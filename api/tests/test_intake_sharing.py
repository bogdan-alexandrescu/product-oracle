"""S6 (owner, 2026-10-19): what others see of findings drawn from the author's own
sources. The author chooses per finding: private (default), counts, summary or full.
Viewers, commenters, approvers, owners and run tokens see only what the level allows;
the author sees everything; every change is audited and can be lowered again.

Synthetic placeholders only.
"""

import asyncio
import copy
import dataclasses
import json
import re
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy import delete, func, select, text

from oracle import readiness
from oracle.auth.deps import Principal
from oracle.auth.models import User
from oracle.auth.service import make_session_cookie, sign_run_binding
from oracle.baseline import service as baseline_service
from oracle.baseline.models import Evidence, Proposal
from oracle.config import get_settings
from oracle.intake import categories as cats
from oracle.intake import checks as intake_checks
from oracle.intake import engine, sharing, views
from oracle.intake import evidence as ev
from oracle.intake import router as intake_router
from oracle.intake import service as intake_service
from oracle.intake.answers import next_actions
from oracle.intake.models import IntakeProposal, IntakeSharedItem, IntakeWithheldItem
from oracle.jobs import worker
from oracle.jobs.models import LlmJob
from oracle.llm import gateway
from oracle.models import AuditEvent
from oracle.runs.models import Run
from oracle.sources import store
from oracle.sources.base import ItemDelete, ItemUpsert
from oracle.sources.models import Source, SourceItem, SourceItemVersion
from oracle.tenancy import tenant_session
from oracle.v2.models import KnowledgeGap, ProductIntake, StakeholderQuestion
from tests.baseline_helpers import NOW, confirm, entity, make_item
from tests.claude_account_helpers import add_account, window
from tests.intake_helpers import (
    BRIEF,
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
from tests.test_mcp import mcp_client, run_token, text_of

# Unique markers that exist only in the author's private sources.
CODENAME = "ZEPHYR-ALPHA"
TITLE_A = "#secret-checkout-research"
EXCERPT_A = (
    f"Returning buyers checkout conversion is 42% for the {CODENAME} cohort; buyers complain "
    "that retyping the shipping address is slow and several abandon the cart."
)
EXCERPT_B = (
    "Returning buyers checkout conversion is 35% according to the finance dashboard; "
    "buyers complain about the shipping address form."
)
EXCERPT_OLD = "Returning buyers complained about retyping the shipping address back then."
# The model "copies" an excerpt verbatim into an item: it must never reach others.
COPIED = EXCERPT_A[:120]
MODEL_GAP = f"Is the {CODENAME} rollout limited to 42% of regions?"
SECRETS = [CODENAME, "42%", "35%", TITLE_A, "buyers checkout conversion", COPIED[:60]]
LEVELS = ["private", "counts", "summary", "full"]
READERS = ["viewer", "commenter", "approver", "owner", "run"]


def _model(payload):
    refs = [s["ref"] for s in payload["untrusted_data"]["sources"]]
    return {
        "items": [{"field": "users", "text": COPIED, "evidence_refs": refs[:1]}],
        "gaps": [
            {"category": "release_rollout", "importance": "high", "statement": MODEL_GAP,
             "evidence_refs": refs[:1]},
        ],
        "category": "feature",
    }  # fmt: skip


# The answer as written: the cases below swap _model out, and their answers build on this one.
_model_as_written = _model


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


async def add_author(ctx, role: str = "commenter") -> None:
    """A second person with ``role``: the intake's author (the ctx keeps one per role)."""
    async with tenant_session(ctx.tenant_id) as s:
        user = User(email=f"author-{role}@example.com", password_hash="x", role=role)
        s.add(user)
        await s.commit()
        await s.refresh(user)
        ctx.users["author"] = user


async def authored_intake(client, fake, role: str = "commenter", **body) -> tuple:
    """An intake whose author has three private items (a conflict, a stale item) and a
    model analysis that copied an excerpt and named the codename."""
    ctx = await company()
    await add_account(ctx.tenant_id, "personal", windows={"five_hour": window(0.2)})
    await add_author(ctx, role)
    items = {
        "a": await make_item(ctx, "author", content=EXCERPT_A, title=TITLE_A),
        "b": await make_item(ctx, "author", content=EXCERPT_B, title="#finance numbers"),
        "old": await make_item(
            ctx, "author", content=EXCERPT_OLD, title="#old thread",
            updated=NOW - timedelta(days=3 * 365),
        ),
    }  # fmt: skip
    fake(_model)
    out = await create_intake(client, ctx, who="author", ai_extraction=True, **body)
    tick = await worker.run_pending(ctx.tenant_id)
    assert tick.succeeded == 1, tick.errors
    return ctx, out["intake"]["id"], items


async def reader_texts(client, ctx, intake_id: str, who: str) -> dict[str, str]:
    """Every read of the intake, as ``who`` sees it (``run``: a run token of a run the
    author created, with both read scopes)."""
    urls = {
        "summary": f"/v1/intakes/{intake_id}/summary",
        "intake": f"/v1/intakes/{intake_id}",
        "intakes": "/v1/intakes",
        "batch": f"/v1/intakes/{intake_id}/question-batch",
        "composition": f"/v1/intakes/{intake_id}/composition-inputs",
        "findings": f"/v1/intakes/{intake_id}/findings",
        "proposals": f"/v1/intakes/{intake_id}/proposals",
        "gaps": f"/v1/gaps?intake_id={intake_id}",
        "questions": f"/v1/questions?intake_id={intake_id}",
        "decisions": "/v1/assumption-decisions",
        "new_evidence": f"/v1/intakes/{intake_id}/new-evidence",
    }
    if who != "run":
        out = {}
        for name, url in urls.items():
            resp = await client.get(url, headers=ctx.as_(who))
            assert resp.status_code == 200, (who, url, resp.text)
            out[name] = resp.text
        return out
    token = await run_token(
        ctx.tenant_id, ["read:baseline", "read:sources"], ctx.users["author"].id
    )
    tools = {
        "summary": ("get_intake_summary", {"intake_id": intake_id}),
        "intake": ("get_intake", {"item_id": intake_id}),
        "intakes": ("list_intakes", {}),
        "batch": ("get_question_batch", {"intake_id": intake_id}),
        "composition": ("get_intake_composition_inputs", {"intake_id": intake_id}),
        "findings": ("list_intake_findings", {"intake_id": intake_id}),
        "gaps": ("list_knowledge_gaps", {"intake_id": intake_id}),
        "questions": ("list_stakeholder_questions", {"intake_id": intake_id}),
        "new_evidence": ("get_intake_new_evidence", {"intake_id": intake_id}),
    }
    out = {}
    async with mcp_client(token) as c:
        for name, (tool, args) in tools.items():
            result = await c.call_tool(tool, args)
            assert not result.is_error, (tool, text_of(result))
            out[name] = text_of(result)
    return out


async def read_summary(client, ctx, intake_id: str, who: str) -> dict:
    if who == "run":
        return json.loads((await reader_texts(client, ctx, intake_id, "run"))["summary"])
    resp = await client.get(f"/v1/intakes/{intake_id}/summary", headers=ctx.as_(who))
    assert resp.status_code == 200, resp.text
    return resp.json()


async def findings(client, ctx, intake_id: str, who: str = "author") -> list[dict]:
    resp = await client.get(f"/v1/intakes/{intake_id}/findings", headers=ctx.as_(who))
    assert resp.status_code == 200, resp.text
    return resp.json()


async def share_all(client, ctx, intake_id: str, level: str) -> list[dict]:
    rows = await findings(client, ctx, intake_id)
    body = {"changes": [{"finding_id": f["id"], "sharing": level} for f in rows]}
    resp = await client.post(
        f"/v1/intakes/{intake_id}/findings/sharing", json=body, headers=ctx.as_("author")
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def model_gap(summary: dict) -> dict | None:
    return next((g for g in summary["gaps"] if g["category"] == "release_rollout"
                 and g["statement"] != gaps_by_category(summary)["release_rollout"]["statement"]
                 or g["statement"] == MODEL_GAP), None)  # fmt: skip


# --- the author --------------------------------------------------------------------------


async def test_the_author_sees_every_finding_and_each_starts_private(client, fake):
    """The intake's author sees every finding at once, and each one starts out private."""
    ctx, intake_id, items = await authored_intake(client, fake)
    mine = await read_summary(client, ctx, intake_id, "author")
    assert mine["is_author"] is True
    [conflict] = [c for c in mine["conflicts"] if c["kind"] == "source"]
    assert conflict["topic"] == "buyers checkout conversion"
    assert {c["value"] for c in conflict["claims"]} == {"42%", "35%"}
    assert conflict["sharing"] == "private" and conflict["finding_id"]
    [copied] = [i for i in mine["extracted"] if i["origin"] == "llm"]
    assert copied["text"] == COPIED and copied["sharing"] == "private"
    [gap] = [g for g in mine["gaps"] if g["statement"] == MODEL_GAP]
    assert gap["sharing"] == "private" and gap["knowledge_state"] == "ai_inference"
    assert [s["evidence"]["source_item_id"] for s in mine["stale"]] == [str(items["old"])]
    assert mine["stale"][0]["sharing"] == "private"
    rows = await findings(client, ctx, intake_id)
    kinds = {r["kind"] for r in rows}
    assert {"item", "gap", "conflict", "stale"} <= kinds
    assert all(r["sharing"] == "private" for r in rows)
    model = [r for r in rows if r["origin"] == "model"]
    assert {r["kind"] for r in model} == {"item", "gap"}
    # Oracle's summary never repeats source text or figures.
    for r in rows:
        assert r["summary"] and not any(s in r["summary"] for s in ("42", "35", COPIED[:30]))


# --- everyone else, at every level ---------------------------------------------------------


@pytest.mark.parametrize("who", READERS)
async def test_private_findings_show_nothing_to_anyone_else(client, fake, who):
    """A private finding is invisible to anyone but its intake's author, always."""
    ctx, intake_id, items = await authored_intake(client, fake)
    texts = await reader_texts(client, ctx, intake_id, who)
    for name, said in texts.items():
        for secret in [*SECRETS, MODEL_GAP]:
            assert secret not in said, (who, name, secret)
        for item_id in items.values():
            assert str(item_id) not in said, (who, name, "item id")
    theirs = json.loads(texts["summary"])
    assert theirs["is_author"] is False
    assert [c for c in theirs["conflicts"] if c["kind"] == "source"] == []
    assert theirs["stale"] == [] and theirs["shared_counts"] == []
    assert [i for i in theirs["extracted"] if i["origin"] == "llm"] == []
    assert json.loads(texts["findings"]) == []
    assert json.loads(texts["new_evidence"])["count"] is None
    coverage = {c["category"]: c for c in theirs["coverage"]}
    assert coverage["pain_evidence"]["state"] == "missing"
    assert coverage["pain_evidence"]["knowledge_state"] == "unknown"
    assert json.loads(texts["composition"])["sources"]["conflicts"] == 0


@pytest.mark.parametrize("who", READERS)
async def test_counts_show_counts_and_categories_only(client, fake, who):
    """At the counts sharing level, others see only a finding's count and category."""
    ctx, intake_id, _ = await authored_intake(client, fake)
    await share_all(client, ctx, intake_id, "counts")
    texts = await reader_texts(client, ctx, intake_id, who)
    for name, said in texts.items():
        for secret in [*SECRETS, MODEL_GAP]:
            assert secret not in said, (who, name, secret)
    theirs = json.loads(texts["summary"])
    labels = {c["label"] for c in theirs["shared_counts"]}
    assert "1 conflict in success metric and baseline evidence" in labels
    assert "1 inferred item about users" in labels
    assert "1 finding in release and rollout evidence" in labels
    assert [c for c in theirs["conflicts"] if c["kind"] == "source"] == []
    rows = json.loads(texts["findings"])
    assert rows and all(r["summary"] is None and r["source_item_ids"] == [] for r in rows)
    assert json.loads(texts["composition"])["sources"]["conflicts"] == 1


@pytest.mark.parametrize("who", READERS)
async def test_summary_shows_oracles_summary_without_excerpts_or_numbers(client, fake, who):
    """At the summary sharing level, others read Oracle's words, never a figure."""
    ctx, intake_id, items = await authored_intake(client, fake)
    await share_all(client, ctx, intake_id, "summary")
    texts = await reader_texts(client, ctx, intake_id, who)
    for name, said in texts.items():
        for secret in SECRETS:
            assert secret not in said, (who, name, secret)
    theirs = json.loads(texts["summary"])
    [conflict] = [c for c in theirs["conflicts"] if c["kind"] == "source"]
    assert conflict["summary_only"] is True
    assert "success metric" in conflict["topic"] and "disagree" in conflict["topic"]
    assert all(c["value"] is None for c in conflict["claims"])
    assert all(not e["visible"] and e["data_excerpt"] is None
               for c in conflict["claims"] for e in c["evidence"])  # fmt: skip
    [item] = [i for i in theirs["extracted"] if i["origin"] == "llm"]
    assert item["text"].startswith("Oracle inferred")  # the copied excerpt never shows
    shown = [g for g in theirs["gaps"] if g["category"] == "release_rollout" and g["sharing"]]
    [gap] = shown
    assert CODENAME.lower() in gap["statement"].lower() or "rollout" in gap["statement"].lower()
    assert "42" not in gap["statement"] and gap["statement"] != MODEL_GAP
    assert all(not e["visible"] for e in gap["evidence"])


@pytest.mark.parametrize("who", READERS)
async def test_full_shows_everything_and_the_read_is_audited(client, fake, who):
    """At the full sharing level, others see a finding's real detail, and it is logged."""
    ctx, intake_id, items = await authored_intake(client, fake)
    await share_all(client, ctx, intake_id, "full")
    theirs = await read_summary(client, ctx, intake_id, who)
    [conflict] = [c for c in theirs["conflicts"] if c["kind"] == "source"]
    assert conflict["topic"] == "buyers checkout conversion"
    assert {c["value"] for c in conflict["claims"]} == {"42%", "35%"}
    refs = [e for c in conflict["claims"] for e in c["evidence"]]
    assert any(e["visible"] and e["title"] == TITLE_A and CODENAME in e["data_excerpt"]
               for e in refs)  # fmt: skip
    assert any(g["statement"] == MODEL_GAP for g in theirs["gaps"])
    assert any(i["text"] == COPIED for i in theirs["extracted"])
    async with tenant_session(ctx.tenant_id) as s:
        reads = (
            await s.scalars(select(AuditEvent).where(AuditEvent.action == "intake.evidence_read"))
        ).all()
    reader = ctx.users["author" if who == "run" else who].id
    # (A run token reads every route; its question batch read is audited too.)
    mine = [e for e in reads if e.actor == f"user:{reader}"
            and e.data["route"] == "get_intake_summary"]  # fmt: skip
    assert mine and str(items["a"]) in mine[-1].data["item_ids"]


async def test_the_author_lowers_a_level_again_and_every_change_is_audited(client, fake):
    """The author can change a finding's sharing level, and each change is audited."""
    ctx, intake_id, _ = await authored_intake(client, fake)
    [conflict_finding] = [f for f in await findings(client, ctx, intake_id)
                          if f["kind"] == "conflict"]  # fmt: skip
    url = f"/v1/intakes/{intake_id}/findings/{conflict_finding['id']}"
    resp = await client.patch(url, json={"sharing": "full"}, headers=ctx.as_("author"))
    assert resp.status_code == 200 and resp.json()["sharing"] == "full"
    theirs = await read_summary(client, ctx, intake_id, "viewer")
    assert [c["topic"] for c in theirs["conflicts"]] == ["buyers checkout conversion"]
    resp = await client.patch(url, json={"sharing": "private"}, headers=ctx.as_("author"))
    assert resp.status_code == 200 and resp.json()["sharing"] == "private"
    theirs = await read_summary(client, ctx, intake_id, "viewer")
    assert theirs["conflicts"] == []
    # A re-analysis keeps the level the author set.
    await client.patch(url, json={"sharing": "summary"}, headers=ctx.as_("author"))
    resp = await client.post(f"/v1/intakes/{intake_id}/analyze", headers=ctx.as_("author"))
    assert resp.status_code == 200, resp.text
    [kept] = [f for f in await findings(client, ctx, intake_id) if f["kind"] == "conflict"]
    assert kept["sharing"] == "summary" and kept["id"] == conflict_finding["id"]
    async with tenant_session(ctx.tenant_id) as s:
        events = (
            await s.scalars(
                select(AuditEvent)
                .where(AuditEvent.action == "intake.finding_shared")
                .order_by(AuditEvent.created_at)
            )
        ).all()
    assert [(e.data["from"], e.data["to"]) for e in events] == [
        ("private", "full"), ("full", "private"), ("private", "summary"),
    ]  # fmt: skip
    assert {e.actor for e in events} == {f"user:{ctx.users['author'].id}"}
    assert all(e.data["finding_id"] == conflict_finding["id"] for e in events)


async def test_only_the_author_sets_sharing(client, fake):
    """Only the intake's author, never a run token or anyone else, can set sharing."""
    ctx, intake_id, _ = await authored_intake(client, fake)
    [row] = [f for f in await findings(client, ctx, intake_id) if f["kind"] == "conflict"]
    url = f"/v1/intakes/{intake_id}/findings/{row['id']}"
    bulk = f"/v1/intakes/{intake_id}/findings/sharing"
    body = {"changes": [{"finding_id": row["id"], "sharing": "full"}]}
    for who in ("viewer", "commenter", "approver", "owner", "token"):
        resp = await client.patch(url, json={"sharing": "full"}, headers=ctx.as_(who))
        assert resp.status_code == 403, (who, resp.text)
        resp = await client.post(bulk, json=body, headers=ctx.as_(who))
        assert resp.status_code == 403, (who, resp.text)
    resp = await client.patch(
        f"/v1/intakes/{intake_id}/findings/{uuid.uuid4()}", json={"sharing": "full"},
        headers=ctx.as_("author"),
    )  # fmt: skip
    assert resp.status_code == 404
    # Not even the author's own run token may share.
    token = await run_token(ctx.tenant_id, ["read:baseline", "read:sources"],
                            ctx.users["author"].id)  # fmt: skip
    async with mcp_client(token) as c:
        refused = await c.call_tool(
            "set_intake_finding_sharing",
            {"intake_id": intake_id, "finding_id": row["id"], "body": {"sharing": "full"}},
        )
        assert refused.is_error
    assert all(f["sharing"] == "private" for f in await findings(client, ctx, intake_id))


async def test_another_company_cannot_read_or_share_findings(client, fake):
    """Another company gets a 404 trying to read or change an intake's findings."""
    ctx, intake_id, _ = await authored_intake(client, fake)
    other = await company("Other Co")
    [row] = [f for f in await findings(client, ctx, intake_id) if f["kind"] == "conflict"]
    for who in ("viewer", "owner"):
        h = other.as_(who)
        assert (await client.get(f"/v1/intakes/{intake_id}/findings", headers=h)).status_code == 404
        resp = await client.patch(
            f"/v1/intakes/{intake_id}/findings/{row['id']}", json={"sharing": "full"}, headers=h
        )
        assert resp.status_code == 404


async def test_a_private_gap_is_404_to_everyone_else_on_every_route(client, fake):
    """A private gap's id is a 404 anywhere else it could be read, decided, answered."""
    ctx, intake_id, _ = await authored_intake(client, fake)
    mine = await read_summary(client, ctx, intake_id, "author")
    [gap] = [g for g in mine["gaps"] if g["statement"] == MODEL_GAP]
    async with tenant_session(ctx.tenant_id) as s:
        from oracle.v2.models import StakeholderQuestion

        q = await s.scalar(
            select(StakeholderQuestion).where(StakeholderQuestion.gap_id == uuid.UUID(gap["id"]))
        )
    assert q is not None
    for who in ("viewer", "commenter", "approver", "owner"):
        h = ctx.as_(who)
        assert (await client.get(f"/v1/gaps/{gap['id']}", headers=h)).status_code == 404
        resp = await client.get(f"/v1/questions/{q.id}", headers=h)
        assert resp.status_code == 404
    for who, method, url, body in [
        ("owner", "POST", f"/v1/gaps/{gap['id']}/decisions",
         {"decision": "validate", "rationale": "x"}),
        ("approver", "PATCH", f"/v1/gaps/{gap['id']}",
         {"importance": "low", "lock_version": gap["lock_version"]}),
        ("commenter", "POST", f"/v1/gaps/{gap['id']}/research", None),
    ]:  # fmt: skip
        resp = await client.request(method, url, json=body, headers=ctx.as_(who))
        assert resp.status_code == 404, (who, url, resp.text)
    resp = await client.post(
        f"/v1/questions/{q.id}/answers", json={"kind": "dont_know"}, headers=ctx.as_("owner")
    )
    assert resp.status_code == 404
    # The author still works on it, and nobody else learns of it from the change log.
    resp = await client.post(f"/v1/gaps/{gap['id']}/research", headers=ctx.as_("author"))
    assert resp.status_code == 201, resp.text
    assert MODEL_GAP not in resp.text  # the proposal is worded by its category
    resp = await client.post(
        f"/v1/questions/{q.id}/answers", json={"kind": "defer"}, headers=ctx.as_("author")
    )
    assert resp.status_code == 201, resp.text
    event_id = resp.json()["change_event_id"]
    url = f"/v1/change-events/{event_id}"
    assert (await client.get(url, headers=ctx.as_("author"))).status_code == 200
    for who in ("viewer", "owner"):
        h = ctx.as_(who)
        assert (await client.get(url, headers=h)).status_code == 404
        listed = (await client.get("/v1/change-events", headers=h)).json()
        assert gap["id"] not in str(listed)


async def test_the_review_gate_names_no_private_finding(client, fake):
    """A model-written critical blocker the author has not shared does not reach the
    document's review gate (its rule-made category gap does), and nothing of it is named."""

    def critical(payload):
        answer = _model(payload)
        answer["gaps"] = [{"category": "blockers", "importance": "critical",
                           "statement": f"The {CODENAME} quota blocks pre-fill.",
                           "evidence_refs": []}]  # fmt: skip
        return answer

    ctx = await company()
    await add_account(ctx.tenant_id, "personal", windows={"five_hour": window(0.2)})
    await add_author(ctx, "approver")
    await make_item(ctx, "author", content=EXCERPT_A, title=TITLE_A)
    doc = await _document(client, ctx)
    fake(critical)
    out = await create_intake(client, ctx, who="author", ai_extraction=True, document=doc)
    assert (await worker.run_pending(ctx.tenant_id)).succeeded == 1
    async with tenant_session(ctx.tenant_id) as s:
        report = await readiness.evaluate(
            readiness.ReadinessContext(s, uuid.UUID(out["intake"]["document_id"])),
            keys=[intake_checks.CRITICAL_BLOCKERS, intake_checks.OPEN_DECISIONS],
        )
    text = report.model_dump_json()
    assert report.results and CODENAME not in text


async def test_a_run_token_marker_only_narrows(client, fake):
    """The run marker header narrows what a session sees; it never widens it."""
    ctx, intake_id, _ = await authored_intake(client, fake)
    cookie = make_session_cookie(ctx.users["author"])
    binding = sign_run_binding(ctx.users["author"].id, uuid.uuid4())
    headers = {"cookie": f"{get_settings().session_cookie_name}={cookie}",
               "x-oracle-run-id": binding}  # fmt: skip
    resp = await client.get(f"/v1/intakes/{intake_id}/summary", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["is_author"] is False and MODEL_GAP not in resp.text
    # A bare or malformed run id is not a run, and is refused (fail closed): the request
    # never quietly acts as the author.
    for bad_value in ("not-a-uuid", str(uuid.uuid4())):
        bad = {**headers, "x-oracle-run-id": bad_value}
        resp = await client.get(f"/v1/intakes/{intake_id}/summary", headers=bad)
        assert resp.status_code == 400 and "is_author" not in resp.text


async def test_findings_from_shared_text_only_are_not_restricted(client, fake):
    """No source of the author's was read: what the model writes from the brief alone
    is not drawn from private sources, so it is shared."""
    ctx = await company()
    await add_account(ctx.tenant_id, "personal", windows={"five_hour": window(0.2)})
    fake(lambda payload: {
        "items": [{"field": "users", "text": "Buyers who order again", "evidence_refs": []}],
        "gaps": [], "category": "feature",
    })  # fmt: skip
    out = await create_intake(client, ctx, ai_extraction=True)
    assert (await worker.run_pending(ctx.tenant_id)).succeeded == 1
    theirs = await read_summary(client, ctx, out["intake"]["id"], "viewer")
    [item] = [i for i in theirs["extracted"] if i["origin"] == "llm"]
    assert item["text"] == "Buyers who order again" and item["sharing"] is None
    assert BRIEF in json.dumps(theirs)


async def test_an_intake_analysed_before_s6_fails_closed(client, fake):
    """Findings never registered (an intake analysed before sharing levels existed) show
    nothing to anyone else until the author re-runs the analysis."""
    ctx, intake_id, _ = await authored_intake(client, fake)
    async with tenant_session(ctx.tenant_id) as s:
        from oracle.v2.models import ProductIntake

        intake = await s.get(ProductIntake, uuid.UUID(intake_id))
        legacy = dict(intake.analysis)
        legacy.pop("findings")
        legacy["items"] = [{k: v for k, v in i.items() if k != "finding_id"}
                           for i in legacy["items"]]  # fmt: skip
        legacy["conflicts"] = [{k: v for k, v in c.items() if k != "finding_id"}
                               for c in legacy["conflicts"]]  # fmt: skip
        legacy["stale"] = [{k: v for k, v in x.items() if k != "finding_id"}
                           for x in legacy["stale"]]  # fmt: skip
        intake.analysis = legacy
        await s.commit()
    for who in ("viewer", "owner", "run"):
        texts = await reader_texts(client, ctx, intake_id, who)
        for name, said in texts.items():
            for secret in [*SECRETS, MODEL_GAP]:
                assert secret not in said, (who, name, secret)
    mine = await read_summary(client, ctx, intake_id, "author")
    assert any(g["statement"] == MODEL_GAP for g in mine["gaps"])


@pytest.fixture(autouse=True)
def _intake_read_on_the_job(monkeypatch):
    """INT2: these cases drive the built-in intake_analysis job, now the SwarmCloud read's
    fallback and the rollback (ORACLE_INTAKE_READ_RUNTIME=job): run them on that path."""
    from oracle.config import get_settings

    monkeypatch.setattr(get_settings(), "intake_read_runtime", "job")


# -----------------------------------------------------------------------------
# Security review, round 3 (S6 and B4).
#
# S6 (owner, 2026-10-19): others see nothing from a private finding, including that it
# exists; gap importance comes from the brief and public facts only. B4: only an owner
# (or the reviewing role) clears a critical gap; the baseline never closes one alone.
#
# Synthetic placeholders only.


# The brief speaks to the users (a hypothesis); the author's sources speak to the
# users and the pain too.


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
    """An intake's summary reads identically whether or not it hides private evidence."""
    ctx, private_id, plain_id = await twin_intakes(client, brief=USERS_BRIEF)
    mine = await read_summary(client, ctx, private_id, "author")
    assert any(c["knowledge_state"] == "ai_inference" for c in mine["coverage"])
    theirs = await read_summary(client, ctx, private_id, who)
    base = await read_summary(client, ctx, plain_id, who)
    for out in (theirs, base):
        out["intake"].pop("author_id", None)
    assert_same(theirs, base)


async def test_next_actions_follow_the_ranking_not_row_ids(client):
    """Next actions are ordered by a gap's importance ranking, never by its row id."""
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
            headers=_writes.as_run(ctx),
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
    """A private question never changes the size or number of anyone else's batch."""
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
    h = _writes.as_run(ctx) if who == "run" else ctx.as_(who)
    resp = await client.get(
        f"/v1/intakes/{intake_id}/question-batch", params={"batch": number}, headers=h
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_an_approvers_batches_stay_full_and_numbered_as_a_plain_intake(client, fake):
    """An approver's batches stay the same size and numbering as a plain intake's."""
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
    """An intake's status waits on a hidden gap only for the author who can see it."""
    ctx, private_id, plain_id = await twin_model_intakes(client, fake)
    await _defer_visible(client, ctx, private_id, "author")
    await _defer_visible(client, ctx, plain_id, "plain")
    base = await read_summary(client, ctx, plain_id, who)
    assert base["intake"]["status"] == "ready"
    theirs = await read_summary(client, ctx, private_id, who)
    assert theirs["intake"]["status"] == "ready"
    h = _writes.as_run(ctx) if who == "run" else ctx.as_(who)
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
    """Only the intake's author sees a job's token counts and cost; others see nulls."""
    ctx, private_id, _ = await twin_model_intakes(client, fake)
    async with tenant_session(ctx.tenant_id) as s:
        job = await s.scalar(select(LlmJob).where(LlmJob.intake_id == uuid.UUID(private_id)))
    url = f"/v1/llm-jobs/{job.id}"
    mine = (await client.get(url, headers=ctx.as_("author"))).json()
    assert (mine["input_tokens"], mine["output_tokens"], mine["cost_usd"]) == (900, 200, 0.02)
    for h in [ctx.as_(w) for w in ("viewer", "commenter", "approver", "owner")] + [
        _writes.as_run(ctx)
    ]:
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
    """A rejected critical answer stays open even after the baseline confirms the fact."""
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
    """A gap's elsewhere reason names the exact role that reviews its own category."""
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
    """A private gap reached through any write path still fails closed as a 404."""
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
    """Rewording a category's question text never turns its existing gaps private."""
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
    """Listing gaps or questions never looks up sharing for an intake outside the list."""
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
    """A huge list of hidden gap ids never breaks a query's bind-parameter limit."""
    ctx, private_id, _ = await twin_intakes(client)
    many = {uuid.uuid4() for _ in range(40_000)}

    async def hidden(*args, **kwargs):
        return many

    monkeypatch.setattr(views, "hidden_gap_ids", hidden)
    for path in ("/v1/gaps", "/v1/questions", "/v1/answers", "/v1/assumption-decisions",
                 "/v1/change-events"):  # fmt: skip
        resp = await client.get(path, headers=ctx.as_("viewer"))
        assert resp.status_code == 200, (path, resp.text[:300])


# -----------------------------------------------------------------------------
# Security review, round 4 (S6 follow-ups, owner 2026-10-19).
#
# 1. A critical gap from private sources blocks publishing only once its author shares it
#    (counts or above); while private the author is warned privately and publish passes.
# 2. The summary level shows a line Oracle drafts and the author edits or confirms; until
#    then others see only the fixed category line.
# 3. Agent runs, including the author's own, see each finding only at its sharing level.
# 4. Answering a question about a private finding proposes nothing to the baseline until
#    the author shares the finding.
#
# And: a person's importance edit is recorded the same way whatever private findings
# exist, it never flips when private evidence arrives, and private evidence never moves
# a shared row. Synthetic placeholders only.


OTHERS = ["viewer", "commenter", "approver", "owner"]


async def share(client, ctx, intake_id: str, fid: str, level: str, who: str = "author"):
    return await client.patch(
        f"/v1/intakes/{intake_id}/findings/{fid}", json={"sharing": level}, headers=ctx.as_(who)
    )


async def rows_of(ctx, intake_id: str) -> dict[str, tuple]:
    """Every gap and question row of the intake: (lock_version, updated_at, values)."""
    async with tenant_session(ctx.tenant_id) as s:
        gaps = (
            await s.scalars(select(KnowledgeGap).where(KnowledgeGap.intake_id == intake_id))
        ).all()
        questions = (
            await s.scalars(
                select(StakeholderQuestion).where(StakeholderQuestion.intake_id == intake_id)
            )
        ).all()
        out = {}
        for g in gaps:
            out[f"gap:{g.category}:{g.id}"] = (
                g.lock_version, g.updated_at, g.importance, list(g.evidence_ids),
                g.confidence, g.knowledge_state, g.status,
            )  # fmt: skip
        for q in questions:
            out[f"question:{q.category}:{q.id}"] = (
                q.updated_at, q.rationale, q.priority, q.status, q.prompt,
            )  # fmt: skip
        return out


async def intake_row(ctx, intake_id: str) -> tuple:
    async with tenant_session(ctx.tenant_id) as s:
        intake = await s.get(ProductIntake, uuid.UUID(intake_id))
        return intake.lock_version, intake.updated_at


async def plain_author_intake(client, **body) -> tuple:
    """An intake whose author pinned only an unrelated item (nothing private speaks to
    it yet)."""
    ctx = await company()
    await add_person(ctx, "author")
    await make_item(ctx, "author", content=UNRELATED, title="#offsite")
    out = await create_intake(client, ctx, who="author", **body)
    return ctx, out["intake"]["id"]


async def repin(client, ctx, intake_id: str) -> dict:
    resp = await client.post(f"/v1/intakes/{intake_id}/repin", headers=ctx.as_("author"))
    assert resp.status_code == 200, resp.text
    return resp.json()


async def set_importance(client, ctx, gap: dict, importance: str, who: str = "owner") -> dict:
    resp = await client.patch(
        f"/v1/gaps/{gap['id']}",
        json={"importance": importance, "lock_version": gap["lock_version"]},
        headers=ctx.as_(who),
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


# --- MAJOR 1: an importance edit changes the intake row the same way, entry or not -------


async def test_an_importance_edit_moves_no_intake_row_whatever_private_findings_exist(client):
    """Changing a gap's importance never moves its intake's row, private or not."""
    ctx, private_id, plain_id = await twin_intakes(client)
    async with tenant_session(ctx.tenant_id) as s:
        intake = await s.get(ProductIntake, uuid.UUID(private_id))
        registered = {e["category"] for e in intake.analysis["findings"].values()
                      if e.get("kind") == "gap"}  # fmt: skip
    assert "pain_evidence" in registered
    moved = []
    for intake_id in (private_id, plain_id):
        gap = gaps_by_category(await read_summary(client, ctx, intake_id, "viewer"))[
            "pain_evidence"
        ]
        before = await intake_row(ctx, intake_id)
        await set_importance(client, ctx, gap, "low")
        after = await intake_row(ctx, intake_id)
        moved.append((after[0] - before[0], after[1] != before[1]))
    assert moved[0] == moved[1] == (0, False)


# --- MAJOR 2: a person's importance never flips once private evidence appears ------------


async def test_a_person_set_importance_survives_private_evidence(client):
    """A person-set critical importance survives new private evidence added later."""
    ctx, intake_id = await plain_author_intake(client)
    gap = gaps_by_category(await read_summary(client, ctx, intake_id, "viewer"))["pain_evidence"]
    assert gap["importance"] != "critical"
    await set_importance(client, ctx, gap, "critical")
    # Now the author's sources speak to the pain, and the author repins.
    await make_item(ctx, "author", content=EXCERPT_A, title=TITLE_A)
    mine = await repin(client, ctx, intake_id)
    assert gaps_by_category(mine)["pain_evidence"]["knowledge_state"] == "ai_inference"
    for who in OTHERS:
        out = await read_summary(client, ctx, intake_id, who)
        shown = gaps_by_category(out)["pain_evidence"]
        assert shown["importance"] == "critical", who
        assert any(a["gap_id"] == shown["id"] for a in out["next_actions"]), who
        resp = await client.get(f"/v1/intakes/{intake_id}/composition-inputs", headers=ctx.as_(who))
        assert shown["id"] in resp.json()["blockers"]["open_critical_gap_ids"], who
        listed = await client.get(
            "/v1/gaps", params={"intake_id": intake_id, "importance": "critical"},
            headers=ctx.as_(who),
        )  # fmt: skip
        assert shown["id"] in {g["id"] for g in listed.json()}, who


# --- MAJOR 3: private evidence never moves a shared row ----------------------------------


async def test_a_repin_adding_private_evidence_moves_no_shared_row(client):
    """Repinning with new private evidence changes nothing any other viewer can see."""
    ctx, intake_id = await plain_author_intake(client, brief=BRIEF)
    before = await rows_of(ctx, intake_id)
    viewer_before = await read_summary(client, ctx, intake_id, "viewer")
    await make_item(ctx, "author", content=EXCERPT_A, title=TITLE_A)
    await make_item(ctx, "author", content=EXCERPT_B, title="#finance numbers")
    mine = await repin(client, ctx, intake_id)
    # The author sees what their sources say...
    assert gaps_by_category(mine)["pain_evidence"]["knowledge_state"] == "ai_inference"
    assert gaps_by_category(mine)["pain_evidence"]["evidence_ids"]
    # ...and no gap or question row moved.
    after = await rows_of(ctx, intake_id)
    assert after.keys() == before.keys()
    moved = [k for k in before if before[k] != after[k]]
    assert not moved, moved
    viewer_after = await read_summary(client, ctx, intake_id, "viewer")
    for out in (viewer_before, viewer_after):
        # What a repin itself changes, as it does on any intake.
        out.pop("pinned"), out.pop("new_evidence"), out["intake"].pop("source_snapshot_ids")
        out["intake"].pop("lock_version"), out["intake"].pop("updated_at")
    assert_same(viewer_after, viewer_before)


async def test_a_draft_question_stores_its_rationale_from_public_facts(client):
    """A draft question's stored rationale is built only from facts everyone can see."""
    ctx, private_id, plain_id = await twin_intakes(client)
    private = await rows_of(ctx, private_id)
    plain = await rows_of(ctx, plain_id)

    def rationales(rows):
        return sorted((k.split(":")[1], v[1]) for k, v in rows.items() if k.startswith("question"))

    assert rationales(private) == rationales(plain)


# --- MAJOR 4: no baseline proposal from a private finding until it is shared -------------


def _privacy_gap(payload):
    answer = _model_as_written(payload)
    answer["gaps"] = [{"category": "security_privacy", "importance": "high",
                       "statement": MODEL_GAP, "evidence_refs": []}]  # fmt: skip
    return answer


async def authored_with(client, fake, model) -> tuple:
    """:func:`authored_intake` with another model answer."""
    from tests import test_intake_sharing as base

    original = base._model
    base._model = model
    try:
        return await authored_intake(client, fake)
    finally:
        base._model = original


async def _model_question(ctx, intake_id: str) -> StakeholderQuestion:
    async with tenant_session(ctx.tenant_id) as s:
        gap = await s.scalar(
            select(KnowledgeGap).where(
                KnowledgeGap.intake_id == uuid.UUID(intake_id), KnowledgeGap.statement == MODEL_GAP
            )
        )
        return await s.scalar(
            select(StakeholderQuestion).where(StakeholderQuestion.gap_id == gap.id)
        )


async def _baseline_proposals(ctx) -> list[Proposal]:
    async with tenant_session(ctx.tenant_id) as s:
        return list((await s.scalars(select(Proposal))).all())


async def test_answering_a_private_finding_proposes_nothing_until_it_is_shared(client, fake):
    """Answering a still-private finding proposes nothing to the baseline until shared."""
    ctx, intake_id, _ = await authored_with(client, fake, _privacy_gap)
    q = await _model_question(ctx, intake_id)
    resp = await client.post(
        f"/v1/questions/{q.id}/answers",
        json={"kind": "answer", "body": "Addresses are stored encrypted."},
        headers=ctx.as_("author"),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["baseline_proposal_ids"] == []
    assert await _baseline_proposals(ctx) == []
    listed = await client.get("/v1/baseline/proposals", headers=ctx.as_("owner"))
    assert listed.status_code == 200 and listed.json() == []
    assert str(q.gap_id) not in listed.text and intake_id not in listed.text

    resp = await share(client, ctx, intake_id, str(q.gap_id), "counts")
    assert resp.status_code == 200, resp.text
    [proposal] = await _baseline_proposals(ctx)
    attrs = proposal.payload["fields"]["attrs"]
    # At counts, the gap's id and category only (owner, 2026-10-19; round 5).
    assert attrs == {"gap_id": str(q.gap_id), "category": "security_privacy"}
    assert MODEL_GAP not in json.dumps(proposal.payload)
    # Lowering to private withdraws the open proposal; sharing again makes a new one
    # (round 6, owner 2026-10-19).
    await share(client, ctx, intake_id, str(q.gap_id), "private")
    [withdrawn] = await _baseline_proposals(ctx)
    assert withdrawn.id == proposal.id and withdrawn.status == "withdrawn"
    await share(client, ctx, intake_id, str(q.gap_id), "summary")
    rows = await _baseline_proposals(ctx)
    assert sorted(p.status for p in rows) == ["open", "withdrawn"]


# --- S6 decision 1: a private critical gap gates publishing only once shared -------------


def _critical_blocker(payload):
    answer = _model_as_written(payload)
    answer["gaps"] = [{"category": "blockers", "importance": "critical",
                       "statement": f"The {CODENAME} quota blocks pre-fill.",
                       "evidence_refs": []}]  # fmt: skip
    return answer


async def _gate(ctx, document_id: str, principal: Principal | None = None):
    """The publish gate, or (``principal``) the advisory report that reader sees: a
    publish report never carries a reader's private findings (round 5)."""
    async with tenant_session(ctx.tenant_id) as s:
        return await readiness.evaluate(
            readiness.ReadinessContext(
                s,
                uuid.UUID(document_id),
                purpose="advisory" if principal is not None else "publish",
                viewer=principal,
            ),
            keys=[intake_checks.CRITICAL_BLOCKERS],
        )


def _principal(ctx, who: str) -> Principal:
    user = ctx.users[who]
    return Principal(tenant_id=ctx.tenant_id, kind="user", role=user.role, user_id=user.id)


async def test_a_private_critical_gap_warns_its_author_and_gates_once_shared(client, fake):
    """A private critical gap warns only its author; publish blocks once shared."""
    ctx = await company()
    await add_account(ctx.tenant_id, "personal", windows={"five_hour": window(0.2)})
    await add_author(ctx, "approver")
    await make_item(ctx, "author", content=EXCERPT_A, title=TITLE_A)
    doc = await _document(client, ctx)
    fake(_critical_blocker)
    out = await create_intake(client, ctx, who="author", ai_extraction=True, document=doc)
    assert (await worker.run_pending(ctx.tenant_id)).succeeded == 1
    intake_id, document_id = out["intake"]["id"], out["intake"]["document_id"]
    mine = await read_summary(client, ctx, intake_id, "author")
    [gap] = [g for g in mine["gaps"] if CODENAME in g["statement"]]

    # Private: publish is not blocked; the author alone is warned.
    report = await _gate(ctx, document_id)
    assert not report.blocked and CODENAME not in report.model_dump_json()
    for who in OTHERS:
        theirs = await _gate(ctx, document_id, _principal(ctx, who))
        assert not theirs.blocked and gap["id"] not in theirs.model_dump_json()
    warned = await _gate(ctx, document_id, _principal(ctx, "author"))
    assert not warned.blocked
    [result] = warned.results
    assert result.status == "warning" and gap["id"] in result.rationale
    assert "only you" in result.rationale.lower()
    assert mine["readiness"]["gate"] == "clear"
    assert mine["readiness"]["private_blocking_gap_ids"] == [gap["id"]]
    viewer = await read_summary(client, ctx, intake_id, "viewer")
    assert viewer["readiness"]["private_blocking_gap_ids"] == []

    # Shared as counts: it gates, named by nothing but its id and category.
    assert (await share(client, ctx, intake_id, gap["id"], "counts")).status_code == 200
    report = await _gate(ctx, document_id)
    assert report.blocked and gap["id"] in report.blocking[0].rationale
    assert CODENAME not in report.model_dump_json()
    viewer = await read_summary(client, ctx, intake_id, "viewer")
    assert viewer["readiness"]["gate"] == "blocked"
    assert gap["id"] in viewer["readiness"]["blocking_gap_ids"]
    assert CODENAME not in json.dumps(viewer)


# --- S6 decision 2: the summary level shows only what the author confirmed ---------------


async def test_the_summary_level_shows_the_fixed_line_until_the_author_confirms(client, fake):
    """At the summary level others see Oracle's draft line until the author confirms."""
    ctx, intake_id, _ = await authored_intake(client, fake)
    rows = await findings(client, ctx, intake_id)
    [gap] = [r for r in rows if r["kind"] == "gap" and r["origin"] == "model"]
    [item] = [r for r in rows if r["kind"] == "item" and r["origin"] == "model"]
    # The author sees Oracle's draft; nobody else does, at any level.
    assert gap["draft_summary"] and gap["summary_confirmed"] is False
    for r in (gap, item):
        assert (await share(client, ctx, intake_id, r["id"], "summary")).status_code == 200
    fixed = "Oracle found an open question about release and rollout in the author's sources."
    for who in OTHERS:
        out = await read_summary(client, ctx, intake_id, who)
        shown = next(g for g in out["gaps"] if g["id"] == gap["id"])
        assert shown["statement"] == fixed, who
        theirs = {f["id"]: f for f in await findings(client, ctx, intake_id, who)}
        assert theirs[gap["id"]]["summary"] == fixed
        assert theirs[gap["id"]].get("draft_summary") is None

    url = f"/v1/intakes/{intake_id}/findings/{gap['id']}/summary"
    for who in OTHERS:
        resp = await client.put(url, json={"text": "x y z"}, headers=ctx.as_(who))
        assert resp.status_code == 403, who
    resp = await client.put(url, json={"text": "x y z"}, headers=_writes.as_run(ctx))
    assert resp.status_code == 403
    # Confirmed as drafted.
    resp = await client.put(url, json={}, headers=ctx.as_("author"))
    assert resp.status_code == 200, resp.text
    assert resp.json()["summary_confirmed"] is True
    out = await read_summary(client, ctx, intake_id, "viewer")
    shown = next(g for g in out["gaps"] if g["id"] == gap["id"])
    assert shown["statement"] == gap["draft_summary"]
    # Edited.
    edited = "Rollout may be limited to some regions."
    resp = await client.put(url, json={"text": edited}, headers=ctx.as_("author"))
    assert resp.status_code == 200, resp.text
    out = await read_summary(client, ctx, intake_id, "viewer")
    assert next(g for g in out["gaps"] if g["id"] == gap["id"])["statement"] == edited
    async with tenant_session(ctx.tenant_id) as s:
        events = (
            await s.scalars(
                select(AuditEvent)
                .where(AuditEvent.action == "intake.finding_summary_set")
                .order_by(AuditEvent.created_at)
            )
        ).all()
    assert [e.data["edited"] for e in events] == [False, True]
    assert all(edited not in json.dumps(e.data) for e in events)
    # The item still shows its fixed line: it was never confirmed.
    out = await read_summary(client, ctx, intake_id, "viewer")
    [shown_item] = [i for i in out["extracted"] if i["origin"] == "llm"]
    assert shown_item["text"] == (
        "Oracle inferred something about the users from the author's sources."
    )


# --- S6 decision 3: runs read each finding at its sharing level only ----------------------


async def _run_of(ctx, intake_id: str) -> dict[str, str]:
    """Headers of a run the author created from the intake (its agents' REST calls)."""
    async with tenant_session(ctx.tenant_id) as s:
        run = Run(
            flow="baseline_to_prd", status="running", created_by=ctx.users["author"].id,
            knobs={"intake_id": intake_id},
        )  # fmt: skip
        s.add(run)
        await s.commit()
        run_id = run.id
    return {
        **_writes.as_run(ctx),
        "x-oracle-run-id": sign_run_binding(ctx.users["author"].id, run_id),
    }


@pytest.mark.parametrize("real_run", [False, True])
async def test_a_run_never_reads_a_private_findings_items(client, fake, real_run):
    """A run can never fetch, search or cite an item behind a still-private finding."""
    ctx, intake_id, items = await authored_intake(client, fake)
    h = await _run_of(ctx, intake_id) if real_run else _writes.as_run(ctx)
    pinned = (await read_summary(client, ctx, intake_id, "author"))["pinned"]["snapshot_id"]
    # Items behind private findings: the conflict's two and the stale one.
    withheld = {str(items["a"]), str(items["b"]), str(items["old"])}

    async def reads() -> str:
        out = []
        resp = await client.get(
            f"/v1/intakes/{intake_id}/evidence", params={"q": "buyers"}, headers=h
        )
        assert resp.status_code == 200, resp.text
        out.append(resp.text)
        for url, params in [
            ("/v1/search", {"q": "buyers"}),
            ("/v1/sources", {}),
            (f"/v1/snapshots/{pinned}/items", {}),
        ]:
            resp = await client.get(url, params=params, headers=h)
            assert resp.status_code in (200, 404), (url, resp.text)
            out.append(resp.text)
        for item in withheld:
            resp = await client.get(f"/v1/source-items/{item}", headers=h)
            assert resp.status_code == 404, resp.text
        return "\n".join(out)

    text = await reads()
    for secret in (CODENAME, "42%", "35%", TITLE_A, *withheld):
        assert secret not in text, secret
    # The author's own session still reads them.
    resp = await client.get("/v1/search", params={"q": "buyers"}, headers=ctx.as_("author"))
    assert str(items["a"]) in resp.text

    # One finding in full while the others stay private: the intake still withholds what
    # it read (round 6, owner 2026-10-19: the intake rule wins), so nothing is searched.
    rows = await findings(client, ctx, intake_id)
    [conflict] = [r for r in rows if r["kind"] == "conflict"]
    assert (await share(client, ctx, intake_id, conflict["id"], "full")).status_code == 200
    resp = await client.get(f"/v1/intakes/{intake_id}/evidence", params={"q": "buyers"},
                            headers=h)  # fmt: skip
    assert resp.json()["hits"] == []
    # Every finding in full: a run of the intake reads what the conflict cites.
    await share_all(client, ctx, intake_id, "full")
    resp = await client.get(f"/v1/intakes/{intake_id}/evidence", params={"q": "buyers"},
                            headers=h)  # fmt: skip
    hits = {x["source_item_id"]: x for x in resp.json()["hits"]}
    assert str(items["a"]) in hits and hits[str(items["a"])]["visible"]
    for hit in hits.values():
        assert hit["visible"] or hit["snippet"] is None


# --- minors --------------------------------------------------------------------------------


async def test_an_old_analysis_without_public_rows_reads_as_a_plain_one(client):
    """An analysis stored before the public rows and states were (no public_coverage,
    no public_state): others still read what a plain intake with the brief shows."""
    ctx, private_id, plain_id = await twin_intakes(client, brief=USERS_BRIEF)
    async with tenant_session(ctx.tenant_id) as s:
        intake = await s.get(ProductIntake, uuid.UUID(private_id))
        analysis = {k: v for k, v in intake.analysis.items() if k != "public_coverage"}
        analysis["findings"] = {
            fid: {k: v for k, v in e.items() if k != "public_state"}
            for fid, e in analysis["findings"].items()
        }
        intake.analysis = analysis
        await s.commit()
    for who in OTHERS:
        theirs = await read_summary(client, ctx, private_id, who)
        base = await read_summary(client, ctx, plain_id, who)
        assert_same(theirs["coverage"], base["coverage"])
        assert_same(
            [(g["category"], g["knowledge_state"]) for g in theirs["gaps"]],
            [(g["category"], g["knowledge_state"]) for g in base["gaps"]],
        )


async def test_a_baseline_answer_closes_an_asked_gap_with_its_row(client):
    """An asked gap the baseline now answers is answered, as its coverage row says."""
    from tests.baseline_helpers import confirm, entity

    ctx = await company()
    out = await create_intake(client, ctx, who="approver")
    intake_id = out["intake"]["id"]
    assert (
        gaps_by_category(await read_summary(client, ctx, intake_id, "viewer"))["goal_alignment"][
            "status"
        ]
        == "asked"
    )
    goal = await entity(
        client,
        ctx,
        type="goal",
        key="returning-buyers-checkout-faster",
        title="Returning buyers check out faster",
    )
    await confirm(client, ctx, goal)
    resp = await client.post(f"/v1/intakes/{intake_id}/analyze", headers=ctx.as_("approver"))
    assert resp.status_code == 200, resp.text
    summary = resp.json()
    row = {c["category"]: c for c in summary["coverage"]}["goal_alignment"]
    gap = gaps_by_category(summary)["goal_alignment"]
    assert row["state"] in ("covered", "partial")
    if row["state"] == "covered":
        assert gap["status"] in ("answered", "validated")
    else:
        assert gap["status"] == "answered_pending_review"


async def test_list_filters_match_what_readers_see(client):
    """``/v1/gaps?importance=`` matches the importance readers see, old rows included;
    ``/v1/questions`` filters on columns everyone reads (status), so a private intake's
    lists read as a plain one's."""
    ctx, private_id, plain_id = await twin_intakes(client, brief=USERS_BRIEF)
    async with tenant_session(ctx.tenant_id) as s:
        intake = await s.get(ProductIntake, uuid.UUID(private_id))
        reg = intake.analysis["findings"]
        for g in (
            await s.scalars(select(KnowledgeGap).where(KnowledgeGap.intake_id == intake.id))
        ).all():
            if str(g.id) in reg:
                # A row from before the basis was recorded, its importance once moved.
                g.importance_basis = None
                g.importance = "critical" if g.importance != "critical" else "low"
        await s.commit()

    async def listed(intake_id: str, url: str, **params) -> list[str]:
        resp = await client.get(
            url, params={"intake_id": intake_id, **params}, headers=ctx.as_("viewer")
        )
        assert resp.status_code == 200, resp.text
        return sorted(r["category"] for r in resp.json())

    for importance in ("critical", "high", "medium", "low"):
        assert await listed(private_id, "/v1/gaps", importance=importance) == await listed(
            plain_id, "/v1/gaps", importance=importance
        ), importance
    for status in ("draft", "asked"):
        assert await listed(private_id, "/v1/questions", status=status) == await listed(
            plain_id, "/v1/questions", status=status
        ), status


# -----------------------------------------------------------------------------
# Security review, round 5 (S6, B4 and AUD-9; owner decisions of 2026-10-19).
#
# Two owner decisions revise round 4:
#
# (a) while any finding from an intake is below "shared in full", runs cannot read ANY
#     item that intake's analysis read, cited or not; sharing the findings in full makes
#     them readable again;
# (b) a baseline proposal from an answer to a finding shared at "counts" carries only the
#     category's question, no answer text and no model-set severity; the answer text and
#     severity appear from "summary" up.
#
# Synthetic placeholders only.


# Matches the run's queries, outranks the shared items, and is never shared.
HIDDEN = "Zebra zebra zebra crossing: zebra zebra zebra buyers zebra notes."


async def share_round5(client, ctx, intake_id: str, fid: str, level: str, who: str = "author"):
    resp = await client.patch(
        f"/v1/intakes/{intake_id}/findings/{fid}", json={"sharing": level}, headers=ctx.as_(who)
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def source_of(ctx, item_id: uuid.UUID) -> str:
    async with tenant_session(ctx.tenant_id) as s:
        return str((await s.get(SourceItem, item_id)).source_id)


async def world(client, fake, *, hidden: bool, model=_model, role: str = "commenter", **body):
    """The author's intake over three private items (a conflict between a and b, a stale
    item), the model's analysis, and (``hidden``) two more items that match the run's
    queries: one in a chosen source the analysis did not find relevant, one in a source
    the intake did not choose."""
    ctx = await company()
    await add_account(ctx.tenant_id, "personal", windows={"five_hour": window(0.2)})
    await add_author(ctx, role)
    items = {
        "a": await make_item(ctx, "author", content=EXCERPT_A, title=TITLE_A),
        "b": await make_item(ctx, "author", content=EXCERPT_B, title="#finance numbers"),
        "old": await make_item(
            ctx, "author", content=EXCERPT_OLD, title="#old thread",
            updated=NOW - timedelta(days=3 * 365),
        ),
    }  # fmt: skip
    chosen = [await source_of(ctx, i) for i in items.values()]
    if hidden:
        items["h1"] = await make_item(ctx, "author", content=HIDDEN, title="#zebra one")
        chosen.append(await source_of(ctx, items["h1"]))
        items["h2"] = await make_item(ctx, "author", content=HIDDEN, title="#zebra two")
    fake(model)
    out = await create_intake(
        client, ctx, who="author", ai_extraction=True, source_ids=chosen, **body
    )
    tick = await worker.run_pending(ctx.tenant_id)
    assert tick.succeeded == 1, tick.errors
    return ctx, out["intake"]["id"], items


async def link(client, ctx, intake_id: str, doc: str) -> None:
    intake = await client.get(f"/v1/intakes/{intake_id}", headers=ctx.as_("approver"))
    resp = await client.patch(
        f"/v1/intakes/{intake_id}",
        json={"document": doc, "lock_version": intake.json()["lock_version"]},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text


async def finding_of(client, ctx, intake_id: str, kind: str, origin: str | None = None) -> dict:
    rows = [
        r
        for r in await findings(client, ctx, intake_id)
        if r["kind"] == kind and (origin is None or r["origin"] == origin)
    ]
    return rows[0]


# --- BLOCKER: the intake evidence search filters before it ranks and limits ---------------


async def test_a_runs_intake_search_reads_the_same_whether_hidden_items_match(client, fake):
    """A run's intake evidence search ranks and limits over the items it may be shown
    only: with any limit and any query, hidden items that match change nothing."""
    responses = {}
    for hidden in (False, True):
        ctx, intake_id, _ = await world(client, fake, hidden=hidden)
        # Every finding in full (round 6: a finding below full withholds the intake's
        # items from runs, so nothing would be searched at all).
        await share_all(client, ctx, intake_id, "full")
        out = []
        for q in ("buyers", "zebra or buyers", "buyers or zebra or address", "zebra"):
            for limit in (1, 2, 3, 5):
                resp = await client.get(
                    f"/v1/intakes/{intake_id}/evidence",
                    params={"q": q, "limit": limit},
                    headers=_writes.as_run(ctx),
                )
                assert resp.status_code == 200, resp.text
                hits = resp.json()["hits"]
                # Equal ranks break on random ids, so a tie may pick either shared item:
                # compare what ranks where, and every hit once the limit takes them all.
                shown = sorted((h["title"], h["snippet"], h["visible"]) for h in hits)
                out.append((q, limit, [h["relevance"] for h in hits],
                            shown if limit >= 3 else len(shown)))  # fmt: skip
        responses[hidden] = out
    assert responses[True] == responses[False]
    # And the shared items are found at every limit.
    assert all(ranks for q, _, ranks, _ in responses[True] if q != "zebra")


# --- MAJOR 1 (owner decision a): everything the analysis read is withheld ------------------


def _cites_nothing(payload):
    """A model analysis that read the sources and cites none of them."""
    return {
        "items": [{"field": "users", "text": "Returning buyers.", "evidence_refs": []}],
        "gaps": [{"category": "blockers", "importance": "critical",
                  "statement": f"The {CODENAME} quota blocks pre-fill.", "evidence_refs": []}],
        "category": "feature",
    }  # fmt: skip


async def run_reads(client, ctx, intake_id: str, items: dict) -> dict[str, int | str]:
    h = _writes.as_run(ctx)
    out: dict[str, int | str] = {}
    for name, item in items.items():
        out[name] = (await client.get(f"/v1/source-items/{item}", headers=h)).status_code
    resp = await client.get("/v1/search", params={"q": "buyers"}, headers=h)
    out["search"] = resp.text
    return out


async def test_a_finding_that_cites_nothing_withholds_everything_its_intake_read(client, fake):
    """A model finding that cites no source still hides every item the read touched."""
    ctx, intake_id, items = await world(client, fake, hidden=False, model=_cites_nothing)
    rows = await findings(client, ctx, intake_id)
    model = [r for r in rows if r["origin"] == "model"]
    assert model and all(r["sharing"] == "private" for r in model)
    # Every finding the rules made is shared in full; the model's cite nothing.
    changes = [{"finding_id": r["id"], "sharing": "full"} for r in rows if r["origin"] != "model"]
    resp = await client.post(
        f"/v1/intakes/{intake_id}/findings/sharing", json={"changes": changes},
        headers=ctx.as_("author"),
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    reads = await run_reads(client, ctx, intake_id, items)
    for name in ("a", "b", "old"):
        assert reads[name] == 404, (name, reads[name])
        assert str(items[name]) not in reads["search"]
    # Shared in full, all of them: readable again.
    for r in model:
        await share_round5(client, ctx, intake_id, r["id"], "full")
    reads = await run_reads(client, ctx, intake_id, items)
    assert reads["a"] == 200 and str(items["a"]) in reads["search"]


async def test_an_intake_without_the_record_withholds_what_it_read(client, fake):
    """An intake analysed before the record was kept: everything its stored analysis
    names is withheld (fail closed), whatever the levels say."""
    ctx, intake_id, items = await world(client, fake, hidden=False, model=_cites_nothing)
    for r in await findings(client, ctx, intake_id):
        await share_round5(client, ctx, intake_id, r["id"], "full")
    async with tenant_session(ctx.tenant_id) as s:
        intake = await s.get(ProductIntake, uuid.UUID(intake_id))
        intake.analysis = {k: v for k, v in intake.analysis.items() if k != "read_item_ids"}
        await s.flush()
        await ev.record_reads(s, intake)
        await s.commit()
    async with tenant_session(ctx.tenant_id) as s:
        intake = await s.get(ProductIntake, uuid.UUID(intake_id))
        relevant = set(intake.analysis["relevant_item_ids"])
    assert relevant
    reads = await run_reads(client, ctx, intake_id, items)
    for name, item in items.items():
        if str(item) in relevant:
            assert reads[name] == 404, name


# --- MAJOR 2: no route copies or quotes a withheld item for a run -------------------------


async def test_a_run_cannot_attach_a_withheld_item_as_baseline_evidence(client, fake):
    """A run cannot attach a withheld source item as evidence, though its author can."""
    ctx, intake_id, items = await world(client, fake, hidden=False, role="approver")
    risk = await entity(client, ctx, type="risk", key="address-risk", title="Address risk")
    h = _writes.as_run(ctx)
    for name in ("a", "b", "old"):
        resp = await client.post(
            f"/v1/baseline/entities/{risk['id']}/evidence",
            json={"source_item_id": str(items[name])}, headers=h,
        )  # fmt: skip
        assert resp.status_code == 404, (name, resp.text)
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.scalars(select(Evidence))).all() == []
    # The author's own session may cite it; a run then reads the evidence (copied at
    # the author's choice) but not the item behind it.
    resp = await client.post(
        f"/v1/baseline/entities/{risk['id']}/evidence",
        json={"source_item_id": str(items["a"])}, headers=ctx.as_("author"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    resp = await client.get("/v1/baseline/evidence", params={"entity_id": risk["id"]}, headers=h)
    assert resp.status_code == 200
    [shown] = resp.json()
    assert shown["source_item"] is None and shown["source_item_private"]
    yaml_out = await client.get("/v1/baseline/yaml", headers=h)
    assert str(items["a"]) not in yaml_out.text


async def test_a_run_cannot_cite_a_withheld_item_in_an_answer(client, fake):
    """A run cannot cite a withheld item when answering, though its author can."""
    ctx, intake_id, items = await world(client, fake, hidden=False)
    async with tenant_session(ctx.tenant_id) as s:
        q = await s.scalar(
            select(StakeholderQuestion).where(
                StakeholderQuestion.intake_id == uuid.UUID(intake_id),
                StakeholderQuestion.category == "pain_evidence",
            )
        )
    resp = await client.post(
        f"/v1/questions/{q.id}/answers",
        json={"kind": "answer", "body": "Yes.", "evidence_ids": [str(items["a"])]},
        headers=_writes.as_run(ctx),
    )
    assert resp.status_code == 422, resp.text
    resp = await client.post(
        f"/v1/questions/{q.id}/answers",
        json={"kind": "answer", "body": "Yes.", "evidence_ids": [str(items["a"])]},
        headers=ctx.as_("author"),
    )
    assert resp.status_code == 201, resp.text


# --- MAJOR 3 (owner decision b): counts proposes the question only ------------------------

ANSWER = "Only the EU region; the partner caps pre-fill at 1000 calls a day."


def _blocker_gap(payload):
    answer = _model_as_written(payload)
    answer["items"] = []
    answer["gaps"] = [{"category": "blockers", "importance": "critical",
                       "statement": MODEL_GAP, "evidence_refs": []}]  # fmt: skip
    return answer


async def _baseline_proposals_round5(ctx) -> list[Proposal]:
    async with tenant_session(ctx.tenant_id) as s:
        return list((await s.scalars(select(Proposal).order_by(Proposal.created_at))).all())


async def test_counts_proposes_only_the_categorys_question(client, fake):
    """Sharing a gap at counts proposes only its category question, not the answer."""
    ctx, intake_id, _ = await world(client, fake, hidden=False, model=_blocker_gap)
    async with tenant_session(ctx.tenant_id) as s:
        gap = await s.scalar(select(KnowledgeGap).where(KnowledgeGap.statement == MODEL_GAP))
        q = await s.scalar(select(StakeholderQuestion).where(StakeholderQuestion.gap_id == gap.id))
    resp = await client.post(
        f"/v1/questions/{q.id}/answers", json={"kind": "answer", "body": ANSWER},
        headers=ctx.as_("author"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    assert await _baseline_proposals_round5(ctx) == []
    prompt = cats.BY_KEY["blockers"].prompt

    await share_round5(client, ctx, intake_id, str(gap.id), "counts")
    [proposal] = await _baseline_proposals_round5(ctx)
    fields = proposal.payload["fields"]
    dumped = json.dumps(proposal.payload)
    # \b: random ids in the payload (e.g. "blockers-a5110000") may contain the digits.
    assert ANSWER not in dumped and not re.search(r"\b1000\b", dumped)
    assert CODENAME not in dumped
    assert fields["title"] == prompt and fields["body"] == prompt
    assert set(fields["attrs"]) <= {"gap_id", "category"}
    assert "severity" not in dumped and "critical" not in dumped
    assert intake_id not in dumped
    listed = await client.get("/v1/baseline/proposals", headers=ctx.as_("viewer"))
    assert ANSWER not in listed.text

    # Summary: the same proposal now carries the answer and the public severity.
    await share_round5(client, ctx, intake_id, str(gap.id), "summary")
    [same] = await _baseline_proposals_round5(ctx)
    assert same.id == proposal.id
    assert ANSWER in json.dumps(same.payload)
    async with tenant_session(ctx.tenant_id) as s:
        from oracle.intake.answers import importance_of

        intake = await s.get(ProductIntake, uuid.UUID(intake_id))
        expected = importance_of(intake, await s.get(KnowledgeGap, gap.id))
    assert same.payload["fields"]["attrs"]["proposed_blocker"]["severity"] == expected

    # Back to counts: stripped again.
    await share_round5(client, ctx, intake_id, str(gap.id), "counts")
    [again] = await _baseline_proposals_round5(ctx)
    assert again.id == proposal.id and ANSWER not in json.dumps(again.payload)
    assert "severity" not in json.dumps(again.payload)
    # Private (round 6, owner 2026-10-19): the open proposal is withdrawn, still stripped.
    await share_round5(client, ctx, intake_id, str(gap.id), "private")
    [again] = await _baseline_proposals_round5(ctx)
    assert again.id == proposal.id and again.status == "withdrawn"
    assert ANSWER not in json.dumps(again.payload) and "severity" not in json.dumps(again.payload)


async def test_answering_a_finding_at_counts_proposes_only_the_question(client, fake):
    """Answering a finding already shared at counts still keeps the answer out of it."""
    ctx, intake_id, _ = await world(client, fake, hidden=False, model=_blocker_gap)
    doc = await _document(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        gap = await s.scalar(select(KnowledgeGap).where(KnowledgeGap.statement == MODEL_GAP))
        q = await s.scalar(select(StakeholderQuestion).where(StakeholderQuestion.gap_id == gap.id))
    await link(client, ctx, intake_id, doc)
    await share_round5(client, ctx, intake_id, str(gap.id), "counts")
    resp = await client.post(
        f"/v1/questions/{q.id}/answers", json={"kind": "answer", "body": ANSWER},
        headers=ctx.as_("author"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    [proposal] = await _baseline_proposals_round5(ctx)
    assert ANSWER not in json.dumps(proposal.payload)
    # No PRD patch carries the answer while others may not read it.
    async with tenant_session(ctx.tenant_id) as s:
        patches = (await s.scalars(select(IntakeProposal))).all()
    assert all(ANSWER not in json.dumps(p.detail) for p in patches if p.kind == "prd_patch")


# --- minors ----------------------------------------------------------------------------------


async def test_a_publish_gate_never_carries_the_viewers_private_gaps(client, fake):
    """A publish gate never shows a viewer's private gap, though an advisory check may."""
    ctx = await company()
    await add_account(ctx.tenant_id, "personal", windows={"five_hour": window(0.2)})
    await add_author(ctx, "approver")
    await make_item(ctx, "author", content=EXCERPT_A, title=TITLE_A)
    doc = await _document(client, ctx)
    fake(_cites_nothing)
    out = await create_intake(client, ctx, who="author", ai_extraction=True, document=doc)
    assert (await worker.run_pending(ctx.tenant_id)).succeeded == 1
    document_id = uuid.UUID(out["intake"]["document_id"])
    author = _principal(ctx, "author")
    async with tenant_session(ctx.tenant_id) as s:
        publish = await readiness.evaluate(
            readiness.ReadinessContext(s, document_id, purpose="publish", viewer=author),
            keys=[intake_checks.CRITICAL_BLOCKERS],
        )
        advisory = await readiness.evaluate(
            readiness.ReadinessContext(s, document_id, viewer=author),
            keys=[intake_checks.CRITICAL_BLOCKERS],
        )
    assert CODENAME not in publish.model_dump_json()
    assert "only you" not in publish.model_dump_json().lower()
    assert CODENAME in advisory.model_dump_json()


async def _open_finding_intake(client, fake) -> tuple:
    """An intake whose model read no source: its findings are open (not restricted)."""
    ctx = await company()
    await add_account(ctx.tenant_id, "personal", windows={"five_hour": window(0.2)})
    await add_author(ctx)
    fake(_cites_nothing)
    out = await create_intake(client, ctx, who="author", ai_extraction=True)
    assert (await worker.run_pending(ctx.tenant_id)).succeeded == 1
    intake_id = out["intake"]["id"]
    async with tenant_session(ctx.tenant_id) as s:
        intake = await s.get(ProductIntake, uuid.UUID(intake_id))
        [fid] = [f for f, e in intake.analysis["findings"].items() if e.get("kind") == "gap"
                 and e.get("origin") == "model"]  # fmt: skip
        assert intake.analysis["findings"][fid].get("restricted") is False
    return ctx, intake_id, fid


async def test_an_unrestricted_finding_takes_no_summary_or_level(client, fake):
    """A finding that was never restricted refuses a summary or sharing-level edit."""
    ctx, intake_id, fid = await _open_finding_intake(client, fake)
    resp = await client.put(
        f"/v1/intakes/{intake_id}/findings/{fid}/summary", json={}, headers=ctx.as_("author")
    )
    assert resp.status_code == 409, resp.text
    resp = await client.patch(
        f"/v1/intakes/{intake_id}/findings/{fid}", json={"sharing": "full"},
        headers=ctx.as_("author"),
    )  # fmt: skip
    assert resp.status_code == 409, resp.text


async def test_run_withheld_reads_one_precomputed_set(client, fake, monkeypatch):
    """A run's withheld-item set comes from one precomputed table, never a live scan."""
    ctx, intake_id, items = await world(client, fake, hidden=False)

    def boom(*a, **k):
        raise AssertionError("run_withheld must not load and parse intakes")

    monkeypatch.setattr(sharing, "registry", boom)
    async with tenant_session(ctx.tenant_id) as s:
        run = Principal(
            tenant_id=ctx.tenant_id, kind="user", role="commenter",
            user_id=ctx.users["author"].id, run_id=uuid.uuid4(),
        )  # fmt: skip
        withheld = await ev.run_withheld(s, run)
    assert {items["a"], items["b"], items["old"]} <= withheld


async def test_a_runs_source_counts_match_what_it_may_list(client, fake):
    """A run's reported source item counts always match what it can actually list."""
    ctx, intake_id, items = await world(client, fake, hidden=False)
    h = _writes.as_run(ctx)
    sources = (await client.get("/v1/sources", headers=h)).json()
    for source in sources:
        listed = await client.get(f"/v1/sources/{source['id']}/items", headers=h)
        assert source["item_count"] == len(listed.json()), source["name"]
    one = await client.get(f"/v1/sources/{sources[0]['id']}", headers=h)
    listed = await client.get(f"/v1/sources/{sources[0]['id']}/items", headers=h)
    assert one.json()["item_count"] == len(listed.json())
    # The author's own session counts everything.
    mine = (await client.get("/v1/sources", headers=ctx.as_("author"))).json()
    assert sum(s["item_count"] for s in mine) == 3


async def test_a_private_findings_summary_audit_names_only_its_id(client, fake):
    """Setting a private finding's summary logs only its id, nothing else about it."""
    ctx, intake_id, _ = await world(client, fake, hidden=False)
    gap = await finding_of(client, ctx, intake_id, "gap", "model")
    resp = await client.put(
        f"/v1/intakes/{intake_id}/findings/{gap['id']}/summary", json={"text": "Rollout plan"},
        headers=ctx.as_("author"),
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        [event] = (
            await s.scalars(
                select(AuditEvent).where(AuditEvent.action == "intake.finding_summary_set")
            )
        ).all()
    assert event.data == {"finding_id": gap["id"]}


async def test_legacy_importance_rows_are_indexed_and_normalized(client, fake):
    """Re-analyzing backfills a missing importance basis on every legacy rule gap."""
    ctx, intake_id, _ = await world(client, fake, hidden=False)
    async with tenant_session(ctx.tenant_id) as s:
        names = (
            await s.scalars(
                text("SELECT indexname FROM pg_indexes WHERE tablename = 'knowledge_gaps'")
            )
        ).all()
        assert "ix_knowledge_gaps_legacy_importance" in names
        for g in (
            await s.scalars(
                select(KnowledgeGap).where(
                    KnowledgeGap.intake_id == uuid.UUID(intake_id),
                    KnowledgeGap.rule_key.is_not(None),
                )
            )
        ).all():
            g.importance_basis = None
        await s.commit()
    resp = await client.post(f"/v1/intakes/{intake_id}/analyze", headers=ctx.as_("author"))
    assert resp.status_code == 200, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        legacy = (
            await s.scalars(
                select(KnowledgeGap).where(
                    KnowledgeGap.rule_key.is_not(None), KnowledgeGap.importance_basis.is_(None)
                )
            )
        ).all()
    assert legacy == []


# --- also checked: stale rows, research proposals, PRD patches, B4 -------------------------


async def test_a_stale_finding_at_summary_shows_its_line_not_its_row(client, fake):
    """A stale finding at the summary level shows only its summary line, not its data."""
    ctx, intake_id, items = await world(client, fake, hidden=False)
    stale = await finding_of(client, ctx, intake_id, "stale")
    await share_round5(client, ctx, intake_id, stale["id"], "summary")
    for who in OTHERS:
        out = await read_summary(client, ctx, intake_id, who)
        [row] = out["stale"]
        assert "freshness" not in row["reason"], who
        assert row["evidence"]["visible"] is False
        assert row["reason"] == stale["summary"], who


async def test_research_and_patches_of_a_finding_shared_as_counts_stay_hidden(client, fake):
    """Research proposals and patches of a counts-shared finding stay hidden too."""
    ctx, intake_id, _ = await world(client, fake, hidden=False, model=_blocker_gap)
    async with tenant_session(ctx.tenant_id) as s:
        gap = await s.scalar(select(KnowledgeGap).where(KnowledgeGap.statement == MODEL_GAP))
    resp = await client.post(f"/v1/gaps/{gap.id}/research", headers=ctx.as_("author"))
    assert resp.status_code == 201, resp.text
    proposal = resp.json()
    assert MODEL_GAP not in resp.text
    await share_round5(client, ctx, intake_id, str(gap.id), "counts")
    for who in OTHERS:
        resp = await client.get(f"/v1/intakes/{intake_id}/proposals", headers=ctx.as_(who))
        assert proposal["id"] not in resp.text, who
        resp = await client.post(
            f"/v1/intake-proposals/{proposal['id']}/accept", headers=ctx.as_(who)
        )
        assert resp.status_code in (403, 404), who
    resp = await client.get(f"/v1/intakes/{intake_id}/proposals", headers=_writes.as_run(ctx))
    assert proposal["id"] not in resp.text


async def test_a_prd_patch_is_not_accepted_while_others_may_not_read_it(client, fake):
    """A PRD patch cannot be accepted while others still cannot read its basis."""
    ctx, intake_id, _ = await world(client, fake, hidden=False, model=_blocker_gap, role="owner")
    doc = await _document(client, ctx)
    await link(client, ctx, intake_id, doc)
    async with tenant_session(ctx.tenant_id) as s:
        gap = await s.scalar(select(KnowledgeGap).where(KnowledgeGap.statement == MODEL_GAP))
        q = await s.scalar(select(StakeholderQuestion).where(StakeholderQuestion.gap_id == gap.id))
    await share_round5(client, ctx, intake_id, str(gap.id), "summary")
    resp = await client.post(
        f"/v1/questions/{q.id}/answers", json={"kind": "answer", "body": ANSWER},
        headers=ctx.as_("author"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    [patch] = [p for p in resp.json()["proposals"] if p["kind"] == "prd_patch"]
    await share_round5(client, ctx, intake_id, str(gap.id), "counts")
    resp = await client.post(
        f"/v1/intake-proposals/{patch['id']}/accept", headers=ctx.as_("author")
    )
    assert resp.status_code == 409, resp.text
    inbox = await client.get("/v1/inbox", headers=ctx.as_("approver"))
    assert ANSWER not in inbox.text


async def _critical_blocker_gap(client, ctx, intake_id: str) -> dict:
    gap = gaps_by_category(await read_summary(client, ctx, intake_id, "viewer"))["blockers"]
    if gap["importance"] != "critical":
        resp = await client.patch(
            f"/v1/gaps/{gap['id']}",
            json={"importance": "critical", "lock_version": gap["lock_version"]},
            headers=ctx.as_("owner"),
        )
        assert resp.status_code == 200, resp.text
        gap = resp.json()
    return gap


async def test_b4_only_an_owner_accepts_a_blockers_risk_for_at_most_90_days(client):
    """Only an owner may accept a blocker's risk, and never for more than 90 days."""
    ctx = await company()
    out = await create_intake(client, ctx, who="approver")
    intake_id = out["intake"]["id"]
    gap = await _critical_blocker_gap(client, ctx, intake_id)
    url = f"/v1/gaps/{gap['id']}/decisions"
    resp = await client.post(
        url, json={"decision": "accept_risk", "rationale": "Partner said yes."},
        headers=ctx.as_("approver"),
    )  # fmt: skip
    assert resp.status_code == 403
    assert resp.json()["detail"] == "Only an owner can accept this risk"
    late = (datetime.now(UTC) + timedelta(days=120)).isoformat()
    resp = await client.post(
        url, json={"decision": "accept_risk", "rationale": "Partner said yes.", "review_at": late},
        headers=ctx.as_("owner"),
    )  # fmt: skip
    assert resp.status_code == 422, resp.text
    resp = await client.post(
        url, json={"decision": "accept_risk", "rationale": "Partner said yes."},
        headers=ctx.as_("owner"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    review_at = datetime.fromisoformat(resp.json()["decision"]["review_at"])
    assert review_at <= datetime.now(UTC) + timedelta(days=90, minutes=1)


async def test_b4_a_critical_gaps_risk_is_reviewed_within_the_company_setting(client):
    """protects=INT-3/B4: a critical gap's accepted risk is reviewed within the company's
    ``blocker_risk_review_max_days``, as a blocker's is; fails_when=the gap reads a fixed
    90 days; no_claim=who may accept it (the test above)."""
    ctx = await company()
    resp = await client.put(
        "/v1/settings/blocker_risk_review_max_days", json={"value": 30}, headers=ctx.as_("owner")
    )
    assert resp.status_code == 200, resp.text
    out = await create_intake(client, ctx, who="approver")
    gap = await _critical_blocker_gap(client, ctx, out["intake"]["id"])
    url = f"/v1/gaps/{gap['id']}/decisions"
    later = (datetime.now(UTC) + timedelta(days=45)).isoformat()
    resp = await client.post(
        url, json={"decision": "accept_risk", "rationale": "Partner said yes.", "review_at": later},
        headers=ctx.as_("owner"),
    )  # fmt: skip
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"] == "Accepting a critical gap is reviewed within 30 days"
    resp = await client.post(
        url, json={"decision": "accept_risk", "rationale": "Partner said yes."},
        headers=ctx.as_("owner"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    review_at = datetime.fromisoformat(resp.json()["decision"]["review_at"])
    assert review_at <= datetime.now(UTC) + timedelta(days=30, minutes=1)
    assert review_at >= datetime.now(UTC) + timedelta(days=29)


# -----------------------------------------------------------------------------
# Security review, round 6 (S6 and AUD-9; owner decisions of 2026-10-19).
#
# Two owner decisions:
#
# (1) a finding shared in full makes its cited documents readable to runs in full text
#     (search and read), while people see title, link and the 400-character excerpt; this
#     still yields to the intake rule (while any finding of the same intake is below
#     "shared in full", that intake's items stay withheld from runs);
# (2) lowering a finding back to private withdraws its open baseline proposal; sharing
#     again recreates it; accepted or rejected proposals stay.
#
# Synthetic placeholders only.


RUNS = ["author", "approver"]


def as_run_of(ctx, who: str) -> dict[str, str]:
    """A run token of a run ``who`` created, as it reaches REST (``as_run`` for others)."""
    cookie = make_session_cookie(ctx.users[who])
    return {"cookie": f"{get_settings().session_cookie_name}={cookie}",
            "x-oracle-run-id": sign_run_binding(ctx.users[who].id, uuid.uuid4())}  # fmt: skip


async def evidence_hits(client, ctx, intake_id: str, who: str, q: str = "buyers") -> list[dict]:
    resp = await client.get(
        f"/v1/intakes/{intake_id}/evidence", params={"q": q, "limit": 50},
        headers=as_run_of(ctx, who),
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    return resp.json()["hits"]


async def run_view(client, ctx, who: str, item_id) -> tuple[int, bool]:
    """(GET /v1/source-items/{id} status, listed by /v1/search) for ``who``'s run."""
    h = as_run_of(ctx, who)
    status_code = (await client.get(f"/v1/source-items/{item_id}", headers=h)).status_code
    resp = await client.get("/v1/search", params={"q": "buyers", "limit": 100}, headers=h)
    assert resp.status_code == 200, resp.text
    listed = str(item_id) in {h["item"]["id"] for h in resp.json()["hits"]}
    return status_code, listed


# --- item 1 (decision 1): runs read what findings shared in full cite, less withheld --------


async def test_every_run_reads_what_its_intake_search_finds_and_nothing_else(client, fake):
    """All findings shared in full: the author's run and another user's run search the
    cited items in full text here, and read and find the very same items on the sources
    routes; an item no finding cites is neither searched here nor readable by another
    user's run."""
    ctx, intake_id, items = await world(client, fake, hidden=True)
    await share_all(client, ctx, intake_id, "full")
    for who in RUNS:
        hits = await evidence_hits(client, ctx, intake_id, who)
        found = {h["source_item_id"] for h in hits}
        assert {str(items["a"]), str(items["b"])} <= found, who
        assert str(items["h1"]) not in found and str(items["h2"]) not in found, who
        for hit in hits:
            assert hit["visible"] and hit["snippet"], (who, hit)
            assert await run_view(client, ctx, who, hit["source_item_id"]) == (200, True), who
        # Read in full text.
        resp = await client.get(f"/v1/source-items/{items['a']}", headers=as_run_of(ctx, who))
        assert resp.json()["content"] == EXCERPT_A, who
    # Another user's run never reads what no finding cites.
    assert await run_view(client, ctx, "approver", items["h1"]) == (404, False)
    assert await run_view(client, ctx, "approver", items["h2"]) == (404, False)


async def test_a_withheld_item_is_searched_read_and_shown_by_no_run(client, fake):
    """One finding shared in full, the rest private: the intake withholds everything it
    read, so no run (the author's own included) searches, reads, finds or sees the
    excerpt of the full finding's items."""
    ctx, intake_id, items = await world(client, fake, hidden=False)
    conflict = await finding_of(client, ctx, intake_id, "conflict")
    await share_round5(client, ctx, intake_id, conflict["id"], "full")
    for who in RUNS:
        assert await evidence_hits(client, ctx, intake_id, who) == [], who
        for name in ("a", "b", "old"):
            assert await run_view(client, ctx, who, items[name]) == (404, False), (who, name)
        resp = await client.get(f"/v1/intakes/{intake_id}/summary", headers=as_run_of(ctx, who))
        assert resp.status_code == 200, resp.text
        assert EXCERPT_A[:60] not in resp.text and TITLE_A not in resp.text, who
    # People still see the full finding's title and excerpt.
    viewer = await read_summary(client, ctx, intake_id, "viewer")
    assert TITLE_A in json.dumps(viewer)
    # Everything in full: readable again, by every run.
    await share_all(client, ctx, intake_id, "full")
    for who in RUNS:
        assert str(items["a"]) in {h["source_item_id"] for h in await evidence_hits(
            client, ctx, intake_id, who)}  # fmt: skip
        assert await run_view(client, ctx, who, items["a"]) == (200, True), who


# --- item 2 (decision 2): lowering to private withdraws the open proposal ------------------


async def _answer_model_gap(client, ctx) -> KnowledgeGap:
    async with tenant_session(ctx.tenant_id) as s:
        gap = await s.scalar(select(KnowledgeGap).where(KnowledgeGap.statement == MODEL_GAP))
        q = await s.scalar(select(StakeholderQuestion).where(StakeholderQuestion.gap_id == gap.id))
    resp = await client.post(
        f"/v1/questions/{q.id}/answers", json={"kind": "answer", "body": ANSWER},
        headers=ctx.as_("author"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    return gap


async def _status(ctx, proposal_id) -> str:
    async with tenant_session(ctx.tenant_id) as s:
        return (await s.get(Proposal, proposal_id)).status


async def test_private_withdraws_the_open_proposal_and_sharing_again_recreates_it(client, fake):
    """Making a gap private withdraws its open proposal; sharing again remakes it."""
    ctx, intake_id, _ = await world(client, fake, hidden=False, model=_blocker_gap)
    gap = await _answer_model_gap(client, ctx)
    await share_round5(client, ctx, intake_id, str(gap.id), "summary")
    [first] = await _baseline_proposals_round5(ctx)
    assert ANSWER in json.dumps(first.payload)

    await share_round5(client, ctx, intake_id, str(gap.id), "private")
    assert await _status(ctx, first.id) == "withdrawn"
    listed = await client.get("/v1/baseline/proposals", headers=ctx.as_("owner"))
    assert str(first.id) not in listed.text and ANSWER not in listed.text
    resp = await client.post(f"/v1/baseline/proposals/{first.id}/accept", headers=ctx.as_("owner"))
    assert resp.status_code == 404, resp.text

    # Shared again: a new proposal, at the new level (the question only at counts).
    await share_round5(client, ctx, intake_id, str(gap.id), "counts")
    opened = [p for p in await _baseline_proposals_round5(ctx) if p.status == "open"]
    assert len(opened) == 1 and opened[0].id != first.id
    assert ANSWER not in json.dumps(opened[0].payload)
    await share_round5(client, ctx, intake_id, str(gap.id), "summary")
    [again] = [p for p in await _baseline_proposals_round5(ctx) if p.status == "open"]
    assert again.id == opened[0].id and ANSWER in json.dumps(again.payload)


async def test_decided_proposals_stay_and_the_answer_follows_a_decided_question(client, fake):
    """A question-only proposal is never accepted (409); once rejected it stays rejected
    through every level, and the answer reaches the baseline as a follow-up proposal
    from summary up."""
    ctx, intake_id, _ = await world(client, fake, hidden=False, model=_blocker_gap)
    gap = await _answer_model_gap(client, ctx)
    await share_round5(client, ctx, intake_id, str(gap.id), "counts")
    [question] = await _baseline_proposals_round5(ctx)
    resp = await client.post(
        f"/v1/baseline/proposals/{question.id}/accept", headers=ctx.as_("owner")
    )
    assert resp.status_code == 409, resp.text
    assert "waits for the author to share the answer" in resp.text
    assert await _status(ctx, question.id) == "open"
    resp = await client.post(
        f"/v1/baseline/proposals/{question.id}/reject", headers=ctx.as_("approver")
    )
    assert resp.status_code == 200, resp.text

    await share_round5(client, ctx, intake_id, str(gap.id), "summary")
    rows = await _baseline_proposals_round5(ctx)
    [follow_up] = [p for p in rows if p.id != question.id]
    assert follow_up.status == "open" and ANSWER in json.dumps(follow_up.payload)
    assert await _status(ctx, question.id) == "rejected"
    resp = await client.post(
        f"/v1/baseline/proposals/{follow_up.id}/accept", headers=ctx.as_("owner")
    )
    assert resp.status_code == 200, resp.text
    # Decided proposals stay as decided, whatever the level becomes.
    for level in ("private", "counts", "summary"):
        await share_round5(client, ctx, intake_id, str(gap.id), level)
        assert await _status(ctx, question.id) == "rejected", level
        assert await _status(ctx, follow_up.id) == "accepted", level
        assert len(await _baseline_proposals_round5(ctx)) == 2, level


# --- item 3: what a job, the summary and the lists give away -------------------------------


async def test_an_intake_jobs_input_holds_no_source_text(client, fake):
    """job.input keeps the prompt's name and the snapshot id only, never the rendered
    prompt with the author's excerpts."""
    ctx, intake_id, _ = await world(client, fake, hidden=False)
    async with tenant_session(ctx.tenant_id) as s:
        job = await s.scalar(select(LlmJob).where(LlmJob.intake_id == uuid.UUID(intake_id)))
    assert set(job.input) <= {"snapshot_id", "prompt"}
    for headers in [ctx.as_(w) for w in OTHERS] + [as_run_of(ctx, w) for w in RUNS]:
        resp = await client.get(f"/v1/llm-jobs/{job.id}", headers=headers)
        assert resp.status_code == 200, resp.text
        for secret in (CODENAME, EXCERPT_A[:40], EXCERPT_OLD[:40], TITLE_A):
            assert secret not in resp.text


# --- minors ----------------------------------------------------------------------------------


async def test_an_unregistered_model_gap_keeps_its_intakes_reads_withheld(client, fake):
    """A model-written gap with no registry entry (written before S6) is private, so
    the intake withholds what it read even when every registered finding is full."""
    ctx, intake_id, items = await world(client, fake, hidden=False)
    await share_all(client, ctx, intake_id, "full")
    assert (await run_view(client, ctx, "author", items["a"]))[0] == 200
    async with tenant_session(ctx.tenant_id) as s:
        intake = await s.get(ProductIntake, uuid.UUID(intake_id))
        gap = await s.scalar(select(KnowledgeGap).where(KnowledgeGap.statement == MODEL_GAP))
        findings_ = {k: v for k, v in intake.analysis["findings"].items() if k != str(gap.id)}
        intake.analysis = {**intake.analysis, "findings": findings_}
        await s.flush()
        await ev.record_reads(s, intake)
        await s.commit()
    for who in RUNS:
        assert await run_view(client, ctx, who, items["a"]) == (404, False), who


async def test_two_writers_recording_the_same_intakes_reads_never_conflict(client, fake):
    """Two concurrent read records for the same intake never conflict or duplicate."""
    ctx, intake_id, _ = await world(client, fake, hidden=False)
    iid = uuid.UUID(intake_id)
    async with tenant_session(ctx.tenant_id) as s:
        await s.execute(delete(IntakeWithheldItem))
        await s.commit()
    async with tenant_session(ctx.tenant_id) as s1, tenant_session(ctx.tenant_id) as s2:
        await ev.record_reads(s1, await s1.get(ProductIntake, iid))
        second = asyncio.create_task(ev.record_reads(s2, await s2.get(ProductIntake, iid)))
        await asyncio.sleep(0.5)  # s2's insert now waits on s1's rows
        await s1.commit()
        await second
        await s2.commit()
    async with tenant_session(ctx.tenant_id) as s:
        count = await s.scalar(select(func.count()).select_from(IntakeWithheldItem))
        expected = len(ev.read_item_ids(await s.get(ProductIntake, iid)))
    assert count == expected > 0


async def test_lowering_to_private_audits_the_finding_id_only(client, fake):
    """Lowering a finding to private logs only its id, never its kind or category."""
    ctx, intake_id, _ = await world(client, fake, hidden=False)
    conflict = await finding_of(client, ctx, intake_id, "conflict")
    await share_round5(client, ctx, intake_id, conflict["id"], "counts")
    await share_round5(client, ctx, intake_id, conflict["id"], "private")
    async with tenant_session(ctx.tenant_id) as s:
        events = (
            await s.scalars(
                select(AuditEvent)
                .where(AuditEvent.action == "intake.finding_shared")
                .order_by(AuditEvent.created_at)
            )
        ).all()
    shared, lowered = events
    assert shared.data["kind"] == "conflict"
    assert lowered.data["finding_id"] == conflict["id"]
    assert "kind" not in lowered.data and "category" not in lowered.data


async def test_a_stale_finding_at_summary_shows_no_confidence(client, fake):
    """The confidence counts freshness, which the summary level hides."""
    ctx, intake_id, _ = await world(client, fake, hidden=False)
    stale = await finding_of(client, ctx, intake_id, "stale")
    await share_round5(client, ctx, intake_id, stale["id"], "summary")
    for who in OTHERS:
        [row] = (await read_summary(client, ctx, intake_id, who))["stale"]
        assert row["evidence"]["confidence"] is None, who
    await share_round5(client, ctx, intake_id, stale["id"], "full")
    [row] = (await read_summary(client, ctx, intake_id, "viewer"))["stale"]
    assert row["evidence"]["confidence"] is not None
    mine = (await read_summary(client, ctx, intake_id, "author"))["stale"]
    assert mine[0]["evidence"]["confidence"] is not None
    assert [f for f in await findings(client, ctx, intake_id) if f["kind"] == "stale"]


# -----------------------------------------------------------------------------
# Security review, round 7 (S6, owner decision of 2026-10-19: freeze at sharing).
#
# (1) Sharing a finding in full releases exactly the documents and versions it cited at
#     that moment; documents a later analysis adds, and newer versions, stay withheld
#     until the author shares again;
# (2) documents deleted upstream stop being readable, and a search's ``as_of`` never
#     reaches another version of a shared item;
# (3) a re-analysis that makes a finding private withdraws its open proposal, and a
#     withdrawn proposal keeps no answer text;
# (4) an accept and a withdraw of the same proposal never both win.
#
# Synthetic placeholders only.


# A new support thread a later sync brings: the analysis cites it as pain evidence.
NEW_PAIN = (
    "Support thread: returning buyers say retyping the shipping address at checkout is "
    "slow, and several abandon the cart."
)
# A word only an upstream edit of item a holds.
EDIT_WORD = "Quetzalcoatl"
EDITED_A = f"Returning buyers now say the {EDIT_WORD} address book fixed checkout for them."


async def _sync(ctx, item_id: uuid.UUID, content: str, *, new: bool = False) -> uuid.UUID:
    """Sync into the source of ``item_id``: an edit of that item, or (``new``) a new item."""
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.get(SourceItem, item_id)
        source = await s.get(Source, item.source_id)
        event = ItemUpsert(
            external_id=uuid.uuid4().hex if new else item.external_id, kind="message",
            title="#support thread" if new else item.title, url=item.url, author=None,
            content=content, source_updated_at=datetime.now(UTC),
        )  # fmt: skip
        row, _ = await store.upsert_item(s, source, event)
        await s.commit()
        return row.id


async def _delete(ctx, item_id: uuid.UUID) -> None:
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.get(SourceItem, item_id)
        source = await s.get(Source, item.source_id)
        assert await store.delete_item(s, source, ItemDelete(external_id=item.external_id))
        await s.commit()


async def _repin(client, ctx, intake_id: str) -> None:
    resp = await client.post(f"/v1/intakes/{intake_id}/repin", headers=ctx.as_("author"))
    assert resp.status_code == 200, resp.text


async def _search(client, ctx, who: str, q: str, **params) -> list[dict]:
    resp = await client.get(
        "/v1/search", params={"q": q, "limit": 100, **params}, headers=as_run_of(ctx, who)
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["hits"]


# --- item 1: freeze at sharing -----------------------------------------------------------


async def test_an_item_a_reanalysis_adds_stays_withheld_until_shared_again(client, fake):  # noqa: F811
    """The reviewer's probe: every finding in full; a new item syncs and the next
    analysis cites it under a finding already in full; no run reads or searches it
    until the author shares that finding again."""
    ctx, intake_id, items = await world(client, fake, hidden=False)
    await share_all(client, ctx, intake_id, "full")
    new = await _sync(ctx, items["a"], NEW_PAIN, new=True)
    await _repin(client, ctx, intake_id)
    rows = await findings(client, ctx, intake_id)
    assert all(f["sharing"] == "full" for f in rows)
    citing = [f for f in rows if str(new) in f["source_item_ids"]]
    assert citing
    # The author is told what is new since they shared.
    assert all(f["unshared_item_ids"] == [str(new)] for f in citing)

    for who in RUNS:
        assert await run_view(client, ctx, who, new) == (404, False), who
        found = {h["source_item_id"] for h in await evidence_hits(client, ctx, intake_id, who)}
        assert str(new) not in found, who
        # What was shared stays readable.
        assert await run_view(client, ctx, who, items["a"]) == (200, True), who

    for f in citing:
        await share_round5(client, ctx, intake_id, f["id"], "full")
    assert all(f["unshared_item_ids"] == [] for f in await findings(client, ctx, intake_id))
    for who in RUNS:
        assert await run_view(client, ctx, who, new) == (200, True), who


async def test_an_item_edited_upstream_after_sharing_serves_the_frozen_text(client, fake):  # noqa: F811
    """A source edited after sharing still serves the version frozen at share time."""
    ctx, intake_id, items = await world(client, fake, hidden=False)
    await share_all(client, ctx, intake_id, "full")
    await _sync(ctx, items["a"], EDITED_A)
    for who in RUNS:
        h = as_run_of(ctx, who)
        resp = await client.get(f"/v1/source-items/{items['a']}", headers=h)
        assert resp.status_code == 200, resp.text
        assert resp.json()["content"] == EXCERPT_A, who
        assert await _search(client, ctx, who, EDIT_WORD) == [], who
        hits = {x["item"]["id"]: x for x in await _search(client, ctx, who, "buyers")}
        assert EDIT_WORD not in hits[str(items["a"])]["snippet"], who
        for hit in await evidence_hits(client, ctx, intake_id, who):
            assert EDIT_WORD not in json.dumps(hit), who
    # Shared again: the newer version is released.
    await share_all(client, ctx, intake_id, "full")
    for who in RUNS:
        assert await _search(client, ctx, who, EDIT_WORD) == [], who  # not pinned yet
    await _repin(client, ctx, intake_id)
    await share_all(client, ctx, intake_id, "full")
    for who in RUNS:
        resp = await client.get(f"/v1/source-items/{items['a']}", headers=as_run_of(ctx, who))
        assert resp.json()["content"] == EDITED_A, who


# --- item 2: deleted items and as_of ------------------------------------------------------


async def test_a_deleted_shared_item_is_a_404_for_runs_and_never_found(client, fake):  # noqa: F811
    """A shared item that gets deleted is a 404 for a run and vanishes from search."""
    ctx, intake_id, items = await world(client, fake, hidden=False)
    await share_all(client, ctx, intake_id, "full")
    for who in RUNS:
        assert await run_view(client, ctx, who, items["a"]) == (200, True), who
    await _delete(ctx, items["a"])
    for who in RUNS:
        assert await run_view(client, ctx, who, items["a"]) == (404, False), who
        found = {h["source_item_id"] for h in await evidence_hits(client, ctx, intake_id, who)}
        assert str(items["a"]) not in found, who


async def test_as_of_never_reaches_another_version_of_a_shared_item(client, fake):  # noqa: F811
    """Asking for an earlier time still returns a shared item's one frozen version."""
    ctx, intake_id, items = await world(client, fake, hidden=False)
    await share_all(client, ctx, intake_id, "full")
    frozen = (
        await client.get(f"/v1/source-items/{items['a']}", headers=as_run_of(ctx, "approver"))
    ).json()["version_id"]
    await _sync(ctx, items["a"], EDITED_A)
    later = datetime.now(UTC).isoformat()
    for who in RUNS:
        assert await _search(client, ctx, who, EDIT_WORD, as_of=later) == [], who
        hits = await _search(client, ctx, who, "buyers", as_of=later)
        [hit] = [x for x in hits if x["item"]["id"] == str(items["a"])]
        assert hit["item"]["version_id"] == frozen, who
        # Before the item existed: still the frozen version, never none or another.
        early = await _search(client, ctx, who, "buyers", as_of="2001-01-01T00:00:00Z")
        assert [x["item"]["version_id"] for x in early if x["item"]["id"] == str(items["a"])] == [
            frozen
        ], who


# --- item 3: lowering stays consistent ------------------------------------------------------


async def test_a_withdrawn_proposal_keeps_no_answer_text(client, fake):  # noqa: F811
    """Withdrawing a proposal strips the answer text out of its stored payload."""
    ctx, intake_id, _ = await world(client, fake, hidden=False, model=_blocker_gap)
    gap = await _answer_model_gap(client, ctx)
    await share_round5(client, ctx, intake_id, str(gap.id), "summary")
    [proposal] = await _baseline_proposals_round5(ctx)
    assert ANSWER in json.dumps(proposal.payload)
    await share_round5(client, ctx, intake_id, str(gap.id), "private")
    [proposal] = await _baseline_proposals_round5(ctx)
    assert proposal.status == "withdrawn"
    assert ANSWER not in json.dumps(proposal.payload)
    assert not re.search(r"\b1000\b", json.dumps(proposal.payload))  # not inside random ids


async def test_a_reanalysis_that_makes_a_finding_private_withdraws_its_proposal(client, fake):  # noqa: F811
    """A model-written gap whose finding is lost (as an intake from before S6) is
    registered private by the next analysis: its open proposal is withdrawn, scrubbed."""
    ctx, intake_id, _ = await world(client, fake, hidden=False, model=_blocker_gap)
    gap = await _answer_model_gap(client, ctx)
    await share_round5(client, ctx, intake_id, str(gap.id), "summary")
    [proposal] = await _baseline_proposals_round5(ctx)
    assert proposal.status == "open"
    async with tenant_session(ctx.tenant_id) as s:
        intake = await s.get(ProductIntake, uuid.UUID(intake_id))
        reg = {k: v for k, v in intake.analysis["findings"].items() if k != str(gap.id)}
        intake.analysis = {**intake.analysis, "findings": reg}
        await s.commit()
    resp = await client.post(f"/v1/intakes/{intake_id}/analyze", headers=ctx.as_("author"))
    assert resp.status_code == 200, resp.text
    [row] = [f for f in await findings(client, ctx, intake_id) if f["id"] == str(gap.id)]
    assert row["sharing"] == "private"
    [proposal] = await _baseline_proposals_round5(ctx)
    assert proposal.status == "withdrawn"
    assert ANSWER not in json.dumps(proposal.payload)


# --- item 4: accept vs withdraw ---------------------------------------------------------------


async def _open_proposal(client, ctx):
    ctx_, intake_id, _ = ctx
    gap = await _answer_model_gap(client, ctx_)
    await share_round5(client, ctx_, intake_id, str(gap.id), "summary")
    [proposal] = await _baseline_proposals_round5(ctx_)
    assert proposal.status == "open"
    return gap, proposal


async def _actions(ctx) -> list[str]:
    async with tenant_session(ctx.tenant_id) as s:
        rows = await s.scalars(select(AuditEvent.action).order_by(AuditEvent.created_at))
        return list(rows.all())


async def test_withdrawn_first_then_the_accept_is_refused(client, fake):  # noqa: F811
    """If a proposal is withdrawn first, a race to accept it afterward is refused."""
    world_ = await world(client, fake, hidden=False, model=_blocker_gap)
    ctx, intake_id, _ = world_
    gap, proposal = await _open_proposal(client, world_)
    async with tenant_session(ctx.tenant_id) as s1, tenant_session(ctx.tenant_id) as s2:
        intake = await s1.get(ProductIntake, uuid.UUID(intake_id))
        await intake_service.set_sharing(
            s1, _principal(ctx, "author"), intake, [(str(gap.id), "private")]
        )

        async def accept():
            return await baseline_service.decide_proposal(
                s2, proposal.id, _principal(ctx, "owner"), True, None
            )

        task = asyncio.create_task(accept())
        await asyncio.sleep(0.5)  # the accept now waits on the withdrawn row
        await s1.commit()
        with pytest.raises(baseline_service.NotFoundError):
            await task
        await s2.rollback()
    [row] = await _baseline_proposals_round5(ctx)
    assert row.status == "withdrawn"
    assert "baseline.proposal.withdrawn" in await _actions(ctx)
    assert "baseline.proposal.accepted" not in await _actions(ctx)


async def test_accepted_first_then_the_withdraw_leaves_it_accepted(client, fake):  # noqa: F811
    """If a proposal is accepted first, a later withdraw leaves it accepted, logged."""
    world_ = await world(client, fake, hidden=False, model=_blocker_gap)
    ctx, intake_id, _ = world_
    gap, proposal = await _open_proposal(client, world_)
    async with tenant_session(ctx.tenant_id) as s1, tenant_session(ctx.tenant_id) as s2:
        await baseline_service.decide_proposal(
            s1, proposal.id, _principal(ctx, "owner"), True, None
        )
        await s1.flush()

        async def lower():
            intake = await s2.get(ProductIntake, uuid.UUID(intake_id))
            await intake_service.set_sharing(
                s2, _principal(ctx, "author"), intake, [(str(gap.id), "private")]
            )
            await s2.commit()

        task = asyncio.create_task(lower())
        await asyncio.sleep(0.5)  # the withdraw now waits on the accepted row
        await s1.commit()
        await task
    [row] = await _baseline_proposals_round5(ctx)
    assert row.status == "accepted"
    actions = await _actions(ctx)
    assert "baseline.proposal.accepted" in actions
    assert "baseline.proposal.withdrawn" not in actions
    # The lowering itself is audited, and so is the withdraw that found it decided.
    assert actions.count("intake.finding_shared") >= 2
    assert "baseline.proposal.withdraw_skipped" in actions


# --- minors ---------------------------------------------------------------------------------


async def test_only_a_real_gaps_question_only_proposal_waits_for_the_answer(client, fake):  # noqa: F811
    """A proposal shaped like a question-only one but naming no gap of an intake cannot be
    made: since #618 only an intake sets attrs.gap_id, so no proposer can park an
    ordinary proposal behind an answer that will never come."""
    ctx, _, _ = await world(client, fake, hidden=False)
    async with tenant_session(ctx.tenant_id) as s:
        writer = baseline_service.Writer(_principal(ctx, "approver"), "agent", reason="probe")
        with pytest.raises(baseline_service.InvalidError, match="gap_id"):
            await baseline_service.propose(
                s, writer, op="create", kind="entity",
                fields={"type": "constraint", "key": "probe-constraint", "title": "Probe",
                        "body": "Probe", "attrs": {"gap_id": str(uuid.uuid4()),
                                                   "category": "blockers"}},
            )  # fmt: skip


async def test_a_run_quoting_its_users_shared_item_quotes_the_frozen_text(client, fake):  # noqa: F811
    """Baseline evidence a run attaches from its user's item a finding shared in full
    released copies the released version, never a newer one (nor a deleted item)."""
    from tests.baseline_helpers import entity

    ctx, intake_id, items = await world(client, fake, hidden=False, role="approver")
    await share_all(client, ctx, intake_id, "full")
    await _sync(ctx, items["a"], EDITED_A)
    feat = await entity(client, ctx, type="feature", key="saved-addresses")
    resp = await client.post(
        f"/v1/baseline/entities/{feat['id']}/evidence",
        json={"source_item_id": str(items["a"])}, headers=as_run_of(ctx, "author"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    assert resp.json()["excerpt"] == EXCERPT_A[:500]
    await _delete(ctx, items["a"])
    resp = await client.post(
        f"/v1/baseline/entities/{feat['id']}/evidence",
        json={"source_item_id": str(items["a"])}, headers=as_run_of(ctx, "author"),
    )  # fmt: skip
    assert resp.status_code == 404, resp.text


# -----------------------------------------------------------------------------
# Security review, round 8 (S6, owner decisions of 2026-10-19: freeze at sharing and
# titles).
#
# (1) An item a finding shared in full released and that was later deleted upstream is
#     never found by a run's ``/v1/search``, whatever ``as_of`` it asks for: an item ever
#     frozen is read only through the shared path, never as the run's user's own item;
# (2) an item's title freezes with its text: runs see the title as it was when shared on
#     every route, and baseline evidence attached from it carries that title.
#
# Synthetic placeholders only.


RENAMED = "#renamed-after-sharing"


async def _rename(ctx, item_id: uuid.UUID, *, content: str | None = None) -> None:
    """Rename the item upstream: alone (no new version), or with ``content`` (a new one)."""
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.get(SourceItem, item_id)
        source = await s.get(Source, item.source_id)
        current = await s.get(store.SourceItemVersion, item.current_version_id)
        event = ItemUpsert(
            external_id=item.external_id, kind=item.kind, title=RENAMED, url=item.url,
            author=None, content=content or current.content,
            source_updated_at=datetime.now(UTC),
        )  # fmt: skip
        await store.upsert_item(s, source, event)
        await s.commit()


# --- item 1: deleted shared items and as_of -------------------------------------------------


async def test_as_of_never_finds_a_shared_item_deleted_upstream(client, fake):  # noqa: F811
    """The reviewer's probe: shared in full (frozen at v1), edited upstream (v2), then
    deleted; a run searching with ``as_of`` between edit and delete finds nothing of it."""
    ctx, intake_id, items = await world(client, fake, hidden=False)
    await share_all(client, ctx, intake_id, "full")
    await _sync(ctx, items["a"], EDITED_A)
    between = datetime.now(UTC).isoformat()
    await _delete(ctx, items["a"])
    for who in RUNS:
        assert await _search(client, ctx, who, EDIT_WORD, as_of=between) == [], who
        for q in ("buyers", "address"):
            for as_of in (between, None):
                params = {"as_of": as_of} if as_of else {}
                hits = await _search(client, ctx, who, q, **params)
                assert str(items["a"]) not in {h["item"]["id"] for h in hits}, (who, q)


async def test_search_and_source_items_agree_for_runs(client, fake):  # noqa: F811
    """Whatever a run's search finds, at any ``as_of``, ``/v1/source-items/{id}`` reads at
    the same version; what it 404s, search never finds."""
    ctx, intake_id, items = await world(client, fake, hidden=False)
    await share_all(client, ctx, intake_id, "full")
    await _sync(ctx, items["a"], EDITED_A)
    between = datetime.now(UTC).isoformat()
    await _delete(ctx, items["b"])
    for who in RUNS:
        h = as_run_of(ctx, who)
        for params in ({}, {"as_of": between}, {"as_of": "2001-01-01T00:00:00Z"}):
            for q in ("buyers", "address", "finance", EDIT_WORD):
                for hit in await _search(client, ctx, who, q, **params):
                    resp = await client.get(f"/v1/source-items/{hit['item']['id']}", headers=h)
                    assert resp.status_code == 200, (who, q, params)
                    assert resp.json()["version_id"] == hit["item"]["version_id"], (who, q)
        for item_id in items.values():
            status = (await client.get(f"/v1/source-items/{item_id}", headers=h)).status_code
            if status == 404:
                for params in ({}, {"as_of": between}):
                    for q in ("buyers", "address", "finance"):
                        found = {
                            x["item"]["id"] for x in await _search(client, ctx, who, q, **params)
                        }
                        assert str(item_id) not in found, (who, item_id, q, params)


# --- item 2: titles freeze with the text ------------------------------------------------------


async def _run_titles(client, ctx, who: str, intake_id: str, item_id) -> dict[str, str | None]:
    """The title of ``item_id`` on every route ``who``'s run reads it through."""
    h = as_run_of(ctx, who)
    out: dict[str, str | None] = {}
    resp = await client.get(f"/v1/source-items/{item_id}", headers=h)
    assert resp.status_code == 200, resp.text
    out["source-item"] = resp.json()["title"]
    hits = {x["item"]["id"]: x for x in await _search(client, ctx, who, "buyers")}
    out["search"] = hits[str(item_id)]["item"]["title"]
    hits = {x["source_item_id"]: x for x in await evidence_hits(client, ctx, intake_id, who)}
    out["intake-evidence"] = hits[str(item_id)]["title"]
    if who == "author":
        source_id = resp.json()["source_id"]
        for deleted in ("false", "true"):
            resp = await client.get(
                f"/v1/sources/{source_id}/items", params={"include_deleted": deleted}, headers=h
            )
            assert resp.status_code == 200, resp.text
            listed = {x["id"]: x for x in resp.json()}
            out[f"source-list-{deleted}"] = listed[str(item_id)]["title"]
        resp = await client.post("/v1/snapshots", json={"label": "probe"}, headers=h)
        assert resp.status_code == 201, resp.text
        resp = await client.get(f"/v1/snapshots/{resp.json()['id']}/items", headers=h)
        assert resp.status_code == 200, resp.text
        out["snapshot"] = {x["id"]: x for x in resp.json()}[str(item_id)]["title"]
    return out


async def test_a_run_sees_the_title_as_shared_after_an_upstream_rename(client, fake):  # noqa: F811
    """A run sees a source's renamed title once it is shared again after the rename."""
    ctx, intake_id, items = await world(client, fake, hidden=False)
    await share_all(client, ctx, intake_id, "full")
    await _rename(ctx, items["a"], content=EDITED_A)
    for who in RUNS:
        titles = await _run_titles(client, ctx, who, intake_id, items["a"])
        assert set(titles.values()) == {TITLE_A}, (who, titles)


async def test_a_run_never_lists_deleted_items(client, fake):  # noqa: F811
    """``include_deleted`` is ignored for runs, on every list."""
    ctx, intake_id, items = await world(client, fake, hidden=False)
    await share_all(client, ctx, intake_id, "full")
    h = as_run_of(ctx, "author")
    source_id = (await client.get(f"/v1/source-items/{items['a']}", headers=h)).json()["source_id"]
    await _delete(ctx, items["a"])
    resp = await client.get(
        f"/v1/sources/{source_id}/items", params={"include_deleted": "true"}, headers=h
    )
    assert resp.status_code == 200, resp.text
    assert str(items["a"]) not in {x["id"] for x in resp.json()}
    # The author, as themselves, still lists it.
    resp = await client.get(
        f"/v1/sources/{source_id}/items", params={"include_deleted": "true"},
        headers=ctx.as_("author"),
    )  # fmt: skip
    assert str(items["a"]) in {x["id"] for x in resp.json()}


async def test_a_snapshot_a_run_opens_serves_shared_items_frozen(client, fake):  # noqa: F811
    """A snapshot taken after the edit: the run still reads the shared item at the
    version (and title) released, and never an item deleted since."""
    ctx, intake_id, items = await world(client, fake, hidden=False)
    await share_all(client, ctx, intake_id, "full")
    h = as_run_of(ctx, "author")
    frozen = (await client.get(f"/v1/source-items/{items['a']}", headers=h)).json()["version_id"]
    await _rename(ctx, items["a"], content=EDITED_A)
    resp = await client.post("/v1/snapshots", json={"label": "after"}, headers=h)
    snapshot = resp.json()["id"]
    await _delete(ctx, items["b"])
    listed = {
        x["id"]: x for x in (await client.get(f"/v1/snapshots/{snapshot}/items", headers=h)).json()
    }
    assert listed[str(items["a"])]["version_id"] == frozen
    assert listed[str(items["a"])]["title"] == TITLE_A
    assert str(items["b"]) not in listed


async def test_attach_without_ref_stores_the_frozen_title(client, fake):  # noqa: F811
    """Evidence from a renamed item keeps the title it had when first shared."""
    from tests.baseline_helpers import entity

    ctx, intake_id, items = await world(client, fake, hidden=False, role="approver")
    await share_all(client, ctx, intake_id, "full")
    feat = await entity(client, ctx, type="feature", key="saved-addresses")
    url = f"/v1/baseline/entities/{feat['id']}/evidence"
    # A rename alone writes no version: the item row's title changes all the same.
    await _rename(ctx, items["a"])
    resp = await client.post(
        url, json={"source_item_id": str(items["a"])}, headers=as_run_of(ctx, "author")
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["ref"] == TITLE_A
    # A rename with an edit: still the title as shared.
    await _rename(ctx, items["a"], content=EDITED_A)
    resp = await client.post(
        url, json={"source_item_id": str(items["a"])}, headers=as_run_of(ctx, "author")
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["ref"] == TITLE_A
    assert resp.json()["excerpt"] == EXCERPT_A[:500]
    # Whoever reads the evidence, the author's run included, sees the title as shared.
    for headers in (as_run_of(ctx, "author"), ctx.as_("author"), ctx.as_("approver")):
        resp = await client.get(f"/v1/baseline/entities/{feat['id']}", headers=headers)
        assert resp.status_code == 200, resp.text
        assert RENAMED not in resp.text
        assert [e["ref"] for e in resp.json()["evidence"]] == [TITLE_A, TITLE_A]
    shown = await client.get(f"/v1/baseline/entities/{feat['id']}", headers=ctx.as_("author"))
    assert {e["source_item"]["title"] for e in shown.json()["evidence"]} == {TITLE_A}


# --- minors ------------------------------------------------------------------------------------


async def test_a_findings_ids_list_only_what_others_may_read(client, fake):  # noqa: F811
    """Anyone but the author is shown the ids of the items a finding released and that
    are still readable: not one deleted upstream since."""
    ctx, intake_id, items = await world(client, fake, hidden=False)
    await share_all(client, ctx, intake_id, "full")
    await _delete(ctx, items["a"])
    for who, headers in (("approver", ctx.as_("approver")), ("run", as_run_of(ctx, "author"))):
        resp = await client.get(f"/v1/intakes/{intake_id}/findings", headers=headers)
        assert resp.status_code == 200, resp.text
        ids = {i for f in resp.json() for i in f["source_item_ids"]}
        assert ids, who
        assert str(items["a"]) not in ids, who
    resp = await client.get(f"/v1/intakes/{intake_id}/findings", headers=ctx.as_("author"))
    assert str(items["a"]) in {i for f in resp.json() for i in f["source_item_ids"]}


async def test_another_users_released_item_reads_without_who_is_on_it(client, fake):  # noqa: F811
    """A shared item hides its author and participants from everyone but the author."""
    ctx, intake_id, items = await world(client, fake, hidden=False)
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.get(SourceItem, items["a"])
        item.author = "U-author"
        item.acl = {"visibility": "private", "participants": ["Ada", "Grace"]}
        await s.commit()
    await share_all(client, ctx, intake_id, "full")
    h = as_run_of(ctx, "approver")
    resp = await client.get(f"/v1/source-items/{items['a']}", headers=h)
    assert resp.status_code == 200, resp.text
    hits = {x["item"]["id"]: x["item"] for x in await _search(client, ctx, "approver", "buyers")}
    for out in (resp.json(), hits[str(items["a"])]):
        assert out["author"] is None
        assert out["source_updated_at"] is None
        assert out["acl"] == {"visibility": "private"}
    # The author's own run reads its own frozen item as at release too (round 10); the
    # author reads it as it is.
    resp = await client.get(f"/v1/source-items/{items['a']}", headers=as_run_of(ctx, "author"))
    assert resp.json()["acl"] == {"visibility": "private"}
    assert resp.json()["source_updated_at"] is None
    resp = await client.get(f"/v1/source-items/{items['a']}", headers=ctx.as_("author"))
    assert resp.json()["acl"]["participants"] == ["Ada", "Grace"]


async def test_a_release_naming_another_items_version_serves_nothing(client, fake):  # noqa: F811
    """A release pointing at another item's version is served to no one."""
    from oracle.intake.models import IntakeSharedItem

    ctx, intake_id, items = await world(client, fake, hidden=False)
    await share_all(client, ctx, intake_id, "full")
    async with tenant_session(ctx.tenant_id) as s:
        b = await s.get(SourceItem, items["b"])
        rows = (
            await s.scalars(select(IntakeSharedItem).where(IntakeSharedItem.item_id == items["a"]))
        ).all()
        assert rows
        for row in rows:
            row.version_id = b.current_version_id
        await s.commit()
    h = as_run_of(ctx, "approver")
    assert (await client.get(f"/v1/source-items/{items['a']}", headers=h)).status_code == 404
    hits = await _search(client, ctx, "approver", "buyers")
    assert str(items["a"]) not in {x["item"]["id"] for x in hits}


async def test_a_reanalysis_never_raises_an_open_proposal(client, fake):  # noqa: F811
    """``propose_shared(create=False)`` only lowers: a question-only proposal stays
    question-only even if the finding reads higher by then."""
    from oracle.intake import answers

    ctx, intake_id, _ = await world(client, fake, hidden=False, model=_blocker_gap)
    gap = await _answer_model_gap(client, ctx)
    await share_round5(client, ctx, intake_id, str(gap.id), "counts")
    [proposal] = await _baseline_proposals_round5(ctx)
    assert proposal.status == "open"
    assert ANSWER not in json.dumps(proposal.payload)
    async with tenant_session(ctx.tenant_id) as s:
        intake = await s.get(ProductIntake, uuid.UUID(intake_id))
        analysis = copy.deepcopy(intake.analysis)
        analysis["findings"][str(gap.id)]["sharing"] = "full"
        intake.analysis = analysis
        await s.flush()
        await answers.propose_shared(s, None, intake, [gap], create=False)
        await s.commit()
    [proposal] = await _baseline_proposals_round5(ctx)
    assert ANSWER not in json.dumps(proposal.payload)


# -----------------------------------------------------------------------------
# Security review, round 9 (S6, owner decision of 2026-10-20: links).
#
# (1) An item's link freezes with its title and text when shared: a Notion link carries
#     the page title, so a rename upstream must never reach anyone through the link.
#     The link is stored on the version (like the title) and served from the version
#     released wherever that version is served: ``item_out`` (search, the source-item
#     route, source and snapshot lists), intake evidence refs, and baseline evidence.
#
# Minors: a run never reads a frozen item it may no longer read through ``attach``;
# another user's item is scored by the version released, not by when it changed
# upstream; another user's item carries no current scalar acl field; a run never cites
# its own deleted or unreleased item in an answer; a run's source list pages are full
# (what it may not read is left out before LIMIT/OFFSET).
#
# Synthetic placeholders only.


PAGE_ID = "1f2e3d4c-5b6a-4987-8a1b-2c3d4e5f6a7b"
PAGE_HEX = PAGE_ID.replace("-", "")
OLD_LINK = f"https://www.notion.so/Saved-addresses-{PAGE_HEX}"
NEW_SLUG = "Acquisition-of-Example-Corp"
NEW_LINK = f"https://www.notion.so/{NEW_SLUG}-{PAGE_HEX}"
NEW_TITLE = "Acquisition of Example Corp"


async def _as_notion_page(ctx, item_id: uuid.UUID) -> None:
    """Make ``item_id`` a Notion page whose link carries its (shared) title."""
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.get(SourceItem, item_id)
        source = await s.get(Source, item.source_id)
        source.kind = "notion"
        item.external_id = PAGE_ID
        item.url = OLD_LINK
        version = await s.get(SourceItemVersion, item.current_version_id)
        version.url = OLD_LINK
        await s.commit()


async def _rename_page(ctx, item_id: uuid.UUID, *, content: str | None = None) -> None:
    """Rename the page upstream (its slug changes): alone, or with an edit."""
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.get(SourceItem, item_id)
        source = await s.get(Source, item.source_id)
        current = await s.get(SourceItemVersion, item.current_version_id)
        event = ItemUpsert(
            external_id=item.external_id, kind=item.kind, title=NEW_TITLE, url=NEW_LINK,
            author=None, content=content or current.content,
            source_updated_at=datetime.now(UTC),
        )  # fmt: skip
        await store.upsert_item(s, source, event)
        await s.commit()


async def _run_links(client, ctx, who: str, intake_id: str, item_id) -> dict[str, str | None]:
    """The link of ``item_id`` on every route ``who``'s run reads it through."""
    h = as_run_of(ctx, who)
    out: dict[str, str | None] = {}
    resp = await client.get(f"/v1/source-items/{item_id}", headers=h)
    assert resp.status_code == 200, resp.text
    assert resp.json()["title"] == TITLE_A
    out["source-item"] = resp.json()["url"]
    hits = {x["item"]["id"]: x for x in await _search(client, ctx, who, "buyers")}
    out["search"] = hits[str(item_id)]["item"]["url"]
    hits = {x["source_item_id"]: x for x in await evidence_hits(client, ctx, intake_id, who)}
    out["intake-evidence"] = hits[str(item_id)]["url"]
    if who == "author":
        source_id = resp.json()["source_id"]
        resp = await client.get(f"/v1/sources/{source_id}/items", headers=h)
        assert resp.status_code == 200, resp.text
        out["source-list"] = {x["id"]: x for x in resp.json()}[str(item_id)]["url"]
        resp = await client.post("/v1/snapshots", json={"label": "probe"}, headers=h)
        assert resp.status_code == 201, resp.text
        resp = await client.get(f"/v1/snapshots/{resp.json()['id']}/items", headers=h)
        out["snapshot"] = {x["id"]: x for x in resp.json()}[str(item_id)]["url"]
    return out


# --- item 1: links freeze with the title and text ------------------------------------------


async def test_a_run_sees_the_link_as_shared_after_an_upstream_rename(client, fake):  # noqa: F811
    """The reviewer's probe: a shared Notion page renamed upstream (alone, then with an
    edit); every route a run reads it through gives the link as shared, never the new."""
    ctx, intake_id, items = await world(client, fake, hidden=False)
    await _as_notion_page(ctx, items["a"])
    await share_all(client, ctx, intake_id, "full")
    for content in (None, EDITED_A):
        await _rename_page(ctx, items["a"], content=content)
        for who in RUNS:
            links = await _run_links(client, ctx, who, intake_id, items["a"])
            assert set(links.values()) == {OLD_LINK}, (who, content, links)


async def test_people_never_see_the_renamed_link_of_a_shared_item(client, fake):  # noqa: F811
    """The intake summary, question batch and evidence route others read: the link as
    shared (refs of a finding shared in full), never the slug of the new title."""
    ctx, intake_id, items = await world(client, fake, hidden=False)
    await _as_notion_page(ctx, items["a"])
    await share_all(client, ctx, intake_id, "full")
    await _rename_page(ctx, items["a"], content=EDITED_A)
    h = ctx.as_("approver")
    seen = ""
    for path in ("summary", "question-batch", "findings"):
        resp = await client.get(f"/v1/intakes/{intake_id}/{path}", headers=h)
        assert resp.status_code in (200, 404), resp.text
        assert NEW_SLUG not in resp.text, path
        seen += resp.text
    assert OLD_LINK in seen


async def test_attach_stores_the_link_as_shared(client, fake):  # noqa: F811
    """Evidence for a linked page keeps the link it had when first shared."""
    from tests.baseline_helpers import entity

    ctx, intake_id, items = await world(client, fake, hidden=False, role="approver")
    await _as_notion_page(ctx, items["a"])
    await share_all(client, ctx, intake_id, "full")
    feat = await entity(client, ctx, type="feature", key="saved-addresses")
    url = f"/v1/baseline/entities/{feat['id']}/evidence"
    for content in (None, EDITED_A):
        await _rename_page(ctx, items["a"], content=content)
        resp = await client.post(
            url, json={"source_item_id": str(items["a"])}, headers=as_run_of(ctx, "author")
        )
        assert resp.status_code == 201, resp.text
        assert resp.json()["url"] == OLD_LINK, content
    for headers in (as_run_of(ctx, "author"), ctx.as_("approver")):
        resp = await client.get(f"/v1/baseline/entities/{feat['id']}", headers=headers)
        assert resp.status_code == 200, resp.text
        assert NEW_SLUG not in resp.text
        assert [e["url"] for e in resp.json()["evidence"]] == [OLD_LINK, OLD_LINK]
    # The run reading the evidence sees its item at the version released, link included.
    resp = await client.get(f"/v1/baseline/entities/{feat['id']}", headers=as_run_of(ctx, "author"))
    assert {e["source_item"]["url"] for e in resp.json()["evidence"]} == {OLD_LINK}


async def test_a_version_keeps_the_link_it_was_written_with(client):
    """``upsert_item`` copies the link onto the version it writes; a rename alone writes
    no version, so the version keeps the link it had."""
    from tests.baseline_helpers import make_item
    from tests.intake_helpers import company

    pass

    ctx = await company()
    await add_author(ctx)
    item_id = await make_item(ctx, "author", kind="notion", url=OLD_LINK)
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.get(SourceItem, item_id)
        source = await s.get(Source, item.source_id)
        event = ItemUpsert(
            external_id=item.external_id, kind=item.kind, title="v2", url=OLD_LINK,
            author=None, content="A new version.", source_updated_at=datetime.now(UTC),
        )  # fmt: skip
        _, written = await store.upsert_item(s, source, event)
        assert written
        version_id = item.current_version_id
        await s.commit()
    await _rename_page(ctx, item_id)
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.get(SourceItem, item_id)
        assert item.current_version_id == version_id
        assert item.url == NEW_LINK
        assert (await s.get(SourceItemVersion, version_id)).url == OLD_LINK


# --- minors ------------------------------------------------------------------------------------


async def test_attach_refuses_a_frozen_item_no_longer_released(client, fake):  # noqa: F811
    """An item a share froze whose release reads nothing now (here: the release names
    another item's version) is missing to the run's attach, like ``get_source_item``;
    it never falls back to the current version."""
    from sqlalchemy import select

    from oracle.intake.models import IntakeSharedItem
    from tests.baseline_helpers import entity

    ctx, intake_id, items = await world(client, fake, hidden=False, role="approver")
    await share_all(client, ctx, intake_id, "full")
    async with tenant_session(ctx.tenant_id) as s:
        b = await s.get(SourceItem, items["b"])
        for row in await s.scalars(
            select(IntakeSharedItem).where(IntakeSharedItem.item_id == items["a"])
        ):
            row.version_id = b.current_version_id
        await s.commit()
    h = as_run_of(ctx, "author")
    assert (await client.get(f"/v1/source-items/{items['a']}", headers=h)).status_code == 404
    feat = await entity(client, ctx, type="feature", key="saved-addresses")
    resp = await client.post(
        f"/v1/baseline/entities/{feat['id']}/evidence",
        json={"source_item_id": str(items["a"])},
        headers=h,
    )
    assert resp.status_code == 404, resp.text


async def test_another_users_item_scores_by_the_version_released(client, fake):  # noqa: F811
    """Freshness of another user's released item comes from the version released, not
    from when it changed upstream since (which would leak that it changed)."""
    ctx, intake_id, items = await world(client, fake, hidden=False)
    await share_all(client, ctx, intake_id, "full")
    h = as_run_of(ctx, "approver")
    before = (await client.get(f"/v1/source-items/{items['a']}", headers=h)).json()
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.get(SourceItem, items["a"])
        item.source_updated_at = datetime(2001, 1, 1, tzinfo=UTC)
        item.occurred_at = datetime(2001, 1, 1, tzinfo=UTC)
        await s.commit()
    after = (await client.get(f"/v1/source-items/{items['a']}", headers=h)).json()
    assert after["confidence"] == before["confidence"]


async def test_another_users_item_carries_no_current_acl_field(client, fake):  # noqa: F811
    """Channel or repository names and sharing flags are current, not frozen: another
    user's released item carries none of them."""
    ctx, intake_id, items = await world(client, fake, hidden=False)
    await share_all(client, ctx, intake_id, "full")
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.get(SourceItem, items["a"])
        item.acl = {"visibility": "private", "channel_name": "#acquisition-example-corp",
                    "repo": "example/acquisition", "shared": True}  # fmt: skip
        await s.commit()
    h = as_run_of(ctx, "approver")
    resp = await client.get(f"/v1/source-items/{items['a']}", headers=h)
    hits = {x["item"]["id"]: x["item"] for x in await _search(client, ctx, "approver", "buyers")}
    for out in (resp.json(), hits[str(items["a"])]):
        assert "acquisition" not in str(out["acl"])
        assert "shared" not in out["acl"]


async def _answer_as_run(client, ctx, evidence: list[uuid.UUID]):
    from sqlalchemy import select

    from oracle.v2.models import KnowledgeGap, StakeholderQuestion

    pass

    async with tenant_session(ctx.tenant_id) as s:
        gap = await s.scalar(select(KnowledgeGap).where(KnowledgeGap.statement == MODEL_GAP))
        q = await s.scalar(select(StakeholderQuestion).where(StakeholderQuestion.gap_id == gap.id))
    return await client.post(
        f"/v1/questions/{q.id}/answers",
        json={
            "kind": "answer",
            "body": "Buyers retype it.",
            "evidence_ids": [str(i) for i in evidence],
        },
        headers=as_run_of(ctx, "author"),
    )


async def test_a_run_never_cites_its_deleted_or_unreleased_items(client, fake):  # noqa: F811
    """A run answering a question cites only what it may read: not its own item
    deleted upstream, nor one a share froze whose release reads nothing now."""
    from sqlalchemy import select

    from oracle.intake.models import IntakeSharedItem

    pass
    pass

    ctx, intake_id, items = await world(client, fake, hidden=False, model=_blocker_gap)
    await share_all(client, ctx, intake_id, "full")
    async with tenant_session(ctx.tenant_id) as s:
        b = await s.get(SourceItem, items["b"])
        for row in await s.scalars(
            select(IntakeSharedItem).where(IntakeSharedItem.item_id == items["a"])
        ):
            row.version_id = b.current_version_id
        await s.commit()
    await _delete(ctx, items["old"])
    for item in ("a", "old"):
        resp = await _answer_as_run(client, ctx, [items[item]])
        assert resp.status_code == 422, (item, resp.text)


async def test_a_runs_source_list_pages_are_full(client, fake):  # noqa: F811
    """Items a run may not read are left out before paging: a page of one is never
    empty while a readable item follows."""
    from sqlalchemy import select

    from oracle.intake.models import IntakeSharedItem

    pass

    ctx, intake_id, items = await world(client, fake, hidden=False)
    await share_all(client, ctx, intake_id, "full")
    fresh = await _sync(ctx, items["a"], "A new thread on returning buyers.", new=True)
    async with tenant_session(ctx.tenant_id) as s:
        b = await s.get(SourceItem, items["b"])
        for row in await s.scalars(
            select(IntakeSharedItem).where(IntakeSharedItem.item_id == items["a"])
        ):
            row.version_id = b.current_version_id
        a = await s.get(SourceItem, items["a"])
        a.source_updated_at = datetime(2100, 1, 1, tzinfo=UTC)
        source_id = a.source_id
        await s.commit()
    h = as_run_of(ctx, "author")
    resp = await client.get(f"/v1/sources/{source_id}/items", params={"limit": 1}, headers=h)
    assert resp.status_code == 200, resp.text
    assert [x["id"] for x in resp.json()] == [str(fresh)]


# -----------------------------------------------------------------------------
# Security review, round 10 (S6: freeze at sharing, titles and links; after the merge
# of main's evidence inspector and blockers).
#
# M1. The evidence inspector (``GET /v1/documents/{doc}/versions/{n}/evidence``, also an
#     MCP tool) read a linked source item's *current* title and link for its owner's
#     runs: a run now gets a withheld, deleted or frozen-but-unreleased item restricted
#     and a released one at the title and link released; a run links none of the three
#     (``create_section_links``). The blockers appendix never falls back to an item's
#     current link.
#
# Minors: (1) a run reads its user's own frozen items as at release (acl, upstream time,
# confidence); (2) a run's own deleted item is missing from baseline evidence; (3) a
# run's YAML import never links its deleted or frozen-but-unreleased items; (4, 5) the
# link backfill repairs versions an old image wrote, writing only rows it gives a link;
# (6) another user's hidden item never scores by when the item changed upstream (baseline
# evidence: people read it live, runs as of their pin, owner 2026-10-20); (7) owners see
# their item's current title and link.
#
# Synthetic placeholders only.


SECTION = "problem"


async def _link(client, ctx, slug: str, item_id, headers) -> int:
    resp = await client.post(
        f"/v1/documents/{slug}/versions/1/section-links",
        json={
            "links": [{"section_key": SECTION, "kind": "evidences", "source_item_id": str(item_id)}]
        },
        headers=headers,
    )
    return resp.status_code


async def _inspected(client, slug: str, headers) -> dict[str, dict]:
    """Source item id -> the inspector's target for it, as ``headers`` reads it."""
    resp = await client.get(f"/v1/documents/{slug}/versions/1/evidence", headers=headers)
    assert resp.status_code == 200, resp.text
    return {
        lk["target"]["id"]: lk["target"]
        for section in resp.json()["sections"]
        for lk in section["links"]
        if lk["target"]["type"] == "source_item"
    }


async def _unrelease(ctx, item_id) -> None:
    """The release of ``item_id`` names another item's version: it reads nothing now."""
    async with tenant_session(ctx.tenant_id) as s:
        other = await s.scalar(
            select(SourceItem.current_version_id).where(SourceItem.id != item_id).limit(1)
        )
        for row in await s.scalars(
            select(IntakeSharedItem).where(IntakeSharedItem.item_id == item_id)
        ):
            row.version_id = other
        await s.commit()


# --- M1: the evidence inspector -----------------------------------------------------------


async def test_the_inspector_restricts_what_the_authors_run_may_not_read(client, fake):  # noqa: F811
    """(a) A withheld item (its intake's findings are private), a deleted one and a
    frozen one with no release readable now: restricted to the author's run, no title
    or link; the author still sees their own items."""
    ctx, intake_id, items = await world(client, fake, hidden=False, role="approver")
    slug = await _document(client, ctx)
    for key in ("a", "b", "old"):
        assert await _link(client, ctx, slug, items[key], ctx.as_("author")) == 201
    run = as_run_of(ctx, "author")
    # Withheld: every finding is private, so the intake withholds what it read.
    seen = await _inspected(client, slug, run)
    for key in ("a", "b", "old"):
        target = seen[str(items[key])]
        assert target["restricted"] and target["title"] is None and target["url"] is None
    assert TITLE_A not in str(seen)
    # Shared in full: released; then a's release reads nothing and old is deleted.
    await share_all(client, ctx, intake_id, "full")
    assert not (await _inspected(client, slug, run))[str(items["a"])]["restricted"]
    await _unrelease(ctx, items["a"])
    await _delete(ctx, items["old"])
    seen = await _inspected(client, slug, run)
    for key in ("a", "old"):
        target = seen[str(items[key])]
        assert target["restricted"] and target["title"] is None and target["url"] is None, key
    assert seen[str(items["b"])]["title"] == "#finance numbers"
    mine = await _inspected(client, slug, ctx.as_("author"))
    assert mine[str(items["a"])]["title"] == TITLE_A


async def test_the_inspector_shows_a_shared_item_as_shared(client, fake):  # noqa: F811
    """(b) A shared Notion page renamed upstream (alone, then with an edit): runs read
    the title and link released; only the owner sees the new ones (minor 7)."""
    pass

    ctx, intake_id, items = await world(client, fake, hidden=False, role="approver")
    slug = await _document(client, ctx)
    await _as_notion_page(ctx, items["a"])
    await share_all(client, ctx, intake_id, "full")
    assert await _link(client, ctx, slug, items["a"], ctx.as_("author")) == 201
    for content in (None, EDITED_A):
        await _rename_page(ctx, items["a"], content=content)
        for who in ("author", "approver"):
            resp = await client.get(
                f"/v1/documents/{slug}/versions/1/evidence", headers=as_run_of(ctx, who)
            )
            assert NEW_SLUG not in resp.text and NEW_TITLE not in resp.text, (who, content)
            target = (await _inspected(client, slug, as_run_of(ctx, who)))[str(items["a"])]
            if who == "author":
                assert (target["title"], target["url"]) == (TITLE_A, OLD_LINK), content
        owner = (await _inspected(client, slug, ctx.as_("author")))[str(items["a"])]
        assert (owner["title"], owner["url"]) == (NEW_TITLE, NEW_LINK)
        # Other people never read another user's item here (AUD-9).
        other = (await _inspected(client, slug, ctx.as_("approver")))[str(items["a"])]
        assert other["restricted"] and other["url"] is None


async def test_a_run_never_links_an_item_it_may_not_read(client, fake):  # noqa: F811
    """(c) The author's run links neither a withheld item, nor a deleted one, nor a
    frozen one with no release; the author may, and so may the run once released."""
    ctx, intake_id, items = await world(client, fake, hidden=False, role="approver")
    slug = await _document(client, ctx)
    run = as_run_of(ctx, "author")
    assert await _link(client, ctx, slug, items["a"], run) == 422  # withheld
    await share_all(client, ctx, intake_id, "full")
    assert await _link(client, ctx, slug, items["b"], run) == 201  # released
    await _unrelease(ctx, items["a"])
    assert await _link(client, ctx, slug, items["a"], run) == 422  # frozen, no release
    fresh = await make_item(ctx, "author", content="Unrelated note.", title="#notes")
    await _delete(ctx, fresh)
    assert await _link(client, ctx, slug, fresh, run) == 422  # deleted
    assert await _link(client, ctx, slug, items["a"], ctx.as_("author")) == 201


async def test_the_blockers_appendix_never_serves_an_items_current_link(client):
    """Evidence stored with a ref only renders its ref, and with neither link nor ref
    nothing, never the item's link as it is now (a Notion link carries the page's
    current title)."""
    from oracle.blockers.views import _evidence_refs
    from tests.intake_helpers import company

    pass

    ctx = await company()
    await add_author(ctx, "approver")
    item_id = await make_item(ctx, "author", kind="notion", url=NEW_LINK)
    feat = await entity(client, ctx, type="feature", key="saved-addresses")
    async with tenant_session(ctx.tenant_id) as s:
        with_ref, bare = (
            Evidence(entity_id=uuid.UUID(feat["id"]), source_item_id=item_id, ref=ref)
            for ref in ("Saved addresses", None)
        )
        bare.excerpt = "Buyers keep two addresses."
        s.add_all([with_ref, bare])
        await s.commit()
        refs = await _evidence_refs(s, {with_ref.id, bare.id})
    assert refs[with_ref.id].ref == "Saved addresses"
    assert refs[bare.id].ref is None
    assert NEW_SLUG not in str(refs)


# --- minors ---------------------------------------------------------------------------------


async def test_a_runs_own_frozen_item_reads_as_at_release(client, fake):  # noqa: F811
    """(1) The author's run reads its own frozen item like another user's released one:
    acl reduced to its scalar flags, no upstream time, confidence from the version
    released, on the source-item route, search, the source list and a snapshot."""
    ctx, intake_id, items = await world(client, fake, hidden=False)
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.get(SourceItem, items["a"])
        item.acl = {"visibility": "private", "participants": ["Ada"], "channel_name": "#x"}
        await s.commit()
    await share_all(client, ctx, intake_id, "full")
    run = as_run_of(ctx, "author")

    async def reads() -> list[dict]:
        one = (await client.get(f"/v1/source-items/{items['a']}", headers=run)).json()
        hits = {x["item"]["id"]: x["item"] for x in await _search(client, ctx, "author", "buyers")}
        listed = await client.get(f"/v1/sources/{one['source_id']}/items", headers=run)
        snap = await client.post("/v1/snapshots", json={"label": "probe"}, headers=run)
        pinned = await client.get(f"/v1/snapshots/{snap.json()['id']}/items", headers=run)
        by_id = lambda r: {x["id"]: x for x in r.json()}[str(items["a"])]  # noqa: E731
        return [one, hits[str(items["a"])], by_id(listed), by_id(pinned)]

    before = await reads()
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.get(SourceItem, items["a"])
        item.source_updated_at = datetime(2001, 1, 1, tzinfo=UTC)
        item.occurred_at = datetime(2001, 1, 1, tzinfo=UTC)
        await s.commit()
    for out, earlier in zip(await reads(), before, strict=True):
        assert out["acl"] == {"visibility": "private"}
        assert out["source_updated_at"] is None
        assert out["confidence"] == earlier["confidence"]
    # The author reads it as it is.
    own = (await client.get(f"/v1/source-items/{items['a']}", headers=ctx.as_("author"))).json()
    assert own["acl"]["participants"] == ["Ada"]


async def test_a_runs_own_deleted_item_is_missing_from_evidence(client, fake):  # noqa: F811
    """(2) Baseline evidence from the author's item never frozen: once deleted upstream,
    the author's run gets no item ref (no last link), as for an item it may not read."""
    ctx, _, _ = await world(client, fake, hidden=False, role="approver")
    item_id = await make_item(ctx, "author", content="Buyers keep two addresses.")
    feat = await entity(client, ctx, type="feature", key="saved-addresses")
    url = f"/v1/baseline/entities/{feat['id']}/evidence"
    resp = await client.post(url, json={"source_item_id": str(item_id)}, headers=ctx.as_("author"))
    assert resp.status_code == 201, resp.text
    run = as_run_of(ctx, "author")
    [before] = (await client.get(f"/v1/baseline/entities/{feat['id']}", headers=run)).json()[
        "evidence"
    ]
    assert before["source_item"]["id"] == str(item_id)
    await _delete(ctx, item_id)
    [after] = (await client.get(f"/v1/baseline/entities/{feat['id']}", headers=run)).json()[
        "evidence"
    ]
    assert after["source_item"] is None and after["source_item_private"]
    # The author still sees their own item.
    [own] = (
        await client.get(f"/v1/baseline/entities/{feat['id']}", headers=ctx.as_("author"))
    ).json()["evidence"]
    assert own["source_item"]["id"] == str(item_id)


async def test_a_runs_yaml_import_never_links_what_it_may_not_read(client, fake):  # noqa: F811
    """(3) A run's YAML import links evidence to its user's items only where the run may
    read them: never one deleted upstream or frozen with no release readable now."""
    ctx, intake_id, items = await world(client, fake, hidden=False, role="approver")
    await share_all(client, ctx, intake_id, "full")
    await _unrelease(ctx, items["a"])
    fresh = await make_item(ctx, "author", content="Unrelated note.", title="#notes")
    await _delete(ctx, fresh)
    body = (
        "version: 1\nentities:\n"
        "  - type: feature\n    key: saved-addresses\n    title: Saved addresses\n"
        "    evidence:\n"
        f"      - ref: frozen\n        source_item: {items['a']}\n"
        f"      - ref: deleted\n        source_item: {fresh}\n"
        f"      - ref: released\n        source_item: {items['b']}\n"
    )
    resp = await client.post(
        "/v1/baseline/yaml",
        content=body.encode(),
        headers={**as_run_of(ctx, "author"), "Content-Type": "application/yaml"},
    )
    assert resp.status_code == 200, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        linked = dict((await s.execute(select(Evidence.ref, Evidence.source_item_id))).all())
    assert linked == {"frozen": None, "deleted": None, "released": items["b"]}


async def test_the_link_repair_fills_old_image_versions_only_where_it_has_a_link(client):
    """(4, 5) Versions an old image wrote without a link get the one 0014_intake gives,
    built from the item's id only (a Notion page's id-only link, a Fireflies transcript
    and a GitHub issue by id, never their current links, which carry a title or
    repository name that may have changed since); a version whose link would stay NULL
    is not written; a second run changes nothing."""
    from oracle.sources.repair import repair_version_urls
    from tests.intake_helpers import company

    pass
    pass

    ctx = await company()
    await add_author(ctx)
    page = await make_item(ctx, "author", kind="notion", url=NEW_LINK)
    chat = await make_item(ctx, "author")
    upload = await make_item(ctx, "author", kind="upload", url=None)
    meeting = await make_item(
        ctx, "author", kind="fireflies", item_kind="transcript",
        url="https://app.fireflies.ai/view/Acquisition-of-Example-Corp::01TRANSCRIPT9",
    )  # fmt: skip
    issue = await make_item(
        ctx, "author", kind="github", item_kind="issue",
        url="https://github.com/example/acquisition-of-example-corp/issues/42",
    )  # fmt: skip
    async with tenant_session(ctx.tenant_id) as s:
        (await s.get(SourceItem, page)).external_id = PAGE_ID
        (await s.get(SourceItem, meeting)).external_id = "01TRANSCRIPT9"
        (await s.get(SourceItem, issue)).external_id = "example/checkout:issue:42"
        for item_id in (page, chat, upload, meeting, issue):
            item = await s.get(SourceItem, item_id)
            (await s.get(SourceItemVersion, item.current_version_id)).url = None
        await s.commit()

    async def state() -> dict:
        async with tenant_session(ctx.tenant_id) as s:
            rows = await s.execute(
                text(
                    "SELECT v.item_id, v.url, v.xmin::text FROM source_item_versions v "
                    "WHERE v.item_id IN (:a, :b, :c, :d, :e)"
                ).bindparams(a=page, b=chat, c=upload, d=meeting, e=issue)
            )
            return {i: (url, xmin) for i, url, xmin in rows.all()}

    before = await state()
    assert await repair_version_urls() == 4
    after = await state()
    assert after[page][0] == f"https://www.notion.so/{PAGE_HEX}"
    assert after[chat][0] == "https://chat.example.com/archives/C1/p1"
    assert after[meeting][0] == "https://app.fireflies.ai/view/01TRANSCRIPT9"
    assert after[issue][0] == "https://github.com/example/checkout/issues/42"
    assert after[upload] == before[upload]  # not written at all
    assert await repair_version_urls() == 0


async def test_hidden_items_score_neutral_and_people_see_live_freshness(client, fake):  # noqa: F811
    """(6) Intake refs another person reads with nothing released (an item they may not
    see) score neutral, never by the item's current upstream time. Baseline evidence:
    people read the live score, which follows the item as it changes upstream (S6,
    owner 2026-10-20: freshness is frozen only for runs, test_evidence_freshness)."""
    from oracle.baseline import scoring
    from oracle.intake import evidence as ev

    ctx, _, items = await world(client, fake, hidden=False, role="approver")
    async with tenant_session(ctx.tenant_id) as s:
        approver = ctx.users["approver"]
        reader = Principal(
            tenant_id=ctx.tenant_id, kind="user", role="approver", user_id=approver.id
        )
        before = await ev.refs(s, [items["a"]], reader, None)
    feat = await entity(client, ctx, type="feature", key="saved-addresses")
    url = f"/v1/baseline/entities/{feat['id']}/evidence"
    resp = await client.post(
        url, json={"source_item_id": str(items["old"])}, headers=ctx.as_("author")
    )
    assert resp.status_code == 201, resp.text
    scored = resp.json()["confidence"]
    async with tenant_session(ctx.tenant_id) as s:
        for key in ("a", "old"):
            item = await s.get(SourceItem, items[key])
            item.source_updated_at = datetime.now(UTC)
        await s.commit()
    async with tenant_session(ctx.tenant_id) as s:
        after = await ev.refs(s, [items["a"]], reader, None)
        await scoring.rescore_targets(s, entity_ids=[uuid.UUID(feat["id"])])
        await s.commit()
    assert not after[items["a"]].visible
    assert after[items["a"]].confidence == before[items["a"]].confidence
    [row] = (
        await client.get(f"/v1/baseline/entities/{feat['id']}", headers=ctx.as_("viewer"))
    ).json()["evidence"]
    assert row["confidence"] > scored


async def test_owners_see_their_items_current_title_and_link(client, fake):  # noqa: F811
    """(7) A rename with no content change writes no version: the owner (a person, never
    frozen) reads the item's current title and link; the run reads them as shared."""
    pass

    ctx, intake_id, items = await world(client, fake, hidden=False, role="approver")
    await _as_notion_page(ctx, items["a"])
    await share_all(client, ctx, intake_id, "full")
    feat = await entity(client, ctx, type="feature", key="saved-addresses")
    resp = await client.post(
        f"/v1/baseline/entities/{feat['id']}/evidence",
        json={"source_item_id": str(items["a"])},
        headers=ctx.as_("author"),
    )
    assert resp.status_code == 201, resp.text
    await _rename_page(ctx, items["a"])
    own = (await client.get(f"/v1/source-items/{items['a']}", headers=ctx.as_("author"))).json()
    assert (own["title"], own["url"]) == (NEW_TITLE, NEW_LINK)
    entity_out = await client.get(f"/v1/baseline/entities/{feat['id']}", headers=ctx.as_("author"))
    assert entity_out.json()["evidence"][0]["source_item"]["url"] == NEW_LINK
    assert set((await _run_links(client, ctx, "author", intake_id, items["a"])).values()) == {
        OLD_LINK
    }


# Last: tests.test_intake_sharing_writes imports this module back, so it reads it whole.
import tests.test_intake_sharing_writes as _writes  # noqa: E402
