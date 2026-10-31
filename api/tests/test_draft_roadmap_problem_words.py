"""qa4-docs-4: the Roadmap tab's check problems read as people's words: no item key and no
ISO date ("the Nov 30, 2026 date has no confirmed schedule behind it yet"). The stored
check keeps the engine's wording (the agents read it); only the view rewrites it."""

from oracle.roadmap.draft_items import readable_check
from oracle.swarm import Outcome
from tests.test_draft_roadmaps import (  # noqa: F401  (fixtures)
    derivations_start,
    items_file,
    new_version,
    owner,
    read,
    runtime,
    tick,
)


async def test_the_tab_reads_problems_without_keys_or_iso_dates(client, owner, runtime):  # noqa: F811
    _, auth = owner
    await new_version(client, auth, 1)
    bad = items_file(1).replace("depends_on: [payment-step]", "depends_on: [nowhere]")
    runtime.script["roadmap_items"] = [Outcome(artifacts={"roadmap_items.yaml": bad})]
    await tick(client, auth)
    await tick(client, auth)
    body = await read(client, auth, 1)
    problems = {p["code"]: p for p in body["check"]["problems"]}
    unverified = problems["unverified_date"]
    assert unverified["item"] == "payment-step"
    assert unverified["message"] == "the Nov 30, 2026 date has no confirmed schedule behind it yet"
    for p in body["check"]["problems"]:
        assert "item " + str(p.get("item")) + ":" not in p["message"], p
        assert "2026-11-30" not in p["message"], p


def test_readable_check_words():
    check = {
        "items": 2,
        "by_horizon": {"now": 1, "next": 1, "later": 0},
        "problems": [
            {
                "code": "date_outside_now",
                "item": "saved-addresses",
                "message": "item saved-addresses: dated milestones belong only in now "
                "(this item is in next)",
            },
            {
                "code": "invalid_date",
                "item": "saved-addresses",
                "message": "item saved-addresses: milestone date 'soon' is not YYYY-MM-DD",
            },
            {"code": "unknown_dependency", "item": None, "message": "due 2026-12-15"},
        ],
    }
    out = readable_check(check)
    assert out is not None
    words = [p["message"] for p in out["problems"]]
    assert words[0] == "a dated milestone belongs only in Now; this item is in Next"
    assert words[1] == "milestone date 'soon' is not a date"
    assert words[2] == "due Dec 15, 2026"
    # The stored check is untouched.
    assert check["problems"][0]["message"].startswith("item saved-addresses:")
    assert readable_check(None) is None
