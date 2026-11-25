"""prio-ux (#1739): the three Priorities tabs read one "this quarter". With a dated plan, an
item the plan places in its span makes the Now line (Ranked list, Value / effort) exactly as
it counts in the goal buckets' weeks, whatever its horizon. Against Postgres; the world is
tests.test_simple_plan_api's. Each test's card is its docstring.
"""

from datetime import timedelta

from sqlalchemy import select

from oracle.baseline.models import Entity
from oracle.roadmap.models import RoadmapItem
from oracle.tenancy import tenant_session
from tests.day_helpers import company_today
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


async def test_an_item_dated_into_now_outside_the_plan_makes_the_line_and_its_bucket(client):
    """protects=an item whose dates put it in Now but which the plan does not place (another
    section of the PRD) makes the Now line and counts in its goal's bucket, beside the plan's
    own; fails_when=with a dated plan the line reads only the plan's items (a feature a
    person dates into this quarter on the Roadmap stays below the line); no_claim=the
    plan-outside list's words."""
    ctx = await make_ctx()
    await seed(ctx, items=("f-03", "x-01"))
    today = company_today()
    async with tenant_session(ctx.tenant_id) as s:
        for key, title in (("f-03", "Invite teammates"), ("x-01", "Alert rules engine")):
            feature = Entity(type="feature", key=key + "-feature", title=title,
                             status="confirmed", origin="user", attrs={"effort": 2})  # fmt: skip
            s.add(feature)
            await s.flush()
            row = await s.scalar(select(RoadmapItem).where(RoadmapItem.item_key == key))
            row.feature_id = feature.id
            if key == "x-01":
                row.start_date, row.end_date = today, today + timedelta(days=14)
        await s.commit()
    r = await client.get("/v1/simple/priorities", headers=ctx.as_("viewer"))
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["line"]["key"] == "now"
    makes = {x["code"] for x in out["rows"] if x["above_line"]}
    counted = {c for b in out["buckets"] for c in b["codes"]}
    assert makes == counted == {"f-03", "x-01"}
