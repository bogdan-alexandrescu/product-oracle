"""Roadmap date warnings only flag dates that truly have no basis (owner, Nov 3).

A roadmap drafted from an approved PRD whose estimates are all verified showed a warning
for every date it wrote. On a fixture roadmap with invented items and verified bases:
(1) a date matches a verified basis for an item its sentence or section is about, for any
item a summary or outcomes text names, and a milestone's date that equals the latest
verified end among its items; (2) dates that are not schedule claims are never checked;
(3) an owner's commitment backs the date it names for the milestone or item it applies
to; (4) warnings are counted per distinct date and item; (5) a version's warnings follow
the bases as they stand, so they are never stale."""

import uuid
from datetime import date

from oracle.docs.parser import parse_draft
from oracle.roadmap import doc_dates, schedule
from oracle.swarm import Outcome
from tests.test_roadmap import (  # noqa: F401 - fixtures
    PRD,
    ROADMAP,
    approved_prd,
    create,
    get,
    owner,
    runtime,
    start,
    tick,
)
from tests.test_roadmap_doc_dates import record, with_line

DAY = date(2026, 11, 3)  # the version's own day

HEAD = """\
---
document: picnic-roadmap
title: Picnic shop roadmap
kind: roadmap
---

# Picnic shop roadmap {#roadmap}

"""


def basis(reference: str, day: date, *, kind: str = "estimate", item: str | None = None):
    return schedule.Basis(
        uuid.uuid4(),
        kind,
        reference,
        day,
        None,
        frozenset({item}) if item else None,
        item,
    )


# Every basis verified on Plan > Dates, each for one invented item.
BASES = [
    basis("EST-1", date(2026, 12, 1), item="saved-baskets"),
    basis("EST-2", date(2026, 12, 15), item="gift-notes"),
    basis("EST-3", date(2027, 1, 20), item="order-tracking"),
]


def flagged(body: str, bases=BASES, ref: date = DAY) -> list[tuple[str, str]]:
    found = doc_dates.find(parse_draft(HEAD + body).sections, title="Picnic shop", ref=ref)
    marks = doc_dates.check_found(found, list(bases), [])
    return [(m.section_key, m.text) for m in doc_dates.flagged(marks)]


ITEMS = """\
# Full version {#full}

## Now {#now}

### Saved baskets {#now-saved-baskets}

Saved baskets ship Dec 1, 2026.

### Gift notes {#now-gift-notes}

Gift notes ship Dec 15, 2026.

## Next {#next}

### Order tracking {#next-order-tracking}

Order tracking follows on Jan 20, 2027.
"""


def test_the_fixture_s_own_item_dates_are_backed():
    assert flagged(ITEMS) == []


# --------------------------------------------------------------------------- (1) matching


def test_a_date_for_another_item_the_sentence_names_is_backed():
    body = ITEMS.replace(
        "Saved baskets ship Dec 1, 2026.",
        "Saved baskets ship Dec 1, 2026; [Gift notes](#now-gift-notes) follow on Dec 15, 2026.",
    )
    assert flagged(body) == []


def test_a_summary_date_of_an_item_it_names_is_backed():
    body = (
        "## Summary {#summary}\n\n"
        "- [Saved baskets](#now-saved-baskets) first, then gift notes on Dec 15, 2026 and "
        "order tracking by Jan 20, 2027.\n\n"
        "## Outcomes {#outcomes}\n\n"
        "| Item | Outcome |\n|---|---|\n"
        "| [Saved baskets](#now-saved-baskets) | Gift notes (Dec 15, 2026) cut support mail |\n\n"
    ) + ITEMS
    # The summary names gift-notes and order-tracking by their keys' words.
    body = body.replace("gift notes on", "[Gift notes](#now-gift-notes) on").replace(
        "order tracking by", "[Order tracking](#next-order-tracking) by"
    )
    body = body.replace(
        "| Gift notes (Dec 15, 2026)", "| [Gift notes](#now-gift-notes) (Dec 15, 2026)"
    )
    assert flagged(body) == []


def test_a_milestone_date_is_the_latest_verified_end_of_its_items():
    body = ITEMS + (
        "\n## Milestones {#milestones}\n\n"
        "| Milestone | Items | Date |\n|---|---|---|\n"
        "| Holiday shop | [Saved baskets](#now-saved-baskets), [Gift notes](#now-gift-notes) "
        "| Dec 15, 2026 |\n"
    )
    assert flagged(body) == []
    # A milestone day that is no item's latest end stays flagged.
    assert flagged(body.replace("| Dec 15, 2026 |", "| Dec 10, 2026 |")) == [
        ("milestones", "Dec 10, 2026")
    ]


# --------------------------------------------------------------------------- (2) not claims


def test_dates_that_are_not_schedule_claims_are_not_checked():
    body = (
        "## Summary {#summary}\n\n"
        "Updated Nov 3, 2026. Today is Nov 3.\n\n"
        "Decision needed by Nov 10 on the gift-note length.\n\n"
        "Work runs Q1 2027 (Jan 1 – Mar 31, 2027).\n\n"
        '> The courier wrote: "we can carry parcels from Feb 2, 2027".\n\n'
        'The courier said "pickups start Feb 9, 2027" in their letter.\n\n'
        "## History {#history}\n\n"
        "- Oct 28, 2026: gift notes moved to Now.\n\n"
    ) + ITEMS
    assert flagged(body) == []


def test_a_truly_unbacked_date_is_still_flagged():
    body = ITEMS.replace("Order tracking follows on Jan 20, 2027.", "Order tracking: Feb 2, 2027.")
    assert flagged(body) == [("next-order-tracking", "Feb 2, 2027")]


# --------------------------------------------------------------------------- (3) commitment


def test_an_owner_s_commitment_backs_the_milestone_date_it_names():
    commitment = basis("CMT-9", date(2026, 12, 20), kind="commitment", item="order-tracking")
    body = ITEMS + (
        "\n## Milestones {#milestones}\n\n"
        "- Holiday launch (CMT-9) on Dec 20, 2026 for [Gift notes](#now-gift-notes).\n"
    )
    assert flagged(body, [*BASES, commitment]) == []
    # Without the commitment the date has no basis.
    assert flagged(body) == [("milestones", "Dec 20, 2026")]


# --------------------------------------------------------------------------- API: (4) and (5)

VERSIONS = f"/v1/documents/{ROADMAP}/versions"


async def _run_roadmap(client, auth, runtime, markdown: str) -> dict:  # noqa: F811
    from tests.test_roadmap import ITEMS as RUN_ITEMS

    runtime.script["roadmap_items"] = [Outcome(artifacts={"roadmap_items.yaml": RUN_ITEMS})]
    runtime.script["roadmap_draft"] = [Outcome(artifacts={"roadmap.md": markdown})]
    off = {"roadmap_items": False, "roadmap_review": False}
    run = await start(
        client, auth, await create(client, auth, source=PRD, knobs={"checkpoints": off})
    )
    await tick(client, auth)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "succeeded", run
    return (await client.get(f"{VERSIONS}/1", headers=auth)).json()


def _date_warnings(version: dict) -> list[dict]:
    return [w for w in version["warnings"] if w["code"] == "unverified_date"]


async def test_warnings_count_each_date_and_item_once(client, owner, runtime):  # noqa: F811
    _, auth = owner
    await approved_prd(client, auth)
    md = with_line("GA on 2026-12-15. Still GA on Dec 15, 2026, and GA 2026-12-15 again.")
    version = await _run_roadmap(client, auth, runtime, md)
    (warning,) = _date_warnings(version)
    assert "Dec 15, 2026" in warning["message"]
    assert warning["refs"]["day"] == "2026-12-15"
    assert warning["refs"]["item"] == "payment-step"


async def test_warnings_follow_bases_verified_and_withdrawn(client, owner, runtime):  # noqa: F811
    _, auth = owner
    await approved_prd(client, auth)
    version = await _run_roadmap(client, auth, runtime, with_line("GA on 2026-12-15."))
    assert len(_date_warnings(version)) == 1

    made = await record(client, auth, "ENG-77", "2026-12-15", item_key="payment-step")
    version = (await client.get(f"{VERSIONS}/1", headers=auth)).json()
    assert _date_warnings(version) == []
    doc = (await client.get(f"/v1/documents/{ROADMAP}", headers=auth)).json()
    assert [
        w for v in doc["versions"] for w in v["warnings"] if w["code"] == "unverified_date"
    ] == []

    resp = await client.post(
        f"/v1/schedule-bases/{made['id']}/withdraw", json={"reason": "re-planned"}, headers=auth
    )
    assert resp.status_code == 200, resp.text
    version = (await client.get(f"{VERSIONS}/1", headers=auth)).json()
    (warning,) = _date_warnings(version)
    assert "Dec 15, 2026" in warning["message"]
