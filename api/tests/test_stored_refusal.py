"""#556 item 2: a refusal stored before #403's wording reads the way #403 writes one now."""

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from oracle.claude_accounts.pool import readable_refusal
from oracle.docs.models import Document, DocumentVersion
from oracle.engineering.models import CodeMap
from oracle.jobs.models import LlmJob
from oracle.roadmap.models import DraftRoadmap
from oracle.runs.models import Run, RunSegment
from oracle.tenancy import tenant_session
from oracle.tenant_settings_api import DEFAULTS
from tests.baseline_helpers import make_ctx
from tests.conftest import make_tenant
from tests.connection_helpers import make_person
from tests.test_code_maps import github_source, request_map
from tests.test_draft_roadmaps import new_version, person
from tests.test_draft_roadmaps import read as read_items
from tests.test_draft_roadmaps import rows as draft_rows
from tests.test_interviews import create as create_interview
from tests.test_interviews import get as get_interview
from tests.test_llm_jobs import SLUG, V, ctx, import_draft, jobs  # noqa: F401
from tests.test_runs import create, owner, runtime  # noqa: F401

# What a reporting job stored before #403: the earliest reset as raw UTC ISO.
OLD = (
    "No Claude account can take this call: every Claude account is spent; "
    "the earliest window clears 2026-10-25T22:00:00.475990+00:00"
)
NOW = (
    "No Claude account can take this call: every Claude account is spent; "
    "the earliest window clears Sun Oct 25, 3:00 PM PDT."
)
# The same refusal on something that failed: it says what was so then, not now (#561 review).
PAST = (
    "No Claude account could take this call: every Claude account was spent; "
    "the earliest window was due to clear Sun Oct 25, 3:00 PM PDT."
)
FAILED_AT = datetime(2026, 10, 18, 23, 12, tzinfo=UTC)


@pytest.fixture(autouse=True)
def company_in_los_angeles(monkeypatch):
    monkeypatch.setitem(DEFAULTS, "company_timezone", "America/Los_Angeles")


def test_a_raw_utc_time_reads_in_words_in_the_company_zone():
    assert readable_refusal(OLD, "America/Los_Angeles") == NOW
    assert readable_refusal(OLD, "Europe/London").endswith("clears Sun Oct 25, 10:00 PM GMT.")


def test_text_already_in_words_ends_its_sentence_once():
    assert readable_refusal(NOW, "America/Los_Angeles") == NOW
    paused = "No Claude account can take this call: every Claude account is paused"
    assert readable_refusal(paused, "America/Los_Angeles") == paused + "."


def test_other_errors_keep_their_words_but_lose_raw_times():
    assert readable_refusal(None, "America/Los_Angeles") is None
    assert readable_refusal("The model's answer was not JSON", "UTC") == (
        "The model's answer was not JSON"
    )
    assert readable_refusal("Rate limited until 2026-10-18T23:12:00Z", "America/Los_Angeles") == (
        "Rate limited until Sun Oct 18, 4:12 PM PDT"
    )


async def test_a_reports_row_and_the_jobs_list_show_a_stored_refusal_rewritten(client, ctx):  # noqa: F811
    await import_draft(client, ctx)
    async with tenant_session(ctx["tenant_id"]) as s:
        doc = (await s.execute(select(Document).where(Document.slug == SLUG))).scalar_one()
        version = (
            await s.execute(select(DocumentVersion).where(DocumentVersion.document_id == doc.id))
        ).scalar_one()
        for j in (await s.execute(select(LlmJob))).scalars():
            await s.delete(j)
        s.add(
            LlmJob(
                kind="reporting",
                document_id=doc.id,
                version_id=version.id,
                status="failed",
                attempts=1,
                error=OLD,
                error_reason="no_account_available",
                next_reset_at=datetime(2026, 10, 25, 22, tzinfo=UTC),
                finished_at=datetime(2026, 10, 18, 23, 12, tzinfo=UTC),
            )
        )
        await s.commit()

    reports = (await client.get(V(1, "/reports"), headers=ctx["headers"])).json()
    assert reports["latest_job"]["error"] == PAST
    assert [j["error"] for j in await jobs(client, ctx)] == [PAST]
    # The row stays as stored: the rewrite is at read time.
    async with tenant_session(ctx["tenant_id"]) as s:
        assert (await s.execute(select(LlmJob.error))).scalar_one() == OLD


def test_a_failed_items_refusal_reads_in_the_past():
    assert readable_refusal(OLD, "America/Los_Angeles", past=True) == PAST
    assert readable_refusal(NOW, "America/Los_Angeles", past=True) == PAST
    other = "No other Claude account can take this call (exhausted): every Claude account is "
    assert readable_refusal(other + "paused, draining or needs a sign-in", past=True) == (
        "No other Claude account could take this call (exhausted): every Claude account was "
        "paused, draining or needed a sign-in."
    )
    assert readable_refusal(
        "No Claude account can take this call: no Claude account has a recent usage reading; "
        "the next sweep reads them",
        past=True,
    ) == (
        "No Claude account could take this call: no Claude account had a recent usage "
        "reading; the next sweep was due to read them."
    )
    assert (
        readable_refusal(
            "No Claude account can take this call: no Claude account is registered", past=True
        )
        == "No Claude account could take this call: no Claude account was registered."
    )
    # Anything else keeps its words.
    assert readable_refusal("The model's answer was not JSON", past=True) == (
        "The model's answer was not JSON"
    )


def test_text_that_only_looks_like_a_time_passes_through_unchanged():
    quoted = "The model wrote 2026-13-40T99:99Z where a date goes"
    assert readable_refusal(quoted, "America/Los_Angeles") == quoted
    assert readable_refusal(quoted, "America/Los_Angeles", past=True) == quoted


def test_a_time_with_no_offset_is_read_as_utc():
    assert readable_refusal("Rate limited until 2026-10-18T23:12", "America/Los_Angeles") == (
        "Rate limited until Sun Oct 18, 4:12 PM PDT"
    )


async def test_a_queued_jobs_wait_stays_in_the_present(client, ctx):  # noqa: F811
    await import_draft(client, ctx)
    async with tenant_session(ctx["tenant_id"]) as s:
        doc = (await s.execute(select(Document).where(Document.slug == SLUG))).scalar_one()
        for j in (await s.execute(select(LlmJob))).scalars():
            await s.delete(j)
        s.add(
            LlmJob(
                kind="reporting",
                document_id=doc.id,
                status="queued",
                attempts=1,
                error=f"{OLD}; retrying",
                error_reason="no_account_available",
            )
        )
        await s.commit()
    assert [j["error"] for j in await jobs(client, ctx)] == [f"{NOW[:-1]}; retrying."]


async def test_a_failed_run_and_segment_read_their_refusal_in_the_past(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    run = await create(client, auth)
    async with tenant_session(tenant_id) as s:
        row = await s.get(Run, uuid.UUID(run["id"]))
        row.status, row.error, row.finished_at = "failed", OLD, FAILED_AT
        segment = (
            (await s.execute(select(RunSegment).where(RunSegment.run_id == row.id)))
            .scalars()
            .first()
        )
        segment.status, segment.error, segment.finished_at = "failed", OLD, FAILED_AT
        await s.commit()
    body = (await client.get(f"/v1/runs/{run['id']}", headers=auth)).json()
    assert body["error"] == PAST
    assert [x["error"] for x in body["segments"] if x["error"]] == [PAST]
    listed = (await client.get("/v1/runs", headers=auth)).json()
    assert [r["error"] for r in listed if r["id"] == run["id"]] == [PAST]


async def test_a_running_segments_wait_stays_in_the_present(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    run = await create(client, auth)
    async with tenant_session(tenant_id) as s:
        segment = (
            (await s.execute(select(RunSegment).where(RunSegment.run_id == uuid.UUID(run["id"]))))
            .scalars()
            .first()
        )
        segment.status, segment.error = "running", OLD
        await s.commit()
    body = (await client.get(f"/v1/runs/{run['id']}", headers=auth)).json()
    assert [x["error"] for x in body["segments"] if x["error"]] == [NOW]


async def test_failed_roadmap_items_read_the_refusal_in_the_past(client, owner, runtime):  # noqa: F811
    tenant_id, _ = owner
    _, headers = await person(tenant_id, "approver")
    await new_version(client, headers, 1)
    async with tenant_session(tenant_id) as s:
        row = await s.get(DraftRoadmap, (await draft_rows(tenant_id))[1].id)
        row.status, row.error = "failed", OLD
        await s.commit()
    body = await read_items(client, headers, 1)
    assert body["status"] == "failed" and body["error"] == PAST


def test_a_refusal_after_a_lead_in_reads_in_the_past_too():
    # As runs.service writes a draft's failure: "{segment}: {error}" (#604 re-review).
    assert readable_refusal(f"Draft: {OLD}", "America/Los_Angeles", past=True) == f"Draft: {PAST}"
    assert readable_refusal(f"Draft: {OLD}", "America/Los_Angeles") == f"Draft: {NOW}"


@pytest.fixture
async def members():
    return await make_ctx()


async def test_a_failed_interview_guide_says_when_it_failed_the_refusal_in_the_past(
    client, members
):
    iv = await create_interview(client, members)
    async with tenant_session(members.tenant_id) as s:
        job = await s.get(LlmJob, uuid.UUID(iv["guide_job"]["id"]))
        job.status, job.error, job.finished_at = "failed", OLD, FAILED_AT
        await s.commit()
    guide = (await get_interview(client, members, iv["id"]))["guide_job"]
    assert guide["status"] == "failed" and guide["error"] == PAST
    assert datetime.fromisoformat(guide["finished_at"]) == FAILED_AT


async def test_a_queued_interview_guides_wait_stays_in_the_present(client, members):
    iv = await create_interview(client, members)
    async with tenant_session(members.tenant_id) as s:
        job = await s.get(LlmJob, uuid.UUID(iv["guide_job"]["id"]))
        job.error = OLD
        await s.commit()
    guide = (await get_interview(client, members, iv["id"]))["guide_job"]
    assert guide["status"] == "queued" and guide["error"] == NOW
    assert guide["finished_at"] is None


async def test_a_failed_triage_says_its_refusal_in_the_past(client, members):
    # As runs.service stores a run's failure: "{segment}: {error}" (#633 re-review).
    async with tenant_session(members.tenant_id) as s:
        s.add(
            Run(
                flow="request_triage",
                status="failed",
                error=f"triage: {OLD}",
                finished_at=FAILED_AT,
            )
        )
        await s.commit()
    resp = await client.get("/v1/requests/triage", headers=members.as_("viewer"))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["error"] == f"triage: {PAST}"
    assert datetime.fromisoformat(body["finished_at"]) == FAILED_AT


async def test_a_running_triages_wait_stays_in_the_present(client, members):
    async with tenant_session(members.tenant_id) as s:
        s.add(Run(flow="request_triage", status="running", error=f"triage: {OLD}"))
        await s.commit()
    body = (await client.get("/v1/requests/triage", headers=members.as_("viewer"))).json()
    assert body["error"] == f"triage: {NOW}"


async def test_a_failed_code_map_says_when_it_failed_the_refusal_in_the_past(client):
    # codemaps.end_builds stores "The code map run failed: {run.error}" (#633 re-review).
    tenant_id = await make_tenant()
    dev = await make_person(tenant_id, "dev@example.com", "owner")
    source_id = await github_source(tenant_id, dev)
    out = (await request_map(client, dev, source_id)).json()
    stored = f"The code map run failed: index: {OLD}"
    async with tenant_session(tenant_id) as s:
        row = await s.get(CodeMap, uuid.UUID(out["id"]))
        run = await s.get(Run, row.run_id)
        run.status, run.error, run.finished_at = "failed", f"index: {OLD}", FAILED_AT
        row.status, row.error = "failed", stored
        await s.commit()
    got = (await client.get(f"/v1/code-maps/{out['id']}", headers=dev.headers)).json()
    assert got["error"] == f"The code map run failed: index: {PAST}"
    assert datetime.fromisoformat(got["failed_at"]) == FAILED_AT
    listed = (await client.get("/v1/code-maps", headers=dev.headers)).json()
    assert [(m["error"], m["failed_at"] is not None) for m in listed] == [(got["error"], True)]
