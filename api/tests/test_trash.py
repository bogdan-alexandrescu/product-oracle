"""Trash (#482 lane A): delete and restore with dependents, Settings › Trash, the 30-day
purge in the ticker, Regenerate as a new run and a new version, and who may do what."""

import ast
import hashlib
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import func, select

from oracle.auth.deps import RUN_TOKEN_HEADER
from oracle.auth.service import create_user, make_session_cookie
from oracle.config import get_settings
from oracle.docs.models import Document, DocumentVersion
from oracle.models import AuditEvent
from oracle.runs.models import Checkpoint, Run
from oracle.runtokens import mint_run_token
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from oracle.tenancy import tenant_session
from oracle.trash import service as trash_service
from oracle.v2.models import ProductIntake
from tests.fixtures import seed_auth
from tests.test_mcp import api_token, mcp_client
from tests.test_roadmap import (
    ITEMS,
    PRD,
    ROADMAP,
    ROADMAP_MD,
    approved_prd,
    as_user,
    built_roadmap,
    decide,
    get,
    seed_baseline,
    tick,
)

SPEC = "checkout-redesign-tech-brief"
API_DIR = Path(__file__).resolve().parents[1]


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


@pytest.fixture
async def owner():
    return await seed_auth()


async def _spec_from(tenant_id: uuid.UUID, prd_slug: str = PRD) -> uuid.UUID:
    """A tech brief built from the PRD's first version (its provenance, as an import of a
    prd_to_spec run records it)."""
    async with tenant_session(tenant_id) as s:
        prd = await s.scalar(select(Document).where(Document.slug == prd_slug))
        v1 = await s.scalar(
            select(DocumentVersion).where(
                DocumentVersion.document_id == prd.id, DocumentVersion.number == 1
            )
        )
        spec = Document(slug=SPEC, title="Checkout tech brief", kind="spec")
        s.add(spec)
        await s.flush()
        md = "# Checkout tech brief {#title}\n"
        s.add(
            DocumentVersion(
                document_id=spec.id,
                number=1,
                markdown=md,
                content_hash=hashlib.sha256(md.encode()).hexdigest(),
                source_version_id=v1.id,
            )
        )
        await s.commit()
        return spec.id


async def _world(client, owner_, runtime_) -> tuple[uuid.UUID, dict[str, str], dict]:
    tenant_id, auth = owner_
    await seed_baseline(tenant_id)
    await approved_prd(client, auth)
    run = await built_roadmap(client, auth, runtime_)
    await _spec_from(tenant_id)
    return tenant_id, auth, run


async def _slugs(client, headers) -> set[str]:
    resp = await client.get("/v1/documents", headers=headers)
    assert resp.status_code == 200, resp.text
    return {d["slug"] for d in resp.json()}


# --------------------------------------------------------------------------- done when 1


async def test_dependents_resolver_lists_what_goes_along(client, owner, runtime):
    _, auth, run = await _world(client, owner, runtime)
    resp = await client.get(f"/v1/documents/{PRD}/dependents", headers=auth)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["root"]["slug"] == PRD and body["root"]["kind"] == "prd"
    docs = {d["slug"]: d["kind"] for d in body["items"] if d["type"] == "document"}
    assert docs == {ROADMAP: "roadmap", SPEC: "spec"}
    runs = {d["id"] for d in body["items"] if d["type"] == "run"}
    assert run["id"] in runs
    assert body["published"] is False


async def test_delete_a_prd_trashes_its_dependents_and_restore_brings_them_back(
    client, owner, runtime
):
    tenant_id, auth, run = await _world(client, owner, runtime)
    assert {PRD, ROADMAP, SPEC} <= await _slugs(client, auth)

    resp = await client.request(
        "DELETE", f"/v1/documents/{PRD}", headers=auth, params={"reason": "Duplicate"}
    )
    assert resp.status_code == 200, resp.text
    entry = resp.json()
    assert entry["root"]["slug"] == PRD
    assert {i["slug"] for i in entry["items"] if i["type"] == "document"} == {ROADMAP, SPEC}

    # Gone from lists, reads, the Inbox, runs and agent (MCP) reads.
    assert not {PRD, ROADMAP, SPEC} & await _slugs(client, auth)
    for slug in (PRD, ROADMAP, SPEC):
        assert (await client.get(f"/v1/documents/{slug}", headers=auth)).status_code == 404
    assert (await client.get(f"/v1/runs/{run['id']}", headers=auth)).status_code == 404
    assert run["id"] not in {r["id"] for r in (await client.get("/v1/runs", headers=auth)).json()}
    inbox = await client.get("/v1/inbox", headers=auth)
    assert inbox.status_code == 200, inbox.text
    token = await api_token(tenant_id)
    async with mcp_client(token) as c:
        listed = await c.call_tool("list_documents", {})
        assert listed.structured_content["result"] == []

    # Settings › Trash: one entry for all three, who, when and days left.
    trash = await client.get("/v1/trash", headers=auth)
    assert trash.status_code == 200, trash.text
    [row] = trash.json()
    assert row["id"] == entry["id"]
    assert row["root"]["slug"] == PRD and row["reason"] == "Duplicate"
    assert row["deleted_by"] and row["deleted_at"]
    assert row["days_left"] == 30
    assert {i["slug"] for i in row["items"] if i["type"] == "document"} == {ROADMAP, SPEC}

    restored = await client.post(f"/v1/trash/{row['id']}/restore", headers=auth)
    assert restored.status_code == 200, restored.text
    assert {PRD, ROADMAP, SPEC} <= await _slugs(client, auth)
    assert (await client.get(f"/v1/runs/{run['id']}", headers=auth)).status_code == 200
    assert (await client.get("/v1/trash", headers=auth)).json() == []
    async with tenant_session(tenant_id) as s:
        actions = set(await s.scalars(select(AuditEvent.action)))
    assert {"trash.delete", "trash.restore"} <= actions


async def test_inbox_drops_the_checkpoints_of_a_trashed_run(client, owner, runtime):
    tenant_id, auth = owner
    await approved_prd(client, auth)
    async with tenant_session(tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == PRD))
        r = Run(flow="baseline_to_prd", document_id=doc.id, status="awaiting_checkpoint")
        s.add(r)
        await s.flush()
        s.add(Checkpoint(run_id=r.id, kind="prd_review", payload={}))
        await s.commit()
        run_id = r.id
    before = (await client.get("/v1/inbox", headers=auth)).json()
    assert any(c["run_id"] == str(run_id) for c in before["checkpoints"])
    # A run that is still working is refused until it is cancelled.
    refused = await client.request("DELETE", f"/v1/runs/{run_id}", headers=auth)
    assert refused.status_code == 409, refused.text
    async with tenant_session(tenant_id) as s:
        (await s.get(Run, run_id)).status = "cancelled"
        await s.commit()
    resp = await client.request("DELETE", f"/v1/runs/{run_id}", headers=auth)
    assert resp.status_code == 200, resp.text
    after = await client.get("/v1/inbox", headers=auth)
    assert after.status_code == 200, after.text
    assert not any(c["run_id"] == str(run_id) for c in after.json()["checkpoints"])
    back = await client.post(f"/v1/runs/{run_id}/restore", headers=auth)
    assert back.status_code == 200, back.text
    assert (await client.get(f"/v1/runs/{run_id}", headers=auth)).status_code == 200


async def test_delete_and_restore_an_intake(client, owner):
    tenant_id, auth = owner
    async with tenant_session(tenant_id) as s:
        intake = ProductIntake(title="Faster checkout", brief="Buyers abandon at shipping.")
        s.add(intake)
        await s.commit()
        intake_id = intake.id
    listed = await client.get("/v1/intakes", headers=auth)
    assert str(intake_id) in {i["id"] for i in listed.json()}
    resp = await client.request("DELETE", f"/v1/intakes/{intake_id}", headers=auth)
    assert resp.status_code == 200, resp.text
    assert resp.json()["root"]["type"] == "intake"
    listed = await client.get("/v1/intakes", headers=auth)
    assert str(intake_id) not in {i["id"] for i in listed.json()}
    assert (await client.get(f"/v1/intakes/{intake_id}", headers=auth)).status_code == 404
    back = await client.post(f"/v1/intakes/{intake_id}/restore", headers=auth)
    assert back.status_code == 200, back.text
    assert (await client.get(f"/v1/intakes/{intake_id}", headers=auth)).status_code == 200


async def test_a_published_document_needs_a_second_confirmation(client, owner, monkeypatch):
    _, auth = owner
    await approved_prd(client, auth)

    async def published(db, ids):
        return set(ids)

    monkeypatch.setattr(trash_service, "published_ids", published)
    preview = await client.get(f"/v1/documents/{PRD}/dependents", headers=auth)
    assert preview.json()["published"] is True
    resp = await client.request("DELETE", f"/v1/documents/{PRD}", headers=auth)
    assert resp.status_code == 409, resp.text
    assert "external copy" in resp.json()["detail"]
    ok = await client.request(
        "DELETE", f"/v1/documents/{PRD}", headers=auth, params={"confirm_published": True}
    )
    assert ok.status_code == 200, ok.text


# --------------------------------------------------------------------------- roles


async def test_only_owners_delete_restore_and_see_trash(client, owner, runtime):
    tenant_id, auth = owner
    await approved_prd(client, auth)
    for role in ("approver", "commenter", "viewer"):
        headers = await as_user(tenant_id, role)
        resp = await client.request("DELETE", f"/v1/documents/{PRD}", headers=headers)
        assert resp.status_code == 403, (role, resp.text)
        assert (await client.get("/v1/trash", headers=headers)).status_code == 403
    entry = (await client.request("DELETE", f"/v1/documents/{PRD}", headers=auth)).json()
    approver = await as_user(tenant_id, "approver")
    resp = await client.post(f"/v1/trash/{entry['id']}/restore", headers=approver)
    assert resp.status_code == 403
    resp = await client.post(f"/v1/documents/{PRD}/restore", headers=approver)
    assert resp.status_code == 403


# --------------------------------------------------------------------------- done when 3


async def test_regenerate_a_roadmap_estimates_runs_and_imports_the_next_version(
    client, owner, runtime
):
    tenant_id, auth = owner
    await seed_baseline(tenant_id)
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)

    est = await client.post(
        f"/v1/documents/{ROADMAP}/regenerate/estimate",
        json={"note": "Shipping first this time"},
        headers=auth,
    )
    assert est.status_code == 200, est.text
    body = est.json()
    assert body["flow"] == "prd_to_roadmap" and body["kind"] == "roadmap"
    assert body["estimate_usd"] > 0
    assert body["needs_owner_approval"] is False
    assert any(PRD in i for i in body["inputs"])

    runtime.script["roadmap_items"] = [Outcome(artifacts={"roadmap_items.yaml": ITEMS})]
    runtime.script["roadmap_draft"] = [
        Outcome(artifacts={"roadmap.md": ROADMAP_MD.replace("Make checkout", "Now make checkout")})
    ]
    started = await client.post(
        f"/v1/documents/{ROADMAP}/regenerate",
        json={"run_id": body["run_id"], "note": "Shipping first this time"},
        headers=auth,
    )
    assert started.status_code == 200, started.text
    run = started.json()
    assert run["status"] == "running"
    for _ in range(6):
        await tick(client, auth)
        run = await get(client, auth, run["id"])
        if run["status"] != "awaiting_checkpoint":
            continue
        run = await decide(client, auth, run)
    assert run["status"] == "succeeded", run
    versions = (await client.get(f"/v1/documents/{ROADMAP}/versions", headers=auth)).json()
    assert [v["number"] for v in versions] == [1, 2]
    async with tenant_session(tenant_id) as s:
        actions = set(await s.scalars(select(AuditEvent.action)))
    assert "document.regenerate" in actions


async def test_regenerate_roles_and_kinds(client, owner, runtime):
    tenant_id, auth = owner
    await approved_prd(client, auth)
    for role in ("commenter", "viewer"):
        headers = await as_user(tenant_id, role)
        resp = await client.post(
            f"/v1/documents/{PRD}/regenerate/estimate", json={}, headers=headers
        )
        assert resp.status_code == 403, (role, resp.text)
    approver = await as_user(tenant_id, "approver")
    resp = await client.post(f"/v1/documents/{PRD}/regenerate/estimate", json={}, headers=approver)
    assert resp.status_code == 200, resp.text
    assert resp.json()["flow"] == "baseline_to_prd"
    # A run made for another document is not this one's regeneration.
    other = await client.post(
        f"/v1/documents/{PRD}/regenerate", json={"run_id": str(uuid.uuid4())}, headers=approver
    )
    assert other.status_code == 404, other.text


# --------------------------------------------------------------------------- done when 4


async def test_the_ticker_purges_trash_after_30_days(client, owner, monkeypatch):
    tenant_id, auth = owner
    await approved_prd(client, auth)
    resp = await client.request("DELETE", f"/v1/documents/{PRD}", headers=auth)
    assert resp.status_code == 200, resp.text
    start = datetime.now(UTC)

    monkeypatch.setattr(trash_service, "now", lambda: start + timedelta(days=29, hours=23))
    await tick(client, auth)
    async with tenant_session(tenant_id) as s:
        left = await s.scalar(
            select(func.count())
            .select_from(Document)
            .execution_options(**{trash_service.INCLUDE_TRASHED: True})
        )
    assert left == 1
    assert (await client.get("/v1/trash", headers=auth)).json()[0]["days_left"] == 1

    monkeypatch.setattr(trash_service, "now", lambda: start + timedelta(days=30, minutes=1))
    await tick(client, auth)
    async with tenant_session(tenant_id) as s:
        left = await s.scalar(
            select(func.count())
            .select_from(Document)
            .execution_options(**{trash_service.INCLUDE_TRASHED: True})
        )
        actions = set(await s.scalars(select(AuditEvent.action)))
    assert left == 0
    assert "trash.purge" in actions
    assert (await client.get("/v1/trash", headers=auth)).json() == []


# --------------------------------------------------------------------------- done when 5


async def test_run_tokens_never_delete_restore_purge_or_regenerate(client, owner, runtime):
    tenant_id, auth = owner
    await approved_prd(client, auth)
    entry = (await client.request("DELETE", f"/v1/documents/{PRD}", headers=auth)).json()
    # A run's REST calls carry its creator's session and the run token (an owner's run).
    async with tenant_session(tenant_id) as s:
        user = await create_user(s, "run-owner@example.com", "pw")
        user.role = "owner"
        r = Run(flow="baseline_to_prd", created_by=user.id, status="running")
        s.add(r)
        await s.flush()
        raw = await mint_run_token(s, r.id, ["read:documents", "write:drafts"], 600)
        await s.commit()
        run_id = r.id
    cookie = f"{get_settings().session_cookie_name}={make_session_cookie(user)}"
    run_auth = {"Cookie": cookie, RUN_TOKEN_HEADER: raw}
    calls = [
        ("DELETE", f"/v1/documents/{PRD}"),
        ("POST", f"/v1/documents/{PRD}/restore"),
        ("DELETE", f"/v1/intakes/{uuid.uuid4()}"),
        ("POST", f"/v1/intakes/{uuid.uuid4()}/restore"),
        ("DELETE", f"/v1/runs/{run_id}"),
        ("POST", f"/v1/runs/{run_id}/restore"),
        ("GET", "/v1/trash"),
        ("POST", f"/v1/trash/{entry['id']}/restore"),
        ("DELETE", f"/v1/trash/{entry['id']}"),
        ("POST", f"/v1/documents/{PRD}/regenerate/estimate"),
        ("POST", f"/v1/documents/{PRD}/regenerate"),
    ]
    for method, path in calls:
        body = {"run_id": str(run_id)} if path.endswith("regenerate") else None
        if path.endswith("estimate"):
            body = {}
        resp = await client.request(method, path, headers=run_auth, json=body)
        assert resp.status_code == 403, (method, path, resp.status_code, resp.text)


async def test_body_less_writes_refuse_other_origins(client, owner):
    tenant_id, auth = owner
    await approved_prd(client, auth)
    cookie = await as_user(tenant_id, "owner")
    for extra in ({"Origin": "https://evil.example.net"}, {"Sec-Fetch-Site": "cross-site"}):
        headers = {**cookie, **extra}
        resp = await client.request("DELETE", f"/v1/documents/{PRD}", headers=headers)
        assert resp.status_code == 403, resp.text
        assert "Cross-site" in resp.json()["detail"]
    entry = (await client.request("DELETE", f"/v1/documents/{PRD}", headers=cookie)).json()
    for method, path in (
        ("POST", f"/v1/trash/{entry['id']}/restore"),
        ("DELETE", f"/v1/trash/{entry['id']}"),
        ("POST", f"/v1/documents/{PRD}/restore"),
    ):
        resp = await client.request(
            method, path, headers={**cookie, "Origin": "https://evil.example.net"}
        )
        assert resp.status_code == 403, (path, resp.text)
    ok = await client.post(
        f"/v1/trash/{entry['id']}/restore", headers={**cookie, "Origin": "http://test"}
    )
    assert ok.status_code == 200, ok.text


async def test_purge_now_from_trash(client, owner):
    tenant_id, auth = owner
    await approved_prd(client, auth)
    entry = (await client.request("DELETE", f"/v1/documents/{PRD}", headers=auth)).json()
    resp = await client.request("DELETE", f"/v1/trash/{entry['id']}", headers=auth)
    assert resp.status_code == 204, resp.text
    assert (await client.get("/v1/trash", headers=auth)).json() == []
    assert (await client.post(f"/v1/trash/{entry['id']}/restore", headers=auth)).status_code == 404


# --------------------------------------------------------------------------- the scan


TRASHABLE_TABLES = ("documents", "product_intakes", "runs")
TRASHABLE_MODELS = ("Document", "ProductIntake", "Run")
# Reads that reach trashable rows outside the ORM filter, each with its reason.
ALLOWED_CORE = {
    # The visibility rule's subquery over documents (it only narrows what is shown).
    "oracle/docs/visibility.py",
}


def _sources() -> list[Path]:
    return [p for p in (API_DIR / "oracle").rglob("*.py") if "trash" not in p.parts]


def test_no_query_can_leak_a_trashed_row():
    """Every read of documents, intakes and runs goes through the ORM, where the trash
    filter (oracle.trash.filter) applies: no raw SQL naming their tables, no Core reads
    of their ``__table__``, and nothing outside oracle.trash asks for trashed rows."""
    problems = []
    for path in _sources():
        rel = path.relative_to(API_DIR).as_posix()
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "text":
                for arg in node.args:
                    if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                        sql = arg.value.lower()
                        if any(f" {t}" in sql and "from" in sql for t in TRASHABLE_TABLES):
                            problems.append(f"{rel}:{node.lineno} raw SQL on a trashable table")
            if (
                isinstance(node, ast.Attribute)
                and node.attr == "__table__"
                and getattr(node.value, "id", None) in TRASHABLE_MODELS
                and rel not in ALLOWED_CORE
            ):
                problems.append(f"{rel}:{node.lineno} Core read of a trashable table")
            if isinstance(node, ast.Constant) and node.value == trash_service.INCLUDE_TRASHED:
                problems.append(f"{rel}:{node.lineno} reads trashed rows outside oracle.trash")
    assert problems == []


def test_every_router_is_scanned():
    routers = [p for p in _sources() if p.name.endswith("router.py")]
    assert len(routers) > 20
    assert (API_DIR / "oracle/trash/router.py").exists()
