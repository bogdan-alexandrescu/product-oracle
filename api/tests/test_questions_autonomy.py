"""C2 Questions to people under H11 Autonomy (issue #151): the ``questions``
responsibility's level decides how far Oracle goes with the questions it drafts.

- Observe: drafts still follow the gaps, but Oracle asks no one: no next batch is
  proposed, asking one is refused (409), and a new brief asks no first batch. A person
  asking a teammate directly (``POST /v1/questions``) is never stopped.
- Draft: the next batch lists the drafted questions, each with its own named person
  (the gap's owner, else the brief's author), never the reader; a person sends it.
- Recommend (the default): today's behaviour.
- Act within limits: the ticker (``oracle.intake.autoask.tick_due``) asks the next
  batch on Oracle's own account once nothing asked earlier is still waiting, never more
  than the weekly cap to one person, then tells the brief's author ("Oracle did", with
  Undo withdrawing what it asked and is still waiting).

Made-up people only. Each test's card: protects=<the observable>; fails_when=<the wrong
result it rejects>; no_claim=<what green does not prove>.
"""

from sqlalchemy import select

from oracle.autonomy_models import OracleAction
from oracle.intake import autoask
from oracle.tenancy import tenant_session
from tests.intake_helpers import company, create_intake

OBSERVE = (
    "Oracle is set to observe questions: it asks no one. "
    "An owner can change this in Settings › Autonomy."
)


async def set_level(client, ctx, level: str, **limits) -> None:
    """An owner sets Ask people questions on Settings › Autonomy (the screen's route)."""
    body: dict = {"level": level, "reason": "Trying how Oracle asks"}
    if limits:
        body["limits"] = limits
    resp = await client.put("/v1/autonomy/questions", json=body, headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text


async def questions(client, ctx, intake_id: str, status: str | None = None) -> list[dict]:
    params: dict = {"intake_id": intake_id, "limit": 500}
    if status:
        params["status"] = status
    resp = await client.get("/v1/questions", params=params, headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    return resp.json()


async def next_batch(client, ctx, intake_id: str, who: str = "commenter") -> dict:
    resp = await client.get(f"/v1/intakes/{intake_id}/next-batch", headers=ctx.as_(who))
    assert resp.status_code == 200, resp.text
    return resp.json()


async def tick(ctx) -> int:
    async with tenant_session(ctx.tenant_id) as db:
        n = await autoask.tick_due(db)
        await db.commit()
        return n


async def actions(ctx) -> list[OracleAction]:
    async with tenant_session(ctx.tenant_id) as db:
        return list(
            await db.scalars(
                select(OracleAction)
                .where(OracleAction.responsibility == "questions")
                .order_by(OracleAction.created_at)
            )
        )


async def quiet_intake(client, ctx) -> dict:
    """A brief written at Observe: every question is still a draft."""
    await set_level(client, ctx, "observe")
    out = await create_intake(client, ctx)
    assert await questions(client, ctx, out["intake"]["id"], "asked") == []
    return out


async def test_observe_asks_no_one_but_people_still_ask_directly(client):
    """protects=at Observe a new brief asks no first batch while its questions are still
    drafted, the next batch proposes nothing and says why in plain words, asking a batch
    is 409 with that sentence, and a person can still ask a teammate a question about
    the brief; fails_when=a batch is asked or proposed, the drafts stop following the
    gaps, the refusal is unexplained, or the direct question is refused; no_claim=the
    intake page's wording (Playwright)."""
    ctx = await company()
    out = await quiet_intake(client, ctx)
    iid = out["intake"]["id"]
    assert len(await questions(client, ctx, iid, "draft")) > 5
    nb = await next_batch(client, ctx, iid)
    assert nb["questions"] == [] and nb["held"] == OBSERVE and nb["remaining"] > 5
    resp = await client.post(
        f"/v1/intakes/{iid}/question-batches", json={"size": 3}, headers=ctx.as_("commenter")
    )
    assert resp.status_code == 409 and resp.json()["detail"] == OBSERVE
    assert await questions(client, ctx, iid, "asked") == []
    direct = await client.post(
        "/v1/questions",
        json={
            "prompt": "Who signs off on the rollout?",
            "asked_to": str(ctx.users["approver"].id),
            "subject": {"kind": "intake", "intake_id": iid},
        },
        headers=ctx.as_("commenter"),
    )
    assert direct.status_code == 201, direct.text


async def test_recommend_is_unchanged(client):
    """protects=at Recommend (the default) a new brief asks its first batch, the next
    batch proposes questions with a person each and no held note, and asking it asks
    them as the person; fails_when=the default level changes today's behaviour;
    no_claim=the batch's order (covered by the intake tests)."""
    ctx = await company()
    out = await create_intake(client, ctx)
    iid = out["intake"]["id"]
    assert len(await questions(client, ctx, iid, "asked")) == 5
    nb = await next_batch(client, ctx, iid)
    assert nb["held"] is None and len(nb["questions"]) == 5
    assert all(c["question"]["asked_to"] for c in nb["questions"])
    resp = await client.post(
        f"/v1/intakes/{iid}/question-batches", json={"size": 2}, headers=ctx.as_("commenter")
    )
    assert resp.status_code == 200, resp.text
    asked = [c["question"] for c in resp.json()["questions"]]
    assert len(asked) == 2
    assert {q["asked_by"] for q in asked} == {str(ctx.users["commenter"].id)}


async def test_draft_lists_drafts_with_their_named_person_and_a_person_sends(client):
    """protects=at Draft a new brief asks no first batch; the next batch lists the
    drafted questions, each with its own named person (here the brief's author), even
    when an approver reads it; the approver can still send it; fails_when=Oracle asks on
    its own at Draft or names the reader instead of the question's person; no_claim=the
    gap's owner as the named person (same rule as Recommend, engine.default_person)."""
    ctx = await company()
    await set_level(client, ctx, "draft")
    out = await create_intake(client, ctx)
    iid = out["intake"]["id"]
    assert await questions(client, ctx, iid, "asked") == []
    nb = await next_batch(client, ctx, iid, who="approver")
    assert nb["held"] is None and len(nb["questions"]) == 5
    author = str(ctx.users["commenter"].id)
    assert {c["question"]["asked_to"] for c in nb["questions"]} == {author}
    resp = await client.post(
        f"/v1/intakes/{iid}/question-batches", json={"size": 5}, headers=ctx.as_("approver")
    )
    assert resp.status_code == 200, resp.text
    assert len(await questions(client, ctx, iid, "asked")) == 5


async def test_act_asks_the_next_batch_once_and_tells_the_author(client):
    """protects=at Act the tick asks one batch of five on Oracle's own account (no
    asker) of the brief's author, records one "Oracle did" row naming the brief and the
    person, notifying the author, with Undo withdrawing those questions; a second tick
    asks nothing while they wait; Undo by the author withdraws them; fails_when=no
    batch is asked, the batch is asked twice, the author is not told, or Undo leaves
    the questions asked; no_claim=the Inbox screen (Playwright)."""
    ctx = await company()
    out = await quiet_intake(client, ctx)
    iid = out["intake"]["id"]
    await set_level(client, ctx, "act")
    assert await tick(ctx) == 1
    asked = await questions(client, ctx, iid, "asked")
    assert len(asked) == 5
    author = str(ctx.users["commenter"].id)
    assert {q["asked_by"] for q in asked} == {None}
    assert {q["asked_to"] for q in asked} == {author}
    assert await tick(ctx) == 0
    assert len(await questions(client, ctx, iid, "asked")) == 5
    (action,) = await actions(ctx)
    assert action.notify_ids == [ctx.users["commenter"].id]
    assert action.subject == {"kind": "intake", "key": iid, "href": f"/intakes/{iid}"}
    assert "Saved addresses" in action.summary and "5 questions" in action.summary
    assert action.undo is not None
    inbox = (await client.get("/v1/inbox", headers=ctx.as_("commenter"))).json()
    (row,) = [r for r in inbox["oracle_actions"] if r["responsibility"] == "questions"]
    undo = await client.post(f"/v1/oracle-actions/{row['id']}/undo", headers=ctx.as_("commenter"))
    assert undo.status_code == 200, undo.text
    assert await questions(client, ctx, iid, "asked") == []
    assert len(await questions(client, ctx, iid, "withdrawn")) >= 5


async def test_act_keeps_within_the_weekly_cap(client):
    """protects=with a cap of 2 a person a week the tick asks the author only 2
    questions, and once those are settled the next tick asks the author nothing more
    that week; fails_when=the cap is ignored or counted per tick instead of per week;
    no_claim=the week's boundary (seven days back from now)."""
    ctx = await company()
    out = await quiet_intake(client, ctx)
    iid = out["intake"]["id"]
    await set_level(client, ctx, "act", max_per_person_per_week=2)
    assert await tick(ctx) == 1
    asked = await questions(client, ctx, iid, "asked")
    assert len(asked) == 2
    for q in asked:
        resp = await client.patch(
            f"/v1/questions/{q['id']}", json={"status": "withdrawn"}, headers=ctx.as_("commenter")
        )
        assert resp.status_code == 200, resp.text
    assert await tick(ctx) == 0
    assert await questions(client, ctx, iid, "asked") == []
    assert len(await actions(ctx)) == 1


async def test_below_act_the_tick_asks_nothing(client):
    """protects=at Recommend, Draft and Observe the tick asks nothing and records no
    "Oracle did" row; fails_when=Oracle asks on its own below Act; no_claim=other
    responsibilities' ticks."""
    ctx = await company()
    out = await quiet_intake(client, ctx)
    iid = out["intake"]["id"]
    for level in ("observe", "draft", "recommend"):
        await set_level(client, ctx, level)
        assert await tick(ctx) == 0
    assert await questions(client, ctx, iid, "asked") == []
    assert await actions(ctx) == []
