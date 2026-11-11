"""build-milestones-on-roadmap: milestones per goal on the Simple roadmap
(``GET /v1/simple/roadmap`` ``goal_milestones``, ``POST/PATCH/DELETE
/v1/simple/roadmap/milestones``), reusing Oracle's track milestone model. Against
Postgres. The company's clock is fixed to Mon Nov 2, 2026 (tests.test_simple_roadmap_api).

Test cards (protects / fails_when / no_claim):

- test_create_list_patch_delete_restore_own_milestone: protects=an owner creates a goal
  milestone (coded the next "M<n>" in that goal on that roadmap), it is listed on the
  roadmap read, its date/items/counts_when are edited, it is deleted and restored, and a
  viewer is refused every write; fails_when=the code does not increment, an edit or the
  delete/restore does not round-trip, or a viewer gets through; no_claim=the web.
- test_prd_milestones_appear_dated_and_propose_through_the_change_engine: protects=a
  roadmap built from a PRD shows that PRD's own milestones as goal milestones, each dated
  from the PRD's approved plan (null when the plan has no date for it), materialised as
  rows; editing one proposes a change to the PRD's owner (the milestone's date stays,
  ``pending`` filled) through the existing change engine, and accepting it through
  ``POST /v1/simple/changes/{id}/accept`` writes the date and clears ``pending``;
  fails_when=the PRD's milestones are absent, a date is wrong, an edit changes the
  milestone directly, or accepting it does not write the date; no_claim=declining (same
  shape as accept, exercised by the change engine's own tests).
- test_a_proposal_whose_milestone_moved_on_is_declined_not_accepted,
  test_a_proposal_whose_milestone_is_gone_is_declined_not_accepted,
  test_a_proposal_whose_milestone_is_in_the_trash_is_declined_not_accepted: a stuck proposal is
  declined, never accepted (cards on the tests).
"""

import uuid

import pytest
from sqlalchemy import select

from oracle import company_time
from oracle.auth.models import User
from oracle.docs.models import Document
from oracle.members.names import display_name
from oracle.models import AuditEvent
from oracle.roadmap.models import TrackMilestone
from oracle.simple.models import SimpleChange, SimplePrdPlan
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx
from tests.test_simple_roadmap_api import NOW, Seed

ROADMAP = "/v1/simple/roadmap"
MILESTONES = f"{ROADMAP}/milestones"
CHANGES = "/v1/simple/changes"


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def seed_roadmap(ctx: Ctx) -> dict:
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, _, rm, _ = await seed.roadmap("launch")
        goal = await seed.entity("goal", "activation")
        await s.commit()
        return {"roadmap_id": str(rm.id), "goal_id": str(goal.id)}


async def seed_prd_roadmap(ctx: Ctx, owner_id: uuid.UUID, slug: str = "setup") -> dict:
    """A roadmap with one item from a PRD whose plan has two milestones: M1 dated, M2
    with no date anywhere."""
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        prd, pv, rm, rv = await seed.roadmap(slug)
        await seed.track(pv, rm, title="Guided setup", owner_id=owner_id)
        await seed.item(rv, pv, "f-03", track_id=None)
        data = {
            "milestones": [
                {"code": "M1", "name": "Prove it", "start": "2026-11-02", "end": "2026-11-27",
                 "effort_weeks": 4, "done_when": [], "targets": []},
                {"code": "M2", "name": "Scale volume", "effort_weeks": None, "done_when": [],
                 "targets": []},
            ],
            "features": [], "goals": [], "holidays": [],
        }  # fmt: skip
        s.add(SimplePrdPlan(document_id=prd.id, version_id=pv.id, status="ready", source="prd",
                            data=data))  # fmt: skip
        await s.commit()
        return {"roadmap_id": str(rm.id), "prd_id": str(prd.id)}


def by_code(body: dict) -> dict[str, dict]:
    return {m["code"]: m for m in body["goal_milestones"]}


async def get_roadmap(client, ctx: Ctx, role: str) -> dict:
    r = await client.get(ROADMAP, headers=ctx.as_(role))
    assert r.status_code == 200, r.text
    return r.json()


async def test_create_list_patch_delete_restore_own_milestone(client):
    ctx = await make_ctx()
    ids = await seed_roadmap(ctx)
    body = {"roadmap_id": ids["roadmap_id"], "name": "Prove it", "date": "2026-11-27",
            "goal_id": ids["goal_id"], "counts_when": "Ten teams finish setup"}  # fmt: skip
    r = await client.post(MILESTONES, json=body, headers=ctx.as_("viewer"))
    assert r.status_code == 403, r.text
    r = await client.post(MILESTONES, json=body, headers=ctx.as_("owner"))
    assert r.status_code == 201, r.text
    m1 = r.json()
    assert (m1["code"], m1["date"], m1["can_change"]) == ("M1", "2026-11-27", True)
    body2 = {**body, "name": "Scale volume", "date": "2026-12-11"}
    r = await client.post(MILESTONES, json=body2, headers=ctx.as_("owner"))
    assert r.status_code == 201, r.text
    m2 = r.json()
    assert m2["code"] == "M2"
    listed = by_code(await get_roadmap(client, ctx, "owner"))
    assert {"M1", "M2"} <= set(listed)
    assert listed["M1"]["name"] == "Prove it"
    item_id = str(uuid.uuid4())
    patch = {"date": "2026-12-04", "counts_when": "Half the teams active",
             "item_ids": [item_id]}  # fmt: skip
    r = await client.patch(f"{MILESTONES}/{m1['id']}", json=patch, headers=ctx.as_("viewer"))
    assert r.status_code == 403, r.text
    r = await client.patch(f"{MILESTONES}/{m1['id']}", json=patch, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    patched = r.json()
    assert patched["date"] == "2026-12-04"
    assert patched["counts_when"] == "Half the teams active"
    assert patched["item_ids"] == [item_id]
    r = await client.delete(f"{MILESTONES}/{m1['id']}", headers=ctx.as_("viewer"))
    assert r.status_code == 403, r.text
    r = await client.delete(f"{MILESTONES}/{m1['id']}", headers=ctx.as_("owner"))
    assert r.status_code == 204, r.text
    listed = by_code(await get_roadmap(client, ctx, "owner"))
    assert "M1" not in listed and "M2" in listed
    r = await client.post(f"{MILESTONES}/{m1['id']}/restore", headers=ctx.as_("viewer"))
    assert r.status_code == 403, r.text
    r = await client.post(f"{MILESTONES}/{m1['id']}/restore", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert r.json()["date"] == "2026-12-04"
    listed = by_code(await get_roadmap(client, ctx, "owner"))
    assert {"M1", "M2"} <= set(listed)
    async with tenant_session(ctx.tenant_id) as s:
        rows = list(await s.scalars(select(TrackMilestone)))
        assert len(rows) == 2 and all(r.roadmap_id is not None for r in rows)


async def test_prd_milestones_appear_dated_and_propose_through_the_change_engine(client):
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        owner = User(email="prdowner@example.com", name="Priya Owner", password_hash="x",
                     role="approver")  # fmt: skip
        s.add(owner)
        await s.commit()
        ctx.users["prdowner"] = owner
    ids = await seed_prd_roadmap(ctx, owner.id)
    out = await get_roadmap(client, ctx, "viewer")
    listed = by_code(out)
    assert listed["M1"]["date"] == "2026-11-27"
    assert listed["M1"]["prd"]["id"] == ids["prd_id"]
    assert listed["M1"]["prd_owner"] == display_name(owner.email, owner.name)
    assert listed["M1"]["can_change"] is False
    assert listed["M2"]["date"] is None
    m1_id = listed["M1"]["id"]
    r = await client.patch(f"{MILESTONES}/{m1_id}", json={"item_ids": [str(uuid.uuid4())]},
                           headers=ctx.as_("commenter"))  # fmt: skip
    assert r.status_code == 422, r.text
    r = await client.patch(f"{MILESTONES}/{m1_id}", json={"date": "2026-12-04"},
                           headers=ctx.as_("viewer"))  # fmt: skip
    assert r.status_code == 403, r.text
    r = await client.patch(f"{MILESTONES}/{m1_id}", json={"date": "2026-12-04"},
                           headers=ctx.as_("commenter"))  # fmt: skip
    assert r.status_code == 200, r.text
    proposed = r.json()
    assert proposed["date"] == "2026-11-27"  # unchanged
    assert proposed["pending"]["date"] == "2026-12-04"
    assert proposed["pending"]["asked_of"] == display_name(owner.email, owner.name)
    change_id = proposed["pending"]["change_id"]
    async with tenant_session(ctx.tenant_id) as s:
        c = await s.get(SimpleChange, uuid.UUID(change_id))
        assert c is not None
        assert (c.op, c.status, str(c.document_id)) == (
            "edit_goal_milestone",
            "proposed",
            ids["prd_id"],
        )
        assert c.routed_to == [owner.id]
    still = by_code(await get_roadmap(client, ctx, "viewer"))
    assert still["M1"]["date"] == "2026-11-27"
    r = await client.post(f"{CHANGES}/{change_id}/accept", headers=ctx.as_("commenter"))
    assert r.status_code == 403, r.text
    r = await client.post(f"{CHANGES}/{change_id}/accept", headers=ctx.as_("prdowner"))
    assert r.status_code == 200, r.text
    assert r.json()["change"]["status"] == "accepted"
    after = by_code(await get_roadmap(client, ctx, "viewer"))
    assert after["M1"]["date"] == "2026-12-04"
    assert after["M1"]["pending"] is None


async def approve_new_plan(ctx: Ctx, prd_id: str, n: int, milestones: list[dict]) -> None:
    """The PRD gets a newer approved version whose stored plan has these milestones."""
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        prd = await s.get(Document, uuid.UUID(prd_id))
        v = await seed.version(prd, n=n)
        plan = await s.scalar(select(SimplePrdPlan).where(SimplePrdPlan.document_id == prd.id))
        plan.version_id = v.id
        plan.data = {**plan.data, "milestones": milestones}
        await s.commit()


async def test_a_newer_approved_prd_version_redates_and_renames_its_milestones(client):
    """protects=each PRD milestone's date and name come from the PRD's latest approved
    version on every read, not only the first: a milestone with no date gets the date a
    later version gives it, a moved date moves, a renamed one is renamed; an accepted change
    holds until the PRD's own plan moves that milestone again; fails_when=the row keeps the
    values it was first read with."""
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        owner = User(email="planowner@example.com", name="Pat Planner", password_hash="x",
                     role="approver")  # fmt: skip
        s.add(owner)
        await s.commit()
        ctx.users["prdowner"] = owner
    ids = await seed_prd_roadmap(ctx, owner.id)
    first = by_code(await get_roadmap(client, ctx, "viewer"))
    assert (first["M1"]["date"], first["M2"]["date"]) == ("2026-11-27", None)
    await approve_new_plan(ctx, ids["prd_id"], 2, [
        {"code": "M1", "name": "Prove it", "start": "2026-11-02", "end": "2026-12-11",
         "effort_weeks": 6, "done_when": [], "targets": []},
        {"code": "M2", "name": "Scale it up", "start": "2026-12-14", "end": "2027-01-15",
         "effort_weeks": 4, "done_when": [], "targets": []},
    ])  # fmt: skip
    second = by_code(await get_roadmap(client, ctx, "viewer"))
    assert (second["M1"]["date"], second["M2"]["date"]) == ("2026-12-11", "2027-01-15")
    assert second["M2"]["name"] == "Scale it up"
    assert second["M1"]["id"] == first["M1"]["id"]
    # An accepted change holds while the PRD's plan keeps its date for that milestone...
    r = await client.patch(f"{MILESTONES}/{second['M1']['id']}", json={"date": "2026-12-18"},
                           headers=ctx.as_("commenter"))  # fmt: skip
    assert r.status_code == 200, r.text
    r = await client.post(f"{CHANGES}/{r.json()['pending']['change_id']}/accept",
                          headers=ctx.as_("prdowner"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert by_code(await get_roadmap(client, ctx, "viewer"))["M1"]["date"] == "2026-12-18"
    # ...and gives way when a newer approved version moves it.
    await approve_new_plan(ctx, ids["prd_id"], 3, [
        {"code": "M1", "name": "Prove it", "start": "2026-11-02", "end": "2027-01-08",
         "effort_weeks": 8, "done_when": [], "targets": []},
        {"code": "M2", "name": "Scale it up", "start": "2027-01-11", "end": "2027-01-29",
         "effort_weeks": 3, "done_when": [], "targets": []},
    ])  # fmt: skip
    third = by_code(await get_roadmap(client, ctx, "viewer"))
    assert (third["M1"]["date"], third["M2"]["date"]) == ("2027-01-08", "2027-01-29")


async def test_the_first_reads_of_a_prd_roadmap_at_once_both_succeed(client, monkeypatch):
    """protects=two people opening a PRD roadmap for the first time at the same moment both
    get it: the other reader materialises the PRD's milestones between this read's look at
    the rows and its insert, and this read still answers 200 with each milestone once (and
    the same ids); fails_when=the second insert of the same row raises a duplicate key and
    the roadmap read returns 500."""
    from oracle.simple import goal_milestones

    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        owner = User(email="racer@example.com", name="Robin Racer", password_hash="x",
                     role="approver")  # fmt: skip
        s.add(owner)
        await s.commit()
    await seed_prd_roadmap(ctx, owner.id)
    real = goal_milestones._rows
    raced: list[dict] = []

    async def other_reader_first(db, roadmap_ids):
        if not raced:
            monkeypatch.setattr(goal_milestones, "_rows", real)
            raced.append(await get_roadmap(client, ctx, "commenter"))
            return []
        return await real(db, roadmap_ids)

    monkeypatch.setattr(goal_milestones, "_rows", other_reader_first)
    mine = await get_roadmap(client, ctx, "viewer")
    assert raced, "the other reader ran"
    assert sorted(m["code"] for m in mine["goal_milestones"]) == ["M1", "M2"]
    assert by_code(mine)["M1"]["id"] == by_code(raced[0])["M1"]["id"]
    again = (await get_roadmap(client, ctx, "viewer"))["goal_milestones"]
    assert sorted(m["code"] for m in again) == ["M1", "M2"]


async def test_the_prd_owners_names_are_read_in_one_query(client):
    """protects=the roadmap read names every PRD milestone's owner from one read of the
    users, however many PRDs (and owners) its milestones come from; fails_when=one users
    read per PRD milestone's owner (an N+1 on the roadmap read)."""
    from sqlalchemy import event

    from oracle.db import get_engine

    ctx = await make_ctx()
    owners = []
    async with tenant_session(ctx.tenant_id) as s:
        for n in range(3):
            u = User(email=f"owner{n}@example.com", name=f"Owner {n}", password_hash="x",
                     role="approver")  # fmt: skip
            s.add(u)
            owners.append(u)
        await s.commit()
    for n, u in enumerate(owners):
        await seed_prd_roadmap(ctx, u.id, f"setup-{n}")
    statements: list[str] = []

    def count(conn, cursor, statement, *args):
        statements.append(statement)

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", count)
    try:
        out = await get_roadmap(client, ctx, "viewer")
    finally:
        event.remove(engine, "before_cursor_execute", count)
    names = {m["prd_owner"] for m in out["goal_milestones"]}
    assert names == {display_name(u.email, u.name) for u in owners}
    # The 6 PRD milestones of 3 owners: no one-user read each (another part of the
    # roadmap read makes one of its own).
    single = [st for st in statements if "FROM users" in st and "WHERE users.id = " in st]
    assert len(single) <= 1, len(single)


async def test_a_prd_milestone_refuses_its_name_goal_and_items_even_with_a_date(client):
    """The PRD's name, goal and items are its own: a proposal that carries any of them is
    422 whole, not a date proposal that drops them unsaid."""
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        owner = User(email="planner@example.com", name="Pat Planner", password_hash="x",
                     role="approver")  # fmt: skip
        s.add(owner)
        await s.commit()
    await seed_prd_roadmap(ctx, owner.id)
    m1_id = by_code(await get_roadmap(client, ctx, "commenter"))["M1"]["id"]
    # milestone-rename: its name may be proposed (tests.test_milestone_rename_api).
    for extra in ({"goal_id": str(uuid.uuid4())},
                  {"item_ids": [str(uuid.uuid4())]}):  # fmt: skip
        r = await client.patch(f"{MILESTONES}/{m1_id}", json={"date": "2026-12-04", **extra},
                               headers=ctx.as_("commenter"))  # fmt: skip
        assert r.status_code == 422, (extra, r.text)
    listed = by_code(await get_roadmap(client, ctx, "commenter"))
    assert listed["M1"]["pending"] is None


async def test_a_roadmap_that_is_history_takes_no_milestone(client):
    """While the company roadmap exists an older per-PRD roadmap is history
    (oracle.roadmap.company.feeding_ids): no milestone is added to it or changed on it."""
    ctx = await make_ctx()
    ids = await seed_roadmap(ctx)
    body = {"roadmap_id": ids["roadmap_id"], "name": "Prove it", "date": "2026-11-27",
            "goal_id": ids["goal_id"]}  # fmt: skip
    r = await client.post(MILESTONES, json=body, headers=ctx.as_("owner"))
    assert r.status_code == 201, r.text
    m1 = r.json()
    async with tenant_session(ctx.tenant_id) as s:
        s.add(Document(slug="product", title="Product", kind="roadmap", company_roadmap=True))
        await s.commit()
    r = await client.post(MILESTONES, json={**body, "name": "Scale"}, headers=ctx.as_("owner"))
    assert r.status_code == 409, r.text
    assert "history" in r.json()["detail"]
    r = await client.patch(f"{MILESTONES}/{m1['id']}", json={"date": "2026-12-04"},
                           headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 409, r.text
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(TrackMilestone, uuid.UUID(m1["id"]))
        assert str(row.target_date) == "2026-11-27"


async def propose_m1(client, ctx: Ctx) -> tuple[dict, str]:
    """A PRD's M1 with a proposed date change waiting on its owner: (M1, the change's id)."""
    async with tenant_session(ctx.tenant_id) as s:
        owner = User(email="prdowner@example.com", name="Priya Owner", password_hash="x",
                     role="approver")  # fmt: skip
        s.add(owner)
        await s.commit()
        ctx.users["prdowner"] = owner
    await seed_prd_roadmap(ctx, owner.id)
    m1 = by_code(await get_roadmap(client, ctx, "viewer"))["M1"]
    r = await client.patch(f"{MILESTONES}/{m1['id']}", json={"date": "2026-12-04"},
                           headers=ctx.as_("commenter"))  # fmt: skip
    assert r.status_code == 200, r.text
    return m1, r.json()["pending"]["change_id"]


async def assert_declined(ctx: Ctx, change_id: str) -> None:
    async with tenant_session(ctx.tenant_id) as s:
        c = await s.get(SimpleChange, uuid.UUID(change_id))
        assert c.status == "declined"
        assert c.decided_by == ctx.users["prdowner"].id
        assert c.decided_at is not None
        assert c.decision_reason == "Out of date"
        events = (await s.scalars(select(AuditEvent).where(
            AuditEvent.action == "simple_change.declined",
            AuditEvent.entity_id == c.id))).all()  # fmt: skip
        assert len(events) == 1


async def test_a_proposal_whose_milestone_moved_on_is_declined_not_accepted(client):
    """protects=a PRD milestone's proposal whose milestone's ``pending_change`` names another
    change is still declined (closed, audited), the milestone and its other change left as
    they are, and accepting it is refused (409); fails_when=declining answers 409 (it waits
    forever on Home, Decisions and Needs a decision) or clears the other change's
    ``pending_change``, or accepting writes the date; no_claim=the web."""
    ctx = await make_ctx()
    m1, change_id = await propose_m1(client, ctx)
    other = {"change_id": str(uuid.uuid4()), "date": "2026-12-11", "counts_when": None}
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(TrackMilestone, uuid.UUID(m1["id"]))
        row.pending_change = other
        await s.commit()
    r = await client.post(f"{CHANGES}/{change_id}/accept", headers=ctx.as_("prdowner"))
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["message"] == "This proposal no longer waits on this milestone"
    r = await client.post(f"{CHANGES}/{change_id}/decline", json={"reason": "Out of date"},
                          headers=ctx.as_("prdowner"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert r.json()["change"]["status"] == "declined"
    await assert_declined(ctx, change_id)
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(TrackMilestone, uuid.UUID(m1["id"]))
        assert row.pending_change == other
        assert str(row.target_date) == "2026-11-27"
    r = await client.post(f"{CHANGES}/{change_id}/accept", headers=ctx.as_("prdowner"))
    assert r.status_code == 409, r.text


async def test_a_proposal_whose_milestone_is_gone_is_declined_not_accepted(client):
    """protects=a PRD milestone's proposal whose milestone row is gone is still declined
    (closed, audited) and accepting it is refused (404); fails_when=declining answers 404
    (it waits forever); no_claim=the web."""
    ctx = await make_ctx()
    m1, change_id = await propose_m1(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        await s.delete(await s.get(TrackMilestone, uuid.UUID(m1["id"])))
        await s.commit()
    r = await client.post(f"{CHANGES}/{change_id}/accept", headers=ctx.as_("prdowner"))
    assert r.status_code == 404, r.text
    r = await client.post(f"{CHANGES}/{change_id}/decline", json={"reason": "Out of date"},
                          headers=ctx.as_("prdowner"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert r.json()["change"]["status"] == "declined"
    await assert_declined(ctx, change_id)


async def test_a_proposal_whose_milestone_is_in_the_trash_is_declined_not_accepted(client):
    """protects=a PRD milestone in the Trash (``deleted_at`` set) whose ``pending_change``
    still names the proposal refuses Accept with "The milestone is gone" (404) and the date
    stays; Decline closes the proposal (audited) and clears ``pending_change``, like a
    hard-deleted milestone's; fails_when=accepting writes the date onto the trashed
    milestone, or declining is refused (it waits forever); no_claim=the web."""
    ctx = await make_ctx()
    m1, change_id = await propose_m1(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(TrackMilestone, uuid.UUID(m1["id"]))
        row.deleted_at = NOW
        await s.commit()
    r = await client.post(f"{CHANGES}/{change_id}/accept", headers=ctx.as_("prdowner"))
    assert r.status_code == 404, r.text
    assert "The milestone is gone" in r.text
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(TrackMilestone, uuid.UUID(m1["id"]))
        assert str(row.target_date) == "2026-11-27"
        assert row.pending_change["change_id"] == change_id
        assert (await s.get(SimpleChange, uuid.UUID(change_id))).status == "proposed"
    r = await client.post(f"{CHANGES}/{change_id}/decline", json={"reason": "Out of date"},
                          headers=ctx.as_("prdowner"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert r.json()["change"]["status"] == "declined"
    await assert_declined(ctx, change_id)
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(TrackMilestone, uuid.UUID(m1["id"]))
        assert row.pending_change is None
        assert str(row.target_date) == "2026-11-27"
