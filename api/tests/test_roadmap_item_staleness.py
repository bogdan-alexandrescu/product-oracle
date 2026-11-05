"""CR-11 and §11.5: a changed PRD section or requirement marks the roadmap items tracing
to it potentially_stale (oracle.changes), never rewriting them; people review or
reconcile. Against Postgres with the FakeRuntime."""

import uuid

import pytest
from sqlalchemy import select

from oracle import changes
from oracle.auth.deps import Principal
from oracle.baseline import service as baseline
from oracle.baseline.models import Entity
from oracle.docs.models import Document, DocumentVersion
from oracle.docs.visibility import Hidden, _words_of
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
                subject_ref=f"{n} Ground Truth items",
                data={"roots": roots, "entity_ids": [r["id"] for r in roots]},
            )
            await s.commit()

    await bulk(42)
    await bulk(11)
    reasons = (await items(client, auth))["payment-step"]["stale_reasons"]
    # Only the requirement of the 42 and of the 11 is the payment step's: it is named, once.
    assert reasons == ["requirement:saved-cards changed"], reasons


async def test_a_real_bulk_write_reads_ground_truth_items_merged_and_plural(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
):
    """#505 / prod-6 with the Ground Truth rename: a bulk write through the Ground Truth
    service (:func:`baseline.batched_changes`) names its size "N Ground Truth items", so the
    payment step's reason is narrowed to its own count, plural, and two bulk writes read one
    line; fails_when=the service writes "N baseline items" and the item reads "4 baseline
    items changed; 3 baseline items changed" or "2 Ground Truth items was confirmed"."""
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    ids = await seed_trace(tenant_id)
    await built_roadmap(client, auth, runtime)
    # The payment step's own feature and blocker, and an entity that is not its own.
    mine = (ids["feature"], ids["blocker"])
    touched = (*mine, ids["criterion"])
    writer = baseline.Writer(None, "user")

    async def bulk(n: int) -> None:
        async with tenant_session(tenant_id) as s:
            async with baseline.batched_changes(s):
                for i, entity_id in enumerate(touched):
                    entity = await s.get(Entity, entity_id)
                    await baseline.update_entity(s, writer, entity, {"body": f"Edit {n}.{i}"})
                for i in range(n - len(touched)):
                    other = await baseline.create_entity(
                        s, writer, type_="feature", key=f"other-{n}-{i}", title=f"Other {n}.{i}"
                    )
                    await baseline.update_entity(s, writer, other.entity, {"body": "Edited"})
            await s.commit()

    await bulk(5)
    async with tenant_session(tenant_id) as s:
        refs = set(
            await s.scalars(
                select(ChangeEvent.subject_ref).where(
                    ChangeEvent.subject_kind == "entity", ChangeEvent.subject_id.is_(None)
                )
            )
        )
    assert refs == {"5 Ground Truth items"}, refs
    await bulk(3)
    reasons = (await items(client, auth))["payment-step"]["stale_reasons"]
    # The 5 and then the 3 each touch two of the payment step's own: one line, its count.
    assert reasons == ["2 Ground Truth items changed"], reasons

    # A bulk confirm of its two reads "were confirmed", never "was confirmed".
    approver = Principal(tenant_id=tenant_id, kind="user", role="owner")
    async with tenant_session(tenant_id) as s:
        for entity_id in touched:
            (await s.get(Entity, entity_id)).status = "proposed"
        await s.commit()
    async with tenant_session(tenant_id) as s:
        async with baseline.batched_changes(s):
            for entity_id in touched:
                entity = await s.get(Entity, entity_id)
                await baseline.set_entity_status(s, approver, entity, "confirmed", None)
        await s.commit()
    reasons = (await items(client, auth))["payment-step"]["stale_reasons"]
    assert reasons == ["2 Ground Truth items changed", "2 Ground Truth items were confirmed"]


def test_a_stored_baseline_items_reason_reads_ground_truth_and_merges():
    """Change events and stale reasons stored before the rename say "N baseline items":
    they count as a bulk write's size, merge with the new form and read Ground Truth on
    the read path, with no migration; fails_when=an old row shows "42 baseline items
    changed" or keeps two counted lines."""
    old = ["42 baseline items changed", "11 Ground Truth items changed"]
    assert staleness.one_count(old) == ["11 Ground Truth items changed"]
    assert staleness.for_reader(["42 baseline items changed"], None) == [
        "42 Ground Truth items changed"
    ]
    assert staleness.stale_why(["3 baseline items were confirmed"], "x") == (
        "3 Ground Truth items were confirmed"
    )
    assert staleness._SIZE.fullmatch("42 baseline items")


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
    counted = "PRD section s-5-1 links 3 Ground Truth items, which changed"
    assert staleness.for_reader([new, counted], None) == [new, counted]
    # One stored before the Ground Truth rename reads Ground Truth.
    old_count = "PRD section s-5-1 links 3 baseline items, which changed"
    assert staleness.for_reader([old_count], None) == [counted]


def test_an_old_literal_reason_naming_a_hidden_decision_is_hidden_before_it_is_reworded():
    """#541 with prod-6 (the train AA stale-alert review): an old literal reason names the
    linked item by its ref ("PRD section s-5-1 links decision:d-7, which changed"); a reader
    who may not see D-7 reads the hidden-reason line, never "links a decision, which
    changed" (rewording first would drop the ref the hidden check looks for), in the
    item's reasons, the at-risk why and an alert's detail; fails_when=the reworded line
    reaches a reader D-7 is hidden from; no_claim=how Hidden is built (visibility tests)."""
    hidden = Hidden(decision_ids=frozenset(), document_ids=frozenset(), ids=frozenset(),
                    numbers=frozenset({7}), words=frozenset())  # fmt: skip
    old = "PRD section s-5-1 links decision:d-7, which changed"
    assert staleness.for_reader([old, "requirement:x changed"], hidden) == [
        staleness.HIDDEN_REASON,
        "requirement:x changed",
    ]
    detail = staleness.detail_for_reader(f"{old}; requirement:x changed", hidden)
    assert detail == f"{staleness.HIDDEN_REASON}; a requirement changed", detail
    assert "decision" not in detail
    # Who may see D-7 reads it in words.
    assert staleness.for_reader([old], None) == [
        "PRD section s-5-1 links a decision, which changed"
    ]


def _hiding(title: str) -> Hidden:
    """What a reader who may not see the decision titled ``title`` may not see."""
    return Hidden(decision_ids=frozenset(), document_ids=frozenset(), ids=frozenset(),
                  numbers=frozenset(), words=frozenset(_words_of(title)))  # fmt: skip


@pytest.mark.parametrize(
    ("title", "shown"),
    [
        # A half that reads as a ref-named reason ("plan:x renamed") is put into words.
        ("plan:enterprise renamed; tier two", "tier two"),
        # A half that reads as a counted reason is absorbed by a later count.
        ("2 Ground Truth items changed; tier two", "tier two"),
    ],
)
def test_an_old_alert_line_cut_on_a_hidden_title_is_hidden_before_it_is_reworded(title, shown):
    """cld-4 review: an old stale alert line, its reasons joined by "; ", that names a
    hidden title holding "; " is hidden on the stored text, before its halves are put into
    words or counted, so neither half reaches the reader; fails_when=one half is reworded
    or absorbed, the line read no longer names the title whole, and the other half is
    shown; no_claim=a title named in other words (Hidden.names)."""
    hidden = _hiding(title)
    detail = staleness.detail_for_reader(
        f"{title} changed; 5 Ground Truth items changed; requirement:x changed", hidden
    )
    assert shown not in detail, detail
    assert detail == (
        f"{staleness.HIDDEN_REASON}; 5 Ground Truth items changed; a requirement changed"
    )


def test_an_old_alert_line_cut_on_a_hidden_title_keeps_its_other_reasons():
    """cld-4 review: an old stale alert line naming a hidden title cut on its "; " hides
    only the parts that make up the title; the line's other reasons are read as before;
    fails_when=the whole line reads only "a linked baseline item changed"; no_claim=a
    title named in other words (Hidden.names)."""
    title = "Pricing; enterprise; tier"
    hidden = _hiding(title)
    old = f"requirement:x changed; {title} changed; feature:y moved"
    detail = staleness.detail_for_reader(old, hidden)
    assert detail == f"A requirement changed; {staleness.HIDDEN_REASON}; the feature moved", detail
    # A hidden title that ends another hidden title: neither title's parts are shown.
    both = Hidden(decision_ids=frozenset(), document_ids=frozenset(), ids=frozenset(),
                  numbers=frozenset(), words=frozenset(_words_of(
                      "Pricing; enterprise; tier", "enterprise; tier")))  # fmt: skip
    detail = staleness.detail_for_reader(old, both)
    assert detail == f"A requirement changed; {staleness.HIDDEN_REASON}; the feature moved", detail
    # Who may see it reads the line split on "; " as before.
    assert staleness.detail_for_reader(old, None) == (
        "A requirement changed; Pricing; enterprise; tier changed; the feature moved"
    )
