"""Who may weaken a gating blocker, and gate history that holds up (PR #23 review).

- Reclassifying a blocker so that it gates (critical and hard) reopens an approver's
  risk acceptance or feasibility scope unless the caller holds the B4 role.
- B4 (owner, 2026-10-19): archiving (rejecting) or deleting a constraint whose blocker
  still gates publishing takes the owner role, on every path (REST, proposals, YAML,
  MCP); resolved or non-gating blockers stay with approvers.
- A blocker recorded before gate snapshots existed (legacy) is snapshotted on its
  first assessment instead of failing closed.
- Events of one blocker are strictly ordered; a reclassification reads sensibly; the
  403s name the configured role; a blank success threshold is refused at approval.
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
import yaml
from sqlalchemy import select

from oracle.baseline.models import Entity, Proposal
from oracle.blockers import service as blockers
from oracle.blockers.readiness import critical_blockers
from oracle.blockers.schemas import BlockerSpec, dump
from oracle.readiness import CheckOutcome, ReadinessContext
from oracle.tenancy import tenant_session
from oracle.v2 import models as m
from tests.baseline_helpers import make_ctx
from tests.blocker_helpers import create_blocker, make_document, make_entity
from tests.test_mcp import api_token, mcp_client, text_of

LATER = (datetime.now(UTC) + timedelta(days=30)).isoformat()
STILL_GATES = "This blocker still gates publishing. Only an owner can archive it."
STILL_GATES_DELETE = "This blocker still gates publishing. Only an owner can delete it."


async def _check(ctx, doc_id) -> CheckOutcome:
    async with tenant_session(ctx.tenant_id) as s:
        out = await critical_blockers(ReadinessContext(s, doc_id, purpose="publish"))
        await s.commit()
        return out


async def _entity(ctx, entity_id) -> Entity | None:
    async with tenant_session(ctx.tenant_id) as s:
        return await s.get(Entity, uuid.UUID(str(entity_id)))


async def _events(ctx, entity_id) -> list[m.BlockerResolutionEvent]:
    async with tenant_session(ctx.tenant_id) as s:
        return list(
            (
                await s.scalars(
                    select(m.BlockerResolutionEvent)
                    .where(m.BlockerResolutionEvent.blocker_id == uuid.UUID(str(entity_id)))
                    .order_by(m.BlockerResolutionEvent.created_at)
                )
            ).all()
        )


async def _blocker(client, ctx, **overrides):
    doc_id = await make_document(ctx)
    b = (await create_blocker(client, ctx, document_ids=[str(doc_id)], **overrides))["blocker"]
    return doc_id, b


async def _experiment(client, ctx, blocker_id, **body) -> dict:
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


async def _decide(client, ctx, blocker_id, action: str, who: str):
    if action == "accept-risk":
        body = {"reason": "Pilot volume stays under the limit", "review_at": LATER}
    else:
        exp = await _experiment(client, ctx, blocker_id)
        body = {"experiment_id": exp["id"], "reason": "One pilot company only"}
    return await client.post(f"/v1/blockers/{blocker_id}/{action}", json=body, headers=ctx.as_(who))


async def _revision(ctx, blocker_id) -> int:
    return (await _entity(ctx, blocker_id)).attrs["blocker"]["revision"]


async def _resolve(client, ctx, blocker_id):
    resp = await client.post(
        f"/v1/blockers/{blocker_id}/status",
        json={"status": "resolved", "reason": "The provider raised our tier"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text


# --- MAJOR 1: reclassifying after an approver's decision ---------------------------------


@pytest.mark.parametrize("action", ["accept-risk", "feasibility-scope"])
@pytest.mark.parametrize(
    ("start", "patch"),
    [({"severity": "high"}, {"severity": "critical"}), ({"type": "soft"}, {"type": "hard"})],
)
async def test_reclassifying_an_approvers_decision_into_the_gate_reopens_it(
    client, action, start, patch
):
    ctx = await make_ctx()
    doc_id, b = await _blocker(client, ctx, **start)
    resp = await _decide(client, ctx, b["id"], action, "approver")
    assert resp.status_code == 200, resp.text
    resp = await client.patch(
        f"/v1/blockers/{b['id']}",
        json={"revision": await _revision(ctx, b["id"]), **patch, "reason": "Worse than thought"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["blocker"]["status"] == "open"
    out = await _check(ctx, doc_id)
    assert out.status == "critical", out
    assert "unresolved" in out.rationale
    last = [e for e in await _events(ctx, b["id"]) if e.to_status is not None][-1]
    assert last.to_status == "open"
    assert "owner" in last.reason


@pytest.mark.parametrize("action", ["accept-risk", "feasibility-scope"])
async def test_an_owner_reclassifying_keeps_the_decision(client, action):
    ctx = await make_ctx()
    doc_id, b = await _blocker(client, ctx, severity="high")
    resp = await _decide(client, ctx, b["id"], action, "approver")
    assert resp.status_code == 200, resp.text
    resp = await client.patch(
        f"/v1/blockers/{b['id']}",
        json={"revision": await _revision(ctx, b["id"]), "severity": "critical"},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 200, resp.text
    status = "accepted_risk" if action == "accept-risk" else "feasibility_only"
    assert resp.json()["blocker"]["status"] == status
    assert (await _check(ctx, doc_id)).status == "pass"


# --- MAJOR 2 (B4): archiving or deleting a blocker that still gates publishing -----------


async def _archive(client, ctx, entity_id, how: str, who: str):
    if how == "reject":
        return await client.post(
            f"/v1/baseline/entities/{entity_id}/reject",
            json={"note": "The partner API is no longer used"},
            headers=ctx.as_(who),
        )
    if how == "patch":
        return await client.patch(
            f"/v1/baseline/entities/{entity_id}",
            json={"status": "rejected"},
            headers=ctx.as_(who),
        )
    return await client.delete(f"/v1/baseline/entities/{entity_id}", headers=ctx.as_(who))


@pytest.mark.parametrize("how", ["reject", "patch", "delete"])
async def test_an_approver_cannot_archive_a_blocker_that_still_gates(client, how):
    ctx = await make_ctx()
    doc_id, b = await _blocker(client, ctx)
    resp = await _archive(client, ctx, b["id"], how, "approver")
    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"] == (STILL_GATES_DELETE if how == "delete" else STILL_GATES)
    entity = await _entity(ctx, b["id"])
    assert entity is not None and entity.status != "rejected"
    assert (await _check(ctx, doc_id)).status == "critical"


async def test_an_accepted_risk_still_gates_for_archiving(client):
    ctx = await make_ctx()
    _doc_id, b = await _blocker(client, ctx)
    assert (await _decide(client, ctx, b["id"], "accept-risk", "owner")).status_code == 200
    resp = await _archive(client, ctx, b["id"], "reject", "approver")
    assert resp.status_code == 403, resp.text


@pytest.mark.parametrize("how", ["reject", "patch", "delete"])
async def test_an_owner_may_archive_a_blocker_that_still_gates(client, how):
    ctx = await make_ctx()
    doc_id, b = await _blocker(client, ctx)
    resp = await _archive(client, ctx, b["id"], how, "owner")
    assert resp.is_success, resp.text
    assert (await _check(ctx, doc_id)).status == "not_applicable"


@pytest.mark.parametrize("how", ["reject", "delete"])
async def test_an_approver_may_archive_a_resolved_blocker(client, how):
    ctx = await make_ctx()
    doc_id, b = await _blocker(client, ctx)
    await _resolve(client, ctx, b["id"])
    resp = await _archive(client, ctx, b["id"], how, "approver")
    assert resp.is_success, resp.text
    assert (await _check(ctx, doc_id)).status == "not_applicable"


@pytest.mark.parametrize("start", [{"severity": "high"}, {"type": "soft"}])
async def test_an_approver_may_archive_a_blocker_that_does_not_gate(client, start):
    ctx = await make_ctx()
    doc_id, b = await _blocker(client, ctx, **start)
    resp = await _archive(client, ctx, b["id"], "reject", "approver")
    assert resp.status_code == 200, resp.text
    assert (await _check(ctx, doc_id)).status == "not_applicable"


async def test_an_approver_may_still_archive_other_constraints(client):
    ctx = await make_ctx()
    entity_id = await make_entity(ctx, "constraint", "plain-constraint")
    resp = await _archive(client, ctx, entity_id, "reject", "approver")
    assert resp.status_code == 200, resp.text


@pytest.mark.parametrize("op", ["delete", "update"])
async def test_accepting_a_proposal_to_archive_a_gating_blocker_takes_an_owner(client, op):
    ctx = await make_ctx()
    doc_id, b = await _blocker(client, ctx)
    body = {"op": op, "kind": "entity", "entity_id": b["id"], "fields": {}}
    if op == "update":
        body["fields"] = {"status": "rejected"}
    resp = await client.post("/v1/baseline/proposals", json=body, headers=ctx.as_("commenter"))
    assert resp.status_code in (200, 201), resp.text
    proposal_id = resp.json()["id"]
    url = f"/v1/baseline/proposals/{proposal_id}/accept"
    resp = await client.post(url, json={}, headers=ctx.as_("approver"))
    assert resp.status_code == 403, resp.text
    assert "Only an owner" in resp.json()["detail"]
    assert (await _check(ctx, doc_id)).status == "critical"
    if op == "delete":
        return  # accepting any delete proposal fails today (proposals cascade with entities)
    resp = await client.post(url, json={}, headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text
    assert (await _check(ctx, doc_id)).status == "not_applicable"


async def test_a_yaml_import_cannot_archive_a_gating_blocker_for_an_approver(client):
    ctx = await make_ctx()
    doc_id, b = await _blocker(client, ctx)
    data = yaml.safe_load((await client.get("/v1/baseline/yaml", headers=ctx.as_("viewer"))).text)
    mine = next(e for e in data["entities"] if e["key"] == b["key"])
    mine["status"] = "rejected"
    headers = {"Content-Type": "application/yaml"}
    # A locked blocker gets a proposal, whose acceptance is checked as above; unlocked,
    # the import itself applies, and is checked.
    resp = await client.post(f"/v1/baseline/entities/{b['id']}/unlock", headers=ctx.as_("approver"))
    assert resp.status_code == 200, resp.text
    resp = await client.post(
        "/v1/baseline/yaml",
        content=yaml.safe_dump(data),
        headers={**ctx.as_("approver"), **headers},
    )
    assert resp.status_code == 422, resp.text
    assert STILL_GATES in resp.text
    assert (await _check(ctx, doc_id)).status == "critical"
    resp = await client.post(
        "/v1/baseline/yaml", content=yaml.safe_dump(data), headers={**ctx.as_("owner"), **headers}
    )
    assert resp.status_code == 200, resp.text
    assert (await _check(ctx, doc_id)).status == "not_applicable"


@pytest.mark.parametrize("tool", ["reject_entity", "delete_entity", "update_entity"])
async def test_the_mcp_tools_cannot_archive_a_gating_blocker_for_an_approver(client, tool):
    ctx = await make_ctx()
    doc_id, b = await _blocker(client, ctx)
    args = {"entity_id": b["id"]}
    if tool == "reject_entity":
        args["body"] = {"note": "No longer used"}
    elif tool == "update_entity":
        args["body"] = {"status": "rejected"}
    async with mcp_client(await api_token(ctx.tenant_id, "approver")) as c:
        result = await c.call_tool(tool, args)
    assert result.is_error, text_of(result)
    assert "HTTP 403" in text_of(result) and "Only an owner" in text_of(result)
    assert (await _check(ctx, doc_id)).status == "critical"
    async with mcp_client(await api_token(ctx.tenant_id, "owner")) as c:
        result = await c.call_tool(tool, args)
    assert not result.is_error, text_of(result)
    assert (await _check(ctx, doc_id)).status == "not_applicable"


# --- MAJOR 3: legacy blockers recorded before gate snapshots -----------------------------


async def _legacy(ctx, doc_id, key: str, *, status_event: bool = True, **fields) -> uuid.UUID:
    """A blocker as the code before gate snapshots stored it: no ``data.gate`` anywhere."""
    spec = BlockerSpec(
        type=fields.get("type", "hard"),
        limit_kind="capacity",
        severity=fields.get("severity", "critical"),
        status=fields.get("status", "open"),
        document_ids=[doc_id],
    )
    entity_id = await make_entity(ctx, "constraint", key, {"blocker": dump(spec)})
    if status_event:
        async with tenant_session(ctx.tenant_id) as s:
            s.add(
                m.BlockerResolutionEvent(
                    blocker_id=entity_id,
                    kind="status_changed",
                    to_status=spec.status,
                    reason="Blocker recorded",
                    actor="user:legacy",
                    data={},
                )
            )
            await s.commit()
    return entity_id


@pytest.mark.parametrize("status_event", [True, False])
async def test_a_legacy_soft_low_resolved_blocker_does_not_block(client, status_event):
    ctx = await make_ctx()
    doc_id = await make_document(ctx)
    entity_id = await _legacy(
        ctx, doc_id, "legacy-soft", type="soft", severity="low", status="resolved",
        status_event=status_event,
    )  # fmt: skip
    out = await _check(ctx, doc_id)
    assert out.status == "pass", out
    snapshots = [e for e in await _events(ctx, entity_id) if "gate" in e.data]
    assert len(snapshots) == 1
    assert snapshots[0].data["change"] == "legacy_snapshot"
    assert snapshots[0].data["gate"]["status"] == "resolved"
    # Assessed again, it is not snapshotted twice.
    assert (await _check(ctx, doc_id)).status == "pass"
    assert len([e for e in await _events(ctx, entity_id) if "gate" in e.data]) == 1


async def test_a_legacy_critical_blocker_is_judged_on_its_status_not_as_tampered(client):
    ctx = await make_ctx()
    doc_id = await make_document(ctx)
    await _legacy(ctx, doc_id, "legacy-critical")
    out = await _check(ctx, doc_id)
    assert out.status == "critical"
    assert "unresolved" in out.rationale and "outside" not in out.rationale


async def test_a_legacy_blocker_edited_after_its_snapshot_fails_closed(client):
    ctx = await make_ctx()
    doc_id = await make_document(ctx)
    entity_id = await _legacy(ctx, doc_id, "legacy-edited", severity="low", type="soft")
    assert (await _check(ctx, doc_id)).status == "pass"
    async with tenant_session(ctx.tenant_id) as s:
        entity = await s.get(Entity, entity_id)
        entity.attrs = {
            **entity.attrs,
            "blocker": {**entity.attrs["blocker"], "status": "resolved"},
        }
        await s.commit()
    out = await _check(ctx, doc_id)
    assert out.status == "critical"
    assert "outside" in out.rationale


async def test_an_unreadable_legacy_strategy_still_fails_closed(client):
    ctx = await make_ctx()
    doc_id = await make_document(ctx)
    await make_entity(
        ctx,
        "constraint",
        "legacy-garbled",
        {"blocker": {"type": "hard", "severity": "catastrophic", "document_ids": [str(doc_id)]}},
    )
    out = await _check(ctx, doc_id)
    assert out.status == "critical"
    assert "cannot be read" in out.rationale


# --- minors -------------------------------------------------------------------------------


async def test_events_of_one_blocker_are_strictly_ordered(client, monkeypatch):
    """Two events in the same instant (a coarse clock) still come out in write order."""
    frozen = datetime.now(UTC)
    monkeypatch.setattr(blockers, "_now", lambda: frozen)
    ctx = await make_ctx()
    doc_id, b = await _blocker(client, ctx, severity="high")
    assert (await _decide(client, ctx, b["id"], "accept-risk", "approver")).status_code == 200
    resp = await client.patch(
        f"/v1/blockers/{b['id']}",
        json={"revision": await _revision(ctx, b["id"]), "severity": "critical"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text
    events = await _events(ctx, b["id"])
    stamps = [e.created_at for e in events]
    assert stamps == sorted(stamps) and len(set(stamps)) == len(stamps)
    assert events[-1].to_status == "open"
    assert (await _check(ctx, doc_id)).status == "critical"


async def test_a_reclassification_reads_sensibly_in_the_history(client):
    ctx = await make_ctx()
    _doc_id, b = await _blocker(client, ctx)
    resp = await client.patch(
        f"/v1/blockers/{b['id']}",
        json={"revision": b["revision"], "severity": "high", "reason": "Pilot volume is small"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text
    strategy = (await client.get(f"/v1/blockers/{b['id']}", headers=ctx.as_("viewer"))).json()
    reclassified = [e for e in strategy["events"] if e["data"].get("change") == "reclassified"]
    assert len(reclassified) == 1
    event = reclassified[0]
    # Not a status change (so the gate does not read it), but it says what changed.
    assert event["from_status"] == event["to_status"] is None
    assert event["summary"] == "Reclassified from hard critical to hard high (status stays open)"
    created = strategy["events"][0]
    assert created["summary"] == "Status set to open"


@pytest.mark.parametrize(
    ("action", "text"),
    [
        ("accept-risk", "Only an owner can accept this risk"),
        ("feasibility-scope", "Only an owner can approve this feasibility scope"),
    ],
)
async def test_the_403_names_the_configured_role(client, action, text):
    ctx = await make_ctx()
    _doc_id, b = await _blocker(client, ctx)
    resp = await _decide(client, ctx, b["id"], action, "approver")
    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"].startswith(text)
    assert "propose" not in resp.json()["detail"]


async def test_a_blank_success_threshold_is_refused_at_approval(client):
    ctx = await make_ctx()
    doc_id, b = await _blocker(client, ctx)
    exp = await _experiment(client, ctx, b["id"], success_threshold="   ")
    resp = await client.post(
        f"/v1/blockers/{b['id']}/feasibility-scope",
        json={"experiment_id": exp["id"], "reason": "One pilot company only"},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 422, resp.text
    assert "a success threshold" in resp.json()["detail"]
    assert (await _check(ctx, doc_id)).status == "critical"


async def test_no_proposal_is_left_by_a_refused_archive(client):
    ctx = await make_ctx()
    _doc_id, b = await _blocker(client, ctx)
    assert (await _archive(client, ctx, b["id"], "delete", "approver")).status_code == 403
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.scalars(select(Proposal))).all() == []
