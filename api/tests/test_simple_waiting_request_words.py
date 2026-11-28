"""#1913 (reopened Nov 27): a change that waits for a decision reads as a request, its item
named, on the one waiting list Home's "Also waiting for you" and Decisions' "Waiting for you"
both read (GET /v1/simple/decisions/waiting ``items``, each proposal's ``title``): "<who> asks
to change the owner of F-01 Sign in", never "<who> proposed: changed the owner of an item".
Against Postgres, plus the words alone (oracle.simple.change_words.request).

Test cards (protects / fails_when / no_claim):

- test_waiting_changes_read_as_requests_with_their_item_named: protects=a waiting owner,
  estimate, date, add, delete and goal-map link change each read "<who> asks to <verb> ..." with
  the item by code and name, and one on an item since moved to Trash names it "(deleted)";
  fails_when=a waiting change reads in the past tense, "proposed:", or "an item";
  no_claim=deciding them.
- test_every_op_has_a_request_form: protects=every op phrase() knows has a request form that
  starts with a verb asked for (the Inbox's own table, web/app/inbox/_request-words.ts VERB);
  fails_when=a new op's request falls back to the past tense; no_claim=the Inbox's rendering
  (docs/contracts/api-request-verbs.json, read by web/app/inbox/_request-words.test.ts).
- test_declined_and_done_rows_keep_their_tense: protects=a declined one reads "<who> asked to
  <request> · declined", an applied one and an undo keep today's words; fails_when=either
  changes; no_claim=which rows list them.
"""

import re
import typing
import uuid
from datetime import timedelta
from pathlib import Path

import pytest
from sqlalchemy import update

from oracle import company_time
from oracle.roadmap.models import RoadmapItem
from oracle.simple import change_words, plan_changes
from oracle.simple.models import SimpleChange
from oracle.simple.schemas_roadmap import ChangeOp
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import World, make_people
from tests.test_simple_roadmap_api import NOW

WAITING = "/v1/simple/decisions/waiting"


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def test_waiting_changes_read_as_requests_with_their_item_named(client):
    """Each waiting change on the one waiting list reads as a request naming its item."""
    ctx = await make_people()
    w = await World(ctx).build(decider=False, ops=["edit_title"])
    names = {"edit_title-a": "F-01 Sign in", "edit_title-b": "F-02 Billing page",
             "edit_title-u": "F-03 Audit log"}  # fmt: skip
    owner, by = ctx.users["owner"].id, ctx.users["commenter"].id
    a, b, u = (w.ids[f"edit_title-{x}"] for x in "abu")
    cases = [
        ("set_owner", {"item_id": a}, {"owner_id": None}, {"owner_id": str(owner)},
         "asks to change the owner of F-01 Sign in"),
        ("estimate_feature", {"item_id": a}, {}, {"estimate_weeks": 3},
         "asks to change the estimate of F-01 Sign in"),
        ("move_dates", {"item_id": b}, {}, {"start_date": "2026-12-01"},
         "asks to move the dates of F-02 Billing page"),
        ("add_item", {"title": "Export to sheets"}, {}, {"title": "Export to sheets"},
         "asks to add “Export to sheets”"),
        ("delete_item", {"item_id": b}, {}, {}, "asks to move F-02 Billing page to Trash"),
        ("link_goal_map", {"item_id": a, "name": "Beta"}, {}, {},
         "asks to put F-01 Sign in on “Beta”"),
        ("set_owner", {"item_id": u}, {"owner_id": None}, {"owner_id": str(owner)},
         "asks to change the owner of F-03 Audit log (deleted)"),
    ]  # fmt: skip
    async with tenant_session(ctx.tenant_id) as s:
        for key, title in names.items():
            await s.execute(update(RoadmapItem).where(RoadmapItem.id == uuid.UUID(w.ids[key]))
                            .values(title=title))  # fmt: skip
        ids = []
        for n, (op, target, before, after, _) in enumerate(cases):
            c = SimpleChange(op=op, target=target, before=before, after=after, status="proposed",
                             by=by, at=NOW - timedelta(minutes=n), routed_to=[owner])  # fmt: skip
            s.add(c)
            await s.flush()
            ids.append(str(c.id))
        # The last one's item has since gone to Trash.
        await s.execute(update(RoadmapItem).where(RoadmapItem.id == uuid.UUID(u))
                        .values(deleted_at=NOW))  # fmt: skip
        await s.commit()
    r = await client.get(WAITING, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    items = {i["ref_id"]: i for i in r.json()["items"]}
    for cid, (op, *_, words) in zip(ids, cases, strict=True):
        got = items.get(cid) or {}
        who = str(got.get("detail", "")).removeprefix("Proposed by ")
        assert got.get("title") == f"{who} {words}", (op, got.get("title"))


def _ops() -> set[str]:
    src = Path(change_words.__file__).read_text()
    cased = {o for line in re.findall(r'case ("[a-z_]+"(?: \| "[a-z_]+")*):', src)
             for o in re.findall(r'"([a-z_]+)"', line)}  # fmt: skip
    return set(typing.get_args(ChangeOp)) | set(plan_changes.OPS) | cased


_SHAPES: list[tuple[dict, dict, dict]] = [
    ({}, {}, {}),
    ({"title": "Ledger", "name": "Beta", "code": "F-09", "dependency": "F-02 Billing page",
      "reason": "too early", "from_milestone": "m1", "from_name": "Alpha",
      "titles": ["Ledger", "Billing"], "into_title": "Ledger"},
     {"depends_on": ["x", "y"], "milestone": {"name": "Old"}, "horizon": "now"},
     {"depends_on": ["x"], "title": "Ledger v2", "horizon": "next", "status": "done",
      "milestone": {"name": "New"}, "shipped": True, "feature_id": "f", "parent_key": "p",
      "line": "Five invites", "number": 6}),
    ({"dependency": "F-02 Billing page"}, {"depends_on": []}, {"depends_on": ["x"]}),
]  # fmt: skip


@pytest.mark.parametrize("op", sorted(_ops()))
def test_every_op_has_a_request_form(op):
    """No op's request form falls back to the past tense."""
    # The words a request may start with: the verbs of the Inbox's table.
    asked_verbs = set(change_words.VERB.values()) | {"make"}
    for target, before, after in _SHAPES:
        asked = change_words.request(op, target, before, after, "F-01 Sign in")
        first = asked.split(" ", 1)[0]
        assert first in asked_verbs, (op, asked)


def test_declined_and_done_rows_keep_their_tense():
    """A declined one reads asked-to; applied and undone rows keep today's words."""
    kw = {"who": "Ana", "item": "F-01 Sign in", "undone": False}
    args = ("set_owner", {"item_id": "x"}, {}, {})
    assert change_words.sentence(*args, status="proposed", **kw) == (
        "Ana asks to change the owner of F-01 Sign in"
    )
    assert change_words.sentence(*args, status="declined", **kw) == (
        "Ana asked to change the owner of F-01 Sign in · declined"
    )
    assert change_words.sentence(*args, status="applied", **kw) == (
        "Ana changed the owner of F-01 Sign in"
    )
    assert change_words.sentence(*args, status="undone", **kw) == (
        "Ana undid: changed the owner of F-01 Sign in"
    )
