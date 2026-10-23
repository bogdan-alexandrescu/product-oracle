"""E3 roadmap item diff (routes): what changed between two roadmap versions and against the
approved plan, an item's history, and the known items a roadmap run keeps ids from.
Against Postgres with the FakeRuntime.

The PRD-draft half (a PRD version's draft items, E1) is not built yet: a PRD ref is 409
until its draft items exist.
"""

from oracle.mcp.scopes import required_scope
from oracle.swarm import Outcome
from tests.test_mcp import mcp_client, run_token, text_of, user_with_role
from tests.test_roadmap import (  # noqa: F401 - fixtures
    ITEMS,
    PRD,
    ROADMAP,
    ROADMAP_MD,
    approved_prd,
    as_user,
    built_roadmap,
    create,
    get,
    owner,
    runtime,
    seed_baseline,
    start,
    tick,
)

DIFF = "/v1/roadmap-items/diff"
HISTORY = "/v1/roadmap-items/history"

# Version 2: the shipping step moves to now, an address book is new in later.
ITEMS_V2 = (
    ITEMS.replace(
        "    horizon: next\n    milestone: Shipping estimate up front\n",
        "    horizon: now\n    milestone: Shipping estimate up front\n",
    )
    + """\
  - id: address-book
    title: Address book
    outcome: Returning buyers pick a saved address
    horizon: later
    depends_on: [shipping-step]
    priority: {score: 1.0, rank: 3, explanation: "activation weight 3 x contribution 0"}
    confidence: low
    prd_section: s-5-2
"""
)
# Version 3: the address book leaves again.
ITEMS_V3 = ITEMS_V2.split("  - id: address-book")[0]


async def new_version(client, auth, runtime, items: str, n: int, approve: bool = False) -> None:  # noqa: F811
    """Version ``n`` of the roadmap, written by a prd_to_roadmap run with these items."""
    runtime.script["roadmap_items"] = [Outcome(artifacts={"roadmap_items.yaml": items})]
    text = ROADMAP_MD.replace("payment first", f"payment first (v{n})")
    runtime.script["roadmap_draft"] = [Outcome(artifacts={"roadmap.md": text})]
    off = {"roadmap_items": False, "roadmap_review": False}
    run = await start(
        client, auth, await create(client, auth, source=PRD, knobs={"checkpoints": off})
    )
    await tick(client, auth)
    await tick(client, auth)
    assert (await get(client, auth, run["id"]))["status"] == "succeeded"
    out = (await client.get(f"/v1/roadmaps/{ROADMAP}/items", headers=auth)).json()
    assert out["roadmap"]["version"] == n
    if approve:
        resp = await client.post(f"/v1/documents/{ROADMAP}/versions/{n}/approve", headers=auth)
        assert resp.status_code == 200, resp.text


async def two_versions(client, auth, runtime, approve_v1: bool = True) -> None:  # noqa: F811
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    if approve_v1:
        resp = await client.post(f"/v1/documents/{ROADMAP}/versions/1/approve", headers=auth)
        assert resp.status_code == 200, resp.text
    await new_version(client, auth, runtime, ITEMS_V2, 2)


async def test_a_roadmap_version_compares_with_the_previous_by_default(client, owner, runtime):  # noqa: F811
    """protects: v2 shows what moved and what is new since v1, item by item, in v2's order;
    fails_when: the default base is not the previous version, or an item lands in the
    wrong class; no_claim: the classification rules themselves (test_roadmap_diff.py)."""
    _, auth = owner
    await two_versions(client, auth, runtime, approve_v1=False)

    resp = await client.get(DIFF, params={"head": f"{ROADMAP}@2"}, headers=auth)
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["head"]["ref"] == f"{ROADMAP}@2" and out["head"]["kind"] == "roadmap"
    assert out["head"]["label"] == "Roadmap v2"
    assert out["head"]["document"]["version"] == 2 and out["head"]["document"]["approved"] is False
    assert out["base"]["ref"] == f"{ROADMAP}@1" and out["base"]["label"] == "Roadmap v1"
    assert out["options"] == {
        "previous": {"ref": f"{ROADMAP}@1", "label": "Roadmap v1"},
        "approved": None,
    }
    assert out["summary"] == {"added": 1, "dropped": 0, "moved": 1, "changed": 0, "unchanged": 1}
    pay, ship, book = out["items"]
    assert [pay["item_key"], ship["item_key"], book["item_key"]] == [
        "payment-step", "shipping-step", "address-book",
    ]  # fmt: skip
    assert pay["change"] == "unchanged" and pay["matched_by"] == "key" and pay["fields"] == []
    assert ship["change"] == "moved"
    assert (ship["base_horizon"], ship["head_horizon"]) == ("next", "now")
    assert ship["fields"] == [{"field": "horizon", "before": "next", "after": "now"}]
    assert book["change"] == "added" and book["matched_by"] is None
    assert book["base_horizon"] is None and book["head_horizon"] == "later"

    # With nothing approved: base null, no items.
    resp = await client.get(DIFF, params={"head": f"{ROADMAP}@2", "base": "approved"}, headers=auth)
    out = resp.json()
    assert out["base"] is None and out["summary"] is None and out["items"] == []
    assert out["options"]["approved"] is None

    # Version 1 has no previous.
    out = (await client.get(DIFF, params={"head": f"{ROADMAP}@1"}, headers=auth)).json()
    assert out["base"] is None and out["items"] == [] and out["options"]["previous"] is None


async def test_the_approved_plan_is_the_latest_approved_other_version(client, owner, runtime):  # noqa: F811
    """protects: "against the approved plan" compares with the roadmap's latest approved
    version other than the head; fails_when: the head itself or an unapproved version is
    the base; no_claim: the PRD-draft half (E1)."""
    _, auth = owner
    await two_versions(client, auth, runtime)
    await new_version(client, auth, runtime, ITEMS_V3, 3)

    out = (
        await client.get(DIFF, params={"head": f"{ROADMAP}@3", "base": "approved"}, headers=auth)
    ).json()
    assert out["base"]["ref"] == f"{ROADMAP}@1" and out["base"]["document"]["approved"] is True
    assert out["options"]["approved"] == {"ref": f"{ROADMAP}@1", "label": "Roadmap v1"}
    assert out["options"]["previous"]["ref"] == f"{ROADMAP}@2"
    assert {i["item_key"]: i["change"] for i in out["items"]} == {
        "payment-step": "unchanged", "shipping-step": "moved",
    }  # fmt: skip
    # v1 is approved, but compared with itself is nothing: the approved plan is another.
    out = (
        await client.get(DIFF, params={"head": f"{ROADMAP}@1", "base": "approved"}, headers=auth)
    ).json()
    assert out["base"] is None and out["options"]["approved"] is None
    # A ref base of the same roadmap.
    out = (
        await client.get(
            DIFF, params={"head": f"{ROADMAP}@3", "base": f"{ROADMAP}@2"}, headers=auth
        )
    ).json()
    assert out["summary"]["dropped"] == 1
    # Dropped: right after the last head item of its horizon or an earlier one (last here).
    assert out["items"][-1]["item_key"] == "address-book"
    assert out["items"][-1]["change"] == "dropped" and out["items"][-1]["base_horizon"] == "later"


async def test_refusals(client, owner, runtime):  # noqa: F811
    """protects: a bad ref is a clear error, never a wrong comparison; fails_when: a
    malformed ref, an unknown version or another document's base is accepted;
    no_claim: company scoping (covered for the items routes)."""
    _, auth = owner
    await two_versions(client, auth, runtime)
    for head, code in (
        ("nonsense", 422),
        (f"{ROADMAP}@0", 422),
        ("no-such-doc@1", 404),
        (f"{ROADMAP}@9", 404),
        # A PRD version's draft items (E1) are not ready: none are stored yet.
        (f"{PRD}@1", 409),
    ):
        resp = await client.get(DIFF, params={"head": head}, headers=auth)
        assert resp.status_code == code, (head, resp.text)
    resp = await client.get(DIFF, params={"head": f"{PRD}@1"}, headers=auth)
    assert resp.json()["detail"] == "Roadmap items for v1 are not ready yet"
    # A base of another chain.
    resp = await client.get(DIFF, params={"head": f"{ROADMAP}@2", "base": f"{PRD}@1"}, headers=auth)
    assert resp.status_code == 422, resp.text
    resp = await client.get(DIFF, params={"head": f"{ROADMAP}@2", "base": "sideways"}, headers=auth)
    assert resp.status_code == 422, resp.text


async def test_dates_compare_as_they_stand_now(client, owner, runtime):  # noqa: F811
    """protects: a basis withdrawn under both versions is not a change between them;
    fails_when: it shows as a milestone_date change; no_claim: the date rules
    (test_roadmap_dates.py)."""
    _, auth = owner
    await two_versions(client, auth, runtime)
    bases = (await client.get("/v1/schedule-bases", headers=auth)).json()
    (eng,) = [b for b in bases if b["reference"] == "ENG-412"]
    resp = await client.post(
        f"/v1/schedule-bases/{eng['id']}/withdraw", json={"reason": "Re-estimated"}, headers=auth
    )
    assert resp.status_code == 200, resp.text
    out = (await client.get(DIFF, params={"head": f"{ROADMAP}@2"}, headers=auth)).json()
    pay = out["items"][0]
    assert pay["item_key"] == "payment-step" and pay["change"] == "unchanged"
    assert all(f["field"] != "milestone_date" for f in pay["fields"])


async def test_an_items_history_across_roadmap_versions(client, owner, runtime):  # noqa: F811
    """protects: an item's horizon and presence version by version, the approved one
    marked; fails_when: an entry is missing, out of order, or a departure is not shown;
    no_claim: draft entries (E1)."""
    _, auth = owner
    await two_versions(client, auth, runtime)
    await new_version(client, auth, runtime, ITEMS_V3, 3)

    resp = await client.get(HISTORY, params={"prd": PRD, "item_key": "shipping-step"}, headers=auth)
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["prd"]["slug"] == PRD and out["item_key"] == "shipping-step"
    assert [(e["label"], e["horizon"], e["change"], e["approved"]) for e in out["entries"]] == [
        ("Roadmap v1", "next", "added", True),
        ("Roadmap v2", "now", "moved", False),
        ("Roadmap v3", "now", "unchanged", False),
    ]
    assert out["entries"][0]["kind"] == "roadmap" and out["entries"][0]["present"] is True

    book = (
        await client.get(HISTORY, params={"prd": PRD, "item_key": "address-book"}, headers=auth)
    ).json()
    assert [(e["label"], e["present"], e["change"]) for e in book["entries"]] == [
        ("Roadmap v2", True, "added"),
        ("Roadmap v3", False, "dropped"),
    ]
    assert (
        await client.get(HISTORY, params={"prd": "no-such-doc", "item_key": "x"}, headers=auth)
    ).status_code == 404


async def test_a_roadmap_run_lists_the_roadmaps_items_as_known(client, owner, runtime):  # noqa: F811
    """protects: the next roadmap version's agents see the current ids, so they can keep
    them; fails_when: the items prompt does not list them; no_claim: whether the agents
    keep them (prompt behaviour)."""
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    await start(client, auth, await create(client, auth, source=PRD))
    first = runtime.submitted[-1].steps[-1].prompt
    assert "Known items" not in first

    runtime.submitted.clear()
    await built_roadmap(client, auth, runtime)
    runtime.submitted.clear()
    await start(client, auth, await create(client, auth, source=PRD))
    prompt = runtime.submitted[-1].steps[-1].prompt
    assert "Known items (roadmap v1)" in prompt
    assert "- payment-step: Payment step (now)" in prompt
    assert "- shipping-step: Shipping step (next)" in prompt


async def test_viewers_read_and_run_tokens_do_not(client, owner, runtime):  # noqa: F811
    """protects: everyone who reads the roadmap reads its diff; agents never do;
    fails_when: a viewer is refused or a run token reaches either route; no_claim: MCP
    tools for people's tokens."""
    tenant_id, auth = owner
    await two_versions(client, auth, runtime)
    viewer = await as_user(tenant_id, "viewer")
    assert (
        await client.get(DIFF, params={"head": f"{ROADMAP}@2"}, headers=viewer)
    ).status_code == 200
    assert (
        await client.get(HISTORY, params={"prd": PRD, "item_key": "payment-step"}, headers=viewer)
    ).status_code == 200
    assert required_scope("GET", DIFF) is None and required_scope("GET", HISTORY) is None
    pm = await user_with_role(tenant_id, "owner", email="pm-diff@example.com")
    token = await run_token(tenant_id, ["read:documents", "read:baseline", "read:sources"], pm.id)
    # A run token reaches neither: no scope names the area, so MCP lists and runs neither.
    async with mcp_client(token) as c:
        names = {t.name for t in (await c.list_tools()).tools}
        assert names.isdisjoint({"diff_roadmap_items", "get_roadmap_item_history"})
        refused = await c.call_tool("diff_roadmap_items", {"head": f"{ROADMAP}@2"})
        assert refused.is_error and "not available to run tokens" in text_of(refused)
