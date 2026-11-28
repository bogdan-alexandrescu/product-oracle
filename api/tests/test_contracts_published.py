"""#1570: the values the web's tests check against the API are published by the API as JSON
in docs/contracts (api-*), and the web's specs read only those copies.

Test card: protects=each api-* contract equals the fixture it copies; fails_when=a fixture
changes and its published copy does not (rewrite it with CONTRACTS_WRITE=1);
no_claim=what the web does with it (its own specs)."""

import json
import os
from pathlib import Path

import pytest

from tests._own_tree_only import CONTRACTS, contract

FIXTURES = Path(__file__).parent / "fixtures"


def _json(name: str):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def _request_verbs():
    from oracle.simple.change_words import VERB

    return VERB


PUBLISHED = {
    "api-audience-redaction": lambda: _json("audience_redaction.json"),
    "api-plan-strip-cases": lambda: _json("plan_strip_cases.json"),
    "api-code-left-out-cases": lambda: _json("code_left_out_cases.json"),
    # #1913: the verbs a waiting change is asked by (the Inbox's table, web/app/inbox).
    "api-request-verbs": lambda: _request_verbs(),
    "api-one-pager-contract": lambda: {
        "prd": (FIXTURES / "one_pager_contract.md").read_text(encoding="utf-8"),
        "contract": _json("one_pager_contract.json"),
    },
}


@pytest.mark.parametrize("name", PUBLISHED)
def test_the_apis_published_contract_is_its_fixture(name):
    """The API's published contract file matches what the API computes."""
    if not CONTRACTS.is_dir():
        pytest.skip("docs/contracts is not available (the API image)")
    value = PUBLISHED[name]()
    if os.environ.get("CONTRACTS_WRITE") == "1":
        text = json.dumps(value, indent=2, ensure_ascii=False) + "\n"
        (CONTRACTS / f"{name}.json").write_text(text, encoding="utf-8")
    assert contract(name) == value, f"docs/contracts/{name}.json: run with CONTRACTS_WRITE=1"
