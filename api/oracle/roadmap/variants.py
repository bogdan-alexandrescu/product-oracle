"""Audience variants of a roadmap: one source, four renderings (spec-O5 §1).

An audience decides what a rendering of a roadmap version shows and how it is grouped;
it never changes the text. The registry below is the source of truth: the API serves it
(``GET /v1/roadmap-audiences``) and the web reads it.

:func:`apply` runs after the export layer (oracle.export.render.apply_audience):

- it drops the audience's hidden sections, and the template's own (``audiences:
  {board: {hide: [not-doing]}}`` in its front matter), each with its sub-sections. A
  template can only hide more; it can never show what the registry hides;
- when the version has structured roadmap items, it rebuilds the sections that only hold
  item rows from them, with the audience's fields: the brief's item table
  (``brief-items``) and the horizon sections (``now``, ``next``, ``later``) with their item
  cards. Prose sections are kept or dropped whole and never edited;
- items that serve no confirmed goal (their card says so) are left out of Board, with
  the line "N items serve no confirmed goal and are left out", and flagged ⚑ in Team and
  Engineering.

The Public audience is never made by filtering the internal text: it is built from
approved public texts (lane 2). Until a version has a public check, asking for it is
refused (:class:`PublicNotReady`).
"""

import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

from oracle.docs.models import Section

Audience = Literal["board", "team", "engineering", "public"]
AUDIENCES: tuple[str, ...] = ("board", "team", "engineering", "public")
DEFAULT_AUDIENCE = "team"
# Audiences a template's ``audiences`` front matter may narrow (Public is built apart).
TEMPLATE_AUDIENCES = ("board", "team", "engineering")
# The sections that only hold item rows, rebuilt from roadmap_items.
ITEMS_SECTION = "brief-items"
HORIZON_SECTIONS = {"now": "Now", "next": "Next", "later": "Later"}
NO_GOAL_PHRASE = "serves no confirmed goal"
NO_GOAL_FLAG = "\u2691 Serves no confirmed goal."
# Board-level financial framing, never shown to Engineering.
REVENUE_PREFIX = "revenue"
# Every item field a variant may render.
ITEM_FIELDS = frozenset(
    {"title", "outcome", "horizon", "confidence", "risk", "depends_on", "milestone", "effort"}
    | {"tracker"}
)


@dataclass(frozen=True)
class Variant:
    key: Audience
    label: str  # "Board", shown as the header badge
    hidden_sections: frozenset[str]  # section keys never rendered
    item_fields: frozenset[str]  # roadmap item fields rendered on cards and tables
    group_by: Literal["goal", "theme", "team", "stage"]
    max_items_per_horizon: int | None
    appendix: bool  # Sources and data points


_ALWAYS_HIDDEN = frozenset({"layout"})
_TEAM_FIELDS = frozenset({"title", "outcome", "horizon", "confidence", "depends_on", "milestone"})

VARIANTS: dict[str, Variant] = {
    "board": Variant(
        key="board",
        label="Board",
        hidden_sections=_ALWAYS_HIDDEN
        | {"sources", "changes", "risks", "dependencies", "capacity", "drift", "launch"}
        | {"no-goal"},
        item_fields=frozenset({"title", "outcome", "horizon", "confidence", "risk"}),
        group_by="goal",
        max_items_per_horizon=7,
        appendix=False,
    ),
    "team": Variant(
        key="team",
        label="Team",
        hidden_sections=_ALWAYS_HIDDEN,
        item_fields=_TEAM_FIELDS,
        group_by="goal",
        max_items_per_horizon=None,
        appendix=True,
    ),
    "engineering": Variant(
        key="engineering",
        label="Engineering",
        hidden_sections=_ALWAYS_HIDDEN,
        item_fields=_TEAM_FIELDS | {"effort", "tracker"},
        group_by="team",
        max_items_per_horizon=None,
        appendix=True,
    ),
    "public": Variant(
        key="public",
        label="Public",
        # Built separately from approved public texts (spec-O5 §2); nothing internal.
        hidden_sections=frozenset(),
        item_fields=frozenset(),
        group_by="stage",
        max_items_per_horizon=None,
        appendix=False,
    ),
}


class AudienceError(ValueError):
    code = "invalid_audience"


class NotARoadmap(AudienceError):
    code = "not_a_roadmap"


class PublicNotReady(AudienceError):
    code = "public_not_ready"


PUBLIC_NOT_READY = (
    "The Public version of this roadmap is built from approved public texts and needs a "
    "public check first; it is never made by removing things from the internal text"
)


@dataclass
class ItemView:
    """A roadmap item as a rendering reads it: plain values, no session."""

    key: str
    title: str
    outcome: str | None
    horizon: str
    position: int
    confidence: str | None = None
    rank: float | None = None
    depends_on: list[str] = field(default_factory=list)
    milestone: dict[str, Any] | None = None
    economics: dict[str, Any] = field(default_factory=dict)
    # [(issue key, url or None)] from the tracker records of the item's track.
    tracker: list[tuple[str, str | None]] = field(default_factory=list)
    no_goal: bool = False


def label(audience: str) -> str:
    return VARIANTS[audience].label


def template_hides(front_matter: dict | None) -> dict[str, set[str]]:
    """The template's ``audiences`` front matter as {audience: section keys to hide}
    (already checked on save by oracle.templates.validation; anything odd is ignored)."""
    raw = (front_matter or {}).get("audiences")
    out: dict[str, set[str]] = {}
    if not isinstance(raw, dict):
        return out
    for audience, spec in raw.items():
        if audience in TEMPLATE_AUDIENCES and isinstance(spec, dict):
            hide = spec.get("hide") or []
            if isinstance(hide, list):
                out[str(audience)] = {str(k) for k in hide if isinstance(k, str)}
    return out


def audiences_problems(raw: Any, section_keys: list[str]) -> list[tuple[str, str, str | None]]:
    """(code, message, section key) for each problem in a template's ``audiences``."""
    if raw is None:
        return []
    shape = "front matter 'audiences' must map board, team or engineering to {hide: [section ids]}"
    if not isinstance(raw, dict):
        return [("invalid_audiences", shape, None)]
    known = set(section_keys)
    problems: list[tuple[str, str, str | None]] = []
    for audience, spec in raw.items():
        if audience not in TEMPLATE_AUDIENCES:
            problems.append(
                (
                    "invalid_audiences",
                    f"'{audience}' is not an audience a template can narrow; use "
                    f"{', '.join(TEMPLATE_AUDIENCES)}",
                    None,
                )
            )
            continue
        if spec is None:
            continue
        hide = spec.get("hide") if isinstance(spec, dict) else None
        if not isinstance(spec, dict) or set(spec) - {"hide"} or not isinstance(hide, list | None):
            problems.append(("invalid_audiences", shape, None))
            continue
        for key in hide or []:
            if not isinstance(key, str) or key not in known:
                problems.append(
                    (
                        "unknown_audience_section",
                        f"audiences.{audience}.hide names '{key}', which is not a section "
                        "of this template",
                        key if isinstance(key, str) else None,
                    )
                )
    return problems


# --- rendering ------------------------------------------------------------------------


def _without(sections: list[Section], hidden: set[str]) -> list[Section]:
    """``sections`` without the hidden ones and the sub-sections under each."""
    out: list[Section] = []
    level: int | None = None
    for s in sections:
        if level is not None:
            if s.level > level:
                continue
            level = None
        if s.section_key in hidden:
            level = s.level
            continue
        out.append(s)
    return out


def _no_goal_keys(sections: list[Section], items: list[ItemView]) -> set[str]:
    """Items whose card (``<horizon>-<item key>``, else a level-3 card titled as the
    item) says it serves no confirmed goal (research "General rules")."""
    by_key = {s.section_key: s for s in sections}
    by_title = {s.heading.strip().lower(): s for s in sections if s.level >= 3}
    out = set()
    for item in items:
        card = by_key.get(f"{item.horizon}-{item.key}") or by_title.get(item.title.lower())
        if card is not None and NO_GOAL_PHRASE in (card.body_md or "").lower():
            out.add(item.key)
    return out


def _cell(text: str | None) -> str:
    return (text or "").replace("|", "\\|").replace("\n", " ").strip()


def _titles(item: ItemView, by_key: dict[str, ItemView]) -> list[str]:
    return [by_key[k].title if k in by_key else k for k in item.depends_on]


def _effort(item: ItemView) -> list[str]:
    lines = []
    for k, v in item.economics.items():
        if str(k).lower().startswith(REVENUE_PREFIX) or v in (None, "", [], {}):
            continue
        if isinstance(v, dict | list):
            continue
        name = str(k).replace("_", " ").capitalize()
        lines.append(f"{name}: {v}")
    return lines


def _milestone(item: ItemView) -> str | None:
    m = item.milestone or {}
    if not m.get("name"):
        return None
    return f"{m['name']}, {m['date']}" if m.get("date") else str(m["name"])


def _tracker_links(item: ItemView) -> str:
    return ", ".join(f"[{ref}]({url})" if url else ref for ref, url in item.tracker)


def _card(item: ItemView, variant: Variant, by_key: dict[str, ItemView]) -> str:
    fields = variant.item_fields
    lines: list[str] = []
    if item.outcome:
        lines.append(item.outcome)
    if "confidence" in fields and item.confidence:
        lines.append(f"Confidence: {item.confidence}")
    deps = _titles(item, by_key)
    if "risk" in fields and deps:
        lines.append(f"Risk: after {', '.join(deps)}")
    if "depends_on" in fields and deps:
        lines.append(f"Depends on: {', '.join(deps)}")
    if "milestone" in fields and (m := _milestone(item)):
        lines.append(f"Milestone: {m}")
    if "effort" in fields:
        lines += _effort(item)
    if "tracker" in fields and item.tracker:
        lines.append(f"Tracker: {_tracker_links(item)}")
    if item.no_goal:
        lines.append(NO_GOAL_FLAG)
    return "\n\n".join(lines)


def _table(shown: dict[str, list[ItemView]], variant: Variant, by_key: dict[str, ItemView]) -> str:
    fields = variant.item_fields
    cols = ["Horizon", "Item", "Outcome"]
    if "confidence" in fields:
        cols.append("Confidence")
    if "risk" in fields:
        cols.append("Risk")
    if "depends_on" in fields:
        cols.append("Depends on")
    if "milestone" in fields:
        cols.append("Milestone")
    if "effort" in fields:
        cols.append("Effort")
    if "tracker" in fields:
        cols.append("Tracker")
    rows = ["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    for horizon, items in shown.items():
        for i, item in enumerate(items):
            name = HORIZON_SECTIONS[horizon]
            deps = ", ".join(_titles(item, by_key))
            title = f"[{_cell(item.title)}](#{horizon}-{item.key})"
            if item.no_goal:
                title = f"\u2691 {title}"
            cells = [f"[{name}](#{horizon})" if i == 0 else "", title, _cell(item.outcome)]
            if "confidence" in fields:
                cells.append(_cell(item.confidence))
            if "risk" in fields:
                cells.append(_cell(f"after {deps}" if deps else ""))
            if "depends_on" in fields:
                cells.append(_cell(deps))
            if "milestone" in fields:
                cells.append(_cell(_milestone(item)))
            if "effort" in fields:
                cells.append(_cell("; ".join(_effort(item))))
            if "tracker" in fields:
                cells.append(_tracker_links(item).replace("|", "\\|"))
            rows.append("| " + " | ".join(cells) + " |")
    return "\n".join(rows)


def _section(like: Section, key: str, level: int, heading: str, body: str) -> Section:
    return Section(
        id=uuid.uuid4(),
        version_id=like.version_id,
        section_key=key,
        ordinal=like.ordinal,
        level=level,
        heading=heading,
        body_md=body,
        body_text=body,
        content_hash=like.content_hash,
        citation_keys=[],
        layer=like.layer,
    )


def _shown(items: list[ItemView], variant: Variant) -> tuple[dict[str, list[ItemView]], int]:
    """Items by horizon as the audience shows them, and how many serve no goal and are
    left out (Board)."""
    left_out = 0
    shown: dict[str, list[ItemView]] = {h: [] for h in HORIZON_SECTIONS}
    for item in sorted(items, key=lambda i: i.position):
        if item.horizon not in shown:
            continue
        if item.no_goal and variant.key == "board":
            left_out += 1
            continue
        shown[item.horizon].append(item)
    if variant.max_items_per_horizon is not None:
        cap = variant.max_items_per_horizon
        for horizon, rows in shown.items():
            ranked = sorted(rows, key=lambda i: (i.rank is None, i.rank or 0, i.position))
            shown[horizon] = ranked[:cap]
    return shown, left_out


def _left_out_line(n: int) -> str:
    if n == 1:
        return "1 item serves no confirmed goal and is left out."
    return f"{n} items serve no confirmed goal and are left out."


def rebuild(
    sections: list[Section],
    audience: str,
    items: list[ItemView],
    hide: set[str],
    cards: list[Section] | None = None,
) -> list[Section]:
    """The sections of one rendering in ``audience`` (see the module docstring).
    ``cards``: every section of the version (where each item's card says whether it
    serves a goal), when ``sections`` is one layer of it."""
    variant = VARIANTS[audience]
    kept = _without(sections, set(variant.hidden_sections) | hide)
    if not items:
        return kept
    no_goal = _no_goal_keys(cards if cards is not None else sections, items)
    items = [ItemView(**{**item.__dict__, "no_goal": item.key in no_goal}) for item in items]
    by_key = {i.key: i for i in items}
    shown, left_out = _shown(items, variant)
    note = _left_out_line(left_out) if left_out else None
    noted = False
    out: list[Section] = []
    skip_level: int | None = None
    for s in kept:
        if skip_level is not None:
            if s.level > skip_level:
                continue  # the old item cards of a rebuilt horizon
            skip_level = None
        if s.section_key == ITEMS_SECTION:
            body = _table(shown, variant, by_key)
            if note:
                body += f"\n\n{note}"
                noted = True
            out.append(_section(s, s.section_key, s.level, s.heading, body))
        elif s.section_key in HORIZON_SECTIONS:
            horizon = s.section_key
            body = ""
            if note and not noted:
                body, noted = note, True
            out.append(_section(s, s.section_key, s.level, s.heading, body))
            for item in shown[horizon]:
                out.append(
                    _section(
                        s,
                        f"{horizon}-{item.key}",
                        s.level + 1,
                        item.title,
                        _card(item, variant, by_key),
                    )
                )
            skip_level = s.level
        else:
            out.append(s)
    return out
