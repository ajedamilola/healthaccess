import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, ForeignKeyConstraint, Integer, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDMixin


class PatientProfile(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "patient_profiles"

    account_id        : Mapped[uuid.UUID] = mapped_column(ForeignKey("accounts.id"), unique=True)
    preferred_language: Mapped[str]       = mapped_column(String, default="en")
    home_area_id      : Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    version           : Mapped[int]       = mapped_column(Integer, default=1)  # for If-Match


class FieldDefinition(Base):
    __tablename__ = "field_definitions"

    field_key        : Mapped[str]  = mapped_column(String, primary_key=True)
    label            : Mapped[str]  = mapped_column(String)
    value_schema     : Mapped[dict] = mapped_column(JSONB)  # every value is validated against this
    emergency_eligible: Mapped[bool] = mapped_column(Boolean, default=False)
    active           : Mapped[bool] = mapped_column(Boolean, default=True)


class PatientFieldValue(Base):
    __tablename__ = "patient_field_values"

    patient_id : Mapped[uuid.UUID] = mapped_column(ForeignKey("patient_profiles.id"), primary_key=True)
    field_key  : Mapped[str]       = mapped_column(ForeignKey("field_definitions.field_key"), primary_key=True)
    value      : Mapped[dict]      = mapped_column(JSONB)
    version    : Mapped[int]       = mapped_column(Integer, default=1)
    provenance : Mapped[str | None] = mapped_column(String, nullable=True)
    updated_at : Mapped[datetime]  = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class PatientCode(Base):
    __tablename__ = "patient_codes"

    patient_id     : Mapped[uuid.UUID] = mapped_column(ForeignKey("patient_profiles.id"), primary_key=True)
    code_digest    : Mapped[str]       = mapped_column(String, unique=True)
    code_ciphertext: Mapped[str]       = mapped_column(String)
    key_version    : Mapped[int]       = mapped_column(Integer, default=1)
    rotated_at     : Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class EmergencyField(Base):
    __tablename__ = "emergency_fields"

    patient_id   : Mapped[uuid.UUID] = mapped_column(primary_key=True)
    field_key    : Mapped[str]       = mapped_column(primary_key=True)
    display_order: Mapped[int]       = mapped_column(Integer, default=0)

    # ties the selection to that patient's own field row
    __table_args__ = (
        ForeignKeyConstraint(
            ["patient_id", "field_key"],
            ["patient_field_values.patient_id", "patient_field_values.field_key"],
        ),
    )