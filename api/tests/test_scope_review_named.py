"""walk-eng-check 5 and 6: the feature set review names a left-out feature's baseline goal
and its evidence by source, never "No goal" or a bare id.

Test cards (protects / fails_when / no_claim):

- test_a_left_out_feature_shows_its_baseline_goal: protects=a feature the set leaves out with
  no goal of its own reads the goals it supports in the baseline (baseline_goals);
  fails_when=baseline_goals is empty for it; no_claim=goals the set names itself.
- test_evidence_is_named_by_its_source: protects=evidence by name (evidence[].title);
  fails_when=only the bare ids are served; no_claim=evidence with no name (left out).
"""

import uuid

from sqlalchemy import select

from oracle.baseline.models import Edge, Entity, Evidence
from oracle.runs.scope_models import PrdScopeItem
from oracle.tenancy import tenant_session
from tests.test_runs import (  # noqa: F401 - fixtures
    owner,
    runtime,
)
from tests.test_scope_review import _open, _read, _row


async def _a_feature_with_a_goal(s, scope_id):
    """A scope row on a baseline feature that supports a confirmed goal, and that goal."""
    rows = (
        await s.scalars(
            select(PrdScopeItem).where(
                PrdScopeItem.scope_id == uuid.UUID(scope_id), PrdScopeItem.entity_id.is_not(None)
            )
        )
    ).all()
    for row in rows:
        goal = await s.scalar(
            select(Entity)
            .join(Edge, Edge.dst_id == Entity.id)
            .where(
                Edge.src_id == row.entity_id,
                Edge.type == "supports",
                Entity.type == "goal",
                Entity.status == "confirmed",
            )
        )
        if goal is not None:
            return row, goal
    # None in the seed: link the first row's feature to a confirmed goal.
    row = rows[0]
    goal = await s.scalar(select(Entity).where(Entity.type == "goal", Entity.status == "confirmed"))
    s.add(
        Edge(
            type="supports",
            src_id=row.entity_id,
            dst_id=goal.id,
            attrs={},
            origin="user",
            status="confirmed",
        )
    )
    return row, goal


async def test_a_left_out_feature_shows_its_baseline_goal(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    _, _, scope_id = await _open(client, owner, runtime)
    async with tenant_session(tenant_id) as s:
        row, goal = await _a_feature_with_a_goal(s, scope_id)
        row.decision = "exclude"
        row.goals = []
        key, goal_key = row.key, goal.key
        await s.commit()
    f = _row(await _read(client, auth, scope_id), key)
    assert f["decision"] == "exclude" and f["goals"] == []
    assert goal_key in [g["key"] for g in f["baseline_goals"]]


async def test_evidence_is_named_by_its_source(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    _, _, scope_id = await _open(client, owner, runtime)
    async with tenant_session(tenant_id) as s:
        row = await s.scalar(
            select(PrdScopeItem).where(
                PrdScopeItem.scope_id == uuid.UUID(scope_id), PrdScopeItem.entity_id.is_not(None)
            )
        )
        ev = Evidence(
            entity_id=row.entity_id,
            ref="Example customer interview",
            url="https://example.com/notes",
        )
        s.add(ev)
        await s.flush()
        row.evidence_ids = [ev.id, uuid.uuid4()]
        key, ev_id = row.key, ev.id
        await s.commit()
    f = _row(await _read(client, auth, scope_id), key)
    assert f["evidence"] == [
        {
            "id": str(ev_id),
            "title": "Example customer interview",
            "url": "https://example.com/notes",
        }
    ]
