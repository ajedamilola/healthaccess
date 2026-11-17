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


settings = Settings()