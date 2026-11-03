"""priorities-keydates (the owner, Nov 2: Simple › Priorities shows a PRD's milestones too,
the same way): the lines on priorities offer each milestone of the PRDs on the roadmaps as a
key date read from the PRD (``lines[].prd``), beside the roadmap's own key dates, read through
the same code as Simple › Roadmap's key dates (key_dates.read_key_dates). Against Postgres,
on the plan tests' invented PRD (Guided setup, M1-M3).

Test cards (protects / fails_when / no_claim):

- test_prd_milestones_are_key_date_lines: protects=priorities offers the plan's M1-M3 as key
  date lines naming their PRD, beside the roadmap's own key date (no PRD), the same key dates
  the roadmap read lists; picking one draws the line on its day; a newly approved version
  that moves M2 moves its line; fails_when=the PRD's milestones are missing from the lines,
  carry no PRD, or keep an old day; no_claim=the web (priorities-keydates.spec.ts).
- test_plan_milestone_on_a_prd_key_date_is_listed_once: protects=prio-line-once (the owner,
  Nov 3: "show it once"): a plan milestone with the same name and day as a PRD's key date is
  left out of the lines (the key date "From the PRD" stays), while one with the same name on
  another day, or another name on the same day, stays; a saved pick of the left-out
  milestone draws the same line, as the key date; fails_when=both are listed, the wrong one
  is dropped, a near one is dropped, or the saved pick falls back to Now; no_claim=the web
  (prio-line-once.spec.ts).
"""

import uuid
from datetime import date

import pytest
from sqlalchemy import select

from oracle import company_time
from oracle.docs.models import Document
from oracle.roadmap.models import TrackMilestone
from oracle.simple.models import RoadmapKeyDate
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.test_simple_plan_api import FIXTURE, seed, version
from tests.test_simple_roadmap_api import NOW

URL = "/v1/simple/priorities"


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


def key_dates(body: dict) -> list[tuple[str, str, str | None]]:
    return [
        (ln["label"], ln["date"], (ln.get("prd") or {}).get("slug"))
        for ln in body["lines"]
        if ln["kind"] == "key_date"
    ]


async def test_prd_milestones_are_key_date_lines(client):
    ctx = await make_ctx()
    ids = await seed(ctx, items=("f-01", "f-03"))
    async with tenant_session(ctx.tenant_id) as s:
        rm = await s.scalar(select(Document).where(Document.slug == "setup-roadmap"))
        owner = ctx.users["owner"].id
        s.add(RoadmapKeyDate(roadmap_document_id=rm.id, name="Launch week",
                             on_date=date(2026, 11, 20), created_by=owner))  # fmt: skip
        await s.commit()
    r = await client.get(URL, headers=ctx.as_("viewer"))
    assert r.status_code == 200, r.text
    body = r.json()
    assert key_dates(body) == [
        ("Launch week · Nov 20, 2026", "2026-11-20", None),
        ("M1 · Prove it · Nov 27, 2026", "2026-11-27", "guided-setup"),
        ("M2 · Scale volume · Dec 25, 2026", "2026-12-25", "guided-setup"),
        ("M3 · Open to all · Feb 12, 2027", "2027-02-12", "guided-setup"),
    ], "the PRD's milestones are not key dates on priorities"
    # The same key dates the roadmap lists, by id.
    road = (await client.get("/v1/simple/roadmap", headers=ctx.as_("viewer"))).json()
    want = {f"key_date:{k['id']}" for k in road["key_dates"]}
    assert {ln["key"] for ln in body["lines"] if ln["kind"] == "key_date"} == want
    m1 = next(ln for ln in body["lines"] if ln["label"].startswith("M1"))
    assert m1["prd"]["title"] == "Guided setup"
    picked = (await client.get(URL, params={"line": m1["key"]}, headers=ctx.as_("viewer"))).json()
    assert picked["line"]["key"] == m1["key"] and picked["line"]["date"] == "2026-11-27"

    # The PRD changes: a newly approved version moves M2; its line moves with it.
    async with tenant_session(ctx.tenant_id) as s:
        prd = await s.get(Document, ids["prd"])
        await version(s, prd, 2, FIXTURE.replace("25 Dec 2026", "18 Dec 2026"))
        await s.commit()
    body = (await client.get(URL, headers=ctx.as_("owner"))).json()
    assert ("M2 · Scale volume · Dec 18, 2026", "2026-12-18", "guided-setup") in key_dates(body)
    assert not any(d == "2026-12-25" for _, d, _ in key_dates(body))


async def test_plan_milestone_on_a_prd_key_date_is_listed_once(client):
    ctx = await make_ctx()
    ids = await seed(ctx, items=("f-01", "f-03"))
    async with tenant_session(ctx.tenant_id) as s:
        made = [
            TrackMilestone(
                track_id=ids["track"],
                name=name,
                target_date=day,
                horizon="now",
                status="planned",
                basis_ids=[uuid.uuid4()],
                item_keys=["f-01"],
            )
            for name, day in (
                ("M1 · Prove it", date(2026, 11, 27)),  # the PRD's M1, on its day
                ("M2 · Scale volume", date(2026, 12, 26)),  # the PRD's M2, a day later
                ("Beta", date(2026, 11, 27)),  # another name on M1's day
            )
        ]
        s.add_all(made)
        await s.commit()
        dup, late, beta = (f"milestone:{m.id}" for m in made)
    body = (await client.get(URL, headers=ctx.as_("viewer"))).json()
    shown = [(ln["kind"], ln["label"]) for ln in body["lines"]]
    assert shown == [
        ("now", "This quarter (Now)"),
        ("key_date", "M1 · Prove it · Nov 27, 2026"),
        ("milestone", "Beta · Nov 27, 2026"),
        ("key_date", "M2 · Scale volume · Dec 25, 2026"),
        ("milestone", "M2 · Scale volume · Dec 26, 2026"),
        ("key_date", "M3 · Open to all · Feb 12, 2027"),
    ], f"the PRD's M1 is not listed once: {shown}"
    keys = {ln["key"] for ln in body["lines"]}
    assert dup not in keys and {late, beta} <= keys
    m1 = next(ln for ln in body["lines"] if ln["label"].startswith("M1"))
    assert m1["prd"]["slug"] == "guided-setup"
    # A saved pick of the milestone left out draws the same line, as the PRD's key date.
    picked = (await client.get(URL, params={"line": dup}, headers=ctx.as_("viewer"))).json()
    assert picked["line"] == m1
