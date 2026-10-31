"""Readiness dashboard and evaluation routes: roles, company scoping, audit, MCP parity."""

import uuid

from sqlalchemy import select

from oracle.docs.models import DocumentVersion
from oracle.main import app
from oracle.mcp.tools import app_operations
from oracle.models import AuditEvent
from oracle.quality import criteria
from oracle.tenancy import tenant_session
from oracle.v2 import models as m
from tests.baseline_helpers import make_ctx
from tests.quality_corpus import load_case, seed_case


def V(slug: str, n: int, path: str = "") -> str:
    return f"/v1/documents/{slug}/versions/{n}{path}"


ROUTES = {
    ("GET", "/v1/quality/criteria"): "list_quality_criteria",
    ("GET", "/v1/documents/{doc}/versions/{n}/readiness"): "get_document_readiness",
    ("POST", "/v1/documents/{doc}/versions/{n}/evaluations"): "create_evaluation_report",
    ("POST", "/v1/documents/{doc}/versions/{n}/evaluations/human"): "create_human_rating",
    ("POST", "/v1/documents/{doc}/versions/{n}/quality-review"): "queue_quality_review",
    ("POST", "/v1/outcomes"): "create_outcome",
    ("GET", "/v1/outcomes"): "list_outcomes",
    ("GET", "/v1/outcomes/{outcome_id}"): "get_outcome",
    ("POST", "/v1/outcomes/{outcome_id}/assessments"): "assess_outcome",
    ("POST", "/v1/outcomes/{outcome_id}/learnings/{index}"): "decide_outcome_learning",
    ("POST", "/v1/learnings"): "create_learning",
    ("GET", "/v1/learnings"): "list_learnings",
    ("GET", "/v1/learnings/signals"): "get_learning_signals",
    ("POST", "/v1/learnings/{learning_id}/retire"): "retire_learning",
}


def test_every_route_is_an_mcp_tool():
    ops = {(o.method, o.path): o for o in app_operations(app)}
    for key, name in ROUTES.items():
        assert key in ops, key
        assert not ops[key].excluded and ops[key].tool_name == name, key


async def test_routes_require_auth(client):
    for method, path in ROUTES:
        url = path.format(doc="x", n=1, outcome_id=uuid.uuid4(), learning_id=uuid.uuid4(), index=0)
        resp = await client.request(method, url, json={})
        assert resp.status_code == 401, (method, path)


async def test_criteria_catalogue(client):
    ctx = await make_ctx()
    resp = await client.get("/v1/quality/criteria", headers=ctx.as_("viewer"))
    assert resp.status_code == 200
    body = resp.json()
    assert [c["key"] for c in body] == [*criteria.KEYS, *criteria.HARD_KEYS]
    assert all(c["title"] and c["question"] for c in body)
    assert {c["key"] for c in body if c["hard"]} == set(criteria.HARD_KEYS)


async def test_the_dashboard_shows_every_criterion_with_its_explanation(client):
    ctx = await make_ctx()
    seeded = await seed_case(client, ctx, load_case("social-api-policy"))
    resp = await client.get(V(seeded.slug, 1, "/readiness"), headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["policy"] == "advisory" and "T2" in body["policy_note"]
    assert body["version"] == 1 and body["version_id"] == str(seeded.version_id)
    items = {i["key"]: i for i in body["items"]}
    assert set(criteria.ALL_KEYS) <= set(items)
    for key in criteria.ALL_KEYS:
        item = items[key]
        assert item["status"] in ("pass", "warning", "critical", "not_applicable")
        assert item["rationale"] and item["title"] and item["question"]
        assert item["hard"] is (key in criteria.HARD_KEYS)
        assert item["model"] is None and item["human"] == []
    party = items["third_party_support"]
    assert party["status"] == "critical"
    assert str(seeded.refs["social-posting"]) in party["evidence_ids"]
    assert party["section_keys"] == ["scope"]
    assert body["blocked"] is True and "third_party_support" in body["blocking"]
    assert sum(body["counts"].values()) == len(body["items"])
    # Reading the dashboard stores nothing.
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.scalars(select(m.EvaluationReport))).all() == []


async def test_a_commenter_stores_a_report_and_it_is_audited(client):
    ctx = await make_ctx()
    seeded = await seed_case(client, ctx, load_case("bad-prd-sections"))
    url = V(seeded.slug, 1, "/evaluations")
    assert (await client.post(url, headers=ctx.as_("viewer"))).status_code == 403
    resp = await client.post(url, headers=ctx.as_("commenter"))
    assert resp.status_code == 201, resp.text
    report = resp.json()
    assert report["evaluator"] == "rules" and report["policy"] == "advisory"
    assert report["status"] == "complete" and report["version_id"] == str(seeded.version_id)
    findings = {f["criterion"]: f for f in report["findings"]}
    assert set(criteria.ALL_KEYS) <= set(findings)
    assert findings["problem_clarity"]["status"] == "critical"
    assert findings["problem_clarity"]["hard"] is False
    assert findings["security_policy"]["hard"] is True
    assert report["summary"]["blocked"] is False
    assert report["summary"]["counts"]["critical"] >= 5
    # The foundation's read routes return it.
    got = await client.get(f"/v1/evaluation-reports/{report['id']}", headers=ctx.as_("viewer"))
    assert got.status_code == 200 and len(got.json()["findings"]) == len(findings)
    async with tenant_session(ctx.tenant_id) as s:
        actions = list(await s.scalars(select(AuditEvent.action)))
    assert "evaluation_report.created" in actions
    dash = (await client.get(V(seeded.slug, 1, "/readiness"), headers=ctx.as_("viewer"))).json()
    assert dash["latest_report"]["id"] == report["id"]


async def test_human_ratings_are_stored_and_compared(client):
    ctx = await make_ctx()
    seeded = await seed_case(client, ctx, load_case("good-prd"))
    url = V(seeded.slug, 1, "/evaluations/human")
    bad = await client.post(
        url,
        json={"ratings": [{"criterion": "nope", "status": "pass", "rationale": "x"}]},
        headers=ctx.as_("commenter"),
    )
    assert bad.status_code == 422
    rating = {
        "ratings": [
            {"criterion": "validation_plan", "status": "warning", "rationale": "No sample size"},
            {"criterion": "problem_clarity", "status": "pass", "rationale": "Clear"},
        ]
    }
    assert (await client.post(url, json=rating, headers=ctx.as_("viewer"))).status_code == 403
    resp = await client.post(url, json=rating, headers=ctx.as_("commenter"))
    assert resp.status_code == 201, resp.text
    assert resp.json()["evaluator"] == "human"
    assert all(f["hard"] is False for f in resp.json()["findings"])
    dash = (await client.get(V(seeded.slug, 1, "/readiness"), headers=ctx.as_("viewer"))).json()
    items = {i["key"]: i for i in dash["items"]}
    assert items["validation_plan"]["status"] == "pass"  # the rules still decide the status
    assert items["validation_plan"]["human"][0]["status"] == "warning"
    assert items["validation_plan"]["agreement"]["human"] == 0.0
    assert items["problem_clarity"]["agreement"]["human"] == 1.0
    assert items["goal_alignment"]["agreement"]["human"] is None


async def test_another_companys_documents_and_reports_are_invisible(client):
    """Negative cross-company test for every document-scoped quality route."""
    a = await make_ctx("Company A")
    b = await make_ctx("Company B")
    theirs = await seed_case(client, b, load_case("good-prd"))
    rating = {"ratings": [{"criterion": "problem_clarity", "status": "pass", "rationale": "x"}]}
    for method, path, body in (
        ("GET", "/readiness", None),
        ("POST", "/evaluations", None),
        ("POST", "/evaluations/human", rating),
        ("POST", "/quality-review", None),
    ):
        for who in ("viewer", "owner", "token"):
            resp = await client.request(
                method, V(theirs.slug, 1, path), json=body, headers=a.as_(who)
            )
            assert resp.status_code in (403, 404), (path, who, resp.status_code)
            if who == "owner":
                assert resp.status_code == 404, path
    # By id too: company A cannot use company B's document id.
    resp = await client.get(V(str(theirs.document_id), 1, "/readiness"), headers=a.as_("owner"))
    assert resp.status_code == 404


async def test_an_unknown_version_is_a_404(client):
    ctx = await make_ctx()
    seeded = await seed_case(client, ctx, load_case("good-prd"))
    resp = await client.get(V(seeded.slug, 9, "/readiness"), headers=ctx.as_("viewer"))
    assert resp.status_code == 404


async def test_publishing_never_needs_a_stored_report(client):
    """The dashboard is live; no stored report is a precondition for anything."""
    ctx = await make_ctx()
    seeded = await seed_case(client, ctx, load_case("good-prd"))
    async with tenant_session(ctx.tenant_id) as s:
        version = await s.get(DocumentVersion, seeded.version_id)
        assert version.approved_at is None
    dash = (await client.get(V(seeded.slug, 1, "/readiness"), headers=ctx.as_("viewer"))).json()
    assert dash["latest_report"] is None and dash["blocked"] is False


async def test_a_human_rating_returns_the_sections_it_names(client):
    """qa4-docs-42: the readiness dashboard lists the sections a person picked with their rating."""
    ctx = await make_ctx()
    seeded = await seed_case(client, ctx, load_case("good-prd"))
    rating = {
        "ratings": [
            {
                "criterion": "problem_clarity",
                "status": "pass",
                "rationale": "Clear",
                "section_keys": ["problem"],
            },
            {"criterion": "validation_plan", "status": "warning", "rationale": "No sample size"},
        ]
    }
    resp = await client.post(
        V(seeded.slug, 1, "/evaluations/human"), json=rating, headers=ctx.as_("commenter")
    )
    assert resp.status_code == 201, resp.text
    dash = (await client.get(V(seeded.slug, 1, "/readiness"), headers=ctx.as_("viewer"))).json()
    items = {i["key"]: i for i in dash["items"]}
    assert items["problem_clarity"]["human"][0]["section_keys"] == ["problem"]
    assert items["validation_plan"]["human"][0]["section_keys"] == []
