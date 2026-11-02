"""Roadmap items review (walk b): an item with two reasons to confirm keeps an Accept per
reason, so accepting one never reopens the other and the item counts as handled.

Integration test: a ``prd_to_roadmap`` run waits at its Roadmap items checkpoint on the
FakeRuntime against Postgres, as tests/test_roadmap_items_review_reads.py does.

Test card: protects=each reason holds its own Accept; fails_when=a second Accept on the
same item replaces the first; no_claim=which reasons the item gets. Synthetic placeholders only.
"""

from tests.test_roadmap import (  # noqa: F401 - fixtures
    approved_prd,
    owner,
    runtime,
    seed_baseline,
)
from tests.test_roadmap_items_review_reads import items_file
from tests.test_roadmap_reasons import roadmap_items_check


async def test_each_reason_keeps_its_own_accept(client, owner, runtime):  # noqa: F811
    _, auth = owner
    await approved_prd(client, auth)
    run, _ = await roadmap_items_check(client, auth, runtime, items_file(1))
    [cp] = [c for c in run["checkpoints"] if c["status"] == "pending"]
    base = f"/v1/runs/{run['id']}/checkpoints/{cp['id']}"
    for code in ("low_confidence", "serves_no_goal"):
        body = {"item_key": "item-0", "kind": "accept", "answers": [code]}
        resp = await client.post(f"{base}/actions", json=body, headers=auth)
        assert resp.status_code == 200, resp.text
    resp = await client.get(f"{base}/review", headers=auth)
    assert resp.status_code == 200, resp.text
    [item] = [i for i in resp.json()["items"] if i["key"] == "item-0"]
    accepts = [a for a in item["actions"] if a["kind"] == "accept" and a["state"] == "staged"]
    assert sorted(c for a in accepts for c in a["answers"]) == ["low_confidence", "serves_no_goal"]
