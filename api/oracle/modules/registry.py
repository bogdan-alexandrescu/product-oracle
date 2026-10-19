"""The company's module registry: built-in modules seeded as versioned data, company
overrides, template manifests and the company module policy.

Seeding follows the rule for built-in templates (``oracle/templates/builtins.py``):
an upgrade never overwrites what a company changed.

- A built-in module gets a packaged release as a new ``module_versions`` row only when
  the company has neither archived the module nor overridden it (its newest version has
  origin ``company``). Rows are never updated or deleted.
- A company override is a new version with origin ``company``, newer than every
  existing version; it becomes the module's effective release. A later packaged release
  is then offered as ``upgrade_available`` instead of being applied.
- A company module with a built-in's key (made before that built-in shipped) keeps the
  key; the built-in is not seeded for that company.
- Template manifests (``template_module_assignments``) are attached to the company's
  built-in PRD templates that are not archived. They never write a template or a
  template version (AUD-3). A manifest the company edited (any row with ``created_by``)
  is never replaced by a packaged one.

The company module policy is the ``module_policy`` company setting: which modules are
mandatory, relaxed to optional or disabled, and the default packs.
"""

import re
import uuid
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, Field, ValidationError, field_validator
from sqlalchemy import delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.modules.catalog import (
    MANIFEST_FORMAT,
    Manifest,
    builtin_contracts,
    builtin_manifests,
    builtin_packs,
)
from oracle.templates.builtins import BUILTIN_TEMPLATES_BY_KEY, builtin_body
from oracle.templates.models import Template, TemplateVersion
from oracle.templates.validation import check_template
from oracle.tenancy import current_tenant
from oracle.tenant_settings import TenantSetting
from oracle.v2.contract import (
    MODULE_ID_PATTERN,
    ModuleContract,
    contract_hash,
    contract_json,
    semver_key,
    validate_contract,
)
from oracle.v2.models import ModuleDefinition, ModuleVersion, TemplateModuleAssignment

POLICY_SETTING_KEY = "module_policy"


class RegistryError(ValueError):
    """A request the registry refuses; ``code`` is stable for clients."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class NotFound(LookupError):
    pass


# --- the loaded catalogue ---------------------------------------------------------------


@dataclass
class Entry:
    """A module as the company sees it: its definition and every release, oldest first."""

    definition: ModuleDefinition
    versions: list[ModuleVersion]

    @property
    def key(self) -> str:
        return self.definition.key

    @property
    def archived(self) -> bool:
        return self.definition.archived_at is not None

    @property
    def effective(self) -> ModuleVersion:
        return self.versions[-1]

    @property
    def contract(self) -> ModuleContract:
        return validate_contract(self.effective.contract)

    @property
    def origin(self) -> str:
        return self.effective.origin

    @property
    def upgrade_available(self) -> str | None:
        """A packaged release newer than the effective one that seeding did not apply."""
        packaged = builtin_contracts().get(self.key)
        if packaged is None or not self.definition.builtin:
            return None
        if semver_key(packaged.version) > semver_key(self.effective.version):
            return packaged.version
        return None

    def version(self, version: str) -> ModuleVersion | None:
        return next((v for v in self.versions if v.version == version), None)


@dataclass
class Catalog:
    entries: dict[str, Entry] = field(default_factory=dict)

    def available(self) -> dict[str, ModuleContract]:
        """Effective contracts of the modules that are not archived."""
        return {k: e.contract for k, e in self.entries.items() if not e.archived}

    def origins(self) -> dict[str, str]:
        return {k: e.origin for k, e in self.entries.items()}


async def load_catalog(session: AsyncSession) -> Catalog:
    definitions = (await session.scalars(select(ModuleDefinition))).all()
    versions = (await session.scalars(select(ModuleVersion))).all()
    by_module: dict[uuid.UUID, list[ModuleVersion]] = {}
    for v in versions:
        by_module.setdefault(v.module_id, []).append(v)
    catalog = Catalog()
    for d in sorted(definitions, key=lambda d: d.key):
        rows = sorted(by_module.get(d.id, []), key=lambda v: semver_key(v.version))
        if rows:
            catalog.entries[d.key] = Entry(d, rows)
    return catalog


# --- seeding ----------------------------------------------------------------------------


def _manifest_rows(manifest: Manifest) -> list[dict[str, Any]]:
    """The packaged manifest as assignment rows; policy from the packaged template body."""
    contracts = builtin_contracts()
    template = BUILTIN_TEMPLATES_BY_KEY[manifest.template]
    spine = set(check_template(builtin_body(template)).default_required_sections())
    rows = []
    for key, sections in manifest.modules.items():
        rows.append(
            {
                "module_key": key,
                "module_version": None,
                "policy": "required" if spine & set(sections) else "optional",
                "display_order": contracts[key].display_order,
                "section_ids": list(sections),
                "since_template_version": None,
                "manifest_format": MANIFEST_FORMAT,
            }
        )
    return rows


def _row_signature(rows: list[dict[str, Any]]) -> set[tuple]:
    return {
        (r["module_key"], r["module_version"], r["policy"], tuple(r["section_ids"])) for r in rows
    }


async def _pending(session: AsyncSession) -> tuple[list[ModuleContract], list[Template]]:
    """Packaged releases to add, and built-in templates whose manifest needs (re)seeding."""
    catalog = await load_catalog(session)
    definitions = {d.key: d for d in (await session.scalars(select(ModuleDefinition))).all()}
    releases: list[ModuleContract] = []
    for key, contract in builtin_contracts().items():
        d = definitions.get(key)
        if d is None:
            releases.append(contract)
            continue
        entry = catalog.entries.get(key)
        if not d.builtin or d.archived_at is not None:
            continue
        if entry is None:
            releases.append(contract)
            continue
        if entry.version(contract.version) is not None or entry.origin == "company":
            continue
        if semver_key(contract.version) > semver_key(entry.effective.version):
            releases.append(contract)

    manifests = builtin_manifests()
    templates = (
        await session.scalars(
            select(Template).where(
                Template.key.in_(list(manifests)),
                Template.builtin.is_(True),
                Template.archived_at.is_(None),
            )
        )
    ).all()
    rows = (await session.scalars(select(TemplateModuleAssignment))).all()
    by_template: dict[uuid.UUID, list[TemplateModuleAssignment]] = {}
    for r in rows:
        by_template.setdefault(r.template_id, []).append(r)
    stale: list[Template] = []
    for t in templates:
        existing = by_template.get(t.id, [])
        if any(r.created_by is not None for r in existing):
            continue  # the company edited this manifest
        current = _row_signature(
            [
                {
                    "module_key": r.module_key,
                    "module_version": r.module_version,
                    "policy": r.policy,
                    "section_ids": r.section_ids,
                }
                for r in existing
            ]
        )
        if current != _row_signature(_manifest_rows(manifests[t.key])):
            stale.append(t)
    return releases, stale


async def ensure_builtin_modules(session: AsyncSession) -> bool:
    """Seed packaged module releases and template manifests (no commit). True if added.

    Call after ``oracle.templates.builtins.ensure_builtins`` so the built-in templates
    exist. Concurrent callers are serialised by a transaction-scoped advisory lock.
    """
    releases, templates = await _pending(session)
    if not releases and not templates:
        return False
    tenant_id = current_tenant(session)
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": f"oracle-modules:{tenant_id}"}
    )
    releases, templates = await _pending(session)  # re-read under the lock
    for contract in releases:
        d = await session.scalar(
            select(ModuleDefinition).where(ModuleDefinition.key == contract.id)
        )
        if d is None:
            d = ModuleDefinition(
                key=contract.id,
                title=contract.title,
                description=contract.description,
                builtin=True,
            )
            session.add(d)
            await session.flush()
        else:
            d.title, d.description = contract.title, contract.description
        session.add(_version_row(d, contract, "builtin", None))
    manifests = builtin_manifests()
    for t in templates:
        await session.execute(
            delete(TemplateModuleAssignment).where(TemplateModuleAssignment.template_id == t.id)
        )
        for row in _manifest_rows(manifests[t.key]):
            session.add(TemplateModuleAssignment(template_id=t.id, **row))
    await session.flush()
    return bool(releases or templates)


def _version_row(
    d: ModuleDefinition, contract: ModuleContract, origin: str, created_by: uuid.UUID | None
) -> ModuleVersion:
    return ModuleVersion(
        module_id=d.id,
        version=contract.version,
        contract=contract_json(contract),
        contract_hash=contract_hash(contract),
        origin=origin,
        created_by=created_by,
    )


# --- company overrides and company modules ----------------------------------------------


def _contract(data: dict[str, Any], key: str | None = None) -> ModuleContract:
    try:
        contract = validate_contract(data)
    except ValidationError as e:
        first = e.errors()[0]
        where = ".".join(str(p) for p in first.get("loc", ()))
        raise RegistryError("invalid_contract", f"{where}: {first.get('msg')}") from None
    if key is not None and contract.id != key:
        raise RegistryError("key_mismatch", f"contract id {contract.id} is not {key}")
    return contract


async def _check_references(session: AsyncSession, contract: ModuleContract) -> None:
    catalog = await load_catalog(session)
    known = set(catalog.entries) | {contract.id}
    refs = (*contract.depends_on, *contract.conflicts_with, *contract.order_after)
    if unknown := sorted({r for r in (*refs, *contract.order_before) if r not in known}):
        raise RegistryError("unknown_module", f"names unknown modules: {', '.join(unknown)}")


async def create_override(
    session: AsyncSession, key: str, data: dict[str, Any], created_by: uuid.UUID | None
) -> ModuleVersion:
    """A company release of an existing module, newer than all its releases."""
    d = await session.scalar(select(ModuleDefinition).where(ModuleDefinition.key == key))
    if d is None:
        raise NotFound(f"module {key} not found")
    contract = _contract(data, key)
    versions = (
        await session.scalars(select(ModuleVersion).where(ModuleVersion.module_id == d.id))
    ).all()
    newest = max((v.version for v in versions), key=semver_key, default=None)
    if newest is not None and semver_key(contract.version) <= semver_key(newest):
        raise RegistryError(
            "version_not_newer", f"version {contract.version} must be newer than {newest}"
        )
    await _check_references(session, contract)
    row = _version_row(d, contract, "company", created_by)
    d.title, d.description = contract.title, contract.description
    session.add(row)
    await session.flush()
    return row


async def create_module(
    session: AsyncSession, data: dict[str, Any], created_by: uuid.UUID | None
) -> ModuleVersion:
    """A new company module (not a built-in)."""
    contract = _contract(data)
    exists = await session.scalar(
        select(ModuleDefinition.id).where(ModuleDefinition.key == contract.id)
    )
    if exists is not None or contract.id in builtin_contracts():
        raise RegistryError("key_taken", f"module {contract.id} already exists")
    await _check_references(session, contract)
    d = ModuleDefinition(
        key=contract.id,
        title=contract.title,
        description=contract.description,
        builtin=False,
        created_by=created_by,
    )
    session.add(d)
    await session.flush()
    row = _version_row(d, contract, "company", created_by)
    session.add(row)
    await session.flush()
    return row


# --- company module policy --------------------------------------------------------------

ModuleKey = Field(pattern=MODULE_ID_PATTERN, max_length=100)


class ModulePolicySettings(BaseModel):
    """The ``module_policy`` company setting (owner writes)."""

    # Mandatory in every composition, whatever the pack or template says.
    required: list[str] = Field(default=[], max_length=200)
    # Relaxed to optional (the company decides): suggested by nothing, addable by people.
    optional: list[str] = Field(default=[], max_length=200)
    # Never suggested or addable. A required module that depends on one fails clearly.
    disabled: list[str] = Field(default=[], max_length=200)
    # Packs a composition uses when none is chosen; empty: by category, else Pack A.
    default_packs: list[str] = Field(default=[], max_length=10)

    @field_validator("required", "optional", "disabled", "default_packs")
    @classmethod
    def _keys(cls, value: list[str]) -> list[str]:
        for key in value:
            if not re.match(MODULE_ID_PATTERN, key):
                raise ValueError(f"{key!r} is not a module or pack id")
        if len(set(value)) != len(value):
            raise ValueError("duplicates")
        return value

    def policy_for(self, key: str) -> str | None:
        if key in self.required:
            return "required"
        if key in self.disabled:
            return "disabled"
        if key in self.optional:
            return "optional"
        return None


async def read_policy(session: AsyncSession) -> tuple[ModulePolicySettings, TenantSetting | None]:
    row = await session.scalar(select(TenantSetting).where(TenantSetting.key == POLICY_SETTING_KEY))
    if row is None:
        return ModulePolicySettings(), None
    return ModulePolicySettings.model_validate(row.value), row


async def write_policy(
    session: AsyncSession, policy: ModulePolicySettings, updated_by: uuid.UUID | None
) -> TenantSetting:
    lists = {"required": policy.required, "optional": policy.optional, "disabled": policy.disabled}
    seen: dict[str, str] = {}
    for name, keys in lists.items():
        for key in keys:
            if key in seen:
                raise RegistryError(
                    "policy_overlap", f"{key} is both {seen[key]} and {name}; pick one"
                )
            seen[key] = name
    catalog = await load_catalog(session)
    if unknown := sorted(k for k in seen if k not in catalog.entries):
        raise RegistryError("unknown_module", f"unknown modules: {', '.join(unknown)}")
    if archived := sorted(k for k in policy.required if catalog.entries[k].archived):
        raise RegistryError("archived_module", f"archived modules: {', '.join(archived)}")
    if unknown := sorted(p for p in policy.default_packs if p not in builtin_packs()):
        raise RegistryError("unknown_pack", f"unknown packs: {', '.join(unknown)}")
    row = await session.scalar(select(TenantSetting).where(TenantSetting.key == POLICY_SETTING_KEY))
    value = policy.model_dump(mode="json")
    if row is None:
        row = TenantSetting(key=POLICY_SETTING_KEY, value=value, updated_by=updated_by)
        session.add(row)
    else:
        row.value = value
        row.updated_by = updated_by
    await session.flush()
    return row


# --- template manifests -----------------------------------------------------------------


async def read_manifest(session: AsyncSession, template_id: uuid.UUID) -> dict[str, Any]:
    """{module key: assignment row} for a template; empty when it has no manifest."""
    rows = (
        await session.scalars(
            select(TemplateModuleAssignment)
            .where(TemplateModuleAssignment.template_id == template_id)
            .order_by(TemplateModuleAssignment.display_order, TemplateModuleAssignment.module_key)
        )
    ).all()
    return {r.module_key: r for r in rows}


async def write_manifest(
    session: AsyncSession,
    template: Template,
    entries: list[dict[str, Any]],
    created_by: uuid.UUID | None,
) -> list[TemplateModuleAssignment]:
    """Replace a template's manifest (a company edit: rows carry ``created_by``).

    Refuses archived modules and sections the template's latest version does not have
    (a manifest maps the template's own {#id} sections)."""
    catalog = await load_catalog(session)
    latest = await session.scalar(
        select(TemplateVersion)
        .where(TemplateVersion.template_id == template.id)
        .order_by(TemplateVersion.version.desc())
        .limit(1)
    )
    sections = set(check_template(latest.body).section_keys) if latest is not None else set()
    seen_sections: dict[str, str] = {}
    keys: set[str] = set()
    for e in entries:
        key = e["module_key"]
        if key not in catalog.entries:
            raise RegistryError("unknown_module", f"unknown module {key}")
        if catalog.entries[key].archived:
            raise RegistryError("archived_module", f"{key} is archived")
        if unknown := [s for s in e["section_ids"] if s not in sections]:
            raise RegistryError(
                "unknown_section",
                f"template '{template.key}' has no section {', '.join(unknown)}",
            )
        if key in keys:
            raise RegistryError("duplicate_module", f"{key} is listed twice")
        keys.add(key)
        for s in e["section_ids"]:
            if s in seen_sections:
                raise RegistryError(
                    "section_mapped_twice", f"section {s} maps to {seen_sections[s]} and {key}"
                )
            seen_sections[s] = key
        version = e.get("module_version")
        if version is not None and catalog.entries[key].version(version) is None:
            raise RegistryError("unknown_version", f"{key} has no version {version}")
    await session.execute(
        delete(TemplateModuleAssignment).where(TemplateModuleAssignment.template_id == template.id)
    )
    rows = []
    for e in entries:
        row = TemplateModuleAssignment(
            template_id=template.id,
            module_key=e["module_key"],
            module_version=e.get("module_version"),
            policy=e["policy"],
            display_order=e.get("display_order")
            if e.get("display_order") is not None
            else catalog.entries[e["module_key"]].contract.display_order,
            section_ids=list(e["section_ids"]),
            since_template_version=e.get("since_template_version"),
            manifest_format=MANIFEST_FORMAT,
            created_by=created_by,
        )
        session.add(row)
        rows.append(row)
    await session.flush()
    return rows


__all__ = [
    "Catalog",
    "Entry",
    "ModulePolicySettings",
    "NotFound",
    "POLICY_SETTING_KEY",
    "RegistryError",
    "create_module",
    "create_override",
    "ensure_builtin_modules",
    "load_catalog",
    "read_manifest",
    "read_policy",
    "write_manifest",
    "write_policy",
]
