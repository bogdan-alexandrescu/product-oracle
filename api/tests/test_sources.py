"""Lane B1: owned sources, the sync engine, uploads, snapshots, confidence and search."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select

from oracle.auth.service import create_api_token
from oracle.connections.models import Connection
from oracle.sources import base, service
from oracle.sources.base import SCOPE_KEY, ConnectorAuthError, ConnectorRateLimited, ItemDelete
from oracle.sources.items import items_as_of
from oracle.sources.models import Source, SourceItem, SourceItemVersion
from oracle.tenancy import tenant_session
from oracle.tenant_settings import TenantSetting
from tests.sources_helpers import (
    SECRET_TOKEN,
    FakeConnector,
    client_for,
    make_connection,
    make_user,
    message,
)


def position(cursor: dict | None) -> dict | None:
    """A saved cursor without the engine's fingerprint of the selection."""
    return {k: v for k, v in (cursor or {}).items() if k != SCOPE_KEY}


@pytest.fixture
def slack(monkeypatch):
    # Load the real connectors first so they cannot clash with the fakes afterwards.
    service.load_connectors()
    fake = FakeConnector(kind="slack")
    monkeypatch.setitem(base._registry, "slack", fake)
    return fake


@pytest.fixture
def github(monkeypatch):
    service.load_connectors()
    fake = FakeConnector(kind="github")
    monkeypatch.setitem(base._registry, "github", fake)
    return fake


@pytest.fixture
async def alice(tenant_id):
    return await make_user(tenant_id, "alice@example.com")


@pytest.fixture
async def bob(tenant_id):
    return await make_user(tenant_id, "bob@example.com")


@pytest.fixture
async def a(alice):
    async with client_for(alice) as c:
        yield c


@pytest.fixture
async def b(bob):
    async with client_for(bob) as c:
        yield c


async def _slack_source(a, tenant_id, alice, name="Product chat", config=None):
    conn = await make_connection(tenant_id, alice, "slack")
    resp = await a.post(
        "/v1/sources",
        json={
            "kind": "slack",
            "name": name,
            "connection_id": str(conn),
            "config": config or {"channels": ["C1"]},
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _sync(client, source_id):
    resp = await client.post(f"/v1/sources/{source_id}/sync")
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _versions(tenant_id) -> list[SourceItemVersion]:
    async with tenant_session(tenant_id) as s:
        rows = await s.scalars(select(SourceItemVersion).order_by(SourceItemVersion.fetched_at))
        return list(rows)


# --- registry ---------------------------------------------------------------------


async def test_create_validates_connection_kind_and_connector(
    a, tenant_id, alice, bob, slack, monkeypatch
):
    # Every kind has a connector now (lanes B2a/B2b); drop one to see the refusal.
    monkeypatch.delitem(base._registry, "notion")
    mine = await make_connection(tenant_id, alice, "slack")
    github_conn = await make_connection(tenant_id, alice, "github")
    notion_conn = await make_connection(tenant_id, alice, "notion")
    bobs = await make_connection(tenant_id, bob, "slack")
    revoked = await make_connection(tenant_id, alice, "slack", status="revoked")

    def body(kind, conn, name="S"):
        return {"kind": kind, "name": name, "connection_id": conn and str(conn), "config": {}}

    resp = await a.post("/v1/sources", json=body("slack", bobs))
    assert resp.status_code == 404  # another user's connection does not exist for alice
    resp = await a.post("/v1/sources", json=body("slack", github_conn))
    assert resp.status_code == 422 and "needs a slack connection" in resp.json()["detail"]
    resp = await a.post("/v1/sources", json=body("slack", None))
    assert resp.status_code == 422
    resp = await a.post("/v1/sources", json=body("slack", revoked))
    assert resp.status_code == 422 and "revoked" in resp.json()["detail"]
    resp = await a.post("/v1/sources", json=body("upload", mine))
    assert resp.status_code == 422 and "no connection" in resp.json()["detail"]
    resp = await a.post("/v1/sources", json=body("notion", notion_conn))
    assert resp.status_code == 422
    assert resp.json()["detail"] == "connector not available yet"

    slack.invalid = "allowlist at least one channel"
    resp = await a.post("/v1/sources", json=body("slack", mine))
    assert resp.status_code == 422 and resp.json()["detail"] == "allowlist at least one channel"
    slack.invalid = None

    resp = await a.post("/v1/sources", json=body("slack", mine))
    assert resp.status_code == 201
    src = resp.json()
    assert src["status"] == "active" and src["connector_available"] is True
    # The connector saw the decrypted credential; the response never carries it.
    assert slack.calls[-1]["credential"]["token"] == SECRET_TOKEN
    assert SECRET_TOKEN not in resp.text
    assert (await a.post("/v1/sources", json=body("slack", mine))).status_code == 409

    resp = await a.post("/v1/sources", json=body("upload", None, "Uploads"))
    assert resp.status_code == 201


async def test_kinds_lists_my_connections_only(a, tenant_id, alice, bob, slack, monkeypatch):
    monkeypatch.delitem(base._registry, "notion")
    await make_connection(tenant_id, alice, "slack")
    await make_connection(tenant_id, bob, "slack")
    await make_connection(tenant_id, alice, "google")
    kinds = {k["kind"]: k for k in (await a.get("/v1/sources/kinds")).json()}
    assert len(kinds["slack"]["connections"]) == 1
    assert kinds["slack"]["connector_available"] is True
    assert kinds["google_docs"]["provider"] == "google"
    assert len(kinds["google_docs"]["connections"]) == 1
    assert kinds["upload"]["provider"] is None and kinds["upload"]["connector_available"]
    assert kinds["notion"]["connector_available"] is False


async def test_patch_pause_resume_delete(a, tenant_id, alice, slack):
    src = await _slack_source(a, tenant_id, alice)
    slack.pages = [[message("m1", "hello")]]
    await _sync(a, src["id"])

    resp = await a.patch(f"/v1/sources/{src['id']}", json={"name": "Renamed"})
    assert resp.status_code == 200 and resp.json()["name"] == "Renamed"
    async with tenant_session(tenant_id) as s:
        assert position((await s.get(Source, src["id"])).cursor) == {"page": 1}

    # A new allowlist starts the next sync from the beginning (a connector without
    # rescope_cursor gets no cursor).
    resp = await a.patch(f"/v1/sources/{src['id']}", json={"config": {"channels": ["C2"]}})
    assert resp.status_code == 200 and resp.json()["config"] == {"channels": ["C2"]}
    await _sync(a, src["id"])
    assert slack.calls[-1]["cursor"] is None

    assert (await a.post(f"/v1/sources/{src['id']}/pause")).json()["status"] == "paused"
    resp = await a.post(f"/v1/sources/{src['id']}/sync")
    assert resp.status_code == 409
    assert (await a.post(f"/v1/sources/{src['id']}/resume")).json()["status"] == "active"

    assert (await a.delete(f"/v1/sources/{src['id']}")).status_code == 204
    assert (await a.get(f"/v1/sources/{src['id']}")).status_code == 404
    async with tenant_session(tenant_id) as s:
        assert await s.scalar(select(func.count()).select_from(SourceItem)) == 0


async def test_api_tokens_cannot_own_sources(tenant_id):
    async with tenant_session(tenant_id) as s:
        _, raw = await create_api_token(s, "agent")
        await s.commit()
    async with client_for(headers={"Authorization": f"Bearer {raw}"}) as c:
        resp = await c.get("/v1/sources")
    assert resp.status_code == 403


# --- owner isolation --------------------------------------------------------------


async def test_user_b_sees_nothing_of_a(a, b, tenant_id, alice, bob, slack):
    src = await _slack_source(a, tenant_id, alice)
    slack.pages = [[message("m1", "pricing decision for the onboarding flow")]]
    await _sync(a, src["id"])
    item = (await a.get(f"/v1/sources/{src['id']}/items")).json()[0]
    snap = (await a.post("/v1/snapshots", json={"label": "alice"})).json()

    assert (await b.get("/v1/sources")).json() == []
    sid = src["id"]
    for method, path in [
        ("GET", f"/v1/sources/{sid}"),
        ("PATCH", f"/v1/sources/{sid}"),
        ("DELETE", f"/v1/sources/{sid}"),
        ("POST", f"/v1/sources/{sid}/sync"),
        ("POST", f"/v1/sources/{sid}/pause"),
        ("POST", f"/v1/sources/{sid}/resume"),
        ("GET", f"/v1/sources/{sid}/items"),
        ("GET", f"/v1/source-items/{item['id']}"),
        ("GET", f"/v1/snapshots/{snap['id']}"),
        ("GET", f"/v1/snapshots/{snap['id']}/items"),
    ]:
        kw = {"json": {"name": "x"}} if method == "PATCH" else {}
        resp = await b.request(method, path, **kw)
        assert resp.status_code == 404, (method, path)
    files = {"files": ("notes.md", b"# Notes\npricing", "text/markdown")}
    assert (await b.post(f"/v1/sources/{sid}/uploads", files=files)).status_code == 404

    assert (await b.get("/v1/search", params={"q": "pricing"})).json()["hits"] == []
    assert (await b.get("/v1/snapshots")).json() == []
    bob_snap = (await b.post("/v1/snapshots", json={})).json()
    assert (await b.get(f"/v1/snapshots/{bob_snap['id']}/items")).json() == []
    async with tenant_session(tenant_id) as s:
        assert await items_as_of(s, bob.id, datetime.now(UTC)) == []
        assert len(await items_as_of(s, alice.id, datetime.now(UTC))) == 1

    # Alice still sees hers.
    assert len((await a.get("/v1/search", params={"q": "pricing"})).json()["hits"]) == 1


# --- sync engine ------------------------------------------------------------------


async def test_new_version_only_when_content_changes(a, tenant_id, alice, slack):
    src = await _slack_source(a, tenant_id, alice)
    slack.pages = [[message("m1", "first draft", title="Plan"), message("m2", "other")]]
    result = await _sync(a, src["id"])
    assert result["outcome"] == "completed"
    assert (result["upserted"], result["versions_written"], result["checkpoints"]) == (2, 2, 1)
    assert result["source"]["item_count"] == 2 and result["source"]["last_synced_at"]
    assert slack.calls[-1]["cursor"] is None

    # Same content again (title changed): no new version.
    slack.pages.append([message("m1", "first draft", title="Plan v2")])
    result = await _sync(a, src["id"])
    assert slack.calls[-1]["cursor"] == {"page": 1}
    assert (result["upserted"], result["versions_written"]) == (1, 0)
    assert len(await _versions(tenant_id)) == 2

    # Changed content: a new version with the title copied at that moment.
    slack.pages.append([message("m1", "second draft", title="Plan v3")])
    result = await _sync(a, src["id"])
    assert result["versions_written"] == 1
    versions = [v for v in await _versions(tenant_id) if v.content.endswith("draft")]
    assert [(v.title, v.content) for v in versions] == [
        ("Plan", "first draft"),
        ("Plan v3", "second draft"),
    ]
    item = next(
        i
        for i in (await a.get(f"/v1/sources/{src['id']}/items")).json()
        if i["external_id"] == "m1"
    )
    detail = (await a.get(f"/v1/source-items/{item['id']}")).json()
    assert detail["content"] == "second draft" and detail["version_count"] == 2


async def test_deletes_are_applied(a, tenant_id, alice, slack):
    src = await _slack_source(a, tenant_id, alice)
    slack.pages = [[message("m1", "keep"), message("m2", "remove me")], [ItemDelete("m2")]]
    result = await _sync(a, src["id"])
    assert result["deleted"] == 1 and result["source"]["item_count"] == 1
    listed = (await a.get(f"/v1/sources/{src['id']}/items")).json()
    assert [i["external_id"] for i in listed] == ["m1"]
    everything = (await a.get(f"/v1/sources/{src['id']}/items?include_deleted=true")).json()
    deleted = next(i for i in everything if i["external_id"] == "m2")
    assert deleted["deleted_at"] is not None
    assert (await a.get("/v1/search", params={"q": "remove"})).json()["hits"] == []

    # Deleting an unknown item is a no-op; an upsert brings a deleted item back.
    slack.pages.append([ItemDelete("never-seen"), message("m2", "back again")])
    result = await _sync(a, src["id"])
    assert result["deleted"] == 0 and result["source"]["item_count"] == 2


async def test_interrupted_sync_resumes_from_cursor(a, tenant_id, alice, slack):
    src = await _slack_source(a, tenant_id, alice)
    slack.pages = [
        [message("m1", "page one")],
        [message("m2", "page two"), message("m3", "page two, second")],
    ]
    slack.fail = {1: RuntimeError(f"socket closed while sending {SECRET_TOKEN}")}
    result = await _sync(a, src["id"])
    assert result["outcome"] == "error"
    assert result["source"]["status"] == "error"
    # Unexpected failures are reported by type only: no provider text, no secrets.
    assert result["error"] == "Sync failed unexpectedly (RuntimeError)"
    async with tenant_session(tenant_id) as s:
        source = await s.get(Source, src["id"])
        assert position(source.cursor) == {"page": 1}
        ids = (await s.scalars(select(SourceItem.external_id))).all()
    # Page one was checkpointed; page two's first item was rolled back.
    assert ids == ["m1"]

    slack.fail = {}
    resp = await a.post(f"/v1/sources/{src['id']}/resume")
    assert resp.json()["status"] == "active" and resp.json()["last_error"] is None
    result = await _sync(a, src["id"])
    assert slack.calls[-1]["cursor"] == {"page": 1}
    assert result["outcome"] == "completed" and result["upserted"] == 2
    assert result["source"]["item_count"] == 3


async def test_auth_error_sets_status_error_without_leaking(a, tenant_id, alice, slack):
    src = await _slack_source(a, tenant_id, alice)
    slack.pages = [[message("m1", "x")]]
    slack.fail = {0: ConnectorAuthError(f"token {SECRET_TOKEN} was revoked")}
    result = await _sync(a, src["id"])
    assert result["outcome"] == "error"
    source = (await a.get(f"/v1/sources/{src['id']}")).json()
    assert source["status"] == "error"
    assert source["last_error"] == "The connection was rejected: token *** was revoked"
    assert SECRET_TOKEN not in str(result)
    # The user's connection is marked expired too, so Settings > Connections shows Reconnect.
    async with tenant_session(tenant_id) as s:
        conn = await s.get(Connection, src["connection_id"])
        assert conn.status == "expired"
        assert conn.last_error == "Rejected during a sync: token *** was revoked"


async def test_rate_limit_stops_cleanly_and_keeps_cursor(a, tenant_id, alice, slack):
    src = await _slack_source(a, tenant_id, alice)
    slack.pages = [[message("m1", "one")], [message("m2", "two")], [message("m3", "three")]]
    slack.fail = {1: ConnectorRateLimited(retry_after=30)}
    result = await _sync(a, src["id"])
    assert result["outcome"] == "rate_limited" and result["retry_after"] == 30
    assert result["source"]["status"] == "active"
    assert "resumes" in result["source"]["last_error"]
    async with tenant_session(tenant_id) as s:
        assert position((await s.get(Source, src["id"])).cursor) == {"page": 1}

    slack.fail = {}
    result = await _sync(a, src["id"])
    assert slack.calls[-1]["cursor"] == {"page": 1}
    assert result["outcome"] == "completed" and result["source"]["item_count"] == 3
    assert result["source"]["last_error"] is None


async def test_sync_without_connector_or_for_uploads(a, tenant_id, alice, slack, monkeypatch):
    src = await _slack_source(a, tenant_id, alice)
    monkeypatch.delitem(base._registry, "slack")
    resp = await a.post(f"/v1/sources/{src['id']}/sync")
    assert resp.status_code == 422 and resp.json()["detail"] == "connector not available yet"
    assert (await a.get(f"/v1/sources/{src['id']}")).json()["connector_available"] is False

    up = (await a.post("/v1/sources", json={"kind": "upload", "name": "Files"})).json()
    assert (await a.post(f"/v1/sources/{up['id']}/sync")).status_code == 409


async def test_revoked_connection_marks_source_error(a, tenant_id, alice, slack):
    src = await _slack_source(a, tenant_id, alice)
    async with tenant_session(tenant_id) as s:
        from oracle.connections.models import Connection

        conn = await s.get(Connection, src["connection_id"])
        conn.status = "expired"
        await s.commit()
    result = await _sync(a, src["id"])
    assert result["outcome"] == "error" and "expired" in result["error"]


# --- uploads ----------------------------------------------------------------------


def _pdf(text: str) -> bytes:
    stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET"
    objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
        "/Resources << /Font << /F1 5 0 R >> >> >>",
        f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = "%PDF-1.4\n"
    offsets = []
    for i, obj in enumerate(objects):
        offsets.append(len(out))
        out += f"{i + 1} 0 obj\n{obj}\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n"
    out += "".join(f"{o:010d} 00000 n \n" for o in offsets)
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"
    return out.encode("latin-1")


async def test_uploads_markdown_and_pdf(a, tenant_id):
    up = (await a.post("/v1/sources", json={"kind": "upload", "name": "Files"})).json()
    files = [
        (
            "files",
            (
                "roadmap-notes.md",
                b"# Roadmap notes\nShip the onboarding checklist",
                "text/markdown",
            ),
        ),
        ("files", ("brief.pdf", _pdf("Quarterly planning brief for search"), "application/pdf")),
    ]
    resp = await a.post(f"/v1/sources/{up['id']}/uploads", files=files)
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert [(i["title"], i["kind"]) for i in body["items"]] == [
        ("roadmap-notes.md", "file"),
        ("brief.pdf", "file"),
    ]
    assert body["unchanged"] == []
    assert body["items"][0]["confidence"]["breakdown"]["source"]["value"] == 0.7
    pdf = (await a.get(f"/v1/source-items/{body['items'][1]['id']}")).json()
    assert "Quarterly planning brief" in pdf["content"]

    hits = (await a.get("/v1/search", params={"q": "quarterly planning"})).json()["hits"]
    assert [h["item"]["title"] for h in hits] == ["brief.pdf"]

    # The same file again writes no version; a changed one does.
    again = [
        (
            "files",
            (
                "roadmap-notes.md",
                b"# Roadmap notes\nShip the onboarding checklist",
                "text/markdown",
            ),
        )
    ]
    resp = await a.post(f"/v1/sources/{up['id']}/uploads", files=again)
    assert resp.json()["unchanged"] == ["roadmap-notes.md"]
    changed = [("files", ("roadmap-notes.md", b"# Roadmap notes\nNew plan", "text/markdown"))]
    resp = await a.post(f"/v1/sources/{up['id']}/uploads", files=changed)
    assert resp.json()["unchanged"] == []
    assert len(await _versions(tenant_id)) == 3


async def test_upload_rejections(a, tenant_id, alice, slack):
    up = (await a.post("/v1/sources", json={"kind": "upload", "name": "Files"})).json()
    for name, data in [
        ("deck.pptx", b"binary"),
        ("empty.txt", b"   "),
        ("broken.pdf", b"not a pdf"),
        ("latin.txt", "café".encode("latin-1")),
    ]:
        resp = await a.post(f"/v1/sources/{up['id']}/uploads", files={"files": (name, data)})
        assert resp.status_code == 422, name
        assert name in resp.json()["detail"]
    src = await _slack_source(a, tenant_id, alice)
    resp = await a.post(f"/v1/sources/{src['id']}/uploads", files={"files": ("a.md", b"x")})
    assert resp.status_code == 409
    resp = await a.post(f"/v1/sources/{up['id']}/uploads", files={"files": ("notes.txt", b"plain")})
    assert resp.status_code == 201 and resp.json()["items"][0]["acl"]["format"] == "txt"


# --- snapshots --------------------------------------------------------------------


async def test_snapshot_pins_reads(a, tenant_id, alice, slack):
    src = await _slack_source(a, tenant_id, alice)
    slack.pages = [
        [message("m1", "pricing is flat", title="Pricing v1"), message("m2", "to be deleted")]
    ]
    await _sync(a, src["id"])
    snap = (await a.post("/v1/snapshots", json={"label": "before change"})).json()
    assert snap["label"] == "before change" and snap["created_by"] == str(alice.id)

    slack.pages.append(
        [
            message("m1", "pricing is tiered", title="Pricing v2"),
            message("m3", "brand new item"),
            ItemDelete("m2"),
        ]
    )
    await _sync(a, src["id"])

    pinned = (await a.get(f"/v1/snapshots/{snap['id']}/items")).json()
    assert sorted(i["external_id"] for i in pinned) == ["m1", "m2"]
    m1 = next(i for i in pinned if i["external_id"] == "m1")
    assert m1["title"] == "Pricing v1"

    async with tenant_session(tenant_id) as s:
        rows = await items_as_of(s, alice.id, datetime.fromisoformat(snap["as_of"]))
        assert {r.item.external_id: r.version.content for r in rows} == {
            "m1": "pricing is flat",
            "m2": "to be deleted",
        }
        now_rows = await items_as_of(s, alice.id, datetime.now(UTC))
        assert {r.item.external_id: r.version.content for r in now_rows} == {
            "m1": "pricing is tiered",
            "m3": "brand new item",
        }
        before_anything = await items_as_of(s, alice.id, datetime(2000, 1, 1, tzinfo=UTC))
        assert before_anything == []

    # Search at the snapshot sees the old text; current search the new.
    flat = await a.get("/v1/search", params={"q": "flat", "as_of": snap["as_of"]})
    assert [h["item"]["title"] for h in flat.json()["hits"]] == ["Pricing v1"]
    assert (await a.get("/v1/search", params={"q": "flat"})).json()["hits"] == []
    assert len((await a.get("/v1/search", params={"q": "tiered"})).json()["hits"]) == 1

    listed = (await a.get("/v1/snapshots")).json()
    assert [s["id"] for s in listed] == [snap["id"]]
    assert (await a.get(f"/v1/snapshots/{snap['id']}")).json()["as_of"] == snap["as_of"]
    future = (datetime.now(UTC) + timedelta(days=1)).isoformat()
    assert (await a.post("/v1/snapshots", json={"as_of": future})).status_code == 422


# --- confidence and search --------------------------------------------------------


async def test_item_confidence_breakdown_and_planning_bonus(a, tenant_id, alice, slack):
    src = await _slack_source(a, tenant_id, alice)
    now = datetime.now(UTC)
    slack.pages = [
        [
            message("plain", "chat", occurred_at=now),
            message("plan", "plan", occurred_at=now, acl={"doc_type": "planning"}),
        ]
    ]
    await _sync(a, src["id"])
    listed = {i["external_id"]: i for i in (await a.get(f"/v1/sources/{src['id']}/items")).json()}
    plain = listed["plain"]["confidence"]
    assert set(plain["breakdown"]) == {"source", "freshness", "mentions", "goal_impact"}
    assert plain["breakdown"]["source"] == {"value": 0.5, "weight": 0.35}
    assert plain["breakdown"]["freshness"]["value"] == pytest.approx(1.0, abs=0.01)
    assert listed["plan"]["confidence"]["breakdown"]["source"]["value"] == 0.6
    assert listed["plan"]["confidence"]["value"] > plain["value"]


async def test_search_ranking_honours_confidence(a, tenant_id, alice, slack, github):
    chat = await _slack_source(a, tenant_id, alice)
    conn = await make_connection(tenant_id, alice, "github")
    code = (
        await a.post(
            "/v1/sources",
            json={"kind": "github", "name": "Repo", "connection_id": str(conn), "config": {}},
        )
    ).json()
    now = datetime.now(UTC)
    text = "the checkout flow keeps the shipping estimate visible"
    slack.pages = [
        [message("c1", text, title="Checkout thread", occurred_at=now - timedelta(days=400))]
    ]
    github.pages = [[message("r1", text, title="Checkout thread", kind="readme", occurred_at=now)]]
    await _sync(a, chat["id"])
    await _sync(a, code["id"])

    resp = await a.get("/v1/search", params={"q": "shipping estimate"})
    hits = resp.json()["hits"]
    assert [h["item"]["source_kind"] for h in hits] == ["github", "slack"]
    # Same text, so same relevance; the order comes from confidence.
    assert hits[0]["relevance"] == hits[1]["relevance"]
    assert hits[0]["score"] > hits[1]["score"]
    assert "<mark>shipping</mark>" in hits[0]["snippet"]
    assert hits[0]["item"]["confidence"]["value"] > hits[1]["item"]["confidence"]["value"]

    # The company's confidence_weights setting is what scores them.
    async with tenant_session(tenant_id) as s:
        s.add(
            TenantSetting(
                key="confidence_weights",
                value={
                    "weights": {"source": 1, "freshness": 0, "mentions": 0, "goal_impact": 0},
                    "source": {"slack": 1.0, "github": 0.1, "github:readme": 0.1},
                },
            )
        )
        await s.commit()
    hits = (await a.get("/v1/search", params={"q": "shipping estimate"})).json()["hits"]
    assert [h["item"]["source_kind"] for h in hits] == ["slack", "github"]

    # Filters: item kinds (repeated or comma-separated) and source.
    resp = await a.get("/v1/search", params={"q": "shipping", "kinds": "readme,issue"})
    assert [h["item"]["kind"] for h in resp.json()["hits"]] == ["readme"]
    resp = await a.get("/v1/search", params={"q": "shipping", "source": chat["id"]})
    assert [h["item"]["source_id"] for h in resp.json()["hits"]] == [chat["id"]]
    assert (await a.get("/v1/search", params={"q": "x", "kinds": "nope"})).status_code == 422


async def test_search_relevance_still_counts(a, tenant_id, alice, slack):
    src = await _slack_source(a, tenant_id, alice)
    slack.pages = [
        [
            message("strong", "roadmap roadmap roadmap planning for the roadmap"),
            message("weak", "a long note that mentions the roadmap once among many other words"),
        ]
    ]
    await _sync(a, src["id"])
    hits = (await a.get("/v1/search", params={"q": "roadmap"})).json()["hits"]
    assert [h["item"]["external_id"] for h in hits] == ["strong", "weak"]
    assert (await a.get("/v1/search", params={"q": '"exact phrase" -missing'})).status_code == 200
