"""The one-pager reads clearly (the owner's pick, 2026-10-30): who has the problem, how each
outcome is measured, codes with names, footnote marks with their notes, numbers that add
up, and the flow prompt only for those who may ask for one. Against Postgres; invented PRDs.

Test cards (protects / fails_when / no_claim):

- test_who_measures_codes_and_marks: protects=the problem block names who has it from the
  PRD's users section; each outcome carries its measure and source (in the line, or from
  another section), else none; a code shows its name ("F-26 Bulk invite", "P0 top
  priority"); a † stays with its note, a ‡ with none is dropped; fails_when=a reader gets
  a bare code, a dagger with no note or an outcome with no measure the PRD states;
  no_claim=the web's words (the Playwright spec).
- test_needs_a_look_for_owners_only: protects=numbers that disagree (8 said, 6 listed;
  40 per region × 5 regions against 250) and a code with no name are a "Needs a look"
  list naming both numbers and where they are, for the PRD's owners only;
  fails_when=a viewer or commenter sees it, or it misses a disagreement; no_claim=wording
  beyond the numbers.
- test_without_users_or_measures: protects=a PRD with no users section and no measures
  says so (``who`` null, no measure) and has nothing to look at; fails_when=Oracle
  invents who or how; no_claim=the web's words.
- test_draw_the_flow_only_for_those_who_may: protects=a bet with no flow offers drawing
  (``can_draw_flow``) to those who change the PRD only; fails_when=a viewer or commenter
  is offered it; no_claim=the drawing.
- test_problem_naming_no_one_is_asked_again: protects=the job's answer whose problem names
  no one of the users section is asked again (with the reason), kept when the second
  names them, refused when it still does not; fails_when=a problem with no one in it is
  built; no_claim=the prompt.
- test_pure_checks: protects=the module's rules on their own; fails_when=a rule drifts.
"""

from sqlalchemy import select

from oracle.docs.models import Section
from oracle.jobs.models import LlmJob
from oracle.simple import one_pager
from oracle.simple import one_pager_checks as checks
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.test_simple_one_pager_api import (
    MD,
    block,
    clock,  # noqa: F401 - the autouse clock
    get,
)

CLEAR_PRD = """---
title: Team invites
---

## Problem {#problem}

Setup stalls in the first week and workspaces stay empty.

## Users and personas {#users}

- New workspace admins: set up the workspace alone
- Team leads: invite their people later

## What we will build {#build}

- F-26 for teams of any size
- A guided first project (P0)
- A reminder email for unanswered invites†

† Sent once, two days after the invite.

## Glossary {#glossary}

| Code | Name |
|---|---|
| F-26 | Bulk invite |
| F-31 | Invite link |

## Outcomes {#outcomes}

- Teams with a second member in week one from 40% to 60%, counted as workspaces with two active members by day 7 · from the product events table
- Invites accepted within two days from 25% to 45%
- Weekly active teams from 1,000 to 1,500‡

## Definitions {#definitions}

- Invites accepted within two days: counted as invites accepted within 48 hours of sending; source: the invite log

## Targets {#targets}

Each region adds 40 paid workspaces a month. We sell in 5 regions. Company-wide target: 250 paid workspaces a month.

## Not this quarter {#later}

Eight features wait for next quarter.

- Invite by QR code
- Invite from chat
- Team templates
- Seat limits
- Guest invites
- Invite analytics

## Risks {#risks}

- F-40 may slip
- Calendar access may scare admins away
"""

BARE_PRD = """---
title: Faster export
---

## Problem {#problem}

Exports take too long.

## What we will build {#build}

- A faster export
- An export queue
- An email when it is done

## Outcomes {#outcomes}

- Export time from 40s to 10s
- Exports finished from 80% to 95%
"""


async def clear_world(client):
    ctx = await make_ctx()
    for slug, md in (("team-invites", CLEAR_PRD), ("faster-export", BARE_PRD)):
        r = await client.post(f"/v1/documents/{slug}/versions", content=md.encode(),
                              headers=MD | ctx.as_("owner"))  # fmt: skip
        assert r.status_code in (200, 201), r.text
    return ctx


def texts(view: dict, key: str) -> list[str]:
    return [x["text"] for x in block(view, key)["lines"]]


async def test_who_measures_codes_and_marks(client):
    ctx = await clear_world(client)
    view = await get(client, ctx, "owner", "team-invites")
    assert block(view, "problem")["who"] == "New workspace admins; Team leads"
    bets = texts(view, "bets")
    assert bets[0] == "F-26 Bulk invite for teams of any size"
    assert bets[1] == "A guided first project (P0 top priority)"
    assert bets[2] == "A reminder email for unanswered invites†"
    assert block(view, "bets")["lines"][2]["footnotes"] == ["† Sent once, two days after the invite."]
    outcomes = block(view, "outcomes")["lines"]
    first, second, third = outcomes
    assert first["measure"] == "workspaces with two active members by day 7"
    assert first["measure_source"] == "the product events table"
    assert second["measure"] == "invites accepted within 48 hours of sending"
    assert second["measure_source"] == "the invite log"
    assert third["measure"] is None and third["measure_source"] is None
    assert "‡" not in third["text"] and "‡" not in third["metric"]["to"]
    assert third["footnotes"] == []
    # Everyone reads the same clear page.
    viewer = await get(client, ctx, "viewer", "team-invites")
    assert texts(viewer, "bets") == bets


async def test_needs_a_look_for_owners_only(client):
    ctx = await clear_world(client)
    view = await get(client, ctx, "owner", "team-invites")
    looks = view["needs_look"]
    said = {x["text"]: x for x in looks}
    assert "“Eight features wait for next” says 8, but “Not this quarter” shows 6 items." in said
    assert said["“Eight features wait for next” says 8, but “Not this quarter” shows 6 items."][
        "where"
    ] == ["Not this quarter"]
    per = next(x for x in looks if "per region" in x["text"])
    assert per["text"] == (
        "40 paid workspaces per region × 5 regions is 200, but the company-wide target says 250."
    )
    assert per["where"] == ["Targets"] and per["source_keys"] == ["targets"]
    code = next(x for x in looks if x["kind"] == "code")
    assert code["text"] == "F-40 has no name in the PRD." and code["where"] == ["Risks"]
    assert len(looks) == 3
    for who in ("viewer", "commenter", "approver"):
        assert (await get(client, ctx, who, "team-invites"))["needs_look"] == []


async def test_without_users_or_measures(client):
    ctx = await clear_world(client)
    view = await get(client, ctx, "owner", "faster-export")
    assert block(view, "problem")["who"] is None
    assert all(x["measure"] is None for x in block(view, "outcomes")["lines"])
    assert view["needs_look"] == []
    assert all(x["footnotes"] == [] for b in view["blocks"] for x in b["lines"])


async def test_draw_the_flow_only_for_those_who_may(client):
    ctx = await clear_world(client)
    for who, may in (("owner", True), ("approver", False), ("commenter", False), ("viewer", False)):
        view = await get(client, ctx, who, "faster-export")
        bets = block(view, "bets")["lines"]
        assert bets and all(x["flow"] is None for x in bets)
        assert [x["can_draw_flow"] for x in bets] == [may] * len(bets), who
        # Never on a line that is not a bet.
        assert not any(x["can_draw_flow"] for x in block(view, "outcomes")["lines"])


def _answer(problem: str) -> dict:
    return {"blocks": [
        {"key": "problem", "lines": [{"text": problem, "source_keys": ["problem", "users"]}]},
        {"key": "bets", "lines": [
            {"text": "Bulk invite", "source_keys": ["build"]},
            {"text": "A guided first project", "source_keys": ["build"]},
            {"text": "A reminder email", "source_keys": ["build"]},
        ]},
        {"key": "outcomes", "lines": [
            {"text": "Second member in week one", "source_keys": ["outcomes"]},
            {"text": "Invites accepted", "source_keys": ["outcomes"]},
        ]},
        {"key": "not_doing", "lines": []},
        {"key": "risks", "lines": [{"text": "F-40 may slip", "source_keys": ["risks"]}]},
    ]}  # fmt: skip


async def test_problem_naming_no_one_is_asked_again(client):
    ctx = await clear_world(client)
    await get(client, ctx, "owner", "team-invites")
    asked: list[dict] = []
    answers = [_answer("Setup stalls in the first week."), _answer("New admins stall in week one.")]

    async def ask(kind, payload):
        asked.append(payload)
        return answers[len(asked) - 1]

    async with tenant_session(ctx.tenant_id) as s:
        job = await s.scalar(select(LlmJob).where(LlmJob.kind == "one_pager"))
        assert (await one_pager.run_job(s, job, ask))["built"] is True
        await s.commit()
    assert len(asked) == 2
    assert asked[0]["who"] == "New workspace admins; Team leads"
    assert "retry" not in asked[0]
    assert "names no one" in asked[1]["retry"]
    view = await get(client, ctx, "owner", "team-invites")
    assert texts(view, "problem") == ["New admins stall in week one."]

    # Twice naming no one: the quick read stays.
    asked.clear()
    answers[1] = answers[0]
    async with tenant_session(ctx.tenant_id) as s:
        job = await s.scalar(select(LlmJob).where(LlmJob.kind == "one_pager"))
        out = await one_pager.run_job(s, job, ask)
    assert out["built"] is False and "names no one" in out["reason"]
    assert len(asked) == 2


def _sec(key: str, heading: str, body: str) -> Section:
    return Section(section_key=key, heading=heading, level=2, ordinal=1, body_md=body,
                   body_text=body, content_hash="x")  # fmt: skip


def test_pure_checks():
    users = _sec("users", "Who has it", "Admins of new teams with fewer than ten people.")
    assert checks.who_has_it([users]) == "Admins of new teams with fewer than ten people"
    assert checks.who_has_it([_sec("problem", "Problem and who has it", "Admins stall.")]) is None
    assert checks.names_who("Admins stall in setup", "Admins of new teams")
    assert not checks.names_who("Setup stalls", "Admins of new teams")
    names = checks.glossary([_sec("g", "Glossary", "- F-12: Spend alerts\n- F-13 (Usage digest)")])
    assert names == {"F-12": "Spend alerts", "F-13": "Usage digest"}
    assert checks.with_names("Ship F-12 first, then F-99", names) == (
        "Ship F-12 Spend alerts first, then F-99", ["F-99"])  # fmt: skip
    assert checks.with_names("F-12: Spend alerts", names)[0] == "F-12: Spend alerts"
    assert checks.marked("From 40% to 60%†", {}) == ("From 40% to 60%", [])
    table = _sec("m", "Measures", "| Metric | Definition | Source |\n|---|---|---|\n"
                 "| Export time | p95 seconds per export | the job log |")  # fmt: skip
    m = checks.measure_for("Export time from 40s to 10s", "Export time", checks.measures([table]))
    assert m is not None and (m.measure, m.source) == ("p95 seconds per export", "the job log")
    head = _sec("later", "Later · 3 items", "- a\n- b")
    assert [x.text for x in checks.numbers([head])] == ["“Later · 3 items” says 3 items, but it lists 2."]
