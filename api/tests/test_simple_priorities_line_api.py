"""Simple roadmap-plus (#723): the line on priorities (``GET /v1/simple/priorities?line=``)
and the person's remembered pick (``priorities_line`` in /v1/me/preferences). The world:
tests.test_simple_priorities_api (one roadmap ``payments``, today Nov 2, 2026, this quarter
Oct 1 - Dec 31), plus dated ends, a key date and a dated track milestone. Each test's card
is its docstring (protects / fails_when / no_claim).
"""

import uuid
from datetime import date

from oracle.roadmap.models import RoadmapItem, TrackMilestone
from oracle.simple.models import RoadmapKeyDate
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import clock, make_people  # noqa: F401
from tests.test_simple_priorities_api import URL, World, rows_by_code
from tests.test_simple_targets_api import no_llm  # noqa: F401


async def world() -> World:
    w = await World(await make_people()).build()
    async with tenant_session(w.ctx.tenant_id) as s:
        # pay-1 (now) ends Nov 30; pay-2 (next) ends Jan 15; pay-3 (now) is estimated (Dec 31).
        for key, end in (("pay-1", date(2026, 11, 30)), ("pay-2", date(2027, 1, 15))):
            row = await s.get(RoadmapItem, uuid.UUID(w.ids[key]))
            row.start_date, row.end_date, row.date_source = date(2026, 10, 1), end, "typed"
        doc = (await s.get(RoadmapItem, uuid.UUID(w.ids["pay-1"]))).roadmap_document_id
        owner = w.ctx.users["owner"].id
        kd = RoadmapKeyDate(roadmap_document_id=doc, name="Board meeting",
                            on_date=date(2026, 12, 10), created_by=owner)  # fmt: skip
        s.add(kd)
        track_id = (await s.get(RoadmapItem, uuid.UUID(w.ids["pay-1"]))).track_id
        m = TrackMilestone(track_id=track_id, name="GA", target_date=date(2027, 1, 31),
                           horizon="next", status="planned", basis_ids=[uuid.uuid4()],
                           item_keys=["pay-2"])  # fmt: skip
        s.add(m)
        await s.commit()
        w.ids |= {"kd": str(kd.id), "ms": str(m.id)}
    return w


async def read(client, w: World, line: str | None = None, who: str = "owner") -> dict:
    r = await client.get(URL, params={"line": line} if line else {}, headers=w.ctx.as_(who))
    assert r.status_code == 200, r.text
    return r.json()


def above(out: dict) -> dict[str, bool]:
    return {code: r["above_line"] for code, r in rows_by_code(out).items() if r["item_id"]}


async def test_default_line_is_this_quarter(client):
    """protects=with no line, above the line is this quarter's plan (the Now horizon), and the
    lines offered are Now, each key date and each dated milestone, with their days; every row
    with an item carries its planned end (stored or estimated); fails_when=the default
    changes, a key date or dated milestone is not offered, or an end is missing;
    no_claim=the web's picker."""
    w = await world()
    out = await read(client, w)
    assert out["line"] == {"key": "now", "kind": "now", "label": "This quarter (Now)",
                           "date": None}  # fmt: skip
    assert above(out) == {"pay-1": True, "pay-2": False, "pay-3": True, "pay-4": False}
    assert [(x["key"], x["date"]) for x in out["lines"]] == [
        ("now", None),
        (f"key_date:{w.ids['kd']}", "2026-12-10"),
        (f"milestone:{w.ids['ms']}", "2027-01-31"),
    ]
    assert out["lines"][1]["label"] == "Board meeting · Dec 10, 2026"
    rows = rows_by_code(out)
    assert (rows["pay-1"]["end_date"], rows["pay-1"]["end_estimated"]) == ("2026-11-30", False)
    assert (rows["pay-3"]["end_date"], rows["pay-3"]["end_estimated"]) == ("2026-12-31", True)


async def test_date_lines_use_the_planned_end(client):
    """protects=a key date, a dated milestone or a picked day draws the line at that day:
    above = planned to finish by it (stored or estimated end); an unknown line reads as Now;
    fails_when=the horizon is used instead of the end, the estimated end is ignored, or an
    unknown key errors; no_claim=the preference's storage (next test)."""
    w = await world()
    out = await read(client, w, f"key_date:{w.ids['kd']}")
    assert out["line"]["kind"] == "key_date" and out["line"]["date"] == "2026-12-10"
    assert above(out) == {"pay-1": True, "pay-2": False, "pay-3": False, "pay-4": False}
    out = await read(client, w, f"milestone:{w.ids['ms']}")
    assert above(out) == {"pay-1": True, "pay-2": True, "pay-3": True, "pay-4": False}
    out = await read(client, w, "date:2026-12-31")
    assert out["line"] == {"key": "date:2026-12-31", "kind": "date", "label": "By Dec 31, 2026",
                           "date": "2026-12-31"}  # fmt: skip
    assert above(out) == {"pay-1": True, "pay-2": False, "pay-3": True, "pay-4": False}
    for junk in (f"key_date:{uuid.uuid4()}", "date:soon", "nonsense"):
        assert (await read(client, w, junk))["line"]["key"] == "now", junk
    # A viewer reads the same lines.
    assert (await read(client, w, "date:2026-12-31", who="viewer"))["line"]["kind"] == "date"


async def test_the_pick_is_remembered_per_person(client):
    """protects=each person's line is kept in their preferences (``priorities_line``), a
    viewer's too, and a malformed one is refused (422); fails_when=one person's pick
    changes another's, or junk is stored; no_claim=the URL (the web keeps it there)."""
    w = await world()
    pref = "/v1/me/preferences"
    assert (await client.get(pref, headers=w.ctx.as_("viewer"))).json()["priorities_line"] is None
    r = await client.patch(pref, json={"priorities_line": f"key_date:{w.ids['kd']}"},
                           headers=w.ctx.as_("viewer"))  # fmt: skip
    assert r.status_code == 200 and r.json()["priorities_line"] == f"key_date:{w.ids['kd']}"
    r = await client.patch(pref, json={"priorities_line": "date:2027-02-01"},
                           headers=w.ctx.as_("commenter"))  # fmt: skip
    assert r.status_code == 200, r.text
    got = (await client.get(pref, headers=w.ctx.as_("viewer"))).json()["priorities_line"]
    assert got == f"key_date:{w.ids['kd']}"
    r = await client.patch(pref, json={"priorities_line": "DROP TABLE"},
                           headers=w.ctx.as_("viewer"))  # fmt: skip
    assert r.status_code == 422, r.text


def test_docs_and_preferences_say_the_same_default_line():
    """protects=docs/mvp-app.md and the Preferences schema name one default for an unset
    ``priorities_line`` (u-followups review); fails_when=either words it differently (one
    said `now`, the other this quarter); no_claim=the default itself
    (test_default_line_is_this_quarter)."""
    from pathlib import Path

    from oracle.preferences.router import Preferences

    said = "unset, this quarter (`now`)"
    docs = (Path(__file__).resolve().parents[2] / "docs" / "mvp-app.md").read_text()
    assert said in docs
    assert said in " ".join((Preferences.__doc__ or "").split()).replace("``", "`")


def test_a_half_typed_picked_day_is_no_line():
    """qa-simple-plan-1: a picked day of year 1 (a field read mid-typing) is Now."""
    from oracle.simple.priorities import NOW_LINE, pick_line

    assert pick_line("date:0001-12-20", []) == NOW_LINE
    assert pick_line("date:0202-12-01", []) == NOW_LINE
    picked = pick_line("date:2026-12-01", [])
    assert (picked.kind, picked.label) == ("date", "By Dec 1, 2026")
