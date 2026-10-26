"""An in-memory Fireflies GraphQL API for tests (no network).

It answers the ``user``, ``transcripts`` and ``transcript`` queries the way Fireflies
does: transcripts newest first, ``fromDate`` / ``toDate`` filters, ``keyword`` with
``scope: "title"``, ``skip`` / ``limit`` paging, ``date`` in epoch milliseconds.
"""

import json
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

import httpx

API_URL = "https://api.fireflies.ai/graphql"
API_KEY = "ff-test-key"


def ms(when: str) -> int:
    return int(datetime.fromisoformat(when.replace("Z", "+00:00")).timestamp() * 1000)


def meeting(
    id: str,
    title: str,
    when: str,
    *,
    calendar_id: str | None = None,
    organizer: str = "ada@example.com",
    participants: list[str] | None = None,
    duration: float = 30.0,
) -> dict[str, Any]:
    return {
        "id": id,
        "title": title,
        "date": ms(when),
        "duration": duration,
        "transcript_url": f"https://app.fireflies.ai/view/{id}",
        "organizer_email": organizer,
        "participants": participants if participants is not None else [organizer],
        "calendar_id": calendar_id,
    }


@dataclass
class FakeFireflies:
    meetings: list[dict[str, Any]] = field(default_factory=list)
    # Answer every query with this response instead (errors, rate limits).
    error: httpx.Response | None = None
    api_key: str = API_KEY
    # The GraphQL endpoint the fake answers at (a connection's configured endpoint).
    api_url: str = API_URL
    requests: list[dict[str, Any]] = field(default_factory=list)
    # Transcripts still being processed: answered as null this many more times.
    processing: dict[str, int] = field(default_factory=dict)
    # List the meetings in the order given, not newest first (out-of-order answers).
    unsorted: bool = False
    # Transcripts whose detail Fireflies refuses (HTTP 403).
    forbidden: set[str] = field(default_factory=set)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        assert str(request.url) == self.api_url
        assert request.headers["Authorization"] == f"Bearer {self.api_key}"
        body = json.loads(request.content)
        self.requests.append(body)
        if self.error is not None:
            return self.error
        query, variables = body["query"], body.get("variables") or {}
        if "user {" in query:
            return httpx.Response(
                200, json={"data": {"user": {"user_id": "u1", "email": "ada@example.com"}}}
            )
        if "transcripts(" in query:
            return httpx.Response(200, json={"data": {"transcripts": self._list(variables)}})
        if "transcript(" in query:
            if variables["id"] in self.forbidden:
                return httpx.Response(403, json={"errors": [{"message": "forbidden"}]})
            found = next((m for m in self.meetings if m["id"] == variables["id"]), None)
            if self.processing.get(variables["id"], 0) > 0:
                self.processing[variables["id"]] -= 1
                found = None
            return httpx.Response(200, json={"data": {"transcript": self._detail(found)}})
        raise AssertionError(f"unexpected query {query}")

    def _list(self, v: dict[str, Any]) -> list[dict[str, Any]]:
        rows = list(self.meetings) if self.unsorted else self._newest_first()
        if v.get("fromDate"):
            rows = [m for m in rows if not _dated(m) or m["date"] >= ms(v["fromDate"])]
        if v.get("toDate"):
            rows = [m for m in rows if not _dated(m) or m["date"] <= ms(v["toDate"])]
        if v.get("keyword"):
            assert v.get("scope") == "title"
            rows = [m for m in rows if v["keyword"].lower() in m["title"].lower()]
        skip, limit = v.get("skip") or 0, v.get("limit") or 50
        assert limit <= 50
        return [dict(m) for m in rows[skip : skip + limit]]

    @staticmethod
    def _detail(m: dict[str, Any] | None) -> dict[str, Any] | None:
        if m is None:
            return None
        return {
            **m,
            "meeting_attendees": [],
            "sentences": [{"index": 0, "speaker_name": "Ada", "text": f"Notes of {m['title']}."}],
            "summary": {"overview": f"About {m['title']}.", "action_items": "", "keywords": ""},
        }

    def _newest_first(self) -> list[dict[str, Any]]:
        return sorted(self.meetings, key=lambda m: m["date"] if _dated(m) else 0, reverse=True)

    def list_variables(self) -> list[dict[str, Any]]:
        return [r["variables"] for r in self.requests if "transcripts(" in r["query"]]

    def detail_ids(self) -> list[str]:
        return [r["variables"]["id"] for r in self.requests if "transcript(" in r["query"]]


def _dated(m: dict[str, Any]) -> bool:
    return isinstance(m["date"], int) and 0 <= m["date"] < 253_402_300_800_000


def rate_limited(retry_after: int = 30) -> httpx.Response:
    return httpx.Response(
        429,
        headers={"Retry-After": str(retry_after)},
        json={
            "errors": [
                {
                    "message": "Too many requests. Please retry after 30 seconds.",
                    "extensions": {"code": "too_many_requests", "status": 429},
                }
            ]
        },
    )


# A month of meetings: two calendar series, a one-off and an old meeting (no calendar).
STANDUP_CAL = "7kq2abc0def1ghi2jkl3mno4pq"
PLANNING_CAL = "plan5q9r8s7t6u"
SAMPLE = [
    meeting("S1", "AI Agents daily standup", "2026-09-28T09:00:00Z", calendar_id=STANDUP_CAL),
    meeting(
        "S2",
        "AI Agents daily standup",
        "2026-10-05T09:00:00Z",
        calendar_id=f"{STANDUP_CAL}_20261005T090000Z",
    ),
    meeting("S3", "AI agents daily standup ", "2026-10-12T09:00:00Z", calendar_id=STANDUP_CAL),
    meeting(
        "P1",
        "AI agents sprint planning #11",
        "2026-09-30T14:00:00Z",
        organizer="lin@x.io",
        calendar_id=PLANNING_CAL,
    ),
    meeting(
        "P2",
        "AI agents sprint planning - Oct 14",
        "2026-10-14T14:00:00Z",
        organizer="lin@x.io",
        calendar_id=f"{PLANNING_CAL}_20261014T140000Z",
    ),
    meeting(
        "K1",
        "Customer interview: Acme",
        "2026-10-02T16:00:00Z",
        participants=["ada@example.com", "jo@acme.test", "lin@x.io"],
        duration=45.5,
    ),
    meeting("O1", "Old kickoff", "2026-08-20T10:00:00Z"),
]
