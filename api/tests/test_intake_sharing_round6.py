"""Security review, round 6 (S6 and AUD-9; owner decisions of 2026-10-19).

Two owner decisions:

(1) a finding shared in full makes its cited documents readable to runs in full text
    (search and read), while people see title, link and the 400-character excerpt; this
    still yields to the intake rule (while any finding of the same intake is below
    "shared in full", that intake's items stay withheld from runs);
(2) lowering a finding back to private withdraws its open baseline proposal; sharing
    again recreates it; accepted or rejected proposals stay.

Synthetic placeholders only.
"""

import asyncio
import json
import uuid

import pytest
from sqlalchemy import delete, func, select

from oracle.auth.service import make_session_cookie
from oracle.baseline.models import Proposal
from oracle.config import get_settings
from oracle.intake import evidence as ev
from oracle.intake.models import IntakeWithheldItem
from oracle.jobs.models import LlmJob
from oracle.llm import gateway
from oracle.models import AuditEvent
from oracle.tenancy import tenant_session
from oracle.v2.models import KnowledgeGap, ProductIntake, StakeholderQuestion
from tests.test_intake_jobs import FakeClaude
from tests.test_intake_sharing import (
    CODENAME,
    EXCERPT_A,
    EXCERPT_OLD,
    MODEL_GAP,
    TITLE_A,
    findings,
    read_summary,
    share_all,
)
from tests.test_intake_sharing_round5 import (
    ANSWER,
    OTHERS,
    _baseline_proposals,
    _blocker_gap,
    finding_of,
    share,
    world,
)

RUNS = ["author", "approver"]


@pytest.fixture
def fake():
    holder = {}

    def install(answer):
        claude = FakeClaude(answer)
        holder["previous"] = gateway.set_transports(gateway.Transports(plan=claude, api_key=claude))
        return claude

    yield install
    if "previous" in holder:
        gateway.set_transports(holder["previous"])


def as_run_of(ctx, who: str) -> dict[str, str]:
    """A run token of a run ``who`` created, as it reaches REST (``as_run`` for others)."""
    cookie = make_session_cookie(ctx.users[who])
    return {"cookie": f"{get_settings().session_cookie_name}={cookie}",
            "x-oracle-run-id": str(uuid.uuid4())}  # fmt: skip


async def evidence_hits(client, ctx, intake_id: str, who: str, q: str = "buyers") -> list[dict]:
    resp = await client.get(
        f"/v1/intakes/{intake_id}/evidence", params={"q": q, "limit": 50},
        headers=as_run_of(ctx, who),
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    return resp.json()["hits"]


async def run_view(client, ctx, who: str, item_id) -> tuple[int, bool]:
    """(GET /v1/source-items/{id} status, listed by /v1/search) for ``who``'s run."""
    h = as_run_of(ctx, who)
    status_code = (await client.get(f"/v1/source-items/{item_id}", headers=h)).status_code
    resp = await client.get("/v1/search", params={"q": "buyers", "limit": 100}, headers=h)
    assert resp.status_code == 200, resp.text
    listed = str(item_id) in {h["item"]["id"] for h in resp.json()["hits"]}
    return status_code, listed


# --- item 1 (decision 1): runs read what findings shared in full cite, less withheld --------


async def test_every_run_reads_what_its_intake_search_finds_and_nothing_else(client, fake):
    """All findings shared in full: the author's run and another user's run search the
    cited items in full text here, and read and find the very same items on the sources
    routes; an item no finding cites is neither searched here nor readable by another
    user's run."""
    ctx, intake_id, items = await world(client, fake, hidden=True)
    await share_all(client, ctx, intake_id, "full")
    for who in RUNS:
        hits = await evidence_hits(client, ctx, intake_id, who)
        found = {h["source_item_id"] for h in hits}
        assert {str(items["a"]), str(items["b"])} <= found, who
        assert str(items["h1"]) not in found and str(items["h2"]) not in found, who
        for hit in hits:
            assert hit["visible"] and hit["snippet"], (who, hit)
            assert await run_view(client, ctx, who, hit["source_item_id"]) == (200, True), who
        # Read in full text.
        resp = await client.get(f"/v1/source-items/{items['a']}", headers=as_run_of(ctx, who))
        assert resp.json()["content"] == EXCERPT_A, who
    # Another user's run never reads what no finding cites.
    assert await run_view(client, ctx, "approver", items["h1"]) == (404, False)
    assert await run_view(client, ctx, "approver", items["h2"]) == (404, False)


async def test_a_withheld_item_is_searched_read_and_shown_by_no_run(client, fake):
    """One finding shared in full, the rest private: the intake withholds everything it
    read, so no run (the author's own included) searches, reads, finds or sees the
    excerpt of the full finding's items."""
    ctx, intake_id, items = await world(client, fake, hidden=False)
    conflict = await finding_of(client, ctx, intake_id, "conflict")
    await share(client, ctx, intake_id, conflict["id"], "full")
    for who in RUNS:
        assert await evidence_hits(client, ctx, intake_id, who) == [], who
        for name in ("a", "b", "old"):
            assert await run_view(client, ctx, who, items[name]) == (404, False), (who, name)
        resp = await client.get(f"/v1/intakes/{intake_id}/summary", headers=as_run_of(ctx, who))
        assert resp.status_code == 200, resp.text
        assert EXCERPT_A[:60] not in resp.text and TITLE_A not in resp.text, who
    # People still see the full finding's title and excerpt.
    viewer = await read_summary(client, ctx, intake_id, "viewer")
    assert TITLE_A in json.dumps(viewer)
    # Everything in full: readable again, by every run.
    await share_all(client, ctx, intake_id, "full")
    for who in RUNS:
        assert str(items["a"]) in {h["source_item_id"] for h in await evidence_hits(
            client, ctx, intake_id, who)}  # fmt: skip
        assert await run_view(client, ctx, who, items["a"]) == (200, True), who


# --- item 2 (decision 2): lowering to private withdraws the open proposal ------------------


async def _answer_model_gap(client, ctx) -> KnowledgeGap:
    async with tenant_session(ctx.tenant_id) as s:
        gap = await s.scalar(select(KnowledgeGap).where(KnowledgeGap.statement == MODEL_GAP))
        q = await s.scalar(select(StakeholderQuestion).where(StakeholderQuestion.gap_id == gap.id))
    resp = await client.post(
        f"/v1/questions/{q.id}/answers", json={"kind": "answer", "body": ANSWER},
        headers=ctx.as_("author"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    return gap


async def _status(ctx, proposal_id) -> str:
    async with tenant_session(ctx.tenant_id) as s:
        return (await s.get(Proposal, proposal_id)).status


async def test_private_withdraws_the_open_proposal_and_sharing_again_recreates_it(client, fake):
    ctx, intake_id, _ = await world(client, fake, hidden=False, model=_blocker_gap)
    gap = await _answer_model_gap(client, ctx)
    await share(client, ctx, intake_id, str(gap.id), "summary")
    [first] = await _baseline_proposals(ctx)
    assert ANSWER in json.dumps(first.payload)

    await share(client, ctx, intake_id, str(gap.id), "private")
    assert await _status(ctx, first.id) == "withdrawn"
    listed = await client.get("/v1/baseline/proposals", headers=ctx.as_("owner"))
    assert str(first.id) not in listed.text and ANSWER not in listed.text
    resp = await client.post(f"/v1/baseline/proposals/{first.id}/accept", headers=ctx.as_("owner"))
    assert resp.status_code == 404, resp.text

    # Shared again: a new proposal, at the new level (the question only at counts).
    await share(client, ctx, intake_id, str(gap.id), "counts")
    opened = [p for p in await _baseline_proposals(ctx) if p.status == "open"]
    assert len(opened) == 1 and opened[0].id != first.id
    assert ANSWER not in json.dumps(opened[0].payload)
    await share(client, ctx, intake_id, str(gap.id), "summary")
    [again] = [p for p in await _baseline_proposals(ctx) if p.status == "open"]
    assert again.id == opened[0].id and ANSWER in json.dumps(again.payload)


async def test_decided_proposals_stay_and_the_answer_follows_a_decided_question(client, fake):
    """A question-only proposal is never accepted (409); once rejected it stays rejected
    through every level, and the answer reaches the baseline as a follow-up proposal
    from summary up."""
    ctx, intake_id, _ = await world(client, fake, hidden=False, model=_blocker_gap)
    gap = await _answer_model_gap(client, ctx)
    await share(client, ctx, intake_id, str(gap.id), "counts")
    [question] = await _baseline_proposals(ctx)
    resp = await client.post(
        f"/v1/baseline/proposals/{question.id}/accept", headers=ctx.as_("owner")
    )
    assert resp.status_code == 409, resp.text
    assert "waits for the author to share the answer" in resp.text
    assert await _status(ctx, question.id) == "open"
    resp = await client.post(
        f"/v1/baseline/proposals/{question.id}/reject", headers=ctx.as_("approver")
    )
    assert resp.status_code == 200, resp.text

    await share(client, ctx, intake_id, str(gap.id), "summary")
    rows = await _baseline_proposals(ctx)
    [follow_up] = [p for p in rows if p.id != question.id]
    assert follow_up.status == "open" and ANSWER in json.dumps(follow_up.payload)
    assert await _status(ctx, question.id) == "rejected"
    resp = await client.post(
        f"/v1/baseline/proposals/{follow_up.id}/accept", headers=ctx.as_("owner")
    )
    assert resp.status_code == 200, resp.text
    # Decided proposals stay as decided, whatever the level becomes.
    for level in ("private", "counts", "summary"):
        await share(client, ctx, intake_id, str(gap.id), level)
        assert await _status(ctx, question.id) == "rejected", level
        assert await _status(ctx, follow_up.id) == "accepted", level
        assert len(await _baseline_proposals(ctx)) == 2, level


# --- item 3: what a job, the summary and the lists give away -------------------------------


async def test_an_intake_jobs_input_holds_no_source_text(client, fake):
    """job.input keeps the prompt's name and the snapshot id only, never the rendered
    prompt with the author's excerpts."""
    ctx, intake_id, _ = await world(client, fake, hidden=False)
    async with tenant_session(ctx.tenant_id) as s:
        job = await s.scalar(select(LlmJob).where(LlmJob.intake_id == uuid.UUID(intake_id)))
    assert set(job.input) <= {"snapshot_id", "prompt"}
    for headers in [ctx.as_(w) for w in OTHERS] + [as_run_of(ctx, w) for w in RUNS]:
        resp = await client.get(f"/v1/llm-jobs/{job.id}", headers=headers)
        assert resp.status_code == 200, resp.text
        for secret in (CODENAME, EXCERPT_A[:40], EXCERPT_OLD[:40], TITLE_A):
            assert secret not in resp.text


# --- minors ----------------------------------------------------------------------------------


async def test_an_unregistered_model_gap_keeps_its_intakes_reads_withheld(client, fake):
    """A model-written gap with no registry entry (written before S6) is private, so
    the intake withholds what it read even when every registered finding is full."""
    ctx, intake_id, items = await world(client, fake, hidden=False)
    await share_all(client, ctx, intake_id, "full")
    assert (await run_view(client, ctx, "author", items["a"]))[0] == 200
    async with tenant_session(ctx.tenant_id) as s:
        intake = await s.get(ProductIntake, uuid.UUID(intake_id))
        gap = await s.scalar(select(KnowledgeGap).where(KnowledgeGap.statement == MODEL_GAP))
        findings_ = {k: v for k, v in intake.analysis["findings"].items() if k != str(gap.id)}
        intake.analysis = {**intake.analysis, "findings": findings_}
        await s.flush()
        await ev.record_reads(s, intake)
        await s.commit()
    for who in RUNS:
        assert await run_view(client, ctx, who, items["a"]) == (404, False), who


async def test_two_writers_recording_the_same_intakes_reads_never_conflict(client, fake):
    ctx, intake_id, _ = await world(client, fake, hidden=False)
    iid = uuid.UUID(intake_id)
    async with tenant_session(ctx.tenant_id) as s:
        await s.execute(delete(IntakeWithheldItem))
        await s.commit()
    async with tenant_session(ctx.tenant_id) as s1, tenant_session(ctx.tenant_id) as s2:
        await ev.record_reads(s1, await s1.get(ProductIntake, iid))
        second = asyncio.create_task(ev.record_reads(s2, await s2.get(ProductIntake, iid)))
        await asyncio.sleep(0.5)  # s2's insert now waits on s1's rows
        await s1.commit()
        await second
        await s2.commit()
    async with tenant_session(ctx.tenant_id) as s:
        count = await s.scalar(select(func.count()).select_from(IntakeWithheldItem))
        expected = len(ev.read_item_ids(await s.get(ProductIntake, iid)))
    assert count == expected > 0


async def test_lowering_to_private_audits_the_finding_id_only(client, fake):
    ctx, intake_id, _ = await world(client, fake, hidden=False)
    conflict = await finding_of(client, ctx, intake_id, "conflict")
    await share(client, ctx, intake_id, conflict["id"], "counts")
    await share(client, ctx, intake_id, conflict["id"], "private")
    async with tenant_session(ctx.tenant_id) as s:
        events = (
            await s.scalars(
                select(AuditEvent)
                .where(AuditEvent.action == "intake.finding_shared")
                .order_by(AuditEvent.created_at)
            )
        ).all()
    shared, lowered = events
    assert shared.data["kind"] == "conflict"
    assert lowered.data["finding_id"] == conflict["id"]
    assert "kind" not in lowered.data and "category" not in lowered.data


async def test_a_stale_finding_at_summary_shows_no_confidence(client, fake):
    """The confidence counts freshness, which the summary level hides."""
    ctx, intake_id, _ = await world(client, fake, hidden=False)
    stale = await finding_of(client, ctx, intake_id, "stale")
    await share(client, ctx, intake_id, stale["id"], "summary")
    for who in OTHERS:
        [row] = (await read_summary(client, ctx, intake_id, who))["stale"]
        assert row["evidence"]["confidence"] is None, who
    await share(client, ctx, intake_id, stale["id"], "full")
    [row] = (await read_summary(client, ctx, intake_id, "viewer"))["stale"]
    assert row["evidence"]["confidence"] is not None
    mine = (await read_summary(client, ctx, intake_id, "author"))["stale"]
    assert mine[0]["evidence"]["confidence"] is not None
    assert [f for f in await findings(client, ctx, intake_id) if f["kind"] == "stale"]
