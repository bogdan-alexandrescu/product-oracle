"""Company settings API: GET / PUT /v1/settings/{key} (owner only), plus read helpers.

The known keys and how each value is checked:

- ``iap_default_role``: one of the roles; the role of a Google sign-in without an invite.
- ``default_claude_connection_id``: a Claude connection of the owner setting it, used
  for Oracle's model calls by users without their own plan; ``null`` clears it.
- ``confidence_weights``: overrides of ``oracle.confidence.DEFAULTS``, same shape.

``PUT`` with ``{"value": null}`` resets a key to its default.
"""

import uuid
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.deps import Principal, TenantDB
from oracle.auth.models import ROLES
from oracle.authz import require_role
from oracle.baseline.models import LINK_KINDS
from oracle.confidence import DEFAULTS as CONFIDENCE_DEFAULTS
from oracle.connections.models import Connection
from oracle.sources.models import ITEM_KINDS, SOURCE_KINDS
from oracle.tenant_settings import TenantSetting

DEFAULTS: dict[str, Any] = {
    "iap_default_role": "commenter",
    "default_claude_connection_id": None,
    "confidence_weights": {},
}
KNOWN_KEYS = tuple(DEFAULTS)


class InvalidSetting(ValueError):
    pass


async def get_setting(session: AsyncSession, key: str) -> Any:
    """The stored value of a known key, or its default."""
    if key not in DEFAULTS:
        raise KeyError(key)
    row = await session.scalar(select(TenantSetting).where(TenantSetting.key == key))
    return DEFAULTS[key] if row is None else row.value


async def clear_setting(session: AsyncSession, key: str) -> None:
    await session.execute(delete(TenantSetting).where(TenantSetting.key == key))


# --- Validation ---------------------------------------------------------------------


def _number(value: Any, where: str, lo: float | None = 0.0, hi: float | None = None) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise InvalidSetting(f"{where} must be a number")
    if lo is not None and value < lo:
        raise InvalidSetting(f"{where} must be at least {lo}")
    if hi is not None and value > hi:
        raise InvalidSetting(f"{where} must be at most {hi}")
    return float(value)


def _kind_key(key: str, where: str) -> None:
    source, _, item = key.partition(":")
    # Public-link evidence is scored as its link kind ("web" has no source of its own).
    if source not in (*SOURCE_KINDS, *LINK_KINDS) or (item and item not in ITEM_KINDS):
        raise InvalidSetting(
            f"{where}: unknown kind {key!r}; use <source kind> or <source kind>:<item kind>"
        )


def validate_confidence_weights(value: Any) -> dict[str, Any]:
    """Partial overrides of confidence.DEFAULTS: same keys, same types, sane ranges."""
    if not isinstance(value, dict):
        raise InvalidSetting("confidence_weights must be an object")
    for key, v in value.items():
        if key not in CONFIDENCE_DEFAULTS:
            known = ", ".join(CONFIDENCE_DEFAULTS)
            raise InvalidSetting(f"confidence_weights: unknown key {key!r}; known: {known}")
        where = f"confidence_weights.{key}"
        default = CONFIDENCE_DEFAULTS[key]
        if isinstance(default, dict):
            if not isinstance(v, dict):
                raise InvalidSetting(f"{where} must be an object")
            for sub, n in v.items():
                if key in ("weights", "goal_impact") and sub not in default:
                    raise InvalidSetting(
                        f"{where}: unknown key {sub!r}; known: {', '.join(default)}"
                    )
                if key in ("source", "half_life_days"):
                    _kind_key(sub, where)
                if key == "half_life_days":
                    num = _number(n, f"{where}.{sub}", lo=None)
                    if num <= 0:
                        raise InvalidSetting(f"{where}.{sub} must be more than 0")
                elif key == "weights":
                    _number(n, f"{where}.{sub}")
                else:
                    _number(n, f"{where}.{sub}", hi=1.0)
            if key == "weights":
                merged = {**default, **v}
                if sum(merged.values()) <= 0:
                    raise InvalidSetting(f"{where}: at least one weight must be above 0")
        else:
            _number(v, where, hi=1.0)
    return value


async def validate(session: AsyncSession, principal: Principal, key: str, value: Any) -> Any:
    if key == "iap_default_role":
        if value not in ROLES:
            raise InvalidSetting(f"iap_default_role must be one of {', '.join(ROLES)}")
        return value
    if key == "default_claude_connection_id":
        try:
            connection_id = uuid.UUID(str(value))
        except ValueError:
            raise InvalidSetting("default_claude_connection_id must be a connection id") from None
        conn = await session.get(Connection, connection_id)
        if conn is None:
            raise InvalidSetting("No such connection")
        if conn.provider != "claude":
            raise InvalidSetting("default_claude_connection_id must be a Claude connection")
        if conn.user_id != principal.user_id:
            raise InvalidSetting("Only your own Claude plan can be the company default")
        if conn.status != "active":
            raise InvalidSetting(f"That Claude connection is {conn.status}; reconnect it first")
        return str(connection_id)
    if key == "confidence_weights":
        return validate_confidence_weights(value)
    raise KeyError(key)


# --- API ----------------------------------------------------------------------------

router = APIRouter(prefix="/v1", tags=["settings"])
Owner = Annotated[Principal, Depends(require_role("owner"))]


class SettingOut(BaseModel):
    key: str
    value: Any
    default: Any
    is_default: bool
    updated_at: datetime | None = None


class SettingIn(BaseModel):
    value: Any = None


def _unknown(key: str) -> HTTPException:
    return HTTPException(
        status.HTTP_404_NOT_FOUND, f"Unknown setting {key!r}; known: {', '.join(KNOWN_KEYS)}"
    )


async def _out(session: AsyncSession, key: str) -> SettingOut:
    row = await session.scalar(select(TenantSetting).where(TenantSetting.key == key))
    return SettingOut(
        key=key,
        value=DEFAULTS[key] if row is None else row.value,
        default=DEFAULTS[key],
        is_default=row is None,
        updated_at=row.updated_at if row else None,
    )


@router.get("/settings", response_model=list[SettingOut])
async def list_settings(principal: Owner, db: TenantDB) -> list[SettingOut]:
    return [await _out(db, key) for key in KNOWN_KEYS]


@router.get("/settings/{key}", response_model=SettingOut)
async def get_setting_endpoint(key: str, principal: Owner, db: TenantDB) -> SettingOut:
    if key not in DEFAULTS:
        raise _unknown(key)
    return await _out(db, key)


@router.put(
    "/settings/{key}",
    response_model=SettingOut,
    responses={404: {"description": "Unknown key"}, 422: {"description": "Invalid value"}},
)
async def put_setting(key: str, body: SettingIn, principal: Owner, db: TenantDB) -> SettingOut:
    if key not in DEFAULTS:
        raise _unknown(key)
    if body.value is None:
        await clear_setting(db, key)
        await audit.record(db, principal, "setting.reset", "tenant_setting", data={"key": key})
        await db.commit()
        return await _out(db, key)
    try:
        value = await validate(db, principal, key, body.value)
    except InvalidSetting as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from None
    row = await db.scalar(select(TenantSetting).where(TenantSetting.key == key))
    if row is None:
        row = TenantSetting(key=key, value=value, updated_by=principal.id)
        db.add(row)
    else:
        row.value = value
        row.updated_by = principal.id
    await audit.record(
        db, principal, "setting.update", "tenant_setting", data={"key": key, "value": value}
    )
    await db.commit()
    await db.refresh(row)
    return await _out(db, key)
