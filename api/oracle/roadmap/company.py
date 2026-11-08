"""one-roadmap-many-prds (the owner, Nov 4): the company has ONE roadmap, never one per PRD.

Many PRDs (one per area of focus) feed it; links between features stay within it.

- **The company roadmap** (:func:`active`, :func:`ensure`): a roadmap document with
  ``company_roadmap`` set, at most one not in Trash (a partial unique index). An owner or
  approver creates it empty (``POST /v1/roadmaps/company``, the first-run step); while one
  exists, Simple (Roadmap, Home, Priorities) reads it alone (:func:`feeding_ids`), and older
  per-PRD roadmaps stay readable as history. With none, every roadmap feeds Simple as before.
- **A PRD's roadmap run** writes the company roadmap's next version (oracle.runs.service's
  default target): its items file adds and updates only its own PRD's items, every other
  PRD's items are carried as they are from the latest version, approved or not
  (:func:`carry_other_prds`, from oracle.roadmap.items.import_items), so a second PRD's run
  merges onto the first one's draft and never overwrites it.
- **One team's queue** (:func:`queue`): every item on the company roadmap, across PRDs, in
  one capacity queue: team size x focus (the ``team_capacity`` setting) person-weeks a week;
  items in milestone order (Now before Next before Later, then the milestone's first place
  on the roadmap), then the company goal order (goal positions), then priority (highest
  first); an item never before the items it depends on, in any PRD.
  An item's effort is its declared ``effort_weeks`` (else 1 week).
- **A replaced PRD** (:func:`replace`): ``replaced_by`` names the PRDs that replace it; it is
  read-only (oracle.docs.service refuses a new version), its items no longer feed the
  roadmap, and its verified schedule bases follow their item to the PRD the item now sits
  under on the company roadmap (:func:`carry_bases`), with the note ``carried from <old
  PRD title>`` and their verified status; the old PRD keeps its own.
"""

import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import (
    DateTime,
    String,
    Uuid,
    and_,
    any_,
    event,
    func,
    literal,
    or_,
    select,
    true,
    union_all,
)
from sqlalchemy.dialects.postgresql import distinct_on
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import ORMExecuteState, Session, aliased

from oracle import audit, company_time
from oracle.auth.deps import Principal
from oracle.baseline.goal_order import goal_sort_key
from oracle.baseline.models import Edge, Entity
from oracle.docs.models import Document, DocumentVersion
from oracle.roadmap import codes
from oracle.roadmap.models import ProductTrack, RoadmapItem, ScheduleBasis

TITLE = "Product roadmap"
SLUG = "product-roadmap"
CAPACITY_KEY = "team_capacity"
DEFAULT_CAPACITY = {"team_size": 1, "focus": 1.0}
HORIZON_ORDER = {"now": 0, "next": 1, "later": 2}
CARRIED = "carried from {title}"


class CompanyError(Exception):
    status_code = 422


class Invalid(CompanyError):
    status_code = 422


class NotFound(CompanyError):
    status_code = 404


async def active(db: AsyncSession) -> Document | None:
    """The company's one roadmap not in Trash, if there is one."""
    return await db.scalar(
        select(Document).where(
            Document.company_roadmap.is_(True),
            Document.kind == "roadmap",
            Document.deleted_at.is_(None),
        )
    )


async def ensure(db: AsyncSession, principal: Principal) -> tuple[Document, bool]:
    """(the company roadmap, made now): made empty when none exists. The caller commits."""
    found = await active(db)
    if found is not None:
        return found, False
    slug, n = SLUG, 1
    while await db.scalar(select(Document.id).where(Document.slug == slug)) is not None:
        n += 1
        slug = f"{SLUG}-{n}"
    doc = Document(slug=slug, title=TITLE, kind="roadmap", status="draft", company_roadmap=True)
    db.add(doc)
    await db.flush()
    await audit.record(db, principal, "roadmap.company_created", "document", doc.id,
                       {"slug": slug})  # fmt: skip
    return doc, True


async def feeding_ids(db: AsyncSession, roadmap_ids: list[uuid.UUID]) -> list[uuid.UUID]:
    """Of ``roadmap_ids``, those that feed Simple: the company roadmap alone while there is
    one (older per-PRD roadmaps are history), else all of them."""
    # replaced-prd-history: a replaced PRD's own roadmap is history too, never fed.
    history = await history_roadmaps(db)
    roadmap_ids = [i for i in roadmap_ids if i not in history]
    company = await active(db)
    if company is None:
        return roadmap_ids
    return [i for i in roadmap_ids if i == company.id]


@dataclass(frozen=True)
class History:
    """replaced-prd-history (the owner, Nov 7): the replaced PRDs, their roadmaps and their
    tracks, read-only history. One rule everywhere: a PRD is history only while a live PRD
    (not in Trash) replaces it; when every replacement is in Trash it is live again."""

    # A replaced PRD -> the live PRDs that replace it.
    prds: dict[uuid.UUID, list[uuid.UUID]]
    # Each roadmap of replaced PRDs alone (built from their versions, or their track's
    # roadmap), never the company roadmap -> the live PRDs that replaced them.
    roadmaps: dict[uuid.UUID, list[uuid.UUID]]
    # The tracks of a replaced PRD or of its roadmap.
    tracks: frozenset[uuid.UUID]

    @property
    def ids(self) -> set[uuid.UUID]:
        return set(self.prds) | set(self.roadmaps)


NO_HISTORY = History({}, {}, frozenset())
_CACHE = "replaced_prd_history"


@event.listens_for(Session, "after_flush")
@event.listens_for(Session, "after_commit")
@event.listens_for(Session, "after_rollback")
@event.listens_for(Session, "after_soft_rollback")
def _forget(session: Session, *_: Any) -> None:
    session.info.pop(_CACHE, None)


@event.listens_for(Session, "do_orm_execute")
def _forget_on_write(state: ORMExecuteState) -> None:
    if not state.is_select:
        state.session.info.pop(_CACHE, None)


async def history(db: AsyncSession) -> History:
    """The read-only history, read once per session (one request: the Inbox's Simple
    approvals and track alerts share it) until the session writes or ends."""
    info = db.sync_session.info
    if (cached := info.get(_CACHE)) is None:
        cached = info[_CACHE] = await _read_history(db)
    return cached


async def _read_history(db: AsyncSession) -> History:
    by = aliased(Document)
    live = (
        select(func.array_agg(by.id))
        .where(by.id == any_(Document.replaced_by), by.deleted_at.is_(None))
        .correlate(Document)
        .scalar_subquery()
    )
    replaced: dict[uuid.UUID, list[uuid.UUID]] = {
        prd: [i for i in raw if i in set(alive or [])]
        for prd, raw, alive in (
            await db.execute(
                select(Document.id, Document.replaced_by, live).where(
                    Document.kind == "prd", Document.replaced_by != []
                )
            )
        ).all()
        if alive
    }
    if not replaced:
        return NO_HISTORY
    built = aliased(DocumentVersion)
    roadmap = and_(Document.kind == "roadmap", Document.company_roadmap.is_(False))
    sources = await db.execute(
        select(DocumentVersion.document_id, built.document_id)
        .join(built, built.id == DocumentVersion.source_version_id)
        .join(Document, Document.id == DocumentVersion.document_id)
        .where(roadmap)
    )
    tracks = (
        await db.execute(
            select(
                ProductTrack.id,
                ProductTrack.roadmap_document_id,
                ProductTrack.prd_document_id,
                roadmap,
            ).outerjoin(Document, Document.id == ProductTrack.roadmap_document_id)
        )
    ).all()
    prds: dict[uuid.UUID, set[uuid.UUID]] = {}
    for rm, prd in [*sources.all(), *((t[1], t[2]) for t in tracks if t[1] and t[3])]:
        prds.setdefault(rm, set()).add(prd)
    roadmaps = {
        rm: list(dict.fromkeys(i for p in sorted(ps, key=str) for i in replaced[p]))
        for rm, ps in prds.items()
        if ps <= replaced.keys()
    }
    ids = replaced.keys() | roadmaps.keys()
    return History(
        replaced,
        roadmaps,
        frozenset(t[0] for t in tracks if t[2] in ids or t[1] in ids),
    )


async def replaced_prd_ids(db: AsyncSession) -> set[uuid.UUID]:
    """The PRDs a live PRD replaces (:class:`History`): their items no longer feed the
    roadmap."""
    return set((await history(db)).prds)


async def history_roadmaps(db: AsyncSession) -> dict[uuid.UUID, list[uuid.UUID]]:
    """Each roadmap of replaced PRDs alone -> the PRDs that replaced them (:class:`History`):
    read-only history, as its PRD: no working draft, track or Inbox row in Simple, and every
    edit, approve and publish refused."""
    return (await history(db)).roadmaps


async def history_ids(db: AsyncSession) -> set[uuid.UUID]:
    """The replaced PRDs and their roadmaps (:class:`History`): read-only history."""
    return (await history(db)).ids


async def history_track_ids(db: AsyncSession) -> set[uuid.UUID]:
    """The tracks of a replaced PRD or of its roadmap: history, never in Simple's Tracks."""
    return set((await history(db)).tracks)


async def read_only(db: AsyncSession, doc: Document) -> str | None:
    """Why ``doc`` takes no edit, approval or publication (a replaced PRD or its roadmap),
    in plain words; None when it does."""
    if doc.kind not in ("prd", "roadmap") or (doc.kind == "prd" and not doc.replaced_by):
        return None
    found = await history(db)
    if doc.kind == "prd" and doc.id in found.prds:
        return f"{doc.title} is replaced and read-only"
    if doc.kind == "roadmap" and doc.id in found.roadmaps:
        return f"{doc.title} is the roadmap of a replaced PRD and read-only"
    return None


async def refs(db: AsyncSession, ids: list[uuid.UUID]) -> list[dict[str, Any]]:
    """{id, slug, title} of the documents ``ids``, in that order (those not found left out)."""
    if not ids:
        return []
    found = {
        d.id: d
        for d in await db.scalars(
            select(Document).where(Document.id.in_(ids), Document.deleted_at.is_(None))
        )
    }
    return [{"id": i, "slug": found[i].slug, "title": found[i].title} for i in ids if i in found]


@dataclass(frozen=True)
class OnRoadmap:
    """A feature the company roadmap knows: its title and the PRD it lives in (a new PRD,
    not imported yet: the run that writes it), and, for a roadmap item, its horizon and
    what it depends on."""

    title: str
    prd: str | None
    prd_id: uuid.UUID | None = None
    run_id: uuid.UUID | None = None
    horizon: str | None = None
    depends_on: tuple[str, ...] = ()

    @property
    def prd_name(self) -> str:
        """``Safety PRD``: the PRD's title, with PRD after it when it does not say so."""
        if not self.prd:
            return "another PRD"
        return self.prd if self.prd.lower().endswith("prd") else f"{self.prd} PRD"

    @property
    def label(self) -> str:
        """``Account health ledger (Safety PRD)``: the title with its PRD named."""
        return f"{self.title} ({self.prd_name})" if self.prd else self.title

    def other_than(self, prd_id: uuid.UUID | None, run_id: uuid.UUID | None = None) -> bool:
        """Held by another PRD than ``prd_id`` (a new PRD: another run than ``run_id``)."""
        if self.prd_id is not None:
            return self.prd_id != prd_id
        return self.run_id is not None and self.run_id != run_id


def _slug_words(slug: Any) -> str | None:
    return str(slug).replace("-", " ").replace("_", " ").capitalize() if slug else None


# The run statuses whose approved scope is not on the company roadmap: the run stopped
# before its PRD was written.
STOPPED_RUNS = ("cancelled", "failed")


async def features_on_roadmap(db: AsyncSession) -> dict[str, OnRoadmap]:
    """The features the company roadmap knows, by key (the owner, Nov 4: a PRD's feature may
    depend on one that lives in another area PRD): the included features of every PRD's
    latest approved scope of a run not cancelled or failed (a new PRD's too, before its
    import names its document, and before the company roadmap exists; a replaced PRD feeds
    nothing; a stopped update run's PRD falls back to the scope it superseded) and the
    items of the roadmap's latest version with items (an item's key and its feature's key,
    with its horizon and dependencies). One read: a check calls this once."""
    from oracle.runs.models import Run
    from oracle.runs.scope_models import PrdScope, PrdScopeItem

    company = (
        select(Document.id)
        .where(
            Document.company_roadmap.is_(True),
            Document.kind == "roadmap",
            Document.deleted_at.is_(None),
        )
        .scalar_subquery()
    )
    latest = (
        select(DocumentVersion.id)
        .where(
            DocumentVersion.document_id == company,
            DocumentVersion.id.in_(
                select(RoadmapItem.roadmap_version_id).where(
                    RoadmapItem.roadmap_document_id == company
                )
            ),
        )
        .order_by(DocumentVersion.number.desc())
        .limit(1)
        .scalar_subquery()
    )
    # Each PRD's latest scope ever approved (a new PRD's: its run's) of a run still live or
    # done: a cancelled or failed run's scope feeds nothing, and the scope its approval
    # superseded (an earlier finished run's) counts again.
    prd = func.coalesce(PrdScope.document_id, PrdScope.run_id)
    latest_scopes = (
        select(PrdScope.id)
        .ext(distinct_on(prd))
        .join(Run, Run.id == PrdScope.run_id)
        .where(
            PrdScope.status.in_(("approved", "superseded")),
            PrdScope.approved_at.is_not(None),
            Run.status.not_in(STOPPED_RUNS),
        )
        .order_by(prd, PrdScope.approved_at.desc().nulls_last(), PrdScope.created_at.desc())
    )
    scopes = (
        select(
            literal(0).label("src"),
            PrdScopeItem.key.label("key"),
            literal(None, String).label("feature_key"),
            PrdScopeItem.title.label("title"),
            literal(None, String).label("feature_title"),
            func.coalesce(Document.title, Run.knobs["document_slug"].astext).label("prd"),
            Document.id.label("prd_id"),
            PrdScope.run_id.label("run_id"),
            literal(None, String).label("horizon"),
            PrdScopeItem.depends_on.label("depends_on"),
            literal(0).label("place"),
            PrdScope.approved_at.label("at"),
            (Document.id.is_(None)).label("new"),
        )
        .join(PrdScope, PrdScope.id == PrdScopeItem.scope_id)
        .join(Run, Run.id == PrdScope.run_id)
        .outerjoin(Document, Document.id == PrdScope.document_id)
        .where(
            PrdScope.id.in_(latest_scopes),
            PrdScopeItem.kind == "feature",
            PrdScopeItem.decision == "include",
            or_(
                PrdScope.document_id.is_(None),
                and_(
                    Document.kind == "prd",
                    Document.deleted_at.is_(None),
                    Document.replaced_by == [],
                ),
            ),
        )
    )
    items = (
        select(
            literal(1).label("src"),
            RoadmapItem.item_key,
            Entity.key,
            RoadmapItem.title,
            Entity.title,
            Document.title,
            RoadmapItem.prd_document_id,
            literal(None, Uuid),
            RoadmapItem.horizon,
            RoadmapItem.depends_on,
            RoadmapItem.position,
            literal(None, DateTime(timezone=True)),
            literal(False),
        )
        .outerjoin(Entity, Entity.id == RoadmapItem.feature_id)
        .outerjoin(Document, Document.id == RoadmapItem.prd_document_id)
        .where(RoadmapItem.roadmap_version_id == latest)
    )
    both = union_all(scopes, items).subquery()
    rows = await db.execute(
        # An item first: it carries a horizon and the roadmap's own dependencies.
        select(both).order_by(both.c.src.desc(), both.c.at.desc().nulls_last(), both.c.place)
    )
    out: dict[str, OnRoadmap] = {}
    for (
        _,
        key,
        feature_key,
        title,
        feature_title,
        prd,
        prd_id,
        run_id,
        horizon,
        deps,
        _,
        _,
        new,
    ) in rows:
        name = _slug_words(prd) if new else prd
        deps = tuple(deps or ())
        if feature_key:
            out.setdefault(
                feature_key, OnRoadmap(feature_title or title, name, prd_id, run_id, horizon, deps)
            )
        out.setdefault(key, OnRoadmap(title, name, prd_id, run_id, horizon, deps))
    return out


async def keys_of_other_prds(
    db: AsyncSession, prd_id: uuid.UUID | None, run_id: uuid.UUID | None = None
) -> frozenset[str]:
    """The keys of the features and items other PRDs than ``prd_id`` hold on the company
    roadmap (:func:`features_on_roadmap`): what a PRD's roadmap item may depend on beyond
    its own items."""
    return frozenset(
        k for k, f in (await features_on_roadmap(db)).items() if f.other_than(prd_id, run_id)
    )


async def other_prds(
    db: AsyncSession, prd_id: uuid.UUID | None, run_id: uuid.UUID | None = None
) -> tuple[Any, ...]:
    """What a PRD's roadmap items may depend on beyond their own (the owner, Nov 4): each
    feature and item other PRDs than ``prd_id`` hold on the company roadmap, named with its
    PRD, with its horizon and dependencies (oracle.runs.roadmap.Elsewhere), by key."""
    return others_of(await features_on_roadmap(db), prd_id, run_id)


def others_of(
    features: dict[str, OnRoadmap], prd_id: uuid.UUID | None, run_id: uuid.UUID | None = None
) -> tuple[Any, ...]:
    """:func:`other_prds` of :func:`features_on_roadmap` read once."""
    from oracle.runs.roadmap import Elsewhere

    return tuple(
        Elsewhere(k, f.label, f.horizon, f.depends_on)
        for k, f in sorted(features.items())
        if f.other_than(prd_id, run_id)
    )


async def _latest_version(db: AsyncSession, document_id: uuid.UUID) -> DocumentVersion | None:
    return await db.scalar(
        select(DocumentVersion)
        .where(DocumentVersion.document_id == document_id)
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )


async def _items_version(
    db: AsyncSession, document_id: uuid.UUID, as_of: datetime | None = None
) -> DocumentVersion | None:
    """The company roadmap's latest version with items (the draft a run writes onto); with
    ``as_of``, the latest made by then."""
    return await db.scalar(
        select(DocumentVersion)
        .where(
            DocumentVersion.document_id == document_id,
            DocumentVersion.created_at <= as_of if as_of is not None else true(),
            DocumentVersion.id.in_(
                select(RoadmapItem.roadmap_version_id).where(
                    RoadmapItem.roadmap_document_id == document_id
                )
            ),
        )
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )


async def carry_other_prds(
    db: AsyncSession, version: DocumentVersion, prd_id: uuid.UUID | None, start: int
) -> int:
    """A company roadmap version written from one PRD keeps every other PRD's items as the
    latest earlier version with items has them (approved or still a draft). The caller
    flushes. Returns how many were carried."""
    from oracle.roadmap.items import COPIED

    previous = await db.scalar(
        select(DocumentVersion)
        .where(
            DocumentVersion.document_id == version.document_id,
            DocumentVersion.number < version.number,
            DocumentVersion.id.in_(
                select(RoadmapItem.roadmap_version_id).where(
                    RoadmapItem.roadmap_document_id == version.document_id
                )
            ),
        )
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )
    if previous is None:
        return 0
    rows = await db.scalars(
        select(RoadmapItem)
        .where(RoadmapItem.roadmap_version_id == previous.id)
        .order_by(RoadmapItem.position)
    )
    carried = 0
    for old in rows:
        if old.prd_document_id == prd_id:
            continue
        values = {c: getattr(old, c) for c in COPIED}
        values["position"] = start + carried
        carry = RoadmapItem(
            **values,
            milestone=old.milestone,
            roadmap_document_id=version.document_id,
            roadmap_version_id=version.id,
            note=old.note,
        )
        db.add(codes.copied_from(carry, roadmap_version_id=previous.id))
        carried += 1
    return carried


# --- one team's capacity queue -------------------------------------------------------


@dataclass
class Queued:
    item: RoadmapItem
    prd: dict[str, Any] | None
    effort_weeks: float
    start: date
    end: date
    order: tuple = ()


def _effort(item: RoadmapItem) -> float:
    economics = item.economics or {}
    for where in (economics.get("declared") or {}, economics.get("baseline") or {}):
        value = where.get("effort_weeks")
        if isinstance(value, int | float) and not isinstance(value, bool) and value > 0:
            return float(value)
    return 1.0


def _priority(item: RoadmapItem) -> float:
    score = (item.priority or {}).get("score")
    if score is None:
        score = (item.economics or {}).get("priority_score")
    return float(score) if isinstance(score, int | float) and not isinstance(score, bool) else 0.0


async def capacity(db: AsyncSession) -> dict[str, Any]:
    from oracle.tenant_settings_api import get_setting

    value = await get_setting(db, CAPACITY_KEY)
    return {**DEFAULT_CAPACITY, **(value if isinstance(value, dict) else {})}


async def queue(
    db: AsyncSession, as_of: datetime | None = None
) -> tuple[dict[str, Any], list[Queued]]:
    """(capacity, every item on the company roadmap planned as one team's queue); with
    ``as_of``, the roadmap as it was then."""
    cap = await capacity(db)
    company = await active(db)
    if company is None:
        return cap, []
    version = await _items_version(db, company.id, as_of)
    if version is None:
        return cap, []
    replaced = await replaced_prd_ids(db)
    rows = [
        r
        for r in await db.scalars(
            select(RoadmapItem)
            .where(RoadmapItem.roadmap_version_id == version.id)
            .order_by(RoadmapItem.position)
        )
        if r.prd_document_id not in replaced and r.plan_state is None
    ]
    # The company goal order: the first goal each item's feature supports.
    feature_ids = {r.feature_id for r in rows if r.feature_id}
    goal_of: dict[uuid.UUID, tuple] = {}
    if feature_ids:
        found = (
            await db.execute(
                select(Edge.src_id, Entity)
                .join(Entity, Entity.id == Edge.dst_id)
                .where(
                    Edge.src_id.in_(feature_ids),
                    Edge.type == "supports",
                    Edge.status != "rejected",
                    Entity.type == "goal",
                    Entity.status != "rejected",
                )
            )
        ).all()
        for src, goal in found:
            key = goal_sort_key(goal)
            if src not in goal_of or key < goal_of[src]:
                goal_of[src] = key
    rank = {key: n for n, key in enumerate(sorted(set(goal_of.values())))}
    places = [_place(r, rank.get(goal_of.get(r.feature_id)) if r.feature_id else None)
              for r in rows]  # fmt: skip
    orders = dict(zip(map(id, rows), _orders(places), strict=True))

    def order(r: RoadmapItem) -> tuple:
        return orders[id(r)]

    prds = {
        p["id"]: p
        for p in await refs(db, list({r.prd_document_id for r in rows if r.prd_document_id}))
    }
    per_week = _per_week(cap)
    today = await run_day(db, as_of)
    out: list[Queued] = []
    ordered = _after_dependencies(sorted(rows, key=order), await feature_keys_of(db, rows))
    for r, (start, end) in zip(ordered, _dates([_effort(r) for r in ordered], per_week, today),
                               strict=True):  # fmt: skip
        out.append(Queued(r, prds.get(r.prd_document_id), _effort(r), start, end, order(r)))
    return cap, out


async def feature_keys_of(db: AsyncSession, rows: list[RoadmapItem]) -> dict[uuid.UUID, str]:
    """The feature key of each item whose feature a dependency names instead of an item key
    (the checks accept either: a feature of another PRD); read only when one does."""
    item_keys = {r.item_key for r in rows}
    if all(d in item_keys for r in rows for d in r.depends_on or []):
        return {}
    ids = {r.feature_id for r in rows if r.feature_id}
    if not ids:
        return {}
    keys = dict((await db.execute(select(Entity.id, Entity.key).where(Entity.id.in_(ids)))).all())
    return {r.id: keys[r.feature_id] for r in rows if r.feature_id in keys}


def _resolve[T](
    rows: list[T], key: Callable[[T], str], feature_key: Callable[[T], str | None]
) -> dict[str, list[T]]:
    at: dict[str, list[T]] = {}
    for r in rows:
        at.setdefault(key(r), [r])
    by_feature: dict[str, list[T]] = {}
    for r in rows:
        if (k := feature_key(r)) is not None and k not in at:
            by_feature.setdefault(k, []).append(r)
    return {**by_feature, **at}


def resolve_dependencies(
    rows: list[RoadmapItem], feature_keys: dict[uuid.UUID, str]
) -> dict[str, list[RoadmapItem]]:
    """What each dependency key names: the item with that key, else the items of the feature
    with that key (:func:`feature_keys_of`), in ``rows``' order."""
    return _resolve(rows, lambda r: r.item_key, lambda r: feature_keys.get(r.id))


def _dependency_order[T](
    ordered: list[T],
    key: Callable[[T], str],
    depends_on: Callable[[T], list[str]],
    feature_key: Callable[[T], str | None],
) -> list[T]:
    """``ordered`` with each entry after the entries it depends on (by key, or by its
    feature's key); else as ordered. A cycle keeps the order it has."""
    at = _resolve(ordered, key, feature_key)
    out: list[T] = []
    placed: set[int] = set()
    visiting: set[int] = set()

    def place(r: T) -> None:
        if id(r) in placed or id(r) in visiting:
            return
        visiting.add(id(r))
        for dep in depends_on(r):
            for d in at.get(dep, ()):
                place(d)
        visiting.discard(id(r))
        placed.add(id(r))
        out.append(r)

    for r in ordered:
        place(r)
    return out


def _after_dependencies(
    ordered: list[RoadmapItem], feature_keys: dict[uuid.UUID, str] | None = None
) -> list[RoadmapItem]:
    """``ordered`` with each item after the items it depends on (by item key, or by its
    feature's key), whichever PRD they are in (the owner, Nov 4: a link between PRDs is
    real); else as ordered. A cycle keeps the order it has: the items check reports it
    (oracle.runs.roadmap, ``dependency_cycle``). :func:`with_run_items` orders a run's
    queue the same way (:func:`_dependency_order`)."""
    keys = feature_keys or {}
    return _dependency_order(ordered, lambda r: r.item_key, lambda r: r.depends_on or [],
                             lambda r: keys.get(r.id))  # fmt: skip


def _milestone_name(milestone: Any) -> str | None:
    """The name of an item's milestone (stored as {name, ...}; a run's file may name it
    alone)."""
    if isinstance(milestone, str):
        return milestone.strip() or None
    if isinstance(milestone, dict) and isinstance(milestone.get("name"), str):
        return milestone["name"].strip() or None
    return None


async def run_day(db: AsyncSession, as_of: datetime | None = None) -> date:
    """The company's day at ``as_of`` (a run's start), else today: a run's prompt and its
    check date the queue from the same day though the run crosses the company's midnight."""
    if as_of is None:
        return await company_time.company_today(db)
    return company_time.day(as_of, await company_time.company_time_zone(db))


def _place(item: RoadmapItem, goal: int | None) -> dict[str, Any]:
    """What an item's place in the queue is made of: its milestone, horizon and position,
    its rank in the company goal order (None: no goal) and its priority."""
    return {
        "milestone": _milestone_name(item.milestone),
        "horizon": HORIZON_ORDER.get(item.horizon, 3),
        "position": item.position,
        "goal": goal,
        "priority": _priority(item),
    }


def _orders(places: list[dict[str, Any]]) -> list[tuple]:
    """Each item's sort key in one team's queue, from :func:`_place`: items naming a
    milestone first, in the milestone's place (the horizon and position of its item that
    sits first on the roadmap), the rest in their own; then the goal order, then priority
    (highest first), then position. :func:`queue` and :func:`with_run_items` both order by
    it, so a run's plan tables are the queue once its file lands."""
    first: dict[str, tuple[int, int]] = {}
    for p in sorted(places, key=lambda p: p["position"]):
        if p["milestone"] and p["milestone"] not in first:
            first[p["milestone"]] = (p["horizon"], p["position"])
    out = []
    for p in places:
        place = first.get(p["milestone"]) if p["milestone"] else None
        out.append((
            place is None,
            place or (p["horizon"], p["position"]),
            (p["goal"] is None, p["goal"] or 0),
            -p["priority"],
            p["position"],
        ))  # fmt: skip
    return out


def _per_week(cap: dict[str, Any]) -> float:
    return max(float(cap["team_size"]) * float(cap["focus"]), 0.01)


def _dates(efforts: list[float], per_week: float, today: date) -> list[tuple[date, date]]:
    """(start, end) of each effort in turn, one team doing ``per_week`` person-weeks a week."""
    done, out = 0.0, []
    for effort in efforts:
        start = today + timedelta(days=round(done / per_week * 7))
        done += effort
        out.append((start, today + timedelta(days=round(done / per_week * 7))))
    return out


async def run_queue(
    db: AsyncSession, prd_id: uuid.UUID | None, as_of: datetime | None = None
) -> list[dict[str, Any]]:
    """What a PRD's roadmap run reads of the shared queue: every item on the company
    roadmap with its place in one team's queue ({key, title, prd, start, end, ours}); the
    other PRDs' items go into the draft's plan tables as they are (Dates from: team queue).
    ``as_of`` (the run's start): the roadmap as it was then, dated from the run's day."""
    return (await frozen_queue(db, prd_id, as_of))["rows"]


async def _feature_goals(db: AsyncSession) -> tuple[dict[str, int | None], dict[uuid.UUID, int]]:
    """Every feature's key -> its rank in the company goal order (the first goal it
    supports, over every goal; None: it supports none), and the same by feature id."""
    features = {
        e.key: e.id
        for e in await db.scalars(
            select(Entity).where(Entity.type == "feature", Entity.status != "rejected")
        )
    }
    found = (
        await db.execute(
            select(Edge.src_id, Entity)
            .join(Entity, Entity.id == Edge.dst_id)
            .where(
                Edge.type == "supports",
                Edge.status != "rejected",
                Entity.type == "goal",
                Entity.status != "rejected",
            )
        )
    ).all()
    rank = {key: n for n, key in enumerate(sorted({goal_sort_key(g) for _, g in found}))}
    by_id: dict[uuid.UUID, int] = {}
    for src, goal in found:
        by_id[src] = min(by_id.get(src, len(rank)), rank[goal_sort_key(goal)])
    return {k: by_id.get(i) for k, i in features.items()}, by_id


async def _section_features(
    db: AsyncSession, prd_version: DocumentVersion | None
) -> dict[str, str]:
    """Each section of the run's PRD version -> the key of the feature it links, the one
    landing traces an item naming that section to (oracle.roadmap.items.derive_traces)."""
    from oracle.docs.models import Section
    from oracle.roadmap.items import _linked_by_section

    if prd_version is None:
        return {}
    keys = set(await db.scalars(select(Section.section_key).where(
        Section.version_id == prd_version.id)))  # fmt: skip
    linked = await _linked_by_section(db, prd_version, keys)
    return {
        k: next(e.key for e in found if e.type == "feature")
        for k, found in linked.items()
        if any(e.type == "feature" for e in found)
    }


async def frozen_queue(
    db: AsyncSession,
    prd_id: uuid.UUID | None,
    as_of: datetime | None = None,
    prd_version: DocumentVersion | None = None,
) -> dict[str, Any]:
    """The shared queue as a run stores it once, when its first prompt is built (JSON):
    {rows: :func:`run_queue`'s rows, per_week: the team's capacity, today: the run's day,
    features: :func:`_feature_goals`' keys, sections: :func:`_section_features` of the
    run's PRD version ``prd_version``}; per_week and today are None without a company
    roadmap. The run's prompts, every rewrite and its check read this copy, though other
    PRDs' runs land or the capacity changes."""
    if await active(db) is None:
        return {"rows": [], "per_week": None, "today": None, "features": {}, "sections": {}}
    cap, queued = await queue(db, as_of)
    today = (await run_day(db, as_of)).isoformat()
    features, goal_of = await _feature_goals(db)
    ids = {q.item.feature_id for q in queued if q.item.feature_id}
    key_of = (
        dict((await db.execute(select(Entity.id, Entity.key).where(Entity.id.in_(ids)))).all())
        if ids
        else {}
    )
    rows = [
        {
            "key": q.item.item_key,
            "title": q.item.title,
            "prd": (q.prd or {}).get("title", ""),
            "start": q.start.isoformat(),
            "end": q.end.isoformat(),
            "ours": q.item.prd_document_id == prd_id,
            # What with_run_items plans the queue again from (see _place).
            "milestone": _milestone_name(q.item.milestone),
            "horizon": HORIZON_ORDER.get(q.item.horizon, 3),
            "position": q.item.position,
            "goal": goal_of.get(q.item.feature_id) if q.item.feature_id else None,
            "priority": _priority(q.item),
            # What it waits on, and its feature's key (another PRD's item may name either).
            "depends_on": list(q.item.depends_on or []),
            "feature_key": key_of.get(q.item.feature_id),
            "effort_weeks": q.effort_weeks,
            "per_week": _per_week(cap),
            "today": today,
        }
        for q in queued
    ]
    return {"rows": rows, "per_week": _per_week(cap), "today": today, "features": features,
            "sections": await _section_features(db, prd_version)}  # fmt: skip


def _run_entries(items: list[dict[str, Any]] | None) -> list[dict[str, Any]] | None:
    """The items of a run's file that landing stores, in file order (as import_items keeps
    them: a horizon, a title and an id not used before); None: no file, or one with no
    items that could be read."""
    from oracle.roadmap.models import HORIZONS
    from oracle.runs.roadmap import _text

    if not items:
        return None
    out, seen = [], set()
    for raw in items:
        key = str(raw.get("id"))
        if (_text(raw.get("horizon")) not in HORIZONS or not _text(raw.get("title"))
                or key in seen or key.startswith("#")):  # fmt: skip
            continue
        seen.add(key)
        out.append(raw)
    return out


def _run_feature(
    raw: dict[str, Any], features: dict[str, Any], sections: dict[str, str]
) -> str | None:
    """The key of the feature landing traces a file's item to (derive_traces): the one it
    declares, else the one its PRD section links, else the one keyed as the item."""
    from oracle.runs.roadmap import _text

    declared = raw.get("feature") if isinstance(raw.get("feature"), str) else None
    section = _text(raw.get("prd_section"))
    for key in (declared, sections.get(section) if section else None, _text(raw.get("id"))):
        if key and key in features:
            return key
    return None


def _run_goal(raw: dict[str, Any], features: dict[str, Any], sections: dict[str, str]) -> Any:
    """The goal rank of the feature landing traces a file's item to (:func:`_run_feature`)."""
    key = _run_feature(raw, features, sections)
    return features[key] if key is not None else None


def _keys(raw: Any) -> list[str]:
    """A file item's ``depends_on`` as keys (the check reports anything else)."""
    from oracle.runs.roadmap import _text

    return [k for k in (_text(d) for d in raw) if k] if isinstance(raw, list) else []


def with_run_items(
    rows: list[dict[str, Any]],
    items: list[dict[str, Any]] | None,
    *,
    per_week: float | None = None,
    today: str | None = None,
    features: dict[str, Any] | None = None,
    sections: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    """The shared queue with this run's items file in it, as :func:`queue` will plan it once
    the file lands: the run's PRD's rows are replaced by the file's items, which take
    positions 0..n-1 in file order (import_items), and every other PRD's item comes after
    them in its current order (carry_other_prds); each milestone's place and the order are
    :func:`_orders`', then each item after what it depends on (:func:`queue`'s
    :func:`_after_dependencies` step, across PRDs, by item key or feature key). ``items``:
    the file's items as its check read them
    (``ItemsCheck.items``, from oracle.runs.roadmap.check_items_async, kept per text): the
    file is never parsed here; none (a missing or unreadable file): the queue as it is.
    ``per_week`` and ``today`` (the run's frozen capacity and day, else the rows'): the
    run's own items are dated though the shared queue is empty. ``features`` and
    ``sections`` (:func:`frozen_queue`'s): the goal each item's feature serves and its
    key."""
    per_week = per_week or (rows[0]["per_week"] if rows and "per_week" in rows[0] else None)
    today = today or (rows[0]["today"] if rows and "today" in rows[0] else None)
    entries = _run_entries(items)
    if entries is None or not per_week or not today:
        return rows
    prd = next((r["prd"] for r in rows if r["ours"]), "")
    merged: list[dict[str, Any]] = []
    for raw in entries:
        # Landing stores the file's priority and declared economics alone, whether or not
        # the item was on the roadmap (its baseline economics never carry effort_weeks), and
        # traces the item to its feature again.
        item = RoadmapItem(horizon=raw.get("horizon"), position=len(merged),
                           milestone=raw.get("milestone"),
                           priority=raw["priority"] if isinstance(raw.get("priority"), dict)
                           else None,
                           economics={"declared": raw["economics"]}
                           if isinstance(raw.get("economics"), dict) else {})  # fmt: skip
        merged.append({"key": str(raw["id"]), "title": str(raw.get("title")).strip(),
                       "prd": prd, "ours": True, "effort_weeks": _effort(item),
                       "depends_on": _keys(raw.get("depends_on")),
                       "feature_key": _run_feature(raw, features or {}, sections or {}),
                       **_place(item, _run_goal(raw, features or {}, sections or {}))})  # fmt: skip
    for r in sorted((r for r in rows if not r["ours"]), key=lambda r: r["position"]):
        merged.append({**r, "position": len(merged)})
    orders = _orders(merged)
    ordered = _dependency_order(
        [r for _, r in sorted(zip(orders, merged, strict=True), key=lambda p: p[0])],
        lambda r: r["key"], lambda r: r.get("depends_on") or [], lambda r: r.get("feature_key"),
    )  # fmt: skip
    planned = _dates([r["effort_weeks"] for r in ordered], per_week, date.fromisoformat(today))
    return [
        {**r, "start": start.isoformat(), "end": end.isoformat(), "per_week": per_week,
         "today": today}
        for r, (start, end) in zip(ordered, planned, strict=True)
    ]  # fmt: skip


def queue_lines(rows: list[dict[str, Any]]) -> list[str]:
    """The shared queue in the run's prompt, dates month first."""
    if not rows:
        return []
    out = [
        "",
        "The company roadmap is one roadmap that every PRD feeds, planned as one team's "
        "queue (team size x focus, milestone order, then the company goal order, then "
        "priority). Each item's place in that queue (yours are marked *):",
    ]
    for r in rows:
        mark = "*" if r["ours"] else "-"
        start, end = (company_time.calendar_day_with_year(r[k]) for k in ("start", "end"))
        out.append(f"{mark} {r['title']} ({r['prd']}): {start} to {end}")
    out.append(
        "Add or change only this PRD's items; every other PRD's item stays as it is, and "
        "the plan tables list it as below."
    )
    return out


# --- a replaced PRD ------------------------------------------------------------------


async def replace(
    db: AsyncSession, principal: Principal, prd: Document, slugs: list[str]
) -> list[ScheduleBasis]:
    """Mark ``prd`` replaced by the PRDs ``slugs`` (in order; empty: no longer replaced) and
    carry its verified bases to the PRDs its items now sit under. The caller commits."""
    if prd.kind != "prd":
        raise Invalid("only a PRD can be replaced")
    by: list[Document] = []
    for slug in dict.fromkeys(slugs):
        doc = await db.scalar(
            select(Document).where(Document.slug == slug, Document.deleted_at.is_(None))
        )
        if doc is None or doc.kind != "prd":
            raise Invalid(f"'{slug}' is not a PRD")
        if doc.id == prd.id:
            raise Invalid("a PRD cannot replace itself")
        if doc.replaced_by:
            raise Invalid(f"{doc.title} is itself replaced")
        by.append(doc)
    before = list(prd.replaced_by or [])
    prd.replaced_by = [d.id for d in by]
    await audit.record(db, principal, "document.replaced_by", "document", prd.id,
                       {"before": [str(i) for i in before],
                        "after": [str(d.id) for d in by]})  # fmt: skip
    await db.flush()
    return await carry_bases(db, prd)


async def carry_bases(db: AsyncSession, old: Document) -> list[ScheduleBasis]:
    """The verified bases of the replaced PRD ``old`` scoped to an item follow that item to
    the replacing PRD it sits under on the company roadmap (the latest version with items),
    once each: same reference, kind, date and item, still verified, with the note
    ``carried from <old title>``. The old PRD keeps its own."""
    if not old.replaced_by:
        return []
    company = await active(db)
    version = await _items_version(db, company.id) if company else None
    if version is None:
        return []
    under: dict[str, uuid.UUID] = {}
    for r in await db.scalars(
        select(RoadmapItem).where(
            RoadmapItem.roadmap_version_id == version.id,
            RoadmapItem.prd_document_id.in_(old.replaced_by),
        )
    ):
        under.setdefault(r.item_key, r.prd_document_id)
    if not under:
        return []
    note = CARRIED.format(title=old.title)
    made: list[ScheduleBasis] = []
    for b in await db.scalars(
        select(ScheduleBasis).where(
            ScheduleBasis.prd_document_id == old.id,
            ScheduleBasis.status == "verified",
            ScheduleBasis.item_key.in_(list(under)),
        )
    ):
        target = under[b.item_key]
        exists = await db.scalar(
            select(ScheduleBasis.id).where(
                ScheduleBasis.prd_document_id == target,
                ScheduleBasis.item_key == b.item_key,
                ScheduleBasis.reference == b.reference,
                ScheduleBasis.supports_date == b.supports_date,
                ScheduleBasis.status == "verified",
            )
        )
        if exists is not None:
            continue
        row = ScheduleBasis(
            kind=b.kind,
            reference=b.reference,
            supports_date=b.supports_date,
            detail=f"{b.detail} ({note})" if b.detail else note,
            prd_document_id=target,
            item_key=b.item_key,
            status=b.status,
            verified_by=b.verified_by,
            verified_at=b.verified_at,
        )
        db.add(row)
        made.append(row)
    await db.flush()
    return made


async def carry_for_version(db: AsyncSession, version: DocumentVersion) -> None:
    """After a company roadmap version's items are stored: the bases of every replaced PRD
    whose items moved onto a replacing PRD follow them."""
    company = await active(db)
    if company is None or company.id != version.document_id:
        return
    for old in await db.scalars(
        select(Document).where(Document.kind == "prd", Document.replaced_by != [])
    ):
        await carry_bases(db, old)
