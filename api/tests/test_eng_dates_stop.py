"""F4 Engineering review stop, lane B: the Engineering dates (``eng_dates``) of Baseline
to PRD, after the PRD review, once the approved version's draft roadmap items are ready.

Every test states its card: protects / fails_when / no_claim. Against Postgres; the
FakeRuntime stands in for SwarmCloud, its architect and E1's items run (no model is
called). Synthetic placeholders only.
"""

import uuid

import pytest
from sqlalchemy import func, select

from oracle.models import AuditEvent
from oracle.roadmap.models import DraftRoadmap, RoadmapItem, ScheduleBasis
from oracle.runs import flows
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from oracle.tenancy import tenant_session
from tests.fixtures import seed_auth
from tests.review_v2_helpers import person
from tests.test_runs import create, decide, get, pending, started, tick

DATES = """\
version: 1
prd: {document: example-prd, version: 1}
items:
  - item: price-early
    estimate: {kind: estimate, reference: est-price-early, supports_date: 2026-11-30}
    confidence: medium
    assumptions: ["Two engineers from mid-November"]
"""


@pytest.fixture(autouse=True)
def derivations_start(monkeypatch):
    from oracle.config import get_settings

    monkeypatch.setattr(get_settings(), "draft_roadmaps_start", True)


@pytest.fixture
def runtime():
    fake = FakeRuntime({"eng_dates": [Outcome(artifacts={flows.DATES_FILE: DATES})] * 3})
    set_runtime(fake)
    yield fake
    set_runtime(None)


@pytest.fixture
async def owner():
    return await seed_auth()


def _url(run, cp) -> str:
    return f"/v1/runs/{run['id']}/checkpoints/{cp['id']}"


async def _act(client, headers, run, body):
    return await client.post(_url(run, pending(run)) + "/actions", json=body, headers=headers)


async def _approve(client, headers, run):
    return await client.post(
        _url(run, pending(run)) + "/decide", json={"decision": "approved"}, headers=headers
    )


async def _draft(tenant_id) -> DraftRoadmap:
    async with tenant_session(tenant_id) as s:
        return await s.scalar(select(DraftRoadmap))


async def _set_draft(tenant_id, **values) -> None:
    async with tenant_session(tenant_id) as s:
        row = await s.scalar(select(DraftRoadmap))
        for k, v in values.items():
            setattr(row, k, v)
        await s.commit()


async def _at_prd_review(client, auth, **knobs) -> dict:
    """A run waiting at the PRD review, every earlier stop approved."""
    run = await started(client, auth, **knobs)
    for kind in ("baseline_confirm", "feature_set", "eng_review", "priority_order"):
        await tick(client, auth)
        run = await get(client, auth, run["id"])
        assert run["waiting_on"] == kind, run["waiting_on"]
        run = await decide(client, auth, run)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["waiting_on"] == "prd_review", run["waiting_on"]
    return run


async def _at_dates(client, auth) -> dict:
    run = await _at_prd_review(client, auth)
    run = await decide(client, auth, run)
    for _ in range(6):
        if run["waiting_on"] == "eng_dates":
            return run
        await tick(client, auth)
        run = await get(client, auth, run["id"])
    raise AssertionError(f"never reached eng_dates: {run['status']} {run.get('waiting_for')}")


# --------------------------------------------------------------------------- unit


def test_the_flow_has_the_dates_stop_after_the_prd_draft_and_it_skips_when_off():
    # protects=AC1/AC2 segment order, skip_when_off, estimate; fails_when=the dates stop is
    # missing, sits before the PRD draft, is off by default or costs other than one
    # architect; no_claim=the run's wait for items (API tests below).
    flow = flows.FLOWS["baseline_to_prd"]
    assert [s.name for s in flow.segments] == [
        "baseline", "feature_set", "eng_review", "priority", "prd_draft", "eng_dates",
    ]  # fmt: skip
    sdef = flow.segment("eng_dates")
    assert sdef.title == "Engineering dates" and sdef.skip_when_off and sdef.waits_for_draft_items
    assert sdef.roles == ("architect",) and sdef.outputs == (flows.DATES_FILE,)
    assert "never date Next or Later" in sdef.task
    knobs = flows.resolve_knobs(flow, {})
    assert knobs.checkpoints["eng_dates"] is True
    assert flows.segment_estimate(sdef, knobs) == flows.Decimal("5.00")


@pytest.mark.parametrize(
    ("text", "code"),
    [
        ("version: 1\nprd: {document: other, version: 1}\nitems: []\n", "wrong_prd"),
        ("::: not yaml", "unreadable"),
        ("version: 1\nprd: {document: example-prd}\nitems:\n  - item: nope\n"
         "    no_date_reason: x\n", "unknown_item"),
        ("version: 1\nprd: {document: example-prd}\nitems:\n  - item: later-one\n"
         "    no_date_reason: x\n", "not_now"),
        ("version: 1\nprd: {document: example-prd}\nitems:\n  - item: price-early\n"
         "    estimate: {kind: estimate, reference: r, supports_date: soon}\n", "bad_date"),
        ("version: 1\nprd: {document: example-prd}\nitems: []\n", "missing_item"),
    ],
)  # fmt: skip
def test_the_dates_file_check_names_each_problem(text, code):
    # protects=AC12 check codes; fails_when=a file naming an unknown, Next/Later or
    # undated item passes, or a missing Now item goes unnoticed; no_claim=the screen.
    from oracle.engineering import dates

    items = {"price-early": "now", "later-one": "later"}
    problems = dates.check(text, "example-prd", 1, items)
    assert code in {p["code"] for p in problems}, problems


def test_a_good_dates_file_passes_the_check():
    # protects=AC12; fails_when=the architect's well-formed file is a problem; no_claim=-.
    from oracle.engineering import dates

    assert dates.check(DATES, "example-prd", 1, {"price-early": "now", "x": "next"}) == []


# --------------------------------------------------------------------------- API


async def test_a_new_run_has_both_stops_on_and_costs_36_50(client, owner, runtime):
    # protects=AC1, AC2 estimate; fails_when=the dates stop is off by default, missing from
    # the estimate, or counted with its stop off; no_claim=the deep and quick depths.
    _, auth = owner
    run = await create(client, auth)
    assert run["knobs"]["checkpoints"]["eng_dates"] is True
    est = (await client.post(f"/v1/runs/{run['id']}/estimate", headers=auth)).json()
    assert est["total_usd"] == pytest.approx(36.5)
    row = next(s for s in est["segments"] if s["name"] == "eng_dates")
    assert row["estimate_usd"] == 5.0 and row["title"] == "Engineering dates"
    off = await create(client, auth, checkpoints={"eng_dates": False})
    est = (await client.post(f"/v1/runs/{off['id']}/estimate", headers=auth)).json()
    assert est["total_usd"] == pytest.approx(31.5)
    body = (await client.get("/v1/flows", headers=auth)).json()
    b2p = next(f for f in body["flows"] if f["key"] == "baseline_to_prd")
    assert {s["name"]: s["decider"] for s in b2p["segments"]}["eng_dates"] == "engineering_lead"


async def test_with_the_dates_off_the_run_ends_at_the_prd_review(client, owner, runtime):
    # protects=AC2; fails_when=the run waits for items or submits eng_dates with the stop
    # off; no_claim=workflow mode.
    _, auth = owner
    run = await _at_prd_review(client, auth, checkpoints={"eng_dates": False})
    run = await decide(client, auth, run)
    assert run["status"] == "succeeded"
    assert "eng_dates" not in [s.labels["segment"] for s in runtime.submitted]


async def test_the_run_waits_for_the_items_then_submits_the_dates(client, owner, runtime):
    # protects=AC9, AC3-like checkpoint; fails_when=approving the PRD review ends the run,
    # submits eng_dates before the items are ready, or never shows waiting_for;
    # no_claim=E1's derivation itself (its own tests).
    tenant_id, auth = owner
    run = await _at_prd_review(client, auth)
    assert (await _draft(tenant_id)).status in ("queued", "running")
    run = await decide(client, auth, run)
    assert run["status"] == "running"
    assert run["waiting_for"] == {"kind": "draft_items", "version": 1}
    assert "eng_dates" not in [s.labels["segment"] for s in runtime.submitted]
    run = await _at_dates(client, auth)
    assert (await _draft(tenant_id)).status == "ready"
    assert run["waiting_for"] is None
    cp = pending(run)
    assert cp["kind"] == "eng_dates"
    check = cp["payload"]["dates_check"]
    assert check["problems"] == []
    assert [i["key"] for i in check["items"]] == ["price-early"]
    assert check["items"][0]["proposed"]["reference"] == "est-price-early"
    seg = next(s for s in run["segments"] if s["name"] == "eng_dates")
    assert flows.DATES_FILE in seg["artifacts"]


async def test_approve_needs_each_date_decided_then_records_verified_bases(client, owner, runtime):
    # protects=AC13, AC14; fails_when=Approve passes with a proposed date undecided, the
    # accepted estimate is not a verified basis by the decider scoped to the item, the
    # draft item keeps an unverified date, or a second identical basis is made;
    # no_claim=the Roadmap tab's rendering (Playwright).
    tenant_id, auth = owner
    run = await _at_dates(client, auth)
    resp = await _approve(client, auth, run)
    assert resp.status_code == 409, resp.text
    left = resp.json()["detail"]["left"]
    assert [(x["code"], x["item"]) for x in left] == [("date_undecided", "price-early")]
    resp = await _act(client, auth, run, {"item_key": "price-early", "kind": "accept",
                                          "value": None})  # fmt: skip
    assert resp.status_code in (200, 201), resp.text
    resp = await _approve(client, auth, run)
    assert resp.status_code == 200, resp.text
    run = await get(client, auth, run["id"])
    assert run["status"] == "succeeded"
    async with tenant_session(tenant_id) as s:
        bases = list(await s.scalars(select(ScheduleBasis)))
        assert len(bases) == 1
        b = bases[0]
        assert (b.status, b.reference, str(b.supports_date), b.item_key) == (
            "verified", "est-price-early", "2026-11-30", "price-early",
        )  # fmt: skip
        assert b.verified_by is not None
        item = await s.scalar(select(RoadmapItem).where(RoadmapItem.item_key == "price-early"))
        assert item.milestone["date"] == "2026-11-30"
        assert item.milestone.get("refused_date") is None
        assert item.milestone["date_source"] == "est-price-early"
        draft = await s.scalar(select(DraftRoadmap))
        codes = [p.get("code") for p in (draft.items_check or {}).get("problems") or []]
        assert "unverified_date" not in codes
        n = await s.scalar(
            select(func.count()).select_from(AuditEvent).where(
                AuditEvent.action == "schedule_basis.verified")
        )  # fmt: skip
        assert n == 1


async def test_a_basis_already_recorded_is_reused(client, owner, runtime):
    # protects=AC14 reuse; fails_when=a second identical verified basis is created;
    # no_claim=a basis of another date (a new one is right then).
    tenant_id, auth = owner
    run = await _at_dates(client, auth)
    async with tenant_session(tenant_id) as s:
        from datetime import date

        s.add(ScheduleBasis(
            kind="estimate", reference="est-price-early", supports_date=date(2026, 11, 30),
            prd_document_id=uuid.UUID(run["document_id"]), item_key="price-early",
            status="verified", verified_at=func.now(),
        ))  # fmt: skip
        await s.commit()
    await _act(client, auth, run, {"item_key": "price-early", "kind": "accept", "value": None})
    assert (await _approve(client, auth, run)).status_code == 200
    async with tenant_session(tenant_id) as s:
        assert await s.scalar(select(func.count()).select_from(ScheduleBasis)) == 1


async def test_a_changed_estimate_and_no_date(client, owner, runtime):
    # protects=AC14 changed estimates, AC13 no_date; fails_when=the changed reference and
    # date are not what is recorded, or No date records a basis; no_claim=-.
    tenant_id, auth = owner
    run = await _at_dates(client, auth)
    value = {"kind": "commitment", "reference": "ENG-412", "supports_date": "2026-12-04"}
    body = {"item_key": "price-early", "kind": "edit", "field": "estimate", "value": value}
    resp = await _act(client, auth, run, body)
    assert resp.status_code in (200, 201), resp.text
    assert (await _approve(client, auth, run)).status_code == 200
    async with tenant_session(tenant_id) as s:
        b = await s.scalar(select(ScheduleBasis))
        assert (b.kind, b.reference, str(b.supports_date)) == (
            "commitment",
            "ENG-412",
            "2026-12-04",
        )


async def test_no_date_records_no_basis(client, owner, runtime):
    # protects=AC14 last clause; fails_when=No date dates the item; no_claim=-.
    tenant_id, auth = owner
    run = await _at_dates(client, auth)
    body = {"item_key": "price-early", "kind": "edit", "field": "no_date",
            "value": {"reason": "Not yet"}}  # fmt: skip
    resp = await _act(client, auth, run, body)
    assert resp.status_code in (200, 201), resp.text
    assert (await _approve(client, auth, run)).status_code == 200
    async with tenant_session(tenant_id) as s:
        assert await s.scalar(select(func.count()).select_from(ScheduleBasis)) == 0


@pytest.mark.parametrize(
    ("body", "words"),
    [
        ({"kind": "accept", "item_key": "nope"}, "not a Now item"),
        ({"kind": "edit", "field": "no_date", "value": {"reason": " "}}, "needs a reason"),
        ({"kind": "edit", "field": "estimate",
          "value": {"kind": "estimate", "reference": "r", "supports_date": "soon"}}, "date"),
        ({"kind": "edit", "field": "estimate",
          "value": {"kind": "guess", "reference": "r", "supports_date": "2026-12-01"}}, "kind"),
        ({"kind": "edit", "field": "size", "value": "m"}, "edit takes the field"),
    ],
)  # fmt: skip
async def test_the_dates_vocabulary_refuses_what_it_does_not_allow(
    client, owner, runtime, body, words
):
    # protects=AC §7 422s; fails_when=an invalid estimate, no_date or item is stored;
    # no_claim=question actions (D8's own tests).
    _, auth = owner
    run = await _at_dates(client, auth)
    resp = await _act(client, auth, run, {"item_key": "price-early", "value": None, **body})
    assert resp.status_code == 422, resp.text
    assert words in resp.text


async def test_with_a_lead_named_an_approver_cannot_decide_the_dates(client, owner, runtime):
    # protects=AC4 at the dates stop; fails_when=an approver decides while a lead is named;
    # no_claim=the console path (A3's tests).
    tenant_id, auth = owner
    run = await _at_dates(client, auth)
    approver = await person(tenant_id, "approver")
    lead = await person(tenant_id, "commenter", "lead")
    resp = await client.patch(
        f"/v1/members/{lead.user_id}", json={"engineering_lead": True}, headers=auth
    )
    assert resp.status_code == 200, resp.text
    resp = await _act(client, lead.headers, run, {"item_key": "price-early", "kind": "accept",
                                                  "value": None})  # fmt: skip
    assert resp.status_code in (200, 201), resp.text
    assert (await _approve(client, approver.headers, run)).status_code == 403
    assert (await _approve(client, lead.headers, run)).status_code == 200
    async with tenant_session(tenant_id) as s:
        b = await s.scalar(select(ScheduleBasis))
        assert b.verified_by == lead.user_id


async def test_items_off_asks_for_a_derivation_by_the_runs_creator(client, owner, runtime):
    # protects=AC10; fails_when=the run waits on items nobody derives, or the derivation
    # is not a person's derive for the run's creator; no_claim=its $5.50 (E1).
    tenant_id, auth = owner
    run = await _at_prd_review(client, auth)
    await _set_draft(tenant_id, status="off")
    run = await decide(client, auth, run)
    row = await _draft(tenant_id)
    assert row.status == "queued" and row.requested_via == "derive"
    assert str(row.requested_by) == run["created_by"]
    assert run["waiting_for"] == {"kind": "draft_items", "version": 1}


async def test_a_failed_derivation_skips_the_dates_and_the_run_ends(client, owner, runtime):
    # protects=AC11; fails_when=the run waits forever, runs the architect, or ends without
    # the note; no_claim=the Plan's line.
    tenant_id, auth = owner
    run = await _at_prd_review(client, auth)
    run = await decide(client, auth, run)
    await _set_draft(tenant_id, status="failed", error="boom", run_id=None)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "succeeded", run["status"]
    seg = next(s for s in run["segments"] if s["name"] == "eng_dates")
    assert seg["status"] == "skipped" and seg["cost_usd"] == 0
    assert "Engineering dates skipped: roadmap items for v1 could not be derived" in str(seg)
    assert "eng_dates" not in [s.labels["segment"] for s in runtime.submitted]


async def test_a_draft_with_no_now_item_skips_the_dates(client, owner):
    # protects=AC11 second clause; fails_when=the architect runs with nothing to date;
    # no_claim=-.
    from oracle.swarm.fake import _default_content

    items = _default_content("roadmap_items.yaml", "roadmap_items", 1).replace(
        "horizon: now", "horizon: next"
    )
    fake = FakeRuntime({"roadmap_items": [Outcome(artifacts={"roadmap_items.yaml": items})]})
    set_runtime(fake)
    try:
        tenant_id, auth = owner
        run = await _at_prd_review(client, auth)
        run = await decide(client, auth, run)
        for _ in range(4):
            await tick(client, auth)
        run = await get(client, auth, run["id"])
        assert run["status"] == "succeeded", (run["status"], run.get("waiting_for"))
        seg = next(s for s in run["segments"] if s["name"] == "eng_dates")
        assert seg["status"] == "skipped"
        assert "No Now items in v1: nothing to date" in str(seg)
        assert "eng_dates" not in [s.labels["segment"] for s in fake.submitted]
    finally:
        set_runtime(None)


async def test_a_version_saved_after_the_prd_review_is_not_the_one_dated(client, owner, runtime):
    # protects=#590 review MAJOR 2: the stop dates the PRD version its review approved (the
    # PRD draft's import), not the document's newest; fails_when=a v2 saved while the run
    # waits for v1's items makes the stop wait for, summarize or date v2; no_claim=a run
    # whose PRD review approved v2 (the same lookup, by the import's number).
    from oracle.docs.models import DocumentVersion

    tenant_id, auth = owner
    run = await _at_prd_review(client, auth)
    run = await decide(client, auth, run)
    assert run["waiting_for"] == {"kind": "draft_items", "version": 1}
    async with tenant_session(tenant_id) as s:
        v1 = await s.scalar(
            select(DocumentVersion).where(
                DocumentVersion.document_id == uuid.UUID(run["document_id"])
            )
        )
        s.add(DocumentVersion(document_id=v1.document_id, number=2,
                              markdown=v1.markdown + "\nA later save.\n",
                              content_hash=f"{v1.content_hash}-2"))  # fmt: skip
        await s.commit()
    run = await _at_dates(client, auth)
    check = pending(run)["payload"]["dates_check"]
    assert check["prd"]["version"] == 1
    assert [i["key"] for i in check["items"]] == ["price-early"]
    await _act(client, auth, run, {"item_key": "price-early", "kind": "accept", "value": None})
    assert (await _approve(client, auth, run)).status_code == 200
    async with tenant_session(tenant_id) as s:
        item = await s.scalar(select(RoadmapItem).where(RoadmapItem.item_key == "price-early"))
        assert item.milestone["date_source"] == "est-price-early"


async def test_with_no_lead_named_an_approver_decides_the_dates_and_the_audit_says_so(
    client, owner, runtime
):
    # protects=#590 review minor: the no-lead fallback (A3) at the dates stop; fails_when=
    # an approver cannot decide with no lead named, or the decision's audit does not record
    # engineering_lead_named: false; no_claim=the lead-named case (above).
    tenant_id, auth = owner
    run = await _at_dates(client, auth)
    cp_id = uuid.UUID(pending(run)["id"])
    approver = await person(tenant_id, "approver")
    resp = await _act(client, approver.headers, run, {"item_key": "price-early",
                                                      "kind": "accept", "value": None})  # fmt: skip
    assert resp.status_code in (200, 201), resp.text
    assert (await _approve(client, approver.headers, run)).status_code == 200
    async with tenant_session(tenant_id) as s:
        event = await s.scalar(
            select(AuditEvent).where(
                AuditEvent.action == "checkpoint.approved", AuditEvent.entity_id == cp_id
            )
        )
        assert event.data["kind"] == "eng_dates"
        assert event.data["engineering_lead_named"] is False
        b = await s.scalar(select(ScheduleBasis))
        assert b.verified_by == approver.user_id
