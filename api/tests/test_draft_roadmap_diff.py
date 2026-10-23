"""E3b roadmap item diff for PRD drafts (after E1): a PRD version's ref names its ready
draft items; a draft compares with the previous ready draft or with the approved plan (the
latest approved roadmap version whose items trace to the PRD); an item's history runs
across the drafts and the roadmap versions. Against Postgres with the FakeRuntime."""

from oracle.swarm import Outcome
from tests.test_draft_roadmaps import (  # noqa: F401 - fixtures
    PRD,
    derivations_start,
    items_file,
    new_version,
    owner,
    runtime,
)
from tests.test_roadmap import ROADMAP, as_user, built_roadmap, tick, verified_estimate
from tests.test_roadmap_diff_routes import ITEMS_V2

DIFF = "/v1/roadmap-items/diff"
HISTORY = "/v1/roadmap-items/history"


async def derived(client, auth, runtime, items: str) -> None:  # noqa: F811
    """The queued draft's items stored (one tick starts the run, the next stores them)."""
    runtime.script["roadmap_items"] = [Outcome(artifacts={"roadmap_items.yaml": items})]
    await tick(client, auth)
    await tick(client, auth)


async def drafts(client, auth, runtime, approved_plan: bool = True) -> None:  # noqa: F811
    """Draft v1 (ITEMS), approved and built into roadmap v1 (approved unless not); then
    draft v2, whose shipping step moves to now and whose address book is new."""
    await new_version(client, auth, 1)
    await verified_estimate(client, auth)
    await derived(client, auth, runtime, items_file(1))
    if approved_plan:
        resp = await client.post(f"/v1/documents/{PRD}/versions/1/approve", headers=auth)
        assert resp.status_code == 200, resp.text
        await built_roadmap(client, auth, runtime)
        resp = await client.post(f"/v1/documents/{ROADMAP}/versions/1/approve", headers=auth)
        assert resp.status_code == 200, resp.text
    await new_version(client, auth, 2)
    await derived(client, auth, runtime, items_file(2, ITEMS_V2))


async def test_a_draft_compares_with_the_previous_draft_by_default(client, owner, runtime):  # noqa: F811
    """protects: criteria 6 and 10 of #177, a PRD draft's ref names its draft items and
    compares with the nearest earlier ready draft by default; fails_when: a PRD ref is
    409 although its items are ready, or the base is not the previous draft; no_claim:
    the classification rules (test_roadmap_diff.py)."""
    _, auth = owner
    await drafts(client, auth, runtime, approved_plan=False)

    resp = await client.get(DIFF, params={"head": f"{PRD}@2"}, headers=auth)
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["head"]["ref"] == f"{PRD}@2" and out["head"]["kind"] == "prd_draft"
    assert out["head"]["label"] == "Draft v2" and out["head"]["document"]["slug"] == PRD
    assert out["base"]["ref"] == f"{PRD}@1" and out["base"]["kind"] == "prd_draft"
    assert out["base"]["label"] == "Draft v1"
    assert out["options"] == {
        "previous": {"ref": f"{PRD}@1", "label": "Draft v1"},
        "approved": None,
    }
    assert out["summary"] == {"added": 1, "dropped": 0, "moved": 1, "changed": 0, "unchanged": 1}
    assert [(i["item_key"], i["change"]) for i in out["items"]] == [
        ("payment-step", "unchanged"), ("shipping-step", "moved"), ("address-book", "added"),
    ]  # fmt: skip

    # Nothing approved yet: the approved plan is nothing to compare with.
    out = (
        await client.get(DIFF, params={"head": f"{PRD}@2", "base": "approved"}, headers=auth)
    ).json()
    assert out["base"] is None and out["summary"] is None and out["items"] == []
    # Draft v1 has no earlier draft.
    out = (await client.get(DIFF, params={"head": f"{PRD}@1"}, headers=auth)).json()
    assert out["base"] is None and out["options"]["previous"] is None


async def test_a_draft_compares_with_the_approved_plan(client, owner, runtime):  # noqa: F811
    """protects: "against the approved plan" for a draft is the latest approved roadmap
    version whose items trace to the PRD; fails_when: no approved option, or the base is
    another draft; no_claim: several roadmaps for one PRD."""
    _, auth = owner
    await drafts(client, auth, runtime)

    out = (
        await client.get(DIFF, params={"head": f"{PRD}@2", "base": "approved"}, headers=auth)
    ).json()
    assert out["options"]["approved"] == {"ref": f"{ROADMAP}@1", "label": "Roadmap v1"}
    assert out["options"]["previous"] == {"ref": f"{PRD}@1", "label": "Draft v1"}
    assert out["base"]["ref"] == f"{ROADMAP}@1" and out["base"]["kind"] == "roadmap"
    assert out["base"]["document"]["approved"] is True
    assert {i["item_key"]: i["change"] for i in out["items"]} == {
        "payment-step": "unchanged", "shipping-step": "moved", "address-book": "added",
    }  # fmt: skip
    # A named ref: the same PRD's draft, or a roadmap version tracing to it.
    for base in (f"{PRD}@1", f"{ROADMAP}@1"):
        resp = await client.get(DIFF, params={"head": f"{PRD}@2", "base": base}, headers=auth)
        assert resp.status_code == 200, resp.text
        assert resp.json()["base"]["ref"] == base
    # A viewer reads a draft's diff too.
    viewer = await as_user(owner[0], "viewer")
    resp = await client.get(DIFF, params={"head": f"{PRD}@2"}, headers=viewer)
    assert resp.status_code == 200, resp.text


async def test_draft_refusals(client, owner, runtime):  # noqa: F811
    """protects: a draft whose items are not ready is 409, never an empty comparison; a
    roadmap version never takes a draft as its base; fails_when: either is answered 200;
    no_claim: the roadmap refusals (test_roadmap_diff_routes.py)."""
    _, auth = owner
    await drafts(client, auth, runtime)
    await new_version(client, auth, 3)  # queued: its items are not derived yet
    resp = await client.get(DIFF, params={"head": f"{PRD}@3"}, headers=auth)
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"] == "Roadmap items for v3 are not ready yet"
    resp = await client.get(DIFF, params={"head": f"{ROADMAP}@1", "base": f"{PRD}@2"}, headers=auth)
    assert resp.status_code == 422, resp.text
    resp = await client.get(DIFF, params={"head": f"{PRD}@2", "base": f"{PRD}@3"}, headers=auth)
    assert resp.status_code == 409, resp.text


async def test_an_items_history_runs_across_drafts_and_roadmap_versions(client, owner, runtime):  # noqa: F811
    """protects: criterion 7's History, an item draft by draft and roadmap version by
    version in the order they were stored; fails_when: a draft entry is missing or out of
    order; no_claim: the 50-entry cap."""
    _, auth = owner
    await drafts(client, auth, runtime)

    resp = await client.get(HISTORY, params={"prd": PRD, "item_key": "shipping-step"}, headers=auth)
    assert resp.status_code == 200, resp.text
    entries = resp.json()["entries"]
    assert [(e["kind"], e["label"], e["horizon"], e["change"], e["approved"]) for e in entries] == [
        ("prd_draft", "Draft v1", "next", "added", True),
        ("roadmap", "Roadmap v1", "next", "unchanged", True),
        ("prd_draft", "Draft v2", "now", "moved", False),
    ]
    assert entries[0]["ref"] == f"{PRD}@1" and entries[2]["ref"] == f"{PRD}@2"
