"""Shared setup for the decision log tests (H1). Synthetic placeholders only."""

import os
import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import select

from oracle.decisions import service
from oracle.decisions.models import Decision
from oracle.tenancy import tenant_session
from oracle.tenant_settings import TenantSetting
from tests.baseline_helpers import Ctx

# The Company time zone of a company that never saved one (owner decision 2026-10-22).
COMPANY_ZONE = "America/Los_Angeles"
# One clock for the test and the API (#336): "now" is frozen when the test starts, or at
# ORACLE_TEST_NOW (an ISO instant with its offset) to run the tests at a chosen hour.
_NOW: list[datetime] = []


@pytest.fixture(autouse=True)
def clock(monkeypatch) -> datetime:
    """Freeze the decision log's "now"; autouse in each module that imports it."""
    raw = os.environ.get("ORACLE_TEST_NOW")
    at = datetime.fromisoformat(raw).astimezone(UTC) if raw else datetime.now(UTC)
    freeze(monkeypatch, at)
    return at


def freeze(monkeypatch, at: datetime) -> None:
    _NOW[:] = [at]
    monkeypatch.setattr(service, "_now", lambda: at)


def today(zone: str = COMPANY_ZONE) -> date:
    """The frozen clock's date in ``zone`` (the Company time zone; its default unless a
    test stored another with :func:`set_company_zone`)."""
    return _NOW[0].astimezone(ZoneInfo(zone)).date()


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


async def set_company_zone(tenant_id: uuid.UUID, zone: str) -> None:
    """The company's stored Company time zone, as an owner saves it on Settings › Company."""
    async with tenant_session(tenant_id) as s:
        s.add(TenantSetting(key="company_timezone", value=zone))
        await s.commit()


def in_days(n: int, zone: str = COMPANY_ZONE) -> str:
    return (today(zone) + timedelta(days=n)).isoformat()
