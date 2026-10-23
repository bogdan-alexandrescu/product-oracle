"""#463: days the API writes into text a person reads are the Company time zone's day
(#401, #447 follow-up), through one helper beside ``company_time.in_words``.

Test card (test_company_day_text, every test below): protects=the owner's rule that every
date a person sees uses the Company time zone; fails_when=a note, label, notice or Inbox
line names the UTC day when the Company day differs, or a text builder words a day on
its own instead of through ``company_time``; no_claim=machine fields (ISO timestamps,
ids), which stay UTC, or how the web formats dates (#447).

Runs against Postgres with the FakeRuntime. Synthetic placeholders only.
"""

import ast
import re
import uuid
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import select

import oracle
from oracle import company_time
from oracle.baseline import describe
from oracle.runs import reuse
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

# Every place under ``api/oracle`` that words a day or a time itself: ``strftime``, a
# ``%Y-%m-%d`` (or any ``%``) format, ``.date().isoformat()`` and ``.date()`` inside an
# f-string. Text a person reads goes through ``company_time`` instead and so is no hit;
# each hit left is named here, by file and function, with why it stays as it is. A new
# hit fails the scan until it goes through the helper or is named here with its reason.
ORACLE = Path(oracle.__file__).parent
HELPERS = {"company_time.py"}
EXCEPTIONS = {
    ("reports/alignment.py", "short_day"): "words a date already in the Company zone",
    ("priorities/service.py", "_cited_as"): "machine field: a citation's ISO date",
    ("requests/triage.py", "prompt_lines"): "agent prompt, labelled UTC",
    ("requests/triage.py", "daily_due"): "machine field: the triage_day knob",
    ("requests/triage.py", "daily"): "machine field: the triage_day knob",
    ("rituals/blocks.py", "outcomes_due"): "machine field: compared with stored ISO days",
    ("review/collab.py", "set_assignment"): (
        "a section's due day: a picked calendar day the web stores at 17:00 UTC, so its UTC "
        "date is the day picked"
    ),
    ("roadmap/diff.py", "_day"): "a milestone's calendar date as the agents wrote it",
    ("runs/reasons.py", "_day"): "a milestone's calendar date as the agents wrote it",
    ("sources/connectors/slack.py", "_thread"): "source item text the agents read",
}


def _date_hits(path: Path) -> list[tuple[str, int, str]]:
    """(function, line, what) for each place in ``path`` that words a day or time."""
    tree = ast.parse(path.read_text())
    where: dict[int, str] = {}
    for fn in ast.walk(tree):
        if isinstance(fn, ast.FunctionDef | ast.AsyncFunctionDef):
            for n in ast.walk(fn):
                where[id(n)] = fn.name  # the innermost function wins (walked last)
    hits = []

    def hit(n: ast.AST, what: str) -> None:
        hits.append((where.get(id(n), "<module>"), n.lineno, what))

    def is_call(n: ast.AST, attr: str) -> bool:
        return (
            isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and (n.func.attr == attr)
        )

    for n in ast.walk(tree):
        if isinstance(n, ast.Attribute) and n.attr == "strftime":
            hit(n, "strftime")
        elif isinstance(n, ast.Constant) and isinstance(n.value, str):
            if "%Y-%m-%d" in n.value or re.search(r"\{[^{}]*:%", n.value):
                hit(n, "a date format")
        elif isinstance(n, ast.FormattedValue) and n.format_spec is not None:
            spec = "".join(v.value for v in n.format_spec.values if isinstance(v, ast.Constant))
            if "%" in spec:
                hit(n, f"f-string format {spec}")
        elif is_call(n, "isoformat") and is_call(n.func.value, "date"):
            hit(n, ".date().isoformat()")
        elif isinstance(n, ast.JoinedStr):
            for v in n.values:
                if isinstance(v, ast.FormattedValue):
                    for m in ast.walk(v.value):
                        if is_call(m, "date") and not m.args:
                            hit(m, ".date() in an f-string")
    return hits


def _all_hits() -> dict[tuple[str, str], list[str]]:
    out: dict[tuple[str, str], list[str]] = {}
    for path in sorted(ORACLE.rglob("*.py")):
        rel = path.relative_to(ORACLE).as_posix()
        if rel in HELPERS:
            continue
        for fn, line, what in _date_hits(path):
            out.setdefault((rel, fn), []).append(f"{rel}:{line} {what}")
    return out


def test_every_api_text_builder_words_its_days_through_the_helper():
    hits = _all_hits()
    unnamed = [h for key, found in hits.items() if key not in EXCEPTIONS for h in found]
    assert unnamed == [], "word these through company_time, or name them in EXCEPTIONS"
    # An exception whose hit is gone is dropped from the list.
    assert sorted(set(EXCEPTIONS) - set(hits)) == []


def test_the_scan_finds_each_way_of_wording_a_day(tmp_path):
    """The scan itself: each pattern is a hit, the helper's words are not."""
    src = tmp_path / "builder.py"
    src.write_text(
        "def a(at):\n    return at.strftime('%d %b')\n"
        "def b(at):\n    return f'on {at:%Y-%m-%d}'\n"
        "def c(at):\n    return at.date().isoformat()\n"
        "def d(at):\n    return f'on {at.date()}'\n"
        "def e(at):\n    return 'on {:%b %d}'.format(at)\n"
        "def f(at, zone):\n    return company_time.day(at, zone).isoformat()\n"
        "def g(at, zone):\n    return f'on {company_time.day_in_words(at, zone)}'\n"
    )
    assert {fn for fn, _, _ in _date_hits(src)} == {"a", "b", "c", "d", "e"}


# --------------------------------------------------------------------------- #463 fixes 1

LATE = datetime(2026, 10, 12, 20, 0, tzinfo=UTC)  # Oct 13, 09:00 NZDT in Auckland


def test_the_helper_words_a_moment_with_the_zones_short_name():
    assert company_time.stamp(LATE, AUCKLAND) == "2026-10-13 09:00 NZDT"
    assert company_time.stamp(LATE, "America/Los_Angeles") == "2026-10-12 13:00 PDT"
    assert company_time.stamp(LATE.replace(tzinfo=None), AUCKLAND) == "2026-10-13 09:00 NZDT"
    assert company_time.day_first_in_words(LATE, AUCKLAND) == "13 Oct"
    assert company_time.day_first_in_words(LATE, "America/Los_Angeles") == "12 Oct"


def test_the_spec_sources_name_the_company_day_of_the_prd_approval():
    from oracle.specs import contract

    inputs = contract.SpecInputs(
        slug="saved-addresses-spec",
        title="Saved addresses",
        depth="brief",
        prd_slug="saved-addresses",
        prd_title="Saved addresses PRD",
        prd_version=2,
        sections=(),
        requirements=(),
        prd_approved_at=LATE,
        zone=AUCKLAND,
    )
    assert "PRD saved-addresses version 2, approved 2026-10-13." in contract._sources_body(inputs)


def test_review_yaml_names_the_company_day_it_was_sent_back():
    from oracle.runs import review_file
    from tests.test_review_file import _full

    lines = review_file.render_yaml(_full(), LATE, AUCKLAND).splitlines()
    assert lines[1] == (
        "# Sent back by an approver on 2026-10-13. Apply each entry; answer each in resolutions."
    )


async def test_the_served_review_yaml_names_the_company_day(client):
    """The run page reads review.yaml through the file route and the draft read."""
    from tests.test_review_file import _full

    ctx = await make_ctx()
    await company_zone(client, ctx, AUCKLAND)
    async with tenant_session(ctx.tenant_id) as s:
        run = Run(flow="baseline", status="running", knobs={})
        s.add(run)
        await s.flush()
        cp = Checkpoint(
            run_id=run.id,
            kind="roadmap_items",
            status="changes_requested",
            approver_role="approver",
            decided_at=LATE,
            review=_full(),
        )
        s.add(cp)
        await s.commit()
        base = f"/v1/runs/{run.id}/checkpoints/{cp.id}"
    sent = "# Sent back by an approver on 2026-10-13."
    resp = await client.get(f"{base}/review.yaml", headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    assert resp.text.splitlines()[1].startswith(sent)
    resp = await client.get(f"{base}/review", headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    assert resp.json()["sent_review_yaml"].splitlines()[1].startswith(sent)


def test_the_export_dates_are_the_company_time_with_its_short_name():
    from oracle.export import render

    assert render._format_dt(LATE, AUCKLAND) == "2026-10-13 09:00 NZDT"
    assert render._format_dt(None, AUCKLAND) == ""


def test_the_ritual_pre_read_is_due_in_the_company_time():
    from oracle.rituals import blocks

    md = blocks.markdown("Weekly product review", LATE, [], AUCKLAND)
    assert "Due 2026-10-13 09:00 NZDT" in md.splitlines()
    assert "UTC" not in md


async def test_blocker_gate_rationales_name_the_company_day(client):
    from oracle.blockers.readiness import critical_blockers
    from oracle.readiness import ReadinessContext
    from oracle.v2 import models as m
    from tests.blocker_helpers import create_blocker, make_document

    ctx = await make_ctx()
    await company_zone(client, ctx, AUCKLAND)
    # 20:00 UTC thirty days out: the next day in Auckland.
    soon = datetime.combine(date.today() + timedelta(days=30), time(20), tzinfo=UTC)
    soon_day = soon.astimezone(ZoneInfo(AUCKLAND)).date().isoformat()
    assert soon_day != soon.date().isoformat()

    async def rationale(doc_id) -> str:
        async with tenant_session(ctx.tenant_id) as s:
            out = await critical_blockers(ReadinessContext(s, doc_id, purpose="publish"))
            return out.rationale

    # An accepted risk: until its review day, then past it.
    doc_id = await make_document(ctx, "risk-doc")
    b = (await create_blocker(client, ctx, key="risky", document_ids=[str(doc_id)]))["blocker"]
    resp = await client.post(
        f"/v1/blockers/{b['id']}/accept-risk",
        json={"reason": "Pilot volume stays low", "review_at": soon.isoformat()},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 200, resp.text
    assert f"until {soon_day}" in await rationale(doc_id)
    async with tenant_session(ctx.tenant_id) as s:
        decision = (await s.scalars(select(m.AssumptionDecision))).one()
        decision.review_at = LATE
        await s.commit()
    assert "past its review date (2026-10-13)" in await rationale(doc_id)

    # A feasibility scope: until its decision gate, then past it.
    doc_id = await make_document(ctx, "scope-doc")
    b = (await create_blocker(client, ctx, key="scoped", document_ids=[str(doc_id)]))["blocker"]
    exp = await client.post(
        f"/v1/blockers/{b['id']}/experiments",
        json={
            "hypothesis": "Batching halves calls",
            "success_threshold": "Under 50 a minute",
            "owner_id": str(ctx.users["approver"].id),
            "decision_gate_at": soon.isoformat(),
        },
        headers=ctx.as_("approver"),
    )
    assert exp.status_code in (200, 201), exp.text
    resp = await client.post(
        f"/v1/blockers/{b['id']}/feasibility-scope",
        json={"experiment_id": exp.json()["id"], "reason": "One pilot only"},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 200, resp.text
    assert f"until {soon_day}" in await rationale(doc_id)
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(m.FeasibilityExperiment, uuid.UUID(exp.json()["id"]))
        row.decision_gate_at = LATE
        await s.commit()
    assert "passed its decision gate (2026-10-13)" in await rationale(doc_id)


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


def test_the_deck_banner_names_the_company_time():
    from oracle.docs.models import Document, DocumentVersion
    from oracle.export import deck
    from oracle.export.render import ExportVersion

    doc = Document(slug="saved-addresses", title="Saved addresses PRD", kind="prd")
    version = DocumentVersion(number=2, approved_at=LATE, created_at=LATE)
    ev = ExportVersion(
        document=doc, version=version, sections=[], citations=[], latest_number=2, zone=AUCKLAND
    )
    assert "approved 2026-10-13 09:00 NZDT" in deck._banner(ev)


# --------------------------------------------------------------------------- #463 fixes 2


async def test_the_documents_blocker_section_names_the_company_day(client):
    """The blocker module a published document carries: "Risk accepted until", "Review
    date" and "Decision gate" name the Company day the gate rationale names."""
    from tests.blocker_helpers import create_blocker, make_document

    ctx = await make_ctx()
    await company_zone(client, ctx, AUCKLAND)
    # 20:00 UTC thirty days out: the next day in Auckland.
    soon = datetime.combine(date.today() + timedelta(days=30), time(20), tzinfo=UTC)
    soon_day = company_time.day(soon, AUCKLAND).isoformat()
    assert soon_day != soon.date().isoformat()

    doc_id = await make_document(ctx, "gate-doc")
    risky = await create_blocker(client, ctx, key="risky", document_ids=[str(doc_id)])
    resp = await client.post(
        f"/v1/blockers/{risky['blocker']['id']}/accept-risk",
        json={"reason": "Pilot volume stays low", "review_at": soon.isoformat()},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 200, resp.text
    scoped = await create_blocker(client, ctx, key="scoped", document_ids=[str(doc_id)])
    exp = await client.post(
        f"/v1/blockers/{scoped['blocker']['id']}/experiments",
        json={
            "hypothesis": "Batching halves calls",
            "success_threshold": "Under 50 a minute",
            "decision_gate_at": soon.isoformat(),
        },
        headers=ctx.as_("approver"),
    )
    assert exp.status_code in (200, 201), exp.text

    resp = await client.get(
        "/v1/documents/gate-doc/blocker-strategy/render", headers=ctx.as_("viewer")
    )
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert f"Risk accepted until {soon_day}" in out["brief_markdown"]
    assert f"- **Review date:** {soon_day}" in out["full_markdown"]
    assert f"Decision gate: {soon_day}." in out["full_markdown"]


def _reports():
    from oracle.jobs.schemas import ChangesReport, NewSource, VersionReports

    return VersionReports(
        document_id=uuid.uuid4(),
        version=2,
        generated_at=LATE,
        changes=ChangesReport(
            since=1,
            summary="The problem is sharper.",
            sections=[],
            new_sources=[NewSource(title="Invite funnel, October", kind="file", added_at=LATE)],
        ),
    )


def test_the_version_reports_name_the_company_time():
    from oracle.docs.models import Document
    from oracle.jobs import service as jobs

    doc = Document(slug="saved-addresses", title="Saved addresses PRD", kind="prd")
    md = jobs.reports_markdown(doc, _reports(), AUCKLAND)
    assert "Product Oracle · saved-addresses · version 2 · generated 2026-10-13 09:00 NZDT" in md
    assert "- Invite funnel, October, file, added 2026-10-13" in md
    assert "UTC" not in md


async def test_the_reports_download_names_the_company_time(client):
    """The download the version page offers, in the zone the company saved."""
    from oracle.docs.models import DocumentVersion
    from oracle.jobs.models import LlmJob
    from tests.test_llm_jobs import DRAFT_V1, SLUG, import_draft

    ctx = await make_ctx()
    await company_zone(client, ctx, AUCKLAND)
    await import_draft(client, {"headers": ctx.as_("owner")}, DRAFT_V1)
    reports = _reports()
    async with tenant_session(ctx.tenant_id) as s:
        version = (await s.scalars(select(DocumentVersion))).one()
        s.add(
            LlmJob(
                kind="reporting",
                document_id=version.document_id,
                version_id=version.id,
                status="succeeded",
                output={
                    "resolution": {"summary": "Nothing was open.", "counts": {}, "items": []},
                    "changes": reports.changes.model_dump(mode="json"),
                },
                finished_at=LATE,
            )
        )
        await s.commit()
    resp = await client.get(
        f"/v1/documents/{SLUG}/versions/1/reports/export", headers=ctx.as_("viewer")
    )
    assert resp.status_code == 200, resp.text
    assert "· generated 2026-10-13 09:00 NZDT" in resp.text
    assert "added 2026-10-13" in resp.text
    assert "UTC" not in resp.text
