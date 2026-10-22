"""B4 Proposal sentences: every baseline proposal reads as one plain sentence.

Table-driven over describe(). The mock layer's TypeScript port (web/lib/api/mock/describe.ts)
is checked against the same strings by web/e2e/baseline.spec.ts.

Card for each case of test_describe_table:
  protects: the approver reads what a proposal changes, from what, in plain words.
  fails_when: the sentence omits the old value, shows a field path (attrs.) or an id,
    names the wrong item or link, lists a field whose value is unchanged (#262), or shows a
    long text change as two identical prefixes.
  no_claim: English only; no check of tone.
"""

import re
import uuid

import pytest

from oracle.baseline.describe import describe
from oracle.baseline.models import Edge, Entity, Proposal

DARK = Entity(
    id=uuid.uuid4(),
    type="feature",
    title="Dark mode",
    body="A dark theme.",
    status="proposed",
    attrs={"status": "idea", "effort": "M", "release_window": "Q1"},
)
SETTINGS = Entity(
    id=uuid.uuid4(), type="feature", title="Saved carts", status="confirmed", attrs={}
)
GOAL = Entity(
    id=uuid.uuid4(),
    type="goal",
    title="Raise activation",
    status="confirmed",
    attrs={"weight": 0.5},
)
CRIT = Entity(id=uuid.uuid4(), type="acceptance_criterion", title="Loads fast", attrs={})
SHOPS = Entity(
    id=uuid.uuid4(),
    type="goal",
    title="Reach paid shops",
    body="Reach fifty paid shops a day by the end of the second quarter of next year.",
    status="confirmed",
    attrs={
        "weight": 0.5,
        "metric": "Shops that take a paid order on their first day of opening their doors",
    },
)
ENTITIES = {e.id: e for e in (DARK, SETTINGS, GOAL, CRIT, SHOPS)}
SUPPORTS = Edge(
    id=uuid.uuid4(), src_id=DARK.id, dst_id=GOAL.id, type="supports", attrs={"contribution": 1}
)
DEPENDS = Edge(id=uuid.uuid4(), src_id=DARK.id, dst_id=SETTINGS.id, type="depends_on", attrs={})
EDGES = {e.id: e for e in (SUPPORTS, DEPENDS)}
LONG = "x" * 200


def proposal(op, kind="entity", fields=None, entity=None, edge=None) -> Proposal:
    return Proposal(
        id=uuid.uuid4(),
        entity_id=entity.id if entity is not None else None,
        edge_id=edge.id if edge is not None else None,
        payload={"op": op, "kind": kind, "fields": fields or {}, "reason": None, "origin": "agent"},
        status="open",
    )


def upd(entity, **fields):
    return proposal("update", fields=fields, entity=entity)


def new_edge(type_, **attrs):
    fields = {"src_id": str(DARK.id), "dst_id": str(GOAL.id), "type": type_, "attrs": attrs}
    return proposal("create", "edge", fields)


EDGE_VERBS = [
    ("depends_on", "depends on"),
    ("blocks", "blocks"),
    ("part_of", "is part of"),
    ("owned_by", "is owned by"),
    ("derived_from", "comes from"),
    ("verifies", "verifies"),
    ("affects", "affects"),
    ("mitigates", "reduces the risk of"),
]

CASES = [
    (
        "entity-create",
        proposal("create", fields={"type": "feature", "key": "k", "title": "Sample data"}),
        "Add feature “Sample data”",
    ),
    (
        "entity-create-type-in-words",
        proposal("create", fields={"type": "acceptance_criterion", "key": "k", "title": "Fast"}),
        "Add acceptance criterion “Fast”",
    ),
    (
        "suggested-blocker",
        proposal(
            "create",
            fields={
                "type": "constraint",
                "key": "k",
                "title": "Carrier terms",
                "attrs": {"proposed_blocker": {"type": "unknown"}},
            },
        ),
        "Add constraint “Carrier terms” (suggested blocker)",
    ),
    ("entity-delete", proposal("delete", entity=DARK), "Remove feature “Dark mode”"),
    ("rename", upd(DARK, title="Night mode"), "Rename “Dark mode” to “Night mode”"),
    ("body", upd(DARK, body="Darker."), "Rewrite the description of Dark mode"),
    ("status-confirmed", upd(DARK, status="confirmed"), "Confirm feature Dark mode"),
    ("status-rejected", upd(DARK, status="rejected"), "Reject feature Dark mode"),
    ("status-proposed", upd(SETTINGS, status="proposed"), "Mark Saved carts as proposed again"),
    (
        "entity-update-one-attr",
        upd(DARK, attrs={"status": "planned"}),
        "Set Dark mode’s delivery status to planned (was idea)",
    ),
    (
        "one-attr-no-old-value",
        upd(DARK, attrs={"owner": "Platform team"}),
        "Set Dark mode’s owner to Platform team",
    ),
    ("cleared-attr", upd(DARK, attrs={"effort": None}), "Clear Dark mode’s effort (was M)"),
    (
        "other-key-in-words",
        upd(DARK, attrs={"release_window": "Q2"}),
        "Set Dark mode’s release window to Q2 (was Q1)",
    ),
    (
        "current-value",
        upd(GOAL, attrs={"current": "38%"}),
        "Set Raise activation’s current value to 38%",
    ),
    (
        "three-fields",
        upd(DARK, attrs={"effort": "L", "status": "planned", "weight": 2}),
        "Change Dark mode: effort to L (was M), delivery status to planned (was idea), weight to 2",
    ),
    (
        "five-fields",
        upd(DARK, title="Night", attrs={"effort": "L", "status": "planned", "a": 1, "b": True}),
        "Change Dark mode: title to Night (was Dark mode), effort to L (was M), "
        "delivery status to planned (was idea) and 2 more",
    ),
    *[
        (
            f"supports-{n}",
            new_edge("supports", contribution=c),
            f"Link Dark mode to goal Raise activation ({n} support)",
        )
        for c, n in enumerate(("none", "weak", "medium", "strong"))
    ],  # fmt: skip
    *[
        (f"edge-create-{t}", new_edge(t), f"Add link: Dark mode {verb} Raise activation")
        for t, verb in EDGE_VERBS
    ],
    (
        "edge-update",
        proposal("update", "edge", {"attrs": {"contribution": 3}}, edge=SUPPORTS),
        "Change link Dark mode supports Raise activation: strength to strong (was weak)",
    ),
    (
        "edge-delete",
        proposal("delete", "edge", edge=DEPENDS),
        "Remove link: Dark mode depends on Saved carts",
    ),
    (
        "target-deleted",
        proposal("update", fields={"attrs": {"effort": "S"}, "id": str(uuid.uuid4())}),
        "Set an item that was removed’s effort to S",
    ),
    (
        "owner-is-an-item",
        upd(DARK, attrs={"owner": str(GOAL.id)}),
        "Set Dark mode’s owner to Raise activation",
    ),
    (
        "list-value",
        upd(DARK, attrs={"tags": ["a", "b", "c", "d", "e"]}),
        "Set Dark mode’s tags to a, b, c and 2 more",
    ),  # fmt: skip
    ("object-value", upd(DARK, attrs={"spec": {"x": 1}}), "Set Dark mode’s spec to a new value"),
    ("bool-value", upd(DARK, attrs={"beta": False}), "Set Dark mode’s beta to no"),
    # #262: only real changes are listed, and counted.
    (
        "unchanged-fields-left-out",
        upd(DARK, title="Dark mode", attrs={"effort": "L", "status": "idea"}),
        "Set Dark mode’s effort to L (was M)",
    ),
    (
        "more-counts-only-real-changes",
        upd(
            DARK,
            title="Dark mode",
            body="A dark theme.",
            attrs={"effort": "L", "status": "planned", "release_window": "Q2", "a": 1},
        ),
        "Change Dark mode: effort to L (was M), delivery status to planned (was idea), "
        "release window to Q2 (was Q1) and 1 more",
    ),
    ("no-change", upd(DARK, title="Dark mode", attrs={"effort": "M"}), "No change to Dark mode"),
    ("no-change-status", upd(SETTINGS, status="confirmed"), "No change to Saved carts"),
    ("no-change-body", upd(DARK, body="A dark theme."), "No change to Dark mode"),
    (
        "no-change-edge",
        proposal("update", "edge", {"attrs": {"contribution": 1}}, edge=SUPPORTS),
        "No change to link Dark mode supports Raise activation",
    ),
    (
        "long-text-shows-what-differs",
        upd(
            SHOPS,
            body="Reach fifty paid shops a day by the end of the third quarter of next year.",
            attrs={"weight": 0.6},
        ),
        "Change Reach paid shops: description to …of the third quarter of next year. "
        "(was …of the second quarter of next year.), weight to 0.6 (was 0.5)",
    ),
    (
        "long-text-one-field",
        upd(
            SHOPS,
            title="Reach paid shops",
            attrs={
                "weight": 0.5,
                "note": None,
                "metric": (
                    "Shops that take a paid order on their first two days of opening their doors"
                ),
            },
        ),
        "Set Reach paid shops’ metric to …their first two days of opening their doors "
        "(was …their first day of opening their doors)",
    ),
    (
        "body-left-after-unchanged-title",
        upd(DARK, title="Dark mode", body="Darker."),
        "Rewrite the description of Dark mode",
    ),
]


@pytest.mark.parametrize(("p", "expected"), [c[1:] for c in CASES], ids=[c[0] for c in CASES])
def test_describe_table(p, expected):
    assert describe(p, ENTITIES, EDGES) == expected


def test_question_only_intake_proposal_waits_for_the_answer():
    """protects: a question-only intake proposal says it waits, never that it adds an item.
    fails_when: it reads "Add …" or names the gap's id.
    no_claim: whether it is question-only (service.awaits_answer decides)."""
    attrs = {"gap_id": str(uuid.uuid4()), "category": "success_metric"}
    p = proposal("create", fields={"type": "requirement", "attrs": attrs})
    assert describe(p, ENTITIES, EDGES, awaiting=True) == (
        "Waiting for the author to share an answer (success metric)"
    )


def test_title_ending_in_s_takes_only_the_apostrophe():
    """protects: possessives read right. fails_when: "Saved carts’s". no_claim: other
    plurals."""
    assert describe(upd(SETTINGS, attrs={"effort": "S"}), ENTITIES, EDGES) == (
        "Set Saved carts’ effort to S"
    )


def test_long_value_is_cut_at_60_and_snake_case_reads_in_words():
    """protects: one short line. fails_when: a 200-character value shows whole, or
    "in_progress" shows its underscore. no_claim: word boundaries."""
    long = describe(upd(DARK, attrs={"note": LONG}), ENTITIES, EDGES)
    assert long == f"Set Dark mode’s note to {'x' * 60}…"
    assert describe(upd(DARK, attrs={"status": "in_progress"}), ENTITIES, EDGES) == (
        "Set Dark mode’s delivery status to in progress (was idea)"
    )


def test_long_change_far_into_the_text_shows_two_different_sides():
    """protects: a reviewer sees what a long text change changes without opening Details.
    fails_when: both sides are the same 60-character prefix.
    no_claim: the exact words around the change (the table pins two cases)."""
    before = "word " * 30 + "alpha " + "tail " * 20
    after = "word " * 30 + "beta " + "tail " * 20
    item = Entity(id=uuid.uuid4(), type="feature", title="Notes", attrs={"note": before})
    sentence = describe(upd(item, attrs={"note": after}), {item.id: item}, {})
    match = re.fullmatch(r"Set Notes’ note to (.+) \(was (.+)\)", sentence)
    assert match is not None, sentence
    new, old = match.groups()
    assert new != old
    assert "beta" in new and "alpha" in old
    assert new.startswith("…") and len(new) <= 62


_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)


@pytest.mark.parametrize("p", [c[1] for c in CASES], ids=[c[0] for c in CASES])
def test_summary_never_shows_a_field_path_or_an_id(p):
    """protects: no field paths on screen. fails_when: "attrs." or a UUID in a sentence.
    no_claim: the reason text, which people write."""
    sentence = describe(p, ENTITIES, EDGES)
    assert "attrs." not in sentence
    assert not _ID.search(sentence)
