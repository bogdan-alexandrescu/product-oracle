"""Migration 0137_stale_by_meaning: the stored stale marks, by the stale rule.

Cards (protects / fails_when / no_claim):

- test_chains_on_the_single_head: protects=the revision chains on 0135 as the single head;
  fails_when=two heads or another parent; no_claim=its effect.
- test_a_seeded_set_clears_and_stays: protects=of nine marked items the three marked only by
  confirmations (or by what was settled before them) clear and their alerts close; the six
  with a reason that changes what they mean stay, the exempt reasons dropped from the item
  and its alert; twice safely; fails_when=any of those differs, or an item's content moves;
  no_claim=marks raised from now on (tests/test_stale_rule.py).
"""

import importlib.util
import json
import uuid
from datetime import UTC, datetime, timedelta

from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import select

from oracle.baseline.models import Edge, Entity
from oracle.docs.models import Document
from oracle.models import AuditEvent
from oracle.roadmap.models import ProductTrack, RoadmapItem, TrackAlert
from oracle.tenancy import tenant_session
from oracle.v2.models import ChangeEvent
from tests.conftest import API_DIR
from tests.test_roadmap import ROADMAP, owner, runtime  # noqa: F401 - fixtures
from tests.test_stale_rule import ok, seeded

REVISION = "0137_stale_by_meaning"
PREVIOUS = "0136_unique_item_codes"
VERBS = {
    "entity_confirmed": "was confirmed",
    "entity_updated": "changed",
    "edge_updated": "had a link changed",
}


def _migration():
    path = API_DIR / "migrations" / "versions" / f"{REVISION}.py"
    spec = importlib.util.spec_from_file_location(REVISION, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def _run(tenant_id) -> None:
    async with tenant_session(tenant_id) as s:
        await s.run_sync(lambda sync: _migration().settle(sync.connection()))
        await s.commit()


def test_chains_on_the_single_head():
    """The migration chains directly onto its prior revision, and it is the one head."""
    script = ScriptDirectory.from_config(Config(str(API_DIR / "alembic.ini")))
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == [REVISION]


async def _item(tenant_id, key: str, goal_id) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID]:
    """One more item of the roadmap's version 1, of a proposed feature with a proposed link."""
    async with tenant_session(tenant_id) as s:
        like = await s.scalar(select(RoadmapItem).where(RoadmapItem.item_key == "payment-step"))
        feature = Entity(
            type="feature", key=key, title=key.title(), status="proposed", origin="agent"
        )
        s.add(feature)
        await s.flush()
        edge = Edge(
            src_id=feature.id, dst_id=goal_id, type="supports", status="proposed",
            origin="agent", attrs={"contribution": 1},
        )  # fmt: skip
        own = {"id", "created_at", "item_key", "title", "feature_id", "position"}
        own.add("prd_section_key")
        row = {
            c.key: getattr(like, c.key)
            for c in RoadmapItem.__mapper__.column_attrs
            if c.key not in own
        }
        item = RoadmapItem(
            **row, item_key=key, title=key.title(), feature_id=feature.id, position=100
        )
        s.add_all([edge, item])
        await s.commit()
        return item.id, feature.id, edge.id


async def _as_before(tenant_id, item_id, feature_id, *extra: str, drop_link=None) -> list[str]:
    """The feature's changes marked its item as the earlier rule did: a reason per event, and
    no word on the event of whether it only raised the standing."""
    async with tenant_session(tenant_id) as s:
        item = await s.get(RoadmapItem, item_id)
        rows = await s.scalars(
            select(ChangeEvent)
            .where(ChangeEvent.subject_id == feature_id)
            .order_by(ChangeEvent.created_at, ChangeEvent.cause)
        )
        reasons: list[str] = []
        for e in rows:
            reason = f"feature:{item.item_key} {VERBS[e.cause]}"
            data = {k: v for k, v in e.data.items() if k != "standing_only"}
            data["roadmap"] = {"item_ids": [str(item.id)], "reasons": {str(item.id): reason}}
            e.data = data
            item.caused_by_change_id = e.id
            if reason not in reasons:
                reasons.append(reason)
        item.freshness = "potentially_stale"
        item.stale_since = datetime.now(UTC)
        item.stale_reasons = [*reasons, *extra]
        if drop_link is not None:
            await s.delete(await s.get(Edge, drop_link))
        await s.commit()
        return list(item.stale_reasons)


async def _confirm(client, auth, feature_id) -> None:
    await ok(await client.post(f"/v1/baseline/entities/{feature_id}/confirm", headers=auth))


async def _rename(client, auth, feature_id) -> None:
    await ok(
        await client.patch(
            f"/v1/baseline/entities/{feature_id}", json={"title": "Another name"}, headers=auth
        )
    )


async def _edge(client, auth, edge_id, **fields) -> None:
    await ok(await client.patch(f"/v1/baseline/edges/{edge_id}", json=fields, headers=auth))


async def test_a_seeded_set_clears_and_stays(client, owner, runtime):  # noqa: F811
    """Nine marked items: three clear, six stay with the reasons that change their meaning."""
    tenant_id, auth = owner
    ids = await seeded(client, auth, tenant_id, runtime)
    await ok(await client.post(f"/v1/documents/{ROADMAP}/versions/1/approve", headers=auth))
    section = "PRD section 5.2 Shipping step changed in version 2"
    rejected = "goal:activation was rejected"
    made = {
        k: await _item(tenant_id, k, ids["goal"])
        for k in ("confirmed", "settled", "counted", "renamed", "weighted", "unlinked", "sectioned",
                  "goal-rejected", "link-gone")
    }  # fmt: skip
    stored: dict[str, list[str]] = {}

    async def mark(key: str, *extra: str, **kw) -> None:
        item_id, feature_id, _ = made[key]
        stored[key] = await _as_before(tenant_id, item_id, feature_id, *extra, **kw)

    await _confirm(client, auth, made["confirmed"][1])
    await mark("confirmed")
    # Renamed, settled by a person, then its link confirmed: only the link marked it again.
    await _rename(client, auth, made["settled"][1])
    async with tenant_session(tenant_id) as s:
        item = await s.get(RoadmapItem, made["settled"][0])
        item.reconciled_at = datetime.now(UTC) + timedelta(microseconds=1)
        await s.commit()
    await _edge(client, auth, made["settled"][2], status="confirmed")
    await mark("settled")
    await mark("counted", "2 Ground Truth items were confirmed")
    await _confirm(client, auth, made["renamed"][1])
    await _rename(client, auth, made["renamed"][1])
    await mark("renamed")
    await _edge(client, auth, made["weighted"][2], status="confirmed")
    await _edge(client, auth, made["weighted"][2], attrs={"contribution": 3})
    await mark("weighted")
    await _edge(client, auth, made["unlinked"][2], status="confirmed")
    await _edge(client, auth, made["unlinked"][2], status="rejected")
    await mark("unlinked")
    await _confirm(client, auth, made["sectioned"][1])
    await mark("sectioned", section)
    await _confirm(client, auth, made["goal-rejected"][1])
    await mark("goal-rejected", rejected)
    await _edge(client, auth, made["link-gone"][2], status="confirmed")
    await mark("link-gone", drop_link=made["link-gone"][2])
    assert stored["confirmed"] == [
        "feature:confirmed had a link changed",
        "feature:confirmed was confirmed",
    ]
    assert stored["settled"] == [
        "feature:settled changed",
        "feature:settled had a link changed",
    ]

    async with tenant_session(tenant_id) as s:
        roadmap = await s.scalar(select(Document).where(Document.slug == ROADMAP))
        track = await s.scalar(
            select(ProductTrack).where(ProductTrack.roadmap_document_id == roadmap.id)
        )
        for key in ("confirmed", "renamed"):
            item = await s.get(RoadmapItem, made[key][0])
            s.add(
                TrackAlert(
                    track_id=track.id, item_key=key, kind="stale",
                    fingerprint=str(item.caused_by_change_id), data={}, state="open",
                    detail=json.dumps(stored[key]),
                )
            )  # fmt: skip
        await s.commit()

    await _run(tenant_id)
    await _run(tenant_id)

    async with tenant_session(tenant_id) as s:
        rows = {i.item_key: i for i in await s.scalars(select(RoadmapItem))}
        found = {a.item_key: a for a in await s.scalars(select(TrackAlert))}
        audits = list(
            await s.scalars(
                select(AuditEvent).where(AuditEvent.action == "roadmap.items.confirmations_cleared")
            )
        )
    got = {k: (rows[k].freshness, list(rows[k].stale_reasons)) for k in made}
    stale = "potentially_stale"
    assert got == {
        "confirmed": ("fresh", []),
        "settled": ("reconciled", []),
        "counted": ("fresh", []),
        "renamed": (stale, ["feature:renamed changed"]),
        "weighted": (stale, ["feature:weighted had a link changed"]),
        "unlinked": (stale, ["feature:unlinked had a link changed"]),
        "sectioned": (stale, [section]),
        "goal-rejected": (stale, [rejected]),
        "link-gone": (stale, ["feature:link-gone had a link changed"]),
    }
    assert rows["confirmed"].stale_since is None and rows["confirmed"].caused_by_change_id is None
    assert rows["renamed"].caused_by_change_id is not None
    assert (rows["confirmed"].title, rows["confirmed"].horizon) == (
        "Confirmed",
        rows["payment-step"].horizon,
    )
    assert found["confirmed"].state == "resolved" and found["confirmed"].resolved_at is not None
    assert found["renamed"].state == "open"
    assert json.loads(found["renamed"].detail) == ["feature:renamed changed"]
    # Three cleared, three shortened; the second run wrote nothing.
    assert len(audits) == 6, [a.data for a in audits]
