import json
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, Query, Request
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.audit import log_event
from app.core.config import settings
from app.core.deps import current_patient, recent_patient, verify_csrf
from app.core.errors import Conflict, NotFound, Unprocessable
from app.core.pagination import paginate
from app.core.responses import ok
from app.core.security import decrypt_code, digest, encrypt_code, new_access_code
from app.db.session import get_db
from app.models.patient import FieldDefinition, PatientFieldValue, PatientProfile
from app.models.sharing import (
    AccessGrant, AccessGrantField, AuditEvent, IdempotencyRecord, RecordReadSession,
)
from app.schemas.sharing import GrantIn

router = APIRouter(prefix="/me", tags=["sharing"], dependencies=[Depends(verify_csrf)])


def _replay(db: Session, scope: str, key: str, req_digest: str):
    rec = db.scalar(select(IdempotencyRecord).where(
        IdempotencyRecord.actor_scope == scope,
        IdempotencyRecord.idem_key == key,
        IdempotencyRecord.expires_at > datetime.now(timezone.utc),
    ))
    if not rec:
        return None
    if rec.request_digest != req_digest:
        raise Conflict("This Idempotency-Key was already used with a different request.")
    return json.loads(decrypt_code(rec.response_ciphertext))


@router.post("/access-grants", status_code=201)
def create_grant(
    body: GrantIn, request: Request,
    idempotency_key: str = Header(alias="Idempotency-Key", min_length=8, max_length=128),
    patient: PatientProfile = Depends(recent_patient),
    db: Session = Depends(get_db),
):
    patient_id, account_id = patient.id, patient.account_id  # survive a rollback below

    if not settings.grant_min_seconds <= body.expires_in_seconds <= settings.grant_max_seconds:
        raise Unprocessable(fields=[{
            "path": "expires_in_seconds",
            "message": f"Choose between {settings.grant_min_seconds} and {settings.grant_max_seconds} seconds.",
        }])

    keys     = list(dict.fromkeys(body.field_keys))
    channels = list(dict.fromkeys(body.allowed_channels))

    scope      = f"grant:{account_id}"
    req_digest = digest(json.dumps({"f": sorted(keys), "c": sorted(channels), "e": body.expires_in_seconds}))
    replayed   = _replay(db, scope, idempotency_key, req_digest)
    if replayed is not None:
        return ok(request, replayed)

    # every key must be a real, active field that this patient has actually filled in
    active = set(db.scalars(select(FieldDefinition.field_key).where(
        FieldDefinition.field_key.in_(keys), FieldDefinition.active.is_(True))))
    filled = set(db.scalars(select(PatientFieldValue.field_key).where(
        PatientFieldValue.patient_id == patient_id, PatientFieldValue.field_key.in_(keys))))
    errors = []
    for k in keys:
        if k not in active:
            errors.append({"path": "field_keys", "message": f"{k} is not a shareable field."})
        elif k not in filled:
            errors.append({"path": "field_keys", "message": f"Add a value for {k} first."})
    if errors:
        raise Unprocessable(fields=errors)

    now     = datetime.now(timezone.utc)
    expires = now + timedelta(seconds=body.expires_in_seconds)

    # the 8-digit code only needs to be unique per patient; retry on the rare collision
    for _ in range(5):
        code  = new_access_code()
        grant = AccessGrant(
            patient_id=patient_id, code_digest=digest(code), allowed_channels=channels,
            expires_at=expires, created_by=account_id,
        )
        db.add(grant)
        try:
            db.flush()
            break
        except IntegrityError:
            db.rollback()
    else:
        raise Conflict("Could not create an access code. Try again.")

    for k in keys:
        db.add(AccessGrantField(grant_id=grant.id, field_key=k))

    data = {
        "grant_id": str(grant.id), "access_code": code, "expires_at": expires.isoformat(),
        "field_keys": keys, "allowed_channels": channels, "read_only": True,
    }
    db.add(IdempotencyRecord(
        actor_scope=scope, idem_key=idempotency_key, request_digest=req_digest, resource_id=grant.id,
        response_ciphertext=encrypt_code(json.dumps(data)),
        expires_at=now + timedelta(hours=settings.idempotency_ttl_hours),
    ))
    log_event(db, request, patient_id=patient_id, actor_id=account_id,
              action="access_grant_created", target=str(grant.id), field_keys=keys)
    try:
        db.commit()
    except IntegrityError:
        # two identical requests raced; the other one won, so return what it stored
        db.rollback()
        replayed = _replay(db, scope, idempotency_key, req_digest)
        if replayed is None:
            raise Conflict()
        return ok(request, replayed)

    return ok(request, data)


@router.get("/access-grants")
def list_grants(
    request: Request,
    limit: int = Query(20, ge=1, le=100), cursor: str | None = None,
    patient: PatientProfile = Depends(current_patient),
    db: Session = Depends(get_db),
):
    rows, nxt = paginate(db, select(AccessGrant).where(AccessGrant.patient_id == patient.id),
                         AccessGrant, limit, cursor)

    fields: dict[uuid.UUID, list[str]] = {}
    if rows:
        for gid, fk in db.execute(select(AccessGrantField.grant_id, AccessGrantField.field_key)
                                  .where(AccessGrantField.grant_id.in_([g.id for g in rows]))):
            fields.setdefault(gid, []).append(fk)

    now = datetime.now(timezone.utc)

    def status(g: AccessGrant) -> str:
        if g.revoked_at is not None:
            return "revoked"
        return "expired" if g.expires_at <= now else "active"

    items = [{
        "grant_id": g.id, "status": status(g), "field_keys": sorted(fields.get(g.id, [])),
        "allowed_channels": g.allowed_channels, "expires_at": g.expires_at,
        "revoked_at": g.revoked_at, "created_at": g.created_at,
    } for g in rows]  # never any code material
    return ok(request, {"items": items, "next_cursor": nxt})


@router.delete("/access-grants/{grant_id}", status_code=204)
def revoke_grant(
    grant_id: uuid.UUID, request: Request,
    patient: PatientProfile = Depends(current_patient),
    db: Session = Depends(get_db),
):
    # someone else's grant looks exactly like a missing one
    grant = db.scalar(select(AccessGrant).where(
        AccessGrant.id == grant_id, AccessGrant.patient_id == patient.id).with_for_update())
    if not grant:
        raise NotFound()

    # repeated revocation is safe: only the first one changes anything
    if grant.revoked_at is None:
        now = datetime.now(timezone.utc)
        grant.revoked_at = now
        db.execute(update(RecordReadSession).where(
            RecordReadSession.grant_id == grant.id, RecordReadSession.revoked_at.is_(None),
        ).values(revoked_at=now))
        log_event(db, request, patient_id=patient.id, actor_id=patient.account_id,
                  action="access_grant_revoked", target=str(grant.id))
    db.commit()


@router.get("/access-events")
def list_events(
    request: Request,
    limit: int = Query(20, ge=1, le=100), cursor: str | None = None,
    patient: PatientProfile = Depends(current_patient),
    db: Session = Depends(get_db),
):
    rows, nxt = paginate(db, select(AuditEvent).where(AuditEvent.patient_id == patient.id),
                         AuditEvent, limit, cursor)
    items = [{
        "id": e.id, "created_at": e.created_at, "channel": e.channel, "action": e.action,
        "result": e.result, "field_keys": e.field_keys,
        "actor": "you" if e.actor_id == patient.account_id else "other",
    } for e in rows]  # field names only, no values or codes
    return ok(request, {"items": items, "next_cursor": nxt})
