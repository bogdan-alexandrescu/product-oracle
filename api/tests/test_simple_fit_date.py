"""Bring a date in (oracle.simple.fit_date): Oracle's ranked changes, the live date of a
picked set, the locked items, the case no set reaches, and the re-plan's estimate marks.
Pure functions, no database, no model call.

Test cards (protects / fails_when / no_claim):

- test_ranked_by_days_saved_for_least_harm: protects=one list, most days saved first, a tie
  ranked by the least harm, the must-include item last and not pickable; fails_when=the
  order follows the PRD or a must-include item can be ticked; no_claim=the wording.
- test_live_date_of_a_picked_set: protects=the picked set's date comes from the capacity
  queue (sizes, team, focus, order, waits), the same picks give the same date, an unknown
  or locked id changes nothing; fails_when=the date is a sum of the parts or a locked item
  can be cut by id; no_claim=how fast (no model call by construction).
- test_oracle_pick_reaches_the_target_with_the_least: protects=Oracle's own pick reaches
  the target and drops picks it does not need; fails_when=it ticks everything.
- test_locked_items: protects=guardrail and safety items are never offered, are listed with
  their rule, and say when cutting one would have reached the target.
- test_no_set_reaches_the_target: protects=reachable is false, the best date is every
  change at once, the draft moves the target to it.
- test_draft_marks_resized_items_for_a_new_estimate: protects=sliced and split items need a
  new estimate, a moved one does not; every moved date is listed old and new.
"""

import datetime as dt

from oracle.simple import fit_date as fd

START = dt.date(2026, 11, 16)


def plan(target: dt.date = dt.date(2027, 1, 29), focus_raise: float | None = 0.8) -> fd.Plan:
    m = fd.Milestone
    i = fd.Item
    return fd.Plan(
        start=START,
        engineers=4,
        focus=0.7,
        milestones=(
            m("M1", "M1 Inbox basics"),
            m("M2", "M2 Agent reply flow", wait_days=7, wait_name="M1 7-day hold"),
            m("M3", "M3 Team inbox"),
        ),
        items=(
            i("views", "Shared inbox views", 3, "M1", owner="Rina Vale"),
            i("assign", "Assign a thread", 2, "M1", owner="Owen Pike"),
            i("drafts", "Reply drafts in the inbox", 6, "M2", must=True),
            i(
                "send",
                "Send check before a draft goes out",
                3,
                "M2",
                guard="Guardrail: no draft is sent without an agent reading it.",
            ),
            i(
                "summary",
                "Thread summary card",
                4,
                "M2",
                lever="slice",
                slice_pw=2,
                owner="Tomas Brook",
            ),
            i("bulk", "Reply to similar threads at once", 5, "M2", lever="move"),
            i("chart", "Reply time chart", 4, "M2", lever="ungate"),
            i("tone", "Tone presets", 3, "M2", lever="next_prd"),
            i(
                "snippets",
                "Import saved snippets",
                2,
                "M2",
                lever="split",
                slice_pw=1,
                owner="Rina Vale",
            ),
            i(
                "cards",
                "Hide card numbers in drafts",
                2,
                "M2",
                guard="Safety: card numbers never reach a draft or a log.",
            ),
            i("edit", "Edit a thread summary", 2, "M3"),
        ),
        milestone="M2",
        target=target,
        focus_raise=focus_raise,
    )


def test_ranked_by_days_saved_for_least_harm():
    a = fd.answer(plan())
    pickable = [c for c in a.changes if c.pickable]
    assert [c.days for c in pickable] == sorted((c.days for c in pickable), reverse=True)
    for x, y in zip(pickable, pickable[1:], strict=False):
        if x.days == y.days:
            assert fd.HARM[x.cost_kind] <= fd.HARM[y.cost_kind]
    assert a.changes[-1].item == "Reply drafts in the inbox"
    assert a.changes[-1].pickable is False and a.changes[-1].cost_kind == "must"
    # Moving a 5 person-week item out saves more days than slicing 2 off another.
    ids = [c.id for c in a.changes]
    assert ids.index("bulk") < ids.index("summary")
    assert {c.lever for c in a.changes} == {
        "move",
        "next_prd",
        "slice",
        "ungate",
        "split",
        "overlap",
        "capacity",
    }
    bulk = next(c for c in a.changes if c.id == "bulk")
    assert bulk.pw_saved == 5 and bulk.cost_kind == "goal"
    assert bulk.moves[0][0] == "M2 Agent reply flow"


def test_live_date_of_a_picked_set():
    p = plan()
    today = fd.schedule(p).milestones["M2"]
    # 4 engineers at 70%: 2.8 person-weeks a week; M1's 5 then M2's 29 gated, plus the hold.
    assert today == START + dt.timedelta(days=round(34 / 2.8 * 7) + 7)
    picked = fd.date_of(p, ["bulk", "wait:M2"])
    assert picked == START + dt.timedelta(days=round(29 / 2.8 * 7))
    assert fd.date_of(p, ["bulk", "wait:M2"]) == picked
    assert fd.date_of(p, ["wait:M2", "bulk"]) == picked
    assert fd.date_of(p, ["nope", "send", "cards", "drafts"]) == today
    # Raising focus shortens every bar: not the sum of the parts.
    both = (today - fd.date_of(p, ["bulk", "focus"])).days
    alone = (today - fd.date_of(p, ["bulk"])).days + (today - fd.date_of(p, ["focus"])).days
    assert both != alone


def test_oracle_pick_reaches_the_target_with_the_least():
    p = plan()
    a = fd.answer(p)
    assert a.reachable
    assert a.pick_date <= p.target
    assert fd.date_of(p, a.pick) == a.pick_date
    assert len(a.pick) < len([c for c in a.changes if c.pickable])
    for cid in a.pick:
        assert fd.date_of(p, [x for x in a.pick if x != cid]) > p.target


def test_locked_items():
    a = fd.answer(plan())
    assert all(c.id not in ("send", "cards") for c in a.changes)
    assert [(it.title, it.guard) for it, _ in a.locked] == [
        (
            "Send check before a draft goes out",
            "Guardrail: no draft is sent without an agent reading it.",
        ),
        ("Hide card numbers in drafts", "Safety: card numbers never reach a draft or a log."),
    ]


def test_no_set_reaches_the_target():
    p = plan(target=dt.date(2026, 12, 20))
    a = fd.answer(p)
    assert a.reachable is False
    assert a.best_date > p.target
    assert set(a.pick) == {c.id for c in a.changes if c.pickable and c.days > 0}
    assert a.best_date == fd.date_of(p, a.pick)
    d = fd.draft(p, a.pick)
    assert d.new_target == a.best_date
    assert d.dates[0] == ("Target", p.target, a.best_date)


def test_cutting_a_locked_item_would_reach_is_said():
    p = plan(
        target=fd.date_of(plan(), [c.id for c in fd.answer(plan()).changes if c.pickable])
        - dt.timedelta(days=3)
    )
    a = fd.answer(p)
    assert a.reachable is False
    assert any(reach for _, reach in a.locked)


def test_draft_marks_resized_items_for_a_new_estimate():
    p = plan()
    d = fd.draft(p, ["summary", "snippets", "bulk", "tone"])
    assert [i.id for i in d.needs_estimate] == ["summary", "snippets"]
    assert [i.owner for i in d.needs_estimate] == ["Tomas Brook", "Rina Vale"]
    assert ("Tone presets", "Moved to the next PRD") in d.prd
    whats = {w: (b, a) for w, b, a in d.dates}
    assert whats["M2 Agent reply flow"][1] < whats["M2 Agent reply flow"][0]
    assert whats["Tone presets"][1] is None
    assert d.new_target is None
    # Locked items keep their size in the re-plan.
    assert {i.id: i.pw for i in d.plan.items}["send"] == 3
