"""A5 Members and access, part 2: the removal and demotion preview (AC 13-15).

Synthetic placeholders only (example.com)."""

import asyncio
import uuid
from datetime import UTC, datetime
from decimal import Decimal

import pytest
from sqlalchemy import func, select

from oracle import readiness
from oracle.auth.service import create_api_token
from oracle.models import AuditEvent
from oracle.tenancy import tenant_session
from tests.review_v2_helpers import DOC, person, setup, states, verdict
from tests.test_review_v2_security_4 import add_oauth_connection, oauth_grant
from tests.test_review_v2_security_6 import (  # noqa: F401 (runtime: a fixture)
    _at_checkpoint,
    _decide,
    runtime,
)


@pytest.fixture(autouse=True)
def _only_test_checks():
    with readiness.isolated_checks():
        yield


async def impact(client, ctx, user_id, **params) -> dict:
    resp = await client.get(f"/v1/members/{user_id}/impact", params=params, headers=ctx.auth)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def audits(ctx, action: str) -> list[AuditEvent]:
    async with tenant_session(ctx.tenant_id) as s:
        return list(
            await s.scalars(
                select(AuditEvent)
                .where(AuditEvent.action == action)
                .order_by(AuditEvent.created_at)
            )
        )


async def _decided_while_down(client, ctx, runtime, headers):  # noqa: F811
    """A checkpoint decision by ``headers`` not delivered yet (SwarmCloud was down)."""
    from oracle.swarm import RuntimeUnavailable

    run = await _at_checkpoint(client, ctx)
    real = runtime.submit

    async def down(spec):
        raise RuntimeUnavailable("SwarmCloud is down")

    runtime.submit = down
    resp = await _decide(client, run, headers)
    assert resp.status_code == 200, resp.text
    runtime.submit = real
    return run


async def _approvals(client, ctx, who) -> None:
    """Three section approvals and one version approval by ``who``."""
    keys = list(await states(client, ctx.auth, 1))[:3]
    for key in keys:
        assert (await verdict(client, who.headers, 1, key)).status_code == 200
    resp = await client.post(ctx.v(1, "/approve"), headers=who.headers)
    assert resp.status_code == 200, resp.text


async def _seed_removal(client, ctx, runtime):  # noqa: F811
    """The member of AC 13: 2 tokens, 1 grant, 1 connection with 2 sources, 1 running
    run, 1 queued job, 1 unstarted spend approval on another member's run, 1 undelivered
    checkpoint decision, 3 section approvals, 1 version approval, 1 open invite."""
    from oracle.docs.models import Document
    from oracle.jobs.models import LlmJob
    from oracle.runs.models import Run, RunSegment
    from oracle.sources.models import Source

    pm = await person(ctx.tenant_id, "approver", "pm")
    author = await person(ctx.tenant_id, "approver", "author")
    await _decided_while_down(client, ctx, runtime, pm.headers)
    await _approvals(client, ctx, pm)
    resp = await client.post(
        "/v1/invites", json={"email": "friend@example.com", "role": "viewer"}, headers=pm.headers
    )
    assert resp.status_code == 201, resp.text
    await oauth_grant(ctx, pm.user_id)
    conn_id = await add_oauth_connection(ctx, pm.user_id)
    async with tenant_session(ctx.tenant_id) as s:
        for n in (1, 2):
            await create_api_token(s, f"pm-token-{n}", user_id=pm.user_id)
            s.add(
                Source(owner_user_id=pm.user_id, connection_id=conn_id, kind="github",
                       name=f"repo-{n}")
            )  # fmt: skip
        doc_id = await s.scalar(select(Document.id).where(Document.slug == DOC))
        s.add(LlmJob(kind="reporting", document_id=doc_id, requested_by=pm.user_id))
        mine = Run(flow="baseline_to_prd", created_by=pm.user_id, status="running")
        theirs = Run(
            flow="baseline_to_prd",
            created_by=author.user_id,
            status="running",
            estimate_usd=Decimal("40"),
            approved_by=pm.user_id,
            approved_at=datetime.now(UTC),
        )
        s.add_all([mine, theirs])
        await s.flush()
        s.add(RunSegment(run_id=theirs.id, seq=1, name="baseline", status="pending"))
        await s.commit()
        return pm, mine.id, theirs.id


async def test_the_removal_preview_lists_what_the_disable_does(client, runtime):  # noqa: F811
    """protects: the remove dialog shows exactly what the disable then does (AC 13).
    fails_when: a selection and its apply disagree on a token, run, invite, job, spend
    approval, checkpoint decision or lapsed approval.
    no_claim: what the runtime and providers do after the commit."""
    ctx = await setup(client)
    pm, mine, theirs = await _seed_removal(client, ctx, runtime)
    body = await impact(client, ctx, pm.user_id, change="remove")
    ends = body["ends"]
    assert body["change"] == "remove" and body["role"] is None and body["nothing"] is False
    assert ends["sign_in"] is True
    assert (ends["api_tokens"], ends["mcp_clients"], ends["sources"]) == (2, 1, 2)
    assert ends["connections"] == {"github": 1}
    assert (ends["llm_jobs"], ends["invites"]) == (1, 1)
    assert [r["id"] for r in ends["runs"]] == [str(mine)]
    assert ends["runs"][0]["status"] == "running" and ends["runs"][0]["title"]
    assert [v["run_id"] for v in body["voids"]["spend_approvals"]] == [str(theirs)]
    assert len(body["voids"]["checkpoint_decisions"]) == 1
    assert body["lapses"]["section_approvals"] == 3
    assert [(v["document"], v["version"]) for v in body["lapses"]["version_approvals"]] == [
        (DOC, 1)
    ]
    # Counts by provider only: never a repo's name.
    assert "repo-1" not in str(body)

    resp = await client.post(f"/v1/members/{pm.user_id}/disable", headers=ctx.auth)
    assert resp.status_code == 200, resp.text
    [event] = await audits(ctx, "member.disable")
    data = event.data
    assert len(data["api_tokens"]) == ends["api_tokens"]
    assert data["runs"] == [r["id"] for r in ends["runs"]]
    assert len(data["invites"]) == ends["invites"]
    assert len(data["llm_jobs"]) == ends["llm_jobs"]
    assert len(data["sources"]) == ends["sources"]
    assert len(data["connections"]) == sum(ends["connections"].values())
    voids = body["voids"]
    assert sorted(data["run_approvals_voided"]) == sorted(
        [v["run_id"] for v in voids["spend_approvals"] + voids["resumes"]]
    )
    assert data["checkpoint_decisions_voided"] == [
        c["checkpoint_id"] for c in voids["checkpoint_decisions"]
    ]
    assert len(data["section_review_ids"]) == body["lapses"]["section_approvals"]
    assert len(data["version_ids"]) == len(body["lapses"]["version_approvals"])


async def test_the_demotion_preview_lists_what_set_role_does(client, runtime):  # noqa: F811
    """protects: the change-role dialog shows exactly what the demotion voids and lapses
    (AC 13, change=role).
    fails_when: the preview and set_role disagree on a spend approval, a checkpoint
    decision or a lapsed approval.
    no_claim: what the Inbox shows for the returned items."""
    from oracle.runs.models import Run, RunSegment

    ctx = await setup(client)
    boss = await person(ctx.tenant_id, "owner", "boss")
    author = await person(ctx.tenant_id, "approver", "author")
    await _decided_while_down(client, ctx, runtime, boss.headers)
    await _approvals(client, ctx, boss)
    async with tenant_session(ctx.tenant_id) as s:
        run = Run(
            flow="baseline_to_prd",
            created_by=author.user_id,
            status="running",
            estimate_usd=Decimal("40"),
            approved_by=boss.user_id,
            approved_at=datetime.now(UTC),
        )
        s.add(run)
        await s.flush()
        s.add(RunSegment(run_id=run.id, seq=1, name="baseline", status="pending"))
        await s.commit()
        run_id = run.id

    body = await impact(client, ctx, boss.user_id, change="role", role="commenter")
    assert body["ends"] is None and body["role"] == "commenter" and body["nothing"] is False
    voids = body["voids"]
    assert [v["run_id"] for v in voids["spend_approvals"]] == [str(run_id)]
    assert len(voids["checkpoint_decisions"]) == 1
    assert body["lapses"]["section_approvals"] == 3
    assert len(body["lapses"]["version_approvals"]) == 1

    resp = await client.patch(
        f"/v1/members/{boss.user_id}", json={"role": "commenter"}, headers=ctx.auth
    )
    assert resp.status_code == 200, resp.text
    voided_runs = [str(e.entity_id) for e in await audits(ctx, "run.approval_voided")]
    voided_runs += [str(e.entity_id) for e in await audits(ctx, "run.resume_voided")]
    assert sorted(voided_runs) == sorted(
        v["run_id"] for v in voids["spend_approvals"] + voids["resumes"]
    )
    voided_cps = [str(e.entity_id) for e in await audits(ctx, "checkpoint.decision_voided")]
    assert voided_cps == [c["checkpoint_id"] for c in voids["checkpoint_decisions"]]
    [lapse] = await audits(ctx, "approval.lapse")
    assert len(lapse.data["section_review_ids"]) == 3
    assert len(lapse.data["version_ids"]) == 1


async def _counts(ctx) -> dict[str, int]:
    from oracle.auth.models import ApiToken, User
    from oracle.connections.models import Connection
    from oracle.jobs.models import LlmJob
    from oracle.members.models import Invite
    from oracle.review.models import SectionReview
    from oracle.runs.models import Run

    async with tenant_session(ctx.tenant_id) as s:
        out = {}
        for model in (AuditEvent, ApiToken, User, Connection, LlmJob, Invite, SectionReview, Run):
            out[model.__name__] = await s.scalar(select(func.count()).select_from(model))
        out["revoked"] = await s.scalar(
            select(func.count()).select_from(ApiToken).where(ApiToken.revoked_at.is_not(None))
        )
        out["disabled"] = await s.scalar(
            select(func.count()).select_from(User).where(User.disabled_at.is_not(None))
        )
        out["lapsed"] = await s.scalar(
            select(func.count())
            .select_from(SectionReview)
            .where(SectionReview.lapsed_at.is_not(None))
        )
        return out


async def test_a_preview_writes_nothing_and_blocks_no_disable(client, runtime):  # noqa: F811
    """protects: opening the dialog changes nothing and never holds up a change (AC 14).
    fails_when: a preview writes a row or an audit event, or takes a lock a disable
    waits on.
    no_claim: how long a preview takes on a large company."""
    from oracle.members.impact import member_impact

    ctx = await setup(client)
    pm, _, _ = await _seed_removal(client, ctx, runtime)
    before = await _counts(ctx)
    await impact(client, ctx, pm.user_id, change="remove")
    await impact(client, ctx, pm.user_id, change="role", role="viewer")
    assert await _counts(ctx) == before

    # A preview still open in its transaction does not hold up a disable.
    async with tenant_session(ctx.tenant_id) as s:
        await member_impact(s, pm.user_id, "remove")
        resp = await asyncio.wait_for(
            client.post(f"/v1/members/{pm.user_id}/disable", headers=ctx.auth), timeout=30
        )
        assert resp.status_code == 200, resp.text
    assert (await _counts(ctx))["disabled"] == before["disabled"] + 1


async def test_nothing_for_a_promotion_the_same_role_or_a_removed_member(client):
    """protects: the dialog is skipped when the change touches nothing (AC 15).
    fails_when: a promotion, the member's own role or removing a removed member
    reports something.
    no_claim: what the page does with ``nothing``."""
    ctx = await setup(client)
    approver = await person(ctx.tenant_id, "approver", "approver")
    assert (await impact(client, ctx, approver.user_id, change="role", role="owner"))["nothing"]
    assert (await impact(client, ctx, approver.user_id, change="role", role="approver"))["nothing"]
    resp = await client.post(f"/v1/members/{approver.user_id}/disable", headers=ctx.auth)
    assert resp.status_code == 200, resp.text
    body = await impact(client, ctx, approver.user_id, change="remove")
    assert body["nothing"] is True and body["ends"] is None
    resp = await client.get(
        f"/v1/members/{uuid.uuid4()}/impact", params={"change": "remove"}, headers=ctx.auth
    )
    assert resp.status_code == 404


async def test_member_detail_and_approvals(client):
    """protects: the inspector reads how a member joined, what they hold and their
    approvals (3.7).
    fails_when: a held approval or responsibility is missing, or a lapsed approval is
    listed without ``lapsed=true``.
    no_claim: the people list."""
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    await _approvals(client, ctx, pm)
    resp = await client.get(f"/v1/members/{pm.user_id}", headers=ctx.auth)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["id"] == str(pm.user_id) and body["joined"]["via"] in ("seeded", "unknown")
    assert body["holds"]["section_approvals"] == 3 and body["holds"]["version_approvals"] == 1
    resp = await client.get(f"/v1/members/{pm.user_id}/approvals", headers=ctx.auth)
    assert resp.status_code == 200, resp.text
    assert len(resp.json()) == 4
    resp = await client.patch(
        f"/v1/members/{pm.user_id}", json={"role": "commenter"}, headers=ctx.auth
    )
    assert resp.status_code == 200, resp.text
    resp = await client.get(f"/v1/members/{pm.user_id}/approvals", headers=ctx.auth)
    assert resp.json() == []
    resp = await client.get(
        f"/v1/members/{pm.user_id}/approvals", params={"lapsed": "true"}, headers=ctx.auth
    )
    assert len(resp.json()) == 4 and all(a["lapsed_at"] for a in resp.json())
