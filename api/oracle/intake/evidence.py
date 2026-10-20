"""What an intake reads: its author's source items at the pinned snapshot (S4).

Built on ``oracle.sources.items`` (pinned reads) and ``oracle.confidence`` (scores); no
new connector or store. Source items stay visible to their owner only (S3 as built,
AUD-9): anyone else sees that a piece of evidence exists, its kind and its confidence,
never its title, link or text, unless the intake's author shared a finding citing it in
full (S6, ``oracle.intake.sharing``). A run token never sees an item's content as its
owner, even when it acts for the owner, and never reads raw any item an intake of its
user read while a finding of that intake is below "shared in full" (:func:`run_withheld`,
precomputed by :func:`record_reads`).

Everything read from a source is **untrusted data**: it is returned under
``data_excerpt`` with ``untrusted: true``, never placed in instructions, and every
retrieval query is audited (``intake.evidence_query``).
"""

import re
import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import Select, and_, delete, or_, select, tuple_
from sqlalchemy.dialects.postgresql import distinct_on
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import confidence
from oracle.auth.deps import Principal
from oracle.intake.schemas import EvidenceRef
from oracle.sources import items as source_items
from oracle.sources.models import Snapshot, Source, SourceItem, SourceItemVersion
from oracle.v2.models import ProductIntake

EXCERPT_CHARS = 400
# Freshness (0-1, oracle.confidence) at or below which pinned evidence counts as stale.
STALE_FRESHNESS = 0.35
# At most this many pinned items are read per analysis.
MAX_ITEMS = 500


@dataclass(frozen=True)
class PinnedItem:
    row: source_items.ItemRow
    confidence: float
    freshness: float

    @property
    def id(self) -> uuid.UUID:
        return self.row.item.id

    @property
    def text(self) -> str:
        return self.row.version.content if self.row.version is not None else ""

    @property
    def title(self) -> str | None:
        version = self.row.version
        return version.title if version is not None else self.row.item.title


def source_ids_of(intake: ProductIntake) -> list[uuid.UUID]:
    return [uuid.UUID(str(i)) for i in (intake.analysis or {}).get("source_ids") or []]


async def pinned_snapshot(db: AsyncSession, intake: ProductIntake) -> Snapshot | None:
    """The snapshot the intake reads now: the last one it pinned."""
    if not intake.source_snapshot_ids:
        return None
    return await db.get(Snapshot, intake.source_snapshot_ids[-1])


async def pinned_items(
    db: AsyncSession, intake: ProductIntake
) -> tuple[list[PinnedItem], Snapshot | None]:
    """The author's items (of the chosen sources) as they were at the pinned snapshot."""
    snapshot = await pinned_snapshot(db, intake)
    if snapshot is None or intake.author_id is None:
        return [], snapshot
    rows = await source_items.items_as_of(
        db, intake.author_id, snapshot.as_of, txn_snapshot=snapshot.txn_snapshot
    )
    chosen = set(source_ids_of(intake))
    if chosen:
        rows = [r for r in rows if r.item.source_id in chosen]
    settings = await source_items.confidence_settings(db)
    out = []
    for row in rows[:MAX_ITEMS]:
        score = source_items.item_confidence(row, settings, now=snapshot.as_of)
        freshness = float(score.breakdown.get("freshness", {}).get("value", 1.0))
        out.append(PinnedItem(row, score.confidence, freshness))
    return out, snapshot


def excerpt(text: str | None, limit: int = EXCERPT_CHARS) -> str | None:
    if text is None:
        return None
    text = re.sub(r"\s+", " ", text).strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def caller_user(principal: Principal | None) -> uuid.UUID | None:
    """The user whose own items the caller reads as their owner: never through a run
    token (S6: an agent run, the owner's own included, reads each finding at its
    sharing level only)."""
    if principal is None or principal.kind != "user" or principal.is_run:
        return None
    return principal.user_id


def _legacy_reads(analysis: dict) -> set[uuid.UUID]:
    """Every item an analysis stored before reads were recorded names (fail closed)."""
    out = {uuid.UUID(i) for i in analysis.get("relevant_item_ids") or []}
    out |= {uuid.UUID(s["item_id"]) for s in analysis.get("stale") or []}
    out |= {uuid.UUID(cl["item_id"]) for c in analysis.get("conflicts") or []
            for cl in c.get("claims") or []}  # fmt: skip
    return out


def read_item_ids(intake: ProductIntake) -> set[uuid.UUID]:
    """Every source item the intake's analysis and jobs read (``read_item_ids``: the
    relevant hits and what each model job was given), and whatever its findings cite.
    An intake analysed before reads were recorded: everything its analysis names."""
    analysis = intake.analysis or {}
    if "read_item_ids" in analysis:
        out = {uuid.UUID(i) for i in analysis["read_item_ids"]}
    else:
        out = _legacy_reads(analysis)
    for entry in (analysis.get("findings") or {}).values():
        out |= {uuid.UUID(i) for i in entry.get("source_item_ids") or []}
        out |= {uuid.UUID(i) for i in entry.get("evidence_ids") or []}
    return out


def note_reads(intake: ProductIntake, analysis: dict, item_ids) -> None:
    """Add ``item_ids`` to what the intake read, in ``analysis`` (the dict about to be
    stored): reads only accumulate, so a repin never makes earlier reads readable."""
    known = read_item_ids(intake)
    analysis["read_item_ids"] = sorted(str(i) for i in known | set(item_ids))


def withholds(intake: ProductIntake, gaps: list | None = None) -> bool:
    """Whether the intake withholds what it read from runs (S6, owner 2026-10-19):
    while any finding of it is below "shared in full", or (fail closed) it was analysed
    before findings or reads were recorded. ``gaps``: the intake's gaps; a model-written
    gap never registered as a model finding (written before S6) is private, so it
    withholds too, whatever the registered findings say."""
    from oracle.intake import sharing

    reg = sharing.registry(intake)
    if reg.unregistered or (reg.analysed and "read_item_ids" not in (intake.analysis or {})):
        # Analysed before findings, or before reads, were recorded: what it read is not
        # known for sure, so all it names stays withheld until it is analysed again.
        return True
    if reg.analysed and any(
        sharing.model_written(g) and (reg.get(str(g.id)) or {}).get("origin") != "model"
        for g in gaps or []
    ):
        return True
    return any(
        not sharing.is_open(e) and e.get("sharing", sharing.DEFAULT) != "full" for e in reg.values()
    )


def shared_full_ids(intake: ProductIntake) -> set[uuid.UUID]:
    """The items the intake's findings shared in full released (S6, owner 2026-10-19,
    freeze at sharing: what each cited when its author shared it): runs read them in
    full text, at the version released, unless an intake withholds them."""
    from oracle.intake import sharing

    return sharing.frozen_item_ids(sharing.registry(intake))


def unshared_ids(intake: ProductIntake) -> set[uuid.UUID]:
    """What the intake's findings shared in full cite but never released: items a later
    analysis added (or one whose version at the pin was not known). Withheld from runs
    until the author shares the finding again."""
    from oracle.intake import sharing

    reg = sharing.registry(intake)
    cited = {uuid.UUID(i) for entry in reg.values() for i in sharing.unshared_ids(entry)}
    return cited - sharing.frozen_item_ids(reg)


async def pinned_versions(
    db: AsyncSession, intake: ProductIntake, item_ids: list[str] | list[uuid.UUID]
) -> dict[str, str]:
    """Item id -> the version of it the intake read (at its pinned snapshot), for the
    author's items of ``item_ids`` still there: what sharing in full releases. An item
    with no version at the pin, deleted or not the author's is left out (withheld)."""
    snapshot = await pinned_snapshot(db, intake)
    ids = {uuid.UUID(str(i)) for i in item_ids}
    if snapshot is None or not ids or intake.author_id is None:
        return {}
    as_of, txn = snapshot.as_of, snapshot.txn_snapshot
    rows = await db.execute(
        select(SourceItemVersion.item_id, SourceItemVersion.id)
        .join(SourceItem, SourceItem.id == SourceItemVersion.item_id)
        .join(Source, Source.id == SourceItem.source_id)
        .where(
            SourceItemVersion.item_id.in_(ids),
            Source.owner_user_id == intake.author_id,
            SourceItem.deleted_at.is_(None),
            source_items.version_at_pin(as_of, txn),
        )
        .ext(distinct_on(SourceItemVersion.item_id))
        .order_by(SourceItemVersion.item_id, SourceItemVersion.fetched_at.desc())
    )
    return {str(item): str(version) for item, version in rows.all()}


async def _rewrite(db: AsyncSession, model: type, intake: ProductIntake, ids: set) -> None:
    """Make the intake's rows of ``model`` exactly ``ids``: stale rows go, new ones are
    inserted with ON CONFLICT DO NOTHING, so two writers recomputing the same intake at
    once never trip its unique constraint. ``ids``: item ids, or (item id, version id)
    pairs for ``intake_shared_items``."""
    from sqlalchemy.dialects.postgresql import insert

    paired = model.__tablename__ == "intake_shared_items"
    key = tuple_(model.item_id, model.version_id) if paired else model.item_id
    gone = delete(model).where(model.intake_id == intake.id)
    if ids:
        gone = gone.where(key.not_in(sorted(ids)))
    await db.execute(gone)
    if ids and intake.author_id is not None:
        rows = [
            {"id": uuid.uuid4(), "tenant_id": intake.tenant_id, "intake_id": intake.id,
             "user_id": intake.author_id,
             **({"item_id": i[0], "version_id": i[1]} if paired else {"item_id": i})}
            for i in sorted(ids)
        ]  # fmt: skip
        await db.execute(insert(model).values(rows).on_conflict_do_nothing())


async def record_reads(db: AsyncSession, intake: ProductIntake) -> None:
    """Rewrite the intake's rows of ``intake_withheld_items`` (everything it read while
    it withholds; once every finding is shared in full, what those findings cite but
    never released) and of ``intake_shared_items`` (the (item, version) pairs its
    findings shared in full released). Called wherever the analysis or a level
    changes."""
    from oracle.intake import engine, sharing
    from oracle.intake.models import IntakeSharedItem, IntakeWithheldItem

    await db.flush()
    author = intake.author_id is not None
    gaps = await engine.intake_gaps(db, intake.id)
    withheld: set[uuid.UUID] = set()
    if author:
        withheld = read_item_ids(intake) if withholds(intake, gaps) else unshared_ids(intake)
    await _rewrite(db, IntakeWithheldItem, intake, withheld)
    pairs = sharing.frozen_pairs(sharing.registry(intake)) if author else set()
    await _rewrite(db, IntakeSharedItem, intake, pairs)
    await db.flush()


def withheld_ids(user_id: uuid.UUID) -> Select:
    """SQL: the items ``user_id``'s runs may not read."""
    from oracle.intake.models import IntakeWithheldItem

    return select(IntakeWithheldItem.item_id).where(IntakeWithheldItem.user_id == user_id)


def readable_shared(intake_id: uuid.UUID | None = None) -> Select:
    """SQL: (item_id, version_id) of what any run reads in full text because a finding
    shared in full released it (S6, owner 2026-10-19), at the version released (the
    newest one released, if several were), less what an intake of the owner withholds
    (the intake rule always wins) and what was deleted upstream since. ``intake_id``:
    what that intake released only."""
    from oracle.intake.models import IntakeSharedItem, IntakeWithheldItem

    held = select(IntakeWithheldItem.id).where(
        IntakeWithheldItem.item_id == IntakeSharedItem.item_id,
        IntakeWithheldItem.user_id == IntakeSharedItem.user_id,
    )
    stmt = (
        select(IntakeSharedItem.item_id, IntakeSharedItem.version_id)
        .join(SourceItem, SourceItem.id == IntakeSharedItem.item_id)
        # The version must be one of that item's: a pair naming another item's version
        # never serves that text under this item.
        .join(
            SourceItemVersion,
            and_(
                SourceItemVersion.id == IntakeSharedItem.version_id,
                SourceItemVersion.item_id == IntakeSharedItem.item_id,
            ),
        )
        .where(~held.exists(), SourceItem.deleted_at.is_(None))
        .ext(distinct_on(IntakeSharedItem.item_id))
        .order_by(IntakeSharedItem.item_id, SourceItemVersion.fetched_at.desc())
    )
    if intake_id is not None:
        stmt = stmt.where(IntakeSharedItem.intake_id == intake_id)
    return stmt


async def run_withheld(db: AsyncSession, principal: Principal | None) -> set[uuid.UUID] | None:
    """Source items a run token may not read raw (S6, owner 2026-10-19): everything an
    intake of its user read while any finding of that intake is below "shared in full"
    (precomputed, one indexed query). None: not a run."""
    if principal is None or not principal.is_run:
        return None
    if principal.user_id is None:
        return set()
    return set((await db.scalars(withheld_ids(principal.user_id).distinct())).all())


def ever_frozen() -> Select:
    """SQL: the ids of every item a finding shared in full froze, as stored (deleted or
    withheld since included): a run reads none of them as its user's own item."""
    from oracle.intake.models import IntakeSharedItem

    return select(IntakeSharedItem.item_id)


def run_reads(intake_id: uuid.UUID | None = None) -> source_items.RunReads:
    """A run's reads (``items.RunReads``): what findings shared in full released (of
    ``intake_id`` only, if given), and every item ever frozen."""
    return source_items.RunReads(released=readable_shared(intake_id), frozen=ever_frozen())


def run_shared(principal: Principal | None) -> source_items.RunReads | None:
    """What a run reads in full text beyond its user's own items, and the only version
    it reads of those (its user's own included) whatever ``as_of`` it asks for; its
    user's own items ever frozen are read through ``released`` only. None for anyone
    but a run."""
    if principal is None or not principal.is_run:
        return None
    return run_reads()


async def run_include(db: AsyncSession, intake: ProductIntake) -> dict[uuid.UUID, uuid.UUID]:
    """What a run (its author's or anyone's) may search and be shown of the intake's
    items, item id -> the version released: what its findings shared in full released,
    less what any intake of the author withholds and what was deleted since. The same
    items and versions ``/v1/source-items/{id}`` and ``/v1/search`` give a run."""
    if intake.author_id is None:
        return {}
    return dict((await db.execute(readable_shared(intake.id))).all())  # type: ignore[arg-type]


async def released_versions(
    db: AsyncSession, pairs: set[tuple[uuid.UUID, uuid.UUID]]
) -> dict[uuid.UUID, uuid.UUID]:
    """Item id -> the newest version ``pairs`` released, for items not deleted since:
    what people are shown of a finding shared in full."""
    if not pairs:
        return {}
    rows = await db.execute(
        select(SourceItemVersion.item_id, SourceItemVersion.id)
        .join(SourceItem, SourceItem.id == SourceItemVersion.item_id)
        .where(
            SourceItemVersion.id.in_({v for _, v in pairs}),
            SourceItem.deleted_at.is_(None),
        )
        .ext(distinct_on(SourceItemVersion.item_id))
        .order_by(SourceItemVersion.item_id, SourceItemVersion.fetched_at.desc())
    )
    wanted = {i for i, _ in pairs}
    return {i: v for i, v in rows.all() if i in wanted}


async def refs(
    db: AsyncSession,
    item_ids: list[uuid.UUID] | set[uuid.UUID],
    principal: Principal | None,
    as_of: datetime | None,
    *,
    txn_snapshot: str | None = None,
    reveal: set[uuid.UUID] | frozenset[uuid.UUID] = frozenset(),
    released: dict[uuid.UUID, uuid.UUID] | None = None,
) -> dict[uuid.UUID, EvidenceRef]:
    """Evidence refs for source items, as they were at the pin, shown per visibility:
    to the item's owner (never through a run token), and for ``reveal`` (items of
    findings shared in full) to anyone. ``released``: the version sharing released of
    each revealed item, shown instead of the pinned one; a revealed item with none
    (deleted upstream since) is not shown."""
    if not item_ids:
        return {}
    rows = (
        await db.execute(
            select(SourceItem, Source)
            .join(Source, Source.id == SourceItem.source_id)
            .where(SourceItem.id.in_(set(item_ids)))
        )
    ).all()
    versions: dict[uuid.UUID, SourceItemVersion] = {}
    me = caller_user(principal)
    for item, source in rows:
        stmt = select(SourceItemVersion).where(SourceItemVersion.item_id == item.id)
        owner = me is not None and source.owner_user_id == me
        if released is not None and item.id in reveal and not owner:
            stmt = stmt.where(SourceItemVersion.id == released.get(item.id))
        elif as_of is not None:
            stmt = stmt.where(source_items.version_at_pin(as_of, txn_snapshot))
        version = await db.scalar(stmt.order_by(SourceItemVersion.fetched_at.desc()).limit(1))
        if version is not None:
            versions[item.id] = version
    settings = await source_items.confidence_settings(db)
    out: dict[uuid.UUID, EvidenceRef] = {}
    for item, source in rows:
        version = versions.get(item.id)
        owner = me is not None and source.owner_user_id == me
        shown = item.id in reveal and (released is None or item.id in released)
        visible = owner or (shown and item.deleted_at is None)
        # Anyone but the owner: as fresh as the version shown, never as the item
        # changed upstream since; an item they may not see scores neutral (S6).
        row = source_items.ItemRow(item, version if visible else None, source.kind)
        score = source_items.item_confidence(row, settings, now=as_of, released=not owner)
        out[item.id] = EvidenceRef(
            source_item_id=item.id,
            visible=visible,
            source_kind=source.kind,
            item_kind=item.kind,
            confidence=score.confidence,
            fetched_at=version.fetched_at if version is not None else None,
            title=(version.title if version is not None else item.title) if visible else None,
            # The link as shared or pinned (S6, links), never the item's current one.
            url=(version.url if version is not None else item.url) if visible else None,
            data_excerpt=excerpt(version.content if version else None) if visible else None,
        )
    return out


def aggregate(confidences: list[float]) -> float | None:
    """The combined confidence of independent items, kept below certainty."""
    value = confidence.aggregate(confidences)
    return None if value is None else min(0.95, value)


async def author_items(
    db: AsyncSession, intake: ProductIntake, item_ids: set[uuid.UUID]
) -> set[uuid.UUID]:
    """Which of ``item_ids`` come from the intake author's own sources."""
    if not item_ids or intake.author_id is None:
        return set()
    rows = await db.scalars(
        select(SourceItem.id)
        .join(Source, Source.id == SourceItem.source_id)
        .where(SourceItem.id.in_(item_ids), Source.owner_user_id == intake.author_id)
    )
    return set(rows.all())


async def new_since(
    db: AsyncSession, intake: ProductIntake, snapshot: Snapshot | None
) -> list[tuple[uuid.UUID, str]]:
    """(item id, new | changed | deleted) of the author's items since the pinned snapshot.

    "Since" is what had not committed when the pin was taken (pin stability). An item
    that was not in the pinned set and is deleted now was never seen: it is left out,
    not reported as deleted."""
    if snapshot is None or intake.author_id is None:
        return []
    as_of, txn = snapshot.as_of, snapshot.txn_snapshot
    owned = select(Source.id).where(Source.owner_user_id == intake.author_id)
    chosen = source_ids_of(intake)
    stmt = select(SourceItem).where(SourceItem.source_id.in_(owned))
    if chosen:
        stmt = stmt.where(SourceItem.source_id.in_(chosen))
    newer = select(SourceItemVersion.item_id).where(~source_items.version_at_pin(as_of, txn))
    deleted_since = and_(
        SourceItem.deleted_at.is_not(None), ~source_items.deleted_at_pin(as_of, txn)
    )
    stmt = stmt.where(
        ~source_items.deleted_at_pin(as_of, txn),
        or_(SourceItem.id.in_(newer), deleted_since),
    ).order_by(SourceItem.created_at, SourceItem.id)
    out = []
    for item in (await db.scalars(stmt)).all():
        before = await db.scalar(
            select(SourceItemVersion.id)
            .where(SourceItemVersion.item_id == item.id, source_items.version_at_pin(as_of, txn))
            .limit(1)
        )
        if item.deleted_at is not None:
            if before is not None:
                out.append((item.id, "deleted"))
            continue
        out.append((item.id, "changed" if before is not None else "new"))
    return out
