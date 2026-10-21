"""Company integrations (F6 §4): Settings › Notifications, owners only.

Connect installs Oracle's Slack app once for the company (Slack's OAuth v2); a second
Connect while one exists is refused (409). The owner then picks a channel (the
``alignment_report`` setting) and can send a test message. Disconnect revokes the bot
token at Slack and deletes it. No endpoint returns the token.
"""

import uuid
from datetime import datetime
from typing import Annotated, Literal
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select

from oracle import audit, crypto
from oracle.auth.deps import CurrentPrincipal, Principal, TenantDB
from oracle.auth.models import User
from oracle.auth.service import may_sign_in
from oracle.authz import recheck_caller, require_role
from oracle.connections import oauth
from oracle.integrations import slack_api, slack_oauth
from oracle.integrations.models import CompanyIntegration
from oracle.reports.alignment import CHANNEL_ID
from oracle.tenancy import tenant_session
from oracle.tenant_settings import TenantSetting

router = APIRouter(prefix="/v1", tags=["company integrations"])

SETTINGS_PAGE = "/settings/notifications"
Owner = Annotated[Principal, Depends(require_role("owner"))]


class CompanyIntegrationOut(BaseModel):
    id: uuid.UUID
    provider: Literal["slack"]
    purpose: Literal["notifications"]
    # Slack's workspace id and name.
    account_id: str
    account_label: str | None
    scopes: list[str]
    status: Literal["active", "revoked", "error"]
    last_error: str | None
    installed_by: uuid.UUID
    created_at: datetime


class InstallOut(BaseModel):
    # Slack's authorize URL: the browser goes there and comes back to the callback.
    url: str


class NotificationChannelOut(BaseModel):
    id: str
    name: str
    is_private: bool = False


class SlackTestIn(BaseModel):
    channel_id: str = Field(min_length=1, max_length=40)

    @field_validator("channel_id")
    @classmethod
    def _a_channel(cls, v: str) -> str:
        # The same check as the report's saved channel: a channel, never a person or a name.
        if not CHANNEL_ID.fullmatch(v):
            raise ValueError("not a Slack channel id")
        return v


class SlackTestOut(BaseModel):
    sent: bool
    channel_id: str


def _out(row: CompanyIntegration) -> CompanyIntegrationOut:
    return CompanyIntegrationOut(
        id=row.id,
        provider=row.provider,  # type: ignore[arg-type]
        purpose=row.purpose,  # type: ignore[arg-type]
        account_id=row.account_id,
        account_label=row.account_label,
        scopes=list(row.scopes or []),
        status=row.status,  # type: ignore[arg-type]
        last_error=row.last_error,
        installed_by=row.installed_by,
        created_at=row.created_at,
    )


def _slack_failed(e: slack_api.SlackError) -> HTTPException:
    return HTTPException(status.HTTP_502_BAD_GATEWAY, f"Slack answered {e.code}")


async def _install(db: TenantDB) -> CompanyIntegration:
    row = await slack_oauth.installed(db)
    if row is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Connect Slack for notifications first")
    return row


@router.get("/company-integrations", response_model=list[CompanyIntegrationOut])
async def list_company_integrations(principal: Owner, db: TenantDB) -> list[CompanyIntegrationOut]:
    """The company's own integrations (Oracle's Slack app); never a credential."""
    rows = await db.scalars(select(CompanyIntegration).order_by(CompanyIntegration.created_at))
    return [_out(r) for r in rows]


@router.get(
    "/company-integrations/slack/install",
    response_model=InstallOut,
    responses={409: {"description": "Already connected, or not configured"}},
)
async def install_slack_notifications(principal: Owner, db: TenantDB) -> InstallOut:
    """Slack's authorize URL to install Oracle's Slack app for the company (browser only:
    the owner signs in at Slack and comes back to the callback)."""
    if principal.user_id is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "An owner installs Slack: sign in as a user")
    if await slack_oauth.installed(db) is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, slack_oauth.ALREADY_CONNECTED)
    client = slack_oauth.client()
    if client is None:
        raise HTTPException(status.HTTP_409_CONFLICT, slack_oauth.NOT_CONFIGURED)
    return InstallOut(url=slack_oauth.authorize_url(client, principal.tenant_id, principal.user_id))


def _back(**params: str) -> RedirectResponse:
    return RedirectResponse(f"{SETTINGS_PAGE}?{urlencode(params)}", status.HTTP_303_SEE_OTHER)


@router.get(
    "/company-integrations/slack/callback",
    response_class=RedirectResponse,
    status_code=status.HTTP_303_SEE_OTHER,
)
async def oauth_slack_notifications_callback(
    principal: CurrentPrincipal,
    state: Annotated[str, Query()] = "",
    code: Annotated[str | None, Query()] = None,
    error: Annotated[str | None, Query()] = None,
) -> RedirectResponse:
    """Where Slack sends the owner back after the install; ends on Settings › Notifications."""
    try:
        st = oauth.decode_state(state, slack_oauth.STATE_PROVIDER)
    except oauth.InvalidState as e:
        return _back(error=str(e))
    if principal.user_id != st.user_id or principal.tenant_id != st.tenant_id:
        return _back(error="This install was started by another person")
    if error or not code:
        return _back(error=error or "Slack returned no code")
    client = slack_oauth.client()
    if client is None:
        return _back(error=slack_oauth.NOT_CONFIGURED)
    async with tenant_session(st.tenant_id) as db, slack_api.http_client() as http:
        user = await db.get(User, st.user_id)
        if not may_sign_in(user) or user.role != "owner":
            return _back(error="Only an owner installs Slack for the company")
        try:
            got = await slack_oauth.exchange_code(http, client, code)
        except slack_api.SlackError as e:
            return _back(error=f"Slack refused the install ({e.code})")
        try:
            await recheck_caller(db, principal, "owner")
        except HTTPException:
            await slack_oauth.revoke(http, got.token)
            return _back(error="Only an owner installs Slack for the company")
        if await slack_oauth.installed(db, for_update=True) is not None:
            # A second install raced past the check: the first one stays.
            await slack_oauth.revoke(http, got.token)
            return _back(error=slack_oauth.ALREADY_CONNECTED)
        row = CompanyIntegration(
            provider=slack_oauth.PROVIDER,
            purpose=slack_oauth.PURPOSE,
            account_id=got.team_id,
            account_label=got.team_name,
            ciphertext=slack_oauth.seal(got.token),
            key_version=crypto.KEY_VERSION,
            scopes=got.scopes,
            status="active",
            installed_by=st.user_id,
        )
        db.add(row)
        await db.flush()
        await audit.record(
            db,
            principal,
            "company_integration.installed",
            "company_integration",
            row.id,
            {"provider": row.provider, "purpose": row.purpose, "account": row.account_label,
             "scopes": row.scopes},
        )  # fmt: skip
        await db.commit()
    return _back(connected="slack")


@router.get(
    "/company-integrations/slack/channels",
    response_model=list[NotificationChannelOut],
    responses={409: {"description": "Slack is not connected"}, 502: {"description": "Slack"}},
)
async def list_slack_notification_channels(
    principal: Owner, db: TenantDB
) -> list[NotificationChannelOut]:
    """The channels the report can post to: public ones, and the private ones the bot was
    invited to when the install can read them."""
    row = await _install(db)
    try:
        async with slack_api.http_client() as http:
            found = await slack_oauth.channels(http, row)
    except slack_api.SlackError as e:
        raise _slack_failed(e) from None
    return [NotificationChannelOut(**c) for c in found]


@router.post(
    "/company-integrations/slack/test",
    response_model=SlackTestOut,
    responses={409: {"description": "Slack is not connected"}, 502: {"description": "Slack"}},
)
async def test_slack_notifications(
    body: SlackTestIn, principal: Owner, db: TenantDB
) -> SlackTestOut:
    """Send "Product Oracle will post the weekly alignment report here." to a channel."""
    row = await _install(db)
    try:
        async with slack_api.http_client() as http:
            await slack_oauth.post(http, row, body.channel_id, slack_oauth.TEST_MESSAGE)
    except slack_api.SlackError as e:
        raise _slack_failed(e) from None
    return SlackTestOut(sent=True, channel_id=body.channel_id)


@router.delete(
    "/company-integrations/{integration_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={404: {"description": "Not found"}},
)
async def delete_company_integration(
    integration_id: uuid.UUID, principal: Owner, db: TenantDB
) -> None:
    """Disconnect: revoke the bot token at Slack (best effort) and delete it. The report
    stops posting (and the report's channel is cleared); people's own Slack connections
    are untouched."""
    await recheck_caller(db, principal, "owner")
    row = await db.scalar(
        select(CompanyIntegration).where(CompanyIntegration.id == integration_id).with_for_update()
    )
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Integration not found")
    try:
        token = slack_oauth.token_of(row)
    except (crypto.DecryptionError, ValueError, KeyError):
        token = None
    revoked = False
    if token:
        async with slack_api.http_client() as http:
            revoked = await slack_oauth.revoke(http, token)
    setting = await db.scalar(select(TenantSetting).where(TenantSetting.key == "alignment_report"))
    if (
        setting is not None
        and isinstance(setting.value, dict)
        and setting.value.get("slack_channel")
    ):
        setting.value = {**setting.value, "slack_channel": None}
        setting.updated_by = principal.id
    await db.delete(row)
    await audit.record(
        db,
        principal,
        "company_integration.removed",
        "company_integration",
        row.id,
        {"provider": row.provider, "purpose": row.purpose, "revoked": revoked},
    )
    await db.commit()
