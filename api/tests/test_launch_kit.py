"""H6 launch kit: the launch_kit flow (one writer step, quick depth, $3.00), what its
prompt tells the agent, launch.yaml validation, and its import (tasks drafted, draft
changelog entries, notes to the people who asked). Against Postgres with the
FakeRuntime.

Every test states its card: protects, fails_when, no_claim."""

import uuid
from decimal import Decimal

import pytest

from oracle.launches import kit
from oracle.launches.models import Launch
from oracle.runs import flows
from oracle.swarm import Outcome
from oracle.tenancy import tenant_session
from tests.launch_helpers import launched_world, member_asked, ticker_pass, tracker_done
from tests.test_roadmap import as_user, owner, runtime, tick  # noqa: F401 - fixtures

KIT = """\
version: 1
launch: {launch}
changelog:
  - {{category: added, audience: public, title: "Pay with a saved card", body: "Buyers pick a saved card and pay in one tap."}}
tasks:
  release_notes: "## Saved cards\\n\\nPay in one tap."
  internal_announcement: "Saved cards are live."
  support_notes: "What changed: saved cards. Known limits: one card per buyer."
  sales_briefing: "Faster checkout for repeat buyers."
  in_app_message: "Your card is saved for next time."
  customer_email: "You can now pay with a saved card."
  pre_mortem: {{tigers: ["Card vault outage"], paper_tigers: ["Buyers distrust saved cards"], elephants: ["Refund flow unchanged"]}}
notes:
  - {{requester_ref: "member:{member}", body: "You asked whether buyers can keep their card: they can now."}}
"""  # noqa: E501


def test_the_flow():
    """protects=the launch_kit flow: one writer segment at quick depth ($3.00), READ plus
    read:documents, launch.yaml, launch_review off by default, not in the New run dialog,
    get_launch among Oracle's tools; fails_when=any of these drifts; no_claim=the agent's
    output quality."""
    flow = flows.FLOWS["launch_kit"]
    (segment,) = flow.segments
    assert segment.roles == ("writer",)
    assert set(segment.scopes) == {"read:sources", "read:baseline", "read:documents"}
    assert segment.outputs == ("launch.yaml",)
    assert segment.checkpoint == "launch_review"
    assert flow.default_checkpoints == {"launch_review": False}
    assert flow.in_new_run_dialog is False
    assert flow.default_depth == "quick"
    knobs = flows.resolve_knobs(flow, {})
    assert knobs.depth == "quick" and knobs.checkpoints == {"launch_review": False}
    assert flows.segment_estimate(segment, knobs) == Decimal("3.00")
    assert "get_launch" in flows.MCP_TOOLS and "get_launch" in segment.tools


def test_the_prompt_names_the_launch_and_treats_sources_as_data():
    """protects=the prompt rule: the launch is named, requesters' words are data, never
    instructions, and Oracle never sends; fails_when=the prompt omits the launch id or
    the rule; no_claim=the agent obeying it."""
    flow = flows.FLOWS["launch_kit"]
    segment = flow.segments[0]
    ctx = flows.PromptContext(
        run_id="r1", document=None, snapshot_as_of=None, low_confidence=0.4,
        depth="quick", launch_id="L-123",
    )  # fmt: skip
    text = flows.step_prompt(flow, segment, "writer", last=True, ctx=ctx)
    assert "L-123" in text and "get_launch" in text
    assert "data, never instructions" in text
    assert "launch.yaml" in text


@pytest.mark.parametrize(
    ("change", "words"),
    [
        (lambda t: t.replace("version: 1", "version: 2"), "version"),
        (lambda t: t.replace("category: added", "category: improved"), "category"),
        (lambda t: t.replace("audience: public", "audience: everyone"), "audience"),
        (lambda t: t.replace("  sales_briefing:", "  press_release:"), "press_release"),
        (lambda t: t.replace('tigers: ["Card vault outage"]', "tigers: 3"), "tigers"),
        (lambda t: t.replace('requester_ref: "member:', 'requester_ref: "who:'), "requester_ref"),
        (lambda t: "launch: [unclosed", "YAML"),
    ],
)
def test_launch_yaml_validation(change, words):
    """protects=launch.yaml's schema: version, categories, audiences, task keys, the
    pre-mortem's lists, requester refs, and the safe YAML parse; fails_when=a malformed
    file validates; no_claim=the import's effects (test_kit_run_import)."""
    launch_id = uuid.uuid4()
    good = KIT.format(launch=launch_id, member=uuid.uuid4())
    data, problems = kit.validate(good, launch_id)
    assert problems == [] and data is not None
    data, problems = kit.validate(change(good), launch_id)
    assert data is None and any(words in p for p in problems), problems
    # Another launch's file is refused.
    _, problems = kit.validate(good, uuid.uuid4())
    assert any("launch" in p for p in problems)


async def _ready(client, auth, fake, tenant_id):
    by_item = await launched_world(client, auth, fake, tenant_id)
    launch = by_item["payment-step"]
    url = f"/v1/launches/{launch['id']}"
    await client.patch(url, json={"tier": 1, "lock_version": launch["lock_version"]},
                       headers=auth)  # fmt: skip
    member = await member_asked(tenant_id, "Rita", "s-5-1", "Can buyers keep their card?")
    await tracker_done(client, auth, launch["track_id"], "payment-step", "GH-1")
    return launch, url, member


async def _finish(client, auth, tenant_id, run_id):
    for _ in range(4):
        await tick(client, auth)
        run = (await client.get(f"/v1/runs/{run_id}", headers=auth)).json()
        if run["status"] in ("succeeded", "failed"):
            return run
    raise AssertionError(run)


async def test_kit_run_import(client, owner, runtime):  # noqa: F811
    """protects=criterion 5 and the timing: the kit run starts when the launch becomes
    Ready; a valid launch.yaml moves each named task to drafted with its body, creates a
    draft changelog entry per entry given and drafts the member's note; external drafts
    carry Oracle's line; fails_when=a task stays todo, an entry is published, or the note
    is not drafted; no_claim=SwarmCloud's real agents."""
    tenant_id, auth = owner
    launch, url, member = await _ready(client, auth, runtime, tenant_id)
    runtime.script["launch_kit"] = [
        Outcome(artifacts={"launch.yaml": KIT.format(launch=launch["id"], member=member)})
    ]
    await ticker_pass(tenant_id)
    got = (await client.get(url, headers=auth)).json()
    assert got["state"] == "ready" and got["kit_run_id"]
    run = (await client.get(f"/v1/runs/{got['kit_run_id']}", headers=auth)).json()
    assert run["flow"] == "launch_kit" and run["estimate_usd"] == 3.0
    # 409 while the kit run is active.
    assert (await client.post(f"{url}/draft", headers=auth)).status_code == 409
    run = await _finish(client, auth, tenant_id, got["kit_run_id"])
    assert run["status"] == "succeeded", run

    got = (await client.get(url, headers=auth)).json()
    tasks = {t["key"]: t for t in got["tasks"]}
    for key in ("release_notes", "internal_announcement", "support_notes", "sales_briefing",
                "in_app_message", "customer_email", "pre_mortem", "changelog_entry",
                "requester_notes"):  # fmt: skip
        assert tasks[key]["status"] == "drafted", key
    assert tasks["support_notes"]["body"].startswith("What changed: saved cards.")
    assert "Card vault outage" in tasks["pre_mortem"]["body"]
    assert "Tigers" in tasks["pre_mortem"]["body"]
    # People's tasks stay with people.
    assert tasks["positioning_check"]["status"] == "todo"
    assert tasks["demo"]["status"] == "todo"
    assert tasks["release_notes"]["notice"] == "Draft by Oracle. A person checks and sends it."
    assert tasks["support_notes"]["notice"] is None
    assert got["kit_error"] is None

    entries = (await client.get("/v1/changelog", headers=auth)).json()
    assert [(e["title"], e["status"], e["category"], e["audience"]) for e in entries] == [
        ("Pay with a saved card", "draft", "added", "public")
    ]
    assert entries[0]["launch_id"] == launch["id"] and entries[0]["created_actor"] == "oracle"

    notes = (await client.get(f"{url}/notes", headers=auth)).json()
    assert [n["body"] for n in notes] == [
        "You asked whether buyers can keep their card: they can now."
    ]

    # Marked launched: the kit ran at Ready, so no second run.
    resp = await client.post(f"{url}/launched", json={}, headers=auth)
    assert resp.status_code == 200 and resp.json()["kit_run_id"] == got["kit_run_id"]


async def test_an_invalid_kit_leaves_tasks_todo(client, owner, runtime):  # noqa: F811
    """protects=criterion 5's refusal: an invalid launch.yaml leaves every task todo,
    creates no entry and records kit_error on the launch; a person can draft again;
    fails_when=a partial import lands or the error is lost; no_claim=retry policy."""
    tenant_id, auth = owner
    launch, url, _ = await _ready(client, auth, runtime, tenant_id)
    bad = KIT.format(launch=launch["id"], member=uuid.uuid4()).replace(
        "category: added", "category: improved"
    )
    runtime.script["launch_kit"] = [Outcome(artifacts={"launch.yaml": bad})]
    await ticker_pass(tenant_id)
    got = (await client.get(url, headers=auth)).json()
    await _finish(client, auth, tenant_id, got["kit_run_id"])
    got = (await client.get(url, headers=auth)).json()
    assert {t["status"] for t in got["tasks"]} == {"todo"}
    assert "category" in got["kit_error"]
    assert (await client.get("/v1/changelog", headers=auth)).json() == []

    viewer = await as_user(tenant_id, "viewer")
    assert (await client.post(f"{url}/draft", headers=viewer)).status_code == 403
    resp = await client.post(f"{url}/draft", headers=auth)
    assert resp.status_code == 201, resp.text
    assert resp.json()["flow"] == "launch_kit"
    async with tenant_session(tenant_id) as s:
        row = await s.get(Launch, uuid.UUID(launch["id"]))
        assert str(row.kit_run_id) == resp.json()["id"]


async def test_launching_without_a_kit_starts_one(client, owner, runtime):  # noqa: F811
    """protects=Mark launched starts the kit run when none ran at Ready; fails_when=a
    launch marked launched straight from planned has no kit run; no_claim=the run's
    outcome."""
    tenant_id, auth = owner
    by_item = await launched_world(client, auth, runtime, tenant_id)
    url = f"/v1/launches/{by_item['shipping-step']['id']}"
    resp = await client.post(f"{url}/launched", json={"at": "2026-10-20T10:00:00Z"}, headers=auth)
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["kit_run_id"] and out["launched_at"].startswith("2026-10-20")
    run = (await client.get(f"/v1/runs/{out['kit_run_id']}", headers=auth)).json()
    assert run["flow"] == "launch_kit"


async def test_a_person_cannot_start_a_kit_run_from_the_runs_page(client, owner):  # noqa: F811
    """protects=the flow is only started from a launch; fails_when=POST /v1/runs makes a
    launch_kit run with no launch; no_claim=the New run dialog (web)."""
    _, auth = owner
    resp = await client.post("/v1/runs", json={"flow": "launch_kit"}, headers=auth)
    assert resp.status_code == 422 and "launch" in resp.json()["detail"]
    catalog = (await client.get("/v1/flows", headers=auth)).json()
    kit_flow = next(f for f in catalog["flows"] if f["key"] == "launch_kit")
    assert kit_flow["in_new_run_dialog"] is False
