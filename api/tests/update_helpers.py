"""Shared setup for the H8 Board and investor drafts tests: synthetic investor and board
update drafts, starting an update, a PRD with an active product track, and an
update_draft run driven by the FakeRuntime."""

from typing import Any

from oracle.swarm import Outcome
from tests.baseline_helpers import Ctx
from tests.fixtures import MARKDOWN, draft

PERIOD = "period: {from: 2026-10-01, to: 2026-10-31}"
PRD = "checkout-redesign"
INVESTOR_ASKS = "Owner to fill: what you need from investors this month (intros, hires, customers)."
BOARD_ASKS = "Owner to fill: the decisions you need from the board this meeting."


def investor_md(
    slug: str,
    *,
    period: str | None = PERIOD,
    highlights_first: bool = False,
    asks: str = INVESTOR_ASKS,
    product: str = "Guided setup shipped; bulk import is next.",
    metrics: str = "- Weekly active teams: 412, up 38 since September (target 600).",
    data_points: str = "- 412 weekly active teams, as of 2026-10-31 (c1)\n- 38 (c1)\n- 600 (c1)",
) -> str:
    """An investor update draft: metrics, asks, highlights, lowlights, product."""
    fm = [
        "---",
        f"document: {slug}",
        'title: "Investor update · October 2026"',
        "kind: update",
        "template: investor-update",
        "brief: [metrics, asks, highlights, lowlights, product]",
    ]
    if period:
        fm.append(period)
    fm.append("---")
    metrics_part = ["## Metrics {#metrics}", "", metrics, ""]
    highlights_part = ["## Highlights {#highlights}", "", "- Larkspur pilot went live.", ""]
    body = [
        "",
        "# Investor update · October 2026 {#title}",
        "",
        *(highlights_part + metrics_part if highlights_first else metrics_part),
        "## Asks {#asks}",
        "",
        asks,
        "",
        *([] if highlights_first else highlights_part),
        "## Lowlights {#lowlights}",
        "",
        "- Bulk import slipped a sprint.",
        "",
        "## Product recap {#product}",
        "",
        product,
        "",
        "# Full version {#full}",
        "",
        "## Sources and data points {#sources}",
        "",
        "### Data points {#sources-data}",
        "",
        data_points,
        "",
    ]
    return "\n".join(fm + body)


def board_md(
    slug: str,
    *,
    period: str | None = PERIOD,
    timeline_first: bool = False,
    timeline: str = "- Now: guided setup (beta).\n- Next: bulk import.\n- Later: SSO.",
) -> str:
    """A board update's product section: two slides of brief sections, then detail."""
    fm = [
        "---",
        f"document: {slug}",
        'title: "Board update · October 2026"',
        "kind: update",
        "template: board-product",
        "brief: [headline, goals, timeline, shipped, lowlights, asks]",
        "slides: [[headline, goals], [timeline, shipped, lowlights, asks]]",
    ]
    if period:
        fm.append(period)
    fm.append("---")
    goals = [
        "## Goals: where we are {#goals}",
        "",
        "| Goal | Target | Now | To go | Trend | Track |",
        "| --- | --- | --- | --- | --- | --- |",
        "| Weekly active teams | 600 | 412 | 188 | up | on track |",
        "",
    ]
    timeline_part = ["## Timeline {#timeline}", "", timeline, ""]
    body = [
        "",
        "# Board update · October 2026 {#title}",
        "",
        "## Product in one line {#headline}",
        "",
        "Activation is on track; bulk import slipped.",
        "",
        *(timeline_part + goals if timeline_first else goals + timeline_part),
        "## Shipped since last board {#shipped}",
        "",
        "- Guided setup.",
        "",
        "## What slipped or did not work {#lowlights}",
        "",
        "- Bulk import slipped a sprint.",
        "",
        "## Decisions we need from the board {#asks}",
        "",
        BOARD_ASKS,
        "",
        "# Full version {#full}",
        "",
        "## Predicted versus actual {#outcomes}",
        "",
        "Guided setup was predicted to lift activation.",
        "",
        "## Risks and blockers {#risks}",
        "",
        "None critical.",
        "",
        "## Decisions made {#decisions}",
        "",
        "None this period.",
        "",
        "## Sources and data points {#sources}",
        "",
        "### Data points {#sources-data}",
        "",
        "- 600, 412, 188 weekly active teams, as of 2026-10-31 (c1)",
        "",
    ]
    return "\n".join(fm + body)


async def import_md(client, headers, slug: str, markdown: str):
    return await client.post(
        f"/v1/documents/{slug}/versions",
        content=markdown.encode(),
        headers={**headers, **MARKDOWN},
    )


async def start_update(
    client, ctx: Ctx, template: str = "investor-update", who: str = "owner", **extra: Any
):
    title = "Board update · October 2026" if template == "board-product" else (
        "Investor update · October 2026"
    )  # fmt: skip
    return await client.post(
        "/v1/drafts",
        json={"kind": "update", "title": title, "template": template, **extra},
        headers=ctx.as_(who),
    )


async def started(client, ctx: Ctx, template: str = "investor-update", **extra: Any) -> str:
    resp = await start_update(client, ctx, template, **extra)
    assert resp.status_code == 201, resp.text
    return resp.json()["slug"]


async def prd_with_active_track(client, ctx: Ctx) -> str:
    """The checkout-redesign PRD, approved by the owner: its product track is active."""
    owner = ctx.as_("owner")
    resp = await import_md(client, owner, PRD, draft("prd_v1.md"))
    assert resp.status_code == 201, resp.text
    resp = await client.post(f"/v1/documents/{PRD}/versions/1/approve", headers=owner)
    assert resp.status_code == 200, resp.text
    return PRD


async def record_basis(client, ctx: Ctx, day: str, reference: str = "ENG-412", who="approver"):
    resp = await client.post(
        "/v1/schedule-bases",
        json={"kind": "estimate", "reference": reference, "supports_date": day, "prd": PRD},
        headers=ctx.as_(who),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def drafted_by_run(client, ctx: Ctx, runtime, slug: str, markdown: str) -> dict:
    """An update_draft run on ``slug`` whose agents hand back ``markdown``: created and
    started by the owner, ticked to its update_review checkpoint. Returns the run."""
    owner = ctx.as_("owner")
    runtime.script["update_draft"] = [Outcome(artifacts={"update.md": markdown})]
    resp = await client.post(
        "/v1/runs", json={"flow": "update_draft", "document": slug}, headers=owner
    )
    assert resp.status_code == 201, resp.text
    run = resp.json()
    est = await client.post(f"/v1/runs/{run['id']}/estimate", headers=owner)
    assert est.status_code == 200, est.text
    resp = await client.post(f"/v1/runs/{run['id']}/start", headers=owner)
    assert resp.status_code == 200, resp.text
    resp = await client.post("/v1/internal/tick", headers=ctx.as_("token"))
    assert resp.status_code == 200 and resp.json()["errors"] == [], resp.text
    resp = await client.get(f"/v1/runs/{run['id']}", headers=owner)
    assert resp.status_code == 200, resp.text
    return resp.json()
