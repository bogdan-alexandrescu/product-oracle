"""The packaged built-in modules, packs and template manifests (pure data, no database).

``builtin/core.yaml`` and ``builtin/platform.yaml`` hold one release of each built-in
module contract, ``builtin/packs.yaml`` the two packs (§4.4) and ``builtin/manifests.yaml``
the module manifests of the seven built-in PRD templates. Everything is validated when
first loaded: a contract through :class:`oracle.v2.contract.ModuleContract`, a pack's
modules and a manifest's modules against the contracts. A broken file fails loudly at
import of the first caller (and in the test suite), never silently at request time.
"""

from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any

import yaml

from oracle.v2.contract import ModuleContract, validate_contract

BUILTIN_DIR = Path(__file__).resolve().parent / "builtin"
MODULE_FILES = ("core.yaml", "platform.yaml")
MANIFEST_FORMAT = 1


@dataclass(frozen=True)
class Pack:
    id: str
    version: str
    title: str
    description: str
    modules: tuple[str, ...]
    # Composition categories that select this pack when none is chosen.
    categories: tuple[str, ...] = ()


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
    return yaml.safe_load((BUILTIN_DIR / name).read_text(encoding="utf-8"))


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
    for raw in _load("packs.yaml"):
        pack = Pack(
            id=raw["id"],
            version=str(raw["version"]),
            title=raw["title"],
            description=" ".join(str(raw["description"]).split()),
            modules=tuple(raw["modules"]),
            categories=tuple(raw.get("categories", ())),
        )
        if len(set(pack.modules)) != len(pack.modules):
            raise CatalogError(f"pack {pack.id} lists a module twice")
        for key in pack.modules:
            if key not in contracts:
                raise CatalogError(f"pack {pack.id} names unknown module {key}")
            if pack.id not in contracts[key].applies_to:
                raise CatalogError(f"module {key} does not list pack {pack.id} in applies_to")
        listed = {k for k, c in contracts.items() if pack.id in c.applies_to}
        if listed != set(pack.modules):
            raise CatalogError(f"pack {pack.id}: applies_to and modules disagree")
        out[pack.id] = pack
    return out


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
]
