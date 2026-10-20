"""Settings, read from the environment (prefix ``ORACLE_``) or a ``.env`` file."""

from functools import lru_cache
from typing import Literal

from pydantic import SecretStr
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
    # Google's Drive picker (Settings > Sources, Google Docs): the Cloud project number
    # of Oracle's Google OAuth client, and a browser API key restricted to Oracle's web
    # origin and the Picker API. The key is public by design (the browser sends it to
    # Google) but is never logged. Either empty: the picker is off (404).
    google_picker_app_id: str = ""
    google_picker_api_key: SecretStr = SecretStr("")
    # Local development only: with no company email domains set (ORACLE_IAP_ALLOWED_DOMAINS
    # or the owner's company_email_domains setting), take them from the members' email
    # addresses. Off, the outside-owner check of Drive folders fails closed. S5 (owner,
    # 2026-10-20): never inferred in production.
    infer_company_domains: bool = False
    # A Google Doc inside a picked Drive folder whose owner's email domain is not one of
    # the company's (ORACLE_IAP_ALLOWED_DOMAINS and company_email_domains), or that is in
    # a shared drive not on company_shared_drives:
    # "skip" leaves it out and lists it on the source as 'Skipped: owned outside
    # <domain>'; "include_and_flag" pulls it in and lists it as 'Owned outside <domain>'.
    # Docs picked one by one are always pulled in. Owner, 2026-10-20 (S5): skip.
    drive_docs_owned_outside: Literal["skip", "include_and_flag"] = "skip"
    # Untrusted YAML (drafts' front matter, baseline.yaml, run files) is refused above this
    # many bytes (oracle.safe_yaml); request bodies that carry it are capped at
    # max_body_bytes (413).
    yaml_max_bytes: int = 1024 * 1024
    max_body_bytes: int = 1024 * 1024


@lru_cache
def get_settings() -> Settings:
    return Settings()
