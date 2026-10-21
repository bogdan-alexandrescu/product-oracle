import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, computed_field, field_validator

from oracle.auth.models import Role

InviteStatus = Literal["open", "accepted", "revoked"]


MemberStatus = Literal["active", "disabled"]


class MemberOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    role: Role
    # A3: speaks for engineering (decides the engineering stops, verifies dates).
    engineering_lead: bool = False
    created_at: datetime
    # A removed member is disabled (C2): kept, so history keeps their name.
    disabled_at: datetime | None = None
    disabled_by: uuid.UUID | None = None
    # Their last password or Google sign-in, when known (recorded since account management).
    last_sign_in_at: datetime | None = None
    # Credentials still acting for them: unrevoked personal API tokens and live MCP
    # client grants (a disable revokes them all).
    open_tokens: int = 0

    @computed_field  # type: ignore[prop-decorator]
    @property
    def status(self) -> MemberStatus:
        return "disabled" if self.disabled_at is not None else "active"


class MemberPatch(BaseModel):
    """A role, the engineering lead flag, or both (applied in one change, role first)."""

    role: Role | None = None
    engineering_lead: bool | None = None


class InviteCreate(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    role: Role
    # A3: their first sign-in lands as an engineering lead (never with role viewer).
    engineering_lead: bool = False

    @field_validator("email")
    @classmethod
    def _normalise(cls, v: str) -> str:
        v = v.strip().lower()
        local, _, domain = v.partition("@")
        if not local or "." not in domain or any(c.isspace() for c in v):
            raise ValueError("not an email address")
        return v


class InviteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    role: Role
    engineering_lead: bool = False
    status: InviteStatus
    invited_by: uuid.UUID | None = None
    created_at: datetime
    accepted_at: datetime | None = None
    revoked_at: datetime | None = None


# personal: an API token acting as a member (po_); service: an API token acting with its
# own role, for no one; run: a run's short-lived token for its agents (ort_); mcp_client:
# an MCP client's OAuth grant (poa_ access and por_ refresh tokens, one id per grant).
TokenKind = Literal["personal", "service", "run", "mcp_client"]


class ApiTokenOut(BaseModel):
    """A credential of this company, never its secret."""

    model_config = ConfigDict(from_attributes=True)

    # The API token's id, the run token's id, or the MCP grant's id (its family).
    id: uuid.UUID
    name: str
    kind: TokenKind = "service"
    # The role it acts with now: a service token's own; a member's role capped by the
    # scope for a personal token or an MCP client; a run creator's role for a run token.
    role: Role
    # The member it acts for (a run token: the run's creator); None for a service token.
    user_id: uuid.UUID | None = None
    owner_email: str | None = None
    # oracle:read / oracle:write (personal, MCP client), read:... / write:... (run); none
    # for a service token (its role says what it may do).
    scopes: list[str] = []
    created_at: datetime
    last_used_at: datetime | None = None
    revoked_at: datetime | None = None
    expires_at: datetime | None = None
    run_id: uuid.UUID | None = None
    # The MCP client's registered client_id (pocl_...).
    client_id: str | None = None


class TokenApprovalOut(BaseModel):
    """An approval given through an API token: a section verdict or a version approval."""

    kind: Literal["section", "version"]
    document: str
    version: int
    section_key: str | None = None
    review_id: uuid.UUID | None = None
    # The person (or the user-less token) the approval counted for.
    approver_id: uuid.UUID | None = None
    approved_at: datetime | None = None
    # Set once it lapsed (the token revoked, its approver demoted or disabled).
    lapsed_at: datetime | None = None
    lapse_reason: str | None = None


FollowUpStatus = Literal["pending", "done", "failed", "dismissed"]


class FollowUpOut(BaseModel):
    """A call a member's disable owes (a provider revoke, a runtime cancel) and how it
    stands: pending (retried by the tick), failed (no more automatic retries; Retry or
    Dismiss), done, or dismissed by an owner."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    member_id: uuid.UUID
    kind: Literal["provider_revoke", "run_cancel"]
    provider: str | None = None
    status: FollowUpStatus
    attempts: int
    outcome: str | None = None
    last_error: str | None = None
    created_at: datetime
    next_attempt_at: datetime | None = None
    done_at: datetime | None = None
    dismissed_at: datetime | None = None
    dismissed_by: uuid.UUID | None = None


class PersonOut(BaseModel):
    """A member as the member directory shows them to everyone (``GET /v1/people``):
    no other field, so a picker never learns more than whom it may name."""

    user_id: uuid.UUID
    name: str
    email: str
    role: Role
    # Commenter or above: can answer a question, comment or be asked.
    can_write: bool
