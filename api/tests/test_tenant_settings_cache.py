"""timeline-order: tenant_settings_api keeps a session's settings read once (a roadmap read asks
for several) and reads them again whenever they may have moved. Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_read_again_across_companies: protects=a session reading across companies never
  answers from the cache; fails_when=a cached value is returned while unscoped;
  no_claim=which company's row the unscoped read picks.
- test_read_again_after_a_lock: protects=a lock taken with a SELECT (pg_advisory_xact_lock,
  FOR UPDATE) makes the next read go to the database, so a value written by another session
  before the lock is seen; fails_when=the read after the lock is stale; no_claim=other locks.
- test_read_again_after_a_write: protects=a write in the session forgets the cache;
  fails_when=the session reads its own old value; no_claim=the setters' checks.
"""

import pytest
from sqlalchemy import delete, select, text

from oracle.tenancy import UNSCOPED_KEY, tenant_session
from oracle.tenant_settings import TenantSetting
from oracle.tenant_settings_api import get_setting

KEY = "iap_default_role"


async def _put(tenant_id, value: str) -> None:
    async with tenant_session(tenant_id) as s:
        await s.execute(delete(TenantSetting).where(TenantSetting.key == KEY))
        s.add(TenantSetting(key=KEY, value=value))
        await s.commit()


async def test_read_again_across_companies(tenant_id):
    """A session reading across companies never answers from the cache."""
    await _put(tenant_id, "viewer")
    async with tenant_session(tenant_id) as s:
        assert await get_setting(s, KEY) == "viewer"
        await _put(tenant_id, "approver")
        s.sync_session.info[UNSCOPED_KEY] = True
        try:
            assert await get_setting(s, KEY) == "approver"
        finally:
            s.sync_session.info.pop(UNSCOPED_KEY, None)


@pytest.mark.parametrize(
    "lock",
    [
        lambda: text("SELECT pg_advisory_xact_lock(hashtext('example'))"),
        lambda: select(TenantSetting.id).where(TenantSetting.key == KEY).with_for_update(),
    ],
    ids=["advisory", "for-update"],
)
async def test_read_again_after_a_lock(tenant_id, lock):
    """A lock taken with a SELECT makes the next settings read go to the database."""
    await _put(tenant_id, "viewer")
    async with tenant_session(tenant_id) as s:
        assert await get_setting(s, KEY) == "viewer"
        await _put(tenant_id, "approver")
        await s.execute(lock())
        assert await get_setting(s, KEY) == "approver"


async def test_read_again_after_a_write(tenant_id):
    """A change in the session forgets the cache."""
    await _put(tenant_id, "viewer")
    async with tenant_session(tenant_id) as s:
        assert await get_setting(s, KEY) == "viewer"
        row = await s.scalar(select(TenantSetting).where(TenantSetting.key == KEY))
        row.value = "approver"
        assert await get_setting(s, KEY) == "approver"
        await s.flush()
        assert await get_setting(s, KEY) == "approver"
