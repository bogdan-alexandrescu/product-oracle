"""Quality checks on what Oracle generates before people see it (oracle.simple.quality):
the ``one_pager``, ``goal_suggestions`` and ``item_draft`` jobs check every answer, ask once
more with the failures named, and store a twice-failed answer with its failures (owners
read a "Needs a look" note; people below owner the last good version, or nothing new).
Against Postgres, with fixture model answers (fakes of ``ask``, never a model).

Test cards (protects / fails_when / no_claim):

- test_one_pager_checks_name_each_failure: protects=each failure kind of a one-pager
  answer is named in plain words (a block neither filled nor marked "Not in the PRD yet",
  fewer than 3 or more than 5 bets, a line linking no section of its block or not drawing
  on the one it links, an empty bullet, TBD, lorem ipsum, "As an AI", unfilled {braces},
  markdown left over) and a good answer (a block marked "Not in the PRD yet" too) has
  none; fails_when=a failure kind passes or a good answer fails; no_claim=the model's
  wording.
- test_good_one_pager_is_built_at_once: protects=a good answer is asked once and stored
  with no checks; owners read no note; fails_when=a good answer is asked again or noted;
  no_claim=the prompt.
- test_one_pager_fails_then_passes: protects=a failing answer is asked once more with its
  failures named (``failed_checks``) and the passing second answer is what everyone
  reads, with no note; fails_when=the first answer is stored, no second ask, or the
  failures are not named; no_claim=the model fixing them.
- test_one_pager_fails_twice: protects=an answer failing twice is stored with its failed
  checks: owners read it with "Needs a look" naming them, a commenter and a viewer read
  the last good version (the quick read) with no note; fails_when=the bad page reaches
  people below owner, or owners get no note; no_claim=the web's note (its spec).
- test_a_block_the_prd_has_is_never_marked_missing: protects=a block marked "Not in the
  PRD yet" ({"missing": true} or the one line) passes only when nothing of the PRD maps to
  it; marking a block the PRD has fails "empty_block", a marked bets block still fails the
  3 to 5 bets check, and clean_answer keeps its strict lines guard for such a block (a
  block with nothing mapped is stored marked); fails_when=an answer marking every block
  passes or is built; no_claim=which sections map to a block.
- test_a_prd_quote_is_not_chatter_or_tbd: protects=a line quoting its own section's words
  ("I can't find…", "TODO lists") is not flagged as chatter or TBD; words its section
  does not hold still are; fails_when=a PRD quote fails the checks or chatter passes;
  no_claim=quotes in suggestions.
- test_an_all_missing_answer_never_blanks_the_page: protects=a model answering every
  block "missing" twice leaves people below owner the quick read, never a blank page;
  fails_when=it is asked once or a reader's blocks go empty; no_claim=the owner's held
  view.
- test_a_held_run_keeps_the_last_good_built_at: protects=a held run leaves the last good
  page's built_at as it was; fails_when=it moves; no_claim=job bookkeeping.
- test_an_owner_editing_a_held_line_is_told_why: protects=an owner editing a line of a
  held page reads why it is refused (the last good line is what edits act on) with that
  line; fails_when=they read only "This line changed since you read it"; no_claim=the
  owner's pick of what such an edit should act on (open question).
- test_a_held_suggestion_does_not_refuse_a_commenter_s_title: protects=a commenter's
  suggestion titled like a held (owner-only) one is filed; an owner, who reads the held
  one, is refused; fails_when=a commenter is refused for a row they cannot see;
  no_claim=duplicate merging.
- test_suggestion_checks_name_each_failure: protects=a suggestion not naming its goal, a
  duplicate of a roadmap item or a feature (the "Looks like" matcher), a title too long
  for one line and chatter are each named; a good one passes; fails_when=a kind passes;
  no_claim=fuzzy matching beyond titles.
- test_suggestions_fail_then_pass: protects=failing suggestions are asked once more with
  the failures named; the passing second answer is stored with no checks and everyone
  reads it; fails_when=the first answer is stored or no second ask; no_claim=the model.
- test_suggestions_fail_twice: protects=suggestions failing twice are stored with their
  checks: owners read them with ``needs_look``, people below owner do not see them,
  passing ones are read by all; fails_when=a failed suggestion reaches a commenter or an
  owner gets no note; no_claim=the web's note.
- test_item_draft_fails_then_passes_or_twice: protects=an added item's draft that fails
  (chatter in its outcome, its goal not named) is asked once more; passing, it fills the
  item; failing twice, nothing of it is written (nothing new) and the job names the
  checks; fails_when=chatter reaches the item; no_claim=dates and dependencies (the
  additions tests).
"""

import uuid
from datetime import timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from oracle import company_time
from oracle.jobs.models import LlmJob
from oracle.roadmap.models import RoadmapItem
from oracle.simple import additions, one_pager, quality, service
from oracle.simple.models import SimpleGoalSuggestion, SimpleOnePager
from oracle.tenancy import tenant_session
from tests.test_simple_additions_api import SUGGESTIONS, World
from tests.test_simple_additions_api import clock as additions_clock  # noqa: F401
from tests.test_simple_one_pager_api import block, edit, get, world
from tests.test_simple_one_pager_api import clock as one_pager_clock  # noqa: F401


def good() -> dict:
    return {"blocks": [
        {"key": "problem", "lines": [{"text": "New admins stall during setup.",
                                      "source_keys": ["problem", "who"]}]},
        {"key": "bets", "lines": [
            {"text": "A setup checklist", "source_keys": ["build"]},
            {"text": "Invite suggestions from the calendar", "source_keys": ["build"]},
            {"text": "A sample project on day one", "source_keys": ["build"]},
        ]},
        {"key": "outcomes", "lines": [
            {"text": "Teammates invited in week one", "source_keys": ["outcomes"],
             "metric": {"name": "Invited in week one", "from": "48%", "to": "65%"}},
            {"text": "Setup finished in a day", "source_keys": ["outcomes"],
             "metric": {"name": "Setup in a day", "from": "30%", "to": "50%"}},
        ]},
        {"key": "not_doing", "lines": [{"text": "Single sign-on", "source_keys": ["not-doing"]}]},
        {"key": "risks", "lines": [{"text": "Calendar access may scare admins",
                                    "source_keys": ["risks"]}]},
    ]}  # fmt: skip


def bad() -> dict:
    a = good()
    a["blocks"][1]["lines"] = a["blocks"][1]["lines"][:2]
    a["blocks"][4]["lines"] = [
        {"text": "As an AI, I think risks are TBD", "source_keys": ["risks"]}
    ]
    return a


def _sec(key: str, heading: str, body: str) -> SimpleNamespace:
    return SimpleNamespace(section_key=key, heading=heading, body_text=body, body_md=body)


MAPPED = {
    "problem": [
        _sec("problem", "Problem", "New workspace admins stall during setup."),
        _sec("who", "Who has it", "Admins of new teams."),
    ],
    "bets": [
        _sec(
            "build",
            "What we will build",
            "A setup checklist. Invite suggestions. A sample project.",
        )
    ],  # fmt: skip
    "outcomes": [
        _sec(
            "outcomes",
            "Outcomes",
            "Teammate invited in week one from 48% to 65%. "
            "Setup finished in a day from 30% to 50%.",
        )
    ],  # fmt: skip
    "not_doing": [_sec("not-doing", "Not doing", "Single sign-on setup.")],
    "risks": [_sec("risks", "Risks", "Calendar access may scare admins away.")],
}


def _checks(edit) -> list[dict]:
    a = good()
    edit(a["blocks"])
    return quality.one_pager(a, one_pager.FALLBACK, MAPPED)


def _bets(b, text):
    b[1]["lines"][0]["text"] = text


@pytest.mark.parametrize(
    ("edit", "check", "say"),
    [
        (lambda b: b[3].update(lines=[]), "empty_block",
         "“Not doing” is empty and not marked “Not in the PRD yet”"),
        (lambda b: b[1].update(lines=b[1]["lines"][:2]), "bets", "2 bets; a one-pager has 3 to 5"),
        (lambda b: b[1]["lines"].extend([dict(b[1]["lines"][0])] * 3), "bets",
         "6 bets; a one-pager has 3 to 5"),
        (lambda b: b[1]["lines"][0].update(source_keys=["risks"]), "unsourced",
         "A line in “What we will build” links no section of it"),
        (lambda b: b[1]["lines"][0].update(source_keys=[]), "unsourced",
         "A line in “What we will build” links no section of it"),
        (lambda b: _bets(b, "Quarterly revenue dashboard"), "unsourced",
         "“Quarterly revenue dashboard” does not draw on the section it links"),
        (lambda b: _bets(b, " - "), "empty", "A line in “What we will build” is empty"),
        (lambda b: _bets(b, "A setup checklist (TBD)"), "tbd",
         "A line in “What we will build” says “TBD”"),
        (lambda b: _bets(b, "A setup checklist lorem ipsum"), "lorem",
         "A line in “What we will build” holds placeholder text (lorem ipsum)"),
        (lambda b: _bets(b, "As an AI, I would build a setup checklist"), "chatter",
         "A line in “What we will build” holds the model's chatter (“As an AI…”)"),
        (lambda b: _bets(b, "A setup checklist for {persona}"), "braces",
         "A line in “What we will build” has an unfilled {placeholder}"),
        (lambda b: _bets(b, "**A setup checklist**"), "markdown",
         "A line in “What we will build” has markdown left over"),
        (lambda b: _bets(b, "- A setup checklist"), "markdown",
         "A line in “What we will build” has markdown left over"),
    ],
)  # fmt: skip
def test_one_pager_checks_name_each_failure(edit, check, say):
    out = _checks(edit)
    assert {"check": check, "say": say} in out, out


def test_good_one_pager_answer_passes_its_checks():
    assert quality.one_pager(good(), one_pager.FALLBACK, MAPPED) == []
    # A block with nothing in the PRD is marked, not filled.
    bare = {**MAPPED, "not_doing": []}
    for mark in (lambda b: b[3].update(lines=[{"text": "Not in the PRD yet"}]),
                 lambda b: b[3].update(lines=[], missing=True)):  # fmt: skip
        a = good()
        mark(a["blocks"])
        assert quality.one_pager(a, one_pager.FALLBACK, bare) == []


def _all_missing() -> dict:
    return {"blocks": [{"key": s.key, "missing": True} for s in one_pager.FALLBACK]}


def test_a_block_the_prd_has_is_never_marked_missing():
    out = quality.one_pager(_all_missing(), one_pager.FALLBACK, MAPPED)
    for title in ("Problem and who has it", "What we will build", "Not doing"):
        say = f"“{title}” is marked “Not in the PRD yet” but the PRD has it"
        assert {"check": "empty_block", "say": say} in out, out
    assert {"check": "bets", "say": "0 bets; a one-pager has 3 to 5"} in out
    noted = _checks(lambda b: b[1].update(lines=[{"text": "Not in the PRD yet."}]))
    assert {"check": "bets", "say": "0 bets; a one-pager has 3 to 5"} in noted
    # Held to the strict guard: an answer marking blocks the PRD has is not usable.
    assert one_pager.clean_answer(_all_missing(), one_pager.FALLBACK, MAPPED) is None
    a = good()
    a["blocks"][3] = {"key": "not_doing", "lines": [{"text": "Not in the PRD yet"}]}
    assert one_pager.clean_answer(a, one_pager.FALLBACK, MAPPED) is None
    # A block with nothing mapped is kept marked (the page reads "Not in the PRD yet").
    a["blocks"][3] = {"key": "not_doing", "missing": True}
    out = one_pager.clean_answer(a, one_pager.FALLBACK, {**MAPPED, "not_doing": []})
    assert out is not None and out[3] == {"key": "not_doing", "lines": [], "missing": True}


def test_a_prd_quote_is_not_chatter_or_tbd():
    mapped = {**MAPPED, "problem": [_sec("problem", "Problem",
              "Users say I can't find my shared TODO lists.")]}  # fmt: skip
    a = good()
    a["blocks"][0]["lines"] = [{"text": "Users say I can't find shared TODO lists",
                                "source_keys": ["problem"]}]  # fmt: skip
    assert quality.one_pager(a, one_pager.FALLBACK, mapped) == []
    # Words the PRD does not hold are still flagged.
    a["blocks"][0]["lines"][0]["text"] = "Users say I can't find lists, TBD"
    assert {c["check"] for c in quality.one_pager(a, one_pager.FALLBACK, mapped)} == {"tbd"}
    a["blocks"][0]["lines"][0]["text"] = "As an AI, users say lists are lost"
    assert {c["check"] for c in quality.one_pager(a, one_pager.FALLBACK, mapped)} == {"chatter"}


async def _run(ctx, answers: list[dict]) -> tuple[dict, list[dict]]:
    asked: list[dict] = []

    async def ask(kind, payload):
        assert kind == "one_pager"
        asked.append(payload)
        return answers[min(len(asked), len(answers)) - 1]

    async with tenant_session(ctx.tenant_id) as s:
        job = await s.scalar(select(LlmJob).where(LlmJob.kind == "one_pager"))
        out = await one_pager.run_job(s, job, ask)
        await s.commit()
    return out, asked


async def test_good_one_pager_is_built_at_once(client):
    ctx = await world(client)
    await get(client, ctx)
    out, asked = await _run(ctx, [good()])
    assert out["built"] is True and len(asked) == 1 and "failed_checks" not in asked[0]
    view = await get(client, ctx)
    assert view["built_by"] == "oracle" and view["needs_look"] == []
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.scalar(select(SimpleOnePager))
        assert row.checks is None and row.held is None


async def test_one_pager_fails_then_passes(client):
    ctx = await world(client)
    await get(client, ctx)
    out, asked = await _run(ctx, [bad(), good()])
    assert out["built"] is True and len(asked) == 2
    named = asked[1]["failed_checks"]
    assert "2 bets; a one-pager has 3 to 5" in named
    assert "A line in “Risks and open decisions” says “TBD”" in named
    for who in ("owner", "commenter"):
        view = await get(client, ctx, who)
        assert view["needs_look"] == [] and view["built_by"] == "oracle"
        assert len(block(view, "bets")["lines"]) == 3


async def test_one_pager_fails_twice(client):
    ctx = await world(client)
    quick = await get(client, ctx)
    out, asked = await _run(ctx, [bad(), bad()])
    assert len(asked) == 2 and out["built"] is False and out["held"] is True
    assert "2 bets; a one-pager has 3 to 5" in out["checks"]
    owner = await get(client, ctx, "owner")
    assert "2 bets; a one-pager has 3 to 5" in owner["needs_look"]
    assert (
        "A line in “Risks and open decisions” holds the model's chatter (“As an AI…”)"
        in (owner["needs_look"])
    )
    assert [x["text"] for x in block(owner, "bets")["lines"]] == [
        "A setup checklist",
        "Invite suggestions from the calendar",
    ]
    for who in ("commenter", "viewer", "approver"):
        view = await get(client, ctx, who)
        assert view["needs_look"] == [], who
        assert view["built_by"] == "extract", who
        assert block(view, "bets")["lines"] == block(quick, "bets")["lines"], who
        assert "TBD" not in str(view["blocks"]), who
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.scalar(select(SimpleOnePager))
        assert {c["check"] for c in row.checks} >= {"bets", "tbd", "chatter"}


async def test_an_all_missing_answer_never_blanks_the_page(client):
    ctx = await world(client)
    quick = await get(client, ctx)
    out, asked = await _run(ctx, [_all_missing()])
    assert len(asked) == 2 and out["built"] is False
    for who in ("commenter", "viewer"):
        view = await get(client, ctx, who)
        assert view["blocks"] == quick["blocks"], who
        assert all(b["lines"] for b in view["blocks"] if b["key"] != "timeline"), who


async def test_a_held_run_keeps_the_last_good_built_at(client, monkeypatch):
    ctx = await world(client)
    await get(client, ctx)
    await _run(ctx, [good()])
    async with tenant_session(ctx.tenant_id) as s:
        built_at = (await s.scalar(select(SimpleOnePager))).built_at
    later = built_at + timedelta(days=2)
    monkeypatch.setattr(company_time, "now", lambda: later)
    async with tenant_session(ctx.tenant_id) as s:
        job = await s.scalar(select(LlmJob).where(LlmJob.kind == "one_pager"))
        job.status = "queued"
        await s.commit()
    out, _ = await _run(ctx, [bad(), bad()])
    assert out["held"] is True
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.scalar(select(SimpleOnePager))
        assert row.built_at == built_at and row.held is not None


async def test_an_owner_editing_a_held_line_is_told_why(client):
    ctx = await world(client)
    await get(client, ctx)
    await _run(ctx, [bad(), bad()])
    owner = await get(client, ctx, "owner")
    r = await edit(client, ctx, "owner", owner, "risks-1", "Calendar access worries admins")
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["message"] == (
        "This line is from Oracle's draft that needs a look; edit the last good line"
    )
    assert r.json()["detail"]["current"]["line"] == "Calendar access may scare admins away"


# --------------------------------------------------------------------------- suggestions


def _idea(title: str, **over) -> dict:
    return {"title": title, "goal_key": "quiet", "outcome": "Fewer pages at night.",
            "why": "Night pages wake people.", "evidence": [], **over}  # fmt: skip


async def test_suggestion_checks_name_each_failure(client):
    w = await World().build()
    async with tenant_session(w.ctx.tenant_id) as s:
        goal = await s.get(additions.Entity, uuid.UUID(w.goals["quiet"]))
        read_ = await service.load(s)
        features = await additions._features(s)

        def says(raw):
            return [c["say"] for c in quality.suggestion(raw, goal, read_.entries, features)]

        assert says(_idea("Quiet hours")) == []
        assert says(_idea("Quiet hours", goal_key="grow")) == [
            "“Quiet hours” does not name its goal"
        ]
        assert says(_idea("Bulk import")) == [
            "“Bulk import” repeats “Bulk import”, already on the roadmap"
        ]
        assert says(_idea("Audit log")) == ["“Audit log” repeats “Audit Log”, already a feature"]
        long = "Quiet hours that hold every alert until the morning stand-up starts"
        assert says(_idea(long)) == [
            "“Quiet hours that hold every alert…” is too long to read in one line"
        ]
        assert says(_idea("Quiet hours", why="As an AI, I suggest it.")) == [
            "“Quiet hours”: its why holds the model's chatter (“As an AI…”)"
        ]


async def _suggest(w: World, answers: list[dict]) -> tuple[dict, list[dict]]:
    asked: list[dict] = []

    async def ask(kind, payload):
        assert kind == "goal_suggestions"
        asked.append(payload)
        return answers[min(len(asked), len(answers)) - 1]

    async with tenant_session(w.ctx.tenant_id) as s:
        assert await additions.suggest_for_empty_goals(s) == 1
        job = await s.scalar(select(LlmJob).where(LlmJob.kind == "goal_suggestions"))
        out = await additions.run_goal_suggestions(s, job, ask)
        await s.commit()
    return out, asked


async def _titles(client, w: World, who: str) -> dict[str, list[str]]:
    r = await client.get(SUGGESTIONS, headers=w.as_(who), params={"goal_id": w.goals["quiet"]})
    assert r.status_code == 200, r.text
    return {x["title"]: x["needs_look"] for x in r.json()["suggestions"]}


GOOD = {"suggestions": [_idea("Quiet hours"), _idea("Alert digest"), _idea("Snooze by team")]}
BAD = {
    "suggestions": [_idea("Quiet hours"), _idea("Bulk import"), _idea("Alert digest", goal_key="")]
}


async def test_suggestions_fail_then_pass(client):
    w = await World().build()
    out, asked = await _suggest(w, [BAD, GOOD])
    assert len(asked) == 2 and out["suggested"] == 3
    assert (
        "“Bulk import” repeats “Bulk import”, already on the roadmap" in asked[1]["failed_checks"]
    )
    assert "“Alert digest” does not name its goal" in asked[1]["failed_checks"]
    for who in ("owner", "commenter"):
        assert await _titles(client, w, who) == {
            "Quiet hours": [],
            "Alert digest": [],
            "Snooze by team": [],
        }


async def test_good_suggestions_are_asked_once(client):
    w = await World().build()
    out, asked = await _suggest(w, [GOOD])
    assert len(asked) == 1 and "failed_checks" not in asked[0] and out["suggested"] == 3


async def test_suggestions_fail_twice(client):
    w = await World().build()
    out, asked = await _suggest(w, [BAD, BAD])
    assert len(asked) == 2 and out["suggested"] == 3
    owner = await _titles(client, w, "owner")
    assert owner == {
        "Quiet hours": [],
        "Bulk import": ["“Bulk import” repeats “Bulk import”, already on the roadmap"],
        "Alert digest": ["“Alert digest” does not name its goal"],
    }
    for who in ("decider", "approver", "commenter", "viewer"):
        assert await _titles(client, w, who) == {"Quiet hours": []}, who
    async with tenant_session(w.ctx.tenant_id) as s:
        rows = {r.title: r.checks for r in await s.scalars(select(SimpleGoalSuggestion))}
        assert rows["Quiet hours"] is None and rows["Bulk import"][0]["check"] == "duplicate"


async def test_a_held_suggestion_does_not_refuse_a_commenter_s_title(client):
    w = await World().build()
    await _suggest(w, [BAD, BAD])
    r = await client.post(f"/v1/simple/goals/{w.goals['quiet']}/suggestions",
                          headers=w.as_("commenter"),
                          json={"title": "Bulk import", "outcome": "Fewer steps"})  # fmt: skip
    assert r.status_code == 201, r.text
    # An owner reads the held one, so their like title is refused.
    r = await client.post(f"/v1/simple/goals/{w.goals['quiet']}/suggestions",
                          headers=w.as_("owner"),
                          json={"title": "Alert digest", "outcome": "Fewer steps"})  # fmt: skip
    assert r.status_code == 409, r.text


# --------------------------------------------------------------------------- item drafts


async def test_item_draft_fails_then_passes_or_twice(client):
    w = await World().build()
    chatty = {"outcome": "As an AI, I think admins bring data in.", "goal_key": "grow"}
    fine = {"outcome": "Admins bring their data in one step.", "goal_key": "grow"}
    for answers, outcome in (([chatty, fine], fine["outcome"]), ([chatty, chatty], None)):
        c = (await w.add(client, "owner", f"Import from files {len(str(outcome))}"))["change"]
        iid = c["target"]["item_id"]
        asked: list[dict] = []

        async def ask(kind, payload, answers=answers, asked=asked):
            asked.append(payload)
            return answers[len(asked) - 1]

        async with tenant_session(w.ctx.tenant_id) as s:
            job = await s.scalar(
                select(LlmJob).where(
                    LlmJob.kind == "item_draft", LlmJob.input["item_id"].astext == iid
                )
            )
            out = await additions.run_item_draft(s, job, ask)
            job.status = "succeeded"
            await s.commit()
            assert len(asked) == 2
            assert (
                "Its outcome holds the model's chatter (“As an AI…”)" in asked[1]["failed_checks"]
            )
            row = await s.get(RoadmapItem, uuid.UUID(iid))
            assert row.outcome == outcome
            if outcome is None:
                assert out["checks"] == ["Its outcome holds the model's chatter (“As an AI…”)"]
