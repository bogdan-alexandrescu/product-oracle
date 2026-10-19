"""Runtime settings, read from the environment (prefix ``ORACLE_``) like oracle.config.

ORACLE_RUNTIME                  swarmcloud (default) | fake (tests and local demos)
ORACLE_SWARMCLOUD_URL           SwarmCloud API base URL, e.g. https://swarm.example.com
ORACLE_SWARMCLOUD_AUTH          bearer (default) | google_id_token | google_access_token
                                (google_access_token: the service account's OAuth access token
                                from the metadata server, what an IAP front door with a
                                Google-managed OAuth client accepts)
ORACLE_SWARMCLOUD_TOKEN         the static bearer, for ``bearer``
ORACLE_SWARMCLOUD_AUDIENCE      the ID token audience, for ``google_id_token``
ORACLE_SWARMCLOUD_PROFILE       runner profile for agent steps (default claude-code)
ORACLE_SWARMCLOUD_PRINCIPAL     Oracle's principal as SwarmCloud records it on an answer
                                (e.g. oracle-api@<project>.iam.gserviceaccount.com); when
                                unset, resolved from the token: an ID token's or JWT
                                bearer's email claim, an access token's service account.
                                Only an answer recorded as this principal's is Oracle's
ORACLE_PUBLIC_URL               where agents reach Oracle (its /mcp endpoint)
ORACLE_RUN_TOKEN_TTL_SECONDS    lifetime of a segment's run token while it is not sent to
                                the agents (default 6 hours)

Adapter v2 (docs/swarmcloud-interface.md):

ORACLE_CHECKPOINT_WAIT_SECONDS  how long a checkpoint waits for a person inside a workflow
                                (W2b; default 72000, 20 h, so draft, wait and revise fit one
                                24 h credential; held to 300-86400)
ORACLE_CHECKPOINT_TAIL_SECONDS  the least of the run's credential a decision must leave
                                when agent steps follow its wait (default 7200). The tail is
                                the budget of those steps, ORACLE_STEP_SECONDS x their
                                count, when larger; a decision leaving less is not posted
                                and the run continues as a new workflow
ORACLE_STEP_SECONDS             the time budgeted per agent step in a workflow's credential
                                and in the tail (default 7200, claude-code's timeout)
ORACLE_SWARMCLOUD_FEATURES_TTL_SECONDS  how long a feature reading is cached (default 60)
ORACLE_EGRESS_REFRESH_SECONDS   how often SwarmCloud's egress addresses are re-read
                                (default 300)
ORACLE_TRUSTED_PROXY_HOPS       X-Forwarded-For entries Oracle's own proxies append after
                                the client's address (default 1: Google's HTTPS load
                                balancer appends "<client>, <load balancer>"); 0 reads the
                                socket's peer address
"""

from functools import lru_cache
from typing import Literal

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# The bounds of a credential's and a wait's lifetime in SwarmCloud.
MAX_CREDENTIAL_SECONDS = 86400
MIN_CREDENTIAL_SECONDS = 60
MIN_WAIT_SECONDS = 300


class RuntimeSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ORACLE_", env_file=".env", extra="ignore")

    # Runs execute in SwarmCloud; the FakeRuntime is for tests that choose it.
    runtime: Literal["fake", "swarmcloud"] = "swarmcloud"
    swarmcloud_url: str = ""
    swarmcloud_auth: Literal["bearer", "google_id_token", "google_access_token"] = "bearer"
    swarmcloud_token: str = ""
    swarmcloud_audience: str = ""
    swarmcloud_profile: str = "claude-code"
    swarmcloud_principal: str = ""
    swarmcloud_timeout_seconds: float = 30.0
    public_url: str = "http://localhost:8000"
    run_token_ttl_seconds: int = 6 * 60 * 60
    checkpoint_wait_seconds: int = 20 * 60 * 60  # W2b
    checkpoint_tail_seconds: int = 2 * 60 * 60
    step_seconds: int = 2 * 60 * 60
    swarmcloud_features_ttl_seconds: float = 60.0
    egress_refresh_seconds: float = 300.0
    trusted_proxy_hops: int = 1

    @field_validator("checkpoint_wait_seconds")
    @classmethod
    def _wait_bounds(cls, v: int) -> int:
        # SwarmCloud takes 300 to 86400 s; a value outside is held to the nearest bound.
        return max(MIN_WAIT_SECONDS, min(MAX_CREDENTIAL_SECONDS, v))

    @field_validator("checkpoint_tail_seconds", "step_seconds", "trusted_proxy_hops")
    @classmethod
    def _not_negative(cls, v: int) -> int:
        return max(0, v)


@lru_cache
def get_runtime_settings() -> RuntimeSettings:
    return RuntimeSettings()
