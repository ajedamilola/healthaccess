import re
import uuid

from starlette.middleware.base import BaseHTTPMiddleware

_VALID = re.compile(r"^[A-Za-z0-9_\-]{8,64}$")


class RequestIDMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        incoming = request.headers.get("x-request-id", "")
        rid      = incoming if _VALID.match(incoming) else f"req_{uuid.uuid4().hex[:12]}"

        request.state.request_id = rid
        response = await call_next(request)
        response.headers["X-Request-ID"] = rid
        return response