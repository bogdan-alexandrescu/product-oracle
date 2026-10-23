"""E1 Roadmap per PRD draft: an items-only roadmap for every PRD version.

Every imported PRD version queues a derivation (``draft_roadmaps``): the
``roadmap.draft_items`` change handler (:func:`on_prd_version`). The tick starts at most
one per PRD, the newest queued version first (:func:`start_due`): a run of flow
``prd_draft_items`` with no checkpoint, for whoever imported the version (or asked to
derive). When its segment ends, Oracle stores every item it can, with the check's
problems (:func:`store`); the Roadmap tab reads them (:func:`view`).

Draft items are ``roadmap_items`` rows with ``draft_roadmap_id`` set and no roadmap
version. They never go stale (the next draft derives again): staleness, tracker and
basis lookups only touch items of roadmap versions.
"""

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, safe_yaml
from oracle.auth.deps import Principal
from oracle.auth.models import ApiToken, User
from oracle.authz import has_role
from oracle.docs.models import Document, DocumentVersion
from oracle.roadmap import items as items_mod
from oracle.roadmap import views
from oracle.roadmap.models import DraftRoadmap, RoadmapItem
from oracle.roadmap.schemas import (
    DraftRoadmapOut,
    DraftRoadmapPrd,
    DraftRoadmapPrevious,
    DraftRoadmapSummary,
)
from oracle.v2.models import ChangeEvent

log = logging.getLogger(__name__)

HANDLER = "roadmap.draft_items"
FLOW = "prd_draft_items"
UNDER_WAY = ("queued", "running")
CANNOT_START = (
    "The person who imported this draft can no longer start runs. An approver can derive again."
)
# Problems that mean the file is not this draft's: nothing is stored.
REFUSED = ("wrong_prd", "missing_file", "unreadable_yaml")


class Conflict(RuntimeError):
    """409: the version's items are already being derived."""


def _now() -> datetime:
    return datetime.now(UTC)


async def _row(db: AsyncSession, version_id: uuid.UUID) -> DraftRoadmap | None:
    return await db.scalar(select(DraftRoadmap).where(DraftRoadmap.prd_version_id == version_id))


# --- queueing --------------------------------------------------------------------------------


async def on_prd_version(db: AsyncSession, event: ChangeEvent) -> None:
    """The ``roadmap.draft_items`` change handler: a new PRD version queues its items.
    Never raises: a failure is logged and the version's import goes on."""
    if event.cause != "version_imported" or event.subject_id is None or not event.document_id:
        return
    try:
        async with db.begin_nested():
            document = await db.get(Document, event.document_id)
            version = await db.get(DocumentVersion, event.subject_id)
            if document is None or version is None or document.kind != "prd":
                return
            await _queue(db, document, version, event)
    except safe_yaml.ParseBusy:
        raise  # the import gives up whole, the caller retries
    except Exception:  # noqa: BLE001 - logged; the PRD version still imports
        log.exception("draft roadmap items for %s were not queued", event.subject_ref)


async def _queue(
    db: AsyncSession, document: Document, version: DocumentVersion, event: ChangeEvent
) -> None:
    if (event.data or {}).get("template_only"):
        status = "skipped"
    elif not document.draft_roadmap_auto:
        status = "off"
    else:
        status = "queued"
    row = DraftRoadmap(
        prd_document_id=document.id,
        prd_version_id=version.id,
        status=status,
        requested_by=version.imported_by,
        requested_via="new_draft",
    )
    db.add(row)
    await db.flush()
    if status == "queued":
        # Latest draft wins: older drafts only queued automatically never start.
        older = await db.scalars(
            select(DraftRoadmap)
            .join(DocumentVersion, DocumentVersion.id == DraftRoadmap.prd_version_id)
            .where(
                DraftRoadmap.prd_document_id == document.id,
                DraftRoadmap.status == "queued",
                DraftRoadmap.requested_via == "new_draft",
                DocumentVersion.number < version.number,
            )
        )
        for old in older:
            old.status = "superseded"
    await audit.record(
        db, audit.ORACLE, f"draft_roadmap.{status}", "document_version", version.id,
        {"document_id": str(document.id), "number": version.number},
    )  # fmt: skip
    await db.flush()


async def derive(
    db: AsyncSession,
    principal: Principal,
    document: Document,
    version: DocumentVersion,
    depth: str = "standard",
) -> DraftRoadmap:
    """A person's Derive: the version's row queued again, for them; it supersedes
    nothing and is never superseded. The caller commits."""
    row = await _row(db, version.id)
    if row is not None and row.status in UNDER_WAY:
        raise Conflict(f"Roadmap items for v{version.number} are already being derived")
    if row is None:
        row = DraftRoadmap(prd_document_id=document.id, prd_version_id=version.id)
        db.add(row)
    row.status = "queued"
    row.requested_via = "derive"
    row.requested_by = principal.id
    row.depth = depth
    row.error = None
    row.run_id = None
    await db.flush()
    await audit.record(
        db, principal, "draft_roadmap.derive_requested", "document_version", version.id,
        {"document_id": str(document.id), "number": version.number, "depth": depth},
    )  # fmt: skip
    return row


# --- starting --------------------------------------------------------------------------------


async def _requester(db: AsyncSession, row: DraftRoadmap) -> Principal | None:
    """Who the run acts for, when they may still start runs (approver+, not disabled)."""
    from oracle.runs.service import _creator
    from oracle.tenancy import current_tenant

    user = await db.get(User, row.requested_by) if row.requested_by else None
    token = None if user or not row.requested_by else await db.get(ApiToken, row.requested_by)
    try:
        principal = _creator(current_tenant(db), user, token)
    except LookupError:
        return None
    return principal if has_role(principal.role, "approver") else None


async def start_due(db: AsyncSession) -> list[str]:
    """Start the derivations due: per PRD with queued rows and none running, the queued
    row of the highest version. One commit per started run; returns the errors."""
    from oracle.config import get_settings
    from oracle.runs import service as runs_service
    from oracle.runs.schemas import KnobsIn, RunCreate

    if not get_settings().draft_roadmaps_start:
        return []
    running = select(DraftRoadmap.prd_document_id).where(DraftRoadmap.status == "running")
    due = (
        await db.execute(
            select(DraftRoadmap.id, DraftRoadmap.prd_document_id)
            .join(DocumentVersion, DocumentVersion.id == DraftRoadmap.prd_version_id)
            .where(
                DraftRoadmap.status == "queued",
                DraftRoadmap.prd_document_id.not_in(running),
            )
            .order_by(DraftRoadmap.prd_document_id, DocumentVersion.number.desc())
        )
    ).all()
    first: dict[uuid.UUID, uuid.UUID] = {}
    for row_id, prd_id in due:
        first.setdefault(prd_id, row_id)
    await db.rollback()
    errors: list[str] = []
    for row_id in first.values():
        row = await db.get(DraftRoadmap, row_id, with_for_update=True)
        if row is None or row.status != "queued":
            await db.rollback()
            continue
        version = await db.get(DocumentVersion, row.prd_version_id)
        document = await db.get(Document, row.prd_document_id)
        if version is None or document is None:
            await db.rollback()
            continue
        principal = await _requester(db, row)
        if principal is None:
            row.status = "failed"
            row.error = CANNOT_START
            await db.commit()
            continue
        try:
            run_id = await runs_service.create_run(
                db,
                principal,
                RunCreate(
                    flow=FLOW,
                    source=document.slug,
                    source_version=version.number,
                    knobs=KnobsIn(depth=row.depth, checkpoints={"roadmap_items": False}),
                ),
                oracle_knobs={"draft_roadmap_id": str(row.id)},
                commit=False,
            )
            row.run_id = run_id
            await runs_service.estimate(db, principal, run_id)
            await runs_service.start(db, principal, run_id)
        except runs_service.RunError as exc:
            await db.rollback()
            row = await db.get(DraftRoadmap, row_id)
            if row is not None:
                row.status = "failed"
                row.error = f"Oracle could not start the derivation: {exc}"
                await db.commit()
            continue
        except Exception as exc:  # noqa: BLE001 - one PRD must not stop the others
            log.exception("starting the draft roadmap %s failed", row_id)
            await db.rollback()
            errors.append(f"draft roadmap {row_id}: {type(exc).__name__}")
            continue
        row = await db.get(DraftRoadmap, row_id)
        if row is not None and row.status == "queued":
            row.status = "running"
            await db.commit()
    return errors


# --- storing ---------------------------------------------------------------------------------


async def _of_run(db: AsyncSession, run: Any) -> DraftRoadmap | None:
    raw = (run.knobs or {}).get("draft_roadmap_id")
    if not raw:
        return None
    try:
        return await db.get(DraftRoadmap, uuid.UUID(str(raw)))
    except ValueError:
        return None


async def store(
    db: AsyncSession, run: Any, text: str | None, check: dict[str, Any]
) -> tuple[int, str | None]:
    """Store the run's roadmap_items.yaml as its draft's items, with the check's
    problems: (items stored, error). Nothing stored (no file, an unreadable or refused
    file, no items, or wrong_prd): the row is failed with the error. The caller commits."""
    row = await _of_run(db, run)
    if row is None or row.run_id not in (None, run.id):
        return 0, "the PRD draft's derivation was replaced"
    version = await db.get(DocumentVersion, row.prd_version_id)
    problems = list(check.get("problems") or [])
    error: str | None = None
    stored = 0
    refused = [p for p in problems if p.get("code") in REFUSED]
    if version is None:
        error = "the PRD version is gone"
    elif text is None:
        error = "the run left no roadmap_items.yaml"
    elif refused:
        error = "; ".join(str(p.get("message") or p.get("code")) for p in refused[:3])
    else:
        result = await items_mod.import_items(db, version, text, run_id=run.id, draft=row)
        stored = len(result.items)
        if not stored:
            error = "roadmap_items.yaml has no items that could be stored"
    if error:
        row.status = "failed"
        row.error = error
        return 0, error
    row.status = "ready"
    row.error = None
    row.items_check = check
    row.ready_at = _now()
    await db.flush()
    return stored, None


async def run_ended(db: AsyncSession, run: Any, error: str) -> None:
    """A prd_draft_items run failed or was cancelled: its draft roadmap is failed."""
    row = await _of_run(db, run)
    if row is None or row.run_id != run.id or row.status == "ready":
        return
    row.status = "failed"
    row.error = error


# --- reading ---------------------------------------------------------------------------------


async def draft_items(db: AsyncSession, row: DraftRoadmap) -> list[RoadmapItem]:
    return list(
        await db.scalars(
            select(RoadmapItem)
            .where(RoadmapItem.draft_roadmap_id == row.id)
            .order_by(RoadmapItem.position)
        )
    )


async def _counts(db: AsyncSession, row_ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    if not row_ids:
        return {}
    return dict(
        (
            await db.execute(
                select(RoadmapItem.draft_roadmap_id, func.count())
                .where(RoadmapItem.draft_roadmap_id.in_(row_ids))
                .group_by(RoadmapItem.draft_roadmap_id)
            )
        ).all()
    )


async def summary(db: AsyncSession, version: DocumentVersion) -> DraftRoadmapSummary:
    """The tab label's figures (VersionOut.draft_roadmap)."""
    row = await _row(db, version.id)
    if row is None:
        return DraftRoadmapSummary(status="none", items=0, problems=0)
    count = (await _counts(db, [row.id])).get(row.id, 0)
    problems = len((row.items_check or {}).get("problems") or []) if count else 0
    return DraftRoadmapSummary(status=row.status, items=count, problems=problems)  # type: ignore[arg-type]


async def _previous(
    db: AsyncSession, version: DocumentVersion
) -> tuple[DocumentVersion, DraftRoadmap] | None:
    found = (
        await db.execute(
            select(DocumentVersion, DraftRoadmap)
            .join(DraftRoadmap, DraftRoadmap.prd_version_id == DocumentVersion.id)
            .where(
                DocumentVersion.document_id == version.document_id,
                DocumentVersion.number < version.number,
                DraftRoadmap.status == "ready",
            )
            .order_by(DocumentVersion.number.desc())
            .limit(1)
        )
    ).first()
    return (found[0], found[1]) if found else None


async def view(
    db: AsyncSession, document: Document, version: DocumentVersion, view: str = "full"
) -> DraftRoadmapOut:
    """GET .../roadmap-items: the version's derivation and its items."""
    row = await _row(db, version.id)
    rows = await draft_items(db, row) if row is not None else []
    ctx = await views.ItemContext.load(db, rows)
    items = [
        views.item_out(i, ctx, view).model_copy(update={"engineering": [], "freshness": "fresh"})
        for i in rows
    ]
    previous = await _previous(db, version)
    prev_out = None
    if previous is not None:
        count = (await _counts(db, [previous[1].id])).get(previous[1].id, 0)
        prev_out = DraftRoadmapPrevious(
            version=previous[0].number, status=previous[1].status, items=count
        )
    return DraftRoadmapOut(
        prd=DraftRoadmapPrd(
            id=document.id,
            slug=document.slug,
            title=document.title,
            version=version.number,
            approved=version.approved_at is not None,
        ),
        status=row.status if row is not None else "none",  # type: ignore[arg-type]
        run_id=row.run_id if row is not None else None,
        requested_at=(row.updated_at or row.created_at) if row is not None else None,
        ready_at=row.ready_at if row is not None else None,
        error=row.error if row is not None else None,
        check=row.items_check if row is not None and rows else None,
        previous=prev_out,
        auto=document.draft_roadmap_auto,
        view=view,  # type: ignore[arg-type]
        items=items,
    )


async def latest_ready(
    db: AsyncSession, prd_document_id: uuid.UUID
) -> tuple[DraftRoadmap, list[RoadmapItem]] | None:
    """The newest ready draft roadmap of a PRD and its items (F1's "Proposed" rows, E3)."""
    row = await db.scalar(
        select(DraftRoadmap)
        .join(DocumentVersion, DocumentVersion.id == DraftRoadmap.prd_version_id)
        .where(DraftRoadmap.prd_document_id == prd_document_id, DraftRoadmap.status == "ready")
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )
    if row is None:
        return None
    return row, await draft_items(db, row)


async def known_items(
    db: AsyncSession, version: DocumentVersion
) -> tuple[str, list[dict[str, str]]]:
    """The items the agents keep the ids of: the nearest earlier ready draft's, then the
    latest approved roadmap version's items traced to this PRD; one per key."""
    known: dict[str, dict[str, str]] = {}
    sources: list[str] = []
    previous = await _previous(db, version)
    if previous is not None:
        for i in await draft_items(db, previous[1]):
            known.setdefault(i.item_key, {"id": i.item_key, "title": i.title, "horizon": i.horizon})
        sources.append(f"draft v{previous[0].number}")
    approved = await db.scalar(
        select(DocumentVersion)
        .where(
            DocumentVersion.approved_at.is_not(None),
            DocumentVersion.id.in_(
                select(RoadmapItem.roadmap_version_id).where(
                    RoadmapItem.prd_document_id == version.document_id,
                    RoadmapItem.roadmap_version_id.is_not(None),
                )
            ),
        )
        .order_by(DocumentVersion.approved_at.desc())
        .limit(1)
    )
    if approved is not None:
        for i in await views.version_items(db, approved):
            known.setdefault(i.item_key, {"id": i.item_key, "title": i.title, "horizon": i.horizon})
        sources.append(f"approved roadmap v{approved.number}")
    return ", ".join(sources), list(known.values())


# --- Build roadmap reuses them (part B, decided 2026-10-21, "Reuse items") ----------------


async def reusable(
    db: AsyncSession, version_id: uuid.UUID
) -> tuple[DraftRoadmap, list[RoadmapItem]] | None:
    """The PRD version's draft roadmap and its items when a Build roadmap run may reuse
    them: ``ready``, at least one item, and no ``wrong_prd`` problem."""
    row = await _row(db, version_id)
    if row is None or row.status != "ready":
        return None
    problems = (row.items_check or {}).get("problems") or []
    if any(p.get("code") == "wrong_prd" for p in problems):
        return None
    found = await draft_items(db, row)
    return (row, found) if found else None


def _declared(item: RoadmapItem, target: str) -> list[str]:
    """The keys the item's file named for ``target`` (a section link is derived again)."""
    return [
        str(t["key"])
        for t in item.trace or []
        if t.get("target") == target and t.get("via") == "declared" and t.get("key")
    ]


def _milestone_out(milestone: dict[str, Any] | None) -> dict[str, Any] | None:
    """A milestone as the file writes it: its date only when one was kept (a refused date
    is left out, so the reused file never proposes it again)."""
    if not milestone:
        return None
    out: dict[str, Any] = {"name": milestone.get("name")}
    if milestone.get("date"):
        out["date"] = str(milestone["date"])
        if milestone.get("date_source"):
            out["date_source"] = milestone["date_source"]
    return out


def items_yaml(slug: str, number: int, rows: list[RoadmapItem]) -> str:
    """The draft's items as ``roadmap_items.yaml`` (oracle.runs.roadmap's format), in their
    stored order, so a Build roadmap run's items stop opens on them."""
    items: list[dict[str, Any]] = []
    for i in rows:
        raw: dict[str, Any] = {
            "id": i.item_key,
            "title": i.title,
            "outcome": i.outcome or "",
            "horizon": i.horizon,
        }
        if (milestone := _milestone_out(i.milestone)) is not None:
            raw["milestone"] = milestone
        raw["depends_on"] = list(i.depends_on or [])
        if i.priority:
            raw["priority"] = i.priority
        if i.confidence:
            raw["confidence"] = i.confidence
        raw["prd_section"] = i.prd_section_key
        if feature := _declared(i, "feature"):
            raw["feature"] = feature[0]
        for field_name, target in (("requirements", "requirement"), ("blockers", "blocker")):
            if keys := _declared(i, target):
                raw[field_name] = keys
        if i.validation_gates:
            raw["validation_gates"] = i.validation_gates
        if i.economics:
            raw["economics"] = i.economics
        items.append(raw)
    data = {"version": 1, "prd": {"document": slug, "version": number}, "items": items}
    return safe_yaml.dump(data, sort_keys=False, allow_unicode=True)
