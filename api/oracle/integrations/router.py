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
from oracle.slack import bridge, outbox
from oracle.tenancy import tenant_session
from oracle.tenant_settings import TenantSetting

router = APIRouter(prefix="/v1", tags=["company integrations"])

SETTINGS_PAGE = "/settings/notifications"
Owner = Annotated[Principal, Depends(require_role("owner"))]
Commenter = Annotated[Principal, Depends(require_role("commenter"))]
Viewer = Annotated[Principal, Depends(require_role("viewer"))]


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


class SlackStatusOut(BaseModel):
    """What any member's discussion menu needs to know (G8): connected, the Slack name,
    whether discussions can be mirrored, and whether an owner must reconnect first."""

    connected: bool
    label: str | None
    mirroring: bool
    needs_reconnect: bool


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
    """The company's own integrations (Oracle's Slack app); never a credential. A
    disconnected one is not listed."""
    rows = await db.scalars(
        select(CompanyIntegration)
        .where(CompanyIntegration.status != "revoked")
        .order_by(CompanyIntegration.created_at)
    )
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
    found = await slack_oauth.installed(db)
    if found is not None and not slack_oauth.needs_reconnect(found):
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
        found = await slack_oauth.installed(db, for_update=True, with_revoked=True)
        if found is not None and found.status == "revoked":
            # Connected again after a Disconnect: the same row, active again.
            found.account_id = got.team_id
            found.account_label = got.team_name
            found.ciphertext = slack_oauth.seal(got.token)
            found.key_version = crypto.KEY_VERSION
            found.scopes = got.scopes
            found.status = "active"
            found.last_error = None
            found.installed_by = st.user_id
            found.bot_user_id = got.bot_user_id
            await db.flush()
            await audit.record(
                db, principal, "company_integration.installed", "company_integration",
                found.id, {"provider": found.provider, "purpose": found.purpose,
                           "account": found.account_label, "scopes": found.scopes},
            )  # fmt: skip
            await db.commit()
            return _back(connected="slack")
        if (
            found is not None
            and found.account_id == got.team_id
            and (slack_oauth.needs_reconnect(found))
        ):
            # G8: reconnecting adds the bridge's scopes to the same install.
            found.ciphertext = slack_oauth.seal(got.token)
            found.key_version = crypto.KEY_VERSION
            found.scopes = got.scopes
            found.bot_user_id = got.bot_user_id
            found.account_label = got.team_name or found.account_label
            await audit.record(
                db, principal, "company_integration.reconnected", "company_integration",
                found.id, {"provider": found.provider, "scopes": found.scopes},
            )  # fmt: skip
            await db.commit()
            return _back(connected="slack")
        if found is not None:
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
            bot_user_id=got.bot_user_id,
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


@router.get("/company-integrations/slack/status", response_model=SlackStatusOut)
async def slack_status(principal: Viewer, db: TenantDB) -> SlackStatusOut:
    """Whether Oracle's Slack app is connected and can mirror discussions (G8); any member."""
    row = await slack_oauth.installed(db)
    active = row is not None and row.status == "active"
    return SlackStatusOut(
        connected=active,
        label=(row.account_label or row.account_id) if row is not None and active else None,
        mirroring=slack_oauth.can_mirror(row),
        needs_reconnect=slack_oauth.needs_reconnect(row),
    )


@router.get(
    "/company-integrations/slack/channels",
    response_model=list[NotificationChannelOut],
    responses={409: {"description": "Slack is not connected"}, 502: {"description": "Slack"}},
)
async def list_slack_notification_channels(
    principal: Commenter, db: TenantDB
) -> list[NotificationChannelOut]:
    """The channels the report can post to, or a discussion can be mirrored to (G8:
    commenters and up): public ones, and the private ones the bot was invited to when
    the install can read them."""
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
    """Disconnect: every mirrored discussion thread gets its closing line and stops
    mirroring (G8), then the bot token is revoked at Slack (best effort) and the install is
    set ``revoked``: its token is erased, and its row and ``bot_user_id`` are kept, so
    people's Slack sources keep skipping Oracle's own posts (S6). The report stops posting
    (and the report's channel is cleared); people's own Slack connections are untouched."""
    await recheck_caller(db, principal, "owner")
    row = await db.scalar(
        select(CompanyIntegration)
        .where(CompanyIntegration.id == integration_id, CompanyIntegration.status != "revoked")
        .with_for_update()
    )
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Integration not found")
    try:
        token = slack_oauth.token_of(row)
    except (crypto.DecryptionError, ValueError, KeyError):
        token = None
    revoked = False
    closed = await bridge.close_all(db, principal)
    if token:
        async with slack_api.http_client() as http:
            await outbox.deliver_closes(db, http, row, closed)
            revoked = await slack_oauth.revoke(http, token)
    setting = await db.scalar(select(TenantSetting).where(TenantSetting.key == "alignment_report"))
    if (
        setting is not None
        and isinstance(setting.value, dict)
        and setting.value.get("slack_channel")
    ):
        setting.value = {**setting.value, "slack_channel": None}
        setting.updated_by = principal.id
    row.status = "revoked"
    row.ciphertext = b""
    await audit.record(
        db,
        principal,
        "company_integration.removed",
        "company_integration",
        row.id,
        {
            "provider": row.provider,
            "purpose": row.purpose,
            "revoked": revoked,
            "mirrors_closed": len(closed),
        },
    )
    await db.commit()
