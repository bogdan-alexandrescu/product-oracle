"""GitHub connector: README, docs, issues, pull requests, releases and milestones.

``config``: ``{"repos": ["owner/name", ...], "include": [...]}``, where ``include`` is a
subset of :data:`INCLUDE` (all of them when absent). ``credential``: ``{"token": "..."}``,
a fine-grained personal access token or an OAuth access token.

The cursor keeps one entry per repo (keyed by the lowercased ``owner/name``):

- ``tree_sha`` / ``files`` / ``include``: the last synced tree, the blob sha of each
  README and ``docs/**/*.md`` file and which of the two were included, so unchanged
  files are not fetched and removed ones are deleted;
- ``issues_since``: the ``updated_at`` of the newest issue or pull request seen;
- ``releases`` / ``milestones``: the ids seen, so removed ones are deleted.

After a config change the next sync first deletes the items of repos and kinds no longer
selected (:meth:`GithubConnector.scope`), then resumes from
:meth:`GithubConnector.rescope_cursor`: each kept repo keeps ``files``, ``releases`` and
``milestones`` (so what was deleted upstream meanwhile is still noticed) but loses
``tree_sha`` and ``issues_since``, and its files are fetched again (``refetch``), so
everything is re-read under the new selection.
"""

import base64
import contextlib
import copy
import re
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any
from urllib.parse import quote

import httpx

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
    register,
)

API_URL = "https://api.github.com"
API_VERSION = "2022-11-28"
INCLUDE = ("readme", "docs", "issues", "pull_requests", "releases", "milestones")
# For the connections lane: GitHub's OAuth web flow (also used by GitHub App user tokens,
# which ignore scopes). ``repo`` is the only OAuth scope that can read private repos.
OAUTH = {
    "authorize_url": "https://github.com/login/oauth/authorize",
    "token_url": "https://github.com/login/oauth/access_token",
    "scopes": ["repo", "read:user"],
}

PER_PAGE = 100
# Repos one source may allowlist.
MAX_REPOS = 100
# Files larger than this are skipped (docs this size are generated, not written).
MAX_FILE_BYTES = 1_000_000
# The owner may hold underscores: Enterprise Managed Users log in as ``name_shortcode``.
# The name may not be "." or ".." (a path segment, not a repo: /repos/owner/.. is /repos).
_REPO_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9_-]*)/(?!\.{1,2}$)[A-Za-z0-9._-]+$")
_README_RE = re.compile(r"^readme(\.[A-Za-z0-9]+)?$", re.IGNORECASE)
_DOC_RE = re.compile(r"^docs/.+\.(md|markdown)$", re.IGNORECASE)
# What a repo's cursor keeps when the selection changes (see rescope_cursor).
_RESCOPE_KEEPS = ("files", "releases", "milestones")
# Item kind -> the ``include`` entry that brings it in.
_KIND_INCLUDE = {
    "readme": "readme",
    "doc": "docs",
    "issue": "issues",
    "pull_request": "pull_requests",
    "release": "releases",
    "milestone": "milestones",
}


def _token(credential: dict[str, Any] | None) -> str:
    credential = credential or {}
    token = credential.get("token") or credential.get("access_token")
    if not isinstance(token, str) or not token:
        raise ConnectorConfigError("a GitHub token is required")
    return token


def _parse_config(config: dict[str, Any]) -> tuple[list[str], set[str]]:
    repos = config.get("repos")
    if not isinstance(repos, list) or not repos:
        raise ConnectorConfigError("allowlist at least one repo as owner/name")
    unique: dict[str, str] = {}
    for repo in repos:
        if not isinstance(repo, str) or not _REPO_RE.match(repo.strip()):
            raise ConnectorConfigError(f"not a repo name (owner/name): {repo!r}")
        unique.setdefault(repo.strip().lower(), repo.strip())
    if len(unique) > MAX_REPOS:
        raise ConnectorConfigError(f"allowlist at most {MAX_REPOS} repos")
    include = config.get("include")
    if include is None:
        include = list(INCLUDE)
    if not isinstance(include, list) or not include:
        raise ConnectorConfigError(f"include at least one of {', '.join(INCLUDE)}")
    unknown = [i for i in include if i not in INCLUDE]
    if unknown:
        raise ConnectorConfigError(f"unknown include {unknown[0]!r}; use {', '.join(INCLUDE)}")
    return list(unique.values()), set(include)


def _message(resp: httpx.Response) -> str:
    try:
        body = resp.json()
    except ValueError:
        return resp.text[:200]
    return str(body.get("message", "")) if isinstance(body, dict) else ""


def _retry_after(resp: httpx.Response) -> float | None:
    retry_after = resp.headers.get("retry-after")
    if retry_after is not None:
        with contextlib.suppress(ValueError):
            return max(0.0, float(retry_after))
    if resp.headers.get("x-ratelimit-remaining") == "0":
        with contextlib.suppress(KeyError, ValueError):
            return max(0.0, float(resp.headers["x-ratelimit-reset"]) - time.time())
    return None


def _raise_for_status(resp: httpx.Response) -> None:
    if resp.is_success:
        return
    status, message = resp.status_code, _message(resp)
    if status == 401:
        raise ConnectorAuthError(f"GitHub rejected the token: {message or 'unauthorized'}")
    if status in (403, 429):
        retry_after = _retry_after(resp)
        if status == 429 or retry_after is not None or "rate limit" in message.lower():
            raise ConnectorRateLimited(f"GitHub rate limit: {message}", retry_after=retry_after)
        raise ConnectorForbidden(f"GitHub refused access: {message or 'forbidden'}")
    raise ConnectorError(f"GitHub API error {status} on {resp.request.url.path}: {message}")


class _Api:
    def __init__(self, client: httpx.AsyncClient, token: str, base_url: str):
        self.client = client
        self.base_url = base_url.rstrip("/")
        self.headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": API_VERSION,
        }

    async def get(
        self, url: str, params: dict[str, Any] | None = None, allow: tuple[int, ...] = ()
    ) -> httpx.Response:
        if url.startswith("/"):
            url = self.base_url + url
        resp = await self.client.get(url, params=params, headers=self.headers)
        if resp.status_code not in allow:
            _raise_for_status(resp)
        return resp

    async def pages(
        self, path: str, params: dict[str, Any], allow: tuple[int, ...] = ()
    ) -> AsyncIterator[list[dict[str, Any]]]:
        """Each page of a list endpoint, following the ``Link: rel="next"`` header."""
        url: str | None = path
        page_params: dict[str, Any] | None = {**params, "per_page": PER_PAGE}
        while url:
            resp = await self.get(url, page_params, allow)
            if resp.status_code in allow:
                return
            yield resp.json()
            url = resp.links.get("next", {}).get("url")
            page_params = None  # the next link carries the query


@dataclass(frozen=True)
class _Repo:
    key: str
    full_name: str
    html_url: str
    default_branch: str | None
    acl: dict[str, Any]

    @classmethod
    def from_api(cls, key: str, data: dict[str, Any]) -> "_Repo":
        visibility = data.get("visibility") or ("private" if data.get("private") else "public")
        return cls(
            key=key,
            full_name=data["full_name"],
            html_url=data["html_url"],
            default_branch=data.get("default_branch"),
            acl={"visibility": visibility, "repo": data["full_name"]},
        )


def _ts(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None


def _login(user: dict[str, Any] | None) -> str | None:
    return user.get("login") if user else None


def _file_kind(path: str, include: set[str]) -> str | None:
    if "readme" in include and "/" not in path and _README_RE.match(path):
        return "readme"
    if "docs" in include and _DOC_RE.match(path):
        return "doc"
    return None


def _decode_blob(blob: dict[str, Any]) -> str | None:
    if blob.get("encoding") != "base64":
        return None
    try:
        return base64.b64decode(blob.get("content", "")).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None


def _first_heading(content: str) -> str | None:
    for line in content.splitlines():
        if line.startswith("# "):
            return line[2:].strip() or None
    return None


def _issue_item(repo: _Repo, issue: dict[str, Any]) -> ItemUpsert:
    is_pr = "pull_request" in issue
    number = issue["number"]
    merged_at = (issue.get("pull_request") or {}).get("merged_at")
    state = issue.get("state", "open")
    if is_pr and merged_at:
        state = "merged"
    elif state == "closed" and issue.get("state_reason"):
        state = f"closed ({issue['state_reason'].replace('_', ' ')})"
    labels = [label["name"] for label in issue.get("labels") or [] if isinstance(label, dict)]
    facts = [
        ("Repository", repo.full_name),
        ("Pull request" if is_pr else "Issue", f"#{number}"),
        ("State", state),
        ("Labels", ", ".join(labels)),
        ("Author", _login(issue.get("user"))),
        ("Created", issue.get("created_at")),
        ("Closed", issue.get("closed_at")),
    ]
    if is_pr:
        facts.append(("Merged", merged_at or "no"))
    facts.append(("Milestone", (issue.get("milestone") or {}).get("title")))
    lines = [f"# {issue['title']}", ""]
    lines += [f"- {name}: {value}" for name, value in facts if value]
    body = (issue.get("body") or "").strip()
    if body:
        lines += ["", body]
    return ItemUpsert(
        external_id=f"{repo.key}:{'pull' if is_pr else 'issue'}:{number}",
        kind="pull_request" if is_pr else "issue",
        title=issue["title"],
        url=issue.get("html_url"),
        author=_login(issue.get("user")),
        content="\n".join(lines) + "\n",
        acl=repo.acl,
        occurred_at=_ts(issue.get("created_at")),
        source_updated_at=_ts(issue.get("updated_at")),
    )


_MERGED = re.compile(r"^- Merged: (\S+)$", re.M)
_FACT = re.compile(r"^- (Repository|Issue|State|Milestone|Due): (.+)$", re.M)
# The State line an issue item carries, read back as a tracker state (F7).
_ISSUE_STATES = {
    "open": "todo",
    "closed": "done",
    "closed (completed)": "done",
    "closed (not planned)": "cancelled",
}


def _facts(content: str) -> dict[str, str]:
    """The ``- Name: value`` lines :func:`_issue_item` and :func:`_milestone_item` write
    (the first of each name: a body's own lines come after them)."""
    out: dict[str, str] = {}
    for name, value in _FACT.findall(content):
        out.setdefault(name, value.strip())
    return out


def github_issue_facts(content: str) -> dict[str, Any]:
    """What an issue item :func:`_issue_item` wrote says about the issue: repository,
    number, the State line as written (``raw_status``) and as a tracker state, and its
    milestone's title (F7 Link tracker issues)."""
    facts = _facts(content)
    raw = facts.get("State")
    number = facts.get("Issue", "").lstrip("#")
    return {
        "repository": facts.get("Repository"),
        "number": int(number) if number.isdigit() else None,
        "raw_status": raw,
        "state": _ISSUE_STATES.get(raw or "", "unknown"),
        "milestone": facts.get("Milestone"),
    }


def github_milestone_due(content: str) -> date | None:
    """The Due day of a milestone item :func:`_milestone_item` wrote, else None."""
    due = _facts(content).get("Due")
    try:
        return _ts(due).date() if due else None
    except ValueError:
        return None


def merged_pull(item: ItemUpsert) -> tuple[str, datetime] | None:
    """(repo, merged at) of a merged pull request item :func:`_issue_item` wrote, else
    None (F5-2: a merge makes the repo's code map stale). The issues list GitHub answers
    does not name a pull request's base branch, so every merge counts."""
    if item.kind != "pull_request" or ":pull:" not in item.external_id:
        return None
    found = _MERGED.search(item.content)
    merged = _ts(found.group(1)) if found and found.group(1) != "no" else None
    if merged is None:
        return None
    return item.external_id.rsplit(":pull:", 1)[0], merged


def _release_item(repo: _Repo, release: dict[str, Any]) -> ItemUpsert:
    title = release.get("name") or release["tag_name"]
    facts = [
        ("Repository", repo.full_name),
        ("Tag", release["tag_name"]),
        ("Published", release.get("published_at")),
        ("Pre-release", "yes" if release.get("prerelease") else None),
    ]
    lines = [f"# {title}", ""] + [f"- {name}: {value}" for name, value in facts if value]
    body = (release.get("body") or "").strip()
    if body:
        lines += ["", body]
    published = _ts(release.get("published_at") or release.get("created_at"))
    return ItemUpsert(
        external_id=f"{repo.key}:release:{release['id']}",
        kind="release",
        title=title,
        url=release.get("html_url"),
        author=_login(release.get("author")),
        content="\n".join(lines) + "\n",
        acl=repo.acl,
        occurred_at=published,
        source_updated_at=published,
    )


def _milestone_item(repo: _Repo, milestone: dict[str, Any]) -> ItemUpsert:
    facts = [
        ("Repository", repo.full_name),
        ("State", milestone.get("state")),
        ("Due", milestone.get("due_on")),
        ("Open issues", milestone.get("open_issues")),
        ("Closed issues", milestone.get("closed_issues")),
        ("Closed", milestone.get("closed_at")),
    ]
    lines = [f"# {milestone['title']}", ""]
    lines += [f"- {name}: {value}" for name, value in facts if value is not None and value != ""]
    description = (milestone.get("description") or "").strip()
    if description:
        lines += ["", description]
    return ItemUpsert(
        external_id=f"{repo.key}:milestone:{milestone['number']}",
        kind="milestone",
        title=milestone["title"],
        url=milestone.get("html_url"),
        author=_login(milestone.get("creator")),
        content="\n".join(lines) + "\n",
        acl=repo.acl,
        occurred_at=_ts(milestone.get("created_at")),
        source_updated_at=_ts(milestone.get("updated_at")),
    )


class GithubConnector:
    kind = "github"

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
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
            yield _Api(client, token, self.base_url)

    async def _repo(self, api: _Api, repo: str) -> _Repo:
        resp = await api.get(f"/repos/{repo}", allow=(404,))
        if resp.status_code == 404:
            raise ConnectorConfigError(f"{repo} was not found or is not readable with this token")
        return _Repo.from_api(repo.lower(), resp.json())

    def check_config(self, config: dict[str, Any]) -> None:
        """The rules a saved config must still meet (repo names, the repo cap)."""
        _parse_config(config)

    def normalize_config(self, config: dict[str, Any]) -> dict[str, Any]:
        """Repos stripped, without repeats (case-insensitively), sorted; include sorted."""
        out = dict(config)
        repos = config.get("repos")
        if isinstance(repos, list) and all(isinstance(r, str) for r in repos):
            unique: dict[str, str] = {}
            for repo in repos:
                unique.setdefault(repo.strip().lower(), repo.strip())
            out["repos"] = [unique[k] for k in sorted(unique)]
        include = config.get("include")
        if isinstance(include, list) and all(isinstance(i, str) for i in include):
            out["include"] = sorted(set(include))
        return out

    def scope(self, config: dict[str, Any]) -> Scope:
        """Still selected: from an allowlisted repo, of a kind still included."""
        repos, include = _parse_config(config)
        return Scope(
            groups=frozenset(r.lower() for r in repos),
            kinds=frozenset(kind for kind, wanted in _KIND_INCLUDE.items() if wanted in include),
        )

    def rescope_cursor(
        self, old_cursor: dict[str, Any] | None, new_config: dict[str, Any]
    ) -> dict[str, Any] | None:
        """Keep, per repo still selected, what deletes are compared against (files,
        releases, milestones); drop what would skip re-reading (the tree, issues since)."""
        repos, _ = _parse_config(new_config)
        previous = (old_cursor or {}).get("repos") or {}
        kept: dict[str, Any] = {}
        for repo in repos:
            entry = previous.get(repo.lower())
            if not entry:
                continue
            entry = {k: copy.deepcopy(v) for k, v in entry.items() if k in _RESCOPE_KEEPS}
            if entry.get("files"):
                entry["refetch"] = True
            kept[repo.lower()] = entry
        return {"repos": kept} if kept else None

    async def validate(self, config: dict[str, Any], credential: dict[str, Any] | None) -> None:
        repos, _ = _parse_config(config)
        async with self._api(credential) as api:
            await api.get("/user")
            for repo in repos:
                await self._repo(api, repo)

    async def sync(
        self,
        config: dict[str, Any],
        credential: dict[str, Any] | None,
        cursor: dict[str, Any] | None,
    ) -> AsyncIterator[SyncEvent]:
        repos, include = _parse_config(config)
        previous = (cursor or {}).get("repos") or {}
        # Repos dropped from the allowlist lose their cursor entry.
        state: dict[str, Any] = {
            "repos": {r.lower(): previous[r.lower()] for r in repos if r.lower() in previous}
        }

        def checkpoint() -> CursorCheckpoint:
            return CursorCheckpoint(copy.deepcopy(state))

        async with self._api(credential) as api:
            for name in repos:
                repo = await self._repo(api, name)
                repo_state = state["repos"].setdefault(repo.key, {})
                if include & {"readme", "docs"} or repo_state.get("files"):
                    async for event in self._files(api, repo, include, repo_state):
                        yield event
                    yield checkpoint()
                if include & {"issues", "pull_requests"}:
                    async for event in self._issues(api, repo, include, repo_state):
                        yield checkpoint() if isinstance(event, CursorCheckpoint) else event
                for kind in ("releases", "milestones"):
                    if kind in include or repo_state.get(kind):
                        async for event in self._listed(api, repo, kind, include, repo_state):
                            yield event
                        yield checkpoint()

    async def _files(
        self, api: _Api, repo: _Repo, include: set[str], state: dict[str, Any]
    ) -> AsyncIterator[SyncEvent]:
        known: dict[str, str] = state.get("files") or {}
        wanted: dict[str, tuple[str, str, int]] = {}  # path -> (kind, blob sha, size)
        tree_sha, truncated = None, False
        file_include = sorted(include & {"readme", "docs"})
        if file_include and repo.default_branch:
            ref = quote(repo.default_branch, safe="")
            resp = await api.get(
                f"/repos/{repo.full_name}/git/trees/{ref}",
                {"recursive": "1"},
                allow=(409,),  # an empty repository
            )
            if resp.is_success:
                tree = resp.json()
                tree_sha, truncated = tree.get("sha"), bool(tree.get("truncated"))
                if tree_sha == state.get("tree_sha") and file_include == state.get("include"):
                    return
                for entry in tree.get("tree", []):
                    kind = entry["type"] == "blob" and _file_kind(entry["path"], include)
                    if kind:
                        wanted[entry["path"]] = (kind, entry["sha"], entry.get("size") or 0)

        # After a selection change every file is read again (its item may have been
        # deleted by the change); unchanged content writes no new version.
        refetch = bool(state.get("refetch"))
        for path, (kind, sha, size) in sorted(wanted.items()):
            if (known.get(path) == sha and not refetch) or size > MAX_FILE_BYTES:
                continue
            blob = (await api.get(f"/repos/{repo.full_name}/git/blobs/{sha}")).json()
            content = _decode_blob(blob)
            if content is None:
                continue
            yield ItemUpsert(
                external_id=f"{repo.key}:file:{path}",
                kind=kind,
                title=_first_heading(content) or path,
                url=f"{repo.html_url}/blob/{quote(repo.default_branch or '')}/{quote(path)}",
                author=None,
                content=content,
                acl=repo.acl,
            )

        files = {path: sha for path, (_, sha, _) in wanted.items()}
        if truncated:
            # A truncated tree may omit files that still exist: keep them, retry next time.
            # Every file it lists was read again above, so the refetch is done (a tree
            # truncated every time must not re-read every blob on every sync).
            state["files"] = {**known, **files}
            state.pop("tree_sha", None)
            state.pop("refetch", None)
            return
        for path in sorted(known.keys() - files.keys()):
            yield ItemDelete(external_id=f"{repo.key}:file:{path}")
        state["files"], state["tree_sha"], state["include"] = files, tree_sha, file_include
        state.pop("refetch", None)

    async def _issues(
        self, api: _Api, repo: _Repo, include: set[str], state: dict[str, Any]
    ) -> AsyncIterator[SyncEvent]:
        """Issues and pull requests (one list endpoint), oldest update first.

        Yields a :class:`CursorCheckpoint` placeholder after each page; the caller turns
        it into the connector-wide checkpoint.
        """
        params = {"state": "all", "sort": "updated", "direction": "asc"}
        if state.get("issues_since"):
            params["since"] = state["issues_since"]
        # 410: issues are disabled on the repository.
        async for page in api.pages(f"/repos/{repo.full_name}/issues", params, allow=(410,)):
            for issue in page:
                is_pr = "pull_request" in issue
                if ("pull_requests" if is_pr else "issues") in include:
                    yield _issue_item(repo, issue)
            if page:
                state["issues_since"] = page[-1]["updated_at"]
            yield CursorCheckpoint({})

    async def _listed(
        self, api: _Api, repo: _Repo, kind: str, include: set[str], state: dict[str, Any]
    ) -> AsyncIterator[SyncEvent]:
        """Releases or milestones: listed in full each sync; ones gone since are deleted."""
        seen: list[int] = []
        if kind in include:
            if kind == "releases":
                pages = api.pages(f"/repos/{repo.full_name}/releases", {})
            else:
                pages = api.pages(f"/repos/{repo.full_name}/milestones", {"state": "all"})
            async for page in pages:
                for entry in page:
                    if kind == "releases":
                        if entry.get("draft"):
                            continue
                        seen.append(entry["id"])
                        yield _release_item(repo, entry)
                    else:
                        seen.append(entry["number"])
                        yield _milestone_item(repo, entry)
        prefix = "release" if kind == "releases" else "milestone"
        for gone in sorted(set(state.get(kind) or []) - set(seen)):
            yield ItemDelete(external_id=f"{repo.key}:{prefix}:{gone}")
        state[kind] = sorted(seen)


register(GithubConnector())
