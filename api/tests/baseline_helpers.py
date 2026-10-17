"""Shared setup for the baseline tests: a company with one person per role, sources."""

import hashlib
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from oracle.auth.models import ApiToken, User
from oracle.auth.service import create_api_token, make_session_cookie
from oracle.config import get_settings
from oracle.sources.models import Source, SourceItem, SourceItemVersion
from oracle.tenancy import tenant_session
from tests.conftest import make_tenant

NOW = datetime.now(UTC)


@dataclass
class Ctx:
    tenant_id: uuid.UUID
    users: dict[str, User] = field(default_factory=dict)
    token: str = ""
    token_id: uuid.UUID | None = None

    def as_(self, name: str) -> dict[str, str]:
        if name == "token":
            return {"Authorization": f"Bearer {self.token}"}
        cookie = make_session_cookie(self.users[name])
        return {"Cookie": f"{get_settings().session_cookie_name}={cookie}"}


async def make_ctx(name: str = "Example Co") -> Ctx:
    """Owner, approver, commenter and viewer users plus an owner API token."""
    tenant_id = await make_tenant(name)
    ctx = Ctx(tenant_id=tenant_id)
    async with tenant_session(tenant_id) as s:
        for role in ("owner", "approver", "commenter", "viewer"):
            user = User(email=f"{role}@example.com", password_hash="x", role=role)
            s.add(user)
            ctx.users[role] = user
        token, raw = await create_api_token(s, "agent-track")
        await s.commit()
        ctx.token, ctx.token_id = raw, token.id
    return ctx


async def set_token_role(ctx: Ctx, role: str) -> None:
    async with tenant_session(ctx.tenant_id) as s:
        token = await s.get(ApiToken, ctx.token_id)
        token.role = role
        await s.commit()


async def make_item(
    ctx: Ctx,
    owner: str,
    *,
    kind: str = "slack",
    item_kind: str = "message",
    content: str = "Guided setup is the top request from new accounts.",
    title: str | None = "#product thread",
    url: str | None = "https://chat.example.com/archives/C1/p1",
    updated: datetime | None = None,
    acl: dict | None = None,
) -> uuid.UUID:
    async with tenant_session(ctx.tenant_id) as s:
        source = Source(
            owner_user_id=ctx.users[owner].id,
            kind=kind,
            name=f"{kind}-{uuid.uuid4().hex[:6]}",
        )
        s.add(source)
        await s.flush()
        item = SourceItem(
            source_id=source.id,
            external_id=uuid.uuid4().hex,
            kind=item_kind,
            title=title,
            url=url,
            acl=acl or {},
            source_updated_at=updated or NOW - timedelta(days=1),
        )
        s.add(item)
        await s.flush()
        version = SourceItemVersion(
            item_id=item.id,
            title=title,
            content=content,
            content_hash=hashlib.sha256(content.encode()).hexdigest(),
        )
        s.add(version)
        await s.flush()
        item.current_version_id = version.id
        await s.commit()
        return item.id


async def entity(client, ctx: Ctx, who: str = "owner", **body) -> dict:
    body.setdefault("title", body.get("key", "x").replace("-", " ").capitalize())
    resp = await client.post("/v1/baseline/entities", json=body, headers=ctx.as_(who))
    assert resp.status_code in (201, 202), resp.text
    return resp.json()["entity"]


async def edge(client, ctx: Ctx, src: dict, dst: dict, type_: str, who="owner", **body) -> dict:
    body = {"src_id": src["id"], "dst_id": dst["id"], "type": type_, **body}
    resp = await client.post("/v1/baseline/edges", json=body, headers=ctx.as_(who))
    assert resp.status_code == 201, resp.text
    return resp.json()["edge"]


async def confirm(client, ctx: Ctx, ent: dict) -> dict:
    resp = await client.post(
        f"/v1/baseline/entities/{ent['id']}/confirm", headers=ctx.as_("approver")
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def cite(client, ctx: Ctx, ent: dict, who: str = "owner", kind="entities", **body) -> dict:
    resp = await client.post(
        f"/v1/baseline/{kind}/{ent['id']}/evidence", json=body, headers=ctx.as_(who)
    )
    assert resp.status_code == 201, resp.text
    return resp.json()
