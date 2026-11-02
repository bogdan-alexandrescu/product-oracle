# ruff: noqa: F811 - the fake Claude fixture is imported
"""INT2 lane 1: Oracle's read of a new intake runs as a SwarmCloud ``intake_analysis`` run.

Owner answers (docs/product-oracle-v2/specs/owner-answers.md, INT2): Q2 automatic on create
and repin with the company switch ``intake_ai_read`` on by default; Q3 (changed) when the
SwarmCloud read cannot start or fails, Oracle falls back to the built-in pool job for that
intake, and the intake says which path produced its read; Q4 analyst at quick, $1.50.
``ORACLE_INTAKE_READ_RUNTIME=job`` stays the rollback. Synthetic placeholders only.
"""

import asyncio
import time
import uuid
from decimal import Decimal

import pytest
from sqlalchemy import select

from oracle import audit
from oracle.config import get_settings
from oracle.intake import read as intake_read
from oracle.jobs.models import LlmJob
from oracle.models import AuditEvent
from oracle.runs.models import Run, RunSegment
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from oracle.swarm.runtime import RuntimeUnavailable
from oracle.tenancy import tenant_session
from oracle.v2.models import ProductIntake
from tests.baseline_helpers import make_item
from tests.claude_account_helpers import add_account, window
from tests.conftest import seed_company
from tests.intake_helpers import BRIEF, PAIN, company, create_intake, summary
from tests.test_intake_jobs import _answer, fake  # noqa: F401 - the fake Claude fixture

ANALYSIS = """\
version: 1
items:
  - field: users
    text: Returning buyers on mobile
    evidence_refs: [src:1]
  - field: outcomes
    text: Faster repeat checkout
    evidence_refs: [src:99]
  - field: made_up
    text: ignored
gaps:
  - category: release_rollout
    importance: high
    statement: Is the rollout gated by region?
    evidence_refs: [src:1]
"""


def _runtime(*outcomes: Outcome) -> FakeRuntime:
    rt = FakeRuntime({"read": list(outcomes)})
    set_runtime(rt)
    return rt


@pytest.fixture(autouse=True)
def _swarmcloud_runtime(monkeypatch):
    monkeypatch.setattr(get_settings(), "intake_read_runtime", "swarmcloud")
    yield
    set_runtime(None)


async def _tick(client, ctx, times: int = 3) -> None:
    for _ in range(times):
        resp = await client.post("/v1/internal/tick", headers=ctx.as_("owner"))
        assert resp.status_code == 200, resp.text


async def _new(client, ctx, **body) -> str:
    await make_item(ctx, "commenter", content=PAIN, title="#support thread")
    out = await create_intake(client, ctx, ai_extraction=body.pop("ai_extraction", True), **body)
    return out["intake"]["id"]


async def _runs(ctx) -> list[Run]:
    async with tenant_session(ctx.tenant_id) as s:
        return list(await s.scalars(select(Run).where(Run.flow == "intake_analysis")))


async def _jobs(ctx) -> list[LlmJob]:
    async with tenant_session(ctx.tenant_id) as s:
        return list(await s.scalars(select(LlmJob).where(LlmJob.kind == "intake_analysis")))


# protects=criterion 1: creating an intake with ai_extraction and the company switch on
# creates one intake_analysis run estimated at $1.50, created by the author, bound to the
# intake and its snapshot, and no llm_jobs row; the author's summary says it is running on
# swarmcloud; fails_when=a pool job is queued, the run is someone else's, or the price is
# not analyst at quick; no_claim=what SwarmCloud does with it.
async def test_create_starts_one_quick_run_as_the_author_and_no_job(client):
    ctx = await company()
    _runtime()
    intake_id = await _new(client, ctx)
    [run] = await _runs(ctx)
    assert run.estimate_usd == Decimal("1.50")
    assert run.created_by == ctx.users["commenter"].id
    assert run.knobs["read_intake_id"] == intake_id
    assert run.knobs["intake_snapshot_id"]
    assert "intake_id" not in run.knobs  # never an intake's draft run (C5 would convert it)
    assert run.status == "running"
    assert await _jobs(ctx) == []
    read = (await summary(client, ctx, intake_id, who="commenter"))["ai_read"]
    assert read["state"] in ("queued", "running")
    assert read["path"] == "swarmcloud" and read["run_id"] == str(run.id)
    assert read["sources"] == 1


# protects=criterion 1 (off): ai_extraction false, or the company switch off, starts neither
# a run nor a job, and the summary says off; fails_when=either is created;
# no_claim=the Settings screen.
async def test_off_per_intake_or_for_the_company_starts_nothing(client):
    ctx = await company()
    _runtime()
    intake_id = await _new(client, ctx, ai_extraction=False)
    assert (await summary(client, ctx, intake_id, who="commenter"))["ai_read"]["state"] == "off"
    resp = await client.put(
        "/v1/settings/intake_ai_read", json={"value": False}, headers=ctx.as_("owner")
    )
    assert resp.status_code == 200, resp.text
    intake_id = await _new(client, ctx)
    read = (await summary(client, ctx, intake_id, who="commenter"))["ai_read"]
    assert read["state"] == "off" and read["off_reason"] == "company"
    assert await _runs(ctx) == [] and await _jobs(ctx) == []


# protects=Q2: the company switch defaults on, only owners change it, and it takes a boolean
# only; fails_when=an approver flips it or a string is stored; no_claim=the audit text.
async def test_the_company_switch_is_on_by_default_and_owners_only(client):
    ctx = await company()
    url = "/v1/settings/intake_ai_read"
    got = await client.get(url, headers=ctx.as_("owner"))
    assert got.status_code == 200 and got.json()["value"] is True
    for who in ("viewer", "commenter", "approver"):
        resp = await client.put(url, json={"value": False}, headers=ctx.as_(who))
        assert resp.status_code == 403, who
    resp = await client.put(url, json={"value": "no"}, headers=ctx.as_("owner"))
    assert resp.status_code == 422


# protects=criterion 4 end to end: the fake runtime's analysis.yaml imports through the
# importer as the job's answer did: an unknown field dropped, an unknown src ref dropped and
# counted, every result an AI inference and a private finding; the summary says done on
# swarmcloud with what was added; fails_when=a src:99 ref is kept, results are shared, or the
# path is not recorded; no_claim=the model's quality.
async def test_a_finished_run_imports_its_analysis_as_private_inferences(client):
    ctx = await company()
    _runtime(Outcome(artifacts={"analysis.yaml": ANALYSIS}))
    intake_id = await _new(client, ctx)
    await _tick(client, ctx)
    [run] = await _runs(ctx)
    assert run.status == "succeeded", run.error
    after = await summary(client, ctx, intake_id, who="commenter")
    read = after["ai_read"]
    assert read["state"] == "done" and read["path"] == "swarmcloud"
    assert read["added"] == {"items": 2, "gaps": 1}
    assert read["dropped_refs"] == 1
    users = [i for i in after["extracted"] if i["text"] == "Returning buyers on mobile"]
    [item] = users
    assert item["knowledge_state"] == "ai_inference"
    async with tenant_session(ctx.tenant_id) as s:
        intake = await s.get(ProductIntake, uuid.UUID(intake_id))
        last = intake.analysis["extraction"]["last"]
        assert last["run_id"] == str(run.id) and last["private"] is True
        model = [f for f in intake.analysis["findings"].values() if f["origin"] == "model"]
        assert len(model) == 3 and all(f.get("restricted") is not False for f in model)
    assert await _jobs(ctx) == []
    # Another member sees no read at all (S6).
    assert (await summary(client, ctx, intake_id, who="approver"))["ai_read"] is None


# protects=criterion 2: a repin while a read runs cancels it and starts one on the new
# snapshot; fails_when=two reads run at once or the old snapshot is read again;
# no_claim=SwarmCloud confirming the cancel.
async def test_repin_cancels_the_running_read_and_starts_a_new_one(client):
    ctx = await company()
    _runtime(Outcome(polls=50), Outcome(polls=50))
    intake_id = await _new(client, ctx)
    resp = await client.post(f"/v1/intakes/{intake_id}/repin", headers=ctx.as_("commenter"))
    assert resp.status_code == 200, resp.text
    runs = sorted(await _runs(ctx), key=lambda r: r.created_at)
    assert [r.status for r in runs] == ["cancelled", "running"]
    assert runs[0].knobs["intake_snapshot_id"] != runs[1].knobs["intake_snapshot_id"]
    assert resp.json()["ai_read"]["run_id"] == str(runs[1].id)


# protects=Q3 as amended, criterion 5: SwarmCloud refusing the submission (503) falls back
# to the built-in job for that intake; the job's answer imports and the intake says the job
# produced the read and why; fails_when=the read is left failed with no fallback, or the
# fallback is not said; no_claim=the pool's retry policy.
async def test_a_read_that_cannot_start_falls_back_to_the_built_in_job(client, fake):
    class Refusing(FakeRuntime):
        async def submit(self, spec):
            raise RuntimeUnavailable("agent service unavailable", status=503)

    ctx = await company()
    await add_account(ctx.tenant_id, "personal", windows={"five_hour": window(0.2)})
    fake(_answer)
    set_runtime(Refusing())
    intake_id = await _new(client, ctx)
    await _tick(client, ctx)
    [run] = await _runs(ctx)
    assert run.status in ("failed", "cancelled")
    [job] = await _jobs(ctx)
    assert job.status == "succeeded", job.error_reason
    read = (await summary(client, ctx, intake_id, who="commenter"))["ai_read"]
    assert read["state"] == "done" and read["path"] == "job"
    assert read["fallback"]["code"] == "agent_unavailable"
    assert read["job_id"] == str(job.id)


# protects=criterion 5 (invalid output) under Q3: an analysis.yaml that is not valid imports
# nothing and the read falls back to the job; fails_when=a partial import lands or the run's
# empty result is shown as done; no_claim=the validation message's wording.
async def test_invalid_analysis_imports_nothing_and_falls_back(client, fake):
    ctx = await company()
    await add_account(ctx.tenant_id, "personal", windows={"five_hour": window(0.2)})
    fake(_answer)
    _runtime(Outcome(artifacts={"analysis.yaml": "items: [unclosed"}))
    intake_id = await _new(client, ctx)
    await _tick(client, ctx, times=4)
    [job] = await _jobs(ctx)
    read = (await summary(client, ctx, intake_id, who="commenter"))["ai_read"]
    assert read["path"] == "job" and read["fallback"]["code"] == "invalid_output"
    assert job.status == "succeeded"


# protects=criterion 5 (closed intake): a read finishing after the intake is archived
# imports nothing and notes why; fails_when=findings land on a closed intake;
# no_claim=the converted case's own wording.
async def test_a_read_finishing_after_the_intake_closed_imports_nothing(client):
    ctx = await company()
    _runtime(Outcome(artifacts={"analysis.yaml": ANALYSIS}, polls=1))
    intake_id = await _new(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        intake = await s.get(ProductIntake, uuid.UUID(intake_id))
        intake.status = "archived"
        await s.commit()
    await _tick(client, ctx, times=4)
    async with tenant_session(ctx.tenant_id) as s:
        intake = await s.get(ProductIntake, uuid.UUID(intake_id))
        assert not [i for i in intake.analysis.get("items") or [] if i.get("origin") == "llm"]
        assert intake.analysis["extraction"]["read"]["note"].startswith("Skipped")
    assert await _jobs(ctx) == []


# protects=criterion 6: two failed reads in a row (the fallback job failing too) give the
# author one Inbox row, and a success ends it; fails_when=a row after one failure, two rows,
# a row for someone else, or the row outlives a success; no_claim=the Inbox screen.
async def test_two_failed_reads_in_a_row_make_one_inbox_row_until_a_success(client):
    ctx = await company()
    set_runtime(FakeRuntime({"read": [Outcome(state="failed", error="boom")] * 10}))
    intake_id = await _new(client, ctx)  # no Claude account: the fallback job fails too
    await _tick(client, ctx, times=4)
    read = (await summary(client, ctx, intake_id, who="commenter"))["ai_read"]
    assert read["state"] == "failed" and read["failures"] == 1
    inbox = (await client.get("/v1/inbox", headers=ctx.as_("commenter"))).json()
    assert inbox["intake_reads"] == []
    resp = await client.post(f"/v1/intakes/{intake_id}/ai-read", headers=ctx.as_("commenter"))
    assert resp.status_code == 202, resp.text
    await _tick(client, ctx, times=4)
    inbox = (await client.get("/v1/inbox", headers=ctx.as_("commenter"))).json()
    [row] = inbox["intake_reads"]
    assert row["intake_id"] == intake_id and row["failures"] == 2
    assert (await client.get("/v1/inbox", headers=ctx.as_("owner"))).json()["intake_reads"] == []
    set_runtime(FakeRuntime({"read": [Outcome(artifacts={"analysis.yaml": ANALYSIS})]}))
    resp = await client.post(f"/v1/intakes/{intake_id}/ai-read", headers=ctx.as_("commenter"))
    assert resp.status_code == 202, resp.text
    await _tick(client, ctx)
    inbox = (await client.get("/v1/inbox", headers=ctx.as_("commenter"))).json()
    assert inbox["intake_reads"] == []


# protects=Analyse with Oracle (POST ai-read): the author starts a read (202), 409 while one
# runs, on a closed intake and with the company switch off; every other role, an API token
# and a run token get 403; fails_when=a non-author starts a read or two run at once;
# no_claim=the button's placement (lane 2).
async def test_ai_read_route_roles_and_conflicts(client):
    from tests.test_mcp import run_token

    ctx = await company()
    _runtime(Outcome(polls=50), Outcome(polls=50))
    intake_id = await _new(client, ctx, ai_extraction=False)
    url = f"/v1/intakes/{intake_id}/ai-read"
    for who in ("viewer", "approver", "owner", "token"):
        assert (await client.post(url, headers=ctx.as_(who))).status_code == 403, who
    from oracle.auth.deps import RUN_TOKEN_HEADER

    raw = await run_token(ctx.tenant_id, ["read:baseline"], ctx.users["commenter"].id)
    as_run = {**ctx.as_("commenter"), RUN_TOKEN_HEADER: raw}
    assert (await client.post(url, headers=as_run)).status_code == 403
    resp = await client.post(url, headers=ctx.as_("commenter"))
    assert resp.status_code == 202, resp.text
    assert resp.json()["state"] in ("queued", "running")
    assert (await client.post(url, headers=ctx.as_("commenter"))).status_code == 409
    other = await _new(client, ctx, ai_extraction=False)
    await client.put("/v1/settings/intake_ai_read", json={"value": False},
                     headers=ctx.as_("owner"))  # fmt: skip
    resp = await client.post(f"/v1/intakes/{other}/ai-read", headers=ctx.as_("commenter"))
    assert resp.status_code == 409
    missing = f"/v1/intakes/{uuid.uuid4()}/ai-read"
    assert (await client.post(missing, headers=ctx.as_("commenter"))).status_code == 404


# protects=criterion 7: ORACLE_INTAKE_READ_RUNTIME=job queues the old job and creates no
# run, and the summary reads the job's state on path job; fails_when=a run is created under
# the rollback; no_claim=the job's own behaviour (test_intake_jobs).
async def test_the_rollback_flag_queues_the_old_job(client, monkeypatch):
    ctx = await company()
    monkeypatch.setattr(get_settings(), "intake_read_runtime", "job")
    intake_id = await _new(client, ctx)
    assert await _runs(ctx) == []
    [job] = await _jobs(ctx)
    assert job.status == "queued"
    read = (await summary(client, ctx, intake_id, who="commenter"))["ai_read"]
    assert read["state"] == "queued" and read["path"] == "job" and read["fallback"] is None


# protects=criterion 8: intakes whose queued job the migration cancelled
# (moved_to_swarmcloud) get a read started on the next tick, at most 20 per tick;
# fails_when=more than 20 start in one tick, or a closed intake gets one;
# no_claim=the migration SQL (test_intake_read_migration).
async def test_pending_reads_start_at_most_twenty_per_tick(client):
    ctx = await company()
    _runtime(*[Outcome(polls=50)] * 30)
    ids = [await _new(client, ctx, ai_extraction=False, title=f"Idea {n}") for n in range(22)]
    async with tenant_session(ctx.tenant_id) as s:
        for n, raw in enumerate(ids):
            intake = await s.get(ProductIntake, uuid.UUID(raw))
            intake.analysis = {**intake.analysis, "extraction": {"ai": True}}
            if n == 0:
                intake.status = "archived"
            s.add(LlmJob(kind="intake_analysis", intake_id=intake.id, status="cancelled",
                         error_reason="moved_to_swarmcloud", input={}, attempts=0))  # fmt: skip
        await s.commit()
    async with tenant_session(ctx.tenant_id) as s:
        assert await intake_read.start_pending_reads(s) == 20
    async with tenant_session(ctx.tenant_id) as s:
        assert await intake_read.start_pending_reads(s) == 1
        assert await intake_read.start_pending_reads(s) == 0
    assert len(await _runs(ctx)) == 21


# protects=Q3 at creation: a run that cannot even be created (the runs service refuses)
# still leaves the new intake in place and falls back to the job at once;
# fails_when=the refusal rolls the intake back (500 or a missing intake) or no job is
# queued; no_claim=why the runs service refused.
async def test_a_run_that_cannot_be_created_keeps_the_intake_and_queues_the_job(
    client, monkeypatch
):
    from oracle.runs import service as runs_service

    async def refuse(*args, **kwargs):
        raise runs_service.RunError("refused for the test")

    monkeypatch.setattr(runs_service, "create_run", refuse)
    ctx = await company()
    _runtime()
    intake_id = await _new(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.get(ProductIntake, uuid.UUID(intake_id)) is not None
    [job] = await _jobs(ctx)
    assert job.status == "queued" and str(job.intake_id) == intake_id
    read = (await summary(client, ctx, intake_id, who="commenter"))["ai_read"]
    assert read["path"] == "job" and read["fallback"]["code"] == "agent_unavailable"
    assert await _runs(ctx) == []


# protects=#689 review: the Inbox of a reader with no intake Oracle failed to read twice
# runs no query of its own for the intake-read rows (the check rides on the Inbox's
# last-seen read), so the Inbox stays within MAX_INBOX_READS; and the author with such an
# intake still gets the row; fails_when=a reader with no such intake pays a query for
# them, or the row is lost; no_claim=the Inbox screen.
async def test_the_inbox_reads_intake_rows_only_for_a_reader_who_has_one(client):
    from sqlalchemy import event

    from oracle.db import get_engine

    ctx = await company()
    set_runtime(FakeRuntime({"read": [Outcome(state="failed", error="boom")] * 10}))
    intake_id = await _new(client, ctx)
    await _tick(client, ctx, times=4)
    resp = await client.post(f"/v1/intakes/{intake_id}/ai-read", headers=ctx.as_("commenter"))
    assert resp.status_code == 202, resp.text
    await _tick(client, ctx, times=4)
    statements: list[str] = []

    def count(conn, cursor, statement, *args):
        statements.append(statement)

    def intake_row_queries() -> list[str]:
        return [
            st
            for st in statements
            if st.lstrip().startswith("SELECT product_intakes.")
            and "product_intakes.author_id =" in st
            and "AS INTEGER) >=" in st
        ]

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", count)
    try:
        owner = await client.get("/v1/inbox", headers=ctx.as_("owner"))
        assert owner.status_code == 200 and owner.json()["intake_reads"] == []
        assert intake_row_queries() == []
        author = await client.get("/v1/inbox", headers=ctx.as_("commenter"))
    finally:
        event.remove(engine, "before_cursor_execute", count)
    [row] = author.json()["intake_reads"]
    assert row["intake_id"] == intake_id and row["failures"] == 2
    assert len(intake_row_queries()) == 1


class _SlowRuntime(FakeRuntime):
    """SwarmCloud as the walk found it: each call it makes takes a while."""

    async def features(self, *, refresh: bool = False):
        await asyncio.sleep(0.8)
        return await super().features(refresh=refresh)

    async def find_by_label(self, label, since=None):
        await asyncio.sleep(0.8)
        return await super().find_by_label(label, since)

    async def submit(self, spec):
        await asyncio.sleep(2.5)
        return await super().submit(spec)


# protects=walk-brief item 1: Continue on New PRD answers without waiting on SwarmCloud;
# the read's run is submitted after the response; fails_when=POST /v1/intakes awaits the
# submission (25-28 s on production); no_claim=how long SwarmCloud itself takes.
async def test_create_answers_before_the_read_is_submitted(client):
    ctx = await company()
    set_runtime(_SlowRuntime({"read": []}))
    await make_item(ctx, "commenter", content=PAIN, title="#support thread")
    await seed_company(ctx.tenant_id)
    body = {"title": "Saved addresses", "brief": BRIEF, "ai_extraction": True}
    started = time.monotonic()
    resp = await client.post("/v1/intakes", json=body, headers=ctx.as_("commenter"))
    assert time.monotonic() - started < 2.0
    assert resp.status_code == 201, resp.text
    out = resp.json()
    assert out["ai_read"]["state"] in ("queued", "running")
    await intake_read.drain()
    [run] = await _runs(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        segments = list(await s.scalars(select(RunSegment).where(RunSegment.run_id == run.id)))
    assert any(seg.swarm_workflow_id for seg in segments)


# protects=binding-forgery-deflake: two followers of one refused read (the create request's
# summary and the submission after it, each in its own session) both see it live; the one
# that commits second answers from the first's fallback instead of failing on the stale
# intake row (StaleDataError, a 500 on POST /v1/intakes); fails_when=the second follower
# raises or queues a second job; no_claim=which follower wins.
async def test_two_followers_of_a_refused_read_fall_back_once(client, monkeypatch):
    class Refusing(FakeRuntime):
        async def submit(self, spec):
            raise RuntimeUnavailable("agent service unavailable", status=503)

    ctx = await company()
    set_runtime(Refusing())
    monkeypatch.setattr(intake_read, "submit_later", lambda tenant_id, intake: None)
    intake_id = uuid.UUID(await _new(client, ctx))
    async with tenant_session(ctx.tenant_id) as s:
        intake = await s.get(ProductIntake, intake_id)
        await intake_read.submit(s, intake_read.current(intake))
        await s.commit()
    async with tenant_session(ctx.tenant_id) as first, tenant_session(ctx.tenant_id) as second:
        mine = await first.get(ProductIntake, intake_id)
        theirs = await second.get(ProductIntake, intake_id)
        assert intake_read.current(theirs)["state"] in intake_read.LIVE
        assert await intake_read.sync(first, mine) is True
        await first.commit()
        assert await intake_read.sync(second, theirs) is False
        await second.commit()
        read = intake_read.current(theirs)
    [job] = await _jobs(ctx)
    assert read["path"] == "job" and read["job_id"] == str(job.id)
    assert read["fallback"]["code"] == "agent_unavailable"


async def _refused(client, ctx, monkeypatch) -> uuid.UUID:
    """An intake whose read's run SwarmCloud refused, not followed yet."""

    class Refusing(FakeRuntime):
        async def submit(self, spec):
            raise RuntimeUnavailable("agent service unavailable", status=503)

    set_runtime(Refusing())
    monkeypatch.setattr(intake_read, "submit_later", lambda tenant_id, intake: None)
    intake_id = uuid.UUID(await _new(client, ctx))
    async with tenant_session(ctx.tenant_id) as s:
        intake = await s.get(ProductIntake, intake_id)
        await intake_read.submit(s, intake_read.current(intake))
        await s.commit()
    return intake_id


async def _fallen_back(client, ctx, monkeypatch) -> uuid.UUID:
    """An intake whose refused read fell back to the job, committed."""
    intake_id = await _refused(client, ctx, monkeypatch)
    async with tenant_session(ctx.tenant_id) as s:
        intake = await s.get(ProductIntake, intake_id)
        assert await intake_read.sync(s, intake) is True
        await s.commit()
    return intake_id


# protects=binding-forgery-deflake review: two followers of one failed job both see the
# read live; the one that writes second answers from the first's ending instead of failing
# at its own commit on the stale intake row (a 500 on the summary or the tick);
# fails_when=the second follower's commit raises or the failure is counted twice;
# no_claim=which follower wins.
async def test_two_followers_of_a_failed_job_end_the_read_once(client, monkeypatch):
    ctx = await company()
    intake_id = await _fallen_back(client, ctx, monkeypatch)
    [job] = await _jobs(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        (await s.get(LlmJob, job.id)).status = "failed"
        await s.commit()
    async with tenant_session(ctx.tenant_id) as first, tenant_session(ctx.tenant_id) as second:
        mine = await first.get(ProductIntake, intake_id)
        theirs = await second.get(ProductIntake, intake_id)
        assert intake_read.current(theirs)["state"] in intake_read.LIVE
        assert await intake_read.sync(first, mine) is True
        await first.commit()
        assert await intake_read.sync(second, theirs) is False
        await second.commit()
        read = intake_read.current(theirs)
        failures = theirs.analysis["extraction"]["failures"]
    assert read["state"] == "failed"
    assert failures == 1


# protects=binding-forgery-deflake review: a follower that loses the race undoes only its
# own changes; what its caller added to the session before following stays and is
# committed; fails_when=the caller's earlier, uncommitted work is rolled back with the
# follower's; no_claim=which follower wins.
async def test_a_follower_that_loses_the_race_keeps_its_callers_work(client, monkeypatch):
    ctx = await company()
    intake_id = await _refused(client, ctx, monkeypatch)
    async with tenant_session(ctx.tenant_id) as first, tenant_session(ctx.tenant_id) as second:
        mine = await first.get(ProductIntake, intake_id)
        theirs = await second.get(ProductIntake, intake_id)
        assert await intake_read.sync(first, mine) is True
        await first.commit()
        await audit.record(second, audit.ORACLE, "example.before_follow", "intake", intake_id)
        assert await intake_read.sync(second, theirs) is False
        await second.commit()
    async with tenant_session(ctx.tenant_id) as s:
        actions = list(
            await s.scalars(
                select(AuditEvent.action).where(AuditEvent.action == "example.before_follow")
            )
        )
    assert actions == ["example.before_follow"]
