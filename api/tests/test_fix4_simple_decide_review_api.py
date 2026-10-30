"""fix4-simple-decide review: a comment made in a meeting before qa-simple-decide-1 was
recorded as a meeting decision titled "Comment: ..."; the data migration
0093_meeting_comments_as_notes turns each into the meeting's comment note. Against Postgres.

Card: protects=an old "Comment: ..." meeting decision becomes a comment of its meeting (its
words, who and when), is no longer one of the meeting's decisions and is withdrawn; other
meeting decisions stay; running it twice adds nothing; the migration chains as the one head;
fails_when=old comments still count as decisions in old meetings, or a comment is lost or
doubled; no_claim=the web's comment list (e2e/fix4-simple-decide-review.spec.ts)."""

import uuid

from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import select

from oracle.decisions.models import Decision
from oracle.simple import meetings
from oracle.simple.models import SimpleMeeting
from oracle.tenancy import tenant_session
from tests.conftest import API_DIR
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_meetings_api import get, start, world


async def test_old_comment_decisions_become_comments(client):
    w = await world()
    m = await start(client, w)
    mid = uuid.UUID(m["id"])
    async with tenant_session(w.ctx.tenant_id) as s:
        from oracle.simple.drafts import principal_for

        p = await principal_for(s, w.ctx.tenant_id, w.ctx.users["approver"].id)
        # As comment() wrote them before qa-simple-decide-1.
        old = await meetings.record_meeting_decision(
            s, p, mid, "Comment: Keep the beta", [{"kind": "document", "id": str(uuid.uuid4())}], []
        )
        kept = await meetings.record_meeting_decision(
            s, p, mid, "Ship the beta", [{"kind": "document", "id": str(uuid.uuid4())}], []
        )
        await s.commit()
    titles = [d["title"] for d in (await get(client, w, m["id"]))["meeting_decisions"]]
    assert "Comment: Keep the beta" in titles
    for _ in range(2):  # a second run adds nothing
        async with tenant_session(w.ctx.tenant_id) as s:
            await s.run_sync(lambda ss: meetings.comment_decisions_to_notes(ss.connection()))
            await s.commit()
    out = await get(client, w, m["id"])
    assert [d["title"] for d in out["meeting_decisions"]] == ["Ship the beta"]
    comments = [n for n in out["notes"] if n["kind"] == "comment"]
    # Who commented: the approver (the world's users go by their email).
    assert [(n["text"], n["by_name"]) for n in comments] == [
        ("Keep the beta", "approver@example.com")
    ]
    async with tenant_session(w.ctx.tenant_id) as s:
        assert (await s.get(Decision, old)).status == "withdrawn"
        assert (await s.get(Decision, kept)).status == "decided"
        row = await s.scalar(select(SimpleMeeting).where(SimpleMeeting.id == mid))
        assert len([n for n in row.notes if n.get("kind") == "comment"]) == 1


def test_the_migration_is_the_one_head():
    cfg = Config(str(API_DIR / "alembic.ini"))
    script = ScriptDirectory.from_config(cfg)
    assert script.get_heads() == ["0093_meeting_comments_as_notes"]
    assert script.get_revision("0093_meeting_comments_as_notes").down_revision == (
        "0092_feedback_discussion"
    )
