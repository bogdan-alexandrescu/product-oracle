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
from oracle.db import Base
from oracle.docs.models import Document, DocumentVersion
from oracle.models import AuditEvent
from oracle.review.models import DocumentReviewPolicy, Notification
from oracle.roadmap.models import ScheduleBasis
from oracle.runs.models import Checkpoint, Run
from oracle.runtokens import mint_run_token
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from oracle.tenancy import tenant_session
from oracle.trash import filter as trash_filter
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


async def _member(tenant_id: uuid.UUID, role: str) -> tuple[uuid.UUID, dict[str, str]]:
    async with tenant_session(tenant_id) as s:
        user = await create_user(s, f"{role}-{uuid.uuid4().hex[:6]}@example.com", "pw")
        user.role = role
        await s.commit()
    cookie = f"{get_settings().session_cookie_name}={make_session_cookie(user)}"
    return user.id, {"Cookie": cookie}


async def _reads(client, headers) -> dict[str, str]:
    """What the Inbox, Home, Plan, notifications and spec requests read, as JSON text."""
    paths = {
        "inbox": "/v1/inbox",
        "home documents": "/v1/documents?kind=prd",
        "home runs": "/v1/runs",
        "plan": "/v1/plan",
        "plan dates": "/v1/schedule-bases",
        "plan tracks": "/v1/tracks",
        "notifications": "/v1/me/notifications",
        "spec requests": "/v1/spec-requests",
    }
    out = {}
    for name, path in paths.items():
        resp = await client.get(path, headers=headers)
        assert resp.status_code == 200, (name, resp.text)
        out[name] = resp.text
    return out


async def test_rows_pointing_at_a_trashed_document_leave_every_read(client, owner, runtime):
    tenant_id, auth, run = await _world(client, owner, runtime)
    user_id, me = await _member(tenant_id, "owner")
    async with tenant_session(tenant_id) as s:
        prd = await s.scalar(select(Document).where(Document.slug == PRD))
        prd_id = prd.id
        s.add(
            Notification(
                user_id=user_id, kind="comment", title="A comment", document_id=prd_id,
                actor="system",
            )
        )  # fmt: skip
        s.add(
            ScheduleBasis(
                kind="estimate", reference="ENG-977", supports_date=datetime(2026, 12, 1).date(),
                prd_document_id=prd_id, status="proposed",
            )
        )  # fmt: skip
        await s.commit()
    before = await _reads(client, me)
    assert str(prd_id) in before["notifications"]
    assert "ENG-412" in before["plan dates"] and "ENG-977" in before["inbox"]
    assert PRD in before["home documents"] and run["id"] in before["home runs"]

    resp = await client.request("DELETE", f"/v1/documents/{PRD}", headers=auth)
    assert resp.status_code == 200, resp.text
    after = await _reads(client, me)
    for name, text in after.items():
        for gone in (PRD, ROADMAP, SPEC, str(prd_id), run["id"], "ENG-412", "ENG-977"):
            assert gone not in text, (name, gone, text)

    back = await client.post(f"/v1/documents/{PRD}/restore", headers=auth)
    assert back.status_code == 200, back.text
    again = await _reads(client, me)
    assert str(prd_id) in again["notifications"] and "ENG-977" in again["inbox"]


async def test_deleting_a_single_dependent_leaves_its_prd(client, owner, runtime):
    tenant_id, auth, run = await _world(client, owner, runtime)
    resp = await client.request("DELETE", f"/v1/documents/{ROADMAP}", headers=auth)
    assert resp.status_code == 200, resp.text
    entry = resp.json()
    assert entry["root"]["slug"] == ROADMAP
    assert run["id"] in {i["id"] for i in entry["items"] if i["type"] == "run"}
    assert not [i for i in entry["items"] if i["type"] == "document"]
    slugs = await _slugs(client, auth)
    assert {PRD, SPEC} <= slugs and ROADMAP not in slugs
    assert (await client.get(f"/v1/documents/{PRD}", headers=auth)).status_code == 200
    plan = await client.get("/v1/plan", headers=auth)
    assert ROADMAP not in plan.text
    back = await client.post(f"/v1/trash/{entry['id']}/restore", headers=auth)
    assert back.status_code == 200, back.text
    assert ROADMAP in await _slugs(client, auth)


# Mapped columns pointing at documents that the trash filter does not follow, each with
# the reason a row stays visible while that document is in Trash.
DOCUMENT_LINKS_EXEMPT = {
    ("Run", "document_id"): "a document's runs go to Trash with it (their own deleted_at)",
    ("ProductIntake", "document_id"): "a brief outlives the PRD it became; deleting the "
    "brief takes the PRD, not the other way round",
    ("ProductRequest", "document_id"): "a request is its requester's: it outlives the PRD "
    "it fed (SET NULL on purge)",
    ("ProductTrack", "roadmap_document_id"): "a track is its PRD's (prd_document_id); its "
    "roadmap link is cleared on purge",
    ("RoadmapItem", "prd_document_id"): "an item is its roadmap's (roadmap_document_id); "
    "its PRD link is cleared on purge",
}


def test_every_document_link_is_filtered_or_exempt():
    """Every mapped column that points at documents (a foreign key, or a document_id
    column) is followed by the trash filter or exempt above with its reason: a new table
    cannot show rows of a trashed document."""
    filtered = {
        (entity.__name__, name)
        for entity, parents in trash_filter._children().items()
        for name, table in parents
        if table.name == "documents"
    }
    unhandled, stale = [], []
    for mapper in Base.registry.mappers:
        for column in mapper.local_table.columns:
            to_documents = any(fk.column.table.name == "documents" for fk in column.foreign_keys)
            if not to_documents and column.name != "document_id":
                continue
            key = (mapper.class_.__name__, column.name)
            if key not in filtered and key not in DOCUMENT_LINKS_EXEMPT:
                unhandled.append(key)
    for key in DOCUMENT_LINKS_EXEMPT:
        if key in filtered:
            stale.append(key)
    assert sorted(unhandled) == [] and stale == []
    assert ("Notification", "document_id") in filtered


def test_oracle_action_is_in_the_model_registry():
    import oracle.models as registry

    assert registry.OracleAction.__tablename__ == "oracle_actions"
    assert "OracleAction" in registry.__all__


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
    # The note reaches the agents: every step of the regenerate run carries it.
    steps = [step for spec in runtime.submitted for step in spec.steps]
    regen = [st for st in steps if run["id"] in st.prompt]
    assert regen and all("Shipping first this time" in st.prompt for st in regen)
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


async def test_the_documents_decider_regenerates_whatever_their_role(client, owner, runtime):
    tenant_id, auth = owner
    await approved_prd(client, auth)
    decider_id, decider = await _member(tenant_id, "commenter")
    _, other = await _member(tenant_id, "commenter")
    async with tenant_session(tenant_id) as s:
        prd = await s.scalar(select(Document).where(Document.slug == PRD))
        s.add(DocumentReviewPolicy(document_id=prd.id, decider_id=decider_id))
        await s.commit()
    resp = await client.post(f"/v1/documents/{PRD}/regenerate/estimate", json={}, headers=other)
    assert resp.status_code == 403, resp.text
    resp = await client.post(f"/v1/documents/{PRD}/regenerate/estimate", json={}, headers=decider)
    assert resp.status_code == 200, resp.text
    started = await client.post(
        f"/v1/documents/{PRD}/regenerate", json={"run_id": resp.json()["run_id"]}, headers=other
    )
    assert started.status_code == 403, started.text


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
