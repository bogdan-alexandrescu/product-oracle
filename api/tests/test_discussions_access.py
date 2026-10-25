"""G1 Discussion model: the rules without the routes. Who reads, writes, adds people and
makes a private discussion open (the access truth table), the typed change registry's
payload validation, and how a subject becomes its lookup key.

Synthetic placeholders only.
"""

import itertools
import uuid

import pytest
from pydantic import ValidationError

from oracle.discussions import access, kinds
from oracle.discussions.models import CHANGE_KINDS, SUBJECT_KINDS
from oracle.discussions.service import SubjectError, parse_subject, subject_key

ROLES = ["viewer", "commenter", "approver", "owner"]
WRITERS = {"commenter", "approver", "owner"}


def _seat(role, visibility, participant, starter, **kw):
    return access.Seat(
        role=role, visibility=visibility, participant=participant, starter=starter, **kw
    )


CASES = list(itertools.product(ROLES, ["open", "private"], [True, False], [True, False]))


# protects=who reads and writes, per Discuss access (4 roles x open/private x participant
# x starter); fails_when=a viewer writes, a non-participant reads a private discussion, or a
# non-starter adds people to a private one; no_claim=the screens (covered by E2E).
@pytest.mark.parametrize(("role", "visibility", "participant", "starter"), CASES)
def test_the_access_truth_table(role, visibility, participant, starter):
    seat = _seat(role, visibility, participant, starter)
    reads = visibility == "open" or participant
    assert access.can_read(seat) is reads
    assert access.can_write(seat) is (reads and role in WRITERS)
    # Adding others: the starter alone on a private discussion; commenters and up on an open one.
    adds = (starter and participant) if visibility == "private" else role in WRITERS
    assert access.can_add(seat) is adds
    # Follow: any reader of an open discussion adds themselves.
    assert access.can_follow(seat) is (visibility == "open")
    # Close or reopen: the starter, or any approver who can read it.
    assert access.can_close(seat) is (reads and (starter or role in {"approver", "owner"}))
    # Make open: the starter of a private discussion, nobody else.
    assert access.can_make_open(seat) is (visibility == "private" and starter and participant)


# protects=rule 3.4.3: nobody is added while the author's finding stays below Summary, and it
# cannot be made open; panel chats are never made open; fails_when=either is allowed;
# no_claim=what Oracle reads of the finding (G2).
def test_the_private_finding_and_panel_chats_restrict_the_starter_too():
    finding = _seat("commenter", "private", True, True, author_only=True)
    assert access.can_read(finding) and access.can_write(finding)
    assert not access.can_add(finding)
    assert not access.can_make_open(finding)
    panel = _seat("approver", "private", True, True, origin="panel")
    assert access.can_add(panel)
    assert not access.can_make_open(panel)


# protects=the registry lists every kind the table's CHECK allows, each with a payload model,
# its subjects and its role, and none is offered before its pick lands (G3 switches on those
# whose path exists; C2, C6, C7, C8 and C9 landed the rest, and H1 added decision);
# fails_when=a kind is missing, unvalidated, or switched off; no_claim=proposing or staging
# (G3, G4).
def test_the_registry_covers_every_kind_and_only_landed_ones_are_available():
    assert set(kinds.REGISTRY) == set(CHANGE_KINDS)
    for name, kind in kinds.REGISTRY.items():
        assert kind.name == name
        assert kind.subjects and set(kind.subjects) <= set(SUBJECT_KINDS)
        assert kind.role in ("commenter", "approver")
        assert kind.lands_in
        assert kind.available(None) is True
    assert kinds.REGISTRY["section_edit"].subjects == ("document", "section")
    assert kinds.REGISTRY["conflict_pick"].role == "approver"


GOOD = {
    "section_edit": {"section_key": "outcomes", "instruction": "Measure from plan thresholds"},
    "goal_measure": {"entity_id": str(uuid.uuid4()), "metric": "activation", "target": 40},
    "entity_edit": {"entity_id": str(uuid.uuid4()), "field": "title", "value": "Activation"},
    "conflict_pick": {"conflict_id": str(uuid.uuid4()), "claim_index": 1, "reason": "Newer"},
    "answer": {"question_id": str(uuid.uuid4()), "body": "Yes, from the plan"},
    "ask_person": {
        "asked_to": str(uuid.uuid4()),
        "prompt": "Who owns detection?",
        "rationale": "Nobody is named",
        "category": "ownership",
    },
    "basis_record": {
        "prd_document_id": str(uuid.uuid4()),
        "kind": "estimate",
        "reference": "Sizing session",
        "supports_date": "2026-12-01",
    },
    "item_horizon": {"item_key": "R-1", "horizon": "next"},
    "item_outcome": {"item_key": "R-1", "outcome": "Fewer abandoned carts"},
    "item_drop": {"item_key": "R-1", "reason": "Out of scope"},
    "item_dependency": {"item_key": "R-1", "add": ["R-2"], "remove": []},
    "item_date_remove": {"item_key": "R-1"},
    "item_split": {"item_key": "R-1", "into": ["R-1a", "R-1b"]},
    "item_merge": {"item_key": "R-1", "with": ["R-2"]},
    "scope_feature": {"feature_id": str(uuid.uuid4()), "decision": "exclude", "reason": "Later"},
    "scope_requirement": {"op": "add", "text": "Saved cards"},
    "priority_move": {
        "feature_id": str(uuid.uuid4()),
        "above_feature_id": str(uuid.uuid4()),
        "reason": "Blocks onboarding",
    },
    "priority_pin": {"feature_id": str(uuid.uuid4()), "position": 3, "reason": "Committed"},
    "decision": {"title": "Ship caps first", "options": [{"key": "caps", "label": "Caps"}]},
}
BAD = {
    "section_edit": {"instruction": "No section"},
    "goal_measure": {"entity_id": "not-an-id"},
    "entity_edit": {"entity_id": str(uuid.uuid4()), "field": "title"},
    "conflict_pick": {"conflict_id": str(uuid.uuid4()), "claim_index": -1, "reason": "x"},
    "answer": {"question_id": str(uuid.uuid4()), "body": ""},
    "ask_person": {"asked_to": str(uuid.uuid4()), "prompt": "Who?"},
    "basis_record": {"prd_document_id": str(uuid.uuid4()), "kind": "estimate"},
    "item_horizon": {"item_key": "R-1", "horizon": "someday"},
    "item_outcome": {"item_key": "R-1"},
    "item_drop": {"item_key": "", "reason": "x"},
    "item_dependency": {"item_key": "R-1", "add": "R-2"},
    "item_date_remove": {"item_key": "R-1", "date": "2026-12-01"},
    "item_split": {"item_key": "R-1", "into": ["R-1a"]},
    "item_merge": {"item_key": "R-1", "with": []},
    "scope_feature": {"feature_id": str(uuid.uuid4()), "decision": "maybe", "reason": "x"},
    "scope_requirement": {"op": "rewrite"},
    "priority_move": {"feature_id": str(uuid.uuid4()), "reason": "x"},
    "priority_pin": {"feature_id": str(uuid.uuid4()), "position": 0, "reason": "x"},
    "decision": {"title": "", "reversibility": "maybe"},
}


# protects=each kind's payload is validated by its model; fails_when=a malformed payload of
# any kind is accepted or a well-formed one refused; no_claim=whether the target exists.
@pytest.mark.parametrize("name", sorted(GOOD))
def test_payload_validation_per_kind(name):
    assert set(GOOD) == set(BAD) == set(CHANGE_KINDS)
    parsed = kinds.validate_payload(name, GOOD[name])
    assert isinstance(parsed, dict)
    assert kinds.label(name, parsed)
    with pytest.raises(ValidationError):
        kinds.validate_payload(name, BAD[name])


# protects=the plain sentence a change reads as (3.3); fails_when=the wording drifts;
# no_claim=names looked up from ids.
def test_change_labels_read_as_the_spec_says():
    assert (
        kinds.label("section_edit", {"section_key": "outcomes", "instruction": "Add a target"})
        == "Change outcomes: Add a target"
    )
    assert kinds.label("item_horizon", {"item_key": "R-1", "horizon": "next"}) == "Move R-1 to Next"
    assert kinds.label("item_drop", {"item_key": "R-1", "reason": "Later"}) == "Drop R-1: Later"


DOC, RUN, CP = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()


# protects=a subject's lookup key, so a discussion follows its subject across versions and
# send-backs; fails_when=the version or the checkpoint id enters a key; no_claim=whether the
# subject exists (the API tests check that).
def test_subject_keys():
    section = {"document_id": str(DOC), "version": 3, "section_key": "outcomes"}
    assert subject_key("section", parse_subject("section", section)) == f"section:{DOC}:outcomes"
    v4 = {**section, "version": 4}
    assert subject_key("section", parse_subject("section", v4)) == f"section:{DOC}:outcomes"
    doc = parse_subject("document", {"document_id": str(DOC), "version": 1})
    assert subject_key("document", doc) == f"document:{DOC}"
    cp = parse_subject("checkpoint", {"run_id": str(RUN), "checkpoint_id": str(CP)})
    assert subject_key("checkpoint", cp, checkpoint_kind="prd_review") == (
        f"checkpoint:{RUN}:prd_review"
    )
    item = parse_subject(
        "checkpoint_item",
        {
            "run_id": str(RUN),
            "checkpoint_id": str(CP),
            "checkpoint_kind": "roadmap_items",
            "item_key": "R-1",
        },
    )
    assert subject_key("checkpoint_item", item) == f"run_item:{RUN}:roadmap_items:R-1"
    track = uuid.uuid4()
    assert subject_key("track", parse_subject("track", {"track_id": str(track)})) == (
        f"track:{track}"
    )
    with_milestone = parse_subject("track", {"track_id": str(track), "milestone": "beta"})
    assert subject_key("track", with_milestone) == f"track:{track}:beta"
    assert subject_key("priorities", parse_subject("priorities", {})) == "priorities"
    assert subject_key("screen", parse_subject("screen", {"path": "/plan"})) == "screen:/plan"
    for bad in ({"path": "plan"}, {"path": "/" + "x" * 200}):
        with pytest.raises(SubjectError):
            parse_subject("screen", bad)
    with pytest.raises(SubjectError):
        parse_subject("section", {"document_id": str(DOC), "version": 3})
