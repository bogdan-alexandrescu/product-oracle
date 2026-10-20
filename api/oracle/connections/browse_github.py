"""GitHub repo picker: the repos a user's GitHub connection can read (S5).

``GET /user/repos`` with the user's token: their own repos, those they collaborate on
and those of their organizations, most recently pushed first.
"""

import uuid
from datetime import datetime
from typing import Annotated, Any
from urllib.parse import parse_qs, urlparse

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel

from oracle.auth.deps import TenantDB
from oracle.connections.browse import open_connection, provider_error
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
        404: {"description": "Not one of your GitHub connections"},
        409: {"description": "The connection needs reconnecting"},
        429: {"description": "GitHub is rate limiting; retry after Retry-After seconds"},
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
    """Repos your GitHub sign-in can read, matched on owner/name and description."""
    page: int | None = 1
    if cursor is not None:
        if not cursor.isdigit() or int(cursor) < 1:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Unknown cursor")
        page = int(cursor)
    conn, token = await open_connection(db, principal, connection_id, "github")
    api = _Api(http, token, API_URL)
    needle = search.strip().lower()
    want = SEARCH_RESULTS if needle else 1
    found: list[GithubRepoOut] = []
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
    return GithubRepoPage(repos=found, next_cursor=str(page) if page else None)
