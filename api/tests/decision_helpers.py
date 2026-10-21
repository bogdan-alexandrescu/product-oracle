"""Shared setup for the decision log tests (H1). Synthetic placeholders only."""

import uuid
from datetime import date, timedelta
from typing import Any

from oracle.decisions.models import Decision
from sqlalchemy import select

from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx

TODAY = date.today()


def two_options() -> list[dict[str, Any]]:
    return [
        {
            "key": "caps-first",
            "label": "Caps first",
            "summary": "Caps read plan thresholds only",
            "pros": ["One sprint"],
            "cons": ["No early warning"],
            "evidence_ids": [],
            "cost_if_wrong": "A month of noisy alerts",
        },
        {
            "key": "together",
            "label": "Ship together",
            "summary": "Wait for detection",
            "pros": [],
            "cons": ["Six more weeks"],
            "evidence_ids": [],
            "cost_if_wrong": "Late for the quarter's goal",
        },
    ]


def proposal(ctx: Ctx, **overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "title": "Ship usage caps before anomaly detection",
        "question": "Do caps wait for detection?",
        "context": "Finance asks for caps; detection adds early warning only.",
        "options": two_options(),
        "approver_id": str(ctx.users["approver"].id),
        "reversibility": "reversible",
        "contributor_ids": [],
        "informed_ids": [],
    }
    body.update(overrides)
    return body


async def propose(client, ctx: Ctx, who: str = "commenter", **overrides: Any) -> dict:
    resp = await client.post("/v1/decisions", json=proposal(ctx, **overrides), headers=ctx.as_(who))
    assert resp.status_code == 201, resp.text
    return resp.json()


def decide_body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "option_key": "caps-first",
        "rationale": "Caps alone meet the goal; detection follows.",
        "reversibility": "reversible",
        "expected_outcome": "Spend incidents drop below 2 a month",
    }
    body.update(overrides)
    return body


async def decide(client, ctx: Ctx, ref: Any, who: str = "approver", **overrides: Any) -> dict:
    resp = await client.post(
        f"/v1/decisions/{ref}/decide", json=decide_body(**overrides), headers=ctx.as_(who)
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def rows(tenant_id: uuid.UUID) -> list[Decision]:
    async with tenant_session(tenant_id) as s:
        return list(await s.scalars(select(Decision).order_by(Decision.number)))


def in_days(n: int) -> str:
    return (TODAY + timedelta(days=n)).isoformat()
