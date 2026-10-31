"""The one-pager reads cleanly for a PRD a run wrote (CLD's production pass, 2026-10-30): a
Goal-traced PRD, its lines carrying ``[c:id]`` citations. Against Postgres; invented PRDs.

Test cards (protects / fails_when / no_claim):

- test_quick_read_never_shows_a_citation_token: protects=before the one_pager job writes the
  page, Oracle's quick read and its PDF read the PRD's words with every ``[c:...]`` resolved
  (none left, none cut to "[c"), and say the job is writing (``writing``); once the job has
  built it, ``writing`` is false; fails_when=a raw or cut token shows, or the page reads as
  final while the job writes it; no_claim=the web's words (the Playwright spec).
- test_stored_quick_read_with_tokens_reads_clean: protects=a quick read stored before this
  rule (its lines holding raw and cut tokens) reads clean too; fails_when=a token shows.
- test_who_has_it_from_labelled_lines: protects=a users section of labelled lines (Primary,
  Job story, Owner, Not the target, each cited) names who has the problem in a sentence:
  the Primary's words; fails_when=it reads as a list of labels or a cut token;
  no_claim=sections of unlabelled leads (test_simple_one_pager_clear).
- test_measure_from_its_source_never_ids: protects=an outcome whose definition is only
  citation ids shows the cited source's words and its name, one defined elsewhere shows
  that definition with its source's name, and one with neither says nothing;
  fails_when="[c:c4] [c:c11]" is the measure.
- test_code_named_right_after_it: protects=a code named right after it in prose ("so F-11
  Photo editing is out") or in a table cell ("F-10 Auto albums") has its name; a code with
  none ("F-40 may slip") is still a "Needs a look" item; fails_when=a named code is listed
  as having no name, or an unnamed one is not.
"""

# ruff: noqa: E501 - the fixture PRDs keep their long lines
from sqlalchemy import select

from oracle.auth.deps import Principal
from oracle.docs.models import Document, Section
from oracle.jobs.models import LlmJob
from oracle.simple import one_pager
from oracle.simple import one_pager_checks as checks
from oracle.simple.models import SimpleOnePager
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.test_simple_one_pager_api import (
    MD,
    block,
    clock,  # noqa: F401 - the autouse clock
    get,
)

# A Baseline to PRD run's PRD (template Goal-traced PRD), invented.
RUN_PRD = """---
title: Photo sorting
citations:
  - id: c1
    source: upload
    ref: owner-interviews.md
    title: Library owner interviews
  - id: c4
    source: upload
    ref: upload-log.csv
    title: Upload log export
    excerpt: photos given an album within 24 hours of upload, per library per week
  - id: c11
    source: web
    ref: https://example.com/sorting-study
    title: Sorting habits study
---

# Photo sorting PRD {#title}

## Summary {#summary}

We will sort new photos into albums for owners of small libraries [c:c1].

## Problem {#problem}

Owners of small photo libraries lose an hour a week finding new photos (about 9 minutes per day) [c:c1]. Every feature below serves sorting time [c:c4]:

## Features by milestone {#brief-items}

| Milestone | Feature | Goal | Outcome |
|---|---|---|---|
| [M1](#milestone-m1) | [F-10 Auto albums](#feature-auto-albums) | Faster sorting | Albums by event [c:c4] |
| | [F-12 Face groups](#feature-face-groups) | Faster sorting | People found in one tap [c:c1] |
| | [F-13 Album names](#feature-album-names) | Faster sorting | Albums named by place and date [c:c1] |

## Non-goals {#non-goals}

Editing stays where it is, so F-11 Photo editing is out [c:c1]. Prints are not planned, so F-14 Print orders waits for next year; and F-15 Shared albums is out too [c:c11].

## Top risks {#top-risks}

- Albums may group the wrong photos: owners move a photo in one tap [c:c11].
- F-40 may slip past M1 [c:c4].

# Full version {#full}

## Problem alignment {#problem-alignment}

### Who has it {#audience}

- **Primary:** Owners of small photo libraries who add a few hundred photos a week [c:c1].
- **Job story:** When a batch of photos lands, I want them grouped by event, so I can find one in seconds [c:c1].
- **Owner:** The person who pays for the library and sets who may edit it [c:c4].
- **Not the target:** Studios with their own photo tools [c:c11].

### Success measures {#success}

- Photos sorted within a day from 40% to 80%, counted as: [c:c4] [c:c11]
- Time to find a photo from 90s to 20s [c:c1]
- Albums renamed by hand from 30% to 10%

## Sources and data points {#sources}

### Data points {#sources-data}

- Time to find a photo: measured as seconds from opening the library to opening the photo; source: [c:c1]
"""

TOKEN = "[c"


async def run_world(client):
    ctx = await make_ctx()
    r = await client.post("/v1/documents/photo-sorting/versions", content=RUN_PRD.encode(),
                          headers=MD | ctx.as_("owner"))  # fmt: skip
    assert r.status_code in (200, 201), r.text
    return ctx


def all_text(view: dict) -> str:
    out = []
    for b in view["blocks"]:
        out.append(b.get("who") or "")
        for x in b["lines"]:
            out += [x["text"], x.get("full") or "", x.get("measure") or "",
                    x.get("measure_source") or "", x.get("words") or ""]  # fmt: skip
            if x.get("metric"):
                out += [x["metric"]["name"], x["metric"]["to"]]
    out += [x["text"] for x in view["needs_look"]]
    return "\n".join(out)


async def pdf(ctx, who: str = "viewer") -> str:
    async with tenant_session(ctx.tenant_id) as s:
        p = Principal(tenant_id=ctx.tenant_id, kind="user", role=who, user_id=ctx.users[who].id)
        html, _ = await one_pager.pdf_html(s, p, "photo-sorting")
    return html


async def test_quick_read_never_shows_a_citation_token(client):
    ctx = await run_world(client)
    view = await get(client, ctx, "owner", "photo-sorting")
    assert view["built_by"] == "extract"
    assert view["writing"] is True
    assert TOKEN not in all_text(view)
    problem = block(view, "problem")["lines"][0]
    assert problem["text"].startswith(
        "Owners of small photo libraries lose an hour a week finding new photos (about 9 minutes per day). Every feature below serves sorting time:"
    )
    # A viewer reads the same quick read, and is told the job is writing it.
    viewer = await get(client, ctx, "viewer", "photo-sorting")
    assert viewer["writing"] is True and TOKEN not in all_text(viewer)
    html = await pdf(ctx)
    assert TOKEN not in html and "about 9 minutes per day)." in html

    # The job writes the page: it reads as final.
    answer = {"blocks": [
        {"key": "problem", "lines": [{"text": "Owners of small photo libraries lose an hour a week [c:c1].", "source_keys": ["problem"]}]},
        {"key": "bets", "lines": [
            {"text": "F-10 Auto albums [c:c4]", "source_keys": ["brief-items"]},
            {"text": "F-12 Face groups", "source_keys": ["brief-items"]},
            {"text": "F-13 Album names", "source_keys": ["brief-items"]},
        ]},
        {"key": "outcomes", "lines": [
            {"text": "Photos sorted within a day from 40% to 80%", "source_keys": ["success"],
             "metric": {"name": "Photos sorted within a day", "from": "40%", "to": "80%"}},
            {"text": "Time to find a photo from 90s to 20s", "source_keys": ["success"],
             "metric": {"name": "Time to find a photo", "from": "90s", "to": "20s"}},
        ]},
        {"key": "not_doing", "lines": [{"text": "F-11 Photo editing", "source_keys": ["non-goals"]}]},
        {"key": "risks", "lines": [{"text": "Albums may group the wrong photos", "source_keys": ["top-risks"]}]},
    ]}  # fmt: skip

    async def ask(kind, payload):
        return answer

    async with tenant_session(ctx.tenant_id) as s:
        job = await s.scalar(select(LlmJob).where(LlmJob.kind == "one_pager"))
        out = await one_pager.run_job(s, job, ask)
        assert out["built"] is True, out
        job.status = "succeeded"
        await s.commit()
    view = await get(client, ctx, "owner", "photo-sorting")
    assert view["built_by"] == "oracle" and view["writing"] is False
    assert TOKEN not in all_text(view)
    assert block(view, "bets")["lines"][0]["text"] == "F-10 Auto albums"


async def test_stored_quick_read_with_tokens_reads_clean(client):
    ctx = await run_world(client)
    await get(client, ctx, "owner", "photo-sorting")
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.scalar(select(SimpleOnePager))
        blocks = [dict(b) for b in row.blocks]
        for b in blocks:
            if b["key"] == "problem":
                b["lines"] = [{
                    "id": "problem-1",
                    "text": "Owners lose an hour a week (about 9 minutes per day) [c:c1]. Every feature serves sorting time [c…",
                    "full": "Owners lose an hour a week (about 9 minutes per day) [c:c1]. Every feature serves sorting time [c:c4]:",
                    "source_keys": ["problem"],
                }]  # fmt: skip
            if b["key"] == "risks":
                b["lines"] = [
                    {
                        "id": "risks-1",
                        "text": "Albums may group the wrong photos [c:c11]",
                        "source_keys": ["top-risks"],
                    }
                ]
        row.blocks = blocks
        await s.commit()
    for who in ("owner", "viewer"):
        view = await get(client, ctx, who, "photo-sorting")
        assert TOKEN not in all_text(view), all_text(view)
        assert block(view, "risks")["lines"][0]["text"] == "Albums may group the wrong photos"
    assert TOKEN not in await pdf(ctx)


async def test_who_has_it_from_labelled_lines(client):
    ctx = await run_world(client)
    view = await get(client, ctx, "owner", "photo-sorting")
    assert block(view, "problem")["who"] == (
        "Owners of small photo libraries who add a few hundred photos a week"
    )
    # A table of labelled rows reads the same; with no Primary, the people named, never a label.
    sec = Section(section_key="who", heading="Who has it", level=3, ordinal=1, content_hash="x",
                  body_md="| Who | Detail |\n|---|---|\n| Primary | Owners of small photo libraries [c:c1] |\n| Not the target | Studios [c:c4] |",
                  body_text="")  # fmt: skip
    assert checks.who_has_it([sec]) == "Owners of small photo libraries"
    sec.body_md = "- **Job story:** When photos land, I want albums [c:c1].\n- **Owner:** Library owners who pay for the plan [c:c4]."
    assert checks.who_has_it([sec]) == "Library owners who pay for the plan"
    # Unlabelled leads read as before.
    sec.body_md = "- New workspace admins: set up alone [c:c1]\n- Team leads: invite later"
    assert checks.who_has_it([sec]) == "New workspace admins; Team leads"


async def test_measure_from_its_source_never_ids(client):
    ctx = await run_world(client)
    view = await get(client, ctx, "owner", "photo-sorting")
    sorted_, find, renamed = block(view, "outcomes")["lines"]
    assert (
        sorted_["measure"]
        == "photos given an album within 24 hours of upload, per library per week"
    )
    assert sorted_["measure_source"] == "Upload log export"
    assert find["measure"] == "seconds from opening the library to opening the photo"
    assert find["measure_source"] == "Library owner interviews"
    assert renamed["measure"] is None and renamed["measure_source"] is None
    # With no source the PRD defines, ids alone are no measure.
    sec = Section(section_key="s", heading="Success", level=3, ordinal=1, content_hash="x",
                  body_md="- Photos sorted within a day, counted as: [c:c4] [c:c11]", body_text="")  # fmt: skip
    assert checks.measures([sec]) == []


async def test_code_named_right_after_it(client):
    ctx = await run_world(client)
    view = await get(client, ctx, "owner", "photo-sorting")
    codes = [x for x in view["needs_look"] if x["kind"] == "code"]
    assert [x["text"] for x in codes] == ["F-40 has no name in the PRD."]
    sec = Section(section_key="n", heading="Non-goals", level=2, ordinal=1, content_hash="x",
                  body_md="Editing stays, so F-11 Photo editing is out. And F-14 Print orders waits; F-40 may slip.",
                  body_text="")  # fmt: skip
    names = checks.glossary([sec])
    assert names == {"F-11": "Photo editing", "F-14": "Print orders"}
    assert (
        checks.with_names("so F-11 Photo editing is out", names)[0]
        == "so F-11 Photo editing is out"
    )
    async with tenant_session(ctx.tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == "photo-sorting"))
        assert doc is not None
