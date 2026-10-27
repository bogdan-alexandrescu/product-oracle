"""CLD's production walk (#723, 2026-10-27): how plans and one-pagers read with real data.
Against Postgres; invented PRDs.

Test cards (protects / fails_when / no_claim):

- test_noted_milestones_one_row_each: protects=items whose milestone texts carry notes
  ("M1 · Measure it, make it safe (a note); Digest in M2 · ...") draw one strip row per
  milestone, "M1 · Measure it, make it safe · 3 items", on the one-pager and its PDF;
  fails_when=one row per distinct text (three identical truncated M1 labels) or a note in
  the label; no_claim=the web's mirror (e2e/simple-plan-strip-rules.spec.ts).
- test_skeleton_prd_one_pager: protects=a PRD started from an empty skeleton shows no
  template guidance (HTML comments, "<Milestone>: <Feature>", "<Risk>: <mitigation>", bare
  arrows) as one-pager lines, and the PDF reads "Not written yet" for each empty block;
  fails_when=a comment, placeholder or arrow becomes a line; no_claim=the web (its spec).
- test_stored_lines_read_tidy: protects=a one-pager an older build stored (a problem line
  cut mid-word at 300 characters, a placeholder line) reads its problem to the last whole
  word with "…" and its whole text in ``full``, and hides the placeholder line, with no
  rebuild; fails_when=the page shows "a 48-ho" with no ellipsis or the placeholder;
  no_claim=the job's answer (test_simple_one_pager_review.py).
"""

from datetime import date

from sqlalchemy import select

from oracle.auth.deps import Principal
from oracle.docs.models import Document, DocumentVersion
from oracle.simple import one_pager
from oracle.simple.models import SimpleOnePager
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.test_simple_one_pager_api import (
    MD,
    block,
    clock,  # noqa: F401 - the autouse clock
    get,
    world,
)
from tests.test_simple_roadmap_api import Seed

M1 = "M1 · Measure it, make it safe"


async def pdf(ctx, doc: str = "guided-setup") -> str:
    async with tenant_session(ctx.tenant_id) as s:
        p = Principal(tenant_id=ctx.tenant_id, kind="user", role="viewer",
                      user_id=ctx.users["viewer"].id)  # fmt: skip
        html, _ = await one_pager.pdf_html(s, p, doc)
    return html


async def test_noted_milestones_one_row_each(client):
    ctx = await world(client)
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        doc = await s.scalar(select(Document).where(Document.slug == "guided-setup"))
        pv = await s.scalar(select(DocumentVersion).where(DocumentVersion.document_id == doc.id))
        rv = await seed.version(await seed.doc("setup-roadmap", "roadmap"))
        notes = [
            f"{M1} (baseline needs the export); Alert digest in M2 · Ship to beta",
            f"{M1} (owner asks for a dry run)",
            f"{M1}; follow-up in M3",
        ]
        for i, name in enumerate(notes):
            await seed.item(rv, pv, f"m1-{i}", start_date=date(2026, 10, 5),
                            end_date=date(2026, 11, 20), date_source="typed",
                            milestone={"name": name, "date": "2026-11-20"})  # fmt: skip
        await seed.item(rv, pv, "m2-0", start_date=date(2026, 11, 23),
                        end_date=date(2026, 12, 18), date_source="typed",
                        milestone={"name": "M2 · Ship to beta (two teams first)",
                                   "date": "2026-12-18"})  # fmt: skip
        await s.commit()
    view = await get(client, ctx, "viewer")
    rows = [(r["name"], r["items"]) for r in view["plan"]["rows"]]
    assert rows == [(M1, 3), ("M2 · Ship to beta", 1)]
    html = await pdf(ctx)
    assert html.count(f"{M1} · 3 items · Nov 20") == 1
    assert "dry run" not in html and "baseline needs" not in html


SKELETON = """---
title: Checkout redesign
---

## Problem and who has it {#problem}

<!-- Brief: fits one slide; say who has the problem and what it costs them. -->

## What we will build {#build}

- <Milestone>: <Feature>
- <Milestone>: <Feature>

## Outcomes {#outcomes}

→

## Not doing {#not-doing}

<!-- What we leave out, and why. -->

## Risks and open decisions {#risks}

- <Risk>: <mitigation>
- →
"""


async def test_skeleton_prd_one_pager(client):
    ctx = await make_ctx()
    r = await client.post("/v1/documents/checkout-redesign/versions", content=SKELETON.encode(),
                          headers=MD | ctx.as_("owner"))  # fmt: skip
    assert r.status_code in (200, 201), r.text
    view = await get(client, ctx, "owner", "checkout-redesign")
    for key in ("problem", "bets", "outcomes", "not_doing", "risks"):
        assert block(view, key)["lines"] == [], block(view, key)
    html = await pdf(ctx, "checkout-redesign")
    assert html.count("Not written yet") == 5
    for junk in ("&lt;!--", "Brief:", "&lt;Milestone&gt;", "&lt;Risk&gt;"):
        assert junk not in html


LONG = (
    "New workspace admins stall during setup because the checklist hides the invite step, "
    "and the queue of half-set-up teams grows every week a cohort lands; teams with more than "
    "ten people wait the longest, and the promise we make is a first answer against a 48-hour "
    "target that we miss for most new teams after a weekend signup and a holiday"
)


async def test_stored_lines_read_tidy(client):
    ctx = await world(client)
    await get(client, ctx, "owner")  # the quick read is stored
    old = LONG[: one_pager.LINE_MAX]
    assert old.endswith("48-ho") or not old.endswith(" ")
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.scalar(select(SimpleOnePager))
        blocks = [dict(b) for b in row.blocks]
        for b in blocks:
            if b["key"] == "problem":
                b["lines"] = [{**b["lines"][0], "text": old}]
            if b["key"] == "risks":
                keys = b["lines"][0]["source_keys"]
                junk = {"id": "risks-9", "text": "<Risk>: <mitigation>", "source_keys": keys}
                b["lines"] = [*b["lines"], junk]
        row.blocks = blocks
        await s.commit()
    view = await get(client, ctx, "viewer")
    problem = block(view, "problem")["lines"][0]
    assert problem["text"].endswith("…") and LONG.startswith(problem["text"][:-1])
    assert LONG[len(problem["text"]) - 1] == " "  # cut between words
    assert problem["full"] and not problem["full"].endswith("…")
    assert "<Risk>" not in str(block(view, "risks")["lines"])
