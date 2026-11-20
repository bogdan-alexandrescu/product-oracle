"""Accepting a baseline proposal locks the item (owner, 2026-10-25): everywhere the
product tells a person or an agent what Accept does, it says the item is then locked
against Oracle's changes until a person unlocks it."""

from oracle.baseline import from_run
from oracle.main import app
from oracle.mcp.curated import CURATED
from oracle.mcp.tools import app_operations
from tests._own_tree_only import contract

LOCKED = "against Oracle's changes until a person unlocks it"


def test_the_accept_tool_says_the_item_is_locked():
    ops = {(o.method, o.path): o for o in app_operations(app)}
    accept = ops[("POST", "/v1/baseline/proposals/{proposal_id}/accept")]
    assert LOCKED in accept.tool_description()
    assert "``" not in accept.tool_description()


def test_the_propose_change_tool_says_accepting_locks_the_item():
    (propose,) = [c for c in CURATED if c.name == "propose_change"]
    assert LOCKED in propose.description


def test_the_from_run_reason_says_accepting_keeps_the_item_locked():
    assert LOCKED in from_run.ACCEPT_KEEPS_LOCKED


def test_the_docs_say_what_accept_does():
    """docs/build-brief.md says it, as the docs publish in docs/contracts/docs-wording.json
    (#1570; docs/contracts/check.py keeps the two the same)."""
    assert LOCKED in contract("docs-wording")["says"]["build-brief.md"]
