"""B2 Baseline review from this run: the rows of what a run wrote to the baseline, their
reasons, the goals rule in the approve gate, look again and the send-back note, and Merge
into… (``POST /v1/baseline/entities/{id}/merge``).

A Build the baseline run (FakeRuntime) merges :data:`RUN_YAML` against Postgres: two
proposed goals (one measurable, one missing its target and owner), a feature with no goal
and no evidence, a duplicate of a person's feature (with evidence and a link to a
confirmed goal), a change to an unlocked item, and a proposal on a locked one. Made-up
names only.

Test cards (protects / fails_when / no_claim) head each test.
"""

import uuid

import pytest
from sqlalchemy import select

from oracle.baseline.models import Entity, EntityRevision, Proposal
from oracle.baseline.scoring import SETTINGS_KEY
from oracle.models import AuditEvent
from oracle.runs import gate
from oracle.runs.models import Checkpoint
from oracle.swarm import Outcome
from oracle.tenancy import tenant_session
from oracle.tenant_settings import TenantSetting
from tests.test_baseline_flow import started
from tests.test_runs import as_user, get, pending, tick
from tests.test_runs import owner as owner  # (tenant id, owner token headers)
from tests.test_runs import runtime as runtime  # the FakeRuntime fixture

RUN_YAML = """\
version: 1
entities:
  - type: goal
    key: g.activation
    title: Raise activation
    attrs: {metric: activated accounts, target: "40%", horizon: short, owner: Example Lead}
  - type: goal
    key: g.retention
    title: Keep teams longer
    attrs: {metric: retained teams, horizon: long}
  - type: feature
    key: f.cart-save
    title: Save cart
  - type: feature
    key: f.saved-carts-2
    title: Saved carts again
    evidence:
      - url: https://notes.example.com/carts
        excerpt: Buyers want to keep a cart for later.
  - type: feature
    key: f.search
    title: Search, faster
  - type: feature
    key: checkout
    title: Checkout, as the agent sees it
edges:
  - src: feature:f.saved-carts-2
    dst: goal:g.confirmed
    type: supports
    attrs: {contribution: 2}
"""
NEW = {"goal:g.activation", "goal:g.retention", "feature:f.cart-save", "feature:f.saved-carts-2"}
ALL = NEW | {"feature:f.search", "feature:checkout"}
LEFT_2 = "2 blocking problems left: fix or waive them, or send back to the agents"


async def entity(client, auth, **body) -> dict:
    resp = await client.post("/v1/baseline/entities", json=body, headers=auth)
    assert resp.status_code == 201, resp.text
    return resp.json()["entity"]


async def at_confirm(client, owner, runtime) -> dict:
    """A Build the baseline run waiting at Confirm the baseline after merging RUN_YAML."""
    _, auth = owner
    confirmed = await entity(client, auth, type="goal", key="g.confirmed", title="Grow orders")
    resp = await client.post(
        f"/v1/baseline/entities/{confirmed['id']}/confirm", json={}, headers=auth
    )
    assert resp.status_code == 200, resp.text
    await entity(client, auth, type="feature", key="checkout", title="Checkout")  # locked
    await entity(client, auth, type="feature", key="f.search", title="Search", origin="agent")
    target = await entity(client, auth, type="feature", key="f.saved-carts", title="Saved carts")
    resp = await client.post(
        "/v1/baseline/edges",
        json={"src_id": target["id"], "dst_id": confirmed["id"], "type": "supports",
              "attrs": {"contribution": 3}},
        headers=auth,
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    runtime.script["baseline"] = [
        Outcome(artifacts={"baseline.yaml": RUN_YAML, "summary.md": "# Summary\n"}),
        Outcome(artifacts={"baseline.yaml": RUN_YAML, "summary.md": "# Summary\n"}),
    ]
    run = await started(client, auth)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["waiting_on"] == "baseline_confirm", run
    return run


async def from_run(client, auth, run_id, expect=200) -> dict:
    resp = await client.get(f"/v1/baseline/from-run/{run_id}", headers=auth)
    assert resp.status_code == expect, resp.text
    return resp.json()


def rows_by_key(view: dict) -> dict[str, dict]:
    return {r["key"]: r for r in view["rows"]}


def codes(row: dict) -> list[str]:
    return [r["code"] for r in row["reasons"]]


async def act(client, auth, run, expect=200, **body) -> dict:
    cp = pending(run)
    resp = await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/actions", json=body, headers=auth
    )
    assert resp.status_code == expect, resp.text
    return resp.json()


async def decide(client, auth, run, decision="approved", note=None):
    cp = pending(run)
    return await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/decide",
        json={"decision": decision, "note": note},
        headers=auth,
    )


WAIVE = {"item_key": "goal:g.retention", "kind": "waive", "answers": ["goal_undecided"],
         "value": {"reason": "Revisit after the board meeting"}}  # fmt: skip


# --------------------------------------------------------------------------- rows


async def test_rows_are_what_the_run_created_changed_or_proposed(client, owner, runtime):
    # protects=criterion 1: membership by entities.run_id, entity_revisions.run_id and the
    # run's proposals, each row's change, its edges and the summary; fails_when=a row is
    # missing, an untouched item is listed, or a person's later edit drops the row;
    # no_claim=edges listed as rows of their own (counted under their entity).
    _, auth = owner
    run = await at_confirm(client, owner, runtime)
    view = await from_run(client, auth, run["id"])
    rows = rows_by_key(view)
    assert set(rows) == ALL
    assert {k for k, r in rows.items() if r["change"] == "new"} == NEW
    assert rows["feature:f.search"]["change"] == "changed"
    assert rows["feature:checkout"]["change"] == "proposal"
    assert len(rows["feature:checkout"]["proposal_ids"]) == 1
    assert rows["feature:f.saved-carts-2"]["edges"] == {"new": 1, "changed": 0}
    assert view["run"]["flow_title"] == "Build the baseline"
    assert view["checkpoint"]["kind"] == "baseline_confirm"
    assert view["checkpoint"]["status"] == "pending"
    assert [g["key"] for g in view["other_proposed_goals"]] == []
    # Grouped: goals first.
    assert [r["key"] for r in view["rows"]][:2] == ["goal:g.activation", "goal:g.retention"]
    summary = view["summary"]
    assert summary["items"] == 6 and summary["not_decided"] == 2
    assert summary["need_you"] == 5  # every row but the duplicate (fine)
    assert rows["feature:f.saved-carts-2"]["state"] == "fine"

    # A person's later edit keeps the row (handled once its reasons are gone).
    cart = rows["feature:f.cart-save"]["entity"]
    resp = await client.patch(
        f"/v1/baseline/entities/{cart['id']}", json={"title": "Save a cart"}, headers=auth
    )
    assert resp.status_code == 200, resp.text
    rows = rows_by_key(await from_run(client, auth, run["id"]))
    assert rows["feature:f.cart-save"]["state"] == "handled"


async def test_each_reason_fires_on_its_fixture(client, owner, runtime):
    # protects=criterion 2: every code on its row and not otherwise, low_confidence on the
    # company's low threshold; fails_when=a code is missing, extra, or ignores the setting;
    # no_claim=goal_check (B5 not built: the four fields stand in).
    tenant_id, auth = owner
    run = await at_confirm(client, owner, runtime)
    rows = rows_by_key(await from_run(client, auth, run["id"]))
    assert codes(rows["goal:g.activation"]) == ["goal_undecided", "no_evidence"]
    retention = rows["goal:g.retention"]
    assert codes(retention) == ["goal_undecided", "goal_not_measurable", "no_evidence"]
    blocking = retention["reasons"][0]
    assert (blocking["severity"], blocking["label"], blocking["waivable"]) == (
        "blocking", "Not decided", True,
    )  # fmt: skip
    assert retention["reasons"][1]["detail"] == "Missing: target, owner"
    assert retention["reasons"][1]["severity"] == "confirm"
    assert codes(rows["feature:f.cart-save"]) == ["no_evidence", "serves_no_goal"]
    assert codes(rows["feature:f.saved-carts-2"]) == []
    assert codes(rows["feature:checkout"]) == ["changes_your_edit"]

    # low_confidence: below the company's low threshold, following the setting.
    async with tenant_session(tenant_id) as s:
        e = await s.scalar(select(Entity).where(Entity.key == "f.saved-carts-2"))
        e.confidence = 0.32
        await s.commit()
    row = rows_by_key(await from_run(client, auth, run["id"]))["feature:f.saved-carts-2"]
    assert codes(row) == ["low_confidence"] and row["reasons"][0]["label"] == "Low confidence 32"
    async with tenant_session(tenant_id) as s:
        s.add(TenantSetting(key=SETTINGS_KEY, value={"low": 0.3}))
        await s.commit()
    row = rows_by_key(await from_run(client, auth, run["id"]))["feature:f.saved-carts-2"]
    assert codes(row) == []

    # material_conflict: an open material conflict on the item.
    goal = rows["goal:g.activation"]["entity"]
    resp = await client.post(
        "/v1/baseline/conflicts",
        json={"entity_id": goal["id"], "field": "attrs.weight",
              "claims": [{"value": 1, "source_kind": "docs"}, {"value": 3, "source_kind": "chat"}]},
        headers=auth,
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    row = rows_by_key(await from_run(client, auth, run["id"]))["goal:g.activation"]
    assert "material_conflict" in codes(row) and len(row["conflict_ids"]) == 1

    # Recomputed on every read: a goal confirmed on the Baseline page loses goal_undecided.
    resp = await client.post(f"/v1/baseline/entities/{goal['id']}/confirm", headers=auth)
    assert resp.status_code == 200, resp.text
    row = rows_by_key(await from_run(client, auth, run["id"]))["goal:g.activation"]
    assert "goal_undecided" not in codes(row)


# --------------------------------------------------------------------------- the gate


async def test_approve_refused_while_goals_undecided(client, owner, runtime):
    # protects=owner call c3 at Baseline confirm (criterion 3): 409 blocking_open naming
    # both goals, then 200 after a confirm and a staged waive, and the run moves on;
    # fails_when=approve succeeds with a proposed goal from the run that has no staged
    # waiver; no_claim=fake runtime; the console path is D3's own test.
    _, auth = owner
    run = await at_confirm(client, owner, runtime)
    cp = pending(run)
    assert cp["gate"]["open"] is False and cp["cannot_approve"] == LEFT_2
    resp = await decide(client, auth, run)
    assert resp.status_code == 409, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == "blocking_open" and detail["message"] == LEFT_2
    assert {(x["item"], x["code"], x["label"], x["waivable"]) for x in detail["left"]} == {
        ("goal:g.activation", "goal_undecided", "Not decided", True),
        ("goal:g.retention", "goal_undecided", "Not decided", True),
    }
    rows = rows_by_key(await from_run(client, auth, run["id"]))
    goal = rows["goal:g.activation"]["entity"]
    resp = await client.post(f"/v1/baseline/entities/{goal['id']}/confirm", headers=auth)
    assert resp.status_code == 200, resp.text
    resp = await decide(client, auth, run)
    assert resp.status_code == 409 and len(resp.json()["detail"]["left"]) == 1
    await act(client, auth, run, **WAIVE)
    view = await from_run(client, auth, run["id"])
    assert view["summary"]["not_decided"] == 0 and view["checkpoint"]["gate"]["open"] is True
    assert rows_by_key(view)["goal:g.retention"]["state"] == "handled"
    resp = await decide(client, auth, run)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "succeeded"
    # Approving confirms nothing by itself: the waived goal stays proposed.
    graph = (await client.get("/v1/baseline/graph", headers=auth)).json()
    assert {e["key"]: e["status"] for e in graph["entities"]}["g.retention"] == "proposed"


async def test_waive_rules(client, owner, runtime):
    # protects=criterion 4: a commenter's waive is 403, no reason is 422, a goal not from
    # this run is 422, deleting the waive closes the gate again; fails_when=any of them
    # is stored or the gate stays open; no_claim=the web.
    tenant_id, auth = owner
    run = await at_confirm(client, owner, runtime)
    commenter = await as_user(tenant_id, "commenter")
    await act(client, commenter, run, expect=403, **WAIVE)
    await act(client, auth, run, expect=422, **{**WAIVE, "value": {"reason": " "}})
    await act(client, auth, run, expect=422, **{**WAIVE, "item_key": "goal:g.confirmed"})
    await act(client, auth, run, expect=422, **{**WAIVE, "item_key": "feature:f.cart-save"})
    review = await act(client, auth, run, **WAIVE)
    first = next(a for i in review["items"] for a in i["actions"] if a["kind"] == "waive")
    await act(client, auth, run, **{**WAIVE, "item_key": "goal:g.activation"})
    run = await get(client, auth, run["id"])
    assert pending(run)["gate"]["open"] is True
    resp = await client.delete(
        f"/v1/runs/{run['id']}/checkpoints/{pending(run)['id']}/actions/{first['id']}",
        headers=auth,
    )
    assert resp.status_code in (200, 204), resp.text
    run = await get(client, auth, run["id"])
    assert pending(run)["gate"]["open"] is False
    assert [x["item"] for x in pending(run)["gate"]["left"]] == ["goal:g.retention"]


async def test_send_back_note_carries_staged_look_agains_only(client, owner, runtime):
    # protects=criterion 5: a staged look again is in the Send back note in 3.1 (7)'s
    # format and in the next attempt's prompt; a commenter's suggestion is not;
    # fails_when=the suggestion is sent or the staged one is missing; no_claim=what the
    # agents do with it.
    tenant_id, auth = owner
    run = await at_confirm(client, owner, runtime)
    commenter = await as_user(tenant_id, "commenter")
    await act(client, commenter, run, item_key="feature:f.search", kind="look_again",
              value={"note": "the old title was right"})  # fmt: skip
    await act(client, auth, run, item_key="goal:g.activation", kind="look_again",
              value={"note": "two sources give different targets"})  # fmt: skip
    await act(client, auth, run, item_key="feature:f.cart-save", kind="look_again",
              value={"note": "looks like a duplicate of f.saved-carts"})  # fmt: skip
    await act(client, auth, run, expect=422, item_key="feature:f.cart-save", kind="look_again",
              value={"note": "x" * 2001})  # fmt: skip
    cp = pending(run)
    resp = await client.put(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/note",
        json={"note": "Check the pricing interviews"},
        headers=auth,
    )
    assert resp.status_code in (200, 204), resp.text
    resp = await decide(client, auth, run, "changes_requested")
    assert resp.status_code == 200, resp.text
    prompt = runtime.submitted[-1].steps[0].prompt
    assert (
        "Look again at these items:\n"
        "- goal g.activation (Raise activation): two sources give different targets\n"
        "- feature f.cart-save (Save cart): looks like a duplicate of f.saved-carts\n"
        "General: Check the pricing interviews\n"
    ) in prompt
    assert "the old title was right" not in prompt


async def test_review_read_returns_the_same_rows(client, owner, runtime):
    # protects=criterion 6: D8's review read of the checkpoint lists from-run's rows (keys,
    # reasons, states); fails_when=its items are empty or differ; no_claim=the web.
    _, auth = owner
    run = await at_confirm(client, owner, runtime)
    await act(client, auth, run, **WAIVE)
    view = await from_run(client, auth, run["id"])
    cp = pending(run)
    resp = await client.get(f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/review", headers=auth)
    assert resp.status_code == 200, resp.text
    review = resp.json()
    assert [(i["key"], [r["code"] for r in i["reasons"]], i["state"]) for i in review["items"]] == [
        (r["key"], codes(r), r["state"]) for r in view["rows"]
    ]
    assert review["gate"] == view["checkpoint"]["gate"]


async def test_roles_and_inbox_counts(client, owner, runtime):
    # protects=criterion 7 and the Inbox summary: a viewer reads from-run, a commenter
    # gets 403 on merge, an unknown run is 404, the Inbox row counts need you and not
    # decided; fails_when=a viewer is refused or a commenter merges; no_claim=D9's child rows.
    tenant_id, auth = owner
    run = await at_confirm(client, owner, runtime)
    viewer = await as_user(tenant_id, "viewer")
    view = await from_run(client, viewer, run["id"])
    assert view["checkpoint"]["can_decide"] is False
    await from_run(client, auth, uuid.uuid4(), expect=404)
    rows = rows_by_key(view)
    commenter = await as_user(tenant_id, "commenter")
    source = rows["feature:f.saved-carts-2"]["entity"]
    resp = await client.post(
        f"/v1/baseline/entities/{source['id']}/merge",
        json={"into": rows["feature:f.cart-save"]["entity"]["id"]},
        headers=commenter,
    )
    assert resp.status_code == 403, resp.text
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    row = next(c for c in inbox["checkpoints"] if c["run_id"] == run["id"])
    assert row["summary"] == {"need_you": 5, "blocking": 2, "to_confirm": 3, "handled": 0,
                              "children": []}  # fmt: skip


# --------------------------------------------------------------------------- merge


async def test_merge_moves_evidence_and_edges(client, owner, runtime):
    # protects=criterion 8: evidence and edges move, a would-be duplicate edge is dropped,
    # open proposals on the source are rejected "Merged into <title>", the source is
    # deleted, the target gets a revision and an audit row is written; fails_when=any of
    # them is missing; no_claim=concurrent edits during a merge.
    tenant_id, auth = owner
    run = await at_confirm(client, owner, runtime)
    rows = rows_by_key(await from_run(client, auth, run["id"]))
    source = rows["feature:f.saved-carts-2"]["entity"]
    graph = (await client.get("/v1/baseline/graph", headers=auth)).json()
    target = next(e for e in graph["entities"] if e["key"] == "f.saved-carts")
    async with tenant_session(tenant_id) as s:
        s.add(Proposal(entity_id=uuid.UUID(source["id"]), run_id=uuid.UUID(run["id"]),
                       payload={"op": "update", "kind": "entity", "fields": {"title": "X"}},
                       status="open"))  # fmt: skip
        await s.commit()
    resp = await client.post(
        f"/v1/baseline/entities/{source['id']}/merge",
        json={"into": target["id"], "reason": "Same feature, different wording"},
        headers=auth,
    )
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["id"] == target["id"] and out["evidence_count"] == 1
    graph = (await client.get("/v1/baseline/graph", headers=auth)).json()
    assert "f.saved-carts-2" not in {e["key"] for e in graph["entities"]}
    supports = [e for e in graph["edges"] if e["src_id"] == target["id"]]
    assert len(supports) == 1  # the duplicate supports edge was dropped
    async with tenant_session(tenant_id) as s:
        proposal = await s.scalar(select(Proposal).where(Proposal.payload["fields"]["title"]
                                                         .as_string() == "X"))  # fmt: skip
        assert proposal.status == "rejected"
        assert proposal.payload["note"] == "Merged into Saved carts"
        revs = (
            await s.scalars(
                select(EntityRevision).where(EntityRevision.entity_id == uuid.UUID(target["id"]))
            )
        ).all()
        assert any(r.reason == "Same feature, different wording" for r in revs)
        audit = await s.scalar(
            select(AuditEvent).where(AuditEvent.action == "baseline.entity.merged")
        )
        assert audit is not None
    rows = rows_by_key(await from_run(client, auth, run["id"]))
    assert "feature:f.saved-carts-2" not in rows


@pytest.mark.parametrize(
    ("source_key", "into_key", "message"),
    [
        ("f.saved-carts-2", "g.confirmed", "Only items of the same type can be merged"),
        ("f.saved-carts", "f.cart-save", "Only items this run created can be merged here"),
        ("f.cart-save", "f.saved-carts", "Locked: a person edited it"),
    ],
)
async def test_merge_refusals_change_nothing(client, owner, runtime, source_key, into_key, message):
    # protects=each refusal of 3.3 is 409 and changes nothing; fails_when=a refused merge
    # deletes or moves anything; no_claim=the web's disabled tooltip.
    _, auth = owner
    run = await at_confirm(client, owner, runtime)
    graph = (await client.get("/v1/baseline/graph", headers=auth)).json()
    by_key = {e["key"]: e for e in graph["entities"]}
    if source_key == "f.cart-save":
        resp = await client.patch(
            f"/v1/baseline/entities/{by_key[source_key]['id']}", json={"body": "x"}, headers=auth
        )
        assert resp.status_code == 200
    resp = await client.post(
        f"/v1/baseline/entities/{by_key[source_key]['id']}/merge",
        json={"into": by_key[into_key]["id"]},
        headers=auth,
    )
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"] == message
    after = (await client.get("/v1/baseline/graph", headers=auth)).json()
    assert len(after["entities"]) == len(graph["entities"])
    assert len(after["edges"]) == len(graph["edges"])
    assert run["id"]


async def test_merge_refused_when_linked(client, owner, runtime):
    # protects=a PRD section never loses the item it cites; fails_when=merge deletes an
    # item with section links; no_claim=does not test concurrent edits during a merge.
    from oracle.docs.models import Document
    from oracle.v2.models import DocumentSectionLink

    tenant_id, auth = owner
    run = await at_confirm(client, owner, runtime)
    rows = rows_by_key(await from_run(client, auth, run["id"]))
    source = rows["feature:f.saved-carts-2"]
    assert source["merge"] == {"allowed": True, "why_not": None}
    async with tenant_session(tenant_id) as s:
        doc = Document(slug="example-prd", title="Example PRD")
        s.add(doc)
        await s.flush()
        s.add(DocumentSectionLink(document_id=doc.id, section_key="features", kind="implements",
                                  entity_id=uuid.UUID(source["entity"]["id"])))  # fmt: skip
        await s.commit()
    rows = rows_by_key(await from_run(client, auth, run["id"]))
    why = "Linked from a PRD section: edit or reject it instead"
    assert rows["feature:f.saved-carts-2"]["merge"] == {"allowed": False, "why_not": why}
    resp = await client.post(
        f"/v1/baseline/entities/{source['entity']['id']}/merge",
        json={"into": rows["feature:f.cart-save"]["entity"]["id"]},
        headers=auth,
    )
    assert resp.status_code == 409 and resp.json()["detail"] == why


# --------------------------------------------------------------------------- revisions


async def test_revisions_carry_the_run(client, owner, runtime):
    # protects=criterion 10: entity_revisions.run_id is set on the run's merge writes and
    # null on a person's edits; fails_when=either is wrong; no_claim=history before the
    # migration (stays null).
    tenant_id, auth = owner
    run = await at_confirm(client, owner, runtime)
    rows = rows_by_key(await from_run(client, auth, run["id"]))
    search = rows["feature:f.search"]["entity"]
    resp = await client.patch(
        f"/v1/baseline/entities/{search['id']}", json={"body": "Typed by a person"}, headers=auth
    )
    assert resp.status_code == 200, resp.text
    async with tenant_session(tenant_id) as s:
        revs = (
            await s.scalars(
                select(EntityRevision)
                .where(EntityRevision.entity_id == uuid.UUID(search["id"]))
                .order_by(EntityRevision.created_at)
            )
        ).all()
        by_run = [r.run_id for r in revs]
        assert by_run[0] is None  # created by a person (origin agent, no run)
        assert str(by_run[1]) == run["id"]  # the run's change
        assert by_run[-1] is None  # the person's edit
        cp = await s.scalar(select(Checkpoint).where(Checkpoint.run_id == uuid.UUID(run["id"])))
        assert cp.kind == "baseline_confirm"


def test_the_gate_registers_baseline_confirm():
    # protects=one registry decides every kind; fails_when=baseline_confirm is gated
    # outside it or goal_undecided is not waivable; no_claim=the live reasons (above).
    assert "baseline_confirm" in gate.BLOCKING_SOURCES
    assert gate.waivable("baseline_confirm", "goal_undecided")


# --------------------------------------------------------------------------- review fixes


async def test_a_staged_look_again_leaves_the_goal_undecided(client, owner, runtime):
    # protects=the tally matches the gate: only a staged waive (Leave proposed) answers
    # goal_undecided, so a staged look again on a goal keeps it "Not decided" in from-run's
    # summary, its row and the Inbox counts while the gate stays closed; fails_when=the
    # summary or the Inbox says 0 undecided while Approve is refused; no_claim=the web.
    _, auth = owner
    run = await at_confirm(client, owner, runtime)
    for key in ("goal:g.activation", "goal:g.retention"):
        await act(client, auth, run, item_key=key, kind="look_again",
                  value={"note": "check the target"})  # fmt: skip
    view = await from_run(client, auth, run["id"])
    assert view["checkpoint"]["gate"]["open"] is False
    assert view["summary"]["not_decided"] == 2
    rows = rows_by_key(view)
    assert rows["goal:g.activation"]["state"] == "needs_you"
    assert rows["goal:g.retention"]["state"] == "needs_you"
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    row = next(c for c in inbox["checkpoints"] if c["run_id"] == run["id"])
    assert row["summary"]["blocking"] == 2
    resp = await decide(client, auth, run)
    assert resp.status_code == 409 and len(resp.json()["detail"]["left"]) == 2


async def test_a_console_approval_is_held_while_a_goal_is_undecided(client, owner, monkeypatch):
    # protects=criterion 9 (D3 "Console gate" at Baseline confirm): a counted console MERGE
    # while goals from the run are undecided is recorded, not followed: the checkpoint stays
    # pending with console.needs "confirm" and the line, the run token stays read-only, and
    # confirm is 409 blocking_open until the goals are decided or waived, then 200;
    # fails_when=the approval is followed or confirmed with a goal undecided; no_claim=the
    # runtime's real console (the fake records the MERGE).
    from datetime import timedelta

    from oracle.runs import service
    from oracle.swarm import set_runtime
    from tests.swarmcloud_fake import FakeSwarmCloud
    from tests.test_adapter_v2 import _member

    tenant_id, auth = owner
    held = "Blocking problems are open: fix or waive them, then confirm"
    swarm = FakeSwarmCloud(mcp=True, await_input=True, service_answer=True)
    for step in ("baseline-1-researcher", "baseline-2-analyst"):
        swarm.step_files[step] = {"baseline.yaml": RUN_YAML, "summary.md": "# Summary\n"}
    set_runtime(swarm.runtime())
    try:
        await _member(tenant_id, "lead@example.com")
        confirmed = await entity(client, auth, type="goal", key="g.confirmed", title="Grow")
        resp = await client.post(f"/v1/baseline/entities/{confirmed['id']}/confirm", headers=auth)
        assert resp.status_code == 200, resp.text
        run = await started(client, auth)
        for _ in range(4):
            await tick(client, auth)
            run = await get(client, auth, run["id"])
            if run["waiting_on"] == "baseline_confirm":
                break
        assert run["waiting_on"] == "baseline_confirm", run
        cp = pending(run)
        assert cp["gate"]["open"] is False
        wf = cp["payload"]["wait"]["workflow_id"]
        posted = len(swarm.answers)
        swarm.console_answer(wf, "baseline-review1", "MERGE", by="lead@example.com")
        real_now = service._now
        monkeypatch.setattr(service, "_now", lambda: real_now() + timedelta(seconds=61))
        await tick(client, auth)
        run = await get(client, auth, run["id"])
        cp = next(c for c in run["checkpoints"] if c["id"] == cp["id"])
        assert cp["status"] == "pending" and cp["console"]["needs"] == "confirm"
        assert cp["console"]["reason"] == held
        assert len(swarm.answers) == posted
        async with tenant_session(tenant_id) as s:
            assert await service.token_hold(s, uuid.UUID(run["id"]), live=False) is not None
        base = f"/v1/runs/{run['id']}/checkpoints/{cp['id']}"
        resp = await client.post(f"{base}/decide", json={"decision": "confirm"}, headers=auth)
        assert resp.status_code == 409 and resp.json()["detail"]["code"] == "blocking_open"
        rows = rows_by_key(await from_run(client, auth, run["id"]))
        goal = rows["goal:g.activation"]["entity"]
        resp = await client.post(f"/v1/baseline/entities/{goal['id']}/confirm", headers=auth)
        assert resp.status_code == 200, resp.text
        resp = await client.post(f"{base}/decide", json={"decision": "confirm"}, headers=auth)
        assert resp.status_code == 409 and resp.json()["detail"]["code"] == "blocking_open"
        resp = await client.post(f"{base}/actions", json=WAIVE, headers=auth)
        assert resp.status_code == 200, resp.text
        resp = await client.post(
            f"{base}/decide",
            json={"decision": "confirm", "expected_revision": resp.json()["revision"]},
            headers=auth,
        )
        assert resp.status_code == 200, resp.text
        cp = next(c for c in resp.json()["checkpoints"] if c["id"] == cp["id"])
        assert cp["status"] == "approved"
    finally:
        set_runtime(None)
