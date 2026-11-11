"""Simple's slow reads and the change POST (owner, 2026-11-11: "product oracle is loading so
slowly"), on a company the size of a real one (tests/simple_perf_helpers.py). Against
Postgres.

Test cards (protects / fails_when / no_claim):

- test_reads_answer_within_budget (timing): protects=GET goal-suggestions, changes, drafts,
  removed, meetings/options and feature-states each answer within their budget (best of 3
  after a warm-up) on the company seed; fails_when=a read slows past its budget;
  no_claim=production hardware or the network.
- test_a_change_answers_within_budget (timing): protects=POST /v1/simple/changes applies an
  owner's title edit within its budget; fails_when=it rebuilds the roadmap more than it
  needs; no_claim=the visuals job it queues (run later by the worker).
- test_reads_make_few_statements: protects=each read's SQL statement count stays within
  its ceiling and does not grow with the rows it lists (no query per suggestion, PRD,
  draft or goal); fails_when=an N+1 comes back; no_claim=the roadmap build's own count
  (oracle.simple.service, its own tests).
- test_a_change_makes_few_statements: protects=POST /v1/simple/changes builds the roadmap
  once for its check and once for its answer, within a statement ceiling;
  fails_when=it builds it a third time; no_claim=meeting sessions' extra work.
- test_a_change_answers_as_the_history_tells_it: protects=the change POST's answer (an
  applied edit, a proposal, an undo, an accepted goal suggestion) tells the change exactly
  as GET /v1/simple/changes does on a fresh read (the answer reuses the read it built for
  its flags);
  fails_when=the answer is told on a stale read; no_claim=the flags (their own tests).
- test_quick_title_match_scores_as_the_full_one: protects=the matcher's shortcut (Looks
  like) scores every pair as the full ratio does, and skips only pairs under LOOKS_LIKE;
  fails_when=a pair at or over it is dropped or scored differently; no_claim=which titles
  should match.
- test_agendas_read_as_one_meeting_s: protects=the change history's batched read of each
  meeting's agenda (agenda.of_many) equals agenda.of for every meeting, a pinned one too;
  fails_when=a meeting's roadmaps differ; no_claim=what an agenda covers (its own tests).
- test_prd_whos_read_as_prd_who: protects=the start sheet's batched read of each PRD's
  decider, required reviewers and track owners equals the one-PRD read for every PRD;
  fails_when=a PRD's people differ; no_claim=who may start (may_start's own tests).
"""

import json
import os
import time
from pathlib import Path

import pytest
from sqlalchemy import event, select

from oracle import company_time
from oracle.auth.models import User
from oracle.db import get_engine
from oracle.docs.models import Document
from oracle.review.models import DocumentReviewPolicy
from oracle.simple import additions, agenda, meetings
from oracle.simple.models import SimpleMeeting
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.simple_perf_helpers import NOUNS, VERBS, seed_company, title
from tests.test_simple_roadmap_api import NOW

READS = {
    "goal-suggestions": ("/v1/simple/goal-suggestions", {}),
    "changes": ("/v1/simple/changes", {}),
    "drafts": ("/v1/simple/drafts", {}),
    "removed": ("/v1/simple/removed", {}),
    "meetings-options": ("/v1/simple/meetings/options", {}),
    "feature-states": ("/v1/feature-states", {}),
}


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


class Statements:
    def __init__(self) -> None:
        self.seen: list[str] = []

    def __call__(self, conn, cursor, statement, *args) -> None:
        if "SAVEPOINT" not in statement:
            self.seen.append(statement)

    def __enter__(self) -> "Statements":
        event.listen(get_engine().sync_engine, "before_cursor_execute", self)
        return self

    def __exit__(self, *exc) -> None:
        event.remove(get_engine().sync_engine, "before_cursor_execute", self)


def _dump(name: str, body) -> None:
    """PERF_DUMP=<dir>: writes each answer there, to compare before and after a change."""
    if out := os.environ.get("PERF_DUMP"):
        Path(out).mkdir(parents=True, exist_ok=True)
        Path(out, f"{name}.json").write_text(json.dumps(body, indent=1, sort_keys=True))


async def _company():
    ctx = await make_ctx()
    co = await seed_company(ctx)
    return ctx, co


def _title_edit(co, n: int) -> dict:
    item = [i for i in co.items if not i.cut][n]
    return {
        "op": "edit_title",
        "target": {"item_id": str(item.id)},
        "before": {"title": item.title},
        "after": {"title": f"Example renamed {n}"},
    }


async def _timed(client, method: str, url: str, headers, **kw):
    t0 = time.perf_counter()
    r = await client.request(method, url, headers=headers, **kw)
    return r, time.perf_counter() - t0


# Budgets, seconds, best of 3 after a warm-up on the seed. Before the fix, on the lane's
# runner: goal-suggestions 2.98, meetings/options 0.17, the change POST 0.66 (120 statements:
# the roadmap built three times), changes 0.34, drafts 0.20, removed 0.27, feature-states 0.12.
BUDGETS = {
    "goal-suggestions": 1.5,
    "changes": 0.6,
    "drafts": 0.5,
    "removed": 0.6,
    "meetings-options": 0.1,
    "feature-states": 0.3,
}
CHANGE_BUDGET = 0.6
# Statement ceilings per read on the seed (before: goal-suggestions 115, a flow read per
# suggestion; meetings/options 83, three reads per PRD).
CEILINGS = {
    "goal-suggestions": 60,
    "changes": 45,  # with changes made in 60 meetings: no read per meeting
    "drafts": 20,
    "removed": 39,
    "meetings-options": 15,
    "feature-states": 9,
}
CHANGE_CEILING = 90


@pytest.mark.timing
async def test_reads_answer_within_budget(client):
    ctx, _ = await _company()
    headers = ctx.as_("owner")
    best = {}
    for name, (url, params) in READS.items():
        times = []
        for _ in range(4):
            r, took = await _timed(client, "GET", url, headers, params=params)
            assert r.status_code == 200, (name, r.text)
            times.append(took)
        _dump(name, r.json())
        best[name] = min(times[1:])
        print(f"{name}: {', '.join(f'{t * 1000:.0f}' for t in times)} ms")
    slow = {n: round(t, 3) for n, t in best.items() if t > BUDGETS[n]}
    assert not slow, (slow, best)


@pytest.mark.timing
async def test_a_change_answers_within_budget(client):
    ctx, co = await _company()
    headers = ctx.as_("owner")
    times = []
    for n in range(4):
        r, took = await _timed(client, "POST", "/v1/simple/changes", headers,
                               json=_title_edit(co, n))  # fmt: skip
        assert r.status_code == 201, r.text
        times.append(took)
    print(f"POST changes: {', '.join(f'{t * 1000:.0f}' for t in times)} ms")
    assert min(times[1:]) < CHANGE_BUDGET, times


async def test_reads_make_few_statements(client):
    ctx, _ = await _company()
    headers = ctx.as_("owner")
    counts = {}
    for name, (url, params) in READS.items():
        await client.get(url, params=params, headers=headers)
        with Statements() as st:
            r = await client.get(url, params=params, headers=headers)
        assert r.status_code == 200, (name, r.text)
        counts[name] = len(st.seen)
    print(counts)
    over = {n: c for n, c in counts.items() if c > CEILINGS[n]}
    assert not over, (over, counts)


async def test_a_change_makes_few_statements(client):
    ctx, co = await _company()
    headers = ctx.as_("owner")
    r = await client.post("/v1/simple/changes", json=_title_edit(co, 0), headers=headers)
    assert r.status_code == 201, r.text
    with Statements() as st:
        r = await client.post("/v1/simple/changes", json=_title_edit(co, 1), headers=headers)
    assert r.status_code == 201, r.text
    _dump("post-change", r.json())
    print(f"POST changes: {len(st.seen)} statements")
    assert len(st.seen) <= CHANGE_CEILING, len(st.seen)


SMALL = {"prds": 4, "per": 6, "cut_per": 2, "entities": 200, "changes": 40, "proposed": 8,
         "drafts": 8, "meetings": 4, "members": 8, "suggestions_per_goal": 4}  # fmt: skip


async def test_a_change_answers_as_the_history_tells_it(client):
    ctx = await make_ctx()
    co = await seed_company(ctx, **SMALL)
    url = "/v1/simple/changes"

    async def as_history(who: str, answer: dict) -> None:
        r = await client.get(url, headers=ctx.as_(who))
        assert r.status_code == 200, r.text
        told = {c["id"]: c for c in r.json()}
        assert told[answer["id"]] == answer

    applied = await client.post(url, json=_title_edit(co, 0), headers=ctx.as_("owner"))
    assert applied.status_code == 201, applied.text
    assert applied.json()["change"]["status"] == "applied"
    await as_history("owner", applied.json()["change"])
    # A commenter's edit is a proposal for the roadmap's decider or owner.
    proposed = await client.post(url, json=_title_edit(co, 1), headers=ctx.as_("commenter"))
    assert proposed.status_code == 201, proposed.text
    assert proposed.json()["change"]["status"] == "proposed"
    await as_history("commenter", proposed.json()["change"])
    undo = await client.post(f"{url}/{applied.json()['change']['id']}/undo",
                             headers=ctx.as_("owner"))  # fmt: skip
    assert undo.status_code in (200, 201), undo.text
    await as_history("owner", undo.json()["change"])
    # Accepting a goal suggestion adds the feature (oracle.simple.additions).
    open_ = await client.get("/v1/simple/goal-suggestions", headers=ctx.as_("owner"))
    first = open_.json()["suggestions"][0]
    added = await client.post(f"/v1/simple/goal-suggestions/{first['id']}/accept",
                              json={"roadmap_id": str(co.roadmaps[0].id)},
                              headers=ctx.as_("owner"))  # fmt: skip
    assert added.status_code in (200, 201), added.text
    assert added.json()["change"]["op"] == "add_item"
    await as_history("owner", added.json()["change"])


def test_quick_title_match_scores_as_the_full_one():
    titles = [title(n) for n in range(0, 900, 7)]
    titles += [f"{t} v2" for t in titles[:40]] + ["", "Export", "export!", "Bulk-export 2"]
    titles += [f"{v} {n}" for v in VERBS[:6] for n in NOUNS[:6]]
    matched = 0
    for a in titles:
        for b in titles:
            full = additions._like(a, b)
            want = full if full >= additions.LOOKS_LIKE else None
            assert additions._looks_like(a, b) == want, (a, b)
            matched += want is not None
    assert matched > len(titles)  # some pairs match beyond each title with itself


async def test_prd_whos_read_as_prd_who():
    ctx = await make_ctx()
    co = await seed_company(ctx, **SMALL)
    async with tenant_session(ctx.tenant_id) as s:
        gone = User(email="gone@example.com", password_hash="x", role="approver",
                    disabled_at=NOW)  # fmt: skip
        s.add(gone)
        await s.flush()
        s.add(DocumentReviewPolicy(document_id=co.prds[1].id, decider_id=gone.id,
                                   mandatory_reviewer_ids=[ctx.users["viewer"].id]))  # fmt: skip
        await s.commit()
        docs = [await s.get(Document, d.id) for d in co.prds]
        batched = await meetings.prd_whos(s, docs)
        for d in docs:
            one = await meetings.prd_who(s, d)
            many = batched[d.id]
            assert (many.decider, many.reviewers, sorted(many.owners)) == (
                one.decider,
                one.reviewers,
                sorted(one.owners),
            ), d.slug
        assert batched[co.prds[1].id].reviewers == [ctx.users["viewer"].id]
        assert all(batched[d.id].owners for d in docs)


async def test_agendas_read_as_one_meeting_s():
    ctx = await make_ctx()
    co = await seed_company(ctx, **SMALL)
    async with tenant_session(ctx.tenant_id) as s:
        rows = list(await s.scalars(select(SimpleMeeting)))
        rows[0].agenda = {"roadmap_id": str(co.roadmaps[3].id)}
        await s.flush()
        many = await agenda.of_many(s, rows)
        for m in rows:
            assert many[m.id] == await agenda.of(s, m), m.title
        assert many[rows[0].id].roadmap_ids == {co.roadmaps[3].id}
        assert all(many[m.id].roadmap_ids for m in rows)
