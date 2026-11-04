"""roadmap-plan-tables: every roadmap draft carries the plan tables approving it applies to
Simple (oracle.simple.approved_roadmap). (1) the roadmap draft's writer and critic are given
both tables, filled from the run's engineering dates (each item's end and its basis in
words, month first; the milestone ladder); (2) a draft that lacks either table, lists an
item the items file does not have, or gives another date is refused with a clear problem;
(3) a draft with them imports, and approving it applies its dates to Simple. Against
Postgres with the FakeRuntime. Invented data only.
"""

from datetime import date

from sqlalchemy import select

from oracle.docs.models import Document
from oracle.roadmap.models import RoadmapItem
from oracle.runs import plan_tables
from oracle.swarm import Outcome
from oracle.tenancy import tenant_session
from tests.test_roadmap import (  # noqa: F401 - fixtures
    ITEMS,
    PLAN_TABLES,
    ROADMAP,
    ROADMAP_MD,
    approved_prd,
    create,
    get,
    owner,
    runtime,
    seed_baseline,
    start,
    tick,
)

OFF = {"roadmap_items": False, "roadmap_review": False}
BASES = [
    {"kind": "estimate", "reference": "ENG-412", "supports_date": "2026-11-30"},
    {"kind": "capacity", "reference": "Team plan", "supports_date": "2027-01-15",
     "item_key": "shipping-step"},
]  # fmt: skip


async def _run(client, auth, tenant_id, runtime, markdown: str, checkpoints=OFF) -> dict:  # noqa: F811
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    runtime.script["roadmap_items"] = [Outcome(artifacts={"roadmap_items.yaml": ITEMS})]
    runtime.script["roadmap_draft"] = [Outcome(artifacts={"roadmap.md": markdown})]
    run = await start(client, auth, await create(client, auth, source="checkout-redesign",
                                                 knobs={"checkpoints": checkpoints}))  # fmt: skip
    await tick(client, auth)
    await tick(client, auth)
    return await get(client, auth, run["id"])


def _codes(run: dict) -> list[str]:
    return [p["code"] for p in run["segments"][1]["draft_import"].get("problems") or []]


# --------------------------------------------------------------------------- the plan


def test_the_engineering_plan_reads_the_items_file_and_the_verified_bases():
    plan = plan_tables.engineering_plan(ITEMS, BASES)
    pay, ship = plan.items
    assert (pay.key, pay.start, pay.end, pay.basis) == ("payment-step", None,
                                                        date(2026, 11, 30), "estimate")  # fmt: skip
    # A capacity plan scoped to the item: its place in the team's queue.
    assert (ship.key, ship.end, ship.basis) == ("shipping-step", date(2027, 1, 15), "team queue")
    beta, up_front = plan.milestones
    assert (beta.name, beta.date, beta.gates) == ("Beta", date(2026, 11, 30), ["Payment step"])
    assert (up_front.date, up_front.gates) == (None, ["Shipping step"])


def test_without_a_verified_basis_an_item_has_no_date():
    plan = plan_tables.engineering_plan(ITEMS, [])
    assert [(r.end, r.basis) for r in plan.items] == [(None, "no date yet")] * 2
    assert plan.milestones[0].date is None


def test_the_tables_read_month_first():
    lines = plan_tables.table_lines(plan_tables.engineering_plan(ITEMS, BASES))
    assert "| payment-step | Payment step |  | Nov 30, 2026 | estimate | planned |" in lines
    assert "| shipping-step | Shipping step |  | Jan 15, 2027 | team queue | planned |" in lines
    assert "| Beta | Nov 30, 2026 | Payment step |  |" in lines
    assert not any("2026-11-30" in line for line in lines)


def test_the_check_finds_each_problem():
    plan = plan_tables.engineering_plan(ITEMS, BASES[:1])
    today = date(2026, 11, 4)
    assert plan_tables.check(ROADMAP_MD, plan, today) == []
    bare = ROADMAP_MD.replace(PLAN_TABLES, "")
    assert [p.code for p in plan_tables.check(bare, plan, today)] == [
        "missing_plan_table", "missing_milestones_table"]  # fmt: skip
    extra = ROADMAP_MD.replace(
        "| shipping-step |", "| gift-cards | Gift cards |  |  | no date yet | planned |\n"
        "| shipping-step |")  # fmt: skip
    (p,) = plan_tables.check(extra, plan, today)
    assert p.code == "unknown_plan_item" and p.message.startswith("Gift cards is in the Plan")
    moved = ROADMAP_MD.replace("|  | Nov 30, 2026 | estimate", "|  | Dec 4, 2026 | estimate")
    (p,) = plan_tables.check(moved, plan, today)
    assert p.code == "plan_date_differs"
    assert p.message == (
        "Payment step's end is Nov 30, 2026 in the engineering dates, not Dec 4, 2026"
    )


# --------------------------------------------------------------------------- the run


async def test_the_writer_and_the_critic_are_given_the_tables(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    await _run(client, auth, tenant_id, runtime, ROADMAP_MD)
    writer, critic = runtime.submitted[1].steps
    row = "| payment-step | Payment step |  | Nov 30, 2026 | estimate | planned |"
    for step in (writer, critic):
        assert "--- plan tables ---" in step.prompt
        assert row in step.prompt
        assert "| Beta | Nov 30, 2026 | Payment step |  |" in step.prompt
    assert "not a warning" in critic.prompt and "not a warning" not in writer.prompt


async def test_a_draft_without_the_tables_is_refused(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    bare = ROADMAP_MD.replace(PLAN_TABLES, "")
    run = await _run(client, auth, tenant_id, runtime, bare, {"roadmap_items": False})
    # Refused, and waits at the review with the problems the writer must fix.
    assert run["status"] == "awaiting_checkpoint" and run["waiting_on"] == "roadmap_review"
    assert _codes(run) == ["missing_plan_table", "missing_milestones_table"]
    assert "has no Plan table" in run["segments"][1]["draft_import"]["error"]
    async with tenant_session(tenant_id) as s:
        assert await s.scalar(select(Document).where(Document.slug == ROADMAP)) is None


async def test_a_date_other_than_the_engineering_date_is_refused(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    moved = ROADMAP_MD.replace("| Beta | Nov 30, 2026 |", "| Beta | Dec 11, 2026 |")
    run = await _run(client, auth, tenant_id, runtime, moved)
    assert _codes(run) == ["plan_date_differs"]
    assert ("Milestone Beta is Nov 30, 2026 in the engineering dates, not Dec 11, 2026"
            in run["segments"][1]["draft_import"]["error"])  # fmt: skip


async def test_a_draft_with_the_tables_imports_and_applies(client, owner, runtime):  # noqa: F811
    """Approving the imported draft applies its dates."""
    tenant_id, auth = owner
    run = await _run(client, auth, tenant_id, runtime, ROADMAP_MD)
    assert run["status"] == "succeeded", run
    assert run["segments"][1]["draft_import"]["version"] == 1
    resp = await client.post(f"/v1/documents/{ROADMAP}/versions/1/approve", headers=auth)
    assert resp.status_code == 200, resp.text
    async with tenant_session(tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == ROADMAP))
        rows = {r.item_key: r for r in await s.scalars(
            select(RoadmapItem).where(RoadmapItem.roadmap_document_id == doc.id))}  # fmt: skip
    pay = rows["payment-step"]
    # The table's dates are the run's engineering dates, and approval applies them.
    assert (pay.end_date, pay.date_source, pay.date_basis) == (date(2026, 11, 30), "accepted",
                                                               "estimate")  # fmt: skip
    assert pay.applied["end"] == "2026-11-30"
    assert rows["shipping-step"].applied["end"] is None
