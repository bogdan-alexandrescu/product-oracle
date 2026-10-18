import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

TemplateKind = Literal["prd", "roadmap"]
ThemeKind = Literal["prd", "roadmap", "any"]
KEY_PATTERN = r"^[a-z0-9][a-z0-9-]{0,62}$"


class Problem(BaseModel):
    code: str
    message: str
    line: int | None = None
    section_key: str | None = None


class ProblemsResponse(BaseModel):
    """422 body when a template or theme fails validation: every problem at once."""

    detail: str
    problems: list[Problem]


# --- templates ----------------------------------------------------------------------


class TemplateVersionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    version: int
    body: str
    required_sections: list[str]
    created_by: uuid.UUID | None
    created_at: datetime
    # From the body's front matter.
    suggested_theme: str | None = None
    suggest_when: str | None = None
    # O1f: the brief layer's section ids (front matter ``brief``, else the sections
    # before a ``Full version {#full}`` heading); every other section is detail.
    brief_sections: list[str] = []
    # Non-blocking findings, e.g. no_brief_sections.
    warnings: list[Problem] = []


class TemplateSummary(BaseModel):
    id: uuid.UUID
    key: str
    name: str
    kind: TemplateKind
    description: str | None
    builtin: bool
    archived_at: datetime | None
    created_at: datetime
    latest_version: int
    suggested_theme: str | None
    suggest_when: str | None


class TemplateOut(TemplateSummary):
    versions: list[TemplateVersionOut]


class TemplateCreate(BaseModel):
    key: str = Field(pattern=KEY_PATTERN)
    name: str = Field(min_length=1, max_length=200)
    kind: TemplateKind
    description: str | None = Field(default=None, max_length=2000)
    body: str = Field(min_length=1, max_length=200_000)
    # Defaults to the body's level 1-2 section ids.
    required_sections: list[str] | None = None


class TemplateUpdate(BaseModel):
    """Name and description change in place; a new body (or required sections) adds an
    immutable version."""

    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    body: str | None = Field(default=None, min_length=1, max_length=200_000)
    required_sections: list[str] | None = None


class TemplateValidateIn(BaseModel):
    body: str = Field(max_length=200_000)
    required_sections: list[str] | None = None


class TemplateValidateOut(BaseModel):
    valid: bool
    problems: list[Problem]
    # Reported without blocking the save: no_brief_sections (O1f).
    warnings: list[Problem] = []
    brief_sections: list[str] = []
    section_keys: list[str]
    suggested_theme: str | None
    suggest_when: str | None


# --- themes -------------------------------------------------------------------------


class ThemeFonts(BaseModel):
    body: str | None = None
    heading: str | None = None
    mono: str | None = None


class ThemeSpacing(BaseModel):
    base_size_pt: float | None = None
    line_height: float | None = None
    page_margin_mm: float | None = None
    section_gap_rem: float | None = None


class ThemePage(BaseModel):
    size: Literal["A4", "Letter"] = "A4"
    orientation: Literal["portrait", "landscape"] = "portrait"


class ThemeFeatures(BaseModel):
    toc: bool = False
    status_header: bool = True
    # "one_page": the PDF export checks the document fits one page.
    page_fit: Literal["one_page"] | None = None
    numbered_headings: bool = False
    legend: bool = False
    appendix_break: bool = False


class ThemeTokens(BaseModel):
    fonts: ThemeFonts = Field(default_factory=ThemeFonts)
    # Hex colours: text, heading, muted, accent, background, rule, surface, ...
    colors: dict[str, str] = Field(default_factory=dict)
    spacing: ThemeSpacing = Field(default_factory=ThemeSpacing)
    page: ThemePage = Field(default_factory=ThemePage)
    features: ThemeFeatures = Field(default_factory=ThemeFeatures)


class ThemeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    key: str
    name: str
    kind: ThemeKind
    description: str | None
    tokens: ThemeTokens
    css: str
    builtin: bool
    archived_at: datetime | None
    created_at: datetime
    updated_at: datetime


class ThemeCreate(BaseModel):
    key: str = Field(pattern=KEY_PATTERN)
    name: str = Field(min_length=1, max_length=200)
    kind: ThemeKind = "any"
    description: str | None = Field(default=None, max_length=2000)
    tokens: ThemeTokens = Field(default_factory=ThemeTokens)
    css: str = Field(default="", max_length=100_000)


class ThemeUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    kind: ThemeKind | None = None
    description: str | None = Field(default=None, max_length=2000)
    tokens: ThemeTokens | None = None
    css: str | None = Field(default=None, max_length=100_000)


class ThemeValidateIn(BaseModel):
    tokens: ThemeTokens
    css: str = Field(default="", max_length=100_000)


class ThemeValidateOut(BaseModel):
    valid: bool
    problems: list[Problem]


class ThemePreviewIn(ThemeValidateIn):
    kind: TemplateKind = "prd"


# --- new-draft picker ---------------------------------------------------------------


class PrdAnswers(BaseModel):
    """At most four questions (docs/research/prd-formats.md, template picker)."""

    decision: (
        Literal[
            "start_or_not", "commit_build", "bet_fixed_time", "choose_between", "technical_design"
        ]
        | None
    ) = None
    size: Literal["small_change", "new_feature", "new_product"] | None = None
    readers: Literal["founder", "product_eng", "leadership", "engineers_or_agents"] | None = None
    model_driven: bool | None = None


class RoadmapAnswers(BaseModel):
    """docs/research/roadmap-formats.md, questions the template picker should ask."""

    audience: Literal["board", "team", "engineering", "public"] | None = None
    external_dates: bool | None = None
    horizon: Literal["one_cycle", "one_two_quarters", "up_to_two_years"] | None = None
    planning_style: Literal["cycles", "sprints", "continuous"] | None = None
    tracker_connected: bool | None = None
    # None: counted from the baseline (confirmed goal entities).
    confirmed_goals: int | None = Field(default=None, ge=0)
    teams: int | None = Field(default=None, ge=0)
    show_capacity: bool | None = None
    public_version: bool | None = None


class RecommendIn(BaseModel):
    kind: TemplateKind
    prd: PrdAnswers | None = None
    roadmap: RoadmapAnswers | None = None


class Choice(BaseModel):
    template: str
    theme: str | None = None


class DraftDefaults(BaseModel):
    """Company default per document kind (tenant setting ``draft_defaults``)."""

    prd: Choice | None = None
    roadmap: Choice | None = None


class TemplateOption(BaseModel):
    key: str
    name: str
    description: str | None
    latest_version: int
    suggested_theme: str | None
    suggest_when: str | None
    builtin: bool


class ThemeOption(BaseModel):
    key: str
    name: str
    description: str | None
    kind: ThemeKind


class Recommendation(BaseModel):
    kind: TemplateKind
    template: TemplateOption
    reason: str
    theme: ThemeOption | None
    theme_reason: str
    # Roadmaps: audience variant (board / team / engineering / public) and layout options.
    variant: str | None = None
    group_by: str | None = None
    show_capacity: bool | None = None
    warnings: list[str]
    confirmed_goals: int | None = None
    company_default: Choice | None = None
    # Every live template of this kind, to override the recommendation.
    templates: list[TemplateOption]
    themes: list[ThemeOption]


class StartDraftIn(BaseModel):
    kind: TemplateKind
    title: str = Field(min_length=1, max_length=300)
    # Defaults to a slug of the title, made unique.
    slug: str | None = Field(default=None, pattern=KEY_PATTERN)
    template: str
    # Defaults to the template's latest version.
    template_version: int | None = Field(default=None, ge=1)
    # Defaults to the template version's suggested theme.
    theme: str | None = None


class StartDraftOut(BaseModel):
    document_id: uuid.UUID
    slug: str
    title: str
    kind: TemplateKind
    template: str
    template_version: int
    theme: str | None
    version: int
