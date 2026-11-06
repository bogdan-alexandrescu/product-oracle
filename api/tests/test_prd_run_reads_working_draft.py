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


async def _prd(s, slug: str, title: str) -> tuple[Document, DocumentVersion]:
    doc = await _add(s, Document(slug=slug, title=title, kind="prd", status="approved",
                                 visibility="company"))  # fmt: skip
    body = f"# {title}"
    v = await _add(s, DocumentVersion(document_id=doc.id, number=1, markdown=body,
                                      content_hash=_hash(body), approved_at=PUBLISHED))  # fmt: skip
    return doc, v


async def world(*, draft: bool = True, starter: str = "owner") -> dict:
    ctx = await make_ctx()
    tenant_id = ctx.tenant_id
    async with tenant_session(tenant_id) as s:
        digest, dv = await _prd(s, "digest", "Digest")
        accounts, av = await _prd(s, "accounts", "Accounts")
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
        await _add(s, item("sign-in-links", "Sign-in links", "f-03", accounts, av, 3))
        if draft:
            # Delete to Trash moves the feature's rows to Trash at once.
            trashed.deleted_at = EDITED
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
        run = await _add(s, Run(flow="baseline_to_prd", status="running", document_id=digest.id,
                                created_by=ctx.users[starter].id,
                                knobs={"regenerate_note": NOTE}))  # fmt: skip
        await s.commit()
        return {"tenant": tenant_id, "run": run.id, "digest": digest.id}


async def _record(w: dict):
    from oracle.simple import roadmap_of_record

    async with tenant_session(w["tenant"]) as s:
        return await roadmap_of_record.read(s)


async def _prompt(w: dict) -> tuple[str, dict]:
    from oracle.runs import flows
    from oracle.runs import service as runs_service
    from oracle.swarm import FakeRuntime

    async with tenant_session(w["tenant"]) as s:
        flow = flows.FLOWS["baseline_to_prd"]
        segments = [
            await _add(s, RunSegment(run_id=w["run"], seq=n, name=d.name, status="pending"))
            for n, d in enumerate(flow.segments, start=1)
        ]
        await s.commit()
        run = await s.get(Run, w["run"])
        seg = next(x for x in segments if x.name == "prd_draft")
        pctx = await runs_service._prompt_context(s, run, seg, segments, 1, None, FakeRuntime())
        prompt = flows.build_steps(flow, flow.segment("prd_draft"), flows.Knobs(), pctx)[-1][2]
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
