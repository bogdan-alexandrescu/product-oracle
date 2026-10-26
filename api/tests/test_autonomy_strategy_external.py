"""H11 Autonomy wired into H4 Strategy and vision (``strategy``, ``vision``) and into the
words Oracle drafts for people outside the company (``external_messages``: H6's launch
kit, H8's board and investor updates; C1's why-not replies are in test_request_replies).

None of the three can reach Act (ceilings Recommend, Draft and Draft), so Oracle never
acts or sends here: Observe stops Oracle drafting, Draft and Recommend shape what it
drafts. Against Postgres with the FakeRuntime.

Every test states its card: protects, fails_when, no_claim."""

import pytest
from sqlalchemy import func, select

from oracle import autonomy
from oracle.runs.models import Run
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.launch_helpers import ticker_pass
from tests.strategy_helpers import (
    STRATEGY,
    VISION,
    belief,
    choice,
    imported,
    strategy_md,
    vision_md,
)
from tests.test_launch_kit import KIT, _finish, _ready
from tests.test_roadmap import owner  # noqa: F401 - fixture
from tests.update_helpers import started

SPAN = {"horizon_from": "2027-01-01", "horizon_to": "2027-12-31"}
DRAFT_LINE = "Oracle is set to Draft for the product strategy"
RECOMMEND_LINE = "Oracle is set to Recommend for the product strategy"


@pytest.fixture
async def ctx():
    return await make_ctx()


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


async def set_level(client, headers, key: str, level: str) -> None:
    """An owner sets a responsibility on Settings › Autonomy (the screen's own route)."""
    resp = await client.put(
        f"/v1/autonomy/{key}", json={"level": level, "reason": "Trying it"}, headers=headers
    )
    assert resp.status_code == 200, resp.text


async def _runs(tenant_id) -> int:
    async with tenant_session(tenant_id) as s:
        return await s.scalar(select(func.count()).select_from(Run))


async def _strategy_run(client, headers, slug: str, brief: dict):
    return await client.post(
        "/v1/runs",
        json={"flow": "strategy_draft", "document": slug, "knobs": {"depth": "standard"},
              "strategy_brief": brief},
        headers=headers,
    )  # fmt: skip


# --- the registry ------------------------------------------------------------------------


async def test_strategy_vision_and_external_messages_are_wired(client, ctx):
    """protects=the three responsibilities report wired (Settings › Autonomy drops their
    "Takes effect when" chip) with their ceilings and defaults unchanged; fails_when=wired
    is false or a ceiling moved; no_claim=the screen (Playwright)."""
    resp = await client.get("/v1/autonomy", headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    by = {i["key"]: i for i in resp.json()["items"]}
    for key, ceiling, default in (
        ("strategy", "recommend", "recommend"),
        ("vision", "draft", "draft"),
        ("external_messages", "draft", "draft"),
    ):
        assert by[key]["wired"] is True, key
        assert (by[key]["ceiling"], by[key]["default"]) == (ceiling, default), key
    # The registry's order is shared with the other lanes: untouched.
    assert list(autonomy.REGISTRY)[-5:] == [
        "strategy", "vision", "pricing_input", "external_messages", "market"
    ]  # fmt: skip


# --- strategy and vision -----------------------------------------------------------------


async def test_at_observe_oracle_drafts_no_strategy(client, ctx, runtime):
    """protects=with strategy at Observe a strategy_draft run on the product strategy is
    409 "Oracle drafts no product strategy at Observe" and no run is made; the drift check
    still runs; fails_when=a run is created or the check is refused; no_claim=the vision
    (below)."""
    owner_h = ctx.as_("owner")
    await imported(client, owner_h, STRATEGY, strategy_md([choice("self-serve", goals=[])]))
    await set_level(client, owner_h, "strategy", "observe")
    resp = await _strategy_run(client, owner_h, STRATEGY, SPAN)
    assert resp.status_code == 409, resp.text
    assert "Oracle drafts no product strategy at Observe" in resp.text
    assert await _runs(ctx.tenant_id) == 0
    # Observe still flags: the drift check is Oracle's at every level.
    assert (await client.post("/v1/strategy/check", headers=owner_h)).status_code == 200


async def test_at_observe_oracle_drafts_no_vision(client, ctx, runtime):
    """protects=with vision at Observe a strategy_draft run on the vision is 409 "Oracle
    drafts no vision at Observe", while the product strategy still drafts; fails_when=the
    vision run is made, or the strategy's is refused; no_claim=the run's prompt."""
    owner_h = ctx.as_("owner")
    await imported(client, owner_h, VISION, vision_md([belief("b1", "Teams plan weekly")]))
    await imported(client, owner_h, STRATEGY, strategy_md([choice("self-serve", goals=[])]))
    await set_level(client, owner_h, "vision", "observe")
    resp = await _strategy_run(client, owner_h, VISION, {"horizon_years": 5})
    assert resp.status_code == 409, resp.text
    assert "Oracle drafts no vision at Observe" in resp.text
    resp = await _strategy_run(client, owner_h, STRATEGY, SPAN)
    assert resp.status_code == 201, resp.text


async def test_at_observe_no_feedback_loop_rewrites_the_strategy(client, ctx, runtime):
    """protects=the feedback loop is Oracle drafting the next version too: on a strategy at
    Observe it is 409 with the same words; fails_when=a run is created; no_claim=the
    feedback loop at Draft (its own tests)."""
    owner_h = ctx.as_("owner")
    await imported(client, owner_h, STRATEGY, strategy_md([choice("self-serve", goals=[])]))
    await set_level(client, owner_h, "strategy", "observe")
    resp = await client.post(
        "/v1/runs", json={"flow": "feedback_loop", "document": STRATEGY}, headers=owner_h
    )
    assert resp.status_code == 409, resp.text
    assert "Oracle drafts no product strategy at Observe" in resp.text
    assert await _runs(ctx.tenant_id) == 0


@pytest.mark.parametrize(
    ("level", "present", "absent"),
    [("recommend", RECOMMEND_LINE, DRAFT_LINE), ("draft", DRAFT_LINE, RECOMMEND_LINE)],
)
async def test_the_strategy_level_reaches_the_prompt(client, ctx, runtime, level, present, absent):
    """protects=at Recommend (the default) the agents propose choices with the alternative
    weighed and a default, and at Draft they write only the choices the owner and the
    company's material name, recommending none; fails_when=the level's line is missing or
    the other level's is there; no_claim=the agents' compliance."""
    owner_h = ctx.as_("owner")
    await imported(client, owner_h, STRATEGY, strategy_md([choice("self-serve", goals=[])]))
    if level != "recommend":
        await set_level(client, owner_h, "strategy", level)
    resp = await _strategy_run(client, owner_h, STRATEGY, SPAN)
    assert resp.status_code == 201, resp.text
    run_id = resp.json()["id"]
    assert (await client.post(f"/v1/runs/{run_id}/estimate", headers=owner_h)).status_code == 200
    resp = await client.post(f"/v1/runs/{run_id}/start", headers=owner_h)
    assert resp.status_code == 200, resp.text
    prompt = runtime.submitted[0].steps[-1].prompt
    assert present in prompt
    assert absent not in prompt


async def test_a_vision_run_carries_no_strategy_line(client, ctx, runtime):
    """protects=the strategy's level speaks only to strategy drafts; fails_when=a vision
    run's prompt carries it; no_claim=the vision's own Draft (its brief test)."""
    owner_h = ctx.as_("owner")
    await imported(client, owner_h, VISION, vision_md([belief("b1", "Teams plan weekly")]))
    resp = await _strategy_run(client, owner_h, VISION, {"horizon_years": 5})
    run_id = resp.json()["id"]
    assert (await client.post(f"/v1/runs/{run_id}/estimate", headers=owner_h)).status_code == 200
    assert (await client.post(f"/v1/runs/{run_id}/start", headers=owner_h)).status_code == 200
    prompt = runtime.submitted[0].steps[-1].prompt
    assert RECOMMEND_LINE not in prompt and DRAFT_LINE not in prompt


# --- words for people outside: board and investor updates --------------------------------


async def test_at_observe_oracle_drafts_no_update(client, ctx, runtime):
    """protects=with external_messages at Observe an update_draft run is 409 "Oracle drafts
    no board or investor update at Observe", and so is the feedback loop on an update; the
    owner can still start the update from its template; fails_when=a run is created;
    no_claim=the update's own checks (test_updates)."""
    owner_h = ctx.as_("owner")
    await set_level(client, owner_h, "external_messages", "observe")
    slug = await started(client, ctx)
    for flow in ("update_draft", "feedback_loop"):
        resp = await client.post("/v1/runs", json={"flow": flow, "document": slug}, headers=owner_h)
        assert resp.status_code == 409, (flow, resp.text)
        assert "Oracle drafts no board or investor update at Observe" in resp.text
    assert await _runs(ctx.tenant_id) == 0


# --- words for people outside: the launch kit --------------------------------------------

KIT_WITH_INTERNAL = KIT.replace(
    "changelog:\n",
    'changelog:\n  - {{category: changed, audience: internal, title: "Card vault moved", '
    'body: "The vault runs in the new region."}}\n',
)


async def test_at_observe_the_launch_kit_drafts_internal_words_only(
    client,
    owner,  # noqa: F811
    runtime,
):
    """protects=with external_messages at Observe the kit run is told to draft internal
    texts only, and its import drafts only internal tasks, internal changelog entries and
    notes to members; release notes, in-app message, customer email, public entries and
    notes to people outside stay to do; fails_when=an external task is drafted or a
    public entry made; no_claim=the agent's compliance with the prompt."""
    tenant_id, auth = owner
    await set_level(client, auth, "external_messages", "observe")
    launch, url, member = await _ready(client, auth, runtime, tenant_id)
    resp = await client.post(
        f"{url}/notes",
        json={"display_name": "Ola at a customer", "asked": "Will it remember my card?"},
        headers=auth,
    )
    assert resp.status_code == 201, resp.text
    outside_note = resp.json()["id"]
    kit_text = KIT_WITH_INTERNAL.format(launch=launch["id"], member=member) + (
        f'  - {{requester_ref: "note:{outside_note}", body: "Your card is saved now."}}\n'
    )
    runtime.script["launch_kit"] = [Outcome(artifacts={"launch.yaml": kit_text})]
    await ticker_pass(tenant_id)
    got = (await client.get(url, headers=auth)).json()
    run = await _finish(client, auth, tenant_id, got["kit_run_id"])
    assert run["status"] == "succeeded", run
    prompt = runtime.submitted[-1].steps[-1].prompt
    assert "Oracle is set to Observe for words for people outside" in prompt

    got = (await client.get(url, headers=auth)).json()
    tasks = {t["key"]: t for t in got["tasks"]}
    for key in ("internal_announcement", "support_notes", "sales_briefing", "pre_mortem"):
        assert tasks[key]["status"] == "drafted", key
    for key in ("release_notes", "in_app_message", "customer_email", "changelog_entry"):
        assert tasks[key]["status"] == "todo" and tasks[key]["body"] is None, key
    entries = (await client.get("/v1/changelog", headers=auth)).json()
    assert [(e["title"], e["audience"]) for e in entries] == [("Card vault moved", "internal")]
    notes = {n["id"]: n for n in (await client.get(f"{url}/notes", headers=auth)).json()}
    assert notes[outside_note]["body"] is None
    assert [n["body"] for n in notes.values() if n["internal"]] == [
        "You asked whether buyers can keep their card: they can now."
    ]


async def test_at_draft_the_launch_kit_drafts_every_text(client, owner, runtime):  # noqa: F811
    """protects=Draft (the default) keeps H6's kit: external tasks and public entries are
    drafted and the prompt carries no Observe line; fails_when=the default loses a draft;
    no_claim=the full import (test_launch_kit)."""
    tenant_id, auth = owner
    launch, url, member = await _ready(client, auth, runtime, tenant_id)
    runtime.script["launch_kit"] = [
        Outcome(artifacts={"launch.yaml": KIT.format(launch=launch["id"], member=member)})
    ]
    await ticker_pass(tenant_id)
    got = (await client.get(url, headers=auth)).json()
    await _finish(client, auth, tenant_id, got["kit_run_id"])
    assert "words for people outside" not in runtime.submitted[-1].steps[-1].prompt
    tasks = {t["key"]: t for t in (await client.get(url, headers=auth)).json()["tasks"]}
    assert tasks["release_notes"]["status"] == "drafted"
    assert tasks["changelog_entry"]["status"] == "drafted"
