"""The owner's production walk (#723, 2026-10-27): flows that show up, the Ask thread per
page, the PRD's F-codes, the ritual's real attendees. Against Postgres; jobs run with fakes.

Test cards (protects / fails_when / no_claim):

- test_flow_failed_then_retry_then_drawn: protects=a visual whose drawing job failed reads
  ``failed`` (with a reason) and not ``pending``; Retry (asking again) queues a new job,
  reads ``pending`` and not ``failed``; once drawn it reads version 1, neither pending nor
  failed; an answer that does not check out also reads ``failed``; viewers read the
  failure but may not retry (can_revise false); fails_when=a finished job keeps the panel
  drawing, a failure reads as "No flow yet", or Retry queues nothing; no_claim=the web's
  polling (the Playwright spec).
- test_ask_thread_per_page_per_role: protects=each role's Ask thread is keyed by person AND
  page: lines asked on the Roadmap show on the Roadmap only, a new page (Priorities)
  starts empty, Home (no page) is its own page, a query string is the same page, and the
  old per-person thread (``/simple/ask/<me>``) is no page's; fails_when=one thread
  follows a person across pages or the old thread shows on a page; no_claim=meeting
  chats (unchanged: test_simple_chat_api).
- test_prd_codes_on_priorities: protects=a feature whose roadmap item was imported from a
  PRD section with a code ("f-06") reads F-06 as its short code (rows, marks, buckets read
  it), the feature's own code wins, initials stay for items with no PRD code, and a PRD
  code already taken falls back to initials; fails_when=a PRD-imported item reads
  initials; no_claim=the web's marks.
- test_item_card_names_the_prd_section: protects=the item card's reason reads "From <PRD>
  (draft N): F-06 <heading>." (the PRD code and the section's heading), and the item's
  name for a key that is no code with no heading (never "section <key>");
  fails_when=the card reads "section f-06"; no_claim=other reasons.
- test_next_review_lists_the_rituals_real_attendees: protects=the next review of a
  ritual lists its owner, its attendees and whoever attended the last review held from
  it (the meeting held had 3, the card says 3); fails_when=the card counts only the
  ritual's owner; no_claim=the ritual settings page.
"""

import uuid

from sqlalchemy import select

from oracle.auth.models import User
from oracle.discussions.models import Discussion
from oracle.docs.models import Section
from oracle.jobs.models import LlmJob
from oracle.rituals.models import Ritual
from oracle.simple import chat, service
from oracle.simple.priorities import prd_code, short_codes
from oracle.tenancy import tenant_session
from tests.test_simple_chat_api import ASK
from tests.test_simple_chat_api import World as ChatWorld
from tests.test_simple_chat_api import clock as clock  # noqa: F401
from tests.test_simple_chat_api import make_people as chat_people
from tests.test_simple_meetings_api import start, uid
from tests.test_simple_meetings_api import world as meeting_world
from tests.test_simple_meetings_walk import ritual
from tests.test_simple_one_pager_api import world as prd_world
from tests.test_simple_priorities_api import World as PriorityWorld
from tests.test_simple_priorities_api import make_people
from tests.test_simple_roadmap_api import Seed
from tests.test_simple_visuals_api import URL as VISUALS
from tests.test_simple_visuals_api import roadmap_world, run_visual_jobs, visual

# --------------------------------------------------------------------------- flows


async def _set_last_job(ctx, **kw) -> None:
    async with tenant_session(ctx.tenant_id) as s:
        job = await s.scalar(
            select(LlmJob)
            .where(LlmJob.kind == "simple_visual")
            .order_by(LlmJob.created_at.desc())
            .limit(1)
        )
        for k, v in kw.items():
            setattr(job, k, v)
        await s.commit()


async def test_flow_failed_then_retry_then_drawn(client):
    ctx = await prd_world(client)
    _, item = await roadmap_world(ctx)
    path = f"{VISUALS}/feature/{item.id}"
    r = await client.post(f"{path}/request", json={"brief": "The checklist"},
                          headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 202, r.text
    assert r.json()["pending"] is True and r.json()["failed"] is False
    # The job fails for good.
    await _set_last_job(ctx, status="failed", error="model unavailable")
    got = await visual(client, ctx, "owner", "feature", item.id)
    assert (got["pending"], got["failed"], got["flow"]) == (False, True, None)
    assert got["failure"] and got["can_revise"] is True
    seen = await visual(client, ctx, "viewer", "feature", item.id)
    assert seen["failed"] is True and seen["can_revise"] is False
    # Retry: a new job, drawing again.
    r = await client.post(f"{path}/request", json={"brief": "The checklist"},
                          headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 202, r.text
    assert (r.json()["pending"], r.json()["failed"]) == (True, False)
    # An answer that does not check out is a failure too.
    (out,) = await run_visual_jobs(ctx, {"title": ""})
    assert out["drawn"] is False
    got = await visual(client, ctx, "owner", "feature", item.id)
    assert (got["pending"], got["failed"]) == (False, True)
    # Retry once more: drawn.
    r = await client.post(f"{path}/request", json={}, headers=ctx.as_("owner"))
    assert r.status_code == 202 and r.json()["pending"] is True, r.text
    await run_visual_jobs(ctx)
    got = await visual(client, ctx, "commenter", "feature", item.id)
    assert (got["pending"], got["failed"], got["flow"]["version"]) == (False, False, 1)


# --------------------------------------------------------------------------- Ask per page


async def _thread(client, ctx, who: str, page: str | None) -> list[str]:
    r = await client.get(ASK.replace("/messages", ""), params={"page": page} if page else {},
                         headers=ctx.as_(who))  # fmt: skip
    assert r.status_code == 200, r.text
    return [m["body"] for m in r.json()["messages"] if m["author_kind"] == "person"]


async def test_ask_thread_per_page_per_role(client):
    ctx = await chat_people()
    await ChatWorld(ctx).build()
    for who in ("viewer", "commenter", "approver", "owner"):
        line = "Who owns Ledger v2?"
        r = await client.post(ASK, json={"text": line, "page": "/simple/roadmap"},
                              headers=ctx.as_(who))  # fmt: skip
        assert r.status_code == 200, r.text
        assert [m["body"] for m in r.json()["messages"] if m["author_kind"] == "person"] == [
            line
        ], who
        assert await _thread(client, ctx, who, "/simple/roadmap") == [line], who
        assert await _thread(client, ctx, who, "/simple/roadmap?prd=x") == [line], who
        assert await _thread(client, ctx, who, "/simple/priorities") == [], who
        assert await _thread(client, ctx, who, None) == [], who
        home = "When is Bulk import?"
        r = await client.post(ASK, json={"text": home}, headers=ctx.as_(who))
        assert r.status_code == 200, r.text
        assert await _thread(client, ctx, who, "/simple") == [home], who
        assert await _thread(client, ctx, who, "/simple/roadmap") == [line], who
    # The old per-person thread stays (readable) but shows on no page.
    me = ctx.users["owner"].id
    async with tenant_session(ctx.tenant_id) as s:
        old = Discussion(subject_kind="screen", subject={"path": f"/simple/ask/{me}"},
                         subject_key=f"screen:/simple/ask/{me}", title="Ask Oracle: changes",
                         visibility="private", author_only=True, origin="panel",
                         started_by=me)  # fmt: skip
        s.add(old)
        await s.commit()
        assert await s.get(Discussion, old.id) is not None
    assert await _thread(client, ctx, "owner", None) == ["When is Bulk import?"]
    assert chat.page_of(None) == chat.page_of("/plan") == "/simple"
    assert chat.page_of("/simple/one-pagers/abc/?x=1#y") == "/simple/one-pagers/abc"


# --------------------------------------------------------------------------- F-codes


def test_prd_code_and_short_codes():
    assert prd_code("f-06") == "F-06" and prd_code("F-30") == "F-30"
    assert prd_code("problem") is None and prd_code(None) is None
    keys = ["delivery-integrity", "F-12", "loop-guards", "data-ingest"]
    prd = {"delivery-integrity": "F-30", "loop-guards": "F-12", "data-ingest": "F-30"}
    # F-12 is the feature's own code; loop-guards' PRD code is taken so it reads initials,
    # and data-ingest's PRD code is taken by delivery-integrity (created first).
    assert short_codes(keys, prd) == ["F-30", "F-12", "LG", "DI"]


async def test_prd_codes_on_priorities(client):
    ctx = await make_people()
    w = await PriorityWorld(ctx).build()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, _, rv = await seed.roadmap("guards")
        f = await seed.entity("feature", "delivery-integrity", effort=1)
        await seed.item(rv, pv, "delivery-integrity", feature_id=f.id, prd_section_key="f-06")
        await s.commit()
    for who in ("owner", "commenter"):
        out = await w.read(client, who)
        codes = {r["code"]: r["short_code"] for r in out["rows"]}
        assert codes["delivery-integrity"] == "F-06", who
        assert codes["pay-1"] == "LE", who  # no PRD code: initials


async def test_item_card_names_the_prd_section(client):
    ctx = await make_people()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, _, rv = await seed.roadmap("guards")
        s.add(Section(version_id=pv.id, section_key="f-06", ordinal=1, level=2,
                      heading="F-06 Loop and blast-radius guards", content_hash="h1"))  # fmt: skip
        await seed.item(rv, pv, "loop-guards", prd_section_key="f-06")
        await seed.item(rv, pv, "other", prd_section_key="scope", position=1)
        await s.commit()
    r = await client.get("/v1/simple/roadmap", headers=ctx.as_("viewer"))
    assert r.status_code == 200, r.text
    reasons = {i["key"]: i["reasons"] for i in r.json()["items"]}
    assert {i["key"]: i["code"] for i in r.json()["items"]} == {
        "loop-guards": "F-06",
        "other": None,
    }
    assert "From Guards Prd (draft 1): F-06 Loop and blast-radius guards." in reasons["loop-guards"]
    assert "From Guards Prd (draft 1): Other." in reasons["other"]
    assert service.prd_section_label("f-06", None) == "F-06"
    assert service.prd_section_label("f-06", "Loop guards") == "F-06 Loop guards"


# --------------------------------------------------------------------------- attendees


async def test_next_review_lists_the_rituals_real_attendees(client):
    w = await meeting_world()
    ritual_id, due = await ritual(w, owner="owner")
    async with tenant_session(w.ctx.tenant_id) as s:
        assert (await s.get(Ritual, uuid.UUID(ritual_id))).attendee_ids == []
    row = (await client.get("/v1/simple/meetings", headers=w.ctx.as_("viewer"))).json()
    assert len(row["upcoming"][0]["attendees"]) == 1
    await start(client, w, "owner", ritual_id=ritual_id, due_at=due.isoformat())
    upcoming = (await client.get("/v1/simple/meetings", headers=w.ctx.as_("viewer"))).json()
    row = next(x for x in upcoming["upcoming"] if x["ritual_id"] == ritual_id)
    names = {a["id"] for a in row["attendees"]}
    assert names == {uid(w, "owner"), uid(w, "approver"), uid(w, "commenter")}
    async with tenant_session(w.ctx.tenant_id) as s:
        assert await s.scalar(select(User).where(User.id == uuid.UUID(uid(w, "owner"))))


def test_simple_page_names():
    """protects=the Ask panel's chip names Simple's pages in words (Home, Roadmap, ...),
    never the route; fails_when=/simple reads "/simple"; no_claim=Detailed's page names."""
    from oracle.discussions.context import page_name

    assert page_name("/simple") == "Home"
    assert page_name("/simple/roadmap?prd=x") == "Roadmap"
    assert page_name("/simple/priorities") == "Priorities"
    assert page_name("/simple/decisions") == "Decisions"
    assert page_name("/simple/one-pagers/guided-setup") == "One-pager"
    assert page_name("/settings/members") == "Settings · Members"
