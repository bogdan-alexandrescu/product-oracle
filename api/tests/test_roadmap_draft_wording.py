"""roadmap-draft-wording: a roadmap drafted from an approved PRD reads well on its own.

- every code is written with its name: a Goal column of bare goal codes ("G-B, G-C"), a
  "Depends on" line of feature codes or a decision cited by its code alone is sent back
  to the writer, and the renderer names an item's goal where the written cell has only
  codes;
- a date backed by an accepted engineering estimate is never called unverified in the
  writer's own words (Oracle marks the dates no verified basis backs);
- an end date that comes from the team's queue (team size, focus, milestone order) is
  said to be the item's place in that queue, with the item's own effort, never "its own
  engineering estimate";
- a dependency is read at the slice the estimate names.

Invented example data only.
"""

import html

from oracle.docs import draft_checks, named_codes
from oracle.docs.parser import parse_draft
from oracle.roadmap import draft_words, variants
from oracle.runs import flows, workflow

ROADMAP = """---
document: example-roadmap
title: Example roadmap
kind: roadmap
---
# Example roadmap {#roadmap}

## In brief {#brief-items}

| Horizon | Item | Goal | Outcome |
|---|---|---|---|
| Now | [Alert checks](#now-alert-checks) | G-B, G-C, G-A1 | Fewer missed alerts |

## Timeline {#timeline}

Each end date comes from that item's own engineering estimate.

- [Alert checks](#now-alert-checks) ends Nov 30, 2026 (date unverified).

## M2 Pilot {#m2}

Depends on: F-03, F-07. Held back per D-12.
"""

HEAD = "---\ndocument: example-roadmap\nkind: roadmap\n---\n"

CLEAN = """---
document: example-roadmap
title: Example roadmap
kind: roadmap
---
# Example roadmap {#roadmap}

## Timeline {#timeline}

An end date is the item's place in the team's queue (team size, focus and milestone
order), not how long the item takes.

- [Alert checks](#now-alert-checks) ends Feb 12, 2027: its place in the team's queue; its own
  effort is 1 week.

## M2 Pilot {#m2}

Depends on: F-03 Sensor feed, F-07 Alert rules. Held back per D-12 Ship alert-checks first.
"""


# --- Codes with their names ------------------------------------------------------------


def test_a_goal_column_of_bare_goal_codes_is_unnamed_not_a_list():
    found = named_codes.findings(
        "| Horizon | Item | Goal | Outcome |\n|---|---|---|---|\n"
        "| Now | [Alert checks](#now-alert-checks) | G-B, G-C, G-A1 | Fewer missed alerts |"
    )
    assert found.unnamed == ["G-B", "G-C", "G-A1"]
    assert found.runs == []


def test_lettered_goal_codes_with_their_names_pass():
    found = named_codes.findings("Serves G-B Faster setup and G-A1 (fewer missed alerts).")
    assert found.unnamed == [] and found.runs == []


def test_a_bare_depends_on_line_and_a_decision_code_are_found():
    found = named_codes.findings("Depends on: F-03, F-07. Held back per D-12.")
    assert found.unnamed == ["F-03", "F-07", "D-12"]


def test_a_run_roadmap_draft_is_checked_for_codes_and_date_words():
    draft = parse_draft(ROADMAP)
    codes = [w.code for w in draft_checks.run_warnings("roadmap", draft.sections)]
    assert codes == ["unnamed_code", "queue_said_as_estimate", "unverified_written"]
    assert [w.code for w in draft_checks.run_warnings("roadmap", parse_draft(CLEAN).sections)] == []
    # A PRD keeps its codes check alone.
    assert [w.code for w in draft_checks.run_warnings("prd", draft.sections)] == ["unnamed_code"]


def test_the_wording_warnings_send_the_draft_back_in_plain_words():
    assert set(draft_words.CODES) <= set(draft_checks.SENT_BACK)
    assert set(named_codes.CODES) <= set(draft_checks.SENT_BACK)
    trouble = workflow.code_name_trouble(["queue_said_as_estimate", "unverified_written"])
    assert "queue" in trouble and "unverified" in trouble
    assert "_" not in trouble


# --- The writer's date words -----------------------------------------------------------


def test_queue_dates_said_to_come_from_the_items_own_estimate_are_flagged():
    for text in (
        "Each end date comes from that item's own engineering estimate.",
        "The end dates come from each item's own estimate.",
        "Its end date is taken from the item's own engineering estimate.",
    ):
        warnings = draft_words.check(
            parse_draft(f"{HEAD}# R {{#r}}\n\n## T {{#t}}\n\n{text}\n").sections
        )
        assert [w.code for w in warnings] == ["queue_said_as_estimate"], text
        assert "place in the team's queue" in warnings[0].message
        assert "own effort" in warnings[0].message


def test_the_writer_never_marks_a_date_unverified_itself():
    for text in (
        "Ends Nov 30, 2026 (date unverified).",
        "Nov 30 [unverified]",
        "Unverified date: Nov 30",
    ):
        warnings = draft_words.check(
            parse_draft(f"{HEAD}# R {{#r}}\n\n## T {{#t}}\n\n{text}\n").sections
        )
        assert [w.code for w in warnings] == ["unverified_written"], text
        assert "accepted engineering estimate" in warnings[0].message
    # The Sources and data points section is not read.
    sources = (
        HEAD + "# R {#r}\n\n## Sources and data points {#sources}\n\nDate unverified in the PRD.\n"
    )
    assert draft_words.check(parse_draft(sources).sections) == []


# --- The renderer ----------------------------------------------------------------------


def _item(**kw) -> variants.ItemView:
    base = dict(key="alert-checks", title="Alert checks", outcome="Fewer missed alerts",
                horizon="now", position=0)  # fmt: skip
    return variants.ItemView(**{**base, **kw})


def _shown(*items: variants.ItemView) -> dict[str, list[variants.ItemView]]:
    out: dict[str, list[variants.ItemView]] = {h: [] for h in variants.HORIZON_SECTIONS}
    for i in items:
        out[i.horizon].append(i)
    return out


def test_a_written_goal_cell_of_bare_codes_renders_the_items_goal_by_name():
    item = _item(goals=["Faster setup"])
    written = (
        "| Horizon | Item | Goal | Outcome |\n|---|---|---|---|\n"
        "| Now | Alert checks | G-B, G-C, G-A1 | Fewer missed alerts |"
    )
    table = variants._table(written, _shown(item), variants.VARIANTS["engineering"],
                            {item.key: item}, {})  # fmt: skip
    assert "G-B" not in table
    assert "| Faster setup |" in table
    # A cell that names its goal is kept as written.
    named = written.replace("G-B, G-C, G-A1", "G-B Faster setup")
    table = variants._table(named, _shown(item), variants.VARIANTS["engineering"],
                            {item.key: item}, {})  # fmt: skip
    assert "| G-B Faster setup |" in table
    # One bare code keeps its place, with its goal's name.
    one = written.replace("G-B, G-C, G-A1", "G-B")
    table = variants._table(one, _shown(item), variants.VARIANTS["engineering"],
                            {item.key: item}, {})  # fmt: skip
    assert "| G-B Faster setup |" in table


def test_a_queue_date_reads_as_the_items_place_in_the_queue_with_its_own_effort():
    item = _item(
        milestone={"name": "Pilot", "date": "2027-02-12", "date_source": "cap-team"},
        date_kind="capacity",
        economics={"effort": "1 week"},
    )
    assert variants._milestone(item) == (
        "Pilot, ends Feb 12, 2027: its place in the team's queue; its own effort: 1 week"
    )
    # Without an effort it still says where the date comes from.
    item = _item(milestone={"name": "Pilot", "date": "2027-02-12"}, date_kind="capacity")
    assert variants._milestone(item) == "Pilot, ends Feb 12, 2027: its place in the team's queue"
    # An estimate's own date reads as before.
    item = _item(milestone={"name": "Pilot", "date": "2027-02-12"}, date_kind="estimate")
    assert variants._milestone(item) == "Pilot, Feb 12, 2027"


# --- The writer's prompt ---------------------------------------------------------------


def _roadmap_prompt(segment: str) -> str:
    flow = flows.FLOWS["prd_to_roadmap"]
    ctx = flows.PromptContext(run_id="run-1", document="example-roadmap", snapshot_as_of=None,
                              low_confidence=0.4, kind="roadmap")  # fmt: skip
    return flows.step_prompt(flow, flow.segment(segment), "writer" if segment ==
                             "roadmap_draft" else "analyst", last=True, ctx=ctx)  # fmt: skip


def test_the_roadmap_writer_is_told_the_wording_rules():
    text = _roadmap_prompt("roadmap_draft")
    assert flows.NAMED_CODES in text
    for words in (
        "G-B Faster setup, not G-B",
        "place in the team's queue",
        "own effort",
        "never write that a date is unverified",
        "slice the estimate names",
    ):
        assert words in text, words


def test_the_items_and_dates_prompts_read_a_dependency_at_its_slice():
    assert "slice the estimate names" in flows.ITEM_FIELDS
    assert "slice the estimate names" in _roadmap_prompt("roadmap_items")
    assert "kind capacity" in flows.ENG_DATES_TASK
    assert "team's queue" in flows.ENG_DATES_TASK


# --- The export reads the date's basis kind --------------------------------------------


async def test_an_export_says_a_capacity_date_is_the_items_place_in_the_queue(client):
    """protects=the Engineering rendering of an item dated by a capacity basis says its
    end date is its place in the team's queue, with its own effort; fails_when=the card
    reads the bare date as if the item took that long."""
    from datetime import UTC, date, datetime

    from sqlalchemy import select

    from oracle.docs.models import Document
    from oracle.roadmap.models import RoadmapItem, ScheduleBasis
    from oracle.tenancy import tenant_session
    from tests.baseline_helpers import make_ctx
    from tests.test_export_audience import EXPORT, _text, seed_roadmap

    ctx = await make_ctx("Example Labs")
    await seed_roadmap(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        prd = await s.scalar(select(Document).where(Document.slug == "example-labs-prd"))
        item = await s.scalar(select(RoadmapItem).where(RoadmapItem.item_key == "csv-parser"))
        item.prd_document_id = prd.id
        item.milestone = {"name": "Pilot", "date": "2027-02-12", "date_source": "cap-team"}
        s.add(
            ScheduleBasis(kind="capacity", reference="cap-team", supports_date=date(2027, 2, 12),
                          prd_document_id=prd.id, item_key="csv-parser", status="verified",
                          verified_at=datetime(2026, 10, 16, tzinfo=UTC))
        )  # fmt: skip
        await s.commit()
    resp = await client.get(
        EXPORT, params={"format": "html", "audience": "engineering"}, headers=ctx.as_("viewer")
    )
    assert resp.status_code == 200, resp.text
    assert (
        "Milestone: Pilot, ends Feb 12, 2027: its place in the team's queue; its own effort: 2"
        in html.unescape(_text(resp.text))
    )
