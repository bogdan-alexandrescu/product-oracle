"""How far Oracle may go on its own, per responsibility (H11 Autonomy).

The registry below is the source of truth: the API (``oracle.autonomy_router``) and the
Settings screen read it. Each responsibility has a ceiling, the highest level an owner
can choose (fixed: decided 2026-10-21, "Ceilings"), and a default that keeps today's
behaviour where behaviour exists. Levels, lowest first:

- **observe**: record and index only;
- **draft**: produce an artifact for a named person to edit and own;
- **recommend**: options with evidence and a default; a person decides;
- **act**: act on reversible items inside the limits an owner set, then tell the owner.

The owner's choices are one company setting, ``autonomy``
(``oracle.tenant_settings_api.DEFAULTS``), ``{key: {"level": ..., "limits": {...}}}``;
``{}`` means every default. It is written only through ``PUT /v1/autonomy/{key}``, so
every change carries a reason.

Every behaviour asks :func:`allows` at its decision point (read per call: a change
takes effect on the next action) and calls :func:`acted` after acting on its own.
"""

import uuid
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.autonomy_models import OracleAction
from oracle.tenant_settings import TenantSetting

Level = Literal["observe", "draft", "recommend", "act"]
ORDER: tuple[Level, ...] = ("observe", "draft", "recommend", "act")
SETTING = "autonomy"

LEVEL_TITLES: dict[Level, str] = {
    "observe": "Observe",
    "draft": "Draft",
    "recommend": "Recommend",
    "act": "Act within limits",
}
# What each level means, in the Settings screen's words.
LEVEL_COPY: dict[Level, str] = {
    "observe": "Oracle watches and flags. It makes nothing for you to act on.",
    "draft": "Oracle writes a draft for a named person to edit and own.",
    "recommend": "Oracle gives options with evidence and a default. A person decides.",
    "act": "Oracle acts on reversible work inside your limits, then tells the owner.",
}
GROUPS = {
    "knowledge": "Knowledge",
    "planning": "Planning",
    "documents": "Documents",
    "operating": "Operating",
    "outside": "Outside the company",
}
# Oracle never decides these, at any setting (research §10.4). Shown with no controls.
STAYS_WITH_PEOPLE = (
    "Hiring, coaching and performance",
    "Pricing",
    "Hard-to-reverse decisions",
    "Date commitments",
    "What is said to the board and investors",
    "The vision itself",
)


class AutonomyError(ValueError):
    """A change the registry refuses (422)."""


class UnknownResponsibility(KeyError):
    """No such responsibility (404)."""

    def __str__(self) -> str:
        return f"Unknown responsibility {self.args[0]!r}"


# --- limits ----------------------------------------------------------------------------


def _fixed(title: str) -> Any:
    return Field(default=True, title=title, json_schema_extra={"fixed": True})


class _Limits(BaseModel):
    model_config = ConfigDict(extra="forbid")


class BaselineLimits(_Limits):
    unlocked_only: Literal[True] = _fixed("Unlocked entries only")


class NextDraftsLimits(_Limits):
    min_staged: int = Field(5, ge=3, le=20, title="Staged changes before a draft")


class RequestsLimits(_Limits):
    min_confidence: float = Field(0.9, ge=0.8, le=1.0, title="Lowest confidence")


class QuestionsLimits(_Limits):
    max_per_person_per_week: int = Field(5, ge=1, le=20, title="Questions a person a week")


class PrioritiesLimits(_Limits):
    within_goal: Literal[True] = _fixed("Within one goal")
    max_rank_move: int = Field(3, ge=1, le=5, title="Most places moved")


class DecisionsLimits(_Limits):
    reversible_only: Literal[True] = _fixed("Reversible decisions only")
    origins: list[Literal["manual", "oracle"]] = Field(
        default_factory=lambda: ["manual", "oracle"], min_length=1, title="Origins"
    )
    max_cost_usd: float = Field(0, ge=0, le=50, title="Highest cost (USD)")


class RitualsLimits(_Limits):
    max_run_usd: float = Field(10, ge=0, le=50, title="Highest cost a run (USD)")


class OutcomesLimits(_Limits):
    only_parsed_actuals: Literal[True] = _fixed("Only actuals read from data")


class LaunchesLimits(_Limits):
    internal_only: Literal[True] = _fixed("Internal only")


def fixed_limits(model: type[BaseModel] | None) -> list[str]:
    if model is None:
        return []
    return [
        name
        for name, info in model.model_fields.items()
        if isinstance(info.json_schema_extra, dict) and info.json_schema_extra.get("fixed")
    ]


def _usd(value: float) -> str:
    return f"${value:g}"


def _places(n: int) -> str:
    return f"{n} place" if n == 1 else f"{n} places"


# --- the registry ----------------------------------------------------------------------


@dataclass(frozen=True)
class Responsibility:
    key: str
    title: str
    group: str
    # The highest level an owner can choose; fixed, an owner cannot raise it.
    ceiling: Level
    # Today's behaviour, or the safest level for new work.
    default: Level
    # What Oracle does at each allowed level, one sentence each.
    levels: dict[Level, str]
    # The "act" limits, validated; None where the ceiling is below act.
    limits: type[BaseModel] | None
    # The pick that makes "act" (or this responsibility) real, and its name.
    wired_by: str
    wired_by_name: str
    # Whether the behaviour the levels steer is built.
    wired: bool = False
    # Why the levels above the ceiling stay with people (the locked steps' tooltip).
    ceiling_reason: str | None = None

    def summary(self, limits: BaseModel | None) -> str | None:
        """The limits in a few words ("within one goal, up to 3 places")."""
        if limits is None:
            return None
        return SUMMARIES[self.key](limits)


SUMMARIES = {
    "baseline": lambda lim: "unlocked entries only",
    "next_drafts": lambda lim: f"once {lim.min_staged} changes wait",
    "requests": lambda lim: f"at {round(lim.min_confidence * 100)}% confidence or more",
    "questions": lambda lim: f"up to {lim.max_per_person_per_week} a person a week",
    "priorities": lambda lim: f"within one goal, up to {_places(lim.max_rank_move)}",
    "decisions": lambda lim: (
        f"reversible only, from {' and '.join(lim.origins)}, up to {_usd(lim.max_cost_usd)}"
    ),
    "rituals": lambda lim: f"up to {_usd(lim.max_run_usd)} a run",
    "outcomes": lambda lim: "only actuals read from data",
    "launches": lambda lim: "internal only",
}

_ALL: tuple[Responsibility, ...] = (
    Responsibility(
        key="baseline",
        title="Keep the baseline current",
        group="knowledge",
        ceiling="act",
        default="act",
        levels={
            "observe": "Oracle reads what runs find and writes nothing to the baseline.",
            "draft": "Agents write every change as a proposal for a person to edit and accept.",
            "recommend": "Agents propose every change; a person accepts each one.",
            "act": "Agents write unlocked entries directly; locked ones become proposals.",
        },
        limits=BaselineLimits,
        wired_by="H11",
        wired_by_name="H11 Autonomy",
        wired=True,
    ),
    Responsibility(
        key="feedback_triage",
        title="Triage review feedback",
        group="documents",
        ceiling="recommend",
        default="recommend",
        levels={
            "observe": "Oracle runs no review jobs; feedback waits for a person.",
            "draft": "Oracle drafts suggestions on new feedback for an approver to edit and own.",
            "recommend": (
                "Oracle classifies new feedback, suggests changes and pushes back once; "
                "a person accepts."
            ),
        },
        limits=None,
        wired_by="H11",
        wired_by_name="H11 Autonomy",
        wired=True,
        ceiling_reason="a person accepts each suggestion until Oracle can act here",
    ),
    Responsibility(
        key="next_drafts",
        title="Build next drafts",
        group="documents",
        ceiling="act",
        default="draft",
        levels={
            "observe": "Oracle counts staged changes and builds nothing.",
            "draft": "Oracle builds the next draft when an approver clicks Build next draft.",
            "recommend": (
                "Oracle says when staged changes are worth a draft; an approver builds it."
            ),
            "act": "Oracle builds the next draft once enough changes wait, and never approves it.",
        },
        limits=NextDraftsLimits,
        wired_by="D12",
        wired_by_name="D12 One Build next draft",
    ),
    Responsibility(
        key="requests",
        title="Triage requests",
        group="knowledge",
        ceiling="act",
        default="recommend",
        levels={
            "observe": "Oracle records and indexes requests. Oracle never says no on its own.",
            "draft": (
                "Oracle drafts a summary of each request for its owner to edit. Oracle never "
                "says no on its own."
            ),
            "recommend": (
                "Oracle suggests duplicates, goals and when to say no for each request; a "
                "person decides. Oracle never says no on its own."
            ),
            "act": (
                "Oracle merges duplicates and links requests to goals at or above your "
                "confidence, then tells the owner. Oracle never says no on its own."
            ),
        },
        limits=RequestsLimits,
        wired_by="C1",
        wired_by_name="C1 Requests API and screen",
    ),
    Responsibility(
        key="questions",
        title="Ask people questions",
        group="knowledge",
        ceiling="act",
        default="recommend",
        levels={
            "observe": "Oracle notes what it does not know and asks no one.",
            "draft": "Oracle drafts questions for a named person to edit and send.",
            "recommend": (
                "Oracle proposes the next questions and who to ask; a person asks each batch."
            ),
            "act": "Oracle asks the next batch to named people on its own, within your weekly cap.",
        },
        limits=QuestionsLimits,
        wired_by="C2",
        wired_by_name="C2 Questions to people",
    ),
    Responsibility(
        key="goals",
        title="Shape goals",
        group="knowledge",
        ceiling="recommend",
        default="recommend",
        levels={
            "observe": "Oracle tracks goals and flags gaps.",
            "draft": "Oracle drafts goals for a named person to edit and own.",
            "recommend": (
                "Oracle proposes goals with evidence and a default; a person confirms them."
            ),
        },
        limits=None,
        wired_by="B6",
        wired_by_name="B6 Goals interview",
        ceiling_reason="the company's goals are set by people",
    ),
    Responsibility(
        key="priorities",
        title="Order priorities",
        group="planning",
        ceiling="act",
        default="recommend",
        levels={
            "observe": "Oracle scores priorities and changes no order.",
            "draft": "Oracle drafts an order for a named person to edit.",
            "recommend": "Oracle proposes an order; a person saves it.",
            "act": "Oracle reorders within one goal, by at most your limit, and tells the owner.",
        },
        limits=PrioritiesLimits,
        wired_by="C9",
        wired_by_name="C9 Priorities move and pin",
    ),
    Responsibility(
        key="roadmap_watch",
        title="Watch the roadmap",
        group="planning",
        ceiling="recommend",
        default="observe",
        levels={
            "observe": "Oracle watches tracks every hour and flags drift.",
            "draft": "Oracle drafts a track update for its owner to edit.",
            "recommend": "Oracle proposes date and scope changes with evidence; a person decides.",
        },
        limits=None,
        wired_by="F2",
        wired_by_name="F2 Track health, drift and date slips",
        ceiling_reason="date commitments",
    ),
    Responsibility(
        key="decisions",
        title="Decide reversible calls",
        group="operating",
        ceiling="act",
        default="recommend",
        levels={
            "observe": "Oracle records decisions and their reasons.",
            "draft": "Oracle drafts a decision record for the approver to edit.",
            "recommend": (
                "Oracle gives options with evidence, a default and the cost of being wrong; "
                "the approver decides."
            ),
            "act": (
                "Oracle decides reversible calls of the listed origins within your cost "
                "limit, then tells the approver."
            ),
        },
        limits=DecisionsLimits,
        wired_by="H1",
        wired_by_name="H1 Decision log",
    ),
    Responsibility(
        key="rituals",
        title="Run rituals",
        group="operating",
        ceiling="act",
        default="draft",
        levels={
            "observe": "Oracle notes when rituals are due.",
            "draft": "Oracle drafts each ritual's pre-read for its owner to edit.",
            "recommend": (
                "Oracle proposes when to start a ritual's preparation; a person starts it."
            ),
            "act": (
                "Oracle starts a ritual's preparation runs "
                "within your cost limit, then tells the owner."
            ),
        },
        limits=RitualsLimits,
        wired_by="H2",
        wired_by_name="H2 Cadence engine",
        wired=True,
    ),
    Responsibility(
        key="outcomes",
        title="Check outcomes",
        group="operating",
        ceiling="act",
        default="recommend",
        levels={
            "observe": "Oracle records predicted and actual results.",
            "draft": "Oracle drafts an outcome review for its owner to edit.",
            "recommend": "Oracle proposes a verdict with evidence; a person records it.",
            "act": (
                "Oracle records the verdict when the "
                "actual was read from data, then tells the owner."
            ),
        },
        limits=OutcomesLimits,
        wired_by="H3",
        wired_by_name="H3 Predicted versus actual",
    ),
    Responsibility(
        key="launches",
        title="Internal launch work",
        group="operating",
        ceiling="act",
        default="draft",
        levels={
            "observe": "Oracle notes what shipped.",
            "draft": "Oracle drafts internal changelog entries for a named person to publish.",
            "recommend": "Oracle proposes the entries and who to tell; a person publishes them.",
            "act": (
                "Oracle publishes internal changelog entries and tells member requesters on launch."
            ),
        },
        limits=LaunchesLimits,
        wired_by="H6",
        wired_by_name="H6 Launches and changelog",
        wired=True,
    ),
    Responsibility(
        key="strategy",
        title="Shape product strategy",
        group="planning",
        ceiling="recommend",
        default="recommend",
        levels={
            "observe": "Oracle tracks what strategy rests on and flags conflicts.",
            "draft": "Oracle drafts strategy for a named person to edit and own.",
            "recommend": (
                "Oracle proposes strategic choices with evidence and a default; a person decides."
            ),
        },
        limits=None,
        wired_by="H4",
        wired_by_name="H4 Strategy and vision",
        ceiling_reason="strategy is a person's call",
    ),
    Responsibility(
        key="vision",
        title="Draft the vision",
        group="planning",
        ceiling="draft",
        default="draft",
        levels={
            "observe": "Oracle notes where work strays from the vision.",
            "draft": "Oracle drafts vision text for a named person to edit and own.",
        },
        limits=None,
        wired_by="H4",
        wired_by_name="H4 Strategy and vision",
        ceiling_reason="the vision itself",
    ),
    Responsibility(
        key="external_messages",
        title="Words for people outside",
        group="outside",
        ceiling="draft",
        default="draft",
        levels={
            "observe": "Oracle notes what people outside may need to hear.",
            "draft": (
                "Oracle drafts release notes, customer notes, why-not replies to people who "
                "asked, the public changelog and board and investor updates for a named "
                "person to edit and send."
            ),
        },
        limits=None,
        wired_by="H6",
        wired_by_name="H6 Launches and changelog",
        ceiling_reason="what is said to people outside the company",
    ),
)
REGISTRY: dict[str, Responsibility] = {r.key: r for r in _ALL}


def get(key: str) -> Responsibility:
    try:
        return REGISTRY[key]
    except KeyError:
        raise UnknownResponsibility(key) from None


def rank(level: str) -> int:
    return ORDER.index(level)  # type: ignore[arg-type]


def allowed(r: Responsibility) -> list[Level]:
    return [lv for lv in ORDER if rank(lv) <= rank(r.ceiling)]


# --- validation ------------------------------------------------------------------------


def _error_text(e: ValidationError) -> str:
    err = e.errors()[0]
    where = ".".join(str(p) for p in err["loc"]) or "limits"
    return f"{where}: {err['msg']}"


def effective_limits(r: Responsibility, stored: dict[str, Any] | None) -> BaseModel | None:
    """The limits in force: the model's defaults under what was stored (fixed limits
    always at their value). A stored value the model no longer accepts falls back to
    the defaults."""
    if r.limits is None:
        return None
    fixed = fixed_limits(r.limits)
    given = {k: v for k, v in (stored or {}).items() if k not in fixed}
    try:
        return r.limits(**given)
    except ValidationError:
        return r.limits()


def validate_change(
    key: str, level: str, limits: dict[str, Any] | None, before: dict[str, Any]
) -> dict[str, Any]:
    """The stored item after setting ``key`` to ``level`` (and ``limits``), or
    :class:`AutonomyError`. ``before`` is the item stored now (``{}`` for none); limits
    not given are kept. Only the limits that differ from the fixed ones are stored."""
    r = get(key)
    if level not in ORDER:
        raise AutonomyError(f"level must be one of {', '.join(ORDER)}")
    if rank(level) > rank(r.ceiling):
        raise AutonomyError(f"{LEVEL_TITLES[r.ceiling]} is the highest level for {r.title}")
    kept = dict(before.get("limits") or {})
    if limits:
        if r.limits is None:
            raise AutonomyError(f"{r.title} has no limits")
        defaults = r.limits().model_dump()
        for name in fixed_limits(r.limits):
            if name in limits:
                if limits[name] != defaults[name]:
                    raise AutonomyError(f"This limit is fixed: {name}")
                limits = {k: v for k, v in limits.items() if k != name}
        kept.update(limits)
        try:
            r.limits(**kept)
        except ValidationError as e:
            raise AutonomyError(_error_text(e)) from None
    out: dict[str, Any] = {"level": level}
    if kept:
        out["limits"] = kept
    return out


# --- reading ---------------------------------------------------------------------------


async def stored(db: AsyncSession) -> dict[str, Any]:
    """The company's ``autonomy`` setting (``{}``: every default). Read per call."""
    row = await db.scalar(select(TenantSetting).where(TenantSetting.key == SETTING))
    value = row.value if row is not None else {}
    return value if isinstance(value, dict) else {}


def level_of(r: Responsibility, item: dict[str, Any] | None) -> Level:
    """The level in force: the stored one, never above the ceiling; else the default."""
    want = (item or {}).get("level")
    if want not in ORDER:
        return r.default
    return want if rank(want) <= rank(r.ceiling) else r.ceiling


async def level(db: AsyncSession, key: str) -> Level:
    r = get(key)
    return level_of(r, (await stored(db)).get(key))


async def allows(db: AsyncSession, key: str, needed: Level) -> bool:
    """Whether Oracle may go as far as ``needed`` for ``key`` (its level is at or above)."""
    return rank(await level(db, key)) >= rank(needed)


async def limits(db: AsyncSession, key: str) -> BaseModel | None:
    r = get(key)
    return effective_limits(r, ((await stored(db)).get(key) or {}).get("limits"))


# --- acting ----------------------------------------------------------------------------


async def acted(
    db: AsyncSession,
    key: str,
    *,
    summary: str,
    subject: dict[str, Any],
    undo: dict[str, Any] | None,
    notify: list[uuid.UUID],
) -> OracleAction:
    """Record what Oracle did on its own for ``key``: an audit event by ``oracle`` and an
    "Oracle did" Inbox row for each person in ``notify`` (counted until they open it).
    ``undo``: ``{method, path, body}`` of the route that reverses it, if any. The caller
    commits."""
    get(key)
    people = list(dict.fromkeys(notify))
    event = await audit.record(
        db,
        audit.ORACLE,
        "autonomy.acted",
        "oracle_action",
        data={"responsibility": key, "summary": summary, "subject": subject, "undo": undo},
    )
    await db.flush()
    action = OracleAction(
        responsibility=key,
        summary=summary,
        subject=subject,
        undo=undo,
        notify_ids=people,
        opened_by=[],
        audit_event_id=event.id,
    )
    db.add(action)
    await db.flush()
    event.entity_id = action.id
    await db.flush()
    return action
