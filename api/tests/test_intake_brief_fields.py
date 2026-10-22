"""C4 One New PRD door: the brief's goals, out-of-scope lines, template, theme and O1d
answers on an intake (issue #153, API items 1-5, acceptance criteria 1, 2, 3 and 6).

Card (test_brief_goals_answer_gap and the tests below):
- protects: the brief's goals and out-of-scope lines count as the author's decision on
  the goal_alignment and non_goals gaps; a goal must be a confirmed goal; the template
  and theme picked at the door must be a PRD template and theme; reopening the sheet
  after an estimate reuses the intake's one draft run.
- fails_when: Oracle asks the goal or non-goals question again in the first batch, a
  non-owner clears a critical gap (B4), an unconfirmed goal or a roadmap template is
  accepted or leaves a half-made intake, a converted intake's brief fields change, or a
  second POST /v1/intakes/{id}/runs makes a second draft run.
- no_claim: goal quality, the wording of the questions, or the web sheet itself.

Synthetic placeholders only.
"""

import uuid

import pytest
from sqlalchemy import func, select

from oracle.swarm import FakeRuntime, set_runtime
from oracle.templates.models import Template
from oracle.tenancy import tenant_session
from oracle.v2.models import ProductIntake, StakeholderAnswer
from tests.baseline_helpers import confirm, entity
from tests.intake_helpers import all_questions, batch, company, create_intake, gaps_by_category


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


async def _goals(client, ctx) -> list[dict]:
    """Two confirmed goals the brief's words do not name (so their gap stays open)."""
    out = []
    for key, title in (("repeat-purchases", "Grow repeat purchases"),
                       ("support-load", "Lower support load")):  # fmt: skip
        goal = await entity(client, ctx, type="goal", key=key, title=title)
        await confirm(client, ctx, goal)
        out.append(goal)
    return out


async def _intake_count(ctx) -> int:
    async with tenant_session(ctx.tenant_id) as s:
        return await s.scalar(select(func.count()).select_from(ProductIntake))


async def _latest_answer(ctx, question_id: str) -> StakeholderAnswer:
    async with tenant_session(ctx.tenant_id) as s:
        return await s.scalar(
            select(StakeholderAnswer)
            .where(StakeholderAnswer.question_id == uuid.UUID(question_id))
            .order_by(StakeholderAnswer.created_at.desc(), StakeholderAnswer.id.desc())
            .limit(1)
        )


async def test_brief_goals_answer_gap(client):
    """Criterion 1: an approver's brief with two confirmed goals and one out-of-scope line
    leaves goal_alignment answered, waiting for review (B4), non_goals answered, and
    neither question in the first batch."""
    ctx = await company()
    goals = await _goals(client, ctx)
    out = await create_intake(
        client, ctx, who="approver",
        goal_ids=[g["id"] for g in goals],
        out_of_scope=["Address book sharing between accounts"],
        template="one-pager", theme="one-page-brief",
        prd_answers={"decision": "commit_build", "size": "new_feature",
                     "readers": "product_eng", "model_driven": False},
    )  # fmt: skip
    intake = out["intake"]
    assert intake["goal_ids"] == [g["id"] for g in goals]
    assert intake["out_of_scope"] == ["Address book sharing between accounts"]
    assert intake["template"] == "one-pager" and intake["theme"] == "one-page-brief"
    assert intake["prd_answers"] == {"decision": "commit_build", "size": "new_feature",
                                     "readers": "product_eng", "model_driven": False}  # fmt: skip
    assert intake["run_ids"] == []

    gaps = gaps_by_category(out)
    assert gaps["goal_alignment"]["importance"] == "critical"
    assert gaps["goal_alignment"]["status"] == "answered_pending_review"
    assert sorted(gaps["goal_alignment"]["entity_ids"]) == sorted(g["id"] for g in goals)
    assert gaps["goal_alignment"]["knowledge_state"] == "user_decision"
    assert gaps["non_goals"]["status"] == "answered"

    first = await batch(client, ctx, intake["id"])
    asked = {c["question"]["category"] for c in first["questions"]}
    assert first["questions"] and not {"goal_alignment", "non_goals"} & asked
    by_cat = {q["category"]: q for q in await all_questions(client, ctx, intake["id"])}
    goal_q, scope_q = by_cat["goal_alignment"], by_cat["non_goals"]
    assert goal_q["status"] == "answered" and scope_q["status"] == "answered"
    goal_a = await _latest_answer(ctx, goal_q["id"])
    assert goal_a.kind == "answer" and goal_a.knowledge_state == "user_decision"
    assert goal_a.body == "Serves: Grow repeat purchases, Lower support load"
    assert goal_a.answered_by == ctx.users["approver"].id
    scope_a = await _latest_answer(ctx, scope_q["id"])
    assert scope_a.body == "Out of scope: Address book sharing between accounts"


async def test_an_owners_brief_clears_the_critical_goal_gap(client):
    """Criterion 2: the same brief by an owner leaves goal_alignment answered (B4)."""
    ctx = await company()
    goals = await _goals(client, ctx)
    out = await create_intake(
        client, ctx, who="owner", goal_ids=[g["id"] for g in goals],
        out_of_scope=["Gift wrapping", "Address import from other shops"],
    )  # fmt: skip
    gaps = gaps_by_category(out)
    assert gaps["goal_alignment"]["status"] == "answered"
    assert gaps["non_goals"]["status"] == "answered"
    by_cat = {q["category"]: q for q in await all_questions(client, ctx, out["intake"]["id"])}
    scope_a = await _latest_answer(ctx, by_cat["non_goals"]["id"])
    assert scope_a.body == "Out of scope: Gift wrapping; Address import from other shops"


async def test_a_goal_that_is_not_confirmed_is_422_and_creates_nothing(client):
    """Criterion 3: an unknown id, a proposed goal or a confirmed feature is 422 and no
    intake is made."""
    ctx = await company()
    (goal,) = (await _goals(client, ctx))[:1]
    proposed = await entity(client, ctx, type="goal", key="new-markets", title="Open new markets")
    assert proposed["status"] != "confirmed"
    feature = await entity(client, ctx, type="feature", key="one-click", title="One click")
    await confirm(client, ctx, feature)
    before = await _intake_count(ctx)
    for bad in (str(uuid.uuid4()), proposed["id"], feature["id"]):
        await create_intake(client, ctx, who="approver", goal_ids=[goal["id"], bad], expect=422)
    assert await _intake_count(ctx) == before
    # The lists' limits.
    await create_intake(client, ctx, goal_ids=[str(uuid.uuid4())] * 11, expect=422)
    await create_intake(client, ctx, out_of_scope=["x"] * 21, expect=422)
    await create_intake(client, ctx, out_of_scope=[""], expect=422)
    await create_intake(client, ctx, out_of_scope=["x" * 301], expect=422)
    assert await _intake_count(ctx) == before


async def test_template_and_theme_must_be_a_live_prd_template_and_theme(client):
    ctx = await company()
    for body in (
        {"template": "no-such-template"},
        {"template": "now-next-later"},  # a roadmap template
        {"theme": "no-such-theme"},
        {"theme": "roadmap-board"},  # a roadmap theme
    ):
        await create_intake(client, ctx, who="approver", expect=422, **body)
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.scalar(select(Template).where(Template.key == "pr-faq"))
        row.archived_at = func.now()
        await s.commit()
    await create_intake(client, ctx, who="approver", template="pr-faq", expect=422)
    await create_intake(client, ctx, prd_answers={"decision": "nonsense"}, expect=422)
    assert await _intake_count(ctx) == 0
    ok = await create_intake(client, ctx, template="prd-rfc")
    assert ok["intake"]["template"] == "prd-rfc" and ok["intake"]["theme"] is None


async def test_patching_the_brief_fields_answers_again(client):
    """A PATCH of the goals or out-of-scope lines answers again (a new answer row, the
    latest wins); the author may, a stranger may not."""
    ctx = await company()
    goals = await _goals(client, ctx)
    out = await create_intake(client, ctx, who="commenter")
    intake = out["intake"]
    gaps = gaps_by_category(out)
    assert gaps["goal_alignment"]["status"] == "unknown"

    resp = await client.patch(
        f"/v1/intakes/{intake['id']}",
        json={"lock_version": intake["lock_version"], "goal_ids": [goals[0]["id"]]},
        headers=ctx.as_("viewer"),
    )
    assert resp.status_code == 403, resp.text
    resp = await client.patch(
        f"/v1/intakes/{intake['id']}",
        json={"lock_version": intake["lock_version"], "goal_ids": [goals[0]["id"]],
              "out_of_scope": ["Gift wrapping"], "template": "one-pager"},
        headers=ctx.as_("commenter"),
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    patched = resp.json()
    assert patched["goal_ids"] == [goals[0]["id"]] and patched["template"] == "one-pager"
    assert patched["out_of_scope"] == ["Gift wrapping"]
    by_cat = {q["category"]: q for q in await all_questions(client, ctx, intake["id"])}
    first = await _latest_answer(ctx, by_cat["goal_alignment"]["id"])
    assert first.body == "Serves: Grow repeat purchases"

    resp = await client.patch(
        f"/v1/intakes/{intake['id']}",
        json={"lock_version": patched["lock_version"], "goal_ids": [g["id"] for g in goals]},
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 200, resp.text
    latest = await _latest_answer(ctx, by_cat["goal_alignment"]["id"])
    assert latest.id != first.id
    assert latest.body == "Serves: Grow repeat purchases, Lower support load"
    summary = (
        await client.get(f"/v1/intakes/{intake['id']}/summary", headers=ctx.as_("viewer"))
    ).json()
    goal_gap = gaps_by_category(summary)["goal_alignment"]
    # A commenter's answer never clears a critical gap alone (B4).
    assert goal_gap["status"] == "answered_pending_review"
    assert sorted(goal_gap["entity_ids"]) == sorted(g["id"] for g in goals)
    resp = await client.patch(
        f"/v1/intakes/{intake['id']}",
        json={"lock_version": resp.json()["lock_version"], "goal_ids": [str(uuid.uuid4())]},
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 422, resp.text


async def test_estimating_twice_leaves_one_draft_run_and_a_converted_brief_is_409(client, runtime):
    """Criterion 6: reopening the sheet after an estimate posts the intake's run again;
    the one draft run is updated, not doubled (run_ids length 1). Once converted the
    brief fields are refused with 409."""
    ctx = await company()
    out = await create_intake(client, ctx, who="approver", template="one-pager")
    intake_id = out["intake"]["id"]
    approver = ctx.as_("approver")
    resp = await client.post(f"/v1/intakes/{intake_id}/runs", json={}, headers=approver)
    assert resp.status_code == 201, resp.text
    first = resp.json()
    assert (
        await client.post(f"/v1/runs/{first['id']}/estimate", headers=approver)
    ).status_code == 200
    resp = await client.post(
        f"/v1/intakes/{intake_id}/runs",
        json={"knobs": {"depth": "deep"}, "template": "prd-rfc"},
        headers=approver,
    )
    assert resp.status_code in (200, 201), resp.text
    second = resp.json()
    assert second["id"] == first["id"]
    assert second["knobs"]["depth"] == "deep" and second["knobs"]["template"] == "prd-rfc"
    assert (
        await client.post(f"/v1/runs/{first['id']}/estimate", headers=approver)
    ).status_code == 200
    intake = (await client.get(f"/v1/intakes/{intake_id}", headers=ctx.as_("viewer"))).json()
    assert intake["status"] == "converted"
    resp = await client.patch(
        f"/v1/intakes/{intake_id}",
        json={"lock_version": intake["lock_version"], "title": "Saved addresses v2"},
        headers=approver,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["run_ids"] == [first["id"]]
    resp = await client.patch(
        f"/v1/intakes/{intake_id}",
        json={"lock_version": resp.json()["lock_version"], "out_of_scope": ["Gift wrapping"]},
        headers=approver,
    )
    assert resp.status_code == 409, resp.text
