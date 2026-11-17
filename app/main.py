from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.core.errors import register_handlers
from app.middleware.no_store import NoStoreMiddleware
from app.middleware.request_id import RequestIDMiddleware
from app.routers import auth, emergency, profile

app = FastAPI(title="HealthAccess Online API", docs_url="/api/v1/docs", openapi_url="/api/v1/openapi.json")

register_handlers(app)

app.add_middleware(NoStoreMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# added last so it runs first and every response carries the id
app.add_middleware(RequestIDMiddleware)

app.include_router(auth.router, prefix="/api/v1")
app.include_router(profile.router, prefix="/api/v1")
app.include_router(emergency.router, prefix="/api/v1")