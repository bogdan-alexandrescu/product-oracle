"""A past event's year-less date is no schedule date (production, Nov 4).

'Approve version' was refused with "1 date is not backed by a confirmed schedule: Oct 27,
2027" because a milestone's Counts when cell said "be#1358 closed on Oct 27": a past
event, written without a year, read as the next Oct 27. (1) A year-less date after a
past-tense or done word ("closed on", "shipped on", "merged on", "since", "was ... on")
reads as its most recent past day and is not a schedule date; (2) Counts when, evidence
and sources prose is not where a schedule is written; (3) the plan tables' own date
cells keep the usual reading, so a milestone date with no basis still warns."""

from datetime import date

import pytest

from tests.test_date_warnings_honest import ITEMS, VERSIONS, _date_warnings, _run_roadmap, flagged
from tests.test_roadmap import (  # noqa: F401 - fixtures
    PLAN_TABLES,
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
        "The pilot was rolled out to five shops on Oct 12.",
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


# --------------------------------------------------------------------------- the approval


async def test_the_production_cell_passes_approval(client, owner, runtime):  # noqa: F811
    _, auth = owner
    await approved_prd(client, auth)
    beta = "| Beta | Nov 30, 2026 | Payment step |  |"
    assert beta in PLAN_TABLES
    md = ROADMAP_MD.replace(beta, f"| Beta | Nov 30, 2026 | Payment step | {CELL} |")
    version = await _run_roadmap(client, auth, runtime, md)
    assert _date_warnings(version) == []
    resp = await client.post(f"{VERSIONS}/1/approve", headers=auth)
    assert resp.status_code == 200, resp.text


async def test_a_future_milestone_date_without_a_basis_blocks_approval(client, owner, runtime):  # noqa: F811
    _, auth = owner
    await approved_prd(client, auth)
    beta = "| Beta | Nov 30, 2026 | Payment step |  |"
    md = ROADMAP_MD.replace(beta, f"| Beta | Nov 30, 2026 | Payment step | {CELL} |")
    # The plan tables must give the engineering dates: the unbacked one is in prose.
    md = with_line("The holiday milestone lands on Dec 10.", "summary", md)
    version = await _run_roadmap(client, auth, runtime, md)
    assert len(_date_warnings(version)) == 1
    resp = await client.post(f"{VERSIONS}/1/approve", headers=auth)
    assert resp.status_code == 409, resp.text
    assert "not backed by a confirmed schedule: Dec 10, 2026" in resp.json()["detail"]
