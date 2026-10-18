"""Runtime settings, read from the environment (prefix ``ORACLE_``) like oracle.config.

ORACLE_RUNTIME                  swarmcloud (default) | fake (tests and local demos)
ORACLE_SWARMCLOUD_URL           SwarmCloud API base URL, e.g. https://swarm.example.com
ORACLE_SWARMCLOUD_AUTH          bearer (default) | google_id_token
ORACLE_SWARMCLOUD_TOKEN         the static bearer, for ``bearer``
ORACLE_SWARMCLOUD_AUDIENCE      the ID token audience, for ``google_id_token``
ORACLE_SWARMCLOUD_PROFILE       runner profile for agent steps (default claude-code)
ORACLE_PUBLIC_URL               where agents reach Oracle (its /mcp endpoint)
ORACLE_RUN_TOKEN_TTL_SECONDS    lifetime of a segment's run token (default 6 hours)
"""

from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class RuntimeSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ORACLE_", env_file=".env", extra="ignore")

    # Runs execute in SwarmCloud; the FakeRuntime is for tests that choose it.
    runtime: Literal["fake", "swarmcloud"] = "swarmcloud"
    swarmcloud_url: str = ""
    swarmcloud_auth: Literal["bearer", "google_id_token"] = "bearer"
    swarmcloud_token: str = ""
    swarmcloud_audience: str = ""
    swarmcloud_profile: str = "claude-code"
    swarmcloud_timeout_seconds: float = 30.0
    public_url: str = "http://localhost:8000"
    run_token_ttl_seconds: int = 6 * 60 * 60


@lru_cache
def get_runtime_settings() -> RuntimeSettings:
    return RuntimeSettings()
