"""Live Fireflies tools (#710 lane 1): /v1/live/sources and /v1/live/fireflies/...

Driven over the ASGI app against a fake archive MCP server and a fake Fireflies GraphQL
(httpx mock transports, tests/live_fakes.py): invented meetings, no network. Each test's
card is in its docstring (protects / fails_when / no_claim).
"""

import json
import logging
import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from oracle.live import budget
from oracle.live import fireflies as live_ff
from oracle.live.models import LiveRead
from sqlalchemy import select

from oracle import crypto
from oracle.auth.service import create_api_token
from oracle.config import get_settings
from oracle.connections.models import Connection
from oracle.sources import fireflies_browse
from oracle.sources.models import BrowseCall
from oracle.tenancy import tenant_session
from tests.connection_helpers import clear_provider_http, use_provider_http
from tests.live_fakes import (
    ARCHIVE_ENDPOINT,
    ARCHIVE_MCP,
    ARCHIVE_TOTAL,
    GRAPHQL_URL,
    LIVE_KEY,
    Both,
    FakeArchive,
    FakeGraphQL,
)
from tests.sources_helpers import client_for, make_user

LIVE_TOOLS = [
    "live_fireflies_list_meetings",
    "live_fireflies_search",
    "live_fireflies_get_meeting",
    "live_fireflies_get_lines",
]
NO_CONNECTION = "You have no Fireflies connection. Connect one in Settings > Connections."


@pytest.fixture
def archive():
    return FakeArchive()


@pytest.fixture
def graphql():
    return FakeGraphQL()


@pytest.fixture(autouse=True)
def fakes(archive, graphql):
    use_provider_http(Both(archive, graphql))
    budget.reset()
    fireflies_browse.reset_limits()
    yield
    clear_provider_http()
    budget.reset()
    fireflies_browse.reset_limits()


@pytest.fixture
async def alice(tenant_id):
    return await make_user(tenant_id, "alice@example.com")


@pytest.fixture
async def bob(tenant_id):
    return await make_user(tenant_id, "bob@example.com")


async def add_fireflies(
    tenant_id,
    user,
    endpoint: str | None = ARCHIVE_ENDPOINT,
    label: str | None = "Fireflies Archive",
    status: str = "active",
) -> uuid.UUID:
    async with tenant_session(tenant_id) as s:
        conn = Connection(
            user_id=user.id,
            provider="fireflies",
            auth_mode="token",
            account_id=f"ff-{uuid.uuid4().hex[:8]}",
            account_label=label,
            ciphertext=crypto.encrypt(json.dumps({"access_token": LIVE_KEY}).encode()),
            key_version=crypto.KEY_VERSION,
            endpoint_url=endpoint,
            status=status,
        )
        s.add(conn)
        await s.commit()
        return conn.id


@pytest.fixture
async def arc(tenant_id, alice):
    """Alice's connection to the archive (an MCP host)."""
    return await add_fireflies(tenant_id, alice)


@pytest.fixture
async def ffa(tenant_id, alice):
    """Alice's connection to Fireflies' own API (GraphQL), with no label."""
    return await add_fireflies(tenant_id, alice, endpoint=None, label=None)


def at(seconds: float):
    """budget's clock, ``seconds`` from a fixed instant."""
    base = datetime(2026, 10, 26, 12, 0, tzinfo=UTC)
    return base + timedelta(seconds=seconds)


async def reads(tenant_id) -> list[LiveRead]:
    async with tenant_session(tenant_id) as s:
        return list((await s.scalars(select(LiveRead).order_by(LiveRead.read_at))).all())


# --- shapes and limits -----------------------------------------------------------------


async def test_sources_lists_the_callers_active_fireflies_connections(
    tenant_id, alice, bob, arc, ffa
):
    """protects=live_sources answers the caller's own active Fireflies connections with
    their label and the four live tools; fails_when=another person's, a non-active or a
    non-Fireflies connection is listed, or a field is missing; no_claim=the tools' answers."""
    await add_fireflies(tenant_id, alice, label="Old", status="expired")
    async with client_for(alice) as a:
        resp = await a.get("/v1/live/sources")
    assert resp.status_code == 200, resp.text
    got = {row["connection_id"]: row for row in resp.json()}
    assert set(got) == {str(arc), str(ffa)}
    assert got[str(arc)] == {
        "connection_id": str(arc),
        "provider": "fireflies",
        "label": "Fireflies Archive",
        "tools": LIVE_TOOLS,
    }
    assert got[str(ffa)]["label"] == "Fireflies"
    async with client_for(bob) as b:
        assert (await b.get("/v1/live/sources")).json() == []


async def test_list_meetings_on_the_archive(alice, arc, archive):
    """protects=list_meetings calls the archive's MCP list_meetings with the default limit
    20 and answers {total, meetings[{id,title,date,duration_s,participants}], cite};
    fails_when=the shape, the default, the arguments or the cite differ; no_claim=GraphQL."""
    async with client_for(alice) as a:
        resp = await a.get(
            f"/v1/live/fireflies/{arc}/meetings",
            params={"date_from": "2026-10-01", "series": "pricing"},
        )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total"] == ARCHIVE_TOTAL
    assert [m["id"] for m in body["meetings"]] == ["m-104", "m-103"]
    assert body["meetings"][0] == {
        "id": "m-104",
        "title": "Pricing sync",
        "date": "2026-10-15T16:00:00Z",
        "duration_s": 2700,
        "participants": ["ada@example.com", "omar@example.com"],
    }
    assert archive.calls == [
        (
            "list_meetings",
            {"date_from": "2026-10-01", "series": "pricing", "limit": 20, "offset": 0},
        )
    ]
    cite = body["cite"]
    assert cite["ref"] == "l:1"
    assert cite["source"] == "Fireflies Archive"
    assert cite["call"] == "list_meetings"
    assert cite["connection_id"] == str(arc)
    assert cite.get("item_id") is None
    datetime.fromisoformat(cite["read_at"])


async def test_count_is_total_with_limit_one(alice, arc, ffa, archive, graphql):
    """protects=the count is total with limit=1 on both backends (4,321 from the archive,
    user.num_transcripts from GraphQL) and only one meeting is read; fails_when=total is
    the page length or limit=1 reads more; no_claim=the reply's wording of the count."""
    async with client_for(alice) as a:
        one = (await a.get(f"/v1/live/fireflies/{arc}/meetings", params={"limit": 1})).json()
        two = (await a.get(f"/v1/live/fireflies/{ffa}/meetings", params={"limit": 1})).json()
    assert one["total"] == 4321 and len(one["meetings"]) == 1
    assert archive.calls[-1] == ("list_meetings", {"limit": 1, "offset": 0})
    assert two["total"] == 37 and len(two["meetings"]) == 1
    assert len(graphql.bodies) == 1
    assert graphql.bodies[0]["variables"]["limit"] == 1
    assert "num_transcripts" in graphql.bodies[0]["query"]


async def test_graphql_count_refused_answers_total_null(alice, ffa, graphql):
    """protects=a plan that refuses user.num_transcripts answers total null and says the
    count is not offered, with the meetings still listed; fails_when=it answers an error,
    a made-up count, or no note; no_claim=other GraphQL errors (see the errors tests)."""
    graphql.refuse_count = True
    async with client_for(alice) as a:
        resp = await a.get(f"/v1/live/fireflies/{ffa}/meetings", params={"limit": 2})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total"] is None
    assert body["note"] == "Fireflies does not offer the meeting count on this plan."
    assert [m["id"] for m in body["meetings"]] == ["m-105", "m-104"]
    assert body["meetings"][0]["duration_s"] == 1800


async def test_graphql_pages_a_limit_over_fifty(alice, ffa, graphql):
    """protects=GraphQL transcripts are asked at most 50 at a time (limit 120 reads 3
    pages with skip); fails_when=one query asks more than 50 or skip is wrong;
    no_claim=the archive (it takes the limit as is)."""
    graphql.meetings = [
        {**graphql.meetings[0], "id": f"g-{i:03}", "date": f"2026-0{1 + i // 31 % 9}-01T00:00:00Z"}
        for i in range(130)
    ]
    async with client_for(alice) as a:
        resp = await a.get(f"/v1/live/fireflies/{ffa}/meetings", params={"limit": 120})
    assert resp.status_code == 200, resp.text
    assert len(resp.json()["meetings"]) == 120
    pages = [(b["variables"]["skip"], b["variables"]["limit"]) for b in graphql.bodies]
    assert pages == [(0, 50), (50, 50), (100, 20)]


@pytest.mark.parametrize(
    ("endpoint", "backend", "url"),
    [
        (None, "graphql", GRAPHQL_URL),
        ("https://api.fireflies.ai/graphql", "graphql", GRAPHQL_URL),
        (ARCHIVE_ENDPOINT, "mcp", ARCHIVE_MCP),
        ("https://ff.example.org:8443/v2/graphql", "mcp", "https://ff.example.org:8443/mcp"),
    ],
)
def test_backend_by_host(endpoint, backend, url):
    """protects=api.fireflies.ai (or no endpoint) uses GraphQL; any other host uses that
    host's /mcp; fails_when=the path of the endpoint is kept, the port dropped, or a
    non-Fireflies host goes to GraphQL; no_claim=the calls themselves."""
    assert live_ff.backend_for(endpoint) == (backend, url)


async def test_backend_choice_reaches_the_right_host(alice, arc, ffa, archive, graphql):
    """protects=a call through each connection reaches only its own backend, with the
    stored key as a bearer and the 10 s timeout; fails_when=the archive connection calls
    GraphQL or the other way round, or the timeout is not 10 s; no_claim=answer shapes."""
    async with client_for(alice) as a:
        assert (await a.get(f"/v1/live/fireflies/{arc}/meetings")).status_code == 200
        assert graphql.requests == []
        assert (await a.get(f"/v1/live/fireflies/{ffa}/meetings")).status_code == 200
    assert {str(r.url) for r in archive.requests} == {ARCHIVE_MCP}
    assert {str(r.url) for r in graphql.requests} == {GRAPHQL_URL}
    for r in archive.requests + graphql.requests:
        assert r.headers["Authorization"] == f"Bearer {LIVE_KEY}"
        assert r.extensions["timeout"]["read"] == 10


async def test_archive_answers_as_server_sent_events(alice, arc, archive):
    """protects=a streamable HTTP server answering text/event-stream is read; fails_when=
    only JSON bodies are understood; no_claim=sessions over several tool calls."""
    archive.sse = True
    async with client_for(alice) as a:
        resp = await a.get(f"/v1/live/fireflies/{arc}/meetings", params={"limit": 1})
    assert resp.status_code == 200, resp.text
    assert resp.json()["total"] == ARCHIVE_TOTAL


async def test_search_on_both_backends(alice, arc, ffa, archive, graphql):
    """protects=search answers {total, matches[{id,title,date,snippet}], cite} with the
    default limit 10, people[] passed to the archive and applied to GraphQL results;
    fails_when=the shape, default or filters differ; no_claim=ranking."""
    async with client_for(alice) as a:
        resp = await a.get(
            f"/v1/live/fireflies/{arc}/search",
            params={"q": "pricing", "people": ["omar@example.com"]},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["total"] == 2
        assert body["matches"][0] == {
            "id": "m-104",
            "title": "Pricing sync",
            "date": "2026-10-15T16:00:00Z",
            "snippet": "Tier names stay; the trial grows to 21 days.",
        }
        assert body["cite"]["call"] == "search"
        assert archive.calls[-1] == (
            "search_meetings",
            {"q": "pricing", "people": ["omar@example.com"], "limit": 10, "offset": 0},
        )
        resp = await a.get(
            f"/v1/live/fireflies/{ffa}/search",
            params={"q": "harbor", "people": ["lin@example.com"]},
        )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [m["id"] for m in body["matches"]] == ["m-105"]
    assert body["matches"][0]["snippet"].startswith("The harbor launch")
    assert graphql.bodies[-1]["variables"]["keyword"] == "harbor"
    assert body["cite"]["source"] == "Fireflies"


async def test_get_meeting_summary_and_all(alice, arc, ffa):
    """protects=get_meeting answers summary only by default and lines up to max_lines with
    truncated when cut, cite.item_id the meeting, on both backends; fails_when=lines leak
    into part=summary, max_lines is ignored or truncated is wrong; no_claim=get_lines."""
    async with client_for(alice) as a:
        for conn in (arc, ffa):
            summary = await a.get(f"/v1/live/fireflies/{conn}/meetings/m-105")
            assert summary.status_code == 200, summary.text
            s = summary.json()
            assert s["id"] == "m-105" and s["title"] == "Harbor launch retro"
            assert s["duration_s"] == 1800
            assert s["participants"] == ["ada@example.com", "lin@example.com"]
            assert s["summary"].startswith("The harbor launch went out")
            assert s.get("lines") is None and s["truncated"] is False
            assert s["cite"]["call"] == "get_meeting" and s["cite"]["item_id"] == "m-105"
            full = (
                await a.get(
                    f"/v1/live/fireflies/{conn}/meetings/m-105",
                    params={"part": "all", "max_lines": 2},
                )
            ).json()
            assert full["lines"] == [
                {"speaker": "Ada", "start_ms": 0, "text": "Welcome to the harbor retro."},
                {"speaker": "Lin", "start_ms": 4000, "text": "We shipped a day late."},
            ]
            assert full["truncated"] is True


async def test_get_lines_by_offset_and_by_time(alice, arc, ffa):
    """protects=get_lines pages by offset/limit with next_offset, or by start_ms/end_ms,
    on both backends; fails_when=next_offset is wrong or the window is not applied;
    no_claim=get_meeting."""
    async with client_for(alice) as a:
        for conn in (arc, ffa):
            page = (
                await a.get(f"/v1/live/fireflies/{conn}/meetings/m-105/lines", params={"limit": 3})
            ).json()
            assert [x["start_ms"] for x in page["lines"]] == [0, 4000, 9000]
            assert page["next_offset"] == 3
            assert page["cite"]["call"] == "get_lines" and page["cite"]["item_id"] == "m-105"
            last = (
                await a.get(f"/v1/live/fireflies/{conn}/meetings/m-105/lines", params={"offset": 3})
            ).json()
            assert [x["text"] for x in last["lines"]] == ["Agreed, I will add it."]
            assert last["next_offset"] is None
            window = (
                await a.get(
                    f"/v1/live/fireflies/{conn}/meetings/m-105/lines",
                    params={"start_ms": 3000, "end_ms": 10000},
                )
            ).json()
            assert [x["start_ms"] for x in window["lines"]] == [4000, 9000]


@pytest.mark.parametrize(
    ("path", "params"),
    [
        ("meetings", {"limit": 0}),
        ("meetings", {"limit": 201}),
        ("meetings", {"offset": -1}),
        ("search", {}),
        ("search", {"q": ""}),
        ("search", {"q": "x" * 201}),
        ("search", {"q": "ok", "limit": 51}),
        ("meetings/m-105", {"part": "lines"}),
        ("meetings/m-105", {"max_lines": 0}),
        ("meetings/m-105", {"max_lines": 2001}),
        ("meetings/m-105/lines", {"limit": 501}),
        ("meetings/m-105/lines", {"limit": 0}),
        ("meetings/m-105/lines", {"offset": 1, "start_ms": 0}),
    ],
)
async def test_query_limits(alice, arc, archive, path, params):
    """protects=every query limit of the spec (limit 1..200 / 1..50 / 1..500, q 1..200,
    max_lines 1..2000, part summary|all, offset with a time window) answers 422 before any
    call; fails_when=an out-of-range value reaches the source; no_claim=in-range values."""
    async with client_for(alice) as a:
        resp = await a.get(f"/v1/live/fireflies/{arc}/{path}", params=params)
    assert resp.status_code == 422, resp.text
    assert archive.calls == []


async def test_limits_at_their_edges_are_accepted(alice, arc, archive):
    """protects=the largest allowed values pass through unchanged; fails_when=an edge value
    is refused or clamped; no_claim=the sources' own caps."""
    async with client_for(alice) as a:
        assert (
            await a.get(f"/v1/live/fireflies/{arc}/meetings", params={"limit": 200})
        ).status_code == 200
        assert (
            await a.get(f"/v1/live/fireflies/{arc}/search", params={"q": "x" * 200, "limit": 50})
        ).status_code == 200
        r = await a.get(
            f"/v1/live/fireflies/{arc}/meetings/m-105", params={"part": "all", "max_lines": 2000}
        )
        assert r.status_code == 200
        assert (
            await a.get(f"/v1/live/fireflies/{arc}/meetings/m-105/lines", params={"limit": 500})
        ).status_code == 200
    limits = [args.get("limit") or args.get("max_lines") for _, args in archive.calls]
    assert limits == [200, 50, 2000, 500]  # fmt: skip


# --- errors ----------------------------------------------------------------------------


@pytest.mark.parametrize("code", [401, 403])
@pytest.mark.parametrize("backend", ["archive", "graphql"])
async def test_refused_key_is_424_and_needs_reconnect(
    tenant_id, alice, arc, ffa, archive, graphql, code, backend
):
    """protects=a 401/403 from the source answers 424 with the reconnect sentence and sets
    the connection to the state sync sets (expired: Settings offers Reconnect), so it
    leaves live_sources; fails_when=another status or sentence, or the connection stays
    active; no_claim=the Settings screen."""
    fake, conn, label = (
        (archive, arc, "Fireflies Archive") if backend == "archive" else (graphql, ffa, "Fireflies")
    )
    fake.status = code
    async with client_for(alice) as a:
        resp = await a.get(f"/v1/live/fireflies/{conn}/meetings")
        assert resp.status_code == 424, resp.text
        assert resp.json()["detail"] == (
            f"{label} refused your key (it may have been revoked or expired). "
            "Reconnect it in Settings > Connections."
        )
        listed = {row["connection_id"] for row in (await a.get("/v1/live/sources")).json()}
    async with tenant_session(tenant_id) as s:
        row = await s.get(Connection, conn)
        assert row.status == "expired"
        assert LIVE_KEY not in (row.last_error or "")
    assert str(conn) not in listed
    async with client_for(alice) as a:
        again = await a.get(f"/v1/live/fireflies/{conn}/meetings", params={"limit": 2})
    assert again.status_code == 424


@pytest.mark.parametrize("backend", ["archive", "graphql"])
async def test_source_rate_limit_is_429_with_its_wait(alice, arc, ffa, archive, graphql, backend):
    """protects=the source's 429 answers 429 "<label> is limiting requests; try again in
    <N> seconds." with N from Retry-After (and the header passed on); fails_when=the wait
    or the sentence differ; no_claim=Oracle's own budget (see the budget tests)."""
    fake, conn, label = (
        (archive, arc, "Fireflies Archive") if backend == "archive" else (graphql, ffa, "Fireflies")
    )
    fake.status, fake.headers = 429, {"Retry-After": "37"}
    async with client_for(alice) as a:
        resp = await a.get(f"/v1/live/fireflies/{conn}/meetings")
    assert resp.status_code == 429
    assert resp.json()["detail"] == f"{label} is limiting requests; try again in 37 seconds."
    assert resp.headers["Retry-After"] == "37"


@pytest.mark.parametrize(
    ("status", "error", "reason"),
    [
        (503, None, "HTTP 503"),
        (500, None, "HTTP 500"),
        (None, httpx.ReadTimeout("slow"), "no answer within 10 seconds"),
        (None, httpx.ConnectError("refused"), "could not be reached"),
    ],
)
@pytest.mark.parametrize("backend", ["archive", "graphql"])
async def test_source_down_is_502(
    alice, arc, ffa, archive, graphql, backend, status, error, reason
):
    """protects=a 5xx, a timeout (10 s) or an unreachable source answers 502 "<label> did
    not answer (<reason>). Synced data is still available; try again later.";
    fails_when=another status, or the source's own text in the detail; no_claim=retries."""
    fake, conn, label = (
        (archive, arc, "Fireflies Archive") if backend == "archive" else (graphql, ffa, "Fireflies")
    )
    fake.status, fake.raise_error = status, error
    async with client_for(alice) as a:
        resp = await a.get(f"/v1/live/fireflies/{conn}/meetings")
    assert resp.status_code == 502
    assert resp.json()["detail"] == (
        f"{label} did not answer ({reason}). Synced data is still available; try again later."
    )


@pytest.mark.parametrize("route", ["meetings/m-999", "meetings/m-999/lines"])
@pytest.mark.parametrize("backend", ["archive", "graphql"])
async def test_meeting_not_found_is_404(alice, arc, ffa, backend, route):
    """protects=an unknown meeting answers 404 "No meeting <id> in <label>." on both
    backends; fails_when=it answers 502, 200 or another sentence; no_claim=known ids."""
    conn, label = (arc, "Fireflies Archive") if backend == "archive" else (ffa, "Fireflies")
    async with client_for(alice) as a:
        resp = await a.get(f"/v1/live/fireflies/{conn}/{route}")
    assert resp.status_code == 404
    assert resp.json()["detail"] == f"No meeting m-999 in {label}."


@pytest.mark.parametrize(
    "route", ["meetings", "search?q=pricing", "meetings/m-105", "meetings/m-105/lines"]
)
async def test_another_persons_connection_is_404(tenant_id, alice, bob, arc, archive, route):
    """protects=owner-only: Bob reaching Alice's connection, a connection that does not
    exist, or his own non-Fireflies connection answers 404 "You have no Fireflies
    connection..." and nothing reaches the source; fails_when=Bob reads Alice's meetings
    or the sentence differs; no_claim=MCP (see the MCP test)."""
    async with tenant_session(tenant_id) as s:
        github = Connection(
            user_id=bob.id, provider="github", auth_mode="token", account_id="gh-1",
            ciphertext=crypto.encrypt(b"{}"), key_version=crypto.KEY_VERSION,
        )  # fmt: skip
        s.add(github)
        await s.commit()
        github_id = github.id
    async with client_for(bob) as b:
        for conn in (arc, uuid.uuid4(), github_id):
            resp = await b.get(f"/v1/live/fireflies/{conn}/{route}")
            assert resp.status_code == 404, resp.text
            assert resp.json()["detail"] == NO_CONNECTION
    assert archive.requests == []


# --- budget and cache ------------------------------------------------------------------


async def test_fireflies_ai_budget_is_ten_a_minute_and_shared_with_the_picker(
    tenant_id, alice, ffa, graphql, monkeypatch
):
    """protects=on api.fireflies.ai live calls are counted in browse_calls (kind 'live')
    against the picker's 10 a minute, shared with the picker's own calls, then 429 "Live
    reads of <label> are at this connection's limit of 10 a minute; try again in <later>."
    with Retry-After; fails_when=the limit, the sentence, the kind or the sharing differ;
    no_claim=the per-reply cap (lane 2)."""
    now = {"t": at(0)}
    monkeypatch.setattr(budget, "_now", lambda: now["t"])
    monkeypatch.setattr(fireflies_browse, "_now", lambda: now["t"])
    async with client_for(alice) as a:
        for i in range(9):
            r = await a.get(f"/v1/live/fireflies/{ffa}/meetings", params={"offset": i, "limit": 1})
            assert r.status_code == 200, r.text
        picker = await a.get(f"/v1/connections/{ffa}/fireflies/meetings")
        assert picker.status_code == 200, picker.text
        now["t"] = at(20)
        refused = await a.get(f"/v1/live/fireflies/{ffa}/meetings", params={"offset": 99})
    assert refused.status_code == 429
    assert refused.json()["detail"] == (
        "Live reads of Fireflies are at this connection's limit of 10 a minute; "
        "try again in 40 seconds."
    )
    assert refused.headers["Retry-After"] == "40"
    async with tenant_session(tenant_id) as s:
        kinds = (await s.execute(select(BrowseCall.kind, BrowseCall.calls))).all()
    assert sorted(k for k, _ in kinds) == ["browse"] + ["live"] * 9


async def test_fireflies_ai_budget_is_25_a_day(alice, ffa, monkeypatch):
    """protects=api.fireflies.ai allows 25 live calls a day; fails_when=the 26th is made
    or the sentence differs; no_claim=the minute window (its own test)."""
    now = {"t": at(0)}
    monkeypatch.setattr(budget, "_now", lambda: now["t"])
    async with client_for(alice) as a:
        for i in range(25):
            now["t"] = at(61 * (i // 10))
            r = await a.get(f"/v1/live/fireflies/{ffa}/meetings", params={"offset": i, "limit": 1})
            assert r.status_code == 200, (i, r.text)
        now["t"] = at(3600)
        refused = await a.get(f"/v1/live/fireflies/{ffa}/meetings", params={"offset": 99})
    assert refused.status_code == 429
    detail = refused.json()["detail"]
    assert detail.startswith(
        "Live reads of Fireflies are at this connection's limit of 25 a day; try again in "
    )
    assert detail.endswith(" hours.")


async def test_other_host_budget_is_120_a_minute_and_3000_a_day(
    tenant_id, alice, arc, archive, monkeypatch
):
    """protects=another host allows 120 live calls a minute and 3,000 a day, counted on
    kind 'live' only (picker rows do not spend it); fails_when=a limit differs, picker
    calls count against it, or the sentence differs; no_claim=the archive's own limit."""
    now = {"t": at(0)}
    monkeypatch.setattr(budget, "_now", lambda: now["t"])
    async with tenant_session(tenant_id) as s:
        s.add(BrowseCall(connection_id=arc, at=at(-5), calls=60, kind="browse"))
        await s.commit()
    async with client_for(alice) as a:
        for i in range(120):
            r = await a.get(f"/v1/live/fireflies/{arc}/meetings", params={"offset": i, "limit": 1})
            assert r.status_code == 200, (i, r.text)
        refused = await a.get(f"/v1/live/fireflies/{arc}/meetings", params={"offset": 999})
        assert refused.status_code == 429
        assert refused.json()["detail"] == (
            "Live reads of Fireflies Archive are at this connection's limit of 120 a minute; "
            "try again in 60 seconds."
        )
        async with tenant_session(tenant_id) as s:
            s.add(BrowseCall(connection_id=arc, at=at(-3600), calls=2880, kind="live"))
            await s.commit()
        now["t"] = at(120)
        assert (
            await a.get(f"/v1/live/fireflies/{arc}/meetings", params={"offset": 1000})
        ).status_code == 429
        day = (await a.get(f"/v1/live/fireflies/{arc}/meetings", params={"offset": 1001})).json()
    assert day["detail"].startswith(
        "Live reads of Fireflies Archive are at this connection's limit of 3,000 a day; "
        "try again in "
    )


async def test_cache_answers_free_and_keeps_read_at(tenant_id, alice, arc, archive, monkeypatch):
    """protects=the same (connection, tool, args) within 60 s is answered from the cache:
    no source call, no budget spent, the original read_at, a 'cached' live_reads row; after
    60 s it reads again; fails_when=the cache calls the source, spends, or restamps
    read_at; no_claim=cache sharing across API processes (it is per process)."""
    clock = {"t": 1000.0}
    monkeypatch.setattr(budget, "_clock", lambda: clock["t"])
    async with client_for(alice) as a:
        first = (await a.get(f"/v1/live/fireflies/{arc}/meetings", params={"limit": 2})).json()
        clock["t"] += 59
        second = (await a.get(f"/v1/live/fireflies/{arc}/meetings", params={"limit": 2})).json()
        other = (await a.get(f"/v1/live/fireflies/{arc}/meetings", params={"limit": 3})).json()
        clock["t"] += 2
        third = (await a.get(f"/v1/live/fireflies/{arc}/meetings", params={"limit": 2})).json()
    assert second == first
    assert second["cite"]["read_at"] == first["cite"]["read_at"]
    assert other["cite"]["read_at"] != first["cite"]["read_at"]
    assert third["cite"]["read_at"] != first["cite"]["read_at"]
    assert [c[1]["limit"] for c in archive.calls] == [2, 3, 2]
    async with tenant_session(tenant_id) as s:
        spent = (await s.execute(select(BrowseCall.calls))).scalars().all()
    assert sum(spent) == 3
    assert [r.status for r in await reads(tenant_id)] == ["ok", "cached", "ok", "ok"]


# --- live_reads, the key, the switch ---------------------------------------------------


async def test_live_reads_rows_hold_no_text(tenant_id, alice, arc, archive):
    """protects=each call writes a live_reads row (user, connection, tool, ref_n 1, item
    id, status ok/error) holding no source text, no query text and no key; fails_when=a
    row is missing, or a title, a query, a line or the key is stored; no_claim=reply
    numbering of ref_n (lane 2)."""
    async with client_for(alice) as a:
        await a.get(f"/v1/live/fireflies/{arc}/search", params={"q": "juniper setup"})
        await a.get(f"/v1/live/fireflies/{arc}/meetings/m-105", params={"part": "all"})
        await a.get(f"/v1/live/fireflies/{arc}/meetings/m-999")
    rows = await reads(tenant_id)
    assert [(r.tool, r.item_id, r.status, r.ref_n) for r in rows] == [
        ("search", None, "ok", 1),
        ("get_meeting", "m-105", "ok", 1),
        ("get_meeting", "m-999", "error", 1),
    ]
    assert {r.user_id for r in rows} == {alice.id}
    assert {r.connection_id for r in rows} == {arc}
    assert all(r.message_id is None for r in rows)
    stored = " ".join(repr(vars(r)) for r in rows)
    for text in ("juniper", "harbor", "Harbor", "dry run", LIVE_KEY):
        assert text not in stored


async def test_the_key_appears_in_no_answer_log_or_row(
    tenant_id, alice, arc, ffa, archive, graphql, caplog
):
    """protects=the stored key never leaves the API: not in any answer (successes and every
    error), any log line, or live_reads; fails_when=it shows up in any of them;
    no_claim=the reply run's argv/env (lane 2)."""
    caplog.set_level(logging.DEBUG)
    texts = []
    async with client_for(alice) as a:
        for conn in (arc, ffa):
            for path in (
                "meetings",
                "search?q=sync",
                "meetings/m-105?part=all",
                "meetings/m-105/lines",
            ):
                texts.append((await a.get(f"/v1/live/fireflies/{conn}/{path}")).text)
            texts.append((await a.get(f"/v1/live/fireflies/{conn}/meetings/m-999")).text)
        texts.append((await a.get("/v1/live/sources")).text)
        archive.status = graphql.status = 503
        texts.append((await a.get(f"/v1/live/fireflies/{arc}/meetings?limit=5")).text)
        texts.append((await a.get(f"/v1/live/fireflies/{ffa}/meetings?limit=5")).text)
        archive.status = graphql.status = 401
        texts.append((await a.get(f"/v1/live/fireflies/{arc}/meetings?limit=6")).text)
        texts.append((await a.get(f"/v1/live/fireflies/{ffa}/meetings?limit=6")).text)
    assert len(texts) == 15
    for text in texts:
        assert LIVE_KEY not in text
    assert LIVE_KEY not in caplog.text
    assert LIVE_KEY not in " ".join(repr(vars(r)) for r in await reads(tenant_id))


@pytest.fixture
def live_off():
    import os

    os.environ["ORACLE_LIVE_READS"] = "off"
    get_settings.cache_clear()
    yield
    del os.environ["ORACLE_LIVE_READS"]
    get_settings.cache_clear()


@pytest.mark.parametrize(
    "path",
    ["sources", "fireflies/{c}/meetings", "fireflies/{c}/search?q=x",
     "fireflies/{c}/meetings/m-105", "fireflies/{c}/meetings/m-105/lines"],
)  # fmt: skip
async def test_off_switch_answers_503(alice, arc, archive, live_off, path):
    """protects=ORACLE_LIVE_READS=off turns every /v1/live route to 503 "Live reads are
    turned off." with no source call; fails_when=a route still reads; no_claim=replies
    (lane 2 gives them no MCP server)."""
    async with client_for(alice) as a:
        resp = await a.get("/v1/live/" + path.format(c=arc))
    assert resp.status_code == 503
    assert resp.json()["detail"] == "Live reads are turned off."
    assert archive.requests == []


# --- MCP -------------------------------------------------------------------------------


async def test_live_tools_on_mcp_and_owner_only(tenant_id, alice, bob, arc):
    """protects=the live routes are MCP tools by operationId for a user caller, they read
    the caller's own connection, and Bob's call on Alice's connection answers the 404
    sentence; fails_when=a tool is missing from tools/list, or Bob reads Alice's meetings
    over MCP; no_claim=olt_ tokens and their tools/list (lane 2)."""
    from tests.test_mcp import mcp_client

    async with tenant_session(tenant_id) as s:
        _, alice_token = await create_api_token(s, "alice-mcp", user_id=alice.id)
        _, bob_token = await create_api_token(s, "bob-mcp", user_id=bob.id)
        await s.commit()
    async with mcp_client(alice_token) as c:
        names = {t.name for t in (await c.list_tools()).tools}
        assert {"live_sources", *LIVE_TOOLS} <= names
        mine = await c.call_tool(
            "live_fireflies_list_meetings", {"connection_id": str(arc), "limit": 1}
        )
        assert not mine.is_error, mine
        assert '"total": 4321' in mine.content[0].text
    async with mcp_client(bob_token) as c:
        theirs = await c.call_tool(
            "live_fireflies_get_meeting", {"connection_id": str(arc), "meeting_id": "m-105"}
        )
    assert theirs.is_error
    assert "HTTP 404" in theirs.content[0].text
    assert NO_CONNECTION in theirs.content[0].text
    assert "Harbor" not in theirs.content[0].text
