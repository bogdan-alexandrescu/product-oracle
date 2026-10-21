"""Retry import of a run's rejected draft (owner, 2026-10-20).

A segment that imports a draft and whose import was refused keeps the error, and the
run waits at its review with no draft imported. POST
/v1/runs/{id}/segments/{seq}/retry-draft-import imports the saved draft again (an Oracle
that now accepts it, or a cause that went away), for the checkpoint's approver role or
above, while that checkpoint is pending. The SwarmCloud wait is untouched: the person
still decides at the checkpoint.

Approving that review is refused while the draft is not imported (owner, 2026-10-20);
a run whose review was approved before that finished without a document, and an owner
retries its import after the run finished.
"""

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from oracle.docs import service as docs_service
from oracle.docs.models import Citation, Document, DocumentVersion
from oracle.docs.parser import DraftError
from oracle.docs.schemas import ImportProblem
from oracle.models import AuditEvent
from oracle.runs import flows
from oracle.runs.models import Checkpoint, Run
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from oracle.tenancy import tenant_session
from tests.fixtures import draft, seed_auth
from tests.test_runs import BAD_PRD, as_user, decide, get, pending, started, tick

# Only the PRD review stops: the draft segment (4) is the one that waits.
OFF = {"baseline_confirm": False, "feature_set": False, "priority_order": False}
ORACLE_PRD = draft("prd_oracle_citations.md")
OLDER = "citation #1 (o-g1) is invalid: source"
NOT_IMPORTED = "the draft was not imported: retry import, or request changes"


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


@pytest.fixture
async def owner():
    return await seed_auth()


def _older_oracle(monkeypatch) -> None:
    """The import refuses every draft, as an Oracle that did not know source 'oracle'."""

    async def refuse(markdown: str):
        raise DraftError([ImportProblem(code="invalid_citation", message=OLDER, cite_key="o-g1")])

    monkeypatch.setattr(docs_service, "parse_draft_async", refuse)


def _retry_url(run, seq: int = 4) -> str:
    return f"/v1/runs/{run['id']}/segments/{seq}/retry-draft-import"


async def _rejected(
    client, auth, runtime, monkeypatch, prd: str | None = ORACLE_PRD, document="example-prd"
):
    """A baseline_to_prd run waiting at its PRD review with its draft refused."""
    _older_oracle(monkeypatch)
    files = {} if prd is None else {"prd.md": prd}
    runtime.script["prd_draft"] = [Outcome(artifacts=files)]
    run = await started(client, auth, document=document, checkpoints=OFF)
    for _ in range(4):
        await tick(client, auth)
    monkeypatch.undo()
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint" and run["waiting_on"] == "prd_review"
    assert run["segments"][3]["draft_import"]["error"]
    return run


async def _approved_while_refused(tenant_id, run_id: str) -> None:
    """The live case: the review was approved while its draft was refused (before approval
    was refused for that), so the run finished with no document."""
    async with tenant_session(tenant_id) as s:
        run = await s.get(Run, uuid.UUID(run_id))
        cp = await s.scalar(
            select(Checkpoint).where(Checkpoint.run_id == run.id, Checkpoint.status == "pending")
        )
        cp.status, cp.decided_at = "approved", datetime.now(UTC)
        run.status, run.finished_at = "succeeded", datetime.now(UTC)
        await s.commit()


async def _decide(client, headers, run, decision="approved", note=None):
    return await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{pending(run)['id']}/decide",
        json={"decision": decision, "note": note},
        headers=headers,
    )


async def _retried(tenant_id) -> list[AuditEvent]:
    async with tenant_session(tenant_id) as s:
        return list(
            await s.scalars(
                select(AuditEvent)
                .where(AuditEvent.action == "run.draft_import_retried")
                .order_by(AuditEvent.created_at)
            )
        )


async def test_a_rejected_draft_is_imported_by_retry(client, owner, runtime, monkeypatch):
    tenant_id, auth = owner
    run = await _rejected(client, auth, runtime, monkeypatch)
    seg = run["segments"][3]
    assert OLDER in seg["draft_import"]["error"] and seg["draft_import"]["version"] is None
    assert seg["can_retry_draft_import"] is True
    assert run["document_id"] is None
    assert OLDER in pending(run)["payload"]["import"]["error"]
    assert pending(run)["cannot_approve"] == NOT_IMPORTED

    resp = await client.post(_retry_url(run), headers=auth)
    assert resp.status_code == 200, resp.text
    run = resp.json()
    seg = run["segments"][3]
    imp = seg["draft_import"]
    assert imp["error"] is None
    assert (imp["slug"], imp["version"], imp["created"]) == ("example-prd", 1, True)
    assert seg["can_retry_draft_import"] is False
    # As at segment end: the run now names the document, and the checkpoint shows the import.
    assert run["document_id"] == imp["document_id"]
    cp = pending(run)
    assert cp["payload"]["import"]["version"] == 1 and "error" not in cp["payload"]["import"]
    assert cp["cannot_approve"] is None
    # Nothing is decided: the person still decides at the review.
    assert run["status"] == "awaiting_checkpoint" and run["waiting_on"] == "prd_review"
    assert any("retried importing prd.md" in n for n in run["notes"])

    async with tenant_session(tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == "example-prd"))
        assert doc is not None and str(doc.id) == run["document_id"]
        assert await s.scalar(select(DocumentVersion.number)) == 1
        assert sorted(await s.scalars(select(Citation.source))) == ["oracle", "oracle", "slack"]
    (event,) = await _retried(tenant_id)
    assert event.entity == "run" and str(event.entity_id) == run["id"]
    assert event.data["segment"] == "prd_draft" and event.data["version"] == 1
    assert OLDER in event.data["previous_error"] and event.data.get("error") is None

    # Idempotent: a second retry finds nothing to retry, and imports nothing.
    again = await client.post(_retry_url(run), headers=auth)
    assert again.status_code == 409 and "nothing to retry" in again.json()["detail"]
    assert len(await _retried(tenant_id)) == 1

    run = await decide(client, auth, run)
    assert run["status"] == "succeeded"
    assert run["segments"][3]["draft_import"]["version"] == 1


async def test_a_draft_still_rejected_keeps_the_new_error(client, owner, runtime, monkeypatch):
    tenant_id, auth = owner
    run = await _rejected(client, auth, runtime, monkeypatch, prd=BAD_PRD)
    before = run["segments"][3]["draft_import"]["error"]
    assert OLDER in before

    resp = await client.post(_retry_url(run), headers=auth)
    assert resp.status_code == 200, resp.text
    run = resp.json()
    seg = run["segments"][3]
    after = seg["draft_import"]["error"]
    assert after != before and "prd.md was rejected" in after and "front_matter" in after
    # The new problems (the findings if the draft goes back to the writer) and their
    # summary replace the old ones too.
    imp = pending(run)["payload"]["import"]
    assert set(imp) == {"error", "problems", "summary"} and imp["error"] == after
    assert [p["code"] for p in imp["problems"]] == ["missing_front_matter"]
    assert imp["summary"] == seg["draft_import"]["summary"]
    assert imp["summary"].startswith("Oracle refused prd.md: draft must start with YAML")
    assert pending(run)["cannot_approve"] == NOT_IMPORTED
    # Still waiting, still retryable, no document.
    assert seg["can_retry_draft_import"] is True
    assert run["status"] == "awaiting_checkpoint" and run["document_id"] is None
    (event,) = await _retried(tenant_id)
    assert event.data["error"] == after and event.data["previous_error"] == before


async def test_nothing_to_retry_is_refused(client, owner, runtime, monkeypatch):
    _, auth = owner
    # A draft that imported: no error to retry.
    ok = await started(client, auth, checkpoints=OFF)
    for _ in range(4):
        await tick(client, auth)
    ok = await get(client, auth, ok["id"])
    assert ok["segments"][3]["draft_import"]["version"] == 1
    assert ok["segments"][3]["can_retry_draft_import"] is False
    resp = await client.post(_retry_url(ok), headers=auth)
    assert resp.status_code == 409 and "nothing to retry" in resp.json()["detail"]
    # A segment that imports no draft, and one the run does not have.
    assert (await client.post(_retry_url(ok, 1), headers=auth)).status_code == 409
    assert (await client.post(_retry_url(ok, 9), headers=auth)).status_code == 404
    missing = {**ok, "id": str(uuid.uuid4())}
    assert (await client.post(_retry_url(missing), headers=auth)).status_code == 404


async def test_a_segment_that_left_no_draft_is_refused(client, owner, runtime, monkeypatch):
    _, auth = owner
    run = await _rejected(client, auth, runtime, monkeypatch, prd=None)
    seg = run["segments"][3]
    assert seg["draft_import"]["error"] == "the segment left no prd.md"
    assert seg["can_retry_draft_import"] is False
    resp = await client.post(_retry_url(run), headers=auth)
    assert resp.status_code == 409 and "prd.md" in resp.json()["detail"]


async def test_refused_once_changes_are_requested(client, owner, runtime, monkeypatch):
    tenant_id, auth = owner
    # Changes requested: the segment runs again; its old review is decided.
    run = await _rejected(client, auth, runtime, monkeypatch)
    run = await decide(client, auth, run, "changes_requested", "Fix the citations")
    assert run["status"] == "running"
    assert run["segments"][3]["can_retry_draft_import"] is False
    resp = await client.post(_retry_url(run), headers=auth)
    assert resp.status_code == 409, resp.text
    assert await _retried(tenant_id) == []


async def test_approve_is_refused_while_the_draft_is_not_imported(
    client, owner, runtime, monkeypatch
):
    tenant_id, auth = owner
    run = await _rejected(client, auth, runtime, monkeypatch)
    assert pending(run)["cannot_approve"] == NOT_IMPORTED
    # Every path is the one decide: the web, the Inbox and MCP (decide_checkpoint).
    for headers in (auth, await as_user(tenant_id, "approver")):
        resp = await _decide(client, headers, run)
        assert resp.status_code == 409, resp.text
        assert resp.json()["detail"] == NOT_IMPORTED
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint" and pending(run)["status"] == "pending"
    assert run["document_id"] is None
    async with tenant_session(tenant_id) as s:
        actions = set(await s.scalars(select(AuditEvent.action)))
    assert "checkpoint.approved" not in actions
    # Request changes stays allowed: the segment runs again with the note.
    resp = await _decide(client, auth, run, "changes_requested", "Fix the citations")
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "running"


async def test_after_the_run_finished_an_owner_retries(client, owner, runtime, monkeypatch):
    tenant_id, auth = owner
    run = await _rejected(client, auth, runtime, monkeypatch)
    await _approved_while_refused(tenant_id, run["id"])

    # Owners only once the run finished: an approver may not.
    approver = await as_user(tenant_id, "approver")
    seen = await get(client, approver, run["id"])
    assert seen["status"] == "succeeded" and seen["document_id"] is None
    assert seen["segments"][3]["can_retry_draft_import"] is False
    resp = await client.post(_retry_url(run), headers=approver)
    assert resp.status_code == 403, resp.text
    assert "owner" in resp.json()["detail"]

    run = await get(client, auth, run["id"])
    assert run["segments"][3]["can_retry_draft_import"] is True
    resp = await client.post(_retry_url(run), headers=auth)
    assert resp.status_code == 200, resp.text
    run = resp.json()
    imp = run["segments"][3]["draft_import"]
    assert imp["error"] is None and (imp["slug"], imp["version"]) == ("example-prd", 1)
    assert run["document_id"] == imp["document_id"]
    assert run["segments"][3]["can_retry_draft_import"] is False
    # Nothing about the run's checkpoints changes; the import is recorded on the review.
    assert run["status"] == "succeeded"
    review = next(c for c in run["checkpoints"] if c["kind"] == "prd_review")
    assert review["status"] == "approved" and review["payload"]["import"]["version"] == 1
    assert any("retried importing prd.md" in n for n in run["notes"])
    async with tenant_session(tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == "example-prd"))
        # The new version goes through the document's own review.
        assert doc is not None and doc.status == "draft"
    (event,) = await _retried(tenant_id)
    assert event.data["version"] == 1 and OLDER in event.data["previous_error"]

    # Idempotent: a version from this run exists now.
    again = await client.post(_retry_url(run), headers=auth)
    assert again.status_code == 409 and "nothing to retry" in again.json()["detail"]
    assert len(await _retried(tenant_id)) == 1


async def test_refused_on_a_cancelled_or_failed_run(client, owner, runtime, monkeypatch):
    tenant_id, auth = owner
    cancelled = await _rejected(client, auth, runtime, monkeypatch)
    resp = await client.post(f"/v1/runs/{cancelled['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    assert resp.json()["segments"][3]["can_retry_draft_import"] is False
    resp = await client.post(_retry_url(cancelled), headers=auth)
    assert resp.status_code == 409 and "cancelled" in resp.json()["detail"]

    # With the review off, a refused draft fails the run.
    _older_oracle(monkeypatch)
    runtime.script["prd_draft"] = [Outcome(artifacts={"prd.md": ORACLE_PRD})]
    off = dict.fromkeys(flows.FLOWS["baseline_to_prd"].checkpoints, False)
    failed = await started(client, auth, document="other-prd", checkpoints=off)
    for _ in range(4):
        await tick(client, auth)
    monkeypatch.undo()
    failed = await get(client, auth, failed["id"])
    assert failed["status"] == "failed" and failed["segments"][3]["draft_import"]["error"]
    assert failed["segments"][3]["can_retry_draft_import"] is False
    resp = await client.post(_retry_url(failed), headers=auth)
    assert resp.status_code == 409 and "failed" in resp.json()["detail"]
    assert await _retried(tenant_id) == []


async def test_the_checkpoint_approver_role_retries(client, owner, runtime, monkeypatch):
    tenant_id, auth = owner
    run = await _rejected(client, auth, runtime, monkeypatch)
    for role in ("viewer", "commenter"):
        headers = await as_user(tenant_id, role)
        seen = await get(client, headers, run["id"])
        assert seen["segments"][3]["can_retry_draft_import"] is False
        resp = await client.post(_retry_url(run), headers=headers)
        assert resp.status_code == 403, (role, resp.text)
    # An approver who did not create the run may: the review's approver role decides.
    approver = await as_user(tenant_id, "approver")
    assert (await get(client, approver, run["id"]))["segments"][3]["can_retry_draft_import"]
    resp = await client.post(_retry_url(run), headers=approver)
    assert resp.status_code == 200, resp.text
    assert resp.json()["segments"][3]["draft_import"]["version"] == 1
