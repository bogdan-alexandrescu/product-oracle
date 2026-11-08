"""replaced-prd-history (re-review): one rule everywhere, a PRD is history only while a live
(not trashed) PRD replaces it. Trust plan, replaced by User Safety, has an approved scope
feature, a draft roadmap with a dated item and an open Simple draft. While User Safety is
live: its roadmap run is refused, its scope feature is off the company roadmap, its draft
roadmap and start sheet leave Simple. With User Safety in Trash (the real Trash route) each
comes back; restoring User Safety from Trash makes Trust plan history again. Against
Postgres. Invented data.

Test card: protects=every place that decides "replaced" reads company.history();
fails_when=a PRD whose only replacement is in Trash is still refused or hidden, or one with
a live replacement is not; no_claim=the Inbox (test_replaced_prd_history_api.py).
"""

import hashlib
from datetime import UTC, date, datetime

import pytest
from sqlalchemy import select

import oracle.main  # noqa: F401 - registers the lanes' checks
from oracle import company_time
from oracle.docs.models import Document, DocumentVersion
from oracle.roadmap import company
from oracle.roadmap.models import DraftRoadmap, RoadmapItem
from oracle.runs.models import Run
from oracle.runs.scope_models import PrdScope, PrdScopeItem
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx

NOW = datetime(2026, 11, 4, 9, 0, tzinfo=UTC)
APPROVED = datetime(2026, 10, 1, tzinfo=UTC)
FEATURE = "appeal-flow"


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def _add(s, row):
    s.add(row)
    await s.flush()
    return row


async def _prd(s, slug: str, title: str, n: int = 1) -> tuple[Document, list[DocumentVersion]]:
    doc = await _add(s, Document(slug=slug, title=title, kind="prd", status="approved",
                                 visibility="company"))  # fmt: skip
    versions = []
    for i in range(1, n + 1):
        body = f"# {title} {i}"
        versions.append(await _add(s, DocumentVersion(
            document_id=doc.id, number=i, markdown=body,
            content_hash=hashlib.sha256(body.encode()).hexdigest(),
            approved_at=APPROVED if i == 1 else None)))  # fmt: skip
    return doc, versions


async def world(client) -> Ctx:
    ctx = await make_ctx()
    r = await client.post("/v1/roadmaps/company", headers=ctx.as_("owner"))
    assert r.status_code in (200, 201), r.text
    async with tenant_session(ctx.tenant_id) as s:
        await _prd(s, "user-safety", "User Safety")
        trust, (_, tv2) = await _prd(s, "trust-plan", "Trust plan", n=2)
        run = await _add(s, Run(flow="baseline_to_prd", status="succeeded",
                                document_id=trust.id))  # fmt: skip
        scope = await _add(s, PrdScope(run_id=run.id, segment_seq=2, attempt=1,
                                       status="approved", document_id=trust.id,
                                       check_result={}, approved_at=NOW))  # fmt: skip
        s.add(PrdScopeItem(scope_id=scope.id, kind="feature", key=FEATURE, title="Appeal flow",
                           depends_on=[], decision="include", position=0))  # fmt: skip
        draft = await _add(s, DraftRoadmap(prd_document_id=trust.id, prd_version_id=tv2.id,
                                           status="ready", run_id=run.id))  # fmt: skip
        s.add(RoadmapItem(draft_roadmap_id=draft.id, item_key="appeal-draft", position=0,
                          title="Appeal draft", horizon="now", start_date=date(2026, 11, 9),
                          end_date=date(2026, 12, 18), prd_document_id=trust.id,
                          prd_version_id=tv2.id))  # fmt: skip
        await s.commit()
    r = await client.post("/v1/documents/trust-plan/replaced-by", headers=ctx.as_("owner"),
                          json={"prds": ["user-safety"]})  # fmt: skip
    assert r.status_code == 200, r.text
    return ctx


async def _trash(client, ctx: Ctx, slug: str) -> str:
    r = await client.request("DELETE", f"/v1/documents/{slug}", headers=ctx.as_("owner"),
                             params={"reason": "Duplicate"})  # fmt: skip
    assert r.status_code == 200, r.text
    return r.json()["id"]


async def _restore(client, ctx: Ctx, entry: str) -> None:
    r = await client.post(f"/v1/trash/{entry}/restore", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text


async def _get(client, ctx: Ctx, path: str):
    r = await client.get(path, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    return r.json()


async def _run(client, ctx: Ctx):
    return await client.post("/v1/runs", headers=ctx.as_("owner"),
                             json={"flow": "prd_to_roadmap", "source": "trust-plan"})  # fmt: skip


async def _on_roadmap(ctx: Ctx) -> set[str]:
    async with tenant_session(ctx.tenant_id) as s:
        return set(await company.features_on_roadmap(s))


async def _draft_prds(client, ctx: Ctx) -> set[str]:
    return {d["prd"]["slug"] for d in await _get(client, ctx, "/v1/simple/roadmap/draft-prds")}


async def _start_sheet(client, ctx: Ctx) -> set[str]:
    options = await _get(client, ctx, "/v1/simple/meetings/options")
    return {p["document"]["slug"] for p in options["prds"]}


async def _assert_history(client, ctx: Ctx) -> None:
    r = await _run(client, ctx)
    assert r.status_code in (409, 422), r.text
    assert "Trust plan is replaced" in r.text
    assert FEATURE not in await _on_roadmap(ctx)
    assert "trust-plan" not in await _draft_prds(client, ctx)
    assert "trust-plan" not in await _start_sheet(client, ctx)
    r = await client.get("/v1/simple/meetings/options?prd=trust-plan", headers=ctx.as_("owner"))
    assert r.status_code == 404, r.text


async def test_a_live_replacement_keeps_the_prd_history_everywhere(client):
    ctx = await world(client)
    await _assert_history(client, ctx)


async def test_with_its_only_replacement_in_trash_the_prd_is_live_everywhere(client):
    ctx = await world(client)
    await _trash(client, ctx, "user-safety")
    r = await _run(client, ctx)
    assert r.status_code == 201, r.text
    assert FEATURE in await _on_roadmap(ctx)
    assert "trust-plan" in await _draft_prds(client, ctx)
    assert "trust-plan" in await _start_sheet(client, ctx)
    options = await _get(client, ctx, "/v1/simple/meetings/options?prd=trust-plan")
    assert [p["document"]["slug"] for p in options["prds"]] == ["trust-plan"]
    page = await _get(client, ctx, "/v1/simple/decisions")
    assert "Trust plan" in {o["title"] for o in page["prds"]}
    r = await client.get("/v1/simple/one-pagers/trust-plan", headers=ctx.as_("owner"))
    assert r.status_code != 404, r.text


async def test_restoring_the_replacement_from_trash_makes_the_prd_history_again(client):
    ctx = await world(client)
    entry = await _trash(client, ctx, "user-safety")
    assert "trust-plan" in await _draft_prds(client, ctx)
    await _restore(client, ctx, entry)
    await _assert_history(client, ctx)


async def test_a_prd_whose_replacement_is_in_trash_may_replace_another(client):
    ctx = await world(client)
    async with tenant_session(ctx.tenant_id) as s:
        await _prd(s, "old-notes", "Old notes")
        await s.commit()
    body = {"prds": ["trust-plan"]}
    r = await client.post("/v1/documents/old-notes/replaced-by", headers=ctx.as_("owner"),
                          json=body)  # fmt: skip
    assert r.status_code == 422, r.text
    await _trash(client, ctx, "user-safety")
    r = await client.post("/v1/documents/old-notes/replaced-by", headers=ctx.as_("owner"),
                          json=body)  # fmt: skip
    assert r.status_code == 200, r.text
    async with tenant_session(ctx.tenant_id) as s:
        notes = await s.scalar(select(Document).where(Document.slug == "old-notes"))
        assert await company.replaced_prd_ids(s) == {notes.id}
