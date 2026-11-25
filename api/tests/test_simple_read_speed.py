"""read-speed (production, Nov 12: roadmap p50 1.8 s, priorities 2.6 s, decisions 2.9 s on
1 vCPU): the three Simple reads Home, Roadmap, Goal map, Priorities and Decisions fire at once
(``GET /v1/simple/roadmap``, ``/v1/simple/priorities``, ``/v1/simple/decisions``) on a company
at least the size of a real one (tests/roadmap_scale_seed.py). Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_reads_say_what_they_said_before: protects=the speed work changes no byte of the three
  reads: each view's body (roadmap by goal and a viewer's, priorities for an owner and a
  viewer, decisions for an owner, a viewer and filtered by goal and by PRD) hashes to the
  digest it had before the cut (3eea4a0); fails_when=any field, order or value moves;
  no_claim=a reader with a working draft. The seed adds 12 ended meetings (minutes sent or
  ready, notes, decisions taken in them) to tests/roadmap_scale_seed.py's company.
- test_roadmap_takes_few_statements, test_priorities_takes_few_statements,
  test_decisions_takes_few_statements: protects=each read's statement count on that company
  (warm, sign-in included): the roadmap 50 (before: 55; the open proposals were read twice,
  the review policies, the goal milestones' open renames and the milestones carried over
  again, and the items once for the feature codes and again for the PRD order), priorities
  51 (before: 69, then 52; the members, documents, tracks and PRD plans were read again by
  each part, then the submitted versions twice), decisions 50 (before: 182; three statements
  per PRD for its questions, five per meeting for its PRD's deciders and the members' names);
  fails_when=a loader comes back per row, a table is read twice or a read builds the same
  thing again; no_claim=wall-clock time.
- test_profile (READ_PROFILE=1 only): prints each read's statements, wall and CPU time and
  writes its CPU-time cProfile (READ_SORT, READ_FILTER) and statements under $TMPDIR, for the
  handoff; asserts nothing.
"""

import cProfile
import hashlib
import io
import json
import os
import pstats
import time
import uuid
from datetime import timedelta
from pathlib import Path

import pytest
from sqlalchemy import event, select

from oracle import company_time
from oracle.auth.models import User
from oracle.db import get_engine
from oracle.decisions.models import Decision
from oracle.docs.models import Document
from oracle.simple.models import SimpleMeeting, SimpleMeetingDecision, SimpleSession
from oracle.tenancy import tenant_session
from tests.roadmap_scale_seed import NOW
from tests.roadmap_scale_seed import seed_company as scale_company

ROADMAP = "/v1/simple/roadmap"
PRIORITIES = "/v1/simple/priorities"
DECISIONS = "/v1/simple/decisions"
VIEWS = {
    "roadmap": (ROADMAP, "owner", {}),
    "roadmap-viewer": (ROADMAP, "viewer", {}),
    "priorities": (PRIORITIES, "owner", {}),
    "priorities-viewer": (PRIORITIES, "viewer", {}),
    "decisions": (DECISIONS, "owner", {}),
    "decisions-viewer": (DECISIONS, "viewer", {}),
    "decisions-goal": (DECISIONS, "owner", {"goal": "goal-1"}),
    "decisions-prd": (DECISIONS, "owner", {"prd": "product-3-prd"}),
}
# Each view's body on the seed as 3eea4a0 answered it (the company's id masked).
# roadmap-dates: picked_quarter, and undated items estimated by their suggestions.
# gt-proposed: each roadmap item's confirm_feature_id (null on this seed), after code_from; the
# two roadmap views differ from c92397816's by that field alone, the six others not at all.
# unique-codes: the two roadmap views gain feature_name on each item (null on this seed) and
# nothing else (diffed against fa899682c); the six others are unchanged.
# timeline-order: the two roadmap views gain position (an integer) and before_override (null on
# this seed) on each item and nothing else (JSON diff, with the rank and without it); the six
# others are unchanged.
# task-push: the two roadmap views gain tracker_ref, tracker_url and tracker_error on each task
# (null on this seed) and nothing else (JSON diff against 4ecbc5620); the six others are unchanged.
DIGESTS = {
    "roadmap": "baf216d64ea3cbafd6e1323acb5ee653074e352c391eb13e2798c16b6f1577b6",
    "roadmap-viewer": "6f6a16c37ccc439f97e88e82a4153ddbb75023baf3c963981e583175d9675ce8",
    "priorities": "b21526e73c21066f6027f67d6f1e116774a913778868391696c541a197bf6b45",
    "priorities-viewer": "2dca1614aa912c759813d3851df35897be11e298a3a9f9cf4eb6c4eb08b937c0",
    "decisions": "dca64176c5f3e0187e007563dd47c7eba45c22a8f43b4c2f56ea86bb05c2cc96",
    "decisions-viewer": "e80e4de138063ab3547b1bc21b304a864959a0a66d66eb2660224f61452a2739",
    "decisions-goal": "7b5209929302d49645ebc2c562340046a3f36a57440ba838d127c650d05f1cf2",
    "decisions-prd": "c552dc5f5bf81d5e818a6ed1b64612318b908fad03a37507715ee033ac907971",
}


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def seed_company():
    """tests/roadmap_scale_seed.py's company and 12 ended review meetings on its PRDs, each
    with minutes (sent or ready), notes and decisions taken in it; fixed ids and times."""
    ctx = await scale_company()
    async with tenant_session(ctx.tenant_id) as s:
        members = list(
            await s.scalars(
                select(User.id).where(User.tenant_id == ctx.tenant_id).order_by(User.id)
            )
        )
        prds = list(
            await s.scalars(select(Document.id).where(Document.kind == "prd").order_by(Document.id))
        )
        decisions = list(await s.scalars(select(Decision).order_by(Decision.number)))
        for m in range(12):
            at = NOW - timedelta(days=2 * m + 1)
            ss = SimpleSession(id=uuid.UUID(int=900_000 + m), kind="meeting",
                               started_by=members[m], started_at=at, closed_at=at)  # fmt: skip
            s.add(ss)
            await s.flush()
            sent = m % 2 == 0
            s.add(SimpleMeeting(
                id=uuid.UUID(int=910_000 + m), title=f"Example review {m}",
                prd_document_id=prds[m % len(prds)], origin="one_pager", session_id=ss.id,
                presenter_id=members[m], attendee_ids=members[m:m + 4], status="ended",
                started_at=at, ended_at=at + timedelta(hours=1), ended_by=members[m],
                minutes={
                    "summary": f"Example summary {m}",
                    "open_questions": [f"D-{4 * m + 4}: still open", "Example question"],
                    "action_items": [{"title": f"Example task {m}", "owner_id": str(members[m + 1]),
                                      "due_date": "2026-11-20"}],
                    "waits": [], "written_by": "edited",
                },
                minutes_state="sent" if sent else "ready",
                sent_at=at + timedelta(hours=2) if sent else None,
                delivery={"email": True, "email_status": "sent", "email_to": {
                    str(members[m + k]): {"status": "sent"} for k in range(3)}} if sent else None,
                notes=[{"id": f"n-{m}-{k}", "kind": ("note", "comment", "question")[k],
                        "text": f"Example note {k}", "by": str(members[m + k]),
                        "at": (at + timedelta(minutes=k)).isoformat()} for k in range(3)],
                created_at=at,
            ))  # fmt: skip
            await s.flush()
            for k in range(3):
                d = decisions[(m * 3 + k) % len(decisions)]
                s.add(SimpleMeetingDecision(
                    id=uuid.UUID(int=920_000 + m * 10 + k),
                    meeting_id=uuid.UUID(int=910_000 + m), decision_id=d.id, change_ids=[],
                    at=at + timedelta(minutes=10 * k)))  # fmt: skip
        await s.commit()
    return ctx


def _digest(body: bytes, tenant_id) -> str:
    return hashlib.sha256(body.replace(str(tenant_id).encode(), b"TENANT")).hexdigest()


async def test_reads_say_what_they_said_before(client):
    """A page's full read answers exactly as it did before, down to the last field."""
    ctx = await seed_company()
    got = {}
    for name, (url, role, params) in VIEWS.items():
        r = await client.get(url, params=params, headers=ctx.as_(role))
        assert r.status_code == 200, r.text
        got[name] = _digest(r.content, ctx.tenant_id)
        if got[name] != DIGESTS.get(name):
            out = Path(os.environ.get("TMPDIR", ".")) / "read-speed"
            out.mkdir(parents=True, exist_ok=True)
            (out / f"{name}.json").write_text(json.dumps(r.json(), indent=1))
    print(json.dumps(got, indent=1))
    assert got == DIGESTS


async def _statements(client, url: str, headers: dict, **params) -> int:
    statements: list[str] = []

    def count(conn, cursor, statement, *args):
        statements.append(statement)

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", count)
    try:
        r = await client.get(url, params=params, headers=headers)
    finally:
        event.remove(engine, "before_cursor_execute", count)
    assert r.status_code == 200, r.text
    statements = [st for st in statements if "SAVEPOINT" not in st]
    if os.environ.get("READ_PROFILE"):
        out = Path(os.environ.get("TMPDIR", ".")) / f"read-statements{url.replace('/', '-')}.txt"
        out.write_text("\n----\n".join(statements))
    return len(statements)


# 53: the roadmap's light rank adds 5 statements to the 48 it took (measured, warm).
ROADMAP_MAX, PRIORITIES_MAX, DECISIONS_MAX = 53, 51, 50


async def _warm_statements(client, ctx, url: str, **params) -> int:
    owner = ctx.as_("owner")
    r = await client.get(url, params=params, headers=owner)
    assert r.status_code == 200, r.text
    n = await _statements(client, url, owner, **params)
    print(f"{url} {params}: {n} statements")
    return n


async def test_roadmap_takes_few_statements(client):
    """Loading the Roadmap page never makes more than its allotted statements."""
    ctx = await seed_company()
    assert await _warm_statements(client, ctx, ROADMAP) <= ROADMAP_MAX


async def test_priorities_takes_few_statements(client):
    """Loading the Priorities page never makes more than its allotted statements."""
    ctx = await seed_company()
    assert await _warm_statements(client, ctx, PRIORITIES) <= PRIORITIES_MAX


async def test_decisions_takes_few_statements(client):
    """Loading Decisions, filtered or not, makes no more than its allotted statements."""
    ctx = await seed_company()
    assert await _warm_statements(client, ctx, DECISIONS) <= DECISIONS_MAX
    # A filter reads no more.
    assert await _warm_statements(client, ctx, DECISIONS, goal="goal-1") <= DECISIONS_MAX


@pytest.mark.skipif(not os.environ.get("READ_PROFILE"), reason="READ_PROFILE=1 only")
async def test_profile(client):
    """Profiling a slow read, when asked, reports where its wall and CPU time go."""
    ctx = await seed_company()
    owner = ctx.as_("owner")
    report = []
    for url in (ROADMAP, PRIORITIES, DECISIONS):
        await client.get(url, headers=owner)
        n = await _statements(client, url, owner)
        walls, cpus = [], []
        for _ in range(3):
            w0, c0 = time.perf_counter(), time.process_time()
            r = await client.get(url, headers=owner)
            walls.append(time.perf_counter() - w0)
            cpus.append(time.process_time() - c0)
            assert r.status_code == 200, r.text
        prof = cProfile.Profile(time.process_time)
        prof.enable()
        await client.get(url, headers=owner)
        prof.disable()
        s = io.StringIO()
        # CPU time alone (DB waits are charged to whatever frame a greenlet left).
        stats = pstats.Stats(prof, stream=s).sort_stats(os.environ.get("READ_SORT", "cumulative"))
        stats.print_stats(os.environ.get("READ_FILTER", "oracle/"), 70)
        report.append(
            f"== {url}: {n} statements, wall {min(walls) * 1000:.0f} ms, "
            f"cpu {min(cpus) * 1000:.0f} ms\n{s.getvalue()}"
        )
    out = Path(os.environ.get("TMPDIR", ".")) / "read-profile.txt"
    out.write_text("\n".join(report))
    print("\n".join(line.split("\n")[0] for line in report))
