import uuid
from datetime import datetime

from pydantic import BaseModel, EmailStr, Field

from app.models.account import Role


class RegisterIn(BaseModel):
    email       : EmailStr
    password    : str = Field(min_length=10, max_length=128)
    display_name: str = Field(min_length=1, max_length=100)


class LoginIn(BaseModel):
    email   : EmailStr
    password: str = Field(max_length=128)


class AccountOut(BaseModel):
    id        : uuid.UUID
    email     : str
    roles     : list[Role]
    patient_id: uuid.UUID | None = None


class SessionOut(BaseModel):
    account   : AccountOut
    expires_at: datetime