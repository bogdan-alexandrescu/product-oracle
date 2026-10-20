"""roadmap_items.yaml is read by one loader that refuses YAML aliases and anchors and
caps the file's size once parsed (review fixes 2, item 1). yaml.safe_load shares an
alias's node, so a few hundred bytes of ``&a``/``*a`` expand to megabytes when the items
are copied to JSON or turned to text: every roadmap item path (the run's checkpoint, a
run's import, a person's PUT) refuses such a file before it is expanded."""

import time

from oracle import safe_yaml
from oracle.runs import roadmap as items_file
from oracle.runs.roadmap import check_items
from oracle.swarm import Outcome
from tests.test_roadmap import (  # noqa: F401 - fixtures
    ITEMS,
    PRD,
    ROADMAP,
    ROADMAP_MD,
    approved_prd,
    built_roadmap,
    create,
    get,
    owner,
    runtime,
    start,
    tick,
)


def bomb(levels: int) -> str:
    """ITEMS with a billion-laughs tree in the payment step's economics: each level
    lists the previous one ten times."""
    rows = ["      l0: &l0 [lol, lol, lol, lol, lol, lol, lol, lol, lol, lol]"]
    for n in range(1, levels + 1):
        rows.append(f"      l{n}: &l{n} [" + ", ".join([f"*l{n - 1}"] * 10) + "]")
    return ITEMS.replace(
        "    prd_section: s-5-1\n",
        "    prd_section: s-5-1\n    economics:\n" + "\n".join(rows) + "\n",
        1,
    )


def _codes(text: str) -> list[str]:
    return [p["code"] for p in check_items(text).problems]


def test_an_alias_bomb_is_refused_quickly_with_a_clear_problem():
    text = bomb(5)  # ~600 bytes; expanded, 10^6 strings
    assert len(text.encode()) < 1500
    started = time.monotonic()
    out = check_items(text)
    assert time.monotonic() - started < 1
    assert [p["code"] for p in out.problems] == ["yaml_alias"]
    assert "alias" in out.problems[0]["message"] and out.items == []


def test_an_anchor_alone_and_a_merge_key_are_refused():
    anchored = ITEMS.replace("confidence: high", "confidence: &c high", 1)
    assert _codes(anchored) == ["yaml_alias"]
    merged = ITEMS.replace(
        "    prd_section: s-5-2\n",
        "    prd_section: s-5-2\n    economics: {<<: {value: 1}}\n",
        1,
    )
    # A merge key with an inline mapping has no alias: it is an ordinary key here.
    assert _codes(merged) == []


def test_too_many_nodes_is_refused(monkeypatch):
    monkeypatch.setattr(safe_yaml, "MAX_NODES", 50)
    assert _codes(ITEMS) == ["too_large"]


def test_too_large_once_parsed_is_refused(monkeypatch):
    monkeypatch.setattr(items_file, "MAX_STORED_BYTES", 200)
    assert _codes(ITEMS) == ["too_large"]


def test_the_plain_file_still_loads():
    assert check_items(ITEMS).ok
    assert items_file.load_items_yaml(ITEMS)["items"][0]["id"] == "payment-step"


async def test_a_person_s_import_refuses_the_bomb(client, owner, runtime):  # noqa: F811
    _, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    started = time.monotonic()
    resp = await client.put(
        f"/v1/roadmaps/{ROADMAP}/versions/1/items", json={"yaml": bomb(5)}, headers=auth
    )
    assert time.monotonic() - started < 5
    assert resp.status_code == 422, resp.text
    assert [p["code"] for p in resp.json()["detail"]["problems"]] == ["yaml_alias"]
    # The run's items are untouched.
    items = (await client.get(f"/v1/roadmaps/{ROADMAP}/items", headers=auth)).json()["items"]
    assert [i["item_key"] for i in items] == ["payment-step", "shipping-step"]
    assert "declared" not in items[0]["economics"]


async def test_a_run_s_bomb_waits_at_its_checkpoint_and_is_never_stored(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
):
    _, auth = owner
    await approved_prd(client, auth)
    runtime.script["roadmap_items"] = [Outcome(artifacts={"roadmap_items.yaml": bomb(5)})]
    runtime.script["roadmap_draft"] = [Outcome(artifacts={"roadmap.md": ROADMAP_MD})]
    run = await start(
        client,
        auth,
        await create(client, auth, source=PRD, knobs={"checkpoints": {"roadmap_review": False}}),
    )
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    cp = next(c for c in run["checkpoints"] if c["status"] == "pending")
    assert [p["code"] for p in cp["payload"]["items_check"]["problems"]] == ["yaml_alias"]
    # A reviewer approves it anyway: the roadmap imports, its items do not.
    resp = await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/decide",
        json={"decision": "approved"},
        headers=auth,
    )
    assert resp.status_code == 200, resp.text
    await tick(client, auth)
    await tick(client, auth)
    assert (await get(client, auth, run["id"]))["status"] == "succeeded"
    items = (await client.get(f"/v1/roadmaps/{ROADMAP}/items", headers=auth)).json()["items"]
    assert items == []
