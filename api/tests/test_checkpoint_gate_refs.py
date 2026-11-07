"""D3 Approve blocked by problems: two problems of one feature with the same code (it depends
on two left-out features) are each their own reason, waived alone with their own reason.

Test cards (protects / fails_when / no_claim):

- test_each_problem_has_its_own_ref: protects=the gate names each problem by its own
  ``ref``; fails_when=two problems of one code share a name; no_claim=the web.
- test_a_waiver_of_one_problem_leaves_the_other_open: protects=Waive… on one problem
  (its ref) answers that one only, and a second waiver keeps its own reason;
  fails_when=one waiver answers both or the second replaces the first's reason;
  no_claim=a waiver naming the code, which still answers every problem of it.
"""

from oracle.runs import gate
from oracle.runs.models import Checkpoint
from tests.test_prd_scope import BLOCKING, at_feature_set
from tests.test_runs import (  # noqa: F401 - fixtures
    get,
    owner,
    pending,
    runtime,
    started,
    tick,
)

TWO = BLOCKING.replace(
    "depends_on: [address-sharing]", "depends_on: [address-sharing, gift-notes]"
).replace(
    "excluded:\n",
    "excluded:\n  - key: gift-notes\n    reason: Waits for the next season\n",
)


def test_each_problem_has_its_own_ref():
    problems = [
        {"code": "depends_on_excluded", "feature": "saved-addresses", "message": m}
        for m in ("depends on address-sharing, left out", "depends on gift-notes, left out")
    ]
    cp = Checkpoint(
        kind="feature_set", status="pending", payload={"feature_set_check": {"problems": problems}}
    )
    shut = gate.approve_gate(cp, None, [])
    assert shut is not None
    refs = [x.ref for x in shut.left]
    assert len(set(refs)) == 2 and all(r.startswith("depends_on_excluded~") for r in refs)


async def test_a_waiver_of_one_problem_leaves_the_other_open(client, owner, runtime):  # noqa: F811
    _, auth = owner
    run = await at_feature_set(client, owner, runtime, TWO)
    cp = pending(run)
    # gift-notes is not in the baseline (unknown_feature): only saved-addresses' are read.
    left = [x for x in cp["gate"]["left"] if x["item"] == "saved-addresses"]
    assert [(x["item"], x["code"]) for x in left] == [
        ("saved-addresses", "depends_on_excluded"),
        ("saved-addresses", "depends_on_excluded"),
    ]
    first, second = left
    assert first["ref"] != second["ref"]
    base = f"/v1/runs/{run['id']}/checkpoints/{cp['id']}"

    async def waive(x, reason):
        body = {
            "item_key": x["item"],
            "kind": "waive",
            "answers": [x["ref"]],
            "value": {"reason": reason},
        }
        resp = await client.post(f"{base}/actions", json=body, headers=auth)
        assert resp.status_code in (200, 201), resp.text
        return resp.json()

    await waive(first, "Sharing ships in the same release")
    cp = pending(await get(client, auth, run["id"]))
    assert [x["ref"] for x in cp["gate"]["left"] if x["item"] == "saved-addresses"] == [
        second["ref"]
    ]

    review = await waive(second, "Notes are a nice to have")
    cp = pending(await get(client, auth, run["id"]))
    assert [x for x in cp["gate"]["left"] if x["item"] == "saved-addresses"] == []
    waivers = [a for i in review["items"] for a in i["actions"] if a["kind"] == "waive"]
    assert sorted(a["value"]["reason"] for a in waivers) == [
        "Notes are a nice to have",
        "Sharing ships in the same release",
    ]


def test_two_same_text_problems_stay_two():
    """A ref names the problem's kind and feature: the same words on two features, or of two
    kinds, are two problems, each waived on its own."""
    same = {"message": "depends on a left-out feature", "requirement": None}
    refs = {
        gate.problem_ref({**same, "code": "depends_on_excluded", "feature": "saved-addresses"}),
        gate.problem_ref({**same, "code": "depends_on_excluded", "feature": "bulk-edit"}),
        gate.problem_ref({**same, "code": "unknown_dependency", "feature": "saved-addresses"}),
    }
    assert len(refs) == 3


def test_a_gate_row_names_its_feature_by_its_title():
    check = {
        "problems": [
            {
                "code": "depends_on_excluded",
                "feature": "saved-addresses",
                "message": "saved-addresses depends on address-sharing, which is excluded",
            }
        ],
        "titles": {"saved-addresses": "Saved addresses", "address-sharing": "Address sharing"},
    }
    cp = Checkpoint(kind="feature_set", status="pending", payload={"feature_set_check": check})
    shut = gate.approve_gate(cp, None, [])
    assert shut is not None
    [row] = shut.left
    assert row.item_title == "Saved addresses"
    assert row.label == "Saved addresses depends on Address sharing, which is excluded"


async def test_the_review_screen_reasons_carry_the_gate_refs(client, owner, runtime):  # noqa: F811
    """The review screen's reasons name each problem by the gate's ref, and a waiver of one
    answers that one only there too."""
    _, auth = owner
    run = await at_feature_set(client, owner, runtime, TWO)
    cp = pending(run)
    refs = [x["ref"] for x in cp["gate"]["left"] if x["item"] == "saved-addresses"]
    latest = (await client.get(f"/v1/runs/{run['id']}/scope", headers=auth)).json()
    scope = (await client.get(f"/v1/prd-scopes/{latest['id']}", headers=auth)).json()
    [feature] = [f for f in scope["features"] if f["key"] == "saved-addresses"]
    blocking = [r for r in feature["reasons"] if r["code"] == "depends_on_excluded"]
    assert [r["ref"] for r in blocking] == refs
    body = {"item_key": "saved-addresses", "kind": "waive", "answers": [refs[0]],
            "value": {"reason": "Sharing ships in the same release"}}  # fmt: skip
    resp = await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/actions", json=body, headers=auth
    )
    assert resp.status_code in (200, 201), resp.text
    scope = (await client.get(f"/v1/prd-scopes/{latest['id']}", headers=auth)).json()
    [feature] = [f for f in scope["features"] if f["key"] == "saved-addresses"]
    answered = {
        r["ref"]: r["answered"] for r in feature["reasons"] if r["code"] == "depends_on_excluded"
    }
    assert answered == {refs[0]: True, refs[1]: False}


def _label(problem: dict, titles: dict[str, str]) -> str:
    check = {"problems": [{"feature": "saved-addresses", **problem}], "titles": titles}
    cp = Checkpoint(kind="feature_set", status="pending", payload={"feature_set_check": check})
    shut = gate.approve_gate(cp, None, [])
    assert shut is not None
    [row] = shut.left
    return row.label


def test_a_gate_row_rewrites_feature_keys_only_never_a_key_like_word():
    """An ordinary hyphenated word ("in-store", "follow-up") is not a feature key: it stays as
    written, while the feature's key reads as its title."""
    label = _label(
        {
            "code": "depends_on_excluded",
            "message": "saved-addresses needs in-store pickup from the follow-up PRD",
        },  # fmt: skip
        {"saved-addresses": "Saved addresses"},
    )
    assert label == "Saved addresses needs in-store pickup from the follow-up PRD"


def test_a_gate_row_reads_a_numbered_row_and_an_untitled_dependency():
    """A row the agents left unkeyed ("#2") reads as its number; a feature key with no title
    (a dependency the set does not hold) reads as words."""
    label = _label(
        {"code": "missing_field", "message": "requirement #2 of feature saved-addresses lacks key"},
        {"saved-addresses": "Saved addresses"},
    )
    assert label == "Requirement 2 of feature Saved addresses lacks key"
    label = _label(
        {
            "code": "depends_on_excluded",
            "message": "saved-addresses depends on gift-notes, which is excluded",
        },  # fmt: skip
        {"saved-addresses": "Saved addresses"},
    )
    assert label == "Saved addresses depends on Gift notes, which is excluded"
