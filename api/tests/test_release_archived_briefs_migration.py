"""Migration 0057_release_archived_briefs (#599 re-review MAJOR 1, decided "Release on
archive", BGD 2026-10-25): the requests behind a brief archived before archiving released
them, and that never made a PRD, are released (their brief link cleared) once.

Card: protects=the data step releases those requests and only those, chained on
0054_reply_opened as the single head; fails_when=a request behind an archived brief with
no PRD keeps the link, a request with a PRD or behind a live brief loses it;
no_claim=archiving from now on (tests/test_requests_brief.py).

The data step's SQL runs on the test database's rows (the scratch-database pattern of the
other migration tests would need every column of an intake and a request by hand)."""

import importlib.util

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text, update

from oracle.tenancy import tenant_session
from oracle.v2.models import ProductIntake
from tests.baseline_helpers import Ctx, make_ctx
from tests.conftest import API_DIR
from tests.intake_helpers import create_intake
from tests.test_requests import get, goal
from tests.test_requests_brief import qualified

REVISION = "0057_release_archived_briefs"
PREVIOUS = "0056_slack_pings"


@pytest.fixture
async def ctx() -> Ctx:
    return await make_ctx()


def _migration():
    path = API_DIR / "migrations" / "versions" / f"{REVISION}.py"
    spec = importlib.util.spec_from_file_location(REVISION, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(Config(str(API_DIR / "alembic.ini")))
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0074_board_wide_tables"]


async def test_releases_requests_behind_briefs_archived_before(client, ctx):
    from tests.v2_helpers import seed_v2

    seeded = await seed_v2(ctx.tenant_id)
    g = await goal(client, ctx)
    stuck = await qualified(client, ctx, "Keep the address", g["id"])
    with_prd = await qualified(client, ctx, "Saved cards", g["id"])
    live = await qualified(client, ctx, "Dark mode", g["id"])
    old = (await create_intake(client, ctx, request_ids=[stuck["id"]]))["intake"]
    made = (await create_intake(client, ctx, title="B", request_ids=[with_prd["id"]]))["intake"]
    kept = (await create_intake(client, ctx, title="C", request_ids=[live["id"]]))["intake"]
    async with tenant_session(ctx.tenant_id) as s:
        # Archived before the release shipped: the status changed, the links stayed.
        await s.execute(
            update(ProductIntake)
            .where(ProductIntake.id.in_([old["id"], made["id"]]))
            .values(status="archived")
        )
        await s.execute(
            text("UPDATE product_requests SET document_id = :d WHERE id = :r"),
            {"d": seeded.document_id, "r": with_prd["id"]},
        )
        await s.commit()
    async with tenant_session(ctx.tenant_id) as s:
        await s.execute(text(_migration().RELEASE))
        await s.commit()
    assert (await get(client, ctx, stuck["id"]))["intake_id"] is None
    assert (await get(client, ctx, with_prd["id"]))["intake_id"] == made["id"]
    assert (await get(client, ctx, live["id"]))["intake_id"] == kept["id"]
