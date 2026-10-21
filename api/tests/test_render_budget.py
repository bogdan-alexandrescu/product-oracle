"""A document's markdown is never parsed or rendered on the event loop (owner decision
2026-10-20): a roadmap version's dates are found on the parse pool and kept per version,
and every export renders on its own pool within a time cap. A slow one is a refusal, never
a stalled API. Against Postgres.

The large document is what ``parse_draft`` still accepts: 1 MB of ``[[[[a]]]] `` in
19,000-character lines (before this change its dates took about 19 s of CPU on every read
of the version, its HTML export another 4.4 s, all on the event loop).

Security review of PR #134 (2026-10-20): a dates job is given up on its own CPU time, not
the wall clock (other companies' work slows it); an export holds no database connection
while it waits, a full queue is "busy" (503), not "too large" (422), and one person or one
company cannot fill the export pool; the kept dates are compact, an entry too large to keep
evicts nothing, an import refuses a pathological number of dates, and one company runs at
most two date jobs at once."""

import asyncio
import contextlib
import hashlib
import threading
import time
import uuid
from datetime import UTC, date, datetime
from types import SimpleNamespace

import pytest
from sqlalchemy import inspect as sa_inspect
from sqlalchemy import select

from oracle.db import get_engine
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.export import offload
from oracle.export import router as export_router
from oracle.roadmap import doc_dates
from oracle.tenancy import tenant_session
from tests.conftest import make_tenant, seed_company
from tests.fixtures import import_draft, seed_auth
from tests.test_brief import (
    DRAFT,
    _import,
    doc,  # noqa: F401 - fixture
)
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


def burn(seconds: float) -> None:
    """Spend ``seconds`` of this thread's CPU."""
    end = time.thread_time() + seconds
    while time.thread_time() < end:
        pass


async def test_a_version_whose_dates_take_past_the_job_cap_is_refused_without_reparsing(
    client, monkeypatch
):
    """A job whose worker spent more than ``JOB_SECONDS`` of its own CPU gives up: that
    read and the next are 422, and the next one parses nothing."""
    tenant_id, auth = await seed_auth()
    markdown = "---\ntitle: Slow plan\nkind: roadmap\n---\n\n# Slow plan {#plan}\n\nNo dates yet.\n"
    assert (await import_draft(client, auth, markdown, "slow-plan")).status_code == 201
    real = doc_dates.find

    def slow(*args, **kwargs):
        burn(0.6)
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


def test_the_export_cap_and_pool_are_the_owner_s():
    """Owner decisions 2026-10-20: every export format renders for at most 60 s, counted
    from when its render starts, on its own 4-thread pool (not the parse pool); a wait of
    more than 10 s for a worker is "busy"; one export per person and two per company at
    a time, so one company never holds every worker."""
    from oracle import safe_yaml

    assert offload.SECONDS == 60.0
    assert offload.QUEUE_SECONDS == 10.0
    assert offload.EXPORTS_PER_PERSON == 1
    assert offload.EXPORTS_PER_COMPANY == 2
    assert offload.POOL._max_workers == 4
    assert offload.EXPORTS_PER_COMPANY < offload.POOL._max_workers
    assert offload.POOL is not safe_yaml._EXECUTOR
    assert offload.BUSY == "Oracle is busy with other exports. Try again in a moment."
    assert offload.BUSY_YOU == "Your previous export is still running"


@pytest.mark.parametrize("path", EXPORTS)
async def test_an_export_past_its_time_cap_is_refused(client, tenant_id, doc, monkeypatch, path):  # noqa: F811
    monkeypatch.setattr("oracle.export.offload.SECONDS", 0)
    viewer = await _token(tenant_id, "viewer")
    resp = await client.get(f"/v1/documents/checkout/versions/1/{path}", headers=viewer)
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"] == "This document is too large to export quickly"


async def test_exports_render_off_the_event_loop(client, tenant_id, doc, monkeypatch):  # noqa: F811
    """Every export renders on the export pool's threads, never on the loop's."""
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


# --------------------------------------------------------------------------- dates: CPU, not wall


async def _slow_plan_v2(client, tenant_id, auth) -> str:
    """Version 2 of ``slow-plan``, whose dates no read has found yet."""
    markdown = "---\ntitle: Slow plan\nkind: roadmap\n---\n\n# Slow plan {#plan}\n\nNo dates yet.\n"
    assert (await import_draft(client, auth, markdown, "slow-plan")).status_code == 201
    await _store_copy(tenant_id, "slow-plan")
    return "/v1/documents/slow-plan/versions/2"


def _given_up_versions() -> set:
    return {k[1] for k in doc_dates._KEPT.gave_up if k and k[0] == "version"}


async def test_a_job_slowed_by_contention_but_under_its_cpu_cap_is_never_given_up(
    client, monkeypatch
):
    """Wall time is how busy the server is, not what the document costs: a job that takes
    three times ``JOB_SECONDS`` on the clock while its worker spends almost no CPU (as when
    other companies' threads hold the GIL; ``time.sleep`` here) is served, never given up."""
    tenant_id, auth = await seed_auth()
    url = await _slow_plan_v2(client, tenant_id, auth)
    real = doc_dates.find

    def slowed(*args, **kwargs):
        time.sleep(0.6)  # the clock runs, this thread's CPU does not
        return real(*args, **kwargs)

    monkeypatch.setattr(doc_dates, "find", slowed)
    monkeypatch.setattr(doc_dates, "JOB_SECONDS", 0.2)
    finds = count_calls(monkeypatch, doc_dates, "find")

    resp = await until_ready(client, url, auth)
    assert resp.status_code == 200, resp.text
    assert finds[0] == 1
    assert uuid.UUID(resp.json()["id"]) not in _given_up_versions()


async def test_the_wall_backstop_never_gives_a_version_up(client, monkeypatch):
    """A job past the wall backstop (``JOB_WALL_SECONDS``: liveness, not cost) stops being
    waited for: the read is 503 (try again), the version is not given up, and the next read
    finds its dates."""
    tenant_id, auth = await seed_auth()
    url = await _slow_plan_v2(client, tenant_id, auth)
    real = doc_dates.find
    calls = [0]

    def first_slow(*args, **kwargs):
        calls[0] += 1
        if calls[0] == 1:
            time.sleep(0.6)
        return real(*args, **kwargs)

    monkeypatch.setattr(doc_dates, "find", first_slow)
    monkeypatch.setattr(doc_dates, "JOB_WALL_SECONDS", 0.2)

    first = await client.get(url, headers=auth)
    assert first.status_code == 503, first.text
    assert first.headers["retry-after"]
    resp = await until_ready(client, url, auth)
    assert resp.status_code == 200, resp.text  # not given up: a given-up version is 422
    assert uuid.UUID(resp.json()["id"]) not in _given_up_versions()
    assert calls[0] == 2


# --------------------------------------------------------------------------- dates: the cache


def _version(tenant_id: uuid.UUID | None = None, created: datetime | None = None):
    """A stored version as found_for_version reads it."""
    return SimpleNamespace(
        id=uuid.uuid4(),
        tenant_id=tenant_id or uuid.uuid4(),
        created_at=created or datetime.now(UTC),
        front_matter={},
    )


PARTS = (doc_dates._Part("plan", 1, "Plan", "Kickoff 2026-11-30."),)


def test_an_entry_too_large_to_keep_evicts_nothing(monkeypatch):
    """An entry above 1/8 of ``KEPT_BYTES`` is not kept, and every other entry stays (an
    oversized entry used to empty the cache and stay alone)."""
    monkeypatch.setattr(doc_dates, "KEPT_BYTES", 8_000)
    kept = doc_dates._Kept()
    small = frozenset({("plan", "2026-11-30")})
    for k in range(3):
        assert kept.put(("template", k), small) is True
    big = frozenset((f"s{k}", "2026-11-30") for k in range(100))
    assert kept.put(("template", "big"), big) is False
    assert kept.get(("template", "big")) is doc_dates._MISSING
    assert all(kept.get(("template", k)) == small for k in range(3))
    assert kept.weight <= doc_dates.KEPT_BYTES


def test_kept_dates_are_compact():
    """What a version keeps is packed: well under the 512 bytes a date took as objects."""
    body = "\n\n".join(f"Step {i} ships 2026-11-{i % 28 + 1:02d}." for i in range(1000))
    parts = (doc_dates._Part("plan", 1, "Plan", body),)
    ref = date(2026, 10, 20)
    found = tuple(doc_dates.find(parts, ref=ref))
    assert len(found) == 1000
    vid = uuid.uuid4()
    doc_dates.keep_for_version(vid, ref, found)
    _, weight = doc_dates._KEPT.values[("version", vid, ref, doc_dates.RENDERER)]
    assert weight < 200 * len(found), weight


async def test_kept_dates_read_back_exactly_what_was_found():
    body = (
        "| Item | Ships |\n|---|---|\n| [Payment](#now-payment-step) | 2026-11-30 |\n\n"
        "```\nfreeze 2026-12-01\n```\n\nThe 3rd of December, and 05/06/2026.\n"
    )
    parts = (doc_dates._Part("plan", 1, "Plan 2026-11-29", body),)
    created = datetime(2026, 10, 20, 12, tzinfo=UTC)
    version = _version(created=created)
    version.front_matter = {"title": "Plan for 2026-12-24"}
    found = tuple(doc_dates.find(parts, title="Plan for 2026-12-24", ref=created.date()))
    assert len(found) >= 5
    doc_dates.keep_for_version(version.id, created.date(), found)
    assert await doc_dates.found_for_version(version, parts) == found


async def test_a_stored_version_past_the_date_cap_is_refused_and_not_kept(monkeypatch):
    """A version stored before the import cap (or by any other path) with more than
    ``MAX_DATES`` dates: refused (422) and given up, never kept nor parsed again."""
    monkeypatch.setattr(doc_dates, "MAX_DATES", 2)
    finds = count_calls(monkeypatch, doc_dates, "find")
    parts = (doc_dates._Part("plan", 1, "Plan", "A 2026-11-30, B 2026-12-01, C 2026-12-02."),)
    version = _version()
    for _ in range(2):
        with pytest.raises(doc_dates.DatesUnavailable) as e:
            await doc_dates.found_for_version(version, parts)
        assert e.value.status_code == 422
    assert finds[0] == 1
    assert not [k for k in doc_dates._KEPT.values if k[1] == version.id]


async def test_a_roadmap_import_with_more_dates_than_the_cap_is_refused(client):
    """A clear refusal at import, well above any real roadmap (Galatia's writes dozens)."""
    assert doc_dates.MAX_DATES >= 1_000
    _, auth = await seed_auth()
    body = " ".join(["2026-11-30"] * (doc_dates.MAX_DATES + 1))
    markdown = f"---\ntitle: Plan\nkind: roadmap\n---\n\n# Plan {{#plan}}\n\n{body}\n"
    resp = await import_draft(client, auth, markdown, "plan")
    assert resp.status_code == 422, resp.text
    errors = resp.json()["errors"]
    assert [p["code"] for p in errors] == ["too_many_dates"], errors
    assert f"{doc_dates.MAX_DATES:,}" in errors[0]["message"]


async def until(cond, seconds: float = 15.0) -> None:
    deadline = time.monotonic() + seconds
    while not cond():
        assert time.monotonic() < deadline, "timed out waiting"
        await asyncio.sleep(0.01)


async def until_found(version) -> tuple:
    deadline = time.monotonic() + 30
    while True:
        try:
            return await doc_dates.found_for_version(version, PARTS)
        except doc_dates.DatesUnavailable as e:
            assert e.status_code == 503 and time.monotonic() < deadline
            await asyncio.sleep(0.02)


async def test_a_company_runs_at_most_two_date_jobs_at_once(monkeypatch):
    """One company cycling large versions cannot fill the 4-thread parse pool: its third
    concurrent job is refused (503, try again) without starting; another company's runs."""
    gate = threading.Event()
    started: list[int] = []
    real = doc_dates.find

    def held(*args, **kwargs):
        started.append(1)
        gate.wait(30)
        return real(*args, **kwargs)

    monkeypatch.setattr(doc_dates, "find", held)
    monkeypatch.setattr(doc_dates, "WAIT_SECONDS", 0.05)
    assert doc_dates.DATE_JOBS_PER_COMPANY == 2
    company = uuid.uuid4()
    mine = [_version(company) for _ in range(3)]
    theirs = _version()
    try:
        for v in mine[:2]:
            with pytest.raises(doc_dates.DatesUnavailable) as e:
                await doc_dates.found_for_version(v, PARTS)
            assert e.value.status_code == 503
        await until(lambda: len(started) == 2)
        with pytest.raises(doc_dates.DatesUnavailable) as e:
            await doc_dates.found_for_version(mine[2], PARTS)
        assert e.value.status_code == 503
        assert e.value.headers["Retry-After"]
        assert e.value.detail == doc_dates.DATES_BUSY
        with pytest.raises(doc_dates.DatesUnavailable):
            await doc_dates.found_for_version(theirs, PARTS)
        await until(lambda: len(started) == 3)
        await asyncio.sleep(0.1)
        assert len(started) == 3  # the refused job never started
    finally:
        gate.set()
    for v in [*mine, theirs]:
        await until_found(v)


def test_a_key_given_up_again_moves_to_the_end_of_the_list():
    kept = doc_dates._Kept()
    kept.give_up("again")
    for k in range(1023):
        kept.give_up(k)
    kept.give_up("again")
    kept.give_up("new")  # 1025 keys: the oldest goes
    assert kept.given_up("again")
    assert not kept.given_up(0)


async def test_a_failed_date_job_is_remembered_briefly(monkeypatch):
    """A job that failed (not a timeout) is not run again by every read: its error is
    served for ``FAILED_SECONDS``, then the next read tries again."""
    calls = [0]

    def broken(*args, **kwargs):
        calls[0] += 1
        raise ValueError("unreadable")

    monkeypatch.setattr(doc_dates, "find", broken)
    version = _version()
    for _ in range(3):
        with pytest.raises(ValueError, match="unreadable"):
            await doc_dates.found_for_version(version, PARTS)
    assert calls[0] == 1
    monkeypatch.setattr(doc_dates, "FAILED_SECONDS", 0.0)
    with pytest.raises(ValueError):
        await doc_dates.found_for_version(version, PARTS)
    assert calls[0] == 2


def test_after_an_empty_leading_code_block_a_date_is_in_its_own_block():
    """The one intended difference from main: an empty leading code block and the
    paragraph after it compared equal (both empty blocks at 0), so the date was read as the
    code block's (no text, no item). It is its paragraph's: its item and its text."""
    body = "```\n```\n\n[Payment](#now-payment-step) ships 2026-11-30.\n"
    (f,) = doc_dates.find([doc_dates._Part("plan", 1, "Plan", body)], ref=date(2026, 10, 20))
    assert f.owner == "payment-step"
    assert f.block == "Payment ships 2026-11-30."


async def test_approve_takes_the_document_lock_only_once_the_dates_are_found(client, monkeypatch):
    """Approving a roadmap version whose dates are still being found does not hold the
    document's row lock meanwhile (an import waits on that lock)."""
    tenant_id, auth = await seed_auth()
    url = await _slow_plan_v2(client, tenant_id, auth)
    gate = threading.Event()
    entered = threading.Event()
    real = doc_dates.find

    def held(*args, **kwargs):
        entered.set()
        gate.wait(30)
        return real(*args, **kwargs)

    monkeypatch.setattr(doc_dates, "find", held)
    approving = asyncio.create_task(client.post(f"{url}/approve", headers=auth))
    try:
        await until(entered.is_set)
        await asyncio.sleep(0.2)
        async with tenant_session(tenant_id) as s:
            # NOWAIT: an error if approve holds the row.
            await s.execute(
                select(Document.id).where(Document.slug == "slow-plan").with_for_update(nowait=True)
            )
            await s.rollback()
    finally:
        gate.set()
        resp = await approving  # its transaction ends before the test's cleanup
    assert resp.status_code in (200, 503), resp.text
    if resp.status_code == 503:  # it waited WAIT_SECONDS: the dates are kept by now
        resp = await until_approved(client, f"{url}/approve", auth)
    assert resp.status_code == 200, resp.text


async def until_approved(client, url: str, auth: dict):
    deadline = time.monotonic() + PATIENCE
    resp = await client.post(url, headers=auth)
    while resp.status_code == 503 and time.monotonic() < deadline:
        await asyncio.sleep(0.2)
        resp = await client.post(url, headers=auth)
    return resp


# --------------------------------------------------------------------------- exports: fair share

URL = "/v1/documents/checkout/versions/1/export?format=html"


class Held:
    """Exports whose render waits until ``release()`` (on the export pool's threads)."""

    def __init__(self, monkeypatch) -> None:
        self.gate = threading.Event()
        self.lock = threading.Lock()
        self.started = 0
        monkeypatch.setattr(export_router, "render_export", self)

    def __call__(self, ev, layer, fmt):
        with self.lock:
            self.started += 1
        self.gate.wait(30)
        return "<p>rendered</p>"

    def release(self) -> None:
        self.gate.set()


async def _company(client, name: str) -> uuid.UUID:
    """A company with the ``checkout`` PRD."""
    tenant = await make_tenant(name)
    await seed_company(tenant)
    resp = await _import(client, await _token(tenant, "approver"), DRAFT)
    assert resp.status_code == 201, resp.text
    return tenant


def _busy(resp, code: str) -> dict:
    body = resp.json()
    assert body["code"] == code, body
    assert body["detail"] == body["message"]
    return body


async def test_one_person_s_second_concurrent_export_is_refused_at_once(
    client,
    tenant_id,
    doc,  # noqa: F811
    monkeypatch,
):
    held = Held(monkeypatch)
    viewer = await _token(tenant_id, "viewer")
    first = asyncio.create_task(client.get(URL, headers=viewer))
    try:
        await until(lambda: held.started == 1)
        second = await client.get(URL, headers=viewer)
        assert second.status_code == 429, second.text
        body = _busy(second, "export_busy_you")
        assert body["message"] == "Your previous export is still running"
        assert held.started == 1  # refused before it rendered anything
    finally:
        held.release()
    assert (await first).status_code == 200
    # Once it is done, the same person exports again.
    assert (await client.get(URL, headers=viewer)).status_code == 200


async def _fill(client, *companies: uuid.UUID) -> list[asyncio.Task]:
    """Two exports of each company, rendering (held) or queued."""
    tasks = []
    for company in companies:
        for _ in range(2):
            headers = await _token(company, "viewer")
            tasks.append(asyncio.create_task(client.get(URL, headers=headers)))
    await until(lambda: sum(offload.in_flight(c) for c in companies) == 2 * len(companies))
    return tasks


async def test_a_company_holding_its_two_exports_leaves_two_workers_to_others(client, monkeypatch):
    """Owner decision 2026-10-20: 4 workers, 2 exports per company: whatever one company
    runs, two workers are left for the others."""
    held = Held(monkeypatch)
    a, b = await _company(client, "A Co"), await _company(client, "B Co")
    tasks = []
    try:
        tasks += await _fill(client, a)
        await until(lambda: held.started == 2)
        tasks += await _fill(client, b)
        await until(lambda: held.started == 4)  # B's two render at once, beside A's
    finally:
        held.release()
    for t in tasks:
        assert (await t).status_code == 200


async def test_a_company_runs_two_exports_and_a_third_company_is_not_starved(client, monkeypatch):
    held = Held(monkeypatch)
    a, b, c = [await _company(client, n) for n in ("A Co", "B Co", "C Co")]
    a_people = [await _token(a, "viewer") for _ in range(3)]
    b_people = [await _token(b, "viewer") for _ in range(3)]
    tasks = []
    try:
        tasks += [asyncio.create_task(client.get(URL, headers=h)) for h in a_people[:2]]
        tasks += [asyncio.create_task(client.get(URL, headers=h)) for h in b_people[:2]]
        await until(lambda: held.started == 4)
        # A and B flood: refused at once, nothing queued for them.
        for h in (a_people[2], b_people[2]):
            resp = await client.get(URL, headers=h)
            assert resp.status_code == 429, resp.text
            _busy(resp, "export_busy_you")
        assert offload.in_flight(a) == offload.in_flight(b) == 2
        # C waits behind at most two companies' share, never behind a flood.
        tasks.append(asyncio.create_task(client.get(URL, headers=await _token(c, "viewer"))))
        await until(lambda: offload.in_flight(c) == 1)
    finally:
        held.release()
    for t in tasks:
        assert (await t).status_code == 200
    assert held.started == 5


async def test_a_wait_for_a_worker_past_ten_seconds_is_busy_not_too_large(client, monkeypatch):
    held = Held(monkeypatch)
    monkeypatch.setattr(offload, "QUEUE_SECONDS", 0.2)
    a, b, c = [await _company(client, n) for n in ("A Co", "B Co", "C Co")]
    blockers = []
    try:
        blockers += await _fill(client, a, b)
        await until(lambda: held.started == 4)
        resp = await client.get(URL, headers=await _token(c, "viewer"))
        assert resp.status_code == 503, resp.text
        assert resp.headers["retry-after"]
        body = _busy(resp, "export_busy")
        assert body["message"] == "Oracle is busy with other exports. Try again in a moment."
        assert offload.in_flight(c) == 0  # refused: its place is free at once
    finally:
        held.release()
    for t in blockers:
        assert (await t).status_code == 200
    # The refused export never renders: the pool reaches it before this one (first in,
    # first out), and only this one renders.
    assert (await client.get(URL, headers=await _token(c, "viewer"))).status_code == 200
    assert held.started == 5


async def test_the_render_cap_counts_from_when_the_render_starts(client, monkeypatch):
    """Queued 1.5 s behind a full pool, then rendered at once: served, although the
    request took longer than the render cap (1 s here)."""
    held = Held(monkeypatch)
    monkeypatch.setattr(offload, "SECONDS", 1.0)
    a, b, c = [await _company(client, n) for n in ("A Co", "B Co", "C Co")]
    blockers = []
    try:
        blockers += await _fill(client, a, b)
        await until(lambda: held.started == 4)
        queued = asyncio.create_task(client.get(URL, headers=await _token(c, "viewer")))
        await asyncio.sleep(1.5)
    finally:
        held.release()
    resp = await queued
    assert resp.status_code == 200, resp.text
    for t in blockers:  # each rendered for 1.5 s: past the cap
        blocked = await t
        assert blocked.status_code == 422, blocked.text
        assert blocked.json()["detail"] == "This document is too large to export quickly"


async def test_exports_waiting_for_the_pool_hold_no_database_connection(client, monkeypatch):
    held = Held(monkeypatch)
    a, b, c = [await _company(client, n) for n in ("A Co", "B Co", "C Co")]
    reader = await _token(a, "viewer")
    tasks = []
    try:
        tasks += await _fill(client, a, b, c)  # four rendering, two queued
        await until(lambda: held.started == 4)
        await asyncio.sleep(0.1)
        assert get_engine().pool.checkedout() == 0
        other = await client.get("/v1/documents/checkout/versions/1", headers=reader)
        assert other.status_code == 200, other.text
    finally:
        held.release()
    for t in tasks:
        assert (await t).status_code == 200


async def test_present_works_while_the_person_s_own_export_runs(
    client,
    tenant_id,
    doc,  # noqa: F811
    monkeypatch,
):
    """Owner decision 2026-10-20: Present mode's deck is not counted against the export
    caps (it still renders on the export pool, within its time cap)."""
    held = Held(monkeypatch)
    viewer = await _token(tenant_id, "viewer")
    exporting = asyncio.create_task(client.get(URL, headers=viewer))
    try:
        await until(lambda: held.started == 1)
        deck = await client.get("/v1/documents/checkout/versions/1/deck", headers=viewer)
        assert deck.status_code == 200, deck.text
        assert deck.json()["slides"]
        assert offload.in_flight(tenant_id) == 1  # only the export holds a place
    finally:
        held.release()
    assert (await exporting).status_code == 200


async def test_an_export_renders_rows_no_session_holds(client, tenant_id, doc, monkeypatch):  # noqa: F811
    """The render reads copies: no row it reads is attached to the request's session (which
    ends before a render that outlives its request)."""
    attached: list[bool] = []
    real = export_router.render_export

    def spy(ev, layer, fmt):
        rows = [ev.document, ev.version, *ev.sections, *ev.all_sections, *ev.citations]
        rows += [ev.theme] if ev.theme is not None else []
        attached.extend(sa_inspect(r).session is not None for r in rows)
        return real(ev, layer, fmt)

    monkeypatch.setattr(export_router, "render_export", spy)
    viewer = await _token(tenant_id, "viewer")
    resp = await client.get(URL, headers=viewer)
    assert resp.status_code == 200, resp.text
    assert attached and not any(attached)
