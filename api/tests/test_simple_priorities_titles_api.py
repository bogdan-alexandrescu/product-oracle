"""prio-ux (#1775): a priorities row whose item's title starts with its own code ("F-77 Ledger")
reads the name alone beside its ``own_key``, as the roadmap read names it
(service.coded_title), so the page never shows the code twice. Against Postgres; the world is
tests.test_simple_priorities_api's. Each test's card is its docstring.
"""

from sqlalchemy import select

from oracle.roadmap.models import RoadmapItem
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import clock, make_people  # noqa: F401
from tests.test_simple_priorities_api import World


async def test_a_coded_title_reads_its_name_beside_its_code(client):
    """protects=pay-1 titled "F-77 Ledger" reads own_key F-77 and title "Ledger"; fails_when=
    the row's title still starts with F-77 (the audit's "F-08 Conversion attribution v0" by an
    F-08 tag); no_claim=a title whose leading code is not its own key keeps it."""
    ctx = await make_people()
    w = await World(ctx).build()
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.scalar(select(RoadmapItem).where(RoadmapItem.item_key == "pay-1"))
        row.title = "F-77 Ledger"
        await s.commit()
    rows = {r["code"]: r for r in (await w.read(client))["rows"]}
    assert rows["pay-1"]["own_key"] == "F-77"
    assert rows["pay-1"]["title"] == "Ledger"
