"""Templates and themes: built-in seeding, versioning, archive, validation, contrast."""

from pathlib import Path

import pytest
from sqlalchemy import func, select

from oracle.templates import builtins
from oracle.templates.builtins import BUILTIN_TEMPLATES, BUILTIN_THEMES, ensure_builtins
from oracle.templates.defaults import DEFAULT_TEMPLATE_BODY, ensure_default_template
from oracle.templates.models import Template, TemplateVersion, Theme
from oracle.templates.validation import check_template, check_theme_tokens, contrast
from oracle.tenancy import tenant_session
from tests.conftest import seed_company
from tests.test_priorities import _token

REPO = Path(__file__).resolve().parents[2]

VALID = """---
theme: clean-document
suggest_when: "Small fixes"
brief: [problem]
---

# {{title}} {#title}

## Problem {#problem}
<!-- guidance -->

## Sources and data points {#sources}

### Sources {#sources-list}
- [c:c1] allowed here
"""


# --- seeding ------------------------------------------------------------------------


def test_packaged_skeletons_match_the_research_copies():
    research = REPO / "docs" / "research" / "templates"
    if not research.exists():  # e.g. inside the API image
        pytest.skip("docs/ not available")
    for t in BUILTIN_TEMPLATES:
        assert t.path.read_text() == (research / t.kind / f"{t.key}.md").read_text(), t.key
    assert len([t for t in BUILTIN_TEMPLATES if t.kind == "prd"]) == 7
    assert len([t for t in BUILTIN_TEMPLATES if t.kind == "roadmap"]) == 5


@pytest.mark.parametrize("t", BUILTIN_TEMPLATES, ids=lambda t: t.key)
def test_every_builtin_is_a_valid_template_naming_a_builtin_theme(t):
    check = check_template(builtins.builtin_body(t))
    assert check.ok, check.problems
    assert check.suggested_theme == t.theme
    assert t.theme in builtins.BUILTIN_THEMES_BY_KEY
    assert check.suggest_when == t.suggest_when


# qa-docs-36 / qa-docs-38: the picker shows these descriptions to people, in plain words
# (web/lib/api/mock/lane-f.ts TEMPLATE_SEEDS carries the same text).
PLAIN_DESCRIPTIONS = {
    "oracle-default": "Oracle's standard: the goal it serves, the problem, the solution in "
    "priority order, numbered requirements, the launch and a look back",
    "now-next-later": "What happens now, next and later. Only Now has dates; every card names "
    "the goal it serves.",
    "outcome-roadmap": "One row per confirmed goal, with what it gets now, next and later. "
    "Shows the work that serves no goal.",
    "quarterly-timeline": "Work laid out by quarter, one lane per team. Firm dates this "
    "quarter, rough ranges after it.",
    "release-plan": "Each release with its target date, what is in it, what is left, and "
    "whether it is still on schedule.",
    "cycle-bets": "What the team committed to this cycle and how far along each piece is, "
    "ideas for the next cycle, and the break between cycles.",
}


def test_builtin_descriptions_are_plain_words():
    by_key = {t.key: t for t in BUILTIN_TEMPLATES}
    for key, text in PLAIN_DESCRIPTIONS.items():
        assert by_key[key].description == text, key
    jargon = ("with ids", "Rows =", "fuzzy bars", "hill position", "cool-down", "estimate drift")
    for t in BUILTIN_TEMPLATES:
        assert not any(j in t.description for j in jargon), t.key


async def test_seeding_is_idempotent_and_keeps_default_v1(db):
    await ensure_default_template(db)  # what migration 0002 / oracle.seed already did
    assert await ensure_builtins(db) is True
    assert await ensure_builtins(db) is False
    await db.commit()
    assert await db.scalar(select(func.count()).select_from(Template)) == 12
    assert await db.scalar(select(func.count()).select_from(Theme)) == len(BUILTIN_THEMES)
    default = await db.scalar(select(Template).where(Template.key == "oracle-default"))
    assert default.builtin and default.name == "Goal-traced PRD" and default.kind == "prd"
    versions = list(
        await db.scalars(
            select(TemplateVersion)
            .where(TemplateVersion.template_id == default.id)
            .order_by(TemplateVersion.version)
        )
    )
    assert [v.version for v in versions] == [1, 2]
    assert versions[0].body == DEFAULT_TEMPLATE_BODY
    assert "{#sources}" in versions[1].body


async def test_seeding_leaves_edited_and_archived_builtins_alone(client, tenant_id):
    h = await _token(tenant_id)
    await seed_company(tenant_id)
    assert (await client.delete("/v1/templates/pr-faq", headers=h)).status_code == 200
    body = (await client.get("/v1/templates/one-pager", headers=h)).json()["versions"][0]["body"]
    edited = body.replace("## Problem {#problem}", "## The problem {#problem}")
    resp = await client.patch("/v1/templates/one-pager", json={"body": edited}, headers=h)
    assert resp.json()["latest_version"] == 2
    async with tenant_session(tenant_id) as s:
        assert await ensure_builtins(s) is False
    live = {t["key"] for t in (await client.get("/v1/templates", headers=h)).json()}
    assert "pr-faq" not in live and len(live) == 11
    assert (await client.get("/v1/templates/one-pager", headers=h)).json()["latest_version"] == 2


# --- template API -------------------------------------------------------------------


async def test_list_filters_by_kind_and_reads_need_sign_in(client, tenant_id):
    await seed_company(tenant_id)
    h = await _token(tenant_id, "viewer")
    prd = (await client.get("/v1/templates?kind=prd", headers=h)).json()
    roadmap = (await client.get("/v1/templates?kind=roadmap", headers=h)).json()
    assert len(prd) == 7 and len(roadmap) == 5
    nnl = next(t for t in roadmap if t["key"] == "now-next-later")
    assert nnl["builtin"] and nnl["suggested_theme"] == "roadmap-board"
    assert nnl["suggest_when"].startswith("Always the default")
    assert (await client.get("/v1/templates")).status_code == 401


async def test_create_edit_versions_archive_restore(client, tenant_id):
    viewer = await _token(tenant_id, "viewer")
    h = await _token(tenant_id, "approver")
    await seed_company(tenant_id)  # the built-in themes, for the theme check
    payload = {"key": "bug-bash", "name": "Bug bash", "kind": "prd", "body": VALID}
    assert (await client.post("/v1/templates", json=payload, headers=viewer)).status_code == 403
    resp = await client.post("/v1/templates", json=payload, headers=h)
    assert resp.status_code == 201, resp.text
    t = resp.json()
    assert t["latest_version"] == 1 and not t["builtin"]
    assert t["versions"][0]["required_sections"] == ["title", "problem", "sources"]
    assert t["suggested_theme"] == "clean-document"
    taken = await client.post("/v1/templates", json=payload, headers=h)
    assert taken.status_code == 409
    assert taken.json()["detail"] == (
        "A template with key bug-bash already exists. Archived templates keep their keys."
    )

    # Renaming keeps the version; a new body adds one, and v1 stays as it was.
    resp = await client.patch("/v1/templates/bug-bash", json={"name": "Bug bash v2"}, headers=h)
    assert resp.json()["name"] == "Bug bash v2" and resp.json()["latest_version"] == 1
    body2 = VALID.replace("## Problem {#problem}", "## Problem {#problem}\n\n## Scope {#scope}")
    resp = await client.patch("/v1/templates/bug-bash", json={"body": body2}, headers=h)
    assert resp.json()["latest_version"] == 2
    v1 = (await client.get("/v1/templates/bug-bash/versions/1", headers=viewer)).json()
    assert v1["body"] == VALID
    same = await client.patch("/v1/templates/bug-bash", json={"body": body2}, headers=h)
    assert same.json()["latest_version"] == 2

    # Archive hides it from the list; every version still resolves; restore brings it back.
    resp = await client.delete("/v1/templates/bug-bash", headers=h)
    assert resp.json()["archived_at"] is not None
    keys = {t["key"] for t in (await client.get("/v1/templates", headers=h)).json()}
    assert "bug-bash" not in keys
    archived = (await client.get("/v1/templates?include_archived=true", headers=h)).json()
    assert "bug-bash" in {t["key"] for t in archived}
    assert (await client.get("/v1/templates/bug-bash/versions/2", headers=h)).status_code == 200
    resp = await client.post("/v1/templates/bug-bash/restore", headers=h)
    assert resp.json()["archived_at"] is None
    assert (await client.get("/v1/templates/nope", headers=h)).status_code == 404


async def test_builtins_are_editable_as_new_versions_and_archivable(client, tenant_id):
    await seed_company(tenant_id)
    h = await _token(tenant_id)
    t = (await client.get("/v1/templates/prd-rfc", headers=h)).json()
    body = t["versions"][-1]["body"].replace("## Open questions", "## Questions")
    resp = await client.patch("/v1/templates/prd-rfc", json={"body": body}, headers=h)
    assert resp.status_code == 200 and resp.json()["latest_version"] == 2
    assert resp.json()["builtin"]
    assert (await client.delete("/v1/templates/prd-rfc", headers=h)).json()["archived_at"]


# O1g: every template marks a brief, so each body below does (but the invalid YAML).
BRIEF_TITLE = "---\nbrief: [title]\n---\n"
BRIEF_T = "---\nbrief: [t]\n---\n"


@pytest.mark.parametrize(
    ("body", "codes"),
    [
        (
            BRIEF_TITLE + "# T {#title}\n\n## Problem\n\n## Sources and data points {#sources}\n",
            {"missing_section_id"},
        ),
        (
            BRIEF_TITLE + "# T {#title}\n\n## Problem {#p}\nWe know [c:c1].\n\n"
            "## Sources and data points {#sources}\n",
            {"citation_in_body"},
        ),
        (BRIEF_TITLE + "# T {#title}\n\n## Problem {#p}\n", {"missing_sources_section"}),
        (
            BRIEF_TITLE
            + "# T {#title}\n\n## Sources and data points {#sources}\n\n## After {#after}\n",
            {"sources_section_not_last"},
        ),
        (
            BRIEF_T + "# T {#t}\n\n## A {#t}\n\n## Sources and data points {#sources}\n",
            {"duplicate_section_id"},
        ),
        (
            "---\ntheme: [\n---\n# T {#t}\n\n## Sources and data points {#sources}\n",
            {"invalid_front_matter", "no_brief_sections"},
        ),
        (
            "---\ntheme: nope\nbrief: [t]\n---\n"
            "# T {#t}\n\n## Sources and data points {#sources}\n",
            {"unknown_theme"},
        ),
        (
            BRIEF_T
            + "# T {#t}\n\n```yaml\nlayout: [\n```\n\n## Sources and data points {#sources}\n",
            {"invalid_layout"},
        ),
    ],
)
async def test_validation_reports_every_problem(client, tenant_id, body, codes):
    h = await _token(tenant_id)
    await client.get("/v1/themes", headers=h)
    resp = await client.post("/v1/templates/validate", json={"body": body}, headers=h)
    out = resp.json()
    assert not out["valid"]
    assert {p["code"] for p in out["problems"]} == codes
    resp = await client.post(
        "/v1/templates",
        json={"key": "bad", "name": "Bad", "kind": "prd", "body": body},
        headers=h,
    )
    assert resp.status_code == 422
    assert resp.json()["detail"].startswith("The template was not saved: it has ")
    assert {p["code"] for p in resp.json()["problems"]} == codes


async def test_citation_problem_names_the_line_and_section(client, tenant_id):
    await seed_company(tenant_id)
    h = await _token(tenant_id)
    body = (
        "---\nbrief: [problem]\n---\n"
        "# T {#title}\n\n## Problem {#problem}\nOk.\nWe know [c:c9].\n\n"
        "## Sources and data points {#sources}\n- [c:c9]\n"
    )
    out = (await client.post("/v1/templates/validate", json={"body": body}, headers=h)).json()
    [p] = out["problems"]
    assert p["line"] == 8 and p["section_key"] == "problem" and "[c:c9]" in p["message"]
    unknown = await client.post(
        "/v1/templates/validate",
        json={"body": VALID, "required_sections": ["problem", "nope"]},
        headers=h,
    )
    assert [p["code"] for p in unknown.json()["problems"]] == ["unknown_required_section"]


# --- themes -------------------------------------------------------------------------


def test_template_problems_are_plain_sentences():
    """qa-settings-34: capitalised sentences, no field paths or code words."""
    messages = [p.message for p in check_template("Just text, no headings.\n").problems]
    assert "The template has no headings (levels 1 to 3)." in messages
    body = "# Idea {#title}\n\n## Problem\n\n## Problem {#title}\n"
    messages = [p.message for p in check_template(body).problems]
    assert "The heading 'Problem' (level 2) must end with {#section-id}." in messages
    assert "The section id title is used more than once." in messages
    assert all(m[0].isupper() or m[0] in "'@" for m in messages), messages


def test_theme_problems_name_the_field_as_the_editor_does():
    """qa-settings-7: the message starts with the field's label, so it shows next to it."""
    problems = check_theme_tokens(
        {
            "colors": {"text": "red", "muted": "#aaaaaa", "background": "#ffffff"},
            "fonts": {"mono": "Fira<Code>"},
            "page": {"size": "A3"},
            "spacing": {"line_height": 9},
        }
    )
    messages = [p.message for p in problems]
    assert "Text colour must be a hex colour like #1f2933." in messages
    assert any(m.startswith("Muted colour #aaaaaa on the background #ffffff") for m in messages)
    assert (
        "Monospace font must be a list of font names (letters, digits, spaces, commas "
        "and quotes)." in messages
    )
    assert "Page size must be A4 or Letter." in messages
    assert "Line height must be a number from 1 to 2.5." in messages
    assert not any("colors." in m or "fonts." in m or "spacing." in m for m in messages)


def test_contrast_ratio():
    assert contrast("#000000", "#ffffff") == pytest.approx(21)
    assert contrast("#777777", "#ffffff") == pytest.approx(4.48, abs=0.01)
    for t in BUILTIN_THEMES:
        colors = t.tokens["colors"]
        for name in ("text", "muted", "accent", "heading"):
            assert contrast(colors[name], colors["background"]) >= 4.5, (t.key, name)


THEME = {
    "key": "brand",
    "name": "Brand",
    "kind": "prd",
    "tokens": {
        "fonts": {"body": "Inter, sans-serif"},
        "colors": {"text": "#111111", "muted": "#555555", "background": "#ffffff"},
        "page": {"size": "Letter", "orientation": "portrait"},
    },
    "css": "h1 { letter-spacing: -0.02em; }",
}


async def test_theme_crud_and_archive(client, tenant_id):
    await seed_company(tenant_id)
    h = await _token(tenant_id, "approver")
    viewer = await _token(tenant_id, "viewer")
    themes = (await client.get("/v1/themes", headers=viewer)).json()
    assert {t["key"] for t in themes} == {t.key for t in BUILTIN_THEMES}
    roadmap = (await client.get("/v1/themes?kind=roadmap", headers=viewer)).json()
    assert [t["key"] for t in roadmap] == ["roadmap-board"]

    assert (await client.post("/v1/themes", json=THEME, headers=viewer)).status_code == 403
    resp = await client.post("/v1/themes", json=THEME, headers=h)
    assert resp.status_code == 201, resp.text
    assert resp.json()["tokens"]["page"]["size"] == "Letter"
    taken = await client.post("/v1/themes", json=THEME, headers=h)
    assert taken.status_code == 409
    assert taken.json()["detail"] == (
        "A theme with key brand already exists. Archived themes keep their keys."
    )

    resp = await client.patch("/v1/themes/brand", json={"css": "h2 { color: #222; }"}, headers=h)
    assert resp.json()["css"] == "h2 { color: #222; }"
    assert resp.json()["tokens"]["fonts"]["body"] == "Inter, sans-serif"
    assert (await client.delete("/v1/themes/brand", headers=h)).json()["archived_at"]
    assert "brand" not in {t["key"] for t in (await client.get("/v1/themes", headers=h)).json()}
    assert (await client.get("/v1/themes/brand", headers=h)).status_code == 200
    assert (await client.post("/v1/themes/brand/restore", headers=h)).json()["archived_at"] is None

    # Built-ins are editable and archivable too.
    resp = await client.patch(
        "/v1/themes/clean-document", json={"description": "Ours now"}, headers=h
    )
    assert resp.status_code == 200 and resp.json()["builtin"]


async def test_low_contrast_is_rejected_with_a_clear_error(client, tenant_id):
    h = await _token(tenant_id)
    bad = {
        **THEME,
        "tokens": {**THEME["tokens"], "colors": {"text": "#aaaaaa", "background": "#ffffff"}},
    }
    resp = await client.post("/v1/themes", json=bad, headers=h)
    assert resp.status_code == 422
    assert resp.json()["detail"] == (
        "Text colour #aaaaaa on the background #ffffff has a contrast of 2.32:1; WCAG AA "
        "needs at least 4.5:1 for body text. Darken the text colour or lighten the background."
    )
    await client.post("/v1/themes", json=THEME, headers=h)
    resp = await client.patch(
        "/v1/themes/brand",
        json={
            "tokens": {**THEME["tokens"], "colors": {"muted": "#cccccc", "background": "#ffffff"}}
        },
        headers=h,
    )
    assert resp.status_code == 422
    assert resp.json()["problems"][0]["code"] == "insufficient_contrast"
    check = await client.post("/v1/themes/validate", json={"tokens": bad["tokens"]}, headers=h)
    assert check.json()["valid"] is False


@pytest.mark.parametrize(
    "css",
    [
        "@import url(https://example.com/x.css);",
        "body { background: url(https://example.com/track.png); }",
        "body { background: url('file:///etc/passwd'); }",
        "</style><script>alert(1)</script>",
        "b { c: u\\72l(x) }",
    ],
)
async def test_unsafe_css_is_rejected(client, tenant_id, css):
    h = await _token(tenant_id)
    resp = await client.post("/v1/themes", json={**THEME, "css": css}, headers=h)
    assert resp.status_code == 422
    assert resp.json()["problems"][0]["code"] == "unsafe_css"


async def test_unsafe_tokens_are_rejected(client, tenant_id):
    h = await _token(tenant_id)
    tokens = {**THEME["tokens"], "fonts": {"body": "x; } body { background: red"}}
    resp = await client.post("/v1/themes", json={**THEME, "tokens": tokens}, headers=h)
    assert resp.status_code == 422
    assert resp.json()["problems"][0]["code"] == "invalid_font"
    tokens = {**THEME["tokens"], "colors": {"text": "red; x: y"}}
    resp = await client.post("/v1/themes", json={**THEME, "tokens": tokens}, headers=h)
    assert resp.json()["problems"][0]["code"] == "invalid_color"


async def test_theme_preview_renders_unsaved_tokens(client, tenant_id):
    h = await _token(tenant_id, "viewer")
    resp = await client.post(
        "/v1/themes/preview",
        json={"tokens": THEME["tokens"], "css": "h1{color:#123456}"},
        headers=h,
    )
    assert resp.status_code == 200
    assert "--color-text: #111111;" in resp.text and "h1{color:#123456}" in resp.text
    assert "size: Letter portrait" in resp.text
    unsafe = await client.post(
        "/v1/themes/preview",
        json={
            "tokens": THEME["tokens"],
            "css": "@import url(https://x.test/a.css);",
            "kind": "roadmap",
        },
        headers=h,
    )
    assert "@import" not in unsafe.text
    assert "flag-no-goal" in unsafe.text  # the sample roadmap has an item serving no goal
