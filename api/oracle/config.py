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
    # The run ticker (POST /internal/scheduler/tick, docs/ops-run-ticker.md): Cloud
    # Scheduler calls it every minute with a Google ID token minted for this audience
    # (https://<host>/internal/scheduler/tick) by this service account's email
    # (oracle-ticker@<project>.iam.gserviceaccount.com). Either empty = off (404).
    ticker_audience: str = ""
    ticker_service_account: str = ""
    # Two-way tracker sync (E1, CR-11): Oracle writing epics and issues to Linear or Jira.
    # Off, and stays off until a connector is verified end to end on an authorized
    # account; with it off Oracle makes no tracker writes and the read-only alignment
    # report is the path. No connector is built yet, so on still writes nothing (501).
    tracker_two_way_enabled: bool = False
    # Untrusted YAML (drafts' front matter, baseline.yaml, run files) is refused above this
    # many bytes (oracle.safe_yaml); request bodies that carry it are capped at
    # max_body_bytes (413).
    yaml_max_bytes: int = 1024 * 1024
    max_body_bytes: int = 1024 * 1024


@lru_cache
def get_settings() -> Settings:
    return Settings()
