"""A sample PRD or roadmap rendered with a theme that may not be saved yet.

Used by Settings > Themes for the live preview and the picker's theme thumbnails.
Nothing touches the database: the sample is parsed and wrapped in transient rows.
Tokens or CSS that fail the safety checks are left out of the preview (contrast
problems are kept, so the editor can see them).
"""

import uuid
from datetime import UTC, datetime

from oracle.docs.models import Citation, Document, DocumentVersion, Section
from oracle.docs.parser import parse_draft
from oracle.export.render import ExportVersion, render_themed_html
from oracle.templates import validation
from oracle.templates.models import Theme
from oracle.templates.schemas import ThemeTokens

SAMPLE_PRD = """---
document: sample-prd
title: Saved carts PRD
citations:
  - id: c1
    source: upload
    ref: https://example.com/interviews
    title: Customer interview notes
  - id: c2
    source: github
    ref: https://github.com/example/shop/issues/12
    title: Cart expiry issue
---

# Saved carts PRD {#title}

## 1. Summary {#summary}

Returning buyers lose their cart after a day. We will keep carts for 30 days so
they can finish a purchase later. This serves the activation goal.

## 2. Goal trace {#goal-trace}

- **G1 Activation** (this quarter): high contribution.

## 3. Requirements {#requirements}

| Id | Requirement | Eval |
|----|-------------|------|
| R1 | Carts persist for 30 days | Pass |
| R2 | Prices refresh on return | Fail |

- R3 A returning buyer sees a "welcome back" banner.

## Sources and data points {#sources}

### Sources {#sources-list}

- c1 upload: Customer interview notes [c:c1]
- c2 github: Cart expiry issue [c:c2]

### Evidence by section {#sources-evidence}

- summary: c1, c2
"""

SAMPLE_ROADMAP = """---
document: sample-roadmap
title: Product roadmap
---

# Product roadmap {#roadmap}

## Now {#now}

### Saved carts {#now-saved-carts}

Returning buyers keep their cart. G1 · ●●● high · after: cart service

### Faster checkout {#now-checkout}

Fewer steps to pay. G1 · ●●○ medium

### Theme refresh {#now-theme}

New colours for the storefront; serves no confirmed goal.

## Next {#next}

### Bulk ordering {#next-bulk}

Business buyers order many items at once. G2 · ●●○ medium

## Later {#later}

### Marketplace {#later-marketplace}

Third-party sellers. G3 · ●○○ low

## Sources and data points {#sources}

Goals and estimates come from the baseline.
"""


def _safe_tokens(tokens: ThemeTokens) -> dict:
    raw = tokens.model_dump(exclude_none=True)
    problems = [p for p in validation.check_theme_tokens(raw) if p.code != "insufficient_contrast"]
    if not problems:
        return raw
    bad = {p.message.split(" ", 1)[0] for p in problems}
    for group in ("colors", "fonts"):
        for name in list(raw.get(group, {})):
            if f"{group}.{name}" in bad:
                del raw[group][name]
    return raw


def render_preview(tokens: ThemeTokens, css: str, kind: str = "prd") -> str:
    draft = parse_draft(SAMPLE_ROADMAP if kind == "roadmap" else SAMPLE_PRD)
    now = datetime.now(UTC)
    document = Document(
        id=uuid.uuid4(),
        slug=draft.document or "sample",
        title=draft.title,
        status="in_review",
        kind=kind,
        template=None,
        created_at=now,
    )
    version = DocumentVersion(
        id=uuid.uuid4(), number=1, markdown=draft.markdown, created_at=now, snapshot=None
    )
    sections = [
        Section(
            section_key=s.section_key,
            ordinal=s.ordinal,
            level=s.level,
            heading=s.heading,
            body_md=s.body_md,
            body_text=s.body_text,
            citation_keys=s.citation_keys,
        )
        for s in draft.sections
    ]
    citations = [
        Citation(cite_key=c.id, source=c.source, ref=c.ref, title=c.title) for c in draft.citations
    ]
    safe_css = "" if validation.check_theme_css(css) else css
    theme = Theme(key="preview", name="Preview", tokens=_safe_tokens(tokens), css=safe_css)
    ev = ExportVersion(
        document=document,
        version=version,
        sections=sections,
        citations=citations,
        latest_number=1,
        theme=theme,
        theme_source="preview",
    )
    return render_themed_html(ev)
