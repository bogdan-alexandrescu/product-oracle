"""D7 Approve with edits: approving a Roadmap items checkpoint whose shared draft holds
staged edits applies them to ``roadmap_items.yaml`` (no model, nothing spent), re-checks the
result and its D3 gate, then continues as an approval does; or refuses with 409 and changes
nothing.

Integration tests wait a ``prd_to_roadmap`` run at its Roadmap items checkpoint on the
FakeRuntime (segment mode) or the fake SwarmCloud (workflow mode) against Postgres.

Test cards (protects / fails_when / no_claim) head each test. Synthetic placeholders only.
"""

import uuid
from datetime import timedelta

import pytest
from sqlalchemy import func, select

from oracle import safe_yaml
from oracle.jobs.models import LlmJob
from oracle.models import AuditEvent
from oracle.roadmap.models import RoadmapItem
from oracle.runs import service
from oracle.runs.models import Checkpoint, CheckpointAction, Run, RunSegment
from oracle.swarm import Outcome, set_runtime
from oracle.tenancy import tenant_session
from tests.review_v2_helpers import person
from tests.test_checkpoint_review import Review
from tests.test_roadmap import (  # noqa: F401 - fixtures
    PRD,
    ROADMAP_MD,
    approved_prd,
    create,
    owner,
    pending,
    runtime,
    seed_baseline,
    start,
)
from tests.test_roadmap_reasons import roadmap_items_check
from tests.test_runs import get, tick

ITEMS = """\
version: 1
prd: {document: checkout-redesign, version: 1}
items:
  - id: slack-alerts
    title: Slack alerts
    outcome: Owners hear about spikes in Slack
    horizon: now
    milestone: {name: Beta, date: 2026-11-30, date_source: ENG-1 estimate}
    confidence: high
    prd_section: s-5-1
  - id: mobile-push
    title: Mobile push
    outcome: Buyers hear when the order ships
    horizon: later
    confidence: medium
    prd_section: no-such-section
  - id: budget-caps
    title: Budget caps
    outcome: Owners cap the monthly spend
    horizon: next
    depends_on: [mobile-push]
    confidence: high
    prd_section: s-5-2
"""
FILE = "roadmap_items.yaml"
LATER = {"item_key": "budget-caps", "kind": "edit", "field": "horizon", "value": "later"}
NO_DATE = {"item_key": "slack-alerts", "kind": "edit", "field": "milestone_date", "value": None,
           "answers": ["unverified_date"]}  # fmt: skip
DROP = {"item_key": "mobile-push", "kind": "drop"}


@pytest.fixture
async def edits(client, owner, runtime) -> Review:  # noqa: F811
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    run, check = await roadmap_items_check(client, auth, runtime, ITEMS)
    assert {(r["item"], r["code"]) for r in check["reasons"] if r["severity"] == "blocking"} >= {
        ("slack-alerts", "unverified_date"),
        ("mobile-push", "unknown_prd_section"),
    }
    people = {"approver": await person(tenant_id, "approver", "abe")}
    return Review(client, tenant_id, auth, run, pending(run), people)


async def artifact(rv: Review, agents: bool = False, expect: int = 200) -> str:
    url = f"/v1/runs/{rv.run['id']}/segments/1/artifacts/{FILE}" + ("?agents=1" if agents else "")
    resp = await rv.client.get(url, headers=rv.auth)
    assert resp.status_code == expect, resp.text
    return resp.text


async def stage_three(rv: Review) -> list[str]:
    return [await _stage(rv, a) for a in (LATER, NO_DATE, DROP)]


async def _stage(rv: Review, action: dict) -> str:
    await rv.act("approver", **action)
    async with tenant_session(rv.tenant_id) as s:
        row = await s.scalar(
            select(CheckpointAction).where(
                CheckpointAction.checkpoint_id == uuid.UUID(rv.cp["id"]),
                CheckpointAction.item_key == action["item_key"],
                CheckpointAction.kind == action["kind"],
            )
        )
        return str(row.id)


def cp_of(run: dict, rv: Review) -> dict:
    return next(c for c in run["checkpoints"] if c["id"] == rv.cp["id"])


async def counts(rv: Review) -> tuple:
    async with tenant_session(rv.tenant_id) as s:
        run = await s.get(Run, uuid.UUID(rv.run["id"]))
        jobs = await s.scalar(select(func.count()).select_from(LlmJob))
        return run.spent_usd, jobs


async def test_approve_applies_the_staged_edits_and_continues(edits, runtime):  # noqa: F811
    """protects=criteria 1, 2, 3, 6, 9 and 10: Approve with 3 edits writes the edited file
    (header, horizon, no date, no dropped item or reference), keeps the agents' text for
    ?agents=1, re-checks the items, pastes the edited file into the roadmap draft's prompt,
    spends nothing and audits the edits; fails_when=the original is used downstream or
    anything is spent; no_claim=the web."""
    rv = edits
    original = await artifact(rv)
    assert original == ITEMS
    ids = await stage_three(rv)
    cp = cp_of(await get(rv.client, rv.auth, rv.run["id"]), rv)
    assert cp["approve_label"] == "Approve with 3 edits" and cp["needs_agents"] == []
    spent, jobs = await counts(rv)
    submitted = len(runtime.submitted)
    revision = (await rv.get())["revision"]
    run = await rv.decide("approver", decision="approved", expected_revision=revision)
    cp = cp_of(run, rv)
    assert cp["status"] == "approved"
    assert cp["review"]["kind"] == "edits" and cp["review"]["revision"] == 1
    assert cp["review"]["edits"] == 3
    assert {e["id"] for e in cp["review"]["applied"]} == {"budget-caps", "slack-alerts",
                                                          "mobile-push"}  # fmt: skip

    edited = await artifact(rv)
    assert edited.startswith(
        "# roadmap_items.yaml, edited at the Roadmap items checkpoint on "
    )
    assert "(abe" in edited.splitlines()[1].lower() and "3 edits applied by Oracle" in edited
    got = {i["id"]: i for i in safe_yaml.load(edited)["items"]}
    assert set(got) == {"slack-alerts", "budget-caps"}
    assert got["budget-caps"]["horizon"] == "later"
    assert "date" not in got["slack-alerts"]["milestone"]
    assert all("mobile-push" not in (i.get("depends_on") or []) for i in got.values())
    assert await artifact(rv, agents=True) == original

    codes = {(r["item"], r["code"]) for r in cp["payload"]["items_check"]["reasons"]}
    assert ("slack-alerts", "unverified_date") not in codes
    assert not [c for k, c in codes if k == "mobile-push"]
    segment = run["segments"][0]
    assert segment["items_check"]["blocking"] == 0
    assert segment["items_check"] == cp["payload"]["items_check"]

    # The roadmap draft segment was queued and submitted with the edited file pasted.
    assert run["segments"][1]["status"] in ("running", "pending")
    assert len(runtime.submitted) == submitted + 1
    prompt = runtime.submitted[-1].steps[-1].prompt
    assert "3 edits applied by Oracle" in prompt and "id: mobile-push" not in prompt
    assert await counts(rv) == (spent, jobs)

    async with tenant_session(rv.tenant_id) as s:
        row = await s.scalar(
            select(AuditEvent).where(
                AuditEvent.entity_id == uuid.UUID(rv.cp["id"]),
                AuditEvent.action == "checkpoint.approved",
            )
        )
        assert row.data["edits"] == 3 and sorted(row.data["actions"]) == sorted(ids)
        assert len(row.data["edited_sha256"]) == 64
        seg = await s.scalar(
            select(RunSegment).where(RunSegment.run_id == uuid.UUID(rv.run["id"]),
                                     RunSegment.seq == 1)
        )  # fmt: skip
        (rev,) = seg.artifacts["revisions"]
        assert rev["attempt"] == 1 and sorted(rev["actions"]) == sorted(ids)
        assert seg.artifacts["agent_files"]["1"][FILE] == original


async def test_the_roadmap_version_imports_the_edited_items(edits, runtime):  # noqa: F811
    """protects=criterion 8: the roadmap version's items follow the edited file;
    fails_when=a dropped item is imported or the old horizon kept; no_claim=the draft."""
    rv = edits
    runtime.script["roadmap_draft"] = [Outcome(artifacts={"roadmap.md": ROADMAP_MD})]
    await stage_three(rv)
    await rv.decide("approver", decision="approved")
    await tick(rv.client, rv.auth)
    run = await get(rv.client, rv.auth, rv.run["id"])
    assert run["waiting_on"] == "roadmap_review", run
    async with tenant_session(rv.tenant_id) as s:
        rows = {r.item_key: r for r in await s.scalars(select(RoadmapItem))}
    assert "mobile-push" not in rows
    assert rows["budget-caps"].horizon == "later"


async def test_edits_that_leave_a_blocking_problem_change_nothing(edits):  # noqa: F811
    """protects=criterion 4: Approve is 409 edits_leave_problems listing what is left, and
    the file, the checkpoint and its actions are unchanged; fails_when=a partial write or a
    decision lands; no_claim=the wording of each reason."""
    rv = edits
    await _stage(rv, LATER)
    await _stage(rv, DROP)
    cp = cp_of(await get(rv.client, rv.auth, rv.run["id"]), rv)
    assert cp["approve_label"] == "Approve with 2 edits"
    out = await rv.decide("approver", expect=409, decision="approved")
    detail = out["detail"]
    assert detail["code"] == "edits_leave_problems"
    assert detail["message"].startswith("After the edits, 1 blocking problem is left: ")
    assert [(x["item"], x["code"]) for x in detail["left"]] == [("slack-alerts", "unverified_date")]
    assert await artifact(rv) == ITEMS
    await artifact(rv, agents=True, expect=404)
    run = await get(rv.client, rv.auth, rv.run["id"])
    cp = cp_of(run, rv)
    assert cp["status"] == "pending" and cp["review"] is None
    assert ("mobile-push", "unknown_prd_section") in {
        (r["item"], r["code"]) for r in cp["payload"]["items_check"]["reasons"]
    }
    draft = await rv.get()
    assert sum(len(i["actions"]) for i in draft["items"]) == 2


async def test_a_staged_split_needs_the_agents(edits):  # noqa: F811
    """protects=criterion 5: with a staged split Approve is 409 needs_agents and the
    checkpoint names it; fails_when=Approve lands or the split is not named;
    no_claim=the send-back."""
    rv = edits
    await _stage(rv, NO_DATE)
    split = await _stage(rv, {"item_key": "budget-caps", "kind": "split",
                              "value": {"into": ["caps-ui", "caps-api"]}})  # fmt: skip
    cp = cp_of(await get(rv.client, rv.auth, rv.run["id"]), rv)
    assert cp["needs_agents"] == [{"action_id": split, "item": "budget-caps", "kind": "split"}]
    assert cp["approve_label"] == "Approve with 1 edit"
    out = await rv.decide("approver", expect=409, decision="approved")
    assert out["detail"]["code"] == "needs_agents" and out["detail"]["actions"] == [split]
    assert out["detail"]["message"] == (
        "Split on budget-caps needs the agents: send back, or remove it to approve."
    )
    assert await artifact(rv) == ITEMS


async def test_without_edits_approve_is_plain(edits):  # noqa: F811
    """protects=with only waivers staged the button is plain Approve and the file is the
    agents'; fails_when=a revision is written; no_claim=D3's gate (its own tests)."""
    rv = edits
    cp = cp_of(await get(rv.client, rv.auth, rv.run["id"]), rv)
    assert cp["approve_label"] == "Approve" and cp["needs_agents"] == []
    out = await rv.decide("approver", expect=409, decision="approved")
    assert out["detail"]["code"] == "blocking_open"


async def _workflow_run(client, owner, monkeypatch):  # noqa: F811
    from tests.swarmcloud_fake import FakeSwarmCloud
    from tests.test_adapter_v2 import _member

    tenant_id, auth = owner
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    swarm = FakeSwarmCloud(mcp=True, await_input=True, service_answer=True)
    set_runtime(swarm.runtime())
    for step in ("roadmap_items-1-analyst", "roadmap_items-2-prioritizer"):
        swarm.step_files[step] = {FILE: ITEMS}
    await _member(tenant_id, "lead@example.com")
    run = await start(client, auth, await create(client, auth, source=PRD))
    for _ in range(4):
        await tick(client, auth)
        run = await get(client, auth, run["id"])
        if run["waiting_on"] == "roadmap_items":
            break
    assert run["waiting_on"] == "roadmap_items", run
    people = {"approver": await person(tenant_id, "approver", "abe")}
    return swarm, Review(client, tenant_id, auth, run, pending(run), people)


async def test_workflow_mode_posts_merge_with_the_applied_edits(client, owner, monkeypatch):  # noqa: F811
    """protects=criterion 7: MERGE is posted with a finding naming what Oracle applied, and
    the run's file (what get_run_output reads) is the edited one; fails_when=the findings
    are empty or the original is served; no_claim=the real SwarmCloud."""
    try:
        swarm, rv = await _workflow_run(client, owner, monkeypatch)
        posted = len(swarm.answers)
        await stage_three(rv)
        await rv.decide("approver", decision="approved")
        assert len(swarm.answers) == posted + 1
        payload = swarm.answers[-1]["payload"]
        assert payload["verdict"] == "MERGE"
        (lead,) = [f for f in payload["findings"] if f.startswith("Oracle applied")]
        assert lead.startswith("Oracle applied the reviewer's edits to roadmap_items.yaml: ")
        assert "budget-caps horizon next → later" in lead
        assert "slack-alerts milestone date removed" in lead and "mobile-push dropped" in lead
        async with tenant_session(rv.tenant_id) as s:
            text = await service.read_artifact(s, uuid.UUID(rv.run["id"]), 1, FILE)
        assert "3 edits applied by Oracle" in text and "id: mobile-push" not in text
    finally:
        set_runtime(None)


async def test_a_console_approval_leaves_staged_edits_unapplied(client, owner, monkeypatch):  # noqa: F811
    """protects=criterion 11: a console MERGE held by the closed gate applies nothing; once
    the gate opens and an approver confirms it, the edits stay unapplied and the run notes
    it; fails_when=the edits are applied or the note is missing; no_claim=the real console."""
    try:
        swarm, rv = await _workflow_run(client, owner, monkeypatch)
        await _stage(rv, LATER)
        wf = rv.cp["payload"]["wait"]["workflow_id"]
        swarm.console_answer(wf, "roadmap_items-review1", "MERGE", by="lead@example.com")
        real_now = service._now
        monkeypatch.setattr(service, "_now", lambda: real_now() + timedelta(seconds=61))
        await tick(rv.client, rv.auth)
        cp = cp_of(await get(rv.client, rv.auth, rv.run["id"]), rv)
        assert cp["status"] == "pending" and cp["console"]["needs"] == "confirm"
        assert await artifact(rv) == ITEMS
        notes = (await get(rv.client, rv.auth, rv.run["id"]))["notes"]
        assert not [n for n in notes if "staged edit" in n]
        # The blocking problems are fixed or waived another way: a waiver can't answer a
        # date, so the console approval stays held until the test opens the stored check.
        async with tenant_session(rv.tenant_id) as s:
            row = await s.get(Checkpoint, uuid.UUID(rv.cp["id"]))
            check = {**row.payload["items_check"], "reasons": [], "blocking": 0}
            row.payload = {**row.payload, "items_check": check}
            await s.commit()
        revision = (await rv.get())["revision"]
        run = await rv.decide("owner", decision="confirm", expected_revision=revision)
        assert cp_of(run, rv)["status"] == "approved"
        assert cp_of(run, rv)["review"] is None
        assert await artifact(rv) == ITEMS
        notes = (await get(rv.client, rv.auth, rv.run["id"]))["notes"]
        assert "Approved in the runtime's console: 1 staged edit was not applied" in notes
    finally:
        set_runtime(None)
