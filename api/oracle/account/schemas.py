import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from oracle.auth.models import Role
from oracle.auth.service import PASSWORD_MIN_LENGTH
from oracle.members.schemas import ApiTokenOut

SignInMethod = Literal["password", "google"]
PersonalScope = Literal["oracle:read", "oracle:write"]
# A personal token's lifetime, chosen when it is created (AC1): 30 days, 90 days (the
# default), a year, or never (null).
TokenLifetime = Literal[30, 90, 365]


class MyAccountOut(BaseModel):
    """The signed-in member: who they are, their role and how they sign in."""

    user_id: uuid.UUID
    email: str
    role: Role
    created_at: datetime
    last_sign_in_at: datetime | None = None
    # password: email and password on the sign-in page; google: Google sign-in (IAP),
    # when this deployment has it on.
    sign_in_methods: list[SignInMethod]
    password_min_length: int = PASSWORD_MIN_LENGTH
    # How this request was made: a browser session (cookie or Google), a personal API
    # token, or an MCP client.
    signed_in_via: Literal["browser", "api_token", "mcp_client"]


class PasswordChange(BaseModel):
    current_password: str = Field(min_length=1, max_length=1024)
    new_password: str = Field(min_length=PASSWORD_MIN_LENGTH, max_length=1024)


class PersonalTokenCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    # oracle:read alone acts as a viewer; with oracle:write the token has your role.
    scopes: list[PersonalScope] = Field(min_length=1)
    # Days until it expires: 30, 90 or 365; null never expires.
    expires_in_days: TokenLifetime | None = 90

    @field_validator("name")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("a name is required")
        return v


class PersonalTokenCreated(BaseModel):
    """The new token and its secret: shown this once, only its hash is kept."""

    token: ApiTokenOut
    secret: str


class McpClientOut(BaseModel):
    """An MCP client you authorized: one OAuth grant (its access and refresh tokens)."""

    # The grant's id (revoke with it).
    id: uuid.UUID
    client_id: str
    client_name: str
    scopes: list[str]
    authorized_at: datetime
    # When it last refreshed its access token (access tokens record no use).
    last_used_at: datetime
    expires_at: datetime
    revoked_at: datetime | None = None


class SignedOutEverywhere(BaseModel):
    """Every session signed before ``sessions_valid_after`` is refused, this one too;
    every personal API token, every MCP client (refresh tokens included) and the run
    tokens of the runs you started that are still going are revoked (AC1)."""

    sessions_valid_after: datetime
    mcp_clients_revoked: int
    api_tokens_revoked: int = 0
    # Runs whose tokens were revoked (the runs themselves go on).
    runs_tokens_revoked: int = 0
