"""F5 lane 3: engineering specs requested from the Plan.

- A Plan item carries its feature and requirements (its trace), so the Plan inspector's
  Request spec dialog pre-ticks them.
- A request that names no engineering approvers gets the engineering leads (A3) who may
  approve (the spec's default, the dialog's "The engineering leads"); an empty list still
  means any approver.
- ``tech_brief_version_id`` feeds the feature's approved tech brief (F5-1) to the spec: the
  approach, the lead's verdict, the answers and the size are given to the agents as decided
  at the engineering review.
- ``GET /v1/spec-requests`` lists spec requests only (never the Engineering check's tech
  briefs, which share the ``tech_brief`` kind), each with its state for the Plan and the
  PRD overview: Requested, Drafting, In review, Approved or Stale.
- prd_to_spec says where it starts: the Plan and a PRD's overview.
- Request spec is an approver's (#580 review): the capabilities an approver reads say so
  for every item, as POST /v1/spec-requests answers them.
- A spec request on a PRD the reader may not see is absent from the list and its read.

Synthetic placeholders only.
"""

import json
import uuid

import pytest
from sqlalchemy import update

from oracle.auth.models import User
from oracle.docs.models import Document
from oracle.runs.models import Run
from oracle.specs import service as spec_service
from oracle.swarm import FakeRuntime, set_runtime
from oracle.tenancy import tenant_session
from oracle.v2.models import ArtifactOutput, ArtifactRequest, ArtifactVersion
from tests.baseline_helpers import make_ctx
from tests.specs_helpers import PRD, add_approver, make_world, request_spec
from tests.test_plan import Seed, by_key, plan
from tests.test_specs_review2 import generated


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


# --------------------------------------------------------------------------- the Plan item


async def test_a_plan_item_carries_its_feature_and_requirements(client):
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        feature = await seed.entity("feature", "f-pay")
        req_a = await seed.entity("requirement", "r-pay-card")
        req_b = await seed.entity("requirement", "r-pay-wallet")
        p1, _, r1, track, _ = await seed.approved_roadmap("prd-a", [])
        await seed.item(r1, "pay", p1, feature_id=feature.id,
                        requirement_ids=[req_a.id, req_b.id], track_id=track.id)  # fmt: skip
        await seed.item(r1, "bare", p1, position=1, track_id=track.id)
        await s.commit()
        ids = feature.id, req_a.id, req_b.id
    items = by_key(await plan(client, ctx, who="viewer"))
    pay = items["pay"]
    assert pay["feature"]["id"] == str(ids[0]) and pay["feature"]["title"] == "F-Pay"
    assert [r["id"] for r in pay["requirements"]] == [str(ids[1]), str(ids[2])]
    assert [r["key"] for r in pay["requirements"]] == ["r-pay-card", "r-pay-wallet"]
    assert items["bare"]["feature"] is None and items["bare"]["requirements"] == []


# --------------------------------------------------------------------------- approvers


async def make_lead(ctx, email: str, role: str = "approver") -> User:
    async with tenant_session(ctx.tenant_id) as s:
        user = User(email=email, password_hash="x", role=role, engineering_lead=True)
        s.add(user)
        await s.commit()
        ctx.users[email] = user
        return user


async def test_a_request_naming_no_approvers_gets_the_engineering_leads(client, runtime):
    world = await make_world(client)
    lead = await make_lead(world.ctx, "lead@example.com")
    # A lead who is a commenter cannot approve a spec: not a default approver.
    await make_lead(world.ctx, "lead-commenter@example.com", role="commenter")
    created = await request_spec(client, world)
    approvers = created["spec"]["engineering_approver_ids"]
    assert approvers == [str(lead.id)]
    # An explicit empty list keeps "any approver".
    other = await request_spec(client, world, engineering_approver_ids=[], document="other-spec")
    assert other["spec"]["engineering_approver_ids"] == []


async def test_without_leads_a_request_naming_no_approvers_is_any_approver(client, runtime):
    world = await make_world(client)
    created = await request_spec(client, world)
    assert created["spec"]["engineering_approver_ids"] == []


async def test_an_approver_is_told_they_may_request_a_spec(client, runtime):
    """protects=Request spec on the Plan and the PRD overview for an approver who is no owner
    (#580 review); fails_when=create_spec_request is per-item at owner, so can() hides it."""
    world = await make_world(client)
    resp = await client.get("/v1/me/capabilities", headers=world.ctx.as_("approver"))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["operations"]["create_spec_request"] is True
    assert "create_spec_request" not in body["per_item"]
    await request_spec(client, world, who="approver")


# --------------------------------------------------------------------------- the brief


BRIEF = {
    "feature": "early-shipping-cost",
    "title": "Early shipping cost",
    "approach": "Call the carrier adapter from the cart through a quote endpoint.",
    "touches": [{"area": "api/cart", "kind": "module", "change": "change", "ref": None}],
    "reuse": [],
    "risks": [{"risk": "Carrier rates time out", "level": "medium", "mitigation": "Cache"}],
    "questions": [{"id": "q1", "question": "Can rates be cached a day?", "why": "Latency",
                   "blocking": True}],
    "size": "m",
    "size_why": "One endpoint and a cache",
    "depends_on": [],
    "assumptions": ["The cart can call internal endpoints"],
    "code_map": {"used": False, "repos": []},
}  # fmt: skip


async def add_brief(
    world, *, status: str = "approved", document_id: uuid.UUID | None = None
) -> uuid.UUID:
    """A feature's tech brief as the Engineering check registers it (F5-1)."""
    async with tenant_session(world.ctx.tenant_id) as s:
        request = ArtifactRequest(
            kind="tech_brief",
            title=BRIEF["title"],
            source_document_id=document_id or world.prd_id,
            source_version_id=world.prd_v1,
            requirement_ids=[world.shipping],
            params={"feature_key": BRIEF["feature"], "run_id": None, "segment_seq": 1},
            status="succeeded",
        )
        s.add(request)
        await s.flush()
        av = ArtifactVersion(
            request_id=request.id,
            number=1,
            status=status,
            source_version_id=world.prd_v1,
            provenance={
                "verdict": {"value": "feasible_with_changes", "note": "Cache the carrier rates",
                            "by": None, "at": None},
                "answers": [{"question_id": "q1", "answer": "Yes, a day is fine", "by": None}],
                "size": "m",
            },
        )  # fmt: skip
        s.add(av)
        await s.flush()
        body = json.dumps(BRIEF)
        s.add(
            ArtifactOutput(version_id=av.id, name="brief.json", media_type="application/json",
                           size_bytes=len(body), sha256="0" * 64, content=body)
        )  # fmt: skip
        await s.commit()
        return av.id


async def prompt_of(world, run_id: str) -> str:
    async with tenant_session(world.ctx.tenant_id) as s:
        run = await s.get(Run, uuid.UUID(run_id))
        return "\n".join(await spec_service.prompt_lines(s, run))


async def test_the_tech_brief_feeds_the_spec(client, runtime):
    world = await make_world(client)
    brief_id = await add_brief(world)
    created = await request_spec(client, world, tech_brief_version_id=str(brief_id))
    spec = created["spec"]
    assert spec["tech_brief_version_id"] == str(brief_id)
    assert spec["request"]["params"]["tech_brief_version_id"] == str(brief_id)
    text = await prompt_of(world, created["run_id"])
    assert "decided at the engineering review" in text
    assert BRIEF["approach"] in text
    assert "feasible_with_changes" in text and "Cache the carrier rates" in text
    assert "Can rates be cached a day?" in text and "Yes, a day is fine" in text
    assert "Size: m" in text
    assert "without saying so" in text


async def test_a_spec_without_a_brief_has_no_brief_lines(client, runtime):
    world = await make_world(client)
    created = await request_spec(client, world)
    assert created["spec"]["tech_brief_version_id"] is None
    assert "decided at the engineering review" not in await prompt_of(world, created["run_id"])


async def test_the_brief_must_be_an_approved_tech_brief_of_the_prd(client, runtime):
    world = await make_world(client)
    missing = await request_spec(client, world, status=422, tech_brief_version_id=str(uuid.uuid4()))
    assert "tech brief" in missing["detail"]
    draft = await add_brief(world, status="draft")
    refused = await request_spec(client, world, status=422, tech_brief_version_id=str(draft))
    assert "approved" in refused["detail"]
    # A brief of another PRD.
    async with tenant_session(world.ctx.tenant_id) as s:
        doc = Document(slug="other-prd", title="Other PRD", kind="prd", status="approved")
        s.add(doc)
        await s.commit()
        other_id = doc.id
    elsewhere = await add_brief(world, document_id=other_id)
    wrong = await request_spec(client, world, status=422, tech_brief_version_id=str(elsewhere))
    assert PRD in wrong["detail"]


# --------------------------------------------------------------------------- the list


async def test_the_list_leaves_out_engineering_check_briefs(client, runtime):
    world = await make_world(client)
    await add_brief(world)
    created = await request_spec(client, world)
    listed = (
        await client.get("/v1/spec-requests", params={"prd": PRD}, headers=world.ctx.as_("viewer"))
    ).json()
    assert [s["request"]["id"] for s in listed] == [created["spec"]["request"]["id"]]
    assert listed[0]["feature_id"] == str(world.feature)


async def test_a_spec_on_a_prd_the_reader_may_not_see_is_absent(client, runtime):
    """protects=an approvers-only PRD's spec requests stay hidden from a commenter (#580
    review); fails_when=the list without ``prd`` or the read by id skips the PRD's
    visibility, or the slug falls back to the stored one."""
    world = await make_world(client)
    created = await request_spec(client, world)
    request_id = created["spec"]["request"]["id"]
    async with tenant_session(world.ctx.tenant_id) as s:
        await s.execute(update(Document).where(Document.slug == PRD).values(visibility="approvers"))
        await s.commit()
    commenter = world.ctx.as_("commenter")
    listed = (await client.get("/v1/spec-requests", headers=commenter)).json()
    assert request_id not in [s["request"]["id"] for s in listed]
    assert created["spec"]["document_slug"] not in json.dumps(listed)
    listed = (await client.get("/v1/spec-requests", params={"prd": PRD}, headers=commenter)).json()
    assert listed == []
    resp = await client.get(f"/v1/spec-requests/{request_id}", headers=commenter)
    assert resp.status_code == 404, resp.text
    # An approver still sees it.
    approver = world.ctx.as_("approver")
    listed = (await client.get("/v1/spec-requests", headers=approver)).json()
    assert request_id in [s["request"]["id"] for s in listed]
    resp = await client.get(f"/v1/spec-requests/{request_id}", headers=approver)
    assert resp.status_code == 200, resp.text


async def listed_state(client, world, request_id: str) -> str:
    resp = await client.get(
        "/v1/spec-requests", params={"prd": PRD}, headers=world.ctx.as_("viewer")
    )
    assert resp.status_code == 200, resp.text
    return next(s for s in resp.json() if s["request"]["id"] == request_id)["state"]


async def test_each_spec_says_its_state(client, runtime):
    world = await make_world(client)
    created = await request_spec(client, world)
    request_id = created["spec"]["request"]["id"]
    assert created["spec"]["state"] == "requested"
    assert await listed_state(client, world, request_id) == "requested"
    async with tenant_session(world.ctx.tenant_id) as s:
        await s.execute(
            update(Run).where(Run.id == uuid.UUID(created["run_id"])).values(status="running")
        )
        await s.commit()
    assert await listed_state(client, world, request_id) == "drafting"
    async with tenant_session(world.ctx.tenant_id) as s:
        await s.execute(
            update(Run).where(Run.id == uuid.UUID(created["run_id"])).values(status="failed")
        )
        await s.commit()
    assert await listed_state(client, world, request_id) == "failed"

    lead = await add_approver(world.ctx)
    built = await generated(client, runtime, world, engineering_approver_ids=[str(lead.id)])
    built_id = built["spec"]["request"]["id"]
    assert await listed_state(client, world, built_id) == "in_review"
    slug = built["spec"]["document_slug"]
    resp = await client.post(
        f"/v1/documents/{slug}/versions/1/approve", headers=world.ctx.as_(lead.email)
    )
    assert resp.status_code == 200, resp.text
    assert await listed_state(client, world, built_id) == "approved"
    async with tenant_session(world.ctx.tenant_id) as s:
        await s.execute(
            update(ArtifactVersion)
            .where(ArtifactVersion.request_id == uuid.UUID(built_id))
            .values(freshness="potentially_stale")
        )
        await s.commit()
    assert await listed_state(client, world, built_id) == "stale"


# --------------------------------------------------------------------------- the flow


async def test_the_spec_flow_says_where_it_starts(client, runtime):
    world = await make_world(client)
    body = (await client.get("/v1/flows", headers=world.ctx.as_("viewer"))).json()
    flow = next(f for f in body["flows"] if f["key"] == "prd_to_spec")
    assert flow["in_new_run_dialog"] is False
    assert flow["starts_from"] == {
        "label": "Request spec · Plan, an approved item, or a PRD's overview",
        "href": "/plan",
    }
