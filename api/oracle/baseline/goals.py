"""Typed goal fields (B5): what a goal's ``attrs`` hold, the checks on them and
``goal_check`` (measurable, missing, warnings).

A person's write with a bad field is refused (422, :class:`GoalFieldsError`); an agent's or
an import's keeps the bad value as text under ``<key>_text`` (:func:`keep_as_text`), so one
vague goal never fails a run's merge. Other keys on a goal are left alone.
"""

import math
import re
import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Any, Literal

from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.baseline import figures

CURRENCIES = ("USD", "EUR", "GBP")
UNITS = ("%", *CURRENCIES, "ms", "s", "min", "h", "days")
COMPARISONS = ("at_least", "above", "at_most", "below")
HORIZONS = ("short", "medium", "long")
# The fields a goal needs to be measurable, in the order goal_check lists them.
MEASURABLE = ("metric", "unit", "comparison", "target", "horizon", "owner")
# The typed keys; a value that does not fit moves to "<key>_text" on agent writes.
TYPED = (
    "metric", "unit", "comparison", "target", "start", "current", "current_as_of", "horizon",
    "due", "owner", "weight",
)  # fmt: skip
NOUN = re.compile(r"[a-z][a-z -]{0,23}")
STALE_DAYS = 45

MESSAGES = {
    "bad_metric": "The metric says what is counted, in 3 to 200 characters",
    "bad_unit": "The unit is %, USD, EUR, GBP, ms, s, min, h, days or a counted noun",
    "bad_comparison": "Which way is success: at_least, above, at_most or below",
    "target_not_number": "The target is a number",
    "start_not_number": "The start value is a number",
    "current_not_number": "The current value is a number",
    "percent_negative": "A percentage is 0 or more",
    "target_needs_unit": "A target needs its unit and which way is success",
    "current_needs_date": "A current value needs the day it was measured",
    "current_date_future": "The current value cannot be measured in the future",
    "bad_date": "A date is written YYYY-MM-DD",
    "bad_horizon": "The horizon is short, medium or long",
    "owner_not_member": "The owner must be a member of this Oracle",
    "weight_out_of_range": "The weight is a number above 0 and at most 10",
}


class GoalAttrs(BaseModel):
    """The typed fields of a goal's ``attrs`` (published so MCP clients see the shape)."""

    metric: str | None = Field(None, min_length=3, max_length=200)
    unit: str | None = None
    comparison: Literal["at_least", "above", "at_most", "below"] | None = None
    target: float | None = None
    start: float | None = None
    current: float | None = None
    current_as_of: date | None = None
    horizon: Literal["short", "medium", "long"] | None = None
    due: date | None = None
    owner: uuid.UUID | None = None
    weight: float | None = Field(None, gt=0, le=10)


class GoalProblem(BaseModel):
    code: str
    message: str
    where: str


class GoalCheck(BaseModel):
    measurable: bool
    missing: list[str]
    warnings: list[str]
    # Fields the checks refuse, kept from before they ran (a goal an older Oracle wrote):
    # shown to fix; a save that leaves them alone is not refused for them.
    problems: list[GoalProblem] = []
    # The company's planning horizons the check used (the form's Horizon tip); null when
    # checked on B2's defaults outside the baseline API.
    horizons: dict[str, int] | None = None


class GoalFieldsError(Exception):
    """A person's write with bad goal fields: 422 with every problem."""

    def __init__(self, problems: list[dict[str, str]]):
        self.problems = problems
        super().__init__(f"goal fields rejected: {len(problems)} problem(s)")


def now() -> datetime:
    return datetime.now(UTC)


def today() -> date:
    """UTC's day: the fallback when the company has no time zone in Settings."""
    return now().date()


async def company_today(db: AsyncSession) -> date:
    """The company's day, in its time zone from Settings; UTC's when none is set. A value
    measured "today" east of UTC is not in the future."""
    from oracle.tenant_settings_api import company_timezone  # imports the baseline models

    zone = await company_timezone(db)
    return now().astimezone(zone).date() if zone is not None else today()


def _number(v: Any) -> bool:
    return isinstance(v, int | float) and not isinstance(v, bool) and math.isfinite(v)


def _date(v: Any) -> date | None:
    if not isinstance(v, str):
        return None
    try:
        return date.fromisoformat(v) if len(v) == 10 else None
    except ValueError:
        return None


def _uuid(v: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(v)) if isinstance(v, str) else None
    except ValueError:
        return None


def _set(attrs: dict[str, Any], key: str) -> bool:
    return attrs.get(key) is not None


def unit_ok(v: Any) -> bool:
    return isinstance(v, str) and (v in UNITS or bool(NOUN.fullmatch(v)))


def field_problems(attrs: dict[str, Any], *, on: date | None = None) -> list[dict[str, str]]:
    """Every problem with the typed fields, without the database (owner: a UUID only)."""
    on = on or today()
    out: list[tuple[str, str]] = []
    if _set(attrs, "metric"):
        m = attrs["metric"]
        if not isinstance(m, str) or not 3 <= len(m.strip()) <= 200:
            out.append(("bad_metric", "metric"))
    if _set(attrs, "unit") and not unit_ok(attrs["unit"]):
        out.append(("bad_unit", "unit"))
    if _set(attrs, "comparison") and attrs["comparison"] not in COMPARISONS:
        out.append(("bad_comparison", "comparison"))
    for key in ("target", "start", "current"):
        if _set(attrs, key) and not _number(attrs[key]):
            out.append((f"{key}_not_number", key))
    if attrs.get("unit") == "%":
        for key in ("target", "start", "current"):
            if _number(attrs.get(key)) and attrs[key] < 0:
                out.append(("percent_negative", key))
    together = [k for k in ("target", "unit", "comparison") if _set(attrs, k)]
    if together and len(together) < 3:
        out.append(("target_needs_unit", together[0]))
    if _set(attrs, "current") and not _set(attrs, "current_as_of"):
        out.append(("current_needs_date", "current"))
    for key in ("current_as_of", "due"):
        if _set(attrs, key) and _date(attrs[key]) is None:
            out.append(("bad_date", key))
    as_of = _date(attrs.get("current_as_of"))
    if as_of is not None and as_of > on:
        out.append(("current_date_future", "current_as_of"))
    if _set(attrs, "horizon") and attrs["horizon"] not in HORIZONS:
        out.append(("bad_horizon", "horizon"))
    if _set(attrs, "owner") and _uuid(attrs["owner"]) is None:
        out.append(("owner_not_member", "owner"))
    if _set(attrs, "weight"):
        w = attrs["weight"]
        if not _number(w) or not 0 < w <= 10:
            out.append(("weight_out_of_range", "weight"))
    return [{"code": c, "message": MESSAGES[c], "where": f"attrs.{k}"} for c, k in out]


async def problems(
    db: AsyncSession, attrs: dict[str, Any], *, on: date | None = None
) -> list[dict[str, str]]:
    """:func:`field_problems` plus the owner's membership: an active member of this Oracle.
    "Today" is the company's (:func:`company_today`) unless ``on`` is given."""
    out = field_problems(attrs, on=on or await company_today(db))
    owner = _uuid(attrs.get("owner"))
    if owner is not None:
        from oracle.auth.models import User

        found = await db.scalar(select(User.id).where(User.id == owner, User.disabled_at.is_(None)))
        if found is None:
            out.append(
                {
                    "code": "owner_not_member",
                    "message": MESSAGES["owner_not_member"],
                    "where": "attrs.owner",
                }
            )
    return out


# The other fields a cross-field problem is about, besides the one it names.
_ALSO = {
    "target_needs_unit": ("target", "unit", "comparison"),
    "current_needs_date": ("current", "current_as_of"),
    "current_date_future": ("current",),
    "percent_negative": ("unit",),
}


def _about(p: dict[str, str]) -> set[str]:
    return {p["where"].removeprefix("attrs."), *_ALSO.get(p["code"], ())}


async def check(
    db: AsyncSession, attrs: dict[str, Any], *, before: dict[str, Any] | None = None
) -> None:
    """Refuse a person's goal write with bad fields. With ``before`` (an update), a problem
    the goal already had is refused only when the write touches a field it is about, so a
    goal an older Oracle left with a refused value stays editable."""
    on = await company_today(db)
    found = await problems(db, attrs, on=on)
    if before is not None and found:
        had = {(p["code"], p["where"]) for p in await problems(db, before, on=on)}
        changed = {k for k in {*attrs, *before} if attrs.get(k) != before.get(k)}
        found = [p for p in found if (p["code"], p["where"]) not in had or _about(p) & changed]
    if found:
        raise GoalFieldsError(found)


def _text(v: Any) -> str:
    return v if isinstance(v, str) else str(v)


async def keep_as_text(db: AsyncSession, attrs: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """``attrs`` with every refused typed value moved to ``<key>_text``, and the keys moved.

    For an agent's or an import's write: the value is kept for a person to read, never
    lost, and the write goes ahead."""
    out = dict(attrs)
    moved: list[str] = []
    on = await company_today(db)
    for _ in range(len(TYPED)):
        found = await problems(db, out, on=on)
        if not found:
            break
        for p in found:
            key = p["where"].removeprefix("attrs.")
            keys = (
                [k for k in ("target", "unit", "comparison") if _set(out, k)]
                if p["code"] == "target_needs_unit"
                else [key]
            )
            for k in keys:
                if k in out:
                    out[f"{k}_text"] = _text(out.pop(k))
                    if k not in moved:
                        moved.append(k)
    return out, moved


# --- goal_check ---------------------------------------------------------------------------


def _windows(on: date, horizons: dict[str, int] | None) -> dict[str, tuple[date, date]]:
    from oracle.tenant_settings_api import DEFAULTS, horizon_windows

    return horizon_windows(horizons or DEFAULTS["planning_horizons"], on)


async def company_horizons(db: AsyncSession) -> dict[str, int]:
    """The company's planning_horizons setting (Settings › Company)."""
    from oracle.tenant_settings_api import company_horizons as stored

    return await stored(db)


def horizon_window(
    horizon: str, on: date, horizons: dict[str, int] | None = None
) -> tuple[date, date]:
    """The span of ``horizon`` on ``on`` by the company's ``horizons`` (the
    planning_horizons setting; B2's defaults when not given)."""
    return _windows(on, horizons)[horizon]


def horizon_of(due: date, on: date, horizons: dict[str, int] | None = None) -> str:
    """The horizon a due date falls in (between medium and long: medium)."""
    windows = _windows(on, horizons)
    if due <= windows["short"][1]:
        return "short"
    if due < windows["long"][0]:
        return "medium"
    return "long"


def meets(value: float, comparison: str, target: float) -> bool:
    return {
        "at_least": value >= target,
        "above": value > target,
        "at_most": value <= target,
        "below": value < target,
    }[comparison]


def goal_check(
    attrs: dict[str, Any],
    *,
    status: str | None = None,
    on: date | None = None,
    horizons: dict[str, int] | None = None,
) -> dict:
    on = on or today()
    # The company's day can be a day ahead of UTC's: a value measured on it is not refused
    # here (the write-time check reads the company's day).
    found = field_problems(attrs, on=on + timedelta(days=1))
    bad = {p["where"].removeprefix("attrs.") for p in found}
    if "target" in bad or any(p["code"] == "target_needs_unit" for p in found):
        bad |= {"target", "unit", "comparison"}
    missing = [k for k in MEASURABLE if not _set(attrs, k) or k in bad]
    warnings: list[str] = []
    typed = not {"target", "unit", "comparison"} & set(missing)
    if typed and any(
        _number(attrs.get(k))
        and k not in bad
        and meets(attrs[k], attrs["comparison"], attrs["target"])
        for k in ("start", "current")
    ):
        warnings.append("target_already_met")
    due = _date(attrs.get("due"))
    if due is not None and attrs.get("horizon") in HORIZONS:
        low, high = horizon_window(attrs["horizon"], on, horizons)
        if not low <= due <= high:
            warnings.append("due_outside_horizon")
    if due is not None and due < on and status == "confirmed":
        warnings.append("due_past")
    as_of = _date(attrs.get("current_as_of"))
    if as_of is not None and (on - as_of).days > STALE_DAYS:
        warnings.append("stale_current")
    return {"measurable": not missing, "missing": missing, "warnings": warnings, "problems": found}


# --- words -------------------------------------------------------------------------------

_WORDS = {"at_least": "at least", "above": "more than", "at_most": "at most", "below": "less than"}


def _figure(value: float, unit: str) -> str:
    n = f"{value:g}"
    if unit == "%":
        return f"{n}%"
    return f"{n} {unit}"


def comparison_words(comparison: str, target: float, unit: str) -> str:
    """A target in words: "less than 8%", "at least 40 teams"."""
    return f"{_WORDS[comparison]} {_figure(target, unit)}"


def target_words(attrs: dict[str, Any]) -> str | None:
    """A goal's typed target in words: "at least 45% (new accounts ...), short horizon,
    due 2026-12-31"; None when it has no typed target."""
    missing = goal_check(attrs)["missing"]
    if any(k in missing for k in ("target", "unit", "comparison")):
        return None
    out = comparison_words(attrs["comparison"], attrs["target"], attrs["unit"])
    if attrs.get("metric"):
        out += f" ({str(attrs['metric']).lower()})"
    if attrs.get("horizon") in HORIZONS:
        out += f", {attrs['horizon']} horizon"
    if attrs.get("due"):
        out += f", due {attrs['due']}"
    return out


# --- fill from text ----------------------------------------------------------------------

_CURRENCY = {"$": "USD", "€": "EUR", "£": "GBP"}


def read_text(
    attrs: dict[str, Any], *, on: date | None = None, horizons: dict[str, int] | None = None
) -> tuple[dict[str, Any], list[str]]:
    """The typed values the goal's ``*_text`` keys read as (same rules as Home), and the
    text fields left unread (each has its ``<field>_text`` key). Only keys whose typed value
    is absent are read. A field whose reading the checks would refuse (a current value
    without its day) is left as text; the rest are still read."""
    on = on or today()
    read: dict[str, dict[str, Any]] = {}
    left: list[str] = []
    target_text = attrs.get("target_text")
    if target_text is not None and not _set(attrs, "target"):
        fig = figures.parse_figure(target_text)
        unit = None
        if fig is not None and fig.range is None:
            if fig.currency:
                unit = _CURRENCY[fig.currency]
            elif fig.unit and unit_ok(fig.unit):
                unit = fig.unit
        if unit is None:
            left.append("target")
        else:
            comparison = figures.comparison_of(figures.direction(target_text))
            read["target"] = {"target": fig.value, "unit": unit, "comparison": comparison}
    for key in ("start", "current"):
        text = attrs.get(f"{key}_text")
        if text is None or _set(attrs, key):
            continue
        fig = figures.parse_figure(text)
        if fig is None or fig.range is not None:
            left.append(key)
        else:
            read[key] = {key: fig.value}
    horizon_text = attrs.get("horizon_text")
    if horizon_text is not None and not _set(attrs, "horizon"):
        due = figures.period_end(horizon_text)
        word = str(horizon_text).strip().lower()
        if word in HORIZONS:
            read["horizon"] = {"horizon": word}
        elif due is not None:
            read["horizon"] = {"horizon": horizon_of(due, on, horizons)}
            if not _set(attrs, "due"):
                read["horizon"]["due"] = due.isoformat()
        else:
            left.append("horizon")
    weight_text = attrs.get("weight_text")
    if weight_text is not None and not _set(attrs, "weight"):
        fig = figures.parse_figure(weight_text)
        if fig is not None and fig.range is None and not fig.unit and 0 < fig.value <= 10:
            read["weight"] = {"weight": fig.value}
        else:
            left.append("weight")
    if attrs.get("owner_text") is not None and not _set(attrs, "owner"):
        left.append("owner")  # names stay text: an owner is a member, picked by a person
    out: dict[str, Any] = {}
    for field, values in read.items():
        before = _codes(field_problems({**attrs, **out}, on=on))
        if _codes(field_problems({**attrs, **out, **values}, on=on)) <= before:
            out.update(values)
        else:
            left.append(field)
    return out, left


def _codes(found: list[dict[str, str]]) -> set[tuple[str, str]]:
    return {(p["code"], p["where"]) for p in found}
