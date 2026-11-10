"""board-quarters (owner, Nov 10): the roadmap read puts each item in the quarter of its
dates, and a column move (change_horizon) shifts the dates by whole quarters. Against
Postgres, on tests.test_simple_changes_api's World; the company's day is Nov 2, 2026.

Test card (protects / fails_when / no_claim):

- test_the_read_puts_items_in_the_quarter_of_their_dates: protects=items read Now / Next /
  Later from their dates whatever horizon is stored (a spanning item, one ending a day into
  next year, an engineering-dated one, an undated one in Later with an estimated bar), and
  the windows are this quarter, next quarter and from the quarter after; fails_when=the
  read shows the stored horizon or the company's short/medium horizons.
- test_a_column_move_shifts_dates_by_quarters: protects=Now -> Next across the year end
  moves the dates three months, length kept, the read shows Next, undo restores them; a
  stored horizon that disagrees with the dates is no conflict (``before`` is the read's);
  an engineering-dated item moved to Later gets typed dates a quarter on; an undated item
  moved to Next gets Next's quarter; a commenter's move is a proposal that changes
  nothing; fails_when=dates shift by days between windows, or only the horizon is written.
"""

from datetime import date

from sqlalchemy import select

from oracle.docs.models import DocumentVersion
from oracle.roadmap.models import RoadmapItem
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import CHANGES, World, clock, make_people  # noqa: F401
from tests.test_simple_roadmap_api import Seed

URL = "/v1/simple/roadmap"


async def read(client, ctx) -> dict:
    return (await client.get(URL, headers=ctx.as_("decider"))).json()


async def seed_more(w: World) -> None:
    async with tenant_session(w.ctx.tenant_id) as s:
        a = await s.scalar(select(RoadmapItem).where(RoadmapItem.item_key == "change_horizon-a"))
        rv = await s.get(DocumentVersion, a.roadmap_version_id)
        seed = Seed(s)
        rows = [
            await seed.item(rv, None, "spans", horizon="later", position=20, track_id=a.track_id,
                            start_date=date(2026, 8, 15), end_date=date(2026, 11, 20),
                            date_source="typed"),
            await seed.item(rv, None, "edge", horizon="next", position=21, track_id=a.track_id,
                            start_date=date(2026, 12, 31), end_date=date(2027, 1, 20),
                            date_source="typed"),
            await seed.item(rv, None, "q1", horizon="now", position=22, track_id=a.track_id,
                            start_date=date(2027, 1, 5), end_date=date(2027, 2, 10),
                            date_source="typed"),
            await seed.item(rv, None, "q2", horizon="now", position=23, track_id=a.track_id,
                            start_date=date(2027, 4, 10), end_date=date(2027, 5, 20),
                            date_source="typed"),
            await seed.item(rv, None, "eng", horizon="now", position=24, track_id=a.track_id,
                            start_date=date(2027, 1, 10), end_date=date(2027, 2, 20),
                            date_source="engineering"),
            await seed.item(rv, None, "blank", horizon="now", position=25, track_id=a.track_id),
        ]  # fmt: skip
        await s.commit()
        for r in rows:
            w.ids[r.item_key] = str(r.id)


async def test_the_read_puts_items_in_the_quarter_of_their_dates(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["change_horizon"])
    await seed_more(w)
    body = await read(client, ctx)
    win = body["windows"]
    assert (win["now"]["start"], win["now"]["end"]) == ("2026-10-01", "2026-12-31")
    assert (win["next"]["start"], win["next"]["end"]) == ("2027-01-01", "2027-03-31")
    assert win["later"]["start"] == "2027-04-01"
    got = {i["key"]: i for i in body["items"]}
    assert {k: got[k]["horizon"] for k in ("spans", "edge", "q1", "q2", "eng", "blank")} == {
        "spans": "now", "edge": "now", "q1": "next", "q2": "later", "eng": "next",
        "blank": "later",
    }  # fmt: skip
    blank = got["blank"]
    assert blank["start"]["estimated"] and blank["end"]["estimated"]
    assert blank["start"]["date"] == "2027-04-01"


async def test_a_column_move_shifts_dates_by_quarters(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["change_horizon"])
    await seed_more(w)

    r = await w.post(client, "decider", "change_horizon", after={"horizon": "next"})
    assert r.status_code == 201, r.text
    a = await w.item("change_horizon-a")
    assert (a.start_date, a.end_date, a.date_source) == (date(2027, 1, 1), date(2027, 2, 15),
                                                         "typed")  # fmt: skip
    got = {i["key"]: i for i in (await read(client, ctx))["items"]}["change_horizon-a"]
    assert got["horizon"] == "next"
    assert (got["start"]["date"], got["end"]["date"]) == ("2027-01-01", "2027-02-15")
    undo = await client.post(f"{CHANGES}/{r.json()['change']['id']}/undo",
                             headers=ctx.as_("decider"))  # fmt: skip
    assert undo.status_code == 201, undo.text
    a = await w.item("change_horizon-a")
    assert (a.start_date, a.end_date) == (date(2026, 10, 1), date(2026, 11, 15))

    async def move(key: str, before: str, after: str, who: str = "decider"):
        return await client.post(CHANGES, headers=ctx.as_(who), json={
            "op": "change_horizon", "target": {"item_id": w.ids[key]},
            "before": {"horizon": before}, "after": {"horizon": after}})  # fmt: skip

    # Stored "now", read "later" (its dates): the read's horizon is no conflict.
    r = await move("q2", "later", "next")
    assert r.status_code == 201, r.text
    q2 = await w.item("q2")
    assert (q2.start_date, q2.end_date) == (date(2027, 1, 10), date(2027, 2, 19))

    r = await move("eng", "next", "later")
    assert r.status_code == 201, r.text
    eng = await w.item("eng")
    assert (eng.start_date, eng.end_date, eng.date_source) == (
        date(2027, 4, 10), date(2027, 5, 21), "typed")  # fmt: skip

    r = await move("blank", "later", "next")
    assert r.status_code == 201, r.text
    blank = await w.item("blank")
    assert (blank.start_date, blank.end_date) == (date(2027, 1, 1), date(2027, 3, 31))

    r = await move("q1", "next", "later", who="commenter")
    assert r.status_code == 201, r.text
    assert r.json()["change"]["status"] == "proposed"
    q1 = await w.item("q1")
    assert (q1.start_date, q1.end_date) == (date(2027, 1, 5), date(2027, 2, 10))
