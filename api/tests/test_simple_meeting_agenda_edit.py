"""mk-edit-meetings-tracks, proposal b (owner's pick, Nov 5): the Agenda sheet's ops.

``POST /v1/simple/meetings/{id}/agenda`` adds a feature or a typed topic, renames, moves
and removes an item of a live meeting's agenda; Undo puts the agenda back as it was before
the sheet's batch. An owner or the PRD's decider saves; an approver who is not the decider
proposes (the agenda does not change; the proposal names the decider, who accepts it or the
proposer withdraws it); a viewer reads.

- test_owner_adds_renames_moves_removes_and_undoes: protects=each op changes the agenda the
  meeting reads (rows in order, kind, minutes, who added a topic), the current item stays,
  Undo restores the batch; fails_when=an op is missing or Undo leaves a change.
- test_approver_not_decider_proposes: protects=an approver's op leaves the agenda as is and
  names the decider; the decider accepts it; fails_when=the approver's op applies.
- test_viewer_is_refused: protects=a viewer's op is a 403 and the viewer reads the agenda.
- test_chat_next_and_skip_still_work: protects=the chat's next and skip read on the rows
  alongside the sheet's edits; fails_when=either stops working after an edit.
"""

from tests.test_simple_chat_actions import apply, one_card
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_meetings_api import MEETINGS, get, start, uid, world


async def op(client, w, who: str, mid: str, **body):
    return await client.post(f"{MEETINGS}/{mid}/agenda", json=body, headers=w.ctx.as_(who))


def titles(m: dict) -> list[str]:
    return [x["title"] for x in m["agenda"]["items"]]


async def live(client, w) -> str:
    mt = await start(client, w, attendee_ids=[uid(w, x) for x in ("approver", "commenter",
                                                                  "viewer")])  # fmt: skip
    return mt["id"]


async def test_owner_adds_renames_moves_removes_and_undoes(client):
    w = await world()
    mid = await live(client, w)
    m = await get(client, w, mid, "owner")
    assert m["can"]["edit_agenda"] is True and m["can"]["propose_agenda"] is False
    first = titles(m)
    assert "Cut A" in first and m["agenda"]["items"][0]["state"] == "now"
    assert all(x["kind"] == "feature" for x in m["agenda"]["items"])

    r = await op(client, w, "owner", mid, op="add", title="Beta date sign-off", batch="b1")
    assert r.status_code == 200, r.text
    rows = r.json()["agenda"]["items"]
    assert rows[-1]["title"] == "Beta date sign-off" and rows[-1]["kind"] == "topic"
    assert rows[-1]["mins"] == 5 and rows[-1]["by_name"]
    topic = rows[-1]["id"]

    feat = r.json()["agenda"]["addable"]
    if feat:
        r = await op(client, w, "owner", mid, op="add", feature_id=feat[0]["id"], batch="b1")
        assert r.status_code == 200, r.text
        assert r.json()["agenda"]["items"][-1]["kind"] == "feature"

    r = await op(client, w, "owner", mid, op="rename", item_id=topic, title="Beta sign-off",
                 batch="b1")  # fmt: skip
    assert r.status_code == 200, r.text
    assert "Beta sign-off" in titles(r.json())

    at = titles(r.json()).index("Beta sign-off")
    r = await op(client, w, "owner", mid, op="move", item_id=topic, to=1, batch="b1")
    assert r.status_code == 200, r.text
    assert titles(r.json())[1] == "Beta sign-off" and at != 1

    # The current item is fixed: it neither moves nor goes.
    now = r.json()["agenda"]["items"][0]["id"]
    assert (await op(client, w, "owner", mid, op="remove", item_id=now)).status_code == 409
    assert (await op(client, w, "owner", mid, op="move", item_id=now, to=2)).status_code == 409

    r = await op(client, w, "owner", mid, op="remove", item_id=topic, batch="b1")
    assert r.status_code == 200, r.text
    assert "Beta sign-off" not in titles(r.json())
    assert r.json()["agenda"]["words"][-1] == "removed Beta sign-off"

    r = await op(client, w, "owner", mid, op="undo", batch="b1")
    assert r.status_code == 200, r.text
    assert titles(r.json()) == first
    assert titles(await get(client, w, mid, "viewer")) == first


async def test_approver_not_decider_proposes(client):
    w = await world()
    mid = await live(client, w)
    m = await get(client, w, mid, "approver")
    assert m["can"]["edit_agenda"] is False and m["can"]["propose_agenda"] is True
    first = titles(m)
    r = await op(client, w, "approver", mid, op="add", title="Pricing page copy", batch="p1")
    assert r.status_code == 200, r.text
    out = r.json()["agenda"]
    assert titles(r.json()) == first
    assert out["proposal"]["decider"]["name"] == w.ctx.users["decider"].name
    assert out["proposal"]["words"] == ["added Pricing page copy"]

    d = await get(client, w, mid, "decider")
    assert d["can"]["edit_agenda"] is True
    r = await op(client, w, "decider", mid, op="accept")
    assert r.status_code == 200, r.text
    assert titles(r.json()) == [*first, "Pricing page copy"]
    assert r.json()["agenda"]["proposal"] is None

    r = await op(client, w, "approver", mid, op="add", title="Help text", batch="p2")
    assert r.json()["agenda"]["proposal"] is not None
    r = await op(client, w, "approver", mid, op="withdraw")
    assert r.status_code == 200, r.text
    assert r.json()["agenda"]["proposal"] is None
    assert "Help text" not in titles(r.json())


async def test_viewer_is_refused(client):
    w = await world()
    mid = await live(client, w)
    m = await get(client, w, mid, "viewer")
    assert m["can"]["edit_agenda"] is False and m["can"]["propose_agenda"] is False
    assert len(m["agenda"]["items"]) >= 1
    r = await op(client, w, "viewer", mid, op="add", title="Viewer topic")
    assert r.status_code == 403
    r = await op(client, w, "commenter", mid, op="add", title="Commenter topic")
    assert r.status_code == 403
    assert "Viewer topic" not in titles(await get(client, w, mid))


async def test_chat_next_and_skip_still_work(client):
    w = await world()
    mid = await live(client, w)
    r = await op(client, w, "decider", mid, op="add", title="Launch email", batch="c1")
    assert r.status_code == 200, r.text

    nxt = await one_card(client, w, "commenter", "next: Cut A", mid)
    assert (await apply(client, w, "commenter", nxt["id"])).status_code == 200
    m = await get(client, w, mid)
    assert m["agenda"]["next"]["title"] == "Cut A"
    assert "Launch email" in titles(m)

    skip = await one_card(client, w, "commenter", "skip Cut A", mid)
    assert (await apply(client, w, "commenter", skip["id"])).status_code == 200
    m = await get(client, w, mid)
    row = next(x for x in m["agenda"]["items"] if x["title"] == "Cut A")
    assert row["state"] == "skipped"
    assert [x["title"] for x in m["agenda"]["skipped"]] == ["Cut A"]
    assert m["agenda"]["items"][0]["state"] in ("now", "skipped")
