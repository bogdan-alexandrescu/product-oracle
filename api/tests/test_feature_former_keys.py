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
- test_a_strategy_naming_a_features_old_key_finds_it: protects=a stop choice naming the old
  key is no unknown_feature and approving it sets its affects edge on the feature;
  fails_when=frontmatter._missing or sync._keyed read by the key now only.
- test_an_engineering_brief_for_a_features_old_key_reads_its_requirements: protects=a brief
  keyed by the old key is registered against the feature and its requirements;
  fails_when=engineering.store._feature reads by the key now only; no_claim=the run flow.
- test_an_approved_check_sets_the_size_on_a_feature_by_its_old_key: protects=the size a
  lead set at the check is written to the feature; fails_when=check.on_approved reads by
  the key now only; no_claim=the run flow.
"""

import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from oracle import company_time
from oracle.auth.deps import Principal
from oracle.baseline import fixes
from oracle.baseline.models import Edge, Entity
from oracle.engineering import check as eng_check
from oracle.engineering import store as eng_store
from oracle.launches import tiers
from oracle.models import AuditEvent
from oracle.roadmap import items as roadmap_items
from oracle.roadmap.models import RoadmapItem
from oracle.simple import changes
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


async def test_a_strategy_naming_a_features_old_key_finds_it(client):
    ctx, planner = await _planner(client)
    md = strategy_md([choice("one", goals=[]), choice("trips", "stop", features=["trip-planner"])])
    v = await imported(client, ctx.as_("owner"), STRATEGY, md)
    assert "unknown_feature" not in {w["code"] for w in v["warnings"]}, v["warnings"]
    await approved(client, ctx.as_("owner"), STRATEGY, 1)
    affects = await edges(ctx.tenant_id, "affects")
    assert [e.dst_id for e in affects] == [uuid.UUID(planner["id"])], affects


async def test_an_engineering_brief_for_a_features_old_key_reads_its_requirements(client):
    ctx, planner = await _planner(client)
    async with tenant_session(ctx.tenant_id) as s:
        req = Entity(type="requirement", key="trip-dates", title="Pick trip dates", attrs={},
                     status="confirmed", origin="user", locked=False)  # fmt: skip
        s.add(req)
        await s.flush()
        s.add(Edge(src_id=req.id, dst_id=uuid.UUID(planner["id"]), type="part_of",
                   attrs={}, status="confirmed", origin="user", locked=False))  # fmt: skip
        await s.commit()
        feature = await eng_store._feature(s, "trip-planner")
        assert feature is not None and feature.id == uuid.UUID(planner["id"])
        assert await eng_store._requirements(s, feature.id) == [req.id]


async def test_an_approved_check_sets_the_size_on_a_feature_by_its_old_key(client):
    ctx, planner = await _planner(client)
    lead = ctx.users["approver"]
    principal = Principal(tenant_id=ctx.tenant_id, kind="user", role="approver",
                          user_id=lead.id)  # fmt: skip
    cp = SimpleNamespace(
        id=uuid.uuid4(),
        payload={eng_check.PAYLOAD_KEY: {"features": [{"key": "trip-planner", "size": "s"}]}},
    )
    size = SimpleNamespace(item_key="trip-planner", field="size", state="staged", kind="edit",
                           value="l")  # fmt: skip
    async with tenant_session(ctx.tenant_id) as s:
        await eng_check.on_approved(s, principal, SimpleNamespace(id=uuid.uuid4()), cp, [size])
        await s.commit()
    async with tenant_session(ctx.tenant_id) as s:
        feature = await s.get(Entity, uuid.UUID(planner["id"]))
        assert (feature.key, feature.attrs.get("effort")) == ("F-01", "l"), feature.attrs
        set_ = await s.scalar(select(AuditEvent).where(AuditEvent.action == "entity.effort_set"))
        assert set_ is not None and set_.entity_id == feature.id
