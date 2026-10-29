"""B6 Goals interview through the routes: starting (and reopening) an interview on a vague
goal, Oracle's opening turn and the versions it stores, the goal block it reads, Propose,
the pushback once, Accept now closing the discussion, the roles, and the after-review count.

Each test's card: protects=<the observable>; fails_when=<the wrong result>;
no_claim=<what green does not prove>. Synthetic placeholders only: made-up goals, people
and figures.
"""

import asyncio
import json
import uuid
from datetime import date

import pytest
from pydantic import ValidationError
from sqlalchemy import event, func, select

from oracle.baseline import goal_interview, goals
from oracle.baseline.models import Evidence, GoalMeasurement
from oracle.claude_accounts import fallback
from oracle.claude_accounts.fallback import API_KEY_PREFIX
from oracle.db import get_engine
from oracle.discussions import kinds
from oracle.discussions.models import Discussion, DiscussionChange, DiscussionMessage
from oracle.jobs import prompting
from oracle.llm import gateway
from oracle.llm.transports import LlmRequest, TransportResult
from oracle.mcp import scopes
from oracle.tenancy import tenant_session
from tests.baseline_helpers import entity, make_ctx, make_item
from tests.test_baseline_flow import started
from tests.test_runs import decide, get, tick
from tests.test_runs import owner as owner  # (tenant id, owner token headers)
from tests.test_runs import runtime as runtime  # the FakeRuntime fixture

B = "/v1/baseline"
METRIC = "Accounts lost in their first 90 days"


def version(**over) -> dict:
    payload = {
        "metric": METRIC, "unit": "%", "comparison": "below", "target": 8, "start": 11,
        "horizon": "medium", "due": "2027-06-30",
    }  # fmt: skip
    payload.update(over)
    return {k: v for k, v in payload.items() if v is not None}


def change(payload: dict, rationale: str = "Churn sits at 11% [c:1].", sources=(1,)) -> dict:
    return {
        "kind": "goal_measure",
        "payload": payload,
        "rationale": rationale,
        "sources": list(sources),
    }


OPENING = "Cut early churn is the goal. Missing: unit, comparison, target, horizon. [c:1]"
VERSIONS = [
    change(version(unit="Parsecs!")),  # refused by B5's unit check
    change(version()),
    change(version(target=6, owner_id=str(uuid.uuid4()), weight=4)),
    change(version(comparison="at_most", target=9, due=None)),
    change(version(target=5)),  # a fourth valid one: past the third
]


def reply_with(versions: list[dict], text: str = OPENING) -> str:
    block = json.dumps(versions)
    return f"{text}\n\nWho should own this goal?\n\n<<<CHANGES>>>\n{block}\n<<<END>>>"


class Fake:
    """Oracle's model streaming ``text`` in small chunks; records each request."""

    def __init__(self, text: str = OPENING):
        self.text = text
        self.requests: list[LlmRequest] = []

    async def complete(self, token, request) -> TransportResult:
        raise AssertionError("replies stream")

    async def stream(self, token, request, on_text) -> TransportResult:
        self.requests.append(request)
        for i in range(0, len(self.text), 7):
            await asyncio.sleep(0)
            await on_text(self.text[i : i + 7])
        return TransportResult(
            text=self.text,
            model=request.model,
            usage={"input_tokens": 100, "output_tokens": 20, "total_cost_usd": 0.01},
        )


@pytest.fixture
def fake():
    model = Fake()
    previous = gateway.set_transports(gateway.Transports(plan=model, api_key=model))
    yield model
    gateway.set_transports(previous)


async def company():
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        await fallback.store(s, API_KEY_PREFIX + "03-key", None)
        await s.commit()
    return ctx


def uid(ctx, who: str) -> str:
    return str(ctx.users[who].id)


async def vague_goal(client, ctx, key="early-churn", title="Cut early churn", **attrs) -> dict:
    attrs = {"metric": METRIC, "owner": uid(ctx, "approver"), **attrs}
    return await entity(client, ctx, type="goal", key=key, title=title, attrs=attrs)


async def measurable_goal(client, ctx) -> dict:
    attrs = {
        "metric": "New accounts that finish setup within 7 days", "unit": "%",
        "comparison": "at_least", "target": 45, "horizon": "short",
        "owner": uid(ctx, "approver"),
    }  # fmt: skip
    return await entity(
        client, ctx, type="goal", key="activation", title="Raise activation", attrs=attrs
    )


async def start(client, ctx, goal_id, who="commenter", expect=201, **body) -> dict:
    resp = await client.post(f"{B}/entities/{goal_id}/interview", json=body, headers=ctx.as_(who))
    assert resp.status_code == expect, resp.text
    return resp.json()


async def messages(client, ctx, d_id, who="commenter") -> list[dict]:
    resp = await client.get(f"/v1/discussions/{d_id}/messages", headers=ctx.as_(who))
    assert resp.status_code == 200, resp.text
    return resp.json()["items"]


async def changes(client, ctx, d_id, who="commenter") -> list[dict]:
    resp = await client.get(f"/v1/discussions/{d_id}/changes", headers=ctx.as_(who))
    assert resp.status_code == 200, resp.text
    return resp.json()


def events_of(text: str) -> list[tuple[str, object]]:
    out = []
    for block in text.split("\n\n"):
        lines = block.splitlines()
        if not lines or lines[0].startswith(":"):
            continue
        out.append((lines[0].removeprefix("event: "), json.loads(lines[1].removeprefix("data: "))))
    return out


async def opened(client, ctx, goal_id, who="commenter") -> tuple[str, list[tuple[str, object]]]:
    """Start the interview and stream Oracle's opening turn to its end."""
    d_id = (await start(client, ctx, goal_id, who))["discussion_id"]
    [turn] = [m for m in await messages(client, ctx, d_id, who) if m["author_kind"] == "oracle"]
    assert (turn["status"], turn["reply_to"]) == ("pending", None)
    resp = await client.get(
        f"/v1/discussions/{d_id}/messages/{turn['id']}/stream", headers=ctx.as_(who)
    )
    assert resp.status_code == 200, resp.text
    return d_id, events_of(resp.text)


async def lock_of(ctx, change_id) -> int:
    async with tenant_session(ctx.tenant_id) as s:
        return (await s.get(DiscussionChange, uuid.UUID(change_id))).lock_version


async def act(client, ctx, change_id, verb, who="commenter", expect=200, **body) -> dict:
    """G3's generic change action (B6's own routes are gone): the change, or the error."""
    body = {"lock_version": await lock_of(ctx, change_id), **body}
    resp = await client.post(
        f"/v1/discussion-changes/{change_id}/{verb}", json=body, headers=ctx.as_(who)
    )
    assert resp.status_code == expect, resp.text
    return resp.json()["change"] if resp.status_code == 200 else resp.json()


async def propose(client, ctx, change_id, who="commenter", expect=200, **body):
    return await act(client, ctx, change_id, "propose", who, expect, **body)


async def proposals(client, ctx) -> list[dict]:
    resp = await client.get(f"{B}/proposals", headers=ctx.as_("approver"))
    assert resp.status_code == 200, resp.text
    return resp.json()


async def vague(client, ctx, who="viewer") -> list[dict]:
    resp = await client.get(f"{B}/goals/vague", headers=ctx.as_(who))
    assert resp.status_code == 200, resp.text
    return resp.json()


# --- units ----------------------------------------------------------------------------------


# protects=B5's checks guard Oracle's versions, and ranking and ownership stay with people;
# fails_when=a version with a bad unit is accepted, or an Oracle version keeps weight or
# owner_id; no_claim=a real model could still mention them in prose (only stored changes
# are checked).
def test_oracle_goal_measure_strips_weight_and_owner():
    goal = str(uuid.uuid4())
    with pytest.raises(goals.GoalFieldsError) as bad:
        kinds.goal_measure({"entity_id": goal, **version(unit="Parsecs!")}, "oracle")
    assert [p["code"] for p in bad.value.problems] == ["bad_unit"]
    with pytest.raises(ValidationError):
        kinds.goal_measure({"entity_id": goal, **version(), "colour": "red"}, "oracle")
    person = str(uuid.uuid4())
    raw = {"entity_id": goal, **version(), "owner_id": person, "weight": 4}
    oracle = kinds.goal_measure(raw, "oracle")
    assert "owner_id" not in oracle and "weight" not in oracle
    assert oracle["target"] == 8 and oracle["due"] == "2027-06-30"
    mine = kinds.goal_measure(raw, "person")
    assert (mine["owner_id"], mine["weight"]) == (person, 4)
    assert kinds.goal_attrs(mine)["owner"] == person
    with pytest.raises(goals.GoalFieldsError):
        kinds.goal_measure({**raw, "weight": 11}, "person")


# protects=the version card's sentence (3.3); fails_when=the comparison, figure, unit or
# date reads otherwise; no_claim=the web's own wording around it.
def test_goal_measure_label_wording():
    goal = str(uuid.uuid4())
    target = {"entity_id": goal, "title": "Cut early churn"}
    stored = kinds.goal_measure({"entity_id": goal, **version()}, "oracle")
    assert kinds.label("goal_measure", stored, target) == (
        "Make Cut early churn measurable: less than 8% by Jun 30"
    )
    teams = {"entity_id": goal, "metric": "Teams", "unit": "teams", "comparison": "at_least",
             "target": 40, "horizon": "short"}  # fmt: skip
    assert kinds.label("goal_measure", teams, target) == (
        "Make Cut early churn measurable: at least 40 teams within the short horizon"
    )
    assert kinds.label("goal_measure", {"entity_id": goal, "metric": "Teams"}) == (
        f"Make {goal} measurable: Teams"
    )


# protects=the change block leaves the stored body and never streams, read with str.find;
# fails_when=the block or its start reaches readers, or a body without one changes;
# no_claim=a model that writes the block twice (the first is read).
def test_change_block_is_taken_out_of_the_reply():
    text = reply_with([change(version())])
    body, found = goal_interview.take_changes(text)
    assert body == f"{OPENING}\n\nWho should own this goal?"
    assert found == [change(version())]
    assert goal_interview.take_changes("No versions.") == ("No versions.", [])
    assert goal_interview.take_changes("x <<<CHANGES>>> not json <<<END>>>") == ("x", [])
    assert goal_interview.visible("Hello <<<CHA") == "Hello "
    assert goal_interview.visible("Hello <<<CHANGES>>>[") == "Hello "
    assert goal_interview.visible("a < b") == "a < b"
    # Linear on a hostile tail: many marker starts, no end.
    goal_interview.take_changes("<<<CHANGES>>>" + "<" * 200_000)


# protects=run tokens reach none of the interview routes (3.5); fails_when=a run-token
# scope names one of them; no_claim=the MCP listing itself (covered by test_mcp's parity).
def test_run_tokens_reach_no_interview_route():
    for method, path in (
        ("POST", "/v1/baseline/entities/{goal_id}/interview"),
        ("POST", "/v1/baseline/goals/interview"),
        ("GET", "/v1/baseline/goals/vague"),
    ):
        assert scopes.required_scope(method, path) is None, path


# --- the routes -----------------------------------------------------------------------------


# protects=criterion 1: one interview per goal on subject entity:<id>, with the starter and
# the goal's owner in it, reopened on a second call; 422 on a measurable goal or a non-goal,
# 404 on none; fails_when=a second discussion opens, the owner is left out, or a 422 is
# missed; no_claim=the owner's Inbox row (test_the_goal_owner_gets_an_inbox_row).
async def test_start_creates_one_interview_with_the_owner(client):
    ctx = await company()
    goal = await vague_goal(client, ctx)
    first = await start(client, ctx, goal["id"])
    assert first["created"] is True
    d = await client.get(f"/v1/discussions/{first['discussion_id']}", headers=ctx.as_("owner"))
    d = d.json()
    assert d["subject_kind"] == "entity" and d["subject_key"] == f"entity:{goal['id']}"
    assert d["subject"] == {"entity_id": goal["id"], "interview": True}
    assert d["title"] == "Make “Cut early churn” measurable"
    assert d["visibility"] == "open"
    assert {p["user_id"] for p in d["participants"]} == {
        uid(ctx, "commenter"),
        uid(ctx, "approver"),
    }
    again = await start(client, ctx, goal["id"], "approver", expect=200)
    assert again == {"discussion_id": first["discussion_id"], "created": False}
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.scalar(select(func.count()).select_from(Discussion)) == 1

    done = await measurable_goal(client, ctx)
    refused = await start(client, ctx, done["id"], expect=422)
    assert refused["detail"] == "This goal is already measurable"
    feature = await entity(client, ctx, type="feature", key="guided-setup", title="Guided setup")
    refused = await start(client, ctx, feature["id"], expect=422)
    assert refused["detail"] == "Only goals can be interviewed"
    await start(client, ctx, uuid.uuid4(), expect=404)
    listed = await vague(client, ctx)
    assert [(g["entity"]["id"], g["missing"], g["discussion_id"]) for g in listed] == [
        (goal["id"], ["unit", "comparison", "target", "horizon"], first["discussion_id"])
    ]


# protects=criterion 2: the goal's owner, added when the interview starts, gets an Invited
# row in the Inbox (G6 Discussion rows in the Inbox); fails_when=no row for the owner, or a
# row for the starter; no_claim=the row's wording and states (tests/test_discussion_inbox.py).
async def test_the_goal_owner_gets_an_inbox_row(client):
    ctx = await company()
    goal = await vague_goal(client, ctx)
    await start(client, ctx, goal["id"])
    title = "Make “Cut early churn” measurable"

    async def rows_for(who: str) -> list[dict]:
        resp = await client.get("/v1/inbox", headers=ctx.as_(who))
        assert resp.status_code == 200, resp.text
        return [r for r in resp.json()["discussions"] if r["title"] == title]

    [row] = await rows_for("approver")
    assert row["kind"] == "invited" and row["state"] == "new"
    assert row["by"]["user_id"] == uid(ctx, "commenter")
    assert await rows_for("commenter") == []


# protects=criterion 3: the opening turn stores up to 3 goal_measure changes, skips the one
# with an invalid unit, strips Oracle's owner_id and weight, and its block never reaches
# readers; the goal prompt rides on discussion_reply's; fails_when=a fourth or an invalid
# version is stored, owner or weight survive, or the block streams; no_claim=a real model.
async def test_opening_turn_stores_versions(client, fake, monkeypatch):
    fake.text = reply_with(VERSIONS)
    ctx = await company()
    goal = await vague_goal(client, ctx)
    skipped: list[str] = []
    monkeypatch.setattr(
        goal_interview.log, "warning", lambda msg, *args: skipped.append(msg % args)
    )
    d_id, evs = await opened(client, ctx, goal["id"])
    assert len(skipped) == 1 and "bad_unit" in skipped[0]
    streamed = "".join(e[1]["text"] for e in evs if e[0] == "delta")
    assert "<<<" not in streamed and "goal_measure" not in streamed
    done = evs[-1]
    assert done[0] == "done" and done[1]["body"] == f"{OPENING}\n\nWho should own this goal?"
    request = fake.requests[0]
    assert request.system == (
        f"{prompting.current('discussion_reply')[1]}\n\n"
        f"{prompting.current('discussion_reply_goal')[1]}"
    )
    assert request.messages[0]["content"].endswith("Open the interview.")
    stored = await changes(client, ctx, d_id)
    assert [c["payload"]["target"] for c in stored] == [8, 6, 9]
    for c in stored:
        assert c["kind"] == "goal_measure" and c["status"] == "proposed"
        assert c["proposed_by_kind"] == "oracle" and c["target"]["title"] == "Cut early churn"
        assert "owner_id" not in c["payload"] and "weight" not in c["payload"]
        assert c["result_ref"] is None and c["pushback"] is None
    assert stored[0]["label"] == "Make Cut early churn measurable: less than 8% by Jun 30"
    assert stored[0]["rationale"] == "Churn sits at 11% [c:1]."
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(DiscussionChange, uuid.UUID(stored[0]["id"]))
        assert row.from_message_id is not None and row.basis[0]["kind"] == "entity"
        turn = await s.get(DiscussionMessage, row.from_message_id)
        assert turn.prompt == "discussion_reply.v2+discussion_reply_goal.v2"
        assert "<<<" not in turn.body


# protects=criterion 4 (card: test_goal_context_has_no_private_items): the model request
# carries the goal block (missing fields, measurements, horizons, other goals' targets) and
# shared evidence, and no source item's text or id; fails_when=any source item text or id
# reaches the request, or the block is missing; no_claim=fake model; does not grade the
# model's answers.
async def test_goal_context_has_no_private_items(client, fake):
    ctx = await company()
    goal = await vague_goal(client, ctx)
    await measurable_goal(client, ctx)
    item_id = await make_item(
        ctx, "commenter", content="Zebra memo: the churn list names a customer.",
        title="Zebra private call",
    )  # fmt: skip
    async with tenant_session(ctx.tenant_id) as s:
        s.add_all([
            Evidence(entity_id=uuid.UUID(goal["id"]), source_item_id=item_id,
                     excerpt="Zebra excerpt from a private call", ref="Zebra private call",
                     confidence=0.9),
            Evidence(entity_id=uuid.UUID(goal["id"]), excerpt="Early churn sits at 11%.",
                     ref="Churn review notes", confidence=0.8),
        ])  # fmt: skip
        await s.commit()
        s.add(GoalMeasurement(entity_id=uuid.UUID(goal["id"]), value=11,
                              measured_on=date(2026, 9, 30)))  # fmt: skip
        await s.commit()
    statements: list[str] = []

    def spy(conn, cursor, statement, *args):
        statements.append(statement)

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", spy)
    try:
        await opened(client, ctx, goal["id"])
    finally:
        event.remove(engine, "before_cursor_execute", spy)
    prompt = fake.requests[0].messages[0]["content"]
    assert "The goal's check: missing unit, comparison, target, horizon" in prompt
    assert "Latest measurements: 11 on 2026-09-30" in prompt
    assert "The company's horizons: short " in prompt and "; medium " in prompt
    assert "The other goals' targets: Raise activation: at least 45%" in prompt
    assert "Early churn sits at 11%." in prompt
    assert "Zebra" not in prompt and str(item_id) not in prompt
    assert statements and not any("source_items" in s for s in statements)


# protects=criteria 5 and 7: a commenter's Propose makes an open proposal with the commenter
# as actor and reason "From discussion …"; an approver's Accept now locks the goal, Oracle
# says it is measurable now, the discussion closes, and goals/vague drops the goal;
# fails_when=the goal changes before Accept, the actor or reason differ, or the discussion
# stays open; no_claim=the card's wording (E2E).
async def test_propose_then_accept_closes_the_interview(client, fake):
    fake.text = reply_with([change(version())])
    ctx = await company()
    goal = await vague_goal(client, ctx)
    d_id, _evs = await opened(client, ctx, goal["id"])
    [c] = await changes(client, ctx, d_id)
    out = await propose(client, ctx, c["id"])
    assert out["status"] == "done" and out["suggested_by"]["user_id"] == uid(ctx, "commenter")
    proposal_id = out["result_ref"]["proposal_id"]
    [p] = await proposals(client, ctx)
    assert p["id"] == proposal_id and p["status"] == "open"
    assert p["actor"] == f"user:{uid(ctx, 'commenter')}"
    # G3's Propose: the reason names the discussion and links its page.
    assert p["payload"]["reason"] == (
        f"From discussion Make “Cut early churn” measurable (/baseline?discussion={d_id})"
    )
    unchanged = await client.get(f"{B}/entities/{goal['id']}", headers=ctx.as_("viewer"))
    assert "target" not in unchanged.json()["attrs"]
    await propose(client, ctx, c["id"], expect=409)  # already acted on

    resp = await client.post(f"{B}/proposals/{proposal_id}/accept", headers=ctx.as_("approver"))
    assert resp.status_code == 200, resp.text
    got = (await client.get(f"{B}/entities/{goal['id']}", headers=ctx.as_("viewer"))).json()
    assert got["attrs"]["target"] == 8 and got["locked"] is True
    assert got["locked_by"] == uid(ctx, "approver")
    d = (await client.get(f"/v1/discussions/{d_id}", headers=ctx.as_("viewer"))).json()
    assert d["status"] == "closed"
    last = (await messages(client, ctx, d_id))[-1]
    assert (last["author_kind"], last["body"]) == ("oracle", "“Cut early churn” is measurable now")
    assert await vague(client, ctx) == []


# protects=a subgoal (#469) is interviewed like any goal: it is listed vague with its parent,
# its interview opens on it, and Accept now makes it measurable under the same parent;
# fails_when=a subgoal is skipped or refused, or accepting its version loses its parent;
# no_claim=the parent's roll-up (tests/test_subgoals.py).
async def test_a_subgoal_is_interviewed_like_any_goal(client, fake):
    fake.text = reply_with([change(version())])
    ctx = await company()
    parent = await measurable_goal(client, ctx)
    sub = await entity(
        client, ctx, type="goal", key="early-churn", title="Cut early churn",
        attrs={"metric": METRIC, "owner": uid(ctx, "approver")}, parent_id=parent["id"],
    )  # fmt: skip
    [listed] = await vague(client, ctx)
    assert (listed["entity"]["id"], listed["entity"]["parent_id"]) == (sub["id"], parent["id"])
    d_id, _evs = await opened(client, ctx, sub["id"])
    d = (await client.get(f"/v1/discussions/{d_id}", headers=ctx.as_("viewer"))).json()
    assert d["subject"] == {"entity_id": sub["id"], "interview": True}
    [c] = await changes(client, ctx, d_id)
    proposal_id = (await propose(client, ctx, c["id"]))["result_ref"]["proposal_id"]
    resp = await client.post(f"{B}/proposals/{proposal_id}/accept", headers=ctx.as_("approver"))
    assert resp.status_code == 200, resp.text
    got = (await client.get(f"{B}/entities/{sub['id']}", headers=ctx.as_("viewer"))).json()
    assert (got["attrs"]["target"], got["parent_id"]) == (8, parent["id"])
    assert got["goal_check"]["measurable"] is True
    assert await vague(client, ctx) == []


# protects=criterion 7's second half: accepting a proposal that no interview made changes
# no discussion; fails_when=an open interview on the goal is closed or written to;
# no_claim=proposals on other goals (same lookup).
async def test_accepting_another_proposal_changes_no_discussion(client):
    ctx = await company()
    goal = await vague_goal(client, ctx)
    d_id = (await start(client, ctx, goal["id"]))["discussion_id"]
    before = await messages(client, ctx, d_id)
    attrs = {"unit": "%", "comparison": "below", "target": 8, "horizon": "medium"}
    resp = await client.post(
        f"{B}/proposals",
        json={"op": "update", "kind": "entity", "entity_id": goal["id"],
              "fields": {"attrs": attrs}, "reason": "From a review"},
        headers=ctx.as_("commenter"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    accepted = await client.post(
        f"{B}/proposals/{resp.json()['id']}/accept", headers=ctx.as_("approver")
    )
    assert accepted.status_code == 200, accepted.text
    d = (await client.get(f"/v1/discussions/{d_id}", headers=ctx.as_("commenter"))).json()
    assert d["status"] == "open"
    assert await messages(client, ctx, d_id) == before


# protects=criterion 6: Propose with fields that fail B5's checks returns its 422 errors and
# creates nothing; fails_when=a proposal is made or the version moves on; no_claim=every B5
# rule (test_goal_fields covers them).
async def test_propose_with_bad_fields_is_422_and_creates_nothing(client, fake):
    fake.text = reply_with([change(version())])
    ctx = await company()
    goal = await vague_goal(client, ctx)
    d_id, _evs = await opened(client, ctx, goal["id"])
    [c] = await changes(client, ctx, d_id)
    edit = {"entity_id": goal["id"], **version(unit="Parsecs!")}
    refused = await propose(client, ctx, c["id"], expect=422, payload=edit)
    assert refused["detail"] == "goal fields rejected: 1 problem(s)"
    assert refused["errors"][0]["code"] == "bad_unit"
    assert refused["errors"][0]["message"] == goals.MESSAGES["bad_unit"]
    assert await proposals(client, ctx) == []
    [still] = await changes(client, ctx, d_id)
    assert still["status"] == "proposed" and still["edited_payload"] is None


# protects=criterion 8: a target the start value already meets gets exactly one pushback,
# posted by Oracle; repeating it proposes it and the summary records the override;
# fails_when=no pushback, a second one, or the override is not in the summary;
# no_claim=pushback on evidence above the threshold (the model's, G2).
async def test_pushback_once_then_the_override_is_recorded(client, fake):
    fake.text = reply_with([change(version())])
    ctx = await company()
    goal = await vague_goal(client, ctx)
    d_id, _evs = await opened(client, ctx, goal["id"])
    [c] = await changes(client, ctx, d_id)
    edit = {"entity_id": goal["id"], **version(target=12)}
    pushed = await propose(client, ctx, c["id"], expect=409, payload=edit)
    sentence = (
        "The start value 11 already meets the target 12; a target that is already met does "
        "not measure progress."
    )
    assert pushed == {"detail": sentence, "pushback": True}
    last = (await messages(client, ctx, d_id))[-1]
    assert last["author_kind"] == "oracle" and last["body"] == f"Pushback: {sentence}"
    assert last["pushback"]["reason"] == sentence
    assert await proposals(client, ctx) == []
    out = await propose(client, ctx, c["id"], payload=edit)
    assert out["status"] == "done" and out["edited_payload"]["target"] == 12
    assert out["pushback"] == {"reason": sentence}
    assert out["override_reason"] == (
        "Kept target 12 although the start value 11 already meets it."
    )
    pushbacks = [m for m in await messages(client, ctx, d_id) if m["body"].startswith("Pushback:")]
    assert len(pushbacks) == 1
    d = (await client.get(f"/v1/discussions/{d_id}", headers=ctx.as_("commenter"))).json()
    assert "Kept target 12 although the start value 11 already meets it." in d["summary"]
    assert d["summary_status"] == "draft"
    [p] = await proposals(client, ctx)
    assert p["payload"]["fields"]["attrs"]["target"] == 12


# protects=criterion 9 and c6: a viewer reads an open interview and cannot post, start one
# or Propose; only approvers Dismiss; a private interview shows others only that it exists;
# fails_when=a viewer writes, a commenter dismisses, or a private one is read by an outsider;
# no_claim=MCP clients (same routes).
async def test_roles_and_a_private_interview(client, fake):
    fake.text = reply_with([change(version()), change(version(target=6))])
    ctx = await company()
    goal = await vague_goal(client, ctx)
    d_id, _evs = await opened(client, ctx, goal["id"])
    seen = (await client.get(f"/v1/discussions/{d_id}", headers=ctx.as_("viewer"))).json()
    assert seen["me"]["can_write"] is False
    resp = await client.post(
        f"/v1/discussions/{d_id}/messages", json={"body": "Me too"}, headers=ctx.as_("viewer")
    )
    assert resp.status_code == 403
    await start(client, ctx, goal["id"], "viewer", expect=403)
    first, second = await changes(client, ctx, d_id, "viewer")
    await propose(client, ctx, first["id"], "viewer", expect=403)
    await act(client, ctx, first["id"], "dismiss", "commenter", expect=403)
    dismissed = await act(client, ctx, first["id"], "dismiss", "approver")
    assert dismissed["status"] == "dismissed"
    await propose(client, ctx, first["id"], expect=409)
    assert second["status"] == "proposed"

    other = await vague_goal(client, ctx, key="support-load", title="Lower support load")
    mine = await start(client, ctx, other["id"], "owner", private=True)
    hidden = await client.get(f"/v1/discussions/{mine['discussion_id']}", headers=ctx.as_("viewer"))
    assert hidden.status_code == 403
    # The approver owns the goal: in it from the start.
    shown = await client.get(
        f"/v1/discussions/{mine['discussion_id']}", headers=ctx.as_("approver")
    )
    assert shown.status_code == 200 and shown.json()["visibility"] == "private"
    rows = {g["entity"]["id"]: g["discussion_id"] for g in await vague(client, ctx, "commenter")}
    assert rows[other["id"]] is None  # the commenter cannot read it


# protects=b6-goal-only-slice: B6's own Propose and Dismiss routes are retired for one
# release; they answer 410 with a pointer to G3's generic actions and change nothing, and
# they are no longer operations (no MCP tool, no OpenAPI path); fails_when=either route
# still acts, answers without the pointer, or is still listed; no_claim=the web's calls
# (the mock specs).
async def test_b6_routes_are_gone_with_a_pointer(client, fake):
    from oracle.main import app

    fake.text = reply_with([change(version())])
    ctx = await company()
    goal = await vague_goal(client, ctx)
    d_id, _evs = await opened(client, ctx, goal["id"])
    [c] = await changes(client, ctx, d_id)
    for verb, who in (("propose", "commenter"), ("dismiss", "approver")):
        resp = await client.post(f"{B}/goal-measures/{c['id']}/{verb}", headers=ctx.as_(who))
        assert resp.status_code == 410, resp.text
        assert resp.json()["detail"] == (
            f"This route is gone. Use POST /v1/discussion-changes/{{change_id}}/{verb} "
            "with the change's lock_version."
        )
    [still] = await changes(client, ctx, d_id)
    assert still["status"] == "proposed"
    assert await proposals(client, ctx) == []
    paths = app.openapi()["paths"]
    assert not [p for p in paths if "goal-measures" in p]


# protects=a person's Edit goes with Propose on G3's generic route as it did on B6's: the
# edited version is proposed, the change keeps the edit, and a commenter's edit does not
# first turn it into their suggestion; fails_when=the edit is lost or the route refuses a
# payload; no_claim=entity_edit's own fields.
async def test_generic_propose_takes_the_persons_edit(client, fake):
    fake.text = reply_with([change(version())])
    ctx = await company()
    goal = await vague_goal(client, ctx)
    d_id, _evs = await opened(client, ctx, goal["id"])
    [c] = await changes(client, ctx, d_id)
    edit = {"entity_id": goal["id"], **version(target=6)}
    out = await propose(client, ctx, c["id"], payload=edit)
    assert out["status"] == "done" and out["edited_payload"]["target"] == 6
    [p] = await proposals(client, ctx)
    assert p["payload"]["fields"]["attrs"]["target"] == 6


# protects=Interview vague goals (3.1 (2)): omitted ids start one interview per vague goal
# in order, and again reopens them; fails_when=a measurable goal is interviewed, a goal is
# skipped, or a second call opens new ones; no_claim=the stepper (E2E).
async def test_interview_every_vague_goal(client):
    ctx = await company()
    first = await vague_goal(client, ctx)
    await measurable_goal(client, ctx)
    second = await vague_goal(client, ctx, key="support-load", title="Lower support load")
    resp = await client.post(f"{B}/goals/interview", json={}, headers=ctx.as_("commenter"))
    assert resp.status_code == 200, resp.text
    rows = resp.json()["discussions"]
    assert [(r["entity_id"], r["created"]) for r in rows] == [
        (first["id"], True), (second["id"], True)
    ]  # fmt: skip
    again = await client.post(
        f"{B}/goals/interview", json={"entity_ids": [second["id"]]}, headers=ctx.as_("approver")
    )
    assert again.json()["discussions"] == [{**rows[1], "created": False}]


# protects=criterion 9a: approving a Confirm the baseline stop with two vague goals creates
# no discussion and makes no model call, and the run's checkpoint read shows vague_goals 2;
# fails_when=an interview starts on its own, Oracle's model is called, or the count is
# missing; no_claim=the after-review line's copy (E2E).
async def test_approving_the_baseline_starts_no_interview(client, owner, runtime, fake):
    tenant_id, auth = owner
    for key in ("early-churn", "support-load"):
        resp = await client.post(
            f"{B}/entities",
            json={"type": "goal", "key": key, "title": key.replace("-", " ").capitalize()},
            headers=auth,
        )
        assert resp.status_code == 201, resp.text
    run = await started(client, auth)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert [(c["kind"], c["vague_goals"]) for c in run["checkpoints"]] == [
        ("baseline_confirm", None)
    ]
    run = await decide(client, auth, run)
    [cp] = run["checkpoints"]
    assert (cp["status"], cp["vague_goals"]) == ("approved", 2)
    assert (await get(client, auth, run["id"]))["checkpoints"][0]["vague_goals"] == 2
    async with tenant_session(tenant_id) as s:
        assert await s.scalar(select(func.count()).select_from(Discussion)) == 0
    assert fake.requests == []


# --- B6 versions beside G3's changes --------------------------------------------------------


def g3_block(goal_id: str) -> str:
    entry = {
        "kind": "entity_edit", "target": {},
        "payload": {"entity_id": goal_id, "field": "title", "value": "Cut churn in 90 days"},
        "rationale": "The window is what the team measures [c:1].", "basis": [],
        "replaces": None,
    }  # fmt: skip
    return "<<<CHANGES>>>" + json.dumps({"changes": [entry]})


# protects=B6 and G3 share the delimiter: either order, B6's versions block stays for
# goal_interview and G3's changes object is taken out; fails_when=one block swallows the
# other or either is left in the text; no_claim=the stream (the route test below).
def test_a_goal_reply_splits_versions_from_changes():
    from oracle.discussions import changes as g3

    versions = reply_with([change(version())])
    g3_tail = g3_block(str(uuid.uuid4()))
    for text in (
        f"{versions}\n{g3_tail}",
        f"{OPENING}\n{g3_tail}\n<<<CHANGES>>>{json.dumps([change(version())])}<<<END>>>",
    ):
        rest, tail = g3.split_goal_reply(text)
        assert tail is not None and json.loads(tail)["changes"][0]["kind"] == "entity_edit"
        body, found = goal_interview.take_changes(rest)
        assert "<<<" not in body and body.startswith(OPENING)
        assert [f["payload"]["target"] for f in found] == [8]
    assert g3.split_goal_reply(versions) == (versions, None)


# protects=a goal discussion's reply carrying both B6's version block and G3's changes block
# shows readers neither (deltas, the saved body), keeps the version and extracts the change,
# sent as one changes event before done; fails_when=either block reaches the chat, the
# version is lost to G3's hold-back, or G3's change is not extracted; no_claim=the model's
# judgement about what to propose (the fake reply stands in).
async def test_goal_reply_with_versions_and_changes(client, fake):
    ctx = await company()
    goal = await vague_goal(client, ctx)
    fake.text = f"{reply_with([change(version())])}\n{g3_block(goal['id'])}"
    d_id, evs = await opened(client, ctx, goal["id"])
    streamed = "".join(e[1]["text"] for e in evs if e[0] == "delta")
    assert "<<<" not in streamed and "goal_measure" not in streamed
    assert "entity_edit" not in streamed and "changes" not in streamed
    names = [e[0] for e in evs]
    assert names.index("changes") == len(names) - 2 and names[-1] == "done"
    assert evs[-1][1]["body"] == f"{OPENING}\n\nWho should own this goal?"
    sent = {c["kind"] for c in evs[names.index("changes")][1]}
    assert sent == {"goal_measure", "entity_edit"}
    stored = {c["kind"]: c for c in await changes(client, ctx, d_id)}
    assert set(stored) == {"goal_measure", "entity_edit"}
    assert stored["goal_measure"]["payload"]["target"] == 8
    assert stored["entity_edit"]["payload"]["value"] == "Cut churn in 90 days"
    for c in stored.values():
        assert (c["status"], c["proposed_by_kind"]) == ("proposed", "oracle")
    async with tenant_session(ctx.tenant_id) as s:
        turn = await s.get(DiscussionMessage, uuid.UUID(evs[-1][1]["id"]))
        assert "<<<" not in turn.body and "entity_edit" not in turn.body


# protects=qa-plan-48: an interview whose goal only lacks an owner is titled by that gap;
# fails_when=it reads "Make “…” measurable" while the goal has its metric, target and horizon;
# no_claim=the opening turn's wording (the reply tests).
async def test_owner_only_gap_titles_the_interview_by_its_question(client):
    ctx = await company()
    attrs = {
        "metric": "Trials that move to a paid plan", "unit": "%",
        "comparison": "at_least", "target": 12, "horizon": "medium",
    }  # fmt: skip
    goal = await entity(
        client, ctx, type="goal", key="paid", title="Grow paid conversion", attrs=attrs
    )
    first = await start(client, ctx, goal["id"])
    d = await client.get(f"/v1/discussions/{first['discussion_id']}", headers=ctx.as_("owner"))
    assert d.json()["title"] == "Who should own “Grow paid conversion”?"
