import uuid
from typing import Literal

from pydantic import BaseModel, Field

from oracle.auth.models import Role


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
