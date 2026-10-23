import re
import unicodedata
import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, computed_field, field_validator

from oracle.auth.models import Role

# expired (A5): open, past its expiry; not claimed at sign-in until resent.
InviteStatus = Literal["open", "expired", "accepted", "revoked"]
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
    # A5: their name, when they or an owner set one (else named from the email).
    name: str | None = None
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
    # Their Google IAP access is still being changed (a failed revoke or grant the tick
    # retries): revoke while removed, grant while active; None when nothing is owed.
    access_pending: MemberAccessPending | None = None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def status(self) -> MemberStatus:
        return "disabled" if self.disabled_at is not None else "active"


class MemberPatch(BaseModel):
    """A role, the engineering lead flag, a name (A5), or several (applied in one
    change: role first). ``"name": null`` clears the name."""

    role: Role | None = None
    engineering_lead: bool | None = None
    name: str | None = Field(default=None, max_length=200)
    # A5: responsibilities moved first, then the role change (one transaction).
    hand_over: list["HandOver"] = Field(default=[], max_length=50)

    @field_validator("name")
    @classmethod
    def _name(cls, v: str | None) -> str | None:
        return clean_name(v)


class NamePatch(BaseModel):
    """``PATCH /v1/me/account``: your name (A5); null clears it."""

    name: str | None = Field(max_length=200)

    @field_validator("name")
    @classmethod
    def _name(cls, v: str | None) -> str | None:
        return clean_name(v)


def clean_name(v: str | None) -> str | None:
    """A person's name (A5): trimmed, 1 to 80 characters, no control characters."""
    if v is None:
        return None
    v = v.strip()
    if not v:
        raise ValueError("A name needs at least one character")
    if len(v) > 80:
        raise ValueError("A name is at most 80 characters")
    if any(unicodedata.category(c) in ("Cc", "Cf") for c in v):
        raise ValueError("A name has no control characters")
    return v


class InviteCreate(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    role: Role
    # A5: how teammates know them; the member takes it at their first sign-in.
    name: str | None = Field(default=None, max_length=200)
    # A3: their first sign-in lands as an engineering lead (never with role viewer).
    engineering_lead: bool = False
    # A personal note sent in the email (#203): plain text; blank is none.
    message: str | None = Field(default=None, max_length=500)

    @field_validator("email")
    @classmethod
    def _normalise(cls, v: str) -> str:
        return plain_address(v)

    @field_validator("name")
    @classmethod
    def _name(cls, v: str | None) -> str | None:
        return clean_name(v)

    @field_validator("message")
    @classmethod
    def _trim(cls, v: str | None) -> str | None:
        return (v or "").strip() or None


class InviteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    role: Role
    engineering_lead: bool = False
    status: InviteStatus
    name: str | None = None
    invited_by: uuid.UUID | None = None
    invited_by_name: str | None = None
    created_at: datetime
    # A5: claimable until then (14 days from creation or the last resend).
    expires_at: datetime
    resent_at: datetime | None = None
    resend_count: int = 0
    # The access request it was approved from, if any.
    access_request_id: uuid.UUID | None = None
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
    # The owner's note to the invitee, sent in the email (#203).
    message: str | None = None


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


AccessRequestStatus = Literal["pending", "approved", "declined", "closed"]


class AccessRequestOut(BaseModel):
    """Someone who signed in with Google without an invite, asking to join (A5)."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    status: AccessRequestStatus
    note: str | None = None
    # When they first asked.
    created_at: datetime
    last_seen_at: datetime
    decided_by: uuid.UUID | None = None
    decided_at: datetime | None = None
    # The role it was approved with, and the invite made for it.
    role: Role | None = None
    invite_id: uuid.UUID | None = None


class AccessApprove(BaseModel):
    role: Role
    name: str | None = Field(default=None, max_length=200)

    @field_validator("name")
    @classmethod
    def _name(cls, v: str | None) -> str | None:
        return clean_name(v)


class SignInDomain(BaseModel):
    domain: str
    # deployment: ORACLE_IAP_ALLOWED_DOMAINS (changed where Oracle is deployed);
    # settings: the owner's company_email_domains.
    source: Literal["deployment", "settings"] = Field(serialization_alias="from")

    model_config = ConfigDict(populate_by_name=True)


class SignInRulesOut(BaseModel):
    google_sign_in: bool
    # ORACLE_IAP_AUTO_PROVISION=false: no new member through Google at all.
    new_sign_ins_off: bool
    domains: list[SignInDomain]
    without_invite: Literal["request", "join", "refuse"]
    default_role: Role


# --- A5: preview, hand-over, member detail ------------------------------------------------


class HandOver(BaseModel):
    """Move one kind of responsibility to ``to`` (an active member with the kind's
    role), or clear it (``to`` null). A kind left out stays as it is."""

    kind: str
    to: uuid.UUID | None = None


class HandOverIn(BaseModel):
    hand_over: list[HandOver] = Field(default=[], max_length=50)


class HeldOut(BaseModel):
    ref: str
    title: str


class ResponsibilityOut(BaseModel):
    kind: str
    label: str
    count: int
    items: list[HeldOut] = []
    needs_role: Role
    # What waits while nobody holds it (e.g. publishing), when anything does.
    blocks: str | None = None


class ImpactResponsibilityOut(ResponsibilityOut):
    # Whether the member may keep it after the change (always false for a removal).
    holder_ok: bool


class HandOverOut(BaseModel):
    responsibilities: list[ResponsibilityOut]


class ImpactRun(BaseModel):
    id: uuid.UUID
    title: str
    status: str


class ImpactEnds(BaseModel):
    sign_in: bool
    api_tokens: int
    mcp_clients: int
    # Counts by provider only: owners never see names of channels, repos or pages.
    connections: dict[str, int]
    sources: int
    runs: list[ImpactRun]
    llm_jobs: int
    invites: int


class ImpactRunRef(BaseModel):
    run_id: uuid.UUID
    title: str


class ImpactCheckpoint(BaseModel):
    run_id: uuid.UUID
    checkpoint_id: uuid.UUID
    kind: str
    title: str


class ImpactVoids(BaseModel):
    spend_approvals: list[ImpactRunRef]
    resumes: list[ImpactRunRef]
    checkpoint_decisions: list[ImpactCheckpoint]


class ImpactVersion(BaseModel):
    document: str
    title: str
    version: int


class ImpactLapses(BaseModel):
    section_approvals: int
    version_approvals: list[ImpactVersion]


class ImpactOut(BaseModel):
    """What removing or demoting the member would do, read as of ``as_of``."""

    member_id: uuid.UUID
    change: Literal["remove", "role"]
    role: Role | None = None
    as_of: datetime
    # What a removal ends; null for a role change.
    ends: ImpactEnds | None = None
    voids: ImpactVoids
    lapses: ImpactLapses
    responsibilities: list[ImpactResponsibilityOut]
    nothing: bool


class JoinedOut(BaseModel):
    at: datetime | None = None
    via: Literal["invite", "access_request", "domain", "seeded", "unknown"]
    by: uuid.UUID | None = None
    by_name: str | None = None


class HoldsOut(BaseModel):
    section_approvals: int
    version_approvals: int
    spend_approvals: int
    checkpoint_decisions: int


class MemberDetailOut(MemberOut):
    joined: JoinedOut
    responsibilities: list[ResponsibilityOut]
    holds: HoldsOut


MemberPatch.model_rebuild()
