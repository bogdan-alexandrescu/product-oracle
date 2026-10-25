"""H9 Pricing input, security fixes for #541, part 2: the change events of a hidden
pricing decision's baseline entity are hidden with it (oracle.docs.visibility). An event
whose subject is that entity, or whose record names it (the ``affects`` edge from it, a
batch with it), is absent for commenters, viewers and their tokens: from
``/v1/change-events`` and its get, the trace impact of a change, and the MCP tools on
them. Against Postgres.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

import pytest
from sqlalchemy import select

from oracle.docs.models import Document
from oracle.swarm import FakeRuntime, set_runtime
from oracle.tenancy import tenant_session
from oracle.v2.models import ChangeEvent
from tests.baseline_helpers import make_ctx
from tests.blocker_helpers import make_entity
from tests.decision_helpers import clock  # noqa: F401
from tests.pricing_helpers import approved_memo
from tests.test_mcp import api_token, mcp_client, run_token, text_of
from tests.test_pricing_baseline_visibility import _decided, _leaks


@pytest.fixture
async def ctx():
    return await make_ctx()


@pytest.fixture(autouse=True)
def runtime():
    """The local runtime: run tokens from any address."""
    set_runtime(FakeRuntime())
    yield
    set_runtime(None)


ROLES = [("owner", True), ("approver", True), ("commenter", False), ("viewer", False)]


async def _reversed(client, ctx) -> tuple[str, str, list[str]]:
    """A decided pricing decision with an ``affects`` edge to a company goal, then
    reversed: (its entity's id, the goal's id, the ids of the change events naming the
    entity: its own update and the edge's record on the goal)."""
    goal = await make_entity(ctx, "goal", "team-plan-revenue")
    entity_id = await _decided(client, ctx)
    owner = ctx.as_("owner")
    resp = await client.post(
        "/v1/baseline/edges",
        json={"src_id": entity_id, "dst_id": str(goal), "type": "affects"},
        headers=owner,
    )
    assert resp.status_code == 201, resp.text
    entity = (await client.get(f"/v1/baseline/entities/{entity_id}", headers=owner)).json()
    number = entity["key"].split("-")[1]
    resp = await client.post(
        f"/v1/decisions/{number}/reviews",
        json={"verdict": "reversed", "note": "Seat counts lied"},
        headers=owner,
    )
    assert resp.status_code == 200, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        events = (await s.scalars(select(ChangeEvent))).all()
    naming = [e for e in events if entity_id in str(e.subject_id) + str(e.data)]
    assert any(str(e.subject_id) == entity_id for e in naming)
    assert any(str(e.subject_id) == str(goal) for e in naming)
    return entity_id, str(goal), [str(e.id) for e in naming]


@pytest.mark.parametrize(("who", "sees"), ROLES)
async def test_change_event_reads_follow_the_decision(client, ctx, who, sees):
    """protects=the change events of a reversed pricing decision's entity (its update and
    its affects edge) are in an owner's and an approver's /v1/change-events (unfiltered and
    by subject), its get and the change's trace impact, and absent for a commenter and a
    viewer (no row, a 404 for the get and the impact); fails_when=a commenter or viewer
    reads the entity's id or its "Price: ..." title through a change event;
    no_claim=the web (the API is what it shows)."""
    entity_id, goal, event_ids = await _reversed(client, ctx)
    me = ctx.as_(who)
    listed = await client.get("/v1/change-events", headers=me)
    by_subject = await client.get("/v1/change-events", params={"subject_id": entity_id}, headers=me)
    by_goal = await client.get("/v1/change-events", params={"subject_id": goal}, headers=me)
    for resp in (listed, by_subject, by_goal):
        assert resp.status_code == 200, resp.text
    ids = {e["id"] for e in listed.json()}
    for event_id in event_ids:
        one = await client.get(f"/v1/change-events/{event_id}", headers=me)
        impact = await client.get(f"/v1/trace/changes/{event_id}/impact", headers=me)
        if sees:
            assert event_id in ids
            assert one.status_code == 200 and entity_id in one.text
            assert impact.status_code == 200, impact.text
        else:
            assert event_id not in ids
            assert one.status_code == 404 and impact.status_code == 404
    if sees:
        assert entity_id in by_subject.text and entity_id in by_goal.text
    else:
        for resp in (listed, by_subject, by_goal):
            assert not _leaks(resp.text, entity_id), resp.url
            assert "Price:" not in resp.text and "decision:d-" not in resp.text


@pytest.mark.parametrize(("who", "sees"), ROLES)
async def test_over_mcp_change_events_follow_the_decision(client, ctx, who, sees):
    """protects=over MCP, a person's API token reads the decision entity's change events
    in list_change_events, get_change_event and get_change_impact only for an owner or an
    approver; fails_when=a commenter's or viewer's token reads them; no_claim=other
    tools (test_pricing_baseline_visibility)."""
    entity_id, _goal, event_ids = await _reversed(client, ctx)
    async with mcp_client(await api_token(ctx.tenant_id, who)) as c:
        listed = await c.call_tool("list_change_events", {})
        ones = [await c.call_tool("get_change_event", {"item_id": i}) for i in event_ids]
        impacts = [await c.call_tool("get_change_impact", {"change_id": i}) for i in event_ids]
    assert not listed.is_error, text_of(listed)
    assert (entity_id in text_of(listed)) is sees
    for got in ones + impacts:
        if sees:
            assert not got.is_error, text_of(got)
        else:
            assert got.is_error and "HTTP 404" in text_of(got), text_of(got)
            assert not _leaks(text_of(got), entity_id)
    if not sees:
        assert not _leaks(text_of(listed), entity_id)


@pytest.mark.parametrize("who", ["owner", "approver", "commenter", "viewer"])
async def test_a_run_token_reads_no_change_event_of_the_decision(client, ctx, who):
    """protects=a run token, whoever started the run, gets nothing on the decision
    entity's change events (change events and trace impact are not a run's reads: the
    tools are refused); fails_when=a run reads the entity's id or title through them;
    no_claim=which scopes a run is offered (oracle.mcp.scopes)."""
    entity_id, _goal, event_ids = await _reversed(client, ctx)
    raw = await run_token(
        ctx.tenant_id, ["read:baseline", "read:documents", "read:sources"], ctx.users[who].id
    )
    async with mcp_client(raw) as c:
        calls = [("list_change_events", {})]
        calls += [("get_change_event", {"item_id": i}) for i in event_ids]
        calls += [("get_change_impact", {"change_id": i}) for i in event_ids]
        for name, args in calls:
            try:
                got = await c.call_tool(name, args)
            except Exception:  # noqa: BLE001 - a tool not offered to the run
                continue
            assert got.is_error or not _leaks(text_of(got), entity_id), (name, text_of(got))


@pytest.mark.parametrize(("who", "sees"), ROLES)
async def test_a_hidden_memo_s_change_events_follow_the_memo(client, ctx, who, sees):
    """protects=the change events recorded against an approvers-only pricing memo (its
    versions) are listed for an owner and an approver and absent for a commenter and a
    viewer, by list, by document and by id; fails_when=a commenter or viewer reads the
    hidden memo's id or slug through a change event; no_claim=other documents' events."""
    slug = await approved_memo(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        doc_id = await s.scalar(select(Document.id).where(Document.slug == slug))
        event_ids = [
            str(i)
            for i in await s.scalars(
                select(ChangeEvent.id).where(ChangeEvent.document_id == doc_id)
            )
        ]
    assert event_ids
    me = ctx.as_(who)
    listed = await client.get("/v1/change-events", headers=me)
    by_doc = await client.get("/v1/change-events", params={"document_id": str(doc_id)}, headers=me)
    assert listed.status_code == 200 and by_doc.status_code == 200
    for event_id in event_ids:
        one = await client.get(f"/v1/change-events/{event_id}", headers=me)
        assert (event_id in listed.text) is sees
        assert one.status_code == (200 if sees else 404)
    if not sees:
        for resp in (listed, by_doc):
            assert str(doc_id) not in resp.text and slug not in resp.text


@pytest.mark.parametrize(("who", "sees"), ROLES)
async def test_an_id_inside_a_string_hides_the_event(client, ctx, who, sees):
    """protects=a change event whose record names the hidden decision entity inside a
    longer string ("entity:<id>", as a trace step does) is absent for a commenter and a
    viewer like one holding the bare id; fails_when=only a whole-string match hides it;
    no_claim=which writers record such strings."""
    entity_id = await _decided(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        event = ChangeEvent(
            subject_kind="entity", subject_id=None, cause="entity_updated", actor="system",
            data={"trace": [f"entity:{entity_id}", "goal:team-plan-revenue"]}, handled_by=[],
        )  # fmt: skip
        s.add(event)
        await s.commit()
        event_id = str(event.id)
    me = ctx.as_(who)
    listed = await client.get("/v1/change-events", headers=me)
    one = await client.get(f"/v1/change-events/{event_id}", headers=me)
    assert (event_id in listed.text) is sees
    assert one.status_code == (200 if sees else 404)
    if not sees:
        assert entity_id not in listed.text


@pytest.mark.parametrize(("who", "sees"), ROLES)
async def test_a_deleted_decision_entity_s_event_stays_hidden(client, ctx, who, sees):
    """protects=after an owner deletes a hidden pricing decision's baseline entity (the
    decision's entity_id goes null), its entity_deleted event, whose record carries the
    entity's key and "Price: ..." title, is still absent for a commenter and a viewer;
    fails_when=the event shows once the link is gone; no_claim=other causes."""
    entity_id = await _decided(client, ctx)
    resp = await client.delete(f"/v1/baseline/entities/{entity_id}", headers=ctx.as_("owner"))
    assert resp.status_code == 204, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        (event_id,) = [
            str(i)
            for i in await s.scalars(
                select(ChangeEvent.id).where(ChangeEvent.cause == "entity_deleted")
            )
        ]
    me = ctx.as_(who)
    listed = await client.get("/v1/change-events", headers=me)
    one = await client.get(f"/v1/change-events/{event_id}", headers=me)
    assert (event_id in listed.text) is sees
    assert one.status_code == (200 if sees else 404)
    if not sees:
        assert not _leaks(listed.text, entity_id) and "Price:" not in listed.text
