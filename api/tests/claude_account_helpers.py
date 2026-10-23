"""Shared helpers for the Claude account pool tests."""

import json
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from oracle.claude_accounts import store
from oracle.claude_accounts.accounts import Account, AccountState, WindowReading
from oracle.claude_accounts.oauth import CredentialError, ReauthRequired
from oracle.claude_accounts.store import _locked
from oracle.tenancy import tenant_session


def now() -> datetime:
    return datetime.now(UTC)


def pair(access: str = "acc-1", refresh: str = "ref-1", expires_in: timedelta | None = None) -> str:
    """Claude Code's saved login, as a person would paste it."""
    expires = now() + (expires_in if expires_in is not None else timedelta(hours=8))
    return json.dumps(
        {
            "claudeAiOauth": {
                "accessToken": access,
                "refreshToken": refresh,
                "expiresAt": int(expires.timestamp() * 1000),
            }
        }
    )


async def add_account(
    tenant_id: uuid.UUID,
    label: str,
    *,
    access: str | None = None,
    refresh: str | None = None,
    expires_in: timedelta | None = None,
    state: AccountState | None = None,
    windows: dict[str, WindowReading] | None = None,
    observed_at: datetime | None = None,
) -> Account:
    access = access or f"acc-{label}"
    account = await store.register(
        tenant_id,
        label,
        pair=pair(access, refresh or f"ref-{label}", expires_in),
        access_token=access,
        added_by=None,
    )
    if state is not None:
        await store.set_state_and_moves(tenant_id, account.account_id, state, "", now=now())
    if windows is not None:
        await store.record_reading(tenant_id, account.account_id, windows, observed_at or now())
    async with tenant_session(tenant_id) as s:
        return await store.get(s, account.account_id)  # type: ignore[return-value]


async def edit_row(tenant_id: uuid.UUID, account_id: str, **values: Any) -> None:
    async with tenant_session(tenant_id) as s:
        row = await _locked(s, account_id)
        for k, v in values.items():
            setattr(row, k, v)
        await s.commit()


async def get_account(tenant_id: uuid.UUID, account_id: str) -> Account:
    async with tenant_session(tenant_id) as s:
        account = await store.get(s, account_id)
    assert account is not None
    return account


def window(utilization: float, resets_in: timedelta = timedelta(hours=2)) -> WindowReading:
    return WindowReading(utilization=utilization, resets_at=now() + resets_in)


class FakeEndpoint:
    """The token endpoint: rotates on every exchange, or refuses as told."""

    def __init__(self) -> None:
        self.exchanged: list[str] = []
        self.redeemed: list[dict[str, Any]] = []
        self.refuse: Exception | None = None
        self.refuse_once: Exception | None = None
        self.n = 0
        # Who the sign-in was for, as the token endpoint reports it beside the tokens.
        self.identity: dict[str, Any] = {
            "account": {"uuid": "acct-1", "email_address": "ada@example.com"},
            "organization": {"uuid": "org-1", "name": "Example Studio"},
        }

    async def exchange(self, refresh_token: str) -> dict[str, Any]:
        self.exchanged.append(refresh_token)
        if self.refuse_once is not None:
            error, self.refuse_once = self.refuse_once, None
            raise error
        if self.refuse is not None:
            raise self.refuse
        self.n += 1
        return {
            "access_token": f"acc-new-{self.n}",
            "refresh_token": f"ref-new-{self.n}",
            "expires_in": 8 * 3600,
        }

    async def redeem(
        self, *, code: str, verifier: str, redirect_uri: str, state: str = ""
    ) -> dict[str, Any]:
        self.redeemed.append(
            {"code": code, "verifier": verifier, "redirect_uri": redirect_uri, "state": state}
        )
        if code == "bad-code":
            raise CredentialError("the sign-in code was not accepted")
        return {
            "access_token": "acc-signed-in",
            "refresh_token": "ref-signed-in",
            "expires_in": 28800,
            **self.identity,
        }


REAUTH = ReauthRequired("the token endpoint rejected the refresh token (400)")
