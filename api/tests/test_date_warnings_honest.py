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

import pytest

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


# Each kind of date that is not a schedule claim, beside the same date written as a claim:
# the claim is flagged, so each skip is shown to be needed on its own.
NOT_CLAIMS = {
    "own day": ("Updated Nov 3, 2026.", "Gift wrap ships Nov 3, 2026."),
    "today": ("Today is Nov 3.", "Gift wrap ships Nov 3."),
    "decision due": (
        "Decision needed by Nov 10 on the gift-note length.",
        "Gift wrap ships by Nov 10 for the gift-note length.",
    ),
    "quarter range": (
        "Work runs Q1 2027 (Jan 1 – Mar 31, 2027).",
        "Work runs Jan 5 – Mar 31, 2027.",
    ),
    "blockquote": (
        '> The courier wrote: "we can carry parcels from Feb 2, 2027".',
        "The courier can carry parcels from Feb 2, 2027.",
    ),
    "quotation": (
        'The courier said "pickups start Feb 9, 2027" in their letter.',
        "The courier's pickups start Feb 9, 2027.",
    ),
}


@pytest.mark.parametrize("kind", NOT_CLAIMS)
def test_a_date_that_is_not_a_schedule_claim_is_not_checked(kind):
    skipped, claim = NOT_CLAIMS[kind]
    assert flagged(f"## Summary {{#summary}}\n\n{skipped}\n\n" + ITEMS) == []
    assert flagged(f"## Summary {{#summary}}\n\n{claim}\n\n" + ITEMS) != []


def test_a_history_section_s_dates_are_not_checked():
    history = "- Oct 28, 2026: gift notes moved to Now.\n\n"
    assert flagged("## History {#history}\n\n" + history + ITEMS) == []
    assert flagged("## Notes {#notes}\n\n" + history + ITEMS) != []


def test_a_decision_word_before_an_other_clause_does_not_hide_its_date():
    # Review minor: "Sign-off from legal, then ship on Mar 3" claims a ship date.
    body = "## Summary {#summary}\n\nSign-off from legal, then ship on Mar 3, 2027.\n\n" + ITEMS
    assert flagged(body) == [("summary", "Mar 3, 2027")]
    # The decision's own due date stays skipped.
    assert flagged("## Summary {#summary}\n\nSign-off needed on Mar 3, 2027.\n\n" + ITEMS) == []


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


def _stored_date_warnings(doc: dict) -> list[dict]:
    return [w for v in doc["versions"] for w in v["warnings"] if w["code"] == "unverified_date"]


async def test_stored_warnings_follow_a_tracker_re_match(client, owner, runtime):  # noqa: F811
    # Review minor: re-matching a tracker issue changes the items its basis covers, and
    # the versions list's stored warnings follow.
    from tests.test_tracks import track_of

    _, auth = owner
    await approved_prd(client, auth)
    await _run_roadmap(client, auth, runtime, with_line("GA on 2026-12-15."))
    track = await track_of(client, auth)

    async def match(item_key: str) -> None:
        resp = await client.post(
            "/v1/tracker/records",
            json={"tracker": "jira", "records": [
                {"external_ref": "ENG-700", "state": "todo", "track_id": track["id"],
                 "item_key": item_key}]},
            headers=auth,
        )  # fmt: skip
        assert resp.status_code == 200, resp.text

    await match("shipping-step")
    await record(client, auth, "CAP-9", "2026-12-15", tracker_key="ENG-700")
    doc = (await client.get(f"/v1/documents/{ROADMAP}", headers=auth)).json()
    assert len(_stored_date_warnings(doc)) == 1

    await match("payment-step")
    doc = (await client.get(f"/v1/documents/{ROADMAP}", headers=auth)).json()
    assert _stored_date_warnings(doc) == []


async def test_a_basis_change_re_checks_only_each_document_s_latest_version(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
    monkeypatch,
):
    # Review minor: the refresh runs inside the request, so it re-finds the dates of each
    # document's latest version only (an older version's read still re-checks its own).
    from tests.fixtures import import_draft
    from tests.test_roadmap import ROADMAP_MD

    _, auth = owner
    await approved_prd(client, auth)
    await _run_roadmap(client, auth, runtime, with_line("GA on 2026-12-15."))
    resp = await import_draft(client, auth, ROADMAP_MD, ROADMAP)
    assert resp.status_code == 201, resp.text

    checked: list[int] = []
    real = doc_dates.occurrences_for_version

    async def counted(db, version, *args, **kwargs):
        checked.append(version.number)
        return await real(db, version, *args, **kwargs)

    monkeypatch.setattr(doc_dates, "occurrences_for_version", counted)
    await record(client, auth, "ENG-78", "2026-12-15", item_key="payment-step")
    assert checked == [2]
    monkeypatch.undo()
    # The older version's own read still follows the bases.
    assert _date_warnings((await client.get(f"{VERSIONS}/1", headers=auth)).json()) == []
