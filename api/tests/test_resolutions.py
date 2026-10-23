"""D6 No per-item resolutions on re-run (#164): the agents answer every review entry, and
the next attempt shows a diff with each answer.

After a send-back with a structured review (D4), attempt 2's ``roadmap_items.yaml`` carries
``resolutions:`` (one per review entry: ``{id, action, status: done | declined, note}``).
Oracle checks each entry against the new file, without a model call
(:func:`oracle.runs.resolutions.resolve`), compares the two attempts field by field
(:func:`oracle.runs.resolutions.item_diff`, over the one D2 diff engine) and turns what it
found into reasons: ``declined_change`` (to confirm), ``change_not_applied`` (blocking) and
``unrequested_change`` (to confirm).

Unit tests check the pure functions; the integration tests send a ``prd_to_roadmap`` run
back from its Roadmap items checkpoint on the FakeRuntime and harvest attempt 2, against
Postgres. Test cards (protects / fails_when / no_claim) head each test. Made-up names only.
"""

from oracle.runs import reasons, resolutions, review_file, roadmap, workflow
from oracle.swarm import Outcome
from tests.test_checkpoint_review import Review, item_of, review  # noqa: F401 - fixtures
from tests.test_roadmap import approved_prd, get, owner, runtime, seed_baseline, tick  # noqa: F401

ITEMS_FILE = "roadmap_items.yaml"


def item(key: str, **kw) -> dict:
    base = {
        "id": key,
        "title": key.replace("-", " ").capitalize(),
        "outcome": f"Owners get {key}",
        "horizon": "now",
        "depends_on": [],
        "prd_section": "s-1",
    }
    return {**base, **kw}


def sent(*entries: dict, unchanged: list[str] | None = None, attempt: int = 1) -> dict:
    return {
        "version": 1,
        "checkpoint": "roadmap_items",
        "attempt": attempt,
        "file": ITEMS_FILE,
        "items": list(entries),
        "unchanged": unchanged or [],
    }


HORIZON = {"id": "x", "action": "change", "changes": {"horizon": "next"}}
BEFORE = [item("x"), item("y"), item("z")]


def entry_of(result: dict, key: str) -> dict:
    return next(e for e in result["entries"] if e["id"] == key)


# --- unit: resolve -----------------------------------------------------------------------


def test_an_applied_change_with_no_answer_is_done():
    """protects=AC1, a change the file shows is done without an answer; fails_when=a
    missing resolution turns an applied change into a problem; no_claim=agent prompts."""
    got = resolutions.resolve(sent(HORIZON), BEFORE, [item("x", horizon="next")], [])
    e = entry_of(got, "x")
    assert (e["outcome"], e["said"], e["note"]) == ("done", "missing", None)
    assert e["fields"] == [{"field": "horizon", "requested": "next", "applied": True,
                            "current": "next"}]  # fmt: skip
    assert got["counts"] == {"done": 1, "declined": 0, "not_applied": 0, "unrequested": 0}
    assert got["review_attempt"] == 1


def test_a_change_not_applied_and_declined_with_a_note_is_declined():
    """protects=AC2, C1b: an agent may decline with a reason; fails_when=the decline is
    counted done or not applied, or its note is lost; no_claim=the reason's wording."""
    said = [{"id": "x", "status": "declined", "note": "Next has no capacity"}]
    got = resolutions.resolve(sent(HORIZON), BEFORE, BEFORE, said)
    e = entry_of(got, "x")
    assert (e["outcome"], e["said"], e["note"]) == ("declined", "declined", "Next has no capacity")
    assert e["fields"][0]["applied"] is False and e["fields"][0]["current"] == "now"
    assert got["counts"]["declined"] == 1


def test_a_change_claimed_done_but_not_in_the_file_is_not_applied():
    """protects=AC3, a claimed change is checked against the file; fails_when=the agents'
    "done" is believed; no_claim=agent behaviour."""
    got = resolutions.resolve(sent(HORIZON), BEFORE, BEFORE, [{"id": "x", "status": "done"}])
    e = entry_of(got, "x")
    assert (e["outcome"], e["said"]) == ("not_applied", "done")
    assert got["counts"]["not_applied"] == 1


def test_a_change_not_applied_with_no_answer_is_not_applied():
    """protects=the table's last row; fails_when=silence counts as done or declined;
    no_claim=—."""
    e = entry_of(resolutions.resolve(sent(HORIZON), BEFORE, BEFORE, []), "x")
    assert (e["outcome"], e["said"]) == ("not_applied", "missing")


def test_an_applied_change_the_agents_declined_is_done_and_keeps_the_note():
    """protects=the file is the truth: applied is done whatever was said; fails_when=a
    contradicting answer hides an applied change or drops its note; no_claim=—."""
    said = [{"id": "x", "action": "change", "status": "declined", "note": "Moved anyway"}]
    e = entry_of(resolutions.resolve(sent(HORIZON), BEFORE, [item("x", horizon="next")], said), "x")
    assert (e["outcome"], e["said"], e["note"]) == ("done", "declined", "Moved anyway")


def test_a_decline_without_a_reason_is_not_a_decline():
    """protects=C1b, declining needs a reason; fails_when=a bare "declined" passes as a
    to-confirm decline; no_claim=—."""
    said = [{"id": "x", "status": "declined", "note": "  "}]
    e = entry_of(resolutions.resolve(sent(HORIZON), BEFORE, BEFORE, said), "x")
    assert (e["outcome"], e["said"], e["note"]) == ("not_applied", "declined", None)


def test_drop_is_done_when_the_id_is_gone_and_not_applied_when_it_stays():
    """protects=AC5; fails_when=a dropped item still in the file passes; no_claim=—."""
    drop = {"id": "y", "action": "drop"}
    gone = resolutions.resolve(sent(drop), BEFORE, [item("x"), item("z")], [])
    assert entry_of(gone, "y")["outcome"] == "done"
    kept = resolutions.resolve(sent(drop), BEFORE, BEFORE, [])
    assert (entry_of(kept, "y")["outcome"], entry_of(kept, "y")["said"]) == (
        "not_applied",
        "missing",
    )


def test_restore_is_done_when_the_id_is_back():
    """protects=restore is checked; fails_when=a restore stays absent unnoticed; no_claim=—."""
    restore = {"id": "w", "action": "restore"}
    assert (
        entry_of(resolutions.resolve(sent(restore), BEFORE, [*BEFORE, item("w")], []), "w")[
            "outcome"
        ]
        == "done"
    )
    assert entry_of(resolutions.resolve(sent(restore), BEFORE, BEFORE, []), "w")["outcome"] == (
        "not_applied"
    )


def test_split_needs_every_into_id_and_the_original_gone():
    """protects=split is checked; fails_when=a half split passes; no_claim=—."""
    split = {"id": "y", "action": "split", "into": ["y-a", "y-b"]}
    done = [item("x"), item("y-a"), item("y-b"), item("z")]
    assert entry_of(resolutions.resolve(sent(split), BEFORE, done, []), "y")["outcome"] == "done"
    half = [item("x"), item("y"), item("y-a"), item("y-b"), item("z")]
    assert entry_of(resolutions.resolve(sent(split), BEFORE, half, []), "y")["outcome"] == (
        "not_applied"
    )


def test_merge_is_done_when_the_with_ids_are_gone_and_one_item_names_them():
    """protects=merge is checked; fails_when=a merge leaving both items passes; no_claim=—."""
    merge = {"id": "x", "action": "merge", "with": ["y"]}
    kept = [item("x"), item("z")]
    assert entry_of(resolutions.resolve(sent(merge), BEFORE, kept, []), "x")["outcome"] == "done"
    named = [item("xy", merged_from=["x", "y"]), item("z")]
    assert entry_of(resolutions.resolve(sent(merge), BEFORE, named, []), "x")["outcome"] == "done"
    both = resolutions.resolve(sent(merge), BEFORE, BEFORE, [])
    assert entry_of(both, "x")["outcome"] == "not_applied"


def test_questions_and_accepts_have_nothing_to_check():
    """protects=only checkable entries can fail; fails_when=a question is "not applied";
    no_claim=what the agents did with the answer."""
    got = resolutions.resolve(
        sent(
            {"id": "x", "action": "question", "question": "Why now?"},
            {"id": "z", "action": "accept"},
        ),
        BEFORE,
        BEFORE,
        [],
    )  # fmt: skip
    assert [e["outcome"] for e in got["entries"]] == ["done", "done"]


def test_field_equality_normalises_dependencies_dates_and_clears():
    """protects=the same normalisation as D7 (depends_on as sets, dates as ISO strings);
    fails_when=a reordered list or a cleared field reads as not applied; no_claim=—."""
    before = [item("a"), item("b"), item("x", depends_on=["a", "b"],
              milestone={"name": "Beta", "date": "2026-11-30", "date_source": "ENG-1"},
              confidence="low")]  # fmt: skip
    after = [item("a"), item("b"), item("x", depends_on=["b"], milestone={"name": "GA"})]
    change = {"id": "x", "action": "change", "changes": {
        "depends_on": {"remove": ["a"]}, "milestone": {"date": None, "name": "GA"},
        "confidence": None}}  # fmt: skip
    e = entry_of(resolutions.resolve(sent(change), before, after, []), "x")
    assert e["outcome"] == "done"
    assert [(f["field"], f["applied"]) for f in e["fields"]] == [
        ("depends_on", True),
        ("milestone.date", True),
        ("milestone.name", True),
        ("confidence", True),
    ]
    still = [item("a"), item("b"), before[2]]
    e = entry_of(resolutions.resolve(sent(change), before, still, []), "x")
    assert [f["applied"] for f in e["fields"]] == [False, False, False, False]


def test_an_unchanged_item_whose_field_changed_is_an_unrequested_change():
    """protects=AC4, nothing changes behind the reviewer's back; fails_when=an outcome edit
    on an item listed under `unchanged` goes unseen; no_claim=—."""
    after = [item("x", horizon="next"), item("y", outcome="Owners get something else"), item("z")]
    got = resolutions.resolve(sent(HORIZON, unchanged=["y", "z"]), BEFORE, after, [])
    assert got["unrequested"] == [
        {"id": "y", "field": "outcome", "from": "Owners get y", "to": "Owners get something else"}
    ]
    assert got["counts"] == {"done": 1, "declined": 0, "not_applied": 0, "unrequested": 1}


# --- unit: item_diff ---------------------------------------------------------------------


def test_item_diff_lists_field_changes_in_the_files_names():
    """protects=AC7, the diff names each changed field; fails_when=a change is missed or a
    phantom one appears; no_claim=rendering."""
    after = [item("x", horizon="next", milestone="Beta"), item("y"), item("z")]
    got = resolutions.item_diff(BEFORE, after, 1)
    assert got == {
        "against_attempt": 1,
        "items": [{"id": "x", "changes": [
            {"field": "horizon", "from": "now", "to": "next"},
            {"field": "milestone.name", "from": None, "to": "Beta"},
        ]}],
        "added": [],
        "removed": [],
    }  # fmt: skip


def test_item_diff_lists_added_and_removed_ids():
    """protects=AC7 added/removed; fails_when=a split's new ids or a drop are missing;
    no_claim=—."""
    after = [item("x"), item("y-a", title="Y a"), item("y-b", title="Y b")]
    got = resolutions.item_diff(BEFORE, after, 1)
    assert (got["added"], got["removed"], got["items"]) == (["y-a", "y-b"], ["y", "z"], [])


def test_item_diff_counts_confidence_and_one_place_rank_moves():
    """protects=every field counts here (an unrequested change of any field surfaces);
    fails_when=confidence or a 1-place rank move is left out as a note; no_claim=D2's
    reasons."""
    before = [item("x", confidence="high", priority={"rank": 1})]
    after = [item("x", confidence="low", priority={"rank": 2})]
    [row] = resolutions.item_diff(before, after, 1)["items"]
    assert row["changes"] == [
        {"field": "confidence", "from": "high", "to": "low"},
        {"field": "priority.rank", "from": 1, "to": 2},
    ]


def test_item_diff_of_the_same_file_is_empty():
    """protects=no phantom changes; fails_when=a re-read reports changes; no_claim=—."""
    got = resolutions.item_diff(BEFORE, [dict(i) for i in BEFORE], 2)
    assert got == {"against_attempt": 2, "items": [], "added": [], "removed": []}


# --- unit: check_items -------------------------------------------------------------------

FILE = """\
version: 1
items:
  - id: x
    title: X
    outcome: Owners get x
    horizon: now
    prd_section: s-1
"""


def test_check_items_refuses_malformed_resolutions_as_a_file_problem():
    """protects=AC6, a malformed answer is visible, never silently ignored; fails_when=
    `resolutions: "yes"` or an entry without status passes; no_claim=the gate (tested
    below)."""
    for bad in ('"yes"', "[{id: x}]", "[{id: x, status: maybe}]", "[x]"):
        check = roadmap.check_items("resolutions: " + bad + "\n" + FILE)
        assert [(p["code"], p.get("item")) for p in check.problems] == [
            ("invalid_resolutions", None)
        ], bad
        assert check.resolutions == []


def test_check_items_returns_well_formed_resolutions():
    """protects=the agents' answers reach resolve; fails_when=they are dropped or a valid
    list is refused; no_claim=—."""
    text = "resolutions:\n  - {id: x, action: change, status: declined, note: No capacity}\n"
    check = roadmap.check_items(text + FILE)
    assert check.ok
    assert check.resolutions == [
        {"id": "x", "action": "change", "status": "declined", "note": "No capacity"}
    ]
    assert roadmap.check_items(FILE).resolutions == []


# --- unit: reasons -----------------------------------------------------------------------


def test_resolution_reasons_word_each_outcome_with_its_fixes():
    """protects=the outcome table's reasons (D2 vocabulary); fails_when=a claimed change
    is not blocking, a decline blocks, or the fixes do not stage the requested edit;
    no_claim=the D8 routes."""
    change = {"id": "y", "action": "change", "changes": {"horizon": "later"}}
    said = [{"id": "x", "status": "declined", "note": "Next has no capacity"},
            {"id": "y", "status": "done"}]  # fmt: skip
    after = [item("x"), item("y"), item("z", outcome="Owners get more")]
    got = resolutions.resolve(sent(HORIZON, change, {"id": "w", "action": "restore"},
                                   unchanged=["z"]), BEFORE, after, said)  # fmt: skip
    found = reasons.resolution_reasons(got, after)
    by = {(r["item"], r["code"]): r for r in found}
    declined = by[("x", "declined_change")]
    assert declined["severity"] == "confirm"
    assert declined["text"] == "Declined: Next has no capacity"
    assert [f["label"] for f in declined["fixes"]] == ["Accept decline", "Apply it myself"]
    assert declined["fixes"][1]["action"] == {
        "kind": "edit", "item": "x", "field": "horizon", "value": "next"}  # fmt: skip
    claimed = by[("y", "change_not_applied")]
    assert claimed["severity"] == "blocking"
    assert claimed["text"] == "The agents said done, but horizon is still now."
    assert [f["label"] for f in claimed["fixes"]] == ["Apply it myself", "Waive…"]
    silent = by[("w", "change_not_applied")]
    assert silent["text"] == "Not applied: w is not back. No answer from the agents."
    assert silent["fixes"][0]["action"]["kind"] == "restore"
    unrequested = by[("z", "unrequested_change")]
    assert unrequested["severity"] == "confirm"
    assert unrequested["text"] == (
        "Changed without being asked: outcome Owners get z → Owners get more"
    )
    assert [f["label"] for f in unrequested["fixes"]] == ["Accept", "Revert"]
    assert unrequested["fixes"][1]["action"] == {
        "kind": "edit", "item": "z", "field": "outcome", "value": "Owners get z"}  # fmt: skip
    for code in ("declined_change", "change_not_applied", "unrequested_change"):
        assert code in reasons.CATALOGUE


# --- unit: prompts -----------------------------------------------------------------------

INSTRUCTION = (
    "At the top of roadmap_items.yaml, write `resolutions:` with one entry per review entry: "
    "`{id, action, status: done | declined, note}`. Declining is allowed with a reason in "
    "`note`."
)


def test_the_revise_prompt_in_both_modes_has_the_resolutions_instruction():
    """protects=AC8, the agents are told how to answer; fails_when=either mode's revise
    prompt lacks it; no_claim=what the agents write."""
    review_ = sent(HORIZON)
    assert INSTRUCTION in review_file.change_request(review_)
    note = workflow.revise_note(1)
    assert "write `resolutions:` with one entry per review entry" in note
    assert "Declining is allowed with a reason in `note`." in note


# --- integration -------------------------------------------------------------------------

# The fixture's attempt 1 (tests.test_roadmap_reasons.SECOND), with a resolutions block:
# mobile-push stays in later (declined), gift-cards stays (claimed done).
ATTEMPT2 = """\
version: 1
prd: {document: checkout-redesign, version: 1}
resolutions:
  - id: mobile-push
    action: change
    status: declined
    note: Push waits for the app release, so it stays in Later
  - {id: gift-cards, action: drop, status: done}
items:
  - id: payment-step
    title: Payment step
    outcome: Buyers pay in one tap
    horizon: next
    priority: {score: 4.2, rank: 1, explanation: "activation weight 3 x contribution 2"}
    confidence: high
    prd_section: s-5-1
  - id: mobile-push
    title: Mobile push
    outcome: Buyers hear when the order ships
    horizon: later
    priority: {score: 3.0, rank: 2, explanation: "retention weight 1 x contribution 3"}
    confidence: low
    prd_section: s-5-2
  - id: gift-cards
    title: Gift cards
    outcome: Buyers pay with a gift card
    horizon: later
    confidence: medium
    prd_section: no-such-section
"""
APPLIED = """\
version: 1
prd: {document: checkout-redesign, version: 1}
items:
  - id: payment-step
    title: Payment step
    outcome: Buyers pay without re-entering their card
    horizon: next
    priority: {score: 4.2, rank: 1, explanation: "activation weight 3 x contribution 2"}
    confidence: high
    prd_section: s-5-1
  - id: mobile-push
    title: Mobile push
    outcome: Buyers hear when the order ships
    horizon: next
    priority: {score: 3.0, rank: 2, explanation: "retention weight 1 x contribution 3"}
    confidence: low
    prd_section: s-5-2
"""


async def _send_back(review: Review, runtime, attempt2: str) -> tuple[dict, dict]:  # noqa: F811
    """Stage two entries (mobile-push to Next, drop gift-cards), send back, harvest attempt
    2; the run waits at the attempt-2 checkpoint."""
    await review.act("approver", item_key="mobile-push", kind="edit", field="horizon",
                     value="next")  # fmt: skip
    await review.act("approver", item_key="gift-cards", kind="drop")
    runtime.script["roadmap_items"] = [Outcome(artifacts={ITEMS_FILE: attempt2})]
    run = await review.decide("approver", decision="changes_requested")
    [cp1] = [c for c in run["checkpoints"] if c["id"] == review.cp["id"]]
    await tick(review.client, review.auth)
    run = await get(review.client, review.auth, review.run["id"])
    assert run["waiting_on"] == "roadmap_items", run
    [cp2] = [c for c in run["checkpoints"] if c["status"] == "pending"]
    assert cp2["payload"]["attempt"] == 2
    return run, {"sent": cp1["review"], "cp": cp2}


async def test_attempt_2_shows_a_decline_a_claimed_change_and_an_unrequested_one(review, runtime):  # noqa: F811
    """protects=AC2, AC3, AC4 end to end: the stored check carries the resolution, the
    reasons and the diff, and the claimed change closes the gate until waived; fails_when=
    the resolution block is missing, a claimed change does not block, or the decline does;
    no_claim=SwarmCloud."""
    run, got = await _send_back(review, runtime, ATTEMPT2)
    assert got["sent"]["unchanged"] == ["payment-step"]
    [seg] = [s for s in run["segments"] if s["name"] == "roadmap_items"]
    check = seg["items_check"]
    assert got["cp"]["payload"]["items_check"]["resolution"] == check["resolution"]
    res = check["resolution"]
    assert res["review_attempt"] == 1 and res["attempt"] == 2
    assert [(e["id"], e["action"], e["outcome"], e["said"]) for e in res["entries"]] == [
        ("mobile-push", "change", "declined", "declined"),
        ("gift-cards", "drop", "not_applied", "done"),
    ]
    assert res["counts"] == {"done": 0, "declined": 1, "not_applied": 1, "unrequested": 1}
    assert check["diff"] == {
        "against_attempt": 1,
        "items": [{"id": "payment-step", "changes": [{"field": "outcome",
                   "from": "Buyers pay without re-entering their card",
                   "to": "Buyers pay in one tap"}]}],
        "added": [],
        "removed": [],
    }  # fmt: skip
    by = {(r["item"], r["code"]): r for r in check["reasons"]}
    assert by[("mobile-push", "declined_change")]["text"] == (
        "Declined: Push waits for the app release, so it stays in Later"
    )
    assert by[("gift-cards", "change_not_applied")]["severity"] == "blocking"
    assert by[("gift-cards", "change_not_applied")]["text"].startswith("The agents said done")
    assert by[("payment-step", "unrequested_change")]["text"] == (
        "Changed without being asked: outcome Buyers pay without re-entering their card → "
        "Buyers pay in one tap"
    )

    # The D8 read of attempt 2: each item's resolution and diff, added/removed on top.
    review.cp = got["cp"]
    read = await review.get("viewer")
    assert item_of(read, "mobile-push")["resolution"]["outcome"] == "declined"
    assert item_of(read, "gift-cards")["resolution"]["outcome"] == "not_applied"
    assert item_of(read, "payment-step")["diff"] == [
        {"field": "outcome", "from": "Buyers pay without re-entering their card",
         "to": "Buyers pay in one tap"}
    ]  # fmt: skip
    assert read["diff"]["against_attempt"] == 1 and read["diff"]["removed"] == []
    codes = [left["code"] for left in read["gate"]["left"]]
    assert "change_not_applied" in codes and "declined_change" not in codes
    assert read["gate"]["open"] is False
    # Waived (and the section problem it still has), the gate opens: the decline never
    # blocked.
    await review.act("approver", item_key="gift-cards", kind="waive",
                     value={"reason": "Gift cards stay for the pilot"})  # fmt: skip
    read = await review.get("viewer")
    assert read["gate"]["open"] is True, read["gate"]


async def test_attempt_2_that_applies_every_entry_is_done_with_a_diff(review, runtime):  # noqa: F811
    """protects=AC1, AC5, AC7: applied entries with no answers are done, the diff lists the
    move and the drop; fails_when=a missing answer is a problem or the diff misses one;
    no_claim=SwarmCloud."""
    run, got = await _send_back(review, runtime, APPLIED)
    [seg] = [s for s in run["segments"] if s["name"] == "roadmap_items"]
    check = seg["items_check"]
    res = check["resolution"]
    assert [(e["id"], e["outcome"], e["said"]) for e in res["entries"]] == [
        ("mobile-push", "done", "missing"),
        ("gift-cards", "done", "missing"),
    ]
    assert res["counts"] == {"done": 2, "declined": 0, "not_applied": 0, "unrequested": 0}
    assert check["diff"]["items"] == [
        {"id": "mobile-push", "changes": [{"field": "horizon", "from": "later", "to": "next"}]}
    ]
    assert check["diff"]["removed"] == ["gift-cards"]
    codes = {r["code"] for r in check["reasons"]}
    assert not codes & {"declined_change", "change_not_applied", "unrequested_change"}
    # Attempt 1 had neither.
    first = next(c for c in run["checkpoints"] if c["id"] == review.cp["id"])
    assert first["payload"]["items_check"]["resolution"] is None
    assert first["payload"]["items_check"]["diff"] is None


async def test_malformed_resolutions_keep_the_gate_closed_with_send_back_only(review, runtime):  # noqa: F811
    """protects=AC6 end to end: `resolutions: "yes"` is a file problem the gate counts and
    no waiver answers; fails_when=it is ignored or waivable; no_claim=—."""
    run, got = await _send_back(review, runtime, 'resolutions: "yes"\n' + APPLIED)
    [seg] = [s for s in run["segments"] if s["name"] == "roadmap_items"]
    check = seg["items_check"]
    assert [p["code"] for p in check["problems"]] == ["invalid_resolutions"]
    assert check["file_problems"] == 1
    review.cp = got["cp"]
    read = await review.get("viewer")
    assert [p["code"] for p in read["file_problems"]] == ["invalid_resolutions"]
    assert read["gate"]["open"] is False and read["gate"]["file_problems"] == 1
    out = await review.act("approver", expect=422, item_key="*", kind="waive",
                           value={"reason": "Fine"})  # fmt: skip
    assert "never waived" in out["detail"]
