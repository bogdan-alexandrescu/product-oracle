"""D14: an Inbox feedback row carries what its in-place actions need.

``GET /v1/inbox`` gives each item with an open Oracle suggestion its id, its text (the
approver's edit when there is one) and rationale cut to 280 characters, and whether Oracle
pushed back; every other item has nulls. The action routes themselves are tested with the
document view (test_llm_jobs, test_next_draft).
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from oracle.jobs.models import LlmSuggestion
from oracle.llm import gateway
from oracle.seed import seed
from oracle.tenancy import tenant_session
from tests.claude_account_helpers import add_account, window
from tests.test_llm_jobs import (
    FakeClaude,
    _baseline,
    comment,
    feedback,
    import_draft,
    review_answer,
    tick,
)

FIELDS = ("suggestion_id", "suggestion_text", "suggestion_pushback", "suggestion_rationale")


@pytest.fixture
def fake():
    claude = FakeClaude()
    previous = gateway.set_transports(gateway.Transports(plan=claude, api_key=claude))
    yield claude
    gateway.set_transports(previous)


@pytest.fixture
async def ctx():
    r = await seed(token_name="test")
    return {"tenant_id": r.tenant_id, "headers": {"Authorization": f"Bearer {r.token}"}}


@pytest.fixture
async def pool(ctx):
    return await add_account(ctx["tenant_id"], "personal", windows={"five_hour": window(0.2)})


async def inbox_items(client, ctx) -> dict[str, dict]:
    resp = await client.get("/v1/inbox", headers=ctx["headers"])
    assert resp.status_code == 200, resp.text
    return {i["id"]: i for i in resp.json()["items"]}


async def test_open_suggestion_fields_and_nulls_otherwise(client, ctx, pool, fake):
    await import_draft(client, ctx)
    change = await comment(client, ctx, "solution", "Make the checklist skippable.")
    staged = await comment(client, ctx, "goal-trace", "Name the activation metric.")
    # Left out of Oracle's answer: no suggestion.
    plain = await comment(client, ctx, "problem", "Which cohort is this?")
    fake.script["review_comments"].append(
        review_answer(
            [
                {
                    "feedback_id": change,
                    "classification": "change_request",
                    "suggestion": {
                        "kind": "section_text",
                        "section_key": "solution",
                        "text": "A guided checklist that teams can skip.",
                        "rationale": "The comment asks for an exit.",
                    },
                },
                {
                    "feedback_id": staged,
                    "classification": "change_request",
                    "suggestion": {
                        "kind": "section_text",
                        "section_key": "goal-trace",
                        "text": "Serves activation.",
                    },
                },
            ]
        )
    )
    await tick(client, ctx)
    fb = await feedback(client, ctx)
    sid = fb[staged]["suggestion"]["id"]
    resp = await client.post(f"/v1/suggestions/{sid}/accept", json={}, headers=ctx["headers"])
    assert resp.status_code == 200, resp.text

    items = await inbox_items(client, ctx)
    row = items[change]
    assert row["suggestion_id"] == fb[change]["suggestion"]["id"]
    assert row["suggestion_text"] == "A guided checklist that teams can skip."
    assert row["suggestion_pushback"] is False
    assert row["suggestion_rationale"] == "The comment asks for an exit."
    assert row["suggestion_kind"] == "section_text" and row["suggestion_status"] == "open"
    # Staged (its suggestion accepted) and an item without a suggestion: nothing to act on.
    assert items[staged]["state"] == "staged"
    assert fb[plain].get("suggestion") is None
    for fid in (staged, plain):
        assert {k: items[fid][k] for k in FIELDS} == dict.fromkeys(FIELDS)


async def test_text_and_rationale_cut_to_280_and_edit_wins(client, ctx, pool, fake):
    await import_draft(client, ctx)
    fid = await comment(client, ctx, "solution", "Spell the whole flow out.")
    long_text = "Teams skip the checklist when they already know the product. " * 8
    fake.script["review_comments"].append(
        review_answer(
            [
                {
                    "feedback_id": fid,
                    "classification": "change_request",
                    "suggestion": {
                        "kind": "section_text",
                        "section_key": "solution",
                        "text": long_text,
                        "rationale": "Why: " + "the study shows it. " * 20,
                    },
                }
            ]
        )
    )
    await tick(client, ctx)
    row = (await inbox_items(client, ctx))[fid]
    assert len(long_text.strip()) > 280
    assert len(row["suggestion_text"]) == 281 and row["suggestion_text"].endswith("…")
    assert row["suggestion_text"][:280] == long_text.strip()[:280]
    assert len(row["suggestion_rationale"]) == 281
    assert row["suggestion_rationale"].endswith("…")

    sid = row["suggestion_id"]
    resp = await client.patch(
        f"/v1/suggestions/{sid}",
        json={"text": "A checklist teams can skip."},
        headers=ctx["headers"],
    )
    assert resp.status_code == 200, resp.text
    row = (await inbox_items(client, ctx))[fid]
    assert row["suggestion_text"] == "A checklist teams can skip."


async def test_pushback_flag(client, ctx, pool, fake):
    await _baseline(ctx["tenant_id"])
    await import_draft(client, ctx)
    drop = await comment(client, ctx, "solution", "Remove the checklist entirely.")
    taste = await comment(client, ctx, "solution", "Call it a tour, not a checklist.")
    fake.script["review_comments"].append(
        review_answer(
            [
                {
                    "feedback_id": drop,
                    "classification": "change_request",
                    "suggestion": {"kind": "section_text", "text": "No checklist."},
                    "pushback": {
                        "reason": "The checklist is the strongest activation lever.",
                        "sources": ["goal:activation", "ev:1"],
                    },
                },
                {
                    "feedback_id": taste,
                    "classification": "change_request",
                    "suggestion": {"kind": "section_text", "text": "A guided tour."},
                },
            ]
        )
    )
    await tick(client, ctx)
    items = await inbox_items(client, ctx)
    assert items[drop]["suggestion_pushback"] is True
    assert items[taste]["suggestion_pushback"] is False
    assert items[drop]["suggestion_text"] == "No checklist."


async def test_a_staged_change_keeps_its_item_staged_under_a_newer_suggestion(
    client, ctx, pool, fake
):
    """protects=hardening 2026-10-20 (C1e Inbox states): an item listed because of its
    accepted, unapplied change takes its state from that change, not from a newer
    suggestion on the same item; fails_when=the row reads open (or done) and is counted
    so while its change still waits for the next draft; no_claim=what the newer
    suggestion offers to act on (its own fields)."""
    await import_draft(client, ctx)
    fid = await comment(client, ctx, "goal-trace", "Name the activation metric.")
    fake.script["review_comments"].append(
        review_answer(
            [
                {
                    "feedback_id": fid,
                    "classification": "change_request",
                    "suggestion": {
                        "kind": "section_text",
                        "section_key": "goal-trace",
                        "text": "Serves activation.",
                    },
                }
            ]
        )
    )
    await tick(client, ctx)
    sid = (await feedback(client, ctx))[fid]["suggestion"]["id"]
    resp = await client.post(f"/v1/suggestions/{sid}/accept", json={}, headers=ctx["headers"])
    assert resp.status_code == 200, resp.text
    resp = await client.get("/v1/inbox", headers=ctx["headers"])
    staged_count = resp.json()["counts"]["staged"]
    assert (await inbox_items(client, ctx))[fid]["state"] == "staged"
    # A later suggestion on the same item, dismissed: the accepted change still waits.
    async with tenant_session(ctx["tenant_id"]) as s:
        staged = await s.get(LlmSuggestion, uuid.UUID(sid))
        s.add(
            LlmSuggestion(
                document_id=staged.document_id,
                feedback_item_id=staged.feedback_item_id,
                version_number=staged.version_number,
                classification="question",
                kind="answer",
                text="It is activated accounts.",
                status="dismissed",
                created_at=datetime.now(UTC) + timedelta(seconds=1),
            )
        )
        await s.commit()

    resp = await client.get("/v1/inbox", headers=ctx["headers"])
    assert resp.status_code == 200, resp.text
    row = next(i for i in resp.json()["items"] if i["id"] == fid)
    assert row["state"] == "staged" and row["staged_for_version"] is not None
    assert resp.json()["counts"]["staged"] == staged_count
