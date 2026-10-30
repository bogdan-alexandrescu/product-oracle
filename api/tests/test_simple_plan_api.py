"""Simple plan-model: a PRD's plan through the API (``GET /v1/simple/prds/{prd}/plan``,
``POST .../plan/read-again``), on the roadmap read, in the dates to confirm and in
Priorities' quarter. Against Postgres; the company's clock is Wed Oct 28, 2026.

Test cards (protects / fails_when / no_claim):

- test_plan_endpoint_per_role (parametrized owner, decider, approver, commenter, viewer):
  protects=every role reads the plan (milestones, slices, goals with targets, weeks per
  goal, span); only owners may read it again (others 403); fails_when=a role is refused
  the read or a non-owner re-reads; no_claim=the web.
- test_new_approved_version_updates_without_duplicating: protects=a newly approved
  version's plan replaces the old one (one stored plan per PRD), and "Read the plan again"
  keeps one row; fails_when=a second row or the old dates; no_claim=draft versions.
- test_job_reads_a_prd_without_tables: protects=a PRD with no tables queues the prd_plan
  job; its (fake) answer becomes the plan, Oracle's ("oracle"), slices placed inside their
  milestones; fails_when=the job is not queued or the answer is dropped; no_claim=the
  live model.
- test_roadmap_items_carry_slices_and_dated_milestones: protects=roadmap items read from
  the PRD carry their slices and milestone codes, the track milestone records get start,
  end, engineer-weeks, done when and targets, and the read carries the plan's span;
  fails_when=any of them is missing; no_claim=the Gantt (roadmap-gantt's lane).
- test_dates_to_confirm_follow_the_plan: protects=an undated item of a planned PRD gets
  one suggestion per slice, inside its milestone (F-03: two), never the Now window's
  packing (main's suggester gave Nov 2 + 42 days for every item); fails_when=a suggestion
  starts at the window or ends past its milestone; no_claim=accept's change engine (its
  own tests).
- test_accept_a_slice_per_role (parametrized owner, decider, approver, commenter, viewer):
  protects=accepting a slice's date is a change through the engine: owners and the decider
  apply it (the item takes the span of its slices, both slices accepted), approvers and
  commenters propose it, viewers are refused; fails_when=a role applies that may not, or the
  item takes one slice's dates only; no_claim=undo (the engine's own tests).
- test_quarter_label_from_the_plan: protects=Priorities' quarter is the plan's span
  ("Nov 2 - Feb 12"), not the calendar quarter; fails_when="Q4 2026"; no_claim=the web.
- test_approving_a_version_reads_its_plan (review): protects=approving a PRD version with
  no tables queues the prd_plan job at once, and its answer is what the roadmap shows;
  fails_when=only a call to the plan endpoint reads it; no_claim=the live model.
- test_reading_the_plan_writes_nothing (review): protects=a viewer's GET of the plan
  stores no plan row and queues no job; fails_when=a read writes or spends; no_claim=the
  owner's "Read the plan again".
- test_dates_to_confirm_show_what_accept_applies (review): protects=the roadmap item's
  suggestion is the span of its open slices (F-03: Nov 16 - Dec 18), the dates Accept
  saves; fails_when=it shows the first slice's dates only; no_claim=the web tray.
- test_this_quarters_weeks_follow_the_plan (review): protects=Priorities' engineer-weeks
  per goal "this quarter" count the items the plan places in its span, whatever their
  horizon; fails_when=only Now items count; no_claim=the ranking.
- test_chat_this_quarter_is_the_plans_span (review): protects="move F-03 to this
  quarter" in Simple's chat means the plan's span; fails_when=the calendar quarter;
  no_claim=other periods (calendar, test_simple_chat_walk_ask).
- test_views_parse_a_version_once (review): protects=reading the plans again does not
  parse an unchanged approved version's text again; fails_when=every read re-parses;
  no_claim=the stored plan's reads.
- test_priorities_carry_the_plan (parametrized owner, decider, approver, commenter, viewer):
  protects=Priorities carries the plan "this quarter" is (plan-charts' Goal buckets header):
  its PRD, milestones with dates, capacity and planned weeks, slices, engineer-weeks per goal
  per milestone (each slice once) and its span, the same for every role; fails_when=the plan
  is missing, its totals differ from the plan endpoint's or a role reads another plan;
  no_claim=the web's drawing (Playwright's simple-priorities-plan spec).
- test_priority_rows_say_whether_they_are_in_the_plan: protects=each Priorities row says
  whether its item is the plan PRD's (in_plan), so Goal buckets still lists the roadmap's items
  outside the plan; fails_when=a row outside the plan reads as in it, or the plan's row does
  not; no_claim=the web's card (Playwright's simple-plan-charts spec).
"""

import hashlib
from datetime import UTC, date, datetime
from pathlib import Path

import pytest
from sqlalchemy import func, select

from oracle import company_time
from oracle.auth.models import User
from oracle.baseline.models import Entity
from oracle.docs.models import Document, DocumentVersion
from oracle.jobs.models import LlmJob
from oracle.review.models import DocumentReviewPolicy
from oracle.roadmap.models import ProductTrack, RoadmapItem, TrackMilestone
from oracle.simple import plan, suggestions
from oracle.simple.models import RoadmapDateSuggestion, SimplePrdPlan
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx
from tests.test_simple_roadmap_api import Seed

NOW = datetime(2026, 10, 28, 19, 0, tzinfo=UTC)
FIXTURE = (Path(__file__).parent / "fixtures" / "prd_plan_invented.md").read_text()


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


def url(slug: str) -> str:
    return f"/v1/simple/prds/{slug}/plan"


async def version(s, doc: Document, n: int, body: str, approved: bool = True):
    v = DocumentVersion(
        document_id=doc.id,
        number=n,
        markdown=body,
        content_hash=hashlib.sha256(body.encode()).hexdigest(),
        approved_at=datetime(2026, 10, 20 + n, tzinfo=UTC) if approved else None,
    )
    s.add(v)
    await s.flush()
    return v


async def seed(ctx: Ctx, body: str = FIXTURE, items: tuple[str, ...] = ()) -> dict:
    async with tenant_session(ctx.tenant_id) as s:
        prd = Document(slug="guided-setup", title="Guided setup", kind="prd", status="approved",
                       visibility="company")  # fmt: skip
        rm = Document(slug="setup-roadmap", title="Setup roadmap", kind="roadmap",
                      status="approved", visibility="company")  # fmt: skip
        s.add_all([prd, rm])
        await s.flush()
        pv = await version(s, prd, 1, body)
        rv = await version(s, rm, 1, "# Setup roadmap\n")
        decider = User(email="decider@example.com", password_hash="x", role="approver")
        s.add(decider)
        await s.flush()
        ctx.users["decider"] = decider
        s.add(DocumentReviewPolicy(document_id=rm.id, decider_id=decider.id))
        track = ProductTrack(prd_document_id=prd.id, started_version_id=pv.id,
                             current_version_id=pv.id, roadmap_document_id=rm.id,
                             title="Guided setup")  # fmt: skip
        s.add(track)
        await s.flush()
        for n, key in enumerate(items):
            s.add(RoadmapItem(roadmap_document_id=rm.id, roadmap_version_id=rv.id,
                              item_key=key, prd_document_id=prd.id, prd_version_id=pv.id,
                              prd_section_key=key, title=key.upper(), horizon="now",
                              position=n, track_id=track.id))  # fmt: skip
        s.add(TrackMilestone(track_id=track.id, name="M1 Prove it", item_keys=list(items[:1])))
        await s.commit()
        return {"prd": prd.id, "track": track.id}


@pytest.mark.parametrize("role", ["owner", "decider", "approver", "commenter", "viewer"])
async def test_plan_endpoint_per_role(client, role):
    ctx = await make_ctx()
    await seed(ctx)
    r = await client.get(url("guided-setup"), headers=ctx.as_(role))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "ready" and body["source"] == "prd"
    assert [m["code"] for m in body["milestones"]] == ["M1", "M2", "M3"]
    assert body["milestones"][2]["start_date"] == "2026-12-28"
    assert body["span"]["label"] == "Nov 2 - Feb 12"
    assert {x["code"] for x in body["slices"]} >= {"F-03a", "F-03b"}
    assert {g["name"] for g in body["goals"]} == {"Activation", "Growth"}
    assert {(w["goal"], w["milestone"], w["weeks"]) for w in body["goal_weeks"]} >= {
        ("Growth", "M2", 3.0)
    }
    assert body["can_read_again"] is (role == "owner")
    again = await client.post(f"{url('guided-setup')}/read-again", headers=ctx.as_(role))
    assert again.status_code == (200 if role == "owner" else 403), again.text


async def test_new_approved_version_updates_without_duplicating(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    assert (await client.get(url("guided-setup"), headers=ctx.as_("viewer"))).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        prd = await s.get(Document, ids["prd"])
        await version(s, prd, 2, FIXTURE.replace("12 Feb 2027", "19 Feb 2027"))
        # A draft after it is not the plan's.
        await version(s, prd, 3, FIXTURE.replace("12 Feb 2027", "26 Feb 2027"), approved=False)
        await s.commit()
    body = (await client.get(url("guided-setup"), headers=ctx.as_("viewer"))).json()
    assert body["version"] == 2 and body["span"]["label"] == "Nov 2 - Feb 19"
    r = await client.post(f"{url('guided-setup')}/read-again", headers=ctx.as_("owner"))
    assert r.status_code == 200 and r.json()["version"] == 2
    async with tenant_session(ctx.tenant_id) as s:
        n = await s.scalar(select(func.count()).select_from(SimplePrdPlan))
        assert n == 1


async def test_job_reads_a_prd_without_tables(client):
    ctx = await make_ctx()
    prose = "# Guided setup\n\nWe ship the checklist first, then invites, then the digest.\n"
    await seed(ctx, prose)
    r = await client.post(f"{url('guided-setup')}/read-again", headers=ctx.as_("owner"))
    body = r.json()
    assert body["status"] == "reading" and body["milestones"] == []
    answer = {
        "milestones": [
            {"code": "M1", "name": "Prove it", "start": "2026-11-02", "end": "2026-11-27",
             "effort_weeks": 6, "done_when": ["Ten teams finish setup"],
             "targets": [{"goal": "Activation", "target": "40% of new teams finish setup"}]},
            {"code": "M2", "name": "Scale volume", "start": "2026-11-30", "end": "2026-12-25",
             "effort_weeks": 6, "done_when": [], "targets": []},
        ],
        "features": [
            {"code": "F-01", "name": "Setup checklist", "milestones": ["M1"], "effort": [3],
             "goals": ["Activation"], "order": ["first"], "pm_owned": False},
            {"code": "F-03", "name": "Invite teammates", "milestones": ["M1", "M2"],
             "effort": [2, 2], "goals": ["Growth"], "order": ["then", "first"],
             "pm_owned": False},
        ],
        "goals": ["Activation", "Growth"],
        "holidays": [],
    }  # fmt: skip

    async def ask(kind, payload):
        assert kind == "prd_plan" and "checklist first" in payload["text"]
        return answer

    async with tenant_session(ctx.tenant_id) as s:
        job = await s.scalar(select(LlmJob).where(LlmJob.kind == "prd_plan"))
        assert job is not None
        assert (await plan.run_job(s, job, ask))["read"] is True
        await s.commit()
    body = (await client.get(url("guided-setup"), headers=ctx.as_("viewer"))).json()
    assert body["status"] == "ready" and body["source"] == "oracle"
    got = {x["code"]: (x["start_date"], x["end_date"]) for x in body["slices"]}
    assert got == {
        "F-01": ("2026-11-02", "2026-11-20"),
        "F-03a": ("2026-11-23", "2026-11-27"),
        "F-03b": ("2026-11-30", "2026-12-11"),
    }


async def test_roadmap_items_carry_slices_and_dated_milestones(client):
    ctx = await make_ctx()
    await seed(ctx, items=("f-03", "f-05"))
    body = (await client.get("/v1/simple/roadmap", headers=ctx.as_("viewer"))).json()
    items = {i["key"]: i for i in body["items"]}
    assert [x["code"] for x in items["f-03"]["slices"]] == ["F-03a", "F-03b"]
    assert items["f-03"]["milestones"] == ["M1", "M2"]
    assert items["f-05"]["slices"][0]["milestone_start"] == "2026-12-28"
    (m,) = body["milestones"]
    assert (m["start_date"], m["end_date"], m["effort_weeks"]) == ("2026-11-02", "2026-11-27", 8.0)
    assert m["done_when"] == ["Ten teams finish setup", "the checklist is live"]
    assert {"goal": "Growth", "target": "20 weekly active teams"} in m["targets"]
    assert body["span"]["label"] == "Nov 2 - Feb 12"


async def test_dates_to_confirm_follow_the_plan(client):
    ctx = await make_ctx()
    await seed(ctx, items=("f-03", "f-05"))
    async with tenant_session(ctx.tenant_id) as s:
        await suggestions.regenerate(s)
        await s.commit()
        rows = list(await s.scalars(select(RoadmapDateSuggestion)))
        keys = {i.id: i.item_key for i in await s.scalars(select(RoadmapItem))}
    got = sorted((keys[r.item_id], r.slice_code, r.start_date, r.end_date) for r in rows)
    assert got == [
        ("f-03", "F-03a", date(2026, 11, 16), date(2026, 11, 27)),
        ("f-03", "F-03b", date(2026, 11, 30), date(2026, 12, 18)),
        ("f-05", "F-05", date(2027, 1, 18), date(2027, 1, 29)),
    ]
    assert all("M" in r.basis for r in rows)


async def test_quarter_label_from_the_plan(client):
    ctx = await make_ctx()
    await seed(ctx, items=("f-03",))
    r = await client.get("/v1/simple/priorities", headers=ctx.as_("viewer"))
    assert r.status_code == 200, r.text
    q = r.json()["quarter"]
    assert (q["label"], q["start"], q["end"]) == ("Nov 2 - Feb 12", "2026-11-02", "2027-02-12")


@pytest.mark.parametrize("role", ["owner", "decider", "approver", "commenter", "viewer"])
async def test_priorities_carry_the_plan(client, role):
    ctx = await make_ctx()
    await seed(ctx, items=("f-03",))
    r = await client.get("/v1/simple/priorities", headers=ctx.as_(role))
    assert r.status_code == 200, r.text
    p = r.json()["plan"]
    assert p["prd"]["slug"] == "guided-setup" and p["status"] == "ready"
    assert p["span"]["label"] == "Nov 2 - Feb 12"
    ms = {m["code"]: m for m in p["milestones"]}
    assert [c for c in ms] == ["M1", "M2", "M3"]
    assert (ms["M2"]["start_date"], ms["M2"]["end_date"]) == ("2026-11-30", "2026-12-25")
    assert [m["effort_weeks"] for m in p["milestones"]] == [8, 8, 12]
    full = (await client.get(url("guided-setup"), headers=ctx.as_(role))).json()
    assert [m["planned_weeks"] for m in p["milestones"]] == [
        m["planned_weeks"] for m in full["milestones"]
    ]
    assert p["goal_weeks"] == full["goal_weeks"]
    assert {s["code"] for s in p["slices"]} == {s["code"] for s in full["slices"]}
    # Each slice once: the goal weeks add up to the planned weeks.
    assert sum(w["weeks"] for w in p["goal_weeks"]) == sum(
        m["planned_weeks"] for m in p["milestones"]
    )


async def test_priority_rows_say_whether_they_are_in_the_plan(client):
    ctx = await make_ctx()
    ids = await seed(ctx, items=("f-03",))
    async with tenant_session(ctx.tenant_id) as s:
        f03 = await s.scalar(select(RoadmapItem).where(RoadmapItem.item_key == "f-03"))
        mine = await Seed(s).entity("feature", "setup-steps", effort=2)
        other = await Seed(s).entity("feature", "loose-end", effort=1)
        f03.feature_id = mine.id
        # An item of the same roadmap that no PRD's plan holds.
        s.add(RoadmapItem(roadmap_document_id=f03.roadmap_document_id,
                          roadmap_version_id=f03.roadmap_version_id, item_key="loose",
                          title="Loose end", horizon="now", position=1, feature_id=other.id,
                          track_id=ids["track"]))  # fmt: skip
        await s.commit()
    r = await client.get("/v1/simple/priorities", headers=ctx.as_("viewer"))
    assert r.status_code == 200, r.text
    got = {row["code"]: row.get("in_plan") for row in r.json()["rows"]}
    assert got == {"f-03": True, "loose": False}


@pytest.mark.parametrize(
    ("role", "status"),
    [("owner", "applied"), ("decider", "applied"), ("approver", "proposed"),
     ("commenter", "proposed"), ("viewer", None)],
)  # fmt: skip
async def test_accept_a_slice_per_role(client, role, status):
    ctx = await make_ctx()
    await seed(ctx, items=("f-03",))
    async with tenant_session(ctx.tenant_id) as s:
        await suggestions.regenerate(s)
        await s.commit()
    rows = (await client.get("/v1/simple/roadmap/date-suggestions",
                             headers=ctx.as_(role))).json()  # fmt: skip
    first = next(r for r in rows if r["slice_code"] == "F-03a")
    r = await client.post(
        f"/v1/simple/roadmap/date-suggestions/{first['id']}/accept", headers=ctx.as_(role)
    )
    if status is None:
        assert r.status_code == 403, r.text
        return
    assert r.status_code == 200, r.text
    change = r.json()["change"]
    assert change["status"] == status
    assert (change["after"]["start_date"], change["after"]["end_date"]) == (
        "2026-11-16", "2026-12-18",
    )  # fmt: skip
    async with tenant_session(ctx.tenant_id) as s:
        states = {x.slice_code: x.status for x in await s.scalars(select(RoadmapDateSuggestion))}
    assert states == (
        {"F-03a": "accepted", "F-03b": "accepted"}
        if status == "applied"
        else {"F-03a": "open", "F-03b": "open"}
    )


async def test_dismissing_a_slice_dismisses_the_item(client):
    """Train Z review: the tray shows one row per item (BGD, 2026-10-28), so Dismiss on its
    first slice's suggestion dismisses every open slice of the item; the roadmap then shows
    no suggestion for it (never the next slice's dates), and a refresh does not reopen one."""
    ctx = await make_ctx()
    await seed(ctx, items=("f-03",))
    async with tenant_session(ctx.tenant_id) as s:
        await suggestions.regenerate(s)
        await s.commit()
    rows = (await client.get("/v1/simple/roadmap/date-suggestions",
                             headers=ctx.as_("owner"))).json()  # fmt: skip
    first = next(r for r in rows if r["slice_code"] == "F-03a")
    r = await client.post(
        f"/v1/simple/roadmap/date-suggestions/{first['id']}/dismiss", headers=ctx.as_("owner")
    )
    assert r.status_code == 200, r.text
    async with tenant_session(ctx.tenant_id) as s:
        states = {x.slice_code: x.status for x in await s.scalars(select(RoadmapDateSuggestion))}
    assert states == {"F-03a": "dismissed", "F-03b": "dismissed"}
    roadmap = (await client.get("/v1/simple/roadmap", headers=ctx.as_("owner"))).json()
    item = next(i for i in roadmap["items"] if i["key"] == "f-03")
    assert item["suggestion"] is None
    async with tenant_session(ctx.tenant_id) as s:
        await suggestions.regenerate(s)
        await s.commit()
        assert {x.status for x in await s.scalars(select(RoadmapDateSuggestion))} == {"dismissed"}


PROSE_ANSWER = {
    "milestones": [
        {"code": "M1", "name": "Prove it", "start": "2026-11-09", "end": "2026-12-04",
         "effort_weeks": 6, "done_when": [], "targets": []},
    ],
    "features": [
        {"code": "F-03", "name": "Invite teammates", "milestones": ["M1"], "effort": [2],
         "goals": ["Growth"], "order": ["first"], "pm_owned": False},
    ],
    "goals": ["Growth"],
    "holidays": [],
}  # fmt: skip


async def test_approving_a_version_reads_its_plan(client):
    ctx = await make_ctx()
    ids = await seed(ctx, items=("f-03",))
    async with tenant_session(ctx.tenant_id) as s:
        prd = await s.get(Document, ids["prd"])
        await version(s, prd, 2, "# Guided setup\n\nInvites first, in four weeks.\n",
                      approved=False)  # fmt: skip
        await s.commit()
    r = await client.post("/v1/documents/guided-setup/versions/2/approve", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text

    async def ask(kind, payload):
        return PROSE_ANSWER

    async with tenant_session(ctx.tenant_id) as s:
        job = await s.scalar(select(LlmJob).where(LlmJob.kind == "prd_plan"))
        assert job is not None, "approving the version queues the plan's job"
        assert (await plan.run_job(s, job, ask))["read"] is True
        await s.commit()
    body = (await client.get("/v1/simple/roadmap", headers=ctx.as_("viewer"))).json()
    assert body["span"]["label"] == "Nov 9 - Dec 4"
    (item,) = body["items"]
    assert [x["code"] for x in item["slices"]] == ["F-03"]


async def test_reading_the_plan_writes_nothing(client):
    ctx = await make_ctx()
    await seed(ctx, "# Guided setup\n\nInvites first.\n")
    r = await client.get(url("guided-setup"), headers=ctx.as_("viewer"))
    assert r.status_code == 200, r.text
    assert r.json()["milestones"] == []
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.scalar(select(func.count()).select_from(SimplePrdPlan)) == 0
        jobs = select(func.count()).select_from(LlmJob).where(LlmJob.kind == "prd_plan")
        assert await s.scalar(jobs) == 0


async def test_dates_to_confirm_show_what_accept_applies(client):
    ctx = await make_ctx()
    await seed(ctx, items=("f-03",))
    async with tenant_session(ctx.tenant_id) as s:
        await suggestions.regenerate(s)
        await s.commit()
    body = (await client.get("/v1/simple/roadmap", headers=ctx.as_("owner"))).json()
    (item,) = body["items"]
    shown = item["suggestion"]
    assert (shown["start_date"], shown["end_date"]) == ("2026-11-16", "2026-12-18")
    r = await client.post(
        f"/v1/simple/roadmap/date-suggestions/{shown['id']}/accept", headers=ctx.as_("owner")
    )
    assert r.status_code == 200, r.text
    after = r.json()["change"]["after"]
    assert (after["start_date"], after["end_date"]) == (shown["start_date"], shown["end_date"])


async def test_this_quarters_weeks_follow_the_plan(client):
    ctx = await make_ctx()
    await seed(ctx, items=("f-03",))
    async with tenant_session(ctx.tenant_id) as s:
        feature = Entity(type="feature", key="invite-teammates", title="Invite teammates",
                         status="confirmed", origin="user", attrs={"effort": 5})  # fmt: skip
        s.add(feature)
        await s.flush()
        row = await s.scalar(select(RoadmapItem).where(RoadmapItem.item_key == "f-03"))
        row.feature_id, row.horizon = feature.id, "later"
        await s.commit()
    r = await client.get("/v1/simple/priorities", headers=ctx.as_("viewer"))
    assert r.status_code == 200, r.text
    weeks = {b["key"]: b["weeks"] for b in r.json()["buckets"]}
    assert sum(weeks.values()) == 5.0, weeks


async def test_chat_this_quarter_is_the_plans_span(client):
    from tests.test_simple_chat_api import say

    ctx = await make_ctx()
    await seed(ctx, items=("f-03",))
    m = await say(client, ctx, "owner", "move F-03 to this quarter")
    assert m["kind"] == "cards", m["body"]
    (card,) = m["cards"]
    assert card["after"] == {"start_date": "2026-11-02", "end_date": "2027-02-12"}


async def test_views_parse_a_version_once(client, monkeypatch):
    ctx = await make_ctx()
    ids = await seed(ctx)
    calls = []
    real = plan.parse

    def counted(text, ref):
        calls.append(ref)
        return real(text, ref)

    monkeypatch.setattr(plan, "parse", counted)
    async with tenant_session(ctx.tenant_id) as s:
        first = await plan.views(s, {ids["prd"]})
        again = await plan.views(s, {ids["prd"]})
    assert first[ids["prd"]].span == again[ids["prd"]].span
    assert len(calls) <= 1
