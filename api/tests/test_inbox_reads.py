"""inbox-reads: GET /v1/inbox reads each table once on a company the size of a real one
(tests/inbox_seed.py), and answers exactly as before; the rail's counts come from a light read
(GET /v1/inbox/counts) and a visit is recorded without reading the Inbox again (POST
/v1/inbox/seen).

Before: the owner's Inbox on the seed took 139 statements (the sign-in's included): the Simple
rows read the company's documents, members, tracks and deciders once per part, the feedback's
open items, suggestions, documents and latest versions twice, and the runs four times. After:
117, of which about 25 are the Simple roadmap read made twice (once as the company sees it,
once with my drafts: oracle.simple.service.load).

Against Postgres, with invented example data only.

Test cards (protects / fails_when / no_claim):

- test_inbox_reads_each_table_once: protects=the owner's Inbox on the seed stays at or under
  MAX_STATEMENTS; fails_when=a part reads again what another part read.
- test_answers_as_before_inbox_reads: protects=the Inbox answers exactly as the code before
  inbox-reads (its changed modules read from git at BEFORE) for the owner, an approver and an
  API token; fails_when=any row, count or field differs.
- test_counts_are_the_inboxs: protects=GET /v1/inbox/counts gives the Inbox's total and the
  part of it the Roadmap tab counts too, for each reader, in fewer statements than the Inbox;
  fails_when=the route is missing or its numbers differ from the Inbox's.
- test_seen_records_the_visit: protects=POST /v1/inbox/seen records this visit (what "new" is
  measured from) in a few statements, without reading the Inbox; fails_when=the route is
  missing, reads the Inbox, or records nothing.
"""

from oracle.review import inbox as review_inbox
from oracle.runs import service as runs_service
from oracle.simple import changes as simple_changes
from tests import test_inbox_read_budget as budget
from tests.baseline_helpers import make_ctx
from tests.inbox_seed import seed_company

READERS = ("owner", "approver", "token")
# The owner's Inbox on the seed, the sign-in's statements included (before inbox-reads: 139).
MAX_STATEMENTS = 117
# main before inbox-reads, and the modules inbox-reads changed.
BEFORE = "3eea4a07d50238b48a73bcb59cf5f139bd89ce1c"
CHANGED = (runs_service, review_inbox, simple_changes)
# Proposals on a PRD question or a one-pager line or number: not the roadmap's.
NOT_ROADMAP = ("decide_question", "name_decider", "edit_line", "set_section_number")


async def statements(client, method: str, url: str, headers) -> tuple[int, object]:
    """The statements one call takes (the sign-in's included), and its answer."""
    seen: list[str] = []

    def count(conn, cursor, statement, *args):
        if "SAVEPOINT" not in statement:
            seen.append(statement)

    from sqlalchemy import event

    from oracle.db import get_engine

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", count)
    try:
        resp = await client.request(method, url, headers=headers)
    finally:
        event.remove(engine, "before_cursor_execute", count)
    assert resp.status_code < 300, resp.text
    return len(seen), (resp.json() if resp.content else None)


async def test_inbox_reads_each_table_once(client):
    ctx = await make_ctx()
    await seed_company(ctx)
    await budget.read(client, ctx.as_("owner"))
    count, _ = await budget.read(client, ctx.as_("owner"))
    print(f"owner Inbox: {count} statements")
    assert count <= MAX_STATEMENTS, count


async def test_answers_as_before_inbox_reads(client, monkeypatch):
    ctx = await make_ctx()
    await seed_company(ctx)
    now = {who: (await budget.read(client, ctx.as_(who)))[1] for who in READERS}
    monkeypatch.setattr(budget, "BEFORE", BEFORE)
    for module in CHANGED:
        for name, fn in budget.before(module).items():
            if getattr(module, name, None) is not None:
                monkeypatch.setattr(module, name, fn)
    counts = {}
    for who, body in now.items():
        counts[who], was = await budget.read(client, ctx.as_(who))
        assert was == body, who
    # The old code really ran.
    assert counts["owner"] > MAX_STATEMENTS, counts


def _roadmap_part(inbox: dict) -> int:
    return (
        sum(1 for x in inbox["simple_proposals"] if x["op"] not in NOT_ROADMAP)
        + len(inbox["simple_approvals"])
        + len(inbox["simple_goal_suggestions"])
        + sum(1 for x in inbox["simple_track_suggestions"] if not x.get("proposed"))
    )


async def test_counts_are_the_inboxs(client):
    ctx = await make_ctx()
    await seed_company(ctx)
    for who in READERS:
        full, inbox = await statements(client, "GET", "/v1/inbox", ctx.as_(who))
        light, counts = await statements(client, "GET", "/v1/inbox/counts", ctx.as_(who))
        assert counts == {"total": inbox["total"], "roadmap": _roadmap_part(inbox)}, who
        assert light < full, (who, light, full)
    # The seed's proposals and drafts wait on the owner: the roadmap part is not empty.
    _, counts = await statements(client, "GET", "/v1/inbox/counts", ctx.as_("owner"))
    assert 0 < counts["roadmap"] <= counts["total"], counts


async def test_seen_records_the_visit(client):
    ctx = await make_ctx()
    await seed_company(ctx)
    headers = ctx.as_("owner")
    _, before = await statements(client, "GET", "/v1/inbox", headers)
    assert before["last_seen_at"] is None
    assert before["counts"]["new"] > 0
    count, body = await statements(client, "POST", "/v1/inbox/seen", headers)
    assert body is None
    # The sign-in, the last visit's read and its write: never the Inbox's reads.
    assert count <= 6, count
    _, after = await statements(client, "GET", "/v1/inbox", headers)
    assert after["last_seen_at"] is not None
    assert after["counts"]["new"] == 0
    assert after["counts"]["open"] == before["counts"]["open"] + before["counts"]["new"]
