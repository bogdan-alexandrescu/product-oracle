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
