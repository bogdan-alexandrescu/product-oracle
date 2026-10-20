"""Google Docs: the Docs and folders one user picked in Google's Drive picker.

credential: the Google connection's OAuth bundle ``{"access_token", ...}`` (the connections
lane refreshes it; a rejected token raises :class:`ConnectorAuthError`).
config ``{"docs": [file ids], "folders": [folder ids], "names": {id: name}}``: the files
and folders the person picked (S5, 'Drive folders', owner 2026-10-19). ``names`` is only
what the Sources page shows before the first sync. A picked folder syncs every Google
Doc in it and its sub-folders, including docs added later, so the connection holds
``drive.readonly`` (read access to the person's Drive), not ``drive.file``. Every id must
look like a Drive id (:data:`DRIVE_ID`); 'root' (the whole My Drive) is refused.

The sync engine adds the company's email domains (``base.COMPANY_DOMAINS``): a doc found
in a picked folder whose owner is outside them is skipped and listed on the source, or
pulled in and flagged (``ORACLE_DRIVE_DOCS_OWNED_OUTSIDE``; owner 2026-10-20: skipped).
Docs picked one by one are always pulled in.

A picked doc Oracle cannot read any more (unshared, access removed, trashed, not a Google
Doc) is reported with :class:`ItemUnavailable`, one per doc, and deleted; a picked folder
it cannot read is reported the same way and what came from it is kept until it can be
read again or is removed from the source. The rest still syncs.

Each Google Doc becomes one ``doc`` item exported as Markdown, or as plain text when
Drive cannot export it as Markdown. ``acl`` is the file's sharing summary (owners,
whether it is shared, and the permissions when the user may read them).

Cursor::

    {"modified_since": "2026-10-01T09:00:00.000Z",
     "files": {"<file id>": "2026-10-01T09:00:00.000Z"},
     "listing": {"for": "<allowlist hash>", "changes": "<Drive changes token>",
                 "at": "<when the folders were last listed>"},
     "tree": {"<picked folder id>": ["<doc id>", ...]},
     "folders": ["<every folder id under the picked ones>"],
     "notes": [{"external_id", "reason", "name", "status"}]}

A sync lists the picked folders (recursively, at most :data:`MAX_FOLDER_DOCS` docs per
source) and reads the picked docs' metadata, then exports a doc only when its
``modifiedTime`` moved past the one in ``files``. Every doc in ``files`` no longer found
under the allowlist yields :class:`ItemDelete`. The sync engine adds every live item of
the source to ``files`` first, so what an edit removed is deleted even when the cursor
was reset (:mod:`oracle.sources.sync`). The folders are not listed again while Drive's
change log shows nothing under them, the allowlist is the same and the last listing is
younger than :data:`RELIST_SECONDS`.
"""

import asyncio
import hashlib
import json
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote

import httpx

from oracle.config import get_settings
from oracle.sources.base import (
    COMPANY_DOMAINS,
    ConnectorAuthError,
    ConnectorBadInput,
    ConnectorConfigError,
    ConnectorError,
    ConnectorRateLimited,
    CursorCheckpoint,
    ItemDelete,
    ItemUnavailable,
    ItemUpsert,
    SyncEvent,
    register,
)

DRIVE_URL = "https://www.googleapis.com/drive/v3/"
OAUTH = {
    "authorize_url": "https://accounts.google.com/o/oauth2/v2/auth",
    "token_url": "https://oauth2.googleapis.com/token",
    "scopes": ["https://www.googleapis.com/auth/drive.readonly"],
}
DOC_MIME = "application/vnd.google-apps.document"
FOLDER_MIME = "application/vnd.google-apps.folder"
EXPORTS = ("text/markdown", "text/plain")
PAGE_SIZE = 100
# What a Drive file id looks like. Anything else (a query fragment, a path with '..',
# 'root' for the whole My Drive) is refused before Drive is called.
DRIVE_ID = re.compile(r"^[A-Za-z0-9_-]{10,200}$")
NOT_A_DRIVE_ID = "is not a Drive file or folder id: choose it from Drive"
# Picked files and folders per source, and how many of them validate checks at once.
MAX_PICKED = 500
VALIDATE_BATCH = 8
# Docs a source pulls in from its folders; past it the listing stops and says so.
MAX_FOLDER_DOCS = 2000
# The folders are listed again at least this often, whatever Drive's change log says.
RELIST_SECONDS = 6 * 3600
# Pages of Drive's change log read to decide whether to list the folders again.
MAX_CHANGE_PAGES = 10
FILE_FIELDS = (
    "id,name,mimeType,trashed,webViewLink,createdTime,modifiedTime,shared,driveId,"
    "owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress),"
    "permissions(type,role,emailAddress,domain,displayName)"
)
RATE_REASONS = {"rateLimitExceeded", "userRateLimitExceeded"}
# Export refusals that plain text may still get past.
EXPORT_REASONS = {"badRequest", "exportSizeLimitExceeded", "cannotExportFile", "invalid"}
LIST_PARAMS = {"supportsAllDrives": "true", "includeItemsFromAllDrives": "true"}
# What the Sources page shows next to a picked doc Oracle cannot read.
NO_ACCESS = "No access: removed, or no longer shared with you"
NOT_PICKED = "Not picked: choose it again from Drive"
TRASHED = "In the trash"
NOT_A_DOC = "Not a Google Doc"
NOT_A_FOLDER = "Not a folder"
FOLDER_NO_ACCESS = (
    "No access to this folder: removed, or no longer shared with you. "
    "What came from it is kept until you remove it here"
)
FOLDER_LIMIT = (
    "Only the first {limit:,} docs in this source's folders are synced: pick smaller folders"
)
# 403 reasons meaning this one file cannot be read (others fail the sync).
FILE_DENIED = {"insufficientFilePermissions", "cannotDownloadFile", "forbidden"}


def valid_id(value: object) -> bool:
    return isinstance(value, str) and bool(DRIVE_ID.match(value)) and value.lower() != "root"


def _ids(config: dict[str, Any], key: str) -> list[str]:
    ids = config.get(key) or []
    if not isinstance(ids, list) or not all(isinstance(i, str) and i for i in ids):
        raise ConnectorConfigError(f"{key} must be a list of Drive ids")
    for i in ids:
        if not valid_id(i):
            raise ConnectorBadInput(f"{i[:60]!r} {NOT_A_DRIVE_ID}")
    return ids


def _options(config: dict[str, Any]) -> tuple[list[str], list[str]]:
    folders, docs = _ids(config, "folders"), _ids(config, "docs")
    names = config.get("names") or {}
    if not isinstance(names, dict) or not all(isinstance(v, str) for v in names.values()):
        raise ConnectorConfigError("names must map Drive ids to file names")
    if not folders and not docs:
        raise ConnectorConfigError("allowlist at least one folder or doc")
    if len(folders) + len(docs) > MAX_PICKED:
        raise ConnectorConfigError(f"choose at most {MAX_PICKED} files and folders per source")
    return folders, docs


def query_string(value: str) -> str:
    """``value`` as a quoted Drive query string: backslash and quote escaped."""
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def _path(*segments: str) -> str:
    """A Drive API path, each segment quoted so it cannot add segments or a query."""
    return "/".join(quote(s, safe="") for s in segments)


def _token(credential: dict[str, Any] | None) -> str:
    token = (credential or {}).get("access_token")
    if not token:
        raise ConnectorConfigError("the Google connection has no access token")
    return token


def _time(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None


def _acl(file: dict[str, Any]) -> dict[str, Any]:
    acl: dict[str, Any] = {
        "shared": bool(file.get("shared")),
        "owners": [o.get("emailAddress") or o.get("displayName") for o in file.get("owners") or []],
    }
    if "permissions" in file:
        acl["permissions"] = [
            {
                k: v
                for k, v in {
                    "type": p.get("type"),
                    "role": p.get("role"),
                    "email": p.get("emailAddress"),
                    "domain": p.get("domain"),
                }.items()
                if v
            }
            for p in file["permissions"]
        ]
    return acl


def _domains(config: dict[str, Any]) -> list[str]:
    value = config.get(COMPANY_DOMAINS) or []
    return sorted({str(d).strip().lower().lstrip("@") for d in value if str(d).strip()})


def owned_outside(file: dict[str, Any], domains: list[str]) -> bool:
    """Whether a doc's owner is outside the company's ``domains``. A doc in a shared
    drive belongs to the drive (Drive names no owner), so it counts as inside; a doc
    whose owner's email Drive does not show counts as outside. No domains: no check."""
    if not domains or file.get("driveId"):
        return False
    emails = [o.get("emailAddress") or "" for o in file.get("owners") or []]
    return not any(e.rpartition("@")[2].lower() in domains for e in emails if "@" in e)


def _outside_label(domains: list[str]) -> str:
    return " or ".join(domains[:3]) + (" …" if len(domains) > 3 else "")


def _listing_key(folders: list[str], docs: list[str], domains: list[str], policy: str) -> str:
    raw = json.dumps([sorted(folders), sorted(docs), domains, policy])
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


def _now() -> str:
    return datetime.now(UTC).isoformat()


class _Error(ConnectorError):
    def __init__(self, status: int, reason: str, message: str):
        super().__init__(f"Google Drive: HTTP {status} {reason} {message}".strip())
        self.status = status
        self.reason = reason


def _unreadable(e: "_Error") -> str | None:
    """The per-item reason when Drive refuses one file, else None (a real failure)."""
    if e.status == 404:
        return NO_ACCESS
    if e.status == 403 and e.reason == "appNotAuthorizedToFile":
        return NOT_PICKED
    if e.status == 403 and e.reason in FILE_DENIED:
        return NO_ACCESS
    return None


class _Drive:
    def __init__(self, client: httpx.AsyncClient, token: str):
        self.client = client
        self.headers = {"Authorization": f"Bearer {token}"}

    async def get(self, path: str, **params: Any) -> httpx.Response:
        response = await self.client.get(DRIVE_URL + path, params=params, headers=self.headers)
        if response.status_code < 400:
            return response
        reason, message = "", ""
        try:
            error = response.json().get("error") or {}
            message = error.get("message") or ""
            reason = ((error.get("errors") or [{}])[0]).get("reason") or error.get("status") or ""
        except ValueError:
            pass
        retry = response.headers.get("Retry-After")
        if response.status_code == 429 or (response.status_code == 403 and reason in RATE_REASONS):
            raise ConnectorRateLimited(
                "Google Drive rate limited", retry_after=float(retry) if retry else None
            )
        if response.status_code == 401:
            raise ConnectorAuthError(f"Google rejected the access token: {message}".strip())
        raise _Error(response.status_code, reason, message)

    async def file(self, file_id: str) -> dict[str, Any] | None:
        """A file's metadata; ``None`` when it is gone or no longer visible."""
        try:
            response = await self.get(
                _path("files", file_id), fields=FILE_FIELDS, supportsAllDrives="true"
            )
        except _Error as e:
            if e.status == 404:
                return None
            raise
        return response.json()

    async def list(
        self, query: str, fields: str, page_token: str | None = None, **params: Any
    ) -> dict[str, Any]:
        """One page of ``files.list`` for ``query``."""
        params = {"q": query, "fields": fields, "pageSize": PAGE_SIZE, **LIST_PARAMS, **params}
        if page_token:
            params["pageToken"] = page_token
        return (await self.get("files", **params)).json()

    async def children(self, folder: str, fields: str) -> AsyncIterator[dict[str, Any]]:
        """The docs and folders directly in ``folder``, oldest first."""
        query = (
            f"{query_string(folder)} in parents and trashed = false and "
            f"(mimeType = '{DOC_MIME}' or mimeType = '{FOLDER_MIME}')"
        )
        token = None
        while True:
            page = await self.list(query, fields, token, orderBy="createdTime")
            for file in page.get("files", []):
                yield file
            token = page.get("nextPageToken")
            if not token:
                return

    async def changes_token(self) -> str | None:
        """Where Drive's change log starts now; ``None`` when Drive does not say."""
        try:
            page = (await self.get("changes/startPageToken", supportsAllDrives="true")).json()
        except _Error:
            return None
        token = page.get("startPageToken")
        return str(token) if token else None

    async def changed(self, token: str, watched: set[str]) -> tuple[bool, str | None]:
        """Whether Drive's change log since ``token`` touches any id in ``watched`` (a
        file, or a file whose parent is one), and the token to read from next time.
        ``(True, None)`` when the log cannot be read or is too long to read now."""
        for _ in range(MAX_CHANGE_PAGES):
            try:
                page = (
                    await self.get(
                        "changes",
                        pageToken=token,
                        pageSize=1000,
                        includeRemoved="true",
                        fields="nextPageToken,newStartPageToken,changes(fileId,removed,file(parents))",
                        **LIST_PARAMS,
                    )
                ).json()
            except _Error:
                return True, None
            for change in page.get("changes") or []:
                parents = set((change.get("file") or {}).get("parents") or [])
                if change.get("fileId") in watched or parents & watched:
                    return True, None
            if page.get("newStartPageToken"):
                return False, str(page["newStartPageToken"])
            token = page.get("nextPageToken")
            if not token:
                return True, None
        return True, None

    async def export(self, file_id: str) -> str:
        for mime in EXPORTS:
            try:
                response = await self.get(_path("files", file_id, "export"), mimeType=mime)
            except _Error as e:
                if (
                    mime != EXPORTS[-1]
                    and e.status in (400, 403, 415)
                    and (e.status != 403 or e.reason in EXPORT_REASONS)
                ):
                    continue
                raise
            # Drive does not always declare a charset; exports are UTF-8.
            return response.content.decode("utf-8", errors="replace")
        raise AssertionError("unreachable")


class GoogleDocsConnector:
    kind = "google_docs"

    def __init__(self, client: httpx.AsyncClient | None = None):
        self._client = client

    @asynccontextmanager
    async def _session(self, credential: dict[str, Any] | None):
        token = _token(credential)
        if self._client is not None:
            yield _Drive(self._client, token)
            return
        async with httpx.AsyncClient(timeout=60) as client:
            yield _Drive(client, token)

    def check_config(self, config: dict[str, Any]) -> None:
        """The config's shape and ids, without calling Drive."""
        _options(config)

    async def validate(self, config: dict[str, Any], credential: dict[str, Any] | None) -> None:
        folders, docs = _options(config)
        wanted = [(i, FOLDER_MIME, "folder") for i in folders]
        wanted += [(i, DOC_MIME, "doc") for i in docs]
        async with self._session(credential) as drive:
            await drive.get("about", fields="user(emailAddress)")
            # One metadata call per picked item, a bounded batch at a time. A failure
            # cancels the rest of its batch.
            for start in range(0, len(wanted), VALIDATE_BATCH):
                batch = wanted[start : start + VALIDATE_BATCH]
                try:
                    async with asyncio.TaskGroup() as group:
                        tasks = [group.create_task(drive.file(i)) for i, _, _ in batch]
                except* Exception as group_error:
                    raise group_error.exceptions[0] from None
                for (item, mime, label), task in zip(batch, tasks, strict=True):
                    file = task.result()
                    if file is None or file.get("trashed"):
                        raise ConnectorConfigError(f"{label} {item} not found or not visible")
                    if file.get("mimeType") != mime:
                        kind = "a folder" if mime == FOLDER_MIME else "a Google Doc"
                        raise ConnectorConfigError(f"{item} is not {kind}")

    async def sync(
        self,
        config: dict[str, Any],
        credential: dict[str, Any] | None,
        cursor: dict[str, Any] | None,
    ) -> AsyncIterator[SyncEvent]:
        folders, docs = _options(config)
        names = config.get("names") or {}
        domains = _domains(config)
        policy = get_settings().drive_docs_owned_outside
        cursor = cursor or {}
        known: dict[str, str] = dict(cursor.get("files") or {})
        modified_since = cursor.get("modified_since")
        key = _listing_key(folders, docs, domains, policy)
        listing = dict(cursor.get("listing") or {})
        tree: dict[str, list[str]] = {
            k: list(v) for k, v in (cursor.get("tree") or {}).items() if k in folders
        }
        all_folders = set(cursor.get("folders") or []) | set(folders)

        def checkpoint() -> CursorCheckpoint:
            return CursorCheckpoint(
                {
                    "modified_since": modified_since,
                    "files": dict(known),
                    "listing": dict(listing),
                    "tree": {k: list(v) for k, v in tree.items()},
                    "folders": sorted(all_folders),
                    "notes": [dict(n) for n in notes],
                }
            )

        async with self._session(credential) as drive:
            relist = (
                listing.get("for") != key
                or not listing.get("changes")
                or (_time(listing.get("at")) or datetime.min.replace(tzinfo=UTC)).timestamp()
                < datetime.now(UTC).timestamp() - RELIST_SECONDS
                or any(not t for t in known.values())
            )
            next_token: str | None = None
            if not relist:
                touched, next_token = await drive.changed(
                    listing["changes"], all_folders | set(known) | set(docs)
                )
                relist = touched
            if not relist:
                # Nothing under the picked folders or docs changed: report what the last
                # listing found, read the picked docs not pulled in yet, keep the rest.
                listing["changes"] = next_token
                recheck = [doc for doc in docs if doc not in known]
                notes = [n for n in cursor.get("notes") or [] if n["external_id"] not in recheck]
                current = {}
                for doc in recheck:
                    file, reason = await self._picked(drive, doc)
                    if reason:
                        notes.append({"external_id": doc, "reason": reason})
                    else:
                        current[doc] = file
                for note in notes:
                    yield ItemUnavailable(**note)
            else:
                if folders:
                    # Read before listing, so what changes while it runs is seen next time.
                    listing["changes"] = await drive.changes_token()
                listing["for"], listing["at"] = key, _now()
                notes: list[dict[str, Any]] = []
                current, protected = {}, set()
                protect_all = False
                all_folders = set(folders)
                outside: dict[str, dict[str, Any]] = {}
                budget = MAX_FOLDER_DOCS
                for root in folders:
                    reason = await self._folder_problem(drive, root)
                    if reason:
                        notes.append(
                            {"external_id": root, "reason": reason, "name": names.get(root)}
                        )
                        if root in tree:
                            protected.update(tree[root])
                        else:
                            # Which docs came from it is not known: delete nothing now.
                            protect_all = True
                        continue
                    found, limited = await self._walk(drive, root, budget, all_folders)
                    if limited:
                        notes.append(
                            {
                                "external_id": root,
                                "reason": FOLDER_LIMIT.format(limit=MAX_FOLDER_DOCS),
                                "name": names.get(root),
                                "status": "limited",
                            }
                        )
                    tree[root] = []
                    for file in found:
                        if file["id"] in current or file["id"] in outside:
                            continue
                        budget -= 1
                        if owned_outside(file, domains):
                            outside[file["id"]] = file
                            if policy == "skip":
                                continue
                        current[file["id"]] = file
                        tree[root].append(file["id"])
                for doc in docs:
                    if doc in current:
                        continue
                    if doc in outside:
                        # Picked on its own: pulled in whoever owns it.
                        current[doc] = outside.pop(doc)
                        continue
                    file, reason = await self._picked(drive, doc)
                    if reason:
                        notes.append({"external_id": doc, "reason": reason})
                    else:
                        current[doc] = file
                label = _outside_label(domains)
                for file_id, file in outside.items():
                    skipped = policy == "skip"
                    notes.append(
                        {
                            "external_id": file_id,
                            "reason": (
                                f"Skipped: owned outside {label}"
                                if skipped
                                else f"Owned outside {label}"
                            ),
                            "name": file.get("name"),
                            "status": "skipped" if skipped else "flagged",
                        }
                    )
                notes = [{k: v for k, v in n.items() if v is not None} for n in notes]
                if not protect_all:
                    for file_id in sorted(set(known) - set(current) - protected):
                        yield ItemDelete(external_id=file_id)
                        del known[file_id]
                for note in notes:
                    yield ItemUnavailable(**note)

            # Oldest change first, so each checkpoint covers everything before it.
            changed = sorted(
                (f for f in current.values() if f.get("modifiedTime") != known.get(f["id"])),
                key=lambda f: f.get("modifiedTime") or "",
            )
            for file in changed:
                try:
                    content = await drive.export(file["id"])
                except _Error as e:
                    reason = _unreadable(e)
                    if reason is None:
                        raise
                    # Not recorded in the cursor: the next sync tries it again.
                    yield ItemUnavailable(external_id=file["id"], reason=reason)
                    continue
                yield self._item(file, content, flagged=file["id"] in _flagged(notes))
                known[file["id"]] = file.get("modifiedTime") or ""
                if (file.get("modifiedTime") or "") > (modified_since or ""):
                    modified_since = file["modifiedTime"]
                yield checkpoint()
            yield checkpoint()

    async def _picked(self, drive: _Drive, doc: str) -> tuple[dict[str, Any] | None, str | None]:
        """A picked doc's metadata, or why it cannot be read."""
        try:
            file = await drive.file(doc)
        except _Error as e:
            reason = _unreadable(e)
            if reason is None:
                raise
            return None, reason
        if file is None:
            return None, NO_ACCESS
        if file.get("trashed"):
            return None, TRASHED
        if file.get("mimeType") != DOC_MIME:
            return None, NOT_A_DOC
        return file, None

    async def _folder_problem(self, drive: _Drive, folder: str) -> str | None:
        """Why a picked folder cannot be listed now (Drive lists an unreadable folder as
        empty, so it is read first); ``None`` when it can."""
        try:
            file = await drive.file(folder)
        except _Error as e:
            if _unreadable(e) is None:
                raise
            return FOLDER_NO_ACCESS
        if file is None:
            return FOLDER_NO_ACCESS
        if file.get("trashed"):
            return TRASHED
        if file.get("mimeType") != FOLDER_MIME:
            return NOT_A_FOLDER
        return None

    async def _walk(
        self, drive: _Drive, root: str, budget: int, seen: set[str]
    ) -> tuple[list[dict[str, Any]], bool]:
        """The docs under ``root`` (sub-folders included), at most ``budget`` of them, and
        whether the listing stopped there. Adds every folder walked to ``seen``."""
        found: list[dict[str, Any]] = []
        stack, walked = [root], set()
        while stack:
            folder = stack.pop()
            if folder in walked:
                continue
            walked.add(folder)
            seen.add(folder)
            async for file in drive.children(folder, f"nextPageToken,files({FILE_FIELDS})"):
                if file.get("mimeType") == FOLDER_MIME:
                    stack.append(file["id"])
                elif not file.get("trashed"):
                    if len(found) >= budget:
                        return found, True
                    found.append(file)
        return found, False

    def _item(self, file: dict[str, Any], content: str, flagged: bool = False) -> ItemUpsert:
        editor = file.get("lastModifyingUser") or {}
        owners = file.get("owners") or [{}]
        acl = _acl(file)
        if flagged:
            acl["owned_outside_company"] = True
        return ItemUpsert(
            external_id=file["id"],
            kind="doc",
            title=file.get("name"),
            url=file.get("webViewLink") or f"https://docs.google.com/document/d/{file['id']}/edit",
            author=owners[0].get("displayName") or editor.get("displayName"),
            content=content.lstrip("﻿").replace("\r\n", "\n"),
            acl=acl,
            occurred_at=_time(file.get("createdTime")),
            source_updated_at=_time(file.get("modifiedTime")),
        )


def _flagged(notes: list[dict[str, Any]]) -> set[str]:
    return {n["external_id"] for n in notes if n.get("status") == "flagged"}


register(GoogleDocsConnector())
