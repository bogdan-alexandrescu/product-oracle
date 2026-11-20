"""The one-pager's PDF page: its CSS, plan list, timeline strip and parts (moved from
oracle.simple.one_pager; ``pdf_html`` stays there)."""

from datetime import date, timedelta
from html import escape
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import company_time
from oracle.docs.models import DocumentVersion
from oracle.simple import plan as plan_model
from oracle.simple.models import SimpleOnePager
from oracle.simple.schemas import OnePagerOut

# --------------------------------------------------------------------------- PDF


PAGE_CSS = """
@page { size: A4; margin: 14mm 16mm; }
body { font-family: "Inter", "Helvetica Neue", Arial, sans-serif; color: #1c1f24;
  font-size: 10pt; line-height: 1.4; margin: 0; }
h1 { font-size: 17pt; margin: 4px 0 2px; }
.meta { color: #5b6270; font-size: 8.5pt; margin-bottom: 10px; }
h2 { font-size: 9pt; text-transform: uppercase; letter-spacing: .06em; color: #5b6270;
  margin: 10px 0 3px; border-top: 1px solid #e3e5e9; padding-top: 6px; }
ul { margin: 0; padding-left: 16px; } li { margin: 1px 0; }
ul.done { list-style: none; padding-left: 2px; }
.metric b { font-variant-numeric: tabular-nums; }
.plan { font-size: 8pt; }
.plan .r { display: flex; align-items: center; height: 15px; }
.plan .n { width: 34%; overflow: hidden; white-space: nowrap; padding-right: 6px; }
.plan .t { position: relative; flex: 1; height: 15px; border-left: 1px solid #e3e5e9; }
.plan .m { position: absolute; top: 0; color: #5b6270; border-left: 1px solid #e3e5e9;
  padding-left: 3px; }
.plan .b { position: absolute; top: 4px; height: 7px; border-radius: 2px; background: #c9ced6; }
.plan .b.est { background: none; border: 1px dashed #9aa1ad; }
.plan .d { position: absolute; top: 2px; width: 9px; height: 9px; margin-left: -5px;
  background: #1c1f24; transform: rotate(45deg); }
.plan .now { position: absolute; top: 0; bottom: 0; border-left: 1.5px solid #c0392b; }
.plan .more { color: #5b6270; margin-top: 3px; }
.tl { font-size: 8pt; }
.tl .r { display: flex; border-bottom: 1px solid #e3e5e9; }
.tl .n { width: 30%; padding: 3px 6px 3px 0; }
.tl .n b { display: block; font-size: 8.5pt; }
.tl .t { position: relative; flex: 1; }
.tl .ax { position: relative; }
.tl .f { position: absolute; white-space: nowrap; padding: 0 3px; font-weight: 600;
  line-height: 14px; border-right: 2px solid; }
.tl .f.l { border-right: 0; border-left: 2px solid; }
.tl .mo { position: absolute; bottom: 0; color: #5b6270; border-left: 1px solid #e3e5e9;
  padding-left: 2px; }
.tl .bar { position: absolute; height: 14px; border: 1px solid; border-radius: 7px;
  box-sizing: border-box; line-height: 12px; padding: 0 4px; white-space: nowrap;
  font-weight: 600; font-size: 7pt; overflow: hidden; }
.tl .bar.pm { border-style: dashed; }
.tl .off { position: absolute; top: 0; bottom: 0;
  background: repeating-linear-gradient(135deg, #d9d5cc 0px, #d9d5cc 2px, transparent 2px,
    transparent 5px); }
.tl .end { position: absolute; top: 0; bottom: 0; border-left: 1px dashed; }
.tl .now { position: absolute; top: 0; bottom: 0; border-left: 1.5px solid #c0392b; }
.tl .key { color: #5b6270; margin-top: 4px; }
.part { page-break-before: always; }
.part h3 { font-size: 9.5pt; margin: 6px 0 2px; }
.part .what { color: #5b6270; }
"""

# prd-timeline: each milestone's colour in the PDF (M1 blue, M2 violet, M3 amber): fill, edge, ink.
TONES = [("#dce8ff", "#3b6fd8", "#173d8a"), ("#ece3ff", "#7a4fd6", "#432088"),
         ("#fdeccb", "#c27c0e", "#6b4300")]  # fmt: skip
PM_LANE = "PM-owned · no engineering"
# prd-timeline review: the lanes' width on the page (70% of A4's 178 mm between margins, in
# CSS px) and a 7pt bold character's, to fit a bar's codes as the web's fitCodes does.
TL_PX = 0.70 * 178 / 25.4 * 96
TL_CH = 5.2
# Export QA X-4, X-6: an 8pt bold flag character's width and a 7pt bold name character's, at
# most (the PDF's fallback sans is wider than Inter), and a flag's padding and edges, in px.
FLAG_CH = 6.6
FLAG_PAD = 9
NAME_CH = 6.0
# Page numbers on a PDF of more than one page (X-15).
PAGE_NUMBERS = (
    '@page { @bottom-right { content: "Page " counter(page) " of " counter(pages);'
    " font-size: 8pt; color: #5b6270; } }"
)


def month_label(m: date, first: bool) -> str:
    """A month on a timeline axis: "Nov", with its year at the first month and at January
    ("Nov 2026", "Jan 2027"), so months that repeat across years read apart (X-5)."""
    month = company_time.calendar_month(m)
    return f"{month} {m.year}" if first or m.month == 1 else month


def range_words(start: date, end: date) -> str:
    """A milestone's dates, month first: "Nov 2 – Nov 13"; across a year, both years
    ("Dec 28, 2026 – Feb 12, 2027", X-5)."""
    day = plan_model._day
    if start.year == end.year:
        return f"{day(start)} – {day(end)}"
    return f"{day(start)}, {start.year} – {day(end)}, {end.year}"


def milestone_words(code: str, name: str, cap: int = 28) -> str:
    """A milestone's code with its name ("M1 Try it"), the name cut with "…" past ``cap``
    characters so a flag stays inside the lanes; never a bare code."""
    name = (name or "").strip()
    if not name:
        return code
    return f"{code} {name if len(name) <= cap else name[: cap - 1].rstrip() + '…'}"


def place_flags(ends: list[float], widths: list[float]) -> list[tuple[float, int, bool]]:
    """Each milestone flag's left edge (px), row and side (X-4): its right edge on its end
    line, or its left edge there when it would start left of the lanes; a flag that would
    overlap one already placed goes on the next row free, so none is ever cut or hidden."""
    rows: list[list[tuple[float, float]]] = []
    out = []
    for end, w in zip(ends, widths, strict=True):
        left_side = end - w < 0
        a = min(end, TL_PX - w) if left_side else end - w
        row = next(
            (i for i, taken in enumerate(rows)
             if all(a + w + 2 <= b0 or a >= b1 + 2 for b0, b1 in taken)),
            len(rows),
        )  # fmt: skip
        if row == len(rows):
            rows.append([])
        rows[row].append((a, a + w))
        out.append((a, row, left_side))
    return out


# The plan strip shows this many rows; the rest are "+N more on the roadmap".
PLAN_ROWS = 8
NOT_WRITTEN = "Not written yet"


def _plan_html(plan: Any) -> str:
    """The plan strip for the PDF: months across, one row per milestone, today's line."""
    if plan is None:
        return "<p>No roadmap items yet</p>"
    span = (plan.end - plan.start).days + 1

    def pct(d: Any) -> float:
        return max(0.0, min(100.0, (d - plan.start).days / span * 100))

    now = f"<span class='now' style='left:{pct(plan.today):.1f}%'></span>" if plan.today else ""
    months = "".join(
        f"<span class='m' style='left:{pct(m):.1f}%'>{month_label(m, i == 0)}</span>"
        for i, m in enumerate(plan.months)
    )
    out = [
        "<div class='plan'><div class='r'><span class='n'></span>"
        f"<span class='t'>{months}{now}</span></div>"
    ]
    for r in plan.rows[:PLAN_ROWS]:
        n = f"{r.items} item{'' if r.items == 1 else 's'}"
        when = f" · {r.date.strftime('%b')} {r.date.day}" if r.date else ""
        left = pct(r.start)
        bar = (
            f"<span class='b{' est' if r.estimated else ''}' "
            f"style='left:{left:.1f}%;width:{max(1.0, pct(r.end) - left):.1f}%'></span>"
        )
        mark = f"<span class='d' style='left:{pct(r.date):.1f}%'></span>" if r.date else ""
        out.append(
            f"<div class='r'><span class='n'>{escape(r.name)} · {n}{when}</span>"
            f"<span class='t'>{bar}{mark}{now}</span></div>"
        )
    extra = []
    if len(plan.rows) > PLAN_ROWS:
        extra.append(f"+{len(plan.rows) - PLAN_ROWS} more on the roadmap")
    if plan.past_edge:
        word = "commitment ends" if plan.past_edge == 1 else "commitments end"
        extra.append(f"{plan.past_edge} {word} after {plan.end.strftime('%b')}")
    if extra:
        out.append(f"<div class='more'>{' · '.join(extra)}</div>")
    return "".join(out) + "</div>"


def _pieces(slices: list[Any]) -> list[tuple[str, list[Any], Any, Any, int]]:
    """A lane's pieces (as the web's PrdTimeline): a run of one milestone's slices (a gap of
    more than two weeks starts another), stacked into rows where they run within a week."""
    out: list[list[Any]] = []
    by: dict[str, list[Any]] = {}
    for sl in slices:
        if sl.start_date and sl.end_date:
            by.setdefault(sl.milestone, []).append(sl)
    for code, of in by.items():
        cur: list[Any] | None = None
        for sl in sorted(of, key=lambda x: x.start_date):
            if cur and (sl.start_date - cur[3]).days <= 14:
                cur[1].append(sl)
                cur[3] = max(cur[3], sl.end_date)
            else:
                cur = [code, [sl], sl.start_date, sl.end_date, 0]
                out.append(cur)
    out.sort(key=lambda p: p[2])
    rows: list[Any] = []
    for p in out:
        r = next((i for i, end in enumerate(rows) if (p[2] - end).days >= 7), len(rows))
        if r == len(rows):
            rows.append(p[3])
        rows[r] = p[3]
        p[4] = r
    return [tuple(p) for p in out]  # type: ignore[misc]


def bar_box(left: float, width: float, least: float) -> tuple[float, float]:
    """A bar's left edge and width (px): at least ``least`` wide, growing left from its end
    when short, and inside the lanes (left + width never past 100%, X-14)."""
    w = min(max(width, least), TL_PX)
    a = max(0.0, left + width - w)
    return min(a, TL_PX - w), w


def bar_label(of: list[Any], px: float) -> tuple[str, dict[str, str]]:
    """A bar's words (X-6): its features' codes and names when they fit, else their names,
    else the first name cut with "…"; never a bare code, every full name in the key."""
    named = " · ".join(f"{x.code} {x.name}" for x in of)
    if len(named) * NAME_CH + 10 <= px:
        return named, {}
    keyed = {x.code: x.name for x in of}
    names = " · ".join(x.name for x in of)
    if len(names) * NAME_CH + 10 <= px:
        return names, keyed
    return cut_name(of[0].name, len(of) - 1, px), keyed


def cut_name(name: str, more: int, px: float) -> str:
    """The first feature's name cut to the bar with "…" (and "+N" for the others when it
    fits): a bar never prints a code without its name; the key lists every full name."""
    tail = f" +{more}" if more else ""
    for tail_ in [tail, ""] if tail else [""]:
        room = int((px - 10) / NAME_CH) - len(tail_) - 1
        if room >= 3:
            return name[:room].rstrip() + "…" + tail_
    return name[:1] + "…"


def _timeline_html(view: Any, today: Any) -> str:
    """prd-timeline: the plan's timeline for the PDF's first page: milestone flags, months,
    one lane per goal (its targets and what is measured now) and the PM-owned lane."""
    tone = {m.code: TONES[i % 3] for i, m in enumerate(view.milestones)}
    first = min(view.span.start, today)
    start = first - timedelta(days=first.weekday())
    last = max(view.span.end, today)
    end = last + timedelta(days=7 - last.weekday())
    days = (end - start).days

    def pct(d: Any, end_of_day: bool = False) -> str:
        return f"{((d - start).days + (1 if end_of_day else 0)) / days * 100:.2f}%"

    def px(a: Any, b: Any) -> float:
        return ((b - a).days + 1) / days * TL_PX

    def at(d: Any, end_of_day: bool = False) -> float:
        return ((d - start).days + (1 if end_of_day else 0)) / days * TL_PX

    mname = {m.code: milestone_words(m.code, m.name) for m in view.milestones}
    flags = [(m, f"{mname[m.code]} ends {plan_model._day(m.end_date)}") for m in view.milestones]
    placed = place_flags([at(m.end_date, True) for m, _ in flags],
                         [len(text) * FLAG_CH + FLAG_PAD for _, text in flags])  # fmt: skip
    rows = max([row + 1 for _, row, _ in placed] or [1])
    out = ["<div class='tl'><div class='r'><div class='n'></div>"
           f"<div class='t ax' style='height:{rows * 15 + 15}px'>"]  # fmt: skip
    for (m, text), (a, row, left_side) in zip(flags, placed, strict=True):
        fill, edge, ink = tone[m.code]
        out.append(f"<span class='f{' l' if left_side else ''}' style='left:"
                   f"{a / TL_PX * 100:.2f}%;top:{row * 15}px;background:{fill};color:{ink};"
                   f"border-color:{edge}'>{escape(text)}</span>")  # fmt: skip
    mo, first = start.replace(day=1), True
    while mo < end:
        nxt = (mo.replace(day=28) + timedelta(days=4)).replace(day=1)
        # A first month with under ten days on the axis gives its label (and year) to the next.
        if not (first and (nxt - start).days < 10):
            on = max(mo, start)
            out.append(f"<span class='mo' style='left:{pct(on)}'>"
                       f"{month_label(on, first)}</span>")  # fmt: skip
            first = False
        mo = nxt
    out.append("</div></div>")
    key: dict[str, str] = {}
    names = [g.name for g in view.goals]
    for sl in view.slices:
        if not sl.pm_owned and sl.goal and sl.goal not in names:
            names.append(sl.goal)
    lanes = [
        (n, next((g for g in view.goals if g.name == n), None),
         [x for x in view.slices if not x.pm_owned and x.goal == n])
        for n in names
    ]  # fmt: skip
    pm = [x for x in view.slices if x.pm_owned]
    if pm:
        lanes.append((PM_LANE, None, pm))
    for name, goal, slices in lanes:
        pieces = _pieces(slices)
        rows = max([p[4] + 1 for p in pieces] or [1])
        label = f"<b>{escape(name)}</b>"
        if goal is not None:
            steps = " → ".join(
                f"{mname.get(t.milestone, t.milestone)} · {t.target}" for t in goal.targets
            )
            now = f"Now {goal.measured}" if goal.measured else "Not counted yet"
            if goal.measured and goal.on_track is not None:
                now += " · on track" if goal.on_track else " · behind"
            label += f"{escape(steps)}<br>{escape(now)}"
        out.append(f"<div class='r'><div class='n'>{label}</div>"
                   f"<div class='t' style='min-height:{rows * 17 + 4}px'>")  # fmt: skip
        for h in view.holidays:
            out.append(f"<span class='off' style='left:{pct(h.start)};width:calc("
                       f"{pct(h.end, True)} - {pct(h.start)})'></span>")  # fmt: skip
        for m in view.milestones:
            out.append(f"<span class='end' style='left:{pct(m.end_date, True)};"
                       f"border-color:{tone[m.code][1]}'></span>")  # fmt: skip
        out.append(f"<span class='now' style='left:{pct(today)}'></span>")
        for code, of, a, b, row in pieces:
            fill, edge, ink = tone.get(code, TONES[0])
            pm_cls = " pm" if of[0].pm_owned else ""
            # X-14: a bar too short for its first code grows left from its end, never past
            # its milestone's line or the page's right edge.
            left, w = bar_box(at(a), px(a, b), 4 * NAME_CH + 10)
            text, keyed = bar_label(of, w)
            key.update(keyed)
            out.append(f"<span class='bar{pm_cls}' style='left:{left / TL_PX * 100:.2f}%;"
                       f"width:{w / TL_PX * 100:.2f}%;top:{2 + row * 17}px;background:{fill};"
                       f"border-color:{edge};color:{ink}'>{escape(text)}</span>")  # fmt: skip
        out.append("</div></div>")
    if key:
        listed = " · ".join(f"{escape(c)} {escape(n)}" for c, n in sorted(key.items()))
        out.append(f"<div class='key'>{listed}</div>")
    return "".join(out) + "</div>"


def _part_html(view: Any, m: Any) -> str:
    """prd-timeline: one milestone's page: name and dates, Done when, targets, what it
    builds by kind, its open decisions and risks."""
    out = [f"<section class='part'><h1>{escape(m.code)} {escape(m.name)}</h1>"
           f"<div class='meta'>{range_words(m.start_date, m.end_date)}"]  # fmt: skip
    if m.effort_weeks is not None:
        out.append(f" · {m.planned_weeks:g} of {m.effort_weeks:g} engineer-weeks planned")
    out.append("</div><h2>Done when</h2><ul class='done'>")
    out += [f"<li>☐ {escape(d)}</li>" for d in m.done_when] or [f"<li>{NOT_WRITTEN}</li>"]
    out.append("</ul><h2>Targets</h2><ul>")
    out += [f"<li>{escape(t.goal)}: {escape(t.target)}</li>" for t in m.targets] or [
        "<li>No targets yet</li>"
    ]
    out.append("</ul><h2>What it builds</h2>")
    groups: dict[str, list[Any]] = {}
    for sl in view.slices:
        if sl.milestone == m.code:
            groups.setdefault("PM-owned" if sl.pm_owned else sl.kind or "Other work", []).append(sl)
    for kind in sorted(groups, key=lambda k: k == "PM-owned"):
        out.append(f"<h3>{escape(kind)}</h3><ul>")
        for sl in groups[kind]:
            what = f" <span class='what'>{escape(sl.what)}</span>" if sl.what else ""
            out.append(f"<li><b>{escape(sl.code)} {escape(sl.name)}</b>{what}</li>")
        out.append("</ul>")
    if not groups:
        out.append("<p>Nothing planned in it yet</p>")
    out.append("<h2>Open decisions</h2><ul>")
    out += [f"<li>{escape(d.code)} {escape(d.title)}</li>" for d in m.decisions] or [
        "<li>No open decisions</li>"
    ]
    out.append("</ul><h2>Risks</h2><ul>")
    out += [f"<li>{escape(r.title)}</li>" for r in m.risks] or ["<li>No risks written yet</li>"]
    out.append("</ul></section>")
    return "".join(out)


async def _published_lines(db: AsyncSession, out: OnePagerOut) -> dict[str, dict[str, Any]]:
    row = await db.scalar(
        select(SimpleOnePager)
        .join(DocumentVersion, DocumentVersion.id == SimpleOnePager.version_id)
        .where(SimpleOnePager.document_id == out.document.id, DocumentVersion.number == out.version)
        .order_by(SimpleOnePager.built_at.desc())
        .limit(1)
    )
    return {line["id"]: line for blk in (row.blocks if row else []) for line in blk["lines"]}
