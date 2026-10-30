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
- test_review_who_marks_codes: protects=who has it comes from a section naming the people
  (personas, users), never from "User stories" or "Customer quotes" before it; a trailing
  "*" is a mark kept only with its "* note" or "\\* note"; a standard name (ISO-8601,
  RFC-3339) is not a code with no name; fails_when=a story is shown as who has it, a bare
  "*" stays, or a standard asks for a name; no_claim=the web's words.
- test_words_keyed_flow_on_a_bet_with_a_code: protects=a flow keyed by a bet's words is
  found when its line gets a code's name (the read and the flow's panel);
  fails_when=the bet loses its flow and offers "Draw the flow"; no_claim=the drawing.
- test_edit_starts_from_the_prds_words: protects=a line whose code got a name or whose mark
  was dropped carries the PRD's words (``words``) for the Edit box; fails_when=the box
  starts from the shown words; no_claim=the web's box (the Playwright spec).
- test_draw_the_flow_agrees_with_the_request: protects=whoever is offered "Draw the flow"
  may ask for it and no one else; fails_when=the link returns 403; no_claim=the drawing.
"""

# ruff: noqa: E501 - the fixture PRDs keep their long lines
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
    assert block(view, "bets")["lines"][2]["footnotes"] == [
        "† Sent once, two days after the invite."
    ]
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


async def test_problem_naming_no_one_is_asked_again(client, monkeypatch):
    # Only the who-check here: the job's quality checks (oracle.simple.quality) have their own
    # tests, and this answer's empty "Not doing" would fail them.
    monkeypatch.setattr(one_pager.quality, "one_pager", lambda *a, **k: [])
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
    assert "failed_checks" not in asked[0]
    assert any("names no one" in x for x in asked[1]["failed_checks"])
    view = await get(client, ctx, "owner", "team-invites")
    assert texts(view, "problem") == ["New admins stall in week one."]

    # Twice naming no one ("Administrators" is not "admins" to names_who).
    asked.clear()
    answers[1] = _answer("Administrators cannot onboard anyone.")
    async with tenant_session(ctx.tenant_id) as s:
        job = await s.scalar(select(LlmJob).where(LlmJob.kind == "one_pager"))
        out = await one_pager.run_job(s, job, ask)
    # Twice naming no one: built anyway (the page shows who has it beside the problem).
    assert out["built"] is True
    assert len(asked) == 2


def _sec(key: str, heading: str, body: str) -> Section:
    return Section(section_key=key, heading=heading, level=2, ordinal=1, body_md=body,
                   body_text=body, content_hash="x")  # fmt: skip


def test_pure_checks():
    users = _sec("users", "Who has it", "Admins of new teams with fewer than ten people.")
    assert checks.who_has_it([users]) == "Admins of new teams with fewer than ten people"
    assert checks.who_has_it([_sec("problem", "Problem and who has it", "Admins stall.")]) is None
    # A template's guidance names no one.
    skeleton = _sec("users", "Users", "<!-- Brief: who -->\n- <Milestone>: <Feature>\n- →")
    assert checks.who_has_it([skeleton]) is None
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
    assert [x.text for x in checks.numbers([head])] == [
        "“Later · 3 items” says 3 items, but it lists 2."
    ]


def test_review_who_marks_codes():
    stories = _sec(
        "stories",
        "User stories",
        "- As a team admin, I want to invite people in bulk so\n- As a new member, I want a reminder",
    )
    quotes = _sec("quotes", "Customer quotes", "- \u201cSetup took us a week\u201d")
    personas = _sec(
        "personas", "Personas", "- Workspace admins: set up alone\n- Team leads: invite later"
    )
    assert checks.who_has_it([stories, quotes, personas]) == "Workspace admins; Team leads"
    users = _sec("users", "Users", "- New admins: alone")
    assert checks.who_has_it([quotes, users]) == "New admins"
    # A personas section wins over a "customers" heading that comes first.
    customers = _sec("customers", "Customers", "- Small agencies")
    assert checks.who_has_it([customers, personas]) == "Workspace admins; Team leads"
    assert checks.who_has_it([stories]) is None
    # A trailing "*" is a mark: kept only with its note.
    assert checks.marked("Activation 40%*", {}) == ("Activation 40%", [])
    notes = checks.footnote_notes(
        [_sec("o", "Outcomes", "- Activation from 20% to 40%*\n\n\\* Counted weekly.")]
    )
    assert notes == {"*": "Counted weekly."}
    assert checks.marked("Activation 40%*", notes) == ("Activation 40%*", ["* Counted weekly."])
    lone = checks.footnote_notes([_sec("o", "Outcomes", "Activation 40%*\n\n* Counted weekly.")])
    assert lone == {"*": "Counted weekly."}
    # A list of "*" bullets is not a note.
    assert checks.footnote_notes([_sec("b", "Build", "* One\n* Two")]) == {}
    # Emphasis is not a mark.
    assert (
        checks.marked("An *easy* setup and **bold** words", {})[0]
        == "An *easy* setup and **bold** words"
    )
    # A standard's name is not a code to name.
    assert checks.with_names("Dates in ISO-8601 and RFC-3339; F-9 too", {}) == (
        "Dates in ISO-8601 and RFC-3339; F-9 too", ["F-9"])  # fmt: skip


async def test_words_keyed_flow_on_a_bet_with_a_code(client):
    import uuid

    from oracle.simple import visuals
    from tests.test_simple_visuals_api import run_visual_jobs

    ctx = await clear_world(client)
    view = await get(client, ctx, "owner", "team-invites")
    doc_id = uuid.UUID(view["document"]["id"])
    said = "F-26 for teams of any size"  # the bet's words before the code got its name
    old = visuals.words_subject(doc_id, said)
    async with tenant_session(ctx.tenant_id) as s:
        await visuals.request_visual(s, None, "one_pager_line", old, said, document_id=doc_id)
        await s.commit()
    await run_visual_jobs(ctx)
    for who in ("owner", "viewer"):
        bet = block(await get(client, ctx, who, "team-invites"), "bets")["lines"][0]
        assert bet["text"] == "F-26 Bulk invite for teams of any size", who
        assert bet["flow_subject"] == str(old) and bet["flow"] is not None, who
        assert bet["can_draw_flow"] is False, who
    r = await client.get(f"/v1/simple/visuals/one_pager_line/{old}",
                         params={"document_id": str(doc_id)}, headers=ctx.as_("viewer"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert r.json()["flow"]["version"] == 1


async def test_edit_starts_from_the_prds_words(client):
    ctx = await clear_world(client)
    view = await get(client, ctx, "owner", "team-invites")
    bets = block(view, "bets")["lines"]
    assert bets[0]["words"] == "F-26 for teams of any size"
    assert bets[1]["words"] == "A guided first project (P0)"
    outcomes = block(view, "outcomes")["lines"]
    assert outcomes[2]["words"] == "Weekly active teams from 1,000 to 1,500\u2021"
    # A line annotate leaves as it is has no other words.
    assert block(view, "bets")["lines"][2]["words"] is None


async def test_draw_the_flow_agrees_with_the_request(client):
    ctx = await clear_world(client)
    for who in ("owner", "approver", "commenter", "viewer"):
        view = await get(client, ctx, who, "faster-export")
        bet = block(view, "bets")["lines"][0]
        r = await client.post(f"/v1/simple/visuals/one_pager_line/{bet['flow_subject']}/request",
                              json={"document_id": view["document"]["id"]}, headers=ctx.as_(who))  # fmt: skip
        assert (r.status_code < 400) is bet["can_draw_flow"], (who, r.status_code, r.text)
