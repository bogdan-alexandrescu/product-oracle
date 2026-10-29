"""The plan strip (#723, the owner's pick after CLD's production walk, 2026-10-27): a PRD's
span BY MONTH with its MILESTONES, today's line and a marker for commitments past the edge;
one row per milestone ("M1 · 12 items"), the items with no milestone summed in one row, no
per-item bars. The one-pager and its PDF draw it from :func:`strip`; Simple's Home draws the
same strip from the roadmap read (web/lib/simple-home.ts ``planByMonth``, the same rules;
both run the cases in api/tests/fixtures/plan_strip_cases.json, so a change to one side
fails until the other follows).

The span: from the month of the earliest item start (or milestone date) to the month of the
latest milestone date (with no dated milestone, the latest committed end; with none
committed, the latest end), at most :data:`MAX_MONTHS` months (a longer span starts the
month before today's, when that is later).

Rows group by the milestone itself, not its text (CLD's production walk, 2026-10-27): real
items carry notes after the milestone ("M1 · Measure it (needs the export); Digest in M2"),
so the key is the milestone record the item links (a track milestone naming it), else the
milestone's code (M1, M2, ...), else the text before the first " (" or ";". A row reads
"<code> · <milestone name>" (the record's name, else the name most of its items give,
a named label before a bare code), dated by the latest of its items' milestone dates.
"""

import re
from collections import Counter
from dataclasses import dataclass
from datetime import date, timedelta

from oracle.simple.schemas import SimplePlanRow, SimplePlanStrip

MAX_MONTHS = 6
NO_MILESTONE = "No milestone"


@dataclass(frozen=True)
class PlanItem:
    start: date
    end: date
    estimated: bool
    milestone: str | None = None
    milestone_date: date | None = None
    # The milestone record the item links (a track milestone's id and name), when any.
    record_id: str | None = None
    record_name: str | None = None
    # plan-model: the milestone's start when the PRD's plan dates it.
    milestone_start: date | None = None


# M1..M99: "M1.5 · X" and "M2026 roadmap" are texts, not codes.
_CODE = re.compile(r"^(M\d{1,2})(?![\w.])\s*[·:\-–—]?\s*(.*)$", re.IGNORECASE)


def milestone_of(text: str | None) -> tuple[str, str]:
    """A milestone text's group key and its label: "M1 · Measure it (a note); more" ->
    ("M1", "M1 · Measure it"); "Beta (two teams)" -> ("Beta", "Beta"); empty -> Milestone."""
    head = (text or "").strip()
    for sep in (" (", ";"):
        head = head.split(sep, 1)[0]
    head = " ".join(head.split())
    m = _CODE.match(head)
    if m:
        code, name = m.group(1).upper(), m.group(2).strip()
        return code, f"{code} · {name}" if name else code
    return (head, head) if head else ("Milestone", "Milestone")


def _month(d: date) -> date:
    return d.replace(day=1)


def _add_months(d: date, n: int) -> date:
    m = d.month - 1 + n
    return date(d.year + m // 12, m % 12 + 1, 1)


def strip(items: list[PlanItem], today: date) -> SimplePlanStrip | None:
    """The strip of a PRD's (uncut) items; None with none."""
    if not items:
        return None
    keyed: dict[str, list[tuple[str, PlanItem]]] = {}
    loose: list[PlanItem] = []
    for i in items:
        if i.record_id:
            key, label = f"record:{i.record_id}", milestone_of(i.record_name)[1]
            keyed.setdefault(key, []).append((label, i))
        elif i.milestone or i.milestone_date:
            key, label = milestone_of(i.milestone)
            keyed.setdefault(key, []).append((label, i))
        else:
            loose.append(i)
    groups: dict[tuple[str, date | None], list[PlanItem]] = {}
    begins: dict[tuple[str, date | None], date] = {}
    for key, of in keyed.items():
        labels = Counter(label for label, _ in of)
        # A named label ("M4 · Rollout") before the bare code ("M4"), then the commonest.
        name = min(labels, key=lambda x: (x == key, -labels[x], x))
        when = max((i.milestone_date for _, i in of if i.milestone_date), default=None)
        groups[(name, when)] = [i for _, i in of]
        # A dated plan milestone (the PRD dates it): its row spans its start to its end.
        starts = [i.milestone_start for _, i in of if i.milestone_start]
        if starts:
            begins[(name, when)] = min(starts)
    dated = [d for _, d in groups if d is not None]
    committed = [i.end for i in items if not i.estimated]
    first = min(
        [i.start for i in items] + dated + [i.milestone_start for i in items if i.milestone_start]
    )
    last = max(dated) if dated else max(committed or [i.end for i in items])
    start = _month(first)
    last_month = _month(max(last, first))
    n = (last_month.year - start.year) * 12 + last_month.month - start.month + 1
    if n > MAX_MONTHS:
        start = max(
            start, min(_add_months(_month(today), -1), _add_months(last_month, 1 - MAX_MONTHS))
        )
        n = min(
            MAX_MONTHS, (last_month.year - start.year) * 12 + last_month.month - start.month + 1
        )
    months = [_add_months(start, k) for k in range(n)]
    end = _add_months(months[-1], 1) - timedelta(days=1)

    def row(
        name: str, when: date | None, of: list[PlanItem], milestone: bool, begin: date | None = None
    ) -> SimplePlanRow:
        planned = begin is not None and when is not None
        return SimplePlanRow(
            name=name,
            date=when,
            items=len(of),
            start=begin if planned else min(i.start for i in of),  # type: ignore[arg-type]
            end=when if planned else max(i.end for i in of),  # type: ignore[arg-type]
            estimated=False if planned else all(i.estimated for i in of),
            milestone=milestone,
            past_edge=when is not None and when > end,
        )

    ordered = sorted(
        groups.items(), key=lambda kv: (kv[0][1] is None, kv[0][1] or date.max, kv[0][0])
    )
    rows = [row(name, when, of, True, begins.get((name, when))) for (name, when), of in ordered]
    if loose:
        rows.append(row(NO_MILESTONE, None, loose, False))
    return SimplePlanStrip(
        start=start,
        end=end,
        months=months,
        today=today if start <= today <= end else None,
        rows=rows,
        past_edge=sum(1 for i in items if not i.estimated and i.end > end),
    )
