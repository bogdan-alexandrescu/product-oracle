"""fix4 impact text: the reasons and regeneration plan the impact explorer shows are in
words a person reads.

- qa-plan-10: a reason names a baseline item by its title ("Save up to five addresses"),
  never its baseline key ("requirement save-five");
- qa-plan-43: a plan reads "a new version of these acceptance tests", never "of this
  acceptance tests"; a singular kind keeps "this wireframe".

The web mock (web/lib/api/mock/trace.ts) writes the same text.
"""

import oracle.main  # noqa: F401
from tests.baseline_helpers import make_ctx
from tests.trace_helpers import depend, dependency, prd_v1, seed_chain, stub_artifact

KEYS = ("save-five", "pick-saved", "requirement save", "acceptance criterion pick")


async def _setup(client):
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    v1 = await prd_v1(client, ctx)
    _, tests_av = await stub_artifact(
        ctx.tenant_id, v1.document_id, v1.id, kind="acceptance_tests", status="draft"
    )
    _, wire_av = await stub_artifact(
        ctx.tenant_id, v1.document_id, v1.id, kind="wireframe", status="draft"
    )
    deps = {
        "tests": await depend(ctx.tenant_id, artifact_version_id=tests_av, entity_id=chain["ac"]),
        "wire": await depend(
            ctx.tenant_id, artifact_version_id=wire_av, entity_id=chain["requirement"]
        ),
    }
    return ctx, chain, deps


async def test_qa_plan_10_a_what_if_names_items_by_their_titles(client):
    """protects=the what-if's reasons name baseline items by title; fails_when=a reason
    reads "acceptance criterion pick-saved is downstream of requirement save-five"."""
    ctx, chain, _ = await _setup(client)
    resp = await client.get(
        f"/v1/baseline/entities/{chain['requirement']}/impact", headers=ctx.as_("viewer")
    )
    assert resp.status_code == 200, resp.text
    report = resp.json()
    by_kind = {a["artifact_kind"]: a for a in report["affected"]}
    tests_reasons = by_kind["acceptance_tests"]["reasons"]
    wire_reasons = by_kind["wireframe"]["reasons"]
    assert any(
        "Pick a saved address" in r and "Save up to five addresses" in r for r in tests_reasons
    ), tests_reasons
    assert "Save up to five addresses changed" in wire_reasons, wire_reasons
    for r in [*tests_reasons, *wire_reasons, *(x for p in report["plan"] for x in p["reasons"])]:
        assert not any(k in r for k in KEYS), r


async def test_qa_plan_10_a_recorded_change_stores_the_titles(client):
    """protects=the reasons a recorded change stores (and its impact page shows) use
    titles; fails_when=the stored reason names "requirement save-five"."""
    ctx, chain, deps = await _setup(client)
    resp = await client.patch(
        f"/v1/baseline/entities/{chain['requirement']}",
        json={"body": "Ten addresses", "origin": "user"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text
    change_id = (await dependency(ctx.tenant_id, deps["wire"])).caused_by_change_id
    assert change_id is not None
    report = (
        await client.get(f"/v1/trace/changes/{change_id}/impact", headers=ctx.as_("viewer"))
    ).json()
    reasons = [r for a in report["affected"] for r in a["reasons"]]
    assert reasons and any("Save up to five addresses" in r for r in reasons), reasons
    assert not any(k in r for r in reasons for k in KEYS), reasons
    assert report["subject"]["title"] == "Save up to five addresses"


async def test_qa_plan_43_the_plan_says_these_acceptance_tests(client):
    """protects=the regeneration plan's grammar; fails_when=it reads "a new version of this
    acceptance tests"."""
    ctx, chain, _ = await _setup(client)
    report = (
        await client.get(
            f"/v1/baseline/entities/{chain['requirement']}/impact", headers=ctx.as_("viewer")
        )
    ).json()
    how = {p["title"]: p["how"] for p in report["plan"]}
    by_kind = {a["artifact_kind"]: a["title"] for a in report["affected"]}
    tests_how = how[by_kind["acceptance_tests"]]
    assert "Propose a new version of these acceptance tests" in tests_how, tests_how
    assert "this acceptance tests" not in tests_how
    assert "Propose a new version of this wireframe" in how[by_kind["wireframe"]]
