"""The ``constraints.solutions`` module's rendering: the blocker strategy as a brief
section and a full-layer section in the draft format, with evidence only in the Sources
and data points appendix (O1c), never inline."""

import yaml

from oracle.docs import layers
from oracle.docs.parser import CITATION_RE, parse_draft
from tests.baseline_helpers import make_ctx
from tests.blocker_helpers import (
    add_option,
    approve_compliance,
    create_blocker,
    make_document,
    make_evidence,
)

EVIDENCE_URL = "https://docs.example.com/partner-api/limits"


async def _render(client, ctx, slug="checkout-redesign") -> dict:
    resp = await client.get(f"/v1/documents/{slug}/blocker-strategy/render",
                            headers=ctx.as_("viewer"))  # fmt: skip
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _full_strategy(client, ctx) -> dict:
    doc_id = await make_document(ctx)
    b = (await create_blocker(client, ctx, document_ids=[str(doc_id)],
                              scaling={"tenants": "Each company has its own quota",
                                       "blast_radius": "One company at a time"}))["blocker"]  # fmt: skip
    ev = await make_evidence(ctx, b["id"])
    h = ctx.as_("approver")
    chosen = await approve_compliance(client, ctx, (await add_option(
        client, ctx, b["id"], evidence_ids=[str(ev)])).json())  # fmt: skip
    await add_option(client, ctx, b["id"], title="Rotate proxies to bypass the rate limit")
    await client.post(
        f"/v1/blocker-options/{chosen['id']}/select",
        json={"lock_version": chosen["lock_version"], "reason": "Cheapest path within the quota"},
        headers=h,
    )  # fmt: skip
    await client.post(
        f"/v1/blockers/{b['id']}/experiments",
        json={"hypothesis": "Batching halves calls", "method": "Replay a synthetic day",
              "success_threshold": "Under 50 requests a minute at peak",
              "decision_gate_at": "2027-01-10T00:00:00Z", "option_id": chosen["id"]},
        headers=h,
    )  # fmt: skip
    return {"blocker": b, "evidence_id": ev}


async def test_the_brief_section_summarizes_the_strategy(client):
    ctx = await make_ctx()
    await _full_strategy(client, ctx)
    out = await _render(client, ctx)
    assert out["module_key"] == "constraints.solutions"
    assert out["brief_section_id"] == "constraints-solutions"
    assert out["full_section_id"] == "constraints-solutions-detail"
    brief = out["brief_markdown"]
    assert brief.startswith("## Blockers and solution strategy {#constraints-solutions}")
    assert "Partner API" in brief or "partner API" in brief
    assert "Batch and cache lookups within the published quota" in brief
    assert "](#blocker-partner-api-rate-limit)" in brief


async def test_the_full_section_carries_everything_section_6_lists(client):
    ctx = await make_ctx()
    await _full_strategy(client, ctx)
    full = (await _render(client, ctx))["full_markdown"]
    assert full.startswith(
        "## Constraints, blockers and solution strategy {#constraints-solutions-detail}"
    )
    assert "### The partner API allows 100 requests a minute per company " \
           "{#blocker-partner-api-rate-limit}" in full  # fmt: skip
    for text in (
        "Hard", "Rate or capacity limit", "Example partner API", "Critical",
        "At launch, when every company syncs at once",
        "More than 100 requests a minute per company",
        # option comparison
        "Architecture", "Peak calls fall below 60 a minute", "Two engineer-weeks",
        "Cached data can be up to ten minutes old", "A single very large company may still queue",
        # selected option and reason
        "Cheapest path within the quota",
        # experiment
        "Batching halves calls", "Under 50 requests a minute at peak", "2027-01-10",
        # fallback, monitoring, scaling, corrective action, review date
        "Queue lookups and retry within the permitted rate", "Share of minutes above 80 requests",
        "Above 80 requests a minute for a week", "Apply for the provider's higher tier",
        "2027-01-15",
        # scaling characteristics
        "Each company has its own quota", "One company at a time",
    ):
        assert text in full, text
    # A ruled-out option is counted, never spelled out as a path in the PRD.
    assert "Rotate proxies" not in full
    assert "1 option ruled out" in full


async def test_evidence_lives_in_the_appendix_never_inline(client):
    ctx = await make_ctx()
    await _full_strategy(client, ctx)
    out = await _render(client, ctx)
    for body in (out["brief_markdown"], out["full_markdown"]):
        assert not CITATION_RE.search(body)
        assert EVIDENCE_URL not in body
        assert "HTTP 429" not in body
    [citation] = out["citations"]
    assert citation["source"] == "web"
    assert citation["ref"] == EVIDENCE_URL
    assert citation["excerpt"] == "Requests above 100 a minute receive HTTP 429."
    assert out["evidence_by_section"] == {
        "constraints-solutions": [citation["id"]],
        "constraints-solutions-detail": [citation["id"]],
        "blocker-partner-api-rate-limit": [citation["id"]],
    }
    assert f"blocker-partner-api-rate-limit: {citation['id']}" in out["appendix_markdown"]
    assert any("More than 100 requests a minute" in d for d in out["data_points"])


async def test_the_rendering_imports_as_a_draft_with_brief_and_full_layers(client):
    ctx = await make_ctx()
    await _full_strategy(client, ctx)
    out = await _render(client, ctx)
    front = {
        "document": "checkout-redesign", "title": "Checkout redesign PRD",
        "brief": [out["brief_section_id"]], "citations": out["citations"],
    }  # fmt: skip
    draft = (
        f"---\n{yaml.safe_dump(front, sort_keys=False)}---\n\n"
        "# Checkout redesign PRD {#title}\n\n"
        f"{out['brief_markdown']}\n\n"
        "# Full version {#full}\n\n"
        f"{out['full_markdown']}\n\n"
        "## Sources and data points {#sources}\n\n"
        f"{out['appendix_markdown']}\n"
    )
    parsed = parse_draft(draft)
    keys = [s.section_key for s in parsed.sections]
    assert "constraints-solutions" in keys
    assert "blocker-partner-api-rate-limit" in keys
    brief, source = layers.resolve_brief(
        [layers.SectionRef(s.section_key, s.level) for s in parsed.sections],
        draft_brief=layers.marked_brief(parsed.front_matter), template_brief=None,
    )  # fmt: skip
    assert (brief, source) == (["constraints-solutions"], "draft")
    # No section body cites anything: the evidence is in the appendix only.
    assert all(not s.citation_keys for s in parsed.sections)


async def test_user_text_cannot_inject_citations_or_section_ids(client):
    ctx = await make_ctx()
    doc_id = await make_document(ctx)
    await create_blocker(
        client, ctx, document_ids=[str(doc_id)],
        statement="Limit [c:evil] here {#title}\n## Injected {#injected}",
        threshold="a | b",
    )  # fmt: skip
    out = await _render(client, ctx)
    for body in (out["brief_markdown"], out["full_markdown"]):
        assert "[c:evil]" not in body
        assert "{#title}" not in body
        assert "{#injected}" not in body
    draft = f"# T {{#t}}\n\n{out['brief_markdown']}\n\n{out['full_markdown']}\n"
    keys = [s.section_key for s in parse_draft(draft).sections]
    assert keys == ["t", "constraints-solutions", "constraints-solutions-detail",
                    "blocker-partner-api-rate-limit"]  # fmt: skip


async def test_no_blockers_says_so(client):
    ctx = await make_ctx()
    await make_document(ctx)
    out = await _render(client, ctx)
    assert "No known blockers" in out["brief_markdown"]
    assert out["citations"] == []
