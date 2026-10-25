"""H9 Pricing input, security fixes for #541, part 5: the launch kit and the runs that
write a draft of a company-wide document read as a member (owner, 2026-10-24).

- ``launch_kit`` is ``member_output``: its run token reads every tool as a commenter,
  whoever started it; its importer refuses a launch.yaml whose text names a decision or
  document a commenter may not see; kit output written before the fix (task bodies,
  release notes, changelog drafts, requester notes) is withheld at read time from a
  reader to whom it names something hidden.
- Baseline to PRD, the feedback loop, PRD to roadmap, PRD to spec and the strategy draft
  read as a member exactly when their target document is company-wide (decided when the
  run starts; a target opened to the company later makes the run read as a member from
  then on); with an approvers-only target they keep the starter's role. Their draft
  import refuses a draft that names something hidden when the run reads as a member.
- Minors: a theme's problem suggestion, ids named in upper case, the Inbox through a
  member run's token with the starter's cookie, and the staging list's JobError.

A decided-then-reversed pricing decision (a Decisions due occurrence prepared for it) and
an imported pricing memo are the hidden things. Against Postgres with the FakeRuntime.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from oracle import audit
from oracle.auth.deps import RUN_TOKEN_HEADER
from oracle.docs.models import Document
from oracle.launches import kit
from oracle.launches.models import ChangelogEntry, Launch, LaunchTask, RequesterNote
from oracle.requests.models import RequestTheme
from oracle.rituals.models import RitualOccurrence
from oracle.runs import flows
from oracle.runs import service as runs_service
from oracle.runs.models import Run
from oracle.runs.schemas import KnobsIn, RunCreate
from oracle.runtokens import mint_run_token
from oracle.swarm import FakeRuntime, set_runtime
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.decision_helpers import clock  # noqa: F401
from tests.fixtures import draft
from tests.pricing_helpers import QUESTION, drafted_by_run, memo_md
from tests.test_mcp import mcp_client, text_of
from tests.test_member_runs_visibility import _knobs, _leaks, _reads, _world
from tests.update_helpers import import_md

DRAFT_FLOWS = ("baseline_to_prd", "feedback_loop", "prd_to_roadmap", "prd_to_spec",
               "strategy_draft")  # fmt: skip
TARGET_KIND = {"baseline_to_prd": "prd", "feedback_loop": "prd", "prd_to_roadmap": "roadmap",
               "prd_to_spec": "spec", "strategy_draft": "strategy"}  # fmt: skip
STARTERS = ("owner", "approver", "oracle")
READERS = (("owner", True), ("approver", True), ("commenter", False), ("viewer", False))
CLEAN = "Buyers pick a saved card and pay in one tap."


@pytest.fixture
async def ctx():
    return await make_ctx()


@pytest.fixture(autouse=True)
def runtime():
    """The local runtime: run tokens from any address."""
    rt = FakeRuntime()
    set_runtime(rt)
    yield rt
    set_runtime(None)


async def _target(ctx, kind: str, visibility: str) -> Document:
    async with tenant_session(ctx.tenant_id) as s:
        doc = Document(slug=f"target-{kind}-{uuid.uuid4().hex[:6]}", title=f"The {kind} target",
                       kind=kind, visibility=visibility)  # fmt: skip
        s.add(doc)
        await s.commit()
        return doc


async def _launch(ctx) -> uuid.UUID:
    async with tenant_session(ctx.tenant_id) as s:
        launch = Launch(title="Saved cards", item_keys=["payment-step"], state="launched",
                        owner_id=ctx.users["owner"].id, launched_at=datetime.now(UTC))  # fmt: skip
        s.add(launch)
        await s.commit()
        return launch.id


async def _token(ctx, run_id: uuid.UUID, flow: str) -> str:
    async with tenant_session(ctx.tenant_id) as s:
        scopes = sorted({x for seg in flows.FLOWS[flow].segments for x in seg.scopes})
        raw = await mint_run_token(s, run_id, scopes, ttl_seconds=600)
        await s.commit()
    return raw


async def _run(ctx, flow: str, starter: str, *, document_id=None, knobs=None) -> uuid.UUID:
    """A run of ``flow`` by the owner or the approver, or by Oracle (no principal: created
    for the owner it acts as)."""
    who = "owner" if starter == "oracle" else starter
    async with tenant_session(ctx.tenant_id) as s:
        if starter == "oracle" and flow == "launch_kit":
            body = RunCreate(flow=flow, knobs=KnobsIn(depth="quick"))  # type: ignore[arg-type]
            run_id = await runs_service.create_run(
                s, audit.ORACLE, body, oracle_knobs=knobs, commit=False,
                created_by=ctx.users[who].id,
            )  # fmt: skip
        else:
            run = Run(flow=flow, created_by=ctx.users[who].id, document_id=document_id,
                      knobs=dict(knobs or {}))  # fmt: skip
            s.add(run)
            await s.flush()
            run_id = run.id
        await s.commit()
    return run_id


async def _all_reads(raw: str, w: dict, extra: list[tuple[str, dict]]) -> list[tuple[str, str]]:
    reads = await _reads(raw, w)
    async with mcp_client(raw) as c:
        offered = {t.name for t in (await c.list_tools()).tools}
        for name, args in extra:
            if name not in offered:
                continue
            text = text_of(await c.call_tool(name, args))
            for value in args.values():
                text = text.replace(value, "")
            reads.append((name, text))
    return reads


def _markdown_reads(w: dict) -> list[tuple[str, dict]]:
    return [("get_document_markdown", {"doc": slug}) for slug, _ in w["docs"]]


# ----------------------------------------------------------------- the run token's reads


def test_the_launch_kit_reads_as_a_member():
    """protects=launch_kit is member_output and the draft flows are marked company drafts;
    fails_when=either mark is missing; no_claim=flows a later lane adds."""
    assert flows.FLOWS["launch_kit"].member_output
    marked = {k for k, f in flows.FLOWS.items() if f.company_draft}
    assert marked == set(DRAFT_FLOWS)
    assert not any(flows.FLOWS[k].member_output for k in DRAFT_FLOWS)


@pytest.mark.parametrize("starter", STARTERS)
async def test_a_launch_kit_run_reads_as_a_commenter(client, ctx, starter):
    """protects=a launch kit run started by an owner, an approver or Oracle reads nothing
    of the hidden pricing decision or memo through get_launch, list_requester_notes,
    get_baseline, list_decisions, get_decision, search or get_document_markdown;
    fails_when=it reads them with its starter's role; no_claim=what the agent writes."""
    w = await _world(client, ctx)
    launch_id = await _launch(ctx)
    run_id = await _run(ctx, "launch_kit", starter, knobs={"launch_id": str(launch_id)})
    raw = await _token(ctx, run_id, "launch_kit")
    ids = {"launch_id": str(launch_id)}
    extra = [("get_launch", ids), ("list_requester_notes", ids), *_markdown_reads(w)]
    reads = await _all_reads(raw, w, extra)
    offered = {n for n, _ in reads}
    assert {"get_baseline", "get_launch"} <= offered, offered
    for name, text in reads:
        assert not _leaks(text, w), (name, text[:400])


@pytest.mark.parametrize("visibility", ["company", "approvers"])
@pytest.mark.parametrize("starter", STARTERS)
@pytest.mark.parametrize("flow", DRAFT_FLOWS)
async def test_a_draft_run_reads_as_a_member_for_a_company_target(
    client, ctx, flow, starter, visibility
):
    """protects=a run of a draft flow whose target document is company-wide, started by an
    owner, an approver or Oracle, reads nothing of the hidden pricing decision or memo;
    with an approvers-only target it still reads them (the starter's role); fails_when=a
    company-target run reads them, or an approvers-target run loses them; no_claim=the
    tools a run is offered (oracle.mcp.scopes)."""
    w = await _world(client, ctx)
    target = await _target(ctx, TARGET_KIND[flow], visibility)
    run_id = await _run(ctx, flow, starter, document_id=target.id)
    raw = await _token(ctx, run_id, flow)
    reads = await _all_reads(raw, w, _markdown_reads(w))
    if visibility == "company":
        for name, text in reads:
            assert not _leaks(text, w), (name, text[:400])
    else:
        assert any(QUESTION in t for n, t in reads if n == "get_baseline"), "starter view lost"


async def _started(client, ctx, slug: str) -> dict:
    """A Baseline to PRD run on ``slug``, created, estimated and started by the owner."""
    owner = ctx.as_("owner")
    resp = await client.post("/v1/runs", json={"flow": "baseline_to_prd", "document": slug},
                             headers=owner)  # fmt: skip
    assert resp.status_code == 201, resp.text
    run = resp.json()
    assert (await client.post(f"/v1/runs/{run['id']}/estimate", headers=owner)).status_code == 200
    resp = await client.post(f"/v1/runs/{run['id']}/start", headers=owner)
    assert resp.status_code == 200, resp.text
    return run


@pytest.mark.parametrize("visibility", ["company", "approvers"])
async def test_start_decides_the_view_from_the_target(client, ctx, runtime, visibility):
    """protects=starting a draft run records whether it reads as a member, from its target
    document's visibility then; fails_when=nothing is recorded or the wrong value;
    no_claim=runs started before this fix (decided from the target on each call)."""
    await _world(client, ctx)
    target = await _target(ctx, "prd", visibility)
    run = await _started(client, ctx, target.slug)
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(Run, uuid.UUID(run["id"]))
        assert row.knobs.get(runs_service.MEMBER_VIEW) is (visibility == "company"), row.knobs


@pytest.mark.parametrize("change", ["opened", "closed"])
async def test_a_later_visibility_change(client, ctx, change):
    """protects=a run that started on a company target keeps reading as a member after the
    target is made approvers-only ("closed"); a run that started on an approvers-only
    target reads as a member once the target is opened to the company ("opened");
    fails_when=either run reads the hidden decision; no_claim=what the run read before the
    change (its working memory: the draft import checks the output)."""
    w = await _world(client, ctx)
    start, then = ("approvers", "company") if change == "opened" else ("company", "approvers")
    target = await _target(ctx, "prd", start)
    run_id = await _run(ctx, "baseline_to_prd", "owner", document_id=target.id,
                        knobs={runs_service.MEMBER_VIEW: start == "company"})  # fmt: skip
    async with tenant_session(ctx.tenant_id) as s:
        (await s.get(Document, target.id)).visibility = then
        await s.commit()
    raw = await _token(ctx, run_id, "baseline_to_prd")
    for name, text in await _reads(raw, w):
        assert not _leaks(text, w), (name, text[:400])


# ----------------------------------------------------------------------- the importers


def _kit(launch_id: uuid.UUID, member_id: uuid.UUID, body: str) -> str:
    return (
        f"version: 1\nlaunch: {launch_id}\n"
        f'changelog:\n  - {{category: added, audience: public, title: "Saved cards", '
        f'body: "{body}"}}\n'
        f'tasks:\n  release_notes: "{body}"\n'
        f'notes:\n  - {{requester_ref: "member:{member_id}", body: "{body}"}}\n'
    )


@pytest.mark.parametrize("names", ["number", "question", "upper_id", "none"])
async def test_the_kit_importer_checks_text_as_a_commenter(client, ctx, names):
    """protects=a launch.yaml whose changelog, task or note text names the hidden pricing
    decision (D-<n>, its title, its id in upper case) is refused: no task drafted, no
    changelog entry, no note, and the refusal names nothing hidden; a kit naming nothing
    hidden is imported; fails_when=the hidden text is stored; no_claim=paraphrase."""
    w = await _world(client, ctx)
    launch_id = await _launch(ctx)
    member = ctx.users["commenter"].id
    upper = w["decision_id"].upper()
    body = {"number": f"See D-{w['number']} for the price.", "question": QUESTION,
            "upper_id": f"Decided in {upper}.", "none": CLEAN}[names]  # fmt: skip
    async with tenant_session(ctx.tenant_id) as s:
        s.add(LaunchTask(launch_id=launch_id, key="release_notes", title="Release notes",
                         position=1, audience="external"))  # fmt: skip
        s.add(RequesterNote(launch_id=launch_id, requester_kind="member", member_id=member,
                            display_name="Casey"))  # fmt: skip
        await s.commit()
    async with tenant_session(ctx.tenant_id) as s:
        launch = await s.get(Launch, launch_id)
        out = await kit.import_kit(s, launch, _kit(launch_id, member, body))
        await s.commit()
    async with tenant_session(ctx.tenant_id) as s:
        task = await s.scalar(select(LaunchTask).where(LaunchTask.launch_id == launch_id))
        entries = list(await s.scalars(select(ChangelogEntry)))
        note = await s.scalar(select(RequesterNote))
        launch = await s.get(Launch, launch_id)
    if names == "none":
        assert task.body == CLEAN and len(entries) == 1 and note.body == CLEAN, out
        return
    assert "error" in out and launch.kit_error, out
    assert not _leaks(launch.kit_error, w), launch.kit_error
    assert task.body is None and not entries and note.body is None


DRAFT_LINE = "Pricing follows D-{n}: " + QUESTION


@pytest.mark.parametrize("visibility", ["company", "approvers"])
@pytest.mark.parametrize("flow", ["baseline_to_prd", "feedback_loop"])
async def test_a_member_view_draft_naming_a_hidden_decision_is_refused(
    client, ctx, flow, visibility
):
    """protects=a draft of a company-wide PRD that names the hidden pricing decision is
    refused at import (it goes back to the writer), so the draft version a viewer or a
    commenter reads never holds it; with an approvers-only PRD it is imported;
    fails_when=a company-wide version holds the decision; no_claim=paraphrase."""
    w = await _world(client, ctx)
    target = await _target(ctx, "prd", visibility)
    md = draft("prd_v1.md").replace("document: checkout-redesign", f"document: {target.slug}")
    md = md.replace("Owner: product. Status: draft for review.", DRAFT_LINE.format(n=w["number"]))
    run_id = await _run(ctx, flow, "owner", document_id=target.id)
    async with tenant_session(ctx.tenant_id) as s:
        run = await s.get(Run, run_id)
        out = await runs_service._import_draft(s, run, "prd", md)
    if visibility == "approvers":
        assert out.get("document_id"), out
        return
    assert out.get("problems") and not out.get("document_id"), out
    assert not _leaks(str(out), w), out
    for who in ("commenter", "viewer"):
        got = await client.get(f"/v1/documents/{target.slug}", headers=ctx.as_(who))
        assert not _leaks(got.text, w), (who, got.text[:400])


# ------------------------------------------------- kit output written before the fix


async def _kit_output(ctx, w: dict) -> tuple[uuid.UUID, str]:
    """A launch whose kit run (before this fix, as an owner) wrote the hidden decision into
    its release notes, a changelog draft and a requester note, next to clean ones."""
    launch_id = await _launch(ctx)
    secret = f"D-{w['number']}: {QUESTION}"
    async with tenant_session(ctx.tenant_id) as s:
        for i, (key, body) in enumerate((("release_notes", secret), ("support_notes", CLEAN))):
            s.add(LaunchTask(launch_id=launch_id, key=key, title=key, position=i,
                             audience="external", status="drafted", body=body))  # fmt: skip
        for title, body in (("Team plan pricing changes", secret), ("Saved cards", CLEAN)):
            s.add(ChangelogEntry(launch_id=launch_id, category="changed", audience="public",
                                 title=title, body=body, released_on=datetime.now(UTC).date(),
                                 created_actor=audit.ORACLE))  # fmt: skip
        for role, body in (("commenter", secret), ("viewer", CLEAN)):
            s.add(RequesterNote(launch_id=launch_id, requester_kind="member",
                                member_id=ctx.users[role].id, display_name=role, body=body,
                                status="notified", notified_at=datetime.now(UTC)))  # fmt: skip
        await s.commit()
    return launch_id, secret


@pytest.mark.parametrize(("who", "sees"), READERS)
async def test_kit_output_naming_a_hidden_decision_is_withheld(client, ctx, who, sees):
    """protects=a viewer and a commenter reading the launch, its notes, the changelog
    drafts and their Inbox's Shipped row see nothing of the hidden decision a kit run
    wrote before this fix, and still see the clean drafts; an owner and an approver see
    it all; fails_when=a member reads it; no_claim=published entries (an approver
    published them)."""
    w = await _world(client, ctx)
    launch_id, secret = await _kit_output(ctx, w)
    headers = ctx.as_(who)
    urls = [f"/v1/launches/{launch_id}", f"/v1/launches/{launch_id}/notes",
            "/v1/changelog?status=draft", "/v1/inbox"]  # fmt: skip
    seen = ""
    for url in urls:
        got = await client.get(url, headers=headers)
        assert got.status_code == 200, (url, got.text)
        seen += got.text
        if not sees:
            assert not _leaks(got.text, w), (who, url, got.text[:400])
    assert CLEAN in seen, who
    if sees:
        assert QUESTION in seen, who


async def test_a_pre_read_changelog_row_naming_a_hidden_decision_is_dropped(client, ctx):
    """protects=the Changelog drafts rows of a stored pre-read (built with Oracle's view)
    whose text names the hidden decision are not shown to a commenter; fails_when=the
    row shows; no_claim=rows naming nothing hidden (kept)."""
    w = await _world(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        occ = await s.get(RitualOccurrence, uuid.UUID(w["occ_id"]))
        occ.pre_read = {**occ.pre_read, "blocks": [*occ.pre_read["blocks"], {
            "key": "changelog_drafts", "title": "Changelog drafts", "rows": [
                {"entry_id": str(uuid.uuid4()), "text": f"Changed: D-{w['number']} {QUESTION}"},
                {"entry_id": str(uuid.uuid4()), "text": f"Added: {CLEAN}"}]}]}  # fmt: skip
        await s.commit()
    for url in (f"/v1/ritual-occurrences/{w['occ_id']}",
                f"/v1/ritual-occurrences/{w['occ_id']}/pre-read.md"):  # fmt: skip
        got = await client.get(url, headers=ctx.as_("commenter"))
        assert got.status_code == 200, got.text
        assert CLEAN in got.text and not _leaks(got.text, w), (url, got.text[:600])


# ------------------------------------------------------------------------------ minors


async def test_a_theme_problem_suggestion_naming_a_hidden_decision_is_withheld(client, ctx):
    """protects=minor: a theme's problem suggestion (request triage, before part 4) naming
    the hidden decision is not shown to a commenter or a viewer, and is to an owner;
    fails_when=a member reads it; no_claim=a confirmed problem (a person confirmed it)."""
    w = await _world(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        problem = {"problem": f"D-{w['number']}: {QUESTION}"}
        s.add(RequestTheme(title="Team pricing", origin="oracle", problem_state="suggested",
                           problem_suggestion=problem))  # fmt: skip
        await s.commit()
    for who, sees in READERS:
        got = await client.get("/v1/request-themes", headers=ctx.as_(who))
        assert got.status_code == 200, got.text
        (theme,) = got.json()
        assert (theme["problem_suggestion"] is not None) is sees, who
        if not sees:
            assert not _leaks(got.text, w), who


async def test_a_summary_naming_a_hidden_id_in_upper_case_is_withheld(client, ctx):
    """protects=minor: Hidden.names matches ids whatever their case (and without dashes);
    fails_when=an upper-case id slips through; no_claim=paraphrase (no id, number or
    title)."""
    w = await _world(client, ctx)
    for text in (f"See {w['decision_id'].upper()}.", f"See {uuid.UUID(w['decision_id']).hex}."):
        async with tenant_session(ctx.tenant_id) as s:
            run = Run(flow="ritual_summary", created_by=ctx.users["owner"].id, knobs=_knobs(w))
            s.add(run)
            await s.flush()
            occ = await s.get(RitualOccurrence, uuid.UUID(w["occ_id"]))
            occ.summary, occ.summary_state, occ.summary_run_id = text, "ready", run.id
            await s.commit()
        url = f"/v1/ritual-occurrences/{w['occ_id']}"
        assert (await client.get(url, headers=ctx.as_("commenter"))).json()["summary"] is None
        assert (await client.get(url, headers=ctx.as_("owner"))).json()["summary"] == text


async def test_the_inbox_through_a_member_run_shows_no_pricing_checkpoint(client, ctx, runtime):
    """protects=minor: GET /v1/inbox with a member run's token and its starter's (an
    owner's) cookie shows no pending pricing_memo checkpoint (its slugs, its document id),
    and the owner's own Inbox still does; fails_when=the member run reads it;
    no_claim=other Inbox sections (no hidden rows in this setup)."""
    w = await _world(client, ctx)
    slug = "team-plan-pricing-run"
    resp = await import_md(client, ctx.as_("owner"), slug, memo_md(slug))
    assert resp.status_code == 201, resp.text
    await drafted_by_run(client, ctx, runtime, slug, memo_md(slug), who="owner")
    async with tenant_session(ctx.tenant_id) as s:
        doc_id = str(await s.scalar(select(Document.id).where(Document.slug == slug)))
    own = await client.get("/v1/inbox", headers=ctx.as_("owner"))
    assert slug in own.text, own.text[:400]
    run_id = await _run(ctx, "ritual_summary", "owner", knobs=_knobs(w))
    raw = await _token(ctx, run_id, "ritual_summary")
    got = await client.get("/v1/inbox", headers={**ctx.as_("owner"), RUN_TOKEN_HEADER: raw})
    assert got.status_code == 200, got.text
    assert slug not in got.text and doc_id not in got.text and not _leaks(got.text, w)


@pytest.mark.parametrize("who", ["viewer", "commenter", "owner"])
async def test_the_staging_list_of_an_unknown_document_is_a_404(client, ctx, who):
    """protects=minor: GET /v1/staging?document=<unknown or hidden> is a 404, not a 500
    (a JobError mapped to its HTTP error); fails_when=500; no_claim=the list's content."""
    got = await client.get("/v1/staging?document=no-such-doc", headers=ctx.as_(who))
    assert got.status_code == 404, got.text
