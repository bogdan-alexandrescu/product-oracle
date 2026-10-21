"""H4 Strategy and vision, lane 2: the strategy stack in the graph. Approving a strategy
version writes its choices and their edges; a newer approved version without a choice
rejects it; approving a vision writes its beliefs; approving a roadmap after a strategy
records its items' dependencies on the choices.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

import pytest
from sqlalchemy import func, select

from oracle.baseline.models import Entity
from oracle.tenancy import tenant_session
from oracle.v2.models import ArtifactDependency, ChangeEvent
from tests.baseline_helpers import make_ctx
from tests.strategy_helpers import (
    STRATEGY,
    VISION,
    add_entity,
    approved,
    belief,
    choice,
    edges,
    entity,
    imported,
    roadmap_with_items,
    strategy_md,
    supports,
    vision_md,
)


@pytest.fixture
async def ctx():
    return await make_ctx()


async def _entity_events(tenant_id) -> int:
    async with tenant_session(tenant_id) as s:
        return await s.scalar(
            select(func.count()).select_from(ChangeEvent).where(ChangeEvent.subject_kind == "entity")
        )


async def test_approving_a_strategy_writes_its_choices_and_edges(client, ctx):
    """protects=acceptance 4, v1: 3 strategy_choice entities (confirmed, locked, by the
    approving owner), 2 derived_from edges goal -> focus choice and 1 affects edge stop
    choice -> feature; fails_when=a choice, edge or attr is missing, unconfirmed or
    unlocked; no_claim=what the choices mean."""
    t = ctx.tenant_id
    a = await add_entity(t, "goal", "a")
    b = await add_entity(t, "goal", "b")
    f = await add_entity(t, "feature", "f")
    md = strategy_md(
        [choice("one", goals=["a"]), choice("two", goals=["b"]),
         choice("sso", "stop", features=["f"])]
    )  # fmt: skip
    await imported(client, ctx.as_("owner"), STRATEGY, md)
    async with tenant_session(t) as s:
        assert await s.scalar(select(func.count()).select_from(Entity).where(
            Entity.type == "strategy_choice")) == 0  # fmt: skip
    await approved(client, ctx.as_("owner"), STRATEGY, 1)

    async with tenant_session(t) as s:
        choices = {
            c.key: c
            for c in await s.scalars(select(Entity).where(Entity.type == "strategy_choice"))
        }
    assert set(choices) == {f"{STRATEGY}-one", f"{STRATEGY}-two", f"{STRATEGY}-sso"}
    for c in choices.values():
        assert c.status == "confirmed" and c.locked and c.origin == "user"
        assert c.locked_by == ctx.users["owner"].id
    one = choices[f"{STRATEGY}-one"]
    assert one.attrs["stance"] == "focus" and one.attrs["version"] == 1
    assert one.attrs["section_key"] == "choice-one" and one.attrs["rank"] == 1
    assert choices[f"{STRATEGY}-sso"].attrs["stance"] == "stop"
    assert one.title == "One"

    derived = await edges(t, "derived_from")
    assert {(e.src_id, e.dst_id) for e in derived} == {
        (a, one.id),
        (b, choices[f"{STRATEGY}-two"].id),
    }
    assert all(e.status == "confirmed" for e in derived)
    affects = await edges(t, "affects")
    assert [(e.src_id, e.dst_id, e.status) for e in affects] == [
        (choices[f"{STRATEGY}-sso"].id, f, "confirmed")
    ]


async def test_a_newer_version_without_a_choice_rejects_it_in_one_change(client, ctx):
    """protects=acceptance 4, v2: the dropped stop choice and its affects edge become
    rejected and exactly one entity change event is recorded, while kept choices move to
    version 2; fails_when=the choice stays confirmed, its edge stays, or each write records
    its own event; no_claim=downstream staleness (next test)."""
    t = ctx.tenant_id
    await add_entity(t, "goal", "a")
    await add_entity(t, "goal", "b")
    await add_entity(t, "feature", "f")
    v1 = [choice("one", goals=["a"]), choice("two", goals=["b"]),
          choice("sso", "stop", features=["f"])]  # fmt: skip
    await imported(client, ctx.as_("owner"), STRATEGY, strategy_md(v1))
    await approved(client, ctx.as_("owner"), STRATEGY, 1)
    await imported(client, ctx.as_("owner"), STRATEGY, strategy_md(v1[:2]))
    before = await _entity_events(t)
    await approved(client, ctx.as_("owner"), STRATEGY, 2)

    sso = await entity(t, "strategy_choice", f"{STRATEGY}-sso")
    assert sso.status == "rejected"
    (affects,) = await edges(t, "affects")
    assert affects.status == "rejected"
    one = await entity(t, "strategy_choice", f"{STRATEGY}-one")
    assert one.status == "confirmed" and one.attrs["version"] == 2
    assert await _entity_events(t) == before + 1


async def test_a_choice_back_in_a_later_version_is_confirmed_again(client, ctx):
    """protects=a rejected choice that returns is confirmed again with its edges, not
    duplicated; fails_when=it stays rejected or a second entity is created;
    no_claim=history of the choice's text."""
    t = ctx.tenant_id
    await add_entity(t, "goal", "a")
    md_with = strategy_md([choice("one", goals=["a"]), choice("two", goals=["a"])])
    md_without = strategy_md([choice("one", goals=["a"])])
    for n, md in enumerate((md_with, md_without, md_with), start=1):
        await imported(client, ctx.as_("owner"), STRATEGY, md)
        await approved(client, ctx.as_("owner"), STRATEGY, n)
    two = await entity(t, "strategy_choice", f"{STRATEGY}-two")
    assert two.status == "confirmed"
    derived = await edges(t, "derived_from")
    assert len(derived) == 2 and all(e.status == "confirmed" for e in derived)


async def test_approving_a_vision_writes_its_beliefs_as_assumptions(client, ctx):
    """protects=each vision belief becomes an assumption entity with vision_document_id,
    belief_id and status, and a dropped belief is rejected; fails_when=a belief is missing,
    its attrs are wrong or a dropped one stays confirmed; no_claim=evidence on beliefs."""
    t = ctx.tenant_id
    beliefs = [belief("b1", "Teams plan weekly", "supported"),
               belief("b2", "Founders decide"), belief("b3", "Tools sprawl", "strained")]  # fmt: skip
    v = await imported(client, ctx.as_("owner"), VISION, vision_md(beliefs))
    await approved(client, ctx.as_("owner"), VISION, 1)
    async with tenant_session(t) as s:
        rows = {e.key: e for e in await s.scalars(select(Entity).where(Entity.type == "assumption"))}
    assert set(rows) == {f"{VISION}-b1", f"{VISION}-b2", f"{VISION}-b3"}
    b1 = rows[f"{VISION}-b1"]
    assert b1.title == "Teams plan weekly" and b1.status == "confirmed"
    assert b1.attrs == {"vision_document_id": v["document_id"], "belief_id": "b1",
                        "status": "supported"}  # fmt: skip
    assert rows[f"{VISION}-b2"].attrs["status"] == "untested"

    await imported(client, ctx.as_("owner"), VISION, vision_md(beliefs[:2]))
    await approved(client, ctx.as_("owner"), VISION, 2)
    assert (await entity(t, "assumption", f"{VISION}-b3")).status == "rejected"


async def test_roadmap_approval_records_item_dependencies_that_go_stale(client, ctx):
    """protects=acceptance 5: approving a roadmap after a strategy writes one
    artifact_dependencies row per (item, choice) path item -> feature -> goal -> choice, and
    approving a strategy that drops the choice marks it potentially_stale; fails_when=no
    row, a duplicate per path, or the row stays fresh; no_claim=items without a feature."""
    t = ctx.tenant_id
    a = await add_entity(t, "goal", "a")
    f = await add_entity(t, "feature", "f")
    g = await add_entity(t, "feature", "g")
    await supports(t, f, a)
    await supports(t, g, a)
    md = strategy_md([choice("one", goals=["a"]), choice("two", goals=["a"])])
    await imported(client, ctx.as_("owner"), STRATEGY, md)
    await approved(client, ctx.as_("owner"), STRATEGY, 1)
    _, roadmap_version = await roadmap_with_items(
        client, ctx, [("item-f", "now", f), ("item-g", "next", g), ("no-feature", "later", None)]
    )
    await approved(client, ctx.as_("owner"), "example-roadmap", 1)

    one = await entity(t, "strategy_choice", f"{STRATEGY}-one")
    two = await entity(t, "strategy_choice", f"{STRATEGY}-two")
    async with tenant_session(t) as s:
        deps = list(
            await s.scalars(
                select(ArtifactDependency).where(
                    ArtifactDependency.document_version_id == roadmap_version,
                    ArtifactDependency.upstream_entity_id.is_not(None),
                )
            )
        )
    # Two items, each under two choices: four paths.
    assert sorted((d.upstream_entity_id, d.note) for d in deps) == sorted(
        [(c.id, f"roadmap item {k}") for c in (one, two) for k in ("item-f", "item-g")]
    )
    assert all(d.freshness == "fresh" for d in deps)

    await imported(client, ctx.as_("owner"), STRATEGY, strategy_md([choice("one", goals=["a"])]))
    await approved(client, ctx.as_("owner"), STRATEGY, 2)
    async with tenant_session(t) as s:
        fresh = dict(
            (
                await s.execute(
                    select(ArtifactDependency.upstream_entity_id, ArtifactDependency.freshness)
                    .where(ArtifactDependency.document_version_id == roadmap_version,
                           ArtifactDependency.upstream_entity_id == two.id)
                )
            ).all()
        )  # fmt: skip
    assert fresh == {two.id: "potentially_stale"}


async def test_a_roadmap_approved_with_no_strategy_records_no_choice_dependencies(client, ctx):
    """protects=no strategy, no choice rows; fails_when=rows appear with nothing upstream;
    no_claim=the roadmap's own dependencies on its PRD."""
    t = ctx.tenant_id
    a = await add_entity(t, "goal", "a")
    f = await add_entity(t, "feature", "f")
    await supports(t, f, a)
    _, version = await roadmap_with_items(client, ctx, [("item-f", "now", f)])
    await approved(client, ctx.as_("owner"), "example-roadmap", 1)
    async with tenant_session(t) as s:
        assert await s.scalar(
            select(func.count()).select_from(ArtifactDependency).where(
                ArtifactDependency.document_version_id == version,
                ArtifactDependency.upstream_entity_id.is_not(None),
            )
        ) == 0  # fmt: skip
