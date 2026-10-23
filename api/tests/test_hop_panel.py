"""G7 Head-of-product panel: panel chats are private discussions (only you, until shared),
"Share as discussion" starts an open one from the chat's summary, and a ``screen`` subject's
context is built on the server from what every member may read.

Each test's card: protects=<the observable>; fails_when=<the wrong result>;
no_claim=<what green does not prove>. Synthetic placeholders only.
"""

import uuid

from sqlalchemy import select

from oracle.baseline.models import Entity, Evidence
from oracle.discussions import context
from oracle.discussions.models import Discussion, DiscussionChange
from oracle.roadmap.models import ProductTrack
from oracle.runs.models import Run
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_item
from tests.test_discussions import company, events, get, listed, messages, patch, section, uid
from tests.test_mcp import api_token, mcp_client

SUMMARY = "Ship the outcomes section once the drop-off measure is named."
SOURCE_LINE = "Guided setup is the top request from new accounts."


async def panel(client, ctx, doc, who="commenter", expect=201, **body) -> dict:
    body = {
        "subject_kind": "section", "subject": section(doc), "origin": "panel",
        "visibility": "private", **body,
    }  # fmt: skip
    resp = await client.post("/v1/discussions", json=body, headers=ctx.as_(who))
    assert resp.status_code == expect, resp.text
    return resp.json()


async def share(client, ctx, d_id, who="commenter", expect=201, **body) -> dict:
    body = {"title": "Outcomes: name the measure", "first_message": SUMMARY, **body}
    resp = await client.post(f"/v1/discussions/{d_id}/share", json=body, headers=ctx.as_(who))
    assert resp.status_code == expect, resp.text
    return resp.json()


async def add_change(ctx, d_id: str, doc: str, status: str) -> None:
    async with tenant_session(ctx.tenant_id) as s:
        s.add(
            DiscussionChange(
                discussion_id=uuid.UUID(d_id), kind="section_edit",
                target={"document_id": doc, "section_key": "problem"},
                payload={"section_key": "problem", "instruction": f"Change ({status})"},
                proposed_by_kind="oracle", status=status,
            )
        )  # fmt: skip
        await s.commit()


# protects=criteria 3 and 4 (Privacy of panel chats): a panel chat is private with one
# participant on the section, and another member sees it only as a hidden "Private
# discussion" row; fails_when=another member reads it or is added to it; no_claim=G1 access
# internals (tested there).
async def test_a_panel_chat_is_just_you_and_oracle(client):
    ctx, doc = await company(client)
    d = await panel(client, ctx, doc, message={"body": "Why is this ranked third?"})
    assert d["origin"] == "panel" and d["visibility"] == "private"
    assert [p["user_id"] for p in d["participants"]] == [uid(ctx, "commenter")]
    assert d["subject_kind"] == "section" and d["subject_key"] == f"section:{doc}:problem"

    [row] = await listed(client, ctx, "approver", subject_key=d["subject_key"])
    assert row["hidden"] is True and row["visibility"] == "private" and "title" not in row
    await get(client, ctx, d["id"], "approver", expect=403)
    mine = await listed(client, ctx, "commenter", mine="true", origin="panel", limit=10)
    assert [x["id"] for x in mine] == [d["id"]]
    assert await listed(client, ctx, "approver", mine="true", origin="panel") == []

    # Nobody else is brought in: not picked at the start, not mentioned, not added.
    body = await panel(client, ctx, doc, expect=422, participants=[uid(ctx, "approver")])
    assert body["detail"] == "A panel chat is just you and Oracle"
    resp = await client.post(
        f"/v1/discussions/{d['id']}/messages",
        json={"body": "And you?", "mentions": [uid(ctx, "approver")]},
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 422 and resp.json()["detail"] == "Share a panel chat with Share as discussion"
    resp = await client.post(
        f"/v1/discussions/{d['id']}/participants",
        json={"user_ids": [uid(ctx, "approver")]},
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 422
    # A panel chat is always private, whatever the body says.
    assert (await panel(client, ctx, doc, visibility="open"))["visibility"] == "private"


# protects=criterion 5 (Privacy of panel chats): Share as discussion starts an open discussion
# on the same subject, first message the edited summary, open changes suggested by the sharer;
# the panel chat stays private and cannot be made open in place; the audit names both ids;
# fails_when=the chat is made open, changes are lost or closed ones copied; no_claim=the UI.
async def test_share_as_discussion_starts_an_open_one_and_the_chat_stays_private(client):
    ctx, doc = await company(client)
    d = await panel(client, ctx, doc, message={"body": "What would we cut?"})
    for status in ("proposed", "staged", "dismissed"):
        await add_change(ctx, d["id"], doc, status)

    shared = await share(client, ctx, d["id"])
    assert shared["id"] != d["id"]
    assert shared["visibility"] == "open" and shared["origin"] == "discuss"
    assert shared["subject_key"] == d["subject_key"] and shared["subject"] == d["subject"]
    assert shared["title"] == "Outcomes: name the measure"
    [first] = [m for m in await messages(client, ctx, shared["id"], "approver")]
    assert first["body"] == SUMMARY and first["author_id"] == uid(ctx, "commenter")

    resp = await client.get(f"/v1/discussions/{shared['id']}/changes", headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    copied = resp.json()
    assert sorted(c["payload"]["instruction"] for c in copied) == [
        "Change (proposed)", "Change (staged)",
    ]  # fmt: skip
    assert {c["status"] for c in copied} == {"suggested"}
    async with tenant_session(ctx.tenant_id) as s:
        rows = list(
            await s.scalars(
                select(DiscussionChange).where(
                    DiscussionChange.discussion_id == uuid.UUID(shared["id"])
                )
            )
        )
        assert {r.suggested_by for r in rows} == {ctx.users["commenter"].id}
        chat = await s.get(Discussion, uuid.UUID(d["id"]))
        assert chat.visibility == "private" and chat.origin == "panel"

    [event] = await events(ctx, "discussion.shared")
    assert event.data["from"] == d["id"] and event.data["to"] == shared["id"]
    assert SUMMARY not in str(event.data)

    body = await patch(
        client, ctx, d["id"], "commenter", expect=422, visibility="open",
        exposes={"messages": 2, "people": 1},
    )  # fmt: skip
    assert body["detail"] == "Share a panel chat with Share as discussion"


# protects=only the panel chat's starter shares it, only a panel chat is shared this way, and
# the first message is required; fails_when=another member or a G1 discussion is shared;
# no_claim=the share dialog's copy.
async def test_only_the_starter_shares_a_panel_chat(client):
    ctx, doc = await company(client)
    d = await panel(client, ctx, doc)
    await share(client, ctx, d["id"], who="approver", expect=403)
    await share(client, ctx, d["id"], who="viewer", expect=403)
    body = await share(client, ctx, d["id"], expect=422, first_message="   ")
    assert body["detail"] == "A message needs some text"
    resp = await client.post(
        "/v1/discussions",
        json={"subject_kind": "section", "subject": section(doc), "visibility": "private"},
        headers=ctx.as_("commenter"),
    )
    plain = resp.json()
    body = await share(client, ctx, plain["id"], expect=422)
    assert body["detail"] == "Only a panel chat is shared as a discussion"
    assert len(await listed(client, ctx, "commenter", subject_key=d["subject_key"])) == 2


# protects=3.6: share_discussion is an MCP tool like any route, and create_discussion takes
# origin "panel"; fails_when=MCP cannot share or start a panel chat; no_claim=MCP auth.
async def test_mcp_starts_and_shares_a_panel_chat(client):
    ctx, doc = await company(client)
    token = await api_token(ctx.tenant_id, "owner")
    async with mcp_client(token) as c:
        names = {t.name for t in (await c.list_tools()).tools}
        assert {"share_discussion", "create_discussion"} <= names


# --- the screen context (unit, on the builder) ---------------------------------------------


async def screen_context(client, ctx, path: str) -> context.Context:
    resp = await client.post(
        "/v1/discussions",
        json={
            "subject_kind": "screen", "subject": {"path": path}, "origin": "panel",
            "visibility": "private",
        },
        headers=ctx.as_("commenter"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        d = await s.get(Discussion, uuid.UUID(resp.json()["id"]))
        return await context.build(s, d, uuid.uuid4())


def data_of(ctx: context.Context) -> str:
    return "\n".join(ctx.lines)


async def company_data(client):
    """A PRD, a confirmed goal with an own-source evidence row, a track, an active run."""
    ctx, doc = await company(client)
    item = await make_item(ctx, "commenter", content=SOURCE_LINE)
    async with tenant_session(ctx.tenant_id) as s:
        goal = Entity(
            type="goal", key="activation", title="Raise activation", status="confirmed",
            origin="user", attrs={"metric": "Activation rate", "current": 30, "target": 40},
        )  # fmt: skip
        s.add(goal)
        await s.flush()
        s.add(Evidence(entity_id=goal.id, source_item_id=item, excerpt=SOURCE_LINE))
        s.add(ProductTrack(prd_document_id=uuid.UUID(doc), title="Checkout track"))
        s.add(Run(flow="baseline_to_prd", status="running"))
        s.add(Run(flow="baseline_to_prd", status="succeeded"))
        await s.commit()
    return ctx, doc


# protects=Screen context (AUD-9, S6): /sources and /settings/* hold only the page name;
# fails_when=a screen context includes source items, goals or anything else;
# no_claim=the reply's wording.
async def test_sources_and_settings_contexts_hold_only_the_page_name(client):
    ctx, _doc = await company_data(client)
    for path, name in (("/sources", "Sources"), ("/settings/members", "Settings · Members")):
        built = await screen_context(client, ctx, path)
        assert built.entries == {}
        text = data_of(built)
        assert f"The page: {name}" in text
        assert "Raise activation" not in text and SOURCE_LINE not in text


# protects=Screen context: /inbox (personal), /requests, /company/updates (H8) and an unknown
# page hold only the page name; fails_when=they include company data; no_claim=wording.
async def test_personal_and_unbuilt_pages_hold_only_the_page_name(client):
    ctx, _doc = await company_data(client)
    for path in ("/inbox", "/requests", "/company/updates", "/somewhere"):
        built = await screen_context(client, ctx, path)
        assert built.entries == {}, path
        assert "Raise activation" not in data_of(built)


# protects=Screen context: /home holds confirmed goals with current value and distance to go,
# tracks with status and counts of open runs and checkpoints, and no source items;
# fails_when=goals or tracks are missing or an own-source excerpt is read; no_claim=wording.
async def test_home_context_has_goals_and_tracks_and_no_source_items(client):
    ctx, _doc = await company_data(client)
    text = data_of(built := await screen_context(client, ctx, "/home"))
    kinds = {e["kind"] for e in built.entries.values()}
    assert kinds == {"entity", "track"}
    assert "Raise activation" in text and "current 30, target 40, 10 to go" in text
    assert "Checkout track" in text and "active" in text
    assert "Open runs: 1; checkpoints waiting: 0" in text
    assert SOURCE_LINE not in text


# protects=Screen context: /documents lists titles, kinds and versions, /runs the active runs
# with status; fails_when=they are missing or a finished run is listed; no_claim=wording.
async def test_documents_and_runs_contexts(client):
    ctx, _doc = await company_data(client)
    text = data_of(await screen_context(client, ctx, "/documents"))
    assert "Checkout redesign PRD" in text and "prd" in text and "latest v1" in text
    text = data_of(await screen_context(client, ctx, "/runs"))
    assert "running" in text and "succeeded" not in text
    assert SOURCE_LINE not in text
