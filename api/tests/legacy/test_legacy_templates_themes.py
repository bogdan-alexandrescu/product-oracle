"""A built-in upgrade (a new packaged skeleton or theme) never touches a template or
theme the company edited, archived or wrote itself, and documents keep resolving the
template version they were imported with (build prompt §1, §14, §16.2; O1d, O1g)."""

import dataclasses

from sqlalchemy import select

from oracle.templates import builtins
from oracle.templates.builtins import ensure_builtins
from oracle.templates.models import Template, TemplateVersion, Theme
from oracle.tenancy import tenant_session
from tests.legacy.helpers import fixture, import_md, role_token

COMPANY_TEMPLATE = """---
title: Company launch brief
---

# Launch brief {#title}

## Summary {#summary}

## Problem {#problem}

# Full version {#full}

## Detail {#detail}

## Sources and data points {#sources}
"""
COMPANY_THEME = {
    "key": "company-brand",
    "name": "Company brand",
    "kind": "prd",
    "css": "h2 { color: #123456; }",
}


async def _templates(tenant_id) -> dict[str, tuple]:
    async with tenant_session(tenant_id) as s:
        rows = (await s.scalars(select(Template))).all()
        versions = (await s.scalars(select(TemplateVersion))).all()
        by_template: dict = {}
        for v in versions:
            by_template.setdefault(v.template_id, []).append(
                (v.version, v.body, tuple(v.required_sections), v.created_by)
            )
        return {
            t.key: (
                t.name,
                t.description,
                t.builtin,
                t.archived_at,
                sorted(by_template.get(t.id, [])),
            )
            for t in rows
        }


async def _themes(tenant_id) -> dict[str, tuple]:
    async with tenant_session(tenant_id) as s:
        return {
            t.key: (
                t.name,
                t.kind,
                t.description,
                t.tokens,
                t.css,
                t.slide_css,
                t.builtin,
                t.archived_at,
                t.created_by,
            )
            for t in await s.scalars(select(Theme))
        }


async def test_template_upgrade_skips_edited_archived_and_company_templates(
    client, tenant_id, monkeypatch
):
    h = {"Authorization": f"Bearer {await role_token(tenant_id, 'approver')}"}
    assert (await client.get("/v1/templates", headers=h)).status_code == 200
    # Edited built-in: a user's body becomes its latest version.
    body = (await client.get("/v1/templates/one-pager", headers=h)).json()["versions"][-1]["body"]
    edited = body.replace("{#problem}", "{#problem}\n\nCompany wording.", 1)
    assert edited != body
    resp = await client.patch("/v1/templates/one-pager", json={"body": edited}, headers=h)
    assert resp.status_code == 200, resp.text
    # Archived built-in, and a template the company wrote.
    assert (await client.delete("/v1/templates/pr-faq", headers=h)).status_code == 200
    created = await client.post(
        "/v1/templates",
        json={
            "key": "launch-brief",
            "name": "Launch brief",
            "kind": "prd",
            "body": COMPANY_TEMPLATE,
        },
        headers=h,
    )
    assert created.status_code == 201, created.text
    before = await _templates(tenant_id)

    # A new release ships a changed skeleton for every built-in.
    packaged = builtins.builtin_body
    monkeypatch.setattr(
        builtins, "builtin_body", lambda t: packaged(t) + "\n<!-- packaged upgrade -->\n"
    )
    async with tenant_session(tenant_id) as s:
        assert await ensure_builtins(s) is True
        await s.commit()
    after = await _templates(tenant_id)

    untouched = {"one-pager", "pr-faq", "launch-brief"}
    for key in untouched:
        assert after[key] == before[key], key
    upgraded = {
        key
        for key in after
        if len(after[key][4]) == len(before[key][4]) + 1
        and after[key][4][-1][1].endswith("<!-- packaged upgrade -->\n")
        and after[key][4][:-1] == before[key][4]
    }
    builtin_keys = {t.key for t in builtins.BUILTIN_TEMPLATES}
    assert len(builtin_keys) == 12
    assert upgraded == builtin_keys - untouched
    # Seven PRD and five roadmap built-ins, still all there.
    kinds = {t.key: t.kind for t in builtins.BUILTIN_TEMPLATES}
    assert sorted(kinds.values()).count("prd") == 7 and list(kinds.values()).count("roadmap") == 5


async def test_theme_upgrade_never_rewrites_existing_themes(client, tenant_id, monkeypatch):
    h = {"Authorization": f"Bearer {await role_token(tenant_id, 'approver')}"}
    themes = (await client.get("/v1/themes", headers=h)).json()
    assert len([t for t in themes if t["builtin"]]) == 6
    resp = await client.patch(
        "/v1/themes/clean-document", json={"css": "h1 { color: #0a0a0a; }"}, headers=h
    )
    assert resp.status_code == 200, resp.text
    archived_key = next(t["key"] for t in themes if t["builtin"] and t["key"] != "clean-document")
    assert (await client.delete(f"/v1/themes/{archived_key}", headers=h)).status_code == 200
    assert (await client.post("/v1/themes", json=COMPANY_THEME, headers=h)).status_code == 201
    before = await _themes(tenant_id)

    # A new release changes every packaged theme's CSS and tokens.
    class Upgraded(builtins.BuiltinTheme):
        @property
        def css(self) -> str:
            return super().css + "\n/* upgrade */"

    changed = tuple(
        Upgraded(**{**dataclasses.asdict(t), "tokens": {**t.tokens, "v": 2}})
        for t in builtins.BUILTIN_THEMES
    )
    monkeypatch.setattr(builtins, "BUILTIN_THEMES", changed)
    async with tenant_session(tenant_id) as s:
        await ensure_builtins(s)
        await s.commit()
    assert await _themes(tenant_id) == before


async def test_documents_keep_resolving_their_template_after_edit_and_archive(client, tenant_id):
    owner = {"Authorization": f"Bearer {await role_token(tenant_id, 'owner')}"}
    assert (await client.get("/v1/templates", headers=owner)).status_code == 200
    resp = await import_md(client, owner, fixture("legacy_prd_v1.md"))
    assert resp.status_code == 201, resp.text
    # The draft names oracle-default v1; the company then edits and archives it.
    body = (await client.get("/v1/templates/oracle-default", headers=owner)).json()
    latest = body["versions"][-1]["body"]
    edit = latest.replace("{#problem}", "{#problem}\n\nCompany wording.", 1)
    resp = await client.patch("/v1/templates/oracle-default", json={"body": edit}, headers=owner)
    assert resp.status_code == 200, resp.text
    assert (await client.delete("/v1/templates/oracle-default", headers=owner)).status_code == 200
    v1 = await client.get("/v1/templates/oracle-default/versions/1", headers=owner)
    assert v1.status_code == 200
    html = await client.get(
        "/v1/documents/legacy-onboarding/versions/1/export?format=html", headers=owner
    )
    assert html.status_code == 200
    assert "Goal-traced PRD v1" in html.text
