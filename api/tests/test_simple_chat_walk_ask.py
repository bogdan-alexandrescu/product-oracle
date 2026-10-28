"""Simple S9 production walk (#723): the Ask panel's one box, relative times in chat moves,
and the change card's constraint lines. Against Postgres; the world, people and helpers are
test_simple_chat_api's (today: Mon Nov 2 2026 in the company's Pacific time zone).

Test cards (protects / fails_when / no_claim):

- test_relative_times_move_dates (one case per phrasing): protects="move <item> to this
  quarter / next quarter / the quarter after / next month / <month> / Qn [year] / Hn
  [year]" each become one move_dates card with the right window (a dated item keeps its
  length, an undated one fills the period), and asking writes nothing; fails_when=a
  phrasing answers "I did not understand", or resolves to the wrong period or year;
  no_claim=wordings outside the documented list.
- test_now_next_later_stay_horizon_moves: protects=Now / Next / Later still change the
  horizon (not dates) while "next quarter" and "next month" move dates; fails_when="next
  quarter" is read as the Next horizon; no_claim=the horizon's windows.
- test_relative_times_use_the_company_time_zone: protects=on Dec 31 at 9 PM Pacific (Jan 1
  in UTC) "this quarter" is Q4 2026 and "next quarter" Q1 2027; fails_when=the server's
  (UTC) day decides the quarter; no_claim=other zones (the company's setting is read the
  same way).
- test_a_period_already_begun_says_so: protects=a move to a period that has begun (this
  quarter, this month, the current Qn) says in its reply that the start is a past day,
  and a future period's reply does not; fails_when=the card starts on a past day without
  a word; no_claim=the card's dates (test_relative_times_move_dates).
- test_only_understood_routes_the_rest_to_ask: protects=with only_understood, a line S9
  understands (a change request, who owns, who decides, when is) gets its reply in the
  thread with understood=true, while any other line (or a question about something not on
  the roadmap) answers understood=false and writes nothing, so the panel sends it to
  Oracle's Ask; chat-reader: a line parse() does not know is pending for Oracle's reader;
  fails_when=an unknown line writes a message, or a change request falls through to Ask;
  no_claim=Ask's model answer (the discussions' own tests).
- test_constraint_line_names_the_dependent_and_the_dependency: protects=moving an item
  past the start of an item that depends on it gives the dependent's red line naming the
  dependent first and the moved dependency second, with the year when they differ;
  fails_when=the line names only the moved item; no_claim=the fix labels' wording.
"""

from datetime import UTC, datetime

import pytest

from oracle import company_time
from tests.test_simple_chat_api import ASK, NOW, World, make_people, n_changes, say


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


# Ledger v2 is Oct 1 - Nov 15 2026 (45 days); Partner API is undated.
CASES = [
    ("Ledger v2", "this quarter", "2026-10-01", "2026-11-15"),
    ("Ledger v2", "next quarter", "2027-01-01", "2027-02-15"),
    ("Ledger v2", "the quarter after", "2027-04-01", "2027-05-16"),
    ("Ledger v2", "the quarter after next", "2027-04-01", "2027-05-16"),
    ("Ledger v2", "next month", "2026-12-01", "2027-01-15"),
    ("Ledger v2", "March", "2027-03-01", "2027-04-15"),
    ("Ledger v2", "november", "2026-11-01", "2026-12-16"),
    ("Ledger v2", "Q2", "2027-04-01", "2027-05-16"),
    ("Ledger v2", "Q3 2027", "2027-07-01", "2027-08-15"),
    ("Ledger v2", "Q1 2028", "2028-01-01", "2028-02-15"),
    ("Ledger v2", "H1", "2027-01-01", "2027-02-15"),
    ("Ledger v2", "H2 2027", "2027-07-01", "2027-08-15"),
    ("Partner API", "next quarter", "2027-01-01", "2027-03-31"),
    ("Partner API", "this quarter", "2026-10-01", "2026-12-31"),
    ("Partner API", "the quarter after", "2027-04-01", "2027-06-30"),
    ("Partner API", "next month", "2026-12-01", "2026-12-31"),
    ("Partner API", "February", "2027-02-01", "2027-02-28"),
    ("Partner API", "H1", "2027-01-01", "2027-06-30"),
    ("Partner API", "H2 2027", "2027-07-01", "2027-12-31"),
    ("Partner API", "Q4 2027", "2027-10-01", "2027-12-31"),
]


@pytest.mark.parametrize(("item", "when", "start", "end"), CASES)
async def test_relative_times_move_dates(client, item, when, start, end):
    ctx = await make_people()
    w = await World(ctx).build()
    m = await say(client, ctx, "owner", f"move {item} to {when}")
    assert m["kind"] == "cards", m["body"]
    (card,) = m["cards"]
    assert card["op"] == "move_dates"
    assert card["item_id"] == w.ids[item]
    assert card["after"] == {"start_date": start, "end_date": end}
    assert card["preview"] == {"kind": "dates", "item_id": w.ids[item],
                               "start_date": start, "end_date": end}  # fmt: skip
    assert await n_changes(ctx) == 0


async def test_now_next_later_stay_horizon_moves(client):
    ctx = await make_people()
    await World(ctx).build()
    for h in ("Now", "next", "Later"):
        m = await say(client, ctx, "owner", f"move Partner API to {h}")
        assert [c["op"] for c in m["cards"]] == ["change_horizon"], h
        assert m["cards"][0]["after"] == {"horizon": h.lower()}
    for when in ("next quarter", "next month"):
        m = await say(client, ctx, "owner", f"move Partner API to {when}")
        assert [c["op"] for c in m["cards"]] == ["move_dates"], when


async def test_relative_times_use_the_company_time_zone(client, monkeypatch):
    ctx = await make_people()
    await World(ctx).build()
    # Dec 31 2026, 9 PM in Pacific time: already Jan 1 2027 in UTC.
    monkeypatch.setattr(company_time, "now", lambda: datetime(2027, 1, 1, 5, 0, tzinfo=UTC))
    this = await say(client, ctx, "owner", "move Partner API to this quarter")
    assert this["cards"][0]["after"] == {"start_date": "2026-10-01", "end_date": "2026-12-31"}
    nxt = await say(client, ctx, "owner", "move Partner API to next quarter")
    assert nxt["cards"][0]["after"] == {"start_date": "2027-01-01", "end_date": "2027-03-31"}
    month = await say(client, ctx, "owner", "move Partner API to next month")
    assert month["cards"][0]["after"] == {"start_date": "2027-01-01", "end_date": "2027-01-31"}


async def test_a_period_already_begun_says_so(client):
    ctx = await make_people()
    await World(ctx).build()
    for when, began in (("this quarter", "Oct 1"), ("this month", "Nov 1"), ("Q4", "Oct 1")):
        m = await say(client, ctx, "owner", f"move Partner API to {when}")
        assert m["kind"] == "cards", when
        assert f"That period began {began}, so the move starts on a past day." in m["body"], when
    for when in ("next quarter", "next month", "Q2"):
        m = await say(client, ctx, "owner", f"move Partner API to {when}")
        assert "past day" not in m["body"], when


async def test_only_understood_routes_the_rest_to_ask(client):
    ctx = await make_people()
    await World(ctx).build()

    async def ask(who: str, text: str) -> dict:
        r = await client.post(ASK, json={"text": text, "only_understood": True},
                              headers=ctx.as_(who))  # fmt: skip
        assert r.status_code == 200, r.text
        return r.json()

    for line in ("when is the offsite?", "who owns pricing?"):
        out = await ask("commenter", line)
        assert out["understood"] is False, line
        assert out["messages"] == [], line
    # chat-reader: any other line is read by Oracle's reader first (it answers "ask" for a
    # plain question, test_simple_chat_reader).
    for line in ("What should we cut first?", "Summarise this page"):
        out = await ask("commenter", line)
        assert out["understood"] is True, line
        assert out["messages"][-1]["kind"] == "pending", line
    for who, line, kind in (
        ("commenter", "who owns Ledger v2?", "answer"),
        ("viewer", "who decides Ledger v2?", "answer"),
        ("viewer", "when is Bulk import?", "answer"),
        ("commenter", "move Ledger v2 to next quarter", "cards"),
        ("owner", "cut Alert export", "cards"),
        ("owner", "move alert to Q2", "question"),
    ):
        out = await ask(who, line)
        assert out["understood"] is True, line
        assert out["messages"][-1]["kind"] == kind, line
        assert out["messages"][-2]["body"] == line
    assert await n_changes(ctx) == 0
    # Without the flag too, a line parse() does not know is for the reader.
    r = await client.post(ASK, json={"text": "make it better"}, headers=ctx.as_("owner"))
    assert r.json()["messages"][-1]["body"] == "Reading that…"


async def test_constraint_line_names_the_dependent_and_the_dependency(client):
    ctx = await make_people()
    await World(ctx).build()
    # Bulk import (Nov 20 - Dec 20 2026) depends on Ledger v2.
    m = await say(client, ctx, "owner", "move Ledger v2 to next quarter")
    (card,) = m["cards"]
    lines = [f["reason"] for x in card["flags"] for f in x["flags"] if f["state"] == "red"]
    assert lines == ["'Bulk import' starts Nov 20 2026, but 'Ledger v2', which it depends on, "
                     "ends Feb 15 2027"]  # fmt: skip
