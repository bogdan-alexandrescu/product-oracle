"""Fakes for the live Fireflies tools (#710): no network, invented meetings only.

:class:`FakeArchive` is a Fireflies Archive's MCP endpoint (streamable HTTP, JSON
answers) implementing exactly amendment A's table: ``list_meetings`` (its ``total`` is
always 4321, as the spec's fake), ``search_meetings``, ``get_transcript``, ``get_lines``
and ``list_people``. :class:`FakeGraphQL` is Fireflies' own GraphQL API
(``api.fireflies.ai``, amendment B): ``user { num_transcripts }``, ``transcripts`` and
``transcript``. :class:`FakeSources` routes a request to one or the other by host; it is
the handler of an ``httpx.MockTransport``.
"""

import asyncio
import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import httpx

LIVE_KEY = "ff-live-fake-key-7f3a9c"
ARCHIVE_ENDPOINT = "https://archive.example.com/graphql"
ARCHIVE_MCP = "https://archive.example.com/mcp"
GRAPHQL_URL = "https://api.fireflies.ai/graphql"
ARCHIVE_TOTAL = 4321


def ms(when: str) -> int:
    return int(datetime.fromisoformat(when.replace("Z", "+00:00")).timestamp() * 1000)


def _lines(n: int, start_ms: int = 0, step_ms: int = 5000) -> list[dict[str, Any]]:
    return [
        {
            "speaker": "Ada" if i % 2 == 0 else "Grace",
            "start_ms": start_ms + i * step_ms,
            "text": f"Invented line {i}.",
        }
        for i in range(n)
    ]


# Invented meetings, newest first, in the archive's tolerated shapes (amendment A): ISO
# or epoch-ms dates, duration in duration_s / duration (seconds) / duration_min,
# participants as names or objects, lines with start_ms or start_time (seconds).
ARCHIVE_MEETINGS: list[dict[str, Any]] = [
    {
        "id": "m-301",
        "title": "Roadmap review",
        "date": "2026-10-20T16:00:00Z",
        "duration_s": 1800,
        "participants": ["Ada", "Grace"],
        "series": "roadmap",
        "summary": "The roadmap was reviewed.",
        "lines": _lines(12),
        "extra_field": {"ignored": True},
    },
    {
        "id": "m-300",
        "title": "Weekly sync",
        "date": ms("2026-10-13T16:00:00Z"),
        "duration": 2400,
        "participants": [{"name": "Ada", "email": "ada@example.com"}, {"name": "Linus"}],
        "series": "weekly",
        "summary": "Weekly sync notes.",
        "lines": [
            {"speaker": "Ada", "start_time": 1.5, "text": "Hello."},
            {"speaker": "Linus", "start_time": 3, "text": "Hi."},
        ],
    },
    {
        "id": "m-299",
        "title": "Weekly sync",
        "date": "2026-10-06T16:00:00Z",
        "duration_min": 30,
        "participants": ["Ada"],
        "series": "weekly",
        "summary": "Earlier weekly sync.",
        "lines": [],
    },
    # Dropped and counted in ``skipped``: no title.
    {"id": "m-298", "date": "2026-10-01T16:00:00Z"},
]

ARCHIVE_TOOLS = ("list_meetings", "search_meetings", "get_transcript", "get_lines", "list_people")


def _day(value: Any) -> str:
    if isinstance(value, int | float):
        return datetime.fromtimestamp(value / 1000, UTC).date().isoformat()
    return str(value)[:10]


def _public(m: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in m.items() if k not in ("lines", "summary", "series")}


@dataclass
class FakeArchive:
    meetings: list[dict[str, Any]] = field(default_factory=lambda: list(ARCHIVE_MEETINGS))
    api_key: str = LIVE_KEY
    total: int = ARCHIVE_TOTAL
    # Answer every request with this HTTP status instead (401, 403, 429, 503).
    fail: int | None = None
    retry_after: str | None = None
    # Wait this long before answering a tool call (a source that does not answer).
    delay: float = 0.0
    # Answer tools/call with content Oracle cannot read: "text" (not JSON) or "two" (two
    # text items).
    malformed: str | None = None
    # Give the session this id on initialize (the client then may open the GET stream and
    # ends the session with a DELETE), and answer those GET and DELETE requests with
    # ``fail_other`` (401, 403, 429, 503) while every POST is answered.
    session_id: str | None = None
    fail_other: int | None = None
    # The tools called, in order: (name, arguments).
    calls: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    authorizations: list[str | None] = field(default_factory=list)

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        self.authorizations.append(request.headers.get("authorization"))
        if self.fail:
            headers = {"Retry-After": self.retry_after} if self.retry_after else {}
            return httpx.Response(self.fail, headers=headers, text="refused")
        if request.headers.get("authorization") != f"Bearer {self.api_key}":
            return httpx.Response(401, text="bad key")
        if self.fail_other and request.method in ("GET", "DELETE"):
            return httpx.Response(self.fail_other, text="refused")
        if request.method != "POST" or request.url.path != "/mcp":
            return httpx.Response(405)
        message = json.loads(request.content)
        if "id" not in message:
            return httpx.Response(202)
        method = message["method"]
        if method == "initialize":
            result: dict[str, Any] = {
                "protocolVersion": message["params"]["protocolVersion"],
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "fake-fireflies-archive", "version": "1"},
            }
        elif method == "tools/list":
            result = {
                "tools": [
                    {"name": name, "inputSchema": {"type": "object"}} for name in ARCHIVE_TOOLS
                ]
            }
        elif method == "tools/call":
            if self.delay:
                await asyncio.sleep(self.delay)
            name = message["params"]["name"]
            args = message["params"].get("arguments") or {}
            self.calls.append((name, args))
            result = self._tool(name, args)
        else:
            result = {}
        headers = {"mcp-session-id": self.session_id} if self.session_id else {}
        return httpx.Response(
            200, headers=headers, json={"jsonrpc": "2.0", "id": message["id"], "result": result}
        )

    def _tool(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        if self.malformed == "text":
            return {"content": [{"type": "text", "text": "meetings: lots"}], "isError": False}
        if self.malformed == "two":
            return {
                "content": [{"type": "text", "text": "{}"}, {"type": "text", "text": "{}"}],
                "isError": False,
            }
        answer = getattr(self, f"_{name}")(args)
        if answer is None:
            return {
                "content": [
                    {"type": "text", "text": f"Meeting {args.get('meeting_id')} not found"}
                ],
                "isError": True,
            }
        # The list answers come as structured content, the others as one JSON text item:
        # Oracle reads both (amendment A).
        if name in ("list_meetings", "search_meetings"):
            return {
                "content": [{"type": "text", "text": json.dumps(answer)}],
                "structuredContent": answer,
                "isError": False,
            }
        return {"content": [{"type": "text", "text": json.dumps(answer)}], "isError": False}

    def _window(self, args: dict[str, Any]) -> list[dict[str, Any]]:
        out = []
        for m in self.meetings:
            day = _day(m.get("date"))
            if args.get("date_from") and day < args["date_from"]:
                continue
            if args.get("date_to") and day > args["date_to"]:
                continue
            out.append(m)
        return out

    @staticmethod
    def _page(found: list[dict[str, Any]], args: dict[str, Any]) -> list[dict[str, Any]]:
        offset = int(args.get("offset") or 0)
        limit = int(args.get("limit") or 20)
        return [_public(m) for m in found[offset : offset + limit]]

    def _list_meetings(self, args: dict[str, Any]) -> dict[str, Any]:
        found = self._window(args)
        if args.get("series"):
            found = [m for m in found if m.get("series") == args["series"]]
        return {"total": self.total, "meetings": self._page(found, args)}

    def _search_meetings(self, args: dict[str, Any]) -> dict[str, Any]:
        query = str(args.get("query") or "").lower()
        found = [m for m in self._window(args) if query in str(m.get("title") or "").lower()]
        people = args.get("people") or []
        if people:
            found = [
                m
                for m in found
                if any(
                    (p if isinstance(p, str) else p.get("name")) in people
                    for p in m.get("participants", [])
                )
            ]
        page = self._page(found, args)
        for m in page:
            m["snippet"] = f"...{m['title']}..."
        return {"total": len(found), "meetings": page}

    def _find(self, meeting_id: Any) -> dict[str, Any] | None:
        return next((m for m in self.meetings if m["id"] == meeting_id), None)

    def _get_transcript(self, args: dict[str, Any]) -> dict[str, Any] | None:
        m = self._find(args.get("meeting_id"))
        if m is None:
            return None
        out = {**_public(m), "summary": m.get("summary")}
        if args.get("part") == "all":
            lines = m.get("lines", [])
            cap = int(args.get("max_lines") or len(lines) or 1)
            out["lines"] = lines[:cap]
            out["truncated"] = len(lines) > cap
        return out

    def _get_lines(self, args: dict[str, Any]) -> dict[str, Any] | None:
        m = self._find(args.get("meeting_id"))
        if m is None:
            return None
        lines = m.get("lines", [])
        if "start_ms" in args:
            return {
                "lines": [
                    line
                    for line in lines
                    if args["start_ms"] <= line.get("start_ms", 0) < args["end_ms"]
                ]
            }
        offset, limit = int(args.get("offset") or 0), int(args.get("limit") or 200)
        page = lines[offset : offset + limit]
        more = offset + limit < len(lines)
        return {"lines": page, "next_offset": offset + limit if more else None}

    def _list_people(self, args: dict[str, Any]) -> dict[str, Any]:
        return {"people": []}


# Fireflies' own API: dates in epoch ms, duration in minutes, sentences with start_time.
GRAPHQL_MEETINGS: list[dict[str, Any]] = [
    {
        "id": "g-12",
        "title": "Design review",
        "date": ms("2026-10-21T17:00:00Z"),
        "duration": 45,
        "participants": ["ada@example.com", "grace@example.com"],
        "summary": {"overview": "The design was reviewed.", "short_summary": "Design."},
        "sentences": [
            {"index": i, "speaker_name": "Ada", "text": f"Sentence {i}.", "start_time": i * 2.5}
            for i in range(6)
        ],
    },
    {
        "id": "g-11",
        "title": "Planning",
        "date": ms("2026-10-14T17:00:00Z"),
        "duration": 30,
        "participants": ["ada@example.com"],
        "summary": {"overview": None, "short_summary": "Planned the quarter."},
        "sentences": [],
    },
]


@dataclass
class FakeGraphQL:
    meetings: list[dict[str, Any]] = field(default_factory=lambda: list(GRAPHQL_MEETINGS))
    api_key: str = LIVE_KEY
    num_transcripts: int = 57
    # The plan does not offer user { num_transcripts }: answered with a GraphQL error.
    count_refused: bool = False
    # Answer the count query alone with this HTTP status (429, 503); the list is read.
    count_fail: int | None = None
    fail: int | None = None
    retry_after: str | None = None
    queries: list[tuple[str, dict[str, Any]]] = field(default_factory=list)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if self.fail:
            headers = {"Retry-After": self.retry_after} if self.retry_after else {}
            return httpx.Response(self.fail, headers=headers, json={"errors": [{"message": "x"}]})
        if request.headers.get("authorization") != f"Bearer {self.api_key}":
            return httpx.Response(401, json={"errors": [{"message": "bad key"}]})
        body = json.loads(request.content)
        query, variables = body["query"], body.get("variables") or {}
        self.queries.append((query, variables))
        if "num_transcripts" in query:
            if self.count_fail:
                return httpx.Response(self.count_fail, json={"errors": [{"message": "x"}]})
            if self.count_refused:
                return httpx.Response(
                    200,
                    json={
                        "data": None,
                        "errors": [
                            {
                                "message": "Cannot query field",
                                "extensions": {"code": "GRAPHQL_VALIDATION_FAILED"},
                            }
                        ],
                    },
                )
            return httpx.Response(
                200, json={"data": {"user": {"num_transcripts": self.num_transcripts}}}
            )
        if "transcripts(" in query:
            found = list(self.meetings)
            if variables.get("keyword"):
                found = [m for m in found if variables["keyword"].lower() in m["title"].lower()]
            skip, limit = int(variables.get("skip") or 0), int(variables.get("limit") or 50)
            page = [
                {k: v for k, v in m.items() if k not in ("sentences", "summary")}
                for m in found[skip : skip + limit]
            ]
            return httpx.Response(200, json={"data": {"transcripts": page}})
        if "transcript(" in query:
            m = next((m for m in self.meetings if m["id"] == variables.get("id")), None)
            return httpx.Response(200, json={"data": {"transcript": m}})
        return httpx.Response(400, json={"errors": [{"message": "unknown query"}]})


@dataclass
class FakeSources:
    """One handler for both: the archive's host and Fireflies' own."""

    archive: FakeArchive = field(default_factory=FakeArchive)
    graphql: FakeGraphQL = field(default_factory=FakeGraphQL)
    hosts: list[str] = field(default_factory=list)

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        self.hosts.append(f"{request.url.host}{request.url.path}")
        if request.url.host == "api.fireflies.ai":
            return self.graphql(request)
        return await self.archive(request)
