import re
import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, computed_field, field_validator

from oracle.auth.models import Role

InviteStatus = Literal["open", "accepted", "revoked"]
# granted: the invitee may pass Google IAP; pending: not granted yet (access_error says
# why; Retry grants it); skipped: this Oracle has no IAP backends to grant (local, dev).
InviteAccess = Literal["granted", "pending", "skipped"]
# queued: Oracle sends it in the background; sent; failed (after one retry; Resend);
# not_sent: no sender is configured, so the owner sends the sign-in link.
InviteEmailStatus = Literal["queued", "sent", "failed", "not_sent"]


MemberStatus = Literal["active", "disabled"]
# A follow-up still owed on a member's Google IAP access (the tick retries it): revoke
# (removed, and the binding not taken away yet) or grant (restored, not granted yet).
MemberAccessPending = Literal["revoke", "grant"]

# A plain address: an RFC 5322 dot-atom local part and ASCII LDH domain labels (at
# least two, no trailing dot). Nothing else gets in: no display name, list, group,
# comment, quoting or whitespace, and no RFC 2047 encoded-word (``=?...?=``) or non-ASCII
# character, which the To header would decode into another address.
_ATOM = r"[a-z0-9!#$%&'*+/=?^_`{|}~-]+"
_LABEL = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
PLAIN_ADDRESS = re.compile(rf"{_ATOM}(?:\.{_ATOM})*@{_LABEL}(?:\.{_LABEL})+", re.ASCII)


def plain_address(value: str) -> str:
    """``value`` as exactly one plain address, ``local@domain``, lowercased (see
    ``PLAIN_ADDRESS``). Raises ValueError otherwise. The invite's To header and its IAM
    member are only ever built from this."""
    v = value.strip()
    # ASCII before lowercasing: "\u212a".lower() is an ASCII "k".
    if not v.isascii() or "=?" in v:
        raise ValueError("not an email address")
    v = v.lower()
    if PLAIN_ADDRESS.fullmatch(v) is None:
        raise ValueError("not an email address")
    return v


class MemberOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    role: Role
    created_at: datetime
    # A removed member is disabled (C2): kept, so history keeps their name.
    disabled_at: datetime | None = None
    disabled_by: uuid.UUID | None = None
    # Their last password or Google sign-in, when known (recorded since account management).
    last_sign_in_at: datetime | None = None
    # Credentials still acting for them: unrevoked personal API tokens and live MCP
    # client grants (a disable revokes them all).
    open_tokens: int = 0
    # Their Google IAP access is still being changed (a failed revoke or grant the tick
    # retries): revoke while removed, grant while active; None when nothing is owed.
    access_pending: MemberAccessPending | None = None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def status(self) -> MemberStatus:
        return "disabled" if self.disabled_at is not None else "active"


class MemberPatch(BaseModel):
    role: Role


class InviteCreate(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    role: Role

    @field_validator("email")
    @classmethod
    def _normalise(cls, v: str) -> str:
        return plain_address(v)


class InviteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    role: Role
    status: InviteStatus
    invited_by: uuid.UUID | None = None
    created_at: datetime
    accepted_at: datetime | None = None
    revoked_at: datetime | None = None
    access: InviteAccess = "pending"
    access_error: str | None = None
    # The last grant attempt.
    access_at: datetime | None = None
    email_status: InviteEmailStatus = "not_sent"
    email_error: str | None = None
    # When the email got its status (queued: when it was owed; sent: when it went out).
    email_at: datetime | None = None
    # Where the invitee signs in with Google (the link the email carries).
    sign_in_url: str


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
    """A call a member's disable owes (a provider revoke, a runtime cancel), or a change
    to a person's Google IAP access that failed (an IAP revoke or grant), and how it
    stands: pending (retried by the tick), failed (no more automatic retries; Retry or
    Dismiss), done, or dismissed by an owner."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    member_id: uuid.UUID
    kind: Literal["provider_revoke", "run_cancel", "iap_revoke", "iap_grant"]
    provider: str | None = None
    # iap_revoke, iap_grant: the address whose access it changes.
    email: str | None = None
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
