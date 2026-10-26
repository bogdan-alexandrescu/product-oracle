"""Shared helpers for the connections, settings and LLM gateway tests."""

import json
import uuid
from collections.abc import Callable
from dataclasses import dataclass

import httpx

from oracle import crypto
from oracle.auth.models import User
from oracle.auth.service import create_user, make_session_cookie
from oracle.config import get_settings
from oracle.connections.models import Connection
from oracle.connections.router import fireflies_http, provider_http
from oracle.main import app
from oracle.tenancy import tenant_session


@dataclass
class Person:
    user: User
    headers: dict[str, str]

    @property
    def id(self) -> uuid.UUID:
        return self.user.id


async def make_person(tenant_id: uuid.UUID, email: str, role: str = "owner") -> Person:
    async with tenant_session(tenant_id) as s:
        user = await create_user(s, email, "a-long-password")
        user.role = role
        await s.commit()
    cookie = f"{get_settings().session_cookie_name}={make_session_cookie(user)}"
    return Person(user=user, headers={"Cookie": cookie})


Handler = Callable[[httpx.Request], httpx.Response]


def use_provider_http(handler: Handler) -> list[httpx.Request]:
    """Route the API's provider calls to ``handler``; returns the list of requests seen."""
    seen: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    async def override():
        async with httpx.AsyncClient(transport=httpx.MockTransport(record)) as client:
            yield client

    app.dependency_overrides[provider_http] = override
    app.dependency_overrides[fireflies_http] = override
    return seen


def clear_provider_http() -> None:
    app.dependency_overrides.pop(provider_http, None)
    app.dependency_overrides.pop(fireflies_http, None)


async def add_connection(
    tenant_id: uuid.UUID,
    user_id: uuid.UUID,
    provider: str = "github",
    *,
    bundle: dict | None = None,
    auth_mode: str = "token",
    account_id: str = "1",
    status: str = "active",
    expires_at=None,
    label: str = "example",
    scopes: list[str] | None = None,
) -> Connection:
    async with tenant_session(tenant_id) as s:
        conn = Connection(
            user_id=user_id,
            provider=provider,
            auth_mode=auth_mode,
            account_id=account_id,
            account_label=label,
            ciphertext=crypto.encrypt(json.dumps(bundle or {"access_token": "tok"}).encode()),
            key_version=crypto.KEY_VERSION,
            scopes=scopes or [],
            status=status,
            expires_at=expires_at,
        )
        s.add(conn)
        await s.commit()
        return conn
