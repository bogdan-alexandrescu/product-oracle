"""The account pool: the Claude subscriptions Oracle's built-in model jobs run on.

Ported from SwarmCloud's ``apps/quota-broker/quota_broker/accounts.py``; the rules and
the numbers are SwarmCloud's. Adapted for one company's Oracle: there is no lending
(every account in a company's pool serves that company and nobody else, which the
tenant scoping of the tables enforces), and an unreadable report is one instant rather
than one per borrowing tenant.

Two things keep a job from stopping because its account ran out of quota:

* pick well at assignment -- the account with the most headroom, not merely one that
  is not yet exhausted (``choose``);
* keep every account alive -- the refresh sweep visits EVERY account, idle ones too,
  because a refresh token that is never exchanged eventually dies
  (``due_for_refresh`` takes no "in use" filter on purpose).

Headroom is observed, not guessed: Claude Code's ``stream-json`` output carries
``rate_limit_event`` with each window's utilization and exact reset, and the usage
poll reads the same windows. Readings go stale (the same subscriptions are used from
a laptop), so ``headroom`` halves an old reading and ``eligibility`` keeps "stale" and
"spent" apart, because they are waited on differently.

Each assignment is a HOLD with an id and a deadline; ``assigned`` is the number of
holds that have not expired, and the sweep prunes the rest, so a killed process cannot
make an account look busy forever.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Any

#: Labels are restricted on the way in, so a bad label is refused at onboarding.
_LABEL = re.compile(r"^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$")

#: A reading older than this says nothing useful: these accounts are also used by a
#: person at a laptop, so utilisation moves without Oracle seeing any of it.
DEFAULT_STALE_AFTER = timedelta(minutes=30)

#: Below this much remaining an account is not handed to a NEW job: one started at
#: 2% headroom hits the wall almost at once and has to be swapped off again.
DEFAULT_ASSIGN_FLOOR = 0.15

#: How long a hold survives without being released. Longer than any call (the
#: transport times out long before) so it never expires under a live job; short
#: enough that a killed process costs one slot for a few hours, not forever.
DEFAULT_HOLD_TTL = timedelta(hours=3)

#: How long a closed hold record is kept: ``expires_at = released_at + 90 days``.
HOLD_LOG_RETENTION = timedelta(days=90)

#: How a hold ended.
HOLD_END_RELEASED = "released"
HOLD_END_UNUSABLE = "unusable"
HOLD_END_EXPIRED = "expired"
#: Given up for a hold on another account in one transaction (``swap_hold``).
HOLD_END_SWAPPED = "swapped"
#: The account was removed while the hold was open.
HOLD_END_ACCOUNT_REMOVED = "account_removed"
HOLD_ENDS = (
    HOLD_END_RELEASED,
    HOLD_END_UNUSABLE,
    HOLD_END_EXPIRED,
    HOLD_END_SWAPPED,
    HOLD_END_ACCOUNT_REMOVED,
)

#: Why a job moved from one account to another between turns.
#:   exhausted  the account it was on ran out of quota;
#:   drain      an owner set the account DRAINING, which marks every live hold to move;
#:   unusable   the account it had just moved to could not start the call.
SWAP_EXHAUSTED = "exhausted"
SWAP_DRAIN = "drain"
SWAP_UNUSABLE = "unusable"
SWAP_REASONS = (SWAP_EXHAUSTED, SWAP_DRAIN, SWAP_UNUSABLE)

#: What the refresher can answer for one account, recorded as ``last_refresh_reason``.
#: SwarmCloud's closed set; ``published_unverified`` and ``unverified_skipped`` cannot
#: happen here (Oracle can always read its own database) and stay for parity.
REFRESH_REASONS = (
    "no_refresh_credential",
    "store_unavailable",
    "unreadable",
    "still_valid",
    "published",
    "published_unverified",
    "unverified_skipped",
    "publish_failed",
    "reauth_required",
    "refresh_failed",
    "refreshed",
    # A job held the account and its token was not yet within the held margin.
    "held_deferred",
    "error",
)


class Unavailable(StrEnum):
    """Why no account could be assigned. Each one is a different wait."""

    #: The pool is empty: the caller falls back to the fallback credential.
    NO_ACCOUNTS_REGISTERED = "no_accounts_registered"
    #: Accounts exist and the binding window on every one is below the assign floor;
    #: at least one may say when it clears. A clock.
    NO_ACCOUNT_AVAILABLE = "no_account_available"
    #: Every account is paused, draining or needs re-authentication. A person.
    POOL_PAUSED = "pool_paused"
    #: Accounts have room by their last reading, but every reading is too old to act
    #: on. The next usage poll, minutes away -- not a clock, and not "spent".
    NO_RECENT_READING = "no_recent_reading"


class AccountState(StrEnum):
    #: Usable, and may be assigned to new jobs.
    AVAILABLE = "AVAILABLE"
    #: Usable by jobs already on it; assigned to no new ones.
    PAUSED = "PAUSED"
    #: No new assignments AND running jobs are moved off. Makes an account safely
    #: removable.
    DRAINING = "DRAINING"
    #: The refresh token is gone. Only a person can fix this, so the sweep stops
    #: trying rather than spend the token endpoint's rate limit every five minutes.
    REAUTH_REQUIRED = "REAUTH_REQUIRED"


#: States from which a job may still be STARTED.
ASSIGNABLE_STATES = frozenset({AccountState.AVAILABLE})
#: States a running job may remain on: pausing means "no new work", draining "get off".
USABLE_STATES = frozenset({AccountState.AVAILABLE, AccountState.PAUSED})


class AccountError(ValueError):
    pass


def validate_label(label: str) -> str:
    if not _LABEL.match(label or ""):
        raise AccountError(
            f"account label {label!r} must be lowercase letters, digits and dashes, "
            "starting and ending alphanumeric, at most 40 characters"
        )
    return label


@dataclass(frozen=True)
class WindowReading:
    """One rate-limit window as the API reported it."""

    #: 0.0 = untouched, 1.0 = exhausted.
    utilization: float
    resets_at: datetime
    #: When THIS window was read (readings arrive one window at a time). None on a
    #: window stored without it, which the account's ``observed_at`` dates. Not part
    #: of equality: two readings of the same figures are the same reading.
    observed_at: datetime | None = field(default=None, compare=False)

    def remaining(self) -> float:
        return max(0.0, 1.0 - self.utilization)

    def is_reset(self, now: datetime) -> bool:
        return now >= self.resets_at


@dataclass(frozen=True)
class Hold:
    """One job's claim on an account, with a deadline that makes the count self-correct."""

    assignment_id: str
    expires_at: datetime
    #: The built-in job that took it (``review_comments``, ``reporting``,
    #: ``refinement``) and that call's attempt id. Optional: descriptive only.
    task_id: str | None = None
    attempt_id: str | None = None
    assigned_at: datetime | None = None
    #: Set when this hold must MOVE to another account at the job's next turn
    #: boundary: ``drain`` when an owner set the account DRAINING.
    move: str | None = None
    #: Set on a hold taken by a SWAP: the account it came from and why it moved.
    swapped_from: str | None = None
    swap_reason: str | None = None

    def is_expired(self, now: datetime) -> bool:
        return now >= self.expires_at


@dataclass(frozen=True)
class Account:
    account_id: str
    label: str
    provider: str = "anthropic"
    state: AccountState = AccountState.AVAILABLE

    #: Per-window readings keyed by the API's own window name ("five_hour",
    #: "seven_day", ...): the windows are the provider's to define.
    windows: dict[str, WindowReading] = field(default_factory=dict)
    observed_at: datetime | None = None

    #: The live claims on this account, and ``assigned`` their projection.
    holds: tuple[Hold, ...] = ()
    assigned: int = 0

    #: When a call could not read this account's credential. Time-limited, so a
    #: freshly added account is not refused forever (``is_unreadable``).
    unreadable_at: datetime | None = None

    #: Why it is in its current state, for the person who has to act on it.
    reason: str = ""

    #: The state it held when the sweep marked it REAUTH_REQUIRED, so recovery gives
    #: back a pause or a drain a person chose instead of promoting it to AVAILABLE.
    #: None: nothing remembered, and recovery is AVAILABLE.
    state_before_reauth: AccountState | None = None

    #: When a job was last assigned this account, ever. None means NEVER.
    last_assigned_at: datetime | None = None

    #: What the refresh sweep last did with this account's credential.
    last_refresh_at: datetime | None = None
    token_expires_at: datetime | None = None
    last_refresh_reason: str = ""

    def live_holds(self, now: datetime) -> tuple[Hold, ...]:
        return tuple(h for h in self.holds if not h.is_expired(now))

    def is_unreadable(
        self, now: datetime, *, unreadable_after: timedelta = DEFAULT_STALE_AFTER
    ) -> bool:
        """Whether a call recently could not read this account's credential."""
        if self.unreadable_at is None:
            return False
        return now - _aware(self.unreadable_at) <= unreadable_after

    def headroom(self, now: datetime, *, stale_after: timedelta = DEFAULT_STALE_AFTER) -> float:
        """Fraction of capacity believed remaining, 0.0-1.0.

        The BINDING window decides, not the average. A window past its reset is full
        again. Never observed is optimistic on purpose (a new account must be
        assignable before it can report anything); a stale reading is halved.
        """
        if not self.windows or self.observed_at is None:
            return 1.0
        if now - self.observed_at > stale_after:
            return self._binding_remaining(now) * 0.5
        return self._binding_remaining(now)

    def _binding_remaining(self, now: datetime) -> float:
        return min((1.0 if w.is_reset(now) else w.remaining()) for w in self.windows.values())

    def is_stale(self, now: datetime, *, stale_after: timedelta = DEFAULT_STALE_AFTER) -> bool:
        """Whether the last reading is too old to act on. Never observed is NOT stale."""
        if self.observed_at is None:
            return False
        return now - self.observed_at > stale_after

    def next_reset(
        self,
        now: datetime,
        *,
        floor: float = DEFAULT_ASSIGN_FLOOR,
        stale_after: timedelta = DEFAULT_STALE_AFTER,
    ) -> datetime | None:
        """When this account becomes assignable again, or None if nothing is a clock.

        Uses ``headroom``'s rule, staleness included, so it agrees with ``choose``;
        only windows that actually constrain count.
        """
        spent = self.spent_by(now, floor=floor, stale_after=stale_after)
        return spent[1] if spent else None

    def spent_by(
        self,
        now: datetime,
        *,
        floor: float = DEFAULT_ASSIGN_FLOOR,
        stale_after: timedelta = DEFAULT_STALE_AFTER,
    ) -> tuple[str, datetime] | None:
        """The window that keeps this account below the floor and when it resets (the
        earliest, when more than one does), or None: ``next_reset`` with its window."""
        if self.headroom(now, stale_after=stale_after) >= floor:
            return None
        blocking = [
            (w.resets_at, name)
            for name, w in self.windows.items()
            if not w.is_reset(now) and w.remaining() < floor
        ]
        if not blocking:
            return None
        at, name = min(blocking)
        return name, at

    def with_reading(self, windows: dict[str, WindowReading], observed_at: datetime) -> Account:
        """This account with a reading folded in PER WINDOW, or unchanged.

        A merge, not a replacement: a reading carrying only ``seven_day`` keeps a
        binding ``five_hour``. Per window an OLDER reading is discarded (reports
        arrive out of order). A window no reading mentions is kept.
        """
        merged = dict(self.windows)
        changed = False
        for name, reading in windows.items():
            current = merged.get(name)
            dated = None
            if current is not None:
                dated = current.observed_at or self.observed_at
            if current is not None and dated is not None and observed_at <= dated:
                continue
            merged[name] = replace(reading, observed_at=observed_at)
            changed = True
        if not changed:
            return self
        newest = observed_at
        if self.observed_at is not None and self.observed_at > newest:
            newest = self.observed_at
        return replace(self, windows=merged, observed_at=newest)


def windows_to_json(windows: dict[str, WindowReading]) -> dict[str, Any]:
    """``Account.windows`` as stored. One spelling, for every writer of the map."""
    out: dict[str, Any] = {}
    for name, w in windows.items():
        item: dict[str, Any] = {
            "utilization": w.utilization,
            "resets_at": w.resets_at.isoformat(),
        }
        if w.observed_at is not None:
            item["observed_at"] = w.observed_at.isoformat()
        out[name] = item
    return out


def windows_from_json(raw: Any) -> dict[str, WindowReading]:
    windows: dict[str, WindowReading] = {}
    if not isinstance(raw, dict):
        return windows
    for name, item in raw.items():
        if not isinstance(item, dict):
            continue
        resets = _instant(item.get("resets_at"))
        if resets is None:
            continue
        windows[str(name)] = WindowReading(
            utilization=float(item.get("utilization", 0.0)),
            resets_at=resets,
            observed_at=_instant(item.get("observed_at")),
        )
    return windows


def holds_to_json(holds: Iterable[Hold]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for h in holds:
        item: dict[str, Any] = {
            "assignment_id": h.assignment_id,
            "expires_at": h.expires_at.isoformat(),
        }
        # Only when present, so a hold is written back in the shape it was read in.
        if h.task_id:
            item["task_id"] = h.task_id
        if h.attempt_id:
            item["attempt_id"] = h.attempt_id
        if h.assigned_at is not None:
            item["assigned_at"] = h.assigned_at.isoformat()
        if h.move:
            item["move"] = h.move
        if h.swapped_from:
            item["swapped_from"] = h.swapped_from
        if h.swap_reason:
            item["swap_reason"] = h.swap_reason
        out.append(item)
    return out


def holds_from_json(raw: Any) -> tuple[Hold, ...]:
    """Read holds back, dropping any that are not shaped like one.

    One bad hold must not make the account unreadable; a dropped hold under-counts by
    one, which ``choose`` survives. A malformed stamp reads as absent.
    """
    if not isinstance(raw, list | tuple):
        return ()
    holds: list[Hold] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        expires = _instant(item.get("expires_at"))
        assignment_id = item.get("assignment_id")
        if expires is None or not assignment_id:
            continue
        holds.append(
            Hold(
                assignment_id=str(assignment_id),
                expires_at=expires,
                task_id=_optional_text(item.get("task_id")),
                attempt_id=_optional_text(item.get("attempt_id")),
                assigned_at=_instant(item.get("assigned_at")),
                move=_optional_text(item.get("move")),
                swapped_from=_optional_text(item.get("swapped_from")),
                swap_reason=_optional_text(item.get("swap_reason")),
            )
        )
    return tuple(holds)


def hold_log_entry(
    hold: Hold,
    account_id: str,
    *,
    end: str | None = None,
    released_at: datetime | None = None,
    swapped_to: str | None = None,
    swap_reason: str | None = None,
) -> dict[str, Any]:
    """The hold log record for one hold, built from the HOLD every time.

    A close is a complete write, so a hold whose open record never landed still gets
    a whole one. ``expires_at`` is the retention deadline: from the close, or from
    the hold's own deadline while it is open, so a record whose hold is never closed
    still ages out. A swap is two records: the one left closes ``swapped`` naming
    where it went; the one taken opens with ``swapped_from``.
    """
    closed_at = released_at if end is not None else None
    anchor = closed_at if closed_at is not None else hold.expires_at
    return {
        "account_id": account_id,
        "task_id": hold.task_id,
        "attempt_id": hold.attempt_id,
        "assigned_at": hold.assigned_at,
        "released_at": closed_at,
        "end": end,
        "hold_expires_at": hold.expires_at,
        "expires_at": anchor + HOLD_LOG_RETENTION,
        "swapped_from": hold.swapped_from,
        "swapped_from_reason": hold.swap_reason if hold.swapped_from else None,
        "swapped_to": swapped_to if end == HOLD_END_SWAPPED else None,
        "swapped_to_reason": swap_reason if end == HOLD_END_SWAPPED else None,
    }


def _optional_text(raw: Any) -> str | None:
    return raw if isinstance(raw, str) and raw else None


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def _instant(raw: Any) -> datetime | None:
    if isinstance(raw, datetime):
        return _aware(raw)
    if isinstance(raw, str) and raw:
        try:
            return _aware(datetime.fromisoformat(raw.replace("Z", "+00:00")))
        except ValueError:
            return None
    return None


def optional_state(raw: Any) -> AccountState | None:
    """A remembered state, or None -- never an exception (it is advisory)."""
    if not raw:
        return None
    try:
        return AccountState(str(raw))
    except ValueError:
        return None


def choose(
    accounts: Iterable[Account],
    now: datetime,
    *,
    assign_floor: float = DEFAULT_ASSIGN_FLOOR,
    stale_after: timedelta = DEFAULT_STALE_AFTER,
    exclude: Iterable[str] = (),
) -> Account | None:
    """The account a new job should get, or None.

    Ordering: most headroom first; then fewest jobs already on it; then label, so the
    choice is deterministic. (SwarmCloud first prefers the tenant's own accounts over
    borrowed ones; Oracle has no lending, so every account is the company's own.)

    ``exclude`` is "not that one, I already tried it" -- without it the choice is
    deterministic and would hand back the same unusable account on every ask.
    """
    skip = {str(a) for a in exclude}
    candidates = [
        a
        for a in accounts
        if a.state in ASSIGNABLE_STATES
        and a.account_id not in skip
        and not a.is_unreadable(now, unreadable_after=stale_after)
        and a.headroom(now, stale_after=stale_after) >= assign_floor
    ]
    if not candidates:
        return None
    return min(
        candidates,
        key=lambda a: (-a.headroom(now, stale_after=stale_after), a.assigned, a.label),
    )


def eligibility(
    accounts: Iterable[Account],
    now: datetime,
    *,
    assign_floor: float = DEFAULT_ASSIGN_FLOOR,
    stale_after: timedelta = DEFAULT_STALE_AFTER,
    exclude: Iterable[str] = (),
) -> tuple[Unavailable, datetime | None]:
    """WHY nothing can be assigned, and when that changes.

    Call it only when ``choose`` returned None, with the same arguments, so the two
    cannot disagree. The second element is a reset INSTANT and only ever that.
    """
    serves = list(accounts)
    if not serves:
        return Unavailable.NO_ACCOUNTS_REGISTERED, None

    skip = {str(a) for a in exclude}
    mine = [
        a
        for a in serves
        if a.account_id not in skip and not a.is_unreadable(now, unreadable_after=stale_after)
    ]
    if not mine:
        # Accounts exist and this call has ruled every one out. A wait, not a
        # fallback: a broken pool must not quietly go back to the fallback credential.
        return Unavailable.NO_ACCOUNT_AVAILABLE, None

    assignable = [a for a in mine if a.state in ASSIGNABLE_STATES]
    if not assignable:
        return Unavailable.POOL_PAUSED, None

    resets = [
        r
        for r in (
            a.next_reset(now, floor=assign_floor, stale_after=stale_after) for a in assignable
        )
        if r is not None
    ]
    if resets:
        return Unavailable.NO_ACCOUNT_AVAILABLE, min(resets)

    if any(a.is_stale(now, stale_after=stale_after) for a in assignable):
        return Unavailable.NO_RECENT_READING, None

    return Unavailable.NO_ACCOUNT_AVAILABLE, None


def due_for_refresh(accounts: Iterable[Account], now: datetime) -> list[Account]:
    """Every account whose credential the sweep should look at now.

    NO "in use" filter: an idle account's refresh token rots unless it is exchanged.
    REAUTH_REQUIRED is excluded: its refresh token is already gone.
    """
    return [a for a in accounts if a.state is not AccountState.REAUTH_REQUIRED]
