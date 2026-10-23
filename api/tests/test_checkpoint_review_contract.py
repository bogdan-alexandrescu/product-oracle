"""D1 Roadmap items review: the contract between the review screen's fixture and the API.

The web's Roadmap items review screen reads the shared draft (D8, ``GET …/review``), the
decide route's 409 bodies and the checkpoint's Approve fields. Its mock answers in the shapes
of web/lib/api/mock/checkpoint-review.json (web/e2e/roadmap-items-review.spec.ts checks the
mock against it). This test keeps that fixture honest: it validates against the API's
models, and the real routes, driven on a ``prd_to_roadmap`` run waiting at Roadmap items,
answer with every field the screen reads present and of the same JSON type. A field renamed
on either side fails it.

protects: the screen and the API agree; fails_when: a field the screen reads is missing,
renamed or retyped; no_claim: the screen's behaviour (Playwright) and the values the API
computes (test_checkpoint_review.py, test_approve_with_edits.py, test_checkpoint_gate.py).
Synthetic placeholders only."""

import json
from pathlib import Path
from typing import Any

from oracle.runs.schemas import CheckpointOut, CheckpointReview, Gate, NeedsAgents
from tests.test_approve_with_edits import DROP, LATER, NO_DATE, _stage, cp_of, edits  # noqa: F401
from tests.test_roadmap import owner, runtime  # noqa: F401 - fixtures
from tests.test_runs import get

FIXTURE = Path(__file__).resolve().parents[2] / "web/lib/api/mock/checkpoint-review.json"

# Every field the screen reads (web/app/runs/[id]/review/[checkpoint]/_items-review.tsx and
# components/review/DecisionBar.tsx), as dotted paths into the review.
REVIEW_FIELDS = [
    "checkpoint_id", "run_id", "kind", "status", "approver_role", "attempt", "revision",
    "wait", "wait.state", "wait.ends_at", "wait.seconds_left", "file", "file_problems",
    "items", "tally", "tally.need_you", "tally.handled", "tally.blocking_open",
    "tally.to_confirm_open", "tally.waiting_on", "tally.suggested", "note", "sent_review",
    "can_suggest", "can_stage", "can_decide", "gate", "gate.open", "gate.blocking_open",
    "gate.file_problems", "gate.left", "diff",
]  # fmt: skip
ITEM_FIELDS = [
    "key", "position", "title", "horizon", "milestone", "milestone.name", "milestone.date",
    "confidence", "rank", "outcome", "depends_on", "prd_section", "reasons", "actions",
    "state", "resolution", "diff",
]  # fmt: skip
REASON_FIELDS = ["item", "code", "severity", "label", "text", "data", "fixes"]
FIX_FIELDS = ["label", "action", "action.kind", "action.item", "action.field", "action.value"]
ACTION_FIELDS = [
    "id", "item_key", "kind", "field", "value", "answers", "state", "created_by",
    "created_by.name", "question",
]  # fmt: skip
GATE_LEFT_FIELDS = ["item", "item_title", "code", "label", "waivable"]
CONFLICT_FIELDS = {
    "review_changed": ["code", "message", "revision", "changes", "by"],
    "blocking_open": ["code", "message", "left"],
    "edits_leave_problems": ["code", "message", "left"],
    "needs_agents": ["code", "message", "actions"],
}

_MISSING = object()


def _fixture() -> dict[str, Any]:
    return json.loads(FIXTURE.read_text())


def _at(obj: Any, path: str) -> Any:
    value = obj
    for part in path.split("."):
        if not isinstance(value, dict) or part not in value:
            return _MISSING
        value = value[part]
    return value


def _kind(value: Any) -> str:
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int | float):
        return "number"
    return type(value).__name__


def _same_shape(got: dict, want: dict, paths: list[str], where: str) -> None:
    for path in paths:
        mine, theirs = _at(got, path), _at(want, path)
        assert mine is not _MISSING, f"{where}: the API has no {path}"
        assert theirs is not _MISSING, f"{where}: the fixture has no {path}"
        if mine is not None and theirs is not None:
            assert _kind(mine) == _kind(theirs), f"{where}.{path}: {_kind(mine)} != {_kind(theirs)}"


def test_the_fixture_is_the_apis_models():
    """protects=the fixture is a CheckpointReview, its 409 bodies name what the screen reads
    and its Approve fields are CheckpointOut's; fails_when=the fixture drifts from a model;
    no_claim=the real routes (the next tests)."""
    fx = _fixture()
    review = CheckpointReview.model_validate(fx["review"])
    assert review.kind == "roadmap_items" and review.items[0].reasons[0].fixes
    for code, fields in CONFLICT_FIELDS.items():
        body = fx["conflicts"][code]
        assert body["code"] == code and all(f in body for f in fields), code
    for left in fx["conflicts"]["blocking_open"]["left"]:
        Gate.model_validate({"open": False, "left": [left]})
    assert set(fx["checkpoint"]) <= set(CheckpointOut.model_fields)
    [NeedsAgents.model_validate(x) for x in fx["checkpoint"]["needs_agents"]]


async def test_the_review_route_carries_every_field_the_screen_reads(edits):  # noqa: F811
    """protects=the real GET …/review answers every field the screen reads, of the fixture's
    type, for the review, an item, its reason and fix, its staged action and the gate;
    fails_when=a field is missing or renamed on either side; no_claim=the values."""
    fx = _fixture()["review"]
    rv = edits
    await _stage(rv, NO_DATE)
    got = await rv.get("approver")
    _same_shape(got, fx, REVIEW_FIELDS, "review")
    item = next(i for i in got["items"] if i["key"] == "slack-alerts")
    want = fx["items"][0]
    _same_shape(item, want, ITEM_FIELDS, "item")
    _same_shape(item["reasons"][0], want["reasons"][0], REASON_FIELDS, "reason")
    _same_shape(item["reasons"][0]["fixes"][0], want["reasons"][0]["fixes"][0], FIX_FIELDS, "fix")
    _same_shape(item["actions"][0], want["actions"][0], ACTION_FIELDS, "action")
    assert got["gate"]["left"], got["gate"]
    _same_shape(got["gate"]["left"][0], fx["gate"]["left"][0], GATE_LEFT_FIELDS, "gate.left")


async def test_decide_409_bodies_and_the_approve_fields_match(edits):  # noqa: F811
    """protects=the four 409 bodies the screen shows (blocking_open, edits_leave_problems,
    needs_agents, review_changed) and CheckpointOut's approve_label and needs_agents carry the
    fixture's fields; fails_when=a body or field is renamed; no_claim=their wording."""
    fx = _fixture()
    rv = edits
    seen: dict[str, dict] = {}
    out = await rv.decide("approver", expect=409, decision="approved")
    seen[out["detail"]["code"]] = out["detail"]
    await _stage(rv, LATER)
    await _stage(rv, DROP)
    out = await rv.decide("approver", expect=409, decision="approved")
    seen[out["detail"]["code"]] = out["detail"]
    await _stage(rv, {"item_key": "budget-caps", "kind": "split",
                      "value": {"into": ["caps-ui", "caps-api"]}})  # fmt: skip
    cp = cp_of(await get(rv.client, rv.auth, rv.run["id"]), rv)
    _same_shape(cp, fx["checkpoint"], ["approve_label", "needs_agents"], "checkpoint")
    assert set(cp["needs_agents"][0]) == set(fx["checkpoint"]["needs_agents"][0])
    out = await rv.decide("approver", expect=409, decision="approved")
    seen[out["detail"]["code"]] = out["detail"]
    out = await rv.decide("approver", expect=409, decision="approved", expected_revision=0)
    seen[out["detail"]["code"]] = out["detail"]
    assert set(seen) == set(CONFLICT_FIELDS)
    for code, fields in CONFLICT_FIELDS.items():
        _same_shape(seen[code], fx["conflicts"][code], fields, code)
    for left in seen["edits_leave_problems"]["left"]:
        _same_shape(left, fx["conflicts"]["edits_leave_problems"]["left"][0], GATE_LEFT_FIELDS, "left")
