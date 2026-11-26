"""#1763: a member with no name set shows by the one name rule (oracle.members.names), never
as a raw email address, on Simple's meetings (attendees, the start sheet's members) and the
Decisions page (who decided)."""

from sqlalchemy import update

from oracle.auth.models import User
from oracle.members.names import display_name
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_meetings_api import MEETINGS, PRD, get, start, uid, world


async def test_a_member_without_a_name_shows_by_name_not_email(client):
    """An attendee with no name reads "First Last" from their address, not the address."""
    w = await world()
    who = w.ctx.users["approver"]
    async with tenant_session(w.ctx.tenant_id) as s:
        await s.execute(update(User).where(User.id == who.id).values(name=None))
        await s.commit()
    shown = display_name(who.email)
    assert shown != who.email
    m = await start(client, w)
    names = {a["id"]: a["name"] for a in (await get(client, w, m["id"]))["attendees"]}
    assert names[uid(w, "approver")] == shown
    listed = (await client.get(MEETINGS, headers=w.ctx.as_("decider"))).json()["live"]
    [row] = [x for x in listed if x["id"] == m["id"]]
    assert who.email not in str(row)
    r = await client.get(f"{MEETINGS}/options", params={"prd": PRD}, headers=w.ctx.as_("owner"))
    members = {x["id"]: x["name"] for x in r.json()["members"]}
    assert members[uid(w, "approver")] == shown
