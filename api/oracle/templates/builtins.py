"""Built-in templates and themes, seeded into every company idempotently.

Templates: the seven PRD and five roadmap skeletons from ``docs/research/templates/``,
copied into ``builtin/`` so the API never reads ``docs/`` at runtime. Key, name,
description and "suggest when" come from the research recommendation tables. The
pre-existing ``oracle-default`` v1 stays; the research skeleton becomes its v2.

Themes: derived from the research's presentation conventions (prd-formats.md section
5, roadmap-formats.md "Visual conventions").

Seeding never overwrites what a company changed: a built-in that was edited (its
latest version was created by a user) or archived is left alone, and a skeleton is
only added as a new version when no version of that template has exactly that body.
"""

import hashlib
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.templates.defaults import DEFAULT_TEMPLATE_KEY, ensure_default_template
from oracle.templates.models import Template, TemplateVersion, Theme
from oracle.templates.validation import check_template
from oracle.tenancy import current_tenant

BUILTIN_DIR = Path(__file__).resolve().parent / "builtin"


@dataclass(frozen=True)
class BuiltinTemplate:
    key: str
    kind: str
    name: str
    description: str
    suggest_when: str
    theme: str

    @property
    def path(self) -> Path:
        return BUILTIN_DIR / self.kind / f"{self.key}.md"


BUILTIN_TEMPLATES: tuple[BuiltinTemplate, ...] = (
    BuiltinTemplate(
        "oracle-default",
        "prd",
        "Goal-traced PRD",
        "Oracle's standard: goal trace, problem alignment, prioritized solution, requirements "
        "with ids, launch, recap",
        "Default for any cross-functional feature or product version; the founder has no "
        "strong preference",
        "clean-document",
    ),
    BuiltinTemplate(
        "one-pager",
        "prd",
        "One-pager",
        "Agree the problem, audience and success measure fast",
        'Early idea, small team, single feature, or "should we spend more time on this"',
        "one-page-brief",
    ),
    BuiltinTemplate(
        "pr-faq",
        "prd",
        "Working Backwards PR/FAQ",
        "Test a big new bet from the customer's view before building",
        "New product, new market, major bet; reviewers are leadership or investors",
        "press-release",
    ),
    BuiltinTemplate(
        "narrative-memo",
        "prd",
        "Decision narrative",
        "Argue one strategic choice in prose",
        "Choosing between options, a strategy shift, a board or exec review",
        "editorial-memo",
    ),
    BuiltinTemplate(
        "shape-up-pitch",
        "prd",
        "Shape Up pitch",
        "Bet a fixed time budget on a shaped solution",
        "Team works in fixed cycles; effort cap matters more than estimates",
        "clean-document",
    ),
    BuiltinTemplate(
        "prd-rfc",
        "prd",
        "Product spec + RFC",
        "Product requirements plus engineering's design, alternatives and trade-offs",
        'Engineering-heavy, infra/API/platform work, or the "how" is the main risk',
        "technical-spec",
    ),
    BuiltinTemplate(
        "ai-feature",
        "prd",
        "AI feature PRD",
        "Specify model behaviour, evals, fallbacks, cost and prompt ownership",
        "Any feature whose output comes from a model or agent",
        "technical-spec",
    ),
    BuiltinTemplate(
        "now-next-later",
        "roadmap",
        "Now / Next / Later",
        "Direction by confidence horizon. Dated milestones only in Now. Goal tag on every card.",
        "Always the default. Especially early stage, fast change, or when goals are confirmed "
        "but dates beyond the quarter are not credible.",
        "roadmap-board",
    ),
    BuiltinTemplate(
        "outcome-roadmap",
        "roadmap",
        "Outcome roadmap",
        "Rows = confirmed goals (metric, target), columns = horizons. Shows what each goal "
        "gets and flags items that serve no goal.",
        "Board or leadership audience. A goal-setting or OKR season. A traceability report "
        'shows drift. The founder asks "are we working on the right things?"',
        "roadmap-board",
    ),
    BuiltinTemplate(
        "quarterly-timeline",
        "roadmap",
        "Quarterly timeline",
        "Quarter axis, swimlanes by team or theme, dated bars in Now, fuzzy bars beyond, "
        "milestones, dependency arrows, capacity strip.",
        "External dates exist (launch, contract, event, regulation). GTM or finance needs "
        "timing. Several teams with cross-dependencies.",
        "roadmap-board",
    ),
    BuiltinTemplate(
        "release-plan",
        "roadmap",
        "Release plan",
        "Releases with target dates, scoped items, readiness, tracker links, estimate vs plan "
        "drift.",
        "Engineering audience. Versioned or app-store releases. Eng tracker connected with "
        "write or read access.",
        "roadmap-board",
    ),
    BuiltinTemplate(
        "cycle-bets",
        "roadmap",
        "Cycle bets (Shape Up)",
        "Current cycle bets with appetite and hill position, next-cycle pitches, cool-down.",
        "The team already works in fixed cycles or the founder wants a betting-table ritual. "
        "Small team, horizon of one cycle.",
        "roadmap-board",
    ),
)
BUILTIN_TEMPLATES_BY_KEY = {t.key: t for t in BUILTIN_TEMPLATES}
DEFAULT_TEMPLATE_FOR_KIND = {"prd": "oracle-default", "roadmap": "now-next-later"}


def _yaml_str(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


@cache
def builtin_body(t: BuiltinTemplate) -> str:
    """The research skeleton with the template's own metadata added to its front matter:
    the suggested theme and when to suggest it (both versioned with the body)."""
    raw = t.path.read_text(encoding="utf-8")
    assert raw.startswith("---\n"), t.path
    end = raw.index("\n---\n", 4)
    meta = f"theme: {t.theme}\nsuggest_when: {_yaml_str(t.suggest_when)}\n"
    return raw[: end + 1] + meta + raw[end + 1 :]


# --- themes -----------------------------------------------------------------------

BASE_TOKENS: dict[str, Any] = {
    "fonts": {
        "body": '"DejaVu Serif", Georgia, serif',
        "heading": '"DejaVu Sans", Helvetica, Arial, sans-serif',
        "mono": '"DejaVu Sans Mono", Menlo, Consolas, monospace',
    },
    "colors": {
        "text": "#1f2933",
        "heading": "#111827",
        "muted": "#5b6472",
        "accent": "#2f5bd3",
        "background": "#ffffff",
        "rule": "#d9dde3",
        "surface": "#f3f4f6",
    },
    "spacing": {
        "base_size_pt": 11,
        "line_height": 1.5,
        "page_margin_mm": 20,
        "section_gap_rem": 1.6,
    },
    "page": {"size": "A4", "orientation": "portrait"},
    "features": {
        "toc": False,
        "status_header": True,
        "page_fit": None,
        "numbered_headings": False,
        "legend": False,
        "appendix_break": False,
    },
}


def _tokens(**overrides: dict[str, Any]) -> dict[str, Any]:
    out = {k: dict(v) for k, v in BASE_TOKENS.items()}
    for group, values in overrides.items():
        out[group].update(values)
    return out


@dataclass(frozen=True)
class BuiltinTheme:
    key: str
    kind: str
    name: str
    description: str
    tokens: dict[str, Any]

    @property
    def css(self) -> str:
        return (BUILTIN_DIR / "themes" / f"{self.key}.css").read_text(encoding="utf-8")


BUILTIN_THEMES: tuple[BuiltinTheme, ...] = (
    BuiltinTheme(
        "clean-document",
        "prd",
        "Clean document",
        "Long scrolling PRD: table of contents, status header block, styled tables and "
        "requirement id badges. For the goal-traced PRD and classic long-form specs.",
        _tokens(
            fonts={"body": '"DejaVu Sans", Helvetica, Arial, sans-serif'},
            features={"toc": True, "status_header": True},
        ),
    ),
    BuiltinTheme(
        "one-page-brief",
        "prd",
        "One-page brief",
        "Dense, compact type for documents that must fit one printed page; the PDF export "
        "checks the fit and says so when it overflows.",
        _tokens(
            fonts={"body": '"DejaVu Sans", Helvetica, Arial, sans-serif'},
            spacing={
                "base_size_pt": 9,
                "line_height": 1.3,
                "page_margin_mm": 12,
                "section_gap_rem": 0.6,
            },
            features={"status_header": True, "page_fit": "one_page"},
        ),
    ),
    BuiltinTheme(
        "editorial-memo",
        "prd",
        "Editorial memo",
        "Print-first narrative: serif, generous line height and margins, appendix on a new "
        "page. For six-page style decision memos.",
        _tokens(
            fonts={
                "body": '"DejaVu Serif", Georgia, "Times New Roman", serif',
                "heading": '"DejaVu Serif", Georgia, serif',
            },
            colors={"accent": "#7a3e12", "text": "#1c1917", "heading": "#1c1917"},
            spacing={"base_size_pt": 11.5, "line_height": 1.7, "page_margin_mm": 28},
            features={"appendix_break": True},
        ),
    ),
    BuiltinTheme(
        "press-release",
        "prd",
        "Press release",
        "Newspaper-like first page (dateline, headline, subheading) for the press release, "
        "then question-and-answer styling for the FAQs. For Working Backwards PR/FAQs.",
        _tokens(
            fonts={"heading": '"DejaVu Serif", Georgia, serif'},
            colors={"accent": "#9b1c1c"},
            features={"appendix_break": True},
        ),
    ),
    BuiltinTheme(
        "technical-spec",
        "prd",
        "Technical spec",
        "Numbered headings, monospace blocks, wide tables with pass/fail colouring and "
        "threshold callouts. For product spec + RFC and AI feature PRDs.",
        _tokens(
            fonts={"body": '"DejaVu Sans", Helvetica, Arial, sans-serif'},
            colors={"accent": "#0f5e8c"},
            spacing={"base_size_pt": 10.5, "line_height": 1.45, "page_margin_mm": 16},
            features={"toc": True, "numbered_headings": True},
        ),
    ),
    BuiltinTheme(
        "roadmap-board",
        "roadmap",
        "Roadmap board",
        "Landscape pages with an as-of header and a legend on every page; items as cards "
        "that never split across pages. For every roadmap template.",
        _tokens(
            fonts={"body": '"DejaVu Sans", Helvetica, Arial, sans-serif'},
            spacing={"base_size_pt": 9.5, "line_height": 1.35, "page_margin_mm": 12},
            page={"size": "A4", "orientation": "landscape"},
            features={"legend": True, "status_header": True},
        ),
    ),
)
BUILTIN_THEMES_BY_KEY = {t.key: t for t in BUILTIN_THEMES}
DEFAULT_THEME_FOR_KIND = {"prd": "clean-document", "roadmap": "roadmap-board"}


async def _stale_builtins(session: AsyncSession) -> list[str]:
    """Keys of built-in templates whose packaged body is not yet a version and which the
    company has not edited (latest version seeded, not created by a user) or archived."""
    rows = (
        await session.execute(
            select(
                Template.key,
                TemplateVersion.version,
                TemplateVersion.created_by,
                func.md5(TemplateVersion.body),
            )
            .join(TemplateVersion, TemplateVersion.template_id == Template.id)
            .where(Template.builtin.is_(True), Template.archived_at.is_(None))
            .order_by(Template.key, TemplateVersion.version)
        )
    ).all()
    hashes: dict[str, set[str]] = {}
    latest_by_user: dict[str, bool] = {}
    for key, _, created_by, digest in rows:
        hashes.setdefault(key, set()).add(digest)
        latest_by_user[key] = created_by is not None
    return [
        t.key
        for t in BUILTIN_TEMPLATES
        if t.key in hashes
        and not latest_by_user[t.key]
        and _md5(builtin_body(t)) not in hashes[t.key]
    ]


def _md5(text_: str) -> str:
    return hashlib.md5(text_.encode("utf-8")).hexdigest()


async def ensure_builtins(session: AsyncSession) -> bool:
    """Seed the built-in themes and templates into the session's company (no commit).

    A packaged skeleton that changed (O1f added the brief layer) becomes the next
    version of a built-in the company has not edited or archived. Returns True when
    something was added. Concurrent callers are serialised by a transaction-scoped
    advisory lock on the company id.
    """
    tenant_id = current_tenant(session)
    theme_keys = set(await session.scalars(select(Theme.key)))
    template_keys = set(await session.scalars(select(Template.key)))
    missing_themes = [t for t in BUILTIN_THEMES if t.key not in theme_keys]
    missing_templates = [t for t in BUILTIN_TEMPLATES if t.key not in template_keys]
    default = BUILTIN_TEMPLATES_BY_KEY[DEFAULT_TEMPLATE_KEY]
    default_body = builtin_body(default)
    default_has_research = False
    if DEFAULT_TEMPLATE_KEY in template_keys:
        default_has_research = default_body in set(
            await session.scalars(
                select(TemplateVersion.body)
                .join(Template, Template.id == TemplateVersion.template_id)
                .where(Template.key == DEFAULT_TEMPLATE_KEY)
            )
        )
    stale = await _stale_builtins(session)
    if not missing_themes and not missing_templates and default_has_research and not stale:
        return False

    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": f"oracle-builtins:{tenant_id}"}
    )
    # Re-read under the lock: another request may have seeded meanwhile.
    theme_keys = set(await session.scalars(select(Theme.key)))
    for t in BUILTIN_THEMES:
        if t.key in theme_keys:
            continue
        session.add(
            Theme(
                key=t.key,
                name=t.name,
                kind=t.kind,
                description=t.description,
                tokens=t.tokens,
                css=t.css,
                builtin=True,
            )
        )

    template = await ensure_default_template(session)
    versions = list(
        await session.scalars(
            select(TemplateVersion).where(TemplateVersion.template_id == template.id)
        )
    )
    if template.description is None and not template.builtin:
        # The oracle-default seeded before v1 had no metadata.
        template.name = default.name
        template.kind = default.kind
        template.description = default.description
        template.builtin = True
    if default_body not in {v.body for v in versions}:
        session.add(_version(template, max(v.version for v in versions) + 1, default_body))
    await session.flush()

    for key in await _stale_builtins(session):
        row = await session.scalar(select(Template).where(Template.key == key))
        assert row is not None
        latest = await session.scalar(
            select(func.max(TemplateVersion.version)).where(TemplateVersion.template_id == row.id)
        )
        session.add(_version(row, (latest or 0) + 1, builtin_body(BUILTIN_TEMPLATES_BY_KEY[key])))

    existing = set(await session.scalars(select(Template.key)))
    for t in BUILTIN_TEMPLATES:
        if t.key in existing:
            continue
        row = Template(key=t.key, name=t.name, kind=t.kind, description=t.description, builtin=True)
        session.add(row)
        await session.flush()
        session.add(_version(row, 1, builtin_body(t)))
    await session.flush()
    return True


def _version(template: Template, number: int, body: str) -> TemplateVersion:
    check = check_template(body)
    assert check.ok, (template.key, check.problems)
    return TemplateVersion(
        template_id=template.id,
        version=number,
        body=body,
        required_sections=check.default_required_sections(),
    )
