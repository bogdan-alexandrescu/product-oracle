"""Baseline graph: CRUD with origin, locks, revisions, proposals, goal confirmation, roles."""

import uuid

import pytest
from sqlalchemy import select

from oracle.baseline.models import Entity, Proposal
from oracle.main import app
from oracle.models import AuditEvent
from oracle.runs.models import Run
from oracle.tenancy import tenant_session
from tests.baseline_helpers import confirm, edge, entity, make_ctx, set_token_role

B = "/v1/baseline"


@pytest.fixture
async def ctx():
    return await make_ctx()


async def test_user_edit_locks_and_writes_revisions(client, ctx):
    feat = await entity(client, ctx, type="feature", key="guided-setup", attrs={"effort": "M"})
    assert feat["origin"] == "user"
    assert feat["status"] == "confirmed"
    assert feat["locked"] is True
    assert feat["locked_by"] == str(ctx.users["owner"].id)

    resp = await client.patch(
        f"{B}/entities/{feat['id']}",
        json={
            "title": "Guided setup v2",
            "attrs": {"effort": "L", "status": "planned"},
            "reason": "sized by eng",
        },
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["applied"] is True
    assert out["entity"]["title"] == "Guided setup v2"
    assert out["entity"]["attrs"] == {"effort": "L", "status": "planned"}
    assert out["entity"]["locked_by"] == str(ctx.users["approver"].id)

    revs = await client.get(f"{B}/entities/{feat['id']}/revisions", headers=ctx.as_("viewer"))
    revs = revs.json()
    assert len(revs) == 2
    latest, created = revs
    assert created["before"] is None and created["after"]["key"] == "guided-setup"
    assert latest["before"]["title"] == "Guided setup"
    assert latest["after"]["title"] == "Guided setup v2"
    assert latest["actor"] == f"user:{ctx.users['approver'].id}"
    assert latest["reason"] == "sized by eng"

    # A null attr removes the key; an unchanged write writes no revision.
    resp = await client.patch(
        f"{B}/entities/{feat['id']}", json={"attrs": {"status": None}}, headers=ctx.as_("owner")
    )
    assert resp.json()["entity"]["attrs"] == {"effort": "L"}
    await client.patch(
        f"{B}/entities/{feat['id']}", json={"title": "Guided setup v2"}, headers=ctx.as_("owner")
    )
    revs = await client.get(f"{B}/entities/{feat['id']}/revisions", headers=ctx.as_("owner"))
    assert len(revs.json()) == 3


async def test_api_token_edits_lock_too(client, ctx):
    feat = await entity(client, ctx, who="token", type="feature", key="saved-carts")
    assert feat["locked"] is True
    assert feat["locked_by"] == str(ctx.token_id)


async def test_agent_writes_apply_to_unlocked_and_propose_on_locked(client, ctx):
    agent = await entity(client, ctx, type="feature", key="dark-mode", origin="agent")
    assert agent["origin"] == "agent"
    assert agent["status"] == "proposed"
    assert agent["locked"] is False

    # Unlocked: an agent edit applies and does not lock.
    resp = await client.patch(
        f"{B}/entities/{agent['id']}",
        json={"title": "Dark theme", "origin": "agent"},
        headers=ctx.as_("token"),
    )
    assert resp.status_code == 200
    assert resp.json()["entity"]["title"] == "Dark theme"
    assert resp.json()["entity"]["locked"] is False

    # A person edits it: now locked; the next agent edit becomes a proposal.
    await client.patch(
        f"{B}/entities/{agent['id']}",
        json={"body": "Asked for by admins"},
        headers=ctx.as_("owner"),
    )
    run_id = None
    body = {"title": "Night mode", "origin": "agent", "reason": "seen in chat"}
    resp = await client.patch(f"{B}/entities/{agent['id']}", json=body, headers=ctx.as_("token"))
    assert resp.status_code == 202, resp.text
    out = resp.json()
    assert out["applied"] is False
    assert out["entity"]["title"] == "Dark theme"
    proposal = out["proposal"]
    assert proposal["status"] == "open"
    assert proposal["entity_id"] == agent["id"]
    assert proposal["payload"] == {
        "op": "update",
        "kind": "entity",
        "fields": {"title": "Night mode"},
        "reason": "seen in chat",
        "origin": "agent",
    }
    assert proposal["run_id"] == run_id

    # The same write again is the same proposal.
    again = await client.patch(f"{B}/entities/{agent['id']}", json=body, headers=ctx.as_("token"))
    assert again.json()["proposal"]["id"] == proposal["id"]

    # Agent delete of a locked item: also a proposal.
    resp = await client.delete(
        f"{B}/entities/{agent['id']}", params={"origin": "agent"}, headers=ctx.as_("token")
    )
    assert resp.status_code == 202
    delete_proposal = resp.json()
    assert delete_proposal["payload"]["op"] == "delete"

    listed = await client.get(
        f"{B}/proposals", params={"status": "open"}, headers=ctx.as_("viewer")
    )
    assert {p["id"] for p in listed.json()} == {proposal["id"], delete_proposal["id"]}

    # Accepting applies it as the approver's own edit.
    resp = await client.post(f"{B}/proposals/{proposal['id']}/accept", headers=ctx.as_("approver"))
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "accepted"
    assert resp.json()["decided_by"] == str(ctx.users["approver"].id)
    detail = (await client.get(f"{B}/entities/{agent['id']}", headers=ctx.as_("viewer"))).json()
    assert detail["title"] == "Night mode"
    assert detail["locked_by"] == str(ctx.users["approver"].id)
    revs = (
        await client.get(f"{B}/entities/{agent['id']}/revisions", headers=ctx.as_("viewer"))
    ).json()
    assert revs[0]["actor"] == f"user:{ctx.users['approver'].id}"

    # Rejecting leaves the item alone; deciding twice is a conflict.
    resp = await client.post(
        f"{B}/proposals/{delete_proposal['id']}/reject", headers=ctx.as_("approver")
    )
    assert resp.json()["status"] == "rejected"
    resp = await client.post(
        f"{B}/proposals/{delete_proposal['id']}/accept", headers=ctx.as_("approver")
    )
    assert resp.status_code == 409
    assert (
        await client.get(f"{B}/entities/{agent['id']}", headers=ctx.as_("owner"))
    ).status_code == 200


async def test_unlock_lets_agents_write_again(client, ctx):
    feat = await entity(client, ctx, type="feature", key="team-invites")
    resp = await client.post(f"{B}/entities/{feat['id']}/unlock", headers=ctx.as_("approver"))
    assert resp.json()["locked"] is False
    resp = await client.patch(
        f"{B}/entities/{feat['id']}",
        json={"title": "Invites", "origin": "agent"},
        headers=ctx.as_("token"),
    )
    assert resp.status_code == 200 and resp.json()["applied"] is True


async def test_user_delete_removes_and_audits(client, ctx):
    feat = await entity(client, ctx, type="feature", key="usage-export")
    resp = await client.delete(f"{B}/entities/{feat['id']}", headers=ctx.as_("owner"))
    assert resp.status_code == 204
    assert (
        await client.get(f"{B}/entities/{feat['id']}", headers=ctx.as_("owner"))
    ).status_code == 404
    async with tenant_session(ctx.tenant_id) as s:
        actions = (await s.scalars(select(AuditEvent.action))).all()
    assert "baseline.entity.deleted" in actions


async def test_entity_validation(client, ctx):
    await entity(client, ctx, type="feature", key="guided-setup")
    dup = await client.post(
        f"{B}/entities",
        json={"type": "feature", "key": "guided-setup", "title": "Again"},
        headers=ctx.as_("owner"),
    )
    assert dup.status_code == 409
    bad = await client.post(
        f"{B}/entities", json={"type": "epic", "key": "x", "title": "X"}, headers=ctx.as_("owner")
    )
    assert bad.status_code == 422
    bad_key = await client.post(
        f"{B}/entities",
        json={"type": "feature", "key": "Has Spaces", "title": "X"},
        headers=ctx.as_("owner"),
    )
    assert bad_key.status_code == 422
    missing = await client.get(f"{B}/entities/{uuid.uuid4()}", headers=ctx.as_("owner"))
    assert missing.status_code == 404


async def test_goals_need_the_confirm_step(client, ctx):
    goal = await entity(
        client,
        ctx,
        type="goal",
        key="activation",
        title="Raise activation",
        attrs={"metric": "activated accounts", "target": "40%", "horizon": "short", "weight": 3},
    )
    assert goal["status"] == "proposed"
    resp = await client.patch(
        f"{B}/entities/{goal['id']}", json={"status": "confirmed"}, headers=ctx.as_("owner")
    )
    assert resp.status_code == 422
    resp = await client.post(
        f"{B}/entities",
        json={"type": "goal", "key": "g2", "title": "G", "status": "confirmed"},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 422

    resp = await client.post(f"{B}/entities/{goal['id']}/confirm", headers=ctx.as_("commenter"))
    assert resp.status_code == 403
    confirmed = await confirm(client, ctx, goal)
    assert confirmed["status"] == "confirmed"
    assert confirmed["locked"] is True
    revs = (
        await client.get(f"{B}/entities/{goal['id']}/revisions", headers=ctx.as_("owner"))
    ).json()
    assert revs[0]["before"]["status"] == "proposed" and revs[0]["after"]["status"] == "confirmed"

    resp = await client.post(f"{B}/entities/{goal['id']}/reject", headers=ctx.as_("approver"))
    assert resp.json()["status"] == "rejected"


async def test_edges(client, ctx):
    goal = await entity(client, ctx, type="goal", key="activation")
    feat = await entity(client, ctx, type="feature", key="guided-setup")
    other = await entity(client, ctx, type="feature", key="sample-data")

    resp = await client.post(
        f"{B}/edges",
        json={"src_id": feat["id"], "dst_id": goal["id"], "type": "supports"},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 422  # contribution required
    resp = await client.post(
        f"{B}/edges",
        json={
            "src_id": feat["id"],
            "dst_id": goal["id"],
            "type": "supports",
            "attrs": {"contribution": 4},
        },
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 422
    sup = await edge(client, ctx, feat, goal, "supports", attrs={"contribution": 2})
    assert sup["locked"] is True and sup["origin"] == "user"
    dup = await client.post(
        f"{B}/edges",
        json={
            "src_id": feat["id"],
            "dst_id": goal["id"],
            "type": "supports",
            "attrs": {"contribution": 1},
        },
        headers=ctx.as_("owner"),
    )
    assert dup.status_code == 409
    self_edge = await client.post(
        f"{B}/edges",
        json={"src_id": feat["id"], "dst_id": feat["id"], "type": "blocks"},
        headers=ctx.as_("owner"),
    )
    assert self_edge.status_code == 422
    dep = await edge(client, ctx, other, feat, "depends_on", origin="agent")
    assert dep["locked"] is False and dep["status"] == "proposed"

    # Agent edit of the locked supports edge: a proposal; accepting applies it.
    resp = await client.patch(
        f"{B}/edges/{sup['id']}",
        json={"attrs": {"contribution": 3}, "origin": "agent"},
        headers=ctx.as_("token"),
    )
    assert resp.status_code == 202
    proposal = resp.json()["proposal"]
    assert proposal["edge_id"] == sup["id"]
    await client.post(f"{B}/proposals/{proposal['id']}/accept", headers=ctx.as_("owner"))
    edges = (
        await client.get(f"{B}/edges", params={"entity_id": feat["id"]}, headers=ctx.as_("viewer"))
    ).json()
    assert {e["type"]: e["attrs"] for e in edges}["supports"] == {"contribution": 3}
    revs = (await client.get(f"{B}/edges/{sup['id']}/revisions", headers=ctx.as_("viewer"))).json()
    assert revs[0]["after"]["attrs"] == {"contribution": 3}

    detail = (await client.get(f"{B}/entities/{feat['id']}", headers=ctx.as_("viewer"))).json()
    assert [e["type"] for e in detail["edges_out"]] == ["supports"]
    assert [e["type"] for e in detail["edges_in"]] == ["depends_on"]

    graph = (await client.get(f"{B}/graph", headers=ctx.as_("viewer"))).json()
    assert len(graph["entities"]) == 3 and len(graph["edges"]) == 2

    resp = await client.delete(f"{B}/edges/{dep['id']}", headers=ctx.as_("owner"))
    assert resp.status_code == 204


async def test_commenter_proposes_new_items(client, ctx):
    resp = await client.post(
        f"{B}/proposals",
        json={
            "op": "create",
            "kind": "entity",
            "fields": {"type": "feature", "key": "bulk-edit", "title": "Bulk edit"},
            "reason": "customers ask for it",
        },
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 201, resp.text
    proposal = resp.json()
    assert proposal["entity_id"] is None
    assert proposal["actor"] == f"user:{ctx.users['commenter'].id}"
    assert (
        await client.post(f"{B}/proposals/{proposal['id']}/accept", headers=ctx.as_("commenter"))
    ).status_code == 403
    resp = await client.post(f"{B}/proposals/{proposal['id']}/accept", headers=ctx.as_("approver"))
    assert resp.status_code == 200
    ents = (
        await client.get(f"{B}/entities", params={"type": "feature"}, headers=ctx.as_("viewer"))
    ).json()
    assert [e["key"] for e in ents] == ["bulk-edit"]
    assert ents[0]["locked"] is True

    bad = await client.post(
        f"{B}/proposals",
        json={"op": "create", "kind": "entity", "fields": {"type": "feature"}},
        headers=ctx.as_("commenter"),
    )
    assert bad.status_code == 422


async def test_accepting_a_stale_create_rolls_back(client, ctx):
    fields = {"type": "feature", "key": "bulk-edit", "title": "Bulk edit"}
    p = (
        await client.post(
            f"{B}/proposals",
            json={"op": "create", "kind": "entity", "fields": fields},
            headers=ctx.as_("commenter"),
        )
    ).json()
    await entity(client, ctx, **fields)
    resp = await client.post(f"{B}/proposals/{p['id']}/accept", headers=ctx.as_("approver"))
    assert resp.status_code == 409
    listed = (
        await client.get(f"{B}/proposals", params={"status": "open"}, headers=ctx.as_("owner"))
    ).json()
    assert [x["id"] for x in listed] == [p["id"]]


@pytest.mark.parametrize(
    ("role", "read", "write", "approve", "propose"),
    [
        ("viewer", 200, 403, 403, 403),
        ("commenter", 200, 403, 403, 201),
        ("approver", 200, 201, 200, 201),
        ("owner", 200, 201, 200, 201),
    ],
)
async def test_roles(client, ctx, role, read, write, approve, propose):
    goal = await entity(client, ctx, type="goal", key="activation")
    h = ctx.as_(role)
    for path in ("/graph", "/entities", "/edges", "/proposals", "/conflicts", "/trace", "/yaml"):
        assert (await client.get(B + path, headers=h)).status_code == read, path
    resp = await client.post(
        f"{B}/entities", json={"type": "feature", "key": f"f-{role}", "title": "F"}, headers=h
    )
    assert resp.status_code == write
    assert (
        await client.post(f"{B}/entities/{goal['id']}/confirm", headers=h)
    ).status_code == approve
    assert (await client.post(f"{B}/rescore", headers=h)).status_code == approve
    resp = await client.post(
        f"{B}/proposals",
        json={
            "op": "update",
            "kind": "entity",
            "entity_id": goal["id"],
            "fields": {"title": "New"},
        },
        headers=h,
    )
    assert resp.status_code == propose


async def test_token_roles_apply(client, ctx):
    await set_token_role(ctx, "viewer")
    resp = await client.post(
        f"{B}/entities",
        json={"type": "feature", "key": "x", "title": "X"},
        headers=ctx.as_("token"),
    )
    assert resp.status_code == 403


async def test_every_baseline_route_requires_auth(client):
    for path, item in app.openapi()["paths"].items():
        if not path.startswith(B):
            continue
        for method in item:
            url = path.format(
                **{
                    k: uuid.uuid4()
                    for k in ("entity_id", "edge_id", "evidence_id", "proposal_id", "conflict_id")
                }
            )
            resp = await client.request(method.upper(), url)
            assert resp.status_code == 401, (method, path)


async def test_other_company_cannot_see_the_graph(client, ctx):
    feat = await entity(client, ctx, type="feature", key="guided-setup")
    other = await make_ctx("Other Co")
    resp = await client.get(f"{B}/entities/{feat['id']}", headers=other.as_("owner"))
    assert resp.status_code == 404
    assert (await client.get(f"{B}/graph", headers=other.as_("owner"))).json()["entities"] == []
    async with tenant_session(other.tenant_id) as s:
        assert (await s.scalars(select(Entity))).all() == []


async def test_revisions_take_a_limit_of_the_newest(client, ctx):
    """Home's goal trend reads only the newest revisions, never a goal's whole history."""
    goal = await entity(client, ctx, type="goal", key="activation", attrs={"current": "30%"})
    for current in ("31%", "33%", "35%"):
        resp = await client.patch(
            f"{B}/entities/{goal['id']}",
            json={"attrs": {"current": current}},
            headers=ctx.as_("owner"),
        )
        assert resp.status_code == 200, resp.text
    url = f"{B}/entities/{goal['id']}/revisions"
    every = (await client.get(url, headers=ctx.as_("viewer"))).json()
    assert len(every) == 4
    newest = (await client.get(url, params={"limit": 2}, headers=ctx.as_("viewer"))).json()
    assert newest == every[:2]
    assert [r["after"]["attrs"]["current"] for r in newest] == ["35%", "33%"]
    for bad in (0, 501):
        resp = await client.get(url, params={"limit": bad}, headers=ctx.as_("viewer"))
        assert resp.status_code == 422, bad


# --- B3: proposals by run --------------------------------------------------------------


async def _run(ctx, flow: str = "baseline_to_prd") -> uuid.UUID:
    async with tenant_session(ctx.tenant_id) as s:
        run = Run(flow=flow, status="running", created_by=ctx.users["owner"].id)
        s.add(run)
        await s.commit()
        return run.id


async def _propose(client, ctx, key: str, run_id: uuid.UUID | None = None, who="commenter"):
    body = {"op": "create", "kind": "entity", "fields": {"type": "feature", "key": key}}
    body["fields"]["title"] = key
    if run_id:
        body["run_id"] = str(run_id)
    resp = await client.post(f"{B}/proposals", json=body, headers=ctx.as_(who))
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _listed(client, ctx, **params) -> list[dict]:
    resp = await client.get(f"{B}/proposals", params=params, headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_proposals_filter_by_run_and_none(client, ctx):
    """protects: the run filter (a run's own proposals, or those of no run), newest first.
    fails_when: another run's or a person's proposal is listed under a run, or the
    reverse; or an unknown value is accepted.
    no_claim: proposals made through the API; a run's merge is covered elsewhere."""
    one, two = await _run(ctx), await _run(ctx, "feedback_loop")
    a = await _propose(client, ctx, "one-a", one)
    person = await _propose(client, ctx, "by-a-person")
    b = await _propose(client, ctx, "one-b", one)
    await _propose(client, ctx, "two-a", two)

    assert [p["id"] for p in await _listed(client, ctx, run_id=str(one))] == [b["id"], a["id"]]
    assert [p["id"] for p in await _listed(client, ctx, run_id="none")] == [person["id"]]
    assert len(await _listed(client, ctx)) == 4
    open_one = await _listed(client, ctx, status="open", run_id=str(one))
    assert [p["id"] for p in open_one] == [b["id"], a["id"]]
    for bad in ("abc", "None", "null", ""):
        resp = await client.get(f"{B}/proposals", params={"run_id": bad}, headers=ctx.as_("viewer"))
        assert resp.status_code == 422, bad


async def test_withdrawn_proposals_never_listed_with_a_run_filter(client, ctx):
    """protects: decision S6 Private findings (a withdrawn proposal is never listed).
    fails_when: the run filter or the none filter lists a withdrawn proposal.
    no_claim: withdraws by setting the status, not through an intake finding."""
    run_id = await _run(ctx)
    kept = await _propose(client, ctx, "kept", run_id)
    gone = await _propose(client, ctx, "gone", run_id)
    no_run = await _propose(client, ctx, "gone-too")
    async with tenant_session(ctx.tenant_id) as s:
        for pid in (gone["id"], no_run["id"]):
            (await s.get(Proposal, uuid.UUID(pid))).status = "withdrawn"
        await s.commit()
    assert [p["id"] for p in await _listed(client, ctx, run_id=str(run_id))] == [kept["id"]]
    assert await _listed(client, ctx, run_id="none") == []
    assert [p["id"] for p in await _listed(client, ctx)] == [kept["id"]]


async def test_proposal_carries_its_run_summary_until_the_run_is_deleted(client, ctx):
    """protects: each proposal names its run (flow title, started date) for the link.
    fails_when: ProposalOut.run is missing or wrong, or survives the run's deletion.
    no_claim: the flow title comes from oracle.runs.flows, not from the run row."""
    run_id = await _run(ctx)
    made = await _propose(client, ctx, "with-run", run_id)
    await _propose(client, ctx, "no-run")
    assert made["run"]["id"] == str(run_id)
    listed = {p["payload"]["fields"]["key"]: p for p in await _listed(client, ctx)}
    run = listed["with-run"]["run"]
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(Run, run_id)
        created_at = row.created_at
    assert run["id"] == str(run_id)
    assert run["flow"] == "baseline_to_prd"
    assert run["flow_title"] == "Baseline to PRD"
    assert run["status"] == "running"
    assert run["created_at"].startswith(created_at.date().isoformat())
    assert listed["no-run"]["run"] is None

    async with tenant_session(ctx.tenant_id) as s:
        await s.delete(await s.get(Run, run_id))
        await s.commit()
    [after] = [p for p in await _listed(client, ctx) if p["id"] == made["id"]]
    assert after["run_id"] is None and after["run"] is None


async def test_people_may_still_name_any_run_or_none(client, ctx):
    """protects: a person or an API token without a run binding chooses the run, as before.
    fails_when: the run-token check refuses a person's run_id or invents one.
    no_claim: says nothing about run tokens (tests/test_mcp.py covers them)."""
    run_id = await _run(ctx)
    assert (await _propose(client, ctx, "person-run", run_id))["run_id"] == str(run_id)
    assert (await _propose(client, ctx, "person-none"))["run_id"] is None
    token = await _propose(client, ctx, "token-run", run_id, who="token")
    assert token["run_id"] == str(run_id)
