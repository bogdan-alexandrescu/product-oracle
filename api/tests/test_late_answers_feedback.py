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
    assert s["draft_document"] == SLUG


async def test_answers_before_drafting_make_no_feedback(client, runtime):  # noqa: F811
    ctx = await company()
    intake_id, run_id, cards = await _started(client, ctx)
    await _import(ctx, run_id)
    assert await _feedback(client, ctx) == []
    s = await read_summary(client, ctx, intake_id)
    assert s["answers_since_run"] == 0 and s["late_answers_as_feedback"] == 0
