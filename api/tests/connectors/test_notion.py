"""Notion connector against recorded-style responses (tests/fixtures/connectors/notion)."""

import json
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
from oracle.sources.connectors import notion
from oracle.sources.connectors.notion import NotionConnector

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "connectors" / "notion"
CREDENTIAL = {"token": "ntn_example"}
ROOT = "11111111-1111-4111-8111-111111111111"
CHILD = "22222222-2222-4222-8222-222222222222"
DB = "33333333-3333-4333-8333-333333333333"
ROW1 = "44444444-4444-4444-8444-444444444441"
ROW2 = "44444444-4444-4444-8444-444444444442"
GRAND = "55555555-5555-4555-8555-555555555555"
USER = "66666666-6666-4666-8666-666666666666"
BULLET = "b0000000-0000-4000-8000-000000000002"
TOGGLE = "b0000000-0000-4000-8000-000000000001"
TABLE = "b0000000-0000-4000-8000-000000000003"
QUOTE = "b0000000-0000-4000-8000-000000000004"
CONFIG = {"roots": [ROOT]}


def fixture(name: str):
    return json.loads((FIXTURES / name).read_text())


def not_found(request=None) -> httpx.Response:
    return httpx.Response(404, json=fixture("error_not_found.json"))


class FakeNotion:
    """Routes ``METHOD path`` (plus ``#<start_cursor>`` when paginating) to recorded bodies."""

    def __init__(self, routes: dict):
        self.routes = routes
        self.requests: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer ntn_example"
        assert request.headers["notion-version"] == notion.API_VERSION
        path = request.url.path.removeprefix("/v1")
        start = request.url.params.get("start_cursor")
        if request.method == "POST":
            assert request.url.params.get("start_cursor") is None
            start = json.loads(request.content).get("start_cursor")
        key = f"{request.method} {path}" + (f"#{start}" if start else "")
        self.requests.append(key)
        route = self.routes.get(key)
        if route is None:
            return not_found()
        if callable(route):
            return route(request)
        return httpx.Response(200, json=fixture(route))

    def connector(self) -> NotionConnector:
        return NotionConnector(client=httpx.AsyncClient(transport=httpx.MockTransport(self)))


def full_routes() -> dict:
    return {
        "GET /users/me": "users_me.json",
        f"GET /users/{USER}": "user.json",
        f"GET /pages/{ROOT}": "page_root.json",
        f"GET /blocks/{ROOT}/children": "blocks_root_1.json",
        f"GET /blocks/{ROOT}/children#cursor-root-2": "blocks_root_2.json",
        f"GET /blocks/{BULLET}/children": "blocks_bullet.json",
        f"GET /blocks/{TOGGLE}/children": "blocks_toggle.json",
        f"GET /blocks/{QUOTE}/children": "blocks_quote.json",
        f"GET /blocks/{TABLE}/children": "blocks_table.json",
        f"GET /pages/{CHILD}": "page_child.json",
        f"GET /blocks/{CHILD}/children": "blocks_child.json",
        f"GET /pages/{GRAND}": "page_grandchild.json",
        f"GET /blocks/{GRAND}/children": "blocks_grandchild.json",
        f"POST /databases/{DB}/query": "query_1.json",
        f"POST /databases/{DB}/query#cursor-db-2": "query_2.json",
        f"GET /blocks/{ROW1}/children": "blocks_row1.json",
        f"GET /blocks/{ROW2}/children": "blocks_empty.json",
        f"GET /databases/{DB}": "database.json",
    }


async def collect(connector, config=CONFIG, cursor=None):
    return [event async for event in connector.sync(config, CREDENTIAL, cursor)]


def upserts(events) -> dict[str, ItemUpsert]:
    return {e.external_id: e for e in events if isinstance(e, ItemUpsert)}


def last_cursor(events) -> dict:
    return [e for e in events if isinstance(e, CursorCheckpoint)][-1].cursor


ROOT_MARKDOWN = """# Product handbook

# Overview

Widgets ships **orders** fast. See [the site](https://example.com).

- Import

  - CSV
  - JSON
- Export
1. Discover
2. Deliver
- [x] Write PRD
- [ ] Review PRD

<details>
<summary>Details</summary>

Hidden detail.

</details>

> Ship small.
>
> Then iterate.

> 💡 Beta ends in October.

```shell
widgets init
widgets run
```

| Metric | Target |
| --- | --- |
| Activation | 40% \\| weekly |

---

[Roadmap](https://www.notion.so/22222222222242228222222222222222)

[Feature requests](https://www.notion.so/33333333333343338333333333333333)

![Flow](https://files.example.com/flow.png)

## Notes

`code` and ~~struck~~ and *leaning*
"""


def test_registered_with_oauth_metadata():
    connector = get_connector("notion")
    assert isinstance(connector, NotionConnector)
    assert isinstance(connector, Connector)
    assert set(notion.OAUTH) >= {"authorize_url", "token_url", "scopes"}
    assert notion.OAUTH["token_url"] == "https://api.notion.com/v1/oauth/token"


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (ROOT, ROOT),
        (ROOT.replace("-", ""), ROOT),
        (f"https://www.notion.so/example/Product-handbook-{ROOT.replace('-', '')}?pvs=4", ROOT),
        ("https://www.notion.so/example/Product-handbook", None),
        ("not an id", None),
    ],
)
def test_normalize_id(value, expected):
    assert notion.normalize_id(value) == expected


async def test_validate():
    fake = FakeNotion(full_routes())
    await fake.connector().validate({"roots": [ROOT, DB]}, CREDENTIAL)
    assert fake.requests == [
        "GET /users/me",
        f"GET /pages/{ROOT}",
        f"GET /pages/{DB}",
        f"GET /databases/{DB}",
    ]


@pytest.mark.parametrize(
    ("config", "credential", "message"),
    [
        ({}, CREDENTIAL, "at least one root"),
        ({"roots": ["nope"]}, CREDENTIAL, "not a Notion page"),
        (CONFIG, {}, "token is required"),
        ({"roots": ["99999999-9999-4999-8999-999999999999"]}, CREDENTIAL, "not shared"),
    ],
)
async def test_validate_rejects(config, credential, message):
    with pytest.raises(ConnectorConfigError, match=message):
        await FakeNotion(full_routes()).connector().validate(config, credential)


async def test_validate_auth_error():
    routes = {
        "GET /users/me": lambda r: httpx.Response(401, json=fixture("error_unauthorized.json"))
    }
    with pytest.raises(ConnectorAuthError, match="unauthorized"):
        await FakeNotion(routes).connector().validate(CONFIG, CREDENTIAL)


async def test_full_sync():
    fake = FakeNotion(full_routes())
    events = await collect(fake.connector())
    items = upserts(events)

    # Depth first, in page order: root, its child page and grandchild, then database rows.
    assert list(items) == [ROOT, CHILD, GRAND, ROW1, ROW2]
    assert all(item.kind == "page" for item in items.values())
    assert all(
        item.acl == {"visibility": "shared_with_integration", "root": ROOT}
        for item in items.values()
    )

    root = items[ROOT]
    assert root.title == "Product handbook"
    assert root.url == f"https://www.notion.so/Product-handbook-{ROOT.replace('-', '')}"
    assert root.author == "Alex Example"
    assert root.occurred_at == datetime(2026, 9, 1, 10, tzinfo=UTC)
    assert root.source_updated_at == datetime(2026, 9, 2, 10, tzinfo=UTC)
    assert root.content == ROOT_MARKDOWN

    assert items[CHILD].content == (
        "# Roadmap\n\nQ4 focuses on imports.\n\n"
        "[Q4 themes](https://www.notion.so/55555555555545558555555555555555)\n"
    )
    assert items[ROW1].content == (
        "# Bulk import\n\n"
        "- Due: 2026-10-31\n"
        "- Owner: Alex Example\n"
        "- Status: Planned\n"
        "- Tags: import, csv\n"
        "- Votes: 12\n\n"
        "Customers ask for CSV import.\n"
    )
    assert (
        items[ROW2].content == "# Dark mode\n\n- Owner: Alex Example\n- Status: Idea\n- Votes: 12\n"
    )

    # The author is looked up once per user.
    assert fake.requests.count(f"GET /users/{USER}") == 1
    # Child pages are not fetched as blocks of their parent.
    assert f"GET /blocks/{CHILD}/children" in fake.requests

    cursor = last_cursor(events)["pages"]
    assert set(cursor) == {ROOT, CHILD, GRAND, ROW1, ROW2}
    assert cursor[ROOT] == {
        "edited": "2026-09-02T10:00:00.000Z",
        "children": [CHILD],
        "databases": [DB],
    }
    assert not any(isinstance(e, ItemDelete) for e in events)


async def test_database_root():
    routes = full_routes()
    routes[f"GET /pages/{DB}"] = lambda r: httpx.Response(
        400, json={"object": "error", "status": 400, "code": "validation_error", "message": "x"}
    )
    events = await collect(FakeNotion(routes).connector(), {"roots": [DB]})
    assert list(upserts(events)) == [ROW1, ROW2]
    assert upserts(events)[ROW1].acl["root"] == DB


async def test_incremental_sync_and_deletes():
    cursor = last_cursor(await collect(FakeNotion(full_routes()).connector()))

    routes = full_routes()
    # The root was edited, the Roadmap page archived, one row edited and the other removed.
    routes[f"GET /pages/{ROOT}"] = "page_root_v2.json"
    routes[f"GET /blocks/{ROOT}/children"] = "blocks_root_v2.json"
    routes[f"GET /pages/{CHILD}"] = "page_child_archived.json"
    routes[f"POST /databases/{DB}/query"] = "query_v2.json"
    fake = FakeNotion(routes)
    events = await collect(fake.connector(), cursor=cursor)

    assert list(upserts(events)) == [ROOT, ROW1]
    assert upserts(events)[ROOT].content == (
        "# Product handbook\n\nRewritten overview.\n\n"
        "[Roadmap](https://www.notion.so/22222222222242228222222222222222)\n\n"
        "[Feature requests](https://www.notion.so/33333333333343338333333333333333)\n"
    )
    assert "- Status: In progress\n" in upserts(events)[ROW1].content
    # The archived page takes its subtree with it; the removed row is gone too.
    assert [e.external_id for e in events if isinstance(e, ItemDelete)] == sorted(
        [CHILD, GRAND, ROW2]
    )
    assert set(last_cursor(events)["pages"]) == {ROOT, ROW1}
    assert f"GET /blocks/{CHILD}/children" not in fake.requests


async def test_unchanged_pages_are_not_refetched():
    cursor = last_cursor(await collect(FakeNotion(full_routes()).connector()))
    fake = FakeNotion(full_routes())
    events = await collect(fake.connector(), cursor=cursor)

    assert [e for e in events if not isinstance(e, CursorCheckpoint)] == []
    assert not any("/blocks/" in r for r in fake.requests)
    assert last_cursor(events) == cursor


async def test_unshared_page_is_deleted():
    cursor = last_cursor(await collect(FakeNotion(full_routes()).connector()))
    routes = full_routes()
    routes[f"GET /pages/{CHILD}"] = not_found
    events = await collect(FakeNotion(routes).connector(), cursor=cursor)
    assert [e.external_id for e in events if isinstance(e, ItemDelete)] == [CHILD, GRAND]


async def test_unshared_root_deletes_everything_under_it():
    cursor = last_cursor(await collect(FakeNotion(full_routes()).connector()))
    routes = full_routes()
    routes[f"GET /pages/{ROOT}"] = not_found
    events = await collect(FakeNotion(routes).connector(), cursor=cursor)
    deleted = [e.external_id for e in events if isinstance(e, ItemDelete)]
    assert deleted == sorted([ROOT, CHILD, GRAND, ROW1, ROW2])
    assert last_cursor(events) == {"pages": {}}


async def test_sync_auth_error():
    routes = {
        f"GET /pages/{ROOT}": lambda r: httpx.Response(401, json=fixture("error_unauthorized.json"))
    }
    with pytest.raises(ConnectorAuthError):
        await collect(FakeNotion(routes).connector())


async def test_rate_limit_with_retry_after():
    routes = full_routes()
    routes[f"GET /blocks/{CHILD}/children"] = lambda r: httpx.Response(
        429, json=fixture("error_rate_limited.json"), headers={"Retry-After": "7"}
    )
    events = []
    with pytest.raises(ConnectorRateLimited) as raised:
        async for event in FakeNotion(routes).connector().sync(CONFIG, CREDENTIAL, None):
            events.append(event)
    assert raised.value.retry_after == 7
    assert [e.external_id for e in events if isinstance(e, ItemUpsert)] == [ROOT]


async def test_checkpoints_every_n_pages(monkeypatch):
    monkeypatch.setattr(notion, "CHECKPOINT_EVERY", 2)
    events = await collect(FakeNotion(full_routes()).connector())
    kinds = ["U" if isinstance(e, ItemUpsert) else "C" for e in events]
    assert "".join(kinds) == "UUCUUCUCC"


def test_markdown_edge_cases():
    def para(*spans):
        return {"type": "paragraph", "paragraph": {"rich_text": list(spans)}}

    def span(text, **annotations):
        return {"type": "text", "plain_text": text, "annotations": annotations, "href": None}

    blocks = [
        para(span("bold ", bold=True), span("tail")),
        {"type": "numbered_list_item", "numbered_list_item": {"rich_text": [span("one")]}},
        para(span("break")),
        {"type": "numbered_list_item", "numbered_list_item": {"rich_text": [span("again")]}},
        {"type": "equation", "equation": {"expression": "e=mc^2"}},
        {"type": "bookmark", "bookmark": {"url": "https://example.com", "caption": []}},
        {"type": "unsupported", "unsupported": {}},
        {
            "type": "column_list",
            "column_list": {},
            "children": [{"type": "column", "column": {}, "children": [para(span("in column"))]}],
        },
    ]
    assert notion.blocks_to_markdown(blocks) == (
        "**bold** tail\n\n1. one\n\nbreak\n\n1. again\n\n$$\ne=mc^2\n$$\n\n"
        "[https://example.com](https://example.com)\n\nin column"
    )


# --- Legacy config key and the page picker's search ------------------------------------

OTHER = "77777777-7777-4777-8777-777777777777"


async def test_legacy_pages_key_is_read_as_roots():
    # Sources made in the web UI before the picker stored their ids under "pages".
    fake = FakeNotion(full_routes())
    await fake.connector().validate({"pages": [ROOT]}, CREDENTIAL)
    events = await collect(fake.connector(), config={"pages": [ROOT]})
    assert set(upserts(events)) == {ROOT, CHILD, ROW1, ROW2, GRAND}
    # Both keys: one allowlist, no duplicates.
    assert notion._parse_config({"roots": [ROOT], "pages": [ROOT, DB]}) == [ROOT, DB]
    with pytest.raises(ConnectorConfigError, match="at least one root"):
        notion._parse_config({"pages": []})


def _search_routes(seen: list[dict]):
    def search(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen.append(body)
        if body.get("query") == "road":
            return httpx.Response(200, json=fixture("search_roadmap.json"))
        if body.get("start_cursor") == "cursor-search-2":
            return httpx.Response(200, json=fixture("search_2.json"))
        return httpx.Response(200, json=fixture("search_1.json"))

    # FakeNotion keys a paginated request by its start_cursor.
    return {"POST /search": search, "POST /search#cursor-search-2": search}


async def test_search_shared_lists_pages_and_databases_with_parents():
    seen: list[dict] = []
    fake = FakeNotion(_search_routes(seen))
    client = httpx.AsyncClient(transport=httpx.MockTransport(fake))
    first, cursor = await notion.search_shared(client, "ntn_example", "", None)
    assert cursor == "cursor-search-2"
    assert seen[0] == {
        "page_size": notion.PAGE_SIZE,
        "sort": {"direction": "descending", "timestamp": "last_edited_time"},
    }
    assert first[0] == {
        "id": ROOT,
        "type": "page",
        "title": "Product handbook",
        "icon": "📘",
        "parent_type": "workspace",
        "parent_id": None,
        "last_edited_at": datetime(2026, 9, 2, 10, tzinfo=UTC),
        "url": "https://www.notion.so/11111111111141118111111111111111",
    }
    assert [(i["id"], i["type"], i["parent_type"], i["parent_id"]) for i in first[1:]] == [
        (CHILD, "page", "page", ROOT),
        (DB, "database", "page", ROOT),
    ]
    assert first[2]["title"] == "Feature requests"
    assert first[2]["icon"] == "https://example.com/icon.png"

    second, cursor = await notion.search_shared(client, "ntn_example", "", "cursor-search-2")
    assert cursor is None
    assert seen[1]["start_cursor"] == "cursor-search-2"
    # Trashed items are left out; a page in a column has a block parent.
    assert [(i["id"], i["parent_type"]) for i in second] == [(ROW1, "database"), (OTHER, "block")]
    assert second[1]["icon"] == "https://files.example.com/i.png"

    found, _ = await notion.search_shared(client, "ntn_example", " road ", None)
    assert seen[2] == {"page_size": notion.PAGE_SIZE, "query": "road"}
    assert [i["title"] for i in found] == ["Roadmap"]


async def test_search_shared_errors():
    limited = FakeNotion(
        {
            "POST /search": lambda r: httpx.Response(
                429, json=fixture("error_rate_limited.json"), headers={"Retry-After": "12"}
            )
        }
    )
    client = httpx.AsyncClient(transport=httpx.MockTransport(limited))
    with pytest.raises(ConnectorRateLimited) as info:
        await notion.search_shared(client, "ntn_example", "", None)
    assert info.value.retry_after == 12

    rejected = FakeNotion(
        {"POST /search": lambda r: httpx.Response(401, json=fixture("error_unauthorized.json"))}
    )
    client = httpx.AsyncClient(transport=httpx.MockTransport(rejected))
    with pytest.raises(ConnectorAuthError):
        await notion.search_shared(client, "ntn_example", "", None)
