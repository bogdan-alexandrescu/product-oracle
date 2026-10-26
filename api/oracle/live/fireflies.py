"""Reading a Fireflies connection live (#710): the two backends and their answers.

Which backend is chosen by the connection's endpoint host. ``api.fireflies.ai`` (or no
endpoint) is Fireflies' own GraphQL (amendment B). Any other host is a Fireflies-compatible
service, a Fireflies Archive: Oracle calls that host's MCP endpoint
(``<scheme>://<host>/mcp``, streamable HTTP, the stored key as the bearer token) with
the ``mcp`` package's client and the tools of amendment A.

Both go through the API's Fireflies HTTP client (the guarded transport: public
addresses only, no redirect to another host), so the key only reaches the configured
host. Answers are read by field name and the rest is ignored; an entry without an id or
a title (a line without text) is dropped and counted in ``skipped``. Every failure is
one of the :class:`LiveError` kinds below, whose words are Oracle's own: never the
source's, which may echo the key.
"""

import json
import logging
import math
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

import anyio
import httpx
import httpx2
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from oracle.sources.connectors import fireflies

log = logging.getLogger(__name__)

TIMEOUT_SECONDS = 10
TIMEOUT_REASON = f"timed out after {TIMEOUT_SECONDS} seconds"
API_HOST = "api.fireflies.ai"
# The most Fireflies' transcripts query returns at once.
GRAPHQL_PAGE = 50
DEFAULT_RETRY_SECONDS = 60
COUNT_NOT_OFFERED = "The count of meetings is not offered by this Fireflies plan."
COUNT_UNREAD = "The count of meetings could not be read just now."

LIST_QUERY = """
query LiveTranscripts(
  $limit: Int, $skip: Int, $fromDate: DateTime, $toDate: DateTime, $keyword: String
) {
  transcripts(
    limit: $limit, skip: $skip, fromDate: $fromDate, toDate: $toDate, keyword: $keyword
  ) {
    id
    title
    date
    duration
    participants
  }
}
"""
DETAIL_QUERY = """
query LiveTranscript($id: String!) {
  transcript(id: $id) {
    id
    title
    date
    duration
    participants
    sentences { index speaker_name text start_time }
    summary { overview short_summary }
  }
}
"""
COUNT_QUERY = "query LiveCount { user { num_transcripts } }"


class LiveError(Exception):
    """A live read that failed; the router words it for the connection's label."""


class SourceRefused(LiveError):
    """The source refused the key (401/403): the connection needs reconnecting."""


class SourceLimited(LiveError):
    def __init__(self, retry_after: int | None):
        super().__init__("rate limited")
        self.retry_after = retry_after


class SourceDown(LiveError):
    """No usable answer: down, timed out, 5xx. ``reason`` is Oracle's words."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class Malformed(LiveError):
    """An answer Oracle cannot read (C7); the connection is not marked."""


class NotFound(LiveError):
    """No such meeting."""


class Unsupported(LiveError):
    """A filter this backend does not offer: answered 422 with its sentence."""

    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = detail


class _GraphQLError(LiveError):
    def __init__(self, code: str, message: str):
        super().__init__(code)
        self.code = code
        self.message = message


def backend_of(endpoint: str | None) -> tuple[str, str]:
    """("graphql", the endpoint) on api.fireflies.ai or with no endpoint; else ("mcp",
    that host's /mcp)."""
    url = endpoint or fireflies.DEFAULT_ENDPOINT
    parts = urlsplit(url)
    if (parts.hostname or "").lower() == API_HOST:
        return "graphql", url
    return "mcp", f"{parts.scheme}://{parts.netloc}/mcp"


# --- reading answers by field name (amendment A) --------------------------------------


def _date(value: Any) -> datetime | None:
    """ISO 8601 or epoch milliseconds; None when missing or unreadable."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        try:
            return datetime.fromtimestamp(value / 1000, UTC)
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(value, str) and value:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
    return None


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value) if math.isfinite(value) else None


def _duration(entry: dict[str, Any], minutes: bool) -> float | None:
    seconds = _number(entry.get("duration_s"))
    if seconds is not None:
        return seconds
    duration = _number(entry.get("duration"))
    if duration is not None:
        # Fireflies' own API counts minutes; the archive, seconds (amendment A).
        return duration * 60 if minutes else duration
    in_minutes = _number(entry.get("duration_min"))
    return in_minutes * 60 if in_minutes is not None else None


def _participants(value: Any) -> list[str]:
    out: list[str] = []
    for p in value if isinstance(value, list) else []:
        name = p.get("name") if isinstance(p, dict) else p
        if isinstance(name, str) and name:
            out.append(name)
    return out


def _id(value: Any) -> str | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return str(value)
    return value if isinstance(value, str) and value else None


def read_meeting(entry: Any, *, minutes: bool = False) -> dict[str, Any] | None:
    """A meeting's id, title, date, duration_s and participants; None without an id or
    a title."""
    if not isinstance(entry, dict):
        return None
    meeting_id, title = _id(entry.get("id")), entry.get("title")
    if meeting_id is None or not isinstance(title, str) or not title:
        return None
    return {
        "id": meeting_id,
        "title": title,
        "date": _date(entry.get("date")),
        "duration_s": _duration(entry, minutes),
        "participants": _participants(entry.get("participants")),
    }


def read_line(entry: Any) -> dict[str, Any] | None:
    """A line's speaker, start_ms (or start_time seconds x 1000) and text; None without
    text."""
    if not isinstance(entry, dict) or not isinstance(entry.get("text"), str):
        return None
    start = _number(entry.get("start_ms"))
    if start is None:
        seconds = _number(entry.get("start_time"))
        start = seconds * 1000 if seconds is not None else None
    speaker = entry.get("speaker", entry.get("speaker_name"))
    return {
        "speaker": speaker if isinstance(speaker, str) else None,
        "start_ms": round(start) if start is not None else None,
        "text": entry["text"],
    }


def _read_all(entries: Any, read) -> tuple[list[dict[str, Any]], int]:
    if not isinstance(entries, list):
        raise Malformed("not a list")
    out = [read(e) for e in entries]
    kept = [e for e in out if e is not None]
    return kept, len(out) - len(kept)


def _total(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _retry(value: str | None) -> int | None:
    wait = fireflies._retry_after(value)
    return max(1, math.ceil(wait)) if wait else None


def _from_status(status: int, retry_after: str | None) -> LiveError | None:
    if status in (401, 403):
        return SourceRefused("refused")
    if status == 429:
        return SourceLimited(_retry(retry_after))
    if status >= 500:
        return SourceDown(f"HTTP {status}")
    return None


# --- the archive's MCP endpoint ---------------------------------------------------------


class _Stream(httpx2.AsyncByteStream):
    def __init__(self, response: httpx.Response):
        self.response = response

    async def __aiter__(self) -> AsyncIterator[bytes]:
        async for chunk in self.response.aiter_bytes():
            yield chunk

    async def aclose(self) -> None:
        await self.response.aclose()


class _Bridge(httpx2.AsyncBaseTransport):
    """The ``mcp`` client's transport (httpx2) over the API's Fireflies client (httpx,
    the guarded transport). Remembers the first refusing HTTP status a POST got."""

    def __init__(self, client: httpx.AsyncClient):
        self.client = client
        self.refused: LiveError | None = None

    async def handle_async_request(self, request: httpx2.Request) -> httpx2.Response:
        body = await request.aread()
        sent = self.client.build_request(
            request.method, str(request.url), headers=list(request.headers.raw), content=body
        )
        response = await self.client.send(sent, stream=True, follow_redirects=False)
        # Only the session's POSTs (initialize, the tool call) can explain a failed call:
        # the optional GET stream and the closing DELETE never decide it.
        if self.refused is None and request.method == "POST":
            self.refused = _from_status(response.status_code, response.headers.get("Retry-After"))
        # aiter_bytes decodes: the decoded body goes on without its encoding headers.
        headers = [
            (k, v)
            for k, v in response.headers.raw
            if k.lower() not in (b"content-encoding", b"content-length", b"transfer-encoding")
        ]
        return httpx2.Response(response.status_code, headers=headers, stream=_Stream(response))


def _structured(result: Any) -> dict[str, Any]:
    """The tool's answer: its structured content, or its one JSON text item (C7)."""
    if result.is_error:
        text = " ".join(getattr(c, "text", "") for c in result.content).lower()
        if "not found" in text or "no meeting" in text:
            raise NotFound("not found")
        raise SourceDown("it answered with an error")
    if isinstance(result.structured_content, dict):
        return result.structured_content
    content = result.content
    if len(content) != 1 or getattr(content[0], "type", None) != "text":
        raise Malformed("not one text item")
    try:
        answer = json.loads(content[0].text)
    except ValueError:
        raise Malformed("not JSON") from None
    if not isinstance(answer, dict):
        raise Malformed("not an object")
    return answer


class ArchiveBackend:
    """A Fireflies Archive's MCP endpoint (amendment A)."""

    kind = "mcp"

    def __init__(self, client: httpx.AsyncClient, url: str, api_key: str):
        self.client = client
        self.url = url
        self.api_key = api_key

    def check(self, call: str, args: dict[str, Any]) -> None:
        return None

    def cost(self, call: str, args: dict[str, Any]) -> int:
        return 1

    async def _tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        bridge = _Bridge(self.client)
        http = httpx2.AsyncClient(
            transport=bridge, headers={"Authorization": f"Bearer {self.api_key}"}
        )
        result = None
        try:
            with anyio.fail_after(TIMEOUT_SECONDS):
                async with (
                    http,
                    streamable_http_client(self.url, http_client=http) as streams,
                    ClientSession(streams[0], streams[1]) as session,
                ):
                    await session.initialize()
                    result = await session.call_tool(name, arguments)
        except Exception as e:  # noqa: BLE001 - worded below, never re-raised as is
            if result is not None:
                # The tool answered: closing the session decides nothing.
                log.info("closing a live archive session failed: %s", type(e).__name__)
                return _structured(result)
            if isinstance(e, TimeoutError):
                raise SourceDown(TIMEOUT_REASON) from None
            if bridge.refused is not None:
                raise bridge.refused from None
            if isinstance(e, LiveError):
                raise
            if fireflies.address_refused(e):
                raise SourceDown("its address is not one Oracle calls") from None
            # The type only: a message could carry what the source sent.
            log.info("a live archive call failed: %s", type(e).__name__)
            raise SourceDown("the connection failed") from None
        return _structured(result)

    async def list_meetings(self, args: dict[str, Any]) -> dict[str, Any]:
        arguments = _days(args)
        if args.get("series"):
            arguments["series"] = args["series"]
        arguments.update(limit=args["limit"], offset=args["offset"])
        answer = await self._tool("list_meetings", arguments)
        meetings, skipped = _read_all(answer.get("meetings"), read_meeting)
        return {"total": _total(answer.get("total")), "meetings": meetings, "skipped": skipped}

    async def search(self, args: dict[str, Any]) -> dict[str, Any]:
        arguments: dict[str, Any] = {"query": args["q"]}
        if args["people"]:
            arguments["people"] = list(args["people"])
        arguments.update(_days(args))
        arguments.update(limit=args["limit"], offset=args["offset"])
        answer = await self._tool("search_meetings", arguments)
        entries = answer.get("meetings")
        matches, skipped = _read_all(entries, read_meeting)
        snippets = {
            _id(e.get("id")): e.get("snippet")
            for e in entries
            if isinstance(e, dict) and isinstance(e.get("snippet"), str)
        }
        return {
            "total": _total(answer.get("total")),
            "matches": [
                {
                    "id": m["id"],
                    "title": m["title"],
                    "date": m["date"],
                    "snippet": snippets.get(m["id"]),
                }
                for m in matches
            ],
            "skipped": skipped,
        }

    async def get_meeting(self, args: dict[str, Any]) -> dict[str, Any]:
        answer = await self._tool(
            "get_transcript",
            {
                "meeting_id": args["meeting_id"],
                "part": args["part"],
                "max_lines": args["max_lines"],
            },
        )
        if isinstance(answer.get("meeting"), dict):
            answer = answer["meeting"]
        meeting = read_meeting(answer)
        if meeting is None:
            raise Malformed("no meeting")
        summary = answer.get("summary")
        out = {**meeting, "summary": summary if isinstance(summary, str) else None}
        out.update(lines=None, truncated=False, skipped=0)
        if args["part"] == "all":
            lines, skipped = _read_all(answer.get("lines", []), read_line)
            cap = args["max_lines"]
            out.update(
                lines=lines[:cap],
                truncated=bool(answer.get("truncated")) or len(lines) > cap,
                skipped=skipped,
            )
        return out

    async def get_lines(self, args: dict[str, Any]) -> dict[str, Any]:
        arguments: dict[str, Any] = {"meeting_id": args["meeting_id"]}
        if args.get("start_ms") is not None:
            arguments.update(start_ms=args["start_ms"], end_ms=args["end_ms"])
        else:
            arguments.update(offset=args["offset"], limit=args["limit"])
        answer = await self._tool("get_lines", arguments)
        lines, skipped = _read_all(answer.get("lines"), read_line)
        next_offset = answer.get("next_offset")
        return {
            "lines": lines,
            "next_offset": _total(next_offset),
            "skipped": skipped,
        }


# --- Fireflies' own API (GraphQL) --------------------------------------------------------


class GraphQLBackend:
    """Fireflies' GraphQL at api.fireflies.ai (amendment B)."""

    kind = "graphql"

    def __init__(self, client: httpx.AsyncClient, url: str, api_key: str, zone: ZoneInfo):
        self.client = client
        self.url = url
        self.api_key = api_key
        self.zone = zone

    def check(self, call: str, args: dict[str, Any]) -> None:
        if call == "list_meetings" and args.get("series"):
            raise Unsupported("Filtering by series needs the Fireflies Archive.")
        if call == "search" and args.get("people"):
            raise Unsupported("Filtering by people needs the Fireflies Archive.")

    @staticmethod
    def _counted(args: dict[str, Any]) -> bool:
        return args.get("date_from") is None and args.get("date_to") is None

    def cost(self, call: str, args: dict[str, Any]) -> int:
        # A list without dates also reads the count.
        return 2 if call == "list_meetings" and self._counted(args) else 1

    async def _query(self, query: str, variables: dict[str, Any]) -> dict[str, Any]:
        payload = {"query": query, "variables": variables}
        try:
            with anyio.fail_after(TIMEOUT_SECONDS):
                response = await fireflies.post(self.client, self.url, self.api_key, payload)
        except TimeoutError:
            raise SourceDown(TIMEOUT_REASON) from None
        except fireflies.EndpointRefused:
            raise SourceDown("it redirected to another address") from None
        except httpx.HTTPError as e:
            if fireflies.address_refused(e):
                raise SourceDown("its address is not one Oracle calls") from None
            raise SourceDown("the connection failed") from None
        refused = _from_status(response.status_code, response.headers.get("Retry-After"))
        if refused is not None:
            raise refused
        try:
            body = response.json()
        except ValueError:
            body = None
        if not isinstance(body, dict):
            if response.status_code >= 400:
                raise SourceDown(f"HTTP {response.status_code}")
            raise Malformed("not JSON")
        errors = body.get("errors") or []
        for error in errors if isinstance(errors, list) else [errors]:
            error = error if isinstance(error, dict) else {"message": str(error)}
            extensions = error.get("extensions")
            extensions = extensions if isinstance(extensions, dict) else {}
            code = str(extensions.get("code") or error.get("code") or "").lower()
            message = str(error.get("message") or "")
            if code in fireflies.AUTH_CODES:
                raise SourceRefused(code)
            if code in fireflies.RATE_CODES or "too many requests" in message.lower():
                raise SourceLimited(_retry(response.headers.get("Retry-After")))
            raise _GraphQLError(code, message)
        if response.status_code >= 400:
            raise SourceDown(f"HTTP {response.status_code}")
        data = body.get("data")
        if not isinstance(data, dict):
            raise Malformed("no data")
        return data

    def _range(self, args: dict[str, Any]) -> dict[str, Any]:
        return fireflies._range(args.get("date_from"), args.get("date_to"), self.zone)

    async def _transcripts(self, variables: dict[str, Any]) -> list[Any]:
        try:
            page = (await self._query(LIST_QUERY, variables)).get("transcripts")
        except _GraphQLError:
            raise SourceDown("it answered with an error") from None
        if not isinstance(page, list):
            raise Malformed("no list")
        return page

    async def _count(self) -> tuple[int | None, str | None]:
        """The count and, without one, why: the plan does not offer it, or it could not
        be read (rate limited, down, timed out). The list itself was read either way."""
        try:
            data = await self._query(COUNT_QUERY, {})
        except (_GraphQLError, SourceRefused, Malformed):
            return None, COUNT_NOT_OFFERED
        except LiveError as e:
            log.info("a live count failed: %s", type(e).__name__)
            return None, COUNT_UNREAD
        user = data.get("user")
        total = _total(user.get("num_transcripts")) if isinstance(user, dict) else None
        return total, COUNT_NOT_OFFERED if total is None else None

    async def list_meetings(self, args: dict[str, Any]) -> dict[str, Any]:
        limit = min(args["limit"], GRAPHQL_PAGE)
        variables = {"limit": limit, "skip": args["offset"], **self._range(args)}
        meetings, skipped = _read_all(
            await self._transcripts(variables), lambda e: read_meeting(e, minutes=True)
        )
        total, note = None, None
        if self._counted(args):
            total, note = await self._count()
        return {
            "total": total,
            "meetings": meetings,
            "skipped": skipped,
            "limit_capped": args["limit"] > GRAPHQL_PAGE,
            "note": note,
        }

    async def search(self, args: dict[str, Any]) -> dict[str, Any]:
        limit = min(args["limit"], GRAPHQL_PAGE)
        variables = {
            "keyword": args["q"],
            "limit": limit,
            "skip": args["offset"],
            **self._range(args),
        }
        matches, skipped = _read_all(
            await self._transcripts(variables), lambda e: read_meeting(e, minutes=True)
        )
        return {
            "total": None,
            "matches": [
                {"id": m["id"], "title": m["title"], "date": m["date"], "snippet": None}
                for m in matches
            ],
            "skipped": skipped,
            "limit_capped": args["limit"] > GRAPHQL_PAGE,
        }

    async def _transcript(self, meeting_id: str) -> dict[str, Any]:
        try:
            found = (await self._query(DETAIL_QUERY, {"id": meeting_id})).get("transcript")
        except _GraphQLError as e:
            if "not_found" in e.code or "not found" in e.message.lower():
                raise NotFound("not found") from None
            raise SourceDown("it answered with an error") from None
        if found is None:
            raise NotFound("not found")
        if not isinstance(found, dict):
            raise Malformed("not a transcript")
        return found

    async def _sentences(self, transcript: dict[str, Any]) -> tuple[list[dict[str, Any]], int]:
        return _read_all(transcript.get("sentences") or [], read_line)

    async def get_meeting(self, args: dict[str, Any]) -> dict[str, Any]:
        transcript = await self._transcript(args["meeting_id"])
        meeting = read_meeting(transcript, minutes=True)
        if meeting is None:
            raise Malformed("no meeting")
        summary = transcript.get("summary")
        summary = summary if isinstance(summary, dict) else {}
        text = summary.get("overview") or summary.get("short_summary")
        out = {**meeting, "summary": text if isinstance(text, str) else None}
        out.update(lines=None, truncated=False, skipped=0)
        if args["part"] == "all":
            lines, skipped = await self._sentences(transcript)
            cap = args["max_lines"]
            out.update(lines=lines[:cap], truncated=len(lines) > cap, skipped=skipped)
        return out

    async def get_lines(self, args: dict[str, Any]) -> dict[str, Any]:
        lines, skipped = await self._sentences(await self._transcript(args["meeting_id"]))
        if args.get("start_ms") is not None:
            window = [
                line
                for line in lines
                if line["start_ms"] is not None
                and args["start_ms"] <= line["start_ms"] < args["end_ms"]
            ]
            return {"lines": window, "next_offset": None, "skipped": skipped}
        offset, limit = args["offset"], args["limit"]
        more = offset + limit < len(lines)
        return {
            "lines": lines[offset : offset + limit],
            "next_offset": offset + limit if more else None,
            "skipped": skipped,
        }


def _days(args: dict[str, Any]) -> dict[str, str]:
    """The date filters as the archive takes them: YYYY-MM-DD."""
    return {k: args[k].isoformat() for k in ("date_from", "date_to") if args.get(k) is not None}


def backend_for(
    client: httpx.AsyncClient, endpoint: str | None, api_key: str, zone: ZoneInfo
) -> ArchiveBackend | GraphQLBackend:
    kind, url = backend_of(endpoint)
    if kind == "graphql":
        return GraphQLBackend(client, url, api_key, zone)
    return ArchiveBackend(client, url, api_key)
