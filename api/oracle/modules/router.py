"""Module catalogue, packs, company module policy, template manifests and document
compositions (build prompt §4, CR-01/CR-02).

Anyone signed in reads and asks for a recommendation (computing one changes nothing).
Approvers confirm composition revisions, publish them and edit template manifests;
adding or removing a module whose contract asks for the owner role needs an owner.
Owners set the company module policy and add company modules or overrides. Every write
is audited; a confirmed revision also records change events (oracle.changes).
"""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle import changes as change_hook
from oracle.auth.deps import Principal, TenantDB
from oracle.authz import require_role
from oracle.docs import service as docs_service
from oracle.docs.models import Document
from oracle.modules import registry, service
from oracle.modules.catalog import builtin_packs
from oracle.modules.composer import CompositionProblem
from oracle.modules.registry import ModulePolicySettings, RegistryError
from oracle.modules.schemas import (
    CatalogModuleDetail,
    CatalogModuleOut,
    CompositionRecommendIn,
    InspectorOut,
    ManifestIn,
    ManifestModuleOut,
    ManifestOut,
    ModuleContractIn,
    ModulePolicyOut,
    ModuleVersionSummary,
    PackModuleOut,
    PackOut,
    ProblemsOut,
    PublishIn,
    RecommendationOut,
    RevisionIn,
)
from oracle.templates.models import Template
from oracle.v2.concurrency import VersionConflict
from oracle.v2.schemas import CompositionRevisionOut

router = APIRouter(prefix="/v1", tags=["modules"])

Viewer = Annotated[Principal, Depends(require_role("viewer"))]
Approver = Annotated[Principal, Depends(require_role("approver"))]
Owner = Annotated[Principal, Depends(require_role("owner"))]
REFUSED = {422: {"model": ProblemsOut, "description": "Refused: the problems say why"}}
CONFLICT = {409: {"description": "Changed since loaded, or not in a state that allows this"}}

# A published document version pins its composition (v2-review records the event).
change_hook.register_handler(
    "modules.pin_published_composition",
    service.on_document_version_change,
    subjects={"document_version"},
)


def _refused(detail: str, problems: list[CompositionProblem]) -> JSONResponse:
    body = ProblemsOut(detail=detail, problems=problems)
    return JSONResponse(body.model_dump(mode="json"), status.HTTP_422_UNPROCESSABLE_CONTENT)


def _registry_refused(e: RegistryError) -> JSONResponse:
    return _refused(str(e), [CompositionProblem(code=e.code, message=str(e))])


def _not_found(message: str) -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, message)


async def _document(db: AsyncSession, doc: str) -> Document:
    try:
        document = await docs_service.get_document_or_404(db, doc)
    except docs_service.NotFoundError as e:
        raise _not_found(str(e)) from e
    if document.kind != "prd":
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "module compositions apply to PRDs only"
        )
    return document


# --- catalogue ----------------------------------------------------------------------


def _catalog_out(entry: registry.Entry, policy: ModulePolicySettings) -> CatalogModuleDetail:
    c = entry.contract
    return CatalogModuleDetail(
        key=entry.key,
        title=entry.definition.title,
        description=entry.definition.description,
        builtin=entry.definition.builtin,
        archived=entry.archived,
        version=entry.effective.version,
        origin=entry.origin,
        policy=c.policy,
        company_policy=policy.policy_for(entry.key),
        applies_to=list(c.applies_to),
        depends_on=list(c.depends_on),
        conflicts_with=list(c.conflicts_with),
        section_ids=c.effective_section_ids(),
        brief_layer=c.brief_layer,
        full_layer=c.full_layer,
        required_review_role=c.required_review_role,
        upgrade_available=entry.upgrade_available,
        versions=[
            ModuleVersionSummary(
                version=v.version,
                origin=v.origin,
                contract_hash=v.contract_hash,
                created_by=v.created_by,
                created_at=v.created_at,
            )
            for v in entry.versions
        ],
        contract=entry.effective.contract,
    )


@router.get("/module-catalog", response_model=list[CatalogModuleOut])
async def list_module_catalog(
    db: TenantDB,
    _: Viewer,
    pack: str | None = None,
    include_archived: bool = False,
) -> list[CatalogModuleOut]:
    """Every module the company can compose with (built-ins seeded on first use)."""
    await service.ensure_seeded(db)
    await db.commit()
    catalog = await registry.load_catalog(db)
    policy, _ = await registry.read_policy(db)
    out = []
    for entry in catalog.entries.values():
        if entry.archived and not include_archived:
            continue
        if pack is not None and pack not in entry.contract.applies_to:
            continue
        detail = _catalog_out(entry, policy)
        out.append(CatalogModuleOut(**detail.model_dump(exclude={"contract"})))
    return out


@router.get("/module-catalog/{key}", response_model=CatalogModuleDetail)
async def get_module_catalog_entry(key: str, db: TenantDB, _: Viewer) -> CatalogModuleDetail:
    """One module with its effective contract and its release history."""
    await service.ensure_seeded(db)
    await db.commit()
    catalog = await registry.load_catalog(db)
    entry = catalog.entries.get(key)
    if entry is None:
        raise _not_found(f"module {key} not found")
    policy, _ = await registry.read_policy(db)
    return _catalog_out(entry, policy)


@router.post(
    "/module-catalog",
    response_model=CatalogModuleDetail,
    status_code=status.HTTP_201_CREATED,
    responses=REFUSED,
)
async def create_company_module(data: ModuleContractIn, db: TenantDB, principal: Owner):
    """Add a company module (not a built-in)."""
    await service.ensure_seeded(db)
    try:
        row = await registry.create_module(db, data.contract, principal.id)
    except RegistryError as e:
        return _registry_refused(e)
    await audit.record(
        db, principal, "module.create", "module_version", row.id,
        {"key": data.contract.get("id"), "version": row.version},
    )  # fmt: skip
    await db.commit()
    catalog = await registry.load_catalog(db)
    policy, _ = await registry.read_policy(db)
    return _catalog_out(catalog.entries[row.contract["id"]], policy)


@router.post(
    "/module-catalog/{key}/versions",
    response_model=CatalogModuleDetail,
    status_code=status.HTTP_201_CREATED,
    responses={**REFUSED, 404: {"description": "No such module"}},
)
async def create_module_override(key: str, data: ModuleContractIn, db: TenantDB, principal: Owner):
    """A company release of a module (an override of a built-in, or a new release of a
    company module). Built-in upgrades never overwrite it."""
    await service.ensure_seeded(db)
    try:
        row = await registry.create_override(db, key, data.contract, principal.id)
    except registry.NotFound as e:
        raise _not_found(str(e)) from e
    except RegistryError as e:
        return _registry_refused(e)
    await audit.record(
        db, principal, "module.override", "module_version", row.id,
        {"key": key, "version": row.version},
    )  # fmt: skip
    await db.commit()
    catalog = await registry.load_catalog(db)
    policy, _ = await registry.read_policy(db)
    return _catalog_out(catalog.entries[key], policy)


@router.get("/module-packs", response_model=list[PackOut])
async def list_module_packs(db: TenantDB, _: Viewer) -> list[PackOut]:
    """The seeded packs: General Tech Startup and Multi-tenant AI Agent Platform."""
    await service.ensure_seeded(db)
    await db.commit()
    contracts = (await registry.load_catalog(db)).available()
    out = []
    for pack in builtin_packs().values():
        keys = [k for k in pack.modules if k in contracts and pack.id in contracts[k].applies_to]
        keys += sorted(k for k, c in contracts.items() if pack.id in c.applies_to and k not in keys)
        out.append(
            PackOut(
                id=pack.id,
                version=pack.version,
                title=pack.title,
                description=pack.description,
                categories=list(pack.categories),
                modules=[
                    PackModuleOut(key=k, title=contracts[k].title, policy=contracts[k].policy)
                    for k in keys
                ],
            )
        )
    return out


# --- company module policy ------------------------------------------------------------


async def _policy_out(db: AsyncSession) -> ModulePolicyOut:
    policy, row = await registry.read_policy(db)
    return ModulePolicyOut(
        **policy.model_dump(), is_default=row is None, updated_at=row.updated_at if row else None
    )


@router.get("/module-policy", response_model=ModulePolicyOut)
async def get_module_policy(db: TenantDB, _: Viewer) -> ModulePolicyOut:
    """Which modules the company makes mandatory, optional or disabled."""
    return await _policy_out(db)


@router.put("/module-policy", response_model=ModulePolicyOut, responses=REFUSED)
async def put_module_policy(data: ModulePolicySettings, db: TenantDB, principal: Owner):
    await service.ensure_seeded(db)
    before, _ = await registry.read_policy(db)
    try:
        await registry.write_policy(db, data, principal.id)
    except RegistryError as e:
        return _registry_refused(e)
    await audit.record(
        db, principal, "module_policy.update", "tenant_setting", None,
        {"before": before.model_dump(), "after": data.model_dump()},
    )  # fmt: skip
    await db.commit()
    return await _policy_out(db)


# --- template manifests ---------------------------------------------------------------


async def _manifest_out(db: AsyncSession, template: Template) -> ManifestOut:
    rows = await registry.read_manifest(db, template.id)
    _, version = await service._template(db, template.key, None)
    sections = [s.key for s in service._template_sections(version.body)] if version else []
    present = set(sections)
    mapped = {s for r in rows.values() for s in r.section_ids}
    return ManifestOut(
        template=template.key,
        template_id=template.id,
        template_version=version.version if version else 0,
        edited=any(r.created_by is not None for r in rows.values()),
        manifest_format=max((r.manifest_format for r in rows.values()), default=1),
        modules=[
            ManifestModuleOut(
                module_key=r.module_key,
                module_version=r.module_version,
                policy=r.policy,
                display_order=r.display_order,
                section_ids=r.section_ids,
                sections_present=[s for s in r.section_ids if s in present],
                sections_absent=[s for s in r.section_ids if s not in present],
                created_by=r.created_by,
            )
            for r in rows.values()
        ],
        unmapped_sections=[s for s in sections if s not in mapped],
    )


async def _template_row(db: AsyncSession, key: str) -> Template:
    template = await db.scalar(select(Template).where(Template.key == key))
    if template is None:
        raise _not_found(f"template '{key}' not found")
    return template


@router.get("/template-manifests/{template}", response_model=ManifestOut)
async def get_template_manifest(template: str, db: TenantDB, _: Viewer) -> ManifestOut:
    """A template's module manifest: which module renders which of its sections, and the
    sections no module claims (template-owned, preserved as-is). Empty for a template
    without a manifest, which composes exactly as before."""
    await service.ensure_seeded(db)
    await db.commit()
    return await _manifest_out(db, await _template_row(db, template))


@router.put("/template-manifests/{template}", response_model=ManifestOut, responses=REFUSED)
async def put_template_manifest(template: str, data: ManifestIn, db: TenantDB, principal: Approver):
    """Replace a template's manifest. The template and its versions are not touched; a
    company-edited manifest is never replaced by a packaged one."""
    await service.ensure_seeded(db)
    row = await _template_row(db, template)
    if row.kind != "prd":
        return _refused(
            "manifests apply to PRD templates",
            [
                CompositionProblem(
                    code="template_kind", message=f"template '{template}' is a {row.kind}"
                )
            ],
        )
    try:
        await registry.write_manifest(db, row, [m.model_dump() for m in data.modules], principal.id)
    except RegistryError as e:
        return _registry_refused(e)
    await audit.record(
        db, principal, "template_manifest.update", "template", row.id,
        {"modules": [m.module_key for m in data.modules]},
    )  # fmt: skip
    await db.commit()
    return await _manifest_out(db, row)


# --- compositions ---------------------------------------------------------------------


@router.post("/compositions/recommend", response_model=RecommendationOut, responses=REFUSED)
async def recommend_composition(data: CompositionRecommendIn, db: TenantDB, principal: Viewer):
    """Recommend a module composition for a document, an intake or a template, with the
    reason, source and missing information behind each module. Changes nothing; pass
    `changes` to preview adding, removing or reordering modules."""
    document = await _document(db, data.document) if data.document else None
    try:
        out = await service.recommend(
            db, data, document=document, role=principal.role, actor_id=principal.id
        )
    except service.NotFound as e:
        raise _not_found(str(e)) from e
    except service.CompositionRefused as e:
        return _refused(str(e), e.problems)
    await db.commit()  # built-in seeding only
    return out


@router.get("/documents/{doc}/composition", response_model=InspectorOut)
async def get_document_composition(doc: str, db: TenantDB, principal: Viewer) -> InspectorOut:
    """The composition inspector: for each module, mandatory, suggested or optional; the
    reason and the source or assumption behind it; missing information; brief/full
    impact; dependencies and conflicts; version history; and the revision history. A
    document without a composition is legacy and gets a recommendation instead."""
    document = await _document(db, doc)
    out = await service.inspect(db, document, role=principal.role)
    await db.commit()  # built-in seeding only
    return out


@router.post(
    "/documents/{doc}/composition/revisions",
    response_model=InspectorOut,
    status_code=status.HTTP_201_CREATED,
    responses={**REFUSED, **CONFLICT},
)
async def confirm_composition_revision(
    doc: str, data: RevisionIn, db: TenantDB, principal: Approver
):
    """Confirm a composition revision (or save it as working): who decided and why.
    Mandatory modules and dependencies are never removed silently; a material change
    records change events for the affected sections."""
    document = await _document(db, doc)
    try:
        revision, change = await service.confirm(
            db, document, data, role=principal.role, actor=principal, actor_id=principal.id
        )
    except service.NotFound as e:
        raise _not_found(str(e)) from e
    except service.CompositionRefused as e:
        return _refused(str(e), e.problems)
    except VersionConflict:
        raise
    await audit.record(
        db, principal, "composition.revision", "composition_revision", revision.id,
        {
            "document_id": str(document.id),
            "number": revision.number,
            "status": revision.status,
            "reason": revision.reason,
            "added": change.added,
            "removed": change.removed,
            "material": change.material,
        },
    )  # fmt: skip
    await db.commit()
    return await service.inspect(db, document, role=principal.role)


@router.post(
    "/documents/{doc}/composition/publish",
    response_model=CompositionRevisionOut,
    responses=CONFLICT,
)
async def publish_composition(doc: str, data: PublishIn, db: TenantDB, principal: Approver):
    """Pin the confirmed composition to an approved document version: template version,
    module ids and versions, company overrides and inputs. Never changed afterwards."""
    document = await _document(db, doc)
    try:
        revision = await service.publish(db, document, data.version)
    except service.NotFound as e:
        raise _not_found(str(e)) from e
    except service.Conflict as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from e
    await audit.record(
        db, principal, "composition.publish", "composition_revision", revision.id,
        {"document_id": str(document.id), "number": revision.number, "version": data.version},
    )  # fmt: skip
    await db.commit()
    await db.refresh(revision)
    return CompositionRevisionOut.model_validate(revision)


__all__ = ["router"]
