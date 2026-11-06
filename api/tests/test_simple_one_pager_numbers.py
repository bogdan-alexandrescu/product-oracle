"""The one-pager's "Needs a look" numbers get a one-click fix (owner, Nov 5, 'New change op'):
each "numbers" item carries its fix (``{action, target, before, value, words}``), the change
engine's ``set_section_number`` op, which sets the number inside the PRD section through the
PRD's working draft, as ``edit_line`` does. Against Postgres, on test_simple_one_pager_clear's
invented PRD "team-invites" ("Eight features wait for next quarter" over six items).

Test cards (protects / fails_when / no_claim):

- test_each_numbers_item_carries_its_fix: protects=both "numbers" items carry their fix
  ("Use 6", "Use 200") and a code item none; an owner's fix applies into the PRD's working
  draft, the item clears for them, the other stays; a viewer still reads the published
  section; fails_when=no fix is sent, the fix writes the published version, or the item
  stays; no_claim=the web's button (e2e simple-one-pager-number-fix).
- test_stale_number_is_refused: protects=a fix whose ``before`` the section no longer holds
  is 409 naming who changed it; nothing is written; fails_when=it applies twice or over
  other words.
- test_undo_puts_the_number_back: protects=Undo restores the section and the item;
  fails_when=the draft keeps the new number.
- test_who_may_fix: protects=an approver's fix is a proposal routed to the owners, shown on
  the item to the owner, who accepts it; a viewer is 403; fails_when=a proposal writes, or
  a viewer changes the PRD.
- test_another_company_cannot_fix: protects=tenant scope: another company's owner is 404
  and nothing is written; fails_when=the op reaches another company's PRD.
"""

from sqlalchemy import select

from oracle.simple.models import SimpleChange, SimpleDraft
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.test_simple_one_pager_api import (
    CHANGES,
    clock,  # noqa: F401 - the autouse clock
    get,
)
from tests.test_simple_one_pager_clear import clear_world

DOC = "team-invites"
COUNT = "“Eight features wait for next” says 8, but “Not this quarter” shows 6 items."
PER = "40 paid workspaces per region × 5 regions is 200, but the company-wide target says 250."


def look(view: dict, text: str) -> dict | None:
    return next((x for x in view["needs_look"] if x["text"] == text), None)


async def fix(client, ctx, who: str, f: dict, **over):
    body = {
        "op": f["action"],
        "target": f["target"],
        "before": {"number": over.get("before", f["before"])},
        "after": {"number": f["value"]},
    }
    return await client.post(CHANGES, json=body, headers=ctx.as_(who))


async def test_each_numbers_item_carries_its_fix(client):
    ctx = await clear_world(client)
    view = await get(client, ctx, "owner", DOC)
    count, per = look(view, COUNT), look(view, PER)
    assert count["fix"] == {
        "action": "set_section_number",
        "target": {
            "document_id": view["document"]["id"],
            "section": "later",
            "said": "Eight features wait for next",
        },
        "before": "Eight",
        "value": "6",
        "words": "Use 6",
        "proposal": None,
    }
    assert per["fix"]["target"]["section"] == "targets"
    assert (per["fix"]["before"], per["fix"]["value"], per["fix"]["words"]) == (
        "250",
        "200",
        "Use 200",
    )
    assert next(x for x in view["needs_look"] if x["kind"] == "code")["fix"] is None
    r = await fix(client, ctx, "owner", count["fix"])
    assert r.status_code == 201, r.text
    c = r.json()["change"]
    assert c["op"] == "set_section_number" and c["status"] == "applied"
    assert "6 features wait for next quarter." in c["after"]["sections"]["later"]["body"]
    assert "Eight features" in c["before"]["sections"]["later"]["body"]
    mine = await get(client, ctx, "owner", DOC)
    assert look(mine, COUNT) is None and look(mine, PER) is not None
    assert mine["draft"]["changes"] == 1
    async with tenant_session(ctx.tenant_id) as s:
        [d] = list(await s.scalars(select(SimpleDraft)))
        assert d.overlay["sections"]["later"].startswith("6 features wait for next quarter.")
    seen = await get(client, ctx, "viewer", DOC)
    assert seen["draft"] is None
    # The per-unit fix sets the company-wide target to what the parts add up to.
    r = await fix(client, ctx, "owner", per["fix"])
    assert r.status_code == 201, r.text
    assert (
        "Company-wide target: 200 paid workspaces"
        in r.json()["change"]["after"]["sections"]["targets"]["body"]
    )
    assert [
        x for x in (await get(client, ctx, "owner", DOC))["needs_look"] if x["kind"] == "numbers"
    ] == []


async def test_stale_number_is_refused(client):
    ctx = await clear_world(client)
    f = look(await get(client, ctx, "owner", DOC), COUNT)["fix"]
    assert (await fix(client, ctx, "owner", f)).status_code == 201
    again = await fix(client, ctx, "owner", f)
    assert again.status_code == 409, again.text
    detail = again.json()["detail"]
    assert detail["changed_by"]["id"] == str(ctx.users["owner"].id)
    assert detail["message"].startswith("Changed by")
    wrong = await fix(client, ctx, "owner", f, before="Seven")
    assert wrong.status_code == 409
    async with tenant_session(ctx.tenant_id) as s:
        ops = [c.op for c in await s.scalars(select(SimpleChange))]
        assert ops == ["set_section_number"]


async def test_undo_puts_the_number_back(client):
    ctx = await clear_world(client)
    f = look(await get(client, ctx, "owner", DOC), COUNT)["fix"]
    r = await fix(client, ctx, "owner", f)
    assert r.status_code == 201, r.text
    u = await client.post(f"{CHANGES}/{r.json()['change']['id']}/undo", headers=ctx.as_("owner"))
    assert u.status_code in (200, 201), u.text
    back = await get(client, ctx, "owner", DOC)
    assert look(back, COUNT)["fix"]["value"] == "6"
    async with tenant_session(ctx.tenant_id) as s:
        d = await s.scalar(select(SimpleDraft))
        assert "later" not in (d.overlay.get("sections") or {})


async def test_who_may_fix(client):
    ctx = await clear_world(client)
    f = look(await get(client, ctx, "owner", DOC), COUNT)["fix"]
    assert (await fix(client, ctx, "viewer", f)).status_code == 403
    r = await fix(client, ctx, "approver", f)
    assert r.status_code == 201, r.text
    prop = r.json()["change"]
    assert prop["status"] == "proposed" and prop["routed_to"] == [str(ctx.users["owner"].id)]
    owner = look(await get(client, ctx, "owner", DOC), COUNT)
    assert owner["fix"]["proposal"]["change_id"] == prop["id"]
    assert owner["fix"]["proposal"]["can_decide"] is True
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.scalar(select(SimpleDraft)) is None
    acc = await client.post(f"{CHANGES}/{prop['id']}/accept", headers=ctx.as_("owner"))
    assert acc.status_code == 200, acc.text
    assert look(await get(client, ctx, "owner", DOC), COUNT) is None


async def test_another_company_cannot_fix(client):
    ctx = await clear_world(client)
    f = look(await get(client, ctx, "owner", DOC), COUNT)["fix"]
    other = await make_ctx("Other Example Co")
    r = await fix(client, other, "owner", f)
    assert r.status_code == 404, r.text
    async with tenant_session(ctx.tenant_id) as s:
        assert list(await s.scalars(select(SimpleChange))) == []
