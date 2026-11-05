"""Train AN's review follow-ups: plan tables for an empty roadmap, the writer's words in
every flow, C6 titles of feature keys only, ParseBusy on the parse-once items check, and
one day-words helper. Invented data only.
"""

import datetime as dt

import pytest

from oracle import company_time, safe_yaml
from oracle.roadmap import doc_dates
from oracle.runs import flows, gate, plan_tables
from oracle.runs import roadmap as runs_roadmap
from tests.test_roadmap import ITEMS

TODAY = dt.date(2026, 11, 5)


# --- plan tables: an empty roadmap ----------------------------------------------------------


EMPTY_TABLES = """\
## Plan {#plan}

| Key | Item | Start | End | Dates from | Status |
|---|---|---|---|---|---|

## Milestones {#plan-milestones}

| Milestone | Date | Gates | Counts when |
|---|---|---|---|
"""


def test_an_empty_roadmap_gives_empty_tables_that_a_loop_draft_still_needs():
    plan = plan_tables.engineering_plan([], [], kept=[])
    assert plan.items == [] and plan.milestones == []
    assert plan_tables.check(EMPTY_TABLES, plan, TODAY, loop=True) == []
    codes = [p.code for p in plan_tables.check("# Roadmap\n\nNo tables.\n", plan, TODAY, loop=True)]
    assert codes == ["missing_plan_table", "missing_milestones_table"]
    brief = "\n".join(plan_tables.prompt_lines(plan, critic=False, loop=True))
    assert ITEMS_HEADER_LINE in brief and plan_tables.MILESTONES_HEADER in brief


ITEMS_HEADER_LINE = plan_tables.ITEMS_HEADER


# --- the writer's words match in every flow -------------------------------------------------


def _writer_prompt(flow_key: str, segment: str, kind: str) -> str:
    flow = flows.FLOWS[flow_key]
    ctx = flows.PromptContext(
        run_id="r1", document=None, snapshot_as_of=None, low_confidence=0.5, kind=kind
    )
    steps = flows.build_steps(flow, flow.segment(segment), flows.Knobs(), ctx)
    return next(prompt for _key, role, prompt, *_ in steps if role == "writer")


def test_a_prd_writer_is_worded_as_the_loop_writer_is():
    """The loop's writer reads "(writes the roadmap draft)"; a PRD's reads "(writes the PRD
    draft)", the kind's own name, never "prd" in lower case."""
    prompt = _writer_prompt("baseline_to_prd", "prd_draft", "prd")
    assert "(writes the PRD draft)" in prompt
    assert "writes the prd draft" not in prompt


# --- C6 titles: feature keys only -----------------------------------------------------------


def test_titled_names_feature_keys_and_leaves_other_words_alone():
    titles = {"bulk-edit": "Bulk address edit", "address-book": "Shared address book"}
    text = gate._titled("bulk-edit depends on address-book, a follow-up to req-12", titles)
    assert text == "Bulk address edit depends on Shared address book, a follow-up to req-12"


# --- ParseBusy on the parse-once items check ------------------------------------------------


async def test_a_busy_items_check_is_raised_and_not_kept(monkeypatch):
    """No worker for the check: ParseBusy reaches the caller (who retries on the next tick)
    and nothing is kept, so the next call checks the file."""
    text = ITEMS + "\n# busy once\n"
    real = safe_yaml.run_parse_within
    calls = []

    async def busy_once(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            raise safe_yaml.ParseBusy("parse_busy")
        return await real(*args, **kwargs)

    monkeypatch.setattr(safe_yaml, "run_parse_within", busy_once)
    with pytest.raises(safe_yaml.ParseBusy):
        await runs_roadmap.check_items_async(text)
    check = await runs_roadmap.check_items_async(text)
    assert len(calls) == 2
    assert [i["id"] for i in check.items][:1] == ["payment-step"]
    # Kept now: a third call reads the cache, not the pool.
    await runs_roadmap.check_items_async(text)
    assert len(calls) == 2


async def test_a_busy_check_for_a_person_with_parses_running_is_429(monkeypatch):
    async def busy(*args, **kwargs):
        raise safe_yaml.ParseBusy("parse_busy_you")

    monkeypatch.setattr(safe_yaml, "run_parse_within", busy)
    with pytest.raises(safe_yaml.ParseBusy) as caught:
        await runs_roadmap.check_items_async(ITEMS + "\n# busy you\n")
    assert caught.value.status == 429


# --- one day-words helper -------------------------------------------------------------------


def test_doc_dates_words_a_day_through_company_time():
    assert doc_dates.shown_day is company_time.calendar_day_with_year
    assert doc_dates.shown_day(dt.date(2026, 11, 30)) == "Nov 30, 2026"


# --- run_imported_into reads an index, not the whole audit table ----------------------------


async def test_run_imported_into_reads_its_index(db):  # noqa: F811
    """The lookup (oracle.docs.service.run_imported_into) has its own partial index on the
    import events, by run and document: no sequential scan of every audit event."""
    from sqlalchemy import text

    await db.execute(text("SET LOCAL enable_seqscan = off"))
    plan = "\n".join(
        await db.scalars(
            text(
                "EXPLAIN SELECT id FROM audit_events WHERE action = 'document.version_imported' "
                "AND data ->> 'document_id' = :doc AND data ->> 'run_id' = :run LIMIT 1"
            ),
            {
                "doc": "00000000-0000-0000-0000-00000000000d",
                "run": "00000000-0000-0000-0000-0000000000a1",
            },
        )
    )
    assert "ix_audit_events_version_imported" in plan, plan


# --- a send-back note answered point by point: every point addressed reads as done -----------

ALL_ADDRESSED = """resolutions:
  - id: note-1
    kind: note
    status: addressed
    note: Shortened the summary to three lines
  - id: note-2
    kind: note
    status: addressed
    note: Named who gets the first alert
"""


async def test_a_note_answered_in_full_says_so_and_names_no_declined_point(client):
    from tests.fixtures import draft, import_draft, seed_auth
    from tests.test_send_back_note_import import _with_resolutions

    _, auth = await seed_auth()
    resp = await import_draft(client, auth, _with_resolutions(draft("prd_v1.md"), ALL_ADDRESSED))
    assert resp.status_code == 201, resp.text
    [answered] = [w for w in resp.json()["warnings"] if w["code"] == "note_answered"]
    assert answered["message"] == (
        "the draft answers every point of the send-back note: 2 points, all addressed"
    )
    assert answered["refs"]["declined"] == []


async def test_a_note_with_a_declined_point_names_it(client):
    from tests.fixtures import draft, import_draft, seed_auth
    from tests.test_send_back_note_import import NOTE_ANSWERS, _with_resolutions

    _, auth = await seed_auth()
    resp = await import_draft(client, auth, _with_resolutions(draft("prd_v1.md"), NOTE_ANSWERS))
    [answered] = [w for w in resp.json()["warnings"] if w["code"] == "note_answered"]
    assert "(1 addressed, 1 declined)" in answered["message"]
    assert answered["refs"]["declined"] == ["note-2"]
