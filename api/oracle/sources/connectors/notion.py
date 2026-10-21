"""Notion connector: pages under allowlisted root pages and databases, as markdown.

``config``: ``{"roots": [page or database id or URL, ...], "labels"?: {id: title}}``, the
roots ticked in the web UI's page picker (:func:`search_shared` lists what can be ticked)
and, under ``labels``, their titles as the picker listed them (only for people to read).
The credential carries a ``token`` entry: an internal integration secret or an OAuth
access token.

Each sync walks every root: child pages and the rows of child databases, recursively.
Fetching a page's blocks is the expensive part, so the cursor remembers, per page, the
``last_edited_time`` it was rendered at and the child pages and databases it links;
an unchanged page is walked from that without fetching its blocks. A page that the walk
no longer reaches (archived, unshared, moved out of the roots) is deleted. After the
roots change, :meth:`NotionConnector.rescope_cursor` keeps only the page ids, so pages
outside the new roots are still deleted and every page is rendered again.

    {"pages": {"<page id>": {"edited": "...", "children": [...], "databases": [...]}}}
"""

import contextlib
import copy
import re
from collections.abc import AsyncIterator
from datetime import datetime
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
    Scope,
    SyncEvent,
    check_labels,
    normalize_labels,
    register,
)

API_URL = "https://api.notion.com/v1"
# How many root titles ``labels`` may hold.
MAX_LABELS = 200
API_VERSION = "2022-06-28"
# For the connections lane. Notion has no OAuth scopes (an integration's capabilities
# are set on the integration); its authorize URL also needs ``owner=user`` and the
# token endpoint takes the client id and secret as HTTP Basic auth.
OAUTH = {
    "authorize_url": "https://api.notion.com/v1/oauth/authorize",
    "token_url": "https://api.notion.com/v1/oauth/token",
    "scopes": [],
    "authorize_params": {"owner": "user"},
    "token_auth": "client_secret_basic",
}

PAGE_SIZE = 100
# Save the cursor after this many rendered pages (and after each root).
CHECKPOINT_EVERY = 20
_ID_RE = re.compile(r"([0-9a-fA-F]{32})$")
_LIST_TYPES = ("bulleted_list_item", "numbered_list_item", "to_do")
# Blocks whose children are separate pages, not part of this page's content.
_PAGE_BLOCKS = ("child_page", "child_database")


def normalize_id(value: str) -> str | None:
    """A page or database id from a dashed or undashed id, or a Notion URL."""
    if not isinstance(value, str):
        return None
    last = value.strip().split("?")[0].split("#")[0].rstrip("/").rsplit("/", 1)[-1]
    match = _ID_RE.search(last.replace("-", ""))
    if not match:
        return None
    h = match.group(1).lower()
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}"


def page_url(page_id: str) -> str:
    return f"https://www.notion.so/{page_id.replace('-', '')}"


def _token(credential: dict[str, Any] | None) -> str:
    credential = credential or {}
    token = credential.get("token") or credential.get("access_token")
    if not isinstance(token, str) or not token:
        raise ConnectorConfigError("a Notion integration token is required")
    return token


def _parse_config(config: dict[str, Any]) -> list[str]:
    if "pages" in config:
        raise ConnectorConfigError('use "roots" for the Notion pages and databases, not "pages"')
    roots = config.get("roots")
    if not isinstance(roots, list) or not roots:
        raise ConnectorConfigError("allowlist at least one root page or database")
    ids: list[str] = []
    for root in roots:
        root_id = normalize_id(root)
        if root_id is None:
            raise ConnectorConfigError(f"not a Notion page or database id: {root!r}")
        if root_id not in ids:
            ids.append(root_id)
    return ids


def _ts(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None


def _raise_for_status(resp: httpx.Response) -> None:
    if resp.is_success:
        return
    try:
        body = resp.json()
        message = f"{body.get('code', '')}: {body.get('message', '')}"
    except ValueError:
        message = resp.text[:200]
    if resp.status_code == 401:
        raise ConnectorAuthError(f"Notion rejected the token ({message})")
    if resp.status_code == 403:
        raise NotionForbidden(f"Notion refused access ({message})")
    if resp.status_code == 429:
        retry_after = None
        with contextlib.suppress(KeyError, ValueError):
            retry_after = max(0.0, float(resp.headers["retry-after"]))
        raise ConnectorRateLimited(f"Notion rate limit ({message})", retry_after=retry_after)
    raise ConnectorError(
        f"Notion API error {resp.status_code} on {resp.request.url.path} ({message})"
    )


class NotionForbidden(ConnectorAuthError):
    """A 403: the token is valid but the integration lacks a capability for this call
    (``restricted_resource``). Not a reason to reconnect."""


class _Api:
    def __init__(self, client: httpx.AsyncClient, token: str, base_url: str):
        self.client = client
        self.base_url = base_url.rstrip("/")
        self.headers = {"Authorization": f"Bearer {token}", "Notion-Version": API_VERSION}
        self._users: dict[str, str | None] = {}

    async def request(
        self, method: str, path: str, allow: tuple[int, ...] = (), **kwargs: Any
    ) -> httpx.Response:
        resp = await self.client.request(
            method, self.base_url + path, headers=self.headers, **kwargs
        )
        if resp.status_code not in allow:
            _raise_for_status(resp)
        return resp

    async def get(self, path: str, allow: tuple[int, ...] = (), **kwargs: Any) -> dict | None:
        """The JSON body, or ``None`` for an allowed error status."""
        resp = await self.request("GET", path, allow, **kwargs)
        return resp.json() if resp.is_success else None

    async def children(self, block_id: str) -> list[dict[str, Any]]:
        """All child blocks (one level), or ``[]`` if the block is not readable."""
        blocks: list[dict[str, Any]] = []
        params: dict[str, Any] = {"page_size": PAGE_SIZE}
        while True:
            data = await self.get(f"/blocks/{block_id}/children", (404,), params=params)
            if data is None:
                return blocks
            blocks += data.get("results", [])
            if not data.get("has_more"):
                return blocks
            params = {"page_size": PAGE_SIZE, "start_cursor": data["next_cursor"]}

    async def query(self, database_id: str) -> list[dict[str, Any]] | None:
        """Every row of a database, or ``None`` if it is not shared (or a linked view)."""
        rows: list[dict[str, Any]] = []
        body: dict[str, Any] = {"page_size": PAGE_SIZE}
        while True:
            resp = await self.request(
                "POST", f"/databases/{database_id}/query", (400, 404), json=body
            )
            if not resp.is_success:
                return None
            data = resp.json()
            rows += data.get("results", [])
            if not data.get("has_more"):
                return rows
            body = {"page_size": PAGE_SIZE, "start_cursor": data["next_cursor"]}

    async def user_name(self, user: dict[str, Any] | None) -> str | None:
        """A user's name; ``None`` when the integration may not read user information."""
        if not user or not user.get("id"):
            return None
        if user.get("name"):
            return user["name"]
        if user["id"] not in self._users:
            data = await self.get(f"/users/{user['id']}", (403, 404))
            self._users[user["id"]] = (data or {}).get("name")
        return self._users[user["id"]]

    async def tree(self, block_id: str) -> list[dict[str, Any]]:
        """Child blocks with their descendants under ``"children"`` (child pages excluded)."""
        blocks = await self.children(block_id)
        for block in blocks:
            if not block.get("has_children") or block["type"] in _PAGE_BLOCKS:
                continue
            source = block["id"]
            # A synced copy's content lives under the original block.
            if block["type"] == "synced_block":
                synced_from = (block.get("synced_block") or {}).get("synced_from") or {}
                source = synced_from.get("block_id") or source
            block["children"] = await self.tree(source)
        return blocks


# --- Markdown -------------------------------------------------------------------------


def _wrap(text: str, marker: str) -> str:
    core = text.strip()
    if not core:
        return text
    lead = text[: len(text) - len(text.lstrip())]
    trail = text[len(text.rstrip()) :]
    return f"{lead}{marker}{core}{marker}{trail}"


def rich_text_to_markdown(rich_text: list[dict[str, Any]]) -> str:
    out = []
    for span in rich_text or []:
        if span.get("type") == "equation":
            out.append(f"${span['equation']['expression']}$")
            continue
        text = span.get("plain_text", "")
        notes = span.get("annotations") or {}
        if notes.get("code"):
            text = _wrap(text, "`")
        if notes.get("bold"):
            text = _wrap(text, "**")
        if notes.get("italic"):
            text = _wrap(text, "*")
        if notes.get("strikethrough"):
            text = _wrap(text, "~~")
        if span.get("href") and text.strip():
            text = f"[{text}]({span['href']})"
        out.append(text)
    return "".join(out)


def _plain(rich_text: list[dict[str, Any]]) -> str:
    return "".join(span.get("plain_text", "") for span in rich_text or [])


def _indent(text: str, prefix: str) -> str:
    return "\n".join(prefix + line if line else line for line in text.split("\n"))


def _file_url(value: dict[str, Any]) -> str | None:
    kind = value.get("type")
    url = (value.get(kind) or {}).get("url") if kind else None
    # Notion-hosted files have signed URLs that change on every read: drop the signature.
    if url and kind == "file":
        url = url.split("?")[0]
    return url


def _table(rows: list[dict[str, Any]]) -> str:
    cells = [
        [
            rich_text_to_markdown(c).replace("|", "\\|").replace("\n", " ")
            for c in r["table_row"]["cells"]
        ]
        for r in rows
        if r.get("type") == "table_row"
    ]
    if not cells:
        return ""
    width = max(len(r) for r in cells)
    cells = [r + [""] * (width - len(r)) for r in cells]
    lines = ["| " + " | ".join(cells[0]) + " |", "|" + " --- |" * width]
    lines += ["| " + " | ".join(r) + " |" for r in cells[1:]]
    return "\n".join(lines)


def _block(block: dict[str, Any], number: int) -> str:
    kind = block["type"]
    value = block.get(kind) or {}
    text = rich_text_to_markdown(value.get("rich_text", []))
    children = blocks_to_markdown(block.get("children") or [])

    def with_children(head: str, child_prefix: str = "") -> str:
        if not children:
            return head
        return f"{head}\n\n{_indent(children, child_prefix)}" if head else children

    if kind == "paragraph":
        return with_children(text, "    ")
    if kind in ("heading_1", "heading_2", "heading_3"):
        return with_children("#" * int(kind[-1]) + " " + text)
    if kind == "bulleted_list_item":
        return with_children(f"- {text}", "  ")
    if kind == "numbered_list_item":
        return with_children(f"{number}. {text}", "   ")
    if kind == "to_do":
        return with_children(f"- [{'x' if value.get('checked') else ' '}] {text}", "  ")
    if kind == "toggle":
        body = f"\n\n{children}\n" if children else ""
        return f"<details>\n<summary>{text}</summary>{body}\n</details>"
    if kind in ("quote", "callout"):
        icon = (value.get("icon") or {}).get("emoji") if kind == "callout" else None
        quoted = with_children(f"{icon} {text}" if icon else text)
        return "\n".join(f"> {line}" if line else ">" for line in quoted.split("\n"))
    if kind == "code":
        language = value.get("language", "")
        language = "" if language == "plain text" else language
        return f"```{language}\n{_plain(value.get('rich_text', []))}\n```"
    if kind == "table":
        return _table(block.get("children") or [])
    if kind == "child_page":
        return f"[{value.get('title') or 'Untitled'}]({page_url(block['id'])})"
    if kind == "child_database":
        return f"[{value.get('title') or 'Untitled database'}]({page_url(block['id'])})"
    if kind == "link_to_page":
        target = value.get(value.get("type", ""), "")
        return f"[Linked page]({page_url(target)})" if target else ""
    if kind == "divider":
        return "---"
    if kind == "equation":
        return f"$$\n{value.get('expression', '')}\n$$"
    if kind in ("image", "file", "pdf", "video", "audio"):
        url = _file_url(value)
        caption = rich_text_to_markdown(value.get("caption", [])) or value.get("name") or kind
        if not url:
            return caption
        return f"![{caption}]({url})" if kind == "image" else f"[{caption}]({url})"
    if kind in ("bookmark", "embed", "link_preview"):
        url = value.get("url")
        caption = rich_text_to_markdown(value.get("caption", [])) or url
        return f"[{caption}]({url})" if url else ""
    # column_list, column, synced_block and anything newer: their text and children.
    return with_children(text)


def blocks_to_markdown(blocks: list[dict[str, Any]]) -> str:
    """Render Notion blocks (with ``"children"`` filled in) as markdown."""
    out: list[str] = []
    previous: str | None = None
    number = 0
    for block in blocks:
        kind = block.get("type", "")
        number = number + 1 if kind == "numbered_list_item" else 0
        text = _block(block, number)
        if not text:
            continue
        if out:
            tight = kind in _LIST_TYPES and previous in _LIST_TYPES
            out.append("\n" if tight else "\n\n")
        out.append(text)
        previous = kind
    return "".join(out)


def _linked_pages(blocks: list[dict[str, Any]]) -> tuple[list[str], list[str]]:
    """The child page and child database ids among ``blocks``, at any depth."""
    pages: list[str] = []
    databases: list[str] = []
    for block in blocks:
        if block.get("type") == "child_page":
            pages.append(block["id"])
        elif block.get("type") == "child_database":
            databases.append(block["id"])
        sub_pages, sub_databases = _linked_pages(block.get("children") or [])
        pages += sub_pages
        databases += sub_databases
    return pages, databases


def page_title(page: dict[str, Any]) -> str:
    for prop in (page.get("properties") or {}).values():
        if prop.get("type") == "title":
            return _plain(prop.get("title", [])).strip() or "Untitled"
    return "Untitled"


def _property_text(prop: dict[str, Any]) -> str:
    kind = prop.get("type")
    value = prop.get(kind) if kind else None
    if value is None or value == [] or value == "":
        return ""
    if kind == "rich_text":
        return rich_text_to_markdown(value)
    if kind in ("select", "status"):
        return value.get("name", "")
    if kind == "multi_select":
        return ", ".join(option.get("name", "") for option in value)
    if kind == "date":
        return value["start"] + (f" to {value['end']}" if value.get("end") else "")
    if kind == "people":
        return ", ".join(person.get("name") or person.get("id", "") for person in value)
    if kind == "checkbox":
        return "yes" if value else "no"
    if kind in ("number", "url", "email", "phone_number"):
        return str(value)
    if kind == "formula":
        return _property_text(value)
    if kind == "relation":
        return ", ".join(page_url(r["id"]) for r in value if r.get("id"))
    if kind == "unique_id":
        prefix = value.get("prefix")
        return f"{prefix}-{value.get('number')}" if prefix else str(value.get("number"))
    if kind == "files":
        return ", ".join(f.get("name", "") for f in value)
    # rollup, created_by, last_edited_*, verification: noisy or derived; left out.
    return ""


def page_markdown(page: dict[str, Any], blocks: list[dict[str, Any]]) -> str:
    """A page as markdown: title, then its properties (database rows), then its blocks."""
    lines = [f"# {page_title(page)}", ""]
    facts = []
    for name, prop in sorted((page.get("properties") or {}).items()):
        if prop.get("type") != "title" and (text := _property_text(prop)):
            facts.append(f"- {name}: {text}")
    if facts:
        lines += facts + [""]
    # Trailing spaces (e.g. after a styled word) only add noise to versions and diffs.
    body = "\n".join(line.rstrip() for line in blocks_to_markdown(blocks).split("\n"))
    if body:
        lines += [body, ""]
    return "\n".join(lines)


# --- Page picker -----------------------------------------------------------------------

_PARENT_TYPES = {"workspace": "workspace", "page_id": "page", "database_id": "database"}


def _icon(icon: dict[str, Any] | None) -> str | None:
    """An emoji, or the URL of an external image icon. A Notion-hosted ("file") icon has
    a short-lived signed URL: unsigned it does not load, and a signed one should not reach
    the browser, so it gets no icon (the picker shows its default glyph)."""
    if not isinstance(icon, dict):
        return None
    kind = icon.get("type")
    if kind == "emoji":
        return icon.get("emoji")
    if kind != "external":
        return None
    url = (icon.get("external") or {}).get("url")
    return url if isinstance(url, str) and url.startswith("https://") else None


def shared_object(obj: dict[str, Any]) -> dict[str, Any] | None:
    """A search result as the page picker shows it; ``None`` if it has no usable id."""
    object_id = normalize_id(obj.get("id"))
    if object_id is None:
        return None
    parent = obj.get("parent") or {}
    parent_kind = parent.get("type", "")
    is_database = obj.get("object") == "database"
    title = (_plain(obj.get("title", [])).strip() or "Untitled") if is_database else page_title(obj)
    return {
        "id": object_id,
        "type": "database" if is_database else "page",
        "title": title,
        "icon": _icon(obj.get("icon")),
        # A page inside a column or a synced block has a block parent: not pickable as such.
        "parent_type": _PARENT_TYPES.get(parent_kind, "block"),
        "parent_id": None if parent_kind == "workspace" else parent.get(parent_kind),
        "last_edited_at": _ts(obj.get("last_edited_time")),
        "url": obj.get("url") or page_url(object_id),
    }


async def search_shared(
    client: httpx.AsyncClient,
    token: str,
    query: str,
    cursor: str | None,
    base_url: str = API_URL,
) -> tuple[list[dict[str, Any]], str | None]:
    """One page of the pages and databases the token can read (Notion's search), and the
    cursor of the next page. With OAuth (``owner=user``) that is what the person shared
    with Product Oracle when connecting, and everything under it."""
    body: dict[str, Any] = {"page_size": PAGE_SIZE}
    if query.strip():
        body["query"] = query.strip()
    else:
        body["sort"] = {"direction": "descending", "timestamp": "last_edited_time"}
    if cursor:
        body["start_cursor"] = cursor
    resp = await _Api(client, token, base_url).request("POST", "/search", json=body)
    data = resp.json()
    if not isinstance(data, dict) or not isinstance(data.get("results", []), list):
        raise ConnectorError("Notion search answered with an unexpected body")
    items = []
    for obj in data.get("results", []):
        # A malformed result is skipped rather than failing the whole page.
        with contextlib.suppress(AttributeError, KeyError, TypeError, ValueError):
            if not _gone(obj) and (item := shared_object(obj)) is not None:
                items.append(item)
    next_cursor = data.get("next_cursor") if data.get("has_more") else None
    return items, next_cursor if isinstance(next_cursor, str) else None


# --- Connector ------------------------------------------------------------------------


def _gone(page: dict[str, Any]) -> bool:
    return bool(page.get("archived") or page.get("in_trash"))


class NotionConnector:
    kind = "notion"

    def __init__(self, client: httpx.AsyncClient | None = None, base_url: str = API_URL):
        # Tests inject a client on an httpx.MockTransport; otherwise one per call.
        self._http = client
        self.base_url = base_url

    @contextlib.asynccontextmanager
    async def _api(self, credential: dict[str, Any] | None) -> AsyncIterator[_Api]:
        token = _token(credential)
        if self._http is not None:
            yield _Api(self._http, token, self.base_url)
            return
        async with httpx.AsyncClient(timeout=30.0) as client:
            yield _Api(client, token, self.base_url)

    async def _root(self, api: _Api, root_id: str) -> tuple[str, dict[str, Any]] | None:
        """``("page" | "database", object)``, or ``None`` if not shared or archived."""
        # Asking for a database as a page is a 400 or a 404, depending on the API version.
        page = await api.get(f"/pages/{root_id}", (400, 404))
        if page is not None:
            return None if _gone(page) else ("page", page)
        database = await api.get(f"/databases/{root_id}", (400, 404))
        if database is not None:
            return None if _gone(database) else ("database", database)
        return None

    def check_config(self, config: dict[str, Any]) -> None:
        """The rules a saved config must still meet (the roots, their titles)."""
        _parse_config(config)
        check_labels(config, MAX_LABELS, "labels must map page ids to titles")

    def normalize_config(self, config: dict[str, Any]) -> dict[str, Any]:
        """Titles kept only for the picked roots (by id, dashed or not, or a page link),
        each cut to length. The roots stay as saved, so a source's fingerprint does not
        change."""
        roots = config.get("roots")
        if not isinstance(roots, list) or not all(isinstance(r, str) for r in roots):
            return dict(config)
        picked = set(roots) | {normalize_id(r) for r in roots} - {None}
        return normalize_labels(dict(config), picked, MAX_LABELS)

    def scope(self, config: dict[str, Any]) -> Scope:
        """Still selected, as far as stored items tell: pulled in from a picked root."""
        return Scope(provenance=(("root", frozenset(_parse_config(config))),))

    def rescope_cursor(
        self, old_cursor: dict[str, Any] | None, new_config: dict[str, Any]
    ) -> dict[str, Any] | None:
        """New roots: keep the page ids pulled in (a page the new roots do not reach is
        then deleted), but render every page again under its new root."""
        pages = (old_cursor or {}).get("pages") or {}
        return {"pages": {page_id: {} for page_id in pages}} if pages else None

    async def validate(self, config: dict[str, Any], credential: dict[str, Any] | None) -> None:
        roots = _parse_config(config)
        async with self._api(credential) as api:
            await api.get("/users/me")
            for root_id in roots:
                if await self._root(api, root_id) is None:
                    raise ConnectorConfigError(
                        f"{root_id} is not shared with the integration, or is archived"
                    )

    async def sync(
        self,
        config: dict[str, Any],
        credential: dict[str, Any] | None,
        cursor: dict[str, Any] | None,
    ) -> AsyncIterator[SyncEvent]:
        roots = _parse_config(config)
        known: dict[str, dict[str, Any]] = dict((cursor or {}).get("pages") or {})
        state: dict[str, Any] = {"pages": dict(known)}
        live: set[str] = set()
        walked_databases: set[str] = set()
        rendered = 0

        async with self._api(credential) as api:
            for root_id in roots:
                root = await self._root(api, root_id)
                acl = {"visibility": "shared_with_integration", "root": root_id}
                # A stack of ("page", id, page object or None) and ("database", id, None).
                stack: list[tuple[str, str, dict[str, Any] | None]] = []
                if root is not None:
                    stack.append((root[0], root_id, root[1] if root[0] == "page" else None))
                while stack:
                    kind, object_id, page = stack.pop()
                    if kind == "database":
                        if object_id in walked_databases:
                            continue
                        walked_databases.add(object_id)
                        rows = await api.query(object_id) or []
                        stack += [("page", row["id"], row) for row in reversed(rows)]
                        continue
                    if object_id in live:
                        continue
                    if page is None:
                        page = await api.get(f"/pages/{object_id}", (404,))
                    if page is None or _gone(page):
                        continue  # unshared or archived: deleted below if known
                    live.add(object_id)
                    entry = known.get(object_id)
                    if entry and entry.get("edited") == page.get("last_edited_time"):
                        children, databases = entry["children"], entry["databases"]
                    else:
                        blocks = await api.tree(object_id)
                        children, databases = _linked_pages(blocks)
                        yield ItemUpsert(
                            external_id=object_id,
                            kind="page",
                            title=page_title(page),
                            url=page.get("url") or page_url(object_id),
                            author=await api.user_name(page.get("created_by")),
                            content=page_markdown(page, blocks),
                            acl=acl,
                            occurred_at=_ts(page.get("created_time")),
                            source_updated_at=_ts(page.get("last_edited_time")),
                            provenance={"root": root_id},
                        )
                        state["pages"][object_id] = {
                            "edited": page.get("last_edited_time"),
                            "children": children,
                            "databases": databases,
                        }
                        rendered += 1
                        if rendered % CHECKPOINT_EVERY == 0:
                            yield CursorCheckpoint(copy.deepcopy(state))
                    stack += [("database", d, None) for d in reversed(databases)]
                    stack += [("page", c, None) for c in reversed(children)]
                yield CursorCheckpoint(copy.deepcopy(state))

        for page_id in sorted(known.keys() - live):
            yield ItemDelete(external_id=page_id)
            state["pages"].pop(page_id, None)
        yield CursorCheckpoint(copy.deepcopy(state))


register(NotionConnector())
