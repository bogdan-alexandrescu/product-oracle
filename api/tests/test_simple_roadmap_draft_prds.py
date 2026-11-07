"""The Simple roadmap's draft layer (RP2, the owner's pick 'Draft layer on roadmap'): the
PRDs whose run's draft roadmap holds dated items not approved yet, each with its items,
dates, owner and run. Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_draft_prds_lists_each_prd_with_its_items: protects=the read lists the PRD with its
  run, its items' dates and owner, ``can_change`` for approvers; fails_when=the route is
  missing or an item lacks its dates; no_claim=how the web draws them.
- test_who_may_read: protects=a PRD only owners and approvers see is left out for a
  commenter and a viewer; fails_when=the read ignores the PRD's visibility.
- test_replaced_or_cancelled_shows_no_layer: protects=a replaced PRD and a cancelled run
  are left out; fails_when=either still lists.
- test_approved_prd_leaves_the_layer: protects=once the draft's PRD version is approved
  the PRD is gone from the read; fails_when=it still lists.
- test_leave_out_and_change_dates_stay_draft: protects=Leave out takes the item off the
  layer and Change dates keeps it draft with the typed dates, approvers only;
  fails_when=a commenter may change it, or the item lands on the roadmap.
"""

from datetime import UTC, date, datetime

import pytest
from sqlalchemy import func, select, update

from oracle.docs.models import Document, DocumentVersion
from oracle.roadmap.models import DraftRoadmap, RoadmapItem
from oracle.runs.models import Run
from oracle.tenancy import tenant_session
from tests.test_plan import Seed
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_meetings_api import PRD, world

DRAFT_PRDS = "/v1/simple/roadmap/draft-prds"


async def add_draft(w, *, run_status: str = "succeeded") -> dict:
    """Three dated items on a run's draft roadmap of the PRD, the first owned by a person."""
    async with tenant_session(w.ctx.tenant_id) as s:
        prd = await s.scalar(select(Document).where(Document.slug == PRD))
        n = await s.scalar(
            select(func.max(DocumentVersion.number)).where(DocumentVersion.document_id == prd.id)
        )
        version = await Seed(s).version(prd, n + 1)  # the run's new draft, not approved
        pv = version.id
        run = Run(flow="baseline_to_prd", status=run_status, created_by=w.ctx.users["owner"].id)
        s.add(run)
        await s.flush()
        draft = DraftRoadmap(prd_document_id=prd.id, prd_version_id=pv, status="ready",
                             run_id=run.id)  # fmt: skip
        s.add(draft)
        await s.flush()
        for i in range(3):
            s.add(RoadmapItem(draft_roadmap_id=draft.id, item_key=f"draft-{i}", position=i,
                              title=f"Draft item {i}", horizon="now",
                              start_date=date(2026, 11, 9 + i), end_date=date(2026, 12, 18 + i),
                              owner_id=w.ctx.users["approver"].id if i == 0 else None,
                              prd_document_id=prd.id, prd_version_id=pv))  # fmt: skip
        await s.commit()
        return {"prd": prd.id, "version": pv, "run": run.id}


async def read(client, w, who: str = "approver") -> list[dict]:
    r = await client.get(DRAFT_PRDS, headers=w.ctx.as_(who))
    assert r.status_code == 200, r.text
    return r.json()


async def test_draft_prds_lists_each_prd_with_its_items(client):
    w = await world()
    ids = await add_draft(w)
    [d] = await read(client, w)
    assert d["prd"]["slug"] == PRD
    assert d["run_id"] == str(ids["run"])
    assert d["can_change"] is True
    assert [i["title"] for i in d["items"]] == ["Draft item 0", "Draft item 1", "Draft item 2"]
    first = d["items"][0]
    assert (first["start"], first["end"]) == ("2026-11-09", "2026-12-18")
    assert first["owner_name"] == "approver@example.com"  # no name: the email
    [c] = await read(client, w, "commenter")
    assert c["can_change"] is False


@pytest.mark.parametrize(
    ("who", "n"), [("owner", 1), ("approver", 1), ("commenter", 0), ("viewer", 0)]
)
async def test_who_may_read(client, who, n):
    w = await world()
    ids = await add_draft(w)
    async with tenant_session(w.ctx.tenant_id) as s:
        await s.execute(
            update(Document).where(Document.id == ids["prd"]).values(visibility="approvers")
        )
        await s.commit()
    assert len(await read(client, w, who)) == n


@pytest.mark.parametrize("how", ["replaced", "cancelled"])
async def test_replaced_or_cancelled_shows_no_layer(client, how):
    w = await world()
    ids = await add_draft(w, run_status="cancelled" if how == "cancelled" else "succeeded")
    if how == "replaced":
        async with tenant_session(w.ctx.tenant_id) as s:
            other = await s.scalar(select(Document.id).where(Document.id != ids["prd"]).limit(1))
            await s.execute(update(Document).where(Document.id == ids["prd"])
                            .values(replaced_by=[other]))  # fmt: skip
            await s.commit()
    assert await read(client, w) == []


async def test_approved_prd_leaves_the_layer(client):
    w = await world()
    ids = await add_draft(w)
    assert len(await read(client, w)) == 1
    async with tenant_session(w.ctx.tenant_id) as s:
        await s.execute(update(DocumentVersion).where(DocumentVersion.id == ids["version"])
                        .values(approved_at=datetime(2026, 11, 4, tzinfo=UTC)))  # fmt: skip
        await s.commit()
    assert await read(client, w) == []


async def test_leave_out_and_change_dates_stay_draft(client):
    w = await world()
    await add_draft(w)
    [d] = await read(client, w)
    first, second = d["items"][0]["id"], d["items"][1]["id"]
    r = await client.post(f"{DRAFT_PRDS}/items/{first}/leave-out", headers=w.ctx.as_("commenter"))
    assert r.status_code == 403, r.text
    r = await client.post(f"{DRAFT_PRDS}/items/{first}/leave-out", headers=w.ctx.as_("approver"))
    assert r.status_code == 204, r.text
    body = {"start": "2027-01-04", "end": "2027-02-05"}
    r = await client.post(f"{DRAFT_PRDS}/items/{second}/dates", json=body,
                          headers=w.ctx.as_("approver"))  # fmt: skip
    assert r.status_code == 204, r.text
    [d] = await read(client, w)
    assert [i["id"] for i in d["items"]][0] == second
    assert (d["items"][0]["start"], d["items"][0]["end"]) == ("2027-01-04", "2027-02-05")
    async with tenant_session(w.ctx.tenant_id) as s:
        row = await s.get(RoadmapItem, d["items"][0]["id"])
        assert row.draft_roadmap_id is not None and row.roadmap_document_id is None
