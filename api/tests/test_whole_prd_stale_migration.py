"""Migration 0090_whole_prd_stale_cleared (the walk-fixes-3 review, P11's stored rows).

Cards (protects / fails_when / no_claim):

- test_chains_on_the_single_head: protects=the revision chains on 0089 as the single head;
  fails_when=two heads or another parent; no_claim=its SQL.
- test_clears_only_the_whole_prd_reason: protects=a roadmap item marked potentially stale
  only by the earlier rule ("the PRD has a new version (N)") is fresh again in the database
  (Detailed's item reads its stored freshness), and an item stale for a reason of its own
  keeps that reason without the whole-PRD one; fails_when=the first stays
  potentially_stale, or the second loses its own reason or its stale state;
  no_claim=the reads' own rule (tests/test_simple_walk_fixes3_ph_api.py).
"""

import importlib.util

from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import select, text

from oracle.roadmap.models import RoadmapItem
from oracle.tenancy import tenant_session
from tests.conftest import API_DIR
from tests.test_roadmap import (  # noqa: F401 - fixtures
    approved_prd,
    built_roadmap,
    owner,
    runtime,
)
from tests.test_roadmap_item_staleness import items
from tests.test_simple_walk_fixes3_ph_api import _mark

REVISION = "0090_whole_prd_stale_cleared"
PREVIOUS = "0090_simple_prd_plans"


def _migration():
    path = API_DIR / "migrations" / "versions" / f"{REVISION}.py"
    spec = importlib.util.spec_from_file_location(REVISION, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(Config(str(API_DIR / "alembic.ini")))
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0092_rituals_wait_for_goal"]


async def test_clears_only_the_whole_prd_reason(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    await _mark(tenant_id, None, "the PRD has a new version (2)")
    own = "PRD section s-5-2 changed in version 2"
    async with tenant_session(tenant_id) as s:
        item = await s.scalar(select(RoadmapItem).where(RoadmapItem.item_key == "shipping-step"))
        item.stale_reasons = [own, "the PRD has a new version (2)"]
        await s.commit()

    async with tenant_session(tenant_id) as s:
        await s.execute(text(_migration().CLEAR))
        await s.commit()

    got = await items(client, auth)
    assert got["payment-step"]["freshness"] == "fresh", got["payment-step"]
    assert got["payment-step"]["stale_reasons"] == []
    assert got["shipping-step"]["freshness"] == "potentially_stale"
    assert got["shipping-step"]["stale_reasons"] == [own]
    async with tenant_session(tenant_id) as s:
        cleared = await s.scalar(select(RoadmapItem).where(RoadmapItem.item_key == "payment-step"))
        assert cleared.stale_since is None and cleared.caused_by_change_id is None
