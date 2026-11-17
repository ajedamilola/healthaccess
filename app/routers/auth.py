from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.deps import current_account, current_session, verify_csrf
from app.core.errors import Conflict, Unauthenticated
from app.core.responses import ok
from app.core.security import (
    digest, encrypt_code, hash_password, new_patient_code, verify_password,
)
from app.core.sessions import clear_cookies, create_session, revoke_session, set_cookies
from app.db.session import get_db
from app.models.account import Account, AccountRole, AuthSession, Role
from app.models.patient import PatientCode, PatientFieldValue, PatientProfile
from app.schemas.auth import AccountOut, LoginIn, RegisterIn, SessionOut

router = APIRouter(prefix="/auth", tags=["auth"])

# verified against when the email doesn't exist, so timing doesn't reveal which emails are registered
_DUMMY_HASH = hash_password("not-a-real-password")


def _account_out(db: Session, acc: Account) -> AccountOut:
    patient_id = db.scalar(select(PatientProfile.id).where(PatientProfile.account_id == acc.id))
    return AccountOut(id=acc.id, email=acc.email_normalized, roles=[r.role for r in acc.roles], patient_id=patient_id)


@router.post("/register", status_code=201)
def register(body: RegisterIn, request: Request, db: Session = Depends(get_db)):
    try:
        acc = Account(email_normalized=body.email.strip().lower(), password_hash=hash_password(body.password))
        db.add(acc)
        db.flush()

        # role is always patient here, never taken from the request
        db.add(AccountRole(account_id=acc.id, role=Role.patient))

        patient = PatientProfile(account_id=acc.id)
        db.add(patient)
        db.flush()

        code = new_patient_code()
        db.add(PatientCode(patient_id=patient.id, code_digest=digest(code), code_ciphertext=encrypt_code(code)))
        db.add(PatientFieldValue(patient_id=patient.id, field_key="full_name", value=body.display_name.strip()))
        db.commit()
    except IntegrityError:
        db.rollback()
        raise Conflict("Could not create an account with these details.")

    db.refresh(acc)
    return ok(request, _account_out(db, acc))


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response, db: Session = Depends(get_db)):
    acc = db.scalar(select(Account).where(Account.email_normalized == body.email.strip().lower()))

    if not acc:
        verify_password(body.password, _DUMMY_HASH)
        raise Unauthenticated("Wrong email or password.")
    if acc.status != "active" or not verify_password(body.password, acc.password_hash):
        raise Unauthenticated("Wrong email or password.")

    token = create_session(db, acc.id)
    set_cookies(response, token)
    return ok(request, _account_out(db, acc))


@router.post("/logout", status_code=204, dependencies=[Depends(verify_csrf)])
def logout(response: Response, sess: AuthSession = Depends(current_session), db: Session = Depends(get_db)):
    revoke_session(db, sess)
    clear_cookies(response)


@router.get("/session")
def session(
    request: Request,
    sess: AuthSession = Depends(current_session),
    acc: Account = Depends(current_account),
    db: Session = Depends(get_db),
):
    return ok(request, SessionOut(account=_account_out(db, acc), expires_at=sess.expires_at))