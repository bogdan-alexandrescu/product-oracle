"""G1 Discussion model through the routes: one thread per subject, open by default to
everyone who can see the subject, private when its starter says so, made open again by the
starter alone after a warning naming what it exposes, ending in typed changes.

Each test's card: protects=<the observable>; fails_when=<the wrong result>;
no_claim=<what green does not prove>. Synthetic placeholders only.
"""

import uuid

from sqlalchemy import select

from oracle.discussions import service as discussions
from oracle.discussions.models import Discussion, DiscussionChange, DiscussionMessage
from oracle.models import AuditEvent
from oracle.runs.models import Checkpoint, Run
from oracle.tenancy import tenant_session
from oracle.v2.models import KnowledgeGap, ProductIntake
from tests.baseline_helpers import Ctx, make_ctx
from tests.conftest import seed_company
from tests.coverage_helpers import read_only_mcp
from tests.fixtures import draft, import_draft
from tests.test_mcp import mcp_client, run_token, text_of
from tests.test_runs import runtime  # noqa: F401

SLUG = "checkout-redesign"
SECRET = "Can this ship without the detection item?"


async def company(client) -> tuple[Ctx, str]:
    """Owner, approver, commenter and viewer, and a PRD (v1) with a ``problem`` section."""
    ctx = await make_ctx()
    await seed_company(ctx.tenant_id)
    resp = await import_draft(client, ctx.as_("token"), draft("prd_v1.md"))
    assert resp.status_code == 201, resp.text
    return ctx, resp.json()["document_id"]


def uid(ctx: Ctx, who: str) -> str:
    return str(ctx.users[who].id)


def section(doc: str, version: int = 1, key: str = "problem") -> dict:
    return {"document_id": doc, "version": version, "section_key": key}


async def start(client, ctx, who="commenter", expect=201, **body) -> dict:
    body.setdefault("subject_kind", "section")
    body.setdefault("title", "Problem: measure from plan thresholds?")
    resp = await client.post("/v1/discussions", json=body, headers=ctx.as_(who))
    assert resp.status_code == expect, resp.text
    return resp.json()


async def private_with_approver(client, ctx, doc, messages: int = 0) -> dict:
    """A private discussion the commenter started with the approver; ``messages`` alternate
    commenter, approver."""
    d = await start(
        client, ctx, subject=section(doc), visibility="private", participants=[uid(ctx, "approver")]
    )
    for i in range(messages):
        who = "commenter" if i % 2 == 0 else "approver"
        await post(client, ctx, d["id"], who, f"Message {i + 1}")
    return d


async def post(client, ctx, d_id, who, body, expect=201, **extra) -> dict:
    resp = await client.post(
        f"/v1/discussions/{d_id}/messages", json={"body": body, **extra}, headers=ctx.as_(who)
    )
    assert resp.status_code == expect, resp.text
    return resp.json()


async def get(client, ctx, d_id, who, expect=200) -> dict:
    resp = await client.get(f"/v1/discussions/{d_id}", headers=ctx.as_(who))
    assert resp.status_code == expect, resp.text
    return resp.json()


async def listed(client, ctx, who, **query) -> list[dict]:
    resp = await client.get("/v1/discussions", params=query, headers=ctx.as_(who))
    assert resp.status_code == 200, resp.text
    return resp.json()["items"]


async def patch(client, ctx, d_id, who, expect=200, **body):
    if "lock_version" not in body:
        body["lock_version"] = (await get(client, ctx, d_id, "commenter"))["lock_version"]
    resp = await client.patch(f"/v1/discussions/{d_id}", json=body, headers=ctx.as_(who))
    assert resp.status_code == expect, resp.text
    return resp.json()


async def events(ctx, action: str) -> list[AuditEvent]:
    async with tenant_session(ctx.tenant_id) as s:
        return list(
            await s.scalars(
                select(AuditEvent).where(AuditEvent.action == action).order_by(AuditEvent.created_at)
            )
        )


async def messages(client, ctx, d_id, who="commenter") -> list[dict]:
    resp = await client.get(f"/v1/discussions/{d_id}/messages", headers=ctx.as_(who))
    assert resp.status_code == 200, resp.text
    return resp.json()["items"]


# protects=criterion 2: a commenter starts an open discussion on a section, a viewer reads it
# and cannot write; fails_when=the viewer writes or cannot read; no_claim=the screens.
async def test_a_commenter_starts_an_open_discussion_and_a_viewer_only_reads(client):
    ctx, doc = await company(client)
    d = await start(client, ctx, subject=section(doc), message={"body": SECRET})
    assert d["visibility"] == "open" and d["status"] == "open" and d["origin"] == "discuss"
    assert d["subject_key"] == f"section:{doc}:problem"
    assert d["subject_label"] == "Checkout redesign PRD · 2. Problem"
    assert d["subject_url"] == f"/documents/{SLUG}/v/1#problem"
    assert d["started_by"]["user_id"] == uid(ctx, "commenter")
    assert d["started_by"]["name"] == "Commenter" and d["started_by"]["role"] == "commenter"
    assert d["message_count"] == 1 and d["summary_status"] == "none"
    assert d["changes"] == {"proposed": 0, "suggested": 0, "staged": 0}
    assert d["me"] == {"participant": True, "can_write": True, "can_manage": True, "unread": 0}

    seen = await get(client, ctx, d["id"], "viewer")
    assert seen["title"] == "Problem: measure from plan thresholds?"
    assert seen["me"]["can_write"] is False and seen["me"]["participant"] is False
    resp = await client.post(
        f"/v1/discussions/{d['id']}/messages", json={"body": "Me too"}, headers=ctx.as_("viewer")
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == "Viewers can read discussions but not write in them"
    # A viewer cannot start one either.
    await start(client, ctx, "viewer", expect=403, subject=section(doc))
    # The title defaults to the subject's label.
    untitled = await start(client, ctx, subject=section(doc, key="users"), title=None)
    assert untitled["title"] == "Checkout redesign PRD · 3. Users"


# protects=criterion 3 and the hidden row shape: others see only that a private discussion
# exists; fails_when=the owner reads it, or the row carries any key beyond id, visibility,
# hidden, summary; no_claim=a shared summary's wording.
async def test_a_private_discussion_is_a_bare_row_for_everyone_else(client):
    ctx, doc = await company(client)
    d = await private_with_approver(client, ctx, doc, messages=1)
    resp = await client.get(f"/v1/discussions/{d['id']}", headers=ctx.as_("owner"))
    assert resp.status_code == 403
    assert resp.json()["detail"] == "This discussion is private"

    [row] = await listed(client, ctx, "owner", subject_key=d["subject_key"])
    assert set(row) == {"id", "visibility", "hidden", "summary"}
    assert row == {"id": d["id"], "visibility": "private", "hidden": True, "summary": None}
    assert len(await listed(client, ctx, "owner", document_id=doc)) == 1
    # Not filtered by its subject, or "mine": nothing at all.
    assert await listed(client, ctx, "owner") == []
    assert await listed(client, ctx, "owner", mine="true", subject_key=d["subject_key"]) == []
    # Its people read it in full.
    [mine] = await listed(client, ctx, "approver", subject_key=d["subject_key"])
    assert mine["title"] == d["title"] and mine["visibility"] == "private"
    assert (await get(client, ctx, d["id"], "approver"))["me"]["participant"] is True


# protects=criterion 4: a mention adds a person to an open discussion; fails_when=the viewer
# is not added, or is added as a writer; no_claim=the Inbox row (G6).
async def test_a_mention_makes_a_viewer_a_participant_who_cannot_write(client):
    ctx, doc = await company(client)
    d = await start(client, ctx, subject=section(doc))
    msg = await post(
        client, ctx, d["id"], "commenter", "@Viewer see this", mentions=[uid(ctx, "viewer")]
    )
    assert msg["mentions"] == [{"user_id": uid(ctx, "viewer"), "name": "Viewer"}]
    people = {
        p["user_id"]: p for p in (await get(client, ctx, d["id"], "commenter"))["participants"]
    }
    assert people[uid(ctx, "viewer")]["added_via"] == "mention"
    assert people[uid(ctx, "viewer")]["can_write"] is False
    assert people[uid(ctx, "commenter")]["added_via"] == "started"
    assert (await get(client, ctx, d["id"], "viewer"))["me"]["participant"] is True


# protects=criterion 5: only the starter adds people to a private discussion, also by a
# mention; fails_when=a non-starter's mention adds someone or stores the message;
# no_claim=the picker's amber chip (E2E).
async def test_only_the_starter_mentions_someone_into_a_private_discussion(client):
    ctx, doc = await company(client)
    d = await private_with_approver(client, ctx, doc)
    resp = await client.post(
        f"/v1/discussions/{d['id']}/messages",
        json={"body": "@Owner what do you think?", "mentions": [uid(ctx, "owner")]},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 422
    assert resp.json()["detail"] == "Only the starter can add people to a private discussion"
    assert await messages(client, ctx, d["id"]) == []

    await post(
        client, ctx, d["id"], "commenter", "@Owner please weigh in", mentions=[uid(ctx, "owner")]
    )
    assert (await get(client, ctx, d["id"], "owner"))["me"]["participant"] is True


# protects=criterion 6: removing a person from a private discussion ends their reading;
# fails_when=they still read it; no_claim=Leave in the UI.
async def test_a_removed_participant_can_no_longer_read_it(client):
    ctx, doc = await company(client)
    d = await private_with_approver(client, ctx, doc)
    resp = await client.delete(
        f"/v1/discussions/{d['id']}/participants/{uid(ctx, 'approver')}",
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 204, resp.text
    await get(client, ctx, d["id"], "approver", expect=403)
    # The starter cannot leave a private discussion while it is open.
    resp = await client.delete(
        f"/v1/discussions/{d['id']}/participants/{uid(ctx, 'commenter')}",
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 422
    [removed] = await events(ctx, "discussion.participant_remove")
    assert removed.data["user_id"] == uid(ctx, "approver")


# protects=criterion 7.1: the starter shares a private discussion's summary on its hidden row;
# fails_when=the summary shows unshared, or not once shared; no_claim=Oracle's draft (G3).
async def test_make_open_1_a_shared_summary_shows_on_the_hidden_row(client):
    ctx, doc = await company(client)
    d = await private_with_approver(client, ctx, doc, messages=3)
    assert d["summary_shared"] is False
    await patch(client, ctx, d["id"], "commenter", summary="Keep detection in scope.")
    [row] = await listed(client, ctx, "owner", subject_key=d["subject_key"])
    assert row["summary"] is None
    await patch(client, ctx, d["id"], "commenter", summary_shared=True)
    [row] = await listed(client, ctx, "owner", subject_key=d["subject_key"])
    assert row == {
        "id": d["id"],
        "visibility": "private",
        "hidden": True,
        "summary": "Keep detection in scope.",
    }
    # The summary's own rules: the starter writes it, at most 1,200 characters.
    await patch(client, ctx, d["id"], "approver", expect=403, summary="Mine now")
    await patch(client, ctx, d["id"], "commenter", expect=422, summary="x" * 1201)


# protects=criterion 7.2: only the starter makes a private discussion open; fails_when=another
# participant opens it; no_claim=whether others agree (the owner decided they are not asked).
async def test_make_open_2_a_participant_who_is_not_the_starter_is_refused(client):
    ctx, doc = await company(client)
    d = await private_with_approver(client, ctx, doc, messages=3)
    body = await patch(
        client, ctx, d["id"], "approver", expect=403, visibility="open",
        exposes={"messages": 3, "people": 2},
    )  # fmt: skip
    assert body["detail"] == "Only the starter can make a private discussion open"
    assert (await get(client, ctx, d["id"], "commenter"))["visibility"] == "private"


# protects=criterion 7.3: make open needs the current counts of what it exposes;
# fails_when=a missing or stale count is accepted, or anything changes; no_claim=the dialog.
async def test_make_open_3_without_current_counts_nothing_changes(client):
    ctx, doc = await company(client)
    d = await private_with_approver(client, ctx, doc, messages=3)
    starter = await get(client, ctx, d["id"], "commenter")
    assert starter["exposure"] == {"messages": 3, "people": 2}
    assert (await get(client, ctx, d["id"], "approver")).get("exposure") is None
    for exposes in (None, {"messages": 2, "people": 2}):
        extra = {} if exposes is None else {"exposes": exposes}
        body = await patch(
            client, ctx, d["id"], "commenter", expect=409, visibility="open", **extra
        )
        assert body == {"detail": "Confirm what this exposes", "messages": 3, "people": 2}
    after = await get(client, ctx, d["id"], "commenter")
    assert after["visibility"] == "private" and after["lock_version"] == starter["lock_version"]
    assert len(await messages(client, ctx, d["id"])) == 3
    assert await events(ctx, "discussion.visibility") == []


# protects=criterion 7.4: with the current counts the starter makes it open, everyone reads it,
# a system line says so, and the audit holds the counts and no text; fails_when=the owner
# still gets 403 or the hidden row, the line is missing, or the audit holds message text;
# no_claim=G5's agent view.
async def test_make_open_4_with_current_counts_everyone_reads_it(client):
    ctx, doc = await company(client)
    d = await private_with_approver(client, ctx, doc, messages=3)
    out = await patch(
        client, ctx, d["id"], "commenter", visibility="open", exposes={"messages": 3, "people": 2}
    )
    assert out["visibility"] == "open"
    assert out["exposure"] is None
    seen = await get(client, ctx, d["id"], "owner")
    assert seen["title"] == d["title"]
    [row] = await listed(client, ctx, "owner", subject_key=d["subject_key"])
    assert row["title"] == d["title"] and "hidden" not in row
    thread = await messages(client, ctx, d["id"], "owner")
    last = thread[-1]
    assert last["author_kind"] == "system" and last["author"] is None
    assert last["body"].startswith("Commenter made this discussion open on ")
    # Everyone in it stays in it; the system line is not counted as a message.
    assert {p["user_id"] for p in seen["participants"]} == {
        uid(ctx, "commenter"),
        uid(ctx, "approver"),
    }
    assert seen["message_count"] == 3
    [event] = await events(ctx, "discussion.visibility")
    assert event.data == {"from": "private", "to": "open", "messages": 3, "people": 2}
    assert event.entity == "discussion" and event.entity_id == uuid.UUID(d["id"])


# protects=criterion 7.5: a rule 3.4.3 discussion and a panel chat are never made open;
# fails_when=either opens; no_claim=G7's Share as discussion.
async def test_make_open_5_a_private_finding_or_a_panel_chat_stays_private(client):
    ctx, doc = await company(client)
    finding = await private_finding(ctx)
    d = await start(client, ctx, subject_kind="gap", subject={"gap_id": finding["gap_id"]})
    assert d["author_only"] is True and d["visibility"] == "private"
    body = await patch(
        client, ctx, d["id"], "commenter", expect=422, visibility="open",
        exposes={"messages": 0, "people": 0},
    )  # fmt: skip
    assert body["detail"] == "Share this finding at Summary or above first"

    panel = await private_with_approver(client, ctx, doc)
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(Discussion, uuid.UUID(panel["id"]))
        row.origin = "panel"
        await s.commit()
    body = await patch(
        client, ctx, panel["id"], "commenter", expect=422, visibility="open",
        exposes={"messages": 0, "people": 0},
    )  # fmt: skip
    assert body["detail"] == "Share a panel chat with Share as discussion"


# protects=criterion 7.6 as far as G1 goes: a change recorded on the discussion before it was
# made open keeps its status and payload; fails_when=making it open rewrites or drops its
# changes; no_claim=from_private on staged changes (G4 One staging list is not on main).
async def test_make_open_6_changes_recorded_before_stay_as_they_were(client):
    ctx, doc = await company(client)
    d = await private_with_approver(client, ctx, doc, messages=1)
    payload = {"section_key": "problem", "instruction": "Name the drop-off"}
    async with tenant_session(ctx.tenant_id) as s:
        s.add(
            DiscussionChange(
                discussion_id=uuid.UUID(d["id"]), kind="section_edit",
                target={"document_id": doc, "section_key": "problem"}, payload=payload,
                proposed_by_kind="person", proposed_by=ctx.users["commenter"].id, status="staged",
            )
        )  # fmt: skip
        await s.commit()
    await patch(
        client, ctx, d["id"], "commenter", visibility="open", exposes={"messages": 1, "people": 1}
    )
    resp = await client.get(f"/v1/discussions/{d['id']}/changes", headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text
    [change] = resp.json()
    assert change["status"] == "staged" and change["payload"] == payload
    assert change["label"] == "Change problem: Name the drop-off"
    assert (await get(client, ctx, d["id"], "owner"))["changes"]["staged"] == 1


async def private_finding(ctx: Ctx) -> dict[str, str]:
    """An intake by the commenter with one model-written gap whose finding is ``private``."""
    gap_id = uuid.uuid4()
    async with tenant_session(ctx.tenant_id) as s:
        intake = ProductIntake(
            title="Saved addresses",
            brief="Returning buyers retype their address.",
            author_id=ctx.users["commenter"].id,
            analysis={
                "findings": {
                    str(gap_id): {
                        "kind": "gap", "origin": "model", "category": "pain_evidence",
                        "source_item_ids": [], "summary": "A gap from the author's sources",
                        "sharing": "private", "gap_id": str(gap_id),
                    }
                }
            },
        )  # fmt: skip
        s.add(intake)
        await s.flush()
        s.add(
            KnowledgeGap(
                id=gap_id, intake_id=intake.id, category="pain_evidence",
                statement="Is the rollout limited to some regions?", impact=[],
                importance="high", knowledge_state="unknown", status="unknown",
            )
        )  # fmt: skip
        await s.commit()
        return {"gap_id": str(gap_id), "intake_id": str(intake.id)}


# protects=criterion 8 (rule 3.4.3): a discussion on the author's own private finding is the
# author's alone, nobody is added until the finding is shared at Summary, and nobody else
# learns it exists; fails_when=a non-author starts, sees or is added to it;
# no_claim=Oracle's reading of the finding (G2).
async def test_a_private_finding_discussion_is_the_authors_alone(client):
    ctx, _doc = await company(client)
    finding = await private_finding(ctx)
    subject = {"gap_id": finding["gap_id"]}
    resp = await client.post(
        "/v1/discussions",
        json={"subject_kind": "gap", "subject": subject},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code in (404, 422)
    with_people = await client.post(
        "/v1/discussions",
        json={"subject_kind": "gap", "subject": subject, "participants": [uid(ctx, "approver")]},
        headers=ctx.as_("commenter"),
    )
    assert with_people.status_code == 422
    assert with_people.json()["detail"] == "Share this finding at Summary or above to add people"
    d = await start(client, ctx, subject_kind="gap", subject=subject, message={"body": SECRET})
    assert d["author_only"] is True and d["visibility"] == "private"
    for who in ("owner", "approver", "viewer"):
        await get(client, ctx, d["id"], who, expect=404)
        assert await listed(client, ctx, who, subject_key=d["subject_key"]) == []
    add = {"user_ids": [uid(ctx, "approver")]}
    url = f"/v1/discussions/{d['id']}/participants"
    resp = await client.post(url, json=add, headers=ctx.as_("commenter"))
    assert resp.status_code == 422
    assert resp.json()["detail"] == "Share this finding at Summary or above to add people"

    resp = await client.post(
        f"/v1/intakes/{finding['intake_id']}/findings/sharing",
        json={"changes": [{"finding_id": finding["gap_id"], "sharing": "summary"}]},
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 200, resp.text
    resp = await client.post(url, json=add, headers=ctx.as_("commenter"))
    assert resp.status_code == 200, resp.text
    assert uid(ctx, "approver") in {p["user_id"] for p in resp.json()}
    assert (await get(client, ctx, d["id"], "approver"))["me"]["participant"] is True


# protects=criterion 9: a closed discussion is read-only and a stale lock_version is refused;
# fails_when=a message lands in a closed discussion or a stale PATCH wins; no_claim=Reopen in
# the UI.
async def test_closed_discussions_and_stale_versions_are_refused(client):
    ctx, doc = await company(client)
    d = await start(client, ctx, subject=section(doc))
    # Any approver who can read it closes it, not a commenter who did not start it.
    other = await start(client, ctx, "approver", subject=section(doc))
    await patch(client, ctx, other["id"], "commenter", expect=403, status="closed")
    closed = await patch(client, ctx, d["id"], "approver", status="closed")
    assert closed["status"] == "closed"
    body = await post(client, ctx, d["id"], "commenter", "Late", expect=409)
    assert body["detail"] == "This discussion is closed"
    body = await patch(client, ctx, d["id"], "commenter", expect=409, title="New", lock_version=1)
    assert body["detail"] == "Someone else changed this since you loaded it; reload and try again"
    reopened = await patch(client, ctx, d["id"], "commenter", status="open")
    assert reopened["status"] == "open"
    assert len(await events(ctx, "discussion.close")) == 1
    assert len(await events(ctx, "discussion.reopen")) == 1


# protects=criterion 10: a discussion follows its section across versions; fails_when=it is
# not listed on the new version's section; no_claim=the "Started on v1" marker (E2E).
async def test_a_section_discussion_follows_the_section_to_the_next_version(client):
    ctx, doc = await company(client)
    d = await start(client, ctx, subject=section(doc, version=1))
    v2 = draft("prd_v1.md").replace("draft for review", "second draft")
    resp = await import_draft(client, ctx.as_("token"), v2)
    assert resp.status_code == 201, resp.text
    assert resp.json()["number"] == 2
    [row] = await listed(client, ctx, "viewer", subject_key=f"section:{doc}:problem")
    assert row["id"] == d["id"]
    # Version 2 has no "nowhere" section: starting on it is refused.
    resp = await client.post(
        "/v1/discussions",
        json={"subject_kind": "section", "subject": section(doc, version=2, key="nowhere")},
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 422
    assert resp.json()["detail"] == "Section nowhere is not in version 2"
    resp = await client.post(
        "/v1/discussions",
        json={
            "subject_kind": "document",
            "subject": {"document_id": str(uuid.uuid4()), "version": 1},
        },
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 404 and resp.json()["detail"] == "Document not found"


# protects=criterion 11: run tokens never reach discussions and read-only credentials change
# nothing (AC1); fails_when=a run token lists discussions or an oracle:read client posts;
# no_claim=G5's own-run tool.
async def test_run_tokens_and_read_only_clients_are_refused(client, runtime):  # noqa: F811
    ctx, doc = await company(client)
    d = await start(client, ctx, subject=section(doc))
    token = await run_token(
        ctx.tenant_id,
        ["read:baseline", "read:documents", "read:sources"],
        ctx.users["commenter"].id,
    )
    async with mcp_client(token) as c:
        names = {t.name for t in (await c.list_tools()).tools}
        assert "list_discussions" not in names and "create_discussion_message" not in names
        refused = await c.call_tool("list_discussions", {})
        assert refused.is_error
    headers = await read_only_mcp(ctx, "commenter")
    resp = await client.post(
        f"/v1/discussions/{d['id']}/messages", json={"body": "Hi"}, headers=headers
    )
    assert resp.status_code == 403
    async with mcp_client(headers["Authorization"].removeprefix("Bearer ")) as c:
        names = {t.name for t in (await c.list_tools()).tools}
        assert "list_discussions" in names
        refused = await c.call_tool(
            "create_discussion_message", {"discussion_id": d["id"], "body": {"body": "Hi"}}
        )
        assert refused.is_error and "403" in text_of(refused)
    assert len(await messages(client, ctx, d["id"])) == 0


# protects=criterion 12: every write is audited with ids and lengths, never message text;
# fails_when=an event is missing or holds text; no_claim=the audit screen.
async def test_every_write_is_audited_without_message_text(client):
    ctx, doc = await company(client)
    d = await start(client, ctx, subject=section(doc), message={"body": SECRET})
    m = await post(client, ctx, d["id"], "approver", SECRET + " Yes.")
    resp = await client.patch(
        f"/v1/discussions/{d['id']}/messages/{m['id']}",
        json={"body": SECRET + " No."},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["edited_at"] is not None
    # Only its author edits or deletes a message.
    resp = await client.delete(
        f"/v1/discussions/{d['id']}/messages/{m['id']}", headers=ctx.as_("commenter")
    )
    assert resp.status_code == 403
    resp = await client.delete(
        f"/v1/discussions/{d['id']}/messages/{m['id']}", headers=ctx.as_("approver")
    )
    assert resp.status_code == 204
    thread = await messages(client, ctx, d["id"])
    gone = next(x for x in thread if x["id"] == m["id"])
    assert gone["deleted"] is True and gone["body"] == ""
    resp = await client.post(
        f"/v1/discussions/{d['id']}/participants",
        json={"user_ids": [uid(ctx, "viewer")]},
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 200, resp.text
    resp = await client.delete(
        f"/v1/discussions/{d['id']}/participants/{uid(ctx, 'viewer')}", headers=ctx.as_("viewer")
    )
    assert resp.status_code == 204
    await patch(client, ctx, d["id"], "commenter", visibility="private")
    await patch(client, ctx, d["id"], "commenter", status="closed")

    actions = [
        "discussion.start",
        "discussion.visibility",
        "discussion.participant_add",
        "discussion.participant_remove",
        "discussion.message_post",
        "discussion.message_edit",
        "discussion.message_delete",
        "discussion.close",
    ]
    for action in actions:
        found = await events(ctx, action)
        assert found, action
        for e in found:
            assert e.entity == "discussion" and e.entity_id == uuid.UUID(d["id"])
            assert "Can this ship" not in str(e.data), action
    posted = await events(ctx, "discussion.message_post")
    assert {e.data["length"] for e in posted} == {len(SECRET), len(SECRET + " Yes.")}
    [vis] = await events(ctx, "discussion.visibility")
    assert vis.data["from"] == "open" and vis.data["to"] == "private"


# protects=criterion 13: a mention picked from GET /v1/people stores that member's id, and an
# id the directory does not return is refused; fails_when=an inactive member or another
# company's person is mentioned; no_claim=the picker's search (E2E).
async def test_mentions_come_from_the_member_directory(client):
    ctx, doc = await company(client)
    other, _ = await company(client)
    people = (
        await client.get("/v1/people", params={"q": "approver"}, headers=ctx.as_("commenter"))
    ).json()
    [approver] = [p for p in people if p["email"] == "approver@example.com"]
    d = await start(client, ctx, subject=section(doc))
    m = await post(client, ctx, d["id"], "commenter", "@Approver", mentions=[approver["user_id"]])
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(DiscussionMessage, uuid.UUID(m["id"]))
        assert [str(x) for x in row.mentions] == [approver["user_id"]]
    for stranger in (uid(other, "approver"), str(uuid.uuid4())):
        body = await post(
            client, ctx, d["id"], "commenter", "@Who", expect=422, mentions=[stranger]
        )
        assert body["detail"] == f"{stranger} is not a member of this company"
    from datetime import UTC, datetime

    async with tenant_session(ctx.tenant_id) as s:
        viewer = ctx.users["viewer"]
        row = await s.get(type(viewer), viewer.id)
        row.disabled_at = datetime.now(UTC)
        await s.commit()
    body = await post(
        client, ctx, d["id"], "commenter", "@V", expect=422, mentions=[uid(ctx, "viewer")]
    )
    assert body["detail"] == f"{uid(ctx, 'viewer')} is not a member of this company"
    body = await post(client, ctx, d["id"], "commenter", "x" * 8001, expect=422)
    assert body["detail"] == "A message can be at most 8,000 characters"


# protects=exposure counts: people's and Oracle's messages count, deleted and system lines do
# not, and people are the distinct writers; fails_when=a deleted or system line is counted, or
# a writer twice; no_claim=the warning's wording (E2E).
async def test_exposure_counts(client):
    ctx, doc = await company(client)
    d = await private_with_approver(client, ctx, doc, messages=3)
    gone = await post(client, ctx, d["id"], "approver", "Scratch that")
    resp = await client.delete(
        f"/v1/discussions/{d['id']}/messages/{gone['id']}", headers=ctx.as_("approver")
    )
    assert resp.status_code == 204
    async with tenant_session(ctx.tenant_id) as s:
        did = uuid.UUID(d["id"])
        s.add(DiscussionMessage(discussion_id=did, author_kind="oracle", body="From the plan"))
        s.add(DiscussionMessage(discussion_id=did, author_kind="system", body="Someone joined"))
        await s.commit()
        row = await s.get(Discussion, did)
        assert await discussions.exposure(s, row) == (4, 2)


# protects=the starter role passes on when the starter is removed (rule 3.1.5): the
# earliest-added remaining approver or above becomes the starter, audited; fails_when=nobody
# can manage a discussion whose starter is gone; no_claim=member removal itself.
async def test_a_removed_starter_hands_the_discussion_to_an_approver(client):
    ctx, doc = await company(client)
    d = await private_with_approver(client, ctx, doc)
    resp = await client.post(
        f"/v1/members/{uid(ctx, 'commenter')}/disable", headers=ctx.as_("owner")
    )
    assert resp.status_code == 200, resp.text
    seen = await get(client, ctx, d["id"], "approver")
    assert seen["started_by"]["user_id"] == uid(ctx, "approver")
    assert seen["me"]["can_manage"] is True
    [event] = await events(ctx, "discussion.starter")
    assert event.data == {"from": uid(ctx, "commenter"), "to": uid(ctx, "approver")}


# protects=the checkpoint subject's key uses the run and the checkpoint kind; fails_when=a
# checkpoint of another run is accepted or the key holds the checkpoint id; no_claim=the run
# page's sheet (E2E).
async def test_a_checkpoint_discussion_is_keyed_by_the_run_and_the_checkpoint_kind(client):
    ctx, _doc = await company(client)
    async with tenant_session(ctx.tenant_id) as s:
        run, other = Run(flow="baseline_to_prd"), Run(flow="baseline_to_prd")
        s.add_all([run, other])
        await s.flush()
        cp = Checkpoint(run_id=run.id, kind="prd_review")
        s.add(cp)
        await s.commit()
    subject = {"run_id": str(run.id), "checkpoint_id": str(cp.id)}
    d = await start(client, ctx, "approver", subject_kind="checkpoint", subject=subject)
    assert d["subject_key"] == f"checkpoint:{run.id}:prd_review"
    assert d["subject_url"] == f"/runs/{run.id}"
    [row] = await listed(client, ctx, "viewer", run_id=str(run.id))
    assert row["id"] == d["id"]
    wrong = {"run_id": str(other.id), "checkpoint_id": str(cp.id)}
    resp = await client.post(
        "/v1/discussions",
        json={"subject_kind": "checkpoint", "subject": wrong},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 404 and resp.json()["detail"] == "Checkpoint not found"
