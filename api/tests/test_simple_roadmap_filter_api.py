"""Simple roadmap's Roadmap filter (#723): the read narrowed to one roadmap
(``GET /v1/simple/roadmap?roadmap=<id or slug>``) with every roadmap the reader may read
(``roadmaps``); quick add (``add_item``) and key dates (``add_key_date`` and friends) sent to
the roadmap the person chose (``target.roadmap_id``); 404 on a roadmap they cannot read; the
pick remembered per person (``simple_roadmap`` in /v1/me/preferences). Against Postgres. The
world: tests.test_simple_key_dates_api's ``payments`` plus ``growth`` (company-wide) and
``board`` (approvers only). Each test's card is its docstring (protects / fails_when /
no_claim).
"""

from datetime import date

from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import CHANGES, World
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_key_dates_api import LAUNCH, world
from tests.test_simple_roadmap_api import Seed

ROADMAP = "/v1/simple/roadmap"
PREFS = "/v1/me/preferences"


async def more_roadmaps(w: World) -> dict[str, str]:
    """``growth`` (one item, ``growth-a``) and ``board`` (approvers only, ``board-a``)."""
    out: dict[str, str] = {}
    async with tenant_session(w.ctx.tenant_id) as s:
        seed = Seed(s)
        for slug, visibility in (("growth", "company"), ("board", "approvers")):
            _, pv, rm, rv = await seed.roadmap(slug, visibility)
            await seed.item(rv, pv, f"{slug}-a", start_date=date(2026, 11, 2),
                            end_date=date(2026, 11, 27), date_source="typed")  # fmt: skip
            out[slug] = str(rm.id)
        await s.commit()
    return out


async def read(client, w: World, who: str, **q) -> dict:
    r = await client.get(ROADMAP, params=q, headers=w.ctx.as_(who))
    assert r.status_code == 200, r.text
    return r.json()


def roadmaps_of(out: dict) -> set[str]:
    return {i["roadmap"]["id"] for i in out["items"]}


async def test_filter_shows_one_roadmap_and_lists_the_readable_ones(client):
    """protects=``roadmap`` narrows the read to that roadmap's items (by id or slug) and
    ``roadmaps`` lists every roadmap the reader may read, approvers-only ones only for
    approvers and up; fails_when=the filter lets other roadmaps' items through, or a viewer
    is offered (or can read) an approvers-only roadmap; no_claim=the web's select."""
    w = await world()
    rm = await more_roadmaps(w)
    everything = await read(client, w, "viewer")
    assert roadmaps_of(everything) == {w.roadmap_id, rm["growth"]}
    assert {r["roadmap"]["slug"] for r in everything["roadmaps"]} == {"payments", "growth"}
    approver = await read(client, w, "approver")
    assert {r["roadmap"]["slug"] for r in approver["roadmaps"]} == {"payments", "growth", "board"}
    for given in (rm["growth"], "growth"):
        one = await read(client, w, "viewer", roadmap=given)
        assert roadmaps_of(one) == {rm["growth"]}, given
        assert [i["title"] for i in one["items"]] == ["Growth A"]
    r = await client.get(ROADMAP, params={"roadmap": rm["board"]}, headers=w.ctx.as_("viewer"))
    assert r.status_code == 404, r.text
    assert roadmaps_of(await read(client, w, "approver", roadmap="board")) == {rm["board"]}


async def test_key_date_goes_to_the_named_roadmap(client):
    """protects=an add_key_date naming ``target.roadmap_id`` lands in that roadmap's working
    draft and shows only when that roadmap is read (the Key dates editor of a filtered
    view); fails_when=it lands on another roadmap or the first one; no_claim=routing per
    role (tests.test_simple_key_dates_api)."""
    w = await world()
    rm = await more_roadmaps(w)
    r = await client.post(CHANGES, headers=w.ctx.as_("owner"), json={
        "op": "add_key_date", "target": {"roadmap_id": rm["growth"]},
        "before": {"key_date": None}, "after": LAUNCH})  # fmt: skip
    assert r.status_code == 201, r.text
    c = r.json()["change"]
    assert (c["document_id"], c["status"]) == (rm["growth"], "applied")
    growth = await read(client, w, "owner", roadmap=rm["growth"])
    assert [(k["name"], k["roadmap"]["id"]) for k in growth["key_dates"]] == [
        ("Spring launch", rm["growth"])
    ]
    assert (await read(client, w, "owner", roadmap=w.roadmap_id))["key_dates"] == []
    # Two names for two roadmaps is a mistake, not a guess.
    r = await client.post(CHANGES, headers=w.ctx.as_("owner"), json={
        "op": "add_key_date", "target": {"roadmap_id": rm["growth"], "document_id": w.roadmap_id},
        "before": {"key_date": None}, "after": LAUNCH})  # fmt: skip
    assert r.status_code == 422, r.text


async def test_filtered_read_lists_its_roadmap_even_with_no_items_shown(client):
    """protects=a roadmap read with other filters that hide its items still carries its
    key dates and its key_date_roadmaps row, so the Key dates editor targets it;
    fails_when=the editor of a filtered view has no roadmap to add to; no_claim=the web."""
    w = await world()
    rm = await more_roadmaps(w)
    out = await read(client, w, "owner", roadmap=rm["growth"], track=w.roadmap_id)
    assert out["items"] == []
    assert [r["roadmap"]["id"] for r in out["key_date_roadmaps"]] == [rm["growth"]]
    assert out["key_date_roadmaps"][0]["applies"] is True


async def test_item_goes_to_the_named_roadmap(client):
    """protects=quick add's add_item with ``target.roadmap_id`` puts the item on that
    roadmap (not the goal's or the first one); fails_when=the item lands elsewhere;
    no_claim=Oracle's drafting of the item (tests.test_simple_additions_api)."""
    w = await world()
    rm = await more_roadmaps(w)
    r = await client.post(CHANGES, headers=w.ctx.as_("owner"), json={
        "op": "add_item", "target": {"roadmap_id": rm["growth"],
                                     "where": {"kind": "horizon", "value": "next"}},
        "before": {}, "after": {"title": "Referral rewards"}})  # fmt: skip
    assert r.status_code == 201, r.text
    assert r.json()["change"]["document_id"] == rm["growth"]
    growth = await read(client, w, "owner", roadmap=rm["growth"])
    assert "Referral rewards" in [i["title"] for i in growth["items"]]
    payments = await read(client, w, "owner", roadmap=w.roadmap_id)
    assert "Referral rewards" not in [i["title"] for i in payments["items"]]


async def test_a_roadmap_the_person_cannot_read_is_404(client):
    """protects=a commenter naming an approvers-only roadmap in add_item or add_key_date
    gets 404 (nothing is proposed), while an approver may propose there; fails_when=the
    roadmap's existence leaks or a change is recorded on it; no_claim=the read's own 404
    (test_filter_shows_one_roadmap_and_lists_the_readable_ones)."""
    w = await world()
    rm = await more_roadmaps(w)
    bodies = [
        {"op": "add_key_date", "target": {"roadmap_id": rm["board"]},
         "before": {"key_date": None}, "after": LAUNCH},
        {"op": "add_item", "target": {"roadmap_id": rm["board"],
                                      "where": {"kind": "horizon", "value": "now"}},
         "before": {}, "after": {"title": "Board pack"}},
    ]  # fmt: skip
    for body in bodies:
        r = await client.post(CHANGES, json=body, headers=w.ctx.as_("commenter"))
        assert r.status_code == 404, (body["op"], r.text)
    mine = await client.get(CHANGES, params={"status": "proposed"}, headers=w.ctx.as_("owner"))
    assert mine.status_code == 200 and mine.json() == [], mine.text
    for body in bodies:
        r = await client.post(CHANGES, json=body, headers=w.ctx.as_("approver"))
        assert r.status_code == 201, (body["op"], r.text)
        assert r.json()["change"]["document_id"] == rm["board"]


async def test_the_pick_is_remembered_per_person(client):
    """protects=``simple_roadmap`` (a roadmap id or ``all``) is kept per person, viewers
    included, and malformed picks are 422; fails_when=one person's pick shows for another
    or junk is stored; no_claim=that the web applies it (the Playwright spec)."""
    w = await world()
    rm = await more_roadmaps(w)
    r = await client.patch(PREFS, json={"simple_roadmap": rm["growth"]},
                           headers=w.ctx.as_("viewer"))  # fmt: skip
    assert r.status_code == 200 and r.json()["simple_roadmap"] == rm["growth"], r.text
    r = await client.get(PREFS, headers=w.ctx.as_("owner"))
    assert r.json()["simple_roadmap"] is None
    r = await client.patch(PREFS, json={"simple_roadmap": "all"}, headers=w.ctx.as_("viewer"))
    assert r.json()["simple_roadmap"] == "all"
    r = await client.patch(PREFS, json={"simple_roadmap": "growth;drop"},
                           headers=w.ctx.as_("viewer"))  # fmt: skip
    assert r.status_code == 422, r.text


async def test_all_roadmaps_carries_every_readable_roadmaps_key_dates(client):
    """protects=with no roadmap chosen the read carries the key dates of every roadmap the
    reader may read (``key_date_roadmaps`` lists them all), so a key date added to a roadmap
    whose items the other filters hide is still listed in the Key dates editor;
    fails_when=only the roadmaps of the items shown are listed (review minor 1);
    no_claim=the web's grouping (the Playwright spec)."""
    w = await world()
    rm = await more_roadmaps(w)
    r = await client.post(CHANGES, headers=w.ctx.as_("owner"), json={
        "op": "add_key_date", "target": {"roadmap_id": rm["growth"]},
        "before": {"key_date": None}, "after": LAUNCH})  # fmt: skip
    assert r.status_code == 201, r.text
    out = await read(client, w, "owner", track=w.roadmap_id)
    assert out["items"] == []
    assert {r["roadmap"]["slug"] for r in out["key_date_roadmaps"]} == {
        "payments",
        "growth",
        "board",
    }
    assert [(k["name"], k["roadmap"]["id"]) for k in out["key_dates"]] == [
        ("Spring launch", rm["growth"])
    ]
    viewer = await read(client, w, "viewer", track=w.roadmap_id)
    assert {r["roadmap"]["slug"] for r in viewer["key_date_roadmaps"]} == {"payments", "growth"}


async def test_prd_goal_and_track_are_remembered_per_person(client):
    """protects=``simple_filters`` (the Simple roadmap's PRD, Goal and Track picks) is kept
    per person like ``simple_roadmap``, an empty pick clears it, and junk is 422;
    fails_when=only the Roadmap filter is remembered (review minor 4), one person's picks
    show for another, or junk is stored; no_claim=that the web applies them (the spec)."""
    w = await world()
    picks = {"prd": "payments-prd", "goal": "G1", "track": w.roadmap_id}
    r = await client.patch(PREFS, json={"simple_filters": picks}, headers=w.ctx.as_("viewer"))
    assert r.status_code == 200, r.text
    assert r.json()["simple_filters"] == picks
    assert (await client.get(PREFS, headers=w.ctx.as_("owner"))).json()["simple_filters"] is None
    r = await client.patch(PREFS, json={"simple_filters": {"prd": "", "goal": "G1", "track": ""}},
                           headers=w.ctx.as_("viewer"))  # fmt: skip
    assert r.json()["simple_filters"] == {"prd": "", "goal": "G1", "track": ""}
    for junk in ({"prd": "x" * 300}, {"group": "goal"}, {"goal": "G1;drop"}):
        r = await client.patch(PREFS, json={"simple_filters": junk}, headers=w.ctx.as_("viewer"))
        assert r.status_code == 422, (junk, r.text)
