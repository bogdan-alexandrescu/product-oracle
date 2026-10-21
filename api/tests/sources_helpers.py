"""Shared setup for the sources tests: users, connections and a scriptable connector."""

import json
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import httpx

from oracle import crypto
from oracle.auth.models import User
from oracle.auth.service import make_session_cookie
from oracle.config import get_settings
from oracle.connections.models import Connection
from oracle.sources.base import CursorCheckpoint, ItemDelete, ItemUpsert
from oracle.tenancy import tenant_session

SECRET_TOKEN = "xoxp-example-secret-token-123"
OLD = datetime(2025, 1, 1, tzinfo=UTC)


async def make_user(tenant_id: uuid.UUID, email: str) -> User:
    async with tenant_session(tenant_id) as s:
        user = User(email=email, password_hash="x", role="owner")
        s.add(user)
        await s.commit()
        return user


async def make_connection(
    tenant_id: uuid.UUID,
    user: User,
    provider: str,
    *,
    credential: dict[str, Any] | None = None,
    status: str = "active",
) -> uuid.UUID:
    async with tenant_session(tenant_id) as s:
        conn = Connection(
            user_id=user.id,
            provider=provider,
            auth_mode="token",
            account_id=f"{provider}-{uuid.uuid4().hex[:6]}",
            account_label=f"{provider} account",
            ciphertext=crypto.encrypt(
                json.dumps(credential or {"access_token": SECRET_TOKEN}).encode()
            ),
            key_version=crypto.KEY_VERSION,
            status=status,
        )
        s.add(conn)
        await s.commit()
        return conn.id


@asynccontextmanager
async def client_for(user: User | None = None, headers: dict[str, str] | None = None):
    from oracle.main import app

    cookies = {get_settings().session_cookie_name: make_session_cookie(user)} if user else None
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://test", cookies=cookies, headers=headers
    ) as c:
        yield c


def message(external_id: str, content: str, **kw: Any) -> ItemUpsert:
    return ItemUpsert(
        external_id=external_id,
        kind=kw.pop("kind", "message"),
        title=kw.pop("title", None),
        url=f"https://chat.example.com/{external_id}",
        author="someone",
        content=content,
        acl=kw.pop("acl", {"channel": "C1"}),
        occurred_at=kw.pop("occurred_at", OLD),
        **kw,
    )


@dataclass
class FakeConnector:
    """Yields ``pages`` from the page in the cursor, a checkpoint after each page.

    ``fail`` maps a page index to an exception raised after that page's first event,
    so a failure lands between checkpoints.
    """

    kind: str
    pages: list[list[ItemUpsert | ItemDelete]] = field(default_factory=list)
    fail: dict[int, Exception] = field(default_factory=dict)
    calls: list[dict[str, Any]] = field(default_factory=list)
    invalid: str | None = None

    async def validate(self, config, credential):
        from oracle.sources.base import ConnectorConfigError

        self.calls.append({"validate": True, "config": config, "credential": credential})
        if self.invalid:
            raise ConnectorConfigError(self.invalid)

    async def sync(self, config, credential, cursor):
        self.calls.append({"config": config, "credential": credential, "cursor": cursor})
        start = (cursor or {}).get("page", 0)
        for n in range(start, len(self.pages)):
            for i, event in enumerate(self.pages[n]):
                yield event
                if i == 0 and n in self.fail:
                    raise self.fail[n]
            if not self.pages[n] and n in self.fail:
                raise self.fail[n]
            yield CursorCheckpoint({"page": n + 1})


async def patch_source(client, source_id, body: dict[str, Any], **kwargs):
    """PATCH a source the way a client must: read it first and send its ``config_version``
    as ``base_version`` (owner 2026-10-20: required wherever config or connection change)."""
    if "base_version" not in body:
        got = await client.get(f"/v1/sources/{source_id}", **kwargs)
        assert got.status_code == 200, got.text
        body = {**body, "base_version": got.json()["config_version"]}
    return await client.patch(f"/v1/sources/{source_id}", json=body, **kwargs)
