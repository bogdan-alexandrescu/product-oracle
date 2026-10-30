"""Staleness (§7, §11.5): which downstream outputs a change may make stale, the
``trace.mark_stale`` change handler, and the human actions that settle staleness.

States, on each ``artifact_dependencies`` row (an artifact version's aggregate is the
worst of its rows):

- ``fresh``: nothing upstream changed since it was made or last confirmed;
- ``potentially_stale``: an upstream change may affect it (set by the handler, with
  ``caused_by_change_id`` and ``stale_since``);
- ``under_review``: a person is checking it, or accepted its regeneration proposal;
- ``reconciled``: a person confirmed it still holds against the current upstream (with
  a reason); the dependency is re-anchored on that upstream. One whose upstream entity
  was deleted has nothing to re-anchor on: reconciled, it is settled for good.

The handler only ever writes these freshness columns, the artifact's aggregate and a
``marked_stale`` review event. It never edits an artifact's content, status or
approval, nor a document version: approved outputs are never rewritten. Regeneration is
proposed (:mod:`oracle.trace.impact`) and makes a new version when a person runs it.

Which change reaches which dependency:

- ``document_version`` (an import): dependencies on that document whose section's
  content hash differs in the new version (or whose section is gone), and dependencies
  on a whole earlier version;
- ``document_section``: dependencies on that section, and on the whole document;
- ``requirement``, ``decision``, ``entity``, ``blocker_status``: the entity (or, for a
  batch, each of ``data["roots"]``) and everything downstream of it in the graph
  (:mod:`oracle.trace.graph`, a scoped walk that flags truncation): dependencies on those
  entities, and on the document sections that link them. A root that was rejected or
  deleted also reaches the wholes it was part of or verified (``part_of``, ``verifies``),
  and what is downstream of those wholes (a sibling part and its criteria); an edge
  change reaches the wholes in ``data["wholes"]``. A deleted root's dependencies stay,
  potentially stale, with a snapshot of what they pointed at. A deleted root also
  reaches the sections whose links cite the evidence it takes with it (its own and its
  edges', ``data["evidence_ids"]``), and the links it leaves with no target are kept in
  ``data["trace"]["links"]``;
- ``source_permission``: evidence and the sources behind it. With cause
  ``source_permission`` (subject: a source or source item) or ``source_deleted``
  (subject: a source, recorded before it is deleted), the evidence that came from its
  items; with ``evidence_deleted`` (subject: the evidence, recorded before it is
  deleted), that evidence. Then the entities the evidence supports (an edge's evidence:
  the edge's downstream end) and everything downstream of them, and the sections whose
  links cite the evidence or the items. A link that keeps another target (an entity, or
  the evidence an item backed) only drops the deleted one; a link left with no target
  is deleted, and ``data["trace"]["links"]`` keeps what it was. Dependencies never
  point at evidence or source items, so no dependency row goes with them;
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
from oracle.baseline.models import Edge, Entity, Evidence
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.models import AuditEvent
from oracle.sources.models import Source, SourceItem
from oracle.trace import graph as graph_mod
from oracle.trace.outputs import downstream_key, refresh_aggregates
from oracle.v2.links import left_without_target
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
# A root that leaves the graph changes the wholes it was part of or verified.
REMOVALS = ("entity_rejected", "entity_deleted")
WHOLE_EDGES = ("part_of", "verifies")
EDGE_VERBS = {"edge_created": "gained", "edge_deleted": "lost", "edge_updated": "had a change to"}
# source_permission causes, and why a section link citing the evidence (or item) is reached.
EVIDENCE_CAUSES = {
    "source_permission": "cites evidence whose source permission changed",
    "evidence_deleted": "cites evidence that was deleted",
    "source_deleted": "cites evidence or a source item whose source was deleted",
}
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
    cause: str | None = None

    @classmethod
    def of(cls, event: ChangeEvent) -> "Subject":
        return cls(event.subject_kind, event.subject_id, event.subject_ref, event.document_id,
                   dict(event.data or {}), event.cause)  # fmt: skip


@dataclass(frozen=True)
class Root:
    """One baseline entity a change starts from, and why."""

    id: uuid.UUID
    cause: str
    edge: dict[str, Any] | None = None
    wholes: tuple[uuid.UUID, ...] = ()

    @property
    def text(self) -> str:
        """``<label> <text>``: what happened to it, in words."""
        if self.cause in EDGE_VERBS:
            kind = str((self.edge or {}).get("type") or "graph").replace("_", " ")
            return f"{EDGE_VERBS[self.cause]} a {kind} link"
        return {
            "entity_deleted": "was deleted",
            "entity_rejected": "was rejected",
            "entity_confirmed": "was confirmed",
            "source_permission": "rests on evidence whose source permission changed",
            "evidence_deleted": "lost evidence it rested on",
            "source_deleted": "rests on evidence whose source was deleted",
            "blocker_status": "changed status",
        }.get(self.cause, "changed")


def _uuid(value: Any) -> uuid.UUID:
    return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))


def roots_of(subject: Subject) -> list[Root]:
    """The entities an entity-kind change starts from: its subject, or a batch's roots
    (``data["roots"]``, recorded once per subject kind by a bulk write)."""
    if subject.kind not in ENTITY_SUBJECTS:
        return []
    if subject.kind == "blocker_status" and subject.cause == "entity_updated":
        subject = Subject(**{**subject.__dict__, "cause": "blocker_status"})
    out = []
    for r in subject.data.get("roots") or []:
        out.append(
            Root(_uuid(r["id"]), r.get("cause") or subject.cause or "", r.get("edge"),
                 tuple(_uuid(w) for w in r.get("wholes") or []))
        )  # fmt: skip
    if subject.id is not None and all(r.id != subject.id for r in out):
        out.insert(
            0,
            Root(subject.id, subject.cause or "", subject.data.get("edge"),
                 tuple(_uuid(w) for w in subject.data.get("wholes") or [])),
        )  # fmt: skip
    return out


@dataclass
class Affected:
    """Dependencies a change reaches, each with its reasons; and the baseline entities
    downstream of it."""

    deps: dict[uuid.UUID, ArtifactDependency] = field(default_factory=dict)
    reasons: dict[uuid.UUID, list[str]] = field(default_factory=lambda: defaultdict(list))
    entity_ids: list[uuid.UUID] = field(default_factory=list)
    # A graph walk stopped at a bound: more may be affected than listed.
    truncated: bool = False
    # Section links that reached a dependency and are about to go (a deleted evidence or
    # source item leaves them with no target): what they were.
    links: list[dict[str, Any]] = field(default_factory=list)

    def add(self, dep: ArtifactDependency, reason: str) -> None:
        self.deps[dep.id] = dep
        if reason not in self.reasons[dep.id]:
            self.reasons[dep.id].append(reason)


def _label(e: Entity) -> str:
    """The item as a person reads it: its title ("Guided setup"), never its baseline key
    (qa-plan-10); a title-less item by its kind and key."""
    title = (e.title or "").strip()
    return title or f"{e.type.replace('_', ' ')} {e.key}"


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

    A link holds for the section whatever version it was made on: one made on a later
    version than a dependency's anchor still says what that section is about (when in
    doubt, mark: potentially stale is the safe side)."""
    by_doc: dict[uuid.UUID, list[DocumentSectionLink]] = defaultdict(list)
    for link in links:
        by_doc[link.document_id].append(link)
    for document_id, doc_links in by_doc.items():
        doc = await db.get(Document, document_id)
        for dep, _ in await _deps_on_document(db, document_id):
            for link in doc_links:
                if dep.upstream_section_key == link.section_key:
                    out.add(dep, f"section {link.section_key} of {doc.slug} {why[link.id]}")
                elif dep.upstream_section_key is None:
                    out.add(
                        dep,
                        f"section {link.section_key} of {doc.slug} {why[link.id]} "
                        "(depends on all of it)",
                    )


async def _removal_wholes(db: AsyncSession, roots: list[Root]) -> list[Root]:
    """A rejected or deleted root also changes what it was part of or verified."""
    removed = [r.id for r in roots if r.cause in REMOVALS]
    if not removed:
        return roots
    rows = (
        await db.execute(
            select(Edge.src_id, Edge.dst_id).where(
                Edge.src_id.in_(removed), Edge.type.in_(WHOLE_EDGES), Edge.status != "rejected"
            )
        )
    ).all()
    wholes: dict[uuid.UUID, list[uuid.UUID]] = defaultdict(list)
    for src, dst in rows:
        wholes[src].append(dst)
    return [
        Root(r.id, r.cause, r.edge, tuple(dict.fromkeys([*r.wholes, *wholes.get(r.id, [])])))
        for r in roots
    ]


async def _by_entities(db: AsyncSession, roots: list[Root], out: Affected) -> None:
    """Dependencies on ``roots``, on everything downstream of them and on their wholes,
    and on the sections that link any of those. One scoped graph load for all roots."""
    if not roots:
        return
    roots = await _removal_wholes(db, roots)
    root_ids = [r.id for r in roots]
    # A removed part's wholes are walked too: what is downstream of them (the other parts
    # and their criteria) may have rested on it.
    removal_wholes = [w for r in roots if r.cause in REMOVALS for w in r.wholes]
    g = await graph_mod.load_around(
        db, list(dict.fromkeys([*root_ids, *removal_wholes])), down=True
    )
    # Roots past MAX_ROOTS and edge-change wholes: their own label, no walk.
    missing = [i for i in [*root_ids, *(w for r in roots for w in r.wholes)] if i not in g.entities]
    extra = {}
    if missing:
        extra = {e.id: e for e in await db.scalars(select(Entity).where(Entity.id.in_(missing)))}

    def entity(e_id: uuid.UUID) -> Entity | None:
        return g.entities.get(e_id) or extra.get(e_id)

    reason_of: dict[uuid.UUID, str] = {}
    link_why: dict[uuid.UUID, str] = {}
    for root in roots:
        e = entity(root.id)
        label = _label(e) if e is not None else "a baseline item"
        reason_of.setdefault(root.id, f"{label} {root.text}")
        link_why.setdefault(root.id, f"links {label}, which {root.text}")
        for step in g.downstream(root.id):
            d = g.entities[step.entity_id]
            via = f"downstream of {label}, which {root.text}"
            reason_of.setdefault(d.id, f"{_label(d)} is {via}")
            link_why.setdefault(d.id, f"links {_label(d)}, {via}")
        for whole_id in root.wholes:
            w = entity(whole_id)
            if w is None:
                continue
            reason_of.setdefault(w.id, f"{_label(w)} contains {label}, which {root.text}")
            link_why.setdefault(w.id, f"links {_label(w)}, which contains {label} ({root.text})")
            if root.cause not in REMOVALS or w.id not in g.entities:
                continue
            for step in g.downstream(w.id):
                d = g.entities[step.entity_id]
                via = f"downstream of {_label(w)}, which contains {label} ({root.text})"
                reason_of.setdefault(d.id, f"{_label(d)} is {via}")
                link_why.setdefault(d.id, f"links {_label(d)}, {via}")
    out.truncated = out.truncated or g.truncated
    for e_id in reason_of:
        if e_id not in out.entity_ids and e_id not in root_ids:
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
    why = {link.id: link_why[link.entity_id] for link in links}  # type: ignore[index]
    await _by_sections(db, list(links), why, out)


def link_snapshot(link: DocumentSectionLink) -> dict[str, Any]:
    """What a section link was, kept on the change when it is about to go with its last
    target. The source item stays out: it is private to its owner."""
    return {
        "id": str(link.id),
        "document_id": str(link.document_id),
        "version_id": str(link.version_id) if link.version_id else None,
        "section_key": link.section_key,
        "kind": link.kind,
        "entity_id": str(link.entity_id) if link.entity_id else None,
        "evidence_id": str(link.evidence_id) if link.evidence_id else None,
        "claim": link.claim,
    }


async def _edge_ends(db: AsyncSession, edge_ids: set[uuid.UUID]) -> set[uuid.UUID]:
    """The downstream end of each confirmed, traced edge (as an edge change is recorded)."""
    if not edge_ids:
        return set()
    edges = await db.scalars(
        select(Edge).where(
            Edge.id.in_(edge_ids), Edge.status == "confirmed", Edge.type != "owned_by"
        )
    )
    return {e.dst_id if e.type in graph_mod.DST_DOWNSTREAM else e.src_id for e in edges}


async def _by_source_permission(db: AsyncSession, subject: Subject, out: Affected) -> None:
    cause = subject.cause if subject.cause in EVIDENCE_CAUSES else "source_permission"
    item_ids = {_uuid(i) for i in subject.data.get("source_item_ids", [])}
    evidence_ids = {_uuid(i) for i in subject.data.get("evidence_ids", [])}
    if subject.id is not None:
        if cause == "evidence_deleted":
            evidence_ids.add(subject.id)
        elif await db.get(Source, subject.id) is not None:
            item_ids |= set(
                (
                    await db.scalars(
                        select(SourceItem.id).where(SourceItem.source_id == subject.id)
                    )
                ).all()
            )
        else:
            item_ids.add(subject.id)
    if not item_ids and not evidence_ids:
        return
    found = [Evidence.id.in_(evidence_ids)] if evidence_ids else []
    if item_ids:
        found.append(Evidence.source_item_id.in_(item_ids))
    evidence = (
        await db.execute(
            select(Evidence.id, Evidence.entity_id, Evidence.edge_id).where(or_(*found))
        )
    ).all()
    evidence_ids |= {e_id for e_id, _, _ in evidence}
    entity_ids = {ent for _, ent, _ in evidence if ent is not None}
    entity_ids |= await _edge_ends(db, {edge for _, _, edge in evidence if edge is not None})
    if entity_ids:
        await _by_entities(db, [Root(e, cause) for e in sorted(entity_ids)], out)
    conditions = []
    if item_ids:
        conditions.append(DocumentSectionLink.source_item_id.in_(item_ids))
    if evidence_ids:
        conditions.append(DocumentSectionLink.evidence_id.in_(evidence_ids))
    links = (await db.scalars(select(DocumentSectionLink).where(or_(*conditions)))).all()
    why = {link.id: EVIDENCE_CAUSES[cause] for link in links}
    await _by_sections(db, list(links), why, out)
    # The links that go with the deleted evidence or items (oracle.v2.links): the rest
    # keep their other target and stay.
    if cause == "evidence_deleted":
        out.links.extend(
            link_snapshot(link) for link in links if left_without_target(link, evidence_ids)
        )
    elif cause == "source_deleted":
        out.links.extend(
            link_snapshot(link) for link in links if left_without_target(link, (), item_ids)
        )


async def _by_deleted_entities(db: AsyncSession, subject: Subject, out: Affected) -> None:
    """An entity about to be deleted takes with it the section links naming it and its
    evidence and its edges' evidence (``data["evidence_ids"]``). The sections whose links
    cite that evidence are reached as for removed evidence. A link that keeps another
    target only drops the deleted ones (oracle.v2.links); the links left with no target
    are deleted, and ``data["trace"]["links"]`` keeps what they were."""
    entity_ids = {r.id for r in roots_of(subject) if r.cause == "entity_deleted"}
    if not entity_ids:
        return
    evidence_ids = {_uuid(i) for i in subject.data.get("evidence_ids", [])}
    for root in subject.data.get("roots") or []:
        evidence_ids |= {_uuid(i) for i in root.get("evidence_ids") or []}
    conditions = [DocumentSectionLink.entity_id.in_(entity_ids)]
    if evidence_ids:
        conditions.append(DocumentSectionLink.evidence_id.in_(evidence_ids))
    links = (await db.scalars(select(DocumentSectionLink).where(or_(*conditions)))).all()
    citing = [link for link in links if link.evidence_id in evidence_ids]
    why = {link.id: EVIDENCE_CAUSES["evidence_deleted"] for link in citing}
    await _by_sections(db, citing, why, out)
    out.links.extend(
        link_snapshot(link)
        for link in links
        if left_without_target(link, evidence_ids, entity_ids=entity_ids)
    )


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
    elif subject.kind in ENTITY_SUBJECTS:
        await _by_entities(db, roots_of(subject), out)
        await _by_deleted_entities(db, subject, out)
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


def upstream_snapshot(entity: Entity) -> dict[str, Any]:
    return {
        "id": str(entity.id),
        "type": entity.type,
        "key": entity.key,
        "title": entity.title,
        "status": entity.status,
    }


async def _keep_deleted_upstream(
    db: AsyncSession, subject: Subject, found: Affected, now: datetime
) -> None:
    """An entity about to be deleted: its dependencies stay, pointing at a snapshot of
    it instead (the foreign key would null the reference anyway, 0014_trace)."""
    deleted = [r.id for r in roots_of(subject) if r.cause == "entity_deleted"]
    for root_id in deleted:
        entity = await db.get(Entity, root_id)
        if entity is None:
            continue
        snapshot = upstream_snapshot(entity)
        for dep in found.deps.values():
            if dep.upstream_entity_id == root_id:
                dep.upstream_snapshot = snapshot
                dep.upstream_deleted_at = now
                dep.upstream_entity_id = None


async def mark_stale(db: AsyncSession, event: ChangeEvent) -> None:
    """The ``trace.mark_stale`` handler: mark what the change reaches potentially_stale,
    with the change as its cause, and record exactly what was marked and why in
    ``event.data["trace"]``. On a version import it also carries unchanged sections'
    links forward and derives a roadmap version's dependencies on its PRD.

    A section change that is part of a version's change (``part_of_change_id``: the
    version import recorded both) is that change's: marked once, from the version."""
    if event.subject_kind == "document_section" and (event.data or {}).get("part_of_change_id"):
        return
    await _derive_for(db, event)
    subject = Subject.of(event)
    found = await affected(db, subject)
    now = datetime.now(UTC)
    await _keep_deleted_upstream(db, subject, found, now)
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
            "truncated": found.truncated,
            "links": found.links,
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
                    "truncated": found.truncated,
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
    """Point a reconciled dependency at the upstream document's latest version.

    A dependency whose upstream entity was deleted has nothing to point at: it is not
    re-anchored (not on an entity made again with the same key either, which is another
    entity). Reconciled, it is settled for good: no change can reach it again, it keeps
    the snapshot of what it pointed at, and the action records it as retired."""
    before: dict[str, Any] = {
        "upstream_version_id": str(dep.upstream_version_id) if dep.upstream_version_id else None,
        "upstream_section_hash": dep.upstream_section_hash,
    }
    if dep.upstream_snapshot is not None and dep.upstream_entity_id is None:
        before["upstream_snapshot"] = dep.upstream_snapshot
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
            if "upstream_snapshot" in entry["anchor_before"]:
                entry["retired"] = True
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
