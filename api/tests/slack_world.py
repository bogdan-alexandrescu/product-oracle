"""A small fake Slack workspace for connector and sync tests (httpx.MockTransport)."""

from datetime import UTC, datetime
from typing import Any

import httpx


def ts(day: str, hour: int = 12) -> str:
    when = datetime.fromisoformat(day).replace(hour=hour, tzinfo=UTC)
    return f"{when.timestamp():.6f}"


class SlackWorld:
    """A workspace with two channels; honours ``oldest`` and ``latest`` (exclusive) as
    Slack does, unless ``ignore_bounds`` (to check the connector's own filter)."""

    def __init__(self):
        self.ignore_bounds = False
        self.channels: dict[str, list[dict[str, Any]]] = {
            "C0PRODUCT": [
                {"ts": ts("2025-10-01"), "user": "U0ADA", "text": "kick-off"},
                {"ts": ts("2025-10-05"), "user": "U0ADA", "text": "pricing idea"},
                {"ts": ts("2025-10-10"), "user": "U0ADA", "text": "launch plan"},
            ],
            "C0ROADMAP": [{"ts": ts("2025-10-03"), "user": "U0ADA", "text": "q4 roadmap"}],
        }
        self.replies: dict[str, list[dict[str, Any]]] = {}
        # Channel id -> name, where it is not the id's lowercased tail.
        self.names: dict[str, str] = {}
        # Methods answered with a 429.
        self.limited: set[str] = set()
        # Method -> how many more calls succeed before it answers 429.
        self.limit_after: dict[str, int] = {}
        self.calls: list[tuple[str, dict[str, str]]] = []

    def info(self, cid: str) -> dict[str, Any]:
        name = self.names.get(cid) or cid[2:].lower()
        private = cid.startswith("G")
        return {"id": cid, "name": name, "is_channel": not private, "is_private": private}

    def count(self, method: str) -> int:
        return sum(1 for m, _ in self.calls if m == method)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        method = request.url.path.rsplit("/", 1)[-1]
        params = dict(request.url.params)
        self.calls.append((method, params))
        if method in self.limit_after:
            if self.limit_after[method] <= 0:
                return httpx.Response(429, headers={"Retry-After": "30"}, json={"ok": False})
            self.limit_after[method] -= 1
        if method in self.limited:
            return httpx.Response(429, headers={"Retry-After": "30"}, json={"ok": False})
        if method == "auth.test":
            return self.ok(url="https://example.slack.com/")
        if method == "conversations.info":
            cid = params["channel"]
            if cid not in self.channels:
                return self.ok_false("channel_not_found")
            return self.ok(channel=self.info(cid))
        if method == "conversations.list":
            entries = [self.info(cid) for cid in self.channels]
            start, limit = int(params.get("cursor") or 0), int(params.get("limit") or 100)
            more = start + limit < len(entries)
            return self.ok(
                channels=entries[start : start + limit],
                response_metadata={"next_cursor": str(start + limit) if more else ""},
            )
        if method == "conversations.history":
            oldest = float(params.get("oldest") or 0)
            latest = float(params.get("latest") or 1e12)
            if self.ignore_bounds:
                oldest, latest = 0, 1e12
            messages = [
                m for m in self.channels[params["channel"]] if oldest <= float(m["ts"]) < latest
            ]
            # Newest first, ``limit`` a page, the offset as Slack's cursor.
            messages.sort(key=lambda m: float(m["ts"]), reverse=True)
            start, limit = int(params.get("cursor") or 0), int(params.get("limit") or 100)
            more = start + limit < len(messages)
            return self.ok(
                messages=messages[start : start + limit],
                has_more=more,
                response_metadata={"next_cursor": str(start + limit) if more else ""},
            )
        if method == "conversations.replies":
            return self.ok(messages=self.replies[params["ts"]], response_metadata={})
        if method == "users.info":
            return self.ok(user={"id": params["user"], "name": "ada"})
        raise AssertionError(f"unexpected Slack call {method}")

    @staticmethod
    def ok(**body: Any) -> httpx.Response:
        return httpx.Response(200, json={"ok": True, **body})

    @staticmethod
    def ok_false(error: str) -> httpx.Response:
        return httpx.Response(200, json={"ok": False, "error": error})
