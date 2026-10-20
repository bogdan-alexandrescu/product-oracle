"""Security review, round 7 (S6, owner decision of 2026-10-19: freeze at sharing).

(1) Sharing a finding in full releases exactly the documents and versions it cited at
    that moment; documents a later analysis adds, and newer versions, stay withheld
    until the author shares again;
(2) documents deleted upstream stop being readable, and a search's ``as_of`` never
    reaches another version of a shared item;
(3) a re-analysis that makes a finding private withdraws its open proposal, and a
    withdrawn proposal keeps no answer text;
(4) an accept and a withdraw of the same proposal never both win.

Synthetic placeholders only.
"""

import asyncio
import json
import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from oracle.baseline import service as baseline_service
from oracle.intake import service as intake_service
from oracle.models import AuditEvent
from oracle.sources import store
from oracle.sources.base import ItemDelete, ItemUpsert
from oracle.sources.models import Source, SourceItem
from oracle.tenancy import tenant_session
from oracle.v2.models import ProductIntake
from tests.test_intake_sharing import EXCERPT_A, findings, share_all
from tests.test_intake_sharing_round5 import (
    ANSWER,
    _baseline_proposals,
    _blocker_gap,
    _principal,
    share,
    world,
)
from tests.test_intake_sharing_round6 import (
    RUNS,
    _answer_model_gap,
    as_run_of,
    evidence_hits,
    fake,  # noqa: F401 (fixture)
    run_view,
)

# A new support thread a later sync brings: the analysis cites it as pain evidence.
NEW_PAIN = (
    "Support thread: returning buyers say retyping the shipping address at checkout is "
    "slow, and several abandon the cart."
)
# A word only an upstream edit of item a holds.
EDIT_WORD = "Quetzalcoatl"
EDITED_A = f"Returning buyers now say the {EDIT_WORD} address book fixed checkout for them."


async def _sync(ctx, item_id: uuid.UUID, content: str, *, new: bool = False) -> uuid.UUID:
    """Sync into the source of ``item_id``: an edit of that item, or (``new``) a new item."""
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.get(SourceItem, item_id)
        source = await s.get(Source, item.source_id)
        event = ItemUpsert(
            external_id=uuid.uuid4().hex if new else item.external_id, kind="message",
            title="#support thread" if new else item.title, url=item.url, author=None,
            content=content, source_updated_at=datetime.now(UTC),
        )  # fmt: skip
        row, _ = await store.upsert_item(s, source, event)
        await s.commit()
        return row.id


async def _delete(ctx, item_id: uuid.UUID) -> None:
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.get(SourceItem, item_id)
        source = await s.get(Source, item.source_id)
        assert await store.delete_item(s, source, ItemDelete(external_id=item.external_id))
        await s.commit()


async def _repin(client, ctx, intake_id: str) -> None:
    resp = await client.post(f"/v1/intakes/{intake_id}/repin", headers=ctx.as_("author"))
    assert resp.status_code == 200, resp.text


async def _search(client, ctx, who: str, q: str, **params) -> list[dict]:
    resp = await client.get(
        "/v1/search", params={"q": q, "limit": 100, **params}, headers=as_run_of(ctx, who)
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["hits"]


# --- item 1: freeze at sharing -----------------------------------------------------------


async def test_an_item_a_reanalysis_adds_stays_withheld_until_shared_again(client, fake):  # noqa: F811
    """The reviewer's probe: every finding in full; a new item syncs and the next
    analysis cites it under a finding already in full; no run reads or searches it
    until the author shares that finding again."""
    ctx, intake_id, items = await world(client, fake, hidden=False)
    await share_all(client, ctx, intake_id, "full")
    new = await _sync(ctx, items["a"], NEW_PAIN, new=True)
    await _repin(client, ctx, intake_id)
    rows = await findings(client, ctx, intake_id)
    assert all(f["sharing"] == "full" for f in rows)
    citing = [f for f in rows if str(new) in f["source_item_ids"]]
    assert citing
    # The author is told what is new since they shared.
    assert all(f["unshared_item_ids"] == [str(new)] for f in citing)

    for who in RUNS:
        assert await run_view(client, ctx, who, new) == (404, False), who
        found = {h["source_item_id"] for h in await evidence_hits(client, ctx, intake_id, who)}
        assert str(new) not in found, who
        # What was shared stays readable.
        assert await run_view(client, ctx, who, items["a"]) == (200, True), who

    for f in citing:
        await share(client, ctx, intake_id, f["id"], "full")
    assert all(f["unshared_item_ids"] == [] for f in await findings(client, ctx, intake_id))
    for who in RUNS:
        assert await run_view(client, ctx, who, new) == (200, True), who


async def test_an_item_edited_upstream_after_sharing_serves_the_frozen_text(client, fake):  # noqa: F811
    ctx, intake_id, items = await world(client, fake, hidden=False)
    await share_all(client, ctx, intake_id, "full")
    await _sync(ctx, items["a"], EDITED_A)
    for who in RUNS:
        h = as_run_of(ctx, who)
        resp = await client.get(f"/v1/source-items/{items['a']}", headers=h)
        assert resp.status_code == 200, resp.text
        assert resp.json()["content"] == EXCERPT_A, who
        assert await _search(client, ctx, who, EDIT_WORD) == [], who
        hits = {x["item"]["id"]: x for x in await _search(client, ctx, who, "buyers")}
        assert EDIT_WORD not in hits[str(items["a"])]["snippet"], who
        for hit in await evidence_hits(client, ctx, intake_id, who):
            assert EDIT_WORD not in json.dumps(hit), who
    # Shared again: the newer version is released.
    await share_all(client, ctx, intake_id, "full")
    for who in RUNS:
        assert await _search(client, ctx, who, EDIT_WORD) == [], who  # not pinned yet
    await _repin(client, ctx, intake_id)
    await share_all(client, ctx, intake_id, "full")
    for who in RUNS:
        resp = await client.get(f"/v1/source-items/{items['a']}", headers=as_run_of(ctx, who))
        assert resp.json()["content"] == EDITED_A, who


# --- item 2: deleted items and as_of ------------------------------------------------------


async def test_a_deleted_shared_item_is_a_404_for_runs_and_never_found(client, fake):  # noqa: F811
    ctx, intake_id, items = await world(client, fake, hidden=False)
    await share_all(client, ctx, intake_id, "full")
    for who in RUNS:
        assert await run_view(client, ctx, who, items["a"]) == (200, True), who
    await _delete(ctx, items["a"])
    for who in RUNS:
        assert await run_view(client, ctx, who, items["a"]) == (404, False), who
        found = {h["source_item_id"] for h in await evidence_hits(client, ctx, intake_id, who)}
        assert str(items["a"]) not in found, who


async def test_as_of_never_reaches_another_version_of_a_shared_item(client, fake):  # noqa: F811
    ctx, intake_id, items = await world(client, fake, hidden=False)
    await share_all(client, ctx, intake_id, "full")
    frozen = (
        await client.get(f"/v1/source-items/{items['a']}", headers=as_run_of(ctx, "approver"))
    ).json()["version_id"]
    await _sync(ctx, items["a"], EDITED_A)
    later = datetime.now(UTC).isoformat()
    for who in RUNS:
        assert await _search(client, ctx, who, EDIT_WORD, as_of=later) == [], who
        hits = await _search(client, ctx, who, "buyers", as_of=later)
        [hit] = [x for x in hits if x["item"]["id"] == str(items["a"])]
        assert hit["item"]["version_id"] == frozen, who
        # Before the item existed: still the frozen version, never none or another.
        early = await _search(client, ctx, who, "buyers", as_of="2001-01-01T00:00:00Z")
        assert [x["item"]["version_id"] for x in early if x["item"]["id"] == str(items["a"])] == [
            frozen
        ], who


# --- item 3: lowering stays consistent ------------------------------------------------------


async def test_a_withdrawn_proposal_keeps_no_answer_text(client, fake):  # noqa: F811
    ctx, intake_id, _ = await world(client, fake, hidden=False, model=_blocker_gap)
    gap = await _answer_model_gap(client, ctx)
    await share(client, ctx, intake_id, str(gap.id), "summary")
    [proposal] = await _baseline_proposals(ctx)
    assert ANSWER in json.dumps(proposal.payload)
    await share(client, ctx, intake_id, str(gap.id), "private")
    [proposal] = await _baseline_proposals(ctx)
    assert proposal.status == "withdrawn"
    assert ANSWER not in json.dumps(proposal.payload)
    assert "1000" not in json.dumps(proposal.payload)


async def test_a_reanalysis_that_makes_a_finding_private_withdraws_its_proposal(client, fake):  # noqa: F811
    """A model-written gap whose finding is lost (as an intake from before S6) is
    registered private by the next analysis: its open proposal is withdrawn, scrubbed."""
    ctx, intake_id, _ = await world(client, fake, hidden=False, model=_blocker_gap)
    gap = await _answer_model_gap(client, ctx)
    await share(client, ctx, intake_id, str(gap.id), "summary")
    [proposal] = await _baseline_proposals(ctx)
    assert proposal.status == "open"
    async with tenant_session(ctx.tenant_id) as s:
        intake = await s.get(ProductIntake, uuid.UUID(intake_id))
        reg = {k: v for k, v in intake.analysis["findings"].items() if k != str(gap.id)}
        intake.analysis = {**intake.analysis, "findings": reg}
        await s.commit()
    resp = await client.post(f"/v1/intakes/{intake_id}/analyze", headers=ctx.as_("author"))
    assert resp.status_code == 200, resp.text
    [row] = [f for f in await findings(client, ctx, intake_id) if f["id"] == str(gap.id)]
    assert row["sharing"] == "private"
    [proposal] = await _baseline_proposals(ctx)
    assert proposal.status == "withdrawn"
    assert ANSWER not in json.dumps(proposal.payload)


# --- item 4: accept vs withdraw ---------------------------------------------------------------


async def _open_proposal(client, ctx):
    ctx_, intake_id, _ = ctx
    gap = await _answer_model_gap(client, ctx_)
    await share(client, ctx_, intake_id, str(gap.id), "summary")
    [proposal] = await _baseline_proposals(ctx_)
    assert proposal.status == "open"
    return gap, proposal


async def _actions(ctx) -> list[str]:
    async with tenant_session(ctx.tenant_id) as s:
        rows = await s.scalars(select(AuditEvent.action).order_by(AuditEvent.created_at))
        return list(rows.all())


async def test_withdrawn_first_then_the_accept_is_refused(client, fake):  # noqa: F811
    world_ = await world(client, fake, hidden=False, model=_blocker_gap)
    ctx, intake_id, _ = world_
    gap, proposal = await _open_proposal(client, world_)
    async with tenant_session(ctx.tenant_id) as s1, tenant_session(ctx.tenant_id) as s2:
        intake = await s1.get(ProductIntake, uuid.UUID(intake_id))
        await intake_service.set_sharing(
            s1, _principal(ctx, "author"), intake, [(str(gap.id), "private")]
        )

        async def accept():
            return await baseline_service.decide_proposal(
                s2, proposal.id, _principal(ctx, "owner"), True, None
            )

        task = asyncio.create_task(accept())
        await asyncio.sleep(0.5)  # the accept now waits on the withdrawn row
        await s1.commit()
        with pytest.raises(baseline_service.NotFoundError):
            await task
        await s2.rollback()
    [row] = await _baseline_proposals(ctx)
    assert row.status == "withdrawn"
    assert "baseline.proposal.withdrawn" in await _actions(ctx)
    assert "baseline.proposal.accepted" not in await _actions(ctx)


async def test_accepted_first_then_the_withdraw_leaves_it_accepted(client, fake):  # noqa: F811
    world_ = await world(client, fake, hidden=False, model=_blocker_gap)
    ctx, intake_id, _ = world_
    gap, proposal = await _open_proposal(client, world_)
    async with tenant_session(ctx.tenant_id) as s1, tenant_session(ctx.tenant_id) as s2:
        await baseline_service.decide_proposal(
            s1, proposal.id, _principal(ctx, "owner"), True, None
        )
        await s1.flush()

        async def lower():
            intake = await s2.get(ProductIntake, uuid.UUID(intake_id))
            await intake_service.set_sharing(
                s2, _principal(ctx, "author"), intake, [(str(gap.id), "private")]
            )
            await s2.commit()

        task = asyncio.create_task(lower())
        await asyncio.sleep(0.5)  # the withdraw now waits on the accepted row
        await s1.commit()
        await task
    [row] = await _baseline_proposals(ctx)
    assert row.status == "accepted"
    actions = await _actions(ctx)
    assert "baseline.proposal.accepted" in actions
    assert "baseline.proposal.withdrawn" not in actions
    # The lowering itself is audited, and so is the withdraw that found it decided.
    assert actions.count("intake.finding_shared") >= 2
    assert "baseline.proposal.withdraw_skipped" in actions
