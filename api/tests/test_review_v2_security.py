"""CR-06 security review fixes (PR #16): the publish gate sees real source
revocations (M1), a section edit stays inside its section (M2), AI text never replaces
approved text without a patch (M3), a section's revision covers its evidence (M4), and
the minors (publish lock, latest version only, re-approval, required sections fail
closed, base versions, immutable deletes, the decider behind an API token).

Synthetic placeholders only."""

import asyncio
import json
import uuid

import httpx
import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError

from oracle import readiness
from oracle.auth.deps import Principal
from oracle.auth.service import create_api_token
from oracle.baseline.models import Entity, Evidence
from oracle.docs import service as docs_service
from oracle.docs.models import Document
from oracle.models import Tenant
from oracle.review.models import DocumentPublication, FeedbackItem, SectionPatch
from oracle.sources.models import Source, SourceItem
from oracle.tenancy import tenant_session, unscoped_session
from oracle.v2.models import ChangeEvent, DocumentSectionLink
from tests.connection_helpers import add_connection, clear_provider_http, use_provider_http
from tests.legacy.helpers import run_cli
from tests.review_v2_helpers import (  # noqa: F401 (local_runtime: a fixture)
    DOC,
    DRAFT,
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
        assert "base_version" in tools["push_draft"].input_schema["required"]
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
    assert resp.status_code == 401


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
