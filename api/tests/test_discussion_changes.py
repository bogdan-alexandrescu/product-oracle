"""G3 Outcome extraction through the routes: Oracle's reply ends in typed changes, people
suggest, edit, stage, dismiss or act on them, and a discussion gets a summary draft.

Unit tests check the delimiter hold-back, the supersede rule and ``action`` / ``why_not``
per role and kind; the integration tests run against Postgres with G2's fake model, a
document's section discussions (G1's fixtures) and a ``prd_to_roadmap`` run waiting at
Roadmap items (D8's fixtures).

Each test's card: protects=<the observable>; fails_when=<the wrong result>;
no_claim=<what green does not prove>. Synthetic placeholders only.
"""

import asyncio
import json
import uuid

import pytest
from sqlalchemy import select

from oracle.baseline.models import Conflict, Proposal
from oracle.discussions import access, changes, context
from oracle.discussions.models import Discussion, DiscussionChange, DiscussionMessage
from oracle.llm import gateway
from oracle.llm.transports import TransportResult
from oracle.runs.models import CheckpointAction
from oracle.staging.models import NextDraftChange
from oracle.tenancy import tenant_session
from tests.baseline_helpers import entity
from tests.test_checkpoint_review import Review, review  # noqa: F401 - fixtures
from tests.test_discussion_replies import events_of, with_key
from tests.test_discussions import (
    company,
    events,
    get,
    patch,
    private_with_approver,
    section,
    start,
)
from tests.test_roadmap import owner, runtime  # noqa: F401 - fixtures

PUSH = "Move it to Next: it depends on an item in Later [c:1]."


class Fake:
    """Oracle's model, streaming ``chunks``; the last call's answer is their join."""

    def __init__(self, chunks: list[str]):
        self.chunks = chunks
        self.calls = 0

    async def complete(self, token, request) -> TransportResult:
        self.calls += 1
        return TransportResult(text="".join(self.chunks), model=request.model, usage={})

    async def stream(self, token, request, on_text) -> TransportResult:
        self.calls += 1
        for chunk in self.chunks:
            await asyncio.sleep(0.01)
            await on_text(chunk)
        return TransportResult(text="".join(self.chunks), model=request.model, usage={})


@pytest.fixture
def model():
    fake = Fake([])
    previous = gateway.set_transports(gateway.Transports(plan=fake, api_key=fake))
    yield fake
    gateway.set_transports(previous)


def horizon(item: str = "mobile-push", to: str = "next", **extra) -> dict:
    return {"kind": "item_horizon", "target": {"item_key": item},
            "payload": {"item_key": item, "horizon": to}, "rationale": PUSH, "basis": [],
            "replaces": None, **extra}  # fmt: skip


def answer_of(*entries: dict, prose: str = "It should move [c:1].") -> list[str]:
    tail = json.dumps({"changes": list(entries)})
    # The delimiter split across chunks, as a model streams it.
    return [prose, "\n<<<CHA", "NGES>>>", tail[:20], tail[20:]]


async def item_discussion(rv: Review, who: str = "commenter", item="mobile-push", **extra) -> str:
    resp = await rv.client.post(
        "/v1/discussions",
        json={"subject_kind": "checkpoint_item",
              "subject": {"run_id": rv.run["id"], "checkpoint_id": rv.cp["id"],
                          "checkpoint_kind": "roadmap_items", "item_key": item},
              "title": "Push timing", **extra},
        headers=rv.h(who),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def ask_and_stream(client, headers, d_id: str, body="@Oracle should it move?") -> list:
    resp = await client.post(
        f"/v1/discussions/{d_id}/messages", json={"body": body}, headers=headers
    )
    assert resp.status_code == 201, resp.text
    reply = resp.json()["reply"]
    resp = await client.get(f"/v1/discussions/{d_id}/messages/{reply['id']}/stream",
                            headers=headers)  # fmt: skip
    assert resp.status_code == 200, resp.text
    return events_of(resp.text)


async def listed(client, headers, d_id: str) -> list[dict]:
    resp = await client.get(f"/v1/discussions/{d_id}/changes", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def add_change(tenant_id, d_id: str, kind: str, payload: dict, **extra) -> str:
    """A change as Oracle's extraction leaves it (setup only)."""
    async with tenant_session(tenant_id) as s:
        row = DiscussionChange(
            discussion_id=uuid.UUID(d_id), kind=kind, target=extra.pop("target", {}),
            payload=payload, rationale="Because [c:1].", proposed_by_kind="oracle", **extra,
        )  # fmt: skip
        s.add(row)
        await s.commit()
        return str(row.id)


async def act(client, headers, change: dict | str, verb: str, expect=200, **body) -> dict:
    cid = change if isinstance(change, str) else change["id"]
    if "lock_version" not in body:
        async with tenant_session(_tenant[0]) as s:
            body["lock_version"] = (await s.get(DiscussionChange, uuid.UUID(cid))).lock_version
    resp = await client.post(f"/v1/discussion-changes/{cid}/{verb}", json=body, headers=headers)
    assert resp.status_code == expect, resp.text
    return resp.json()


_tenant: list = [None]


@pytest.fixture(autouse=True)
def _reset_tenant():
    _tenant[0] = None
    yield


def section_change(key="problem", instruction="Say detection follows activation") -> dict:
    return {"section_key": key, "instruction": instruction}


# --- unit -----------------------------------------------------------------------------------


# protects=the stream's hold-back: no part of the delimiter or the JSON is ever emitted, and
# text that only looked like the delimiter's start is emitted later; fails_when=a "<<<"
# prefix or the JSON reaches the chat, or prose is lost; no_claim=the route (criterion 1).
def test_the_hold_back_never_emits_the_delimiter_or_what_follows():
    hb = changes.HoldBack()
    out = [hb.feed(c) for c in ["Keep it <<", "< in mind. ", "Move it.\n<<<CHAN", 'GES>>>{"a":1}']]
    out.append(hb.flush())
    assert "".join(out) == "Keep it <<< in mind. Move it.\n"
    assert hb.tail == '{"a":1}'
    plain = changes.HoldBack()
    assert plain.feed("a" * 40) == "a" * 24
    assert plain.flush() == "a" * 16 and plain.tail is None


# protects=action and why_not per role and kind (c6, Discuss access, rule 4); fails_when=a
# viewer gets an action, a commenter may stage, or a rule-4 change may act;
# no_claim=the target's own role checks.
def test_action_and_why_not_per_role_and_kind():
    def seat(role, **kw):
        return access.Seat(role=role, visibility="open", participant=True, starter=False, **kw)

    c = DiscussionChange(kind="item_horizon", status="proposed", proposed_by_kind="oracle")
    assert changes.action_for(seat("viewer"), c) is None
    a = changes.action_for(seat("commenter"), c)
    assert (a.verb, a.allowed, a.why_not) == ("Stage", False, changes.APPROVERS_STAGE)
    a = changes.action_for(seat("approver"), c)
    assert (a.verb, a.allowed, a.why_not) == ("Stage", True, None)
    goal = DiscussionChange(kind="goal_measure", status="proposed", proposed_by_kind="oracle")
    assert changes.action_for(seat("commenter"), goal).allowed is True
    a = changes.action_for(seat("approver", author_only=True), c)
    assert (a.allowed, a.why_not) == (False, changes.SHARE_FIRST)
    assert changes.can_of(seat("viewer"), c, None).model_dump() == {
        "suggest": False, "edit": False, "withdraw": False, "dismiss": False}  # fmt: skip
    assert changes.can_of(seat("commenter"), c, None).suggest is True
    assert changes.can_of(seat("approver"), c, None).dismiss is True


def test_only_kinds_whose_pick_landed_are_available():
    """protects=Oracle is offered only available, allowed kinds; fails_when=scope, priority
    or ask kinds are offered before C2/C6/C9; no_claim=the prompt's wording."""
    assert set(changes.kinds.available_for("checkpoint_item")) >= {"item_horizon", "answer"}
    for kind in ("scope_feature", "priority_move", "ask_person", "basis_record"):
        assert kind not in changes.kinds.available_for("checkpoint_item")
    assert changes.kinds.available_for("section") == ["section_edit", "answer"]


# --- extraction -------------------------------------------------------------------------------


# protects=criterion 1 (card: Extraction): a reply ending in the delimiter creates one
# proposed change, a changes event comes before done, and no part of the delimiter or JSON is
# streamed or stored; fails_when=the JSON shows in the chat or no row is written;
# no_claim=the model's judgement (the fake reply stands in).
async def test_a_reply_with_changes_streams_prose_and_stores_one_proposed_change(review, model):  # noqa: F811
    rv = review
    _tenant[0] = rv.tenant_id
    await with_key(rv)
    d_id = await item_discussion(rv)
    model.chunks = answer_of(horizon())
    evs = await ask_and_stream(rv.client, rv.h("commenter"), d_id)
    text = "".join(e[1]["text"] for e in evs if e[0] == "delta")
    assert text == "It should move [c:1].\n"
    assert "<" not in text and "changes" not in text
    names = [e[0] for e in evs]
    assert names.index("changes") < names.index("done")
    [sent] = dict(evs)["changes"]
    assert (sent["kind"], sent["status"], sent["proposed_by_kind"]) == (
        "item_horizon", "proposed", "oracle")  # fmt: skip
    assert sent["label"] == "Move mobile-push to Next"
    async with tenant_session(rv.tenant_id) as s:
        reply = await s.get(DiscussionMessage, uuid.UUID(dict(evs)["done"]["id"]))
        assert "<<<" not in reply.body and reply.prompt == "discussion_reply.v2"
        [row] = list(await s.scalars(select(DiscussionChange)))
        assert row.from_message_id == reply.id


# protects=criterion 2 (card: Extraction): unavailable, disallowed, bad, locked and unsourced
# entries are dropped, one audit event each with no text; fails_when=a dropped entry is
# stored or its text audited; no_claim=the prompt's listing.
async def test_invalid_entries_are_dropped_and_audited_without_text(client, monkeypatch):
    ctx, doc = await company(client)
    d = await start(client, ctx, subject=section(doc))

    async def locked(db, document_id):
        return {"users"}

    monkeypatch.setattr(changes, "locked_sections", locked)
    ctx_ = context.Context()
    ctx_.add("finding", "f-shared", "Finding", "Shared line")
    entries = [
        {"kind": "scope_feature", "target": {}, "payload": {"feature_id": str(uuid.uuid4()),
         "decision": "defer", "reason": "SECRET-A"}, "rationale": "SECRET-A"},
        {"kind": "item_horizon", "target": {}, "payload": {"item_key": "x", "horizon": "next"},
         "rationale": "SECRET-B"},
        {"kind": "section_edit", "target": {}, "payload": {"section_key": "problem"},
         "rationale": "SECRET-C"},
        {"kind": "section_edit", "target": {}, "payload": section_change("users"),
         "rationale": "SECRET-D"},
        {"kind": "section_edit", "target": {}, "payload": section_change(),
         "rationale": "SECRET-E", "basis": ["f-hidden"]},
        {"kind": "section_edit", "target": {}, "payload": section_change(),
         "rationale": "Kept [c:1].", "basis": ["f-shared"]},
    ]  # fmt: skip
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(Discussion, uuid.UUID(d["id"]))
        # Two replies: at most 5 entries are read from one.
        made = await changes.extract(s, row, None, json.dumps({"changes": entries[:3]}), ctx_)
        made += await changes.extract(s, row, None, json.dumps({"changes": entries[3:]}), ctx_)
        await s.commit()
    dropped = await events(ctx, "discussion.change_dropped")
    assert [c.payload["section_key"] for c in made] == ["problem"], [e.data for e in dropped]
    assert [e.data["reason"] for e in dropped] == [
        "unavailable", "not_allowed", "bad_payload", "locked", "basis"]  # fmt: skip
    assert "SECRET" not in json.dumps([e.data for e in dropped])


# protects=criterion 3 (card: Extraction): a second Oracle proposal of the same kind and
# target supersedes the first, and never a person's suggestion; fails_when=duplicates stay
# open or a suggestion is overwritten; no_claim=G4's list.
async def test_a_second_proposal_supersedes_oracles_but_not_a_suggestion(review, model):  # noqa: F811
    rv = review
    _tenant[0] = rv.tenant_id
    await with_key(rv)
    d_id = await item_discussion(rv)
    model.chunks = answer_of(horizon())
    await ask_and_stream(rv.client, rv.h("commenter"), d_id)
    mine = await act(rv.client, rv.h("commenter"),
                     (await listed(rv.client, rv.h("commenter"), d_id))[0], "suggest")  # fmt: skip
    assert mine["change"]["status"] == "suggested"
    model.chunks = answer_of(horizon(to="later"))
    await ask_and_stream(rv.client, rv.h("commenter"), d_id, "@Oracle and now?")
    model.chunks = answer_of(horizon(to="now"))
    await ask_and_stream(rv.client, rv.h("commenter"), d_id, "@Oracle and now again?")
    rows = await listed(rv.client, rv.h("commenter"), d_id)
    by = {(c["payload"]["horizon"], c["status"]) for c in rows}
    assert by == {("next", "suggested"), ("later", "superseded"), ("now", "proposed")}


# --- roles ------------------------------------------------------------------------------------


# protects=criteria 4 and 5 (card: Roles): a commenter's Stage is 403 with the copy, their
# Suggest sets suggested_by, an approver's Stage writes one staged D8 action, a viewer is
# 403 everywhere and gets no action; fails_when=any role acts beyond 3.2;
# no_claim=D8's own role checks.
async def test_commenters_suggest_approvers_stage_and_viewers_only_read(review):  # noqa: F811
    rv = review
    _tenant[0] = rv.tenant_id
    d_id = await item_discussion(rv)
    cid = await add_change(rv.tenant_id, d_id, "item_horizon",
                           {"item_key": "mobile-push", "horizon": "next"})  # fmt: skip
    for verb in ("suggest", "stage", "dismiss", "withdraw", "propose", "resolve", "answer"):
        out = await act(rv.client, rv.h("viewer"), cid, verb, expect=403)
    [seen] = await listed(rv.client, rv.h("viewer"), d_id)
    assert seen["action"] is None and not any(seen["can"].values())
    out = await act(rv.client, rv.h("commenter"), cid, "stage", expect=403)
    assert out["detail"] == "Approvers stage changes. You can suggest it."
    out = await act(rv.client, rv.h("commenter"), cid, "suggest")
    assert out["change"]["suggested_by"]["user_id"] == rv.id("commenter")
    assert out["change"]["suggested_by"]["name"]
    out = await act(rv.client, rv.h("approver"), cid, "stage")
    assert out["change"]["status"] == "staged"
    assert out["change"]["result_ref"]["kind"] == "checkpoint_action"
    async with tenant_session(rv.tenant_id) as s:
        [action] = list(await s.scalars(select(CheckpointAction)))
    assert action.state == "staged" and str(action.id) == out["change"]["result_ref"]["id"]
    resp = await rv.client.get(f"/v1/discussions/{d_id}/messages", headers=rv.h("viewer"))
    lines = [m["body"] for m in resp.json()["items"]
             if m["author_kind"] == "system"]  # fmt: skip
    assert any(line.endswith("staged: Move mobile-push to Next") for line in lines)


# protects=criterion 12: a stale lock_version is 409 on every action; fails_when=a stale
# write applies; no_claim=concurrent transactions.
async def test_a_stale_lock_version_is_409(client):
    ctx, doc = await company(client)
    _tenant[0] = ctx.tenant_id
    d = await start(client, ctx, subject=section(doc))
    cid = await add_change(ctx.tenant_id, d["id"], "section_edit", section_change())
    for verb in ("suggest", "stage", "dismiss"):
        await act(client, ctx.as_("approver"), cid, verb, expect=409, lock_version=99)
    resp = await client.patch(f"/v1/discussion-changes/{cid}", headers=ctx.as_("approver"),
                              json={"payload": section_change(), "lock_version": 99})  # fmt: skip
    assert resp.status_code == 409


# protects=Edit and Withdraw (3.2): a commenter's edit becomes their suggestion, an
# approver's keeps the status, Withdraw returns Oracle's to proposed and dismisses a
# person's; fails_when=an edit loses the original payload or a withdrawn change vanishes;
# no_claim=the form (E2E).
async def test_edit_withdraw_dismiss_and_a_change_written_by_hand(client):
    ctx, doc = await company(client)
    _tenant[0] = ctx.tenant_id
    d = await start(client, ctx, subject=section(doc))
    cid = await add_change(ctx.tenant_id, d["id"], "section_edit", section_change())
    edited = section_change(instruction="Name the plan thresholds")
    resp = await client.patch(f"/v1/discussion-changes/{cid}", headers=ctx.as_("commenter"),
                              json={"payload": edited, "lock_version": 1})  # fmt: skip
    assert resp.status_code == 200, resp.text
    c = resp.json()["change"]
    assert c["status"] == "suggested" and c["edited_payload"] == edited
    assert c["payload"] == section_change() and c["label"].endswith("Name the plan thresholds")
    c = (await act(client, ctx.as_("commenter"), cid, "withdraw"))["change"]
    assert c["status"] == "proposed" and c["suggested_by"] is None
    resp = await client.post(
        f"/v1/discussions/{d['id']}/changes", headers=ctx.as_("commenter"),
        json={"kind": "section_edit", "target": {}, "payload": section_change("users"),
              "rationale": "Users first."},
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    mine = resp.json()["change"]
    assert mine["status"] == "suggested" and mine["proposed_by_kind"] == "person"
    assert (await act(client, ctx.as_("commenter"), mine, "withdraw"))["change"]["status"] == (
        "dismissed"
    )
    resp = await client.post(
        f"/v1/discussions/{d['id']}/changes", headers=ctx.as_("approver"),
        json={"kind": "item_horizon", "target": {}, "payload": {"item_key": "a",
              "horizon": "next"}, "rationale": "No."},
    )  # fmt: skip
    assert resp.status_code == 422
    c = (await act(client, ctx.as_("approver"), cid, "dismiss", note="Not now"))["change"]
    assert c["status"] == "dismissed" and c["decision_note"] == "Not now"


# --- pushback and private staging --------------------------------------------------------------


# protects=criterion 6 (C1b): Stage on a change whose reply pushed back needs a reason, which
# is stored and audited; fails_when=it stages unasked or the reason is lost;
# no_claim=the pushback's wording (G2).
async def test_a_pushed_back_change_needs_a_reason_to_stage(client):
    ctx, doc = await company(client)
    _tenant[0] = ctx.tenant_id
    d = await start(client, ctx, subject=section(doc))
    pushback = {"reason": "It breaks the activation goal", "sources": [1]}
    cid = await add_change(ctx.tenant_id, d["id"], "section_edit", section_change(),
                           pushback=pushback)  # fmt: skip
    [c] = await listed(client, ctx.as_("approver"), d["id"])
    assert c["pushback"] == pushback
    out = await act(client, ctx.as_("approver"), cid, "stage", expect=422)
    assert out["detail"] == "Oracle pushed back on this. Give a reason to stage it anyway."
    out = await act(client, ctx.as_("approver"), cid, "stage", override_reason="Ops asked")
    assert out["change"]["status"] == "staged"
    assert out["change"]["result_ref"]["kind"] == "next_draft_change"
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(DiscussionChange, uuid.UUID(cid))).override_reason == "Ops asked"
    [audited] = await events(ctx, "discussion.change_override")
    assert audited.data["change_id"] == cid


# protects=criterion 7 (card: Private staging): from a private discussion Stage needs the
# reason everyone will see, which travels with from_private; once made open, Stage needs none
# and the earlier row keeps its reason; fails_when=a private change stages with the rationale
# unasked, or an earlier row is rewritten; no_claim=G5's agent view.
async def test_private_staging_needs_a_reason_until_the_discussion_is_open(client):
    ctx, doc = await company(client)
    _tenant[0] = ctx.tenant_id
    d = await private_with_approver(client, ctx, doc, messages=1)
    first = await add_change(ctx.tenant_id, d["id"], "section_edit", section_change())
    [c] = await listed(client, ctx.as_("approver"), d["id"])
    assert c["needs_reason"] is True
    out = await act(client, ctx.as_("approver"), first, "stage", expect=422)
    assert out["detail"] == "Write the reason everyone will see"
    await act(client, ctx.as_("approver"), first, "stage", reason="Detection waits on activation")
    seen = await get(client, ctx, d["id"], "commenter")
    await patch(client, ctx, d["id"], "commenter", visibility="open", exposes=seen["exposure"],
                lock_version=seen["lock_version"])  # fmt: skip
    second = await add_change(ctx.tenant_id, d["id"], "section_edit", section_change("users"))
    await act(client, ctx.as_("approver"), second, "stage")
    async with tenant_session(ctx.tenant_id) as s:
        rows = {str(r.discussion_change_id): r for r in await s.scalars(select(NextDraftChange))}
    assert (rows[first].from_private, rows[first].reason) == (
        True, "Detection waits on activation")  # fmt: skip
    assert rows[second].from_private is False and rows[second].reason is None


# --- the other actions ----------------------------------------------------------------------


# protects=criterion 8 (Propose, Resolve, Use as answer): goal_measure becomes an open
# baseline proposal naming the discussion, conflict_pick resolves the conflict; each change
# ends done; fails_when=the baseline is written directly or the change stays open;
# no_claim=accepting the proposal (Baseline's tests).
async def test_propose_and_resolve_end_done(client):
    ctx, _doc = await company(client)
    _tenant[0] = ctx.tenant_id
    goal = await entity(client, ctx, type="goal", key="activation", title="Raise activation")
    d = await start(client, ctx, subject_kind="entity", subject={"entity_id": goal["id"]},
                    title="Activation measure")  # fmt: skip
    cid = await add_change(ctx.tenant_id, d["id"], "goal_measure",
                           {"entity_id": goal["id"], "metric": "activation rate", "target": 0.4,
                            "horizon": "Q3"})  # fmt: skip
    out = await act(client, ctx.as_("commenter"), cid, "propose")
    assert out["change"]["status"] == "done"
    pid = out["change"]["result_ref"]["proposal_id"]
    async with tenant_session(ctx.tenant_id) as s:
        proposal = await s.get(Proposal, uuid.UUID(pid))
        assert proposal.status == "open"
        assert "From discussion Activation measure" in proposal.payload["reason"]
        conflict = Conflict(
            entity_id=uuid.UUID(goal["id"]),
            field="title",
            claims=[{"value": "Raise activation"}, {"value": "Lift activation"}],
        )
        s.add(conflict)
        await s.commit()
        conflict_id = str(conflict.id)
    d2 = await start(client, ctx, subject_kind="conflict", subject={"conflict_id": conflict_id},
                     title="Which title")  # fmt: skip
    pick = await add_change(ctx.tenant_id, d2["id"], "conflict_pick",
                            {"conflict_id": conflict_id, "claim_index": 1,
                             "reason": "The plan says lift"})  # fmt: skip
    await act(client, ctx.as_("commenter"), pick, "resolve", expect=403)
    out = await act(client, ctx.as_("approver"), pick, "resolve")
    assert out["change"]["status"] == "done"
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(Conflict, uuid.UUID(conflict_id))).status == "resolved"


# --- rules 4 and 5 ------------------------------------------------------------------------------


# protects=criterion 10 (rule 5): lowering a finding to private supersedes the open changes
# resting on it with the note, staged ones stay; fails_when=an open change keeps resting on a
# private finding or a staged one is touched; no_claim=the intake routes' own checks.
async def test_a_finding_made_private_supersedes_the_open_changes_on_it(client):
    ctx, doc = await company(client)
    d = await start(client, ctx, subject=section(doc))
    intake_id = str(uuid.uuid4())
    basis = [{"intake_id": intake_id, "finding_id": "f1"}]
    open_ = await add_change(ctx.tenant_id, d["id"], "section_edit", section_change(),
                             basis=basis)  # fmt: skip
    staged = await add_change(ctx.tenant_id, d["id"], "section_edit", section_change("users"),
                              basis=basis, status="staged")  # fmt: skip
    other = await add_change(ctx.tenant_id, d["id"], "section_edit", section_change("goals"))
    async with tenant_session(ctx.tenant_id) as s:
        await changes.on_finding_lowered(s, uuid.UUID(intake_id), ["f1"])
        await s.commit()
        got = {str(c.id): c for c in await s.scalars(select(DiscussionChange))}
    assert (got[open_].status, got[open_].decision_note) == (
        "superseded", "The finding was made private")  # fmt: skip
    assert got[staged].status == "staged" and got[other].status == "proposed"


# --- summary ---------------------------------------------------------------------------------


# protects=criterion 11 (c5): Oracle drafts a summary of at most 1,200 characters; after
# the starter confirms it, a commenter's ask is 409 with the copy; closing queues a draft the
# next tick writes; fails_when=a confirmed summary is replaced unasked, or a closed
# discussion has none; no_claim=the summary's wording (the fake stands in).
async def test_summary_draft_confirm_and_on_close(client, model):
    ctx, doc = await company(client)
    await with_key(ctx)
    model.chunks = ["Decided: nothing yet.\nOpen: the thresholds.\nContext: " + "x" * 2000]
    d = await start(client, ctx, subject=section(doc))
    resp = await client.post(f"/v1/discussions/{d['id']}/summary", json={},
                             headers=ctx.as_("commenter"))  # fmt: skip
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["summary_status"] == "draft" and len(out["summary"]) <= 1200
    assert out["summary"].startswith("Decided:")
    await patch(client, ctx, d["id"], "commenter", summary="Decided: hold.",
                summary_status="confirmed")  # fmt: skip
    resp = await client.post(f"/v1/discussions/{d['id']}/summary", json={},
                             headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 409
    assert resp.json()["detail"] == (
        "The starter confirmed this summary. They can ask Oracle for a new draft."
    )
    resp = await client.post(f"/v1/discussions/{d['id']}/summary", json={"replace": True},
                             headers=ctx.as_("commenter"))  # fmt: skip
    assert resp.status_code == 200 and resp.json()["summary_status"] == "draft"

    other = await start(client, ctx, subject=section(doc, key="users"))
    await patch(client, ctx, other["id"], "approver", status="closed")
    from oracle.discussions import summary

    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(Discussion, uuid.UUID(other["id"]))).summary_status == "none"
    done = await summary.run_queued(ctx.tenant_id)
    assert done == 1
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(Discussion, uuid.UUID(other["id"]))).summary_status == "draft"
