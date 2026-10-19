"""Review fixes on the composition routes, round 2 (PR #24 review).

MAJOR 1: one company failing to seed never stops the others; its id is logged and it is
seeded again by its next write and the next startup.
MAJOR 2: only explicitly chosen packs carry to the next revision; a default or a
category pack is recomputed, so a default_packs or category change applies.
MAJOR 3: re-sending a removal an earlier revision made is a no-op that refreshes the
reason and who decided, never a 422.
Minors: template and theme reads never seed; a decision set aside is a problem in the
confirm response.
"""

import logging

from sqlalchemy import func, select

from oracle.modules import registry, service
from oracle.modules.catalog import builtin_contracts
from oracle.templates.builtins import BUILTIN_TEMPLATES, BUILTIN_THEMES
from oracle.templates.models import Template, Theme
from oracle.tenancy import current_tenant, tenant_session
from oracle.v2.models import ModuleDefinition
from tests.baseline_helpers import make_ctx
from tests.modules.helpers import draft, import_md, seeded_ctx

SLUG = "placeholder-platform"
PLATFORM = {
    "category": "ai_agent_platform",
    "scope": {"capabilities": ["tool_use", "memory"]},
    "signals": {"tenant_count": 12},
}
MEMORY = "agents.knowledge-memory"


async def _doc(client, ctx, slug=SLUG):
    resp = await import_md(client, ctx.as_("approver"), slug, draft("oracle-default", slug))
    assert resp.status_code == 201, resp.text


async def _revise(client, ctx, base, reason, who="approver", **body):
    body = {"base_revision": base, "reason": reason, **body}
    return await client.post(
        f"/v1/documents/{SLUG}/composition/revisions", json=body, headers=ctx.as_(who)
    )


def _mods(inspector, part="current"):
    return {m["key"]: m for m in inspector[part]["modules"]}


async def _module_count(tenant_id) -> int:
    async with tenant_session(tenant_id) as s:
        return await s.scalar(select(func.count()).select_from(ModuleDefinition))


async def _policy(client, ctx, **body):
    resp = await client.put("/v1/module-policy", json=body, headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text


# --- MAJOR 1 ----------------------------------------------------------------------------


async def test_one_company_failing_to_seed_does_not_stop_the_others(client, monkeypatch, caplog):
    first, second, third = [await make_ctx(f"Placeholder Co {n}") for n in (1, 2, 3)]
    real = registry.ensure_builtin_modules

    async def failing_for_the_second(session):
        if current_tenant(session) == second.tenant_id:
            raise RuntimeError("could not obtain the advisory lock")
        return await real(session)

    monkeypatch.setattr(registry, "ensure_builtin_modules", failing_for_the_second)
    # Alembic's logging config (the migrations ran first) disables loggers it found.
    monkeypatch.setattr(logging.getLogger("oracle.modules.service"), "disabled", False)
    with caplog.at_level(logging.WARNING, logger="oracle.modules.service"):
        result = await service.seed_all_companies()  # never raises: the API still starts

    assert result.failed == [second.tenant_id]
    assert await _module_count(first.tenant_id) == len(builtin_contracts())
    assert await _module_count(third.tenant_id) == len(builtin_contracts())
    assert await _module_count(second.tenant_id) == 0
    logged = " ".join(r.getMessage() for r in caplog.records)
    assert str(second.tenant_id) in logged
    assert "Placeholder Co" not in logged  # ids only, never names

    # Its next write seeds it, as does the next startup.
    monkeypatch.setattr(registry, "ensure_builtin_modules", real)
    resp = await client.put(
        "/v1/module-policy", json={"default_packs": []}, headers=second.as_("owner")
    )
    assert resp.status_code == 200, resp.text
    assert await _module_count(second.tenant_id) == len(builtin_contracts())
    assert (await service.seed_all_companies()).failed == []


async def test_a_transient_seeding_failure_is_retried_in_the_same_startup(monkeypatch):
    ctx = await make_ctx()
    real = registry.ensure_builtin_modules
    calls: list[int] = []

    async def fails_once(session):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("duplicate key: another replica is seeding")
        return await real(session)

    monkeypatch.setattr(registry, "ensure_builtin_modules", fails_once)
    result = await service.seed_all_companies()
    assert result.failed == [] and result.changed == 1
    assert await _module_count(ctx.tenant_id) == len(builtin_contracts())


# --- MAJOR 2 ----------------------------------------------------------------------------


async def test_a_default_packs_change_applies_on_the_next_revision(client):
    ctx = await seeded_ctx()
    await _doc(client, ctx)
    first = await _revise(client, ctx, None, "First")
    assert first.status_code == 201, first.text
    assert first.json()["current"]["packs"] == ["startup.standard"]
    assert first.json()["current"]["inputs"]["policy"]["packs_source"] == "category"

    await _policy(client, ctx, default_packs=["saas.b2b"])
    second = await _revise(client, ctx, 1, "Apply the company default")
    assert second.status_code == 201, second.text
    current = second.json()["current"]
    assert current["packs"] == ["saas.b2b"]
    assert current["inputs"]["policy"]["packs_source"] == "default"
    assert any(k.startswith("saas.") and m["included"] for k, m in _mods(second.json()).items())


async def test_a_category_change_applies_on_the_next_revision(client):
    ctx = await seeded_ctx()
    await _doc(client, ctx)
    first = await _revise(client, ctx, None, "First", inputs={"category": "fintech"})
    assert first.status_code == 201, first.text
    assert first.json()["current"]["packs"] == ["fintech.payments"]
    second = await _revise(client, ctx, 1, "It is B2B SaaS", inputs={"category": "saas"})
    assert second.status_code == 201, second.text
    assert second.json()["current"]["packs"] == ["saas.b2b"]


async def test_an_explicitly_chosen_pack_survives_a_default_packs_change(client):
    ctx = await seeded_ctx()
    await _doc(client, ctx)
    first = await _revise(client, ctx, None, "First", inputs=PLATFORM, packs=["ai-agent.platform"])
    assert first.status_code == 201, first.text
    assert first.json()["current"]["inputs"]["policy"]["packs_source"] == "chosen"

    await _policy(client, ctx, default_packs=["saas.b2b"])
    second = await _revise(client, ctx, 1, "Re-confirm")
    assert second.status_code == 201, second.text
    current = second.json()["current"]
    assert current["packs"] == ["ai-agent.platform"]
    assert current["inputs"]["policy"]["packs_source"] == "chosen"
    # A third revision keeps it too: the choice carries, not just the first time.
    third = await _revise(client, ctx, 2, "Again", inputs={"category": "saas"})
    assert third.status_code == 201, third.text
    assert third.json()["current"]["packs"] == ["ai-agent.platform"]


# --- MAJOR 3 ----------------------------------------------------------------------------


async def test_resending_an_earlier_removal_refreshes_its_reason(client):
    ctx = await seeded_ctx()
    await _doc(client, ctx)
    resp = await _revise(client, ctx, None, "First", inputs=PLATFORM, packs=["ai-agent.platform"])
    assert resp.status_code == 201, resp.text
    resp = await _revise(client, ctx, 1, "Memory is a later PRD", changes={"remove": [MEMORY]})
    assert resp.status_code == 201, resp.text

    resp = await _revise(
        client, ctx, 2, "Memory moves to the Q3 PRD", who="owner", changes={"remove": [MEMORY]}
    )
    assert resp.status_code == 201, resp.text
    memory = _mods(resp.json())[MEMORY]
    assert not memory["included"] and memory["decided_by"] == "user"
    assert memory["user_reason"] == "Memory moves to the Q3 PRD"
    assert memory["overridden_by"] == str(ctx.users["owner"].id)
    assert resp.json()["current"]["diff"]["removed"] == []

    # A module never in the composition is still refused.
    resp = await _revise(client, ctx, 3, "Nope", changes={"remove": ["no.such-module"]})
    assert resp.status_code == 422
    assert resp.json()["problems"][0]["code"] == "not_included"


# --- minors -----------------------------------------------------------------------------


async def test_template_and_theme_reads_never_seed(client):
    ctx = await make_ctx()  # not seeded, as before startup or company creation seeds it
    viewer = ctx.as_("viewer")

    async def counts():
        async with tenant_session(ctx.tenant_id) as s:
            return (
                await s.scalar(select(func.count()).select_from(Template)),
                await s.scalar(select(func.count()).select_from(Theme)),
            )

    before = await counts()
    for path in (
        "/v1/templates",
        "/v1/templates?kind=prd",
        "/v1/templates/oracle-default",
        "/v1/templates/oracle-default/versions/1",
        "/v1/themes",
        "/v1/themes/clean-document",
    ):
        resp = await client.get(path, headers=viewer)
        assert resp.status_code in (200, 404), (path, resp.text)
    assert await counts() == before

    # Startup seeds every company; then reads see every built-in.
    await service.seed_all_companies()
    listed = (await client.get("/v1/templates", headers=viewer)).json()
    assert {t["key"] for t in listed} == {t.key for t in BUILTIN_TEMPLATES}
    themes = (await client.get("/v1/themes", headers=viewer)).json()
    assert {t["key"] for t in themes} == {t.key for t in BUILTIN_THEMES}


async def test_a_template_write_seeds_the_builtins(client):
    ctx = await make_ctx()
    resp = await client.patch(
        "/v1/templates/oracle-default", json={"name": "Our PRD"}, headers=ctx.as_("owner")
    )
    assert resp.status_code == 200, resp.text
    listed = (await client.get("/v1/templates", headers=ctx.as_("viewer"))).json()
    assert {t["key"] for t in listed} == {t.key for t in BUILTIN_TEMPLATES}


async def test_a_decision_set_aside_is_a_problem_in_the_confirm_response(client):
    ctx = await seeded_ctx()
    await _doc(client, ctx)
    resp = await _revise(client, ctx, None, "First", inputs=PLATFORM, packs=["ai-agent.platform"])
    assert resp.status_code == 201, resp.text
    assert resp.json()["problems"] == []
    resp = await _revise(client, ctx, 1, "Memory is a later PRD", changes={"remove": [MEMORY]})
    assert resp.status_code == 201, resp.text

    await _policy(client, ctx, required=[MEMORY])
    resp = await _revise(client, ctx, 2, "Apply the new policy")
    assert resp.status_code == 201, resp.text
    out = resp.json()
    assert _mods(out)[MEMORY]["included"]
    problems = [p for p in out["problems"] if p["module"] == MEMORY]
    assert [(p["code"], p["fatal"]) for p in problems] == [("decision_superseded", False)]
    assert "Memory is a later PRD" in problems[0]["message"]
    # Reads carry no confirm problems.
    read = await client.get(f"/v1/documents/{SLUG}/composition", headers=ctx.as_("viewer"))
    assert read.json()["problems"] == []
