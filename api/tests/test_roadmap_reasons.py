"""Product reasons on roadmap items (oracle.runs.reasons): every item says why it needs a
person, blocking (a rule problem of the check) or to confirm (advisory), each with a
plain sentence and its fixes as data.

Pure tests build :class:`ReasonContext` by hand; the integration tests advance a
``prd_to_roadmap`` run on the FakeRuntime against Postgres.
"""

import uuid

from sqlalchemy import select, text

from oracle.baseline.models import Entity
from oracle.roadmap import diff as item_diff
from oracle.runs import reasons as reasons_mod
from oracle.runs.models import Run
from oracle.runs.reasons import (
    TOP_RANKS,
    LinkedBlocker,
    ReasonContext,
    TracedFeature,
    reason_context,
    reasons_for,
    summarize,
)
from oracle.runs.roadmap import check_items
from oracle.swarm import Outcome
from oracle.tenancy import tenant_session
from tests.fixtures import draft, import_draft
from tests.roadmap_helpers import seed_trace
from tests.test_roadmap import (  # noqa: F401 - fixtures
    PRD,
    approved_prd,
    built_roadmap,
    create,
    get,
    owner,
    pending,
    runtime,
    seed_baseline,
    start,
    tick,
)

ROADMAP_V1 = {"kind": "roadmap_version", "label": "roadmap v1", "version": 1, "attempt": None}


def item(key: str, **kw) -> dict:
    return {
        "id": key,
        "title": kw.pop("title", key.replace("-", " ").capitalize()),
        "outcome": "Something better",
        "horizon": kw.pop("horizon", "now"),
        "prd_section": kw.pop("prd_section", "s-1"),
        "depends_on": kw.pop("depends_on", []),
        **kw,
    }


def ctx(**kw) -> ReasonContext:
    return ReasonContext(**{"low": 0.5, **kw})


def codes(reasons: list[dict], key: str | None = None) -> list[str]:
    return [r["code"] for r in reasons if key is None or r["item"] == key]


def only(reasons: list[dict], code: str) -> dict:
    (found,) = [r for r in reasons if r["code"] == code]
    return found


def check(yaml_text: str, **kw) -> tuple[list[dict], list[dict]]:
    out = check_items(yaml_text, **kw)
    return out.items, out.problems


# --------------------------------------------------------------------------- to confirm


def test_low_confidence_by_word_and_by_the_company_threshold():
    items = [
        item("a", confidence="low"),
        item("b", confidence=0.4),
        item("c", confidence=0.6),
        item("d", confidence="medium"),
    ]
    out = reasons_for(items, [], ctx(low=0.5))
    assert codes(out) == ["low_confidence", "low_confidence"]
    a, b = out
    assert (a["item"], a["severity"], a["label"]) == ("a", "confirm", "Low confidence")
    assert b["item"] == "b"
    assert b["text"] == "Confidence 0.4, under the company's low threshold (0.5)."
    assert [f["label"] for f in b["fixes"]] == ["Accept", "Move to Later", "Drop"]


def test_serves_no_goal_traced_and_untraced():
    items = [item("mobile-push"), item("ghost"), item("pay")]
    features = {
        "mobile-push": TracedFeature("mobile-push", "Mobile push", ("serves_no_goal",)),
        "ghost": None,
        "pay": TracedFeature("payment-step", "Payment step", ("no_evidence",)),
    }
    out = reasons_for(items, [], ctx(features=features))
    assert codes(out) == ["serves_no_goal", "serves_no_goal"]
    assert out[0]["text"] == "Mobile push supports no confirmed goal."
    assert out[0]["data"] == {"feature": "mobile-push"}
    assert out[1]["text"] == (
        "Oracle could not trace it to a baseline feature, so no goal is known."
    )
    assert [f["action"] for f in out[0]["fixes"]] == [
        {"kind": "accept", "item": "mobile-push", "field": None, "value": None},
        {"kind": "drop", "item": "mobile-push", "field": None, "value": None},
    ]
    # Not traced at all (the context could not say): no reason.
    assert reasons_for([item("x")], [], ctx()) == []


def test_horizon_changed_new_and_dropped_against_the_base():
    items = [item("a", horizon="next"), item("c", horizon="later")]
    base_items = {
        "a": {"horizon": "now", "raw": item("a", horizon="now")},
        "b": {"horizon": "next", "raw": item("b", horizon="next")},
    }
    out = reasons_for(items, [], ctx(base=ROADMAP_V1, base_items=base_items))
    assert [(r["item"], r["code"]) for r in out] == [
        ("a", "horizon_changed"),
        ("b", "dropped_item"),
        ("c", "new_item"),
    ]
    moved, dropped, new = out
    assert moved["label"] == "Moved from Now (roadmap v1)"
    assert moved["text"] == "It was in Now in roadmap v1."
    assert moved["fixes"][1] == {
        "label": "Keep in Now",
        "action": {"kind": "edit", "item": "a", "field": "horizon", "value": "now"},
    }
    assert new["label"] == "New since roadmap v1" and new["text"] == "Not in roadmap v1."
    assert dropped["text"] == "It was in roadmap v1 and is not in this file."
    assert [f["label"] for f in dropped["fixes"]] == ["Accept drop", "Keep"]
    assert dropped["fixes"][1]["action"]["kind"] == "restore"
    # No base: none of the three.
    assert reasons_for(items, [], ctx(base_items=base_items)) == []


def test_the_base_comparison_goes_through_the_one_diff(monkeypatch):
    calls = []
    real = item_diff.diff_items

    def spy(base, head, **kw):
        calls.append(([s.key for s in base], [s.key for s in head]))
        return real(base, head, **kw)

    monkeypatch.setattr(item_diff, "diff_items", spy)
    items = [item("a", horizon="next"), item("c")]
    base_items = {
        "a": {"horizon": "now", "raw": item("a")},
        "b": {"horizon": "now", "raw": item("b")},
    }
    out = reasons_for(items, [], ctx(base=ROADMAP_V1, base_items=base_items))
    assert calls == [(["a", "b"], ["a", "c"])]
    assert set(codes(out)) == {"horizon_changed", "dropped_item", "new_item"}


def test_a_top_rank_in_later():
    assert TOP_RANKS == 3
    items = [
        item("a", horizon="later", priority={"rank": 2}),
        item("b", horizon="later", priority={"rank": 4}),
        item("c", horizon="next", priority={"rank": 1}),
    ]
    out = reasons_for(items, [], ctx())
    assert [(r["item"], r["code"]) for r in out] == [("a", "rank_vs_horizon")]
    assert out[0]["text"] == "Ranked 2 but placed in Later."
    assert out[0]["fixes"][1]["action"] == {
        "kind": "edit", "item": "a", "field": "horizon", "value": "next",
    }  # fmt: skip


def test_linked_blocker_only_while_unresolved():
    items = [item("pay"), item("ship")]
    blockers = {
        "pay": [LinkedBlocker("psp", "Payment provider rate limit", "open")],
        "ship": [LinkedBlocker("carrier", "Carrier API", "resolved")],
    }
    out = reasons_for(items, [], ctx(blockers=blockers))
    assert [(r["item"], r["code"]) for r in out] == [("pay", "linked_blocker")]
    assert out[0]["text"] == "Payment provider rate limit is open."
    assert out[0]["data"]["blocker"] == "psp"
    assert [f["label"] for f in out[0]["fixes"]] == ["Accept", "Move to Later"]


def test_stale_section_when_its_hash_moved_or_it_is_gone():
    items = [
        item("a", prd_section="s-1"),
        item("b", prd_section="s-2"),
        item("c", prd_section="s-3"),
    ]
    out = reasons_for(
        items,
        [],
        ctx(
            section_changes={"s-1": (3, False), "s-2": (3, True)},
            prd_title="Checkout redesign PRD",
            prd_version=2,
            prd_titles={"a": "5.1 Payment step"},
        ),
    )
    assert [(r["item"], r["code"]) for r in out] == [("a", "stale_section"), ("b", "stale_section")]
    assert out[0]["text"] == (
        "5.1 Payment step changed in Checkout redesign PRD v3 after this item was derived from v2."
    )
    assert out[1]["text"] == (
        "Section s-2 is gone from Checkout redesign PRD v3; this item was derived from v2."
    )


# --------------------------------------------------------------------------- blocking

FILE = """\
version: 1
items:
{items}
"""


def test_every_item_problem_becomes_one_blocking_reason_with_a_fix():
    body = """\
  - {id: a, title: A, outcome: o, horizon: next, prd_section: s-1,
     milestone: {name: Beta, date: 2026-11-30}, depends_on: [b, nope],
     priority: {score: 2}, confidence: sure, feature: 7, requirements: x,
     blockers: [1], validation_gates: [1], economics: x}
  - {id: b, title: B, outcome: o, horizon: later, prd_section: zzz, depends_on: 5}
  - {id: c, title: C, horizon: soon, prd_section: s-1, milestone: [1]}
  - {id: c, title: C2, outcome: o, horizon: now, prd_section: s-1,
     milestone: {name: Beta, date: someday, date_source: guess}}
  - {title: No id, outcome: o, horizon: now, prd_section: s-1}
"""
    items, problems = check(FILE.format(items=body), prd_sections={"s-1"})
    out = reasons_for(items, problems, ctx(prd_title="Checkout redesign PRD", prd_version=1))
    blocking = [r for r in out if r["severity"] == "blocking"]
    assert len(blocking) == len(problems)
    assert sorted(codes(blocking)) == sorted(p["code"] for p in problems)
    for r in blocking:
        empty_ok = r["code"] == "missing_field" and r["data"]["fields"] == ["id"]
        assert r["fixes"] or empty_ok, r
        for f in r["fixes"]:
            assert f["action"]["item"] in {"a", "b", "c", "#5"}
    by = {(r["item"], r["code"]): r for r in blocking}
    assert by[("a", "date_outside_now")]["text"] == (
        "Dated milestones belong only in Now; this item is in Next."
    )
    assert [f["label"] for f in by[("a", "date_outside_now")]["fixes"]] == [
        "Remove date", "Move to Now",
    ]  # fmt: skip
    assert by[("a", "undated_source")]["label"] == "Date has no source"
    assert by[("a", "unknown_dependency")]["text"] == "nope is not an item in this file."
    assert by[("a", "order_breaks_dependency")]["text"] == "It is listed before B."
    assert by[("a", "order_breaks_dependency")]["fixes"][0]["action"]["field"] == "order"
    hbd = by[("a", "horizon_breaks_dependency")]
    assert hbd["text"] == (
        "Needs B, which is in Later. An item cannot ship before what it depends on."
    )
    assert [f["action"] for f in hbd["fixes"]] == [
        {"kind": "edit", "item": "a", "field": "horizon", "value": "later"},
        {"kind": "edit", "item": "b", "field": "horizon", "value": "next"},
        {"kind": "edit", "item": "a", "field": "depends_on", "value": {"remove": ["b"]}},
    ]
    assert [f["label"] for f in hbd["fixes"]] == [
        "Move to Later", "Pull dependency to Next", "Remove dependency",
    ]  # fmt: skip
    malformed = by[("a", "unexplained_priority")]
    assert malformed["label"] == "Malformed priority"
    assert malformed["fixes"] == [
        {"label": "Clear priority",
         "action": {"kind": "edit", "item": "a", "field": "clear:priority", "value": None}},
    ]  # fmt: skip
    assert (
        by[("b", "unknown_prd_section")]["text"]
        == "Section zzz is not in Checkout redesign PRD v1."
    )
    assert by[("b", "unknown_prd_section")]["fixes"][0]["label"] == "Link section"
    assert by[("c", "invalid_horizon")]["text"] == "soon is not Now, Next or Later."
    missing = [r for r in blocking if r["code"] == "missing_field"]
    assert {r["label"] for r in missing} == {"Missing outcome", "Missing id"}
    assert [f["label"] for f in by[("c", "missing_field")]["fixes"]] == ["Edit outcome"]
    drop = {"kind": "drop", "item": "c", "field": None, "value": None}
    assert by[("c", "duplicate_id")]["fixes"][0] == {"label": "Drop this one", "action": drop}
    assert by[("c", "invalid_date")]["text"] == "someday is not a date."
    assert by[("#5", "missing_field")]["fixes"] == []


def test_unverified_date_reads_in_full():
    body = """\
  - {id: a, title: A, outcome: o, horizon: now, prd_section: s-1,
     milestone: {name: Beta, date: 2026-11-30, date_source: a hunch}}
"""
    items, problems = check(FILE.format(items=body), date_bases=[])
    (r,) = reasons_for(items, problems, ctx())
    assert (r["code"], r["severity"], r["label"]) == (
        "unverified_date",
        "blocking",
        "Date unverified",
    )
    assert r["text"] == "No verified estimate, capacity or commitment supports 2026-11-30."
    # Record basis waits for the date bases form: only Remove date for now.
    assert r["fixes"] == [
        {"label": "Remove date",
         "action": {"kind": "edit", "item": "a", "field": "milestone_date", "value": None}},
    ]  # fmt: skip


def test_file_problems_are_not_reasons_and_are_counted():
    items, problems = check("version: 1\nitems: []\n")
    out = reasons_for(items, problems, ctx())
    assert out == []
    summary = summarize({"items": 0, "by_horizon": {}, "problems": problems}, out, None)
    assert summary["file_problems"] == 1 and summary["blocking"] == 0
    assert summary["reasons"] == [] and summary["base"] is None


def test_order_and_counts_are_stable():
    body = """\
  - {id: a, title: A, outcome: o, horizon: later, prd_section: s-1, depends_on: [b],
     confidence: low, priority: {rank: 1}}
  - {id: b, title: B, outcome: o, horizon: later, prd_section: s-1, confidence: low}
"""
    items, problems = check(FILE.format(items=body))
    context = ctx(features={"a": None, "b": None})
    one = reasons_for(items, problems, context)
    two = reasons_for(items, problems, context)
    assert one == two
    assert [(r["item"], r["code"]) for r in one] == [
        ("a", "order_breaks_dependency"),
        ("a", "low_confidence"),
        ("a", "serves_no_goal"),
        ("a", "rank_vs_horizon"),
        ("b", "low_confidence"),
        ("b", "serves_no_goal"),
    ]
    s = summarize({"items": 2, "by_horizon": {}, "problems": problems}, one, None)
    assert (s["blocking"], s["to_confirm"], s["file_problems"]) == (1, 5, 0)


def test_fix_builders_target_the_item_and_its_field():
    items = [item("a", horizon="now", confidence="low")]
    (r,) = reasons_for(items, [], ctx())
    assert [f["action"] for f in r["fixes"]] == [
        {"kind": "accept", "item": "a", "field": None, "value": None},
        {"kind": "edit", "item": "a", "field": "horizon", "value": "later"},
        {"kind": "drop", "item": "a", "field": None, "value": None},
    ]
    # Already in Later: Move to Later is not offered.
    (r,) = reasons_for([item("a", horizon="later", confidence="low")], [], ctx())
    assert [f["label"] for f in r["fixes"]] == ["Accept", "Drop"]


def test_without_a_context_only_blocking_reasons():
    body = """\
  - {id: a, title: A, outcome: o, horizon: later, prd_section: s-1, confidence: low,
     depends_on: [x]}
"""
    items, problems = check(FILE.format(items=body))
    out = reasons_for(items, problems, None)
    assert codes(out) == ["unknown_dependency"]


# --------------------------------------------------------------------------- integration

SECOND = """\
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


async def roadmap_items_check(client, auth, runtime, items: str) -> tuple[dict, dict]:  # noqa: F811
    runtime.script["roadmap_items"] = [Outcome(artifacts={"roadmap_items.yaml": items})]
    run = await start(client, auth, await create(client, auth, source=PRD))
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint" and run["waiting_on"] == "roadmap_items"
    return run, run["segments"][0]["items_check"]


async def test_advance_stores_reasons_on_the_segment_and_the_checkpoint(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    await seed_trace(tenant_id)  # an open critical blocker affects the payment step
    await built_roadmap(client, auth, runtime)  # roadmap v1: payment-step now, shipping-step next
    # A newer PRD version changes the shipping section (5.2), not the payment one (5.1).
    assert (await import_draft(client, auth, draft("prd_v2.md"))).status_code == 201

    run, check = await roadmap_items_check(client, auth, runtime, SECOND)
    assert pending(run)["payload"]["items_check"] == check
    assert check["base"] == ROADMAP_V1
    assert check.get("reasons_partial", False) is False
    got = [(r["item"], r["code"], r["severity"]) for r in check["reasons"]]
    assert got == [
        ("payment-step", "horizon_changed", "confirm"),
        ("payment-step", "linked_blocker", "confirm"),
        ("shipping-step", "dropped_item", "confirm"),
        ("mobile-push", "low_confidence", "confirm"),
        ("mobile-push", "serves_no_goal", "confirm"),
        ("mobile-push", "new_item", "confirm"),
        ("mobile-push", "rank_vs_horizon", "confirm"),
        ("mobile-push", "stale_section", "confirm"),
        ("gift-cards", "unknown_prd_section", "blocking"),
        ("gift-cards", "serves_no_goal", "confirm"),
        ("gift-cards", "new_item", "confirm"),
    ]
    by = {(r["item"], r["code"]): r for r in check["reasons"]}
    assert by[("payment-step", "horizon_changed")]["label"] == "Moved from Now (roadmap v1)"
    assert by[("payment-step", "linked_blocker")]["text"] == "Payment provider rate limit is open."
    assert by[("mobile-push", "serves_no_goal")]["text"] == (
        "Oracle could not trace it to a baseline feature, so no goal is known."
    )
    assert by[("mobile-push", "stale_section")]["text"] == (
        "5.2 Shipping step changed in Checkout redesign PRD v2 after this item was derived from v1."
    )
    assert by[("gift-cards", "unknown_prd_section")]["text"] == (
        "Section no-such-section is not in Checkout redesign PRD v1."
    )
    assert (check["blocking"], check["to_confirm"], check["file_problems"]) == (1, 10, 0)
    assert [p["code"] for p in check["problems"]] == ["unknown_prd_section"]


async def test_no_base_on_a_first_roadmap(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    first = SECOND.replace("    horizon: next\n", "    horizon: now\n", 1)
    _, check = await roadmap_items_check(client, auth, runtime, first)
    assert check["base"] is None
    found = {(r["item"], r["code"]) for r in check["reasons"]}
    assert not {c for _, c in found} & {"horizon_changed", "new_item", "dropped_item"}
    # The payment step's feature serves the confirmed activation goal; no blocker yet.
    assert not [c for k, c in found if k == "payment-step"]
    assert ("mobile-push", "serves_no_goal") in found


async def test_a_resolved_blocker_and_a_confirmed_goal_clear_on_recompute(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    ids = await seed_trace(tenant_id)
    async with tenant_session(tenant_id) as s:
        goal = await s.scalar(select(Entity).where(Entity.type == "goal"))
        goal.status = "proposed"
        await s.commit()
    run, check = await roadmap_items_check(client, auth, runtime, SECOND)
    pay = [r for r in check["reasons"] if r["item"] == "payment-step"]
    assert {r["code"] for r in pay} == {"linked_blocker", "serves_no_goal"}
    assert only(pay, "serves_no_goal")["text"] == "Payment step supports no confirmed goal."

    async with tenant_session(tenant_id) as s:
        blocker = await s.get(Entity, ids["blocker"])
        blocker.attrs = {
            **blocker.attrs,
            "blocker": {**blocker.attrs["blocker"], "status": "resolved"},
        }
        goal = await s.scalar(select(Entity).where(Entity.type == "goal"))
        goal.status = "confirmed"
        await s.commit()
    async with tenant_session(tenant_id) as s:
        row = await s.get(Run, uuid.UUID(run["id"]))
        items, problems = check_items(SECOND).items, check_items(SECOND).problems
        again = reasons_for(items, problems, await reason_context(s, row, items))
    assert not [r for r in again if r["item"] == "payment-step"]


async def test_the_company_low_threshold_is_read(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    await approved_prd(client, auth)
    resp = await client.put(
        "/v1/settings/confidence_weights", json={"value": {"low": 0.5}}, headers=auth
    )
    assert resp.status_code == 200, resp.text
    items = [item("a", confidence=0.45, prd_section="s-5-1")]
    run = await create(client, auth, source=PRD)
    async with tenant_session(tenant_id) as s:
        context = await reason_context(s, await s.get(Run, uuid.UUID(run["id"])), items)
    assert context.low == 0.5
    assert codes(reasons_for(items, [], context)) == ["low_confidence", "serves_no_goal"]


async def test_a_failing_reason_context_keeps_the_tick_and_the_blocking_reasons(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
    monkeypatch,
):
    _, auth = owner
    await approved_prd(client, auth)

    async def broken(db, run, items, previous=None):
        await db.execute(text("SELECT * FROM no_such_table"))

    monkeypatch.setattr(reasons_mod, "reason_context", broken)
    run, check = await roadmap_items_check(client, auth, runtime, SECOND)
    assert check["reasons_partial"] is True
    assert [(r["item"], r["code"]) for r in check["reasons"]] == [
        ("gift-cards", "unknown_prd_section")
    ]
    assert (check["blocking"], check["to_confirm"]) == (1, 0)
    assert pending(run)["payload"]["items_check"] == check
