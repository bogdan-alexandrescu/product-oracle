"""replaced-prd-history (the owner, Nov 7): an old PRD replaced by newer PRDs is read-only
history, and so is its own roadmap. A tenant with User Safety and its roadmap, and the older
Trust plan (replaced by User Safety) with its own roadmap, track, item and a draft of that
roadmap sent for approval: Simple shows no working draft, track, Inbox row or count of the
old roadmap; every edit, approve and publish of it is refused in plain words; the old PRD
stays reachable from User Safety ("replaces"). Against Postgres. Invented data.

Test card: protects=a replaced PRD's roadmap never competes with the current roadmap in
Simple and takes no change; fails_when=its draft, track, item or Inbox row shows, or an
approve or a new version of it goes through; no_claim=Trash (restoring keeps working).
"""

import hashlib
from datetime import UTC, date, datetime

import pytest

from oracle import company_time
from oracle.docs.models import Document, DocumentVersion
from oracle.roadmap.models import ProductTrack, RoadmapItem
from oracle.simple.models import SimpleDraft
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx

NOW = datetime(2026, 11, 4, 9, 0, tzinfo=UTC)
APPROVED = datetime(2026, 10, 1, tzinfo=UTC)
OLD_ROADMAP = "trust-plan-roadmap"
NEW_VERSION = "---\ntitle: Trust plan roadmap\n---\n# Trust plan roadmap {#roadmap}\n\nMore.\n"


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


def _hash(body: str) -> str:
    return hashlib.sha256(body.encode()).hexdigest()


async def _add(s, row):
    s.add(row)
    await s.flush()
    return row


async def _doc(s, slug: str, title: str, kind: str, n: int = 1, source=None):
    doc = await _add(s, Document(slug=slug, title=title, kind=kind, status="approved",
                                 visibility="company"))  # fmt: skip
    versions = []
    for i in range(1, n + 1):
        body = f"# {title} {i}"
        versions.append(await _add(s, DocumentVersion(
            document_id=doc.id, number=i, markdown=body, content_hash=_hash(body),
            source_version_id=source.id if source else None,
            approved_at=APPROVED if i == 1 else None)))  # fmt: skip
    return doc, versions


async def _roadmap(s, slug, title, prd, pv, key, item, n: int = 1):
    rm, vs = await _doc(s, slug, title, "roadmap", n, source=pv)
    s.add(RoadmapItem(roadmap_document_id=rm.id, roadmap_version_id=vs[0].id, item_key=key,
                      title=item, horizon="now", position=0, prd_document_id=prd.id,
                      prd_version_id=pv.id, start_date=date(2026, 11, 9),
                      end_date=date(2026, 11, 27), date_source="engineering"))  # fmt: skip
    s.add(ProductTrack(prd_document_id=prd.id, roadmap_document_id=rm.id, title=prd.title,
                       started_version_id=pv.id, current_version_id=pv.id))  # fmt: skip
    return rm, vs


async def world(client, replace: bool = True, old_status: str = "submitted") -> tuple[Ctx, dict]:
    ctx = await make_ctx()
    owner = ctx.users["owner"].id
    async with tenant_session(ctx.tenant_id) as s:
        safety, (sv,) = await _doc(s, "user-safety", "User Safety", "prd")
        trust, (tv,) = await _doc(s, "trust-plan", "Trust plan", "prd")
        new_rm, (nv,) = await _roadmap(s, "user-safety-roadmap", "User Safety roadmap", safety,
                                       sv, "report-button", "Report button")  # fmt: skip
        old_rm, (ov1, ov2) = await _roadmap(s, OLD_ROADMAP, "Trust plan roadmap", trust, tv,
                                            "appeal-flow", "Appeal flow", n=2)  # fmt: skip
        s.add(SimpleDraft(document_id=new_rm.id, base_version_id=nv.id, created_by=owner,
                          participant_ids=[owner]))  # fmt: skip
        submitted = old_status == "submitted"
        old = await _add(s, SimpleDraft(
            document_id=old_rm.id, base_version_id=ov1.id, status=old_status,
            version_id=ov2.id if submitted else None, created_by=owner, participant_ids=[owner],
            submitted_at=NOW if submitted else None, submitted_by=owner if submitted else None,
            waiting_on=[owner] if submitted else []))  # fmt: skip
        await s.commit()
        ids = {"new_rm": str(new_rm.id), "old_rm": str(old_rm.id), "old_draft": str(old.id)}
    if replace:
        await _replace(client, ctx)
    return ctx, ids


async def _replace(client, ctx: Ctx) -> None:
    r = await client.post("/v1/documents/trust-plan/replaced-by", headers=ctx.as_("owner"),
                          json={"prds": ["user-safety"]})  # fmt: skip
    assert r.status_code == 200, r.text


async def _get(client, ctx: Ctx, path: str):
    r = await client.get(path, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    return r.json()


async def test_replaced_prds_roadmap_shows_no_working_draft_in_simple(client):
    ctx, ids = await world(client)
    drafts = await _get(client, ctx, "/v1/simple/drafts")
    assert [d["document"]["id"] for d in drafts] == [ids["new_rm"]]
    out = await _get(client, ctx, "/v1/simple/roadmap")
    assert [d["document_id"] for d in out["drafts"]] == [ids["new_rm"]]
    assert {r["id"] for r in out["roadmaps"]} == {ids["new_rm"]}
    assert {i["key"] for i in out["items"]} == {"report-button"}
    r = await client.get(f"/v1/simple/roadmap?roadmap={OLD_ROADMAP}", headers=ctx.as_("owner"))
    assert r.status_code == 404, r.text


async def test_replaced_prds_tracks_are_not_in_tracks(client):
    ctx, _ = await world(client)
    tracks = await _get(client, ctx, "/v1/simple/tracks")
    assert [t["title"] for t in tracks["tracks"]] == ["User Safety"]


async def test_replaced_prds_roadmap_makes_no_inbox_row_or_count(client):
    ctx, ids = await world(client, replace=False)
    before = await _get(client, ctx, "/v1/inbox")
    assert ids["old_draft"] in {str(a["draft_id"]) for a in before["simple_approvals"]}
    await _replace(client, ctx)
    after = await _get(client, ctx, "/v1/inbox")
    assert ids["old_draft"] not in {str(a["draft_id"]) for a in after["simple_approvals"]}
    assert after["needs_me"] == before["needs_me"] - 1
    assert after["total"] == before["total"] - 1


@pytest.mark.parametrize("status", ["submitted", "working"])
async def test_replaced_prds_roadmap_refuses_approve_and_publish(client, status):
    ctx, ids = await world(client, old_status=status)
    r = await client.post(f"/v1/simple/drafts/{ids['old_draft']}/approve",
                          headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 409, r.text
    assert "Trust plan roadmap is the roadmap of a replaced PRD and read-only" in r.text
    if status == "working":
        r = await client.post(f"/v1/simple/drafts/{ids['old_draft']}/submit",
                              headers=ctx.as_("owner"), json={})  # fmt: skip
        assert r.status_code == 409, r.text
        assert "read-only" in r.text


async def test_replaced_prds_roadmap_takes_no_new_version_or_approval(client):
    ctx, _ = await world(client)
    r = await client.post(f"/v1/documents/{OLD_ROADMAP}/versions", headers={
        **ctx.as_("owner"), "content-type": "text/markdown"},
        content=NEW_VERSION)  # fmt: skip
    assert r.status_code == 409, r.text
    assert "read-only" in r.text
    r = await client.post(f"/v1/documents/{OLD_ROADMAP}/versions/2/approve",
                          headers=ctx.as_("owner"), json={})  # fmt: skip
    assert r.status_code == 409, r.text
    assert "read-only" in r.text


async def test_replaced_prd_is_reachable_read_only_from_its_replacement(client):
    ctx, _ = await world(client)
    new = await _get(client, ctx, "/v1/documents/user-safety")
    assert [p["slug"] for p in new["replaces"]] == ["trust-plan"]
    old = await _get(client, ctx, "/v1/documents/trust-plan")
    assert [p["slug"] for p in old["replaced_by"]] == ["user-safety"]
    roadmap = await _get(client, ctx, f"/v1/documents/{OLD_ROADMAP}")
    assert [p["slug"] for p in roadmap["replaced_by"]] == ["user-safety"]
    current = await _get(client, ctx, "/v1/documents/user-safety-roadmap")
    assert current["replaced_by"] == []
