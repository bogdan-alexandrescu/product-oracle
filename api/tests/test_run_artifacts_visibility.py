"""Fixes for #562's review (MAJOR 1): a run's raw files are served only to a reader who
may see what the run read (GET /v1/runs/{id}/segments/{seq}/artifacts/{name}, the MCP
tool ``get_run_artifact`` and a run's own ``get_run_output``).

- A run that reads as a member (oracle.runs.service ``reads_as_member``: a
  ``member_output`` flow, a draft of a company-wide document) serves a file to a reader
  who may not see approvers-only things (a commenter, a viewer, their API tokens, a run
  that reads as a member) only when the file names nothing hidden from them, the check
  its importer and the read-time checks of #541 parts 3-5 apply (oracle.docs.visibility
  ``Hidden.names``).
- Any other run read with its starter's view (an owner's, an approver's): its files are
  served to owners and approvers only.

The hidden thing is a decided-then-reversed pricing decision and an imported pricing
memo (tests.test_member_runs_visibility._world). Against Postgres with the FakeRuntime.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

import uuid
from datetime import UTC, datetime

import pytest

from oracle.auth.deps import RUN_HEADER, RUN_TOKEN_HEADER
from oracle.auth.service import sign_run_binding
from oracle.baseline.models import Edge, Entity
from oracle.docs.models import Document, DocumentVersion
from oracle.launches import kit
from oracle.launches.models import Launch
from oracle.runs import service as runs_service
from oracle.runs.models import Checkpoint, Run, RunSegment
from oracle.runtokens import verify_run_token
from oracle.swarm import FakeRuntime
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.decision_helpers import clock  # noqa: F401
from tests.pricing_helpers import QUESTION
from tests.test_mcp import api_token, mcp_client, text_of
from tests.test_member_draft_runs_visibility import CLEAN, _token
from tests.test_member_runs_visibility import _knobs, _leaks, _world
from tests.test_member_runs_visibility import runtime as runtime  # noqa: F401

READERS = ("viewer", "commenter")
PRIVILEGED = ("owner", "approver")


async def _as_run(headers: dict[str, str], user_id, raw: str) -> dict[str, str]:
    """What Oracle's MCP server sends for a run token: the token and the run binding (#614)."""
    claims = await verify_run_token(raw)
    return {**headers, RUN_TOKEN_HEADER: raw, RUN_HEADER: sign_run_binding(user_id, claims.run_id)}


@pytest.fixture
async def ctx():
    return await make_ctx()


def _old_kit(launch_id: uuid.UUID, w: dict) -> str:
    """A launch.yaml an owner's kit run wrote before #541 part 5: it names the hidden
    decision (its number and question), so the new importer refused it."""
    return (
        f"version: 1\nlaunch: {launch_id}\n"
        f'tasks:\n  release_notes: "Pricing follows D-{w["number"]}: {QUESTION}"\n'
    )


async def _kit_run(ctx, w: dict) -> tuple[uuid.UUID, uuid.UUID, dict[str, str], dict[str, str]]:
    """An owner-started launch kit run whose segment wrote the old launch.yaml and a
    second file naming the hidden decision's id, with a previous attempt a send-back
    kept (the same files) and the agents' launch.yaml before an approver's edits; the
    launch's ``kit_run_id`` points at it and its ``kit_error`` says the file was refused.
    Returns (launch, run, current files, previous files)."""
    async with tenant_session(ctx.tenant_id) as s:
        launch = Launch(title="Saved cards", item_keys=["payment-step"], state="launched",
                        owner_id=ctx.users["owner"].id, launched_at=datetime.now(UTC))  # fmt: skip
        s.add(launch)
        await s.flush()
        kit_yaml = _old_kit(launch.id, w)
        files = {"launch.yaml": kit_yaml, "kit-notes.md": f"Decided in {w['decision_id']}."}
        previous = {"launch.yaml": kit_yaml, "kit-notes.md": f"See D-{w['number']}."}
        run = Run(flow="launch_kit", created_by=ctx.users["owner"].id, status="succeeded",
                  knobs={"launch_id": str(launch.id)})  # fmt: skip
        s.add(run)
        await s.flush()
        s.add(RunSegment(run_id=run.id, seq=1, name="kit", status="succeeded", artifacts={
            "files": files, "attempts": [{"attempt": 1}, {"attempt": 2}], "notes": [],
            "previous": {"attempt": 1, "files": previous},
            "revisions": [{"attempt": 2}], "agent_files": {"2": {"launch.yaml": kit_yaml}},
        }))  # fmt: skip
        launch.kit_run_id = run.id
        launch.kit_error = "launch.yaml was refused: tasks.release_notes names a decision"
        await s.commit()
        return launch.id, run.id, files, previous


def _urls(run_id: uuid.UUID, files: dict[str, str], previous: dict[str, str]) -> list[str]:
    base = f"/v1/runs/{run_id}/segments/1/artifacts"
    return [
        *(f"{base}/{name}" for name in files),
        *(f"{base}/{name}?attempt=1" for name in previous),
        f"{base}/launch.yaml?agents=true",
    ]


async def _member_run_token(ctx, w: dict) -> str:
    """The token of a run that reads as a member (a ritual summary an owner started)."""
    async with tenant_session(ctx.tenant_id) as s:
        run = Run(flow="ritual_summary", created_by=ctx.users["owner"].id, knobs=_knobs(w))
        s.add(run)
        await s.commit()
        run_id = run.id
    return await _token(ctx, run_id, "ritual_summary")


@pytest.mark.parametrize("who", READERS)
async def test_an_old_kit_file_is_not_served_to_a_member(client, ctx, who):
    """protects=a viewer and a commenter (session cookie and API token) reading every file
    of an owner's kit run (launch.yaml and kit-notes.md, the previous attempt's, the
    agents' file) get a 404 with nothing of the hidden decision, the run id taken from
    GET /v1/launches/{id}; fails_when=any file is served (the review's 200 with the
    pricing question); no_claim=paraphrase of the decision (oracle.docs.visibility)."""
    w = await _world(client, ctx)
    launch_id, run_id, files, previous = await _kit_run(ctx, w)
    got = await client.get(f"/v1/launches/{launch_id}", headers=ctx.as_(who))
    assert got.json()["kit_run_id"] == str(run_id), got.text
    token = {"Authorization": f"Bearer {await api_token(ctx.tenant_id, who)}"}
    for headers in (ctx.as_(who), token):
        for url in _urls(run_id, files, previous):
            got = await client.get(url, headers=headers)
            assert got.status_code == 404, (url, got.status_code, got.text[:300])
            assert not _leaks(got.text, w), (url, got.text[:300])


@pytest.mark.parametrize("who", READERS)
async def test_an_old_kit_file_is_not_served_over_mcp(client, ctx, who):
    """protects=the MCP tool get_run_artifact with a viewer's or a commenter's API token
    returns nothing of the hidden decision for any file of the owner's kit run, any
    attempt; fails_when=the tool returns the file; no_claim=other tools (the probe)."""
    w = await _world(client, ctx)
    _, run_id, files, previous = await _kit_run(ctx, w)
    calls = [{"run_id": str(run_id), "seq": 1, "name": n} for n in files]
    calls += [{"run_id": str(run_id), "seq": 1, "name": n, "attempt": 1} for n in previous]
    calls += [{"run_id": str(run_id), "seq": 1, "name": "launch.yaml", "agents": True}]
    async with mcp_client(await api_token(ctx.tenant_id, who)) as c:
        offered = {t.name for t in (await c.list_tools()).tools}
        assert "get_run_artifact" in offered, sorted(offered)[:20]
        for args in calls:
            text = text_of(await c.call_tool("get_run_artifact", args))
            assert not _leaks(text.replace(str(run_id), ""), w), (args, text[:300])


async def test_an_old_kit_file_is_not_served_to_a_member_run(client, ctx):
    """protects=a run that reads as a member (a ritual summary an owner started, with its
    starter's cookie over REST, alone over MCP) and the kit run itself (its
    get_run_output) read no file of the owner's old kit run; fails_when=a file is served
    to the run; no_claim=runs that read with their starter's view (served, as to the
    owner)."""
    w = await _world(client, ctx)
    _, run_id, files, previous = await _kit_run(ctx, w)
    raw = await _member_run_token(ctx, w)
    headers = await _as_run(ctx.as_("owner"), ctx.users["owner"].id, raw)
    for url in _urls(run_id, files, previous):
        got = await client.get(url, headers=headers)
        assert got.status_code == 404, (url, got.status_code, got.text[:300])
        assert not _leaks(got.text, w), (url, got.text[:300])
    async with mcp_client(raw) as c:
        offered = {t.name for t in (await c.list_tools()).tools}
        if "get_run_artifact" in offered:
            for name in files:
                args = {"run_id": str(run_id), "seq": 1, "name": name}
                text = text_of(await c.call_tool("get_run_artifact", args))
                assert not _leaks(text.replace(str(run_id), ""), w), (name, text[:300])
    own = await _token(ctx, run_id, "launch_kit")
    async with mcp_client(own) as c:
        offered = {t.name for t in (await c.list_tools()).tools}
        assert "get_run_output" in offered, sorted(offered)[:20]
        for name in files:
            text = text_of(await c.call_tool("get_run_output", {"seq": 1, "name": name}))
            assert not _leaks(text, w), (name, text[:300])


@pytest.mark.parametrize("who", PRIVILEGED)
async def test_owners_and_approvers_still_read_every_kit_file(client, ctx, who):
    """protects=an owner and an approver read every file of the kit run as it was written;
    fails_when=the fix hides them from those who may see the decision; no_claim=-."""
    w = await _world(client, ctx)
    _, run_id, files, previous = await _kit_run(ctx, w)
    for url in _urls(run_id, files, previous):
        got = await client.get(url, headers=ctx.as_(who))
        assert got.status_code == 200, (url, got.text[:300])
    got = await client.get(_urls(run_id, files, previous)[0], headers=ctx.as_(who))
    assert QUESTION in got.text


async def test_a_member_view_file_naming_nothing_hidden_is_served(client, ctx):
    """protects=a file of a run that reads as a member which names nothing hidden is still
    served to a viewer and a commenter; fails_when=the fix hides every member-view file;
    no_claim=-."""
    w = await _world(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        run = Run(flow="ritual_summary", created_by=ctx.users["owner"].id, knobs=_knobs(w))
        s.add(run)
        await s.flush()
        s.add(RunSegment(run_id=run.id, seq=1, name="summary", status="succeeded",
                         artifacts={"files": {"summary.md": CLEAN}}))  # fmt: skip
        await s.commit()
        run_id = run.id
    for who in READERS:
        got = await client.get(f"/v1/runs/{run_id}/segments/1/artifacts/summary.md",
                               headers=ctx.as_(who))  # fmt: skip
        assert got.status_code == 200 and got.text == CLEAN, (who, got.text[:300])


async def test_a_starter_view_run_serves_its_files_to_approvers_only(client, ctx):
    """protects=a run that read with its starter's view (an owner's baseline run) serves
    its files, even ones naming nothing hidden, to owners and approvers only: a viewer, a
    commenter and a member run's token get a 404; fails_when=a member reads what an
    owner's view produced; no_claim=-."""
    w = await _world(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        run = Run(flow="baseline", created_by=ctx.users["owner"].id, status="succeeded")
        s.add(run)
        await s.flush()
        s.add(RunSegment(run_id=run.id, seq=1, name="baseline", status="succeeded",
                         artifacts={"files": {"baseline.yaml": CLEAN}}))  # fmt: skip
        await s.commit()
        run_id = run.id
    url = f"/v1/runs/{run_id}/segments/1/artifacts/baseline.yaml"
    raw = await _member_run_token(ctx, w)
    member_run = await _as_run(ctx.as_("owner"), ctx.users["owner"].id, raw)
    for headers in (ctx.as_("viewer"), ctx.as_("commenter"), member_run):
        assert (await client.get(url, headers=headers)).status_code == 404
    for who in PRIVILEGED:
        got = await client.get(url, headers=ctx.as_(who))
        assert got.status_code == 200 and got.text == CLEAN, (who, got.text[:300])


# ------------------------------------------------------------------------------ minors


@pytest.mark.parametrize("target", ["company", "approvers"])
async def test_a_member_view_roadmap_prompt_has_no_hidden_entity(client, ctx, target):
    """protects=minor: the PRD to roadmap source context of a run that reads as a member
    (a company-wide roadmap) has no hidden decision's entity and no hand-made depends_on
    link to it; a run on an approvers-only roadmap (its starter's view) still has the
    link; fails_when=the member-view prompt names the entity (``decision:<key>``);
    no_claim=the PRD text itself (a company-wide document)."""
    w = await _world(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        hidden = await s.get(Entity, uuid.UUID(w["entity_id"]))
        # A decided (not reversed) hidden decision's entity stays confirmed.
        hidden.status = "confirmed"
        feature = Entity(type="feature", key="saved-cards", title="Saved cards",
                         status="confirmed", origin="user")  # fmt: skip
        s.add(feature)
        await s.flush()
        s.add(Edge(src_id=feature.id, dst_id=hidden.id, type="depends_on", status="confirmed",
                   origin="user"))  # fmt: skip
        prd = Document(slug="checkout", title="Checkout PRD", kind="prd")
        roadmap = Document(slug="the-roadmap", title="The roadmap", kind="roadmap",
                           visibility=target)  # fmt: skip
        s.add_all([prd, roadmap])
        await s.flush()
        version = DocumentVersion(document_id=prd.id, number=1, markdown="# Checkout\n",
                                  content_hash="x")  # fmt: skip
        s.add(version)
        await s.flush()
        run = Run(flow="prd_to_roadmap", document_id=roadmap.id,
                  created_by=ctx.users["owner"].id,
                  knobs={"source_version_id": str(version.id)})  # fmt: skip
        s.add(run)
        await s.flush()
        source = await runs_service._source_context(s, run)
        named = f"decision:{hidden.key}"
        await s.rollback()
    assert source is not None
    linked = any(named in (e["src"], e["dst"]) for e in source.edges)
    assert linked is (target == "approvers"), source.edges


def test_a_kit_refusal_repeats_nothing_the_file_holds():
    """protects=minor: a refused launch.yaml's problems (kit_error, shown to every member)
    repeat none of its unknown keys, its launch value, an unknown task key or an unknown
    pre-mortem key, which may paraphrase a hidden decision Hidden.names does not catch;
    fails_when=a problem quotes them; no_claim=the YAML parser's own message (a position
    and a generic problem)."""
    said = "decision seven flat price per team"
    text = (
        f'version: 1\nlaunch: "{said} a"\n"{said} b": 1\n'
        f'tasks:\n  "{said} c": "x"\n  pre_mortem: {{"{said} d": []}}\n'
    )
    data, problems = kit.validate(text, uuid.uuid4())
    assert data is None and len(problems) == 4, problems
    assert not any(said in p for p in problems), problems


@pytest.mark.parametrize("target", ["company", "approvers"])
async def test_a_member_view_prompt_has_no_note_naming_a_hidden_decision(client, ctx, target):
    """protects=minor: the prompt of a run that reads as a member (a Baseline to PRD run on
    a company-wide PRD) gets no approved stop's note, change request or Regenerate note
    that names the hidden decision; a run on an approvers-only PRD (its starter's view)
    still gets them; fails_when=the member-view prompt holds D-<n>; no_claim=paraphrase,
    discussions (filtered the same way, oracle.discussions.agent_view)."""
    w = await _world(client, ctx)
    said = f"Follow D-{w['number']} on the price."
    async with tenant_session(ctx.tenant_id) as s:
        doc = Document(slug=f"target-{uuid.uuid4().hex[:6]}", title="The target", kind="prd",
                       visibility=target)  # fmt: skip
        s.add(doc)
        await s.flush()
        run = Run(flow="baseline_to_prd", document_id=doc.id, created_by=ctx.users["owner"].id,
                  knobs={"regenerate_note": said})  # fmt: skip
        s.add(run)
        await s.flush()
        s.add(Checkpoint(run_id=run.id, kind="baseline_confirm", status="approved", note=said))
        seg = RunSegment(run_id=run.id, seq=1, name="baseline", status="pending")
        s.add(seg)
        await s.flush()
        pctx = await runs_service._prompt_context(s, run, seg, [seg], 2, said, FakeRuntime())
        await s.rollback()
    held = [*pctx.reviewer_notes, pctx.change_request or "", *pctx.extra_lines]
    assert any(said in x for x in held) is (target == "approvers"), held
