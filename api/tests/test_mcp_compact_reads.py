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
                origin="user",
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


def prompt_ctx() -> "flows.PromptContext":
    return flows.PromptContext(
        run_id=str(uuid.uuid4()),
        document="example-prd",
        snapshot_as_of=None,
        low_confidence=0.4,
        mcp_reachable=True,
    )


def test_writer_prompt_keeps_its_context_small():
    flow = flows.FLOWS["baseline_to_prd"]
    seg = flow.segment("prd_draft")
    ctx = prompt_ctx()
    prompt = flows.step_prompt(flow, seg, "writer", last=False, ctx=ctx)
    assert "list_entities" in seg.tools
    # The whole baseline is not offered to the writer.
    assert "get_baseline" not in seg.tools
    assert "only this PRD's" in prompt
    assert "ids=" in prompt and "entity_id" in prompt
    assert "section=work" in prompt
    assert "grep" in prompt
    assert "section by section" in prompt
    # The other long roles get the same rule.
    for role in ("analyst", "researcher", "critic"):
        assert "grep" in flows.step_prompt(flow, seg, role, last=False, ctx=ctx)
    assert "section=work" in flows.UNKNOWN_IS_WORK_DRAFT


def test_other_flows_are_not_told_to_write_a_prd():
    for key in ("prd_to_roadmap", "feedback_loop", "strategy_draft"):
        flow = flows.FLOWS[key]
        for seg in flow.segments:
            for role in seg.roles:
                prompt = flows.step_prompt(flow, seg, role, last=False, ctx=prompt_ctx())
                assert flows.CONTEXT_ROOM not in prompt, (key, seg.name, role)
                if "roadmap" in key:
                    assert "prd.md" not in prompt, (key, seg.name, role)


def summary_with_work(n_work: int, pad: int) -> dict:
    """An intake summary with ``n_work`` work items, ``pad`` filler claims (~1.2 KB each)."""
    return {
        "id": str(uuid.uuid4()),
        "title": "Example intake",
        "work": [
            {"requirement": f"Find out example unknown {i}", "cite_ref": f"a{i}"}
            for i in range(n_work)
        ],
        "features": [{"key": f"feature-{i:03d}", "title": f"Example {i}"} for i in range(8)],
        "goals": [{"key": f"goal-{i}", "title": f"Example goal {i}"} for i in range(5)],
        "items": [{"id": i, "text": "z" * 1200} for i in range(pad)],
    }


def test_a_small_or_medium_intake_summary_comes_back_whole():
    for pad in (0, 25):
        data = summary_with_work(6, pad)
        assert compact.summary_view(data, None, 0, None) == data


def test_a_large_intake_summary_outline_keeps_work_features_and_goals_whole():
    data = summary_with_work(12, 60)
    assert len(json.dumps(data)) > compact.SUMMARY_WHOLE
    outline = compact.summary_view(data, None, 0, None)
    assert outline["work"] == data["work"]
    assert outline["features"] == data["features"]
    assert outline["goals"] == data["goals"]
    assert len(outline["items"]) == compact.OUTLINE_ITEMS
    assert "section=work" in outline["how_to_read"] or "whole" in outline["how_to_read"]


async def test_list_entities_ids_take_keys_too(tenant_id):
    await seed_entities(tenant_id)
    token = await api_token(tenant_id, "owner")
    async with mcp_client(token) as c:
        got = await c.call_tool("list_entities", {"ids": ["feature-001", "feature-002"]})
    assert not got.is_error, text_of(got)
    assert sorted(e["key"] for e in got.structured_content["entities"]) == [
        "feature-001",
        "feature-002",
    ]


async def test_a_realistic_writer_session_stays_under_budget(tenant_id):
    """60 features in a baseline of 200 entities: the scope read, this PRD's entities, a
    previous PRD read in pages, the intake summary (whole) and its work section, a search:
    under 150,000 bytes."""
    async with tenant_session(tenant_id) as s:
        ids: list[str] = []
        for i in range(200):
            kind = "feature" if i < 60 else ("requirement" if i < 160 else "constraint")
            e = Entity(
                type=kind,
                key=f"{kind}-{i:03d}",
                title=f"Example {kind} {i}",
                body=BODY,
                attrs={"note": "x" * 200},
                status="confirmed",
                origin="user",
            )
            s.add(e)
            await s.flush()
            ids.append(str(e.id))
        await s.commit()
    scope = {
        "id": str(uuid.uuid4()),
        "status": "approved",
        "features": [
            {
                "id": str(uuid.uuid4()),
                "key": f"feature-{i:03d}",
                "title": f"Example feature {i}",
                "decision": "include",
                "origin": "agent",
                "goals": [{"key": "goal-1", "title": "Example goal"}],
                "depends_on": [],
                "entity_id": ids[i] if i % 10 else None,
                "proposal_id": None if i % 10 else str(uuid.uuid4()),
                "requirements": [
                    {
                        "id": str(uuid.uuid4()),
                        "key": f"requirement-{60 + i}",
                        "title": f"Example requirement {i}",
                        "text": "Shoppers see an example total before they pay.",
                        "decision": "keep",
                        "origin": "agent",
                        "entity_id": ids[60 + i],
                    }
                ],
            }
            for i in range(60)
        ],
    }
    wanted = [f["entity_id"] for f in scope["features"] if f["entity_id"]] + [
        r["entity_id"] for f in scope["features"] for r in f["requirements"]
    ]
    token = await api_token(tenant_id, "owner")
    async with mcp_client(token) as c:
        mine = await c.call_tool("list_entities", {"ids": wanted, "limit": 200})
    assert mine.structured_content["total"] == len(wanted)
    previous = "".join(f"Line {i} of an example earlier PRD.\n" for i in range(6_000))
    pages = [compact.text_page(previous, 0, None)]
    pages.append(compact.text_page(previous, compact.TEXT_PAGE, None))
    summary = summary_with_work(10, 38)  # ~48 KB: comes back whole
    assert len(json.dumps(summary)) > 45_000
    sizes = {
        "get_prd_scope": len(json.dumps(scope)),
        "list_entities": size(mine),
        "get_run_output": sum(len(p) for p in pages),
        "get_intake_summary": len(json.dumps(compact.summary_view(summary, None, 0, None))),
        "get_intake_summary(work)": len(json.dumps(compact.summary_view(summary, "work", 0, 100))),
        "search": len(
            json.dumps(
                compact.search_view(
                    {"hits": [{"item": {"id": "1", "body": "b" * 8000}, "snippet": "s"}] * 10},
                    full=False,
                )
            )
        ),
    }
    assert sum(sizes.values()) < 150_000, sizes
