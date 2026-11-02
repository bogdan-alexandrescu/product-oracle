"""roadmap-keydates: Simple › Roadmap lists each milestone of the PRDs on the roadmap as a
key date read from the PRD (``key_dates[].prd``), read-only, beside the roadmap's own key
dates; an item built from a PRD takes its own bet's flow, never the first bet that mentions
its title; and a roadmap read only builds the one-pager of a PRD with a drawn bet, once.
Against Postgres, on the plan tests' and the one-pager tests' invented PRDs.

Test cards (protects / fails_when / no_claim):

- test_prd_milestones_are_read_only_key_dates: protects=the roadmap read (all roadmaps and
  the roadmap chosen) lists the plan's M1-M3 as key dates "From the PRD" (their PRD named,
  name and end day), beside the roadmap's own key date (no PRD); a newly approved version
  that moves M2 moves its key date; editing one through the change engine is refused;
  fails_when="Key dates · 1" (the PRD's milestones missing), an old day, or an edit applies;
  no_claim=the web (roadmap-keydates.spec.ts).
- test_item_takes_its_own_bet_not_the_first_naming_its_title: protects=an item "Alerts"
  from section F-02 takes the flow of the bet naming F-02, not the first bet that mentions
  alerts; an item "Alerts" with no code, from a section several bets come from, whose title
  two bets mention, takes none; fails_when=either takes the digest bet's flow;
  no_claim=the card.
- test_roadmap_read_builds_a_one_pager_only_for_a_drawn_bet: protects=a roadmap read never
  builds the one-pager of a PRD with no drawn bet, and builds it once for a PRD with one,
  however many of its items wait for a flow; fails_when=every read rebuilds every PRD's
  one-pager; no_claim=the one-pager page's own reads.
"""

import uuid
from datetime import date

import pytest
from sqlalchemy import select

import tests.test_simple_one_pager_api as op
from oracle import company_time
from oracle.docs.models import Document, DocumentVersion
from oracle.simple import one_pager
from oracle.simple.models import RoadmapKeyDate
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.test_simple_line_visuals_api import ask
from tests.test_simple_one_pager_api import line, world
from tests.test_simple_plan_api import FIXTURE, seed, version
from tests.test_simple_roadmap_api import NOW, Seed, by_key, get
from tests.test_simple_visuals_api import run_visual_jobs


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


def days(body: dict) -> list[tuple[str, str, str | None]]:
    return [(k["name"], k["date"], (k.get("prd") or {}).get("slug")) for k in body["key_dates"]]


async def test_prd_milestones_are_read_only_key_dates(client):
    ctx = await make_ctx()
    ids = await seed(ctx, items=("f-01", "f-03"))
    async with tenant_session(ctx.tenant_id) as s:
        rm = await s.scalar(select(Document).where(Document.slug == "setup-roadmap"))
        s.add(RoadmapKeyDate(roadmap_document_id=rm.id, name="Launch week",
                             on_date=date(2026, 11, 20), created_by=ctx.users["owner"].id))  # fmt: skip
        await s.commit()
    want = [
        ("Launch week", "2026-11-20", None),
        ("M1 · Prove it", "2026-11-27", "guided-setup"),
        ("M2 · Scale volume", "2026-12-25", "guided-setup"),
        ("M3 · Open to all", "2027-02-12", "guided-setup"),
    ]
    for q in ("", "?roadmap=setup-roadmap"):
        body = (await client.get(f"/v1/simple/roadmap{q}", headers=ctx.as_("viewer"))).json()
        assert days(body) == want, "the PRD's milestones are not key dates"
        assert {k["roadmap"]["slug"] for k in body["key_dates"]} == {"setup-roadmap"}
    m1 = next(k for k in body["key_dates"] if k["name"].startswith("M1"))
    assert m1["prd"]["title"] == "Guided setup" and not m1["in_draft"]

    # The PRD changes: a newly approved version moves M2; its key date moves with it.
    async with tenant_session(ctx.tenant_id) as s:
        prd = await s.get(Document, ids["prd"])
        await version(s, prd, 2, FIXTURE.replace("25 Dec 2026", "18 Dec 2026"))
        await s.commit()
    body = (await client.get("/v1/simple/roadmap", headers=ctx.as_("owner"))).json()
    assert ("M2 · Scale volume", "2026-12-18", "guided-setup") in days(body)

    # Read-only: the change engine refuses to edit or remove a PRD's milestone.
    m2 = next(k for k in body["key_dates"] if k["name"].startswith("M2"))
    seen = {"name": m2["name"], "date": m2["date"], "note": None}
    target = {"roadmap_id": m2["roadmap"]["id"], "key_date_id": m2["id"]}
    for op_, after in (("edit_key_date", {**seen, "date": "2026-12-11"}), ("remove_key_date", {})):
        r = await client.post("/v1/simple/changes", headers=ctx.as_("owner"), json={
            "op": op_, "target": target, "before": {"key_date": seen}, "after": after,
        })  # fmt: skip
        assert r.status_code >= 400, r.text
    body = (await client.get("/v1/simple/roadmap", headers=ctx.as_("owner"))).json()
    assert ("M2 · Scale volume", "2026-12-18", "guided-setup") in days(body)


BETS = """- A setup checklist that shows the next step
- Invite suggestions from the admin's calendar
- A sample project created on day one
- A progress meter on the home page
"""
ALERT_BETS = """- F-01 A weekly digest that groups alerts by team
- F-02 Alerts when a setup step fails
- F-03 A sample project created on day one
"""


async def _drawn(client, monkeypatch, *bets: str):
    """The one-pager world with the alert bets, the given bets' flows drawn."""
    monkeypatch.setattr(op, "PRD", op.PRD.replace(BETS, ALERT_BETS))
    ctx = await world(client)
    view = await op.get(client, ctx, "decider")
    doc_id = view["document"]["id"]
    sids = {b: line(view, b)["flow_subject"] for b in bets}
    for sid in sids.values():
        assert (await ask(client, ctx, "decider", sid, doc_id)).status_code == 202
    await run_visual_jobs(ctx)
    return ctx, sids


async def _items(ctx, *rows: tuple[str, str, str]) -> None:
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        doc = await s.scalar(select(Document).where(Document.slug == "guided-setup"))
        pv = await s.scalar(select(DocumentVersion).where(DocumentVersion.document_id == doc.id))
        rm = await seed.doc("guided-setup-roadmap", "roadmap")
        rv = await seed.version(rm)
        for n, (key, title, section) in enumerate(rows):
            await seed.item(rv, pv, key, title=title, position=n, prd_section_key=section)
        await s.commit()


async def test_item_takes_its_own_bet_not_the_first_naming_its_title(client, monkeypatch):
    ctx, sids = await _drawn(client, monkeypatch, "bets-1", "bets-2")
    await _items(ctx, ("alerts", "Alerts", "f-02"), ("alerts-too", "Alerts", "build"))
    items = by_key(await get(client, ctx, "owner"))
    flow = items["alerts"]["flow"]
    assert flow is not None and flow["subject_id"] == sids["bets-2"], "took another bet's flow"
    # Its title names two bets and its section has three: no bet is its own.
    assert items["alerts-too"]["flow"] is None


async def test_roadmap_read_builds_a_one_pager_only_for_a_drawn_bet(client, monkeypatch):
    calls: list[uuid.UUID] = []
    real = one_pager.built

    async def counted(db, document, **kw):
        calls.append(document.id)
        return await real(db, document, **kw)

    ctx = await world(client)
    await _items(ctx, ("one", "One", "build"), ("two", "Two", "build"))
    monkeypatch.setattr(one_pager, "built", counted)
    await get(client, ctx, "owner")
    assert calls == [], "a roadmap read built a one-pager with no drawn bet"

    monkeypatch.setattr(one_pager, "built", real)
    view = await op.get(client, ctx, "decider")
    sid = line(view, "bets-1")["flow_subject"]
    assert (await ask(client, ctx, "decider", sid, view["document"]["id"])).status_code == 202
    await run_visual_jobs(ctx)
    monkeypatch.setattr(one_pager, "built", counted)
    await get(client, ctx, "owner")
    assert len(calls) == 1, "the one-pager was built more than once in one read"
