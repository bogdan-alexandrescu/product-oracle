"""G5 Agents read discussions: one own-run MCP tool (``get_run_discussions``, over
``GET /v1/runs/{run_id}/discussions``) gives a run's agents the summaries and staged
changes people made, never the transcripts; the step prompt names the tool, or pastes the
staged changes when MCP is not attached.

Unit tests build the agent view and the prompt lines without a database; the integration
tests wait a ``prd_to_roadmap`` run at Roadmap items (D8's fixtures, as G4's tests do) and
stage discussion changes through G4's service.

Test cards (protects / fails_when / no_claim) head each test:
- Agent view: protects=c5 (summary plus changes, never transcripts) and Discuss access
  privacy; fails_when=a message body, a private title or an unshared private summary reaches
  a run token; no_claim=what agents do with it (SwarmCloud agents are not run).
- Prompt: protects=agents are told the tool exists and what to do with staged changes;
  fails_when=the line is missing or the pasted copy exceeds its cap; no_claim=the model
  obeying it.
Synthetic placeholders only.
"""

import json
import uuid
from datetime import UTC, datetime, timedelta

from oracle.discussions import agent_view
from oracle.discussions.models import Discussion, DiscussionChange
from oracle.mcp import auth as mcp_auth
from oracle.mcp.curated import CURATED
from oracle.runs import flows
from oracle.runs.models import Run
from oracle.runtokens import mint_run_token
from oracle.tenancy import tenant_session
from oracle.v2.models import KnowledgeGap, ProductIntake
from tests.test_checkpoint_review import Review, review  # noqa: F401 - fixtures
from tests.test_mcp import api_token, mcp_client, text_of
from tests.test_roadmap import approved_prd, owner, runtime, seed_baseline  # noqa: F401
from tests.test_staging import HORIZON, change, discussion, stage

SECRET = "A private remark that must never reach an agent."
REASON = "It depends on an item in Later."
DROP_REASON = "Serves no confirmed goal."


# --- unit: the agent view -----------------------------------------------------------------


def _discussion(**kw) -> Discussion:
    base = {
        "id": uuid.uuid4(),
        "subject_kind": "checkpoint_item",
        "subject": {"run_id": str(uuid.uuid4()), "checkpoint_id": str(uuid.uuid4()),
                    "checkpoint_kind": "roadmap_items", "item_key": "mobile-push"},
        "title": "Push timing",
        "visibility": "open",
        "summary": "Decided: move mobile-push to Next.",
        "summary_status": "confirmed",
        "summary_shared": True,
    }  # fmt: skip
    return Discussion(**{**base, **kw})


STAGED = [{"id": str(uuid.uuid4()), "kind": "item_drop", "label": "Drop gift-cards",
           "item_key": "gift-cards", "payload": {"item_key": "gift-cards"},
           "reason": DROP_REASON, "status": "staged",
           "target": {"kind": "checkpoint", "checkpoint_kind": "roadmap_items",
                      "attempt": 1}}]  # fmt: skip


def _entry(d: Discussion, reads: bool = False) -> dict:
    return agent_view.entry(
        d, reads=reads, subject_label="Roadmap · mobile-push", link="https://x/runs/r",
        staged=STAGED, decided=[{"kind": "answer", "label": "Answer: yes"}],
    )  # fmt: skip


def test_an_open_discussion_gives_title_summary_and_staged_changes():
    """Agent view card; criterion 2 (open)."""
    out = _entry(_discussion())
    assert out["title"] == "Push timing" and out["subject_label"] == "Roadmap · mobile-push"
    assert (out["summary"], out["summary_status"], out["summary_withheld"]) == (
        "Decided: move mobile-push to Next.", "confirmed", False
    )  # fmt: skip
    assert out["staged_changes"] == STAGED
    assert out["decided"] == [{"kind": "answer", "label": "Answer: yes"}]
    assert out["subject"] == {"kind": "checkpoint_item", "checkpoint_kind": "roadmap_items",
                              "item_key": "mobile-push"}  # fmt: skip


def test_a_private_discussion_gives_only_its_staged_changes_with_their_reason():
    """Agent view card; criterion 2 (private, summary not shared)."""
    out = _entry(_discussion(visibility="private", summary_shared=False))
    assert (out["title"], out["subject_label"]) == (None, None)
    assert (out["summary"], out["summary_status"], out["summary_withheld"]) == (None, None, True)
    assert out["staged_changes"][0]["reason"] == DROP_REASON
    assert out["visibility"] == "private"


def test_a_shared_private_summary_reaches_the_agents_without_the_title():
    """Agent view card; criterion 3 (summary_shared)."""
    out = _entry(_discussion(visibility="private", summary_shared=True))
    assert out["summary"] == "Decided: move mobile-push to Next."
    assert out["summary_withheld"] is False and out["title"] is None


def test_a_discussion_made_open_reads_as_open_whatever_summary_shared_holds():
    """Agent view card; criterion 3 (made open later)."""
    out = _entry(_discussion(visibility="open", summary_shared=False))
    assert out["title"] == "Push timing" and out["summary_withheld"] is False
    assert out["summary"] == "Decided: move mobile-push to Next."


def test_a_person_in_a_private_discussion_reads_its_title_and_summary():
    """protects=people get the same shape, a private discussion they are in shows its
    title (3.2); fails_when=a participant gets the bare row; no_claim=G1's access table."""
    out = _entry(_discussion(visibility="private", summary_shared=False), reads=True)
    assert out["title"] == "Push timing" and out["summary_withheld"] is False


def test_the_cap_keeps_50_discussions_and_counts_the_rest():
    """Agent view card; criterion 9 (the count cap)."""
    entries = [_entry(_discussion()) for _ in range(60)]
    kept, omitted = agent_view.cap(entries)
    assert (len(kept), omitted) == (50, 10)


def test_the_cap_keeps_the_response_under_40000_characters():
    """Agent view card; the character cap."""
    big = [_entry(_discussion(summary="x" * 1200)) for _ in range(40)]
    kept, omitted = agent_view.cap(big)
    assert omitted == 40 - len(kept) and omitted > 0
    assert len(json.dumps(kept)) <= agent_view.MAX_CHARS


# --- unit: the prompt ---------------------------------------------------------------------


def _ctx(**kw) -> flows.PromptContext:
    return flows.PromptContext(run_id="r1", document="usage-alerts", snapshot_as_of=None,
                               low_confidence=0.4, **kw)  # fmt: skip


PROMPT_DISCUSSIONS = [
    {"id": "d1", "visibility": "open", "title": "Push timing", "link": "https://x/runs/r1?discussion=d1",
     "summary": "Decided: move mobile-push to Next.", "summary_status": "confirmed",
     "summary_withheld": False,
     "staged_changes": [{"label": "Move mobile-push to Next", "reason": REASON}], "decided": []},
    {"id": "d2", "visibility": "private", "title": None, "link": "https://x/runs/r1?discussion=d2",
     "summary": None, "summary_status": None, "summary_withheld": True,
     "staged_changes": [{"label": "Drop gift-cards", "reason": DROP_REASON}], "decided": []},
]  # fmt: skip


def _prompt(ctx: flows.PromptContext) -> str:
    flow = flows.FLOWS["prd_to_roadmap"]
    seg = flow.segments[0]
    return flows.step_prompt(flow, seg, seg.roles[0], last=True, ctx=ctx)


def test_with_mcp_attached_the_prompt_names_the_tool_and_pastes_no_summary():
    """Prompt card; criterion 8 (MCP attached)."""
    text = _prompt(_ctx(mcp_attached=True, discussions=PROMPT_DISCUSSIONS))
    assert "People discussed this run: 2 discussions, 2 staged changes." in text
    assert "Read them with get_run_discussions before you start." in text
    assert "Decided: move mobile-push to Next." not in text
    assert "Staged changes from discussions:" not in text


def test_without_mcp_the_prompt_pastes_the_staged_changes_and_shared_summaries():
    """Prompt card; criterion 8 (MCP not attached)."""
    text = _prompt(_ctx(mcp_attached=False, discussions=PROMPT_DISCUSSIONS))
    assert "Staged changes from discussions:" in text
    link = "https://x/runs/r1?discussion=d1"
    assert f"- Move mobile-push to Next ({REASON}) [discussion {link}]" in text
    assert f"- Drop gift-cards ({DROP_REASON})" in text
    assert "Summary of Push timing: Decided: move mobile-push to Next." in text
    assert "a private discussion" not in text


def test_no_discussions_add_no_lines():
    """Prompt card; nothing is said when nobody discussed the run."""
    text = _prompt(_ctx(mcp_attached=True))
    assert "get_run_discussions:" in text  # the segment's tool list names it
    assert "People discussed this run" not in text


def test_the_pasted_copy_is_capped_at_8000_characters():
    """Prompt card; the cap."""
    many = [
        {**PROMPT_DISCUSSIONS[0], "id": f"d{i}", "summary": "s" * 1000,
         "staged_changes": [{"label": f"Move item-{i} to Next", "reason": "r" * 300}]}
        for i in range(30)
    ]  # fmt: skip
    lines = flows.discussion_lines(_ctx(mcp_attached=False, discussions=many))
    assert len("\n".join(lines)) <= flows.MAX_DISCUSSION_CHARS + 100
    assert lines[-1].endswith("more in Oracle.")


def test_every_segment_lists_the_tool():
    """Prompt card; 3.4: the tool is in every segment's tools."""
    assert "get_run_discussions" in flows.MCP_TOOLS
    for flow in flows.FLOWS.values():
        for seg in flow.segments:
            assert "get_run_discussions" in seg.tools, (flow.key, seg.name)


# --- integration ---------------------------------------------------------------------------


async def mint(rv: Review, run_id: str | None = None) -> str:
    async with tenant_session(rv.tenant_id) as s:
        raw = await mint_run_token(
            s, uuid.UUID(run_id or rv.run["id"]), ["read:baseline"], ttl_seconds=600
        )
        await s.commit()
    return raw


async def via_tool(token: str) -> dict:
    async with mcp_client(token) as c:
        out = await c.call_tool("get_run_discussions", {})
    assert not out.is_error, text_of(out)
    return json.loads(out.content[0].text)


async def post(rv: Review, who: str, d: str, body: str = SECRET) -> None:
    resp = await rv.client.post(
        f"/v1/discussions/{d}/messages", json={"body": body}, headers=rv.h(who)
    )
    assert resp.status_code == 201, resp.text


async def patch(rv: Review, who: str, d: str, **body) -> dict:
    current = await rv.client.get(f"/v1/discussions/{d}", headers=rv.h(who))
    resp = await rv.client.patch(
        f"/v1/discussions/{d}",
        json={**body, "lock_version": current.json()["lock_version"]},
        headers=rv.h(who),
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def open_and_private(rv: Review) -> tuple[str, str]:
    """An open discussion on mobile-push and a private one (approver with commenter) on
    gift-cards, each with one staged change and a message."""
    opened = await discussion(rv, "approver")
    cid = await change(rv, opened, "item_horizon", HORIZON)
    await stage(rv, "approver", "approver", cid, reason=REASON)
    await patch(rv, "approver", opened, summary="Decided: move mobile-push to Next.",
                summary_status="confirmed")  # fmt: skip
    private = await discussion(
        rv, "approver", item="gift-cards", visibility="private",
        participants=[rv.id("commenter")],
    )  # fmt: skip
    drop = await change(rv, private, "item_drop", {"item_key": "gift-cards", "reason": "x"})
    await stage(rv, "approver", "approver", drop, reason=DROP_REASON)
    await patch(rv, "approver", private, summary="Only the people in it read this.",
                summary_shared=False)  # fmt: skip
    await post(rv, "approver", opened)
    await post(rv, "approver", private)
    return opened, private


def keys_at_any_depth(value) -> set[str]:
    if isinstance(value, dict):
        return set(value) | {k for v in value.values() for k in keys_at_any_depth(v)}
    if isinstance(value, list):
        return {k for v in value for k in keys_at_any_depth(v)}
    return set()


async def test_a_run_token_lists_the_tool_and_an_api_token_does_not(review):  # noqa: F811
    """Agent view card; criterion 1. no_claim=OAuth clients (they list tools as API tokens
    do: own-run tools are offered to run tokens only)."""
    assert next(c for c in CURATED if c.name == "get_run_discussions").own_run
    async with mcp_client(await mint(review)) as c:
        tools = {t.name: t for t in (await c.list_tools()).tools}
    assert "get_run_discussions" in tools
    assert tools["get_run_discussions"].annotations.read_only_hint is True
    assert not tools["get_run_discussions"].input_schema.get("required")
    async with mcp_client(await api_token(review.tenant_id, "owner")) as c:
        names = {t.name for t in (await c.list_tools()).tools}
    assert "get_run_discussions" not in names and "list_run_discussions" in names


async def test_the_tool_gives_an_open_and_a_private_discussion_without_transcripts(review):  # noqa: F811
    """Agent view card; criteria 2 and 5."""
    opened, private = await open_and_private(review)
    out = await via_tool(await mint(review))
    assert out["run_id"] == review.run["id"]
    assert (out["truncated"], out["omitted"]) == (False, 0)
    by_id = {d["id"]: d for d in out["discussions"]}
    assert set(by_id) == {opened, private}
    o = by_id[opened]
    assert (o["visibility"], o["title"], o["summary"], o["summary_status"]) == (
        "open", "Push timing", "Decided: move mobile-push to Next.", "confirmed"
    )  # fmt: skip
    [moved] = o["staged_changes"]
    assert (moved["kind"], moved["label"], moved["reason"], moved["status"]) == (
        "item_horizon", "Move mobile-push to Next", REASON, "staged"
    )  # fmt: skip
    assert moved["target"] == {"kind": "checkpoint", "checkpoint_kind": "roadmap_items",
                               "attempt": 1}  # fmt: skip
    assert o["link"].endswith(f"/runs/{review.run['id']}?discussion={opened}")
    p = by_id[private]
    assert (p["visibility"], p["title"], p["summary"], p["summary_status"]) == (
        "private", None, None, None
    )  # fmt: skip
    assert p["summary_withheld"] is True
    [dropped] = p["staged_changes"]
    assert (dropped["label"], dropped["reason"]) == ("Drop gift-cards", DROP_REASON)
    assert p["subject"]["item_key"] == "gift-cards"
    # Criterion 5: never a transcript, a person or a private summary.
    raw = json.dumps(out)
    assert keys_at_any_depth(out).isdisjoint({"messages", "body", "participants"})
    assert SECRET not in raw and "Only the people in it read this." not in raw


async def test_a_shared_summary_then_making_it_open(review):  # noqa: F811
    """Agent view card; criterion 3."""
    _opened, private = await open_and_private(review)
    token = await mint(review)
    await patch(review, "approver", private, summary_shared=True)
    p = next(d for d in (await via_tool(token))["discussions"] if d["id"] == private)
    assert (p["title"], p["summary"], p["summary_withheld"]) == (
        None, "Only the people in it read this.", False
    )  # fmt: skip
    await patch(review, "approver", private, summary_shared=False)
    await patch(review, "approver", private, visibility="open",
                exposes={"messages": 1, "people": 1})  # fmt: skip
    p = next(d for d in (await via_tool(token))["discussions"] if d["id"] == private)
    assert (p["visibility"], p["title"], p["summary"], p["summary_withheld"]) == (
        "open", "Push timing", "Only the people in it read this.", False
    )  # fmt: skip
    assert len(p["staged_changes"]) == 1


async def test_the_run_creators_participation_is_never_used(review):  # noqa: F811
    """Agent view card; criterion 4 (S6 follow-up 3)."""
    async with tenant_session(review.tenant_id) as s:
        run = await s.get(Run, uuid.UUID(review.run["id"]))
        run.created_by = review.people["approver"].user_id
        await s.commit()
    _opened, private = await open_and_private(review)
    p = next(d for d in (await via_tool(await mint(review)))["discussions"] if d["id"] == private)
    assert p["title"] is None and p["summary_withheld"] is True
    # The approver, a person in it, reads its title through the route.
    resp = await review.client.get(
        f"/v1/runs/{review.run['id']}/discussions", headers=review.h("approver")
    )
    mine = next(d for d in resp.json()["discussions"] if d["id"] == private)
    assert mine["title"] == "Push timing"
    # A viewer, not in it, gets the bare row.
    resp = await review.client.get(
        f"/v1/runs/{review.run['id']}/discussions", headers=review.h("viewer")
    )
    assert resp.status_code == 200
    assert next(d for d in resp.json()["discussions"] if d["id"] == private)["title"] is None


async def test_an_authors_own_private_finding_is_left_out_and_not_counted(review):  # noqa: F811
    """Agent view card; criterion 6, and intake discussions reach the run (3.1.2)."""
    gap_id = uuid.uuid4()
    author = review.people["commenter"].user_id
    async with tenant_session(review.tenant_id) as s:
        intake = ProductIntake(
            title="Saved addresses", brief="Returning buyers retype their address.",
            author_id=author,
            analysis={"findings": {str(gap_id): {
                "kind": "gap", "origin": "model", "category": "pain_evidence",
                "source_item_ids": [], "summary": "A gap from the author's sources",
                "sharing": "private", "gap_id": str(gap_id)}}},
        )  # fmt: skip
        s.add(intake)
        await s.flush()
        s.add(KnowledgeGap(id=gap_id, intake_id=intake.id, category="pain_evidence",
                           statement="Is the rollout limited to some regions?", impact=[],
                           importance="high", knowledge_state="unknown",
                           status="unknown"))  # fmt: skip
        run = await s.get(Run, uuid.UUID(review.run["id"]))
        run.knobs = {**run.knobs, "intake_id": str(intake.id)}
        await s.commit()
        intake_id = str(intake.id)
    hidden = await review.client.post(
        "/v1/discussions",
        json={"subject_kind": "gap", "subject": {"gap_id": str(gap_id)}, "title": "My finding"},
        headers=review.h("commenter"),
    )
    assert hidden.status_code == 201, hidden.text
    assert hidden.json()["author_only"] is True
    on_intake = await review.client.post(
        "/v1/discussions",
        json={"subject_kind": "intake", "subject": {"intake_id": intake_id},
              "title": "Brief scope"},
        headers=review.h("commenter"),
    )  # fmt: skip
    assert on_intake.status_code == 201, on_intake.text
    out = await via_tool(await mint(review))
    assert [d["id"] for d in out["discussions"]] == [on_intake.json()["id"]]
    assert (out["truncated"], out["omitted"]) == (False, 0)
    assert "My finding" not in json.dumps(out)


async def test_another_runs_token_gets_404_and_generic_tools_stay_closed(review):  # noqa: F811
    """Agent view card; criterion 7."""
    await open_and_private(review)
    async with tenant_session(review.tenant_id) as s:
        other = Run(flow="baseline_to_prd", created_by=review.people["approver"].user_id)
        s.add(other)
        await s.commit()
        other_id = str(other.id)
    caller = await mcp_auth.verify(await mint(review, other_id))
    assert caller is not None
    resp = await review.client.get(
        f"/v1/runs/{review.run['id']}/discussions", headers=dict(caller.credentials)
    )
    assert resp.status_code == 404, resp.text
    own = await review.client.get(
        f"/v1/runs/{other_id}/discussions", headers=dict(caller.credentials)
    )
    assert own.status_code == 200 and own.json()["discussions"] == []
    async with mcp_client(await mint(review)) as c:
        names = {t.name for t in (await c.list_tools()).tools}
        assert "list_discussions" not in names and "list_run_discussions" not in names
        refused = await c.call_tool("list_discussions", {})
    assert refused.is_error


async def test_the_prompt_context_carries_the_agent_view(review):  # noqa: F811
    """Prompt card; criterion 8 through the run's own data."""
    await open_and_private(review)
    async with tenant_session(review.tenant_id) as s:
        run = await s.get(Run, uuid.UUID(review.run["id"]))
        listed = await agent_view.for_prompt(s, run)
    text = "\n".join(flows.discussion_lines(_ctx(mcp_attached=False, discussions=listed)))
    assert f"- Move mobile-push to Next ({REASON})" in text
    assert f"- Drop gift-cards ({DROP_REASON})" in text
    assert "Only the people in it read this." not in text and SECRET not in text


async def test_60_discussions_give_50_newest_first(review):  # noqa: F811
    """Agent view card; criterion 9."""
    run_id = uuid.UUID(review.run["id"])
    cp_id = review.cp["id"]
    start = datetime(2026, 10, 1, tzinfo=UTC)
    async with tenant_session(review.tenant_id) as s:
        for i in range(60):
            s.add(Discussion(
                subject_kind="checkpoint_item",
                subject={"run_id": str(run_id), "checkpoint_id": cp_id,
                         "checkpoint_kind": "roadmap_items", "item_key": f"item-{i}"},
                subject_key=f"run_item:{run_id}:roadmap_items:item-{i}",
                run_id=run_id, title=f"Item {i}", started_by=review.people["approver"].user_id,
                last_message_at=start + timedelta(minutes=i),
            ))  # fmt: skip
        await s.commit()
    out = await via_tool(await mint(review))
    assert (len(out["discussions"]), out["truncated"], out["omitted"]) == (50, True, 10)
    assert out["discussions"][0]["title"] == "Item 59"
    assert out["discussions"][-1]["title"] == "Item 10"


async def test_decided_changes_show_as_label_and_kind(review):  # noqa: F811
    """Agent view card: changes already done read as ``decided``, label and kind only."""
    d = await discussion(review, "approver")
    async with tenant_session(review.tenant_id) as s:
        s.add(DiscussionChange(
            discussion_id=uuid.UUID(d), kind="answer", target={},
            payload={"question_id": str(uuid.uuid4()), "body": "Yes, from plan thresholds"},
            proposed_by_kind="oracle", status="done",
        ))  # fmt: skip
        await s.commit()
    [row] = (await via_tool(await mint(review)))["discussions"]
    assert row["decided"] == [{"kind": "answer", "label": "Answer: Yes, from plan thresholds"}]
    assert row["staged_changes"] == []
