"""D4 A note is all the agents get: a structured review file per checkpoint.

Request changes (send back) builds ``review.yaml`` from the checkpoint's shared draft (D8):
the staged actions only, one entry per item, the items left alone under ``unchanged``, the
blocking reasons nothing answers under ``problems_open``, the waivers under ``waived`` and the
note as ``general_note``. It is stored on the checkpoint (``checkpoints.review``) and is what
the agents of the revise round get: the rendered YAML as the change request (segment mode)
or one line per entry as the findings (workflow mode). ``GET .../review.yaml`` serves it.

Unit tests check :mod:`oracle.runs.review_file`; the integration tests wait a
``prd_to_roadmap`` run at its Roadmap items checkpoint on the FakeRuntime (segment mode) and
a ``feedback_loop`` run on the SwarmCloud fake (workflow mode), against Postgres.

Test cards (protects / fails_when / no_claim) head each test. Made-up names only.
"""

import uuid
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from oracle import safe_yaml
from oracle.runs import review_file
from oracle.runs.schemas import ReviewAction, ReviewAnswer, ReviewAnswerer, ReviewQuestion
from tests.test_adapter_v2 import feedback_doc, on, use
from tests.test_adapter_v2 import settings as _v2_settings
from tests.test_checkpoint_review import WAIVE, Review, item_of, review  # noqa: F401 - fixtures
from tests.test_roadmap import approved_prd, owner, runtime, seed_baseline  # noqa: F401
from tests.test_runs import get, pending, started, tick

settings = _v2_settings

RUN = uuid.UUID("00000000-0000-0000-0000-0000000000a1")
EMPTY = "Stage a change, ask a question, or write a note to send back."


def cp(kind: str = "roadmap_items", attempt: int = 1):
    return SimpleNamespace(
        kind=kind,
        run_id=RUN,
        payload={"segment": "roadmap_items", "segment_seq": 1, "attempt": attempt},
    )


def act(item: str, kind: str, field=None, value=None, *, state="staged", **kw) -> ReviewAction:
    return ReviewAction(
        id=uuid.uuid4(),
        item_key=item,
        kind=kind,
        field=field,
        value=value,
        state=state,
        updated_at=datetime(2026, 10, 21, tzinfo=UTC),
        **kw,
    )


def reason(item: str, code: str, severity: str = "blocking", text: str = "A reason") -> dict:
    return {"item": item, "code": code, "severity": severity, "text": text}


ITEMS = ["budget-caps", "slack-alerts", "mobile-push", "per-seat", "thresholds", "email-alerts"]


# --- unit: build_review ------------------------------------------------------------------


def test_two_edits_of_one_item_merge_into_one_change_entry_with_the_files_field_names():
    """protects=every edit of an item reaches the agents in one entry keyed by the item
    file's own field names; fails_when=an edit is lost, two entries, or milestone_date /
    milestone_name leak instead of milestone.date / milestone.name; no_claim=delivery."""
    got = review_file.build_review(
        cp(),
        [
            act("budget-caps", "edit", "depends_on", {"remove": ["anomaly-detection"]},
                answers=["horizon_breaks_dependency"], note="Caps ship on plan thresholds"),
            act("budget-caps", "edit", "outcome", "Finance can stop spend at a set amount"),
            act("slack-alerts", "edit", "milestone_date", None, answers=["unverified_date"]),
            act("slack-alerts", "edit", "milestone_name", "Beta"),
            act("slack-alerts", "edit", "horizon", "next"),
        ],
        ITEMS,
        [],
        None,
        1,
    )  # fmt: skip
    assert got["items"] == [
        {
            "id": "budget-caps",
            "action": "change",
            "changes": {
                "depends_on": {"remove": ["anomaly-detection"]},
                "outcome": "Finance can stop spend at a set amount",
            },
            "answers": ["horizon_breaks_dependency"],
            "note": "Caps ship on plan thresholds",
        },
        {
            "id": "slack-alerts",
            "action": "change",
            "changes": {"milestone": {"date": None, "name": "Beta"}, "horizon": "next"},
            "answers": ["unverified_date"],
        },
    ]


def test_clear_and_order_edits_map_to_a_null_field_and_reorder():
    """protects=clear:<field> and Fix order reach the agents; fails_when=clear:confidence is
    sent under its action name, or order is a field change; no_claim=how the agents reorder."""
    got = review_file.build_review(
        cp(),
        [
            act("budget-caps", "edit", "clear:confidence", None),
            act("budget-caps", "edit", "order", {"after": "thresholds"}),
            act("per-seat", "edit", "order", None),
        ],
        ITEMS,
        [],
        None,
        1,
    )
    assert got["items"] == [
        {
            "id": "budget-caps",
            "action": "change",
            "changes": {"confidence": None},
            "reorder": True,
            "after": "thresholds",
        },
        {"id": "per-seat", "action": "change", "reorder": True},
    ]


def test_accept_drop_restore_split_and_merge_are_entries_of_their_own():
    """protects=each D8 action word reaches the agents; fails_when=an action is lost or
    mis-mapped; no_claim=delivery."""
    got = review_file.build_review(
        cp(),
        [
            act("thresholds", "accept", answers=["low_confidence"]),
            act("mobile-push", "drop", answers=["serves_no_goal"]),
            act("legacy-export", "restore"),
            act("per-seat", "split", value={"into": ["per-seat-a", "per-seat-b"]},
                note="Split admin alerts from member alerts"),
            act("email-alerts", "merge", value={"with": ["slack-alerts"]}),
        ],
        ITEMS,
        [],
        None,
        1,
    )  # fmt: skip
    assert got["items"] == [
        {"id": "mobile-push", "action": "drop", "answers": ["serves_no_goal"]},
        {
            "id": "per-seat",
            "action": "split",
            "into": ["per-seat-a", "per-seat-b"],
            "note": "Split admin alerts from member alerts",
        },
        {"id": "thresholds", "action": "accept", "answers": ["low_confidence"]},
        {"id": "email-alerts", "action": "merge", "with": ["slack-alerts"]},
        {"id": "legacy-export", "action": "restore"},
    ]


def test_a_question_carries_who_was_asked_and_the_latest_answer():
    """protects=what a teammate answered reaches the agents; fails_when=the answer or the
    person is missing, or an unanswered question has no null answer; no_claim=C2 asking."""
    answered = ReviewQuestion(
        id=uuid.uuid4(),
        status="answered",
        text="Is there evidence beyond one thread?",
        asked_to=ReviewAnswerer(name="Robin Example"),
        answer=ReviewAnswer(kind="answer", body="Two support tickets this month"),
    )
    open_ = ReviewQuestion(id=uuid.uuid4(), status="asked", text="Who owns it?")
    got = review_file.build_review(
        cp(),
        [
            act("budget-caps", "question", value={"text": "x"}, question=answered),
            act("slack-alerts", "question", value={"text": "Who owns it?"}, question=open_),
        ],
        ITEMS,
        [],
        None,
        1,
    )
    assert got["items"] == [
        {
            "id": "budget-caps",
            "action": "question",
            "question": "Is there evidence beyond one thread?",
            "asked_to": "Robin Example",
            "answer": "Two support tickets this month",
        },
        {
            "id": "slack-alerts",
            "action": "question",
            "question": "Who owns it?",
            "asked_to": None,
            "answer": None,
        },
    ]


def test_suggested_actions_are_not_sent():
    """protects=only what an approver staged reaches the agents (AC3); fails_when=a
    commenter's suggestion is in the review; no_claim=role checks."""
    got = review_file.build_review(
        cp(), [act("mobile-push", "drop", state="suggested")], ITEMS, [], "Tighten it", 1
    )
    assert got["items"] == []
    assert "mobile-push" in got["unchanged"]
    assert got["general_note"] == "Tighten it"


def test_unchanged_problems_open_and_waived():
    """protects=the agents know what to leave alone, what is still blocking and what was
    waived; fails_when=an item with an entry, a waiver or an open reason is listed as
    unchanged, a handled reason is open, or a waiver is lost; no_claim=the reasons (D2)."""
    got = review_file.build_review(
        cp(),
        [
            act("mobile-push", "drop"),
            act("per-seat", "waive", value={"reason": "Outcome is in the PRD section"}),
            act("budget-caps", "edit", "title", "Caps", answers=["missing_field"]),
        ],
        ITEMS,
        [
            reason("per-seat", "missing_field"),
            reason("mobile-push", "serves_no_goal", "confirm"),
            reason("budget-caps", "missing_field"),
            reason("budget-caps", "unknown_prd_section", text="Section x is not in the PRD"),
            reason("email-alerts", "low_confidence", "confirm"),
            reason("thresholds", "unknown_dependency", text="y is not an item"),
        ],
        None,
        2,
    )
    assert got["waived"] == [
        {"id": "per-seat", "code": "missing_field", "reason": "Outcome is in the PRD section"}
    ]
    assert got["problems_open"] == [
        {"id": "budget-caps", "code": "unknown_prd_section", "text": "Section x is not in the PRD"},
        {"id": "thresholds", "code": "unknown_dependency", "text": "y is not an item"},
    ]
    # No entry, no waiver, no open reason (email-alerts has an open one to confirm).
    assert got["unchanged"] == ["slack-alerts"]
    assert got["attempt"] == 2


def test_the_fixed_keys_in_order():
    """protects=one file format for every checkpoint; fails_when=a key is missing or
    reordered; no_claim=other kinds' entry builders."""
    got = review_file.build_review(cp(), [], ITEMS, [], None, 1)
    assert list(got) == [
        "version", "checkpoint", "run", "segment", "attempt", "file", "items", "unchanged",
        "problems_open", "waived", "general_note",
    ]  # fmt: skip
    assert (got["version"], got["checkpoint"], got["run"], got["segment"], got["file"]) == (
        1,
        "roadmap_items",
        str(RUN),
        "roadmap_items",
        "roadmap_items.yaml",
    )


def test_a_kind_without_an_entry_builder_sends_the_note_alone():
    """protects=checkpoints without item rows send today's content in the new shape;
    fails_when=actions of an unregistered kind become entries or the note is lost;
    no_claim=later specs' builders (C7, F4, D10)."""
    assert "roadmap_items" in review_file.ENTRY_BUILDERS
    assert "priority_order" not in review_file.ENTRY_BUILDERS
    got = review_file.build_review(
        cp("priority_order"), [act("x", "accept")], ["x"], [], "Rank billing first", 1
    )
    assert got["items"] == [] and got["unchanged"] == []
    assert got["general_note"] == "Rank billing first" and got["file"] is None


# --- unit: render_yaml and findings ------------------------------------------------------


def _full() -> dict:
    return review_file.build_review(
        cp(),
        [
            act("budget-caps", "edit", "depends_on", {"remove": ["anomaly-detection"]},
                answers=["horizon_breaks_dependency"], note="Caps ship on plan thresholds"),
            act("budget-caps", "edit", "outcome", 'Finance can stop spend: "a set amount"'),
            act("slack-alerts", "edit", "milestone_date", None),
            act("mobile-push", "drop"),
        ],
        ITEMS,
        [],
        "Keep it short",
        1,
    )  # fmt: skip


def test_render_yaml_parses_back_to_the_stored_dict_with_its_header():
    """protects=the agents get parseable YAML equal to what is stored (AC4); fails_when=the
    YAML does not parse with safe_yaml or differs; no_claim=agent behaviour."""
    sent = _full()
    text = review_file.render_yaml(sent, datetime(2026, 10, 21, tzinfo=UTC))
    lines = text.splitlines()
    assert lines[0] == (
        "# Review of roadmap_items.yaml, attempt 1, at the Roadmap items checkpoint."
    )
    assert lines[1] == (
        "# Sent back by an approver on 2026-10-21. Apply each entry; answer each in resolutions."
    )
    assert lines[2] == "version: 1"
    assert safe_yaml.load(text) == sent
    assert "milestone_date" not in text and "milestone:" in text


def test_findings_lead_one_line_per_entry_unchanged_and_note():
    """protects=workflow mode's list of strings carries every entry (AC5); fails_when=the
    lead does not name get_checkpoint_review or an entry has no line; no_claim=SwarmCloud."""
    lines = review_file.findings(_full())
    assert lines[0] == (
        "Structured review of roadmap_items.yaml, attempt 1: 3 entries. "
        "The full review: get_checkpoint_review."
    )
    assert lines[1] == (
        "budget-caps: change depends_on remove anomaly-detection; outcome "
        '"Finance can stop spend: \\"a set amount\\"" (answers: horizon_breaks_dependency). '
        "Note: Caps ship on plan thresholds"
    )
    assert lines[2] == "slack-alerts: change milestone date null"
    assert lines[3] == "mobile-push: drop"
    assert lines[4] == "Unchanged: per-seat, thresholds, email-alerts"
    assert lines[5] == "Note: Keep it short"
    assert len(lines) == 6


def test_findings_put_oracles_check_after_the_note():
    """protects=the person's note comes before Oracle's check, as before D4 (D5); fails_when=
    the check sits between the review and its note; no_claim=SwarmCloud."""
    check = ["Oracle's check found these problems in prd.md; fix each one:", "Oracle refused"]
    lines = review_file.findings(_full(), check)
    assert lines[-3:] == ["Note: Keep it short", *check]


def test_findings_are_capped_at_200_lines():
    """protects=a long review stays a bounded answer; fails_when=more than 200 lines or no
    pointer to the rest; no_claim=what the agent reads next."""
    many = [f"item-{n}" for n in range(400)]
    sent = review_file.build_review(cp(), [act(i, "drop") for i in many], many, [], None, 1)
    lines = review_file.findings(sent)
    assert len(lines) == 200
    assert lines[-1] == "(… more in get_checkpoint_review)"
    assert lines[1] == "item-0: drop"


# --- integration: segment mode -----------------------------------------------------------


async def _answer(review: Review, question_id: str, body: str) -> None:  # noqa: F811
    resp = await review.client.post(
        f"/v1/questions/{question_id}/answers",
        json={"kind": "answer", "body": body},
        headers=review.h("commenter"),
    )
    assert resp.status_code == 201, resp.text


async def test_a_send_back_with_staged_actions_and_no_note_stores_the_review(review, runtime):  # noqa: F811
    """protects=every staged decision is stored and reaches the re-run's prompt (AC1, AC3,
    AC4, AC7); fails_when=a note is required, an action is lost or mis-mapped, a suggestion
    is sent, or the prompt carries no YAML; no_claim=what the agents do with it."""
    await review.act("approver", item_key="mobile-push", kind="edit", field="horizon",
                     value="next", answers=["low_confidence"])  # fmt: skip
    await review.act("approver", item_key="mobile-push", kind="edit", field="milestone_date",
                     value=None)  # fmt: skip
    await review.act("approver", item_key="gift-cards", kind="drop")
    got = await review.act(
        "approver",
        item_key="payment-step",
        kind="question",
        value={"asked_to": review.id("commenter"), "text": "Is the card vault ready?"},
    )
    [question] = item_of(got, "payment-step")["actions"]
    await _answer(review, question["question"]["id"], "Yes, since last sprint")
    await review.act("approver", item_key="payment-step", kind="waive",
                     value={"reason": "Accepted for the beta"})  # fmt: skip
    # A commenter's suggestion is not sent.
    await review.act("commenter", item_key="payment-step", kind="accept")

    run = await review.decide("approver", decision="changes_requested")
    [cp_out] = [c for c in run["checkpoints"] if c["id"] == review.cp["id"]]
    assert cp_out["status"] == "changes_requested"
    sent = cp_out["review"]
    assert sent["checkpoint"] == "roadmap_items" and sent["attempt"] == 1
    assert sent["file"] == "roadmap_items.yaml" and sent["run"] == review.run["id"]
    asked = (await review.get("viewer"))["items"]
    asked_to = item_of({"items": asked}, "payment-step")["actions"][0]["question"]["asked_to"]
    assert sent["items"] == [
        {
            "id": "payment-step",
            "action": "question",
            "question": "Is the card vault ready?",
            "asked_to": asked_to["name"],
            "answer": "Yes, since last sprint",
        },
        {
            "id": "mobile-push",
            "action": "change",
            "changes": {"horizon": "next", "milestone": {"date": None}},
            "answers": ["low_confidence"],
        },
        {"id": "gift-cards", "action": "drop"},
    ]
    assert [w["id"] for w in sent["waived"]] == ["payment-step"]
    assert {w["reason"] for w in sent["waived"]} == {"Accepted for the beta"}
    assert sent["unchanged"] == [] and sent["general_note"] is None
    assert "accept" not in [e["action"] for e in sent["items"]]

    # No note: the attempt shows none (never the YAML); the agents still get the file.
    [seg] = [s for s in run["segments"] if s["name"] == "roadmap_items"]
    assert seg["attempts"][-1]["note"] is None
    # The re-run's first step has the YAML, after the instruction lines.
    spec = runtime.submitted[-1]
    assert spec.labels["attempt"] == "2"
    first = spec.steps[0].prompt
    assert (
        "The reviewer sent roadmap_items.yaml back with a structured review (review.yaml, "
        "below). Start from your previous roadmap_items.yaml." in first
    )
    assert "do not change items under `unchanged` unless an entry forces it" in first
    assert "Answer every entry under `resolutions`." in first
    text = review_file.render_yaml(sent, datetime.now(UTC))
    body = "\n".join(line for line in text.splitlines() if not line.startswith("#"))
    assert body in first
    assert safe_yaml.load(text) == sent

    # The D8 read and the file route serve what was sent.
    read = await review.get("viewer")
    assert read["sent_review"] == sent
    assert safe_yaml.load(read["sent_review_yaml"]) == sent
    resp = await review.client.get(f"{review.base}/review.yaml", headers=review.h("viewer"))
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/plain")
    assert resp.text.startswith("# Review of roadmap_items.yaml, attempt 1")
    assert safe_yaml.load(resp.text) == sent


async def test_nothing_to_send_is_422_and_a_note_alone_works_as_today(review):  # noqa: F811
    """protects=a send-back always says something, and a note alone still works (AC2, AC6);
    fails_when=an empty send-back is accepted, a note-only one is refused, or review.yaml is
    served while pending; no_claim=the console's Redo."""
    resp = await review.client.get(f"{review.base}/review.yaml", headers=review.h("viewer"))
    assert resp.status_code == 404
    # A suggestion is not something to send.
    await review.act("commenter", item_key="gift-cards", kind="drop")
    out = await review.decide("approver", expect=422, decision="changes_requested")
    assert out["detail"] == EMPTY
    run = await review.decide(
        "approver", decision="changes_requested", note="Keep the shipping step next"
    )
    [cp_out] = [c for c in run["checkpoints"] if c["id"] == review.cp["id"]]
    assert cp_out["review"]["items"] == []
    assert cp_out["review"]["general_note"] == "Keep the shipping step next"
    resp = await review.client.get(f"{review.base}/review.yaml", headers=review.h("viewer"))
    assert resp.status_code == 200
    assert safe_yaml.load(resp.text)["general_note"] == "Keep the shipping step next"


async def test_an_approval_stores_no_review(review):  # noqa: F811
    """protects=only a send-back has a review file; fails_when=an approval serves one;
    no_claim=approve with edits (D7)."""
    await review.act("approver", **WAIVE)  # D3: the gate open first
    run = await review.decide("approver", decision="approved")
    [cp_out] = [c for c in run["checkpoints"] if c["id"] == review.cp["id"]]
    assert cp_out["review"] is None
    resp = await review.client.get(f"{review.base}/review.yaml", headers=review.h("viewer"))
    assert resp.status_code == 404
    assert (await review.get("viewer"))["sent_review"] is None


# --- integration: workflow mode ----------------------------------------------------------


@pytest.fixture
async def v2_owner():
    from tests.fixtures import seed_auth

    return await seed_auth()


async def test_workflow_mode_posts_the_review_as_findings(client, v2_owner):
    """protects=the revise step reads the structured review (AC5); fails_when=the findings
    are the bare note, the lead does not name get_checkpoint_review, or they are unbounded;
    no_claim=real SwarmCloud."""
    tenant_id, auth = v2_owner
    swarm = on()
    use(swarm)
    await feedback_doc(client, auth, tenant_id)
    run = await started(client, auth, flow="feedback_loop", document="checkout-redesign")
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    cp_id = pending(run)["id"]
    resp = await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{cp_id}/decide",
        json={"decision": "changes_requested", "note": "Tighten the scope"},
        headers=auth,
    )
    assert resp.status_code == 200, resp.text
    [answer] = swarm.answers
    findings = answer["payload"]["findings"]
    assert answer["payload"]["verdict"] == "NOT_YET"
    assert "get_checkpoint_review" in findings[0]
    assert findings[0].startswith("Structured review of ")
    assert "Note: Tighten the scope" in findings
    assert len(findings) <= 200
    [cp_out] = [c for c in resp.json()["checkpoints"] if c["id"] == cp_id]
    assert cp_out["review"]["general_note"] == "Tighten the scope"
