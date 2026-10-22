"""G4 One staging list: what people stage from discussions joins the checkpoint's shared
draft (D8's ``checkpoint_actions``) or the document's next draft (``next_draft_changes``),
and ``GET /v1/staging`` reads everything staged for one target in one list.

Unit tests check the G1 kind <-> D8 action mapping and the list merge; the integration
tests wait a ``prd_to_roadmap`` run at Roadmap items (D8's fixtures) or stage C1e
suggestions on a document (C1e's fixtures), against Postgres. G3's Suggest and Stage
routes are not built yet: the tests call :mod:`oracle.staging.service` as G3 will.

Test cards (protects / fails_when / no_claim) head each test. Synthetic placeholders only.
"""

import uuid

import pytest
from sqlalchemy import select

from oracle.auth.deps import Principal
from oracle.discussions.models import DiscussionChange
from oracle.jobs.models import LlmJob
from oracle.runs import actions
from oracle.runs.models import Checkpoint, CheckpointAction
from oracle.staging import mapping, service
from oracle.staging.models import NextDraftChange
from oracle.tenancy import tenant_session
from tests.review_v2_helpers import person
from tests.test_checkpoint_review import Review, item_of, review  # noqa: F401 - fixtures
from tests.test_llm_jobs import SLUG, tick
from tests.test_members import token_with_role
from tests.test_next_draft import (  # noqa: F401 - fixtures
    DOC,
    batch_answer,
    ctx,
    fake,
    pool,
    staged,
    staged_setup,
)
from tests.test_roadmap import approved_prd, owner, runtime, seed_baseline  # noqa: F401

# --- unit: the mapping ---------------------------------------------------------------------


@pytest.mark.parametrize(
    ("kind", "payload", "action"),
    [
        ("item_horizon", {"item_key": "mobile-push", "horizon": "next"},
         ("mobile-push", "edit", "horizon", "next", None)),
        ("item_outcome", {"item_key": "mobile-push", "outcome": "Owners hear about spikes"},
         ("mobile-push", "edit", "outcome", "Owners hear about spikes", None)),
        ("item_dependency", {"item_key": "mobile-push", "add": ["payment-step"], "remove": []},
         ("mobile-push", "edit", "depends_on", {"add": ["payment-step"], "remove": []}, None)),
        ("item_date_remove", {"item_key": "mobile-push"},
         ("mobile-push", "edit", "milestone_date", None, None)),
        ("item_drop", {"item_key": "gift-cards", "reason": "Out of scope this year"},
         ("gift-cards", "drop", None, None, "Out of scope this year")),
        ("item_split", {"item_key": "mobile-push", "into": ["mobile-ios", "mobile-android"]},
         ("mobile-push", "split", None, {"into": ["mobile-ios", "mobile-android"]}, None)),
        ("item_merge", {"item_key": "mobile-push", "with": ["payment-step"]},
         ("mobile-push", "merge", None, {"with": ["payment-step"]}, None)),
    ],
)  # fmt: skip
def test_item_kinds_map_to_d8_actions_d8_accepts_and_back(kind, payload, action):
    """protects=a discussion change and a row action for the same edit are the same D8
    action; fails_when=a mapped action has a field or value D8 refuses, or the reverse
    mapping gives another kind or label; no_claim=D7 applying it (D7's tests)."""
    mapped = mapping.to_action(kind, payload)
    assert (mapped.item_key, mapped.kind, mapped.field, mapped.value, mapped.note) == action
    vocab = actions.ValidationContext(
        item_keys=frozenset({"mobile-push", "payment-step", "gift-cards"})
    )
    actions.validate("roadmap_items", mapped, vocab)
    back_kind, back_payload = mapping.to_change(mapped.item_key, mapped.kind, mapped.field,
                                                mapped.value)  # fmt: skip
    assert back_kind == kind
    assert mapping.label(back_kind, back_payload, mapped.item_key) == mapping.label(
        kind, payload, mapped.item_key
    )


def test_ask_person_and_scope_kinds_map_to_question_and_the_scope_vocabulary():
    """protects=questions and C7's scope words reach D8 in its shapes; fails_when=the value
    carries other keys; no_claim=C7's vocabulary validation (C7 registers it)."""
    asked = str(uuid.uuid4())
    q = mapping.to_action(
        "ask_person",
        {"asked_to": asked, "prompt": "Is push in scope?", "rationale": "Unclear",
         "category": "scope"},
        item_key="mobile-push",
    )  # fmt: skip
    assert (q.kind, q.field, q.value) == ("question", None, {"asked_to": asked,
                                                             "text": "Is push in scope?"})  # fmt: skip
    feature = str(uuid.uuid4())
    s = mapping.to_action(
        "scope_feature", {"feature_id": feature, "decision": "defer", "reason": "Later"}
    )
    assert (s.item_key, s.kind, s.field, s.value, s.note) == (
        feature, "edit", "decision", "defer", "Later"
    )  # fmt: skip
    assert mapping.CHECKPOINT_KIND["scope_feature"] == "feature_set"
    assert mapping.CHECKPOINT_KIND["item_horizon"] == "roadmap_items"


def test_priority_and_baseline_kinds_are_never_staged():
    """protects=overrides and proposals keep their own records; fails_when=a priority move
    maps to an action; no_claim=C9 applying it."""
    for kind in ("priority_move", "priority_pin", "goal_measure", "entity_edit"):
        assert mapping.target_of(kind) is None
    assert mapping.target_of("section_edit") == "next_draft"
    assert mapping.target_of("item_horizon") == "checkpoint"


def test_row_actions_without_a_g1_kind_keep_d8_kind_and_label():
    """protects=the list shows row actions D8 alone knows; fails_when=accept or waive is
    dropped or mislabelled; no_claim=D1's row copy."""
    assert mapping.to_change("gift-cards", "accept", None, None) == (None, None)
    assert mapping.label(None, None, "gift-cards", d8_kind="accept") == "Accept gift-cards"
    assert mapping.label(None, None, "gift-cards", d8_kind="waive") == "Waive gift-cards"
    assert mapping.label("item_horizon", {"item_key": "a", "horizon": "next"}, "a") == (
        "Move a to Next"
    )


def test_the_list_merge_keeps_each_row_once_in_order():
    """protects=one read shows everything staged for a target, each row once;
    fails_when=a row is missing or doubled; no_claim=how rows are read from the stores."""
    a, b, c = (service.ListRow(id=uuid.uuid4(), at=n) for n in (3, 1, 2))
    assert [r.id for r in service.merge([a, b], [b, c])] == [b.id, c.id, a.id]


# --- integration: the checkpoint's shared draft --------------------------------------------


def principal_of(review: Review, who: str, role: str) -> Principal:
    return Principal(
        tenant_id=review.tenant_id, kind="user", role=role, user_id=review.people[who].user_id
    )


async def discussion(review: Review, who: str, item: str = "mobile-push", **extra) -> str:
    resp = await review.client.post(
        "/v1/discussions",
        json={
            "subject_kind": "checkpoint_item",
            "subject": {"run_id": review.run["id"], "checkpoint_id": review.cp["id"],
                        "checkpoint_kind": "roadmap_items", "item_key": item},
            "title": "Push timing",
            **extra,
        },  # fmt: skip
        headers=review.h(who),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def change(review: Review, discussion_id: str, kind: str, payload: dict) -> uuid.UUID:
    """A typed change as G3's extraction leaves it (G3's routes are not built)."""
    async with tenant_session(review.tenant_id) as s:
        row = DiscussionChange(
            discussion_id=uuid.UUID(discussion_id),
            kind=kind,
            target={"item_key": payload.get("item_key")},
            payload=payload,
            proposed_by_kind="oracle",
        )
        s.add(row)
        await s.commit()
        return row.id


async def suggest(review: Review, who: str, role: str, change_id: uuid.UUID):
    async with tenant_session(review.tenant_id) as s:
        row = await s.get(DiscussionChange, change_id)
        return await service.suggest_discussion_change(s, principal_of(review, who, role), row)


async def stage(review: Review, who: str, role: str, change_id: uuid.UUID, reason=None):
    async with tenant_session(review.tenant_id) as s:
        row = await s.get(DiscussionChange, change_id)
        return await service.stage_discussion_change(
            s, principal_of(review, who, role), row, reason, None
        )


async def change_row(review: Review, change_id: uuid.UUID) -> DiscussionChange:
    async with tenant_session(review.tenant_id) as s:
        return await s.get(DiscussionChange, change_id)


async def action_rows(review: Review) -> list[CheckpointAction]:
    async with tenant_session(review.tenant_id) as s:
        return list(await s.scalars(select(CheckpointAction)))


async def listing(client, headers, **params) -> dict:
    resp = await client.get("/v1/staging", params=params, headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


HORIZON = {"item_key": "mobile-push", "horizon": "next"}


async def test_suggest_then_stage_writes_one_d8_action_from_the_discussion(review):  # noqa: F811
    """protects=a commenter's Suggest is a D8 suggestion and an approver's Stage turns it
    staged through D8's own service (criterion 5); fails_when=a second store, a staged
    suggestion, no revision bump or the discussion change not following; no_claim=G3's
    routes."""
    d = await discussion(review, "commenter")
    cid = await change(review, d, "item_horizon", HORIZON)
    await suggest(review, "commenter", "commenter", cid)
    [row] = await action_rows(review)
    assert (row.kind, row.field, row.value, row.state, row.origin) == (
        "edit", "horizon", "next", "suggested", "discussion"
    )  # fmt: skip
    assert row.discussion_id == uuid.UUID(d) and row.discussion_change_id == cid
    got = await review.get("viewer")
    [action] = item_of(got, "mobile-push")["actions"]
    assert action["state"] == "suggested"
    assert action["created_by"]["id"] == review.id("commenter")
    assert (await change_row(review, cid)).status == "suggested"
    revision = got["revision"]

    ref = await stage(review, "approver", "approver", cid, reason="It depends on a later item.")
    assert ref == {"kind": "checkpoint_action", "id": str(row.id)}
    [row] = await action_rows(review)
    assert row.state == "staged" and row.note == "It depends on a later item."
    assert (await review.get())["revision"] == revision + 1
    staged_change = await change_row(review, cid)
    assert staged_change.status == "staged" and staged_change.result_ref == ref


async def test_staging_the_same_slot_again_replaces_the_first_change(review):  # noqa: F811
    """protects=D8's one action per item, kind and field holds for discussions (criterion
    6); fails_when=two actions, or the first change still reads staged; no_claim=D8's
    replace for row actions (D8's tests)."""
    d = await discussion(review, "approver")
    first = await change(review, d, "item_horizon", HORIZON)
    second = await change(review, d, "item_horizon", {**HORIZON, "horizon": "later"})
    await stage(review, "approver", "approver", first)
    await stage(review, "approver", "approver", second)
    [row] = await action_rows(review)
    assert (row.value, row.discussion_change_id) == ("later", second)
    replaced = await change_row(review, first)
    assert replaced.status == "proposed"
    assert replaced.decision_note == "Replaced by a later change to the same item"
    assert (await change_row(review, second)).status == "staged"


async def test_stage_without_a_waiting_checkpoint_is_409(review):  # noqa: F811
    """protects=item kinds land only on a pending checkpoint (criterion 7); fails_when=an
    action lands on a decided checkpoint; no_claim=F1's re-plan."""
    d = await discussion(review, "approver")
    cid = await change(review, d, "item_horizon", HORIZON)
    async with tenant_session(review.tenant_id) as s:
        cp = await s.get(Checkpoint, uuid.UUID(review.cp["id"]))
        cp.status = "approved"
        await s.commit()
    with pytest.raises(service.StagingError) as err:
        await stage(review, "approver", "approver", cid)
    assert err.value.status == 409
    assert str(err.value) == "No roadmap items checkpoint is waiting in this run"


async def test_a_commenter_cannot_stage(review):  # noqa: F811
    """protects=commenters suggest, approvers stage (c6); fails_when=a commenter's Stage
    writes a staged action; no_claim=D8's own role checks."""
    d = await discussion(review, "commenter")
    cid = await change(review, d, "item_horizon", HORIZON)
    with pytest.raises(service.StagingError) as err:
        await stage(review, "commenter", "commenter", cid)
    assert err.value.status == 403
    assert await action_rows(review) == []


async def test_the_decision_marks_staged_changes_done_and_keeps_suggestions(review):  # noqa: F811
    """protects=a discussion's card shows what happened to its change (criterion 8);
    fails_when=a change stays staged after the decision, or a suggestion is marked done;
    no_claim=what send-back does with the actions (D4)."""
    d = await discussion(review, "commenter")
    staged_id = await change(review, d, "item_horizon", HORIZON)
    suggested_id = await change(review, d, "item_drop",
                                {"item_key": "gift-cards", "reason": "Out of scope"})  # fmt: skip
    await stage(review, "approver", "approver", staged_id)
    await suggest(review, "commenter", "commenter", suggested_id)
    await review.decide("approver", decision="changes_requested", note="Look again")
    done = await change_row(review, staged_id)
    assert (done.status, done.decision_note) == ("done", "Sent to the agents")
    assert (await change_row(review, suggested_id)).status == "suggested"


async def test_d8_delete_returns_the_change_to_the_discussion(review):  # noqa: F811
    """protects=a change never stays staged after its action is removed (criterion 9);
    fails_when=the change still reads staged; no_claim=D8's delete itself."""
    d = await discussion(review, "commenter")
    cid = await change(review, d, "item_horizon", HORIZON)
    await suggest(review, "commenter", "commenter", cid)
    await stage(review, "approver", "approver", cid)
    [row] = await action_rows(review)
    await review.remove("approver", str(row.id))
    assert (await change_row(review, cid)).status == "suggested"


async def test_one_read_lists_row_and_discussion_actions_and_hides_private_ones(review):  # noqa: F811
    """protects=one read shows everything staged at a checkpoint, and a private
    discussion's title only to the people in it, until its starter makes it open
    (criterion 10); fails_when=a row is missing, a non-participant reads the title, or
    from_private is rewritten; no_claim=G1's visibility rules."""
    await review.act("approver", item_key="gift-cards", kind="drop")
    d = await discussion(review, "approver", visibility="private")
    cid = await change(review, d, "item_horizon", HORIZON)
    await stage(review, "approver", "approver", cid, reason="It depends on a later item.")
    out = await listing(review.client, review.h("viewer"), checkpoint=review.cp["id"])
    assert out["target"]["kind"] == "checkpoint"
    assert out["target"]["checkpoint_kind"] == "roadmap_items"
    assert out["target"]["label"] == "Roadmap items · attempt 1"
    assert out["counts"] == {"staged": 2, "suggested": 0}
    assert out["can_stage"] is False
    by_origin = {i["origin"]: i for i in out["items"]}
    row = by_origin["row"]
    assert (row["source"], row["kind"], row["label"]) == (
        "checkpoint_action", "item_drop", "Drop gift-cards"
    )  # fmt: skip
    disc = by_origin["discussion"]
    assert (disc["kind"], disc["label"], disc["state"]) == (
        "item_horizon", "Move mobile-push to Next", "staged"
    )  # fmt: skip
    assert disc["reason"] == "It depends on a later item."
    assert disc["discussion"] == {"id": None, "title": None, "private": True}
    assert disc["from_private"] is True
    mine = await listing(review.client, review.h("approver"), checkpoint=review.cp["id"])
    assert {i["origin"]: i for i in mine["items"]}["discussion"]["discussion"] == {
        "id": d, "title": "Push timing", "private": True
    }  # fmt: skip
    assert mine["can_stage"] is True

    # The starter makes it open: every reader sees it; the row keeps how it was staged.
    resp = await review.client.get(f"/v1/discussions/{d}", headers=review.h("approver"))
    resp = await review.client.patch(
        f"/v1/discussions/{d}",
        json={"visibility": "open", "exposes": {"messages": 0, "people": 0},
              "lock_version": resp.json()["lock_version"]},
        headers=review.h("approver"),
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    out = await listing(review.client, review.h("viewer"), checkpoint=review.cp["id"])
    disc = {i["origin"]: i for i in out["items"]}["discussion"]
    assert disc["discussion"] == {"id": d, "title": "Push timing", "private": False}
    assert disc["from_private"] is True
    assert [r.from_private for r in await action_rows(review) if r.origin == "discussion"] == [
        True
    ]


# --- integration: the next draft -----------------------------------------------------------


async def section_discussion(client, tenant_id) -> tuple[str, uuid.UUID, Principal]:
    """A discussion on the problem section, an approver in it, and their section_edit."""
    approver = await person(tenant_id, "approver", "abe")
    async with tenant_session(tenant_id) as s:
        from oracle.docs.models import Document

        doc = await s.scalar(select(Document).where(Document.slug == SLUG))
    resp = await client.post(
        "/v1/discussions",
        json={"subject_kind": "section", "title": "Invite wording",
              "subject": {"document_id": str(doc.id), "version": 1, "section_key": "problem"}},
        headers=approver.headers,
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    d = resp.json()["id"]
    async with tenant_session(tenant_id) as s:
        row = DiscussionChange(
            discussion_id=uuid.UUID(d),
            kind="section_edit",
            target={"document_id": str(doc.id), "section_key": "problem"},
            payload={"section_key": "problem", "instruction": "Say most, not half."},
            proposed_by_kind="oracle",
        )
        s.add(row)
        await s.commit()
        cid = row.id
    who = Principal(tenant_id=tenant_id, kind="user", role="approver", user_id=approver.user_id)
    return d, cid, who


async def stage_section(tenant_id, who: Principal, cid: uuid.UUID) -> dict:
    async with tenant_session(tenant_id) as s:
        row = await s.get(DiscussionChange, cid)
        return await service.stage_discussion_change(s, who, row, "Matches the funnel.", None)


def answer_with_instructions(payload: dict) -> dict:
    """The fake model: C1e's answer, plus the sections only instructions touch."""
    out = batch_answer(payload)
    done = {s["section_key"] for s in out["sections"]}
    for i in payload.get("instructions") or []:
        if i["section_key"] not in done:
            done.add(i["section_key"])
            heading = next(
                s["heading"] for s in payload["sections"] if s["section_key"] == i["section_key"]
            )
            out["sections"].append(
                {"section_key": i["section_key"], "heading": heading,
                 "body_md": "Most new teams never invite a teammate.", "notes": "Reworded.",
                 "data_points": [], "resolutions": []}
            )  # fmt: skip
    return out


async def test_a_staged_section_edit_lists_builds_and_applies_with_c1e_items(
    client, ctx, pool, fake  # noqa: F811
):
    """protects=a discussion's section change joins the next draft next to C1e suggestions
    and one read shows both (criteria 2, 3); fails_when=a row is missing, doubled, left out
    of the build or the Inbox count, or left staged after apply; no_claim=how the model
    rewrites sections (the fake model stands in)."""
    ids = await staged_setup(client, ctx, fake)
    d, cid, who = await section_discussion(client, ctx["tenant_id"])
    ref = await stage_section(ctx["tenant_id"], who, cid)
    assert ref["kind"] == "next_draft_change"

    out = await listing(client, ctx["headers"], document=SLUG)
    assert out["target"]["kind"] == "document"
    sources = sorted(i["source"] for i in out["items"])
    assert sources == ["next_draft_change", "suggestion", "suggestion"]
    row = next(i for i in out["items"] if i["source"] == "next_draft_change")
    assert (row["kind"], row["origin"], row["reason"]) == (
        "section_edit", "discussion", "Matches the funnel."
    )  # fmt: skip
    assert row["discussion"] == {"id": d, "title": "Invite wording", "private": False}
    assert out["counts"] == {"staged": 3, "suggested": 0}
    listed = await staged(client, ctx)
    [nd] = listed["next_draft_changes"]
    assert nd["id"] == ref["id"] and nd["discussion"]["title"] == "Invite wording"
    inbox = (await client.get("/v1/inbox", headers=ctx["headers"])).json()
    [srow] = inbox["staged"]
    assert srow["count"] == 3

    resp = await client.post(f"{DOC}/next-draft", json={}, headers=ctx["headers"])
    assert resp.status_code == 201, resp.text
    job = resp.json()
    assert job["input"]["next_draft_change_ids"] == [ref["id"]]
    assert sorted(job["input"]["suggestion_ids"]) == sorted([ids["goal_s"], ids["sol_s"]])
    fake.script["refinement_batch"].append(answer_with_instructions)
    await tick(client, ctx)
    kind, payload = fake.calls[-1]
    assert kind == "refinement_batch"
    assert payload["instructions"] == [
        {"next_draft_change_id": ref["id"], "section_key": "problem",
         "instruction": "Say most, not half.", "reason": "Matches the funnel."}
    ]  # fmt: skip
    preview = (await client.get(f"{DOC}/next-draft/{job['id']}", headers=ctx["headers"])).json()
    problem = next(s for s in preview["sections"] if s["section_key"] == "problem")
    assert problem["instructions"][0]["origin"] == "From discussion Invite wording"

    resp = await client.post(f"{DOC}/next-draft/{job['id']}/apply", json={}, headers=ctx["headers"])
    assert resp.status_code == 201, resp.text
    async with tenant_session(ctx["tenant_id"]) as s:
        nd_row = await s.get(NextDraftChange, uuid.UUID(ref["id"]))
        assert (nd_row.status, nd_row.applied_in_version) == ("applied", 2)
        assert (await s.get(DiscussionChange, cid)).status == "done"


async def test_unticking_the_row_builds_only_the_others_and_discard_keeps_it(
    client, ctx, pool, fake  # noqa: F811
):
    """protects=the approver can untick a discussion row, and discard keeps it staged
    (criterion 3); fails_when=an unticked row is built or a discarded one leaves staging;
    no_claim=the engine choice (D12)."""
    ids = await staged_setup(client, ctx, fake)
    _, cid, who = await section_discussion(client, ctx["tenant_id"])
    ref = await stage_section(ctx["tenant_id"], who, cid)
    resp = await client.post(
        f"{DOC}/next-draft",
        json={"suggestion_ids": [ids["sol_s"]], "next_draft_change_ids": []},
        headers=ctx["headers"],
    )
    assert resp.status_code == 201, resp.text
    job = resp.json()
    assert job["input"]["next_draft_change_ids"] == []
    resp = await client.post(f"{DOC}/next-draft/{job['id']}/discard", headers=ctx["headers"])
    assert resp.status_code == 200, resp.text
    async with tenant_session(ctx["tenant_id"]) as s:
        assert (await s.get(NextDraftChange, uuid.UUID(ref["id"]))).status == "staged"
        assert (await s.get(LlmJob, uuid.UUID(job["id"]))) is not None


async def test_a_section_edit_on_a_locked_section_is_refused_at_build(
    client, ctx, pool, fake  # noqa: F811
):
    """protects=locked sections are never changed (criterion 4); fails_when=the build
    starts or the copy differs from C1e's; no_claim=locking itself."""
    from tests.test_llm_jobs import verdict

    ids = await staged_setup(client, ctx, fake)
    _, cid, who = await section_discussion(client, ctx["tenant_id"])
    ref = await stage_section(ctx["tenant_id"], who, cid)
    await verdict(client, ctx, "problem", "approved")
    resp = await client.post(
        f"{DOC}/next-draft",
        json={"suggestion_ids": [ids["sol_s"]], "next_draft_change_ids": [ref["id"]]},
        headers=ctx["headers"],
    )
    assert resp.status_code == 409
    assert resp.json()["detail"] == (
        "approved and locked, never changed: Problem (problem); untick them"
    )


async def test_unstage_is_for_approvers_and_viewers_read_the_list(
    client, ctx, pool, fake  # noqa: F811
):
    """protects=roles on the one read and the unstage route (criterion 10); fails_when=a
    commenter unstages, a viewer cannot read, or an applied row unstages; no_claim=D8's
    roles."""
    await staged_setup(client, ctx, fake)
    _, cid, who = await section_discussion(client, ctx["tenant_id"])
    ref = await stage_section(ctx["tenant_id"], who, cid)
    viewer = await token_with_role(ctx["tenant_id"], "viewer")
    assert (await client.get("/v1/staging", params={"document": SLUG}, headers=viewer)).status_code == 200  # noqa: E501
    commenter = await token_with_role(ctx["tenant_id"], "commenter")
    url = f"/v1/next-draft-changes/{ref['id']}/unstage"
    resp = await client.post(url, json={"lock_version": 1}, headers=commenter)
    assert resp.status_code == 403
    resp = await client.post(url, json={"lock_version": 1}, headers=ctx["headers"])
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "unstaged"
    async with tenant_session(ctx["tenant_id"]) as s:
        assert (await s.get(DiscussionChange, cid)).status == "proposed"
        row = await s.get(NextDraftChange, uuid.UUID(ref["id"]))
        row.status, row.applied_in_version = "applied", 2
        await s.commit()
    resp = await client.post(url, json={"lock_version": 2}, headers=ctx["headers"])
    assert resp.status_code == 409 and resp.json()["detail"] == "Already in draft 2"
    out = await listing(client, ctx["headers"], document=SLUG)
    assert [i["source"] for i in out["items"]].count("next_draft_change") == 0


def test_staging_routes_are_mcp_tools_and_closed_to_run_tokens():
    """protects=MCP clients read and unstage with their role, run tokens never;
    fails_when=a route is not a tool or a run-token scope opens it; no_claim=G5's tool."""
    from oracle.main import app
    from oracle.mcp.scopes import required_scope
    from oracle.mcp.tools import app_operations

    ops = {op.operation_id: op for op in app_operations(app)}
    for op_id in ("list_staging", "unstage_next_draft_change"):
        assert ops[op_id].excluded is None and ops[op_id].tool_name == op_id
    assert required_scope("GET", "/v1/staging") is None
    assert required_scope("POST", "/v1/next-draft-changes/x/unstage") is None
