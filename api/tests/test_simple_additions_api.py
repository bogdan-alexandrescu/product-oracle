"""Simple S7 (#723, D15): additions and goal suggestions. Against Postgres.

Each test seeds one roadmap through the models and acts as a person would, over REST
(``/v1/simple/changes`` with the ops ``add_item``, ``merge_item`` and ``keep_both``, and
``/v1/simple/goal-suggestions``). Oracle's jobs run with fakes of ``ask``, never a model.

Test cards (protects / fails_when / no_claim):

- test_add_item_per_role: protects=owners and the roadmap's decider add a draft item at
  once (it reads ``draft``, its goal is the goal it was dropped on, Oracle's drafting job
  is queued); approvers and commenters propose it (no item until the decider accepts,
  then it appears); viewers get 403; an empty title is 422; undo removes the item;
  fails_when=a proposer's add writes, a viewer adds, or undo leaves the item;
  no_claim=the web's drag.
- test_added_item_is_in_the_draft_only: protects=an added item is read by those who see
  the roadmap's working draft and never by others or by the published version (Detailed's
  rows are untouched); submitting the draft carries the item into the next version;
  fails_when=a viewer sees an unpublished addition or submit drops it; no_claim=the review
  policy itself (tests/test_simple_drafts_api.py).
- test_drafting_job_fills_the_draft: protects=the drafting job fills the outcome, links
  the best-matching baseline feature, adds the dependencies it names (known keys only)
  and opens a date suggestion inside the dropped quarter; it never overwrites an outcome
  a person typed; fails_when=it invents a key, writes outside the quarter or overwrites;
  no_claim=the model's quality.
- test_merge_item_per_role: protects=merge_item moves the draft's goal links and
  dependencies onto the kept item, points the draft's dependents at the kept item, and
  closes the draft (status merged, merged_into names the kept item); undo restores both;
  approvers who see the draft (its reviewers) propose it, viewers get 403, a non-draft is
  422; fails_when=a link is lost or
  undo leaves a half merge; no_claim=merging two published items.
- test_reconcile_and_keep_both: protects=a draft whose title looks like an existing item
  or a baseline feature lists it in ``looks_like`` (item first); keep_both empties it and
  its undo brings it back; merging with a feature links the draft to it; fails_when=a
  match is missed or keep_both does not stick; no_claim=fuzzy matching beyond titles.
- test_goal_suggestions_accept_reject_per_role: protects=accepting a suggestion is an
  add_item on its goal (applied for owners, a proposal for approvers and commenters), the
  suggestion becomes accepted, undoing the add reopens it; approvers and owners reject
  with an optional reason, commenters and viewers may not; viewers accept nothing;
  fails_when=a role does what it may not or a suggestion state is wrong; no_claim=the web.
- test_empty_goal_suggests_once: protects=the tick queues Oracle's suggestions for a goal
  with no items exactly once, never again for that goal even when it empties again; the
  job stores 3-5 suggestions, never one titled like a rejected one; on demand "Suggest
  features" queues a job each time (pending while it waits); viewers may not ask;
  fails_when=the trigger fires twice, a rejected suggestion comes back or a viewer asks;
  no_claim=the scheduled ticker's lock.
"""

import uuid
from datetime import date

import pytest
from sqlalchemy import select

from oracle import company_time
from oracle.jobs.models import LlmJob
from oracle.review.models import DocumentReviewPolicy
from oracle.roadmap.models import RoadmapItem
from oracle.simple import additions, drafts
from oracle.simple.models import RoadmapDateSuggestion, SimpleGoalSuggestion
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import make_people
from tests.test_simple_roadmap_api import NOW, Seed

CHANGES = "/v1/simple/changes"
ROADMAP = "/v1/simple/roadmap"
SUGGESTIONS = "/v1/simple/goal-suggestions"


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    moment = {"now": NOW}
    monkeypatch.setattr(company_time, "now", lambda: moment["now"])
    return moment


class World:
    """One roadmap with a track; items ``import-a`` (dated) and ``import-b`` (needs
    import-a); the goal ``grow`` (served by the feature ``bulk-import`` of import-a) and
    the goal ``quiet`` with no items; the feature ``audit-log`` with no item."""

    async def build(self, decider: bool = True) -> "World":
        self.ctx = await make_people()
        async with tenant_session(self.ctx.tenant_id) as s:
            seed = Seed(s)
            _, pv, rm, rv = await seed.roadmap("payments")
            self.roadmap_id, self.rv_id = str(rm.id), rv.id
            track = await seed.track(pv, rm, owner_id=self.ctx.users["owner"].id)
            grow = await seed.entity("goal", "grow")
            quiet = await seed.entity("goal", "quiet")
            feature = await seed.entity("feature", "bulk-import")
            other = await seed.entity("feature", "audit-log")
            await seed.supports(feature, grow)
            a = await seed.item(rv, pv, "import-a", title="Bulk import", track_id=track.id,
                                feature_id=feature.id, start_date=date(2026, 11, 1),
                                end_date=date(2026, 11, 30), date_source="typed")  # fmt: skip
            b = await seed.item(rv, pv, "import-b", title="Import history", position=1,
                                track_id=track.id, depends_on=["import-a"])  # fmt: skip
            if decider:
                # The approver reviews it, so sees its working draft (and proposes in it).
                u = self.ctx.users
                s.add(DocumentReviewPolicy(document_id=rm.id, decider_id=u["decider"].id,
                                           mandatory_reviewer_ids=[u["approver"].id]))  # fmt: skip
            await s.commit()
            self.ids = {"import-a": str(a.id), "import-b": str(b.id)}
            self.goals = {"grow": str(grow.id), "quiet": str(quiet.id)}
            self.features = {"bulk-import": str(feature.id), "audit-log": str(other.id)}
        return self

    def as_(self, who: str) -> dict:
        return self.ctx.as_(who)

    async def add(self, client, who: str, title: str, kind="goal", value=None, status=201):
        value = value if value is not None else self.goals["grow"]
        r = await client.post(CHANGES, headers=self.as_(who), json={
            "op": "add_item", "target": {"roadmap_id": self.roadmap_id,
                                         "where": {"kind": kind, "value": value}},
            "before": {}, "after": {"title": title}})  # fmt: skip
        assert r.status_code == status, r.text
        return r.json()

    async def items(self, client, who: str = "owner") -> dict[str, dict]:
        r = await client.get(ROADMAP, headers=self.as_(who))
        assert r.status_code == 200, r.text
        return {i["id"]: i for i in r.json()["items"]}


async def test_add_item_per_role(client):
    w = await World().build()
    for who in ("owner", "decider"):
        out = await w.add(client, who, f"Guided setup {who}")
        c = out["change"]
        assert c["status"] == "applied" and c["can_undo"]
        item = (await w.items(client, who))[c["target"]["item_id"]]
        assert item["draft"] and item["status"] == "draft" and item["drafting"]
        assert item["goal"]["id"] == w.goals["grow"] and w.goals["grow"] in item["goal_ids"]
        assert item["title"] == f"Guided setup {who}"
    async with tenant_session(w.ctx.tenant_id) as s:
        assert len(list(await s.scalars(select(LlmJob).where(LlmJob.kind == "item_draft")))) == 2
    for who in ("approver", "commenter"):
        out = await w.add(client, who, f"Proposed {who}", kind="horizon", value="later")
        c = out["change"]
        assert c["status"] == "proposed" and c["routed_to"] == [str(w.ctx.users["decider"].id)]
        assert c["target"]["item_id"] not in await w.items(client, "decider")
        r = await client.post(f"{CHANGES}/{c['id']}/accept", headers=w.as_(who), json={})
        assert r.status_code == 403
        r = await client.post(f"{CHANGES}/{c['id']}/accept", headers=w.as_("decider"), json={})
        assert r.status_code == 200, r.text
        item = (await w.items(client, "decider"))[c["target"]["item_id"]]
        assert item["horizon"] == "later" and item["draft"]
    await w.add(client, "viewer", "Nope", status=403)
    await w.add(client, "owner", "   ", status=422)
    await w.add(client, "owner", "Bad goal", value=str(uuid.uuid4()), status=422)
    # Undo removes the item.
    c = (await w.add(client, "owner", "Short lived"))["change"]
    r = await client.post(f"{CHANGES}/{c['id']}/undo", headers=w.as_("owner"))
    assert r.status_code == 201, r.text
    assert c["target"]["item_id"] not in await w.items(client)
    async with tenant_session(w.ctx.tenant_id) as s:
        assert await s.get(RoadmapItem, uuid.UUID(c["target"]["item_id"])) is None


async def test_added_item_is_in_the_draft_only(client):
    w = await World().build()
    c = (await w.add(client, "owner", "Guided setup"))["change"]
    iid = c["target"]["item_id"]
    assert iid in await w.items(client, "decider")
    assert iid not in await w.items(client, "viewer")
    async with tenant_session(w.ctx.tenant_id) as s:
        published = list(
            await s.scalars(select(RoadmapItem).where(RoadmapItem.roadmap_version_id == w.rv_id))
        )
        assert sorted(r.item_key for r in published) == ["import-a", "import-b"]
    drafts = (await client.get("/v1/simple/drafts", headers=w.as_("decider"))).json()
    d = next(x for x in drafts if x["document"]["id"] == w.roadmap_id)
    r = await client.post(f"/v1/simple/drafts/{d['id']}/submit", headers=w.as_("decider"))
    assert r.status_code == 200, r.text
    async with tenant_session(w.ctx.tenant_id) as s:
        new = list(
            await s.scalars(
                select(RoadmapItem).where(
                    RoadmapItem.roadmap_document_id == uuid.UUID(w.roadmap_id),
                    RoadmapItem.roadmap_version_id.is_not(None),
                    RoadmapItem.roadmap_version_id != w.rv_id,
                )
            )
        )
        added = [r for r in new if r.title == "Guided setup"]
        assert (
            len(added) == 1 and added[0].draft and added[0].goal_ids == [uuid.UUID(w.goals["grow"])]
        )


async def test_drafting_job_fills_the_draft(client):
    w = await World().build()
    c = (await w.add(client, "owner", "Import from files", kind="quarter", value="2026-Q4"))[
        "change"
    ]
    iid = c["target"]["item_id"]
    seen: dict = {}

    async def ask(kind, payload):
        seen.update(payload)
        assert kind == "item_draft"
        return {
            "outcome": "Admins bring their data in one step.",
            "feature_key": "bulk-import",
            "depends_on": ["import-a", "made-up"],
            "start_date": "2026-11-16",
            "end_date": "2026-12-18",
            "basis": "Two sprints after the import it builds on.",
        }

    async with tenant_session(w.ctx.tenant_id) as s:
        job = await s.scalar(select(LlmJob).where(LlmJob.kind == "item_draft"))
        assert job.input["item_id"] == iid
        out = await additions.run_item_draft(s, job, ask)
        assert out["drafted"] is True
        job.status = "succeeded"
        await s.commit()
    assert seen["title"] == "Import from files"
    assert {f["key"] for f in seen["features"]} >= {"bulk-import", "audit-log"}
    item = (await w.items(client))[iid]
    assert item["outcome"] == "Admins bring their data in one step."
    assert item["depends_on"] == [w.ids["import-a"]]
    assert item["suggestion"] is not None
    s0, s1 = item["suggestion"]["start_date"], item["suggestion"]["end_date"]
    assert "2026-10-01" <= s0 <= s1 <= "2026-12-31"
    assert not item["drafting"]
    async with tenant_session(w.ctx.tenant_id) as s:
        row = await s.get(RoadmapItem, uuid.UUID(iid))
        assert str(row.feature_id) == w.features["bulk-import"]
    # A person's outcome stays.
    c2 = (await w.add(client, "owner", "Second draft"))["change"]
    i2 = c2["target"]["item_id"]
    r = await client.post(CHANGES, headers=w.as_("owner"), json={
        "op": "edit_outcome", "target": {"item_id": i2}, "before": {"outcome": None},
        "after": {"outcome": "Typed by a person"}})  # fmt: skip
    assert r.status_code == 201, r.text

    async def ask2(kind, payload):
        return {"outcome": "Oracle's", "feature_key": None, "depends_on": [],
                "start_date": "2027-05-01", "end_date": "2027-04-01", "basis": "x"}  # fmt: skip

    async with tenant_session(w.ctx.tenant_id) as s:
        job = await s.scalar(
            select(LlmJob).where(
                LlmJob.kind == "item_draft",
                LlmJob.status == "queued",
                LlmJob.input["item_id"].astext == i2,
            )  # fmt: skip
        )
        await additions.run_item_draft(s, job, ask2)
        await s.commit()
        # An end before its start is no suggestion.
        assert (
            await s.scalar(
                select(RoadmapDateSuggestion).where(RoadmapDateSuggestion.item_id == uuid.UUID(i2))
            )
            is None
        )
    assert (await w.items(client))[i2]["outcome"] == "Typed by a person"


async def test_merge_item_per_role(client):
    w = await World().build()
    c = (await w.add(client, "owner", "Import from spreadsheets"))["change"]
    draft = c["target"]["item_id"]
    async with tenant_session(w.ctx.tenant_id) as s:
        # Oracle's drafting gave it a dependency; another draft depends on it.
        row = await s.get(RoadmapItem, uuid.UUID(draft))
        row.depends_on = ["import-b"]
        await s.commit()
    c2 = (await w.add(client, "owner", "Import reports"))["change"]
    dependent = c2["target"]["item_id"]
    items = await w.items(client)
    async with tenant_session(w.ctx.tenant_id) as s:
        dep_row = await s.get(RoadmapItem, uuid.UUID(dependent))
        dep_row.depends_on = [items[draft]["key"]]
        await s.commit()
    body = {"op": "merge_item", "target": {"item_id": draft, "into_id": w.ids["import-a"]},
            "before": {}, "after": {}}  # fmt: skip
    r = await client.post(CHANGES, headers=w.as_("viewer"), json=body)
    assert r.status_code == 403
    r = await client.post(CHANGES, headers=w.as_("approver"), json=body)
    assert r.status_code == 201 and r.json()["change"]["status"] == "proposed"
    assert (await w.items(client))[draft]["status"] == "draft"
    r = await client.post(CHANGES, headers=w.as_("owner"), json=body)
    assert r.status_code == 201, r.text
    merge = r.json()["change"]
    items = await w.items(client)
    assert items[draft]["status"] == "merged"
    assert items[draft]["merged_into"] == {"id": w.ids["import-a"], "code": "import-a",
                                           "title": "Bulk import"}  # fmt: skip
    kept = items[w.ids["import-a"]]
    assert w.goals["grow"] in kept["goal_ids"]
    assert w.ids["import-b"] in kept["depends_on"]
    assert w.ids["import-a"] in items[dependent]["depends_on"]
    assert draft not in items[dependent]["depends_on"]
    # The approver's proposal is outdated now.
    r = await client.post(CHANGES, headers=w.as_("owner"), json=body)
    assert r.status_code == 422
    r = await client.post(f"{CHANGES}/{merge['id']}/undo", headers=w.as_("owner"))
    assert r.status_code == 201, r.text
    items = await w.items(client)
    assert items[draft]["status"] == "draft" and items[draft]["merged_into"] is None
    assert items[w.ids["import-a"]]["goal_ids"] == []
    assert items[w.ids["import-a"]]["depends_on"] == []
    assert items[dependent]["depends_on"] == [draft]
    # A published item is not merged away.
    r = await client.post(CHANGES, headers=w.as_("owner"), json={
        "op": "merge_item", "target": {"item_id": w.ids["import-b"], "into_id": w.ids["import-a"]},
        "before": {}, "after": {}})  # fmt: skip
    assert r.status_code == 422


async def test_reconcile_and_keep_both(client):
    w = await World().build()
    c = (await w.add(client, "owner", "Bulk import"))["change"]
    draft = c["target"]["item_id"]
    item = (await w.items(client))[draft]
    assert item["looks_like"][0] == {"kind": "item", "id": w.ids["import-a"],
                                     "code": "import-a", "title": "Bulk import"}  # fmt: skip
    c2 = (await w.add(client, "owner", "Audit log"))["change"]
    d2 = c2["target"]["item_id"]
    assert (await w.items(client))[d2]["looks_like"][0]["kind"] == "feature"
    assert (await w.items(client))[d2]["looks_like"][0]["code"] == "audit-log"
    r = await client.post(CHANGES, headers=w.as_("owner"), json={
        "op": "keep_both", "target": {"item_id": draft}, "before": {"kept_both": False},
        "after": {}})  # fmt: skip
    assert r.status_code == 201, r.text
    assert (await w.items(client))[draft]["looks_like"] == []
    r = await client.post(f"{CHANGES}/{r.json()['change']['id']}/undo", headers=w.as_("owner"))
    assert r.status_code == 201, r.text
    assert (await w.items(client))[draft]["looks_like"] != []
    # Merging with a feature links the draft to it.
    r = await client.post(CHANGES, headers=w.as_("owner"), json={
        "op": "merge_item", "target": {"item_id": d2, "feature_id": w.features["audit-log"]},
        "before": {}, "after": {}})  # fmt: skip
    assert r.status_code == 201, r.text
    async with tenant_session(w.ctx.tenant_id) as s:
        # In the working draft (the published rows are never written).
        row = await drafts.effective_row(s, await s.get(RoadmapItem, uuid.UUID(d2)))
        assert str(row.feature_id) == w.features["audit-log"]
    assert (await w.items(client))[d2]["looks_like"] == []


async def _seed_suggestions(w: World, n: int = 4) -> list[str]:
    async with tenant_session(w.ctx.tenant_id) as s:
        rows = [
            SimpleGoalSuggestion(
                goal_id=uuid.UUID(w.goals["quiet"]),
                title=f"Quiet hours {i}",
                outcome="Fewer alerts at night",
                why="Alerts wake people",
                evidence=[],
                origin="auto",
            )  # fmt: skip
            for i in range(n)
        ]
        s.add_all(rows)
        await s.commit()
        return [str(r.id) for r in rows]


async def test_goal_suggestions_accept_reject_per_role(client):
    w = await World().build()
    ids = await _seed_suggestions(w)
    r = await client.get(SUGGESTIONS, headers=w.as_("viewer"), params={"goal_id": w.goals["quiet"]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["suggestions"]) == 4
    assert not any(x["can_accept"] or x["can_reject"] for x in body["suggestions"])
    assert body["goals"][0]["empty"] is True
    r = await client.post(f"{SUGGESTIONS}/{ids[0]}/accept", headers=w.as_("viewer"), json={})
    assert r.status_code == 403
    r = await client.post(f"{SUGGESTIONS}/{ids[0]}/accept", headers=w.as_("owner"),
                          json={"roadmap_id": w.roadmap_id})  # fmt: skip
    assert r.status_code == 200, r.text
    c = r.json()["change"]
    assert c["op"] == "add_item" and c["status"] == "applied"
    item = (await w.items(client))[c["target"]["item_id"]]
    assert item["goal"]["id"] == w.goals["quiet"] and item["outcome"] == "Fewer alerts at night"
    one = (await client.get(SUGGESTIONS, headers=w.as_("owner"),
                            params={"status": "accepted"})).json()["suggestions"]  # fmt: skip
    assert [x["id"] for x in one] == [ids[0]] and one[0]["item_id"] == item["id"]
    r = await client.post(f"{SUGGESTIONS}/{ids[0]}/accept", headers=w.as_("owner"), json={})
    assert r.status_code == 409
    r = await client.post(f"{CHANGES}/{c['id']}/undo", headers=w.as_("owner"))
    assert r.status_code == 201, r.text
    r = await client.get(SUGGESTIONS, headers=w.as_("owner"), params={"goal_id": w.goals["quiet"]})
    assert ids[0] in [x["id"] for x in r.json()["suggestions"]]
    for who in ("approver", "commenter"):
        r = await client.post(f"{SUGGESTIONS}/{ids[1 if who == 'approver' else 2]}/accept",
                              headers=w.as_(who), json={})  # fmt: skip
        assert r.status_code == 200 and r.json()["change"]["status"] == "proposed", r.text
    r = await client.post(f"{SUGGESTIONS}/{ids[3]}/reject", headers=w.as_("commenter"),
                          json={"reason": "no"})  # fmt: skip
    assert r.status_code == 403
    r = await client.post(f"{SUGGESTIONS}/{ids[3]}/reject", headers=w.as_("approver"),
                          json={"reason": "Not this year"})  # fmt: skip
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "rejected" and r.json()["reason"] == "Not this year"
    r = await client.post(f"{SUGGESTIONS}/{ids[3]}/reject", headers=w.as_("owner"), json={})
    assert r.status_code == 409


async def test_empty_goal_suggests_once(client):
    w = await World().build()

    async def jobs(s) -> list[LlmJob]:
        return list(await s.scalars(select(LlmJob).where(LlmJob.kind == "goal_suggestions")))

    async with tenant_session(w.ctx.tenant_id) as s:
        assert await additions.suggest_for_empty_goals(s) == 1
        await s.commit()
        assert await additions.suggest_for_empty_goals(s) == 0
        await s.commit()
        [job] = await jobs(s)
        assert job.input["goal_id"] == w.goals["quiet"] and job.input["origin"] == "auto"
    r = await client.get(SUGGESTIONS, headers=w.as_("owner"), params={"goal_id": w.goals["quiet"]})
    assert r.json()["goals"][0]["pending"] is True
    s0 = SimpleGoalSuggestion(goal_id=uuid.UUID(w.goals["quiet"]), title="Night mode",
                              outcome="o", why="w", evidence=[], origin="auto",
                              status="rejected")  # fmt: skip

    async def ask(kind, payload):
        assert kind == "goal_suggestions" and payload["goal"]["key"] == "quiet"
        return {"suggestions": [
            {"title": "Night mode", "outcome": "o", "why": "w", "evidence": []},
            *[{"title": f"Idea {i}", "outcome": f"Outcome {i}", "why": "Because",
               "evidence": [{"ref": "made-up", "label": "x"}]} for i in range(6)],
        ]}  # fmt: skip

    async with tenant_session(w.ctx.tenant_id) as s:
        s.add(s0)
        await s.flush()
        [job] = await jobs(s)
        out = await additions.run_goal_suggestions(s, job, ask)
        assert out["suggested"] == 5
        await s.commit()
    r = await client.get(SUGGESTIONS, headers=w.as_("owner"), params={"goal_id": w.goals["quiet"]})
    titles = [x["title"] for x in r.json()["suggestions"]]
    assert "Night mode" not in titles and len(titles) == 5
    assert all(x["evidence"] == [] for x in r.json()["suggestions"])
    # The goal gets an item, then empties again: no second automatic run.
    sid = r.json()["suggestions"][0]["id"]
    r = await client.post(f"{SUGGESTIONS}/{sid}/accept", headers=w.as_("owner"), json={})
    c = r.json()["change"]
    await client.post(f"{CHANGES}/{c['id']}/undo", headers=w.as_("owner"))
    async with tenant_session(w.ctx.tenant_id) as s:
        for j in await jobs(s):
            j.status = "succeeded"
        await s.commit()
        assert await additions.suggest_for_empty_goals(s) == 0
    # On demand, each time; never for a viewer.
    r = await client.post(f"/v1/simple/goals/{w.goals['grow']}/suggest", headers=w.as_("viewer"))
    assert r.status_code == 403
    for _ in range(2):
        r = await client.post(f"/v1/simple/goals/{w.goals['grow']}/suggest",
                              headers=w.as_("commenter"))  # fmt: skip
        assert r.status_code == 200, r.text
        assert r.json()["pending"] is True
        async with tenant_session(w.ctx.tenant_id) as s:
            for j in await jobs(s):
                j.status = "succeeded"
            await s.commit()
    async with tenant_session(w.ctx.tenant_id) as s:
        assert len([j for j in await jobs(s) if j.input["origin"] == "on_demand"]) == 2


async def test_undo_add_refused_while_a_merge_kept_the_item(client):
    """Review: undoing an added item that a merge kept would delete it with what the merge
    moved onto it and leave the merged draft pointing at nothing."""
    w = await World().build()
    kept = (await w.add(client, "owner", "Guided setup"))["change"]
    x = kept["target"]["item_id"]
    y = (await w.add(client, "owner", "Guided setup wizard"))["change"]["target"]["item_id"]
    r = await client.post(CHANGES, headers=w.as_("owner"), json={
        "op": "merge_item", "target": {"item_id": y, "into_id": x},
        "before": {}, "after": {}})  # fmt: skip
    assert r.status_code == 201, r.text
    merge = r.json()["change"]
    r = await client.post(f"{CHANGES}/{kept['id']}/undo", headers=w.as_("owner"))
    assert r.status_code == 409, r.text
    items = await w.items(client)
    assert x in items and items[y]["merged_into"]["id"] == x
    # Undo the merge first, then the add goes.
    r = await client.post(f"{CHANGES}/{merge['id']}/undo", headers=w.as_("owner"))
    assert r.status_code == 201, r.text
    r = await client.post(f"{CHANGES}/{kept['id']}/undo", headers=w.as_("owner"))
    assert r.status_code == 201, r.text
    assert x not in await w.items(client)


async def test_merge_into_a_cut_item_is_refused(client):
    """Review: a draft is not merged into an item that was cut."""
    w = await World().build()
    draft = (await w.add(client, "owner", "Import from spreadsheets"))["change"]
    r = await client.post(CHANGES, headers=w.as_("owner"), json={
        "op": "cut", "target": {"item_id": w.ids["import-b"]}, "before": {"cut": False},
        "after": {}, "reason": "Not this year"})  # fmt: skip
    assert r.status_code == 201, r.text
    r = await client.post(CHANGES, headers=w.as_("owner"), json={
        "op": "merge_item",
        "target": {"item_id": draft["target"]["item_id"], "into_id": w.ids["import-b"]},
        "before": {}, "after": {}})  # fmt: skip
    assert r.status_code == 422, r.text


async def test_a_goal_with_a_working_draft_item_is_not_empty(client):
    """Review: a goal whose only item is a quick add in the working draft is not empty, so
    the automatic suggestions do not run for it."""
    w = await World().build()
    await w.add(client, "owner", "Quiet hours", value=w.goals["quiet"])
    async with tenant_session(w.ctx.tenant_id) as s:
        assert await additions.suggest_for_empty_goals(s) == 0


async def test_date_suggestion_survives_publishing_an_added_item(client):
    """Review: approving the draft must not drop an added item's open date suggestion; the
    published copy carries it."""
    w = await World().build()
    iid = (await w.add(client, "owner", "Guided setup"))["change"]["target"]["item_id"]
    async with tenant_session(w.ctx.tenant_id) as s:
        s.add(RoadmapDateSuggestion(item_id=uuid.UUID(iid), start_date=date(2026, 11, 2),
                                    end_date=date(2026, 11, 20), basis="Two sprints"))  # fmt: skip
        await s.commit()
    ds = (await client.get("/v1/simple/drafts", headers=w.as_("decider"))).json()
    d = next(x for x in ds if x["document"]["id"] == w.roadmap_id)
    r = await client.post(f"/v1/simple/drafts/{d['id']}/submit", headers=w.as_("decider"))
    assert r.status_code == 200, r.text
    for who in ("decider", "approver"):
        r = await client.post(f"/v1/simple/drafts/{d['id']}/approve", headers=w.as_(who))
        assert r.status_code == 200, r.text
    assert r.json()["status"] == "approved", r.text
    async with tenant_session(w.ctx.tenant_id) as s:
        assert await s.get(RoadmapItem, uuid.UUID(iid)) is None
        copy = await s.scalar(
            select(RoadmapItem).where(
                RoadmapItem.title == "Guided setup", RoadmapItem.roadmap_version_id.is_not(None)
            )
        )
        sug = await s.scalar(
            select(RoadmapDateSuggestion).where(RoadmapDateSuggestion.item_id == copy.id)
        )
        assert sug is not None and sug.status == "open" and sug.basis == "Two sprints"
