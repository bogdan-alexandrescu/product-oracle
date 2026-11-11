"""GET /v1/simple/decisions/waiting (oracle.simple.waiting_list) answers fast on a company the
size of a real one, in a fixed number of statements, and says exactly what it said before.

Before: the list built the whole Simple roadmap (service.build) just to keep its broken links
and dates, read the roadmap again for the proposals (changes.listing) and again for the goal
suggestions (additions.listing, which also matched every suggestion against every feature
and read each one's flow, a statement per suggestion): the slowest route in production
(p50 6.5 s). Against Postgres, with invented example data only (tests/waiting_seed.py).

Test cards (protects / fails_when / no_claim):

- test_waiting_answers_under_budget: protects=on 400 items, 1,500 changes, 200 decisions,
  150 drafts and 40 goal suggestions the list answers (best of 3, after a warm-up) under
  BUDGET_S for the roadmap's decider and for an owner; fails_when=a source builds the whole
  roadmap again or reads per row; no_claim=production hardware (timing mark: CI runs it alone).
- test_waiting_reads_no_statement_per_row: protects=the read's statements (after a first
  read, which reads each PRD's questions in once) stay under MAX_STATEMENTS with several
  hundred waiting items (any per-row read passes it many times
  over); fails_when=a source reads per item, change or suggestion; no_claim=wall-clock time.
- test_waiting_says_what_it_said_before: protects=for every role, a roadmap's decider and a
  track owner, the response is identical to the one the former list built from the roadmap,
  changes and suggestions pages' own reads (``former_items`` below, kept verbatim);
  fails_when=any item, its order, words, link or time differs; no_claim=kinds this seed
  does not hold (the Inbox's rows, read as before).
"""

import time
from typing import Any

import pytest
from sqlalchemy import event

from oracle import company_time
from oracle.db import get_engine
from oracle.simple import waiting_list
from oracle.simple.schemas import SimpleWaitingItem
from tests.baseline_helpers import make_ctx
from tests.test_simple_roadmap_api import NOW
from tests.waiting_seed import big_company

WAITING = "/v1/simple/decisions/waiting"
# Measured on the CI-sized runner's test Postgres: before, 1.3 s for the decider and 1.4 s for
# an owner; after, see the commit message.
BUDGET_S = 0.6
# Counted on a warm read (the first reads each PRD's questions in once, questions.ensure).
# Before: 224 statements (sign-in included), the list's sources 142 of them.
MAX_STATEMENTS = 110


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


@pytest.fixture
async def company():
    ctx = await make_ctx()
    seeded = await big_company(ctx)
    return ctx, seeded


async def read(client, headers) -> tuple[int, float, dict]:
    statements: list[str] = []

    def count(conn, cursor, statement, *args):
        if "SAVEPOINT" not in statement:
            statements.append(statement)

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", count)
    t0 = time.perf_counter()
    try:
        resp = await client.get(WAITING, headers=headers)
    finally:
        elapsed = time.perf_counter() - t0
        event.remove(engine, "before_cursor_execute", count)
    assert resp.status_code == 200, resp.text
    return len(statements), elapsed, resp.json()


@pytest.mark.timing
async def test_waiting_answers_under_budget(client, company):
    ctx, _ = company
    best = {}
    for role in ("approver", "owner"):
        times = []
        for _ in range(4):
            _, elapsed, body = await read(client, ctx.as_(role))
            times.append(elapsed)
        assert len(body["items"]) > 500, len(body["items"])
        print(f"{role}: " + ", ".join(f"{t * 1000:.0f}" for t in times) + " ms")
        best[role] = min(times[1:])
    assert max(best.values()) < BUDGET_S, best


async def test_waiting_reads_no_statement_per_row(client, company):
    ctx, _ = company
    await read(client, ctx.as_("owner"))
    for role in ("approver", "owner"):
        n, _, body = await read(client, ctx.as_(role))
        kinds = {i["kind"] for i in body["items"]}
        assert {"broken_link", "date", "proposal", "goal_suggestion", "draft"} <= kinds, kinds
        assert len(body["items"]) > 500
        print(f"{role}: {n} statements, {len(body['items'])} items")
        assert n <= MAX_STATEMENTS, n


async def test_waiting_says_what_it_said_before(client, company, monkeypatch):
    ctx, seeded = company
    people = {role: ctx.as_(role) for role in ("owner", "approver", "commenter", "viewer")}
    # member-5 decides roadmap 3; member-6 is every roadmap's required reviewer.
    for name in ("member-5", "member-6", "member-7"):
        ctx.users[name] = seeded["members"][name]
        people[name] = ctx.as_(name)
    now = {}
    for name, headers in people.items():
        _, _, now[name] = await read(client, headers)
    monkeypatch.setattr(waiting_list, "items", former_items)
    for name, headers in people.items():
        _, _, before = await read(client, headers)
        assert now[name] == before, name
    assert len(now["approver"]["items"]) > 500 and len(now["owner"]["items"]) > 500


# --- The former list, verbatim: each source read as its own page reads it. ---------------


async def former_items(db, principal, qs) -> list[SimpleWaitingItem]:
    w = waiting_list
    if getattr(principal, "user_id", None) is None:
        return []
    out = await w._stops(db, principal)
    out += w._questions(qs)
    out += await w._calls(db, principal)
    out += await _former_roadmap(db, principal)
    out += await w._drafts(db, principal)
    out += await _former_proposals(db, principal)
    out += await _former_goal_suggestions(db, principal)
    out += await w._goals(db, principal)
    out += await w._inbox(db, principal)
    return out


async def _former_roadmap(db, principal: Any) -> list[SimpleWaitingItem]:
    from oracle.simple import service

    rm = await service.build(db, principal)
    today = await company_time.company_today(db)
    titles = {i.id: i.title for i in rm.items}
    out = []
    for i in rm.items:
        if not i.can_decide:
            continue
        for f in i.flags:
            if f.state != "red" or not f.fixes:
                continue
            dep = titles.get(waiting_list._uuid(f.subject)) if f.subject else None
            out.append(SimpleWaitingItem(
                kind="broken_link", key=f"broken_link:{i.id}:{f.kind}:{f.subject or ''}",
                ref_id=str(i.id), title=i.title,
                detail=f"{f.reason}" + (f" ({dep})" if dep and dep not in f.reason else ""),
                action="Fix the link", href=f"/simple/roadmap?item={i.id}",
            ))  # fmt: skip
        s = i.suggestion
        if s is not None and s.status == "open" and s.can_decide:
            out.append(SimpleWaitingItem(
                kind="date", key=f"date:{s.id}", ref_id=str(s.id), title=i.title,
                detail=f"Oracle suggests {waiting_list._day(s.start_date, today)} – "
                f"{waiting_list._day(s.end_date, today)}",
                action="Confirm the dates", href=f"/simple/roadmap?item={i.id}",
                at=s.created_at,
            ))  # fmt: skip
    return out


async def _former_proposals(db, principal: Any) -> list[SimpleWaitingItem]:
    from oracle.simple import changes

    out = []
    for c in await changes.listing(db, principal, None, None, "proposed", False):
        if not c.can_decide:
            continue
        item = (c.target or {}).get("item_id")
        date = c.op == "accept_date_suggestion"
        out.append(SimpleWaitingItem(
            kind="date" if date else "proposal", key=f"proposal:{c.id}", ref_id=str(c.id),
            title=c.words or ("New dates proposed" if date else "A proposed change"),
            detail=f"Proposed by {c.by_name}", action="Accept",
            href=f"/simple/roadmap?item={item}" if item else "/simple/roadmap",
            at=c.at, op=c.op,
        ))  # fmt: skip
    return out


async def _former_goal_suggestions(db, principal: Any) -> list[SimpleWaitingItem]:
    from oracle.simple import additions

    got = await additions.listing(db, principal, None, "open")
    return [
        SimpleWaitingItem(
            kind="goal_suggestion",
            key=f"goal_suggestion:{s.id}",
            ref_id=str(s.id),
            title=s.title,
            detail=f"Suggested for {s.goal.title}",
            action="Confirm",
            href="/simple/goals",
            at=s.created_at,
        )  # fmt: skip
        for s in got.suggestions
        if s.status == "open" and s.can_accept
    ]
