import jsonschema
from fastapi import APIRouter, Depends, Header, Request, Response
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.security import decrypt_code
from app.core.deps import current_patient, verify_csrf
from app.core.errors import StaleVersion, Unprocessable
from app.core.responses import ok
from app.db.session import get_db
from app.models.patient import EmergencyField, FieldDefinition, PatientCode, PatientFieldValue, PatientProfile
from app.schemas.profile import ProfileOut, ProfilePatch

router = APIRouter(prefix="/me", tags=["profile"], dependencies=[Depends(verify_csrf)])


def _parse_version(raw: str) -> int:
    # frontend sends the ETag back as-is, which may be quoted
    try:
        return int(raw.strip().removeprefix("W/").strip('"'))
    except ValueError:
        raise Unprocessable("If-Match must be the profile version.")


def _profile_out(db: Session, patient: PatientProfile) -> ProfileOut:
    rows = db.scalars(select(PatientFieldValue).where(PatientFieldValue.patient_id == patient.id)).all()
    return ProfileOut(
        fields             = {r.field_key: r.value for r in rows},
        preferred_language = patient.preferred_language,
        home_area_id       = patient.home_area_id,
        version            = patient.version,
    )


@router.get("/profile")
def read_profile(
    request: Request, response: Response,
    patient: PatientProfile = Depends(current_patient),
    db: Session = Depends(get_db),
):
    response.headers["ETag"] = f'"{patient.version}"'
    return ok(request, _profile_out(db, patient))


@router.patch("/profile")
def update_profile(
    body: ProfilePatch, request: Request, response: Response,
    if_match: str = Header(alias="If-Match"),
    patient: PatientProfile = Depends(current_patient),
    db: Session = Depends(get_db),
):
    expected = _parse_version(if_match)

    # lock the row so two edits can't both pass the version check
    locked = db.scalar(
        select(PatientProfile).where(PatientProfile.id == patient.id)
        .with_for_update().execution_options(populate_existing=True)
    )
    if locked.version != expected:
        raise StaleVersion()

    defs = {
        d.field_key: d for d in db.scalars(
            select(FieldDefinition).where(
                FieldDefinition.field_key.in_(list(body.fields)), FieldDefinition.active.is_(True)
            )
        )
    }

    errors = []
    for key, value in body.fields.items():
        d = defs.get(key)
        if not d:
            errors.append({"path": f"fields.{key}", "message": "Unknown field."})
            continue
        if value is not None:
            try:
                jsonschema.validate(value, d.value_schema)
            except jsonschema.ValidationError as e:
                errors.append({"path": f"fields.{key}", "message": e.message})
    if errors:
        raise Unprocessable(fields=errors)

    for key, value in body.fields.items():
        row = db.get(PatientFieldValue, (patient.id, key))
        if value is None:
            if row:
                # drop the emergency selection first, it points at this row
                db.execute(delete(EmergencyField).where(
                    EmergencyField.patient_id == patient.id, EmergencyField.field_key == key
                ))
                db.delete(row)
        elif row:
            row.value   = value
            row.version += 1
        else:
            db.add(PatientFieldValue(patient_id=patient.id, field_key=key, value=value))

    if body.preferred_language is not None:
        locked.preferred_language = body.preferred_language
    if "home_area_id" in body.model_fields_set:
        locked.home_area_id = body.home_area_id

    locked.version += 1
    db.commit()
    db.refresh(locked)

    response.headers["ETag"] = f'"{locked.version}"'
    return ok(request, _profile_out(db, locked))


@router.get("/patient-code")
def read_patient_code(
    request: Request,
    patient: PatientProfile = Depends(current_patient),
    db: Session = Depends(get_db),
):
    row = db.get(PatientCode, patient.id)
    return ok(request, {"patient_code": decrypt_code(row.code_ciphertext)})