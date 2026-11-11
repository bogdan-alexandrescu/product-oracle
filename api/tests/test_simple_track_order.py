"""track-order (owner Nov 9): the company's tracks keep one stored order, set in the Tracks
sheet with Move up and Move down (op ``move_track`` through the change engine). Against
Postgres. The company's clock is fixed (tests.test_simple_roadmap_api).

Test cards (protects / fails_when / no_claim):

- test_tracks_read_in_the_stored_order_and_move_one_step: protects=``GET
  /v1/simple/tracks`` and the roadmap read's ``tracks`` list the tracks in the stored order
  (oldest first until someone moves one), each with its ``order`` (each feature's track
  too); a new track goes last;
  ``move_track`` (after ``{to: up|down}``) moves one a step, in words, both reads follow;
  Undo puts it back; Group by Track's groups follow it too; the first cannot go up nor the
  last down; fails_when=a read is in another order, a move skips or does not land, or Undo
  leaves it moved; no_claim=the web.
- test_one_who_does_not_decide_proposes_a_move: protects=a move by one who does not decide
  the track (an approver on another's track) is proposed to its decider and applies on
  accept; a viewer may not; another company neither reads nor moves them;
  fails_when=the approver's move applies, the accept does not move it, or a viewer moves it;
  no_claim=the Tracks sheet's toast.
"""

from datetime import timedelta

import pytest

from oracle import company_time
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx
from tests.test_simple_roadmap_api import NOW, Seed

CHANGES = "/v1/simple/changes"
TRACKS = "/v1/simple/tracks"
ROADMAP = "/v1/simple/roadmap"


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


def who(ctx: Ctx, role: str) -> str:
    u = ctx.users[role]
    return u.name or u.email


async def seed(ctx: Ctx) -> dict[str, str]:
    """Three tracks made a day apart: Checkout (oldest), Search, Gift wrap (newest)."""
    async with tenant_session(ctx.tenant_id) as s:
        sd = Seed(s)
        out = {}
        for n, (slug, title) in enumerate(
            (("checkout", "Checkout"), ("search", "Search"), ("gift-wrap", "Gift wrap"))
        ):
            _, pv, rm, rv = await sd.roadmap(slug)
            t = await sd.track(pv, rm, title=title, owner_id=ctx.users["owner"].id)
            await sd.item(rv, pv, f"f-0{n + 1}", title=f"{title} page", track_id=t.id)
            t.created_at = NOW - timedelta(days=3 - n)
            out[title] = str(t.id)
        await s.commit()
        return out


async def tracks(client, ctx: Ctx, role: str = "owner") -> list[dict]:
    r = await client.get(TRACKS, headers=ctx.as_(role))
    assert r.status_code == 200, r.text
    return r.json()["tracks"]


async def titles(client, ctx: Ctx) -> list[str]:
    return [t["title"] for t in await tracks(client, ctx)]


async def bands(client, ctx: Ctx) -> list[str]:
    r = await client.get(ROADMAP, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    return [t["title"] for t in r.json()["tracks"]]


async def groups(client, ctx: Ctx) -> list[str]:
    """Group by Track: each track's group, in the track order, then No track."""
    r = await client.get(ROADMAP, params={"group": "track"}, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    return [g["title"] for g in r.json()["groups"] if g["key"] != "none"]


async def move(client, ctx: Ctx, role: str, track_id: str, to: str, code: int = 201) -> dict:
    body = {"op": "move_track", "target": {"track_id": track_id}, "before": {}, "after": {"to": to}}
    r = await client.post(CHANGES, json=body, headers=ctx.as_(role))
    assert r.status_code == code, r.text
    return r.json()


async def test_tracks_read_in_the_stored_order_and_move_one_step(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    start = ["Checkout", "Search", "Gift wrap"]
    assert await titles(client, ctx) == start
    assert await bands(client, ctx) == start
    assert await groups(client, ctx) == start
    # Tracks never moved (no place number) read oldest first.
    assert [t["order"] for t in await tracks(client, ctx)] == [None, None, None]

    moved = (await move(client, ctx, "owner", ids["Gift wrap"], "up"))["change"]
    assert moved["status"] == "applied" and moved["can_undo"] is True
    assert moved["words"] == f"{who(ctx, 'owner')} moved the track Gift wrap up"
    assert await titles(client, ctx) == ["Checkout", "Gift wrap", "Search"]
    assert await bands(client, ctx) == ["Checkout", "Gift wrap", "Search"]
    assert [t["order"] for t in await tracks(client, ctx)] == [1, 2, 3]
    # Each feature's track names its place number, for the pickers that list tracks.
    r = await client.get(ROADMAP, headers=ctx.as_("owner"))
    places = {i["track"]["title"]: i["track"]["order"] for i in r.json()["items"] if i["track"]}
    assert places == {"Checkout": 1, "Gift wrap": 2, "Search": 3}
    assert [t["order"] for t in r.json()["tracks"]] == [1, 2, 3]
    # One step per move.
    await move(client, ctx, "owner", ids["Gift wrap"], "up")
    assert await titles(client, ctx) == ["Gift wrap", "Checkout", "Search"]
    # The ends: the first does not go up, the last does not go down.
    await move(client, ctx, "owner", ids["Gift wrap"], "up", code=422)
    await move(client, ctx, "owner", ids["Search"], "down", code=422)
    await move(client, ctx, "owner", ids["Search"], "sideways", code=422)

    # Undo puts the order back as it was before that move.
    down = (await move(client, ctx, "owner", ids["Checkout"], "up"))["change"]
    assert await titles(client, ctx) == ["Checkout", "Gift wrap", "Search"]
    r = await client.post(f"{CHANGES}/{down['id']}/undo", headers=ctx.as_("owner"))
    assert r.status_code == 201, r.text
    assert await titles(client, ctx) == ["Gift wrap", "Checkout", "Search"]
    assert await bands(client, ctx) == ["Gift wrap", "Checkout", "Search"]
    assert await groups(client, ctx) == ["Gift wrap", "Checkout", "Search"]

    # A new track goes last.
    body = {"op": "add_track", "target": {}, "before": {}, "after": {"title": "Returns"}}
    r = await client.post(CHANGES, json=body, headers=ctx.as_("owner"))
    assert r.status_code == 201, r.text
    assert await titles(client, ctx) == ["Gift wrap", "Checkout", "Search", "Returns"]
    assert [t["order"] for t in await tracks(client, ctx)] == [1, 2, 3, 4]
    assert await bands(client, ctx) == ["Gift wrap", "Checkout", "Search", "Returns"]


async def test_one_who_does_not_decide_proposes_a_move(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    row = next(t for t in await tracks(client, ctx, "approver") if t["title"] == "Search")
    assert row["can_decide"] is False
    prop = (await move(client, ctx, "approver", ids["Search"], "up"))["change"]
    assert prop["status"] == "proposed" and prop["routed_to"] == [str(ctx.users["owner"].id)]
    assert "the track Search up" in prop["words"]
    assert await titles(client, ctx) == ["Checkout", "Search", "Gift wrap"]
    r = await client.post(f"{CHANGES}/{prop['id']}/accept", json={}, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert await titles(client, ctx) == ["Search", "Checkout", "Gift wrap"]

    await move(client, ctx, "viewer", ids["Search"], "down", code=403)
    other = await make_ctx()
    await move(client, other, "owner", ids["Search"], "down", code=404)
    assert await titles(client, ctx) == ["Search", "Checkout", "Gift wrap"]
