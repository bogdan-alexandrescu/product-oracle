"""Production QA of the Simple one-pager (PR 1502): each "Needs a look" item once, who has
the problem never a confidence label, and a long Problem line edited whole. Invented PRDs.

Test cards (protects / fails_when / no_claim):

- test_needs_a_look_says_each_item_once: protects=a disagreement the PRD states twice (the
  same sentence again in its Summary) is one "Needs a look" item; fails_when=the same card
  shows twice; no_claim=the web's words (the Playwright spec).
- test_who_has_it_is_never_a_confidence_label: protects=who has it names the people, never a
  note on how sure the PRD is ("Low confidence: ..."), and is nothing when only such notes
  are there; fails_when=the page says "Who has it: Low confidence"; no_claim=the web.
- test_long_problem_line_edited_whole: protects=a Problem line over 300 characters (shown
  cut, its whole text behind it) is edited from its whole words: the edit is taken, the
  section reads the new words only and the page shows them whole; fails_when=the edit is
  refused for its length or the cut tail stays beside the new words; no_claim=the web's box.
"""

from sqlalchemy import select

from oracle.docs.models import Section
from oracle.simple import one_pager
from oracle.simple import one_pager_checks as checks
from oracle.simple.models import SimpleOnePager
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.test_simple_one_pager_api import (
    MD,
    clock,  # noqa: F401 - the autouse clock
    edit,
    get,
    line,
)


def _sec(key: str, heading: str, body: str) -> Section:
    return Section(section_key=key, heading=heading, level=2, ordinal=1, body_md=body,
                   body_text=body, content_hash="x")  # fmt: skip


def test_needs_a_look_says_each_item_once():
    summary = _sec(
        "summary",
        "Summary",
        "Eight features ship in May. Eight features ship in May.\n\n"
        "- Bulk invite\n- Invite link\n- Team templates\n",
    )
    looks = checks.annotate([], [summary])
    said = [(x.kind, x.text, tuple(x.source_keys)) for x in looks]
    text = "“Eight features ship in May” says 8, but “Summary” shows 3 items."
    assert said == [("numbers", text, ("summary",))]
    # The same per-unit sentence said twice is one item too.
    targets = _sec(
        "targets",
        "Targets",
        "Each studio adds 4 paid seats a month. Each studio adds 4 paid seats a month. "
        "We serve 5 studios. Company-wide target: 30 paid seats a month.",
    )
    assert len([x for x in checks.annotate([], [targets]) if "per studio" in x.text]) == 1


def test_who_has_it_is_never_a_confidence_label():
    leads = _sec(
        "users", "Users", "- Studio admins: set up alone\n- Low confidence: we met three studios"
    )
    assert checks.who_has_it([leads]) == "Studio admins"
    labelled = _sec("users", "Users", "- Owner: Studio leads\n- Low confidence: not checked yet")
    assert checks.who_has_it([labelled]) == "Studio leads"
    only = _sec("users", "Users", "- Low confidence: we have not met anyone yet")
    assert not checks.who_has_it([only])
    prose = _sec("users", "Who has it", "Low confidence. Studio admins of small teams.")
    assert checks.who_has_it([prose]) == "Studio admins of small teams"


LONG = (
    "New workspace admins at small design studios stall during setup because nobody tells "
    "them which step comes next. Half of them never invite a teammate in the first week, so "
    "their projects stay empty and quiet. Many give up on the trial before they ever see a "
    "shared board, a comment thread or a finished handoff."
)

LONG_PRD = f"""---
title: Studio setup
---

## Problem {{#problem}}

{LONG}

## What we will build {{#build}}

- A setup checklist that shows the next step
- Invite suggestions for new studios
- A sample board on day one
"""


async def test_long_problem_line_edited_whole(client):
    assert len(LONG) > one_pager.LINE_MAX and len(LONG.split()) <= one_pager.PROBLEM_WORDS
    ctx = await make_ctx()
    r = await client.post("/v1/documents/studio-setup/versions", content=LONG_PRD.encode(),
                          headers=MD | ctx.as_("owner"))  # fmt: skip
    assert r.status_code in (200, 201), r.text
    await get(client, ctx, "owner", "studio-setup")
    # The Problem line as a long paragraph reads: cut at 300 characters, its whole behind it.
    shown, whole = one_pager.clip(LONG, one_pager.PROBLEM_WORDS)
    assert shown.endswith("…") and whole == LONG
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.scalar(select(SimpleOnePager))
        blocks = [dict(b) for b in row.blocks]
        i = next(n for n, b in enumerate(blocks) if b["key"] == "problem")
        blocks[i] = {**blocks[i], "lines": [
            {"id": "problem-1", "text": shown, "full": whole, "source_keys": ["problem"]}
        ]}  # fmt: skip
        row.blocks = blocks
        await s.commit()
    view = await get(client, ctx, "owner", "studio-setup")
    assert line(view, "problem-1")["text"] == shown and line(view, "problem-1")["full"] == LONG
    # The Edit box starts from the whole words; one word changed.
    new = LONG.replace("Half of them", "Most of them")
    r = await edit(client, ctx, "owner", view, "problem-1", new)
    assert r.status_code == 201, r.text
    body = r.json()["change"]["after"]["sections"]["problem"]["body"]
    assert body.strip() == new
    after = await get(client, ctx, "owner", "studio-setup")
    assert line(after, "problem-1")["text"] == new
    assert line(after, "problem-1")["state"] == "edited"
