"""qa5-chat-working-draft: a meeting's chat reads the PRD as the meeting shows it. Against
Postgres; the reader's model is a fake. The invented PRD of test_simple_one_pager_api
("Guided setup", approved as version 1, decided by Dee Cider).

A line edited in the meeting goes into the PRD's working draft, and the meeting's
one-pager shows it (its lines and its sections) to whoever sees that draft. Before the fix
the chat's reader was given only the saved version's text, so it could answer with the old
words that the meeting's screen no longer shows.

Test cards (protects / fails_when / no_claim):

- test_the_reader_reads_the_working_draft_the_meeting_shows: protects=after a line is
  edited in the meeting, the reader's PRD text holds the edited words and every section
  body the meeting's one-pager shows the asker, and no longer the replaced words;
  fails_when=the reader gets the saved version's text; no_claim=the reader's answer.
- test_who_cannot_see_the_draft_reads_the_saved_version: protects=an attendee who does
  not see the working draft (a commenter) is read the saved version, as their one-pager
  shows it; fails_when=the draft's unsaved words reach a reader asked by someone who
  cannot see them; no_claim=the commenter's other rights.
- test_the_prd_text_carries_no_raw_tokens: protects=the PRD text given to the reader has
  no raw citation token ([c:4]) or section id label ({#build}) in the edited part;
  fails_when=the patch adds one; no_claim=the saved version's own headings.
- test_the_version_named_is_the_one_whose_text_is_read: protects=with a newer unapproved
  version (v2) and a working draft on the published v1, the reader's prd_version names
  v1, the version its text is built on; fails_when=it names v2 while the text is v1 with
  the meeting's edit; no_claim=which items the meeting lists.
- test_an_unpatchable_section_keeps_the_front_matter_and_title: protects=when the edited
  section cannot be found in the saved markdown, the reader's text still starts with the
  PRD's front matter and title; fails_when=the fallback keeps only the sections;
  no_claim=how the one-pager itself handles it.
"""

import re

from oracle.simple import one_pager
from oracle.simple.changes import ChangeError
from tests import test_simple_one_pager_api as op
from tests.test_simple_chat_reader import read
from tests.test_simple_one_pager_api import clock as clock  # noqa: F401

MEETINGS = "/v1/simple/meetings"
OLD = "A setup checklist that shows the next step"
NEW = "A checklist with two steps"


async def _meeting_with_an_edit(client, ctx) -> dict:
    r = await client.post(MEETINGS, json={
        "prd": "guided-setup", "title": "Setup review",
        "attendee_ids": [str(ctx.users["commenter"].id)],
    }, headers=ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 201, r.text
    m = r.json()
    view = await op.get(client, ctx, "decider")
    assert op.line(view, "bets-1")["text"] == OLD
    r = await client.post("/v1/simple/changes", json={
        "op": "edit_line", "session_id": m["session_id"],
        "target": {"document_id": view["document"]["id"], "line_id": "bets-1"},
        "before": {"line": OLD}, "after": {"line": NEW},
    }, headers=ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 201, r.text
    return m


async def _meeting(client, ctx, mid: str, who: str) -> dict:
    r = await client.post(f"{MEETINGS}/{mid}/chat/messages",
                          json={"text": "What will we build?"}, headers=ctx.as_(who))  # fmt: skip
    assert r.status_code == 200, r.text
    seen: list = []
    await read(ctx, {"actions": [], "clarify": None, "answer": None}, seen)
    [payload] = seen
    return payload["context"]["meeting"]


async def _prd_text(client, ctx, mid: str, who: str) -> str:
    return (await _meeting(client, ctx, mid, who))["prd_text"]


async def test_the_reader_reads_the_working_draft_the_meeting_shows(client):
    ctx = await op.world(client)
    m = await _meeting_with_an_edit(client, ctx)
    shown = await op.get(client, ctx, "decider")
    assert op.line(shown, "bets-1")["text"] == NEW
    text = await _prd_text(client, ctx, m["id"], "decider")
    assert NEW in text
    assert OLD not in text
    for sec in shown["sections"]:
        assert sec["body"].strip() in text, sec["key"]
    # The rest of the saved version is still read.
    assert "Invite suggestions from the admin's calendar" in text
    assert "Single sign-on setup" in text


async def test_who_cannot_see_the_draft_reads_the_saved_version(client):
    ctx = await op.world(client)
    m = await _meeting_with_an_edit(client, ctx)
    shown = await op.get(client, ctx, "commenter")
    assert shown["draft"] is None
    assert op.line(shown, "bets-1")["text"] == OLD
    text = await _prd_text(client, ctx, m["id"], "commenter")
    assert OLD in text
    assert NEW not in text


async def test_the_prd_text_carries_no_raw_tokens(client):
    ctx = await op.world(client)
    m = await _meeting_with_an_edit(client, ctx)
    text = await _prd_text(client, ctx, m["id"], "decider")
    build = text.split("{#build}", 1)[1].split("## ", 1)[0]
    assert NEW in build
    assert not re.search(r"\[(?:c|l):\d+\]|\{#", build)


async def test_the_version_named_is_the_one_whose_text_is_read(client):
    ctx = await op.world(client)
    v2 = op.PRD.replace("Fewer support tickets about setup", "Half the setup tickets")
    r = await client.post("/v1/documents/guided-setup/versions", content=v2.encode(),
                          headers=op.MD | ctx.as_("owner"))  # fmt: skip
    assert r.status_code in (200, 201), r.text
    m = await _meeting_with_an_edit(client, ctx)
    shown = await op.get(client, ctx, "decider")
    assert shown["draft"]["base_version"] == 1
    meeting = await _meeting(client, ctx, m["id"], "decider")
    assert NEW in meeting["prd_text"]
    assert "Fewer support tickets about setup" in meeting["prd_text"]
    assert meeting["prd_version"] == 1


async def test_an_unpatchable_section_keeps_the_front_matter_and_title(client, monkeypatch):
    def refuse(*_a, **_k):
        raise ChangeError(409, "Section could not be patched")

    monkeypatch.setattr(one_pager, "patched_markdown", refuse)
    ctx = await op.world(client)
    m = await _meeting_with_an_edit(client, ctx)
    text = await _prd_text(client, ctx, m["id"], "decider")
    assert text.startswith("---\ntitle: Guided setup\n---")
    assert NEW in text and OLD not in text
    assert "## Not doing" in text
