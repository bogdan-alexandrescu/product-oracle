import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from oracle.auth.models import Role
from oracle.rituals.schedule import DEFAULT_ZONE


class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=1, max_length=1024)


class Capabilities(BaseModel):
    """#370: what the caller's role may do, per API operation (operationId)."""

    role: Role
    # A3: the engineering lead flag gates its own actions (date checks, engineering stops).
    engineering_lead: bool = False
    operations: dict[str, bool]
    # Whether the caller decides the engineering stops (A3): owners, and once a lead is
    # named, the leads; with none named, whoever the stop's role allows.
    decide_engineering_stops: bool = False
    # Operations the item decides too (oracle.capabilities.PER_ITEM): the role the handler
    # never refuses on role grounds; below it, only the item's author, asker or approver.
    per_item: dict[str, Role | None] = {}
    # #723: Simple mode is on (ORACLE_SIMPLE_MODE): the web shows the [Simple | Studio]
    # switch and lands people by their saved mode or role.
    simple_mode: bool = False


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
    # #401: the Company time zone (an IANA name) every screen shows dates and times in;
    # every member reads it here (Settings' own GET is for owners).
    company_timezone: str = DEFAULT_ZONE


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
