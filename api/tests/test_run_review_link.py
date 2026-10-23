"""D10: a run's PRD or roadmap review is decided in the version view (one review place).

A run that imported a draft waits at ``prd_review``; its review follows the document
review of that version: ``GET .../versions/{n}/run-review`` finds it, approving the last
section or publishing the version approves it (``via: document_review``), and Send back
carries the document's own feedback as the structured review file."""

import uuid

import pytest
import yaml
from sqlalchemy import select

from oracle.docs.models import Document, Section
from oracle.jobs.models import LlmSuggestion
from oracle.models import AuditEvent
from oracle.review import publish_gate
from oracle.review.models import FeedbackItem
from oracle.runs import review_link
from oracle.runs.models import Checkpoint
from oracle.tenancy import tenant_session
from tests.fixtures import draft, import_draft, seed_auth
from tests.swarmcloud_fake import FakeSwarmCloud
from tests.test_adapter_v2 import feedback_doc, on, use
from tests.test_adapter_v2 import settings as _v2_settings
from tests.test_runs import as_user, get, pending, runtime, started, tick

__all__ = ["runtime"]
DOC = "checkout-redesign"
NOTHING = "Nothing to send back: comment, request changes on a section, or write a note."


@pytest.fixture
async def owner():
    return await seed_auth()


async def _waiting(client, auth) -> tuple[dict, dict]:
    """A feedback-loop run waiting at prd_review on the v2 it imported."""
    assert (await import_draft(client, auth, draft("prd_v1.md"))).status_code == 201
    run = await started(client, auth, flow="feedback_loop", document=DOC)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["waiting_on"] == "prd_review"
    cp = pending(run)
    assert cp["payload"]["import"]["version"] == 2
    return run, cp


async def _keys(tenant_id, n: int = 2) -> list[str]:
    from oracle.docs.models import DocumentVersion

    async with tenant_session(tenant_id) as s:
        version = await s.scalar(select(DocumentVersion).where(DocumentVersion.number == n))
        return list(
            await s.scalars(
                select(Section.section_key)
                .where(Section.version_id == version.id)
                .order_by(Section.ordinal)
            )
        )


async def _verdict(client, auth, key: str, verdict: str = "approved", n: int = 2):
    resp = await client.put(
        f"/v1/documents/{DOC}/versions/{n}/sections/{key}/review",
        json={"verdict": verdict, "note": None if verdict == "approved" else "Tighten it"},
        headers=auth,
    )
    assert resp.status_code == 200, resp.text
    return resp


async def _checkpoint(tenant_id, cp_id: str) -> Checkpoint:
    async with tenant_session(tenant_id) as s:
        return await s.get(Checkpoint, uuid.UUID(cp_id))


async def _audits(tenant_id, action: str) -> list[AuditEvent]:
    async with tenant_session(tenant_id) as s:
        return list(await s.scalars(select(AuditEvent).where(AuditEvent.action == action)))


async def _send_back(client, auth, run, cp, note=None):
    return await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/decide",
        json={"decision": "changes_requested", "note": note},
        headers=auth,
    )


async def _feedback(tenant_id, open_items: int, staged: int, version: int = 2) -> None:
    async with tenant_session(tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == DOC))
        # The feedback loop's import may settle what it was sent: start from none open.
        for item in await s.scalars(select(FeedbackItem).where(FeedbackItem.status == "open")):
            item.status = "addressed"
        for i in range(open_items):
            s.add(
                FeedbackItem(
                    document_id=doc.id,
                    raised_on_version=version,
                    kind="general",
                    summary=f"Open point {i + 1}",
                )
            )
        for i in range(staged):
            item = FeedbackItem(
                document_id=doc.id,
                raised_on_version=version,
                kind="comment",
                section_key="problem",
                summary=f"Staged point {i + 1}",
            )
            s.add(item)
            await s.flush()
            s.add(
                LlmSuggestion(
                    document_id=doc.id,
                    feedback_item_id=item.id,
                    version_number=version,
                    classification="change_request",
                    kind="section_text",
                    section_key="problem",
                    text="Buyers abandon checkout at the payment step.",
                    status="accepted",
                )
            )
        await s.commit()


async def test_run_review_matches_the_version_the_run_imported(client, owner, runtime):
    tenant_id, auth = owner
    run, cp = await _waiting(client, auth)
    keys = await _keys(tenant_id)
    await _verdict(client, auth, keys[0])
    await _verdict(client, auth, keys[1], "changes_requested")

    resp = await client.get(f"/v1/documents/{DOC}/versions/2/run-review", headers=auth)
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["checkpoint_id"] == cp["id"] and out["run_id"] == run["id"]
    assert out["kind"] == "prd_review" and out["status"] == "pending"
    assert out["flow_title"] == run["flow_title"]
    assert out["approver_role"] == "approver" and out["can_decide"] is True
    # The outline's "N of M reviewed": a verdict of any kind counts as reviewed.
    assert out["sections"] == {"total": len(keys), "reviewed": 2, "approved": 1}
    assert out["feedback"]["verdicts"] == 1
    assert out["wait"]["state"] == "none"
    # v1 was not made by the run.
    missing = await client.get(f"/v1/documents/{DOC}/versions/1/run-review", headers=auth)
    assert missing.status_code == 404
    # Every client opens the same place.
    assert cp["review_link"] == f"/documents/{DOC}/v/2?run_review={cp['id']}"
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    assert inbox["checkpoints"][0]["review_link"] == cp["review_link"]
    [listed] = [
        r for r in (await client.get("/v1/runs", headers=auth)).json() if r["id"] == run["id"]
    ]
    assert listed["review_link"] == cp["review_link"]


async def test_a_commenter_reads_the_run_review_without_deciding(client, owner, runtime):
    tenant_id, auth = owner
    await _waiting(client, auth)
    commenter = await as_user(tenant_id, "commenter")
    resp = await client.get(f"/v1/documents/{DOC}/versions/2/run-review", headers=commenter)
    assert resp.status_code == 200, resp.text
    assert resp.json()["can_decide"] is False


async def test_approving_the_last_section_approves_the_run_review(client, owner, runtime):
    tenant_id, auth = owner
    run, cp = await _waiting(client, auth)
    keys = await _keys(tenant_id)
    for key in keys[:-1]:
        await _verdict(client, auth, key)
    assert (await _checkpoint(tenant_id, cp["id"])).status == "pending"

    await _verdict(client, auth, keys[-1])
    assert (await _checkpoint(tenant_id, cp["id"])).status == "approved"
    assert (await get(client, auth, run["id"]))["status"] == "succeeded"
    [event] = await _audits(tenant_id, "checkpoint.approved")
    assert event.data["via"] == "document_review"
    review = await client.get(f"/v1/documents/{DOC}/versions/2/run-review", headers=auth)
    assert review.json()["status"] == "approved" and review.json()["can_decide"] is False


async def test_publishing_the_version_approves_the_run_review(client, owner, runtime):
    tenant_id, auth = owner
    run, cp = await _waiting(client, auth)
    resp = await client.post(f"/v1/documents/{DOC}/versions/2/approve", headers=auth)
    assert resp.status_code == 200, resp.text
    assert (await _checkpoint(tenant_id, cp["id"])).status == "approved"
    [event] = await _audits(tenant_id, "checkpoint.approved")
    assert event.data["via"] == "document_review"
    assert (await get(client, auth, run["id"]))["status"] == "succeeded"


async def test_a_publish_the_gate_refuses_decides_nothing(client, owner, runtime, monkeypatch):
    tenant_id, auth = owner
    _, cp = await _waiting(client, auth)

    async def blocked(*_a, **_kw):
        raise publish_gate.PublishBlocked("Not ready to publish", [])

    monkeypatch.setattr(publish_gate, "check", blocked)
    resp = await client.post(f"/v1/documents/{DOC}/versions/2/approve", headers=auth)
    assert resp.status_code == 409, resp.text
    assert (await _checkpoint(tenant_id, cp["id"])).status == "pending"


async def test_a_failure_in_the_link_keeps_the_review_and_the_checkpoint(
    client, owner, runtime, monkeypatch
):
    tenant_id, auth = owner
    _, cp = await _waiting(client, auth)

    async def broken(*_a, **_kw):
        raise RuntimeError("boom")

    monkeypatch.setattr(review_link, "_decide", broken)
    for key in await _keys(tenant_id):
        await _verdict(client, auth, key)
    assert (await _checkpoint(tenant_id, cp["id"])).status == "pending"
    review = await client.get(f"/v1/documents/{DOC}/versions/2/run-review", headers=auth)
    assert review.json()["can_decide"] is True


async def test_send_back_carries_the_documents_feedback(client, owner, runtime):
    tenant_id, auth = owner
    run, cp = await _waiting(client, auth)
    await _feedback(tenant_id, open_items=3, staged=1)
    review = await client.get(f"/v1/documents/{DOC}/versions/2/run-review", headers=auth)
    assert review.json()["feedback"] == {"open": 3, "staged": 1, "verdicts": 0}

    resp = await _send_back(client, auth, run, cp)
    assert resp.status_code == 200, resp.text
    stored = await _checkpoint(tenant_id, cp["id"])
    assert stored.status == "changes_requested"
    sent = yaml.safe_load(stored.payload["review_file"])
    assert stored.note is None
    assert sent["checkpoint"] == "prd_review" and sent["file"] == "prd.md"
    assert len(sent["entries"]) == 4
    assert all(e["action"] == "change" for e in sent["entries"])
    [staged] = [e for e in sent["entries"] if e.get("accepted_text")]
    assert staged["section"] == "problem"
    assert staged["accepted_text"] == "Buyers abandon checkout at the payment step."
    assert {e["section"] for e in sent["entries"]} == {"general", "problem"}
    assert "general_note" not in sent
    # Segment mode: the YAML is the change request.
    assert "checkpoint: prd_review" in runtime.submitted[-1].steps[-1].prompt


async def test_send_back_with_nothing_open_and_no_note_is_refused(client, owner, runtime):
    tenant_id, auth = owner
    run, cp = await _waiting(client, auth)
    await _feedback(tenant_id, open_items=0, staged=0)
    resp = await _send_back(client, auth, run, cp)
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"] == NOTHING
    assert (await _checkpoint(tenant_id, cp["id"])).status == "pending"
    # A note alone is enough.
    resp = await _send_back(client, auth, run, cp, note="Shorten the rollout")
    assert resp.status_code == 200, resp.text
    stored = await _checkpoint(tenant_id, cp["id"])
    assert stored.note == "Shorten the rollout"
    sent = yaml.safe_load(stored.payload["review_file"])
    assert sent["entries"] == [] and sent["general_note"] == "Shorten the rollout"


settings = _v2_settings


async def test_send_back_in_workflow_mode_posts_one_finding_per_entry(client, owner, settings):
    tenant_id, auth = owner
    swarm: FakeSwarmCloud = on()
    use(swarm)
    await feedback_doc(client, auth, tenant_id)
    run = await started(client, auth, flow="feedback_loop", document=DOC)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    cp = pending(run)
    assert cp["payload"]["wait"]["step_id"] == "next_draft-review1"
    await _feedback(tenant_id, open_items=2, staged=1)

    resp = await _send_back(client, auth, run, cp, note="Keep it short")
    assert resp.status_code == 200, resp.text
    [answer] = swarm.answers
    findings = answer["payload"]["findings"]
    assert answer["payload"]["verdict"] == "NOT_YET"
    assert len(findings) == 4  # three entries and the note
    assert any(f.startswith("general: Open point 1") for f in findings)
    assert any(f.startswith("problem: Staged point 1") for f in findings)
    assert findings[-1] == "Keep it short"


async def _decider(client, tenant_id, auth) -> tuple[uuid.UUID, dict[str, str]]:
    """An approver named the document's designated decider (review policy)."""
    from oracle.auth.service import create_user, make_session_cookie
    from oracle.config import get_settings

    async with tenant_session(tenant_id) as s:
        user = await create_user(s, "dana.decider@example.com", "pw")
        user.role = "approver"
        await s.commit()
    resp = await client.put(
        f"/v1/documents/{DOC}/review-policy", json={"decider_id": str(user.id)}, headers=auth
    )
    assert resp.status_code == 200, resp.text
    return user.id, {"Cookie": f"{get_settings().session_cookie_name}={make_session_cookie(user)}"}


async def test_only_the_designated_decider_decides_the_run_review(client, owner, runtime):
    tenant_id, auth = owner
    run, cp = await _waiting(client, auth)
    decider_id, decider = await _decider(client, tenant_id, auth)
    await _feedback(tenant_id, open_items=1, staged=0)

    # Someone else, even an owner, reads who decides and may not decide.
    review = (await client.get(f"/v1/documents/{DOC}/versions/2/run-review", headers=auth)).json()
    assert review["can_decide"] is False
    assert review["decider_id"] == str(decider_id) and review["decider_name"] == "Dana Decider"
    approve = await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/decide",
        json={"decision": "approved"},
        headers=auth,
    )
    assert approve.status_code == 403, approve.text
    assert approve.json()["detail"] == "Only the designated decider decides this run review"
    sent = await _send_back(client, auth, run, cp, note="Shorten it")
    assert sent.status_code == 403, sent.text
    assert (await _checkpoint(tenant_id, cp["id"])).status == "pending"

    # The decider may.
    mine = (await client.get(f"/v1/documents/{DOC}/versions/2/run-review", headers=decider)).json()
    assert mine["can_decide"] is True
    resp = await _send_back(client, decider, run, cp)
    assert resp.status_code == 200, resp.text
    assert (await _checkpoint(tenant_id, cp["id"])).status == "changes_requested"


async def test_the_last_section_approves_the_run_review_only_when_the_decider_gives_it(
    client, owner, runtime
):
    """Owner, 2026-10-22: with a designated decider, someone else's approval of the last
    section leaves the run review pending for the decider; the decider's approval of the
    last section approves it."""
    tenant_id, auth = owner
    run, cp = await _waiting(client, auth)
    decider_id, decider = await _decider(client, tenant_id, auth)
    keys = await _keys(tenant_id)
    for key in keys:
        await _verdict(client, auth, key)
    assert (await _checkpoint(tenant_id, cp["id"])).status == "pending"
    assert (await get(client, auth, run["id"]))["status"] == "awaiting_checkpoint"
    assert await _audits(tenant_id, "checkpoint.approved") == []
    review = (await client.get(f"/v1/documents/{DOC}/versions/2/run-review", headers=auth)).json()
    assert review["status"] == "pending" and review["sections"]["approved"] == len(keys)
    assert review["decider_id"] == str(decider_id) and review["can_decide"] is False
    mine = (await client.get(f"/v1/documents/{DOC}/versions/2/run-review", headers=decider)).json()
    assert mine["can_decide"] is True

    # The decider gives the last section's approval: the run review is approved.
    await _verdict(client, decider, keys[-1], "changes_requested")
    await _verdict(client, decider, keys[-1])
    assert (await _checkpoint(tenant_id, cp["id"])).status == "approved"
    [event] = await _audits(tenant_id, "checkpoint.approved")
    assert event.data["via"] == "document_review"
    assert (await get(client, auth, run["id"]))["status"] == "succeeded"
