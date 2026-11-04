"""roadmap-plan-tables for the feedback loop (the owner): every roadmap draft carries the plan
tables, the feedback loop's next draft of a roadmap too. Its writer is given both tables,
filled from the roadmap's latest items and the engineering dates (as for prd_to_roadmap),
and a draft that lacks them or gives other dates is refused with the same problems; a draft
with them imports. Against Postgres with the FakeRuntime. Invented data only.
"""

from sqlalchemy import select

from oracle.docs.models import Document, DocumentVersion
from oracle.swarm import Outcome
from oracle.tenancy import tenant_session
from tests.test_roadmap import (  # noqa: F401 - fixtures
    ITEMS,
    PLAN_TABLES,
    PRD,
    ROADMAP,
    ROADMAP_MD,
    approved_prd,
    built_roadmap,
    create,
    get,
    owner,
    runtime,
    start,
    tick,
)

LOOP = {
    "flow": "feedback_loop",
    "document": ROADMAP,
    "knobs": {"checkpoints": {"prd_review": False}},
}
NEXT_MD = ROADMAP_MD.replace("Make checkout predictable", "Make checkout predictable and quick")


async def _loop(client, auth, runtime, markdown: str | None) -> dict:  # noqa: F811
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    if markdown is not None:
        runtime.script["next_draft"] = [Outcome(artifacts={"roadmap.md": markdown})]
    resp = await client.post("/v1/runs", json=LOOP, headers=auth)
    assert resp.status_code in (200, 201), resp.text
    run = await start(client, auth, resp.json())
    await tick(client, auth)
    return await get(client, auth, run["id"])


def _codes(run: dict) -> list[str]:
    return [p["code"] for p in run["segments"][0]["draft_import"].get("problems") or []]


async def _versions(tenant_id) -> list[int]:
    async with tenant_session(tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == ROADMAP))
        return list(
            await s.scalars(
                select(DocumentVersion.number)
                .where(DocumentVersion.document_id == doc.id)
                .order_by(DocumentVersion.number)
            )
        )


async def test_the_loop_writer_is_given_the_roadmaps_plan_tables(client, owner, runtime):  # noqa: F811
    _, auth = owner
    await _loop(client, auth, runtime, NEXT_MD)
    prompt = runtime.submitted[-1].steps[-1].prompt
    assert "--- plan tables ---" in prompt
    # The roadmap's items with the PRD's engineering dates, month first.
    assert "| payment-step | Payment step |  | Nov 30, 2026 | estimate | planned |" in prompt
    assert "| shipping-step | Shipping step |  |  | no date yet | planned |" in prompt
    assert "| Beta | Nov 30, 2026 | Payment step |  |" in prompt
    assert "roadmap_items.yaml" not in prompt


async def test_a_loop_draft_without_the_plan_tables_is_refused(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    run = await _loop(client, auth, runtime, NEXT_MD.replace(PLAN_TABLES, ""))
    assert _codes(run) == ["missing_plan_table", "missing_milestones_table"]
    assert "has no Plan table" in run["segments"][0]["draft_import"]["error"]
    assert await _versions(tenant_id) == [1]


async def test_a_loop_draft_with_another_date_is_refused(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    moved = NEXT_MD.replace("| Beta | Nov 30, 2026 |", "| Beta | Dec 11, 2026 |")
    run = await _loop(client, auth, runtime, moved)
    assert _codes(run) == ["plan_date_differs"]
    assert await _versions(tenant_id) == [1]


async def test_a_loop_draft_missing_an_item_names_the_roadmap_not_a_file(client, owner, runtime):  # noqa: F811
    _, auth = owner
    short = NEXT_MD.replace("| shipping-step | Shipping step |  |  | no date yet | planned |\n", "")
    run = await _loop(client, auth, runtime, short)
    (problem,) = run["segments"][0]["draft_import"]["problems"]
    assert problem["code"] == "missing_plan_item"
    assert problem["message"].startswith("Shipping step is on the roadmap but not in the Plan")


async def test_a_loop_draft_with_the_plan_tables_is_imported(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    run = await _loop(client, auth, runtime, NEXT_MD)
    assert run["status"] == "succeeded", run
    assert run["segments"][0]["draft_import"]["version"] == 2
    assert await _versions(tenant_id) == [1, 2]


async def test_a_faked_loop_draft_copies_the_tables_and_is_imported(client, owner, runtime):  # noqa: F811
    """The fake runtime's default draft copies the brief's plan tables."""
    _, auth = owner
    run = await _loop(client, auth, runtime, None)
    assert run["segments"][0]["draft_import"]["version"] == 2, run


SHIPPED_ROW = "| shipping-step | Shipping step |  |  | no date yet | shipped |"
SHIPPED_MD = ROADMAP_MD.replace(
    "| shipping-step | Shipping step |  |  | no date yet | planned |", SHIPPED_ROW
)


async def _loop_after_shipped(client, auth, runtime, markdown: str | None) -> dict:  # noqa: F811
    """Version 1 marks Shipping step shipped and is approved (its plan applied: the item's
    plan_state is shipped); then a feedback-loop draft of the roadmap."""
    await approved_prd(client, auth)
    runtime.script["roadmap_items"] = [Outcome(artifacts={"roadmap_items.yaml": ITEMS})]
    runtime.script["roadmap_draft"] = [Outcome(artifacts={"roadmap.md": SHIPPED_MD})]
    off = {"roadmap_items": False, "roadmap_review": False}
    built = await start(
        client, auth, await create(client, auth, source=PRD, knobs={"checkpoints": off})
    )
    await tick(client, auth)
    await tick(client, auth)
    assert (await get(client, auth, built["id"]))["status"] == "succeeded"
    resp = await client.post(f"/v1/documents/{ROADMAP}/versions/1/approve", headers=auth)
    assert resp.status_code == 200, resp.text
    if markdown is not None:
        runtime.script["next_draft"] = [Outcome(artifacts={"roadmap.md": markdown})]
    resp = await client.post("/v1/runs", json=LOOP, headers=auth)
    assert resp.status_code in (200, 201), resp.text
    run = await start(client, auth, resp.json())
    await tick(client, auth)
    return await get(client, auth, run["id"])


async def test_a_loop_draft_keeping_a_shipped_row_is_imported(client, owner, runtime):  # noqa: F811
    """The review's major: an approved version marked a row shipped (carried forward as the
    item's plan_state); the loop draft keeps that row and is imported, not refused with
    'is in the Plan table but not on the roadmap'."""
    tenant_id, auth = owner
    next_md = SHIPPED_MD.replace("Make checkout predictable", "Make checkout predictable and quick")
    run = await _loop_after_shipped(client, auth, runtime, next_md)
    assert _codes(run) == [], run["segments"][0]["draft_import"]
    assert run["status"] == "succeeded", run
    assert await _versions(tenant_id) == [1, 2]


async def test_the_loop_brief_shows_a_shipped_row_with_its_status(client, owner, runtime):  # noqa: F811
    _, auth = owner
    run = await _loop_after_shipped(client, auth, runtime, None)
    prompt = runtime.submitted[-1].steps[-1].prompt
    assert SHIPPED_ROW in prompt
    assert "| payment-step | Payment step |  | Nov 30, 2026 | estimate | planned |" in prompt
    # The fake runtime's draft copies the brief's tables, the shipped row too: imported.
    assert run["segments"][0]["draft_import"]["version"] == 2, run


async def test_the_loop_writer_is_told_it_cannot_add_or_remove_items(client, owner, runtime):  # noqa: F811
    _, auth = owner
    await _loop(client, auth, runtime, NEXT_MD)
    prompt = runtime.submitted[-1].steps[-1].prompt
    assert "cannot add or remove roadmap items" in prompt
    assert "Simple's add-item flow" in prompt
    assert "writes the roadmap draft" in prompt
    assert "writes the prd draft" not in prompt
