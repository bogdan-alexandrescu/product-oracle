"""Simple polish from CLD's production walk (#723, 2026-10-27): the one-pager's lines from
markdown tables, its owner, and the plan strip by month. Against Postgres; invented PRDs.

Test cards (protects / fails_when / no_claim):

- test_table_rows_are_readable_lines: protects=a PRD whose bets (and risks) are a markdown
  table shows one readable line per body row ("<first cell>: <the next non-empty cell>"),
  never the header or separator row, never a line starting or ending with "|", in the
  template-less fallback; fails_when=a header row or a piped row becomes a line;
  no_claim=the model's wording.
- test_template_block_table_rows: protects=a template's block reads a table the same way;
  fails_when=the template path keeps piped lines; no_claim=template editing.
- test_job_answer_never_keeps_pipes: protects=a job line written as a table row is read as
  one line without pipes; fails_when=the answer's pipes reach the page; no_claim=the prompt.
- test_edit_a_table_line_patches_its_row: protects=editing a line read from a table row
  rewrites that row's cells in the working draft (the table stays a table);
  fails_when=the edit is refused or breaks the row; no_claim=Detailed's editor.
- test_owner_named_or_no_owner_yet: protects=the meta names the PRD's owner (the user an
  importing API token acts for) and its decider by name; a PRD
  imported by a service token has no owner: ``owner`` is null and the PDF's meta says
  "No owner yet"; fails_when=the owner reads "someone"; no_claim=the web's wording (spec).
- test_plan_strip_by_month_with_milestones: protects=the one-pager's plan strip is the PRD's
  span by month (first item's month to the last milestone's), one row per milestone with
  its date and item count, the items with no milestone summed in one row, today's line,
  and the committed items past the edge counted; the PDF draws those rows, no per-item
  bars; fails_when=the strip lists each item or loses a milestone's count;
  no_claim=pixel layout (the Playwright spec).
- test_plan_strip_rules: protects=the strip's pure rules (no items: none; at most 6
  months; undated milestones after dated; estimated rows); fails_when=a long span draws
  every month; no_claim=the web's mirror (web/lib/simple-home.ts, its spec).
- test_a_merged_feature_is_not_on_the_plan (panel-menu): protects=a published feature
  merged into another (merged_into) is left off the one-pager's timeline and plan strip
  counts, as a cut one is; fails_when=it is listed or counted as live; no_claim=the web.
- test_every_milestone_row_has_its_name (vqa one-pager 3): protects=each milestone row of the
  strip reads its code with its name: an item of the PRD with no slice whose milestone (or
  milestone record) says only its code takes the name the PRD's plan gives that code, or the
  name another row of the strip gives it; fails_when=a row reads a bare code ("Milestone M2")
  while the PRD names it; no_claim=which code a row shows (an owner's decision).
"""

from datetime import date

from sqlalchemy import select

from oracle.auth.models import ApiToken, User
from oracle.auth.service import create_api_token
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.simple import one_pager
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.test_simple_one_pager_api import (
    MD,
    PRD,
    block,
    clock,  # noqa: F401 - the autouse clock
    edit,
    get,
    world,
)
from tests.test_simple_roadmap_api import Seed

TABLE_PRD = """---
title: Usage alerts
---

## Problem {#problem}

Teams find out about overages from the invoice. They want a warning first.

## What we will build {#build}

We will build these, in this order.

| Feature | What it does | Goals | Score | Details |
|---|:---:|---|---:|---|
| Spend alerts | Warns at 80% of the budget | Safety, Scale | 0.320 | Full design F-12 |
| Usage digest | | Scale | 0.210 | A weekly email |
| Alert routing | Sends alerts to a channel | Safety | 0.180 | |

## Outcomes {#outcomes}

- Overage surprises from 30% to 5%
- Alerts read within a day from 40% to 70%

## Risks {#risks}

| Risk | Mitigation |
| --- | --- |
| Too many alerts | A daily cap |
"""


async def table_world(client):
    ctx = await make_ctx()
    r = await client.post("/v1/documents/usage-alerts/versions", content=TABLE_PRD.encode(),
                          headers=MD | ctx.as_("owner"))  # fmt: skip
    assert r.status_code in (200, 201), r.text
    return ctx


def nm(u: User) -> str:
    # Export QA X-15: a name, never an email ("owner@example.com" reads "Owner").
    from oracle.members.names import display_name

    return display_name(u.email, u.name)


def texts(view: dict, key: str) -> list[str]:
    return [x["text"] for x in block(view, key)["lines"]]


async def test_table_rows_are_readable_lines(client):
    ctx = await table_world(client)
    view = await get(client, ctx, "owner", "usage-alerts")
    assert texts(view, "bets") == [
        "Spend alerts: Warns at 80% of the budget",
        "Usage digest: Scale",
        "Alert routing: Sends alerts to a channel",
    ]
    assert texts(view, "risks") == ["Too many alerts: A daily cap"]
    for b in view["blocks"]:
        for x in b["lines"]:
            assert not x["text"].startswith("|") and not x["text"].endswith("|"), x
            assert "What it does" not in x["text"] and "---" not in x["text"]


def test_template_block_table_rows():
    specs = one_pager._template_specs(
        "---\none_pager:\n  blocks:\n    - key: plan\n      title: The plan\n"
        "      sections: [build]\n---\n# Template\n"
    )
    body = TABLE_PRD.split("{#build}\n\n", 1)[1].split("\n## ", 1)[0]
    sec = Section(section_key="build", heading="What we will build", level=2, ordinal=1,
                  body_md=body, body_text=body, content_hash="x")  # fmt: skip
    lines = one_pager.extract(specs, one_pager.mapping(specs, [sec]))[0]["lines"]
    assert [x["text"] for x in lines] == [
        "Spend alerts: Warns at 80% of the budget",
        "Usage digest: Scale",
        "Alert routing: Sends alerts to a channel",
    ]


def test_job_answer_never_keeps_pipes():
    specs = one_pager.FALLBACK
    sec = Section(section_key="build", heading="What we will build", level=2, ordinal=1,
                  body_md="- a\n- b\n- c", body_text="a b c", content_hash="x")  # fmt: skip
    mapped = one_pager.mapping(specs, [sec])
    answer = {"blocks": [{"key": "bets", "lines": [
        {"text": "| Spend alerts | 0.320 | Full design F-12 |", "source_keys": ["build"]},
        {"text": "Usage digest |", "source_keys": ["build"]},
        {"text": "Alert routing", "source_keys": ["build"]},
    ]}]}  # fmt: skip
    blocks = one_pager.clean_answer(answer, specs, mapped)
    bets = next(b for b in blocks if b["key"] == "bets")["lines"]
    assert [x["text"] for x in bets] == ["Spend alerts: 0.320", "Usage digest", "Alert routing"]


async def test_edit_a_table_line_patches_its_row(client):
    ctx = await table_world(client)
    view = await get(client, ctx, "owner", "usage-alerts")
    r = await edit(client, ctx, "owner", view, "bets-3", "Alert routing: Sends alerts to a team")
    assert r.status_code in (200, 201), r.text
    view = await get(client, ctx, "owner", "usage-alerts")
    body = next(x["body"] for x in view["sections"] if x["key"] == "build")
    assert "| Alert routing | Sends alerts to a team | Safety | 0.180 |  |" in body
    assert "| Feature | What it does |" in body and "Sends alerts to a channel" not in body


async def test_owner_named_or_no_owner_yet(client):
    # Imported by a user: the owner reads by name, with the decider.
    ctx = await world(client)
    view = await get(client, ctx, "viewer")
    assert view["owner"]["name"] == nm(ctx.users["owner"])
    assert view["decider"]["name"] == "Dee Cider"
    # Imported by the owner's personal API token: still that person.
    async with tenant_session(ctx.tenant_id) as s:
        token, raw = await create_api_token(s, "personal", user_id=ctx.users["approver"].id)
        await s.commit()
    r = await client.post("/v1/documents/plan-b/versions", content=PRD.encode(),
                          headers=MD | {"Authorization": f"Bearer {raw}"})  # fmt: skip
    assert r.status_code in (200, 201), r.text
    assert (await get(client, ctx, "viewer", "plan-b"))["owner"]["name"] == (
        nm(ctx.users["approver"])
    )
    # Imported by a service token: no owner yet (never "someone").
    r = await client.post("/v1/documents/plan-c/versions", content=PRD.encode(),
                          headers=MD | ctx.as_("token"))  # fmt: skip
    assert r.status_code in (200, 201), r.text
    view = await get(client, ctx, "viewer", "plan-c")
    assert view["owner"] is None
    async with tenant_session(ctx.tenant_id) as s:
        from oracle.auth.deps import Principal

        p = Principal(tenant_id=ctx.tenant_id, kind="user", role="viewer",
                      user_id=ctx.users["viewer"].id)  # fmt: skip
        html, _ = await one_pager.pdf_html(s, p, "plan-c")
        assert "No owner yet" in html and "someone" not in html
        assert await s.scalar(select(ApiToken.user_id).where(ApiToken.id == token.id))


async def seed_slice(ctx) -> None:
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        doc = await s.scalar(select(Document).where(Document.slug == "guided-setup"))
        pv = await s.scalar(select(DocumentVersion).where(DocumentVersion.document_id == doc.id))
        rm = await seed.doc("setup-roadmap", "roadmap")
        rv = await seed.version(rm)

        def dated(start: date, end: date, ms: dict | None = None) -> dict:
            return {"start_date": start, "end_date": end, "date_source": "typed",
                    "milestone": ms}  # fmt: skip

        m1 = {"name": "M1", "date": "2026-11-20"}
        m3 = {"name": "M3", "date": "2027-01-29"}
        for i in range(3):
            await seed.item(rv, pv, f"m1-{i}", **dated(date(2026, 10, 5), date(2026, 11, 20), m1))
        await seed.item(rv, pv, "m3-0", **dated(date(2026, 12, 1), date(2027, 1, 29), m3))
        await seed.item(rv, pv, "loose-0", **dated(date(2026, 11, 1), date(2027, 3, 31)))
        await seed.item(rv, pv, "loose-1", horizon="later")
        await s.commit()


async def test_plan_strip_by_month_with_milestones(client):
    ctx = await world(client)
    await seed_slice(ctx)
    view = await get(client, ctx, "viewer")
    plan = view["plan"]
    assert plan["months"] == ["2026-10-01", "2026-11-01", "2026-12-01", "2027-01-01"]
    assert (plan["start"], plan["end"], plan["today"]) == ("2026-10-01", "2027-01-31", "2026-11-02")
    rows = [(r["name"], r["date"], r["items"], r["milestone"]) for r in plan["rows"]]
    assert rows == [
        ("M1", "2026-11-20", 3, True),
        ("M3", "2027-01-29", 1, True),
        ("No milestone", None, 2, False),
    ]
    assert plan["past_edge"] == 1  # loose-0 is committed to March
    async with tenant_session(ctx.tenant_id) as s:
        from oracle.auth.deps import Principal

        p = Principal(tenant_id=ctx.tenant_id, kind="user", role="viewer",
                      user_id=ctx.users["viewer"].id)  # fmt: skip
        html, _ = await one_pager.pdf_html(s, p, "guided-setup")
    assert "M1 · 3 items · Nov 20" in html and "No milestone · 2 items" in html
    # qa-simple-prd-39: the footer reads as the page's strip, in words and with no arrow.
    assert "1 commitment ends after Jan" in html and "past Jan" not in html
    assert "after Jan →" not in html
    assert "M1-0" not in html and "Loose 1" not in html  # no per-item bars


def test_plan_strip_rules():
    from oracle.simple import plan_strip

    P = plan_strip.PlanItem
    assert plan_strip.strip([], date(2026, 11, 2)) is None
    long = [P(date(2026, 1, 5), date(2027, 6, 1), False, "GA", date(2027, 6, 1))]
    s = plan_strip.strip(long, date(2026, 11, 2))
    assert len(s.months) == 6 and s.months[0] == date(2026, 10, 1) and s.today
    rows = plan_strip.strip(
        [
            P(date(2026, 11, 1), date(2026, 12, 1), True, "Later", None),
            P(date(2026, 11, 1), date(2026, 12, 1), True, "Beta", date(2026, 12, 1)),
        ],
        date(2026, 11, 2),
    ).rows
    assert [(r.name, r.estimated) for r in rows] == [("Beta", True), ("Later", True)]


async def test_a_merged_feature_is_not_on_the_plan(client):
    ctx = await world(client)
    await seed_slice(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        rv = await s.scalar(
            select(DocumentVersion).join(Document).where(Document.slug == "setup-roadmap")
        )
        pv = await s.scalar(
            select(DocumentVersion).join(Document).where(Document.slug == "guided-setup")
        )
        m1 = {"name": "M1", "date": "2026-11-20"}
        await seed.item(rv, pv, "m1-merged", title="Merged away", merged_into="m1-0",
                        start_date=date(2026, 10, 5), end_date=date(2026, 11, 20),
                        date_source="typed", milestone=m1)  # fmt: skip
        await s.commit()
    view = await get(client, ctx, "viewer")
    assert "Merged away" not in [i["title"] for i in view["timeline"]]
    rows = {r["name"]: r["items"] for r in view["plan"]["rows"]}
    assert rows["M1"] == 3


def test_every_milestone_row_has_its_name():
    from types import SimpleNamespace as N

    from oracle.simple import plan_strip

    def item(milestone=None, slices=(), n=0):
        return N(id=None, status="planned", slices=list(slices), estimated=False,
                 start=N(date=date(2026, 11, 2 + n)), end=N(date=date(2026, 11, 20 + n)),
                 milestone=milestone)  # fmt: skip

    def ms(name, day, record_id=None, record_name=None):
        return N(name=name, date=date(2026, 12, day), record_id=record_id,
                 record_name=record_name, start_date=None)  # fmt: skip

    sliced = N(milestone="M1", milestone_name="Measured and mapped", start_date=None,
               end_date=None, milestone_start=None, milestone_end=date(2026, 12, 4))  # fmt: skip
    items = [
        item(slices=[sliced]),
        item(ms("M2", 11), n=1),  # the PRD's own item, its milestone only its code
        item(ms("M3", 18, "c3a1", "M3"), n=2),  # its milestone record named only by its code
        item(ms("M4", 24), n=3),
        item(ms("M4 · Rollout", 24), n=4),
    ]
    names = {"M1": "Measured and mapped", "M2": "Ship to beta", "M3": "Open to all"}
    rows = plan_strip.strip(one_pager.plan_items(items, names), date(2026, 11, 2)).rows
    assert [r.name for r in rows] == [
        "M1 · Measured and mapped",
        "M2 · Ship to beta",
        "M3 · Open to all",
        "M4 · Rollout",
    ]
    # A record row whose code another row names reads that name too.
    rows = plan_strip.strip(
        [
            plan_strip.PlanItem(date(2026, 11, 2), date(2026, 11, 20), False, "M2 · Ship to beta", date(2026, 12, 11)),
            plan_strip.PlanItem(date(2026, 11, 3), date(2026, 11, 21), False, "M2", date(2026, 12, 11), "c3a2", "M2"),
        ],
        date(2026, 11, 2),
    ).rows
    assert [r.name for r in rows] == ["M2 · Ship to beta", "M2 · Ship to beta"]
