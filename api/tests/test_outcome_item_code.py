"""outcomes-code: each outcome carries its roadmap item's Ground Truth code
(``roadmap_item_code``), so Outcomes names the item as every other page does ("F-12 Payment
step"); an item whose feature has no code reads None (the web flags it). Against Postgres with
the FakeRuntime; made-up names only.

Every test states its card: protects (the observable), fails_when (the wrong result
it rejects), no_claim (what green does not prove)."""

from sqlalchemy import select

from oracle.baseline.models import Entity
from oracle.tenancy import tenant_session
from tests.outcome_helpers import outcome_world
from tests.test_roadmap import (  # noqa: F401 - fixtures
    owner,
    runtime,
)


async def _code_feature(tenant_id, key: str, code: str) -> None:
    async with tenant_session(tenant_id) as s:
        feature = await s.scalar(select(Entity).where(Entity.type == "feature", Entity.key == key))
        feature.key = code
        await s.commit()


async def test_outcomes_carry_the_items_feature_code(client, owner, runtime):  # noqa: F811
    """protects=GET /v1/outcomes and GET /v1/outcomes/{id} give the linked roadmap item's
    feature code, and an uncoded item's outcome reads None; fails_when=the field is missing,
    every outcome reads the same code, or the one-outcome read leaves it out;
    no_claim=how the web shows it."""
    tenant_id, auth = owner
    rows = await outcome_world(client, auth, runtime, tenant_id)
    await _code_feature(tenant_id, "payment-step", "F-12")

    listed = {
        r["roadmap_item_key"]: r for r in (await client.get("/v1/outcomes", headers=auth)).json()
    }
    assert listed["payment-step"]["roadmap_item_code"] == "F-12"
    assert listed["shipping-step"]["roadmap_item_code"] is None

    one = await client.get(f"/v1/outcomes/{rows['payment-step']['id']}", headers=auth)
    assert one.json()["roadmap_item_code"] == "F-12"

    shipped = await client.post(
        f"/v1/outcomes/{rows['payment-step']['id']}/shipped", json={}, headers=auth
    )
    assert shipped.status_code == 200, shipped.text
    assert shipped.json()["roadmap_item_code"] == "F-12"
