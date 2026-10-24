"""A pricing memo's front matter and import checks (H9).

- ``question``: one sentence, at most 300 characters, else the draft is refused;
- ``options``: two to four ``{id, title, reversibility, recommended}``, unique ids, each
  with its ``{#option-<id>}`` section, at most one recommended; else refused naming the
  option;
- a run's draft (``level`` given: H11 ``pricing_input``) that recommends nothing at
  Recommend warns ``no_recommendation``; one that recommends at Draft warns
  ``recommended_at_draft``, and Decide ignores the flag (:func:`recommendation_ignored`);
- a price or a percentage in ``{#options}`` that no row of Sources and data points carries
  warns ``uncited_figure`` (the rule of ``oracle.updates.frontmatter``);
- an empty ``{#research-plan}`` warns ``no_research_plan``.

The template's skeleton (``template_only``) has no options yet: it is not refused.
"""

import re
from dataclasses import dataclass
from typing import Any

from oracle.docs import layers
from oracle.docs.parser import DraftError, ParsedSection
from oracle.docs.schemas import ImportProblem, VersionWarning
from oracle.updates.frontmatter import figures

QUESTION_MAX = 300
MIN_OPTIONS, MAX_OPTIONS = 2, 4
OPTIONS_KEY = "options"
RESEARCH_PLAN_KEY = "research-plan"
RECOMMENDATION_KEY = "recommendation"
REVERSIBILITY = ("reversible", "irreversible")
OPTION_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,59}$")
ASK_QUESTION = "Say the pricing question in one sentence"
ONE_RECOMMENDATION = "Recommend one option at most"
RECOMMENDED_AT_DRAFT = "recommended_at_draft"
# A price or a percentage as a reader sees it: $20, €1,200, 20 USD, 15%.
_PRICE = re.compile(
    r"[$€£]\s?\d[\d,]*(?:\.\d+)?[kKmM]?"
    r"|\d[\d,]*(?:\.\d+)?\s?(?:%|percent\b|USD\b|EUR\b|GBP\b|dollars?\b|euros?\b)"
)


@dataclass(frozen=True)
class Option:
    id: str
    title: str
    reversibility: str
    recommended: bool

    @property
    def section_key(self) -> str:
        return f"option-{self.id}"


def question_of(front_matter: dict[str, Any]) -> str | None:
    value = front_matter.get("question")
    return value.strip() if isinstance(value, str) and value.strip() else None


def options_of(front_matter: dict[str, Any]) -> list[Option]:
    """The front matter's options as written; malformed entries are left out (the import
    check refuses them first)."""
    out = []
    for raw in front_matter.get(OPTIONS_KEY) or []:
        if not isinstance(raw, dict):
            continue
        oid, title = raw.get("id"), raw.get("title")
        if not isinstance(oid, str) or not isinstance(title, str):
            continue
        reversibility = raw.get("reversibility")
        out.append(
            Option(
                id=oid.strip(),
                title=title.strip(),
                reversibility=reversibility if reversibility in REVERSIBILITY else "irreversible",
                recommended=raw.get("recommended") is True,
            )
        )
    return out


def recommendation_ignored(warnings: list[dict[str, Any]] | None) -> bool:
    """Whether a version's recommendation came from a run at Draft (Decide ignores it)."""
    return any(w.get("code") == RECOMMENDED_AT_DRAFT for w in warnings or [])


def _plain(text: str) -> str:
    return " ".join(layers.strip_comments(text or "").split())


def _problems(front_matter: dict[str, Any], keys: set[str]) -> list[ImportProblem]:
    problems: list[ImportProblem] = []
    question = front_matter.get("question")
    if not isinstance(question, str) or not question.strip() or len(question) > QUESTION_MAX:
        problems.append(
            ImportProblem(
                code="pricing_question",
                message=f"{ASK_QUESTION} (question: in the front matter, at most "
                f"{QUESTION_MAX} characters)",
            )
        )
    raw = front_matter.get(OPTIONS_KEY)
    if not isinstance(raw, list) or not MIN_OPTIONS <= len(raw) <= MAX_OPTIONS:
        count = len(raw) if isinstance(raw, list) else 0
        problems.append(
            ImportProblem(
                code="pricing_options",
                message=f"A pricing memo sets out {MIN_OPTIONS} to {MAX_OPTIONS} options; "
                f"this one has {count}",
            )
        )
        raw = raw if isinstance(raw, list) else []
    seen: set[str] = set()
    recommended = []
    for i, item in enumerate(raw, start=1):
        oid = item.get("id") if isinstance(item, dict) else None
        title = item.get("title") if isinstance(item, dict) else None
        if not isinstance(oid, str) or not OPTION_ID.match(oid.strip()):
            problems.append(
                ImportProblem(
                    code="pricing_option",
                    message=f"Option {i} needs an id of lowercase letters, digits and hyphens",
                )
            )
            continue
        oid = oid.strip()
        if not isinstance(title, str) or not title.strip():
            problems.append(
                ImportProblem(code="pricing_option", message=f"Option {oid} needs a title")
            )
        if item.get("reversibility") not in (None, *REVERSIBILITY):
            problems.append(
                ImportProblem(
                    code="pricing_option",
                    message=f"Option {oid}: reversibility is reversible or irreversible",
                )
            )
        if oid in seen:
            problems.append(
                ImportProblem(
                    code="pricing_option", message=f"Option {oid} is listed twice; ids are unique"
                )
            )
        seen.add(oid)
        if f"option-{oid}" not in keys:
            problems.append(
                ImportProblem(
                    code="pricing_option_section",
                    message=f"Option {oid} has no section: add ### <title> {{#option-{oid}}} "
                    "under Options",
                    section_key=f"option-{oid}",
                )
            )
        if item.get("recommended") is True:
            recommended.append(oid)
    if len(recommended) > 1:
        problems.append(
            ImportProblem(
                code="pricing_recommendation",
                message=f"{ONE_RECOMMENDATION} ({', '.join(recommended)} are recommended)",
            )
        )
    return problems


def check_import(
    front_matter: dict[str, Any],
    sections: list[ParsedSection],
    *,
    level: str | None,
    template_only: bool = False,
) -> list[VersionWarning]:
    """Refuse (DraftError) a pricing memo without one question or with malformed options;
    return its warnings otherwise. ``level``: H11 ``pricing_input`` for a run's draft,
    None for a person's."""
    keys = {s.section_key for s in sections}
    if template_only:
        return []
    problems = _problems(front_matter, keys)
    if problems:
        raise DraftError(problems)

    warnings: list[VersionWarning] = []
    recommended = [o for o in options_of(front_matter) if o.recommended]
    if level == "recommend" and not recommended:
        warnings.append(
            VersionWarning(
                code="no_recommendation",
                message="No option is recommended; at Recommend, Oracle recommends one",
                section_keys=[RECOMMENDATION_KEY],
            )
        )
    if level == "draft" and recommended:
        warnings.append(
            VersionWarning(
                code=RECOMMENDED_AT_DRAFT,
                message=f"Option {recommended[0].id} is marked recommended, but Oracle's "
                "pricing input is at Draft: Decide ignores the recommendation",
                section_keys=[RECOMMENDATION_KEY],
            )
        )
    refs = [layers.SectionRef(s.section_key, s.level) for s in sections]
    in_sources = set(layers.subtree(refs, layers.SOURCES_SECTION_ID))
    in_options = set(layers.subtree(refs, OPTIONS_KEY))
    cited = {f for s in sections if s.section_key in in_sources for f in figures(s.body_md)}
    for s in sections:
        if s.section_key not in in_options:
            continue
        body = layers.strip_comments(s.body_md or "")
        prices = [m.group(0).strip() for m in _PRICE.finditer(body)]
        missing = list(dict.fromkeys(p for p in prices if any(f not in cited for f in figures(p))))
        if missing:
            warnings.append(
                VersionWarning(
                    code="uncited_figure",
                    message=f"{s.section_key}: {', '.join(missing)} "
                    f"{'has' if len(missing) == 1 else 'have'} no data point row in Sources "
                    "and data points; every price and percentage cites",
                    section_keys=[s.section_key],
                )
            )
    plan = next((s for s in sections if s.section_key == RESEARCH_PLAN_KEY), None)
    if plan is None or not _plain(plan.body_md):
        warnings.append(
            VersionWarning(
                code="no_research_plan",
                message="The research plan is empty: say what we do not know and how to find out",
                section_keys=[RESEARCH_PLAN_KEY],
            )
        )
    return warnings
