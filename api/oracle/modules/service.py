"""Composition service: build a composition context from a document or an intake,
recommend, confirm a revision, publish, and the inspector's read model.

The composer itself is pure (oracle.modules.composer); this module does the reading and
the writing around it. A confirmed revision records who decided and why; a material
change records change events for the affected sections through ``oracle.changes`` (the
review and trace lanes react there). Callers audit and commit.
"""

import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import changes as change_hook
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.modules import registry
from oracle.modules.catalog import builtin_packs, default_pack_for
from oracle.modules.composer import (
    Advisory,
    Changes,
    ComposedModule,
    Composition,
    CompositionProblem,
    Context,
    ManifestEntry,
    Provenance,
    TemplateSection,
    compose,
)
from oracle.modules.schemas import (
    ComposeIn,
    CompositionSummary,
    InspectedModule,
    InspectorOut,
    ModuleVersionSummary,
    RecommendationOut,
    RevisionDetail,
    RevisionDiff,
    RevisionSummary,
    VersionChange,
)
from oracle.templates.builtins import DEFAULT_TEMPLATE_FOR_KIND, ensure_builtins
from oracle.templates.models import Template, TemplateVersion
from oracle.templates.service import company_draft_defaults
from oracle.templates.validation import check_template
from oracle.v2.concurrency import VersionConflict
from oracle.v2.contract import CONDITION_ROOTS, validate_contract
from oracle.v2.models import CompositionRevision, DocumentComposition, ProductIntake
from oracle.v2.schemas import CompositionInputs, IntakeAnalysis

INPUT_ROOTS = (*CONDITION_ROOTS, "intake_id", "baseline_snapshot_id", "source_snapshot_ids")


class CompositionRefused(ValueError):
    """The composition is invalid; ``problems`` say why (a 422)."""

    def __init__(self, problems: list[CompositionProblem]) -> None:
        super().__init__("; ".join(p.message for p in problems if p.fatal))
        self.problems = problems


class NotFound(LookupError):
    pass


class Conflict(RuntimeError):
    pass


async def ensure_seeded(db: AsyncSession) -> None:
    """Built-in templates first (manifests attach to them), then modules and manifests."""
    await ensure_builtins(db)
    await registry.ensure_builtin_modules(db)


# --- inputs from an intake ------------------------------------------------------------

# Capability tags a brief's wording suggests. Advisory only: each inferred tag is shown
# as an AI inference with its source, and a person's own scope replaces it.
CAPABILITY_HINTS: dict[str, tuple[str, ...]] = {
    "multi_tenant": ("multi-tenant", "multitenant", "multi tenant", "tenants", "per customer"),
    "customer_onboarding": ("onboarding", "provisioning"),
    "organisation_model": ("organisation model", "organization model", "workspace", "workspaces"),
    "configuration": ("configuration", "configurable", "settings"),
    "agent_configuration": ("agent behaviour", "agent behavior", "agent types", "archetype"),
    "tool_use": ("tool use", "tool calls", "tool calling", "function calling"),
    "memory": ("memory", "remember", "long-term state"),
    "knowledge": ("knowledge base", "retrieval"),
    "evaluation": ("evaluation", "evals", "simulation"),
    "versioning": ("versioning", "version migration", "migrate configurations"),
    "fleet_operations": ("fleet", "observability"),
    "quotas": ("quota", "quotas", "spend limit"),
    "usage_billing": ("usage-based", "metered", "usage billing"),
    "external_channels": ("social channel", "social channels", "external api", "third-party api"),
    "human_interaction": ("handoff", "human-in-the-loop", "end users", "end-user"),
    "customer_branding": ("brand", "branding", "white-label", "white label"),
    "continuous_improvement": ("continuous improvement", "learn from feedback"),
    "portability": ("portable", "portability"),
}


def infer_capabilities(text: str) -> list[str]:
    lowered = text.lower()
    found = []
    for tag, phrases in CAPABILITY_HINTS.items():
        if any(re.search(rf"(?<![a-z0-9]){re.escape(p)}(?![a-z0-9])", lowered) for p in phrases):
            found.append(tag)
    return found


def _intake_inputs(intake: ProductIntake) -> tuple[dict[str, Any], dict[str, Provenance]]:
    analysis = IntakeAnalysis.model_validate(intake.analysis or {})
    inferred = Provenance("ai_inference", (), f"intake {intake.id} analysis")
    inputs: dict[str, Any] = {
        "brief": {"title": intake.title, "text": intake.brief, "length": len(intake.brief)},
        "scope": {"items": analysis.scope, "non_goals": analysis.non_goals},
        "baseline": {
            "goal_ids": [str(g) for g in analysis.goal_ids],
            "goal_count": len(analysis.goal_ids),
        },
        "stakeholders": {"user_count": len(analysis.users)},
        "blockers": {
            "count": len(analysis.blockers),
            "hard_count": sum(1 for b in analysis.blockers if b.get("type") == "hard"),
        },
        "sources": {"snapshot_count": len(intake.source_snapshot_ids)},
        "intake_id": str(intake.id),
        "source_snapshot_ids": [str(s) for s in intake.source_snapshot_ids],
    }
    provenance = {
        "brief": Provenance("user_decision", (), f"intake {intake.id} brief"),
        "scope": inferred,
        "blockers": inferred,
        "stakeholders": inferred,
        "baseline": Provenance("verified_fact", (), "confirmed baseline goals"),
        "sources": Provenance("verified_fact", (), "pinned source snapshots"),
    }
    if analysis.category:
        inputs["category"] = analysis.category
        provenance["category"] = inferred
    text = " ".join([intake.title, intake.brief, *analysis.scope])
    if capabilities := infer_capabilities(text):
        inputs["scope"]["capabilities"] = capabilities
        provenance["scope.capabilities"] = Provenance(
            "ai_inference", (), "keywords in the intake brief (advisory)"
        )
    return inputs, provenance


def _merge(base: dict[str, Any], top: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for key, value in top.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = {**out[key], **value}
        else:
            out[key] = value
    return out


# --- context --------------------------------------------------------------------------


@dataclass
class Built:
    ctx: Context
    inputs: CompositionInputs
    template: Template | None
    template_version: TemplateVersion | None
    intake: ProductIntake | None


async def _template(
    db: AsyncSession, key: str | None, version: int | None
) -> tuple[Template | None, TemplateVersion | None]:
    if key is None:
        return None, None
    t = await db.scalar(select(Template).where(Template.key == key))
    if t is None:
        raise NotFound(f"template '{key}' not found")
    stmt = select(TemplateVersion).where(TemplateVersion.template_id == t.id)
    if version is not None:
        v = await db.scalar(stmt.where(TemplateVersion.version == version))
        if v is None:
            raise NotFound(f"version {version} of template '{key}' not found")
    else:
        v = await db.scalar(stmt.order_by(TemplateVersion.version.desc()).limit(1))
    return t, v


def _template_sections(body: str) -> list[TemplateSection]:
    check = check_template(body)
    brief = set(check.brief_sections)
    return [
        TemplateSection(h.key, h.level, h.text, h.key in brief) for h in check.headings if h.key
    ]


async def build(
    db: AsyncSession,
    data: ComposeIn,
    *,
    document: Document | None = None,
    previous: CompositionRevision | None = None,
) -> Built:
    await ensure_seeded(db)
    catalog = await registry.load_catalog(db)
    policy, _ = await registry.read_policy(db)

    # The intake: given, else the one linked to the document, else the previous one.
    intake = None
    intake_id = data.intake_id
    if intake_id is None and previous is not None:
        intake_id = (previous.inputs or {}).get("intake_id")
    if intake_id is not None:
        intake = await db.get(ProductIntake, uuid.UUID(str(intake_id)))
        if intake is None and data.intake_id is not None:
            raise NotFound(f"intake {intake_id} not found")
        # An intake a previous revision named and that is gone: its inputs are kept.
    elif document is not None:
        intake = await db.scalar(
            select(ProductIntake)
            .where(ProductIntake.document_id == document.id)
            .order_by(ProductIntake.created_at.desc())
            .limit(1)
        )

    inputs: dict[str, Any] = {}
    provenance: dict[str, Provenance] = {}
    if previous is not None:
        inputs = {k: v for k, v in (previous.inputs or {}).items() if k in INPUT_ROOTS}
    if intake is not None:
        derived, provenance = _intake_inputs(intake)
        inputs = _merge(inputs, derived)
    unknown = sorted(set(data.inputs) - set(INPUT_ROOTS))
    if unknown:
        raise CompositionRefused(
            [
                CompositionProblem(
                    code="unknown_input", message=f"unknown input roots: {', '.join(unknown)}"
                )
            ]
        )
    inputs = _merge(inputs, data.inputs)
    for path in data.inputs:
        provenance.setdefault(path, Provenance("user_decision", (), "given in the request"))
    for path, p in data.provenance.items():
        provenance[path] = Provenance(p.knowledge_state, tuple(p.evidence_ids), p.source)

    # The template: given, else the document's, else the company default, else built-in.
    key = data.template or (document.template if document else None)
    version = data.template_version
    if version is None and data.template is None and document and document.template_version:
        version = int(document.template_version) if document.template_version.isdigit() else None
    if key is None:
        defaults = await company_draft_defaults(db)
        key = (defaults.get("prd") or {}).get("template") or DEFAULT_TEMPLATE_FOR_KIND["prd"]
    try:
        template, template_version = await _template(db, key, version)
    except NotFound:
        if data.template_version is not None:
            raise
        # The draft names a template version this company does not have: use the latest.
        template, template_version = await _template(db, key, None)
    if template is not None and template.kind != "prd":
        raise CompositionRefused(
            [
                CompositionProblem(
                    code="template_kind",
                    message=f"template '{template.key}' is a {template.kind} template; "
                    "module compositions apply to PRDs",
                )
            ]
        )

    contracts = catalog.available()
    manifest: dict[str, ManifestEntry] = {}
    sections: list[TemplateSection] = []
    if template is not None and template_version is not None:
        sections = _template_sections(template_version.body)
        rows = await registry.read_manifest(db, template.id)
        for mkey, row in rows.items():
            if row.since_template_version and template_version.version < row.since_template_version:
                continue
            if mkey not in contracts:
                continue
            if row.module_version and (pinned := catalog.entries[mkey].version(row.module_version)):
                contracts[mkey] = validate_contract(pinned.contract)
            manifest[mkey] = ManifestEntry(tuple(row.section_ids), row.policy, row.module_version)

    # Packs: given, else company default, else by category.
    pack_ids = data.packs or policy.default_packs or [default_pack_for(inputs.get("category"))]
    known = builtin_packs()
    if unknown := sorted(p for p in pack_ids if p not in known):
        raise CompositionRefused(
            [
                CompositionProblem(
                    code="unknown_pack", message=f"unknown packs: {', '.join(unknown)}"
                )
            ]
        )
    packs: dict[str, tuple[str, ...]] = {}
    for pid in pack_ids:
        listed = [
            k for k in known[pid].modules if k in contracts and pid in contracts[k].applies_to
        ]
        extra = sorted(k for k, c in contracts.items() if pid in c.applies_to and k not in listed)
        packs[pid] = tuple(listed + extra)
    inputs["policy"] = {
        **(inputs.get("policy") or {}),
        "packs": list(pack_ids),
        "required": policy.required,
        "optional": policy.optional,
        "disabled": policy.disabled,
    }
    inputs["template"] = {
        **(inputs.get("template") or {}),
        "key": template.key if template else None,
        "version": str(template_version.version) if template_version else None,
        "manifest": {k: list(e.sections) for k, e in manifest.items()},
    }
    try:
        typed = CompositionInputs.model_validate(inputs)
    except ValidationError as e:
        first = e.errors()[0]
        where = ".".join(str(p) for p in first.get("loc", ()))
        raise CompositionRefused(
            [CompositionProblem(code="invalid_input", message=f"{where}: {first.get('msg')}")]
        ) from None

    ctx = Context(
        contracts=contracts,
        origins=catalog.origins(),
        unavailable={k for k, e in catalog.entries.items() if e.archived},
        packs=packs,
        template_key=template.key if template else None,
        template_version=str(template_version.version) if template_version else None,
        template_sections=sections,
        manifest=manifest,
        company_required=tuple(policy.required),
        company_optional=tuple(policy.optional),
        company_disabled=tuple(policy.disabled),
        inputs=typed.model_dump(mode="json"),
        provenance=provenance,
        advisory={k: Advisory(a.score, a.rationale) for k, a in data.advisory.items()},
        field_values=data.field_values,
    )
    return Built(ctx, typed, template, template_version, intake)


def changes_of(
    data: ComposeIn, role: str, actor_id: uuid.UUID | None, reason: str | None
) -> Changes | None:
    if data.changes is None:
        return None
    return Changes(
        add=tuple(data.changes.add),
        remove=tuple(data.changes.remove),
        order=tuple(data.changes.order) if data.changes.order is not None else None,
        reason=reason,
        role=role,
        actor_id=str(actor_id) if actor_id else None,
    )


def summary(modules: list[ComposedModule]) -> CompositionSummary:
    return CompositionSummary(
        mandatory=sum(1 for m in modules if m.selection == "mandatory"),
        suggested=sum(1 for m in modules if m.selection == "suggested"),
        optional=sum(1 for m in modules if m.selection == "optional"),
        included=sum(1 for m in modules if m.included),
        excluded=sum(1 for m in modules if not m.included),
    )


def recommendation_out(
    built: Built, comp: Composition, document: Document | None
) -> RecommendationOut:
    return RecommendationOut(
        document_id=document.id if document else None,
        intake_id=built.intake.id if built.intake else None,
        template=comp.template,
        template_version=comp.template_version,
        packs=comp.packs,
        valid=comp.valid,
        summary=summary(comp.modules),
        modules=comp.modules,
        problems=comp.problems,
        outline=comp.outline,
        inputs=built.inputs,
    )


async def recommend(
    db: AsyncSession,
    data: ComposeIn,
    *,
    document: Document | None,
    role: str,
    actor_id: uuid.UUID | None,
) -> RecommendationOut:
    previous = None
    if document is not None:
        composition = await _composition(db, document.id)
        if composition is not None and composition.current_revision is not None:
            previous = await _revision(db, composition.id, composition.current_revision)
    built = await build(db, data, document=document, previous=previous)
    comp = compose(built.ctx, changes_of(data, role, actor_id, None))
    return recommendation_out(built, comp, document)


# --- persistence ----------------------------------------------------------------------


async def _composition(db: AsyncSession, document_id: uuid.UUID) -> DocumentComposition | None:
    return await db.scalar(
        select(DocumentComposition).where(DocumentComposition.document_id == document_id)
    )


async def _revision(
    db: AsyncSession, composition_id: uuid.UUID, number: int
) -> CompositionRevision | None:
    return await db.scalar(
        select(CompositionRevision).where(
            CompositionRevision.composition_id == composition_id,
            CompositionRevision.number == number,
        )
    )


def _modules(rows: list[dict[str, Any]]) -> list[ComposedModule]:
    return [ComposedModule.model_validate(r) for r in rows]


def diff(before: list[ComposedModule] | None, after: list[ComposedModule]) -> RevisionDiff:
    if before is None:
        return RevisionDiff()
    b = {m.key: m for m in before if m.included}
    a = {m.key: m for m in after if m.included}
    added = sorted(set(a) - set(b))
    removed = sorted(set(b) - set(a))
    changed = [
        VersionChange(key=k, before=b[k].version, after=a[k].version)
        for k in sorted(set(a) & set(b))
        if a[k].version != b[k].version
    ]
    common = [k for k in sorted(a, key=lambda k: a[k].order) if k in b]
    reordered = common != [k for k in sorted(b, key=lambda k: b[k].order) if k in a]
    affected: list[str] = []
    for k in added:
        affected.extend(a[k].section_ids)
    for k in removed:
        affected.extend(b[k].section_ids)
    for c in changed:
        affected.extend(a[c.key].section_ids)
    material = bool(added or removed or changed)
    return RevisionDiff(
        added=added,
        removed=removed,
        version_changed=changed,
        reordered=reordered,
        material=material,
        affected_sections=sorted(set(affected)),
    )


async def confirm(
    db: AsyncSession,
    document: Document,
    data: Any,
    *,
    role: str,
    actor: Any,
    actor_id: uuid.UUID | None,
) -> tuple[CompositionRevision, RevisionDiff]:
    """Confirm (or save as working) a composition revision. The caller audits and commits.

    Raises :class:`CompositionRefused` (422), :class:`VersionConflict` (409).
    """
    composition = await _composition(db, document.id)
    current = composition.current_revision if composition else None
    if data.base_revision != current:
        raise VersionConflict(current)
    previous = await _revision(db, composition.id, current) if composition and current else None
    built = await build(db, data, document=document, previous=previous)
    reason = data.reason.strip()
    comp = compose(built.ctx, changes_of(data, role, actor_id, reason))
    if not comp.valid:
        raise CompositionRefused(comp.problems)

    if composition is None:
        composition = DocumentComposition(document_id=document.id)
        db.add(composition)
        try:
            await db.flush()
        except IntegrityError as e:
            raise VersionConflict() from e
    number = (
        await db.scalar(
            select(func.max(CompositionRevision.number)).where(
                CompositionRevision.composition_id == composition.id
            )
        )
        or 0
    ) + 1
    revision = CompositionRevision(
        composition_id=composition.id,
        number=number,
        status=data.status,
        modules=[m.model_dump(mode="json") for m in comp.modules],
        inputs=built.inputs.model_dump(mode="json"),
        decided_by=actor_id,
        decided_at=datetime.now(UTC),
        reason=reason,
        parent_number=current,
    )
    db.add(revision)
    if previous is not None and previous.status in ("working", "confirmed"):
        previous.status = "superseded"
    composition.current_revision = number
    composition.template = comp.template
    composition.template_version = comp.template_version
    try:
        await db.flush()
    except IntegrityError as e:
        raise VersionConflict() from e

    change = diff(_modules(previous.modules) if previous else None, comp.modules)
    await change_hook.record_change(
        db,
        "composition_revision",
        cause="composition_confirmed" if data.status == "confirmed" else "composition_saved",
        actor=actor,
        subject_id=revision.id,
        subject_ref=f"{document.slug}#composition@{number}",
        document_id=document.id,
        data={
            "number": number,
            "parent_number": current,
            "status": data.status,
            **change.model_dump(mode="json"),
        },
    )
    if change.material:
        await _record_section_changes(db, document, revision, change, actor)
    return revision, change


async def _record_section_changes(
    db: AsyncSession,
    document: Document,
    revision: CompositionRevision,
    change: RevisionDiff,
    actor: Any,
) -> None:
    """One change event per affected section, so approvals and artifacts react."""
    owner: dict[str, tuple[str, str]] = {}
    for key in change.added:
        owner.update({s: (key, "module_added") for s in _sections_of(revision, key)})
    for v in change.version_changed:
        owner.update({s: (v.key, "module_version_changed") for s in _sections_of(revision, v.key)})
    for section in change.affected_sections:
        module, cause = owner.get(section, (None, "module_removed"))
        await change_hook.record_change(
            db,
            "document_section",
            cause="composition_changed",
            actor=actor,
            subject_ref=f"{document.slug}#{section}",
            document_id=document.id,
            data={
                "section_key": section,
                "module": module,
                "change": cause,
                "composition_revision": revision.number,
                "parent_revision": revision.parent_number,
            },
        )


def _sections_of(revision: CompositionRevision, key: str) -> list[str]:
    for m in revision.modules:
        if m.get("key") == key:
            return list(m.get("section_ids") or [])
    return []


async def publish(db: AsyncSession, document: Document, number: int) -> CompositionRevision:
    """Pin the current confirmed revision to an approved document version (§4.3 step 8).

    The revision already records the template version, module ids and versions, company
    overrides (origin) and the inputs; publishing freezes it. Idempotent for the same
    version. Raises :class:`Conflict` (409) or :class:`NotFound` (404).
    """
    version = await db.scalar(
        select(DocumentVersion).where(
            DocumentVersion.document_id == document.id, DocumentVersion.number == number
        )
    )
    if version is None:
        raise NotFound(f"version {number} of '{document.slug}' not found")
    composition = await _composition(db, document.id)
    if composition is None or composition.current_revision is None:
        raise Conflict("the document has no composition to publish; confirm one first")
    revision = await _revision(db, composition.id, composition.current_revision)
    assert revision is not None
    if revision.status == "published":
        if revision.document_version_id == version.id:
            return revision
        raise Conflict(
            f"composition revision {revision.number} is already published with another "
            "version; confirm a new revision first"
        )
    if revision.status != "confirmed":
        raise Conflict(
            f"composition revision {revision.number} is {revision.status}, not confirmed"
        )
    if version.approved_at is None:
        raise Conflict(f"version {number} is not approved; approve it before publishing")
    revision.status = "published"
    revision.document_version_id = version.id
    await db.flush()
    return revision


async def on_document_version_change(db: AsyncSession, event: Any) -> None:
    """``oracle.changes`` handler: a published document version pins its composition.

    The review lane's publish transaction records ``document_version`` with cause
    ``published``; a document without a composition is left alone (legacy).
    """
    if event.cause != "published" or event.document_id is None or event.subject_id is None:
        return
    version = await db.get(DocumentVersion, event.subject_id)
    document = await db.get(Document, event.document_id)
    if version is None or document is None or version.approved_at is None:
        return
    composition = await _composition(db, document.id)
    if composition is None or composition.current_revision is None:
        return
    revision = await _revision(db, composition.id, composition.current_revision)
    if revision is not None and revision.status == "confirmed":
        revision.status = "published"
        revision.document_version_id = version.id
        await db.flush()


# --- the inspector --------------------------------------------------------------------


async def _latest_sections(db: AsyncSession, document: Document) -> tuple[int | None, list[str]]:
    version = await db.scalar(
        select(DocumentVersion)
        .where(DocumentVersion.document_id == document.id)
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )
    if version is None:
        return None, []
    keys = (
        await db.scalars(
            select(Section.section_key)
            .where(Section.version_id == version.id)
            .order_by(Section.ordinal)
        )
    ).all()
    return version.number, list(keys)


def _summary_of(
    revision: CompositionRevision, parent: CompositionRevision | None
) -> RevisionSummary:
    return RevisionSummary(
        id=revision.id,
        number=revision.number,
        status=revision.status,
        decided_by=revision.decided_by,
        decided_at=revision.decided_at,
        reason=revision.reason,
        parent_number=revision.parent_number,
        document_version_id=revision.document_version_id,
        diff=diff(_modules(parent.modules) if parent else None, _modules(revision.modules)),
    )


async def inspect(db: AsyncSession, document: Document, *, role: str) -> InspectorOut:
    composition = await _composition(db, document.id)
    number, present = await _latest_sections(db, document)
    revisions: list[CompositionRevision] = []
    if composition is not None:
        revisions = list(
            (
                await db.scalars(
                    select(CompositionRevision)
                    .where(CompositionRevision.composition_id == composition.id)
                    .order_by(CompositionRevision.number)
                )
            ).all()
        )
    by_number = {r.number: r for r in revisions}
    summaries = [
        _summary_of(r, by_number.get(r.parent_number) if r.parent_number else None)
        for r in reversed(revisions)
    ]
    current_row = by_number.get(composition.current_revision) if composition else None

    if current_row is None:
        rec = await recommend(db, ComposeIn(), document=document, role=role, actor_id=None)
        claimed = {s for m in rec.modules if m.included for s in m.section_ids}
        return InspectorOut(
            document_id=document.id,
            slug=document.slug,
            legacy=True,
            composition_id=composition.id if composition else None,
            lock_version=composition.lock_version if composition else None,
            recommendation=rec,
            revisions=summaries,
            sections={"version": number, "unmapped": [s for s in present if s not in claimed]},
        )

    catalog = await registry.load_catalog(db)
    modules: list[InspectedModule] = []
    present_set = set(present)
    for m in _modules(current_row.modules):
        entry = catalog.entries.get(m.key)
        inspected = InspectedModule(**m.model_dump())
        inspected.sections_present = [s for s in m.section_ids if s in present_set]
        inspected.sections_missing = (
            [s for s in m.section_ids if s not in present_set] if m.included and number else []
        )
        if entry is not None:
            inspected.versions = [
                ModuleVersionSummary(
                    version=v.version,
                    origin=v.origin,
                    contract_hash=v.contract_hash,
                    created_by=v.created_by,
                    created_at=v.created_at,
                )
                for v in entry.versions
            ]
            inspected.latest_version = entry.effective.version
            newer = entry.effective.version != m.version
            inspected.upgrade_available = (
                entry.effective.version if newer else entry.upgrade_available
            )
        modules.append(inspected)
    claimed = {s for m in modules if m.included for s in m.section_ids}
    parent = by_number.get(current_row.parent_number) if current_row.parent_number else None
    head = _summary_of(current_row, parent)
    inputs = CompositionInputs.model_validate(current_row.inputs or {})
    current = RevisionDetail(
        **head.model_dump(),
        lock_version=current_row.lock_version,
        template=composition.template,
        template_version=composition.template_version,
        packs=list((inputs.policy or {}).get("packs") or []),
        inputs=inputs,
        modules=modules,
        summary=summary(modules),
    )
    return InspectorOut(
        document_id=document.id,
        slug=document.slug,
        legacy=False,
        composition_id=composition.id,
        lock_version=composition.lock_version,
        current=current,
        revisions=summaries,
        sections={"version": number, "unmapped": [s for s in present if s not in claimed]},
    )


__all__ = [
    "CAPABILITY_HINTS",
    "CompositionRefused",
    "Conflict",
    "NotFound",
    "build",
    "confirm",
    "diff",
    "ensure_seeded",
    "infer_capabilities",
    "inspect",
    "on_document_version_change",
    "publish",
    "recommend",
]
