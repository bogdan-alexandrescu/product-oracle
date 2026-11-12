"""roadmap-edit-fixes (Nov 5): what applying many roadmap changes through Simple's panel
met. Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_cross_prd_dependency_names_its_stored_key: protects=an item depending on another
  PRD's feature (by the feature's key, neither an item key nor a code) is read with the key
  that names each dependency (``depends_key_of``), so the panel's remove sends the list
  without it and the read no longer lists it; fails_when=the read gives no key for it, or
  the removal leaves it listed; no_claim=the web.
- test_rename_keeps_the_code: protects=an item whose title carries its code ("F-07 Alpha")
  reads as code F-07 and name Alpha; a rename as the panel sends it (the name alone) keeps
  the code; fails_when=the read shows the code in the name, or the rename drops the code;
  no_claim=Priorities' letters.
- test_set_depends_refuses_a_loop: protects=an item set to depend on one that already
  depends on it (directly or through others) is 422 naming both; fails_when=the loop is
  stored; no_claim=the runs' items check.
- test_merge_refuses_a_loop: protects=a merge whose kept item would take a dependency that
  waits on the kept item is 422; fails_when=the merge stores the loop.
- test_set_prd_moves_the_track_with_it: protects=a track follows its PRD (a product track is
  one PRD's): moving an item to another PRD moves it to that PRD's track, and Undo puts both
  back; fails_when=the item keeps the first PRD's track; no_claim=items with no track.
- test_oracle_draft_never_overwrites_a_person: protects=a person's goal and outcome saved
  while Oracle drafts a new item stay; Oracle's dependency ideas are suggestions
  (``suggested_depends``), never written; fails_when=Oracle's draft resets the goal, writes
  its outcome over the person's, or adds a dependency on its own.
- test_a_person_edit_over_oracles_draft_stays: protects=a person who opened the outcome
  while Oracle drafted (it read empty) keeps what they typed when Oracle's draft lands before
  their save: Oracle fills only what a person leaves empty; a later person's write still
  conflicts, by that person; fails_when=the save is refused as changed by Oracle and Oracle's
  outcome stays, or the later write is named as anyone but that person.
- test_oracle_filled_reads_only_the_items_changes: protects=the check for Oracle's draft reads
  the changes that name the item, not every change of the company; fails_when=it loads the
  changes of other items.
"""

import asyncio
import uuid
from datetime import date

import pytest
from sqlalchemy import event, select

from oracle import company_time
from oracle.auth.models import User
from oracle.jobs.models import LlmJob
from oracle.roadmap.models import RoadmapItem
from oracle.simple import additions, changes
from oracle.simple.models import SimpleChange
from oracle.tenancy import tenant_session
from tests.test_simple_additions_api import World
from tests.test_simple_changes_api import CHANGES, make_people
from tests.test_simple_roadmap_api import NOW, Seed, by_key, get

pytestmark = pytest.mark.asyncio(loop_scope="session")


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


class Two:
    """Items ``a`` (payments PRD, track Track) and ``b`` (ledger PRD, track Second, feature
    ``ledger-sync``) and ``c`` (payments) on one roadmap; c depends on ledger-sync."""

    async def build(self, title_a: str = "Alpha") -> "Two":
        self.ctx = await make_people()
        async with tenant_session(self.ctx.tenant_id) as s:
            seed = Seed(s)
            prd, pv, rm, rv = await seed.roadmap("payments")
            self.track = await seed.track(pv, rm)
            self.ledger = await seed.doc("ledger-prd")
            lv = await seed.version(self.ledger)
            self.second = await seed.track(lv, rm, title="Second")
            self.prd = prd
            f = await seed.entity("feature", "ledger-sync")
            a = await seed.item(rv, pv, "a", position=0, title=title_a, track_id=self.track.id)
            b = await seed.item(rv, lv, "b", position=1, feature_id=f.id, title="Beta")
            c = await seed.item(rv, pv, "c", position=2, depends_on=["ledger-sync"],
                                title="Gamma")  # fmt: skip
            self.a, self.b, self.c = str(a.id), str(b.id), str(c.id)
            await s.commit()
        return self

    async def read(self, client) -> dict[str, dict]:
        return by_key(await get(client, self.ctx, "owner"))

    async def post(self, client, op, item, before, after, who="owner"):
        body = {"op": op, "target": {"item_id": item}, "before": before, "after": after}
        return await client.post(CHANGES, json=body, headers=self.ctx.as_(who))


async def test_cross_prd_dependency_names_its_stored_key(client):
    t = await Two().build()
    c = (await t.read(client))["c"]
    assert c["depends_on"] == [t.b]
    assert c["depends_key_of"] == {t.b: "ledger-sync"}
    keys = [k for k in c["depends_keys"] if k != c["depends_key_of"][t.b]]
    r = await t.post(client, "set_depends", t.c, {"depends_on": c["depends_keys"]},
                     {"depends_on": keys})  # fmt: skip
    assert r.status_code == 201, r.text
    c = (await t.read(client))["c"]
    assert c["depends_on"] == [] and c["depends_keys"] == []


async def test_rename_keeps_the_code(client):
    t = await Two().build(title_a="F-07 Alpha")
    a = (await t.read(client))["a"]
    assert (a["code"], a["title"]) == ("F-07", "Alpha")
    r = await t.post(client, "edit_title", t.a, {"title": a["title"]}, {"title": "Alpha two"})
    assert r.status_code == 201, r.text
    a = (await t.read(client))["a"]
    assert (a["code"], a["title"]) == ("F-07", "Alpha two")
    async with tenant_session(t.ctx.tenant_id) as s:
        from oracle.simple import drafts

        row = await drafts.effective_row(s, await s.get(RoadmapItem, uuid.UUID(t.a)))
        assert row.title == "F-07 Alpha two"


async def test_set_depends_refuses_a_loop(client):
    t = await Two().build()
    # c depends on b (by its feature key): b may not depend on c.
    r = await t.post(client, "set_depends", t.b, {"depends_on": []}, {"depends_on": ["c"]})
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "Not added, it would make a loop: Gamma already depends on Beta"
    # Through another: a depends on b; c on a would close b <- c <- a <- b? No: b on a.
    r = await t.post(client, "set_depends", t.a, {"depends_on": []}, {"depends_on": ["c"]})
    assert r.status_code == 201, r.text
    r = await t.post(client, "set_depends", t.b, {"depends_on": []}, {"depends_on": ["a"]})
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "Not added, it would make a loop: Alpha already depends on Beta"
    items = await t.read(client)
    assert items["b"]["depends_keys"] == []


async def test_merge_refuses_a_loop(client):
    w = await World().build()
    c = (await w.add(client, "owner", "Import wizard"))["change"]
    iid = c["target"]["item_id"]
    # The draft depends on import-b, which depends on import-a: merged into import-a,
    # import-a would depend on import-b.
    r = await client.post(CHANGES, headers=w.as_("owner"), json={
        "op": "set_depends", "target": {"item_id": iid}, "before": {"depends_on": []},
        "after": {"depends_on": ["import-b"]}})  # fmt: skip
    assert r.status_code == 201, r.text
    r = await client.post(CHANGES, headers=w.as_("owner"), json={
        "op": "merge_item", "target": {"item_id": iid, "into_id": w.ids["import-a"]},
        "before": {}, "after": {}})  # fmt: skip
    assert r.status_code == 422, r.text
    assert "already depends on" in r.json()["detail"]


async def test_set_prd_moves_the_track_with_it(client):
    t = await Two().build()
    a = (await t.read(client))["a"]
    assert a["track"]["id"] == str(t.track.id)
    r = await t.post(client, "set_prd", t.a, {"prd_document_id": str(t.prd.id)},
                     {"prd_document_id": str(t.ledger.id)})  # fmt: skip
    assert r.status_code == 201, r.text
    a = (await t.read(client))["a"]
    assert a["prd"]["id"] == str(t.ledger.id)
    assert a["track"]["id"] == str(t.second.id)
    undo = await client.post(f"{CHANGES}/{r.json()['change']['id']}/undo",
                             headers=t.ctx.as_("owner"))  # fmt: skip
    assert undo.status_code in (200, 201), undo.text
    a = (await t.read(client))["a"]
    assert a["prd"]["id"] == str(t.prd.id) and a["track"]["id"] == str(t.track.id)


async def _job(s, iid: str) -> LlmJob:
    return await s.scalar(
        select(LlmJob).where(LlmJob.kind == "item_draft", LlmJob.input["item_id"].astext == iid)
    )


async def test_oracle_draft_never_overwrites_a_person(client):
    w = await World().build()
    c = (await w.add(client, "owner", "Import from files"))["change"]
    iid = c["target"]["item_id"]
    other = (await w.add(client, "owner", "Import mapping"))["change"]["target"]["item_id"]
    item = (await w.items(client))[iid]

    async def ask(kind, payload):
        # The person edits while Oracle drafts.
        for op, before, after in (
            ("set_goal", {"goal_id": item["goal"]["id"]}, {"goal_id": w.goals["quiet"]}),
            ("edit_outcome", {"outcome": None}, {"outcome": "Typed by a person"}),
        ):
            # Oracle holds no lock on the item while it asks: the save is not kept waiting.
            r = await asyncio.wait_for(client.post(CHANGES, headers=w.as_("owner"), json={
                "op": op, "target": {"item_id": iid}, "before": before, "after": after}),
                timeout=10)  # fmt: skip
            assert r.status_code == 201, r.text
        new = [i for i in payload["items"] if i["key"] != "import-a"]
        return {"outcome": "Admins bring their data in one step.", "goal_key": "grow",
                "feature_key": None, "depends_on": ["import-a", *[i["key"] for i in new]],
                "start_date": "2026-11-16", "end_date": "2026-12-18", "basis": "x"}  # fmt: skip

    async with tenant_session(w.ctx.tenant_id) as s:
        job = await _job(s, iid)
        job.output = await additions.run_item_draft(s, job, ask)
        job.status = "succeeded"
        await s.commit()
    item = (await w.items(client))[iid]
    assert item["goal"]["id"] == w.goals["quiet"]
    assert item["outcome"] == "Typed by a person"
    assert item["depends_on"] == [] and item["depends_keys"] == []
    assert "import-a" in item["suggested_depends"]
    # The other new item's idea of depending on this one is never a loop either.
    async with tenant_session(w.ctx.tenant_id) as s:
        key = (await s.get(RoadmapItem, uuid.UUID(iid))).item_key
    r = await client.post(CHANGES, headers=w.as_("owner"), json={
        "op": "set_depends", "target": {"item_id": other}, "before": {"depends_on": []},
        "after": {"depends_on": [key]}})  # fmt: skip
    assert r.status_code == 201, r.text
    items = await w.items(client)
    assert items[other]["depends_keys"] == [key]
    assert items[other]["key"] not in items[iid]["suggested_depends"]


async def test_a_person_edit_over_oracles_draft_stays(client):
    w = await World().build()
    c = (await w.add(client, "owner", "Import from files"))["change"]
    iid = c["target"]["item_id"]

    async def ask(kind, payload):
        return {"outcome": "Admins bring their data in one step.", "goal_key": "grow",
                "feature_key": None, "depends_on": [],
                "start_date": "2026-11-16", "end_date": "2026-12-18", "basis": "x"}  # fmt: skip

    async with tenant_session(w.ctx.tenant_id) as s:
        job = await _job(s, iid)
        job.output = await additions.run_item_draft(s, job, ask)
        job.status = "succeeded"
        await s.commit()
    async with tenant_session(w.ctx.tenant_id) as s:
        other = User(email="robin@example.com", name="Robin Vale", password_hash="x",
                     role="owner")  # fmt: skip
        s.add(other)
        await s.commit()
    w.ctx.users["other"] = other
    # A person opened the outcome before Oracle's came in, and saves after it did.
    r = await client.post(CHANGES, headers=w.as_("other"), json={
        "op": "edit_outcome", "target": {"item_id": iid}, "before": {"outcome": None},
        "after": {"outcome": "Mine"}})  # fmt: skip
    assert r.status_code == 201, r.text
    assert (await w.items(client))[iid]["outcome"] == "Mine"
    # A person's write since is still theirs: another who saw it empty is told who changed it.
    r = await client.post(CHANGES, headers=w.as_("owner"), json={
        "op": "edit_outcome", "target": {"item_id": iid}, "before": {"outcome": None},
        "after": {"outcome": "Theirs"}})  # fmt: skip
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["changed_by"]["name"] == "Robin Vale"
    assert (await w.items(client))[iid]["outcome"] == "Mine"
    _ = date


async def test_oracle_filled_reads_only_the_items_changes(client):
    w = await World().build()
    iid = (await w.add(client, "owner", "Import from files"))["change"]["target"]["item_id"]

    async def ask(kind, payload):
        return {"outcome": "Admins bring their data in one step.", "goal_key": "grow",
                "feature_key": None, "depends_on": [],
                "start_date": "2026-11-16", "end_date": "2026-12-18", "basis": "x"}  # fmt: skip

    async with tenant_session(w.ctx.tenant_id) as s:
        job = await _job(s, iid)
        job.output = await additions.run_item_draft(s, job, ask)
        job.status = "succeeded"
        await s.commit()
    # Many changes of other items.
    seen = None
    for n in range(12):
        r = await client.post(CHANGES, headers=w.as_("owner"), json={
            "op": "edit_outcome", "target": {"item_id": w.ids["import-b"]},
            "before": {"outcome": seen}, "after": {"outcome": f"Step {n}"}})  # fmt: skip
        assert r.status_code == 201, r.text
        seen = f"Step {n}"
    loaded: list[SimpleChange] = []

    def on_load(target, _ctx):
        loaded.append(target)

    event.listen(SimpleChange, "load", on_load)
    try:
        async with tenant_session(w.ctx.tenant_id) as s:
            assert await changes._oracle_filled(s, iid, ("outcome",))
    finally:
        event.remove(SimpleChange, "load", on_load)
    assert loaded and all(c.target.get("item_id") == iid for c in loaded), len(loaded)
