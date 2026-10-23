"""Issue #260: a PRD run names the goals it serves (the ``goals`` knob of a Baseline to
PRD run, carried from the brief's goals or picked in Draft with Oracle).

Test card (test_target_goals, every test below): protects=a PRD run's target goals reach
its prompts (the baseline proposal and feature set favour features that move them, each
kept feature names the goals it serves, the PRD's goal trace covers them); fails_when=the
brief's goals are dropped on the way to the run, an unconfirmed goal or another flow is
accepted, a PATCH without goals loses them, or a segment prompt leaves them out;
no_claim=how well the agents follow the prompt, or how the web draws the choice.

Runs against Postgres with the FakeRuntime. Synthetic placeholders only.
"""

import uuid

import pytest

from oracle.runs import flows
from oracle.swarm import FakeRuntime, set_runtime
from tests.baseline_helpers import confirm, entity
from tests.intake_helpers import company, create_intake


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


async def _goals(client, ctx) -> list[dict]:
    """Three confirmed goals and one that is only proposed."""
    out = []
    for key, title in (("repeat-purchases", "Grow repeat purchases"),
                       ("support-load", "Lower support load"),
                       ("new-markets", "Open two new markets")):  # fmt: skip
        goal = await entity(client, ctx, type="goal", key=key, title=title)
        await confirm(client, ctx, goal)
        out.append(goal)
    out.append(await entity(client, ctx, type="goal", key="maybe-later", title="A maybe"))
    return out


def _named(run: dict) -> list[tuple[str, str]]:
    return [(g["key"], g["title"]) for g in run["knobs"]["goals"]]


async def _run(client, ctx, expect: int = 201, flow: str = "baseline_to_prd", **knobs) -> dict:
    resp = await client.post(
        "/v1/runs",
        json={"flow": flow, "document": "saved-addresses", "knobs": knobs},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == expect, resp.text
    return resp.json()


async def test_an_intake_run_carries_the_briefs_goals(client):
    ctx = await company()
    goals = await _goals(client, ctx)
    out = await create_intake(
        client, ctx, who="approver", goal_ids=[goals[1]["id"], goals[0]["id"]]
    )
    resp = await client.post(
        f"/v1/intakes/{out['intake']['id']}/runs", json={}, headers=ctx.as_("approver")
    )
    assert resp.status_code == 201, resp.text
    run = resp.json()
    assert _named(run) == [
        ("support-load", "Lower support load"),
        ("repeat-purchases", "Grow repeat purchases"),
    ]
    assert run["knobs"]["goals"][0]["id"] == goals[1]["id"]
    read = (await client.get(f"/v1/runs/{run['id']}", headers=ctx.as_("viewer"))).json()
    assert read["knobs"]["goals"] == run["knobs"]["goals"]


async def test_the_sheets_pick_overrides_the_brief_on_the_same_draft_run(client):
    ctx = await company()
    goals = await _goals(client, ctx)
    out = await create_intake(client, ctx, who="approver", goal_ids=[goals[0]["id"]])
    url = f"/v1/intakes/{out['intake']['id']}/runs"
    approver = ctx.as_("approver")
    first = (await client.post(url, json={}, headers=approver)).json()
    resp = await client.post(
        url, json={"knobs": {"goals": [goals[0]["id"], goals[2]["id"]]}}, headers=approver
    )
    assert resp.status_code in (200, 201), resp.text
    second = resp.json()
    assert second["id"] == first["id"]
    assert _named(second) == [
        ("repeat-purchases", "Grow repeat purchases"),
        ("new-markets", "Open two new markets"),
    ]
    # None picked: the run serves no named goal.
    resp = await client.post(url, json={"knobs": {"goals": []}}, headers=approver)
    assert resp.status_code in (200, 201), resp.text
    assert resp.json()["knobs"]["goals"] == []


async def test_a_plain_run_names_goals_by_key_and_patch_keeps_them(client):
    ctx = await company()
    await _goals(client, ctx)
    run = await _run(client, ctx, goals=["new-markets", "repeat-purchases", "new-markets"])
    assert _named(run) == [
        ("new-markets", "Open two new markets"),
        ("repeat-purchases", "Grow repeat purchases"),
    ]
    owner = ctx.as_("owner")
    resp = await client.patch(
        f"/v1/runs/{run['id']}", json={"knobs": {"depth": "deep"}}, headers=owner
    )
    assert resp.status_code in (200, 204), resp.text
    read = (await client.get(f"/v1/runs/{run['id']}", headers=owner)).json()
    assert read["knobs"]["depth"] == "deep"
    assert _named(read) == _named(run)
    resp = await client.patch(
        f"/v1/runs/{run['id']}", json={"knobs": {"goals": ["support-load"]}}, headers=owner
    )
    assert resp.status_code in (200, 204), resp.text
    read = (await client.get(f"/v1/runs/{run['id']}", headers=owner)).json()
    assert _named(read) == [("support-load", "Lower support load")]
    # Without the knob a run names none.
    assert (await _run(client, ctx))["knobs"]["goals"] == []


async def test_an_unconfirmed_goal_or_another_flow_is_422(client):
    ctx = await company()
    await _goals(client, ctx)
    resp = await _run(client, ctx, expect=422, goals=["maybe-later"])
    assert "maybe-later" in str(resp)
    await _run(client, ctx, expect=422, goals=["no-such-goal"])
    await _run(client, ctx, expect=422, flow="feedback_loop", goals=["support-load"])


async def test_the_started_runs_baseline_prompt_names_the_target_goals(client, runtime):
    ctx = await company()
    await _goals(client, ctx)
    run = await _run(client, ctx, goals=["support-load"], reuse_baseline=False)
    owner = ctx.as_("owner")
    assert (await client.post(f"/v1/runs/{run['id']}/estimate", headers=owner)).status_code == 200
    resp = await client.post(f"/v1/runs/{run['id']}/start", headers=owner)
    assert resp.status_code == 200, resp.text
    [spec] = runtime.submitted
    assert spec.labels["segment"] == "baseline"
    prompt = spec.steps[0].prompt
    assert "Target goals" in prompt
    assert "- support-load: Lower support load" in prompt
    assert "Favour the features that move these goals" in prompt


def _prompt(segment: str, goals: list[tuple[str, str]]) -> str:
    flow = flows.FLOWS["baseline_to_prd"]
    seg = flow.segment(segment)
    ctx = flows.PromptContext(
        run_id="r1", document="saved-addresses", snapshot_as_of=None, low_confidence=0.5,
        target_goals=goals,
    )  # fmt: skip
    return flows.step_prompt(flow, seg, seg.roles[-1], last=True, ctx=ctx)


GOALS = [("support-load", "Lower support load"), ("new-markets", "Open two new markets")]


def test_the_feature_set_prompt_favours_the_target_goals():
    prompt = _prompt("feature_set", GOALS)
    assert "- support-load: Lower support load" in prompt
    assert "- new-markets: Open two new markets" in prompt
    assert "Favour the features that move these goals" in prompt
    assert "every kept feature lists, under goals, the target goals it serves" in prompt


def test_the_prd_prompt_covers_the_target_goals_in_its_goal_trace():
    prompt = _prompt("prd_draft", GOALS)
    assert "- support-load: Lower support load" in prompt
    assert "The Goal trace section ({#goal-trace}) covers every target goal" in prompt


def test_a_run_without_target_goals_says_nothing_of_them():
    for segment in ("baseline", "feature_set", "priority", "prd_draft"):
        assert "Target goals" not in _prompt(segment, [])


# --- #260 review fixes ------------------------------------------------------------------


async def test_a_brief_goal_rejected_since_is_left_out_of_the_draft_run(client):
    """Finding 1: the brief named a goal that was rejected afterwards. Draft with Oracle
    leaves it out (the sheet says so) instead of refusing the first estimate with 422."""
    ctx = await company()
    goals = await _goals(client, ctx)
    out = await create_intake(
        client, ctx, who="approver", goal_ids=[goals[0]["id"], goals[1]["id"]]
    )
    resp = await client.post(
        f"/v1/baseline/entities/{goals[1]['id']}/reject", headers=ctx.as_("approver")
    )
    assert resp.status_code == 200, resp.text
    url = f"/v1/intakes/{out['intake']['id']}/runs"
    approver = ctx.as_("approver")
    resp = await client.post(url, json={}, headers=approver)
    assert resp.status_code == 201, resp.text
    run = resp.json()
    assert _named(run) == [("repeat-purchases", "Grow repeat purchases")]
    resp = await client.post(f"/v1/runs/{run['id']}/estimate", headers=approver)
    assert resp.status_code == 200, resp.text
    # The sheet sends the brief's goals as it read them: the rejected one is left out too.
    resp = await client.post(
        url, json={"knobs": {"goals": [goals[0]["id"], goals[1]["id"]]}}, headers=approver
    )
    assert resp.status_code in (200, 201), resp.text
    assert _named(resp.json()) == [("repeat-purchases", "Grow repeat purchases")]
    # A goal the person picks that is not confirmed is still refused.
    resp = await client.post(url, json={"knobs": {"goals": [goals[3]["id"]]}}, headers=approver)
    assert resp.status_code == 422, resp.text


def _known(**over):
    from oracle.runs import feature_set as fs

    base = {
        "features": {"saved-addresses": fs.Ref(entity_id=uuid.uuid4(), title="Saved addresses")},
        "goals": {"support-load": uuid.uuid4(), "new-markets": uuid.uuid4()},
    }
    return fs.Known(**(base | over))


FEATURE_SET = """\
version: 1
document: saved-addresses
features:
  - key: saved-addresses
    title: Saved addresses
    goals: [{key: support-load, contribution: 2}]
    depends_on: []
    confidence: 0.7
    requirements: []
"""


def test_the_feature_set_check_names_a_target_goal_no_kept_feature_serves():
    """Finding 3: the feature set says which goals each kept feature serves; a target goal
    no kept feature serves is a problem the reviewer sees (not blocking: the PRD's goal
    trace may say nothing moves it)."""
    from oracle.runs import feature_set as fs

    out = fs.check_feature_set(
        FEATURE_SET, document="saved-addresses",
        known=_known(targets={"support-load": "Lower support load",
                              "new-markets": "Open two new markets"}),
    )  # fmt: skip
    [problem] = [p for p in out.problems if p["code"] == "target_goal_unserved"]
    assert problem["blocking"] is False
    assert "new-markets" in problem["message"]
    assert out.blocking == 0
    clean = fs.check_feature_set(
        FEATURE_SET, document="saved-addresses",
        known=_known(targets={"support-load": "Lower support load"}),
    )  # fmt: skip
    assert not [p for p in clean.problems if p["code"] == "target_goal_unserved"]


PRD = """\
# Saved addresses {#title}

## Goal trace {#goal-trace}

Saved addresses lower support load (support-load): fewer tickets about wrong addresses.

## Problem {#problem}

Open two new markets is not this PRD's job.
"""


def test_the_goal_trace_check_names_the_target_goals_it_leaves_out():
    """Finding 3: the PRD's Goal trace covers every target goal, by key or title; a goal
    named only outside that section does not count."""
    targets = [("support-load", "Lower support load"), ("new-markets", "Open two new markets")]
    assert flows.goal_trace_missing(PRD, targets) == ["new-markets"]
    assert flows.goal_trace_missing(PRD, targets[:1]) == []
    assert flows.goal_trace_missing("# No trace {#title}\n", targets[:1]) == ["support-load"]


async def test_a_prd_whose_goal_trace_leaves_out_a_target_goal_says_so(client, runtime):
    """Finding 3, end to end: the run's feature set check and its imported PRD name the
    target goal they leave out (the FakeRuntime's PRD traces G1 only)."""
    from tests.fixtures import seed_auth
    from tests.test_runs import get, started, tick

    _, auth = await seed_auth()
    resp = await client.post(
        "/v1/baseline/entities",
        json={"type": "goal", "key": "support-load", "title": "Lower support load"},
        headers=auth,
    )
    assert resp.status_code in (201, 202), resp.text
    goal = resp.json()["entity"]
    resp = await client.post(f"/v1/baseline/entities/{goal['id']}/confirm", headers=auth)
    assert resp.status_code == 200, resp.text
    off = {"baseline_confirm": False, "feature_set": False, "priority_order": False}
    run = await started(
        client, auth, document="example-prd", checkpoints=off, goals=["support-load"]
    )
    for _ in range(4):
        await tick(client, auth)
    run = await get(client, auth, run["id"])
    fs_check = next(s for s in run["segments"] if s["name"] == "feature_set")
    codes = [p["code"] for p in fs_check["feature_set_check"]["problems"]]
    assert "target_goal_unserved" in codes
    imp = next(s for s in run["segments"] if s["name"] == "prd_draft")["draft_import"]
    assert imp["error"] is None
    assert "goal_trace_incomplete" in imp["warnings"]
    assert any("support-load" in n and "Goal trace" in n for n in run["notes"])
