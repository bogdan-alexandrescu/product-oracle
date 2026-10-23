"""The Claude account pool's API: list, add (browser sign-in or paste), state, refresh,
remove, holders, history, and the fallback credential.

Ported from SwarmCloud's broker routes (``quota_broker/main.py``) and swarm-api's
proxy (``swarm_api/routes/accounts.py``). Every member may read the pool; every change
needs the owner role. No route returns key material, not even a length.

The company comes from the caller's session, never from a request field. An account
id that is not this company's answers 404, the same as one that does not exist.
"""

import re
import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from oracle import audit
from oracle.auth.deps import Principal, TenantDB
from oracle.authz import recheck_caller, require_role, require_role_now
from oracle.claude_accounts import fallback, store
from oracle.claude_accounts.accounts import (
    DEFAULT_STALE_AFTER,
    HOLD_END_SWAPPED,
    HOLD_ENDS,
    HOLD_LOG_RETENTION,
    SWAP_REASONS,
    Account,
    AccountError,
    AccountState,
    Hold,
    Unavailable,
    choose,
    eligibility,
    validate_label,
)
from oracle.claude_accounts.models import ClaudeAccountHold, ClaudeAccountSignin
from oracle.claude_accounts.oauth import (
    OAUTH_REDIRECT_URI,
    PENDING_TTL,
    CredentialError,
    build_authorize_url,
    challenge_for,
    credential_from_token_response,
    new_state,
    new_verifier,
    parse_credential,
    serialise,
    split_pasted_code,
)
from oracle.claude_accounts.sweep import get_token_endpoint, liveness, refresher_for
from oracle.claude_accounts.sweep import sweep as run_sweep
from oracle.company_time import company_time_zone

router = APIRouter(prefix="/v1/claude-accounts", tags=["claude-accounts"])

Member = Annotated[Principal, Depends(require_role("viewer"))]
Owner = Annotated[Principal, Depends(require_role("owner"))]
OwnerNow = Annotated[Principal, Depends(require_role_now("owner"))]

#: Refresh outcomes that mean only a person can fix the credential.
CREDENTIAL_NEEDS_A_HUMAN = ("reauth_required", "unreadable")

HISTORY_PAGE = 100
HISTORY_PAGE_MAX = 500
HISTORY_DEFAULT_SPAN = timedelta(days=7)

NOTE = "stored encrypted and write-only; no route returns key material"


# --- schemas ------------------------------------------------------------------------


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class WindowOut(BaseModel):
    utilization: float
    resets_at: datetime
    # True once the window has passed its reset: the figure describes the one before.
    reset: bool


class AccountOut(BaseModel):
    account_id: str
    label: str
    provider: str
    state: Literal["AVAILABLE", "PAUSED", "DRAINING", "REAUTH_REQUIRED"]
    reason: str
    assigned: int
    windows: dict[str, WindowOut]
    observed_at: datetime | None
    # No reading recent enough to trust. Distinct from "utilization is zero".
    stale: bool
    # A call recently could not read its credential, so the pool skips it for now.
    unreadable_now: bool
    last_refresh_at: datetime | None
    token_expires_at: datetime | None
    last_refresh_reason: str | None
    # Null means NEVER assigned.
    last_assigned_at: datetime | None
    # Whether the pool would give it a call now: ``choose`` on this account alone.
    takes_calls: bool
    # An AVAILABLE account the pool will not choose because a window is below the assign
    # floor: that window (``seven_day``, ``five_hour``) and when it resets. Null otherwise.
    spent_by: str | None
    spent_until: datetime | None


class PoolOut(BaseModel):
    """Whether Oracle's built-in calls can run now, as the gateway decides it."""

    # An account the pool would choose, or no account registered and a fallback set.
    takes_calls: bool
    # Why not (``eligibility``): no_accounts_registered, no_account_available,
    # pool_paused or no_recent_reading. Null when it takes calls.
    reason: str | None
    # When the earliest spent window clears, if a clock is what it waits on.
    until: datetime | None


class RefreshSweepOut(BaseModel):
    last_completed_at: datetime | None
    last_outcome: Literal["ok", "error"] | None
    readable: bool


class FallbackOut(BaseModel):
    kind: Literal["plan", "api_key"]
    label: str
    updated_at: datetime


class AccountsPage(BaseModel):
    accounts: list[AccountOut]
    # Rows the store could not decode: the list is short by exactly this many.
    unreadable_documents: list[str]
    unreadable_document_count: int
    refresh_sweep: RefreshSweepOut
    # The credential used while no account is registered.
    fallback: FallbackOut | None
    pool: PoolOut
    # The company's time zone, which a person reads these times in.
    time_zone: str


class AuthorizeIn(Strict):
    label: str = Field(min_length=1, max_length=64)


class AuthorizeOut(BaseModel):
    authorize_url: str
    state: str
    expires_in_seconds: int


class ExchangeIn(Strict):
    state: str = Field(min_length=8, max_length=256)
    # As pasted: the callback page shows `<code>#<state>`.
    code: str = Field(min_length=4, max_length=2048)


class RegisterIn(Strict):
    label: str = Field(min_length=1, max_length=64)
    # Claude Code's saved login, pasted verbatim. Write-only.
    credential: str = Field(min_length=8, max_length=16384)


class AccountCreated(BaseModel):
    account: AccountOut
    expires_at: datetime
    note: str


class StateIn(Strict):
    state: str = Field(min_length=1, max_length=32)
    reason: str = Field(default="", max_length=512)


class StateOut(BaseModel):
    account: AccountOut
    # Holds marked to move off (DRAINING).
    moving: int


class RefreshResult(BaseModel):
    account_id: str
    refreshed: bool
    reason: str
    expires_at: datetime | None


class RefreshOut(BaseModel):
    refresh: RefreshResult
    account: AccountOut


class RemovedOut(BaseModel):
    removed: str
    label: str
    # Open hold records closed as account_removed.
    closed_holds: int
    # The credential lived on the account's row, so it went with it.
    credential: Literal["deleted"]


class HolderOut(BaseModel):
    # The built-in job that holds it, and that call's attempt.
    task_id: str | None
    attempt_id: str | None
    since: datetime | None
    expires_at: datetime
    swapped_from: str | None
    swapped_from_reason: str | None
    move: str | None


class HoldersOut(BaseModel):
    account_id: str
    total: int
    holders: list[HolderOut]


class SpanOut(BaseModel):
    task_id: str | None
    attempt_id: str | None
    since: datetime | None
    until: datetime | None
    end: str | None
    hold_expires_at: datetime | None
    swapped_from: str | None
    swapped_from_reason: str | None
    swapped_to: str | None
    swapped_to_reason: str | None


class HistoryOut(BaseModel):
    account_id: str
    from_: datetime = Field(serialization_alias="from")
    to: datetime
    spans: list[SpanOut]
    next_cursor: str | None


class FallbackIn(Strict):
    # A `claude setup-token` value or an Anthropic API key. Write-only.
    token: str = Field(min_length=8, max_length=4096)


class SweepOut(BaseModel):
    result: dict[str, Any]


# --- shaping ------------------------------------------------------------------------


def account_out(account: Account, *, now: datetime | None = None) -> AccountOut:
    """One account for a person to read. ``stale`` is computed: the server owns the clock."""
    now = now or datetime.now(UTC)
    observed = account.observed_at
    takes = account.provider == "anthropic" and choose([account], now) is not None
    spent = (
        None
        if takes or account.state is not AccountState.AVAILABLE or account.is_unreadable(now)
        else account.spent_by(now)
    )
    return AccountOut(
        account_id=account.account_id,
        label=account.label,
        provider=account.provider,
        state=account.state.value,  # type: ignore[arg-type]
        reason=account.reason,
        assigned=account.assigned,
        windows={
            name: WindowOut(
                utilization=round(float(w.utilization), 4),
                resets_at=w.resets_at,
                reset=w.is_reset(now),
            )
            for name, w in account.windows.items()
        },
        observed_at=observed,
        stale=True if observed is None else (now - observed) > DEFAULT_STALE_AFTER,
        unreadable_now=account.is_unreadable(now),
        last_refresh_at=account.last_refresh_at,
        token_expires_at=account.token_expires_at,
        last_refresh_reason=account.last_refresh_reason or None,
        last_assigned_at=account.last_assigned_at,
        takes_calls=takes,
        spent_by=spent[0] if spent else None,
        spent_until=spent[1] if spent else None,
    )


def pool_out(accounts: list[Account], *, has_fallback: bool, now: datetime) -> PoolOut:
    """The pool's own answer (``choose``, then ``eligibility``), so the page cannot say
    Available while the gateway refuses."""
    candidates = [a for a in accounts if a.provider == "anthropic"]
    if choose(candidates, now) is not None:
        return PoolOut(takes_calls=True, reason=None, until=None)
    reason, until = eligibility(candidates, now)
    if reason is Unavailable.NO_ACCOUNTS_REGISTERED and has_fallback:
        return PoolOut(takes_calls=True, reason=None, until=None)
    return PoolOut(takes_calls=False, reason=reason.value, until=until)


async def _own(db: TenantDB, account_id: str) -> Account:
    try:
        account = await store.get(db, account_id)
    except store.MalformedAccountError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from None
    if account is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No Claude account {account_id!r}")
    return account


async def _fresh(db: TenantDB, account_id: str) -> Account:
    db.expire_all()
    return await _own(db, account_id)


def _label(raw: str) -> str:
    try:
        return validate_label(raw.strip())
    except AccountError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from None


def _unprocessable(message: str) -> HTTPException:
    return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, message)


# --- the pool -----------------------------------------------------------------------


@router.get("", response_model=AccountsPage)
async def list_claude_accounts(principal: Member, db: TenantDB) -> AccountsPage:
    """Every account in the company's pool, with the sweep's liveness and the fallback."""
    listing = await store.list_reporting(db)
    now = datetime.now(UTC)
    spare = await fallback.describe(db)
    return AccountsPage(
        accounts=[account_out(a, now=now) for a in listing.accounts],
        unreadable_documents=listing.unreadable,
        unreadable_document_count=len(listing.unreadable),
        refresh_sweep=RefreshSweepOut(**await liveness(db)),
        fallback=None
        if spare is None
        else FallbackOut(kind=spare.kind, label=spare.label, updated_at=spare.updated_at),  # type: ignore[arg-type]
        pool=pool_out(listing.accounts, has_fallback=spare is not None, now=now),
        time_zone=await company_time_zone(db),
    )


@router.post("/authorize", response_model=AuthorizeOut)
async def begin_claude_sign_in(
    body: AuthorizeIn, principal: OwnerNow, db: TenantDB
) -> AuthorizeOut:
    """Start a browser sign-in: the URL to open, and the ``state`` that keys it.

    The PKCE verifier stays here, keyed by ``state``; the browser never holds it.
    """
    label = _label(body.label)
    verifier, state = new_verifier(), new_state()
    url = build_authorize_url(state=state, code_challenge=challenge_for(verifier))
    db.add(
        ClaudeAccountSignin(state=state, verifier=verifier, label=label, started_by=principal.id)
    )
    await db.commit()
    return AuthorizeOut(
        authorize_url=url, state=state, expires_in_seconds=int(PENDING_TTL.total_seconds())
    )


@router.post(
    "/exchange",
    response_model=AccountCreated,
    status_code=status.HTTP_201_CREATED,
    responses={403: {"description": "Someone else started this sign-in"}},
)
async def finish_claude_sign_in(body: ExchangeIn, principal: Owner, db: TenantDB) -> AccountCreated:
    """Redeem the pasted code and add the account.

    Only whoever started the sign-in may finish it, checked BEFORE the code is redeemed:
    a mismatch redeems nothing and leaves the pending sign-in for its owner. Where the
    account lands (its label) comes from the pending sign-in, never from this request.
    """
    code, pasted_state = split_pasted_code(body.code)
    if pasted_state and pasted_state != body.state:
        raise _unprocessable(
            "The pasted code belongs to a different sign-in than the one this page "
            "started. Press Add account and sign in again."
        )
    pending = await db.scalar(
        select(ClaudeAccountSignin).where(ClaudeAccountSignin.state == body.state)
    )
    if pending is None:
        raise _unprocessable(
            "This sign-in has expired or was already completed. Codes are single-use; "
            "press Add account to start again."
        )
    if pending.started_by != principal.id:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "This sign-in was started by someone else; only they can finish it. Press "
            "Add account to start your own.",
        )
    if datetime.now(UTC) - pending.created_at > PENDING_TTL:
        await db.delete(pending)
        await db.commit()
        raise _unprocessable(
            "This sign-in took too long and the code will have expired. Press Add account "
            "to start again."
        )
    try:
        payload = await get_token_endpoint().redeem(
            code=code,
            verifier=pending.verifier,
            redirect_uri=OAUTH_REDIRECT_URI,
            state=body.state,
        )
        credential = credential_from_token_response(payload)
    except CredentialError as e:
        # The pending sign-in stays, so the person can paste again.
        raise _unprocessable(str(e)) from None
    # The redeem is a network call: the caller is re-read under the gate after it, and the
    # gate is held until the account is recorded.
    await recheck_caller(db, principal, "owner")
    label = pending.label
    account = await store.register(
        principal.tenant_id,
        label,
        pair=serialise(credential),
        access_token=credential.access_token,
        added_by=principal.id,
    )
    # Single-use, deleted only once the account exists.
    await db.delete(pending)
    await audit.record(
        db, principal, "claude_account.add", "claude_account", uuid.UUID(account.account_id),
        {"label": label, "via": "sign_in"},
    )  # fmt: skip
    await db.commit()
    return AccountCreated(account=account_out(account), expires_at=credential.expires_at, note=NOTE)


@router.post("", response_model=AccountCreated, status_code=status.HTTP_201_CREATED)
async def add_claude_account(body: RegisterIn, principal: OwnerNow, db: TenantDB) -> AccountCreated:
    """Add an account from Claude Code's saved login, pasted verbatim.

    It must be a PAIR: a credential with no refresh token cannot be kept alive, so it is
    refused here rather than dying silently at its first expiry.
    """
    label = _label(body.label)
    try:
        credential = parse_credential(body.credential)
    except CredentialError as e:
        raise _unprocessable(str(e)) from None
    account = await store.register(
        principal.tenant_id,
        label,
        pair=body.credential,
        access_token=credential.access_token,
        added_by=principal.id,
    )
    await audit.record(
        db, principal, "claude_account.add", "claude_account", uuid.UUID(account.account_id),
        {"label": label, "via": "paste"},
    )  # fmt: skip
    await db.commit()
    return AccountCreated(account=account_out(account), expires_at=credential.expires_at, note=NOTE)


# --- the fallback credential and the sweep ------------------------------------------


@router.put("/fallback", response_model=FallbackOut)
async def set_claude_fallback(body: FallbackIn, principal: OwnerNow, db: TenantDB) -> FallbackOut:
    """Set the credential used while no account is registered (setup-token or API key)."""
    try:
        row = await fallback.store(db, body.token, principal.id)
    except fallback.NotAClaudeCredential as e:
        raise _unprocessable(str(e)) from None
    await audit.record(
        db, principal, "claude_fallback.set", "claude_fallback", row.id, {"kind": row.kind}
    )
    await db.commit()
    await db.refresh(row)
    return FallbackOut(kind=row.kind, label=row.label, updated_at=row.updated_at)  # type: ignore[arg-type]


@router.delete("/fallback", status_code=status.HTTP_204_NO_CONTENT)
async def clear_claude_fallback(principal: OwnerNow, db: TenantDB) -> None:
    await fallback.clear(db)
    await audit.record(db, principal, "claude_fallback.clear", "claude_fallback")
    await db.commit()


@router.post("/sweep", response_model=SweepOut)
async def sweep_claude_accounts(principal: Owner, db: TenantDB) -> SweepOut:
    """Run the sweep now: reclaim holds, refresh credentials, read usage. Within five
    minutes of the last sweep's completion only the holds are reclaimed
    (``sweep_lease.not_due``): Claude's usage endpoint allows about five calls per five
    minutes per account."""
    # Checked now; the sweep's network calls do not hold the gate (it writes nothing an
    # owner decides: the tick runs the same sweep).
    await recheck_caller(db, principal, "owner")
    await db.commit()
    return SweepOut(result=await run_sweep(principal.tenant_id))


@router.put("/{account_id}/state", response_model=StateOut)
async def set_claude_account_state(
    account_id: str, body: StateIn, principal: OwnerNow, db: TenantDB
) -> StateOut:
    """AVAILABLE, PAUSED, DRAINING or REAUTH_REQUIRED. DRAINING marks every live hold to
    move at its next turn boundary, in the same transaction."""
    account = await _own(db, account_id)
    try:
        state = AccountState(body.state.strip().upper())
    except ValueError:
        raise _unprocessable(
            f"unknown account state {body.state!r}; known: "
            f"{', '.join(s.value for s in AccountState)}"
        ) from None
    moving = await store.set_state_and_moves(
        principal.tenant_id, account.account_id, state, body.reason.strip(), now=datetime.now(UTC)
    )
    await audit.record(
        db, principal, "claude_account.state", "claude_account", uuid.UUID(account.account_id),
        {"label": account.label, "state": state.value, "reason": body.reason.strip()},
    )  # fmt: skip
    await db.commit()
    return StateOut(account=account_out(await _fresh(db, account_id)), moving=moving)


@router.post("/{account_id}/refresh", response_model=RefreshOut)
async def refresh_claude_account(account_id: str, principal: Owner, db: TenantDB) -> RefreshOut:
    """Exchange this account's credential now, through the same single writer as the
    sweep, and say what happened."""
    # Checked now; the exchange does not hold the gate (the sweep makes the same one).
    await recheck_caller(db, principal, "owner")
    await db.commit()
    account = await _own(db, account_id)
    outcome = await refresher_for(principal.tenant_id).refresh_secret(store.secret_for(account))
    await store.record_refresh(
        principal.tenant_id,
        account.account_id,
        at=datetime.now(UTC),
        reason=outcome.reason,
        expires_at=outcome.expires_at,
    )
    if outcome.reason in CREDENTIAL_NEEDS_A_HUMAN:
        await store.mark_reauth_required(
            principal.tenant_id, account.account_id, f"refresh failed: {outcome.reason}"
        )
    elif outcome.reason == "refreshed":
        # A completed exchange proves the refresh token works.
        await store.clear_reauth_required(principal.tenant_id, account.account_id)
    return RefreshOut(
        refresh=RefreshResult(**outcome.as_dict()),
        account=account_out(await _fresh(db, account_id)),
    )


@router.delete("/{account_id}", response_model=RemovedOut)
async def remove_claude_account(account_id: str, principal: OwnerNow, db: TenantDB) -> RemovedOut:
    """Remove the account; its open hold records close as ``account_removed``."""
    account = await _own(db, account_id)
    closed = await store.remove_account_and_close_holds(
        principal.tenant_id, account.account_id, now=datetime.now(UTC)
    )
    await audit.record(
        db, principal, "claude_account.remove", "claude_account", uuid.UUID(account.account_id),
        {"label": account.label, "closed_holds": closed},
    )  # fmt: skip
    await db.commit()
    return RemovedOut(
        removed=account.account_id, label=account.label, closed_holds=closed, credential="deleted"
    )


# --- who holds it, and who held it --------------------------------------------------


def _holder(h: Hold) -> HolderOut:
    return HolderOut(
        task_id=h.task_id,
        attempt_id=h.attempt_id,
        since=h.assigned_at,
        expires_at=h.expires_at,
        swapped_from=h.swapped_from,
        swapped_from_reason=h.swap_reason if h.swapped_from else None,
        move=h.move,
    )


@router.get("/{account_id}/holders", response_model=HoldersOut)
async def claude_account_holders(account_id: str, principal: Member, db: TenantDB) -> HoldersOut:
    """The LIVE holds: an expired one is a killed job, not a holder."""
    account = await _own(db, account_id)
    live = account.live_holds(datetime.now(UTC))
    return HoldersOut(
        account_id=account.account_id, total=len(live), holders=[_holder(h) for h in live]
    )


def _instant(raw: str, name: str, now: datetime) -> datetime:
    try:
        value = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if value.tzinfo is None:
            raise _unprocessable(f"`{name}` must carry a UTC offset")
        value = value.astimezone(UTC)
    except (ValueError, OverflowError):
        raise _unprocessable(f"`{name}` must be an ISO 8601 instant with an offset") from None
    if not now - HOLD_LOG_RETENTION - timedelta(days=1) <= value <= now + timedelta(days=1):
        raise _unprocessable(f"`{name}` is outside the range the hold log retains")
    return value


_COUNT = re.compile(r"^[0-9]{1,4}$")


def _cursor(raw: str, now: datetime) -> tuple[datetime, int]:
    """``<instant>|<n served at that instant>``, as the previous page minted it."""
    instant, sep, count = raw.rpartition("|")
    if not sep or not _COUNT.match(count) or int(count) > HISTORY_PAGE_MAX:
        raise _unprocessable("the cursor is not one this route issued")
    return _instant(instant, "cursor", now), int(count)


def _span(r: ClaudeAccountHold) -> SpanOut:
    end = r.end if r.end in HOLD_ENDS else None
    return SpanOut(
        task_id=r.task_id,
        attempt_id=r.attempt_id,
        since=r.assigned_at,
        until=r.released_at,
        end=end,
        hold_expires_at=r.hold_expires_at,
        swapped_from=r.swapped_from,
        swapped_from_reason=r.swapped_from_reason
        if r.swapped_from_reason in SWAP_REASONS
        else None,
        swapped_to=r.swapped_to if end == HOLD_END_SWAPPED else None,
        swapped_to_reason=(
            r.swapped_to_reason
            if end == HOLD_END_SWAPPED and r.swapped_to_reason in SWAP_REASONS
            else None
        ),
    )


@router.get("/{account_id}/history", response_model=HistoryOut, response_model_by_alias=True)
async def claude_account_history(
    account_id: str,
    principal: Member,
    db: TenantDB,
    start: Annotated[str | None, Query(alias="from")] = None,
    end: Annotated[str | None, Query(alias="to")] = None,
    cursor: Annotated[str | None, Query(max_length=80)] = None,
    limit: Annotated[int, Query(ge=1, le=HISTORY_PAGE_MAX)] = HISTORY_PAGE,
) -> HistoryOut:
    """Recorded spans taken in [from, to), newest first (default: the last 7 days).

    A cursor is ``<instant>|<n>``: the last ``assigned_at`` served and how many rows at
    that instant were served, so ties are not dropped. Windows over 90 days, and
    cursors this route did not mint, are refused.
    """
    account = await _own(db, account_id)
    now = datetime.now(UTC)
    until = _instant(end, "to", now) if end else now
    since = _instant(start, "from", now) if start else until - HISTORY_DEFAULT_SPAN
    if since >= until:
        raise _unprocessable("`from` must be earlier than `to`")
    if until - since > HOLD_LOG_RETENTION:
        raise _unprocessable(
            f"the window `from`..`to` may span at most {HOLD_LOG_RETENTION.days} days"
        )
    position = _cursor(cursor, now) if cursor else None
    if position is not None and position[0] >= until:
        raise _unprocessable("the cursor is outside the window")
    top = position[0] if position is not None else until
    skip = position[1] if position is not None else 0
    upper = (
        ClaudeAccountHold.assigned_at <= top
        if position is not None
        else ClaudeAccountHold.assigned_at < top
    )
    rows = list(
        (
            await db.scalars(
                select(ClaudeAccountHold)
                .where(
                    ClaudeAccountHold.account_id == uuid.UUID(account.account_id),
                    ClaudeAccountHold.assigned_at >= since,
                    upper,
                )
                .order_by(ClaudeAccountHold.assigned_at.desc(), ClaudeAccountHold.id)
                .limit(limit + skip + 1)
            )
        ).all()
    )[skip:]
    more = len(rows) > limit
    page = rows[:limit]
    next_cursor = None
    if more and page:
        last = page[-1].assigned_at
        at_last = sum(1 for r in page if r.assigned_at == last)
        if position is not None and last == position[0]:
            at_last += skip
        assert last is not None
        next_cursor = f"{last.astimezone(UTC).isoformat()}|{at_last}"
    return HistoryOut(
        account_id=account.account_id,
        from_=since,
        to=until,
        spans=[_span(r) for r in page],
        next_cursor=next_cursor,
    )
