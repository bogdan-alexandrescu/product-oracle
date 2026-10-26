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

import asyncio
import re
import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from oracle import db
from oracle.config import get_settings
from oracle.docs import service as docs_service
from oracle.docs.models import Citation, Document, DocumentVersion
from oracle.docs.parser import DraftError
from oracle.docs.schemas import ImportProblem
from oracle.models import AuditEvent
from oracle.runs import flows
from oracle.runs import service as run_service
from oracle.runs.models import Checkpoint, Run
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from oracle.tenancy import TenantSession, tenant_session
from tests.fixtures import draft, import_draft, seed_auth, seed_oracle_refs
from tests.test_runs import BAD_PRD, as_user, decide, get, pending, started, tick

# Only the PRD review stops: the draft segment (5) is the one that waits.
OFF = {
    "baseline_confirm": False,
    "feature_set": False,
    "eng_review": False,
    "eng_dates": False,
    "priority_order": False,
}
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
    tenant_id, auth = await seed_auth()
    await seed_oracle_refs(tenant_id)
    return tenant_id, auth


def _older_oracle(monkeypatch) -> None:
    """The import refuses every draft, as an Oracle that did not know source 'oracle'."""

    async def refuse(markdown: str):
        raise DraftError([ImportProblem(code="invalid_citation", message=OLDER, cite_key="o-g1")])

    monkeypatch.setattr(docs_service, "parse_draft_async", refuse)


def _retry_url(run, seq: int = 5) -> str:
    return f"/v1/runs/{run['id']}/segments/{seq}/retry-draft-import"


async def _rejected(
    client,
    auth,
    runtime,
    monkeypatch,
    prd: str | None = ORACLE_PRD,
    document="example-prd",
    by=None,
):
    """A baseline_to_prd run waiting at its PRD review with its draft refused; ``by``
    starts it (the owner ``auth`` by default)."""
    _older_oracle(monkeypatch)
    files = {} if prd is None else {"prd.md": prd}
    runtime.script["prd_draft"] = [Outcome(artifacts=files)]
    run = await started(client, by or auth, document=document, checkpoints=OFF)
    for _ in range(4):
        await tick(client, auth)
    monkeypatch.undo()
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint" and run["waiting_on"] == "prd_review"
    assert run["segments"][4]["draft_import"]["error"]
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
    seg = run["segments"][4]
    assert OLDER in seg["draft_import"]["error"] and seg["draft_import"]["version"] is None
    assert seg["can_retry_draft_import"] is True
    assert run["document_id"] is None
    assert OLDER in pending(run)["payload"]["import"]["error"]
    assert pending(run)["cannot_approve"] == NOT_IMPORTED

    resp = await client.post(_retry_url(run), headers=auth)
    assert resp.status_code == 200, resp.text
    run = resp.json()
    seg = run["segments"][4]
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
    assert run["segments"][4]["draft_import"]["version"] == 1


async def test_a_draft_still_rejected_keeps_the_new_error(client, owner, runtime, monkeypatch):
    tenant_id, auth = owner
    run = await _rejected(client, auth, runtime, monkeypatch, prd=BAD_PRD)
    before = run["segments"][4]["draft_import"]["error"]
    assert OLDER in before

    resp = await client.post(_retry_url(run), headers=auth)
    assert resp.status_code == 200, resp.text
    run = resp.json()
    seg = run["segments"][4]
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
    assert ok["segments"][4]["draft_import"]["version"] == 1
    assert ok["segments"][4]["can_retry_draft_import"] is False
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
    seg = run["segments"][4]
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
    assert run["segments"][4]["can_retry_draft_import"] is False
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
    assert seen["segments"][4]["can_retry_draft_import"] is False
    resp = await client.post(_retry_url(run), headers=approver)
    assert resp.status_code == 403, resp.text
    assert "owner" in resp.json()["detail"]

    run = await get(client, auth, run["id"])
    assert run["segments"][4]["can_retry_draft_import"] is True
    resp = await client.post(_retry_url(run), headers=auth)
    assert resp.status_code == 200, resp.text
    run = resp.json()
    imp = run["segments"][4]["draft_import"]
    assert imp["error"] is None and (imp["slug"], imp["version"]) == ("example-prd", 1)
    assert run["document_id"] == imp["document_id"]
    assert run["segments"][4]["can_retry_draft_import"] is False
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


async def test_refused_when_the_slug_now_names_another_document(
    client, owner, runtime, monkeypatch
):
    """The run was to create example-prd; once it finished without it, someone else
    created a document of that slug. The retry must not add the run's draft to it."""
    tenant_id, auth = owner
    run = await _rejected(client, auth, runtime, monkeypatch)
    await _approved_while_refused(tenant_id, run["id"])
    other = draft("prd_v1.md").replace("document: checkout-redesign", "document: example-prd")
    created = await import_draft(client, auth, other, doc="example-prd")
    assert created.status_code == 201, created.text

    resp = await client.post(_retry_url(run), headers=auth)
    assert resp.status_code == 409, resp.text
    assert "example-prd now names another document" in resp.json()["detail"]
    async with tenant_session(tenant_id) as s:
        assert await s.scalar(select(DocumentVersion.number)) == 1
        stored = await s.get(Run, uuid.UUID(run["id"]))
        assert stored.document_id is None
    assert await _retried(tenant_id) == []


async def test_a_burst_of_retries_imports_a_few_at_a_time(client, owner, runtime, monkeypatch):
    """Each retry imports in a session of its own (two connections, no lock held): a burst
    is bounded (DRAFT_RETRY_SLOTS at a time per process), so it cannot take every
    connection of the pool."""
    tenant_id, auth = owner
    runs = []
    for slug in ("prd-a", "prd-b", "prd-c"):
        prd = ORACLE_PRD.replace("document: example-prd", f"document: {slug}")
        runs.append(await _rejected(client, auth, runtime, monkeypatch, prd=prd, document=slug))
    real = docs_service.import_draft
    active = peak = 0

    async def slow(*args, **kwargs):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        try:
            await asyncio.sleep(0.3)
            return await real(*args, **kwargs)
        finally:
            active -= 1

    monkeypatch.setattr(docs_service, "import_draft", slow)
    answers = await asyncio.gather(*(client.post(_retry_url(r), headers=auth) for r in runs))
    assert [a.status_code for a in answers] == [200, 200, 200], [a.text for a in answers]
    assert peak <= 2 == run_service.DRAFT_RETRY_SLOTS
    assert sorted(a.json()["segments"][4]["draft_import"]["slug"] for a in answers) == [
        "prd-a",
        "prd-b",
        "prd-c",
    ]


async def test_refused_on_a_cancelled_or_failed_run(client, owner, runtime, monkeypatch):
    tenant_id, auth = owner
    cancelled = await _rejected(client, auth, runtime, monkeypatch)
    resp = await client.post(f"/v1/runs/{cancelled['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    assert resp.json()["segments"][4]["can_retry_draft_import"] is False
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
    assert failed["status"] == "failed" and failed["segments"][4]["draft_import"]["error"]
    assert failed["segments"][4]["can_retry_draft_import"] is False
    resp = await client.post(_retry_url(failed), headers=auth)
    assert resp.status_code == 409 and "failed" in resp.json()["detail"]
    assert await _retried(tenant_id) == []


async def test_the_checkpoint_approver_role_retries(client, owner, runtime, monkeypatch):
    tenant_id, auth = owner
    run = await _rejected(client, auth, runtime, monkeypatch)
    for role in ("viewer", "commenter"):
        headers = await as_user(tenant_id, role)
        seen = await get(client, headers, run["id"])
        assert seen["segments"][4]["can_retry_draft_import"] is False
        resp = await client.post(_retry_url(run), headers=headers)
        assert resp.status_code == 403, (role, resp.text)
    # An approver who did not create the run may: the review's approver role decides.
    approver = await as_user(tenant_id, "approver")
    assert (await get(client, approver, run["id"]))["segments"][4]["can_retry_draft_import"]
    resp = await client.post(_retry_url(run), headers=approver)
    assert resp.status_code == 200, resp.text
    assert resp.json()["segments"][4]["draft_import"]["version"] == 1


async def test_a_retry_imports_with_the_run_row_unlocked(client, owner, runtime, monkeypatch):
    """#589 review, MAJOR 1: the import's own session is never opened while the retry
    holds the run's row lock. Two other requests wait on that row (a tick, a cancel) and
    hold the rest of a small pool: the retry still completes."""
    tenant_id, auth = owner
    run = await _rejected(client, auth, runtime, monkeypatch)
    rid = uuid.UUID(run["id"])

    async def lock_the_run() -> None:
        async with tenant_session(tenant_id) as s:
            await s.execute(select(Run.id).where(Run.id == rid).with_for_update())
            await asyncio.sleep(0.2)
            await s.commit()

    real = docs_service.import_draft
    waiters: list[asyncio.Task] = []

    async def crowded(*args, **kwargs):
        waiters.extend(asyncio.create_task(lock_the_run()) for _ in range(2))
        await asyncio.sleep(0.5)  # they take the pool's other connections, then the lock
        return await real(*args, **kwargs)

    monkeypatch.setattr(docs_service, "import_draft", crowded)
    with pytest.MonkeyPatch.context() as pool:
        engine = create_async_engine(
            get_settings().database_url, pool_size=3, max_overflow=0, pool_timeout=3
        )
        pool.setattr(db, "_engine", engine)
        pool.setattr(
            db,
            "_sessionmaker",
            async_sessionmaker(engine, expire_on_commit=False, sync_session_class=TenantSession),
        )
        try:
            resp = await client.post(_retry_url(run), headers=auth)
            await asyncio.gather(*waiters)
        finally:
            await engine.dispose()
    assert resp.status_code == 200, resp.text
    imp = resp.json()["segments"][4]["draft_import"]
    assert imp["error"] is None and (imp["slug"], imp["version"]) == ("example-prd", 1)
    assert len(waiters) == 2


async def test_a_retry_never_imports_into_a_document_created_meanwhile(
    client, owner, runtime, monkeypatch
):
    """#589 review, MAJOR 2: a member creates a document of the run's slug after the
    retry's check and before its import. The import refuses; the member's document keeps
    its one version."""
    tenant_id, auth = owner
    run = await _rejected(client, auth, runtime, monkeypatch)
    await _approved_while_refused(tenant_id, run["id"])
    other = draft("prd_v1.md").replace("document: checkout-redesign", "document: example-prd")
    real = docs_service.import_draft

    async def raced(*args, **kwargs):
        if kwargs.get("run_id") is not None:  # the retry's import, not the member's
            created = await import_draft(client, auth, other, doc="example-prd")
            assert created.status_code == 201, created.text
        return await real(*args, **kwargs)

    monkeypatch.setattr(docs_service, "import_draft", raced)
    resp = await client.post(_retry_url(run), headers=auth)
    monkeypatch.undo()
    assert resp.status_code == 200, resp.text
    imp = resp.json()["segments"][4]["draft_import"]
    assert imp["version"] is None
    assert "example-prd now names another document" in imp["error"]
    async with tenant_session(tenant_id) as s:
        assert list(await s.scalars(select(DocumentVersion.number))) == [1]
        stored = await s.get(Run, uuid.UUID(run["id"]))
        assert stored.document_id is None


async def test_a_segment_end_import_never_adds_to_another_document(
    client, owner, runtime, monkeypatch
):
    """#589 review (minor): the run was to create example-prd; a member created it while
    the run drafted. The segment-end import refuses instead of adding the run's draft."""
    tenant_id, auth = owner
    runtime.script["prd_draft"] = [Outcome(artifacts={"prd.md": ORACLE_PRD})]
    run = await started(client, auth, document="example-prd", checkpoints=OFF)
    other = draft("prd_v1.md").replace("document: checkout-redesign", "document: example-prd")
    created = await import_draft(client, auth, other, doc="example-prd")
    assert created.status_code == 201, created.text
    for _ in range(4):
        await tick(client, auth)
    run = await get(client, auth, run["id"])
    imp = run["segments"][4]["draft_import"]
    assert imp["version"] is None
    assert "example-prd now names another document" in imp["error"]
    assert run["document_id"] is None
    async with tenant_session(tenant_id) as s:
        assert list(await s.scalars(select(DocumentVersion.number))) == [1]


# --- owner decisions, 2026-10-25 -----------------------------------------------------------


async def _inbox(client, headers) -> dict:
    resp = await client.get("/v1/inbox", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_a_run_that_finished_with_no_document_gets_an_inbox_row(
    client, owner, runtime, monkeypatch
):
    tenant_id, auth = owner
    run = await _rejected(client, auth, runtime, monkeypatch)
    # Still waiting at its review: the review's checkpoint is the Inbox's item, not this.
    assert all(r["id"] != run["id"] for r in (await _inbox(client, auth))["no_documents"])
    await _approved_while_refused(tenant_id, run["id"])

    inbox = await _inbox(client, auth)
    (row,) = [r for r in inbox["no_documents"] if r["id"] == run["id"]]
    # A plain reason and the action to take.
    text = row["no_document"]
    assert text.startswith("example-prd finished without a document:")
    assert "Oracle refused its draft" in text and "Retry import" in text
    assert inbox["total"] >= 1
    # Owners only: they alone retry a finished run's import.
    approver = await as_user(tenant_id, "approver")
    assert (await _inbox(client, approver))["no_documents"] == []

    resp = await client.post(_retry_url(run), headers=auth)
    assert resp.status_code == 200, resp.text
    assert all(r["id"] != run["id"] for r in (await _inbox(client, auth))["no_documents"])


async def test_draft_rejected_clears_once_the_run_succeeded_past_the_refusal(
    client, owner, runtime, monkeypatch
):
    tenant_id, auth = owner
    run = await _rejected(client, auth, runtime, monkeypatch)
    assert (await get(client, auth, run["id"]))["draft_rejected"]
    await _approved_while_refused(tenant_id, run["id"])
    seen = await get(client, auth, run["id"])
    assert seen["status"] == "succeeded" and seen["draft_rejected"] is None
    listed = (await client.get("/v1/runs", headers=auth)).json()
    rows = listed if isinstance(listed, list) else listed["runs"]
    (row,) = [r for r in rows if r["id"] == run["id"]]
    assert row["draft_rejected"] is None
    # The segment still shows what was refused, with Retry import.
    assert seen["segments"][4]["draft_import"]["error"]


async def test_a_retried_import_reads_imported_again_by_the_retrier(
    client, owner, runtime, monkeypatch
):
    """The version stays authored by the run's creator; its history says who imported it
    again and when, in the Company time zone, as the audit records it."""
    from oracle.company_time import stamp
    from oracle.members.names import display_name

    tenant_id, auth = owner
    from oracle.tenant_settings import TenantSetting

    async with tenant_session(tenant_id) as s:
        s.add(TenantSetting(key="company_timezone", value="Europe/Berlin"))
        await s.commit()
    approver = await as_user(tenant_id, "approver", "alex.creator@example.com")
    run = await _rejected(client, auth, runtime, monkeypatch, by=approver)
    await _approved_while_refused(tenant_id, run["id"])
    retrier = await as_user(tenant_id, "owner", "robin.retrier@example.com")
    resp = await client.post(_retry_url(run), headers=retrier)
    assert resp.status_code == 200, resp.text

    (event,) = await _retried(tenant_id)
    versions = (await client.get("/v1/documents/example-prd/versions", headers=auth)).json()
    (v1,) = versions
    async with tenant_session(tenant_id) as s:
        from oracle.auth.models import User

        creator = await s.scalar(select(User).where(User.email == "alex.creator@example.com"))
    assert v1["imported_by"] == str(creator.id)
    assert v1["imported_again"] == (
        f"imported again by {display_name('robin.retrier@example.com')} "
        f"on {stamp(event.created_at, 'Europe/Berlin')}"
    )
    assert "CET" in v1["imported_again"] or "CEST" in v1["imported_again"]


async def test_another_segments_import_keeps_the_retry_refused_in_plain_words(
    client, owner, runtime, monkeypatch
):
    tenant_id, auth = owner
    run = await _rejected(client, auth, runtime, monkeypatch)
    await _approved_while_refused(tenant_id, run["id"])
    # Another segment's retry imported a version of the run's document.
    async with tenant_session(tenant_id) as s:
        from oracle.runs.models import RunSegment

        other = await s.scalar(
            select(RunSegment).where(RunSegment.run_id == uuid.UUID(run["id"]), RunSegment.seq == 3)
        )
        other.artifacts = {
            **(other.artifacts or {}),
            "import": {"slug": "example-prd", "version": 1, "error": None},
        }
        await s.commit()

    seen = await get(client, auth, run["id"])
    seg = seen["segments"][4]
    assert seg["can_retry_draft_import"] is False
    why = seg["draft_retry_refused"]
    assert "already imported example-prd v1" in why and "Start a new run" in why
    resp = await client.post(_retry_url(run), headers=auth)
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert "nothing to retry" in detail and "Start a new run" in detail
    # The segment that imported reads no refusal.
    assert seen["segments"][2]["draft_retry_refused"] is None


# --- #583 review: the No document row clears itself, and old runs do not flood the Inbox --


async def _finished_without_document(client, auth, tenant_id, runtime, monkeypatch, at=None):
    """A run approved past its refused draft, finished ``at`` (now by default)."""
    run = await _rejected(client, auth, runtime, monkeypatch)
    await _approved_while_refused(tenant_id, run["id"])
    if at is not None:
        async with tenant_session(tenant_id) as s:
            (await s.get(Run, uuid.UUID(run["id"]))).finished_at = at
            await s.commit()
    return run


def _rows(inbox: dict, run) -> list[dict]:
    return [r for r in inbox["no_documents"] if r["id"] == run["id"]]


async def test_the_no_document_row_clears_when_a_later_run_imports_the_document(
    client, owner, runtime, monkeypatch
):
    tenant_id, auth = owner
    base = (await _inbox(client, auth))["total"]
    run = await _finished_without_document(client, auth, tenant_id, runtime, monkeypatch)
    inbox = await _inbox(client, auth)
    assert len(_rows(inbox, run)) == 1 and inbox["total"] == base + 1

    # The owner follows the advice: a new run of the same document imports v1.
    runtime.script["prd_draft"] = [Outcome(artifacts={"prd.md": ORACLE_PRD})]
    later = await started(client, auth, document="example-prd", checkpoints=OFF)
    for _ in range(4):
        await tick(client, auth)
    later = await get(client, auth, later["id"])
    assert later["segments"][4]["draft_import"]["version"] == 1

    inbox = await _inbox(client, auth)
    assert _rows(inbox, run) == []
    # The later run waits at its own review: that is the one item left.
    assert inbox["total"] == base + 1
    assert [c["run_id"] for c in inbox["checkpoints"]] == [later["id"]]


async def test_the_no_document_row_clears_on_a_successful_retry(
    client, owner, runtime, monkeypatch
):
    tenant_id, auth = owner
    base = (await _inbox(client, auth))["total"]
    run = await _finished_without_document(client, auth, tenant_id, runtime, monkeypatch)
    inbox = await _inbox(client, auth)
    assert len(_rows(inbox, run)) == 1
    assert inbox["total"] == base + len(inbox["no_documents"]) == base + 1

    resp = await client.post(_retry_url(run), headers=auth)
    assert resp.status_code == 200, resp.text
    inbox = await _inbox(client, auth)
    assert inbox["no_documents"] == [] and inbox["total"] == base


async def test_a_run_that_finished_before_the_row_shipped_gets_none(
    client, owner, runtime, monkeypatch
):
    from oracle.runs.service import NO_DOCUMENT_SINCE

    tenant_id, auth = owner
    base = (await _inbox(client, auth))["total"]
    old = await _finished_without_document(
        client, auth, tenant_id, runtime, monkeypatch, at=datetime(2026, 10, 1, tzinfo=UTC)
    )
    assert datetime(2026, 10, 1, tzinfo=UTC) < NO_DOCUMENT_SINCE
    inbox = await _inbox(client, auth)
    assert _rows(inbox, old) == [] and inbox["total"] == base
    # Its run page still offers Retry import: only the Inbox leaves it out.
    assert (await get(client, auth, old["id"]))["segments"][4]["can_retry_draft_import"] is True


async def test_a_retry_by_oracle_or_the_system_reads_so(client, owner, runtime, monkeypatch):
    """Not "a former member": Oracle's or the system's retry names them."""
    tenant_id, auth = owner
    run = await _finished_without_document(client, auth, tenant_id, runtime, monkeypatch)
    resp = await client.post(_retry_url(run), headers=auth)
    assert resp.status_code == 200, resp.text
    for actor, who in (("oracle", "Oracle"), ("system", "the system")):
        async with tenant_session(tenant_id) as s:
            (event,) = await s.scalars(
                select(AuditEvent).where(AuditEvent.action == "run.draft_import_retried")
            )
            event.actor = actor
            await s.commit()
        (v1,) = (await client.get("/v1/documents/example-prd/versions", headers=auth)).json()
        assert v1["imported_again"].startswith(f"imported again by {who} on ")


async def test_the_no_document_rows_never_read_the_drafts(client, owner, runtime, monkeypatch):
    """protects=the Inbox's No document rows read only the refused import and the kept
    files' names; fails_when=its reads select a run segment's whole artifacts (the drafts'
    text) again; no_claim=the Inbox's other rows (Sent back by Oracle reads active runs'
    segments) or the run page, which reads the drafts it shows."""
    from sqlalchemy import event

    from oracle.db import get_engine
    from oracle.runs import service as runs_service

    tenant_id, auth = owner
    run = await _finished_without_document(client, auth, tenant_id, runtime, monkeypatch)
    statements: list[str] = []
    reading = False
    no_documents = runs_service._no_documents

    async def watched(db):
        nonlocal reading
        reading = True
        try:
            return await no_documents(db)
        finally:
            reading = False

    def seen(conn, cursor, statement, *args):
        if reading:
            statements.append(statement)

    monkeypatch.setattr(runs_service, "_no_documents", watched)
    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", seen)
    try:
        inbox = await _inbox(client, auth)
    finally:
        event.remove(engine, "before_cursor_execute", seen)
    assert len(_rows(inbox, run)) == 1 and statements
    # A whole artifacts column, not one of its keys (artifacts['import'], artifacts -> 'import').
    whole = re.compile(r"run_segments\.artifacts(?!\s*(->|#>|\[))")
    assert not [s for s in statements if whole.search(s)]
