import hmac
from datetime import datetime, timezone

from fastapi import Depends, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import Forbidden, Unauthenticated
from app.core.security import digest
from app.core.sessions import CSRF_COOKIE, SESSION_COOKIE
from app.db.session import get_db
from app.models.account import Account, AuthSession, Role
from app.models.patient import PatientProfile

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def optional_session(request: Request, db: Session = Depends(get_db)) -> AuthSession | None:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None

    now  = datetime.now(timezone.utc)
    sess = db.scalar(
        select(AuthSession).where(
            AuthSession.token_digest == digest(token),
            AuthSession.revoked_at.is_(None),
            AuthSession.expires_at > now,
        )
    )
    if sess:
        sess.last_activity = now
        db.commit()
    return sess


def current_session(sess: AuthSession | None = Depends(optional_session)) -> AuthSession:
    if not sess:
        raise Unauthenticated()
    return sess


def optional_account(sess: AuthSession | None = Depends(optional_session), db: Session = Depends(get_db)) -> Account | None:
    if not sess:
        return None
    acc = db.get(Account, sess.account_id)
    return acc if acc and acc.status == "active" else None


def current_account(acc: Account | None = Depends(optional_account)) -> Account:
    if not acc:
        raise Unauthenticated()
    return acc


def require_role(*allowed: Role):
    def guard(acc: Account = Depends(current_account)) -> Account:
        have = {r.role for r in acc.roles}
        if not have & set(allowed):
            raise Forbidden()
        return acc
    return guard


def current_patient(acc: Account = Depends(require_role(Role.patient)), db: Session = Depends(get_db)) -> PatientProfile:
    # always resolved from the session, never from an id the client sends
    patient = db.scalar(select(PatientProfile).where(PatientProfile.account_id == acc.id))
    if not patient:
        raise Forbidden()
    return patient


def verify_csrf(request: Request):
    if request.method in SAFE_METHODS:
        return

    cookie = request.cookies.get(CSRF_COOKIE)
    header = request.headers.get("x-csrf-token")
    if not cookie or not header or not hmac.compare_digest(cookie, header):
        raise Forbidden("CSRF check failed.")