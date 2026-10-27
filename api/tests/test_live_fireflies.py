"""Live Ask lane 1 (#710): the /v1/live Fireflies tools, both backends, limits, errors.

The sources are fakes (tests/live_fakes.py, invented meetings): a Fireflies Archive's MCP
endpoint implementing amendment A's table, and Fireflies' own GraphQL (amendment B), both
behind the API's Fireflies HTTP client (an httpx mock transport).

Card (file): protects=spec #710 section 1, the live_reads table, ORACLE_LIVE_READS=off,
owner only, amendments A, B, C2, C4, C5, C7; fails_when=a route's shape, limit, backend,
budget, cache or error sentence drifts from the spec; no_claim=live tokens, the MCP scope,
reply wiring and citations in replies (lanes 2 and 3).
"""

import logging
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta

import httpx2
import pytest
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from sqlalchemy import select, text, update

from oracle.auth.service import create_api_token
from oracle.config import get_settings
from oracle.connections.models import Connection
from oracle.live import fireflies as fireflies_live
from oracle.main import app
from oracle.sources.models import BrowseCall
from oracle.tenancy import tenant_session
from tests.connection_helpers import clear_provider_http, use_provider_http
from tests.live_fakes import (
    ARCHIVE_ENDPOINT,
    ARCHIVE_TOTAL,
    LIVE_KEY,
    FakeSources,
    ms,
)
from tests.sources_helpers import client_for, make_connection, make_user

LABEL = "Fireflies Archive"
NO_CONNECTION = "You have no Fireflies connection. Connect one in Settings > Connections."
LIVE_TOOLS = {
    "live_sources",
    "live_fireflies_list_meetings",
    "live_fireflies_search",
    "live_fireflies_get_meeting",
    "live_fireflies_get_lines",
}


@pytest.fixture
def sources():
    from oracle.live import router as live_router

    fake = FakeSources()
    use_provider_http(fake)
    live_router.reset_cache()
    yield fake
    clear_provider_http()
    live_router.reset_cache()


@pytest.fixture
async def alice(tenant_id):
    return await make_user(tenant_id, "alice@example.com")


@pytest.fixture
async def bob(tenant_id):
    return await make_user(tenant_id, "bob@example.com")


async def _fireflies(tenant_id, user, endpoint: str | None, label: str = LABEL) -> uuid.UUID:
    conn_id = await make_connection(
        tenant_id, user, "fireflies", credential={"access_token": LIVE_KEY}
    )
    async with tenant_session(tenant_id) as s:
        await s.execute(
            update(Connection)
            .where(Connection.id == conn_id)
            .values(endpoint_url=endpoint, account_label=label)
        )
        await s.commit()
    return conn_id


@pytest.fixture
async def archive(tenant_id, alice):
    """Alice's connection to a Fireflies-compatible archive (another host: MCP)."""
    return await _fireflies(tenant_id, alice, ARCHIVE_ENDPOINT)


@pytest.fixture
async def graphql(tenant_id, alice):
    """Alice's connection to Fireflies' own API (no endpoint set: api.fireflies.ai)."""
    return await _fireflies(tenant_id, alice, None, label="Fireflies")


async def _reads(tenant_id) -> list[dict]:
    async with tenant_session(tenant_id) as s:
        rows = (await s.execute(text("SELECT * FROM live_reads ORDER BY read_at, id"))).mappings()
        return [dict(r) for r in rows]


async def _conn(tenant_id, conn_id) -> Connection:
    async with tenant_session(tenant_id) as s:
        return await s.get(Connection, conn_id)


# --- live_sources ---------------------------------------------------------------------


# protects=live_sources lists the caller's own active Fireflies connections with their
# tools and no cite; fails_when=another person's, an inactive or a non-live provider's
# connection is listed, or the tool names drift; no_claim=what the reply prompt does.
async def test_live_sources_lists_own_active_fireflies_connections(
    sources, tenant_id, alice, bob, archive
):
    await _fireflies(tenant_id, bob, ARCHIVE_ENDPOINT, label="Bob's archive")
    expired = await _fireflies(tenant_id, alice, ARCHIVE_ENDPOINT, label="Old")
    async with tenant_session(tenant_id) as s:
        await s.execute(update(Connection).where(Connection.id == expired).values(status="expired"))
        await s.commit()
    await make_connection(tenant_id, alice, "slack")
    async with client_for(alice) as a:
        resp = await a.get("/v1/live/sources")
    assert resp.status_code == 200, resp.text
    assert resp.json() == [
        {
            "connection_id": str(archive),
            "provider": "fireflies",
            "label": LABEL,
            "tools": [
                "live_fireflies_list_meetings",
                "live_fireflies_search",
                "live_fireflies_get_meeting",
                "live_fireflies_get_lines",
            ],
        }
    ]
    assert "cite" not in resp.text


# --- the archive (MCP) ----------------------------------------------------------------


# protects=AC1's count: limit=1 answers the archive's total (4321) through its MCP
# endpoint at <host>/mcp with the stored key, and the cite; fails_when=the count is not
# total, the backend is GraphQL for another host, or the cite's fields drift;
# no_claim=the reply text's "4,321" (lane 2).
async def test_archive_count_with_limit_1(sources, tenant_id, alice, archive):
    async with client_for(alice) as a:
        resp = await a.get(f"/v1/live/fireflies/{archive}/meetings", params={"limit": 1})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total"] == ARCHIVE_TOTAL
    assert [m["id"] for m in body["meetings"]] == ["m-301"]
    assert body["meetings"][0] == {
        "id": "m-301",
        "title": "Roadmap review",
        "date": "2026-10-20T16:00:00Z",
        "duration_s": 1800.0,
        "participants": [
            "Ada",
            "Grace",
            "ada@example.com",
            "grace@example.com",
            "linus@example.com",
        ],
    }
    cite = body["cite"]
    assert cite["ref"] == "l:1"
    assert cite["source"] == LABEL
    assert cite["call"] == "list_meetings"
    assert cite["connection_id"] == str(archive)
    assert cite["item_id"] is None
    assert datetime.fromisoformat(cite["read_at"]).tzinfo is not None
    assert sources.archive.calls == [("list_meetings", {"limit": 1, "offset": 0})]
    assert set(sources.hosts) == {"archive.example.com/mcp"}
    assert set(sources.archive.authorizations) == {f"Bearer {LIVE_KEY}"}


# protects=the archive's real list shape read by field name: ISO dates, duration_min,
# participants = speakers then attendees, de-duplicated in order (an empty attendees
# list adds no one), an entry without a title dropped and counted in skipped;
# fails_when=any of these is read wrongly or the bad entry is kept; no_claim=the shapes
# amendment A tolerates beyond the real one (test_amendment_a_tolerated_shapes).
async def test_archive_meetings_are_read_by_field_name(sources, tenant_id, alice, archive):
    async with client_for(alice) as a:
        resp = await a.get(f"/v1/live/fireflies/{archive}/meetings")
    body = resp.json()
    assert resp.status_code == 200, resp.text
    assert body["skipped"] == 1
    assert [(m["id"], m["date"], m["duration_s"], m["participants"]) for m in body["meetings"]] == [
        (
            "m-301",
            "2026-10-20T16:00:00Z",
            1800.0,
            ["Ada", "Grace", "ada@example.com", "grace@example.com", "linus@example.com"],
        ),
        ("m-300", "2026-10-13T16:00:00Z", 2400.0, ["Ada", "Linus"]),
        ("m-299", "2026-10-06T16:00:00Z", 1800.0, ["ada@example.com"]),
    ]
    assert sources.archive.calls[-1] == ("list_meetings", {"limit": 20, "offset": 0})


# protects=amendment A's tolerant reading, kept beside the real shape: epoch-ms dates,
# duration_s, duration (seconds), legacy participants as names or objects, lines with
# start_time (seconds), unknown fields ignored; fails_when=any of these is read wrongly;
# no_claim=that the archive sends them (its real shape is the fake's).
def test_amendment_a_tolerated_shapes():
    meeting = fireflies_live.read_meeting(
        {
            "id": 7,
            "title": "Old shape",
            "date": ms("2026-10-13T16:00:00Z"),
            "duration": 2400,
            "participants": [{"name": "Ada", "email": "ada@example.com"}, "Linus"],
            "extra_field": {"ignored": True},
        }
    )
    assert meeting == {
        "id": "7",
        "title": "Old shape",
        "date": datetime(2026, 10, 13, 16, tzinfo=UTC),
        "duration_s": 2400.0,
        "participants": ["Ada", "Linus"],
    }
    assert (
        fireflies_live.read_meeting({"id": "x", "title": "T", "duration_s": 90})["duration_s"]
        == 90.0
    )
    assert fireflies_live.read_line({"speaker": "Ada", "start_time": 1.5, "text": "Hi."}) == {
        "speaker": "Ada",
        "start_ms": 1500,
        "text": "Hi.",
    }


# protects=list filters reach the archive as amendment A names them (date_from, date_to as
# YYYY-MM-DD, series, limit, offset); fails_when=an argument is renamed or dropped;
# no_claim=how the archive interprets a day.
async def test_archive_list_passes_filters(sources, tenant_id, alice, archive):
    async with client_for(alice) as a:
        resp = await a.get(
            f"/v1/live/fireflies/{archive}/meetings",
            params={
                "date_from": "2026-10-05",
                "date_to": "2026-10-14",
                "series": "weekly",
                "limit": 5,
                "offset": 1,
            },
        )
    assert resp.status_code == 200, resp.text
    assert sources.archive.calls[-1] == (
        "list_meetings",
        {
            "date_from": "2026-10-05",
            "date_to": "2026-10-14",
            "series": "weekly",
            "limit": 5,
            "offset": 1,
        },
    )
    assert [m["id"] for m in resp.json()["meetings"]] == ["m-299"]


@pytest.mark.parametrize(
    ("route", "params"),
    [
        ("meetings", {"limit": 0}),
        ("meetings", {"limit": 201}),
        ("meetings", {"offset": -1}),
        ("search", {"q": ""}),
        ("search", {"q": "x" * 201}),
        ("search", {"q": "a", "limit": 51}),
        ("search", {"q": "a", "limit": 0}),
        ("meetings/m-301", {"max_lines": 0}),
        ("meetings/m-301", {"max_lines": 2001}),
        ("meetings/m-301", {"part": "lines"}),
        ("meetings/m-301/lines", {"limit": 501}),
        ("meetings/m-301/lines", {"limit": 0}),
    ],
)
# protects=every route's query limits (limit 1..200 / 1..50 / 1..500, q 1..200 chars,
# max_lines 1..2000, part summary|all); fails_when=a value outside them reaches the
# source; no_claim=the wording of FastAPI's validation errors.
async def test_query_limits(sources, tenant_id, alice, archive, route, params):
    async with client_for(alice) as a:
        resp = await a.get(f"/v1/live/fireflies/{archive}/{route}", params=params)
    assert resp.status_code == 422, resp.text
    assert sources.archive.calls == []


# protects=C4: date_to before date_from answers 422 before the source is called;
# fails_when=it is sent on; no_claim=the Company time zone's effect (GraphQL test).
async def test_date_to_before_date_from_is_422(sources, tenant_id, alice, archive):
    async with client_for(alice) as a:
        resp = await a.get(
            f"/v1/live/fireflies/{archive}/meetings",
            params={"date_from": "2026-10-10", "date_to": "2026-10-09"},
        )
        bad_day = await a.get(
            f"/v1/live/fireflies/{archive}/meetings", params={"date_from": "10/09/2026"}
        )
    assert resp.status_code == 422
    assert resp.json()["detail"] == "date_to is before date_from."
    assert bad_day.status_code == 422
    assert sources.archive.calls == []


# protects=search's shape on the archive: total is the match count, matches carry
# id/title/date/snippet, query and people go to search_meetings; fails_when=the shape or
# the arguments drift; no_claim=ranking.
async def test_archive_search(sources, tenant_id, alice, archive):
    async with client_for(alice) as a:
        resp = await a.get(
            f"/v1/live/fireflies/{archive}/search",
            params={"q": "weekly", "people": ["Linus"], "limit": 3},
        )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total"] == 1
    assert body["matches"] == [
        {
            "id": "m-300",
            "title": "Weekly sync",
            "date": "2026-10-13T16:00:00Z",
            "snippet": "...Weekly sync...",
        }
    ]
    assert body["cite"]["call"] == "search"
    assert sources.archive.calls[-1] == (
        "search_meetings",
        {"query": "weekly", "people": ["Linus"], "limit": 3, "offset": 0},
    )


# protects=AC2's pull: get_meeting answers id, title, summary and, for part=all, lines up
# to max_lines with truncated, and the cite names the meeting; fails_when=the shape,
# truncation or item_id drift; no_claim=the chip (lane 3).
async def test_archive_get_meeting(sources, tenant_id, alice, archive):
    async with client_for(alice) as a:
        summary = await a.get(f"/v1/live/fireflies/{archive}/meetings/m-301")
        full = await a.get(
            f"/v1/live/fireflies/{archive}/meetings/m-301", params={"part": "all", "max_lines": 5}
        )
        seconds = await a.get(
            f"/v1/live/fireflies/{archive}/meetings/m-300", params={"part": "all"}
        )
    assert summary.status_code == 200, summary.text
    body = summary.json()
    assert (body["id"], body["title"], body["summary"]) == (
        "m-301",
        "Roadmap review",
        "The roadmap was reviewed.",
    )
    assert body["lines"] is None and body["truncated"] is False
    assert body["cite"]["call"] == "get_meeting"
    assert body["cite"]["item_id"] == "m-301"
    assert sources.archive.calls[0] == (
        "get_transcript",
        {"meeting_id": "m-301", "part": "summary", "max_lines": 400},
    )
    body = full.json()
    # The archive answers next_offset (no "truncated"): more lines remain.
    assert len(body["lines"]) == 5 and body["truncated"] is True
    assert body["lines"][1] == {"speaker": "Grace", "start_ms": 5000, "text": "Invented line 1."}
    assert [line["start_ms"] for line in seconds.json()["lines"]] == [1500, 3000]
    assert seconds.json()["truncated"] is False


# protects=owner 2026-10-26: the archive's get_transcript is flat and its summary is
# ``overview`` (there is no ``summary`` key), so a meeting with one reads it and one
# Fireflies has not summarised yet reads null; participants are speakers then attendees,
# de-duplicated; fails_when=the reader looks for a ``summary`` key or a ``meeting``
# wrapper (a real summary reads as none), or drops attendees or speakers; no_claim=the
# keywords, chapters and action items (not answered by get_meeting).
async def test_archive_get_meeting_reads_overview_as_summary(sources, tenant_id, alice, archive):
    async with client_for(alice) as a:
        summarised = await a.get(f"/v1/live/fireflies/{archive}/meetings/m-301")
        unsummarised = await a.get(f"/v1/live/fireflies/{archive}/meetings/m-299")
    assert summarised.status_code == 200, summarised.text
    assert summarised.json()["summary"] == "The roadmap was reviewed."
    assert summarised.json()["participants"] == [
        "Ada",
        "Grace",
        "ada@example.com",
        "grace@example.com",
        "linus@example.com",
    ]
    assert unsummarised.status_code == 200, unsummarised.text
    assert unsummarised.json()["summary"] is None
    assert unsummarised.json()["participants"] == ["ada@example.com"]


# protects=get_lines by offset/limit (defaults 0 and 200, next_offset) and by
# start_ms..end_ms; fails_when=either kind is sent wrongly or next_offset is lost;
# no_claim=the archive's own paging rules.
async def test_archive_get_lines(sources, tenant_id, alice, archive):
    async with client_for(alice) as a:
        first = await a.get(
            f"/v1/live/fireflies/{archive}/meetings/m-301/lines", params={"limit": 4}
        )
        window = await a.get(
            f"/v1/live/fireflies/{archive}/meetings/m-301/lines",
            params={"start_ms": 10000, "end_ms": 20000},
        )
        default = await a.get(f"/v1/live/fireflies/{archive}/meetings/m-301/lines")
    assert first.status_code == 200, first.text
    assert [line["text"] for line in first.json()["lines"]] == [
        f"Invented line {i}." for i in range(4)
    ]
    assert first.json()["next_offset"] == 4
    assert first.json()["cite"]["call"] == "get_lines"
    assert first.json()["cite"]["item_id"] == "m-301"
    assert [line["start_ms"] for line in window.json()["lines"]] == [10000, 15000]
    assert default.json()["next_offset"] is None
    assert sources.archive.calls == [
        ("get_lines", {"meeting_id": "m-301", "offset": 0, "limit": 4}),
        ("get_lines", {"meeting_id": "m-301", "start_ms": 10000, "end_ms": 20000}),
        ("get_lines", {"meeting_id": "m-301", "offset": 0, "limit": 200}),
    ]


@pytest.mark.parametrize(
    ("params", "detail"),
    [
        (
            {"offset": 0, "start_ms": 0, "end_ms": 10},
            "Use offset and limit, or start_ms and end_ms, not both.",
        ),
        (
            {"limit": 5, "start_ms": 0, "end_ms": 10},
            "Use offset and limit, or start_ms and end_ms, not both.",
        ),
        ({"start_ms": 100}, "Give start_ms and end_ms together, with end_ms after start_ms."),
        (
            {"start_ms": 100, "end_ms": 100},
            "Give start_ms and end_ms together, with end_ms after start_ms.",
        ),
    ],
)
# protects=C5: both kinds of line window at once, or a half or empty ms window, answer
# 422 with the sentence; fails_when=the source is called or the sentence drifts;
# no_claim=-.
async def test_lines_windows_are_one_kind(sources, tenant_id, alice, archive, params, detail):
    async with client_for(alice) as a:
        resp = await a.get(f"/v1/live/fireflies/{archive}/meetings/m-301/lines", params=params)
    assert resp.status_code == 422
    assert resp.json()["detail"] == detail
    assert sources.archive.calls == []


# --- Fireflies' own API (GraphQL) -------------------------------------------------------


# protects=amendment B's count: on api.fireflies.ai the list is transcripts() and total
# is user { num_transcripts } with no date filter, null with one; dates are whole days in
# the Company time zone (C4); fails_when=the backend is MCP, the count comes from elsewhere
# or a dated total is not null; no_claim=Fireflies' real plan limits.
async def test_graphql_count_and_dates(sources, tenant_id, alice, graphql):
    async with client_for(alice) as a:
        count = await a.get(f"/v1/live/fireflies/{graphql}/meetings", params={"limit": 1})
        dated = await a.get(
            f"/v1/live/fireflies/{graphql}/meetings",
            params={"date_from": "2026-10-01", "date_to": "2026-10-31"},
        )
    assert count.status_code == 200, count.text
    body = count.json()
    assert body["total"] == 57
    assert [m["id"] for m in body["meetings"]] == ["g-12"]
    # Fireflies' duration is in minutes; its date in epoch ms.
    assert body["meetings"][0]["duration_s"] == 2700.0
    assert body["meetings"][0]["date"] == "2026-10-21T17:00:00Z"
    assert body["cite"]["source"] == "Fireflies"
    assert dated.json()["total"] is None
    assert set(sources.hosts) == {"api.fireflies.ai/graphql"}
    listed = [v for q, v in sources.graphql.queries if "transcripts(" in q]
    assert listed[0]["limit"] == 1
    assert listed[-1]["fromDate"] == "2026-10-01T07:00:00Z"
    assert listed[-1]["toDate"] == "2026-11-01T06:59:59.999Z"
    assert sum("num_transcripts" in q for q, _ in sources.graphql.queries) == 1


# protects=a plan that refuses user { num_transcripts }: total is null and the answer says
# the count is not offered; fails_when=the call fails or a total is made up; no_claim=-.
async def test_graphql_count_refused_is_null(sources, tenant_id, alice, graphql):
    sources.graphql.count_refused = True
    async with client_for(alice) as a:
        resp = await a.get(f"/v1/live/fireflies/{graphql}/meetings", params={"limit": 1})
    assert resp.status_code == 200, resp.text
    assert resp.json()["total"] is None
    assert resp.json()["note"] == "The count of meetings is not offered by this Fireflies plan."


@pytest.mark.parametrize("fail", [429, 503])
# protects=#717 review: a rate-limited or failing count query (user { num_transcripts })
# gives total null with the list that was read, and says the count could not be read
# (not that the plan lacks it), leaving the connection as it was; fails_when=a count
# failure fails the whole call or a total is made up; no_claim=a count that times out
# (the same path: any LiveError of the count).
async def test_graphql_count_failure_keeps_the_list(sources, tenant_id, alice, graphql, fail):
    sources.graphql.count_fail = fail
    async with client_for(alice) as a:
        resp = await a.get(f"/v1/live/fireflies/{graphql}/meetings", params={"limit": 1})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total"] is None
    assert [m["id"] for m in body["meetings"]] == ["g-12"]
    assert body["note"] == "The count of meetings could not be read just now."
    assert (await _conn(tenant_id, graphql)).status == "active"


# protects=amendment B: a limit above 50 is capped with limit_capped, series and people
# answer 422 with their sentences, search's total is null; fails_when=more than 50 is sent,
# a filter is silently dropped, or a total is made up; no_claim=-.
async def test_graphql_caps_and_refusals(sources, tenant_id, alice, graphql):
    async with client_for(alice) as a:
        capped = await a.get(f"/v1/live/fireflies/{graphql}/meetings", params={"limit": 200})
        series = await a.get(f"/v1/live/fireflies/{graphql}/meetings", params={"series": "x"})
        people = await a.get(
            f"/v1/live/fireflies/{graphql}/search", params={"q": "plan", "people": ["Ada"]}
        )
        search = await a.get(f"/v1/live/fireflies/{graphql}/search", params={"q": "plan"})
    assert capped.json()["limit_capped"] is True
    listed = [v for q, v in sources.graphql.queries if "transcripts(" in q]
    assert listed[0]["limit"] == 50
    assert series.status_code == 422
    assert series.json()["detail"] == "Filtering by series needs the Fireflies Archive."
    assert people.status_code == 422
    assert people.json()["detail"] == "Filtering by people needs the Fireflies Archive."
    assert search.status_code == 200, search.text
    assert search.json()["total"] is None
    assert [m["id"] for m in search.json()["matches"]] == ["g-11"]
    assert listed[-1]["keyword"] == "plan"


# protects=amendment B's one meeting: transcript(id), sentences as lines (start_time x
# 1000), summary from overview else short_summary, participants = speakers[].name then
# participants then meeting_attendees (de-duplicated, in order), and lines sliced by
# offset/limit or start_ms..end_ms; fails_when=any of these drifts; no_claim=-.
async def test_graphql_meeting_and_lines(sources, tenant_id, alice, graphql):
    async with client_for(alice) as a:
        full = await a.get(
            f"/v1/live/fireflies/{graphql}/meetings/g-12", params={"part": "all", "max_lines": 4}
        )
        short = await a.get(f"/v1/live/fireflies/{graphql}/meetings/g-11")
        page = await a.get(
            f"/v1/live/fireflies/{graphql}/meetings/g-12/lines", params={"offset": 2, "limit": 2}
        )
        window = await a.get(
            f"/v1/live/fireflies/{graphql}/meetings/g-12/lines",
            params={"start_ms": 5000, "end_ms": 10000},
        )
    body = full.json()
    assert full.status_code == 200, full.text
    assert body["summary"] == "The design was reviewed."
    assert body["truncated"] is True
    assert body["lines"][1] == {"speaker": "Ada", "start_ms": 2500, "text": "Sentence 1."}
    assert len(body["lines"]) == 4
    # speakers[].name, then participants, then meeting_attendees: de-duplicated in order.
    assert body["participants"] == [
        "Ada",
        "Grace",
        "ada@example.com",
        "grace@example.com",
        "linus@example.com",
    ]
    assert short.json()["summary"] == "Planned the quarter."
    assert short.json()["participants"] == ["Ada", "ada@example.com"]
    assert short.json()["lines"] is None
    assert [line["text"] for line in page.json()["lines"]] == ["Sentence 2.", "Sentence 3."]
    assert page.json()["next_offset"] == 4
    assert [line["start_ms"] for line in window.json()["lines"]] == [5000, 7500]


# --- errors ---------------------------------------------------------------------------


@pytest.mark.parametrize("refusal", [401, 403])
# protects=errors table row 1 on both backends: a 401/403 from the source answers 424
# with the sentence and sets the connection to needs reconnecting (status expired, as a
# sync does), writing an error row without a ref; fails_when=the status, sentence or the
# connection's state drifts; no_claim=the Settings page's button.
async def test_source_refused_key_is_424_and_needs_reconnect(
    sources, tenant_id, alice, archive, graphql, refusal
):
    sources.archive.fail = refusal
    sources.graphql.fail = refusal
    async with client_for(alice) as a:
        resp = await a.get(f"/v1/live/fireflies/{archive}/meetings")
        own = await a.get(f"/v1/live/fireflies/{graphql}/meetings")
    assert resp.status_code == 424
    assert resp.json()["detail"] == (
        "Fireflies Archive refused your key (it may have been revoked or expired). "
        "Reconnect it in Settings > Connections."
    )
    assert own.status_code == 424
    assert own.json()["detail"].startswith("Fireflies refused your key")
    assert (await _conn(tenant_id, archive)).status == "expired"
    assert (await _conn(tenant_id, graphql)).status == "expired"
    rows = await _reads(tenant_id)
    assert [(r["status"], r["ref_n"]) for r in rows] == [("error", None), ("error", None)]
    # A connection that needs reconnecting is not called again.
    async with client_for(alice) as a:
        again = await a.get(f"/v1/live/fireflies/{archive}/meetings", params={"limit": 3})
    assert again.status_code == 424
    assert len(sources.archive.authorizations) == 1


# protects=errors table row 2: the source's 429 answers 429 with its Retry-After in the
# sentence and the header; fails_when=the wait is lost or the status drifts; no_claim=-.
async def test_source_rate_limit_is_429_with_retry_after(sources, tenant_id, alice, archive):
    sources.archive.fail = 429
    sources.archive.retry_after = "17"
    async with client_for(alice) as a:
        resp = await a.get(f"/v1/live/fireflies/{archive}/meetings")
    assert resp.status_code == 429
    assert (
        resp.json()["detail"] == "Fireflies Archive is limiting requests; try again in 17 seconds."
    )
    assert resp.headers["retry-after"] == "17"
    assert (await _conn(tenant_id, archive)).status == "active"


@pytest.mark.parametrize(("fail", "reason"), [(503, "HTTP 503"), (500, "HTTP 500")])
# protects=errors table row 4 for 5xx: 502 with the reason and the sentence; fails_when=
# the status or sentence drifts, or the connection is marked; no_claim=-.
async def test_source_5xx_is_502(sources, tenant_id, alice, archive, graphql, fail, reason):
    sources.archive.fail = fail
    sources.graphql.fail = fail
    async with client_for(alice) as a:
        resp = await a.get(f"/v1/live/fireflies/{archive}/meetings")
        own = await a.get(f"/v1/live/fireflies/{graphql}/meetings")
    assert resp.status_code == 502
    assert resp.json()["detail"] == (
        f"Fireflies Archive did not answer ({reason}). Synced data is still available; "
        "try again later."
    )
    assert own.status_code == 502
    assert own.json()["detail"] == (
        f"Fireflies did not answer ({reason}). Synced data is still available; try again later."
    )
    assert (await _conn(tenant_id, archive)).status == "active"


# protects=errors table row 4 for a timeout: a source silent past the limit (10 s, made
# shorter here) answers 502 "did not answer (timed out)"; fails_when=the request hangs or
# the sentence drifts; no_claim=the exact 10 s (a constant, checked below).
async def test_source_timeout_is_502(sources, tenant_id, alice, archive, monkeypatch):
    from oracle.live import fireflies as live_fireflies

    assert live_fireflies.TIMEOUT_SECONDS == 10
    monkeypatch.setattr(live_fireflies, "TIMEOUT_SECONDS", 0.2)
    sources.archive.delay = 2
    async with client_for(alice) as a:
        resp = await a.get(f"/v1/live/fireflies/{archive}/meetings")
    assert resp.status_code == 502
    assert resp.json()["detail"] == (
        "Fireflies Archive did not answer (timed out after 10 seconds). Synced data is still "
        "available; try again later."
    )


@pytest.mark.parametrize("fail", [401, 403, 503])
# protects=#717 review: only the tool call's own response decides a live archive call:
# the session's optional GET stream and its closing DELETE answering an error leave a
# successful result as it is and the connection active; fails_when=a refusal of the GET
# or the DELETE turns the answer into a 424/502 or marks the connection expired;
# no_claim=an archive that sends no session id (no GET, no DELETE: the other tests).
async def test_archive_session_errors_do_not_decide(sources, tenant_id, alice, archive, fail):
    sources.archive.session_id = "s-1"
    sources.archive.fail_other = fail
    async with client_for(alice) as a:
        resp = await a.get(f"/v1/live/fireflies/{archive}/meetings", params={"limit": 1})
    assert resp.status_code == 200, resp.text
    assert resp.json()["total"] == ARCHIVE_TOTAL
    assert (await _conn(tenant_id, archive)).status == "active"
    assert [r["status"] for r in await _reads(tenant_id)] == ["ok"]


# protects=errors table row 5 on both backends: an unknown meeting answers 404 "No meeting
# <id> in <label>."; fails_when=it reads as an empty meeting or another status; no_claim=-.
async def test_unknown_meeting_is_404(sources, tenant_id, alice, archive, graphql):
    async with client_for(alice) as a:
        resp = await a.get(f"/v1/live/fireflies/{archive}/meetings/m-999")
        lines = await a.get(f"/v1/live/fireflies/{archive}/meetings/m-999/lines")
        own = await a.get(f"/v1/live/fireflies/{graphql}/meetings/g-99")
    assert resp.status_code == 404
    assert resp.json()["detail"] == "No meeting m-999 in Fireflies Archive."
    assert lines.status_code == 404
    assert own.status_code == 404
    assert own.json()["detail"] == "No meeting g-99 in Fireflies."


@pytest.mark.parametrize("kind", ["text", "two"])
# protects=C7: content that is neither structured nor one JSON text item answers 502 with
# the sentence and leaves the connection active; fails_when=it is read as no meetings or
# the connection is marked; no_claim=-.
async def test_malformed_answer_is_502(sources, tenant_id, alice, archive, kind):
    sources.archive.malformed = kind
    async with client_for(alice) as a:
        resp = await a.get(f"/v1/live/fireflies/{archive}/meetings")
    assert resp.status_code == 502
    assert resp.json()["detail"] == "Fireflies Archive answered in a way Oracle could not read."
    assert (await _conn(tenant_id, archive)).status == "active"


# protects=errors table row 6 and the owner-only rule: another person's connection, an
# unknown id, or another provider's connection answers 404 with the sentence, and the
# source is never called; fails_when=B reads A's connection or the sentence drifts;
# no_claim=-.
async def test_not_your_connection_is_404(sources, tenant_id, alice, bob, archive):
    slack = await make_connection(tenant_id, alice, "slack")
    async with client_for(bob) as b:
        routes = [
            f"/v1/live/fireflies/{archive}/meetings",
            f"/v1/live/fireflies/{archive}/search?q=weekly",
            f"/v1/live/fireflies/{archive}/meetings/m-301",
            f"/v1/live/fireflies/{archive}/meetings/m-301/lines",
            f"/v1/live/fireflies/{uuid.uuid4()}/meetings",
        ]
        answers = [await b.get(route) for route in routes]
    async with client_for(alice) as a:
        answers.append(await a.get(f"/v1/live/fireflies/{slack}/meetings"))
    for resp in answers:
        assert resp.status_code == 404, resp.text
        assert resp.json()["detail"] == NO_CONNECTION
    assert sources.archive.calls == []
    assert await _reads(tenant_id) == []


# --- MCP: the routes are tools --------------------------------------------------------


@asynccontextmanager
async def _mcp(token: str):
    http = httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=app),
        base_url="http://test",
        headers={"Authorization": f"Bearer {token}"},
    )
    async with http, Client(streamable_http_client("http://test/mcp", http_client=http)) as c:
        yield c


async def _personal_token(tenant_id, user) -> str:
    async with tenant_session(tenant_id) as s:
        _, raw = await create_api_token(s, "mine", user_id=user.id)
        await s.commit()
    return raw


def _text(result) -> str:
    return "\n".join(getattr(c, "text", "") for c in result.content)


# protects=the live routes are MCP tools by operationId for a user caller, and owner only
# on MCP too: B's call on A's connection answers the 404 sentence while A's own call
# answers the count; fails_when=a tool is missing or B reads A's meetings; no_claim=the
# olt_ token's tools/list (lane 2).
async def test_mcp_lists_live_tools_and_is_owner_only(sources, tenant_id, alice, bob, archive):
    async with _mcp(await _personal_token(tenant_id, bob)) as c:
        names = {t.name for t in (await c.list_tools()).tools}
        assert LIVE_TOOLS <= names
        refused = await c.call_tool(
            "live_fireflies_list_meetings", {"connection_id": str(archive), "limit": 1}
        )
    assert refused.is_error
    assert NO_CONNECTION in _text(refused)
    assert "4321" not in _text(refused)
    async with _mcp(await _personal_token(tenant_id, alice)) as c:
        own = await c.call_tool(
            "live_fireflies_list_meetings", {"connection_id": str(archive), "limit": 1}
        )
    assert not own.is_error, _text(own)
    assert '"total":4321' in _text(own).replace(" ", "")


# --- budget and cache -----------------------------------------------------------------


async def _spent(tenant_id, conn_id, kind: str, calls: int, ago: timedelta) -> None:
    async with tenant_session(tenant_id) as s:
        s.add(BrowseCall(connection_id=conn_id, at=datetime.now(UTC) - ago, calls=calls, kind=kind))
        await s.commit()


# protects=the archive's live budget: 120 a minute and 3,000 a day per connection, counted
# in browse_calls with kind 'live' (picker calls are not counted against it), answering 429
# with the sentence at the limit; fails_when=the limits or the sentence drift, or a refused
# call reaches the source; no_claim=the 8-per-reply rule (lane 2).
async def test_archive_budget_120_a_minute_3000_a_day(sources, tenant_id, alice, archive):
    await _spent(tenant_id, archive, "browse", 500, timedelta(seconds=5))
    await _spent(tenant_id, archive, "live", 119, timedelta(seconds=5))
    async with client_for(alice) as a:
        ok = await a.get(f"/v1/live/fireflies/{archive}/meetings", params={"limit": 2})
        refused = await a.get(f"/v1/live/fireflies/{archive}/meetings", params={"limit": 3})
    assert ok.status_code == 200, ok.text
    assert refused.status_code == 429
    detail = refused.json()["detail"]
    assert detail.startswith(
        "Live reads of Fireflies Archive are at this connection's limit of 120 a minute; "
        "try again in "
    )
    assert detail.endswith(" seconds.")
    assert int(refused.headers["retry-after"]) <= 60
    assert len(sources.archive.calls) == 1
    async with tenant_session(tenant_id) as s:
        kinds = (await s.scalars(select(BrowseCall.kind).order_by(BrowseCall.at))).all()
    assert kinds.count("live") == 2

    async with tenant_session(tenant_id) as s:
        await s.execute(text("DELETE FROM browse_calls"))
        await s.commit()
    await _spent(tenant_id, archive, "live", 3000, timedelta(hours=3))
    async with client_for(alice) as a:
        day = await a.get(f"/v1/live/fireflies/{archive}/meetings", params={"limit": 4})
    assert day.status_code == 429
    assert day.json()["detail"] == (
        "Live reads of Fireflies Archive are at this connection's limit of 3000 a day; "
        "try again in 21 hours."
    )


# protects=api.fireflies.ai's live budget shares the picker's 10 a minute and 25 a day
# (picker calls count against it); fails_when=live reads spend Fireflies' quota beyond the
# picker's limits; no_claim=Fireflies' own plan counter.
async def test_graphql_budget_shares_the_pickers(sources, tenant_id, alice, graphql):
    await _spent(tenant_id, graphql, "browse", 9, timedelta(seconds=5))
    async with client_for(alice) as a:
        ok = await a.get(f"/v1/live/fireflies/{graphql}/meetings/g-12")
        refused = await a.get(f"/v1/live/fireflies/{graphql}/meetings/g-11")
    assert ok.status_code == 200, ok.text
    assert refused.status_code == 429
    assert refused.json()["detail"].startswith(
        "Live reads of Fireflies are at this connection's limit of 10 a minute; try again in "
    )
    async with tenant_session(tenant_id) as s:
        await s.execute(text("DELETE FROM browse_calls"))
        await s.commit()
    await _spent(tenant_id, graphql, "browse", 25, timedelta(minutes=30))
    async with client_for(alice) as a:
        day = await a.get(f"/v1/live/fireflies/{graphql}/meetings/g-11")
    assert day.status_code == 429
    assert day.json()["detail"] == (
        "Live reads of Fireflies are at this connection's limit of 25 a day; try again in 24 hours."
    )


# protects=the 60 s cache per (connection, tool, args): a repeat answers from the cache,
# costs nothing, keeps its original read_at and writes a 'cached' row; after 60 s the
# source is read again; fails_when=a repeat calls the source, spends budget or gets a new
# read_at; no_claim=the cache across API processes (it is per process, like browse).
async def test_cache_keeps_read_at_and_costs_nothing(
    sources, tenant_id, alice, archive, monkeypatch
):
    from oracle.live import router as live_router

    now = [1000.0]
    monkeypatch.setattr(live_router, "_clock", lambda: now[0])
    async with client_for(alice) as a:
        first = await a.get(f"/v1/live/fireflies/{archive}/meetings", params={"limit": 1})
        now[0] += 30
        second = await a.get(f"/v1/live/fireflies/{archive}/meetings", params={"limit": 1})
        await a.get(f"/v1/live/fireflies/{archive}/meetings", params={"limit": 2})
        now[0] += 31
        third = await a.get(f"/v1/live/fireflies/{archive}/meetings", params={"limit": 1})
    assert second.json() == first.json()
    assert second.json()["cite"]["read_at"] == first.json()["cite"]["read_at"]
    assert third.json()["cite"]["read_at"] != first.json()["cite"]["read_at"]
    assert [args["limit"] for _, args in sources.archive.calls] == [1, 2, 1]
    async with tenant_session(tenant_id) as s:
        spent = (await s.scalars(select(BrowseCall.calls))).all()
    assert sum(spent) == 3
    rows = await _reads(tenant_id)
    assert [r["status"] for r in rows] == ["ok", "cached", "ok", "ok"]
    assert rows[1]["ref_n"] == 1


# --- live_reads, the off switch, the key ----------------------------------------------


# protects=section 3's live_reads row and C2: user, connection, tool, source_label (the
# label at read time), ref_n, item_id and status are written when the read happens, and
# renaming the connection later leaves the row as it was; it holds no query text;
# fails_when=a column is missing, the label is read later, or the query is stored;
# no_claim=message_id (lane 2 sets it for olt_ calls).
async def test_live_reads_rows_written_at_read_time(sources, tenant_id, alice, archive):
    async with client_for(alice) as a:
        await a.get(f"/v1/live/fireflies/{archive}/meetings/m-301")
        await a.get(f"/v1/live/fireflies/{archive}/search", params={"q": "secretword"})
    async with tenant_session(tenant_id) as s:
        await s.execute(
            update(Connection).where(Connection.id == archive).values(account_label="Renamed")
        )
        await s.commit()
    rows = await _reads(tenant_id)
    assert [
        (
            r["user_id"],
            r["connection_id"],
            r["tool"],
            r["source_label"],
            r["ref_n"],
            r["item_id"],
            r["status"],
            r["message_id"],
        )
        for r in rows
    ] == [
        (alice.id, archive, "get_meeting", LABEL, 1, "m-301", "ok", None),
        (alice.id, archive, "search", LABEL, 1, None, "ok", None),
    ]
    assert rows[0]["tenant_id"] == tenant_id
    assert "secretword" not in repr(rows)
    assert "Roadmap review" not in repr(rows)


# protects=the rollback switch: ORACLE_LIVE_READS=off answers 503 "Live reads are turned
# off." on every /v1/live route and calls no source; fails_when=any route still reads;
# no_claim=the replies' MCP server (lane 2).
async def test_off_switch_is_503(sources, tenant_id, alice, archive, monkeypatch):
    monkeypatch.setattr(get_settings(), "live_reads", "off")
    async with client_for(alice) as a:
        answers = [
            await a.get("/v1/live/sources"),
            await a.get(f"/v1/live/fireflies/{archive}/meetings"),
            await a.get(f"/v1/live/fireflies/{archive}/search?q=weekly"),
            await a.get(f"/v1/live/fireflies/{archive}/meetings/m-301"),
            await a.get(f"/v1/live/fireflies/{archive}/meetings/m-301/lines"),
            await a.get(f"/v1/live/fireflies/{uuid.uuid4()}/meetings"),
        ]
    for resp in answers:
        assert resp.status_code == 503, resp.text
        assert resp.json()["detail"] == "Live reads are turned off."
    assert sources.archive.calls == []


# protects=AC6 for lane 1: the stored key reaches the source as the bearer only, and
# appears in no answer (successes and every error), no log line at any level and no
# live_reads row; fails_when=any answer, log record or row holds the key; no_claim=the
# Claude Code argv, env and MCP config (lane 2).
async def test_fake_key_appears_in_no_answer_log_or_row(
    sources, tenant_id, alice, archive, graphql, caplog
):
    caplog.set_level(logging.DEBUG)
    bodies = []
    async with client_for(alice) as a:
        for conn in (archive, graphql):
            for route in (
                "meetings?limit=1",
                "search?q=weekly",
                "meetings/m-301?part=all",
                "meetings/m-301/lines",
                "meetings/nope",
            ):
                resp = await a.get(f"/v1/live/fireflies/{conn}/{route}")
                bodies.append(resp.text + repr(resp.headers))
        sources.archive.fail = 429
        sources.archive.retry_after = "5"
        bodies.append((await a.get(f"/v1/live/fireflies/{archive}/meetings?limit=9")).text)
        sources.archive.fail = 503
        bodies.append((await a.get(f"/v1/live/fireflies/{archive}/meetings?limit=8")).text)
        sources.archive.fail = None
        sources.archive.malformed = "text"
        bodies.append((await a.get(f"/v1/live/fireflies/{archive}/meetings?limit=7")).text)
        sources.archive.malformed = None
        sources.archive.fail = 401
        bodies.append((await a.get(f"/v1/live/fireflies/{archive}/meetings?limit=6")).text)
    assert f"Bearer {LIVE_KEY}" in sources.archive.authorizations
    for body in bodies:
        assert LIVE_KEY not in body
    assert LIVE_KEY not in caplog.text
    for record in caplog.records:
        assert LIVE_KEY not in record.getMessage()
        assert LIVE_KEY not in repr(record.args)
    rows = await _reads(tenant_id)
    assert rows
    assert LIVE_KEY not in repr(rows)
    async with tenant_session(tenant_id) as s:
        conn = await s.get(Connection, archive)
        assert LIVE_KEY not in (conn.last_error or "")


@pytest.mark.parametrize(
    ("endpoint", "backend", "url"),
    [
        (None, "graphql", "https://api.fireflies.ai/graphql"),
        ("https://api.fireflies.ai/graphql", "graphql", "https://api.fireflies.ai/graphql"),
        (ARCHIVE_ENDPOINT, "mcp", "https://archive.example.com/mcp"),
        ("https://archive.example.com/api/v2/graphql", "mcp", "https://archive.example.com/mcp"),
    ],
)
# protects=the backend choice by host: api.fireflies.ai (or no endpoint) is GraphQL, any
# other host is that host's /mcp; fails_when=a path is kept or the host test drifts;
# no_claim=-.
def test_backend_by_host(endpoint, backend, url):
    from oracle.live import fireflies as live_fireflies

    assert live_fireflies.backend_of(endpoint) == (backend, url)
