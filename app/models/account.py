import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDMixin


class Role(str, enum.Enum):
    patient         = "patient"
    practitioner    = "practitioner"
    directory_admin = "directory_admin"
    account_admin   = "account_admin"


class Account(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "accounts"

    email_normalized: Mapped[str] = mapped_column(String, unique=True, index=True)
    password_hash   : Mapped[str] = mapped_column(String)
    status          : Mapped[str] = mapped_column(String, default="active")

    roles = relationship("AccountRole", cascade="all, delete-orphan")


class AccountRole(Base):
    __tablename__ = "account_roles"

    account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("accounts.id"), primary_key=True)
    role      : Mapped[Role]      = mapped_column(Enum(Role, name="account_role"), primary_key=True)


class AuthSession(Base, UUIDMixin):
    __tablename__ = "auth_sessions"

    account_id   : Mapped[uuid.UUID] = mapped_column(ForeignKey("accounts.id"), index=True)
    token_digest : Mapped[str]       = mapped_column(String, unique=True)  # never store the raw token
    expires_at   : Mapped[datetime]  = mapped_column(DateTime(timezone=True))
    last_activity: Mapped[datetime]  = mapped_column(DateTime(timezone=True))
    revoked_at   : Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)