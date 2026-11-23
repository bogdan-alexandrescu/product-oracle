"""An approved roadmap version settles the stale items it keeps (the owner, Nov 23).

Cards (protects / fails_when / no_claim):

- test_approving_a_version_settles_what_it_keeps: protects=approving roadmap version 2
  reconciles each potentially stale item it keeps, with "Kept in version 2, approved <Mon D>
  by <name>", the approver acting, audited, the PRD's approved version stored as its anchor;
  an item the version changed stays flagged; a change after the approval flags the kept item
  again; fails_when=the kept item stays potentially_stale, or the changed one is settled, or
  a later change is swallowed; no_claim=the Plan's counts (web e2e).
- test_the_migration_settles_todays_flags: protects=migration 0134 reconciles flagged items
  kept in their roadmap's latest approved version whose flagging change is older than the
  approval, twice safely; an item changed after it, an item the version changed and an item
  of an older version stay as they are; fails_when=any of those is wrong;
  no_claim=the approval path (above).
- test_a_confirmation_is_not_a_change: protects=confirming a Ground Truth item (status only,
  alone or in a bulk write) marks no roadmap item; a real content change still does;
  fails_when=a confirmation marks the item, or a rename does not; no_claim=link confirmations
  (an edge change event does not say the status it had).
"""

import importlib.util
import uuid

from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import select, update

from oracle.baseline.models import Entity
from oracle.docs.models import Document, DocumentVersion
from oracle.models import AuditEvent
from oracle.roadmap import staleness
from oracle.roadmap.models import RoadmapItem
from oracle.tenancy import tenant_session
from oracle.v2.models import ChangeEvent
from tests.conftest import API_DIR
from tests.fixtures import import_draft
from tests.roadmap_helpers import seed_trace
from tests.test_roadmap import (  # noqa: F401 - fixtures
    ROADMAP,
    ROADMAP_MD,
    approved_prd,
    built_roadmap,
    owner,
    runtime,
    seed_baseline,
)

REVISION = "0134_stale_settled_by_approval"
PREVIOUS = "0133_null_run_cost"


def _migration():
    path = API_DIR / "migrations" / "versions" / f"{REVISION}.py"
    spec = importlib.util.spec_from_file_location(REVISION, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def _approve(client, auth, n: int) -> None:
    resp = await client.post(f"/v1/documents/{ROADMAP}/versions/{n}/approve", headers=auth)
    assert resp.status_code == 200, resp.text


async def _rename_requirement(client, auth, ids, title: str) -> None:
    resp = await client.patch(
        f"/v1/baseline/entities/{ids['requirement']}", json={"title": title}, headers=auth
    )
    assert resp.status_code == 200, resp.text


async def _version_items(tenant_id, n: int) -> dict[str, RoadmapItem]:
    async with tenant_session(tenant_id) as s:
        v = await s.scalar(
            select(DocumentVersion)
            .join(Document, Document.id == DocumentVersion.document_id)
            .where(Document.slug == ROADMAP, DocumentVersion.number == n)
        )
        rows = await s.scalars(select(RoadmapItem).where(RoadmapItem.roadmap_version_id == v.id))
        return {i.item_key: i for i in rows}


async def _two_versions(client, auth, tenant_id, runtime) -> dict:  # noqa: F811
    """Roadmap v1 approved; v2 imported keeping payment-step and renaming shipping-step;
    payment-step flagged by a requirement change, shipping-step flagged by hand."""
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    ids = await seed_trace(tenant_id)
    await built_roadmap(client, auth, runtime)
    await _approve(client, auth, 1)
    v2 = ROADMAP_MD.replace("payment first, then shipping.", "payment first, shipping next.")
    assert (await import_draft(client, auth, v2, doc=ROADMAP)).status_code == 201
    v2_items = await _version_items(tenant_id, 2)
    assert set(v2_items) == {"payment-step", "shipping-step"}
    async with tenant_session(tenant_id) as s:
        await s.execute(
            update(RoadmapItem)
            .where(RoadmapItem.id == v2_items["shipping-step"].id)
            .values(
                title="Shipping step, estimated",
                freshness="potentially_stale",
                stale_reasons=["PRD section 5.2 Shipping step changed in version 2"],
            )
        )
        await s.commit()
    await _rename_requirement(client, auth, ids, "Saved cards and wallets")
    got = await _version_items(tenant_id, 2)
    assert got["payment-step"].freshness == "potentially_stale"
    return ids


async def test_approving_a_version_settles_what_it_keeps(client, owner, runtime):  # noqa: F811
    """Approving v2 reconciles the kept stale item, not the changed one; a later change flags."""
    tenant_id, auth = owner
    ids = await _two_versions(client, auth, tenant_id, runtime)

    await _approve(client, auth, 2)

    got = await _version_items(tenant_id, 2)
    pay, ship = got["payment-step"], got["shipping-step"]
    assert pay.freshness == "reconciled", pay.freshness
    async with tenant_session(tenant_id) as s:
        v2 = await s.get(DocumentVersion, pay.roadmap_version_id)
        name = await staleness.approver_name(s, v2.approved_by)
        when = v2.approved_at
        audits = list(
            await s.scalars(
                select(AuditEvent).where(AuditEvent.action == "roadmap.items.reconcile")
            )
        )
    assert pay.note == f"Kept in version 2, approved {when:%b} {when.day} by {name}"
    assert pay.reconciled_at is not None and pay.reconciled_by is not None
    assert pay.reconciled_version_id is not None
    assert ship.freshness == "potentially_stale"
    assert len(audits) == 1 and [e["item"] for e in audits[0].data["items"]] == ["payment-step"]
    assert audits[0].actor != "system"

    await _rename_requirement(client, auth, ids, "Saved cards, wallets and vouchers")
    assert (await _version_items(tenant_id, 2))["payment-step"].freshness == "potentially_stale"


async def _unsettle(tenant_id, item_id, event_id) -> None:
    """The item as it stood before the fix: flagged by ``event_id``, never reconciled."""
    async with tenant_session(tenant_id) as s:
        await s.execute(
            update(RoadmapItem)
            .where(RoadmapItem.id == item_id)
            .values(
                freshness="potentially_stale",
                caused_by_change_id=event_id,
                note=None,
                reconciled_by=None,
                reconciled_at=None,
                reconciled_version_id=None,
                reconciled_section_hash=None,
            )
        )
        await s.commit()


async def _run_migration(tenant_id) -> None:
    async with tenant_session(tenant_id) as s:
        await s.execute(_migration().STATEMENT)
        await s.commit()


def test_chains_on_the_single_head():
    """The migration chains directly onto its prior revision; the branch has one head, which a
    later migration (unique item codes, after feature comments) now holds."""
    script = ScriptDirectory.from_config(Config(str(API_DIR / "alembic.ini")))
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_revision("0135_feature_comments").down_revision == REVISION
    assert script.get_heads() == ["0136_unique_item_codes"]


async def test_the_migration_settles_todays_flags(client, owner, runtime):  # noqa: F811
    """Flagged before the approval: settled; after it, changed or dropped: untouched; twice."""
    tenant_id, auth = owner
    ids = await _two_versions(client, auth, tenant_id, runtime)
    before = await _version_items(tenant_id, 2)
    event_id = before["payment-step"].caused_by_change_id
    assert event_id is not None
    v1 = await _version_items(tenant_id, 1)
    assert v1["payment-step"].freshness == "potentially_stale"
    await _approve(client, auth, 2)
    pay = before["payment-step"]
    await _unsettle(tenant_id, pay.id, event_id)

    await _run_migration(tenant_id)
    await _run_migration(tenant_id)

    got = await _version_items(tenant_id, 2)
    async with tenant_session(tenant_id) as s:
        v2 = await s.get(DocumentVersion, pay.roadmap_version_id)
        name = await staleness.approver_name(s, v2.approved_by)
        when = v2.approved_at
        audits = list(
            await s.scalars(
                select(AuditEvent).where(AuditEvent.action == "roadmap.items.settled_by_approval")
            )
        )
    assert got["payment-step"].freshness == "reconciled"
    assert got["payment-step"].note == f"Kept in version 2, approved {when:%b} {when.day} by {name}"
    assert got["payment-step"].reconciled_by == v2.approved_by
    assert got["payment-step"].reconciled_version_id is not None
    assert (got["payment-step"].title, got["payment-step"].horizon) == (pay.title, pay.horizon)
    assert len(audits) == 1
    # The version changed it: left flagged. An older version's rows: untouched.
    assert got["shipping-step"].freshness == "potentially_stale"
    assert (await _version_items(tenant_id, 1))["payment-step"].freshness == "potentially_stale"
    async with tenant_session(tenant_id) as s:
        assert (await s.get(DocumentVersion, v2.id)).approved_at == when

    # A change after the approval: the item stays flagged.
    await _rename_requirement(client, auth, ids, "Saved cards, wallets and vouchers")
    await _run_migration(tenant_id)
    assert (await _version_items(tenant_id, 2))["payment-step"].freshness == "potentially_stale"


async def _mark_with(tenant_id, item_id, cause: str, data: dict, subject_id=None) -> str:
    async with tenant_session(tenant_id) as s:
        item = await s.get(RoadmapItem, item_id)
        event = ChangeEvent(
            subject_kind="entity",
            subject_id=subject_id or item.feature_id,
            subject_ref=None if subject_id is None and "roots" in data else "feature:payment-step",
            cause=cause,
            actor="user:example",
            data=data,
        )
        s.add(event)
        await s.flush()
        await staleness.mark_items(s, event)
        await s.commit()
        await s.refresh(item)
        return item.freshness


async def test_a_confirmation_is_not_a_change(client, owner, runtime):  # noqa: F811
    """A status-only confirmation marks nothing; a rename of the same feature marks it."""
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    await built_roadmap(client, auth, runtime)
    async with tenant_session(tenant_id) as s:
        feature = await s.scalar(
            select(Entity.id).where(Entity.type == "feature", Entity.key == "payment-step")
        )
        await s.execute(update(RoadmapItem).values(feature_id=feature))
        item_id = await s.scalar(
            select(RoadmapItem.id).where(RoadmapItem.item_key == "payment-step").limit(1)
        )
        await s.commit()
    entity = {"id": str(feature), "type": "feature", "key": "f-07", "title": "Payment step"}

    one = {"fields": ["key", "status"], "entity": entity}
    assert await _mark_with(tenant_id, item_id, "entity_confirmed", one) == "fresh"
    other = str(uuid.uuid4())
    bulk = {
        "entity_ids": [str(feature), other],
        "fields": ["status"],
        "roots": [
            {"id": str(feature), "ref": "feature:f-07", "cause": "entity_confirmed",
             "fields": ["status"], "entity": entity},
            {"id": other, "ref": "goal:kr-1", "cause": "entity_confirmed", "fields": ["status"],
             "entity": {"id": other, "type": "goal", "key": "kr-1", "title": "Example goal"}},
        ],
    }  # fmt: skip
    async with tenant_session(tenant_id) as s:
        event = ChangeEvent(
            subject_kind="entity",
            subject_ref="2 Ground Truth items",
            cause="entity_confirmed",
            actor="user:example",
            data=bulk,
        )
        s.add(event)
        await s.flush()
        await staleness.mark_items(s, event)
        await s.commit()
        assert (await s.get(RoadmapItem, item_id)).freshness == "fresh"

    renamed = {"fields": ["title"], "entity": {**entity, "title": "Pay in one step"}}
    assert await _mark_with(tenant_id, item_id, "entity_updated", renamed) == "potentially_stale"


async def test_a_plan_item_is_under_the_track_that_holds_its_alerts(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
):
    """protects=the Plan item's track is the one its track alerts are raised on
    (views.owner_of: its PRD's track among those that follow the roadmap), so its panel finds
    its stale alert and shows Review and Still valid…; fails_when=an item whose own track_id
    names another track reads that track, whose alerts never hold it (the owner's report: 29 of
    60 flagged items had no review form); no_claim=the alerts' own rules."""
    from oracle.roadmap.models import ProductTrack

    tenant_id, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    await _approve(client, auth, 1)
    async with tenant_session(tenant_id) as s:
        roadmap = await s.scalar(select(Document).where(Document.slug == ROADMAP))
        followed = list(
            await s.scalars(
                select(ProductTrack).where(ProductTrack.roadmap_document_id == roadmap.id)
            )
        )
        assert len(followed) == 1, followed
        other = ProductTrack(title="Example other track")
        s.add(other)
        await s.flush()
        await s.execute(update(RoadmapItem).values(track_id=other.id))
        await s.commit()
        holder, other_id = followed[0].id, other.id
    plan = (await client.get("/v1/plan", headers=auth)).json()
    tracks = {i["key"]: i["track_id"] for i in plan["items"]}
    assert tracks["payment-step"] == str(holder), (tracks, str(other_id))


async def test_approving_takes_the_kept_items_stale_alert_out_of_the_inbox(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
):
    """protects=approving a version settles its kept items' stale alerts in the same request
    (views.monitor_owners, as the item-staleness route does); fails_when=the alert stays open
    until the hourly monitor_due pass, so the Inbox and its counts keep it; no_claim=the
    alerts' own rules."""
    from oracle.roadmap import alerts
    from oracle.roadmap.models import ProductTrack

    tenant_id, auth = owner
    await _two_versions(client, auth, tenant_id, runtime)
    async with tenant_session(tenant_id) as s:
        roadmap = await s.scalar(select(Document).where(Document.slug == ROADMAP))
        track_ids = list(
            await s.scalars(
                select(ProductTrack.id).where(ProductTrack.roadmap_document_id == roadmap.id)
            )
        )
    for track_id in track_ids:
        r = await client.post(f"/v1/tracks/{track_id}/monitor", headers=auth)
        assert r.status_code == 200, r.text

    async def open_keys() -> set[str]:
        async with tenant_session(tenant_id) as s:
            return {
                a.item_key
                for a in await s.scalars(
                    select(alerts.TrackAlert).where(
                        alerts.TrackAlert.state == "open", alerts.TrackAlert.kind == "stale"
                    )
                )
            }

    assert "payment-step" in await open_keys()

    await _approve(client, auth, 2)

    assert "payment-step" not in await open_keys()
