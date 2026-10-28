"""plan-model (the owner's pick, 2026-10-28): a PRD's plan as data, for every page that
reads milestones (the plan strip, the one-pager timeline and its PDF, the roadmap, the
dates to confirm, Priorities' quarter).

**What a plan is**: its milestones (code M1, M2, ..., name, start and end, engineer-weeks
as capacity, "done when", per-goal targets in words), its features (code, name, the
milestones they span, engineer-weeks per milestone, goals in the PRD's order, the PRD's
order words, PM-owned), its goals and its no-work weeks. Stored as JSON, one row per PRD
(``simple_prd_plans``).

**Where it comes from**: the PRD's latest approved version. Its tables first, read
deterministically (:func:`parse`: a milestones table, a features table, a targets table and
a "No-work week:" line); a version with no milestones table is read by the ``prd_plan``
llm job (:func:`run_job`). A newly approved version is read the next time the plan is read
(:func:`ensure`); an owner may read it again (``POST .../plan/read-again``).

**Slices** (:func:`compute`): one per milestone a feature spans (F-05a, F-05b; one
milestone: F-05), placed inside its milestone by the PRD's order words, counted in work
weeks (a no-work week is not one): "weeks 1-2", "first" (from the milestone's start, its
engineer-weeks long), "then" (after the slice before it in that milestone), "in parallel"
(with the slice before it), "last" (ending with the milestone); no word: the whole
milestone. Never outside the milestone; always ``estimated`` (the PRD's dates are the
milestones'). A PM-owned feature has no engineer-weeks.
"""

import math
import re
import uuid
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import company_time
from oracle.docs.models import Document, DocumentVersion
from oracle.simple.models import SimplePrdPlan
from oracle.simple.schemas import (
    SimpleDocRef,
    SimpleGoalWeeks,
    SimpleHoliday,
    SimpleMilestoneTarget,
    SimplePlanGoal,
    SimplePlanGoalTarget,
    SimplePlanMilestone,
    SimplePlanOut,
    SimplePlanSpan,
    SimpleSlice,
)

NO_DATES = "This PRD's milestones have no dates."
NO_PLAN = "This PRD's approved version has no milestones yet."
NO_VERSION = "This PRD has no approved version yet."
READING = "Oracle is reading the plan from this PRD."
FAILED = "Oracle could not read a plan from this PRD."
# The text the job reads, at most.
MAX_TEXT = 60_000
LETTERS = "abcdefghij"
_MS = re.compile(r"\bM(\d{1,2})\b", re.I)
_CODE = re.compile(r"\b([A-Z]{1,3}-\d{1,3})\b")
_NUM = re.compile(r"\d+(?:\.\d+)?")
_MONTHS = {m: i + 1 for i, m in enumerate(
    ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"))}  # fmt: skip
_HOLIDAY = re.compile(r"(?im)^\s*(?:[-*]\s*)?(?:no[- ]work weeks?|holidays?)\s*:\s*(.+)$")
_WEEKS = re.compile(r"weeks?\s*(\d+)(?:\s*(?:-|–|to)\s*(\d+))?", re.I)


# --------------------------------------------------------------------------- parsing


def _cells(row: str) -> list[str]:
    r = row.strip()
    r = r[1:] if r.startswith("|") else r
    r = r[:-1] if r.endswith("|") else r
    return [c.strip() for c in r.split("|")]


def tables(text: str) -> list[tuple[list[str], list[list[str]]]]:
    """Every Markdown table: its header (lower case) and its rows."""
    out: list[tuple[list[str], list[list[str]]]] = []
    lines = text.splitlines()
    i = 0
    while i < len(lines) - 1:
        head, rule = lines[i].strip(), lines[i + 1].strip()
        if head.startswith("|") and re.fullmatch(r"\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?", rule):
            header = [" ".join(c.lower().split()) for c in _cells(head)]
            rows: list[list[str]] = []
            i += 2
            while i < len(lines) and lines[i].strip().startswith("|"):
                cells = _cells(lines[i])
                rows.append(cells + [""] * (len(header) - len(cells)))
                i += 1
            out.append((header, rows))
            continue
        i += 1
    return out


def parse_day(text: str, ref: date) -> date | None:
    """ "2026-11-02", "2 Nov 2026", "Nov 2, 2026", "2 Nov" (the year: ``ref``'s, or the next
    when that day is long before ``ref``)."""
    t = (text or "").strip()
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", t)
    if m:
        try:
            return date(int(m[1]), int(m[2]), int(m[3]))
        except ValueError:
            return None
    m = re.search(r"(\d{1,2})\s+([A-Za-z]{3,9})\.?(?:,?\s+(\d{4}))?", t)
    day, month, year = (m[1], m[2], m[3]) if m else (None, None, None)
    if not m:
        m = re.search(r"([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?", t)
        if m:
            day, month, year = m[2], m[1], m[3]
    if not m or month is None or month[:3].lower() not in _MONTHS:
        return None
    try:
        out = date(int(year) if year else ref.year, _MONTHS[month[:3].lower()], int(day))  # type: ignore[arg-type]
    except ValueError:
        return None
    if not year and out < ref - timedelta(days=120):
        out = out.replace(year=out.year + 1)
    return out


def _col(header: list[str], *starts: str, contains: str | None = None) -> int | None:
    for i, h in enumerate(header):
        if h.startswith(starts) or (contains is not None and contains in h):
            return i
    return None


def _cell(row: list[str], i: int | None) -> str:
    return row[i].strip() if i is not None and i < len(row) else ""


def _number(text: str) -> float | None:
    m = _NUM.search(text or "")
    return float(m[0]) if m else None


def _list(text: str, sep: str = ";") -> list[str]:
    return [x.strip() for x in (text or "").split(sep) if x.strip()]


def _is_ms_table(h: list[str]) -> bool:
    return (
        _col(h, "milestone", "code") is not None
        and _col(h, "feature") is None
        and _col(h, "goal") is None
    )


def _milestones(header: list[str], rows: list[list[str]], ref: date) -> list[dict[str, Any]]:
    c_code, c_name = _col(header, "milestone", "code"), _col(header, "name", "title")
    c_start, c_end = _col(header, "start", "from", "begin"), _col(header, "end", "finish", "due")
    c_eff = _col(header, "effort", "capacity", "eng", contains="week")
    c_done = _col(header, "done")
    out = []
    for r in rows:
        head = _cell(r, c_code)
        m = _MS.search(head)
        if not m:
            continue
        code = f"M{int(m[1])}"
        name = _cell(r, c_name) or head[m.end() :].strip(" ·:-–—") or code
        start = parse_day(_cell(r, c_start), ref) if c_start is not None else None
        end = parse_day(_cell(r, c_end), ref) if c_end is not None else None
        if start and end and end < start:
            end = None
        out.append({
            "code": code, "name": name,
            "start": start.isoformat() if start else None,
            "end": end.isoformat() if end else None,
            "effort_weeks": _number(_cell(r, c_eff)) if c_eff is not None else None,
            "done_when": _list(_cell(r, c_done)), "targets": [],
        })  # fmt: skip
    return out


def _features(header: list[str], rows: list[list[str]], known: set[str]) -> list[dict[str, Any]]:
    c_code, c_name = _col(header, "feature", "code", "id"), _col(header, "name", "title")
    c_ms = _col(header, "milestone")
    c_eff = _col(header, "effort", "engineer", contains="week")
    c_goal, c_order = _col(header, "goal"), _col(header, "when", "order", "placement", "timing")
    c_owner = _col(header, "owner")
    out = []
    for r in rows:
        head = _cell(r, c_code)
        m = _CODE.search(head)
        if not m:
            continue
        mss = [f"M{int(x)}" for x in _MS.findall(_cell(r, c_ms))]
        mss = [x for i, x in enumerate(mss) if x in known and x not in mss[:i]]
        if not mss:
            continue
        effort_text = _cell(r, c_eff)
        pm = bool(re.match(r"^\s*pm\b", effort_text, re.I)) or (
            _cell(r, c_owner).strip().lower() == "pm" and not _NUM.search(effort_text)
        )
        nums = [float(x) for x in _NUM.findall(effort_text)] if not pm else []
        if pm or not nums:
            effort: list[float | None] = [None] * len(mss)
        elif len(nums) == len(mss):
            effort = list(nums)
        else:
            effort = [round(sum(nums) / len(mss), 2)] * len(mss)
        order = _list(_cell(r, c_order))
        out.append({
            "code": m[1],
            "name": _cell(r, c_name) or head[m.end() :].strip(" ·:-–—") or m[1],
            "milestones": mss, "effort": effort,
            "goals": _list(_cell(r, c_goal), ","),
            "order": (order + [""] * len(mss))[: len(mss)],
            "pm_owned": pm,
        })  # fmt: skip
    return out


def _holidays(text: str, ref: date) -> list[dict[str, Any]]:
    out = []
    for m in _HOLIDAY.finditer(text):
        for part in re.split(r"[,;]\s*(?=\d|[A-Za-z]{3}\s+\d)", m[1]):
            hm = re.match(r"\s*(.+?)\s+[-–]\s+(.+?)\s*(?:\((.+)\))?\s*\.?$", part)
            if not hm:
                continue
            start, end = parse_day(hm[1], ref), parse_day(hm[2], ref)
            if start and end and end >= start:
                out.append({"start": start.isoformat(), "end": end.isoformat(),
                            "label": (hm[3] or "").strip() or None})  # fmt: skip
    return out


def parse(text: str, ref: date) -> dict[str, Any] | None:
    """The plan from a PRD's tables; None when it has no milestones table (the job reads
    it then). ``ref``: the day the version was approved (the year of a day without one)."""
    found = tables(text or "")
    milestones: list[dict[str, Any]] = []
    for h, rows in found:
        if _is_ms_table(h):
            milestones = _milestones(h, rows, ref)
            if milestones:
                break
    if not milestones:
        return None
    known = {m["code"] for m in milestones}
    by_code = {m["code"]: m for m in milestones}
    features: list[dict[str, Any]] = []
    goals: list[str] = []
    for h, rows in found:
        if _col(h, "feature") is not None and _col(h, "milestone") is not None:
            features += _features(h, rows, known)
        elif h and h[0].startswith("goal"):
            cols = {i: f"M{int(m[1])}" for i, x in enumerate(h) if (m := _MS.fullmatch(x))}
            for r in rows:
                goal = r[0].strip()
                if not goal:
                    continue
                goals.append(goal) if goal not in goals else None
                for i, code in cols.items():
                    if code in by_code and _cell(r, i):
                        by_code[code]["targets"].append({"goal": goal, "target": _cell(r, i)})
        elif _col(h, "milestone") is not None and _col(h, "target") is not None:
            c_ms, c_goal, c_t = _col(h, "milestone"), _col(h, "goal"), _col(h, "target")
            for r in rows:
                m = _MS.search(_cell(r, c_ms))
                goal = _cell(r, c_goal) or "Goal"
                if m and f"M{int(m[1])}" in by_code and _cell(r, c_t):
                    goals.append(goal) if goal not in goals else None
                    by_code[f"M{int(m[1])}"]["targets"].append({"goal": goal,
                                                               "target": _cell(r, c_t)})  # fmt: skip
    for f in features:
        for g in f["goals"]:
            if g not in goals:
                goals.append(g)
    return {"milestones": milestones, "features": features, "goals": goals,
            "holidays": _holidays(text, ref)}  # fmt: skip


def clean(answer: Any) -> dict[str, Any] | None:
    """The job's answer held to the plan's shape; None without one milestone."""
    if not isinstance(answer, dict):
        return None
    milestones = []
    for m in answer.get("milestones") or []:
        if not isinstance(m, dict) or not _MS.fullmatch(str(m.get("code") or "").strip()):
            continue
        start = _iso(m.get("start"))
        end = _iso(m.get("end"))
        milestones.append({
            "code": str(m["code"]).strip().upper(), "name": str(m.get("name") or m["code"])[:120],
            "start": start, "end": end if not (start and end and end < start) else None,
            "effort_weeks": _float(m.get("effort_weeks")),
            "done_when": [str(x)[:200] for x in m.get("done_when") or [] if str(x).strip()][:8],
            "targets": [{"goal": str(t["goal"])[:80], "target": str(t["target"])[:160]}
                        for t in m.get("targets") or []
                        if isinstance(t, dict) and t.get("goal") and t.get("target")],
        })  # fmt: skip
    if not milestones:
        return None
    known = {m["code"] for m in milestones}
    features = []
    for f in answer.get("features") or []:
        if not isinstance(f, dict) or not _CODE.fullmatch(str(f.get("code") or "").strip()):
            continue
        mss = [str(x).upper() for x in f.get("milestones") or [] if str(x).upper() in known]
        if not mss:
            continue
        pm = bool(f.get("pm_owned"))
        effort = [None if pm else _float(x) for x in f.get("effort") or []]
        order = [str(x) for x in f.get("order") or []]
        features.append({
            "code": str(f["code"]).strip(), "name": str(f.get("name") or f["code"])[:120],
            "milestones": mss, "effort": (effort + [None] * len(mss))[: len(mss)],
            "goals": [str(g)[:80] for g in f.get("goals") or [] if str(g).strip()],
            "order": (order + [""] * len(mss))[: len(mss)], "pm_owned": pm,
        })  # fmt: skip
    goals = [str(g)[:80] for g in answer.get("goals") or [] if str(g).strip()]
    for f in features:
        goals += [g for g in f["goals"] if g not in goals]
    holidays = [
        {"start": s, "end": e, "label": (str(h.get("label")) if h.get("label") else None)}
        for h in answer.get("holidays") or []
        if isinstance(h, dict) and (s := _iso(h.get("start"))) and (e := _iso(h.get("end")))
    ]
    return {"milestones": milestones, "features": features, "goals": goals, "holidays": holidays}


def _iso(v: Any) -> str | None:
    try:
        return date.fromisoformat(str(v)[:10]).isoformat() if v else None
    except ValueError:
        return None


def _float(v: Any) -> float | None:
    try:
        return float(v) if v is not None and not isinstance(v, bool) else None
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------------------------- the view


@dataclass
class View:
    milestones: list[SimplePlanMilestone] = field(default_factory=list)
    slices: list[SimpleSlice] = field(default_factory=list)
    goals: list[SimplePlanGoal] = field(default_factory=list)
    goal_weeks: list[SimpleGoalWeeks] = field(default_factory=list)
    holidays: list[SimpleHoliday] = field(default_factory=list)
    span: SimplePlanSpan | None = None
    dated: bool = False
    message: str | None = None

    def milestone(self, code: str | None) -> SimplePlanMilestone | None:
        return next((m for m in self.milestones if m.code == code), None)

    def slices_of(self, feature_code: str | None) -> list[SimpleSlice]:
        return [s for s in self.slices if feature_code and s.feature_code == feature_code]


def _day(d: date) -> str:
    """A calendar day as "2 Nov" (no time of day)."""
    return f"{d.day} {d:%b}"


def span_label(start: date, end: date) -> str:
    return f"{_day(start)} - {_day(end)}"


def _friday_back(d: date, floor: date) -> date:
    while d.weekday() >= 5 and d > floor:
        d -= timedelta(days=1)
    return d


def _weeks(start: date, end: date, holidays: list[SimpleHoliday]) -> list[date]:
    out, ws = [], start
    while ws <= end:
        we = ws + timedelta(days=6)
        if not any(h.start <= we and h.end >= ws for h in holidays):
            out.append(ws)
        ws += timedelta(days=7)
    return out or [start]


def _word(text: str) -> tuple[str, int | None, int | None]:
    t = (text or "").lower()
    m = _WEEKS.search(t)
    if m:
        a = int(m[1])
        return "weeks", a, int(m[2]) if m[2] else a
    for word, keys in (("parallel", ("parallel", "alongside", "same time")),
                       ("first", ("first", "start")), ("then", ("then", "next", "after")),
                       ("last", ("last", "end", "final"))):  # fmt: skip
        if any(k in t for k in keys):
            return word, None, None
    return "", None, None


def compute(data: dict[str, Any] | None) -> View:
    """The plan's view: milestones with planned weeks, slices placed, goals with targets,
    engineer-weeks per goal per milestone, the span."""
    view = View()
    if not data or not data.get("milestones"):
        view.message = NO_PLAN
        return view
    view.holidays = [
        SimpleHoliday(start=date.fromisoformat(h["start"]), end=date.fromisoformat(h["end"]),
                      label=h.get("label"))  # fmt: skip
        for h in data.get("holidays") or []
    ]
    raw = data["milestones"]
    for m in raw:
        view.milestones.append(SimplePlanMilestone(
            code=m["code"], name=m["name"],
            start_date=date.fromisoformat(m["start"]) if m.get("start") else None,
            end_date=date.fromisoformat(m["end"]) if m.get("end") else None,
            effort_weeks=m.get("effort_weeks"), done_when=list(m.get("done_when") or []),
            targets=[SimpleMilestoneTarget(**t) for t in m.get("targets") or []],
            source=data.get("source") or "prd",
        ))  # fmt: skip
    by = {m.code: m for m in view.milestones}
    weeks = {
        m.code: _weeks(m.start_date, m.end_date, view.holidays)
        for m in view.milestones
        if m.start_date and m.end_date
    }
    # Per milestone: the last slice placed (its start and end week index).
    last: dict[str, tuple[int, int]] = {}
    for f in data.get("features") or []:
        n = len(f["milestones"])
        for i, code in enumerate(f["milestones"]):
            m = by[code]
            if f["code"] not in m.feature_codes:
                m.feature_codes.append(f["code"])
            effort = None if f.get("pm_owned") else (f.get("effort") or [None] * n)[i]
            start = end = None
            if code in weeks:
                ws = weeks[code]
                k = len(ws)
                length = max(1, math.ceil(effort)) if effort else None
                word, a, b = _word((f.get("order") or [""] * n)[i])
                prev = last.get(code)
                if word == "weeks":
                    lo, hi = min(max(a - 1, 0), k - 1), min(max(b - 1, 0), k - 1)  # type: ignore[operator]
                elif word == "parallel" and prev is not None:
                    lo = prev[0]
                    hi = k - 1 if length is None else min(lo + length - 1, k - 1)
                elif word == "then" and prev is not None:
                    after = ws[prev[1]] + timedelta(days=6)
                    lo = next((j for j, w in enumerate(ws) if w > after), k - 1)
                    hi = k - 1 if length is None else min(lo + length - 1, k - 1)
                elif word == "last":
                    hi = k - 1
                    lo = 0 if length is None else max(k - length, 0)
                elif word in ("first", "then", "parallel"):
                    lo = 0
                    hi = k - 1 if length is None else min(length - 1, k - 1)
                else:
                    lo, hi = 0, k - 1
                last[code] = (lo, hi)
                start = max(ws[lo], m.start_date)  # type: ignore[type-var]
                end = _friday_back(min(ws[hi] + timedelta(days=6), m.end_date), start)  # type: ignore[type-var]
            view.slices.append(SimpleSlice(
                code=f"{f['code']}{LETTERS[i]}" if n > 1 else f["code"],
                feature_code=f["code"],
                name=f"{f['name']}, part {i + 1} of {n}" if n > 1 else f["name"],
                milestone=code, milestone_name=m.name,
                milestone_start=m.start_date, milestone_end=m.end_date,
                start_date=start, end_date=end, estimated=True,
                effort_weeks=effort, goal=(f.get("goals") or [None])[0],
                pm_owned=bool(f.get("pm_owned")),
            ))  # fmt: skip
    totals: dict[tuple[str, str], float] = {}
    for s in view.slices:
        if s.effort_weeks:
            by[s.milestone].planned_weeks += s.effort_weeks
            if s.goal:
                totals[(s.goal, s.milestone)] = totals.get((s.goal, s.milestone), 0) + s.effort_weeks
    goals = list(data.get("goals") or [])
    order = {c: i for i, c in enumerate(by)}
    view.goal_weeks = [
        SimpleGoalWeeks(goal=g, milestone=c, weeks=w)
        for (g, c), w in sorted(
            totals.items(),
            key=lambda kv: (goals.index(kv[0][0]) if kv[0][0] in goals else 99, order[kv[0][1]]),
        )
    ]
    view.goals = [
        SimplePlanGoal(name=g, targets=[SimplePlanGoalTarget(milestone=m.code, target=t.target)
                                        for m in view.milestones for t in m.targets
                                        if t.goal == g])  # fmt: skip
        for g in goals
    ]
    view.dated = all(m.start_date and m.end_date for m in view.milestones)
    if view.dated:
        start = min(m.start_date for m in view.milestones)  # type: ignore[type-var]
        end = max(m.end_date for m in view.milestones)  # type: ignore[type-var]
        view.span = SimplePlanSpan(start=start, end=end, label=span_label(start, end))
    else:
        view.message = NO_DATES
    return view


def current_span(views: list[View], today: date) -> SimplePlanSpan | None:
    """The span "this quarter" means: the plan running today, else the next to start, else
    the latest to end."""
    spans = [v.span for v in views if v.span is not None]
    if not spans:
        return None
    running = [s for s in spans if s.start <= today <= s.end]
    if running:
        return min(running, key=lambda s: (s.start, s.end))
    ahead = [s for s in spans if s.start > today]
    if ahead:
        return min(ahead, key=lambda s: (s.start, s.end))
    return max(spans, key=lambda s: (s.end, s.start))


# --------------------------------------------------------------------------- storage


async def approved_version(db: AsyncSession, document_id: uuid.UUID) -> DocumentVersion | None:
    return await db.scalar(
        select(DocumentVersion)
        .where(DocumentVersion.document_id == document_id, DocumentVersion.approved_at.is_not(None))
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )


def _read(row: SimplePrdPlan, v: DocumentVersion) -> None:
    ref = (v.approved_at or company_time.now()).date()
    data = parse(v.markdown or "", ref)
    row.version_id, row.read_at, row.error, row.job_id = v.id, company_time.now(), None, None
    if data is not None:
        row.status, row.source, row.data = "ready", "prd", data
    else:
        row.status, row.source, row.data = "reading", None, {}


async def ensure(
    db: AsyncSession, document: Document, *, force: bool = False, persist: bool = True
) -> tuple[SimplePrdPlan | None, DocumentVersion | None]:
    """The PRD's stored plan, read again when a newer version is approved (or ``force``);
    with no tables the ``prd_plan`` job is queued. One row per PRD, updated in place."""
    from oracle.jobs import service as jobs

    v = await approved_version(db, document.id)
    row = await db.scalar(select(SimplePrdPlan).where(SimplePrdPlan.document_id == document.id))
    if v is None:
        return row, None
    if row is not None and row.version_id == v.id and not force:
        return row, v
    if row is None:
        row = SimplePrdPlan(document_id=document.id, data={})
        if persist:
            db.add(row)
    _read(row, v)
    if not persist:
        return row, v
    await db.flush()
    if row.status == "reading":
        try:
            job = await jobs.enqueue(db, document, "prd_plan", version=v, coalesce=True)
            row.job_id = job.id
        except jobs.JobError as e:
            row.status, row.error = "none", str(e)
        await db.flush()
    return row, v


async def views(db: AsyncSession, prd_ids: set[uuid.UUID]) -> dict[uuid.UUID, View]:
    """The plans of these PRDs as their latest approved versions have them, reading
    nothing into the database: a stored plan of that version, else the version's tables."""
    if not prd_ids:
        return {}
    rows = {
        r.document_id: r
        for r in await db.scalars(
            select(SimplePrdPlan).where(SimplePrdPlan.document_id.in_(prd_ids))
        )
    }
    latest: dict[uuid.UUID, DocumentVersion] = {}
    for v in await db.scalars(
        select(DocumentVersion)
        .where(DocumentVersion.document_id.in_(prd_ids), DocumentVersion.approved_at.is_not(None))
        .order_by(DocumentVersion.number)
    ):
        latest[v.document_id] = v
    out: dict[uuid.UUID, View] = {}
    for pid, v in latest.items():
        row = rows.get(pid)
        if row is not None and row.version_id == v.id:
            data = {**row.data, "source": row.source} if row.status == "ready" else None
        else:
            data = parse(v.markdown or "", (v.approved_at or company_time.now()).date())
        if data:
            out[pid] = compute(data)
    return out


def plan_out(
    document: Document,
    row: SimplePrdPlan | None,
    v: DocumentVersion | None,
    principal: Any,
) -> SimplePlanOut:
    from oracle.authz import has_role

    ref = SimpleDocRef(id=document.id, slug=document.slug, title=document.title)
    may = principal is not None and has_role(principal.role, "owner")
    if v is None or row is None:
        return SimplePlanOut(prd=ref, status="none", message=NO_VERSION, can_read_again=may)
    base = {"prd": ref, "version": v.number, "can_read_again": may, "read_at": row.read_at}
    if row.status != "ready":
        msg = {"reading": READING, "failed": FAILED}.get(row.status, NO_PLAN)
        return SimplePlanOut(status=row.status, message=msg, **base)  # type: ignore[arg-type]
    view = compute({**row.data, "source": row.source})
    return SimplePlanOut(
        status="ready", source=row.source, dated=view.dated, message=view.message,  # type: ignore[arg-type]
        milestones=view.milestones, slices=view.slices, goals=view.goals,
        goal_weeks=view.goal_weeks, span=view.span, holidays=view.holidays, **base,
    )  # fmt: skip


# --------------------------------------------------------------------------- the job


async def run_job(s: AsyncSession, job: Any, ask: Any) -> dict[str, Any]:
    """The ``prd_plan`` job: one call with the approved version's text; the answer, held to
    the plan's shape (:func:`clean`), becomes the PRD's plan (``source`` oracle) unless a
    newer version was read meanwhile."""
    from oracle.jobs.kinds import JobInputError

    document = await s.get(Document, job.document_id)
    v = await s.get(DocumentVersion, job.version_id) if job.version_id else None
    if document is None or v is None:
        raise JobInputError("the PRD version no longer exists")
    payload = {
        "title": document.title,
        "approved_on": (v.approved_at or company_time.now()).date().isoformat(),
        "text": (v.markdown or "")[:MAX_TEXT],
    }
    data = clean(await ask("prd_plan", payload))
    row = await s.scalar(select(SimplePrdPlan).where(SimplePrdPlan.document_id == document.id))
    if row is None or row.version_id != v.id:
        return {"read": False, "reason": "a newer version's plan is read already"}
    row.job_id, row.read_at = job.id, company_time.now()
    if data is None:
        row.status, row.source, row.data = "none", None, {}
        await s.flush()
        return {"read": False, "reason": "the answer has no milestones"}
    row.status, row.source, row.data, row.error = "ready", "oracle", data, None
    await s.flush()
    return {"read": True, "milestones": len(data["milestones"])}


async def job_failed(s: AsyncSession, job: Any) -> None:
    """The job failed for good: the plan says so (an owner may read it again)."""
    row = await s.scalar(select(SimplePrdPlan).where(SimplePrdPlan.document_id == job.document_id))
    if row is not None and row.version_id == job.version_id and row.status == "reading":
        row.status = "failed"
        await s.flush()
