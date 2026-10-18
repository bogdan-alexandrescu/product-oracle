"""Conflicts (confidence, then precedence, then newer) and the traceability report."""

from decimal import Decimal

import pytest
from sqlalchemy import update

from oracle.baseline.conflicts import pick_winner, source_class
from oracle.baseline.models import Evidence
from oracle.tenancy import tenant_session
from tests.baseline_helpers import cite, confirm, edge, entity, make_ctx, make_item

B = "/v1/baseline"


@pytest.fixture
async def ctx():
    return await make_ctx()


def claim(value, conf, kind=None, observed=None):
    return {
        "value": value,
        "confidence": conf,
        "source_kind": kind,
        "source_class": source_class(kind),
        "observed_at": observed,
    }


def test_precedence_classes():
    assert source_class("github:pull_request") == "code"
    assert source_class("github:issue") == "tracker"
    assert source_class("notion:page") == "docs"
    assert source_class("fireflies:transcript") == "meeting"
    assert source_class("slack:message") == "chat"
    assert source_class("code") == "code"
    assert source_class("manual") is None


def test_pick_winner_rules():
    # Clear confidence gap wins regardless of precedence.
    w, why = pick_winner([claim("a", 0.4, "github"), claim("b", 0.8, "slack")], {})
    assert w == 1 and why.startswith("confidence 0.80 beats 0.40")
    # Within the tie margin: code > tracker > docs > chat.
    w, why = pick_winner([claim("a", 0.6, "slack:message"), claim("b", 0.65, "github:issue")], {})
    assert w == 1 and "tracker beats chat" in why
    w, _ = pick_winner(
        [claim("a", 0.6, "notion"), claim("b", 0.6, "github:release"), claim("c", 0.6, "slack")],
        {},
    )
    assert w == 1
    # Same precedence: newer beats older.
    w, why = pick_winner(
        [
            claim("a", 0.6, "notion", "2026-09-01T00:00:00+00:00"),
            claim("b", 0.6, "google_docs", "2026-10-01T00:00:00+00:00"),
        ],
        {},
    )
    assert w == 1 and "newer" in why
    # Nothing separates them.
    w, _ = pick_winner([claim("a", 0.6, "slack"), claim("b", 0.6, "slack")], {})
    assert w is None
    # The company's tie margin applies.
    w, _ = pick_winner([claim("a", 0.6, "slack"), claim("b", 0.75, "github")], {"tie_margin": 0})
    assert w == 1


async def _evidence(client, ctx, target, confs: list[float], kind="entities", items=()):
    """Evidence rows with fixed confidences (set after attaching, which rescores)."""
    ids = []
    for i in range(len(confs)):
        extra = {"source_item_id": str(items[i])} if i < len(items) else {}
        ev = await cite(client, ctx, target, kind=kind, url=f"https://x.example.com/{i}", **extra)
        ids.append(ev["id"])
    async with tenant_session(ctx.tenant_id) as s:
        for ev_id, conf in zip(ids, confs, strict=True):
            await s.execute(
                update(Evidence).where(Evidence.id == ev_id).values(confidence=Decimal(str(conf)))
            )
        await s.commit()
    return ids


async def test_immaterial_conflict_is_logged_and_applied(client, ctx):
    req = await entity(
        client, ctx, type="requirement", key="sso", origin="agent", attrs={"protocol": "saml"}
    )
    strong, weak = await _evidence(client, ctx, req, [0.9, 0.3])
    resp = await client.post(
        f"{B}/conflicts",
        json={
            "entity_id": req["id"],
            "field": "protocol",
            "claims": [
                {"value": "saml", "evidence_ids": [weak]},
                {"value": "oidc", "evidence_ids": [strong]},
            ],
        },
        headers=ctx.as_("token"),
    )
    assert resp.status_code == 201, resp.text
    c = resp.json()
    assert c["field"] == "attrs.protocol"
    assert c["status"] == "logged" and c["material"] is False
    assert c["resolution"]["winner"] == 1 and c["resolution"]["applied"] is True
    assert c["claims"][1]["confidence"] == 0.9
    assert c["claims"][1]["source_kind"] == "manual"
    detail = (await client.get(f"{B}/entities/{req['id']}", headers=ctx.as_("owner"))).json()
    assert detail["attrs"]["protocol"] == "oidc"
    assert detail["locked"] is False  # an agent write


async def test_tie_falls_back_to_precedence(client, ctx):
    req = await entity(
        client, ctx, type="requirement", key="limits", origin="agent", attrs={"max_seats": 10}
    )
    chat_item = await make_item(ctx, "owner")
    code_item = await make_item(
        ctx,
        "owner",
        kind="github",
        item_kind="pull_request",
        title="PR 12",
        url="https://code.example.com/pr/12",
    )
    chat, code = await _evidence(client, ctx, req, [0.62, 0.58], items=[chat_item, code_item])
    c = (
        await client.post(
            f"{B}/conflicts",
            json={
                "entity_id": req["id"],
                "field": "attrs.max_seats",
                "claims": [
                    {"value": 10, "evidence_ids": [chat]},
                    {"value": 25, "evidence_ids": [code]},
                ],
            },
            headers=ctx.as_("owner"),
        )
    ).json()
    assert [cl["source_class"] for cl in c["claims"]] == ["chat", "code"]
    assert c["resolution"]["winner"] == 1
    assert "code beats chat" in c["resolution"]["rule"]
    assert c["status"] == "logged"
    detail = (await client.get(f"{B}/entities/{req['id']}", headers=ctx.as_("owner"))).json()
    assert detail["attrs"]["max_seats"] == 25


async def test_immaterial_change_to_locked_item_becomes_proposal(client, ctx):
    req = await entity(client, ctx, type="requirement", key="sso", attrs={"protocol": "saml"})
    a, b = await _evidence(client, ctx, req, [0.9, 0.2])
    c = (
        await client.post(
            f"{B}/conflicts",
            json={
                "entity_id": req["id"],
                "field": "protocol",
                "claims": [
                    {"value": "oidc", "evidence_ids": [a]},
                    {"value": "saml", "evidence_ids": [b]},
                ],
            },
            headers=ctx.as_("owner"),
        )
    ).json()
    assert c["status"] == "logged"
    assert c["resolution"]["applied"] is False and c["resolution"]["proposal_id"]
    detail = (await client.get(f"{B}/entities/{req['id']}", headers=ctx.as_("owner"))).json()
    assert detail["attrs"]["protocol"] == "saml"


async def test_material_conflict_is_escalated_then_resolved(client, ctx):
    feat = await entity(
        client, ctx, type="feature", key="guided-setup", origin="agent", attrs={"status": "planned"}
    )
    a, b = await _evidence(client, ctx, feat, [0.9, 0.4])
    c = (
        await client.post(
            f"{B}/conflicts",
            json={
                "entity_id": feat["id"],
                "field": "attrs.status",
                "claims": [
                    {"value": "planned", "evidence_ids": [b]},
                    {"value": "shipped", "evidence_ids": [a]},
                ],
            },
            headers=ctx.as_("token"),
        )
    ).json()
    assert c["material"] is True and c["status"] == "open"
    assert c["resolution"]["winner"] == 1 and c["resolution"]["applied"] is False
    detail = (await client.get(f"{B}/entities/{feat['id']}", headers=ctx.as_("owner"))).json()
    assert detail["attrs"]["status"] == "planned"

    listed = (
        await client.get(
            f"{B}/conflicts", params={"status": "open", "material": True}, headers=ctx.as_("viewer")
        )
    ).json()
    assert [x["id"] for x in listed] == [c["id"]]

    resp = await client.post(
        f"{B}/conflicts/{c['id']}/resolve", json={"claim": 1}, headers=ctx.as_("commenter")
    )
    assert resp.status_code == 403
    resp = await client.post(
        f"{B}/conflicts/{c['id']}/resolve",
        json={"claim": 0, "note": "not shipped yet"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text
    r = resp.json()
    assert r["status"] == "resolved" and r["resolution"]["value"] == "planned"
    assert r["resolution"]["decided_by"] == f"user:{ctx.users['approver'].id}"
    detail = (await client.get(f"{B}/entities/{feat['id']}", headers=ctx.as_("owner"))).json()
    assert detail["locked"] is True
    again = await client.post(
        f"{B}/conflicts/{c['id']}/resolve", json={"claim": 0}, headers=ctx.as_("approver")
    )
    assert again.status_code == 409


async def test_goal_link_conflict_is_material_and_ties_escalate(client, ctx):
    goal = await entity(client, ctx, type="goal", key="activation")
    feat = await entity(client, ctx, type="feature", key="guided-setup")
    sup = await edge(client, ctx, feat, goal, "supports", attrs={"contribution": 1}, origin="agent")
    a, b = await _evidence(client, ctx, sup, [0.5, 0.5], kind="edges")
    c = (
        await client.post(
            f"{B}/conflicts",
            json={
                "edge_id": sup["id"],
                "field": "contribution",
                "claims": [
                    {
                        "value": 1,
                        "evidence_ids": [a],
                        "source_kind": "slack",
                        "observed_at": "2026-10-01T00:00:00Z",
                    },
                    {
                        "value": 3,
                        "evidence_ids": [b],
                        "source_kind": "slack",
                        "observed_at": "2026-10-01T00:00:00Z",
                    },
                ],
            },
            headers=ctx.as_("owner"),
        )
    ).json()
    assert c["material"] is True and c["status"] == "open"
    assert c["resolution"]["winner"] is None

    # Same value as now: nothing to decide, logged.
    c2 = (
        await client.post(
            f"{B}/conflicts",
            json={
                "edge_id": sup["id"],
                "field": "contribution",
                "claims": [
                    {"value": 1, "evidence_ids": [a], "source_kind": "github"},
                    {"value": 3, "evidence_ids": [b], "source_kind": "slack"},
                ],
            },
            headers=ctx.as_("owner"),
        )
    ).json()
    assert c2["status"] == "logged" and c2["material"] is False


async def test_conflict_validation(client, ctx):
    feat = await entity(client, ctx, type="feature", key="guided-setup")
    body = {"entity_id": feat["id"], "field": "status", "claims": [{"value": "a"}]}
    resp = await client.post(f"{B}/conflicts", json=body, headers=ctx.as_("owner"))
    assert resp.status_code == 422
    body["claims"] = [{"value": "a", "evidence_ids": [feat["id"]]}, {"value": "b"}]
    resp = await client.post(f"{B}/conflicts", json=body, headers=ctx.as_("owner"))
    assert resp.status_code == 422  # unknown evidence


async def test_traceability_report(client, ctx):
    activation = await entity(
        client, ctx, type="goal", key="activation", title="Raise activation", attrs={"weight": 3}
    )
    conversion = await entity(client, ctx, type="goal", key="conversion")
    churn = await entity(client, ctx, type="goal", key="churn")
    await confirm(client, ctx, activation)
    await confirm(client, ctx, churn)

    setup = await entity(client, ctx, type="feature", key="guided-setup")
    carts = await entity(client, ctx, type="feature", key="saved-carts")
    await entity(client, ctx, type="feature", key="dark-mode")
    weak = await entity(client, ctx, type="feature", key="usage-export")
    await edge(client, ctx, setup, activation, "supports", attrs={"contribution": 3})
    # Supports only a goal that is not confirmed: serves no goal.
    await edge(client, ctx, carts, conversion, "supports", attrs={"contribution": 2})
    await edge(client, ctx, weak, activation, "supports", attrs={"contribution": 1})

    await cite(client, ctx, setup, source_item_id=str(await make_item(ctx, "owner")))
    await cite(client, ctx, carts, url="https://notes.example.com/carts")
    await _evidence(client, ctx, weak, [0.2])
    async with tenant_session(ctx.tenant_id) as s:
        await s.execute(
            update(Evidence)
            .where(Evidence.entity_id == setup["id"])
            .values(confidence=Decimal("0.7"))
        )
        await s.commit()

    resp = await client.get(f"{B}/trace", headers=ctx.as_("viewer"))
    assert resp.status_code == 200
    report = resp.json()
    flags = {f["key"]: f["flags"] for f in report["features"]}
    assert flags == {
        "dark-mode": ["serves_no_goal", "no_evidence"],
        "guided-setup": [],
        "saved-carts": ["serves_no_goal"],
        "usage-export": ["low_confidence"],
    }
    assert {f["key"] for f in report["flagged"]} == {"dark-mode", "saved-carts", "usage-export"}
    goals = {g["key"]: g for g in report["goals"]}
    assert goals["activation"]["coverage"] == 4
    assert [f["key"] for f in goals["activation"]["features"]] == ["guided-setup", "usage-export"]
    assert goals["activation"]["weight"] == 3
    assert goals["churn"]["features"] == []
    assert report["summary"] == {
        "features": 4,
        "flagged": 3,
        "serves_no_goal": 2,
        "weak_evidence": 2,
        "goals": 3,
        "confirmed_goals": 2,
        "uncovered_goals": 1,
    }
    assert report["low"] == 0.4
