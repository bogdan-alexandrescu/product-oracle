"""G6 Discussion rows in the Inbox: invitations, mentions, the changes proposed in a
discussion and the questions it asks wait in the one Inbox, and count in ``total``.

Each test's card: protects=<the observable>; fails_when=<the wrong result>;
no_claim=<what green does not prove>. Synthetic placeholders only.

Cards shared by the rows (issue #190, 6):
- Counting: protects=badge = New + Open = ``total`` (C1e); fails_when=a discussion row is
  counted on one surface and not another; no_claim=the visual order of groups.
- Privacy: protects=a private discussion's title reaches only people in it;
  fails_when=a removed participant or a non-participant approver sees any row;
  no_claim=discussion access itself (G1's tests).
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy import select

from oracle.discussions.models import DiscussionChange, DiscussionInboxItem
from oracle.tenancy import tenant_session
from oracle.v2.models import StakeholderQuestion
from tests.test_discussions import company, get, patch, post, section, start, uid

TITLE = "Caps: measure from plan thresholds?"
SECRET_TITLE = "Pricing: a private aside"


async def inbox(client, ctx, who) -> dict:
    resp = await client.get("/v1/inbox", headers=ctx.as_(who))
    assert resp.status_code == 200, resp.text
    return resp.json()


def rows(box: dict, kind: str | None = None, state: str | None = None) -> list[dict]:
    return [
        r
        for r in box["discussions"]
        if (kind is None or r["kind"] == kind) and (state is None or r["state"] == state)
    ]


async def read(client, ctx, d_id, who, message_id) -> None:
    resp = await client.post(
        f"/v1/discussions/{d_id}/read", json={"message_id": message_id}, headers=ctx.as_(who)
    )
    assert resp.status_code == 204, resp.text


async def add_change(ctx, d_id: str, status: str = "proposed", by: str | None = None) -> uuid.UUID:
    """A typed change as G3's extraction leaves it (G3's routes are not built); ``by``: the
    commenter whose Suggest made it ``suggested``."""
    async with tenant_session(ctx.tenant_id) as s:
        row = DiscussionChange(
            discussion_id=uuid.UUID(d_id),
            kind="section_edit",
            target={"section_key": "problem"},
            payload={"section_key": "problem", "instruction": "Say most, not half."},
            proposed_by_kind="oracle",
            status=status,
            suggested_by=ctx.users[by].id if by else None,
            suggested_at=datetime.now(UTC) if by else None,
        )
        s.add(row)
        await s.commit()
        return row.id


async def set_status(ctx, change_id: uuid.UUID, status: str) -> None:
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(DiscussionChange, change_id)
        row.status = status
        await s.commit()


# Counting card. protects=criterion 1: a commenter's mention adds the viewer and puts one
# "invited" row in their Inbox, counted in total, done after they read the thread;
# fails_when=no row, a second row, total unchanged, or still counted after the read;
# no_claim=the screens (web/e2e/inbox-discussions.spec.ts).
async def test_a_mention_invites_and_reading_marks_it_done(client):
    ctx, doc = await company(client)
    before = (await inbox(client, ctx, "viewer"))["total"]
    d = await start(client, ctx, subject=section(doc), title=TITLE)
    m = await post(
        client, ctx, d["id"], "commenter", "Viewer, see this", mentions=[uid(ctx, "viewer")]
    )
    box = await inbox(client, ctx, "viewer")
    [row] = rows(box)
    assert row["kind"] == "invited" and row["state"] == "new"
    assert row["title"] == TITLE and row["visibility"] == "open"
    assert row["by"]["user_id"] == uid(ctx, "commenter")
    assert row["subject_label"] == "Checkout redesign PRD · 2. Problem"
    assert f"discussion={d['id']}" in row["subject_url"]
    assert row["can_write"] is False
    assert box["total"] == before + 1
    # The commenter mentioned nobody of their own: no row for themselves.
    assert rows(await inbox(client, ctx, "commenter")) == []
    await read(client, ctx, d["id"], "viewer", m["id"])
    box = await inbox(client, ctx, "viewer")
    [row] = rows(box)
    assert row["state"] == "done"
    assert box["total"] == before


# Counting card. protects=criterion 2: a participant mentioned again gets one "mentioned"
# row whose excerpt is the message's first 140 characters; fails_when=no row, an invited
# row again, or a longer excerpt; no_claim=the quoting on screen.
async def test_a_later_mention_is_a_mentioned_row_with_a_short_excerpt(client):
    ctx, doc = await company(client)
    d = await start(client, ctx, subject=section(doc), title=TITLE)
    first = await post(client, ctx, d["id"], "commenter", "Hi", mentions=[uid(ctx, "viewer")])
    await read(client, ctx, d["id"], "viewer", first["id"])
    before = (await inbox(client, ctx, "viewer"))["total"]
    body = "Thresholds " + "x" * 200
    await post(client, ctx, d["id"], "commenter", body, mentions=[uid(ctx, "viewer")])
    box = await inbox(client, ctx, "viewer")
    [row] = rows(box, "mentioned")
    assert row["state"] == "new" and len(row["excerpt"]) <= 140
    assert row["excerpt"] == body[:140]
    assert len(rows(box, "invited")) == 1
    assert box["total"] == before + 1


# Counting card. protects=criterion 3: a commenter's Suggest gives every approver who can
# read the open discussion one "changes_proposed" row (count 1), and staging it removes
# the row for all of them; fails_when=a commenter gets it, an approver does not, or it
# stays after Stage; no_claim=G3's Suggest and Stage routes (not built: status set here).
async def test_a_suggested_change_waits_on_every_approver_until_staged(client):
    ctx, doc = await company(client)
    d = await start(client, ctx, subject=section(doc), title=TITLE, message={"body": "Thoughts?"})
    before = {who: (await inbox(client, ctx, who))["total"] for who in ("approver", "owner")}
    # Oracle's proposal alone waits on participants only: the approvers are not in it.
    cid = await add_change(ctx, d["id"])
    assert rows(await inbox(client, ctx, "approver")) == []
    await set_status(ctx, cid, "suggested")
    for who in ("approver", "owner"):
        box = await inbox(client, ctx, who)
        [row] = rows(box)
        assert row["kind"] == "changes_proposed" and row["count"] == 1
        assert row["id"] == f"chg_{d['id']}"
        assert row["people"] == ["Commenter"] and row["people_more"] == 0
        assert box["total"] == before[who] + 1
    assert rows(await inbox(client, ctx, "commenter")) == []
    await set_status(ctx, cid, "staged")
    for who in ("approver", "owner"):
        box = await inbox(client, ctx, who)
        assert rows(box) == [] and box["total"] == before[who]


# Privacy card. protects=criterion 4: a non-participant approver gets no row of a private
# discussion; once its starter makes it open, the same approver gets one changes_proposed
# row for its suggested change and no invited row; fails_when=a row before, none after, or
# an invited row; no_claim=G1's Make open warning.
async def test_a_private_discussion_made_open_reaches_approvers_without_inviting(client):
    ctx, doc = await company(client)
    d = await start(
        client, ctx, subject=section(doc), title=SECRET_TITLE, visibility="private",
        participants=[uid(ctx, "viewer")], message={"body": "Between us"},
    )  # fmt: skip
    await add_change(ctx, d["id"], "suggested", by="commenter")
    box = await inbox(client, ctx, "approver")
    assert rows(box) == [] and SECRET_TITLE not in str(box)
    before = box["total"]
    await patch(
        client, ctx, d["id"], "commenter", visibility="open", exposes={"messages": 1, "people": 1}
    )
    box = await inbox(client, ctx, "approver")
    [row] = rows(box)
    assert row["kind"] == "changes_proposed" and row["count"] == 1
    assert box["total"] == before + 1


# Privacy card. protects=criterion 5: the starter's add invites (never the starter), and
# removing the person deletes their invited and mentioned rows at once; fails_when=a row
# is left (even done) or any response carries the title; no_claim=G1's removal rules.
async def test_a_removed_participant_loses_the_rows_and_the_title(client):
    ctx, doc = await company(client)
    d = await start(
        client, ctx, subject=section(doc), title=SECRET_TITLE, visibility="private",
        participants=[uid(ctx, "viewer")],
    )  # fmt: skip
    await post(client, ctx, d["id"], "commenter", "Still with us?", mentions=[uid(ctx, "viewer")])
    box = await inbox(client, ctx, "viewer")
    assert {r["kind"] for r in rows(box)} == {"invited", "mentioned"}
    [invited] = rows(box, "invited")
    assert invited["visibility"] == "private" and invited["title"] == SECRET_TITLE
    assert rows(await inbox(client, ctx, "commenter")) == []
    resp = await client.delete(
        f"/v1/discussions/{d['id']}/participants/{uid(ctx, 'viewer')}",
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 204, resp.text
    box = await inbox(client, ctx, "viewer")
    assert rows(box) == [] and SECRET_TITLE not in str(box)
    async with tenant_session(ctx.tenant_id) as s:
        left = await s.scalars(
            select(DiscussionInboxItem).where(DiscussionInboxItem.user_id == ctx.users["viewer"].id)
        )
        assert list(left) == []


# Counting card. protects=criterion 6: only the row's owner dismisses an invited row (204,
# then Done); anyone else gets 404, and a changes_proposed row cannot be dismissed;
# fails_when=another person dismisses it or the row stays counted; no_claim=the button.
async def test_only_the_owner_dismisses_a_row(client):
    ctx, doc = await company(client)
    d = await start(client, ctx, subject=section(doc), title=TITLE)
    await post(client, ctx, d["id"], "commenter", "Hi", mentions=[uid(ctx, "viewer")])
    box = await inbox(client, ctx, "viewer")
    [row] = rows(box)
    url = f"/v1/inbox/discussion-items/{row['id']}"
    assert (await client.delete(url, headers=ctx.as_("approver"))).status_code == 404
    assert (await client.delete(url, headers=ctx.as_("viewer"))).status_code == 204
    after = await inbox(client, ctx, "viewer")
    assert rows(after)[0]["state"] == "done" and after["total"] == box["total"] - 1
    resp = await client.delete(
        f"/v1/inbox/discussion-items/chg_{d['id']}", headers=ctx.as_("viewer")
    )
    assert resp.status_code == 404


# Privacy card. protects=criterion 7: a question Oracle asked from a discussion comes back
# with its discussion's title, and with none for a reader of a private discussion they
# are not in; fails_when=no title, or a private title leaks; no_claim=C2's answer flow.
async def test_a_question_from_a_discussion_carries_its_title(client):
    ctx, doc = await company(client)
    d = await start(client, ctx, subject=section(doc), title=TITLE)
    secret = await start(
        client, ctx, subject=section(doc), title=SECRET_TITLE, visibility="private"
    )
    async with tenant_session(ctx.tenant_id) as s:
        for i, disc in enumerate((d, secret)):
            s.add(
                StakeholderQuestion(
                    document_id=uuid.UUID(doc),
                    section_key="problem",
                    category="general",
                    prompt=f"Which plan thresholds apply? {i}",
                    priority=1,
                    status="asked",
                    asked_to=ctx.users["viewer"].id,
                    discussion_id=uuid.UUID(disc["id"]),
                )  # fmt: skip
            )
        await s.commit()
    resp = await client.get("/v1/inbox/questions", headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    by_id = {q["question"]["discussion_id"]: q for q in resp.json()}
    assert by_id[d["id"]]["asked_by"]["kind"] == "oracle"
    assert by_id[d["id"]]["question"]["discussion_title"] == TITLE
    assert by_id[secret["id"]]["question"]["discussion_title"] is None
    assert SECRET_TITLE not in resp.text


# Counting card. protects=needs_me stays the feedback-only figure and total counts each
# new or open discussion row once (C1e); fails_when=needs_me moves or a done row counts;
# no_claim=the web's own count (web/e2e/inbox-discussions.spec.ts).
async def test_total_counts_new_and_open_rows_and_needs_me_does_not(client):
    ctx, doc = await company(client)
    base = await inbox(client, ctx, "approver")
    d = await start(client, ctx, subject=section(doc), title=TITLE, message={"body": "Hi"})
    await post(client, ctx, d["id"], "commenter", "Look", mentions=[uid(ctx, "approver")])
    await add_change(ctx, d["id"], "suggested", by="commenter")
    await add_change(ctx, d["id"])
    box = await inbox(client, ctx, "approver")
    [chg] = rows(box, "changes_proposed")
    # A participant now: Oracle's proposal counts with the suggestion.
    assert chg["count"] == 2
    live = [r for r in rows(box) if r["state"] in ("new", "open")]
    assert len(live) == 2 and box["total"] == base["total"] + 2
    assert box["needs_me"] == base["needs_me"]
    assert (await get(client, ctx, d["id"], "approver"))["title"] == TITLE


# Privacy card. protects=a G7 panel chat (private, its starter and Oracle) makes Inbox rows
# for its starter only: Oracle's proposed and the starter's suggested changes wait on the
# starter, no other approver or owner gets a row or its title, and once shared only the
# new open discussion reaches them; fails_when=anyone else sees the panel chat's row or
# title; no_claim=the panel's screens (G7's specs).
async def test_a_panel_chat_makes_rows_for_its_starter_only(client):
    ctx, doc = await company(client)
    resp = await client.post(
        "/v1/discussions",
        json={
            "subject_kind": "section", "subject": section(doc), "origin": "panel",
            "title": SECRET_TITLE, "message": {"body": "What would we cut?"},
        },
        headers=ctx.as_("approver"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    chat = resp.json()
    await add_change(ctx, chat["id"], "proposed")
    await add_change(ctx, chat["id"], "suggested", by="approver")

    [row] = rows(await inbox(client, ctx, "approver"))
    assert row["kind"] == "changes_proposed" and row["discussion_id"] == chat["id"]
    assert row["count"] == 2
    for who in ("owner", "commenter", "viewer"):
        box = await inbox(client, ctx, who)
        assert rows(box) == [] and SECRET_TITLE not in str(box)

    resp = await client.post(
        f"/v1/discussions/{chat['id']}/share",
        json={"title": TITLE, "first_message": "Name the measure first."},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 201, resp.text
    shared = resp.json()
    box = await inbox(client, ctx, "owner")
    assert [r["discussion_id"] for r in rows(box)] == [shared["id"]]
    assert SECRET_TITLE not in str(box)
