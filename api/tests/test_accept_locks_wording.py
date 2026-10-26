"""Accepting a baseline proposal locks the item (owner, 2026-10-25): everywhere the
product tells a person or an agent what Accept does, it says the item is then locked
against Oracle's changes until a person unlocks it."""

from pathlib import Path

from oracle.baseline import from_run
from oracle.main import app
from oracle.mcp.curated import CURATED
from oracle.mcp.tools import app_operations

LOCKED = "against Oracle's changes until a person unlocks it"
DOCS = Path(__file__).resolve().parents[2] / "docs"


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
    text = (DOCS / "build-brief.md").read_text()
    assert LOCKED in text
