"""#621 review: a hidden title is matched whatever characters it holds.

``Hidden.names`` (oracle.docs.visibility) looks for the titles of what a commenter may not
see in text Oracle shows to every member. The discussion agent view and request triage
checked ``json.dumps(...)`` of their rows, which escapes non-ASCII characters (an em dash,
curly quotes, an accented letter) and a double quote, so a title holding one was never
found and its discussion reached a member-view run's prompt. These tests name hidden
documents with such titles and check every way the text can carry them: the field
itself, JSON (ASCII-escaped or not), HTML entities, another Unicode normalisation, other
case and other whitespace.
"""

import html
import json
import unicodedata
import uuid

import pytest

from oracle.discussions import agent_view
from oracle.docs import visibility
from oracle.docs.models import Document
from oracle.requests.models import RequestTheme
from oracle.runs.models import Run
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx

TITLES = {
    "em dash": "Annual plan — the 2027 price list",
    "curly quotes": "The “Team” plan’s new seat price",
    "accent": "Café tier pricing for résumé builders",
    "double quote": 'The "Team" plan seat price rework',
}


@pytest.fixture
async def ctx():
    return await make_ctx()


async def _hidden_doc(ctx, title: str) -> None:
    async with tenant_session(ctx.tenant_id) as s:
        s.add(Document(slug=f"memo-{uuid.uuid4().hex[:6]}", title=title, kind="pricing",
                       visibility="approvers"))  # fmt: skip
        await s.commit()


@pytest.mark.parametrize("kind", TITLES)
async def test_a_discussion_titled_with_a_hidden_title_is_not_in_a_member_runs_view(ctx, kind):
    """protects=MINOR 1: a discussion whose title or summary is a hidden document's title
    holding an em dash, curly quotes, an accent or a double quote is left out of the
    agents' view of a run that reads as a member; fails_when=it is kept (json.dumps
    escaped the title); no_claim=a run with its starter's view (keeps it)."""
    title = TITLES[kind]
    await _hidden_doc(ctx, title)
    async with tenant_session(ctx.tenant_id) as s:
        doc = Document(slug=f"target-{uuid.uuid4().hex[:6]}", title="The target", kind="prd",
                       visibility="company")  # fmt: skip
        s.add(doc)
        await s.flush()
        run = Run(flow="baseline_to_prd", document_id=doc.id, created_by=ctx.users["owner"].id)
        s.add(run)
        await s.flush()
        entries = [
            {"title": title, "summary": None, "staged": []},
            {"title": "Onboarding", "summary": f"Follows {title}.", "staged": []},
            {"title": "Onboarding", "summary": None, "staged": [{"label": title}]},
            {"title": "Clean discussion", "summary": "Nothing hidden.", "staged": []},
        ]
        kept = await agent_view.for_member_run(s, run, entries)
        await s.rollback()
    assert [e["title"] for e in kept] == ["Clean discussion"], kept


@pytest.mark.parametrize("kind", TITLES)
async def test_a_theme_problem_suggestion_naming_a_hidden_title_is_withheld(client, ctx, kind):
    """protects=MINOR 1 (request triage, the same json.dumps check): a theme's suggested
    problem naming a hidden title with such characters is not shown to a commenter, and
    is to an owner; fails_when=the commenter reads it."""
    title = TITLES[kind]
    await _hidden_doc(ctx, title)
    async with tenant_session(ctx.tenant_id) as s:
        s.add(RequestTheme(title="Team pricing", origin="oracle", problem_state="suggested",
                           problem_suggestion={"problem": f"Undo {title} for teams"}))  # fmt: skip
        await s.commit()
    for who, sees in (("owner", True), ("commenter", False)):
        got = await client.get("/v1/request-themes", headers=ctx.as_(who))
        assert got.status_code == 200, got.text
        (theme,) = got.json()
        assert (theme["problem_suggestion"] is not None) is sees, (who, theme)


def _forms(title: str) -> dict[str, str]:
    """The ways a text can carry ``title``."""
    return {
        "as is": title,
        "json ascii": json.dumps({"t": title}),
        "json": json.dumps({"t": title}, ensure_ascii=False),
        "html": html.escape(title),
        "html entities": "".join(c if c.isascii() else f"&#{ord(c)};" for c in title),
        "nfd": unicodedata.normalize("NFD", title),
        "upper": title.upper(),
        "whitespace": title.replace(" ", "\n  ", 2),
        "straight quotes and hyphen": title.translate(
            str.maketrans({"“": '"', "”": '"', "’": "'", "—": "-"})
        ),
    }


@pytest.mark.parametrize("kind", TITLES)
async def test_hidden_names_finds_a_title_in_every_form(ctx, kind):
    """protects=MINOR 1 (every Hidden.names caller: kit, launch, docs, runs' raw files,
    market, metrics, rituals): a hidden title is found as is, inside JSON whether or not
    it escapes non-ASCII, HTML-escaped, in another Unicode normalisation, in other case,
    with other whitespace and with straight quotes or a hyphen for typographic ones;
    fails_when=one form is missed; no_claim=paraphrase."""
    await _hidden_doc(ctx, TITLES[kind])
    async with tenant_session(ctx.tenant_id) as s:
        hidden = await visibility.hidden_for_reader(s, as_member=True)
    assert hidden is not None
    missed = [f for f, text in _forms(TITLES[kind]).items() if not hidden.names(f"See {text}.")]
    assert not missed, missed
    assert not hidden.names("See the onboarding plan.")


async def test_hidden_names_in_finds_a_title_in_any_field(ctx):
    """protects=MINOR 1: ``Hidden.names_in`` checks every string of a row (keys, values,
    nested lists and dicts) as itself, not as escaped JSON; fails_when=a nested field
    holding the title is missed."""
    title = TITLES["double quote"]
    await _hidden_doc(ctx, title)
    async with tenant_session(ctx.tenant_id) as s:
        hidden = await visibility.hidden_for_reader(s, as_member=True)
    assert hidden is not None
    assert hidden.names_in({"staged": [{"change": {"label": title}}]})
    assert hidden.names_in([1, None, {"x": title}])
    assert not hidden.names_in({"staged": [{"label": "Clean"}], "n": 3})
