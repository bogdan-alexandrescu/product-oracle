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
  (warm, sign-in included): the roadmap 55, priorities 52 (before: 69; the members,
  documents, tracks and PRD plans were read again by each part), decisions 50 (before: 182;
  three statements per PRD for its questions, five per meeting for its PRD's deciders and the
  members' names); fails_when=a loader comes back per row, a table is read twice or a read
  builds the same thing again; no_claim=wall-clock time.
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
DIGESTS = {
    "roadmap": "2bdb31518feb21d575a13c1b1dbccae21ed5dffa38e6a7b26cefcb81fc9fa352",
    "roadmap-viewer": "9c2f1c3d20f5cc7f43d0f90c50b7a1759dbed7b17a0e4c58801b800fd06a1bb7",
    "priorities": "47fab36d7325276b7c141d70d1d510c6026116c977f2a48b743b78d314b49b37",
    "priorities-viewer": "a43376612642b3c90e23fce7011806c453febdf9341a8ec7994ac6f6e8b89517",
    "decisions": "e5265b88addf7bd45293bc4041094ac5e6d46a38a00b94bbd175f6a22e6ec400",
    "decisions-viewer": "990a9f77ce6c52e514901685e5baee279b0d9a6cd8706ef47a556be42a29b12a",
    "decisions-goal": "cd08b498db9fec8500fb80a6be5209a18d37c790126f4d659a5fd7f5d5c61ca3",
    "decisions-prd": "0de850205b25e4e0ffa6ec9ce53cc1efcdf916aa90786ba0fc53525c19ee56d4",
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


ROADMAP_MAX, PRIORITIES_MAX, DECISIONS_MAX = 55, 52, 50


async def _warm_statements(client, ctx, url: str, **params) -> int:
    owner = ctx.as_("owner")
    r = await client.get(url, params=params, headers=owner)
    assert r.status_code == 200, r.text
    n = await _statements(client, url, owner, **params)
    print(f"{url} {params}: {n} statements")
    return n


async def test_roadmap_takes_few_statements(client):
    ctx = await seed_company()
    assert await _warm_statements(client, ctx, ROADMAP) <= ROADMAP_MAX


async def test_priorities_takes_few_statements(client):
    ctx = await seed_company()
    assert await _warm_statements(client, ctx, PRIORITIES) <= PRIORITIES_MAX


async def test_decisions_takes_few_statements(client):
    ctx = await seed_company()
    assert await _warm_statements(client, ctx, DECISIONS) <= DECISIONS_MAX
    # A filter reads no more.
    assert await _warm_statements(client, ctx, DECISIONS, goal="goal-1") <= DECISIONS_MAX


@pytest.mark.skipif(not os.environ.get("READ_PROFILE"), reason="READ_PROFILE=1 only")
async def test_profile(client):
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
