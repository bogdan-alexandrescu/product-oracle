"""Blocker strategy routes (CR-04, build prompt §6): blockers on baseline constraint
entities, their options, experiments and resolution events. Role guards, company
scoping, the constraint-only rule, audit and change events."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from oracle import changes
from oracle.baseline.models import Edge, Entity
from oracle.blockers import service
from oracle.main import app
from oracle.mcp.tools import app_operations
from oracle.models import AuditEvent
from oracle.tenancy import tenant_session
from oracle.v2 import models as m
from tests.baseline_helpers import make_ctx
from tests.blocker_helpers import (
    add_option,
    approve_compliance,
    create_blocker,
    make_document,
    make_entity,
)

LATER = (datetime.now(UTC) + timedelta(days=30)).isoformat()

NEW_ROUTES = [
    ("GET", "/v1/blockers"),
    ("POST", "/v1/blockers"),
    ("GET", "/v1/blockers/{blocker_id}"),
    ("PATCH", "/v1/blockers/{blocker_id}"),
    ("POST", "/v1/blockers/{blocker_id}/status"),
    ("POST", "/v1/blockers/{blocker_id}/accept-risk"),
    ("POST", "/v1/blockers/{blocker_id}/feasibility-scope"),
    ("POST", "/v1/blockers/{blocker_id}/options"),
    ("POST", "/v1/blockers/{blocker_id}/experiments"),
    ("PATCH", "/v1/blocker-options/{item_id}"),
    ("POST", "/v1/blocker-options/{item_id}/select"),
    ("POST", "/v1/blocker-options/{item_id}/fallback"),
    ("POST", "/v1/blocker-options/{item_id}/reject"),
    ("PATCH", "/v1/feasibility-experiments/{item_id}"),
    ("GET", "/v1/documents/{doc}/blocker-strategy"),
    ("GET", "/v1/documents/{doc}/blocker-strategy/render"),
]


async def _audit(ctx, action: str) -> list[AuditEvent]:
    async with tenant_session(ctx.tenant_id) as s:
        return list((await s.scalars(select(AuditEvent).where(AuditEvent.action == action))).all())


async def _events(ctx, blocker_id: str) -> list[m.BlockerResolutionEvent]:
    async with tenant_session(ctx.tenant_id) as s:
        rows = await s.scalars(
            select(m.BlockerResolutionEvent)
            .where(m.BlockerResolutionEvent.blocker_id == uuid.UUID(blocker_id))
            .order_by(m.BlockerResolutionEvent.created_at)
        )
        return list(rows.all())


def test_every_new_route_is_an_mcp_tool():
    ops = {(o.method, o.path): o for o in app_operations(app)}
    for method, path in NEW_ROUTES:
        op = ops[(method, path)]
        assert not op.excluded, (method, path)


async def test_routes_require_auth(client):
    some = uuid.uuid4()
    assert (await client.get("/v1/blockers")).status_code == 401
    assert (await client.post("/v1/blockers", json={})).status_code == 401
    assert (await client.get(f"/v1/blockers/{some}")).status_code == 401
    assert (await client.post(f"/v1/blockers/{some}/options", json={})).status_code == 401


# --- blockers on constraint entities ---------------------------------------------------


async def test_create_a_blocker_makes_a_constraint_entity_with_the_strategy(client):
    ctx = await make_ctx()
    doc_id = await make_document(ctx)
    out = await create_blocker(client, ctx, document_ids=[str(doc_id)])
    b = out["blocker"]
    assert b["key"] == "partner-api-rate-limit"
    assert b["statement"] == "The partner API allows 100 requests a minute per company"
    assert (b["type"], b["limit_kind"], b["severity"], b["status"]) == (
        "hard",
        "capacity",
        "critical",
        "open",
    )
    assert b["limit_kind_label"] == "Rate or capacity limit"
    assert b["threshold"] == "More than 100 requests a minute per company"
    assert b["revision"] == 1
    assert [d["slug"] for d in out["documents"]] == ["checkout-redesign"]
    async with tenant_session(ctx.tenant_id) as s:
        entity = await s.get(Entity, uuid.UUID(b["id"]))
        assert entity.type == "constraint"
        assert entity.attrs["blocker"]["type"] == "hard"
        assert entity.locked  # a person's decision, like any baseline edit
    events = await _events(ctx, b["id"])
    assert [(e.kind, e.to_status) for e in events] == [("status_changed", "open")]
    assert len(await _audit(ctx, "blocker.created")) == 1


async def test_an_existing_constraint_entity_becomes_a_blocker(client):
    ctx = await make_ctx()
    entity_id = await make_entity(ctx, "constraint", "data-residency")
    resp = await client.post(
        "/v1/blockers",
        json={
            "entity_id": str(entity_id),
            "type": "soft",
            "limit_kind": "policy",
            "severity": "high",
        },
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["blocker"]["id"] == str(entity_id)
    again = await client.post(
        "/v1/blockers",
        json={"entity_id": str(entity_id), "type": "soft"},
        headers=ctx.as_("approver"),
    )
    assert again.status_code == 409


async def test_a_non_constraint_entity_is_refused_everywhere(client):
    """The blocker tables reference any entities.id; the service layer insists on
    type = 'constraint' (the database cannot)."""
    ctx = await make_ctx()
    requirement = await make_entity(ctx, "requirement", "saved-addresses")
    h = ctx.as_("approver")
    resp = await client.post(
        "/v1/blockers", json={"entity_id": str(requirement), "type": "hard"}, headers=h
    )
    assert resp.status_code == 422
    assert "constraint" in resp.json()["detail"]
    resp = await add_option(client, ctx, str(requirement))
    assert resp.status_code == 422
    resp = await client.post(
        f"/v1/blockers/{requirement}/experiments", json={"hypothesis": "x"}, headers=h
    )
    assert resp.status_code == 422
    calls = [
        ("PATCH", "", {"revision": 1, "severity": "low"}),
        ("POST", "/status", {"status": "resolved", "reason": "x"}),
        ("POST", "/accept-risk", {"reason": "x", "review_at": LATER}),
        ("POST", "/feasibility-scope", {"experiment_id": str(uuid.uuid4()), "reason": "x"}),
    ]
    for method, path, body in calls:
        r = await client.request(method, f"/v1/blockers/{requirement}{path}", json=body, headers=h)
        assert r.status_code == 422, path
        assert "constraint" in r.json()["detail"], path
    assert (await client.get(f"/v1/blockers/{requirement}", headers=h)).status_code == 422

    # And in the service layer itself, for any caller that is not a route.
    async with tenant_session(ctx.tenant_id) as s:
        with pytest.raises(service.NotAConstraintError):
            await service.get_blocker(s, requirement)
        with pytest.raises(service.NotAConstraintError):
            await service.require_constraint(s, requirement)
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.scalars(select(m.BlockerOption))).all() == []
        assert (await s.scalars(select(m.FeasibilityExperiment))).all() == []
        assert (await s.scalars(select(m.BlockerResolutionEvent))).all() == []


async def test_a_constraint_without_a_strategy_is_not_a_blocker_yet(client):
    ctx = await make_ctx()
    entity_id = await make_entity(ctx, "constraint", "plain-constraint")
    resp = await add_option(client, ctx, str(entity_id))
    assert resp.status_code == 409
    assert "POST /v1/blockers" in resp.json()["detail"]


async def test_roles(client):
    ctx = await make_ctx()
    for who in ("viewer", "commenter"):
        resp = await client.post(
            "/v1/blockers",
            json={"key": "k", "statement": "s", "type": "hard"},
            headers=ctx.as_(who),
        )
        assert resp.status_code == 403, who
    b = (await create_blocker(client, ctx))["blocker"]
    assert (await client.get(f"/v1/blockers/{b['id']}", headers=ctx.as_("viewer"))).is_success
    assert (await add_option(client, ctx, b["id"], who="viewer")).status_code == 403
    # Commenters may propose options; deciding stays with approvers.
    opt = await add_option(client, ctx, b["id"], who="commenter")
    assert opt.status_code == 201, opt.text
    opt = opt.json()
    resp = await client.post(
        f"/v1/blocker-options/{opt['id']}/select",
        json={"lock_version": opt["lock_version"], "reason": "r"},
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 403
    resp = await client.post(
        f"/v1/blockers/{b['id']}/accept-risk",
        json={"reason": "r", "review_at": LATER},
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 403


async def test_another_companys_blockers_are_invisible(client):
    """Negative cross-company test on every new route."""
    a = await make_ctx("Company A")
    b = await make_ctx("Company B")
    await make_document(b, "their-prd")
    theirs = (await create_blocker(client, b))["blocker"]
    opt = (await add_option(client, b, theirs["id"])).json()
    exp = await client.post(
        f"/v1/blockers/{theirs['id']}/experiments",
        json={"hypothesis": "h"},
        headers=b.as_("approver"),
    )
    exp = exp.json()
    for who in ("viewer", "approver", "owner", "token"):
        h = a.as_(who)
        assert (await client.get(f"/v1/blockers/{theirs['id']}", headers=h)).status_code == 404
        listed = (await client.get("/v1/blockers", headers=h)).json()
        assert theirs["id"] not in {x["id"] for x in listed}
        assert (
            await client.get("/v1/documents/their-prd/blocker-strategy", headers=h)
        ).status_code == 404
    h = a.as_("owner")
    calls = [
        ("PATCH", f"/v1/blockers/{theirs['id']}", {"revision": 1, "severity": "low"}),
        ("POST", f"/v1/blockers/{theirs['id']}/status", {"status": "resolved", "reason": "x"}),
        ("POST", f"/v1/blockers/{theirs['id']}/accept-risk", {"reason": "x", "review_at": LATER}),
        (
            "POST",
            f"/v1/blockers/{theirs['id']}/feasibility-scope",
            {"experiment_id": exp["id"], "reason": "x"},
        ),
        ("POST", f"/v1/blockers/{theirs['id']}/options", {"title": "t", "approach": "operations"}),
        ("POST", f"/v1/blockers/{theirs['id']}/experiments", {"hypothesis": "h"}),
        ("PATCH", f"/v1/blocker-options/{opt['id']}", {"lock_version": 1, "title": "x"}),
        ("POST", f"/v1/blocker-options/{opt['id']}/select", {"lock_version": 1, "reason": "x"}),
        ("POST", f"/v1/blocker-options/{opt['id']}/fallback", {"lock_version": 1}),
        ("POST", f"/v1/blocker-options/{opt['id']}/reject", {"lock_version": 1, "reason": "x"}),
        (
            "PATCH",
            f"/v1/feasibility-experiments/{exp['id']}",
            {"lock_version": 1, "status": "running"},
        ),
    ]
    for method, path, body in calls:
        resp = await client.request(method, path, json=body, headers=h)
        assert resp.status_code == 404, (method, path, resp.text)
    # Linking their document or their entities from company A fails too.
    mine = await make_entity(a, "constraint", "mine")
    resp = await client.post(
        "/v1/blockers",
        json={"entity_id": str(mine), "type": "hard", "impacted_entity_ids": [theirs["id"]]},
        headers=h,
    )
    assert resp.status_code == 422


async def test_a_third_party_limit_must_be_classified(client):
    ctx = await make_ctx()
    resp = await client.post(
        "/v1/blockers",
        json={
            "key": "k",
            "statement": "s",
            "type": "hard",
            "third_party": "Example network",
            "limit_kind": "other",
        },
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 422
    assert "capacity" in resp.text


async def test_patch_needs_the_current_revision(client):
    ctx = await make_ctx()
    b = (await create_blocker(client, ctx))["blocker"]
    h = ctx.as_("approver")
    ok = await client.patch(
        f"/v1/blockers/{b['id']}",
        json={"revision": 1, "severity": "high", "reason": "r"},
        headers=h,
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["blocker"]["severity"] == "high"
    assert ok.json()["blocker"]["revision"] == 2
    stale = await client.patch(
        f"/v1/blockers/{b['id']}", json={"revision": 1, "severity": "low"}, headers=h
    )
    assert stale.status_code == 409
    # The status moves only through the status routes.
    resp = await client.patch(
        f"/v1/blockers/{b['id']}", json={"revision": 2, "status": "resolved"}, headers=h
    )
    assert resp.status_code == 422


async def test_impacted_requirements_get_affects_edges(client):
    ctx = await make_ctx()
    req = await make_entity(ctx, "requirement", "saved-addresses")
    outcome = await make_entity(ctx, "outcome", "faster-repeat-checkout")
    b = (
        await create_blocker(
            client,
            ctx,
            impacted_entity_ids=[str(req), str(outcome)],
            impacted_users=["Returning buyers"],
        )
    )["blocker"]
    assert {i["key"] for i in b["impacted"]} == {"saved-addresses", "faster-repeat-checkout"}
    async with tenant_session(ctx.tenant_id) as s:
        edges = (await s.scalars(select(Edge).where(Edge.src_id == uuid.UUID(b["id"])))).all()
        assert [(e.type, e.dst_id) for e in edges] == [("affects", req)]
    resp = await client.patch(
        f"/v1/blockers/{b['id']}",
        json={"revision": 1, "impacted_entity_ids": [str(outcome)]},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.scalars(select(Edge).where(Edge.src_id == uuid.UUID(b["id"])))).all() == []


# --- status changes call oracle.changes.record_change ----------------------------------


async def test_a_status_change_records_a_change_event(client):
    ctx = await make_ctx()
    doc_id = await make_document(ctx)
    b = (await create_blocker(client, ctx, document_ids=[str(doc_id)]))["blocker"]
    seen = []

    async def handler(db, event):
        seen.append(
            (
                event.subject_kind,
                event.subject_id,
                event.document_id,
                event.cause,
                event.data["from_status"],
                event.data["to_status"],
            )
        )

    with changes.isolated_handlers():
        changes.register_handler("test.capture", handler, subjects={"blocker_status"})
        resp = await client.post(
            f"/v1/blockers/{b['id']}/status",
            json={"status": "mitigating", "reason": "Work began"},
            headers=ctx.as_("approver"),
        )
    assert resp.status_code == 200, resp.text
    assert resp.json()["blocker"]["status"] == "mitigating"
    assert seen == [
        ("blocker_status", uuid.UUID(b["id"]), doc_id, "status_changed", "open", "mitigating")
    ]
    async with tenant_session(ctx.tenant_id) as s:
        rows = (await s.scalars(select(m.ChangeEvent))).all()
        assert [(r.subject_kind, r.actor) for r in rows] == [
            ("blocker_status", f"user:{ctx.users['approver'].id}")
        ]
    assert len(await _audit(ctx, "blocker.status_changed")) == 1


async def test_a_handler_that_fails_aborts_the_status_change(client):
    ctx = await make_ctx()
    b = (await create_blocker(client, ctx))["blocker"]

    async def boom(db, event):
        raise RuntimeError("downstream refused")

    with changes.isolated_handlers():
        changes.register_handler("test.boom", boom)
        with pytest.raises(RuntimeError):
            await client.post(
                f"/v1/blockers/{b['id']}/status",
                json={"status": "resolved", "reason": "x"},
                headers=ctx.as_("approver"),
            )
    got = await client.get(f"/v1/blockers/{b['id']}", headers=ctx.as_("viewer"))
    assert got.json()["blocker"]["status"] == "open"


async def test_status_route_rules(client):
    ctx = await make_ctx()
    b = (await create_blocker(client, ctx))["blocker"]
    h = ctx.as_("approver")
    for status in ("accepted_risk", "feasibility_only"):
        resp = await client.post(
            f"/v1/blockers/{b['id']}/status", json={"status": status, "reason": "x"}, headers=h
        )
        assert resp.status_code == 422, status
    resp = await client.post(
        f"/v1/blockers/{b['id']}/status", json={"status": "resolved"}, headers=h
    )
    assert resp.status_code == 422  # resolving needs a reason
    resp = await client.post(
        f"/v1/blockers/{b['id']}/status",
        json={"status": "resolved", "reason": "The provider raised our tier"},
        headers=h,
    )
    assert resp.json()["blocker"]["status"] == "resolved"
    resp = await client.post(
        f"/v1/blockers/{b['id']}/status",
        json={"status": "open", "reason": "Tier withdrawn"},
        headers=h,
    )
    assert resp.json()["blocker"]["status"] == "open"
    kinds = [(e.kind, e.from_status, e.to_status) for e in await _events(ctx, b["id"])]
    assert kinds[-2:] == [("status_changed", "open", "resolved"), ("reopened", "resolved", "open")]


# --- options: compare, select with a reason ----------------------------------------------


async def test_select_an_option_with_a_reason(client):
    ctx = await make_ctx()
    doc_id = await make_document(ctx)
    b = (await create_blocker(client, ctx, document_ids=[str(doc_id)]))["blocker"]
    h = ctx.as_("approver")
    first = (await add_option(client, ctx, b["id"])).json()
    assert first["compliance"] == "needs_review"
    assert first["details"]["fallback"] == "Queue lookups and retry within the permitted rate"
    resp = await client.post(
        f"/v1/blocker-options/{first['id']}/select",
        json={"lock_version": first["lock_version"], "reason": "Cheapest"},
        headers=h,
    )
    assert resp.status_code == 422  # not reviewed for compliance yet
    first = await approve_compliance(client, ctx, first)
    assert first["compliance"] == "compliant"
    second = await approve_compliance(
        client,
        ctx,
        (
            await add_option(
                client,
                ctx,
                b["id"],
                title="Ask the provider for a higher tier",
                approach="partnership",
            )
        ).json(),
    )

    seen = []

    async def handler(db, event):
        seen.append(event.cause)

    with changes.isolated_handlers():
        changes.register_handler("test.capture", handler)
        resp = await client.post(
            f"/v1/blocker-options/{first['id']}/select",
            json={"lock_version": first["lock_version"], "reason": "Fastest within the quota"},
            headers=h,
        )
        assert resp.status_code == 200, resp.text
        strategy = resp.json()
        assert strategy["blocker"]["selected_option_id"] == first["id"]
        assert strategy["blocker"]["status"] == "mitigating"
        chosen = next(o for o in strategy["options"] if o["id"] == first["id"])
        assert (chosen["status"], chosen["selected_reason"]) == (
            "selected",
            "Fastest within the quota",
        )
        resp = await client.post(
            f"/v1/blocker-options/{second['id']}/select",
            json={"lock_version": second["lock_version"], "reason": "Tier approved"},
            headers=h,
        )
        assert resp.status_code == 200, resp.text
    statuses = {o["id"]: o["status"] for o in resp.json()["options"]}
    assert statuses == {first["id"]: "evaluating", second["id"]: "selected"}
    assert seen == ["option_selected", "option_selected"]
    kinds = [e.kind for e in await _events(ctx, b["id"])]
    assert kinds.count("option_selected") == 2
    assert len(await _audit(ctx, "blocker_option.selected")) == 2
    # A stale lock_version is a conflict, not a silent overwrite.
    resp = await client.post(
        f"/v1/blocker-options/{second['id']}/reject",
        json={"lock_version": second["lock_version"], "reason": "x"},
        headers=h,
    )
    assert resp.status_code == 409


async def test_fallback_and_reject(client):
    ctx = await make_ctx()
    b = (await create_blocker(client, ctx))["blocker"]
    h = ctx.as_("approver")
    opt = (await add_option(client, ctx, b["id"])).json()
    resp = await client.post(
        f"/v1/blocker-options/{opt['id']}/fallback",
        json={"lock_version": opt["lock_version"]},
        headers=h,
    )
    assert resp.status_code == 422  # a fallback must be reviewed as compliant too
    opt = await approve_compliance(client, ctx, opt)
    resp = await client.post(
        f"/v1/blocker-options/{opt['id']}/fallback",
        json={"lock_version": opt["lock_version"]},
        headers=h,
    )
    assert resp.json()["status"] == "fallback"
    rewrite = await client.patch(
        f"/v1/blocker-options/{opt['id']}",
        json={"lock_version": resp.json()["lock_version"], "title": "Something else"},
        headers=h,
    )
    assert rewrite.status_code == 409  # the reviewed fallback is this exact text
    resp = await client.post(
        f"/v1/blocker-options/{opt['id']}/reject",
        json={"lock_version": resp.json()["lock_version"], "reason": "Too slow"},
        headers=h,
    )
    assert resp.json()["status"] == "rejected"


async def test_editing_a_reviewed_option_needs_a_new_review(client):
    ctx = await make_ctx()
    b = (await create_blocker(client, ctx))["blocker"]
    opt = await approve_compliance(client, ctx, (await add_option(client, ctx, b["id"])).json())
    resp = await client.patch(
        f"/v1/blocker-options/{opt['id']}",
        json={"lock_version": opt["lock_version"], "description": "Cache for an hour instead."},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200
    assert resp.json()["compliance"] == "needs_review"


async def test_option_evidence_must_be_this_companys(client):
    a = await make_ctx("Company A")
    b = await make_ctx("Company B")
    from tests.blocker_helpers import make_evidence

    their_entity = await make_entity(b, "constraint", "theirs")
    their_ev = await make_evidence(b, their_entity)
    blocker = (await create_blocker(client, a))["blocker"]
    resp = await add_option(client, a, blocker["id"], evidence_ids=[str(their_ev)])
    assert resp.status_code == 422


# --- experiments, feasibility scope and risk acceptance ---------------------------------


async def _experiment(client, ctx, blocker_id, **body):
    payload = {
        "hypothesis": "Batching halves calls",
        "method": "Replay a synthetic day",
        "success_threshold": "Under 50 requests a minute at peak",
        "owner_id": str(ctx.users["approver"].id),
        "decision_gate_at": LATER,
        **body,
    }
    resp = await client.post(
        f"/v1/blockers/{blocker_id}/experiments", json=payload, headers=ctx.as_("approver")
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def test_experiment_lifecycle(client):
    ctx = await make_ctx()
    b = (await create_blocker(client, ctx))["blocker"]
    other = (await create_blocker(client, ctx, key="other-limit"))["blocker"]
    other_opt = (await add_option(client, ctx, other["id"])).json()
    resp = await client.post(
        f"/v1/blockers/{b['id']}/experiments",
        json={"hypothesis": "h", "option_id": other_opt["id"]},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 422  # the option belongs to another blocker
    exp = await _experiment(client, ctx, b["id"])
    resp = await client.patch(
        f"/v1/feasibility-experiments/{exp['id']}",
        json={"lock_version": exp["lock_version"], "status": "running"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text
    resp2 = await client.patch(
        f"/v1/feasibility-experiments/{exp['id']}",
        json={"lock_version": exp["lock_version"], "status": "succeeded"},
        headers=ctx.as_("approver"),
    )
    assert resp2.status_code == 409
    resp = await client.patch(
        f"/v1/feasibility-experiments/{exp['id']}",
        json={"lock_version": resp.json()["lock_version"], "status": "succeeded"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 422  # concluding needs a result
    kinds = [e.kind for e in await _events(ctx, b["id"])]
    assert "experiment_started" in kinds


async def test_feasibility_scope_needs_a_scoped_experiment(client):
    ctx = await make_ctx()
    b = (await create_blocker(client, ctx))["blocker"]
    loose = await _experiment(client, ctx, b["id"], owner_id=None, decision_gate_at=None)
    resp = await client.post(
        f"/v1/blockers/{b['id']}/feasibility-scope",
        json={"experiment_id": loose["id"], "reason": "Prove it first"},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 422
    assert "owner" in resp.text and "decision gate" in resp.text
    exp = await _experiment(client, ctx, b["id"])
    resp = await client.post(
        f"/v1/blockers/{b['id']}/feasibility-scope",
        json={"experiment_id": exp["id"], "reason": "Ship to one pilot company only"},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["blocker"]["status"] == "feasibility_only"
    assert resp.json()["gate"]["status"] == "pass"
    # The experiment fails: the feasibility scope no longer holds, the blocker reopens.
    resp = await client.patch(
        f"/v1/feasibility-experiments/{exp['id']}",
        json={
            "lock_version": exp["lock_version"],
            "status": "failed",
            "result": "Peak stayed at 140 a minute",
        },
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text
    got = (await client.get(f"/v1/blockers/{b['id']}", headers=ctx.as_("viewer"))).json()
    assert got["blocker"]["status"] == "open"
    assert got["gate"]["status"] == "critical"
    kinds = [(e.kind, e.to_status) for e in await _events(ctx, b["id"])]
    assert ("feasibility_scope_approved", "feasibility_only") in kinds
    assert kinds[-1] == ("status_changed", "open")


async def test_risk_acceptance_records_who_and_why(client):
    ctx = await make_ctx()
    doc_id = await make_document(ctx)
    b = (await create_blocker(client, ctx, document_ids=[str(doc_id)]))["blocker"]
    h = ctx.as_("owner")
    past = (datetime.now(UTC) - timedelta(days=1)).isoformat()
    for body in (
        {"reason": "", "review_at": LATER},
        {"reason": "ok", "review_at": past},
        {"reason": "ok"},
    ):
        resp = await client.post(f"/v1/blockers/{b['id']}/accept-risk", json=body, headers=h)
        assert resp.status_code == 422, body
    resp = await client.post(
        f"/v1/blockers/{b['id']}/accept-risk",
        json={
            "reason": "Launch to the pilot company; the limit holds at its volume",
            "review_at": LATER,
        },
        headers=h,
    )
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["blocker"]["status"] == "accepted_risk"
    acc = out["risk_acceptance"]
    assert acc["decided_by"] == str(ctx.users["owner"].id)
    assert acc["rationale"].startswith("Launch to the pilot company")
    assert acc["decision"] == "accept_risk"
    assert out["gate"]["status"] == "pass"
    audits = await _audit(ctx, "blocker.risk_accepted")
    assert len(audits) == 1
    assert audits[0].actor == f"user:{ctx.users['owner'].id}"
    assert audits[0].data["reason"].startswith("Launch to the pilot company")
    events = await _events(ctx, b["id"])
    assert events[-1].kind == "risk_accepted"
    assert events[-1].data["assumption_decision_id"] == acc["id"]


# --- the strategy views ---------------------------------------------------------------


async def test_document_strategy_lists_linked_blockers(client):
    ctx = await make_ctx()
    doc_id = await make_document(ctx)
    other_doc = await make_document(ctx, "another-prd")
    linked = (await create_blocker(client, ctx, document_ids=[str(doc_id)]))["blocker"]
    await create_blocker(client, ctx, key="unrelated", document_ids=[str(other_doc)])
    via_link = (await create_blocker(client, ctx, key="linked-by-section", severity="low"))[
        "blocker"
    ]
    async with tenant_session(ctx.tenant_id) as s:
        s.add(
            m.DocumentSectionLink(
                document_id=doc_id,
                section_key="risks",
                kind="mentions",
                entity_id=uuid.UUID(via_link["id"]),
            )
        )
        await s.commit()
    resp = await client.get(
        "/v1/documents/checkout-redesign/blocker-strategy", headers=ctx.as_("viewer")
    )
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert {b["blocker"]["id"] for b in out["blockers"]} == {linked["id"], via_link["id"]}
    # Most severe first.
    assert out["blockers"][0]["blocker"]["id"] == linked["id"]
    assert out["readiness"]["status"] == "critical"
    listed = await client.get(f"/v1/blockers?document_id={doc_id}", headers=ctx.as_("viewer"))
    assert {b["id"] for b in listed.json()} == {linked["id"], via_link["id"]}
    filtered = await client.get("/v1/blockers?severity=low", headers=ctx.as_("viewer"))
    assert [b["id"] for b in filtered.json()] == [via_link["id"]]


def test_agents_read_blockers_but_never_decide():
    """Run tokens (agents) read blocker strategies with the baseline; every write here is
    a person's decision, so no run-token scope allows it."""
    from oracle.mcp.scopes import required_scope

    for path in ("/v1/blockers", "/v1/blockers/{blocker_id}", "/v1/blocker-options",
                 "/v1/feasibility-experiments", "/v1/blocker-events"):  # fmt: skip
        assert required_scope("GET", path) == "read:baseline", path
    assert required_scope("GET", "/v1/documents/{doc}/blocker-strategy") == "read:documents"
    for method, path in NEW_ROUTES:
        if method != "GET":
            assert required_scope(method, path) is None, (method, path)
