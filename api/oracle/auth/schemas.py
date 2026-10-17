import uuid
from typing import Literal

from pydantic import BaseModel, Field


class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=1, max_length=1024)


class Me(BaseModel):
    kind: Literal["user", "token"]
    tenant_id: uuid.UUID
    user_id: uuid.UUID | None = None
    email: str | None = None
    token_id: uuid.UUID | None = None
    token_name: str | None = None
