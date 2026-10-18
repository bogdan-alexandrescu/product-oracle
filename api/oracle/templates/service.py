"""Templates, themes, and the new-draft picker. The router owns the HTTP layer.

A template edit never changes a stored version: a new body is a new version, and
documents keep pointing at the version they were started from. Delete archives, so a
document whose template (or theme) is archived still resolves and still exports.
"""

import json
import re
import unicodedata
import uuid
from datetime import UTC, datetime
from functools import lru_cache
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.deps import Principal
from oracle.baseline.models import Entity
from oracle.docs import service as docs_service
from oracle.docs.models import Document
from oracle.docs.parser import DraftError, split_front_matter
from oracle.templates import validation
from oracle.templates.builtins import (
    BUILTIN_TEMPLATES_BY_KEY,
    DEFAULT_TEMPLATE_FOR_KIND,
    DEFAULT_THEME_FOR_KIND,
    ensure_builtins,
)
from oracle.templates.models import Template, TemplateVersion, Theme
from oracle.templates.schemas import (
    Choice,
    DraftDefaults,
    PrdAnswers,
    Problem,
    Recommendation,
    RecommendIn,
    RoadmapAnswers,
    StartDraftIn,
    StartDraftOut,
    TemplateCreate,
    TemplateOption,
    TemplateOut,
    TemplateSummary,
    TemplateUpdate,
    TemplateValidateOut,
    TemplateVersionOut,
    ThemeCreate,
    ThemeOption,
    ThemeTokens,
    ThemeUpdate,
)
from oracle.tenant_settings import TenantSetting

DRAFT_DEFAULTS_KEY = "draft_defaults"


class NotFoundError(LookupError):
    pass


class ConflictError(RuntimeError):
    pass


class InvalidError(ValueError):
    def __init__(self, detail: str, problems: list[Problem]):
        self.detail = detail
        self.problems = problems
        super().__init__(detail)


def _problems(items: list[validation.Problem]) -> list[Problem]:
    return [Problem(**p.__dict__) for p in items]


@lru_cache(maxsize=256)
def version_meta(body: str) -> validation.TemplateCheck:
    """Front matter and headings of a stored body (cached: versions are immutable)."""
    return validation.check_template(body)


def _now() -> datetime:
    return datetime.now(UTC)


# --- templates ----------------------------------------------------------------------


async def _latest_versions(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, Any]:
    if not ids:
        return {}
    latest = (
        select(TemplateVersion.template_id, func.max(TemplateVersion.version).label("n"))
        .where(TemplateVersion.template_id.in_(ids))
        .group_by(TemplateVersion.template_id)
        .subquery()
    )
    rows = await db.scalars(
        select(TemplateVersion).join(
            latest,
            (TemplateVersion.template_id == latest.c.template_id)
            & (TemplateVersion.version == latest.c.n),
        )
    )
    return {v.template_id: v for v in rows}


def _summary(t: Template, latest: TemplateVersion) -> dict[str, Any]:
    meta = version_meta(latest.body)
    return {
        "id": t.id,
        "key": t.key,
        "name": t.name,
        "kind": t.kind,
        "description": t.description,
        "builtin": t.builtin,
        "archived_at": t.archived_at,
        "created_at": t.created_at,
        "latest_version": latest.version,
        "suggested_theme": meta.suggested_theme,
        "suggest_when": meta.suggest_when,
    }


def _version_out(v: TemplateVersion) -> TemplateVersionOut:
    meta = version_meta(v.body)
    return TemplateVersionOut(
        version=v.version,
        body=v.body,
        required_sections=list(v.required_sections or []),
        created_by=v.created_by,
        created_at=v.created_at,
        suggested_theme=meta.suggested_theme,
        suggest_when=meta.suggest_when,
        brief_sections=meta.brief_sections,
        # A version saved before O1g may have no brief: it keeps resolving, and the
        # template's next edit must add brief markers.
        warnings=_problems(
            meta.warnings + [p for p in meta.problems if p.code == validation.NO_BRIEF_SECTIONS]
        ),
    )


async def list_templates(
    db: AsyncSession, kind: str | None = None, include_archived: bool = False
) -> list[TemplateSummary]:
    if await ensure_builtins(db):
        await db.commit()
    stmt = select(Template).order_by(Template.kind, Template.builtin.desc(), Template.name)
    if kind:
        stmt = stmt.where(Template.kind == kind)
    if not include_archived:
        stmt = stmt.where(Template.archived_at.is_(None))
    templates = list(await db.scalars(stmt))
    latest = await _latest_versions(db, [t.id for t in templates])
    return [TemplateSummary(**_summary(t, latest[t.id])) for t in templates if t.id in latest]


async def _template_or_404(db: AsyncSession, key: str) -> Template:
    template = await db.scalar(select(Template).where(Template.key == key))
    if template is None:
        if await ensure_builtins(db):
            await db.commit()
            template = await db.scalar(select(Template).where(Template.key == key))
    if template is None:
        raise NotFoundError(f"template '{key}' not found")
    return template


async def read_template(db: AsyncSession, key: str) -> TemplateOut:
    template = await _template_or_404(db, key)
    versions = list(
        await db.scalars(
            select(TemplateVersion)
            .where(TemplateVersion.template_id == template.id)
            .order_by(TemplateVersion.version)
        )
    )
    return TemplateOut(
        **_summary(template, versions[-1]), versions=[_version_out(v) for v in versions]
    )


async def read_template_version(db: AsyncSession, key: str, n: int) -> TemplateVersionOut:
    template = await _template_or_404(db, key)
    version = await db.scalar(
        select(TemplateVersion).where(
            TemplateVersion.template_id == template.id, TemplateVersion.version == n
        )
    )
    if version is None:
        raise NotFoundError(f"version {n} of template '{key}' not found")
    return _version_out(version)


async def _theme_keys(db: AsyncSession) -> set[str]:
    return set(await db.scalars(select(Theme.key)))


async def validate_template(
    db: AsyncSession, body: str, required_sections: list[str] | None = None
) -> TemplateValidateOut:
    if await ensure_builtins(db):
        await db.commit()
    check = validation.check_template(body, theme_keys=await _theme_keys(db))
    problems = list(check.problems)
    if required_sections is not None:
        problems += validation.check_required_sections(required_sections, check)
    return TemplateValidateOut(
        valid=not problems,
        problems=_problems(problems),
        warnings=_problems(check.warnings),
        brief_sections=check.brief_sections,
        section_keys=check.section_keys,
        suggested_theme=check.suggested_theme,
        suggest_when=check.suggest_when,
    )


async def _checked_version(
    db: AsyncSession, body: str, required: list[str] | None
) -> tuple[str, list[str]]:
    result = await validate_template(db, body, required)
    if not result.valid:
        raise InvalidError(f"template rejected: {len(result.problems)} problem(s)", result.problems)
    check = version_meta(body)
    return body, required if required is not None else check.default_required_sections()


async def create_template(db: AsyncSession, data: TemplateCreate, principal: Principal):
    body, required = await _checked_version(db, data.body, data.required_sections)
    if await db.scalar(select(Template.id).where(Template.key == data.key)):
        raise ConflictError(f"a template with key '{data.key}' exists (archived ones too)")
    template = Template(
        key=data.key, name=data.name, kind=data.kind, description=data.description, builtin=False
    )
    db.add(template)
    try:
        await db.flush()
    except IntegrityError as e:
        await db.rollback()
        raise ConflictError(f"a template with key '{data.key}' exists") from e
    db.add(
        TemplateVersion(
            template_id=template.id,
            version=1,
            body=body,
            required_sections=required,
            created_by=principal.id,
        )
    )
    await audit.record(
        db, principal, "template.created", "template", template.id, {"key": data.key}
    )
    await db.commit()
    return await read_template(db, data.key)


async def update_template(
    db: AsyncSession, key: str, data: TemplateUpdate, principal: Principal
) -> TemplateOut:
    # Seed first: an upgrade seeded after ``latest`` is read would take its version number.
    if await ensure_builtins(db):
        await db.commit()
    template = await _template_or_404(db, key)
    latest = await db.scalar(
        select(TemplateVersion)
        .where(TemplateVersion.template_id == template.id)
        .order_by(TemplateVersion.version.desc())
        .limit(1)
    )
    assert latest is not None
    changes: dict[str, Any] = {}
    if data.name is not None and data.name != template.name:
        template.name = changes["name"] = data.name
    if "description" in data.model_fields_set and data.description != template.description:
        template.description = changes["description"] = data.description
    body = data.body if data.body is not None else latest.body
    required = data.required_sections
    if body != latest.body or (required is not None and required != latest.required_sections):
        body, required = await _checked_version(db, body, required)
        version = TemplateVersion(
            template_id=template.id,
            version=latest.version + 1,
            body=body,
            required_sections=required,
            created_by=principal.id,
        )
        db.add(version)
        changes["version"] = version.version
    if changes:
        await audit.record(db, principal, "template.updated", "template", template.id, changes)
        await db.commit()
    return await read_template(db, key)


async def set_template_archived(
    db: AsyncSession, key: str, archived: bool, principal: Principal
) -> TemplateOut:
    template = await _template_or_404(db, key)
    if archived and template.archived_at is None:
        template.archived_at = _now()
    elif not archived:
        template.archived_at = None
    action = "template.archived" if archived else "template.restored"
    await audit.record(db, principal, action, "template", template.id, {"key": key})
    await db.commit()
    return await read_template(db, key)


# --- themes -------------------------------------------------------------------------


def _check_theme(tokens: ThemeTokens, css: str, slide_css: str | None = None) -> list[Problem]:
    return _problems(
        validation.check_theme_tokens(tokens.model_dump(exclude_none=True))
        + validation.check_theme_css(css)
        + validation.check_slide_css(slide_css)
    )


def check_theme(tokens: ThemeTokens, css: str, slide_css: str | None = None) -> list[Problem]:
    return _check_theme(tokens, css, slide_css)


def _slide_css(value: str | None) -> str | None:
    """Blank slide CSS is stored as null: the theme uses the shared slide layout."""
    return value if value and value.strip() else None


def _raise_if(problems: list[Problem], what: str) -> None:
    if problems:
        contrast = [p for p in problems if p.code == "insufficient_contrast"]
        detail = contrast[0].message if contrast else f"{what} rejected: {problems[0].message}"
        raise InvalidError(detail, problems)


async def list_themes(
    db: AsyncSession, kind: str | None = None, include_archived: bool = False
) -> list[Theme]:
    if await ensure_builtins(db):
        await db.commit()
    stmt = select(Theme).order_by(Theme.builtin.desc(), Theme.name)
    if kind:
        stmt = stmt.where(Theme.kind.in_([kind, "any"]))
    if not include_archived:
        stmt = stmt.where(Theme.archived_at.is_(None))
    return list(await db.scalars(stmt))


async def theme_or_404(db: AsyncSession, key: str) -> Theme:
    theme = await db.scalar(select(Theme).where(Theme.key == key))
    if theme is None and await ensure_builtins(db):
        await db.commit()
        theme = await db.scalar(select(Theme).where(Theme.key == key))
    if theme is None:
        raise NotFoundError(f"theme '{key}' not found")
    return theme


async def create_theme(db: AsyncSession, data: ThemeCreate, principal: Principal) -> Theme:
    _raise_if(_check_theme(data.tokens, data.css, data.slide_css), "theme")
    if await db.scalar(select(Theme.id).where(Theme.key == data.key)):
        raise ConflictError(f"a theme with key '{data.key}' exists (archived ones too)")
    theme = Theme(
        key=data.key,
        name=data.name,
        kind=data.kind,
        description=data.description,
        tokens=data.tokens.model_dump(exclude_none=True),
        css=data.css,
        slide_css=_slide_css(data.slide_css),
        builtin=False,
        created_by=principal.id,
    )
    db.add(theme)
    try:
        await db.flush()
    except IntegrityError as e:
        await db.rollback()
        raise ConflictError(f"a theme with key '{data.key}' exists") from e
    await audit.record(db, principal, "theme.created", "theme", theme.id, {"key": data.key})
    await db.commit()
    await db.refresh(theme)
    return theme


async def update_theme(db: AsyncSession, key: str, data: ThemeUpdate, principal: Principal):
    theme = await theme_or_404(db, key)
    tokens = data.tokens if data.tokens is not None else ThemeTokens.model_validate(theme.tokens)
    css = data.css if data.css is not None else theme.css
    slide_set = "slide_css" in data.model_fields_set
    slide_css = _slide_css(data.slide_css) if slide_set else theme.slide_css
    problems = _check_theme(tokens, css, slide_css)
    if theme.builtin and slide_set and slide_css is not None:
        problems.append(
            Problem(
                code="builtin_slide_css",
                message="a built-in theme keeps its own slide design; create a company "
                "theme to write slide CSS",
            )
        )
    _raise_if(problems, "theme")
    changed = []
    for field in ("name", "kind", "description"):
        if field in data.model_fields_set and getattr(data, field) is not None:
            setattr(theme, field, getattr(data, field))
            changed.append(field)
    if data.tokens is not None:
        theme.tokens = tokens.model_dump(exclude_none=True)
        changed.append("tokens")
    if data.css is not None:
        theme.css = css
        changed.append("css")
    if slide_set and slide_css != theme.slide_css:
        theme.slide_css = slide_css
        changed.append("slide_css")
    if changed:
        await audit.record(db, principal, "theme.updated", "theme", theme.id, {"fields": changed})
        await db.commit()
        await db.refresh(theme)
    return theme


async def set_theme_archived(db: AsyncSession, key: str, archived: bool, principal: Principal):
    theme = await theme_or_404(db, key)
    if archived and theme.archived_at is None:
        theme.archived_at = _now()
    elif not archived:
        theme.archived_at = None
    action = "theme.archived" if archived else "theme.restored"
    await audit.record(db, principal, action, "theme", theme.id, {"key": key})
    await db.commit()
    await db.refresh(theme)
    return theme


# --- company defaults ---------------------------------------------------------------


async def company_draft_defaults(db: AsyncSession) -> dict[str, Any]:
    value = await db.scalar(
        select(TenantSetting.value).where(TenantSetting.key == DRAFT_DEFAULTS_KEY)
    )
    return value if isinstance(value, dict) else {}


async def read_draft_defaults(db: AsyncSession) -> DraftDefaults:
    return DraftDefaults.model_validate(await company_draft_defaults(db))


async def write_draft_defaults(
    db: AsyncSession, data: DraftDefaults, principal: Principal
) -> DraftDefaults:
    problems: list[Problem] = []
    for kind in ("prd", "roadmap"):
        choice: Choice | None = getattr(data, kind)
        if choice is None:
            continue
        template = await db.scalar(select(Template).where(Template.key == choice.template))
        if template is None or template.archived_at is not None or template.kind != kind:
            problems.append(
                Problem(
                    code="unknown_template",
                    message=f"{kind}: no live {kind} template '{choice.template}'",
                )
            )
        if choice.theme is not None:
            theme = await db.scalar(select(Theme).where(Theme.key == choice.theme))
            if theme is None or theme.archived_at is not None:
                problems.append(
                    Problem(code="unknown_theme", message=f"{kind}: no live theme '{choice.theme}'")
                )
    if problems:
        raise InvalidError("defaults rejected", problems)
    value = data.model_dump(exclude_none=True)
    row = await db.scalar(select(TenantSetting).where(TenantSetting.key == DRAFT_DEFAULTS_KEY))
    if row is None:
        db.add(TenantSetting(key=DRAFT_DEFAULTS_KEY, value=value, updated_by=principal.id))
    else:
        row.value = value
        row.updated_by = principal.id
    await audit.record(db, principal, "settings.draft_defaults", "tenant_setting", None, value)
    await db.commit()
    return DraftDefaults.model_validate(value)


# --- picker -------------------------------------------------------------------------


def recommend_prd(a: PrdAnswers) -> tuple[str, str]:
    """(template key, one-line reason) from the four PRD picker answers.

    Rules follow docs/research/prd-formats.md, "Template picker: what to ask": the
    decision wanted is the strongest signal, then size and newness, then readers;
    model-driven output gets the AI feature template.
    """
    if a.decision == "start_or_not":
        if a.model_driven:
            return "one-pager", (
                "You want a go / no-go first; a one-pager settles that. Add behaviour and "
                "evals when it becomes an AI feature PRD."
            )
        return (
            "one-pager",
            "You want a go / no-go first: a one-pager agrees the problem, "
            "audience and success measure fast.",
        )
    if a.decision == "technical_design":
        return (
            "prd-rfc",
            "The decision is about how to build it: product requirements first, "
            "then engineering's design, alternatives and trade-offs.",
        )
    if a.decision == "choose_between":
        return (
            "narrative-memo",
            "You are choosing between options: a decision narrative argues "
            "one choice in prose, with the options side by side.",
        )
    if a.decision == "bet_fixed_time":
        if a.size == "new_product":
            return (
                "pr-faq",
                "A big new bet: the PR/FAQ tests it from the customer's side before anyone builds.",
            )
        return (
            "shape-up-pitch",
            "You are betting a fixed time budget: a pitch shapes the solution to fit the appetite.",
        )
    if a.size == "new_product":
        return (
            "pr-faq",
            "A new product or market: the PR/FAQ tests the bet from the "
            "customer's view before building.",
        )
    if a.model_driven:
        return (
            "ai-feature",
            "The output comes from a model: this template specifies behaviour, "
            "evals, fallbacks and cost.",
        )
    if a.readers == "leadership":
        return (
            "narrative-memo",
            "Leadership or the board reads it: a narrative memo argues the "
            "case in prose and is read in one sitting.",
        )
    if a.decision is None and a.size == "small_change" and a.readers in (None, "founder"):
        return "one-pager", "A small change for the founder: a one-pager is enough to decide."
    if a.readers == "engineers_or_agents":
        return (
            "oracle-default",
            "Engineers or coding agents build from it: the goal-traced PRD "
            "has numbered requirements with Given / When / Then criteria.",
        )
    return (
        "oracle-default",
        "A cross-functional build: the goal-traced PRD agrees the problem, "
        "then the prioritized solution, then launch.",
    )


def recommend_roadmap(
    a: RoadmapAnswers, confirmed_goals: int | None
) -> tuple[str, str, dict[str, Any], list[str]]:
    """(template key, reason, options, warnings) from the roadmap picker answers.

    Rules follow docs/research/roadmap-formats.md, "Questions the template picker
    should ask"; audience becomes a variant layered on any template.
    """
    warnings: list[str] = []
    options: dict[str, Any] = {
        "variant": {"board": "board", "engineering": "engineering", "public": "public"}.get(
            a.audience or "", "team"
        ),
        "group_by": "team" if (a.teams or 0) >= 2 else None,
        "show_capacity": None,
    }
    if a.horizon == "one_cycle" or a.planning_style == "cycles":
        key, reason = (
            "cycle-bets",
            "The team plans in fixed cycles: show this cycle's bets, "
            "the next betting table and raw ideas.",
        )
    elif a.audience == "engineering":
        key, reason = (
            "release-plan",
            "Engineering reads it first: releases with target dates, "
            "scope, readiness and estimate drift.",
        )
    elif a.external_dates:
        key, reason = (
            "quarterly-timeline",
            "Real external dates exist: a quarterly timeline "
            "shows them, with dates only on committed work.",
        )
    elif a.audience == "board":
        key, reason = (
            "outcome-roadmap",
            "The board reads it first: rows are confirmed goals, "
            'so it answers "are we working on the right things?"',
        )
    elif a.horizon == "one_two_quarters" and (a.teams or 0) >= 2:
        key, reason = (
            "quarterly-timeline",
            "Several teams over one or two quarters: a "
            "timeline with swimlanes shows sequencing and dependencies.",
        )
    else:
        key, reason = (
            "now-next-later",
            "Direction by confidence horizon, with dated "
            "milestones only in Now: the default for most roadmaps.",
        )
        if a.audience == "public":
            reason = (
                "A public roadmap: Now / Next / Later rendered as status columns, "
                "public text only, with a disclaimer."
            )

    if key == "outcome-roadmap" and confirmed_goals is not None and confirmed_goals < 2:
        warnings.append(
            f"Only {confirmed_goals} confirmed goal(s) in the baseline: the outcome roadmap "
            "will be thin. Confirm goals first (goals interview)."
        )
    if a.public_version or a.audience == "public":
        if key in ("outcome-roadmap", "cycle-bets"):
            warnings.append(
                "This template has no public variant; the public version renders as "
                "Now / Next / Later."
            )
        warnings.append("Each item's public text needs approval before the public version ships.")
    if a.tracker_connected is False:
        warnings.append(
            "No engineering tracker estimates: the roadmap shows no dates, even in Now."
        )
    if a.show_capacity:
        if a.tracker_connected:
            options["show_capacity"] = True
        else:
            options["show_capacity"] = False
            warnings.append(
                "Capacity needs tracker estimates; it is hidden until a tracker is connected."
            )
    if options["group_by"]:
        reason += " Swimlanes by team, with dependency arrows."
    return key, reason, options, warnings


async def _confirmed_goals(db: AsyncSession) -> int:
    return int(
        await db.scalar(
            select(func.count())
            .select_from(Entity)
            .where(Entity.type == "goal", Entity.status == "confirmed")
        )
        or 0
    )


def _option(s: TemplateSummary) -> TemplateOption:
    return TemplateOption(
        key=s.key,
        name=s.name,
        description=s.description,
        latest_version=s.latest_version,
        suggested_theme=s.suggested_theme,
        suggest_when=s.suggest_when,
        builtin=s.builtin,
    )


def _theme_option(t: Theme) -> ThemeOption:
    return ThemeOption(key=t.key, name=t.name, description=t.description, kind=t.kind)


async def recommend(db: AsyncSession, data: RecommendIn) -> Recommendation:
    kind = data.kind
    templates = await list_templates(db, kind=kind)
    themes = await list_themes(db, kind=kind)
    by_key = {t.key: t for t in templates}
    theme_by_key = {t.key: t for t in themes}
    defaults = await company_draft_defaults(db)
    company = Choice.model_validate(defaults[kind]) if defaults.get(kind) else None

    warnings: list[str] = []
    options: dict[str, Any] = {}
    confirmed: int | None = None
    if kind == "prd":
        answers = data.prd or PrdAnswers()
        answered = answers.model_fields_set and any(
            v is not None for v in answers.model_dump().values()
        )
        key, reason = recommend_prd(answers)
    else:
        answers = data.roadmap or RoadmapAnswers()
        answered = any(v is not None for v in answers.model_dump().values())
        confirmed = (
            answers.confirmed_goals
            if answers.confirmed_goals is not None
            else await _confirmed_goals(db)
        )
        key, reason, options, warnings = recommend_roadmap(answers, confirmed)

    if not answered and company and company.template in by_key:
        key, reason = company.template, "Your company's default template for new drafts."
    if key not in by_key:
        # The recommended built-in was archived: fall back to the company default, then
        # the kind's default, then whatever is live.
        fallback = next(
            (
                k
                for k in (company.template if company else None, DEFAULT_TEMPLATE_FOR_KIND[kind])
                if k and k in by_key
            ),
            templates[0].key if templates else None,
        )
        if fallback is None:
            raise NotFoundError(f"no live {kind} template")
        archived = BUILTIN_TEMPLATES_BY_KEY.get(key)
        warnings.append(
            f"'{archived.name if archived else key}' is archived; "
            f"showing '{by_key[fallback].name}'."
        )
        key = fallback
    template = by_key[key]

    theme_key, theme_reason = None, ""
    if company and company.template == key and company.theme in theme_by_key:
        theme_key, theme_reason = company.theme, "Your company's default theme for this template."
    elif template.suggested_theme in theme_by_key:
        theme_key, theme_reason = template.suggested_theme, f"Suggested by {template.name}."
    elif company and company.theme in theme_by_key:
        theme_key, theme_reason = company.theme, "Your company's default theme."
    elif DEFAULT_THEME_FOR_KIND[kind] in theme_by_key:
        theme_key = DEFAULT_THEME_FOR_KIND[kind]
        theme_reason = f"The default {kind.upper() if kind == 'prd' else kind} theme."
    elif themes:
        theme_key, theme_reason = themes[0].key, "The first available theme."

    return Recommendation(
        kind=kind,
        template=_option(template),
        reason=reason,
        theme=_theme_option(theme_by_key[theme_key]) if theme_key else None,
        theme_reason=theme_reason,
        variant=options.get("variant"),
        group_by=options.get("group_by"),
        show_capacity=options.get("show_capacity"),
        warnings=warnings,
        confirmed_goals=confirmed,
        company_default=company,
        templates=[_option(t) for t in templates],
        themes=[_theme_option(t) for t in themes],
    )


# --- start a draft ------------------------------------------------------------------


def slugify(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug[:60].strip("-") or "draft"


async def _free_slug(db: AsyncSession, base: str) -> str:
    taken = set(
        await db.scalars(
            select(Document.slug).where((Document.slug == base) | Document.slug.like(f"{base}-%"))
        )
    )
    if base not in taken:
        return base
    n = 2
    while f"{base}-{n}" in taken:
        n += 1
    return f"{base}-{n}"


_TITLE_LINE = re.compile(r"^(#\s+)(.*?)(\s*\{#[A-Za-z0-9][A-Za-z0-9_.:-]*\}\s*)$", re.M)


def _yaml_scalar(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def draft_skeleton(
    body: str,
    *,
    slug: str,
    title: str,
    kind: str,
    template: str,
    version: int,
    theme: str | None,
) -> str:
    """The template body as a first draft: front matter rewritten for this document,
    template metadata dropped except the brief markers (O1f), the level-1 heading set
    to the title."""
    yaml_text, rest, _ = split_front_matter(body.replace("\r\n", "\n"))
    # The template's own front matter is replaced, not merged; its brief carries over.
    brief = version_meta(body).marked_brief
    lines = [
        "---",
        f"document: {slug}",
        f"title: {_yaml_scalar(title)}",
        f"kind: {kind}",
        f"template: {template}",
        f'template_version: "{version}"',
    ]
    if theme:
        lines.append(f"theme: {theme}")
    if brief:
        lines.append("brief: [" + ", ".join(json.dumps(k) for k in brief) + "]")
    lines.append("---")
    safe_title = title.replace("{", "(").replace("}", ")").replace("\n", " ")
    rest = _TITLE_LINE.sub(lambda m: f"{m.group(1)}{safe_title}{m.group(3)}", rest, count=1)
    return "\n".join(lines) + "\n" + rest.lstrip("\n")


async def start_draft(db: AsyncSession, data: StartDraftIn, principal: Principal) -> StartDraftOut:
    template = await _template_or_404(db, data.template)
    if template.kind != data.kind:
        raise InvalidError(
            f"template '{template.key}' is a {template.kind} template, not {data.kind}",
            [Problem(code="kind_mismatch", message=f"template kind is {template.kind}")],
        )
    if template.archived_at is not None:
        raise InvalidError(
            f"template '{template.key}' is archived; restore it to start new drafts",
            [Problem(code="archived_template", message="template is archived")],
        )
    stmt = select(TemplateVersion).where(TemplateVersion.template_id == template.id)
    if data.template_version is not None:
        stmt = stmt.where(TemplateVersion.version == data.template_version)
    else:
        stmt = stmt.order_by(TemplateVersion.version.desc()).limit(1)
    version = await db.scalar(stmt)
    if version is None:
        raise NotFoundError(
            f"version {data.template_version} of template '{template.key}' not found"
        )

    theme_key = data.theme or version_meta(version.body).suggested_theme
    if theme_key:
        theme = await db.scalar(select(Theme).where(Theme.key == theme_key))
        if theme is None:
            raise NotFoundError(f"theme '{theme_key}' not found")
        if theme.archived_at is not None and data.theme:
            raise InvalidError(
                f"theme '{theme_key}' is archived",
                [Problem(code="archived_theme", message="theme is archived")],
            )
        if theme.archived_at is not None:
            theme_key = None

    if data.slug:
        if await docs_service.find_document(db, data.slug) is not None:
            raise ConflictError(f"a document with slug '{data.slug}' exists")
        slug = data.slug
    else:
        slug = await _free_slug(db, slugify(data.title))

    document = Document(
        slug=slug,
        title=data.title,
        status="draft",
        kind=data.kind,
        template=template.key,
        template_version=str(version.version),
        theme=theme_key,
    )
    db.add(document)
    try:
        await db.flush()
    except IntegrityError as e:
        await db.rollback()
        raise ConflictError(f"a document with slug '{slug}' was created concurrently") from e

    markdown = draft_skeleton(
        version.body,
        slug=slug,
        title=data.title,
        kind=data.kind,
        template=template.key,
        version=version.version,
        theme=theme_key,
    )
    await audit.record(
        db,
        principal,
        "document.draft_started",
        "document",
        document.id,
        {"template": template.key, "template_version": version.version, "theme": theme_key},
    )
    try:
        result = await docs_service.import_draft(db, slug, markdown, principal)
    except DraftError as e:
        await db.rollback()
        raise InvalidError(
            "the template skeleton is not a valid draft",
            [Problem(code=p.code, message=p.message, line=p.line) for p in e.problems],
        ) from e
    return StartDraftOut(
        document_id=document.id,
        slug=slug,
        title=data.title,
        kind=data.kind,
        template=template.key,
        template_version=version.version,
        theme=theme_key,
        version=result.version.number,
    )
