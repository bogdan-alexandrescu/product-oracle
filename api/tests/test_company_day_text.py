"""#463: days the API writes into text a person reads are the Company time zone's day
(#401, #447 follow-up), through one helper beside ``company_time.in_words``.

Test card (test_company_day_text, every test below): protects=the owner's rule that every
date a person sees uses the Company time zone; fails_when=a note, label, notice or Inbox
line names the UTC day when the Company day differs, or a text builder words a day on
its own instead of through ``company_time``; no_claim=machine fields (ISO timestamps,
ids), which stay UTC, or how the web formats dates (#447).

Runs against Postgres with the FakeRuntime. Synthetic placeholders only.
"""

import inspect
import uuid
from datetime import UTC, date, datetime

import pytest

from oracle import company_time
from oracle.baseline import describe
from oracle.discussions import service as discussions
from oracle.runs import reuse
from oracle.runs import service as runs
from oracle.runs.models import Checkpoint, Run
from oracle.swarm import FakeRuntime, set_runtime
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.intake_helpers import intake_with_source

AUCKLAND = "Pacific/Auckland"


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


async def company_zone(client, ctx, zone: str) -> None:
    resp = await client.put(
        "/v1/settings/company_timezone", json={"value": zone}, headers=ctx.as_("owner")
    )
    assert resp.status_code == 200, resp.text


# --------------------------------------------------------------------------- the helper


def test_the_day_is_the_company_day():
    late = datetime(2026, 10, 12, 20, 0, tzinfo=UTC)
    assert company_time.day(late, AUCKLAND) == date(2026, 10, 13)
    assert company_time.day_in_words(late, AUCKLAND) == "Oct 13"
    assert company_time.day_in_words(late, "America/Los_Angeles") == "Oct 12"
    # An ISO string (a knob's stored moment) and a naive moment (read as UTC) both work.
    assert company_time.day_in_words(late.isoformat(), AUCKLAND) == "Oct 13"
    assert company_time.day_in_words(late.replace(tzinfo=None), AUCKLAND) == "Oct 13"
    # A zone that no longer reads falls back to the default zone, never UTC.
    assert company_time.day_in_words(datetime(2026, 10, 13, 3, tzinfo=UTC), "Nowhere/X") == (
        "Oct 12"
    )


# --------------------------------------------------------------------------- Done when


async def test_the_reuse_note_and_banner_name_the_company_day(client, runtime, monkeypatch):
    # A fixed approval moment: any age is reusable here (the 30-day rule has its own tests).
    monkeypatch.setattr(reuse, "REUSE_DAYS", 100_000)
    ctx = await make_ctx()
    await company_zone(client, ctx, AUCKLAND)
    async with tenant_session(ctx.tenant_id) as s:
        run = Run(flow="baseline", status="succeeded", knobs={})
        s.add(run)
        await s.flush()
        s.add(
            Checkpoint(
                run_id=run.id,
                kind="baseline_confirm",
                status="approved",
                approver_role="approver",
                decided_at=datetime(2026, 10, 12, 20, 0, tzinfo=UTC),
            )
        )
        await s.commit()
    out = await intake_with_source(client, ctx)
    resp = await client.post(
        f"/v1/intakes/{out['intake']['id']}/runs",
        json={"document": "saved-addresses", "reuse_baseline": None},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 201, resp.text
    run_id = resp.json()["id"]

    resp = await client.post(f"/v1/runs/{run_id}/estimate", headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text
    banner = {r["name"]: r for r in resp.json()["segments"]}["baseline"]["note"]
    assert banner == "Current baseline, approved Oct 13"

    resp = await client.post(f"/v1/runs/{run_id}/start", headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text
    started = resp.json()
    assert started["segments"][0]["note"] == "Reused the baseline approved Oct 13"
    [spec] = runtime.submitted
    assert "The baseline was reviewed and approved on Oct 13;" in spec.steps[0].prompt
    # The knob keeps the machine moment in UTC.
    assert started["segments"][0]["reused"]["approved_at"].startswith("2026-10-12T20:00")


async def test_a_runs_proposals_are_labelled_with_the_company_day(client):
    ctx = await make_ctx()
    await company_zone(client, ctx, AUCKLAND)
    async with tenant_session(ctx.tenant_id) as s:
        run = Run(
            flow="baseline",
            status="running",
            created_by=ctx.users["owner"].id,
            created_at=datetime(2026, 10, 20, 23, 30, tzinfo=UTC),
        )
        s.add(run)
        await s.commit()
        run_id = run.id
    body = {
        "op": "create",
        "kind": "entity",
        "fields": {"type": "feature", "key": "late-run", "title": "Late run"},
        "run_id": str(run_id),
    }
    resp = await client.post("/v1/baseline/proposals", json=body, headers=ctx.as_("commenter"))
    assert resp.status_code == 201, resp.text
    resp = await client.get("/v1/baseline/proposals", headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    [made] = [p for p in resp.json() if p["run_id"] == str(run_id)]
    assert made["proposer"] == {
        "kind": "run",
        "label": "Build the baseline · Oct 21",
        "run_id": str(run_id),
        "user_id": None,
        "email": None,
    }


# --------------------------------------------------------------------------- every builder

# Each API text builder that names a day or a time for a person to read. A new one joins
# this list and words its day through ``company_time``. Not here: a section's due day
# (review/collab.py), a picked calendar day the web stores at 17:00 UTC, so its UTC date
# is the day picked.
DAY_TEXT_BUILDERS = [
    (reuse.short_date, "day_in_words"),  # run notes, the reuse banner, the run prompt
    (describe.run_label, "day_in_words"),  # proposal sources
    (discussions._make_open, "day_in_words"),  # "… made this discussion open on Oct 13"
    (runs._source_context, "day_in_words"),  # "this PRD's approved order of …"
]


@pytest.mark.parametrize(
    ("builder", "helper"), DAY_TEXT_BUILDERS, ids=lambda v: getattr(v, "__name__", v)
)
def test_each_day_text_builder_goes_through_the_helper(builder, helper):
    source = inspect.getsource(builder)
    assert f"company_time.{helper}" in source, builder.__qualname__
    # It never words the day itself: no strftime, no "%b" of its own, no UTC .date().
    for own in ("strftime", ":%b", ":%Y", ".date()"):
        assert own not in source, (builder.__qualname__, own)


def test_short_date_takes_the_company_zone():
    at = datetime(2026, 10, 12, 20, 0, tzinfo=UTC)
    assert reuse.short_date(at, AUCKLAND) == "Oct 13"
    assert reuse.short_date(at.isoformat(), "America/Los_Angeles") == "Oct 12"


def test_run_label_takes_the_company_zone():
    from oracle.baseline.schemas import ProposalRun

    run = ProposalRun(
        id=uuid.uuid4(),
        flow="baseline",
        flow_title="Build the baseline",
        status="running",
        created_at=datetime(2026, 10, 20, 23, 30, tzinfo=UTC),
    )
    assert describe.run_label(run, AUCKLAND) == "Build the baseline · Oct 21"
    assert describe.run_label(run, "America/Los_Angeles") == "Build the baseline · Oct 20"
