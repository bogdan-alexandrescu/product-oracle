"""Front matter of a product strategy (choices) and a vision (beliefs): read, and checked
on import beside the roadmap date checks (oracle.docs.service.import_draft).

A strategy's front matter::

    kind: strategy
    horizon: {from: 2026-11-01, to: 2027-12-31}
    review_on: 2027-11-01
    choices:
      - {id: self-serve, title: "Self-serve onboarding", stance: focus, goals: [activation]}
      - {id: enterprise-sso, title: "Enterprise SSO", stance: stop, features: [sso]}

Refused (422): a malformed choice, a duplicate id, a choice with no ``{#choice-<id>}``
section. Warnings, stored on the version: unknown goal or feature keys (the goal may be
proposed later), more than five focus choices, a focus choice with no goals.

A vision's front matter: ``horizon_years``, ``review_on`` and ``beliefs: [{id, statement,
status}]`` (status supported | untested | strained, untested by default).
"""

import re
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.baseline.models import Entity
from oracle.docs.parser import DraftError
from oracle.docs.schemas import ImportProblem, VersionWarning

STANCES = ("focus", "stop")
BELIEF_STATUSES = ("supported", "untested", "strained")
MAX_FOCUS = 5
CHOICE_SECTION = "choice-{}"
_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,62}$")


@dataclass(frozen=True)
class Choice:
    id: str
    title: str
    stance: str
    rank: int
    goals: list[str] = field(default_factory=list)
    features: list[str] = field(default_factory=list)

    @property
    def section_key(self) -> str:
        return CHOICE_SECTION.format(self.id)


@dataclass(frozen=True)
class Belief:
    id: str
    statement: str
    status: str = "untested"


def _keys(value: Any) -> list[str] | None:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(v, str) and v for v in value):
        return None
    return list(dict.fromkeys(value))


def read_choices(front_matter: dict[str, Any]) -> tuple[list[Choice], list[str]]:
    """The choices, in order (rank from 1), and what is wrong with them."""
    raw = front_matter.get("choices")
    if raw is None:
        return [], []
    if not isinstance(raw, list):
        return [], ["'choices' must be a list"]
    out: list[Choice] = []
    problems: list[str] = []
    seen: set[str] = set()
    for i, c in enumerate(raw, start=1):
        if not isinstance(c, dict):
            problems.append(f"choice {i} must be a mapping with id, title and stance")
            continue
        cid = c.get("id")
        if not isinstance(cid, str) or not _ID.match(cid):
            problems.append(f"choice {i}: id must be a lowercase slug")
            continue
        if cid in seen:
            problems.append(f"choice '{cid}' is listed twice")
            continue
        seen.add(cid)
        stance = c.get("stance")
        if stance not in STANCES:
            problems.append(f"choice '{cid}': stance must be focus or stop")
            continue
        title = c.get("title", cid)
        goals, features = _keys(c.get("goals")), _keys(c.get("features"))
        if not isinstance(title, str) or not title.strip() or goals is None or features is None:
            problems.append(f"choice '{cid}': title is text, goals and features are key lists")
            continue
        out.append(Choice(cid, title.strip(), stance, len(out) + 1, goals, features))
    return out, problems


def read_beliefs(front_matter: dict[str, Any]) -> tuple[list[Belief], list[str]]:
    raw = front_matter.get("beliefs")
    if raw is None:
        return [], []
    if not isinstance(raw, list):
        return [], ["'beliefs' must be a list"]
    out: list[Belief] = []
    problems: list[str] = []
    seen: set[str] = set()
    for i, b in enumerate(raw, start=1):
        bid = b.get("id") if isinstance(b, dict) else None
        statement = b.get("statement") if isinstance(b, dict) else None
        status = b.get("status", "untested") if isinstance(b, dict) else None
        if not isinstance(bid, str) or not _ID.match(bid) or bid in seen:
            problems.append(f"belief {i}: id must be a lowercase slug, listed once")
            continue
        if not isinstance(statement, str) or not statement.strip():
            problems.append(f"belief '{bid}' needs a statement")
            continue
        if status not in BELIEF_STATUSES:
            problems.append(f"belief '{bid}': status must be supported, untested or strained")
            continue
        seen.add(bid)
        out.append(Belief(bid, statement.strip(), status))
    return out, problems


def review_on(front_matter: dict[str, Any]) -> date | None:
    """The front matter's review date, when it is one (YYYY-MM-DD)."""
    value = front_matter.get("review_on")
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return date.fromisoformat(value.strip())
        except ValueError:
            return None
    return None


async def _missing(db: AsyncSession, type_: str, keys: set[str]) -> list[str]:
    if not keys:
        return []
    found = set(
        await db.scalars(select(Entity.key).where(Entity.type == type_, Entity.key.in_(keys)))
    )
    return sorted(keys - found)


async def check_import(
    db: AsyncSession, kind: str, front_matter: dict[str, Any], section_keys: set[str]
) -> list[VersionWarning]:
    """Refuse a malformed strategy or vision draft (DraftError); return its warnings."""
    warnings: list[VersionWarning] = []
    if kind == "vision":
        _, problems = read_beliefs(front_matter)
        if problems:
            raise DraftError([ImportProblem(code="invalid_belief", message=m) for m in problems])
    elif kind != "strategy":
        return warnings
    if front_matter.get("review_on") is not None and review_on(front_matter) is None:
        warnings.append(
            VersionWarning(
                code="invalid_review_on",
                message="review_on is not a date (YYYY-MM-DD): the review falls due a year "
                "after approval",
            )
        )
    if kind == "vision":
        return warnings

    choices, problems = read_choices(front_matter)
    if problems:
        raise DraftError([ImportProblem(code="invalid_choice", message=m) for m in problems])
    no_section = [c for c in choices if c.section_key not in section_keys]
    if no_section:
        raise DraftError(
            [
                ImportProblem(
                    code="choice_without_section",
                    message=f"choice '{c.id}' has no {{#{c.section_key}}} section",
                )
                for c in no_section
            ]
        )
    goals = await _missing(db, "goal", {g for c in choices for g in c.goals})
    if goals:
        warnings.append(
            VersionWarning(
                code="unknown_goal",
                message="goal keys not in the baseline (the goal may be proposed later): "
                + ", ".join(goals),
            )
        )
    features = await _missing(db, "feature", {f for c in choices for f in c.features})
    if features:
        warnings.append(
            VersionWarning(
                code="unknown_feature",
                message="feature keys not in the baseline: " + ", ".join(features),
            )
        )
    focus = [c for c in choices if c.stance == "focus"]
    if len(focus) > MAX_FOCUS:
        warnings.append(
            VersionWarning(
                code="too_many_focus",
                message="More than 5 focus choices. Twenty high priorities overwhelm a team.",
                section_keys=[c.section_key for c in focus],
            )
        )
    goalless = [c for c in focus if not c.goals]
    if goalless:
        warnings.append(
            VersionWarning(
                code="focus_without_goal",
                message="focus choices that serve no goal: " + ", ".join(c.id for c in goalless),
                section_keys=[c.section_key for c in goalless],
            )
        )
    return warnings
