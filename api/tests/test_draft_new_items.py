"""S4 Freshness: "N new items since draft k, refresh?" on a PRD draft.

``GET /v1/documents/{doc}/versions/{n}/new-items`` counts the items of the draft's
author's own sources that are new, changed or deleted since the sources the draft was
written from: the snapshot its run pinned, or the moment the version was imported when no
run made it. Sources are private (S5): only the author sees the number; anyone else
gets ``visible: false`` and no count."""

import uuid

import pytest
from sqlalchemy import select

from oracle.docs.models import Document
from oracle.runs.models import Checkpoint, Run
from oracle.sources import base, service
from oracle.sources.models import Snapshot
from oracle.tenancy import tenant_session
from tests.fixtures import MARKDOWN, draft
from tests.sources_helpers import FakeConnector, client_for, make_connection, make_user, message

DOC = "checkout-redesign"


@pytest.fixture
def slack(monkeypatch):
    service.load_connectors()
    fake = FakeConnector(kind="slack", pages=[[message("m1", "one")]])
    monkeypatch.setitem(base._registry, "slack", fake)
    return fake


async def _source(c, tenant_id, user, name="Team chat"):
    conn = await make_connection(tenant_id, user, "slack")
    resp = await c.post(
        "/v1/sources",
        json={
            "kind": "slack",
            "name": name,
            "connection_id": str(conn),
            "config": {"channels": ["C1"]},
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _sync(c, sid):
    resp = await c.post(f"/v1/sources/{sid}/sync")
    assert resp.status_code == 200 and resp.json()["outcome"] == "completed", resp.text


async def _import(c):
    resp = await c.post(
        f"/v1/documents/{DOC}/versions", content=draft("prd_v1.md").encode(), headers=MARKDOWN
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _new(c, n=1):
    resp = await c.get(f"/v1/documents/{DOC}/versions/{n}/new-items")
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_the_author_sees_what_changed_since_the_import(tenant_id, slack):
    alice = await make_user(tenant_id, "alice@example.com")
    async with client_for(alice) as a:
        sid = await _source(a, tenant_id, alice)
        await _sync(a, sid)
        await _import(a)
        assert (await _new(a)) == {
            "version": 1,
            "as_of": (await _new(a))["as_of"],
            "count": 0,
            "visible": True,
        }
        # One new item and one changed one after the draft.
        slack.pages.append([message("m2", "two"), message("m1", "one, edited")])
        await _sync(a, sid)
        got = await _new(a)
        assert got["count"] == 2 and got["visible"] is True and got["as_of"] is not None


async def test_others_see_neither_the_items_nor_their_number(tenant_id, slack):
    alice = await make_user(tenant_id, "alice@example.com")
    bob = await make_user(tenant_id, "bob@example.com")
    async with client_for(alice) as a, client_for(bob) as b:
        sid = await _source(a, tenant_id, alice)
        await _import(a)
        await _sync(a, sid)
        assert (await _new(a))["count"] == 1
        # Bob's own new items do not count on Alice's draft either.
        bob_sid = await _source(b, tenant_id, bob, "Bob chat")
        await _sync(b, bob_sid)
        assert (await _new(a))["count"] == 1
        assert (await _new(b)) == {"version": 1, "as_of": None, "count": None, "visible": False}


async def test_a_run_draft_counts_from_the_runs_pin(tenant_id, slack):
    alice = await make_user(tenant_id, "alice@example.com")
    async with client_for(alice) as a:
        sid = await _source(a, tenant_id, alice)
        await _sync(a, sid)
        async with tenant_session(tenant_id) as s:
            snap = Snapshot(label="Run pin", created_by=alice.id)
            s.add(snap)
            await s.commit()
            snap_id = snap.id
        # Synced after the run pinned its sources but before the draft was imported:
        # the draft was not written from it.
        slack.pages.append([message("m2", "two")])
        await _sync(a, sid)
        await _import(a)
        async with tenant_session(tenant_id) as s:
            doc = await s.scalar(select(Document).where(Document.slug == DOC))
            run = Run(
                flow="baseline_to_prd",
                status="awaiting_checkpoint",
                snapshot_id=snap_id,
                created_by=alice.id,
                document_id=doc.id,
            )
            s.add(run)
            await s.flush()
            s.add(
                Checkpoint(
                    run_id=run.id,
                    kind="prd_review",
                    payload={"import": {"document_id": str(doc.id), "version": 1, "slug": DOC}},
                )
            )
            await s.commit()
        assert (await _new(a))["count"] == 1


async def test_a_run_draft_belongs_to_the_person_it_acted_for(tenant_id, slack):
    alice = await make_user(tenant_id, "alice@example.com")
    bob = await make_user(tenant_id, "bob@example.com")
    async with client_for(alice) as a, client_for(bob) as b:
        await _import(a)
        async with tenant_session(tenant_id) as s:
            doc = await s.scalar(select(Document).where(Document.slug == DOC))
            snap = Snapshot(label="Run pin", created_by=bob.id)
            s.add(snap)
            await s.flush()
            run = Run(
                flow="baseline_to_prd",
                status="awaiting_checkpoint",
                snapshot_id=snap.id,
                created_by=bob.id,
                document_id=doc.id,
            )
            s.add(run)
            await s.flush()
            s.add(
                Checkpoint(
                    run_id=run.id,
                    kind="prd_review",
                    payload={"import": {"document_id": str(doc.id), "version": 1, "slug": DOC}},
                )
            )
            await s.commit()
        assert (await _new(a))["visible"] is False
        assert (await _new(b))["visible"] is True


async def test_an_unknown_version_is_404(tenant_id, slack):
    alice = await make_user(tenant_id, "alice@example.com")
    async with client_for(alice) as a:
        await _import(a)
        resp = await a.get(f"/v1/documents/{DOC}/versions/9/new-items")
        assert resp.status_code == 404
        resp = await a.get(f"/v1/documents/{uuid.uuid4()}/versions/1/new-items")
        assert resp.status_code == 404
