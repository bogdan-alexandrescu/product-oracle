"""Export QA (X-4, X-5, X-6, X-13, X-14, X-15): the Simple one-pager's PDF of a PRD with a
dated plan of many items from Nov 2026 to Feb 2027. Checks the rendered HTML. Against
Postgres; invented PRD, people, goals and features.

Test cards (protects / fails_when / no_claim):

- test_milestone_flags_never_overlap_or_leave_the_lanes: protects=X-4, each "M1 ends Nov 13"
  flag sits whole inside the lanes (never over the lane names) and flags that would collide
  stack on another row; fails_when=two flags on one row overlap by a width estimate, or a
  flag starts left of the lanes or ends past their right edge; no_claim=exact font metrics.
- test_months_and_ranges_carry_the_year: protects=X-5, the first month and every January
  show their year, and a milestone range across New Year names both years ("Dec 28, 2026 –
  Feb 12, 2027"); fails_when=a bare "Jan" or a range without years; no_claim=the web.
- test_every_bar_code_has_its_name: protects=X-6, a bar prints the feature's name when it
  fits, else its code, and every code printed without its name is in the key with its name;
  fails_when=a code shows with no name anywhere on the timeline page; no_claim=PDF layout.
- test_a_wide_bar_prints_its_name: protects=X-6, a bar wide enough prints "F-10 Single
  sign-on" and the timeline needs no key; fails_when=the bar shows the bare code;
  no_claim=font metrics.
- test_holiday_shading_writes_each_stop_in_full: protects=X-13, the PDF engine draws the
  holiday hatching (no shorthand two-position colour stops); fails_when=a stop like
  "#d9d5cc 0 2px"; no_claim=other gradients.
- test_bars_stay_inside_their_milestone_and_the_page: protects=X-14, a short bar's least
  width never pushes it past its milestone's end line or the right edge; fails_when=left +
  width passes 100% or the bar's end passes its milestone's line; no_claim=the web.
- test_done_when_one_marker_owner_name_and_page_numbers: protects=X-15, Done when items show
  one marker, the owner shows as a name (not an email) as the decider does, and the pages
  are numbered "Page N of M"; fails_when=a bullet and a box, an email, or no page counter;
  no_claim=the PDF engine's page count.
"""

import re
from datetime import date

from sqlalchemy import select

from oracle.auth.models import User
from oracle.docs.models import Document, DocumentVersion
from oracle.simple import one_pager
from oracle.simple.models import SimplePrdPlan
from oracle.tenancy import tenant_session
from tests.test_simple_one_pager_api import (
    clock,  # noqa: F401 - the autouse clock
    world,
)
from tests.test_simple_prd_timeline_pdf import pdf

MILESTONES = [
    ("M1", "Try it", "2026-11-02", "2026-11-13"),
    ("M2", "Pilot", "2026-11-16", "2026-11-20"),
    ("M3", "Invite", "2026-11-23", "2026-12-04"),
    ("M4", "Grow", "2026-12-07", "2026-12-24"),
    ("M5", "Open up", "2026-12-28", "2027-02-05"),
    ("M6", "Polish", "2027-02-08", "2027-02-12"),
]
FEATURES = [
    ("F-01", "Setup checklist", ["M1"], "Activation"),
    ("F-02", "Sample projects", ["M1"], "Activation"),
    ("F-03", "Guided first report", ["M2"], "Activation"),
    ("F-05", "Team invites", ["M3", "M5"], "Growth"),
    ("F-06", "Invite reminders", ["M3"], "Growth"),
    ("F-07", "Shared folders", ["M4"], "Growth"),
    ("F-08", "Bulk user import", ["M4"], "Growth"),
    ("F-09", "Usage digest email", ["M4"], "Growth"),
    ("F-10", "Single sign-on", ["M5"], "Revenue"),
    ("F-11", "Billing by seat", ["M5"], "Revenue"),
    ("F-12", "Plan upgrade prompts", ["M5"], "Revenue"),
    ("F-13", "Public signup", ["M5"], "Growth"),
    ("F-14", "Help centre links", ["M6"], "Activation"),
]
DATA = {
    "milestones": [
        {"code": c, "name": n, "start": a, "end": b, "effort_weeks": 6,
         "done_when": [f"{n} is live for pilot teams"],
         "targets": [{"goal": "Growth", "target": f"{(i + 1) * 50} weekly active teams"}]}
        for i, (c, n, a, b) in enumerate(MILESTONES)
    ],
    "holidays": [{"start": "2026-12-28", "end": "2027-01-01", "label": "Year-end break"}],
    "features": [
        {"code": c, "name": n, "milestones": ms, "effort": [2] * len(ms), "goals": [g],
         "kind": "New for people"}
        for c, n, ms, g in FEATURES
    ] + [{"code": "F-04", "name": "Pricing page words", "milestones": ["M2"], "pm_owned": True,
          "goals": ["Revenue"]}],
    "goals": ["Growth", "Activation", "Revenue"],
}  # fmt: skip

# A 8pt bold character's width at most (the PDF's fallback sans is wider than Inter), and a
# flag's padding and edge, in CSS px.
FLAG_CH = 6.2
FLAG_PAD = 8


async def plan_pdf(client, data=DATA) -> str:
    ctx = await world(client)
    async with tenant_session(ctx.tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == "guided-setup"))
        v = await s.scalar(select(DocumentVersion).where(DocumentVersion.document_id == doc.id))
        s.add(SimplePrdPlan(document_id=doc.id, version_id=v.id, status="ready", source="prd",
                            data=data))  # fmt: skip
        owner = await s.get(User, ctx.users["owner"].id)
        owner.email, owner.name = "mira.santos@example.com", None
        await s.commit()
    return await pdf(ctx)


def timeline(html: str) -> str:
    return html[html.index("<div class='tl'>") : html.index("<section class='part'>")]


def css_rule(html: str, selector: str) -> str:
    m = re.search(re.escape(selector) + r"\s*\{([^}]*)\}", html)
    return m.group(1) if m else ""


def _num(style: str, prop: str) -> float:
    m = re.search(rf"(?:^|;)\s*{prop}:\s*(-?[\d.]+)", style)
    assert m, (prop, style)
    return float(m.group(1))


async def test_milestone_flags_never_overlap_or_leave_the_lanes(client):
    html = await plan_pdf(client)
    right_aligned = "translateX(-100%)" in css_rule(html, ".tl .f")
    flags = re.findall(r"<span class='f(?: l)?' style='([^']*)'>([^<]*)</span>", timeline(html))
    day = one_pager.plan_model._day
    want = [f"{c} ends {day(date.fromisoformat(b))}" for c, _, _, b in MILESTONES]
    assert [t for _, t in flags] == want
    spans: dict[float, list[tuple[float, float]]] = {}
    for style, text in flags:
        w = len(text) * FLAG_CH + FLAG_PAD
        at = _num(style, "left") / 100 * one_pager.TL_PX
        a = at - w if right_aligned else at
        assert a >= -0.5 and a + w <= one_pager.TL_PX + 0.5, (text, a, w)
        row = _num(style, "top") if "top:" in style else 0.0
        for b0, b1 in spans.get(row, []):
            assert a + w <= b0 + 0.5 or a >= b1 - 0.5, f"{text} overlaps a flag on its row"
        spans.setdefault(row, []).append((a, a + w))


async def test_months_and_ranges_carry_the_year(client):
    html = await plan_pdf(client)
    months = re.findall(r"<span class='mo'[^>]*>([^<]*)</span>", timeline(html))
    assert months[0] == "Nov 2026"
    assert "Jan 2027" in months and "Jan" not in months
    assert "Dec" in months  # other months stay short
    parts = html.split("<section class='part'>")[1:]
    assert "Nov 2 – Nov 13" in parts[0]
    assert "Dec 28, 2026 – Feb 5, 2027" in parts[4]


async def test_every_bar_code_has_its_name(client):
    html = await plan_pdf(client)
    tl = timeline(html)
    labels = re.findall(r"<span class='bar[^']*'[^>]*>([^<]*)</span>", tl)
    key = re.search(r"<div class='key'>(.*?)</div>", tl)
    keyed = key.group(1) if key else ""
    names = {c: n for c, n, _, _ in FEATURES} | {"F-04": "Pricing page words"}
    printed = set()
    for label in labels:
        for code in re.findall(r"F-\d+[a-z]?", label):
            name = names[code[:4]]
            assert name in label or f"{code} {name}" in keyed, (code, label)
            printed.add(code[:4])
    # Codes a bar folds into "+N" are in the key with their names too.
    for code in re.findall(r"F-\d+[a-z]?", keyed):
        assert f"{code} {names[code[:4]]}" in keyed
        printed.add(code[:4])
    assert printed == set(names)


async def test_holiday_shading_writes_each_stop_in_full(client):
    html = await plan_pdf(client)
    off = css_rule(html, ".tl .off")
    assert "background" in off
    stops = re.findall(r"(#[0-9a-fA-F]{3,6}|transparent)\s+([^,)]+)", off)
    for colour, at in stops:
        assert len(at.split()) == 1, f"{colour} {at}: a shorthand stop the PDF engine ignores"


async def test_bars_stay_inside_their_milestone_and_the_page(client):
    html = await plan_pdf(client)
    tl = timeline(html)
    # Each lane draws the milestones' end lines in order; the first lane's are M1..M6.
    lines = re.findall(r"<span class='end' style='([^']*)'>", tl)[: len(MILESTONES)]
    ends = {c: _num(st, "left") for (c, *_), st in zip(MILESTONES, lines, strict=True)}
    bars = re.findall(r"<span class='bar[^']*' style='([^']*)'>([^<]*)</span>", tl)
    assert bars
    for style, label in bars:
        assert "min-width" not in style and "calc(" not in style, style
        left, width = _num(style, "left"), _num(style, "width")
        assert left >= 0 and left + width <= 100.01, (label, left, width)
    # The one-week M6 bar (F-14) ends on M6's line, not past it.
    f14 = next(s for s, label in bars if "F-14" in label)
    assert _num(f14, "left") + _num(f14, "width") <= ends["M6"] + 0.01


async def test_done_when_one_marker_owner_name_and_page_numbers(client):
    html = await plan_pdf(client)
    part = html.split("<section class='part'>")[1]
    done = part[part.index("Done when") : part.index("Targets")]
    assert "☐" in done
    ul = re.search(r"<ul([^>]*)>", done).group(1)
    cls = re.search(r"class='([^']+)'", ul)
    assert cls and "list-style: none" in css_rule(html, f".{cls.group(1)}"), ul
    meta = re.search(r"<div class='meta'>(.*?)</div>", html).group(1)
    assert "owner Mira Santos" in meta and "decider Dee Cider" in meta
    assert "@" not in meta
    page = re.search(r"@page\s*\{.*?\}\s*\}", html, re.S)
    assert page and 'counter(page) " of " counter(pages)' in page.group(0)
    assert '"Page "' in page.group(0)


async def test_a_wide_bar_prints_its_name(client):
    data = {**DATA, "milestones": DATA["milestones"][4:5], "features": [
        {"code": "F-10", "name": "Single sign-on", "milestones": ["M5"], "effort": [4],
         "goals": ["Revenue"]},
    ]}  # fmt: skip
    tl = timeline(await plan_pdf(client, data))
    assert re.findall(r"<span class='bar[^']*'[^>]*>([^<]*)</span>", tl) == ["F-10 Single sign-on"]
    assert "<div class='key'>" not in tl
