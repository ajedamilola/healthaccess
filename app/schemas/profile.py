import uuid
from typing import Any

from pydantic import BaseModel


class ProfileOut(BaseModel):
    fields            : dict[str, Any]
    preferred_language: str
    home_area_id      : uuid.UUID | None
    version           : int


class ProfilePatch(BaseModel):
    # a field set to null removes it
    fields            : dict[str, Any] = {}
    preferred_language: str | None = None
    home_area_id      : uuid.UUID | None = None