"""trash-features-goals follow-up: a feature whose roadmap item(s) were all moved to Trash
(``DELETE /v1/simple/roadmap/items/{item_id}``, oracle.simple.trash_items.trash_feature)
still showed as a row on Simple's Priorities (oracle.simple.priorities.build) and in the
goal buckets (oracle.simple.goal_buckets.list_goal_buckets): the trash filter
(oracle.trash.filter) hides the trashed ``RoadmapItem``, but the feature's baseline
``Entity`` stays live, so the read still appended it (Priorities: ``e is None``, not
reorderable; goal buckets: the live ``Entity`` query never looked at its items at all).
Against Postgres.

The world: one roadmap ("payments") with three features: ``kept`` (its item ``pay-1``
stays on the roadmap), ``doomed`` (its only item ``pay-2`` is moved to Trash) and
``orphan`` (no roadmap item at all, never trashed). A second roadmap ("secret-roadmap",
visibility ``approvers``) with a feature ``hidden`` whose only item a commenter cannot
see: cross-roadmap visibility, not Trash, so the row still shows with no item.

Test card (protects / fails_when / no_claim):

- test_priorities_and_goal_buckets_leave_out_a_trashed_feature: protects=once the owner
  moves ``doomed``'s only roadmap item to Trash (the real delete route, as a person
  would), ``GET /v1/simple/priorities`` and ``GET /v1/simple/goal-buckets`` no longer
  list ``doomed`` at all, while ``kept`` (a live item) and ``orphan`` (no item, never
  trashed) keep showing; fails_when=``doomed`` still appears (with no item, unreorderable)
  on either read; no_claim=Trash's own restore and purge (tests/test_trash_features_goals.py).
- test_a_feature_hidden_by_roadmap_visibility_still_shows: protects=a feature whose only
  item sits on a roadmap the reader cannot see (not Trash) keeps showing on Priorities as
  it did before this fix, with no item and not reorderable; fails_when=the Trash fix also
  drops a feature that is merely invisible to this reader; no_claim=the goal buckets (which
  never filter by roadmap visibility).
"""

from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import make_people
from tests.test_simple_roadmap_api import Seed

PRIORITIES = "/v1/simple/priorities"
BUCKETS = "/v1/simple/goal-buckets"
ITEMS = "/v1/simple/roadmap/items"


class World:
    """Roadmap ``payments``: features ``kept`` (item ``pay-1``), ``doomed`` (item
    ``pay-2``, later trashed) and ``orphan`` (no item). Roadmap ``secret-roadmap``
    (approvers-only): feature ``hidden`` (item ``secret-1``)."""

    async def build(self) -> "World":
        self.ctx = await make_people()
        async with tenant_session(self.ctx.tenant_id) as s:
            seed = Seed(s)
            _, pv, rm, rv = await seed.roadmap("payments")
            kept = await seed.entity("feature", "kept")
            doomed = await seed.entity("feature", "doomed")
            orphan = await seed.entity("feature", "orphan")
            await seed.item(rv, pv, "pay-1", position=0, feature_id=kept.id)
            pay2 = await seed.item(rv, pv, "pay-2", position=1, feature_id=doomed.id)
            _, hpv, _, hrv = await seed.roadmap("secret-roadmap", visibility="approvers")
            hidden = await seed.entity("feature", "hidden")
            await seed.item(hrv, hpv, "secret-1", position=0, feature_id=hidden.id)
            await s.commit()
            self.ids = {
                "kept": str(kept.id),
                "doomed": str(doomed.id),
                "orphan": str(orphan.id),
                "hidden": str(hidden.id),
                "pay-2": str(pay2.id),
            }
        return self

    def as_(self, who: str) -> dict:
        return self.ctx.as_(who)

    async def trash_pay_2(self, client) -> None:
        resp = await client.request(
            "DELETE", f"{ITEMS}/{self.ids['pay-2']}", headers=self.as_("owner")
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["entry"] is not None, resp.text

    async def priorities(self, client, who: str = "owner") -> dict:
        resp = await client.get(PRIORITIES, headers=self.as_(who))
        assert resp.status_code == 200, resp.text
        return resp.json()

    async def buckets(self, client, who: str = "owner") -> dict:
        resp = await client.get(BUCKETS, headers=self.as_(who))
        assert resp.status_code == 200, resp.text
        return resp.json()


async def test_priorities_and_goal_buckets_leave_out_a_trashed_feature(client):
    w = await World().build()
    before = await w.priorities(client)
    before_ids = {r["feature_id"] for r in before["rows"]}
    assert {w.ids["kept"], w.ids["doomed"], w.ids["orphan"]} <= before_ids

    await w.trash_pay_2(client)

    after = await w.priorities(client)
    after_ids = {r["feature_id"] for r in after["rows"]}
    assert w.ids["doomed"] not in after_ids, after["rows"]
    assert w.ids["kept"] in after_ids
    assert w.ids["orphan"] in after_ids

    buckets = await w.buckets(client)
    bucket_ids = {f["id"] for f in buckets["features"]}
    assert w.ids["doomed"] not in bucket_ids, buckets["features"]
    assert w.ids["kept"] in bucket_ids
    assert w.ids["orphan"] in bucket_ids


async def test_a_feature_hidden_by_roadmap_visibility_still_shows(client):
    w = await World().build()
    out = await w.priorities(client, "commenter")
    rows = {r["feature_id"]: r for r in out["rows"]}
    assert w.ids["hidden"] in rows, out["rows"]
    hidden_row = rows[w.ids["hidden"]]
    assert hidden_row["item_id"] is None
    assert hidden_row["can_reorder"] is False

    await w.trash_pay_2(client)

    out = await w.priorities(client, "commenter")
    rows = {r["feature_id"]: r for r in out["rows"]}
    assert w.ids["hidden"] in rows, out["rows"]
    assert w.ids["doomed"] not in rows
