"""A refused draft goes back to the writer before a person is asked (owner, 2026-10-20).

Adapter v2 runs the last segment's checkpoint as ``work -> review1 -> revise1 -> review2
(-> revise2)`` in one SwarmCloud workflow. When the segment-end import refuses the draft
at review1 of the workflow's last segment, Oracle answers review1 itself with NOT_YET and
the import's problems, grouped in plain words, as findings; revise1 fixes the draft and
Oracle imports it again when review2 opens. Only a draft still refused then reaches the
Inbox. The answer is Oracle's: noted on the segment and audited with actor ``oracle``,
no checkpoint decided, no person's decision, the W5 hold kept, nothing approved. An
earlier segment's checkpoint (one round, no revise step) is left to the person.

While the revision runs, the run reads "Revising: sent back by Oracle", not "Draft
rejected" (``SegmentOut.sent_back``, ``RunSummary.sent_back``), and the Inbox shows it
as a row with nothing to decide (``InboxOut.revising``, not in ``total``)."""

import json
import uuid
from dataclasses import replace

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.models import AuditEvent
from oracle.runs import flows, service
from oracle.runs.models import Checkpoint
from oracle.swarm.fake import _default_content
from oracle.tenancy import tenant_session
from tests.fixtures import seed_auth
from tests.swarmcloud_fake import FakeSwarmCloud
from tests.test_adapter_v2 import REVIEW_LEAD, feedback_doc, on, use
from tests.test_adapter_v2 import settings as _v2_settings
from tests.test_priorities import _token
from tests.test_runs import decide, get, pending, started, tick

# The same environment as test_adapter_v2 (Oracle's public URL, default timings).
settings = _v2_settings

NOT_IMPORTED = "the draft was not imported: retry import, or request changes"
# Refused at import: a citation source Oracle does not know, and a chip with no citation.
BAD_PRD = (
    "---\n"
    "title: Example product PRD\n"
    "citations:\n"
    "  - id: c1\n"
    "    source: jira\n"
    "    ref: https://example.atlassian.net/browse/X-1\n"
    "---\n\n"
    "# Example product PRD {#title}\n\n"
    "## Problem {#problem}\n\n"
    "Buyers drop off late [c:c1] and early [c:c2].\n"
)
WRITER = "next_draft-2-writer"


@pytest.fixture
async def owner():
    return await seed_auth()


async def _feedback_run(client, auth, tenant_id, swarm: FakeSwarmCloud) -> dict:
    use(swarm)
    await feedback_doc(client, auth, tenant_id)
    return await started(client, auth, flow="feedback_loop", document="checkout-redesign")


async def _audit(tenant_id, action: str) -> list[AuditEvent]:
    async with tenant_session(tenant_id) as s:
        return list(await s.scalars(select(AuditEvent).where(AuditEvent.action == action)))


async def _checkpoints(tenant_id, run_id: str) -> list[Checkpoint]:
    async with tenant_session(tenant_id) as s:
        return list(
            await s.scalars(select(Checkpoint).where(Checkpoint.run_id == uuid.UUID(run_id)))
        )


async def _hold(tenant_id, run_id: str) -> str | None:
    async with tenant_session(tenant_id) as s:
        return await service.token_hold(s, uuid.UUID(run_id))


async def _inbox(client, auth) -> dict:
    return (await client.get("/v1/inbox", headers=auth)).json()


async def _listed(client, auth, run_id: str) -> dict:
    [row] = [r for r in (await client.get("/v1/runs", headers=auth)).json() if r["id"] == run_id]
    return row


def _counted(inbox: dict) -> int:
    """What the Inbox counts (``total``): a revising row is shown, never counted."""
    kinds = ("checkpoints", "approvals", "overruns", "lookups", "imports")
    return sum(len(inbox[k]) for k in kinds) + inbox["counts"]["new"] + inbox["counts"]["open"]


async def test_a_refused_draft_goes_back_to_the_writer_then_to_the_person(client, owner):
    tenant_id, auth = owner
    swarm = on()
    swarm.step_files[WRITER] = {"prd.md": BAD_PRD}
    run = await _feedback_run(client, auth, tenant_id, swarm)

    # review1 parks, the import refuses the draft: Oracle answers review1 itself.
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "running", run
    assert [c for c in run["checkpoints"] if c["status"] == "pending"] == []
    assert await _checkpoints(tenant_id, run["id"]) == []
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    assert inbox["checkpoints"] == []
    [answer] = swarm.answers
    assert answer["step_id"] == "next_draft-review1" and answer["workflow_id"] == "wf_1"
    assert answer.get("on_behalf_of") is None
    payload = answer["payload"]
    assert payload["verdict"] == "NOT_YET"
    findings = payload["findings"]
    assert "could not import prd.md" in findings[0]
    [cites] = [f for f in findings if f.startswith("Citations:")]
    assert "[c:c2]" in cites and "citation #1 (c1)" in cites
    # The contract, in plain words, with the allowed sources.
    assert "oracle" in cites and "web" in cites
    seg = run["segments"][0]
    assert seg["draft_import"]["error"]
    assert any("Oracle sent" in n and "back to the writer" in n for n in run["notes"]), run["notes"]
    # The revision's attempt carries Oracle's findings, as Oracle's.
    assert len(seg["attempts"]) == 2
    assert seg["attempts"][-1]["note_by"] == "Oracle"
    assert "Citations:" in seg["attempts"][-1]["note"]
    # Audited as Oracle's, never a person's, and no checkpoint decision.
    [event] = await _audit(tenant_id, "run.draft_sent_back")
    assert event.actor == "oracle"
    assert event.data["step_id"] == "next_draft-review1" and event.data["verdict"] == "NOT_YET"
    assert await _audit(tenant_id, "checkpoint.changes_requested") == []
    # W5: Oracle's answer is not one that counts: the token stays read-only.
    assert await _hold(tenant_id, run["id"]) is not None
    # Revising, not rejected: the run, the runs list and the Inbox say Oracle sent the
    # draft back, with what it refused; nothing asks a person to decide.
    refused = seg["draft_import"]["summary"]
    assert refused.startswith("Oracle refused prd.md: ")
    assert seg["sent_back"] is True
    assert run["sent_back"] == refused and run["draft_rejected"] is None
    row = await _listed(client, auth, run["id"])
    assert row["sent_back"] == refused and row["draft_rejected"] is None
    [revising] = inbox["revising"]
    assert revising["id"] == run["id"] and revising["sent_back"] == refused
    assert revising["status"] == "running" and revising["waiting_on"] is None
    assert inbox["total"] == _counted(inbox)
    # Shown to those who would decide the review: not below its approver role.
    assert (await _inbox(client, await _token(tenant_id, "commenter")))["revising"] == []
    assert len((await _inbox(client, await _token(tenant_id, "approver")))["revising"]) == 1

    # revise1 writes a draft Oracle accepts: imported when review2 opens, for the person.
    await tick(client, auth)
    revise = swarm.workflows["wf_1"].step("next_draft-revise1")
    assert "[c:c2]" in revise.staged["prd.md"]
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint" and run["waiting_on"] == "prd_review"
    cp = pending(run)
    assert cp["payload"]["wait"]["step_id"] == "next_draft-review2"
    assert cp["payload"]["import"]["version"] == 2
    assert cp["cannot_approve"] is None
    assert len(swarm.answers) == 1
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    assert [c["id"] for c in inbox["checkpoints"]] == [cp["id"]]
    # The clean revision clears it: no longer revising, nothing rejected.
    assert run["segments"][0]["sent_back"] is False
    assert run["sent_back"] is None and run["draft_rejected"] is None
    assert inbox["revising"] == []
    assert (await _listed(client, auth, run["id"]))["sent_back"] is None

    # The person approves review2: the run ends with the revised draft.
    run = await decide(client, auth, run, "approved")
    assert run["status"] == "succeeded"
    assert swarm.answers[-1]["step_id"] == "next_draft-review2"
    assert swarm.answers[-1]["payload"]["verdict"] == "MERGE"


async def test_a_draft_still_refused_after_the_revision_opens_the_inbox(client, owner):
    tenant_id, auth = owner
    swarm = on()
    swarm.step_files[WRITER] = {"prd.md": BAD_PRD}
    swarm.step_files["next_draft-revise1"] = {"prd.md": BAD_PRD}
    run = await _feedback_run(client, auth, tenant_id, swarm)
    await tick(client, auth)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint" and run["waiting_on"] == "prd_review"
    cp = pending(run)
    # The person's wait: review2, left open for them (Retry import / Request changes).
    assert cp["payload"]["wait"]["step_id"] == "next_draft-review2"
    assert cp["payload"]["import"]["error"]
    assert cp["cannot_approve"] == NOT_IMPORTED
    assert [a["step_id"] for a in swarm.answers] == ["next_draft-review1"]
    assert swarm.workflows["wf_1"].step("next_draft-review2").state == "PARKED"
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    assert [c["id"] for c in inbox["checkpoints"]] == [cp["id"]]
    assert len(await _audit(tenant_id, "run.draft_sent_back")) == 1
    # Back with the person: Draft rejected (the revision's refusal), no longer revising.
    seg = run["segments"][0]
    assert seg["sent_back"] is False
    assert run["sent_back"] is None and run["draft_rejected"] == seg["draft_import"]["summary"]
    assert inbox["revising"] == []

    # The person requests changes: posted for them, and revise2 runs. The draft is still
    # refused, so the import's problems follow the structured review and its note (D4, D5
    # Re-run keeps its output).
    run = await decide(client, auth, run, "changes_requested", note="Cite the Slack thread")
    assert run["status"] == "running"
    assert swarm.answers[-1]["step_id"] == "next_draft-review2"
    assert swarm.answers[-1]["payload"] == {
        "verdict": "NOT_YET",
        "findings": [
            REVIEW_LEAD.format(attempt=2),
            "Note: Cite the Slack thread",
            "Oracle's check found these problems in prd.md; fix each one:",
            cp["payload"]["import"]["summary"],
        ],
    }


async def test_an_earlier_segments_refused_draft_is_left_to_the_person(client, owner, monkeypatch):
    """One round, no revise step: the next segment depends on the checkpoint, so Oracle
    does not answer it; the person retries the import or requests changes."""
    tenant_id, auth = owner
    b2p = flows.FLOWS["baseline_to_prd"]
    # A draft segment that is not the workflow's last.
    flow = replace(b2p, segments=(b2p.segment("prd_draft"), b2p.segment("priority")))
    monkeypatch.setitem(flows.FLOWS, "baseline_to_prd", flow)
    swarm = on()
    swarm.step_files["prd_draft-2-critic"] = {"prd.md": BAD_PRD}
    use(swarm)
    run = await started(client, auth, document="example-prd")
    [body] = swarm.submissions()
    assert "prd_draft-revise1" not in [s["step_id"] for s in body["steps"]]
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint" and run["waiting_on"] == "prd_review"
    cp = pending(run)
    assert cp["payload"]["wait"]["step_id"] == "prd_draft-review1"
    assert cp["payload"]["import"]["error"]
    assert cp["cannot_approve"] == NOT_IMPORTED
    assert swarm.answers == []
    assert await _audit(tenant_id, "run.draft_sent_back") == []
    assert swarm.workflows["wf_1"].step("prd_draft-review1").state == "PARKED"


async def test_an_accepted_draft_is_not_answered_by_oracle(client, owner):
    tenant_id, auth = owner
    swarm = on()
    run = await _feedback_run(client, auth, tenant_id, swarm)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint"
    assert pending(run)["payload"]["wait"]["step_id"] == "next_draft-review1"
    assert swarm.answers == []


async def test_a_run_cancelled_while_revising_reads_draft_rejected(client, owner):
    """Revising holds only while the revision can still land: once the run ends, the
    refused draft reads as rejected again, and the Inbox row goes."""
    tenant_id, auth = owner
    swarm = on()
    swarm.step_files[WRITER] = {"prd.md": BAD_PRD}
    run = await _feedback_run(client, auth, tenant_id, swarm)
    await tick(client, auth)
    assert (await get(client, auth, run["id"]))["segments"][0]["sent_back"] is True
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    run = await get(client, auth, run["id"])
    assert run["status"] == "cancelled"
    seg = run["segments"][0]
    assert seg["sent_back"] is False
    assert run["sent_back"] is None and run["draft_rejected"] == seg["draft_import"]["summary"]
    assert (await _inbox(client, auth))["revising"] == []


async def test_a_send_back_whose_commit_was_lost_is_replayed_once(client, owner, monkeypatch):
    """SwarmCloud took Oracle's NOT_YET, then the transaction that records it was lost:
    the next tick sends the draft back again with the same answer id and payload (a
    replay), and the run records one send-back."""
    tenant_id, auth = owner
    swarm = on()
    swarm.step_files[WRITER] = {"prd.md": BAD_PRD}
    run = await _feedback_run(client, auth, tenant_id, swarm)

    real_send_back, real_commit = service._send_back, AsyncSession.commit
    armed: list[bool] = []

    async def send_back(*args, **kwargs):
        sent = await real_send_back(*args, **kwargs)
        if sent and not armed:
            armed.append(True)
        return sent

    async def commit(self):
        if armed and armed[-1]:
            armed[-1] = False
            await self.rollback()
            raise ConnectionError("the commit after the send-back was lost")
        return await real_commit(self)

    monkeypatch.setattr(service, "_send_back", send_back)
    monkeypatch.setattr(AsyncSession, "commit", commit)
    resp = await client.post("/v1/internal/tick", headers=auth)
    assert resp.status_code == 200, resp.text
    assert resp.json()["errors"] == [f"run {run['id']}: ConnectionError"]
    assert armed == [False]
    # Posted to SwarmCloud, recorded nowhere in Oracle.
    assert len(swarm.answers) == 1
    assert await _audit(tenant_id, "run.draft_sent_back") == []
    assert (await get(client, auth, run["id"]))["segments"][0]["sent_back"] is False

    await tick(client, auth)
    posts = [
        json.loads(r.content)
        for r in swarm.requests
        if r.method == "POST" and r.url.path.endswith("/steps/next_draft-review1/input")
    ]
    assert len(posts) == 2 and posts[0] == posts[1]
    answer_id = str(uuid.uuid5(uuid.UUID(run["id"]), "send-back/wf_1/next_draft-review1"))
    assert posts[1]["answer_id"] == answer_id
    assert posts[1]["payload"]["verdict"] == "NOT_YET"
    # The second post was a replay: SwarmCloud recorded one answer.
    [answer] = swarm.answers
    assert answer["answer_id"] == answer_id and answer["payload"] == posts[0]["payload"]
    run = await get(client, auth, run["id"])
    assert run["status"] == "running", run
    assert await _checkpoints(tenant_id, run["id"]) == []
    [event] = await _audit(tenant_id, "run.draft_sent_back")
    assert event.data["findings"] == answer["payload"]["findings"]
    assert sum("Oracle sent" in n and "back to the writer" in n for n in run["notes"]) == 1
    seg = run["segments"][0]
    assert seg["sent_back"] is True and len(seg["attempts"]) == 2
    assert seg["attempts"][-1]["note_by"] == "Oracle"

    # The revision proceeds once: review2 opens for the person.
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint", run
    assert pending(run)["payload"]["wait"]["step_id"] == "next_draft-review2"
    assert len(swarm.answers) == 1
    assert len(await _audit(tenant_id, "run.draft_sent_back")) == 1


# e2e-draft-codes: a draft that imports but names a code nowhere goes back to the writer
# too, with the codes to name; the milestone's name reads like prose (invented data).
UNNAMED_PRD = _default_content("prd.md", "next_draft", 1).replace(
    "Serves G1 (activation).",
    "Serves G1 first; it is not expected to move at M3 200 teams and 50 seats, and "
    "onboarding at scale.",
)


async def test_a_draft_with_unnamed_codes_goes_back_to_the_writer_first(client, owner):
    tenant_id, auth = owner
    swarm = on()
    swarm.step_files[WRITER] = {"prd.md": UNNAMED_PRD}
    run = await _feedback_run(client, auth, tenant_id, swarm)

    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "running", run
    assert await _checkpoints(tenant_id, run["id"]) == []
    [answer] = swarm.answers
    assert answer["step_id"] == "next_draft-review1"
    assert answer["payload"]["verdict"] == "NOT_YET"
    findings = answer["payload"]["findings"]
    assert "codes" in findings[0] and "prd.md" in findings[0]
    [line] = [f for f in findings if "Goal trace" in f]
    assert "G1" in line and "M3" in line
    assert any("M3 (its name)" in f for f in findings)
    seg = run["segments"][0]
    assert seg["sent_back"] is True
    assert seg["attempts"][-1]["note_by"] == "Oracle"
    assert any("Oracle sent" in n and "back to the writer" in n for n in run["notes"])
    [event] = await _audit(tenant_id, "run.draft_sent_back")
    assert event.actor == "oracle" and event.data["findings"] == findings

    # revise1 names its codes: imported when review2 opens, for the person.
    await tick(client, auth)
    revise = swarm.workflows["wf_1"].step("next_draft-revise1")
    assert "M3" in revise.staged["prd.md"]
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint" and run["waiting_on"] == "prd_review"
    cp = pending(run)
    assert cp["payload"]["wait"]["step_id"] == "next_draft-review2"
    assert cp["payload"]["import"]["version"] == 2
    assert "unnamed_code" not in cp["payload"]["import"]["warnings"]
    assert len(swarm.answers) == 1


async def test_codes_still_unnamed_after_the_revision_say_which_at_the_review(client, owner):
    tenant_id, auth = owner
    swarm = on()
    swarm.step_files[WRITER] = {"prd.md": UNNAMED_PRD}
    swarm.step_files["next_draft-revise1"] = {"prd.md": UNNAMED_PRD}
    run = await _feedback_run(client, auth, tenant_id, swarm)
    await tick(client, auth)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint" and run["waiting_on"] == "prd_review"
    cp = pending(run)
    assert cp["payload"]["wait"]["step_id"] == "next_draft-review2"
    # Imported, never refused: the person reads which codes still lack names.
    imported = cp["payload"]["import"]
    assert imported["version"] == 2 and "unnamed_code" in imported["warnings"]
    [names] = imported["code_names"]
    assert "Goal trace: G1, M3" in names
    assert [a["step_id"] for a in swarm.answers] == ["next_draft-review1"]
    # A person's request for changes passes the same lines on to the writer.
    run = await decide(client, auth, run, "changes_requested", note="Name the milestone")
    assert any("Goal trace: G1, M3" in f for f in swarm.answers[-1]["payload"]["findings"])
