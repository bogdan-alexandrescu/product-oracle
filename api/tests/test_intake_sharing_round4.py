"""Security review, round 4 (S6 follow-ups, owner 2026-10-19).

1. A critical gap from private sources blocks publishing only once its author shares it
   (counts or above); while private the author is warned privately and publish passes.
2. The summary level shows a line Oracle drafts and the author edits or confirms; until
   then others see only the fixed category line.
3. Agent runs, including the author's own, see each finding only at its sharing level.
4. Answering a question about a private finding proposes nothing to the baseline until
   the author shares the finding.

And: a person's importance edit is recorded the same way whatever private findings
exist, it never flips when private evidence arrives, and private evidence never moves
a shared row. Synthetic placeholders only.
"""

import json
import uuid

import pytest
from sqlalchemy import select

from oracle import readiness
from oracle.auth.deps import Principal
from oracle.baseline.models import Proposal
from oracle.intake import checks as intake_checks
from oracle.jobs import worker
from oracle.llm import gateway
from oracle.models import AuditEvent
from oracle.runs.models import Run
from oracle.tenancy import tenant_session
from oracle.v2.models import KnowledgeGap, ProductIntake, StakeholderQuestion
from tests.baseline_helpers import make_item
from tests.claude_account_helpers import add_account, window
from tests.intake_helpers import BRIEF, company, create_intake, gaps_by_category
from tests.test_intake import _document
from tests.test_intake_jobs import FakeClaude
from tests.test_intake_sharing import (
    CODENAME,
    EXCERPT_A,
    EXCERPT_B,
    MODEL_GAP,
    TITLE_A,
    _model,
    add_author,
    authored_intake,
    findings,
    read_summary,
)
from tests.test_intake_sharing_round3 import (
    UNRELATED,
    USERS_BRIEF,
    add_person,
    assert_same,
    twin_intakes,
)
from tests.test_intake_sharing_writes import as_run

OTHERS = ["viewer", "commenter", "approver", "owner"]


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
    ctx, private_id, plain_id = await twin_intakes(client)
    private = await rows_of(ctx, private_id)
    plain = await rows_of(ctx, plain_id)

    def rationales(rows):
        return sorted((k.split(":")[1], v[1]) for k, v in rows.items() if k.startswith("question"))

    assert rationales(private) == rationales(plain)


# --- MAJOR 4: no baseline proposal from a private finding until it is shared -------------


def _privacy_gap(payload):
    answer = _model(payload)
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
    assert attrs["gap_id"] == str(q.gap_id) and attrs["intake_id"] == intake_id
    assert MODEL_GAP not in json.dumps(proposal.payload)
    # Lowering and sharing again proposes nothing new.
    await share(client, ctx, intake_id, str(q.gap_id), "private")
    await share(client, ctx, intake_id, str(q.gap_id), "summary")
    assert len(await _baseline_proposals(ctx)) == 1


# --- S6 decision 1: a private critical gap gates publishing only once shared -------------


def _critical_blocker(payload):
    answer = _model(payload)
    answer["gaps"] = [{"category": "blockers", "importance": "critical",
                       "statement": f"The {CODENAME} quota blocks pre-fill.",
                       "evidence_refs": []}]  # fmt: skip
    return answer


async def _gate(ctx, document_id: str, principal: Principal | None = None):
    async with tenant_session(ctx.tenant_id) as s:
        return await readiness.evaluate(
            readiness.ReadinessContext(
                s, uuid.UUID(document_id), purpose="publish", viewer=principal
            ),
            keys=[intake_checks.CRITICAL_BLOCKERS],
        )


def _principal(ctx, who: str) -> Principal:
    user = ctx.users[who]
    return Principal(tenant_id=ctx.tenant_id, kind="user", role=user.role, user_id=user.id)


async def test_a_private_critical_gap_warns_its_author_and_gates_once_shared(client, fake):
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
    resp = await client.put(url, json={"text": "x y z"}, headers=as_run(ctx))
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
                select(AuditEvent).where(AuditEvent.action == "intake.finding_summary_set")
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
    return {**as_run(ctx), "x-oracle-run-id": str(run_id)}


@pytest.mark.parametrize("real_run", [False, True])
async def test_a_run_never_reads_a_private_findings_items(client, fake, real_run):
    ctx, intake_id, items = await authored_intake(client, fake)
    h = await _run_of(ctx, intake_id) if real_run else as_run(ctx)
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

    # Shared in full: a run of the intake reads what the finding cites.
    rows = await findings(client, ctx, intake_id)
    [conflict] = [r for r in rows if r["kind"] == "conflict"]
    assert (await share(client, ctx, intake_id, conflict["id"], "full")).status_code == 200
    resp = await client.get(f"/v1/intakes/{intake_id}/evidence", params={"q": "buyers"},
                            headers=h)  # fmt: skip
    hits = {x["source_item_id"]: x for x in resp.json()["hits"]}
    assert str(items["old"]) not in hits
    if real_run:
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
