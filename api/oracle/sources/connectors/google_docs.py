"""Google Docs: the Docs in one user's allowlisted Drive folders, plus single docs.

credential: the Google connection's OAuth bundle ``{"access_token", ...}`` (the connections
lane refreshes it; a rejected token raises :class:`ConnectorAuthError`).
config ``{"folders": [folder ids], "docs": [file ids]}``; folders are read recursively.

Each Google Doc becomes one ``doc`` item exported as Markdown, or as plain text when
Drive cannot export it as Markdown. ``acl`` is the file's sharing summary (owners,
whether it is shared, and the permissions when the user may read them).

Cursor::

    {"modified_since": "2026-10-01T09:00:00.000Z",
     "files": {"<file id>": "2026-10-01T09:00:00.000Z"}}

Every sync lists the folders (metadata only) and exports a doc only when its
``modifiedTime`` moved past the one in ``files``. A doc in ``files`` that is trashed,
deleted, or no longer in an allowlisted folder yields :class:`ItemDelete`.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
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
FILE_FIELDS = (
    "id,name,mimeType,trashed,webViewLink,createdTime,modifiedTime,shared,"
    "owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress),"
    "permissions(type,role,emailAddress,domain,displayName)"
)
RATE_REASONS = {"rateLimitExceeded", "userRateLimitExceeded"}
# Export refusals that plain text may still get past.
EXPORT_REASONS = {"badRequest", "exportSizeLimitExceeded", "cannotExportFile", "invalid"}
LIST_PARAMS = {"supportsAllDrives": "true", "includeItemsFromAllDrives": "true"}


def _ids(config: dict[str, Any], key: str) -> list[str]:
    ids = config.get(key) or []
    if not isinstance(ids, list) or not all(isinstance(i, str) and i for i in ids):
        raise ConnectorConfigError(f"{key} must be a list of Drive ids")
    return ids


def _options(config: dict[str, Any]) -> tuple[list[str], list[str]]:
    folders, docs = _ids(config, "folders"), _ids(config, "docs")
    if not folders and not docs:
        raise ConnectorConfigError("allowlist at least one folder or doc")
    return folders, docs


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


class _Error(ConnectorError):
    def __init__(self, status: int, reason: str, message: str):
        super().__init__(f"Google Drive: HTTP {status} {reason} {message}".strip())
        self.status = status
        self.reason = reason


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
                f"files/{file_id}", fields=FILE_FIELDS, supportsAllDrives="true"
            )
        except _Error as e:
            if e.status == 404:
                return None
            raise
        return response.json()

    async def children(self, folder: str, fields: str) -> AsyncIterator[dict[str, Any]]:
        query = (
            f"'{folder}' in parents and trashed = false and "
            f"(mimeType = '{DOC_MIME}' or mimeType = '{FOLDER_MIME}')"
        )
        token = None
        while True:
            params = {"q": query, "fields": fields, "pageSize": PAGE_SIZE, **LIST_PARAMS}
            if token:
                params["pageToken"] = token
            page = (await self.get("files", **params)).json()
            for file in page.get("files", []):
                yield file
            token = page.get("nextPageToken")
            if not token:
                return

    async def export(self, file_id: str) -> str:
        for mime in EXPORTS:
            try:
                response = await self.get(f"files/{file_id}/export", mimeType=mime)
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

    async def validate(self, config: dict[str, Any], credential: dict[str, Any] | None) -> None:
        folders, docs = _options(config)
        async with self._session(credential) as drive:
            await drive.get("about", fields="user(emailAddress)")
            for folder in folders:
                file = await drive.file(folder)
                if file is None or file.get("trashed"):
                    raise ConnectorConfigError(f"folder {folder} not found or not visible")
                if file.get("mimeType") != FOLDER_MIME:
                    raise ConnectorConfigError(f"{folder} is not a folder")
            for doc in docs:
                file = await drive.file(doc)
                if file is None or file.get("trashed"):
                    raise ConnectorConfigError(f"doc {doc} not found or not visible")
                if file.get("mimeType") != DOC_MIME:
                    raise ConnectorConfigError(f"{doc} is not a Google Doc")

    async def sync(
        self,
        config: dict[str, Any],
        credential: dict[str, Any] | None,
        cursor: dict[str, Any] | None,
    ) -> AsyncIterator[SyncEvent]:
        folders, docs = _options(config)
        known: dict[str, str] = dict((cursor or {}).get("files") or {})
        modified_since = (cursor or {}).get("modified_since")

        async with self._session(credential) as drive:
            current: dict[str, dict[str, Any]] = {}
            seen_folders: set[str] = set()
            stack = list(folders)
            while stack:
                folder = stack.pop()
                if folder in seen_folders:
                    continue
                seen_folders.add(folder)
                async for file in drive.children(folder, f"nextPageToken,files({FILE_FIELDS})"):
                    if file.get("mimeType") == FOLDER_MIME:
                        stack.append(file["id"])
                    elif not file.get("trashed"):
                        current[file["id"]] = file
            for doc in docs:
                if doc in current:
                    continue
                file = await drive.file(doc)
                if file and not file.get("trashed") and file.get("mimeType") == DOC_MIME:
                    current[doc] = file

            for file_id in sorted(set(known) - set(current)):
                yield ItemDelete(external_id=file_id)
                del known[file_id]

            # Oldest change first, so each checkpoint covers everything before it.
            changed = sorted(
                (f for f in current.values() if f.get("modifiedTime") != known.get(f["id"])),
                key=lambda f: f.get("modifiedTime") or "",
            )
            for file in changed:
                content = await drive.export(file["id"])
                yield self._item(file, content)
                known[file["id"]] = file.get("modifiedTime") or ""
                if (file.get("modifiedTime") or "") > (modified_since or ""):
                    modified_since = file["modifiedTime"]
                yield CursorCheckpoint({"modified_since": modified_since, "files": dict(known)})
            yield CursorCheckpoint({"modified_since": modified_since, "files": dict(known)})

    def _item(self, file: dict[str, Any], content: str) -> ItemUpsert:
        editor = file.get("lastModifyingUser") or {}
        owners = file.get("owners") or [{}]
        return ItemUpsert(
            external_id=file["id"],
            kind="doc",
            title=file.get("name"),
            url=file.get("webViewLink") or f"https://docs.google.com/document/d/{file['id']}/edit",
            author=owners[0].get("displayName") or editor.get("displayName"),
            content=content.lstrip("\ufeff").replace("\r\n", "\n"),
            acl=_acl(file),
            occurred_at=_time(file.get("createdTime")),
            source_updated_at=_time(file.get("modifiedTime")),
        )


register(GoogleDocsConnector())
