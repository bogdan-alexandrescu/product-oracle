"""prio-ux (#1739): the three Priorities tabs read one "this quarter". With a dated plan, an
item the plan places in its span makes the Now line (Ranked list, Value / effort) exactly as
it counts in the goal buckets' weeks, whatever its horizon. Against Postgres; the world is
tests.test_simple_plan_api's. Each test's card is its docstring.
"""

from sqlalchemy import select

from oracle.baseline.models import Entity
from oracle.roadmap.models import RoadmapItem
from oracle.tenancy import tenant_session
from tests.test_simple_plan_api import make_ctx, seed


async def test_the_now_line_and_the_buckets_read_one_set(client):
    """protects=f-03, in the plan's span but on the Later horizon, makes the Now line and
    counts in its goal's bucket; fails_when=the line reads the horizon while the buckets read
    the plan (Makes this quarter 35 beside 0 weeks planned); no_claim=a picked dated line."""
    ctx = await make_ctx()
    await seed(ctx, items=("f-03",))
    async with tenant_session(ctx.tenant_id) as s:
        feature = Entity(type="feature", key="invite-teammates", title="Invite teammates",
                         status="confirmed", origin="user", attrs={"effort": 5})  # fmt: skip
        s.add(feature)
        await s.flush()
        row = await s.scalar(select(RoadmapItem).where(RoadmapItem.item_key == "f-03"))
        row.feature_id, row.horizon = feature.id, "later"
        await s.commit()
    r = await client.get("/v1/simple/priorities", headers=ctx.as_("viewer"))
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["line"]["key"] == "now"
    makes = {x["code"] for x in out["rows"] if x["above_line"]}
    counted = {c for b in out["buckets"] for c in b["codes"]}
    assert makes == counted == {"f-03"}
