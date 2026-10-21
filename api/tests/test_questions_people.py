"""C2 Questions to people: every open question reaches a named person, who answers it
from the Inbox (``GET /v1/inbox/questions``). People ask a named teammate about an
intake, a document section, a run checkpoint item or a baseline entity
(``POST /v1/questions``), reassign or withdraw a question (``PATCH``), and pick people
from one member directory (``GET /v1/people``). Run tokens do none of it.

Test cards (protects / fails_when / no_claim) head each test. Synthetic placeholders only.
"""

import uuid

import pytest
from pydantic import ValidationError
from sqlalchemy import select

from oracle.auth.models import User
from oracle.intake.schemas import QuestionCreate
from oracle.jobs import worker
from oracle.llm import gateway
from oracle.members.names import display_name
from oracle.models import AuditEvent
from oracle.runs.models import Checkpoint, Run
from oracle.tenancy import tenant_session
from oracle.v2.models import KnowledgeGap, StakeholderAnswer, StakeholderQuestion
from tests.baseline_helpers import entity, make_item
from tests.claude_account_helpers import add_account, window
from tests.intake_helpers import answer, company, create_intake
from tests.test_intake import _document
from tests.test_intake_jobs import FakeClaude
from tests.test_intake_sharing import EXCERPT_A, MODEL_GAP, TITLE_A, _model, add_author
from tests.test_mcp import mcp_client, run_token, text_of

PEOPLE_KEYS = {"user_id", "name", "email", "role", "can_write"}


@pytest.fixture(autouse=True)
def local_runtime():
    """The local runtime: run tokens from any address (as tests.test_mcp)."""
    from oracle.swarm import FakeRuntime, set_runtime

    set_runtime(FakeRuntime())
    yield
    set_runtime(None)


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


async def inbox(client, ctx, who: str) -> list[dict]:
    resp = await client.get("/v1/inbox/questions", headers=ctx.as_(who))
    assert resp.status_code == 200, resp.text
    return resp.json()


def uid(ctx, who: str) -> str:
    return str(ctx.users[who].id)


async def questions_of(client, ctx, intake_id: str, status: str) -> list[dict]:
    resp = await client.get(
        "/v1/questions",
        params={"intake_id": intake_id, "status": status, "limit": 500},
        headers=ctx.as_("viewer"),
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def ask(client, ctx, who: str = "commenter", expect: int = 201, **body) -> dict:
    resp = await client.post("/v1/questions", json=body, headers=ctx.as_(who))
    assert resp.status_code == expect, resp.text
    return resp.json()


def section_subject(document_id: str, key: str = "metrics") -> dict:
    return {"kind": "document_section", "document_id": document_id, "section_key": key}


async def document_id(client, ctx) -> tuple[str, str]:
    slug = await _document(client, ctx)
    resp = await client.get(f"/v1/documents/{slug}", headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    return slug, resp.json()["id"]


# --- unit ----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("email", "name"),
    [
        ("first.last@example.com", "First Last"),
        ("approver@example.com", "Approver"),
        ("ana_maria-lee@example.com", "Ana Maria Lee"),
        ("j.r.r.tolkien@example.com", "J R R Tolkien"),
    ],
)
def test_display_name_reads_the_email(email, name):
    """protects=one name rule for every person picker; fails_when="first.last" is not
    "First Last"; no_claim=names people chose themselves."""
    assert display_name(email) == name


@pytest.mark.parametrize(
    "subject",
    [
        {"kind": "document_section", "document_id": str(uuid.uuid4())},
        {"kind": "checkpoint_item", "checkpoint_id": str(uuid.uuid4())},
        {"kind": "intake"},
        {"kind": "planet", "id": str(uuid.uuid4())},
    ],
)
def test_question_subject_needs_its_own_fields(subject):
    """protects=a question is always about one thing; fails_when=a subject without its
    ids validates; no_claim=that the thing exists (the route checks that)."""
    with pytest.raises(ValidationError):
        QuestionCreate(prompt="Which tiers get caps?", asked_to=uuid.uuid4(), subject=subject)


def test_question_prompt_and_why_are_bounded():
    s = {"kind": "entity", "entity_id": str(uuid.uuid4())}
    with pytest.raises(ValidationError):
        QuestionCreate(prompt="x" * 1001, asked_to=uuid.uuid4(), subject=s)
    with pytest.raises(ValidationError):
        QuestionCreate(prompt="Why?", rationale="x" * 501, asked_to=uuid.uuid4(), subject=s)
    with pytest.raises(ValidationError):
        QuestionCreate(prompt="   ", asked_to=uuid.uuid4(), subject=s)


# --- the engine's batches --------------------------------------------------------------


async def test_unassigned_goes_to_author(client):
    """protects=no question reaches nobody; fails_when=an asked question has asked_to
    null; no_claim=who the best person is (the asker chooses)."""
    ctx = await company()
    out = await create_intake(client, ctx, "commenter")
    intake_id = out["intake"]["id"]
    asked = await questions_of(client, ctx, intake_id, "asked")
    assert asked and all(q["asked_to"] == uid(ctx, "commenter") for q in asked)
    mine = await inbox(client, ctx, "commenter")
    assert {r["question"]["id"] for r in mine} == {q["id"] for q in asked}
    row = mine[0]
    assert row["asked_by"] == {"kind": "oracle"}
    assert (
        row["subject"]["kind"] == "intake"
        and row["subject"]["title"] == "Before drafting · Saved addresses"
    )
    # No PRD yet and no intake page: nothing to open, the answer is given in place.
    assert row["subject"]["href"] is None
    assert row["answer_paths"] == ["answer", "dont_know", "defer", "delegate", "research"]
    assert row["gap"] is not None and row["gap"]["id"] == row["question"]["gap_id"]
    # Oldest first.
    stamps = [r["question"]["created_at"] for r in mine]
    assert stamps == sorted(stamps)
    # Nobody else is asked them.
    assert await inbox(client, ctx, "approver") == []


async def test_batch_assign_sends_each_named_question_to_that_person(client):
    ctx = await company()
    out = await create_intake(client, ctx, "commenter", batch_size=1)
    intake_id = out["intake"]["id"]
    drafts = await questions_of(client, ctx, intake_id, "draft")
    drafts.sort(key=lambda q: q["priority"])
    first, second = drafts[0], drafts[1]
    resp = await client.post(
        f"/v1/intakes/{intake_id}/question-batches",
        json={"size": 2, "assign": {first["id"]: uid(ctx, "approver")}},
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 200, resp.text
    by_id = {c["question"]["id"]: c["question"] for c in resp.json()["questions"]}
    assert by_id[first["id"]]["asked_to"] == uid(ctx, "approver")
    assert by_id[second["id"]]["asked_to"] == uid(ctx, "commenter")
    assert [r["question"]["id"] for r in await inbox(client, ctx, "approver")] == [first["id"]]
    # The query parameter still sets the size (compatibility).
    resp = await client.post(
        f"/v1/intakes/{intake_id}/question-batches?size=1", headers=ctx.as_("commenter")
    )
    assert resp.status_code == 200 and len(resp.json()["questions"]) == 1


async def test_batch_assign_to_a_viewer_is_refused_and_asks_nothing(client):
    ctx = await company()
    out = await create_intake(client, ctx, "commenter", batch_size=1)
    intake_id = out["intake"]["id"]
    drafts = await questions_of(client, ctx, intake_id, "draft")
    for target in (uid(ctx, "viewer"), str(uuid.uuid4())):
        resp = await client.post(
            f"/v1/intakes/{intake_id}/question-batches",
            json={"size": 2, "assign": {drafts[0]["id"]: target}},
            headers=ctx.as_("commenter"),
        )
        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"] == "Ask someone who can answer"
    assert len(await questions_of(client, ctx, intake_id, "draft")) == len(drafts)
    assert len(await questions_of(client, ctx, intake_id, "asked")) == 1


# --- delegation --------------------------------------------------------------------------


async def test_delegate_sees_question(client):
    """protects=delegation reaches the delegate's Inbox; fails_when=status delegated is
    filtered out; no_claim=notification channels."""
    ctx = await company()
    out = await create_intake(client, ctx, "approver", batch_size=1)
    [q] = await questions_of(client, ctx, out["intake"]["id"], "asked")
    assert [r["question"]["id"] for r in await inbox(client, ctx, "approver")] == [q["id"]]
    await answer(
        client, ctx, q["id"], "approver", kind="delegate", delegated_to=uid(ctx, "commenter")
    )
    theirs = await inbox(client, ctx, "commenter")
    assert [r["question"]["id"] for r in theirs] == [q["id"]]
    assert theirs[0]["question"]["status"] == "delegated"
    assert await inbox(client, ctx, "approver") == []
    # The delegate answers it from there.
    await answer(client, ctx, q["id"], "commenter", body="Median repeat checkout time")
    assert await inbox(client, ctx, "commenter") == []


# --- ask a teammate --------------------------------------------------------------------


async def test_ask_a_teammate_about_a_document_section(client):
    ctx = await company()
    slug, doc_id = await document_id(client, ctx)
    q = await ask(
        client, ctx, "commenter",
        prompt="Which plan tiers get hard caps?", asked_to=uid(ctx, "approver"),
        rationale="The scope review needs it before approving",
        subject=section_subject(doc_id),
    )  # fmt: skip
    assert q["category"] == "general" and q["status"] == "asked"
    assert q["asked_by"] == uid(ctx, "commenter") and q["asked_to"] == uid(ctx, "approver")
    assert q["document_id"] == doc_id and q["section_key"] == "metrics"
    assert q["batch"] is None and q["priority"] == 100 and q["gap_id"] is None
    [row] = await inbox(client, ctx, "approver")
    assert row["question"]["id"] == q["id"]
    assert row["asked_by"] == {"kind": "person", "id": uid(ctx, "commenter"), "name": "Commenter"}
    assert row["subject"]["kind"] == "document_section"
    assert row["subject"]["title"] == "Checkout redesign PRD · 6. Success metrics"
    assert row["subject"]["href"] == f"/documents/{slug}/v/1#metrics"
    assert row["gap"] is None
    assert row["answer_paths"] == ["answer", "dont_know", "defer", "delegate"]
    async with tenant_session(ctx.tenant_id) as s:
        events = (
            await s.scalars(select(AuditEvent).where(AuditEvent.action == "question.asked"))
        ).all()
    assert [e.entity_id for e in events] == [uuid.UUID(q["id"])]
    # A viewer cannot ask.
    await ask(
        client, ctx, "viewer", expect=403,
        prompt="Who owns this?", asked_to=uid(ctx, "approver"), subject=section_subject(doc_id),
    )  # fmt: skip


async def test_a_general_question_is_answered_and_the_asker_reads_the_answer(client):
    ctx = await company()
    _, doc_id = await document_id(client, ctx)
    q = await ask(
        client, ctx, prompt="Which tiers get caps?", asked_to=uid(ctx, "approver"),
        subject=section_subject(doc_id),
    )  # fmt: skip
    out = await answer(client, ctx, q["id"], "approver", body="Only the free tier")
    assert out["question"]["status"] == "answered" and out["gap"] is None
    assert out["answer"]["body"] == "Only the free tier"
    assert await inbox(client, ctx, "approver") == []
    resp = await client.get(
        "/v1/answers", params={"question_id": q["id"]}, headers=ctx.as_("commenter")
    )
    assert [a["body"] for a in resp.json()] == ["Only the free tier"]


async def test_every_subject_kind_reads_with_its_title_and_link(client):
    ctx = await company()
    ent = await entity(client, ctx, type="goal", key="activation", title="Activation")
    out = await create_intake(client, ctx, "commenter", batch_size=1)
    async with tenant_session(ctx.tenant_id) as s:
        run = Run(flow="baseline_to_prd", created_by=ctx.users["owner"].id)
        s.add(run)
        await s.flush()
        cp = Checkpoint(run_id=run.id, kind="roadmap_items", payload={})
        s.add(cp)
        await s.commit()
        run_id, cp_id = run.id, cp.id
    subjects = [
        {"kind": "entity", "entity_id": ent["id"]},
        {"kind": "checkpoint_item", "checkpoint_id": str(cp_id), "item_ref": "item-3"},
        {"kind": "intake", "intake_id": out["intake"]["id"]},
    ]
    for subject in subjects:
        await ask(
            client, ctx, prompt="Who decides?", asked_to=uid(ctx, "approver"), subject=subject
        )
    rows = {r["subject"]["kind"]: r["subject"] for r in await inbox(client, ctx, "approver")}
    assert rows["entity"] == {"kind": "entity", "title": "Baseline · Activation",
                              "href": f"/baseline?entity={ent['id']}"}  # fmt: skip
    assert rows["checkpoint_item"]["href"] == f"/runs/{run_id}#decide"
    assert rows["checkpoint_item"]["title"] == "Roadmap items · item-3"
    assert rows["intake"]["title"] == "Before drafting · Saved addresses"
    # A subject that does not exist, or a person who cannot answer: 422.
    for subject in (
        {"kind": "entity", "entity_id": str(uuid.uuid4())},
        {"kind": "document_section", "document_id": str(uuid.uuid4()), "section_key": "x"},
        {"kind": "checkpoint_item", "checkpoint_id": str(uuid.uuid4()), "item_ref": "a"},
        {"kind": "intake", "intake_id": str(uuid.uuid4())},
    ):
        await ask(
            client, ctx, expect=422, prompt="Who?", asked_to=uid(ctx, "approver"), subject=subject
        )
    resp = await client.post(
        "/v1/questions",
        json={"prompt": "Who?", "asked_to": uid(ctx, "viewer"), "subject": subjects[0]},
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 422 and resp.json()["detail"] == "Ask someone who can answer"


async def test_a_disabled_member_cannot_be_asked_nor_listed(client):
    ctx = await company()
    ent = await entity(client, ctx, type="goal", key="activation", title="Activation")
    resp = await client.post(
        f"/v1/members/{uid(ctx, 'approver')}/disable", headers=ctx.as_("owner")
    )
    assert resp.status_code == 200, resp.text
    resp = await client.post(
        "/v1/questions",
        json={"prompt": "Who?", "asked_to": uid(ctx, "approver"),
              "subject": {"kind": "entity", "entity_id": ent["id"]}},
        headers=ctx.as_("commenter"),
    )  # fmt: skip
    assert resp.status_code == 422 and resp.json()["detail"] == "Ask someone who can answer"
    resp = await client.get("/v1/people", params={"q": "appr"}, headers=ctx.as_("viewer"))
    assert resp.json() == []


# --- reassign and withdraw ----------------------------------------------------------


async def test_reassign_and_withdraw(client):
    """protects=the asker moves or withdraws their question; fails_when=a withdrawn
    question stays in the Inbox or anyone may move it; no_claim=notifications."""
    ctx = await company()
    _, doc_id = await document_id(client, ctx)
    q = await ask(
        client, ctx, prompt="Who?", asked_to=uid(ctx, "approver"), subject=section_subject(doc_id)
    )
    url = f"/v1/questions/{q['id']}"
    # Not the asker, not an intake author, not an approver: 403.
    async with tenant_session(ctx.tenant_id) as s:
        other = User(email="second.commenter@example.com", password_hash="x", role="commenter")
        s.add(other)
        await s.commit()
        ctx.users["other"] = other
    resp = await client.patch(url, json={"asked_to": uid(ctx, "owner")}, headers=ctx.as_("other"))
    assert resp.status_code == 403, resp.text
    resp = await client.patch(url, json={"status": "withdrawn"}, headers=ctx.as_("viewer"))
    assert resp.status_code == 403
    # The asker reassigns: the new person is asked, the old one no longer.
    resp = await client.patch(
        url, json={"asked_to": uid(ctx, "owner")}, headers=ctx.as_("commenter")
    )
    assert resp.status_code == 200 and resp.json()["asked_to"] == uid(ctx, "owner")
    assert await inbox(client, ctx, "approver") == []
    assert [r["question"]["id"] for r in await inbox(client, ctx, "owner")] == [q["id"]]
    resp = await client.patch(
        url, json={"asked_to": uid(ctx, "viewer")}, headers=ctx.as_("commenter")
    )
    assert resp.status_code == 422
    # Withdrawn: out of the Inbox at once, and final.
    resp = await client.patch(url, json={"status": "withdrawn"}, headers=ctx.as_("commenter"))
    assert resp.status_code == 200 and resp.json()["status"] == "withdrawn"
    assert await inbox(client, ctx, "owner") == []
    resp = await client.patch(
        url, json={"asked_to": uid(ctx, "approver")}, headers=ctx.as_("owner")
    )
    assert resp.status_code == 409
    async with tenant_session(ctx.tenant_id) as s:
        actions = (
            await s.scalars(
                select(AuditEvent.action).where(AuditEvent.entity_id == uuid.UUID(q["id"]))
            )
        ).all()
    assert {"question.asked", "question.reassigned", "question.withdrawn"} <= set(actions)


async def test_an_answered_question_is_not_reassigned_and_the_author_moves_intake_questions(
    client,
):
    ctx = await company()
    out = await create_intake(client, ctx, "commenter", batch_size=2)
    first, second = await questions_of(client, ctx, out["intake"]["id"], "asked")
    url = f"/v1/questions/{first['id']}"
    # The intake's author (also the asker here) and an approver may move it.
    resp = await client.patch(
        url, json={"asked_to": uid(ctx, "approver")}, headers=ctx.as_("approver")
    )
    assert resp.status_code == 200, resp.text
    await answer(client, ctx, first["id"], "approver", body="Returning buyers")
    resp = await client.patch(
        url, json={"asked_to": uid(ctx, "commenter")}, headers=ctx.as_("commenter")
    )
    assert resp.status_code == 409
    # A draft can be given its person before it is asked.
    [draft, *_] = await questions_of(client, ctx, out["intake"]["id"], "draft")
    resp = await client.patch(
        f"/v1/questions/{draft['id']}",
        json={"asked_to": uid(ctx, "owner")},
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 200 and resp.json()["status"] == "draft"
    # Neither field, or both: 422.
    for body in ({}, {"asked_to": uid(ctx, "owner"), "status": "withdrawn"}, {"status": "asked"}):
        resp = await client.patch(
            f"/v1/questions/{second['id']}", json=body, headers=ctx.as_("commenter")
        )
        assert resp.status_code == 422, body


# --- private findings (S6) -----------------------------------------------------------


async def test_private_gap_not_assignable(client, fake):
    """protects=decision S6 Private findings sharing; fails_when=a hidden gap's
    question is asked of a non-author; no_claim=the sharing UI."""
    ctx = await company()
    await add_account(ctx.tenant_id, "personal", windows={"five_hour": window(0.2)})
    await add_author(ctx, "commenter")
    await make_item(ctx, "author", content=EXCERPT_A, title=TITLE_A)
    fake(_model)
    out = await create_intake(client, ctx, who="author", ai_extraction=True, batch_size=1)
    tick = await worker.run_pending(ctx.tenant_id)
    assert tick.succeeded == 1, tick.errors
    intake_id = out["intake"]["id"]
    async with tenant_session(ctx.tenant_id) as s:
        q = await s.scalar(
            select(StakeholderQuestion).where(
                StakeholderQuestion.intake_id == uuid.UUID(intake_id),
                StakeholderQuestion.prompt.contains("42%"),
            )
        )
    assert q is not None, "the model gap's question"
    # Before it is asked: a batch may not send it to anyone but the author.
    if q.status == "draft":
        resp = await client.post(
            f"/v1/intakes/{intake_id}/question-batches",
            json={"size": 10, "assign": {str(q.id): uid(ctx, "approver")}},
            headers=ctx.as_("author"),
        )
        assert resp.status_code == 409, resp.text
        assert resp.json()["detail"] == "Share this finding first to ask someone else"
        # Asked in a later batch, of the author.
        while True:
            resp = await client.post(
                f"/v1/intakes/{intake_id}/question-batches",
                json={"size": 10},
                headers=ctx.as_("author"),
            )
            if resp.status_code == 409:
                break
            assert resp.status_code == 200, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(StakeholderQuestion, q.id)
        assert (row.status, row.asked_to) == ("asked", ctx.users["author"].id)
    resp = await client.patch(
        f"/v1/questions/{q.id}", json={"asked_to": uid(ctx, "approver")}, headers=ctx.as_("author")
    )
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"] == "Share this finding first to ask someone else"
    # The author is asked it, and sees it in their Inbox; nobody else learns of it.
    mine = await inbox(client, ctx, "author")
    assert str(q.id) in {r["question"]["id"] for r in mine}
    for who in ("approver", "owner", "viewer"):
        assert MODEL_GAP not in str(await inbox(client, ctx, who))


# --- the member directory ----------------------------------------------------------------


async def test_people_lists_active_members_with_five_fields(client):
    ctx = await company()
    resp = await client.get("/v1/people", params={"q": "appr"}, headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    [row] = resp.json()
    assert set(row) == PEOPLE_KEYS
    assert row == {
        "user_id": uid(ctx, "approver"), "name": "Approver", "email": "approver@example.com",
        "role": "approver", "can_write": True,
    }  # fmt: skip
    everyone = (await client.get("/v1/people", headers=ctx.as_("viewer"))).json()
    assert {p["email"]: p["can_write"] for p in everyone} == {
        "owner@example.com": True, "approver@example.com": True,
        "commenter@example.com": True, "viewer@example.com": False,
    }  # fmt: skip
    resp = await client.get("/v1/people", params={"limit": 2}, headers=ctx.as_("viewer"))
    assert len(resp.json()) == 2
    # The full member list stays the owner's.
    assert (await client.get("/v1/members", headers=ctx.as_("viewer"))).status_code == 403
    # Another company's members are not listed.
    other = await company("Other Co")
    theirs = (await client.get("/v1/people", headers=other.as_("viewer"))).json()
    assert not {p["user_id"] for p in theirs} & {p["user_id"] for p in everyone}


# --- run tokens --------------------------------------------------------------------


async def test_run_tokens_are_refused_on_every_new_route(client):
    """protects=agents never create, move or read people's questions; fails_when=a run
    token reaches one of the four tools; no_claim=people's MCP clients (they may)."""
    ctx = await company()
    _, doc_id = await document_id(client, ctx)
    q = await ask(
        client, ctx, prompt="Who?", asked_to=uid(ctx, "approver"), subject=section_subject(doc_id)
    )
    token = await run_token(
        ctx.tenant_id, ["read:baseline", "read:sources", "read:documents", "write:proposals"],
        ctx.users["approver"].id,
    )  # fmt: skip
    calls = {
        "create_question": {"body": {"prompt": "Who?", "asked_to": uid(ctx, "owner"),
                                     "subject": section_subject(doc_id)}},
        "update_question": {"question_id": q["id"], "body": {"status": "withdrawn"}},
        "list_inbox_questions": {},
        "list_people": {},
    }  # fmt: skip
    async with mcp_client(token) as c:
        names = {t.name for t in (await c.list_tools()).tools}
        assert names.isdisjoint(calls)
        for tool, args in calls.items():
            result = await c.call_tool(tool, args)
            assert result.is_error and "not available to run tokens" in text_of(result), tool
    # People's MCP clients (an API token) have them.
    async with mcp_client(ctx.token) as c:
        names = {t.name for t in (await c.list_tools()).tools}
    assert set(calls) <= names
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(StakeholderQuestion, uuid.UUID(q["id"]))).status == "asked"


# --- review fixes: who a question may reach ------------------------------------------


async def asked_private_question(client, ctx, fake) -> StakeholderQuestion:
    """A private finding's question (the model gap), asked of its author."""
    await add_account(ctx.tenant_id, "personal", windows={"five_hour": window(0.2)})
    await add_author(ctx, "commenter")
    await make_item(ctx, "author", content=EXCERPT_A, title=TITLE_A)
    fake(_model)
    out = await create_intake(client, ctx, who="author", ai_extraction=True, batch_size=1)
    tick = await worker.run_pending(ctx.tenant_id)
    assert tick.succeeded == 1, tick.errors
    intake_id = out["intake"]["id"]
    while True:
        resp = await client.post(
            f"/v1/intakes/{intake_id}/question-batches", json={"size": 10},
            headers=ctx.as_("author"),
        )  # fmt: skip
        if resp.status_code == 409:
            break
        assert resp.status_code == 200, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        q = await s.scalar(
            select(StakeholderQuestion).where(
                StakeholderQuestion.intake_id == uuid.UUID(intake_id),
                StakeholderQuestion.prompt.contains("42%"),
            )
        )
    assert q is not None and (q.status, q.asked_to) == ("asked", ctx.users["author"].id)
    return q


async def test_delegating_a_private_findings_question_is_refused(client, fake):
    """protects=S6 on the Inbox's "Ask someone" (delegate); fails_when=a private
    finding's question is delegated to someone who cannot see it; no_claim=sharing."""
    ctx = await company()
    q = await asked_private_question(client, ctx, fake)
    resp = await client.post(
        f"/v1/questions/{q.id}/answers",
        json={"kind": "delegate", "delegated_to": uid(ctx, "approver")},
        headers=ctx.as_("author"),
    )
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"] == "Share this finding first to ask someone else"
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(StakeholderQuestion, q.id)
        assert (row.status, row.asked_to) == ("asked", ctx.users["author"].id)
        assert (await s.get(KnowledgeGap, row.gap_id)).owner_id != ctx.users["approver"].id
        assert (
            await s.scalars(select(StakeholderAnswer).where(StakeholderAnswer.question_id == q.id))
        ).all() == []
    assert str(q.id) in {r["question"]["id"] for r in await inbox(client, ctx, "author")}
    assert await inbox(client, ctx, "approver") == []


async def test_delegating_to_a_disabled_member_is_refused(client):
    """protects=a delegated question reaches someone who can answer; fails_when=a
    disabled member is delegated to; no_claim=restoring members."""
    ctx = await company()
    out = await create_intake(client, ctx, "approver", batch_size=1)
    [q] = await questions_of(client, ctx, out["intake"]["id"], "asked")
    resp = await client.post(
        f"/v1/members/{uid(ctx, 'commenter')}/disable", headers=ctx.as_("owner")
    )
    assert resp.status_code == 200, resp.text
    for target in (uid(ctx, "commenter"), uid(ctx, "viewer"), str(uuid.uuid4())):
        resp = await client.post(
            f"/v1/questions/{q['id']}/answers",
            json={"kind": "delegate", "delegated_to": target},
            headers=ctx.as_("approver"),
        )
        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"] == "Delegate to a person of this company who can answer"
    [still] = await questions_of(client, ctx, out["intake"]["id"], "asked")
    assert still["asked_to"] == uid(ctx, "approver")


async def ask_until_asked(client, ctx, intake_id: str, question_id: str, who: str) -> dict:
    for _ in range(20):
        asked = {q["id"]: q for q in await questions_of(client, ctx, intake_id, "asked")}
        if question_id in asked:
            return asked[question_id]
        resp = await client.post(
            f"/v1/intakes/{intake_id}/question-batches", json={"size": 10},
            headers=ctx.as_(who),
        )  # fmt: skip
        assert resp.status_code == 200, resp.text
    raise AssertionError("never asked")


async def owned_gap_question(client, ctx, intake_id: str, owner: str) -> str:
    resp = await client.post(
        "/v1/gaps",
        json={"intake_id": intake_id, "category": "ownership", "importance": "high",
              "statement": "Who signs off the rollout?", "owner_id": uid(ctx, owner)},
        headers=ctx.as_("commenter"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    gap_id = resp.json()["id"]
    [draft] = [
        q for q in await questions_of(client, ctx, intake_id, "draft") if q["gap_id"] == gap_id
    ]
    assert draft["asked_to"] == uid(ctx, owner)
    return draft["id"]


async def test_batch_skips_a_gap_owner_who_can_no_longer_answer(client):
    """protects=C2 every asked question reaches a person who can answer; fails_when=the
    batch falls back to a disabled or demoted gap owner; no_claim=who owns the gap."""
    ctx = await company()
    out = await create_intake(client, ctx, "commenter", batch_size=1)
    intake_id = out["intake"]["id"]
    disabled = await owned_gap_question(client, ctx, intake_id, "approver")
    resp = await client.post(
        f"/v1/members/{uid(ctx, 'approver')}/disable", headers=ctx.as_("owner")
    )
    assert resp.status_code == 200, resp.text
    q = await ask_until_asked(client, ctx, intake_id, disabled, "commenter")
    # The intake's author is asked instead.
    assert q["asked_to"] == uid(ctx, "commenter")


async def test_batch_skips_a_gap_owner_demoted_to_viewer(client):
    ctx = await company()
    out = await create_intake(client, ctx, "commenter", batch_size=1)
    intake_id = out["intake"]["id"]
    demoted = await owned_gap_question(client, ctx, intake_id, "approver")
    resp = await client.patch(
        f"/v1/members/{uid(ctx, 'approver')}", json={"role": "viewer"},
        headers=ctx.as_("owner"),
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    q = await ask_until_asked(client, ctx, intake_id, demoted, "commenter")
    assert q["asked_to"] == uid(ctx, "commenter")


async def test_batch_asks_the_approver_asking_when_the_author_cannot_answer(client):
    """The owner and the author cannot answer: the approver who asks the batch is
    asked (they may always ask it, so they can answer it)."""
    ctx = await company()
    out = await create_intake(client, ctx, "commenter", batch_size=1)
    intake_id = out["intake"]["id"]
    resp = await client.post(
        "/v1/gaps",
        json={"intake_id": intake_id, "category": "ownership", "importance": "high",
              "statement": "Who signs off the rollout?", "owner_id": uid(ctx, "viewer")},
        headers=ctx.as_("commenter"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    resp = await client.post(
        f"/v1/members/{uid(ctx, 'commenter')}/disable", headers=ctx.as_("owner")
    )
    assert resp.status_code == 200, resp.text
    drafts = await questions_of(client, ctx, intake_id, "draft")
    resp = await client.post(
        f"/v1/intakes/{intake_id}/question-batches", json={"size": 10},
        headers=ctx.as_("approver"),
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    asked = {c["question"]["id"]: c["question"] for c in resp.json()["questions"]}
    assert asked and set(asked) <= {d["id"] for d in drafts}
    assert {q["asked_to"] for q in asked.values()} == {uid(ctx, "approver")}


async def test_research_on_a_general_question_is_refused(client):
    """protects=Research this is offered only on a gap's question; fails_when=the API
    accepts research on a question with no gap; no_claim=research on gaps."""
    ctx = await company()
    _, doc_id = await document_id(client, ctx)
    q = await ask(
        client, ctx, prompt="Which tiers get caps?", asked_to=uid(ctx, "approver"),
        subject=section_subject(doc_id),
    )  # fmt: skip
    resp = await client.post(
        f"/v1/questions/{q['id']}/answers", json={"kind": "research"},
        headers=ctx.as_("approver"),
    )  # fmt: skip
    assert resp.status_code == 422, resp.text
    assert [r["question"]["status"] for r in await inbox(client, ctx, "approver")] == ["asked"]
