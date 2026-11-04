"""A past event's year-less date is no schedule date (production, Nov 4).

'Approve version' was refused with "1 date is not backed by a confirmed schedule: Oct 27,
2027" because a milestone's Counts when cell said "be#1358 closed on Oct 27": a past
event, written without a year, read as the next Oct 27. (1) A year-less date reported as
done ("closed on", "shipped on", "merged on", "since") in a sentence with no plan words
reads as its most recent past day, when that is within about 60 days before the version's
day, and is not a schedule date; "done", "opened", "started", "was ... on", a plan word or
a far past reading keep the usual reading and still warn; (2) Counts when, evidence and
sources columns (the whole header) and labelled sentences are not where a schedule is
written; (3) the plan tables' own date cells keep the usual reading, so a milestone date
with no basis still warns."""

from datetime import UTC, date, datetime

import pytest
from sqlalchemy import select, update

from oracle import company_time
from oracle.docs.models import Document, DocumentVersion
from oracle.tenancy import tenant_session
from tests.test_date_warnings_honest import ITEMS, VERSIONS, _date_warnings, _run_roadmap, flagged
from tests.test_roadmap import (  # noqa: F401 - fixtures
    PLAN_TABLES,
    ROADMAP,
    ROADMAP_MD,
    approved_prd,
    owner,
    runtime,
)
from tests.test_roadmap_doc_dates import with_line

DAY = date(2026, 11, 4)

# The milestones table as a run writes it, with the production cell.
CELL = "be#1358 closed on Oct 27"
MILESTONES = (
    "\n## Milestones {#plan-milestones}\n\n"
    "| Milestone | Date | Gates | Counts when |\n|---|---|---|---|\n"
    "| Holiday shop | Dec 15, 2026 | [Gift notes](#now-gift-notes) | @cell |\n"
)


def test_the_production_counts_when_cell_is_not_flagged():
    assert flagged(ITEMS + MILESTONES.replace("@cell", CELL), ref=DAY) == []


@pytest.mark.parametrize(
    "line",
    [
        "Gift wrap shipped on Oct 27.",
        "The checkout fix merged on Oct 30.",
        "Saved baskets have been live since Oct 2.",
        "The pilot rolled out on Oct 12.",
        "The courier contract closed Oct 20.",
    ],
)
def test_a_past_event_s_year_less_date_is_not_a_schedule_date(line):
    assert flagged(f"## Notes {{#notes}}\n\n{line}\n\n" + ITEMS, ref=DAY) == []


def test_a_future_claim_without_a_basis_still_warns():
    # The same day as a plan: read as the next Oct 27, with no basis.
    assert flagged("## Notes {#notes}\n\nGift wrap ships on Oct 27.\n\n" + ITEMS, ref=DAY) == [
        ("notes", "Oct 27")
    ]
    # A past word with a future written year is still a claim.
    assert flagged(
        "## Notes {#notes}\n\nGift wrap shipped on Oct 27, 2027.\n\n" + ITEMS, ref=DAY
    ) == [("notes", "Oct 27, 2027")]
    # "to be done on" is a plan, not a done thing.
    assert flagged(
        "## Notes {#notes}\n\nGift wrap is to be delivered on Oct 27.\n\n" + ITEMS, ref=DAY
    ) == [("notes", "Oct 27")]


@pytest.mark.parametrize(
    "cell", ["be#1358 closed on Oct 27", "Shop owners can reorder by Jan 9", "after Feb 2"]
)
def test_counts_when_evidence_and_sources_are_not_schedule_places(cell):
    assert flagged(ITEMS + MILESTONES.replace("@cell", cell), ref=DAY) == []
    evidence = (
        "\n## Proof {#proof}\n\n"
        "| Item | Evidence | Sources |\n|---|---|---|\n"
        f"| [Gift notes](#now-gift-notes) | {cell} | {cell} |\n\n"
        f"- Counts when: {cell}.\n- Evidence: {cell}.\n- Sources: {cell}.\n"
    )
    assert flagged(ITEMS + evidence, ref=DAY) == []


def test_a_future_milestone_date_without_a_basis_still_warns():
    body = ITEMS + MILESTONES.replace("@cell", CELL)
    assert flagged(body.replace("| Dec 15, 2026 |", "| Dec 10 |"), ref=DAY) == [
        ("plan-milestones", "Dec 10")
    ]
    # The plan table's own year-less date keeps the usual reading (the next Oct 27),
    # whatever words are in it.
    assert flagged(body.replace("| Dec 15, 2026 |", "| closed on Oct 27 |"), ref=DAY) == [
        ("plan-milestones", "Oct 27")
    ]


# A past reading counts only when it is recent (within about 60 days before the version's
# day) and the sentence reports a thing that happened, with no plan words around it.
@pytest.mark.parametrize(
    "line",
    [
        "Migration done on Dec 15.",
        "M2: done on Dec 15",
        "Done Dec 15",
        "Target: shipped on Dec 15",
        "Finished on Dec 15 at the latest.",
        "Delivered on Dec 15 is the plan.",
        "The launch was moved to go live on Dec 15.",
        "Release was rescheduled on Dec 15.",
        "Beta opened on Dec 1.",
        "Shipped on 15 December.",
        # Recent, but a plan or not clearly a report.
        "Target: shipped on Oct 27.",
        "Gift wrap shipped on Oct 27 at the latest.",
        "Gift wrap merged on Oct 27 is the plan.",
        "Gift wrap was moved to go live on Oct 27.",
        "Gift wrap was rescheduled on Oct 27.",
        "Gift wrap done on Oct 27.",
        "Beta opened on Oct 27.",
        "Work started on Oct 27.",
        "Work began on Oct 27.",
        # "fixed" is set, not done.
        "The launch is fixed on Nov 1.",
        "The launch date was fixed on Oct 30.",
        # A report, but far back: the next Oct 2 is the reading.
        "Gift wrap shipped on Aug 2.",
    ],
)
def test_a_far_or_planned_past_reading_still_warns(line):
    found = flagged(f"## Notes {{#notes}}\n\n{line}\n", bases=[], ref=DAY)
    assert len(found) == 1 and found[0][0] == "notes", found


@pytest.mark.parametrize(
    "table",
    [
        "| Milestone | Notes |\n|---|---|\n| Holiday shop | done on Dec 15 |",
        "| ETA |\n|---|\n| done on Dec 15 |",
        "| When |\n|---|\n| done on Dec 15 |",
        "| When |\n|---|\n| shipped on Dec 15 |",
    ],
)
def test_a_far_past_reading_in_a_table_still_warns(table):
    assert flagged(f"## Notes {{#notes}}\n\n{table}\n", bases=[], ref=DAY) == [("notes", "Dec 15")]


@pytest.mark.parametrize("header", ["Proof due", "Sources & dates"])
def test_only_a_whole_evidence_header_is_not_a_schedule_place(header):
    table = f"| Item | {header} |\n|---|---|\n| [Gift notes](#now-gift-notes) | Dec 10 |"
    assert flagged(f"## Notes {{#notes}}\n\n{table}\n\n" + ITEMS, ref=DAY) == [("notes", "Dec 10")]


def test_a_label_skips_only_its_own_sentence():
    line = "Evidence: be#1358 closed on Oct 27. Gift notes ship on Dec 10."
    assert flagged(f"## Notes {{#notes}}\n\n{line}\n\n" + ITEMS, ref=DAY) == [("notes", "Dec 10")]
    line = "Counts when: shop owners can reorder by Jan 9.\nGift notes ship on Dec 10."
    assert flagged(f"## Notes {{#notes}}\n\n{line}\n\n" + ITEMS, ref=DAY) == [("notes", "Dec 10")]
    # A ';' ends the labelled part too.
    line = "Evidence: issue closed; launch on Dec 20."
    assert flagged(f"## Notes {{#notes}}\n\n{line}\n", bases=[], ref=DAY) == [("notes", "Dec 20")]


def test_an_evidence_place_still_warns_on_a_full_future_date():
    # Only a past event's day is skipped there: a written future day is a claim.
    table = "| Item | Evidence |\n|---|---|\n| [Gift notes](#now-gift-notes) | ships Dec 20, 2026 |"
    assert flagged(f"## Notes {{#notes}}\n\n{table}\n", bases=[], ref=DAY) == [
        ("notes", "Dec 20, 2026")
    ]
    line = "Evidence: gift notes ship Dec 20, 2026."
    assert flagged(f"## Notes {{#notes}}\n\n{line}\n", bases=[], ref=DAY) == [
        ("notes", "Dec 20, 2026")
    ]
    # A past written day there is still no schedule date.
    table = (
        "| Item | Evidence |\n|---|---|\n| [Gift notes](#now-gift-notes) | closed Oct 27, 2026 |"
    )
    assert flagged(f"## Notes {{#notes}}\n\n{table}\n", bases=[], ref=DAY) == []


@pytest.mark.parametrize(
    "header",
    ["Start date", "Target date", "Delivery date", "ETA", "When", "Planned date", "Deadline"],
)
def test_a_named_date_column_keeps_the_usual_reading(header):
    table = f"| Milestone | {header} |\n|---|---|\n| Holiday shop | closed on Oct 27 |"
    assert flagged(f"## Notes {{#notes}}\n\n{table}\n\n" + ITEMS, ref=DAY) == [("notes", "Oct 27")]


# --------------------------------------------------------------------------- the approval

# The approval tests read year-less dates against the version's day: the clock and the
# stored version's created_at are pinned to DAY (noon Pacific), so they pass on any day.
PINNED = datetime(2026, 11, 4, 20, 0, tzinfo=UTC)


@pytest.fixture
def pinned(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: PINNED)


async def _run_pinned(client, auth, tenant_id, runtime, markdown: str) -> dict:  # noqa: F811
    """The run's roadmap version, made on DAY."""
    await _run_roadmap(client, auth, runtime, markdown)
    async with tenant_session(tenant_id) as s:
        document = await s.scalar(select(Document).where(Document.slug == ROADMAP))
        await s.execute(
            update(DocumentVersion)
            .where(DocumentVersion.document_id == document.id)
            .values(created_at=PINNED)
        )
        await s.commit()
    assert company_time.day(PINNED) == DAY
    return (await client.get(f"{VERSIONS}/1", headers=auth)).json()


@pytest.mark.usefixtures("pinned")
async def test_the_production_cell_passes_approval(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    await approved_prd(client, auth)
    beta = "| Beta | Nov 30, 2026 | Payment step |  |"
    assert beta in PLAN_TABLES
    md = ROADMAP_MD.replace(beta, f"| Beta | Nov 30, 2026 | Payment step | {CELL} |")
    version = await _run_pinned(client, auth, tenant_id, runtime, md)
    assert _date_warnings(version) == []
    resp = await client.post(f"{VERSIONS}/1/approve", headers=auth)
    assert resp.status_code == 200, resp.text


@pytest.mark.usefixtures("pinned")
async def test_a_future_milestone_date_without_a_basis_blocks_approval(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    await approved_prd(client, auth)
    beta = "| Beta | Nov 30, 2026 | Payment step |  |"
    md = ROADMAP_MD.replace(beta, f"| Beta | Nov 30, 2026 | Payment step | {CELL} |")
    # The plan tables must give the engineering dates: the unbacked one is in prose.
    md = with_line("The holiday milestone lands on Dec 10.", "summary", md)
    version = await _run_pinned(client, auth, tenant_id, runtime, md)
    assert len(_date_warnings(version)) == 1
    resp = await client.post(f"{VERSIONS}/1/approve", headers=auth)
    assert resp.status_code == 409, resp.text
    assert "not backed by a confirmed schedule: Dec 10, 2026" in resp.json()["detail"]


@pytest.mark.usefixtures("pinned")
async def test_a_far_past_reading_blocks_approval(client, owner, runtime):  # noqa: F811
    # "done on Dec 10" in a Nov 4 version: Dec 10, 2025 is 11 months back, so it is the
    # next Dec 10, with no basis.
    tenant_id, auth = owner
    await approved_prd(client, auth)
    md = with_line("M2: done on Dec 10.", "summary", ROADMAP_MD)
    version = await _run_pinned(client, auth, tenant_id, runtime, md)
    assert len(_date_warnings(version)) == 1
    resp = await client.post(f"{VERSIONS}/1/approve", headers=auth)
    assert resp.status_code == 409, resp.text
    assert "not backed by a confirmed schedule: Dec 10, 2026" in resp.json()["detail"]
