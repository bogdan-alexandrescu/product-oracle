"""Fireflies: one user's meeting transcripts.

credential ``{"api_key"}``; config, as the browse screen saves it (S5, owner 2026-10-19)::

    {"mode": "all" | "selected", "date_from"?: ISO date, "date_to"?: ISO date,
     "series": [series keys], "meetings": [transcript ids], "labels"?: {key or id: title}}

``all`` takes every meeting in the date range; ``selected`` takes every meeting of the
picked recurring series (past and future, so a new one is picked up on the next sync)
plus the picked meetings, within the date range when one is set. ``date_to`` is
inclusive (whole UTC day); no ``date_to`` means ongoing. ``labels`` only remembers what
the picker showed, for the web UI.

Configs saved before the picker still work and read as a *title rule*: a config without
``mode`` is ``all`` from ``from_date``, keeping only titles that contain one of
``title_contains`` (or of ``meetings``, where the old web form put title filters).

A series is keyed by the transcript's ``calendar_id`` (the calendar provider's event id,
https://docs.fireflies.ai/schema/transcript; ``cal:<id>``, a Google instance suffix
``_YYYYMMDDTHHMMSSZ``, a 'this and following' split ``_R<start>`` and ``@google.com``
removed) and, for meetings without one, by the normalised title and
organizer (``title:<title>|<organizer>``).

Each transcript becomes one ``transcript`` item: the summary (overview, action items,
keywords) followed by the sentences as ``speaker: text``. Participants are the ``acl``.

Cursor::

    {"since": "2026-10-01T09:00:00Z", "listed": "2026-10-03T15:00:00Z",
     "recent": {"id1": "2026-10-01T09:00:00Z"}, "aliases": ["title:standup|ada@example.com"],
     "selection": "3f2a9c0d1e4b5a6c"}

``since`` is the date of the newest transcript synced; ``listed`` that of the newest
meeting listed when it is later (one not picked), so the position moves on even when
nothing new is picked and an old pick does not make every sync list the account's
history since then. Fireflies can finish processing
an earlier meeting after a later one, so a sync reads back ``OVERLAP`` before ``since``
and skips the ids in ``recent`` (those synced within that window, with their dates).

``selection`` is a fingerprint of the config the cursor was saved under: a cursor of
another selection is ignored, so narrowing always gets a full pass (see below).

``aliases`` are the title keys of meetings seen in a picked calendar series: a meeting
whose calendar id changed (or that has none) still matches the series by its title and
organizer.

A pass without a position (a new source, or one whose config changed) lists the whole date
range: stored items no longer picked are deleted, stored items still picked are not
fetched again. The engine passes ``known`` (the source's stored ids) for this.
"""

import hashlib
import json
import re
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from email.utils import parsedate_to_datetime
from typing import Any

import httpx

from oracle.sources.base import (
    ConnectorAuthError,
    ConnectorConfigError,
    ConnectorError,
    ConnectorRateLimited,
    CursorCheckpoint,
    ItemDelete,
    ItemUpsert,
    SyncEvent,
    register,
)

API_URL = "https://api.fireflies.ai/graphql"
OAUTH = None
PAGE_SIZE = 50  # the most Fireflies returns per transcripts query
OVERLAP = timedelta(days=1)
# The series list reads at most this many pages of meetings (rate limits: 30-60 a minute).
SERIES_PAGES = 10
MAX_SERIES = 200
MAX_MEETINGS = 2000
MAX_LABELS = 1000

AUTH_CODES = {"auth_failed", "unauthorized", "unauthenticated", "forbidden", "invalid_api_key"}
RATE_CODES = {"too_many_requests", "rate_limited", "rate_limit_exceeded"}

USER_QUERY = "query { user { user_id email name } }"
LIST_QUERY = """
query Transcripts(
  $limit: Int, $skip: Int, $fromDate: DateTime, $toDate: DateTime,
  $keyword: String, $scope: String
) {
  transcripts(
    limit: $limit, skip: $skip, fromDate: $fromDate, toDate: $toDate,
    keyword: $keyword, scope: $scope
  ) {
    id
    title
    date
    duration
    transcript_url
    organizer_email
    participants
    calendar_id
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
    spec = "milliseconds" if value.microsecond else "seconds"
    return value.astimezone(UTC).isoformat(timespec=spec).replace("+00:00", "Z")


def _config_date(config: dict[str, Any], key: str) -> datetime | None:
    value = config.get(key)
    if value is None or value == "":
        return None
    # Numbers (and booleans, which are ints) would read as epoch milliseconds.
    if not isinstance(value, str):
        raise ConnectorConfigError(f"{key} must be an ISO date (YYYY-MM-DD)")
    try:
        parsed = _parse_date(value)
        # date_to is used as the day after it: the last representable day cannot be.
        if parsed is not None:
            parsed + timedelta(days=1)
        return parsed
    except ValueError as e:
        raise ConnectorConfigError(f"{key} must be an ISO date (YYYY-MM-DD)") from e
    except OverflowError as e:
        raise ConnectorConfigError(f"{key} is out of range") from e


def _retry_after(value: str | None) -> float | None:
    """Retry-After in seconds, or as an HTTP date; None when unreadable."""
    if not value:
        return None
    try:
        return max(float(value), 0.0)
    except ValueError:
        pass
    try:
        when = parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError):
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    wait = (when - datetime.now(UTC)).total_seconds()
    return wait if wait > 0 else None


def _strings(config: dict[str, Any], key: str, limit: int) -> list[str]:
    value = config.get(key) or []
    if not isinstance(value, list) or not all(isinstance(v, str) and v.strip() for v in value):
        raise ConnectorConfigError(f"{key} must be a list of strings")
    if len(value) > limit:
        raise ConnectorConfigError(f"{key} takes at most {limit} entries")
    return [v.strip() for v in value]


# --- Series -------------------------------------------------------------------------

_MONTH = r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?"
_WEEKDAY = r"(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?,?\s*"
_DAY = r"\d{1,2}(?:st|nd|rd|th)?"
_DATED = (
    r"(?:#\d+|\d+"
    r"|\d{4}-\d{1,2}-\d{1,2}"
    r"|\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?"
    rf"|(?:{_WEEKDAY})?{_MONTH}\s+{_DAY}(?:,?\s+\d{{4}})?"
    rf"|(?:{_WEEKDAY})?{_DAY}\s+{_MONTH}(?:,?\s+\d{{4}})?)"
)
# Titles are cut to this many characters before their suffixes are removed.
MAX_TITLE = 200
# Every trailing date or number after a space or separator, in one anchored match:
# " - Oct 14", " #12", " (10/14) #3".
_SUFFIXES = re.compile(rf"(?:(?:\s*[-\u2013\u2014:|,]\s*|\s+)\(?{_DATED}\)?)+\s*$", re.IGNORECASE)
# Google Calendar instance ids are the recurring event's id plus the instance start
# (_YYYYMMDDTHHMMSSZ); 'this and following' splits the series into <id>_R<start>, whose
# instances add their own start. Either may end in "@google.com".
_INSTANCE = re.compile(r"(?:_R\d{8}(?:T\d{6}Z?)?)?(?:_\d{8}(?:T\d{6}Z?)?)?$")
_GOOGLE_DOMAIN = re.compile(r"@google\.com$", re.IGNORECASE)
# Title keys remembered for the picked calendar series (see Selection.matches).
MAX_ALIASES = 1000


def series_title(title: str | None) -> str:
    """The title with trailing dates and numbers removed, case kept.

    The title is cut to MAX_TITLE characters first, so the cost is bounded whatever
    Fireflies returns."""
    text = " ".join((title or "").split())[:MAX_TITLE].strip()
    shorter = _SUFFIXES.sub("", text, count=1).strip()
    return shorter or text or "Untitled meeting"


def normalise_title(title: str | None) -> str:
    return series_title(title).lower()


def title_key(entry: dict[str, Any]) -> str:
    """The series key of a transcript by its normalised title and organizer."""
    organizer = str(entry.get("organizer_email") or "").strip().lower()
    return f"title:{normalise_title(entry.get('title'))}|{organizer}"


def series_key(entry: dict[str, Any]) -> str:
    """The recurring series a transcript belongs to: its calendar event, else its
    normalised title and organizer."""
    calendar = _GOOGLE_DOMAIN.sub("", str(entry.get("calendar_id") or "").strip())
    calendar = _INSTANCE.sub("", calendar) or calendar
    if calendar:
        return f"cal:{calendar}"
    return title_key(entry)


# --- Config -------------------------------------------------------------------------


@dataclass(frozen=True)
class Selection:
    mode: str = "all"
    date_from: datetime | None = None
    # Exclusive: the day after date_to.
    date_to_end: datetime | None = None
    series: frozenset[str] = frozenset()
    meetings: frozenset[str] = frozenset()
    # Lowercased title fragments of a title rule (configs saved before the picker).
    titles: tuple[str, ...] = ()
    legacy: bool = False

    def matches(
        self, entry: dict[str, Any], when: datetime | None, aliases: frozenset[str] = frozenset()
    ) -> bool:
        """Whether the selection takes this transcript. A picked series also matches by
        title and organizer: the series' own title key, or ``aliases``, the title keys
        of the meetings seen in a picked calendar series (so a series whose calendar id
        changes keeps matching)."""
        if when is not None:
            if self.date_from and when < self.date_from:
                return False
            if self.date_to_end and when >= self.date_to_end:
                return False
        if self.titles:
            title = (entry.get("title") or "").lower()
            if not any(t in title for t in self.titles):
                return False
        if self.mode == "all":
            return True
        if entry.get("id") in self.meetings or series_key(entry) in self.series:
            return True
        by_title = title_key(entry)
        return by_title in self.series or by_title in aliases


def selection(config: dict[str, Any]) -> Selection:
    """Read a source's config; raises :class:`ConnectorConfigError` when it is invalid."""
    if "mode" not in config:
        titles = _strings(config, "title_contains", MAX_MEETINGS)
        # The old web form saved its "meeting title filters" under "meetings".
        titles += _strings(config, "meetings", MAX_MEETINGS)
        return Selection(
            date_from=_config_date(config, "from_date"),
            titles=tuple(t.lower() for t in titles),
            legacy=bool(config),
        )
    mode = config.get("mode")
    if mode not in ("all", "selected"):
        raise ConnectorConfigError("mode must be 'all' or 'selected'")
    date_from = _config_date(config, "date_from") or _config_date(config, "from_date")
    date_to = _config_date(config, "date_to")
    if date_from and date_to and date_to < date_from:
        raise ConnectorConfigError("date_to must be on or after date_from")
    series = frozenset(_strings(config, "series", MAX_SERIES))
    meetings = frozenset(_strings(config, "meetings", MAX_MEETINGS))
    if mode == "selected" and not series and not meetings:
        raise ConnectorConfigError("pick at least one series or meeting, or take all meetings")
    labels = config.get("labels") or {}
    if not isinstance(labels, dict) or not all(
        isinstance(k, str) and isinstance(v, str) for k, v in labels.items()
    ):
        raise ConnectorConfigError("labels must map strings to strings")
    if len(labels) > MAX_LABELS:
        raise ConnectorConfigError(f"labels takes at most {MAX_LABELS} entries")
    titles = _strings(config, "title_contains", MAX_MEETINGS)
    return Selection(
        mode=mode,
        date_from=date_from,
        date_to_end=date_to + timedelta(days=1) if date_to else None,
        series=series if mode == "selected" else frozenset(),
        meetings=meetings if mode == "selected" else frozenset(),
        titles=tuple(t.lower() for t in titles),
    )


# --- Browse -------------------------------------------------------------------------


@dataclass(frozen=True)
class Meeting:
    id: str
    title: str
    date: datetime | None
    duration: float | None
    organizer: str | None
    attendee_count: int
    series_key: str
    series_title: str


@dataclass(frozen=True)
class MeetingPage:
    meetings: list[Meeting]
    # Where the next page starts; None on the last page.
    next_skip: int | None


@dataclass
class Series:
    key: str
    title: str
    meeting_count: int
    last_date: datetime | None
    organizer: str | None


@dataclass(frozen=True)
class SeriesList:
    series: list[Series]
    # More meetings exist than the list read (SERIES_PAGES pages).
    truncated: bool
    # Meetings read to build the list.
    scanned: int = 0


def _meeting(entry: dict[str, Any]) -> Meeting:
    duration = entry.get("duration")
    return Meeting(
        id=entry["id"],
        title=entry.get("title") or "Untitled meeting",
        date=_parse_date(entry.get("date")),
        duration=float(duration) if isinstance(duration, int | float) else None,
        organizer=entry.get("organizer_email") or None,
        attendee_count=len(_participants(entry)),
        series_key=series_key(entry),
        series_title=series_title(entry.get("title")),
    )


def _range(date_from: date | None, date_to: date | None) -> dict[str, Any]:
    variables: dict[str, Any] = {}
    if date_from:
        variables["fromDate"] = _iso(datetime.combine(date_from, datetime.min.time(), UTC))
    if date_to:
        if date_to >= date.max:
            raise ConnectorConfigError("the end date is out of range")
        end = datetime.combine(date_to + timedelta(days=1), datetime.min.time(), UTC)
        variables["toDate"] = _iso(end - timedelta(milliseconds=1))
    return variables


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


class FirefliesForbidden(ConnectorAuthError):
    """Fireflies refused one request ("forbidden"): the key may lack access to it (a
    plan or team permission), which does not mean the key itself was revoked."""


class _Fireflies:
    def __init__(self, client: httpx.AsyncClient, api_key: str):
        self.client = client
        self.headers = {"Authorization": f"Bearer {api_key}"}

    async def query(self, query: str, **variables: Any) -> dict[str, Any]:
        response = await self.client.post(
            API_URL, json={"query": query, "variables": variables}, headers=self.headers
        )
        retry_after = _retry_after(response.headers.get("Retry-After"))
        if response.status_code == 429:
            raise ConnectorRateLimited("Fireflies rate limited", retry_after=retry_after)
        if response.status_code == 403:
            raise FirefliesForbidden("Fireflies refused the request (403)")
        if response.status_code == 401:
            raise ConnectorAuthError(f"Fireflies rejected the API key ({response.status_code})")
        try:
            body = response.json()
        except ValueError:
            body = None
        if not isinstance(body, dict):
            # Never read as "no meetings": a full pass would delete everything stored.
            raise ConnectorError(
                f"Fireflies answered HTTP {response.status_code} with something other than JSON"
            )
        errors = body.get("errors") or []
        for error in errors:
            code = str((error.get("extensions") or {}).get("code") or error.get("code") or "")
            code = code.lower()
            message = error.get("message") or code
            if code == "forbidden":
                raise FirefliesForbidden(f"Fireflies refused the request: {message}")
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
        data = body.get("data")
        if not isinstance(data, dict):
            raise ConnectorError("Fireflies answered without data")
        return data

    async def transcripts(self, **variables: Any) -> list[dict[str, Any]]:
        """One page of the transcripts list. A missing list is an error, never an empty
        page: a full pass would otherwise delete everything stored."""
        page = (await self.query(LIST_QUERY, **variables)).get("transcripts")
        if not isinstance(page, list) or not all(isinstance(e, dict) and e.get("id") for e in page):
            raise ConnectorError("Fireflies answered without a list of transcripts")
        return page


def fingerprint(config: dict[str, Any]) -> str:
    """What the config selects, as a short hash (``labels`` only name things)."""
    chosen = {k: v for k, v in config.items() if k != "labels"}
    return hashlib.sha256(json.dumps(chosen, sort_keys=True).encode()).hexdigest()[:16]


def _cursor(
    selected: str,
    since: datetime | None,
    listed: datetime | None,
    recent: dict[str, str],
    aliases: set[str],
) -> dict[str, Any]:
    cursor: dict[str, Any] = {"recent": dict(recent)}
    if since is not None:
        cursor = {"since": _iso(since), **cursor}
    # Only past ``since``: the newest meeting listed, when it was not picked.
    if listed is not None and (since is None or listed > since):
        cursor["listed"] = _iso(listed)
    if aliases:
        cursor["aliases"] = sorted(aliases)
    cursor["selection"] = selected
    return cursor


def _without_selection(cursor: dict[str, Any] | None) -> dict[str, Any] | None:
    return None if cursor is None else {k: v for k, v in cursor.items() if k != "selection"}


class FirefliesConnector:
    kind = "fireflies"
    # sync takes ``known``: see oracle.sources.base.Connector.
    prunes = True

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
        selection(config)
        async with self._session(credential) as fireflies:
            data = await fireflies.query(USER_QUERY)
            if not data.get("user"):
                raise ConnectorAuthError("Fireflies did not return the key's user")

    async def _pages(
        self, fireflies: _Fireflies, variables: dict[str, Any], max_pages: int | None = None
    ) -> AsyncIterator[list[dict[str, Any]]]:
        """Pages of the transcripts list, newest first, until a short page."""
        skip = 0
        while max_pages is None or skip < max_pages * PAGE_SIZE:
            page = await fireflies.transcripts(limit=PAGE_SIZE, skip=skip, **variables)
            yield page
            if len(page) < PAGE_SIZE:
                return
            skip += PAGE_SIZE

    async def sync(
        self,
        config: dict[str, Any],
        credential: dict[str, Any] | None,
        cursor: dict[str, Any] | None,
        known: Callable[[], Awaitable[set[str]]] | None = None,
    ) -> AsyncIterator[SyncEvent]:
        picked = selection(config)
        selected = fingerprint(config)
        # Saved under another selection (a sync that was still running when the source
        # was narrowed saves its cursor after the reset): start over with a full pass,
        # which deletes what the selection no longer takes. Cursors from before the
        # fingerprint carry none and are kept.
        if cursor and cursor.get("selection", selected) != selected:
            cursor = None
        since = _parse_date((cursor or {}).get("since"))
        listed_before = _parse_date((cursor or {}).get("listed"))
        recent: dict[str, str] = dict((cursor or {}).get("recent") or {})
        aliases = {a for a in (cursor or {}).get("aliases") or [] if isinstance(a, str)}
        position = max((d for d in (since, listed_before) if d), default=None)
        stop = position - OVERLAP if position else picked.date_from
        if position and picked.date_from and picked.date_from > stop:
            stop = picked.date_from
        # A full pass (no position) knows the whole selection, so it can prune.
        stored = await known() if known is not None and position is None else None

        async with self._session(credential) as fireflies:
            variables: dict[str, Any] = {}
            if stop:
                variables["fromDate"] = _iso(stop)
            if picked.date_to_end:
                variables["toDate"] = _iso(picked.date_to_end - timedelta(milliseconds=1))
            # Newest first: page until a transcript is older than the stop date.
            listed: list[tuple[datetime | None, dict[str, Any]]] = []
            newest_listed = listed_before
            done = False
            async for page in self._pages(fireflies, variables):
                for entry in page:
                    when = _parse_date(entry.get("date"))
                    if stop and when and when < stop:
                        done = True
                        break
                    listed.append((when, entry))
                    if when and (newest_listed is None or when > newest_listed):
                        newest_listed = when
                    if series_key(entry) in picked.series and len(aliases) < MAX_ALIASES:
                        aliases.add(title_key(entry))
                if done:
                    break

            learned = frozenset(aliases)
            matched: set[str] = set()
            pending: list[tuple[datetime, dict[str, Any], bool]] = []
            for when, entry in listed:
                if not picked.matches(entry, when, learned):
                    continue
                matched.add(entry["id"])
                if entry["id"] in recent:
                    continue
                fetch = stored is None or entry["id"] not in stored
                pending.append((when or datetime.min.replace(tzinfo=UTC), entry, fetch))

            for external_id in sorted((stored or set()) - matched):
                yield ItemDelete(external_id)

            # Oldest first, so each checkpoint covers everything before it.
            pending.sort(key=lambda p: p[0])
            newest = since
            written = cursor or None
            for when, entry, fetch in pending:
                if fetch:
                    data = await fireflies.query(DETAIL_QUERY, id=entry["id"])
                    transcript = data.get("transcript")
                    if transcript:
                        yield self._item(transcript)
                if newest is None or when > newest:
                    newest = when
                recent[entry["id"]] = _iso(when)
                horizon = newest - OVERLAP
                recent = {i: d for i, d in recent.items() if _parse_date(d) >= horizon}
                if fetch:
                    written = _cursor(selected, newest, listed_before, recent, aliases)
                    yield CursorCheckpoint(written)
            # The whole listing is done: the position moves to the newest meeting listed,
            # picked or not. Written whenever it changed, deletes and all.
            end = max((d for d in (newest, newest_listed) if d), default=None)
            if end is not None:
                recent = {i: d for i, d in recent.items() if _parse_date(d) >= end - OVERLAP}
            final = _cursor(selected, newest, newest_listed, recent, aliases)
            # The fingerprint alone is no change (cursors saved before it lack it).
            if _without_selection(final) != _without_selection(written):
                yield CursorCheckpoint(final)

    async def browse_meetings(
        self,
        credential: dict[str, Any] | None,
        *,
        search: str,
        date_from: date | None,
        date_to: date | None,
        skip: int,
    ) -> MeetingPage:
        """One page of the key's meetings, newest first, for the picker."""
        variables: dict[str, Any] = {"limit": PAGE_SIZE, "skip": skip, **_range(date_from, date_to)}
        if search.strip():
            variables.update(keyword=search.strip()[:255], scope="title")
        async with self._session(credential) as fireflies:
            page = await fireflies.transcripts(**variables)
        return MeetingPage(
            meetings=[_meeting(e) for e in page],
            next_skip=skip + PAGE_SIZE if len(page) >= PAGE_SIZE else None,
        )

    async def browse_series(
        self, credential: dict[str, Any] | None, *, date_from: date | None, date_to: date | None
    ) -> SeriesList:
        """The key's meetings grouped into series, newest first (at most SERIES_PAGES
        pages of meetings are read)."""
        groups: dict[str, Series] = {}
        scanned = 0
        truncated = False
        async with self._session(credential) as fireflies:
            async for page in self._pages(fireflies, _range(date_from, date_to), SERIES_PAGES):
                for entry in page:
                    scanned += 1
                    m = _meeting(entry)
                    group = groups.get(m.series_key)
                    if group is None:
                        # Pages are newest first: the first meeting seen names the series.
                        groups[m.series_key] = Series(
                            m.series_key, m.series_title, 1, m.date, m.organizer
                        )
                    else:
                        group.meeting_count += 1
                        if m.date and (group.last_date is None or m.date > group.last_date):
                            group.last_date = m.date
                truncated = len(page) >= PAGE_SIZE and scanned >= SERIES_PAGES * PAGE_SIZE
        ordered = sorted(
            groups.values(),
            key=lambda g: g.last_date or datetime.min.replace(tzinfo=UTC),
            reverse=True,
        )
        return SeriesList(series=ordered, truncated=truncated, scanned=scanned)

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
