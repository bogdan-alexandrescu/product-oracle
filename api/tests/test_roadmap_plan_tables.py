"""roadmap-plan-tables: every roadmap draft carries the plan tables approving it applies to
Simple (oracle.simple.approved_roadmap). (1) the roadmap draft's writer and critic are given
both tables, filled from the run's engineering dates (each item's end and its basis in
words, month first; the milestone ladder); (2) a draft that lacks either table, lists an
item the items file does not have, or gives another date is refused with a clear problem;
(3) a draft with them imports, and approving it applies its dates to Simple. Against
Postgres with the FakeRuntime. Invented data only.
"""

from datetime import date, timedelta

import pytest
from sqlalchemy import select

from oracle.company_time import calendar_day_with_year
from oracle.docs.models import Document
from oracle.roadmap.models import RoadmapItem
from oracle.runs import plan_tables
from oracle.runs.roadmap import check_items
from oracle.simple import approved_roadmap
from oracle.swarm import Outcome
from oracle.templates.builtins import BUILTIN_TEMPLATES, builtin_body
from oracle.tenancy import tenant_session
from tests.test_roadmap import (  # noqa: F401 - fixtures
    ENG_412_DAY,
    ENG_412_ON,
    ENG_412_WORDS,
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
# The team plan's day for shipping-step: after ENG-412's, wherever the clock puts it (#1717).
SHIP_ON = ENG_412_ON + timedelta(days=46)
SHIP_WORDS = calendar_day_with_year(SHIP_ON)
# Days the tests move Payment step or Beta to, off ENG-412's.
MOVED_WORDS = calendar_day_with_year(ENG_412_ON + timedelta(days=4))
LATER_WORDS = calendar_day_with_year(ENG_412_ON + timedelta(days=11))
BASES = [
    {"kind": "estimate", "reference": "ENG-412", "supports_date": ENG_412_DAY},
    {"kind": "capacity", "reference": "Team plan", "supports_date": SHIP_ON.isoformat(),
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
    """The engineering plan takes each item's date and basis kind from items and bases."""
    plan = plan_tables.engineering_plan(check_items(ITEMS).items, BASES)
    pay, ship = plan.items
    assert (pay.key, pay.start, pay.end, pay.basis) == ("payment-step", None,
                                                        ENG_412_ON, "estimate")  # fmt: skip
    # A capacity plan scoped to the item: its place in the team's queue.
    assert (ship.key, ship.end, ship.basis) == ("shipping-step", SHIP_ON, "team queue")
    beta, up_front = plan.milestones
    assert (beta.name, beta.date, beta.gates) == ("Beta", ENG_412_ON, ["Payment step"])
    assert (up_front.date, up_front.gates) == (None, ["Shipping step"])


def test_without_a_verified_basis_an_item_has_no_date():
    """With no verified basis, every plan item and milestone shows no date yet."""
    plan = plan_tables.engineering_plan(check_items(ITEMS).items, [])
    assert [(r.end, r.basis) for r in plan.items] == [(None, "no date yet")] * 2
    assert plan.milestones[0].date is None


def test_the_tables_read_month_first():
    """The plan and milestones tables show every date month first, never ISO."""
    lines = plan_tables.table_lines(plan_tables.engineering_plan(check_items(ITEMS).items, BASES))
    assert f"| payment-step | Payment step |  | {ENG_412_WORDS} | estimate | planned |" in lines
    assert f"| shipping-step | Shipping step |  | {SHIP_WORDS} | team queue | planned |" in lines
    assert f"| Beta | {ENG_412_WORDS} | Payment step |  |" in lines
    assert not any(ENG_412_DAY in line for line in lines)


def test_the_check_finds_each_problem():
    """The plan check flags a missing table, an unknown item, and a disagreeing date."""
    plan = plan_tables.engineering_plan(check_items(ITEMS).items, BASES[:1])
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
    old = f"|  | {ENG_412_WORDS} | estimate"
    assert old in ROADMAP_MD
    moved = ROADMAP_MD.replace(old, f"|  | {MOVED_WORDS} | estimate")
    (p,) = plan_tables.check(moved, plan, today)
    assert p.code == "plan_date_differs"
    assert p.message == (
        f"Payment step's end is {ENG_412_WORDS} in the engineering dates, not {MOVED_WORDS}"
    )


def test_the_check_finds_an_item_missing_from_the_plan_table():
    """The plan check flags an item in roadmap_items.yaml missing from the Plan table."""
    plan = plan_tables.engineering_plan(check_items(ITEMS).items, BASES[:1])
    row = "| shipping-step | Shipping step |  |  | no date yet | planned |\n"
    short = ROADMAP_MD.replace(row, "")
    (p,) = plan_tables.check(short, plan, date(2026, 11, 4))
    assert p.code == "missing_plan_item" and p.refs == {"item": "shipping-step"}
    assert p.message.startswith("Shipping step is in roadmap_items.yaml but not in the Plan")


def test_the_check_reads_the_dates_from_words():
    """The plan check reads a basis word like Estimate from the table, case-blind."""
    plan = plan_tables.engineering_plan(check_items(ITEMS).items, BASES[:1])
    today = date(2026, 11, 4)
    old = f"| {ENG_412_WORDS} | estimate |"
    assert old in ROADMAP_MD
    said = ROADMAP_MD.replace(old, f"| {ENG_412_WORDS} | commitment |")
    (p,) = plan_tables.check(said, plan, today)
    assert p.code == "plan_basis_differs" and p.refs == {"item": "payment-step"}
    assert p.message == (
        "Payment step's end rests on estimate in the engineering dates, not commitment"
    )
    # The words are read as a person writes them.
    assert plan_tables.check(ROADMAP_MD.replace("| estimate |", "| Estimate |"), plan, today) == []


def test_a_later_milestones_table_with_gates_takes_the_place_of_one_without():
    """A timeline template's own Key milestones table (no Gates) gives way to the plan's;
    a plan's table is not taken over by a later one without Gates."""
    own = "| Milestone | Date | Kind |\n|---|---|---|\n| Kickoff | Oct 1, 2026 | estimate |\n"
    plan = "| Milestone | Date | Gates | Counts when |\n|---|---|---|---|\n| Beta | Nov 30, 2026 | Payment step |  |\n"  # noqa: E501
    for markdown in (own + "\n" + plan, plan + "\n" + own):
        got = approved_roadmap.parse(markdown, date(2026, 9, 1))
        assert [(m.name, m.date, m.gates) for m in got.milestones] == [
            ("Beta", date(2026, 11, 30), ["Payment step"])]  # fmt: skip


@pytest.mark.parametrize("t", [t for t in BUILTIN_TEMPLATES if t.kind == "roadmap"],
                         ids=lambda t: t.key)  # fmt: skip
def test_every_roadmap_template_has_the_plan_sections(t):
    """The stored roadmap templates name both plan sections, under Full version and before
    Sources and data points, as the writer's brief asks."""
    body = builtin_body(t)
    heads = (
        "# Full version {#full}",
        "## Plan {#plan}",
        "## Milestones {#plan-milestones}",
        "## Sources and data points",
    )
    at = [body.index(h) for h in heads]
    assert at == sorted(at)


# --------------------------------------------------------------------------- the run


async def test_the_writer_and_the_critic_are_given_the_tables(client, owner, runtime):  # noqa: F811
    """Both the roadmap writer and critic prompts carry the plan tables."""
    tenant_id, auth = owner
    await _run(client, auth, tenant_id, runtime, ROADMAP_MD)
    writer, critic = runtime.submitted[1].steps
    row = f"| payment-step | Payment step |  | {ENG_412_WORDS} | estimate | planned |"
    for step in (writer, critic):
        assert "--- plan tables ---" in step.prompt
        assert row in step.prompt
        assert f"| Beta | {ENG_412_WORDS} | Payment step |  |" in step.prompt
    assert "not a warning" in critic.prompt and "not a warning" not in writer.prompt


async def test_a_draft_without_the_tables_is_refused(client, owner, runtime):  # noqa: F811
    """A roadmap draft missing its Plan or Milestones table is refused, not stored."""
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
    """A milestone date that disagrees with the engineering plan's date is refused."""
    tenant_id, auth = owner
    old = f"| Beta | {ENG_412_WORDS} |"
    assert old in ROADMAP_MD
    moved = ROADMAP_MD.replace(old, f"| Beta | {LATER_WORDS} |")
    run = await _run(client, auth, tenant_id, runtime, moved)
    assert _codes(run) == ["plan_date_differs"]
    assert (f"Milestone Beta is {ENG_412_WORDS} in the engineering dates, not {LATER_WORDS}"
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
    assert (pay.end_date, pay.date_source, pay.date_basis) == (ENG_412_ON, "accepted",
                                                               "estimate")  # fmt: skip
    assert pay.applied["end"] == ENG_412_DAY
    assert rows["shipping-step"].applied["end"] is None
