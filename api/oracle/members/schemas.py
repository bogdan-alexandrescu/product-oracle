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
    created_at: datetime
    # A removed member is disabled (C2): kept, so history keeps their name.
    disabled_at: datetime | None = None
    disabled_by: uuid.UUID | None = None

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
    status: InviteStatus
    invited_by: uuid.UUID | None = None
    created_at: datetime
    accepted_at: datetime | None = None
    revoked_at: datetime | None = None


class ApiTokenOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    # The role a user-less token acts with; a token for a user acts as that user.
    role: Role
    user_id: uuid.UUID | None = None
    created_at: datetime
    last_used_at: datetime | None = None
    revoked_at: datetime | None = None


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
