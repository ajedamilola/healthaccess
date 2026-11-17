from typing import Generic, TypeVar

from pydantic import BaseModel

T = TypeVar("T")


class Meta(BaseModel):
    request_id : str
    api_version: str = "v1"


class FieldError(BaseModel):
    path   : str
    message: str


class ErrorBody(BaseModel):
    code   : str
    message: str
    fields : list[FieldError] = []


class Envelope(BaseModel, Generic[T]):
    data: T
    meta: Meta


class ErrorEnvelope(BaseModel):
    error: ErrorBody
    meta : Meta