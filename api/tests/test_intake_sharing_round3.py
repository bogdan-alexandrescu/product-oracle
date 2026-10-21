"""Security review, round 3 (S6 and B4).

S6 (owner, 2026-10-19): others see nothing from a private finding, including that it
exists; gap importance comes from the brief and public facts only. B4: only an owner
(or the reviewing role) clears a critical gap; the baseline never closes one alone.

Synthetic placeholders only.
"""

import dataclasses
import json
import re
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from oracle.auth.deps import Principal
from oracle.auth.models import User
from oracle.intake import categories as cats
from oracle.intake import engine, sharing, views
from oracle.intake import router as intake_router
from oracle.intake.answers import next_actions
from oracle.jobs import worker
from oracle.jobs.models import LlmJob
from oracle.llm import gateway
from oracle.tenancy import tenant_session
from oracle.v2.models import KnowledgeGap, ProductIntake, StakeholderQuestion
from tests.baseline_helpers import NOW, confirm, entity, make_item
from tests.claude_account_helpers import add_account, window
from tests.intake_helpers import (
    answer,
    ask_of,
    batch,
    company,
    create_intake,
    gaps_by_category,
    question_for,
)
from tests.test_intake import _document
from tests.test_intake_jobs import FakeClaude
from tests.test_intake_rules import BLOCKER_BRIEF
from tests.test_intake_sharing import (
    CODENAME,
    EXCERPT_A,
    EXCERPT_B,
    MODEL_GAP,
    READERS,
    TITLE_A,
    read_summary,
)
from tests.test_intake_sharing_writes import as_run

# The brief speaks to the users (a hypothesis); the author's sources speak to the
# users and the pain too.


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


UNRELATED = "Lunch menu for the offsite: soup, salad and a vegetarian option."
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
TIME_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?")


async def add_person(ctx, key: str, role: str = "commenter") -> None:
    async with tenant_session(ctx.tenant_id) as s:
        user = User(email=f"{key}@example.com", password_hash="x", role=role)
        s.add(user)
        await s.commit()
        await s.refresh(user)
        ctx.users[key] = user


def normalized(value) -> object:
    """The JSON with ids numbered by first appearance and times blanked: two intakes
    that differ only in what private sources say must read the same."""
    text = TIME_RE.sub("T", json.dumps(value, sort_keys=True))
    seen: dict[str, str] = {}
    return json.loads(UUID_RE.sub(lambda m: seen.setdefault(m.group(0), f"id{len(seen)}"), text))


def differences(a, b, path: str = "") -> list[str]:
    if isinstance(a, dict) and isinstance(b, dict):
        out = []
        for key in sorted(set(a) | set(b)):
            out += differences(a.get(key), b.get(key), f"{path}.{key}")
        return out
    if isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
        return [d for n, (x, y) in enumerate(zip(a, b, strict=True))
                for d in differences(x, y, f"{path}[{n}]")]  # fmt: skip
    return [] if a == b else [f"{path}: {a!r} != {b!r}"]


def assert_same(theirs, base, ignore: frozenset[str] = frozenset()) -> None:
    diff = [d for d in differences(normalized(theirs), normalized(base))
            if d.split(":")[0].rsplit(".", 1)[-1] not in ignore]  # fmt: skip
    assert not diff, "\n".join(diff[:40])


async def twin_intakes(client, **body) -> tuple:
    """Two intakes with the same brief: the "author" pinned private items that speak to
    it, the "plain" author only an unrelated item."""
    ctx = await company()
    await add_account(ctx.tenant_id, "personal", windows={"five_hour": window(0.2)})
    await add_person(ctx, "author")
    await add_person(ctx, "plain")
    await make_item(ctx, "author", content=EXCERPT_A, title=TITLE_A)
    await make_item(ctx, "author", content=EXCERPT_B, title="#finance numbers")
    await make_item(ctx, "plain", content=UNRELATED, title="#offsite")
    private = await create_intake(client, ctx, who="author", **body)
    plain = await create_intake(client, ctx, who="plain", **body)
    return ctx, private["intake"]["id"], plain["intake"]["id"]


# --- the summary tells nobody which categories private sources speak to ------------------

USERS_BRIEF = (
    "Returning buyers retype their shipping address at every checkout. "
    "Customer: returning buyers on the web shop. "
    "Add saved addresses so returning buyers check out faster."
)


@pytest.mark.parametrize("who", READERS)
async def test_a_summary_with_private_evidence_reads_as_a_plain_one(client, who):
    ctx, private_id, plain_id = await twin_intakes(client, brief=USERS_BRIEF)
    mine = await read_summary(client, ctx, private_id, "author")
    assert any(c["knowledge_state"] == "ai_inference" for c in mine["coverage"])
    theirs = await read_summary(client, ctx, private_id, who)
    base = await read_summary(client, ctx, plain_id, who)
    for out in (theirs, base):
        out["intake"].pop("author_id", None)
    assert_same(theirs, base)


async def test_next_actions_follow_the_ranking_not_row_ids(client):
    ctx, private_id, plain_id = await twin_intakes(client)
    for intake_id in (private_id, plain_id):
        out = await read_summary(client, ctx, intake_id, "viewer")
        ranked = [g["id"] for g in out["gaps"] if g["importance"] == "critical"]
        acted = list(dict.fromkeys(a["gap_id"] for a in out["next_actions"]))
        assert acted == [g for g in ranked if g in acted]


# --- existence: batches, status and job usage --------------------------------------------


def _model_for(marker: str):
    """The model writes a gap only when it reads ``marker`` in the author's sources."""

    def answer(payload):
        if marker not in json.dumps(payload):
            return {"items": [], "gaps": [], "category": "feature"}
        refs = [s["ref"] for s in payload["untrusted_data"]["sources"]]
        return {
            "items": [],
            "gaps": [{"category": "release_rollout", "importance": "critical",
                      "statement": MODEL_GAP, "evidence_refs": refs[:1]}],
            "category": "feature",
        }  # fmt: skip

    return answer


async def twin_model_intakes(client, fake, **body) -> tuple:
    fake(_model_for(CODENAME))
    ctx, private_id, plain_id = await twin_intakes(client, ai_extraction=True, **body)
    tick = await worker.run_pending(ctx.tenant_id)
    assert tick.succeeded == 2, tick.errors
    return ctx, private_id, plain_id


async def ask_all(client, ctx, intake_id: str, who: str, size: int = 3) -> list[int]:
    sizes = []
    for _ in range(20):
        resp = await client.post(
            f"/v1/intakes/{intake_id}/question-batches", params={"size": size},
            headers=ctx.as_(who),
        )  # fmt: skip
        if resp.status_code == 409:
            return sizes
        assert resp.status_code == 200, resp.text
        sizes.append(len(resp.json()["questions"]))
    raise AssertionError("never ran out of questions")


async def question_rows(client, ctx, intake_id: str, who: str) -> list[tuple]:
    if who == "run":
        resp = await client.get(
            "/v1/questions", params={"intake_id": intake_id, "limit": 500},
            headers=as_run(ctx),
        )  # fmt: skip
    else:
        resp = await client.get(
            "/v1/questions", params={"intake_id": intake_id, "limit": 500},
            headers=ctx.as_(who),
        )  # fmt: skip
    assert resp.status_code == 200, resp.text
    return sorted((q["batch"] or 0, q["priority"], q["category"], q["status"]) for q in resp.json())


@pytest.mark.parametrize("who", READERS)
async def test_batch_sizes_and_numbers_never_reveal_a_private_question(client, fake, who):
    ctx, private_id, plain_id = await twin_model_intakes(client, fake)
    # The author's private question waits as a draft, ranked among the others.
    mine = await question_rows(client, ctx, private_id, "author")
    assert any(c == "release_rollout" and s == "draft" for _, _, c, s in mine if c)
    await ask_all(client, ctx, private_id, "author")
    await ask_all(client, ctx, plain_id, "plain")
    assert await question_rows(client, ctx, private_id, who) == await question_rows(
        client, ctx, plain_id, who
    )
    theirs = await read_summary(client, ctx, private_id, who)
    base = await read_summary(client, ctx, plain_id, who)
    assert theirs["batch"] == base["batch"]
    for out in (theirs, base):
        out["intake"].pop("author_id", None)
    assert_same(theirs, base)
    for n in range(1, (base["batch"]["current"] or 0) + 1):
        a = await batch_as(client, ctx, private_id, who, n)
        b = await batch_as(client, ctx, plain_id, who, n)
        assert [c["question"]["category"] for c in a["questions"]] == [
            c["question"]["category"] for c in b["questions"]
        ], n
    # The author asked their own question too.
    mine = await question_rows(client, ctx, private_id, "author")
    assert all(s != "draft" for _, _, _, s in mine)


async def batch_as(client, ctx, intake_id: str, who: str, number: int) -> dict:
    h = as_run(ctx) if who == "run" else ctx.as_(who)
    resp = await client.get(
        f"/v1/intakes/{intake_id}/question-batch", params={"batch": number}, headers=h
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_an_approvers_batches_stay_full_and_numbered_as_a_plain_intake(client, fake):
    ctx, private_id, plain_id = await twin_model_intakes(client, fake)
    a = await ask_all(client, ctx, private_id, "approver")
    b = await ask_all(client, ctx, plain_id, "approver")
    assert a == b
    # Then the author asks their private question: no new batch number shows to others.
    resp = await client.post(
        f"/v1/intakes/{private_id}/question-batches", headers=ctx.as_("author")
    )
    assert resp.status_code == 200, resp.text
    assert MODEL_GAP in resp.text
    # A rejected decision asks a gap again: the next batch is numbered as a plain one's.
    for intake_id in (private_id, plain_id):
        out = await read_summary(client, ctx, intake_id, "viewer")
        resp = await client.post(
            f"/v1/gaps/{gaps_by_category(out)['pain_evidence']['id']}/decisions",
            json={"decision": "reject", "rationale": "Ask again."}, headers=ctx.as_("owner"),
        )  # fmt: skip
        assert resp.status_code == 201, resp.text
        assert await ask_all(client, ctx, intake_id, "approver") == [1]
    for who in ("viewer", "approver"):
        assert await question_rows(client, ctx, private_id, who) == await question_rows(
            client, ctx, plain_id, who
        )
        theirs = await read_summary(client, ctx, private_id, who)
        assert theirs["batch"] == (await read_summary(client, ctx, plain_id, who))["batch"]


async def _defer_visible(client, ctx, intake_id: str, author: str) -> None:
    """The author defers every question everyone else sees."""
    for _ in range(3):
        rows = (
            await client.get(
                "/v1/questions", params={"intake_id": intake_id, "limit": 500},
                headers=ctx.as_("viewer"),
            )
        ).json()  # fmt: skip
        open_ = [q for q in rows if q["status"] in ("draft", "asked")]
        if not open_:
            return
        for q in open_:
            resp = await client.post(
                f"/v1/questions/{q['id']}/answers", json={"kind": "defer"},
                headers=ctx.as_(author),
            )  # fmt: skip
            assert resp.status_code == 201, resp.text


@pytest.mark.parametrize("who", READERS)
async def test_status_never_waits_on_a_hidden_gap(client, fake, who):
    ctx, private_id, plain_id = await twin_model_intakes(client, fake)
    await _defer_visible(client, ctx, private_id, "author")
    await _defer_visible(client, ctx, plain_id, "plain")
    base = await read_summary(client, ctx, plain_id, who)
    assert base["intake"]["status"] == "ready"
    theirs = await read_summary(client, ctx, private_id, who)
    assert theirs["intake"]["status"] == "ready"
    h = as_run(ctx) if who == "run" else ctx.as_(who)
    listed = (await client.get("/v1/intakes", headers=h)).json()
    assert {i["status"] for i in listed} == {"ready"}
    # The author still sees that their own gap waits for an answer.
    mine = await read_summary(client, ctx, private_id, "author")
    assert mine["intake"]["status"] == "awaiting_answers"
    # A re-analysis keeps it so.
    resp = await client.post(f"/v1/intakes/{private_id}/analyze", headers=ctx.as_("author"))
    assert resp.status_code == 200, resp.text
    assert resp.json()["intake"]["status"] == "awaiting_answers"
    theirs = await read_summary(client, ctx, private_id, who)
    assert theirs["intake"]["status"] == "ready"


async def test_an_intake_jobs_usage_is_the_authors_only(client, fake):
    ctx, private_id, _ = await twin_model_intakes(client, fake)
    async with tenant_session(ctx.tenant_id) as s:
        job = await s.scalar(select(LlmJob).where(LlmJob.intake_id == uuid.UUID(private_id)))
    url = f"/v1/llm-jobs/{job.id}"
    mine = (await client.get(url, headers=ctx.as_("author"))).json()
    assert (mine["input_tokens"], mine["output_tokens"], mine["cost_usd"]) == (900, 200, 0.02)
    for h in [ctx.as_(w) for w in ("viewer", "commenter", "approver", "owner")] + [as_run(ctx)]:
        theirs = await client.get(url, headers=h)
        assert theirs.status_code == 200, theirs.text
        body = theirs.json()
        assert body["output"] is None
        assert (body["input_tokens"], body["output_tokens"], body["cost_usd"]) == (None,) * 3
    for path in ("cancel", "retry"):
        resp = await client.post(f"{url}/{path}", headers=ctx.as_("approver"))
        if resp.status_code == 200:
            assert resp.json()["input_tokens"] is None


# --- B4: the baseline never closes a critical gap alone ----------------------------------


async def test_a_rejected_critical_answer_is_not_closed_by_the_baseline(client):
    ctx = await company()
    doc = await _document(client, ctx)
    out = await create_intake(client, ctx, who="approver", document=doc, brief=BLOCKER_BRIEF)
    intake_id = out["intake"]["id"]
    gap = gaps_by_category(out)["blockers"]
    assert gap["importance"] == "critical"
    q = question_for(await batch(client, ctx, intake_id), "blockers")
    await ask_of(client, ctx, q["id"], "commenter")
    done = await answer(client, ctx, q["id"], body="The partner limit is fine.")
    assert done["gap"]["status"] == "answered_pending_review"
    resp = await client.post(
        f"/v1/gaps/{gap['id']}/decisions",
        json={"decision": "reject", "rationale": "Not checked with the partner."},
        headers=ctx.as_("owner"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    # The baseline now holds a confirmed constraint the brief matches.
    c = await entity(client, ctx, type="constraint", key="partner-shipping-api-rate-limit",
                     title="Partner shipping API rate limit")  # fmt: skip
    await confirm(client, ctx, c)
    resp = await client.post(f"/v1/intakes/{intake_id}/analyze", headers=ctx.as_("approver"))
    assert resp.status_code == 200, resp.text
    after = gaps_by_category(resp.json())["blockers"]
    assert after["status"] == "answered_pending_review", after
    assert resp.json()["readiness"]["gate"] == "blocked"
    [row] = [r for r in resp.json()["coverage"] if r["category"] == "blockers"]
    assert row["state"] != "covered" and "an owner" in row["reason"]
    # An owner reviews it.
    resp = await client.post(
        f"/v1/gaps/{gap['id']}/decisions",
        json={"decision": "validate", "rationale": "The constraint covers it."},
        headers=ctx.as_("owner"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text


def test_the_elsewhere_reason_names_the_role_that_reviews():
    for cat in cats.CATEGORIES:
        gap = KnowledgeGap(
            id=uuid.uuid4(), category=cat.key, importance="critical",
            status=engine.PENDING, impact=list(cat.impact),
        )  # fmt: skip
        [action] = next_actions(gap)
        reason = engine.elsewhere_reason(cat.key)
        assert f"an {action.role} reviews it" in reason, (cat.key, action.role, reason)
        other = "owner" if action.role == "approver" else "approver"
        assert f"an {other}" not in reason


# --- minors -------------------------------------------------------------------------------


async def test_a_private_gap_from_a_write_route_fails_closed():
    gap = KnowledgeGap(
        id=uuid.uuid4(), intake_id=uuid.uuid4(), category="release_rollout",
        statement=MODEL_GAP, importance="high", impact=["risks"], evidence_ids=[],
        knowledge_state="ai_inference", status="unknown", related_modules=[], entity_ids=[],
        section_keys=[], lock_version=1, created_at=NOW, updated_at=NOW,
    )  # fmt: skip
    intake = ProductIntake(id=gap.intake_id, author_id=uuid.uuid4(), analysis={
        "coverage": [], "findings": {str(gap.id): {
            "kind": "gap", "origin": "model", "category": "release_rollout",
            "source_item_ids": [], "summary": "x", "sharing": "private"}}})  # fmt: skip
    viewer = Principal(tenant_id=uuid.uuid4(), kind="user", role="owner", user_id=uuid.uuid4())
    with pytest.raises(HTTPException) as e:
        intake_router._gap_out(intake, viewer, gap)
    assert e.value.status_code == 404


async def test_old_rows_show_importance_and_priority_from_public_facts(client):
    """Rows written before importance came from the brief alone: others see what the
    brief and public facts give, the author what is stored."""
    ctx, private_id, plain_id = await twin_intakes(client, brief=USERS_BRIEF)
    async with tenant_session(ctx.tenant_id) as s:
        intake = await s.get(ProductIntake, uuid.UUID(private_id))
        reg = intake.analysis["findings"]
        gaps = (
            await s.scalars(select(KnowledgeGap).where(KnowledgeGap.intake_id == intake.id))
        ).all()
        touched = [g for g in gaps if str(g.id) in reg]
        assert touched
        for g in touched:
            # A row from before its importance basis was recorded.
            g.importance_basis = None
            g.importance = "low" if g.importance != "low" else "critical"
            for q in (
                await s.scalars(
                    select(StakeholderQuestion).where(StakeholderQuestion.gap_id == g.id)
                )
            ).all():
                q.priority = 1
        await s.commit()
    for who in READERS:
        theirs = await read_summary(client, ctx, private_id, who)
        base = await read_summary(client, ctx, plain_id, who)
        for out in (theirs, base):
            out["intake"].pop("author_id", None)
        # (Editing the rows here moved their lock version.)
        assert_same(theirs, base, frozenset({"lock_version"}))
        assert await question_rows(client, ctx, private_id, who) == await question_rows(
            client, ctx, plain_id, who
        )
    mine = await read_summary(client, ctx, private_id, "author")
    stored = {g.category: g.importance for g in touched}
    assert {g["category"]: g["importance"] for g in mine["gaps"] if g["category"] in stored} == (
        stored
    )


async def test_editing_a_categorys_statement_never_turns_rule_gaps_private(client, monkeypatch):
    ctx, private_id, _ = await twin_intakes(client)
    before = await read_summary(client, ctx, private_id, "viewer")
    changed = tuple(
        dataclasses.replace(c, statement=c.statement + " (reworded)") for c in cats.CATEGORIES
    )
    monkeypatch.setattr(cats, "CATEGORIES", changed)
    for c in changed:
        monkeypatch.setitem(cats.BY_KEY, c.key, c)
    after = await read_summary(client, ctx, private_id, "viewer")
    assert {g["id"] for g in after["gaps"]} == {g["id"] for g in before["gaps"]}
    resp = await client.post(f"/v1/intakes/{private_id}/analyze", headers=ctx.as_("author"))
    assert resp.status_code == 200, resp.text
    again = await read_summary(client, ctx, private_id, "viewer")
    assert {g["id"] for g in again["gaps"]} == {g["id"] for g in before["gaps"]}


async def test_a_non_authors_list_reads_only_the_intakes_it_lists(client, monkeypatch):
    ctx, private_id, plain_id = await twin_intakes(client)
    seen: list[str] = []
    real = sharing.registry

    def spy(intake):
        seen.append(str(intake.id))
        return real(intake)

    monkeypatch.setattr(sharing, "registry", spy)
    for path in ("/v1/gaps", "/v1/questions"):
        seen.clear()
        resp = await client.get(path, params={"intake_id": plain_id}, headers=ctx.as_("viewer"))
        assert resp.status_code == 200, resp.text
        assert private_id not in seen, path


async def test_a_long_hidden_list_never_exceeds_the_bind_parameter_limit(client, monkeypatch):
    ctx, private_id, _ = await twin_intakes(client)
    many = {uuid.uuid4() for _ in range(40_000)}

    async def hidden(*args, **kwargs):
        return many

    monkeypatch.setattr(views, "hidden_gap_ids", hidden)
    for path in ("/v1/gaps", "/v1/questions", "/v1/answers", "/v1/assumption-decisions",
                 "/v1/change-events"):  # fmt: skip
        resp = await client.get(path, headers=ctx.as_("viewer"))
        assert resp.status_code == 200, (path, resp.text[:300])
