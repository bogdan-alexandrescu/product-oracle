"""prd-order on Plan (its own file, so the change reverts in one piece): the PRD cards, and
Group by PRD's lanes that take their order, follow the company PRD order."""

from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.test_simple_roadmap_api import Seed


async def test_plan_cards_follow_the_prd_order(client):
    """protects=GET /v1/plan's prds in the company PRD order, before and after a move;
    fails_when=newest first (or waiting-for-me, then at-risk, first)."""
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        for slug in ("apple", "banana", "cherry"):
            await seed.version(await seed.doc(slug), approved=False)
        await s.commit()

    async def cards() -> list[str]:
        r = await client.get("/v1/plan", headers=ctx.as_("owner"))
        assert r.status_code == 200, r.text
        return [p["document"]["slug"] for p in r.json()["prds"]]

    assert await cards() == ["apple", "banana", "cherry"]
    r = await client.post("/v1/documents/cherry/move", json={"to": "up"},
                          headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert await cards() == ["apple", "cherry", "banana"]
