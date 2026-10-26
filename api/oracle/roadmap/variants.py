"""Audience variants of a roadmap: one source, four renderings (spec-O5 §1).

An audience decides what a rendering of a roadmap version shows and how it is grouped;
it never changes the text. The registry below is the source of truth: the API serves it
(``GET /v1/roadmap-audiences``) and the web reads it.

:func:`apply` runs after the export layer (oracle.export.render.apply_audience):

- it drops the audience's hidden sections, and the template's own (``audiences:
  {board: {hide: [not-doing]}}`` in its front matter), each with its sub-sections. A
  template can only hide more; it can never show what the registry hides;
- when the version has structured roadmap items, it rebuilds the brief's item table
  (``brief-items``) from them: the template's own columns (Horizon, Release, Quarter or
  Cycle; Item or Bet; Goal; Outcome), each written row's milestone, goal and links kept
  (a link only to a section the rendering has), then the audience's item fields. The
  horizon sections (``now``, ``next``, ``later``) are rebuilt with a card per item: the
  audience's fields, then the written card's text (its goal and evidence);
- the sections where a template writes its items (``ITEM_AREAS``: horizons, releases,
  timeline lanes, key milestones, cycle bets, pitches and raw ideas) keep their written
  text without what the audience hides: labelled owner (Board), tracker, estimate or
  effort and dependency parts (``Owner: …``, ``Tracker: …``), table columns so headed,
  sentences naming an item's tracker issue, and revenue framing (Engineering);
- items that serve no confirmed goal (their feature has no confirmed ``supports`` edge
  to a confirmed goal, oracle.launches.tiers) are left out of Board, their cards and
  lines included, with the line "N items serve no confirmed goal and are left out", and
  flagged ⚑ in Team and Engineering.

The Public audience is never made by filtering the internal text: it is built from
approved public texts (lane 2). Until a version has a public check, asking for it is
refused (:class:`PublicNotReady`).
"""

import re
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
# Where each built-in template writes its items (and its sub-sections, the cards).
ITEM_AREAS = frozenset(
    {"now", "next", "later", "releases", "timeline", "milestones", "current", "candidates"}
    | {"ideas"}
)
# The section an unlisted item's milestone cell links to, per horizon (first that exists):
# the now-next-later and outcome horizons, else the cycle-bets columns.
HORIZON_HOMES = {
    "now": ("now", "current"),
    "next": ("next", "candidates"),
    "later": ("later", "ideas"),
}
# An item's own card, by template: <horizon>-<key>, bet-<key>, pitch-<key>.
CARD_PREFIXES = ("bet", "pitch")
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
    # From the item's feature-to-goal link (oracle.launches.tiers): the goal it serves
    # best, or none.
    goals: list[str] = field(default_factory=list)
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

# Labelled parts of a written card ("Owner: Dana.", "**Tracker**: ENG-1;") and the
# field each one belongs to; the audience hides the fields it does not show.
_LABELS = {
    "owner": "owner",
    "owners": "owner",
    "tracker": "tracker",
    "tracker key": "tracker",
    "tracker keys": "tracker",
    "issue": "tracker",
    "issues": "tracker",
    "epic": "tracker",
    "epics": "tracker",
    "estimate": "effort",
    "estimates": "effort",
    "effort": "effort",
    "depends on": "depends_on",
    "dependencies": "depends_on",
}
_LABELLED = re.compile(
    r"(?<![\w-])(?:\*\*)?(?P<label>[A-Za-z][A-Za-z ]{1,20}?)(?:\*\*)?\s*:(?:\*\*)?"
    r"(?:[^.;|\n]|\.(?=\S))*[.;]?[ \t]*"
)
_SENTENCE_END = re.compile(r"(?<=[.;!?])\s+")
_LINK = re.compile(r"\[([^\]]*)\]\(#([^)\s]+)\)")
_TABLE_SEP = re.compile(r"^\s*\|?\s*:?-{2,}")


def hidden_fields(variant: Variant) -> set[str]:
    """The labelled fields an audience hides in written text: owners on Board; tracker,
    effort and dependencies where the audience does not show them; revenue framing for
    Engineering (it shows effort, never the board-level money)."""
    out = {"tracker", "effort", "depends_on"} - set(variant.item_fields)
    if variant.key == "board":
        out.add("owner")
    if "effort" in variant.item_fields:
        out.add(REVENUE_PREFIX)
    return out


def _label_field(label: str) -> str | None:
    label = label.strip().lower()
    if label.startswith(REVENUE_PREFIX):
        return REVENUE_PREFIX
    return _LABELS.get(label)


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


def _cell(text: str | None) -> str:
    return (text or "").replace("|", "\\|").replace("\n", " ").strip()


def _split_row(line: str) -> list[str]:
    inner = line.strip()
    if inner.startswith("|"):
        inner = inner[1:]
    if inner.endswith("|") and not inner.endswith("\\|"):
        inner = inner[:-1]
    return [c.strip() for c in re.split(r"(?<!\\)\|", inner)]


def _join_row(cells: list[str]) -> str:
    return "| " + " | ".join(cells) + " |"


def _is_row(line: str) -> bool:
    return line.lstrip().startswith("|")


def _drop_columns(text: str, hidden: set[str]) -> str:
    """Markdown tables in ``text`` without the columns headed by a hidden field."""
    lines = text.split("\n")
    out: list[str] = []
    drop: set[int] | None = None
    for i, line in enumerate(lines):
        if not _is_row(line):
            drop = None
            out.append(line)
            continue
        if drop is None:
            nxt = lines[i + 1] if i + 1 < len(lines) else ""
            if not _TABLE_SEP.match(nxt):
                out.append(line)
                continue
            head = _split_row(line)
            drop = {n for n, h in enumerate(head) if _label_field(h.strip("* ")) in hidden}
        if drop:
            cells = [c for n, c in enumerate(_split_row(line)) if n not in drop]
            line = _join_row(cells) if cells else ""
        out.append(line)
    return "\n".join(out)


def _mentions(line: str, name: str) -> bool:
    return re.search(rf"(?<!\w){re.escape(name)}(?!\w)", line, re.IGNORECASE) is not None


def redact(text: str, variant: Variant, items: list[ItemView], drop_titles: list[str]) -> str:
    """Written item text without what ``variant`` hides (see the module docstring), and
    without the lines naming an item in ``drop_titles`` (Board's goal-less items)."""
    hidden = hidden_fields(variant)
    refs = [ref for i in items for ref, _ in i.tracker] if "tracker" in hidden else []
    text = _drop_columns(text or "", hidden)
    out: list[str] = []
    fence = False
    for line in text.split("\n"):
        if line.lstrip().startswith("```"):
            fence = not fence
        if fence or line.lstrip().startswith("```") or not line.strip():
            out.append(line)
            continue
        if any(_mentions(line, t) for t in drop_titles):
            continue
        new = _LABELLED.sub(
            lambda m: "" if _label_field(m.group("label")) in hidden else m.group(0), line
        )
        if refs and any(_mentions(new, r) for r in refs):
            parts = _SENTENCE_END.split(new)
            new = " ".join(p for p in parts if not any(_mentions(p, r) for r in refs))
        if new != line:
            new = new.rstrip()
        if not new.strip(" -*+|\t"):
            continue
        out.append(new)
    return "\n".join(out).strip("\n")


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


def _card(item: ItemView, variant: Variant, by_key: dict[str, ItemView], why: str) -> str:
    """An item's rebuilt card: its outcome, goal and the audience's fields, then the
    written card's own text (its why: goal and evidence), redacted."""
    fields = variant.item_fields
    lines: list[str] = []
    if item.outcome and item.outcome not in why:
        lines.append(item.outcome)
    if item.goals:
        lines.append(f"Goal: {', '.join(item.goals)}")
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
    if why:
        lines.append(why)
    if item.no_goal and NO_GOAL_PHRASE not in why.lower():
        lines.append(NO_GOAL_FLAG)
    return "\n\n".join(lines)


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


def _card_of(s: Section, items: list[ItemView]) -> ItemView | None:
    """The item a sub-section of an item area is the card of: ``<prefix>-<item key>``
    (a horizon, bet or pitch), else a card headed with the item's title."""
    for item in items:
        if s.section_key.endswith(f"-{item.key}") and s.section_key.split("-", 1)[0] in (
            *HORIZON_SECTIONS,
            *CARD_PREFIXES,
        ):
            return item
    heading = s.heading.strip().lower()
    return next((i for i in items if i.title.strip().lower() == heading), None)


def _written_card(horizon: str, item: ItemView, cards: list[Section]) -> Section | None:
    by_key = {s.section_key: s for s in cards}
    if (s := by_key.get(f"{horizon}-{item.key}")) is not None:
        return s
    title = item.title.strip().lower()
    return next((s for s in cards if s.level >= 3 and s.heading.strip().lower() == title), None)


def _layout(
    sections: list[Section],
    variant: Variant,
    items: list[ItemView],
    shown: dict[str, list[ItemView]],
    hidden: set[str],
    cards: list[Section],
) -> list[Section]:
    """``sections`` for ``variant``, the brief table not yet rebuilt (:func:`rebuild`)."""
    by_key = {i.key: i for i in items}
    shown_keys = {i.key for rows in shown.values() for i in rows}
    dropped = [i for i in items if i.key not in shown_keys]
    drop_titles = [i.title for i in dropped if i.no_goal]
    out: list[Section] = []
    area: int | None = None  # the level of the item area being read
    skip: int | None = None  # the level of a rebuilt horizon, or a dropped card
    for s in _without(sections, hidden):
        if skip is not None:
            if s.level > skip:
                continue
            skip = None
        if area is not None and s.level <= area:
            area = None
        if s.section_key in HORIZON_SECTIONS and items:
            horizon = s.section_key
            out.append(
                _section(
                    s,
                    s.section_key,
                    s.level,
                    s.heading,
                    redact(s.body_md, variant, items, drop_titles),
                )
            )
            for item in shown[horizon]:
                written = _written_card(horizon, item, cards)
                why = redact(written.body_md, variant, items, drop_titles) if written else ""
                out.append(
                    _section(
                        s,
                        f"{horizon}-{item.key}",
                        s.level + 1,
                        item.title,
                        _card(item, variant, by_key, why),
                    )
                )
            skip = s.level
            continue
        in_area = area is not None or s.section_key in ITEM_AREAS
        if not in_area:
            out.append(s)
            continue
        if area is None:
            area = s.level
        body = redact(s.body_md or "", variant, items, drop_titles)
        if s.level > area and (item := _card_of(s, items)) is not None:
            if item.key not in shown_keys and item.no_goal and variant.key == "board":
                skip = s.level  # a goal-less item's card, and what is under it
                continue
            if item.no_goal and NO_GOAL_PHRASE not in body.lower():
                body = f"{body}\n\n{NO_GOAL_FLAG}".strip()
        if body == (s.body_md or "").strip("\n"):
            out.append(s)
        else:
            out.append(_section(s, s.section_key, s.level, s.heading, body))
    return out


def _parse_table(text: str) -> tuple[list[str], list[list[str]]]:
    """The first markdown table in ``text``: its header and rows ([], [] when none)."""
    lines = (text or "").split("\n")
    for i, line in enumerate(lines[:-1]):
        if _is_row(line) and _TABLE_SEP.match(lines[i + 1]):
            rows = []
            for row in lines[i + 2 :]:
                if not _is_row(row):
                    break
                rows.append(_split_row(row))
            return _split_row(line), rows
    return [], []


def _plain(cell: str) -> str:
    return _LINK.sub(lambda m: m.group(1), cell).replace("\u2691", "").strip().lower()


def _keep_links(cell: str, known: dict[str, str]) -> str:
    """``cell`` with in-document links to sections the rendering lacks unlinked."""
    return _LINK.sub(lambda m: m.group(0) if m.group(2) in known else m.group(1), cell)


def _table(
    written: str,
    shown: dict[str, list[ItemView]],
    variant: Variant,
    by_key: dict[str, ItemView],
    known: dict[str, str],
) -> str:
    """The brief's item table from the items, in the template's own columns: each
    written row's milestone, item link and goal kept for the item it names, the outcome
    from the item, then the audience's fields."""
    fields = variant.item_fields
    hidden = hidden_fields(variant)
    head, rows = _parse_table(written)
    if len(head) < 2:
        head, rows = ["Horizon", "Item", "Goal", "Outcome"], []
    names = [h.strip("* ").lower() for h in head]
    keep = [n for n, h in enumerate(names) if _label_field(h) not in hidden]
    goal_col = next((n for n, h in enumerate(names) if h.startswith("goal")), None)
    outcome_col = next((n for n, h in enumerate(names) if h.startswith("outcome")), None)
    extra = [
        (field_, label_)
        for field_, label_ in (
            ("confidence", "Confidence"),
            ("risk", "Risk"),
            ("depends_on", "Depends on"),
            ("milestone", "Milestone"),
            ("effort", "Effort"),
            ("tracker", "Tracker"),
        )
        if field_ in fields and label_.lower() not in names
    ]
    shown_items = [i for horizon in HORIZON_SECTIONS for i in shown[horizon]]
    # The written rows, with the milestone each one sits under, by the item they name.
    written_rows: dict[str, tuple[str, list[str]]] = {}
    order: list[str] = []
    group = ""
    by_title = {i.title.strip().lower(): i for i in shown_items}
    for row in rows:
        row = row + [""] * (len(head) - len(row))
        if row[0].strip():
            group = row[0]
        item = by_title.get(_plain(row[1]))
        if item is None:
            anchors = [a for _, a in _LINK.findall(row[1])]
            item = next(
                (i for i in shown_items if any(a.endswith(f"-{i.key}") for a in anchors)), None
            )
        if item is not None and item.key not in written_rows:
            written_rows[item.key] = (group, row)
            order.append(item.key)
    order += [i.key for i in shown_items if i.key not in written_rows]

    def home(item: ItemView) -> str:
        for key in HORIZON_HOMES.get(item.horizon, ()):
            if key in known:
                return f"[{known[key]}](#{key})"
        return HORIZON_SECTIONS.get(item.horizon, item.horizon)

    def own(item: ItemView) -> str:
        for prefix in (item.horizon, *CARD_PREFIXES):
            if f"{prefix}-{item.key}" in known:
                return f"[{_cell(item.title)}](#{prefix}-{item.key})"
        return _cell(item.title)

    cols = [head[n] for n in keep] + [label_ for _, label_ in extra]
    lines = [_join_row(cols), "|" + "---|" * len(cols)]
    previous = None
    for key in order:
        item = by_key[key]
        group, row = written_rows.get(key, (home(item), None))
        group = _keep_links(group, known)
        cells: list[str] = []
        for n in keep:
            if n == 0:
                cells.append(group if _plain(group) != previous else "")
            elif n == 1:
                title = _keep_links(row[1], known) if row is not None else own(item)
                cells.append(f"\u2691 {title}" if item.no_goal and "\u2691" not in title else title)
            elif n == goal_col:
                cells.append(_keep_links(row[n], known) if row else _cell(", ".join(item.goals)))
            elif n == outcome_col:
                cells.append(_cell(item.outcome))
            else:
                cells.append(_keep_links(row[n], known) if row else "")
        previous = _plain(group)
        deps = ", ".join(_titles(item, by_key))
        for field_, _ in extra:
            if field_ == "confidence":
                cells.append(_cell(item.confidence))
            elif field_ == "risk":
                cells.append(_cell(f"after {deps}" if deps else ""))
            elif field_ == "depends_on":
                cells.append(_cell(deps))
            elif field_ == "milestone":
                cells.append(_cell(_milestone(item)))
            elif field_ == "effort":
                cells.append(_cell("; ".join(_effort(item))))
            else:
                cells.append(_tracker_links(item).replace("|", "\\|"))
        lines.append(_join_row(cells))
    return "\n".join(lines)


def rebuild(
    sections: list[Section],
    audience: str,
    items: list[ItemView],
    hide: set[str],
    cards: list[Section] | None = None,
) -> list[Section]:
    """The sections of one rendering in ``audience`` (see the module docstring).
    ``cards``: every section of the version (the written item cards, and the sections a
    rebuilt table may link to), when ``sections`` is one layer of it."""
    variant = VARIANTS[audience]
    hidden = set(variant.hidden_sections) | hide
    every = cards if cards is not None else sections
    by_key = {i.key: i for i in items}
    shown, left_out = _shown(items, variant)
    full = _layout(every, variant, items, shown, hidden, every)
    known = {s.section_key: s.heading for s in full}
    out = full if sections is every else _layout(sections, variant, items, shown, hidden, every)
    note = _left_out_line(left_out) if left_out else None
    noted = False
    final: list[Section] = []
    for s in out:
        if s.section_key == ITEMS_SECTION:
            if items:
                body = _table(s.body_md or "", shown, variant, by_key, known)
            else:
                body = redact(s.body_md or "", variant, items, [])
            if note:
                body += f"\n\n{note}"
                noted = True
            s = _section(s, s.section_key, s.level, s.heading, body)
        elif note and not noted and s.section_key in ITEM_AREAS and s.level <= 2:
            s = _section(
                s, s.section_key, s.level, s.heading, f"{note}\n\n{s.body_md or ''}".strip()
            )
            noted = True
        final.append(s)
    return final
