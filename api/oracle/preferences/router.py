"""``/v1/me/preferences``: what the signed-in user (or API token) chose for themselves."""

import uuid
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select

from oracle.auth.deps import CurrentPrincipal, TenantDB
from oracle.preferences.models import UserPreference

DocumentView = Literal["brief", "full"]


class SlackPings(BaseModel):
    """Which Slack pings the member gets (oracle.slack.pings): ``review_requested`` and
    ``draft_ready`` on by default, the rest off."""

    draft_ready: bool = True
    review_requested: bool = True
    comments: bool = False
    feedback_wanted: bool = False
    published: bool = False


class SlackPingsUpdate(BaseModel):
    """Only the pings sent change; the others keep the member's choice."""

    model_config = ConfigDict(extra="forbid")

    draft_ready: bool | None = None
    review_requested: bool | None = None
    comments: bool | None = None
    feedback_wanted: bool | None = None
    published: bool | None = None


class Preferences(BaseModel):
    """What the signed-in user (or API token) chose. ``document_view``: the layer
    documents open on; brief unless they switched to the full document. ``setup_hidden``:
    they hid Home's Set up checklist (A1); a header chip shows it again.
    ``welcome_dismissed``: they dismissed Home's welcome for invited members (A1).
    ``slack_pings``: the Slack pings they get (My account)."""

    document_view: DocumentView = "brief"
    setup_hidden: bool = False
    welcome_dismissed: bool = False
    slack_pings: SlackPings = SlackPings()


class PreferencesUpdate(BaseModel):
    document_view: DocumentView | None = None
    setup_hidden: bool | None = None
    welcome_dismissed: bool | None = None
    slack_pings: SlackPingsUpdate | None = None


router = APIRouter(prefix="/v1/me", tags=["auth"])


async def read_preferences(db, principal_id: uuid.UUID) -> Preferences:
    rows = await db.execute(
        select(UserPreference.key, UserPreference.value).where(
            UserPreference.principal_id == principal_id
        )
    )
    known = set(Preferences.model_fields)
    stored = {k: v for k, v in rows.all() if k in known}
    if "slack_pings" in stored:
        from oracle.slack.pings import chosen_of

        stored["slack_pings"] = chosen_of(stored["slack_pings"])
    return Preferences(**stored)


@router.get("/preferences", response_model=Preferences)
async def get_preferences(principal: CurrentPrincipal, db: TenantDB) -> Preferences:
    return await read_preferences(db, principal.id)


@router.patch("/preferences", response_model=Preferences)
async def update_preferences(
    data: PreferencesUpdate, principal: CurrentPrincipal, db: TenantDB
) -> Preferences:
    """Any signed-in user, viewers included, keeps their own choices."""
    current = await read_preferences(db, principal.id)
    for key, value in data.model_dump(exclude_unset=True, exclude_none=True).items():
        if key == "slack_pings":
            value = {**current.slack_pings.model_dump(), **value}
        row = await db.scalar(
            select(UserPreference).where(
                UserPreference.principal_id == principal.id, UserPreference.key == key
            )
        )
        if row is None:
            db.add(UserPreference(principal_id=principal.id, key=key, value=value))
        else:
            row.value = value
    await db.commit()
    return await read_preferences(db, principal.id)
