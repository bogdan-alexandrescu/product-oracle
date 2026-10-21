"""A document's markdown is never parsed or rendered on the event loop (owner decision
2026-10-20): a roadmap version's dates are found on the parse pool and kept per version,
and every export renders on its own pool within a time cap. A slow one is a refusal, never
a stalled API. Against Postgres.

The large document is what ``parse_draft`` still accepts: 1 MB of ``[[[[a]]]] `` in
19,000-character lines (before this change its dates took about 19 s of CPU on every read
of the version, its HTML export another 4.4 s, all on the event loop)."""

import asyncio
import contextlib
import hashlib
import time

import pytest

from oracle.docs.models import Document, DocumentVersion, Section
from oracle.roadmap import doc_dates
from oracle.tenancy import tenant_session
from tests.fixtures import import_draft, seed_auth
from tests.test_brief import doc  # noqa: F401 - fixture
from tests.test_priorities import _token

# How long the event loop may go without running another task.
MAX_STALL = 0.2
# How long a test keeps asking for a version whose dates are still being found.
PATIENCE = 180.0

LINE = "[[[[a]]]] " * 1900  # 19,000 characters
BIG_BODY = "\n".join([LINE] * (1_000_000 // (len(LINE) + 1)))
SLUG = "big-roadmap"


@contextlib.asynccontextmanager
async def heartbeat():
    """The longest the event loop went without running this task, in seconds (``[0]``)."""
    longest = [0.0]
    stop = asyncio.Event()

    async def beat() -> None:
        last = time.perf_counter()
        while not stop.is_set():
            await asyncio.sleep(0.01)
            now = time.perf_counter()
            longest[0] = max(longest[0], now - last)
            last = now

    task = asyncio.create_task(beat())
    try:
        yield longest
    finally:
        stop.set()
        await task


async def big_roadmap(tenant_id) -> str:
    """A stored roadmap version with the large body (as one written before the import
    refused it): version 1 of ``big-roadmap``."""
    markdown = (
        f"---\ntitle: Big roadmap\nkind: roadmap\n---\n\n# Big roadmap {{#big}}\n\n{BIG_BODY}\n"
    )
    async with tenant_session(tenant_id) as s:
        document = Document(slug=SLUG, title="Big roadmap", status="draft", kind="roadmap")
        s.add(document)
        await s.flush()
        version = DocumentVersion(
            document_id=document.id,
            number=1,
            markdown=markdown,
            content_hash=hashlib.sha256(markdown.encode()).hexdigest(),
            front_matter={"title": "Big roadmap", "kind": "roadmap"},
        )
        s.add(version)
        await s.flush()
        s.add(
            Section(
                version_id=version.id,
                section_key="big",
                ordinal=0,
                level=1,
                heading="Big roadmap",
                body_md=BIG_BODY,
                body_text="",
                content_hash="big",
                layer="detail",
            )
        )
        await s.commit()
    return f"/v1/documents/{SLUG}/versions/1"


def count_calls(monkeypatch, module, name: str) -> list[int]:
    calls = [0]
    real = getattr(module, name)

    def counted(*args, **kwargs):
        calls[0] += 1
        return real(*args, **kwargs)

    monkeypatch.setattr(module, name, counted)
    return calls


async def until_ready(client, url: str, auth: dict):
    """GET ``url``, again while it answers 503 (the dates are still being found)."""
    deadline = time.monotonic() + PATIENCE
    resp = await client.get(url, headers=auth)
    while resp.status_code == 503 and time.monotonic() < deadline:
        assert resp.headers.get("retry-after"), resp.headers
        await asyncio.sleep(0.2)
        resp = await client.get(url, headers=auth)
    return resp


# --------------------------------------------------------------------------- roadmap reads


async def test_a_large_roadmap_read_never_blocks_the_loop_and_is_found_once(client, monkeypatch):
    tenant_id, auth = await seed_auth()
    url = await big_roadmap(tenant_id)
    finds = count_calls(monkeypatch, doc_dates, "find")

    async with heartbeat() as stall:
        resp = await until_ready(client, url, auth)
    assert stall[0] < MAX_STALL, f"the event loop stalled for {stall[0]:.2f} s"
    # Served once its dates are found, or refused because they take too long.
    assert resp.status_code in (200, 422), resp.text
    if resp.status_code == 200:
        assert resp.json()["date_marks"] == []

    # The next read is served from what the first one found: no second parse.
    async with heartbeat() as stall:
        again = await client.get(url, headers=auth)
    assert stall[0] < MAX_STALL, f"the event loop stalled for {stall[0]:.2f} s"
    assert again.status_code == resp.status_code, again.text
    assert finds[0] == 1

    # The markdown view reads the same dates.
    markdown = await client.get(f"{url}/markdown", headers=auth)
    assert markdown.status_code == resp.status_code
    assert finds[0] == 1


async def test_a_read_waits_for_dates_at_most_its_cap_then_they_are_served(client, monkeypatch):
    """A read that would wait longer than ``WAIT_SECONDS`` is refused with 503 and a
    Retry-After; the dates are still found, and the next read is served from them."""
    tenant_id, auth = await seed_auth()
    markdown = "---\ntitle: Slow plan\nkind: roadmap\n---\n\n# Slow plan {#plan}\n\nNo dates yet.\n"
    assert (await import_draft(client, auth, markdown, "slow-plan")).status_code == 201
    real = doc_dates.find

    def slow(*args, **kwargs):
        time.sleep(0.5)
        return real(*args, **kwargs)

    monkeypatch.setattr(doc_dates, "find", slow)
    monkeypatch.setattr(doc_dates, "WAIT_SECONDS", 0.05)
    finds = count_calls(monkeypatch, doc_dates, "find")
    # Version 2, imported the same way: its first read finds its dates.
    await _store_copy(tenant_id, "slow-plan")
    url = "/v1/documents/slow-plan/versions/2"

    first = await client.get(url, headers=auth)
    assert first.status_code == 503, first.text
    assert first.headers["retry-after"]
    assert "still being checked" in first.json()["detail"]
    resp = await until_ready(client, url, auth)
    assert resp.status_code == 200, resp.text
    assert finds[0] == 1


async def test_a_version_whose_dates_take_past_the_job_cap_is_refused_without_reparsing(
    client, monkeypatch
):
    """A job that ran past ``JOB_SECONDS`` gives up: that read and the next are 422, and
    the next one parses nothing."""
    tenant_id, auth = await seed_auth()
    markdown = "---\ntitle: Slow plan\nkind: roadmap\n---\n\n# Slow plan {#plan}\n\nNo dates yet.\n"
    assert (await import_draft(client, auth, markdown, "slow-plan")).status_code == 201
    real = doc_dates.find

    def slow(*args, **kwargs):
        time.sleep(0.6)
        return real(*args, **kwargs)

    monkeypatch.setattr(doc_dates, "find", slow)
    monkeypatch.setattr(doc_dates, "JOB_SECONDS", 0.2)
    finds = count_calls(monkeypatch, doc_dates, "find")
    await _store_copy(tenant_id, "slow-plan")
    url = "/v1/documents/slow-plan/versions/2"

    for _ in range(2):
        resp = await client.get(url, headers=auth)
        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"] == "This roadmap is too large to check its dates quickly"
    markdown_view = await client.get(f"{url}/markdown", headers=auth)
    assert markdown_view.status_code == 422
    assert finds[0] == 1


async def _store_copy(tenant_id, slug: str) -> None:
    """Version 2 of ``slug``: version 1's text, stored without an import (no dates found
    for it yet)."""
    from sqlalchemy import select

    async with tenant_session(tenant_id) as s:
        document = await s.scalar(select(Document).where(Document.slug == slug))
        v1 = await s.scalar(
            select(DocumentVersion).where(
                DocumentVersion.document_id == document.id, DocumentVersion.number == 1
            )
        )
        sections = list(await s.scalars(select(Section).where(Section.version_id == v1.id)))
        v2 = DocumentVersion(
            document_id=document.id,
            number=2,
            markdown=v1.markdown + "\n",
            content_hash=v1.content_hash + "-2",
            front_matter=v1.front_matter,
        )
        s.add(v2)
        await s.flush()
        for sec in sections:
            s.add(
                Section(
                    version_id=v2.id,
                    section_key=sec.section_key,
                    ordinal=sec.ordinal,
                    level=sec.level,
                    heading=sec.heading,
                    body_md=sec.body_md,
                    body_text=sec.body_text,
                    content_hash=sec.content_hash,
                    layer=sec.layer,
                )
            )
        await s.commit()


async def test_a_roadmap_import_whose_dates_take_too_long_is_refused(client, monkeypatch):
    _, auth = await seed_auth()
    monkeypatch.setattr(doc_dates, "WAIT_SECONDS", 0)
    markdown = "---\ntitle: Plan\nkind: roadmap\n---\n\n# Plan {#plan}\n\nNo dates yet.\n"
    resp = await import_draft(client, auth, markdown, "plan")
    assert resp.status_code == 422, resp.text
    assert [p["code"] for p in resp.json()["errors"]] == ["too_slow"]
    assert "dates" in resp.json()["errors"][0]["message"]


async def test_an_import_keeps_its_dates_for_the_version(client, monkeypatch):
    """The dates an import found are the version's: reading it right after parses nothing."""
    _, auth = await seed_auth()
    finds = count_calls(monkeypatch, doc_dates, "find")
    markdown = "---\ntitle: Plan\nkind: roadmap\n---\n\n# Plan {#plan}\n\nNo dates yet.\n"
    resp = await import_draft(client, auth, markdown, "plan")
    assert resp.status_code == 201, resp.text
    assert (await client.get("/v1/documents/plan/versions/1", headers=auth)).status_code == 200
    assert finds[0] == 1


async def test_template_dates_are_found_once_per_template_body(monkeypatch):
    body = "---\ntitle: T\n---\n\n# Plan {#plan}\n\nKickoff 2026-11-30.\n"
    calls = count_calls(monkeypatch, doc_dates, "template_dates")
    first = await doc_dates.template_dates_async(body)
    assert first == {("plan", "2026-11-30")}
    assert await doc_dates.template_dates_async(body) == first
    assert calls[0] == 1


# --------------------------------------------------------------------------- exports


@pytest.mark.parametrize("fmt", ["html", "md"])
async def test_a_large_roadmap_export_never_blocks_the_loop(client, fmt):
    tenant_id, auth = await seed_auth()
    url = await big_roadmap(tenant_id)

    async with heartbeat() as stall:
        resp = await until_ready(client, f"{url}/export?format={fmt}", auth)
    assert stall[0] < MAX_STALL, f"the event loop stalled for {stall[0]:.2f} s"
    assert resp.status_code in (200, 422), resp.text
    if resp.status_code == 422:
        assert resp.json()["detail"] in (
            "This document is too large to export quickly",
            "This roadmap is too large to check its dates quickly",
        )
    else:
        assert "[[[[a]]]]" in resp.text


EXPORTS = [
    "export?format=html",
    "export?format=pdf",
    "export?format=md",
    "export?layer=brief&format=html",
    "export?layer=deck&format=html",
    "export?layer=deck&format=pdf",
    "export?layer=deck&format=pptx",
    "deck",
    "reports/export?format=html",
]


@pytest.mark.parametrize("path", EXPORTS)
async def test_an_export_past_its_time_cap_is_refused(client, tenant_id, doc, monkeypatch, path):  # noqa: F811
    monkeypatch.setattr("oracle.export.offload.SECONDS", 0)
    viewer = await _token(tenant_id, "viewer")
    resp = await client.get(f"/v1/documents/checkout/versions/1/{path}", headers=viewer)
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"] == "This document is too large to export quickly"


async def test_exports_render_off_the_event_loop(client, tenant_id, doc, monkeypatch):  # noqa: F811
    """Every export renders on the export pool's threads, never on the loop's."""
    import threading

    from oracle.export import render

    seen: list[str] = []
    real = render.build_themed_context

    def spy(*args, **kwargs):
        seen.append(threading.current_thread().name)
        return real(*args, **kwargs)

    monkeypatch.setattr(render, "build_themed_context", spy)
    viewer = await _token(tenant_id, "viewer")
    resp = await client.get("/v1/documents/checkout/versions/1/export?format=html", headers=viewer)
    assert resp.status_code == 200, resp.text
    assert seen and all(name != threading.main_thread().name for name in seen), seen
