"""#730 review: the Simple stack's owner decisions (D-a..D-d, 2026-10-26) and review
findings, against Postgres. Built on S3a's and S3b's worlds (tests.test_simple_changes_api,
tests.test_simple_drafts_api): one roadmap, approved version 1, people of every role,
``decider`` (an approver the review policy names) and ``reviewer2``.

Test cards (protects / fails_when / no_claim):

- test_detailed_approve_settles_the_draft: protects=S3b-1, approving the submitted
  version in the Detailed view (the ordinary approve route) settles the Simple draft: it
  is approved, the required reviewer's Inbox request closes, Simple shows the new version,
  and a new Simple change is accepted again; fails_when=the draft stays submitted and the
  roadmap locked; no_claim=the Detailed view's screen.
- test_absent_reviewer_section_review_settles: protects=S3b-1, a required reviewer absent
  from Simple who approves every section through the Detailed section review settles the
  draft once nothing blocks (the decider approved in Simple); then the roadmap takes
  changes; fails_when=the version never publishes or the roadmap stays locked;
  no_claim=reviewer attendance (S8).
- test_a_blocking_verdict_returns_the_draft (changes_requested, rejected): protects=S3b-1,
  a reviewer's changes requested or rejection of a section returns the draft to working:
  its changes kept and undoable again, the version marked withdrawn and refused by the
  ordinary approve, new changes accepted, a new submit making the next version;
  fails_when=the draft stays submitted or loses its changes; no_claim=feedback threads.
- test_any_non_approved_verdict_returns_the_draft (required, optional x changes_requested,
  rejected): protects=the owner decision of 2026-10-26 (#734 review), any verdict other
  than approved, on a required or an optional section, returns the draft to working, its
  changes kept and undoable, the version marked withdrawn; fails_when=an optional section's
  verdict leaves the draft submitted; no_claim=which sections a template requires.
- test_withdraw (author, decider): protects=S3b-1, the draft's author or the decider
  withdraws a submitted draft back to working (a required reviewer 403, a commenter 404),
  the version is marked withdrawn and can't be approved, and the roadmap takes new
  changes; fails_when=someone else withdraws or the roadmap stays locked; no_claim=the web.
- test_track_owner_decides_only_as_approver (viewer, commenter, approver): protects=D-a,
  with no decider the item's track owner applies and decides suggestions only when their
  role is approver or owner; a viewer or commenter track owner decides nothing and their
  proposals (and others') go to the company's owners; fails_when=a viewer or commenter
  track owner decides or is routed to; no_claim=drafts of roadmaps with several tracks.
- test_open_proposals_follow_the_current_decider: protects=S3a-minor, a proposal made with
  no decider is routed to the decider named afterwards (the change and the Inbox), who
  accepts it; fails_when=routed_to stays the proposal-time route; no_claim=notifications.
- test_suggestions_go_through_the_change_engine: protects=D-b, accepting or editing a date
  suggestion writes a change (accept_date_suggestion, the edit variant edited) into the
  working draft, never the published rows; undo reopens the suggestion; a non-decider's
  accept is a proposal that writes nothing; fails_when=any route writes the published
  version's dates; no_claim=the MCP transport (tools are the routes).
- test_stale_suggestion_is_409_outdated: protects=S2-minor, a suggestion accepted after
  tracker or engineering dates arrived answers 409 outdated and writes nothing;
  fails_when=the arriving dates are overwritten; no_claim=which source wins (S2).
- test_dismissed_quiet_30_days_and_never_the_same_dates: protects=D-c, after a dismissal
  no suggestion for 30 days, then a new one only with other dates, never the dismissed
  ones; fails_when=a suggestion comes back early or repeats; no_claim=the rule's dates.
- test_copied_forward_keeps_accepted_dates_and_risks: protects=S2-M1, the next version's
  copied items keep start_date, end_date, date_source, accepted_risks and draft;
  fails_when=they are lost; no_claim=items files that set them anew.
- test_concurrent_starts_and_refreshes_are_not_500: protects=S2/S3a-minor, two "start a
  session" calls of one person reuse one session, two refreshes both answer, neither 500;
  fails_when=a unique index surfaces as 500; no_claim=other tables.
- test_failed_daily_regeneration_backs_off: protects=S2-minor, a failed daily run retries
  after an hour, then waits for the next day; fails_when=it retries every minute;
  no_claim=the ticker's own scheduling.
- test_fix_locks_dependents_before_reading: protects=S3a-minor, a fix locks every item it
  may move before service.load reads them; fails_when=a dependent is locked only after the
  read; no_claim=Postgres lock modes.
- test_approve_in_meeting_with_different_deciders: protects=S3b-minor, approving in a
  meeting approves the roadmaps the caller decides and reports the others instead of
  failing with 403; fails_when=the call fails whole; no_claim=the meeting screen (S8).
- test_draft_lists_its_changes: protects=D-d, the draft lists each change's author, time
  and whether it was made in a meeting; fails_when=a field is missing; no_claim=the web.
- test_roadmap_items_say_who_decides (commenter, approver track owner): protects=#723 S1
  Home review, each roadmap item says whether the caller decides it and names its deciders
  (the decider, else the deciding track owner, else the company's owners); fails_when=an
  approver decider is told someone else decides or a commenter's row names nobody;
  no_claim=the web (web/e2e/simple-home.spec.ts).
"""

import asyncio
import uuid
from datetime import date, timedelta

import pytest
from sqlalchemy import select

from oracle.auth.models import User
from oracle.docs.models import DocumentVersion, Section
from oracle.review.models import DocumentReviewPolicy
from oracle.roadmap import items as items_mod
from oracle.roadmap.models import RoadmapItem
from oracle.simple import changes as simple_changes
from oracle.simple import dates, drafts, service, suggestions
from oracle.simple.models import RoadmapDateSuggestion, SimpleChange, SimpleDraft, SimpleSession
from oracle.tenancy import tenant_session
from oracle.ticker import body as ticker_body
from tests.test_simple_changes_api import CHANGES, SESSIONS, World, make_people
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_drafts_api import (
    DRAFTS,
    TITLE,
    edit_title,
    inbox,
    published,
    roadmap,
    slug,
    the_draft,
    title_in,
    world,
)
from tests.test_simple_roadmap_api import NOW, SUGGESTIONS, Seed, by_key

DOCS = "/v1/documents"


async def submitted(client, w: World, who: str = "decider") -> dict:
    """The decider's title change, submitted: version 2 in review."""
    change = (await edit_title(client, w, who)).json()["change"]
    d = await the_draft(client, w)
    r = await client.post(f"{DRAFTS}/{d['id']}/submit", headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    return {"draft": r.json(), "change": change}


async def draft_row(w: World, draft_id: str) -> SimpleDraft:
    async with tenant_session(w.ctx.tenant_id) as s:
        return await s.get(SimpleDraft, uuid.UUID(draft_id))


async def version(w: World, n: int) -> DocumentVersion:
    async with tenant_session(w.ctx.tenant_id) as s:
        return await s.scalar(
            select(DocumentVersion).where(
                DocumentVersion.document_id == uuid.UUID(w.roadmap_id),
                DocumentVersion.number == n,
            )
        )


async def section_keys(w: World, n: int) -> list[str]:
    v = await version(w, n)
    async with tenant_session(w.ctx.tenant_id) as s:
        return list(
            await s.scalars(
                select(Section.section_key)
                .where(Section.version_id == v.id)
                .order_by(Section.ordinal)
            )
        )


async def unlocked(client, w: World) -> None:
    """The roadmap takes a new Simple change again (on the item as the shown version has
    it: an approved version's rows are new)."""
    item = by_key(await roadmap(client, w, "decider"))["move_dates-a"]
    r = await w.post(client, "decider", "move_dates", target={"item_id": item["id"]})
    assert r.status_code == 201, r.text
    assert r.json()["change"]["status"] == "applied"


async def test_detailed_approve_settles_the_draft(client):
    w = await world(reviewers=("approver",))
    d = (await submitted(client, w))["draft"]
    assert [x["draft_id"] for x in (await inbox(client, w, "approver"))["simple_approvals"]] == [
        d["id"]
    ]
    r = await client.post(
        f"{DOCS}/{await slug(w)}/versions/2/approve", headers=w.ctx.as_("decider")
    )
    assert r.status_code == 200, r.text
    row = await draft_row(w, d["id"])
    assert row.status == "approved" and row.approved_at is not None and row.waiting_on == []
    assert (await inbox(client, w, "approver"))["simple_approvals"] == []
    assert title_in(await roadmap(client, w, "viewer"), "edit_title-a") == "Ledger v2"
    await unlocked(client, w)


async def test_absent_reviewer_section_review_settles(client):
    w = await world(reviewers=("approver",))
    d = (await submitted(client, w))["draft"]
    r = await client.post(f"{DRAFTS}/{d['id']}/approve", headers=w.ctx.as_("decider"))
    assert r.status_code == 200 and r.json()["status"] == "submitted", r.text
    for key in await section_keys(w, 2):
        r = await client.put(
            f"{DOCS}/{await slug(w)}/versions/2/sections/{key}/review",
            json={"verdict": "approved"},
            headers=w.ctx.as_("approver"),
        )
        assert r.status_code in (200, 201), r.text
    row = await draft_row(w, d["id"])
    assert row.status == "approved", row.status
    assert title_in(await roadmap(client, w, "viewer"), "edit_title-a") == "Ledger v2"
    await unlocked(client, w)


@pytest.mark.parametrize("verdict", ["changes_requested", "rejected"])
async def test_a_blocking_verdict_returns_the_draft(client, verdict):
    w = await world(reviewers=("approver",))
    s = await submitted(client, w)
    d, change = s["draft"], s["change"]
    key = (await section_keys(w, 2))[0]
    r = await client.put(
        f"{DOCS}/{await slug(w)}/versions/2/sections/{key}/review",
        json={"verdict": verdict, "note": "Not this quarter"},
        headers=w.ctx.as_("approver"),
    )
    assert r.status_code in (200, 201), r.text
    row = await draft_row(w, d["id"])
    assert row.status == "working" and row.version_id is None
    assert (await the_draft(client, w))["changes"] == 1
    v2 = await version(w, 2)
    assert any(n.get("code") == drafts.WITHDRAWN for n in v2.notes)
    r = await client.post(
        f"{DOCS}/{await slug(w)}/versions/2/approve", headers=w.ctx.as_("decider")
    )
    assert r.status_code == 409, r.text
    assert title_in(await roadmap(client, w, "viewer"), "edit_title-a") == TITLE
    assert title_in(await roadmap(client, w, "decider"), "edit_title-a") == "Ledger v2"
    await unlocked(client, w)
    r = await client.post(f"{CHANGES}/{change['id']}/undo", headers=w.ctx.as_("decider"))
    assert r.status_code == 201, r.text
    r = await client.post(f"{DRAFTS}/{d['id']}/submit", headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    assert r.json()["version"] == 3


async def required_keys(w: World, n: int) -> set[str]:
    """The required sections of version ``n`` (the template's, its modules' and the policy's)."""
    from oracle.docs.models import Document
    from oracle.review.state import effective_policy, required_sections

    v = await version(w, n)
    async with tenant_session(w.ctx.tenant_id) as s:
        doc = await s.get(Document, v.document_id)
        return set(await required_sections(s, doc, v, await effective_policy(s, doc)))


@pytest.mark.parametrize("section", ["required", "optional"])
@pytest.mark.parametrize("verdict", ["changes_requested", "rejected"])
async def test_any_non_approved_verdict_returns_the_draft(client, section, verdict):
    # Owner decision 2026-10-26 (#734 review): a required or an optional section's
    # verdict other than approved returns the draft, its changes kept and undoable.
    w = await world(reviewers=("approver",))
    s = await submitted(client, w)
    d, change = s["draft"], s["change"]
    keys = await section_keys(w, 2)
    if section == "required":
        # The policy makes the version's first section required.
        async with tenant_session(w.ctx.tenant_id) as db:
            p = await db.scalar(
                select(DocumentReviewPolicy).where(
                    DocumentReviewPolicy.document_id == uuid.UUID(w.roadmap_id)
                )
            )
            p.required_section_keys = [keys[0]]
            await db.commit()
    required = await required_keys(w, 2)
    pick = [k for k in keys if (k in required) == (section == "required")]
    assert pick, (section, keys, required)
    r = await client.put(
        f"{DOCS}/{await slug(w)}/versions/2/sections/{pick[0]}/review",
        json={"verdict": verdict, "note": "Not this quarter"},
        headers=w.ctx.as_("approver"),
    )
    assert r.status_code in (200, 201), r.text
    row = await draft_row(w, d["id"])
    assert row.status == "working" and row.version_id is None
    assert (await the_draft(client, w))["changes"] == 1
    assert any(n.get("code") == drafts.WITHDRAWN for n in (await version(w, 2)).notes)
    r = await client.post(f"{CHANGES}/{change['id']}/undo", headers=w.ctx.as_("decider"))
    assert r.status_code == 201, r.text


@pytest.mark.parametrize("author", ["owner", "decider"])
async def test_withdraw(client, author):
    w = await world(reviewers=("approver",))
    s = await submitted(client, w, who=author)
    d, change = s["draft"], s["change"]
    url = f"{DRAFTS}/{d['id']}/withdraw"
    for who, code in (("commenter", 404), ("approver", 403)):
        r = await client.post(url, headers=w.ctx.as_(who))
        assert r.status_code == code, (who, r.text)
    who = "owner" if author == "owner" else "decider"
    r = await client.post(url, headers=w.ctx.as_(who))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "working" and r.json()["version"] is None
    assert (await client.post(url, headers=w.ctx.as_(who))).status_code == 409
    v2 = await version(w, 2)
    assert any(n.get("code") == drafts.WITHDRAWN for n in v2.notes)
    r = await client.post(
        f"{DOCS}/{await slug(w)}/versions/2/approve", headers=w.ctx.as_("decider")
    )
    assert r.status_code == 409, r.text
    assert (await inbox(client, w, "approver"))["simple_approvals"] == []
    await unlocked(client, w)
    r = await client.post(f"{CHANGES}/{change['id']}/undo", headers=w.ctx.as_(author))
    assert r.status_code == 201, r.text


@pytest.mark.parametrize("owner_role", ["viewer", "commenter", "approver"])
async def test_track_owner_decides_only_as_approver(client, owner_role):
    ctx = await make_people()
    async with tenant_session(ctx.tenant_id) as s:
        u = User(email="trackowner@example.com", name="Tao Owner", password_hash="x",
                 role=owner_role)  # fmt: skip
        s.add(u)
        await s.commit()
        ctx.users["trackowner"] = u
    w = await World(ctx).build(decider=False, track_owner="trackowner",
                               ops=["edit_title", "accept_date_suggestion"])  # fmt: skip
    decides = owner_role == "approver"
    listed = (await client.get(SUGGESTIONS, headers=ctx.as_("trackowner"))).json()
    assert {x["can_decide"] for x in listed} == {decides}
    r = await w.post(client, "trackowner", "edit_title")
    if owner_role == "viewer":
        assert r.status_code == 403, r.text
    else:
        assert r.status_code == 201, r.text
        assert r.json()["change"]["status"] == ("applied" if decides else "proposed")
    # The commenter reads the published title (the track owner's draft is not theirs).
    r = await w.post(client, "commenter", "edit_title", after={"title": "Ledger v3"})
    assert r.status_code == 201, r.text
    routed = [str(ctx.users["trackowner" if decides else "owner"].id)]
    assert r.json()["change"]["routed_to"] == routed
    sid = w.suggestion["accept_date_suggestion-u"]
    r = await client.post(f"{SUGGESTIONS}/{sid}/dismiss", headers=ctx.as_("trackowner"))
    assert r.status_code == (200 if decides else 403), r.text


async def test_open_proposals_follow_the_current_decider(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=False, ops=["edit_title"])
    prop = (await w.post(client, "commenter", "edit_title")).json()["change"]
    assert prop["routed_to"] == [str(ctx.users["owner"].id)]
    async with tenant_session(ctx.tenant_id) as s:
        s.add(DocumentReviewPolicy(document_id=uuid.UUID(w.roadmap_id),
                                   decider_id=ctx.users["decider"].id))  # fmt: skip
        await s.commit()
    listed = (await client.get(CHANGES, headers=ctx.as_("decider"))).json()
    [row] = [c for c in listed if c["id"] == prop["id"]]
    assert row["routed_to"] == [str(ctx.users["decider"].id)] and row["can_decide"]
    waiting = (await inbox(client, w, "decider"))["simple_proposals"]
    assert [x["id"] for x in waiting] == [prop["id"]]
    assert (await inbox(client, w, "owner"))["simple_proposals"] == []
    r = await client.post(f"{CHANGES}/{prop['id']}/accept", headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text


async def test_suggestions_go_through_the_change_engine(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["move_dates", "edit_title"])
    owner = ctx.as_("owner")
    rows = {r["item_key"]: r for r in (await client.get(SUGGESTIONS, headers=owner)).json()}
    a, b = rows["move_dates-u"], rows["edit_title-u"]
    # A non-decider's accept is a proposal: nothing is written, the suggestion stays open.
    r = await client.post(f"{SUGGESTIONS}/{a['id']}/accept", headers=ctx.as_("approver"))
    assert r.status_code == 200, r.text
    assert r.json()["change"]["status"] == "proposed"
    r = await client.post(f"{SUGGESTIONS}/{a['id']}/accept", headers=owner)
    assert r.status_code == 200, r.text
    accepted = r.json()["change"]
    assert accepted["op"] == "accept_date_suggestion" and accepted["status"] == "applied"
    assert len(accepted["draft_ids"]) == 1
    r = await client.post(f"{SUGGESTIONS}/{b['id']}/edit", headers=owner,
                          json={"start_date": "2026-11-02", "end_date": "2026-11-30"})  # fmt: skip
    assert r.status_code == 200, r.text
    edited = r.json()["change"]
    assert edited["after"]["start_date"] == "2026-11-02"
    async with tenant_session(ctx.tenant_id) as s:
        statuses = {x.id: x.status for x in await s.scalars(select(RoadmapDateSuggestion))}
        assert statuses[uuid.UUID(a["id"])] == "accepted"
        assert statuses[uuid.UUID(b["id"])] == "edited"
        ops = [c.op for c in await s.scalars(select(SimpleChange).order_by(SimpleChange.at))]
        assert ops.count("accept_date_suggestion") == 3
    # The published rows stay undated: the dates are in the working draft.
    for key in ("move_dates-u", "edit_title-u"):
        row = await published(w, key)
        assert (row.start_date, row.end_date, row.date_source) == (None, None, None), key
    items = by_key(await roadmap(client, w, "owner"))
    assert items["edit_title-u"]["start"]["date"] == "2026-11-02"
    assert items["edit_title-u"]["start"]["source"] == "accepted"
    assert by_key(await roadmap(client, w, "viewer"))["edit_title-u"]["estimated"] is True
    # Undo reopens the suggestion.
    r = await client.post(f"{CHANGES}/{edited['id']}/undo", headers=owner)
    assert r.status_code == 201, r.text
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(RoadmapDateSuggestion, uuid.UUID(b["id"]))).status == "open"


async def test_stale_suggestion_is_409_outdated(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["move_dates"])
    sid = w.suggestion["move_dates-u"]
    # Tracker dates arrive after the suggestion was made.
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(RoadmapItem, uuid.UUID(w.ids["move_dates-u"]))
        row.start_date, row.end_date, row.date_source = (
            date(2026, 12, 1),
            date(2026, 12, 20),
            "tracker",
        )
        await s.commit()
    r = await client.post(f"{SUGGESTIONS}/{sid}/accept", headers=ctx.as_("owner"))
    assert r.status_code == 409, r.text
    assert "outdated" in r.text
    row = await w.item("move_dates-u")
    assert (row.start_date, row.date_source) == (date(2026, 12, 1), "tracker")


async def test_dismissed_quiet_30_days_and_never_the_same_dates(client, clock, monkeypatch):
    fixed = {"start": date(2026, 11, 9), "end": date(2026, 12, 4)}
    monkeypatch.setattr(
        dates, "suggest", lambda *a, **k: dates.Suggestion(fixed["start"], fixed["end"], "rule")
    )
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["move_dates"])
    sid = w.suggestion["move_dates-u"]
    r = await client.post(f"{SUGGESTIONS}/{sid}/dismiss", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text

    async def offered() -> list[RoadmapDateSuggestion]:
        async with tenant_session(ctx.tenant_id) as s:
            await suggestions.regenerate(s)
            await s.commit()
            return list(
                await s.scalars(
                    select(RoadmapDateSuggestion).where(
                        RoadmapDateSuggestion.item_id == uuid.UUID(w.ids["move_dates-u"]),
                        RoadmapDateSuggestion.status == "open",
                    )
                )
            )

    fixed["start"] = date(2026, 11, 16)
    for days in (1, 29):
        clock["now"] = NOW + timedelta(days=days)
        assert await offered() == [], days
    # After 30 days: the dismissed dates never again; other dates again.
    fixed["start"] = date(2026, 11, 9)
    clock["now"] = NOW + timedelta(days=31)
    assert await offered() == []
    fixed["start"] = date(2026, 11, 16)
    [again] = await offered()
    assert again.start_date == date(2026, 11, 16)


async def test_copied_forward_keeps_accepted_dates_and_risks():
    for f in ("start_date", "end_date", "date_source", "accepted_risks", "draft"):
        assert f in items_mod.COPIED, f
    ctx = await make_people()
    risk = {"flag": "dependency_order", "subject": None, "note": "Beta week"}
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, rm, rv = await seed.roadmap("payments")
        await seed.item(rv, pv, "ledger", start_date=date(2026, 11, 2),
                        end_date=date(2026, 11, 30), date_source="accepted",
                        accepted_risks=[risk], draft=True)  # fmt: skip
        body = "# payments v2\n\nledger\n"
        v2 = await seed.add(
            DocumentVersion(document_id=rm.id, number=2, markdown=body, content_hash="h2")
        )
        assert await items_mod.carry_forward(s, v2) == 1
        row = await s.scalar(select(RoadmapItem).where(RoadmapItem.roadmap_version_id == v2.id))
        assert (row.start_date, row.end_date, row.date_source) == (
            date(2026, 11, 2),
            date(2026, 11, 30),
            "accepted",
        )
        assert row.accepted_risks == [risk] and row.draft is True


async def test_concurrent_starts_and_refreshes_are_not_500(client):
    ctx = await make_people()
    await World(ctx).build(decider=True, ops=["move_dates"])
    me = drafts.Principal(tenant_id=ctx.tenant_id, kind="user", role="approver",
                          user_id=ctx.users["decider"].id)  # fmt: skip
    # Two "start a session" calls cross: the second waits for the first and reuses it.
    async with tenant_session(ctx.tenant_id) as s1, tenant_session(ctx.tenant_id) as s2:
        first = await simple_changes.start_session(s1, me, "editing")
        second = asyncio.create_task(simple_changes.start_session(s2, me, "editing"))
        await asyncio.sleep(0.3)
        await s1.commit()
        assert (await second).id == first.id
        await s2.commit()
    # Two refreshes of one item's suggestion cross: neither fails on the unique index.
    async with tenant_session(ctx.tenant_id) as s:
        await s.execute(RoadmapDateSuggestion.__table__.delete())
        await s.commit()
    async with tenant_session(ctx.tenant_id) as s1, tenant_session(ctx.tenant_id) as s2:
        await suggestions.regenerate(s1)
        other = asyncio.create_task(suggestions.regenerate(s2))
        await asyncio.sleep(0.3)
        await s1.commit()
        await other
        await s2.commit()
    r = await client.post(f"{SUGGESTIONS}/refresh", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text


async def test_failed_daily_regeneration_backs_off(clock, monkeypatch):
    ctx = await make_people()
    calls: list = []

    async def boom(db):
        calls.append(1)
        raise RuntimeError("the read failed")

    monkeypatch.setattr(suggestions, "regenerate", boom)

    async def tick(minutes: int) -> None:
        clock["now"] = NOW + timedelta(minutes=minutes)
        async with tenant_session(ctx.tenant_id) as s:
            await ticker_body.tick_company(s, ctx.tenant_id)

    await tick(0)
    assert len(calls) == 1
    for m in (1, 2, 30, 59):
        await tick(m)
    assert len(calls) == 1
    await tick(61)
    assert len(calls) == 2
    for m in (62, 120, 180):
        await tick(m)
    assert len(calls) == 2
    await tick(24 * 60 + 1)
    assert len(calls) == 3


async def test_fix_locks_dependents_before_reading(client, monkeypatch):
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["shift_dependents"])
    # A third item depends on -b and overlaps it: the fix moves it too.
    async with tenant_session(ctx.tenant_id) as s:
        b = await s.get(RoadmapItem, uuid.UUID(w.ids["shift_dependents-b"]))
        c = RoadmapItem(roadmap_document_id=b.roadmap_document_id,
                        roadmap_version_id=b.roadmap_version_id, item_key="shift_dependents-c",
                        title="C", horizon="now", position=50, track_id=b.track_id,
                        prd_document_id=b.prd_document_id, prd_version_id=b.prd_version_id,
                        start_date=date(2026, 12, 1), end_date=date(2026, 12, 20),
                        date_source="typed", depends_on=["shift_dependents-b"])  # fmt: skip
        s.add(c)
        await s.commit()
        cid = c.id
    events: list = []
    lock, load = simple_changes._lock, service.load

    async def spy_lock(db, ids):
        events.append(("lock", set(ids)))
        return await lock(db, ids)

    async def spy_load(db, overlays=None):
        events.append(("load", None))
        return await load(db, overlays)

    monkeypatch.setattr(simple_changes, "_lock", spy_lock)
    monkeypatch.setattr(service, "load", spy_load)
    r = await w.post(client, "decider", "shift_dependents")
    assert r.status_code == 201, r.text
    first_load = next(i for i, e in enumerate(events) if e[0] == "load")
    locked = set().union(*[e[1] for e in events[:first_load] if e[0] == "lock"])
    assert cid in locked


async def test_approve_in_meeting_with_different_deciders(client):
    w = await world()
    ctx = w.ctx
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, rm2, rv2 = await seed.roadmap("growth")
        other = await seed.item(rv2, pv, "growth-a")
        s.add(DocumentReviewPolicy(document_id=rm2.id, decider_id=ctx.users["approver"].id))
        await s.commit()
        other_id, rm2_id = str(other.id), rm2.id
    meeting = await client.post(SESSIONS, json={"kind": "meeting"}, headers=ctx.as_("owner"))
    sid = meeting.json()["id"]
    assert (await edit_title(client, w, "owner", session_id=sid)).status_code == 201
    r = await client.post(CHANGES, headers=ctx.as_("owner"), json={
        "op": "edit_title", "session_id": sid, "target": {"item_id": other_id},
        "before": {"title": "Growth A"}, "after": {"title": "Growth B"}})  # fmt: skip
    assert r.status_code == 201, r.text
    async with tenant_session(ctx.tenant_id) as s:
        session = await s.get(SimpleSession, uuid.UUID(sid))
        out = await drafts.approve_in_meeting(s, session, ctx.users["decider"].id, [])
        await s.commit()
    assert [d.status for d in out.drafts] == ["approved"]
    assert [x.document.id for x in out.not_approved] == [rm2_id]
    assert title_in(await roadmap(client, w, "viewer"), "edit_title-a") == "Ledger v2"


async def test_draft_lists_its_changes(client):
    w = await world()
    meeting = await client.post(SESSIONS, json={"kind": "meeting"}, headers=w.ctx.as_("decider"))
    assert (
        await edit_title(client, w, "decider", session_id=meeting.json()["id"])
    ).status_code == 201
    r = await w.post(client, "owner", "move_dates")
    assert r.status_code == 201, r.text
    d = await the_draft(client, w)
    log = {c["op"]: c for c in d["change_log"]}
    assert set(log) == {"edit_title", "move_dates"}
    assert log["edit_title"]["by"] == str(w.ctx.users["decider"].id)
    assert log["edit_title"]["by_name"] == "Dee Cider"
    assert log["edit_title"]["in_meeting"] is True
    assert log["edit_title"]["session_kind"] == "meeting"
    assert log["move_dates"]["in_meeting"] is False and log["move_dates"]["at"]
    assert log["move_dates"]["by"] == str(w.ctx.users["owner"].id)


@pytest.mark.parametrize("owner_role", ["commenter", "approver"])
async def test_roadmap_items_say_who_decides(client, owner_role):
    """#723 S1 Home review: each item of the roadmap read says whether the caller decides it
    (service.can_decide) and the deciders' names (the decider, else the deciding track
    owner, else the company's owners), so Simple's Home applies or proposes the broken-link
    fixes and names who decides."""
    ctx = await make_people()
    async with tenant_session(ctx.tenant_id) as s:
        u = User(email="trackowner@example.com", name="Tao Owner", password_hash="x",
                 role=owner_role)  # fmt: skip
        s.add(u)
        await s.commit()
        ctx.users["trackowner"] = u
    w = await World(ctx).build(decider=False, track_owner="trackowner", ops=["edit_title"])
    owners = [ctx.users["owner"].name or ctx.users["owner"].email]
    named = ["Tao Owner"] if owner_role == "approver" else owners
    for who, decides in [("trackowner", owner_role == "approver"), ("commenter", False),
                         ("owner", True)]:  # fmt: skip
        item = by_key(await roadmap(client, w, who))["edit_title-a"]
        assert (item["can_decide"], item["deciders"]) == (decides, named), who
    async with tenant_session(ctx.tenant_id) as s:
        s.add(DocumentReviewPolicy(document_id=uuid.UUID(w.roadmap_id),
                                   decider_id=ctx.users["decider"].id))  # fmt: skip
        await s.commit()
    for who, decides in [("decider", True), ("trackowner", False), ("commenter", False)]:
        item = by_key(await roadmap(client, w, who))["edit_title-a"]
        assert (item["can_decide"], item["deciders"]) == (decides, ["Dee Cider"]), who
