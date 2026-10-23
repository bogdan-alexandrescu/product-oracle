"""E1 Roadmap per PRD draft: every PRD version queues an items-only derivation (the
prd_draft_items flow), the tick starts one per PRD (latest draft wins), the run stores
its items with the check's problems, and the Roadmap tab's routes read and derive them.
Against Postgres with the FakeRuntime."""

import uuid

import pytest
from sqlalchemy import select

from oracle import changes
from oracle.auth.models import User
from oracle.docs.models import Document, DocumentVersion
from oracle.mcp.scopes import required_scope
from oracle.roadmap import schedule
from oracle.roadmap.models import DraftRoadmap, RoadmapItem
from oracle.runs import flows
from oracle.runs.models import Checkpoint, Run
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from oracle.tenancy import tenant_session
from tests.fixtures import draft, import_draft, seed_auth
from tests.test_mcp import user_with_role
from tests.test_roadmap import ITEMS, built_roadmap, verified_estimate

PRD = "checkout-redesign"
ITEMS_PATH = "/v1/documents/{doc}/versions/{n}/roadmap-items"
SETTINGS = f"/v1/documents/{PRD}/roadmap-items/settings"


def items_file(version: int, body: str = ITEMS) -> str:
    return body.replace("version: 1}", f"version: {version}}}")


@pytest.fixture(autouse=True)
def derivations_start(monkeypatch):
    from oracle.config import get_settings

    monkeypatch.setattr(get_settings(), "draft_roadmaps_start", True)


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


@pytest.fixture
async def owner():
    return await seed_auth()


async def person(tenant_id: uuid.UUID, role: str) -> tuple[User, dict[str, str]]:
    from oracle.auth.service import make_session_cookie
    from oracle.config import get_settings

    user = await user_with_role(tenant_id, role, email=f"{role}-{uuid.uuid4().hex[:6]}@example.com")
    cookie = f"{get_settings().session_cookie_name}={make_session_cookie(user)}"
    return user, {"Cookie": cookie}


async def new_version(client, headers, n: int) -> None:
    text = draft("prd_v1.md")
    if n > 1:
        text = text.replace("Checkout redesign PRD", f"Checkout redesign PRD (v{n})")
    resp = await import_draft(client, headers, text)
    assert resp.status_code == 201, resp.text
    assert resp.json()["number"] == n


async def rows(tenant_id: uuid.UUID) -> dict[int, DraftRoadmap]:
    async with tenant_session(tenant_id) as s:
        found = (
            await s.execute(
                select(DocumentVersion.number, DraftRoadmap).join(
                    DocumentVersion, DocumentVersion.id == DraftRoadmap.prd_version_id
                )
            )
        ).all()
    return {n: r for n, r in found}


async def tick(client, headers):
    resp = await client.post("/v1/internal/tick", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def read(client, headers, n: int, status: int = 200) -> dict:
    resp = await client.get(ITEMS_PATH.format(doc=PRD, n=n), headers=headers)
    assert resp.status_code == status, resp.text
    return resp.json()


async def draft_runs(tenant_id: uuid.UUID) -> list[Run]:
    async with tenant_session(tenant_id) as s:
        return list(
            await s.scalars(
                select(Run).where(Run.flow == "prd_draft_items").order_by(Run.created_at)
            )
        )


async def test_a_new_prd_version_queues_its_items_in_the_import(client, owner, runtime):
    """protects: criterion 1, every imported PRD version queues its derivation for the
    importer; fails_when: no row, another status, or another requester; no_claim: the
    run itself (next tests)."""
    tenant_id, auth = owner
    pm, headers = await person(tenant_id, "approver")
    await new_version(client, headers, 1)
    found = await rows(tenant_id)
    assert found[1].status == "queued" and found[1].requested_by == pm.id
    assert found[1].requested_via == "new_draft"
    body = await read(client, headers, 1)
    assert body["status"] == "queued" and body["items"] == [] and body["auto"] is True
    assert body["prd"]["slug"] == PRD and body["prd"]["version"] == 1
    version = (await client.get(f"/v1/documents/{PRD}/versions/1", headers=headers)).json()
    assert version["draft_roadmap"] == {"status": "queued", "items": 0, "problems": 0}


async def test_a_failing_handler_never_fails_the_import(client, owner, runtime, monkeypatch):
    """protects: criterion 2, the derivation is best effort; fails_when: the import
    fails or a row is left; no_claim: the log line."""
    from oracle.roadmap import draft_items

    async def broken(db, document, version, event):
        raise RuntimeError("forced")

    monkeypatch.setattr(draft_items, "_queue", broken)
    tenant_id, auth = owner
    await new_version(client, auth, 1)
    assert await rows(tenant_id) == {}
    assert any(r.name == "roadmap.draft_items" for r in changes._handlers)


async def test_the_tick_starts_one_run_and_stores_its_items(client, owner, runtime):
    """protects: criteria 3 and 4, the tick starts a $5.50 standard run for the importer
    with the checkpoint off, and its file is stored as the draft's items; fails_when: no
    run, another cost or creator, a checkpoint that waits, or items on a roadmap version;
    no_claim: agent output quality (the fake runtime scripts the file)."""
    tenant_id, auth = owner
    pm, headers = await person(tenant_id, "approver")
    await new_version(client, headers, 1)
    await verified_estimate(client, headers)
    runtime.script["roadmap_items"] = [Outcome(artifacts={"roadmap_items.yaml": items_file(1)})]
    await tick(client, auth)
    (run,) = await draft_runs(tenant_id)
    assert run.estimate_usd == pytest.approx(5.50) and run.created_by == pm.id
    assert run.knobs["checkpoints"] == {"roadmap_items": False}
    assert run.knobs["draft_roadmap_id"] == str((await rows(tenant_id))[1].id)
    row = (await rows(tenant_id))[1]
    assert row.status in ("running", "ready") and row.run_id == run.id
    await tick(client, auth)
    row = (await rows(tenant_id))[1]
    assert row.status == "ready" and row.items_check["items"] == 2
    async with tenant_session(tenant_id) as s:
        items = list(await s.scalars(select(RoadmapItem).order_by(RoadmapItem.position)))
        v1 = await s.scalar(select(DocumentVersion.id).where(DocumentVersion.number == 1))
        cps = list(await s.scalars(select(Checkpoint).where(Checkpoint.run_id == run.id)))
        run = await s.get(Run, run.id)
    assert [i.item_key for i in items] == ["payment-step", "shipping-step"]
    assert all(i.draft_roadmap_id == row.id and i.roadmap_version_id is None for i in items)
    assert all(i.prd_version_id == v1 and i.track_id is None for i in items)
    assert [(c.kind, c.status) for c in cps] == [("roadmap_items", "skipped")]
    assert run.status == "succeeded"
    body = await read(client, headers, 1)
    assert body["status"] == "ready" and body["run_id"] == str(run.id)
    assert [i["item_key"] for i in body["items"]] == ["payment-step", "shipping-step"]
    assert body["items"][0]["milestone"]["date"] == "2026-11-30"
    assert body["check"]["by_horizon"]["now"] == 1


async def test_items_with_problems_are_stored_and_the_run_succeeds(client, owner, runtime):
    """protects: criterion 5 (card stores-with-problems), a per-item problem never drops
    items or fails the run; fails_when: the run fails or an item is missing, or a refused
    date shows as a date; no_claim: the problems' wording."""
    tenant_id, auth = owner
    await new_version(client, auth, 1)
    bad = items_file(1).replace("depends_on: [payment-step]", "depends_on: [nowhere]")
    runtime.script["roadmap_items"] = [Outcome(artifacts={"roadmap_items.yaml": bad})]
    await tick(client, auth)
    await tick(client, auth)
    body = await read(client, auth, 1)
    assert body["status"] == "ready", body
    assert {p["code"] for p in body["check"]["problems"]} >= {
        "unverified_date",
        "unknown_dependency",
    }
    pay = next(i for i in body["items"] if i["item_key"] == "payment-step")
    assert pay["milestone"].get("date") is None
    assert pay["milestone"]["refused_date"] == "2026-11-30"
    assert pay["milestone"]["refused"] == schedule.UNVERIFIED
    (run,) = await draft_runs(tenant_id)
    assert run.status == "succeeded"
    version = (await client.get(f"/v1/documents/{PRD}/versions/1", headers=auth)).json()
    assert version["draft_roadmap"]["items"] == 2 and version["draft_roadmap"]["problems"] >= 2


@pytest.mark.parametrize(
    "text",
    [
        "version: 1\nprd: {document: checkout-redesign, version: 1}\nitems: []\n",
        "version: 1\nitems: [: nope\n",
        "WRONG",
    ],
    ids=["no-items", "unreadable", "wrong-prd"],
)
async def test_nothing_stored_fails_the_row_and_the_run(client, owner, runtime, text):
    """protects: criterion 6, a file that stores nothing fails; fails_when: the row is
    ready or the run succeeds; no_claim: the exact reasons."""
    tenant_id, auth = owner
    await new_version(client, auth, 1)
    if text == "WRONG":
        text = items_file(1).replace("document: checkout-redesign", "document: another-prd")
    runtime.script["roadmap_items"] = [Outcome(artifacts={"roadmap_items.yaml": text})]
    await tick(client, auth)
    await tick(client, auth)
    body = await read(client, auth, 1)
    assert body["status"] == "failed" and body["error"], body
    assert body["items"] == []
    (run,) = await draft_runs(tenant_id)
    assert run.status == "failed"


async def test_one_at_a_time_latest_draft_wins(client, owner, runtime):
    """protects: criterion 7 (card one-at-a-time); fails_when: two runs start, or an
    older draft starts before a newer one, or a person's Derive is superseded; no_claim:
    SwarmCloud's own concurrency."""
    tenant_id, auth = owner
    await new_version(client, auth, 1)
    await new_version(client, auth, 2)
    found = await rows(tenant_id)
    assert found[1].status == "superseded" and found[2].status == "queued"
    sup = await read(client, auth, 1)
    assert sup["status"] == "superseded"
    # A long segment: v2 stays running while v3 is imported.
    runtime.script["roadmap_items"] = [
        Outcome(polls=3, artifacts={"roadmap_items.yaml": items_file(2)}),
        Outcome(artifacts={"roadmap_items.yaml": items_file(4)}),
        Outcome(artifacts={"roadmap_items.yaml": items_file(1)}),
    ]
    await tick(client, auth)
    assert (await rows(tenant_id))[2].status == "running"
    await new_version(client, auth, 3)
    await tick(client, auth)
    found = await rows(tenant_id)
    assert found[2].status == "running" and found[3].status == "queued"
    assert len(await draft_runs(tenant_id)) == 1
    # A person's Derive on v1 waits its turn; v4 queued after it still starts first.
    resp = await client.post(ITEMS_PATH.format(doc=PRD, n=1) + "/derive", json={}, headers=auth)
    assert resp.status_code == 202, resp.text
    await new_version(client, auth, 4)
    found = await rows(tenant_id)
    assert found[3].status == "superseded" and found[1].status == "queued"
    for _ in range(12):
        await tick(client, auth)
    found = await rows(tenant_id)
    assert found[2].status == "ready" and found[4].status == "ready"
    assert found[1].status == "ready"
    order = [r.knobs["source_version_id"] for r in await draft_runs(tenant_id)]
    assert order == [str(found[n].prd_version_id) for n in (2, 4, 1)]


async def test_skeleton_and_switch_off_then_derive(client, owner, runtime):
    """protects: criteria 8 and 9 (settings), a template's empty skeleton costs nothing
    and the owner's switch stops new drafts; a Derive queues either; fails_when: a
    skeleton or a switched-off PRD queues a run; no_claim: the tab's copy."""
    tenant_id, auth = owner
    resp = await client.post(
        "/v1/drafts",
        json={"kind": "prd", "title": "Loyalty points", "template": "oracle-default"},
        headers=auth,
    )
    assert resp.status_code == 201, resp.text
    slug = resp.json()["slug"]
    body = await read_doc(client, auth, slug, 1)
    assert body["status"] == "skipped"
    await new_version(client, auth, 1)
    _, approver = await person(tenant_id, "approver")
    off = {"each_draft": False}
    assert (await client.put(SETTINGS, json=off, headers=approver)).status_code == 403
    resp = await client.put(SETTINGS, json=off, headers=auth)
    assert resp.status_code == 200 and resp.json() == off
    assert (await client.get(SETTINGS, headers=approver)).json() == off
    await new_version(client, auth, 2)
    assert (await read(client, auth, 2))["status"] == "off"
    for doc, n in ((PRD, 2), (slug, 1)):
        resp = await client.post(ITEMS_PATH.format(doc=doc, n=n) + "/derive", headers=approver)
        assert resp.status_code == 202, resp.text
        assert resp.json()["status"] == "queued"


async def read_doc(client, headers, doc: str, n: int) -> dict:
    resp = await client.get(ITEMS_PATH.format(doc=doc, n=n), headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_derive_roles_and_refusals(client, owner, runtime):
    """protects: criterion 9, only approvers and owners derive, never twice at once, and
    never on a roadmap; fails_when: a commenter or viewer derives, a second derive is
    accepted, or a roadmap gets a derivation; no_claim: the web buttons (Playwright)."""
    tenant_id, auth = owner
    await new_version(client, auth, 1)
    path = ITEMS_PATH.format(doc=PRD, n=1) + "/derive"
    for role in ("viewer", "commenter"):
        _, headers = await person(tenant_id, role)
        assert (await client.post(path, headers=headers)).status_code == 403
        assert (await read(client, headers, 1))["status"] == "queued"
    _, approver = await person(tenant_id, "approver")
    resp = await client.post(path, headers=approver)
    assert resp.status_code == 409 and "already being derived" in resp.text
    runtime.script["roadmap_items"] = [Outcome(artifacts={"roadmap_items.yaml": items_file(1)})]
    await verified_estimate(client, auth)
    await tick(client, auth)
    await tick(client, auth)
    assert (await read(client, auth, 1))["status"] == "ready"
    resp = await client.post(path, json={"depth": "quick"}, headers=approver)
    assert resp.status_code == 202, resp.text
    # The current items stay shown until the new ones are stored.
    assert resp.json()["status"] == "queued" and len(resp.json()["items"]) == 2
    roadmap = await built_roadmap_doc(client, auth, runtime)
    resp = await client.post(ITEMS_PATH.format(doc=roadmap, n=1) + "/derive", headers=approver)
    assert resp.status_code == 422
    assert (
        await client.get(ITEMS_PATH.format(doc=roadmap, n=1), headers=approver)
    ).status_code == 422
    assert (await client.get(ITEMS_PATH.format(doc=PRD, n=9), headers=approver)).status_code == 404


async def built_roadmap_doc(client, auth, runtime) -> str:
    resp = await client.post(f"/v1/documents/{PRD}/versions/1/approve", headers=auth)
    assert resp.status_code == 200, resp.text
    run = await built_roadmap(client, auth, runtime)
    return run["document_slug"] or "checkout-redesign-roadmap"


async def test_a_demoted_requester_fails_the_row_and_starts_nothing(client, owner, runtime):
    """protects: criterion 10, a derivation runs only for someone who may still start
    runs; fails_when: a run is created for a commenter; no_claim: disabled members (the
    same check)."""
    tenant_id, auth = owner
    pm, headers = await person(tenant_id, "approver")
    await new_version(client, headers, 1)
    async with tenant_session(tenant_id) as s:
        (await s.get(User, pm.id)).role = "commenter"
        await s.commit()
    await tick(client, auth)
    row = (await rows(tenant_id))[1]
    assert row.status == "failed" and "can no longer start runs" in row.error
    assert await draft_runs(tenant_id) == []


async def test_the_prompt_names_the_draft_and_the_known_items(client, owner, runtime):
    """protects: criterion 11, the agents read a draft (not an approved PRD) and keep
    the known items' ids; fails_when: the prompt says approved PRD or lists no known
    items; no_claim: the agents keeping the ids."""
    tenant_id, auth = owner
    await new_version(client, auth, 1)
    runtime.script["roadmap_items"] = [
        Outcome(artifacts={"roadmap_items.yaml": items_file(1)}),
        Outcome(artifacts={"roadmap_items.yaml": items_file(2)}),
    ]
    await tick(client, auth)
    await tick(client, auth)
    await new_version(client, auth, 2)
    await tick(client, auth)
    prompt = runtime.submitted[-1].steps[-1].prompt
    assert "PRD draft" in prompt and "version 2" in prompt and "Known items" in prompt
    assert "approved PRD" not in prompt
    assert "- payment-step: Payment step (now)" in prompt
    assert "- shipping-step: Shipping step (next)" in prompt


async def test_draft_items_never_go_stale(client, owner, runtime):
    """protects: criterion 12 (card draft-items-never-stale); fails_when: a new PRD
    version marks draft items stale, or no longer marks a roadmap version's items;
    no_claim: staleness messages' wording."""
    tenant_id, auth = owner
    await new_version(client, auth, 1)
    await verified_estimate(client, auth)
    runtime.script["roadmap_items"] = [Outcome(artifacts={"roadmap_items.yaml": items_file(1)})]
    await tick(client, auth)
    await tick(client, auth)
    await built_roadmap_doc(client, auth, runtime)
    v3 = draft("prd_v1.md").replace("Checkout redesign PRD", "Checkout redesign PRD (v2)")
    v3 = v3.replace("### 5.1 Payment step {#s-5-1}\n", "### 5.1 Payment step {#s-5-1}\n\nNew.\n")
    assert (await import_draft(client, auth, v3)).status_code == 201
    async with tenant_session(tenant_id) as s:
        items = list(await s.scalars(select(RoadmapItem)))
    drafts = [i for i in items if i.draft_roadmap_id is not None]
    roadmap = [i for i in items if i.roadmap_version_id is not None]
    assert drafts and all(i.freshness == "fresh" for i in drafts)
    assert roadmap and any(i.freshness == "potentially_stale" for i in roadmap)


async def test_prd_to_roadmap_still_refuses_an_unapproved_version(client, owner, runtime):
    """protects: criterion 13, the approved-only rule of Build roadmap; fails_when: a
    roadmap run reads a draft; no_claim: the new flow (accepts any version)."""
    _, auth = owner
    await new_version(client, auth, 1)
    resp = await client.post(
        "/v1/runs",
        json={"flow": "prd_to_roadmap", "source": PRD, "source_version": 1},
        headers=auth,
    )
    assert resp.status_code == 422 and "is not approved" in resp.json()["detail"]
    resp = await client.post(
        "/v1/runs",
        json={"flow": "prd_draft_items", "source": PRD, "source_version": 1},
        headers=auth,
    )
    assert resp.status_code == 201, resp.text
    flow = next(
        f
        for f in (await client.get("/v1/flows", headers=auth)).json()["flows"]
        if f["key"] == "prd_draft_items"
    )
    assert flow["source_kind"] == "prd" and flow["target_kind"] is None
    assert [s["checkpoint"] for s in flow["segments"]] == ["roadmap_items"]
    assert flow["in_new_run_dialog"] is False


async def test_run_tokens_read_draft_items_and_nothing_else(client, owner, runtime):
    """protects: criterion 14, a run token with read:documents reads the items and never
    derives or switches; fails_when: either write is reachable with a run scope;
    no_claim: people's API tokens."""
    path = "/v1/documents/{doc}/versions/{n}/roadmap-items"
    assert required_scope("GET", path) == "read:documents"
    assert required_scope("POST", path + "/derive") is None
    assert required_scope("PUT", "/v1/documents/{doc}/roadmap-items/settings") is None
    assert required_scope("GET", "/v1/documents/{doc}/roadmap-items/settings") == ("read:documents")


def test_item_fields_are_shared_by_both_tasks_and_the_lines_say_draft():
    """protects: the two items tasks cannot drift, and a draft's source lines say draft;
    fails_when: a task loses the field list or the lines say approved PRD; no_claim: the
    whole prompt (the integration test above)."""
    roadmap = flows.FLOWS["prd_to_roadmap"].segment("roadmap_items")
    drafts = flows.FLOWS["prd_draft_items"].segment("roadmap_items")
    assert flows.ITEM_FIELDS in roadmap.task and flows.ITEM_FIELDS in drafts.task
    src = flows.SourceContext(
        slug=PRD, title="Checkout", version=2, markdown="", approved=False,
        known_items=[{"id": "a", "title": "A", "horizon": "now"}], known_from="draft v1",
    )  # fmt: skip
    text = "\n".join(flows.source_lines(src))
    assert "PRD draft 'Checkout' (checkout-redesign), version 2, not approved" in text
    assert "approved PRD" not in text and "- a: A (now)" in text
    approved = flows.SourceContext(slug=PRD, title="Checkout", version=2, markdown="")
    assert "approved PRD 'Checkout'" in "\n".join(flows.source_lines(approved))
    assert flows.FLOWS["prd_draft_items"].source_approved is False


async def test_documents_keep_their_switch(client, owner, runtime):
    """protects: the switch is per PRD and defaults on; fails_when: a new PRD starts
    off; no_claim: roadmap documents (no switch)."""
    tenant_id, auth = owner
    await new_version(client, auth, 1)
    assert (await client.get(SETTINGS, headers=auth)).json() == {"each_draft": True}
    async with tenant_session(tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == PRD))
        assert doc.draft_roadmap_auto is True
