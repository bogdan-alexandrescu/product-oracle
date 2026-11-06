"""The heavy MCP reads have a compact form, so a PRD writer stays well under its
session's context ceiling (SwarmCloud: 200,000 tokens). A writer that read every
entity, a whole intake summary and whole files ran out of room and failed."""

import json
import uuid

from oracle.baseline.models import Entity
from oracle.mcp import compact
from oracle.runs import flows
from oracle.tenancy import tenant_session
from tests.test_mcp import api_token, mcp_client, text_of

BODY = "Lorem ipsum dolor sit amet, invented example text. " * 60  # ~3 KB each
BUDGET = 120_000


async def seed_entities(tenant_id: uuid.UUID) -> list[str]:
    """200 entities, 50 of them features, each with a ~3 KB body; the feature ids."""
    features: list[str] = []
    async with tenant_session(tenant_id) as s:
        for i in range(200):
            kind = "feature" if i < 50 else ("requirement" if i < 150 else "constraint")
            e = Entity(
                type=kind,
                key=f"{kind}-{i:03d}",
                title=f"Example {kind} {i}",
                body=BODY,
                attrs={"note": "x" * 200},
                status="confirmed",
                origin="human",
            )
            s.add(e)
            await s.flush()
            if kind == "feature":
                features.append(str(e.id))
        await s.commit()
    return features


def size(result) -> int:
    return len(text_of(result).encode())


async def test_list_entities_is_compact_filtered_and_paged(tenant_id):
    ids = await seed_entities(tenant_id)
    token = await api_token(tenant_id, "owner")
    async with mcp_client(token) as c:
        # This PRD's features only, by id: no bodies unless asked.
        mine = await c.call_tool("list_entities", {"ids": ids})
        assert not mine.is_error, text_of(mine)
        data = mine.structured_content
        assert data["total"] == 50 and len(data["entities"]) == 50
        assert all("body" not in e for e in data["entities"])
        assert {"id", "type", "key", "title"} <= set(data["entities"][0])
        # Unfiltered, a page at a time.
        page = await c.call_tool("list_entities", {})
        assert page.structured_content["total"] == 200
        assert len(page.structured_content["entities"]) == compact.ENTITY_LIMIT
        assert page.structured_content["next_offset"] == compact.ENTITY_LIMIT
        last = await c.call_tool("list_entities", {"offset": 190, "limit": 50})
        assert len(last.structured_content["entities"]) == 10
        assert last.structured_content["next_offset"] is None
        # By kind, with chosen fields and the body when asked.
        some = await c.call_tool(
            "list_entities",
            {"type": "requirement", "fields": ["key", "body"], "limit": 2},
        )
        got = some.structured_content
        assert got["total"] == 100
        assert set(got["entities"][0]) == {"id", "key", "body"}
        assert got["entities"][0]["body"] == BODY
        # The full REST answer stays reachable under its own name.
        assert "list_entities_op" in {t.name for t in (await c.list_tools()).tools}
        total = size(mine) + size(page)
    assert total < 40_000, total


def big_summary() -> dict:
    """An intake summary as large as the one that filled a writer's context (~118 KB)."""
    return {
        "id": str(uuid.uuid4()),
        "title": "Example intake",
        "coverage": {"score": 0.7, "note": "y" * 300},
        "items": [{"id": i, "text": "z" * 1200, "kind": "claim"} for i in range(60)],
        "conflicts": [{"id": i, "a": "q" * 800, "b": "w" * 800} for i in range(20)],
        "assumptions": [f"assumption {i} " + "e" * 300 for i in range(40)],
    }


def test_intake_summary_reads_as_an_outline_then_by_section():
    data = big_summary()
    assert len(json.dumps(data)) > 100_000
    outline = compact.summary_view(data, None, 0, None)
    assert len(json.dumps(outline)) < 12_000
    assert outline["sections"]["items"] == 60
    assert outline["title"] == "Example intake"
    page = compact.summary_view(data, "items", 20, 10)
    assert [i["id"] for i in page["items"]] == list(range(20, 30))
    assert page["total"] == 60 and page["next_offset"] == 30
    assert len(json.dumps(page)) < 16_000


def test_long_text_reads_in_pages():
    text = "".join(f"line {i}\n" for i in range(20_000))  # ~200 KB
    first = compact.text_page(text, 0, None)
    assert len(first) < compact.TEXT_PAGE + 300
    assert "offset=" in first and text[:1000] in first
    tail = compact.text_page(text, len(text) - 50, None)
    assert tail.endswith(text[-50:]) and "offset=" not in tail.split("\n", 1)[0]


def test_search_hits_drop_item_bodies():
    hits = {
        "query": "checkout",
        "hits": [
            {
                "item": {"id": str(i), "kind": "doc", "title": f"Doc {i}", "body": "b" * 4000},
                "snippet": "a snippet",
                "relevance": 0.5,
                "score": 0.4,
                "confidence": 0.8,
            }
            for i in range(20)
        ],
    }
    out = compact.search_view(hits, full=False)
    assert all("body" not in h["item"] for h in out["hits"])
    assert out["hits"][0]["snippet"] == "a snippet"
    assert len(json.dumps(out)) < 8_000


async def test_the_writers_reads_stay_under_budget(tenant_id):
    """The calls the PRD writer's prompt names, for a PRD with 50 features in a baseline
    of 200 entities: this PRD's features, an intake summary outline and one section page,
    a page of an earlier file and a search: well under the session's room."""
    ids = await seed_entities(tenant_id)
    token = await api_token(tenant_id, "owner")
    async with mcp_client(token) as c:
        mine = await c.call_tool("list_entities", {"ids": ids})
    sizes = {
        "list_entities": size(mine),
        "get_intake_summary": len(json.dumps(compact.summary_view(big_summary(), None, 0, None))),
        "get_intake_summary(items)": len(
            json.dumps(compact.summary_view(big_summary(), "items", 0, None))
        ),
        "get_run_output": len(compact.text_page("v" * 300_000, 0, None)),
        "search": len(
            json.dumps(
                compact.search_view(
                    {"hits": [{"item": {"id": "1", "body": "b" * 8000}, "snippet": "s"}] * 10},
                    full=False,
                )
            )
        ),
    }
    assert sum(sizes.values()) < BUDGET, sizes


def test_writer_prompt_keeps_its_context_small():
    flow = flows.FLOWS["baseline_to_prd"]
    seg = flow.segment("prd_draft")
    ctx = flows.PromptContext(
        run_id=str(uuid.uuid4()),
        document="example-prd",
        snapshot_as_of=None,
        low_confidence=0.4,
        mcp_reachable=True,
    )
    prompt = flows.step_prompt(flow, seg, "writer", last=False, ctx=ctx)
    assert "list_entities" in seg.tools
    assert "only this PRD's" in prompt
    assert "ids=" in prompt
    assert "grep" in prompt
    assert "section by section" in prompt
    # The other long roles get the same rule.
    for role in ("analyst", "researcher", "critic"):
        assert "grep" in flows.step_prompt(flow, seg, role, last=False, ctx=ctx)
