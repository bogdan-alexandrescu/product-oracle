"""CR-06 security review fixes (PR #16): the publish gate sees real source
revocations (M1), a section edit stays inside its section (M2), AI text never replaces
approved text without a patch (M3), a section's revision covers its evidence (M4), and
the minors (publish lock, latest version only, re-approval, required sections fail
closed, base versions, immutable deletes, the decider behind an API token).

Synthetic placeholders only."""

import asyncio
import inspect
import json
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace

import httpx
import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError

from oracle import readiness
from oracle.audit import AuditEvent
from oracle.auth.deps import Principal
from oracle.auth.models import ApiToken, User
from oracle.auth.service import create_api_token
from oracle.baseline.models import Entity, Evidence
from oracle.config import get_settings
from oracle.connections.models import Connection
from oracle.docs import service as docs_service
from oracle.docs.models import Document, DocumentVersion
from oracle.docs.parser import DraftError
from oracle.main import app
from oracle.members.models import Invite
from oracle.models import Tenant
from oracle.review import publish
from oracle.review.models import DocumentPublication, FeedbackItem, SectionPatch, SectionReview
from oracle.runs import service
from oracle.runs.models import Run, RunSegment
from oracle.runtokens import RunToken, mint_run_token
from oracle.sources.models import Source, SourceItem
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from oracle.tenancy import tenant_session, unscoped_session
from oracle.v2.models import ChangeEvent, DocumentSectionLink
from tests.connection_helpers import add_connection, clear_provider_http, use_provider_http
from tests.fixtures import seed_auth
from tests.legacy.helpers import run_cli
from tests.review_v2_helpers import (  # noqa: F401 (local_runtime: a fixture)
    DOC,
    DRAFT,
    MARKDOWN,
    approve_all,
    edit,
    import_md,
    local_runtime,
    person,
    replace,
    setup,
    states,
    verdict,
)
from tests.test_adapter_v2 import _decide_raw, _waiting, adapter_v2_env, feedback_doc, on  # noqa: F401
from tests.test_runs import decide, get, started, tick


@pytest.fixture(autouse=True)
def _only_test_checks():
    with readiness.isolated_checks():
        yield


async def approved(client, ctx, n: int = 1, headers=None) -> None:
    resp = await client.post(ctx.v(n, "/approve"), headers=headers or ctx.auth)
    assert resp.status_code == 200, resp.text


async def check(client, ctx, n: int = 1) -> dict:
    resp = await client.get(ctx.v(n, "/publish-check"), headers=ctx.auth)
    assert resp.status_code == 200, resp.text
    return resp.json()


def codes(body: dict) -> list[str]:
    return [b["code"] for b in body["blockers"]]


def principal_of(ctx, user_id: uuid.UUID, role: str = "owner", **kw) -> Principal:
    return Principal(tenant_id=ctx.tenant_id, kind="user", role=role, user_id=user_id, **kw)


# --- M1: real source revocations -------------------------------------------------------

SURVEY_URL = "https://Example.com/calendar-survey"


async def _source_item(ctx, owner, *, connection_id=None, url=SURVEY_URL) -> tuple:
    async with tenant_session(ctx.tenant_id) as s:
        source = Source(
            owner_user_id=owner.user_id,
            kind="github" if connection_id else "upload",
            name=f"Survey {uuid.uuid4().hex[:6]}",
            connection_id=connection_id,
        )
        s.add(source)
        await s.flush()
        item = SourceItem(
            source_id=source.id, external_id="survey.md", kind="file", title="Survey", url=url
        )
        s.add(item)
        await s.commit()
        return source.id, item.id


async def _delete_source(client, owner, source_id) -> None:
    resp = await client.delete(f"/v1/sources/{source_id}", headers=owner.headers)
    assert resp.status_code == 204, resp.text


async def test_a_cited_source_deleted_blocks_publish(client):
    """The citation names the item by URL (normalized: case of the host, a trailing
    slash); deleting the source records a source_permission tombstone."""
    ctx = await setup(client)
    await approved(client, ctx)
    owner = await person(ctx.tenant_id, "owner", "source-owner")
    source_id, item_id = await _source_item(ctx, owner, url="https://EXAMPLE.com/calendar-survey/")
    assert (await check(client, ctx))["can_publish"] is True

    await _delete_source(client, owner, source_id)
    body = await check(client, ctx)
    assert codes(body) == ["source_permission_revoked"]
    assert body["blockers"][0]["section_keys"] == ["goal-trace"]
    resp = await client.post(ctx.v(1, "/publish"), json={}, headers=ctx.auth)
    assert resp.status_code == 409
    assert resp.json()["check"]["blockers"][0]["code"] == "source_permission_revoked"
    async with tenant_session(ctx.tenant_id) as s:
        # One tombstone; the sections it reaches are recorded as changes of their own
        # (oracle.trace).
        [event] = (
            await s.scalars(
                select(ChangeEvent).where(ChangeEvent.subject_kind == "source_permission")
            )
        ).all()
        assert (event.subject_kind, event.cause, event.subject_id) == (
            "source_permission",
            "source_deleted",
            source_id,
        )
        assert str(item_id) in event.data["item_ids"]
        assert (await s.scalars(select(DocumentPublication))).all() == []


async def test_a_citation_by_item_id_is_matched(client):
    ctx = await setup(client)
    owner = await person(ctx.tenant_id, "owner", "source-owner")
    source_id, item_id = await _source_item(ctx, owner, url=None)
    draft = replace(DRAFT, "ref: https://example.com/calendar-survey", f"ref: {item_id}")
    v2 = await import_md(client, ctx.auth, draft)
    assert v2.status_code == 201, v2.text
    await approved(client, ctx, 2)
    assert (await check(client, ctx, 2))["can_publish"] is True
    await _delete_source(client, owner, source_id)
    assert codes(await check(client, ctx, 2)) == ["source_permission_revoked"]


async def test_a_deleted_connection_blocks_evidence_and_entity_links(client):
    """Links to baseline evidence and to entities are followed back to their source
    items; deleting the connection those items came through revokes them."""
    ctx = await setup(client)
    await approved(client, ctx)
    owner = await person(ctx.tenant_id, "owner", "source-owner")
    conn = await add_connection(ctx.tenant_id, owner.user_id, "github")
    _, item_id = await _source_item(ctx, owner, connection_id=conn.id, url="https://x.test/a")
    async with tenant_session(ctx.tenant_id) as s:
        goal = Entity(type="goal", key="retention", title="Retention", origin="user")
        feature = Entity(type="feature", key="calendar", title="Calendar", origin="user")
        s.add_all([goal, feature])
        await s.flush()
        evidence = Evidence(entity_id=goal.id, source_item_id=item_id, excerpt="Teams plan")
        s.add_all([evidence, Evidence(entity_id=feature.id, source_item_id=item_id, excerpt="Cal")])
        await s.flush()
        document = await s.scalar(select(Document).where(Document.slug == DOC))
        s.add_all(
            [
                DocumentSectionLink(
                    document_id=document.id,
                    section_key="problem",
                    kind="evidences",
                    evidence_id=evidence.id,
                ),
                DocumentSectionLink(
                    document_id=document.id,
                    section_key="solution",
                    kind="implements",
                    entity_id=feature.id,
                ),
            ]
        )
        await s.commit()
    assert (await check(client, ctx))["can_publish"] is True

    use_provider_http(lambda request: httpx.Response(204))
    try:
        resp = await client.delete(f"/v1/connections/{conn.id}", headers=owner.headers)
    finally:
        clear_provider_http()
    assert resp.status_code == 204, resp.text
    body = await check(client, ctx)
    assert codes(body) == ["source_permission_revoked"]
    assert body["blockers"][0]["section_keys"] == ["problem", "solution"]


async def test_a_deleted_source_with_a_direct_section_link_blocks(client):
    ctx = await setup(client)
    await approved(client, ctx)
    owner = await person(ctx.tenant_id, "owner", "source-owner")
    source_id, item_id = await _source_item(ctx, owner, url="https://x.test/b")
    async with tenant_session(ctx.tenant_id) as s:
        document = await s.scalar(select(Document).where(Document.slug == DOC))
        s.add(
            DocumentSectionLink(
                document_id=document.id,
                section_key="risks",
                kind="evidences",
                source_item_id=item_id,
            )
        )
        await s.commit()
    await _delete_source(client, owner, source_id)
    body = await check(client, ctx)
    assert codes(body) == ["source_permission_revoked"]
    assert body["blockers"][0]["section_keys"] == ["risks"]


# --- M2: a section edit stays inside its section ---------------------------------------


async def _owned_by_commenter(client, ctx, key: str = "solution"):
    commenter = await person(ctx.tenant_id, "commenter", "section-owner")
    resp = await client.put(
        f"/v1/documents/{DOC}/sections/{key}/assignment",
        json={"owner_id": str(commenter.user_id)},
        headers=ctx.auth,
    )
    assert resp.status_code == 200, resp.text
    return commenter


@pytest.mark.parametrize(
    "body",
    [
        # A new section after this one.
        "A shared calendar view.\n\n## Pricing {#pricing}\n\nFree.",
        # A level-1 section.
        "A shared calendar view.\n\n# Takeover {#takeover}",
        # Another section's id, rewriting it.
        "A shared calendar view.\n\n## Risks {#risks}\n\nNo risks at all.",
        # An unclosed code fence swallowing every later section.
        "A shared calendar view.\n\n```\n",
        # A setext heading.
        "A shared calendar view.\n\nInjected\n========",
        # Indented fence variant and a tilde fence.
        "A shared calendar view.\n\n~~~~\n",
    ],
)
async def test_a_section_edit_cannot_reach_other_sections(client, body):
    ctx = await setup(client)
    commenter = await _owned_by_commenter(client, ctx)
    s1 = await states(client, ctx.auth, 1)
    resp = await edit(client, commenter.headers, "solution", 1, s1["solution"]["revision"], body)
    assert resp.status_code == 422, resp.text
    # Approvers are held to the same rule: a section edit edits one section.
    resp = await edit(client, ctx.auth, "solution", 1, s1["solution"]["revision"], body)
    assert resp.status_code == 422, resp.text
    versions = (await client.get(f"/v1/documents/{DOC}/versions", headers=ctx.auth)).json()
    assert [v["number"] for v in versions] == [1]


async def test_a_section_heading_cannot_carry_another_id(client):
    ctx = await setup(client)
    s1 = await states(client, ctx.auth, 1)
    resp = await edit(
        client,
        ctx.auth,
        "solution",
        1,
        s1["solution"]["revision"],
        "Body.",
        heading="Solution {#risks}\n\n## Extra {#extra}",
    )
    assert resp.status_code == 422, resp.text


async def test_an_owner_resolves_only_their_sections_feedback(client):
    ctx = await setup(client)
    commenter = await _owned_by_commenter(client, ctx)
    items = {}
    for key in ("solution", "risks"):
        created = await client.post(
            ctx.v(1, "/comments"),
            json={"section_key": key, "anchor": {"exact": "a"}, "body": f"About {key}"},
            headers=ctx.auth,
        )
        items[key] = created.json()["feedback_item_id"]
    s1 = await states(client, ctx.auth, 1)
    rev = s1["solution"]["revision"]
    # Closing another section's feedback takes the approver role.
    resp = await edit(
        client,
        commenter.headers,
        "solution",
        1,
        rev,
        "A shared calendar view per team.",
        resolutions=[{"feedback_id": items["risks"], "status": "declined"}],
    )
    assert resp.status_code == 403, resp.text
    resp = await edit(
        client,
        commenter.headers,
        "solution",
        1,
        rev,
        "A shared calendar view per team.",
        resolutions=[{"feedback_id": items["solution"], "status": "addressed", "note": "Done"}],
    )
    assert resp.status_code == 201, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        rows = {i.section_key: i.status for i in await s.scalars(select(FeedbackItem))}
        assert rows == {"solution": "addressed", "risks": "open"}
        from oracle.audit import AuditEvent

        [event] = (
            await s.scalars(select(AuditEvent).where(AuditEvent.action == "feedback.resolve"))
        ).all()
        assert event.actor == f"user:{commenter.user_id}"

    # An approver closes any feedback from a section edit.
    s2 = await states(client, ctx.auth, 2)
    resp = await edit(
        client,
        ctx.auth,
        "solution",
        2,
        s2["solution"]["revision"],
        "A shared calendar view per project team.",
        resolutions=[{"feedback_id": items["risks"], "status": "declined"}],
    )
    assert resp.status_code == 201, resp.text


# --- M3: AI text never replaces approved text without a patch ----------------------------


@pytest.mark.usefixtures("local_runtime")
async def test_a_run_token_push_is_an_agent_draft(client):
    """MCP push_draft under a run token carries the run: the approved-section hold
    applies even though the REST call is made for the run's creator."""
    from oracle.runs.models import Run
    from oracle.runtokens import mint_run_token
    from tests.legacy.helpers import mcp_session

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    assert (await verdict(client, ctx.auth, 1, "problem")).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        run = Run(flow="baseline_to_prd", created_by=pm.user_id)
        s.add(run)
        await s.flush()
        token = await mint_run_token(s, run.id, ["write:drafts", "read:documents"], 600)
        await s.commit()
        run_id = run.id
    agent = replace(DRAFT, "Teams miss shared deadlines.", "The agent's problem.")
    async with mcp_session(token) as c:
        tools = {t.name: t for t in (await c.list_tools()).tools}
        assert "base_version" not in tools["push_draft"].input_schema["required"]
        pushed = await c.call_tool("push_draft", {"doc": DOC, "markdown": agent, "base_version": 1})
        assert not pushed.is_error, pushed.content
        via_rest = await c.call_tool(
            "import_version",
            {"doc": DOC, "body": replace(agent, "Owner: product.", "Owner: agents.")},
        )
        assert not via_rest.is_error, via_rest.content
    v2 = pushed.structured_content
    assert [w["code"] for w in v2["warnings"]] == ["approved_section_held"]
    assert {s["section_key"]: s["body_md"] for s in v2["sections"]}["problem"] == (
        "Teams miss shared deadlines."
    )
    v3 = via_rest.structured_content
    assert {s["section_key"]: s["body_md"] for s in v3["sections"]}["problem"] == (
        "Teams miss shared deadlines."
    )
    async with tenant_session(ctx.tenant_id) as s:
        rows = (await s.scalars(select(SectionPatch).order_by(SectionPatch.created_at))).all()
        assert [(p.section_key, p.origin, p.run_id) for p in rows] == [
            ("problem", "run", run_id),
            ("problem", "run", run_id),
        ]


async def test_a_forged_run_header_is_refused(client):
    ctx = await setup(client)
    resp = await client.get(
        f"/v1/documents/{DOC}", headers={**ctx.auth, "x-oracle-run-token": "ort_forged"}
    )
    # Refused before it is read: a run token counts only in Oracle's in-process MCP call.
    assert resp.status_code == 403


async def _agent_import(ctx, markdown: str):
    owner = await person(ctx.tenant_id, "owner", "run-creator")
    async with tenant_session(ctx.tenant_id) as s:
        return await docs_service.import_draft(
            s, DOC, markdown, principal_of(ctx, owner.user_id), cause="run_draft", origin="run"
        )


async def test_an_agent_cannot_remove_or_rename_an_approved_section(client):
    ctx = await setup(client)
    for key in ("problem", "risks"):
        assert (await verdict(client, ctx.auth, 1, key)).status_code == 200
    removed = replace(DRAFT, "## Problem {#problem}\n\nTeams miss shared deadlines.\n\n", "")
    renamed = replace(removed, "## Risks {#risks}", "## Risks {#risk-register}")
    result = await _agent_import(ctx, renamed)
    v2 = result.version
    keys = [s.section_key for s in v2.sections]
    # Both approved sections are kept in place with their approved text.
    assert keys == [
        "title",
        "goal-trace",
        "problem",
        "solution",
        "risks",
        "risk-register",
        "sources",
    ]
    bodies = {s.section_key: s.body_md for s in v2.sections}
    assert bodies["problem"] == "Teams miss shared deadlines."
    assert bodies["risks"] == "Calendar sync may lag."
    s2 = await states(client, ctx.auth, 2)
    assert s2["problem"]["status"] == s2["risks"]["status"] == "approved"
    patches = (
        await client.get(f"/v1/documents/{DOC}/section-patches?status=open", headers=ctx.auth)
    ).json()
    assert sorted((p["section_key"], p["action"]) for p in patches) == [
        ("problem", "remove"),
        ("risks", "remove"),
    ]
    # Accepting the removal is the reviewed change that drops the section.
    [problem] = [p for p in patches if p["section_key"] == "problem"]
    detail = (await client.get(f"/v1/section-patches/{problem['id']}", headers=ctx.auth)).json()
    resp = await client.post(
        f"/v1/section-patches/{problem['id']}/accept",
        json={"base_revision": detail["current_revision"], "lock_version": detail["lock_version"]},
        headers=ctx.auth,
    )
    assert resp.status_code == 201, resp.text
    assert "problem" not in [s["section_key"] for s in resp.json()["sections"]]
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(SectionPatch, uuid.UUID(problem["id"]))
        assert row.status == "accepted" and row.applied_version == 3


async def test_an_agent_cannot_rewrite_an_approved_sections_citations(client):
    ctx = await setup(client)
    assert (await verdict(client, ctx.auth, 1, "goal-trace")).status_code == 200
    agent = replace(
        replace(DRAFT, "title: Calendar survey", "title: Calendar survey\n    excerpt: Invented"),
        "ref: https://example.com/calendar-survey",
        "ref: https://example.com/another-page",
    )
    result = await _agent_import(ctx, agent)
    [c1] = [c for c in result.version.citations if c.cite_key == "c1"]
    assert (c1.ref, c1.excerpt) == ("https://example.com/calendar-survey", None)
    s2 = await states(client, ctx.auth, 2)
    assert s2["goal-trace"]["status"] == "approved"


# --- M4: a section's revision covers its evidence ----------------------------------------


async def test_a_citation_change_changes_the_revision_and_invalidates(client):
    ctx = await setup(client)
    assert (await verdict(client, ctx.auth, 1, "goal-trace")).status_code == 200
    assert (await verdict(client, ctx.auth, 1, "problem")).status_code == 200
    s1 = await states(client, ctx.auth, 1)
    changed = replace(
        DRAFT, "title: Calendar survey", "title: Calendar survey\n    excerpt: 9 of 10"
    )
    assert (await import_md(client, ctx.auth, changed, base=1)).status_code == 201
    s2 = await states(client, ctx.auth, 2)
    assert s2["goal-trace"]["revision"] != s1["goal-trace"]["revision"]
    assert s2["goal-trace"]["status"] == "approval_stale"
    assert s2["problem"]["status"] == "approved"
    async with tenant_session(ctx.tenant_id) as s:
        keys = [
            e.data["section_key"]
            for e in await s.scalars(select(ChangeEvent))
            if e.subject_kind == "document_section"
        ]
    assert keys == ["goal-trace"]


async def test_brief_membership_changes_the_revision(client):
    ctx = await setup(client)
    assert (await verdict(client, ctx.auth, 1, "problem")).status_code == 200
    briefed = replace(
        DRAFT, "title: Team calendar PRD\n", "title: Team calendar PRD\nbrief: [problem]\n"
    )
    assert (await import_md(client, ctx.auth, briefed, base=1)).status_code == 201
    s2 = await states(client, ctx.auth, 2)
    assert s2["problem"]["layer"] == "brief"
    assert s2["problem"]["status"] == "approval_stale"
    assert s2["solution"]["status"] == "unreviewed"


# --- minors ------------------------------------------------------------------------------


async def test_publish_only_the_latest_version_unless_the_company_allows(client):
    ctx = await setup(client)
    await approved(client, ctx)
    v2 = replace(DRAFT, "Owner: product.", "Owner: growth.")
    assert (await import_md(client, ctx.auth, v2, base=1)).status_code == 201
    body = await check(client, ctx, 1)
    assert codes(body) == ["superseded_version"]
    resp = await client.put(
        "/v1/settings/publish_latest_only", json={"value": False}, headers=ctx.auth
    )
    assert resp.status_code == 200, resp.text
    assert (await check(client, ctx, 1))["can_publish"] is True
    bad = await client.put(
        "/v1/settings/publish_latest_only", json={"value": "no"}, headers=ctx.auth
    )
    assert bad.status_code == 422
    listed = {s["key"]: s for s in (await client.get("/v1/settings", headers=ctx.auth)).json()}
    assert listed["publish_latest_only"]["default"] is True


async def test_a_decider_set_later_reapproves_the_version(client):
    ctx = await setup(client)
    await approved(client, ctx)
    decider = await person(ctx.tenant_id, "approver", "decider")
    resp = await client.put(
        f"/v1/documents/{DOC}/review-policy",
        json={"decider_id": str(decider.user_id)},
        headers=ctx.auth,
    )
    assert resp.status_code == 200, resp.text
    assert codes(await check(client, ctx)) == ["approval_not_by_decider"]
    await approved(client, ctx, headers=decider.headers)
    body = await check(client, ctx)
    assert body["can_publish"] is True, body["blockers"]
    assert body["approved_by"] == str(decider.user_id)


async def test_the_decider_behind_an_api_token_is_the_user(client):
    ctx = await setup(client)
    decider = await person(ctx.tenant_id, "approver", "decider")
    async with tenant_session(ctx.tenant_id) as s:
        _, raw = await create_api_token(s, "decider-agent", user_id=decider.user_id)
        await s.commit()
    token = {"Authorization": f"Bearer {raw}"}
    resp = await client.put(
        f"/v1/documents/{DOC}/review-policy",
        json={"decider_id": str(decider.user_id), "mandatory_reviewer_ids": [str(decider.user_id)]},
        headers=ctx.auth,
    )
    assert resp.status_code == 200, resp.text
    await approve_all(client, token, 1)
    await approved(client, ctx, headers=token)
    body = await check(client, ctx)
    assert body["can_publish"] is True, body["blockers"]
    assert body["approved_by"] == str(decider.user_id)


@pytest.mark.parametrize(
    ("template", "version"),
    [("no-such-template", '"1"'), ("oracle-default", '"latest"'), ("oracle-default", '"99"')],
)
async def test_an_unresolvable_template_fails_closed(client, template, version):
    templated = replace(
        DRAFT,
        "title: Team calendar PRD\n",
        f"title: Team calendar PRD\ntemplate: {template}\ntemplate_version: {version}\n",
    )
    ctx = await setup(client, templated)
    await approved(client, ctx)
    body = await check(client, ctx)
    assert codes(body) == ["template_unresolved"]
    assert template in body["blockers"][0]["message"]


async def test_rest_imports_without_a_base_are_flagged(client):
    ctx = await setup(client)
    v2 = replace(DRAFT, "Owner: product.", "Owner: growth.")
    resp = await import_md(client, ctx.auth, v2)
    assert resp.status_code == 201
    assert resp.json()["warnings"] == []
    assert [n["code"] for n in resp.json()["notes"]] == ["base_version_missing"]
    v3 = replace(v2, "Owner: growth.", "Owner: design.")
    resp = await import_md(client, ctx.auth, v3, base=2)
    assert resp.status_code == 201 and resp.json()["notes"] == []


async def test_front_matter_changed_since_the_base_is_a_conflict(client):
    ctx = await setup(client)
    v2 = replace(DRAFT, "title: Team calendar PRD\n", "title: Team calendar PRD (renamed)\n")
    assert (await import_md(client, ctx.auth, v2, base=1)).status_code == 201
    mine = replace(DRAFT, "Calendar sync may lag.", "Sync lags.")
    resp = await import_md(client, ctx.auth, mine, base=1)
    assert resp.status_code == 409, resp.text
    body = resp.json()
    assert body["code"] == "version_conflict" and body["front_matter_changed"] is True
    # The draft that already has version 2's front matter goes in.
    merged = replace(v2, "Calendar sync may lag.", "Sync lags.")
    assert (await import_md(client, ctx.auth, merged, base=1)).status_code == 201


async def test_cli_push_sends_the_base_it_pulled(client, tmp_path):
    ctx = await setup(client)
    token = ctx.auth["Authorization"].split(" ", 1)[1]
    code, out, _ = await run_cli(
        client, ["pull", DOC, "--version", "1", "--out", str(tmp_path)], token
    )
    assert code == 0, out
    pulled = tmp_path / f"{DOC}-v1.md"
    v2 = replace(DRAFT, "Teams miss shared deadlines.", "Changed in v2.")
    assert (await import_md(client, ctx.auth, v2, base=1)).status_code == 201
    # The pulled draft, edited, is pushed on its base (1): version 2 changed the
    # problem since, and the draft still has version 1's problem text.
    pulled.write_text(replace(pulled.read_text(), "Calendar sync may lag.", "Lag."))
    code, out, err = await run_cli(client, ["push", str(pulled)], token)
    assert code != 0 and "409" in err, (out, err)


async def test_mcp_push_draft_creates_a_document_with_base_zero(client):
    from tests.legacy.helpers import mcp_session

    tenant_id = (await setup(client)).tenant_id
    async with tenant_session(tenant_id) as s:
        _, raw = await create_api_token(s, "agent")
        await s.commit()
    other = replace(DRAFT, "document: team-calendar", "document: other-doc")
    async with mcp_session(raw) as c:
        created = await c.call_tool(
            "push_draft", {"doc": "other-doc", "markdown": other, "base_version": 0}
        )
        assert not created.is_error, created.content
        again = await c.call_tool(
            "push_draft",
            {
                "doc": "other-doc",
                "markdown": replace(other, "Owner: product.", "x"),
                "base_version": 0,
            },
        )
        assert again.is_error
        # base_version is optional (the latest version): an unchanged draft still imports.
        left_out = await c.call_tool("push_draft", {"doc": "other-doc", "markdown": other})
        assert not left_out.is_error, left_out.content
        no_doc = await c.call_tool("push_draft", {"doc": "", "markdown": other})
        assert no_doc.is_error and "doc" in str(no_doc.content)


async def test_mcp_push_draft_without_a_base_takes_the_latest_version(client):
    """base_version is optional: left out, the draft is taken as written on the document's
    latest version (a new document when it has none)."""
    from tests.legacy.helpers import mcp_session

    ctx = await setup(client)  # team-calendar has version 1
    async with tenant_session(ctx.tenant_id) as s:
        _, raw = await create_api_token(s, "agent")
        await s.commit()
    async with mcp_session(raw) as c:
        schema = next(t for t in (await c.list_tools()).tools if t.name == "push_draft")
        assert schema.input_schema["required"] == ["doc", "markdown"]
        assert "base_version" in schema.input_schema["properties"]
        changed = replace(DRAFT, "Owner: product.", "Owner: growth.")
        pushed = await c.call_tool("push_draft", {"doc": "team-calendar", "markdown": changed})
        assert not pushed.is_error, pushed.content
        assert pushed.structured_content["number"] == 2
        fresh = replace(DRAFT, "document: team-calendar", "document: brand-new")
        created = await c.call_tool("push_draft", {"doc": "brand-new", "markdown": fresh})
        assert not created.is_error, created.content
        assert created.structured_content["number"] == 1


async def test_mcp_push_draft_with_a_stale_base_is_still_a_conflict(client):
    from tests.legacy.helpers import mcp_session

    ctx = await setup(client)
    v2 = replace(DRAFT, "Teams miss shared deadlines.", "Teams miss deadlines (v2).")
    assert (await import_md(client, ctx.auth, v2, base=1)).status_code == 201
    async with tenant_session(ctx.tenant_id) as s:
        _, raw = await create_api_token(s, "agent")
        await s.commit()
    stale = replace(DRAFT, "Calendar sync may lag.", "Calendar sync lags.")
    async with mcp_session(raw) as c:
        result = await c.call_tool(
            "push_draft", {"doc": "team-calendar", "markdown": stale, "base_version": 1}
        )
        assert result.is_error and "version_conflict" in str(result.content), result.content


async def test_publications_refuse_delete_but_a_company_delete_cascades(client):
    ctx = await setup(client)
    await approved(client, ctx)
    resp = await client.post(ctx.v(1, "/publish"), json={}, headers=ctx.auth)
    assert resp.status_code == 201, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        with pytest.raises(DBAPIError, match="immutable"):
            await s.execute(text("DELETE FROM document_publications"))
        await s.rollback()
    async with tenant_session(ctx.tenant_id) as s:
        # A published version cannot be deleted out from under its publication.
        with pytest.raises(DBAPIError):
            await s.execute(text("DELETE FROM document_versions WHERE number = 1"))
        await s.rollback()
    async with tenant_session(ctx.tenant_id) as s:
        # Deleting the document takes its publications with it.
        await s.execute(text("DELETE FROM documents"))
        await s.rollback()
    async with unscoped_session() as s:
        tenant = await s.get(Tenant, ctx.tenant_id)
        await s.delete(tenant)
        await s.commit()
    async with unscoped_session() as s:
        assert (await s.scalars(select(DocumentPublication))).all() == []


async def test_get_or_create_state_is_race_free(client):
    from oracle.review.state import get_or_create_state

    ctx = await setup(client)
    async with tenant_session(ctx.tenant_id) as s:
        document_id = await s.scalar(select(Document.id).where(Document.slug == DOC))

    async def create() -> uuid.UUID:
        async with tenant_session(ctx.tenant_id) as s:
            row = await get_or_create_state(s, document_id, "problem")
            await asyncio.sleep(0.05)
            await s.commit()
            return row.id

    a, b = await asyncio.gather(create(), create())
    assert a == b


async def test_a_verdict_waits_for_a_publish_in_progress(client):
    """The publish lock (the document row) serializes verdicts with a publish."""
    ctx = await setup(client)
    async with tenant_session(ctx.tenant_id) as s:
        await s.execute(select(Document).where(Document.slug == DOC).with_for_update())
        task = asyncio.create_task(verdict(client, ctx.auth, 1, "problem"))
        await asyncio.sleep(0.5)
        assert not task.done()
        await s.rollback()
    resp = await asyncio.wait_for(task, 10)
    assert resp.status_code == 200


async def test_a_revocation_waits_for_a_publish_in_progress(client):
    """Revocations are company-wide: they take the review gate exclusively, a publish
    takes it shared."""
    from oracle.review.publish import gate_lock

    ctx = await setup(client)
    owner = await person(ctx.tenant_id, "owner", "source-owner")
    source_id, _ = await _source_item(ctx, owner)
    async with tenant_session(ctx.tenant_id) as s:
        await gate_lock(s, shared=True)
        task = asyncio.create_task(client.delete(f"/v1/sources/{source_id}", headers=owner.headers))
        await asyncio.sleep(0.5)
        assert not task.done()
        await s.rollback()
    resp = await asyncio.wait_for(task, 10)
    assert resp.status_code == 204


def test_normalized_urls():
    from oracle.review.publish import normalize_url

    assert normalize_url("HTTPS://Example.COM:443/a/b/?q=1#frag") == "https://example.com/a/b?q=1"
    assert normalize_url("https://example.com/") == "https://example.com"
    assert normalize_url("not a url") == "not a url"
    assert normalize_url(json.dumps(None)) == "null"


async def test_an_agent_draft_changing_only_approved_sections_leaves_patches(client):
    ctx = await setup(client)
    assert (await verdict(client, ctx.auth, 1, "problem")).status_code == 200
    result = await _agent_import(
        ctx, replace(DRAFT, "Teams miss shared deadlines.", "Only the approved text changed.")
    )
    bodies = {sec.section_key: sec.body_md for sec in result.version.sections}
    assert bodies["problem"] == "Teams miss shared deadlines."
    patches = (
        await client.get(f"/v1/documents/{DOC}/section-patches?status=open", headers=ctx.auth)
    ).json()
    assert [(p["section_key"], p["body_md"]) for p in patches] == [
        ("problem", "Only the approved text changed.")
    ]


# -----------------------------------------------------------------------------
# CR-06 security review fixes, round 2 (PR #16 / #27): approvals count only while the
# approver still is one (role, membership, an active token), an agent draft cannot drop
# an approved section through an unclosed code fence, and the minors (revocation
# matching, a revision that covers citation source, retrieved_at and section links, one
# markdown env per exported section, open criticals gate publish, a run's draft closes
# only the feedback it addressed).
#
# Synthetic placeholders only.


def blocker(body: dict, code: str) -> dict:
    [b] = [b for b in body["blockers"] if b["code"] == code]
    return b


async def policy(client, ctx, **value) -> None:
    resp = await client.put(f"/v1/documents/{DOC}/review-policy", json=value, headers=ctx.auth)
    assert resp.status_code == 200, resp.text


async def set_role(client, ctx, user_id, role: str):
    return await client.patch(f"/v1/members/{user_id}", json={"role": role}, headers=ctx.auth)


SECTIONS = ["title", "goal-trace", "problem", "solution", "risks", "sources"]


# --- BLOCKER: approvals count only while the approver still is one ----------------------


async def test_a_demoted_approvers_approvals_stop_counting(client):
    ctx = await setup(client)
    await policy(client, ctx, section_approval="all_sections")
    pm = await person(ctx.tenant_id, "approver", "pm")
    await approve_all(client, pm.headers, 1)
    await approved(client, ctx, headers=pm.headers)
    assert (await check(client, ctx))["can_publish"] is True

    assert (await set_role(client, ctx, pm.user_id, "viewer")).status_code == 200
    body = await check(client, ctx)
    assert body["can_publish"] is False
    assert codes(body) == ["version_approval_lapsed", "missing_approval"]
    lapsed = blocker(body, "version_approval_lapsed")
    assert lapsed["ids"] == [str(pm.user_id)]
    assert "no longer" in lapsed["message"]
    missing = blocker(body, "missing_approval")
    assert missing["section_keys"] == SECTIONS
    assert str(pm.user_id) in missing["message"]
    s1 = await states(client, ctx.auth, 1)
    assert {s["status"] for s in s1.values()} == {"unreviewed"}
    resp = await client.post(ctx.v(1, "/publish"), json={}, headers=ctx.auth)
    assert resp.status_code == 409, resp.text

    async with tenant_session(ctx.tenant_id) as s:
        [event] = (
            await s.scalars(select(ChangeEvent).where(ChangeEvent.subject_kind == "member"))
        ).all()
        assert (event.cause, event.subject_id) == ("role_changed", pm.user_id)
        assert (event.data["before"], event.data["after"]) == ("approver", "viewer")

    # Promoted again: the approvals lapsed for good (C2), they never come back.
    assert (await set_role(client, ctx, pm.user_id, "approver")).status_code == 200
    assert codes(await check(client, ctx)) == ["version_approval_lapsed", "missing_approval"]


async def test_a_demoted_designated_decider_blocks(client):
    ctx = await setup(client)
    decider = await person(ctx.tenant_id, "approver", "decider")
    await policy(client, ctx, decider_id=str(decider.user_id))
    await approved(client, ctx, headers=decider.headers)
    assert (await check(client, ctx))["can_publish"] is True

    assert (await set_role(client, ctx, decider.user_id, "commenter")).status_code == 200
    body = await check(client, ctx)
    assert codes(body) == ["decider_not_current", "version_approval_lapsed"]
    named = blocker(body, "decider_not_current")
    assert named["ids"] == [str(decider.user_id)]
    assert "review policy" in named["message"]


async def test_a_demoted_mandatory_reviewer_blocks(client):
    ctx = await setup(client)
    reviewer = await person(ctx.tenant_id, "approver", "eng-lead")
    await policy(client, ctx, mandatory_reviewer_ids=[str(reviewer.user_id)])
    await approve_all(client, reviewer.headers, 1)
    await approved(client, ctx)
    assert (await check(client, ctx))["can_publish"] is True

    assert (await set_role(client, ctx, reviewer.user_id, "viewer")).status_code == 200
    body = await check(client, ctx)
    assert codes(body) == ["mandatory_reviewer_pending"]
    pending = blocker(body, "mandatory_reviewer_pending")
    assert pending["ids"] == [str(reviewer.user_id)]
    assert pending["section_keys"] == SECTIONS
    assert "no longer has the approver role" in pending["message"]
    s1 = await states(client, ctx.auth, 1)
    assert s1["problem"]["mandatory_approvals"] == [
        {"reviewer_id": str(reviewer.user_id), "approved": False}
    ]


async def test_a_removed_members_approvals_stop_counting(client):
    """Removing a member disables them (C2): the row stays, their approvals lapse."""
    ctx = await setup(client)
    await policy(client, ctx, section_approval="all_sections")
    pm = await person(ctx.tenant_id, "approver", "pm")
    await approve_all(client, pm.headers, 1)
    await approved(client, ctx, headers=pm.headers)
    assert (await check(client, ctx))["can_publish"] is True
    other = await person(ctx.tenant_id, "approver", "other")
    # Owners only.
    resp = await client.delete(f"/v1/members/{pm.user_id}", headers=other.headers)
    assert resp.status_code == 403
    resp = await client.delete(f"/v1/members/{pm.user_id}", headers=ctx.auth)
    assert resp.status_code == 204, resp.text
    # Removing a disabled member again is a no-op.
    assert (await client.delete(f"/v1/members/{pm.user_id}", headers=ctx.auth)).status_code == 204
    # The removed member cannot sign in with their session any more.
    assert (await client.get(f"/v1/documents/{DOC}", headers=pm.headers)).status_code == 401

    body = await check(client, ctx)
    assert codes(body) == ["version_approval_lapsed", "missing_approval"]
    async with tenant_session(ctx.tenant_id) as s:
        user = await s.get(User, pm.user_id)
        assert user is not None and user.disabled_at is not None
        [event] = (
            await s.scalars(select(ChangeEvent).where(ChangeEvent.subject_kind == "member"))
        ).all()
        assert (event.cause, event.subject_id) == ("member_disabled", pm.user_id)
        [audit] = (
            await s.scalars(select(AuditEvent).where(AuditEvent.action == "member.disable"))
        ).all()
        assert audit.entity_id == pm.user_id and audit.data["role"] == "approver"


async def test_the_last_owner_cannot_be_removed(client):
    ctx = await setup(client)
    async with tenant_session(ctx.tenant_id) as s:
        [owner] = (await s.scalars(select(User).where(User.role == "owner"))).all()
    resp = await client.delete(f"/v1/members/{owner.id}", headers=ctx.auth)
    assert resp.status_code == 409, resp.text


async def test_a_removed_members_sources_are_revoked_first(client):
    """Removing (disabling) a member revokes their sources: each gets a
    source_permission revocation, so documents citing them cannot publish."""
    ctx = await setup(client)
    await approved(client, ctx)
    analyst = await person(ctx.tenant_id, "commenter", "analyst")
    async with tenant_session(ctx.tenant_id) as s:
        source = Source(owner_user_id=analyst.user_id, kind="upload", name="Survey")
        s.add(source)
        await s.flush()
        s.add(
            SourceItem(
                source_id=source.id,
                external_id="survey.md",
                kind="file",
                url="https://example.com/calendar-survey",
            )
        )
        await s.commit()
    assert (await check(client, ctx))["can_publish"] is True
    resp = await client.delete(f"/v1/members/{analyst.user_id}", headers=ctx.auth)
    assert resp.status_code == 204, resp.text
    assert codes(await check(client, ctx)) == ["source_permission_revoked"]


async def test_a_revoked_tokens_verdicts_stop_counting(client):
    ctx = await setup(client)
    await policy(client, ctx, section_approval="all_sections")
    async with tenant_session(ctx.tenant_id) as s:
        token, raw = await create_api_token(s, "review-bot")
        token.role = "approver"
        await s.commit()
        token_id = token.id
    bot = {"Authorization": f"Bearer {raw}"}
    await approve_all(client, bot, 1)
    await approved(client, ctx, headers=bot)
    assert (await check(client, ctx))["can_publish"] is True

    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(ApiToken, token_id)
        row.revoked_at = datetime.now(UTC)
        await s.commit()
    body = await check(client, ctx)
    assert codes(body) == ["version_approval_lapsed", "missing_approval"]
    assert blocker(body, "version_approval_lapsed")["ids"] == [str(token_id)]


async def test_a_member_tokens_approval_lapses_with_the_token(client):
    """A token acting for a user approves as the user, and Oracle records the token:
    revoking it voids the approvals it gave (C2), even when revoked outside the API."""
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    async with tenant_session(ctx.tenant_id) as s:
        token, raw = await create_api_token(s, "pm-agent", user_id=pm.user_id)
        await s.commit()
        token_id = token.id
    await approved(client, ctx, headers={"Authorization": f"Bearer {raw}"})
    assert (await check(client, ctx))["can_publish"] is True
    async with tenant_session(ctx.tenant_id) as s:
        (await s.get(ApiToken, token_id)).revoked_at = datetime.now(UTC)
        await s.commit()
    assert codes(await check(client, ctx)) == ["version_approval_lapsed"]


# --- MAJOR: an unclosed code fence cannot swallow an approved section -------------------

FENCED = replace(DRAFT, "A shared calendar view per project.", "A shared calendar view.\n\n```text")


@pytest.mark.usefixtures("local_runtime")
async def test_an_unclosed_fence_push_draft_keeps_the_approved_section(client):
    from oracle.runs.models import Run
    from oracle.runtokens import mint_run_token
    from tests.legacy.helpers import mcp_session

    ctx = await setup(client)
    assert (await verdict(client, ctx.auth, 1, "risks")).status_code == 200
    pm = await person(ctx.tenant_id, "approver", "pm")
    async with tenant_session(ctx.tenant_id) as s:
        run = Run(flow="baseline_to_prd", created_by=pm.user_id)
        s.add(run)
        await s.flush()
        token = await mint_run_token(s, run.id, ["write:drafts", "read:documents"], 600)
        await s.commit()
    async with mcp_session(token) as c:
        pushed = await c.call_tool(
            "push_draft", {"doc": DOC, "markdown": FENCED, "base_version": 1}
        )
        assert not pushed.is_error, pushed.content
    v2 = pushed.structured_content
    bodies = {s["section_key"]: s["body_md"] for s in v2["sections"]}
    assert bodies["risks"] == "Calendar sync may lag."
    # The fence the agent left open is closed before the held section.
    assert bodies["solution"].endswith("```")
    s2 = await states(client, ctx.auth, 2)
    assert s2["risks"]["status"] == "approved"
    async with tenant_session(ctx.tenant_id) as s:
        patches = (await s.scalars(select(SectionPatch))).all()
        assert [(p.section_key, p.action) for p in patches] == [("risks", "remove")]


async def test_the_hold_refuses_a_draft_that_still_loses_an_approved_section(client, monkeypatch):
    """Whatever the composer does, the held draft is checked: every approved section
    must be there with its approved revision, or the import is refused."""
    from oracle.jobs import service as jobs_service

    ctx = await setup(client)
    assert (await verdict(client, ctx.auth, 1, "risks")).status_code == 200
    real = jobs_service.compose_markdown

    def leaky(front_matter, sections, replace_, resolutions):
        out = real(front_matter, sections, replace_, resolutions)
        return out.replace("Calendar sync may lag.", "Calendar sync never lags.")

    monkeypatch.setattr(jobs_service, "compose_markdown", leaky)
    owner = await person(ctx.tenant_id, "owner", "run-creator")
    agent = replace(DRAFT, "Calendar sync may lag.", "Sync is instant.")
    async with tenant_session(ctx.tenant_id) as s:
        with pytest.raises(DraftError) as raised:
            await docs_service.import_draft(
                s,
                DOC,
                agent,
                Principal(ctx.tenant_id, "user", "owner", user_id=owner.user_id),
                origin="run",
                cause="run_draft",
            )
    assert [p.code for p in raised.value.problems] == ["approved_section_not_held"]
    assert raised.value.problems[0].section_key == "risks"


@pytest.mark.parametrize(
    ("body", "closing"),
    [
        ("Intro.\n\n```text\ncode", "```"),
        ("Intro.\n\n~~~~\ncode", "~~~~"),
        ("Intro.\n\n  `````\n```\nstill code", "`````"),
    ],
)
def test_compose_closes_a_dangling_fence(body, closing):
    from oracle.docs.parser import parse_draft
    from oracle.jobs.service import compose_markdown

    sections = [
        SimpleNamespace(section_key="a", level=2, heading="A", body_md=body),
        SimpleNamespace(section_key="b", level=2, heading="B", body_md="Kept."),
    ]
    parsed = parse_draft(compose_markdown({"title": "T"}, sections, {}, []))
    assert [s.section_key for s in parsed.sections] == ["a", "b"]
    assert parsed.sections[0].body_md == f"{body}\n{closing}"
    assert parsed.sections[1].body_md == "Kept."


def test_compose_leaves_closed_fences_and_the_last_section_alone():
    from oracle.jobs.service import compose_markdown

    sections = [
        SimpleNamespace(section_key="a", level=2, heading="A", body_md="```\nx\n```"),
        SimpleNamespace(section_key="b", level=2, heading="B", body_md="```\nopen"),
    ]
    out = compose_markdown({"title": "T"}, sections, {}, [])
    assert out.endswith("## B {#b}\n\n```\nopen\n")
    assert "```\nx\n```\n\n## B" in out


# --- minors: revocation matching -----------------------------------------------------------


def test_normalized_urls_ignore_scheme_www_slash_and_tracking():
    from oracle.review.publish import normalize_url

    assert normalize_url("http://www.Example.com/a/") == "https://example.com/a"
    assert normalize_url("https://example.com/a?utm_source=x&b=2&a=1#f") == (
        "https://example.com/a?a=1&b=2"
    )
    assert normalize_url("HTTPS://WWW.example.com:443/") == "https://example.com"
    assert normalize_url("https://example.com:8443/a") == "https://example.com:8443/a"
    # Idempotent, so tombstones recorded with an older normalization still match.
    for url in ("https://example.com/a?b=1", "http://www.x.test/"):
        assert normalize_url(normalize_url(url)) == normalize_url(url)


async def _source(ctx, owner, *, url="https://example.com/calendar-survey", kind="upload"):
    async with tenant_session(ctx.tenant_id) as s:
        source = Source(owner_user_id=owner.user_id, kind=kind, name=f"S {uuid.uuid4().hex[:6]}")
        s.add(source)
        await s.flush()
        item = SourceItem(
            source_id=source.id, external_id="survey-123", kind="file", title="Survey", url=url
        )
        s.add(item)
        await s.commit()
        return source.id, item.id


async def _cited(client, ctx, ref: str, source: str = "web") -> None:
    draft = replace(
        replace(DRAFT, "ref: https://example.com/calendar-survey", f"ref: {ref}"),
        "source: web",
        f"source: {source}",
    )
    assert (await import_md(client, ctx.auth, draft, base=1)).status_code == 201
    await approved(client, ctx, 2)
    assert (await check(client, ctx, 2))["can_publish"] is True


async def test_a_citation_url_variant_is_matched(client):
    ctx = await setup(client)
    owner = await person(ctx.tenant_id, "owner", "source-owner")
    source_id, _ = await _source(ctx, owner)
    await _cited(client, ctx, "http://www.example.com/calendar-survey/?utm_source=mail")
    await _delete_source(client, owner, source_id)
    body = await check(client, ctx, 2)
    assert codes(body) == ["source_permission_revoked"]
    assert blocker(body, "source_permission_revoked")["section_keys"] == ["goal-trace"]


async def test_a_citation_by_external_id_is_matched(client):
    ctx = await setup(client)
    owner = await person(ctx.tenant_id, "owner", "source-owner")
    source_id, _ = await _source(ctx, owner, url=None)
    await _cited(client, ctx, "survey-123", source="upload")
    await _delete_source(client, owner, source_id)
    assert codes(await check(client, ctx, 2)) == ["source_permission_revoked"]


async def test_a_citation_by_evidence_id_is_matched(client):
    ctx = await setup(client)
    owner = await person(ctx.tenant_id, "owner", "source-owner")
    source_id, item_id = await _source(ctx, owner, url="https://x.test/evidence-only")
    async with tenant_session(ctx.tenant_id) as s:
        goal = Entity(type="goal", key="retention", title="Retention", origin="user")
        s.add(goal)
        await s.flush()
        evidence = Evidence(entity_id=goal.id, source_item_id=item_id, excerpt="Teams plan")
        s.add(evidence)
        await s.commit()
        evidence_id = evidence.id
    await _cited(client, ctx, str(evidence_id))
    await _delete_source(client, owner, source_id)
    body = await check(client, ctx, 2)
    assert codes(body) == ["source_permission_revoked"]
    assert blocker(body, "source_permission_revoked")["section_keys"] == ["goal-trace"]


# --- minors: the revision covers citation source, retrieved_at and links -----------------


@pytest.mark.parametrize(
    ("old", "new"),
    [
        (
            "title: Calendar survey",
            "title: Calendar survey\n    retrieved_at: 2026-09-01T00:00:00Z",
        ),
        ("source: web", "source: upload"),
    ],
)
async def test_citation_source_and_retrieved_at_change_the_revision(client, old, new):
    ctx = await setup(client)
    assert (await verdict(client, ctx.auth, 1, "goal-trace")).status_code == 200
    assert (await import_md(client, ctx.auth, replace(DRAFT, old, new), base=1)).status_code == 201
    s2 = await states(client, ctx.auth, 2)
    assert s2["goal-trace"]["status"] == "approval_stale"


async def test_an_unchanged_retrieved_at_keeps_the_revision(client):
    dated = replace(
        DRAFT, "title: Calendar survey", "title: Calendar survey\n    retrieved_at: 2026-09-01"
    )
    ctx = await setup(client, dated)
    assert (await verdict(client, ctx.auth, 1, "goal-trace")).status_code == 200
    again = replace(dated, "Owner: product.", "Owner: growth.")
    assert (await import_md(client, ctx.auth, again, base=1)).status_code == 201
    assert (await states(client, ctx.auth, 2))["goal-trace"]["status"] == "approved"


async def test_a_link_added_after_approval_stales_the_section(client):
    ctx = await setup(client)
    await policy(client, ctx, section_approval="all_sections")
    await approve_all(client, ctx.auth, 1)
    await approved(client, ctx)
    assert (await check(client, ctx))["can_publish"] is True
    async with tenant_session(ctx.tenant_id) as s:
        goal = Entity(type="goal", key="retention", title="Retention", origin="user")
        s.add(goal)
        await s.flush()
        document = await s.scalar(select(Document).where(Document.slug == DOC))
        s.add(
            DocumentSectionLink(
                document_id=document.id, section_key="problem", kind="evidences", entity_id=goal.id
            )
        )
        await s.commit()
    s1 = await states(client, ctx.auth, 1)
    assert s1["problem"]["status"] == "approval_stale"
    assert s1["solution"]["status"] == "approved"
    body = await check(client, ctx)
    assert codes(body) == ["stale_approval"]
    assert blocker(body, "stale_approval")["section_keys"] == ["problem"]
    # Approving the section with its link is what counts.
    assert (await verdict(client, ctx.auth, 1, "problem")).status_code == 200
    assert (await check(client, ctx))["can_publish"] is True


# --- minors: one markdown env per exported section -------------------------------------

LEAKY = [
    SimpleNamespace(
        section_key="a",
        level=2,
        heading="A",
        body_md="Defines a reference.\n\n[ref]: https://leak.example/a",
        layer="detail",
        citation_keys=[],
    ),
    SimpleNamespace(
        section_key="b",
        level=2,
        heading="B",
        body_md="Uses [ref] here.",
        citation_keys=[],
        layer="detail",
    ),
]


def _ev(theme=None):
    from oracle.export.render import ExportVersion

    return ExportVersion(
        document=SimpleNamespace(
            kind="prd", title="T", slug="t", status="draft", template=None, template_version=None
        ),
        version=SimpleNamespace(
            number=1, snapshot=None, created_at=datetime.now(UTC), approved_at=None
        ),
        sections=LEAKY,
        citations=[],
        latest_number=1,
        theme=theme,
        all_sections=LEAKY,
    )


def test_a_link_reference_does_not_leak_across_sections():
    from oracle.export.render import build_context

    ctx = build_context(_ev())
    b = next(s for s in ctx["sections"] if s.key == "b")
    assert "leak.example" not in str(b.body)


def test_a_link_reference_does_not_leak_across_themed_sections():
    from oracle.export.render import build_themed_context

    theme = SimpleNamespace(key="plain", name="Plain", tokens={}, css="")
    ctx = build_themed_context(_ev(theme))
    b = next(g for g in ctx["groups"] if g.key == "b")
    assert "leak.example" not in str(b.body)


# --- minors: open criticals gate publish (T2) -----------------------------------------------


async def test_an_open_critical_change_request_blocks_publish(client):
    ctx = await setup(client)
    created = await client.post(
        ctx.v(1, "/comments"),
        json={
            "section_key": "risks",
            "anchor": {"exact": "lag"},
            "body": "This is a launch risk",
            "severity": "critical",
        },
        headers=ctx.auth,
    )
    assert created.status_code == 201, created.text
    await approved(client, ctx)
    body = await check(client, ctx)
    assert codes(body) == ["open_critical_change_request"]
    assert blocker(body, "open_critical_change_request")["section_keys"] == ["risks"]
    assert (await client.post(ctx.v(1, "/publish"), json={}, headers=ctx.auth)).status_code == 409
    item_id = created.json()["feedback_item_id"]
    resp = await client.patch(
        f"/v1/feedback/{item_id}",
        json={"status": "addressed", "resolution_note": "Mitigated"},
        headers=ctx.auth,
    )
    assert resp.status_code == 200, resp.text
    assert (await check(client, ctx))["can_publish"] is True


# --- minors: a run's draft closes only the feedback it addressed -----------------------


async def test_a_run_draft_closes_only_feedback_on_sections_it_changed(client):
    ctx = await setup(client)
    assert (await verdict(client, ctx.auth, 1, "risks")).status_code == 200
    items = {}
    for key in ("solution", "problem", "risks"):
        created = await client.post(
            ctx.v(1, "/comments"),
            json={"section_key": key, "anchor": {"exact": "a"}, "body": f"About {key}"},
            headers=ctx.auth,
        )
        items[key] = created.json()["feedback_item_id"]
    resolutions = "".join(
        f"  - feedback_id: {items[k]}\n    status: {status}\n"
        for k, status in (
            ("solution", "addressed"),
            ("problem", "addressed"),
            ("risks", "addressed"),
        )
    )
    agent = replace(
        replace(
            replace(DRAFT, "A shared calendar view per project.", "A calendar per team."),
            "Calendar sync may lag.",
            "Sync is instant.",
        ),
        "title: Team calendar PRD\n",
        f"title: Team calendar PRD\nresolutions:\n{resolutions}",
    )
    owner = await person(ctx.tenant_id, "owner", "run-creator")
    async with tenant_session(ctx.tenant_id) as s:
        result = await docs_service.import_draft(
            s,
            DOC,
            agent,
            Principal(ctx.tenant_id, "user", "owner", user_id=owner.user_id),
            origin="run",
            cause="run_draft",
        )
    warnings = {w.code: w for w in result.version.warnings}
    # problem: not changed; risks: approved, the change waits as a patch.
    assert warnings["resolution_not_applied"].section_keys == ["problem", "risks"]
    # #396: a person reads the sections by heading; agents get the feedback ids in refs.
    left_open = warnings["resolution_not_applied"]
    assert items["problem"] not in left_open.message and "2 feedback items" in left_open.message
    assert left_open.refs == {"feedback_items": [items["problem"], items["risks"]]}
    async with tenant_session(ctx.tenant_id) as s:
        rows = {i.section_key: i.status for i in await s.scalars(select(FeedbackItem))}
    assert rows == {"solution": "addressed", "problem": "open", "risks": "open"}


async def test_a_run_draft_cannot_decline_feedback(client):
    ctx = await setup(client)
    created = await client.post(
        ctx.v(1, "/comments"),
        json={"section_key": "solution", "anchor": {"exact": "a"}, "body": "Too vague"},
        headers=ctx.auth,
    )
    item = created.json()["feedback_item_id"]
    agent = replace(
        replace(DRAFT, "A shared calendar view per project.", "A calendar per team."),
        "title: Team calendar PRD\n",
        f"title: Team calendar PRD\nresolutions:\n  - feedback_id: {item}\n    status: declined\n",
    )
    owner = await person(ctx.tenant_id, "owner", "run-creator")
    async with tenant_session(ctx.tenant_id) as s:
        result = await docs_service.import_draft(
            s,
            DOC,
            agent,
            Principal(ctx.tenant_id, "user", "owner", user_id=owner.user_id),
            origin="run",
            cause="run_draft",
        )
    assert "resolution_not_applied" in [w.code for w in result.version.warnings]
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(FeedbackItem, uuid.UUID(item))).status == "open"


def test_the_migration_backfills_the_same_revision():
    """0014_review backfills sections.revision with a frozen copy of the parser's."""
    import importlib.util

    from oracle.docs.parser import cited_entries, instant, section_revision
    from tests.conftest import API_DIR

    path = API_DIR / "migrations" / "versions" / "0014_review.py"
    spec = importlib.util.spec_from_file_location("m0014", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    at = datetime(2026, 9, 1, 12, 30, tzinfo=UTC)
    citation = SimpleNamespace(ref="https://x.test", title="T", excerpt=None, source="web")
    for retrieved in (at, at.replace(tzinfo=None), None):
        citation.retrieved_at = retrieved
        cited = cited_entries(["c1"], {"c1": citation})
        frozen = [["c1", "https://x.test", "T", None, "web", migration._instant(retrieved)]]
        assert cited == [tuple(frozen[0])]
        assert instant(retrieved) == migration._instant(retrieved)
        for layer in ("brief", "detail"):
            assert section_revision("h", layer, cited) == migration._revision("h", layer, frozen)


# -----------------------------------------------------------------------------
# CR-06 review fixes, round 3 (PR #16 / #27 / #38), after the owner's C2 decision:
# removing a member disables them (sign-in refused on every path, sources and
# connections revoked, approvals void, history keeps the row, an owner can restore), a
# lapsed approval lapses for good, approvals record the API token that gave them, an
# unclosed fence never swallows a section, and a UUID citation ref is also an external
# id. Synthetic placeholders only.


@pytest.fixture
def provider():
    """Provider calls (the revoke at disconnect) go to a mock; returns the requests."""
    seen = use_provider_http(lambda request: httpx.Response(200, json={"ok": True}))
    yield seen
    clear_provider_http()


async def disable(client, ctx, user_id, headers=None):
    return await client.post(f"/v1/members/{user_id}/disable", headers=headers or ctx.auth)


async def restore(client, ctx, user_id, headers=None):
    return await client.post(f"/v1/members/{user_id}/restore", headers=headers or ctx.auth)


async def member_token(ctx, user_id, name="agent") -> tuple[uuid.UUID, dict[str, str]]:
    async with tenant_session(ctx.tenant_id) as s:
        token, raw = await create_api_token(s, name, user_id=user_id)
        await s.commit()
        return token.id, {"Authorization": f"Bearer {raw}"}


async def oauth_token(ctx, user_id) -> str:
    from oracle.mcp.oauth.models import OAuthClient
    from oracle.mcp.oauth.service import _new_token_row

    async with tenant_session(ctx.tenant_id) as s:
        oc = OAuthClient(
            client_id=uuid.uuid4().hex, name="Desk client", redirect_uris=["http://127.0.0.1/cb"]
        )
        s.add(oc)
        await s.flush()
        row, issued = _new_token_row(
            client_id=oc.id, user_id=user_id, scope="oracle:read oracle:write", family_id=None
        )
        s.add(row)
        await s.commit()
        return issued.access_token


async def lapsed_reviews(ctx, user_id) -> list[SectionReview]:
    async with tenant_session(ctx.tenant_id) as s:
        return list(
            await s.scalars(
                select(SectionReview).where(
                    SectionReview.reviewer_id == user_id, SectionReview.verdict == "approved"
                )
            )
        )


# --- BLOCKER 1: removing a member disables them ---------------------------------------


async def test_a_disabled_member_keeps_their_row_and_cannot_sign_in_anywhere(client):
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    async with tenant_session(ctx.tenant_id) as s:
        email = (await s.get(User, pm.user_id)).email
    _, bearer = await member_token(ctx, pm.user_id)
    access = await oauth_token(ctx, pm.user_id)
    oauth = {"Authorization": f"Bearer {access}"}
    for headers in (pm.headers, bearer, oauth):
        assert (await client.get(f"/v1/documents/{DOC}", headers=headers)).status_code == 200
    login = {"email": email, "password": "pw"}
    assert (await client.post("/v1/auth/login", json=login)).status_code == 200

    other = await person(ctx.tenant_id, "approver", "other")
    assert (await disable(client, ctx, pm.user_id, other.headers)).status_code == 403
    resp = await disable(client, ctx, pm.user_id)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "disabled" and body["disabled_at"] and body["email"] == email
    # Disabling twice is a no-op.
    assert (await disable(client, ctx, pm.user_id)).status_code == 200

    for headers in (pm.headers, bearer, oauth):
        assert (await client.get(f"/v1/documents/{DOC}", headers=headers)).status_code == 401
    # qa-settings-42: refused in words (the right password), never signed in.
    refused = await client.post("/v1/auth/login", json=login)
    assert refused.status_code == 403 and "removed you" in refused.json()["detail"]
    assert (await client.post("/v1/auth/login", json={**login, "password": "x"})).status_code == 401

    async with tenant_session(ctx.tenant_id) as s:
        user = await s.get(User, pm.user_id)
        assert user is not None and user.email == email and user.disabled_at is not None
        assert user.disabled_by is not None
        tokens = (await s.scalars(select(ApiToken).where(ApiToken.user_id == pm.user_id))).all()
        assert tokens and all(t.revoked_at is not None for t in tokens)
        [event] = (
            await s.scalars(
                select(ChangeEvent).where(
                    ChangeEvent.subject_kind == "member", ChangeEvent.cause == "member_disabled"
                )
            )
        ).all()
        assert event.subject_id == pm.user_id
        [audit] = (
            await s.scalars(select(AuditEvent).where(AuditEvent.action == "member.disable"))
        ).all()
        assert audit.entity_id == pm.user_id and audit.data["role"] == "approver"
    members = (await client.get("/v1/members", headers=ctx.auth)).json()
    [row] = [m for m in members if m["id"] == str(pm.user_id)]
    assert row["status"] == "disabled" and row["email"] == email


async def test_a_disabled_member_cannot_act_through_mcp_or_a_run(client):
    from oracle.mcp.auth import verify

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    async with tenant_session(ctx.tenant_id) as s:
        token, raw = await create_api_token(s, "pm-mcp", user_id=pm.user_id)
        run = Run(flow="baseline_to_prd", created_by=pm.user_id, status="running")
        s.add(run)
        await s.flush()
        run_token = await mint_run_token(s, run.id, ["read:documents"], 600)
        await s.commit()
        run_id = run.id
    access = await oauth_token(ctx, pm.user_id)
    for credential in (raw, run_token, access):
        assert await verify(credential) is not None
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    for credential in (raw, run_token, access):
        assert await verify(credential) is None
    async with tenant_session(ctx.tenant_id) as s:
        run = await s.get(Run, run_id)
        assert run.status == "cancelled"
        assert all(t.revoked_at for t in await s.scalars(select(RunToken)))


async def test_a_disabled_creators_run_token_header_is_refused(client):
    """The in-process REST call for a run carries the creator's session and the run
    token; a disabled creator's is refused even with a session minted earlier."""
    from oracle.auth.deps import RUN_HEADER, RUN_TOKEN_HEADER
    from oracle.auth.service import sign_run_binding

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    async with tenant_session(ctx.tenant_id) as s:
        run = Run(flow="baseline_to_prd", created_by=pm.user_id, status="running")
        s.add(run)
        await s.flush()
        raw = await mint_run_token(s, run.id, ["read:documents"], 600)
        await s.commit()
    binding = sign_run_binding(pm.user_id, run.id)
    headers = {**pm.headers, RUN_TOKEN_HEADER: raw, RUN_HEADER: binding}
    assert (await client.get(f"/v1/documents/{DOC}", headers=headers)).status_code == 200
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    assert (await client.get(f"/v1/documents/{DOC}", headers=headers)).status_code == 401


async def test_iap_refuses_a_disabled_email_and_never_provisions_it_again(client, monkeypatch):
    from oracle.auth import iap
    from oracle.config import get_settings
    from tests import test_iap
    from tests.test_iap import HEADER, assertion

    settings = get_settings()
    monkeypatch.setattr(settings, "iap_audiences", [test_iap.AUDIENCE])
    monkeypatch.setattr(settings, "iap_allowed_domains", ["example.com"])
    monkeypatch.setattr(settings, "iap_auto_provision", True)

    async def fake_fetch():
        return test_iap._jwks()

    monkeypatch.setattr(iap, "_fetch_jwks", fake_fetch)
    iap._keys.clear()
    try:
        ctx = await setup(client)
        await test_iap._join_at_once(ctx.tenant_id)  # A5: an uninvited sign-in joins at once
        email = "iap-pm@example.com"
        signed = {HEADER: assertion(email)}
        assert (await client.get("/v1/me", headers=signed)).status_code == 200
        async with tenant_session(ctx.tenant_id) as s:
            user_id = await s.scalar(select(User.id).where(User.email == email))
        assert (await disable(client, ctx, user_id)).status_code == 200
        assert (await client.get("/v1/me", headers=signed)).status_code == 401
        async with tenant_session(ctx.tenant_id) as s:
            users = (await s.scalars(select(User).where(User.email == email))).all()
            assert [u.id for u in users] == [user_id]
        # Restored: IAP signs them in again, as the same user.
        assert (await restore(client, ctx, user_id)).status_code == 200
        me = await client.get("/v1/me", headers=signed)
        assert me.status_code == 200 and me.json()["user_id"] == str(user_id)
    finally:
        iap._keys.clear()


async def test_disabling_revokes_connections_at_the_provider_and_records_sources(client, provider):
    from oracle import crypto

    ctx = await setup(client)
    await approved(client, ctx)
    analyst = await person(ctx.tenant_id, "commenter", "analyst")
    async with tenant_session(ctx.tenant_id) as s:
        conn = Connection(
            user_id=analyst.user_id,
            provider="notion",
            auth_mode="token",
            account_id="ws-1",
            account_label="Workspace",
            ciphertext=crypto.encrypt(b'{"access_token": "placeholder"}'),
            key_version=crypto.KEY_VERSION,
        )
        s.add(conn)
        await s.flush()
        synced = Source(
            owner_user_id=analyst.user_id, kind="notion", name="Notes", connection_id=conn.id
        )
        upload = Source(owner_user_id=analyst.user_id, kind="upload", name="Survey")
        s.add_all([synced, upload])
        await s.flush()
        s.add(
            SourceItem(
                source_id=upload.id,
                external_id="survey.md",
                kind="file",
                url="https://example.com/calendar-survey",
            )
        )
        s.add(Invite(email="later@example.com", role="viewer"))
        await s.commit()
        conn_id, synced_id, upload_id = conn.id, synced.id, upload.id
        analyst_email = (await s.get(User, analyst.user_id)).email
    async with tenant_session(ctx.tenant_id) as s:
        # An open invite for the same email (made before they joined) is revoked too.
        s.add(Invite(email=analyst_email, role="approver"))
        await s.commit()
    assert (await check(client, ctx))["can_publish"] is True

    assert (await disable(client, ctx, analyst.user_id)).status_code == 200
    assert codes(await check(client, ctx)) == ["source_permission_revoked"]
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.get(Connection, conn_id) is None
        [audit] = (
            await s.scalars(select(AuditEvent).where(AuditEvent.action == "connection.disconnect"))
        ).all()
        assert audit.entity_id == conn_id and "provider_revoke" in audit.data
        events = (
            await s.scalars(
                select(ChangeEvent).where(ChangeEvent.subject_kind == "source_permission")
            )
        ).all()
        assert {e.subject_id for e in events} == {synced_id, upload_id}
        # The sources stay (history), paused.
        assert {x.status for x in await s.scalars(select(Source))} == {"paused"}
        invites = {i.email: i for i in await s.scalars(select(Invite))}
        assert invites[analyst_email].revoked_at is not None
        assert invites["later@example.com"].revoked_at is None

    # Restored: they sign in again (fresh), but nothing is reconnected or un-revoked.
    assert (await restore(client, ctx, analyst.user_id)).status_code == 200
    assert (await client.get(f"/v1/documents/{DOC}", headers=analyst.headers)).status_code == 401
    assert codes(await check(client, ctx)) == ["source_permission_revoked"]
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.get(Connection, conn_id) is None


async def test_the_last_active_owner_cannot_be_disabled(client):
    ctx = await setup(client)
    async with tenant_session(ctx.tenant_id) as s:
        [owner] = (await s.scalars(select(User).where(User.role == "owner"))).all()
    second = await person(ctx.tenant_id, "owner", "second")
    assert (await disable(client, ctx, second.user_id)).status_code == 200
    # A disabled owner is not "another owner".
    assert (await disable(client, ctx, owner.id)).status_code == 409
    resp = await client.patch(
        f"/v1/members/{owner.id}", json={"role": "approver"}, headers=ctx.auth
    )
    assert resp.status_code == 409
    assert (await client.delete(f"/v1/members/{uuid.uuid4()}", headers=ctx.auth)).status_code == 404


async def test_delete_is_kept_as_disable(client):
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    assert (await client.delete(f"/v1/members/{pm.user_id}", headers=ctx.auth)).status_code == 204
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(User, pm.user_id)).disabled_at is not None


async def test_restore_is_owner_only_and_audited(client):
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    other = await person(ctx.tenant_id, "approver", "other")
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    assert (await restore(client, ctx, pm.user_id, other.headers)).status_code == 403
    # Their email cannot be invited again: they are restored instead.
    async with tenant_session(ctx.tenant_id) as s:
        email = (await s.get(User, pm.user_id)).email
    resp = await client.post(
        "/v1/invites", json={"email": email, "role": "viewer"}, headers=ctx.auth
    )
    assert resp.status_code == 409 and "restore" in resp.json()["detail"]
    resp = await restore(client, ctx, pm.user_id)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "active" and resp.json()["disabled_at"] is None
    # A session signed before the disable stays dead (round 4); they sign in fresh.
    assert (await client.get(f"/v1/documents/{DOC}", headers=pm.headers)).status_code == 401
    login = await client.post("/v1/auth/login", json={"email": email, "password": "pw"})
    assert login.status_code == 200
    client.cookies.clear()
    name = get_settings().session_cookie_name
    fresh = {"Cookie": f"{name}={login.cookies[name]}"}
    assert (await client.get(f"/v1/documents/{DOC}", headers=fresh)).status_code == 200
    assert (await restore(client, ctx, uuid.uuid4())).status_code == 404
    async with tenant_session(ctx.tenant_id) as s:
        assert (
            await s.scalar(select(AuditEvent.id).where(AuditEvent.action == "member.restore"))
        ) is not None
        causes = list(
            await s.scalars(
                select(ChangeEvent.cause)
                .where(ChangeEvent.subject_kind == "member")
                .order_by(ChangeEvent.created_at)
            )
        )
        assert causes == ["member_disabled", "member_restored"]


async def test_a_disabled_member_is_not_a_valid_decider(client):
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    resp = await client.put(
        f"/v1/documents/{DOC}/review-policy",
        json={"decider_id": str(pm.user_id)},
        headers=ctx.auth,
    )
    assert resp.status_code in (400, 422), resp.text


# --- BLOCKER 2: a lapsed approval lapses for good ---------------------------------------


async def test_demote_then_promote_never_revives_approvals(client):
    ctx = await setup(client)
    await policy(client, ctx, section_approval="all_sections")
    pm = await person(ctx.tenant_id, "approver", "pm")
    await approve_all(client, pm.headers, 1)
    await approved(client, ctx, headers=pm.headers)
    assert (await check(client, ctx))["can_publish"] is True

    assert (await set_role(client, ctx, pm.user_id, "commenter")).status_code == 200
    # Recorded in the role change's own transaction.
    assert all(r.lapsed_at is not None for r in await lapsed_reviews(ctx, pm.user_id))
    assert (await set_role(client, ctx, pm.user_id, "approver")).status_code == 200
    body = await check(client, ctx)
    assert codes(body) == ["version_approval_lapsed", "missing_approval"]
    assert blocker(body, "version_approval_lapsed")["ids"] == [str(pm.user_id)]
    s1 = await states(client, ctx.auth, 1)
    assert {s["status"] for s in s1.values()} == {"unreviewed"}

    # A fresh approval after the promotion is a new approval, and counts.
    await approve_all(client, pm.headers, 1)
    await approved(client, ctx, headers=pm.headers)
    assert (await check(client, ctx))["can_publish"] is True


async def test_owner_to_approver_is_not_a_lapse(client):
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "owner", "pm")
    await approved(client, ctx, headers=pm.headers)
    assert (await set_role(client, ctx, pm.user_id, "approver")).status_code == 200
    assert (await check(client, ctx))["can_publish"] is True


async def test_disable_then_restore_never_revives_approvals(client):
    ctx = await setup(client)
    await policy(client, ctx, section_approval="all_sections")
    pm = await person(ctx.tenant_id, "approver", "pm")
    await approve_all(client, pm.headers, 1)
    await approved(client, ctx, headers=pm.headers)
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    body = await check(client, ctx)
    assert codes(body) == ["version_approval_lapsed", "missing_approval"]
    assert (await restore(client, ctx, pm.user_id)).status_code == 200
    body = await check(client, ctx)
    assert codes(body) == ["version_approval_lapsed", "missing_approval"]
    assert all(r.lapsed_at is not None for r in await lapsed_reviews(ctx, pm.user_id))


async def test_a_lapsed_version_approval_stops_showing_approved(client):
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    await approved(client, ctx, headers=pm.headers)
    doc = (await client.get(f"/v1/documents/{DOC}", headers=ctx.auth)).json()
    assert doc["status"] == "approved"
    assert (await set_role(client, ctx, pm.user_id, "viewer")).status_code == 200
    doc = (await client.get(f"/v1/documents/{DOC}", headers=ctx.auth)).json()
    assert doc["status"] != "approved"
    version = (await client.get(ctx.v(1), headers=ctx.auth)).json()
    assert version["approved_at"] is None
    md = await client.get(ctx.v(1, "/export"), params={"format": "md"}, headers=ctx.auth)
    assert md.status_code == 200, md.text
    assert "status approved" not in md.text and "· approved " not in md.text


async def test_role_changes_and_disables_take_the_review_gate(client, monkeypatch):
    from oracle.review import publish

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    calls: list[bool] = []
    real = publish.gate_lock

    async def spy(db, *, shared):
        calls.append(shared)
        await real(db, shared=shared)

    monkeypatch.setattr(publish, "gate_lock", spy)
    assert (await set_role(client, ctx, pm.user_id, "commenter")).status_code == 200
    assert calls == [False]
    calls.clear()
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    assert calls and calls[0] is False


# --- MAJOR: approvals record the API token that gave them -------------------------------


async def test_a_tokens_approvals_record_it_and_revoking_it_voids_them(client):
    ctx = await setup(client)
    await policy(client, ctx, section_approval="all_sections")
    pm = await person(ctx.tenant_id, "approver", "pm")
    token_id, agent = await member_token(ctx, pm.user_id, "pm-agent")
    await approve_all(client, agent, 1)
    await approved(client, ctx, headers=agent)
    assert (await check(client, ctx))["can_publish"] is True
    # One more approval by the person directly, not through the token.
    growth = replace(DRAFT, "Owner: product.", "Owner: growth.")
    assert (await import_md(client, ctx.auth, growth, base=1)).status_code == 201
    assert (await verdict(client, pm.headers, 2, "problem")).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        reviews = (await s.scalars(select(SectionReview))).all()
        assert {r.token_id for r in reviews if r.version_id is not None} == {token_id, None}
        v1 = await s.scalar(select(DocumentVersion).where(DocumentVersion.number == 1))
        assert v1.approved_token_id == token_id and v1.approved_by == pm.user_id
        [audit] = (
            await s.scalars(select(AuditEvent).where(AuditEvent.action == "version.approve"))
        ).all()
        assert audit.actor == f"user:{pm.user_id}"
        assert audit.actor_token_id == token_id

    # Owners only.
    url = f"/v1/api-tokens/{token_id}"
    assert (await client.get(url + "/approvals", headers=pm.headers)).status_code == 403
    listed = await client.get(url + "/approvals", headers=ctx.auth)
    assert listed.status_code == 200, listed.text
    rows = listed.json()
    assert {r["kind"] for r in rows} == {"section", "version"}
    assert len([r for r in rows if r["kind"] == "section"]) == 6
    assert all(r["lapsed_at"] is None for r in rows)

    assert (await client.delete(url, headers=pm.headers)).status_code == 403
    assert (await client.delete(url, headers=ctx.auth)).status_code == 204
    body = await check(client, ctx)
    assert {"version_approval_lapsed", "missing_approval"} <= set(codes(body))
    rows = (await client.get(url + "/approvals", headers=ctx.auth)).json()
    assert rows and all(r["lapsed_at"] is not None for r in rows)
    # The person's own approval (not the token's) stands.
    s2 = await states(client, ctx.auth, 2)
    assert s2["problem"]["status"] == "approved"
    assert s2["solution"]["status"] == "unreviewed"
    # The person can still sign in; only the token is gone.
    assert (await client.get(f"/v1/documents/{DOC}", headers=agent)).status_code == 401
    assert (await client.get(f"/v1/documents/{DOC}", headers=pm.headers)).status_code == 200
    unknown = await client.delete(f"/v1/api-tokens/{uuid.uuid4()}", headers=ctx.auth)
    assert unknown.status_code == 404


async def test_a_token_revoked_outside_the_endpoint_still_voids_at_gate_time(client):
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    token_id, agent = await member_token(ctx, pm.user_id)
    await approved(client, ctx, headers=agent)
    async with tenant_session(ctx.tenant_id) as s:
        (await s.get(ApiToken, token_id)).revoked_at = datetime.now(UTC) - timedelta(seconds=1)
        await s.commit()
    assert codes(await check(client, ctx)) == ["version_approval_lapsed"]


# --- MAJOR 2: an unclosed fence never swallows a section ---------------------------------


@pytest.mark.parametrize(
    "body",
    [
        "Intro.\n\n```text\ncode\n   ",
        "Intro.\n\n```text\ncode\n \t\n   ",
        "```\n   ",
        "Intro.\n\n```text\ncode\n\n\n",
        "```\n\n\n",
    ],
)
def test_unclosed_fence_ignores_trailing_whitespace_lines(body):
    from oracle.docs.parser import unclosed_fence

    assert unclosed_fence(body) == "```"


@pytest.mark.parametrize("body", ["```\ncode\n```\n  \n", "```\ncode\n```\n\n\n", "Text.\n\n  "])
def test_a_closed_fence_with_trailing_blanks_is_closed(body):
    from oracle.docs.parser import unclosed_fence

    assert unclosed_fence(body) is None


@pytest.mark.parametrize("body", ["Intro.\n\n```text\ncode\n   ", "Intro.\n\n```text\ncode\n\n\n"])
def test_compose_closes_a_fence_with_trailing_blank_lines(body):
    from types import SimpleNamespace

    from oracle.docs.parser import parse_draft
    from oracle.jobs.service import compose_markdown

    sections = [
        SimpleNamespace(section_key="a", level=2, heading="A", body_md=body),
        SimpleNamespace(section_key="b", level=2, heading="B", body_md="Kept."),
    ]
    parsed = parse_draft(compose_markdown({"title": "T"}, sections, {}, []))
    assert [s.section_key for s in parsed.sections] == ["a", "b"]
    assert parsed.sections[1].body_md == "Kept."


def test_compose_refuses_to_lose_a_section(monkeypatch):
    from types import SimpleNamespace

    from oracle.docs import parser
    from oracle.docs.parser import DraftError
    from oracle.jobs.service import compose_markdown

    monkeypatch.setattr(parser, "unclosed_fence", lambda body: None)
    sections = [
        SimpleNamespace(section_key="a", level=2, heading="A", body_md="```\nopen"),
        SimpleNamespace(section_key="b", level=2, heading="B", body_md="Kept."),
    ]
    with pytest.raises(DraftError) as raised:
        compose_markdown({"title": "T"}, sections, {}, [])
    [problem] = raised.value.problems
    assert problem.code == "section_lost" and problem.section_key == "b"


# --- MAJOR 3: a UUID citation ref is also an external id ---------------------------------


async def test_a_notion_page_id_citation_is_matched(client):
    ctx = await setup(client)
    owner = await person(ctx.tenant_id, "owner", "source-owner")
    page_id = str(uuid.uuid4())
    async with tenant_session(ctx.tenant_id) as s:
        source = Source(owner_user_id=owner.user_id, kind="notion", name="Wiki")
        s.add(source)
        await s.flush()
        s.add(SourceItem(source_id=source.id, external_id=page_id, kind="page", title="Plan"))
        await s.commit()
        source_id = source.id
    draft = replace(
        replace(DRAFT, "ref: https://example.com/calendar-survey", f"ref: {page_id}"),
        "source: web",
        "source: notion",
    )
    assert (await import_md(client, ctx.auth, draft, base=1)).status_code == 201
    await approved(client, ctx, 2)
    assert (await check(client, ctx, 2))["can_publish"] is True
    resp = await client.delete(f"/v1/sources/{source_id}", headers=owner.headers)
    assert resp.status_code == 204, resp.text
    body = await check(client, ctx, 2)
    assert codes(body) == ["source_permission_revoked"]
    assert blocker(body, "source_permission_revoked")["section_keys"] == ["goal-trace"]


# --- minors: URL matching ------------------------------------------------------------------


def test_google_docs_edit_view_and_usp_are_one_url():
    from oracle.review.publish import normalize_url

    base = "https://docs.google.com/document/d/AbC123/edit"
    for variant in (
        "https://docs.google.com/document/d/AbC123/view",
        "https://docs.google.com/document/d/AbC123/edit?usp=sharing",
        "https://docs.google.com/document/d/AbC123/",
        "http://docs.google.com/document/d/AbC123/edit#heading=h.1",
        "https://docs.google.com/document/u/0/d/AbC123/preview",
    ):
        assert normalize_url(variant) == normalize_url(base), variant
    assert normalize_url(base) != normalize_url("https://docs.google.com/document/d/Other/edit")


def test_percent_encoding_is_normalized():
    from oracle.review.publish import normalize_url

    assert normalize_url("https://example.com/a%7Eb") == normalize_url("https://example.com/a~b")
    assert normalize_url("https://example.com/a%2fb") == normalize_url("https://example.com/a%2Fb")
    assert normalize_url("https://example.com/caf%C3%A9") == normalize_url(
        "https://example.com/caf%c3%a9"
    )
    for url in ("https://example.com/a%7Eb", "https://example.com/a%2fb?q=a%20b"):
        assert normalize_url(normalize_url(url)) == normalize_url(url)


async def test_a_url_with_a_user_name_is_matched(client):
    ctx = await setup(client)
    owner = await person(ctx.tenant_id, "owner", "source-owner")
    url = "https://reader@example.com/private-survey"
    async with tenant_session(ctx.tenant_id) as s:
        source = Source(owner_user_id=owner.user_id, kind="upload", name="Private")
        s.add(source)
        await s.flush()
        s.add(SourceItem(source_id=source.id, external_id="p-1", kind="file", url=url))
        await s.commit()
        source_id = source.id
    draft = replace(DRAFT, "ref: https://example.com/calendar-survey", f"ref: {url}")
    assert (await import_md(client, ctx.auth, draft, base=1)).status_code == 201
    await approved(client, ctx, 2)
    # Mark the item revoked without the tombstone naming it by URL: only the item lookup
    # (by its URL, through the host pre-filter) finds it.
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.scalar(select(SourceItem).where(SourceItem.source_id == source_id))
        item.deleted_at = datetime.now(UTC)
        await s.commit()
    body = await check(client, ctx, 2)
    assert codes(body) == ["source_permission_revoked"]


async def test_documents_keep_working_for_a_disabled_members_history(client):
    """History keeps the name: the disabled member's verdict rows still resolve."""
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    assert (await verdict(client, pm.headers, 1, "problem", "changes_requested")).status_code == 200
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        [review] = (await s.scalars(select(SectionReview))).all()
        assert (await s.get(User, review.reviewer_id)) is not None
        document = await s.scalar(select(Document).where(Document.slug == DOC))
        assert document is not None


# -----------------------------------------------------------------------------
# CR-06 review fixes, round 4 (PR #16 / #27 / #38 / #45), after the owner's C2
# follow-ups (2026-10-19): a disable ends every session and a restored member signs in
# fresh; a member-management request re-reads its caller under the gate; approvals by
# people demoted before the disable change are lapsed by the migration; revoking an MCP
# OAuth grant voids the approvals made through it. Synthetic placeholders only.


async def email_of(ctx, user_id) -> str:
    async with tenant_session(ctx.tenant_id) as s:
        return (await s.get(User, user_id)).email


async def sign_in(client, email: str, password: str = "pw") -> httpx.Response:
    resp = await client.post("/v1/auth/login", json={"email": email, "password": password})
    # The test client keeps cookies; each test passes the one it means explicitly.
    client.cookies.clear()
    return resp


def cookie_headers(resp: httpx.Response) -> dict[str, str]:
    name = get_settings().session_cookie_name
    return {"Cookie": f"{name}={resp.cookies[name]}"}


# --- MAJOR 1: a disable ends every session ----------------------------------------------


async def test_a_session_signed_before_a_disable_stays_dead_after_restore(client):
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    email = await email_of(ctx, pm.user_id)
    login = await sign_in(client, email)
    assert login.status_code == 200
    signed_in = cookie_headers(login)
    for headers in (pm.headers, signed_in):
        assert (await client.get(f"/v1/documents/{DOC}", headers=headers)).status_code == 200

    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    assert (await restore(client, ctx, pm.user_id)).status_code == 200
    # Every cookie signed before the disable is refused, on every cookie path.
    for headers in (pm.headers, signed_in):
        assert (await client.get(f"/v1/documents/{DOC}", headers=headers)).status_code == 401
        assert (await client.get("/v1/me", headers=headers)).status_code == 401
    # A fresh sign-in after the restore works.
    fresh = await sign_in(client, email)
    assert fresh.status_code == 200
    resp = await client.get(f"/v1/documents/{DOC}", headers=cookie_headers(fresh))
    assert resp.status_code == 200


async def test_a_session_signed_while_disabled_is_dead_after_restore(client, monkeypatch):
    """A cookie minted during a disable (a sign-in racing it) is older than the restore."""
    from oracle.auth.service import make_session_cookie

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        racing = make_session_cookie(await s.get(User, pm.user_id))
    assert (await restore(client, ctx, pm.user_id)).status_code == 200
    headers = {"Cookie": f"{get_settings().session_cookie_name}={racing}"}
    assert (await client.get(f"/v1/documents/{DOC}", headers=headers)).status_code == 401


async def test_an_oauth_code_issued_before_a_disable_is_void_after_restore(client):
    from oracle.mcp.oauth import service as oauth
    from oracle.mcp.oauth.models import OAuthClient
    from tests.test_oauth import REDIRECT, pkce

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    verifier, challenge = pkce()
    async with tenant_session(ctx.tenant_id) as s:
        oc = OAuthClient(client_id=uuid.uuid4().hex, name="Desk client", redirect_uris=[REDIRECT])
        s.add(oc)
        await s.flush()
        req = oauth.AuthorizationRequest(oc.client_id, REDIRECT, "oracle:read", challenge, None)
        code = await oauth.issue_code(s, oc, pm.user_id, req)
        await s.commit()
        client_id = oc.client_id
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    assert (await restore(client, ctx, pm.user_id)).status_code == 200
    resp = await client.post(
        "/oauth/token",
        data={
            "grant_type": "authorization_code",
            "client_id": client_id,
            "code": code,
            "redirect_uri": REDIRECT,
            "code_verifier": verifier,
        },
    )
    assert resp.status_code == 400 and resp.json()["error"] == "invalid_grant", resp.text


# --- MAJOR 2: a member-management request re-reads its caller under the gate ----------


async def admin_id(ctx) -> uuid.UUID:
    async with tenant_session(ctx.tenant_id) as s:
        return await s.scalar(select(User.id).where(User.email == "admin@example.com"))


async def test_a_queued_request_of_an_owner_being_disabled_is_refused(client, monkeypatch):
    """Rogue owner B loops restore-self; owner A disables B. B's request, queued on the
    gate while A holds it, runs after A commits: it is refused, B stays disabled."""
    import asyncio

    from oracle.review import publish

    ctx = await setup(client)
    rogue = await person(ctx.tenant_id, "owner", "rogue")
    real = publish.gate_lock
    a_holds, b_waits = asyncio.Event(), asyncio.Event()
    calls = 0

    async def spy(db, *, shared):
        nonlocal calls
        calls += 1
        if calls == 1:  # A's disable: hold the gate until B queues on it
            await real(db, shared=shared)
            a_holds.set()
            await b_waits.wait()
            await asyncio.sleep(0.3)
            return
        b_waits.set()
        await real(db, shared=shared)

    monkeypatch.setattr(publish, "gate_lock", spy)
    a = asyncio.create_task(disable(client, ctx, rogue.user_id))
    await a_holds.wait()
    b = asyncio.create_task(restore(client, ctx, rogue.user_id, rogue.headers))
    ra, rb = await asyncio.gather(a, b)
    assert ra.status_code == 200, ra.text
    assert rb.status_code == 403, rb.text
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(User, rogue.user_id)).disabled_at is not None


async def _lose_standing(ctx, how: str, user_id, token_id=None) -> None:
    from datetime import UTC, datetime

    from oracle.auth.models import ApiToken

    async with tenant_session(ctx.tenant_id) as s:
        if how == "disabled":
            (await s.get(User, user_id)).disabled_at = datetime.now(UTC)
        elif how == "demoted":
            (await s.get(User, user_id)).role = "approver"
        else:
            (await s.get(ApiToken, token_id)).revoked_at = datetime.now(UTC)
        await s.commit()


ROUTES = [
    "set_role",
    "disable",
    "restore",
    "revoke_token",
    "create_invite",
    "revoke_invite",
    "resend_invite",
]


@pytest.mark.parametrize(
    "route,how",
    [(r, "disabled") for r in ROUTES]
    + [(r, "demoted") for r in ("set_role", "create_invite", "revoke_invite", "resend_invite")]
    + [("disable", "token_revoked")],
)
async def test_a_caller_who_lost_standing_while_waiting_on_the_gate_is_refused(
    client, monkeypatch, route, how
):
    from datetime import UTC, datetime

    from oracle.auth.service import create_api_token
    from oracle.members.models import Invite
    from oracle.review import publish

    pass

    ctx = await setup(client)
    caller = await person(ctx.tenant_id, "owner", "caller")
    token_id, bearer = await member_token(ctx, caller.user_id, "caller-agent")
    headers = bearer if how == "token_revoked" else caller.headers
    target = await person(ctx.tenant_id, "approver", "target")
    async with tenant_session(ctx.tenant_id) as s:
        other_token, _ = await create_api_token(s, "other", user_id=target.user_id)
        # Someone else's invite: only an owner revokes or resends it (A5).
        invite = Invite(email="queued@example.com", role="viewer")
        s.add(invite)
        if route == "restore":
            (await s.get(User, target.user_id)).disabled_at = datetime.now(UTC)
        await s.commit()
        other_token_id, invite_id = other_token.id, invite.id

    real = publish.gate_lock
    fired = False

    async def spy(db, *, shared):
        # The caller loses standing while their request waits on the gate.
        nonlocal fired
        if not fired:
            fired = True
            await _lose_standing(ctx, how, caller.user_id, token_id)
        await real(db, shared=shared)

    monkeypatch.setattr(publish, "gate_lock", spy)
    t = target.user_id
    if route == "set_role":
        resp = await client.patch(f"/v1/members/{t}", json={"role": "viewer"}, headers=headers)
    elif route == "disable":
        resp = await disable(client, ctx, t, headers)
    elif route == "restore":
        resp = await restore(client, ctx, t, headers)
    elif route == "revoke_token":
        resp = await client.delete(f"/v1/api-tokens/{other_token_id}", headers=headers)
    elif route == "create_invite":
        # An approver invites viewers and commenters only (A5), so the owner demoted to
        # approver while waiting is refused an approver invite.
        body = {"email": "new@example.com", "role": "approver"}
        resp = await client.post("/v1/invites", json=body, headers=headers)
    elif route == "resend_invite":
        resp = await client.post(f"/v1/invites/{invite_id}/resend", headers=headers)
    else:
        resp = await client.delete(f"/v1/invites/{invite_id}", headers=headers)
    assert fired, "the route did not take the gate"
    assert resp.status_code == 403, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        user = await s.get(User, t)
        assert user.role == "approver"
        assert (user.disabled_at is not None) == (route == "restore")
        assert await s.scalar(select(Invite.id).where(Invite.email == "new@example.com")) is None
        queued = await s.get(Invite, invite_id)
        assert (queued.revoked_at, queued.resend_count) == (None, 0)


@pytest.fixture
def provider_security4():
    from tests.connection_helpers import clear_provider_http, use_provider_http

    seen = use_provider_http(lambda request: httpx.Response(200, json={"ok": True}))
    yield seen
    clear_provider_http()


async def add_oauth_connection(ctx, user_id):
    from oracle import crypto
    from oracle.connections.models import Connection

    async with tenant_session(ctx.tenant_id) as s:
        conn = Connection(
            user_id=user_id,
            provider="github",
            auth_mode="oauth",
            account_id="gh-1",
            account_label="octo",
            ciphertext=crypto.encrypt(b'{"access_token": "placeholder"}'),
            key_version=crypto.KEY_VERSION,
        )
        s.add(conn)
        await s.commit()
        return conn.id


async def test_a_disable_calls_providers_after_it_commits_outside_the_gate(
    client, monkeypatch, provider_security4
):
    from sqlalchemy import text

    from oracle.connections import service as connections

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    conn_id = await add_oauth_connection(ctx, pm.user_id)
    seen: list[tuple[bool, bool]] = []

    async def revoke(http, conn):
        async with tenant_session(ctx.tenant_id) as s:
            free = await s.scalar(
                text("SELECT pg_try_advisory_xact_lock(hashtextextended(:k, 0))"),
                {"k": f"oracle-review-gate:{ctx.tenant_id}"},
            )
            disabled = (await s.get(User, pm.user_id)).disabled_at is not None
            await s.rollback()
        seen.append((free, disabled))
        return "revoked"

    monkeypatch.setattr(connections, "revoke_at_provider", revoke)
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    # Called once, with the disable committed and the company-wide gate free.
    assert seen == [(True, True)]
    from oracle.audit import AuditEvent

    async with tenant_session(ctx.tenant_id) as s:
        events = {
            e.action: e
            for e in await s.scalars(select(AuditEvent).where(AuditEvent.entity_id == conn_id))
        }
        assert events["connection.provider_revoke"].data["outcome"] == "revoked"


async def test_a_failed_provider_revoke_is_retried_from_the_tick(
    client, monkeypatch, provider_security4
):
    from datetime import UTC, datetime

    from oracle.connections import service as connections
    from oracle.members.models import MemberFollowUp

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    await add_oauth_connection(ctx, pm.user_id)
    outcomes = ["failed", "revoked"]
    calls: list[str] = []

    async def revoke(http, conn):
        calls.append(conn.provider)
        return outcomes.pop(0)

    monkeypatch.setattr(connections, "revoke_at_provider", revoke)
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        [row] = (await s.scalars(select(MemberFollowUp))).all()
        assert row.status == "pending" and row.attempts == 1 and row.outcome == "failed"
        # Round 5: retried by time, with a backoff; make it due.
        row.next_attempt_at = datetime.now(UTC)
        await s.commit()
    resp = await client.post("/v1/internal/tick", headers=ctx.auth)
    assert resp.status_code == 200, resp.text
    assert calls == ["github", "github"]
    async with tenant_session(ctx.tenant_id) as s:
        [row] = (await s.scalars(select(MemberFollowUp))).all()
        assert row.status == "done" and row.outcome == "revoked" and row.ciphertext is None


# --- OAUTH GRANTS: revoking an MCP OAuth grant voids the approvals made through it -----


async def oauth_grant(ctx, user_id) -> tuple[str, str, str, uuid.UUID]:
    """An MCP client's grant for ``user_id``: (client_id, access, refresh, grant id)."""
    from oracle.mcp.oauth.models import OAuthClient
    from oracle.mcp.oauth.service import _new_token_row

    async with tenant_session(ctx.tenant_id) as s:
        oc = OAuthClient(
            client_id=uuid.uuid4().hex, name="Desk client", redirect_uris=["http://127.0.0.1/cb"]
        )
        s.add(oc)
        await s.flush()
        row, issued = _new_token_row(
            client_id=oc.id, user_id=user_id, scope="oracle:read oracle:write", family_id=None
        )
        s.add(row)
        await s.commit()
        return oc.client_id, issued.access_token, issued.refresh_token, row.family_id


async def test_approvals_through_an_oauth_grant_record_it(client):
    from oracle.audit import AuditEvent
    from oracle.docs.models import DocumentVersion
    from oracle.review.models import SectionReview
    from tests.review_v2_helpers import approve_all

    pass

    ctx = await setup(client)
    await policy(client, ctx, section_approval="all_sections")
    pm = await person(ctx.tenant_id, "approver", "pm")
    _, access, _, grant_id = await oauth_grant(ctx, pm.user_id)
    agent = {"Authorization": f"Bearer {access}"}
    await approve_all(client, agent, 1)
    await approved(client, ctx, headers=agent)
    assert (await check(client, ctx))["can_publish"] is True
    async with tenant_session(ctx.tenant_id) as s:
        reviews = (await s.scalars(select(SectionReview))).all()
        assert reviews and {r.grant_id for r in reviews} == {grant_id}
        assert {r.reviewer_id for r in reviews} == {pm.user_id}
        v1 = await s.scalar(select(DocumentVersion).where(DocumentVersion.number == 1))
        assert v1.approved_grant_id == grant_id and v1.approved_by == pm.user_id
        events = (
            await s.scalars(
                select(AuditEvent).where(
                    AuditEvent.action.in_(("version.approve", "section.review"))
                )
            )
        ).all()
        assert events and {e.actor_grant_id for e in events} == {grant_id}


@pytest.mark.parametrize("how", ["revoke_access", "revoke_refresh", "refresh_reuse"])
async def test_revoking_an_oauth_grant_voids_its_approvals(client, how):
    from oracle.docs.models import DocumentVersion
    from oracle.review.models import SectionReview
    from tests.review_v2_helpers import approve_all, states, verdict

    pass

    ctx = await setup(client)
    await policy(client, ctx, section_approval="all_sections")
    pm = await person(ctx.tenant_id, "approver", "pm")
    client_id, access, refresh, grant_id = await oauth_grant(ctx, pm.user_id)
    agent = {"Authorization": f"Bearer {access}"}
    await approve_all(client, agent, 1)
    await approved(client, ctx, headers=agent)
    # One approval by the person directly stands.
    async with tenant_session(ctx.tenant_id) as s:
        own = await s.scalar(select(SectionReview.id).where(SectionReview.section_key == "risks"))
    assert (await verdict(client, pm.headers, 1, "risks")).status_code == 200
    assert (await check(client, ctx))["can_publish"] is True

    if how == "refresh_reuse":
        form = {"grant_type": "refresh_token", "client_id": client_id, "refresh_token": refresh}
        assert (await client.post("/oauth/token", data=form)).status_code == 200
        reused = await client.post("/oauth/token", data=form)
        assert reused.status_code == 400 and "reused" in reused.text
    else:
        token = access if how == "revoke_access" else refresh
        resp = await client.post("/oauth/revoke", data={"client_id": client_id, "token": token})
        assert resp.status_code == 200
    # Lapsed for good, in the revocation's own transaction.
    async with tenant_session(ctx.tenant_id) as s:
        reviews = (
            await s.scalars(select(SectionReview).where(SectionReview.grant_id == grant_id))
        ).all()
        assert reviews and all(r.lapsed_at is not None for r in reviews)
        assert all("OAuth grant" in r.lapse_reason for r in reviews)
        assert own is not None
        v1 = await s.scalar(select(DocumentVersion).where(DocumentVersion.number == 1))
        assert v1.approved_at is None and v1.approval_lapsed_at is not None
        assert v1.approved_grant_id == grant_id
    body = await check(client, ctx)
    assert {"version_approval_lapsed", "missing_approval"} <= set(codes(body))
    s1 = await states(client, ctx.auth, 1)
    assert s1["risks"]["status"] == "approved"
    assert s1["problem"]["status"] == "unreviewed"
    # The person still signs in; only the grant is gone.
    assert (await client.get(f"/v1/documents/{DOC}", headers=pm.headers)).status_code == 200


async def test_a_grant_revoked_outside_the_endpoint_still_voids_at_gate_time(client):
    from datetime import UTC, datetime

    from sqlalchemy import update

    from oracle.mcp.oauth.models import OAuthToken

    pass

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    _, access, _, grant_id = await oauth_grant(ctx, pm.user_id)
    await approved(client, ctx, headers={"Authorization": f"Bearer {access}"})
    async with tenant_session(ctx.tenant_id) as s:
        await s.execute(
            update(OAuthToken)
            .where(OAuthToken.family_id == grant_id)
            .values(revoked_at=datetime.now(UTC))
        )
        await s.commit()
    assert codes(await check(client, ctx)) == ["version_approval_lapsed"]


async def test_a_verdict_through_a_grant_revoked_while_waiting_is_refused(client, monkeypatch):
    from datetime import UTC, datetime

    from sqlalchemy import update

    from oracle.mcp.oauth.models import OAuthToken
    from oracle.review import publish
    from tests.review_v2_helpers import verdict

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    _, access, _, grant_id = await oauth_grant(ctx, pm.user_id)
    real = publish.gate_lock

    async def spy(db, *, shared):
        async with tenant_session(ctx.tenant_id) as s:
            await s.execute(
                update(OAuthToken)
                .where(OAuthToken.family_id == grant_id)
                .values(revoked_at=datetime.now(UTC))
            )
            await s.commit()
        await real(db, shared=shared)

    monkeypatch.setattr(publish, "gate_lock", spy)
    resp = await verdict(client, {"Authorization": f"Bearer {access}"}, 1, "problem")
    assert resp.status_code == 403, resp.text


# --- minors -------------------------------------------------------------------------------


def _uuid_forms(page: uuid.UUID) -> list[str]:
    return [page.hex, page.hex.upper(), "{" + str(page) + "}", f"urn:uuid:{page}", str(page)]


@pytest.mark.parametrize("form", range(5))
@pytest.mark.parametrize("stored", ["dashed", "undashed"])
@pytest.mark.parametrize("revoke", ["delete_source", "disable_owner"])
async def test_a_notion_page_id_in_any_uuid_form_is_matched(client, form, stored, revoke):
    from oracle.sources.models import Source, SourceItem
    from tests.review_v2_helpers import DRAFT, import_md, replace

    pass

    ctx = await setup(client)
    owner = await person(ctx.tenant_id, "approver", "source-owner")
    page = uuid.uuid4()
    async with tenant_session(ctx.tenant_id) as s:
        source = Source(owner_user_id=owner.user_id, kind="notion", name="Wiki")
        s.add(source)
        await s.flush()
        external = str(page) if stored == "dashed" else page.hex
        s.add(SourceItem(source_id=source.id, external_id=external, kind="page", title="Plan"))
        await s.commit()
        source_id = source.id
    ref = _uuid_forms(page)[form]
    draft = replace(
        replace(DRAFT, "ref: https://example.com/calendar-survey", f'ref: "{ref}"'),
        "source: web",
        "source: notion",
    )
    assert (await import_md(client, ctx.auth, draft, base=1)).status_code == 201
    await approved(client, ctx, 2)
    assert (await check(client, ctx, 2))["can_publish"] is True
    if revoke == "delete_source":
        resp = await client.delete(f"/v1/sources/{source_id}", headers=owner.headers)
        assert resp.status_code == 204, resp.text
    else:
        assert (await disable(client, ctx, owner.user_id)).status_code == 200
    body = await check(client, ctx, 2)
    assert "source_permission_revoked" in codes(body), (ref, external)
    assert blocker(body, "source_permission_revoked")["section_keys"] == ["goal-trace"]


async def test_an_unrelated_revoked_notion_source_does_not_block(client):
    """A revoked source's external ids match only citations of those ids (a loop
    variable once shadowed the matched section keys, so any match flagged them all)."""
    from oracle.sources.models import Source, SourceItem
    from tests.review_v2_helpers import DRAFT, import_md, replace

    pass

    ctx = await setup(client)
    owner = await person(ctx.tenant_id, "approver", "source-owner")
    async with tenant_session(ctx.tenant_id) as s:
        source = Source(owner_user_id=owner.user_id, kind="notion", name="Other wiki")
        s.add(source)
        await s.flush()
        s.add(SourceItem(source_id=source.id, external_id=str(uuid.uuid4()), kind="page"))
        await s.commit()
    draft = replace(
        replace(DRAFT, "ref: https://example.com/calendar-survey", f"ref: {uuid.uuid4()}"),
        "source: web",
        "source: notion",
    )
    assert (await import_md(client, ctx.auth, draft, base=1)).status_code == 201
    await approved(client, ctx, 2)
    assert (await disable(client, ctx, owner.user_id)).status_code == 200
    assert (await check(client, ctx, 2))["can_publish"] is True


async def test_an_oauth_refresh_racing_a_disable_leaves_no_live_token(client, monkeypatch):
    """A refresh that arrives while a disable runs either waits and is refused, or its
    new token is revoked: none survives to work after a restore."""
    import asyncio

    from oracle.mcp.oauth.models import OAuthToken
    from oracle.members import service as members

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    client_id, _, refresh, _ = await oauth_grant(ctx, pm.user_id)
    real = members._disconnect_all
    holding, refreshing = asyncio.Event(), asyncio.Event()

    async def slow(session, principal, user, via):
        out = await real(session, principal, user, via)
        holding.set()  # the disable holds the member's row lock from here to its commit
        await refreshing.wait()
        await asyncio.sleep(0.5)
        return out

    monkeypatch.setattr(members, "_disconnect_all", slow)
    a = asyncio.create_task(disable(client, ctx, pm.user_id))
    await holding.wait()
    form = {"grant_type": "refresh_token", "client_id": client_id, "refresh_token": refresh}
    b = asyncio.create_task(client.post("/oauth/token", data=form))
    refreshing.set()
    ra, rb = await asyncio.gather(a, b)
    assert ra.status_code == 200, ra.text
    assert rb.status_code == 400 and rb.json()["error"] == "invalid_grant", rb.text
    async with tenant_session(ctx.tenant_id) as s:
        live = await s.scalars(
            select(OAuthToken).where(
                OAuthToken.user_id == pm.user_id, OAuthToken.revoked_at.is_(None)
            )
        )
        assert list(live) == []


async def test_a_connections_callback_racing_a_disable_connects_nothing(client, monkeypatch):
    """The provider's callback authenticated before the disable; the member is disabled
    while the code is exchanged. No connection is created for them."""
    from datetime import UTC, datetime

    from oracle.connections import oauth as provider_oauth
    from oracle.connections.models import Connection
    from oracle.connections.providers import PROVIDERS
    from tests.connection_helpers import clear_provider_http, use_provider_http

    for key, value in {
        "ORACLE_OAUTH_GITHUB_CLIENT_ID": "client-123",
        "ORACLE_OAUTH_GITHUB_CLIENT_SECRET": "secret-456",
        "ORACLE_OAUTH_REDIRECT_BASE": "https://oracle.example.com",
    }.items():
        monkeypatch.setenv(key, value)
    provider_oauth.get_oauth_settings.cache_clear()
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    state = provider_oauth.encode_state(
        provider_oauth.State(
            tenant_id=ctx.tenant_id,
            user_id=pm.user_id,
            provider="github",
            verifier="v" * 64,
            connection_id=None,
        )
    )
    real = provider_oauth.exchange_code

    async def exchange(*args, **kw):
        out = await real(*args, **kw)
        async with tenant_session(ctx.tenant_id) as s:
            (await s.get(User, pm.user_id)).disabled_at = datetime.now(UTC)
            await s.commit()
        return out

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url == "https://github.com/login/oauth/access_token":
            return httpx.Response(200, json={"access_token": "example-access", "scope": "repo"})
        return httpx.Response(200, json={"id": 42, "login": "user-42"})

    monkeypatch.setattr(provider_oauth, "exchange_code", exchange)
    use_provider_http(handler)
    try:
        back = await client.get(
            "/v1/connections/github/callback",
            params={"code": "the-code", "state": state},
            headers=pm.headers,
        )
    finally:
        clear_provider_http()
        provider_oauth.get_oauth_settings.cache_clear()
    assert PROVIDERS
    assert back.status_code == 303 and "error=" in back.headers["location"], back.headers
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.scalars(select(Connection))).all() == []


async def test_a_disable_revokes_the_invites_the_member_created(client):
    from oracle.members.models import Invite

    ctx = await setup(client)
    rogue = await person(ctx.tenant_id, "owner", "rogue")
    resp = await client.post(
        "/v1/invites", json={"email": "friend@example.com", "role": "owner"}, headers=rogue.headers
    )
    assert resp.status_code == 201, resp.text
    resp = await client.post(
        "/v1/invites", json={"email": "kept@example.com", "role": "viewer"}, headers=ctx.auth
    )
    assert resp.status_code == 201, resp.text
    assert (await disable(client, ctx, rogue.user_id)).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        invites = {i.email: i for i in await s.scalars(select(Invite))}
    assert invites["friend@example.com"].revoked_at is not None
    assert invites["kept@example.com"].revoked_at is None


async def test_a_disable_cancels_the_members_queued_llm_jobs(client):
    from oracle.docs.models import Document
    from oracle.jobs.models import LlmJob

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    async with tenant_session(ctx.tenant_id) as s:
        doc_id = await s.scalar(select(Document.id).where(Document.slug == DOC))
        mine = LlmJob(kind="reporting", document_id=doc_id, requested_by=pm.user_id)
        running = LlmJob(
            kind="reporting", document_id=doc_id, requested_by=pm.user_id, status="running"
        )
        other = LlmJob(kind="reporting", document_id=doc_id, requested_by=None)
        s.add_all([mine, running, other])
        await s.commit()
        ids = mine.id, running.id, other.id
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        jobs = [await s.get(LlmJob, i) for i in ids]
    assert [j.status for j in jobs] == ["cancelled", "running", "queued"]
    assert "removed" in jobs[0].error


@pytest.mark.parametrize("started", [False, True])
async def test_a_spend_approval_by_a_disabled_approver_is_voided_on_an_unstarted_run(
    client, started
):
    from datetime import UTC, datetime
    from decimal import Decimal

    from oracle.runs.models import Run, RunSegment

    ctx = await setup(client)
    approver = await person(ctx.tenant_id, "owner", "approver")
    author = await person(ctx.tenant_id, "approver", "author")
    async with tenant_session(ctx.tenant_id) as s:
        run = Run(
            flow="baseline_to_prd",
            created_by=author.user_id,
            status="running",
            estimate_usd=Decimal("40"),
            approved_by=approver.user_id,
            approved_at=datetime.now(UTC),
        )
        s.add(run)
        await s.flush()
        s.add(
            RunSegment(
                run_id=run.id,
                seq=1,
                name="baseline",
                status="running" if started else "pending",
                started_at=datetime.now(UTC) if started else None,
            )
        )
        await s.commit()
        run_id = run.id
    assert (await disable(client, ctx, approver.user_id)).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        run = await s.get(Run, run_id)
    if started:
        # A started run keeps its ceiling and its approval.
        assert run.status == "running" and run.approved_by == approver.user_id
    else:
        assert run.status == "awaiting_approval"
        assert run.approved_by is None and run.approved_at is None


async def test_a_sync_in_flight_does_not_resume_a_disabled_members_source(client, monkeypatch):
    from oracle import crypto
    from oracle.connections.models import Connection
    from oracle.sources import base
    from oracle.sources import service as sources
    from oracle.sources.base import CursorCheckpoint
    from oracle.sources.models import Source
    from tests.sources_helpers import message

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")

    class Midway:
        kind = "slack"

        async def validate(self, config, credential):
            return None

        async def sync(self, config, credential, cursor):
            yield message("m1", "first")
            yield CursorCheckpoint({"page": 1})
            # The owner is removed while the sync runs.
            assert (await disable(client, ctx, pm.user_id)).status_code == 200
            yield message("m2", "second")
            yield CursorCheckpoint({"page": 2})

    sources.load_connectors()
    monkeypatch.setitem(base._registry, "slack", Midway())
    async with tenant_session(ctx.tenant_id) as s:
        conn = Connection(
            user_id=pm.user_id,
            provider="slack",
            auth_mode="token",
            account_id="T1",
            account_label="Workspace",
            ciphertext=crypto.encrypt(b'{"access_token": "placeholder"}'),
            key_version=crypto.KEY_VERSION,
        )
        s.add(conn)
        await s.flush()
        source = Source(
            owner_user_id=pm.user_id,
            kind="slack",
            name="Chat",
            connection_id=conn.id,
            config={"channels": ["C1"]},
            # A source that failed before: a good sync puts it back to active.
            status="error",
            last_error="Rate limited",
        )
        s.add(source)
        await s.commit()
        source_id = source.id
    resp = await client.post(f"/v1/sources/{source_id}/sync", headers=pm.headers)
    assert resp.status_code in (200, 401, 403), resp.text
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(Source, source_id)).status == "paused"


async def test_a_revoked_run_token_is_refused_under_the_gate(client):
    from oracle.auth.deps import Principal
    from oracle.auth.service import caller_refusal
    from oracle.runs.models import Run
    from oracle.runtokens import RunToken, mint_run_token, revoke_run_tokens

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    async with tenant_session(ctx.tenant_id) as s:
        run = Run(flow="baseline_to_prd", created_by=pm.user_id, status="running")
        s.add(run)
        await s.flush()
        await mint_run_token(s, run.id, ["read:documents"], 600)
        await s.commit()
        token_id = await s.scalar(select(RunToken.id).where(RunToken.run_id == run.id))
        principal = Principal(
            tenant_id=ctx.tenant_id,
            kind="user",
            role="approver",
            user_id=pm.user_id,
            run_id=run.id,
            run_token_id=token_id,
        )
        assert await caller_refusal(s, principal, "approver") is None
        await revoke_run_tokens(s, run.id)
        await s.commit()
        assert await caller_refusal(s, principal, "approver") == "This run's token was revoked"


@pytest.mark.parametrize("field", ["owner_id", "reviewer_ids"])
async def test_a_disabled_member_cannot_be_a_section_owner_or_reviewer(client, field):
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    value = str(pm.user_id) if field == "owner_id" else [str(pm.user_id)]
    resp = await client.put(
        f"/v1/documents/{DOC}/sections/problem/assignment", json={field: value}, headers=ctx.auth
    )
    assert resp.status_code in (400, 422), resp.text
    assert "removed" in resp.text


async def test_campaign_invitees_by_role_leave_out_disabled_members(client):
    from oracle.review.models import Notification

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "commenter", "pm")
    gone = await person(ctx.tenant_id, "commenter", "gone")
    assert (await disable(client, ctx, gone.user_id)).status_code == 200
    resp = await client.post(
        f"/v1/documents/{DOC}/campaigns",
        json={"title": "Feedback", "audience_roles": ["commenter"]},
        headers=ctx.auth,
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["invited"] == 1
    async with tenant_session(ctx.tenant_id) as s:
        notified = set(await s.scalars(select(Notification.user_id)))
    assert pm.user_id in notified and gone.user_id not in notified


async def test_the_legacy_version_view_shows_a_lapsed_approval_as_lapsed(client):
    from tests.review_v2_helpers import verdict

    pass

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    assert (await verdict(client, pm.headers, 1, "problem")).status_code == 200
    body = (await client.get(f"/v1/documents/{DOC}/versions/1", headers=ctx.auth)).json()
    [problem] = [s for s in body["sections"] if s["section_key"] == "problem"]
    assert problem["verdict"]["verdict"] == "approved"
    assert problem["verdict"]["lapsed_at"] is None
    assert (await set_role(client, ctx, pm.user_id, "commenter")).status_code == 200
    body = (await client.get(f"/v1/documents/{DOC}/versions/1", headers=ctx.auth)).json()
    [problem] = [s for s in body["sections"] if s["section_key"] == "problem"]
    assert problem["verdict"]["lapsed_at"] is not None
    assert "demoted" in problem["verdict"]["lapse_reason"]


async def test_a_disabled_row_does_not_block_the_same_email_in_another_company(client):
    from datetime import UTC, datetime

    from oracle.auth.service import authenticate_user, create_user
    from tests.conftest import make_tenant

    email = f"shared-{uuid.uuid4().hex[:8]}@example.com"
    first, second = await make_tenant("First Co"), await make_tenant("Second Co")
    ids = {}
    for tenant in (first, second):
        async with tenant_session(tenant) as s:
            user = await create_user(s, email, "pw")
            if tenant == first:
                user.disabled_at = datetime.now(UTC)
            await s.commit()
            ids[tenant] = user.id
    user = await authenticate_user(email, "pw")
    assert user is not None and user.id == ids[second]
    assert (await sign_in(client, email)).status_code == 200
    # Wrong password, or only disabled rows: nobody.
    assert await authenticate_user(email, "nope") is None
    async with tenant_session(second) as s:
        (await s.get(User, ids[second])).disabled_at = datetime.now(UTC)
        await s.commit()
    assert await authenticate_user(email, "pw") is None


async def test_a_new_approval_keeps_the_lapsed_history(client):
    pass
    pass

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    token_id, agent = await member_token(ctx, pm.user_id, "pm-agent")
    await approved(client, ctx, headers=agent)
    assert (await client.delete(f"/v1/api-tokens/{token_id}", headers=ctx.auth)).status_code == 204
    # Someone else approves again: the lapse is history, not gone.
    await approved(client, ctx)
    body = (await client.get(f"/v1/documents/{DOC}/versions/1", headers=ctx.auth)).json()
    assert body["approved_at"] is not None
    [lapse] = body["approval_lapses"]
    assert lapse["approved_by"] == str(pm.user_id)
    assert lapse["approved_token_id"] == str(token_id)
    assert lapse["lapsed_at"] and lapse["approved_at"] and "revoked" in lapse["reason"]
    # The owner still sees the token's version approval, lapsed.
    rows = (await client.get(f"/v1/api-tokens/{token_id}/approvals", headers=ctx.auth)).json()
    [version] = [r for r in rows if r["kind"] == "version"]
    assert version["lapsed_at"] is not None and version["approver_id"] == str(pm.user_id)


# -----------------------------------------------------------------------------
# CR-06 review fixes, round 5 (PR #57, on #45 / #38), after the owner's C2 follow-ups
# (2026-10-19): owner-level writes re-check the caller under the gate like member routes;
# a provider revoke that keeps failing is retried for 24 hours and shown to owners in the
# Inbox with Retry and Dismiss. Synthetic placeholders only.


@pytest.fixture
def provider_security5():
    from tests.connection_helpers import clear_provider_http, use_provider_http

    seen = use_provider_http(lambda request: httpx.Response(200, json={"ok": True}))
    yield seen
    clear_provider_http()


# --- ITEM 1: owner-level writes re-check the caller under the gate --------------------

POLICY = {
    "decider_id": None,
    "mandatory_reviewer_ids": [],
    "required_section_keys": [],
    "section_approval": "required_sections",
    "rereview_on_change": False,
}


async def _settings(ctx) -> dict:
    from oracle.tenant_settings import TenantSetting

    async with tenant_session(ctx.tenant_id) as s:
        return {r.key: r.value for r in await s.scalars(select(TenantSetting))}


async def _document_policy(ctx):
    from oracle.review.models import DocumentReviewPolicy

    async with tenant_session(ctx.tenant_id) as s:
        return await s.scalar(select(DocumentReviewPolicy))


ROGUE_WRITES = ["iap_default_role", "review_policy", "document_review_policy"]


async def _rogue_write(client, what: str, headers):
    if what == "iap_default_role":
        return await client.put(
            "/v1/settings/iap_default_role", json={"value": "viewer"}, headers=headers
        )
    if what == "review_policy":
        return await client.put(
            "/v1/settings/review_policy", json={"value": POLICY}, headers=headers
        )
    return await client.put(f"/v1/documents/{DOC}/review-policy", json=POLICY, headers=headers)


@pytest.mark.parametrize("what", ROGUE_WRITES)
async def test_an_owner_write_queued_on_the_gate_while_the_owner_is_disabled_is_refused(
    client, monkeypatch, what
):
    """Rogue owner B writes a company setting or a PRD's review policy; owner A disables
    B. B's request, queued on the gate while A holds it, runs after A commits: refused,
    nothing written."""
    from oracle.review import publish

    ctx = await setup(client)
    rogue = await person(ctx.tenant_id, "owner", "rogue")
    real = publish.gate_lock
    a_holds, b_waits = asyncio.Event(), asyncio.Event()
    calls = 0

    async def spy(db, *, shared):
        nonlocal calls
        calls += 1
        if calls == 1:  # A's disable: hold the gate until B queues on it
            await real(db, shared=shared)
            a_holds.set()
            try:  # a route that never takes the gate never queues: give up, and see
                await asyncio.wait_for(b_waits.wait(), 2)
            except TimeoutError:
                pass
            await asyncio.sleep(0.3)
            return
        b_waits.set()
        await real(db, shared=shared)

    monkeypatch.setattr(publish, "gate_lock", spy)
    a = asyncio.create_task(disable(client, ctx, rogue.user_id))
    await a_holds.wait()
    b = asyncio.create_task(_rogue_write(client, what, rogue.headers))
    ra, rb = await asyncio.gather(a, b)
    assert ra.status_code == 200, ra.text
    assert rb.status_code == 403, rb.text
    assert b_waits.is_set(), "the write did not take the gate"
    if what == "document_review_policy":
        assert await _document_policy(ctx) is None
    else:
        assert what not in await _settings(ctx)


async def _awaiting_run(ctx, author_id) -> uuid.UUID:
    from oracle.runs.models import Run, RunSegment

    async with tenant_session(ctx.tenant_id) as s:
        run = Run(
            flow="baseline_to_prd",
            created_by=author_id,
            status="awaiting_approval",
            estimate_usd=Decimal("80"),
        )
        s.add(run)
        await s.flush()
        s.add(RunSegment(run_id=run.id, seq=1, name="baseline", status="pending"))
        await s.commit()
        return run.id


OWNER_ROUTES = [
    "settings_confidence_weights",
    "settings_publish_latest_only",
    "settings_reset",
    "document_review_policy",
    "llm_job_settings",
    "draft_defaults",
    "claude_fallback",
    "run_approve",
    "run_resume",
]
APPROVER_ROUTES = ["llm_job_enqueue", "run_start", "run_create"]


@pytest.mark.parametrize(
    "route,how",
    [(r, "disabled") for r in OWNER_ROUTES + APPROVER_ROUTES]
    + [("settings_confidence_weights", "demoted"), ("run_approve", "demoted")]
    + [("document_review_policy", "token_revoked"), ("llm_job_enqueue", "token_revoked")],
)
async def test_an_owner_or_approver_write_by_a_caller_who_lost_standing_is_refused(
    client, monkeypatch, route, how
):
    from oracle.jobs.models import LlmJob
    from oracle.review import publish
    from oracle.runs.models import Run

    ctx = await setup(client)
    role = "approver" if route in APPROVER_ROUTES else "owner"
    caller = await person(ctx.tenant_id, role, "caller")
    token_id, bearer = await member_token(ctx, caller.user_id, "caller-agent")
    headers = bearer if how == "token_revoked" else caller.headers
    author = await person(ctx.tenant_id, "approver", "author")
    run_id = await _awaiting_run(ctx, author.user_id)
    if route == "run_resume":
        async with tenant_session(ctx.tenant_id) as s:
            (await s.get(Run, run_id)).status = "paused_overrun"
            await s.commit()
    if route == "run_start":
        async with tenant_session(ctx.tenant_id) as s:
            run = await s.get(Run, run_id)
            run.status, run.created_by = "draft", caller.user_id
            await s.commit()
    before = await _settings(ctx)

    real = publish.gate_lock
    fired = False

    async def spy(db, *, shared):
        nonlocal fired
        if not fired:
            fired = True
            await _lose_standing(ctx, how, caller.user_id, token_id)
        await real(db, shared=shared)

    monkeypatch.setattr(publish, "gate_lock", spy)
    if route == "settings_confidence_weights":
        body = {"value": {"low": 0.3}}
        resp = await client.put("/v1/settings/confidence_weights", json=body, headers=headers)
    elif route == "settings_publish_latest_only":
        body = {"value": False}
        resp = await client.put("/v1/settings/publish_latest_only", json=body, headers=headers)
    elif route == "settings_reset":
        body = {"value": None}
        resp = await client.put("/v1/settings/iap_default_role", json=body, headers=headers)
    elif route == "document_review_policy":
        resp = await client.put(f"/v1/documents/{DOC}/review-policy", json=POLICY, headers=headers)
    elif route == "llm_job_settings":
        body = {"review_comments": False, "reporting": True, "refinement": True}
        resp = await client.put(
            f"/v1/documents/{DOC}/llm-jobs/settings", json=body, headers=headers
        )
    elif route == "draft_defaults":
        resp = await client.put("/v1/drafts/defaults", json={}, headers=headers)
    elif route == "claude_fallback":
        token = "-".join(("sk", "ant", "api03", "placeholder" * 3))
        body = {"token": token}
        resp = await client.put("/v1/claude-accounts/fallback", json=body, headers=headers)
    elif route == "run_approve":
        resp = await client.post(f"/v1/runs/{run_id}/approve", headers=headers)
    elif route == "run_resume":
        resp = await client.post(f"/v1/runs/{run_id}/resume", headers=headers)
    elif route == "run_start":
        resp = await client.post(f"/v1/runs/{run_id}/start", headers=headers)
    elif route == "run_create":
        body = {"flow": "baseline_to_prd"}
        resp = await client.post("/v1/runs", json=body, headers=headers)
    else:
        body = {"kind": "review_comments"}
        resp = await client.post(f"/v1/documents/{DOC}/llm-jobs", json=body, headers=headers)
    assert fired, "the route did not take the gate"
    assert resp.status_code == 403, resp.text
    assert await _settings(ctx) == before
    assert await _document_policy(ctx) is None
    async with tenant_session(ctx.tenant_id) as s:
        run = await s.get(Run, run_id)
        assert run.approved_by is None
        assert run.status in ("awaiting_approval", "paused_overrun", "draft")
        assert await s.scalar(select(LlmJob.id)) is None
        assert await s.scalar(select(Run.id).where(Run.id != run_id)) is None


async def test_an_active_owner_still_writes_settings_and_policies(client):
    ctx = await setup(client)
    owner = await person(ctx.tenant_id, "owner", "owner")
    for what in ROGUE_WRITES:
        resp = await _rogue_write(client, what, owner.headers)
        assert resp.status_code == 200, (what, resp.text)
    settings = await _settings(ctx)
    assert settings["iap_default_role"] == "viewer"
    assert settings["review_policy"]["rereview_on_change"] is False
    assert await _document_policy(ctx) is not None
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(User, owner.user_id)).disabled_at is None


# --- ITEM 2: a provider revoke that keeps failing: 24 hours, then the Inbox -------------


async def add_connection_security5(ctx, user_id, account: str) -> uuid.UUID:
    """An OAuth GitHub connection of ``user_id`` (``account``: the provider's account id)."""
    from oracle import crypto
    from oracle.connections.models import Connection

    async with tenant_session(ctx.tenant_id) as s:
        conn = Connection(
            user_id=user_id,
            provider="github",
            auth_mode="oauth",
            account_id=account,
            account_label=account,
            ciphertext=crypto.encrypt(b'{"access_token": "placeholder"}'),
            key_version=crypto.KEY_VERSION,
        )
        s.add(conn)
        await s.commit()
        return conn.id


def _always(outcome: str, calls: list | None = None):
    async def revoke(http, conn):
        if calls is not None:
            calls.append(conn.id)
        return outcome

    return revoke


async def _follow_up_row(ctx):
    from oracle.members.models import MemberFollowUp

    async with tenant_session(ctx.tenant_id) as s:
        return (await s.scalars(select(MemberFollowUp))).one()


async def _shift(ctx, *, created_hours_ago: float | None = None, due: bool = True) -> None:
    """Move the follow-up's clock: due now, and created ``created_hours_ago`` hours ago."""
    from datetime import UTC, datetime, timedelta

    from oracle.members.models import MemberFollowUp

    async with tenant_session(ctx.tenant_id) as s:
        row = (await s.scalars(select(MemberFollowUp))).one()
        now = datetime.now(UTC)
        if due:
            row.next_attempt_at = now - timedelta(seconds=1)
        if created_hours_ago is not None:
            row.created_at = now - timedelta(hours=created_hours_ago)
        await s.commit()


async def _tick(client, ctx):
    resp = await client.post("/v1/internal/tick", headers=ctx.auth)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _revoke_failures(client, headers) -> list[dict]:
    resp = await client.get("/v1/inbox", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()["revoke_failures"]


async def test_a_failing_revoke_is_retried_by_time_for_24_hours_and_keeps_its_copy(
    client, monkeypatch, provider_security5
):
    from oracle.connections import service as connections

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    await add_oauth_connection(ctx, pm.user_id)
    calls: list = []
    monkeypatch.setattr(connections, "revoke_at_provider", _always("failed", calls))
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    assert len(calls) == 1
    # Ticks in quick succession do not burn retries: the next one waits for its backoff.
    for _ in range(6):
        await _tick(client, ctx)
    assert len(calls) == 1
    row = await _follow_up_row(ctx)
    assert row.status == "pending" and row.attempts == 1 and row.ciphertext is not None
    # Due again: retried, still pending, the copy kept; well past 5 attempts.
    for _ in range(6):
        await _shift(ctx)
        await _tick(client, ctx)
    assert len(calls) == 7
    row = await _follow_up_row(ctx)
    assert row.status == "pending" and row.attempts == 7 and row.ciphertext is not None
    # 24 hours on: retrying stops; the copy is kept for an owner's Retry or Dismiss.
    await _shift(ctx, created_hours_ago=25)
    await _tick(client, ctx)
    row = await _follow_up_row(ctx)
    assert row.status == "failed" and row.ciphertext is not None
    await _shift(ctx)
    await _tick(client, ctx)
    assert len(calls) == 8  # no automatic retry after the 24 hours
    [item] = await _revoke_failures(client, ctx.auth)
    email = await email_of(ctx, pm.user_id)
    assert item["title"] == f"Couldn't revoke {email}'s GitHub access at GitHub"
    assert item["status"] == "failed" and item["outcome"] == "failed"


@pytest.mark.parametrize("outcome", ["not_configured", "unreadable"])
async def test_not_configured_and_unreadable_are_not_a_success(
    client, monkeypatch, provider_security5, outcome
):
    from oracle.connections import service as connections

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    await add_oauth_connection(ctx, pm.user_id)
    monkeypatch.setattr(connections, "revoke_at_provider", _always(outcome))
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    row = await _follow_up_row(ctx)
    assert row.status == "pending" and row.outcome == outcome and row.ciphertext is not None
    [item] = await _revoke_failures(client, ctx.auth)
    assert item["outcome"] == outcome


async def test_owners_see_revoke_failures_others_do_not(client, monkeypatch, provider_security5):
    from oracle.connections import service as connections

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    other = await person(ctx.tenant_id, "approver", "other")
    await add_oauth_connection(ctx, pm.user_id)
    monkeypatch.setattr(connections, "revoke_at_provider", _always("failed"))
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    assert len(await _revoke_failures(client, ctx.auth)) == 1
    assert await _revoke_failures(client, other.headers) == []
    resp = await client.get("/v1/inbox", headers=ctx.auth)
    assert resp.json()["total"] >= 1


async def test_retry_runs_now_and_a_success_drops_the_copy(client, monkeypatch, provider_security5):
    from oracle.audit import AuditEvent
    from oracle.connections import service as connections

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    await add_oauth_connection(ctx, pm.user_id)
    monkeypatch.setattr(connections, "revoke_at_provider", _always("failed"))
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    await _shift(ctx, created_hours_ago=25)
    await _tick(client, ctx)
    [item] = await _revoke_failures(client, ctx.auth)
    # Retry is owner-only.
    resp = await client.post(f"/v1/member-follow-ups/{item['id']}/retry", headers=pm.headers)
    assert resp.status_code in (401, 403)
    calls: list = []
    monkeypatch.setattr(connections, "revoke_at_provider", _always("revoked", calls))
    resp = await client.post(f"/v1/member-follow-ups/{item['id']}/retry", headers=ctx.auth)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "done" and resp.json()["outcome"] == "revoked"
    assert len(calls) == 1
    row = await _follow_up_row(ctx)
    assert row.status == "done" and row.ciphertext is None
    assert await _revoke_failures(client, ctx.auth) == []
    async with tenant_session(ctx.tenant_id) as s:
        actions = list(await s.scalars(select(AuditEvent.action)))
    assert "connection.provider_revoke" in actions


async def test_a_failed_retry_keeps_the_item(client, monkeypatch, provider_security5):
    from oracle.connections import service as connections

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    await add_oauth_connection(ctx, pm.user_id)
    monkeypatch.setattr(connections, "revoke_at_provider", _always("failed"))
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    [item] = await _revoke_failures(client, ctx.auth)
    resp = await client.post(f"/v1/member-follow-ups/{item['id']}/retry", headers=ctx.auth)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "pending" and resp.json()["attempts"] == 2
    row = await _follow_up_row(ctx)
    assert row.ciphertext is not None
    assert len(await _revoke_failures(client, ctx.auth)) == 1


async def test_dismiss_is_owner_only_audited_and_drops_the_copy(
    client, monkeypatch, provider_security5
):
    from oracle.audit import AuditEvent
    from oracle.connections import service as connections

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    approver = await person(ctx.tenant_id, "approver", "approver")
    await add_oauth_connection(ctx, pm.user_id)
    monkeypatch.setattr(connections, "revoke_at_provider", _always("failed"))
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    [item] = await _revoke_failures(client, ctx.auth)
    url = f"/v1/member-follow-ups/{item['id']}/dismiss"
    assert (await client.post(url, headers=approver.headers)).status_code == 403
    assert (await _follow_up_row(ctx)).ciphertext is not None
    resp = await client.post(url, headers=ctx.auth)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "dismissed"
    row = await _follow_up_row(ctx)
    assert row.status == "dismissed" and row.ciphertext is None and row.dismissed_at
    assert await _revoke_failures(client, ctx.auth) == []
    async with tenant_session(ctx.tenant_id) as s:
        event = await s.scalar(
            select(AuditEvent).where(AuditEvent.action == "connection.provider_revoke_dismissed")
        )
    assert event is not None and event.data["member_id"] == str(pm.user_id)
    # A dismissed revoke is never tried again.
    await _shift(ctx)
    await _tick(client, ctx)
    assert (await _follow_up_row(ctx)).status == "dismissed"
    retry = await client.post(f"/v1/member-follow-ups/{item['id']}/retry", headers=ctx.auth)
    assert retry.status_code == 409


async def test_dismiss_by_an_owner_disabled_while_waiting_on_the_gate_is_refused(
    client, monkeypatch, provider_security5
):
    from oracle.connections import service as connections
    from oracle.review import publish

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    caller = await person(ctx.tenant_id, "owner", "caller")
    await add_oauth_connection(ctx, pm.user_id)
    monkeypatch.setattr(connections, "revoke_at_provider", _always("failed"))
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    [item] = await _revoke_failures(client, ctx.auth)
    real = publish.gate_lock
    fired = False

    async def spy(db, *, shared):
        nonlocal fired
        if not fired:
            fired = True
            await _lose_standing(ctx, "disabled", caller.user_id)
        await real(db, shared=shared)

    monkeypatch.setattr(publish, "gate_lock", spy)
    url = f"/v1/member-follow-ups/{item['id']}/dismiss"
    assert (await client.post(url, headers=caller.headers)).status_code == 403
    assert fired
    assert (await _follow_up_row(ctx)).ciphertext is not None


@pytest.mark.timing
async def test_follow_ups_run_after_runs_and_jobs_within_a_time_budget(
    client, monkeypatch, provider_security5
):
    from oracle.connections import service as connections
    from oracle.members import service as members
    from oracle.members.models import MemberFollowUp
    from oracle.runs import router as runs_router

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    for i in range(3):
        await add_connection_security5(ctx, pm.user_id, f"gh-{i}")
    monkeypatch.setattr(connections, "revoke_at_provider", _always("failed"))
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        for row in await s.scalars(select(MemberFollowUp)):
            row.next_attempt_at = datetime.now(UTC)
        await s.commit()

    order: list[str] = []
    real_tick, real_jobs = runs_router.service.tick, runs_router.run_llm_jobs

    async def runs_tick(db, principal=None):
        order.append("runs")
        return await real_tick(db, principal)

    async def jobs(tenant_id, **kwargs):
        order.append("jobs")
        return await real_jobs(tenant_id, **kwargs)

    async def slow(http, conn):
        order.append("revoke")
        await asyncio.sleep(0.6)
        return "failed"

    monkeypatch.setattr(runs_router.service, "tick", runs_tick)
    monkeypatch.setattr(runs_router, "run_llm_jobs", jobs)
    monkeypatch.setattr(connections, "revoke_at_provider", slow)
    monkeypatch.setattr(members, "FOLLOW_UP_TICK_BUDGET_SECONDS", 1.0)
    started = asyncio.get_running_loop().time()
    out = await _tick(client, ctx)
    elapsed = asyncio.get_running_loop().time() - started
    # Runs and jobs first; then as many follow-ups as fit in the budget, the rest wait.
    assert order[:2] == ["runs", "jobs"]
    assert order.count("revoke") < 3
    assert 1 <= out["member_follow_ups"] < 3
    assert elapsed < 1.0 + 1.5
    # A call the budget cut short is not counted: it is due again at the next tick.
    async with tenant_session(ctx.tenant_id) as s:
        attempts = sorted(r.attempts for r in await s.scalars(select(MemberFollowUp)))
    assert attempts == [1] * (3 - out["member_follow_ups"]) + [2] * out["member_follow_ups"]


async def test_a_db_error_in_one_follow_up_rolls_it_back_and_the_others_run(
    client, monkeypatch, provider_security5
):
    from sqlalchemy import text

    from oracle.connections import service as connections
    from oracle.members import service as members
    from oracle.members.models import MemberFollowUp

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    first = await add_connection_security5(ctx, pm.user_id, "gh-1")
    second = await add_connection_security5(ctx, pm.user_id, "gh-2")
    monkeypatch.setattr(connections, "revoke_at_provider", _always("failed"))
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        for row in await s.scalars(select(MemberFollowUp)):
            row.next_attempt_at = datetime.now(UTC)
        await s.commit()

    real_record = members.audit.record

    async def record(session, *args, **kwargs):
        if args[2] == "connection" and args[3] == first and args[1] == "connection.provider_revoke":
            await session.execute(text("SELECT 1/0"))  # a real DB error: the txn aborts
        return await real_record(session, *args, **kwargs)

    monkeypatch.setattr(connections, "revoke_at_provider", _always("revoked"))
    monkeypatch.setattr(members.audit, "record", record)
    out = await _tick(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        rows = {r.target_id: r for r in await s.scalars(select(MemberFollowUp))}
    # The broken one rolled back (still pending, its copy kept); the other one ran.
    assert rows[first].status == "pending" and rows[first].attempts == 1
    assert rows[first].ciphertext is not None
    assert rows[second].status == "done" and rows[second].ciphertext is None
    assert out["member_follow_ups"] >= 1


# --- MINORS --------------------------------------------------------------------------


async def test_the_sweep_rechecks_the_member_under_the_gate(client, monkeypatch):
    """A restore that commits while the sweep waits on the gate: nothing of the restored
    member's is revoked."""
    from oracle.auth.models import ApiToken
    from oracle.members.service import sweep_disabled
    from oracle.review import publish

    pass

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    token_id, _ = await member_token(ctx, pm.user_id, "slipped-in")
    real = publish.gate_lock

    async def spy(db, *, shared):
        monkeypatch.setattr(publish, "gate_lock", real)
        assert (await restore(client, ctx, pm.user_id)).status_code == 200
        await real(db, shared=shared)

    monkeypatch.setattr(publish, "gate_lock", spy)
    async with tenant_session(ctx.tenant_id) as s:
        assert await sweep_disabled(s, None, pm.user_id) is False
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(ApiToken, token_id)).revoked_at is None


async def test_a_disable_waits_for_a_locked_queued_job_and_cancels_it(client):
    from oracle.docs.models import Document
    from oracle.jobs.models import LlmJob

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    async with tenant_session(ctx.tenant_id) as s:
        doc_id = await s.scalar(select(Document.id).where(Document.slug == DOC))
        job = LlmJob(kind="reporting", document_id=doc_id, requested_by=pm.user_id)
        s.add(job)
        await s.commit()
        job_id = job.id
    held = asyncio.Event()

    async def hold():
        # A worker looking at the job (its claim locks the row briefly).
        async with tenant_session(ctx.tenant_id) as s:
            await s.scalar(select(LlmJob).where(LlmJob.id == job_id).with_for_update())
            held.set()
            await asyncio.sleep(0.5)
            await s.rollback()

    holder = asyncio.create_task(hold())
    await held.wait()
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    await holder
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(LlmJob, job_id)).status == "cancelled"


@pytest.mark.parametrize(
    "spelling",
    [
        "URN:UUID:{u}",
        "Urn:Uuid:{u}",
        "urn:uuid:{U}",
        "URN:UUID:{{{U}}}",
        "  URN:UUID:{h}  ",
    ],
)
def test_external_key_accepts_any_case_urn_prefix(spelling):
    from oracle.review.publish import _as_uuid, external_key

    u = uuid.UUID("12345678-9abc-def0-1234-56789abcdef0")
    value = spelling.format(u=u, U=str(u).upper(), h=u.hex)
    assert external_key(value) == str(u)
    assert _as_uuid(value) == u


# -----------------------------------------------------------------------------
# CR-06 review fixes, round 6 (PR #69, on #57 / #45 / #38), after round 5's security
# review: approver-level writes re-check the caller under the gate (C2: a disable voids
# their approvals, a demoted approver's lapse), and the review gate is never held across
# a SwarmCloud call. Synthetic placeholders only.


WAIT = 5  # seconds: long enough for any route here, short enough to fail fast
# A baseline segment's spend past the overrun ceiling of the default Baseline to PRD run:
# 1.5x its estimate of $36.50 (six segments with the Engineering dates, on by default).
OVERSPEND = Decimal(60)


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


async def _lose(ctx, how: str, user_id, token_id=None) -> None:
    """The caller loses standing: disabled, demoted one step (owner to approver,
    approver to commenter), or their API token revoked."""
    from oracle.auth.models import ApiToken

    async with tenant_session(ctx.tenant_id) as s:
        user = await s.get(User, user_id)
        if how == "disabled":
            user.disabled_at = datetime.now(UTC)
        elif how == "demoted":
            user.role = "approver" if user.role == "owner" else "commenter"
        else:
            (await s.get(ApiToken, token_id)).revoked_at = datetime.now(UTC)
        await s.commit()


def _lose_on_first_gate(monkeypatch, ctx, how, user_id, token_id=None) -> list[bool]:
    """The first time the request takes the gate, the caller loses standing (a disable,
    a demotion or a revoke that commits while the request waits on the gate). Returns
    a flag the test reads: did the request take the gate at all?"""
    from oracle.review import publish

    real = publish.gate_lock
    fired: list[bool] = []

    async def spy(db, *, shared):
        if not fired:
            fired.append(True)
            await _lose(ctx, how, user_id, token_id)
        await real(db, shared=shared)

    monkeypatch.setattr(publish, "gate_lock", spy)
    return fired


async def _tick_security6(client, ctx) -> dict:
    resp = await client.post("/v1/internal/tick", headers=ctx.auth)
    assert resp.status_code == 200, resp.text
    assert resp.json()["errors"] == []
    return resp.json()


async def _run(client, ctx, headers=None, **knobs) -> dict:
    headers = headers or ctx.auth
    resp = await client.post(
        "/v1/runs", json={"flow": "baseline_to_prd", "document": DOC, "knobs": knobs},
        headers=headers,
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    run = resp.json()
    est = await client.post(f"/v1/runs/{run['id']}/estimate", headers=headers)
    assert est.status_code == 200, est.text
    return run


async def _started(client, ctx, headers=None, **knobs) -> dict:
    headers = headers or ctx.auth
    run = await _run(client, ctx, headers, **knobs)
    resp = await client.post(f"/v1/runs/{run['id']}/start", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _read(client, ctx, run_id) -> dict:
    resp = await client.get(f"/v1/runs/{run_id}", headers=ctx.auth)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _at_checkpoint(client, ctx) -> dict:
    run = await _started(client, ctx)
    await _tick_security6(client, ctx)
    run = await _read(client, ctx, run["id"])
    assert run["status"] == "awaiting_checkpoint", run
    return run


def _pending(run) -> dict:
    return next(c for c in run["checkpoints"] if c["status"] == "pending")


def _decide(client, run, headers, decision="approved", note=None):
    cp = _pending(run)
    return client.post(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/decide",
        json={"decision": decision, "note": note},
        headers=headers,
    )


class _Blocked:
    """Holds one runtime call (submit or cancel) until released: SwarmCloud being slow."""

    def __init__(self, runtime: FakeRuntime, method: str) -> None:
        self.entered, self.release = asyncio.Event(), asyncio.Event()
        real = getattr(runtime, method)

        async def slow(*args):
            self.entered.set()
            await self.release.wait()
            return await real(*args)

        setattr(runtime, method, slow)


# --- ITEM 1a: a checkpoint decision re-checks the caller under the gate ---------------


@pytest.mark.parametrize("how", ["disabled", "demoted", "token_revoked"])
@pytest.mark.parametrize("decision", ["approved", "changes_requested"])
async def test_a_checkpoint_decision_by_an_approver_who_lost_standing_is_refused(
    client, monkeypatch, runtime, how, decision
):
    ctx = await setup(client)
    run = await _at_checkpoint(client, ctx)
    approver = await person(ctx.tenant_id, "approver", "approver")
    token_id, bearer = await member_token(ctx, approver.user_id, "approver-agent")
    headers = bearer if how == "token_revoked" else approver.headers
    fired = _lose_on_first_gate(monkeypatch, ctx, how, approver.user_id, token_id)
    resp = await _decide(client, run, headers, decision, "Cite G1")
    assert fired, "the decision did not take the gate"
    assert resp.status_code == 403, resp.text
    run = await _read(client, ctx, run["id"])
    assert run["status"] == "awaiting_checkpoint"
    assert _pending(run)["decided_by"] is None
    assert len(runtime.submitted) == 1  # nothing more was submitted, nothing spent


async def test_an_active_approver_still_decides_a_checkpoint(client, runtime):
    ctx = await setup(client)
    run = await _at_checkpoint(client, ctx)
    approver = await person(ctx.tenant_id, "approver", "approver")
    resp = await _decide(client, run, approver.headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "running"
    assert resp.json()["segments"][1]["status"] == "running"
    assert len(runtime.submitted) == 2


@pytest.mark.parametrize("decision", ["approved", "changes_requested"])
async def test_a_disable_racing_a_checkpoint_decision_voids_it(client, runtime, decision):
    """Approver B decides a checkpoint; while SwarmCloud takes its time over the
    segment B's decision starts, owner A disables B. The disable does not wait for
    SwarmCloud, and B's decision is void: the checkpoint waits again, the workflow
    submitted for it is cancelled, nothing more runs for it."""
    ctx = await setup(client)
    run = await _at_checkpoint(client, ctx)
    first_workflow = runtime.submitted[0].labels
    approver = await person(ctx.tenant_id, "approver", "approver")
    blocked = _Blocked(runtime, "submit")
    decided = asyncio.create_task(_decide(client, run, approver.headers, decision, "Cite G1"))
    try:
        await asyncio.wait_for(blocked.entered.wait(), WAIT)
        resp = await asyncio.wait_for(disable(client, ctx, approver.user_id), WAIT)
        assert resp.status_code == 200, resp.text
        assert not decided.done()
    finally:
        blocked.release.set()
    resp = await decided
    assert resp.status_code == 200, resp.text
    run = await _read(client, ctx, run["id"])
    assert run["status"] == "awaiting_checkpoint", run
    cp = _pending(run)
    assert cp["decided_by"] is None and cp["decided_at"] is None
    # The workflow SwarmCloud started for the void decision is cancelled at once.
    assert len(runtime.submitted) == 2
    assert len(runtime.cancelled) == 1
    assert runtime.cancelled[0].startswith(f"fake-{runtime.submitted[1].labels['segment']}-")
    seg = run["segments"]
    assert seg[0]["status"] == "succeeded" and seg[1]["status"] == "pending"
    assert seg[0]["attempts"][-1]["attempt"] == int(first_workflow["attempt"])
    async with tenant_session(ctx.tenant_id) as s:
        voided = list(
            await s.scalars(
                select(AuditEvent).where(AuditEvent.action == "checkpoint.decision_voided")
            )
        )
        assert [e.data["decided_by"] for e in voided] == [str(approver.user_id)]
    # A tick submits nothing for it.
    await _tick_security6(client, ctx)
    assert len(runtime.submitted) == 2
    # Another approver decides it again; the next segment starts.
    other = await person(ctx.tenant_id, "approver", "other")
    resp = await _decide(client, await _read(client, ctx, run["id"]), other.headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "running"


async def test_a_disable_voids_a_decision_whose_submission_is_waiting_for_a_retry(client, runtime):
    """The runtime refused the submission a decision started (it waits for the tick's
    retry); the decider is disabled: the decision is void, the tick submits nothing."""
    from oracle.swarm import RuntimeUnavailable

    ctx = await setup(client)
    run = await _at_checkpoint(client, ctx)
    approver = await person(ctx.tenant_id, "approver", "approver")
    real = runtime.submit

    async def down(spec):
        raise RuntimeUnavailable("SwarmCloud is down")

    runtime.submit = down
    resp = await _decide(client, run, approver.headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["segments"][1]["status"] == "pending"
    runtime.submit = real
    assert (await disable(client, ctx, approver.user_id)).status_code == 200
    await _tick_security6(client, ctx)
    run = await _read(client, ctx, run["id"])
    assert run["status"] == "awaiting_checkpoint"
    assert len(runtime.submitted) == 1


# --- ITEM 1b: the other approver-only branches re-check under the gate ----------------


@pytest.mark.parametrize("how", ["disabled", "demoted"])
async def test_an_approver_section_edit_by_one_who_lost_standing_is_refused(
    client, monkeypatch, how
):
    from oracle.docs.models import DocumentVersion

    ctx = await setup(client)
    approver = await person(ctx.tenant_id, "approver", "approver")
    rev = (await states(client, ctx.auth, 1))["problem"]["revision"]
    fired = _lose_on_first_gate(monkeypatch, ctx, how, approver.user_id)
    resp = await edit(client, approver.headers, "problem", 1, rev, "Rewritten.")
    assert fired, "the edit did not take the gate"
    assert resp.status_code == 403, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.scalar(select(DocumentVersion.id).where(DocumentVersion.number == 2)) is None


async def test_an_active_approver_still_edits_any_section(client):
    ctx = await setup(client)
    approver = await person(ctx.tenant_id, "approver", "approver")
    rev = (await states(client, ctx.auth, 1))["problem"]["revision"]
    resp = await edit(client, approver.headers, "problem", 1, rev, "Rewritten.")
    assert resp.status_code == 201, resp.text


@pytest.mark.parametrize("how", ["disabled", "demoted"])
async def test_an_owner_cancelling_someone_elses_run_after_losing_standing_is_refused(
    client, monkeypatch, runtime, how
):
    """Owner B cancels a run approver A created; B is demoted to approver (or disabled)
    while the request waits on the gate: an approver cancels only their own runs."""
    ctx = await setup(client)
    author = await person(ctx.tenant_id, "approver", "author")
    run = await _started(client, ctx, author.headers)
    owner = await person(ctx.tenant_id, "owner", "owner")
    fired = _lose_on_first_gate(monkeypatch, ctx, how, owner.user_id)
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=owner.headers)
    assert fired
    assert resp.status_code == 403, resp.text
    assert (await _read(client, ctx, run["id"]))["status"] == "running"
    assert runtime.cancelled == []


async def test_an_owner_and_the_creator_still_cancel(client, runtime):
    ctx = await setup(client)
    author = await person(ctx.tenant_id, "approver", "author")
    owner = await person(ctx.tenant_id, "owner", "owner")
    for headers in (owner.headers, author.headers):
        run = await _started(client, ctx, author.headers)
        resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=headers)
        assert resp.status_code == 200, resp.text
        assert resp.json()["status"] == "cancelled"
    assert len(runtime.cancelled) == 2


async def _evidence(ctx, added_by=None) -> uuid.UUID:
    from oracle.baseline.models import Entity, Evidence

    async with tenant_session(ctx.tenant_id) as s:
        feature = Entity(
            type="feature", key=f"calendar-{uuid.uuid4().hex[:6]}", title="Calendar", origin="user"
        )
        s.add(feature)
        await s.flush()
        ev = Evidence(
            entity_id=feature.id,
            url="https://example.com/calendar-survey",
            excerpt="Teams miss shared deadlines.",
            confidence=Decimal("0.7"),
            kind="web" if added_by else None,
            added_by=added_by,
        )
        s.add(ev)
        await s.commit()
        return ev.id


@pytest.mark.parametrize("how", ["disabled", "demoted"])
async def test_an_approver_removing_evidence_after_losing_standing_is_refused(
    client, monkeypatch, how
):
    from oracle.baseline.models import Evidence

    ctx = await setup(client)
    evidence_id = await _evidence(ctx)
    approver = await person(ctx.tenant_id, "approver", "approver")
    fired = _lose_on_first_gate(monkeypatch, ctx, how, approver.user_id)
    resp = await client.delete(f"/v1/baseline/evidence/{evidence_id}", headers=approver.headers)
    assert fired, "the removal did not take the gate"
    assert resp.status_code == 403, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.get(Evidence, evidence_id) is not None


async def test_an_approver_and_the_commenter_who_added_a_link_still_remove_it(client):
    ctx = await setup(client)
    approver = await person(ctx.tenant_id, "approver", "approver")
    commenter = await person(ctx.tenant_id, "commenter", "commenter")
    theirs = await _evidence(ctx)
    resp = await client.delete(f"/v1/baseline/evidence/{theirs}", headers=approver.headers)
    assert resp.status_code == 204, resp.text
    mine = await _evidence(ctx, added_by=commenter.user_id)
    resp = await client.delete(f"/v1/baseline/evidence/{mine}", headers=commenter.headers)
    assert resp.status_code == 204, resp.text


async def _comment(client, ctx) -> str:
    resp = await client.post(
        f"/v1/documents/{DOC}/versions/1/comments",
        json={
            "section_key": "problem",
            "anchor": {"exact": "shared deadlines", "prefix": "", "suffix": ""},
            "body": "Which teams?",
        },
        headers=ctx.auth,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


@pytest.mark.parametrize("how", ["disabled", "demoted"])
async def test_an_approver_moderating_a_comment_after_losing_standing_is_refused(
    client, monkeypatch, how
):
    ctx = await setup(client)
    comment_id = await _comment(client, ctx)
    approver = await person(ctx.tenant_id, "approver", "approver")
    fired = _lose_on_first_gate(monkeypatch, ctx, how, approver.user_id)
    resp = await client.patch(
        f"/v1/comments/{comment_id}", json={"resolved": True, "body": "Rewritten"},
        headers=approver.headers,
    )  # fmt: skip
    assert fired, "the moderation did not take the gate"
    assert resp.status_code == 403, resp.text
    comments = await client.get(f"/v1/documents/{DOC}/versions/1/comments", headers=ctx.auth)
    [comment] = comments.json()
    assert comment["resolved_at"] is None and comment["body"] == "Which teams?"


async def test_an_approver_still_moderates_and_an_author_still_edits_their_own(client):
    ctx = await setup(client)
    comment_id = await _comment(client, ctx)
    approver = await person(ctx.tenant_id, "approver", "approver")
    resp = await client.patch(
        f"/v1/comments/{comment_id}", json={"resolved": True}, headers=approver.headers
    )
    assert resp.status_code == 200, resp.text
    resp = await client.patch(
        f"/v1/comments/{comment_id}", json={"body": "Which teams, exactly?"}, headers=ctx.auth
    )
    assert resp.status_code == 200, resp.text


# --- ITEM 2: the review gate is not held across a SwarmCloud call -----------------------


async def _prepare(client, ctx, runtime, route: str) -> tuple[dict, str]:
    """A run ready for ``route``, and the runtime call the route makes."""
    if route == "start":
        return await _run(client, ctx), "submit"
    if route == "approve":
        run = await _started(client, ctx, depth="deep")
        assert run["status"] == "awaiting_approval"
        return run, "submit"
    if route == "resume":
        # Paused on overrun with its segment finished and its checkpoint off: resuming
        # submits the next segment.
        runtime.script["baseline"] = [Outcome(cost_usd=OVERSPEND, polls=1)]
        run = await _started(client, ctx, checkpoints={"baseline_confirm": False})
        await _tick_security6(client, ctx)
        await _tick_security6(client, ctx)
        run = await _read(client, ctx, run["id"])
        assert run["status"] == "paused_overrun", run
        return run, "submit"
    if route == "cancel":
        return await _started(client, ctx), "cancel"
    return await _at_checkpoint(client, ctx), "submit"


async def _call(client, ctx, route: str, run: dict):
    if route == "decide":
        return await _decide(client, run, ctx.auth)
    return await client.post(f"/v1/runs/{run['id']}/{route}", headers=ctx.auth)


@pytest.mark.parametrize("route", ["start", "approve", "resume", "cancel", "decide"])
async def test_a_slow_runtime_call_does_not_hold_the_gate(client, runtime, route):
    """The route's SwarmCloud call hangs; a disable of another member, which takes the
    gate exclusively, completes while the call is still waiting."""
    ctx = await setup(client)
    bystander = await person(ctx.tenant_id, "approver", "bystander")
    run, method = await _prepare(client, ctx, runtime, route)
    calls_before = len(runtime.submitted) + len(runtime.cancelled)
    blocked = _Blocked(runtime, method)
    call = asyncio.create_task(_call(client, ctx, route, run))
    try:
        await asyncio.wait_for(blocked.entered.wait(), WAIT)
        resp = await asyncio.wait_for(disable(client, ctx, bystander.user_id), WAIT)
        assert resp.status_code == 200, resp.text
        assert not call.done(), "the call was not under way"
    finally:
        blocked.release.set()
    resp = await call
    assert resp.status_code == 200, resp.text
    assert len(runtime.submitted) + len(runtime.cancelled) == calls_before + 1
    expected = "cancelled" if route == "cancel" else "running"
    assert resp.json()["status"] == expected, resp.json()


async def test_a_disable_racing_a_start_cancels_the_workflow_it_submitted(client, runtime):
    """Approver B starts their run; while SwarmCloud takes its time, B is disabled: the
    disable does not wait, the run is cancelled, and the workflow that SwarmCloud
    started for it is cancelled as soon as Oracle hears of it."""
    ctx = await setup(client)
    author = await person(ctx.tenant_id, "approver", "author")
    run = await _run(client, ctx, author.headers)
    blocked = _Blocked(runtime, "submit")
    call = asyncio.create_task(client.post(f"/v1/runs/{run['id']}/start", headers=author.headers))
    try:
        await asyncio.wait_for(blocked.entered.wait(), WAIT)
        resp = await asyncio.wait_for(disable(client, ctx, author.user_id), WAIT)
        assert resp.status_code == 200, resp.text
    finally:
        blocked.release.set()
    resp = await call
    assert resp.status_code == 200, resp.text
    run = await _read(client, ctx, run["id"])
    assert run["status"] == "cancelled"
    assert len(runtime.submitted) == 1 and len(runtime.cancelled) == 1
    async with tenant_session(ctx.tenant_id) as s:
        seg = await s.scalar(select(RunSegment).where(RunSegment.seq == 1))
        assert seg.status == "cancelled" and seg.swarm_workflow_id is None
        event = await s.scalar(
            select(AuditEvent).where(AuditEvent.action == "run.workflow_cancelled")
        )
        assert event.data["workflow_id"] == runtime.cancelled[0]


async def test_a_disable_racing_an_approve_voids_it_and_cancels_the_workflow(client, runtime):
    """Owner B approves a run's cost; while SwarmCloud takes its time, B is disabled:
    the approval is void (the run waits for an owner again) and the workflow is
    cancelled."""
    ctx = await setup(client)
    run = await _started(client, ctx, depth="deep")
    owner = await person(ctx.tenant_id, "owner", "owner")
    blocked = _Blocked(runtime, "submit")
    call = asyncio.create_task(client.post(f"/v1/runs/{run['id']}/approve", headers=owner.headers))
    try:
        await asyncio.wait_for(blocked.entered.wait(), WAIT)
        resp = await asyncio.wait_for(disable(client, ctx, owner.user_id), WAIT)
        assert resp.status_code == 200, resp.text
    finally:
        blocked.release.set()
    assert (await call).status_code == 200
    run = await _read(client, ctx, run["id"])
    assert run["status"] == "awaiting_approval", run
    assert len(runtime.cancelled) == 1
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(Run, uuid.UUID(run["id"]))
        assert row.approved_by is None
        seg = await s.scalar(select(RunSegment).where(RunSegment.seq == 1))
        assert seg.status == "pending" and seg.swarm_workflow_id is None
    await _tick_security6(client, ctx)
    assert len(runtime.submitted) == 1


async def test_a_submission_lost_after_commit_is_made_by_the_tick(client, runtime, monkeypatch):
    """The state change commits, then the process dies before SwarmCloud is called: the
    next tick makes the submission."""
    from oracle.runs import service

    async def die(db, run_id):
        raise RuntimeError("the process died")

    ctx = await setup(client)
    run = await _run(client, ctx)
    monkeypatch.setattr(service, "submit_queued", die)
    with pytest.raises(RuntimeError):
        await client.post(f"/v1/runs/{run['id']}/start", headers=ctx.auth)
    monkeypatch.undo()
    assert runtime.submitted == []
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(Run, uuid.UUID(run["id"]))).status == "running"
    await _tick_security6(client, ctx)
    run = await _read(client, ctx, run["id"])
    assert run["segments"][0]["status"] == "running"
    assert len(runtime.submitted) == 1


async def test_a_claimed_submission_is_not_made_twice_by_the_tick(client, runtime):
    """A tick that runs while a route's submission is under way leaves it alone."""
    ctx = await setup(client)
    run = await _run(client, ctx)
    blocked = _Blocked(runtime, "submit")
    call = asyncio.create_task(client.post(f"/v1/runs/{run['id']}/start", headers=ctx.auth))
    try:
        await asyncio.wait_for(blocked.entered.wait(), WAIT)
        await asyncio.wait_for(_tick_security6(client, ctx), WAIT)
    finally:
        blocked.release.set()
    assert (await call).status_code == 200
    assert len(runtime.submitted) == 1
    assert (await _read(client, ctx, run["id"]))["segments"][0]["status"] == "running"


async def test_a_failed_cancel_of_a_workflow_started_for_a_changed_run_is_retried(client, runtime):
    """The run was cancelled while its submission was under way, and the runtime does
    not confirm the cancel of the workflow it started: the tick retries it."""
    from oracle.members.models import MemberFollowUp
    from oracle.swarm import RuntimeUnavailable

    ctx = await setup(client)
    run = await _run(client, ctx)
    blocked = _Blocked(runtime, "submit")
    real_cancel = runtime.cancel

    async def down(workflow_id):
        raise RuntimeUnavailable("SwarmCloud is down")

    call = asyncio.create_task(client.post(f"/v1/runs/{run['id']}/start", headers=ctx.auth))
    try:
        await asyncio.wait_for(blocked.entered.wait(), WAIT)
        resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=ctx.auth)
        assert resp.status_code == 200, resp.text
        runtime.cancel = down
    finally:
        blocked.release.set()
    assert (await call).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.scalar(select(MemberFollowUp))
        assert row.kind == "run_cancel" and row.status == "pending"
        row.next_attempt_at = None
        await s.commit()
    runtime.cancel = real_cancel
    await _tick_security6(client, ctx)
    assert len(runtime.cancelled) == 1
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.scalar(select(MemberFollowUp))).status == "done"


# --- MINORS --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "spelling", ["{{URN:UUID:{u}}}", "UUID:{u}", "URN:{u}", "Uuid:{h}", "{{urn:uuid:{U}}}"]
)
def test_external_key_reads_every_uuid_spelling_in_any_case(spelling):
    from oracle.review.publish import _as_uuid, external_key

    u = uuid.UUID("12345678-9abc-def0-1234-56789abcdef0")
    value = spelling.format(u=u, U=str(u).upper(), h=u.hex)
    assert external_key(value) == str(u)
    assert _as_uuid(value) == u


@pytest.mark.parametrize(
    "stored", ["uuid:{u}", "URN:{u}", "UUID:{h}", "{{URN:UUID:{u}}}", " urn:uuid:{U} "]
)
async def test_a_stored_id_in_any_uuid_spelling_reads_as_its_hex_in_sql(client, stored):
    from sqlalchemy import literal

    from oracle.review.publish import _hex32

    ctx = await setup(client)
    u = uuid.uuid4()
    value = stored.format(u=u, U=str(u).upper(), h=u.hex)
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.scalar(select(_hex32(literal(value)))) == u.hex


async def _disabled_with_connection(client, ctx, monkeypatch, outcome="failed"):
    from oracle.connections import service as connections

    pass

    pm = await person(ctx.tenant_id, "approver", "pm")
    await add_connection_security5(ctx, pm.user_id, "gh-1")
    monkeypatch.setattr(connections, "revoke_at_provider", _always(outcome))
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    return pm


async def _due(ctx) -> None:
    from oracle.members.models import MemberFollowUp

    async with tenant_session(ctx.tenant_id) as s:
        for row in await s.scalars(select(MemberFollowUp)):
            row.next_attempt_at = datetime.now(UTC)
        await s.commit()


async def test_follow_ups_still_run_when_an_earlier_part_of_the_tick_fails(client, monkeypatch):
    from oracle.connections import service as connections
    from oracle.members.models import MemberFollowUp
    from oracle.runs import router as runs_router

    pass

    ctx = await setup(client)
    await _disabled_with_connection(client, ctx, monkeypatch)
    await _due(ctx)

    async def broken(tenant_id, **kwargs):
        raise RuntimeError("the model jobs broke")

    monkeypatch.setattr(runs_router, "run_llm_jobs", broken)
    monkeypatch.setattr(connections, "revoke_at_provider", _always("revoked"))
    with pytest.raises(RuntimeError):
        await client.post("/v1/internal/tick", headers=ctx.auth)
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.scalar(select(MemberFollowUp))).status == "done"


async def test_a_successful_revoke_that_fails_to_save_is_not_shown_as_a_failure(
    client, monkeypatch
):
    """The provider revoked the grant, then saving that failed: the next attempt
    records the success without asking the provider again (a second revoke of a dead
    grant fails), and owners never see it as "Couldn't revoke"."""
    from oracle.connections import service as connections
    from oracle.members import service as members
    from oracle.members.models import MemberFollowUp

    pass

    ctx = await setup(client)
    await _disabled_with_connection(client, ctx, monkeypatch)
    await _due(ctx)
    real_record = members.audit.record
    broke: list[bool] = []

    async def record_once(session, *args, **kwargs):
        if args[1] == "connection.provider_revoke" and not broke:
            broke.append(True)
            raise RuntimeError("the database went away")
        return await real_record(session, *args, **kwargs)

    calls: list = []
    monkeypatch.setattr(connections, "revoke_at_provider", _always("revoked", calls))
    monkeypatch.setattr(members.audit, "record", record_once)
    await _tick_security6(client, ctx)
    assert broke and len(calls) == 1
    assert await _revoke_failures(client, ctx.auth) == []
    # The provider now refuses: the grant is gone. The next attempt does not ask it.
    monkeypatch.setattr(connections, "revoke_at_provider", _always("failed", calls))
    await _due(ctx)
    await _tick_security6(client, ctx)
    assert len(calls) == 1
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.scalar(select(MemberFollowUp))
        assert row.status == "done" and row.outcome == "revoked" and row.ciphertext is None
    assert await _revoke_failures(client, ctx.auth) == []


@pytest.mark.timing
async def test_a_budget_that_runs_out_mid_query_does_not_cut_the_query_or_fail_the_tick(
    client, monkeypatch, runtime
):
    """The tick's follow-up budget runs out while a follow-up is reading the database:
    only network calls are timed, so the query is not cancelled halfway (that can leave
    the session unusable and the tick a 500); the tick answers."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import AsyncSession

    from oracle.members import service as members
    from oracle.members.models import MemberFollowUp

    ctx = await setup(client)
    author = await person(ctx.tenant_id, "approver", "author")
    await _started(client, ctx, author.headers)
    assert (await disable(client, ctx, author.user_id)).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.scalar(select(MemberFollowUp).where(MemberFollowUp.kind == "run_cancel"))
        row.status, row.attempts, row.next_attempt_at = "pending", 1, datetime.now(UTC)
        await s.commit()
    real_get = AsyncSession.get

    async def slow_get(self, entity, *args, **kwargs):
        if entity is RunSegment:
            await self.execute(text("SELECT pg_sleep(2)"))
        return await real_get(self, entity, *args, **kwargs)

    monkeypatch.setattr(AsyncSession, "get", slow_get)
    monkeypatch.setattr(members, "FOLLOW_UP_TICK_BUDGET_SECONDS", 0.5)
    resp = await client.post("/v1/internal/tick", headers=ctx.auth)
    monkeypatch.undo()
    assert resp.status_code == 200, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.scalar(select(MemberFollowUp).where(MemberFollowUp.kind == "run_cancel"))
        assert row.status == "done" and row.attempts == 2


async def test_the_sweep_rereads_what_it_revokes_after_taking_the_gate(client, monkeypatch):
    """A token created while the sweep waited on the gate is revoked and named in its
    audit; one revoked meanwhile is not named."""
    from oracle.members.service import sweep_disabled
    from oracle.review import publish

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    early, _ = await member_token(ctx, pm.user_id, "slipped-in")
    late: list[uuid.UUID] = []
    real = publish.gate_lock

    async def spy(db, *, shared):
        monkeypatch.setattr(publish, "gate_lock", real)
        token_id, _ = await member_token(ctx, pm.user_id, "slipped-in-later")
        late.append(token_id)
        await real(db, shared=shared)

    monkeypatch.setattr(publish, "gate_lock", spy)
    async with tenant_session(ctx.tenant_id) as s:
        assert await sweep_disabled(s, None, pm.user_id) is True
    async with tenant_session(ctx.tenant_id) as s:
        event = await s.scalar(
            select(AuditEvent).where(AuditEvent.action == "member.disable_sweep")
        )
        assert sorted(event.data["api_tokens"]) == sorted([str(early), str(late[0])])


async def test_the_sweep_cancels_a_job_queued_for_a_disabled_member(client):
    """The reporting job an import queued for its requester, committed after the
    requester's disable: the sweep cancels it."""
    from oracle.docs.models import Document
    from oracle.jobs.models import LlmJob
    from oracle.members.service import sweep_disabled

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        doc_id = await s.scalar(select(Document.id).where(Document.slug == DOC))
        job = LlmJob(kind="reporting", document_id=doc_id, requested_by=pm.user_id)
        s.add(job)
        await s.commit()
        job_id = job.id
    async with tenant_session(ctx.tenant_id) as s:
        assert await sweep_disabled(s, None, pm.user_id) is True
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(LlmJob, job_id)).status == "cancelled"


# -----------------------------------------------------------------------------
# CR-07 review fixes, round 7 (PR #78, on #69 / #57 / #45 / #38), after round 6's
# security review: a cancelled run (or a disabled member's) never comes back to life, the
# tick holds no run row lock across a SwarmCloud call, and the review gate is not held
# while a client's request body is read. Synthetic placeholders only.


# --- ITEM 3: the gate is not held while a request body is received --------------------

YAML = """entities:
  - type: feature
    key: slow-upload
    title: Slow upload
"""


class _SlowBody:
    """A request body sent in two halves, the second only once released: a client on
    a slow link."""

    def __init__(self, data: bytes) -> None:
        self.data = data
        self.sent_first, self.release = asyncio.Event(), asyncio.Event()

    async def __aiter__(self):
        half = len(self.data) // 2
        yield self.data[:half]
        self.sent_first.set()
        await self.release.wait()
        yield self.data[half:]


@pytest.mark.parametrize("route", ["baseline_yaml", "document_version"])
async def test_the_gate_is_not_held_while_a_request_body_is_received(client, route):
    """An approver uploads slowly; meanwhile the owner disables another member (which
    takes the gate exclusively). The disable does not wait for the upload."""
    ctx = await setup(client)
    approver = await person(ctx.tenant_id, "approver", "approver")
    other = await person(ctx.tenant_id, "commenter", "other")
    if route == "baseline_yaml":
        url, data, ctype = "/v1/baseline/yaml", YAML.encode(), "application/yaml"
    else:
        url, data, ctype = f"/v1/documents/{DOC}/versions", DRAFT.encode(), MARKDOWN["Content-Type"]
    body = _SlowBody(data)
    upload = asyncio.create_task(
        client.post(url, content=body, headers={**approver.headers, "Content-Type": ctype})
    )
    try:
        await asyncio.wait_for(body.sent_first.wait(), WAIT)
        resp = await asyncio.wait_for(disable(client, ctx, other.user_id), WAIT)
        assert resp.status_code == 200, resp.text
        assert not upload.done()
    finally:
        body.release.set()
    resp = await asyncio.wait_for(upload, WAIT)
    assert resp.status_code in (200, 201), resp.text


@pytest.mark.parametrize("route", ["baseline_yaml", "document_version"])
async def test_a_request_body_over_the_limit_is_refused_before_the_gate(client, monkeypatch, route):
    from oracle.config import get_settings
    from oracle.review import publish

    ctx = await setup(client)
    monkeypatch.setattr(get_settings(), "max_body_bytes", 64)
    taken: list[bool] = []
    real = publish.gate_lock

    async def spy(db, *, shared):
        taken.append(shared)
        await real(db, shared=shared)

    monkeypatch.setattr(publish, "gate_lock", spy)
    if route == "baseline_yaml":
        url, ctype = "/v1/baseline/yaml", "application/yaml"
    else:
        url, ctype = f"/v1/documents/{DOC}/versions", MARKDOWN["Content-Type"]

    async def chunks():  # no Content-Length: the limit holds while reading
        yield b"x" * 50
        yield b"x" * 50

    resp = await client.post(url, content=chunks(), headers={**ctx.auth, "Content-Type": ctype})
    assert resp.status_code == 413, resp.text
    assert taken == []


# --- ITEM 1: a cancelled or disabled member's run never comes back to life ------------


def _during_import(monkeypatch, act) -> list[bool]:
    """Run ``act`` while the run's baseline.yaml is being imported (its own
    transaction, the run's row lock released): a cancel or a disable that lands then."""
    from oracle.runs import service

    real = service._import_baseline
    fired: list[bool] = []

    async def spy(db, run, text):
        out = await real(db, run, text)
        if not fired:
            fired.append(True)
            await act()
        return out

    monkeypatch.setattr(service, "_import_baseline", spy)
    return fired


def _ended(run) -> None:
    """Cancelled, and nothing of it reopened: no checkpoint waits, no segment runs."""
    assert run["status"] == "cancelled", run
    assert [c for c in run["checkpoints"] if c["status"] == "pending"] == []
    assert [s["status"] for s in run["segments"]][1:] == ["cancelled"] * (len(run["segments"]) - 1)


@pytest.mark.parametrize("checkpoint", [True, False])
async def test_a_run_cancelled_during_its_import_stays_cancelled(
    client, monkeypatch, runtime, checkpoint
):
    ctx = await setup(client)
    knobs = {} if checkpoint else {"checkpoints": {"baseline_confirm": False}}
    run = await _started(client, ctx, **knobs)

    async def cancel():
        resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=ctx.auth)
        assert resp.status_code == 200, resp.text

    fired = _during_import(monkeypatch, cancel)
    await _tick_security6(client, ctx)
    assert fired
    _ended(await _read(client, ctx, run["id"]))
    assert len(runtime.submitted) == 1  # the next segment was never submitted
    await _tick_security6(client, ctx)
    _ended(await _read(client, ctx, run["id"]))
    assert len(runtime.submitted) == 1


@pytest.mark.parametrize("checkpoint", [True, False])
async def test_a_run_whose_creator_is_disabled_during_its_import_stays_cancelled(
    client, monkeypatch, runtime, checkpoint
):
    ctx = await setup(client)
    author = await person(ctx.tenant_id, "approver", "author")
    knobs = {} if checkpoint else {"checkpoints": {"baseline_confirm": False}}
    run = await _started(client, ctx, author.headers, **knobs)

    async def disable_author():
        resp = await disable(client, ctx, author.user_id)
        assert resp.status_code == 200, resp.text

    fired = _during_import(monkeypatch, disable_author)
    await _tick_security6(client, ctx)
    assert fired
    _ended(await _read(client, ctx, run["id"]))
    assert len(runtime.submitted) == 1


@pytest.mark.parametrize("checkpoint", [True, False])
async def test_a_resume_racing_a_cancel_does_not_reopen_the_run(
    client, monkeypatch, runtime, checkpoint
):
    """Paused on overrun with its segment done; the owner resumes, and while the
    resume imports the segment's baseline.yaml the run is cancelled."""
    ctx = await setup(client)
    runtime.script["baseline"] = [Outcome(cost_usd=OVERSPEND)]
    knobs = {} if checkpoint else {"checkpoints": {"baseline_confirm": False}}
    run = await _started(client, ctx, **knobs)
    await _tick_security6(client, ctx)
    assert (await _read(client, ctx, run["id"]))["status"] == "paused_overrun"

    async def cancel():
        resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=ctx.auth)
        assert resp.status_code == 200, resp.text

    fired = _during_import(monkeypatch, cancel)
    resp = await client.post(f"/v1/runs/{run['id']}/resume", headers=ctx.auth)
    assert fired
    assert resp.status_code in (200, 409), resp.text
    _ended(await _read(client, ctx, run["id"]))
    await _tick_security6(client, ctx)
    _ended(await _read(client, ctx, run["id"]))
    assert len(runtime.submitted) == 1


@pytest.mark.parametrize("target", ["cancelled", "running"])
async def test_a_checkpoint_decision_refuses_a_segment_not_in_the_expected_state(
    client, runtime, target
):
    """Defence in depth: a checkpoint whose next segment is not pending (cancelled, or
    already running) is not decided, and nothing is submitted."""
    ctx = await setup(client)
    run = await _started(client, ctx)
    await _tick_security6(client, ctx)
    run = await _read(client, ctx, run["id"])
    assert run["status"] == "awaiting_checkpoint"
    async with tenant_session(ctx.tenant_id) as s:
        seg = await s.scalar(
            select(RunSegment).where(RunSegment.run_id == run["id"], RunSegment.seq == 2)
        )
        seg.status = target
        await s.commit()
    cp = next(c for c in run["checkpoints"] if c["status"] == "pending")
    resp = await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/decide",
        json={"decision": "approved", "note": None},
        headers=ctx.auth,
    )
    assert resp.status_code == 409, resp.text
    assert len(runtime.submitted) == 1


async def test_a_checkpoint_decision_on_a_cancelled_run_is_refused(client, runtime):
    ctx = await setup(client)
    run = await _started(client, ctx)
    await _tick_security6(client, ctx)
    run = await _read(client, ctx, run["id"])
    cp = next(c for c in run["checkpoints"] if c["status"] == "pending")
    async with tenant_session(ctx.tenant_id) as s:
        # A run cancelled under a checkpoint left pending (as a reopened one was).
        (await s.get(Run, uuid.UUID(run["id"]))).status = "cancelled"
        await s.commit()
    resp = await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/decide",
        json={"decision": "approved", "note": None},
        headers=ctx.auth,
    )
    assert resp.status_code == 409, resp.text
    assert len(runtime.submitted) == 1


# --- ITEM 2: the tick holds no run row lock across a SwarmCloud call -----------------


@pytest.mark.parametrize("method", ["status", "artifacts"])
async def test_a_slow_swarmcloud_call_in_the_tick_does_not_block_a_disable(client, runtime, method):
    """The tick reads a run's workflow while SwarmCloud takes its time; the owner
    disables the run's creator meanwhile (the gate exclusively, then the run's row).
    The disable does not wait for SwarmCloud, and the tick then leaves the run
    cancelled: no checkpoint, nothing submitted."""
    ctx = await setup(client)
    author = await person(ctx.tenant_id, "approver", "author")
    run = await _started(client, ctx, author.headers)
    blocked = _Blocked(runtime, method)
    ticking = asyncio.create_task(client.post("/v1/internal/tick", headers=ctx.auth))
    try:
        await asyncio.wait_for(blocked.entered.wait(), WAIT)
        resp = await asyncio.wait_for(disable(client, ctx, author.user_id), WAIT)
        assert resp.status_code == 200, resp.text
        assert not ticking.done()
    finally:
        blocked.release.set()
    resp = await asyncio.wait_for(ticking, WAIT)
    assert resp.status_code == 200, resp.text
    run = await _read(client, ctx, run["id"])
    assert run["status"] == "cancelled"
    assert run["checkpoints"] == []
    assert len(runtime.submitted) == 1


async def test_a_tick_pass_on_one_run_has_an_overall_deadline(client, monkeypatch, runtime):
    """SwarmCloud never answers: the tick gives up on the run within its deadline,
    reports it, and the run is as it was."""
    from oracle.runs import service

    ctx = await setup(client)
    run = await _started(client, ctx)
    monkeypatch.setattr(service, "TICK_RUN_SECONDS", 0.3)
    _Blocked(runtime, "status")
    resp = await asyncio.wait_for(client.post("/v1/internal/tick", headers=ctx.auth), WAIT)
    assert resp.status_code == 200, resp.text
    assert len(resp.json()["errors"]) == 1
    assert (await _read(client, ctx, run["id"]))["status"] == "running"


def _swarm(raw):
    """A SwarmCloud whose one task lists ``names`` and serves each through ``raw``."""
    import httpx

    from oracle.swarm.swarmcloud import StaticBearer, SwarmCloudRuntime

    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/v1/workflows/wf_1":
            return httpx.Response(
                200,
                json={
                    "workflow": {"state": "SUCCEEDED", "steps": [{"task_id": "t1"}]},
                    "tasks": [{"id": "t1", "state": "SUCCEEDED"}],
                },
            )
        if path.endswith("/artifacts"):
            return httpx.Response(200, json={"artifacts": raw.listing()})
        if path.endswith("/artifacts/raw"):
            calls.append(request.url.params["name"])
            return raw.serve(request.url.params["name"])
        return httpx.Response(404)

    rt = SwarmCloudRuntime(
        "https://swarm.test", StaticBearer("sc-bearer"), transport=httpx.MockTransport(handler)
    )
    return rt, calls


async def test_an_oversized_artifact_is_refused_without_being_read_in_full():
    import httpx

    from oracle.swarm import swarmcloud

    sent = {"bytes": 0}
    chunk = b"x" * 65536

    class Raw:
        def listing(self):
            return [{"name": "huge.md", "role": None}, {"name": "prd.md", "role": None}]

        def serve(self, name):
            if name == "prd.md":
                return httpx.Response(200, text="# PRD")

            async def body():  # 50 MB, no Content-Length
                for _ in range(800):
                    sent["bytes"] += len(chunk)
                    yield chunk

            return httpx.Response(200, content=body())

    rt, _ = _swarm(Raw())
    files = await rt.artifacts("wf_1")
    assert files == {"prd.md": "# PRD"}
    assert sent["bytes"] <= swarmcloud.MAX_ARTIFACT_BYTES + 2 * len(chunk)


async def test_an_artifact_announced_oversized_is_not_read():
    import httpx

    class Raw:
        def listing(self):
            return [{"name": "huge.md", "role": None}]

        def serve(self, name):
            return httpx.Response(
                200, content=b"x", headers={"Content-Length": str(50 * 1024 * 1024)}
            )

    rt, _ = _swarm(Raw())
    assert await rt.artifacts("wf_1") == {}


async def test_the_artifacts_read_per_pass_are_capped():
    import httpx

    from oracle.swarm import swarmcloud

    class Raw:
        def listing(self):
            return [{"name": f"note-{i}.md", "role": None} for i in range(1000)]

        def serve(self, name):
            return httpx.Response(200, text=name)

    rt, calls = _swarm(Raw())
    files = await rt.artifacts("wf_1")
    assert len(calls) == swarmcloud.MAX_ARTIFACT_FILES
    assert len(files) == swarmcloud.MAX_ARTIFACT_FILES


# --- MINORS --------------------------------------------------------------------------


async def _segment(ctx, run_id, seq) -> RunSegment:
    async with tenant_session(ctx.tenant_id) as s:
        return await s.scalar(
            select(RunSegment).where(
                RunSegment.run_id == uuid.UUID(str(run_id)), RunSegment.seq == seq
            )
        )


async def test_the_claim_keeps_the_reviewers_note_until_the_submission_succeeds(client, runtime):
    """Changes requested with a note; while SwarmCloud takes the re-run, the claimed
    segment still holds the note (a process that dies mid-call loses nothing)."""
    pass

    ctx = await setup(client)
    run = await _at_checkpoint(client, ctx)
    blocked = _Blocked(runtime, "submit")
    decided = asyncio.create_task(_decide(client, run, ctx.auth, "changes_requested", "Cite G1"))
    try:
        await asyncio.wait_for(blocked.entered.wait(), WAIT)
        seg = await _segment(ctx, run["id"], 1)
        assert seg.artifacts.get("claim")
        assert seg.artifacts.get("pending_note") == "Cite G1"
    finally:
        blocked.release.set()
    assert (await decided).status_code == 200
    seg = await _segment(ctx, run["id"], 1)
    assert "pending_note" not in seg.artifacts
    assert seg.artifacts["attempts"][-1]["note"] == "Cite G1"


async def test_a_cancel_records_its_runtime_follow_up_before_the_call(client, runtime):
    """The cancel's follow-up is in the cancel's own transaction: when the runtime is
    called it is already saved, so a crash in between leaves it for the tick."""
    from oracle.members.models import MemberFollowUp

    ctx = await setup(client)
    run = await _started(client, ctx)
    seen: list = []
    real = runtime.cancel

    async def spy(workflow_id):
        async with tenant_session(ctx.tenant_id) as s:
            seen.append(
                await s.scalar(
                    select(MemberFollowUp).where(MemberFollowUp.workflow_id == workflow_id)
                )
            )
        await real(workflow_id)

    runtime.cancel = spy
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=ctx.auth)
    assert resp.status_code == 200, resp.text
    assert len(seen) == 1 and seen[0] is not None and seen[0].kind == "run_cancel"
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(MemberFollowUp, seen[0].id)).status == "done"


async def test_a_workflow_started_for_a_changed_run_has_its_follow_up_before_the_call(
    client, runtime
):
    from oracle.members.models import MemberFollowUp

    ctx = await setup(client)
    run = await _run_estimated(client, ctx)
    blocked = _Blocked(runtime, "submit")
    seen: list = []
    real = runtime.cancel

    async def spy(workflow_id):
        async with tenant_session(ctx.tenant_id) as s:
            seen.append(
                await s.scalar(
                    select(MemberFollowUp).where(MemberFollowUp.workflow_id == workflow_id)
                )
            )
        await real(workflow_id)

    runtime.cancel = spy
    call = asyncio.create_task(client.post(f"/v1/runs/{run['id']}/start", headers=ctx.auth))
    try:
        await asyncio.wait_for(blocked.entered.wait(), WAIT)
        resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=ctx.auth)
        assert resp.status_code == 200, resp.text
    finally:
        blocked.release.set()
    assert (await call).status_code == 200
    assert len(seen) == 1 and seen[0] is not None


async def _run_estimated(client, ctx) -> dict:
    pass

    return await _run(client, ctx)


async def test_an_unexpected_submission_error_is_recorded_not_a_500(client, runtime):
    ctx = await setup(client)
    run = await _run_estimated(client, ctx)
    real = runtime.submit

    async def broken(spec):
        raise ValueError("unexpected answer")

    runtime.submit = broken
    resp = await client.post(f"/v1/runs/{run['id']}/start", headers=ctx.auth)
    assert resp.status_code == 200, resp.text
    seg = resp.json()["segments"][0]
    assert seg["status"] == "pending" and "ValueError" in seg["error"]
    assert "claim" not in (await _segment(ctx, run["id"], 1)).artifacts
    runtime.submit = real
    await _tick_security6(client, ctx)
    assert (await _read(client, ctx, run["id"]))["segments"][0]["status"] == "running"


async def test_a_cancel_follow_up_does_not_write_onto_a_segment_requeued_since(client, runtime):
    from datetime import UTC, datetime

    from oracle.members.models import MemberFollowUp
    from oracle.runs.service import QUEUED
    from oracle.swarm import RuntimeUnavailable

    pass

    ctx = await setup(client)
    run = await _at_checkpoint(client, ctx)
    seg = await _segment(ctx, run["id"], 2)
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(RunSegment, seg.id)
        row.error = QUEUED  # queued again since its earlier workflow was cancelled
        s.add(
            MemberFollowUp(
                member_id=uuid.UUID(run["created_by"]),
                kind="run_cancel",
                target_id=seg.id,
                workflow_id="fake-old-workflow",
                next_attempt_at=datetime.now(UTC),
            )
        )
        await s.commit()

    async def down(workflow_id):
        raise RuntimeUnavailable("SwarmCloud is down")

    runtime.cancel = down
    await _tick_security6(client, ctx)
    assert (await _segment(ctx, run["id"], 2)).error == QUEUED


async def test_the_tick_refuses_a_viewer_api_token(client, runtime):
    from oracle.auth.service import create_api_token

    ctx = await setup(client)
    async with tenant_session(ctx.tenant_id) as s:
        token, raw = await create_api_token(s, "read-only")
        token.role = "viewer"
        await s.commit()
    resp = await client.post("/v1/internal/tick", headers={"Authorization": f"Bearer {raw}"})
    assert resp.status_code == 403, resp.text
    await _tick_security6(client, ctx)  # an owner's token still runs it


SPELLINGS = [
    "{u}",
    "{h}",
    "urn:uuid:{U}",
    " {{{u}}}\t",
    "UUID:{h}",
    "0x{h30}",  # uuid.UUID reads it (int(..., 16)); the SQL never did
    "{h_}",  # an underscore: the same
    "{u}}}{{",  # braces inside
    " {u}",  # a non-ASCII space
    "{h31}",
    "not-a-uuid",
]


@pytest.mark.parametrize("spelling", SPELLINGS)
async def test_external_key_and_the_sql_read_exactly_the_same_spellings(client, spelling):
    from sqlalchemy import literal

    from oracle.review.publish import _as_uuid, _hex32, external_key

    ctx = await setup(client)
    u = uuid.UUID("12345678-9abc-def0-1234-56789abcdef0")
    value = spelling.format(
        u=u, U=str(u).upper(), h=u.hex, h30=u.hex[:30], h_=u.hex[:16] + "_" + u.hex[17:],
        h31=u.hex[:31],
    )  # fmt: skip
    parsed = _as_uuid(value)
    async with tenant_session(ctx.tenant_id) as s:
        in_sql = await s.scalar(select(_hex32(literal(value))))
    assert (parsed.hex if parsed else None) == in_sql
    assert (external_key(value) == str(parsed)) if parsed else (external_key(value) != str(u))


# -----------------------------------------------------------------------------
# PR #128, security review round 7: nothing is held across a SwarmCloud call (the review
# gate, a run's row lock), an Inbox decision is recorded under the gate and posted after it,
# and every approver/owner write under /v1/runs re-checks the caller under the gate (CR-06).
# Synthetic placeholders only.


@pytest.fixture
async def owner():
    return await seed_auth()


# --- nothing is held across a runtime call ---------------------------------------------


class Probe:
    """A runtime that checks, before each call it forwards, that nothing is held across
    it: no row lock on any run, and not the review gate (both tried from another
    connection)."""

    def __init__(self, inner, tenant_id) -> None:
        self.inner, self.tenant_id, self.held = inner, tenant_id, []

    def __getattr__(self, name):
        attr = getattr(self.inner, name)
        if not inspect.iscoroutinefunction(attr):
            return attr

        async def call(*args, **kwargs):
            await self.check(name)
            return await attr(*args, **kwargs)

        return call

    async def check(self, name: str) -> None:
        key = f"oracle-review-gate:{self.tenant_id}"
        async with tenant_session(self.tenant_id) as s:
            free = await s.scalar(
                text("SELECT pg_try_advisory_xact_lock(hashtextextended(:k, 0))"), {"k": key}
            )
            if not free:
                self.held.append(f"{name}: the review gate")
            await s.rollback()
        async with tenant_session(self.tenant_id) as s:
            try:
                await s.execute(select(Run.id).with_for_update(nowait=True))
            except DBAPIError:
                self.held.append(f"{name}: a run's row lock")
            await s.rollback()


def probed(swarm, tenant_id) -> Probe:
    probe = Probe(swarm.runtime(), tenant_id)
    set_runtime(probe)
    return probe


@pytest.mark.usefixtures("adapter_v2_env")  # test_adapter_v2's environment
async def test_start_tick_and_decision_hold_nothing_across_swarmcloud(client, owner):
    """Start (features, MCP registration, submit), the tick's reads (status, artifacts,
    a wait) and an Inbox decision's answer post: none with the gate or a run's row
    lock held."""
    tenant_id, auth = owner
    swarm = on()
    probe = probed(swarm, tenant_id)
    await feedback_doc(client, auth, tenant_id)
    run = await started(client, auth, flow="feedback_loop", document="checkout-redesign")
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    await tick(client, auth)  # reads the open wait
    run = await decide(client, auth, run, "changes_requested", note="Tighten the scope")
    assert len(swarm.answers) == 1
    await tick(client, auth)
    assert probe.held == []


@pytest.mark.usefixtures("adapter_v2_env")  # test_adapter_v2's environment
async def test_a_late_decision_cancels_and_submits_with_nothing_held(client, owner, monkeypatch):
    """Under the tail the decision cancels the waiting workflow and continues as a new
    one: the cancel and the submit are made outside the gate and the row lock."""
    tenant_id, auth = owner
    swarm = on()
    probe = probed(swarm, tenant_id)
    await feedback_doc(client, auth, tenant_id)
    run = await started(client, auth, flow="feedback_loop", document="checkout-redesign")
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    real_now = service._now
    monkeypatch.setattr(service, "_now", lambda: real_now() + timedelta(hours=23))
    run = await decide(client, auth, run, "changes_requested", note="Still too broad")
    assert swarm.workflows["wf_1"].state == "CANCELLED" and len(swarm.submissions()) == 2
    assert run["status"] == "running"
    assert probe.held == []


@pytest.mark.usefixtures("adapter_v2_env")  # test_adapter_v2's environment
async def test_a_retried_lost_submission_is_queued_and_nothing_is_held(client, owner, monkeypatch):
    tenant_id, auth = owner
    swarm = on()
    probe = probed(swarm, tenant_id)
    swarm.other_tasks = 1100  # the lost submission is behind newer tasks
    swarm.lose_next_submit = True
    run = await started(client, auth)
    real_now = service._now
    monkeypatch.setattr(
        service, "_now", lambda: real_now() + timedelta(seconds=service.LOST_LOOKUP_SECONDS + 60)
    )
    await tick(client, auth)
    resp = await client.post(f"/v1/runs/{run['id']}/retry", headers=auth)
    assert resp.status_code == 200, resp.text
    assert resp.json()["segments"][0]["workflow_id"] == "wf_2"
    await tick(client, auth)  # looks for the abandoned one
    assert probe.held == []


@pytest.mark.usefixtures("adapter_v2_env")  # test_adapter_v2's environment
async def test_an_unconfirmed_cancel_is_retried_by_the_tick_with_nothing_held(client, owner):
    tenant_id, auth = owner
    swarm = on()
    probe = probed(swarm, tenant_id)
    run = await started(client, auth)
    swarm.fail_cancels = 1
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    await tick(client, auth)
    await tick(client, auth)
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    assert probe.held == []


# --- an Inbox decision is recorded first; a failed post is the tick's ------------------

_UNAVAILABLE = {"code": "unavailable", "message": "try later", "detail": {"reason": "unavailable"}}


@pytest.mark.usefixtures("adapter_v2_env")  # test_adapter_v2's environment
async def test_a_refused_post_leaves_the_decision_recorded_for_the_tick(client, owner):
    tenant_id, auth = owner
    swarm = on()
    run = await _waiting(client, auth, tenant_id, swarm)
    swarm.fail_next_answer = httpx.Response(503, json=_UNAVAILABLE)
    resp = await _decide_raw(client, auth, run, "changes_requested", "Cover returns")
    assert resp.status_code == 503 and "recorded" in resp.text, resp.text
    run = await get(client, auth, run["id"])
    # Recorded: nothing left to decide again, nothing posted yet.
    assert [c["status"] for c in run["checkpoints"]] == ["changes_requested"]
    assert swarm.answers == [] and run["status"] == "awaiting_checkpoint"
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert len(swarm.answers) == 1 and len(swarm.submissions()) == 1
    # Delivered; the same tick's pass follows the workflow on (into round 2's wait).
    assert run["checkpoints"][0]["status"] == "changes_requested"
    assert "posting" not in run["checkpoints"][0]["payload"]["wait"]
    await tick(client, auth)
    assert len(swarm.answers) == 1  # never answered twice


@pytest.mark.usefixtures("adapter_v2_env")  # test_adapter_v2's environment
async def test_the_tick_keeps_what_a_runs_searches_counted(client, owner):
    """PR #128 minor: a run's searches pause it on its ceiling (a pause the tick counts);
    the run's own pass then calls SwarmCloud and runs again (_replay): the pause the
    searches counted stays counted."""
    tenant_id, auth = owner
    swarm = on()
    set_runtime(swarm.runtime())
    run = await started(client, auth)
    async with tenant_session(tenant_id) as s:
        row = await s.get(Run, uuid.UUID(run["id"]))
        entry = {"id": "wf_1", "seq": 1, "label": "oracle-r-baseline-1", "cancel": False}
        row.knobs = {**row.knobs, "spend_ceiling_usd": "0.01", "searches": [entry]}
        await s.commit()
    swarm.workflows["wf_1"].steps[0].cost += 1.0
    resp = await client.post("/v1/internal/tick", headers=auth)
    assert resp.status_code == 200, resp.text
    assert (await get(client, auth, run["id"]))["status"] == "paused_overrun"
    assert resp.json()["runs_paused"] == 1, resp.json()


@pytest.mark.usefixtures("adapter_v2_env")  # test_adapter_v2's environment
async def test_a_lost_answer_is_replayed_by_the_tick_never_doubled(client, owner):
    tenant_id, auth = owner
    swarm = on()
    run = await _waiting(client, auth, tenant_id, swarm)
    swarm.lose_next_answer = True  # recorded by SwarmCloud, the response lost
    resp = await _decide_raw(client, auth, run, "changes_requested", "Add a guardrail metric")
    assert resp.status_code == 503 and "recorded" in resp.text, resp.text
    assert len(swarm.answers) == 1
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert len(swarm.answers) == 1 and len(swarm.submissions()) == 1
    assert run["checkpoints"][0]["status"] == "changes_requested"
    assert "posting" not in run["checkpoints"][0]["payload"]["wait"]


# --- CR-06: every approver/owner write under /v1/runs re-checks the caller -------------

# Every write route under /v1/runs and the role it needs. A new route must be listed here,
# and so is walked by the test below: a caller who loses standing between authenticating
# and writing is refused under the gate.
WRITE_ROUTES = {
    ("post", "/v1/runs"): "approver",
    ("patch", "/v1/runs/{run_id}"): "approver",
    ("post", "/v1/runs/{run_id}/estimate"): "approver",
    ("post", "/v1/runs/{run_id}/start"): "approver",
    ("post", "/v1/runs/{run_id}/approve"): "owner",
    ("post", "/v1/runs/{run_id}/resume"): "owner",
    ("post", "/v1/runs/{run_id}/retry"): "approver",
    ("post", "/v1/runs/{run_id}/cancel"): "approver",
    ("post", "/v1/runs/{run_id}/stop-cancelling"): "approver",
    ("post", "/v1/runs/{run_id}/retry-lookup"): "approver",
    ("post", "/v1/runs/{run_id}/retry-import"): "owner",
    ("post", "/v1/runs/{run_id}/segments/{seq}/retry"): "approver",
    ("post", "/v1/runs/{run_id}/segments/{seq}/retry-draft-import"): "approver",
    ("post", "/v1/runs/{run_id}/cancel-again"): "approver",
    ("post", "/v1/runs/{run_id}/dismiss-overrun"): "approver",
    ("post", "/v1/runs/{run_id}/checkpoints/{checkpoint_id}/decide"): "approver",
    # D8: the checkpoint's shared draft (commenters suggest, the approver role stages).
    ("post", "/v1/runs/{run_id}/checkpoints/{checkpoint_id}/actions"): "commenter",
    ("post", "/v1/runs/{run_id}/checkpoints/{checkpoint_id}/actions/{action_id}/stage"): "approver",
    ("delete", "/v1/runs/{run_id}/checkpoints/{checkpoint_id}/actions/{action_id}"): "commenter",
    ("put", "/v1/runs/{run_id}/checkpoints/{checkpoint_id}/note"): "approver",
    # AQ1: answering an agent's question at the stop (the same gate as the note).
    (
        "put",
        "/v1/runs/{run_id}/checkpoints/{checkpoint_id}/agent-questions/{question_id}/answer",
    ): "approver",
    # Trash (#482): only an owner deletes a run or restores it.
    ("delete", "/v1/runs/{run_id}"): "owner",
    ("post", "/v1/runs/{run_id}/restore"): "owner",
}


@pytest.mark.usefixtures("adapter_v2_env")  # test_adapter_v2's environment
def test_every_run_write_route_is_walked():
    found = {
        (method, path)
        for path, item in app.openapi()["paths"].items()
        if path.startswith("/v1/runs")
        for method in item
        if method in ("post", "put", "patch", "delete")
    }
    assert found == set(WRITE_ROUTES), (
        "a write route under /v1/runs is not in WRITE_ROUTES (or one was removed): add it, "
        "and make it re-check the caller under the gate (CR-06)"
    )


def _viewer_on_first_gate(monkeypatch, ctx, user_id) -> list[bool]:
    """As _lose_on_first_gate for a commenter's route (D8 draft writes): one step down from
    commenter is viewer, made while the request waits on the gate."""
    from oracle.auth.models import User

    real = publish.gate_lock
    fired: list[bool] = []

    async def spy(db, *, shared):
        if not fired:
            fired.append(True)
            async with tenant_session(ctx.tenant_id) as s:
                (await s.get(User, user_id)).role = "viewer"
                await s.commit()
        await real(db, shared=shared)

    monkeypatch.setattr(publish, "gate_lock", spy)
    return fired


@pytest.mark.parametrize("route", sorted(WRITE_ROUTES), ids=lambda r: f"{r[0]} {r[1]}")
@pytest.mark.parametrize("how", ["demoted", "disabled"])
@pytest.mark.usefixtures("adapter_v2_env")  # test_adapter_v2's environment
async def test_a_caller_who_lost_standing_before_the_write_is_refused(
    client, monkeypatch, runtime, route, how
):
    method, template = route
    role = WRITE_ROUTES[route]
    ctx = await setup(client)
    caller = await person(ctx.tenant_id, role, "caller")
    body = None
    if "{checkpoint_id}" in template or "retry-draft-import" in template:
        run = await _at_checkpoint(client, ctx)
        checkpoint_id = next(c["id"] for c in run["checkpoints"] if c["status"] == "pending")
    elif template == "/v1/runs":
        run, checkpoint_id = {"id": "unused"}, "unused"
        body = {"flow": "baseline_to_prd", "document": DOC, "knobs": {}}
    else:
        run, checkpoint_id = await _run(client, ctx), "unused"
    if template.endswith("/decide"):
        body = {"decision": "approved", "note": None}
    elif template.endswith("/actions"):
        body = {"item_key": "*", "kind": "accept"}
    elif template.endswith("/note"):
        body = {"note": "Caps first"}
    elif template.endswith("/answer"):
        body = {"option": "a", "note": None}
    elif template.endswith("/stage"):
        body = {}
    elif template.endswith("/cancel-again"):
        body = {"workflow_id": "wf_unused"}
    elif method == "patch":
        body = {"knobs": {}}
    # An action that does not exist: the caller is refused before it is looked up.
    path = template.format(
        run_id=run["id"],
        seq=1,
        checkpoint_id=checkpoint_id,
        action_id=uuid.uuid4(),
        question_id="q1",
    )
    if role == "commenter" and how == "demoted":
        fired = _viewer_on_first_gate(monkeypatch, ctx, caller.user_id)
    else:
        fired = _lose_on_first_gate(monkeypatch, ctx, how, caller.user_id)
    resp = await client.request(method.upper(), path, json=body, headers=caller.headers)
    assert fired, f"{method.upper()} {template} did not take the gate"
    assert resp.status_code == 403, resp.text


@pytest.mark.parametrize("how", ["demoted", "disabled"])
@pytest.mark.usefixtures("adapter_v2_env")  # test_adapter_v2's environment
async def test_cancel_re_checks_the_caller_after_its_runtime_calls(
    client, monkeypatch, runtime, how
):
    """Cancel releases the gate its dependency took while it calls the runtime; the write
    that follows takes it again and re-reads the caller. Here the caller loses standing
    between the two."""
    ctx = await setup(client)
    author = await person(ctx.tenant_id, "approver", "author")
    run = await _started(client, ctx, author.headers)

    real = publish.gate_lock
    takes: list[bool] = []

    async def spy(db, *, shared):
        takes.append(True)
        if len(takes) == 2:
            await _lose(ctx, how, author.user_id)
        await real(db, shared=shared)

    monkeypatch.setattr(publish, "gate_lock", spy)
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=author.headers)
    assert len(takes) >= 2, "the write after the runtime calls did not take the gate again"
    assert resp.status_code == 403, resp.text
    assert (await _read(client, ctx, run["id"]))["status"] == "running"


# --- CR-06 after a runtime call: standing lost WHILE SwarmCloud answers ----------------
#
# A write route that calls SwarmCloud while it handles the request does so with the gate
# released (nothing is held across a call), so the caller may lose standing during the
# call. One that writes on what the call returned takes the gate again and re-reads the
# caller before it writes: 403, nothing written (DURING, with the call to lose standing
# in). An Inbox decision is recorded before its post: the post's follow-through re-reads
# the decider, and one who lost standing has the decision voided (403), its answer never
# followed on its own. One whose only call submits what its write queued, after the write
# committed, needs no re-read: the write was the caller's while they had standing, and a
# disable cancels or voids what it started (oracle.members.service.disable_member;
# AFTER_COMMIT). Every other write route makes no runtime call (NO_CALL). A new route must
# be put in one.
DECIDE = ("post", "/v1/runs/{run_id}/checkpoints/{checkpoint_id}/decide")
DURING = {
    ("post", "/v1/runs/{run_id}/retry"): "find_by_label",
    ("post", "/v1/runs/{run_id}/retry-lookup"): "status",
    ("post", "/v1/runs/{run_id}/cancel"): "cancel",
    DECIDE: "answer",
}
AFTER_COMMIT = {
    ("post", "/v1/runs/{run_id}/start"),
    ("post", "/v1/runs/{run_id}/approve"),
    ("post", "/v1/runs/{run_id}/resume"),
    ("post", "/v1/runs/{run_id}/segments/{seq}/retry"),
}
NO_CALL = {
    ("post", "/v1/runs"),
    ("patch", "/v1/runs/{run_id}"),
    ("post", "/v1/runs/{run_id}/estimate"),
    ("post", "/v1/runs/{run_id}/stop-cancelling"),
    ("post", "/v1/runs/{run_id}/retry-import"),
    ("post", "/v1/runs/{run_id}/segments/{seq}/retry-draft-import"),
    ("post", "/v1/runs/{run_id}/cancel-again"),
    ("post", "/v1/runs/{run_id}/dismiss-overrun"),
    ("post", "/v1/runs/{run_id}/checkpoints/{checkpoint_id}/actions"),
    ("post", "/v1/runs/{run_id}/checkpoints/{checkpoint_id}/actions/{action_id}/stage"),
    ("delete", "/v1/runs/{run_id}/checkpoints/{checkpoint_id}/actions/{action_id}"),
    ("put", "/v1/runs/{run_id}/checkpoints/{checkpoint_id}/note"),
    ("put", "/v1/runs/{run_id}/checkpoints/{checkpoint_id}/agent-questions/{question_id}/answer"),
    ("delete", "/v1/runs/{run_id}"),
    ("post", "/v1/runs/{run_id}/restore"),
}


@pytest.mark.usefixtures("adapter_v2_env")  # test_adapter_v2's environment
def test_every_run_write_route_says_whether_it_calls_swarmcloud():
    kinds = [set(DURING), AFTER_COMMIT, NO_CALL]
    assert sum(len(k) for k in kinds) == len(set().union(*kinds)), "a route is in two lists"
    assert set().union(*kinds) == set(WRITE_ROUTES), (
        "a write route under /v1/runs is not in DURING, AFTER_COMMIT or NO_CALL: say whether "
        "it calls SwarmCloud, and if it writes on what the call returned, re-check the caller "
        "under the gate after the call (CR-06)"
    )


class LoseDuring:
    """The runtime, except that its first call to the armed method makes the caller lose
    standing (a disable or a demotion committed while SwarmCloud answers) before it is
    forwarded."""

    def __init__(self, inner, tenant_id) -> None:
        self.inner, self.tenant_id = inner, tenant_id
        self.armed: tuple | None = None
        self.fired: list[str] = []

    def arm(self, method: str, how: str, user_id) -> None:
        self.armed = (method, how, user_id)

    def __getattr__(self, name):
        attr = getattr(self.inner, name)
        if not inspect.iscoroutinefunction(attr):
            return attr

        async def call(*args, **kwargs):
            if self.armed is not None and self.armed[0] == name:
                _, how, user_id = self.armed
                self.armed = None
                await _lose(SimpleNamespace(tenant_id=self.tenant_id), how, user_id)
                self.fired.append(name)
            return await attr(*args, **kwargs)

        return call


async def _knobs(tenant_id, run_id) -> dict:
    async with tenant_session(tenant_id) as s:
        return dict((await s.get(Run, uuid.UUID(run_id))).knobs or {})


async def _audits(tenant_id, action: str) -> int:
    async with tenant_session(tenant_id) as s:
        return len(list(await s.scalars(select(AuditEvent).where(AuditEvent.action == action))))


async def _stuck_lookup(client, auth, headers, swarm, tenant_id, monkeypatch) -> dict:
    """A run whose lost submission is past the lookup cap (Inbox: Retry)."""
    swarm.other_tasks = 1100  # the lost submission is behind newer tasks
    swarm.lose_next_submit = True
    run = await started(client, headers)
    real_now = service._now
    monkeypatch.setattr(
        service, "_now", lambda: real_now() + timedelta(seconds=service.LOST_LOOKUP_SECONDS + 60)
    )
    await tick(client, auth)
    assert (await _knobs(tenant_id, run["id"])).get("stuck_lookup")
    return run


async def _cost_unknown(client, headers, tenant_id) -> dict:
    """A run with a searched workflow whose cost is unknown (Inbox: Retry lookup), one
    Oracle no longer cancels: Retry lookup reads its status."""
    run = await started(client, headers)
    async with tenant_session(tenant_id) as s:
        row = await s.get(Run, uuid.UUID(run["id"]))
        entry = {"id": "wf_1", "seq": 1, "label": "oracle-r-baseline-1", "cost_unknown": True}
        row.knobs = {**(row.knobs or {}), "searches": [{**entry, "cancel": False}]}
        await s.commit()
    return run


@pytest.mark.parametrize("route", sorted(DURING), ids=lambda r: f"{r[0]} {r[1]}")
@pytest.mark.parametrize("how", ["demoted", "disabled"])
@pytest.mark.parametrize("who", ["creator", "owner"])
@pytest.mark.usefixtures("adapter_v2_env")  # test_adapter_v2's environment
async def test_a_caller_who_lost_standing_during_the_runtime_call_is_refused(
    client, monkeypatch, route, how, who
):
    """``creator``: the approver who created the run; ``owner``: an owner who did not.
    Either loses standing while SwarmCloud answers the route's call: 403, and what the
    route writes after the call is not written."""
    method, template = route
    tenant_id, auth = await seed_auth()
    swarm = on()
    lose = LoseDuring(swarm.runtime(), tenant_id)
    set_runtime(lose)
    author = await person(tenant_id, "approver", "author")
    caller = author if who == "creator" else await person(tenant_id, "owner", "owner")
    creator = author.headers if who == "creator" else auth
    body, checkpoint_id = None, "unused"
    if template.endswith("/retry"):
        run = await _stuck_lookup(client, auth, creator, swarm, tenant_id, monkeypatch)
    elif template.endswith("/retry-lookup"):
        run = await _cost_unknown(client, creator, tenant_id)
    elif route == DECIDE:
        await feedback_doc(client, auth, tenant_id)
        run = await started(client, creator, flow="feedback_loop", document="checkout-redesign")
        await tick(client, auth)
        run = await get(client, auth, run["id"])
        assert run["status"] == "awaiting_checkpoint"
        checkpoint_id = next(c["id"] for c in run["checkpoints"] if c["status"] == "pending")
        body = {"decision": "approved", "note": None}
    else:
        run = await started(client, creator)
    before = await _knobs(tenant_id, run["id"])
    submitted = len(swarm.submissions())
    lose.arm(DURING[route], how, caller.user_id)
    path = template.format(run_id=run["id"], checkpoint_id=checkpoint_id)
    resp = await client.request(method.upper(), path, json=body, headers=caller.headers)
    assert lose.fired == [DURING[route]], f"{template} did not call {DURING[route]}"
    if route == DECIDE:
        await _decision_during_the_post(client, auth, tenant_id, swarm, run, resp, how, who)
        return
    assert resp.status_code == 403, resp.text
    assert (await get(client, auth, run["id"]))["status"] == "running"
    assert len(swarm.submissions()) == submitted
    knobs = await _knobs(tenant_id, run["id"])
    if template.endswith("/retry"):
        assert knobs.get("stuck_lookup") == before["stuck_lookup"]
        assert await _audits(tenant_id, "run.retried") == 0
    elif template.endswith("/retry-lookup"):
        assert knobs["searches"] == before["searches"]
        assert await _audits(tenant_id, "run.lookup_retried") == 0
    else:
        assert await _audits(tenant_id, "run.cancelled") == 0


async def _decision_during_the_post(client, auth, tenant_id, swarm, run, resp, how, who):
    """The decider lost standing while SwarmCloud took Oracle's post (it landed): the
    decision is voided (403), the checkpoint waits for an approver again, nothing more is
    submitted, and the tick never follows the posted answer on its own: it waits in the
    Inbox for an approver to confirm it. An owner demoted to approver still holds the
    checkpoint's role: the decision stands."""
    assert len(swarm.answers) == 1  # the post landed while the caller lost standing
    if who == "owner" and how == "demoted":
        assert resp.status_code == 200, resp.text
        assert [c["status"] for c in resp.json()["checkpoints"]][:1] == ["approved"]
        return
    assert resp.status_code == 403, resp.text
    after = await get(client, auth, run["id"])
    assert after["status"] == "awaiting_checkpoint"
    cp = next(c for c in after["checkpoints"] if c["status"] == "pending")
    assert cp["decided_by"] is None
    assert await _audits(tenant_id, "checkpoint.decision_voided") == 1
    submitted = len(swarm.submissions())
    await tick(client, auth)
    after = await get(client, auth, run["id"])
    assert after["status"] == "awaiting_checkpoint"
    cp = next(c for c in after["checkpoints"] if c["id"] == cp["id"])
    assert cp["status"] == "pending" and cp["console"]["needs"] == "confirm", cp
    assert len(swarm.submissions()) == submitted and len(swarm.answers) == 1
