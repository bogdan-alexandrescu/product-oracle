"""INT2 lane 1, owner answer Q1: one run-bound read of the job's exact payload.

``GET /v1/intakes/{id}/analysis-input`` (``get_intake_analysis_input``) answers only the
token of that intake's own ``intake_analysis`` run, created by the intake's author, holding
``read:intake-input``; any other run token gets 404, people and API tokens 403, and an
ended run's token 401. Synthetic placeholders only.
"""

import json
import uuid

import pytest
from sqlalchemy import select

from oracle.auth.deps import RUN_TOKEN_HEADER
from oracle.config import get_settings
from oracle.intake import job as intake_job
from oracle.mcp.scopes import required_scope
from oracle.models import AuditEvent
from oracle.runs import flows
from oracle.runs.models import Run
from oracle.runtokens import SCOPES, RunToken, mint_run_token, revoke_run_tokens
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from oracle.tenancy import tenant_session
from oracle.v2.models import ProductIntake
from tests.baseline_helpers import make_item
from tests.intake_helpers import PAIN, company, create_intake

SCOPE = "read:intake-input"


@pytest.fixture(autouse=True)
def _swarmcloud_runtime(monkeypatch):
    monkeypatch.setattr(get_settings(), "intake_read_runtime", "swarmcloud")
    set_runtime(FakeRuntime({"read": [Outcome(polls=50)] * 5}))
    yield
    set_runtime(None)


async def _intake_with_run(client, ctx) -> tuple[str, Run]:
    await make_item(ctx, "commenter", content=PAIN, title="#support thread")
    out = await create_intake(client, ctx, ai_extraction=True)
    intake_id = out["intake"]["id"]
    async with tenant_session(ctx.tenant_id) as s:
        run = await s.scalar(
            select(Run).where(Run.knobs["read_intake_id"].astext == intake_id)
        )
    assert run is not None
    return intake_id, run


async def _token(ctx, run_id, scopes=(SCOPE,)) -> str:
    async with tenant_session(ctx.tenant_id) as s:
        raw = await mint_run_token(s, run_id, list(scopes), ttl_seconds=600)
        await s.commit()
    return raw


def _as_run(ctx, who: str, raw: str) -> dict:
    return {**ctx.as_(who), RUN_TOKEN_HEADER: raw}


# protects=the scope mapping: the route needs read:intake-input (not read:baseline, which
# every intake read takes), the scope is known to run tokens, and only the intake_analysis
# flow's one segment holds it, with that one tool; fails_when=another flow could mint it or
# the read falls under read:baseline; no_claim=the MCP transport.
def test_only_the_intake_read_holds_the_scope():
    assert required_scope("GET", "/v1/intakes/{intake_id}/analysis-input") == SCOPE
    assert required_scope("GET", "/v1/intakes/{intake_id}/summary") == "read:sources"
    assert SCOPE in SCOPES
    holders = [(f.key, s.name) for f in flows.FLOWS.values() for s in f.segments
               if SCOPE in s.scopes]  # fmt: skip
    assert holders == [("intake_analysis", "read")]
    seg = flows.FLOWS["intake_analysis"].segment("read")
    assert seg.scopes == (SCOPE,)
    assert seg.roles == ("analyst",) and seg.outputs == ("analysis.yaml",)
    assert set(seg.tools) == {"get_intake_analysis_input", flows.RUN_DISCUSSIONS_TOOL}
    assert "get_intake_analysis_input" in flows.MCP_TOOLS
    flow = flows.FLOWS["intake_analysis"]
    assert flow.default_depth == "quick" and not flow.writes_document
    knobs = flows.resolve_knobs(flow, {})
    assert str(flows.segment_estimate(seg, knobs)) == "1.50"


# protects=criterion 3a: with its run's token the route returns exactly the body payload()
# builds for the intake (byte-equal), sources untrusted, and the read is audited; the run's
# own minted token holds read:intake-input only; fails_when=the body differs from the job's
# payload or an excerpt is missing; no_claim=what the agent does with it.
async def test_the_runs_token_reads_exactly_the_jobs_payload(client):
    ctx = await company()
    intake_id, run = await _intake_with_run(client, ctx)
    raw = await _token(ctx, run.id)
    resp = await client.get(f"/v1/intakes/{intake_id}/analysis-input",
                            headers=_as_run(ctx, "commenter", raw))  # fmt: skip
    assert resp.status_code == 200, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        intake = await s.get(ProductIntake, uuid.UUID(intake_id))
        body, _known, chosen = await intake_job.payload(s, intake)
    got = resp.json()
    assert got.pop("untrusted") is True
    assert json.dumps(got, sort_keys=True) == json.dumps(body, sort_keys=True, default=str)
    assert len(got["untrusted_data"]["sources"]) == len(chosen) == 1
    async with tenant_session(ctx.tenant_id) as s:
        events = list(await s.scalars(select(AuditEvent).where(
            AuditEvent.action == "intake.evidence_read")))  # fmt: skip
        assert any(e.details.get("route") == "get_intake_analysis_input" for e in events)
        minted = list(await s.scalars(select(RunToken).where(RunToken.run_id == run.id)))
        assert all(t.scopes == [SCOPE] for t in minted)


# protects=criterion 3b: another intake's read token, a run of another flow holding the
# scope, and the run's token without the scope all get 404; fails_when=any of them reads
# the payload; no_claim=SwarmCloud's token handling.
async def test_any_other_run_token_is_404(client):
    ctx = await company()
    intake_id, run = await _intake_with_run(client, ctx)
    other_id, other_run = await _intake_with_run(client, ctx)
    url = f"/v1/intakes/{intake_id}/analysis-input"
    other = await _token(ctx, other_run.id)
    resp = await client.get(url, headers=_as_run(ctx, "commenter", other))
    assert resp.status_code == 404
    no_scope = await _token(ctx, run.id, scopes=("read:baseline",))
    assert (await client.get(url, headers=_as_run(ctx, "commenter", no_scope))).status_code == 404
    async with tenant_session(ctx.tenant_id) as s:
        prd = Run(flow="baseline_to_prd", created_by=ctx.users["commenter"].id,
                  knobs={"read_intake_id": intake_id})  # fmt: skip
        s.add(prd)
        await s.commit()
    wrong_flow = await _token(ctx, prd.id)
    resp = await client.get(url, headers=_as_run(ctx, "commenter", wrong_flow))
    assert resp.status_code == 404


# protects=the role matrix: viewer, commenter (the author too), approver, owner and an API
# token get 403 "This is for Oracle's read of an intake"; another company's intake is 404;
# fails_when=a person or an API token reads the author's excerpts; no_claim=MCP listing.
async def test_people_and_api_tokens_get_403(client):
    ctx = await company()
    intake_id, _run = await _intake_with_run(client, ctx)
    url = f"/v1/intakes/{intake_id}/analysis-input"
    for who in ("viewer", "commenter", "approver", "owner", "token"):
        resp = await client.get(url, headers=ctx.as_(who))
        assert resp.status_code == 403, who
        assert "Oracle's read of an intake" in resp.json()["detail"]
    other = await company("Other Co")
    resp = await client.get(url, headers=other.as_("owner"))
    assert resp.status_code in (403, 404)


# protects=criterion 3c: once the run ends its tokens are revoked and the route answers
# 401; fails_when=a revoked token still reads; no_claim=the 10-minute expiry timing.
async def test_an_ended_runs_token_is_401(client):
    ctx = await company()
    intake_id, run = await _intake_with_run(client, ctx)
    raw = await _token(ctx, run.id)
    async with tenant_session(ctx.tenant_id) as s:
        await revoke_run_tokens(s, run.id)
        await s.commit()
    resp = await client.get(f"/v1/intakes/{intake_id}/analysis-input",
                            headers=_as_run(ctx, "commenter", raw))  # fmt: skip
    assert resp.status_code == 401
