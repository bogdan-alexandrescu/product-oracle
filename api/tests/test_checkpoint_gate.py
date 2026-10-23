"""D3 Approve blocked by problems: Approve stays refused until every blocking reason is
fixed or waived, on every path (the decide route, a console confirm or continue, and a
counted console approval the tick reads, which is held, not followed).

Unit tests check :func:`oracle.runs.gate.approve_gate`; the integration tests wait a
``prd_to_roadmap`` run at its Roadmap items checkpoint (FakeRuntime, or the fake SwarmCloud
for the console) against Postgres. The checkpoint switched off still fails the run on
blocking problems: ``tests/test_roadmap.py`` keeps that ("was rejected: [unverified_date]").

Test cards (protects / fails_when / no_claim) head each test. Synthetic placeholders only.
"""

import uuid
from datetime import timedelta
from types import SimpleNamespace

from sqlalchemy import select

from oracle.models import AuditEvent
from oracle.runs import gate, service
from oracle.runs.models import Checkpoint
from oracle.swarm import set_runtime
from oracle.tenancy import tenant_session
from tests.test_checkpoint_review import Review, item_of, review  # noqa: F401 - fixtures
from tests.test_roadmap import (  # noqa: F401 - fixtures
    PRD,
    approved_prd,
    create,
    owner,
    pending,
    runtime,
    seed_baseline,
    start,
)
from tests.test_roadmap_reasons import SECOND, roadmap_items_check
from tests.test_runs import get, tick

LEFT = "1 blocking problem left: fix or waive them, or send back to the agents"
HELD = "Blocking problems are open: fix or waive them, then confirm"


# --- unit: gate.approve_gate -------------------------------------------------------------


def reason(item: str, code: str, severity: str = "blocking") -> dict:
    return {"item": item, "item_title": item.title(), "code": code, "severity": severity,
            "label": code.replace("_", " ")}  # fmt: skip


def act(item: str, kind: str = "waive", state: str = "staged", answers=()) -> SimpleNamespace:
    return SimpleNamespace(item_key=item, kind=kind, state=state, answers=list(answers))


def cp(reasons: list[dict], file_problems: int = 0, kind: str = "roadmap_items") -> Checkpoint:
    check = {"reasons": reasons, "file_problems": file_problems}
    return Checkpoint(kind=kind, payload={"items_check": check})


SECTION = reason("per-seat", "unknown_prd_section")
DATE = reason("slack-alerts", "unverified_date")
CONFIRM = reason("per-seat", "low_confidence", "confirm")


def test_a_blocking_reason_closes_the_gate_and_is_listed():
    """protects=Approve is refused with a blocking reason open; fails_when=the gate is open
    or the reason is not listed; no_claim=route wiring."""
    got = gate.approve_gate(cp([SECTION, DATE, CONFIRM]), None, [])
    assert got is not None and not got.open
    assert (got.blocking_open, got.file_problems) == (2, 0)
    assert [(x.item, x.code, x.waivable) for x in got.left] == [
        ("per-seat", "unknown_prd_section", True),
        ("slack-alerts", "unverified_date", False),
    ]
    assert gate.message(got) == (
        "2 blocking problems left: fix or waive them, or send back to the agents"
    )


def test_a_staged_waiver_answers_its_reason():
    """protects=a staged waiver opens the gate; fails_when=it stays closed; no_claim=roles."""
    got = gate.approve_gate(cp([SECTION]), None, [act("per-seat", answers=["unknown_prd_section"])])
    assert got.open and got.left == []


def test_a_suggested_waiver_counts_for_nothing():
    """protects=a commenter's suggestion never opens the gate; fails_when=it does;
    no_claim=staging."""
    got = gate.approve_gate(cp([SECTION]), None, [act("per-seat", state="suggested")])
    assert not got.open and got.blocking_open == 1


def test_a_date_reason_is_never_waived():
    """protects=O4: a date shows only on a verified basis; fails_when=a waiver opens the
    gate over a date reason; no_claim=the 422 (the route)."""
    for answers in ([], ["unverified_date"]):
        got = gate.approve_gate(cp([DATE]), None, [act("slack-alerts", answers=answers)])
        assert not got.open and [x.code for x in got.left] == ["unverified_date"]


def test_staged_edits_do_not_open_the_gate_until_they_are_applied():
    """protects=nothing is approved with an edit left unapplied (until D7); fails_when=a
    staged edit or accept answers a blocking reason; no_claim=D7's re-check."""
    edit = act("per-seat", kind="edit", answers=["unknown_prd_section"])
    accept = act("per-seat", kind="accept")
    got = gate.approve_gate(cp([SECTION]), None, [edit, accept])
    assert not got.open and got.blocking_open == 1


def test_a_waiver_answers_only_its_item_and_codes():
    """protects=one waiver does not clear another item or another code; fails_when=it
    does; no_claim=the wording."""
    dep = reason("per-seat", "unknown_dependency")
    other = reason("gift-cards", "unknown_prd_section")
    got = gate.approve_gate(
        cp([SECTION, dep, other]), None, [act("per-seat", answers=["unknown_prd_section"])]
    )
    assert [(x.item, x.code) for x in got.left] == [
        ("per-seat", "unknown_dependency"),
        ("gift-cards", "unknown_prd_section"),
    ]


def test_to_confirm_reasons_never_block():
    """protects=only blocking reasons close the gate; fails_when=an advisory one does;
    no_claim=D2's catalogue."""
    got = gate.approve_gate(cp([CONFIRM]), None, [])
    assert got.open and got.blocking_open == 0


def test_a_file_problem_keeps_the_gate_closed_whatever_is_staged():
    """protects=file-level problems are sent back, never waived; fails_when=the gate opens
    with one; no_claim=the run off the checkpoint."""
    got = gate.approve_gate(cp([], file_problems=1), None, [act("*")])
    assert not got.open and got.file_problems == 1 and gate.message(got) == LEFT


def test_a_kind_without_blocking_reasons_has_no_gate():
    """protects=kinds no spec registered are untouched; fails_when=they get a gate;
    no_claim=the later specs' sources."""
    assert set(gate.BLOCKING_SOURCES) == {"roadmap_items", "feature_set", "priority_order"}
    assert gate.approve_gate(cp([SECTION], kind="prd_review"), None, []) is None


# --- integration: the decide route --------------------------------------------------------


async def audit_actions(rv: Review) -> list[tuple[str, dict]]:
    async with tenant_session(rv.tenant_id) as s:
        rows = await s.scalars(
            select(AuditEvent)
            .where(AuditEvent.entity_id == uuid.UUID(rv.cp["id"]))
            .order_by(AuditEvent.created_at, AuditEvent.id)
        )
        return [(r.action, r.data) for r in rows]


async def test_approve_is_refused_while_a_blocking_reason_is_open(review):  # noqa: F811
    """protects=criteria 1, 2 and 7: decide approved is 409 blocking_open listing the open
    reason, nothing decided or audited, and the run read carries the gate; after a staged
    waiver Approve lands, the waiver audited first; fails_when=Approve lands with the gate
    closed; no_claim=the web."""
    run = await get(review.client, review.auth, review.run["id"])
    cp = pending(run)
    assert cp["gate"] == {
        "open": False,
        "blocking_open": 1,
        "file_problems": 0,
        "left": [
            {"item": "gift-cards", "item_title": "Gift cards", "code": "unknown_prd_section",
             "label": "No PRD section", "waivable": True},
        ],
    }  # fmt: skip
    assert cp["cannot_approve"] == LEFT
    assert (await review.get())["gate"] == cp["gate"]
    out = await review.decide("approver", expect=409, decision="approved")
    assert out["detail"] == {"code": "blocking_open", "message": LEFT, "left": cp["gate"]["left"]}
    assert not [a for a, _ in await audit_actions(review) if a == "checkpoint.approved"]
    got = await review.act("approver", item_key="gift-cards", kind="waive",
                           answers=["unknown_prd_section"],
                           value={"reason": "Section lands in the next PRD version"})  # fmt: skip
    assert got["gate"]["open"] is True and got["gate"]["left"] == []
    run = await review.decide("approver", decision="approved")
    assert next(c for c in run["checkpoints"] if c["id"] == review.cp["id"])["status"] == (
        "approved"
    )
    trail = await audit_actions(review)
    names = [a for a, _ in trail]
    assert names.index("checkpoint.action_staged") < names.index("checkpoint.approved")
    staged = next(d for a, d in trail if a == "checkpoint.action_staged")
    assert staged["action"]["kind"] == "waive"
    assert staged["action"]["value"] == {"reason": "Section lands in the next PRD version"}


async def test_waivers_refuse_dates_file_problems_and_commenters(review):  # noqa: F811
    """protects=criterion 3: a date or a file-level problem is never waived (422) and a
    commenter cannot even suggest a waiver (403); fails_when=any is stored;
    no_claim=the reasons' wording."""
    out = await review.act(
        "approver", expect=422, item_key="payment-step", kind="waive",
        answers=["unverified_date"], value={"reason": "We trust it"},
    )  # fmt: skip
    assert out["detail"] == gate.DATE_NOT_WAIVED
    out = await review.act("approver", expect=422, item_key="*", kind="waive",
                           answers=["no_items"], value={"reason": "Fine"})  # fmt: skip
    assert out["detail"] == gate.FILE_NOT_WAIVED
    await review.act("commenter", expect=403, item_key="gift-cards", kind="waive",
                     answers=["unknown_prd_section"], value={"reason": "Fine"})  # fmt: skip
    assert (await review.get())["revision"] == 0


async def test_only_to_confirm_reasons_open_the_gate(client, owner, runtime):  # noqa: F811
    """protects=criterion 4: advisory reasons never block Approve; fails_when=a run with
    only to-confirm reasons is refused; no_claim=which advisory reasons appear."""
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    clean = SECOND.replace("prd_section: no-such-section", "prd_section: s-5-2")
    run, check = await roadmap_items_check(client, auth, runtime, clean)
    assert check["blocking"] == 0 and check["to_confirm"] > 0
    cp = pending(run)
    assert cp["gate"]["open"] is True and cp["cannot_approve"] is None
    resp = await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/decide",
        json={"decision": "approved"},
        headers=auth,
    )
    assert resp.status_code == 200, resp.text


async def test_a_file_problem_is_sent_back_never_approved(review):  # noqa: F811 - fixture
    """protects=criterion 5: a file-level problem keeps the gate closed whatever is staged,
    and Request changes still works; fails_when=Approve lands, or a send-back is refused;
    no_claim=the agents' re-run."""
    await review.act("approver", item_key="gift-cards", kind="waive",
                     answers=["unknown_prd_section"], value={"reason": "Later"})  # fmt: skip
    async with tenant_session(review.tenant_id) as s:
        row = await s.get(Checkpoint, uuid.UUID(review.cp["id"]))
        check = {**row.payload["items_check"], "file_problems": 1}
        row.payload = {**row.payload, "items_check": check}
        await s.commit()
    out = await review.decide("approver", expect=409, decision="approved")
    assert out["detail"]["code"] == "blocking_open" and out["detail"]["message"] == LEFT
    run = await review.decide("approver", decision="changes_requested", note="List the items")
    cp = next(c for c in run["checkpoints"] if c["id"] == review.cp["id"])
    assert cp["status"] == "changes_requested"


# --- integration: a console approval -----------------------------------------------------


async def test_a_console_approval_is_held_until_the_gate_opens(client, owner, monkeypatch):  # noqa: F811
    """protects=criteria 6, 6a, 6b and 6c: a counted console MERGE with a blocking reason
    open is recorded, not followed (pending, needs confirm, the line, nothing delivered,
    the token read-only, the Inbox row counted once); confirm and continue are 409 until a
    waiver opens the gate; a stale confirm is review_changed; the current one approves via
    the console; fails_when=the approval is followed or confirmed with the gate closed;
    no_claim=the runtime's real console (the fake records the MERGE)."""
    from tests.swarmcloud_fake import FakeSwarmCloud
    from tests.test_adapter_v2 import _member

    tenant_id, auth = owner
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    swarm = FakeSwarmCloud(mcp=True, await_input=True, service_answer=True)
    set_runtime(swarm.runtime())
    try:
        for step in ("roadmap_items-1-analyst", "roadmap_items-2-prioritizer"):
            swarm.step_files[step] = {"roadmap_items.yaml": SECOND}
        await _member(tenant_id, "lead@example.com")
        run = await start(client, auth, await create(client, auth, source=PRD))
        for _ in range(4):
            await tick(client, auth)
            run = await get(client, auth, run["id"])
            if run["waiting_on"] == "roadmap_items":
                break
        assert run["waiting_on"] == "roadmap_items", run
        cp = pending(run)
        assert cp["gate"]["open"] is False
        wf = cp["payload"]["wait"]["workflow_id"]
        posted = len(swarm.answers)
        swarm.console_answer(wf, "roadmap_items-review1", "MERGE", by="lead@example.com")
        real_now = service._now
        monkeypatch.setattr(service, "_now", lambda: real_now() + timedelta(seconds=61))
        await tick(client, auth)
        run = await get(client, auth, run["id"])
        cp = next(c for c in run["checkpoints"] if c["id"] == cp["id"])
        assert cp["status"] == "pending" and cp["console"]["needs"] == "confirm"
        assert cp["console"]["reason"] == HELD
        assert len(swarm.answers) == posted
        async with tenant_session(tenant_id) as s:
            assert await service.token_hold(s, uuid.UUID(run["id"]), live=False) is not None
        inbox = (await client.get("/v1/inbox", headers=auth)).json()
        rows = [c for c in inbox["checkpoints"] if c["id"] == cp["id"]]
        assert len(rows) == 1 and rows[0]["console"]["needs"] == "confirm"
        assert rows[0]["gate"]["open"] is False
        total = inbox["total"]
        base = f"/v1/runs/{run['id']}/checkpoints/{cp['id']}"
        for choice in ("confirm", "continue"):
            resp = await client.post(f"{base}/decide", json={"decision": choice}, headers=auth)
            assert resp.status_code in (409, 422), resp.text
        resp = await client.post(f"{base}/decide", json={"decision": "confirm"}, headers=auth)
        assert resp.status_code == 409 and resp.json()["detail"]["code"] == "blocking_open"
        resp = await client.post(
            f"{base}/actions",
            json={"item_key": "gift-cards", "kind": "waive", "answers": ["unknown_prd_section"],
                  "value": {"reason": "Section lands in the next PRD version"}},
            headers=auth,
        )  # fmt: skip
        assert resp.status_code == 200, resp.text
        revision = resp.json()["revision"]
        resp = await client.post(
            f"{base}/decide",
            json={"decision": "confirm", "expected_revision": revision - 1},
            headers=auth,
        )
        assert resp.status_code == 409 and resp.json()["detail"]["code"] == "review_changed"
        resp = await client.post(
            f"{base}/decide",
            json={"decision": "confirm", "expected_revision": revision},
            headers=auth,
        )
        assert resp.status_code == 200, resp.text
        cp = next(c for c in resp.json()["checkpoints"] if c["id"] == cp["id"])
        assert cp["status"] == "approved"
        async with tenant_session(tenant_id) as s:
            row = await s.scalar(
                select(AuditEvent).where(
                    AuditEvent.entity_id == uuid.UUID(cp["id"]),
                    AuditEvent.action == "checkpoint.approved",
                )
            )
            assert row is not None and row.data.get("via") == "swarmcloud_console"
        inbox = (await client.get("/v1/inbox", headers=auth)).json()
        assert not [c for c in inbox["checkpoints"] if c["id"] == cp["id"]]
        assert inbox["total"] == total - 1
    finally:
        set_runtime(None)
