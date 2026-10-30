# ruff: noqa: F811 - the ritual fixtures are imported
"""A suite with no marker sees the real "has a confirmed goal" check when the built-in
rituals are seeded (tests.conftest._rituals_seed_on): only the suites written before
"Start paused until goals" that model a company with a goal opt into seeding them on.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

from oracle.rituals import service as rituals
from oracle.tenancy import tenant_session
from tests.ritual_helpers import at, ctx, rituals_of, tick  # noqa: F401


async def test_an_unmarked_suite_s_new_company_waits_for_its_first_goal(ctx, at):
    """protects=a suite without the opt-in marker seeds a new company's default
    built-ins paused, waiting for the first goal; fails_when=the conftest forces every
    unmarked suite's company to have a confirmed goal, so its built-ins are seeded on;
    no_claim=which suites opt in (each says why)."""
    async with tenant_session(ctx.tenant_id) as db:
        assert not await rituals.has_confirmed_goal(db)
    await tick(ctx.tenant_id)
    seeded = await rituals_of(ctx.tenant_id)
    assert seeded["goals_checkin"].status == "paused"
    assert seeded["goals_checkin"].waits_for_goal
