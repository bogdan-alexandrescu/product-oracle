"""Fakes for the live Fireflies tools (oracle.live): no network, invented meetings.

``FakeArchive`` is a Fireflies-compatible archive's MCP endpoint (streamable HTTP,
JSON-RPC: ``initialize``, ``notifications/initialized``, ``tools/call`` of
``list_meetings``, ``search_meetings``, ``get_transcript`` and ``get_lines``). Its
``list_meetings`` answers ``total: 4321`` whatever it lists, as the spec's archive does.

``FakeGraphQL`` is Fireflies' own GraphQL API at api.fireflies.ai for the queries the
live tools send: ``transcripts`` (limit at most 50), ``transcript(id)`` and
``user { num_transcripts }`` (refused when ``refuse_count``).
"""

import json
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

import httpx

LIVE_KEY = "ff-live-secret-key-9c41"
ARCHIVE_ENDPOINT = "https://archive.example.com/graphql"
ARCHIVE_MCP = "https://archive.example.com/mcp"
GRAPHQL_URL = "https://api.fireflies.ai/graphql"
ARCHIVE_TOTAL = 4321


def _ms(when: str) -> int:
    return int(datetime.fromisoformat(when.replace("Z", "+00:00")).timestamp() * 1000)


# Invented meetings: (id, title, date, seconds, participants, series, summary, lines).
MEETINGS: list[dict[str, Any]] = [
    {
        "id": "m-105",
        "title": "Harbor launch retro",
        "date": "2026-10-20T17:00:00Z",
        "duration_s": 1800,
        "participants": ["ada@example.com", "lin@example.com"],
        "series": "launch-retros",
        "summary": "The harbor launch went out a day late; the checklist gains a dry run.",
        "lines": [
            {"speaker": "Ada", "start_ms": 0, "text": "Welcome to the harbor retro."},
            {"speaker": "Lin", "start_ms": 4000, "text": "We shipped a day late."},
            {"speaker": "Ada", "start_ms": 9000, "text": "Next time we do a dry run."},
            {"speaker": "Lin", "start_ms": 15000, "text": "Agreed, I will add it."},
        ],
    },
    {
        "id": "m-104",
        "title": "Pricing sync",
        "date": "2026-10-15T16:00:00Z",
        "duration_s": 2700,
        "participants": ["ada@example.com", "omar@example.com"],
        "series": "pricing",
        "summary": "Tier names stay; the trial grows to 21 days.",
        "lines": [
            {"speaker": "Omar", "start_ms": 0, "text": "Trial length first."},
            {"speaker": "Ada", "start_ms": 3000, "text": "Twenty one days then."},
        ],
    },
    {
        "id": "m-103",
        "title": "Pricing sync",
        "date": "2026-10-08T16:00:00Z",
        "duration_s": 2400,
        "participants": ["omar@example.com"],
        "series": "pricing",
        "summary": "Tier names were drafted.",
        "lines": [{"speaker": "Omar", "start_ms": 0, "text": "Draft tiers today."}],
    },
    {
        "id": "m-102",
        "title": "Onboarding interview: Juniper Labs",
        "date": "2026-10-02T15:00:00Z",
        "duration_s": 3600,
        "participants": ["lin@example.com", "kai@juniper.example"],
        "series": None,
        "summary": "Juniper wants a shorter setup.",
        "lines": [{"speaker": "Kai", "start_ms": 0, "text": "Setup took us a week."}],
    },
    {
        "id": "m-101",
        "title": "Kickoff",
        "date": "2026-09-20T15:00:00Z",
        "duration_s": 1200,
        "participants": ["ada@example.com"],
        "series": None,
        "summary": "The quarter starts.",
        "lines": [{"speaker": "Ada", "start_ms": 0, "text": "Let us begin."}],
    },
]


def _in_range(m: dict[str, Any], date_from: str | None, date_to: str | None) -> bool:
    day = m["date"][:10]
    return (not date_from or day >= date_from[:10]) and (not date_to or day <= date_to[:10])


@dataclass
class FakeArchive:
    meetings: list[dict[str, Any]] = field(default_factory=lambda: [dict(m) for m in MEETINGS])
    key: str = LIVE_KEY
    url: str = ARCHIVE_MCP
    # Answer every request with this status (and headers) instead.
    status: int | None = None
    headers: dict[str, str] = field(default_factory=dict)
    # Raise this httpx error instead of answering (a timeout, a refused connect).
    raise_error: Exception | None = None
    # Answer JSON-RPC as server-sent events, as streamable HTTP servers may.
    sse: bool = False
    # Every tools/call: (tool, arguments).
    calls: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    requests: list[httpx.Request] = field(default_factory=list)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        assert str(request.url) == self.url, request.url
        if self.raise_error is not None:
            raise self.raise_error
        if self.status is not None:
            return httpx.Response(self.status, headers=self.headers, json={"error": "nope"})
        if request.headers.get("Authorization") != f"Bearer {self.key}":
            return httpx.Response(401, json={"error": "invalid_token"})
        assert "text/event-stream" in request.headers["Accept"]
        message = json.loads(request.content)
        method = message["method"]
        if method == "notifications/initialized":
            assert request.headers.get("Mcp-Session-Id") == "sess-1"
            return httpx.Response(202)
        if method == "initialize":
            result: dict[str, Any] = {
                "protocolVersion": message["params"]["protocolVersion"],
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "fake-archive", "version": "1"},
            }
            return self._answer(message["id"], result, {"Mcp-Session-Id": "sess-1"})
        assert method == "tools/call", method
        assert request.headers.get("Mcp-Session-Id") == "sess-1"
        name, args = message["params"]["name"], message["params"].get("arguments") or {}
        self.calls.append((name, args))
        payload = getattr(self, f"_{name}")(args)
        if payload is None:
            result = {"content": [{"type": "text", "text": "Meeting not found"}], "isError": True}
        else:
            result = {
                "content": [{"type": "text", "text": json.dumps(payload)}],
                "structuredContent": payload,
            }
        return self._answer(message["id"], result)

    def _answer(self, id_: Any, result: Any, headers: dict[str, str] | None = None):
        body = {"jsonrpc": "2.0", "id": id_, "result": result}
        if self.sse:
            text = f"event: message\ndata: {json.dumps(body)}\n\n"
            return httpx.Response(
                200,
                headers={**(headers or {}), "Content-Type": "text/event-stream"},
                content=text.encode(),
            )
        return httpx.Response(200, headers=headers, json=body)

    def _brief(self, m: dict[str, Any]) -> dict[str, Any]:
        keys = ("id", "title", "date", "duration_s", "participants")
        return {k: m[k] for k in keys}

    def _list_meetings(self, args: dict[str, Any]) -> dict[str, Any]:
        found = [
            m
            for m in self.meetings
            if _in_range(m, args.get("date_from"), args.get("date_to"))
            and (not args.get("series") or m["series"] == args["series"])
        ]
        offset, limit = args.get("offset", 0), args.get("limit", 20)
        return {
            "total": ARCHIVE_TOTAL,
            "meetings": [self._brief(m) for m in found[offset : offset + limit]],
        }

    def _search_meetings(self, args: dict[str, Any]) -> dict[str, Any]:
        q = args["q"].lower()
        people = set(args.get("people") or [])
        found = [
            m
            for m in self.meetings
            if (q in m["title"].lower() or q in m["summary"].lower())
            and (not people or people & set(m["participants"]))
            and _in_range(m, args.get("date_from"), args.get("date_to"))
        ]
        offset, limit = args.get("offset", 0), args.get("limit", 10)
        return {
            "total": len(found),
            "matches": [
                {"id": m["id"], "title": m["title"], "date": m["date"], "snippet": m["summary"]}
                for m in found[offset : offset + limit]
            ],
        }

    def _find(self, args: dict[str, Any]) -> dict[str, Any] | None:
        return next((m for m in self.meetings if m["id"] == args["meeting_id"]), None)

    def _get_transcript(self, args: dict[str, Any]) -> dict[str, Any] | None:
        m = self._find(args)
        if m is None:
            return None
        out = {**self._brief(m), "summary": m["summary"]}
        if args.get("part") == "all":
            cap = args.get("max_lines", 400)
            out["lines"] = m["lines"][:cap]
            out["truncated"] = len(m["lines"]) > cap
        else:
            out["truncated"] = False
        return out

    def _get_lines(self, args: dict[str, Any]) -> dict[str, Any] | None:
        m = self._find(args)
        if m is None:
            return None
        lines = m["lines"]
        if "start_ms" in args or "end_ms" in args:
            lo, hi = args.get("start_ms", 0), args.get("end_ms", 1 << 60)
            return {"lines": [x for x in lines if lo <= x["start_ms"] <= hi], "next_offset": None}
        offset, limit = args.get("offset", 0), args.get("limit", 200)
        more = offset + limit < len(lines)
        return {
            "lines": lines[offset : offset + limit],
            "next_offset": offset + limit if more else None,
        }


@dataclass
class FakeGraphQL:
    meetings: list[dict[str, Any]] = field(default_factory=lambda: [dict(m) for m in MEETINGS])
    key: str = LIVE_KEY
    num_transcripts: int = 37
    refuse_count: bool = False
    status: int | None = None
    headers: dict[str, str] = field(default_factory=dict)
    raise_error: Exception | None = None
    bodies: list[dict[str, Any]] = field(default_factory=list)
    requests: list[httpx.Request] = field(default_factory=list)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        assert str(request.url) == GRAPHQL_URL, request.url
        if self.raise_error is not None:
            raise self.raise_error
        if self.status is not None:
            return httpx.Response(self.status, headers=self.headers, json={"errors": []})
        if request.headers.get("Authorization") != f"Bearer {self.key}":
            return httpx.Response(
                401,
                json={"errors": [{"message": "bad key", "extensions": {"code": "auth_failed"}}]},
            )
        body = json.loads(request.content)
        self.bodies.append(body)
        query, variables = body["query"], body.get("variables") or {}
        data: dict[str, Any] = {}
        errors: list[dict[str, Any]] = []
        if "num_transcripts" in query:
            if self.refuse_count:
                data["user"] = None
                errors.append(
                    {
                        "message": "num_transcripts is not available on this plan",
                        "path": ["user", "num_transcripts"],
                        "extensions": {"code": "forbidden"},
                    }
                )
            else:
                data["user"] = {"num_transcripts": self.num_transcripts}
        if "transcripts(" in query:
            assert variables.get("limit", 50) <= 50
            data["transcripts"] = self._list(variables)
        elif "transcript(" in query:
            m = next((m for m in self.meetings if m["id"] == variables["id"]), None)
            data["transcript"] = self._detail(m) if m else None
        out: dict[str, Any] = {"data": data}
        if errors:
            out["errors"] = errors
        return httpx.Response(200, json=out)

    def _entry(self, m: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": m["id"],
            "title": m["title"],
            "date": _ms(m["date"]),
            "duration": m["duration_s"] / 60,
            "participants": m["participants"],
            "calendar_id": m["series"],
            "summary": {"short_summary": m["summary"]},
        }

    def _list(self, v: dict[str, Any]) -> list[dict[str, Any]]:
        found = list(self.meetings)
        if v.get("keyword"):
            k = v["keyword"].lower()
            found = [m for m in found if k in m["title"].lower() or k in m["summary"].lower()]
        if v.get("fromDate"):
            found = [m for m in found if m["date"] >= v["fromDate"][:10]]
        if v.get("toDate"):
            found = [m for m in found if m["date"][:10] <= v["toDate"][:10]]
        skip, limit = v.get("skip", 0), v.get("limit", 50)
        return [self._entry(m) for m in found[skip : skip + limit]]

    def _detail(self, m: dict[str, Any]) -> dict[str, Any]:
        return {
            **self._entry(m),
            "summary": {"overview": m["summary"], "short_summary": m["summary"]},
            "sentences": [
                {"index": i, "speaker_name": x["speaker"], "text": x["text"],
                 "start_time": x["start_ms"] / 1000}
                for i, x in enumerate(m["lines"])
            ],
        }  # fmt: skip


class Both:
    """Route the provider HTTP calls to the archive or to GraphQL by host."""

    def __init__(self, archive: FakeArchive, graphql: FakeGraphQL):
        self.archive, self.graphql = archive, graphql

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.host == "api.fireflies.ai":
            return self.graphql(request)
        return self.archive(request)
