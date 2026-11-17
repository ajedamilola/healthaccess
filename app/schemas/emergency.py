from typing import Any

from pydantic import BaseModel


class EmergencyIn(BaseModel):
    field_keys: list[str]


class EmergencyOut(BaseModel):
    field_keys: list[str]
    projection: dict[str, Any]