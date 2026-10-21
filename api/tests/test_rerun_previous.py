"""D5 Re-run keeps its output (#163): a segment a person sent back runs again from its
previous files and the problems Oracle's check found in them, and the previous attempt's
files are kept (one level) and readable with ``?attempt=``.

Unit tests for the prompt section and ``workflow.check_findings``; segment-mode
integration tests on the FakeRuntime (one workflow per segment)."""

import uuid
from dataclasses import replace

import pytest
from sqlalchemy import select

from oracle.runs import flows, service, workflow
from oracle.runs.models import Run, RunSegment
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from oracle.tenancy import tenant_session
from tests.fixtures import draft, import_draft, seed_auth
from tests.test_draft_sent_back import BAD_PRD
from tests.test_roadmap import ITEMS, PRD, approved_prd, create, decide, get, pending, start, tick

ITEMS_FILE = "roadmap_items.yaml"
# Item shipping-step names a PRD section the PRD version does not have.
NO_SECTION = ITEMS.replace("prd_section: s-5-2", "prd_section: s-9")
NO_SECTION_MESSAGE = "item shipping-step: PRD section 's-9' is not in the PRD version"
HEADER = "Your previous attempt (attempt 1) wrote these files"


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


@pytest.fixture
async def owner():
    return await seed_auth()


# --------------------------------------------------------------------------- unit: prompt


def _ctx(**kw) -> flows.PromptContext:
    base = flows.PromptContext(
        run_id="r1",
        document="checkout-redesign-roadmap",
        snapshot_as_of=None,
        low_confidence=0.4,
        kind="roadmap",
        attempt=2,
        change_request="Put the shipping step in later",
        previous_attempt=1,
        previous_seq=1,
        previous_files={ITEMS_FILE: NO_SECTION},
        previous_problems=[f"No PRD section (shipping-step): {NO_SECTION_MESSAGE}"],
    )
    return replace(base, **kw)


def _prompts(ctx: flows.PromptContext, roles: list[str]) -> list[str]:
    flow = flows.FLOWS["prd_to_roadmap"]
    sdef = flow.segment("roadmap_items")
    knobs = flows.Knobs(roles={"roadmap_items": roles})
    return [p for _, _, p, _, _ in flows.build_steps(flow, sdef, knobs, ctx)]


def test_first_and_last_steps_get_the_previous_files_pasted_and_the_problems():
    first, middle, last = _prompts(_ctx(), ["analyst", "architect", "prioritizer"])
    for prompt in (first, last):
        assert HEADER in prompt
        assert "Start from them and change only what the review asks" in prompt
        assert f"--- {ITEMS_FILE} ---\n{NO_SECTION}" in prompt
        # After the change request.
        assert prompt.index("The reviewer requested changes") < prompt.index(HEADER)
    # Middle steps: the problems only.
    assert HEADER not in middle and NO_SECTION not in middle
    for prompt in (first, middle, last):
        assert "Oracle's check found these problems in attempt 1; fix each one:" in prompt
        assert f"- No PRD section (shipping-step): {NO_SECTION_MESSAGE}" in prompt


def test_with_the_run_token_attached_the_previous_files_are_named_not_pasted():
    [first, last] = _prompts(_ctx(mcp_attached=True), ["analyst", "prioritizer"])
    for prompt in (first, last):
        assert HEADER in prompt
        assert f"get_run_output(seq=1, name={ITEMS_FILE})" in prompt
        assert "shipping-step" not in prompt.split(HEADER)[1].split("Oracle's check")[0]
        assert NO_SECTION not in prompt


def test_a_long_previous_file_is_cut_at_the_cap():
    long = "x" * flows.MAX_PRIOR_CHARS + "TAIL"
    [first] = _prompts(_ctx(previous_files={ITEMS_FILE: long}), ["analyst"])
    assert "x" * flows.MAX_PRIOR_CHARS in first
    assert "TAIL" not in first
    assert "(truncated: read the rest with get_run_output)" in first


def test_no_change_request_or_no_previous_attempt_adds_no_section():
    for ctx in (
        _ctx(change_request=None),
        _ctx(previous_attempt=None, previous_files={}, previous_problems=[]),
    ):
        [first] = _prompts(ctx, ["analyst"])
        assert "Your previous attempt" not in first
        assert "Oracle's check found these problems" not in first


# --------------------------------------------------------------------------- unit: findings


def test_check_findings_lists_each_blocking_reason_and_never_a_to_confirm_one():
    check = {
        "items": 2,
        "problems": [{"code": "unknown_prd_section", "message": NO_SECTION_MESSAGE}],
        # D2 Product reasons: blocking ones are fixed by the agents, a person decides the
        # others.
        "reasons": [
            {
                "item": "shipping-step",
                "label": "No PRD section",
                "text": "Section s-9 is not in the PRD version.",
                "severity": "blocking",
            },
            {
                "item": "payment-step",
                "label": "Moved",
                "text": "It moved from next to now.",
                "severity": "confirm",
            },
        ],
    }
    assert workflow.check_findings(ITEMS_FILE, check, []) == [
        f"Oracle's check found these problems in {ITEMS_FILE}; fix each one:",
        "No PRD section (shipping-step): Section s-9 is not in the PRD version.",
    ]
    # Without reasons: one line per problem of the check.
    del check["reasons"]
    assert workflow.check_findings(ITEMS_FILE, check, []) == [
        f"Oracle's check found these problems in {ITEMS_FILE}; fix each one:",
        f"[unknown_prd_section] {NO_SECTION_MESSAGE}",
    ]


def test_check_findings_with_no_problems_is_empty_and_import_problems_are_summarised():
    assert workflow.check_findings(ITEMS_FILE, {"items": 2, "problems": []}, []) == []
    assert workflow.check_findings("prd.md", None, []) == []
    problems = [{"code": "missing_section_id", "message": "heading 'Goals' has no {#id}"}]
    [lead, line] = workflow.check_findings("prd.md", None, problems)
    assert lead == "Oracle's check found these problems in prd.md; fix each one:"
    assert line.startswith("Oracle refused prd.md:")


# --------------------------------------------------------------------------- segment mode


async def _segment(tenant_id: uuid.UUID, run_id: str, seq: int = 1) -> RunSegment:
    async with tenant_session(tenant_id) as s:
        return await s.scalar(
            select(RunSegment).where(RunSegment.run_id == uuid.UUID(run_id), RunSegment.seq == seq)
        )


async def _items_run(client, auth, runtime, *outcomes: str) -> dict:
    await approved_prd(client, auth)
    runtime.script["roadmap_items"] = [Outcome(artifacts={ITEMS_FILE: t}) for t in outcomes]
    run = await start(client, auth, await create(client, auth, source=PRD))
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["waiting_on"] == "roadmap_items", run
    return run


async def test_a_send_back_starts_from_the_previous_file_and_its_problems(client, owner, runtime):
    """AC1: the re-submitted workflow's first step has the previous file and its problem."""
    _, auth = owner
    run = await _items_run(client, auth, runtime, NO_SECTION, ITEMS)
    codes = [p["code"] for p in pending(run)["payload"]["items_check"]["problems"]]
    assert codes == ["unknown_prd_section"]
    await decide(client, auth, run, "changes_requested", "Keep the shipping step next")
    spec = runtime.submitted[-1]
    assert spec.labels["attempt"] == "2"
    first, last = spec.steps[0].prompt, spec.steps[-1].prompt
    assert "Attempt 2. The reviewer requested changes:\nKeep the shipping step next" in first
    assert HEADER in first and HEADER in last
    assert f"--- {ITEMS_FILE} ---\n{NO_SECTION}" in first
    assert "Oracle's check found these problems in attempt 1; fix each one:" in first
    # With D2 Product reasons the check carries reasons: a blocking one reaches the agents
    # as its label and sentence.
    assert "- No PRD section (shipping-step): Section s-9 is not in " in first


async def test_the_previous_attempt_survives_the_harvest_one_level_kept(client, owner, runtime):
    """AC4: after attempt 2 is harvested the previous is attempt 1; after attempt 3 is
    submitted it is attempt 2 (one level)."""
    tenant_id, auth = owner
    second = ITEMS.replace("Payment step", "Payment step, second try")
    run = await _items_run(client, auth, runtime, NO_SECTION, second, ITEMS)
    run = await decide(client, auth, run, "changes_requested", "Fix the PRD section")
    seg = await _segment(tenant_id, run["id"])
    kept = seg.artifacts["previous"]
    assert kept["attempt"] == 1 and kept["files"] == {ITEMS_FILE: NO_SECTION}
    assert [p["code"] for p in kept["items_check"]["problems"]] == ["unknown_prd_section"]
    assert kept["import_problems"] == [] and kept["kept_at"]

    await tick(client, auth)
    run = await get(client, auth, run["id"])
    seg = await _segment(tenant_id, run["id"])
    assert seg.artifacts["files"] == {ITEMS_FILE: second}
    assert seg.artifacts["previous"]["attempt"] == 1
    assert seg.artifacts["previous"]["files"] == {ITEMS_FILE: NO_SECTION}
    out = run["segments"][0]
    assert out["previous_attempt"] == {"attempt": 1, "artifacts": [ITEMS_FILE]}

    run = await decide(client, auth, run, "changes_requested", "Shorter titles")
    seg = await _segment(tenant_id, run["id"])
    assert seg.artifacts["previous"]["attempt"] == 2
    assert seg.artifacts["previous"]["files"] == {ITEMS_FILE: second}
    assert set(seg.artifacts["previous"]) == {
        "attempt",
        "files",
        "items_check",
        "import_problems",
        "kept_at",
    }
    assert HEADER.replace("1", "2") in runtime.submitted[-1].steps[0].prompt


async def test_the_artifact_reads_the_previous_attempt_and_nothing_older(client, owner, runtime):
    """AC5: ?attempt= serves the previous attempt's file; 0 and older attempts are 404."""
    _, auth = owner
    second = ITEMS.replace("Payment step", "Payment step, second try")
    run = await _items_run(client, auth, runtime, NO_SECTION, second, ITEMS)
    run = await decide(client, auth, run, "changes_requested", "Fix the PRD section")
    await tick(client, auth)
    url = f"/v1/runs/{run['id']}/segments/1/artifacts/{ITEMS_FILE}"
    assert (await client.get(url, headers=auth)).text == second
    resp = await client.get(url, params={"attempt": 1}, headers=auth)
    assert resp.status_code == 200 and resp.text == NO_SECTION
    assert (await client.get(url, params={"attempt": 2}, headers=auth)).text == second
    resp = await client.get(url, params={"attempt": 0}, headers=auth)
    assert resp.status_code == 404
    assert "only the current and the previous attempt are kept" in resp.text
    resp = await client.get(
        f"/v1/runs/{run['id']}/segments/1/artifacts/other.md", params={"attempt": 1}, headers=auth
    )
    assert resp.status_code == 404

    run = await decide(client, auth, await get(client, auth, run["id"]), "changes_requested", "x")
    await tick(client, auth)
    assert (await client.get(url, params={"attempt": 3}, headers=auth)).text == ITEMS
    assert (await client.get(url, params={"attempt": 2}, headers=auth)).text == second
    resp = await client.get(url, params={"attempt": 1}, headers=auth)
    assert resp.status_code == 404
    assert "only the current and the previous attempt are kept" in resp.text


async def test_a_refused_draft_sent_back_by_a_person_lists_the_import_problems(
    client, owner, runtime
):
    """AC7: segment mode, a PRD draft refused at import, then Request changes: the re-run
    prompt lists the import's problems summary."""
    tenant_id, auth = owner
    assert (await import_draft(client, auth, draft("prd_v1.md"))).status_code == 201
    runtime.script["next_draft"] = [Outcome(artifacts={"prd.md": BAD_PRD})]
    resp = await client.post(
        "/v1/runs",
        json={"flow": "feedback_loop", "document": "checkout-redesign"},
        headers=auth,
    )
    assert resp.status_code == 201, resp.text
    run = await start(client, auth, resp.json())
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    summary = pending(run)["payload"]["import"]["summary"]
    assert summary.startswith("Oracle refused prd.md:")
    await decide(client, auth, run, "changes_requested", "Cite only accepted sources")
    seg = await _segment(tenant_id, run["id"])
    assert seg.artifacts["previous"]["import_problems"]
    first = runtime.submitted[-1].steps[0].prompt
    assert "Oracle's check found these problems in attempt 1; fix each one:" in first
    assert f"- {summary}" in first
    assert "Your previous attempt (attempt 1) wrote these files" in first
    assert BAD_PRD in first


async def test_a_rerun_that_is_not_a_send_back_has_no_previous_section(client, owner, runtime):
    """AC8: a submission without a change request (a runtime retry re-runs the same work)
    adds no previous-files section, though the segment keeps a previous attempt."""
    tenant_id, auth = owner
    run = await _items_run(client, auth, runtime, NO_SECTION, ITEMS)
    await decide(client, auth, run, "changes_requested", "Fix the PRD section")
    async with tenant_session(tenant_id) as s:
        row = await s.get(Run, uuid.UUID(run["id"]))
        segments = list(
            await s.scalars(
                select(RunSegment).where(RunSegment.run_id == row.id).order_by(RunSegment.seq)
            )
        )
        assert segments[0].artifacts["previous"]["attempt"] == 1
        ctx = await service._prompt_context(s, row, segments[0], segments, 3, None, runtime)
        assert ctx.previous_attempt is None
        assert ctx.previous_files == {} and ctx.previous_problems == []
        flow = flows.FLOWS["prd_to_roadmap"]
        sdef = flow.segment("roadmap_items")
        prompts = [p for _, _, p, _, _ in flows.build_steps(flow, sdef, flows.Knobs(), ctx)]
        assert all("Your previous attempt" not in p for p in prompts)
        # With the note, the same segment's re-run does get it.
        ctx = await service._prompt_context(s, row, segments[0], segments, 3, "Again", runtime)
        assert ctx.previous_attempt == 1 and ctx.previous_files == {ITEMS_FILE: NO_SECTION}
