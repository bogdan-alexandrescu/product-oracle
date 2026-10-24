"""A publish renders on the export pool, never on the event loop, and never under its locks
(owner decision 2026-10-21, review of PR #134). Against Postgres.

Publish renders first (the export pool, in a place like an export: the publishing
person's export place and the company's shared places), then takes the review gate and the
document's row lock, checks again and stores. A version that changed during its render is
rendered once more; changed again, the publish is refused (409) and can be retried. A
published PDF renders on the export pool in a place too."""

import asyncio
import threading
from collections import defaultdict

import pytest
from sqlalchemy import select, text, update

from oracle import readiness
from oracle.db import get_engine
from oracle.docs.models import Document, DocumentVersion
from oracle.export import offload
from oracle.export import render as export_render
from oracle.review.models import DocumentPublication
from oracle.tenancy import tenant_session
from tests.conftest import make_tenant, seed_company
from tests.review_v2_helpers import DOC, DRAFT, Ctx, import_md, setup, verdict
from tests.test_priorities import _token
from tests.test_render_budget import Held, _busy, _company, _fill, until

# How long a held render waits for its release at most: a render held on the event loop
# (the bug) stalls the test this long, then lets it fail instead of hanging.
HOLD = 5.0
EXPORT = f"/v1/documents/{DOC}/versions/1/export?format=html"


@pytest.fixture(autouse=True)
def _only_test_checks():
    with readiness.isolated_checks():
        yield


class SlowPublish:
    """Publish renders whose full HTML waits until ``release(i)`` (``i``: the render's
    number, from 0); records the thread each ran on."""

    def __init__(self, monkeypatch) -> None:
        self.real = export_render.render_html
        self.gates: defaultdict[int, threading.Event] = defaultdict(threading.Event)
        self.lock = threading.Lock()
        self.started = 0
        self.threads: list[str] = []
        monkeypatch.setattr(export_render, "render_html", self)

    def __call__(self, ev):
        if ev.layer == "full":
            with self.lock:
                i = self.started
                self.started += 1
                self.threads.append(threading.current_thread().name)
                gate = self.gates[i]
            gate.wait(HOLD)
        return self.real(ev)

    def release(self, i: int | None = None) -> None:
        for n in range(64) if i is None else (i,):
            self.gates[n].set()


async def settle(*tasks: asyncio.Task) -> None:
    """Wait for ``tasks`` to end, so none outlives a failed test (its teardown wipes the
    tables)."""
    if tasks:
        await asyncio.wait(tasks)


def off_the_loop(slow: SlowPublish) -> None:
    assert slow.threads[-1].startswith("export"), f"rendered on {slow.threads[-1]}"


async def approved(client, ctx: Ctx) -> None:
    resp = await client.post(ctx.v(1, "/approve"), headers=ctx.auth)
    assert resp.status_code == 200, resp.text


async def company(client, name: str) -> Ctx:
    """Another company, with the team calendar PRD (version 1) and an owner token."""
    tenant = await make_tenant(name)
    await seed_company(tenant)
    auth = await _token(tenant, "owner")
    assert (await import_md(client, auth, DRAFT)).status_code == 201
    return Ctx(tenant, auth)


def publish(client, ctx: Ctx, headers: dict | None = None):
    return client.post(ctx.v(1, "/publish"), json={}, headers=headers or ctx.auth)


async def publications(ctx: Ctx) -> list[DocumentPublication]:
    async with tenant_session(ctx.tenant_id) as s:
        return list((await s.scalars(select(DocumentPublication))).all())


async def change_version(ctx: Ctx, content_hash: str) -> None:
    """Version 1's content changes (as a version written by another path would)."""
    async with tenant_session(ctx.tenant_id) as s:
        document = await s.scalar(select(Document).where(Document.slug == DOC))
        await s.execute(
            update(DocumentVersion)
            .where(DocumentVersion.document_id == document.id, DocumentVersion.number == 1)
            .values(content_hash=content_hash)
        )
        await s.commit()


# --------------------------------------------------------------------------- no lock held


async def test_publish_never_renders_under_the_gate_or_the_row_lock(client, monkeypatch):
    ctx = await setup(client)
    await approved(client, ctx)
    slow = SlowPublish(monkeypatch)
    task = asyncio.create_task(publish(client, ctx))
    try:
        await until(lambda: slow.started == 1)
        off_the_loop(slow)
        # No connection held while it renders, so no transaction and no lock.
        await asyncio.sleep(0.1)
        assert get_engine().pool.checkedout() == 0
        async with tenant_session(ctx.tenant_id) as s:
            gate = await s.scalar(
                text("SELECT pg_try_advisory_xact_lock(hashtextextended(:k, 0))"),
                {"k": f"oracle-review-gate:{ctx.tenant_id}"},
            )
            assert gate is True, "the review gate is held during the render"
            row = await s.scalar(
                select(Document).where(Document.slug == DOC).with_for_update(nowait=True)
            )
            assert row is not None  # the row lock is free (NOWAIT would raise)
            await s.rollback()
    finally:
        slow.release()
        await settle(task)
    resp = await task
    assert resp.status_code == 201, resp.text
    assert slow.threads and all(t.startswith("export") for t in slow.threads), slow.threads


# --------------------------------------------------------------------------- version changed


async def test_a_version_changed_during_its_render_is_rendered_once_more(client, monkeypatch):
    ctx = await setup(client)
    await approved(client, ctx)
    slow = SlowPublish(monkeypatch)
    task = asyncio.create_task(publish(client, ctx))
    try:
        await until(lambda: slow.started == 1)
        off_the_loop(slow)
        await change_version(ctx, "changed-once")
        slow.release(0)
        await until(lambda: slow.started == 2)
    finally:
        slow.release()
        await settle(task)
    resp = await task
    assert resp.status_code == 201, resp.text
    assert slow.started == 2
    [row] = await publications(ctx)
    assert row.content_hash == "changed-once"


async def test_a_version_changed_during_both_renders_is_refused_and_can_be_retried(
    client, monkeypatch
):
    ctx = await setup(client)
    await approved(client, ctx)
    slow = SlowPublish(monkeypatch)
    task = asyncio.create_task(publish(client, ctx))
    try:
        await until(lambda: slow.started == 1)
        off_the_loop(slow)
        await change_version(ctx, "changed-once")
        slow.release(0)
        await until(lambda: slow.started == 2)
        await change_version(ctx, "changed-twice")
        slow.release(1)
    finally:
        slow.release()
        await settle(task)
    resp = await task
    assert resp.status_code == 409, resp.text
    assert "changed while it was being published" in resp.json()["detail"]
    assert slow.started == 2  # rendered once more, never a third time
    assert await publications(ctx) == []
    # The person publishes again: rendered and stored.
    again = await publish(client, ctx)
    assert again.status_code == 201, again.text
    [row] = await publications(ctx)
    assert row.content_hash == "changed-twice"


# --------------------------------------------------------------------------- places


async def test_publish_takes_the_person_s_export_place(client, monkeypatch):
    ctx = await setup(client)
    await approved(client, ctx)
    held = Held(monkeypatch)
    export = asyncio.create_task(client.get(EXPORT, headers=ctx.auth))
    try:
        await until(lambda: held.started == 1)
        resp = await publish(client, ctx)
        assert resp.status_code == 429, resp.text
        assert resp.headers["retry-after"] == "5"
        assert _busy(resp, "export_busy_you")["message"] == offload.BUSY_YOU
        assert await publications(ctx) == []
    finally:
        held.release()
        await settle(export)
    assert (await export).status_code == 200
    # And a publish rendering holds the person's place: their export waits its turn.
    slow = SlowPublish(monkeypatch)
    task = asyncio.create_task(publish(client, ctx))
    try:
        await until(lambda: slow.started == 1)
        off_the_loop(slow)
        assert offload.in_flight(ctx.tenant_id) == 1
        resp = await client.get(EXPORT, headers=ctx.auth)
        assert resp.status_code == 429, resp.text
        _busy(resp, "export_busy_you")
    finally:
        slow.release()
        await settle(task)
    assert (await task).status_code == 201
    assert offload.in_flight(ctx.tenant_id) == 0


async def test_publish_counts_in_the_company_s_two_places(client, monkeypatch):
    ctx = await setup(client)
    await approved(client, ctx)
    held = Held(monkeypatch)
    viewers = [await _token(ctx.tenant_id, "viewer") for _ in range(2)]
    exports = [asyncio.create_task(client.get(EXPORT, headers=h)) for h in viewers]
    try:
        await until(lambda: held.started == 2)
        resp = await publish(client, ctx)
        assert resp.status_code == 429, resp.text
        assert resp.headers["retry-after"] == "5"
        assert _busy(resp, "export_busy_you")["message"] == offload.BUSY_COMPANY
        assert offload.in_flight(ctx.tenant_id) == 2
    finally:
        held.release()
        await settle(*exports)
    for t in exports:
        assert (await t).status_code == 200
    assert await publications(ctx) == []


async def test_a_publish_waiting_past_the_queue_cap_is_busy(client, monkeypatch):
    held = Held(monkeypatch)
    monkeypatch.setattr(offload, "QUEUE_SECONDS", 0.2)
    a, b = await _company(client, "A Co"), await _company(client, "B Co")
    ctx = await company(client, "C Co")
    await approved(client, ctx)
    blockers = []
    try:
        blockers += await _fill(client, a, b)
        await until(lambda: held.started == 4)
        resp = await publish(client, ctx)
        assert resp.status_code == 503, resp.text
        assert resp.headers["retry-after"] == "5"
        assert _busy(resp, "export_busy")["message"] == offload.BUSY
        assert offload.in_flight(ctx.tenant_id) == 0
        assert await publications(ctx) == []
    finally:
        held.release()
        await settle(*blockers)
    for t in blockers:
        assert (await t).status_code == 200
    assert (await publish(client, ctx)).status_code == 201


# --------------------------------------------------------------------------- published PDF


async def test_the_published_pdf_renders_on_the_export_pool_in_a_place(client, monkeypatch):
    from oracle.export import pdf

    ctx = await setup(client)
    await approved(client, ctx)
    assert (await publish(client, ctx)).status_code == 201
    gate = threading.Event()
    threads: list[str] = []

    def held_pdf(html: str) -> bytes:
        threads.append(threading.current_thread().name)
        gate.wait(HOLD)
        return b"%PDF-1.7 held"

    monkeypatch.setattr(pdf, "html_to_pdf", held_pdf)
    url = f"/v1/documents/{DOC}/publications/1/export?format=pdf"
    task = asyncio.create_task(client.get(url, headers=ctx.auth))
    try:
        await until(lambda: len(threads) == 1)
        assert threads[0].startswith("export"), f"rendered on {threads[0]}"
        assert not task.done()
        assert offload.in_flight(ctx.tenant_id) == 1
        # The person's place is taken: a second PDF is refused at once.
        resp = await client.get(url, headers=ctx.auth)
        assert resp.status_code == 429, resp.text
        _busy(resp, "export_busy_you")
    finally:
        gate.set()
        await settle(task)
    resp = await task
    assert resp.status_code == 200, resp.text
    assert resp.content == b"%PDF-1.7 held"
    assert threads == [threads[0]] and threads[0].startswith("export"), threads


# --------------------------------------------------------------------------- others go on


@pytest.mark.timing
async def test_approvals_go_on_while_a_publish_renders(client, monkeypatch):
    """Another company's approvals, and verdicts on the document being published, are not
    held behind a slow publish render."""
    ctx = await setup(client)
    await approved(client, ctx)
    other = await company(client, "Other Co")
    slow = SlowPublish(monkeypatch)
    task = asyncio.create_task(publish(client, ctx))
    try:
        await until(lambda: slow.started == 1)
        off_the_loop(slow)
        resp = await asyncio.wait_for(client.post(other.v(1, "/approve"), headers=other.auth), 2)
        assert resp.status_code == 200, resp.text
        resp = await asyncio.wait_for(verdict(client, ctx.auth, 1, "problem"), 2)
        assert resp.status_code == 200, resp.text
        assert not task.done()
    finally:
        slow.release()
        await settle(task)
    assert (await task).status_code == 201
