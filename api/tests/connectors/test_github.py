"""GitHub connector against recorded-style responses (tests/fixtures/connectors/github)."""

import json
import time
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest

from oracle.sources.base import (
    Connector,
    ConnectorAuthError,
    ConnectorConfigError,
    ConnectorRateLimited,
    CursorCheckpoint,
    ItemDelete,
    ItemUpsert,
    get_connector,
)
from oracle.sources.connectors import github
from oracle.sources.connectors.github import GithubConnector

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "connectors" / "github"
API = "https://api.github.com"
REPO = "/repos/example-org/widgets"
CREDENTIAL = {"token": "test-token"}
CONFIG = {"repos": ["example-org/widgets"]}


def fixture(name: str):
    return json.loads((FIXTURES / name).read_text())


class FakeGithub:
    """Routes ``GET <path>`` to a fixture file name, a callable or a JSON body (``json()``)."""

    def __init__(self, routes: dict):
        self.routes = routes
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        assert request.headers["authorization"] == "Bearer test-token"
        assert request.headers["x-github-api-version"] == github.API_VERSION
        route = self.routes.get(request.url.path.lower())  # GitHub paths ignore case
        if callable(route):
            return route(request)
        if route is None:
            return httpx.Response(404, json=fixture("error_not_found.json"))
        return httpx.Response(200, json=fixture(route))

    def paths(self) -> list[str]:
        return [r.url.path for r in self.requests]

    def connector(self) -> GithubConnector:
        return GithubConnector(client=httpx.AsyncClient(transport=httpx.MockTransport(self)))


def body(data):
    return lambda request: httpx.Response(200, json=data)


def issues_pages(request: httpx.Request) -> httpx.Response:
    params = request.url.params
    assert params["state"] == "all" and params["sort"] == "updated"
    assert params["direction"] == "asc" and params["per_page"] == "100"
    if params.get("page") == "2":
        return httpx.Response(200, json=fixture("issues_page2.json"))
    assert "since" not in params
    next_url = f"{API}/repositories/3001/issues?state=all&sort=updated&direction=asc"
    next_url += "&per_page=100&page=2"
    link = f'<{next_url}>; rel="next", <{next_url}>; rel="last"'
    return httpx.Response(200, json=fixture("issues_page1.json"), headers={"Link": link})


def full_routes() -> dict:
    return {
        "/user": "user.json",
        REPO: "repo_widgets.json",
        f"{REPO}/git/trees/main": "tree_widgets.json",
        f"{REPO}/git/blobs/a000000000000000000000000000000000000001": "blob_readme.json",
        f"{REPO}/git/blobs/a000000000000000000000000000000000000002": "blob_guide.json",
        f"{REPO}/git/blobs/a000000000000000000000000000000000000003": "blob_endpoints.json",
        f"{REPO}/issues": issues_pages,
        "/repositories/3001/issues": issues_pages,
        f"{REPO}/releases": "releases.json",
        f"{REPO}/milestones": "milestones.json",
    }


async def collect(connector, config=CONFIG, cursor=None):
    return [event async for event in connector.sync(config, CREDENTIAL, cursor)]


def upserts(events) -> dict[str, ItemUpsert]:
    return {e.external_id: e for e in events if isinstance(e, ItemUpsert)}


def last_cursor(events) -> dict:
    return [e for e in events if isinstance(e, CursorCheckpoint)][-1].cursor


def test_registered_with_oauth_metadata():
    connector = get_connector("github")
    assert isinstance(connector, GithubConnector)
    assert isinstance(connector, Connector)
    assert set(github.OAUTH) >= {"authorize_url", "token_url", "scopes"}
    assert github.OAUTH["authorize_url"].startswith("https://github.com/")


async def test_validate():
    fake = FakeGithub(full_routes())
    await fake.connector().validate(CONFIG, CREDENTIAL)
    assert fake.paths() == ["/user", REPO]


@pytest.mark.parametrize(
    ("config", "credential", "message"),
    [
        ({}, CREDENTIAL, "at least one repo"),
        ({"repos": ["widgets"]}, CREDENTIAL, "owner/name"),
        # Path segments, not repos: /repos/example-org/.. would read /repos.
        ({"repos": ["example-org/."]}, CREDENTIAL, "owner/name"),
        ({"repos": ["example-org/.."]}, CREDENTIAL, "owner/name"),
        ({"repos": ["example-org/widgets"], "include": ["wiki"]}, CREDENTIAL, "unknown"),
        ({"repos": ["example-org/widgets"], "include": []}, CREDENTIAL, "include at least"),
        (CONFIG, {}, "token is required"),
        ({"repos": ["example-org/widgets", "example-org/missing"]}, CREDENTIAL, "missing"),
    ],
)
async def test_validate_rejects(config, credential, message):
    with pytest.raises(ConnectorConfigError, match=message):
        await FakeGithub(full_routes()).connector().validate(config, credential)


async def test_validate_auth_error():
    routes = {"/user": lambda r: httpx.Response(401, json=fixture("error_unauthorized.json"))}
    with pytest.raises(ConnectorAuthError, match="Bad credentials"):
        await FakeGithub(routes).connector().validate(CONFIG, CREDENTIAL)


async def test_full_sync():
    fake = FakeGithub(full_routes())
    events = await collect(fake.connector())
    items = upserts(events)

    assert sorted(items) == [
        "example-org/widgets:file:README.md",
        "example-org/widgets:file:docs/api/endpoints.md",
        "example-org/widgets:file:docs/guide.md",
        "example-org/widgets:issue:1",
        "example-org/widgets:issue:3",
        "example-org/widgets:milestone:1",
        "example-org/widgets:pull:2",
        "example-org/widgets:release:5001",  # the draft release is left out
    ]
    acl = {"visibility": "private", "repo": "example-org/widgets"}
    assert all(item.acl == acl for item in items.values())

    readme = items["example-org/widgets:file:README.md"]
    assert readme.kind == "readme"
    assert readme.title == "Widgets"
    assert readme.url == "https://github.com/example-org/widgets/blob/main/README.md"
    assert readme.content == "# Widgets\n\nWidgets turns orders into shipments.\n"
    assert items["example-org/widgets:file:docs/guide.md"].kind == "doc"

    issue = items["example-org/widgets:issue:1"]
    assert issue.kind == "issue"
    assert issue.title == "Bulk import of orders"
    assert issue.url == "https://github.com/example-org/widgets/issues/1"
    assert issue.author == "example-user"
    assert issue.occurred_at == datetime(2026, 9, 1, 10, tzinfo=UTC)
    assert issue.source_updated_at == datetime(2026, 9, 2, 10, tzinfo=UTC)
    assert issue.content == (
        "# Bulk import of orders\n\n"
        "- Repository: example-org/widgets\n"
        "- Issue: #1\n"
        "- State: open\n"
        "- Labels: feature, import\n"
        "- Author: example-user\n"
        "- Created: 2026-09-01T10:00:00Z\n"
        "- Milestone: Beta\n\n"
        "Customers want to import orders from a CSV file.\n"
    )
    pull = items["example-org/widgets:pull:2"]
    assert pull.kind == "pull_request"
    assert "- State: merged\n" in pull.content
    assert "- Merged: 2026-09-03T09:00:00Z\n" in pull.content
    closed = items["example-org/widgets:issue:3"]
    assert "- State: closed (completed)\n" in closed.content
    assert closed.author == "another-user"

    release = items["example-org/widgets:release:5001"]
    assert release.kind == "release"
    assert release.title == "v0.2.0: CSV import"
    assert release.content.endswith("- CSV import (#2)\n- Fix: empty rows (#3)\n")
    assert release.occurred_at == datetime(2026, 9, 5, 11, tzinfo=UTC)
    milestone = items["example-org/widgets:milestone:1"]
    assert milestone.kind == "milestone"
    assert "- Due: 2026-10-31T07:00:00Z\n- Open issues: 1\n- Closed issues: 2\n" in (
        milestone.content
    )

    # Non-markdown files, nested READMEs and source code are not fetched.
    assert not any("a000000000000000000000000000000000000004" in p for p in fake.paths())
    assert not any("a000000000000000000000000000000000000006" in p for p in fake.paths())

    cursor = last_cursor(events)["repos"]["example-org/widgets"]
    assert cursor["tree_sha"] == "7ree000000000000000000000000000000000001"
    assert cursor["issues_since"] == "2026-09-04T10:00:00Z"
    assert cursor["releases"] == [5001]
    assert cursor["milestones"] == [1]
    assert not any(isinstance(e, ItemDelete) for e in events)


async def test_issues_paginate_with_a_checkpoint_per_page():
    events = await collect(FakeGithub(full_routes()).connector(), {**CONFIG, "include": ["issues"]})
    kinds = [type(e).__name__ for e in events]
    assert kinds == ["ItemUpsert", "CursorCheckpoint", "ItemUpsert", "CursorCheckpoint"]
    first, second = (e.cursor for e in events if isinstance(e, CursorCheckpoint))
    assert first["repos"]["example-org/widgets"]["issues_since"] == "2026-09-03T10:00:00Z"
    assert second["repos"]["example-org/widgets"]["issues_since"] == "2026-09-04T10:00:00Z"
    # Pull requests are left out when only issues are included.
    assert sorted(upserts(events)) == ["example-org/widgets:issue:1", "example-org/widgets:issue:3"]


async def test_incremental_sync_from_cursor():
    cursor = last_cursor(await collect(FakeGithub(full_routes()).connector()))

    def issues_since(request):
        assert request.url.params["since"] == "2026-09-04T10:00:00Z"
        return httpx.Response(200, json=fixture("issues_since.json"))

    releases = fixture("releases.json")[1:]
    releases[0]["body"] += "\n- Edited notes"
    fake = FakeGithub(
        {
            REPO: "repo_widgets.json",
            f"{REPO}/git/trees/main": "tree_widgets_v2.json",
            f"{REPO}/git/blobs/a000000000000000000000000000000000000012": "blob_guide_v2.json",
            f"{REPO}/issues": issues_since,
            f"{REPO}/releases": body(releases),
            f"{REPO}/milestones": body([]),
        }
    )
    events = await collect(fake.connector(), cursor=cursor)

    # Only the changed blob is fetched; the README's sha is unchanged.
    assert [p for p in fake.paths() if "/blobs/" in p] == [
        f"{REPO}/git/blobs/a000000000000000000000000000000000000012"
    ]
    assert sorted(upserts(events)) == [
        "example-org/widgets:file:docs/guide.md",
        "example-org/widgets:issue:3",
        "example-org/widgets:pull:4",
        "example-org/widgets:release:5001",
    ]
    assert "--demo" in upserts(events)["example-org/widgets:file:docs/guide.md"].content
    reopened = upserts(events)["example-org/widgets:issue:3"]
    assert "- State: open\n" in reopened.content
    draft_pr = upserts(events)["example-org/widgets:pull:4"]
    assert "- State: open\n" in draft_pr.content and "- Merged: no\n" in draft_pr.content
    assert [e.external_id for e in events if isinstance(e, ItemDelete)] == [
        "example-org/widgets:file:docs/api/endpoints.md",
        "example-org/widgets:milestone:1",
    ]
    state = last_cursor(events)["repos"]["example-org/widgets"]
    assert state["issues_since"] == "2026-09-11T10:00:00Z"
    assert state["milestones"] == []
    assert sorted(state["files"]) == ["README.md", "docs/guide.md"]


async def test_unchanged_tree_fetches_no_blobs():
    config = {**CONFIG, "include": ["readme", "docs"]}
    cursor = last_cursor(await collect(FakeGithub(full_routes()).connector(), config))
    fake = FakeGithub(full_routes())
    events = await collect(fake.connector(), config, cursor)
    assert not [e for e in events if not isinstance(e, CursorCheckpoint)]
    assert fake.paths() == [REPO, f"{REPO}/git/trees/main"]


async def test_a_truncated_tree_clears_the_refetch_flag():
    """After a selection change every listed file is read again once; a tree GitHub
    truncates every time must not make every later sync re-read every blob."""
    config = {**CONFIG, "include": ["readme", "docs"]}
    routes = full_routes()
    tree = fixture("tree_widgets.json")
    routes[f"{REPO}/git/trees/main"] = body({**tree, "truncated": True})
    first = last_cursor(await collect(FakeGithub(routes).connector(), config))
    rescoped = GithubConnector().rescope_cursor(first, config)
    assert rescoped["repos"]["example-org/widgets"]["refetch"] is True
    fake = FakeGithub(routes)
    cursor = last_cursor(await collect(fake.connector(), config, rescoped))
    assert "refetch" not in cursor["repos"]["example-org/widgets"]
    assert any("/git/blobs/" in p for p in fake.paths())
    # The next sync reads only blobs it does not know.
    fake = FakeGithub(routes)
    await collect(fake.connector(), config, cursor)
    assert not any("/git/blobs/" in p for p in fake.paths())


def test_the_config_is_normalised():
    config = {"repos": [" b/x", "A/y", "a/Y", "b/x"], "include": ["docs", "readme", "docs"]}
    assert GithubConnector().normalize_config(config) == {
        "repos": ["A/y", "b/x"],
        "include": ["docs", "readme"],
    }


async def test_dropping_kinds_from_include_deletes_them():
    cursor = last_cursor(await collect(FakeGithub(full_routes()).connector()))
    connector = FakeGithub(full_routes()).connector()
    events = await collect(connector, {**CONFIG, "include": ["readme"]}, cursor)
    # Issues and pull requests are not tracked by id, so they stay.
    assert [e.external_id for e in events if isinstance(e, ItemDelete)] == [
        "example-org/widgets:file:docs/api/endpoints.md",
        "example-org/widgets:file:docs/guide.md",
        "example-org/widgets:release:5001",
        "example-org/widgets:milestone:1",
    ]
    assert not upserts(events)


async def test_empty_repo_and_public_acl():
    fake = FakeGithub(
        {
            "/repos/example-org/gadgets": "repo_gadgets.json",
            "/repos/example-org/gadgets/git/trees/main": lambda r: httpx.Response(
                409, json=fixture("error_empty_repo.json")
            ),
            "/repos/example-org/gadgets/issues": body([]),
            "/repos/example-org/gadgets/releases": "releases.json",
            "/repos/example-org/gadgets/milestones": body([]),
        }
    )
    events = await collect(fake.connector(), {"repos": ["Example-Org/Gadgets"]})
    items = upserts(events)
    assert list(items) == ["example-org/gadgets:release:5001"]
    assert items["example-org/gadgets:release:5001"].acl == {
        "visibility": "public",
        "repo": "example-org/gadgets",
    }
    assert list(last_cursor(events)["repos"]) == ["example-org/gadgets"]


async def test_sync_auth_error():
    routes = {REPO: lambda r: httpx.Response(401, json=fixture("error_unauthorized.json"))}
    with pytest.raises(ConnectorAuthError):
        await collect(FakeGithub(routes).connector())


async def test_forbidden_without_rate_limit_is_an_auth_error():
    body = {"message": "Resource not accessible by personal access token"}
    routes = {**full_routes(), f"{REPO}/git/trees/main": lambda r: httpx.Response(403, json=body)}
    with pytest.raises(ConnectorAuthError, match="not accessible"):
        await collect(FakeGithub(routes).connector())


async def test_primary_rate_limit():
    reset = int(time.time()) + 60
    headers = {"x-ratelimit-remaining": "0", "x-ratelimit-reset": str(reset)}
    routes = {
        **full_routes(),
        f"{REPO}/issues": lambda r: httpx.Response(
            403, json=fixture("error_rate_limited.json"), headers=headers
        ),
    }
    events = []
    with pytest.raises(ConnectorRateLimited) as raised:
        async for event in FakeGithub(routes).connector().sync(CONFIG, CREDENTIAL, None):
            events.append(event)
    assert 50 < raised.value.retry_after <= 60
    # The files done before the limit are checkpointed, so the next sync resumes there.
    assert last_cursor(events)["repos"]["example-org/widgets"]["tree_sha"]


async def test_secondary_rate_limit_and_429():
    secondary = {"message": "You have exceeded a secondary rate limit."}
    routes = {REPO: lambda r: httpx.Response(403, json=secondary, headers={"retry-after": "30"})}
    with pytest.raises(ConnectorRateLimited) as raised:
        await collect(FakeGithub(routes).connector())
    assert raised.value.retry_after == 30

    routes = {REPO: lambda r: httpx.Response(429, json={"message": "Too many requests"})}
    with pytest.raises(ConnectorRateLimited) as raised:
        await collect(FakeGithub(routes).connector())
    assert raised.value.retry_after is None


async def test_oauth_credential_shape_is_accepted():
    fake = FakeGithub(full_routes())
    events = [
        e
        async for e in fake.connector().sync(
            {**CONFIG, "include": ["milestones"]}, {"access_token": "test-token"}, None
        )
    ]
    assert list(upserts(events)) == ["example-org/widgets:milestone:1"]
