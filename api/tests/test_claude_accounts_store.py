"""Holds, the hold log, states, drain and swap against Postgres, mirroring SwarmCloud's
test_account_hold_log.py, test_account_swap.py and the REAUTH_REQUIRED round trips."""

from datetime import timedelta

import pytest
from sqlalchemy import select

from oracle.claude_accounts import pool, store
from oracle.claude_accounts.accounts import AccountState, Unavailable
from oracle.claude_accounts.models import ClaudeAccountHold
from oracle.tenancy import tenant_session
from tests.claude_account_helpers import add_account, edit_row, get_account, now, window


async def _records(tenant_id, account_id=None):
    async with tenant_session(tenant_id) as s:
        q = select(ClaudeAccountHold).order_by(ClaudeAccountHold.assigned_at)
        if account_id:
            q = q.where(ClaudeAccountHold.account_id == account_id)
        return list((await s.scalars(q)).all())


async def test_acquiring_counts_the_hold_and_opens_its_record(tenant_id):
    a = await add_account(tenant_id, "work")
    assignment_id, assigned = await store.acquire_hold(
        tenant_id, a.account_id, now=now(), task_id="reporting", attempt_id="att-1"
    )
    assert assigned == 1
    account = await get_account(tenant_id, a.account_id)
    assert account.assigned == 1 and account.last_assigned_at is not None
    hold = account.holds[0]
    assert (hold.task_id, hold.attempt_id) == ("reporting", "att-1")
    [record] = await _records(tenant_id)
    assert record.assignment_id == assignment_id and record.end is None
    assert record.expires_at == hold.expires_at + timedelta(days=90)


async def test_releasing_closes_the_record_and_a_duplicate_writes_nothing(tenant_id):
    a = await add_account(tenant_id, "work")
    hold_id, _ = await store.acquire_hold(tenant_id, a.account_id, now=now())
    assert await store.release_hold(tenant_id, a.account_id, assignment_id=hold_id, now=now()) == (
        0,
        True,
    )
    [record] = await _records(tenant_id)
    assert record.end == "released" and record.released_at is not None
    again = await store.release_hold(tenant_id, a.account_id, assignment_id=hold_id, now=now())
    assert again == (0, False)
    assert (await _records(tenant_id))[0].released_at == record.released_at


async def test_a_release_reporting_the_credential_unreadable_ends_as_unusable(tenant_id):
    a = await add_account(tenant_id, "work")
    hold_id, _ = await store.acquire_hold(tenant_id, a.account_id, now=now())
    await store.release_hold(
        tenant_id, a.account_id, assignment_id=hold_id, now=now(), unusable="no token"
    )
    assert (await _records(tenant_id))[0].end == "unusable"
    assert (await get_account(tenant_id, a.account_id)).is_unreadable(now())


async def test_an_expired_hold_is_pruned_and_closed_at_its_own_deadline(tenant_id):
    a = await add_account(tenant_id, "work")
    taken = now() - timedelta(hours=4)
    hold_id, _ = await store.acquire_hold(tenant_id, a.account_id, now=taken)
    assert (await get_account(tenant_id, a.account_id)).assigned == 1
    assert await store.prune_holds(tenant_id, a.account_id, now=now()) == 1
    assert (await get_account(tenant_id, a.account_id)).assigned == 0
    [record] = await _records(tenant_id)
    assert record.end == "expired"
    assert record.released_at == taken + timedelta(hours=3)
    assert await store.prune_holds(tenant_id, a.account_id, now=now()) == 0


async def test_an_expired_hold_dropped_by_a_later_assignment_is_closed_too(tenant_id):
    a = await add_account(tenant_id, "work")
    await store.acquire_hold(tenant_id, a.account_id, now=now() - timedelta(hours=4))
    _, assigned = await store.acquire_hold(tenant_id, a.account_id, now=now())
    assert assigned == 1
    ends = sorted(str(r.end) for r in await _records(tenant_id))
    assert ends == ["None", "expired"]


async def test_draining_marks_every_live_hold_and_leaving_it_clears_the_marks(tenant_id):
    a = await add_account(tenant_id, "work")
    h1, _ = await store.acquire_hold(tenant_id, a.account_id, now=now())
    await store.acquire_hold(tenant_id, a.account_id, now=now())
    moving = await store.set_state_and_moves(
        tenant_id, a.account_id, AccountState.DRAINING, "retiring", now=now()
    )
    assert moving == 2
    account = await get_account(tenant_id, a.account_id)
    assert {h.move for h in account.holds} == {"drain"}
    assert await store.hold_move(tenant_id, a.account_id, h1) == "drain"
    # A draining account takes no new hold.
    assert await store.acquire_hold(tenant_id, a.account_id, now=now()) is None
    await store.set_state_and_moves(tenant_id, a.account_id, AccountState.AVAILABLE, "", now=now())
    account = await get_account(tenant_id, a.account_id)
    assert {h.move for h in account.holds} == {None}
    assert await store.hold_move(tenant_id, a.account_id, h1) is None


async def test_a_drained_account_reaches_zero_holders_by_swaps(tenant_id):
    a = await add_account(tenant_id, "alpha")
    b = await add_account(tenant_id, "bravo", windows={"five_hour": window(0.5)})
    first = await pool.assign(tenant_id, job="reporting", attempt_id="x")
    assert isinstance(first, pool.Assignment) and first.account_id == a.account_id
    await store.set_state_and_moves(tenant_id, a.account_id, AccountState.DRAINING, "", now=now())
    assert await pool.must_move(tenant_id, first) == "drain"
    moved = await pool.swap(tenant_id, first, reason="drain")
    assert isinstance(moved, pool.Assignment) and moved.account_id == b.account_id
    assert (await get_account(tenant_id, a.account_id)).assigned == 0
    assert (await get_account(tenant_id, b.account_id)).assigned == 1


async def test_a_swap_moves_the_hold_in_one_commit_with_one_closed_and_one_opened_record(
    tenant_id,
):
    a = await add_account(tenant_id, "alpha")
    b = await add_account(tenant_id, "bravo", windows={"five_hour": window(0.3)})
    hold_id, _ = await store.acquire_hold(
        tenant_id, a.account_id, now=now(), task_id="refinement", attempt_id="att"
    )
    new_id, assigned = await store.swap_hold(
        tenant_id, a.account_id, b.account_id, assignment_id=hold_id, reason="exhausted", now=now()
    )
    assert assigned == 1
    assert (await get_account(tenant_id, a.account_id)).assigned == 0
    moved = (await get_account(tenant_id, b.account_id)).holds[0]
    assert (moved.assignment_id, moved.task_id, moved.swapped_from) == (
        new_id,
        "refinement",
        a.account_id,
    )
    [left] = await _records(tenant_id, a.account_id)
    [taken] = await _records(tenant_id, b.account_id)
    assert (left.end, left.swapped_to, left.swapped_to_reason) == (
        "swapped",
        b.account_id,
        "exhausted",
    )
    assert (taken.end, taken.swapped_from, taken.swapped_from_reason) == (
        None,
        a.account_id,
        "exhausted",
    )
    # A hold the caller does not have cannot be swapped.
    with pytest.raises(store.HoldNotHeld):
        await store.swap_hold(
            tenant_id, a.account_id, b.account_id, assignment_id=hold_id, reason="drain", now=now()
        )


async def test_no_other_account_keeps_the_hold_and_says_why(tenant_id):
    a = await add_account(tenant_id, "alpha")
    await add_account(tenant_id, "paused", state=AccountState.PAUSED)
    got = await pool.assign(tenant_id, job="reporting", attempt_id="x")
    assert isinstance(got, pool.Assignment)
    moved = await pool.swap(tenant_id, got, reason="exhausted")
    assert isinstance(moved, pool.NoAccount) and moved.reason is Unavailable.POOL_PAUSED
    assert (await get_account(tenant_id, a.account_id)).assigned == 1


async def test_a_swap_off_an_unusable_account_keeps_the_next_ask_away_from_it(tenant_id):
    a = await add_account(tenant_id, "alpha")
    b = await add_account(tenant_id, "bravo", windows={"five_hour": window(0.5)})
    got = await pool.assign(tenant_id, job="reporting", attempt_id="x")
    assert got.account_id == a.account_id  # type: ignore[union-attr]
    await pool.swap(tenant_id, got, reason="unusable")  # type: ignore[arg-type]
    again = await pool.assign(tenant_id, job="reporting", attempt_id="y")
    assert again.account_id == b.account_id  # type: ignore[union-attr]


async def test_the_sweep_remembers_the_state_it_overrules_and_recovery_gives_it_back(tenant_id):
    a = await add_account(tenant_id, "work", state=AccountState.PAUSED)
    marked = await store.mark_reauth_required(tenant_id, a.account_id, "refresh failed")
    assert marked.state is AccountState.REAUTH_REQUIRED
    assert marked.state_before_reauth is AccountState.PAUSED
    # Marking again does not overwrite the remembered state with itself.
    again = await store.mark_reauth_required(tenant_id, a.account_id, "again")
    assert again.state_before_reauth is AccountState.PAUSED and again.reason == "refresh failed"
    back = await store.clear_reauth_required(tenant_id, a.account_id)
    assert back.state is AccountState.PAUSED and back.reason == ""
    assert back.state_before_reauth is None


async def test_a_person_setting_a_state_forgets_what_the_sweep_remembered(tenant_id):
    a = await add_account(tenant_id, "work", state=AccountState.DRAINING)
    await store.mark_reauth_required(tenant_id, a.account_id, "refresh failed")
    await store.set_state_and_moves(
        tenant_id, a.account_id, AccountState.REAUTH_REQUIRED, "by hand", now=now()
    )
    assert (await get_account(tenant_id, a.account_id)).state_before_reauth is None
    back = await store.clear_reauth_required(tenant_id, a.account_id)
    assert back.state is AccountState.AVAILABLE


async def test_signing_in_again_recovers_and_keeps_holds_and_readings(tenant_id):
    a = await add_account(tenant_id, "work", windows={"five_hour": window(0.4)})
    await store.acquire_hold(tenant_id, a.account_id, now=now())
    await store.mark_reauth_required(tenant_id, a.account_id, "refresh failed: reauth_required")
    again = await add_account(tenant_id, "work", access="acc-fresh")
    assert again.account_id == a.account_id
    assert again.state is AccountState.AVAILABLE and again.reason == ""
    assert again.assigned == 1 and "five_hour" in again.windows
    assert await store.DbSecretStore(tenant_id).access(a.account_id) == "acc-fresh"


async def test_removing_an_account_closes_its_open_hold_records(tenant_id):
    a = await add_account(tenant_id, "work")
    await store.acquire_hold(tenant_id, a.account_id, now=now())
    await store.acquire_hold(tenant_id, a.account_id, now=now() - timedelta(hours=4))
    closed = await store.remove_account_and_close_holds(tenant_id, a.account_id, now=now())
    assert closed == 1
    ends = sorted(r.end for r in await _records(tenant_id))
    assert ends == ["account_removed", "expired"]
    async with tenant_session(tenant_id) as s:
        assert await store.get(s, a.account_id) is None


async def test_a_reading_is_merged_in_a_transaction(tenant_id):
    a = await add_account(tenant_id, "work", windows={"five_hour": window(0.9)})
    await store.record_reading(tenant_id, a.account_id, {"seven_day": window(0.1)}, now())
    account = await get_account(tenant_id, a.account_id)
    assert set(account.windows) == {"five_hour", "seven_day"}
    old = now() - timedelta(hours=1)
    await store.record_reading(tenant_id, a.account_id, {"five_hour": window(0.0)}, old)
    assert (await get_account(tenant_id, a.account_id)).windows["five_hour"].utilization == 0.9


async def test_the_pool_is_one_companys(tenant_id):
    from tests.conftest import make_tenant

    other = await make_tenant("Other Co")
    mine = await add_account(tenant_id, "work")
    assert await store.acquire_hold(other, mine.account_id, now=now()) is None
    got = await pool.assign(other, job="reporting", attempt_id="x")
    assert isinstance(got, pool.NoAccount) and got.is_pool_absent


async def test_an_unreadable_report_is_forgotten_by_the_sweep(tenant_id):
    a = await add_account(tenant_id, "work")
    await edit_row(tenant_id, a.account_id, unreadable_at=now() - timedelta(hours=1))
    await store.prune_holds(tenant_id, a.account_id, now=now())
    assert (await get_account(tenant_id, a.account_id)).unreadable_at is None
