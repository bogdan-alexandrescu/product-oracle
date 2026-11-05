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
- test_two_editors_at_once_keep_every_change: protects=ops sent at the same moment by two
  people all land; fails_when=the meeting row is read before its lock and one op's agenda
  overwrites another's (4 adds, 2 saved).
- test_undo_only_the_last_batch: protects=Undo of a batch someone else edited after is a
  409 and keeps their work; fails_when=Undo restores the latest batch's snapshot whatever
  batch it names.
- test_decider_undoes_what_they_accepted: protects=the accept is the decider's batch, so
  their Undo line shows and Undo puts the agenda back; fails_when=the accept's batch is one
  the decider's sheet never named.
- test_move_and_rename_read_as_one_clause: protects=the done line reads "moved X up and
  renamed it"; fails_when=it reads two clauses about one item.
- test_stale_proposal_op_is_dropped: protects=an approver's later op saves when an item
  their earlier proposal named was removed, and the proposal says what it dropped;
  fails_when=every later op is a 404.
- test_feature_gone_from_the_prd_keeps_its_name: protects=a row whose feature left the PRD
  reads its last known name; fails_when=it reads "Untitled".
- test_other_company_cannot_edit: protects=tenant isolation; fails_when=an owner of another
  company reads or changes this meeting's agenda.
"""

import asyncio

from sqlalchemy import delete, select

from oracle.roadmap.models import RoadmapItem
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_chat_actions import apply, one_card
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
    assert out["decider"]["name"] == w.ctx.users["decider"].name
    assert m["agenda"]["decider"]["name"] == w.ctx.users["decider"].name

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


async def test_two_editors_at_once_keep_every_change(client):
    w = await world()
    mid = await live(client, w)
    first = titles(await get(client, w, mid))
    sent = [("owner", "Owner one", "o1"), ("decider", "Decider one", "d1"),
            ("owner", "Owner two", "o2"), ("decider", "Decider two", "d2")]  # fmt: skip
    rs = await asyncio.gather(
        *(op(client, w, who, mid, op="add", title=t, batch=b) for who, t, b in sent)
    )
    assert all(r.status_code == 200 for r in rs), [r.text for r in rs]
    now = titles(await get(client, w, mid, "viewer"))
    assert sorted(now[len(first) :]) == sorted(t for _, t, _ in sent)


async def test_undo_only_the_last_batch(client):
    w = await world()
    mid = await live(client, w)
    first = titles(await get(client, w, mid))
    r = await op(client, w, "owner", mid, op="add", title="Owner topic", batch="ob")
    assert r.status_code == 200, r.text
    r = await op(client, w, "decider", mid, op="add", title="Decider topic", batch="db")
    assert r.status_code == 200, r.text

    r = await op(client, w, "owner", mid, op="undo", batch="ob")
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == "Someone changed the agenda since"
    assert titles(await get(client, w, mid)) == [*first, "Owner topic", "Decider topic"]

    r = await op(client, w, "decider", mid, op="undo", batch="db")
    assert r.status_code == 200, r.text
    assert titles(r.json()) == [*first, "Owner topic"]


async def test_decider_undoes_what_they_accepted(client):
    w = await world()
    mid = await live(client, w)
    first = titles(await get(client, w, mid))
    r = await op(client, w, "approver", mid, op="add", title="Pricing page copy", batch="p1")
    assert r.status_code == 200, r.text
    r = await op(client, w, "decider", mid, op="accept", batch="acc1")
    assert r.status_code == 200, r.text
    out = r.json()["agenda"]
    assert out["batch"] == "acc1" and out["words"] == ["added Pricing page copy"]
    r = await op(client, w, "decider", mid, op="undo", batch="acc1")
    assert r.status_code == 200, r.text
    assert titles(r.json()) == first


async def test_move_and_rename_read_as_one_clause(client):
    w = await world()
    mid = await live(client, w)
    for t in ("Quiet hours", "Launch email"):
        r = await op(client, w, "owner", mid, op="add", title=t, batch="s0")
        assert r.status_code == 200, r.text
    rows = r.json()["agenda"]["items"]
    quiet = next(x["id"] for x in rows if x["title"] == "Quiet hours")
    r = await op(client, w, "owner", mid, op="move", item_id=quiet, to=1, batch="s1")
    assert r.status_code == 200, r.text
    r = await op(client, w, "owner", mid, op="rename", item_id=quiet, title="Quiet time",
                 batch="s1")  # fmt: skip
    assert r.status_code == 200, r.text
    assert r.json()["agenda"]["words"] == ["moved Quiet hours up and renamed it"]
    r = await op(client, w, "owner", mid, op="add", title="Help text", batch="s1")
    assert r.json()["agenda"]["words"] == ["moved Quiet hours up and renamed it",
                                           "added Help text"]  # fmt: skip


async def test_stale_proposal_op_is_dropped(client):
    w = await world()
    mid = await live(client, w)
    r = await op(client, w, "owner", mid, op="add", title="Quiet hours", batch="o1")
    quiet = r.json()["agenda"]["items"][-1]["id"]
    r = await op(client, w, "approver", mid, op="rename", item_id=quiet, title="Quiet time",
                 batch="p1")  # fmt: skip
    assert r.status_code == 200, r.text
    r = await op(client, w, "owner", mid, op="remove", item_id=quiet, batch="o2")
    assert r.status_code == 200, r.text

    r = await op(client, w, "approver", mid, op="add", title="Help text", batch="p1")
    assert r.status_code == 200, r.text
    prop = r.json()["agenda"]["proposal"]
    assert prop["words"] == ["added Help text"]
    assert prop["dropped"] == ["renamed Quiet hours to Quiet time"]
    r = await op(client, w, "decider", mid, op="accept", batch="a1")
    assert r.status_code == 200, r.text
    assert titles(r.json())[-1] == "Help text"


async def test_feature_gone_from_the_prd_keeps_its_name(client):
    w = await world()
    mid = await live(client, w)
    m = await get(client, w, mid)
    gone = m["agenda"]["items"][-1]
    assert gone["kind"] == "feature"
    r = await op(client, w, "owner", mid, op="add", title="Help text", batch="o1")
    assert r.status_code == 200, r.text
    async with tenant_session(w.ctx.tenant_id) as s:
        key = await s.scalar(select(RoadmapItem.item_key).where(RoadmapItem.id == gone["id"]))
        await s.execute(delete(RoadmapItem).where(RoadmapItem.item_key == key))
        await s.commit()
    row = next(x for x in (await get(client, w, mid))["agenda"]["items"] if x["id"] == gone["id"])
    assert row["title"] == gone["title"]


async def test_other_company_cannot_edit(client):
    w = await world()
    other = await world()
    mid = await live(client, w)
    first = titles(await get(client, w, mid))
    r = await op(client, other, "owner", mid, op="add", title="Not theirs", batch="x1")
    assert r.status_code == 404, r.text
    r = await client.get(f"{MEETINGS}/{mid}", headers=other.ctx.as_("owner"))
    assert r.status_code == 404
    assert titles(await get(client, w, mid)) == first
