"""The pool's pure rules, mirroring SwarmCloud's tests/unit/control_plane/test_account_pool.py
and test_account_readings.py: choice, eligibility reasons, readings merge, labels."""

from datetime import UTC, datetime, timedelta

import pytest

from oracle.claude_accounts.accounts import (
    DEFAULT_ASSIGN_FLOOR,
    HOLD_END_RELEASED,
    HOLD_END_SWAPPED,
    HOLD_LOG_RETENTION,
    Account,
    AccountError,
    AccountState,
    Hold,
    Unavailable,
    WindowReading,
    choose,
    due_for_refresh,
    eligibility,
    hold_log_entry,
    holds_from_json,
    holds_to_json,
    validate_label,
    windows_from_json,
    windows_to_json,
)

NOW = datetime(2026, 10, 18, 12, 0, tzinfo=UTC)


def win(utilization: float, resets_in: timedelta = timedelta(hours=2)) -> WindowReading:
    return WindowReading(utilization=utilization, resets_at=NOW + resets_in)


def acct(label: str, *, state=AccountState.AVAILABLE, observed=NOW, assigned=0, **windows):
    return Account(
        account_id=f"id-{label}",
        label=label,
        state=state,
        windows=dict(windows),
        observed_at=observed if windows else None,
        assigned=assigned,
    )


def test_the_binding_window_decides_not_the_average():
    a = acct("a", five_hour=win(0.10), seven_day=win(0.95))
    assert a.headroom(NOW) == pytest.approx(0.05)


def test_an_account_past_its_reset_is_full_again_without_being_probed():
    a = acct("a", five_hour=win(1.0, resets_in=-timedelta(minutes=1)))
    assert a.headroom(NOW) == 1.0
    assert choose([a], NOW) == a


def test_the_account_with_the_most_headroom_wins():
    busy = acct("busy", five_hour=win(0.7))
    idle = acct("idle", five_hour=win(0.2))
    assert choose([busy, idle], NOW) == idle


def test_load_is_spread_rather_than_stacked_when_headroom_ties():
    one = acct("one", assigned=3, five_hour=win(0.2))
    two = acct("two", assigned=1, five_hour=win(0.2))
    assert choose([one, two], NOW) == two


def test_choosing_is_deterministic_by_label_last():
    b = acct("bravo", five_hour=win(0.2))
    a = acct("alpha", five_hour=win(0.2))
    assert choose([b, a], NOW) == a
    assert choose([a, b], NOW) == a


def test_a_nearly_spent_account_is_not_handed_to_a_new_job():
    nearly = acct("nearly", five_hour=win(1 - DEFAULT_ASSIGN_FLOOR + 0.01))
    assert choose([nearly], NOW) is None


def test_an_unobserved_account_is_assignable():
    fresh = acct("fresh")
    assert fresh.headroom(NOW) == 1.0
    assert choose([fresh], NOW) == fresh
    assert not fresh.is_stale(NOW)


def test_a_stale_reading_is_discounted_but_not_treated_as_exhausted():
    old = acct("old", observed=NOW - timedelta(hours=1), five_hour=win(0.2))
    new = acct("new", five_hour=win(0.5))
    assert old.headroom(NOW) == pytest.approx(0.4)
    assert choose([old, new], NOW) == new
    assert choose([old], NOW) == old


@pytest.mark.parametrize(
    "state", [AccountState.PAUSED, AccountState.DRAINING, AccountState.REAUTH_REQUIRED]
)
def test_only_an_available_account_takes_new_jobs(state):
    assert choose([acct("x", state=state)], NOW) is None


def test_excluded_and_unreadable_accounts_are_skipped():
    a, b = acct("a"), acct("b")
    assert choose([a, b], NOW, exclude=["id-a"]) == b
    unreadable = Account(account_id="id-c", label="c", unreadable_at=NOW - timedelta(minutes=5))
    assert choose([unreadable], NOW) is None
    # The report is forgotten after thirty minutes.
    forgotten = Account(account_id="id-c", label="c", unreadable_at=NOW - timedelta(minutes=31))
    assert choose([forgotten], NOW) == forgotten


# --- why nothing could be assigned ------------------------------------------------


def test_no_accounts_is_the_one_reason_that_means_fall_back():
    assert eligibility([], NOW) == (Unavailable.NO_ACCOUNTS_REGISTERED, None)


def test_a_paused_pool_waits_on_a_person():
    pool = [acct("a", state=AccountState.PAUSED), acct("b", state=AccountState.REAUTH_REQUIRED)]
    assert choose(pool, NOW) is None
    assert eligibility(pool, NOW) == (Unavailable.POOL_PAUSED, None)


def test_a_spent_pool_says_when_the_earliest_window_clears():
    soon = acct("soon", five_hour=win(0.99, resets_in=timedelta(minutes=40)))
    later = acct("later", seven_day=win(1.0, resets_in=timedelta(days=2)))
    assert choose([soon, later], NOW) is None
    assert eligibility([soon, later], NOW) == (
        Unavailable.NO_ACCOUNT_AVAILABLE,
        NOW + timedelta(minutes=40),
    )


def test_an_account_blocked_only_by_staleness_is_a_reading_wait_not_a_spent_pool():
    # Raw remaining between the floor and twice it: halved below the floor by age alone.
    old = acct("old", observed=NOW - timedelta(hours=1), five_hour=win(0.8))
    assert choose([old], NOW) is None
    assert old.next_reset(NOW) is None
    assert eligibility([old], NOW) == (Unavailable.NO_RECENT_READING, None)


def test_every_account_ruled_out_by_this_call_is_a_wait_not_a_fallback():
    assert eligibility([acct("a")], NOW, exclude=["id-a"]) == (
        Unavailable.NO_ACCOUNT_AVAILABLE,
        None,
    )


def test_next_reset_reports_only_what_is_actually_blocking():
    roomy = acct("roomy", five_hour=win(0.3), seven_day=win(0.5))
    assert roomy.next_reset(NOW) is None
    blocked = acct(
        "blocked",
        five_hour=win(0.95, resets_in=timedelta(hours=1)),
        seven_day=win(0.5, resets_in=timedelta(hours=30)),
    )
    assert blocked.next_reset(NOW) == NOW + timedelta(hours=1)


# --- readings ----------------------------------------------------------------------


def test_a_reading_of_one_window_keeps_the_other():
    a = acct("a", five_hour=win(0.9))
    merged = a.with_reading({"seven_day": win(0.2)}, NOW + timedelta(minutes=1))
    assert set(merged.windows) == {"five_hour", "seven_day"}
    assert merged.windows["five_hour"].utilization == 0.9
    assert merged.observed_at == NOW + timedelta(minutes=1)


def test_a_newer_reading_wins_and_an_older_one_is_discarded():
    a = acct("a", five_hour=win(0.5))
    newer = a.with_reading({"five_hour": win(0.7)}, NOW + timedelta(minutes=5))
    assert newer.windows["five_hour"].utilization == 0.7
    older = newer.with_reading({"five_hour": win(0.1)}, NOW + timedelta(minutes=1))
    assert older is newer


def test_windows_and_holds_round_trip_and_bad_entries_are_dropped():
    windows = {"five_hour": WindowReading(0.25, NOW, observed_at=NOW)}
    assert windows_from_json(windows_to_json(windows)) == windows
    hold = Hold("h1", NOW, task_id="reporting", attempt_id="a1", assigned_at=NOW, move="drain")
    assert holds_from_json(holds_to_json([hold])) == (hold,)
    raw = [*holds_to_json([hold]), "junk", {"assignment_id": "x"}, {"expires_at": "nope"}]
    assert holds_from_json(raw) == (hold,)
    assert holds_from_json("not a list") == ()


def test_hold_log_entries_age_out_and_carry_both_sides_of_a_swap():
    hold = Hold("h1", NOW + timedelta(hours=3), assigned_at=NOW, swapped_from="id-a",
                swap_reason="exhausted")  # fmt: skip
    opened = hold_log_entry(hold, "id-b")
    assert opened["end"] is None and opened["released_at"] is None
    assert opened["expires_at"] == hold.expires_at + HOLD_LOG_RETENTION
    assert opened["swapped_from"] == "id-a" and opened["swapped_from_reason"] == "exhausted"
    closed = hold_log_entry(hold, "id-b", end=HOLD_END_SWAPPED, released_at=NOW,
                            swapped_to="id-c", swap_reason="drain")  # fmt: skip
    assert closed["swapped_to"] == "id-c" and closed["swapped_to_reason"] == "drain"
    released = hold_log_entry(hold, "id-b", end=HOLD_END_RELEASED, released_at=NOW,
                              swapped_to="id-c")  # fmt: skip
    assert released["swapped_to"] is None
    assert released["expires_at"] == NOW + HOLD_LOG_RETENTION


def test_every_account_is_swept_except_a_dead_one():
    pool = [
        acct("idle"),
        acct("paused", state=AccountState.PAUSED),
        acct("draining", state=AccountState.DRAINING),
        acct("dead", state=AccountState.REAUTH_REQUIRED),
    ]
    assert [a.label for a in due_for_refresh(pool, NOW)] == ["idle", "paused", "draining"]


@pytest.mark.parametrize("bad", ["", "UPPER", "-lead", "trail-", "has space", "a" * 41, "dot.x"])
def test_a_label_outside_the_rule_is_refused(bad):
    with pytest.raises(AccountError):
        validate_label(bad)


def test_a_label_inside_the_rule_is_accepted():
    for good in ["a", "personal", "work-2", "a" * 40]:
        assert validate_label(good) == good
