from fastapi import APIRouter, Depends, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import log_event
from app.core.config import settings
from app.core.deps import optional_account
from app.core.errors import NotFound
from app.core.ratelimit import check, rate_limit
from app.core.responses import ok
from app.core.security import digest
from app.db.session import SessionLocal, get_db
from app.models.account import Account
from app.models.patient import PatientCode
from app.routers.emergency import _summary  # TODO: move _summary into app/services/ so routers don't import each other
from app.schemas.sharing import LookupIn

router = APIRouter(prefix="/records", tags=["records"])


def _audit_failed(request: Request):
    # its own session on purpose: a rejected attempt must be logged even if the request's transaction rolls back
    with SessionLocal() as s:
        log_event(s, request, patient_id=None, actor_id=None, action="emergency_lookup", result="not_found")
        s.commit()


@router.post("/emergency-lookups", dependencies=[Depends(rate_limit("lookup", settings.lookup_rate_per_min))])
def emergency_lookup(
    body: LookupIn, request: Request,
    acc: Account | None = Depends(optional_account),
    db: Session = Depends(get_db),
):
    code_digest = digest(body.patient_code)
    check(f"lookup-code:{code_digest}", 20)  # also protects one patient's code from being hammered

    row = db.scalar(select(PatientCode).where(PatientCode.code_digest == code_digest))
    if not row:
        _audit_failed(request)
        raise NotFound()

    data = _summary(db, row.patient_id)  # only the selected emergency fields
    log_event(db, request, patient_id=row.patient_id, actor_id=acc.id if acc else None,
              action="emergency_lookup", field_keys=data.field_keys)
    db.commit()
    return ok(request, data)
