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
    PLAN_TABLES,
    ROADMAP,
    ROADMAP_MD,
    approved_prd,
    built_roadmap,
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
