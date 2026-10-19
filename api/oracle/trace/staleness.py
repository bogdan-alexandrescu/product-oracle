"""Staleness (§7, §11.5): which downstream outputs a change may make stale, the
``trace.mark_stale`` change handler, and the human actions that settle staleness.

States, on each ``artifact_dependencies`` row (an artifact version's aggregate is the
worst of its rows):

- ``fresh``: nothing upstream changed since it was made or last confirmed;
- ``potentially_stale``: an upstream change may affect it (set by the handler, with
  ``caused_by_change_id`` and ``stale_since``);
- ``under_review``: a person is checking it, or accepted its regeneration proposal;
- ``reconciled``: a person confirmed it still holds against the current upstream (with
  a reason); the dependency is re-anchored on that upstream.

The handler only ever writes these freshness columns, the artifact's aggregate and a
``marked_stale`` review event. It never edits an artifact's content, status or
approval, nor a document version: approved outputs are never rewritten. Regeneration is
proposed (:mod:`oracle.trace.impact`) and makes a new version when a person runs it.

Which change reaches which dependency:

- ``document_version`` (an import): dependencies on that document whose section's
  content hash differs in the new version (or whose section is gone), and dependencies
  on a whole earlier version;
- ``document_section``: dependencies on that section, and on the whole document;
- ``requirement``, ``decision``, ``entity``, ``blocker_status``: the entity and
  everything downstream of it in the graph (:mod:`oracle.trace.graph`): dependencies on
  those entities, and on the document sections that link them;
- ``source_permission``: the evidence that came from the source's items, the entities it
  supports, and the sections that link either;
- ``composition_revision``: dependencies on the sections of the modules that changed
  since the parent revision, and on the whole document.
"""

import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.deps import Principal
from oracle.baseline.models import Entity, Evidence
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.models import AuditEvent
from oracle.sources.models import Source, SourceItem
from oracle.trace import graph as graph_mod
from oracle.trace.outputs import downstream_key, refresh_aggregates
from oracle.v2.models import (
    ArtifactDependency,
    ArtifactReviewEvent,
    ArtifactVersion,
    ChangeEvent,
    CompositionRevision,
    DocumentComposition,
    DocumentSectionLink,
)

HANDLER = "trace.mark_stale"
SUBJECTS = (
    "document_section",
    "document_version",
    "requirement",
    "decision",
    "entity",
    "blocker_status",
    "source_permission",
    "composition_revision",
)
ENTITY_SUBJECTS = ("requirement", "decision", "entity", "blocker_status")
# Section links that make a section depend on what they point at ("mentions" does not).
DEPENDING_LINKS = ("implements", "evidences", "claims", "tests")


class NotFound(LookupError):
    pass


class Invalid(ValueError):
    pass


class Conflict(RuntimeError):
    pass


@dataclass(frozen=True)
class Subject:
    """What changed: a recorded change event, or a hypothetical one for a preview."""

    kind: str
    id: uuid.UUID | None = None
    ref: str | None = None
    document_id: uuid.UUID | None = None
    data: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def of(cls, event: ChangeEvent) -> "Subject":
        return cls(event.subject_kind, event.subject_id, event.subject_ref, event.document_id,
                   dict(event.data or {}))  # fmt: skip


@dataclass
class Affected:
    """Dependencies a change reaches, each with its reasons; and the baseline entities
    downstream of it."""

    deps: dict[uuid.UUID, ArtifactDependency] = field(default_factory=dict)
    reasons: dict[uuid.UUID, list[str]] = field(default_factory=lambda: defaultdict(list))
    entity_ids: list[uuid.UUID] = field(default_factory=list)

    def add(self, dep: ArtifactDependency, reason: str) -> None:
        self.deps[dep.id] = dep
        if reason not in self.reasons[dep.id]:
            self.reasons[dep.id].append(reason)


def _label(e: Entity) -> str:
    return f"{e.type.replace('_', ' ')} {e.key}"


async def _deps_on_document(
    db: AsyncSession, document_id: uuid.UUID
) -> list[tuple[ArtifactDependency, DocumentVersion]]:
    rows = await db.execute(
        select(ArtifactDependency, DocumentVersion)
        .join(DocumentVersion, DocumentVersion.id == ArtifactDependency.upstream_version_id)
        .where(DocumentVersion.document_id == document_id)
        .order_by(ArtifactDependency.created_at, ArtifactDependency.id)
    )
    return [(dep, version) for dep, version in rows.all()]


async def _section_hashes(db: AsyncSession, version_ids: set[uuid.UUID]) -> dict:
    if not version_ids:
        return {}
    rows = await db.execute(
        select(Section.version_id, Section.section_key, Section.content_hash).where(
            Section.version_id.in_(version_ids)
        )
    )
    return {(v, k): h for v, k, h in rows.all()}


# --- what a change reaches ------------------------------------------------------------------


async def _by_document_version(db: AsyncSession, subject: Subject, out: Affected) -> None:
    new = await db.get(DocumentVersion, subject.id) if subject.id else None
    if new is None:
        return
    doc = await db.get(Document, new.document_id)
    rows = await _deps_on_document(db, new.document_id)
    hashes = await _section_hashes(db, {new.id} | {up.id for _, up in rows})
    where = f"{doc.slug} v{new.number}"
    for dep, up in rows:
        if dep.document_version_id == new.id or up.id == new.id or up.number > new.number:
            continue
        key = dep.upstream_section_key
        if key:
            old = dep.upstream_section_hash or hashes.get((up.id, key))
            now = hashes.get((new.id, key))
            if now is None and old is None:
                continue
            if now is None:
                out.add(dep, f"section {key} was removed in {where}")
            elif now != old:
                out.add(dep, f"section {key} changed in {where}")
        elif up.content_hash != new.content_hash:
            out.add(dep, f"{doc.slug} has a newer version, v{new.number} (depends on all of it)")


async def _by_document_section(db: AsyncSession, subject: Subject, out: Affected) -> None:
    key = subject.data.get("section_key")
    if not key and subject.ref and "#" in subject.ref:
        key = subject.ref.rsplit("#", 1)[1]
    if not key or subject.document_id is None:
        return
    after = subject.data.get("after_hash")
    doc = await db.get(Document, subject.document_id)
    for dep, _ in await _deps_on_document(db, subject.document_id):
        if dep.upstream_section_key == key:
            if after is None or dep.upstream_section_hash != after:
                out.add(dep, f"section {key} of {doc.slug} changed")
        elif dep.upstream_section_key is None:
            out.add(dep, f"section {key} of {doc.slug} changed (depends on all of it)")


async def _by_sections(
    db: AsyncSession, links: list[DocumentSectionLink], why: dict[uuid.UUID, str], out: Affected
) -> None:
    """Dependencies on the sections ``links`` belong to; ``why[link.id]`` says why.

    A link made on a version holds for that version and later ones (a dependency
    re-anchored on a newer version keeps what the section was linked to): when in
    doubt, mark (potentially stale is the safe side)."""
    by_doc: dict[uuid.UUID, list[DocumentSectionLink]] = defaultdict(list)
    for link in links:
        by_doc[link.document_id].append(link)
    version_ids = {link.version_id for link in links if link.version_id}
    numbers = {}
    if version_ids:
        numbers = dict(
            (
                await db.execute(
                    select(DocumentVersion.id, DocumentVersion.number).where(
                        DocumentVersion.id.in_(version_ids)
                    )
                )
            ).all()
        )
    for document_id, doc_links in by_doc.items():
        doc = await db.get(Document, document_id)
        for dep, up in await _deps_on_document(db, document_id):
            for link in doc_links:
                if link.version_id is not None and numbers.get(link.version_id, 0) > up.number:
                    continue
                if dep.upstream_section_key == link.section_key:
                    out.add(dep, f"section {link.section_key} of {doc.slug} {why[link.id]}")
                elif dep.upstream_section_key is None:
                    out.add(
                        dep,
                        f"section {link.section_key} of {doc.slug} {why[link.id]} "
                        "(depends on all of it)",
                    )


async def _by_entities(db: AsyncSession, roots: list[uuid.UUID], cause: str, out: Affected) -> None:
    g = await graph_mod.load(db)
    reason_of: dict[uuid.UUID, str] = {}
    for root in roots:
        entity = g.entities.get(root) or await db.get(Entity, root)
        label = _label(entity) if entity is not None else "a baseline item"
        reason_of.setdefault(root, f"{label} {cause}")
        for step in g.downstream(root):
            e = g.entities[step.entity_id]
            reason_of.setdefault(e.id, f"{_label(e)} is downstream of {label}, which {cause}")
    if not reason_of:
        return
    for e_id in reason_of:
        if e_id not in out.entity_ids and e_id not in roots:
            out.entity_ids.append(e_id)
    deps = (
        await db.scalars(
            select(ArtifactDependency).where(ArtifactDependency.upstream_entity_id.in_(reason_of))
        )
    ).all()
    for dep in deps:
        out.add(dep, reason_of[dep.upstream_entity_id])  # type: ignore[index]
    links = (
        await db.scalars(
            select(DocumentSectionLink).where(
                DocumentSectionLink.entity_id.in_(reason_of),
                DocumentSectionLink.kind.in_(DEPENDING_LINKS),
            )
        )
    ).all()
    why = {}
    for link in links:
        e = g.entities.get(link.entity_id)  # type: ignore[arg-type]
        name = _label(e) if e is not None else "a baseline item"
        why[link.id] = f"links {name}, which {cause}" if link.entity_id in roots else (
            f"links {name}, downstream of a change"
        )  # fmt: skip
    await _by_sections(db, list(links), why, out)


async def _by_source_permission(db: AsyncSession, subject: Subject, out: Affected) -> None:
    item_ids: set[uuid.UUID] = {uuid.UUID(str(i)) for i in subject.data.get("source_item_ids", [])}
    if subject.id is not None:
        if await db.get(Source, subject.id) is not None:
            item_ids |= set(
                (
                    await db.scalars(
                        select(SourceItem.id).where(SourceItem.source_id == subject.id)
                    )
                ).all()
            )
        else:
            item_ids.add(subject.id)
    if not item_ids:
        return
    evidence = (
        await db.execute(
            select(Evidence.id, Evidence.entity_id).where(Evidence.source_item_id.in_(item_ids))
        )
    ).all()
    evidence_ids = {e_id for e_id, _ in evidence}
    entity_ids = sorted({ent for _, ent in evidence if ent is not None})
    if entity_ids:
        await _by_entities(db, entity_ids, "rests on evidence whose source permission changed", out)
    conditions = [DocumentSectionLink.source_item_id.in_(item_ids)]
    if evidence_ids:
        conditions.append(DocumentSectionLink.evidence_id.in_(evidence_ids))
    links = (await db.scalars(select(DocumentSectionLink).where(or_(*conditions)))).all()
    why = {link.id: "cites evidence whose source permission changed" for link in links}
    await _by_sections(db, list(links), why, out)


def _module_sections(modules: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {m["key"]: m for m in modules or [] if "key" in m}


async def _by_composition(db: AsyncSession, subject: Subject, out: Affected) -> None:
    revision = await db.get(CompositionRevision, subject.id) if subject.id else None
    if revision is None:
        return
    comp = await db.get(DocumentComposition, revision.composition_id)
    document_id = comp.document_id if comp else subject.document_id
    if document_id is None:
        return
    parent_number = revision.parent_number or revision.number - 1
    parent = await db.scalar(
        select(CompositionRevision).where(
            CompositionRevision.composition_id == revision.composition_id,
            CompositionRevision.number == parent_number,
        )
    )
    changed: dict[str, str] | None = None  # section key -> module key; None: everything
    if parent is not None:
        changed = {}
        new, old = _module_sections(revision.modules), _module_sections(parent.modules)
        for key in set(new) | set(old):
            a, b = new.get(key, {}), old.get(key, {})
            fields = ("included", "version", "section_ids", "policy")
            if any(a.get(f) != b.get(f) for f in fields):
                for s in set(a.get("section_ids") or []) | set(b.get("section_ids") or []):
                    changed.setdefault(s, key)
    for s in subject.data.get("section_keys") or []:
        if changed is not None:
            changed.setdefault(s, "a module")
    doc = await db.get(Document, document_id)
    where = f"composition revision {revision.number} of {doc.slug}"
    for dep, _ in await _deps_on_document(db, document_id):
        key = dep.upstream_section_key
        if key is None:
            if changed is None or changed:
                out.add(dep, f"{where} changed its modules (depends on all of it)")
        elif changed is None:
            out.add(dep, f"{where} has no earlier revision to compare (section {key})")
        elif key in changed:
            out.add(dep, f"{where} changed module {changed[key]}, which renders section {key}")


async def affected(db: AsyncSession, subject: Subject) -> Affected:
    out = Affected()
    if subject.kind == "document_version":
        await _by_document_version(db, subject, out)
    elif subject.kind == "document_section":
        await _by_document_section(db, subject, out)
    elif subject.kind in ENTITY_SUBJECTS and subject.id is not None:
        cause = {
            "blocker_status": "changed status",
            "decision": "changed",
            "requirement": "changed",
        }.get(subject.kind, "changed")
        await _by_entities(db, [subject.id], cause, out)
    elif subject.kind == "source_permission":
        await _by_source_permission(db, subject, out)
    elif subject.kind == "composition_revision":
        await _by_composition(db, subject, out)
    return out


# --- derived dependencies of documents built from documents ----------------------------------


async def derive_document_dependencies(
    db: AsyncSession, version: DocumentVersion
) -> list[ArtifactDependency]:
    """A version built from another document's version (a roadmap from its PRD, O4b)
    depends on the sections it links (``/documents/<slug>/v/<n>#<section>``), or on the
    whole source version when it links none. Created once, fresh; never when the
    version already has dependencies (a lane recorded its own)."""
    from oracle.runs.roadmap import doc_links

    if version.source_version_id is None:
        return []
    has = await db.scalar(
        select(func.count())
        .select_from(ArtifactDependency)
        .where(ArtifactDependency.document_version_id == version.id)
    )
    if has:
        return []
    anchors: list[tuple[uuid.UUID, str | None]] = []
    for link in doc_links(version.markdown):
        target = await db.scalar(
            select(DocumentVersion)
            .join(Document, Document.id == DocumentVersion.document_id)
            .where(Document.slug == link["slug"], DocumentVersion.number == link["version"])
        )
        if target is None or target.id == version.id:
            continue
        anchor = (target.id, link["section"])
        if anchor not in anchors:
            anchors.append(anchor)
    if not anchors:
        anchors = [(version.source_version_id, None)]
    hashes = await _section_hashes(db, {v for v, _ in anchors})
    resolved: dict[tuple[uuid.UUID, str | None], str | None] = {}
    for version_id, key in anchors:
        h = hashes.get((version_id, key)) if key else None
        # A link to a section the version does not have: the whole version.
        resolved.setdefault((version_id, key if h else None), h)
    created = []
    for (version_id, key), h in resolved.items():
        dep = ArtifactDependency(
            document_version_id=version.id,
            upstream_version_id=version_id,
            upstream_section_key=key,
            upstream_section_hash=h,
            note="derived from the version's links to its source",
        )
        db.add(dep)
        created.append(dep)
    await db.flush()
    return created


async def _derive_for(db: AsyncSession, event: ChangeEvent) -> None:
    if event.subject_kind != "document_version" or event.subject_id is None:
        return
    new = await db.get(DocumentVersion, event.subject_id)
    if new is None:
        return
    await carry_links_forward(db, new)
    await derive_document_dependencies(db, new)
    # Older versions built from this document (imported before their links were traced).
    sourced = (
        await db.scalars(
            select(DocumentVersion).where(
                DocumentVersion.source_version_id.in_(
                    select(DocumentVersion.id).where(DocumentVersion.document_id == new.document_id)
                ),
                ~select(ArtifactDependency.id)
                .where(ArtifactDependency.document_version_id == DocumentVersion.id)
                .exists(),
            )
        )
    ).all()
    for version in sourced:
        await derive_document_dependencies(db, version)


# --- the change handler -----------------------------------------------------------------


async def carry_links_forward(db: AsyncSession, version: DocumentVersion) -> int:
    """Copy the previous version's section links onto ``version`` for every section
    whose content is unchanged (same hash): the same words make the same claims. A
    changed section's links stay on the version they were made on, for a person (or a
    drafting run) to link again."""
    previous = await db.scalar(
        select(DocumentVersion)
        .where(
            DocumentVersion.document_id == version.document_id,
            DocumentVersion.number < version.number,
        )
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )
    if previous is None:
        return 0
    hashes = await _section_hashes(db, {version.id})
    links = (
        await db.scalars(
            select(DocumentSectionLink).where(DocumentSectionLink.version_id == previous.id)
        )
    ).all()
    copied = 0
    for link in links:
        if link.section_hash is None or hashes.get((version.id, link.section_key)) != (
            link.section_hash
        ):
            continue
        db.add(
            DocumentSectionLink(
                document_id=link.document_id,
                version_id=version.id,
                section_key=link.section_key,
                section_hash=link.section_hash,
                composition_revision=link.composition_revision,
                module_key=link.module_key,
                kind=link.kind,
                entity_id=link.entity_id,
                evidence_id=link.evidence_id,
                source_item_id=link.source_item_id,
                precision=link.precision,
                claim=link.claim,
                created_by=link.created_by,
            )
        )
        copied += 1
    await db.flush()
    return copied


async def mark_stale(db: AsyncSession, event: ChangeEvent) -> None:
    """The ``trace.mark_stale`` handler: mark what the change reaches potentially_stale,
    with the change as its cause, and record exactly what was marked and why in
    ``event.data["trace"]``. On a version import it also carries unchanged sections'
    links forward and derives a roadmap version's dependencies on its PRD."""
    await _derive_for(db, event)
    found = await affected(db, Subject.of(event))
    now = datetime.now(UTC)
    marked = []
    by_output: dict[tuple[str, uuid.UUID], list[uuid.UUID]] = defaultdict(list)
    for dep_id, dep in found.deps.items():
        previous = dep.freshness
        dep.freshness = "potentially_stale"
        dep.caused_by_change_id = event.id
        if previous != "potentially_stale" or dep.stale_since is None:
            dep.stale_since = now
        marked.append({"id": str(dep_id), "previous": previous, "reasons": found.reasons[dep_id]})
        by_output[downstream_key(dep)].append(dep_id)
    await db.flush()
    await refresh_aggregates(db, {ident for kind, ident in by_output if kind == "artifact_version"})
    for (kind, ident), dep_ids in by_output.items():
        if kind != "artifact_version":
            continue
        reasons = [r for d in dep_ids for r in found.reasons[d]]
        db.add(
            ArtifactReviewEvent(
                version_id=ident,
                kind="marked_stale",
                body="; ".join(dict.fromkeys(reasons))[:2000],
                actor="system",
                data={
                    "change_event_id": str(event.id),
                    "caused_by": event.actor,
                    "dependency_ids": [str(d) for d in dep_ids],
                },
            )
        )
    event.data = {
        **(event.data or {}),
        "trace": {
            "dependency_ids": [m["id"] for m in marked],
            "marked": marked,
            "entity_ids": [str(e) for e in found.entity_ids],
            "outputs": [{"kind": k, "id": str(i)} for k, i in by_output],
        },
    }
    if marked:
        db.add(
            AuditEvent(
                actor="system",
                action="trace.marked_stale",
                entity="change_event",
                entity_id=event.id,
                data={
                    "caused_by": event.actor,
                    "subject_kind": event.subject_kind,
                    "dependencies": len(marked),
                    "outputs": len(by_output),
                },
            )
        )
    await db.flush()


# --- human actions ------------------------------------------------------------------------

FROM_STATES = {
    "review": ("potentially_stale",),
    "accept_regeneration": ("potentially_stale", "under_review"),
    "reconcile": ("potentially_stale", "under_review"),
}


async def _output(
    db: AsyncSession, artifact_version_id: uuid.UUID | None, document_version_id: uuid.UUID | None
):
    if artifact_version_id is not None:
        row = await db.get(ArtifactVersion, artifact_version_id)
        label = "Artifact version"
    else:
        row = await db.get(DocumentVersion, document_version_id)
        label = "Document version"
    if row is None:
        raise NotFound(f"{label} not found")
    return row


def _downstream_filter(artifact_version_id, document_version_id):
    if artifact_version_id is not None:
        return ArtifactDependency.artifact_version_id == artifact_version_id
    return ArtifactDependency.document_version_id == document_version_id


async def _reanchor(db: AsyncSession, dep: ArtifactDependency) -> dict[str, Any]:
    """Point a reconciled dependency at the upstream document's latest version."""
    before = {
        "upstream_version_id": str(dep.upstream_version_id) if dep.upstream_version_id else None,
        "upstream_section_hash": dep.upstream_section_hash,
    }
    if dep.upstream_version_id is None:
        return before
    up = await db.get(DocumentVersion, dep.upstream_version_id)
    if up is None:
        return before
    latest = await db.scalar(
        select(DocumentVersion)
        .where(DocumentVersion.document_id == up.document_id)
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )
    dep.upstream_version_id = latest.id
    if dep.upstream_section_key:
        dep.upstream_section_hash = await db.scalar(
            select(Section.content_hash).where(
                Section.version_id == latest.id, Section.section_key == dep.upstream_section_key
            )
        )
    return before


async def act(
    db: AsyncSession,
    principal: Principal,
    action: str,
    *,
    artifact_version_id: uuid.UUID | None,
    document_version_id: uuid.UUID | None,
    dependency_ids: list[uuid.UUID],
    reason: str | None,
) -> None:
    """Apply a person's review, regeneration acceptance or reconciliation. The caller
    commits. Raises NotFound, Invalid (unknown dependency ids) or Conflict (nothing in a
    state the action applies to)."""
    await _output(db, artifact_version_id, document_version_id)
    deps = (
        await db.scalars(
            select(ArtifactDependency)
            .where(_downstream_filter(artifact_version_id, document_version_id))
            .order_by(ArtifactDependency.created_at, ArtifactDependency.id)
        )
    ).all()
    if dependency_ids:
        known = {d.id for d in deps}
        if unknown := [str(i) for i in dependency_ids if i not in known]:
            raise Invalid(f"not dependencies of this output: {', '.join(unknown)}")
        deps = [d for d in deps if d.id in set(dependency_ids)]
    targets = [d for d in deps if d.freshness in FROM_STATES[action]]
    if not targets:
        states = sorted({d.freshness for d in deps}) or ["no dependencies"]
        raise Conflict(f"nothing to {action.replace('_', ' ')}: {', '.join(states)}")
    now = datetime.now(UTC)
    changed = []
    for dep in targets:
        entry: dict[str, Any] = {"id": str(dep.id), "from": dep.freshness}
        if action == "reconcile":
            entry["anchor_before"] = await _reanchor(db, dep)
            dep.freshness = "reconciled"
            dep.reconciled_by = principal.id
            dep.reconciled_at = now
        else:
            dep.freshness = "under_review"
        if reason:
            dep.note = reason
        entry["to"] = dep.freshness
        changed.append(entry)
    await db.flush()
    if artifact_version_id is not None:
        await refresh_aggregates(db, {artifact_version_id})
        db.add(
            ArtifactReviewEvent(
                version_id=artifact_version_id,
                kind="reconciled" if action == "reconcile" else "comment",
                body=reason,
                actor=principal.actor,
                data={"action": action, "dependencies": changed},
            )
        )
    await audit.record(
        db,
        principal,
        f"trace.staleness.{action}",
        "artifact_version" if artifact_version_id else "document_version",
        artifact_version_id or document_version_id,
        {"dependencies": changed, "reason": reason},
    )
    await db.flush()


# --- registering dependencies ---------------------------------------------------------------


async def add_dependencies(
    db: AsyncSession,
    principal: Principal,
    *,
    artifact_version_id: uuid.UUID | None,
    document_version_id: uuid.UUID | None,
    upstream: list[Any],
) -> list[ArtifactDependency]:
    """Record what an output was made from, anchored at each section's current hash.
    Idempotent: an anchor the output already depends on returns the existing row. The
    caller commits. Wave 2 lanes call this when they import an artifact version."""
    output = await _output(db, artifact_version_id, document_version_id)
    existing = (
        await db.scalars(
            select(ArtifactDependency).where(
                _downstream_filter(artifact_version_id, document_version_id)
            )
        )
    ).all()
    out: list[ArtifactDependency] = []
    created = 0
    for ref in upstream:
        if ref.entity_id is not None:
            if await db.get(Entity, ref.entity_id) is None:
                raise Invalid(f"unknown baseline entity {ref.entity_id}")
            match = next((d for d in existing if d.upstream_entity_id == ref.entity_id), None)
            fields: dict[str, Any] = {"upstream_entity_id": ref.entity_id}
        else:
            version = await db.get(DocumentVersion, ref.version_id)
            if version is None:
                raise Invalid(f"unknown document version {ref.version_id}")
            if isinstance(output, DocumentVersion) and version.id == output.id:
                raise Invalid("a version cannot depend on itself")
            h = None
            if ref.section_key is not None:
                h = await db.scalar(
                    select(Section.content_hash).where(
                        Section.version_id == version.id, Section.section_key == ref.section_key
                    )
                )
                if h is None:
                    raise Invalid(f"version has no section {ref.section_key!r}")
            match = next(
                (
                    d
                    for d in existing
                    if d.upstream_version_id == version.id
                    and d.upstream_section_key == ref.section_key
                ),
                None,
            )
            fields = {
                "upstream_version_id": version.id,
                "upstream_section_key": ref.section_key,
                "upstream_section_hash": h,
            }
        if match is None:
            match = ArtifactDependency(
                artifact_version_id=artifact_version_id,
                document_version_id=document_version_id,
                **fields,
            )
            db.add(match)
            existing = [*existing, match]
            created += 1
        if match not in out:
            out.append(match)
    await db.flush()
    if created:
        await audit.record(
            db,
            principal,
            "trace.dependencies.created",
            "artifact_version" if artifact_version_id else "document_version",
            artifact_version_id or document_version_id,
            {"created": created, "upstream": len(upstream)},
        )
    return out
