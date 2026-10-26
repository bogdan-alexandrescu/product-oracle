"""Fireflies: one user's meeting transcripts.

credential ``{"api_key", "endpoint"?}`` (``endpoint``: an owner-set GraphQL endpoint, else
Fireflies' own); config, as the browse screen saves it (S5, owner 2026-10-19)::

    {"mode": "all" | "selected", "date_from"?: ISO date, "date_to"?: ISO date,
     "timezone"?: IANA zone, "series": [series keys], "meetings": [transcript ids],
     "labels"?: {key or id: title}}

``all`` takes every meeting in the date range; ``selected`` takes every meeting of the
picked recurring series (past and future, so a new one is picked up on the next sync)
plus the picked meetings, within the date range when one is set. ``date_to`` is
inclusive; the days are whole days in ``timezone`` (#401: the Company time zone, which
the picker saves beside them; UTC for configs saved without one); no ``date_to`` means
ongoing. ``labels`` only remembers what
the picker showed, for the web UI.

Configs saved before the picker still work and read as a *title rule*: a config without
``mode`` is ``all`` from ``from_date``, keeping only titles that contain one of
``title_contains`` (or of ``meetings``, where the old web form put title filters).

A series is a calendar series, keyed by the transcript's ``calendar_id`` (the calendar
provider's event id, https://docs.fireflies.ai/schema/transcript; ``cal:<id>``, a Google
instance suffix ``_YYYYMMDDTHHMMSSZ``, a 'this and following' split ``_R<start>`` and
``@google.com`` removed). A picked series takes exactly the meetings of that calendar
series, the ones the picker counts. A meeting without a calendar id is in no series: only
picking it takes it.

Each transcript becomes one ``transcript`` item: the summary (overview, action items,
keywords) followed by the sentences as ``speaker: text``. The item's ``acl`` records
the participants for reference only: nothing reads it, and a source's items are visible
only to its owner (S3).

Cursor::

    {"since": "2026-10-01T09:00:00Z", "listed": "2026-10-03T15:00:00Z",
     "recent": {"id1": "2026-10-01T09:00:00Z"}, "missing": {"id2": 1},
     "selection": "3f2a9c0d1e4b5a6c"}

``since`` is the date of the newest transcript synced; ``listed`` that of the newest
meeting listed when it is later (one not picked), so the position moves on even when
nothing new is picked and an old pick does not make every sync list the account's
history since then. Neither goes past the time of the sync. Fireflies can finish
processing an earlier meeting after a later one, so a sync reads back ``OVERLAP`` (three
days) before the position and skips the ids in ``recent`` (those synced within that
window, with their dates). A meeting listed whose transcript Fireflies does not return
yet is counted in ``missing`` and the position stays before it, so the next sync asks
again; after ``MISSING_TRIES`` asks it is skipped.

``selection`` is a fingerprint of what the config selects (``labels`` aside), so a
change of labels alone keeps the position (:meth:`FirefliesConnector.rescope_cursor`).

When the selection changed, the engine (oracle.sources.sync) first deletes the stored
items outside the new date range (:meth:`FirefliesConnector.scope`), then the cursor is
rescoped to none: a pass without a position (a new source, or one whose config changed)
lists the whole date range: stored items no longer picked are deleted, stored items still
picked are not fetched again. The engine passes ``known`` (the source's stored ids) for
this. A sync still running when the source changes saves nothing more (the engine's
writes are conditional), so a cursor of another selection never reaches ``sync``.
"""

import hashlib
import ipaddress
import json
import logging
import math
import re
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta, tzinfo
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import urlsplit

import httpx

from oracle.baseline.public_links import (
    LinkError,
    _check_url,
    guarded_transport,
    public_address,
    system_resolve,
)
from oracle.sources.base import (
    ConnectorAuthError,
    ConnectorConfigError,
    ConnectorError,
    ConnectorForbidden,
    ConnectorRateLimited,
    CursorCheckpoint,
    ItemDelete,
    ItemUpsert,
    Scope,
    SyncEvent,
    config_zone,
    register,
    scope_narrows,
    zone_midnight,
)

log = logging.getLogger(__name__)

API_URL = "https://api.fireflies.ai/graphql"
# A connection reads Fireflies' own API unless an owner set another GraphQL endpoint on
# it (BGD, "Build now, owner-set, guarded"); either way every request goes through the
# guarded transport of oracle.baseline.public_links.
DEFAULT_ENDPOINT = API_URL
MAX_REDIRECTS = 5
OAUTH = None
PAGE_SIZE = 50  # the most Fireflies returns per transcripts query
# Fireflies can finish a transcript days after the meeting: each sync reads back this far.
OVERLAP = timedelta(days=3)
# A meeting Fireflies lists but answers without a transcript is asked for again on this
# many syncs (the position waits for it), then skipped.
MISSING_TRIES = 3
# The series list reads at most this many pages of meetings (the newest 300), so it
# leaves most of the browse budget to Search and Load more.
SERIES_PAGES = 6
MAX_SERIES = 200
MAX_MEETINGS = 2000
# The picker keeps a label for each pick only.
MAX_LABELS = MAX_SERIES + MAX_MEETINGS
# The longest calendar id read as a series (longer ones are in no series), meeting id
# picked, and label (the title the picker showed).
MAX_CALENDAR_ID = 512
MAX_SERIES_KEY = len("cal:") + MAX_CALENDAR_ID
MAX_MEETING_ID = 256
MAX_LABEL = 500
# Fireflies' keyword search takes at most this many characters.
MAX_SEARCH = 255

# Longer waits Fireflies asks for are read as this (a day).
MAX_RETRY_AFTER = 86_400.0

# The dates a meeting can have. A sync skips a meeting dated outside them (positions are
# computed back from dates: one near year 1 would overflow on every sync).
EARLIEST = datetime(2000, 1, 1, tzinfo=UTC)
LATEST = datetime(2200, 1, 1, tzinfo=UTC)

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
    calendar_id
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


def _fireflies_date(value: Any) -> datetime | None:
    """A date Fireflies sent; None when it is missing, unreadable or out of range."""
    try:
        parsed = _parse_date(value)
    except (ValueError, OverflowError, OSError, TypeError):
        return None
    return parsed if parsed is None or EARLIEST <= parsed < LATEST else None


def _out_of_range(value: Any) -> bool:
    """Whether Fireflies sent a readable date no meeting can have (before EARLIEST or from
    LATEST on). An unreadable one is no date, as before."""
    try:
        parsed = _parse_date(value)
    except (ValueError, OverflowError, OSError, TypeError):
        return False
    return parsed is not None and not EARLIEST <= parsed < LATEST


def _cursor_date(value: Any) -> datetime | None:
    """A date of a saved cursor; None (no position) when unreadable or out of range."""
    if not isinstance(value, str):
        return None
    return _fireflies_date(value)


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


_DAY_FORMAT = re.compile(r"\d{4}-\d{2}-\d{2}")


def _config_day(config: dict[str, Any], key: str, next_day: bool = False) -> datetime | None:
    """A picker date: a plain YYYY-MM-DD day, read as its start (or, ``next_day``, the
    start of the day after it) in the config's zone (``timezone``, the Company time zone
    the picker saved; UTC without one)."""
    value = config.get(key)
    if value is None or value == "":
        return None
    if not isinstance(value, str) or not _DAY_FORMAT.fullmatch(value):
        raise ConnectorConfigError(f"{key} must be a date (YYYY-MM-DD)")
    try:
        day = date.fromisoformat(value)
    except ValueError as e:
        raise ConnectorConfigError(f"{key} must be a date (YYYY-MM-DD)") from e
    # date_to is used as the day after it: the last representable day cannot be.
    if day >= date.max:
        raise ConnectorConfigError(f"{key} is out of range")
    return zone_midnight(day + timedelta(days=1) if next_day else day, config_zone(config))


def _retry_after(value: str | None) -> float | None:
    """Retry-After in seconds, or as an HTTP date; None when unreadable."""
    if not value:
        return None
    try:
        seconds = float(value)
    except ValueError:
        pass
    else:
        # "inf" and "nan" parse as floats.
        return min(max(seconds, 0.0), MAX_RETRY_AFTER) if math.isfinite(seconds) else None
    try:
        when = parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError):
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    wait = (when - datetime.now(UTC)).total_seconds()
    return min(wait, MAX_RETRY_AFTER) if wait > 0 else None


def _strings(config: dict[str, Any], key: str, limit: int, length: int | None = None) -> list[str]:
    value = config.get(key) or []
    if not isinstance(value, list) or not all(isinstance(v, str) and v.strip() for v in value):
        raise ConnectorConfigError(f"{key} must be a list of strings")
    if len(value) > limit:
        raise ConnectorConfigError(f"{key} takes at most {limit} entries")
    if length is not None and any(len(v.strip()) > length for v in value):
        raise ConnectorConfigError(f"{key} entries take at most {length} characters")
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
# One trailing date or number after a space or separator: " - Oct 14", " #12", " (10/14)".
# No quantifier is nested in another: series_title strips one suffix at a time.
_SUFFIX = re.compile(rf"(?:\s*[-\u2013\u2014:|,]\s*|\s+)\(?{_DATED}\)?\s*$", re.IGNORECASE)
# The longest suffix _SUFFIX matches, but for a run of digits: a separator (" - ", "("),
# a weekday ("wednesday., "), a month ("september."), a day ("14th"), a year (", 2026").
_SUFFIX_WINDOW = 64
# Google Calendar instance ids are the recurring event's id plus the instance start
# (_YYYYMMDDTHHMMSSZ); 'this and following' splits the series into <id>_R<start>, whose
# instances add their own start. Either may end in "@google.com".
_INSTANCE = re.compile(r"(?:_R\d{8}(?:T\d{6}Z?)?)?(?:_\d{8}(?:T\d{6}Z?)?)?$")
_GOOGLE_DOMAIN = re.compile(r"@google\.com$", re.IGNORECASE)


def series_title(title: str | None) -> str:
    """The title with trailing dates and numbers removed, case kept.

    Bounded whatever Fireflies returns, so it runs inline: the title is cut to MAX_TITLE
    characters with single spaces, each round strips at least two characters (so at most
    MAX_TITLE / 2 rounds), and each round tries _SUFFIX, which nests no quantifiers, only
    from the last _SUFFIX_WINDOW characters. Worst case about 3 ms."""
    text = " ".join((title or "").split())[:MAX_TITLE].strip()
    while True:
        found = _SUFFIX.search(text, max(0, len(text) - _SUFFIX_WINDOW))
        shorter = text[: found.start()].strip() if found else text
        # Nothing but a suffix ("- 12") is kept as it is.
        if shorter == text or not shorter:
            return text or "Untitled meeting"
        text = shorter


def series_key(entry: dict[str, Any]) -> str | None:
    """The calendar series a transcript belongs to; None without a calendar id."""
    calendar = entry.get("calendar_id")
    if not isinstance(calendar, str) or len(calendar) > MAX_CALENDAR_ID + len("@google.com"):
        return None
    calendar = _GOOGLE_DOMAIN.sub("", calendar.strip())
    calendar = _INSTANCE.sub("", calendar) or calendar
    return f"cal:{calendar}" if calendar and len(calendar) <= MAX_CALENDAR_ID else None


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

    def matches(self, entry: dict[str, Any], when: datetime | None) -> bool:
        """Whether the selection takes this transcript: in ``selected`` mode, a picked
        meeting or a meeting of a picked calendar series."""
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
        return entry.get("id") in self.meetings or series_key(entry) in self.series


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
    config_zone(config)
    date_from = _config_day(config, "date_from") or _config_date(config, "from_date")
    date_to = _config_day(config, "date_to")
    if date_from and date_to and date_to < date_from:
        raise ConnectorConfigError("date_to must be on or after date_from")
    # The start of the day after date_to in the zone (a DST day is not 24 hours).
    date_to_end = _config_day(config, "date_to", next_day=True)
    series = frozenset(_strings(config, "series", MAX_SERIES, MAX_SERIES_KEY))
    if not all(key.startswith("cal:") for key in series):
        raise ConnectorConfigError("series takes calendar series keys (cal:...)")
    meetings = frozenset(_strings(config, "meetings", MAX_MEETINGS, MAX_MEETING_ID))
    if mode == "selected" and not series and not meetings:
        raise ConnectorConfigError("pick at least one series or meeting, or take all meetings")
    labels = config.get("labels") or {}
    if not isinstance(labels, dict) or not all(
        isinstance(k, str) and isinstance(v, str) for k, v in labels.items()
    ):
        raise ConnectorConfigError("labels must map strings to strings")
    if len(labels) > MAX_LABELS:
        raise ConnectorConfigError(f"labels takes at most {MAX_LABELS} entries")
    if any(len(k) > MAX_SERIES_KEY or len(v) > MAX_LABEL for k, v in labels.items()):
        raise ConnectorConfigError(
            f"labels take keys of at most {MAX_SERIES_KEY} and titles of at most "
            f"{MAX_LABEL} characters"
        )
    titles = _strings(config, "title_contains", MAX_MEETINGS)
    return Selection(
        mode=mode,
        date_from=date_from,
        date_to_end=date_to_end,
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
    # None: the meeting is in no calendar series.
    series_key: str | None
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
    # Meetings outside the series with its title (a reschedule, a one-off copy), newest
    # first, at most MAX_MEETINGS.
    same_title: list[Meeting] = field(default_factory=list)


@dataclass(frozen=True)
class SeriesList:
    series: list[Series]
    # More meetings may exist than the list read (SERIES_PAGES or ``more`` stopped it).
    truncated: bool
    # Meetings read to build the list.
    scanned: int = 0


def _meeting(entry: dict[str, Any]) -> Meeting:
    duration = entry.get("duration")
    return Meeting(
        id=entry["id"],
        title=(entry.get("title") or "Untitled meeting")[:MAX_LABEL],
        date=_fireflies_date(entry.get("date")),
        duration=float(duration) if isinstance(duration, int | float) else None,
        organizer=_text(entry.get("organizer_email")),
        attendee_count=len(_participants(entry)),
        series_key=series_key(entry),
        series_title=series_title(entry.get("title")),
    )


def _range(date_from: date | None, date_to: date | None, zone: tzinfo = UTC) -> dict[str, Any]:
    """Fireflies' fromDate/toDate for whole days in ``zone`` (the Company time zone)."""
    variables: dict[str, Any] = {}
    if date_from:
        variables["fromDate"] = _iso(zone_midnight(date_from, zone))
    if date_to:
        if date_to >= date.max:
            raise ConnectorConfigError("the end date is out of range")
        end = zone_midnight(date_to + timedelta(days=1), zone)
        variables["toDate"] = _iso(end - timedelta(milliseconds=1))
    return variables


def _text(value: Any) -> str | None:
    """An optional text field Fireflies sent; None when missing or not text."""
    return value if isinstance(value, str) and value else None


def _well_formed(entry: Any) -> bool:
    """A transcript with a text id and, when it has one, a text title."""
    return (
        isinstance(entry, dict)
        and isinstance(entry.get("id"), str)
        and bool(entry["id"])
        and isinstance(entry.get("title"), str | None)
    )


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


class FirefliesForbidden(ConnectorForbidden):
    """Fireflies refused one request ("forbidden"): the key may lack access to it (a
    plan or team permission), which does not mean the key itself was revoked."""


class EndpointRefused(ConnectorConfigError):
    """An endpoint URL (or a redirect from it) Oracle does not call. The message is meant
    for people and never holds the key."""


_PRIVATE = (
    "The endpoint points to a private, local or internal network address, which "
    "Product Oracle does not call."
)


def check_endpoint(url: str | None) -> str | None:
    """The normalized endpoint, None for the default (or none); EndpointRefused unless it
    is https on the default port, without user info, query or fragment, on a host that is
    not a private, loopback, link-local, shared or reserved address. Where a host name
    resolves to is checked by the guarded transport on every connect."""
    if url is None or not url.strip():
        return None
    url = url.strip()
    try:
        parts = urlsplit(url)
        parts.port  # noqa: B018 - raises on a port that is not a number
    except ValueError as exc:
        raise EndpointRefused("The endpoint is not a valid URL.") from exc
    if parts.scheme.lower() != "https":
        raise EndpointRefused("The endpoint must be an https:// URL.")
    if parts.username is not None or parts.password is not None:
        raise EndpointRefused("The endpoint cannot contain a user name or password.")
    if parts.port not in (None, 443):
        raise EndpointRefused("The endpoint must use the standard https port (443).")
    if parts.query or parts.fragment or url.endswith(("?", "#")):
        raise EndpointRefused("The endpoint cannot have a query or a fragment.")
    try:
        normalized, host = _check_url(url)
    except LinkError as exc:
        raise EndpointRefused("The endpoint is not a valid URL.") from exc
    try:
        ipaddress.ip_address(host)
    except ValueError:
        if "." not in host:
            raise EndpointRefused(_PRIVATE) from None
    else:
        if not public_address(host):
            raise EndpointRefused(_PRIVATE)
    return None if normalized == DEFAULT_ENDPOINT else normalized


def endpoint_of(credential: dict[str, Any] | None) -> str:
    return (credential or {}).get("endpoint") or DEFAULT_ENDPOINT


def fireflies_host(endpoint: str | None) -> bool:
    """Whether the endpoint is Fireflies' own (fireflies.ai or a subdomain)."""
    host = (urlsplit(endpoint or DEFAULT_ENDPOINT).hostname or "").lower()
    return host == "fireflies.ai" or host.endswith(".fireflies.ai")


def address_refused(exc: BaseException) -> bool:
    """Whether a request failed because the guarded transport refused the address."""
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, LinkError) and current.code == "blocked_address":
            return True
        current = current.__cause__ or current.__context__
    return False


def guarded_client(resolve=None) -> httpx.AsyncClient:
    """The client for Fireflies calls: the guarded transport (public addresses only, the
    checked address is the one connected to), no environment proxy, no redirects followed
    by httpx (:func:`post` follows same-host ones by hand)."""
    return httpx.AsyncClient(
        timeout=60,
        transport=guarded_transport(resolve or system_resolve),
        follow_redirects=False,
        trust_env=False,
    )


def _origin(url: httpx.URL) -> tuple[str, str, int | None]:
    return (url.scheme, url.host.lower(), url.port)


async def post(
    client: httpx.AsyncClient, endpoint: str, api_key: str, payload: dict[str, Any]
) -> httpx.Response:
    """POST to the endpoint with the key. A redirect is followed only to the same host
    (re-checked by :func:`check_endpoint`, at most MAX_REDIRECTS); one to another host is
    refused before anything is sent there, so the key only reaches the configured host."""
    headers = {"Authorization": f"Bearer {api_key}"}
    url = httpx.URL(endpoint)
    home = _origin(url)
    for _ in range(MAX_REDIRECTS + 1):
        response = await client.post(url, json=payload, headers=headers, follow_redirects=False)
        if not response.is_redirect:
            return response
        location = response.headers.get("Location")
        await response.aclose()
        target = url.join(location) if location else None
        if target is None or _origin(target) != home:
            raise EndpointRefused(
                "The Fireflies endpoint redirected to another address, which Product "
                "Oracle does not follow (the API key is sent only to the configured host)."
            )
        try:
            check_endpoint(str(target.copy_with(query=None, fragment=None)))
        except EndpointRefused as exc:
            raise EndpointRefused(f"The Fireflies endpoint redirected badly: {exc}") from None
        url = target
    raise EndpointRefused("The Fireflies endpoint redirects too many times.")


class _Fireflies:
    def __init__(self, client: httpx.AsyncClient, api_key: str, endpoint: str = DEFAULT_ENDPOINT):
        self.client = client
        self.api_key = api_key
        self.endpoint = endpoint

    async def query(self, query: str, **variables: Any) -> dict[str, Any]:
        response = await post(
            self.client, self.endpoint, self.api_key, {"query": query, "variables": variables}
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
        if not isinstance(errors, list):
            errors = [errors]
        # Entries are objects by the GraphQL spec; anything else is read as its text.
        errors = [e if isinstance(e, dict) else {"message": str(e)} for e in errors]
        for error in errors:
            extensions = error.get("extensions")
            extensions = extensions if isinstance(extensions, dict) else {}
            code = str(extensions.get("code") or error.get("code") or "").lower()
            message = str(error.get("message") or code)
            if code == "forbidden":
                raise FirefliesForbidden(f"Fireflies refused the request: {message}")
            if code in AUTH_CODES:
                raise ConnectorAuthError(f"Fireflies rejected the API key: {message}")
            if code in RATE_CODES or "too many requests" in message.lower():
                metadata = extensions.get("metadata")
                retry_ms = metadata.get("retryAfter") if isinstance(metadata, dict) else None
                if (
                    retry_after is None
                    and isinstance(retry_ms, int | float)
                    and math.isfinite(retry_ms)
                ):
                    # Fireflies reports retryAfter as an epoch-ms timestamp.
                    wait = retry_ms / 1000 - datetime.now(UTC).timestamp()
                    retry_after = min(wait, MAX_RETRY_AFTER) if wait > 0 else None
                raise ConnectorRateLimited(f"Fireflies: {message}", retry_after=retry_after)
        if response.status_code >= 400 or errors:
            detail = str(errors[0].get("message")) if errors else f"HTTP {response.status_code}"
            raise ConnectorError(f"Fireflies query failed: {detail}")
        data = body.get("data")
        if not isinstance(data, dict):
            raise ConnectorError("Fireflies answered without data")
        return data

    async def transcripts(self, **variables: Any) -> list[dict[str, Any]]:
        """One page of the transcripts list. A missing list is an error, never an empty
        page: a full pass would otherwise delete everything stored."""
        page = (await self.query(LIST_QUERY, **variables)).get("transcripts")
        if not isinstance(page, list) or not all(isinstance(e, dict) for e in page):
            raise ConnectorError("Fireflies answered without a list of transcripts")
        return page


def _listed(page: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The page's transcripts with a text id and title; the others are skipped (noted)."""
    kept = [e for e in page if _well_formed(e)]
    if len(kept) < len(page):
        log.warning(
            "skipped %d Fireflies transcript(s) without a text id or title", len(page) - len(kept)
        )
    return kept


def fingerprint(config: dict[str, Any]) -> str:
    """What the config selects, as a short hash (``labels`` only name things)."""
    chosen = {k: v for k, v in config.items() if k != "labels"}
    return hashlib.sha256(json.dumps(chosen, sort_keys=True).encode()).hexdigest()[:16]


def _clamp(value: datetime | None, now: datetime) -> datetime | None:
    return min(value, now) if value is not None else None


def _held(value: datetime | None, held: datetime | None) -> datetime | None:
    """A position, kept just before ``held`` (a meeting whose transcript is missing)."""
    if held is None or value is None:
        return value
    return min(value, held - timedelta(milliseconds=1))


def _within(recent: dict[str, str], position: datetime | None) -> dict[str, str]:
    """The ids synced within OVERLAP of the position (a sync reads back that far)."""
    if position is None:
        return recent
    horizon = position - OVERLAP
    kept = {}
    for i, d in recent.items():
        when = _cursor_date(d)
        if when is not None and when >= horizon:
            kept[i] = d
    return kept


def _cursor(
    selected: str,
    since: datetime | None,
    listed: datetime | None,
    recent: dict[str, str],
    missing: dict[str, int] | None = None,
) -> dict[str, Any]:
    cursor: dict[str, Any] = {"recent": dict(recent)}
    if since is not None:
        cursor = {"since": _iso(since), **cursor}
    # Only past ``since``: the newest meeting listed, when it was not picked.
    if listed is not None and (since is None or listed > since):
        cursor["listed"] = _iso(listed)
    if missing:
        cursor["missing"] = dict(missing)
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
        endpoint = endpoint_of(credential)
        if self._client is not None:
            yield _Fireflies(self._client, api_key, endpoint)
            return
        async with guarded_client() as client:
            yield _Fireflies(client, api_key, endpoint)

    def check_config(self, config: dict[str, Any]) -> None:
        """The rules a saved config must still meet (the caps, the dates)."""
        selection(config)

    def normalize_config(self, config: dict[str, Any]) -> dict[str, Any]:
        """Picked series and meetings stripped, without repeats, sorted."""
        out = dict(config)
        for key in ("series", "meetings", "title_contains"):
            value = config.get(key)
            if isinstance(value, list) and all(isinstance(v, str) for v in value):
                out[key] = sorted({v.strip() for v in value})
        return out

    def scope(self, config: dict[str, Any]) -> Scope:
        """Still selected, as far as stored items tell: dated inside the date range and,
        in ``selected`` mode, a picked meeting or in a picked series (each item stores its
        meeting id and series key), so a save deletes the unpicked with no Fireflies call."""
        picked = selection(config)
        picks = None
        if picked.mode == "selected" and not picked.titles:
            picks = (("meeting", picked.meetings), ("series", picked.series))
        return Scope(
            occurred_from=picked.date_from, occurred_before=picked.date_to_end, provenance=picks
        )

    def narrows(self, old: dict[str, Any], new: dict[str, Any]) -> bool:
        """Whether ``new`` only takes less than ``old`` (no provider call needed to save
        it). A title rule (a config saved before the picker) filters at Fireflies, which
        the stored items cannot show: changing from or to one is never a pure narrowing."""
        before, after = selection(old), selection(new)
        if before.titles or after.titles or before.legacy or after.legacy:
            return False
        return scope_narrows(self.scope(old), self.scope(new))

    def rescope_cursor(
        self, old_cursor: dict[str, Any] | None, new_config: dict[str, Any]
    ) -> dict[str, Any] | None:
        """Another selection: start over with a full pass, which deletes what is no longer
        picked. New labels alone (they only name things) keep the position."""
        if old_cursor and old_cursor.get("selection") == fingerprint(new_config):
            return old_cursor
        return None

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
        now = datetime.now(UTC)
        # A position past now (a meeting Fireflies dated in the future) would skip what
        # is recorded until then.
        since = _clamp(_cursor_date((cursor or {}).get("since")), now)
        listed_before = _clamp(_cursor_date((cursor or {}).get("listed")), now)
        recent: dict[str, str] = {
            i: d
            for i, d in dict((cursor or {}).get("recent") or {}).items()
            if _cursor_date(d) is not None
        }
        missing: dict[str, int] = {
            i: n
            for i, n in ((cursor or {}).get("missing") or {}).items()
            if isinstance(n, int) and not isinstance(n, bool)
        }
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
            # Newest first: an incremental sync pages until a transcript is older than the
            # stop date. A full pass reads every page and skips such a transcript (it
            # prunes what it did not list, so it must not stop on one out of order).
            listed: list[tuple[datetime | None, dict[str, Any]]] = []
            newest_listed = listed_before
            done = False
            out_of_range = 0
            async for page in self._pages(fireflies, variables):
                for entry in _listed(page):
                    if _out_of_range(entry.get("date")):
                        # Dated before EARLIEST (or after LATEST): skipped, never synced.
                        out_of_range += 1
                        continue
                    when = _fireflies_date(entry.get("date"))
                    if stop and when and when < stop:
                        if position is None:
                            continue
                        done = True
                        break
                    listed.append((when, entry))
                    seen = _clamp(when, now)
                    if seen and (newest_listed is None or seen > newest_listed):
                        newest_listed = seen
                if done:
                    break
            if out_of_range:
                log.warning("skipped %d Fireflies transcript(s) dated out of range", out_of_range)

            matched: set[str] = set()
            pending: list[tuple[datetime, dict[str, Any], bool]] = []
            for when, entry in listed:
                if not picked.matches(entry, when):
                    continue
                matched.add(entry["id"])
                if entry["id"] in recent:
                    continue
                fetch = stored is None or entry["id"] not in stored or entry["id"] in missing
                pending.append((when or datetime.min.replace(tzinfo=UTC), entry, fetch))

            for external_id in sorted((stored or set()) - matched):
                yield ItemDelete(external_id)

            # Oldest first, so each checkpoint covers everything before it.
            pending.sort(key=lambda p: p[0])
            newest = since
            # The oldest meeting Fireflies answered without a transcript (still being
            # processed): the position stays before it, so the next sync asks again.
            held: datetime | None = None
            written = cursor or None
            for when, entry, fetch in pending:
                if fetch:
                    data = await fireflies.query(DETAIL_QUERY, id=entry["id"])
                    transcript = data.get("transcript")
                    if isinstance(transcript, dict) and transcript.get("id"):
                        missing.pop(entry["id"], None)
                        if _well_formed(transcript):
                            yield self._item(transcript)
                        else:
                            # Not stored, and not asked again: noted, then passed by.
                            log.warning("skipped a Fireflies transcript without a text title")
                    else:
                        tries = missing.get(entry["id"], 0) + 1
                        if tries < MISSING_TRIES:
                            missing[entry["id"]] = tries
                            dated = when > datetime.min.replace(tzinfo=UTC)
                            if dated and (held is None or when < held):
                                held = when
                            continue
                        # Asked MISSING_TRIES times: it is skipped from now on.
                        missing.pop(entry["id"], None)
                if when > datetime.min.replace(tzinfo=UTC):
                    when = _clamp(when, now)
                    if newest is None or when > newest:
                        newest = when
                else:
                    # Undated: it does not move the position; remembered as seen now.
                    when = newest or now
                recent[entry["id"]] = _iso(when)
                recent = _within(recent, _held(newest, held))
                if fetch:
                    written = _cursor(selected, _held(newest, held), listed_before, recent, missing)
                    yield CursorCheckpoint(written)
            # The whole listing is done: the position moves to the newest meeting listed,
            # picked or not, unless a transcript is still missing. Written whenever it
            # changed, deletes and all.
            end = _held(max((d for d in (newest, newest_listed) if d), default=None), held)
            if end is not None:
                recent = _within(recent, end)
            final = _cursor(
                selected, _held(newest, held), _held(newest_listed, held), recent, missing
            )
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
        zone: tzinfo = UTC,
    ) -> MeetingPage:
        """One page of the key's meetings, newest first, for the picker (from/to: whole
        days in ``zone``)."""
        variables: dict[str, Any] = {
            "limit": PAGE_SIZE,
            "skip": skip,
            **_range(date_from, date_to, zone),
        }
        keyword = search.strip()[:MAX_SEARCH]
        if keyword:
            variables.update(keyword=keyword, scope="title")
        async with self._session(credential) as fireflies:
            page = await fireflies.transcripts(**variables)
        return MeetingPage(
            meetings=[_meeting(e) for e in _listed(page)],
            next_skip=skip + PAGE_SIZE if len(page) >= PAGE_SIZE else None,
        )

    async def browse_series(
        self,
        credential: dict[str, Any] | None,
        *,
        date_from: date | None,
        date_to: date | None,
        more: Callable[[], Awaitable[bool]] | None = None,
        zone: tzinfo = UTC,
    ) -> SeriesList:
        """The key's meetings grouped into their calendar series, newest first, over the
        window's pages up to SERIES_PAGES: before each page after the first ``more()`` is
        asked, and a False stops the list there (truncated, as is a full last page).
        Meetings without a calendar id are in no series. A series' count is what a sync
        of it takes over the same dates."""
        groups: dict[str, Series] = {}
        by_title: dict[str, list[Meeting]] = {}
        scanned = 0
        truncated = False
        variables = _range(date_from, date_to, zone)
        async with self._session(credential) as fireflies:
            skip = 0
            while True:
                page = await fireflies.transcripts(limit=PAGE_SIZE, skip=skip, **variables)
                for entry in _listed(page):
                    scanned += 1
                    m = _meeting(entry)
                    by_title.setdefault(m.series_title.casefold(), []).append(m)
                    if m.series_key is None:
                        continue
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
                if len(page) < PAGE_SIZE:
                    break
                if skip + PAGE_SIZE >= SERIES_PAGES * PAGE_SIZE or (
                    more is not None and not await more()
                ):
                    truncated = True
                    break
                skip += PAGE_SIZE
        newest_first = datetime.min.replace(tzinfo=UTC)
        for group in groups.values():
            others = [
                m for m in by_title.get(group.title.casefold(), []) if m.series_key != group.key
            ]
            others.sort(key=lambda m: m.date or newest_first, reverse=True)
            group.same_title = others[:MAX_MEETINGS]
        ordered = sorted(groups.values(), key=lambda g: g.last_date or newest_first, reverse=True)
        return SeriesList(series=ordered, truncated=truncated, scanned=scanned)

    def _item(self, transcript: dict[str, Any]) -> ItemUpsert:
        when = _fireflies_date(transcript.get("date"))
        participants = _participants(transcript)
        return ItemUpsert(
            external_id=transcript["id"],
            kind="transcript",
            title=transcript.get("title") or "Untitled meeting",
            url=_text(transcript.get("transcript_url")),
            author=_text(transcript.get("organizer_email")),
            content=_content(transcript),
            acl={"participants": participants},
            occurred_at=when,
            source_updated_at=when,
            provenance={"meeting": transcript["id"], "series": series_key(transcript)},
        )


register(FirefliesConnector())
