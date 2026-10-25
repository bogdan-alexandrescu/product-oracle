"""B6 Goals interview under H11 Autonomy: the ``goals`` responsibility (Shape goals)
decides how far Oracle goes when a person asks it to make a vague goal measurable.

- Observe: Oracle tracks goals and flags gaps. It opens no goals interview (409, in plain
  words) and stores no versions, even when the level drops mid-interview; the flags (the
  vague goals and what each misses) stay.
- Draft: Oracle drafts one version for a named person to edit and own: at most one
  version is stored (the web offers no "Use version 1" default).
- Recommend (the default and ceiling): unchanged, up to three versions.

Oracle's model is the fake from test_goal_interview; no model is called. Made-up goals and
people only.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

from sqlalchemy import func, select

from oracle.baseline import goal_interview
from oracle.discussions.models import Discussion
from oracle.tenancy import tenant_session
from tests.test_goal_interview import (
    VERSIONS,
    B,
    changes,
    company,
    opened,
    reply_with,
    start,
    vague,
    vague_goal,
)
from tests.test_goal_interview import (
    fake as fake,  # the fake model fixture
)


async def set_level(client, ctx, level: str) -> None:
    """An owner sets Shape goals on Settings › Autonomy (the screen's own route)."""
    body = {"level": level, "reason": "Trying how far Oracle shapes goals"}
    resp = await client.put("/v1/autonomy/goals", json=body, headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text
    assert resp.json()["level"] == level


async def discussion_count(ctx) -> int:
    async with tenant_session(ctx.tenant_id) as s:
        return await s.scalar(select(func.count()).select_from(Discussion))


# protects=at Observe, neither Make measurable (one goal) nor Interview vague goals (all)
# opens an interview: 409 with the plain sentence, no discussion is created, and the vague
# goals list (the flags) still names the goal and what it misses; fails_when=an interview
# opens, the refusal is another status or wording, or the flags disappear; no_claim=the
# web hiding the buttons (autonomy-goals.spec.ts).
async def test_observe_opens_no_interview_and_keeps_the_flags(client, fake):
    fake.text = reply_with(VERSIONS)
    ctx = await company()
    goal = await vague_goal(client, ctx)
    await set_level(client, ctx, "observe")
    refused = await start(client, ctx, goal["id"], expect=409)
    assert refused["detail"] == goal_interview.OBSERVING
    assert refused["detail"] == (
        "Oracle is set to observe goals: it flags gaps and drafts nothing. An owner can "
        "change this in Settings › Autonomy."
    )
    resp = await client.post(f"{B}/goals/interview", json={}, headers=ctx.as_("commenter"))
    assert resp.status_code == 409, resp.text
    assert await discussion_count(ctx) == 0
    [row] = await vague(client, ctx)
    assert row["entity"]["id"] == goal["id"] and row["missing"]
    assert row["discussion_id"] is None
    assert fake.requests == []


# protects=a level dropped to Observe while Oracle's opening turn is pending stores none
# of its versions (keep_versions reads the level when the reply completes); fails_when=any
# goal_measure version is stored; no_claim=the reply's prose (it still streams).
async def test_observe_mid_interview_stores_no_versions(client, fake):
    fake.text = reply_with(VERSIONS)
    ctx = await company()
    goal = await vague_goal(client, ctx)
    d_id = (await start(client, ctx, goal["id"]))["discussion_id"]
    await set_level(client, ctx, "observe")
    resp = await client.get(f"/v1/discussions/{d_id}/messages", headers=ctx.as_("commenter"))
    [turn] = [m for m in resp.json()["items"] if m["author_kind"] == "oracle"]
    streamed = await client.get(
        f"/v1/discussions/{d_id}/messages/{turn['id']}/stream", headers=ctx.as_("commenter")
    )
    assert streamed.status_code == 200, streamed.text
    assert await changes(client, ctx, d_id) == []


# protects=at Draft, the interview opens and Oracle keeps one version (the first valid
# one, B5's checks still skip the invalid unit), not three; fails_when=more than one is
# stored, or none; no_claim=the web's missing Use version 1 quick reply (the web reads
# the level; autonomy-goals.spec.ts).
async def test_draft_keeps_one_version(client, fake):
    fake.text = reply_with(VERSIONS)
    ctx = await company()
    goal = await vague_goal(client, ctx)
    await set_level(client, ctx, "draft")
    d_id, _evs = await opened(client, ctx, goal["id"])
    stored = await changes(client, ctx, d_id)
    assert [c["payload"]["target"] for c in stored] == [8]
    assert stored[0]["status"] == "proposed" and stored[0]["proposed_by_kind"] == "oracle"


# protects=Recommend (set back from Observe) keeps today's interview: up to three versions;
# fails_when=the level trims or refuses at Recommend; no_claim=the versions' content
# (test_goal_interview.test_opening_turn_stores_versions).
async def test_recommend_keeps_up_to_three_versions(client, fake):
    fake.text = reply_with(VERSIONS)
    ctx = await company()
    goal = await vague_goal(client, ctx)
    await set_level(client, ctx, "observe")
    await set_level(client, ctx, "recommend")
    d_id, _evs = await opened(client, ctx, goal["id"])
    stored = await changes(client, ctx, d_id)
    assert [c["payload"]["target"] for c in stored] == [8, 6, 9]
