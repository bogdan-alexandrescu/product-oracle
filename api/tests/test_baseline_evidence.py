"""Evidence: attaching from your own items, privacy of items, confidence scoring."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from oracle import confidence
from oracle.baseline.models import Evidence
from oracle.models import AuditEvent
from oracle.tenancy import tenant_session
from oracle.tenant_settings import TenantSetting
from tests.baseline_helpers import NOW, cite, confirm, edge, entity, make_ctx, make_item

B = "/v1/baseline"


@pytest.fixture
async def ctx():
    return await make_ctx()


def _close(a: float, b: float) -> bool:
    return abs(a - b) <= 0.002


async def test_evidence_from_own_item_copies_and_stays_private(client, ctx):
    feat = await entity(client, ctx, type="feature", key="guided-setup")
    item_id = await make_item(ctx, "owner", content="x" * 900)

    ev = await cite(client, ctx, feat, who="owner", source_item_id=str(item_id))
    assert ev["url"] == "https://chat.example.com/archives/C1/p1"
    assert ev["ref"] == "#product thread"
    assert ev["excerpt"] == "x" * 500
    assert ev["retrieved_at"] is not None
    assert ev["source_kind"] == "slack:message"
    assert ev["source_item"]["id"] == str(item_id)
    assert ev["source_item_private"] is False

    # Anyone else: the excerpt, url and ref, never the item.
    for who in ("approver", "viewer", "token"):
        (other,) = (
            await client.get(
                f"{B}/evidence", params={"entity_id": feat["id"]}, headers=ctx.as_(who)
            )
        ).json()
        assert other["source_item"] is None, who
        assert other["source_item_private"] is True
        assert other["excerpt"] == ev["excerpt"] and other["url"] == ev["url"]
        assert other["ref"] == ev["ref"]
        detail = (await client.get(f"{B}/entities/{feat['id']}", headers=ctx.as_(who))).json()
        assert detail["evidence"][0]["source_item"] is None
        assert detail["evidence_count"] == 1
    owner_view = (await client.get(f"{B}/entities/{feat['id']}", headers=ctx.as_("owner"))).json()
    assert owner_view["evidence"][0]["source_item"]["title"] == "#product thread"

    # Nobody can cite someone else's item, and an API token has no items.
    for who in ("approver", "token"):
        resp = await client.post(
            f"{B}/entities/{feat['id']}/evidence",
            json={"source_item_id": str(item_id)},
            headers=ctx.as_(who),
        )
        assert resp.status_code == 404, who

    # Given fields win over the copied ones.
    ev2 = await cite(
        client, ctx, feat, source_item_id=str(item_id), excerpt="Top request", ref="Thread on setup"
    )
    assert ev2["excerpt"] == "Top request" and ev2["ref"] == "Thread on setup"


async def test_free_standing_evidence_and_detach(client, ctx):
    feat = await entity(client, ctx, type="feature", key="guided-setup")
    resp = await client.post(
        f"{B}/entities/{feat['id']}/evidence", json={}, headers=ctx.as_("owner")
    )
    assert resp.status_code == 422
    ev = await cite(client, ctx, feat, url="https://notes.example.com/plan", excerpt="Plan")
    assert ev["source_kind"] == "manual"
    assert ev["source_item_private"] is False
    assert ev["confidence"] is not None
    resp = await client.delete(f"{B}/evidence/{ev['id']}", headers=ctx.as_("commenter"))
    assert resp.status_code == 403
    resp = await client.delete(f"{B}/evidence/{ev['id']}", headers=ctx.as_("approver"))
    assert resp.status_code == 204
    detail = (await client.get(f"{B}/entities/{feat['id']}", headers=ctx.as_("owner"))).json()
    assert detail["evidence"] == [] and detail["confidence"] is None


async def test_detach_keeps_the_reason_in_the_audit_log(client, ctx):
    """#338: the drawer's Remove asks why; the audit event keeps the reason."""
    feat = await entity(client, ctx, type="feature", key="guided-setup")
    ev = await cite(client, ctx, feat, url="https://notes.example.com/plan", excerpt="Plan")
    plain = await cite(client, ctx, feat, url="https://notes.example.com/old", excerpt="Old")
    resp = await client.delete(
        f"{B}/evidence/{ev['id']}",
        params={"reason": "Cites the wrong feature."},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 204
    resp = await client.delete(f"{B}/evidence/{plain['id']}", headers=ctx.as_("approver"))
    assert resp.status_code == 204
    resp = await client.delete(
        f"{B}/evidence/{ev['id']}", params={"reason": "x" * 1001}, headers=ctx.as_("approver")
    )
    assert resp.status_code == 422
    async with tenant_session(ctx.tenant_id) as s:
        rows = (
            await s.scalars(
                select(AuditEvent).where(AuditEvent.action == "baseline.evidence.removed")
            )
        ).all()
    reasons = {str(r.entity_id): r.data.get("reason") for r in rows}
    assert reasons == {ev["id"]: "Cites the wrong feature.", plain["id"]: None}


async def test_scoring_factors_and_aggregate(client, ctx):
    goal = await entity(client, ctx, type="goal", key="activation")
    feat = await entity(client, ctx, type="feature", key="guided-setup")
    await edge(client, ctx, feat, goal, "supports", attrs={"contribution": 2})

    slack_at = NOW - timedelta(days=30)
    slack = await make_item(ctx, "owner", updated=slack_at)
    notion = await make_item(
        ctx,
        "approver",
        kind="notion",
        item_kind="page",
        title="H2 plan",
        url="https://notes.example.com/h2",
        updated=NOW - timedelta(days=2),
        acl={"doc_type": "planning"},
    )
    # Goal not confirmed yet: no goal impact.
    first = await cite(client, ctx, feat, who="owner", source_item_id=str(slack))
    inputs = first["confidence_factors"]["inputs"]
    assert inputs["goal_contribution"] is None and inputs["mentions"] == 1

    await confirm(client, ctx, goal)  # rescoring follows the goal's status
    await cite(client, ctx, feat, who="approver", source_item_id=str(notion))
    await cite(client, ctx, feat, who="owner", source_item_id=str(slack), excerpt="again")

    rows = (
        await client.get(
            f"{B}/evidence", params={"entity_id": feat["id"]}, headers=ctx.as_("viewer")
        )
    ).json()
    assert len(rows) == 3
    for row in rows:
        f = row["confidence_factors"]
        # Two distinct items behind this feature; contribution 2 to a confirmed goal.
        assert f["inputs"]["mentions"] == 2
        assert f["inputs"]["goal_contribution"] == 2
        assert set(f["breakdown"]) == {"source", "freshness", "mentions", "goal_impact"}
        assert f["weights"] == confidence.DEFAULTS["weights"]
        assert row["scored_at"] is not None

    slack_row = next(r for r in rows if r["source_kind"] == "slack:message")
    expected = confidence.score(
        confidence.Factors(
            source_kind="slack",
            item_kind="message",
            latest_at=slack_at,
            mentions=2,
            goal_contribution=2,
        )
    )
    assert _close(slack_row["confidence"], expected.confidence)
    assert slack_row["confidence_factors"]["breakdown"]["goal_impact"]["value"] == 0.85

    notion_row = next(r for r in rows if r["source_kind"] == "notion:page")
    assert notion_row["confidence_factors"]["inputs"]["planning_doc"] is True
    assert notion_row["confidence_factors"]["breakdown"]["source"]["value"] == 0.8  # 0.7 + 0.1

    detail = (await client.get(f"{B}/entities/{feat['id']}", headers=ctx.as_("viewer"))).json()
    assert _close(detail["confidence"], confidence.aggregate([r["confidence"] for r in rows]))

    # Removing the notion evidence: back to one mention.
    await client.delete(f"{B}/evidence/{notion_row['id']}", headers=ctx.as_("owner"))
    rows = (
        await client.get(
            f"{B}/evidence", params={"entity_id": feat["id"]}, headers=ctx.as_("viewer")
        )
    ).json()
    assert {r["confidence_factors"]["inputs"]["mentions"] for r in rows} == {1}


async def test_goal_itself_counts_three_and_edges_use_their_source(client, ctx):
    goal = await entity(client, ctx, type="goal", key="activation")
    feat = await entity(client, ctx, type="feature", key="guided-setup")
    await confirm(client, ctx, goal)
    sup = await edge(client, ctx, feat, goal, "supports", attrs={"contribution": 1})

    g = await cite(client, ctx, goal, url="https://notes.example.com/okrs")
    assert g["confidence_factors"]["inputs"]["goal_contribution"] == 3
    e = await cite(client, ctx, sup, kind="edges", url="https://notes.example.com/okrs#2")
    assert e["confidence_factors"]["inputs"]["goal_contribution"] == 1
    detail = (await client.get(f"{B}/edges/{sup['id']}", headers=ctx.as_("viewer"))).json()
    assert detail["confidence"] == e["confidence"]
    assert len(detail["evidence"]) == 1

    # Raising the contribution rescores the edge's evidence.
    await client.patch(
        f"{B}/edges/{sup['id']}", json={"attrs": {"contribution": 3}}, headers=ctx.as_("owner")
    )
    detail = (await client.get(f"{B}/edges/{sup['id']}", headers=ctx.as_("viewer"))).json()
    assert detail["evidence"][0]["confidence_factors"]["inputs"]["goal_contribution"] == 3
    assert detail["evidence"][0]["confidence"] > e["confidence"]


async def test_company_weights_and_rescore(client, ctx):
    feat = await entity(client, ctx, type="feature", key="guided-setup")
    item = await make_item(ctx, "owner")
    ev = await cite(client, ctx, feat, source_item_id=str(item))

    async with tenant_session(ctx.tenant_id) as s:
        s.add(
            TenantSetting(
                key="confidence_weights",
                value={
                    "weights": {"source": 1, "freshness": 0, "mentions": 0, "goal_impact": 0},
                    "source": {"slack": 0.2},
                },
            )
        )
        await s.commit()
    resp = await client.post(f"{B}/rescore", headers=ctx.as_("approver"))
    assert resp.status_code == 200
    assert resp.json() == {"evidence": 1, "entities": 1, "edges": 0}
    (row,) = (
        await client.get(
            f"{B}/evidence", params={"entity_id": feat["id"]}, headers=ctx.as_("owner")
        )
    ).json()
    assert row["confidence"] == 0.2 != ev["confidence"]
    assert row["confidence_factors"]["weights"]["source"] == 1.0


async def test_stored_columns(ctx, client):
    feat = await entity(client, ctx, type="feature", key="guided-setup")
    await cite(
        client,
        ctx,
        feat,
        url="https://notes.example.com/a",
        retrieved_at=datetime(2026, 1, 1, tzinfo=UTC).isoformat(),
    )
    async with tenant_session(ctx.tenant_id) as s:
        (ev,) = (await s.scalars(select(Evidence))).all()
    assert 0 <= float(ev.confidence) <= 1
    assert ev.confidence_factors["inputs"]["latest_at"].startswith("2026-01-01")
    assert ev.scored_at is not None
