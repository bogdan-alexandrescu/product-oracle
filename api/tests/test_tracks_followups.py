"""Review fixes 2, the smaller items: approving a PRD version (= publishing it, T2)
starts its track and only a PRD has one; the hourly monitor isolates a failing track;
GET /v1/tracks reads blockers in one query per track, not one per item; a track's owner
is a member of the company; carry_forward matches item keys exactly; a create_track race
returns the existing track with 200. Against Postgres with the FakeRuntime."""

import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy import delete, select

from oracle.auth.service import create_user
from oracle.docs.models import Document
from oracle.roadmap import items as items_mod
from oracle.roadmap import tracks, views
from oracle.roadmap.models import ProductTrack
from oracle.tenancy import tenant_session
from tests.conftest import make_tenant
from tests.test_roadmap import (  # noqa: F401 - fixtures
    PRD,
    ROADMAP,
    ROADMAP_MD,
    approved_prd,
    built_roadmap,
    owner,
    runtime,
)


async def _tracks(client, auth) -> list[dict]:
    return (await client.get("/v1/tracks", headers=auth)).json()


async def test_approving_a_prd_version_starts_its_track(client, owner):  # noqa: F811
    tenant_id, auth = owner
    await approved_prd(client, auth, approve=False)
    assert await _tracks(client, auth) == []
    resp = await client.post(f"/v1/documents/{PRD}/versions/1/approve", headers=auth)
    assert resp.status_code == 200, resp.text
    (track,) = await _tracks(client, auth)
    assert track["prd"]["slug"] == PRD
    # Approving again starts nothing new.
    await client.post(f"/v1/documents/{PRD}/versions/1/approve", headers=auth)
    assert len(await _tracks(client, auth)) == 1


async def test_only_a_prd_has_a_track(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    resp = await client.post(f"/v1/documents/{ROADMAP}/versions/1/approve", headers=auth)
    assert resp.status_code == 200
    assert len(await _tracks(client, auth)) == 1
    async with tenant_session(tenant_id) as s:
        from oracle.docs.models import DocumentVersion

        roadmap = await s.scalar(select(Document).where(Document.slug == ROADMAP))
        version = await s.scalar(
            select(DocumentVersion).where(DocumentVersion.document_id == roadmap.id)
        )
        with pytest.raises(tracks.Invalid):
            await tracks.ensure_track(s, roadmap, version, actor="system", cause="x")
        # A roadmap built from a roadmap version (never a PRD) gets no track.
        assert await tracks.track_for_roadmap(s, version, version) is None


async def test_a_create_track_race_returns_the_existing_track(client, owner, monkeypatch):  # noqa: F811
    _, auth = owner
    await approved_prd(client, auth)
    (existing,) = await _tracks(client, auth)
    # The PRD already has a track: an ordinary second start is a conflict.
    assert (await client.post("/v1/tracks", json={"prd": PRD}, headers=auth)).status_code == 409
    # The race: the route's check saw no track; ensure_track found the one just made.
    real = tracks.track_of_prd
    calls = []

    async def first_none(db, prd_id):
        calls.append(1)
        return None if len(calls) == 1 else await real(db, prd_id)

    monkeypatch.setattr(tracks, "track_of_prd", first_none)
    resp = await client.post("/v1/tracks", json={"prd": PRD}, headers=auth)
    assert resp.status_code == 200, resp.text
    assert resp.json()["id"] == existing["id"]


async def test_the_monitor_isolates_a_failing_track(client, owner, runtime, monkeypatch):  # noqa: F811
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    async with tenant_session(tenant_id) as s:
        other = Document(slug="billing-prd", title="Billing PRD", kind="prd", status="draft")
        s.add(other)
        await s.flush()
        s.add(ProductTrack(prd_document_id=other.id, title="Billing"))
        await s.commit()
        bad = (await s.scalar(select(ProductTrack).where(ProductTrack.title == "Billing"))).id

    real = views.overview

    async def overview(db, track):
        if track.id == bad:
            raise RuntimeError("boom")
        return await real(db, track)

    monkeypatch.setattr(views, "overview", overview)
    failed: list[uuid.UUID] = []
    async with tenant_session(tenant_id) as s:
        assert await views.monitor_due(s, failed=failed) == 1
        await s.commit()
    assert failed == [bad]
    async with tenant_session(tenant_id) as s:
        good = await s.scalar(select(ProductTrack).where(ProductTrack.id != bad))
        assert good.monitored_at is not None and good.monitor["health"]

    # The ticker counts the company as failed and keeps the good track's check.
    from oracle.ticker import router as ticker

    async with tenant_session(tenant_id) as s:
        await s.execute(delete(ProductTrack).where(ProductTrack.id == bad))
        s.add(ProductTrack(prd_document_id=other.id, title="Billing"))
        await s.commit()
        bad = (await s.scalar(select(ProductTrack).where(ProductTrack.title == "Billing"))).id
    seen = []
    # The account sweep is a step of oracle.ticker.body.tick_company.
    monkeypatch.setattr(ticker.body.claude_sweep, "sweep_if_due", lambda *a: _none())
    await ticker._tick_company(tenant_id, ticker.TickerOut(), SimpleNamespace(add=seen.append))
    assert seen == [tenant_id]


async def _none() -> None:
    return None


async def test_listing_tracks_reads_blockers_once_per_track(client, owner, runtime, monkeypatch):  # noqa: F811
    _, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    calls = []
    real = items_mod.blockers_of

    async def counted(db, ids):
        calls.append(ids)
        return await real(db, ids)

    monkeypatch.setattr(items_mod, "blockers_of", counted)
    assert len(await _tracks(client, auth)) == 1
    # Two items, one track: one batched read (not one per item).
    assert len(calls) <= 1, calls


async def test_a_track_owner_is_a_member_of_the_company(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    await approved_prd(client, auth)
    (track,) = await _tracks(client, auth)
    url = f"/v1/tracks/{track['id']}"
    resp = await client.patch(url, json={"lock_version": 1, "owner_id": str(uuid.uuid4())},
                              headers=auth)  # fmt: skip
    assert resp.status_code == 422, resp.text
    async with tenant_session(await make_tenant("Other Co")) as s:
        stranger = str((await create_user(s, "stranger@example.com", "pw")).id)
        await s.commit()
    resp = await client.patch(url, json={"lock_version": 1, "owner_id": stranger},
                              headers=auth)  # fmt: skip
    assert resp.status_code == 422, resp.text
    async with tenant_session(tenant_id) as s:
        mine = str((await create_user(s, "lead@example.com", "pw")).id)
        await s.commit()
    resp = await client.patch(url, json={"lock_version": 1, "owner_id": mine}, headers=auth)
    assert resp.status_code == 200 and resp.json()["owner_id"] == mine
    resp = await client.patch(url, json={"lock_version": 2, "owner_id": None}, headers=auth)
    assert resp.status_code == 200 and resp.json()["owner_id"] is None


def test_carry_forward_matches_keys_exactly():
    def item(key, title):
        return SimpleNamespace(item_key=key, title=title)

    text = ROADMAP_MD
    assert items_mod._named_in(item("payment-step", "Something else"), text)
    assert items_mod._named_in(item("other", "Payment step"), text)
    # 'ment-step' is a part of 'payment-step', not the key of an item the text names.
    assert not items_mod._named_in(item("ment-step", "Card vault"), text)
    assert not items_mod._named_in(item("ping-step", "Card vault"), text)
    assert not items_mod._named_in(item("payment-step-2", "Card vault"), text)
