import base64
import json
import uuid
from datetime import datetime

from sqlalchemy import tuple_
from sqlalchemy.orm import Session

from app.core.errors import Unprocessable


def encode_cursor(created_at: datetime, id_: uuid.UUID) -> str:
    return base64.urlsafe_b64encode(json.dumps([created_at.isoformat(), str(id_)]).encode()).decode()


def decode_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    try:
        ts, id_ = json.loads(base64.urlsafe_b64decode(cursor.encode()))
        return datetime.fromisoformat(ts), uuid.UUID(id_)
    except Exception:
        raise Unprocessable("Invalid cursor.")


def paginate(db: Session, stmt, model, limit: int, cursor: str | None):
    """Newest-first keyset pagination on (created_at, id). Returns (rows, next_cursor)."""
    if cursor:
        ts, id_ = decode_cursor(cursor)
        stmt = stmt.where(tuple_(model.created_at, model.id) < tuple_(ts, id_))
    rows = db.scalars(stmt.order_by(model.created_at.desc(), model.id.desc()).limit(limit + 1)).all()
    more = len(rows) > limit
    rows = rows[:limit]
    return rows, (encode_cursor(rows[-1].created_at, rows[-1].id) if more and rows else None)
