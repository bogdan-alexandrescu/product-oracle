"""The snapshot lock (CR-12 part, S4): an intake and every run it starts read one pinned
snapshot; later syncs never rewrite in-progress decisions, and new evidence since the
pinned version is shown before anything is redrafted."""

import uuid

import pytest
from sqlalchemy import func

from oracle.runs.models import Run
from oracle.runtokens import mint_run_token
from oracle.sources.items import current_xid
from oracle.sources.models import Snapshot, SourceItem, SourceItemVersion
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
from tests.test_mcp import mcp_client, text_of


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
    before = gaps_by_category(await summary(client, ctx, intake_id, who="commenter"))

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
    assert gaps["success_metric"]["status"] == "answered_pending_review"
    assert gaps["success_metric"]["statement"] == before["success_metric"]["statement"]
    assert gaps["success_metric"]["lock_version"] == before["success_metric"]["lock_version"]
    assert str(new_item) in gaps["pain_evidence"]["evidence_ids"]
    assert len(repinned["intake"]["source_snapshot_ids"]) == 2


async def test_only_the_author_repins_or_reanalyses(client):
    """Both re-read the author's own sources: nobody else, whatever their role."""
    ctx = await company()
    out = await create_intake(client, ctx)
    for action in ("repin", "analyze"):
        url = f"/v1/intakes/{out['intake']['id']}/{action}"
        for who in ("viewer", "approver", "owner"):
            assert (await client.post(url, headers=ctx.as_(who))).status_code == 403, (action, who)
        assert (await client.post(url, headers=ctx.as_("commenter"))).status_code == 200


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


# --- pin stability ------------------------------------------------------------------------


async def _items_at(client, ctx, snapshot_id: str, who: str = "commenter") -> dict[str, dict]:
    resp = await client.get(f"/v1/snapshots/{snapshot_id}/items", headers=ctx.as_(who))
    assert resp.status_code == 200, resp.text
    return {i["id"]: i for i in resp.json()}


async def test_a_sync_that_commits_after_the_pin_never_joins_the_pinned_set(client):
    """The race: a sync writes a version (and deletes an item) before the pin is taken,
    and commits after. Neither may change what the pin reads."""
    ctx = await company()
    changed = await make_item(ctx, "commenter", content="Buyers complain about retyping.")
    deleted = await make_item(ctx, "commenter", content="Buyers abandon the cart at checkout.")
    async with tenant_session(ctx.tenant_id) as sync:
        item = await sync.get(SourceItem, changed)
        old_version = item.current_version_id
        version = SourceItemVersion(
            item_id=changed, title=item.title, content="Rewritten after the pin.",
            content_hash="rewritten", fetched_at=func.clock_timestamp(),
        )  # fmt: skip
        sync.add(version)
        await sync.flush()
        item.current_version_id = version.id
        gone = await sync.get(SourceItem, deleted)
        gone.deleted_at = func.clock_timestamp()
        gone.deleted_xid = current_xid()
        await sync.flush()
        # The pin is taken while the sync is still open...
        out = await create_intake(client, ctx)
        # ...and the sync commits afterwards, with stamps from before the pin.
        await sync.commit()
        assert version.fetched_at < (await sync.get(Snapshot, uuid.UUID(
            out["pinned"]["snapshot_id"]))).as_of  # fmt: skip

    pinned = await _items_at(client, ctx, out["pinned"]["snapshot_id"])
    assert pinned[str(changed)]["version_id"] == str(old_version)
    assert str(deleted) in pinned and pinned[str(deleted)]["deleted_at"] is not None
    new = (
        await client.get(
            f"/v1/intakes/{out['intake']['id']}/new-evidence", headers=ctx.as_("commenter")
        )
    ).json()
    assert {(i["source_item_id"], i["change"]) for i in new["items"]} == {
        (str(changed), "changed"), (str(deleted), "deleted"),
    }  # fmt: skip
    # Re-analysing still reads the pin, not the late sync.
    resp = await client.post(
        f"/v1/intakes/{out['intake']['id']}/analyze", headers=ctx.as_("commenter")
    )
    assert resp.status_code == 200
    assert resp.json()["new_evidence"]["count"] == 2


async def test_items_created_and_deleted_after_the_pin_are_not_reported_deleted(client):
    ctx = await company()
    out = await intake_with_source(client, ctx)
    intake_id = out["intake"]["id"]
    later = await make_item(ctx, "commenter", content="A thread that came and went.")
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(SourceItem, later)
        row.deleted_at = func.now()
        await s.commit()
    new = (
        await client.get(f"/v1/intakes/{intake_id}/new-evidence", headers=ctx.as_("commenter"))
    ).json()
    assert new["count"] == 0 and new["items"] == []


async def test_a_run_a_non_author_approver_starts_can_read_its_snapshot(client, runtime):
    """The intake's snapshot was taken by its author; the approver who creates and starts
    the run (and the run's agents) may read it, as themselves: never the author's items."""
    ctx = await company()
    out = await intake_with_source(client, ctx)  # the commenter's intake and item
    mine = await make_item(ctx, "approver", content="The approver's own thread.")
    pinned = out["pinned"]["snapshot_id"]
    approver = ctx.as_("approver")
    # Not before a run of theirs reads it.
    resp = await client.get(f"/v1/snapshots/{pinned}/items", headers=approver)
    assert resp.status_code == 404
    resp = await client.post(
        f"/v1/intakes/{out['intake']['id']}/runs", json={"document": "saved-addresses"},
        headers=approver,
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    run_id = resp.json()["id"]
    assert (await client.post(f"/v1/runs/{run_id}/estimate", headers=approver)).status_code == 200
    assert (await client.post(f"/v1/runs/{run_id}/start", headers=approver)).status_code == 200

    items = await _items_at(client, ctx, pinned, who="approver")
    author_item = gaps_by_category(out)["pain_evidence"]["evidence_ids"][0]
    assert author_item not in items  # the author's items stay the author's (AUD-9)
    assert str(mine) not in items  # made after the pin
    # Someone with no run on it still cannot.
    resp = await client.get(f"/v1/snapshots/{pinned}/items", headers=ctx.as_("owner"))
    assert resp.status_code == 404

    # The run's own token reads it through MCP, and sees the intake only as shared (S6).
    async with tenant_session(ctx.tenant_id) as s:
        raw = await mint_run_token(s, uuid.UUID(run_id), ["read:sources", "read:baseline"], 600)
        await s.commit()
    async with mcp_client(raw) as c:
        result = await c.call_tool("list_snapshot_items", {"snapshot_id": pinned})
        assert not result.is_error, text_of(result)
        result = await c.call_tool("get_intake_summary", {"intake_id": out["intake"]["id"]})
        assert not result.is_error, text_of(result)
        assert "retyping the shipping address" not in text_of(result)
        assert author_item not in text_of(result)
