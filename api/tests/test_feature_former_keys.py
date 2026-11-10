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
"""

import uuid

import pytest

from oracle import company_time
from oracle.baseline import fixes
from oracle.baseline.models import Edge, Entity
from oracle.launches import tiers
from oracle.roadmap import items as roadmap_items
from oracle.roadmap.models import RoadmapItem
from oracle.simple import changes
from oracle.tenancy import tenant_session
from tests.baseline_helpers import entity, make_ctx
from tests.coverage_helpers import count_statements
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
