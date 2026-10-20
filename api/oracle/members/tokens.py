"""Every credential of a company, by kind: personal and service API tokens, run tokens and
MCP clients' OAuth grants. Listed for owners (Settings > API tokens) and, a member's own,
for My account; revoked by id whatever the kind. Never a secret: only hashes are stored.

Functions flush, never commit; the router commits once per request.
"""

import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.models import ApiToken, User
from oracle.auth.service import token_role
from oracle.members.schemas import ApiTokenOut, TokenKind

if TYPE_CHECKING:
    from oracle.auth.deps import Principal

FULL_SCOPES = ["oracle:read", "oracle:write"]


def scopes_of(scope: str | None) -> list[str]:
    """A personal token's or grant's scopes, sorted; no scope: every one."""
    return sorted(set(scope.split())) if scope else list(FULL_SCOPES)


def api_token_out(token: ApiToken, user: User | None) -> ApiTokenOut:
    if token.user_id is None:
        return ApiTokenOut(
            id=token.id,
            name=token.name,
            kind="service",
            role=token.role,
            created_at=token.created_at,
            last_used_at=token.last_used_at,
            revoked_at=token.revoked_at,
        )
    return ApiTokenOut(
        id=token.id,
        name=token.name,
        kind="personal",
        role=token_role(user.role if user else "viewer", token.scope),
        user_id=token.user_id,
        owner_email=user.email if user else None,
        scopes=scopes_of(token.scope),
        created_at=token.created_at,
        last_used_at=token.last_used_at,
        revoked_at=token.revoked_at,
    )


@dataclass
class Grant:
    """One MCP client's OAuth grant: every token row descending from one consent."""

    id: uuid.UUID  # the family id
    client_pk: uuid.UUID
    client_id: str
    client_name: str
    user_id: uuid.UUID
    scope: str
    authorized_at: datetime
    # The newest row: issued at the last refresh (access tokens record no use).
    last_used_at: datetime
    expires_at: datetime
    revoked_at: datetime | None

    @property
    def live(self) -> bool:
        return self.revoked_at is None and self.expires_at > datetime.now(UTC)


async def grants(
    session: AsyncSession, *, user_id: uuid.UUID | None = None, grant_id: uuid.UUID | None = None
) -> list[Grant]:
    """MCP grants, oldest first. A grant is revoked once none of its rows is active."""
    from oracle.mcp.oauth.models import OAuthClient, OAuthToken

    stmt = (
        select(OAuthToken, OAuthClient)
        .join(OAuthClient, OAuthClient.id == OAuthToken.client_id)
        .order_by(OAuthToken.created_at, OAuthToken.id)
    )
    if user_id is not None:
        stmt = stmt.where(OAuthToken.user_id == user_id)
    if grant_id is not None:
        stmt = stmt.where(OAuthToken.family_id == grant_id)
    out: dict[uuid.UUID, Grant] = {}
    for row, client in (await session.execute(stmt)).all():
        g = out.get(row.family_id)
        if g is None:
            out[row.family_id] = Grant(
                id=row.family_id,
                client_pk=client.id,
                client_id=client.client_id,
                client_name=client.name,
                user_id=row.user_id,
                scope=row.scope,
                authorized_at=row.created_at,
                last_used_at=row.created_at,
                expires_at=row.refresh_expires_at,
                revoked_at=row.revoked_at,
            )
            continue
        # Rows come oldest first: the newest decides scope and expiry.
        g.scope, g.last_used_at, g.expires_at = row.scope, row.created_at, row.refresh_expires_at
        g.revoked_at = row.revoked_at
    return list(out.values())


async def _users(session: AsyncSession, ids: Iterable[uuid.UUID | None]) -> dict[uuid.UUID, User]:
    wanted = {i for i in ids if i is not None}
    if not wanted:
        return {}
    return {u.id: u for u in await session.scalars(select(User).where(User.id.in_(wanted)))}


def grant_out(g: Grant, user: User | None) -> ApiTokenOut:
    from oracle.mcp.oauth.service import effective_role

    return ApiTokenOut(
        id=g.id,
        name=g.client_name,
        kind="mcp_client",
        role=effective_role(user.role if user else "viewer", g.scope),
        user_id=g.user_id,
        owner_email=user.email if user else None,
        scopes=scopes_of(g.scope),
        created_at=g.authorized_at,
        last_used_at=g.last_used_at,
        revoked_at=g.revoked_at,
        expires_at=g.expires_at,
        client_id=g.client_id,
    )


async def list_tokens(
    session: AsyncSession, *, kind: TokenKind | None = None, user_id: uuid.UUID | None = None
) -> list[ApiTokenOut]:
    """Every credential of the company, oldest first, revoked ones included; ``kind`` and
    ``user_id`` (the member it acts for) narrow it."""
    from oracle.runs.models import Run
    from oracle.runtokens import RunToken

    out: list[ApiTokenOut] = []
    if kind in (None, "personal", "service"):
        stmt = select(ApiToken).order_by(ApiToken.created_at)
        if kind == "personal" or user_id is not None:
            stmt = stmt.where(ApiToken.user_id.is_not(None))
        if kind == "service":
            stmt = stmt.where(ApiToken.user_id.is_(None))
        if user_id is not None:
            stmt = stmt.where(ApiToken.user_id == user_id)
        rows = list(await session.scalars(stmt))
        users = await _users(session, (t.user_id for t in rows))
        out += [api_token_out(t, users.get(t.user_id)) for t in rows]  # type: ignore[arg-type]
    if kind in (None, "run"):
        stmt = select(RunToken, Run).join(Run, Run.id == RunToken.run_id)
        if user_id is not None:
            stmt = stmt.where(Run.created_by == user_id)
        pairs = (await session.execute(stmt.order_by(RunToken.created_at))).all()
        users = await _users(session, (r.created_by for _, r in pairs))
        for token, run in pairs:
            creator = users.get(run.created_by)  # type: ignore[arg-type]
            out.append(
                ApiTokenOut(
                    id=token.id,
                    name=f"Run · {run.flow.replace('_', ' ')}",
                    kind="run",
                    role=creator.role if creator else "viewer",
                    user_id=run.created_by,
                    owner_email=creator.email if creator else None,
                    scopes=sorted(token.scopes),
                    created_at=token.created_at,
                    last_used_at=token.last_used_at,
                    revoked_at=token.revoked_at,
                    expires_at=token.expires_at,
                    run_id=run.id,
                )
            )
    if kind in (None, "mcp_client"):
        found = await grants(session, user_id=user_id)
        users = await _users(session, (g.user_id for g in found))
        out += [grant_out(g, users.get(g.user_id)) for g in found]
    out.sort(key=lambda t: t.created_at)
    return out


async def open_token_counts(session: AsyncSession) -> dict[uuid.UUID, int]:
    """Per member: unrevoked personal API tokens plus live MCP grants."""
    from oracle.mcp.oauth.models import OAuthToken

    counts: dict[uuid.UUID, int] = {}
    personal = await session.execute(
        select(ApiToken.user_id, func.count())
        .where(ApiToken.user_id.is_not(None), ApiToken.revoked_at.is_(None))
        .group_by(ApiToken.user_id)
    )
    for user_id, n in personal.all():
        counts[user_id] = counts.get(user_id, 0) + n
    live = await session.execute(
        select(OAuthToken.user_id, func.count(func.distinct(OAuthToken.family_id)))
        .where(OAuthToken.revoked_at.is_(None), OAuthToken.refresh_expires_at > func.now())
        .group_by(OAuthToken.user_id)
    )
    for user_id, n in live.all():
        counts[user_id] = counts.get(user_id, 0) + n
    return counts


async def revoke_run_token(
    session: AsyncSession, principal: "Principal", token_id: uuid.UUID
) -> bool:
    """Revoke a run token (the gate is held by the caller). False when unknown. The run
    goes on; its agents can no longer call Oracle with this token. Twice is a no-op."""
    from oracle.runtokens import RunToken

    token = await session.get(RunToken, token_id, with_for_update=True)
    if token is None:
        return False
    if token.revoked_at is None:
        token.revoked_at = datetime.now(UTC)
        await session.flush()
        await audit.record(
            session,
            principal,
            "run_token.revoke",
            "run_token",
            token.id,
            {"run_id": str(token.run_id)},
        )
    return True


async def revoke_grant(
    session: AsyncSession, principal: "Principal", grant: Grant, why: str
) -> None:
    """End an MCP client's grant (every token of it, refresh included) and lapse the
    approvals made through it (as the client's own revocation does). Twice: a no-op."""
    from oracle.mcp.oauth.models import OAuthClient
    from oracle.mcp.oauth.service import _revoke_family

    if grant.revoked_at is not None:
        return
    client = await session.get(OAuthClient, grant.client_pk)
    await _revoke_family(session, grant.id, client, why)  # type: ignore[arg-type]
    await audit.record(
        session,
        principal,
        "mcp_grant.revoke",
        "mcp_grant",
        grant.id,
        {
            "client_id": grant.client_id,
            "client_name": grant.client_name,
            "user_id": str(grant.user_id),
            "why": why,
        },
    )
