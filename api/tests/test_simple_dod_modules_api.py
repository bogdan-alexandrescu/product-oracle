"""Simple Definition of Done, item 5 (docs/simple-dod-ops.md): the ops the change engine
hands to its op modules (oracle.simple.targets, oracle.simple.key_dates), and every
Simple write route. Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_target_ops_record_who_and_when: protects=every non-versioned target op (priority
  override, item tasks, action items, launch tasks), applied by an owner or proposed by
  a commenter, is a change row naming its author and the company's now; fails_when=an op
  writes without that record; no_claim=the targets' own rules (test_simple_targets_api).
- test_target_ops_stay_in_their_company: protects=another company's owner cannot change
  this company's items, tasks, action items or launch tasks through any target op;
  fails_when=one lands; no_claim=the web.
- test_key_date_ops_record_who_and_when_and_stay_in_their_company: protects=each key-date
  op is a change row with its author and now; another company's owner cannot add, edit
  or remove this company's roadmap's key dates; fails_when=either way; no_claim=the
  key dates' draft rules (test_simple_key_dates_api).
- test_draft_item_ops_roles_record_and_undo: protects=add_item, keep_both, confirm_item
  and merge_item on a draft item: owner and decider apply, the approver who reviews the
  draft proposes (nothing written), a commenter does not see the draft's item, a viewer is
  refused; each is a change row with its author and now; an undo of keep_both,
  confirm_item and merge_item puts back every stored column of every item it touched;
  fails_when=any of these; no_claim=the drafting job's text.
- test_a_viewer_attendee_is_refused_every_meeting_write: protects=a viewer invited to a
  live review meeting is refused joining as a changer, its rules, comments, approval, chat
  mode, ending it and its minutes (edit, redraft, send), and the meeting is as it was;
  fails_when=one lets a viewer in; no_claim=reading the meeting (viewers read).
- test_every_simple_write_refuses_a_run: protects=every write route under /v1/simple
  refuses a call made for a run (people only act in Simple), before reading its body;
  fails_when=a route lets a run in (a new route without the people-only guard);
  no_claim=reads, which are refused the same way by shared code.
"""

import re
import uuid
from datetime import datetime

import pytest
from sqlalchemy import select

from oracle.roadmap.models import RoadmapItem
from oracle.simple import drafts
from oracle.simple.models import RoadmapKeyDate, SimpleChange
from oracle.tenancy import tenant_session
from tests.coverage_helpers import run_headers
from tests.test_promote_csrf import _routes
from tests.test_simple_additions_api import World as AddWorld
from tests.test_simple_changes_api import CHANGES, make_people
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_dod_changes_api import columns
from tests.test_simple_key_dates_api import LAUNCH, published_key_date
from tests.test_simple_key_dates_api import post as post_key_date
from tests.test_simple_key_dates_api import world as key_date_world
from tests.test_simple_roadmap_api import NOW
from tests.test_simple_targets_api import OPS as TARGET_OPS
from tests.test_simple_targets_api import World as TargetWorld
from tests.test_simple_targets_api import no_llm as no_llm  # noqa: F401


async def recorded(ctx, change: dict, who: str, op: str) -> None:
    assert change["by"] == str(ctx.users[who].id), op
    assert datetime.fromisoformat(change["at"]) == NOW, op
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(SimpleChange, change["id"])
        assert (row.op, row.by, row.at) == (op, ctx.users[who].id, NOW), op


@pytest.mark.parametrize("who", ["owner", "commenter"])
async def test_target_ops_record_who_and_when(client, who):
    w = await TargetWorld(await make_people()).build()
    for op in TARGET_OPS:
        r = await w.post(client, who, op)
        assert r.status_code == 201, (op, r.text)
        change = r.json()["change"]
        assert change["status"] == ("applied" if who == "owner" else "proposed"), op
        await recorded(w.ctx, change, who, op)


async def test_target_ops_stay_in_their_company(client):
    w = await TargetWorld(await make_people()).build()
    other = await make_people()
    for op in TARGET_OPS:
        r = await client.post(CHANGES, json=w.body(op), headers=other.as_("owner"))
        assert r.status_code in (404, 422), (op, r.text)
        assert not await w.changed(op), op
    async with tenant_session(w.ctx.tenant_id) as s:
        assert list(await s.scalars(select(SimpleChange))) == []


async def test_key_date_ops_record_who_and_when_and_stay_in_their_company(client):
    w = await key_date_world()
    other = await make_people()
    kd = await published_key_date(w)
    seen = {"name": "Board meeting", "date": "2026-11-20", "note": None}
    # Another company's owner: refused on this company's roadmap.
    for op, before, after, target in (
        ("add_key_date", None, LAUNCH, {}),
        ("edit_key_date", seen, {"name": "Moved"}, {"key_date_id": kd}),
        ("remove_key_date", seen, None, {"key_date_id": kd}),
    ):
        body = {"op": op, "target": {"document_id": w.roadmap_id, **target},
                "before": {"key_date": before}, "after": after or {}}  # fmt: skip
        r = await client.post(CHANGES, json=body, headers=other.as_("owner"))
        assert r.status_code in (404, 422), (op, r.text)
    async with tenant_session(w.ctx.tenant_id) as s:
        assert [k.name for k in await s.scalars(select(RoadmapKeyDate))] == ["Board meeting"]
        assert list(await s.scalars(select(SimpleChange))) == []
    # This company's owner: each op recorded with who and when.
    r = await post_key_date(client, w, "owner", "add_key_date", None, LAUNCH)
    assert r.status_code == 201, r.text
    await recorded(w.ctx, r.json()["change"], "owner", "add_key_date")
    r = await post_key_date(client, w, "commenter", "edit_key_date", seen, {"name": "Moved"},
                            key_date_id=kd)  # fmt: skip
    assert r.status_code == 201, r.text
    assert r.json()["change"]["status"] == "proposed"
    await recorded(w.ctx, r.json()["change"], "commenter", "edit_key_date")
    r = await post_key_date(client, w, "owner", "remove_key_date", seen, key_date_id=kd)
    assert r.status_code == 201, r.text
    await recorded(w.ctx, r.json()["change"], "owner", "remove_key_date")


def _simple_writes():
    from oracle.main import app

    for route in _routes(app.routes):
        methods = getattr(route, "methods", None) or set()
        if not route.path.startswith("/v1/simple"):
            continue
        for method in sorted(methods - {"GET", "HEAD", "OPTIONS"}):
            yield method, re.sub(r"\{[^}]+\}", str(uuid.UUID(int=1)), route.path)


async def test_every_simple_write_refuses_a_run(client):
    ctx = await make_people()
    run = await run_headers(ctx, "owner")
    writes = list(_simple_writes())
    assert len(writes) >= 40, writes
    for method, path in writes:
        r = await client.request(method, path, json={}, headers=run)
        assert r.status_code == 403, (method, path, r.text)
    async with tenant_session(ctx.tenant_id) as s:
        assert list(await s.scalars(select(SimpleChange))) == []


async def rows(ctx, ids: list[str]) -> dict[str, dict]:
    async with tenant_session(ctx.tenant_id) as s:
        return {
            i: columns(await drafts.effective_row(s, await s.get(RoadmapItem, uuid.UUID(i))))
            for i in ids
        }


async def test_draft_item_ops_roles_record_and_undo(client):
    w = await AddWorld().build()
    for op in ("keep_both", "confirm_item", "merge_item"):
        c = (await w.add(client, "owner", f"Draft for {op}"))["change"]
        await recorded(w.ctx, c, "owner", "add_item")
        draft = c["target"]["item_id"]
        body = {
            "keep_both": {"target": {"item_id": draft}, "before": {"kept_both": False},
                          "after": {"kept_both": True}},
            "confirm_item": {"target": {"item_id": draft}, "before": {"draft": True},
                             "after": {"draft": False}},
            "merge_item": {"target": {"item_id": draft, "into_id": w.ids["import-a"]},
                           "before": {}, "after": {}},
        }[op]  # fmt: skip
        body = {"op": op, **body}
        touched = [draft, w.ids["import-a"], w.ids["import-b"]]
        seen = await rows(w.ctx, touched)
        r = await client.post(CHANGES, json=body, headers=w.as_("viewer"))
        assert r.status_code == 403, (op, r.text)
        # A commenter does not see the working draft's new item (it is not theirs to see).
        r = await client.post(CHANGES, json=body, headers=w.as_("commenter"))
        assert r.status_code == 404, (op, r.text)
        for who in ("approver",):
            r = await client.post(CHANGES, json=body, headers=w.as_(who))
            assert r.status_code == 201, (op, who, r.text)
            assert r.json()["change"]["status"] == "proposed", (op, who)
            await recorded(w.ctx, r.json()["change"], who, op)
        assert await rows(w.ctx, touched) == seen, op
        r = await client.post(CHANGES, json=body, headers=w.as_("decider"))
        assert r.status_code == 201, (op, r.text)
        c = r.json()["change"]
        assert c["status"] == "applied", op
        await recorded(w.ctx, c, "decider", op)
        assert await rows(w.ctx, touched) != seen, op
        r = await client.post(f"{CHANGES}/{c['id']}/undo", headers=w.as_("decider"))
        assert r.status_code == 201, (op, r.text)
        assert await rows(w.ctx, touched) == seen, op


async def test_a_viewer_attendee_is_refused_every_meeting_write(client):
    from tests import test_simple_meetings_api as mt

    w = await mt.world()
    m = await mt.start(client, w, attendee_ids=[mt.uid(w, x) for x in ("approver", "viewer")])
    seen = await mt.get(client, w, m["id"])
    url = f"{mt.MEETINGS}/{m['id']}"
    writes = [
        ("POST", f"{url}/join", None),
        ("PATCH", f"{url}/rules", {"change_mode": "presenter"}),
        ("POST", f"{url}/comments", {"text": "Keep the beta"}),
        ("POST", f"{url}/approve", None),
        ("PUT", f"{url}/chat/mode", {"change_mode": "presenter"}),
        ("POST", f"{url}/end", None),
        ("PUT", f"{url}/minutes", {"summary": "Mine"}),
        ("POST", f"{url}/minutes/redraft", None),
        ("POST", f"{url}/send", {"email": True}),
    ]
    for method, path, body in writes:
        r = await client.request(method, path, json=body, headers=w.ctx.as_("viewer"))
        assert r.status_code == 403, (method, path, r.text)
    after = await mt.get(client, w, m["id"])
    for key in ("status", "change_mode", "attendees", "comments", "decisions"):
        assert after.get(key) == seen.get(key), key
