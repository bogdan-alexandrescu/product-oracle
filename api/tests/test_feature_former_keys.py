"""codes-on-join review: a feature given its code when it joins the Ground Truth is still
found by the key it was added with (its alias, oracle.baseline.fixes.features_by_keys), a
batch reads the codes taken once, and a join never ends without its code. Invented example
data only (a "Trip planner" feature, an "Example Co" company).

Test cards (protects / fails_when / no_claim):

- test_derive_traces_finds_a_feature_by_its_old_key: protects=a roadmap item named by the
  key its feature had before its code traces to that feature; fails_when=derive_traces reads
  features by their key now only; no_claim=a section link.
- test_item_goal_links_find_a_feature_by_its_old_key: protects=a launch item keyed by the
  feature's old key reads the goal the feature supports; fails_when=item_goal_links reads by
  the key now only.
- test_unknown_keys_know_a_features_old_key: protects=a dependency on a feature's old key is
  no unknown key; fails_when=_unknown_keys reads by the key now only.
- test_a_lost_race_on_join_is_refused: protects=two confirms that pick one code: the second
  is refused ("That code is taken; try again.") and stays proposed; fails_when=it joins with
  no code.
- test_a_create_with_another_features_old_key_names_it: protects=the refusal names the
  feature that had the key (its code and name); fails_when=it reads "feature:<key> already
  exists".
- test_a_yaml_import_reads_the_codes_taken_once: protects=an import adding 1 or 5 features
  reads the codes taken (the PRD plans) as often; fails_when=they are read per feature.

Guards added after the fix (they fail on the readers as they were before it, 064e9c4a2,
and pass now; not red-first):

- test_a_roadmap_dependency_on_a_features_old_key_shows_its_name: protects=an item that
  depends on the feature's old key reads its name; fails_when=with_dependency_names reads
  features by their key now only; no_claim=the web's own fallback.
- test_a_strategy_naming_a_features_old_key_is_no_unknown_feature: protects=a stop choice
  naming the old key raises no unknown_feature at import; fails_when=frontmatter._missing
  reads by the key now only.
- test_an_approved_strategy_naming_a_features_old_key_sets_its_edge: protects=approving it
  sets its affects edge on the feature; fails_when=sync._keyed reads by the key now only.
- test_an_engineering_brief_for_a_features_old_key_reads_its_requirements: protects=a lead
  gives a feature its code after the run's order is approved, and the brief the PRD draft
  registers, keyed by the old key, reads as the feature's with its requirements (the brief
  read route and its row); fails_when=engineering.store._feature reads by the key now only;
  no_claim=a feature set or order naming an old key (they read the key now only).
- test_an_approved_check_sets_the_size_on_a_feature_by_its_old_key: protects=the size a
  lead set at the check is written to the feature (real run, checkpoint and staged action
  rows); fails_when=check.on_approved reads by the key now only; no_claim=the run flow.
"""

import uuid

import pytest
from sqlalchemy import select

from oracle import company_time
from oracle.auth.deps import Principal
from oracle.baseline import fixes
from oracle.baseline.models import Edge, Entity
from oracle.engineering import check as eng_check
from oracle.launches import tiers
from oracle.models import AuditEvent
from oracle.roadmap import items as roadmap_items
from oracle.roadmap.models import RoadmapItem
from oracle.runs import flows
from oracle.runs.models import Checkpoint, CheckpointAction, Run
from oracle.simple import changes
from oracle.swarm import Outcome, set_runtime
from oracle.tenancy import tenant_session
from tests.baseline_helpers import entity, make_ctx
from tests.coverage_helpers import count_statements
from tests.strategy_helpers import (
    STRATEGY,
    approved,
    choice,
    edges,
    imported,
    roadmap_with_items,
    strategy_md,
)
from tests.test_simple_roadmap_api import NOW

B = "/v1/baseline"


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def _planner(client):
    ctx = await make_ctx()
    planner = await entity(client, ctx, "approver", type="feature", key="trip-planner",
                           title="Trip planner")  # fmt: skip
    assert planner["key"] == "F-01", planner
    return ctx, planner


async def test_derive_traces_finds_a_feature_by_its_old_key(client):
    ctx, planner = await _planner(client)
    async with tenant_session(ctx.tenant_id) as s:
        (trace,) = await roadmap_items.derive_traces(
            s, None, [{"id": "trip-planner", "feature": "trip-planner"}]
        )
        assert trace["feature_id"] == uuid.UUID(planner["id"]), trace


async def test_item_goal_links_find_a_feature_by_its_old_key(client):
    ctx, planner = await _planner(client)
    async with tenant_session(ctx.tenant_id) as s:
        goal = Entity(type="goal", key="more-trips", title="More trips booked", attrs={},
                      status="confirmed", origin="user", locked=False)  # fmt: skip
        s.add(goal)
        await s.flush()
        s.add(Edge(src_id=uuid.UUID(planner["id"]), dst_id=goal.id, type="supports",
                   attrs={}, status="confirmed", origin="user", locked=False))  # fmt: skip
        await s.commit()
        row = RoadmapItem(item_key="trip-planner", title="Trip planner", feature_id=None)
        _, groups, _ = await tiers.item_goal_links(s, [row])
        assert groups["trip-planner"] == "More trips booked", groups


async def test_unknown_keys_know_a_features_old_key(client):
    ctx, _ = await _planner(client)

    class NoItems:
        def by_id(self):
            return {}

    async with tenant_session(ctx.tenant_id) as s:
        left = await changes._unknown_keys(s, ["trip-planner", "no-such"], NoItems())
        assert left == ["no-such"]


async def test_a_lost_race_on_join_is_refused(client, monkeypatch):
    ctx = await make_ctx()
    one = await entity(client, ctx, "approver", type="feature", key="packing-list",
                       title="Packing list", status="proposed")  # fmt: skip
    two = await entity(client, ctx, "approver", type="feature", key="route-maps",
                       title="Route maps", status="proposed")  # fmt: skip

    async def same(db, feature):  # both confirms pick the one code
        return "F-50"

    monkeypatch.setattr(fixes, "next_code", same)
    r = await client.post(f"{B}/entities/{one['id']}/confirm", headers=ctx.as_("approver"))
    assert r.status_code == 200, r.text
    assert r.json()["key"] == "F-50"
    r = await client.post(f"{B}/entities/{two['id']}/confirm", headers=ctx.as_("approver"))
    assert r.status_code == 409, r.text
    assert "That code is taken; try again." in r.text
    async with tenant_session(ctx.tenant_id) as s:
        e = await s.get(Entity, uuid.UUID(two["id"]))
        assert (e.key, e.status) == ("route-maps", "proposed")


async def test_a_create_with_another_features_old_key_names_it(client):
    ctx, _ = await _planner(client)
    body = {"type": "feature", "key": "trip-planner", "title": "Trips"}
    r = await client.post(f"{B}/entities", headers=ctx.as_("approver"), json=body)
    assert r.status_code == 409, r.text
    assert "The key trip-planner is F-01 Trip planner's old key." in r.text


def _yaml(n: int, prefix: str) -> str:
    rows = "".join(
        f"  - type: feature\n    key: {prefix}-{i}\n    title: Example {prefix} {i}\n"
        "    status: confirmed\n"
        for i in range(n)
    )
    return f"version: 1\nentities:\n{rows}"


async def test_a_yaml_import_reads_the_codes_taken_once(client):
    ctx = await make_ctx()
    reads = []
    for n, prefix in ((1, "one"), (5, "five")):
        with count_statements() as seen:
            headers = {**ctx.as_("owner"), "Content-Type": "application/yaml"}
            r = await client.post(f"{B}/yaml", content=_yaml(n, prefix).encode(), headers=headers)
        assert r.status_code == 200, r.text
        reads.append(sum("simple_prd_plans" in q for q in seen))
    assert reads[0] == reads[1], reads
    async with tenant_session(ctx.tenant_id) as s:
        found = await fixes.features_by_keys(s, ["one-0", *(f"five-{i}" for i in range(5))])
        assert sorted(e.key for e in found.values()) == [f"F-0{i}" for i in range(1, 7)]


async def test_a_roadmap_dependency_on_a_features_old_key_shows_its_name(client):
    ctx, _ = await _planner(client)
    await roadmap_with_items(client, ctx, [("trip-sharing", "now", None)], track=False)
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.scalar(select(RoadmapItem).where(RoadmapItem.item_key == "trip-sharing"))
        row.depends_on = ["trip-planner"]
        await s.commit()
    r = await client.get(
        "/v1/roadmaps/example-roadmap/items", params={"version": 1}, headers=ctx.as_("owner")
    )
    assert r.status_code == 200, r.text
    (item,) = r.json()["items"]
    assert item["depends_titles"] == {"trip-planner": "Trip planner"}, item


async def test_a_strategy_naming_a_features_old_key_is_no_unknown_feature(client):
    ctx, _ = await _planner(client)
    md = strategy_md([choice("one", goals=[]), choice("trips", "stop", features=["trip-planner"])])
    v = await imported(client, ctx.as_("owner"), STRATEGY, md)
    assert "unknown_feature" not in {w["code"] for w in v["warnings"]}, v["warnings"]


async def test_an_approved_strategy_naming_a_features_old_key_sets_its_edge(client):
    ctx, planner = await _planner(client)
    md = strategy_md([choice("one", goals=[]), choice("trips", "stop", features=["trip-planner"])])
    await imported(client, ctx.as_("owner"), STRATEGY, md)
    await approved(client, ctx.as_("owner"), STRATEGY, 1)
    affects = await edges(ctx.tenant_id, "affects")
    assert [e.dst_id for e in affects] == [uuid.UUID(planner["id"])], affects


async def test_an_engineering_brief_for_a_features_old_key_reads_its_requirements(
    client, monkeypatch
):
    from tests.tech_brief_helpers import NO_MAP, BriefsRuntime, flow_with_eng_check, seed_features
    from tests.test_tech_briefs import advance_to, brief_rows, decide, start

    monkeypatch.setitem(flows.FLOWS, "baseline_to_prd", flow_with_eng_check())
    set_runtime(BriefsRuntime({"eng_check": [Outcome(artifacts={flows.BRIEFS_FILE: NO_MAP})]}))
    try:
        ctx = await make_ctx()
        ids = await seed_features(ctx.tenant_id)
        owner = ctx.as_("owner")
        run = await start(client, owner, "trip-briefs")
        # The order approved, a lead gives feature-a its code before the PRD draft
        # registers the briefs: they still name the key it had before.
        await decide(client, owner, await advance_to(client, owner, run["id"], "priority_order"))
        r = await client.post(f"{B}/entities/{ids['feature-a']}/code", headers=ctx.as_("approver"))
        assert r.status_code == 200, r.text
        await advance_to(client, owner, run["id"], "prd_review")
    finally:
        set_runtime(None)
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(Entity, ids["feature-a"])).key == "F-01"
    r = await client.get(
        "/v1/tech-briefs", params={"prd": "trip-briefs", "feature": "feature-a"},
        headers=ctx.as_("viewer"),
    )  # fmt: skip
    assert r.status_code == 200, r.text
    (brief,) = r.json()
    assert brief["feature"]["entity_id"] == str(ids["feature-a"]), brief
    by_key = {q.params["feature_key"]: q for q, _ in await brief_rows(ctx.tenant_id)}
    assert set(by_key["feature-a"].requirement_ids) == {ids["req-a1"], ids["req-a2"]}, by_key


async def test_an_approved_check_sets_the_size_on_a_feature_by_its_old_key(client):
    ctx, planner = await _planner(client)
    lead = ctx.users["approver"]
    principal = Principal(tenant_id=ctx.tenant_id, kind="user", role="approver",
                          user_id=lead.id)  # fmt: skip
    payload = {eng_check.PAYLOAD_KEY: {"features": [{"key": "trip-planner", "size": "s"}]}}
    async with tenant_session(ctx.tenant_id) as s:
        run = Run(flow="baseline_to_prd", status="running")
        s.add(run)
        await s.flush()
        cp = Checkpoint(run_id=run.id, kind=eng_check.KIND, status="pending", payload=payload)
        s.add(cp)
        await s.flush()
        size = CheckpointAction(checkpoint_id=cp.id, item_key="trip-planner", kind="edit",
                                field="size", state="staged", value="l")  # fmt: skip
        s.add(size)
        await s.flush()
        await eng_check.on_approved(s, principal, run, cp, [size])
        await s.commit()
    async with tenant_session(ctx.tenant_id) as s:
        feature = await s.get(Entity, uuid.UUID(planner["id"]))
        assert (feature.key, feature.attrs.get("effort")) == ("F-01", "l"), feature.attrs
        set_ = await s.scalar(select(AuditEvent).where(AuditEvent.action == "entity.effort_set"))
        assert set_ is not None and set_.entity_id == feature.id
