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
