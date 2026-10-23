import uuid
from typing import Literal

from pydantic import BaseModel, Field

from oracle.auth.models import Role
from oracle.rituals.schedule import DEFAULT_ZONE


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
    # #401: the Company time zone (an IANA name) every screen shows dates and times in;
    # every member reads it here (Settings' own GET is for owners).
    company_timezone: str = DEFAULT_ZONE
