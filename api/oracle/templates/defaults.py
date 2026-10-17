"""The built-in PRD template, ``oracle-default`` v1, seeded into every tenant.

Migration 0002 seeds the tenants that existed before it with a frozen copy of this
body; ``oracle.seed`` seeds new ones. A version is immutable: change the skeleton by
adding version 2, never by editing this one.
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.templates.models import Template, TemplateVersion

DEFAULT_TEMPLATE_KEY = "oracle-default"
DEFAULT_TEMPLATE_NAME = "Oracle default PRD"
DEFAULT_TEMPLATE_BODY = """\
# {Feature or product name} PRD {#title}

Owner, status and the source snapshot this draft was written from.

## 1. Goal trace {#goal-trace}

Which confirmed company goal(s) this serves and how much, with citations. A PRD that
serves no confirmed goal says so here.

## 2. Problem {#problem}

The problem in the user's words, how often it happens and what it costs, with evidence.

## 3. Users {#users}

Who has the problem, in which situation, and who is out of scope.

## 4. Solution {#solution}

The proposed features in priority order, each with user stories and acceptance
criteria; dependencies between them.

## 5. Success metrics {#metrics}

The measures that show the goal moved: baseline, target and horizon.

## 6. Risks {#risks}

What could make this fail or harm another goal, and the mitigation for each.

## 7. Open questions {#open-questions}

Decisions still needed, each with an owner.
"""
DEFAULT_REQUIRED_SECTIONS = ["title", "goal-trace", "problem", "solution", "metrics"]


async def ensure_default_template(session: AsyncSession) -> Template:
    """Create ``oracle-default`` v1 in the session's tenant unless it exists (no commit)."""
    template = await session.scalar(select(Template).where(Template.key == DEFAULT_TEMPLATE_KEY))
    if template is not None:
        return template
    template = Template(key=DEFAULT_TEMPLATE_KEY, name=DEFAULT_TEMPLATE_NAME)
    session.add(template)
    await session.flush()
    session.add(
        TemplateVersion(
            template_id=template.id,
            version=1,
            body=DEFAULT_TEMPLATE_BODY,
            required_sections=DEFAULT_REQUIRED_SECTIONS,
        )
    )
    await session.flush()
    return template
