"""C1 Requests under H11 Autonomy (issue #150): the ``requests`` responsibility's level
decides what Oracle's triage does with what it finds.

- "Act within limits": a suggestion at or above ``min_confidence`` (default 0.9) merges
  its duplicate, else links its confirmed goals, and tells the run's starter ("Oracle
  did", with Undo); themes and features stay suggestions;
- below the limit, or below Act: suggestions only (shown at Recommend and above, hidden
  at Observe and Draft);
- at no level does Oracle say no on its own.

Against Postgres; the triage file is applied as the run's segment end does. Made-up
people only. Each test's card: protects=<the observable>; fails_when=<the wrong result
it rejects>; no_claim=<what green does not prove>.
"""

import uuid

import pytest
from sqlalchemy import select

from oracle.autonomy_models import OracleAction
from oracle.docs.models import Document
from oracle.requests.models import ProductRequest
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx
from tests.test_requests import add, audits, get, goal
from tests.test_requests_triage import apply, triage_file, triage_run


@pytest.fixture
async def ctx() -> Ctx:
    return await make_ctx()


async def set_level(client, ctx: Ctx, level: str, **limits) -> None:
    """An owner sets Triage requests on Settings › Autonomy (the screen's own route)."""
    body: dict = {"level": level, "reason": "Trying Oracle on duplicates"}
    if limits:
        body["limits"] = limits
    resp = await client.put("/v1/autonomy/requests", json=body, headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text


async def actions(ctx: Ctx) -> list[OracleAction]:
    async with tenant_session(ctx.tenant_id) as db:
        return list(
            await db.scalars(select(OracleAction).where(OracleAction.responsibility == "requests"))
        )


async def undo(client, ctx: Ctx, action: OracleAction, who: str = "approver"):
    return await client.post(f"/v1/oracle-actions/{action.id}/undo", headers=ctx.as_(who))


async def test_at_act_a_sure_duplicate_is_merged_and_undo_reopens_it(client, ctx):
    """protects=Act: a 0.95 duplicate is merged into its target (decided by Oracle, audited
    as oracle), "duplicate" is marked accepted, one "Oracle did" row reaches the run's
    starter's Inbox linking to the request, and Undo (as the approver) reopens it as New;
    a second triage of the same pair does not merge it again; fails_when=nothing merges,
    someone else is told, the link is wrong, Undo fails, or Oracle redoes an undone merge;
    no_claim=the Inbox screen (Playwright, mock)."""
    await set_level(client, ctx, "act")
    a = await add(client, ctx, title="Remember my address")
    b = await add(client, ctx, title="Keep the delivery address")
    entry = {"id": a["id"], "duplicate_of": b["id"], "confidence": 0.95}
    result = await apply(ctx, await triage_run(ctx, "approver"), triage_file([entry]))
    assert result["acted"] == 1

    got = await get(client, ctx, a["id"])
    assert got["state"] == "merged" and got["merged_into_id"] == b["id"]
    assert got["decided_by"] is None
    (merged,) = await audits(ctx, "request.merged")
    assert merged.actor == "oracle" and merged.data["confidence"] == 0.95

    (action,) = await actions(ctx)
    assert action.notify_ids == [ctx.users["approver"].id]
    assert action.subject == {
        "kind": "request",
        "key": a["id"],
        "href": f"/requests?request={a['id']}",
    }
    assert action.summary == (
        "Merged “Remember my address” into “Keep the delivery address” (95% sure)"
    )
    assert action.undo == {
        "method": "POST",
        "path": f"/v1/requests/{a['id']}/reopen",
        "body": {"lock_version": got["lock_version"]},
    }
    inbox = (await client.get("/v1/inbox", headers=ctx.as_("approver"))).json()
    (row,) = [r for r in inbox["oracle_actions"] if r["responsibility"] == "requests"]
    assert row["subject"]["href"] == f"/requests?request={a['id']}" and row["counts"] is True

    resp = await undo(client, ctx, action)
    assert resp.status_code == 200, resp.text
    back = await get(client, ctx, a["id"])
    assert back["state"] == "new" and back["merged_into_id"] is None

    # The next triage suggests the same duplicate: a person undid it, so it stays a
    # suggestion.
    result = await apply(ctx, await triage_run(ctx, "approver"), triage_file([entry]))
    assert "acted" not in result
    again = await get(client, ctx, a["id"])
    assert again["state"] == "new" and again["suggestion"]["duplicate_of"] == b["id"]
    assert len(await actions(ctx)) == 1


async def test_at_act_sure_goals_are_linked_and_undo_restores_them(client, ctx):
    """protects=Act: a 0.95 suggestion with confirmed goals and no duplicate links them
    (kept with the request's own), marks "goals" accepted, leaves the theme a suggestion,
    and Undo (PATCH with the earlier goals) restores them; with no starter the
    longest-standing owner is told; fails_when=goals are not linked, a person's goal is
    dropped, the theme is applied, or Undo leaves Oracle's goal; no_claim=the Requests
    screen."""
    await set_level(client, ctx, "act")
    activation = await goal(client, ctx)
    retention = await goal(client, ctx, key="retention")
    a = await add(client, ctx, title="Bulk edit prices", goal_ids=[retention["id"]])
    entry = {
        "id": a["id"],
        "goals": ["activation"],
        "theme": {"title": "Catalogue tools"},
        "confidence": 0.95,
    }
    await apply(ctx, await triage_run(ctx, None), triage_file([entry]))

    got = await get(client, ctx, a["id"])
    assert got["state"] == "new"
    assert got["goal_ids"] == [retention["id"], activation["id"]]
    assert got["theme"] is None and got["suggestion"]["theme_title"] == "Catalogue tools"
    assert got["suggestion"]["accepted"] == ["goals"]

    (action,) = await actions(ctx)
    assert action.notify_ids == [ctx.users["owner"].id]
    assert action.summary.startswith("Linked “Bulk edit prices” to goal “")
    assert action.summary.endswith("(95% sure)")
    assert action.undo == {
        "method": "PATCH",
        "path": f"/v1/requests/{a['id']}",
        "body": {"lock_version": got["lock_version"], "goal_ids": [retention["id"]]},
    }
    resp = await undo(client, ctx, action, "owner")
    assert resp.status_code == 200, resp.text
    assert (await get(client, ctx, a["id"]))["goal_ids"] == [retention["id"]]


async def test_below_the_confidence_limit_it_stays_a_suggestion(client, ctx):
    """protects=the limit: at Act with the default 0.9, a 0.85 duplicate and goal stay a
    suggestion and nothing is reported; raising the bar to 0.8 lets the same file act;
    fails_when=Oracle acts under the limit or ignores a lower one; no_claim=the Settings
    limit field (Playwright)."""
    await set_level(client, ctx, "act")
    await goal(client, ctx)
    a = await add(client, ctx, title="Remember my address")
    b = await add(client, ctx, title="Keep the delivery address")
    entry = {"id": a["id"], "duplicate_of": b["id"], "goals": ["activation"], "confidence": 0.85}
    await apply(ctx, await triage_run(ctx), triage_file([entry]))
    got = await get(client, ctx, a["id"])
    assert got["state"] == "new" and got["goal_ids"] == []
    assert got["suggestion"]["duplicate_of"] == b["id"] and got["suggestion"]["accepted"] == []
    assert await actions(ctx) == []

    await set_level(client, ctx, "act", min_confidence=0.8)
    await apply(ctx, await triage_run(ctx), triage_file([entry]))
    assert (await get(client, ctx, a["id"]))["state"] == "merged"
    assert len(await actions(ctx)) == 1


@pytest.mark.parametrize("level", ["observe", "draft", "recommend"])
async def test_below_act_nothing_is_merged(client, ctx, level):
    """protects=below Act: a 1.0 duplicate is not merged nor goals linked and no "Oracle
    did" row appears; the suggestion shows at Recommend only (Observe and Draft hide it
    and refuse accepting it); fails_when=Oracle acts below Act, or shows or applies
    suggestions at Observe or Draft; no_claim=a drafted summary at Draft (not built)."""
    await set_level(client, ctx, level)
    await goal(client, ctx)
    a = await add(client, ctx, title="Remember my address")
    b = await add(client, ctx, title="Keep the delivery address")
    entry = {"id": a["id"], "duplicate_of": b["id"], "goals": ["activation"], "confidence": 1.0}
    await apply(ctx, await triage_run(ctx), triage_file([entry]))
    got = await get(client, ctx, a["id"])
    assert got["state"] == "new" and got["goal_ids"] == []
    assert await actions(ctx) == []
    resp = await client.post(
        f"/v1/requests/{a['id']}/suggestion/accept",
        json={"lock_version": got["lock_version"], "parts": ["goals"]},
        headers=ctx.as_("approver"),
    )
    if level == "recommend":
        assert got["suggestion"]["duplicate_of"] == b["id"]
        assert resp.status_code == 200, resp.text
    else:
        assert got["suggestion"] is None
        assert resp.status_code == 422, resp.text


async def test_act_never_says_no(client, ctx):
    """protects="Oracle never says no on its own": at Act with confidence 1.0 and a
    decline suggestion, the request stays New (no disqualify, no decision, no reply) and
    nothing is reported; fails_when=Oracle disqualifies; no_claim=Use this (a person's
    Disqualify form)."""
    await set_level(client, ctx, "act")
    a = await add(client, ctx, title="Export to a fax machine")
    entry = {
        "id": a["id"],
        "confidence": 1.0,
        "decline": {"reason": "out_of_scope", "why": "Nobody we serve uses fax"},
    }
    await apply(ctx, await triage_run(ctx), triage_file([entry]))
    got = await get(client, ctx, a["id"])
    assert got["state"] == "new" and got["disqualify_reason"] is None
    assert got["suggestion"]["decline"]["reason"] == "out_of_scope"
    assert await audits(ctx, "request.disqualified") == []
    assert await actions(ctx) == []


async def test_undo_of_linked_goals_survives_the_next_triage(client, ctx):
    """protects=#586 review MAJOR 2: Oracle links a goal at Act, the next triage run (Classify
    now or the daily run) rewrites the still-New request's suggestion, and Undo still
    restores the request's own goals; fails_when=Undo answers 409 because the triage bumped
    the request's lock_version after the Undo was recorded; no_claim=a person's own edit in
    between (it still makes Undo answer 409, as any stale edit)."""
    await set_level(client, ctx, "act")
    await goal(client, ctx)
    retention = await goal(client, ctx, key="retention")
    a = await add(client, ctx, title="Bulk edit prices", goal_ids=[retention["id"]])
    entry = {"id": a["id"], "goals": ["activation"], "confidence": 0.95}
    await apply(ctx, await triage_run(ctx, "approver"), triage_file([entry]))
    linked = await get(client, ctx, a["id"])
    # The next day's run classifies every New request again, this one included.
    await apply(ctx, await triage_run(ctx, "approver"), triage_file([entry]))
    assert (await get(client, ctx, a["id"]))["lock_version"] > linked["lock_version"]

    (action,) = await actions(ctx)
    resp = await undo(client, ctx, action)
    assert resp.status_code == 200, resp.text
    assert (await get(client, ctx, a["id"]))["goal_ids"] == [retention["id"]]


async def test_oracle_did_goes_to_an_approver(client, ctx):
    """protects=#586 review minor: the "Oracle did" row (and its Undo) reaches someone who
    can undo it: a run started by a person who is not an approver now (here a commenter)
    tells the longest-standing owner instead; fails_when=the commenter is told, and their
    Undo answers 403; no_claim=the Inbox screen."""
    await set_level(client, ctx, "act")
    a = await add(client, ctx, title="Remember my address")
    b = await add(client, ctx, title="Keep the delivery address")
    entry = {"id": a["id"], "duplicate_of": b["id"], "confidence": 0.95}
    await apply(ctx, await triage_run(ctx, "commenter"), triage_file([entry]))
    (action,) = await actions(ctx)
    assert action.notify_ids == [ctx.users["owner"].id]


async def test_undo_of_a_merge_into_a_no_withdraws_its_reply(client, ctx):
    """protects=#586 review minor: Oracle merges a request into one said no to, which drafts
    the same reasoned reply for its asker (H10 Asked again); Undo reopens it and that
    drafted reply goes, as a reopened request's own replies do; fails_when=the "why not"
    reply stays to be sent for a request that is New again; no_claim=replies already sent
    (they stay sent)."""
    await set_level(client, ctx, "act")
    a = await add(client, ctx, title="Export to a fax machine")
    b = await add(client, ctx, title="Fax the weekly report")
    b_lock = (await get(client, ctx, b["id"]))["lock_version"]
    resp = await client.post(
        f"/v1/requests/{b['id']}/disqualify",
        json={"lock_version": b_lock, "reason": "no_goal"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text
    entry = {"id": a["id"], "duplicate_of": b["id"], "confidence": 0.95}
    await apply(ctx, await triage_run(ctx, "approver"), triage_file([entry]))
    assert (await get(client, ctx, a["id"]))["state"] == "merged"

    async def mine() -> list[dict]:
        resp = await client.get(f"/v1/requests/{b['id']}/replies", headers=ctx.as_("approver"))
        assert resp.status_code == 200, resp.text
        return [r for r in resp.json() if r["request_id"] == a["id"]]

    (drafted,) = await mine()
    assert drafted["status"] != "withdrawn"
    (action,) = await actions(ctx)
    assert (await undo(client, ctx, action)).status_code == 200
    assert [r["status"] for r in await mine()] in ([], ["withdrawn"])


@pytest.mark.parametrize("level", ["draft", "recommend"])
async def test_a_suggestion_naming_a_hidden_title_shows_only_at_recommend_to_who_may_see_it(
    client, ctx, level
):
    """protects=#665 on main: both gates on a request's suggestion. #615 shows Oracle's
    suggestions at Recommend and above only; #621 (main) withholds one naming a hidden
    document, matched in the field itself (an em dash survives). At Recommend the owner
    reads it and a commenter does not; at Draft nobody does; fails_when=either gate is
    lost in the merge (the commenter reads the hidden title, or Draft shows it);
    no_claim=the Requests screen (Playwright)."""
    title = "Annual plan — the 2027 price list"
    async with tenant_session(ctx.tenant_id) as s:
        s.add(Document(slug=f"memo-{uuid.uuid4().hex[:6]}", title=title, kind="pricing",
                       visibility="approvers"))  # fmt: skip
        await s.commit()
    await set_level(client, ctx, level)
    a = await add(client, ctx, title="Remember my address")
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(ProductRequest, uuid.UUID(a["id"]))
        assert row is not None
        row.suggestion = {"rationale": f"Follows {title}.", "confidence": 0.7}
        await s.commit()
    for who, sees in (("owner", level == "recommend"), ("commenter", False)):
        got = await get(client, ctx, a["id"], who)
        assert (got["suggestion"] is not None) is sees, (level, who, got["suggestion"])
