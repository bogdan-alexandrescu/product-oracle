"""#624 review: an ``intake_analysis`` run is private to its creator, the intake's author.

The run has no document, so H8's document rule never hid it; its ``analysis.yaml`` holds
what the model drew from the author's private pinned sources (S6). Listing runs, reading
one, reading its files (REST and MCP ``list_runs``, ``get_run``, ``get_run_artifact``)
show it to the author only: a viewer, another commenter, an approver, an owner, an API
token and another member's MCP client get no row and 404. Synthetic placeholders only.
"""

import pytest
from sqlalchemy import select

from oracle.account import service as account_service
from oracle.auth.deps import Principal
from oracle.auth.service import make_session_cookie
from oracle.config import get_settings
from oracle.runs.models import Run
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_item
from tests.intake_helpers import PAIN, company, create_intake
from tests.test_mcp import api_token, mcp_client, text_of, user_with_role

ANALYSIS = """\
version: 1
items:
  - field: users
    text: Returning buyers on mobile
    evidence_refs: [src:1]
gaps: []
"""
NAME = "analysis.yaml"


@pytest.fixture(autouse=True)
def _swarmcloud_runtime(monkeypatch):
    monkeypatch.setattr(get_settings(), "intake_read_runtime", "swarmcloud")
    set_runtime(FakeRuntime({"read": [Outcome(artifacts={NAME: ANALYSIS})]}))
    yield
    set_runtime(None)


async def _finished_read(client, ctx) -> Run:
    await make_item(ctx, "commenter", content=PAIN, title="#support thread")
    await create_intake(client, ctx, ai_extraction=True)
    for _ in range(3):
        resp = await client.post("/v1/internal/tick", headers=ctx.as_("owner"))
        assert resp.status_code == 200, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        run = await s.scalar(select(Run).where(Run.flow == "intake_analysis"))
    assert run is not None and run.status == "succeeded", run and run.error
    return run


async def _cookie_of_other_commenter(ctx) -> dict[str, str]:
    other = await user_with_role(ctx.tenant_id, "commenter", "other-pm@example.com")
    return {"Cookie": f"{get_settings().session_cookie_name}={make_session_cookie(other)}"}


async def _personal_token(ctx, who: str) -> str:
    user = ctx.users[who]
    principal = Principal(tenant_id=ctx.tenant_id, kind="user", role=user.role, user_id=user.id)
    async with tenant_session(ctx.tenant_id) as s:
        _token, raw = await account_service.create_personal_token(
            s, principal, f"mcp-{who}", ["oracle:read"], 90
        )
        await s.commit()
    return raw


# protects=over REST the author lists, reads and downloads the read's run and its
# analysis.yaml, and a viewer, another commenter, an approver, an owner and an API token get
# no row from GET /v1/runs and 404 from the run and its file; fails_when=any member other
# than the author reads the private analysis or learns the run exists; no_claim=the web.
async def test_only_the_author_lists_reads_and_downloads_the_read_run(client):
    ctx = await company()
    run = await _finished_read(client, ctx)
    run_url = f"/v1/runs/{run.id}"
    file_url = f"{run_url}/segments/1/artifacts/{NAME}"

    author = ctx.as_("commenter")
    listed = await client.get("/v1/runs", headers=author)
    assert listed.status_code == 200 and str(run.id) in listed.text
    assert (await client.get(run_url, headers=author)).status_code == 200
    got = await client.get(file_url, headers=author)
    assert got.status_code == 200 and "Returning buyers on mobile" in got.text

    others = {who: ctx.as_(who) for who in ("viewer", "approver", "owner", "token")}
    others["another commenter"] = await _cookie_of_other_commenter(ctx)
    for who, headers in others.items():
        listed = await client.get("/v1/runs", headers=headers)
        assert listed.status_code == 200, who
        assert str(run.id) not in listed.text, who
        assert (await client.get(run_url, headers=headers)).status_code == 404, who
        got = await client.get(file_url, headers=headers)
        assert got.status_code == 404, who
        assert "Returning buyers" not in got.text, who


# protects=over MCP the author's own client reads the run and its file, while an owner's
# API token and another member's (the owner's) personal client get no row from list_runs
# and an error (404) from get_run and get_run_artifact; fails_when=an MCP client reads the
# author's private analysis; no_claim=run tokens of other runs.
async def test_only_the_authors_mcp_client_reads_the_read_run(client):
    ctx = await company()
    run = await _finished_read(client, ctx)
    args = {"run_id": str(run.id), "seq": 1, "name": NAME}

    async with mcp_client(await _personal_token(ctx, "commenter")) as c:
        listed = await c.call_tool("list_runs", {})
        got = await c.call_tool("get_run", {"run_id": str(run.id)})
        art = await c.call_tool("get_run_artifact", args)
    assert str(run.id) in text_of(listed)
    assert not got.is_error and not art.is_error, text_of(art)
    assert "Returning buyers on mobile" in text_of(art)

    clients = {
        "owner api token": await api_token(ctx.tenant_id, "owner"),
        "owner personal": await _personal_token(ctx, "owner"),
        "approver personal": await _personal_token(ctx, "approver"),
    }
    for who, raw in clients.items():
        async with mcp_client(raw) as c:
            listed = await c.call_tool("list_runs", {})
            got = await c.call_tool("get_run", {"run_id": str(run.id)})
            art = await c.call_tool("get_run_artifact", args)
        assert not listed.is_error, (who, text_of(listed))
        assert str(run.id) not in text_of(listed), who
        assert got.is_error and "HTTP 404" in text_of(got), (who, text_of(got))
        assert art.is_error and "HTTP 404" in text_of(art), (who, text_of(art))
        assert "Returning buyers" not in text_of(art), who


# protects=the discussion panel's Runs screen context (built with Oracle's view, read by
# every member's discussion) never lists an intake read, not even in its author's own
# discussion; fails_when=the context names the run; no_claim=the model's reply.
async def test_the_runs_screen_context_leaves_out_the_intake_read(client):
    from tests.test_hop_panel import screen_context

    ctx = await company()
    set_runtime(FakeRuntime({"read": [Outcome(polls=50)]}))
    await make_item(ctx, "commenter", content=PAIN, title="#support thread")
    await create_intake(client, ctx, ai_extraction=True)
    async with tenant_session(ctx.tenant_id) as s:
        run = await s.scalar(select(Run).where(Run.flow == "intake_analysis"))
    assert run is not None and run.status == "running"
    built = await screen_context(client, ctx, "/runs")
    assert str(run.id) not in {e["ref"] for e in built.entries.values()}
    assert "Oracle's read" not in "\n".join(built.lines)
