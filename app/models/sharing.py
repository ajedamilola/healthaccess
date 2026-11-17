import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, UUIDMixin


class AccessGrant(Base, UUIDMixin):
    __tablename__ = "access_grants"
    __table_args__ = (UniqueConstraint("patient_id", "code_digest"),)

    patient_id      : Mapped[uuid.UUID]      = mapped_column(ForeignKey("patient_profiles.id"), index=True)
    code_digest     : Mapped[str]            = mapped_column(String)
    allowed_channels: Mapped[list[str]]      = mapped_column(ARRAY(String))
    expires_at      : Mapped[datetime]       = mapped_column(DateTime(timezone=True), index=True)
    revoked_at      : Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by      : Mapped[uuid.UUID]      = mapped_column(ForeignKey("accounts.id"))
    created_at      : Mapped[datetime]       = mapped_column(DateTime(timezone=True), server_default=func.now())


class AccessGrantField(Base):
    __tablename__ = "access_grant_fields"

    grant_id : Mapped[uuid.UUID] = mapped_column(ForeignKey("access_grants.id"), primary_key=True)
    field_key: Mapped[str]       = mapped_column(ForeignKey("field_definitions.field_key"), primary_key=True)


class RecordReadSession(Base, UUIDMixin):
    __tablename__ = "record_read_sessions"

    grant_id          : Mapped[uuid.UUID]      = mapped_column(ForeignKey("access_grants.id"), index=True)
    actor_account_id  : Mapped[uuid.UUID | None] = mapped_column(ForeignKey("accounts.id"), nullable=True)
    channel_binding   : Mapped[str | None]     = mapped_column(String, nullable=True)  # for USSD sessions
    channel           : Mapped[str]            = mapped_column(String)
    expires_at        : Mapped[datetime]       = mapped_column(DateTime(timezone=True))
    revoked_at        : Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AuditEvent(Base, UUIDMixin):
    __tablename__ = "audit_events"

    patient_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True, index=True)
    actor_id  : Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    channel   : Mapped[str]              = mapped_column(String)
    action    : Mapped[str]              = mapped_column(String)
    target    : Mapped[str | None]       = mapped_column(String, nullable=True)
    field_keys: Mapped[list[str]]        = mapped_column(ARRAY(String), default=list)  # names only, never values
    result    : Mapped[str]              = mapped_column(String)
    request_id: Mapped[str | None]       = mapped_column(String, nullable=True)
    created_at: Mapped[datetime]         = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)


class ProfileUseConsent(Base, UUIDMixin):
    __tablename__ = "profile_use_consents"

    patient_id      : Mapped[uuid.UUID]      = mapped_column(ForeignKey("patient_profiles.id"), index=True)
    channel         : Mapped[str]            = mapped_column(String)
    field_keys      : Mapped[list[str]]      = mapped_column(ARRAY(String))
    linked_phone_id : Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    expires_at      : Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at      : Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)