"""Shared setup for the H2 Cadence engine tests: a company with an owner, approver,
commenter and viewer (made-up people), Oracle's ritual clock, and one ticker pass."""

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from oracle.rituals import clock
from oracle.rituals import service as rituals
from oracle.rituals.models import Ritual, RitualOccurrence
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx

# A Monday noon in Los Angeles (the default Company time zone), well before the first
# built-in falls due.
START = datetime(2026, 10, 19, 19, 0, tzinfo=UTC)


@pytest.fixture
def at(monkeypatch):
    """Sets Oracle's ritual clock: ``at(datetime)``; starts at :data:`START`."""
    state = {"now": START}
    monkeypatch.setattr(clock, "now", lambda: state["now"])

    def set_(when: datetime) -> datetime:
        state["now"] = when
        return when

    return set_


@pytest.fixture
async def ctx() -> Ctx:
    return await make_ctx()


async def tick(tenant_id: uuid.UUID) -> None:
    async with tenant_session(tenant_id) as db:
        await rituals.tick_due(db)


async def rituals_of(tenant_id: uuid.UUID) -> dict[str, Ritual]:
    async with tenant_session(tenant_id) as db:
        return {r.kind: r for r in await db.scalars(select(Ritual))}


async def occurrences_of(tenant_id: uuid.UUID, ritual_id=None) -> list[RitualOccurrence]:
    async with tenant_session(tenant_id) as db:
        q = select(RitualOccurrence).order_by(RitualOccurrence.due_at)
        if ritual_id is not None:
            q = q.where(RitualOccurrence.ritual_id == ritual_id)
        return list(await db.scalars(q))


async def ready_occurrence(client, ctx: Ctx, at, kind: str = "roadmap_refresh") -> dict:
    """Seeds the built-ins, then moves the clock to ``kind``'s preparation moment and
    ticks: its occurrence is ready. Returns the OccurrenceOut."""
    await tick(ctx.tenant_id)
    ritual = (await rituals_of(ctx.tenant_id))[kind]
    at(ritual.next_due_at)
    await tick(ctx.tenant_id)
    (occ,) = await occurrences_of(ctx.tenant_id, ritual.id)
    assert occ.status == "ready", occ.error
    resp = await client.get(f"/v1/ritual-occurrences/{occ.id}", headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text
    return resp.json()


async def only(client, ctx: Ctx, *kinds: str) -> None:
    """Seeds the built-ins, then an owner pauses every other active one on Company ›
    Rituals, so a test sees only ``kinds``' occurrences and summary runs."""
    await tick(ctx.tenant_id)
    for kind, r in (await rituals_of(ctx.tenant_id)).items():
        if kind not in kinds and r.status == "active":
            resp = await client.post(f"/v1/rituals/{r.id}/pause", headers=ctx.as_("owner"))
            assert resp.status_code == 200, resp.text
