"""A one-pager bet's drawn flow stays with its bet across PRD versions (vqa one-pager 1).

Test cards (protects / fails_when / no_claim):

- test_flow_stays_on_its_bet_after_a_bet_is_added_above: protects=every bet of a page Oracle
  worded keeps the flow drawn for it when the next version adds a bet above them (and the
  quick read of that version words them as the PRD does); the new bet has none ("Draw the
  flow"); fails_when=a bet shows the flow drawn for the bet that was at its place before
  (the flows shift by one); no_claim=the drawing itself (test_simple_visuals_api).
- test_a_shifted_page_reads_each_flow_on_its_own_bet: protects=a page already built with its
  bets' keys shifted by one (before this fix) still shows each flow on the bet it was drawn
  for, by the words it was drawn from, and the bet left without one can be drawn;
  fails_when=the stored keys decide which bet shows a flow drawn for another.
"""

import uuid

import pytest
from sqlalchemy import select

from oracle import company_time
from oracle.docs.models import Document, DocumentVersion
from oracle.jobs.models import LlmJob
from oracle.simple import one_pager
from oracle.simple.models import SimpleOnePager, SimpleVisual
from oracle.tenancy import tenant_session
from tests.test_simple_line_visuals_api import ask
from tests.test_simple_one_pager_api import MD, PRD, block, get, world
from tests.test_simple_roadmap_api import NOW
from tests.test_simple_visuals_api import run_visual_jobs

# Oracle's words for the four bets of the first version (the PRD says them longer).
WORDED = [
    "Setup checklist showing the next step",
    "Invite suggestions from the admin calendar",
    "Sample project made on day one",
    "Progress meter on the home page",
]
ANSWER = {"blocks": [
    {"key": "problem", "lines": [{"text": "Admins stall.", "source_keys": ["problem"]}]},
    {"key": "bets", "lines": [{"text": t, "source_keys": ["build"]} for t in WORDED]},
    {"key": "outcomes", "lines": [
        {"text": "Invites up", "source_keys": ["outcomes"],
         "metric": {"name": "Invited", "from": "48%", "to": "65%"}},
        {"text": "Setup", "source_keys": ["outcomes"],
         "metric": {"name": "Setup", "from": "30%", "to": "50%"}}]},
    {"key": "not_doing", "lines": [{"text": "No SSO", "source_keys": ["not-doing"]}]},
    {"key": "risks", "lines": [{"text": "Calendar", "source_keys": ["risks"]}]},
]}  # fmt: skip
# The next version: a new first bet; the last one dropped (as many bets as before).
V2 = PRD.replace(
    "- A setup checklist that shows the next step",
    "- A welcome note that names the first three steps\n- A setup checklist that shows the next step",
).replace("- A progress meter on the home page\n", "")


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def drawn(client, ctx) -> dict[str, str]:
    """Version 1 built by Oracle (WORDED), each bet's flow drawn: brief -> subject."""
    await get(client, ctx, "decider")  # a writer's read queues the one_pager job
    async with tenant_session(ctx.tenant_id) as s:
        job = await s.scalar(select(LlmJob).where(LlmJob.kind == "one_pager"))

        async def built(kind, payload):
            return ANSWER

        assert (await one_pager.run_job(s, job, built))["built"] is True
        await s.commit()
    await run_visual_jobs(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        return {v.brief: str(v.subject_id) for v in await s.scalars(select(SimpleVisual))}


async def next_version(client, ctx) -> None:
    r = await client.post("/v1/documents/guided-setup/versions", content=V2.encode(),
                          headers=MD | ctx.as_("owner"))  # fmt: skip
    assert r.status_code in (200, 201), r.text
    async with tenant_session(ctx.tenant_id) as s:
        v2 = await s.scalar(select(DocumentVersion).where(DocumentVersion.number == 2))
        v2.approved_at = NOW
        await s.commit()


def shown(view: dict) -> list[tuple[str, str | None]]:
    """Each bet's words and the subject of the flow it shows (None: "Draw the flow")."""
    return [
        (x["text"], x["flow_subject"] if x["flow"] else None) for x in block(view, "bets")["lines"]
    ]


async def test_flow_stays_on_its_bet_after_a_bet_is_added_above(client):
    ctx = await world(client)
    by_brief = await drawn(client, ctx)
    assert len(by_brief) == 4
    await next_version(client, ctx)
    for who in ("decider", "viewer"):
        view = await get(client, ctx, who)
        assert view["version"] == 2
        assert shown(view) == [
            ("A welcome note that names the first three steps", None),
            ("A setup checklist that shows the next step", by_brief[WORDED[0]]),
            ("Invite suggestions from the admin's calendar", by_brief[WORDED[1]]),
            ("A sample project created on day one", by_brief[WORDED[2]]),
        ], who


async def test_a_shifted_page_reads_each_flow_on_its_own_bet(client):
    ctx = await world(client)
    by_brief = await drawn(client, ctx)
    await next_version(client, ctx)
    view = await get(client, ctx, "decider")
    doc_id = view["document"]["id"]
    # The page as built before the fix: each bet keyed by the bet at its place before.
    async with tenant_session(ctx.tenant_id) as s:
        v1 = await s.scalar(
            select(SimpleOnePager)
            .join(DocumentVersion, DocumentVersion.id == SimpleOnePager.version_id)
            .where(DocumentVersion.number == 1)
        )
        old = [x["flow_key"] for b in v1.blocks if b["key"] == "bets" for x in b["lines"]]
        doc = await s.scalar(select(Document).where(Document.slug == "guided-setup"))
        v2 = await s.scalar(
            select(SimpleOnePager).where(
                SimpleOnePager.document_id == doc.id, SimpleOnePager.id != v1.id
            )
        )
        blocks = [dict(b, lines=[dict(x) for x in b["lines"]]) for b in v2.blocks]
        bets = next(b for b in blocks if b["key"] == "bets")["lines"]
        for x, key in zip(bets, old, strict=True):
            x["flow_key"] = key
        v2.blocks = blocks
        await s.commit()
    view = await get(client, ctx, "decider")
    assert shown(view) == [
        ("A welcome note that names the first three steps", None),
        ("A setup checklist that shows the next step", by_brief[WORDED[0]]),
        ("Invite suggestions from the admin's calendar", by_brief[WORDED[1]]),
        ("A sample project created on day one", by_brief[WORDED[2]]),
    ]
    # The new bet, its own key taken by another bet's flow, is drawn on a subject of its own.
    new = block(view, "bets")["lines"][0]
    assert new["can_draw_flow"] and new["flow_subject"] not in by_brief.values()
    assert (await ask(client, ctx, "decider", new["flow_subject"], doc_id)).status_code == 202
    await run_visual_jobs(ctx)
    after = block(await get(client, ctx, "decider"), "bets")["lines"]
    assert after[0]["flow"] is not None and after[0]["flow_subject"] == new["flow_subject"]
    assert uuid.UUID(after[1]["flow_subject"]) == uuid.UUID(by_brief[WORDED[0]])
