"""#1570: the API's tests read only api/ and the contracts other trees publish in
docs/contracts; any other file of the checkout raises ForeignRead (tests/_own_tree_only.py).

Test card: protects=a test cannot read web/, docs prose or another tree directly;
fails_when=the guard is not armed, or lets a foreign read or import through;
no_claim=reads in a subprocess (a git or node child)."""

import importlib.util
from pathlib import Path

import pytest

from tests._own_tree_only import CONTRACTS, ROOT, ForeignRead, contract

if not (ROOT / "web").is_dir():
    pytest.skip("not a checkout: there is no other tree", allow_module_level=True)


def test_a_read_outside_api_raises():
    with pytest.raises(ForeignRead, match=r"web/package.json is outside api/"):
        (ROOT / "web" / "package.json").read_text()
    with pytest.raises(ForeignRead, match=r"docs/build-brief.md is outside api/"):
        open(ROOT / "docs" / "build-brief.md", encoding="utf-8")  # noqa: SIM115


def test_an_import_from_outside_api_raises():
    script = ROOT / ".github" / "scripts" / "cancel_superseded_runs.py"
    spec = importlib.util.spec_from_file_location("foreign", script)
    with pytest.raises(ForeignRead):
        spec.loader.exec_module(importlib.util.module_from_spec(spec))


def test_its_own_tree_and_the_contracts_are_read():
    assert "product-oracle-api" in (Path(__file__).parents[1] / "pyproject.toml").read_text()
    assert (CONTRACTS / "web-proxy.json").read_text()
    assert contract("web-proxy")["proxy_timeout_ms"] > 0


@pytest.mark.foreign_read("web/package.json", reason="the guard's own exception")
def test_a_named_foreign_file_is_read():
    assert '"name"' in (ROOT / "web" / "package.json").read_text()
    with pytest.raises(ForeignRead):
        (ROOT / "web" / "tsconfig.json").read_text()
