"""Company settings API: GET / PUT /v1/settings/{key} (owner only), plus read helpers.

The known keys and how each value is checked:

- ``iap_default_role``: one of the roles; the role of a Google sign-in without an invite.
- ``confidence_weights``: overrides of ``oracle.confidence.DEFAULTS``, same shape.
- ``review_policy``: the company's default review policy (``oracle.review.state``):
  designated decider, mandatory reviewers, required sections, which sections need an
  approval before a publish, re-review on change. A document's own policy replaces it.

- ``publish_latest_only``: true (default) refuses publishing a version a newer one
  superseded; false lets an approved older version be published.
- ``blocker_risk_acceptance_role`` (B4): ``approver`` or ``owner``, the lowest role that
  may accept a critical hard blocker's risk or approve its feasibility scope.
- ``blocker_risk_review_max_days`` (B4): an integer, 1-365, the latest review date of an
  accepted risk, in days from its acceptance.
- ``decision_irreversible_role`` (H1): ``approver`` or ``owner``, the lowest role whose
  approver may decide a hard-to-reverse decision.
- ``company_email_domains`` (S5): the company's email domains, e.g. ``["example.com"]``.
  A doc in a picked Drive folder whose owner is outside them is skipped; with none set
  (here or in ORACLE_IAP_ALLOWED_DOMAINS) every doc in a picked folder is. Public mail
  providers (gmail.com, outlook.com, gmx.de, ...) are refused: anyone has an address there.
- ``company_shared_drives`` (S5): ``[{"id", "name"}]``, the Google shared drives that are
  the company's. A doc in a picked folder in any other shared drive is skipped.

Removing a domain or a shared drive (or resetting either) takes effect on save (S5, owner
2026-10-20): the docs in picked folders that now fall outside are deleted (soft delete)
from every member's Google Docs sources in the same request, with no Drive call
(:func:`oracle.sources.service.hide_outside_company`).

``PUT`` with ``{"value": null}`` resets a key to its default.
"""

import re
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.deps import Principal, TenantDB
from oracle.auth.models import ROLES
from oracle.authz import recheck_caller, require_role
from oracle.baseline.models import LINK_KINDS
from oracle.confidence import DEFAULTS as CONFIDENCE_DEFAULTS
from oracle.sources.models import ITEM_KINDS, SOURCE_KINDS
from oracle.tenant_settings import TenantSetting

DEFAULTS: dict[str, Any] = {
    "iap_default_role": "commenter",
    "confidence_weights": {},
    "review_policy": {
        "decider_id": None,
        "mandatory_reviewer_ids": [],
        "required_section_keys": [],
        "section_approval": "required_sections",
        "rereview_on_change": True,
    },
    "publish_latest_only": True,
    # B4 (owner, 2026-10-19): owners only, reviewed within at most 90 days.
    "blocker_risk_acceptance_role": "owner",
    "blocker_risk_review_max_days": 90,
    # H1: hard-to-reverse decisions are an owner's call unless an owner lowers it.
    "decision_irreversible_role": "owner",
    # S5 (owner, 2026-10-20): explicit, never inferred in production.
    "company_email_domains": [],
    "company_shared_drives": [],
}
# Settings the publish gate reads: a change takes the review gate exclusively, so it
# never lands while a publish renders (oracle.review.publish.gate_lock). Every other
# key takes it shared; either way the caller is re-read under it.
GATE_KEYS = ("review_policy", "publish_latest_only")
RISK_ACCEPTANCE_ROLES = ("approver", "owner")
# Changing these narrows every member's Google Docs sources at once (S5).
COMPANY_KEYS = ("company_email_domains", "company_shared_drives")
DOMAIN = re.compile(
    r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})"
)
MAX_COMPANY_LIST = 100
MAX_REVIEW_DAYS = 365
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
    if key == "confidence_weights":
        return validate_confidence_weights(value)
    if key == "review_policy":
        from oracle.review.state import PolicyError, validate_policy

        try:
            return await validate_policy(session, value)
        except PolicyError as e:
            raise InvalidSetting(str(e)) from None
    if key == "publish_latest_only":
        if not isinstance(value, bool):
            raise InvalidSetting("publish_latest_only must be true or false")
        return value
    if key == "blocker_risk_acceptance_role":
        if value not in RISK_ACCEPTANCE_ROLES:
            raise InvalidSetting(
                f"blocker_risk_acceptance_role must be one of {', '.join(RISK_ACCEPTANCE_ROLES)}"
            )
        return value
    if key == "decision_irreversible_role":
        if value not in RISK_ACCEPTANCE_ROLES:
            raise InvalidSetting(
                f"decision_irreversible_role must be one of {', '.join(RISK_ACCEPTANCE_ROLES)}"
            )
        return value
    if key == "blocker_risk_review_max_days":
        if isinstance(value, bool) or not isinstance(value, int):
            raise InvalidSetting("blocker_risk_review_max_days must be a whole number of days")
        if not 1 <= value <= MAX_REVIEW_DAYS:
            raise InvalidSetting(
                f"blocker_risk_review_max_days must be between 1 and {MAX_REVIEW_DAYS}"
            )
        return value
    if key == "company_email_domains":
        return validate_company_domains(value)
    if key == "company_shared_drives":
        return validate_shared_drives(value)
    raise KeyError(key)


def validate_company_domains(value: Any) -> list[str]:
    from oracle.sources.service import is_public_mail_domain

    if not isinstance(value, list) or not all(isinstance(d, str) for d in value):
        raise InvalidSetting("company_email_domains must be a list of domains")
    if len(value) > MAX_COMPANY_LIST:
        raise InvalidSetting(f"company_email_domains: at most {MAX_COMPANY_LIST}")
    out: list[str] = []
    for raw in value:
        domain = raw.strip().lower().rpartition("@")[2]
        if not DOMAIN.fullmatch(domain):
            raise InvalidSetting(f"company_email_domains: {raw[:80]!r} is not a domain")
        if is_public_mail_domain(domain):
            raise InvalidSetting(
                f"company_email_domains: {domain} is a public mail provider, where anyone "
                "can have an address; enter the company's own domain"
            )
        if domain not in out:
            out.append(domain)
    return out


def validate_shared_drives(value: Any) -> list[dict[str, str]]:
    from oracle.sources.connectors.google_docs import valid_id

    if not isinstance(value, list) or len(value) > MAX_COMPANY_LIST:
        raise InvalidSetting(
            f"company_shared_drives must be a list of at most {MAX_COMPANY_LIST} shared drives"
        )
    out: dict[str, dict[str, str]] = {}
    for drive in value:
        if not isinstance(drive, dict) or not valid_id(drive.get("id")):
            raise InvalidSetting("company_shared_drives: each needs the id of a shared drive")
        name = drive.get("name")
        if name is not None and not isinstance(name, str):
            raise InvalidSetting("company_shared_drives: a name must be text")
        name = (name or "").strip()[:200] or drive["id"]
        out.setdefault(drive["id"], {"id": drive["id"], "name": name})
    return list(out.values())


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


async def _company_narrowing(
    db: AsyncSession, principal: Principal, before: tuple[list[str], list[str]] | None
) -> dict[str, int]:
    """Delete, now, the Drive docs a narrower company setting leaves out (S5, owner
    2026-10-20); what the audit event records of it."""
    from oracle.sources.service import hide_outside_company

    if before is None:
        return {}
    await db.flush()
    hidden = await hide_outside_company(db, principal.tenant_id, before)
    return {"hidden_items": hidden} if hidden else {}


@router.put(
    "/settings/{key}",
    response_model=SettingOut,
    responses={404: {"description": "Unknown key"}, 422: {"description": "Invalid value"}},
)
async def put_setting(key: str, body: SettingIn, principal: Owner, db: TenantDB) -> SettingOut:
    from oracle.sources.service import company_scope

    if key not in DEFAULTS:
        raise _unknown(key)
    # Every key: the caller must still be an owner when the change lands (a rogue owner
    # being disabled must not raise iap_default_role with a request in flight).
    await recheck_caller(db, principal, "owner", shared=key not in GATE_KEYS)
    before = await company_scope(db, principal.tenant_id) if key in COMPANY_KEYS else None
    if body.value is None:
        await clear_setting(db, key)
        extra = await _company_narrowing(db, principal, before)
        await audit.record(
            db, principal, "setting.reset", "tenant_setting", data={"key": key, **extra}
        )
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
    extra = await _company_narrowing(db, principal, before)
    await audit.record(
        db,
        principal,
        "setting.update",
        "tenant_setting",
        data={"key": key, "value": value, **extra},
    )
    await db.commit()
    await db.refresh(row)
    return await _out(db, key)
