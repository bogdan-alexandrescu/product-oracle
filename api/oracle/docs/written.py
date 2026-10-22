"""Whether a version holds anything written (#254).

A section is template-only when, without its guidance comments and presenter notes, it
is empty or still reads exactly as its template's section does (the placeholder table
rows and lines a template starts a draft with). A version whose sections are all
template-only has nothing written: it is never approved, published or built from. A
version without sections is not judged here.
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.docs import layers
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.docs.parser import DraftError, _parse_sections, split_front_matter

NOTHING_WRITTEN = "Nothing is written yet: every section still holds only the template's text"


def _plain(body_md: str) -> str:
    return " ".join(layers.slide_body(body_md).split())


async def _template_bodies(db: AsyncSession, document: Document) -> dict[str, str]:
    from oracle.templates.models import Template, TemplateVersion

    if not document.template or not (document.template_version or "").isdigit():
        return {}
    body = await db.scalar(
        select(TemplateVersion.body)
        .join(Template, Template.id == TemplateVersion.template_id)
        .where(
            Template.key == document.template,
            TemplateVersion.version == int(document.template_version or 0),
        )
    )
    if not body:
        return {}
    _, rest, offset = split_front_matter(body.replace("\r\n", "\n"))
    try:
        sections = _parse_sections(rest, offset, [])
    except DraftError:
        return {}
    return {s.section_key: _plain(s.body_md) for s in sections}


async def nothing_written(db: AsyncSession, document: Document, version: DocumentVersion) -> bool:
    """True when the version has sections and every one is template-only."""
    rows = list(
        await db.execute(
            select(Section.section_key, Section.body_md).where(Section.version_id == version.id)
        )
    )
    if not rows:
        return False
    template = await _template_bodies(db, document)
    return all(not (text := _plain(md)) or template.get(key) == text for key, md in rows)
