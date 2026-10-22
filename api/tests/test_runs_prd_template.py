"""C4: a Baseline-to-PRD run takes a PRD template, and its draft gets the skeleton (issue
#153, API items 6-7, acceptance criteria 4 and 5).

Card (test_prd_run_takes_template and the tests below):
- protects: the template picked at the door reaches the run's knobs and the PRD draft
  prompt; the roadmap draft prompt is byte-for-byte what it was before the refactor.
- fails_when: the run refuses a PRD template, the knobs lack template/template_version/
  theme, the prd_draft prompt lacks the template key, version or skeleton headings, a
  feedback loop starts taking a template, or a roadmap prompt changes by one byte.
- no_claim: that the agent follows the skeleton.

Synthetic placeholders only.
"""

import hashlib
import uuid

import pytest
from sqlalchemy import select

from oracle.runs import flows
from oracle.runs import service as runs_service
from oracle.runs.models import Run, RunSegment
from oracle.swarm import FakeRuntime, set_runtime
from oracle.tenancy import tenant_session
from tests.intake_helpers import company, create_intake


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


async def test_prd_run_takes_template(client, runtime):
    """Criterion 4: the intake's template and theme reach the run's knobs."""
    ctx = await company()
    out = await create_intake(
        client, ctx, who="approver", template="one-pager", theme="one-page-brief"
    )
    resp = await client.post(
        f"/v1/intakes/{out['intake']['id']}/runs", json={}, headers=ctx.as_("approver")
    )
    assert resp.status_code == 201, resp.text
    run = resp.json()
    assert run["template"] == "one-pager" and run["theme"] == "one-page-brief"
    async with tenant_session(ctx.tenant_id) as s:
        knobs = (await s.get(Run, uuid.UUID(run["id"]))).knobs
    assert knobs["template"] == "one-pager"
    assert isinstance(knobs["template_version"], int) and knobs["template_version"] >= 1
    assert knobs["theme"] == "one-page-brief"


async def test_the_run_body_overrides_and_no_template_takes_the_default(client, runtime):
    ctx = await company()
    out = await create_intake(client, ctx, who="approver", template="one-pager")
    resp = await client.post(
        f"/v1/intakes/{out['intake']['id']}/runs",
        json={"template": "prd-rfc", "theme": "clean-document"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["template"] == "prd-rfc"
    assert resp.json()["theme"] == "clean-document"

    # A plain POST /v1/runs with no template: the built-in default, as roadmaps.
    resp = await client.post(
        "/v1/runs",
        json={"flow": "baseline_to_prd", "document": "plain-prd"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 201, resp.text
    run = (await client.get(f"/v1/runs/{resp.json()['id']}", headers=ctx.as_("approver"))).json()
    assert run["template"] == "oracle-default"
    assert run["theme"] == "clean-document"
    for body in ({"template": "now-next-later"}, {"theme": "roadmap-board"}):
        resp = await client.post(
            "/v1/runs",
            json={"flow": "baseline_to_prd", "document": "other-prd", **body},
            headers=ctx.as_("approver"),
        )
        assert resp.status_code == 422, resp.text


async def test_a_feedback_loop_still_refuses_a_template(client, runtime):
    ctx = await company()
    resp = await client.post(
        "/v1/runs",
        json={"flow": "feedback_loop", "document": "some-prd", "template": "one-pager"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 422, resp.text
    assert "takes no template or theme" in resp.text or "writes" in resp.text


async def test_the_prd_draft_prompt_names_the_template_and_pastes_the_skeleton(client, runtime):
    """Criterion 5: the prd_draft step prompt holds the template key, version, theme and
    the skeleton's headings; the other segments get no skeleton."""
    ctx = await company()
    out = await create_intake(
        client, ctx, who="approver", title="Saved addresses", template="one-pager",
        theme="one-page-brief",
    )  # fmt: skip
    resp = await client.post(
        f"/v1/intakes/{out['intake']['id']}/runs", json={}, headers=ctx.as_("approver")
    )
    run_id = uuid.UUID(resp.json()["id"])
    async with tenant_session(ctx.tenant_id) as s:
        run = await s.get(Run, run_id)
        version = run.knobs["template_version"]
        segments = list(
            await s.scalars(
                select(RunSegment).where(RunSegment.run_id == run_id).order_by(RunSegment.seq)
            )
        )
        flow = flows.FLOWS["baseline_to_prd"]
        prompts = {}
        for seg in segments:
            pctx = await runs_service._prompt_context(s, run, seg, segments, 1, None, runtime)
            steps = flows.build_steps(flow, flow.segment(seg.name), flows.Knobs(), pctx)
            prompts[seg.name] = steps[-1][2]
    draft = prompts["prd_draft"]
    assert f"template one-pager version {version}, theme one-page-brief" in draft
    assert "--- template skeleton ---" in draft
    for heading in ("## Goal served {#goal-trace}", "## Not doing {#non-goals}"):
        assert heading in draft
    assert "kind: prd" in draft and "template: one-pager" in draft
    assert "document: saved-addresses" in draft
    for name, prompt in prompts.items():
        if name != "prd_draft":
            assert "--- template skeleton ---" not in prompt, name


# --- the roadmap draft prompt, pinned ------------------------------------------------------

# sha256 (first 16 hex) of each roadmap_draft step prompt, captured from main BEFORE
# roadmap_lines became draft_lines (C4): (with a source PRD, theme, MCP attached).
ROADMAP_PINS = {
    (True, "roadmap-board", False): ["7ab0ec790db5698a", "8f559e817762b3af"],
    (True, "roadmap-board", True): ["ad669b369c095f42", "bc613cba7b18b062"],
    (True, None, False): ["fdee1ea119449d48", "8cec0bf72b0306de"],
    (True, None, True): ["d0045dc62af49da2", "c3b952bd602971af"],
    (False, "roadmap-board", False): ["23476a9bd380e280", "8c7c17321175bb51"],
    (False, "roadmap-board", True): ["23476a9bd380e280", "8c7c17321175bb51"],
    (False, None, False): ["85f662a08cfcf9ed", "ad0edab8f1df8d6c"],
    (False, None, True): ["85f662a08cfcf9ed", "ad0edab8f1df8d6c"],
}


def _source() -> flows.SourceContext:
    return flows.SourceContext(
        slug="checkout-redesign",
        title="Checkout redesign PRD",
        version=3,
        markdown="# Checkout\n\n## Payment step {#s-5-1}\nPay.\n",
        sections=[("s-5-1", "Payment step")],
        priorities=[
            {
                "rank": 1,
                "key": "payment-step",
                "title": "Payment step",
                "score": 4.2,
                "flags": [],
                "depends_on": [],
                "explanation": "Serves activation",
            }
        ],  # fmt: skip
        edges=[{"src": "feature:a", "type": "depends_on", "dst": "feature:b"}],
        goals=[{"key": "activation", "title": "Raise activation", "horizon": "short"}],
    )


@pytest.mark.parametrize("case", sorted(ROADMAP_PINS, key=str))
def test_the_roadmap_draft_prompt_is_byte_for_byte_unchanged(case):
    with_source, theme, attached = case
    flow = flows.FLOWS["prd_to_roadmap"]
    knobs = flows.resolve_knobs(flow, {})
    draft = flows.DraftContext(
        kind="roadmap",
        slug="checkout-redesign-roadmap",
        template="now-next-later",
        template_version=2,
        theme=theme,
        skeleton="---\nkind: roadmap\n---\n# Roadmap {#roadmap}\n",
    )
    ctx = flows.PromptContext(
        run_id="r1",
        document="checkout-redesign-roadmap",
        snapshot_as_of=None,
        low_confidence=0.4,
        kind="roadmap",
        source=_source() if with_source else None,
        draft=draft,
        mcp_attached=attached,
    )
    steps = flows.build_steps(flow, flow.segment("roadmap_draft"), knobs, ctx)
    digests = [hashlib.sha256(s[2].encode()).hexdigest()[:16] for s in steps]
    assert digests == ROADMAP_PINS[case]


def test_baseline_to_prd_points_to_the_new_prd_door():
    """Runs › New run no longer offers Baseline to PRD; its pointer line opens New PRD."""
    flow = flows.FLOWS["baseline_to_prd"]
    assert flow.in_new_run_dialog is False
    assert flow.starts_from == ("New PRD · PRDs", "/documents/new?kind=prd")
