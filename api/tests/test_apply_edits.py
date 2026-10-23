"""D7 Approve with edits: :func:`oracle.runs.apply_edits.apply` turns the staged actions of a
Roadmap items checkpoint into a new ``roadmap_items.yaml``, with no model call.

Pure unit tests: no database. The integration path is ``tests/test_approve_with_edits.py``.

Test cards (protects / fails_when / no_claim) head each test. Synthetic placeholders only.
"""

import uuid
from types import SimpleNamespace

import pytest

from oracle import safe_yaml
from oracle.runs import apply_edits

FILE = """\
version: 1
prd: {document: alerts-prd, version: 2}
items:
  - id: slack-alerts
    title: Slack alerts
    outcome: Owners hear about spikes in Slack
    horizon: now
    milestone: {name: Beta, date: 2026-11-30, date_source: ENG-1 estimate}
    confidence: high
    prd_section: s-1
  - id: mobile-push
    title: Mobile push
    outcome: Owners hear about spikes on the phone
    horizon: later
    confidence: low
    prd_section: s-2
  - id: budget-caps
    title: Budget caps
    outcome: Owners cap the monthly spend
    horizon: next
    depends_on: [mobile-push, slack-alerts]
    confidence: medium
    prd_section: s-3
"""


def act(item: str, kind: str, field: str | None = None, value=None, answers=()):
    return SimpleNamespace(
        id=uuid.uuid4(), item_key=item, kind=kind, field=field, value=value,
        answers=list(answers), note=None, state="staged",
    )  # fmt: skip


def items(text: str) -> list[dict]:
    return safe_yaml.load(text)["items"]


def by_id(text: str) -> dict[str, dict]:
    return {i["id"]: i for i in items(text)}


def test_horizon_edit_changes_only_that_field():
    """protects=an edit of horizon lands on its item; fails_when=another item or field
    changes; no_claim=the re-check."""
    out, applied = apply_edits.apply(FILE, [act("budget-caps", "edit", "horizon", "later")], {})
    got = by_id(out)
    assert got["budget-caps"]["horizon"] == "later"
    assert got["mobile-push"]["horizon"] == "later" and got["slack-alerts"]["horizon"] == "now"
    assert [e["text"] for e in applied] == ["budget-caps horizon next → later"]
    assert applied[0]["action"] == "change" and applied[0]["changes"] == {"horizon": "later"}


def test_removing_the_milestone_date_keeps_the_milestone_name():
    """protects=Remove date drops the date and its source only; fails_when=the date stays
    or the milestone name is lost; no_claim=adding a date (out of scope)."""
    out, applied = apply_edits.apply(FILE, [act("slack-alerts", "edit", "milestone_date")], {})
    assert by_id(out)["slack-alerts"]["milestone"] == {"name": "Beta"}
    assert applied[0]["text"] == "slack-alerts milestone date removed"


def test_text_fields_and_milestone_name():
    """protects=title, outcome, prd_section and milestone_name are set as staged;
    fails_when=a value is lost; no_claim=their bounds (D8 validates those)."""
    actions = [
        act("mobile-push", "edit", "title", "Phone alerts"),
        act("mobile-push", "edit", "outcome", "Owners see spikes on the phone"),
        act("mobile-push", "edit", "prd_section", "s-3"),
        act("mobile-push", "edit", "milestone_name", "GA"),
    ]
    got = by_id(apply_edits.apply(FILE, actions, {})[0])["mobile-push"]
    assert got["title"] == "Phone alerts" and got["outcome"] == "Owners see spikes on the phone"
    assert got["prd_section"] == "s-3" and got["milestone"] == {"name": "GA"}


def test_depends_on_add_and_remove():
    """protects=depends_on edits add and remove ids; fails_when=an id is duplicated or
    kept; no_claim=the order check."""
    out, _ = apply_edits.apply(
        FILE,
        [act("budget-caps", "edit", "depends_on", {"add": ["slack-alerts"],
                                                   "remove": ["mobile-push"]})],
        {},
    )  # fmt: skip
    assert by_id(out)["budget-caps"]["depends_on"] == ["slack-alerts"]


def test_drop_removes_the_item_and_every_reference_to_it():
    """protects=a drop leaves no dangling dependency; fails_when=the item or its id in a
    depends_on stays; no_claim=the reasons."""
    out, applied = apply_edits.apply(FILE, [act("mobile-push", "drop")], {})
    got = by_id(out)
    assert "mobile-push" not in got
    assert got["budget-caps"]["depends_on"] == ["slack-alerts"]
    assert applied == [{"id": "mobile-push", "action": "drop", "text": "mobile-push dropped"}]


def test_order_is_a_stable_topological_sort():
    """protects=Fix order puts an item after what it depends on and keeps the rest in its
    order; fails_when=the order breaks a dependency or moves unrelated items;
    no_claim=cycles (the check reports those)."""
    text = FILE.replace("depends_on: [mobile-push, slack-alerts]", "depends_on: []").replace(
        "    confidence: high\n", "    depends_on: [budget-caps]\n    confidence: high\n"
    )
    out, applied = apply_edits.apply(text, [act("slack-alerts", "edit", "order")], {})
    assert [i["id"] for i in items(out)] == ["mobile-push", "budget-caps", "slack-alerts"]
    assert applied[0]["reorder"] is True


def test_clear_removes_the_field():
    """protects=clear:<field> removes an optional field; fails_when=it stays;
    no_claim=which fields are clearable (D8)."""
    out, applied = apply_edits.apply(FILE, [act("mobile-push", "edit", "clear:confidence")], {})
    assert "confidence" not in by_id(out)["mobile-push"]
    assert applied[0]["text"] == "mobile-push confidence cleared"


def test_restore_copies_the_base_item_in_its_place():
    """protects=Keep (restore) brings back the comparison base's item; fails_when=it is
    missing or altered; no_claim=where the base comes from."""
    base = {"slack-alerts": {"id": "slack-alerts"},
            "csv-export": {"id": "csv-export", "title": "CSV export", "horizon": "next",
                           "outcome": "Owners export spikes", "prd_section": "s-1"},
            "mobile-push": {"id": "mobile-push"}}  # fmt: skip
    out, applied = apply_edits.apply(FILE, [act("csv-export", "restore")], base)
    assert [i["id"] for i in items(out)] == [
        "slack-alerts",
        "csv-export",
        "mobile-push",
        "budget-caps",
    ]
    assert by_id(out)["csv-export"]["title"] == "CSV export"
    assert applied[0]["text"] == "csv-export restored"


def test_accept_waive_and_answered_questions_change_nothing_but_are_recorded():
    """protects=no-change kinds leave the file alone and are listed; fails_when=the
    file changes; no_claim=the gate."""
    actions = [
        act("mobile-push", "accept"),
        act("mobile-push", "waive", value={"reason": "Fine"}, answers=["low_confidence"]),
        act("slack-alerts", "question", value={"asked_to": str(uuid.uuid4()), "text": "Sure?"}),
    ]
    out, applied = apply_edits.apply(FILE, actions, {})
    assert items(out) == items(FILE)
    assert [e["action"] for e in applied] == ["accept", "waive", "question"]


def test_an_edit_whose_item_is_gone_is_refused():
    """protects=no edit lands on nothing; fails_when=it is silently skipped;
    no_claim=the 409 (decide)."""
    edit = act("no-such-item", "edit", "horizon", "now")
    with pytest.raises(apply_edits.EditError) as caught:
        apply_edits.apply(FILE, [edit], {})
    assert caught.value.action_id == edit.id and "no-such-item" in str(caught.value)
    dep = act("budget-caps", "edit", "depends_on", {"add": ["nope"]})
    with pytest.raises(apply_edits.EditError, match="nope"):
        apply_edits.apply(FILE, [dep], {})


def test_key_order_is_kept_and_new_keys_come_last():
    """protects=the file reads as the agents wrote it; fails_when=keys are sorted;
    no_claim=comments (YAML drops them)."""
    out, _ = apply_edits.apply(FILE, [act("mobile-push", "edit", "milestone_name", "GA")], {})
    assert list(safe_yaml.load(out)) == ["version", "prd", "items"]
    assert list(by_id(out)["mobile-push"]) == [
        "id",
        "title",
        "outcome",
        "horizon",
        "confidence",
        "prd_section",
        "milestone",
    ]
    assert list(by_id(out)["slack-alerts"]) == [
        "id",
        "title",
        "outcome",
        "horizon",
        "milestone",
        "confidence",
        "prd_section",
    ]


def test_header_names_the_approver_and_the_count():
    """protects=the edited file says who edited it and that no agent ran; fails_when=the
    count or name is missing; no_claim=the date's zone (the Company's)."""
    from datetime import date

    head = apply_edits.header("Abe Approver", date(2026, 10, 21), 3, 1)
    assert head == (
        "# roadmap_items.yaml, edited at the Roadmap items checkpoint on 2026-10-21 by an "
        "approver\n# (Abe Approver): 3 edits applied by Oracle; no agent ran. The agents' "
        "attempt 1 is kept.\n"
    )
    assert "1 edit applied" in apply_edits.header("Abe", date(2026, 10, 21), 1, 2)


def test_agent_only_kinds_and_the_count():
    """protects=split, merge and an unanswered question need the agents; the count is the
    file-changing actions; fails_when=either is wrong; no_claim=the label's wording."""
    q = act("slack-alerts", "question", value={"asked_to": "x", "text": "Sure?"})
    q.question_id = uuid.uuid4()
    split = act("budget-caps", "split", value={"into": ["a", "b"]})
    staged = [act("mobile-push", "drop"), act("slack-alerts", "edit", "milestone_date"),
              act("mobile-push", "waive", value={"reason": "x"}), split, q]  # fmt: skip
    assert [a.id for a in apply_edits.needs_agents(staged, {q.question_id})] == [split.id, q.id]
    assert [a.id for a in apply_edits.needs_agents(staged, set())] == [split.id]
    assert apply_edits.edit_count(staged) == 2
    assert apply_edits.label(2) == "Approve with 2 edits"
    assert apply_edits.label(1) == "Approve with 1 edit" and apply_edits.label(0) == "Approve"
