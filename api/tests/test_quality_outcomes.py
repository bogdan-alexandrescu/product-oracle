"""Post-publish outcome tracking and learnings (§10, last paragraph).

Launched roadmap items and validation experiments link back to goals; an assessment
records whether the prediction held; learnings feed future module and question
recommendations. None of it changes a published (approved) document.
"""

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from oracle.baseline.models import Entity
from oracle.docs.models import DocumentVersion, Section
from oracle.models import AuditEvent
from oracle.tenancy import tenant_session
from oracle.v2 import models as m
from tests.baseline_helpers import make_ctx
from tests.quality_corpus import import_markdown, load_case, seed_case

ROADMAP = """---
document: saved-addresses-roadmap
title: Saved addresses roadmap
kind: roadmap
---

# Saved addresses roadmap {#title}

## Now {#now}

### Saved address book {#item-saved-addresses}

Launch the address book to 10% of returning buyers.
"""


@pytest.fixture
async def world(client):
    """An approved PRD (published), a launched roadmap item and an experiment."""
    ctx = await make_ctx()
    seeded = await seed_case(client, ctx, load_case("good-prd"))
    roadmap = await import_markdown(client, ctx.as_("owner"), ROADMAP)
    async with tenant_session(ctx.tenant_id) as s:
        version = await s.get(DocumentVersion, seeded.version_id)
        version.approved_at = datetime.now(UTC)
        version.approved_by = ctx.users["owner"].id
        experiment = m.FeasibilityExperiment(
            blocker_id=seeded.refs["lookup-quota"], hypothesis="Batching halves lookup calls"
        )
        s.add(experiment)
        await s.commit()
        experiment_id = experiment.id
    return {
        "ctx": ctx,
        "seeded": seeded,
        "roadmap_version_id": roadmap["id"],
        "experiment_id": str(experiment_id),
    }


def outcome_body(world, **extra) -> dict:
    seeded = world["seeded"]
    return {
        "title": "Saved addresses lift repeat checkout",
        "goal_id": str(seeded.refs["goal"]),
        "prd_version_id": str(seeded.version_id),
        "roadmap_version_id": world["roadmap_version_id"],
        "roadmap_item_key": "item-saved-addresses",
        "experiment_id": world["experiment_id"],
        "prediction": {
            "metric": "repeat checkout completion",
            "baseline": "62%",
            "predicted": "at least 68%",
            "threshold": "below 64% after 30 days: revisit",
        },
        "module_keys": ["metrics.success"],
        "gap_categories": ["success_metric"],
        **extra,
    }


async def test_an_approver_links_launched_work_to_a_goal_and_assesses_it(client, world):
    ctx = world["ctx"]
    body = outcome_body(world)
    assert (await client.post("/v1/outcomes", json=body, headers=ctx.as_("commenter"))).status_code == 403
    resp = await client.post("/v1/outcomes", json=body, headers=ctx.as_("approver"))
    assert resp.status_code == 201, resp.text
    outcome = resp.json()
    assert outcome["status"] == "tracking"
    assert outcome["goal_id"] == body["goal_id"]
    assert outcome["document_id"] == str(world["seeded"].document_id)
    assert outcome["roadmap_item_key"] == "item-saved-addresses"

    listed = await client.get(
        "/v1/outcomes", params={"goal_id": body["goal_id"]}, headers=ctx.as_("viewer")
    )
    assert [o["id"] for o in listed.json()] == [outcome["id"]]

    url = f"/v1/outcomes/{outcome['id']}/assessments"
    assessment = {"verdict": "not_held", "observed": "63% after 60 days", "note": "Pilot too small"}
    assert (await client.post(url, json=assessment, headers=ctx.as_("viewer"))).status_code == 403
    resp = await client.post(url, json=assessment, headers=ctx.as_("approver"))
    assert resp.status_code == 200, resp.text
    result = resp.json()
    assert result["outcome"]["status"] == "not_held"
    assert result["outcome"]["observed"] == "63% after 60 days"
    assert len(result["outcome"]["assessments"]) == 1
    # Oracle drafts learnings; a person decides whether to keep them.
    drafts = result["suggested_learnings"]
    assert {(d["applies_to"], d["target"]) for d in drafts} >= {
        ("question_category", "success_metric"),
        ("module", "metrics.success"),
    }
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.scalars(select(m.EvaluationReport))).all() == []
        actions = list(await s.scalars(select(AuditEvent.action)))
    assert "outcome.created" in actions and "outcome.assessed" in actions


async def test_outcome_links_are_validated(client, world):
    ctx = world["ctx"]
    seeded = world["seeded"]
    headers = ctx.as_("approver")
    # Not a goal.
    resp = await client.post(
        "/v1/outcomes",
        json=outcome_body(world, goal_id=str(seeded.refs["feature"])),
        headers=headers,
    )
    assert resp.status_code == 422 and "goal" in resp.json()["detail"]
    # Nothing launched to link.
    body = outcome_body(world)
    for key in ("prd_version_id", "roadmap_version_id", "roadmap_item_key", "experiment_id"):
        body.pop(key)
    resp = await client.post("/v1/outcomes", json=body, headers=headers)
    assert resp.status_code == 422
    # A roadmap item that is not in the roadmap version.
    resp = await client.post(
        "/v1/outcomes", json=outcome_body(world, roadmap_item_key="nope"), headers=headers
    )
    assert resp.status_code == 422
    # A PRD version that was never approved (published) is not tracked.
    second = await import_markdown(
        client, ctx.as_("owner"), "---\ndocument: draft-only\ntitle: Draft\n---\n\n# D {#d}\n"
    )
    resp = await client.post(
        "/v1/outcomes",
        json=outcome_body(world, prd_version_id=second["id"]),
        headers=headers,
    )
    assert resp.status_code == 422 and "approved" in resp.json()["detail"]
    # Unknown ids.
    resp = await client.post(
        "/v1/outcomes", json=outcome_body(world, experiment_id=str(uuid.uuid4())), headers=headers
    )
    assert resp.status_code == 422


async def test_tracking_never_changes_a_published_document(client, world):
    ctx = world["ctx"]
    seeded = world["seeded"]

    async def snapshot():
        async with tenant_session(ctx.tenant_id) as s:
            v = await s.get(DocumentVersion, seeded.version_id)
            sections = list(
                await s.execute(
                    select(Section.section_key, Section.content_hash).where(
                        Section.version_id == v.id
                    )
                )
            )
            return (v.markdown, v.content_hash, v.approved_at, sorted(sections))

    before = await snapshot()
    outcome = (
        await client.post("/v1/outcomes", json=outcome_body(world), headers=ctx.as_("approver"))
    ).json()
    await client.post(
        f"/v1/outcomes/{outcome['id']}/assessments",
        json={"verdict": "held", "observed": "69%"},
        headers=ctx.as_("approver"),
    )
    await client.post(
        "/v1/learnings",
        json={
            "outcome_id": outcome["id"],
            "statement": "Address-step metrics predicted the lift well",
            "applies_to": "module",
            "target": "metrics.success",
            "direction": "recommend_more",
        },
        headers=ctx.as_("approver"),
    )
    assert await snapshot() == before
    async with tenant_session(ctx.tenant_id) as s:
        goal = await s.get(Entity, seeded.refs["goal"])
        assert goal.status == "confirmed"


async def test_learnings_become_recommendation_signals(client, world):
    ctx = world["ctx"]
    headers = ctx.as_("approver")

    async def learn(**body):
        resp = await client.post(
            "/v1/learnings", json={"statement": "A synthetic learning", **body}, headers=headers
        )
        assert resp.status_code == 201, resp.text
        return resp.json()

    a = await learn(applies_to="question_category", target="success_metric",
                    direction="recommend_more", weight=2)  # fmt: skip
    await learn(applies_to="question_category", target="success_metric", direction="recommend_more")
    await learn(applies_to="question_category", target="non_goals", direction="recommend_less")
    await learn(applies_to="module", target="economics.unit", direction="note")
    bad = await client.post(
        "/v1/learnings",
        json={"statement": "x", "applies_to": "question_category", "target": "not-a-category",
              "direction": "recommend_more"},
        headers=headers,
    )  # fmt: skip
    assert bad.status_code == 422
    bad = await client.post(
        "/v1/learnings",
        json={"statement": "x", "applies_to": "criterion", "target": "nope", "direction": "note"},
        headers=headers,
    )
    assert bad.status_code == 422

    resp = await client.get(
        "/v1/learnings/signals",
        params={"applies_to": "question_category"},
        headers=ctx.as_("viewer"),
    )
    assert resp.status_code == 200
    signals = {s["target"]: s for s in resp.json()}
    assert signals["success_metric"]["score"] == 3
    assert len(signals["success_metric"]["learning_ids"]) == 2
    assert signals["non_goals"]["score"] == -1
    assert "economics.unit" not in signals

    # A retired learning no longer counts.
    resp = await client.post(
        f"/v1/learnings/{a['id']}/retire", json={"reason": "Superseded"}, headers=headers
    )
    assert resp.status_code == 200 and resp.json()["status"] == "retired"
    signals = {
        s["target"]: s
        for s in (
            await client.get("/v1/learnings/signals", headers=ctx.as_("viewer"))
        ).json()
    }
    assert signals["success_metric"]["score"] == 1
    assert signals["economics.unit"]["score"] == 0
    listed = await client.get(
        "/v1/learnings", params={"status": "active"}, headers=ctx.as_("viewer")
    )
    assert a["id"] not in {x["id"] for x in listed.json()}


async def test_another_companys_outcomes_and_learnings_are_invisible(client, world):
    ctx = world["ctx"]
    other = await make_ctx("Company B")
    outcome = (
        await client.post("/v1/outcomes", json=outcome_body(world), headers=ctx.as_("approver"))
    ).json()
    learning = (
        await client.post(
            "/v1/learnings",
            json={"statement": "x", "applies_to": "module", "target": "m.k", "direction": "note"},
            headers=ctx.as_("approver"),
        )
    ).json()
    for who in ("viewer", "owner", "token"):
        h = other.as_(who)
        assert (await client.get(f"/v1/outcomes/{outcome['id']}", headers=h)).status_code == 404
        assert (await client.get("/v1/outcomes", headers=h)).json() == []
        assert (await client.get("/v1/learnings", headers=h)).json() == []
        assert (await client.get("/v1/learnings/signals", headers=h)).json() == []
    h = other.as_("owner")
    resp = await client.post(
        f"/v1/outcomes/{outcome['id']}/assessments", json={"verdict": "held", "observed": "x"},
        headers=h,
    )  # fmt: skip
    assert resp.status_code == 404
    resp = await client.post(f"/v1/learnings/{learning['id']}/retire", json={}, headers=h)
    assert resp.status_code == 404
    # Company B cannot link company A's goal or versions to its own outcome.
    resp = await client.post("/v1/outcomes", json=outcome_body(world), headers=h)
    assert resp.status_code == 422
