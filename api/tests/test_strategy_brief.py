"""H4 Strategy and vision, lane 3: the brief Company › Strategy's sheet sends with a
strategy_draft run (what changed since the last one, the horizon, whether to start from
the last approved version), checked on create and written into the agents' prompt."""

import pytest
from sqlalchemy import select

from oracle.runs.models import Run
from oracle.swarm import FakeRuntime, set_runtime
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.strategy_helpers import (
    STRATEGY,
    VISION,
    approved,
    belief,
    choice,
    imported,
    strategy_md,
    vision_md,
)


@pytest.fixture
async def ctx():
    return await make_ctx()


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


async def _create(client, headers, document: str, brief: dict, flow: str = "strategy_draft"):
    return await client.post(
        "/v1/runs",
        json={"flow": flow, "document": document, "knobs": {"depth": "standard"},
              "strategy_brief": brief},
        headers=headers,
    )  # fmt: skip


async def _strategy_v2(client, ctx) -> None:
    """A product strategy whose v1 is approved and v2 is a newer draft."""
    owner = ctx.as_("owner")
    await imported(client, owner, STRATEGY, strategy_md([choice("self-serve", goals=[])]))
    await approved(client, owner, STRATEGY, 1)
    await imported(
        client, owner, STRATEGY, strategy_md([choice("self-serve", goals=[])], summary="Newer.")
    )


async def test_a_strategy_brief_is_kept_and_reaches_the_prompt(client, ctx, runtime):
    """protects=what changed, the horizon dates and "start from the last approved version"
    reach the agents, naming the approved version (v1, not the newer v2); fails_when=the
    brief is dropped, or the prompt names the latest version; no_claim=what the agent
    writes."""
    await _strategy_v2(client, ctx)
    owner = ctx.as_("owner")
    resp = await _create(
        client,
        owner,
        STRATEGY,
        {
            "changed": "Team plans moved up after the pricing change.",
            "horizon_from": "2027-01-01",
            "horizon_to": "2027-12-31",
            "from_approved": True,
        },
    )
    assert resp.status_code == 201, resp.text
    run_id = resp.json()["id"]
    async with tenant_session(ctx.tenant_id) as s:
        run = await s.scalar(select(Run))
        assert run.knobs["strategy_brief"] == {
            "changed": "Team plans moved up after the pricing change.",
            "horizon_from": "2027-01-01",
            "horizon_to": "2027-12-31",
            "from_version": 1,
        }

    assert (await client.post(f"/v1/runs/{run_id}/estimate", headers=owner)).status_code == 200
    resp = await client.post(f"/v1/runs/{run_id}/start", headers=owner)
    assert resp.status_code == 200, resp.text
    prompt = runtime.submitted[0].steps[-1].prompt
    assert "Team plans moved up after the pricing change." in prompt
    assert "2027-01-01 to 2027-12-31" in prompt
    assert f"get_document_markdown(doc={STRATEGY}, version=1)" in prompt


async def test_a_vision_brief_takes_years_and_starts_from_the_latest(client, ctx, runtime):
    """protects=a vision's horizon in years, and no from_version without the box ticked;
    fails_when=years are refused for a vision, or an approved version is named anyway;
    no_claim=the strategy's dates (above)."""
    owner = ctx.as_("owner")
    await imported(client, owner, VISION, vision_md([belief("b1", "Teams plan weekly")]))
    await approved(client, owner, VISION, 1)
    resp = await _create(client, owner, VISION, {"horizon_years": 5})
    assert resp.status_code == 201, resp.text
    run_id = resp.json()["id"]
    assert (await client.post(f"/v1/runs/{run_id}/estimate", headers=owner)).status_code == 200
    resp = await client.post(f"/v1/runs/{run_id}/start", headers=owner)
    assert resp.status_code == 200, resp.text
    prompt = runtime.submitted[0].steps[-1].prompt
    assert "Horizon: 5 years" in prompt
    assert "version=1)" not in prompt


@pytest.mark.parametrize(
    ("slug", "brief", "message"),
    [
        (STRATEGY, {"horizon_years": 5}, "a product strategy's horizon is its dates"),
        (VISION, {"horizon_from": "2027-01-01", "horizon_to": "2027-12-31"},
         "a vision's horizon is in years"),
        (STRATEGY, {"horizon_from": "2027-12-31", "horizon_to": "2027-01-01"},
         "the horizon ends before it starts"),
        (STRATEGY, {"from_approved": True}, "the product strategy has no approved version"),
    ],
)  # fmt: skip
async def test_a_brief_that_does_not_fit_the_document_is_refused(client, ctx, slug, brief, message):
    """protects=the brief is checked against the document's kind and versions; fails_when=a
    vision gets dates, a strategy gets years, an inverted horizon or a start from a version
    that does not exist is accepted; no_claim=the sheet's own checks (Playwright)."""
    owner = ctx.as_("owner")
    markdown = (
        strategy_md([choice("self-serve", goals=[])])
        if slug == STRATEGY
        else vision_md([belief("b1", "Teams plan weekly")])
    )
    await imported(client, owner, slug, markdown)
    resp = await _create(client, owner, slug, brief)
    assert resp.status_code == 422, resp.text
    assert message in resp.text
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.scalar(select(Run)) is None


async def test_only_a_strategy_draft_run_takes_a_brief(client, ctx):
    """protects=the brief belongs to the strategy_draft flow; fails_when=another flow keeps
    one silently; no_claim=that flow's other inputs."""
    resp = await _create(
        client, ctx.as_("owner"), "checkout", {"changed": "x"}, flow="baseline_to_prd"
    )
    assert resp.status_code == 422, resp.text
    assert "only a Vision or strategy draft run takes a brief" in resp.text


async def test_the_flow_catalog_points_to_company_strategy(client, ctx):
    """protects=the New run dialog says where a vision or strategy draft starts (Company ›
    Strategy) and does not offer the flow itself; fails_when=the pointer is missing or the
    flow is in the dialog; no_claim=the page itself (Playwright)."""
    resp = await client.get("/v1/flows", headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text
    flow = {f["key"]: f for f in resp.json()["flows"]}["strategy_draft"]
    assert flow["in_new_run_dialog"] is False
    assert flow["starts_from"] == {
        "label": "Vision or strategy · Company › Strategy, New vision or Draft next version",
        "href": "/company/strategy",
    }
