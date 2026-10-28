"""H8: an update's dates follow the verified-basis rule (O4 'document dates'), against
every PRD with an active product track: a person's import with an unverified date is
refused naming it and its line; a run's import keeps the draft, marks the date
'unverified' in the view, the markdown and the exports, and approval is refused until a
verified basis supports it; a withdrawn basis later marks it 'date withdrawn' without
rewriting the approved text. Against Postgres with the FakeRuntime.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

import pytest
from sqlalchemy import update

from oracle.docs.models import Document
from oracle.roadmap import doc_dates
from oracle.roadmap.models import ProductTrack
from oracle.swarm import FakeRuntime, set_runtime
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.update_helpers import (
    drafted_by_run,
    import_md,
    investor_md,
    prd_with_active_track,
    record_basis,
    started,
)

BETA = "Guided setup shipped; Beta on 2026-12-15."


@pytest.fixture
async def ctx():
    return await make_ctx()


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


async def test_the_basis_lookup_is_every_prd_with_an_active_track(client, ctx):
    """protects=doc_dates' multi-PRD lookup for an update: every PRD with an active track,
    and none once its track is paused; a roadmap keeps its single PRD; fails_when=an update
    reads one PRD only, or a paused track still counts; no_claim=tracks of other kinds."""
    prd = await prd_with_active_track(client, ctx)
    slug = await started(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        prd_id = (await s.execute(
            Document.__table__.select().where(Document.slug == prd)
        )).first().id  # fmt: skip
        update_id = (await s.execute(
            Document.__table__.select().where(Document.slug == slug)
        )).first().id  # fmt: skip
        assert await doc_dates.prds_with_active_track(s) == [prd_id]
        assert await doc_dates.prds_for(s, update_id) == [prd_id]
        await s.execute(update(ProductTrack).values(status="paused"))
        await s.commit()
        assert await doc_dates.prds_for(s, update_id) == []


async def test_a_persons_import_with_an_unverified_date_is_refused(client, ctx):
    """protects=a person's import writing "Beta on 2026-12-15" with no verified basis of any
    active-track PRD is a 422 naming the date and its line; with the basis it imports;
    fails_when=it imports, or the refusal does not name the date and line; no_claim=bases
    scoped to an item or tracker key (the roadmap tests cover them)."""
    await prd_with_active_track(client, ctx)
    slug = await started(client, ctx)
    resp = await import_md(client, ctx.as_("owner"), slug, investor_md(slug, product=BETA))
    assert resp.status_code == 422, resp.text
    (problem,) = resp.json()["errors"]
    assert problem["code"] == "unverified_date" and problem["section_key"] == "product"
    assert "Dec 15, 2026" in problem["message"] and "line 1" in problem["message"]
    assert "any PRD with an active product track" in problem["message"]

    await record_basis(client, ctx, "2026-12-15")
    resp = await import_md(client, ctx.as_("owner"), slug, investor_md(slug, product=BETA))
    assert resp.status_code == 201, resp.text


async def test_a_runs_import_marks_the_date_and_approval_waits_for_a_basis(client, ctx, runtime):
    """protects=the same text from an update_draft run imports with the date marked
    "unverified" (view, markdown, export), approval is a 409 naming it, and after an
    approver records a verified basis the owner's approval succeeds; fails_when=the run's
    draft is refused, the mark is missing anywhere, or approval passes with the date
    unverified; no_claim=Present's rendering in the browser (the e2e covers it)."""
    await prd_with_active_track(client, ctx)
    slug = await started(client, ctx)
    run = await drafted_by_run(client, ctx, runtime, slug, investor_md(slug, product=BETA))
    assert run["status"] == "awaiting_checkpoint", run
    owner = ctx.as_("owner")
    url = f"/v1/documents/{slug}/versions/2"
    version = (await client.get(url, headers=owner)).json()
    assert [w["code"] for w in version["warnings"]].count("unverified_date") == 1
    assert [(m["text"], m["status"], m["label"]) for m in version["date_marks"]] == [
        ("2026-12-15", "unverified", "unverified")
    ]
    md = (await client.get(f"{url}/markdown", headers=owner)).text
    assert "2026-12-15 <!-- oracle: date unverified -->" in md
    html = (await client.get(f"{url}/export", params={"format": "html"}, headers=owner)).text
    assert "2026-12-15 <strong>[unverified]</strong>" in html

    resp = await client.post(f"{url}/approve", headers=owner)
    assert resp.status_code == 409, resp.text
    assert "Dec 15, 2026" in resp.json()["detail"]

    await record_basis(client, ctx, "2026-12-15")
    resp = await client.post(f"{url}/approve", headers=owner)
    assert resp.status_code == 200, resp.text


async def test_a_withdrawn_basis_marks_the_approved_update(client, ctx):
    """protects=withdrawing the basis an approved update's date rests on marks the date
    "date withdrawn" in the view and markdown, and the approved text is not rewritten;
    fails_when=the mark is missing or the stored markdown changes; no_claim=notifying
    anyone of the withdrawal."""
    await prd_with_active_track(client, ctx)
    basis = await record_basis(client, ctx, "2026-12-15")
    slug = await started(client, ctx)
    owner = ctx.as_("owner")
    assert (
        await import_md(client, owner, slug, investor_md(slug, product=BETA))
    ).status_code == 201
    url = f"/v1/documents/{slug}/versions/2"
    assert (await client.post(f"{url}/approve", headers=owner)).status_code == 200
    before = (await client.get(f"{url}/markdown", headers=owner)).text
    resp = await client.post(
        f"/v1/schedule-bases/{basis['id']}/withdraw",
        json={"reason": "re-estimated"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text
    version = (await client.get(url, headers=owner)).json()
    assert [(m["text"], m["status"]) for m in version["date_marks"]] == [
        ("2026-12-15", "withdrawn")
    ]
    after = (await client.get(f"{url}/markdown", headers=owner)).text
    assert after == before.replace("2026-12-15.", "2026-12-15 <!-- oracle: date withdrawn -->.")
    assert version["approved_at"] is not None
