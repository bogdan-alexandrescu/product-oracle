"""Shared setup for the module and composition tests. Synthetic placeholders only."""

from oracle.modules.catalog import builtin_contracts, builtin_manifests, builtin_packs
from oracle.modules.composer import Context, ManifestEntry, TemplateSection
from oracle.templates.builtins import BUILTIN_TEMPLATES_BY_KEY, builtin_body
from oracle.templates.service import draft_skeleton
from oracle.templates.validation import check_template

MARKDOWN = {"Content-Type": "text/markdown"}


def template_sections(body: str) -> list[TemplateSection]:
    check = check_template(body)
    brief = set(check.brief_sections)
    return [
        TemplateSection(h.key, h.level, h.text, h.key in brief) for h in check.headings if h.key
    ]


def builtin_manifest(template: str) -> dict[str, ManifestEntry]:
    body = builtin_body(BUILTIN_TEMPLATES_BY_KEY[template])
    spine = set(check_template(body).default_required_sections())
    return {
        key: ManifestEntry(sections, "required" if spine & set(sections) else "optional")
        for key, sections in builtin_manifests()[template].modules.items()
    }


def context(
    pack: str = "startup.standard", template: str | None = "oracle-default", **kwargs
) -> Context:
    """A pure composer context over the packaged catalogue."""
    contracts = dict(kwargs.pop("contracts", builtin_contracts()))
    packs = kwargs.pop("packs", {pack: builtin_packs()[pack].modules} if pack else {})
    sections = (
        template_sections(builtin_body(BUILTIN_TEMPLATES_BY_KEY[template])) if template else []
    )
    manifest = builtin_manifest(template) if template else {}
    return Context(
        contracts=contracts,
        packs=packs,
        template_key=template,
        template_version="1" if template else None,
        template_sections=sections,
        manifest=manifest,
        **kwargs,
    )


def draft(template: str, slug: str, title: str = "Placeholder PRD") -> str:
    """A first draft of a built-in template, as the picker would start it."""
    body = builtin_body(BUILTIN_TEMPLATES_BY_KEY[template])
    return draft_skeleton(
        body, slug=slug, title=title, kind="prd", template=template, version=1, theme=None
    )


async def import_md(client, headers, slug: str, text: str):
    return await client.post(
        f"/v1/documents/{slug}/versions", content=text.encode(), headers={**headers, **MARKDOWN}
    )


async def seeded_ctx(name: str = "Example Co"):
    """A company with its built-in templates, modules and manifests seeded, as startup
    and company creation leave it (reads never seed)."""
    from oracle.modules.service import ensure_seeded
    from oracle.tenancy import tenant_session
    from tests.baseline_helpers import make_ctx

    ctx = await make_ctx(name)
    async with tenant_session(ctx.tenant_id) as s:
        await ensure_seeded(s)
        await s.commit()
    return ctx
