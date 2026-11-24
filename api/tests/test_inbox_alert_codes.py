"""inbox-ux (#1786): an Inbox track alert names its item with the item's feature code, as every
feature reads ("F-17 Checkout tips"); an item with no code has none. Reuses the stale-marks
walk's world (tests/test_inbox_track_alerts_walk.py). Against Postgres. Invented data only.

protects=the code with every feature name on the Inbox's track rows; fails_when=the alert
carries no item_code, or one for an item with no code; no_claim=the web row (the Playwright
spec web/e2e/inbox-ux.spec.ts).
"""

from sqlalchemy import update

from oracle.roadmap.models import RoadmapItem
from oracle.tenancy import tenant_session
from tests.test_inbox_track_alerts_walk import inbox_tracks, world


async def test_an_alert_carries_its_items_code(client):
    """An alert names its item with the item's code (F-17), and none for an item with none."""
    ctx, tracks = await world()
    async with tenant_session(ctx.tenant_id) as s:
        # Checkout tips came from the Conversion PRD's coded section f-17: its code is F-17.
        await s.execute(
            update(RoadmapItem)
            .where(RoadmapItem.item_key == "checkout-tips")
            .values(prd_section_key="f-17")
        )
        await s.commit()
    for track_id in tracks.values():
        r = await client.post(f"/v1/tracks/{track_id}/monitor", headers=ctx.as_("owner"))
        assert r.status_code == 200, r.text
    rows = await inbox_tracks(client, ctx)
    alerts = {a["item_key"]: a for t in rows.values() for a in t["alerts"]}
    assert alerts["checkout-tips"]["item_code"] == "F-17"
    assert alerts["checkout-tips"]["item_title"] == "Checkout tips"
    # Signup nudge's section (s-2) is no code, and it has no feature: no code.
    assert alerts["signup-nudge"]["item_code"] is None
