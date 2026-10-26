"""Settings, read from the environment (prefix ``ORACLE_``) or a ``.env`` file."""

from functools import lru_cache
from typing import Literal

from pydantic import SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ORACLE_", env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://oracle:oracle@localhost:5432/oracle"
    # Signs the UI session cookie. Override in any non-local environment.
    secret_key: str = "dev-insecure-change-me"
    session_cookie_name: str = "oracle_session"
    session_max_age_seconds: int = 60 * 60 * 24 * 7
    # A run binding is minted per request by the MCP layer: it only has to outlive one call.
    run_binding_max_age_seconds: int = 300
    cookie_secure: bool = False
    # Origins allowed to call the API with credentials (the web app in dev).
    cors_origins: list[str] = ["http://localhost:3000"]
    sql_echo: bool = False
    # E1: the tick starts queued derivations of PRD drafts' roadmap items. Off: they stay
    # queued (the test suite, whose scripted runtimes are for the runs a test starts).
    draft_roadmaps_start: bool = True
    # Where people open the web app: exports turn the app's own links (a roadmap's links
    # to its PRD's sections) into absolute URLs under it. Empty: ORACLE_PUBLIC_URL, where
    # the app and the API share a host behind the load balancer.
    app_url: str = ""
    # G8 Slack bridge: Oracle's Slack app's signing secret (Secret Manager
    # oracle-slack-signing-secret). Empty: the events endpoint refuses every request.
    slack_signing_secret: str = ""
    # Google IAP single sign-on. Empty audiences = off: the IAP header is ignored.
    # Audience: /projects/<PROJECT_NUMBER>/global/backendServices/<BACKEND_SERVICE_ID>.
    iap_audiences: list[str] = []
    # Email domains (e.g. ["example.com"]) whose IAP users are created on first visit.
    iap_allowed_domains: list[str] = []
    iap_auto_provision: bool = True
    # The IAP backend services an invite grants its invitee access to (#242): their ids
    # (e.g. ["oracle-api-be", "oracle-web-be"]) in ORACLE_GCP_PROJECT. Creating an invite
    # grants user:<email> roles/iap.httpsResourceAccessor on each; revoking it, or
    # removing the member, takes it away. Empty (local and dev): no grant, recorded.
    iap_backends: list[str] = []
    gcp_project: str = ""
    # The invite email (#242): "gmail_api" sends as ORACLE_MAIL_SENDER (one company
    # mailbox) through domain-wide delegation (oracle.members.mailer). Either unset:
    # nothing is sent and the invite records it. A failed send is retried once, after
    # mail_retry_seconds.
    mail_provider: Literal["", "gmail_api"] = ""
    mail_sender: str = ""
    mail_retry_seconds: float = 5.0
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
    # The mock/test build only: let users and invites use the reserved example domains
    # (example.com/.org/.net, *.test, *.invalid, *.localhost). Off everywhere real, so a
    # seed or an invite can never create admin@example.com again (account management).
    allow_reserved_email_domains: bool = False
    # H7 Competitive digest: Oracle's web tools (oracle.web), the only web its agents
    # reach. The provider (Q5 "Web search", owner 2026-10-23: a key Oracle holds, Brave
    # Search API) and its key, Secret Manager oracle-web-search-key mounted as
    # ORACLE_WEB_SEARCH_KEY (docs/ops-web-search.md); never logged, never sent to agents.
    # No key, or provider "none": POST /v1/web/search answers 503 web_search_unconfigured.
    # Per run, at most this many searches and page reads (429 web_cap_reached above);
    # the company's web_searches_per_month setting caps searches across runs.
    web_search_provider: Literal["brave", "none"] = "brave"
    web_search_key: SecretStr = SecretStr("")
    web_search_max_per_run: int = 30
    web_fetch_max_per_run: int = 40
    # The deployment's kind (ORACLE_ENV); "production" refuses the switches for tests below.
    env: str = "development"
    # I1 webhooks: the Playwright fixture's stub receiver only. On, a webhook may point at
    # a loopback address (http or https), sent without the guarded transport; every other
    # address still goes through it. Refused in a real deployment, as the switch above is.
    webhooks_allow_loopback_for_tests: bool = False

    @model_validator(mode="after")
    def _no_reserved_domains_in_production(self) -> "Settings":
        # A deployment with secure cookies or Google sign-in is a real one: the switch
        # meant for tests and the mock is refused there, so it cannot be left on.
        if self.allow_reserved_email_domains and (self.cookie_secure or self.iap_audiences):
            raise ValueError(
                "ORACLE_ALLOW_RESERVED_EMAIL_DOMAINS is for tests and the mock only; it "
                "cannot be set with ORACLE_COOKIE_SECURE or ORACLE_IAP_AUDIENCES"
            )
        real = self.env == "production" or self.cookie_secure or self.iap_audiences
        if self.webhooks_allow_loopback_for_tests and real:
            raise ValueError(
                "ORACLE_WEBHOOKS_ALLOW_LOOPBACK_FOR_TESTS is for tests only; it cannot be set "
                "with ORACLE_ENV=production, ORACLE_COOKIE_SECURE or ORACLE_IAP_AUDIENCES"
            )
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
