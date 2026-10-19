"""Seeding built-in modules and manifests, company overrides, the company policy.

§16 item 2: an existing company-edited or archived template and theme are untouched by
built-in module upgrades.
"""

from datetime import UTC, datetime
from unittest.mock import patch

import pytest
from sqlalchemy import func, select

from oracle.modules import catalog as catalog_mod
from oracle.modules import registry
from oracle.modules.catalog import builtin_contracts, builtin_manifests
from oracle.modules.registry import ModulePolicySettings, RegistryError
from oracle.modules.service import ensure_seeded
from oracle.templates.models import Template, TemplateVersion, Theme
from oracle.v2.contract import validate_contract
from oracle.v2.models import ModuleDefinition, ModuleVersion, TemplateModuleAssignment


async def _counts(db):
    return (
        await db.scalar(select(func.count()).select_from(ModuleDefinition)),
        await db.scalar(select(func.count()).select_from(ModuleVersion)),
        await db.scalar(select(func.count()).select_from(TemplateModuleAssignment)),
    )


def _bumped(key: str, version: str, **changes):
    """The packaged catalogue with ``key`` released again as ``version``."""
    contracts = dict(builtin_contracts())
    data = contracts[key].model_dump(mode="json")
    data.update(version=version, **changes)
    contracts[key] = validate_contract(data)
    return patch.object(catalog_mod, "builtin_contracts", lambda: contracts), patch.object(
        registry, "builtin_contracts", lambda: contracts
    )


async def test_seeding_is_idempotent_and_complete(db):
    await ensure_seeded(db)
    await db.commit()
    first = await _counts(db)
    assert first[0] == first[1] == len(builtin_contracts())
    assert first[2] == sum(len(m.modules) for m in builtin_manifests().values())
    assert await registry.ensure_builtin_modules(db) is False
    assert await _counts(db) == first
    catalog = await registry.load_catalog(db)
    assert {e.origin for e in catalog.entries.values()} == {"builtin"}


async def test_manifest_policy_follows_the_template_spine(db):
    await ensure_seeded(db)
    t = await db.scalar(select(Template).where(Template.key == "prd-rfc"))
    rows = await registry.read_manifest(db, t.id)
    assert rows["solution.alternatives"].policy == "optional"  # level-3 "Alternatives"
    assert rows["risks.register"].policy == "required"  # level-2 "Top risks"
    assert rows["sources.data-points"].section_ids[0] == "sources"


async def test_a_new_builtin_release_reaches_untouched_modules(db):
    await ensure_seeded(db)
    await db.commit()
    p1, p2 = _bumped("risks.register", "1.1.0", title="Risks and mitigations")
    with p1, p2:
        assert await registry.ensure_builtin_modules(db) is True
        await db.commit()
        entry = (await registry.load_catalog(db)).entries["risks.register"]
        assert [v.version for v in entry.versions] == ["1.0.0", "1.1.0"]
        assert entry.definition.title == "Risks and mitigations"
        assert entry.upgrade_available is None


async def test_a_company_override_is_never_overwritten_by_an_upgrade(db):
    await ensure_seeded(db)
    data = builtin_contracts()["risks.register"].model_dump(mode="json")
    data.update(version="1.0.1", instructions="Our own risk rubric.")
    row = await registry.create_override(db, "risks.register", data, None)
    await db.commit()
    p1, p2 = _bumped("risks.register", "1.1.0")
    with p1, p2:
        await registry.ensure_builtin_modules(db)
        await db.commit()
        entry = (await registry.load_catalog(db)).entries["risks.register"]
        assert [v.version for v in entry.versions] == ["1.0.0", "1.0.1"]
        assert entry.effective.id == row.id and entry.origin == "company"
        assert entry.contract.instructions == "Our own risk rubric."
        assert entry.upgrade_available == "1.1.0"


async def test_an_archived_module_is_not_upgraded(db):
    await ensure_seeded(db)
    d = await db.scalar(select(ModuleDefinition).where(ModuleDefinition.key == "risks.register"))
    d.archived_at = datetime.now(UTC)
    await db.commit()
    p1, p2 = _bumped("risks.register", "1.1.0")
    with p1, p2:
        assert await registry.ensure_builtin_modules(db) is False
    entry = (await registry.load_catalog(db)).entries["risks.register"]
    assert [v.version for v in entry.versions] == ["1.0.0"]
    assert "risks.register" not in (await registry.load_catalog(db)).available()


async def test_edited_and_archived_templates_and_themes_are_untouched(db):
    """§16.2, also AUD-3: manifests never write a template or template version."""
    from oracle.templates.builtins import ensure_builtins

    await ensure_builtins(db)
    await db.flush()
    one = await db.scalar(select(Template).where(Template.key == "one-pager"))
    db.add(
        TemplateVersion(template_id=one.id, version=2, body="# Ours {#ours}\n", created_by=one.id)
    )
    memo = await db.scalar(select(Template).where(Template.key == "narrative-memo"))
    memo.archived_at = datetime.now(UTC)
    theme = await db.scalar(select(Theme).where(Theme.key == "clean-document"))
    theme.css = "/* company edit */"
    await db.commit()
    before_templates = [
        (t.key, t.name, t.archived_at, t.builtin)
        for t in (await db.scalars(select(Template).order_by(Template.key))).all()
    ]
    before_versions = [
        (v.template_id, v.version, v.body, v.created_by)
        for v in (await db.scalars(select(TemplateVersion).order_by(TemplateVersion.id))).all()
    ]
    before_themes = [(t.key, t.css, t.tokens) for t in (await db.scalars(select(Theme))).all()]

    await ensure_seeded(db)
    await db.commit()
    p1, p2 = _bumped("risks.register", "1.1.0")
    with p1, p2:
        await ensure_seeded(db)
        await db.commit()

    after_templates = [
        (t.key, t.name, t.archived_at, t.builtin)
        for t in (await db.scalars(select(Template).order_by(Template.key))).all()
    ]
    after_versions = [
        (v.template_id, v.version, v.body, v.created_by)
        for v in (await db.scalars(select(TemplateVersion).order_by(TemplateVersion.id))).all()
    ]
    assert after_templates == before_templates
    assert after_versions == before_versions
    assert [(t.key, t.css, t.tokens) for t in (await db.scalars(select(Theme))).all()] == (
        before_themes
    )
    # The archived template gets no manifest; the edited one keeps the sidecar only.
    assert not await registry.read_manifest(db, memo.id)
    assert await registry.read_manifest(db, one.id)


async def test_a_company_edited_manifest_is_never_replaced(db):
    await ensure_seeded(db)
    t = await db.scalar(select(Template).where(Template.key == "one-pager"))
    await registry.write_manifest(
        db,
        t,
        [{"module_key": "risks.register", "section_ids": ["top-risks"], "policy": "optional"}],
        t.id,
    )
    await db.commit()
    await ensure_seeded(db)
    await db.commit()
    rows = await registry.read_manifest(db, t.id)
    assert list(rows) == ["risks.register"] and rows["risks.register"].policy == "optional"


async def test_overrides_and_company_modules_are_validated(db):
    await ensure_seeded(db)
    data = builtin_contracts()["risks.register"].model_dump(mode="json")
    with pytest.raises(RegistryError) as e:
        await registry.create_override(db, "risks.register", data, None)  # same version
    assert e.value.code == "version_not_newer"
    with pytest.raises(RegistryError) as e:
        await registry.create_override(db, "risks.register", {**data, "id": "x.y"}, None)
    assert e.value.code == "key_mismatch"
    with pytest.raises(RegistryError) as e:
        await registry.create_module(db, {**data, "id": "risks.register"}, None)
    assert e.value.code == "key_taken"
    with pytest.raises(RegistryError) as e:
        await registry.create_module(
            db, {"id": "a.b", "version": "1.0.0", "title": "A", "policy": "optional",
                 "depends_on": ["no.such"]}, None,
        )  # fmt: skip
    assert e.value.code == "unknown_module"
    with pytest.raises(RegistryError) as e:
        await registry.create_module(db, {"id": "a.b", "version": "1", "title": "A"}, None)
    assert e.value.code == "invalid_contract"


async def test_company_policy_is_checked(db):
    await ensure_seeded(db)
    with pytest.raises(RegistryError) as e:
        await registry.write_policy(
            db, ModulePolicySettings(required=["risks.register"], optional=["risks.register"]), None
        )
    assert e.value.code == "policy_overlap"
    with pytest.raises(RegistryError) as e:
        await registry.write_policy(db, ModulePolicySettings(required=["no.such"]), None)
    assert e.value.code == "unknown_module"
    with pytest.raises(RegistryError) as e:
        await registry.write_policy(db, ModulePolicySettings(default_packs=["no.pack"]), None)
    assert e.value.code == "unknown_pack"
    await registry.write_policy(
        db, ModulePolicySettings(required=["platform.tenant-isolation"]), None
    )
    policy, row = await registry.read_policy(db)
    assert row is not None and policy.required == ["platform.tenant-isolation"]
