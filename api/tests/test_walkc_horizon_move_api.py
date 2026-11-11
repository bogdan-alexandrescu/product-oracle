"""walkc-roadmap-tasks review: a horizon move carries an item's own dates with it.
Against Postgres, on tests.test_simple_changes_api's World.

Test card (protects / fails_when / no_claim):

- test_a_horizon_move_moves_an_items_own_dates: protects=moving a dated item (typed Oct 1 -
  Nov 15) from Now to Later shifts its own dates by whole quarters (board-quarters: into
  Later's first quarter), keeping its length, so the roadmap read draws it in Later; undo
  puts the horizon and the dates back; fails_when=the move writes only the horizon and the
  dated item stays at its old dates; no_claim=undated and engineering-dated items
  (tests.test_simple_board_quarters_api).
"""

from datetime import date, timedelta

from tests.test_simple_changes_api import CHANGES, World, clock, make_people  # noqa: F401

URL = "/v1/simple/roadmap"


async def read_items(client, ctx) -> dict:
    body = (await client.get(URL, headers=ctx.as_("decider"))).json()
    return {i["key"]: i for i in body["items"]}


async def test_a_horizon_move_moves_an_items_own_dates(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["change_horizon"])
    read = (await client.get(URL, headers=ctx.as_("owner"))).json()
    win = {h: date.fromisoformat(read["windows"][h]["start"]) for h in ("now", "later")}
    shift = win["later"] - win["now"]
    assert shift > timedelta(0) and win["later"].day == 1

    r = await w.post(client, "decider", "change_horizon", after={"horizon": "later"})
    assert r.status_code == 201, r.text
    a = await w.item("change_horizon-a")
    assert a.horizon == "later"
    assert (a.start_date, a.end_date) == (date(2026, 10, 1) + shift, date(2026, 11, 15) + shift)
    assert a.date_source == "typed"
    items = await read_items(client, ctx)
    got = items["change_horizon-a"]
    assert (got["start"]["date"], got["end"]["date"]) == (
        (date(2026, 10, 1) + shift).isoformat(),
        (date(2026, 11, 15) + shift).isoformat(),
    )
    assert got["estimated"] is False

    undo = await client.post(f"{CHANGES}/{r.json()['change']['id']}/undo",
                             headers=ctx.as_("decider"))  # fmt: skip
    assert undo.status_code == 201, undo.text
    a = await w.item("change_horizon-a")
    assert (a.horizon, a.start_date, a.end_date) == ("now", date(2026, 10, 1), date(2026, 11, 15))
