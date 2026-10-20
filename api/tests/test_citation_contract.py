"""The citation contract in what agents read (owner, 2026-10-20): a writer cited Oracle's
own baseline with ``source: oracle`` and Oracle refused it, because no prompt said which
sources are allowed. The draft segments' task text, their step prompts and the
push_draft tool state the contract, with the source list generated from CitationSource;
the built-in PRD templates list ``oracle`` among the source kinds."""

from typing import get_args

import pytest
from sqlalchemy import select

from oracle.docs.schemas import CitationSource
from oracle.mcp.curated import CURATED
from oracle.runs import flows
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
