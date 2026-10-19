"""The snapshot lock (CR-12 part, S4): an intake and every run it starts read one pinned
snapshot; later syncs never rewrite in-progress decisions, and new evidence since the
pinned version is shown before anything is redrafted."""

import uuid

import pytest

from oracle.runs.models import Run
from oracle.sources.models import Snapshot
from oracle.swarm import FakeRuntime, set_runtime
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_item
from tests.intake_helpers import (
    BRIEF,
    answer,
    batch,
    company,
    create_intake,
    gaps_by_category,
    intake_with_source,
    question_for,
    summary,
)


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


async def test_later_sources_do_not_rewrite_the_intake_until_it_is_repinned(client):
    ctx = await company()
    out = await intake_with_source(client, ctx)
    intake_id = out["intake"]["id"]
    q = question_for(await batch(client, ctx, intake_id), "success_metric")
    await answer(client, ctx, q["id"], body="Repeat checkout time, 95 s to 45 s.")
    before = gaps_by_category(await summary(client, ctx, intake_id))

    # A sync after the pin brings a new item.
    new_item = await make_item(
        ctx, "commenter", content="Returning buyers complain about retyping addresses again.",
        title="#new support thread",
    )  # fmt: skip
    new = (
        await client.get(f"/v1/intakes/{intake_id}/new-evidence", headers=ctx.as_("commenter"))
    ).json()
    assert new["since_version"] == 1 and new["count"] == 1
    assert [i["source_item_id"] for i in new["items"]] == [str(new_item)]
    assert new["items"][0]["title"] == "#new support thread"

    # Re-analysing reads the pinned snapshot: the new item is not evidence yet.
    resp = await client.post(f"/v1/intakes/{intake_id}/analyze", headers=ctx.as_("commenter"))
    assert resp.status_code == 200
    after = gaps_by_category(resp.json())
    assert after["pain_evidence"]["evidence_ids"] == before["pain_evidence"]["evidence_ids"]
    assert resp.json()["new_evidence"]["count"] == 1

    # Repinning is explicit; it never changes a decided gap.
    resp = await client.post(f"/v1/intakes/{intake_id}/repin", headers=ctx.as_("commenter"))
    assert resp.status_code == 200, resp.text
    repinned = resp.json()
    assert repinned["pinned"]["version"] == 2
    assert [v["version"] for v in repinned["pinned"]["versions"]] == [1, 2]
    assert repinned["new_evidence"]["count"] == 0
    gaps = gaps_by_category(repinned)
    assert gaps["success_metric"]["status"] == "answered"
    assert gaps["success_metric"]["statement"] == before["success_metric"]["statement"]
    assert gaps["success_metric"]["lock_version"] == before["success_metric"]["lock_version"]
    assert str(new_item) in gaps["pain_evidence"]["evidence_ids"]
    assert len(repinned["intake"]["source_snapshot_ids"]) == 2


async def test_only_the_author_or_an_approver_repins(client):
    ctx = await company()
    out = await create_intake(client, ctx)
    url = f"/v1/intakes/{out['intake']['id']}/repin"
    assert (await client.post(url, headers=ctx.as_("viewer"))).status_code == 403
    other = await create_intake(client, ctx, who="approver")
    url_other = f"/v1/intakes/{other['intake']['id']}/repin"
    assert (await client.post(url_other, headers=ctx.as_("commenter"))).status_code == 403
    assert (await client.post(url_other, headers=ctx.as_("owner"))).status_code == 200


async def test_an_existing_snapshot_and_chosen_sources_can_be_pinned(client):
    ctx = await company()
    first = await make_item(ctx, "commenter", content="Buyers complain about retyping.")
    resp = await client.post(
        "/v1/snapshots", json={"label": "before"}, headers=ctx.as_("commenter")
    )
    snapshot = resp.json()
    later = await make_item(ctx, "commenter", content="Buyers complain about retyping, again.")
    out = await create_intake(client, ctx, snapshot_id=snapshot["id"])
    assert out["pinned"]["snapshot_id"] == snapshot["id"]
    pain = gaps_by_category(out)["pain_evidence"]
    assert pain["evidence_ids"] == [str(first)]
    assert str(later) not in pain["evidence_ids"]

    # Choosing sources narrows what the intake reads.
    async with tenant_session(ctx.tenant_id) as s:
        from oracle.sources.models import SourceItem

        source_id = (await s.get(SourceItem, later)).source_id
    out = await create_intake(client, ctx, source_ids=[str(source_id)])
    assert out["intake"]["source_ids"] == [str(source_id)]
    assert gaps_by_category(out)["pain_evidence"]["evidence_ids"] == [str(later)]


async def test_a_run_started_from_an_intake_reads_its_pinned_snapshot(client, runtime):
    ctx = await company()
    out = await intake_with_source(client, ctx)
    intake_id = out["intake"]["id"]
    pinned = out["pinned"]["snapshot_id"]

    resp = await client.post(
        f"/v1/intakes/{intake_id}/runs", json={"document": "saved-addresses"},
        headers=ctx.as_("commenter"),
    )  # fmt: skip
    assert resp.status_code == 403
    resp = await client.post(
        f"/v1/intakes/{intake_id}/runs", json={"document": "saved-addresses"},
        headers=ctx.as_("approver"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    run = resp.json()
    assert run["status"] == "draft" and run["flow"] == "baseline_to_prd"
    assert runtime.submitted == []
    intake = (await client.get(f"/v1/intakes/{intake_id}", headers=ctx.as_("viewer"))).json()
    assert intake["status"] == "converted"

    # A sync after the pin, then the run starts: it keeps the intake's snapshot.
    await make_item(ctx, "commenter", content="A newer thread")
    approver = ctx.as_("approver")
    assert (
        await client.post(f"/v1/runs/{run['id']}/estimate", headers=approver)
    ).status_code == 200
    resp = await client.post(f"/v1/runs/{run['id']}/start", headers=approver)
    assert resp.status_code == 200, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(Run, uuid.UUID(run["id"]))
        assert str(row.snapshot_id) == pinned
        snapshots = (await s.scalars(__import__("sqlalchemy").select(Snapshot))).all()
        assert len(snapshots) == 1  # no second snapshot was taken

    # The agents get the intake by id, to read through Oracle's tools: never its text.
    [spec] = runtime.submitted
    prompt = repr(spec)
    assert intake_id in prompt
    assert "get_intake" in prompt
    assert BRIEF not in prompt
    assert "retyping the shipping address" not in prompt
