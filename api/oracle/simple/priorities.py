"""Simple S6 (#723): the priorities read (``GET /v1/simple/priorities``). For people: a run's
token is refused (oracle.simple.router._people).

The live goal-weighted ranking (oracle.priorities.service.compute, people's overrides
applied; each row keeps Oracle's rank as ``oracle_rank``) joined with the roadmap items the
reader sees (oracle.simple.service.load over the working drafts they see): a feature's row
takes its item in the earliest horizon (now, next, later), then the lowest key, never a
draft item (drafts are not ranked yet: they sit among the drafts); a feature with no visible
non-draft item is still a row (no item, not reorderable, no weeks in a bucket); one whose item
is a draft is on the roadmap (``draft_item_id``: a move confirms it).

**One feature, one row** (qa-prio-twins): records join by their link (an item's
``feature_id``, else its trace's source feature), never by name; separate features with one
name are one row (the best-ranked on a roadmap), the others its ``twins`` with how each merges
into it, and a draft shows on its feature's row (else a row of its name's: ``row_feature_id``),
not as a draft of its own. Nothing is merged or deleted here. Besides the
rows: the open ``override_priority`` and ``estimate_feature`` proposals the caller may see
(each with its item's feature, so one on a feature's other item shows under its row) and
the ``confirm_item``, ``merge_item`` (S7's Merge; train T's was a ``cut`` with a note) and
``cut`` proposals on draft items, the visible
draft items with the items they may merge into, the live non-draft items no row holds
(``unranked``: no feature, or one not ranked) and this quarter's engineer-weeks per goal.

**The line** (roadmap-plus): above the line is this quarter's plan (the Now horizon) by
default; ``?line=`` draws it at a day instead: ``key_date:<id>`` (a roadmap's key date),
``milestone:<id>`` (a dated track milestone) or ``date:<YYYY-MM-DD>``; then a row is above
the line when its item is planned to finish by that day (its stored or estimated end). An
unknown line reads as Now. ``lines`` offers Now, every key date and every dated milestone
the reader sees, except a milestone with a PRD key date's name on its day, listed once as
that key date (prio-line-once; its key still draws that line); the web keeps a person's pick
in their preferences (``priorities_line``).

Changes go through the change engine (``/v1/simple/changes``): ``override_priority`` (with
each row's ``before_override``), ``estimate_feature`` and ``confirm_item``. It writes
nothing.
"""

import re
import uuid
from datetime import date
from typing import Annotated, Any

from fastapi import APIRouter, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.deps import TenantDB
from oracle.authz import has_role
from oracle.baseline.goal_order import goal_position, sort_goals
from oracle.baseline.models import Entity
from oracle.docs import visibility
from oracle.docs.models import Document, DocumentVersion
from oracle.priorities import service as priorities
from oracle.priorities.schemas import RankedFeature
from oracle.roadmap import company
from oracle.roadmap.models import HORIZONS, RoadmapItem
from oracle.simple import additions, changes, drafts, key_dates, service, targets
from oracle.simple.models import SimpleChange
from oracle.simple.router import Reader
from oracle.simple.schemas import (
    SimpleDocRef,
    SimpleGoalBucket,
    SimpleLine,
    SimplePlanOut,
    SimplePrioritiesOut,
    SimplePriorityAfter,
    SimplePriorityDraft,
    SimplePriorityGoal,
    SimplePriorityMerge,
    SimplePriorityOverride,
    SimplePriorityProposal,
    SimplePriorityRow,
    SimplePriorityTwin,
    SimplePriorityUnranked,
    SimpleQuarter,
)
from oracle.trash.filter import INCLUDE_TRASHED

router = APIRouter(prefix="/v1/simple", tags=["simple"])

METHOD = "goal_weighted"
PROPOSED_OPS = ("override_priority", "estimate_feature")
# Confirm and Merge of a draft item, shown under the draft.
DRAFT_OPS = ("confirm_item", "cut", "merge_item")
MERGE_MAX = 8
NONE = "none"


def quarter(today: date) -> SimpleQuarter:
    """The calendar quarter of ``today``."""
    q = (today.month - 1) // 3
    start = date(today.year, 3 * q + 1, 1)
    end = date(today.year + 1, 1, 1) if q == 3 else date(today.year, 3 * q + 4, 1)
    return SimpleQuarter(start=start, end=date.fromordinal(end.toordinal() - 1),
                         label=f"Q{q + 1} {today.year}")  # fmt: skip


async def plan_quarter(
    db: AsyncSession, read_: service.Read
) -> tuple[SimpleQuarter, set[uuid.UUID] | None]:
    """plan-model: "this quarter" is the plan's span (the plan running today, else the next
    to start) of the PRDs on the roadmap; the calendar quarter only with no dated plan.
    With the plan's span, also the items it places in that span (a slice overlapping it);
    None: the calendar quarter, whose items are the Now horizon's."""
    from oracle.simple import plan

    views = await plan.views(db, {e.prd.id for e in read_.entries if e.prd})
    span = plan.current_span(list(views.values()), read_.today)
    if span is None:
        return quarter(read_.today), None
    inside = {
        e.row.id
        for e in read_.entries
        if e.prd is not None
        and e.prd.id in views
        and any(
            x.start_date is not None
            and x.end_date is not None
            and x.start_date <= span.end
            and x.end_date >= span.start
            for x in views[e.prd.id].slices_of(service._prd_code(e.row.prd_section_key))
        )
    }
    return SimpleQuarter(start=span.start, end=span.end, label=span.label), inside


async def plan_in_play(
    db: AsyncSession, read_: service.Read
) -> tuple[SimpleQuarter, SimplePlanOut | None]:
    """The quarter and plan-charts' plan: the plan "this quarter" is (its PRD on the roadmap
    the reader sees, its milestones, slices and engineer-weeks per goal per milestone)."""
    from oracle.simple import plan

    prds = {e.prd.id: e.prd for e in read_.entries if e.prd}
    picked = plan.current(await plan.views(db, set(prds)), read_.today)
    if picked is None or picked[1].span is None:
        return quarter(read_.today), None
    pid, view = picked
    span = view.span
    doc = prds[pid]
    return SimpleQuarter(start=span.start, end=span.end, label=span.label), SimplePlanOut(
        prd=SimpleDocRef(id=doc.id, slug=doc.slug, title=doc.title),
        status="ready", source=view.milestones[0].source if view.milestones else None,
        dated=view.dated, message=view.message, milestones=view.milestones,
        slices=view.slices, goals=view.goals, goal_weeks=view.goal_weeks, span=span,
        holidays=view.holidays,
    )  # fmt: skip


def _items(read_: service.Read) -> dict[str, service.Entry]:
    """Feature id -> its item: the earliest horizon, then the lowest key (cut and draft items
    never: a draft is not ranked yet)."""
    out: dict[str, service.Entry] = {}

    def key(e: service.Entry) -> tuple:
        h = e.row.horizon
        return (HORIZONS.index(h) if h in HORIZONS else len(HORIZONS), e.row.item_key)

    for e in read_.entries:
        if e.row.feature_id is None or e.status == "cut" or e.row.draft:
            continue
        fid = str(e.row.feature_id)
        if fid not in out or key(e) < key(out[fid]):
            out[fid] = e
    return out


def link(row: Any) -> str | None:
    """qa-prio-twins: the baseline feature an item stands for, by its link: its ``feature_id``,
    else the source feature its trace names; None for an item linked to none."""
    if row.feature_id is not None:
        return str(row.feature_id)
    for t in row.trace or []:
        if isinstance(t, dict) and t.get("target") == "feature" and t.get("id"):
            return str(t["id"])
    return None


def _live_drafts(read_: service.Read) -> list[service.Entry]:
    return [e for e in read_.entries if e.row.draft and e.status not in ("cut", "merged")]


def _held(read_: service.Read, roadmap_id: uuid.UUID | None) -> dict[str, service.Entry]:
    """qa-prio-twins: feature id -> its draft item (by its link; the lowest key) for a feature
    with no other item: on the roadmap, not yet confirmed (a move confirms it: targets.
    add_to_company finds it the same way). Only the company roadmap's (``roadmap_id``) while
    there is one."""
    out: dict[str, service.Entry] = {}
    for e in sorted(_live_drafts(read_), key=lambda e: e.row.item_key):
        if roadmap_id is not None and e.roadmap.id != roadmap_id:
            continue
        fid = link(e.row)
        if fid is not None:
            out.setdefault(fid, e)
    return out


def same_name(title: str | None) -> str:
    """What makes two records' names the same (qa-prio-twins): case and spacing aside."""
    return " ".join((title or "").split()).casefold()


def _goal(f: RankedFeature, e: service.Entry | None) -> SimplePriorityGoal | None:
    if e is not None and e.goal is not None:
        return SimplePriorityGoal(
            key=e.goal.key, title=e.goal.title, position=goal_position(e.goal.attrs)
        )
    if f.explanation.goals:
        g = f.explanation.goals[0]
        return SimplePriorityGoal(key=g.goal, title=g.title, position=g.position)
    return None


def _value(f: RankedFeature, name: str) -> Any:
    v = f.explanation.inputs.get(name)
    return v.get("value") if isinstance(v, dict) else None


def _after(rows: list[SimplePriorityRow], deps: dict[str, list[str]]) -> None:
    """A row scored above some row ranked above it waits for a dependency: name the nearest
    one above it among what it needs (transitively)."""
    position = {r.feature_id: i for i, r in enumerate(rows)}
    for i, r in enumerate(rows):
        if r.score is None or not any(o.score is not None and o.score < r.score for o in rows[:i]):
            continue
        seen: set[str] = set()
        todo = list(deps.get(r.feature_id, []))
        while todo:
            d = todo.pop()
            if d not in seen:
                seen.add(d)
                todo.extend(deps.get(d, []))
        above = [d for d in seen if d in position and position[d] < i]
        if above:
            nearest = rows[max(position[d] for d in above)]
            r.after = SimplePriorityAfter(code=nearest.code, title=nearest.title)


async def _proposals(
    db: AsyncSession,
    principal: Any,
    by_id: dict[uuid.UUID, service.Entry],
    twin_items: set[uuid.UUID] | None = None,
) -> list[SimplePriorityProposal]:
    """qa-prio-twins: also a ``merge_item`` of a row's twin's item (``twin_items``): it shows
    on that row."""
    rows = list(
        await db.scalars(
            select(SimpleChange)
            .where(
                SimpleChange.status == "proposed",
                SimpleChange.op.in_(PROPOSED_OPS + DRAFT_OPS),
            )
            .order_by(SimpleChange.at, SimpleChange.seq)
        )
    )
    if not rows:
        return []
    v = await changes._view(db, principal, rows)
    shown = []
    for c in rows:
        try:
            e = by_id.get(uuid.UUID(str(c.target.get("item_id"))))
        except ValueError:
            e = None
        twin = c.op == "merge_item" and e is not None and e.row.id in (twin_items or ())
        if e is not None and (c.op in PROPOSED_OPS or e.row.draft or twin) and v.sees(c):
            shown.append((c, e))
    from oracle.simple import visuals

    by_change = await visuals.flows_for(db, "change", [c.id for c, _ in shown])
    by_item = await visuals.flows_for(db, "feature", [e.row.id for _, e in shown])
    names = await changes._names(db, {c.by for c, _ in shown} | {
        p for c, _ in shown for p in v.route(c)
    })  # fmt: skip
    return [
        SimplePriorityProposal(
            change_id=c.id,
            op=c.op,
            item_id=e.row.id,
            feature_id=str(e.row.feature_id) if e.row.feature_id is not None else None,
            code=e.row.item_key,  # type: ignore[arg-type]
            title=e.row.title,
            by_name=names.get(c.by, "someone"),
            at=c.at,
            reason=c.reason,
            after=c.after,
            waiting_for=[names.get(p, "someone") for p in v.route(c)],
            can_decide=v.may_decide(c),
            can_withdraw=c.by == getattr(principal, "user_id", None),
            flow=by_change.get(c.id) or by_item.get(e.row.id),
        )  # fmt: skip
        for c, e in shown
    ]


def _drafts(
    read_: service.Read,
    principal: Any,
    rows: list[SimplePriorityRow] | None = None,
    named: dict[str, SimplePriorityRow] | None = None,
) -> list[SimplePriorityDraft]:
    """The visible drafts, each with the items it may merge into; qa-prio-twins: one that is a
    ranked row's feature (by its link, else by name: ``named``) shows on that row, its item
    first to merge into."""
    out = []
    live = [e for e in read_.entries if e.status not in ("cut", "merged")]
    by_feature = {r.feature_id: r for r in rows or []}
    for e in live:
        if not e.row.draft:
            continue
        fid = link(e.row)
        row = by_feature.get(fid) if fid is not None else None
        linked = row is not None
        if row is None and fid is None:
            row = (named or {}).get(same_name(e.row.title))
        goal = e.goal.id if e.goal is not None else None
        into = row.item_id if row is not None else None
        cands = sorted(
            (o for o in live if o.roadmap.id == e.roadmap.id and not o.row.draft),
            key=lambda o: (
                o.row.id != into,
                not (goal is not None and o.goal is not None and o.goal.id == goal),
                o.row.position,
                o.row.item_key,
            ),
        )[:MERGE_MAX]
        out.append(
            SimplePriorityDraft(
                item_id=e.row.id,
                code=e.row.item_key,
                title=e.row.title,
                goal=SimplePriorityGoal(
                    key=e.goal.key, title=e.goal.title, position=goal_position(e.goal.attrs)
                )
                if e.goal
                else None,
                roadmap=service._ref(e.roadmap),  # type: ignore[arg-type]
                applies=service.can_decide(principal, e, read_.deciders),
                merge_into=[
                    SimplePriorityMerge(item_id=o.row.id, code=o.row.item_key, title=o.row.title)
                    for o in cands
                ],
                row_feature_id=row.feature_id if row is not None else None,
                linked=linked,
            )  # fmt: skip
        )
    return out


def _unranked(read_: service.Read, ranked: set[str]) -> list[SimplePriorityUnranked]:
    """prio-unranked: the live, non-draft items whose feature no row holds (no feature, or one
    the ranking leaves out), by horizon, then position, then key."""

    def key(e: service.Entry) -> tuple:
        h = e.row.horizon
        return (
            HORIZONS.index(h) if h in HORIZONS else len(HORIZONS),
            e.row.position,
            e.row.item_key,
        )

    out = []
    for e in sorted(read_.entries, key=key):
        if e.status in ("cut", "merged") or e.row.draft:
            continue
        if e.row.feature_id is not None and str(e.row.feature_id) in ranked:
            continue
        goal = e.goal
        out.append(
            SimplePriorityUnranked(
                item_id=e.row.id,
                code=e.row.item_key,
                title=e.row.title,
                goal=SimplePriorityGoal(
                    key=goal.key, title=goal.title, position=goal_position(goal.attrs)
                )
                if goal
                else None,
                roadmap=service._ref(e.roadmap),  # type: ignore[arg-type]
            )
        )
    return out


# A slice of a feature reads its number with a letter (F-15a, oracle.baseline.fixes).
FEATURE_CODE = re.compile(r"[A-Z]{1,3}-\d+[a-j]?")


def _initials(name: str) -> str:
    """Initials of up to three words of ``name`` (Team invite nudges TIN); a one-word name's
    first two letters (Pricing PR); then the name's first number, if it has one (Pay 1 PA1,
    Team plan 2 TP2)."""
    words = re.findall(r"[^\W\d_]+", name)
    number = next(iter(re.findall(r"\d+", name)), "")
    if len(words) >= 2:
        return "".join(w[0] for w in words[:3]).upper() + number
    return ((words[0] if words else "") + "xx")[:2].upper() + number


PRD_SECTION_CODE = re.compile(r"([a-z]{1,3})-(\d+)", re.IGNORECASE)


def prd_code(section_key: str | None) -> str | None:
    """The PRD's own code of a section an item was imported from ("f-06" -> "F-06"); None
    for a section key that is no code ("problem", "goals")."""
    m = PRD_SECTION_CODE.fullmatch((section_key or "").strip())
    return f"{m.group(1).upper()}-{m.group(2)}" if m else None


def short_codes(
    keys: list[str], prd: dict[str, str] | None = None, names: dict[str, str] | None = None
) -> list[str]:
    """Each feature's short code, for feature keys in the features' creation order: the key
    when it is a code (F-12), else the PRD code of the section its roadmap item was imported
    from (``prd``: "F-06"), else the initials of its shown name (``names``, by key; the key
    when it has none: Team invite nudges TIN) and its number (Pay 1 PA1), a digit added on a
    clash (SC, SC2; PA1.2 after a number) in creation order. From the feature alone, never the
    item a reader sees, nor the key's order or the rank: every reader reads the same code, and
    a new feature never renames an older one."""
    prd = prd or {}
    names = names or {}
    out: list[str | None] = [None] * len(keys)
    taken: set[str] = set()
    # Codes (the key's own, else the PRD's) in creation order: the older feature keeps a
    # code; a later one that would read the same reads it with a digit (F-06.2).
    for i, k in enumerate(keys):
        own = k if FEATURE_CODE.fullmatch(k) else prd.get(k)
        if own is None:
            continue
        if own in taken and not FEATURE_CODE.fullmatch(k):
            continue  # a PRD code already taken: initials below
        code, n = own, 1
        while code in taken:
            n += 1
            code = f"{own}.{n}"
        out[i] = code
        taken.add(code)
    for i, k in enumerate(keys):
        if out[i] is not None:
            continue
        base = _initials(names.get(k) or k)
        sep = "." if base[-1:].isdigit() else ""
        code, n = base, 1
        while code in taken:
            n += 1
            code = f"{base}{sep}{n}"
        taken.add(code)
        out[i] = code
    return out  # type: ignore[return-value]


async def _shown_names(db: AsyncSession, key_of: dict[uuid.UUID, str]) -> dict[str, str]:
    """Each feature's shown name by its key: the title of its item on a roadmap every reader
    sees (the version the roadmap shows; the earliest horizon, then the lowest key, as
    ``_items``; never a draft item), else the feature's own title. So a rename moves the code,
    and every reader reads the same one."""
    docs = list(
        await db.scalars(
            select(Document.id).where(
                Document.kind == "roadmap", Document.visibility == visibility.COMPANY
            )
        )
    )
    # one-roadmap-many-prds: the company roadmap alone while there is one (the rest is history).
    docs = await company.feeding_ids(db, docs)
    if not docs:
        return {}
    versions = (
        await db.execute(
            select(
                DocumentVersion.id,
                DocumentVersion.document_id,
                DocumentVersion.number,
                DocumentVersion.approved_at,
            ).where(DocumentVersion.document_id.in_(docs))
        )
    ).all()
    with_items = set(
        await db.scalars(
            select(RoadmapItem.roadmap_version_id)
            .where(RoadmapItem.roadmap_document_id.in_(docs))
            .distinct()
        )
    )
    shown = service._versions(versions, with_items, await drafts.submitted_versions(db))
    best: dict[str, tuple[tuple, str]] = {}
    for fid, title, horizon, item_key in await db.execute(
        select(
            RoadmapItem.feature_id, RoadmapItem.title, RoadmapItem.horizon, RoadmapItem.item_key
        ).where(
            RoadmapItem.roadmap_version_id.in_(list(shown.values())),
            RoadmapItem.feature_id.is_not(None),
            RoadmapItem.draft.is_(False),
        )
    ):
        k = key_of.get(fid)
        if k is None or not (title or "").strip():
            continue
        rank = (HORIZONS.index(horizon) if horizon in HORIZONS else len(HORIZONS), item_key)
        if k not in best or rank < best[k][0]:
            best[k] = (rank, title.strip())
    return {k: t for k, (_, t) in best.items()}


async def _short_codes(db: AsyncSession, names: bool = True) -> dict[str, str]:
    """Every feature's short code by its key, over all the company's features (dropped ones
    keep theirs, so no code moves when one goes). A feature whose roadmap item came from a
    PRD section with a code ("f-06") reads as the PRD names it (F-06); one with no code the
    letters of its shown name (``_shown_names``). ``names=False`` skips that lookup for a
    caller that keeps only the real codes (the roadmap's): those never depend on names."""
    from oracle.roadmap import codes

    features, sections = codes.feature_reads()
    rows = (await db.execute(features)).all()
    keys = [k for _, k, _ in rows]
    key_of = {i: k for i, k, _ in rows}
    shown = {k: t for _, k, t in rows if (t or "").strip()}
    if names:
        shown |= await _shown_names(db, key_of)
    prd = codes.prd_by_key(key_of, await db.execute(sections))
    return dict(zip(keys, short_codes(keys, prd, shown), strict=True))


def _buckets(
    rows: list[SimplePriorityRow],
    inside: set[uuid.UUID] | None = None,
    order: dict[str, int] | None = None,
) -> tuple[list[SimpleGoalBucket], float]:
    """Engineer-weeks per goal this quarter: the plan's items in its span (``inside``), else
    the Now horizon's. Goals come in the one goal order (``order``: goal key -> place),
    "No goal" last."""
    goals: dict[str, SimpleGoalBucket] = {}
    none: SimpleGoalBucket | None = None
    for r in rows:
        if r.goal is None:
            if none is None:
                none = SimpleGoalBucket(key=NONE, title="No goal", weeks=0, share=0, codes=[],
                                        no_goal=True)  # fmt: skip
            b = none
        else:
            if r.goal.key not in goals:
                goals[r.goal.key] = SimpleGoalBucket(
                    key=r.goal.key,
                    title=r.goal.title,
                    weeks=0,
                    share=0,
                    codes=[],
                    position=r.goal.position,
                )
            b = goals[r.goal.key]
        if (r.item_id in inside) if inside is not None else r.horizon == "now":
            b.weeks += r.effort or 0
            b.codes.append(r.code)
    place = order or {}
    ranked = sorted(goals, key=lambda k: (place.get(k, len(place)), k))
    out = [goals[k] for k in ranked] + ([none] if none is not None else [])
    total = round(sum(b.weeks for b in out), 3)
    for b in out:
        b.weeks = round(b.weeks, 3)
        b.share = round(b.weeks / total, 3) if total else 0
    return out, total


def _day(d: date) -> str:
    return f"{d:%b} {d.day}, {d.year}"


NOW_LINE = SimpleLine(key="now", kind="now", label="This quarter (Now)")


# A milestone's code before its words: "M1 · ", "F-26: ", "M2b " (roadmap/_lib.ts drawnKeyDates).
_CODE = re.compile(r"^[A-Z][A-Z0-9]*-?[0-9]+[a-z]?\s*[·:.\-–—]?\s*")


def _same_as(name: str, day: date) -> set[tuple[str, date]]:
    """What makes a milestone the same as another on its day (prio-line-once), by the roadmap
    chart's rule (roadmap/_lib.ts drawnKeyDates): its code ("M1"), or its name without the
    code ("prove it", in lower case as the chart's toLowerCase)."""
    words = _CODE.sub("", name, count=1).strip().lower()
    return {(re.split(r"[\s·]", name)[0], day)} | ({("~" + words, day)} if words else set())


# prio-company (Nov 4): a name carrying a template's lone "N" placeholder ("Milestone N
# agents") is no name a person reads; a real name with brackets ("Beta [internal]") is.
_PLACEHOLDER = re.compile(r"(^|\s)N(\s|$)")


def readable(name: str | None) -> str | None:
    """``name`` when a person can read it, else None (a placeholder left from a template)."""
    name = (name or "").strip()
    return name if name and not _PLACEHOLDER.search(name) else None


def _code_of(name: str) -> str | None:
    """A milestone's code ("M1" of "M1 · Measured"), None for a name with no code."""
    m = _CODE.match(name)
    return re.split(r"[\s·:.–—]", name)[0] if m else None


async def lines(
    db: AsyncSession, principal: Any, read_: service.Read
) -> tuple[list[SimpleLine], dict[str, SimpleLine]]:
    """The lines offered: Now, each key date and each dated milestone of the roadmap the
    reader sees (the company roadmap's while there is one: ``service.load``), each naming its
    PRD, each once; and the line each milestone left out is drawn at (prio-line-once,
    below), by its key."""
    docs = {e.roadmap.id: e.roadmap for e in read_.entries}
    # priorities-keydates: the roadmap's key dates as Simple › Roadmap reads them, its PRDs'
    # milestones with them.
    kds, _ = await key_dates.read_key_dates(db, principal, docs, read_.entries)
    kds = [k for k in kds if readable(k.name)]
    tracks = {e.track.id: e.track for e in read_.entries if e.track is not None}
    prds = {e.prd.id: e.prd for e in read_.entries if e.prd is not None}
    out = [NOW_LINE]
    out += [
        SimpleLine(
            key=f"key_date:{k.id}",
            kind="key_date",
            label=f"{k.name} · {_day(k.date)}",
            date=k.date,
            prd=k.prd,
        )
        for k in kds
    ]
    # prio-line-once (the owner, Nov 3: "show it once"): a plan milestone the same as a PRD key
    # date on its day (_same_as: its code, or its name without the code) is that milestone,
    # listed once, "From the PRD"; a saved pick of it draws the key date's line. prio-company
    # (Nov 4): one of the PRD's codes on any day is that milestone too (a stale copy: "M1 ·
    # Measured" beside "M1 · Measured and mapped"), and a line the same as one listed, once.
    from_prd: dict[tuple[str, date], SimpleLine] = {}
    by_code: dict[tuple[uuid.UUID, str], SimpleLine] = {}
    seen: dict[tuple[str, date | None], SimpleLine] = {}
    for k, ln in zip(kds, out[1:], strict=True):
        for same_as in _same_as(k.name, k.date) if k.prd else ():
            from_prd.setdefault(same_as, ln)
        code = _code_of(k.name)
        if k.prd is not None and code:
            by_code.setdefault((k.prd.id, code), ln)
    kept = [out[0]]
    for ln in out[1:]:
        twin = seen.get((f"{ln.label}|{ln.prd.id if ln.prd else ''}", ln.date))
        if twin is None:
            seen[(f"{ln.label}|{ln.prd.id if ln.prd else ''}", ln.date)] = ln
            kept.append(ln)
    out = kept
    same: dict[str, SimpleLine] = {}
    for m in read_.milestones:
        if m.target_date is None or m.track_id not in tracks or m.status == "dropped":
            continue
        if not readable(m.name):
            continue
        key = f"milestone:{m.id}"
        track = tracks[m.track_id]
        code = _code_of(m.name)
        kd = next(
            (from_prd[x] for x in sorted(_same_as(m.name, m.target_date)) if x in from_prd), None
        ) or (next((by_code[(p, code)] for p in track.prd_ids if (p, code) in by_code), None)
              if code else None)  # fmt: skip
        # tracks-goal: a track milestone reads the first of the track's PRDs on the roadmap.
        prd = next((prds[p] for p in track.prd_ids if p in prds), None)
        ref = SimpleDocRef(id=prd.id, slug=prd.slug, title=prd.title) if prd else None
        ln = SimpleLine(key=key, kind="milestone", label=f"{m.name} · {_day(m.target_date)}",
                        date=m.target_date, prd=ref)  # fmt: skip
        twin = kd or seen.get((f"{ln.label}|{ref.id if ref else ''}", ln.date))
        if twin is not None:
            same[key] = twin
            continue
        seen[(f"{ln.label}|{ref.id if ref else ''}", ln.date)] = ln
        out.append(ln)
    # Key dates and milestones in date order, one list (Now first).
    return [out[0], *sorted(out[1:], key=lambda x: x.date or date.max)], same


# A picked day earlier than this is a half-typed one (year 1, 20, 202), never a line.
FIRST_LINE_YEAR = 2000


def pick_line(
    key: str | None, offered: list[SimpleLine], same: dict[str, SimpleLine] | None = None
) -> SimpleLine:
    """The line ``key`` names among those offered (or, for a milestone left out as a PRD's key
    date, that key date's: ``same``), or a picked day; else Now."""
    if key and key.startswith("date:"):
        try:
            day = date.fromisoformat(key[5:])
        except ValueError:
            return NOW_LINE
        if day.year < FIRST_LINE_YEAR:
            return NOW_LINE
        return SimpleLine(key=f"date:{day.isoformat()}", kind="date", label=f"By {_day(day)}",
                          date=day)  # fmt: skip
    if key and same and key in same:
        return same[key]
    return next((x for x in offered if x.key == key), NOW_LINE)


def above(e: service.Entry | None, line: SimpleLine) -> bool:
    if e is None:
        return False
    if line.date is None:
        return e.row.horizon == "now"
    return e.resolved.end.date <= line.date


async def _trashed_without_live(db: AsyncSession, feature_ids: set[str]) -> set[str]:
    """Feature ids (``ranking.features``' ``entity_id`` strings) with at least one roadmap
    item in Trash and no live one anywhere (trash-features-goals): those leave Priorities
    with their roadmap item, not just the reader's view of it. A feature with no roadmap
    item at all, or whose only item sits on a roadmap this reader cannot see, keeps showing
    as it did (its row un-reorderable): this only drops a feature actually in Trash."""
    ids = {uuid.UUID(f) for f in feature_ids}
    if not ids:
        return set()
    rows = await db.execute(
        select(RoadmapItem.feature_id, RoadmapItem.deleted_at)
        .where(RoadmapItem.feature_id.in_(ids))
        .execution_options(**{INCLUDE_TRASHED: True})
    )
    trashed: set[str] = set()
    live: set[str] = set()
    for feature_id, deleted_at in rows:
        (live if deleted_at is None else trashed).add(str(feature_id))
    return trashed - live


def _milestone_name(e: service.Entry | None) -> str | None:
    """The item's milestone as a person reads it: its own name, else the track milestone's
    it is on, else none (prio-company: never a template's placeholder)."""
    if e is None or e.milestone is None:
        return None
    return readable(e.milestone.name) or readable(e.milestone.record_name)


def _fold_twins(
    rows: list[SimplePriorityRow],
    titles: dict[str, str],
    by_id: dict[uuid.UUID, service.Entry],
    principal: Any,
    deciders: Any,
    can_change: bool,
) -> tuple[list[SimplePriorityRow], dict[str, SimplePriorityRow]]:
    """qa-prio-twins: rows of separate features with one name (a row's title or its feature's
    own, ``titles``: feature id -> title) are one feature not linked as one: one row, the
    best-ranked of those on a roadmap (else the best-ranked), listing the others as its
    ``twins`` with how each merges into it; nothing is merged. Also each name -> its row."""
    group: dict[str, int] = {}
    groups: list[list[SimplePriorityRow]] = []
    for r in rows:
        names = {n for n in (same_name(r.title), same_name(titles.get(r.feature_id))) if n}
        found = sorted({group[n] for n in names if n in group})
        if found:
            g = found[0]
            for other in found[1:]:
                groups[g] += groups[other]
                groups[other] = []
                group |= {n: g for n, x in group.items() if x == other}
            groups[g].append(r)
        else:
            g = len(groups)
            groups.append([r])
        group |= dict.fromkeys(names, g)
    lead_of: dict[str, SimplePriorityRow] = {}
    for members in groups:
        if not members:
            continue
        members.sort(key=lambda r: r.rank)
        lead = next((r for r in members if r.on_roadmap), members[0])
        for r in members:
            lead_of[r.feature_id] = lead
            if r is lead:
                continue
            e = by_id.get(r.item_id) if r.item_id is not None else None
            lead_e = by_id.get(lead.item_id) if lead.item_id is not None else None
            merge: str | None = None
            applies = False
            if not can_change:
                pass
            elif e is not None and lead_e is not None and e.roadmap.id == lead_e.roadmap.id:
                merge, applies = "item", service.can_decide(principal, e, deciders)
            else:
                # No item, an item on another roadmap, or a lead with only a draft: the
                # baseline's Merge into… of its feature into the row's.
                merge, applies = "entity", has_role(principal.role, "approver")
            lead.twins.append(
                SimplePriorityTwin(
                    feature_id=r.feature_id, item_id=r.item_id, code=r.code, title=r.title,
                    goal=r.goal, rank=r.rank, merge=merge,  # type: ignore[arg-type]
                    into_id=lead.item_id if merge == "item" else None, applies=applies,
                )
            )  # fmt: skip
    kept = [r for r in rows if lead_of[r.feature_id] is r]
    named = {n: lead_of[gr[0].feature_id] for n, g in group.items() if (gr := groups[g])}
    return kept, named


async def build(
    db: AsyncSession, principal: Any, line_key: str | None = None
) -> SimplePrioritiesOut:
    ranking = await priorities.compute(db, METHOD, principal, overrides=True)
    read_ = await service.load(db, await drafts.overlays_for(db, principal))
    items = _items(read_)
    offered, same = await lines(db, principal, read_)
    line = pick_line(line_key, offered, same)
    active = {str(o.id): o for o in await priorities.active_overrides(db)}
    by_feature = {str(o.feature_id): o for o in active.values()}
    names = await changes._names(db, {o.created_by for o in active.values()})
    can_change = has_role(principal.role, "commenter")
    trashed = await _trashed_without_live(
        db, {f.entity_id for f in ranking.features if f.entity_id not in items}
    )
    features = [f for f in ranking.features if f.entity_id not in trashed]
    # prio-company (Nov 4): an owner moves every row; a feature not on the company roadmap
    # their move adds there (targets.add_to_company). Anyone else moves what is on it.
    owner = has_role(principal.role, "owner")
    the_company = await company.active(db)
    held = _held(read_, the_company.id if the_company is not None else None)
    code_of = {
        f.key: (items[f.entity_id].row.item_key if f.entity_id in items else f.key)
        for f in features
    }
    id_of = {f.key: f.entity_id for f in features}
    key_of = {f.entity_id: f.key for f in features}
    by_id = read_.by_id()
    # feature-parts: each part's parent, as the roadmap reads it.
    extras: dict[uuid.UUID, dict[str, Any]] = {}
    additions._parts(read_, list(items.values()), extras)
    rows: list[SimplePriorityRow] = []
    deps: dict[str, list[str]] = {}
    prd_of: list[str | None] = []
    for f in features:
        e = items.get(f.entity_id)
        # roadmap-edit-fixes round 1: a feature on the roadmap needs what its item depends
        # on, as its panel lists it; the baseline's feature edges only for one that is not.
        needs = f.depends_on
        if e is not None:
            fids = [str(d.row.feature_id) for i in e.depends_on
                    if (d := by_id.get(i)) is not None and d.row.feature_id]  # fmt: skip
            needs = list(dict.fromkeys(key_of[x] for x in fids if x in key_of and x != f.entity_id))
        deps[f.entity_id] = [id_of[d] for d in needs if d in id_of]
        gv = f.explanation.inputs.get("goal_value")
        prd_of.append(str(e.prd.id) if e is not None and e.prd is not None else None)
        o = active.get(f.override.id) if f.override is not None else None
        rows.append(
            SimplePriorityRow(
                rank=f.rank,
                oracle_rank=f.formula_rank,
                feature_id=f.entity_id,
                item_id=e.row.id if e is not None else None,
                code=e.row.item_key if e is not None else f.key,
                title=e.row.title if e is not None else f.title,
                goal=_goal(f, e),
                milestone=_milestone_name(e),
                horizon=e.row.horizon if e is not None else None,  # type: ignore[arg-type]
                goal_value=_value(f, "goal_value"),
                effort=_value(f, "effort"),
                score=f.score,
                confidence=round(f.explanation.confidence.value, 2),
                value_estimated=bool(isinstance(gv, dict) and gv.get("estimated")),
                depends_on=[code_of[d] for d in needs if d in code_of],
                override=SimplePriorityOverride(
                    by_name=names.get(o.created_by, f.override.by) if o else f.override.by,
                    reason=f.override.reason,
                    at=f.override.created_at,
                )
                if f.override is not None
                else None,
                above_line=above(e, line),
                end_date=e.resolved.end.date if e is not None else None,
                end_estimated=e is not None and e.resolved.end.estimated,
                estimate_pending=e is not None and e.row.estimate_pending,
                no_goal=not f.serves_goal,
                can_reorder=can_change and (e is not None or owner),
                # qa-prio-twins: a draft item of the feature is on the roadmap too.
                on_roadmap=e is not None or f.entity_id in held,
                draft_item_id=held[f.entity_id].row.id
                if e is None and f.entity_id in held
                else None,
                applies=service.can_decide(principal, e, read_.deciders) if e else owner,
                part_of=extras.get(e.row.id, {}).get("part_of") if e is not None else None,
                parts=extras.get(e.row.id, {}).get("parts", []) if e is not None else [],
                before_override=targets._snap(by_feature.get(f.entity_id)),
            )
        )
    short = await _short_codes(db)
    for f, r in zip(features, rows, strict=True):
        r.short_code = short.get(f.key, f.key)
        r.own_key = r.short_code if FEATURE_CODE.fullmatch(r.short_code) else None
    _after(rows, deps)
    this_quarter, inside = await plan_quarter(db, read_)
    _, plan_out = await plan_in_play(db, read_)
    if plan_out is not None:
        for r, pid in zip(rows, prd_of, strict=True):
            r.in_plan = pid == str(plan_out.prd.id)
    rows, named = _fold_twins(rows, {f.entity_id: f.title for f in features}, by_id, principal,
                              read_.deciders, can_change)  # fmt: skip
    twin_items = {t.item_id for r in rows for t in r.twins if t.item_id is not None}
    goal_rows = await db.scalars(select(Entity).where(Entity.type == "goal"))
    order = {g.key: i for i, g in enumerate(sort_goals(goal_rows))}
    buckets, total = _buckets(rows, inside, order)
    return SimplePrioritiesOut(
        today=read_.today,
        quarter=this_quarter,
        plan=plan_out,
        method=METHOD,
        formula=ranking.formula,
        rows=rows,
        proposals=await _proposals(db, principal, read_.by_id(), twin_items),
        drafts=_drafts(read_, principal, rows, named),
        unranked=_unranked(read_, {f.entity_id for f in features}),
        buckets=buckets,
        weeks_total=total,
        can_change=can_change,
        line=line,
        lines=offered,
        company_roadmap=SimpleDocRef(
            id=the_company.id, slug=the_company.slug, title=the_company.title
        )
        if the_company is not None
        else None,
    )


@router.get("/priorities", response_model=SimplePrioritiesOut, name="get_simple_priorities")
async def get_simple_priorities(
    principal: Reader, db: TenantDB, line: Annotated[str | None, Query(max_length=80)] = None
) -> SimplePrioritiesOut:
    """The live goal-weighted ranking in the company's order joined with the roadmap items
    the caller sees: each row's Oracle rank, goal, horizon, goal value (a person's estimate
    or the goals'), effort, score, the dependency it waits for, the override that placed it
    and whether the caller's change applies or is proposed; the open priority and estimate
    proposals, the draft items with what they may merge into, the items no row holds, and
    this quarter's engineer-weeks per goal. ``line``: where the line is drawn (Now, a key
    date, a dated milestone or a day; see the module)."""
    return await build(db, principal, line)
