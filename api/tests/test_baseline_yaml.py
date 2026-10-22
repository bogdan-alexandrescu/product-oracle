"""YAML import/export of the graph, and the `oracle baseline push|pull` CLI."""

import io

import httpx
import pytest
import yaml
from sqlalchemy import func, select

from oracle.baseline.models import Edge, Entity, Evidence, Proposal
from oracle.cli.oracle_cli import main
from oracle.tenancy import tenant_session
from tests.baseline_helpers import cite, confirm, edge, entity, make_ctx, make_item

B = "/v1/baseline"
GRAPH = """\
version: 1
entities:
  - type: goal
    key: activation
    title: Raise activation
    status: confirmed
    attrs: {metric: activated accounts, unit: "%", comparison: at_least, target: 40,
            horizon: short, weight: 3}
    evidence:
      - url: https://notes.example.com/okrs
        ref: Company goals
        excerpt: Activation is the first goal this half.
  - type: product
    key: storefront
    title: Storefront
  - type: feature
    key: guided-setup
    title: Guided setup
    attrs: {status: planned, effort: M}
  - type: feature
    key: dark-mode
    title: Dark mode
edges:
  - src: feature:guided-setup
    dst: goal:activation
    type: supports
    attrs: {contribution: 3}
    evidence:
      - url: https://chat.example.com/archives/C1/p2
        excerpt: New accounts get stuck before their first project.
  - src: feature:guided-setup
    dst: product:storefront
    type: part_of
"""


@pytest.fixture
async def ctx():
    return await make_ctx()


async def push(client, ctx, text: str, who: str = "owner") -> httpx.Response:
    return await client.post(
        f"{B}/yaml",
        content=text.encode(),
        headers={**ctx.as_(who), "Content-Type": "application/yaml"},
    )


async def counts(ctx) -> tuple[int, int, int, int]:
    async with tenant_session(ctx.tenant_id) as s:
        return tuple(
            [
                await s.scalar(select(func.count()).select_from(m))
                for m in (Entity, Edge, Evidence, Proposal)
            ]
        )


async def test_import_creates_and_is_idempotent(client, ctx):
    resp = await push(client, ctx, GRAPH)
    assert resp.status_code == 200, resp.text
    r = resp.json()
    assert (r["created"], r["updated"], r["unchanged"], r["proposals"]) == (6, 0, 0, 0)
    assert r["evidence_added"] == 2
    # A goal never arrives confirmed through an import.
    assert [n["code"] for n in r["notes"]] == ["goal_needs_confirmation"]
    ents = {
        e["key"]: e for e in (await client.get(f"{B}/entities", headers=ctx.as_("owner"))).json()
    }
    assert ents["activation"]["status"] == "proposed"
    assert ents["activation"]["origin"] == "import"
    assert ents["guided-setup"]["locked"] is False
    assert ents["guided-setup"]["status"] == "proposed"
    before = await counts(ctx)
    assert before == (4, 2, 2, 0)

    again = (await push(client, ctx, GRAPH)).json()
    assert (again["created"], again["updated"], again["unchanged"], again["proposals"]) == (
        0,
        0,
        6,
        0,
    )
    assert again["evidence_added"] == 0
    assert await counts(ctx) == before


async def test_round_trip(client, ctx):
    goal = await entity(
        client,
        ctx,
        type="goal",
        key="activation",
        title="Raise activation",
        attrs={"weight": 3, "metric": "activated accounts"},
    )
    await confirm(client, ctx, goal)
    feat = await entity(
        client, ctx, type="feature", key="guided-setup", body="Walk through.", attrs={"effort": "M"}
    )
    other = await entity(client, ctx, type="feature", key="sample-data", origin="agent")
    sup = await edge(client, ctx, feat, goal, "supports", attrs={"contribution": 2})
    await edge(client, ctx, other, feat, "depends_on")
    item = await make_item(ctx, "owner")
    await cite(client, ctx, feat, source_item_id=str(item))
    await cite(client, ctx, sup, kind="edges", url="https://notes.example.com/plan", ref="Plan")

    exported = await client.get(f"{B}/yaml", headers=ctx.as_("owner"))
    assert exported.status_code == 200
    assert exported.headers["content-type"].startswith("application/yaml")
    doc = yaml.safe_load(exported.text)
    assert doc["version"] == 1
    assert [f"{e['type']}:{e['key']}" for e in doc["entities"]] == [
        "feature:guided-setup",
        "feature:sample-data",
        "goal:activation",
    ]
    feat_doc = doc["entities"][0]
    assert feat_doc["locked"] is True
    assert feat_doc["evidence"][0]["source_item"] == str(item)  # the exporter's own item
    # Someone else's export never names the item.
    other_doc = yaml.safe_load((await client.get(f"{B}/yaml", headers=ctx.as_("viewer"))).text)
    assert "source_item" not in other_doc["entities"][0]["evidence"][0]
    assert other_doc["entities"][0]["evidence"][0]["excerpt"] == feat_doc["evidence"][0]["excerpt"]

    # Importing the export into the same graph changes nothing.
    r = (await push(client, ctx, exported.text)).json()
    assert r["created"] == 0 and r["updated"] == 0 and r["proposals"] == 0
    assert r["evidence_added"] == 0

    # Into another company: same graph (goals wait for confirmation; nothing is locked).
    fresh = await make_ctx("Other Co")
    r = (await push(client, fresh, exported.text)).json()
    assert r["created"] == 5 and r["evidence_added"] == 2
    await confirm(
        client,
        fresh,
        next(
            e
            for e in (await client.get(f"{B}/entities", headers=fresh.as_("owner"))).json()
            if e["type"] == "goal"
        ),
    )
    second = yaml.safe_load((await client.get(f"{B}/yaml", headers=fresh.as_("owner"))).text)

    def strip(d):
        for kind in ("entities", "edges"):
            for e in d[kind]:
                e.pop("locked", None)
                for ev in e.get("evidence", []):
                    ev.pop("source_item", None)
        return d

    assert strip(second) == strip(doc)


async def test_import_respects_locks(client, ctx):
    await push(client, ctx, GRAPH)
    feat = next(
        e
        for e in (
            await client.get(f"{B}/entities", params={"type": "feature"}, headers=ctx.as_("owner"))
        ).json()
        if e["key"] == "guided-setup"
    )
    # A person corrects the feature: it is locked.
    await client.patch(
        f"{B}/entities/{feat['id']}", json={"title": "Guided onboarding"}, headers=ctx.as_("owner")
    )

    changed = GRAPH.replace("title: Dark mode", "title: Dark theme")
    r = (await push(client, ctx, changed)).json()
    # The locked feature would revert to "Guided setup": a proposal instead.
    assert r["proposals"] == 1 and r["updated"] == 1
    detail = (await client.get(f"{B}/entities/{feat['id']}", headers=ctx.as_("owner"))).json()
    assert detail["title"] == "Guided onboarding"
    (proposal,) = (await client.get(f"{B}/proposals", headers=ctx.as_("owner"))).json()
    assert proposal["entity_id"] == feat["id"]
    assert proposal["payload"]["origin"] == "import"
    assert proposal["payload"]["fields"]["title"] == "Guided setup"

    # Again: still one proposal.
    r = (await push(client, ctx, changed)).json()
    assert r["proposals"] == 1
    assert len((await client.get(f"{B}/proposals", headers=ctx.as_("owner"))).json()) == 1


async def test_import_keeps_confirmed_goals_and_drops_removed_attrs(client, ctx):
    await push(client, ctx, GRAPH)
    goal = next(
        e
        for e in (
            await client.get(f"{B}/entities", params={"type": "goal"}, headers=ctx.as_("owner"))
        ).json()
    )
    await confirm(client, ctx, goal)
    r = (
        await push(
            client,
            ctx,
            GRAPH.replace(
                "    attrs: {status: planned, effort: M}\n", "    attrs: {status: planned}\n"
            ),
        )
    ).json()
    assert r["notes"] == []  # already confirmed here
    assert r["updated"] == 1
    feats = (
        await client.get(f"{B}/entities", params={"type": "feature"}, headers=ctx.as_("owner"))
    ).json()
    assert next(f for f in feats if f["key"] == "guided-setup")["attrs"] == {"status": "planned"}


@pytest.mark.parametrize(
    ("text", "code"),
    [
        ("entities: [", "invalid_yaml"),
        ("- a\n- b\n", "invalid_yaml"),
        ("version: 2\n", "unsupported_version"),
        ("entities:\n  - {type: epic, key: x, title: X}\n", "invalid_type"),
        ("entities:\n  - {type: feature, title: X}\n", "missing_key"),
        ("edges:\n  - {src: feature:a, dst: goal:b, type: supports}\n", "unknown_ref"),
        (
            "entities:\n  - {type: feature, key: a, title: A}\n  - {type: goal, key: b, title: B}\n"
            "edges:\n  - {src: feature:a, dst: goal:b, type: supports}\n",
            "rejected",
        ),
        ("entities:\n  - {type: feature, key: a, title: A, evidence: [{}]}\n", "invalid_evidence"),
    ],
)
async def test_import_rejects_bad_files_without_writing(client, ctx, text, code):
    resp = await push(client, ctx, text)
    assert resp.status_code == 422, resp.text
    assert code in [e["code"] for e in resp.json()["errors"]]
    assert await counts(ctx) == (0, 0, 0, 0)


async def test_import_needs_an_approver(client, ctx):
    assert (await push(client, ctx, GRAPH, who="commenter")).status_code == 403
    assert (await push(client, ctx, GRAPH, who="approver")).status_code == 200


# --- CLI ---------------------------------------------------------------------------------


@pytest.fixture
def _env(monkeypatch):
    monkeypatch.setenv("ORACLE_URL", "http://oracle.test:8000/")
    monkeypatch.setenv("ORACLE_API_TOKEN", "po_secret")


def run(argv, handler):
    requests: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return handler(request)

    out, err = io.StringIO(), io.StringIO()
    code = main(argv, transport=httpx.MockTransport(record), out=out, err=err)
    return code, out.getvalue(), err.getvalue(), requests


def test_cli_baseline_push(tmp_path, _env):
    path = tmp_path / "graph.yaml"
    path.write_text(GRAPH, encoding="utf-8")
    result = {
        "created": 6,
        "updated": 0,
        "unchanged": 0,
        "proposals": 1,
        "evidence_added": 2,
        "notes": [
            {"code": "goal_needs_confirmation", "message": "confirm it", "where": "entities[0]"}
        ],
    }
    code, out, err, reqs = run(
        ["baseline", "push", str(path)], lambda r: httpx.Response(200, json=result)
    )
    assert code == 0, err
    (req,) = reqs
    assert req.method == "POST"
    assert str(req.url) == "http://oracle.test:8000/v1/baseline/yaml"
    assert req.headers["content-type"].startswith("application/yaml")
    assert req.headers["authorization"] == "Bearer po_secret"
    assert req.content.decode() == GRAPH
    assert "6 created, 0 updated, 0 unchanged, 2 evidence added" in out
    assert "1 change(s) to locked items became proposals" in out
    assert "note [goal_needs_confirmation]: confirm it (entities[0])" in out


def test_cli_baseline_push_reports_errors(tmp_path, _env):
    path = tmp_path / "graph.yaml"
    path.write_text("version: 2\n", encoding="utf-8")
    body = {
        "detail": "file rejected: 1 problem(s)",
        "errors": [
            {"code": "unsupported_version", "message": "version must be 1", "where": "version"}
        ],
    }
    code, _, err, _ = run(["baseline", "push", str(path)], lambda r: httpx.Response(422, json=body))
    assert code == 1
    assert "[unsupported_version] version must be 1 (version)" in err


def test_cli_baseline_push_missing_file(tmp_path, _env):
    code, _, err, reqs = run(
        ["baseline", "push", str(tmp_path / "nope.yaml")], lambda r: httpx.Response(200)
    )
    assert code == 2 and reqs == []
    assert "cannot read" in err


def test_cli_baseline_pull(tmp_path, _env):
    target = tmp_path / "out.yaml"
    code, out, err, reqs = run(
        ["baseline", "pull", "--out", str(target)],
        lambda r: httpx.Response(200, text=GRAPH, headers={"content-type": "application/yaml"}),
    )
    assert code == 0, err
    assert reqs[0].method == "GET" and reqs[0].url.path == "/v1/baseline/yaml"
    assert target.read_text(encoding="utf-8") == GRAPH
    assert f"Pulled the baseline to {target}" in out

    code, out, _, _ = run(
        ["baseline", "pull", "-o", "-"], lambda r: httpx.Response(200, text=GRAPH)
    )
    assert code == 0 and out == GRAPH
