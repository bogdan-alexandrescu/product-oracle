"""Simple DoD: the change engine's remaining MISSING cells of docs/simple-dod-ops.md
(``estimate_feature``, ``edit_line``, ``name_decider``, ``add_key_date``,
``override_priority``, ``add_item``/``confirm_item``). Against Postgres, over REST
(``/v1/simple/changes``), as a person of the company would act.

The worlds are the cited tests' own: tests.test_simple_priorities_api (a roadmap with a
decider, Dee Cider, and ranked features), tests.test_simple_one_pager_api (a PRD with a
decider), tests.test_simple_prd_questions (a PRD's open questions, the PRD's decider their
decider), tests.test_simple_key_dates_api (a roadmap with a decider). The company's clock is
fixed (tests.test_simple_changes_api's ``clock``); the reason check never reaches a model
(tests.test_simple_targets_api's ``no_llm``).

Test cards (protects / fails_when / no_claim):

- test_estimate_feature_decider_applies_approver_proposes: protects=the review policy's
  rule for estimate_feature: the roadmap's decider applies directly (the feature's attrs
  change, the change is undoable and its undo restores them) and a plain approver
  proposes (routed to the decider, the attrs untouched) as owners and commenters already
  do; fails_when=the decider only proposes, or an approver's estimate writes the attrs;
  no_claim=versioning (a feature's attrs are a non-versioned target).
- test_estimate_feature_accept_is_outdated_after_a_later_estimate: protects=a proposed
  estimate accepted after the feature's estimate changed since is refused 409 "outdated"
  naming who changed it and the current values, writing nothing (the later estimate
  stays, the proposal stays proposed and may still be declined); fails_when=the accept
  overwrites the later estimate or marks the proposal accepted; no_claim=create-side 409
  (test_simple_priorities_api).
- test_edit_line_plain_approver_proposes_and_multi_step_undo: protects=on a one-pager
  with a decider a plain approver's edit_line is a proposal routed to the decider that
  writes nothing; two edits of one line by the decider undo step by step: undoing the
  latest restores the first edit's text, undoing the earlier one the published text (and
  the earlier undo is refused while the latest is live); fails_when=an approver applies,
  an undo restores the wrong text, or an out-of-order undo lands; no_claim=undo after
  submit (test_simple_one_pager_api).
- test_edit_line_accept_is_outdated_after_the_line_changed: protects=an edit_line
  proposal accepted after the line changed since is refused 409 "outdated" with the line
  as it now reads, writing nothing (the draft keeps the decider's text, the proposal stays
  proposed); fails_when=the accept overwrites the later edit; no_claim=section-only
  changes.
- test_name_decider_role_matrix: protects=name_decider follows the question's review
  rule: an owner and the question's decider apply (the decider changes, undoable), an
  approver and a commenter propose to the question's decider (``routed_to`` and the
  decider's Inbox name them, not the company's owners; nothing changes), a viewer
  is 403 and another company's owner is refused (404/422), each writing nothing;
  fails_when=a proposer or a viewer changes the decider, a proposal is routed to the
  owners instead of the question's decider, or a stranger reaches the question;
  no_claim=an accept-time outdated check (name_decider has none by design).
- test_add_key_date_accept_never_overwrites: protects=an add_key_date proposal names a
  fresh key date id, so it can never be "changed since"; accepted while the roadmap's
  draft is in review it is refused 409 writing nothing; accepted later beside an
  identical key date the decider added directly it adds its own row and never overwrites
  the other; a second accept is 409; fails_when=the accept writes during review,
  replaces the other key date, or applies twice; no_claim=deduplicating same-named key
  dates (the code keeps both).
- test_override_priority_pushback_through_the_engine: protects=override_priority through
  /v1/simple/changes answers Oracle's pushback (a pin of a feature serving no goal above
  ones that do) as 409 with the pushback codes, the reason check and the preview rank,
  writing nothing (no override, no change row); ``after.confirm`` keeps the pin, logged
  as kept after pushback; a commenter's proposal is never pushed back at create, and the
  decider's accept keeps it the same way; fails_when=a pushed-back pin lands unconfirmed,
  a confirmed one is refused, or the change engine drops the pushback detail;
  no_claim=the rules' thresholds (tests/test_priority_overrides.py).
- test_draft_without_owner_through_add_and_confirm: protects=an item added through
  add_item on a roadmap whose track has no owner comes back (in the change's flags and in
  the roadmap read) with ``draft_without_owner``; on a roadmap whose track has an owner
  it does not; confirm_item of the ownerless draft clears the flag in its response and
  read, and the confirm's undo brings it back; fails_when=the flag is missing, shown for
  an owned item, or survives the confirm; no_claim=the checker's own unit test.
"""

import uuid
from datetime import date

from sqlalchemy import func, select

from oracle.decisions.models import Decision
from oracle.priorities.models import PriorityOverride
from oracle.review.models import DocumentReviewPolicy
from oracle.simple.models import RoadmapKeyDate, SimpleChange, SimpleDraft
from oracle.tenancy import tenant_session
from tests import test_simple_key_dates_api as kd_tests
from tests import test_simple_one_pager_api as op_tests
from tests import test_simple_prd_questions as q_tests
from tests.baseline_helpers import make_ctx
from tests.test_simple_changes_api import CHANGES, clock, make_people  # noqa: F401
from tests.test_simple_priorities_api import World as PriWorld
from tests.test_simple_roadmap_api import Seed
from tests.test_simple_targets_api import no_llm  # noqa: F401

ROADMAP = "/v1/simple/roadmap"
DRAFTS = "/v1/simple/drafts"
REASON = "Contoso's renewal hangs on it"


async def count(ctx, model, *where) -> int:
    async with tenant_session(ctx.tenant_id) as s:
        return await s.scalar(select(func.count()).select_from(model).where(*where))


# --------------------------------------------------------------------------- estimate_feature


async def test_estimate_feature_decider_applies_approver_proposes(client):
    ctx = await make_people()
    w = await PriWorld(ctx).build()
    before = {"goal_value": None, "effort": 8}
    r = await w.change(client, "approver", "estimate_feature", "pay-2", before, {"effort": 5})
    assert r.status_code == 201, r.text
    prop = r.json()["change"]
    assert prop["status"] == "proposed" and prop["session_id"] is None
    assert prop["routed_to"] == [str(ctx.users["decider"].id)]
    assert (await w.attrs("sync"))["effort"] == 8
    r = await w.change(client, "decider", "estimate_feature", "pay-2", before,
                       {"goal_value": 3, "effort": 4})  # fmt: skip
    assert r.status_code == 201, r.text
    change = r.json()["change"]
    assert (change["status"], change["can_undo"]) == ("applied", True)
    assert change["by"] == str(ctx.users["decider"].id)
    attrs = await w.attrs("sync")
    assert (attrs["goal_value"], attrs["effort"]) == (3.0, 4.0)
    u = await client.post(f"{CHANGES}/{change['id']}/undo", headers=ctx.as_("decider"))
    assert u.status_code == 201, u.text
    attrs = await w.attrs("sync")
    assert "goal_value" not in attrs and attrs["effort"] == 8


async def test_estimate_feature_accept_is_outdated_after_a_later_estimate(client):
    ctx = await make_people()
    w = await PriWorld(ctx).build()
    before = {"goal_value": None, "effort": 8}
    r = await w.change(client, "commenter", "estimate_feature", "pay-2", before, {"effort": 5})
    assert r.status_code == 201, r.text
    prop = r.json()["change"]
    r = await w.change(client, "owner", "estimate_feature", "pay-2", before, {"effort": 6})
    assert r.status_code == 201, r.text
    accept = f"{CHANGES}/{prop['id']}/accept"
    r = await client.post(accept, json={}, headers=ctx.as_("decider"))
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert detail["message"] == "outdated: changed by owner@example.com"
    # The check reads the fields the proposal writes (effort), as the stored values now.
    assert detail["current"] == {"effort": 6.0}
    assert (await w.attrs("sync"))["effort"] == 6
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(SimpleChange, uuid.UUID(prop["id"]))
        assert (row.status, row.decided_by) == ("proposed", None)
    r = await client.post(f"{CHANGES}/{prop['id']}/decline", json={"reason": "Outdated"},
                          headers=ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 200 and r.json()["change"]["status"] == "declined", r.text
    assert (await w.attrs("sync"))["effort"] == 6


# --------------------------------------------------------------------------- edit_line


async def overlay_line(ctx, line_id: str) -> str | None:
    async with tenant_session(ctx.tenant_id) as s:
        d = await s.scalar(select(SimpleDraft).where(SimpleDraft.status == "working"))
        return ((d.overlay or {}).get("lines") or {}).get(line_id) if d else None


async def test_edit_line_plain_approver_proposes_and_multi_step_undo(client):
    ctx = await op_tests.world(client)
    view = await op_tests.get(client, ctx, "approver")
    old = op_tests.line(view, "bets-1")["text"]
    r = await op_tests.edit(client, ctx, "approver", view, "bets-1", "A checklist for admins")
    assert r.status_code == 201, r.text
    prop = r.json()["change"]
    assert (prop["status"], prop["draft_ids"]) == ("proposed", [])
    assert prop["routed_to"] == [str(ctx.users["decider"].id)]
    assert await count(ctx, SimpleDraft) == 0
    # The decider edits the line twice, then undoes step by step.
    first_text, second_text = "A setup checklist with the next step", "A checklist of three steps"
    r = await op_tests.edit(client, ctx, "decider", view, "bets-1", first_text)
    assert r.status_code == 201, r.text
    first = r.json()["change"]
    mine = await op_tests.get(client, ctx, "decider")
    r = await op_tests.edit(client, ctx, "decider", mine, "bets-1", second_text)
    assert r.status_code == 201, r.text
    second = r.json()["change"]
    assert second["before"]["line"] == first_text
    now = await op_tests.get(client, ctx, "decider")
    assert op_tests.line(now, "bets-1")["text"] == second_text
    # Out of order: the earlier edit's text is no longer the line's.
    r = await client.post(f"{CHANGES}/{first['id']}/undo", headers=ctx.as_("decider"))
    assert r.status_code == 409, r.text
    assert await overlay_line(ctx, "bets-1") == second_text
    r = await client.post(f"{CHANGES}/{second['id']}/undo", headers=ctx.as_("decider"))
    assert r.status_code == 201, r.text
    back = await op_tests.get(client, ctx, "decider")
    assert op_tests.line(back, "bets-1")["text"] == first_text
    assert first_text in r.json()["change"]["after"]["sections"]["build"]["body"]
    r = await client.post(f"{CHANGES}/{first['id']}/undo", headers=ctx.as_("decider"))
    assert r.status_code == 201, r.text
    back = await op_tests.get(client, ctx, "decider")
    # Back to the published text; the approver's proposal still marks the line.
    assert op_tests.line(back, "bets-1")["text"] == old
    assert op_tests.line(back, "bets-1")["state"] == "proposal"
    async with tenant_session(ctx.tenant_id) as s:
        d = await s.scalar(select(SimpleDraft))
        assert "build" not in (d.overlay.get("sections") or {})
    # The approver's proposal still waits, untouched.
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(SimpleChange, uuid.UUID(prop["id"]))).status == "proposed"


async def test_edit_line_accept_is_outdated_after_the_line_changed(client):
    ctx = await op_tests.world(client)
    view = await op_tests.get(client, ctx, "approver")
    r = await op_tests.edit(client, ctx, "approver", view, "bets-1", "A checklist for admins")
    assert r.status_code == 201, r.text
    prop = r.json()["change"]
    later = "A setup checklist the decider wrote"
    r = await op_tests.edit(client, ctx, "decider", await op_tests.get(client, ctx, "decider"),
                            "bets-1", later)  # fmt: skip
    assert r.status_code == 201, r.text
    r = await client.post(f"{CHANGES}/{prop['id']}/accept", json={}, headers=ctx.as_("decider"))
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert detail["message"].startswith("outdated") and detail["current"]["line"] == later
    assert await overlay_line(ctx, "bets-1") == later
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(SimpleChange, uuid.UUID(prop["id"]))
        assert (row.status, row.decided_by, row.draft_ids) == ("proposed", None, [])


# --------------------------------------------------------------------------- name_decider


async def test_name_decider_role_matrix(client):
    ctx = await make_ctx()
    await q_tests.seed(ctx)
    q = next(x for x in (await q_tests.page(client, ctx))["questions"] if x["code"] == "Q3")
    decider = ctx.users["decider"].id

    async def approver_id() -> uuid.UUID:
        async with tenant_session(ctx.tenant_id) as s:
            return (await s.get(Decision, uuid.UUID(q["id"]))).approver_id

    def body(to: str) -> dict:
        return {"op": "name_decider", "target": {"decision_id": q["id"]}, "before": {},
                "after": {"decider_id": str(ctx.users[to].id)}}  # fmt: skip

    assert await approver_id() == decider
    for role in ("approver", "commenter"):
        r = await client.post(CHANGES, json=body("commenter"), headers=ctx.as_(role))
        assert r.status_code == 201, (role, r.text)
        c = r.json()["change"]
        assert (c["status"], c["routed_to"]) == ("proposed", [str(decider)]), role
        assert await approver_id() == decider, role
    # The proposals wait in the question's decider's Inbox, not the company owners'.
    listed = await client.get(CHANGES, params={"status": "proposed"}, headers=ctx.as_("decider"))
    proposals = [c["id"] for c in listed.json()]
    inbox = (await client.get("/v1/inbox", headers=ctx.as_("decider"))).json()
    assert sorted(p["id"] for p in inbox["simple_proposals"]) == sorted(proposals)
    assert len(proposals) == 2
    r = await client.post(CHANGES, json=body("viewer"), headers=ctx.as_("viewer"))
    assert r.status_code == 403, r.text
    other = await make_people()
    r = await client.post(CHANGES, json=body("owner"), headers=other.as_("owner"))
    assert r.status_code in (404, 422), r.text
    assert await approver_id() == decider
    for role, to in (("decider", "approver"), ("owner", "commenter")):
        r = await client.post(CHANGES, json=body(to), headers=ctx.as_(role))
        assert r.status_code == 201, (role, r.text)
        c = r.json()["change"]
        assert (c["status"], c["can_undo"]) == ("applied", True), role
        assert await approver_id() == ctx.users[to].id, role
        u = await client.post(f"{CHANGES}/{c['id']}/undo", headers=ctx.as_(role))
        assert u.status_code in (200, 201), u.text
        assert await approver_id() == decider, role
    # Every proposal still waits; the viewer and the stranger left no row.
    async with tenant_session(ctx.tenant_id) as s:
        rows = list(await s.scalars(select(SimpleChange).where(SimpleChange.op == "name_decider")))
    assert sorted(r.status for r in rows) == [
        "applied", "applied", "proposed", "proposed", "undone", "undone",
    ]  # fmt: skip


# --------------------------------------------------------------------------- add_key_date


async def test_add_key_date_accept_never_overwrites(client):
    w = await kd_tests.world()
    launch = kd_tests.LAUNCH
    r = await kd_tests.post(client, w, "approver", "add_key_date", None, launch)
    assert r.status_code == 201, r.text
    prop = r.json()["change"]
    assert prop["status"] == "proposed"
    # The decider adds the same key date directly and sends the draft to review.
    r = await kd_tests.post(client, w, "decider", "add_key_date", None, launch)
    assert r.status_code == 201, r.text
    own = r.json()["change"]["target"]["key_date_id"]
    assert own != prop["target"]["key_date_id"]
    [d] = (await client.get(DRAFTS, headers=w.ctx.as_("decider"))).json()
    r = await client.post(f"{DRAFTS}/{d['id']}/submit", headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    accept = f"{CHANGES}/{prop['id']}/accept"
    r = await client.post(accept, json={}, headers=w.ctx.as_("decider"))
    assert r.status_code == 409, r.text
    async with tenant_session(w.ctx.tenant_id) as s:
        assert (await s.get(SimpleChange, uuid.UUID(prop["id"]))).status == "proposed"
        [sub] = list(await s.scalars(select(SimpleDraft)))
        assert list(sub.overlay["key_dates"]) == [own]
    r = await client.post(f"{DRAFTS}/{d['id']}/approve", headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    # Accepted now, it adds its own key date beside the published one, never over it.
    r = await client.post(accept, json={}, headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    assert r.json()["change"]["status"] == "accepted"
    kds = await kd_tests.key_dates(client, w, "decider")
    assert sorted(k["id"] for k in kds) == sorted([own, prop["target"]["key_date_id"]])
    assert {(k["name"], k["date"], k["note"]) for k in kds} == {
        (launch["name"], launch["date"], launch["note"])
    }
    async with tenant_session(w.ctx.tenant_id) as s:
        rows = list(await s.scalars(select(RoadmapKeyDate)))
    assert [(str(x.id), x.on_date) for x in rows] == [(own, date(2026, 12, 1))]
    r = await client.post(accept, json={}, headers=w.ctx.as_("decider"))
    assert r.status_code == 409, r.text


# --------------------------------------------------------------------------- override_priority


async def test_override_priority_pushback_through_the_engine(client):
    ctx = await make_people()
    w = await PriWorld(ctx).build()
    pin = {"position": 1, "reason": REASON}
    r = await w.change(client, "decider", "override_priority", "pay-4", {"override": None}, pin)
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert "no_confirmed_goal" in [m["code"] for m in detail["pushback"]]
    assert detail["reason_check"]["status"] == "failed"
    assert detail["preview_rank"] == 1 and detail["hint"].startswith("after.confirm")
    assert await count(ctx, PriorityOverride) == 0
    assert await count(ctx, SimpleChange) == 0
    # A commenter's proposal is not pushed back at create; nothing is pinned.
    r = await w.change(client, "commenter", "override_priority", "pay-4", {"override": None}, pin)
    assert r.status_code == 201, r.text
    prop = r.json()["change"]
    assert prop["status"] == "proposed"
    assert await count(ctx, PriorityOverride) == 0
    # The decider keeps the pin anyway (after.confirm).
    r = await w.change(client, "decider", "override_priority", "pay-4", {"override": None},
                       {**pin, "confirm": True})  # fmt: skip
    assert r.status_code == 201, r.text
    mine = r.json()["change"]
    async with tenant_session(ctx.tenant_id) as s:
        [o] = list(await s.scalars(select(PriorityOverride)))
    assert (o.kept_after_pushback, o.position, o.reason) == (True, 1, REASON)
    assert "no_confirmed_goal" in [m["code"] for m in o.pushback]
    # The proposal is outdated now; undo the pin and accept it: kept as confirmed.
    u = await client.post(f"{CHANGES}/{mine['id']}/undo", headers=ctx.as_("decider"))
    assert u.status_code == 201, u.text
    r = await client.post(f"{CHANGES}/{prop['id']}/accept", json={}, headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    async with tenant_session(ctx.tenant_id) as s:
        [o] = list(await s.scalars(select(PriorityOverride).where(
            PriorityOverride.removed_at.is_(None))))  # fmt: skip
    assert (o.kept_after_pushback, o.position) == (True, 1)
    assert "no_confirmed_goal" in [m["code"] for m in o.pushback]


# --------------------------------------------------------------------------- draft_without_owner


async def test_draft_without_owner_through_add_and_confirm(client):
    ctx = await make_people()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        ids = {}
        for slug, owner in (("payments", None), ("billing", ctx.users["owner"].id)):
            _, pv, rm, rv = await seed.roadmap(slug)
            track = await seed.track(pv, rm, owner_id=owner)
            await seed.item(rv, pv, f"{slug}-1", track_id=track.id)
            s.add(DocumentReviewPolicy(document_id=rm.id, decider_id=ctx.users["decider"].id))
            ids[slug] = str(rm.id)
        await s.commit()

    async def add(slug: str, title: str) -> dict:
        r = await client.post(CHANGES, headers=ctx.as_("owner"), json={
            "op": "add_item", "target": {"roadmap_id": ids[slug],
                                         "where": {"kind": "horizon", "value": "now"}},
            "before": {}, "after": {"title": title}})  # fmt: skip
        assert r.status_code == 201, r.text
        return r.json()

    async def flags_read(item_id: str) -> list[str]:
        r = await client.get(ROADMAP, headers=ctx.as_("owner"))
        assert r.status_code == 200, r.text
        [item] = [i for i in r.json()["items"] if i["id"] == item_id]
        return [f["kind"] for f in item["flags"]]

    def flags_of(out: dict, item_id: str) -> list[str]:
        [f] = [x for x in out["flags"] if x["item_id"] == item_id]
        return [g["kind"] for g in f["flags"]]

    out = await add("payments", "Refund portal")
    item = out["change"]["target"]["item_id"]
    assert flags_of(out, item) == ["draft_without_owner"]
    assert await flags_read(item) == ["draft_without_owner"]
    owned = await add("billing", "Invoice export")
    oid = owned["change"]["target"]["item_id"]
    assert flags_of(owned, oid) == [] and await flags_read(oid) == []
    r = await client.post(CHANGES, headers=ctx.as_("owner"), json={
        "op": "confirm_item", "target": {"item_id": item}, "before": {"draft": True},
        "after": {}})  # fmt: skip
    assert r.status_code == 201, r.text
    confirm = r.json()
    assert confirm["change"]["status"] == "applied"
    assert flags_of(confirm, item) == [] and await flags_read(item) == []
    u = await client.post(f"{CHANGES}/{confirm['change']['id']}/undo", headers=ctx.as_("owner"))
    assert u.status_code == 201, u.text
    assert flags_of(u.json(), item) == ["draft_without_owner"]
    assert await flags_read(item) == ["draft_without_owner"]
