"""The plan strip (#723, the owner's pick after CLD's production walk, 2026-10-27): a PRD's
span BY MONTH with its MILESTONES, today's line and a marker for commitments past the edge;
one row per milestone ("M1 · 12 items"), the items with no milestone summed in one row, no
per-item bars. The one-pager and its PDF draw it from :func:`strip`; Simple's Home draws the
same strip from the roadmap read (web/lib/simple-home.ts ``planByMonth``, the same rules).

The span: from the month of the earliest item start (or milestone date) to the month of the
latest milestone date (with no dated milestone, the latest committed end; with none
committed, the latest end), at most :data:`MAX_MONTHS` months (a longer span starts the
month before today's, when that is later).
"""

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


def _month(d: date) -> date:
    return d.replace(day=1)


def _add_months(d: date, n: int) -> date:
    m = d.month - 1 + n
    return date(d.year + m // 12, m % 12 + 1, 1)


def strip(items: list[PlanItem], today: date) -> SimplePlanStrip | None:
    """The strip of a PRD's (uncut) items; None with none."""
    if not items:
        return None
    groups: dict[tuple[str, date | None], list[PlanItem]] = {}
    loose: list[PlanItem] = []
    for i in items:
        if i.milestone or i.milestone_date:
            groups.setdefault((i.milestone or "Milestone", i.milestone_date), []).append(i)
        else:
            loose.append(i)
    dated = [d for _, d in groups if d is not None]
    committed = [i.end for i in items if not i.estimated]
    first = min([i.start for i in items] + dated)
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

    def row(name: str, when: date | None, of: list[PlanItem], milestone: bool) -> SimplePlanRow:
        return SimplePlanRow(
            name=name,
            date=when,
            items=len(of),
            start=min(i.start for i in of),
            end=max(i.end for i in of),
            estimated=all(i.estimated for i in of),
            milestone=milestone,
            past_edge=when is not None and when > end,
        )

    ordered = sorted(
        groups.items(), key=lambda kv: (kv[0][1] is None, kv[0][1] or date.max, kv[0][0])
    )
    rows = [row(name, when, of, True) for (name, when), of in ordered]
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
