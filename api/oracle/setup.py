"""``GET /v1/setup`` (A1): how far the signed-in person is with setting Oracle up.

Home's Set up checklist reads it. Every step is worked out live from tables that already
record it (connections, sources, users, invites, tenant_settings); nothing is stored
besides the person's ``setup_hidden`` preference. The cost is fixed whatever the
company's size: one statement per step, plus the preference.

Steps live in one ordered registry, :data:`STEPS`. Another pick adds a step by adding an
entry here and a label in the web, without touching the others; the API returns keys
only, the labels are the web's copy.
"""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import AfterValidator, BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.deps import CurrentPrincipal, Principal, TenantDB
from oracle.auth.models import User
from oracle.connections.models import Connection
from oracle.members.models import Invite
from oracle.preferences.models import UserPreference
from oracle.runs.models import Run
from oracle.sources.models import Source
from oracle.sources.service import company_domains
from oracle.tenant_settings import TenantSetting

# Each person connects their own tools and picks their own sources (S5 Connector auth);
# viewers cannot add sources, so they have no steps.
PERSONAL = ("commenter", "approver", "owner")
OWNERS = ("owner",)


def known_step(key: str) -> str:
    if key not in {s.key for s in STEPS}:
        raise ValueError(f"unknown setup step {key!r}")
    return key


# A1's keys: connect, sources, invite, domains, horizons, A3's eng_lead and B1's
# build_baseline. Later picks add more through STEPS, so the type is a str checked
# against the registry.
SetupKey = Annotated[str, AfterValidator(known_step)]


class SetupStep(BaseModel):
    key: SetupKey
    done: bool
    # Connections, sources, people, domains, engineering leads; None for horizons.
    count: int | None = None
    # The single domain when there is exactly one; build_baseline: when the last build
    # finished (ISO 8601).
    detail: str | None = None


class SetupOut(BaseModel):
    # In the registry's order, only the steps for the caller's role.
    steps: list[SetupStep]
    done: int
    total: int
    # The caller's setup_hidden preference.
    hidden: bool


Compute = Callable[[AsyncSession, Principal], Awaitable[SetupStep]]


@dataclass(frozen=True)
class Step:
    key: str
    roles: tuple[str, ...]
    compute: Compute


async def _connect(db: AsyncSession, principal: Principal) -> SetupStep:
    n = await db.scalar(
        select(func.count())
        .select_from(Connection)
        .where(Connection.user_id == principal.user_id, Connection.status == "active")
    )
    return SetupStep(key="connect", done=bool(n), count=n)


async def _sources(db: AsyncSession, principal: Principal) -> SetupStep:
    n = await db.scalar(
        select(func.count()).select_from(Source).where(Source.owner_user_id == principal.user_id)
    )
    return SetupStep(key="sources", done=bool(n), count=n)


async def _invite(db: AsyncSession, principal: Principal) -> SetupStep:
    """Done with someone else on board: a second active member, or an open invite."""
    members = select(func.count()).select_from(User).where(User.disabled_at.is_(None))
    invites = (
        select(func.count())
        .select_from(Invite)
        .where(Invite.accepted_at.is_(None), Invite.revoked_at.is_(None))
    )
    row = (await db.execute(select(members.scalar_subquery(), invites.scalar_subquery()))).one()
    people, open_invites = row
    return SetupStep(key="invite", done=people >= 2 or open_invites >= 1, count=people)


async def _domains(db: AsyncSession, principal: Principal) -> SetupStep:
    domains = await company_domains(db, principal.tenant_id)
    return SetupStep(
        key="domains",
        done=bool(domains),
        count=len(domains),
        detail=domains[0] if len(domains) == 1 else None,
    )


async def _eng_lead(db: AsyncSession, principal: Principal) -> SetupStep:
    """Done once an owner named an engineering lead (A3): active members flagged."""
    n = await db.scalar(
        select(func.count())
        .select_from(User)
        .where(User.engineering_lead.is_(True), User.disabled_at.is_(None))
    )
    return SetupStep(key="eng_lead", done=bool(n), count=n)


async def _horizons(db: AsyncSession, principal: Principal) -> SetupStep:
    """Done once an owner confirmed or changed them: a stored planning_horizons row."""
    stored = await db.scalar(
        select(TenantSetting.key).where(TenantSetting.key == "planning_horizons")
    )
    return SetupStep(key="horizons", done=stored is not None)


async def _build_baseline(db: AsyncSession, principal: Principal) -> SetupStep:
    """Done once a Build the baseline run succeeded (B1); detail: the last one's finish."""
    finished = await db.scalar(
        select(func.max(func.coalesce(Run.finished_at, Run.created_at))).where(
            Run.flow == "baseline", Run.status == "succeeded"
        )
    )
    return SetupStep(
        key="build_baseline",
        done=finished is not None,
        detail=finished.isoformat() if finished else None,
    )


STEPS: list[Step] = [
    Step("connect", PERSONAL, _connect),
    Step("sources", PERSONAL, _sources),
    Step("invite", OWNERS, _invite),
    Step("domains", OWNERS, _domains),
    Step("eng_lead", OWNERS, _eng_lead),
    Step("horizons", OWNERS, _horizons),
    Step("build_baseline", OWNERS, _build_baseline),
]


async def compute(db: AsyncSession, principal: Principal) -> SetupOut:
    """The caller's steps, in order, and their hide preference."""
    steps = [await s.compute(db, principal) for s in STEPS if principal.role in s.roles]
    hidden = await db.scalar(
        select(UserPreference.value).where(
            UserPreference.principal_id == principal.id, UserPreference.key == "setup_hidden"
        )
    )
    return SetupOut(
        steps=steps,
        done=sum(s.done for s in steps),
        total=len(steps),
        hidden=hidden is True,
    )


async def require_person(principal: CurrentPrincipal) -> Principal:
    """A person signed in: not an API token acting for no member, not a run's token."""
    if principal.kind != "user" or principal.user_id is None or principal.is_run:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Setup is for people signed in")
    return principal


Person = Annotated[Principal, Depends(require_person)]

router = APIRouter(prefix="/v1", tags=["setup"])


@router.get("/setup", response_model=SetupOut, responses={403: {"description": "Not a person"}})
async def get_setup(principal: Person, db: TenantDB) -> SetupOut:
    """Home's Set up checklist: the caller's setup steps, which are done, and whether they
    hid the checklist. Owners get every step; approvers and commenters connecting tools
    and picking sources; viewers none."""
    return await compute(db, principal)
