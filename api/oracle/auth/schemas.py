import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from oracle.auth.models import Role


class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=1, max_length=1024)


class Me(BaseModel):
    kind: Literal["user", "token"]
    tenant_id: uuid.UUID
    role: Role
    user_id: uuid.UUID | None = None
    email: str | None = None
    # A3: whether the caller acts for an engineering lead (false for a token acting for
    # no member).
    engineering_lead: bool = False
    token_id: uuid.UUID | None = None
    token_name: str | None = None
    # A5: the member's name, when they or an owner set one.
    name: str | None = None
    # A5: the roles the caller may invite people with and approve access requests as
    # (owners all four, approvers viewer and commenter, others none).
    invite_roles: list[Role] = []


AccessStateName = Literal[
    "member",
    "pending",
    "approved",
    "declined",
    "invite_expired",
    "invite_only",
    "outside_domains",
    "removed",
    "no_google_sign_in",
]


class AccessStateOut(BaseModel):
    """Where a Google-signed person stands (A5): never anything about other people."""

    state: AccessStateName
    email: str | None = None
    company: str | None = None
    requested_at: datetime | None = None
    note: str | None = None
    invite_expired_at: datetime | None = None


class AccessNote(BaseModel):
    note: str | None = Field(default=None, max_length=500)
