"""Fireflies: one user's meeting transcripts.

credential ``{"api_key"}``; config ``{"from_date"?: ISO date, "title_contains"?: [strings]}``
(a transcript is kept when its title contains any of the strings, case-insensitively).

Each transcript becomes one ``transcript`` item: the summary (overview, action items,
keywords) followed by the sentences as ``speaker: text``. Participants are the ``acl``.

Cursor::

    {"since": "2026-10-01T09:00:00Z", "recent": {"id1": "2026-10-01T09:00:00Z"}}

``since`` is the date of the newest transcript synced. Fireflies can finish processing
an earlier meeting after a later one, so a sync reads back ``OVERLAP`` before ``since``
and skips the ids in ``recent`` (those synced within that window, with their dates).
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime, timedelta
from typing import Any

import httpx

from oracle.sources.base import (
    ConnectorAuthError,
    ConnectorConfigError,
    ConnectorError,
    ConnectorRateLimited,
    CursorCheckpoint,
    ItemUpsert,
    SyncEvent,
    register,
)

API_URL = "https://api.fireflies.ai/graphql"
OAUTH = None
PAGE_SIZE = 50  # the most Fireflies returns per transcripts query
OVERLAP = timedelta(days=1)

AUTH_CODES = {"auth_failed", "unauthorized", "unauthenticated", "forbidden", "invalid_api_key"}
RATE_CODES = {"too_many_requests", "rate_limited", "rate_limit_exceeded"}

USER_QUERY = "query { user { user_id email name } }"
LIST_QUERY = """
query Transcripts($limit: Int, $skip: Int, $fromDate: DateTime) {
  transcripts(limit: $limit, skip: $skip, fromDate: $fromDate) {
    id
    title
    date
    transcript_url
    organizer_email
    participants
  }
}
"""
DETAIL_QUERY = """
query Transcript($id: String!) {
  transcript(id: $id) {
    id
    title
    date
    transcript_url
    organizer_email
    participants
    meeting_attendees { displayName email }
    sentences { index speaker_name text }
    summary { overview action_items keywords }
  }
}
"""


def _parse_date(value: Any) -> datetime | None:
    """Fireflies ``date`` is epoch milliseconds; config and cursor dates are ISO."""
    if value is None or value == "":
        return None
    if isinstance(value, int | float):
        return datetime.fromtimestamp(value / 1000, UTC)
    text = str(value)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        parsed = datetime.combine(date.fromisoformat(text), datetime.min.time())
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def _options(config: dict[str, Any]) -> tuple[datetime | None, list[str]]:
    try:
        from_date = _parse_date(config.get("from_date"))
    except ValueError as e:
        raise ConnectorConfigError("from_date must be an ISO date (YYYY-MM-DD)") from e
    titles = config.get("title_contains") or []
    if not isinstance(titles, list) or not all(isinstance(t, str) and t for t in titles):
        raise ConnectorConfigError("title_contains must be a list of strings")
    return from_date, [t.lower() for t in titles]


def _api_key(credential: dict[str, Any] | None) -> str:
    key = (credential or {}).get("api_key")
    if not key:
        raise ConnectorConfigError("the Fireflies connection has no API key")
    return key


def _lines(value: Any) -> list[str]:
    """Summary fields arrive as a newline-separated string or a list."""
    if not value:
        return []
    items = value if isinstance(value, list) else str(value).splitlines()
    lines = [str(i).strip() for i in items if str(i).strip()]
    return [line[2:].strip() if line[:2] in ("- ", "* ", "• ") else line for line in lines]


def _content(transcript: dict[str, Any]) -> str:
    summary = transcript.get("summary") or {}
    parts = []
    if summary.get("overview"):
        parts.append(f"## Overview\n\n{str(summary['overview']).strip()}")
    actions = _lines(summary.get("action_items"))
    if actions:
        # Fireflies groups action items under bold speaker names.
        parts.append(
            "## Action items\n\n"
            + "\n".join(a if a.startswith("**") else f"- {a}" for a in actions)
        )
    keywords = _lines(summary.get("keywords"))
    if keywords:
        parts.append("## Keywords\n\n" + ", ".join(keywords))

    # Consecutive sentences of one speaker become one paragraph.
    turns: list[tuple[str, list[str]]] = []
    sentences = sorted(transcript.get("sentences") or [], key=lambda s: s.get("index") or 0)
    for sentence in sentences:
        text = (sentence.get("text") or "").strip()
        if not text:
            continue
        speaker = sentence.get("speaker_name") or "Unknown speaker"
        if turns and turns[-1][0] == speaker:
            turns[-1][1].append(text)
        else:
            turns.append((speaker, [text]))
    if turns:
        parts.append(
            "## Transcript\n\n" + "\n".join(f"{s}: {' '.join(texts)}" for s, texts in turns)
        )
    return "\n\n".join(parts)


def _participants(transcript: dict[str, Any]) -> list[str]:
    people = [p for p in transcript.get("participants") or [] if p]
    for attendee in transcript.get("meeting_attendees") or []:
        email = (attendee or {}).get("email")
        if email:
            people.append(email)
    seen: dict[str, None] = {}
    for person in people:
        # Fireflies sometimes packs several addresses into one comma-separated entry.
        for part in str(person).split(","):
            if part.strip():
                seen.setdefault(part.strip().lower(), None)
    return list(seen)


class _Fireflies:
    def __init__(self, client: httpx.AsyncClient, api_key: str):
        self.client = client
        self.headers = {"Authorization": f"Bearer {api_key}"}

    async def query(self, query: str, **variables: Any) -> dict[str, Any]:
        response = await self.client.post(
            API_URL, json={"query": query, "variables": variables}, headers=self.headers
        )
        retry = response.headers.get("Retry-After")
        retry_after = float(retry) if retry else None
        if response.status_code == 429:
            raise ConnectorRateLimited("Fireflies rate limited", retry_after=retry_after)
        if response.status_code in (401, 403):
            raise ConnectorAuthError(f"Fireflies rejected the API key ({response.status_code})")
        try:
            body = response.json()
        except ValueError:
            body = {}
        errors = body.get("errors") or []
        for error in errors:
            code = str((error.get("extensions") or {}).get("code") or error.get("code") or "")
            code = code.lower()
            message = error.get("message") or code
            if code in AUTH_CODES:
                raise ConnectorAuthError(f"Fireflies rejected the API key: {message}")
            if code in RATE_CODES or "too many requests" in message.lower():
                metadata = (error.get("extensions") or {}).get("metadata") or {}
                retry_ms = metadata.get("retryAfter")
                if retry_after is None and isinstance(retry_ms, int | float):
                    # Fireflies reports retryAfter as an epoch-ms timestamp.
                    wait = retry_ms / 1000 - datetime.now(UTC).timestamp()
                    retry_after = wait if wait > 0 else None
                raise ConnectorRateLimited(f"Fireflies: {message}", retry_after=retry_after)
        if response.status_code >= 400 or errors:
            detail = errors[0].get("message") if errors else f"HTTP {response.status_code}"
            raise ConnectorError(f"Fireflies query failed: {detail}")
        return body.get("data") or {}


class FirefliesConnector:
    kind = "fireflies"

    def __init__(self, client: httpx.AsyncClient | None = None):
        self._client = client

    @asynccontextmanager
    async def _session(self, credential: dict[str, Any] | None):
        api_key = _api_key(credential)
        if self._client is not None:
            yield _Fireflies(self._client, api_key)
            return
        async with httpx.AsyncClient(timeout=60) as client:
            yield _Fireflies(client, api_key)

    async def validate(self, config: dict[str, Any], credential: dict[str, Any] | None) -> None:
        _options(config)
        async with self._session(credential) as fireflies:
            data = await fireflies.query(USER_QUERY)
            if not data.get("user"):
                raise ConnectorAuthError("Fireflies did not return the key's user")

    async def sync(
        self,
        config: dict[str, Any],
        credential: dict[str, Any] | None,
        cursor: dict[str, Any] | None,
    ) -> AsyncIterator[SyncEvent]:
        from_date, titles = _options(config)
        since = _parse_date((cursor or {}).get("since"))
        recent: dict[str, str] = dict((cursor or {}).get("recent") or {})
        stop = since - OVERLAP if since else from_date
        if since and from_date and from_date > stop:
            stop = from_date

        async with self._session(credential) as fireflies:
            # Newest first: page until a transcript is older than the stop date.
            pending: list[tuple[datetime, dict[str, Any]]] = []
            skip = 0
            while True:
                variables: dict[str, Any] = {"limit": PAGE_SIZE, "skip": skip}
                if stop:
                    variables["fromDate"] = _iso(stop)
                page = (await fireflies.query(LIST_QUERY, **variables)).get("transcripts") or []
                done = len(page) < PAGE_SIZE
                for entry in page:
                    when = _parse_date(entry.get("date"))
                    if stop and when and when < stop:
                        done = True
                        break
                    if entry["id"] in recent:
                        continue
                    title = (entry.get("title") or "").lower()
                    if titles and not any(t in title for t in titles):
                        continue
                    pending.append((when or datetime.min.replace(tzinfo=UTC), entry))
                if done:
                    break
                skip += PAGE_SIZE

            # Oldest first, so each checkpoint covers everything before it.
            pending.sort(key=lambda p: p[0])
            newest = since
            for when, entry in pending:
                data = await fireflies.query(DETAIL_QUERY, id=entry["id"])
                transcript = data.get("transcript")
                if transcript:
                    yield self._item(transcript)
                if newest is None or when > newest:
                    newest = when
                recent[entry["id"]] = _iso(when)
                horizon = newest - OVERLAP
                recent = {i: d for i, d in recent.items() if _parse_date(d) >= horizon}
                yield CursorCheckpoint({"since": _iso(newest), "recent": dict(recent)})

    def _item(self, transcript: dict[str, Any]) -> ItemUpsert:
        when = _parse_date(transcript.get("date"))
        participants = _participants(transcript)
        return ItemUpsert(
            external_id=transcript["id"],
            kind="transcript",
            title=transcript.get("title") or "Untitled meeting",
            url=transcript.get("transcript_url"),
            author=transcript.get("organizer_email"),
            content=_content(transcript),
            acl={"participants": participants},
            occurred_at=when,
            source_updated_at=when,
        )


register(FirefliesConnector())
