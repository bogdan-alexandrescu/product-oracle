"""roadmap-plan-tables: every roadmap draft carries the plan tables approving it applies to
Simple (oracle.simple.approved_roadmap reads them).

**The engineering plan** (:func:`engineering_plan`): what the run already knows, from the
items file (``roadmap_items.yaml``) and the source PRD's verified schedule bases (the
``schedule_bases`` of the prompt, ``Basis.as_json``):

- each item's end: its milestone date when a verified basis covering the item, named in
  its ``date_source``, supports exactly that date (as the items check reads it), else the
  latest date a verified basis scoped to the item (its key, or a tracker issue matched to
  it) supports; its basis in words (``estimate``, ``team queue`` for a capacity plan,
  ``commitment``), else ``no date yet``. Engineering dates are end dates only: a start
  stays empty, and Simple estimates it;
- the milestone ladder: each milestone the items name, in their order, with its date (the
  verified date of an item it is on), the items it gates (by title) and how it counts (the
  items' validation gates).

**The tables** (:func:`table_lines`): the two Markdown tables the writer copies under Full
version, dates month first.

**The check** (:func:`check`, the import of a prd_to_roadmap draft and the critic's brief):
a draft that lacks either table (``missing_plan_table``, ``missing_milestones_table``),
lists an item the items file does not have (``unknown_plan_item``), or gives a date other
than the engineering one (``plan_date_differs``) is refused: the writer must fix it.
"""

import datetime as dt
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from oracle.docs.schemas import ImportProblem
from oracle.roadmap.schedule import _names, as_date
from oracle.runs.roadmap import ItemsYamlError, load_items_yaml
from oracle.simple import approved_roadmap

ITEMS_FILE = "roadmap_items.yaml"
BASIS_WORDS = {"estimate": "estimate", "capacity": "team queue", "commitment": "commitment"}
NO_DATE = "no date yet"
PLANNED = "planned"
ITEMS_HEADER = "| Key | Item | Start | End | Dates from | Status |"
MILESTONES_HEADER = "| Milestone | Date | Gates | Counts when |"


@dataclass
class Row:
    key: str
    title: str
    start: date | None = None
    end: date | None = None
    basis: str = NO_DATE


@dataclass
class Milestone:
    name: str
    date: dt.date | None = None
    gates: list[str] = field(default_factory=list)
    counts: list[str] = field(default_factory=list)


@dataclass
class EngineeringPlan:
    items: list[Row] = field(default_factory=list)
    milestones: list[Milestone] = field(default_factory=list)

    def item(self, key: str | None, title: str) -> Row | None:
        for r in self.items:
            if key and r.key == key:
                return r
        for r in self.items:
            if r.title.strip().lower() == title.strip().lower():
                return r
        return None

    def milestone(self, name: str) -> Milestone | None:
        return next((m for m in self.milestones if m.name.lower() == name.strip().lower()), None)


def day(d: date | None) -> str:
    """Month first, as a person reads it: ``Nov 30, 2026``."""
    return f"{d:%b} {d.day}, {d.year}" if d else ""


def _covers(basis: dict[str, Any], key: str) -> bool:
    if basis.get("item_key"):
        return basis["item_key"] == key
    if basis.get("tracker_key"):
        return key in (basis.get("item_keys") or [])
    return True


def _scoped(basis: dict[str, Any], key: str) -> bool:
    return bool(basis.get("item_key") or basis.get("tracker_key")) and _covers(basis, key)


def _text(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def engineering_plan(items_text: str | None, bases: Iterable[dict[str, Any]]) -> EngineeringPlan:
    """The run's engineering dates for each item of the items file and its milestones. An
    unreadable or missing items file: no items."""
    plan = EngineeringPlan()
    if not items_text:
        return plan
    try:
        data = load_items_yaml(items_text)
    except ItemsYamlError:
        return plan
    entries = data.get("items") if isinstance(data, dict) else None
    bases = list(bases)
    for raw in entries if isinstance(entries, list) else []:
        if not isinstance(raw, dict) or not _text(raw.get("id")):
            continue
        key = _text(raw["id"])
        row = Row(key=key, title=_text(raw.get("title")) or key)
        ms = raw.get("milestone")
        ms_name = _text(ms.get("name") if isinstance(ms, dict) else ms)
        ms_day = as_date(ms.get("date")) if isinstance(ms, dict) else None
        source = _text(ms.get("date_source")) if isinstance(ms, dict) else ""
        backing = [
            b
            for b in bases
            if ms_day is not None
            and source
            and as_date(b.get("supports_date")) == ms_day
            and _covers(b, key)
            and _names(_text(b.get("reference")), source)
        ]
        if backing:
            row.end, row.basis = ms_day, BASIS_WORDS.get(backing[0].get("kind"), NO_DATE)
        else:
            own = sorted(
                (b for b in bases if _scoped(b, key) and as_date(b.get("supports_date"))),
                key=lambda b: as_date(b.get("supports_date")),  # type: ignore[arg-type, return-value]
            )
            if own:
                row.end = as_date(own[-1].get("supports_date"))
                row.basis = BASIS_WORDS.get(own[-1].get("kind"), NO_DATE)
        plan.items.append(row)
        if ms_name:
            m = plan.milestone(ms_name)
            if m is None:
                m = Milestone(ms_name)
                plan.milestones.append(m)
            m.gates.append(row.title)
            if backing and m.date is None:
                m.date = ms_day
            for gate in raw.get("validation_gates") or []:
                criterion = _text(gate.get("criterion")) if isinstance(gate, dict) else ""
                if criterion and criterion not in m.counts:
                    m.counts.append(criterion)
    return plan


def _cell(text: str) -> str:
    return text.replace("|", "/").replace("\n", " ").strip()


def table_lines(plan: EngineeringPlan) -> list[str]:
    """The two tables, filled from the engineering plan; Counts when is the writer's to
    word when the items name no validation gate."""
    lines = [ITEMS_HEADER, "|---|---|---|---|---|---|"]
    lines += [
        f"| {r.key} | {_cell(r.title)} | {day(r.start)} | {day(r.end)} | {r.basis} | {PLANNED} |"
        for r in plan.items
    ]
    lines += ["", MILESTONES_HEADER, "|---|---|---|---|"]
    lines += [
        f"| {_cell(m.name)} | {day(m.date)} | {_cell(', '.join(m.gates))} | "
        f"{_cell('; '.join(m.counts))} |"
        for m in plan.milestones
    ]
    return lines


def markdown(plan: EngineeringPlan) -> str:
    """The Plan and Milestones sections as a draft carries them."""
    lines = table_lines(plan)
    cut = lines.index("")
    return "\n".join(
        ["## Plan {#plan}", "", *lines[:cut], "", "## Milestones {#plan-milestones}", "",
         *lines[cut + 1 :], "", ""]
    )  # fmt: skip


def prompt_lines(plan: EngineeringPlan, *, critic: bool) -> list[str]:
    """What the roadmap draft's writer and critic read about the plan tables."""
    lines = [
        "",
        "Plan tables (approving this version applies them to Simple's plan): put a "
        "'## Plan {#plan}' section with the items table and a '## Milestones {#plan-milestones}' "
        "section with the milestones table under Full version, before Sources and data "
        "points. Copy the rows below as they are: every item of roadmap_items.yaml and no "
        "other, each date exactly the engineering date, month first (Nov 30, 2026), and an "
        "empty cell where it is empty below (the engineering dates give no start: Simple "
        "estimates it). Dates from says what the end rests on: estimate, team queue or "
        "commitment. You may word Counts when (how the milestone counts) where it is empty. "
        "Oracle refuses a draft that lacks either table, lists an item roadmap_items.yaml "
        "does not have, or gives another date.",
        "",
        "--- plan tables ---",
        *table_lines(plan),
        "--- end of plan tables ---",
    ]
    if critic:
        lines += [
            "",
            "As the critic, check both tables against the rows above before the draft goes "
            "on: a missing table, an item roadmap_items.yaml does not have or a date other "
            "than the engineering date is a problem the writer must fix, not a warning; fix "
            "it in roadmap.md.",
        ]
    return lines


def _problem(code: str, message: str, **refs: str) -> ImportProblem:
    return ImportProblem(code=code, message=message, refs=refs)


def _differs(what: str, said: date | None, eng: date | None) -> str | None:
    if said == eng:
        return None
    if eng is None:
        return f"{what} is {day(said)} in the Plan tables, but no engineering date backs it: leave it empty"  # noqa: E501
    if said is None:
        return f"{what} is {day(eng)} in the engineering dates, but empty in the Plan tables"
    return f"{what} is {day(eng)} in the engineering dates, not {day(said)}"


def check(markdown: str, plan: EngineeringPlan, today: date) -> list[ImportProblem]:
    """The draft's plan tables against the engineering plan: every problem at once."""
    got = approved_roadmap.parse(markdown, today)
    out: list[ImportProblem] = []
    if not got.has_items_table:
        out.append(_problem("missing_plan_table", "The draft has no Plan table (Key, Item, "
                            "Start, End, Dates from, Status): add it from the plan tables "
                            "in your brief"))  # fmt: skip
    if not got.has_milestones_table:
        out.append(_problem("missing_milestones_table", "The draft has no Milestones table "
                            "(Milestone, Date, Gates, Counts when): add it from the plan "
                            "tables in your brief"))  # fmt: skip
    for p in got.items:
        eng = plan.item(p.key, p.title)
        if eng is None:
            out.append(_problem("unknown_plan_item", f"{p.title} is in the Plan table but not "
                                f"in {ITEMS_FILE}: take it out or use the item's own key and "
                                "title", item=p.key or p.title))  # fmt: skip
            continue
        if p.state is not None:
            continue
        for what, said, want in (("start", p.start, eng.start), ("end", p.end, eng.end)):
            text = _differs(f"{eng.title}'s {what}", said, want)
            if text:
                out.append(_problem("plan_date_differs", text, item=eng.key))
    for m in got.milestones:
        eng_m = plan.milestone(m.name)
        text = _differs(f"Milestone {m.name}", m.date, eng_m.date if eng_m else None)
        if text:
            out.append(_problem("plan_date_differs", text, milestone=m.name))
    return out
