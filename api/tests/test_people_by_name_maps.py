"""#1763: wherever Simple names a person from the members list, a member who set no name
shows a name made from their email (oracle.members.names.display_name), never the email.
Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_the_name_maps_name_a_member_without_a_name: protects=the name maps behind changes'
  by_name, questions, goal owners, rebuilds' names, their decider and the owner, and the Goal
  map's "who" read "approver@example.com" as "Approver"; fails_when=any of them names that
  member by their email; no_claim=how each page shows the name (web/e2e/people-by-name.spec.ts).
- test_no_name_map_falls_back_to_the_bare_email: protects=the name maps read inline in
  Simple and rebuilds (service, drafts, One-pager, One-pager access, roadmap drafts, targets,
  Goal map, rebuilds) all go through display_name; fails_when=one of the lines #1763 listed
  still writes `name or email`; no_claim=other modules.
"""

import pathlib
import re
from types import SimpleNamespace

from oracle.rebuilds import service as rebuilds
from oracle.simple import changes, goal_buckets, goal_map_router, questions
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx

ORACLE = pathlib.Path(__file__).resolve().parents[1] / "oracle"


async def test_the_name_maps_name_a_member_without_a_name(client):
    """A member with no name reads "Approver" from approver@example.com in each name map."""
    ctx = await make_ctx()
    lead, owner = ctx.users["approver"], ctx.users["owner"]
    assert not lead.name and not owner.name
    async with tenant_session(ctx.tenant_id) as db:
        for names in (changes._names, questions._names, goal_buckets._names, rebuilds._names):
            assert await names(db, {lead.id}) == {lead.id: "Approver"}, names.__module__
        assert await rebuilds._owner_name(db) == "Owner"
        who = await goal_map_router._who(db, SimpleNamespace(user_id=lead.id))
        assert who == "Approver"


def test_no_name_map_falls_back_to_the_bare_email():
    """No line of the files #1763 listed names a member `name or email`."""
    files = [
        "simple/changes.py", "simple/questions.py", "simple/goal_buckets.py",
        "simple/service.py", "simple/drafts.py", "simple/one_pager.py",
        "simple/one_pager_access.py", "simple/roadmap_drafts.py", "simple/targets.py",
        "simple/goal_map_router.py", "rebuilds/service.py",
    ]  # fmt: skip
    bare = re.compile(r"\b(?:\w+\.)?name or (?:\w+\.)?email\b")
    found = [
        f"{f}:{n}"
        for f in files
        for n, line in enumerate((ORACLE / f).read_text().splitlines(), 1)
        if bare.search(line)
    ]
    assert found == []
