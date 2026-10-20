"""GitHub repo picker: the repos a user's GitHub connection can read (S5).

``GET /user/repos`` with the user's token: their own repos, those they collaborate on
and those of their organizations, most recently pushed first.
"""

import uuid
from datetime import datetime
from typing import Annotated, Any
from urllib.parse import parse_qs, urlparse

import httpx
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel

from oracle.auth.deps import TenantDB
from oracle.connections import browse
from oracle.connections.browse import open_connection, provider_error, unreachable
from oracle.connections.router import ProviderHttp, UserPrincipal
from oracle.sources.base import ConnectorError
from oracle.sources.connectors.github import API_URL, PER_PAGE, _Api

router = APIRouter(prefix="/v1", tags=["connections"])

AFFILIATION = "owner,collaborator,organization_member"
# A search reads on through GitHub's pages (``/user/repos`` has no filter) until it has
# this many matches or has read MAX_PAGES pages; the cursor resumes where it stopped.
SEARCH_RESULTS = 50
MAX_PAGES = 5


class GithubRepoOut(BaseModel):
    full_name: str
    owner: str
    name: str
    is_private: bool
    is_archived: bool
    description: str | None
    pushed_at: datetime | None


class GithubRepoPage(BaseModel):
    repos: list[GithubRepoOut]
    # Pass back as ``cursor`` for more; null at the end.
    next_cursor: str | None
    # Set when GitHub left out organizations whose SAML single sign-on this sign-in has
    # not been authorized for (``X-GitHub-SSO: partial-results``).
    sso_hint: str | None = None


def _sso_hint(header: str | None) -> str | None:
    """``partial-results; organizations=21955855,20582480`` -> what the picker shows."""
    if not header or not header.strip().lower().startswith("partial-results"):
        return None
    orgs = header.partition("organizations=")[2].split(";")[0]
    count = len([o for o in orgs.split(",") if o.strip()])
    who = {
        0: "Some organizations hide their repositories",
        1: "1 organization hides its repositories",
    }.get(count, f"{count} organizations hide their repositories")
    return (
        f"{who} until you authorize this GitHub sign-in for their single sign-on (SAML): "
        "on GitHub, open Settings > Applications (or your token's Configure SSO) and "
        "authorize it, then reload"
    )


def _repo(entry: dict[str, Any]) -> GithubRepoOut:
    owner, _, name = entry["full_name"].partition("/")
    return GithubRepoOut(
        full_name=entry["full_name"],
        owner=(entry.get("owner") or {}).get("login") or owner,
        name=entry.get("name") or name,
        is_private=bool(entry.get("private")),
        is_archived=bool(entry.get("archived")),
        description=entry.get("description") or None,
        pushed_at=entry.get("pushed_at"),
    )


def _next_page(link: dict[str, Any] | None) -> int | None:
    pages = parse_qs(urlparse((link or {}).get("url", "")).query).get("page")
    return int(pages[0]) if pages and pages[0].isdigit() else None


@router.get(
    "/connections/{connection_id}/github/repos",
    response_model=GithubRepoPage,
    responses={
        403: {"description": "GitHub refused the request (the connection stays usable)"},
        404: {"description": "Not one of your GitHub connections"},
        409: {"description": "The connection needs reconnecting"},
        429: {
            "description": "GitHub is rate limiting, or this connection searched too often; "
            "retry after Retry-After seconds"
        },
    },
)
async def list_github_repos(
    connection_id: uuid.UUID,
    principal: UserPrincipal,
    db: TenantDB,
    http: ProviderHttp,
    search: Annotated[str, Query(max_length=200)] = "",
    cursor: Annotated[str | None, Query(max_length=10)] = None,
) -> GithubRepoPage:
    """Repos your GitHub sign-in can read, matched on owner/name and description.

    Answers are cached for a minute per connection, and a connection may search GitHub
    a limited number of times a minute."""
    page: int | None = 1
    if cursor is not None:
        if not cursor.isdigit() or int(cursor) < 1:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Unknown cursor")
        page = int(cursor)
    conn, token = await open_connection(db, principal, connection_id, "github")
    key = ("github/repos", search, page)
    hit = browse.cached(conn, key)
    if hit is not None:
        return hit
    browse.admit(conn, "GitHub")
    api = _Api(http, token, API_URL)
    needle = search.strip().lower()
    want = SEARCH_RESULTS if needle else 1
    found: list[GithubRepoOut] = []
    sso_hint: str | None = None
    try:
        for _ in range(MAX_PAGES):
            assert page is not None
            resp = await api.get(
                "/user/repos",
                {
                    "affiliation": AFFILIATION,
                    "sort": "pushed",
                    "direction": "desc",
                    "per_page": PER_PAGE,
                    "page": page,
                },
            )
            sso_hint = sso_hint or _sso_hint(resp.headers.get("X-GitHub-SSO"))
            for entry in resp.json():
                repo = _repo(entry)
                text = f"{repo.full_name} {repo.description or ''}".lower()
                if needle and needle not in text:
                    continue
                found.append(repo)
            page = _next_page(resp.links.get("next"))
            if page is None or len(found) >= want:
                break
    except ConnectorError as e:
        raise await provider_error(db, conn, "GitHub", e) from None
    except (httpx.HTTPError, ValueError):
        raise unreachable("GitHub") from None
    answer = GithubRepoPage(repos=found, next_cursor=str(page) if page else None, sso_hint=sso_hint)
    browse.remember(conn, key, answer)
    return answer
