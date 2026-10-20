"""The impact explorer (§7, §11.5): for a change, the engineering specs, wireframes,
roadmaps, prototypes and acceptance tests that may need updating, why, and a targeted
regeneration plan.

Everything here reads. A plan is proposals only: a person accepts one through the
staleness actions (``accept_regeneration``), and regenerating makes a new version for
review; an approved output is never overwritten.
"""

import uuid
from collections import Counter

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.baseline.models import Entity
from oracle.docs.models import Document, DocumentVersion
from oracle.trace import staleness
from oracle.trace.outputs import describe, entity_ref
from oracle.trace.schemas import (
    ImpactReport,
    ImpactSubject,
    RegenerationProposal,
    TraceOutput,
)
from oracle.v2.models import ArtifactDependency, ChangeEvent
from oracle.v2.schemas import ChangeEventOut

ENTITY_SUBJECT = {"requirement": "requirement", "decision": "decision"}
INACTIVE = ("superseded", "rejected")


def subject_kind_of(entity: Entity) -> str:
    if entity.type == "constraint" and (entity.attrs or {}).get("blocker"):
        return "blocker_status"
    return ENTITY_SUBJECT.get(entity.type, "entity")


def _proposal(view: TraceOutput, subject_kind: str) -> RegenerationProposal | None:
    if view.status in INACTIVE:
        return None
    sections = sorted({d.upstream.section_key for d in view.dependencies if d.upstream.section_key})
    entities = sorted({d.upstream.entity.id for d in view.dependencies if d.upstream.entity})
    whole = [
        d.upstream.document_slug
        for d in view.dependencies
        if d.upstream.version_id and not d.upstream.section_key
    ]
    scope = []
    if sections:
        scope.append("sections " + ", ".join(sections))
    if entities:
        scope.append(f"{len(entities)} baseline item(s)")
    if whole and not sections:
        scope.append("the changes in " + ", ".join(sorted(set(filter(None, whole)))))
    scope_text = " and ".join(scope) or "what changed"
    keeps = (
        f"the current version (v{view.number}, approved) stays as it is"
        if view.approved
        else f"the current version (v{view.number}) stays as it is"
    )
    if subject_kind == "source_permission":
        action = "review"
        how = (
            f"Check the claims that relied on the changed source ({scope_text}); "
            f"regenerate only if they no longer hold. Nothing changes until you decide; {keeps}."
        )
    elif view.kind == "document_version" and view.category == "roadmap":
        action = "regenerate"
        how = (
            "Start a roadmap run from the approved PRD version (flow prd_to_roadmap), "
            f"focused on {scope_text}; it imports a new version for review, and {keeps} "
            "until a reviewer approves the new one."
        )
    else:
        action = "regenerate"
        label = (view.artifact_kind or view.category).replace("_", " ")
        how = (
            f"Propose a new version of this {label} covering only {scope_text}, from the "
            f"current upstream; {keeps} until a reviewer approves the new one."
        )
    return RegenerationProposal(
        kind=view.kind,
        category=view.category,
        artifact_version_id=view.artifact_version_id,
        document_version_id=view.document_version_id,
        title=view.title,
        action=action,  # type: ignore[arg-type]
        section_keys=sections,
        entity_ids=entities,
        reasons=view.reasons,
        approved=view.approved,
        keeps_approved_version=True,
        how=how,
    )


async def _report(
    db: AsyncSession,
    subject: ImpactSubject,
    subject_kind: str,
    deps: list[ArtifactDependency],
    reasons: dict[uuid.UUID, list[str]],
    entity_ids: list[uuid.UUID],
    *,
    change: ChangeEvent | None,
    preview: bool,
    changes: list[ChangeEvent] | None = None,
    truncated: bool = False,
) -> ImpactReport:
    views = await describe(db, deps, reasons)
    plan = [p for v in views if (p := _proposal(v, subject_kind)) is not None]
    entities = []
    if entity_ids:
        rows = (await db.scalars(select(Entity).where(Entity.id.in_(entity_ids)))).all()
        order = {e: i for i, e in enumerate(entity_ids)}
        entities = [entity_ref(e) for e in sorted(rows, key=lambda e: order[e.id])]
    counts = Counter(v.category for v in views)
    counts["total"] = len(views)
    counts["approved"] = sum(v.approved for v in views)
    return ImpactReport(
        subject=subject,
        change=ChangeEventOut.model_validate(change) if change is not None else None,
        changes=[ChangeEventOut.model_validate(c) for c in changes or []],
        preview=preview,
        affected=views,
        affected_entities=entities,
        plan=plan,
        counts=dict(counts),
        truncated=truncated,
    )


async def _subject_of_event(db: AsyncSession, event: ChangeEvent) -> ImpactSubject:
    title = None
    if event.subject_id is not None:
        if event.subject_kind in staleness.ENTITY_SUBJECTS:
            e = await db.get(Entity, event.subject_id)
            # A deleted entity: the title it had, as the change recorded it.
            title = e.title if e else ((event.data or {}).get("entity") or {}).get("title")
        elif event.subject_kind == "document_version":
            v = await db.get(DocumentVersion, event.subject_id)
            if v is not None:
                d = await db.get(Document, v.document_id)
                title = f"{d.title} v{v.number}"
    elif (event.data or {}).get("roots"):
        title = f"{len(event.data['roots'])} baseline items"
    return ImpactSubject(
        kind=event.subject_kind,
        id=event.subject_id,
        ref=event.subject_ref,
        title=title,
        document_id=event.document_id,
    )


async def for_change(db: AsyncSession, event: ChangeEvent) -> ImpactReport:
    """A recorded change: exactly what it marked and why (``data["trace"]``); a change
    recorded before the handler existed is computed now, as a preview."""
    recorded = (event.data or {}).get("trace")
    subject = await _subject_of_event(db, event)
    if recorded is not None:
        ids = [uuid.UUID(m["id"]) for m in recorded.get("marked", [])]
        reasons = {uuid.UUID(m["id"]): list(m.get("reasons", [])) for m in recorded["marked"]}
        deps = []
        if ids:
            deps = list(
                (
                    await db.scalars(
                        select(ArtifactDependency).where(ArtifactDependency.id.in_(ids))
                    )
                ).all()
            )
        entity_ids = [uuid.UUID(e) for e in recorded.get("entity_ids", [])]
        return await _report(
            db, subject, event.subject_kind, deps, reasons, entity_ids, change=event,
            preview=False, truncated=bool(recorded.get("truncated")),
        )  # fmt: skip
    found = await staleness.affected(db, staleness.Subject.of(event))
    return await _report(
        db, subject, event.subject_kind, list(found.deps.values()), found.reasons,
        found.entity_ids, change=event, preview=True, truncated=found.truncated,
    )  # fmt: skip


async def for_entity(db: AsyncSession, entity: Entity) -> ImpactReport:
    """What a change to this baseline item would reach (nothing is marked)."""
    kind = subject_kind_of(entity)
    found = await staleness.affected(db, staleness.Subject(kind, entity.id))
    subject = ImpactSubject(kind=kind, id=entity.id, ref=f"{entity.type}:{entity.key}",
                            title=entity.title)  # fmt: skip
    return await _report(
        db, subject, kind, list(found.deps.values()), found.reasons, found.entity_ids,
        change=None, preview=True, truncated=found.truncated,
    )  # fmt: skip


async def for_version(
    db: AsyncSession, document: Document, version: DocumentVersion
) -> ImpactReport:
    """What this version changes for outputs built on earlier versions, with the change
    events recorded against it."""
    found = await staleness.affected(
        db, staleness.Subject("document_version", version.id, document_id=document.id)
    )
    changes = (
        await db.scalars(
            select(ChangeEvent)
            .where(ChangeEvent.subject_kind == "document_version",
                   ChangeEvent.subject_id == version.id)
            .order_by(ChangeEvent.created_at)
        )
    ).all()  # fmt: skip
    subject = ImpactSubject(
        kind="document_version",
        id=version.id,
        ref=f"{document.slug}@{version.number}",
        title=f"{document.title} v{version.number}",
        document_id=document.id,
    )
    return await _report(
        db, subject, "document_version", list(found.deps.values()), found.reasons,
        found.entity_ids, change=None, preview=True, changes=list(changes),
        truncated=found.truncated,
    )  # fmt: skip
