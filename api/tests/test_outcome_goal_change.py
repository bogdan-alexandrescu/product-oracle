"""Outcomes edits (Nov 13), Change goal: an approver moves an outcome to another company
goal from its inspector; its prediction stays as written, and its track record counts
toward the new goal. Made-up names only.

Every test states its card: protects (the observable), fails_when (the wrong result
it rejects), no_claim (what green does not prove)."""

import uuid
from datetime import UTC, datetime

from oracle.baseline.models import Entity
from oracle.tenancy import tenant_session
from tests.outcome_helpers import outcome_world, set_record
from tests.test_roadmap import (  # noqa: F401 - fixtures
    as_user,
    owner,
    runtime,
)


async def _entity(tenant_id: uuid.UUID, type_: str, title: str) -> str:
    async with tenant_session(tenant_id) as s:
        row = Entity(type=type_, key=f"{type_}-{uuid.uuid4().hex[:6]}", title=title,
                     status="confirmed", origin="user", attrs={})  # fmt: skip
        s.add(row)
        await s.commit()
        return str(row.id)


async def test_an_approver_changes_an_outcomes_goal(client, owner, runtime):  # noqa: F811
    """protects=PATCH goal_id moves the outcome to another goal, any state; the prediction
    is kept as it was; its track record counts under the new goal; a feature is refused
    with the API's sentence; a viewer cannot; fails_when=the goal stays, the prediction is
    lost, or a non-goal is taken; no_claim=the inspector's picker."""
    tenant_id, auth = owner
    by_item = await outcome_world(client, auth, runtime, tenant_id)
    pay = by_item["payment-step"]
    await set_record(tenant_id, pay["id"], status="held", assessed_at=datetime.now(UTC))
    other = await _entity(tenant_id, "goal", "Fewer support tickets")
    feature = await _entity(tenant_id, "feature", "Help center search")
    url = f"/v1/outcomes/{pay['id']}"
    lock = (await client.get(url, headers=auth)).json()["lock_version"]

    viewer = await as_user(tenant_id, "viewer")
    body = {"goal_id": other, "lock_version": lock}
    assert (await client.patch(url, json=body, headers=viewer)).status_code == 403
    bad = await client.patch(url, json={**body, "goal_id": feature}, headers=auth)
    assert bad.status_code == 422 and "is not a goal" in bad.json()["detail"]

    resp = await client.patch(url, json=body, headers=auth)
    assert resp.status_code == 200, resp.text
    moved = resp.json()
    assert moved["goal_id"] == other and moved["prediction"] == pay["prediction"]
    record = (await client.get("/v1/priorities/calibration", headers=auth)).json()
    assert {g["goal_id"]: g["n"] for g in record["goals"]} == {other: 1}
