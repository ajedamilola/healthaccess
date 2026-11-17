import secrets
from datetime import datetime, timedelta, timezone

from fastapi import Response
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import digest, new_session_token
from app.models.account import AuthSession

SESSION_COOKIE = "ha_session"
CSRF_COOKIE    = "ha_csrf"


def create_session(db: Session, account_id) -> str:
    token = new_session_token()
    now   = datetime.now(timezone.utc)

    db.add(AuthSession(
        account_id    = account_id,
        token_digest  = digest(token),
        expires_at    = now + timedelta(minutes=settings.session_ttl_minutes),
        last_activity = now,
    ))
    db.commit()
    return token


def revoke_session(db: Session, session: AuthSession):
    session.revoked_at = datetime.now(timezone.utc)
    db.commit()


def set_cookies(response: Response, token: str):
    max_age = settings.session_ttl_minutes * 60

    # the session cookie is HttpOnly so JS can't read it
    response.set_cookie(
        SESSION_COOKIE, token, max_age=max_age, path="/",
        httponly=True, secure=settings.cookie_secure, samesite="lax",
    )
    # the CSRF cookie has to be readable so the frontend can echo it in a header
    response.set_cookie(
        CSRF_COOKIE, secrets.token_urlsafe(24), max_age=max_age, path="/",
        httponly=False, secure=settings.cookie_secure, samesite="lax",
    )


def clear_cookies(response: Response):
    response.delete_cookie(SESSION_COOKIE, path="/")
    response.delete_cookie(CSRF_COOKIE, path="/")