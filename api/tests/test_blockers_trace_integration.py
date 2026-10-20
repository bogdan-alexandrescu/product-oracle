"""Blockers (CR-04) beside traceability (CR-05): one change event per blocker change.

The blocker routes write attrs.blocker through oracle.baseline.service, whose trace hook
records a change event for every entity write. The blocker routes record their own
(``blocker_status``, with from_status and to_status), so a write that changes only the
status, type, severity or option change is not recorded twice; any other strategy
change and a statement change are still ``entity`` changes.
"""

import uuid

from sqlalchemy import select

from oracle.tenancy import tenant_session
from oracle.v2 import models as m
from tests.baseline_helpers import make_ctx
from tests.blocker_helpers import create_blocker, make_document


async def _changes(ctx, blocker_id: str) -> list[tuple[str, str]]:
    async with tenant_session(ctx.tenant_id) as s:
        rows = await s.scalars(
            select(m.ChangeEvent)
            .where(m.ChangeEvent.subject_id == uuid.UUID(blocker_id))
            .order_by(m.ChangeEvent.created_at)
        )
        return [(r.subject_kind, r.cause) for r in rows.all()]


async def test_a_status_change_is_one_blocker_status_event_and_a_statement_is_an_entity_change(
    client,
):
    ctx = await make_ctx()
    doc_id = await make_document(ctx)
    b = (await create_blocker(client, ctx, document_ids=[str(doc_id)]))["blocker"]
    h = ctx.as_("approver")
    assert await _changes(ctx, b["id"]) == []

    resp = await client.post(
        f"/v1/blockers/{b['id']}/status",
        json={"status": "mitigating", "reason": "Work began"},
        headers=h,
    )
    assert resp.status_code == 200, resp.text
    assert await _changes(ctx, b["id"]) == [("blocker_status", "status_changed")]

    revision = resp.json()["blocker"]["revision"]
    resp = await client.patch(
        f"/v1/blockers/{b['id']}",
        json={"revision": revision, "statement": "Provider caps lookups at 50 a second"},
        headers=h,
    )
    assert resp.status_code == 200, resp.text
    assert await _changes(ctx, b["id"]) == [
        ("blocker_status", "status_changed"),
        ("entity", "entity_updated"),
    ]


async def test_a_strategy_only_edit_is_still_an_entity_change(client):
    """A threshold or document change is not recorded by the blocker routes, so it must
    stay an ``entity`` change: otherwise a PRD section built on the blocker is never
    marked stale (integration review of #64)."""
    ctx = await make_ctx()
    doc_id = await make_document(ctx)
    b = (await create_blocker(client, ctx, document_ids=[str(doc_id)]))["blocker"]
    h = ctx.as_("approver")

    resp = await client.patch(
        f"/v1/blockers/{b['id']}",
        json={"revision": b["revision"], "threshold": "5 a second"},
        headers=h,
    )
    assert resp.status_code == 200, resp.text
    assert await _changes(ctx, b["id"]) == [("entity", "entity_updated")]
