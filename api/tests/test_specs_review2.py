"""Specs security review, round 2 (owner decision E1, 2026-10-19): an edit to a spec may
change only its engineering parts; a spec lists only requirements linked to its approved
PRD version; a run token pushes only to its own run's document; with no engineering
approvers named, the requester may approve their own spec, audited."""

import uuid

import pytest
from sqlalchemy import select

from oracle.baseline.models import Entity
from oracle.docs.models import Document, DocumentVersion
from oracle.models import AuditEvent
from oracle.runs.models import Run
from oracle.runtokens import mint_run_token
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from oracle.tenancy import tenant_session
from oracle.v2.models import ArtifactVersion, DocumentSectionLink
from tests.fixtures import draft
from tests.specs_helpers import (
    PRD,
    adopt,
    design_json,
    get_run,
    get_spec,
    import_md,
    make_world,
    pending,
    request_spec,
    spec_md,
    start,
    tick,
)
from tests.test_mcp import mcp_client, text_of

SECTIONS = ["s-5-1", "s-5-2"]
REFUSED = "Product requirements come from PRD v1. Change them in the PRD."


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


async def generated(client, runtime, world, who: str = "approver", **body):
    created = await request_spec(client, world, who=who, depth="full", **body)
    runtime.script["spec_draft"] = [
        Outcome(artifacts={"spec.md": spec_md(), "design.json": design_json(world.reqs, SECTIONS)})
    ]
    await start(client, world.ctx.as_(who), created["run_id"])
    await tick(client, world.ctx.as_("owner"))
    return created


async def stored_markdown(tenant_id, slug: str, number: int = 1) -> str:
    async with tenant_session(tenant_id) as s:
        return await s.scalar(
            select(DocumentVersion.markdown)
            .join(Document, Document.id == DocumentVersion.document_id)
            .where(Document.slug == slug, DocumentVersion.number == number)
        )


async def version_count(tenant_id, slug: str) -> int:
    async with tenant_session(tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == slug))
        return len(
            (
                await s.scalars(
                    select(DocumentVersion.id).where(DocumentVersion.document_id == doc.id)
                )
            ).all()
        )


# --------------------------------------------------------------------------- item 2: edits


EDITS_OF_PRD_PARTS = [
    # A reworded requirement.
    ("Show shipping cost on the cart**", "Show shipping cost on the cart, free over $50**"),
    # A requirement statement.
    ("The cart shows the shipping cost before", "The cart may show the shipping cost before"),
    # An acceptance criterion decided with the PRD.
    ("A shopper sees the shipping cost without", "A shopper may see the shipping cost without"),
    # Sources.
    ("- Product requirements: PRD checkout-redesign version 1", "- Product requirements: none"),
    # The section heading.
    ("## Product requirements {#requirements}", "## Requirements we like {#requirements}"),
]


@pytest.mark.parametrize(("old", "new"), EDITS_OF_PRD_PARTS)
async def test_an_edit_that_changes_a_prd_part_is_refused(client, runtime, old, new):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    slug = created["spec"]["document_slug"]
    stored = await stored_markdown(world.ctx.tenant_id, slug)
    assert old in stored
    resp = await import_md(client, world.ctx.as_("approver"), stored.replace(old, new), doc=slug)
    assert resp.status_code == 422, resp.text
    assert REFUSED in resp.text
    assert await version_count(world.ctx.tenant_id, slug) == 1


async def test_an_edit_that_drops_the_requirements_section_is_refused(client, runtime):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    slug = created["spec"]["document_slug"]
    stored = await stored_markdown(world.ctx.tenant_id, slug)
    start_at = stored.index("## Product requirements {#requirements}")
    end_at = stored.index("## Proposed engineering approach")
    resp = await import_md(
        client,
        world.ctx.as_("owner"),
        (stored[:start_at] + stored[end_at:]).replace("\n- requirements\n", "\n"),
        doc=slug,
    )
    assert resp.status_code == 422, resp.text
    assert REFUSED in resp.text


async def test_an_edit_to_engineering_parts_is_accepted(client, runtime):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    slug = created["spec"]["document_slug"]
    stored = await stored_markdown(world.ctx.tenant_id, slug)
    edited = stored.replace("A shipping quote service", "A cached shipping quote service").replace(
        "- The quote refreshes when the cart changes.",
        "- The quote refreshes when the cart or the postcode changes.",
    )
    assert edited.count("cached shipping quote") == 1 and "or the postcode" in edited
    resp = await import_md(client, world.ctx.as_("approver"), edited, doc=slug)
    assert resp.status_code == 201, resp.text
    spec = await get_spec(client, world.ctx.as_("owner"), created["spec"]["request"]["id"])
    assert spec["latest_version"] == 2 and spec["versions"][1]["origin"] == "edit"
    # And an edit of that edit, still leaving the PRD parts alone.
    again = edited.replace(
        "Which carrier rates to cache.", "Which carrier rates to cache, how long."
    )
    resp = await import_md(client, world.ctx.as_("owner"), again, doc=slug)
    assert resp.status_code == 201, resp.text


async def test_a_run_cannot_push_to_another_runs_spec(client, runtime):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    slug = created["spec"]["document_slug"]
    stored = await stored_markdown(world.ctx.tenant_id, slug)
    edited = stored.replace("A shipping quote service", "A cached shipping quote service")
    owner = world.ctx.users["owner"]
    async with tenant_session(world.ctx.tenant_id) as s:
        other = Run(flow="baseline_to_prd", created_by=owner.id, knobs={"document_slug": "other"})
        s.add(other)
        await s.flush()
        other_token = await mint_run_token(s, other.id, ["write:drafts"], ttl_seconds=600)
        await s.commit()
    async with mcp_client(other_token) as c:
        refused = await c.call_tool("push_draft", {"doc": slug, "markdown": edited})
    assert refused.is_error, text_of(refused)
    assert "its own run's document" in text_of(refused)
    assert await version_count(world.ctx.tenant_id, slug) == 1
    # A run with no document of its own cannot push to a spec either.
    async with tenant_session(world.ctx.tenant_id) as s:
        loose = Run(flow="baseline_to_prd", created_by=owner.id)
        s.add(loose)
        await s.flush()
        loose_token = await mint_run_token(s, loose.id, ["write:drafts"], ttl_seconds=600)
        await s.commit()
    async with mcp_client(loose_token) as c:
        refused = await c.call_tool("push_draft", {"doc": slug, "markdown": edited})
    assert refused.is_error and "its own run's document" in text_of(refused)
    # The spec's own run may (and its edit is checked like anyone's).
    async with tenant_session(world.ctx.tenant_id) as s:
        own_token = await mint_run_token(
            s, uuid.UUID(created["run_id"]), ["write:drafts"], ttl_seconds=600
        )
        await s.commit()
    async with mcp_client(own_token) as c:
        pushed = await c.call_tool("push_draft", {"doc": slug, "markdown": edited})
        assert not pushed.is_error, text_of(pushed)
        reworded = edited.replace("Show shipping cost on the cart**", "Free shipping**")
        refused = await c.call_tool("push_draft", {"doc": slug, "markdown": reworded})
    assert refused.is_error and REFUSED in text_of(refused)


# --------------------------------------------------------------------------- item 3: linked


async def _requirement(world, key: str, status: str, link: str | None = None) -> uuid.UUID:
    """A requirement; ``link``: None, "version" (a link on PRD v1) or "document"."""
    async with tenant_session(world.ctx.tenant_id) as s:
        e = Entity(type="requirement", key=key, title=key, status=status, origin="user")
        s.add(e)
        await s.flush()
        if link is not None:
            s.add(
                DocumentSectionLink(
                    document_id=world.prd_id,
                    version_id=world.prd_v1 if link == "version" else None,
                    section_key="s-5-1",
                    kind="implements",
                    entity_id=e.id,
                )
            )
        await s.commit()
        return e.id


async def test_a_proposed_requirement_the_prd_never_adopted_is_refused(client, runtime):
    world = await make_world(client)
    r9 = await _requirement(world, "R9", "proposed")
    body = await request_spec(
        client, world, status=422, requirement_ids=[str(r9)], section_keys=["s-5-1"]
    )
    assert body["detail"] == "R9 is not in PRD v1"


async def test_a_confirmed_but_unlinked_requirement_is_refused(client, runtime):
    world = await make_world(client)
    r7 = await _requirement(world, "R7", "confirmed")
    body = await request_spec(
        client,
        world,
        status=422,
        requirement_ids=[str(world.shipping), str(r7)],
        section_keys=["s-5-1"],
    )
    assert body["detail"] == "R7 is not in PRD v1"


async def test_a_requirement_linked_to_another_prd_version_is_refused(client, runtime):
    world = await make_world(client)
    r8 = await _requirement(world, "R8", "confirmed")
    # Linked only on PRD v2, not on v1 that the spec is built from.
    v2 = draft("prd_v1.md").replace("wallet payments", "wallet and bank payments")
    assert (await import_md(client, world.ctx.as_("owner"), v2)).status_code == 201
    async with tenant_session(world.ctx.tenant_id) as s:
        v2_id = await s.scalar(
            select(DocumentVersion.id).where(
                DocumentVersion.document_id == world.prd_id, DocumentVersion.number == 2
            )
        )
        s.add(
            DocumentSectionLink(
                document_id=world.prd_id, version_id=v2_id, section_key="s-5-1",
                kind="implements", entity_id=r8,
            )
        )  # fmt: skip
        await s.commit()
    body = await request_spec(
        client, world, status=422, requirement_ids=[str(r8)], section_keys=["s-5-1"], prd_version=1
    )
    assert body["detail"] == "R8 is not in PRD v1"


async def test_linked_requirements_are_accepted(client, runtime):
    world = await make_world(client)
    on_version = await _requirement(world, "R5", "confirmed", link="version")
    on_document = await _requirement(world, "R6", "confirmed", link="document")
    created = await request_spec(
        client, world, requirement_ids=[str(world.shipping), str(on_version), str(on_document)]
    )
    assert len(created["spec"]["request"]["requirement_ids"]) == 3


# --------------------------------------------------------------------------- item 4


async def test_with_no_engineering_approvers_the_requester_approves_their_own_spec(client, runtime):
    world = await make_world(client)
    created = await generated(client, runtime, world, who="approver")
    slug = created["spec"]["document_slug"]
    requester = world.ctx.users["approver"]
    resp = await client.post(
        f"/v1/documents/{slug}/versions/1/approve", headers=world.ctx.as_("approver")
    )
    assert resp.status_code == 200, resp.text
    async with tenant_session(world.ctx.tenant_id) as s:
        av = await s.scalar(
            select(ArtifactVersion).where(
                ArtifactVersion.request_id == uuid.UUID(created["spec"]["request"]["id"])
            )
        )
        assert av.status == "approved" and av.approved_by == requester.id
        event = await s.scalar(
            select(AuditEvent).where(
                AuditEvent.action == "spec.approach_approved", AuditEvent.entity_id == av.id
            )
        )
    assert event is not None
    assert event.data["self_approval"] is True
    assert event.data["engineering_approvers_named"] is False
    assert event.data["requested_by"] == str(requester.id)
    # PRDs allow the same.
    resp = await client.post(
        f"/v1/documents/{PRD}/versions/1/approve", headers=world.ctx.as_("approver")
    )
    assert resp.status_code == 200


# --------------------------------------------------------------------------- minors


async def test_regenerate_changes_nothing_until_its_run_imports(client, runtime):
    world = await make_world(client)
    owner, approver = world.ctx.as_("owner"), world.ctx.as_("approver")
    created = await generated(client, runtime, world)
    request_id = created["spec"]["request"]["id"]
    run = await get_run(client, owner, created["run_id"])
    await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{pending(run)['id']}/decide",
        json={"decision": "approved"},
        headers=owner,
    )
    before = (await get_spec(client, owner, request_id))["request"]
    v2 = draft("prd_v1.md").replace("wallet payments", "wallet and bank payments")
    assert (await import_md(client, owner, v2)).status_code == 201
    await client.post(f"/v1/documents/{PRD}/versions/2/approve", headers=owner)
    # E1: PRD v2 adopts the spec's requirements (a regeneration is refused otherwise).
    await adopt(world, 2)
    resp = await client.post(
        f"/v1/spec-requests/{request_id}/regenerate", json={"reason": "v2"}, headers=approver
    )
    assert resp.status_code == 201, resp.text
    proposal = resp.json()
    after = (await get_spec(client, owner, request_id))["request"]
    for key in ("source_version_id", "section_keys", "status"):
        assert after[key] == before[key], key
    # Cancelled, the proposal leaves the request as it was.
    resp = await client.post(f"/v1/runs/{proposal['run_id']}/cancel", headers=approver)
    assert resp.status_code == 200, resp.text
    assert (await get_spec(client, owner, request_id))["request"]["source_version_id"] == (
        before["source_version_id"]
    )
    # A run that imports moves the request to the PRD version it was built from.
    resp = await client.post(
        f"/v1/spec-requests/{request_id}/regenerate", json={"reason": "v2"}, headers=approver
    )
    assert resp.status_code == 201, resp.text
    runtime.script["spec_draft"] = [
        Outcome(artifacts={"spec.md": spec_md(), "design.json": design_json(world.reqs, SECTIONS)})
    ]
    await start(client, approver, resp.json()["run_id"])
    await tick(client, owner)
    spec = await get_spec(client, owner, request_id)
    assert spec["latest_version"] == 2
    assert spec["request"]["source_version_id"] != before["source_version_id"]
    assert spec["versions"][1]["artifact_version"]["provenance"]["prd_version"] == 2
    # Never back to an older approved version.
    resp = await client.post(
        f"/v1/spec-requests/{request_id}/regenerate", json={"prd_version": 1}, headers=approver
    )
    assert resp.status_code == 422, resp.text
    assert "older" in resp.json()["detail"]


async def test_record_design_does_not_record_the_same_design_twice(client, runtime):
    from oracle.auth.deps import Principal  # noqa: F401
    from oracle.specs import lineage
    from oracle.specs.design import check_design
    from oracle.v2.models import ArtifactRequest

    world = await make_world(client)
    created = await generated(client, runtime, world)
    flow_request_id = created["spec"]["request"]["params"]["design_request_ids"]["user_flow"]
    check = check_design(
        design_json(world.reqs, SECTIONS),
        prd_sections=set(SECTIONS) | {"s-1"},
        requirement_ids=set(world.reqs),
    )
    assert check.flows
    async with tenant_session(world.ctx.tenant_id) as s:
        request = await s.get(ArtifactRequest, uuid.UUID(flow_request_id))
        before = (
            await s.scalars(select(ArtifactVersion).where(ArtifactVersion.request_id == request.id))
        ).all()
        assert len(before) == 1
        av = await lineage.record_design(
            s,
            None,
            request,
            check.flows,
            source_version_id=world.prd_v1,
            provenance={"run_id": created["run_id"]},
            prd_version_id=world.prd_v1,
        )
        await s.commit()
        assert av.id == before[0].id
        rows = (
            await s.scalars(select(ArtifactVersion).where(ArtifactVersion.request_id == request.id))
        ).all()
        assert len(rows) == 1 and rows[0].status != "superseded"
