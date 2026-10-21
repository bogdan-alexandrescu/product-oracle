"""H4 Strategy and vision, lane 3: what Company › Strategy reads from the stack beyond the
choices: each focus goal's own roadmap item count (one stack-table line per goal)."""

import pytest

from tests.baseline_helpers import make_ctx
from tests.strategy_helpers import (
    STRATEGY,
    add_entity,
    approved,
    choice,
    imported,
    roadmap_with_items,
    strategy_md,
    supports,
)


@pytest.fixture
async def ctx():
    return await make_ctx()


async def test_each_focus_goal_counts_its_own_roadmap_items(client, ctx):
    """protects=a focus goal's line in the stack table counts the items serving that goal,
    while the choice counts every item under it once; fails_when=each goal repeats the
    choice's total, or an item serving both goals counts twice for the choice;
    no_claim=items outside the strategy (test_strategy_drift)."""
    t = ctx.tenant_id
    a, b = await add_entity(t, "goal", "a"), await add_entity(t, "goal", "b")
    fa, fb, fab = [await add_entity(t, "feature", k) for k in ("fa", "fb", "fab")]
    await supports(t, fa, a)
    await supports(t, fb, b)
    await supports(t, fab, a)
    await supports(t, fab, b)
    owner = ctx.as_("owner")
    await imported(client, owner, STRATEGY, strategy_md([choice("one", goals=["a", "b"])]))
    await approved(client, owner, STRATEGY, 1)
    await roadmap_with_items(
        client,
        ctx,
        [("i1", "now", fa), ("i2", "next", fa), ("i3", "now", fb), ("i4", "later", fab)],
    )
    await approved(client, owner, "example-roadmap", 1)
    stack = (await client.get("/v1/strategy/stack", headers=ctx.as_("viewer"))).json()
    (one,) = stack["strategy"]["choices"]
    assert one["items"] == 4
    assert {g["key"]: g["items"] for g in one["goals"]} == {"a": 3, "b": 2}
