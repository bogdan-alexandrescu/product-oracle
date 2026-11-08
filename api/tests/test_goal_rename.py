"""Ground Truth goals: renaming a goal (its name and description) from the goal panel, and
no goal name or description written with an unfilled placeholder such as "[n]".

Invented example data only.

Test cards (protects / fails_when / no_claim):

- test_owner_renames_a_proposed_goal_with_an_audit_row: protects=a person who can change
  goals renames a proposed goal and rewrites its description through PATCH, and an audit
  row says who changed what from what; fails_when=the rename is not stored or leaves no
  audit row; no_claim=the panel (Playwright e2e/ground-truth-goal-rename.spec.ts).
- test_a_viewer_cannot_rename_a_goal: protects=a viewer's rename is refused (403) and
  nothing changes; fails_when=a viewer renames a goal.
- test_import_writes_goal_names_without_placeholders: protects=a goal imported with "[n]"
  in its name or description is written without it; fails_when="[n]" is stored.
- test_a_goal_stored_with_a_placeholder_reads_without_it: protects=a goal whose name and
  description were stored with "[n]" before the guard reads without it in the goal list
  (Home's proposed goals) while the graph keeps the stored text (the rename form starts
  from it); fails_when="[n]" is read in the list or the graph loses the stored text.
- test_a_blank_goal_name_is_refused: protects=a goal's name is stripped, and a blank or
  whitespace name is refused in plain words (422) on create and rename; fails_when=a blank
  name is stored or the padding is kept.
- test_an_empty_goal_name_reads_the_same_as_a_blank_one: protects=an empty name ("") is
  refused with the same plain words as a whitespace one, on create and rename; fails_when=the
  API answers pydantic's "at least 1 character" detail.
- test_without_placeholders: protects=the placeholder guard drops the forms an import writes
  ("[n]", "[n] of [n]", "[n] out of [n]", "[x]", "[#]", "[?]", "[tbd]", lowercase) and tidies
  the spaces; fails_when=a placeholder or a double space is left; no_claim=placeholders
  without square brackets.
- test_a_real_bracketed_word_stays_in_a_goal_name: protects=a capitalised or other bracketed
  word ("Project [X]", "Price [Value]", "Launch [beta]") is kept; fails_when=it is stripped.
"""

import pytest
from sqlalchemy import select

from oracle.baseline import goals
from oracle.baseline.models import Entity
from oracle.models import AuditEvent
from oracle.tenancy import tenant_session
from tests.baseline_helpers import entity, make_ctx

B = "/v1/baseline"


@pytest.fixture
async def ctx():
    return await make_ctx()


async def test_owner_renames_a_proposed_goal_with_an_audit_row(client, ctx):
    goal = await entity(
        client, ctx, who="token", type="goal", key="kr-reply-rate", title="KR 1.1 Replies"
    )
    assert goal["status"] == "proposed"
    resp = await client.patch(
        f"{B}/entities/{goal['id']}",
        json={
            "title": "KR 1.1 Ten live helpers answer 50 threads a day",
            "body": "Counted on the first of each month.",
            "origin": "user",
        },
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 200, resp.text
    read = (await client.get(f"{B}/entities/{goal['id']}", headers=ctx.as_("viewer"))).json()
    assert read["title"] == "KR 1.1 Ten live helpers answer 50 threads a day"
    assert read["body"] == "Counted on the first of each month."
    assert read["status"] == "proposed"
    async with tenant_session(ctx.tenant_id) as s:
        rows = (
            await s.scalars(select(AuditEvent).where(AuditEvent.action == "baseline.goal.renamed"))
        ).all()
    assert len(rows) == 1
    row = rows[0]
    assert row.actor == ctx.users["owner"].email or row.actor.endswith(str(ctx.users["owner"].id))
    assert str(row.entity_id) == goal["id"]
    assert row.data["before"]["title"] == "KR 1.1 Replies"
    assert row.data["after"]["title"] == "KR 1.1 Ten live helpers answer 50 threads a day"
    assert row.data["after"]["body"] == "Counted on the first of each month."


async def test_a_viewer_cannot_rename_a_goal(client, ctx):
    goal = await entity(client, ctx, type="goal", key="kr-uptime", title="KR 2.1 Uptime")
    resp = await client.patch(
        f"{B}/entities/{goal['id']}",
        json={"title": "Something else", "origin": "user"},
        headers=ctx.as_("viewer"),
    )
    assert resp.status_code == 403, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(Entity, goal["id"])
        assert row.title == "KR 2.1 Uptime"
        audits = (
            await s.scalars(select(AuditEvent).where(AuditEvent.action == "baseline.goal.renamed"))
        ).all()
    assert audits == []


LADDER = """
entities:
  - type: goal
    key: kr-1-1
    title: KR 1.1 [n] of [n] live helpers averaging 50 replied threads a day in March 2027
    body: Reach [n] live helpers, each replying to [N] threads a day.
  - type: goal
    key: kr-1-2
    title: KR 1.2 [n] helpers running at the same time, toward 200 replied threads
"""


async def test_import_writes_goal_names_without_placeholders(client, ctx):
    resp = await client.post(
        f"{B}/yaml",
        content=LADDER.encode(),
        headers={**ctx.as_("owner"), "Content-Type": "application/yaml"},
    )
    assert resp.status_code == 200, resp.text
    ents = {
        e["key"]: e
        for e in (
            await client.get(f"{B}/entities", params={"type": "goal"}, headers=ctx.as_("owner"))
        ).json()
    }
    assert ents["kr-1-1"]["title"] == (
        "KR 1.1 live helpers averaging 50 replied threads a day in March 2027"
    )
    assert ents["kr-1-2"]["title"] == (
        "KR 1.2 helpers running at the same time, toward 200 replied threads"
    )
    detail = (
        await client.get(f"{B}/entities/{ents['kr-1-1']['id']}", headers=ctx.as_("owner"))
    ).json()
    assert "[" not in detail["body"]
    assert detail["body"] == "Reach live helpers, each replying to threads a day."


async def test_an_agent_update_drops_placeholders(client, ctx):
    goal = await entity(
        client,
        ctx,
        who="token",
        type="goal",
        key="kr-latency",
        title="KR 3.1 Faster pages",
        origin="agent",
    )
    assert goal["locked"] is False
    resp = await client.patch(
        f"{B}/entities/{goal['id']}",
        json={"title": "KR 3.1 Pages load in [X] seconds", "origin": "agent"},
        headers=ctx.as_("token"),
    )
    assert resp.status_code == 200, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(Entity, goal["id"])
        assert row.title == "KR 3.1 Pages load in seconds"


async def test_a_goal_stored_with_a_placeholder_reads_without_it(client, ctx):
    goal = await entity(client, ctx, type="goal", key="kr-helpers", title="KR 4.1 Helpers")
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(Entity, goal["id"])
        row.title = "KR 4.1 [n] of [n] live helpers by March"
        row.body = "Reach [n] live helpers."
        await s.commit()
    listed = {
        e["key"]: e
        for e in (
            await client.get(f"{B}/entities", params={"type": "goal"}, headers=ctx.as_("viewer"))
        ).json()
    }
    assert listed["kr-helpers"]["title"] == "KR 4.1 live helpers by March"
    assert listed["kr-helpers"]["body"] == "Reach live helpers."
    graph = (await client.get(f"{B}/graph", headers=ctx.as_("owner"))).json()
    stored = next(e for e in graph["entities"] if e["key"] == "kr-helpers")
    assert stored["title"] == "KR 4.1 [n] of [n] live helpers by March"


async def test_a_blank_goal_name_is_refused(client, ctx):
    goal = await entity(client, ctx, type="goal", key="kr-signups", title="KR 5.1 Sign-ups")
    resp = await client.patch(
        f"{B}/entities/{goal['id']}",
        json={"title": "   ", "origin": "user"},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"] == "A goal needs a name"
    resp = await client.patch(
        f"{B}/entities/{goal['id']}",
        json={"title": "  KR 5.1 More sign-ups  ", "origin": "user"},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 200, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(Entity, goal["id"])).title == "KR 5.1 More sign-ups"
    resp = await client.post(
        f"{B}/entities",
        json={"type": "goal", "key": "kr-blank", "title": " \t ", "origin": "user"},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"] == "A goal needs a name"


async def test_an_empty_goal_name_reads_the_same_as_a_blank_one(client, ctx):
    goal = await entity(client, ctx, type="goal", key="kr-trials", title="KR 6.1 Trials")
    resp = await client.patch(
        f"{B}/entities/{goal['id']}",
        json={"title": "", "origin": "user"},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"] == "A goal needs a name"
    resp = await client.post(
        f"{B}/entities",
        json={"type": "goal", "key": "kr-empty", "title": "", "origin": "user"},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"] == "A goal needs a name"


def test_without_placeholders():
    assert goals.without_placeholders("KR 1.1 [n] of [n] live helpers") == "KR 1.1 live helpers"
    assert goals.without_placeholders("KR [n] of [n] agents") == "KR agents"
    assert goals.without_placeholders("Reach [n] out of [n] people by [tbd].") == "Reach people by."
    assert goals.without_placeholders("Ship [x] releases, then [?] more, [#] in all") == (
        "Ship releases, then more, in all"
    )
    assert goals.without_placeholders("Keep [optional] notes [1] here") == (
        "Keep [optional] notes [1] here"
    )
    assert goals.without_placeholders(None) is None


def test_a_real_bracketed_word_stays_in_a_goal_name():
    for name in ("Project [X]", "Price [Value]", "Launch [beta]", "Reach [N] by [TBD]"):
        assert goals.without_placeholders(name) == name
        assert goals.goal_name(name, "kr-x") == name
