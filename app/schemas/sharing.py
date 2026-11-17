from typing import Literal

from pydantic import BaseModel, Field

Channel = Literal["web_practitioner", "ussd"]


class GrantIn(BaseModel):
    field_keys      : list[str] = Field(min_length=1, max_length=30)
    allowed_channels: list[Channel] = Field(min_length=1)
    expires_in_seconds: int = 3600


class LookupIn(BaseModel):
    patient_code: str = Field(pattern=r"^\d{12}$")
