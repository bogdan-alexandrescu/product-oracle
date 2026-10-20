"""S6 (owner, 2026-10-19): what others see of findings drawn from the author's own
sources. The author chooses per finding: private (default), counts, summary or full.
Viewers, commenters, approvers, owners and run tokens see only what the level allows;
the author sees everything; every change is audited and can be lowered again.

Synthetic placeholders only.
"""

import json
import uuid
from datetime import timedelta

import pytest
from sqlalchemy import select

from oracle import readiness
from oracle.auth.models import User
from oracle.auth.service import make_session_cookie, sign_run_binding
from oracle.config import get_settings
from oracle.intake import checks as intake_checks
from oracle.jobs import worker
from oracle.llm import gateway
from oracle.models import AuditEvent
from oracle.tenancy import tenant_session
from tests.baseline_helpers import NOW, make_item
from tests.claude_account_helpers import add_account, window
from tests.intake_helpers import BRIEF, company, create_intake, gaps_by_category
from tests.test_intake import _document
from tests.test_intake_jobs import FakeClaude
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
    ctx, intake_id, items = await authored_intake(client, fake)
    texts = await reader_texts(client, ctx, intake_id, who)
    for name, text in texts.items():
        for secret in [*SECRETS, MODEL_GAP]:
            assert secret not in text, (who, name, secret)
        for item_id in items.values():
            assert str(item_id) not in text, (who, name, "item id")
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
    ctx, intake_id, _ = await authored_intake(client, fake)
    await share_all(client, ctx, intake_id, "counts")
    texts = await reader_texts(client, ctx, intake_id, who)
    for name, text in texts.items():
        for secret in [*SECRETS, MODEL_GAP]:
            assert secret not in text, (who, name, secret)
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
    ctx, intake_id, items = await authored_intake(client, fake)
    await share_all(client, ctx, intake_id, "summary")
    texts = await reader_texts(client, ctx, intake_id, who)
    for name, text in texts.items():
        for secret in SECRETS:
            assert secret not in text, (who, name, secret)
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
    headers = {"cookie": f"{get_settings().session_cookie_name}={cookie}",
               "x-oracle-run-id": sign_run_binding(ctx.users["author"].id, uuid.uuid4())}  # fmt: skip
    resp = await client.get(f"/v1/intakes/{intake_id}/summary", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["is_author"] is False and MODEL_GAP not in resp.text
    # A bare or malformed run id is not a run: the author stays the author.
    for bad_value in ("not-a-uuid", str(uuid.uuid4())):
        bad = {**headers, "x-oracle-run-id": bad_value}
        resp = await client.get(f"/v1/intakes/{intake_id}/summary", headers=bad)
        assert resp.status_code == 200 and resp.json()["is_author"] is True


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
        for name, text in texts.items():
            for secret in [*SECRETS, MODEL_GAP]:
                assert secret not in text, (who, name, secret)
    mine = await read_summary(client, ctx, intake_id, "author")
    assert any(g["statement"] == MODEL_GAP for g in mine["gaps"])
