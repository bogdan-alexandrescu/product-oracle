"""D1 Roadmap items review, first load: the review screen (/runs/<id>/review/<checkpoint>)
reads ``GET /v1/runs/<id>`` and the checkpoint's shared draft (D8 ``GET …/review``). Both
read a fixed number of statements whatever the number of items and their staged actions:
no item's trace, baseline row, actions or people are read on their own.

Integration tests: a ``prd_to_roadmap`` run waits at its Roadmap items checkpoint on the
FakeRuntime against Postgres, as tests/test_inbox_checkpoint_summary.py does.

Test cards (protects / fails_when / no_claim) head each test. Synthetic placeholders only.
"""

from sqlalchemy import event

from oracle.db import get_engine
from tests.test_roadmap import (  # noqa: F401 - fixtures
    approved_prd,
    owner,
    runtime,
    seed_baseline,
)
from tests.test_roadmap_reasons import roadmap_items_check

# The reads of one first load of the review screen's draft with 38 items, each with an
# accept and an outcome edit staged (measured 24: the sign-in, the run, the checkpoint, its
# segment, the PRD version and its sections, the date bases, the company-wide trace inputs,
# the items' traces together, the base roadmap, the actions and their people). The SAVEPOINT
# around the advisory reasons (two statements) is not a read.
MAX_REVIEW_READS = 24
# The run's own read (measured 13 with the sign-in).
MAX_RUN_READS = 13


def items_file(n: int) -> str:
    """``n`` items on the fixture PRD's two sections, each depending on the one before."""
    lines = ["version: 1", "prd: {document: checkout-redesign, version: 1}", "items:"]
    for i in range(n):
        lines += [
            f"  - id: item-{i}",
            f"    title: Item {i}",
            "    outcome: Buyers finish checkout",
            f"    horizon: {('now', 'next', 'later')[i % 3]}",
            f"    priority: {{score: 1.0, rank: {i + 1}}}",
            "    confidence: low",
            f"    milestone: {{name: M{i}}}",
            f"    prd_section: s-5-{1 + i % 2}",
        ]
        if i:
            lines.append(f"    depends_on: [item-{i - 1}]")
    return "\n".join(lines) + "\n"


async def reads_of(client, auth, url: str) -> tuple[list[str], dict]:
    statements: list[str] = []

    def count(conn, cursor, statement, *args):
        statements.append(statement)

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", count)
    try:
        resp = await client.get(url, headers=auth)
    finally:
        event.remove(engine, "before_cursor_execute", count)
    assert resp.status_code == 200, resp.text
    return [st for st in statements if "SAVEPOINT" not in st], resp.json()


async def staged_review(client, auth, runtime, n: int) -> tuple[str, str]:  # noqa: F811
    """The run and the review URL of a Roadmap items checkpoint with ``n`` items, an accept
    and an outcome edit staged on each."""
    run, _ = await roadmap_items_check(client, auth, runtime, items_file(n))
    [cp] = [c for c in run["checkpoints"] if c["status"] == "pending"]
    base = f"/v1/runs/{run['id']}/checkpoints/{cp['id']}"
    for i in range(n):
        for body in (
            {"item_key": f"item-{i}", "kind": "accept"},
            {"item_key": f"item-{i}", "kind": "edit", "field": "outcome", "value": "Paid"},
        ):
            resp = await client.post(f"{base}/actions", json=body, headers=auth)
            assert resp.status_code == 200, resp.text
    return f"/v1/runs/{run['id']}", f"{base}/review"


async def test_the_review_screens_reads_do_not_grow_with_its_items(client, owner, runtime):  # noqa: F811
    """protects=the review screen's first load reads the run and the draft in a fixed number
    of statements, so 38 items draw as quickly as 3; fails_when=a statement is read per item
    (a trace, a baseline row, an item's actions or their people), so 38 items read more than
    3, or more than MAX_REVIEW_READS / MAX_RUN_READS; no_claim=the web's call order (see
    web/e2e/roadmap-items-first-load.spec.ts) or production data volume."""
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    small_run, small_review = await staged_review(client, auth, runtime, 3)
    big_run, big_review = await staged_review(client, auth, runtime, 38)

    few, _ = await reads_of(client, auth, small_review)
    many, review = await reads_of(client, auth, big_review)
    assert len(review["items"]) == 38
    assert all(len(i["actions"]) == 2 for i in review["items"])
    assert len(many) == len(few), (len(few), len(many))
    assert len(many) <= MAX_REVIEW_READS, len(many)

    few, _ = await reads_of(client, auth, small_run)
    many, _ = await reads_of(client, auth, big_run)
    assert len(many) == len(few), (len(few), len(many))
    assert len(many) <= MAX_RUN_READS, len(many)
