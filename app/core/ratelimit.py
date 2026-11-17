import time
from collections import defaultdict, deque

from fastapi import Request

from app.core.errors import TooManyRequests

# In-memory sliding window: fine for one dev process. Before pilot, move to Redis or a DB table,
# otherwise every worker/instance keeps its own counters.
_hits: dict[str, deque] = defaultdict(deque)


def check(key: str, limit: int, window: int = 60):
    now = time.monotonic()
    q = _hits[key]
    while q and now - q[0] > window:
        q.popleft()
    if len(q) >= limit:
        retry = max(1, int(window - (now - q[0])))
        raise TooManyRequests(headers={"Retry-After": str(retry)})
    q.append(now)


def rate_limit(name: str, limit: int, window: int = 60):
    def dep(request: Request):
        ip = request.client.host if request.client else "unknown"
        check(f"{name}:{ip}", limit, window)
    return dep
