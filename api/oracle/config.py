"""Settings, read from the environment (prefix ``ORACLE_``) or a ``.env`` file."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ORACLE_", env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://oracle:oracle@localhost:5432/oracle"
    # Signs the UI session cookie. Override in any non-local environment.
    secret_key: str = "dev-insecure-change-me"
    session_cookie_name: str = "oracle_session"
    session_max_age_seconds: int = 60 * 60 * 24 * 7
    cookie_secure: bool = False
    # Origins allowed to call the API with credentials (the web app in dev).
    cors_origins: list[str] = ["http://localhost:3000"]
    sql_echo: bool = False
    # Where people open the web app: exports turn the app's own links (a roadmap's links
    # to its PRD's sections) into absolute URLs under it. Empty: ORACLE_PUBLIC_URL, where
    # the app and the API share a host behind the load balancer.
    app_url: str = ""
    # Google IAP single sign-on. Empty audiences = off: the IAP header is ignored.
    # Audience: /projects/<PROJECT_NUMBER>/global/backendServices/<BACKEND_SERVICE_ID>.
    iap_audiences: list[str] = []
    # Email domains (e.g. ["example.com"]) whose IAP users are created on first visit.
    iap_allowed_domains: list[str] = []
    iap_auto_provision: bool = True


@lru_cache
def get_settings() -> Settings:
    return Settings()
