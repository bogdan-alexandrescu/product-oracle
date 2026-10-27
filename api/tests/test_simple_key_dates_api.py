"""Simple roadmap-plus (#723): a roadmap's key dates through the change engine
(``add_key_date`` / ``edit_key_date`` / ``remove_key_date``, oracle.simple.key_dates), into
the roadmap's one shared working draft; and the waterfall's drag (``move_dates`` on a
phased item: the estimated phases are worked out again, dated gates stay). Against
Postgres. The world, people and clock: tests.test_simple_changes_api (one roadmap
``payments``; Dee Cider its decider when ``decider``). Each test's card is its docstring
(protects / fails_when / no_claim).
"""

import uuid
from datetime import date
from typing import Any

import pytest
from sqlalchemy import select

from oracle.roadmap.models import RoadmapItem
from oracle.simple.models import RoadmapKeyDate, SimpleDraft
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import CHANGES, World, make_people
from tests.test_simple_changes_api import clock as clock  # noqa: F401

ROADMAP = "/v1/simple/roadmap"
DRAFTS = "/v1/simple/drafts"
LAUNCH = {"name": "Spring launch", "date": "2026-12-01", "note": "Press day"}
ROLES = ["owner", "decider", "approver", "commenter", "viewer"]


async def world(decider: bool = True, track_owner: str | None = None) -> World:
    return await World(await make_people()).build(
        decider=decider, track_owner=track_owner, ops=["move_dates"]
    )


async def published_key_date(w: World, name: str = "Board meeting", day=date(2026, 11, 20)):
    async with tenant_session(w.ctx.tenant_id) as s:
        row = RoadmapKeyDate(roadmap_document_id=uuid.UUID(w.roadmap_id), name=name,
                             on_date=day, created_by=w.ctx.users["owner"].id)  # fmt: skip
        s.add(row)
        await s.commit()
        return str(row.id)


async def post(client, w: World, who: str, op: str, before: Any, after: Any = None, **target):
    body = {"op": op, "target": {"document_id": w.roadmap_id, **target},
            "before": {"key_date": before}, "after": after or {}}  # fmt: skip
    return await client.post(CHANGES, json=body, headers=w.ctx.as_(who))


async def key_dates(client, w: World, who: str) -> list[dict]:
    r = await client.get(ROADMAP, headers=w.ctx.as_(who))
    assert r.status_code == 200, r.text
    return r.json()["key_dates"]


def names(kds: list[dict]) -> list[str]:
    return [k["name"] for k in kds]


@pytest.mark.parametrize("with_decider", [True, False], ids=["decider", "no-decider"])
@pytest.mark.parametrize("role", ROLES)
async def test_permission_matrix_per_op(client, role, with_decider):
    """protects=each key-date op applies for an owner and the roadmap's decider (into the
    working draft, never the published rows), is a proposal routed to the decider (with none,
    the company's owners) for approvers and commenters, and is refused for viewers;
    fails_when=a role applies what it may only propose, a proposal writes anything, or a
    viewer gets through; no_claim=the web's editor."""
    w = await world(decider=with_decider)
    kd = await published_key_date(w)
    seen = {"name": "Board meeting", "date": "2026-11-20", "note": None}
    applies = role == "owner" or (role == "decider" and with_decider)
    routed = [str(w.ctx.users["decider" if with_decider else "owner"].id)]
    cases = [
        ("add_key_date", None, LAUNCH, {}),
        ("edit_key_date", seen, {"date": "2026-11-27"}, {"key_date_id": kd}),
        ("remove_key_date", seen, None, {"key_date_id": kd}),
    ]
    for op, before, after, target in cases:
        r = await post(client, w, role, op, before, after, **target)
        if role == "viewer":
            assert r.status_code == 403, (op, r.text)
            continue
        assert r.status_code == 201, (op, r.text)
        c = r.json()["change"]
        assert (c["op"], c["document_id"]) == (op, w.roadmap_id)
        assert c["status"] == ("applied" if applies else "proposed"), op
        if applies:
            assert len(c["draft_ids"]) == 1 and c["can_undo"], op
            if op == "edit_key_date":
                # Undo the edit so the remove sees the published value.
                u = await client.post(f"{CHANGES}/{c['id']}/undo", headers=w.ctx.as_(role))
                assert u.status_code == 201, u.text
        else:
            assert c["routed_to"] == routed and c["draft_ids"] == [], op
    async with tenant_session(w.ctx.tenant_id) as s:
        rows = list(await s.scalars(select(RoadmapKeyDate)))
        assert [(r.name, r.on_date) for r in rows] == [("Board meeting", date(2026, 11, 20))]
        d = await s.scalar(select(SimpleDraft))
        assert (d is not None) is applies
    if applies:
        # The draft has the launch and no board meeting; readers of the published version
        # still see the board meeting.
        assert names(await key_dates(client, w, role)) == ["Spring launch"]
        assert names(await key_dates(client, w, "viewer")) == ["Board meeting"]


async def test_track_owner_decides_only_as_approver(client):
    """protects=D-a for key dates: with no decider, the roadmap's owner (its track owner)
    applies while an approver, and only proposes as a commenter; fails_when=a commenter who
    owns a track applies; no_claim=routing of item changes (tests.test_simple_changes_api)."""
    w = await world(decider=False, track_owner="approver")
    r = await post(client, w, "approver", "add_key_date", None, LAUNCH)
    assert r.status_code == 201 and r.json()["change"]["status"] == "applied", r.text
    w2 = await world(decider=False, track_owner="commenter")
    r = await post(client, w2, "commenter", "add_key_date", None, LAUNCH)
    assert r.status_code == 201 and r.json()["change"]["status"] == "proposed", r.text
    assert r.json()["change"]["routed_to"] == [str(w2.ctx.users["owner"].id)]


async def test_undo_step_by_step_and_stale_before(client):
    """protects=undo reverses one key-date change at a time inside the working draft (add,
    then edit), and a change whose before is stale is 409 with the current value;
    fails_when=undo skips a step, leaves the draft wrong, or a stale edit applies;
    no_claim=undo after the draft is submitted (the drafts' own tests)."""
    w = await world()
    add = (await post(client, w, "decider", "add_key_date", None, LAUNCH)).json()["change"]
    kd = add["target"]["key_date_id"]
    seen = {**LAUNCH}
    edit = await post(client, w, "decider", "edit_key_date", seen, {"name": "Launch day"},
                      key_date_id=kd)  # fmt: skip
    assert edit.status_code == 201, edit.text
    stale = await post(client, w, "decider", "edit_key_date", seen, {"note": "x"}, key_date_id=kd)
    assert stale.status_code == 409, stale.text
    assert stale.json()["detail"]["current"]["key_date"]["name"] == "Launch day"
    assert names(await key_dates(client, w, "decider")) == ["Launch day"]
    u = await client.post(f"{CHANGES}/{edit.json()['change']['id']}/undo",
                          headers=w.ctx.as_("decider"))  # fmt: skip
    assert u.status_code == 201, u.text
    assert names(await key_dates(client, w, "decider")) == ["Spring launch"]
    u = await client.post(f"{CHANGES}/{add['id']}/undo", headers=w.ctx.as_("decider"))
    assert u.status_code == 201, u.text
    assert await key_dates(client, w, "decider") == []
    # Someone else's change is not theirs to undo.
    again = (await post(client, w, "decider", "add_key_date", None, LAUNCH)).json()["change"]
    r = await client.post(f"{CHANGES}/{again['id']}/undo", headers=w.ctx.as_("owner"))
    assert r.status_code == 403, r.text


async def test_proposal_accept_decline_and_outdated(client):
    """protects=a commenter's proposal writes nothing until the decider accepts it (into the
    working draft), a declined one writes nothing, and accepting one whose key date changed
    since is 409 outdated; a commenter may not decide; fails_when=a proposal applies on its
    own, a decline writes, or an outdated proposal applies; no_claim=the Inbox's wording."""
    w = await world()
    kd = await published_key_date(w)
    seen = {"name": "Board meeting", "date": "2026-11-20", "note": None}
    p1 = (await post(client, w, "commenter", "add_key_date", None, LAUNCH)).json()["change"]
    p2 = (await post(client, w, "approver", "edit_key_date", seen, {"date": "2026-11-25"},
                     key_date_id=kd)).json()["change"]  # fmt: skip
    p3 = (await post(client, w, "commenter", "remove_key_date", seen,
                     key_date_id=kd)).json()["change"]  # fmt: skip
    assert names(await key_dates(client, w, "decider")) == ["Board meeting"]
    r = await client.post(f"{CHANGES}/{p1['id']}/accept", headers=w.ctx.as_("commenter"))
    assert r.status_code == 403, r.text
    r = await client.post(f"{CHANGES}/{p1['id']}/accept", headers=w.ctx.as_("decider"))
    assert r.status_code == 200 and r.json()["change"]["status"] == "accepted", r.text
    assert len(r.json()["change"]["draft_ids"]) == 1
    r = await client.post(f"{CHANGES}/{p2['id']}/accept", headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    # The board meeting moved since the remove was proposed.
    r = await client.post(f"{CHANGES}/{p3['id']}/accept", headers=w.ctx.as_("decider"))
    assert r.status_code == 409 and "outdated" in r.text, r.text
    r = await client.post(f"{CHANGES}/{p3['id']}/decline", headers=w.ctx.as_("decider"))
    assert r.status_code == 200 and r.json()["change"]["status"] == "declined", r.text
    kds = await key_dates(client, w, "decider")
    assert [(k["name"], k["date"], k["in_draft"]) for k in kds] == [
        ("Board meeting", "2026-11-25", True),
        ("Spring launch", "2026-12-01", True),
    ]
    inbox = await client.get("/v1/inbox", headers=w.ctx.as_("decider"))
    assert inbox.status_code == 200, inbox.text


async def test_draft_publishes_key_dates_on_approval(client):
    """protects=key dates wait in the roadmap's working draft (readers who may not see it get
    the published ones) and become published rows when the draft is submitted and approved;
    the roadmap read names which roadmaps the reader may change (applies vs proposes);
    fails_when=a draft's key date leaks to a viewer, or approval does not publish it;
    no_claim=review policies with required reviewers (the drafts' own tests)."""
    w = await world()
    kd = await published_key_date(w)
    seen = {"name": "Board meeting", "date": "2026-11-20", "note": None}
    assert (await post(client, w, "decider", "add_key_date", None, LAUNCH)).status_code == 201
    assert (await post(client, w, "decider", "remove_key_date", seen,
                       key_date_id=kd)).status_code == 201  # fmt: skip
    assert names(await key_dates(client, w, "viewer")) == ["Board meeting"]
    out = (await client.get(ROADMAP, headers=w.ctx.as_("decider"))).json()
    assert [(r["applies"], r["can_change"]) for r in out["key_date_roadmaps"]] == [(True, True)]
    out = (await client.get(ROADMAP, headers=w.ctx.as_("commenter"))).json()
    assert [(r["applies"], r["can_change"]) for r in out["key_date_roadmaps"]] == [(False, True)]
    out = (await client.get(ROADMAP, headers=w.ctx.as_("viewer"))).json()
    assert [(r["applies"], r["can_change"]) for r in out["key_date_roadmaps"]] == [(False, False)]
    [d] = (await client.get(DRAFTS, headers=w.ctx.as_("decider"))).json()
    assert d["changes"] == 2
    r = await client.post(f"{DRAFTS}/{d['id']}/submit", headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    r = await client.post(f"{DRAFTS}/{d['id']}/approve", headers=w.ctx.as_("decider"))
    assert r.status_code == 200 and r.json()["status"] == "approved", r.text
    kds = await key_dates(client, w, "viewer")
    assert [(k["name"], k["date"], k["note"], k["in_draft"]) for k in kds] == [
        ("Spring launch", "2026-12-01", "Press day", False)
    ]
    async with tenant_session(w.ctx.tenant_id) as s:
        assert [r.name for r in await s.scalars(select(RoadmapKeyDate))] == ["Spring launch"]


async def test_malformed_and_unknown(client):
    """protects=a key date needs a name and a day (422), an edit or remove names one of the
    roadmap's key dates (404), and the roadmap must be one the caller reads (404);
    fails_when=a nameless or dateless key date is stored; no_claim=the web's validation."""
    w = await world()
    r = await post(client, w, "decider", "add_key_date", None, {"name": "", "date": "2026-12-01"})
    assert r.status_code == 422, r.text
    r = await post(client, w, "decider", "add_key_date", None, {"name": "X", "date": "soon"})
    assert r.status_code == 422, r.text
    r = await post(client, w, "decider", "remove_key_date", LAUNCH, key_date_id=str(uuid.uuid4()))
    assert r.status_code == 404, r.text
    body = {"op": "add_key_date", "target": {"document_id": str(uuid.uuid4())},
            "before": {"key_date": None}, "after": LAUNCH}  # fmt: skip
    r = await client.post(CHANGES, json=body, headers=w.ctx.as_("decider"))
    assert r.status_code == 404, r.text


async def test_waterfall_move_reworks_estimated_phases_and_keeps_gates(client):
    """protects=the waterfall's drag: move_dates on a phased item moves the whole item; its
    estimated phases are worked out again over the new span while a phase a dated validation
    gate ends stays on the gate's day; fails_when=the gate's phase moves with the bar, or
    the estimated phases keep the old span; no_claim=how the web draws a bunched phase."""
    w = await world()
    async with tenant_session(w.ctx.tenant_id) as s:
        row = await s.get(RoadmapItem, w.ids["move_dates-a"])
        row.validation_gates = [{"phase": "beta", "date": "2026-11-05"}]
        await s.commit()
    r = await w.post(client, "decider", "move_dates")  # Oct 5 - Nov 20
    assert r.status_code == 201 and r.json()["change"]["status"] == "applied", r.text
    out = (await client.get(ROADMAP, headers=w.ctx.as_("decider"))).json()
    item = next(i for i in out["items"] if i["key"] == "move_dates-a")
    assert (item["start"]["date"], item["end"]["date"]) == ("2026-10-05", "2026-11-20")
    ph = {p["key"]: p for p in item["phases"]}
    assert ph["discover"]["start"] == "2026-10-05" and ph["discover"]["estimated"]
    assert ph["beta"]["end"] == "2026-11-05" and not ph["beta"]["estimated"]
    assert ph["launch"]["end"] == "2026-11-20" and ph["launch"]["estimated"]
