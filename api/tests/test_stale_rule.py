"""The stale rule (the owner, Nov 23): a change that only raises the standing of the same
content does not make an approved roadmap item stale; a change to what it means does.

Cards (protects / fails_when / no_claim):

- test_a_change_that_only_raises_standing_marks_nothing: protects=each exempt kind (a feature
  or goal confirmed, however it is written, with the links and the code that come with it; a
  proposed link confirmed) marks no item; fails_when=any of them marks one; no_claim=documents
  (oracle.trace).
- test_a_change_of_meaning_marks_the_item: protects=each other kind marks the item and its
  reason names it; fails_when=one marks nothing; no_claim=the Goal map's own target edit, which
  records no change.
- test_one_event_with_both_names_only_the_change: protects=a bulk write that confirms one thing
  and edits another marks what the edit reaches and names the edit; fails_when=an item reached
  only by the confirmation is marked, or the reason counts it; no_claim=the PRD's own sections.
- test_a_settled_reason_does_not_come_back: protects=a mark on an item a person settled starts
  from the new reason; fails_when=an already settled reason reads again beside it;
  no_claim=an item under review, which keeps its reasons.
- test_a_stored_confirmation_reads_as_no_reason: protects=the panel, the Plan's At risk and the
  track's alerts follow one read of a stored mark; fails_when=any of them counts a confirmation;
  no_claim=reasons whose words do not say what changed (the migration).
"""

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select, update

from oracle.auth.deps import Principal
from oracle.baseline import fixes
from oracle.baseline import service as baseline
from oracle.baseline.models import Edge, Entity
from oracle.docs.models import Document
from oracle.roadmap import alerts, staleness
from oracle.roadmap.models import ProductTrack, RoadmapItem
from oracle.tenancy import tenant_session
from tests.fixtures import draft, import_draft
from tests.roadmap_helpers import seed_trace
from tests.test_roadmap import (  # noqa: F401 - fixtures
    ROADMAP,
    approved_prd,
    built_roadmap,
    owner,
    runtime,
    seed_baseline,
)
from tests.test_roadmap_item_staleness import ACT, SHIPPING_V1, items

BASE = "/v1/baseline"


async def seeded(client, auth, tenant_id, runtime) -> dict[str, uuid.UUID]:  # noqa: F811
    """An approved PRD and a roadmap of two items, each the item of its own feature, both
    features serving one goal; no item is stale."""
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    ids = await seed_trace(tenant_id)
    await built_roadmap(client, auth, runtime)
    async with tenant_session(tenant_id) as s:
        rows = {(e.type, e.key): e.id for e in await s.scalars(select(Entity))}
        pay, ship = rows["feature", "payment-step"], rows["feature", "shipping-step"]
        goal = rows["goal", "activation"]
        for key, feature in (("payment-step", pay), ("shipping-step", ship)):
            await s.execute(
                update(RoadmapItem)
                .where(RoadmapItem.item_key == key)
                .values(feature_id=feature, requirement_ids=[], blocker_ids=[])
            )
        edges = {(e.src_id, e.dst_id): e.id for e in await s.scalars(select(Edge))}
        await s.commit()
    got = await items(client, auth)
    assert {i["freshness"] for i in got.values()} == {"fresh"}
    return {**ids, "pay": pay, "ship": ship, "goal": goal, "link": edges[pay, goal]}


async def standing(tenant_id, model, row_id, status: str) -> None:
    """The row as it stood before: ``status``, with no change recorded."""
    async with tenant_session(tenant_id) as s:
        await s.execute(update(model).where(model.id == row_id).values(status=status))
        await s.commit()


async def ok(resp) -> dict:
    assert resp.status_code in (200, 201, 204), resp.text
    return resp.json() if resp.content else {}


async def freshness(client, auth) -> dict[str, str]:
    return {k: i["freshness"] for k, i in (await items(client, auth)).items()}


def person(tenant_id) -> Principal:
    return Principal(tenant_id=tenant_id, kind="user", role="owner")


# --- exempt ---------------------------------------------------------------------------------


async def feature_confirmed(client, auth, tenant_id, ids):
    await standing(tenant_id, Entity, ids["pay"], "proposed")
    await ok(await client.post(f"{BASE}/entities/{ids['pay']}/confirm", headers=auth))


async def feature_confirmed_with_its_goal_link(client, auth, tenant_id, ids):
    await standing(tenant_id, Edge, ids["link"], "proposed")
    await feature_confirmed(client, auth, tenant_id, ids)
    async with tenant_session(tenant_id) as s:
        assert (await s.get(Edge, ids["link"])).status == "confirmed"


async def feature_confirmed_by_an_edit(client, auth, tenant_id, ids):
    await standing(tenant_id, Entity, ids["pay"], "proposed")
    await ok(
        await client.patch(
            f"{BASE}/entities/{ids['pay']}", json={"status": "confirmed"}, headers=auth
        )
    )


async def goal_confirmed(client, auth, tenant_id, ids):
    await standing(tenant_id, Entity, ids["goal"], "proposed")
    await ok(await client.post(f"{BASE}/entities/{ids['goal']}/confirm", headers=auth))


async def link_confirmed(client, auth, tenant_id, ids):
    await standing(tenant_id, Edge, ids["link"], "proposed")
    await ok(
        await client.patch(
            f"{BASE}/edges/{ids['link']}", json={"status": "confirmed"}, headers=auth
        )
    )


async def feature_given_its_code(client, auth, tenant_id, ids):
    async with tenant_session(tenant_id) as s:
        feature = await s.get(Entity, ids["pay"])
        await fixes.give_code(s, baseline.Writer(person(tenant_id), "user"), feature)
        await s.commit()
        assert feature.key != "payment-step"


async def all_confirmed_in_one_write(client, auth, tenant_id, ids):
    for model, key in ((Entity, "pay"), (Entity, "ship"), (Entity, "goal"), (Edge, "link")):
        await standing(tenant_id, model, ids[key], "proposed")
    async with tenant_session(tenant_id) as s:
        who = person(tenant_id)
        async with baseline.batched_changes(s):
            for key in ("goal", "pay", "ship"):
                entity = await s.get(Entity, ids[key])
                await baseline.set_entity_status(s, who, entity, "confirmed", None)
        await s.commit()
        assert (await s.get(Edge, ids["link"])).status == "confirmed"


EXEMPT = [
    feature_confirmed,
    feature_confirmed_with_its_goal_link,
    feature_confirmed_by_an_edit,
    goal_confirmed,
    link_confirmed,
    feature_given_its_code,
    all_confirmed_in_one_write,
]


@pytest.mark.parametrize("kind", EXEMPT, ids=lambda f: f.__name__)
async def test_a_change_that_only_raises_standing_marks_nothing(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
    kind,
):
    """Raising the standing of the same content leaves every item as it was."""
    tenant_id, auth = owner
    ids = await seeded(client, auth, tenant_id, runtime)
    await kind(client, auth, tenant_id, ids)
    assert set((await freshness(client, auth)).values()) == {"fresh"}


# --- a change of meaning --------------------------------------------------------------------


def edit(key: str, **fields):
    async def run(client, auth, tenant_id, ids):
        await ok(await client.patch(f"{BASE}/entities/{ids[key]}", json=fields, headers=auth))

    return run


def status(key: str, verb: str):
    async def run(client, auth, tenant_id, ids):
        await ok(await client.post(f"{BASE}/entities/{ids[key]}/{verb}", headers=auth))

    return run


def edge_edit(**fields):
    async def run(client, auth, tenant_id, ids):
        await ok(await client.patch(f"{BASE}/edges/{ids['link']}", json=fields, headers=auth))

    return run


async def confirmed_with_a_new_name(client, auth, tenant_id, ids):
    await standing(tenant_id, Entity, ids["pay"], "proposed")
    await edit("pay", title="Pay in one step", status="confirmed")(client, auth, tenant_id, ids)


async def link_confirmed_with_another_weight(client, auth, tenant_id, ids):
    await standing(tenant_id, Edge, ids["link"], "proposed")
    await edge_edit(status="confirmed", attrs={"contribution": 3})(client, auth, tenant_id, ids)


async def goal_restored(client, auth, tenant_id, ids):
    await standing(tenant_id, Entity, ids["goal"], "rejected")
    await status("goal", "confirm")(client, auth, tenant_id, ids)


async def deleted(client, auth, tenant_id, ids):
    async with tenant_session(tenant_id) as s:
        goal = await s.get(Entity, ids["goal"])
        await baseline.delete_entity(s, baseline.Writer(person(tenant_id), "user"), goal)
        await s.commit()


async def link_added(client, auth, tenant_id, ids):
    body = {"src_id": str(ids["pay"]), "dst_id": str(ids["requirement"]), "type": "depends_on"}
    await ok(await client.post(f"{BASE}/edges", json=body, headers=auth))


async def link_removed(client, auth, tenant_id, ids):
    async with tenant_session(tenant_id) as s:
        edge = await s.get(Edge, ids["link"])
        await baseline.delete_edge(s, baseline.Writer(person(tenant_id), "user"), edge)
        await s.commit()


async def section_changed(client, auth, tenant_id, ids):
    text = draft("prd_v1.md").replace(SHIPPING_V1, "Show an estimated shipping cost only.")
    await ok(await import_draft(client, auth, text))


async def section_removed(client, auth, tenant_id, ids):
    await ok(await import_draft(client, auth, draft("prd_v1.md").replace("{#s-5-2}", "{#s-9}")))


async def blocker_changed(client, auth, tenant_id, ids):
    from oracle import changes

    async with tenant_session(tenant_id) as s:
        await s.execute(update(RoadmapItem).values(blocker_ids=[ids["blocker"]]))
        await changes.record_change(
            s,
            "blocker_status",
            cause="resolved",
            actor="user:example",
            subject_id=ids["blocker"],
            subject_ref="constraint:psp-rate-limit",
            data={"from_status": "open", "to_status": "resolved"},
        )
        await s.commit()


GOAL = 'The goal "Raise activation"'
PAY = 'The feature "Payment step"'
MEANING = {
    "feature_renamed": (edit("pay", title="Pay once"), 'The feature "Pay once" changed'),
    "feature_text_edited": (edit("pay", body="One page to pay."), f"{PAY} changed"),
    "goal_renamed": (edit("goal", title="Raise it"), 'The goal "Raise it" changed'),
    "goal_measure_edited": (edit("goal", attrs={"metric": "paid accounts"}), f"{GOAL} changed"),
    "goal_target_edited": (
        edit("goal", attrs={"target": 55, "unit": "%", "comparison": "at_least"}),
        f"{GOAL} changed",
    ),
    "goal_date_edited": (edit("goal", attrs={"due": "2027-03-31"}), f"{GOAL} changed"),
    "goal_rejected": (status("goal", "reject"), f"{GOAL} was rejected"),
    "goal_restored": (goal_restored, f"{GOAL} was restored"),
    "goal_deleted": (deleted, "A goal was deleted"),
    "requirement_edited": (
        edit("requirement", title="Saved cards and wallets"),
        'The requirement "Saved cards and wallets" changed',
    ),
    "confirmed_with_a_new_name": (confirmed_with_a_new_name, 'The feature "Pay in one step" '),
    "link_weight_edited": (edge_edit(attrs={"contribution": 3}), f"{PAY} had a link changed"),
    "link_confirmed_with_another_weight": (
        link_confirmed_with_another_weight,
        f"{PAY} had a link changed",
    ),
    "link_rejected": (edge_edit(status="rejected"), f"{PAY} had a link changed"),
    "link_added": (link_added, f"{PAY} gained a link"),
    "link_removed": (link_removed, f"{PAY} lost a link"),
    "blocker_changed": (blocker_changed, "changed status"),
    "section_changed": (section_changed, "PRD section 5.2 Shipping step changed in version 2"),
    "section_removed": (section_removed, "PRD section 5.2 Shipping step removed in version 2"),
}


@pytest.mark.parametrize("kind", MEANING)
async def test_a_change_of_meaning_marks_the_item(client, owner, runtime, kind):  # noqa: F811
    """Each kind that changes what an item means marks it, and its reason names the change."""
    tenant_id, auth = owner
    ids = await seeded(client, auth, tenant_id, runtime)
    if kind == "requirement_edited":
        async with tenant_session(tenant_id) as s:
            await s.execute(
                update(RoadmapItem)
                .where(RoadmapItem.item_key == "payment-step")
                .values(requirement_ids=[ids["requirement"]])
            )
            await s.commit()
    change, said = MEANING[kind]
    await change(client, auth, tenant_id, ids)
    key = "shipping-step" if kind.startswith("section") else "payment-step"
    got = (await items(client, auth))[key]
    assert got["freshness"] == "potentially_stale"
    assert len(got["stale_reasons"]) == 1 and said in got["stale_reasons"][0], got["stale_reasons"]


async def test_one_event_with_both_names_only_the_change(client, owner, runtime):  # noqa: F811
    """Confirming the goal both features serve, and rejecting one feature, in one write."""
    tenant_id, auth = owner
    ids = await seeded(client, auth, tenant_id, runtime)
    async with tenant_session(tenant_id) as s:
        # Shipping no longer depends on payment: only the goal's confirmation reaches it.
        await s.execute(update(Edge).where(Edge.type == "depends_on").values(status="rejected"))
        await s.commit()
    await standing(tenant_id, Entity, ids["goal"], "proposed")
    async with tenant_session(tenant_id) as s:
        who = person(tenant_id)
        async with baseline.batched_changes(s):
            for key, to in (("goal", "confirmed"), ("pay", "rejected")):
                entity = await s.get(Entity, ids[key])
                await baseline.set_entity_status(s, who, entity, to, None)
        await s.commit()
    got = await items(client, auth)
    assert got["shipping-step"]["freshness"] == "fresh", got["shipping-step"]["stale_reasons"]
    assert got["payment-step"]["freshness"] == "potentially_stale"
    assert got["payment-step"]["stale_reasons"] == [f"{PAY} was rejected"]


async def test_a_settled_reason_does_not_come_back(client, owner, runtime):  # noqa: F811
    """Marked, settled by a person, then marked again: only the new reason reads."""
    tenant_id, auth = owner
    ids = await seeded(client, auth, tenant_id, runtime)
    await status("goal", "reject")(client, auth, tenant_id, ids)
    body = {"action": "reconcile", "reason": "Still holds", "item_keys": ["payment-step"]}
    await ok(await client.post(ACT, json=body, headers=auth))
    await edit("pay", title="Pay once")(client, auth, tenant_id, ids)
    got = (await items(client, auth))["payment-step"]
    assert got["stale_reasons"] == ['The feature "Pay once" changed']


async def test_a_stored_confirmation_reads_as_no_reason(client, owner, runtime):  # noqa: F811
    """A mark stored before the rule: the item, the Plan and the alerts read it one way."""
    tenant_id, auth = owner
    await seeded(client, auth, tenant_id, runtime)
    await ok(await client.post(f"/v1/documents/{ROADMAP}/versions/1/approve", headers=auth))
    confirmed = ["goal:activation was confirmed", "2 Ground Truth items were confirmed"]
    edited = "PRD section 5.2 Shipping step changed in version 2"
    async with tenant_session(tenant_id) as s:
        for key, reasons in (("payment-step", confirmed), ("shipping-step", [*confirmed, edited])):
            await s.execute(
                update(RoadmapItem)
                .where(RoadmapItem.item_key == key)
                .values(
                    freshness="potentially_stale",
                    stale_reasons=reasons,
                    stale_since=datetime.now(UTC),
                )
            )
        await s.commit()
    got = await items(client, auth)
    assert got["payment-step"]["freshness"] == "fresh"
    assert got["payment-step"]["stale_reasons"] == []
    assert got["shipping-step"]["freshness"] == "potentially_stale"
    assert got["shipping-step"]["stale_reasons"] == [edited]

    plan = (await client.get("/v1/plan", headers=auth)).json()["items"]
    at_risk = {i["key"]: [r["detail"] for r in i["reasons"] if r["kind"] == "stale"] for i in plan}
    assert (at_risk["payment-step"], at_risk["shipping-step"]) == ([], [edited])

    async with tenant_session(tenant_id) as s:
        roadmap = await s.scalar(select(Document).where(Document.slug == ROADMAP))
        track = await s.scalar(
            select(ProductTrack).where(ProductTrack.roadmap_document_id == roadmap.id)
        )
    await ok(await client.post(f"/v1/tracks/{track.id}/monitor", headers=auth))
    async with tenant_session(tenant_id) as s:
        opened = {
            a.item_key: staleness.stored_reasons(a.detail)
            for a in await s.scalars(
                select(alerts.TrackAlert).where(
                    alerts.TrackAlert.kind == "stale", alerts.TrackAlert.state == "open"
                )
            )
        }
    assert opened == {"shipping-step": [edited]}
