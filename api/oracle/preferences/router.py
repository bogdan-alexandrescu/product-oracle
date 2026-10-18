"""``/v1/me/preferences``: what the signed-in user (or API token) chose for themselves."""

import uuid
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import select

from oracle.auth.deps import CurrentPrincipal, TenantDB
from oracle.preferences.models import UserPreference

DocumentView = Literal["brief", "full"]


class Preferences(BaseModel):
    """What the signed-in user (or API token) chose. ``document_view``: the layer
    documents open on; brief unless they switched to the full document."""

    document_view: DocumentView = "brief"


class PreferencesUpdate(BaseModel):
    document_view: DocumentView | None = None


router = APIRouter(prefix="/v1/me", tags=["auth"])


async def read_preferences(db, principal_id: uuid.UUID) -> Preferences:
    rows = await db.execute(
        select(UserPreference.key, UserPreference.value).where(
            UserPreference.principal_id == principal_id
        )
    )
    known = set(Preferences.model_fields)
    return Preferences(**{k: v for k, v in rows.all() if k in known})


@router.get("/preferences", response_model=Preferences)
async def get_preferences(principal: CurrentPrincipal, db: TenantDB) -> Preferences:
    return await read_preferences(db, principal.id)


@router.patch("/preferences", response_model=Preferences)
async def update_preferences(
    data: PreferencesUpdate, principal: CurrentPrincipal, db: TenantDB
) -> Preferences:
    """Any signed-in user, viewers included, keeps their own choices."""
    for key, value in data.model_dump(exclude_unset=True, exclude_none=True).items():
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
