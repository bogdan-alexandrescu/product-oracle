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
