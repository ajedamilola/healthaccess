from fastapi import APIRouter, Depends, Request
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.audit import log_event
from app.core.deps import current_patient, verify_csrf
from app.core.errors import Unprocessable
from app.core.responses import ok
from app.db.session import get_db
from app.models.patient import EmergencyField, FieldDefinition, PatientFieldValue, PatientProfile
from app.schemas.emergency import EmergencyIn, EmergencyOut

router = APIRouter(prefix="/me", tags=["emergency"], dependencies=[Depends(verify_csrf)])


def _summary(db: Session, patient_id) -> EmergencyOut:
    rows = db.scalars(
        select(EmergencyField).where(EmergencyField.patient_id == patient_id).order_by(EmergencyField.display_order)
    ).all()
    keys = [r.field_key for r in rows]

    values = {
        v.field_key: v.value for v in db.scalars(
            select(PatientFieldValue).where(
                PatientFieldValue.patient_id == patient_id, PatientFieldValue.field_key.in_(keys)
            )
        )
    }
    return EmergencyOut(field_keys=keys, projection={k: values[k] for k in keys if k in values})


@router.get("/emergency-summary")
def read_summary(request: Request, patient: PatientProfile = Depends(current_patient), db: Session = Depends(get_db)):
    return ok(request, _summary(db, patient.id))


@router.put("/emergency-summary")
def save_summary(
    body: EmergencyIn, request: Request,
    patient: PatientProfile = Depends(current_patient),
    db: Session = Depends(get_db),
):
    keys = list(dict.fromkeys(body.field_keys))  # drop duplicates, keep order

    eligible = set(db.scalars(
        select(FieldDefinition.field_key).where(
            FieldDefinition.field_key.in_(keys),
            FieldDefinition.active.is_(True),
            FieldDefinition.emergency_eligible.is_(True),
        )
    ))
    filled = set(db.scalars(
        select(PatientFieldValue.field_key).where(
            PatientFieldValue.patient_id == patient.id, PatientFieldValue.field_key.in_(keys)
        )
    ))

    errors = []
    for k in keys:
        if k not in eligible:
            errors.append({"path": "field_keys", "message": f"{k} cannot be shared in an emergency summary."})
        elif k not in filled:
            errors.append({"path": "field_keys", "message": f"Add a value for {k} first."})
    if errors:
        raise Unprocessable(fields=errors)

    # an empty list turns sharing off
    db.execute(delete(EmergencyField).where(EmergencyField.patient_id == patient.id))
    for i, k in enumerate(keys):
        db.add(EmergencyField(patient_id=patient.id, field_key=k, display_order=i))

    log_event(db, request, patient_id=patient.id, actor_id=patient.account_id,
              action="emergency_fields_updated", field_keys=keys)
    db.commit()

    return ok(request, _summary(db, patient.id))