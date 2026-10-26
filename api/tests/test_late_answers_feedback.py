"""C5 follow-up: an answer given after drafting started becomes feedback on the draft.

The draft run reads the answers pinned when it started; each later answer (an answer
with a body, not "I don't know", defer, delegate or research) becomes one whole-draft
(D13 ``general``) feedback item on the intake's PRD, raised by the person who answered and
linked back to its question, so the next draft takes it like any other feedback. While
the run has not imported its first draft there is nothing to raise it on: the import
raises the ones given meanwhile. Each answer makes one item, once.

Test cards (protects / fails_when / no_claim):

- ``test_a_late_answer_becomes_feedback_on_the_draft``: protects=a late answer reaches
  the next draft; fails_when=no item, an item for a pinned answer, or one twice;
  no_claim=what the next draft writes.

Synthetic placeholders only.
"""

import uuid

from oracle.runs import service as runs_service
from oracle.runs.models import Run
from oracle.tenancy import tenant_session
from tests.intake_helpers import answer, batch, company, intake_with_source
from tests.intake_helpers import summary as read_summary
from tests.test_intake_draft_gate import _create_run, runtime  # noqa: F401 (fixture)
from tests.test_llm_jobs import DRAFT_V1

SLUG = "saved-addresses"
DRAFT = DRAFT_V1.replace("document: onboarding-revamp", f"document: {SLUG}")


async def _started(client, ctx) -> tuple[str, str, list[dict]]:
    out = await intake_with_source(client, ctx)
    intake_id = out["intake"]["id"]
    cards = (await batch(client, ctx, intake_id))["questions"]
    run_id = (await _create_run(client, ctx, intake_id)).json()["id"]
    approver = ctx.as_("approver")
    assert (await client.post(f"/v1/runs/{run_id}/estimate", headers=approver)).status_code == 200
    resp = await client.post(f"/v1/runs/{run_id}/start", headers=approver)
    assert resp.status_code == 200, resp.text
    return intake_id, run_id, cards


async def _import(ctx, run_id: str) -> None:
    """The run's first draft lands (the step's import, as a segment's draft file)."""
    async with tenant_session(ctx.tenant_id) as s:
        run = await s.get(Run, uuid.UUID(run_id))
        out = await runs_service._import_draft(s, run, "prd", DRAFT)
        assert "error" not in out, out


async def _feedback(client, ctx) -> list[dict]:
    resp = await client.get(f"/v1/documents/{SLUG}/feedback", headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_a_late_answer_becomes_feedback_on_the_draft(client, runtime):  # noqa: F811
    ctx = await company()
    out = await intake_with_source(client, ctx)
    intake_id = out["intake"]["id"]
    first, second, third, fourth = (await batch(client, ctx, intake_id))["questions"][:4]
    await answer(client, ctx, first["question"]["id"], body="Returning buyers.")
    run_id = (await _create_run(client, ctx, intake_id)).json()["id"]
    approver = ctx.as_("approver")
    assert (await client.post(f"/v1/runs/{run_id}/estimate", headers=approver)).status_code == 200
    assert (await client.post(f"/v1/runs/{run_id}/start", headers=approver)).status_code == 200

    # Given while the run writes its first draft: nothing to raise it on yet.
    during = await answer(client, ctx, second["question"]["id"], body="Checkout time.")
    await answer(client, ctx, fourth["question"]["id"], kind="dont_know")
    await _import(ctx, run_id)
    [item] = await _feedback(client, ctx)
    assert item["kind"] == "general" and item["section_key"] is None
    assert item["status"] == "open" and item["raised_on_version"] == 1
    assert item["author_id"] == str(ctx.users["commenter"].id)
    assert item["intake_question_id"] == second["question"]["id"]
    assert item["intake_answer_id"] == during["answer"]["id"]
    assert item["intake_id"] == intake_id
    assert "Checkout time." in item["summary"]
    assert second["question"]["prompt"] in item["summary"]

    # Once the draft exists, a later answer becomes an item at once.
    after = await answer(client, ctx, third["question"]["id"], body="Under ten seconds.")
    items = {i["intake_answer_id"]: i for i in await _feedback(client, ctx)}
    assert set(items) == {during["answer"]["id"], after["answer"]["id"]}
    assert items[after["answer"]["id"]]["intake_question_id"] == third["question"]["id"]
    # A second import raises nothing twice.
    await _import(ctx, run_id)
    assert len(await _feedback(client, ctx)) == 2
    s = await read_summary(client, ctx, intake_id)
    assert s["answers_since_run"] == 3
    assert s["late_answers_as_feedback"] == 2
    assert (s["draft_document"], s["draft_version"]) == (SLUG, 1)


async def test_answers_before_drafting_make_no_feedback(client, runtime):  # noqa: F811
    ctx = await company()
    intake_id, run_id, cards = await _started(client, ctx)
    await _import(ctx, run_id)
    assert await _feedback(client, ctx) == []
    s = await read_summary(client, ctx, intake_id)
    assert s["answers_since_run"] == 0 and s["late_answers_as_feedback"] == 0


async def _private_answer(client) -> tuple:
    """A drafted intake whose model question's finding is private, answered late."""
    from tests.test_intake_sharing_round4 import _model_question, _privacy_gap, authored_with

    holder: dict = {}

    def install(answer):
        from oracle.llm import gateway
        from tests.test_intake_jobs import FakeClaude

        claude = FakeClaude(answer)
        holder["previous"] = gateway.set_transports(gateway.Transports(plan=claude, api_key=claude))

    try:
        ctx, intake_id, _items = await authored_with(client, install, _privacy_gap)
    finally:
        if "previous" in holder:
            from oracle.llm import gateway

            gateway.set_transports(holder["previous"])
    q = await _model_question(ctx, intake_id)
    run_id = (await _create_run(client, ctx, intake_id)).json()["id"]
    approver = ctx.as_("approver")
    assert (await client.post(f"/v1/runs/{run_id}/estimate", headers=approver)).status_code == 200
    assert (await client.post(f"/v1/runs/{run_id}/start", headers=approver)).status_code == 200
    await _import(ctx, run_id)

    # Answered while the finding is private: counted on the intake page, no feedback.
    body = "Addresses are stored encrypted."
    resp = await client.post(
        f"/v1/questions/{q.id}/answers",
        json={"kind": "answer", "body": body},
        headers=ctx.as_("author"),
    )
    assert resp.status_code == 201, resp.text
    assert await _feedback(client, ctx) == []
    return ctx, intake_id, str(q.gap_id), body


async def test_a_late_answer_hides_while_its_finding_is_not_shared_in_full(
    client,
    runtime,  # noqa: F811
):
    """#587 review MAJOR 2: the feedback item quoting an answer follows its finding's
    level; and an answer given while the finding was private becomes feedback once it is
    shared in full."""
    from tests.test_intake_sharing_round4 import share

    ctx, intake_id, fid, body = await _private_answer(client)
    # Shared in full: now it is feedback.
    assert (await share(client, ctx, intake_id, fid, "full")).status_code == 200
    [item] = await _feedback(client, ctx)
    assert body in item["summary"]

    for level in ("private", "counts"):
        assert (await share(client, ctx, intake_id, fid, level)).status_code == 200
        listed = await client.get(f"/v1/documents/{SLUG}/feedback", headers=ctx.as_("viewer"))
        assert listed.status_code == 200 and body not in listed.text
        assert (await read_summary(client, ctx, intake_id))["late_answers_as_feedback"] == 0
    # Shared at summary alone (#595 re-review): the answer is feedback again, once.
    assert (await share(client, ctx, intake_id, fid, "summary")).status_code == 200
    [item] = await _feedback(client, ctx)
    assert body in item["summary"]
    assert (await read_summary(client, ctx, intake_id))["late_answers_as_feedback"] == 1
    assert (await share(client, ctx, intake_id, fid, "full")).status_code == 200
    [item] = await _feedback(client, ctx)
    assert body in item["summary"]


async def test_a_late_answer_someone_acted_on_is_kept_with_its_quote_withheld(
    client,
    runtime,  # noqa: F811
):
    """#595 re-review: an item someone triaged is not deleted (nor what hangs off it) when
    its finding goes private: it stays, its quote withheld, and reads in full once shared."""
    from tests.test_intake_sharing_round4 import share

    ctx, intake_id, fid, body = await _private_answer(client)
    assert (await share(client, ctx, intake_id, fid, "full")).status_code == 200
    [item] = await _feedback(client, ctx)
    resp = await client.patch(
        f"/v1/feedback/{item['id']}",
        json={"status": "addressed", "resolution_note": "Covered in Security."},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text

    assert (await share(client, ctx, intake_id, fid, "private")).status_code == 200
    [kept] = await _feedback(client, ctx)
    assert kept["id"] == item["id"] and body not in kept["summary"]
    assert kept["summary"].startswith("Answered after drafting started")
    assert (kept["status"], kept["resolution_note"]) == ("addressed", "Covered in Security.")
    assert (await read_summary(client, ctx, intake_id))["late_answers_as_feedback"] == 0

    assert (await share(client, ctx, intake_id, fid, "summary")).status_code == 200
    [back] = await _feedback(client, ctx)
    assert back["id"] == item["id"] and body in back["summary"]
    assert (await read_summary(client, ctx, intake_id))["late_answers_as_feedback"] == 1


async def test_a_withheld_late_answer_hides_its_suggestions_too(
    client,
    runtime,  # noqa: F811
):
    """#636 re-review MAJOR 1: the model wrote a kept item's suggestion from the summary
    that quoted the answer, so while the item is withheld every output that serves the
    suggestion (Feedback, the suggestions list, the Inbox, staged changes) leaves its text,
    edited text and rationale out, for every role; shared in full again, they show."""
    from datetime import UTC, datetime

    from oracle.jobs.models import LlmSuggestion
    from oracle.review.models import FeedbackItem
    from tests.test_intake_sharing_round4 import share

    ctx, intake_id, fid, body = await _private_answer(client)
    assert (await share(client, ctx, intake_id, fid, "full")).status_code == 200
    [item] = await _feedback(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(FeedbackItem, uuid.UUID(item["id"]))
        sug = LlmSuggestion(
            document_id=row.document_id,
            feedback_item_id=row.id,
            version_number=1,
            classification="change_request",
            kind="section_text",
            section_key="solution",
            text=f"Say it plainly: {body}",
            rationale=f"The answer says: {body}",
            status="open",
            created_at=datetime.now(UTC),
        )
        s.add(sug)
        await s.commit()
        sug_id = str(sug.id)
    approver = ctx.as_("approver")
    resp = await client.post(
        f"/v1/suggestions/{sug_id}/accept",
        json={"text": f"Edited: {body}"},
        headers=approver,
    )
    assert resp.status_code == 200, resp.text

    async def outputs() -> dict[str, str]:
        out = {}
        for role in ("viewer", "commenter", "approver"):
            listed = await client.get(f"/v1/documents/{SLUG}/feedback", headers=ctx.as_(role))
            assert listed.status_code == 200, listed.text
            out[f"feedback:{role}"] = listed.text
            sugs = await client.get(f"/v1/documents/{SLUG}/suggestions", headers=ctx.as_(role))
            assert sugs.status_code == 200, sugs.text
            out[f"suggestions:{role}"] = sugs.text
        staged = await client.get(f"/v1/documents/{SLUG}/staged-changes", headers=approver)
        assert staged.status_code == 200, staged.text
        out["staged-changes"] = staged.text
        inbox = await client.get("/v1/inbox", headers=approver)
        assert inbox.status_code == 200, inbox.text
        out["inbox"] = inbox.text
        return out

    shown = await outputs()
    assert all(body in text for k, text in shown.items() if k != "inbox"), shown

    assert (await share(client, ctx, intake_id, fid, "private")).status_code == 200
    hidden = await outputs()
    assert not [k for k, text in hidden.items() if body in text], hidden
    [kept] = await _feedback(client, ctx)
    assert kept["id"] == item["id"] and kept["suggestion"]["id"] == sug_id
    assert kept["suggestion"]["status"] == "accepted"
    assert (kept["suggestion"]["text"], kept["suggestion"]["edited_text"]) == (None, None)
    assert kept["suggestion"]["rationale"] is None

    assert (await share(client, ctx, intake_id, fid, "full")).status_code == 200
    [back] = await _feedback(client, ctx)
    assert back["suggestion"]["edited_text"] == f"Edited: {body}"
    assert back["suggestion"]["rationale"] == f"The answer says: {body}"


async def test_a_withheld_late_answer_hides_its_lines_in_job_outputs(
    client,
    runtime,  # noqa: F811
):
    """#645 re-review MAJOR 1: a reporting job's output keeps each item's summary, note and
    explanation as they were when it ran, and a refinement's its resolution notes. While
    the item is withheld none of them shows, for any role, in the version's reports (its
    lines and ``latest_job``), the export, or the jobs list and detail (MCP reads the same
    routes); the report's narrative, written from every item, is withheld with it. Shared
    in full again, they show."""
    from datetime import UTC, datetime

    from sqlalchemy import select

    from oracle.docs.models import Document, DocumentVersion
    from oracle.jobs.models import LlmJob
    from oracle.review.models import FeedbackItem
    from tests.test_intake_sharing_round4 import share

    ctx, intake_id, fid, body = await _private_answer(client)
    assert (await share(client, ctx, intake_id, fid, "full")).status_code == 200
    [item] = await _feedback(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(FeedbackItem, uuid.UUID(item["id"]))
        version_id = await s.scalar(
            select(DocumentVersion.id)
            .join(Document, Document.id == DocumentVersion.document_id)
            .where(Document.slug == SLUG, DocumentVersion.number == 1)
        )
        # Acted on: Oracle's refinement closed it with a note quoting the answer.
        note = f"Worked in: {body}"
        row.status, row.resolution_note = "addressed", note
        now = datetime.now(UTC)
        report = LlmJob(
            kind="reporting",
            document_id=row.document_id,
            version_id=version_id,
            status="succeeded",
            finished_at=now,
            output={
                "version": 1,
                "since": None,
                "resolution": {
                    "summary": f"One item asked about storage: {body}",
                    "counts": {"addressed": 1},
                    "items": [
                        {
                            "feedback_id": str(row.id),
                            "summary": row.summary,
                            "section_key": None,
                            "status": "addressed",
                            "resolution_note": note,
                            "addressed_in_version": 1,
                            "explanation": f"Explained: {body}",
                        }
                    ],
                },
                "changes": {
                    "since": None,
                    "summary": "Nothing changed.",
                    "sections": [],
                    "new_sources": [],
                },
            },
        )
        refinement = LlmJob(
            kind="refinement",
            document_id=row.document_id,
            version_id=version_id,
            section_key="solution",
            status="succeeded",
            finished_at=now,
            output={
                "section_key": "solution",
                "resolutions": [{"feedback_id": str(row.id), "status": "addressed", "note": note}],
            },
        )
        s.add_all([report, refinement])
        await s.commit()
        job_ids = [str(report.id), str(refinement.id)]
    assert body in row.summary

    async def outputs() -> dict[str, str]:
        out = {}
        for role in ("viewer", "commenter", "approver"):
            h = ctx.as_(role)
            for name, url in [
                ("reports", f"/v1/documents/{SLUG}/versions/1/reports"),
                ("export", f"/v1/documents/{SLUG}/versions/1/reports/export"),
                ("jobs", f"/v1/documents/{SLUG}/llm-jobs"),
                ("feedback", f"/v1/documents/{SLUG}/feedback"),
                *[(f"job:{j}", f"/v1/llm-jobs/{j}") for j in job_ids],
            ]:
                resp = await client.get(url, headers=h)
                assert resp.status_code == 200, (url, resp.text)
                out[f"{name}:{role}"] = resp.text
        return out

    shown = await outputs()
    assert all(body in text for text in shown.values()), shown

    assert (await share(client, ctx, intake_id, fid, "private")).status_code == 200
    hidden = await outputs()
    assert not [k for k, text in hidden.items() if body in text], hidden
    reports = (
        await client.get(f"/v1/documents/{SLUG}/versions/1/reports", headers=ctx.as_("viewer"))
    ).json()
    [line] = reports["resolution"]["items"]
    assert line["summary"].startswith("Answered after drafting started")
    assert (line["resolution_note"], line["explanation"]) == (None, "")
    assert reports["resolution"]["counts"] == {"addressed": 1}
    [job_line] = reports["latest_job"]["output"]["resolution"]["items"]
    assert job_line == line

    assert (await share(client, ctx, intake_id, fid, "full")).status_code == 200
    back = await outputs()
    assert all(body in text for text in back.values()), back


async def test_a_withheld_note_from_an_earlier_suggestion_stays_withheld(
    client,
    runtime,  # noqa: F811
):
    """#645 re-review: the note Accept wrote from an earlier suggestion stays withheld once
    a newer suggestion on the item is the latest."""
    from datetime import UTC, datetime, timedelta

    from oracle.jobs.models import LlmSuggestion
    from oracle.review.models import FeedbackItem
    from tests.test_intake_sharing_round4 import share

    ctx, intake_id, fid, body = await _private_answer(client)
    assert (await share(client, ctx, intake_id, fid, "full")).status_code == 200
    [item] = await _feedback(client, ctx)
    now = datetime.now(UTC)
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(FeedbackItem, uuid.UUID(item["id"]))
        old, new = (
            LlmSuggestion(
                document_id=row.document_id,
                feedback_item_id=row.id,
                version_number=1,
                classification="question",
                kind=kind,
                text=text,
                rationale=rationale,
                status=status,
                created_at=at,
            )
            for kind, text, rationale, status, at in [
                ("answer", f"Yes: {body}", None, "accepted", now - timedelta(minutes=5)),
                ("none", None, "Nothing more to change", "open", now),
            ]
        )
        s.add_all([old, new])
        row.status, row.resolution_note = "addressed", f"Answered: Yes: {body}"
        await s.commit()

    assert (await share(client, ctx, intake_id, fid, "private")).status_code == 200
    for role in ("viewer", "approver"):
        listed = await client.get(f"/v1/documents/{SLUG}/feedback", headers=ctx.as_(role))
        assert listed.status_code == 200 and body not in listed.text, listed.text
    inbox = await client.get("/v1/inbox", headers=ctx.as_("approver"))
    assert inbox.status_code == 200 and body not in inbox.text, inbox.text
