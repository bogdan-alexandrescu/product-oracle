"""Roadmap from an approved PRD (O4b): the prd_to_roadmap flow, roadmap_items.yaml,
the roadmap draft's import with provenance and PRD links, exports, the feedback loop
on a roadmap, roles, and MCP. Against Postgres with the FakeRuntime."""

import uuid
from datetime import date

import pytest
from sqlalchemy import select

from oracle.auth.service import create_user, make_session_cookie
from oracle.baseline.models import Edge, Entity
from oracle.config import get_settings
from oracle.docs.models import Document, DocumentVersion
from oracle.export import render
from oracle.review.models import FeedbackItem
from oracle.runs import flows
from oracle.runs.roadmap import check_items, doc_links
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from oracle.tenancy import tenant_session
from tests.fixtures import draft, import_draft, seed_auth

PRD = "checkout-redesign"
ROADMAP = "checkout-redesign-roadmap"
PRD_TITLE = "Checkout redesign PRD"

ITEMS = """\
version: 1
prd: {document: checkout-redesign, version: 1}
items:
  - id: payment-step
    title: Payment step
    outcome: Buyers pay without re-entering their card
    horizon: now
    milestone: {name: Beta, date: 2026-11-30, date_source: ENG-412 estimate}
    depends_on: []
    priority: {score: 4.2, rank: 1, explanation: "activation weight 3 x contribution 2"}
    confidence: high
    prd_section: s-5-1
  - id: shipping-step
    title: Shipping step
    outcome: Fewer buyers drop off at shipping
    horizon: next
    milestone: Shipping estimate up front
    depends_on: [payment-step]
    priority: {score: 3.1, rank: 2, explanation: "activation weight 3 x contribution 1"}
    confidence: medium
    prd_section: s-5-2
"""

ROADMAP_MD = """\
---
document: checkout-redesign-roadmap
title: Checkout roadmap
kind: roadmap
prd: {document: checkout-redesign, version: 1}
template: now-next-later
template_version: "1"
theme: roadmap-board
brief: [summary, brief-items]
citations:
  - id: c1
    source: github
    ref: https://github.com/example-org/storefront/issues/412
    title: ENG-412 estimate
---

# Checkout roadmap {#roadmap}

## Summary {#summary}

Make checkout predictable: payment first, then shipping.

## Items by horizon {#brief-items}

| Horizon | Item | Outcome |
|---|---|---|
| [Now](#now) | [Payment step](#now-payment-step) | Buyers pay without re-entering their card |
| [Next](#next) | [Shipping step](#next-shipping-step) | Fewer buyers drop off at shipping |

# Full version {#full}

## Now {#now}

### Payment step {#now-payment-step}

Beta by 2026-11-30. From the PRD: [Payment step](/documents/checkout-redesign/v/1#s-5-1).

## Next {#next}

### Shipping step {#next-shipping-step}

After the payment step. From the PRD: [Shipping step](/documents/checkout-redesign/v/1#s-5-2)
and [an old section](/documents/checkout-redesign/v/1#gone).

## Later {#later}

## Sources and data points {#sources}

- Beta date: ENG-412 estimate [c:c1]
"""


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


async def verified_estimate(client, auth, reference: str = "ENG-412") -> None:
    """CR-11, O4: a date needs a verified basis recorded for its PRD. ITEMS' Beta date
    rests on ENG-412."""
    resp = await client.post(
        "/v1/schedule-bases",
        json={"kind": "estimate", "reference": reference, "supports_date": "2026-11-30",
              "prd": PRD},
        headers=auth,
    )  # fmt: skip
    assert resp.status_code == 201, resp.text


@pytest.fixture
async def owner():
    tenant_id, auth = await seed_auth()
    return tenant_id, auth


async def as_user(tenant_id: uuid.UUID, role: str) -> dict[str, str]:
    async with tenant_session(tenant_id) as s:
        user = await create_user(s, f"{role}-{uuid.uuid4().hex[:6]}@example.com", "pw")
        user.role = role
        await s.commit()
    return {"Cookie": f"{get_settings().session_cookie_name}={make_session_cookie(user)}"}


async def approved_prd(client, auth, approve: bool = True) -> None:
    """The PRD, with the ENG-412 estimate recorded for it, approved unless not."""
    assert (await import_draft(client, auth, draft("prd_v1.md"))).status_code == 201
    await verified_estimate(client, auth)
    if approve:
        resp = await client.post(f"/v1/documents/{PRD}/versions/1/approve", headers=auth)
        assert resp.status_code == 200, resp.text


async def seed_baseline(tenant_id: uuid.UUID) -> None:
    """A confirmed goal, two features serving it, shipping depends on payment."""
    async with tenant_session(tenant_id) as s:
        goal = Entity(
            type="goal",
            key="activation",
            title="Raise activation",
            status="confirmed",
            origin="user",
            attrs={"metric": "activated accounts", "target": "40%", "horizon": "short"},
        )
        pay = Entity(
            type="feature",
            key="payment-step",
            title="Payment step",
            status="confirmed",
            origin="user",
            attrs={"effort": 2, "confidence": 0.8},
        )
        ship = Entity(
            type="feature",
            key="shipping-step",
            title="Shipping step",
            status="confirmed",
            origin="user",
            attrs={"effort": 3, "confidence": 0.6},
        )
        s.add_all([goal, pay, ship])
        await s.flush()
        s.add_all(
            [
                Edge(
                    src_id=pay.id,
                    dst_id=goal.id,
                    type="supports",
                    status="confirmed",
                    origin="user",
                    attrs={"contribution": 2},
                ),
                Edge(
                    src_id=ship.id,
                    dst_id=goal.id,
                    type="supports",
                    status="confirmed",
                    origin="user",
                    attrs={"contribution": 1},
                ),
                Edge(
                    src_id=ship.id,
                    dst_id=pay.id,
                    type="depends_on",
                    status="confirmed",
                    origin="user",
                ),
            ]
        )
        await s.commit()


async def create(client, headers, status=201, **body):
    resp = await client.post("/v1/runs", json={"flow": "prd_to_roadmap", **body}, headers=headers)
    assert resp.status_code == status, resp.text
    return resp.json()


async def start(client, headers, run):
    est = await client.post(f"/v1/runs/{run['id']}/estimate", headers=headers)
    assert est.status_code == 200, est.text
    resp = await client.post(f"/v1/runs/{run['id']}/start", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def tick(client, headers):
    resp = await client.post("/v1/internal/tick", headers=headers)
    assert resp.status_code == 200 and resp.json()["errors"] == [], resp.text


async def get(client, headers, run_id):
    resp = await client.get(f"/v1/runs/{run_id}", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


def pending(run):
    return next(c for c in run["checkpoints"] if c["status"] == "pending")


async def decide(client, headers, run, decision="approved", note=None):
    resp = await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{pending(run)['id']}/decide",
        json={"decision": decision, "note": note},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def built_roadmap(client, auth, runtime) -> dict:
    """A finished prd_to_roadmap run with every checkpoint off."""
    runtime.script["roadmap_items"] = [Outcome(artifacts={"roadmap_items.yaml": ITEMS})]
    runtime.script["roadmap_draft"] = [Outcome(artifacts={"roadmap.md": ROADMAP_MD})]
    off = {"roadmap_items": False, "roadmap_review": False}
    run = await start(
        client, auth, await create(client, auth, source=PRD, knobs={"checkpoints": off})
    )
    await tick(client, auth)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "succeeded", run
    return run


# --------------------------------------------------------------------------- flow


async def test_flow_in_the_catalog(client, owner, runtime):
    _, auth = owner
    body = (await client.get("/v1/flows", headers=auth)).json()
    flow = next(f for f in body["flows"] if f["key"] == "prd_to_roadmap")
    assert flow["target_kind"] == "roadmap" and flow["source_kind"] == "prd"
    assert flow["requires_document"] is False
    assert [(s["name"], s["roles"], s["checkpoint"], s["outputs"]) for s in flow["segments"]] == [
        ("roadmap_items", ["analyst", "prioritizer"], "roadmap_items", ["roadmap_items.yaml"]),
        ("roadmap_draft", ["writer", "critic"], "roadmap_review", ["roadmap.md"]),
    ]
    # Both segments are read-only: Oracle imports roadmap.md itself, with provenance.
    assert all("write:drafts" not in s["scopes"] for s in flow["segments"])
    assert all("push_draft" not in s.tools for s in flows.FLOWS["prd_to_roadmap"].segments)
    loop = next(f for f in body["flows"] if f["key"] == "feedback_loop")
    assert loop["target_kind"] is None


def test_knobs_and_estimate():
    flow = flows.FLOWS["prd_to_roadmap"]
    knobs = flows.resolve_knobs(flow, {})
    assert knobs.roles == {
        "roadmap_items": ["analyst", "prioritizer"],
        "roadmap_draft": ["writer", "critic"],
    }
    assert knobs.checkpoints == {"roadmap_items": True, "roadmap_review": True}
    total = sum(flows.segment_estimate(s, knobs) for s in flow.segments)
    assert str(total) == "14.50"
    deep = flows.resolve_knobs(flow, {"depth": "deep", "roles": {"roadmap_items": ["analyst"]}})
    assert str(sum(flows.segment_estimate(s, deep) for s in flow.segments)) == "24.00"
    for bad in (
        {"roles": {"roadmap_items": ["ghost"]}},
        {"roles": {"prd_draft": ["writer"]}},
        {"checkpoints": {"prd_review": False}},
    ):
        with pytest.raises(flows.KnobError):
            flows.resolve_knobs(flow, bad)


def test_segment_prompts_carry_the_prd_version_priorities_and_edges():
    flow = flows.FLOWS["prd_to_roadmap"]
    knobs = flows.resolve_knobs(flow, {})
    source = flows.SourceContext(
        slug=PRD,
        title=PRD_TITLE,
        version=3,
        markdown="# Checkout redesign PRD {#title}\n\n## Payment step {#s-5-1}\n",
        sections=[("title", "Checkout redesign PRD"), ("s-5-1", "Payment step")],
        priorities=[
            {
                "rank": 1,
                "key": "payment-step",
                "title": "Payment step",
                "score": 4.2,
                "flags": [],
                "depends_on": [],
                "explanation": "weight 3 x contribution 2",
            },
            {
                "rank": 2,
                "key": "shipping-step",
                "title": "Shipping step",
                "score": None,
                "flags": ["missing_inputs"],
                "depends_on": ["payment-step"],
                "explanation": "",
            },
        ],
        edges=[
            {"src": "feature:shipping-step", "type": "depends_on", "dst": "feature:payment-step"}
        ],
        goals=[{"key": "activation", "title": "Raise activation", "horizon": "short"}],
    )
    rm = flows.DraftContext(
        kind="roadmap",
        slug=ROADMAP,
        template="now-next-later",
        template_version=1,
        theme="roadmap-board",
        skeleton="---\nkind: roadmap\n---\n# Roadmap {#roadmap}\n",
    )
    ctx = flows.PromptContext(
        run_id="r1",
        document=ROADMAP,
        snapshot_as_of=None,
        low_confidence=0.4,
        kind="roadmap",
        source=source,
    )
    items = flows.build_steps(flow, flow.segment("roadmap_items"), knobs, ctx)
    prompt = items[-1][2]
    assert "roadmap document 'checkout-redesign-roadmap'" in prompt
    assert f"approved PRD '{PRD_TITLE}' ({PRD}), version 3" in prompt
    assert "s-5-1 (Payment step)" in prompt
    assert "1. payment-step (Payment step), score 4.2." in prompt
    assert (
        "2. shipping-step (Shipping step), unscored [missing_inputs]; depends on payment-step"
        in prompt
    )
    assert "- feature:shipping-step depends_on feature:payment-step" in prompt
    assert "now = short term, the current quarter" in prompt
    assert "- activation: Raise activation (horizon short)" in prompt
    assert "roadmap_items.yaml" in prompt and "get_priorities" in prompt
    assert "--- PRD checkout-redesign v3 ---" in prompt
    draft_ctx = flows.PromptContext(**{**ctx.__dict__, "draft": rm})
    steps = flows.build_steps(flow, flow.segment("roadmap_draft"), knobs, draft_ctx)
    prompt = steps[-1][2]
    assert "Write these files as artifacts: roadmap.md." in prompt
    assert "template now-next-later version 1, theme roadmap-board" in prompt
    assert "/documents/checkout-redesign/v/3#<section id>" in prompt
    assert "--- template skeleton ---" in prompt and "kind: roadmap" in prompt
    assert "Sources and data points" in prompt


@pytest.mark.parametrize(
    "h, lines",
    [
        ((1, 2, 12, 24), flows.HORIZONS),
        (
            (1, 1, 6, 12),
            (
                ("now", "short", "the current quarter"),
                ("next", "medium", "the next quarter"),
                ("later", "long", "6 to 12 months"),
            ),
        ),
        (
            (2, 1, 9, 12),
            (
                ("now", "short", "the current and next quarter"),
                ("next", "medium", "the next quarter"),
                ("later", "long", "9 to 12 months"),
            ),
        ),
        (
            (2, 4, 18, 60),
            (
                ("now", "short", "the current and next quarter"),
                ("next", "medium", "the next 4 quarters"),
                ("later", "long", "18 to 60 months"),
            ),
        ),
    ],
)
def test_horizon_lines(h, lines):
    # protects=the prompt's wording per horizon value; fails_when=a span reads wrong or the
    # defaults' text drifts from HORIZONS; no_claim=agents use it.
    keys = ("short_quarters", "medium_quarters", "long_from_months", "long_to_months")
    assert flows.horizon_lines(dict(zip(keys, h, strict=True))) == lines


@pytest.mark.parametrize("short", [1, 2])
@pytest.mark.parametrize("medium", [1, 2, 3, 4])
def test_next_reads_the_next_quarters_whatever_now_covers(short, medium):
    # protects=acceptance criterion 9 (owner, 2026-10-21): Next reads "the next N quarters"
    # ("the next quarter" for 1) whether Now is one quarter or two; fails_when=Next is worded
    # relative to Now (e.g. "after those two"); no_claim=agents read it so.
    h = {
        "short_quarters": short,
        "medium_quarters": medium,
        "long_from_months": 3 * (short + medium),
        "long_to_months": 60,
    }
    spans = {col: span for col, _, span in flows.horizon_lines(h)}
    assert spans["now"] == ("the current quarter" if short == 1 else "the current and next quarter")
    assert spans["next"] == ("the next quarter" if medium == 1 else f"the next {medium} quarters")


def test_feedback_loop_prompt_names_the_roadmap():
    flow = flows.FLOWS["feedback_loop"]
    segment = flow.segment("next_draft")
    ctx = flows.PromptContext(
        run_id="r1", document=ROADMAP, snapshot_as_of=None, low_confidence=0.4, kind="roadmap"
    )
    prompt = flows.build_steps(flow, segment, flows.resolve_knobs(flow, {}), ctx)[-1][2]
    assert "next draft of the roadmap" in prompt
    assert "Write the draft as roadmap.md" in prompt
    assert "artifacts: roadmap.md." in prompt
    assert segment.outputs_for("prd") == ("prd.md",)


# --------------------------------------------------------------------------- roadmap_items.yaml


def _check(text, **kw):
    return check_items(text, prd_slug=PRD, prd_version=1, prd_sections={"s-5-1", "s-5-2"}, **kw)


def _codes(text):
    return [p["code"] for p in _check(text).problems]


def test_items_valid():
    out = _check(ITEMS)
    assert out.ok, out.problems
    assert out.as_json() == {
        "items": 2,
        "by_horizon": {"now": 1, "next": 1, "later": 0},
        "problems": [],
    }


@pytest.mark.parametrize(
    ("change", "code"),
    [
        (("horizon: next", "horizon: soon"), "invalid_horizon"),
        (("    outcome: Fewer buyers drop off at shipping\n", ""), "missing_field"),
        (("id: shipping-step", "id: payment-step"), "duplicate_id"),
        (("depends_on: [payment-step]", "depends_on: [ghost]"), "unknown_dependency"),
        (("prd_section: s-5-2", "prd_section: s-9"), "unknown_prd_section"),
        (("confidence: medium", "confidence: sure"), "invalid_confidence"),
        (
            ('explanation: "activation weight 3 x contribution 1"', 'explanation: ""'),
            "unexplained_priority",
        ),
        (
            (
                "milestone: Shipping estimate up front",
                "milestone: {name: GA, date: 2027-02-01, date_source: guess}",
            ),
            "date_outside_now",
        ),
        (("date_source: ENG-412 estimate", "owner: me"), "undated_source"),
        (("date: 2026-11-30", 'date: "next month"'), "invalid_date"),
        (("horizon: now", "horizon: later"), "horizon_breaks_dependency"),
        (("document: checkout-redesign", "document: other"), "wrong_prd"),
    ],
)
def test_items_problems(change, code):
    text = ITEMS.replace(*change, 1)
    assert text != ITEMS
    assert code in _codes(text)


def test_items_order_respects_dependencies():
    first, second = ITEMS.split("  - id: shipping-step")
    head, payment = first.split("  - id: payment-step")
    swapped = head + "  - id: shipping-step" + second + "  - id: payment-step" + payment
    assert "order_breaks_dependency" in _codes(swapped)


@pytest.mark.parametrize(
    ("text", "code"),
    [("items: [", "invalid_yaml"), ("- a\n- b\n", "invalid_shape"), ("version: 1\n", "no_items")],
)
def test_items_shape(text, code):
    assert _codes(text) == [code]


def test_doc_links():
    links = doc_links(ROADMAP_MD)
    assert [(link["slug"], link["version"], link["section"]) for link in links] == [
        (PRD, 1, "s-5-1"),
        (PRD, 1, "s-5-2"),
        (PRD, 1, "gone"),
    ]


# --------------------------------------------------------------------------- inputs


async def test_refused_without_an_approved_version(client, owner, runtime):
    _, auth = owner
    await approved_prd(client, auth, approve=False)
    resp = await client.post(
        "/v1/runs", json={"flow": "prd_to_roadmap", "source": PRD}, headers=auth
    )
    assert resp.status_code == 422
    assert "no approved version" in resp.json()["detail"]


async def test_a_named_version_must_be_approved(client, owner, runtime):
    _, auth = owner
    await approved_prd(client, auth, approve=False)
    v2 = draft("prd_v1.md").replace("Checkout redesign PRD", "Checkout redesign PRD (v2)")
    assert (await import_draft(client, auth, v2)).status_code == 201
    assert (
        await client.post(f"/v1/documents/{PRD}/versions/2/approve", headers=auth)
    ).status_code == 200
    resp = await client.post(
        "/v1/runs",
        json={"flow": "prd_to_roadmap", "source": PRD, "source_version": 1},
        headers=auth,
    )
    assert resp.status_code == 422 and "not approved" in resp.json()["detail"]
    run = await create(client, auth, source=PRD)
    assert run["source"]["version"] == 2  # the latest approved version by default
    run = await create(client, auth, source=PRD, source_version=2, document="named-roadmap")
    assert run["source"]["version"] == 2 and run["document_slug"] == "named-roadmap"
    missing = await create(client, auth, status=422, source=PRD, source_version=9)
    assert "not found" in missing["detail"]


async def test_input_validation(client, owner, runtime):
    _, auth = owner
    await approved_prd(client, auth)
    cases = [
        {},  # no source
        {"source": "nope"},
        {"source": PRD, "document": PRD},  # the target is a PRD, not a roadmap
        {"source": PRD, "template": "oracle-default"},  # a PRD template
        {"source": PRD, "template": "ghost"},
        {"source": PRD, "theme": "ghost"},
        {"source": PRD, "document": str(uuid.uuid4())},
        {"source": PRD, "knobs": {"roles": {"roadmap_items": ["ghost"]}}},
    ]
    for body in cases:
        resp = await client.post("/v1/runs", json={"flow": "prd_to_roadmap", **body}, headers=auth)
        assert resp.status_code == 422, (body, resp.text)
    for body in (
        {"flow": "baseline_to_prd", "document": "x", "template": "now-next-later"},
        {"flow": "baseline_to_prd", "document": "x", "source": PRD},
    ):
        resp = await client.post("/v1/runs", json=body, headers=auth)
        assert resp.status_code == 422, (body, resp.text)
    # A roadmap is not a PRD to build from.
    run = await built_roadmap(client, auth, runtime)
    resp = await client.post(
        "/v1/runs", json={"flow": "prd_to_roadmap", "source": run["document_slug"]}, headers=auth
    )
    assert resp.status_code == 422 and "not a PRD" in resp.json()["detail"]


async def test_defaults_and_patch(client, owner, runtime):
    _, auth = owner
    await approved_prd(client, auth)
    run = await create(client, auth, source=PRD)
    assert run["flow"] == "prd_to_roadmap" and run["status"] == "draft"
    assert run["document_slug"] == ROADMAP and run["document_id"] is None
    assert run["document_kind"] == "roadmap"
    assert run["template"] == "now-next-later" and run["theme"] == "roadmap-board"
    assert run["source"]["slug"] == PRD and run["source"]["version"] == 1
    assert run["source"]["title"] == PRD_TITLE and run["source"]["approved_at"]
    resp = await client.patch(
        f"/v1/runs/{run['id']}",
        json={"template": "outcome-roadmap", "knobs": {"depth": "quick"}},
        headers=auth,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["template"] == "outcome-roadmap" and body["theme"] == "roadmap-board"
    assert body["knobs"]["depth"] == "quick"
    assert body["source"]["version"] == 1 and body["document_slug"] == ROADMAP
    est = (await client.post(f"/v1/runs/{run['id']}/estimate", headers=auth)).json()
    assert est["total_usd"] == 7.25
    assert [s["name"] for s in est["segments"]] == ["roadmap_items", "roadmap_draft"]


# --------------------------------------------------------------------------- end to end


async def test_end_to_end(client, owner, runtime):
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    runtime.script["roadmap_items"] = [Outcome(artifacts={"roadmap_items.yaml": ITEMS})]
    runtime.script["roadmap_draft"] = [Outcome(artifacts={"roadmap.md": ROADMAP_MD})]

    run = await start(client, auth, await create(client, auth, source=PRD))
    assert run["status"] == "running" and run["estimate_usd"] == 14.5
    spec = runtime.submitted[0]
    assert spec.outputs == ("roadmap_items.yaml",)
    assert set(spec.mcp.scopes) == {"read:sources", "read:baseline", "read:documents"}
    prompt = spec.steps[-1].prompt
    assert f"approved PRD '{PRD_TITLE}' ({PRD}), version 1" in prompt
    assert "s-5-1 (5.1 Payment step)" in prompt
    assert "Priority order (goal_weighted, live ranking" in prompt
    assert "payment-step (Payment step), score" in prompt
    assert "depends on payment-step" in prompt
    assert "- feature:shipping-step depends_on feature:payment-step" in prompt
    assert "- activation: Raise activation" in prompt
    assert "--- PRD checkout-redesign v1 ---" in prompt
    assert "--- template skeleton ---" not in prompt  # the skeleton is for the draft

    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint" and run["waiting_on"] == "roadmap_items"
    check = run["segments"][0]["items_check"]
    assert check == {
        "items": 2,
        "by_horizon": {"now": 1, "next": 1, "later": 0},
        "problems": [],
        # D2 product reasons (additive): both items serve a confirmed goal, no base yet.
        "reasons": [],
        "blocking": 0,
        "to_confirm": 0,
        "file_problems": 0,
        "base": None,
        "reasons_partial": False,
    }
    assert pending(run)["payload"]["items_check"] == check
    run = await decide(client, auth, run, note="Keep shipping in next")

    spec = runtime.submitted[1]
    assert spec.outputs == ("roadmap.md",)
    assert "write:drafts" not in spec.mcp.scopes
    prompt = spec.steps[-1].prompt
    assert "--- roadmap_items.yaml ---" in prompt and "id: payment-step" in prompt
    assert "roadmap_items: Keep shipping in next" in prompt
    assert "/documents/checkout-redesign/v/1#<section id>" in prompt
    assert "--- template skeleton ---" in prompt
    assert "document: checkout-redesign-roadmap" in prompt
    assert "template: now-next-later" in prompt and "theme: roadmap-board" in prompt

    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint" and run["waiting_on"] == "roadmap_review"
    imp = run["segments"][1]["draft_import"]
    assert imp["version"] == 1 and imp["created"] and imp["slug"] == ROADMAP
    assert imp["kind"] == "roadmap"
    assert imp["source"]["slug"] == PRD and imp["source"]["version"] == 1
    assert imp["prd_links"] == {
        "resolved": 2,
        "unresolved": ["/documents/checkout-redesign/v/1#gone"],
    }
    assert run["document_slug"] == ROADMAP and run["document_id"]
    run = await decide(client, auth, run)
    assert run["status"] == "succeeded"

    # The document: a roadmap with the run's template and theme, and its provenance.
    doc = (await client.get(f"/v1/documents/{ROADMAP}", headers=auth)).json()
    assert doc["kind"] == "roadmap" and doc["theme"] == "roadmap-board"
    assert doc["template"] == "now-next-later" and doc["template_version"] == "1"
    assert doc["source"]["slug"] == PRD and doc["source"]["version"] == 1
    assert doc["versions"][0]["source"]["title"] == PRD_TITLE
    version = (await client.get(f"/v1/documents/{ROADMAP}/versions/1", headers=auth)).json()
    assert version["source"]["document_id"] == doc["source"]["document_id"]
    assert version["brief_source"] == "draft"
    listed = (await client.get("/v1/documents?kind=roadmap", headers=auth)).json()
    assert [(d["slug"], d["source"]["version"]) for d in listed] == [(ROADMAP, 1)]
    prds = (await client.get("/v1/documents?kind=prd", headers=auth)).json()
    assert [(d["slug"], d["approved_version"], d["source"]) for d in prds] == [(PRD, 1, None)]
    async with tenant_session(tenant_id) as s:
        row = await s.scalar(select(Document).where(Document.slug == ROADMAP))
        v1 = await s.scalar(select(DocumentVersion).where(DocumentVersion.document_id == row.id))
        prd_v1 = await s.scalar(
            select(DocumentVersion)
            .join(Document, Document.id == DocumentVersion.document_id)
            .where(Document.slug == PRD)
        )
        assert v1.source_version_id == prd_v1.id

    # Runs list the source too.
    runs = (await client.get("/v1/runs", headers=auth)).json()
    assert runs[0]["source"]["slug"] == PRD and runs[0]["document_kind"] == "roadmap"


async def test_the_prompt_reads_the_companys_horizons(client, owner, runtime):
    # protects=runs honour the owner's horizons; fails_when=the constant is still used;
    # no_claim=agent behaviour.
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    value = {
        "short_quarters": 2,
        "medium_quarters": 2,
        "long_from_months": 18,
        "long_to_months": 30,
    }
    put = await client.put("/v1/settings/planning_horizons", json={"value": value}, headers=auth)
    assert put.status_code == 200, put.text
    await start(client, auth, await create(client, auth, source=PRD))
    prompt = runtime.submitted[0].steps[-1].prompt
    assert (
        "now = short term, the current and next quarter; next = medium term, the next 2 "
        "quarters; later = long term, 18 to 30 months"
    ) in prompt
    assert "the current quarter;" not in prompt


async def test_without_a_setting_the_prompt_keeps_the_default_horizons(client, owner, runtime):
    # protects=no stored row means today's text, byte for byte; fails_when=the default
    # wording drifts; no_claim=agent behaviour.
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    await start(client, auth, await create(client, auth, source=PRD))
    prompt = runtime.submitted[0].steps[-1].prompt
    assert (
        "Horizons (B2): now = short term, the current quarter; next = medium term, the next "
        "two quarters; later = long term, 12 to 24 months."
    ) in prompt


async def test_a_run_keeps_the_horizons_it_started_with(client, owner, runtime):
    # protects=Settings > Company's promise that runs under way keep what they started
    # with; fails_when=a later segment or a change request reads the setting
    # changed mid-run; no_claim=agent behaviour.
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    runtime.script["roadmap_items"] = [
        Outcome(artifacts={"roadmap_items.yaml": ITEMS}),
        Outcome(artifacts={"roadmap_items.yaml": ITEMS}),
    ]
    runtime.script["roadmap_draft"] = [Outcome(artifacts={"roadmap.md": ROADMAP_MD})]
    started = (
        "Horizons (B2): now = short term, the current quarter; next = medium term, the next "
        "two quarters; later = long term, 12 to 24 months."
    )
    changed = (
        "now = short term, the current quarter; next = medium term, the next 4 quarters; "
        "later = long term, 18 to 30 months"
    )

    def prompt(n: int) -> str:
        return "\n".join(step.prompt for step in runtime.submitted[n].steps)

    run = await start(client, auth, await create(client, auth, source=PRD))
    assert started in prompt(0)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["waiting_on"] == "roadmap_items"

    value = {
        "short_quarters": 1,
        "medium_quarters": 4,
        "long_from_months": 18,
        "long_to_months": 30,
    }
    put = await client.put("/v1/settings/planning_horizons", json={"value": value}, headers=auth)
    assert put.status_code == 200, put.text

    # A change request resubmits the segment: still the run's horizons.
    run = await decide(client, auth, run, "changes_requested", "Tighten the now column")
    assert len(runtime.submitted) == 2
    assert "Tighten the now column" in prompt(1)
    assert started in prompt(1) and changed not in prompt(1)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["waiting_on"] == "roadmap_items"

    # The next segment too.
    run = await decide(client, auth, run)
    assert len(runtime.submitted) == 3
    assert started in prompt(2) and changed not in prompt(2)

    # A run started after the change takes the new horizons.
    later = await start(client, auth, await create(client, auth, source=PRD, document="r2"))
    assert later["status"] == "running"
    assert changed in prompt(3) and started not in prompt(3)


async def test_exports_resolve_prd_links_and_carry_provenance(client, owner, runtime):
    _, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    url = f"/v1/documents/{ROADMAP}/versions/1/export"
    app = render.app_url("")
    for layer in ("full", "brief"):
        html = (await client.get(url, params={"format": "html", "layer": layer}, headers=auth)).text
        assert f'<a href="{app}/documents/{PRD}/v/1">From {PRD_TITLE} v1</a>' in html, layer
    html = (await client.get(url, params={"format": "html"}, headers=auth)).text
    assert f'href="{app}/documents/{PRD}/v/1#s-s-5-1"' in html
    assert 'href="/documents/' not in html
    md = (await client.get(url, params={"format": "md"}, headers=auth)).text
    assert f"from {PRD_TITLE} ({PRD}) version 1" in md.split("\n-->")[0]
    deck = (await client.get(f"/v1/documents/{ROADMAP}/versions/1/deck", headers=auth)).json()
    assert deck["source"]["slug"] == PRD
    assert f"From {PRD_TITLE} v1" in deck["banner"]
    assert f"From {PRD_TITLE} v1" in deck["slides"][0]["html"]
    deck_html = (
        await client.get(url, params={"format": "html", "layer": "deck"}, headers=auth)
    ).text
    assert f"From {PRD_TITLE} v1" in deck_html


async def test_a_bad_items_file_waits_at_its_checkpoint_or_fails_the_run(client, owner, runtime):
    _, auth = owner
    await approved_prd(client, auth)
    bad = ITEMS.replace("horizon: next", "horizon: soon")
    runtime.script["roadmap_items"] = [
        Outcome(artifacts={"roadmap_items.yaml": bad}),
        Outcome(artifacts={"roadmap_items.yaml": ITEMS}),
        Outcome(artifacts={"roadmap_items.yaml": bad}),
    ]
    run = await start(client, auth, await create(client, auth, source=PRD))
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["waiting_on"] == "roadmap_items"
    assert [p["code"] for p in pending(run)["payload"]["items_check"]["problems"]] == [
        "invalid_horizon"
    ]
    run = await decide(client, auth, run, "changes_requested", "Use now, next or later")
    assert "Use now, next or later" in runtime.submitted[-1].steps[0].prompt
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["segments"][0]["items_check"]["problems"] == []

    off = {"roadmap_items": False, "roadmap_review": False}
    run = await start(
        client,
        auth,
        await create(client, auth, source=PRD, document="r2", knobs={"checkpoints": off}),
    )
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "failed"
    assert run["error"].startswith("roadmap_items.yaml was rejected: [invalid_horizon]")


async def test_a_date_without_a_verified_basis_is_refused(client, owner, runtime):
    """O4 and CR-11: Oracle never invents dates. A milestone date whose date_source
    names no verified estimate, capacity or commitment (or one for another date) is a
    problem at the checkpoint, and fails the run with the checkpoint off."""
    _, auth = owner
    await approved_prd(client, auth)
    guessed = ITEMS.replace("date_source: ENG-412 estimate", "date_source: the team thinks so")
    other_day = ITEMS.replace("date: 2026-11-30", "date: 2026-12-15")
    runtime.script["roadmap_items"] = [
        Outcome(artifacts={"roadmap_items.yaml": guessed}),
        Outcome(artifacts={"roadmap_items.yaml": other_day}),
    ]
    run = await start(client, auth, await create(client, auth, source=PRD))
    assert "- ENG-412 (estimate) supports 2026-11-30" in runtime.submitted[0].steps[-1].prompt
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert [p["code"] for p in pending(run)["payload"]["items_check"]["problems"]] == [
        "unverified_date"
    ]
    off = {"roadmap_items": False, "roadmap_review": False}
    run = await start(
        client,
        auth,
        await create(client, auth, source=PRD, document="r2", knobs={"checkpoints": off}),
    )
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "failed"
    assert run["error"].startswith("roadmap_items.yaml was rejected: [unverified_date]")


def test_items_check_dates_against_verified_bases():
    from oracle.roadmap.schedule import Basis

    eng = Basis(uuid.uuid4(), "estimate", "ENG-412", date(2026, 11, 30))
    assert check_items(ITEMS, date_bases=[eng]).ok
    assert check_items(ITEMS).ok  # without bases (pure parsing) dates are not checked
    for bases in ([], [Basis(uuid.uuid4(), "estimate", "ENG-41", date(2026, 11, 30))]):
        codes = [p["code"] for p in check_items(ITEMS, date_bases=bases).problems]
        assert codes == ["unverified_date"], bases
    dated = "milestone: {name: Beta, date: 2026-11-30, date_source: ENG-412 estimate}"
    undated = ITEMS.replace(dated, "milestone: Beta")
    assert check_items(undated, date_bases=[]).ok


async def test_existing_roadmap_gets_the_next_version(client, owner, runtime):
    _, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    run = await create(client, auth, source=PRD)
    assert run["document_slug"] == ROADMAP and run["document_id"]
    # A PRD theme does not fit a roadmap.
    refused = await create(
        client, auth, status=422, source=PRD, document=ROADMAP, theme="clean-document"
    )
    assert "not roadmap" in refused["detail"]
    off = {"roadmap_items": False, "roadmap_review": False}
    runtime.script["roadmap_items"] = [Outcome(artifacts={"roadmap_items.yaml": ITEMS})]
    runtime.script["roadmap_draft"] = [
        Outcome(artifacts={"roadmap.md": ROADMAP_MD.replace("payment first", "payment now")})
    ]
    run = await start(
        client, auth, await create(client, auth, source=PRD, knobs={"checkpoints": off})
    )
    await tick(client, auth)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "succeeded", run
    assert run["segments"][1]["draft_import"]["version"] == 2


# --------------------------------------------------------------------------- feedback loop


async def test_feedback_loop_on_a_roadmap(client, owner, runtime):
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    async with tenant_session(tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == ROADMAP))
        s.add(
            FeedbackItem(
                document_id=doc.id,
                raised_on_version=1,
                kind="general",
                summary="Move shipping into now",
            )
        )
        await s.commit()

    resp = await client.post(
        "/v1/runs",
        json={"flow": "feedback_loop", "document": ROADMAP, "template": "now-next-later"},
        headers=auth,
    )
    assert resp.status_code == 422  # the feedback loop keeps the document's template
    run = await start(
        client,
        auth,
        (
            await client.post(
                "/v1/runs", json={"flow": "feedback_loop", "document": ROADMAP}, headers=auth
            )
        ).json(),
    )
    assert run["document_kind"] == "roadmap"
    spec = runtime.submitted[-1]
    assert spec.outputs == ("roadmap.md",)
    prompt = spec.steps[-1].prompt
    assert "roadmap document 'checkout-redesign-roadmap'" in prompt
    assert "next draft of the roadmap" in prompt and "Move shipping into now" in prompt

    await tick(client, auth)
    run = await get(client, auth, run["id"])
    # The feedback loop on a roadmap is a roadmap review; its knob keeps the segment key.
    assert run["waiting_on"] == "roadmap_review"
    assert run["segments"][0]["checkpoint"] == "roadmap_review"
    assert run["knobs"]["checkpoints"] == {"prd_review": True}
    imp = run["segments"][0]["draft_import"]
    assert imp["version"] == 2 and imp["kind"] == "roadmap"
    # The next draft keeps the PRD version the roadmap came from.
    assert imp["source"]["slug"] == PRD and imp["source"]["version"] == 1
    doc = (await client.get(f"/v1/documents/{ROADMAP}", headers=auth)).json()
    assert doc["kind"] == "roadmap" and doc["template"] == "now-next-later"
    assert [v["source"]["version"] for v in doc["versions"]] == [1, 1]
    run = await decide(client, auth, run)
    assert run["status"] == "succeeded"


async def test_feedback_loop_refuses_a_prd_draft_for_a_roadmap(client, owner, runtime):
    _, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    runtime.script["next_draft"] = [Outcome(artifacts={"prd.md": draft("prd_v1.md")})]
    run = await start(
        client,
        auth,
        (
            await client.post(
                "/v1/runs", json={"flow": "feedback_loop", "document": ROADMAP}, headers=auth
            )
        ).json(),
    )
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["segments"][0]["draft_import"]["error"] == "the segment left no roadmap.md"


# --------------------------------------------------------------------------- roles and cost


async def test_role_checks(client, owner, runtime):
    tenant_id, auth = owner
    await approved_prd(client, auth)
    viewer = await as_user(tenant_id, "viewer")
    commenter = await as_user(tenant_id, "commenter")
    approver = await as_user(tenant_id, "approver")
    body = {"flow": "prd_to_roadmap", "source": PRD}
    for headers in (viewer, commenter):
        assert (await client.post("/v1/runs", json=body, headers=headers)).status_code == 403
    run = await start(client, approver, await create(client, approver, source=PRD))
    await tick(client, auth)
    run = await get(client, commenter, run["id"])
    assert pending(run)["kind"] == "roadmap_items" and pending(run)["can_decide"] is False
    resp = await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{pending(run)['id']}/decide",
        json={"decision": "approved"},
        headers=commenter,
    )
    assert resp.status_code == 403
    inbox = (await client.get("/v1/inbox", headers=approver)).json()
    assert [c["segment_title"] for c in inbox["checkpoints"]] == ["Roadmap items"]
    run = await decide(client, approver, await get(client, approver, run["id"]))
    assert run["status"] == "running"
    # Viewers read runs and roadmaps.
    assert (await client.get(f"/v1/runs/{run['id']}", headers=viewer)).status_code == 200
    assert (await client.get("/v1/documents?kind=roadmap", headers=viewer)).status_code == 200


async def test_over_the_threshold_waits_for_an_owner(client, owner, runtime):
    tenant_id, auth = owner
    await approved_prd(client, auth)
    approver = await as_user(tenant_id, "approver")
    roles = {
        "roadmap_items": ["researcher", "analyst", "architect", "prioritizer"],
        "roadmap_draft": ["writer", "critic", "researcher", "architect"],
    }
    run = await create(client, approver, source=PRD, knobs={"depth": "deep", "roles": roles})
    est = (await client.post(f"/v1/runs/{run['id']}/estimate", headers=approver)).json()
    assert est["total_usd"] == 65.0 and est["needs_approval"] is True
    resp = await client.post(f"/v1/runs/{run['id']}/start", headers=approver)
    assert resp.json()["status"] == "awaiting_approval"
    assert runtime.submitted == []
    assert (await client.post(f"/v1/runs/{run['id']}/approve", headers=approver)).status_code == 403
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    assert [r["source"]["slug"] for r in inbox["approvals"]] == [PRD]
    resp = await client.post(f"/v1/runs/{run['id']}/approve", headers=auth)
    assert resp.status_code == 200 and resp.json()["status"] == "running"
    assert len(runtime.submitted) == 1


# --------------------------------------------------------------------------- MCP


async def test_mcp_lists_the_flow_and_returns_provenance(client, owner, runtime):
    from tests.test_mcp import api_token, mcp_client, text_of

    tid, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    token = await api_token(tid, "owner")
    async with mcp_client(token) as c:
        catalog = await c.call_tool("list_flows", {})
        assert not catalog.is_error, text_of(catalog)
        assert "prd_to_roadmap" in [f["key"] for f in catalog.structured_content["flows"]]
        doc = await c.call_tool("get_document", {"doc": ROADMAP})
        assert doc.structured_content["source"]["slug"] == PRD
        listed = await c.call_tool("list_documents", {"kind": "roadmap"})
        assert [d["slug"] for d in listed.structured_content["result"]] == [ROADMAP]
        created = await c.call_tool(
            "create_run", {"body": {"flow": "prd_to_roadmap", "source": PRD, "document": "via-mcp"}}
        )
        assert not created.is_error, text_of(created)
        assert created.structured_content["source"]["version"] == 1


# --------------------------------------------------------------------- review fixes


async def test_a_draft_of_the_other_kind_never_imports_into_a_document(client, owner):
    _, auth = owner
    await approved_prd(client, auth)
    # A roadmap pushed into the approved PRD, by its front matter kind or its template.
    named = ROADMAP_MD.replace("document: checkout-redesign-roadmap\n", "")
    resp = await import_draft(client, auth, named, doc=PRD)
    assert resp.status_code == 422
    assert resp.json()["errors"][0]["code"] == "kind_mismatch"
    by_template = named.replace("kind: roadmap\n", "")
    resp = await import_draft(client, auth, by_template, doc=PRD)
    assert resp.status_code == 422
    assert resp.json()["errors"][0]["code"] == "kind_mismatch"
    doc = (await client.get(f"/v1/documents/{PRD}", headers=auth)).json()
    assert doc["status"] == "approved" and doc["latest_version"] == 1


async def test_a_run_without_a_template_takes_the_company_default(client, owner, runtime):
    _, auth = owner
    await approved_prd(client, auth)
    await client.get("/v1/templates", headers=auth)
    resp = await client.put(
        "/v1/drafts/defaults",
        json={"roadmap": {"template": "outcome-roadmap", "theme": "roadmap-board"}},
        headers=auth,
    )
    assert resp.status_code == 200, resp.text
    run = await create(client, auth, source=PRD)
    assert run["template"] == "outcome-roadmap" and run["theme"] == "roadmap-board"
    # A template named in the call still wins.
    run = await create(client, auth, source=PRD, template="now-next-later")
    assert run["template"] == "now-next-later"


def test_app_links_default_to_the_public_url(monkeypatch):
    from oracle.config import Settings
    from oracle.swarm.settings import get_runtime_settings

    assert Settings.model_fields["app_url"].default == ""
    monkeypatch.setattr(render, "get_settings", lambda: Settings(app_url=""))
    base = get_runtime_settings().public_url.rstrip("/")
    assert render.app_url("/documents/x/v/1") == f"{base}/documents/x/v/1"
    monkeypatch.setattr(render, "get_settings", lambda: Settings(app_url="https://o.example/"))
    assert render.app_url("/documents/x/v/1") == "https://o.example/documents/x/v/1"


async def test_a_new_document_takes_its_kind_from_the_draft_and_stays_importable(client, owner):
    _, auth = owner
    # No kind line: the roadmap template makes it a roadmap, and it takes new versions.
    # (No PRD to verify a date against: round 3, a date in the text would be refused.)
    first = ROADMAP_MD.replace("kind: roadmap\n", "").replace("Beta by 2026-11-30.", "Beta first.")
    assert (await import_draft(client, auth, first, doc=ROADMAP)).status_code == 201
    doc = (await client.get(f"/v1/documents/{ROADMAP}", headers=auth)).json()
    assert doc["kind"] == "roadmap"
    second = first.replace("title: Checkout roadmap", "title: Checkout roadmap, second pass")
    assert (await import_draft(client, auth, second, doc=ROADMAP)).status_code == 201


async def test_a_draft_pushed_before_the_import_still_gets_its_provenance(client, owner, runtime):
    _, auth = owner
    await approved_prd(client, auth)
    # The same roadmap.md arrived first by another path (an agent's push).
    assert (await import_draft(client, auth, ROADMAP_MD, doc=ROADMAP)).status_code == 201
    run = await built_roadmap(client, auth, runtime)
    imp = run["segments"][-1]["draft_import"]
    assert imp["created"] is False and imp["version"] == 1
    assert imp["source"]["slug"] == PRD and imp["source"]["version"] == 1
    doc = (await client.get(f"/v1/documents/{ROADMAP}", headers=auth)).json()
    assert doc["versions"][0]["source"]["version"] == 1
