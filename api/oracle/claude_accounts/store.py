"""Where accounts live, and every transaction that changes one.

Ported from SwarmCloud's ``quota_broker/accountstore.py`` and the hold transactions of
``quota_broker/main.py`` (``acquire_hold``, ``release_hold``, ``swap_hold``,
``prune_holds``, ``set_state_and_moves``, ``remove_account_and_close_holds``). Each
function here is ONE Postgres transaction in its own tenant session, with the account
row locked ``FOR UPDATE`` -- the Firestore transaction it replaces -- so a lost write
cannot make an account look busier or emptier than it is.

``assigned`` is a projection of ``holds`` and is written only from it
(``_hold_payload``). Every change to ``holds`` writes the hold log in the same
transaction: a record written after the counter commits could disagree with it.

The credential has exactly ONE writer, ``oracle.claude_accounts.credentials``, plus the
two ways in (a sign-in and a paste) which write a fresh pair.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import crypto
from oracle.claude_accounts.accounts import (
    DEFAULT_HOLD_TTL,
    DEFAULT_STALE_AFTER,
    HOLD_END_ACCOUNT_REMOVED,
    HOLD_END_EXPIRED,
    HOLD_END_RELEASED,
    HOLD_END_SWAPPED,
    HOLD_END_UNUSABLE,
    HOLD_LOG_RETENTION,
    SWAP_DRAIN,
    SWAP_UNUSABLE,
    Account,
    AccountError,
    AccountState,
    Hold,
    WindowReading,
    hold_log_entry,
    holds_from_json,
    holds_to_json,
    optional_state,
    validate_label,
    windows_from_json,
    windows_to_json,
)
from oracle.claude_accounts.models import ClaudeAccount, ClaudeAccountHold
from oracle.tenancy import tenant_session

log = logging.getLogger(__name__)

#: What decoding raises on a row it cannot read, and nothing else (an outage is not
#: one account being unreadable).
MALFORMED_ERRORS = (KeyError, ValueError, TypeError, AttributeError)

#: Suffix naming the long-lived half (SwarmCloud's ``{base}-refresh``).
REFRESH_SUFFIX = "-refresh"


class MalformedAccountError(AccountError):
    """An account row exists and cannot be decoded. Carries the id and class only."""

    def __init__(self, account_id: str, error: str) -> None:
        self.account_id = account_id
        self.error = error
        super().__init__(f"account {account_id!r} is malformed ({error})")


class HoldNotHeld(Exception):
    """The caller holds no live hold matching what it named."""


def _now() -> datetime:
    return datetime.now(UTC)


def to_account(row: ClaudeAccount) -> Account:
    try:
        return Account(
            account_id=str(row.id),
            label=row.label,
            provider=row.provider or "anthropic",
            state=AccountState(row.state),
            windows=windows_from_json(row.windows),
            observed_at=row.observed_at,
            holds=holds_from_json(row.holds),
            assigned=int(row.assigned),
            unreadable_at=row.unreadable_at,
            reason=row.reason or "",
            state_before_reauth=optional_state(row.state_before_reauth),
            last_assigned_at=row.last_assigned_at,
            last_refresh_at=row.last_refresh_at,
            token_expires_at=row.token_expires_at,
            last_refresh_reason=row.last_refresh_reason or "",
            claude_email=row.claude_email,
            claude_organization=row.claude_organization,
        )
    except MALFORMED_ERRORS as exc:
        error = type(exc).__name__
        log.warning("an account row is malformed", extra={"account_id": str(row.id)})
        raise MalformedAccountError(str(row.id), error) from None


@dataclass(frozen=True)
class AccountListing:
    """Every account that could be read, AND the rows that could not."""

    accounts: list[Account] = field(default_factory=list)
    unreadable: list[str] = field(default_factory=list)


async def list_reporting(session: AsyncSession) -> AccountListing:
    rows = (await session.scalars(select(ClaudeAccount).order_by(ClaudeAccount.label))).all()
    out: list[Account] = []
    unreadable: list[str] = []
    for row in rows:
        try:
            out.append(to_account(row))
        except MalformedAccountError:
            unreadable.append(str(row.id))
    if unreadable and not out:
        log.error("every account row is unreadable; the pool reads as empty")
    return AccountListing(accounts=out, unreadable=sorted(unreadable))


async def list_accounts(session: AsyncSession) -> list[Account]:
    return (await list_reporting(session)).accounts


async def get_row(session: AsyncSession, account_id: str | uuid.UUID) -> ClaudeAccount | None:
    try:
        key = account_id if isinstance(account_id, uuid.UUID) else uuid.UUID(str(account_id))
    except ValueError:
        return None
    return await session.get(ClaudeAccount, key)


async def get(session: AsyncSession, account_id: str | uuid.UUID) -> Account | None:
    row = await get_row(session, account_id)
    return None if row is None else to_account(row)


async def _locked(session: AsyncSession, account_id: str) -> ClaudeAccount | None:
    try:
        key = uuid.UUID(str(account_id))
    except ValueError:
        return None
    return await session.scalar(
        select(ClaudeAccount).where(ClaudeAccount.id == key).with_for_update()
    )


def _split_holds(row: ClaudeAccount, now: datetime) -> tuple[list[Hold], list[Hold]]:
    """(live, expired). Every path that drops the expired ones closes their records."""
    holds = holds_from_json(row.holds)
    return [h for h in holds if not h.is_expired(now)], [h for h in holds if h.is_expired(now)]


def _hold_payload(row: ClaudeAccount, holds: list[Hold]) -> None:
    """``assigned`` is written from ``holds`` and never independently of it."""
    row.holds = holds_to_json(holds)
    row.assigned = len(holds)


async def _write_log(session: AsyncSession, row: ClaudeAccount, entry: dict[str, Any]) -> None:
    hold_id = entry.pop("assignment_id")
    values = {**entry, "account_id": uuid.UUID(entry["account_id"]), "tenant_id": row.tenant_id}
    stmt = insert(ClaudeAccountHold).values(id=uuid.uuid4(), assignment_id=hold_id, **values)
    await session.execute(stmt.on_conflict_do_update(index_elements=["assignment_id"], set_=values))


async def _log(session: AsyncSession, row: ClaudeAccount, hold: Hold, **kw: Any) -> None:
    entry = hold_log_entry(hold, str(row.id), **kw)
    await _write_log(session, row, {"assignment_id": hold.assignment_id, **entry})


async def _close_expired(session: AsyncSession, row: ClaudeAccount, expired: list[Hold]) -> None:
    """Close lapsed holds' records at the hold's own deadline, in the caller's transaction."""
    for hold in expired:
        await _log(session, row, hold, end=HOLD_END_EXPIRED, released_at=hold.expires_at)


# --- the ways in -----------------------------------------------------------------------


async def register(
    tenant_id: uuid.UUID,
    label: str,
    *,
    pair: str,
    access_token: str,
    added_by: uuid.UUID | None,
    claude_email: str | None = None,
    claude_organization: str | None = None,
) -> Account:
    """Record an account and its credential, or replace the credential of one that exists.

    Re-registering keeps the state, holds and readings (it must not un-pause an
    account a person paused). Signing in again IS the fix for REAUTH_REQUIRED, so an
    account in that state gets its remembered state back once the new pair is stored.

    Who the credential is for is replaced with it, None included: a new pair may be a
    different Claude account, and the old name must not stay on it.
    """
    validate_label(label)
    async with tenant_session(tenant_id) as s:
        row = await s.scalar(
            select(ClaudeAccount).where(ClaudeAccount.label == label).with_for_update()
        )
        if row is None:
            row = ClaudeAccount(
                label=label,
                provider="anthropic",
                state=AccountState.AVAILABLE.value,
                reason="",
                windows={},
                holds=[],
                assigned=0,
                last_refresh_reason="",
                added_by=added_by,
            )
            s.add(row)
        else:
            to_account(row)  # refuse to overwrite a row nobody can read
        # The pair, then the access token: the means of getting more credentials first.
        row.credential_ciphertext = crypto.encrypt(pair.encode())
        row.credential_key_version = crypto.KEY_VERSION
        row.access_ciphertext = crypto.encrypt(access_token.encode())
        row.access_key_version = crypto.KEY_VERSION
        row.unreadable_at = None
        row.claude_email = claude_email
        row.claude_organization = claude_organization
        await s.commit()
        account_id = str(row.id)
        account = to_account(row)
    if account.state is AccountState.REAUTH_REQUIRED:
        account = await clear_reauth_required(tenant_id, account_id) or account
    return account


# --- state ---------------------------------------------------------------------------


async def set_state_and_moves(
    tenant_id: uuid.UUID, account_id: str, state: AccountState, reason: str, *, now: datetime
) -> int:
    """A person's state change, and the holds it moves, in ONE write. Returns how many.

    DRAINING marks every live hold ``move: drain`` in the same transaction as the state,
    so nobody reads "draining" while nothing is told to leave; leaving DRAINING clears
    the marks. ``state_before_reauth`` is cleared: a person decided.
    """
    async with tenant_session(tenant_id) as s:
        row = await _locked(s, account_id)
        if row is None:
            raise LookupError(account_id)
        live, expired = _split_holds(row, now)
        draining = state is AccountState.DRAINING
        marked = [
            replace(h, move=SWAP_DRAIN if draining else (None if h.move == SWAP_DRAIN else h.move))
            for h in live
        ]
        row.state = state.value
        row.reason = reason
        row.state_before_reauth = None
        _hold_payload(row, marked)
        await _close_expired(s, row, expired)
        await s.commit()
        return sum(1 for h in marked if h.move == SWAP_DRAIN)


async def mark_reauth_required(
    tenant_id: uuid.UUID, account_id: str, reason: str
) -> Account | None:
    """Record that the credential is dead, REMEMBERING the state it replaces.

    An account already marked is left exactly as it is, so the remembered state is not
    overwritten with REAUTH_REQUIRED itself.
    """
    async with tenant_session(tenant_id) as s:
        row = await _locked(s, account_id)
        if row is None:
            return None
        current = to_account(row)
        if current.state is AccountState.REAUTH_REQUIRED:
            return current
        row.state = AccountState.REAUTH_REQUIRED.value
        row.reason = reason
        row.state_before_reauth = current.state.value
        await s.commit()
        return to_account(row)


async def clear_reauth_required(tenant_id: uuid.UUID, account_id: str) -> Account | None:
    """Give a recovered account back the state it had (AVAILABLE if none was remembered).

    Called only where a credential has just been proven to work: a completed exchange
    or a freshly stored pair. Not on ``still_valid``, which never presents the refresh
    token.
    """
    async with tenant_session(tenant_id) as s:
        row = await _locked(s, account_id)
        if row is None:
            return None
        current = to_account(row)
        if current.state is not AccountState.REAUTH_REQUIRED:
            return current
        restored = current.state_before_reauth or AccountState.AVAILABLE
        row.state = restored.value
        row.reason = ""
        row.state_before_reauth = None
        await s.commit()
        return to_account(row)


async def remove_account_and_close_holds(
    tenant_id: uuid.UUID, account_id: str, *, now: datetime
) -> int:
    """Delete the account and close every open hold record it had, in one transaction.

    A live hold closes as ``account_removed``, an expired one as ``expired`` at its own
    deadline, and an open record whose hold is not on the row is closed too.
    """
    async with tenant_session(tenant_id) as s:
        row = await _locked(s, account_id)
        if row is None:
            return 0
        try:
            live, expired = _split_holds(row, now)
        except MALFORMED_ERRORS:
            live, expired = [], []
        closed = 0
        for hold in live:
            await _log(s, row, hold, end=HOLD_END_ACCOUNT_REMOVED, released_at=now)
            closed += 1
        await _close_expired(s, row, expired)
        covered = [h.assignment_id for h in [*live, *expired]]
        result = await s.execute(
            update(ClaudeAccountHold)
            .where(
                ClaudeAccountHold.account_id == row.id,
                ClaudeAccountHold.end.is_(None),
                ClaudeAccountHold.assignment_id.not_in(covered),
            )
            .values(
                end=HOLD_END_ACCOUNT_REMOVED,
                released_at=now,
                expires_at=now + HOLD_LOG_RETENTION,
            )
            .execution_options(synchronize_session=False)
        )
        closed += result.rowcount or 0  # type: ignore[attr-defined]
        await s.delete(row)
        await s.commit()
        return closed


# --- holds ---------------------------------------------------------------------------


async def acquire_hold(
    tenant_id: uuid.UUID,
    account_id: str,
    *,
    now: datetime,
    ttl: timedelta = DEFAULT_HOLD_TTL,
    task_id: str | None = None,
    attempt_id: str | None = None,
) -> tuple[str, int] | None:
    """Record one job's claim on an account. Returns (assignment_id, assigned).

    Eligibility is re-checked IN the transaction: the account may have been removed,
    paused or drained since the listing ``choose`` read. Expired holds are dropped on
    the way through and their records closed; the new hold's record opens here.
    """
    assignment_id = uuid.uuid4().hex
    async with tenant_session(tenant_id) as s:
        row = await _locked(s, account_id)
        if row is None or row.state != AccountState.AVAILABLE.value:
            return None
        holds, expired = _split_holds(row, now)
        hold = Hold(
            assignment_id=assignment_id,
            expires_at=now + ttl,
            task_id=task_id or None,
            attempt_id=attempt_id or None,
            assigned_at=now,
        )
        holds.append(hold)
        _hold_payload(row, holds)
        row.last_assigned_at = now
        await _log(s, row, hold)
        await _close_expired(s, row, expired)
        await s.commit()
        return assignment_id, len(holds)


async def release_hold(
    tenant_id: uuid.UUID,
    account_id: str,
    *,
    assignment_id: str,
    now: datetime,
    unusable: str = "",
) -> tuple[int | None, bool]:
    """Give one named assignment back. Returns (assigned, whether it was held).

    Idempotent: a second release finds nothing and writes nothing. ``unusable`` records
    that the credential could not be read, so the next call is not sent at the same
    wall, and closes the record as ``unusable``.
    """
    async with tenant_session(tenant_id) as s:
        row = await _locked(s, account_id)
        if row is None:
            return None, False
        holds, expired = _split_holds(row, now)
        held = [h for h in holds if h.assignment_id == assignment_id]
        remaining = [h for h in holds if h not in held]
        if not held and not expired:
            return len(remaining), False
        _hold_payload(row, remaining)
        if unusable and held:
            row.unreadable_at = now
        end = HOLD_END_UNUSABLE if unusable else HOLD_END_RELEASED
        for hold in held:
            await _log(s, row, hold, end=end, released_at=now)
        await _close_expired(s, row, expired)
        await s.commit()
        return len(remaining), bool(held)


async def hold_move(tenant_id: uuid.UUID, account_id: str, assignment_id: str) -> str | None:
    """Whether the caller's hold must move (``drain``), asked once per turn. One read."""
    async with tenant_session(tenant_id) as s:
        row = await get_row(s, account_id)
        if row is None:
            return None
        hold = next(
            (
                h
                for h in holds_from_json(row.holds)
                if h.assignment_id == assignment_id and not h.is_expired(_now())
            ),
            None,
        )
        if hold is None:
            return None
        return hold.move or (SWAP_DRAIN if row.state == AccountState.DRAINING.value else None)


async def swap_hold(
    tenant_id: uuid.UUID,
    from_account: str,
    to_account_id: str,
    *,
    assignment_id: str,
    reason: str,
    now: datetime,
    ttl: timedelta = DEFAULT_HOLD_TTL,
) -> tuple[str, int] | None:
    """Move one job's hold from one account to another, in ONE transaction.

    Returns (new assignment id, holders now on ``to_account_id``), or None when that
    account cannot take it -- nothing is written and the caller still holds what it
    held. Raises ``HoldNotHeld`` when the caller's hold is not live. So a job never
    holds two accounts at once, and never holds none while the swap succeeds.
    """
    if from_account == to_account_id:
        raise ValueError("a swap must move to a different account")
    new_id = uuid.uuid4().hex
    async with tenant_session(tenant_id) as s:
        # Both rows locked in id order, so two swaps in opposite directions cannot
        # deadlock.
        first, second = sorted([from_account, to_account_id])
        rows = {first: await _locked(s, first), second: await _locked(s, second)}
        src, dst = rows[from_account], rows[to_account_id]
        if src is None:
            raise HoldNotHeld(from_account)
        live, expired = _split_holds(src, now)
        held = next((h for h in live if h.assignment_id == assignment_id), None)
        if held is None:
            raise HoldNotHeld(from_account)
        if dst is None or dst.state != AccountState.AVAILABLE.value:
            return None
        to_live, to_expired = _split_holds(dst, now)
        taken = Hold(
            assignment_id=new_id,
            expires_at=now + ttl,
            task_id=held.task_id,
            attempt_id=held.attempt_id,
            assigned_at=now,
            swapped_from=from_account,
            swap_reason=reason,
        )
        _hold_payload(src, [h for h in live if h.assignment_id != held.assignment_id])
        if reason == SWAP_UNUSABLE:
            src.unreadable_at = now
        _hold_payload(dst, [*to_live, taken])
        dst.last_assigned_at = now
        await _log(
            s,
            src,
            held,
            end=HOLD_END_SWAPPED,
            released_at=now,
            swapped_to=to_account_id,
            swap_reason=reason,
        )
        await _log(s, dst, taken)
        await _close_expired(s, src, expired)
        await _close_expired(s, dst, to_expired)
        await s.commit()
        return new_id, len(to_live) + 1


async def prune_holds(
    tenant_id: uuid.UUID,
    account_id: str,
    *,
    now: datetime,
    forget_unreadable_after: timedelta = DEFAULT_STALE_AFTER,
) -> int:
    """Drop expired holds and an aged-out unreadable report. Returns how many holds went.

    The last backstop for a job killed without releasing; the sweep calls it for every
    account on every tick. Writes nothing when nothing changed.
    """
    async with tenant_session(tenant_id) as s:
        row = await _locked(s, account_id)
        if row is None:
            return 0
        holds = holds_from_json(row.holds)
        live = [h for h in holds if not h.is_expired(now)]
        dropped = len(holds) - len(live)
        stale_report = (
            row.unreadable_at is not None and now - row.unreadable_at > forget_unreadable_after
        )
        if not dropped and not stale_report and row.assigned == len(live):
            return 0
        _hold_payload(row, live)
        if stale_report:
            row.unreadable_at = None
        await _close_expired(s, row, [h for h in holds if h.is_expired(now)])
        await s.commit()
        return dropped


# --- readings and refresh outcomes ---------------------------------------------------


async def record_reading(
    tenant_id: uuid.UUID,
    account_id: str,
    windows: dict[str, WindowReading],
    observed_at: datetime,
) -> Account | None:
    """Fold a reading in, window by window (``Account.with_reading``), in a transaction."""
    async with tenant_session(tenant_id) as s:
        row = await _locked(s, account_id)
        if row is None:
            return None
        current = to_account(row)
        updated = current.with_reading(windows, observed_at)
        if updated is current:
            return current
        row.windows = windows_to_json(updated.windows)
        row.observed_at = updated.observed_at
        await s.commit()
        return updated


async def record_refresh(
    tenant_id: uuid.UUID,
    account_id: str,
    *,
    at: datetime,
    reason: str,
    expires_at: datetime | None,
) -> bool:
    """Write what the refresh sweep did. ``token_expires_at`` only when the outcome has one."""
    async with tenant_session(tenant_id) as s:
        row = await get_row(s, account_id)
        if row is None:
            return False
        row.last_refresh_at = at
        row.last_refresh_reason = reason
        if expires_at is not None:
            row.token_expires_at = expires_at
        await s.commit()
        return True


# --- the secret store ----------------------------------------------------------------


class DbSecretStore:
    """SwarmCloud's two secrets per account, as two encrypted columns of its row.

    ``<account id>-refresh`` is the pair and ``<account id>`` the access token. Each
    ``add_version`` is its own transaction, so the refresher's write ORDER holds: the
    rotated pair is committed before the access token is.
    """

    def __init__(self, tenant_id: uuid.UUID) -> None:
        self.tenant_id = tenant_id

    @staticmethod
    def _split(name: str) -> tuple[str, bool]:
        if name.endswith(REFRESH_SUFFIX):
            return name[: -len(REFRESH_SUFFIX)], True
        return name, False

    async def access(self, name: str) -> str:
        """The payload. Raises KeyError -- and only KeyError -- when there is none."""
        account_id, pair = self._split(name)
        async with tenant_session(self.tenant_id) as s:
            row = await get_row(s, account_id)
            if row is None:
                raise KeyError(name)
            blob = row.credential_ciphertext if pair else row.access_ciphertext
            if not blob:
                raise KeyError(name)
            return crypto.decrypt(blob).decode()

    async def add_version(self, name: str, payload: str) -> None:
        account_id, pair = self._split(name)
        async with tenant_session(self.tenant_id) as s:
            row = await _locked(s, account_id)
            if row is None:
                raise KeyError(name)
            blob = crypto.encrypt(payload.encode())
            if pair:
                row.credential_ciphertext, row.credential_key_version = blob, crypto.KEY_VERSION
            else:
                row.access_ciphertext, row.access_key_version = blob, crypto.KEY_VERSION
            await s.commit()


def secret_for(account: Account) -> str:
    """The base name of an account's credential pair in ``DbSecretStore``."""
    return account.account_id
