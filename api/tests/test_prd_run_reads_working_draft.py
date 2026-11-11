"""prd-reads-working-draft (production, Nov 6): a PRD's run follows the company roadmap's
working draft, not only its last published version.

The company roadmap's v7 was published on Nov 4. On Nov 5 the owner edited it in Simple:
"Weekly digest email" (F-12) renamed "Weekly summary email" and its end moved to Dec 4,
"Digest settings page" (F-13) marked done and its dependency on F-12 removed, "CSV export
of digests" (F-14) deleted to Trash, and "Digest preview" added under the Digest PRD with
no F-code. The Digest PRD's Regenerate run is told each of these from the working draft,
with the words saying which roadmap it read; with no working draft it reads v7.

Test card: protects=the update run's context takes names, dates, done marks, Trash, new
items and dependencies from the working draft, and says which roadmap it read;
fails_when=the run reads only the published version (old name, date, no done mark, the
trashed item back, the new item missing). Against Postgres. Invented data only.
"""

import hashlib
from datetime import UTC, date, datetime

import pytest
from sqlalchemy import select

import oracle.main  # noqa: F401  (registers the lanes' prompt lines)
from oracle import company_time
from oracle.docs.models import Document, DocumentVersion
from oracle.roadmap import company
from oracle.roadmap.models import RoadmapItem
from oracle.runs.models import Run, RunSegment
from oracle.simple.models import SimpleChange, SimpleDraft
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx

NOW = datetime(2026, 11, 6, 9, 0, tzinfo=UTC)
PUBLISHED = datetime(2026, 11, 4, 18, 0, tzinfo=UTC)
# Nov 5, 2026, 11:40 PM PST.
EDITED = datetime(2026, 11, 6, 7, 40, tzinfo=UTC)
NOTE = "Follow the roadmap as edited."
OWNER = "00000000-0000-4000-8000-000000000001"


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


def _hash(body: str) -> str:
    return hashlib.sha256(body.encode()).hexdigest()


async def _add(s, row):
    s.add(row)
    await s.flush()
    return row


async def _prd(
    s, slug: str, title: str, visibility: str = "company"
) -> tuple[Document, DocumentVersion]:
    doc = await _add(s, Document(slug=slug, title=title, kind="prd", status="approved",
                                 visibility=visibility))  # fmt: skip
    body = f"# {title}"
    v = await _add(s, DocumentVersion(document_id=doc.id, number=1, markdown=body,
                                      content_hash=_hash(body), approved_at=PUBLISHED))  # fmt: skip
    return doc, v


async def world(
    *,
    draft: bool = True,
    starter: str | None = "owner",
    flow: str = "baseline_to_prd",
    accounts: str = "company",
    digest_visibility: str = "company",
) -> dict:
    """``starter``: a role of make_ctx's users, or None (a run Oracle started); ``accounts``:
    the Accounts PRD's visibility."""
    ctx = await make_ctx()
    tenant_id = ctx.tenant_id
    d = None
    async with tenant_session(tenant_id) as s:
        digest, dv = await _prd(s, "digest", "Digest", digest_visibility)
        accounts_doc, av = await _prd(s, "accounts", "Accounts", accounts)
        rm = await _add(s, Document(slug=company.SLUG, title=company.TITLE, kind="roadmap",
                                    status="approved", visibility="company",
                                    company_roadmap=True))  # fmt: skip
        v7 = await _add(s, DocumentVersion(document_id=rm.id, number=7, markdown="# R",
                                           content_hash=_hash("# R"),
                                           approved_at=PUBLISHED))  # fmt: skip

        def item(key, title, code, prd, pv, pos, deps=(), start=None, end=None):
            return RoadmapItem(roadmap_document_id=rm.id, roadmap_version_id=v7.id,
                               item_key=key, title=title, horizon="now", position=pos,
                               prd_document_id=prd.id, prd_version_id=pv.id,
                               prd_section_key=code, depends_on=list(deps),
                               start_date=start, end_date=end)  # fmt: skip

        digest_email = await _add(s, item("weekly-digest", "Weekly digest email", "f-12", digest,
                                          dv, 0, start=date(2026, 11, 9),
                                          end=date(2026, 11, 20)))  # fmt: skip
        settings = await _add(s, item("digest-settings", "Digest settings page", "f-13", digest,
                                      dv, 1, deps=["weekly-digest"]))  # fmt: skip
        trashed = await _add(s, item("csv-export", "CSV export of digests", "f-14", digest,
                                     dv, 2))  # fmt: skip
        await _add(s, item("sign-in-links", "Sign-in links", "f-03", accounts_doc, av, 3))
        expiry = await _add(s, item("link-expiry", "Magic link expiry", "f-04", accounts_doc,
                                    av, 5))  # fmt: skip
        if draft:
            # Delete to Trash moves the feature's rows to Trash at once.
            trashed.deleted_at = EDITED
            if accounts != "company":
                expiry.deleted_at = EDITED
            d = await _add(s, SimpleDraft(document_id=rm.id, base_version_id=v7.id,
                                          status="working", created_by=OWNER, overlay={
                str(digest_email.id): {"title": "Weekly summary email",
                                       "end_date": "2026-12-04"},
                str(settings.id): {"shipped": {"note": "Marked done in its panel",
                                               "on": "2026-11-05", "by": OWNER},
                                   "depends_on": []},
            }))  # fmt: skip
            added = await _add(s, RoadmapItem(roadmap_document_id=rm.id,
                                              roadmap_version_id=None, simple_draft_id=d.id,
                                              item_key="digest-preview",
                                              title="Digest preview", horizon="next",
                                              position=4, prd_document_id=digest.id,
                                              start_date=date(2026, 12, 7),
                                              end_date=date(2026, 12, 18)))  # fmt: skip
            s.add(SimpleChange(document_id=rm.id, op="add_item", target={"item_id": str(added.id)},
                               before={}, after={}, status="applied", by=OWNER, at=EDITED,
                               draft_ids=[d.id]))  # fmt: skip
        run = await _add(s, Run(flow=flow, status="running", document_id=digest.id,
                                created_by=ctx.users[starter].id if starter else None,
                                knobs={"regenerate_note": NOTE}))  # fmt: skip
        await s.commit()
        return {"tenant": tenant_id, "run": run.id, "digest": digest.id, "roadmap": rm.id,
                "draft": d.id if d is not None else None, "users": ctx.users,
                "flow": flow}  # fmt: skip


async def _record(w: dict):
    from oracle.simple import roadmap_of_record

    async with tenant_session(w["tenant"]) as s:
        return await roadmap_of_record.read(s)


async def _prompt(w: dict, segment: str | None = None) -> tuple[str, dict]:
    from oracle.runs import flows
    from oracle.runs import service as runs_service
    from oracle.swarm import FakeRuntime

    segment = segment or ("next_draft" if w["flow"] == "feedback_loop" else "prd_draft")
    async with tenant_session(w["tenant"]) as s:
        flow = flows.FLOWS[w["flow"]]
        segments = list(
            await s.scalars(
                select(RunSegment).where(RunSegment.run_id == w["run"]).order_by(RunSegment.seq)
            )
        ) or [
            await _add(s, RunSegment(run_id=w["run"], seq=n, name=d.name, status="pending"))
            for n, d in enumerate(flow.segments, start=1)
        ]
        await s.commit()
        run = await s.get(Run, w["run"])
        seg = next(x for x in segments if x.name == segment)
        pctx = await runs_service._prompt_context(s, run, seg, segments, 1, None, FakeRuntime())
        prompt = flows.build_steps(flow, flow.segment(segment), flows.Knobs(), pctx)[-1][2]
        await s.commit()
    async with tenant_session(w["tenant"]) as s:
        knobs = dict((await s.get(Run, w["run"])).knobs)
    return prompt, knobs


async def test_the_reader_takes_every_edit_from_the_working_draft():
    w = await world()
    rec = await _record(w)
    assert rec is not None and rec.draft
    assert rec.label == "Company roadmap, working draft (edited Nov 5, 2026, 11:40 PM PST)"
    by = {i.key: i for i in rec.items}
    assert by["weekly-digest"].title == "Weekly summary email"
    assert by["weekly-digest"].code == "F-12"
    assert by["weekly-digest"].end == date(2026, 12, 4)
    assert by["digest-settings"].status == "done"
    assert by["digest-settings"].depends_on == []
    assert "csv-export" not in by
    assert rec.trashed == [("csv-export", "CSV export of digests")]
    assert by["digest-preview"].new and by["digest-preview"].prd_id == w["digest"]
    assert by["digest-preview"].code is None


async def test_the_update_run_s_prompt_follows_the_working_draft():
    w = await world()
    prompt, knobs = await _prompt(w)
    label = "Company roadmap, working draft (edited Nov 5, 2026, 11:40 PM PST)"
    assert label in prompt
    assert knobs["roadmap_read"] == label
    assert "- F-12 Weekly summary email [key weekly-digest]: Nov 9, 2026 to Dec 4, 2026" in prompt
    assert "Weekly digest email" not in prompt
    line = next(x for x in prompt.splitlines() if "[key digest-settings]" in x)
    assert "DONE" in line and "depends on nothing" in line
    trash = prompt.split("In Trash (leave out of the PRD, never bring back):")[1]
    assert "CSV export of digests [key csv-export]" in trash
    new = next(x for x in prompt.splitlines() if "[key digest-preview]" in x)
    assert "Digest preview" in new and "Not in the Ground Truth" in new
    assert "Sign-in links" in prompt and "PRD: Accounts" in prompt


async def test_with_no_working_draft_the_run_reads_the_published_version():
    w = await world(draft=False)
    rec = await _record(w)
    assert rec is not None and not rec.draft
    assert rec.label == "Company roadmap v7 (published Nov 4)"
    by = {i.key: i for i in rec.items}
    assert by["weekly-digest"].title == "Weekly digest email"
    assert by["weekly-digest"].end == date(2026, 11, 20)
    assert by["digest-settings"].status != "done"
    assert "digest-preview" not in by and rec.trashed == []
    prompt, knobs = await _prompt(w)
    assert "Company roadmap v7 (published Nov 4)" in prompt
    assert knobs["roadmap_read"] == "Company roadmap v7 (published Nov 4)"


async def test_a_run_started_by_someone_who_may_not_see_the_draft_reads_the_published_one():
    # The draft's own rule (oracle.simple.drafts.sees): a commenter who took no part in it
    # reads the published version, so the PRD their run writes shows nothing of the draft.
    w = await world(starter="commenter")
    prompt, knobs = await _prompt(w)
    assert knobs["roadmap_read"] == "Company roadmap v7 (published Nov 4)"
    assert "Weekly summary email" not in prompt and "Digest preview" not in prompt


DRAFT_LABEL = "Company roadmap, working draft (edited Nov 5, 2026, 11:40 PM PST)"
PUBLISHED_LABEL = "Company roadmap v7 (published Nov 4)"


async def _let_in(w: dict, how: str) -> None:
    """Gives the commenter the part in the draft or the roadmap ``how`` names (the draft's
    own rule, oracle.simple.drafts.sees)."""
    from oracle.review.models import DocumentReviewPolicy
    from oracle.roadmap.models import ProductTrack

    me = w["users"]["commenter"].id
    async with tenant_session(w["tenant"]) as s:
        d = await s.get(SimpleDraft, w["draft"])
        if how == "participant":
            d.participant_ids = [*(d.participant_ids or []), me]
        elif how == "decider":
            s.add(DocumentReviewPolicy(document_id=w["roadmap"], decider_id=me))
        elif how == "reviewer":
            s.add(DocumentReviewPolicy(document_id=w["roadmap"], mandatory_reviewer_ids=[me]))
        elif how == "track owner":
            s.add(ProductTrack(prd_document_id=w["digest"], roadmap_document_id=w["roadmap"],
                               title="Digest track", owner_id=me))  # fmt: skip
        elif how == "waiting on":
            d.waiting_on = [me]
        elif how == "added reviewer":
            d.added_reviewers = [{"id": str(me), "name": "Casey Commenter"}]
        await s.commit()


# Who reads the working draft: whoever the draft's own rule lets see it; everyone else
# reads the published version (round 1 review).
WHO = [
    ("owner", None, True),
    ("commenter", "participant", True),
    ("commenter", "decider", True),
    ("commenter", "reviewer", True),
    ("commenter", "track owner", True),
    ("commenter", "waiting on", True),
    ("commenter", "added reviewer", True),
    ("approver", None, False),
    ("commenter", None, False),
    ("viewer", None, False),
]


@pytest.mark.parametrize(("starter", "how", "sees"), WHO)
async def test_the_run_reads_the_draft_only_when_its_starter_may_see_it(starter, how, sees):
    w = await world(starter=starter)
    if how:
        await _let_in(w, how)
    prompt, knobs = await _prompt(w)
    assert knobs["roadmap_read"] == (DRAFT_LABEL if sees else PUBLISHED_LABEL)
    assert (DRAFT_LABEL if sees else PUBLISHED_LABEL) in prompt
    assert ("Weekly summary email" in prompt) is sees
    assert ("Digest preview" in prompt) is sees
    assert ("Weekly digest email" in prompt) is not sees


@pytest.mark.parametrize(("starter", "sees"), [("owner", True), ("commenter", False)])
async def test_build_next_draft_follows_the_same_rule(starter, sees):
    w = await world(starter=starter, flow="feedback_loop")
    prompt, knobs = await _prompt(w)
    assert knobs["roadmap_read"] == (DRAFT_LABEL if sees else PUBLISHED_LABEL)
    assert ("Weekly summary email" in prompt) is sees


@pytest.mark.parametrize("target", ["company", "approvers"])
async def test_a_run_nobody_started_reads_the_published_version(target):
    # No starter, nobody who may see the draft: the published version, whoever the PRD's
    # readers are.
    w = await world(starter=None, digest_visibility=target)
    prompt, knobs = await _prompt(w)
    assert knobs["roadmap_read"] == PUBLISHED_LABEL
    assert "Weekly summary email" not in prompt and "Digest preview" not in prompt


async def test_a_company_visible_prd_s_run_leaves_out_an_approvers_only_prd_s_items():
    # The Digest PRD is company-wide (its run reads as a member); Accounts is approvers-only:
    # its title, its items and its item in Trash stay out of what every commenter will read.
    w = await world(accounts="approvers")
    prompt, knobs = await _prompt(w)
    assert knobs["roadmap_read"] == DRAFT_LABEL
    assert "Weekly summary email" in prompt
    assert "Sign-in links" not in prompt and "PRD: Accounts" not in prompt
    assert "Magic link expiry" not in prompt
    assert "CSV export of digests" in prompt


async def test_an_approvers_only_prd_s_items_stay_when_nothing_is_hidden():
    w = await world()
    prompt, _ = await _prompt(w)
    assert "Sign-in links" in prompt and "Magic link expiry" in prompt


@pytest.mark.parametrize("segment", ["eng_review", "eng_dates"])
async def test_engineering_steps_read_the_same_roadmap(segment):
    # Engineering dates start from the owner's dates, not the published ones.
    w = await world()
    prompt, knobs = await _prompt(w, segment)
    assert DRAFT_LABEL in prompt
    assert "- F-12 Weekly summary email [key weekly-digest]: Nov 9, 2026 to Dec 4, 2026" in prompt
    assert knobs["roadmap_read_by"] == {segment: DRAFT_LABEL}


async def test_each_step_keeps_the_roadmap_it_read():
    w = await world()
    await _prompt(w, "feature_set")
    _, knobs = await _prompt(w, "prd_draft")
    assert knobs["roadmap_read_by"] == {"feature_set": DRAFT_LABEL, "prd_draft": DRAFT_LABEL}


async def test_a_draft_with_edits_but_no_change_rows_dates_from_when_it_was_made():
    from oracle.simple import roadmap_of_record

    w = await world(draft=False)
    made = datetime(2026, 11, 5, 20, 0, tzinfo=UTC)
    async with tenant_session(w["tenant"]) as s:
        v7 = await s.scalar(
            select(DocumentVersion).where(DocumentVersion.document_id == w["roadmap"])
        )
        edited = await _add(s, SimpleDraft(document_id=w["roadmap"], base_version_id=v7.id,
                                           created_by=OWNER, created_at=made,
                                           overlay={"x": {"title": "Renamed"}}))  # fmt: skip
        assert await roadmap_of_record._edited_at(s, edited) == made
        edited.overlay = {}
        await s.flush()
        assert await roadmap_of_record._edited_at(s, edited) is None
        await s.rollback()


async def test_a_run_started_with_the_owner_s_personal_token_reads_the_working_draft():
    # PR 1333: a run started through a personal API token acts as its person, so it reads
    # what they may see: the owner's token reads the working draft, not the published one.
    import uuid

    from oracle.auth.deps import Principal
    from oracle.runs import service as runs_service
    from oracle.runs.schemas import RunCreate

    w = await world(starter=None)
    owner = w["users"]["owner"]
    token = Principal(tenant_id=w["tenant"], kind="user", role="owner", user_id=owner.id,
                      token_id=uuid.uuid4())  # fmt: skip
    async with tenant_session(w["tenant"]) as s:
        run_id = await runs_service.create_run(
            s, token, RunCreate(flow="baseline_to_prd", document="digest"), commit=False
        )
        await s.commit()
        assert (await s.get(Run, run_id)).created_by == owner.id
    prompt, knobs = await _prompt({**w, "run": run_id})
    assert knobs["roadmap_read"] == DRAFT_LABEL
    assert DRAFT_LABEL in prompt and "Weekly summary email" in prompt
    assert "Digest preview" in prompt


async def test_the_prompt_names_the_working_draft_as_no_one_person_s():
    # PR 1333: any decider's working draft is read (the draft's own rule), so the prompt
    # calls it the roadmap's working draft, not "the owner's".
    w = await world(starter="commenter")
    await _let_in(w, "decider")
    prompt, _ = await _prompt(w)
    assert DRAFT_LABEL in prompt
    assert "owner's" not in prompt
    assert "the roadmap's working draft, newer than the published version" in prompt
