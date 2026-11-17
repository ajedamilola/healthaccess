from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url        : str
    code_digest_key     : str   # keyed hash for patient/access codes
    code_encryption_key : str   # for the retrievable permanent patient code
    cookie_secure       : bool = True
    session_ttl_minutes : int  = 60 * 24
    cors_origins        : list[str] = []
    ai_service_url      : str
    ai_service_token    : str

    # --- added in this patch ---
    grant_default_seconds : int = 3600
    grant_min_seconds     : int = 15 * 60
    grant_max_seconds     : int = 24 * 3600
    idempotency_ttl_hours : int = 24
    lookup_rate_per_min   : int = 10
    login_rate_per_min    : int = 5


settings = Settings()
