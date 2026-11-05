"""Visual QA pass B (PRDs and documents): Present mode for a version with no brief opens on
the full document's sections (B-04); a roadmap draft's as-of line is month first (B-05)."""

from oracle.runs import flows
from tests.test_brief import DETAIL_ONLY, _import
from tests.test_priorities import _token


async def test_present_mode_without_a_brief_shows_the_full_document(client, tenant_id):
    # protects=B-04 Present mode of a version with no brief sections; fails_when=the deck
    # route answers 422 "has no brief sections" instead of slides of the full document.
    h = await _token(tenant_id, "approver")
    assert (await _import(client, h, DETAIL_ONLY, "notes")).status_code == 201
    resp = await client.get("/v1/documents/notes/versions/1/deck", headers=h)
    assert resp.status_code == 200, resp.text
    slides = resp.json()["slides"]
    assert slides[0]["kind"] == "title"
    assert [s["heading"] for s in slides if s["kind"] == "section"] == ["Background"]
    # The exports keep their own rule: no brief, no brief export.
    resp = await client.get(
        "/v1/documents/notes/versions/1/export?layer=brief&format=html", headers=h
    )
    assert resp.status_code == 422


TITLED = """---
title: Notes
---

# Notes {#title}
A short note on saved carts for example.com shoppers.

## Background {#background}
Text.

## Sources and data points {#sources}

### Interviews {#interviews}
Five invented shoppers.
"""


async def test_present_mode_without_a_brief_never_repeats_the_title(client, tenant_id):
    # protects=B-04 fix 1: a non-empty title section folds into the next slide;
    # fails_when=slide 2 is headed "Notes" again right after the title slide.
    h = await _token(tenant_id, "approver")
    assert (await _import(client, h, TITLED, "notes")).status_code == 201
    resp = await client.get("/v1/documents/notes/versions/1/deck", headers=h)
    assert resp.status_code == 200, resp.text
    slides = resp.json()["slides"]
    assert [s["heading"] for s in slides] == ["Notes", "Background"]
    assert slides[1]["kind"] == "section" and slides[1]["section_key"] == "background"
    assert "A short note on saved carts" in slides[1]["html"]
    assert slides[1]["html"].index("A short note") < slides[1]["html"].index("Text.")


def _roadmap_prompt(company_plan: dict) -> str:
    flow = flows.FLOWS["prd_to_roadmap"]
    knobs = flows.resolve_knobs(flow, {})
    draft = flows.DraftContext(
        kind="roadmap",
        slug="example-roadmap",
        template="now-next-later",
        template_version=2,
        theme=None,
        skeleton="---\nkind: roadmap\n---\n# Roadmap {#roadmap}\n",
    )
    src = flows.SourceContext(
        slug="example-prd",
        title="Example PRD",
        version=1,
        markdown="# Example\n\n## Scope {#scope}\nText.\n",
        sections=[("scope", "Scope")],
        company_plan=company_plan,
    )
    ctx = flows.PromptContext(
        run_id="r1",
        document="example-roadmap",
        snapshot_as_of=None,
        low_confidence=0.4,
        kind="roadmap",
        source=src,
        draft=draft,
    )
    return flows.build_steps(flow, flow.segment("roadmap_draft"), knobs, ctx)[0][2]


def test_roadmap_draft_prompt_gives_the_as_of_day_month_first():
    # protects=B-05 the roadmap's as-of line reads "As of Oct 2, 2026"; fails_when=the
    # prompt gives no as-of day, or only the ISO day the writer copies.
    prompt = _roadmap_prompt({"per_week": 2, "today": "2026-10-02", "features": {}, "sections": {}})
    assert '"As of Oct 2, 2026"' in prompt
    assert "As of 2026-10-02" not in prompt
