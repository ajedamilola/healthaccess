from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


class AppError(Exception):
    status  = 400
    code    = "BAD_REQUEST"
    message = "Request could not be completed."

    def __init__(self, message: str | None = None, fields: list[dict] | None = None, headers: dict | None = None):
        self.message = message or self.message
        self.fields  = fields or []
        self.headers = headers or {}


class Unauthenticated(AppError):
    status, code, message = 401, "UNAUTHENTICATED", "Sign in to continue."

class Forbidden(AppError):
    status, code, message = 403, "FORBIDDEN", "You do not have access to this."

class ReauthRequired(AppError):
    status, code, message = 403, "RECENT_SIGNIN_REQUIRED", "Sign in again to do this."

class NotFound(AppError):
    # also used for failed code lookups, so nothing leaks
    status, code, message = 404, "NOT_FOUND", "Not found."

class Conflict(AppError):
    status, code, message = 409, "CONFLICT", "This conflicts with the current state."

class StaleVersion(AppError):
    status, code, message = 412, "STALE_VERSION", "This was changed elsewhere. Reload and try again."

class Unprocessable(AppError):
    status, code, message = 422, "VALIDATION_ERROR", "Some input is invalid."

class TooManyRequests(AppError):
    status, code, message = 429, "RATE_LIMITED", "Too many attempts. Try again shortly."

class Unavailable(AppError):
    status, code, message = 503, "SERVICE_UNAVAILABLE", "Temporarily unavailable."


def _body(request: Request, code: str, message: str, fields: list[dict]):
    # exception handlers can run outside our middleware, so don't assume request_id is set
    rid = getattr(request.state, "request_id", "unknown")
    return {
        "error": {"code": code, "message": message, "fields": fields},
        "meta" : {"request_id": rid, "api_version": "v1"},
    }


def register_handlers(app: FastAPI):
    @app.exception_handler(AppError)
    def app_error(request: Request, exc: AppError):
        return JSONResponse(_body(request, exc.code, exc.message, exc.fields), exc.status, exc.headers)

    @app.exception_handler(RequestValidationError)
    def validation_error(request: Request, exc: RequestValidationError):
        fields = [
            {"path": ".".join(str(p) for p in e["loc"] if p != "body"), "message": e["msg"]}
            for e in exc.errors()
        ]
        return JSONResponse(_body(request, "VALIDATION_ERROR", "Some input is invalid.", fields), 422)

    @app.exception_handler(Exception)
    def unhandled(request: Request, exc: Exception):
        # never echo internals to the client
        return JSONResponse(_body(request, "INTERNAL_ERROR", "Something went wrong.", []), 500)