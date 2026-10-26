"""Company settings API: GET / PUT /v1/settings/{key} (owner only), plus read helpers.

The known keys and how each value is checked:

- ``iap_default_role``: viewer or commenter (A5; a stored approver or owner is still
  honoured until changed); the role of an approved access request and of a Google sign-in
  that joins at once.
- ``sign_in_without_invite`` (A5): ``request`` (an owner approves first), ``join`` (at
  once, with the default role; the default until the /access page a waiting person sees
  exists) or ``refuse`` (invite only).
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
- ``planning_horizons`` (A1): what Now / Next / Later mean on every roadmap, B2 Goals
  framework's defaults (veto any time): ``short_quarters`` (Now: the current quarter and
  maybe the next), ``medium_quarters`` (Next: the quarters after it) and
  ``long_from_months`` to ``long_to_months`` (Later). Read with :func:`company_horizons`;
  dated with :func:`horizon_windows`. A stored row is the Set up step being done.
- ``autonomy`` (H11): how far Oracle goes on its own, per responsibility
  (``oracle.autonomy``); ``{}`` is every default. Written only through
  ``PUT /v1/autonomy/{key}`` (each change carries a reason); here it can only be reset.

Removing a domain or a shared drive (or resetting either) takes effect on save (S5, owner
2026-10-20): the docs in picked folders that now fall outside are deleted (soft delete)
from every member's Google Docs sources in the same request, with no Drive call
(:func:`oracle.sources.service.hide_outside_company`).

- ``alignment_report`` (F6): the weekly alignment report's schedule and Slack channel,
  ``{"enabled", "weekday": "mon".."sun", "time": "HH:MM",
  "slack_channel": {"id", "name"} | null}`` (oracle.reports.alignment). A partial value
  takes the defaults for the rest.

- ``company_timezone``: the Company time zone, an IANA name (``zoneinfo``),
  America/Los_Angeles by default (owner decision 2026-10-22; H2's A1 Time zone step
  opens Settings › Company to set it). Goals' "today", the decision log's "today" (#336),
  the weekly alignment report's schedule and every ritual read it (a ritual has no zone
  of its own); a change moves every ritual.
- ``ritual_summaries`` (H2): ``on_demand`` or ``always`` (Every pre-read); also set with
  ``PUT /v1/rituals/summaries``.
- ``outcome_measure_days`` (H3): 7-365, default 30: an outcome is checked at the later of
  its prediction's ``by`` and this many days after it shipped.
- ``calibration_min_outcomes`` (H3): 1-100, default 5: assessed outcomes a goal (or the
  company) needs before its track record sets a factor.
- ``request_asked_again_threshold`` (H10): 1-20, default 3: requests merged into a
  declined one with a logged decision before its approver hears it was asked again.
- ``outcome_calibration`` (H3): ``apply`` (default) multiplies priority confidence by the
  track record; ``show`` only displays it.
- ``pricing_owner`` (H9): the one person who decides prices, an active owner's user id;
  null reads as the earliest active owner (:func:`oracle.pricing.decide.pricing_owner`).

- ``web_searches_per_month`` (H7): 0-2,000, default 200: the open-web searches Oracle's
  digest runs may make in the Company time zone's month (counted from ``web_searches``);
  0 turns web search off.

- ``branding`` (O5): display name, logo, accent, public disclaimer and the "Made with
  Product Oracle" switch (``oracle.branding``); written only through ``PUT /v1/branding``
  and the logo routes, so its revision bumps on every change. A reset here bumps it too
  and deletes the stored logos (``oracle.branding.reset``).

``PUT`` with ``{"value": null}`` resets a key to its default.
"""

import re
from calendar import monthrange
from datetime import date, datetime, timedelta
from typing import Annotated, Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.deps import Principal, TenantDB
from oracle.authz import not_for_runs, recheck_caller, require_role
from oracle.baseline.models import LINK_KINDS
from oracle.branding import DEFAULT as BRANDING_DEFAULT
from oracle.confidence import DEFAULTS as CONFIDENCE_DEFAULTS
from oracle.rituals.schedule import DEFAULT_ZONE as COMPANY_ZONE
from oracle.sources.models import ITEM_KINDS, SOURCE_KINDS
from oracle.tenant_settings import TenantSetting

DEFAULTS: dict[str, Any] = {
    "iap_default_role": "commenter",
    # A5 "Join rule": ``request`` (owner, 2026-10-21) once the /access page a waiting
    # person sees exists; ``join`` until then, so an uninvited sign-in is never a 401.
    "sign_in_without_invite": "join",
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
    # A1, B2 Goals framework: short = current quarter, medium = next 2 quarters,
    # long = 12-24 months.
    "planning_horizons": {
        "short_quarters": 1,
        "medium_quarters": 2,
        "long_from_months": 12,
        "long_to_months": 24,
    },
    # F6 (defaults the spec picks): Monday 08:00, for the week that just ended, in the
    # Company time zone.
    "alignment_report": {
        "enabled": True,
        "weekday": "mon",
        "time": "08:00",
        "slack_channel": None,
    },
    # H11: every responsibility at its default (oracle.autonomy.REGISTRY).
    "autonomy": {},
    # The Company time zone (an IANA name): goals' and decisions' today, the alignment
    # report, rituals. Los Angeles until an owner sets one (owner decision 2026-10-22).
    "company_timezone": COMPANY_ZONE,
    # H2: Oracle's written summary of a pre-read: on_demand, or always (Every pre-read).
    "ritual_summaries": "on_demand",
    # H3 Predicted versus actual: days after shipping before an outcome is checked, the
    # assessed outcomes a goal needs before its own track record counts, and whether the
    # track record lowers priority scores (apply) or is only shown (show).
    "outcome_measure_days": 30,
    "calibration_min_outcomes": 5,
    "outcome_calibration": "apply",
    # H10 Reasoned no: asked again this many times since the no, the decider hears.
    "request_asked_again_threshold": 3,
    # H9 Pricing input: the pricing owner's user id; null is the earliest active owner.
    "pricing_owner": None,
    # H7 Competitive digest: open-web searches per month across runs; 0 turns them off.
    "web_searches_per_month": 200,
    # O5 lane 4: the company's branding (oracle.branding), changed on PUT /v1/branding only.
    "branding": BRANDING_DEFAULT,
}
MAX_WEB_SEARCHES_PER_MONTH = 2000
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
HORIZON_KEYS = ("short_quarters", "medium_quarters", "long_from_months", "long_to_months")
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


async def company_timezone(session: AsyncSession) -> ZoneInfo:
    """The Company time zone from Settings; :data:`COMPANY_ZONE` when none is set (or it
    no longer reads)."""
    zone = await get_setting(session, "company_timezone")
    try:
        return ZoneInfo(zone) if isinstance(zone, str) and zone else ZoneInfo(COMPANY_ZONE)
    except (ValueError, ZoneInfoNotFoundError):
        return ZoneInfo(COMPANY_ZONE)


async def company_horizons(session: AsyncSession) -> dict[str, int]:
    """The company's planning horizons: the stored value or B2's defaults. Later picks
    read the horizons through this and :func:`horizon_windows`, never on their own."""
    return dict(await get_setting(session, "planning_horizons"))


def _add_months(day: date, months: int) -> date:
    """``day`` moved ``months`` calendar months on, clamped to the month's last day."""
    year, month = divmod(day.month - 1 + months, 12)
    year += day.year
    return date(year, month + 1, min(day.day, monthrange(year, month + 1)[1]))


def horizon_windows(h: dict[str, int], today: date) -> dict[str, tuple[date, date]]:
    """The date span of each horizon on ``today`` (both ends included): short from the
    first day of the current calendar quarter to the end of ``short_quarters`` quarters,
    medium the ``medium_quarters`` quarters after it, long from ``today`` plus
    ``long_from_months`` to ``today`` plus ``long_to_months``."""
    quarter_start = date(today.year, 3 * ((today.month - 1) // 3) + 1, 1)
    medium_start = _add_months(quarter_start, 3 * h["short_quarters"])
    medium_end = _add_months(medium_start, 3 * h["medium_quarters"])
    day = timedelta(days=1)
    return {
        "short": (quarter_start, medium_start - day),
        "medium": (medium_start, medium_end - day),
        "long": (
            _add_months(today, h["long_from_months"]),
            _add_months(today, h["long_to_months"]),
        ),
    }


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
        # A5: an approver or an owner is only ever chosen per person (an invite).
        if value not in ("viewer", "commenter"):
            raise InvalidSetting("iap_default_role must be viewer or commenter")
        return value
    if key == "sign_in_without_invite":
        if value not in ("request", "join", "refuse"):
            raise InvalidSetting("sign_in_without_invite must be request, join or refuse")
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
    if key in ("outcome_measure_days", "calibration_min_outcomes", "request_asked_again_threshold"):
        lo, hi = {
            "outcome_measure_days": (7, 365),
            "calibration_min_outcomes": (1, 100),
            "request_asked_again_threshold": (1, 20),
        }[key]
        if isinstance(value, bool) or not isinstance(value, int) or not lo <= value <= hi:
            raise InvalidSetting(f"{key} must be a whole number from {lo} to {hi}")
        return value
    if key == "web_searches_per_month":
        hi = MAX_WEB_SEARCHES_PER_MONTH
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= hi:
            raise InvalidSetting(f"web_searches_per_month must be a whole number from 0 to {hi}")
        return value
    if key == "outcome_calibration":
        if value not in ("apply", "show"):
            raise InvalidSetting("outcome_calibration must be apply or show")
        return value
    if key == "company_email_domains":
        return validate_company_domains(value)
    if key == "company_shared_drives":
        return validate_shared_drives(value)
    if key == "planning_horizons":
        return validate_planning_horizons(value)
    if key == "alignment_report":
        from oracle.reports.alignment import validate_setting

        try:
            return validate_setting(value)
        except ValueError as e:
            raise InvalidSetting(str(e)) from None
    if key == "company_timezone":
        from oracle.rituals.schedule import zone

        try:
            zone(value) if isinstance(value, str) else zone("")
        except ValueError:
            raise InvalidSetting("company_timezone must be an IANA time zone name") from None
        return value
    if key == "ritual_summaries":
        if value not in ("on_demand", "always"):
            raise InvalidSetting("ritual_summaries must be on_demand or always")
        return value
    if key == "pricing_owner":
        from oracle.pricing.decide import check_pricing_owner

        return await check_pricing_owner(session, value)
    if key == "branding":
        raise InvalidSetting(
            "branding changes on Settings › Company › Branding, where the logo is uploaded "
            "too (a null value here resets every default)"
        )
    if key == "autonomy":
        raise InvalidSetting(
            "autonomy changes one responsibility at a time, with a reason: change it on "
            "Settings › Autonomy (a null value here resets every default)"
        )
    raise KeyError(key)


def validate_planning_horizons(value: Any) -> dict[str, int]:
    """B2's horizons, in whole quarters and months, each starting after the one before."""
    if (
        not isinstance(value, dict)
        or set(value) != set(HORIZON_KEYS)
        or any(isinstance(v, bool) or not isinstance(v, int) for v in value.values())
    ):
        raise InvalidSetting(
            "planning_horizons needs short_quarters, medium_quarters, long_from_months and "
            "long_to_months as whole numbers"
        )
    short, medium = value["short_quarters"], value["medium_quarters"]
    long_from, long_to = value["long_from_months"], value["long_to_months"]
    if not 1 <= short <= 2:
        raise InvalidSetting("short_quarters must be 1 or 2")
    if not 1 <= medium <= 4:
        raise InvalidSetting("medium_quarters must be between 1 and 4")
    next_ends = 3 * (short + medium)
    if not next_ends <= long_from <= 36:
        raise InvalidSetting(
            f"long_from_months must start after Next ends (at least {next_ends} months) "
            "and be at most 36"
        )
    if not long_from < long_to <= 60:
        raise InvalidSetting("long_to_months must be after long_from_months and at most 60")
    return {k: value[k] for k in HORIZON_KEYS}


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
# Who becomes a member through Google sign-in (A5): refused to a run's agents. Every
# setting sign-in or membership reads: the role a sign-in joins with, the join rule, and
# the company's domains (who may join under ``join`` or ask under ``request``).
SIGN_IN_KEYS = ("iap_default_role", "sign_in_without_invite", "company_email_domains")
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


async def _follow(db: AsyncSession, key: str, previous: Any) -> None:
    """What follows a stored change: F6's report schedule moves its ritual (H2); the
    Company time zone moves the rituals on the old zone."""
    if key == "company_timezone":
        from oracle.rituals.service import follow_company_timezone

        await db.flush()
        await follow_company_timezone(db, str(previous))
    if key == "alignment_report":
        from oracle.rituals.service import follow_alignment_setting

        await db.flush()
        await follow_alignment_setting(db)


@router.put(
    "/settings/{key}",
    response_model=SettingOut,
    responses={404: {"description": "Unknown key"}, 422: {"description": "Invalid value"}},
)
async def put_setting(key: str, body: SettingIn, principal: Owner, db: TenantDB) -> SettingOut:
    from oracle.sources.service import company_scope

    if key not in DEFAULTS:
        raise _unknown(key)
    if key in SIGN_IN_KEYS:
        # A5 (AC 20): who becomes a member is never a run's to change.
        await not_for_runs(principal)
    # Every key: the caller must still be an owner when the change lands (a rogue owner
    # being disabled must not raise iap_default_role with a request in flight).
    await recheck_caller(db, principal, "owner", shared=key not in GATE_KEYS)
    before = await company_scope(db, principal.tenant_id) if key in COMPANY_KEYS else None
    previous = await get_setting(db, key)
    if body.value is None:
        if key == "branding":
            from oracle.branding import reset as reset_branding

            await reset_branding(db, principal, previous)
        else:
            await clear_setting(db, key)
        await _follow(db, key, previous)
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
    await _follow(db, key, previous)
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
