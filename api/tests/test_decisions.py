"""H1 Decision log: the record, who may do what, reviews, the Inbox rows, the graph.

Each test states its card: protects (the observable it guards), fails_when (the wrong
result it rejects) and no_claim (what green does not prove, and what stands in for what).
Synthetic placeholders only.
"""

import asyncio
import uuid
from datetime import datetime, timedelta

import pytest
from sqlalchemy import select, text

from oracle.baseline.models import Edge, Entity
from oracle.decisions import capture as capture_lines
from oracle.decisions.models import Decision, DecisionReview
from oracle.docs.models import Document, DocumentVersion
from oracle.jobs import worker
from oracle.jobs.models import LlmJob
from oracle.quality.models import OutcomeRecord
from oracle.tenancy import tenant_session
from oracle.v2.models import ArtifactDependency, ChangeEvent
from tests.baseline_helpers import make_ctx
from tests.blocker_helpers import make_entity, make_evidence
from tests.claude_account_helpers import add_account, window
from tests.decision_helpers import (
    clock,  # noqa: F401 (autouse: one clock for the test and the API)
    decide,
    decide_body,
    freeze,
    in_days,
    proposal,
    propose,
    rows,
    today,
    two_options,
)
from tests.test_llm_jobs import FakeClaude


@pytest.fixture
async def ctx():
    return await make_ctx()


# --- unit: numbers, validation, the role rule, the generated line ---------------------------


async def test_numbers_follow_the_company_maximum_and_never_collide(client, ctx):
    """protects=number is the company's previous maximum plus 1, also for concurrent
    creates; fails_when=two creates racing get the same D-number or a number is reused;
    no_claim=two concurrent requests through one ASGI app stand in for two API instances."""
    first = await propose(client, ctx)
    assert first["number"] == 1 and first["ref"] == "D-1"
    results = await asyncio.gather(
        *[
            client.post("/v1/decisions", json=proposal(ctx), headers=ctx.as_("commenter"))
            for _ in range(4)
        ]
    )
    assert [r.status_code for r in results] == [201] * 4
    assert sorted(r.json()["number"] for r in results) == [2, 3, 4, 5]
    # Another company counts from 1.
    other = await make_ctx("Other Co")
    assert (await propose(client, other))["number"] == 1


@pytest.mark.parametrize(
    ("options", "fragment"),
    [
        (two_options() + [two_options()[0]], "unique"),
        ([{**two_options()[0], "key": f"o{i}"} for i in range(7)], "6"),
    ],
)
async def test_option_rules(client, ctx, options, fragment):
    """protects=option keys are unique and at most six are kept; fails_when=a duplicate
    key or a seventh option is stored; no_claim=none beyond protects."""
    resp = await client.post(
        "/v1/decisions", json=proposal(ctx, options=options), headers=ctx.as_("commenter")
    )
    assert resp.status_code == 422, resp.text
    assert fragment in resp.text
    assert await rows(ctx.tenant_id) == []


async def test_review_date_defaults_to_90_days_and_is_bounded(client, ctx):
    """protects=deciding without review_at stores the decision date + 90 days; a date in
    the past or more than 365 days out is refused; fails_when=no review date is stored or
    an out-of-range one is accepted; no_claim=the server's today is the decision date."""
    d = await propose(client, ctx)
    for bad in (in_days(-1), in_days(366)):
        resp = await client.post(
            f"/v1/decisions/{d['number']}/decide",
            json=decide_body(review_at=bad),
            headers=ctx.as_("approver"),
        )
        assert resp.status_code == 422, resp.text
    decided = await decide(client, ctx, d["number"])
    assert decided["status"] == "decided"
    assert decided["review_at"] == in_days(90)
    assert decided["decided_by"] == str(ctx.users["approver"].id)


async def test_hard_to_reverse_needs_the_settings_role(client, ctx):
    """protects=a hard-to-reverse decision is decided only by an approver holding
    decision_irreversible_role (default owner); fails_when=an approver-role member decides
    it while the setting is owner, or stays refused after an owner lowers it; no_claim=none
    beyond protects."""
    d = await propose(client, ctx, reversibility="irreversible")
    resp = await client.post(
        f"/v1/decisions/{d['id']}/decide",
        json=decide_body(reversibility="irreversible"),
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == "Only an owner can decide a hard-to-reverse decision"
    # Owner-only setting, validated.
    bad = await client.put(
        "/v1/settings/decision_irreversible_role",
        json={"value": "commenter"},
        headers=ctx.as_("owner"),
    )
    assert bad.status_code == 422
    refused = await client.put(
        "/v1/settings/decision_irreversible_role",
        json={"value": "approver"},
        headers=ctx.as_("approver"),
    )
    assert refused.status_code == 403
    ok = await client.put(
        "/v1/settings/decision_irreversible_role",
        json={"value": "approver"},
        headers=ctx.as_("owner"),
    )
    assert ok.status_code == 200, ok.text
    decided = await decide(client, ctx, d["id"], reversibility="irreversible")
    assert decided["reversibility"] == "irreversible" and decided["status"] == "decided"


def test_generated_checkpoint_line():
    """protects=a checkpoint approval with no note reads what was staged; fails_when=the
    counts are lost or mis-pluralised; no_claim=the counts are passed in, not read from a
    D8 draft (not on main)."""
    line = capture_lines.checkpoint_line
    assert line("approved", staged=2, waivers=1) == "Approved with 2 staged changes and 1 waiver"
    assert line("approved", staged=1, waivers=0) == "Approved with 1 staged change"
    assert line("approved", staged=0, waivers=3) == "Approved with 3 waivers"
    assert line("approved") == "Approved with no note"
    assert line("changes_requested") == "Sent back with no note"


async def test_decide_validation_changes_nothing(client, ctx):
    """protects=an unknown option, an empty rationale or a missing expected outcome is a
    422 that leaves the decision proposed; fails_when=any of them is stored or half
    applied; no_claim=none beyond protects."""
    d = await propose(client, ctx)
    for body in (
        decide_body(option_key="nope"),
        decide_body(rationale="  "),
        {k: v for k, v in decide_body().items() if k != "expected_outcome"},
    ):
        resp = await client.post(
            f"/v1/decisions/{d['number']}/decide", json=body, headers=ctx.as_("approver")
        )
        assert resp.status_code == 422, (body, resp.text)
    [row] = await rows(ctx.tenant_id)
    assert row.status == "proposed" and row.chosen_option is None and row.lock_version == 1
    # Fewer than two options cannot be decided.
    one = await propose(client, ctx, options=two_options()[:1])
    resp = await client.post(
        f"/v1/decisions/{one['number']}/decide", json=decide_body(), headers=ctx.as_("approver")
    )
    assert resp.status_code == 422 and "two options" in resp.text


async def test_state_reads_review_due_once_the_date_arrives(client, ctx):
    """protects=a decided judgement call whose review date is today reads state
    review_due in the list and the record; fails_when=it stays plain decided; no_claim=the
    date is today's, not a moved clock."""
    d = await propose(client, ctx)
    out = await decide(client, ctx, d["number"], review_at=today().isoformat())
    assert out["state"] == "review_due" and out["status"] == "decided"
    listed = (await client.get("/v1/decisions?due=true", headers=ctx.as_("viewer"))).json()
    assert [x["number"] for x in listed] == [d["number"]]
    assert listed[0]["state"] == "review_due"


# 23:30 and 00:30 in UTC and in America/Los_Angeles (PDT, UTC-7) around 2026-10-23.
CLOCKS = (
    "2026-10-22T23:30:00+00:00",
    "2026-10-23T00:30:00+00:00",
    "2026-10-22T23:30:00-07:00",
    "2026-10-23T00:30:00-07:00",
)


@pytest.mark.parametrize("zone", ["UTC", "America/Los_Angeles"])
@pytest.mark.parametrize("at", CLOCKS)
async def test_today_is_the_company_day_at_any_hour(client, ctx, monkeypatch, zone, at):
    """protects=the default review date (+90 days), the "not in the past" bound and
    review_due read today in the company time zone, at any hour; fails_when=the API takes
    UTC's date for a Pacific company (from 5 PM PDT it refuses the company's today) or the
    test and the API read different clocks (#336); no_claim=the clock is frozen in the
    process, not the machine's."""
    freeze(monkeypatch, datetime.fromisoformat(at))
    if zone != "UTC":
        put = await client.put(
            "/v1/settings/company_timezone", json={"value": zone}, headers=ctx.as_("owner")
        )
        assert put.status_code == 200, put.text
    d = await propose(client, ctx)
    resp = await client.post(
        f"/v1/decisions/{d['number']}/decide",
        json=decide_body(review_at=in_days(-1, zone)),
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 422 and "cannot be in the past" in resp.text
    out = await decide(client, ctx, d["number"], review_at=in_days(0, zone))
    assert out["state"] == "review_due"
    later = await decide(client, ctx, (await propose(client, ctx))["number"])
    assert (later["review_at"], later["state"]) == (in_days(90, zone), "decided")


# --- API: create, decide, reassign, withdraw, edit, review --------------------------------


async def test_create_roles_and_record(client, ctx):
    """protects=a commenter proposes (201, proposed, origin manual, driver user:<id>) and
    a viewer is refused; fails_when=a viewer creates one or the record loses its fields;
    no_claim=none beyond protects."""
    resp = await client.post("/v1/decisions", json=proposal(ctx), headers=ctx.as_("viewer"))
    assert resp.status_code == 403
    d = await propose(client, ctx, informed_ids=[str(ctx.users["viewer"].id)])
    assert d["status"] == "proposed" and d["origin"] == "manual" and d["class"] == "judgement"
    assert d["driver"] == f"user:{ctx.users['commenter'].id}"
    assert d["lock_version"] == 1
    assert [o["key"] for o in d["options"]] == ["caps-first", "together"]
    assert d["approver_email"] == "approver@example.com"
    # Read by number, by D-number and by id.
    for ref in (d["number"], f"D-{d['number']}", d["id"]):
        got = await client.get(f"/v1/decisions/{ref}", headers=ctx.as_("viewer"))
        assert got.status_code == 200 and got.json()["id"] == d["id"]
    # The approver must be an active approver or above.
    resp = await client.post(
        "/v1/decisions",
        json=proposal(ctx, approver_id=str(ctx.users["commenter"].id)),
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 422


async def test_only_the_named_approver_decides(client, ctx):
    """protects=anyone but the named approver gets 403 "Only <name> decides D-<n>";
    fails_when=an owner or the proposer decides in the approver's place; no_claim=the
    approver's email stands in for their name (members have no display name)."""
    d = await propose(client, ctx)
    for who in ("owner", "commenter", "viewer"):
        resp = await client.post(
            f"/v1/decisions/{d['number']}/decide", json=decide_body(), headers=ctx.as_(who)
        )
        assert resp.status_code == 403, who
        assert resp.json()["detail"] == f"Only approver@example.com decides D-{d['number']}"
    out = await decide(client, ctx, d["number"])
    assert out["chosen_option"] == "caps-first" and out["decided_at"]
    again = await client.post(
        f"/v1/decisions/{d['number']}/decide", json=decide_body(), headers=ctx.as_("approver")
    )
    assert again.status_code == 409


async def test_prediction_creates_one_outcome_record(client, ctx):
    """protects=deciding with a prediction creates exactly one outcome record (tracking)
    and stores its id; fails_when=none or two are created, or outcome_id stays empty;
    no_claim=H3's status changes are not built."""
    goal = await make_entity(ctx, "goal", "fewer-spend-incidents")
    d = await propose(client, ctx)
    prediction = {
        "goal_id": str(goal),
        "metric": "spend incidents per month",
        "baseline": "6",
        "predicted": "2",
        "threshold": "3",
        "by": in_days(100),
    }
    out = await decide(client, ctx, d["number"], prediction=prediction)
    assert out["outcome_id"]
    async with tenant_session(ctx.tenant_id) as s:
        records = list(await s.scalars(select(OutcomeRecord)))
    assert len(records) == 1
    assert str(records[0].id) == out["outcome_id"] and records[0].status == "tracking"
    assert records[0].prediction["metric"] == "spend incidents per month"
    assert records[0].goal_id == goal


async def test_reassign_is_an_owners(client, ctx):
    """protects=only owners reassign the approver, to an active approver or above;
    fails_when=the approver or a commenter reassigns, or a commenter becomes approver;
    no_claim=none beyond protects."""
    d = await propose(client, ctx)
    body = {"approver_id": str(ctx.users["owner"].id), "reason": "The owner holds pricing"}
    resp = await client.post(
        f"/v1/decisions/{d['number']}/reassign", json=body, headers=ctx.as_("approver")
    )
    assert resp.status_code == 403
    bad = {"approver_id": str(ctx.users["commenter"].id), "reason": "x"}
    resp = await client.post(
        f"/v1/decisions/{d['number']}/reassign", json=bad, headers=ctx.as_("owner")
    )
    assert resp.status_code == 422
    resp = await client.post(
        f"/v1/decisions/{d['number']}/reassign", json=body, headers=ctx.as_("owner")
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["approver_id"] == str(ctx.users["owner"].id)
    out = await decide(client, ctx, d["number"], who="owner")
    assert out["decided_by"] == str(ctx.users["owner"].id)


async def test_withdraw_and_edit(client, ctx):
    """protects=a proposed decision is edited (lock_version) and withdrawn by its creator,
    approver or an owner; others get 403; a decided one is 409 "Decided decisions are not
    edited. Revisit it instead."; fails_when=a stale lock_version overwrites or a decided
    decision changes; no_claim=none beyond protects."""
    d = await propose(client, ctx)
    path = f"/v1/decisions/{d['number']}"
    resp = await client.patch(
        path, json={"lock_version": 1, "title": "Caps first"}, headers=ctx.as_("viewer")
    )
    assert resp.status_code == 403
    resp = await client.patch(
        path, json={"lock_version": 1, "title": "Caps first"}, headers=ctx.as_("commenter")
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["title"] == "Caps first" and resp.json()["lock_version"] == 2
    stale = await client.patch(
        path, json={"lock_version": 1, "title": "Stale"}, headers=ctx.as_("approver")
    )
    assert stale.status_code == 409
    # Withdraw: proposed only, by creator, approver or owner.
    other = await propose(client, ctx)
    resp = await client.post(
        f"/v1/decisions/{other['number']}/withdraw", json={"reason": "x"}, headers=ctx.as_("viewer")
    )
    assert resp.status_code == 403
    resp = await client.post(
        f"/v1/decisions/{other['number']}/withdraw",
        json={"reason": "Pricing moved to next quarter"},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 200 and resp.json()["status"] == "withdrawn"

    decided = await decide(client, ctx, d["number"])
    resp = await client.patch(
        path,
        json={"lock_version": decided["lock_version"], "title": "Changed"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 409
    assert resp.json()["detail"] == "Decided decisions are not edited. Revisit it instead."
    resp = await client.post(f"{path}/withdraw", json={"reason": "x"}, headers=ctx.as_("owner"))
    assert resp.status_code == 409


async def test_reviews_reaffirm_revisit_reverse(client, ctx):
    """protects=the approver reviews a decided decision: reaffirm moves the review date,
    revisit opens a proposed decision that supersedes the original once decided, reverse
    marks it reversed; fails_when=another person reviews, a proposed one is reviewed, or
    the original is not superseded; no_claim=none beyond protects."""
    d = await propose(client, ctx)
    path = f"/v1/decisions/{d['number']}/reviews"
    early = await client.post(
        path, json={"verdict": "reaffirmed", "note": "x"}, headers=ctx.as_("approver")
    )
    assert early.status_code == 409
    await decide(client, ctx, d["number"])
    resp = await client.post(
        path, json={"verdict": "reaffirmed", "note": "Held"}, headers=ctx.as_("owner")
    )
    assert resp.status_code == 403
    resp = await client.post(
        path,
        json={
            "verdict": "reaffirmed",
            "note": "Held: 1 incident in December",
            "next_review_at": in_days(120),
        },
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["review_at"] == in_days(120) and resp.json()["status"] == "decided"
    assert [r["verdict"] for r in resp.json()["reviews"]] == ["reaffirmed"]

    resp = await client.post(
        path, json={"verdict": "revisit", "note": "Detection is ready"}, headers=ctx.as_("approver")
    )
    assert resp.status_code == 200, resp.text
    revisit_id = resp.json()["revisit_id"]
    assert revisit_id and resp.json()["status"] == "decided"
    new = (await client.get(f"/v1/decisions/{revisit_id}", headers=ctx.as_("viewer"))).json()
    assert new["status"] == "proposed" and new["supersedes_id"] == d["id"]
    assert new["title"] == d["title"] and [o["key"] for o in new["options"]] == [
        "caps-first",
        "together",
    ]
    await decide(client, ctx, revisit_id, option_key="together")
    original = (await client.get(f"/v1/decisions/{d['id']}", headers=ctx.as_("viewer"))).json()
    assert original["status"] == "superseded"

    resp = await client.post(
        f"/v1/decisions/{revisit_id}/reviews",
        json={"verdict": "reversed", "note": "Detection slipped"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200 and resp.json()["status"] == "reversed"
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.scalar(select(DecisionReview.verdict).where(
            DecisionReview.decision_id == uuid.UUID(revisit_id))) == "reversed"  # fmt: skip


async def test_company_isolation(client, ctx):
    """protects=every route answers 404 for another company's decision id; fails_when=a
    route reads or changes it; no_claim=none beyond protects."""
    d = await propose(client, ctx)
    other = await make_ctx("Other Co")
    h = other.as_("owner")
    base = f"/v1/decisions/{d['id']}"
    calls = [
        client.get(base, headers=h),
        client.patch(base, json={"lock_version": 1, "title": "x"}, headers=h),
        client.post(f"{base}/decide", json=decide_body(), headers=h),
        client.post(
            f"{base}/reassign",
            json={"approver_id": str(other.users["owner"].id), "reason": "x"},
            headers=h,
        ),
        client.post(f"{base}/withdraw", json={"reason": "x"}, headers=h),
        client.post(f"{base}/reviews", json={"verdict": "reversed", "note": "x"}, headers=h),
        client.post(f"{base}/options-job", headers=h),
    ]
    for resp in await asyncio.gather(*calls):
        assert resp.status_code == 404, resp.text
    assert (await client.get("/v1/decisions", headers=h)).json() == []
    [row] = await rows(ctx.tenant_id)
    assert row.title == d["title"] and row.status == "proposed"


# --- Inbox -------------------------------------------------------------------------------


async def _inbox(client, ctx, who: str) -> dict:
    resp = await client.get("/v1/inbox", headers=ctx.as_(who))
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_inbox_rows_and_counts(client, ctx):
    """protects=the approver sees needs_decision for each proposed decision and review_due
    once review_at is today, both counted in needs_me and total; an informed member sees
    an informed row that counts in neither; fails_when=a row is missing or the counts are
    off; no_claim=H11's oracle_decided row is not built."""
    before = await _inbox(client, ctx, "approver")
    viewer_before = await _inbox(client, ctx, "viewer")
    proposed = await propose(client, ctx)
    due = await propose(client, ctx, informed_ids=[str(ctx.users["viewer"].id)])
    await decide(client, ctx, due["number"], review_at=today().isoformat())

    inbox = await _inbox(client, ctx, "approver")
    by = {(r["number"], r["reason"]): r for r in inbox["decisions"]}
    assert by[(proposed["number"], "needs_decision")]["counts"] is True
    assert by[(due["number"], "review_due")]["counts"] is True
    assert by[(due["number"], "review_due")]["review_at"] == today().isoformat()
    assert inbox["needs_me"] == before["needs_me"] + 2
    assert inbox["total"] == before["total"] + 2

    viewer = await _inbox(client, ctx, "viewer")
    [row] = viewer["decisions"]
    assert (row["number"], row["reason"], row["counts"]) == (due["number"], "informed", False)
    assert viewer["total"] == viewer_before["total"]
    assert viewer["needs_me"] == viewer_before["needs_me"]

    # Reaffirmed in place: the row is done and no longer counted.
    resp = await client.post(
        f"/v1/decisions/{due['number']}/reviews",
        json={"verdict": "reaffirmed", "note": "Held"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200 and resp.json()["review_at"] == in_days(90)
    after = await _inbox(client, ctx, "approver")
    done = [r for r in after["decisions"] if r["number"] == due["number"]]
    assert [(r["state"], r["counts"]) for r in done] == [("done", False)]
    assert after["total"] == before["total"] + 1


# --- the graph and staleness ---------------------------------------------------------------


async def test_decided_call_syncs_a_locked_decision_entity_and_reversal_marks_stale(client, ctx):
    """protects=deciding upserts one locked baseline decision entity d-<n> with affects
    edges; reversing rejects it, records a decision change event and marks a version that
    depends on it potentially stale; fails_when=no entity, a second entity, or no
    staleness; no_claim=the dependency row is inserted directly, as the trace lane would."""
    feature = await make_entity(ctx, "feature", "usage-caps")
    d = await propose(client, ctx, entity_ids=[str(feature)])
    out = await decide(client, ctx, d["number"])
    async with tenant_session(ctx.tenant_id) as s:
        [ent] = list(await s.scalars(select(Entity).where(Entity.type == "decision")))
        assert ent.key == f"d-{d['number']}" and ent.locked and ent.status == "confirmed"
        assert ent.attrs == {
            "decision_id": d["id"],
            "chosen_option": "caps-first",
            "reversibility": "reversible",
        }
        assert ent.body == out["rationale"]
        edge = await s.scalar(select(Edge).where(Edge.src_id == ent.id))
        assert edge.type == "affects" and edge.dst_id == feature
        doc = Document(slug="usage-alerts", title="Usage alerts PRD")
        s.add(doc)
        await s.flush()
        version = DocumentVersion(document_id=doc.id, number=1, markdown="x", content_hash="h")
        s.add(version)
        await s.flush()
        s.add(ArtifactDependency(document_version_id=version.id, upstream_entity_id=ent.id))
        await s.commit()
        entity_id, version_id = ent.id, version.id
    assert out["entity_id"] == str(entity_id)

    resp = await client.post(
        f"/v1/decisions/{d['number']}/reviews",
        json={"verdict": "reversed", "note": "Caps confused customers"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        ent = await s.get(Entity, entity_id)
        assert ent.status == "rejected"
        kinds = list(await s.scalars(select(ChangeEvent.subject_kind)))
        assert "decision" in kinds
        dep = await s.scalar(
            select(ArtifactDependency).where(ArtifactDependency.document_version_id == version_id)
        )
        assert dep.freshness == "potentially_stale"
        assert await s.scalar(select(Entity.id).where(Entity.type == "decision").limit(2)) == ent.id


def _migration():
    """The H1 migration module, for its backfill statements."""
    import importlib.util

    from tests.conftest import API_DIR

    path = API_DIR / "migrations" / "versions" / "0020_decisions.py"
    spec = importlib.util.spec_from_file_location("migration_0020_decisions", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def test_a_backfilled_decision_is_in_the_graph_and_reversing_it_marks_stale(client, ctx):
    """protects=a gap's accepted assumption backfilled by the migration is in the Baseline
    graph as live capture leaves it: one locked decision entity d-<n> on the record, the
    gap's entity among its subjects (not its entity_ids); reversing it rejects that entity
    and marks a version that depends on it potentially stale (criterion 10);
    fails_when=the backfill leaves no entity, so reversing marks nothing stale;
    no_claim=the migration's backfill statements run on the test database (already at
    head) rather than through Alembic, and the dependency row is inserted directly."""
    from oracle.v2.models import AssumptionDecision

    feature = await make_entity(ctx, "feature", "usage-caps")
    async with tenant_session(ctx.tenant_id) as s:
        s.add(
            AssumptionDecision(
                entity_id=feature,
                statement="Buyers keep one billing address",
                decision="accept_assumption",
                rationale="Measured in the pilot",
                decided_by=ctx.users["approver"].id,
            )
        )
        await s.commit()
    module = _migration()
    async with tenant_session(ctx.tenant_id) as s:
        for statement in getattr(module, "BACKFILLS", (module.BACKFILL,)):
            await s.execute(text(statement))
        await s.commit()
    got = (await client.get("/v1/decisions/1", headers=ctx.as_("viewer"))).json()
    assert got["status"] == "decided" and got["origin"] == "assumption"
    assert got["entity_ids"] == []
    assert {"kind": "entity", "id": str(feature)} in got["subjects"]
    async with tenant_session(ctx.tenant_id) as s:
        d = await s.scalar(select(Decision).where(Decision.number == 1))
        assert d.entity_id is not None
        ent = await s.get(Entity, d.entity_id)
        assert ent.type == "decision" and ent.key == "d-1"
        assert ent.locked and ent.status == "confirmed"
        assert ent.attrs == {
            "decision_id": str(d.id),
            "chosen_option": "accept_assumption",
            "reversibility": "reversible",
        }
        doc = Document(slug="billing", title="Billing PRD")
        s.add(doc)
        await s.flush()
        version = DocumentVersion(document_id=doc.id, number=1, markdown="x", content_hash="h")
        s.add(version)
        await s.flush()
        s.add(ArtifactDependency(document_version_id=version.id, upstream_entity_id=ent.id))
        await s.commit()
        entity_id, version_id = ent.id, version.id

    resp = await client.post(
        "/v1/decisions/1/reviews",
        json={"verdict": "reversed", "note": "Buyers asked for several addresses"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(Entity, entity_id)).status == "rejected"
        dep = await s.scalar(
            select(ArtifactDependency).where(ArtifactDependency.document_version_id == version_id)
        )
        assert dep.freshness == "potentially_stale"


# --- Ask Oracle for options -----------------------------------------------------------------


async def test_options_job_fills_options_with_evidence_and_a_recommendation(client, ctx):
    """protects=an approver queues decision_options; the job fills 2-4 options with
    evidence ids it was given and marks one recommended; a commenter is refused;
    fails_when=evidence the model was not given is kept or no option is recommended;
    no_claim=a scripted fake stands in for the model."""
    feature = await make_entity(ctx, "feature", "usage-caps")
    ev = await make_evidence(ctx, feature, confidence=0.9)
    d = await propose(client, ctx, options=[], entity_ids=[str(feature)])
    resp = await client.post(
        f"/v1/decisions/{d['number']}/options-job", headers=ctx.as_("commenter")
    )
    assert resp.status_code == 403
    resp = await client.post(
        f"/v1/decisions/{d['number']}/options-job", headers=ctx.as_("approver")
    )
    assert resp.status_code == 201, resp.text
    job = resp.json()
    assert job["kind"] == "decision_options" and job["decision_id"] == d["id"]

    fake = FakeClaude()
    from oracle.llm import gateway

    previous = gateway.set_transports(gateway.Transports(plan=fake, api_key=fake))
    try:
        await add_account(ctx.tenant_id, "personal", windows={"five_hour": window(0.2)})
        fake.script["decision_options"].append(
            {
                "options": [
                    {
                        "key": "caps-first",
                        "label": "Caps first",
                        "summary": "Thresholds only",
                        "pros": ["One sprint"],
                        "cons": ["No early warning"],
                        "evidence_ids": [str(ev), str(uuid.uuid4())],
                        "cost_if_wrong": "Noisy alerts",
                        "recommended": True,
                    },
                    {
                        "key": "together",
                        "label": "Ship together",
                        "summary": "Wait",
                        "pros": [],
                        "cons": ["Six weeks"],
                        "evidence_ids": [],
                        "cost_if_wrong": "Late",
                    },
                ]
            }
        )
        await worker.run_pending(ctx.tenant_id)
    finally:
        gateway.set_transports(previous)
    kind, payload = fake.calls[0]
    assert kind == "decision_options"
    assert payload["decision"]["title"] == d["title"]
    assert [e["id"] for e in payload["evidence"]] == [str(ev)]
    got = (await client.get(f"/v1/decisions/{d['number']}", headers=ctx.as_("viewer"))).json()
    assert [o["key"] for o in got["options"]] == ["caps-first", "together"]
    assert got["options"][0]["recommended"] is True and not got["options"][1]["recommended"]
    assert got["options"][0]["evidence_ids"] == [str(ev)]
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(LlmJob, uuid.UUID(job["id"]))
        assert row.status == "succeeded"


async def test_options_job_does_not_hold_the_decision_while_the_model_thinks(client, ctx):
    """protects=while decision_options waits on the model, the approver decides the same
    decision at once, and the job then leaves the decided record's options alone;
    fails_when=Decide waits for the model call (the job holds the row lock) or the job
    writes its options over a decision that changed meanwhile; no_claim=a scripted fake
    stands in for the model and a 5 second bound stands in for "at once"."""
    d = await propose(client, ctx)
    resp = await client.post(
        f"/v1/decisions/{d['number']}/options-job", headers=ctx.as_("approver")
    )
    assert resp.status_code == 201, resp.text
    job = resp.json()

    fake = FakeClaude()
    decided: list[int] = []

    async def decide_meanwhile(kind, payload):
        r = await asyncio.wait_for(
            client.post(
                f"/v1/decisions/{d['number']}/decide",
                json=decide_body(),
                headers=ctx.as_("approver"),
            ),
            timeout=5,
        )
        decided.append(r.status_code)

    fake.on_call = decide_meanwhile
    from oracle.llm import gateway

    previous = gateway.set_transports(gateway.Transports(plan=fake, api_key=fake))
    try:
        await add_account(ctx.tenant_id, "personal", windows={"five_hour": window(0.2)})
        fake.script["decision_options"].append(
            {
                "options": [
                    {"key": "late-a", "label": "Late A", "recommended": True},
                    {"key": "late-b", "label": "Late B"},
                ]
            }
        )
        await worker.run_pending(ctx.tenant_id)
    finally:
        gateway.set_transports(previous)
    assert decided == [200]
    got = (await client.get(f"/v1/decisions/{d['number']}", headers=ctx.as_("viewer"))).json()
    assert got["status"] == "decided" and got["chosen_option"] == "caps-first"
    assert [o["key"] for o in got["options"]] == ["caps-first", "together"]
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(LlmJob, uuid.UUID(job["id"]))
        assert row.status == "failed"
        assert "changed" in (row.error or "")


async def test_options_job_never_drops_options_people_wrote(client, ctx):
    """protects=with 4 options written by people and 4 from Oracle, the record keeps all
    4 of the people's, as written, and only as many of Oracle's as fit in 6;
    fails_when=a person's option is dropped to make room for Oracle's, or a seventh is
    stored; no_claim=a scripted fake stands in for the model."""
    written = two_options() + [
        {**two_options()[0], "key": "pilot", "label": "Pilot with two teams"},
        {**two_options()[1], "key": "defer", "label": "Defer a quarter"},
    ]
    d = await propose(client, ctx, options=written)
    resp = await client.post(
        f"/v1/decisions/{d['number']}/options-job", headers=ctx.as_("approver")
    )
    assert resp.status_code == 201, resp.text
    job = resp.json()
    fake = FakeClaude()
    from oracle.llm import gateway

    previous = gateway.set_transports(gateway.Transports(plan=fake, api_key=fake))
    try:
        await add_account(ctx.tenant_id, "personal", windows={"five_hour": window(0.2)})
        fake.script["decision_options"].append(
            {
                "options": [
                    {"key": "oracle-a", "label": "Oracle A", "recommended": True},
                    {"key": "oracle-b", "label": "Oracle B"},
                    {"key": "oracle-c", "label": "Oracle C"},
                    {"key": "oracle-d", "label": "Oracle D"},
                ]
            }
        )
        await worker.run_pending(ctx.tenant_id)
    finally:
        gateway.set_transports(previous)
    got = (await client.get(f"/v1/decisions/{d['number']}", headers=ctx.as_("viewer"))).json()
    assert [o["key"] for o in got["options"]] == [
        "caps-first",
        "together",
        "pilot",
        "defer",
        "oracle-a",
        "oracle-b",
    ]
    assert [o["label"] for o in got["options"][:4]] == [o["label"] for o in written]
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(LlmJob, uuid.UUID(job["id"]))
        assert row.status == "succeeded"
        assert row.output["options"] == ["oracle-a", "oracle-b"]


async def test_list_filters(client, ctx):
    """protects=status, approver=me, origin, subject and q filter the list, newest number
    first; fails_when=a filter is ignored; no_claim=none beyond protects."""
    doc_id = uuid.uuid4()
    a = await propose(client, ctx, subjects=[{"kind": "document", "id": str(doc_id)}])
    b = await propose(client, ctx, title="Price the team plan per seat")
    await decide(client, ctx, b["number"])
    h = ctx.as_("approver")

    async def numbers(query: str) -> list[int]:
        resp = await client.get(f"/v1/decisions{query}", headers=h)
        assert resp.status_code == 200, resp.text
        return [x["number"] for x in resp.json()]

    assert await numbers("") == [b["number"], a["number"]]
    assert await numbers("?status=proposed") == [a["number"]]
    assert await numbers("?approver=me") == [b["number"], a["number"]]
    assert await numbers(f"?approver={ctx.users['owner'].id}") == []
    assert await numbers("?origin=manual&class=judgement") == [b["number"], a["number"]]
    assert await numbers(f"?subject_kind=document&subject_id={doc_id}") == [a["number"]]
    assert await numbers("?q=team%20plan") == [b["number"]]
    assert await numbers("?limit=1&offset=1") == [a["number"]]


async def test_review_at_after_365_days_is_refused_on_reaffirm(client, ctx):
    """protects=a reaffirm's next review is at most 365 days out; fails_when=a later date
    is stored; no_claim=none beyond protects."""
    d = await propose(client, ctx)
    await decide(client, ctx, d["number"])
    resp = await client.post(
        f"/v1/decisions/{d['number']}/reviews",
        json={"verdict": "reaffirmed", "note": "x", "next_review_at": in_days(400)},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 422
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.scalar(select(Decision))
        assert row.review_at == today() + timedelta(days=90)


async def test_people_lists_active_members_for_the_pickers(client, ctx):
    """protects=any member reads the active members (id, email, role) the pickers offer,
    disabled ones left out; fails_when=a disabled member is offered or a viewer is refused;
    no_claim=none beyond protects."""
    from datetime import UTC, datetime

    from oracle.auth.models import User

    async with tenant_session(ctx.tenant_id) as s:
        gone = User(email="former@example.com", password_hash="x", role="approver")
        gone.disabled_at = datetime.now(UTC)
        s.add(gone)
        await s.commit()
    resp = await client.get("/v1/decisions/people", headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    listed = {p["email"]: p["role"] for p in resp.json()}
    assert listed == {
        "approver@example.com": "approver",
        "commenter@example.com": "commenter",
        "owner@example.com": "owner",
        "viewer@example.com": "viewer",
    }


async def test_list_filters_reach_decisions_older_than_the_newest_200(client, ctx):
    """protects=the Decisions page's state and From filters run in the API, company-scoped,
    so an old decision whose review is due, an old proposal waiting on me (status=open with
    approver=me) and an old checkpoint approval (chosen=approve) are found among 260
    decisions, and offset pages through the rest; fails_when=a filter only sees the newest
    200 or another company's decision is listed; no_claim=rows are inserted directly."""
    from datetime import UTC, datetime

    approver, owner = ctx.users["approver"].id, ctx.users["owner"].id
    now = datetime.now(UTC)
    done = {"chosen_option": "caps-first", "rationale": "Because", "decided_at": now}

    def row(number: int, **fields) -> Decision:
        return Decision(
            number=number,
            title=f"Decision {number}",
            approver_id=fields.pop("approver_id", owner),
            driver="oracle",
            origin=fields.pop("origin", "manual"),
            **fields,
        )

    async with tenant_session(ctx.tenant_id) as s:
        due = today() - timedelta(days=3)
        s.add(row(1, status="decided", approver_id=approver, review_at=due, **done))
        s.add(row(2, status="proposed", approver_id=approver))
        for number, chosen in ((3, "approve"), (4, "request_changes")):
            stop = {**done, "chosen_option": chosen}
            s.add(row(number, status="decided", origin="checkpoint", **stop))
        s.add(row(5, status="decided", review_at=today() + timedelta(days=30), **done))
        for n in range(6, 261):
            s.add(row(n))
        await s.commit()
    other = await make_ctx("Other Co")
    async with tenant_session(other.tenant_id) as s:
        s.add(
            Decision(
                number=1,
                title="Elsewhere",
                approver_id=other.users["approver"].id,
                driver="oracle",
                origin="manual",
                status="decided",
                review_at=today() - timedelta(days=1),
                **done,
            )
        )
        await s.commit()
    h = ctx.as_("approver")

    async def numbers(query: str) -> list[int]:
        resp = await client.get(f"/v1/decisions?limit=200&{query}", headers=h)
        assert resp.status_code == 200, resp.text
        return [x["number"] for x in resp.json()]

    assert await numbers("class=judgement&status=open&approver=me") == [2, 1]
    assert await numbers("class=judgement&status=review_due") == [1]
    assert await numbers("class=judgement&status=proposed&approver=me") == [2]
    assert await numbers("class=judgement&status=decided") == [5, 1]
    assert await numbers("class=all&origin=checkpoint&chosen=approve") == [3]
    assert await numbers("class=all&origin=checkpoint&chosen=request_changes") == [4]
    first = await numbers("class=all")
    rest = await numbers("class=all&offset=200")
    assert first == list(range(260, 60, -1)) and rest == list(range(60, 0, -1))
