"""Shared setup for the coverage tests (A2): sources and items written straight to the
database, a run's headers, a read-only MCP client, and a statement counter.
Synthetic placeholders only."""

import hashlib
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import event

from oracle.auth.service import hash_token, make_session_cookie, sign_run_binding
from oracle.config import get_settings
from oracle.db import get_engine
from oracle.mcp.oauth.models import OAuthClient, OAuthToken
from oracle.runs.models import Run
from oracle.sources.models import Source, SourceItem, SourceItemVersion
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx

NOW = datetime.now(UTC)


def days_ago(n: float) -> datetime:
    return NOW - timedelta(days=n)


async def add_source(
    ctx: Ctx,
    who: str,
    *,
    kind: str = "slack",
    name: str | None = None,
    unavailable: list[dict[str, Any]] | None = None,
    last_synced_at: datetime | None = None,
    status: str = "active",
) -> uuid.UUID:
    async with tenant_session(ctx.tenant_id) as s:
        source = Source(
            owner_user_id=ctx.users[who].id,
            kind=kind,
            name=name or f"{kind}-{uuid.uuid4().hex[:6]}",
            unavailable_items=unavailable or [],
            last_synced_at=last_synced_at,
            status=status,
        )
        s.add(source)
        await s.commit()
        return source.id


async def add_item(
    ctx: Ctx,
    source_id: uuid.UUID,
    *,
    kind: str = "message",
    occurred_at: datetime | None = None,
    updated_at: datetime | None = None,
    fetched_at: datetime | None = None,
    version: bool = True,
    deleted: bool = False,
    title: str | None = "A thread",
) -> uuid.UUID:
    """An item; with ``version`` its one version, fetched at ``fetched_at`` (default now)."""
    async with tenant_session(ctx.tenant_id) as s:
        item = SourceItem(
            source_id=source_id,
            external_id=uuid.uuid4().hex,
            kind=kind,
            title=title,
            occurred_at=occurred_at,
            source_updated_at=updated_at,
            deleted_at=NOW if deleted else None,
        )
        s.add(item)
        await s.flush()
        if version:
            content = f"content {item.id}"
            v = SourceItemVersion(
                item_id=item.id,
                title=title,
                content=content,
                content_hash=hashlib.sha256(content.encode()).hexdigest(),
            )
            if fetched_at is not None:
                v.fetched_at = fetched_at
            s.add(v)
            await s.flush()
            item.current_version_id = v.id
        await s.commit()
        return item.id


async def run_headers(ctx: Ctx, who: str) -> dict[str, str]:
    """Headers of a call a run ``who`` started makes (it reads as a run, S6)."""
    async with tenant_session(ctx.tenant_id) as s:
        run = Run(flow="baseline_to_prd", status="running", created_by=ctx.users[who].id)
        s.add(run)
        await s.commit()
        run_id = run.id
    cookie = make_session_cookie(ctx.users[who])
    return {
        "Cookie": f"{get_settings().session_cookie_name}={cookie}",
        "x-oracle-run-id": sign_run_binding(ctx.users[who].id, run_id),
    }


async def read_only_mcp(ctx: Ctx, who: str) -> dict[str, str]:
    """Headers of an MCP client ``who`` approved with oracle:read only."""
    raw = f"poa_{uuid.uuid4().hex}"
    # Dated when minted, not by the import-time NOW: a long run (xdist) may reach the
    # caller over an hour after this module was imported, and the token would be expired.
    now = datetime.now(UTC)
    async with tenant_session(ctx.tenant_id) as s:
        client = OAuthClient(
            client_id=uuid.uuid4().hex, name="Claude", redirect_uris=["http://localhost/cb"]
        )
        s.add(client)
        await s.flush()
        s.add(
            OAuthToken(
                access_hash=hash_token(raw),
                refresh_hash=hash_token(f"por_{uuid.uuid4().hex}"),
                client_id=client.id,
                user_id=ctx.users[who].id,
                scope="oracle:read",
                expires_at=now + timedelta(hours=1),
                refresh_expires_at=now + timedelta(days=1),
                family_id=uuid.uuid4(),
            )
        )
        await s.commit()
    return {"Authorization": f"Bearer {raw}"}


@contextmanager
def count_statements():
    """Counts the SQL statements sent while the block runs (only those)."""
    seen: list[str] = []

    def listener(conn, cursor, statement, parameters, context, executemany):
        seen.append(statement)

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", listener)
    try:
        yield seen
    finally:
        event.remove(engine, "before_cursor_execute", listener)
