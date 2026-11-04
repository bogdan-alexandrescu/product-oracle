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
