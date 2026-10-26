"""Fetch a public link for evidence: public Notion pages, Google Docs, public web pages.

The owner, 2026-10-17: commenters can attach evidence or supporting docs through public
links (public Notion pages, Google Docs shared with "anyone with the link", plain
public web pages) without connecting their accounts.

Every fetch is anonymous: no credential, no cookie, no proxy from the environment. The
server fetches untrusted URLs, so:

- only ``https`` on the default port, without user info in the URL;
- the host must resolve to public addresses only; private, loopback, link-local,
  shared, reserved and multicast addresses are refused, for the first request and for
  every redirect (followed by hand, at most ``MAX_REDIRECTS``). The real transport
  checks again when it connects and connects to the address it checked, so a DNS
  answer that changes in between cannot reach a private address;
- a timeout per request and for the whole fetch, a size cap on the body (counted
  after decompression), and only HTML or plain text.

A page that wants a sign-in (401 / 403, a redirect to a sign-in page, a Notion page
that renders only the app shell) is "not public".

Text: Google Docs through the public export (``/export?format=txt``), titled from the
export's file name; Notion pages from their HTML (the page content, else the page's
description); other pages from their main text (``<main>``, else ``<article>``, else
the body without navigation, header, footer and scripts). The page's last change comes
from the ``Last-Modified`` header, else from what the page states (``article:modified_time``,
``og:updated_time``, ``dateModified``).
"""

import asyncio
import email.utils
import hashlib
import ipaddress
import json
import re
import socket
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from html.parser import HTMLParser
from typing import Any
from urllib.parse import unquote, urljoin, urlsplit, urlunsplit

import httpcore
import httpx

MAX_BYTES = 2_000_000
MAX_TEXT_CHARS = 200_000
MAX_REDIRECTS = 5
REQUEST_TIMEOUT = 10.0
TOTAL_TIMEOUT = 20.0
# Notion serves a public page's content only to link-preview bots (others get the app
# shell, which renders it with JavaScript), so the fetcher says it is one.
USER_AGENT = "Mozilla/5.0 (compatible; ProductOracleBot/1.0; +public link evidence)"
ALLOWED_TYPES = ("text/html", "application/xhtml+xml", "text/plain")

NOTION_HOSTS = ("notion.so", "www.notion.so")
NOTION_SITE_SUFFIX = ".notion.site"
GOOGLE_DOCS_HOST = "docs.google.com"
_GDOC_RE = re.compile(r"^/document/(?:u/\d+/)?d/([A-Za-z0-9_-]{20,})(?:/|$)")
_GDOC_PUB_RE = re.compile(r"^/document/d/e/([A-Za-z0-9_-]{20,})/pub")
_SIGN_IN_PATH = re.compile(
    r"/(login|log-in|signin|sign-in|servicelogin)(/|$)",
    re.IGNORECASE,
)
_SIGN_IN_HOSTS = ("accounts.google.com",)
# " | Notion" ending a page title. Starts only where a whitespace run starts, so a long run
# is scanned once (linear).
_NOTION_SUFFIX = re.compile(r"(?<!\s)\s*+[|–-]\s*+Notion$")
# Titles Notion gives a page it does not show to anonymous readers.
_NOTION_SHELL_TITLES = {
    "",
    "notion",
    "notion – the all-in-one workspace for your notes, tasks, wikis, and databases.",
}


def notion_shell(title: str | None) -> bool:
    """Notion's app shell (what it shows when it will not render a page), by its title."""
    t = (title or "").strip().lower()
    return t in _NOTION_SHELL_TITLES or t.startswith(("notion |", "notion –", "notion - "))


_NAT64 = ipaddress.ip_network("64:ff9b::/96")

NOT_PUBLIC = (
    "This link is not public: the page asks for a sign-in. Share it publicly (a public "
    "Notion page, or a Google Doc shared with anyone with the link) and try again."
)


class LinkError(Exception):
    """A link that cannot be used as evidence; ``code`` says why."""

    def __init__(self, code: str, message: str, status_code: int = 422):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


@dataclass(frozen=True)
class Target:
    """What to fetch for a URL the user gave."""

    url: str  # the URL as cited (fragment removed)
    kind: str  # "notion" | "google_docs" | "web"
    fetch_url: str  # what is fetched (the Google Docs export for a Google Doc)


@dataclass(frozen=True)
class Page:
    url: str
    kind: str
    final_url: str
    title: str | None
    text: str
    content_type: str | None
    fetched_at: datetime
    last_modified: datetime | None

    @property
    def content_hash(self) -> str:
        return hashlib.sha256(f"{self.title or ''}\n{self.text}".encode()).hexdigest()


# --- URLs -----------------------------------------------------------------------------------


# Host names that only ever mean a local or internal machine.
_LOCAL_SUFFIXES = (".localhost", ".local", ".internal", ".home.arpa", ".lan", ".intranet")


def _private_host(host: str) -> bool:
    """An IP literal that is not public, or a name that only means a local machine."""
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return host == "localhost" or "." not in host or host.endswith(_LOCAL_SUFFIXES)
    return not public_address(host)


def check_url(url: str) -> tuple[str, str]:
    """(normalized url, host) for an https URL on the default port, with no user name, to
    a host that is not a private IP literal or a local name; LinkError otherwise. The one
    URL check for every page Oracle fetches (evidence links, watched pages); a public
    name resolving to a private address is refused at connect (:func:`guarded_transport`)."""
    url = (url or "").strip()
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError as exc:
        raise LinkError("invalid_url", "That is not a valid URL.") from exc
    if parts.scheme.lower() != "https":
        raise LinkError("not_https", "Only https:// links can be added as evidence.")
    host = (parts.hostname or "").rstrip(".").lower()
    if not host:
        raise LinkError("invalid_url", "That is not a valid URL.")
    if parts.username is not None or parts.password is not None:
        raise LinkError("invalid_url", "Links with a user name or password cannot be added.")
    if port not in (None, 443):
        raise LinkError("invalid_url", "Only links on the standard https port can be added.")
    if _private_host(host):
        raise LinkError(
            "blocked_address",
            "This link points to a private, local or internal network address, "
            "which Product Oracle does not fetch.",
        )
    netloc = host if ":" not in host else f"[{host}]"
    return urlunsplit(("https", netloc, parts.path or "/", parts.query, "")), host


def classify(url: str) -> Target:
    """The kind of a link and what to fetch for it."""
    url, host = check_url(url)
    path = urlsplit(url).path
    if host == GOOGLE_DOCS_HOST:
        if m := _GDOC_PUB_RE.match(path):
            return Target(url, "google_docs", f"https://{host}/document/d/e/{m.group(1)}/pub")
        if m := _GDOC_RE.match(path):
            doc_id = m.group(1)
            return Target(
                url, "google_docs", f"https://{host}/document/d/{doc_id}/export?format=txt"
            )
        raise LinkError(
            "unsupported_link",
            "Only Google Docs documents can be added from docs.google.com "
            "(not Sheets, Slides or Forms).",
        )
    if host in NOTION_HOSTS or host.endswith(NOTION_SITE_SUFFIX):
        return Target(url, "notion", url)
    return Target(url, "web", url)


def _sign_in(url: str) -> bool:
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    return host in _SIGN_IN_HOSTS or bool(_SIGN_IN_PATH.search(parts.path or "/"))


# --- addresses ------------------------------------------------------------------------------


def public_address(address: str) -> bool:
    """True for a globally routable unicast address."""
    try:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            ip = ip.ipv4_mapped
        elif ip in _NAT64:
            ip = ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
        elif ip.sixtofour is not None or ip.teredo is not None:
            return False
    return ip.is_global and not ip.is_multicast


Resolver = Callable[[str, int], Awaitable[list[str]]]


async def system_resolve(host: str, port: int) -> list[str]:
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return list(dict.fromkeys(info[4][0] for info in infos))


async def public_addresses(host: str, port: int, resolve: Resolver) -> list[str]:
    """The host's addresses if every one is public; LinkError otherwise."""
    try:
        ipaddress.ip_address(host)
        addresses = [host]
    except ValueError:
        try:
            addresses = await resolve(host, port)
        except (OSError, UnicodeError) as exc:
            raise LinkError("unreachable", f"Could not find the site {host}.", 502) from exc
    if not addresses:
        raise LinkError("unreachable", f"Could not find the site {host}.", 502)
    if not all(public_address(a) for a in addresses):
        raise LinkError(
            "blocked_address",
            "This link points to a private, local or internal network address, "
            "which Product Oracle does not fetch.",
        )
    return addresses


class _GuardedBackend(httpcore.AsyncNetworkBackend):
    """Connects only to public addresses: resolves, checks, then connects to the IP."""

    def __init__(self, resolve: Resolver):
        self._inner = httpcore.AnyIOBackend()
        self._resolve = resolve

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[Any] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        try:
            addresses = await public_addresses(host, port, self._resolve)
        except LinkError as exc:
            raise httpcore.ConnectError(str(exc)) from exc
        last: Exception | None = None
        for address in addresses:
            try:
                return await self._inner.connect_tcp(
                    address,
                    port,
                    timeout=timeout,
                    local_address=local_address,
                    socket_options=socket_options,
                )
            except (httpcore.ConnectError, httpcore.ConnectTimeout, OSError) as exc:
                last = exc
        raise httpcore.ConnectError(str(last) if last else f"cannot connect to {host}")

    async def connect_unix_socket(self, *args: Any, **kwargs: Any) -> httpcore.AsyncNetworkStream:
        raise httpcore.ConnectError("unix sockets are not fetched")

    async def sleep(self, seconds: float) -> None:
        await self._inner.sleep(seconds)


def guarded_transport(resolve: Resolver = system_resolve) -> httpx.AsyncHTTPTransport:
    transport = httpx.AsyncHTTPTransport(retries=0)
    # httpx does not take a network backend; its pool does (the TLS name stays the host).
    transport._pool = httpcore.AsyncConnectionPool(
        ssl_context=httpx.create_ssl_context(),
        max_connections=4,
        network_backend=_GuardedBackend(resolve),
    )
    return transport


# --- text -----------------------------------------------------------------------------------

_SKIP = {
    "script",
    "style",
    "noscript",
    "template",
    "svg",
    "nav",
    "header",
    "footer",
    "aside",
    "form",
    "button",
    "iframe",
    "select",
    "head",
}
_VOID = {
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
}
_BLOCK = {
    "p",
    "div",
    "li",
    "ul",
    "ol",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "br",
    "tr",
    "section",
    "article",
    "main",
    "blockquote",
    "pre",
    "table",
    "hr",
    "dd",
    "dt",
}
_MODIFIED_META = (
    "article:modified_time",
    "og:updated_time",
    "last-modified",
    "datemodified",
    "dc.date.modified",
)


class _Extractor(HTMLParser):
    """Title, metadata and text of the containers a reader cares about."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[tuple[str, frozenset[str]]] = []
        self.buffers: dict[str, list[str]] = {
            "notion": [],
            "main": [],
            "article": [],
            "body": [],
        }
        self.title_parts: list[str] = []
        self.meta: dict[str, str] = {}
        self.ld_json: list[str] = []
        self._in_title = False
        self._in_ld = False

    def _flags(self) -> set[str]:
        out: set[str] = set()
        for _, f in self.stack:
            out |= f
        return out

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "meta":
            key = (a.get("property") or a.get("name") or a.get("itemprop") or "").lower()
            key = key or (a.get("http-equiv") or "").lower()
            if key and a.get("content") and key not in self.meta:
                self.meta[key] = a["content"].strip()
            return
        if tag == "title":
            self._in_title = True
        if tag == "script" and "ld+json" in a.get("type", "").lower():
            self._in_ld = True
        if tag in _BLOCK:
            self._newline()
        if tag in _VOID:
            return
        flags: set[str] = set()
        if tag in _SKIP:
            flags.add("skip")
        if tag == "main" or a.get("role") == "main":
            flags.add("main")
        if tag == "article":
            flags.add("article")
        if tag == "body":
            flags.add("body")
        if "notion-page-content" in a.get("class", "").split():
            flags.add("notion")
        self.stack.append((tag, frozenset(flags)))

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if tag not in _VOID and self.stack and self.stack[-1][0] == tag:
            self.stack.pop()

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False
        if tag == "script":
            self._in_ld = False
        if tag in _BLOCK:
            self._newline()
        if tag in _VOID:
            return
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                break

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title_parts.append(data)
            return
        if self._in_ld:
            self.ld_json.append(data)
            return
        flags = self._flags()
        if "skip" in flags:
            return
        for name in ("notion", "main", "article"):
            if name in flags:
                self.buffers[name].append(data)
        self.buffers["body"].append(data)

    def _newline(self) -> None:
        for buf in self.buffers.values():
            if buf and buf[-1] != "\n":
                buf.append("\n")

    def text(self, *order: str) -> str:
        for name in order:
            text = clean_text("".join(self.buffers[name]))
            if text:
                return text
        return ""

    @property
    def title(self) -> str | None:
        title = self.meta.get("og:title") or " ".join("".join(self.title_parts).split())
        return title or None


def clean_text(text: str) -> str:
    lines = (" ".join(line.split()) for line in text.replace("\r", "\n").split("\n"))
    out = "\n".join(lines)
    return re.sub(r"\n{3,}", "\n\n", out).strip()


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    value = value.strip()
    try:
        parsed = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError):
        parsed = None
    if parsed is None:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _ld_modified(blobs: list[str]) -> str | None:
    def walk(node: Any) -> str | None:
        if isinstance(node, dict):
            if isinstance(node.get("dateModified"), str):
                return node["dateModified"]
            for v in node.values():
                if found := walk(v):
                    return found
        elif isinstance(node, list):
            for v in node:
                if found := walk(v):
                    return found
        return None

    for blob in blobs:
        try:
            if found := walk(json.loads(blob)):
                return found
        except ValueError:
            continue
    return None


def _strip_title(title: str | None, kind: str) -> str | None:
    if title and kind == "notion":
        title = _NOTION_SUFFIX.sub("", title).strip()
    return title or None


def extract_html(html: str, kind: str) -> tuple[str | None, str, datetime | None]:
    """(title, text, stated last change) of an HTML page."""
    parser = _Extractor()
    parser.feed(html)
    parser.close()
    title = _strip_title(parser.title, kind)
    # Notion's prerendered page is a bare body; its app adds a page-content block.
    order = ("notion", "main", "article", "body")
    text = parser.text(*order)
    if not text:
        description = parser.meta.get("og:description") or parser.meta.get("description", "")
        text = clean_text(description)
    stated = next((parser.meta[k] for k in _MODIFIED_META if parser.meta.get(k)), None)
    modified = parse_time(stated or _ld_modified(parser.ld_json))
    return title, text, modified


def _download_name(disposition: str | None) -> str | None:
    """The file name in a Content-Disposition header, without its extension."""
    if not disposition:
        return None
    m = re.search(r"filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)", disposition)
    name = unquote(m.group(1).strip()) if m else None
    if not name:
        m = re.search(r'filename\s*=\s*"([^"]*)"', disposition) or re.search(
            r"filename\s*=\s*([^;]+)", disposition
        )
        name = m.group(1).strip() if m else None
    if not name:
        return None
    # "Plan.txt", or "Plan.docx.txt" for an uploaded Word file.
    name = re.sub(r"\.(txt|html?)$", "", name, flags=re.IGNORECASE)
    return re.sub(r"\.(docx?|odt|rtf)$", "", name, flags=re.IGNORECASE).strip() or None


# --- fetching -------------------------------------------------------------------------------


class LinkFetcher:
    """Fetches public links. Tests pass a mock transport and resolver."""

    def __init__(
        self,
        transport: httpx.AsyncBaseTransport | None = None,
        resolve: Resolver = system_resolve,
        max_bytes: int = MAX_BYTES,
    ):
        self._transport = transport
        self._resolve = resolve
        self.max_bytes = max_bytes

    async def fetch(self, url: str, now: datetime | None = None) -> Page:
        target = classify(url)
        try:
            async with asyncio.timeout(TOTAL_TIMEOUT):
                return await self._fetch(target, now)
        except TimeoutError as exc:
            raise LinkError("timeout", "The page took too long to respond.", 504) from exc

    async def _fetch(self, target: Target, now: datetime | None) -> Page:
        transport = self._transport or guarded_transport(self._resolve)
        async with httpx.AsyncClient(
            transport=transport,
            follow_redirects=False,
            trust_env=False,
            timeout=httpx.Timeout(REQUEST_TIMEOUT),
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9",
            },
        ) as client:
            response, body, final_url = await self._get(client, target.fetch_url, target.kind)
        fetched_at = now or datetime.now(UTC)
        content_type = response.headers.get("content-type", "").split(";")[0].strip().lower()
        charset = response.charset_encoding or "utf-8"
        try:
            raw = body.decode(charset, errors="replace")
        except LookupError:
            raw = body.decode("utf-8", errors="replace")
        modified = parse_time(response.headers.get("last-modified"))

        if content_type == "text/plain":
            text = clean_text(raw.lstrip("﻿"))
            title = _download_name(response.headers.get("content-disposition"))
            if not title and text:
                title = text.split("\n", 1)[0][:200]
        else:
            title, text, stated = extract_html(raw, target.kind)
            modified = modified or stated
            if target.kind == "notion" and notion_shell(title):
                raise LinkError("not_public", NOT_PUBLIC)
        if not text:
            raise LinkError("empty", "The page has no readable text to cite.")
        if modified and modified > fetched_at:
            modified = fetched_at
        return Page(
            url=target.url,
            kind=target.kind,
            final_url=final_url,
            title=title[:500] if title else None,
            text=text[:MAX_TEXT_CHARS],
            content_type=content_type or None,
            fetched_at=fetched_at,
            last_modified=modified,
        )

    async def _get(
        self, client: httpx.AsyncClient, url: str, kind: str
    ) -> tuple[httpx.Response, bytes, str]:
        for _ in range(MAX_REDIRECTS + 1):
            url, host = check_url(url)
            if _sign_in(url):
                raise LinkError("not_public", NOT_PUBLIC)
            await public_addresses(host, 443, self._resolve)
            client.cookies.clear()
            try:
                response = await client.send(client.build_request("GET", url), stream=True)
            except httpx.TimeoutException as exc:
                raise LinkError("timeout", "The page took too long to respond.", 504) from exc
            except httpx.HTTPError as exc:
                raise LinkError("unreachable", "Could not reach the page.", 502) from exc
            try:
                if response.is_redirect:
                    location = response.headers.get("location")
                    if not location:
                        raise LinkError("unreachable", "The page redirects nowhere.", 502)
                    url = urljoin(url, location)
                    continue
                self._check_status(response, kind)
                content_type = response.headers.get("content-type", "").split(";")[0].strip()
                if content_type.lower() not in ALLOWED_TYPES:
                    kind = content_type or "no type"
                    raise LinkError(
                        "unsupported_content",
                        f"The link is not a web page or text document ({kind}).",
                    )
                length = response.headers.get("content-length")
                if length and length.isdigit() and int(length) > self.max_bytes:
                    raise LinkError("too_large", self._too_large())
                body = bytearray()
                try:
                    async for chunk in response.aiter_bytes():
                        body.extend(chunk)
                        if len(body) > self.max_bytes:
                            raise LinkError("too_large", self._too_large())
                except httpx.TimeoutException as exc:
                    raise LinkError("timeout", "The page took too long to respond.", 504) from exc
                except httpx.HTTPError as exc:
                    raise LinkError("unreachable", "Could not read the page.", 502) from exc
                return response, bytes(body), url
            finally:
                await response.aclose()
        raise LinkError("unreachable", "The page redirects too many times.", 502)

    def _too_large(self) -> str:
        return f"The page is larger than {self.max_bytes / 1_000_000:g} MB."

    @staticmethod
    def _check_status(response: httpx.Response, kind: str) -> None:
        code = response.status_code
        # Notion answers a private page with 404, like a missing one.
        if code in (401, 403, 407) or (kind == "notion" and code == 404):
            raise LinkError("not_public", NOT_PUBLIC)
        if code in (404, 410):
            raise LinkError(
                "not_found",
                "The page was not found. If it exists but is private, this link is not "
                "public: share it publicly and try again.",
            )
        if code >= 400:
            raise LinkError("unreachable", f"The page answered with an error ({code}).", 502)


def get_link_fetcher() -> LinkFetcher:
    """FastAPI dependency; tests override it with a mock transport."""
    return LinkFetcher()
