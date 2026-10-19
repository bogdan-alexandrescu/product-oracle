"""Shared setup for the blocker strategy tests (CR-04). Synthetic placeholders only."""

import uuid

from oracle.baseline.models import Entity, Evidence
from oracle.docs.models import Document
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx

# A third-party limit, phrased the way a company would: synthetic, no real provider.
RATE_LIMIT = {
    "key": "partner-api-rate-limit",
    "statement": "The partner API allows 100 requests a minute per company",
    "type": "hard",
    "limit_kind": "capacity",
    "third_party": "Example partner API",
    "severity": "critical",
    "timing": "At launch, when every company syncs at once",
    "threshold": "More than 100 requests a minute per company",
}

COMPLIANT_OPTION = {
    "title": "Batch and cache lookups within the published quota",
    "approach": "architecture",
    "description": "Coalesce duplicate lookups and cache results for ten minutes.",
    "technical_feasibility": "high",
    "policy_feasibility": "high",
    "details": {
        "expected_outcome": "Peak calls fall below 60 a minute",
        "cost": "Two engineer-weeks",
        "effort": "medium",
        "risk": "Cached data can be up to ten minutes old",
        "residual_limitations": "A single very large company may still queue",
        "fallback": "Queue lookups and retry within the permitted rate",
        "monitoring_signal": "Share of minutes above 80 requests",
        "scaling_trigger": "Above 80 requests a minute for a week",
        "corrective_action": "Apply for the provider's higher tier",
        "review_at": "2027-01-15T00:00:00Z",
    },
}


async def make_document(ctx: Ctx, slug: str = "checkout-redesign") -> uuid.UUID:
    async with tenant_session(ctx.tenant_id) as s:
        doc = Document(slug=slug, title="Checkout redesign PRD", kind="prd")
        s.add(doc)
        await s.commit()
        return doc.id


async def make_entity(ctx: Ctx, type_: str, key: str, attrs: dict | None = None) -> uuid.UUID:
    async with tenant_session(ctx.tenant_id) as s:
        entity = Entity(type=type_, key=key, title=key.replace("-", " ").capitalize(),
                        origin="user", attrs=attrs or {})  # fmt: skip
        s.add(entity)
        await s.commit()
        return entity.id


async def make_evidence(ctx: Ctx, entity_id: uuid.UUID, **fields) -> uuid.UUID:
    async with tenant_session(ctx.tenant_id) as s:
        ev = Evidence(
            entity_id=entity_id,
            url=fields.get("url", "https://docs.example.com/partner-api/limits"),
            excerpt=fields.get("excerpt", "Requests above 100 a minute receive HTTP 429."),
            ref=fields.get("ref"),
            confidence=fields.get("confidence", 0.8),
        )
        s.add(ev)
        await s.commit()
        return ev.id


async def create_blocker(client, ctx: Ctx, who: str = "approver", **overrides) -> dict:
    body = {**RATE_LIMIT, **overrides}
    resp = await client.post("/v1/blockers", json=body, headers=ctx.as_(who))
    assert resp.status_code == 201, resp.text
    return resp.json()


async def add_option(client, ctx: Ctx, blocker_id: str, who: str = "approver", **overrides):
    body = {**COMPLIANT_OPTION, **overrides}
    return await client.post(
        f"/v1/blockers/{blocker_id}/options", json=body, headers=ctx.as_(who)
    )


async def approve_compliance(client, ctx: Ctx, option: dict) -> dict:
    resp = await client.patch(
        f"/v1/blocker-options/{option['id']}",
        json={"lock_version": option["lock_version"], "compliance": "compliant",
              "reason": "Within the provider's published terms"},
        headers=ctx.as_("approver"),
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    return resp.json()
