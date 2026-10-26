"""D9 Inbox checkpoint counts: a pending Roadmap items checkpoint in ``GET /v1/inbox``
carries ``summary``, a projection of its shared draft (D8 ``GET …/review``): how many items
need the caller, how many blocking and to-confirm reasons are open, how many are handled,
the wait's time left, and up to three child rows (blocking first, then in position order),
each with its first open reason and the safe one-click fix when that reason has one.

Unit tests check :func:`oracle.runs.actions.summarize` (child selection, order, the safe-fix
filter) on a review built by hand; the integration tests wait a ``prd_to_roadmap`` run at
its Roadmap items checkpoint on the FakeRuntime against Postgres.

Test cards (protects / fails_when / no_claim) head each test. Synthetic placeholders only.
"""

import math
import time
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import event

from oracle import safe_yaml
from oracle.db import get_engine
from oracle.runs import actions
from oracle.runs.models import Checkpoint
from oracle.runs.schemas import (
    CheckpointReview,
    ItemReason,
    ReviewAction,
    ReviewItem,
    ReviewTally,
    WaitInfo,
)
from oracle.tenancy import tenant_session
from tests.review_v2_helpers import person
from tests.test_roadmap import (  # noqa: F401 - fixtures
    approved_prd,
    owner,
    pending,
    runtime,
    seed_baseline,
)
from tests.test_roadmap_reasons import SECOND, roadmap_items_check

# The reads of one ``GET /v1/inbox`` with 20 Roadmap items checkpoints of 3 distinct items
# each: 70 when batched (most of them the Inbox's other rows, a fixed few per section:
# discussions, access requests and member follow-ups added theirs in train I; the metrics
# review's variances, the answers to requests and the market and pricing settings theirs in
# train L; the owners' No document rows theirs in #583, the searching runs folded into the
# stuck runs' read for it), about 170 when each item's trace is read on its own; plus the
# approved product strategy once for every checkpoint's drift reasons (H4 §5); Simple's
# proposals and decisions on them one (#723 S3a); the versions from Simple drafts waiting
# for a required reviewer one (#723 S3b).
MAX_INBOX_READS = 73
# The timing of that call: a warm-up, then enough samples that the p95 is not one outlier.
WARM_UP = 3
SAMPLES = 40

# --- unit: actions.summarize -------------------------------------------------------------


def fix(label: str, kind: str, item: str, field: str | None = None, value=None) -> dict:
    return {"label": label, "action": {"kind": kind, "item": item, "field": field, "value": value}}


def reason(item: str, code: str, severity: str, fixes: list[dict]) -> ItemReason:
    return ItemReason(
        item=item,
        code=code,
        severity=severity,
        label=code.replace("_", " "),
        text=f"{code}.",
        fixes=fixes,
    )


def action(item: str, kind: str, state: str = "staged", **kw) -> ReviewAction:
    return ReviewAction(
        id=uuid.uuid4(), item_key=item, kind=kind, state=state, updated_at=datetime.now(UTC), **kw
    )


def item(key: str, position: int, reasons: list[ItemReason], acts=(), state=None) -> ReviewItem:
    open_ = [r for r in reasons if not any(actions._answers(a, r.model_dump()) for a in acts)]
    if state is None:
        state = "fine" if not reasons else "handled" if not open_ else "needs_you"
    return ReviewItem(
        key=key,
        position=position,
        title=key.title(),
        reasons=reasons,
        actions=list(acts),
        state=state,
    )


def review(items: list[ReviewItem]) -> CheckpointReview:
    tally = ReviewTally()
    for i in items:
        open_ = [
            r for r in i.reasons if not any(actions._answers(a, r.model_dump()) for a in i.actions)
        ]
        tally.need_you += i.state == "needs_you"
        tally.handled += i.state == "handled"
        tally.blocking_open += sum(1 for r in open_ if r.severity == "blocking")
        tally.to_confirm_open += sum(1 for r in open_ if r.severity == "confirm")
    return CheckpointReview(
        checkpoint_id=uuid.uuid4(),
        run_id=uuid.uuid4(),
        kind="roadmap_items",
        status="pending",
        approver_role="approver",
        revision=0,
        wait=WaitInfo(state="none"),
        items=items,
        tally=tally,
    )


def test_children_are_blocking_first_then_in_position_order_at_most_three():
    """protects=the Inbox shows the most urgent items first; fails_when=a to-confirm item
    comes before a blocking one, more than three show, or the counts differ from the tally;
    no_claim=rendering."""
    items = [
        item("a", 1, [reason("a", "low_confidence", "confirm", [fix("Accept", "accept", "a")])]),
        item("b", 2, []),
        item("c", 3, [reason("c", "unverified_date", "blocking", [])]),
        item("d", 4, [reason("d", "new_item", "confirm", [])]),
        item("e", 5, [reason("e", "invalid_date", "blocking", [])]),
        item("f", 6, [reason("f", "serves_no_goal", "confirm", [])]),
    ]
    got = actions.summarize(review(items))
    assert [c.item for c in got.children] == ["c", "e", "a"]
    assert (got.need_you, got.blocking, got.to_confirm, got.handled) == (5, 2, 3, 0)
    assert got.more == 2


def test_only_fully_determined_one_click_fixes_are_offered():
    """protects=the Inbox only stages what is undone with one click and needs no text;
    fails_when=Drop, Waive, Link section, Set horizon, a text edit or a fix on another item
    is offered; no_claim=what the fix does (D7 applies it)."""
    safe = [
        fix("Accept", "accept", "x"),
        fix("Move to Later", "edit", "x", "horizon", "later"),
        fix("Remove date", "edit", "x", "milestone_date", None),
        fix("Remove dependency", "edit", "x", "depends_on", {"remove": ["y"]}),
        fix("Fix order", "edit", "x", "order", {"after": "y"}),
    ]
    unsafe = [
        fix("Drop", "drop", "x"),
        fix("Keep", "restore", "x"),
        fix("Waive", "waive", "x"),
        fix("Link section", "edit", "x", "prd_section", None),
        fix("Set horizon", "edit", "x", "horizon", None),
        fix("Clear confidence", "edit", "x", "clear:confidence", None),
        fix("Rename", "edit", "x", "title", "New name"),
        fix("Add dependency", "edit", "x", "depends_on", {"add": ["y"]}),
        fix("Pull dependency to Now", "edit", "y", "horizon", "now"),
    ]
    for f in safe:
        assert actions.safe_fix("x", [f]) is not None, f
    for f in unsafe:
        assert actions.safe_fix("x", [f]) is None, f
    # The first safe one of a reason's fixes, after unsafe ones.
    assert actions.safe_fix("x", [unsafe[0], safe[1], safe[0]]).label == "Move to Later"


def test_a_child_without_a_safe_fix_has_none():
    """protects=a reason that needs typing shows only Open; fails_when=its Link section is
    offered in the Inbox; no_claim=the Open link (the web builds it)."""
    items = [
        item(
            "u",
            1,
            [
                reason(
                    "u",
                    "unknown_prd_section",
                    "blocking",
                    [fix("Link section", "edit", "u", "prd_section", None)],
                )
            ],
        )
    ]
    [child] = actions.summarize(review(items)).children
    assert child.reason.code == "unknown_prd_section" and child.fix is None


def test_fixed_items_leave_the_slots_to_items_that_need_me():
    """protects=the three child rows are items still needing the person; one fixed earlier
    (a staged safe fix, or handled another way) gives its slot to the next item, and the
    counts drop; fails_when=a fixed item fills a slot while an item needing the person is
    left under "+k more"; no_claim=the done row the page keeps after a click (web)."""
    later = fix("Move to Later", "edit", "b", "horizon", "later")
    moved = action(
        "b", "edit", field="horizon", value="later", answers=["horizon_breaks_dependency"]
    )
    items = [
        item("a", 1, [reason("a", "unverified_date", "blocking", [])]),
        item("b", 2, [reason("b", "horizon_breaks_dependency", "blocking", [later])], [moved]),
        item("c", 3, [reason("c", "low_confidence", "confirm", [])]),
        item("d", 4, [reason("d", "new_item", "confirm", [])]),
    ]
    got = actions.summarize(review(items))
    assert [c.item for c in got.children] == ["a", "c", "d"]
    assert all(c.staged is None for c in got.children)
    assert (got.need_you, got.blocking, got.handled, got.more) == (3, 1, 1, 0)
    # Handled from the review screen another way (a drop): not in a slot either.
    dropped = action("b", "drop")
    items[1] = item(
        "b", 2, [reason("b", "horizon_breaks_dependency", "blocking", [later])], [dropped]
    )
    assert [c.item for c in actions.summarize(review(items)).children] == ["a", "c", "d"]


def test_a_commenters_suggestion_shows_on_its_child_row():
    """protects=the approver sees what a commenter suggested and stages it from the Inbox;
    fails_when=the suggestion is missing or counts as handled; no_claim=role checks."""
    suggested = action("a", "accept", state="suggested", answers=["low_confidence"])
    items = [
        item(
            "a",
            1,
            [reason("a", "low_confidence", "confirm", [fix("Accept", "accept", "a")])],
            [suggested],
        )
    ]
    got = actions.summarize(review(items))
    [child] = got.children
    assert child.suggested is not None and child.suggested.id == suggested.id
    assert child.staged is None and got.need_you == 1


# --- integration -------------------------------------------------------------------------


async def inbox_of(client, headers) -> dict:
    resp = await client.get("/v1/inbox", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_the_inbox_summary_equals_the_review_tally(client, owner, runtime):  # noqa: F811
    """protects=the Inbox and the review screen count the same; a one-click fix stages and
    decides nothing; fails_when=numbers differ, more than three children, a blocking child
    after a to-confirm one, or staging decides the checkpoint; no_claim=wording."""
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    run, _ = await roadmap_items_check(client, auth, runtime, SECOND)
    cp = pending(run)
    approver = await person(tenant_id, "approver", "abe")
    base = f"/v1/runs/{run['id']}/checkpoints/{cp['id']}"
    expires = (datetime.now(UTC) + timedelta(hours=19, minutes=5)).isoformat()
    async with tenant_session(tenant_id) as s:
        row = await s.get(Checkpoint, uuid.UUID(cp["id"]))
        row.payload = {
            **row.payload,
            "wait": {
                **(row.payload.get("wait") or {}),
                "workflow_id": "wf-1",
                "expires_at": expires,
            },
        }
        await s.commit()

    async def both() -> tuple[dict, dict]:
        got = await inbox_of(client, approver.headers)
        [c] = [c for c in got["checkpoints"] if c["id"] == cp["id"]]
        resp = await client.get(f"{base}/review", headers=approver.headers)
        return c["summary"], resp.json()

    summary, rev = await both()
    tally = rev["tally"]
    assert (
        summary["need_you"],
        summary["blocking"],
        summary["to_confirm"],
        summary["handled"],
    ) == (
        tally["need_you"],
        tally["blocking_open"],
        tally["to_confirm_open"],
        tally["handled"],
    )
    assert summary["need_you"] >= 2 and summary["blocking"] >= 1
    assert 0 < len(summary["children"]) <= 3
    sev = [c["reason"]["severity"] for c in summary["children"]]
    assert sev == sorted(sev, key=lambda s: s != "blocking")
    assert summary["wait"]["state"] == "open" and summary["wait"]["seconds_left"] > 18 * 3600
    assert summary["source"]["version"] == 1 and summary["source"]["title"]
    assert summary["console_held"] is False and summary["sections"] is None
    # Gift cards' "No PRD section" has no safe fix (Link section needs a choice).
    gift = next(c for c in summary["children"] if c["item"] == "gift-cards")
    assert gift["reason"]["code"] == "unknown_prd_section" and gift["fix"] is None

    # A child with a safe fix: staging it stages (answers set) and decides nothing.
    child = next(c for c in summary["children"] if c["fix"])
    a = child["fix"]["action"]
    body = {
        "item_key": a["item"],
        "kind": a["kind"],
        "field": a["field"],
        "value": a["value"],
        "answers": [child["reason"]["code"]],
    }
    resp = await client.post(f"{base}/actions", json=body, headers=approver.headers)
    assert resp.status_code == 200, resp.text
    after, rev = await both()
    assert rev["status"] == "pending"
    assert after["need_you"] == rev["tally"]["need_you"]
    [staged] = [a for i in rev["items"] if i["key"] == child["item"] for a in i["actions"]]
    assert staged["state"] == "staged" and staged["answers"] == [child["reason"]["code"]]
    # The slots hold items still needing me, each with a reason still open: the one fixed
    # is not shown again.
    needing = {i["key"] for i in rev["items"] if i["state"] == "needs_you"}
    assert [c["item"] for c in after["children"]] == [
        c["item"] for c in summary["children"] if c["item"] in needing
    ]
    assert all(c["staged"] is None for c in after["children"])
    assert child["reason"]["code"] not in [
        c["reason"]["code"] for c in after["children"] if c["item"] == child["item"]
    ]
    # Undo restores both rows.
    resp = await client.delete(f"{base}/actions/{staged['id']}", headers=approver.headers)
    assert resp.status_code == 200, resp.text
    again, _ = await both()
    assert again["need_you"] == summary["need_you"] and again["children"] == summary["children"]


async def test_a_held_console_approval_marks_the_summary(client, owner, runtime):  # noqa: F811
    """protects=a console approval given while blocking reasons are open is shown as held;
    fails_when=console_held is false then, or still true once nothing blocks; no_claim=D3's
    Confirm action."""
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    run, _ = await roadmap_items_check(client, auth, runtime, SECOND)
    cp = pending(run)
    async with tenant_session(tenant_id) as s:
        row = await s.get(Checkpoint, uuid.UUID(cp["id"]))
        console = {
            "needs": "confirm",
            "answered_by": "someone",
            "verdict": "MERGE",
            "counted": False,
        }
        row.payload = {
            **row.payload,
            "wait": {**(row.payload.get("wait") or {}), "console": console},
        }
        await s.commit()
    [c] = [c for c in (await inbox_of(client, auth))["checkpoints"] if c["id"] == cp["id"]]
    assert c["summary"]["console_held"] is True and c["summary"]["blocking"] >= 1
    # Waive every blocking reason: the gate opens, the checkpoint still waits for Confirm.
    base = f"/v1/runs/{run['id']}/checkpoints/{cp['id']}"
    rev = (await client.get(f"{base}/review", headers=auth)).json()
    for i in rev["items"]:
        if any(r["severity"] == "blocking" for r in i["reasons"]):
            body = {"item_key": i["key"], "kind": "waive", "value": {"reason": "Accepted for beta"}}
            assert (
                await client.post(f"{base}/actions", json=body, headers=auth)
            ).status_code == 200
    [c] = [c for c in (await inbox_of(client, auth))["checkpoints"] if c["id"] == cp["id"]]
    assert c["summary"]["blocking"] == 0 and c["summary"]["console_held"] is False
    assert c["console"]["needs"] == "confirm"


async def twenty_checkpoints(client, auth, runtime) -> None:  # noqa: F811
    for n in range(20):
        # Distinct items in every checkpoint: nothing is shared between them but the
        # company-wide reads.
        items = SECOND
        for key in ("payment-step", "mobile-push", "gift-cards"):
            items = items.replace(f"id: {key}", f"id: {key}-{n}")
        await roadmap_items_check(client, auth, runtime, items)


async def test_the_inbox_with_20_roadmap_checkpoints_reads_in_batches(client, owner, runtime):  # noqa: F811
    """protects=the Inbox reads the company-wide inputs once per call and the traces of all
    its checkpoints' items together, so its reads do not grow with the checkpoints' items;
    fails_when=more than MAX_INBOX_READS reads with 20 pending Roadmap items checkpoints
    whose items all differ; no_claim=wall time (the timing test below)."""
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    await twenty_checkpoints(client, auth, runtime)
    statements: list[str] = []

    def count(conn, cursor, statement, *args):
        statements.append(statement)

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", count)
    try:
        got = await inbox_of(client, auth)
    finally:
        event.remove(engine, "before_cursor_execute", count)
    assert sum(1 for c in got["checkpoints"] if c["summary"]) == 20
    # Batched, not per checkpoint or per item: the reads do not grow with the 60 items (each
    # review's savepoint, two statements, is not a read).
    reads = [st for st in statements if "SAVEPOINT" not in st]
    assert len(reads) <= MAX_INBOX_READS, len(reads)
    assert got["total"] >= 20  # the badge: one per checkpoint, children add nothing


@pytest.mark.timing
async def test_the_inbox_with_20_roadmap_checkpoints_is_quick(client, owner, runtime):  # noqa: F811
    """protects=the Inbox with 20 Roadmap items checkpoints stays quick; fails_when=p95 over
    300 ms (after a warm-up, over SAMPLES calls) with 20 pending Roadmap items checkpoints
    whose items all differ, on the test database, run alone (marker ``timing``: CI runs it
    after the parallel run); no_claim=the read count (the test above), production data
    volume."""
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    await twenty_checkpoints(client, auth, runtime)
    got = await inbox_of(client, auth)
    assert sum(1 for c in got["checkpoints"] if c["summary"]) == 20
    for _ in range(WARM_UP):
        await inbox_of(client, auth)
    times = []
    for _ in range(SAMPLES):
        start = time.perf_counter()
        await inbox_of(client, auth)
        times.append(time.perf_counter() - start)
    # The nearest-rank p95: of 40 samples the 38th, so two slow calls do not fail it.
    p95 = sorted(times)[math.ceil(len(times) * 0.95) - 1]
    print(f"GET /v1/inbox with 20 roadmap checkpoints: p95 {p95 * 1000:.0f} ms")
    assert p95 < 0.3, f"p95 {p95 * 1000:.0f} ms"


async def test_the_inbox_parses_each_items_file_once(client, owner, runtime, monkeypatch):  # noqa: F811
    """protects=an Inbox call parses each checkpoint's roadmap_items.yaml at most once, and
    a file already parsed (the same text) is not parsed again by later calls; the counts
    stay those of the file; fails_when=a file is parsed twice in one call, or a warm Inbox
    call parses any of its 20 unchanged files; no_claim=timing (see the test above)."""
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    await twenty_checkpoints(client, auth, runtime)
    parsed: list[str] = []
    load = safe_yaml.load

    def counted(text, **kw):
        parsed.append(text)
        return load(text, **kw)

    monkeypatch.setattr(safe_yaml, "load", counted)
    first = await inbox_of(client, auth)
    assert len(parsed) == len(set(parsed)) <= 20
    parsed.clear()
    again = await inbox_of(client, auth)
    assert parsed == []
    assert [c["summary"] for c in again["checkpoints"]] == [
        c["summary"] for c in first["checkpoints"]
    ]
    assert sum(1 for c in again["checkpoints"] if c["summary"]) == 20
