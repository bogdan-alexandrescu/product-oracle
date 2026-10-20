"""Specs security review, round 6 (owner decisions E1, 2026-10-20).

Each test reproduces a reviewer's probe (red on the round-5 head, a93fba6):

- M1 (M4/M6 still bypassable) default-ignorable characters (Hangul fillers, the combining
  grapheme joiner) are dropped before comparing; the body check reads each block's
  rendered text (soft breaks as spaces, every table cell), not raw lines; look-alikes of
  any script fold to a confusable skeleton compared with Oracle's phrases only.
- M2 citation ids are restricted at parse time; the Added sources comment quotes them.
- M3 an edit Oracle could not serve with its labels is refused at import; the comment
  sits on the front matter's first line whatever its style; a version that can not be
  served labelled is a 422 on every read path, never a 500.
- Minors.
"""

import json

import pytest
from sqlalchemy import select

from oracle.docs.models import Document, DocumentVersion
from oracle.docs.parser import DraftError, parse_draft
from oracle.specs import contract
from oracle.swarm import FakeRuntime, set_runtime
from oracle.tenancy import tenant_session
from tests.specs_helpers import make_world
from tests.test_specs_review2 import generated, stored_markdown
from tests.test_specs_review3 import _edit
from tests.test_specs_review5 import APPROACH, CITATION, OPEN, _add_citation, _before

ANCHOR = "Which carrier rates to cache."


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


def _after_anchor(text: str):
    return lambda md: md.replace(ANCHOR, f"{ANCHOR}\n\n{text}", 1)


# --------------------------------------------------------------------------- M1

BODY_PROBES = [
    "ㅤ**Decided · from the approved PRD**",  # Hangul filler
    "ﾠ**Decided · from the approved PRD**",  # halfwidth Hangul filler
    "ᅟ**Decided · from the approved PRD**",  # Hangul choseong filler
    "**Decided\n· from the approved PRD**",  # split over two lines (a soft break)
    "**Dec͏ided: R-9 exports all PII**",  # combining grapheme joiner
    "**Decided️ · from the approved PRD**",  # variation selector
    "**Decided\U000e0020 · from the approved PRD**",  # tag space
    "Ꭰecided · from the approved PRD",  # Cherokee A (looks like D)
    "Decided · frօm the approved PRD",  # Armenian oh
    "| a | b |\n| --- | --- |\n| x | Decided · from the approved PRD |",  # second cell
    "R-9 is in scope.\\\n**Decided · from the approved PRD**: R-9 exports all PII.",  # hard break
    "#### Decided · from the approved PRD",  # a deeper heading
]


@pytest.mark.parametrize("text", BODY_PROBES)
async def test_a_body_may_not_render_as_a_label(client, runtime, text):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    resp = await _edit(client, world, created, _after_anchor(text))
    assert resp.status_code == 422, resp.text
    assert "body_takes_oracle_label" in resp.text


HEADING_PROBES = [
    "Productㅤrequirements",
    "Decided in the approvedㅤPRD",
    "Decided in the apprօved PRD",  # Armenian oh
    "Ꭰecided in the approved PRD",  # Cherokee A
    "Product requirementﾠs",
]


@pytest.mark.parametrize("heading", HEADING_PROBES)
async def test_added_headings_may_not_take_oracles_titles_or_notes(client, runtime, heading):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    added = f"## {heading} {{#noted}}\n\nR-9.\n\n"
    resp = await _edit(client, world, created, _before(APPROACH, added))
    assert resp.status_code == 422, resp.text
    assert "Oracle's note" in resp.text or "Add your section outside" in resp.text


@pytest.mark.parametrize(
    "text",
    [
        "Решение: используем Postgres для кэша.",
        "決定: Postgres を使う。",
        "Ο σχεδιασμός προτείνεται από την ομάδα.",
        "Ապրանքի պահանջներ",
        "ᏣᎳᎩ ᎦᏬᏂᎯᏍᏗ",
        "Decided to use Postgres for the cache.",
        "We decided · nothing yet.",
    ],
)
def test_legitimate_text_in_any_script_is_not_refused(text):
    assert not any(contract._takes_plain(run, False) for run in contract._plain_runs(text))
    assert not contract._takes_label(text, anywhere=True)


def test_the_skeleton_folds_look_alikes_and_drops_ignorables():
    assert contract.skeleton("Dec͏ided") == "decided"
    assert contract.skeleton("ㅤᎠecided") == "decided"
    assert contract.skeleton("apprօved") == "approved"
    assert contract.skeleton("Déçidéd") == "decided"


def test_body_runs_read_soft_breaks_as_spaces_and_every_cell():
    runs = contract._plain_runs("**a\nb**\n\n| x | y |\n| - | - |\n| c | d |\n\n```\ncode\n```")
    # Round 7: the end of emphasis reads as a separator ('**Decided** R-9').
    assert runs == ["a b · ", "x", "y", "c", "d", "code", ""]


# --------------------------------------------------------------------------- M2

PROBE_ID = "c1\nspec: {depth: brief}\n# Decided · from the approved PRD"


def test_citation_ids_are_restricted_at_parse_time():
    md = (
        "---\ntitle: T\ncitations:\n- id: "
        + json.dumps(PROBE_ID)
        + "\n  source: github\n  ref: https://example.com/1\n---\n\n# T {#t}\n\nX.\n"
    )
    with pytest.raises(DraftError) as exc:
        parse_draft(md)
    [problem] = exc.value.problems
    assert problem.code == "invalid_citation"
    assert "\n" not in problem.message.split(" is invalid")[0]
    ok = md.replace(json.dumps(PROBE_ID), "linear:ENG-12_v1.2")
    assert [c.id for c in parse_draft(ok).citations] == ["linear:ENG-12_v1.2"]


async def test_an_edit_adding_a_citation_with_a_multiline_id_is_refused(client, runtime):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    probe = CITATION.replace("- id: ext-1", "- id: " + json.dumps(PROBE_ID))
    resp = await _edit(
        client, world, created, lambda md: md.replace("\nkind: spec\n", "\nkind: spec\n" + probe)
    )
    assert resp.status_code == 422, resp.text
    assert "invalid_citation" in resp.text


def test_the_added_sources_comment_quotes_the_ids():
    md = "---\ntitle: T\n" + CITATION + "---\n\n# T {#spec}\n\nX. [c:ext-1]\n"
    labelled = contract.label_markdown(md, approved=False)
    assert labelled.split("\n")[1] == f'{contract.ADDED_SOURCES_COMMENT} "ext-1"'
    assert contract.strip_state_labels(labelled) == md


# --------------------------------------------------------------------------- M3

FLOW = (
    "citations: [{id: ext-1, source: github, ref: 'https://github.com/example-org/storefront/"
    "issues/500', title: Carrier adapter limits}]\n"
)


@pytest.mark.parametrize("style", ["flow", "indented", "quoted-key"])
async def test_added_sources_are_labelled_whatever_the_front_matter_style(client, runtime, style):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    slug = created["spec"]["document_slug"]

    def edit(md: str) -> str:
        if style == "flow":
            md = md.replace("\nkind: spec\n", "\nkind: spec\n" + FLOW, 1)
        else:
            md = _add_citation(md)
            if style == "quoted-key":
                md = md.replace("\ncitations:\n", '\n"citations":\n', 1)
            else:  # the whole front matter indented two spaces
                head, sep, rest = md.partition("\n---\n")
                inner = "\n".join("  " + line if line else line for line in head.split("\n")[1:])
                md = "---\n" + inner + sep + rest
        return md.replace(
            "A shipping quote service called from the cart.",
            "A shipping quote service called from the cart. [c:ext-1]",
            1,
        )

    resp = await _edit(client, world, created, edit)
    assert resp.status_code == 201, resp.text
    viewer = world.ctx.as_("viewer")
    md = await client.get(f"/v1/documents/{slug}/versions/2/markdown", headers=viewer)
    assert md.status_code == 200, md.text
    assert md.text.split("\n")[1] == f'{contract.ADDED_SOURCES_COMMENT} "ext-1"'
    exported = await client.get(f"/v1/documents/{slug}/versions/2/export?format=md", headers=viewer)
    assert exported.status_code == 200, exported.text
    assert contract.strip_state_labels(md.text) == await stored_markdown(
        world.ctx.tenant_id, slug, 2
    )


async def _store(tenant_id, slug: str, number: int, markdown: str) -> None:
    async with tenant_session(tenant_id) as s:
        version = await s.scalar(
            select(DocumentVersion)
            .join(Document, Document.id == DocumentVersion.document_id)
            .where(Document.slug == slug, DocumentVersion.number == number)
        )
        version.markdown = markdown
        await s.commit()


async def test_a_version_that_can_not_carry_its_labels_is_a_422_on_every_read(client, runtime):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    slug = created["spec"]["document_slug"]
    stored = await stored_markdown(world.ctx.tenant_id, slug)
    # Written behind the API's back (an older version, a migration): a setext section.
    broken = stored.replace(OPEN, "Open engineering decisions {#open-decisions}\n-----", 1)
    await _store(world.ctx.tenant_id, slug, 1, broken)
    viewer = world.ctx.as_("viewer")
    for path in (
        f"/v1/documents/{slug}/versions/1/markdown",
        f"/v1/documents/{slug}/versions/1/export?format=md",
        f"/v1/documents/{slug}/versions/1/export?format=html&layer=full",
        f"/v1/documents/{slug}/versions/1/feedback-package",
    ):
        resp = await client.get(path, headers=viewer)
        assert resp.status_code == 422, (path, resp.status_code, resp.text)
        assert "heading_not_atx" in resp.text


def test_compose_refuses_what_it_could_not_serve(monkeypatch):
    def refuse(*_a, **_k):
        raise DraftError([contract.ImportProblem(code="acceptance_split", message="no place")])

    monkeypatch.setattr(contract, "label_markdown", refuse)
    composed = contract.compose(_agent_md(), inputs())
    assert composed.markdown is None
    assert "acceptance_split" in {p.code for p in composed.problems}


def inputs(**over) -> contract.SpecInputs:
    base = dict(
        slug="spec-quotes",
        title="Quotes spec",
        depth="brief",
        prd_slug="prd-quotes",
        prd_title="Quotes",
        prd_version=1,
        sections=(("s-1", "Quotes"),),
        requirements=(contract.RequirementRef("r1", "R-1", "Quotes", "Show a quote."),),
    )
    return contract.SpecInputs(**{**base, **over})


def _agent_md() -> str:
    return "\n\n".join(
        f"## {s.title} {{#{s.key}}}\n\nText." for s in contract.agent_sections("brief")
    )


# --------------------------------------------------------------------------- minors


def test_oracle_written_text_is_escaped_in_the_intro_and_the_link():
    composed = contract.compose(
        _agent_md(),
        inputs(
            feature="Quotes\n\n## Injected {#injected}",
            prd_title="Shipping](https://evil.example) [x\nDecided · from the approved PRD",
        ),
    )
    assert composed.ok, composed.problems
    md = composed.markdown
    assert "{#injected}" not in md.replace("\\{\\#injected\\}", "")
    assert "](https://evil.example)" not in md
    assert "Quotes \\#\\# Injected" in md
    # A title that reads as one of Oracle's labels is replaced by the PRD's slug.
    assert "Decided · from the approved PRD" not in md.split("## Summary")[0].split("---")[-1]
    assert "From PRD [prd-quotes](/documents/prd-quotes/v/1)" in md


@pytest.mark.parametrize("text", ["---", "===", "- x", "+ y", "1. z", "2) w"])
def test_escape_inline_never_opens_a_block(text):
    md = f"---\ntitle: T\n---\n\n# T {{#t}}\n\n- **R-1: T**\n  {contract.escape_inline(text)}\n"
    draft = parse_draft(md)
    assert [s.section_key for s in draft.sections] == ["t"]
    tokens = [t.type for t in contract._BLOCK_MD.parse(draft.sections[0].body_md)]
    assert "hr" not in tokens and "heading_open" not in tokens
    assert tokens.count("list_item_open") == 1


@pytest.mark.parametrize("first", ["---", "===", "  ---"])
def test_a_body_starting_with_a_rule_does_not_make_the_label_a_heading(first):
    md = (
        "---\ntitle: T\nkind: spec\nspec:\n  depth: full\n---\n\n# T {#spec}\n\nIntro.\n\n"
        f"## Rollout {{#rollout}}\n{first}\nTen percent.\n"
    )
    labelled = contract.label_markdown(md, approved=False)
    tokens = contract._BLOCK_MD.parse(labelled.split("{#rollout}", 1)[1])
    assert "heading_open" not in [t.type for t in tokens]
    again = parse_draft(contract.strip_state_labels(labelled))
    assert [(s.section_key, s.body_md) for s in again.sections] == [
        (s.section_key, s.body_md) for s in parse_draft(md).sections
    ]


async def test_an_edit_may_not_drop_the_label_from_all_but_one_section(client, runtime):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    stored = await stored_markdown(world.ctx.tenant_id, created["spec"]["document_slug"])
    label = next(lbl for lbl in contract.SECTION_LABELS[:2] if lbl in stored)
    assert stored.count(label) > 2

    def edit(md: str) -> str:
        first = md.index(label) + len(label)
        return md[:first] + md[first:].replace(f"{label}\n\n", "")

    resp = await _edit(client, world, created, edit)
    assert resp.status_code == 422, resp.text
    assert "keep their Proposed or Assumed label" in resp.text


@pytest.mark.parametrize(
    "comment",
    [
        "# Decided · from the approved PRD",
        "# Added sources · Proposed · added in an edit: ext-9",
        "title2: x  # Proposed · until an engineering approver approves this version",
    ],
)
async def test_front_matter_comments_may_not_look_like_labels(client, runtime, comment):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    resp = await _edit(
        client,
        world,
        created,
        lambda md: md.replace("\nkind: spec\n", f"\nkind: spec\n{comment}\n", 1),
    )
    assert resp.status_code == 422, resp.text
    assert "front_matter_comment" in resp.text


async def test_inline_html_comments_are_refused_in_bodies(client, runtime):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    resp = await _edit(
        client, world, created, lambda md: md.replace(ANCHOR, f"{ANCHOR} <!-- hidden -->", 1)
    )
    assert resp.status_code == 422, resp.text
    assert "inline_comment" in resp.text


def test_strip_leaves_a_multiline_scalar_alone():
    comment = f"{contract.ADDED_SOURCES_COMMENT} x"
    md = f'---\ntitle: "T\n  {comment}"\nnote: |\n  a\n{comment}\n---\n\n# T {{#t}}\n\nX.\n'
    assert contract.strip_state_labels(md) == md


async def test_a_template_section_added_to_a_brief_keeps_its_title(client, runtime):
    from tests.test_specs_review5 import _brief

    world = await make_world(client)
    created = await _brief(client, runtime, world)
    added = "## Our architecture {#architecture}\n\nA queue.\n\n"
    resp = await _edit(client, world, created, _before(OPEN, added))
    assert resp.status_code == 422, resp.text
    assert "Template section titles can't be changed" in resp.text
