"""#585 review: a decision proposed from a discussion on an approvers-only document (a PRD
set to approvers, a pricing memo) is hidden with that document, and so is the discussion.

Each test's card: protects=<the observable>; fails_when=<the wrong result>;
no_claim=<what green does not prove>. Synthetic placeholders only.
"""

import uuid

import pytest
from sqlalchemy import select

from oracle.decisions.models import Decision
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx, set_token_role
from tests.decision_helpers import clock  # noqa: F401
from tests.pricing_helpers import approved_memo
from tests.test_discussion_changes import _tenant, act, add_change
from tests.test_discussions import company, section, start, uid
from tests.test_mcp import api_token, mcp_client, text_of

TITLE = "Hold the trial length at fourteen days"
THREAD = "Trial length for the hidden plan"
READERS = ["commenter", "viewer", "token:commenter", "token:viewer"]


async def _hidden_prd(client) -> tuple:
    ctx, doc = await company(client)
    async with tenant_session(ctx.tenant_id) as s:
        (await s.get(Document, uuid.UUID(doc))).visibility = "approvers"
        await s.commit()
    return ctx, section(doc)


async def _memo(client) -> tuple:
    ctx = await make_ctx()
    slug = await approved_memo(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == slug))
        assert doc.visibility == "approvers"
        key = await s.scalar(
            select(Section.section_key)
            .join(DocumentVersion, DocumentVersion.id == Section.version_id)
            .where(DocumentVersion.document_id == doc.id, DocumentVersion.number == 2)
            .limit(1)
        )
    return ctx, section(str(doc.id), version=2, key=key)


SETUPS = {"prd": _hidden_prd, "memo": _memo}


async def _proposed(client, ctx, subject) -> tuple[str, dict]:
    """An approver's discussion on the hidden document and the decision proposed from it."""
    _tenant[0] = ctx.tenant_id
    d = await start(client, ctx, who="approver", subject=subject, title=THREAD)
    cid = await add_change(ctx.tenant_id, d["id"], "decision",
                           {"title": TITLE, "approver_id": uid(ctx, "approver")})  # fmt: skip
    out = await act(client, ctx.as_("approver"), cid, "propose")
    return d["id"], out["result"]


async def _headers(ctx, who: str) -> dict:
    if who.startswith("token:"):
        await set_token_role(ctx, who.split(":")[1])
        return ctx.as_("token")
    return ctx.as_(who)


def _leaks(text: str) -> bool:
    return TITLE in text or THREAD in text


async def _absent(client, ctx, who, d_id, ref) -> None:
    me = await _headers(ctx, who)
    resp = await client.get("/v1/decisions", headers=me)
    assert resp.status_code == 200 and not _leaks(resp.text), resp.text
    for path in (f"/v1/decisions/{ref['number']}", f"/v1/decisions/{ref['decision_id']}",
                 f"/v1/discussions/{d_id}"):  # fmt: skip
        resp = await client.get(path, headers=me)
        assert resp.status_code == 404, (path, resp.text)
    for path in ("/v1/inbox", "/v1/plan", "/v1/discussions", "/v1/decisions/people"):
        resp = await client.get(path, headers=me)
        assert not _leaks(resp.text), (path, resp.text)
    hits = await client.get("/v1/search", params={"q": "fourteen days"}, headers=me)
    assert not _leaks(hits.text), hits.text


# protects=a decision proposed from a discussion on an approvers-only PRD or a pricing memo
# names the document and is absent, with its discussion, from a commenter's and a viewer's
# decision log, direct read, Inbox, Plan, discussion list and search, cookie or API token,
# and an approver still reads it; fails_when=the decision names only the discussion and
# passes the visibility rule (#585 BLOCKER 1); no_claim=the web pages (they read these).
@pytest.mark.parametrize("who", READERS)
@pytest.mark.parametrize("kind", list(SETUPS))
async def test_a_discussions_decision_follows_its_document(client, kind, who):
    ctx, subject = await SETUPS[kind](client)
    d_id, ref = await _proposed(client, ctx, subject)
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(Decision, uuid.UUID(ref["decision_id"]))
        named = {(x["kind"], x["id"]) for x in row.subjects}
        assert ("document", subject["document_id"]) in named, row.subjects
    seen = await client.get(f"/v1/decisions/{ref['number']}", headers=ctx.as_("approver"))
    assert seen.status_code == 200, seen.text
    await _absent(client, ctx, who, d_id, ref)


# protects=a decision made before the fix (its only subject the discussion) is hidden at read
# time from a reader who may not see the discussion's document; fails_when=only new
# decisions name the document; no_claim=the migration of old rows (none: read time).
@pytest.mark.parametrize("who", READERS)
@pytest.mark.parametrize("kind", list(SETUPS))
async def test_an_older_decision_naming_only_the_discussion_is_hidden(client, kind, who):
    ctx, subject = await SETUPS[kind](client)
    d_id, ref = await _proposed(client, ctx, subject)
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(Decision, uuid.UUID(ref["decision_id"]))
        row.subjects = [x for x in row.subjects if x["kind"] == "discussion"]
        await s.commit()
    await _absent(client, ctx, who, d_id, ref)


# protects=MCP's list_decisions and get_decision miss the decision for a commenter's and a
# viewer's token, and an approver's token gets it; fails_when=MCP reads it; no_claim=other
# MCP tools (they read through the same rule).
@pytest.mark.parametrize("role", ["commenter", "viewer"])
@pytest.mark.parametrize("kind", list(SETUPS))
async def test_mcp_misses_a_discussions_hidden_decision(client, kind, role):
    ctx, subject = await SETUPS[kind](client)
    _d_id, ref = await _proposed(client, ctx, subject)
    async with mcp_client(await api_token(ctx.tenant_id, role)) as c:
        listed = await c.call_tool("list_decisions", {})
        assert not _leaks(text_of(listed)), text_of(listed)
        got = await c.call_tool("get_decision", {"decision": ref["number"]})
        assert got.is_error or not _leaks(text_of(got)), text_of(got)
    async with mcp_client(await api_token(ctx.tenant_id, "approver")) as c:
        got = await c.call_tool("get_decision", {"decision": ref["number"]})
        assert not got.is_error and TITLE in text_of(got), text_of(got)


# protects=a discussion on a company PRD keeps its decision company-wide; fails_when=the
# rule hides every discussion's decision; no_claim=other subjects.
async def test_a_company_documents_discussion_decision_stays_visible(client):
    ctx, doc = await company(client)
    d_id, ref = await _proposed(client, ctx, section(doc))
    me = ctx.as_("commenter")
    assert (await client.get(f"/v1/decisions/{ref['number']}", headers=me)).status_code == 200
    assert (await client.get(f"/v1/discussions/{d_id}", headers=me)).status_code == 200
