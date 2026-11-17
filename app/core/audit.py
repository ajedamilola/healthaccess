from fastapi import Request
from sqlalchemy.orm import Session

from app.models.sharing import AuditEvent


def log_event(db: Session, request: Request, *, patient_id, actor_id, action: str, result: str = "ok",
              target: str | None = None, field_keys: list[str] | None = None, channel: str = "web"):
    # added to the caller's transaction, so it commits or rolls back with the change itself
    db.add(AuditEvent(
        patient_id=patient_id, actor_id=actor_id, channel=channel, action=action, result=result,
        target=target, field_keys=field_keys or [], request_id=request.state.request_id,
    ))