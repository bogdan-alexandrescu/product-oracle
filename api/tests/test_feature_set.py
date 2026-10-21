"""C6 Feature set: the check of ``feature_set.yaml`` (oracle.runs.feature_set), without a
database. Every blocking code has a minimal failing file; the advisory flags, the cycle
detection and the safe loader have their own cases.

Test cards (protects / fails_when / no_claim):

- test_check_depends_on_excluded: protects=an included feature never rests on a left-out
  one; fails_when=the check passes or names the wrong keys; no_claim=whether the agent
  writes good dependencies.
- test_every_blocking_code_has_a_minimal_failing_file: protects=each code in the spec's
  table is raised by exactly the file that breaks its rule; fails_when=a broken file
  passes, or a different code is raised; no_claim=the wording of the messages.
- test_flags_are_advisory: protects=serves_no_goal, low_confidence, linked_blocker,
  new_feature and duplicate_of_existing are stored per feature and never block;
  fails_when=a flag is missing, lands on the wrong feature, or counts as blocking;
  no_claim=how C7 Scope review shows them.
- test_a_clean_file_has_no_problems: protects=a good file passes with its counts;
  fails_when=a valid file is refused or miscounted; no_claim=the baseline lookups (see
  tests/test_prd_scope.py).
"""

import uuid

import pytest

from oracle.runs import feature_set as fs

GOAL = uuid.uuid4()
DOC = "saved-addresses"


def known(**over) -> fs.Known:
    base = {
        "features": {
            "saved-addresses": fs.Ref(entity_id=uuid.uuid4(), title="Saved addresses"),
            "address-lookup": fs.Ref(entity_id=uuid.uuid4(), title="Address lookup"),
            "address-sharing": fs.Ref(entity_id=uuid.uuid4(), title="Address sharing"),
            "bulk-edit": fs.Ref(proposal_id=uuid.uuid4(), title="Bulk edit"),
        },
        "requirements": {
            "saved-addresses-pick": fs.Ref(entity_id=uuid.uuid4(), title="Pick an address"),
            "bulk-edit-many": fs.Ref(proposal_id=uuid.uuid4(), title="Edit many"),
        },
        "goals": {"activation": GOAL},
        "constraints": {"card-vault-limits": uuid.uuid4(), "vendor-quota": uuid.uuid4()},
        "gating": {"card-vault-limits"},
        "titles": [
            ("saved-addresses", fs.norm_title("Saved addresses")),
            ("address-lookup", fs.norm_title("Address lookup")),
            ("address-sharing", fs.norm_title("Address sharing")),
            ("legacy-book", fs.norm_title("Address book!")),
        ],
        "low": 0.4,
    }
    base.update(over)
    return fs.Known(**base)


CLEAN = """\
version: 1
document: saved-addresses
features:
  - key: saved-addresses
    title: Saved addresses
    summary: Returning buyers pick a saved address at checkout
    goals:
      - {key: activation, contribution: 2}
    depends_on: [address-lookup]
    confidence: 0.7
    requirements:
      - key: saved-addresses-pick
        text: The buyer picks one of up to five saved addresses
        acceptance: ["Five addresses at most", "The last used one is preselected"]
  - key: address-lookup
    title: Address lookup
    goals: [{key: activation, contribution: 1}]
    confidence: 0.9
    requirements: []
excluded:
  - key: address-sharing
    reason: Serves no confirmed goal
"""


def check(text: str, **kw) -> fs.FeatureSetCheck:
    return fs.check_feature_set(text, document=kw.pop("document", DOC), known=kw.pop("k", known()))


def codes(out: fs.FeatureSetCheck) -> list[str]:
    return [p["code"] for p in out.problems]


def test_a_clean_file_has_no_problems():
    out = check(CLEAN)
    assert out.problems == [] and out.blocking == 0
    assert out.as_json() == {
        "features": 2,
        "requirements": 1,
        "excluded": 1,
        "problems": [],
        "flags": {},
    }
    # The parsed set, in file order, is what the scope writer stores.
    assert [f["key"] for f in out.features] == ["saved-addresses", "address-lookup"]
    assert out.features[0]["requirements"][0]["acceptance"] == [
        "Five addresses at most",
        "The last used one is preselected",
    ]
    assert out.excluded == [{"key": "address-sharing", "reason": "Serves no confirmed goal"}]


def test_check_depends_on_excluded():
    text = CLEAN.replace("depends_on: [address-lookup]", "depends_on: [address-sharing]")
    out = check(text)
    assert codes(out) == ["depends_on_excluded"]
    (p,) = out.problems
    assert p["blocking"] is True
    assert p["feature"] == "saved-addresses" and p["requirement"] is None
    assert "saved-addresses" in p["message"] and "address-sharing" in p["message"]
    assert p["message"] == "saved-addresses depends on address-sharing, which is excluded"


MINIMAL = {
    "unreadable_yaml": "version: 1\nfeatures: [\n",
    "wrong_version": CLEAN.replace("version: 1", "version: 2"),
    "wrong_document": CLEAN.replace("document: saved-addresses", "document: checkout"),
    "no_features": "version: 1\ndocument: saved-addresses\nfeatures: []\n",
    "missing_field": CLEAN.replace("    title: Address lookup\n", ""),
    "duplicate_key": CLEAN.replace("excluded:\n", "excluded:\n  - {key: address-sharing, reason: Twice}\n"),  # noqa: E501
    "unknown_feature": CLEAN.replace("key: address-lookup\n    title", "key: ghost\n    title")
    .replace("depends_on: [address-lookup]", "depends_on: []"),
    "unknown_requirement": CLEAN.replace("key: saved-addresses-pick", "key: ghost-req"),
    "unknown_goal": CLEAN.replace("{key: activation, contribution: 1}", "{key: retention, contribution: 1}"),  # noqa: E501
    "unknown_dependency": CLEAN.replace("depends_on: [address-lookup]", "depends_on: [nowhere]"),
    "depends_on_excluded": CLEAN.replace(
        "depends_on: [address-lookup]", "depends_on: [address-sharing]"
    ),
    "dependency_cycle": CLEAN.replace(
        "    confidence: 0.9\n", "    confidence: 0.9\n    depends_on: [saved-addresses]\n"
    ),
    "unknown_blocker": CLEAN.replace(
        "    confidence: 0.7\n", "    confidence: 0.7\n    blockers: [no-such-limit]\n"
    ),
}  # fmt: skip


@pytest.mark.parametrize("code", sorted(MINIMAL))
def test_every_blocking_code_has_a_minimal_failing_file(code):
    out = check(MINIMAL[code])
    assert codes(out) == [code], out.problems
    assert all(p["blocking"] for p in out.problems)
    assert out.blocking == 1


def test_not_a_mapping_is_unreadable():
    out = check("- just\n- a list\n")
    assert codes(out) == ["unreadable_yaml"]


def test_missing_requirement_text_and_duplicate_requirement_keys():
    text = CLEAN.replace(
        "        text: The buyer picks one of up to five saved addresses\n", ""
    ).replace(
        "    requirements: []",
        "    requirements:\n      - key: saved-addresses-pick\n        text: Again",
    )
    out = check(text)
    assert sorted(codes(out)) == ["duplicate_key", "missing_field"]
    missing = next(p for p in out.problems if p["code"] == "missing_field")
    assert missing["feature"] == "saved-addresses"
    assert missing["requirement"] == "saved-addresses-pick"


def test_a_proposed_goal_is_unknown():
    # Only confirmed goals count: the known goals are the confirmed ones.
    out = check(CLEAN, k=known(goals={}))
    assert codes(out) == ["unknown_goal", "unknown_goal"]


def test_a_dependency_on_a_baseline_feature_outside_the_set_is_fine():
    text = CLEAN.replace("depends_on: [address-lookup]", "depends_on: [bulk-edit]")
    assert check(text).problems == []


def test_cycles_are_found_once_with_their_path():
    text = """\
version: 1
document: saved-addresses
features:
  - {key: saved-addresses, title: A, goals: [], depends_on: [address-lookup]}
  - {key: address-lookup, title: B, goals: [], depends_on: [bulk-edit]}
  - {key: bulk-edit, title: C, goals: [], depends_on: [saved-addresses]}
"""
    out = check(text)
    assert codes(out) == ["dependency_cycle"]
    msg = out.problems[0]["message"]
    assert "saved-addresses" in msg and "address-lookup" in msg and "bulk-edit" in msg


def test_self_dependency_is_a_cycle():
    text = CLEAN.replace("depends_on: [address-lookup]", "depends_on: [saved-addresses]")
    assert codes(check(text)) == ["dependency_cycle"]


def test_every_problem_listed_in_one_pass():
    text = (
        CLEAN.replace("version: 1", "version: 3")
        .replace("{key: activation, contribution: 2}", "{key: retention, contribution: 2}")
        .replace("depends_on: [address-lookup]", "depends_on: [address-sharing]")
    )
    assert sorted(codes(check(text))) == ["depends_on_excluded", "unknown_goal", "wrong_version"]


def test_flags_are_advisory():
    text = """\
version: 1
document: saved-addresses
features:
  - key: saved-addresses
    title: Saved addresses
    goals: []
    confidence: 0.2
    blockers: [card-vault-limits, vendor-quota]
    requirements: []
  - key: bulk-edit
    title: Address book
    goals: [{key: activation, contribution: 3}]
    confidence: 0.9
    requirements:
      - {key: bulk-edit-many, text: Edit many addresses at once}
"""
    out = check(text)
    assert out.problems == [] and out.blocking == 0
    assert out.flags == {
        "saved-addresses": ["serves_no_goal", "low_confidence", "linked_blocker"],
        # A proposal of this run, titled like another feature (case and punctuation aside).
        "bulk-edit": ["new_feature", "duplicate_of_existing"],
    }
    assert out.as_json()["flags"] == out.flags


def test_a_features_own_title_is_not_a_duplicate():
    assert check(CLEAN).flags == {}


def test_invalid_contribution_is_blocking():
    out = check(CLEAN.replace("contribution: 2", "contribution: 7"))
    assert codes(out) == ["invalid_field"]
    assert out.problems[0]["feature"] == "saved-addresses"


def test_without_a_document_slug_any_document_passes():
    out = fs.check_feature_set(
        CLEAN.replace("saved-addresses\nfeatures", "other\nfeatures"), document=None, known=known()
    )
    assert out.problems == []


def test_the_loader_is_the_safe_one():
    with pytest.raises(fs.FeatureSetError) as exc:
        fs.load_feature_set("a: &x 1\nb: *x\n")
    assert exc.value.code
    out = check("version: 1\na: &x 1\nb: *x\n")
    assert codes(out) == ["unreadable_yaml"]


def test_too_large_once_parsed_is_refused(monkeypatch):
    monkeypatch.setattr(fs, "MAX_STORED_BYTES", 100)
    with pytest.raises(fs.FeatureSetError) as exc:
        fs.load_feature_set(CLEAN)
    assert exc.value.code == "too_large"
    assert codes(check(CLEAN)) == ["unreadable_yaml"]


async def test_the_async_check_runs_on_the_parse_pool():
    out = await fs.check_feature_set_async(CLEAN, document=DOC, known=known())
    assert out.problems == [] and out.as_json()["features"] == 2


def test_blocking_message_counts():
    assert fs.blocking_message(1) == (
        "The feature set has 1 blocking problem; send it back with Request changes"
    )
    assert fs.blocking_message(3) == (
        "The feature set has 3 blocking problems; send it back with Request changes"
    )


def test_scope_rows_are_checked_by_the_same_rules():
    """check_rows: the stored scope (rows), re-checked with the same rules as the file."""
    out = check(CLEAN)
    rows = fs.rows_of(out)
    again = fs.check_rows(rows, known=known())
    assert again.as_json() == out.as_json()
    # A dependency on an excluded feature among the rows is blocking there too.
    for r in rows:
        if r["key"] == "saved-addresses":
            r["depends_on"] = ["address-sharing"]
    assert [p["code"] for p in fs.check_rows(rows, known=known()).problems] == [
        "depends_on_excluded"
    ]
