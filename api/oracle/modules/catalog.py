"""The packaged built-in modules, packs and template manifests (pure data, no database).

``builtin/core.yaml`` (the shared core), ``builtin/platform.yaml`` and one file per
industry pack (O1h) hold one release of each built-in module contract,
``builtin/packs.yaml`` the packs (§4.4 and O1h) and ``builtin/manifests.yaml`` the module
manifests of the seven built-in PRD templates. Everything is validated when
first loaded: a contract through :class:`oracle.v2.contract.ModuleContract`, a pack's
modules and a manifest's modules against the contracts. A broken file fails loudly at
import of the first caller (and in the test suite), never silently at request time.
"""

from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any

from oracle import safe_yaml
from oracle.v2.contract import ModuleContract, validate_contract

BUILTIN_DIR = Path(__file__).resolve().parent / "builtin"
MODULE_FILES = (
    "core.yaml",
    "platform.yaml",
    # Industry packs (O1h, 2026-10-19): each reuses the shared core of startup.standard.
    "marketplace.yaml",
    "fintech.yaml",
    "hardware.yaml",
    "saas.yaml",
    "smb.yaml",
    "enterprise.yaml",
)
MANIFEST_FORMAT = 1


@dataclass(frozen=True)
class Pack:
    id: str
    version: str
    title: str
    description: str
    # Every module of the pack, in order: the core pack's modules first, if it has one.
    modules: tuple[str, ...]
    # Composition categories that select this pack when none is chosen.
    categories: tuple[str, ...] = ()
    # The pack whose modules it reuses as its shared core (O1h); those modules keep their
    # own applies_to, so adding a pack never changes a core module's contract.
    core: str | None = None
    # The pack's own modules (all of them when it has no core).
    own: tuple[str, ...] = ()

    def member_packs(self) -> tuple[str, ...]:
        """Pack ids a module's applies_to may name to belong to this pack."""
        return (self.id, self.core) if self.core else (self.id,)


@dataclass(frozen=True)
class Manifest:
    """A template's module manifest: module key -> the template {#id} sections it maps."""

    template: str
    version: str
    format: int
    modules: dict[str, tuple[str, ...]]

    def section_owner(self) -> dict[str, str]:
        return {s: key for key, sections in self.modules.items() for s in sections}


class CatalogError(ValueError):
    pass


def _load(name: str) -> Any:
    return safe_yaml.load((BUILTIN_DIR / name).read_text(encoding="utf-8"))


@cache
def builtin_contracts() -> dict[str, ModuleContract]:
    """Every packaged module contract by id, in file order."""
    out: dict[str, ModuleContract] = {}
    for name in MODULE_FILES:
        for raw in _load(name):
            contract = validate_contract(raw)
            if contract.id in out:
                raise CatalogError(f"module {contract.id} is defined twice")
            out[contract.id] = contract
    _check_references(out)
    return out


def _check_references(contracts: dict[str, ModuleContract]) -> None:
    sections: dict[str, str] = {}
    for c in contracts.values():
        for ref in (*c.depends_on, *c.conflicts_with, *c.order_after, *c.order_before):
            if ref not in contracts:
                raise CatalogError(f"module {c.id} names unknown module {ref}")
        for s in c.effective_section_ids():
            if s in sections:
                raise CatalogError(f"section {s} belongs to {sections[s]} and {c.id}")
            sections[s] = c.id


@cache
def builtin_packs() -> dict[str, Pack]:
    contracts = builtin_contracts()
    out: dict[str, Pack] = {}
    categories: dict[str, str] = {}
    for raw in _load("packs.yaml"):
        own = tuple(raw["modules"])
        core_id = raw.get("core")
        if core_id is not None:
            core = out.get(core_id)
            if core is None or core.core is not None:
                raise CatalogError(f"pack {raw['id']}: core {core_id} must be an earlier pack")
            modules = core.modules + own
        else:
            modules = own
        pack = Pack(
            id=raw["id"],
            version=str(raw["version"]),
            title=raw["title"],
            description=" ".join(str(raw["description"]).split()),
            modules=modules,
            categories=tuple(raw.get("categories", ())),
            core=core_id,
            own=own,
        )
        if pack.id in out:
            raise CatalogError(f"pack {pack.id} is defined twice")
        if len(set(pack.modules)) != len(pack.modules):
            raise CatalogError(f"pack {pack.id} lists a module twice")
        for key in own:
            if key not in contracts:
                raise CatalogError(f"pack {pack.id} names unknown module {key}")
            if pack.id not in contracts[key].applies_to:
                raise CatalogError(f"module {key} does not list pack {pack.id} in applies_to")
        listed = {k for k, c in contracts.items() if pack.id in c.applies_to}
        if listed != set(own):
            raise CatalogError(f"pack {pack.id}: applies_to and modules disagree")
        for category in pack.categories:
            if category in categories:
                raise CatalogError(f"category {category} selects {categories[category]} too")
            categories[category] = pack.id
        out[pack.id] = pack
    return out


def pack_members(pack: Pack, contracts: dict[str, ModuleContract]) -> tuple[str, ...]:
    """The available modules of a pack, in pack order, then company modules that apply to
    it (or to its core) by id. A module whose applies_to no longer names the pack (a
    company override) leaves it."""
    names = set(pack.member_packs())
    listed = [k for k in pack.modules if k in contracts and names & set(contracts[k].applies_to)]
    extra = sorted(k for k, c in contracts.items() if k not in listed and names & set(c.applies_to))
    return tuple(listed + extra)


@cache
def builtin_manifests() -> dict[str, Manifest]:
    contracts = builtin_contracts()
    raw = _load("manifests.yaml")
    if raw.get("format") != MANIFEST_FORMAT:
        raise CatalogError(f"manifests.yaml must have format {MANIFEST_FORMAT}")
    out: dict[str, Manifest] = {}
    for template, modules in raw["templates"].items():
        seen: dict[str, str] = {}
        mapped: dict[str, tuple[str, ...]] = {}
        for key, sections in modules.items():
            if key not in contracts:
                raise CatalogError(f"manifest {template} names unknown module {key}")
            for s in sections:
                if s in seen:
                    raise CatalogError(f"manifest {template}: section {s} mapped twice")
                seen[s] = key
            mapped[key] = tuple(sections)
        out[template] = Manifest(template, str(raw["version"]), MANIFEST_FORMAT, mapped)
    return out


def default_pack_for(category: str | None) -> str:
    """The pack a composition uses when none is chosen: by category, else Pack A."""
    if category:
        for pack in builtin_packs().values():
            if category in pack.categories:
                return pack.id
    return "startup.standard"


__all__ = [
    "BUILTIN_DIR",
    "CatalogError",
    "MANIFEST_FORMAT",
    "Manifest",
    "Pack",
    "builtin_contracts",
    "builtin_manifests",
    "builtin_packs",
    "default_pack_for",
    "pack_members",
]
