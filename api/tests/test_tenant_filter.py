"""Directly executed Core statements filter by company (security report c5b8604f, MAJOR 1),
and a run token on REST acts only in Oracle's in-process MCP call (its minor 1).

Tenant scoping (oracle.tenancy) rewrites ORM statements only: a select on
``Model.__table__`` or a ``text()`` statement must name the company itself."""

import uuid
from types import SimpleNamespace

from oracle.auth.deps import RUN_HEADER, RUN_TOKEN_HEADER, Principal
from oracle.auth.service import create_user, make_session_cookie, sign_run_binding
from oracle.config import get_settings
from oracle.decisions.models import Decision
from oracle.docs import visibility
from oracle.docs.models import Document
from oracle.runs.models import Run
from oracle.runtokens import mint_run_token
from oracle.tenancy import tenant_session
from tests.conftest import make_tenant

# Long enough to be looked for in text (visibility._MIN_TITLE).
B_DOC_TITLE = "Board update for the other company"
B_DECISION_TITLE = "Pause the other company's pilot"


def _decision(number: int, title: str, approver: uuid.UUID, **kw) -> Decision:
    return Decision(
        number=number, title=title, approver_id=approver, driver="oracle", origin="manual", **kw
    )


async def _company_b() -> tuple[uuid.UUID, uuid.UUID, uuid.UUID]:
    """Company B: an approvers-only document and the decision naming it (hidden from B's
    commenters), D-5. Returns (tenant, document id, decision id)."""
    tenant = await make_tenant("Company B")
    async with tenant_session(tenant) as s:
        doc = Document(slug="board-update-b", title=B_DOC_TITLE, kind="update")
        doc.visibility = "approvers"
        s.add(doc)
        await s.flush()
        decision = _decision(
            5, B_DECISION_TITLE, uuid.uuid4(), subjects=[{"kind": "document", "id": str(doc.id)}]
        )
        s.add(decision)
        await s.commit()
        return tenant, doc.id, decision.id


async def _company_a() -> tuple[uuid.UUID, uuid.UUID]:
    """Company A: its own company-wide D-5. Returns (tenant, a commenter's id)."""
    tenant = await make_tenant("Company A")
    async with tenant_session(tenant) as s:
        s.add(_decision(5, "Ship the onboarding checklist first", uuid.uuid4()))
        user = await create_user(s, f"commenter-{uuid.uuid4().hex[:6]}@example.com", "pw")
        user.role = "commenter"
        await s.commit()
        return tenant, user.id


async def test_hidden_for_reader_names_only_the_readers_company():
    b, b_doc, b_decision = await _company_b()
    a, commenter = await _company_a()
    async with tenant_session(b) as s:
        own = await visibility.hidden_for_reader(s, as_member=True)
    # B's own commenters do not see them (the rule still holds within B).
    assert own is not None and b_doc in own.document_ids and b_decision in own.decision_ids
    for as_member in (True, False):
        async with tenant_session(a) as s:
            principal = Principal(tenant_id=a, kind="user", role="commenter", user_id=commenter)
            visibility.bind(s, principal)
            hidden = await visibility.hidden_for_reader(s, as_member=as_member)
        assert hidden is not None
        assert b_doc not in hidden.document_ids
        assert b_decision not in hidden.decision_ids
        assert not {str(b_doc), str(b_decision)} & hidden.ids
        assert B_DOC_TITLE.casefold() not in hidden.words
        assert B_DECISION_TITLE.casefold() not in hidden.words
        assert 5 not in hidden.numbers
        # B's hidden D-5 does not hide A's suggestion that names A's own visible D-5,
        # nor does its title tell A that B has such a document.
        assert not hidden.names("Revisit D-5 before the launch")
        assert not hidden.names(f"See {B_DOC_TITLE}")


async def test_hidden_decision_ids_only_of_the_readers_company():
    b, _doc, b_decision = await _company_b()
    a, _commenter = await _company_a()
    async with tenant_session(a) as s:
        assert await visibility.hidden_decision_ids(s, [b_decision], as_member=True) == set()
    async with tenant_session(b) as s:
        assert await visibility.hidden_decision_ids(s, [b_decision], as_member=True) == {b_decision}


async def test_disabled_check_by_sql_reads_only_the_company(monkeypatch):
    """roadmap.router._is_disabled's text() read of ``users`` (the path for a database
    whose User model does not map ``disabled_at`` yet) names the company."""
    from datetime import UTC, datetime

    from oracle.roadmap import router

    b = await make_tenant("Company B")
    async with tenant_session(b) as s:
        other = await create_user(s, f"gone-{uuid.uuid4().hex[:6]}@example.com", "pw")
        other.disabled_at = datetime.now(UTC)
        await s.commit()
    a = await make_tenant("Company A")
    monkeypatch.setattr(router, "User", SimpleNamespace(__table__=SimpleNamespace(c={})))
    async with tenant_session(a) as s:
        assert await router._is_disabled(s, SimpleNamespace(id=other.id)) is False
    async with tenant_session(b) as s:
        assert await router._is_disabled(s, SimpleNamespace(id=other.id)) is True


async def _creator_with_run(scopes: list[str]) -> tuple[uuid.UUID, dict[str, str], str]:
    tenant = await make_tenant()
    async with tenant_session(tenant) as s:
        user = await create_user(s, f"owner-{uuid.uuid4().hex[:6]}@example.com", "pw")
        user.role = "owner"
        await s.flush()
        run = Run(flow="baseline_to_prd", status="running", created_by=user.id)
        s.add(run)
        await s.flush()
        raw = await mint_run_token(s, run.id, scopes, 600)
        await s.commit()
        cookie = f"{get_settings().session_cookie_name}={make_session_cookie(user)}"
        return run.id, {"Cookie": cookie, "_user": str(user.id)}, raw


async def test_rest_refuses_a_run_token_outside_the_in_process_mcp_call(client):
    """Sent straight to REST (no server-signed run binding), a run token is refused: it
    would skip /mcp's egress allowlist and act with the creator's whole role instead of
    the token's scopes."""
    run_id, person, raw = await _creator_with_run(["read:documents"])
    user_id = uuid.UUID(person.pop("_user"))
    assert (await client.get("/v1/documents", headers=person)).status_code == 200
    resp = await client.get("/v1/documents", headers={**person, RUN_TOKEN_HEADER: raw})
    assert resp.status_code == 403, resp.text
    # A binding for another run does not make it the run's call either.
    other = sign_run_binding(user_id, uuid.uuid4())
    resp = await client.get(
        "/v1/documents", headers={**person, RUN_TOKEN_HEADER: raw, RUN_HEADER: other}
    )
    assert resp.status_code in (400, 403), resp.text
    # The in-process MCP call carries both, for the same run: it is the run's call.
    binding = sign_run_binding(user_id, run_id)
    resp = await client.get(
        "/v1/documents", headers={**person, RUN_TOKEN_HEADER: raw, RUN_HEADER: binding}
    )
    assert resp.status_code == 200, resp.text
