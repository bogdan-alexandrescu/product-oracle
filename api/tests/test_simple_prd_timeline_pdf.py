"""prd-timeline (the owner's pick D "Timeline first", 2026-10-28): the one-pager's PDF of a
PRD with a dated plan. Against Postgres; invented PRD, goals and features.

Test cards (protects / fails_when / no_claim):

- test_pdf_prints_the_timeline_then_a_page_per_milestone: protects=the PDF's first page
  draws the plan's timeline (milestone flags "M1 ends 27 Nov", one lane per goal with its
  targets and "Not counted yet", the PM-owned lane, the pieces' codes, the no-work week)
  in place of the strip, and is no longer held to one page; then one page per milestone in
  order, each with its Done when, targets, what it builds by kind, decisions and risks;
  fails_when=a milestone's page is missing or out of order, or the strip is printed;
  no_claim=the PDF engine's layout (test_export.py).
- test_pdf_without_a_dated_plan_stays_one_page: protects=a PRD with no plan keeps the one
  page and its strip; fails_when=milestone pages appear; no_claim=the web.
"""

from sqlalchemy import select

from oracle.auth.deps import Principal
from oracle.docs.models import Document, DocumentVersion
from oracle.simple import one_pager
from oracle.simple.models import SimplePrdPlan
from oracle.tenancy import tenant_session
from tests.test_simple_one_pager_api import (
    clock,  # noqa: F401 - the autouse clock
    world,
)

DATA = {
    "milestones": [
        {"code": "M1", "name": "Prove it", "start": "2026-11-02", "end": "2026-11-27",
         "effort_weeks": 8, "done_when": ["Ten pilot teams finish setup"],
         "targets": [{"goal": "Growth", "target": "100 weekly active teams"}],
         "decisions": [{"code": "Q3", "title": "Which sample data to ship"}],
         "risks": ["Pilot teams may be busy"]},
        {"code": "M2", "name": "Scale volume", "start": "2026-11-30", "end": "2026-12-25",
         "effort_weeks": 8, "done_when": ["Bulk import handles 10,000 rows"],
         "targets": [{"goal": "Growth", "target": "250 weekly active teams"}]},
        {"code": "M3", "name": "Open to all", "start": "2026-12-28", "end": "2027-02-12",
         "effort_weeks": 12, "done_when": ["Anyone can sign up"]},
    ],
    "holidays": [{"start": "2026-12-28", "end": "2027-01-01", "label": "Year-end break"}],
    "features": [
        {"code": "F-01", "name": "Setup checklist", "milestones": ["M1"], "effort": [3],
         "goals": ["Activation"], "kind": "New for people", "what": "Ticks off setup steps"},
        {"code": "F-05", "name": "Team invites", "milestones": ["M1", "M2"], "effort": [2, 2],
         "goals": ["Growth"], "kind": "New for people"},
        {"code": "F-04", "name": "Pricing page words", "milestones": ["M1"], "pm_owned": True,
         "goals": ["Revenue"]},
        {"code": "F-13", "name": "Public signup", "milestones": ["M3"], "effort": [4],
         "goals": ["Growth"], "kind": "Behind the scenes"},
    ],
    "goals": ["Growth", "Activation", "Revenue"],
}  # fmt: skip


async def pdf(ctx) -> str:
    async with tenant_session(ctx.tenant_id) as s:
        p = Principal(tenant_id=ctx.tenant_id, kind="user", role="viewer",
                      user_id=ctx.users["viewer"].id)  # fmt: skip
        html, _ = await one_pager.pdf_html(s, p, "guided-setup")
    return html


async def test_pdf_prints_the_timeline_then_a_page_per_milestone(client):
    ctx = await world(client)
    async with tenant_session(ctx.tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == "guided-setup"))
        v = await s.scalar(select(DocumentVersion).where(DocumentVersion.document_id == doc.id))
        s.add(SimplePrdPlan(document_id=doc.id, version_id=v.id, status="ready", source="prd",
                            data=DATA))  # fmt: skip
        await s.commit()
    html = await pdf(ctx)
    assert "oracle-page-fit" not in html
    assert "class='plan'" not in html
    tl = html[html.index("<div class='tl'>") : html.index("<section class='part'>")]
    for flag in ("M1 ends 27 Nov", "M2 ends 25 Dec", "M3 ends 12 Feb"):
        assert flag in tl
    assert "M1 100 weekly active teams → M2 250 weekly active teams" in tl
    assert "Not counted yet" in tl and "PM-owned · no engineering" in tl
    assert tl.count("class='off'") == 4  # the year-end break, hatched in each of the 4 lanes
    assert ">F-05a<" in tl and ">F-05b<" in tl and ">F-04<" in tl
    parts = html.split("<section class='part'>")[1:]
    assert [p[p.index("<h1>") + 4 : p.index("</h1>")] for p in parts] == [
        "M1 Prove it",
        "M2 Scale volume",
        "M3 Open to all",
    ]
    m1 = parts[0]
    assert "2 Nov – 27 Nov" in m1 and "Ten pilot teams finish setup" in m1
    assert "Growth: 100 weekly active teams" in m1
    assert "<h3>New for people</h3>" in m1 and "F-01 Setup checklist" in m1
    assert "Ticks off setup steps" in m1 and m1.index("New for people") < m1.index("PM-owned")
    assert "Q3 Which sample data to ship" in m1 and "Pilot teams may be busy" in m1
    assert "F-13" not in m1 and "F-13 Public signup" in parts[2]
    assert "No open decisions" in parts[1]


async def test_pdf_without_a_dated_plan_stays_one_page(client):
    ctx = await world(client)
    html = await pdf(ctx)
    assert '<meta name="oracle-page-fit" content="one_page">' in html
    assert "<section class='part'>" not in html and "<div class='tl'>" not in html
