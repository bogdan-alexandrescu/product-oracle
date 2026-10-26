"""Security review at f972c5e: who may set an intake's marks, who a proposal names, and
the same-origin check on every write a browser signs in with its own credentials.

MAJOR 1: ``attrs.proposed_blocker``, ``gap_id`` and ``intake_id`` are an intake's marks
(baseline.MANAGED_ATTRS): only an intake answer sets them, so nobody can forge "From an
intake answer" or the "suggested blocker" that Promote pre-fills; a proposal is labelled
by who sent it unless an intake made it.
MAJOR 2: every non-GET request signed in by the session cookie or Google sign-in (IAP)
passes the same-origin check, app-wide; the raw-body imports take only their declared
Content-Type from a browser. Bearer tokens (API, run, MCP) are not browser credentials
and keep working. Synthetic placeholders only."""

import re
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.routing import _IncludedRouter
from sqlalchemy import select

from oracle.auth.deps import RUN_HEADER, RUN_TOKEN_HEADER
from oracle.auth.iap import ASSERTION_HEADER
from oracle.auth.models import User
from oracle.auth.service import sign_run_binding
from oracle.baseline.models import Entity, Proposal
from oracle.config import get_settings
from oracle.mcp.oauth.models import OAuthClient, OAuthToken
from oracle.mcp.oauth.service import hash_token
from oracle.runtokens import verify_run_token
from oracle.tenancy import tenant_session
from oracle.v2.models import KnowledgeGap, StakeholderQuestion
from tests.baseline_helpers import make_ctx
from tests.test_intake_sharing_round5 import ANSWER as INTAKE_ANSWER
from tests.test_intake_sharing_round5 import MODEL_GAP, _blocker_gap, share, world
from tests.test_intake_sharing_round6 import fake  # noqa: F401 (fixture)
from tests.test_mcp import local_runtime, run_token  # noqa: F401 (fixture)

B = "/v1/baseline"
REFUSED = "Cross-site request refused"
FOREIGN = "https://elsewhere.example"
MARKS = {
    "proposed_blocker": {"type": "hard", "severity": "critical", "status": "open"},
    "gap_id": str(uuid.UUID(int=7)),
    "intake_id": str(uuid.UUID(int=8)),
}


async def _as_run(headers: dict[str, str], user_id, raw: str) -> dict[str, str]:
    """What Oracle's MCP server sends for a run token: the token and the run binding (#614)."""
    claims = await verify_run_token(raw)
    return {**headers, RUN_TOKEN_HEADER: raw, RUN_HEADER: sign_run_binding(user_id, claims.run_id)}


@pytest.fixture
async def ctx():
    return await make_ctx()


async def _mcp_token(ctx, who: str) -> str:
    raw = f"poa_{uuid.uuid4().hex}"
    async with tenant_session(ctx.tenant_id) as s:
        client = OAuthClient(
            client_id=uuid.uuid4().hex, name="Claude", redirect_uris=["http://localhost/cb"]
        )
        s.add(client)
        await s.flush()
        now = datetime.now(UTC)
        s.add(
            OAuthToken(
                access_hash=hash_token(raw),
                refresh_hash=hash_token(f"por_{uuid.uuid4().hex}"),
                client_id=client.id,
                user_id=ctx.users[who].id,
                scope="oracle:read oracle:write",
                expires_at=now + timedelta(hours=1),
                refresh_expires_at=now + timedelta(days=1),
                family_id=uuid.uuid4(),
            )
        )
        await s.commit()
    return raw


async def _senders(ctx) -> dict[str, dict[str, str]]:
    run = await run_token(ctx.tenant_id, ["write:proposals"], ctx.users["commenter"].id)
    mcp = await _mcp_token(ctx, "commenter")
    return {
        "commenter": ctx.as_("commenter"),
        # A run's REST call, as the MCP server makes it in-process: its creator's session,
        # the run token and the run binding (#614).
        "run": await _as_run(ctx.as_("commenter"), ctx.users["commenter"].id, run),
        "mcp": {"Authorization": f"Bearer {mcp}"},
    }


async def _constraint(ctx, key: str, status: str = "confirmed", **attrs) -> uuid.UUID:
    async with tenant_session(ctx.tenant_id) as s:
        entity = Entity(
            type="constraint", key=key, title=f"Constraint {key}", origin="user",
            status=status, attrs=attrs,
        )  # fmt: skip
        s.add(entity)
        await s.commit()
        return entity.id


# --- MAJOR 1: the intake's marks -----------------------------------------------------------


@pytest.mark.parametrize("mark", sorted(MARKS))
async def test_no_proposer_sets_an_intake_mark(client, ctx, mark):
    """A commenter, a run token and an MCP token can neither create nor edit an item with
    an intake's mark through a proposal."""
    senders = await _senders(ctx)
    target = await _constraint(ctx, f"target-{mark.replace('_', '-')}")
    for who, headers in senders.items():
        create = {
            "op": "create", "kind": "entity",
            "fields": {"type": "constraint", "key": f"forged-{who}", "title": "Forged",
                       "attrs": {mark: MARKS[mark]}},
        }  # fmt: skip
        resp = await client.post(f"{B}/proposals", json=create, headers=headers)
        assert resp.status_code == 422, (who, resp.text)
        assert f"attrs.{mark}" in resp.text
        edit = {
            "op": "update", "kind": "entity", "entity_id": str(target),
            "fields": {"attrs": {mark: MARKS[mark]}},
        }  # fmt: skip
        resp = await client.post(f"{B}/proposals", json=edit, headers=headers)
        assert resp.status_code == 422, (who, resp.text)
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.scalars(select(Proposal))).all() == []


async def test_no_writer_sets_an_intake_mark_on_an_item(client, ctx):
    """The direct entity routes refuse the marks too (create and edit)."""
    target = await _constraint(ctx, "direct-target")
    for mark, value in MARKS.items():
        body = {"type": "constraint", "key": f"direct-{mark}".replace("_", "-"),
                "title": "Direct", "attrs": {mark: value}}  # fmt: skip
        resp = await client.post(f"{B}/entities", json=body, headers=ctx.as_("approver"))
        assert resp.status_code == 422, (mark, resp.text)
        resp = await client.patch(
            f"{B}/entities/{target}", json={"attrs": {mark: value}}, headers=ctx.as_("approver")
        )
        assert resp.status_code == 422, (mark, resp.text)


async def _legacy_forgery(ctx) -> uuid.UUID:
    """An open proposal a commenter forged before the fix: the marks, its own sender."""
    async with tenant_session(ctx.tenant_id) as s:
        proposal = Proposal(
            payload={
                "op": "create", "kind": "entity", "origin": "agent", "reason": None,
                "fields": {"type": "constraint", "key": "forged-legacy", "title": "Forged",
                           "attrs": dict(MARKS)},
            },
            actor=f"user:{ctx.users['commenter'].id}",
            status="open",
        )  # fmt: skip
        s.add(proposal)
        await s.commit()
        return proposal.id


async def test_a_forged_proposal_names_its_sender_and_is_not_accepted(client, ctx):
    proposal_id = await _legacy_forgery(ctx)
    listed = (await client.get(f"{B}/proposals", headers=ctx.as_("approver"))).json()
    [shown] = [p for p in listed if p["id"] == str(proposal_id)]
    assert shown["proposer"]["kind"] == "person"
    assert shown["proposer"]["user_id"] == str(ctx.users["commenter"].id)
    assert shown["proposer"]["label"] != "From an intake answer"
    resp = await client.post(
        f"{B}/proposals/{proposal_id}/accept", json={"note": "Looks right"},
        headers=ctx.as_("approver"),
    )  # fmt: skip
    assert resp.status_code == 422, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.scalar(select(Entity).where(Entity.key == "forged-legacy")) is None
        assert (await s.get(Proposal, proposal_id)).status == "open"


async def test_a_token_forgery_names_the_token(client, ctx):
    async with tenant_session(ctx.tenant_id) as s:
        proposal = Proposal(
            payload={"op": "create", "kind": "entity", "origin": "agent", "reason": None,
                     "fields": {"type": "constraint", "key": "forged-token", "title": "F",
                                "attrs": {"gap_id": MARKS["gap_id"]}}},
            actor=f"token:{ctx.token_id}", status="open",
        )  # fmt: skip
        s.add(proposal)
        await s.commit()
    listed = (await client.get(f"{B}/proposals", headers=ctx.as_("approver"))).json()
    [shown] = [p for p in listed if p["id"] == str(proposal.id)]
    assert shown["proposer"]["kind"] == "token"
    assert shown["proposer"]["label"] == "API token “agent-track”"


async def test_an_intake_answer_still_proposes_its_suggested_blocker(client, fake):  # noqa: F811
    """The intake's own proposal keeps its label and its mark through Accept."""
    ctx, intake_id, _ = await world(client, fake, hidden=False, model=_blocker_gap)
    async with tenant_session(ctx.tenant_id) as s:
        gap = await s.scalar(select(KnowledgeGap).where(KnowledgeGap.statement == MODEL_GAP))
        q = await s.scalar(select(StakeholderQuestion).where(StakeholderQuestion.gap_id == gap.id))
    resp = await client.post(
        f"/v1/questions/{q.id}/answers", json={"kind": "answer", "body": INTAKE_ANSWER},
        headers=ctx.as_("author"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    await share(client, ctx, intake_id, str(gap.id), "summary")
    [made] = (await client.get(f"{B}/proposals", headers=ctx.as_("approver"))).json()
    assert made["proposer"]["kind"] == "intake"
    assert made["proposer"]["label"] == "From an intake answer"
    resp = await client.post(
        f"{B}/proposals/{made['id']}/accept", json={"note": "Agreed"},
        headers=ctx.as_("approver"),
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        entity = await s.scalar(select(Entity).where(Entity.type == "constraint"))
    assert entity.attrs["proposed_blocker"]["status"] == "open"
    assert entity.attrs["gap_id"] == str(gap.id)


# --- MAJOR 2: the same-origin check on every cookie write ----------------------------------


def _routes(routes):
    """Every route, the included routers' too (FastAPI includes them lazily)."""
    for route in routes:
        if isinstance(route, _IncludedRouter):
            yield from _routes(route.effective_candidates())
        else:
            yield route


def _writes():
    from oracle.main import app

    for route in _routes(app.routes):
        methods = getattr(route, "methods", None) or set()
        for method in sorted(methods - {"GET", "HEAD", "OPTIONS"}):
            path = re.sub(r"\{[^}]+\}", str(uuid.UUID(int=1)), route.path)
            yield method, path


COOKIE = {"Cookie": f"{get_settings().session_cookie_name}=signed-in"}
IAP = {ASSERTION_HEADER: "signed-in"}
CROSS_SITE = {
    "sec-fetch-site": {"sec-fetch-site": "cross-site"},
    "foreign-origin": {"Origin": FOREIGN},
    "null-origin": {"Origin": "null"},
    "foreign-referer": {"Referer": f"{FOREIGN}/page"},
    "text-plain": {"Origin": FOREIGN, "Content-Type": "text/plain"},
}


@pytest.mark.parametrize("signed_in", ["cookie", "iap"])
@pytest.mark.parametrize("how", sorted(CROSS_SITE))
async def test_every_browser_write_is_checked_for_its_origin(client, signed_in, how):
    """Walks every non-GET route: a cross-site request the browser signs in itself is
    refused before the route runs."""
    ambient = COOKIE if signed_in == "cookie" else IAP
    reached = []
    writes = list(_writes())
    assert len(writes) > 100
    for method, path in writes:
        resp = await client.request(
            method, path, headers={**ambient, **CROSS_SITE[how]}, content=b"x=1"
        )
        if resp.status_code != 403 or REFUSED not in resp.text:
            reached.append(f"{method} {path} -> {resp.status_code}")
    assert reached == []
    # The MCP endpoint too.
    resp = await client.post("/mcp", headers={**ambient, **CROSS_SITE[how]}, content=b"{}")
    assert resp.status_code == 403


async def test_a_same_origin_cookie_write_passes(client, ctx):
    body = {"type": "feature", "key": "guided", "title": "Guided setup"}
    for extra in ({"Origin": "http://test"}, {"sec-fetch-site": "same-origin"}, {}):
        body["key"] = f"guided-{len(body['title'])}"
        body["title"] += " again"
        resp = await client.post(
            f"{B}/entities", json=body, headers={**ctx.as_("approver"), **extra}
        )
        assert resp.status_code == 201, (extra, resp.text)


async def test_bearer_tokens_are_not_browser_credentials(client, ctx):
    """An API token and an MCP token write from anywhere; a run's in-process REST call
    (its creator's session and the run token, no Origin) is not refused."""
    mcp = await _mcp_token(ctx, "approver")
    for i, raw in enumerate((ctx.token, mcp)):
        headers = {"Authorization": f"Bearer {raw}", "Origin": FOREIGN,
                   "sec-fetch-site": "cross-site"}  # fmt: skip
        fields = {"type": "feature", "key": f"from-bearer-{i}", "title": "Bearer"}
        body = {"op": "create", "kind": "entity", "fields": fields}
        resp = await client.post(f"{B}/proposals", json=body, headers=headers)
        assert resp.status_code == 201, (i, resp.text)
    run = await run_token(ctx.tenant_id, ["write:proposals"], ctx.users["approver"].id)
    body = {"op": "create", "kind": "entity",
            "fields": {"type": "feature", "key": "from-run", "title": "Run"}}  # fmt: skip
    headers = await _as_run(ctx.as_("approver"), ctx.users["approver"].id, run)
    resp = await client.post(f"{B}/proposals", json=body, headers=headers)
    assert resp.status_code == 201, resp.text
    assert resp.json()["proposer"]["kind"] == "run"


RAW = {
    "yaml": (f"{B}/yaml", "application/yaml", b"entities: []\nedges: []\n"),
    "draft": ("/v1/documents/gift-notes/versions", "text/markdown",
              b"---\ntitle: Gift notes\n---\n\n# Gift notes\n\n## Problem\n\nBuyers forget.\n"),
    "csv": ("/v1/deal-outcomes/import?dry_run=true", "text/csv",
            b"result,account,segment,plan,annual_value,currency,decided_on,reason\n"),
}  # fmt: skip


@pytest.mark.parametrize("kind", sorted(RAW))
async def test_raw_imports_take_only_their_declared_type(client, ctx, kind):
    path, declared, body = RAW[kind]
    for wrong in ("text/plain", "application/x-www-form-urlencoded", "multipart/form-data"):
        headers = {**ctx.as_("approver"), "Content-Type": wrong}
        resp = await client.post(path, content=body, headers=headers)
        assert resp.status_code == 415, (wrong, resp.text)
    # A browser's own credentials must name the type.
    resp = await client.post(path, content=body, headers=ctx.as_("approver"))
    assert resp.status_code == 415, resp.text
    headers = {**ctx.as_("approver"), "Content-Type": f"{declared}; charset=utf-8"}
    resp = await client.post(path, content=body, headers=headers)
    assert resp.status_code != 415, resp.text
    # A bearer token may leave the type out, as scripts do.
    resp = await client.post(path, content=body, headers=ctx.as_("token"))
    assert resp.status_code != 415, resp.text


# --- minors ------------------------------------------------------------------------------


async def test_a_rejected_constraint_is_not_made_a_blocker(client, ctx):
    entity_id = await _constraint(ctx, "archived-limit", status="rejected")
    body = {"entity_id": str(entity_id), "type": "hard", "severity": "high", "status": "open"}
    resp = await client.post("/v1/blockers", json=body, headers=ctx.as_("approver"))
    assert resp.status_code == 409, resp.text


async def test_a_proposed_suggested_blocker_is_accepted_before_promote(client, ctx):
    entity_id = await _constraint(
        ctx, "unaccepted-limit", status="proposed", proposed_blocker=MARKS["proposed_blocker"]
    )
    body = {"entity_id": str(entity_id), "type": "hard", "severity": "high", "status": "open"}
    resp = await client.post("/v1/blockers", json=body, headers=ctx.as_("approver"))
    assert resp.status_code == 409, resp.text


async def test_a_disabled_member_does_not_own_a_new_blocker(client, ctx):
    async with tenant_session(ctx.tenant_id) as s:
        gone = User(email="gone@example.com", password_hash="x", role="approver",
                    disabled_at=datetime.now(UTC))  # fmt: skip
        s.add(gone)
        await s.commit()
    entity_id = await _constraint(ctx, "owned-limit")
    body = {"entity_id": str(entity_id), "type": "hard", "severity": "high", "status": "open",
            "owner_id": str(gone.id)}  # fmt: skip
    resp = await client.post("/v1/blockers", json=body, headers=ctx.as_("approver"))
    assert resp.status_code == 422, resp.text
