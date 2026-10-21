"""C8 Priority order snapshot: the run's priority.yaml is checked, stored as a proposed
snapshot, compared with the live ranking, and saved for the PRD when the stop is approved.

Unit tests drive :func:`run_order.check_order` with a minimal file per code; the rest run
end to end against Postgres with the FakeRuntime (the console gate with the fake
SwarmCloud): a baseline_to_prd run approved past its feature set (C6) reaches the priority
stop with a scripted priority.yaml.

Test cards (protects / fails_when / no_claim):

- test_check_*: protects=every check code of the spec's table, blocking or advisory, from a
  minimal file; fails_when=a code is missing, mis-flagged blocking/advisory, or (for
  before_prerequisite) the message does not name both features; no_claim=the agent writes
  good orders.
- test_live_rank_is_restricted_to_the_ranked_features: protects=live_rank and
  differs_from_live compare like with like (the live ranking of the file's method,
  restricted to the file's features); fails_when=a feature the run leaves out shifts the
  live ranks; no_claim=ranking quality.
- test_segment_end_stores_a_proposed_snapshot: protects=rule 1: the order is a proposed
  snapshot of the run, with the file's method, the run's ranks and each row's live_rank,
  and the check is on the segment and the checkpoint; fails_when=the snapshot is missing,
  saved, or a rank, live_rank or the method is not the file's; no_claim=the draft follows
  the order.
- test_priority_approve_saves: protects=approving the stop applies the order;
  fails_when=approval leaves it proposed, or passes with a blocking problem; no_claim=that
  the draft follows the order.
- test_approve_refused_with_blocking_then_request_changes_discards: protects=call c3 on
  REST and MCP, and rule 4; fails_when=either path approves with a blocking problem open,
  or Request changes leaves the snapshot proposed; no_claim=C9 moves.
- the console gate: tests/test_priority_run_order_console.py.
- test_a_rerun_proposal_discards_the_earlier_one: protects=rule 2; fails_when=two
  proposals of a run are open at once; no_claim=which attempt is better.
- test_stop_off_*: protects=rule 5; fails_when=a clean order is not saved by Oracle or a
  blocking one passes; no_claim=the file's quality.
- test_the_draft_import_fills_the_document: protects=rule 6; fails_when=the saved
  snapshot does not name the PRD once it exists; no_claim=the draft's content.
- test_list_and_read_show_saved_unless_asked: protects=rule 7 for the list and read
  routes; fails_when=a proposed or discarded snapshot is listed by default, or ?status=all
  hides one; no_claim=pagination.
- test_compare_*: protects=the compare route's rows (run rank, live rank, delta,
  problems) and its viewer access; fails_when=a row disagrees with the check or the live
  ranking; no_claim=the screen.
- test_roadmap_reads_only_saved: protects=an unapproved order never shapes a roadmap;
  fails_when=the roadmap context reads a proposed or discarded snapshot; no_claim=ranking
  quality.
- test_roadmap_reads_this_prds_approved_order: protects=rule 7's reader order (this
  PRD's saved order before a company-wide one) and its method line; fails_when=another
  PRD's order or a company snapshot wins; no_claim=the roadmap agent obeys it.
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from oracle.baseline.models import Edge, Entity
from oracle.docs.models import Document
from oracle.models import AuditEvent
from oracle.priorities import run_order
from oracle.priorities.models import PrioritySnapshot
from oracle.runs.models import Checkpoint, Run
from oracle.swarm import Outcome
from oracle.tenancy import tenant_session
from tests.test_mcp import api_token, mcp_client, text_of
from tests.test_prd_scope import CLEAN, DOC, propose_feature, scopes
from tests.test_prd_scope import seed_baseline as seed_scope_baseline
from tests.test_runs import (  # noqa: F401 - fixtures
    as_user,
    decide,
    get,
    owner,
    pending,
    runtime,
    started,
    tick,
)

# The approved scope of CLEAN includes saved-addresses (depends on address-lookup),
# address-lookup and bulk-edit (a proposal of the run, not in the live ranking).
ORDER = """\
version: 1
method: goal_weighted
order:
  - key: address-lookup
    rank: 1
    score: 2.1
    explanation: "Activation weight 3 x contribution 1 x confidence 0.7 / effort 1"
  - key: saved-addresses
    rank: 2
    score: 3.6
    explanation: "Needs address-lookup first; Activation weight 3 x contribution 2 x 0.6 / 1"
  - key: bulk-edit
    rank: 3
    score: 0
    explanation: "Serves no confirmed goal"
"""
# saved-addresses ranked above the feature it depends on: one blocking problem.
BLOCKING = (
    ORDER.replace("rank: 1\n", "rank: X\n")
    .replace("rank: 2\n", "rank: 1\n")
    .replace("rank: X\n", "rank: 2\n")
)
BLOCKED = "The priority order has 1 blocking problem; send it back with Request changes"


async def seed_baseline(tenant_id) -> None:
    """C6's baseline, plus what the live ranking needs: both features serve the confirmed
    goal, saved-addresses depends on address-lookup."""
    await seed_scope_baseline(tenant_id)
    async with tenant_session(tenant_id) as s:
        by_key = {e.key: e for e in await s.scalars(select(Entity))}
        by_key["activation"].attrs = {"weight": 3}
        for key, contribution in (("saved-addresses", 2), ("address-lookup", 1)):
            by_key[key].attrs = {"effort": 1, "confidence": 0.7}
            s.add(
                Edge(
                    src_id=by_key[key].id,
                    dst_id=by_key["activation"].id,
                    type="supports",
                    status="confirmed",
                    origin="user",
                    attrs={"contribution": contribution},
                )
            )
        s.add(
            Edge(
                src_id=by_key["saved-addresses"].id,
                dst_id=by_key["address-lookup"].id,
                type="depends_on",
                status="confirmed",
                origin="user",
            )
        )
        await s.commit()


async def at_priority(client, owner, runtime, text=ORDER, **knobs) -> dict:  # noqa: F811
    """A baseline_to_prd run past its approved feature set, its priority segment ended
    with ``text`` as priority.yaml."""
    tenant_id, auth = owner
    await seed_baseline(tenant_id)
    runtime.script["feature_set"] = [
        Outcome(artifacts={"feature_set.yaml": CLEAN, "design.md": "# Design\n"})
    ]
    runtime.script["priority"] = [Outcome(artifacts={"priority.yaml": text})]
    run = await started(client, auth, document=DOC, **knobs)
    await propose_feature(tenant_id, run["id"])
    for _ in range(4):
        await tick(client, auth)
        run = await get(client, auth, run["id"])
        if run["status"] != "awaiting_checkpoint" or run["waiting_on"] == "priority_order":
            break
        run = await decide(client, auth, run)
    return await get(client, auth, run["id"])


async def snapshots(tenant_id, run_id=None) -> list[PrioritySnapshot]:
    async with tenant_session(tenant_id) as s:
        q = select(PrioritySnapshot).order_by(PrioritySnapshot.created_at)
        if run_id:
            q = q.where(PrioritySnapshot.run_id == uuid.UUID(str(run_id)))
        return list(await s.scalars(q))


# --------------------------------------------------------------------------- the check


def live_row(key: str, rank: int, flags=()) -> dict:
    return {
        "key": key,
        "rank": rank,
        "title": key.title(),
        "flags": list(flags),
        "depends_on": [],
        "explanation": {"formula": "f", "steps": []},
    }


def known(
    features=("a", "b", "c", "d"), *, scope=None, depends_on=None, live=None, method="goal_weighted"
) -> run_order.Known:
    rows = live if live is not None else [live_row(k, i + 1) for i, k in enumerate(features)]
    return run_order.Known(
        features={k: k.title() for k in features},
        scope=list(scope) if scope is not None else None,
        depends_on={k: set(v) for k, v in (depends_on or {}).items()},
        live={method: rows},
    )


def order(*rows: tuple[str, int], method: str = "goal_weighted", version: int = 1) -> str:
    lines = [f"version: {version}", f"method: {method}", "order:"]
    for key, rank in rows:
        lines += [
            f"  - key: {key}",
            f"    rank: {rank}",
            "    score: 1",
            f"    explanation: {key} explained",
        ]
    return "\n".join(lines) + "\n"


def codes(check: run_order.OrderCheck) -> list[tuple[str, bool, str | None]]:
    return [(p["code"], p["blocking"], p["feature"]) for p in check.problems]


CLEAN_ABCD = order(("a", 1), ("b", 2), ("c", 3), ("d", 4))


def test_check_a_clean_order_has_no_problem():
    out = run_order.check_order(CLEAN_ABCD, known=known())
    assert out.problems == [] and out.blocking == 0
    assert out.method == "goal_weighted"
    assert [(r["key"], r["rank"], r["live_rank"]) for r in out.order] == [
        ("a", 1, 1),
        ("b", 2, 2),
        ("c", 3, 3),
        ("d", 4, 4),
    ]


@pytest.mark.parametrize(
    "text",
    [
        "version: 1\nmethod: goal_weighted\norder: [unclosed\n",
        "- just a list\n",
        "version: 1\nmethod: goal_weighted\norder: 3\n",
    ],
)
def test_check_unreadable_yaml(text):
    out = run_order.check_order(text, known=known())
    assert [c for c, _, _ in codes(out)][:1] == ["unreadable_yaml"]
    assert out.blocking >= 1


def test_check_wrong_version():
    out = run_order.check_order(
        order(("a", 1), ("b", 2), ("c", 3), ("d", 4), version=2), known=known()
    )
    assert codes(out) == [("wrong_version", True, None)]


def test_check_unknown_method():
    out = run_order.check_order(CLEAN_ABCD.replace("goal_weighted", "gut_feel"), known=known())
    assert codes(out) == [("unknown_method", True, None)]


def test_check_duplicate_key():
    out = run_order.check_order(
        order(("a", 1), ("b", 2), ("c", 3), ("d", 4), ("a", 5)), known=known()
    )
    assert codes(out) == [("duplicate_key", True, "a")]


def test_check_duplicate_rank():
    out = run_order.check_order(order(("a", 1), ("b", 2), ("c", 2), ("d", 3)), known=known())
    assert codes(out) == [("duplicate_rank", True, "c")]


def test_check_rank_gap():
    out = run_order.check_order(order(("a", 1), ("b", 2), ("c", 3), ("d", 5)), known=known())
    assert codes(out) == [("rank_gap", True, None)]
    assert "4" in out.problems[0]["message"]


def test_check_unknown_feature():
    text = order(("a", 1), ("b", 2), ("c", 3), ("d", 4), ("ghost", 5))
    out = run_order.check_order(text, known=known())
    assert codes(out) == [("unknown_feature", True, "ghost")]


def test_check_a_scope_feature_not_in_the_baseline_is_known():
    """A feature of the approved scope that is a proposal of the run (not in the baseline
    yet) is ranked like any other."""
    k = known(("a", "b"), scope=("a", "b", "new-one"))
    k.features["new-one"] = "New one"
    out = run_order.check_order(order(("a", 1), ("b", 2), ("new-one", 3)), known=k)
    assert out.problems == []
    assert [r["live_rank"] for r in out.order] == [1, 2, None]


def test_check_not_in_scope_and_missing_feature():
    out = run_order.check_order(order(("a", 1), ("b", 2), ("d", 3)), known=known(scope="abc"))
    assert codes(out) == [("not_in_scope", True, "d"), ("missing_feature", True, "c")]


def test_check_no_scope_skips_the_scope_codes():
    out = run_order.check_order(order(("a", 1), ("b", 2)), known=known())
    assert out.problems == []


def test_check_before_prerequisite_names_both_features():
    out = run_order.check_order(
        order(("b", 1), ("a", 2), ("c", 3), ("d", 4)), known=known(depends_on={"b": ["a"]})
    )
    assert codes(out) == [("before_prerequisite", True, "b")]
    message = out.problems[0]["message"]
    assert "b" in message.split() and "a" in message.split()
    assert message == "b is ranked 1, above a (rank 2), which it depends on"


def test_check_differs_from_live_and_no_goal_are_advisory():
    live = [
        live_row("a", 1),
        live_row("b", 2),
        live_row("c", 3),
        live_row("d", 4, ["no_confirmed_goal"]),
    ]
    out = run_order.check_order(
        order(("d", 1), ("a", 2), ("b", 3), ("c", 4)), known=known(live=live)
    )
    assert codes(out) == [("differs_from_live", False, "d"), ("no_goal", False, "d")]
    assert out.blocking == 0
    assert out.problems[0]["message"] == "d is ranked 1 here and 4 in the live ranking"


def test_live_rank_is_restricted_to_the_ranked_features():
    """The live ranking of the same method, restricted to the same features: x, ranked
    live between a and b and left out of the run's order, shifts nothing."""
    live = [
        live_row("a", 1),
        live_row("x", 2),
        live_row("x2", 3),
        live_row("x3", 4),
        live_row("b", 5),
    ]
    k = known(("a", "b", "x", "x2", "x3"), live=live)
    out = run_order.check_order(order(("b", 1), ("a", 2)), known=k)
    assert [(r["key"], r["live_rank"]) for r in out.order] == [("b", 2), ("a", 1)]
    assert out.problems == []
    # Another method's live ranking is the one read when the file names it.
    k.live["rice"] = [live_row("b", 1), live_row("a", 2)]
    out = run_order.check_order(order(("b", 1), ("a", 2), method="rice"), known=k)
    assert [(r["key"], r["live_rank"]) for r in out.order] == [("b", 1), ("a", 2)]


# --------------------------------------------------------------------------- the stop


async def test_segment_end_stores_a_proposed_snapshot(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    text = ORDER.replace("method: goal_weighted", "method: rice")
    run = await at_priority(client, owner, runtime, text)
    assert run["status"] == "awaiting_checkpoint" and run["waiting_on"] == "priority_order"
    segment = next(s for s in run["segments"] if s["name"] == "priority")
    check = segment["priority_check"]
    assert check["method"] == "rice" and check["features"] == 3
    assert [p["code"] for p in check["problems"] if p["blocking"]] == []
    cp = pending(run)
    assert cp["payload"]["priority_check"] == check
    assert cp["cannot_approve"] is None

    (snap,) = await snapshots(tenant_id, run["id"])
    assert cp["payload"]["priority_snapshot_id"] == str(snap.id)
    assert snap.status == "proposed" and snap.method == "rice"
    assert str(snap.checkpoint_id) == cp["id"] and snap.document_id is None
    (scope,) = await scopes(tenant_id, run["id"])
    assert snap.scope_id == scope.id and scope.status == "approved"
    assert [(r["key"], r["rank"], r["live_rank"]) for r in snap.ranking] == [
        ("address-lookup", 1, 1),
        ("saved-addresses", 2, 2),
    ]  # bulk-edit is not in the live ranking: it stays in the check's order only
    assert snap.ranking[1]["run_explanation"].startswith("Needs address-lookup first")
    assert snap.ranking[0]["explanation"]["method"] == "rice"
    assert [(r["key"], r["rank"], r["live_rank"]) for r in snap.check_result["order"]] == [
        ("address-lookup", 1, 1),
        ("saved-addresses", 2, 2),
        ("bulk-edit", 3, None),
    ]
    # The prioritizer was told the format.
    prompt = runtime.submitted[-1].steps[-1].prompt
    assert "method: <goal_weighted | rice | moscow | wsjf>" in prompt
    assert "version: 1" in prompt


async def test_priority_approve_saves(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    run = await at_priority(client, owner, runtime)
    approver = await as_user(tenant_id, "approver")
    run = await decide(client, approver, run, note="Good order")
    assert run["status"] == "running"
    (snap,) = await snapshots(tenant_id, run["id"])
    assert snap.status == "saved" and snap.decided_by is not None and snap.decided_at
    async with tenant_session(tenant_id) as s:
        ev = await s.scalar(
            select(AuditEvent).where(AuditEvent.action == "priority_snapshot.approved")
        )
    assert ev is not None and ev.entity_id == snap.id


async def test_approve_refused_with_blocking_then_request_changes_discards(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
):
    tenant_id, auth = owner
    run = await at_priority(client, owner, runtime, BLOCKING)
    cp = pending(run)
    assert cp["cannot_approve"] == BLOCKED
    (p,) = [p for p in cp["payload"]["priority_check"]["problems"] if p["blocking"]]
    assert p["code"] == "before_prerequisite" and p["feature"] == "saved-addresses"
    url = f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/decide"
    for headers in (auth, await as_user(tenant_id, "approver")):
        resp = await client.post(url, json={"decision": "approved"}, headers=headers)
        assert resp.status_code == 409, resp.text
        assert resp.json()["detail"] == BLOCKED
    async with mcp_client(await api_token(tenant_id)) as c:
        out = await c.call_tool(
            "decide_checkpoint",
            {"run_id": run["id"], "checkpoint_id": cp["id"], "body": {"decision": "approved"}},
        )
        assert out.is_error and BLOCKED in text_of(out)
    (snap,) = await snapshots(tenant_id, run["id"])
    assert snap.status == "proposed"

    resp = await client.post(
        url, json={"decision": "changes_requested", "note": "Lookup first"}, headers=auth
    )
    assert resp.status_code == 200, resp.text
    (snap,) = await snapshots(tenant_id, run["id"])
    assert snap.status == "discarded" and snap.decided_by is not None


async def test_a_rerun_proposal_discards_the_earlier_one(client, owner):  # noqa: F811
    tenant_id, _ = owner
    await seed_baseline(tenant_id)
    async with tenant_session(tenant_id) as s:
        run = Run(flow="baseline_to_prd", knobs={"document_slug": DOC})
        s.add(run)
        await s.flush()
        k, scope_id = await run_order.known_for_run(s, run)
        check = run_order.check_order(ORDER, known=k)
        a = await run_order.propose(
            s, run, segment_seq=3, attempt=1, check=check, known=k, scope_id=scope_id
        )
        b = await run_order.propose(
            s, run, segment_seq=3, attempt=2, check=check, known=k, scope_id=scope_id
        )
        # Written again for the same attempt (a resumed segment end): replaced, not doubled.
        c = await run_order.propose(
            s, run, segment_seq=3, attempt=2, check=check, known=k, scope_id=scope_id
        )
        await s.commit()
        rows = list(
            await s.scalars(select(PrioritySnapshot).where(PrioritySnapshot.run_id == run.id))
        )
    assert a.status == "discarded" and c.status == "proposed" and b.id == c.id
    assert sorted(r.status for r in rows) == ["discarded", "proposed"]


async def test_stop_off_saves_a_clean_order_by_oracle(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    run = await at_priority(client, owner, runtime, checkpoints={"priority_order": False})
    assert run["status"] in ("running", "awaiting_checkpoint") and run["error"] is None
    (snap,) = await snapshots(tenant_id, run["id"])
    assert snap.status == "saved" and snap.decided_by is None and snap.decided_at
    async with tenant_session(tenant_id) as s:
        ev = await s.scalar(
            select(AuditEvent).where(AuditEvent.action == "priority_snapshot.approved")
        )
    assert ev.actor == "oracle" and ev.data["reason"] == "stop off"


async def test_stop_off_fails_the_run_on_a_blocking_problem(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    run = await at_priority(client, owner, runtime, BLOCKING, checkpoints={"priority_order": False})
    assert run["status"] == "failed"
    assert run["error"].startswith("priority.yaml was rejected: [before_prerequisite]")
    (snap,) = await snapshots(tenant_id, run["id"])
    assert snap.status == "proposed"


async def test_the_draft_import_fills_the_document(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    run = await at_priority(client, owner, runtime)
    run = await decide(client, auth, run)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["document_id"]
    (snap,) = await snapshots(tenant_id, run["id"])
    assert snap.status == "saved" and str(snap.document_id) == run["document_id"]
    # The Snapshots list names its PRD.
    (row,) = (await client.get("/v1/priorities/snapshots", headers=auth)).json()
    assert row["id"] == str(snap.id) and row["run_id"] == run["id"]
    assert row["document"]["slug"] == DOC and row["document"]["title"]


# --------------------------------------------------------------------------- readers


def ranked(key: str, formula: str) -> dict:
    """A RankedFeature as JSON, as a snapshot stores it."""
    confidence = {"value": 0.5, "source": "default", "explain": "assumed", "evidence": []}
    explanation = {
        "method": "goal_weighted",
        "formula": formula,
        "inputs": {},
        "confidence": confidence,
        "goals": [],
        "missing": [],
        "steps": [],
    }
    return {
        "rank": 1,
        "score_rank": 1,
        "entity_id": str(uuid.uuid4()),
        "key": key,
        "title": key,
        "status": "confirmed",
        "score": 1.0,
        "serves_goal": True,
        "flags": [],
        "depends_on": [],
        "dependents": [],
        "explanation": explanation,
    }


async def add_snapshot(
    tenant_id, status, *, run_id=None, document_id=None, minutes=0, key="address-lookup"
) -> uuid.UUID:
    async with tenant_session(tenant_id) as s:
        snap = PrioritySnapshot(
            method="goal_weighted",
            params={},
            ranking=[ranked(key, f"{status} order")],
            status=status,
            run_id=run_id,
            document_id=document_id,
            decided_at=datetime.now(UTC) if status == "saved" and run_id else None,
        )
        s.add(snap)
        await s.flush()
        snap.created_at = datetime.now(UTC) + timedelta(minutes=minutes)
        await s.commit()
        return snap.id


async def test_list_and_read_show_saved_unless_asked(client, owner):  # noqa: F811
    tenant_id, auth = owner
    saved = await add_snapshot(tenant_id, "saved")
    proposed = await add_snapshot(tenant_id, "proposed", minutes=1)
    discarded = await add_snapshot(tenant_id, "discarded", minutes=2)

    async def ids(query=""):
        resp = await client.get(f"/v1/priorities/snapshots{query}", headers=auth)
        assert resp.status_code == 200, resp.text
        return [r["id"] for r in resp.json()]

    assert await ids() == [str(saved)]
    assert await ids("?status=proposed") == [str(proposed)]
    assert await ids("?status=discarded") == [str(discarded)]
    assert await ids("?status=all") == [str(discarded), str(proposed), str(saved)]
    assert (
        await client.get("/v1/priorities/snapshots?status=nope", headers=auth)
    ).status_code == 422
    # Read: a proposed one only when asked.
    url = f"/v1/priorities/snapshots/{proposed}"
    assert (await client.get(url, headers=auth)).status_code == 404
    out = await client.get(url + "?status=all", headers=auth)
    assert out.status_code == 200 and out.json()["status"] == "proposed"


async def test_compare_rows_follow_the_check_and_the_live_ranking(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    run = await at_priority(client, owner, runtime, BLOCKING)
    (snap,) = await snapshots(tenant_id, run["id"])
    viewer = await as_user(tenant_id, "viewer")
    resp = await client.get(f"/v1/priorities/snapshots/{snap.id}/compare", headers=viewer)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["snapshot"]["status"] == "proposed"
    assert body["snapshot"]["run_id"] == run["id"]
    assert body["snapshot"]["check_result"]["problems"]
    assert body["live_generated_at"]
    assert body["run"]["flow_title"] == "Baseline to PRD"
    assert body["checkpoint"]["id"] == pending(run)["id"]
    assert body["checkpoint"]["cannot_approve"] == BLOCKED
    rows = {r["key"]: r for r in body["rows"]}
    assert [r["key"] for r in body["rows"]] == ["saved-addresses", "address-lookup", "bulk-edit"]
    assert (rows["saved-addresses"]["run_rank"], rows["saved-addresses"]["live_rank"]) == (1, 2)
    # delta = live rank - run rank: positive, the run ranks it higher than Oracle does.
    assert rows["saved-addresses"]["delta"] == 1
    assert rows["address-lookup"]["delta"] == -1
    assert rows["bulk-edit"]["live_rank"] is None and rows["bulk-edit"]["delta"] is None
    assert rows["saved-addresses"]["title"] == "Saved addresses"
    assert rows["saved-addresses"]["run_explanation"].startswith("Needs address-lookup first")
    assert rows["saved-addresses"]["live_explanation"]
    (p,) = rows["saved-addresses"]["problems"]
    assert p["code"] == "before_prerequisite" and p["blocking"] is True
    assert rows["address-lookup"]["problems"] == []


async def test_compare_is_404_for_an_unknown_snapshot(client, owner):  # noqa: F811
    _, auth = owner
    resp = await client.get(f"/v1/priorities/snapshots/{uuid.uuid4()}/compare", headers=auth)
    assert resp.status_code == 404


async def roadmap_prompt(client, auth, runtime) -> str:  # noqa: F811
    from tests.test_roadmap import PRD, create, start

    await start(client, auth, await create(client, auth, source=PRD))
    return runtime.submitted[-1].steps[-1].prompt


async def test_roadmap_reads_only_saved(client, owner, runtime):  # noqa: F811
    from tests.test_roadmap import approved_prd
    from tests.test_roadmap import seed_baseline as seed_roadmap_baseline

    tenant_id, auth = owner
    await approved_prd(client, auth)
    await seed_roadmap_baseline(tenant_id)
    await add_snapshot(tenant_id, "saved", key="company-order")
    run_id = uuid.uuid4()
    async with tenant_session(tenant_id) as s:
        s.add(Run(id=run_id, flow="baseline_to_prd"))
        await s.commit()
    # A run's order, newer than every saved one, not approved (or discarded).
    await add_snapshot(tenant_id, "proposed", run_id=run_id, minutes=5, key="proposed-order")
    await add_snapshot(tenant_id, "discarded", run_id=run_id, minutes=6, key="discarded-order")
    prompt = await roadmap_prompt(client, auth, runtime)
    assert "company-order" in prompt
    assert "proposed-order" not in prompt and "discarded-order" not in prompt
    assert "Priority order (goal_weighted, priority snapshot of" in prompt


async def test_roadmap_reads_this_prds_approved_order(client, owner, runtime):  # noqa: F811
    from tests.test_roadmap import PRD, approved_prd
    from tests.test_roadmap import seed_baseline as seed_roadmap_baseline

    tenant_id, auth = owner
    await approved_prd(client, auth)
    await seed_roadmap_baseline(tenant_id)
    async with tenant_session(tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == PRD))
        other = Document(slug="other-prd", title="Other PRD", kind="prd")
        run = Run(flow="baseline_to_prd")
        s.add_all([other, run])
        await s.commit()
    await add_snapshot(tenant_id, "saved", run_id=run.id, document_id=doc.id, key="this-prd-order")
    # Newer: a person's company-wide snapshot and another PRD's approved order.
    await add_snapshot(tenant_id, "saved", minutes=3, key="company-order")
    await add_snapshot(
        tenant_id, "saved", run_id=run.id, document_id=other.id, minutes=4, key="other-prd-order"
    )
    prompt = await roadmap_prompt(client, auth, runtime)
    assert "this-prd-order" in prompt
    assert "company-order" not in prompt and "other-prd-order" not in prompt
    today = datetime.now(UTC)
    assert f"Priority order (goal_weighted, this PRD's approved order of {today:%-d %b}" in prompt


async def test_existing_checkpoints_of_other_kinds_are_not_gated(client, owner):  # noqa: F811
    """A priority_order checkpoint from before C8 (no check on its payload) approves as
    before: nothing to gate on."""
    from oracle.runs.service import _cannot_approve

    cp = Checkpoint(kind="priority_order", status="pending", payload={})
    assert _cannot_approve(cp) is None
    cp.payload = {"priority_check": {"problems": [{"code": "no_goal", "blocking": False}]}}
    assert _cannot_approve(cp) is None
