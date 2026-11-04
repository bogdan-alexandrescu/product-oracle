"""ask-page-context: Ask Oracle's "This page" knows what the page shows.

The owner's walk (Nov 3): on a run's Roadmap items review, a panel chat was titled "Runs"
and its context had none of the page's items, so asked about "these 4 items" Oracle said
it did not have them. The page now sends what it shows with its subject (``view``: its
name, the filters in use and its items); the reply's context reads it, in the person's own
private panel chat only.
"""

import uuid

from oracle.discussions import context
from oracle.discussions.models import Discussion
from oracle.runs.models import Checkpoint, Run
from oracle.tenancy import tenant_session
from tests.test_discussions import company

VIEW = {
    "name": "Roadmap items review",
    "filters": ["Needs you", "Horizon: Now"],
    "lines": [
        "Saved carts for guests — horizon Now; milestone Beta (Dec 15); confidence medium;"
        " needs you because: no due date",
        "Gift card balance check — horizon Next; milestone none; confidence low;"
        " needs you because: no outcome named",
    ],
}


async def review_stop(ctx) -> tuple[str, str]:
    async with tenant_session(ctx.tenant_id) as s:
        run = Run(flow="prd_to_roadmap", status="awaiting_checkpoint")
        s.add(run)
        await s.flush()
        cp = Checkpoint(run_id=run.id, kind="roadmap_items", status="pending")
        s.add(cp)
        await s.commit()
        return str(run.id), str(cp.id)


async def start(client, ctx, body: dict, who: str = "commenter") -> dict:
    resp = await client.post("/v1/discussions", json=body, headers=ctx.as_(who))
    assert resp.status_code == 201, resp.text
    return resp.json()


async def built(ctx, d_id: str) -> str:
    async with tenant_session(ctx.tenant_id) as s:
        d = await s.get(Discussion, uuid.UUID(d_id))
        return "\n".join((await context.build(s, d, uuid.uuid4())).lines)


# protects=the owner's walk (Nov 3): a run review page's "This page" chat has the run, its
# flow, the stop, the items listed (with horizon, milestone, confidence, why each needs the
# owner) and the filters in use; fails_when=the context holds only "Runs" or no items;
# no_claim=the reply's wording.
async def test_a_run_review_chat_context_has_its_items(client):
    ctx, _doc = await company(client)
    run_id, cp_id = await review_stop(ctx)
    d = await start(
        client, ctx,
        {
            "subject_kind": "checkpoint",
            "subject": {"run_id": run_id, "checkpoint_id": cp_id, "view": VIEW},
            "origin": "panel", "visibility": "private",
        },
    )  # fmt: skip
    assert d["subject_label"] == "Roadmap from an approved PRD · Roadmap items"
    text = await built(ctx, d["id"])
    assert "The run: Roadmap from an approved PRD, status awaiting_checkpoint" in text
    assert "The stop: Roadmap items, status pending" in text
    assert "Filters in use: Needs you; Horizon: Now" in text
    assert "Saved carts for guests — horizon Now; milestone Beta (Dec 15)" in text
    assert "Gift card balance check" in text and "needs you because: no outcome named" in text


# protects=a page's own name heads its "This page" chat; fails_when=it reads "Runs";
# no_claim=the page's list of items.
async def test_a_screen_chat_is_named_by_its_page_and_reads_what_it_shows(client):
    ctx, _doc = await company(client)
    d = await start(
        client, ctx,
        {
            "subject_kind": "screen",
            "subject": {"path": "/plan/dates", "view": {"name": "Dates · Plan", "lines": ["Beta, Dec 15"]}},
            "origin": "panel", "visibility": "private",
        },
    )  # fmt: skip
    assert d["subject_label"] == "Dates · Plan" and d["title"] == "Dates · Plan"
    text = await built(ctx, d["id"])
    assert "The page shows: Dates · Plan" in text and "- Beta, Dec 15" in text


# protects=what one person's page showed stays in their own private panel chat;
# fails_when=an open discussion or a shared copy carries the view; no_claim=G7 sharing.
async def test_an_open_discussion_never_carries_a_page_view(client):
    ctx, _doc = await company(client)
    run_id, cp_id = await review_stop(ctx)
    subject = {"run_id": run_id, "checkpoint_id": cp_id, "view": VIEW}
    d = await start(client, ctx, {"subject_kind": "checkpoint", "subject": subject})
    assert "view" not in d["subject"]
    assert "Saved carts for guests" not in await built(ctx, d["id"])
    chat = await start(
        client, ctx,
        {"subject_kind": "checkpoint", "subject": subject, "origin": "panel"},
    )  # fmt: skip
    resp = await client.post(
        f"/v1/discussions/{chat['id']}/share",
        json={"title": "Dates for the review", "first_message": "Which items need a date?"},
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 201, resp.text
    assert "view" not in resp.json()["subject"]
    assert "Saved carts for guests" not in await built(ctx, resp.json()["id"])
