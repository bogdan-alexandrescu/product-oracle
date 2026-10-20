"""The thin v2 read routes: list and get per entity, role guard, company scoping."""

import uuid
from pathlib import Path

import pytest

from oracle.main import app
from oracle.mcp.tools import app_operations
from oracle.v2.router import RESOURCES
from tests.baseline_helpers import make_ctx
from tests.conftest import seed_company
from tests.v2_helpers import seed_v2

# Route path -> the table its rows come from.
TABLE = {r.path: r.model.__tablename__ for r in RESOURCES}
PATHS = sorted(TABLE)
FIXTURES_DIR_PRD = Path(__file__).parent / "fixtures" / "prd_v1.md"


def test_every_new_table_has_a_list_and_a_get():
    from oracle.db import Base
    from oracle.v2 import models as m

    v2_tables = {
        t.name
        for t in Base.metadata.sorted_tables
        if any(cls.__table__ is t for cls in vars(m).values() if isinstance(cls, type)
               and issubclass(cls, Base) and hasattr(cls, "__table__"))
    }  # fmt: skip
    assert v2_tables == set(TABLE.values())
    paths = app.openapi()["paths"]
    for path in PATHS:
        assert "get" in paths[f"/v1{path}"], path
        assert "get" in paths[f"/v1{path}/{{item_id}}"], path


def test_every_route_is_an_mcp_tool():
    ops = {(o.method, o.path): o for o in app_operations(app)}
    for res in RESOURCES:
        listing = ops[("GET", f"/v1{res.path}")]
        one = ops[("GET", f"/v1{res.path}/{{item_id}}")]
        assert not listing.excluded and not one.excluded
        assert listing.tool_name == f"list_{res.plural}"
        assert one.tool_name == f"get_{res.singular}"


@pytest.mark.parametrize("path", PATHS)
async def test_routes_require_auth(client, path):
    assert (await client.get(f"/v1{path}")).status_code == 401
    assert (await client.get(f"/v1{path}/{uuid.uuid4()}")).status_code == 401


async def test_a_viewer_lists_and_gets_every_entity_of_their_company(client):
    ctx = await make_ctx()
    seeded = await seed_v2(ctx.tenant_id)
    viewer = ctx.as_("viewer")
    for path in PATHS:
        row_id = str(seeded.ids[TABLE[path]])
        resp = await client.get(f"/v1{path}", headers=viewer)
        assert resp.status_code == 200, (path, resp.text)
        assert [r["id"] for r in resp.json()] == [row_id], path
        resp = await client.get(f"/v1{path}/{row_id}", headers=viewer)
        assert resp.status_code == 200, (path, resp.text)
        assert resp.json()["id"] == row_id
        missing = await client.get(f"/v1{path}/{uuid.uuid4()}", headers=viewer)
        assert missing.status_code == 404, path


async def test_another_companys_rows_are_invisible(client):
    """Negative cross-company test: ids of company B are 404 for company A, every route."""
    a = await make_ctx("Company A")
    b = await make_ctx("Company B")
    await seed_v2(a.tenant_id)
    theirs = await seed_v2(b.tenant_id)
    for path in PATHS:
        their_id = str(theirs.ids[TABLE[path]])
        for who in ("viewer", "owner", "token"):
            resp = await client.get(f"/v1{path}/{their_id}", headers=a.as_(who))
            assert resp.status_code == 404, (path, who)
        listed = (await client.get(f"/v1{path}", headers=a.as_("owner"))).json()
        assert their_id not in {r["id"] for r in listed}, path
        assert len(listed) == 1, path
    # Filtering by another company's parent id finds nothing either.
    resp = await client.get(
        "/v1/gaps", params={"intake_id": str(theirs.ids["product_intakes"])}, headers=a.as_("owner")
    )
    assert resp.json() == []


async def test_list_filters_and_paging(client):
    ctx = await make_ctx()
    seeded = await seed_v2(ctx.tenant_id)
    h = ctx.as_("viewer")

    async def ids(path, **params):
        resp = await client.get(path, params=params, headers=h)
        assert resp.status_code == 200, resp.text
        return [r["id"] for r in resp.json()]

    gap = str(seeded.ids["knowledge_gaps"])
    assert await ids("/v1/gaps", importance="critical") == [gap]
    assert await ids("/v1/gaps", importance="low") == []
    assert await ids("/v1/gaps", intake_id=str(seeded.ids["product_intakes"])) == [gap]
    assert await ids("/v1/blocker-options", blocker_id=str(seeded.blocker_id)) == [
        str(seeded.ids["blocker_options"])
    ]
    assert await ids("/v1/artifact-dependencies", freshness="potentially_stale") == []
    assert await ids("/v1/section-links", section_key="goal-trace") != []
    assert await ids("/v1/change-events", subject_kind="document_section") != []
    assert await ids("/v1/gaps", offset=1) == []
    for bad in ({"importance": "urgent"}, {"limit": 0}, {"limit": 501}, {"offset": -1}):
        resp = await client.get("/v1/gaps", params=bad, headers=h)
        assert resp.status_code == 422, bad
    resp = await client.get("/v1/gaps", params={"intake_id": "not-a-uuid"}, headers=h)
    assert resp.status_code == 422


async def test_typed_json_columns_come_back_typed(client):
    ctx = await make_ctx()
    seeded = await seed_v2(ctx.tenant_id)
    h = ctx.as_("viewer")
    rev = (await client.get("/v1/composition-revisions", headers=h)).json()[0]
    assert rev["modules"][0]["key"] == "constraints.solutions"
    assert rev["modules"][0]["included"] is True
    assert rev["inputs"]["category"] == "platform" and rev["inputs"]["outputs"] == []
    report_id = seeded.ids["evaluation_reports"]
    report = (await client.get(f"/v1/evaluation-reports/{report_id}", headers=h)).json()
    assert [f["criterion"] for f in report["findings"]] == ["problem_clarity"]
    assert report["policy"] == "advisory"
    gap = (await client.get("/v1/gaps", headers=h)).json()[0]
    assert gap["status"] == "unknown" and gap["knowledge_state"] == "unknown"
    assert gap["impact"] == ["goals", "scope"]
    output = (await client.get("/v1/artifact-outputs", headers=h)).json()[0]
    assert "content" not in output and "storage_ref" not in output


async def test_legacy_documents_and_templates_load_as_before(client):
    """A document with no composition and a template with no manifest behave as before."""
    ctx = await make_ctx()
    await seed_company(ctx.tenant_id)
    owner = ctx.as_("owner")
    with open(FIXTURES_DIR_PRD, encoding="utf-8") as f:
        markdown = f.read()
    resp = await client.post(
        "/v1/documents/checkout-redesign/versions",
        content=markdown.encode(),
        headers={**owner, "Content-Type": "text/markdown"},
    )
    assert resp.status_code == 201, resp.text
    doc = (await client.get("/v1/documents/checkout-redesign", headers=owner)).json()
    version = (await client.get("/v1/documents/checkout-redesign/versions/1", headers=owner)).json()
    assert version["sections"]
    resp = await client.get("/v1/compositions", params={"document_id": doc["id"]}, headers=owner)
    assert resp.json() == []
    templates = (await client.get("/v1/templates", headers=owner)).json()
    assert templates
    for t in templates:
        resp = await client.get(
            "/v1/template-module-assignments", params={"template_id": t["id"]}, headers=owner
        )
        assert resp.json() == []


async def test_questions_asked_of_me_are_never_cut_off(client):
    """GET /v1/questions?asked_to=me: the Inbox's Questions group and the rail badge (I3)."""
    from datetime import UTC, datetime, timedelta

    from oracle.tenancy import tenant_session
    from oracle.v2 import models as m

    ctx = await make_ctx()
    seeded = await seed_v2(ctx.tenant_id)
    viewer, owner = ctx.users["viewer"], ctx.users["owner"]
    old = datetime(2026, 1, 1, tzinfo=UTC)
    async with tenant_session(ctx.tenant_id) as s:
        mine = m.StakeholderQuestion(
            intake_id=seeded.ids["product_intakes"], category="success_metric",
            prompt="Which metric?", status="asked", asked_to=viewer.id, created_at=old,
        )  # fmt: skip
        s.add(mine)
        # 100 newer questions asked of someone else fill the default page.
        s.add_all(
            m.StakeholderQuestion(
                intake_id=seeded.ids["product_intakes"],
                category="success_metric",
                prompt=f"Question {i}",
                status="asked",
                asked_to=owner.id,
                created_at=old + timedelta(days=1, minutes=i),
            )  # fmt: skip
            for i in range(100)
        )
        await s.commit()
        mine_id = str(mine.id)

    listed = (await client.get("/v1/questions", headers=ctx.as_("viewer"))).json()
    assert len(listed) == 100 and mine_id not in {q["id"] for q in listed}

    resp = await client.get(
        "/v1/questions", params={"asked_to": "me", "status": "asked"}, headers=ctx.as_("viewer")
    )
    assert resp.status_code == 200, resp.text
    assert [q["id"] for q in resp.json()] == [mine_id]
    theirs = (
        await client.get("/v1/questions", params={"asked_to": "me"}, headers=ctx.as_("owner"))
    ).json()
    assert len(theirs) == 100 and {q["asked_to"] for q in theirs} == {str(owner.id)}
    # An API token acts for no person: nothing is asked of it, never the unassigned ones.
    token = await client.get("/v1/questions", params={"asked_to": "me"}, headers=ctx.as_("token"))
    assert token.status_code == 200 and token.json() == []
    # Only "me": another person's id is not a filter this route takes.
    bad = await client.get(
        "/v1/questions", params={"asked_to": str(owner.id)}, headers=ctx.as_("viewer")
    )
    assert bad.status_code == 422
    assert (await client.get("/v1/questions", params={"asked_to": "me"})).status_code == 401
