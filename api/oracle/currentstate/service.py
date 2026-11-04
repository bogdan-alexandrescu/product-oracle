"""Current state beside Desired state: each confirmed feature's mark, its proof and the
owner's decisions.

**The mark** (:func:`mark`): a feature *exists* when it was marked as already shipped or
moved to Current state, unless the owner said it no longer runs; it reads *exists_old*
when its proof was last read more than 30 days ago, and *exists* with ``no_proof_yet``
when it has no proof at all. Otherwise it is *in_progress* when any proof counts
something or its items' tasks are under way, else *new*.

**Ready** (:func:`ready`): not existing yet, with all four proofs in (code map hits,
merged pull requests, every task done, a measured value), and no Not yet from the owner
since the proof was last read.

**Re-reading** (:func:`reread`, one reader per kind in :data:`READERS`): code map hits
are the shared code maps' entries that name the feature (its key, title or items' keys);
pull requests are the synced merged ones that name it; tasks are its roadmap items' tasks
(done of all, dropped left out); the measured value is the latest week of the metric of
the goal it supports. A source with nothing for the feature keeps the stored proof,
unconfirmed: the mark ages on ``checked_at`` (a live read, a move or the owner's "still
runs"), not on ``read_at`` (any re-read). A measured value from a past month is not
still true ("not read yet").
:func:`nightly` re-reads every feature with a state or proofs once a night (the
scheduled ticker, oracle.ticker.body).
"""

import re
import uuid
from collections.abc import Awaitable, Callable, Iterable
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.baseline.models import Edge, Entity
from oracle.currentstate.models import PROOF_KINDS, FeatureProof, FeatureState
from oracle.currentstate.schemas import FeatureProofOut, FeatureStateOut, FeatureStatesOut
from oracle.engineering import codemap, codemaps
from oracle.metrics.models import Metric, MetricValue
from oracle.roadmap.models import RoadmapItem
from oracle.simple.models import RoadmapItemTask
from oracle.sources.connectors.github import _MERGED
from oracle.sources.models import SourceItem, SourceItemVersion

OLD_AFTER = timedelta(days=30)
# A feature re-read within this long is not read again by the nightly job.
NIGHT = timedelta(hours=20)
NOT_READ_YET = "not read yet"
UNDER_WAY = ("doing", "done")


class NotFound(Exception):
    pass


class NotReady(Exception):
    pass


def _id(value: uuid.UUID | str) -> uuid.UUID:
    return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))


def exists(state: FeatureState | None) -> bool:
    return (
        state is not None
        and state.status in ("shipped", "current")
        and state.answer != "no_longer_runs"
    )


def mark(
    state: FeatureState | None,
    proofs: Iterable[FeatureProof],
    under_way: bool,
    now: datetime,
) -> str:
    """``new``, ``in_progress``, ``exists`` or ``exists_old`` (module docstring)."""
    proofs = list(proofs)
    if exists(state):
        assert state is not None
        if state.checked_at is not None and now - state.checked_at > OLD_AFTER:
            return "exists_old"
        return "exists"
    if under_way or any((p.count or 0) > 0 for p in proofs):
        return "in_progress"
    return "new"


def ready(state: FeatureState | None, proofs: Iterable[FeatureProof]) -> bool:
    if exists(state):
        return False
    by = {p.kind: p for p in proofs}
    code, prs, tasks, measured = (by.get(k) for k in PROOF_KINDS)
    if not (
        code is not None
        and (code.count or 0) > 0
        and prs is not None
        and (prs.count or 0) > 0
        and tasks is not None
        and (tasks.total or 0) > 0
        and tasks.count == tasks.total
        and measured is not None
        and bool(measured.value)
    ):
        return False
    if state is not None and state.not_yet_at is not None:
        read = [p.checked_at for p in by.values()] + [state.read_at]
        latest = max((at for at in read if at), default=None)
        if latest is None or state.not_yet_at >= latest:
            return False
    return True


async def feature(db: AsyncSession, feature_id: uuid.UUID | str) -> Entity:
    """A confirmed feature, or :class:`NotFound`."""
    try:
        fid = _id(feature_id)
    except ValueError as exc:
        raise NotFound from exc
    row = await db.get(Entity, fid)
    if row is None or row.type != "feature" or row.status != "confirmed":
        raise NotFound
    return row


async def state_of(db: AsyncSession, feature_id: uuid.UUID | str) -> FeatureState | None:
    return (
        await db.execute(select(FeatureState).where(FeatureState.feature_id == _id(feature_id)))
    ).scalar_one_or_none()


async def proofs_of(db: AsyncSession, feature_id: uuid.UUID | str) -> list[FeatureProof]:
    rows = (
        await db.execute(select(FeatureProof).where(FeatureProof.feature_id == _id(feature_id)))
    ).scalars()
    return sorted(rows, key=lambda p: PROOF_KINDS.index(p.kind))


async def _state(db: AsyncSession, feature_id: uuid.UUID) -> FeatureState:
    st = await state_of(db, feature_id)
    if st is None:
        st = FeatureState(feature_id=feature_id, status="desired", checking=False)
        db.add(st)
    return st


async def _items(db: AsyncSession, ids: Iterable[uuid.UUID]) -> dict[uuid.UUID, list[RoadmapItem]]:
    ids = list(ids)
    out: dict[uuid.UUID, list[RoadmapItem]] = {}
    if not ids:
        return out
    rows = (
        await db.execute(
            select(RoadmapItem)
            .where(RoadmapItem.feature_id.in_(ids))
            .order_by(RoadmapItem.item_key, RoadmapItem.id)
        )
    ).scalars()
    for row in rows:
        assert row.feature_id is not None
        out.setdefault(row.feature_id, []).append(row)
    return out


async def _tasks(db: AsyncSession, items: list[RoadmapItem]) -> list[RoadmapItemTask]:
    """The tasks under these items (by id, or by roadmap and key: another version's)."""
    if not items:
        return []
    ids = {i.id for i in items}
    anchors = {(i.roadmap_document_id, i.item_key) for i in items if i.roadmap_document_id}
    docs = {d for d, _ in anchors}
    q = select(RoadmapItemTask).where(
        RoadmapItemTask.item_id.in_(ids) | RoadmapItemTask.roadmap_document_id.in_(docs)
    )
    return [
        t
        for t in (await db.execute(q)).scalars()
        if t.item_id in ids or (t.roadmap_document_id, t.item_key) in anchors
    ]


# One reader per proof kind, reading it again from its live source. Each says whether that
# source confirmed the proof now; without anything there the stored count or value stays,
# not confirmed.
Reader = Callable[[AsyncSession, Entity, FeatureProof, datetime], Awaitable[bool]]


async def _names(db: AsyncSession, f: Entity) -> list[str]:
    """The words that name the feature in code and pull requests: its key, its title (as
    words and as a slug) and its roadmap items' keys."""
    title = (f.title or "").strip()
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    words = [f.key, title, slug, *(i.item_key for i in (await _items(db, [f.id])).get(f.id, []))]
    return sorted({w.lower() for w in words if w and len(w) > 2})


def _names_in(names: list[str], text: str) -> bool:
    text = text.lower()
    return any(re.search(rf"(?<![a-z0-9]){re.escape(n)}(?![a-z0-9])", text) for n in names)


async def read_code_map(db: AsyncSession, f: Entity, proof: FeatureProof, now: datetime) -> bool:
    """Code map hits: the entries of each shared code map (its latest per repo) whose id,
    name, path or summary names the feature."""
    names = await _names(db, f)
    hits = 0
    for m in await codemaps.latest_shared(db):
        for kind in codemap.KINDS:
            for entry in (m.content or {}).get(kind) or []:
                if isinstance(entry, dict):
                    words = (entry.get(k) for k in ("id", "name", "path", "summary"))
                    hits += _names_in(names, " ".join(w for w in words if isinstance(w, str)))
    if hits:
        proof.count = hits
    proof.still_true = (proof.count or 0) > 0
    return hits > 0


async def read_pull_requests(
    db: AsyncSession, f: Entity, proof: FeatureProof, now: datetime
) -> bool:
    """Merged pull requests that name the feature in their title or text."""
    names = await _names(db, f)
    rows = await db.execute(
        select(SourceItemVersion.title, SourceItemVersion.content)
        .join(SourceItem, SourceItem.current_version_id == SourceItemVersion.id)
        .where(SourceItem.kind == "pull_request", SourceItem.deleted_at.is_(None))
    )
    merged = sum(
        bool(m and m.group(1) != "no") and _names_in(names, f"{title or ''}\n{content}")
        for title, content in rows
        for m in [_MERGED.search(content)]
    )
    if merged:
        proof.count = merged
    proof.still_true = (proof.count or 0) > 0
    return merged > 0


async def read_measured(db: AsyncSession, f: Entity, proof: FeatureProof, now: datetime) -> bool:
    """The latest week of the metric that measures the feature's goal ("3,410 sent", its
    month); one from a past month is not still true."""
    goal = (
        await db.execute(
            select(Edge.dst_id)
            .join(Entity, Entity.id == Edge.dst_id)
            .where(Edge.src_id == f.id, Edge.type == "supports", Edge.status != "rejected",
                   Entity.type == "goal", Entity.status == "confirmed")
            .order_by(Entity.key)
            .limit(1)
        )
    ).scalar_one_or_none()  # fmt: skip
    latest = None
    if goal is not None:
        latest = (
            await db.execute(
                select(MetricValue.value, MetricValue.week_start, Metric.unit)
                .join(Metric, Metric.id == MetricValue.metric_id)
                .where(Metric.goal_id == goal, Metric.status != "archived")
                .order_by(MetricValue.week_start.desc())
                .limit(1)
            )
        ).first()
    if latest is not None:
        value, week, unit = latest
        number = f"{value:,.0f}" if value == value.to_integral_value() else f"{value:,}"
        proof.value = f"{number} {unit}".strip()
        proof.period = week.strftime("%b")
    proof.still_true = bool(proof.value) and not _past_period(proof.period, now)
    return latest is not None and bool(proof.still_true)


async def read_tasks(db: AsyncSession, f: Entity, proof: FeatureProof, now: datetime) -> bool:
    """Tracker tasks under the feature's roadmap items: done of all, dropped left out. With
    no tasks there the stored numbers stay."""
    tasks = [t for t in await _tasks(db, (await _items(db, [f.id])).get(f.id, [])) if
             t.status != "dropped"]  # fmt: skip
    if tasks:
        proof.total = len(tasks)
        proof.count = sum(t.status == "done" for t in tasks)
    proof.still_true = (proof.total or 0) > 0 and proof.count == proof.total
    return bool(tasks)


READERS: dict[str, Reader] = {
    "code_map": read_code_map,
    "pull_requests": read_pull_requests,
    "tasks": read_tasks,
    "measured": read_measured,
}


def _past_period(period: str | None, now: datetime) -> bool:
    return bool(period) and period != now.strftime("%b")


def _ok(proof: FeatureProof) -> bool:
    if proof.kind == "tasks":
        return (proof.total or 0) > 0 and proof.count == proof.total
    if proof.kind == "measured":
        return bool(proof.value)
    return (proof.count or 0) > 0


async def reread(db: AsyncSession, f: Entity, now: datetime) -> FeatureState:
    """Read each of the feature's proofs again now (a kind with nothing stored is made
    when its source has something); stamps the state's read_at. Only a proof a live source
    read again (it had rows for the feature) is stamped checked now, and the state's
    checked_at with it: a re-read that finds nothing leaves old proof old."""
    stored = {p.kind: p for p in await proofs_of(db, f.id)}
    confirmed = False
    for kind in PROOF_KINDS:
        proof = stored.get(kind) or FeatureProof(feature_id=f.id, kind=kind)
        live = await READERS[kind](db, f, proof, now)
        if kind not in stored and not live:
            continue
        if kind not in stored:
            db.add(proof)
        proof.ok = _ok(proof)
        if live:
            proof.checked_at = now
            confirmed = True
    st = await _state(db, f.id)
    st.read_at, st.checking = now, False
    if confirmed:
        st.checked_at = now
    await db.flush()
    return st


async def _candidates(db: AsyncSession) -> list[uuid.UUID]:
    ids = set((await db.execute(select(FeatureState.feature_id))).scalars())
    ids |= set((await db.execute(select(FeatureProof.feature_id))).scalars())
    return sorted(ids)


async def reread_all(db: AsyncSession, now: datetime, *, since: datetime | None = None) -> int:
    """Re-read every feature with a state or proofs (skipping those read at or after
    ``since``); the number re-read."""
    ids = await _candidates(db)
    if not ids:
        return 0
    states = {
        s.feature_id: s
        for s in (
            await db.execute(select(FeatureState).where(FeatureState.feature_id.in_(ids)))
        ).scalars()
    }
    n = 0
    for f in (await db.execute(select(Entity).where(Entity.id.in_(ids)))).scalars():
        st = states.get(f.id)
        if since is not None and st is not None and st.read_at and st.read_at >= since:
            continue
        await reread(db, f, now)
        n += 1
    return n


async def nightly(db: AsyncSession, now: datetime) -> int:
    """The nightly re-read (the scheduled ticker): every feature not read in the last
    20 hours, so a tick each few minutes reads each once a night."""
    return await reread_all(db, now, since=now - NIGHT)


async def _goals(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, str]:
    if not ids:
        return {}
    rows = await db.execute(
        select(Edge.src_id, Entity.title)
        .join(Entity, Entity.id == Edge.dst_id)
        .where(
            Edge.src_id.in_(ids),
            Edge.type == "supports",
            Edge.status != "rejected",
            Entity.type == "goal",
            Entity.status == "confirmed",
        )
        .order_by(Edge.src_id, Entity.key)
    )
    out: dict[uuid.UUID, str] = {}
    for src, title in rows:
        out.setdefault(src, title)
    return out


def _proof_out(p: FeatureProof, now: datetime) -> FeatureProofOut:
    note = NOT_READ_YET if p.kind == "measured" and _past_period(p.period, now) else None
    return FeatureProofOut(kind=p.kind, count=p.count, total=p.total, value=p.value,  # type: ignore[arg-type]
                           period=p.period, ok=p.ok, still_true=p.still_true,
                           checked_at=p.checked_at, note=note)  # fmt: skip


def _move_how(st: FeatureState | None) -> str | None:
    if not exists(st):
        return None
    assert st is not None
    if st.status == "current":
        return st.move_note or "owner_confirmed"
    return "marked_shipped"


async def outs(db: AsyncSession, features: list[Entity], now: datetime) -> list[FeatureStateOut]:
    ids = [f.id for f in features]
    if not ids:
        return []
    states = {
        s.feature_id: s
        for s in (
            await db.execute(select(FeatureState).where(FeatureState.feature_id.in_(ids)))
        ).scalars()
    }
    proofs: dict[uuid.UUID, list[FeatureProof]] = {}
    for p in (
        await db.execute(select(FeatureProof).where(FeatureProof.feature_id.in_(ids)))
    ).scalars():
        proofs.setdefault(p.feature_id, []).append(p)
    items = await _items(db, ids)
    tasks = await _tasks(db, [i for rows in items.values() for i in rows])
    item_feature = {i.id: fid for fid, rows in items.items() for i in rows}
    anchor_feature = {(i.roadmap_document_id, i.item_key): fid
                      for fid, rows in items.items() for i in rows}  # fmt: skip
    under_way: set[uuid.UUID] = set()
    for t in tasks:
        fid = item_feature.get(t.item_id) if t.item_id else None
        fid = fid or anchor_feature.get((t.roadmap_document_id, t.item_key))
        if fid is not None and t.status in UNDER_WAY:
            under_way.add(fid)
    goals = await _goals(db, ids)
    out = []
    for f in features:
        st = states.get(f.id)
        ps = sorted(proofs.get(f.id, []), key=lambda p: PROOF_KINDS.index(p.kind))
        milestone = next(
            (
                i.milestone.get("name")
                for i in items.get(f.id, [])
                if isinstance(i.milestone, dict) and i.milestone.get("name")
            ),
            None,
        )
        area = (f.attrs or {}).get("area")
        checked = st.checked_at if st else None
        out.append(
            FeatureStateOut(
                feature_id=f.id,
                code=f.key,
                title=f.title,
                area=area if isinstance(area, str) else None,
                goal=goals.get(f.id),
                milestone=milestone,
                mark=mark(st, ps, f.id in under_way, now),  # type: ignore[arg-type]
                shipped_at=st.shipped_at if st else None,
                checked_at=checked,
                proof_days=max(0, (now - checked).days) if checked else None,
                no_proof_yet=exists(st) and not ps,
                ready=ready(st, ps),
                checking=bool(st and st.checking),
                answer=st.answer if st else None,  # type: ignore[arg-type]
                answered_at=st.answered_at if st else None,
                moved_at=st.moved_at if st else None,
                move_how=_move_how(st),  # type: ignore[arg-type]
                proofs=[_proof_out(p, now) for p in ps],
                item_ids=[i.id for i in items.get(f.id, [])],
            )
        )
    return out


async def one(db: AsyncSession, f: Entity, now: datetime) -> FeatureStateOut:
    return (await outs(db, [f], now))[0]


async def listing(
    db: AsyncSession, now: datetime, *, can_move: bool, can_answer: bool
) -> FeatureStatesOut:
    features = list(
        (
            await db.execute(
                select(Entity)
                .where(Entity.type == "feature", Entity.status == "confirmed")
                .order_by(Entity.key)
            )
        ).scalars()
    )
    rows = await outs(db, features, now)
    marks = [r.mark for r in rows]
    in_progress, new = marks.count("in_progress"), marks.count("new")
    return FeatureStatesOut(
        features=rows,
        running=marks.count("exists") + marks.count("exists_old"),
        old_proof=marks.count("exists_old"),
        in_progress=in_progress,
        new=new,
        desired=in_progress + new,
        ready=sum(r.ready for r in rows),
        can_move=can_move,
        can_answer=can_answer,
    )


async def answer(
    db: AsyncSession, f: Entity, value: str, who: uuid.UUID | None, now: datetime
) -> None:
    st = await _state(db, f.id)
    st.answer, st.answered_at, st.answered_by = value, now, who
    if value == "still_runs":
        st.checked_at = now
    elif value == "no_longer_runs":
        st.status = "desired"
    await db.flush()


async def move(
    db: AsyncSession, f: Entity, decision: str, who: uuid.UUID | None, now: datetime
) -> None:
    st = await _state(db, f.id)
    if decision == "not_yet":
        st.not_yet_at = now
        await db.flush()
        return
    if not ready(st, await proofs_of(db, f.id)):
        raise NotReady
    st.status, st.moved_at, st.moved_by = "current", now, who
    st.move_note = "owner_confirmed"
    st.shipped_at = st.shipped_at or now
    st.checked_at = now
    st.answer = st.answered_at = st.answered_by = None
    await db.flush()


async def shipped(db: AsyncSession, f: Entity, now: datetime) -> None:
    st = await _state(db, f.id)
    if st.status != "current" or st.answer == "no_longer_runs":
        st.status = "shipped"
    st.shipped_at = now
    st.answer = st.answered_at = st.answered_by = None
    await db.flush()
