"""H11 Autonomy routes: the levels (GET / PUT /v1/autonomy) and the "Oracle did" rows
(open, undo).

Everyone reads the levels (run tokens with read:baseline too, as ``get_autonomy``); only
an owner changes one, with a reason. Each change is audited as ``autonomy.changed`` with
before, after and the reason.
"""

import uuid
from datetime import UTC, datetime
from typing import Annotated, Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, autonomy
from oracle.auth.deps import CurrentPrincipal, Principal, TenantDB
from oracle.authz import recheck_caller, require_role
from oracle.autonomy_models import OracleAction
from oracle.runs.schemas import InboxOracleAction
from oracle.tenant_settings import TenantSetting

router = APIRouter(prefix="/v1", tags=["autonomy"])
Viewer = Annotated[Principal, Depends(require_role("viewer"))]
Owner = Annotated[Principal, Depends(require_role("owner"))]
# The newest "Oracle did" rows the Inbox shows a person.
INBOX_LIMIT = 50
UNDO_METHODS = ("POST", "PUT", "PATCH", "DELETE")


class AutonomyItem(BaseModel):
    key: str
    title: str
    group: str
    group_title: str
    level: autonomy.Level
    default: autonomy.Level
    ceiling: autonomy.Level
    # The levels an owner may choose (at or below the ceiling), lowest first.
    allowed: list[autonomy.Level]
    # What Oracle does at each allowed level, one sentence each.
    levels: dict[str, str]
    # Why the levels above the ceiling stay with people.
    ceiling_reason: str | None = None
    # The act limits in force (fixed ones included), their JSON schema, which are fixed,
    # and a few words for them ("within one goal, up to 3 places").
    limits: dict[str, Any] | None = None
    limits_schema: dict[str, Any] | None = None
    fixed_limits: list[str] = []
    limits_summary: str | None = None
    # False: the behaviour the current level steers is not built yet; the level takes
    # effect when the pick ``wired_by`` ships.
    wired: bool
    wired_by: str
    wired_by_name: str


class AutonomyOut(BaseModel):
    items: list[AutonomyItem]
    # What Oracle never decides, at any setting.
    stays_with_people: list[str]
    # Who changed a level last (a user or API token id) and when; None before any change.
    updated_by: uuid.UUID | None = None
    updated_at: datetime | None = None


class AutonomyIn(BaseModel):
    level: autonomy.Level
    limits: dict[str, Any] | None = None
    reason: str = Field(min_length=1, max_length=2000)

    @field_validator("reason")
    @classmethod
    def _reason(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Say why")
        return v.strip()


def item_out(r: autonomy.Responsibility, stored: dict[str, Any] | None) -> AutonomyItem:
    lim = autonomy.effective_limits(r, (stored or {}).get("limits"))
    level = autonomy.level_of(r, stored)
    return AutonomyItem(
        key=r.key,
        title=r.title,
        group=r.group,
        group_title=autonomy.GROUPS[r.group],
        level=level,
        default=r.default,
        ceiling=r.ceiling,
        allowed=autonomy.allowed(r),
        levels=dict(r.levels),
        ceiling_reason=r.ceiling_reason,
        limits=lim.model_dump() if lim is not None else None,
        limits_schema=r.limits.model_json_schema() if r.limits is not None else None,
        fixed_limits=autonomy.fixed_limits(r.limits),
        limits_summary=r.summary(lim),
        wired=r.wired_at(level),
        wired_by=r.wired_by,
        wired_by_name=r.wired_by_name,
    )


def _snapshot(r: autonomy.Responsibility, stored: dict[str, Any] | None) -> dict[str, Any]:
    lim = autonomy.effective_limits(r, (stored or {}).get("limits"))
    return {
        "level": autonomy.level_of(r, stored),
        "limits": lim.model_dump() if lim is not None else None,
    }


@router.get("/autonomy", response_model=AutonomyOut)
async def get_autonomy(principal: Viewer, db: TenantDB) -> AutonomyOut:
    """How far Oracle may go on its own, per responsibility: the level, what it means,
    the ceiling and the limits."""
    row = await db.scalar(select(TenantSetting).where(TenantSetting.key == autonomy.SETTING))
    value = row.value if row is not None and isinstance(row.value, dict) else {}
    return AutonomyOut(
        items=[item_out(r, value.get(r.key)) for r in autonomy.REGISTRY.values()],
        stays_with_people=list(autonomy.STAYS_WITH_PEOPLE),
        updated_by=row.updated_by if row is not None and value else None,
        updated_at=row.updated_at if row is not None and value else None,
    )


@router.put(
    "/autonomy/{key}",
    response_model=AutonomyItem,
    responses={
        404: {"description": "Unknown responsibility"},
        422: {"description": "Above the ceiling, a bad or fixed limit, or no reason"},
    },
)
async def set_autonomy(key: str, body: AutonomyIn, principal: Owner, db: TenantDB) -> AutonomyItem:
    """Set how far Oracle may go for one responsibility (owner), with a reason."""
    try:
        r = autonomy.get(key)
    except autonomy.UnknownResponsibility as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from None
    await recheck_caller(db, principal, "owner", shared=True)
    # One row per company: made if missing, then locked, so two owners saving at once
    # each change their own key.
    await db.execute(
        pg_insert(TenantSetting)
        .values(
            id=uuid.uuid4(),
            tenant_id=principal.tenant_id,
            key=autonomy.SETTING,
            value={},
            updated_by=principal.id,
        )
        .on_conflict_do_nothing(index_elements=["tenant_id", "key"])
    )
    row = await db.scalar(
        select(TenantSetting)
        .where(TenantSetting.key == autonomy.SETTING)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    assert row is not None
    value = dict(row.value) if isinstance(row.value, dict) else {}
    before = value.get(key) or {}
    try:
        after = autonomy.validate_change(key, body.level, body.limits, before)
    except autonomy.AutonomyError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from None
    row.value = {**value, key: after}
    row.updated_by = principal.id
    await audit.record(
        db,
        principal,
        "autonomy.changed",
        "autonomy",
        data={
            "key": key,
            "before": _snapshot(r, before),
            "after": _snapshot(r, after),
            "reason": body.reason,
        },
    )
    await db.commit()
    return item_out(r, after)


# --- "Oracle did" ----------------------------------------------------------------------


def action_out(action: OracleAction, me: uuid.UUID) -> InboxOracleAction:
    r = autonomy.REGISTRY.get(action.responsibility)
    done = me in (action.opened_by or []) or action.undone_at is not None
    return InboxOracleAction(
        id=action.id,
        responsibility=action.responsibility,
        responsibility_title=r.title if r else action.responsibility,
        summary=action.summary,
        subject=action.subject or {},
        undo=action.undo,
        state="done" if done else "open",
        counts=not done,
        created_at=action.created_at,
        undone_at=action.undone_at,
    )


async def inbox_actions(db: AsyncSession, principal: Principal) -> list[InboxOracleAction]:
    """The "Oracle did" rows of the people it notified, newest first."""
    me = principal.id
    rows = await db.scalars(
        select(OracleAction)
        .where(OracleAction.notify_ids.contains([me]))
        .order_by(OracleAction.created_at.desc(), OracleAction.id)
        .limit(INBOX_LIMIT)
    )
    return [action_out(a, me) for a in rows]


async def _mine(db: AsyncSession, principal: Principal, action_id: uuid.UUID) -> OracleAction:
    action = await db.scalar(
        select(OracleAction)
        .where(OracleAction.id == action_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if action is None or principal.id not in (action.notify_ids or []):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return action


def _opened(action: OracleAction, me: uuid.UUID) -> None:
    if me not in (action.opened_by or []):
        action.opened_by = [*(action.opened_by or []), me]


@router.post("/oracle-actions/{action_id}/open", response_model=InboxOracleAction)
async def open_oracle_action(
    action_id: uuid.UUID, principal: CurrentPrincipal, db: TenantDB
) -> InboxOracleAction:
    """Mark an "Oracle did" row opened, for me only: it stops counting in my Inbox."""
    action = await _mine(db, principal, action_id)
    _opened(action, principal.id)
    await db.commit()
    return action_out(action, principal.id)


# Request headers the undo call does not pass on (the client sets its own).
_HOP = {"host", "content-length", "content-type", "transfer-encoding", "connection"}


@router.post(
    "/oracle-actions/{action_id}/undo",
    response_model=InboxOracleAction,
    responses={409: {"description": "Nothing to undo, or already undone"}},
)
async def undo_oracle_action(
    action_id: uuid.UUID, request: Request, principal: CurrentPrincipal, db: TenantDB
) -> InboxOracleAction:
    """Undo what Oracle did: call the route the behaviour stored, as me (my role and
    checks apply), and record that I undid it. A refusal of that route is returned as is
    and records nothing."""
    action = await _mine(db, principal, action_id)
    undo = action.undo or {}
    method, path = str(undo.get("method", "")).upper(), str(undo.get("path", ""))
    if not undo or method not in UNDO_METHODS or not path.startswith("/v1/"):
        raise HTTPException(status.HTTP_409_CONFLICT, "This action has no undo")
    if path.startswith("/v1/oracle-actions"):
        raise HTTPException(status.HTTP_409_CONFLICT, "This action has no undo")
    if action.undone_at is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Already undone")
    # Claimed first, committed, so a second click cannot undo twice; released if the
    # route refuses.
    action.undone_by, action.undone_at = principal.id, datetime.now(UTC)
    await db.commit()
    headers = {k: v for k, v in request.headers.items() if k.lower() not in _HOP}
    transport = httpx.ASGITransport(app=request.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://oracle.internal") as c:
        resp = await c.request(method, path, json=undo.get("body"), headers=headers)
    action = await _mine(db, principal, action_id)
    if resp.status_code >= 400:
        action.undone_by = action.undone_at = None
        await db.commit()
        try:
            detail = resp.json().get("detail", resp.text)
        except ValueError:
            detail = resp.text
        raise HTTPException(resp.status_code, detail)
    _opened(action, principal.id)
    await audit.record(
        db,
        principal,
        "autonomy.undone",
        "oracle_action",
        action.id,
        {"responsibility": action.responsibility, "undo": undo, "status": resp.status_code},
    )
    await db.commit()
    return action_out(action, principal.id)
