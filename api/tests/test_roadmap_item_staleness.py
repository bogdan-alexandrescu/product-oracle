"""CR-11 and §11.5: a changed PRD section or requirement marks the roadmap items tracing
to it potentially_stale (oracle.changes), never rewriting them; people review or
reconcile. Against Postgres with the FakeRuntime."""

import uuid

from sqlalchemy import select

from oracle import changes
from oracle.baseline.models import Entity
from oracle.docs.models import Document, DocumentVersion
from oracle.roadmap import staleness
from oracle.roadmap.models import RoadmapItem
from oracle.tenancy import tenant_session
from oracle.v2.models import ChangeEvent
from tests.fixtures import draft, import_draft
from tests.roadmap_helpers import seed_trace
from tests.test_roadmap import (  # noqa: F401 - fixtures
    PRD,
    ROADMAP,
    approved_prd,
    as_user,
    built_roadmap,
    owner,
    runtime,
    seed_baseline,
)
from tests.trace_helpers import link_section

URL = f"/v1/roadmaps/{ROADMAP}/items"
SHIPPING_V1 = "Show the shipping cost on the cart page, before the shopper enters an address."


def prd_v2() -> str:
    """Version 1 with only section 5.2 (shipping) rewritten."""
    text = draft("prd_v1.md")
    assert SHIPPING_V1 in text
    return text.replace(SHIPPING_V1, "Show an estimated shipping cost from the postcode only.")


ACT = f"/v1/roadmaps/{ROADMAP}/items/staleness"


async def items(client, auth) -> dict[str, dict]:
    out = (await client.get(URL, headers=auth)).json()
    return {i["item_key"]: i for i in out["items"]}


async def test_a_new_prd_version_marks_only_the_items_whose_section_changed(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
):
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    async with tenant_session(tenant_id) as s:
        before = {
            i.item_key: (i.title, i.horizon, i.milestone)
            for i in await s.scalars(select(RoadmapItem))
        }

    # PRD v2 rewrites 5.2 (shipping) and leaves 5.1 (payment) as it was.
    assert (await import_draft(client, auth, prd_v2())).status_code == 201
    got = await items(client, auth)
    assert got["payment-step"]["freshness"] == "fresh"
    ship = got["shipping-step"]
    assert ship["freshness"] == "potentially_stale"
    assert ship["stale_reasons"] == ["PRD section s-5-2 changed in version 2"]
    assert ship["stale_since"] and ship["caused_by_change_id"]
    # Still traced to the PRD version it was built from: nothing rewritten.
    assert ship["prd"]["document"]["version"] == 1
    async with tenant_session(tenant_id) as s:
        after = {
            i.item_key: (i.title, i.horizon, i.milestone)
            for i in await s.scalars(select(RoadmapItem))
        }
        assert after == before
        event = await s.get(ChangeEvent, ship["caused_by_change_id"])
        assert event.subject_kind == "document_version" and event.cause == "version_imported"
        assert event.handled_by.index("trace.mark_stale") < event.handled_by.index("roadmap.items")
        assert event.data["roadmap"]["item_ids"] == [ship["id"]]


async def test_a_changed_requirement_marks_its_items(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    ids = await seed_trace(tenant_id)
    await built_roadmap(client, auth, runtime)
    assert {i["freshness"] for i in (await items(client, auth)).values()} == {"fresh"}

    resp = await client.patch(
        f"/v1/baseline/entities/{ids['requirement']}",
        json={"title": "Saved cards and wallets"},
        headers=auth,
    )
    assert resp.status_code == 200, resp.text
    got = await items(client, auth)
    assert got["payment-step"]["freshness"] == "potentially_stale"
    assert got["payment-step"]["stale_reasons"] == ["requirement:saved-cards changed"]
    assert got["shipping-step"]["freshness"] == "fresh"


async def test_a_blocker_status_change_marks_its_items(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    ids = await seed_trace(tenant_id)
    await built_roadmap(client, auth, runtime)
    resp = await client.post(
        f"/v1/blockers/{ids['blocker']}/status",
        json={"status": "mitigating", "reason": "Token bucket in review"},
        headers=auth,
    )
    assert resp.status_code == 200, resp.text
    got = await items(client, auth)
    assert got["payment-step"]["freshness"] == "potentially_stale"
    assert got["payment-step"]["blockers"][0]["blocker_status"] == "mitigating"


async def test_review_and_reconcile(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)

    # Nothing is stale yet.
    resp = await client.post(ACT, json={"action": "review"}, headers=auth)
    assert resp.status_code == 409

    assert (await import_draft(client, auth, prd_v2())).status_code == 201
    resp = await client.post(
        ACT, json={"action": "review", "item_keys": ["shipping-step"]}, headers=auth
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["changed"][0]["to"] == "under_review"

    resp = await client.post(ACT, json={"action": "reconcile"}, headers=auth)
    assert resp.status_code == 422  # a reason is needed
    resp = await client.post(ACT, json={"action": "review", "item_keys": ["nope"]}, headers=auth)
    assert resp.status_code == 422

    commenter = await as_user(tenant_id, "commenter")
    resp = await client.post(
        ACT, json={"action": "reconcile", "reason": "Still holds"}, headers=commenter
    )
    assert resp.status_code == 403

    # Reconciled against the latest *approved* PRD version: v2 is a draft, so v1.
    resp = await client.post(
        ACT, json={"action": "reconcile", "reason": "Shipping estimate still fits"}, headers=auth
    )
    assert resp.status_code == 200, resp.text
    ship = (await items(client, auth))["shipping-step"]
    assert ship["freshness"] == "reconciled" and ship["note"] == "Shipping estimate still fits"
    assert ship["prd"]["document"]["version"] == 1 and ship["prd"]["reconciled_version"] == 1
    built_hash = ship["prd"]["section_hash"]

    assert (
        await client.post(f"/v1/documents/{PRD}/versions/2/approve", headers=auth)
    ).status_code == 200
    # Stale again (as a later change would make it); reconciling now records v2.
    async with tenant_session(tenant_id) as s:
        row = await s.scalar(select(RoadmapItem).where(RoadmapItem.item_key == "shipping-step"))
        row.freshness = "potentially_stale"
        await s.commit()
    resp = await client.post(
        ACT, json={"action": "reconcile", "reason": "Checked against v2"}, headers=auth
    )
    assert resp.status_code == 200, resp.text
    ship = (await items(client, auth))["shipping-step"]
    # The trace stays as built (v1, its hash); what it was reconciled against is v2.
    assert ship["prd"]["document"]["version"] == 1 and ship["prd"]["section_hash"] == built_hash
    assert ship["prd"]["reconciled_version"] == 2
    assert ship["prd"]["reconciled_section_hash"] not in (None, built_hash)
    anchor = resp.json()["changed"][0]["anchor_before"]
    assert anchor["version_id"] and anchor["section_hash"]

    # A v3 that leaves 5.2 as v2 has it does not make the item stale again.
    v3 = prd_v2().replace("- First-time buyers on mobile.", "- First-time buyers on phones.")
    assert v3 != prd_v2()
    assert (await import_draft(client, auth, v3)).status_code == 201
    assert (await items(client, auth))["shipping-step"]["freshness"] == "reconciled"


async def test_bulk_changes_name_the_count_that_applies_to_the_item_once(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
):
    """#505: two bulk writes (42 items, then 11) that each touch the payment step's
    requirement say what changed once, with the payment step's own count; never
    "42 baseline items changed; 11 baseline items changed"."""
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    ids = await seed_trace(tenant_id)
    await built_roadmap(client, auth, runtime)

    async def bulk(n: int) -> None:
        roots = [{"id": str(ids["requirement"]), "ref": "requirement:saved-cards"}] + [
            {"id": str(uuid.uuid4()), "ref": f"feature:other-{i}"} for i in range(n - 1)
        ]
        async with tenant_session(tenant_id) as s:
            await changes.record_change(
                s,
                "entity",
                cause="entity_updated",
                actor=None,
                subject_ref=f"{n} baseline items",
                data={"roots": roots, "entity_ids": [r["id"] for r in roots]},
            )
            await s.commit()

    await bulk(42)
    await bulk(11)
    reasons = (await items(client, auth))["payment-step"]["stale_reasons"]
    # Only the requirement of the 42 and of the 11 is the payment step's: it is named, once.
    assert reasons == ["requirement:saved-cards changed"], reasons


async def test_a_section_link_names_the_section_and_the_feature_it_links(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
):
    """prod-6: an item whose PRD section links a changed entity (not its own feature,
    requirement or blocker) names the section by its title and the entity by its name,
    never "PRD section s-5-1 links feature:promo-codes, which changed"."""
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    await built_roadmap(client, auth, runtime)

    async with tenant_session(tenant_id) as s:
        promo = Entity(
            type="feature", key="promo-codes", title="Promo codes",
            status="confirmed", origin="user",
        )  # fmt: skip
        s.add(promo)
        await s.flush()
        promo_id = promo.id
        doc_id = await s.scalar(select(Document.id).where(Document.slug == PRD))
        version_id = await s.scalar(
            select(DocumentVersion.id).where(
                DocumentVersion.document_id == doc_id, DocumentVersion.number == 1
            )
        )
        await s.commit()
    # The payment step's own section (s-5-1) links a feature that is not its own.
    await link_section(tenant_id, doc_id, version_id, "s-5-1", entity_id=promo_id)

    resp = await client.patch(
        f"/v1/baseline/entities/{promo_id}", json={"title": "Promo codes v2"}, headers=auth
    )
    assert resp.status_code == 200, resp.text

    got = await items(client, auth)
    assert got["payment-step"]["freshness"] == "potentially_stale"
    assert got["payment-step"]["stale_reasons"] == [
        "PRD section 5.1 Payment step links Promo codes v2, which changed"
    ]
    assert got["shipping-step"]["freshness"] == "fresh"


def test_an_old_literal_section_link_reason_is_reworded_when_read():
    """prod-6: a reason stored before the fix named the linked item by its bare ref
    ("PRD section s-5-1 links feature:promo-codes, which changed"); the read path
    (:func:`staleness.for_reader`, :func:`staleness.stale_why`) puts it in words
    without a migration, the same as a freshly written reason would read."""
    old = "PRD section s-5-1 links feature:promo-codes, which changed"
    reworded = "PRD section s-5-1 links the feature, which changed"
    assert staleness.for_reader([old], None) == [reworded]
    assert staleness.stale_why([old], "default") == reworded
    # Read back from a stored TrackAlert.detail (hidden=None: nothing masked, but still
    # put into words - the only read path for an alert opened before the fix).
    assert staleness.detail_for_reader(old, None) == reworded
    # Already-worded (new-form) reasons, and counted ones, pass through unchanged.
    new = "PRD section s-5-1 links Promo codes, which changed"
    counted = "PRD section s-5-1 links 3 baseline items, which changed"
    assert staleness.for_reader([new, counted], None) == [new, counted]
