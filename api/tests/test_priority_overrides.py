"""C9 Move and pin: approvers reorder priorities with a reason, Oracle pushes back once
when the numbers disagree, and every override is logged.

Unit tests cover ``apply_overrides`` (moves, pins, chains, dependency repair, dropped
anchors) and each pushback rule at its threshold edge; API tests cover create, confirm,
remove and replace, roles and run tokens, the readers (snapshots, the roadmap context)
and the migration. The reason check has its own file (test_priority_reason_check.py);
here no Claude account exists, so every check reads ``failed`` and the rules decide.
"""

import asyncio
import uuid
from datetime import UTC, datetime
from decimal import Decimal

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import select, text
from sqlalchemy.engine import make_url

from oracle.baseline.models import Edge, Entity, Evidence
from oracle.models import AuditEvent
from oracle.priorities import pushback
from oracle.priorities.models import PriorityOverride, PrioritySnapshot
from oracle.priorities.scoring import (
    EvidenceRef,
    FeatureInput,
    GoalLink,
    OverrideIn,
    apply_overrides,
    rank,
)
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx, make_item
from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema
from tests.test_mcp import mcp_client, run_token, text_of

# --- unit: apply_overrides ----------------------------------------------------------------


def f(key, score=1.0, *, conf=0.8, goal=True, deps=(), sources=1) -> FeatureInput:
    """A feature whose goal-weighted score is ``score`` (one goal, effort 1)."""
    return FeatureInput(
        id=f"id-{key}",
        key=key,
        title=key.replace("-", " ").title(),
        status="confirmed",
        attrs={"effort": 1},
        evidence=[EvidenceRef(id=f"{key}-e{i}", confidence=conf, ref=None) for i in range(sources)],
        goals=[GoalLink("activation", "Activation", score / conf, 1, "confirmed")] if goal else [],
        depends_on=list(deps),
    )


def move(key, above, n=1) -> OverrideIn:
    return OverrideIn(id=f"o{n}", feature=key, kind="move", above=above, position=None, info={})


def pin(key, position, n=1) -> OverrideIn:
    return OverrideIn(id=f"o{n}", feature=key, kind="pin", above=None, position=position, info={})


def keys(result) -> list[str]:
    return [r["key"] for r in result["features"]]


FIVE = [f("a", 5), f("b", 4), f("c", 3), f("d", 2), f("e", 1)]


def test_no_overrides_leaves_the_formula_order_and_sets_formula_rank():
    base = rank(FIVE)
    out = apply_overrides(base, [])
    assert keys(out) == ["a", "b", "c", "d", "e"]
    assert [r["formula_rank"] for r in out["features"]] == [1, 2, 3, 4, 5]
    assert all(r["override"] is None for r in out["features"])


def test_a_move_goes_directly_above_its_anchor():
    out = apply_overrides(rank(FIVE), [move("d", "b")])
    assert keys(out) == ["a", "d", "b", "c", "e"]
    d = out["features"][1]
    assert d["rank"] == 2 and d["formula_rank"] == 4 and d["score_rank"] == 4
    assert d["override"] is not None and d["override"]["id"] == "o1"
    # The others keep their formula rank beside their new place.
    assert [(r["key"], r["formula_rank"]) for r in out["features"]][2] == ("b", 2)


def test_a_pin_holds_its_rank_and_clamps_to_the_list():
    assert keys(apply_overrides(rank(FIVE), [pin("e", 1)])) == ["e", "a", "b", "c", "d"]
    assert keys(apply_overrides(rank(FIVE), [pin("a", 3)])) == ["b", "c", "a", "d", "e"]
    assert keys(apply_overrides(rank(FIVE), [pin("a", 99)])) == ["b", "c", "d", "e", "a"]


def test_overrides_chain_in_creation_order():
    out = apply_overrides(rank(FIVE), [pin("e", 1, 1), move("d", "e", 2)])
    assert keys(out) == ["d", "e", "a", "b", "c"]


def test_dependencies_win():
    """protects=decision O3 Prioritization dependency order; fails_when=any override puts
    a feature above its prerequisite; no_claim=cycles (reported as today)."""
    features = [f("a", 5), f("b", 4), f("c", 3), f("prereq", 2), f("x", 1, deps=["prereq"])]
    base = rank(features)
    assert keys(base) == ["a", "b", "c", "prereq", "x"]
    out = apply_overrides(base, [pin("x", 1)])
    assert keys(out) == ["a", "b", "c", "prereq", "x"]
    x = out["features"][4]
    assert "held_by_dependency" in x["flags"] and x["held_below"] == "prereq"
    assert any("prereq" in line for line in x["explanation"]["order"])
    # Moving the prerequisite down drags what needs it below it too.
    down = apply_overrides(base, [pin("prereq", 5)])
    order = keys(down)
    assert order.index("prereq") < order.index("x")
    assert "held_by_dependency" in down["features"][order.index("x")]["flags"]


def test_a_move_whose_anchor_is_gone_is_dropped():
    out = apply_overrides(rank(FIVE), [move("e", "gone"), move("ghost", "a", 2)])
    assert keys(out) == ["a", "b", "c", "d", "e"]
    assert out["dropped"] == ["o1", "o2"]


def test_cycles_keep_their_members_together():
    features = [f("a", 5, deps=["b"]), f("b", 4, deps=["a"]), f("c", 3)]
    out = apply_overrides(rank(features), [pin("c", 1)])
    assert keys(out)[0] == "c"
    assert out["cycles"] == [["a", "b"]]


# --- unit: the four pushback rules ------------------------------------------------------


def _check(features, override, *, low=0.4, blockers=None):
    base = apply_overrides(rank(features), [])
    after = apply_overrides(rank(features), [override])
    return pushback.rules(
        base["features"], after["features"], override.feature, low=low, blockers=blockers or {}
    )


def codes(messages) -> list[str]:
    return [m["code"] for m in messages]


def test_no_confirmed_goal_fires_when_it_passes_a_goal_feature():
    features = [f("goal-a", 3), f("goal-b", 2), f("loner", goal=False)]
    msgs = _check(features, move("loner", "goal-b"))
    [msg] = [m for m in msgs if m["code"] == "no_confirmed_goal"]
    assert "Loner serves no confirmed goal" in msg["message"]
    assert "Goal B serves Activation" in msg["message"]
    assert msg["numbers"]["passes"] == "goal-b"
    assert msg["numbers"]["passes_score"] == pytest.approx(2)


def test_no_confirmed_goal_misses_when_it_passes_only_goalless_features():
    features = [f("goal-a", 3), f("loner-a", goal=False), f("loner-b", goal=False)]
    base = keys(rank(features))
    assert base[-1] == "loner-b"
    assert "no_confirmed_goal" not in codes(_check(features, move(base[-1], base[-2])))


def test_low_confidence_fires_below_the_threshold_and_misses_at_it():
    features = [f("sure", 2, conf=0.72, sources=4), f("shaky", 1, conf=0.31)]
    [msg] = [m for m in _check(features, pin("shaky", 1)) if m["code"] == "low_confidence"]
    assert msg["message"] == "Confidence 0.31 is below 0.4; Sure has 0.72 from 4 sources."
    at = [f("sure", 2, conf=0.72), f("edge", 1, conf=0.4)]
    assert "low_confidence" not in codes(_check(at, pin("edge", 1)))
    # The company's own threshold decides.
    assert "low_confidence" in codes(_check(at, pin("edge", 1), low=0.5))


def test_low_confidence_misses_when_the_passed_feature_is_below_it_too():
    features = [f("weak", 2, conf=0.35), f("weaker", 1, conf=0.3)]
    assert "low_confidence" not in codes(_check(features, pin("weaker", 1)))


def test_against_score_fires_at_three_places_and_twice_the_score():
    features = [f("a", 10), f("b", 9), f("c", 8), f("d", 2.4), f("x", 1.2)]
    msgs = _check(features, move("x", "c"))  # 5 -> 3: two places
    assert "against_score" not in codes(msgs)
    [msg] = [m for m in _check(features, move("x", "b")) if m["code"] == "against_score"]
    assert msg["numbers"]["formula_rank"] == 5 and msg["numbers"]["rank"] == 2
    assert "Score 1.2 against" in msg["message"] and "× higher" in msg["message"]


def test_against_score_misses_under_twice_the_score():
    features = [f("a", 2.3), f("b", 2.3), f("c", 2.3), f("x", 1.2)]
    assert "against_score" not in codes(_check(features, pin("x", 1)))
    features = [f("a", 2.4), f("b", 2.3), f("c", 2.3), f("x", 1.2)]
    assert "against_score" in codes(_check(features, pin("x", 1)))


def test_open_blocker_fires_entering_the_top_three_and_misses_at_four():
    features = [f("a", 5), f("b", 4), f("c", 3), f("d", 2), f("e", 1)]
    blockers = {"e": ["Card vault limits"]}
    [msg] = [
        m
        for m in _check(features, move("e", "c"), blockers=blockers)
        if m["code"] == "open_blocker"
    ]
    assert msg["message"] == "An open critical blocker (Card vault limits) is linked to it."
    assert "open_blocker" not in codes(_check(features, move("e", "d"), blockers=blockers))


def test_a_change_with_no_contradiction_has_no_messages():
    features = [f("a", 2), f("b", 1.9)]
    assert _check(features, move("b", "a")) == []


# --- API --------------------------------------------------------------------------------


@pytest.fixture
def local_runtime():
    """The local runtime: run tokens from any address (as tests.test_mcp)."""
    from oracle.swarm import FakeRuntime, set_runtime

    set_runtime(FakeRuntime())
    yield
    set_runtime(None)


async def _baseline(ctx: Ctx) -> dict[str, uuid.UUID]:
    """Formula order: saved-addresses, shipping-cost, usage-alerts, address-lookup,
    one-click (needs address-lookup), bulk-edit (no confirmed goal)."""
    async with tenant_session(ctx.tenant_id) as s:
        out: dict[str, Entity] = {}

        def entity(type_, key, **attrs):
            e = Entity(
                type=type_,
                key=key,
                title=key.replace("-", " ").capitalize(),
                attrs=attrs,
                status="confirmed",
                origin="user",
            )
            s.add(e)
            out[key] = e
            return e

        activation = entity("goal", "activation", weight=3)
        retention = entity("goal", "retention", weight=2)
        entity("feature", "saved-addresses", effort=1)
        entity("feature", "shipping-cost", effort=2, confidence=0.8)
        entity("feature", "usage-alerts", effort=2, confidence=0.6)
        entity("feature", "address-lookup", effort=3, confidence=0.5)
        entity("feature", "one-click", effort=8, confidence=0.5)
        entity("feature", "bulk-edit", effort=1, confidence=0.9)
        await s.flush()

        def edge(src, dst, type_, **attrs):
            s.add(
                Edge(
                    src_id=out[src].id,
                    dst_id=out[dst].id,
                    type=type_,
                    attrs=attrs,
                    status="confirmed",
                    origin="user",
                )
            )

        edge("saved-addresses", "activation", "supports", contribution=2)
        edge("shipping-cost", "activation", "supports", contribution=3)
        edge("usage-alerts", "retention", "supports", contribution=2)
        edge("address-lookup", "activation", "supports", contribution=1)
        edge("one-click", "retention", "supports", contribution=1)
        edge("one-click", "address-lookup", "depends_on")
        for c in ("0.8", "0.6"):
            s.add(
                Evidence(
                    entity_id=out["saved-addresses"].id,
                    url=f"https://example.com/research/{c}",
                    confidence=Decimal(c),
                )
            )
        await s.commit()
        assert activation.id and retention.id
        return {k: e.id for k, e in out.items()}


FORMULA = [
    "saved-addresses",
    "shipping-cost",
    "usage-alerts",
    "address-lookup",
    "one-click",
    "bulk-edit",
]


async def _ranking(client, ctx: Ctx, who="viewer", **params) -> list[dict]:
    resp = await client.get("/v1/priorities", params=params, headers=ctx.as_(who))
    assert resp.status_code == 200, resp.text
    return resp.json()["features"]


async def _create(client, ctx: Ctx, who="approver", **body):
    body.setdefault("reason", "A launch partner needs it in the first release")
    return await client.post("/v1/priorities/overrides", json=body, headers=ctx.as_(who))


async def test_a_move_with_no_contradiction_is_stored_and_read(client):
    ctx = await make_ctx()
    ids = await _baseline(ctx)
    assert [r["key"] for r in await _ranking(client, ctx)] == FORMULA
    resp = await _create(
        client,
        ctx,
        feature_id=str(ids["address-lookup"]),
        kind="move",
        above_feature_id=str(ids["shipping-cost"]),
    )
    assert resp.status_code == 201, resp.text
    out = resp.json()
    assert out["kind"] == "move" and out["feature"]["key"] == "address-lookup"
    assert out["above"]["key"] == "shipping-cost" and out["kept_after_pushback"] is False
    assert out["pushback"] == [] and out["created_by"]["name"] == "approver@example.com"
    # No Claude account here: the reason check fails quietly and the rules decide.
    assert out["reason_check"]["status"] == "failed"

    rows = await _ranking(client, ctx)
    assert [r["key"] for r in rows][:3] == ["saved-addresses", "address-lookup", "shipping-cost"]
    moved = rows[1]
    assert moved["formula_rank"] == 4 and moved["rank"] == 2
    assert moved["override"]["id"] == out["id"] and moved["override"]["kind"] == "move"
    assert moved["override"]["by"] == "approver@example.com"
    assert moved["override"]["reason"].startswith("A launch partner")

    # Oracle's order: the formula only, unchanged from before.
    plain = await _ranking(client, ctx, overrides="false")
    assert [r["key"] for r in plain] == FORMULA
    assert all(r["override"] is None for r in plain)
    async with tenant_session(ctx.tenant_id) as s:
        actions = [e.action for e in await s.scalars(select(AuditEvent))]
    assert "priority_override.created" in actions


async def test_pushback_once(client):
    """protects=decision C1b Pushback policy (push back once, then comply and log);
    fails_when=a contradicting change is stored without confirmation, or a confirmed one
    is refused; no_claim=whether the rules catch every bad call."""
    ctx = await make_ctx()
    ids = await _baseline(ctx)
    body = {
        "feature_id": str(ids["bulk-edit"]),
        "kind": "move",
        "above_feature_id": str(ids["usage-alerts"]),
    }
    resp = await _create(client, ctx, **body)
    assert resp.status_code == 409, resp.text
    out = resp.json()
    assert out["detail"] == "Oracle disagrees with this change"
    msg = next(m for m in out["pushback"] if m["code"] == "no_confirmed_goal")
    assert "serves no confirmed goal" in msg["message"] and msg["numbers"]["passes"]
    assert out["preview_rank"] == 3 and out["held_below"] is None
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.scalars(select(PriorityOverride))).all() == []

    kept = await _create(client, ctx, confirm=True, **body)
    assert kept.status_code == 201, kept.text
    row = kept.json()
    assert row["kept_after_pushback"] is True
    assert "no_confirmed_goal" in [m["code"] for m in row["pushback"]]
    log = (await client.get("/v1/priorities/overrides", headers=ctx.as_("viewer"))).json()
    assert [o["id"] for o in log] == [row["id"]] and log[0]["kept_after_pushback"] is True
    rows = await _ranking(client, ctx)
    assert [r["key"] for r in rows].index("bulk-edit") == 2


async def test_a_pin_is_held_below_its_prerequisite(client):
    ctx = await make_ctx()
    ids = await _baseline(ctx)
    resp = await _create(client, ctx, feature_id=str(ids["one-click"]), kind="pin", position=1)
    assert resp.status_code == 201, resp.text
    assert resp.json()["held_below"] == "address-lookup"
    rows = await _ranking(client, ctx)
    order = [r["key"] for r in rows]
    assert order.index("one-click") == order.index("address-lookup") + 1
    held = rows[order.index("one-click")]
    assert "held_by_dependency" in held["flags"] and held["held_below"] == "address-lookup"


async def test_a_second_override_replaces_the_first_and_remove_ends_it(client):
    ctx = await make_ctx()
    ids = await _baseline(ctx)
    first = await _create(client, ctx, feature_id=str(ids["usage-alerts"]), kind="pin", position=1)
    assert first.status_code == 201, first.text
    second = await _create(
        client,
        ctx,
        feature_id=str(ids["usage-alerts"]),
        kind="move",
        above_feature_id=str(ids["shipping-cost"]),
    )
    assert second.status_code == 201, second.text
    log = (
        await client.get(
            "/v1/priorities/overrides",
            params={"include_removed": "true"},
            headers=ctx.as_("viewer"),
        )
    ).json()
    old = next(o for o in log if o["id"] == first.json()["id"])
    assert old["removed_at"] is not None and old["replaced_by"] == second.json()["id"]
    active = (await client.get("/v1/priorities/overrides", headers=ctx.as_("viewer"))).json()
    assert [o["id"] for o in active] == [second.json()["id"]]

    # Commenters see overrides but cannot remove one.
    oid = second.json()["id"]
    refused = await client.request(
        "DELETE", f"/v1/priorities/overrides/{oid}", json={}, headers=ctx.as_("commenter")
    )
    assert refused.status_code == 403
    gone = await client.request(
        "DELETE",
        f"/v1/priorities/overrides/{oid}",
        json={"reason": "The partner moved their date"},
        headers=ctx.as_("approver"),
    )
    assert gone.status_code == 200, gone.text
    assert gone.json()["removed_at"] and gone.json()["removed_by"]["name"] == "approver@example.com"
    assert gone.json()["removed_reason"] == "The partner moved their date"
    assert [r["key"] for r in await _ranking(client, ctx)] == FORMULA
    again = await client.request(
        "DELETE", f"/v1/priorities/overrides/{oid}", json={}, headers=ctx.as_("approver")
    )
    assert again.status_code == 409
    async with tenant_session(ctx.tenant_id) as s:
        actions = [e.action for e in await s.scalars(select(AuditEvent))]
    assert "priority_override.replaced" in actions and "priority_override.removed" in actions


async def test_overrides_apply_under_every_method(client):
    ctx = await make_ctx()
    ids = await _baseline(ctx)
    resp = await _create(client, ctx, feature_id=str(ids["usage-alerts"]), kind="pin", position=1)
    assert resp.status_code == 201, resp.text
    for method in ("goal_weighted", "rice", "moscow", "wsjf"):
        rows = await _ranking(client, ctx, method=method)
        assert rows[0]["key"] == "usage-alerts", method
        assert rows[0]["override"] is not None and rows[0]["formula_rank"] >= 1


async def test_overrides_reach_readers(client, local_runtime):
    """protects=a person's order is the order everyone reads; fails_when=snapshots, the
    roadmap context or get_priorities ignore active overrides; no_claim=the draft's use
    of it."""
    from oracle.docs.models import Document, DocumentVersion
    from oracle.runs import service as runs_service
    from oracle.runs.models import Run

    ctx = await make_ctx()
    ids = await _baseline(ctx)
    created = await _create(
        client, ctx, feature_id=str(ids["usage-alerts"]), kind="pin", position=1
    )
    assert created.status_code == 201, created.text

    # The roadmap context of a prd_to_roadmap run, built from live priorities.
    async with tenant_session(ctx.tenant_id) as s:
        doc = Document(slug="checkout", title="Checkout PRD", kind="prd")
        s.add(doc)
        await s.flush()
        version = DocumentVersion(
            document_id=doc.id, number=1, markdown="# Checkout\n", content_hash="x"
        )
        s.add(version)
        await s.flush()
        run = Run(flow="prd_to_roadmap", knobs={"source_version_id": str(version.id)})
        s.add(run)
        await s.flush()
        source = await runs_service._source_context(s, run)
        assert source is not None and source.priorities[0]["key"] == "usage-alerts"
        await s.rollback()

    # A snapshot stores the overridden order and the override ids.
    snap = await client.post(
        "/v1/priorities/snapshots", json={"method": "rice"}, headers=ctx.as_("approver")
    )
    assert snap.status_code == 201, snap.text
    assert snap.json()["ranking"][0]["key"] == "usage-alerts"
    assert snap.json()["params"]["overrides"] == [created.json()["id"]]
    async with tenant_session(ctx.tenant_id) as s:
        stored = (await s.scalars(select(PrioritySnapshot))).one()
        assert stored.ranking[0]["key"] == "usage-alerts"

    # Agents (MCP): a run token reads the ranking with overrides and the log, and cannot
    # write: POST and DELETE map to no run scope.
    owner = ctx.users["owner"]
    token = await run_token(ctx.tenant_id, ["read:baseline"], owner.id)
    async with mcp_client(token) as c:
        names = {t.name for t in (await c.list_tools()).tools}
        assert {"get_priorities", "list_priority_overrides"} <= names
        assert "create_priority_override" not in names
        got = await c.call_tool("get_priorities", {})
        assert not got.is_error, text_of(got)
        top = got.structured_content["features"][0]
        assert top["key"] == "usage-alerts" and top["formula_rank"] == 3
        listed = await c.call_tool("list_priority_overrides", {})
        assert not listed.is_error, text_of(listed)
        refused = await c.call_tool(
            "create_priority_override",
            {"body": {"feature_id": str(ids["bulk-edit"]), "kind": "pin", "position": 1,
                      "reason": "An agent wants it first"}},
        )  # fmt: skip
        assert refused.is_error
    async with tenant_session(ctx.tenant_id) as s:
        assert len((await s.scalars(select(PriorityOverride))).all()) == 1


async def test_roles_and_validation(client):
    ctx = await make_ctx()
    ids = await _baseline(ctx)
    feature = str(ids["usage-alerts"])
    assert (
        await _create(client, ctx, "commenter", feature_id=feature, kind="pin", position=1)
    ).status_code == 403
    assert (
        await _create(client, ctx, "viewer", feature_id=feature, kind="pin", position=1)
    ).status_code == 403
    assert (
        await client.get("/v1/priorities/overrides", headers=ctx.as_("viewer"))
    ).status_code == 200
    bad = [
        {"kind": "pin", "position": 0},
        {"kind": "pin", "position": 1, "reason": ""},
        {"kind": "pin", "position": 1, "reason": "x" * 501},
        {"kind": "move", "above_feature_id": feature},
        {"kind": "move"},
        {"kind": "pin", "position": 1, "above_feature_id": str(ids["bulk-edit"])},
        {"kind": "move", "above_feature_id": str(ids["activation"])},  # a goal, not a feature
        {"kind": "move", "above_feature_id": str(uuid.uuid4())},
    ]
    for extra in bad:
        resp = await _create(client, ctx, feature_id=feature, **extra)
        assert resp.status_code == 422, (extra, resp.text)
    rejected = await _create(client, ctx, feature_id=str(ids["activation"]), kind="pin", position=1)
    assert rejected.status_code == 422
    async with tenant_session(ctx.tenant_id) as s:
        s.add(PrioritySnapshot(method="goal_weighted", params={}, ranking=[]))
        await s.commit()
        snap = (await s.scalars(select(PrioritySnapshot))).one()
    saved = await _create(
        client, ctx, feature_id=feature, kind="pin", position=1, snapshot_id=str(snap.id)
    )
    assert saved.status_code == 409


async def test_a_rejected_anchor_no_longer_applies(client):
    ctx = await make_ctx()
    ids = await _baseline(ctx)
    resp = await _create(
        client,
        ctx,
        feature_id=str(ids["address-lookup"]),
        kind="move",
        above_feature_id=str(ids["shipping-cost"]),
    )
    assert resp.status_code == 201, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        anchor = await s.get(Entity, ids["shipping-cost"])
        anchor.status = "rejected"
        await s.commit()
    rows = await _ranking(client, ctx)
    lookup = next(r for r in rows if r["key"] == "address-lookup")
    assert lookup["override"] is None and lookup["rank"] == lookup["formula_rank"]
    [entry] = (await client.get("/v1/priorities/overrides", headers=ctx.as_("viewer"))).json()
    assert entry["no_longer_applies"] is True


async def test_a_kept_override_is_recorded_in_the_decision_log(client):
    from oracle.decisions.models import Decision

    ctx = await make_ctx()
    ids = await _baseline(ctx)
    resp = await _create(
        client,
        ctx,
        feature_id=str(ids["bulk-edit"]),
        kind="pin",
        position=1,
        confirm=True,
    )
    assert resp.status_code == 201, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        [d] = (await s.scalars(select(Decision))).all()
    assert d.origin == "priority_override" and d.source_id == uuid.UUID(resp.json()["id"])
    assert d.rationale == "A launch partner needs it in the first release"
    assert "serves no confirmed goal" in (d.context or "")


async def test_overrides_are_company_scoped(client):
    ctx = await make_ctx()
    ids = await _baseline(ctx)
    resp = await _create(client, ctx, feature_id=str(ids["usage-alerts"]), kind="pin", position=1)
    assert resp.status_code == 201
    other = await make_ctx("Other Co")
    assert (await client.get("/v1/priorities/overrides", headers=other.as_("viewer"))).json() == []
    gone = await client.request(
        "DELETE",
        f"/v1/priorities/overrides/{resp.json()['id']}",
        json={},
        headers=other.as_("owner"),
    )
    assert gone.status_code == 404


# A private source item: its current title, kind and date are its owner's alone (S3, S6).
SECRET_TITLE = "Board memo: churn in the enterprise tier"
CITED_AS = "Partner call notes"
ITEM_DAY = datetime(2026, 3, 14, 9, 0, tzinfo=UTC)


async def private_evidence(ctx: Ctx, feature_id: uuid.UUID, owner: str = "approver") -> str:
    """Evidence on ``feature_id`` from an item of ``owner``'s own Notion source; the
    stored ref (the label people cite it by) is not the item's current title."""
    item_id = await make_item(
        ctx,
        owner,
        kind="notion",
        item_kind="page",
        title=SECRET_TITLE,
        url=None,
        updated=ITEM_DAY,
    )
    async with tenant_session(ctx.tenant_id) as s:
        ev = Evidence(
            entity_id=feature_id,
            source_item_id=item_id,
            ref=CITED_AS,
            excerpt="Two partners asked for it on the call.",
            confidence=Decimal("0.7"),
        )
        s.add(ev)
        await s.commit()
        return str(ev.id)


def cited(features: list[dict], key: str, evidence_id: str) -> dict:
    row = next(r for r in features if r["key"] == key)
    return next(e for e in row["explanation"]["confidence"]["evidence"] if e["id"] == evidence_id)


def hidden(chip: dict) -> None:
    """Cited as a reader who may not see the item: its stored ref, no kind, no date."""
    assert chip["title"] == CITED_AS
    assert chip["source_kind"] == "private_source"
    assert chip["date"] is None


async def test_a_private_item_is_cited_without_its_title_kind_or_date(client, local_runtime):
    """protects=S3 and S6 (a private item's title, kind and date reach only its owner);
    fails_when=a viewer, a run token, a snapshot or an override record shows the
    item's current title, its source kind or its date; no_claim=the excerpt (evidence
    copies it for everyone)."""
    ctx = await make_ctx()
    ids = await _baseline(ctx)
    ev = await private_evidence(ctx, ids["address-lookup"])
    pinned = await _create(
        client,
        ctx,
        feature_id=str(ids["address-lookup"]),
        kind="pin",
        position=1,
        evidence_ids=[ev],
        confirm=True,
    )
    assert pinned.status_code == 201, pinned.text
    assert SECRET_TITLE not in pinned.text and "notion" not in pinned.text
    [chip] = pinned.json()["evidence"]
    hidden(chip)

    # Its author sees it as cited from their own source.
    mine = cited(await _ranking(client, ctx, "approver"), "address-lookup", ev)
    assert mine["title"] == SECRET_TITLE
    assert mine["source_kind"] == "notion"
    assert mine["date"] == ITEM_DAY.date().isoformat()

    # Everyone else does not.
    for who in ("viewer", "owner"):
        resp = await client.get("/v1/priorities", headers=ctx.as_(who))
        assert resp.status_code == 200 and SECRET_TITLE not in resp.text, who
        hidden(cited(resp.json()["features"], "address-lookup", ev))
    log = await client.get("/v1/priorities/overrides", headers=ctx.as_("viewer"))
    assert log.status_code == 200 and SECRET_TITLE not in log.text
    hidden(log.json()[0]["evidence"][0])

    # A snapshot is a record everyone reads: stored as no one in particular sees it,
    # even when the item's author saves it.
    snap = await client.post(
        "/v1/priorities/snapshots", json={"method": "goal_weighted"}, headers=ctx.as_("approver")
    )
    assert snap.status_code == 201, snap.text
    assert SECRET_TITLE not in snap.text
    hidden(cited(snap.json()["ranking"], "address-lookup", ev))
    read = await client.get(
        f"/v1/priorities/snapshots/{snap.json()['id']}", headers=ctx.as_("viewer")
    )
    assert read.status_code == 200 and SECRET_TITLE not in read.text
    async with tenant_session(ctx.tenant_id) as s:
        stored = (await s.scalars(select(PrioritySnapshot))).one()
        assert SECRET_TITLE not in str(stored.ranking)

    # A run token reads the ranking as another person would.
    token = await run_token(ctx.tenant_id, ["read:baseline"], ctx.users["owner"].id)
    async with mcp_client(token) as c:
        got = await c.call_tool("get_priorities", {})
        assert not got.is_error, text_of(got)
        assert SECRET_TITLE not in text_of(got)
        hidden(cited(got.structured_content["features"], "address-lookup", ev))
        listed = await c.call_tool("list_priority_overrides", {})
        assert not listed.is_error and SECRET_TITLE not in text_of(listed)


# --- migration --------------------------------------------------------------------------

REVISION = "0022_priority_overrides"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_priority_overrides")
    .render_as_string(hide_password=False)
)


def _cfg() -> Config:
    cfg = Config(str(API_DIR / "alembic.ini"))
    cfg.attributes["database_url"] = SCRATCH_URL
    return cfg


def _run(sql: str, **params):
    async def go():
        from sqlalchemy.ext.asyncio import create_async_engine

        engine = create_async_engine(SCRATCH_URL)
        async with engine.begin() as conn:
            result = await conn.execute(text(sql), params)
            rows = result.all() if result.returns_rows else None
        await engine.dispose()
        return rows

    return asyncio.run(go())


def test_the_chain_ends_here_after_agent_staging():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_heads() == ["0088_simple_chat_actions"]
    assert script.get_revision(REVISION).down_revision == "0022_priority_snapshot_runs"


def test_upgrade_adds_priority_overrides_and_downgrade_drops_it():
    asyncio.run(_reset_schema(SCRATCH_URL))
    try:
        cfg = _cfg()
        command.upgrade(cfg, REVISION)
        tenant, a, b = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        _run("INSERT INTO tenants (id, name) VALUES (:t, 'Company')", t=tenant)
        for e, key in ((a, "a"), (b, "b")):
            _run(
                "INSERT INTO entities (id, tenant_id, type, key, title, status, origin) "
                "VALUES (:e, :t, 'feature', :k, :k, 'confirmed', 'user')",
                e=e,
                t=tenant,
                k=key,
            )
        insert = (
            "INSERT INTO priority_overrides (id, tenant_id, feature_id, kind, above_feature_id, "
            "position, reason, created_by) VALUES (:id, :t, :f, :kind, :above, :pos, :r, :t)"
        )
        _run(insert, id=uuid.uuid4(), t=tenant, f=a, kind="move", above=b, pos=None, r="Why")
        bad = [
            {"kind": "move", "above": None, "pos": None, "r": "Why"},
            {"kind": "pin", "above": None, "pos": 0, "r": "Why"},
            {"kind": "move", "above": a, "pos": None, "r": "Why"},
            {"kind": "pin", "above": None, "pos": 1, "r": ""},
            # A second active override on the same feature and ranking.
            {"kind": "pin", "above": None, "pos": 1, "r": "Why"},
        ]
        for row in bad:
            with pytest.raises(Exception):  # noqa: B017 - any constraint violation
                _run(insert, id=uuid.uuid4(), t=tenant, f=a, **row)
        [(status,)] = _run("SELECT reason_check->>'status' FROM priority_overrides")
        assert status == "skipped"
        command.downgrade(cfg, "0022_priority_snapshot_runs")
        assert _run("SELECT to_regclass('priority_overrides')") == [(None,)]
    finally:
        asyncio.run(_reset_schema(SCRATCH_URL))
