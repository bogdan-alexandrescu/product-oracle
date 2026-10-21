"""The citation contract in what agents read (owner, 2026-10-20): a writer cited Oracle's
own baseline with ``source: oracle`` and Oracle refused it, because no prompt said which
sources are allowed. The draft segments' task text, their step prompts and the
push_draft tool state the contract, with the source list generated from CitationSource;
the built-in PRD templates list ``oracle`` among the source kinds. A citation's
confidence is a number from 0 to 1: the contract says so, the import refuses any other in
plain words, and the bounds are the ones 0019_citation_confidence stores."""

from typing import get_args

import pytest
from sqlalchemy import CheckConstraint, select

from oracle.docs.models import Citation
from oracle.docs.parser import CitationIn, DraftError, parse_draft
from oracle.docs.schemas import (
    CONFIDENCE_MAX,
    CONFIDENCE_MIN,
    CitationOut,
    CitationSource,
    citation_contract,
)
from oracle.mcp.curated import CURATED
from oracle.runs import flows
from oracle.runs.rejection import summary
from oracle.templates import builtins
from oracle.templates.builtins import BUILTIN_TEMPLATES, ensure_builtins
from oracle.templates.models import Template, TemplateVersion
from oracle.tenancy import tenant_session
from tests.conftest import seed_company
from tests.test_priorities import _token

SOURCES = get_args(CitationSource)
DRAFT_SEGMENTS = [
    ("baseline_to_prd", "prd_draft", "prd"),
    ("feedback_loop", "next_draft", "prd"),
    ("feedback_loop", "next_draft", "roadmap"),
    ("prd_to_roadmap", "roadmap_draft", "roadmap"),
]


def _says_the_contract(text: str) -> None:
    assert "oracle" in SOURCES
    assert "source (one of: " + ", ".join(SOURCES) + ")" in text, text
    assert "YAML front matter" in text and "citations" in text
    for name in ("id", "ref", "title", "excerpt", "retrieved_at"):
        assert name in text
    assert '"baseline decision <key>"' in text
    assert "[c:id]" in text


@pytest.mark.parametrize(("flow", "segment", "kind"), DRAFT_SEGMENTS)
def test_draft_tasks_state_the_citation_contract(flow, segment, kind):
    sdef = flows.FLOWS[flow].segment(segment)
    _says_the_contract(sdef.task_for(kind))
    ctx = flows.PromptContext(run_id="r1", document="d", snapshot_as_of=None, low_confidence=0.4)
    ctx = flows.PromptContext(**{**ctx.__dict__, "kind": kind})
    for role in sdef.roles:
        prompt = flows.step_prompt(flows.FLOWS[flow], sdef, role, last=True, ctx=ctx)
        _says_the_contract(prompt)


def test_the_source_list_follows_citation_source(monkeypatch):
    """Generated, not copied: a source added to CitationSource reaches the prompts."""
    from typing import Literal

    from oracle.docs import schemas

    monkeypatch.setattr(schemas, "CitationSource", Literal[(*SOURCES, "linear")])
    text = schemas.citation_contract()
    assert "source (one of: " + ", ".join((*SOURCES, "linear")) + ")" in text


def test_push_draft_states_the_citation_contract():
    tool = next(c for c in CURATED if c.name == "push_draft")
    _says_the_contract(tool.description)


# Confidence (owner, 2026-10-20; stored by 0019_citation_confidence): a number from 0 to 1.
CONFIDENCE_PROBLEM = "confidence must be a number from 0 to 1"


def test_the_contract_says_confidence_is_a_number_from_0_to_1():
    text = citation_contract()
    assert "confidence (a number from 0 to 1" in text, text
    assert "confidence_note" in text and "low_confidence" in text and "item" in text
    assert "a confidence outside 0 to 1" in text


def test_the_bounds_are_the_ones_stored():
    """The contract, the import's validation, the API's output and the database's check
    (0019_citation_confidence) keep the same 0 to 1."""
    assert (CONFIDENCE_MIN, CONFIDENCE_MAX) == (0, 1)
    for model in (CitationIn, CitationOut):
        bounds = {type(m).__name__: m for m in model.model_fields["confidence"].metadata}
        assert (bounds["Ge"].ge, bounds["Le"].le) == (CONFIDENCE_MIN, CONFIDENCE_MAX)
    [check] = [
        c
        for c in Citation.__table__.constraints
        if isinstance(c, CheckConstraint) and "confidence" in str(c.sqltext)
    ]
    assert str(check.sqltext) == (
        f"confidence IS NULL OR (confidence >= {CONFIDENCE_MIN} AND confidence <= {CONFIDENCE_MAX})"
    )


def _confidence_draft(value: str) -> str:
    return "\n".join(
        [
            "---",
            "title: Confidence",
            "citations:",
            "  - id: c1",
            "    source: web",
            "    ref: https://example.com/a",
            f"    confidence: {value}",
            "---",
            "",
            "# Confidence {#title}",
            "",
            "Claim [c:c1].",
            "",
        ]
    )


@pytest.mark.parametrize(("value", "stored"), [("0", 0), ("1", 1), ("0.75", 0.75), ("null", None)])
def test_a_confidence_from_0_to_1_is_accepted(value, stored):
    [citation] = parse_draft(_confidence_draft(value)).citations
    assert citation.confidence == stored


@pytest.mark.parametrize("value", ["1.5", "-0.1", "75", "high"])
def test_a_confidence_outside_0_to_1_is_refused_in_plain_words(value):
    with pytest.raises(DraftError) as exc:
        parse_draft(_confidence_draft(value))
    invalid = [p for p in exc.value.problems if p.code == "invalid_citation"]
    assert [p.message for p in invalid] == [f"citation #1 (c1) is invalid: {CONFIDENCE_PROBLEM}"]
    assert summary("prd.md", exc.value.problems) == (
        f"Oracle refused prd.md: 1 citation is invalid ({CONFIDENCE_PROBLEM}); "
        "1 reference fails because of it."
    )


@pytest.mark.parametrize(
    "t", [t for t in BUILTIN_TEMPLATES if t.kind == "prd"], ids=lambda t: t.key
)
def test_builtin_prd_templates_list_oracle_as_a_source_kind(t):
    body = builtins.builtin_body(t)
    assert "kind (" + ", ".join(SOURCES) + ")" in body


async def test_an_unedited_builtin_gets_the_new_skeleton_as_its_next_version(client, tenant_id):
    """The repo's rule for a changed packaged skeleton: the next version of every built-in
    a company has not edited or archived."""
    h = await _token(tenant_id)
    await seed_company(tenant_id)
    old = "kind (slack, notion, gdocs, github, fireflies, upload, web)"
    async with tenant_session(tenant_id) as s:
        t = await s.scalar(select(Template).where(Template.key == "one-pager"))
        for v in await s.scalars(
            select(TemplateVersion).where(TemplateVersion.template_id == t.id)
        ):
            v.body = v.body.replace("kind (" + ", ".join(SOURCES) + ")", old)
            assert old in v.body
        await s.commit()
    async with tenant_session(tenant_id) as s:
        assert await ensure_builtins(s) is True
        await s.commit()
    body = (await client.get("/v1/templates/one-pager", headers=h)).json()
    assert body["latest_version"] == 2
    latest = max(body["versions"], key=lambda v: v["version"])
    assert "web, oracle)" in latest["body"]
