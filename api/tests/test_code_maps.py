"""F5-2 code capability maps: the code_map.json format and its check, the code_map flow
(one indexer segment, no checkpoint), the code_maps rows a run stores, who sees a map
(S6: private to the source's owner until shared in full), the refresh on merge, and the
runs that use a shared map (the tech brief check, specs' capability map).

The fake SwarmCloud runtime stands in for the indexer; no model is called and no
repository is read. Synthetic placeholders only."""

import json
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

import oracle.main  # noqa: F401  (registers the lanes' importers and prompt lines)
from oracle.engineering import codemap
from oracle.engineering.models import CodeMap
from oracle.models import AuditEvent
from oracle.runs import flows
from oracle.runs.models import Checkpoint, Run
from oracle.sources import base
from oracle.sources.connectors import github
from oracle.sources.models import Source
from oracle.specs.capabilities import capability_map
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from oracle.tenancy import tenant_session
from tests.conftest import make_tenant
from tests.connection_helpers import add_connection, make_person
from tests.fixtures import seed_auth
from tests.tech_brief_helpers import SAMPLE, seed_features
from tests.test_mcp import mcp_client, run_token, text_of

REPO = "example-org/app"

MAP = {
    "version": 1,
    "repo": REPO,
    "commit": "3f2c9a1",
    "generated_at": "2026-10-18T10:00:00Z",
    "modules": [
        {"id": "module:billing", "path": "api/billing", "summary": "Invoices",
         "depends_on": ["module:notifications"]},
        {"id": "module:notifications", "path": "api/notifications", "summary": "Email",
         "depends_on": []},
    ],
    "apis": [{"id": "api:create-invoice", "method": "POST", "path": "/v1/invoices",
              "module": "module:billing"}],
    "data_models": [{"id": "model:invoice", "name": "Invoice", "module": "module:billing",
                     "fields": ["id", "amount"]}],
    "flags": [{"id": "flag:new-checkout", "name": "new_checkout",
               "module": "module:notifications"}],
    "jobs": [{"id": "job:nightly-sync", "schedule": "0 3 * * *", "module": "module:billing"}],
}  # fmt: skip


def text(data: dict) -> str:
    return json.dumps(data)


def changed(**edits) -> dict:
    data = json.loads(json.dumps(MAP))
    data.update(edits)
    return data


def codes(problems) -> set[str]:
    return {p.code for p in problems}


# --------------------------------------------------------------------------- the check


def test_the_sample_map_checks_clean():
    # protects=AC4 a map in the format checks clean and lists its ids; fails_when=a valid
    # map is refused; no_claim=what the map says is true of the code.
    assert codemap.check(text(MAP)) == []
    assert codemap.ids(MAP) == {
        "module:billing", "module:notifications", "api:create-invoice", "model:invoice",
        "flag:new-checkout", "job:nightly-sync",
    }  # fmt: skip


def _module(**over) -> dict:
    return {"id": "module:extra", "path": "api/extra", "summary": "x", "depends_on": [], **over}


@pytest.mark.parametrize(
    ("code", "data"),
    [
        ("duplicate_id", changed(modules=[*MAP["modules"], _module(id="module:billing")])),
        ("duplicate_id", changed(jobs=[*MAP["jobs"], {"id": "job:nightly-sync",
                                                       "module": "module:billing"}])),
        ("bad_prefix", changed(apis=[{"id": "module:invoices", "method": "GET",
                                      "path": "/v1/invoices", "module": "module:billing"}])),
        ("unresolved_ref", changed(apis=[{"id": "api:x", "method": "GET", "path": "/v1/x",
                                          "module": "module:ghost"}])),
        ("unresolved_ref", changed(modules=[*MAP["modules"],
                                            _module(depends_on=["module:ghost"])])),
        ("bad_path", changed(modules=[*MAP["modules"], _module(path="/etc/app")])),
        ("bad_path", changed(modules=[*MAP["modules"], _module(path="api/../secrets")])),
        ("bad_path", changed(modules=[*MAP["modules"], _module(path="C:\\app")])),
        ("wrong_version", changed(version=2)),
        ("bad_entry", changed(modules=[{"path": "api/x"}])),
        ("bad_entry", changed(partial="yes")),
        ("bad_entry", changed(repo="")),
    ],
)  # fmt: skip
def test_each_problem_code_is_reported(code, data):
    # protects=AC4 duplicate ids, ids not prefixed by their kind, unresolved module refs,
    # absolute or parent paths are refused; fails_when=such a map is stored as ready.
    assert code in codes(codemap.check(text(data)))


def test_unreadable_and_oversized_files_are_refused():
    # protects=AC4 the 2 MB cap and unreadable text; fails_when=a huge or broken file is
    # parsed or stored.
    assert codes(codemap.check("{not json")) == {"unreadable"}
    assert codes(codemap.check("[1, 2]")) == {"unreadable"}
    huge = changed(modules=[*MAP["modules"], _module(summary="x" * (2 * 1024 * 1024))])
    assert codes(codemap.check(text(huge))) == {"too_large"}
    nested = "[" * 100_000 + "]" * 100_000
    assert codes(codemap.check(nested)) == {"unreadable"}


@pytest.mark.parametrize("number", ["NaN", "Infinity", "-Infinity", "1e999", "-1e999"])
def test_numbers_that_are_not_finite_are_refused(number):
    # protects=a map with NaN or Infinity (JSONB refuses them) is refused as it is read,
    # with a clear reason; fails_when=it checks clean and its store fails.
    raw = text(MAP).replace('"version": 1', f'"version": 1, "weight": {number}')
    problems = codemap.check(raw)
    assert codes(problems) == {"unreadable"}
    assert "finite" in problems[0].message


@pytest.mark.parametrize(
    "data",
    [
        changed(repo="example-org/a\u0000pp"),
        changed(modules=[*MAP["modules"], _module(summary="a\u0000b")]),
        changed(extra={"k\u0000": 1}),
    ],
)
def test_nul_characters_are_refused(data):
    # protects=a map with a NUL character (JSONB text refuses it), in a value or a key,
    # is refused as it is read, with a clear reason; fails_when=it checks clean and its
    # store fails.
    raw = text(data)
    assert "\\u0000" in raw
    problems = codemap.check(raw)
    assert codes(problems) == {"unreadable"}
    assert "NUL" in problems[0].message


def test_a_docs_only_map_is_marked_partial():
    # protects=the fallback until the checkout is available: a map built from synced
    # docs says so; fails_when=partial is lost or a non-boolean passes.
    data = changed(partial=True)
    assert codemap.check(text(data)) == []
    assert codemap.parse(text(data))["partial"] is True
    assert "Docs only: code not read" in codemap.summary(data)


def test_the_summary_lists_what_the_map_holds():
    summary = codemap.summary(MAP)
    assert REPO in summary and "3f2c9a1" in summary
    assert "module:billing" in summary and "api:create-invoice" in summary


# --------------------------------------------------------------------------- the flow


def test_the_code_map_flow_has_one_indexer_segment_without_a_checkpoint():
    # protects=the code_map flow (one segment, role indexer, no checkpoint, writes
    # code_map.json) and the optional checkpoint; fails_when=the flow opens a stop or the
    # catalog cannot describe it.
    flow = flows.FLOWS["code_map"]
    (segment,) = flow.segments
    assert (segment.name, segment.roles, segment.checkpoint) == ("index", ("indexer",), None)
    assert segment.outputs == (codemap.FILE,)
    assert flow.checkpoints == ()
    assert flows.ROLES["indexer"].title == "Indexer"
    assert not flow.in_new_run_dialog and not flow.writes_document
    assert "list_code_maps" in flows.MCP_TOOLS and "get_code_map" in flows.MCP_TOOLS
    assert "data" in segment.task and "instructions" in segment.task


async def test_the_flow_catalog_shows_a_segment_without_a_checkpoint(client):
    tenant_id, auth = await seed_auth()
    catalog = (await client.get("/v1/flows", headers=auth)).json()
    flow = next(f for f in catalog["flows"] if f["key"] == "code_map")
    assert flow["segments"][0]["checkpoint"] is None


# --------------------------------------------------------------------------- runs


@pytest.fixture
def map_runtime():
    fake = FakeRuntime({"index": [Outcome(artifacts={codemap.FILE: text(MAP)})]})
    set_runtime(fake)
    yield fake
    set_runtime(None)


@pytest.fixture
def bad_map_runtime():
    bad = changed(apis=[{"id": "api:x", "method": "GET", "path": "/v1/x", "module": "module:no"}])
    fake = FakeRuntime({"index": [Outcome(artifacts={codemap.FILE: text(bad)})]})
    set_runtime(fake)
    yield fake
    set_runtime(None)


async def github_source(tenant_id, person, repos=(REPO,), name="App repo") -> uuid.UUID:
    conn = await add_connection(tenant_id, person.user.id, "github")
    async with tenant_session(tenant_id) as s:
        source = Source(
            owner_user_id=person.user.id,
            connection_id=conn.id,
            kind="github",
            name=name,
            config={"repos": list(repos)},
            status="active",
        )
        s.add(source)
        await s.commit()
        return source.id


_TICKERS: dict[uuid.UUID, dict[str, str]] = {}


async def tick(client, tenant_id: uuid.UUID) -> None:
    """The company's tick, as its owner (the tick is the owner's or an API token's)."""
    if tenant_id not in _TICKERS:
        person = await make_person(tenant_id, f"ticker-{uuid.uuid4().hex[:6]}@example.com")
        _TICKERS[tenant_id] = person.headers
    resp = await client.post("/v1/internal/tick", headers=_TICKERS[tenant_id])
    assert resp.status_code == 200 and resp.json()["errors"] == [], resp.text


async def request_map(client, person, source_id, repo=REPO):
    return await client.post(
        "/v1/code-maps", json={"source_id": str(source_id), "repo": repo}, headers=person.headers
    )


async def built_map(client, tenant_id, owner) -> dict:
    """A map the owner requested, built by the fake indexer."""
    source_id = await github_source(tenant_id, owner)
    resp = await request_map(client, owner, source_id)
    assert resp.status_code == 201, resp.text
    await tick(client, tenant_id)
    got = await client.get(f"/v1/code-maps/{resp.json()['id']}", headers=owner.headers)
    assert got.status_code == 200, got.text
    return got.json()


async def test_the_sources_owner_maps_the_code(client, map_runtime):
    # protects=AC5 Map the code drafts a code_map run, starts it after its estimate, and
    # a valid map is stored ready with its content and as_of; fails_when=no run starts,
    # the map is not stored or not audited; no_claim=the indexer reads the code (the
    # fake runtime writes the file).
    tenant_id = await make_tenant()
    owner = await make_person(tenant_id, "dev@example.com", "approver")
    source_id = await github_source(tenant_id, owner)
    resp = await request_map(client, owner, source_id)
    assert resp.status_code == 201, resp.text
    out = resp.json()
    assert out["status"] == "building" and out["sharing"] == "private" and out["mine"] is True
    assert out["repo"] == REPO and out["run_id"]
    async with tenant_session(tenant_id) as s:
        run = await s.get(Run, uuid.UUID(out["run_id"]))
        assert run.flow == "code_map" and run.status == "running"
        assert run.estimate_usd is not None and run.created_by == owner.user.id
        actions = set(await s.scalars(select(AuditEvent.action)))
        assert {"code_map.requested", "run.started"} <= actions

    # A second request while one builds is refused.
    assert (await request_map(client, owner, source_id)).status_code == 409

    await tick(client, tenant_id)
    got = (await client.get(f"/v1/code-maps/{out['id']}", headers=owner.headers)).json()
    assert got["status"] == "ready" and got["commit_sha"] == "3f2c9a1"
    assert got["as_of"].startswith("2026-10-18T10:00:00")
    assert got["content"]["modules"][0]["id"] == "module:billing"
    assert got["counts"] == {"modules": 2, "apis": 1, "data_models": 1, "flags": 1, "jobs": 1}
    assert got["size_bytes"] > 0 and got["partial"] is False
    async with tenant_session(tenant_id) as s:
        run = await s.get(Run, uuid.UUID(out["run_id"]))
        assert run.status == "succeeded"
        # No stop: the flow has no checkpoint.
        assert list(await s.scalars(select(Checkpoint).where(Checkpoint.run_id == run.id))) == []


async def test_an_invalid_map_is_stored_failed_with_its_problems(client, bad_map_runtime):
    # protects=AC5 an invalid map stores failed with the problems; fails_when=it is
    # stored ready or the run succeeds.
    tenant_id = await make_tenant()
    owner = await make_person(tenant_id, "dev@example.com", "commenter")
    source_id = await github_source(tenant_id, owner)
    out = (await request_map(client, owner, source_id)).json()
    await tick(client, tenant_id)
    got = (await client.get(f"/v1/code-maps/{out['id']}", headers=owner.headers)).json()
    assert got["status"] == "failed" and got["content"] is None
    assert "unresolved_ref" in got["error"] and "module:no" in got["error"]
    async with tenant_session(tenant_id) as s:
        assert (await s.get(Run, uuid.UUID(out["run_id"]))).status == "failed"


async def test_the_map_is_read_once_on_the_parse_pool(client, map_runtime, monkeypatch):
    # protects=the importer reads the untrusted code_map.json once, on the parse pool
    # (oracle.safe_yaml.run_parse_within); fails_when=it is parsed on the event loop or
    # twice.
    import threading

    from oracle import safe_yaml

    loop_thread = threading.get_ident()
    loads: list[int] = []
    pooled: list[str] = []
    real_load, real_within = codemap._load, safe_yaml.run_parse_within

    def load(raw):
        loads.append(threading.get_ident())
        return real_load(raw)

    async def within(fn, /, *args, **kwargs):
        pooled.append(kwargs.get("name", ""))
        return await real_within(fn, *args, **kwargs)

    monkeypatch.setattr(codemap, "_load", load)
    monkeypatch.setattr(safe_yaml, "run_parse_within", within)
    tenant_id = await make_tenant()
    owner = await make_person(tenant_id, "dev@example.com", "commenter")
    got = await built_map(client, tenant_id, owner)
    assert got["status"] == "ready"
    assert len(loads) == 1 and loads[0] != loop_thread
    assert codemap.FILE in pooled


@pytest.mark.parametrize(
    ("raw", "reason"),
    [
        (text(MAP).replace('"version": 1', '"version": 1, "weight": NaN'), "finite"),
        (text(MAP).replace('"version": 1', '"version": 1, "weight": Infinity'), "finite"),
        (text(changed(jobs=[{"id": "job:a\u0000", "module": "module:billing"}])), "NUL"),
    ],
    ids=["nan", "infinity", "nul"],
)
async def test_a_map_jsonb_refuses_ends_failed_with_the_reason(client, raw, reason):
    # protects=a map with NaN, Infinity or a NUL character ends failed with that reason
    # (and its run fails); fails_when=the store raises and the map stays building with a
    # generic error.
    fake = FakeRuntime({"index": [Outcome(artifacts={codemap.FILE: raw})]})
    set_runtime(fake)
    try:
        tenant_id = await make_tenant()
        owner = await make_person(tenant_id, "dev@example.com", "commenter")
        source_id = await github_source(tenant_id, owner)
        out = (await request_map(client, owner, source_id)).json()
        await tick(client, tenant_id)
    finally:
        set_runtime(None)
    got = (await client.get(f"/v1/code-maps/{out['id']}", headers=owner.headers)).json()
    assert got["status"] == "failed" and got["content"] is None
    assert "[unreadable]" in got["error"] and reason in got["error"]
    async with tenant_session(tenant_id) as s:
        run = await s.get(Run, uuid.UUID(out["run_id"]))
        assert run.status == "failed"


async def test_only_the_sources_owner_maps_its_repos(client, map_runtime):
    # protects=start_code_map is the source's owner's, for a repo of a GitHub source;
    # fails_when=another member maps someone's source or an unlisted repo is mapped.
    tenant_id = await make_tenant()
    owner = await make_person(tenant_id, "dev@example.com", "commenter")
    other = await make_person(tenant_id, "pm@example.com", "owner")
    source_id = await github_source(tenant_id, owner)
    assert (await request_map(client, other, source_id)).status_code == 404
    assert (await request_map(client, owner, source_id, "example-org/other")).status_code == 422
    assert (await request_map(client, owner, uuid.uuid4())).status_code == 404
    # Mapping is one of the source's writes: a viewer's own source is refused.
    viewer = await make_person(tenant_id, "viewer@example.com", "viewer")
    viewers = await github_source(tenant_id, viewer, name="Viewer repo")
    assert (await request_map(client, viewer, viewers)).status_code == 403
    async with tenant_session(tenant_id) as s:
        slack = Source(owner_user_id=owner.user.id, kind="slack", name="Chat",
                       config={"channels": ["C1"]}, status="active")  # fmt: skip
        s.add(slack)
        await s.commit()
    assert (await request_map(client, owner, slack.id)).status_code == 422


async def test_a_run_over_the_threshold_waits_for_an_owner(client, map_runtime, monkeypatch):
    # protects=P3 gating: a code_map run over $50 waits for an owner's approval; the map
    # stays building; fails_when=it starts without approval.
    monkeypatch.setattr(flows, "APPROVAL_THRESHOLD_USD", flows.ROLES["indexer"].base_usd / 4)
    tenant_id = await make_tenant()
    owner = await make_person(tenant_id, "dev@example.com", "commenter")
    out = (await request_map(client, owner, await github_source(tenant_id, owner))).json()
    assert out["status"] == "building" and out["run_status"] == "awaiting_approval"


async def test_a_run_that_fails_marks_its_map_failed(client):
    # protects=a map never stays building after its run failed at the runtime;
    # fails_when=the row stays building and blocks Map the code forever.
    set_runtime(FakeRuntime({"index": [Outcome(state="failed", error="runtime down")]}))
    try:
        tenant_id = await make_tenant()
        owner = await make_person(tenant_id, "dev@example.com", "owner")
        source_id = await github_source(tenant_id, owner)
        out = (await request_map(client, owner, source_id)).json()
        await tick(client, tenant_id)
        await tick(client, tenant_id)
        got = (await client.get(f"/v1/code-maps/{out['id']}", headers=owner.headers)).json()
        assert got["status"] == "failed" and got["error"]
    finally:
        set_runtime(None)


# --------------------------------------------------------------------------- who sees it


async def test_a_private_map_is_the_owners_until_shared_in_full(client, map_runtime):
    # protects=AC6 and AC9 (S6): a private map is a 404 to another member, absent for a
    # run token and from capability_map(); after sharing: full, all three see it; lowering
    # it back stops new uses; audited; fails_when=a private map leaks to anyone but the
    # source's owner, or a shared one stays hidden.
    tenant_id = await make_tenant()
    owner = await make_person(tenant_id, "dev@example.com", "commenter")
    other = await make_person(tenant_id, "pm@example.com", "owner")
    got = await built_map(client, tenant_id, owner)
    map_id = got["id"]
    assert got["sharing"] == "private"

    assert (await client.get(f"/v1/code-maps/{map_id}", headers=other.headers)).status_code == 404
    assert (await client.get("/v1/code-maps", headers=other.headers)).json() == []
    token = await run_token(tenant_id, ["read:sources"], owner.user.id)
    async with mcp_client(token) as c:
        listed = await c.call_tool("list_code_maps", {})
        assert not listed.is_error, text_of(listed)
        assert listed.structured_content["result"] == []
        one = await c.call_tool("get_code_map", {"code_map_id": map_id})
        assert one.is_error
    async with tenant_session(tenant_id) as s:
        assert await capability_map(s) is None

    # Only the source's owner shares it.
    share = {"sharing": "full"}
    resp = await client.post(f"/v1/code-maps/{map_id}/sharing", json=share, headers=other.headers)
    assert resp.status_code == 404
    resp = await client.post(f"/v1/code-maps/{map_id}/sharing", json=share, headers=owner.headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["sharing"] == "full" and resp.json()["shared_by"] == str(owner.user.id)

    seen = await client.get(f"/v1/code-maps/{map_id}", headers=other.headers)
    assert seen.status_code == 200 and seen.json()["mine"] is False
    assert [m["id"] for m in (await client.get("/v1/code-maps", headers=other.headers)).json()] == [
        map_id
    ]
    async with mcp_client(token) as c:
        listed = await c.call_tool("list_code_maps", {})
        assert [m["id"] for m in listed.structured_content["result"]] == [map_id]
        one = await c.call_tool("get_code_map", {"code_map_id": map_id})
        assert not one.is_error and one.structured_content["content"]["repo"] == REPO
    async with tenant_session(tenant_id) as s:
        cmap = await capability_map(s)
        assert cmap is not None and "module:billing" in cmap.summary
        assert cmap.as_of and cmap.as_of.startswith("2026-10-18")

    private = {"sharing": "private"}
    resp = await client.post(f"/v1/code-maps/{map_id}/sharing", json=private, headers=owner.headers)
    assert resp.status_code == 200
    assert (await client.get(f"/v1/code-maps/{map_id}", headers=other.headers)).status_code == 404
    async with tenant_session(tenant_id) as s:
        assert await capability_map(s) is None
        actions = list(await s.scalars(select(AuditEvent.action)))
        assert "code_map.shared" in actions and "code_map.unshared" in actions


async def test_list_filters_by_repo_and_status(client, map_runtime):
    tenant_id = await make_tenant()
    owner = await make_person(tenant_id, "dev@example.com", "commenter")
    got = await built_map(client, tenant_id, owner)
    h = owner.headers
    ready = (await client.get("/v1/code-maps?status=ready", headers=h)).json()
    assert [m["id"] for m in ready] == [got["id"]]
    assert (await client.get("/v1/code-maps?status=failed", headers=h)).json() == []
    assert (await client.get("/v1/code-maps?repo=example-org/none", headers=h)).json() == []
    listed = (await client.get(f"/v1/code-maps?repo={REPO}", headers=h)).json()
    assert len(listed) == 1 and "content" not in listed[0]


async def test_another_companys_maps_are_404(client, map_runtime):
    # protects=AC9 every route is company-scoped; fails_when=an id of another company
    # reads or shares.
    tenant_id = await make_tenant()
    owner = await make_person(tenant_id, "dev@example.com", "commenter")
    got = await built_map(client, tenant_id, owner)
    await client.post(f"/v1/code-maps/{got['id']}/sharing", json={"sharing": "full"},
                      headers=owner.headers)  # fmt: skip
    other_co = await make_tenant("Other Co")
    stranger = await make_person(other_co, "owner@example.org", "owner")
    resp = await client.get(f"/v1/code-maps/{got['id']}", headers=stranger.headers)
    assert resp.status_code == 404
    assert (await client.get("/v1/code-maps", headers=stranger.headers)).json() == []
    resp = await client.post(f"/v1/code-maps/{got['id']}/sharing", json={"sharing": "private"},
                             headers=stranger.headers)  # fmt: skip
    assert resp.status_code == 404


async def test_deleting_or_narrowing_the_source_deletes_its_maps(client, map_runtime):
    # protects=S5's narrowing rule: a repo dropped from the source's allowlist, or the
    # source deleted, takes its maps with it; fails_when=a map outlives its source.
    tenant_id = await make_tenant()
    owner = await make_person(tenant_id, "dev@example.com", "commenter")
    source_id = await github_source(tenant_id, owner, repos=(REPO, "example-org/web"))
    first = (await request_map(client, owner, source_id)).json()
    await tick(client, tenant_id)
    async with tenant_session(tenant_id) as s:
        from oracle.engineering import codemaps

        source = await s.get(Source, source_id)
        source.config = {"repos": ["example-org/web"]}
        await codemaps.drop_outside(s, source)
        await s.commit()
        assert await s.get(CodeMap, uuid.UUID(first["id"])) is None
    async with tenant_session(tenant_id) as s:
        s.add(CodeMap(source_id=source_id, repo="example-org/web", status="failed"))
        await s.commit()
    assert (await client.delete(f"/v1/sources/{source_id}", headers=owner.headers)).is_success
    async with tenant_session(tenant_id) as s:
        assert list(await s.scalars(select(CodeMap))) == []


# --------------------------------------------------------------------------- refresh


def merged_pr(number: int, merged_at: datetime) -> base.ItemUpsert:
    repo = github._Repo(
        key=REPO, full_name=REPO, html_url=f"https://github.com/{REPO}",
        default_branch="main", acl={"visibility": "private", "repo": REPO},
    )  # fmt: skip
    stamp = merged_at.isoformat().replace("+00:00", "Z")
    return github._issue_item(
        repo,
        {
            "number": number, "title": f"Change {number}", "state": "closed",
            "pull_request": {"merged_at": stamp}, "created_at": stamp, "updated_at": stamp,
        },
    )  # fmt: skip


def sync_yielding(monkeypatch, events: list):
    connector = base._registry["github"]

    async def fake(config, credential, cursor, **kw):
        for e in list(events):
            yield e
        events.clear()

    monkeypatch.setattr(connector, "sync", fake)


async def sync(client, person, source_id) -> None:
    resp = await client.post(f"/v1/sources/{source_id}/sync", headers=person.headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["outcome"] == "completed", resp.text


async def maps_of(tenant_id) -> list[CodeMap]:
    async with tenant_session(tenant_id) as s:
        return list(await s.scalars(select(CodeMap).order_by(CodeMap.created_at)))


async def age(tenant_id, map_id, hours: float) -> None:
    async with tenant_session(tenant_id) as s:
        row = await s.get(CodeMap, uuid.UUID(map_id))
        row.created_at = datetime.now(UTC) - timedelta(hours=hours)
        await s.commit()


async def test_a_merge_marks_the_map_stale_and_the_tick_refreshes_it_once(
    client, map_runtime, monkeypatch
):
    # protects=AC7 a sync seeing a merged pull request marks the map stale; the tick
    # starts exactly one refresh run; a merge during the refresh coalesces into one
    # follow-up, and a merge within the day of the last start starts none (the company's
    # default spacing, daily); fails_when=a merge goes unnoticed, the tick starts two runs,
    # or refreshes more than daily; no_claim=the pull request's base branch (the GitHub
    # list does not say it).
    tenant_id = await make_tenant()
    owner = await make_person(tenant_id, "dev@example.com", "commenter")
    got = await built_map(client, tenant_id, owner)
    source_id = got["source_id"]
    await age(tenant_id, got["id"], 25)
    events: list = []
    sync_yielding(monkeypatch, events)

    # A pull request merged before the map was built does not make it stale.
    events.append(merged_pr(1, datetime.now(UTC) - timedelta(hours=3)))
    await sync(client, owner, source_id)
    assert [m.status for m in await maps_of(tenant_id)] == ["ready"]

    events.append(merged_pr(2, datetime.now(UTC)))
    await sync(client, owner, source_id)
    assert [m.status for m in await maps_of(tenant_id)] == ["stale"]

    # The refresh reads the merged commit.
    refreshed = text(changed(commit="4a5b6c7"))
    set_runtime(FakeRuntime({"index": [Outcome(artifacts={codemap.FILE: refreshed}, polls=5)]}))
    await tick(client, tenant_id)
    rows = await maps_of(tenant_id)
    assert [m.status for m in rows] == ["stale", "building"]
    async with tenant_session(tenant_id) as s:
        runs = list(await s.scalars(select(Run).where(Run.flow == "code_map")))
        assert len(runs) == 2 and runs[-1].created_by == owner.user.id
    await tick(client, tenant_id)
    assert len(await maps_of(tenant_id)) == 2

    # Merges during the refresh: one follow-up, once the refresh ends.
    events += [merged_pr(3, datetime.now(UTC)), merged_pr(4, datetime.now(UTC))]
    await sync(client, owner, source_id)
    for _ in range(6):
        await tick(client, tenant_id)
    rows = await maps_of(tenant_id)
    assert [m.status for m in rows][:2] == ["stale", "stale"]
    # The refresh started within the day: no run yet.
    assert len(rows) == 2
    await age(tenant_id, str(rows[1].id), 25)
    await tick(client, tenant_id)
    assert [m.status for m in await maps_of(tenant_id)][-1] == "building"
    assert len(await maps_of(tenant_id)) == 3


async def test_a_refresh_keeps_the_maps_sharing(client, map_runtime, monkeypatch):
    # protects=a refreshed map is shared as the one it replaces; fails_when=a refresh
    # makes a shared map private (runs lose it) or a private one shared.
    tenant_id = await make_tenant()
    owner = await make_person(tenant_id, "dev@example.com", "commenter")
    got = await built_map(client, tenant_id, owner)
    await client.post(f"/v1/code-maps/{got['id']}/sharing", json={"sharing": "full"},
                      headers=owner.headers)  # fmt: skip
    await age(tenant_id, got["id"], 25)
    events = [merged_pr(9, datetime.now(UTC))]
    sync_yielding(monkeypatch, events)
    await sync(client, owner, got["source_id"])
    refreshed = text(changed(commit="4a5b6c7"))
    set_runtime(FakeRuntime({"index": [Outcome(artifacts={codemap.FILE: refreshed})]}))
    await tick(client, tenant_id)
    await tick(client, tenant_id)
    rows = await maps_of(tenant_id)
    assert [(m.status, m.sharing) for m in rows] == [("stale", "full"), ("ready", "full")]


# --------------------------------------------------------------------------- refresh setting


async def stale_map(client, tenant_id, owner) -> dict:
    """A built map a merge has made stale (the merge itself is the sync test's)."""
    got = await built_map(client, tenant_id, owner)
    async with tenant_session(tenant_id) as s:
        row = await s.get(CodeMap, uuid.UUID(got["id"]))
        row.status = "stale"
        await s.commit()
    return got


async def choose(client, tenant_id, value) -> dict:
    boss = await make_person(tenant_id, f"boss-{uuid.uuid4().hex[:6]}@example.com", "owner")
    resp = await client.put(
        "/v1/settings/code_map_refresh", json={"value": value}, headers=boss.headers
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


@pytest.mark.parametrize(
    "choice, hours",
    [("hourly", 1), ("every_6_hours", 6), ("daily", 24), ("weekly", 168)],
)
async def test_each_refresh_choice_spaces_the_tick_refresh(client, map_runtime, choice, hours):
    # protects=the company's 'Refresh stale code maps' choice is the spacing the tick keeps
    # between a repo's last map run and its refresh: none just inside it, one just past it;
    # fails_when=the tick still refreshes hourly whatever the company chose, or never;
    # no_claim=the merge that made the map stale (the sync test).
    tenant_id = await make_tenant()
    owner = await make_person(tenant_id, "dev@example.com", "commenter")
    got = await stale_map(client, tenant_id, owner)
    await choose(client, tenant_id, choice)
    await age(tenant_id, got["id"], hours - 0.25)
    await tick(client, tenant_id)
    assert [m.status for m in await maps_of(tenant_id)] == ["stale"]
    await age(tenant_id, got["id"], hours + 0.25)
    await tick(client, tenant_id)
    assert [m.status for m in await maps_of(tenant_id)] == ["stale", "building"]


async def test_only_on_demand_never_refreshes_and_map_the_code_still_does(client, map_runtime):
    # protects=only on demand: the tick never refreshes a stale map, however old; Map the
    # code refreshes it at once; fails_when=the tick refreshes on demand, or Map the code is
    # refused on a stale map; no_claim=the run's cost approval (P3's tests).
    tenant_id = await make_tenant()
    owner = await make_person(tenant_id, "dev@example.com", "commenter")
    got = await stale_map(client, tenant_id, owner)
    await choose(client, tenant_id, "on_demand")
    await age(tenant_id, got["id"], 24 * 400)
    for _ in range(3):
        await tick(client, tenant_id)
    assert [m.status for m in await maps_of(tenant_id)] == ["stale"]
    resp = await request_map(client, owner, got["source_id"])
    assert resp.status_code == 201, resp.text
    assert resp.json()["status"] == "building"


async def test_a_company_that_never_chose_refreshes_daily(client, map_runtime):
    # protects=the default is daily: GET settings names it, a stale map 2 hours after its run
    # waits, one a day after refreshes; fails_when=the old hourly spacing stays the default;
    # no_claim=the other choices (the parametrized test).
    tenant_id = await make_tenant()
    owner = await make_person(tenant_id, "dev@example.com", "commenter")
    boss = await make_person(tenant_id, "boss@example.com", "owner")
    resp = await client.get("/v1/settings/code_map_refresh", headers=boss.headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["value"] == "daily" and resp.json()["is_default"] is True
    listed = await client.get("/v1/settings", headers=boss.headers)
    assert "code_map_refresh" in {s["key"] for s in listed.json()}
    got = await stale_map(client, tenant_id, owner)
    await age(tenant_id, got["id"], 2)
    await tick(client, tenant_id)
    assert [m.status for m in await maps_of(tenant_id)] == ["stale"]
    await age(tenant_id, got["id"], 25)
    await tick(client, tenant_id)
    assert [m.status for m in await maps_of(tenant_id)] == ["stale", "building"]


async def test_the_refresh_setting_is_an_owners_and_audited(client):
    # protects=only owners change 'Refresh stale code maps', an unknown choice is 422, and a
    # change is an audit entry with its value; fails_when=an approver changes it, a typo is
    # stored, or the change leaves no trace; no_claim=the other settings' checks.
    tenant_id = await make_tenant()
    boss = await make_person(tenant_id, "boss@example.com", "owner")
    lead = await make_person(tenant_id, "lead@example.com", "approver")
    url = "/v1/settings/code_map_refresh"
    denied = await client.put(url, json={"value": "weekly"}, headers=lead.headers)
    assert denied.status_code == 403
    bad = await client.put(url, json={"value": "monthly"}, headers=boss.headers)
    assert bad.status_code == 422 and "hourly" in bad.text
    ok = await client.put(url, json={"value": "weekly"}, headers=boss.headers)
    assert ok.status_code == 200 and ok.json()["value"] == "weekly"
    async with tenant_session(tenant_id) as s:
        events = list(
            await s.scalars(select(AuditEvent).where(AuditEvent.action == "setting.update"))
        )
        assert any(e.data == {"key": "code_map_refresh", "value": "weekly"} for e in events)


# --------------------------------------------------------------------------- runs use it


async def shared_map(tenant_id, content: dict, *, repo: str = REPO) -> uuid.UUID:
    owner = await make_person(tenant_id, f"dev-{uuid.uuid4().hex[:6]}@example.com", "commenter")
    source_id = await github_source(tenant_id, owner, repos=(repo,))
    async with tenant_session(tenant_id) as s:
        row = CodeMap(
            source_id=source_id, repo=repo, commit_sha=content["commit"], status="ready",
            sharing="full", shared_by=owner.user.id, shared_at=datetime.now(UTC),
            content=content, size_bytes=len(text(content)),
            as_of=datetime(2026, 10, 18, 10, tzinfo=UTC),
        )  # fmt: skip
        s.add(row)
        await s.commit()
        return row.id


@pytest.fixture
def eng_flow(monkeypatch):
    from tests.tech_brief_helpers import flow_with_eng_check

    monkeypatch.setitem(flows.FLOWS, "baseline_to_prd", flow_with_eng_check())


@pytest.fixture
def briefs_runtime():
    fake = FakeRuntime({"eng_check": [Outcome(artifacts={flows.BRIEFS_FILE: SAMPLE})]})
    set_runtime(fake)
    yield fake
    set_runtime(None)


async def test_a_run_records_the_code_maps_it_used_and_briefs_are_checked_against_them(
    client, eng_flow, briefs_runtime
):
    # protects=F5-1's unchecked registration checks refs against the shared maps the run
    # recorded at its start: a brief citing the map's ids is registered; fails_when=the
    # run records no map, or a brief whose refs the map holds is refused as unknown_ref.
    from tests.test_tech_briefs import advance_to, brief_rows, start

    tenant_id, auth = await seed_auth()
    await seed_features(tenant_id)
    map_id = await shared_map(tenant_id, MAP)
    run = await start(client, auth, "mapped-prd", checkpoints={"eng_review": False})
    async with tenant_session(tenant_id) as s:
        row = await s.get(Run, uuid.UUID(run["id"]))
        assert row.knobs["code_maps"] == [
            {"id": str(map_id), "repo": REPO, "commit": "3f2c9a1",
             "as_of": "2026-10-18T10:00:00+00:00"}
        ]  # fmt: skip
    await advance_to(client, auth, run["id"], "prd_review")
    rows = await brief_rows(tenant_id)
    assert sorted(req.params["feature_key"] for req, _ in rows) == ["feature-a", "feature-b"]


async def test_a_brief_citing_a_docs_only_map_is_marked_partial(client, eng_flow, briefs_runtime):
    # protects=briefs cite a docs-only map with its label: Oracle sets partial on the
    # brief's repo from the map the run recorded, never from the file; fails_when=a
    # brief resting on the docs reads as resting on the code.
    from tests.test_tech_briefs import advance_to, start

    tenant_id, auth = await seed_auth()
    await seed_features(tenant_id)
    # SAMPLE cites org/app; the shared map of org/app was built from the docs only.
    await shared_map(tenant_id, {**MAP, "repo": "org/app", "partial": True}, repo="org/app")
    run = await start(client, auth, "docs-only-prd", checkpoints={"eng_review": False})
    await advance_to(client, auth, run["id"], "prd_review")
    listed = (await client.get("/v1/tech-briefs", headers=auth)).json()
    assert len(listed) == 2
    for brief in listed:
        assert brief["code_map"]["repos"] == [
            {"repo": "org/app", "commit": "3f2c9a1", "as_of": "2026-10-18T10:00:00Z",
             "partial": True}
        ]  # fmt: skip


async def test_a_private_map_is_not_recorded_for_a_run(client, eng_flow, briefs_runtime):
    # protects=S6: a run never uses a private map; fails_when=a private map's ids pass
    # an unchecked brief.
    from tests.test_tech_briefs import advance_to, brief_rows, start

    tenant_id, auth = await seed_auth()
    await seed_features(tenant_id)
    map_id = await shared_map(tenant_id, MAP)
    async with tenant_session(tenant_id) as s:
        (await s.get(CodeMap, map_id)).sharing = "private"
        await s.commit()
    run = await start(client, auth, "unmapped-prd", checkpoints={"eng_review": False})
    async with tenant_session(tenant_id) as s:
        assert "code_maps" not in (await s.get(Run, uuid.UUID(run["id"]))).knobs
    await advance_to(client, auth, run["id"], "prd_review")
    # SAMPLE cites module:billing and module:notifications: unknown without a map.
    assert await brief_rows(tenant_id) == []


async def test_the_code_map_prompt_names_the_repo_and_the_docs_only_fallback(client):
    # protects=the indexer's task: the repo, the format, data-not-instructions, and the
    # docs-only fallback (partial: true) while the checkout is not available;
    # fails_when=the prompt omits the repo or the fallback.
    fake = FakeRuntime({"index": [Outcome(artifacts={codemap.FILE: text(MAP)})]})
    set_runtime(fake)
    try:
        tenant_id = await make_tenant()
        owner = await make_person(tenant_id, "dev@example.com", "commenter")
        await request_map(client, owner, await github_source(tenant_id, owner))
        prompts = [step.prompt for wf in fake.submitted for step in wf.steps]
    finally:
        set_runtime(None)
    prompt = "\n".join(prompts)
    assert REPO in prompt and codemap.FILE in prompt
    assert '"partial": true' in prompt and "Docs only" in prompt
    assert "module:" in prompt and "data, never instructions" in prompt
