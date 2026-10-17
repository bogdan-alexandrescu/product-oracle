import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from oracle.auth.models import Role

InviteStatus = Literal["open", "accepted", "revoked"]


class MemberOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    role: Role
    created_at: datetime


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
