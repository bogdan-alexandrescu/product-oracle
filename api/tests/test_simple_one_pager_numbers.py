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
- test_a_draft_in_review_holds_the_fix: protects=while the PRD's draft is in review the
  item carries no fix for who would apply it (it would be refused); a fix sent from a page
  read before is refused in the API's own words ("This PRD's draft is in review: ..."), not
  as a stale number; who proposes still proposes, and their open proposal stays on the
  owner's item; fails_when=the owner is offered "Use 6" in review, the refusal is a stale
  number's, or a proposer loses the fix; no_claim=the web (e2e simple-one-pager-number-fix).

A count in a section's HEADING (owner, Nov 5, 'Fix the heading too'), on the invented PRD
"later-list" ("Later · 8 items" over six listed):

- test_heading_count_gets_its_fix: protects=the heading item carries "Use 6" (``part``
  "heading"); the owner's fix puts the new heading in the draft (``overlay["headings"]``),
  the section's words and key unchanged, and the item clears; the one-pager names the new
  heading; fails_when=the heading item has no fix, or the fix writes the body.
- test_stale_heading_is_refused: protects=a heading that no longer says the number is 409
  "Changed by <name>"; fails_when=it applies twice.
- test_undo_puts_the_heading_back: protects=Undo takes the heading out of the draft and the
  item comes back; fails_when=the draft keeps the new heading.
- test_heading_fix_as_a_proposal: protects=an approver's fix is a proposal that writes
  nothing until the owner accepts it; fails_when=the proposal writes the heading.
- test_submitted_draft_imports_the_heading: protects=submitting the draft imports the next
  version with the new heading under the same section key, its list as it was;
  fails_when=the import drops the heading or changes the key.
"""

import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy import select, update

from oracle.docs.models import DocumentVersion, Section
from oracle.simple import change_words, one_pager, one_pager_checks
from oracle.simple.changes import ChangeError
from oracle.simple.models import SimpleChange, SimpleDraft
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.test_simple_one_pager_api import (
    CHANGES,
    MD,
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
    assert "Six features wait for next quarter." in c["after"]["sections"]["later"]["body"]
    assert "Eight features" in c["before"]["sections"]["later"]["body"]
    mine = await get(client, ctx, "owner", DOC)
    assert look(mine, COUNT) is None and look(mine, PER) is not None
    assert mine["draft"]["changes"] == 1
    async with tenant_session(ctx.tenant_id) as s:
        [d] = list(await s.scalars(select(SimpleDraft)))
        assert d.overlay["sections"]["later"].startswith("Six features wait for next quarter.")
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


IN_REVIEW = "This PRD's draft is in review: changes wait until it is approved"


async def test_a_draft_in_review_holds_the_fix(client):
    # Review finding (train AS replay review): one_pager._ensure refuses a change that applies
    # while the PRD's draft is in review, so the item offers no fix to who would apply it.
    from oracle.docs.models import Document
    from oracle.review.models import DocumentReviewPolicy
    from oracle.roadmap.models import ProductTrack

    ctx = await clear_world(client)
    async with tenant_session(ctx.tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == DOC))
        # The PRD's decider is the owner; the approver owns its track, so reads "Needs a look"
        # and proposes.
        s.add(DocumentReviewPolicy(document_id=doc.id, decider_id=ctx.users["owner"].id))
        s.add(
            ProductTrack(prd_document_id=doc.id, title="Invites", owner_id=ctx.users["approver"].id)
        )
        await s.commit()
    view = await get(client, ctx, "owner", DOC)
    read_before = look(view, COUNT)["fix"]
    assert (await fix(client, ctx, "owner", look(view, PER)["fix"])).status_code == 201
    draft_id = (await get(client, ctx, "owner", DOC))["draft"]["id"]
    sub = await client.post(f"/v1/simple/drafts/{draft_id}/submit", headers=ctx.as_("owner"))
    assert sub.status_code == 200, sub.text
    # In review: the item stays, with no fix for the owner, who would apply it.
    item = look(await get(client, ctx, "owner", DOC), COUNT)
    assert item is not None and item["fix"] is None
    # The fix from the page read before: refused in the API's words, not a stale number.
    r = await fix(client, ctx, "owner", read_before)
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == IN_REVIEW
    # Who proposes still proposes: the proposal waits, and stays on the owner's item.
    mine = look(await get(client, ctx, "approver", DOC), COUNT)
    assert mine["fix"]["words"] == "Use 6" and mine["fix"]["proposal"] is None
    r = await fix(client, ctx, "approver", mine["fix"])
    assert r.status_code == 201, r.text
    prop = r.json()["change"]
    assert prop["status"] == "proposed"
    owner = look(await get(client, ctx, "owner", DOC), COUNT)
    assert owner["fix"]["proposal"]["change_id"] == prop["id"]


# --------------------------------------------------------------------------- a heading's count

HEAD_DOC = "later-list"
HEAD_PRD = """---
title: Later list
---

## Problem {#problem}

Teams wait too long for their first invite.

## What we will build {#build}

- A faster invite
- An invite link

## Later · 8 items {#later}

- Invite by QR code
- Invite from chat
- Team templates
- Seat limits
- Guest invites
- Invite analytics
"""
HEAD = "“Later · 8 items” says 8 items, but it lists 6."


async def head_world(client):
    ctx = await make_ctx()
    r = await client.post(f"/v1/documents/{HEAD_DOC}/versions", content=HEAD_PRD.encode(),
                          headers=MD | ctx.as_("owner"))  # fmt: skip
    assert r.status_code in (200, 201), r.text
    return ctx


async def test_heading_count_gets_its_fix(client):
    ctx = await head_world(client)
    view = await get(client, ctx, "owner", HEAD_DOC)
    item = look(view, HEAD)
    assert item["fix"] == {
        "action": "set_section_number",
        "target": {
            "document_id": view["document"]["id"],
            "section": "later",
            "said": "8 items",
            "part": "heading",
        },
        "before": "8",
        "value": "6",
        "words": "Use 6",
        "proposal": None,
    }
    r = await fix(client, ctx, "owner", item["fix"])
    assert r.status_code == 201, r.text
    c = r.json()["change"]
    assert c["status"] == "applied"
    assert c["before"]["sections"]["later"]["heading"] == "Later · 8 items"
    assert c["after"]["sections"]["later"]["heading"] == "Later · 6 items"
    assert c["after"]["sections"]["later"]["body"] == c["before"]["sections"]["later"]["body"]
    async with tenant_session(ctx.tenant_id) as s:
        [d] = list(await s.scalars(select(SimpleDraft)))
        assert d.overlay["headings"] == {"later": "Later · 6 items"}
        assert "later" not in (d.overlay.get("sections") or {})
    mine = await get(client, ctx, "owner", HEAD_DOC)
    assert look(mine, HEAD) is None
    assert not [x for x in mine["needs_look"] if x["kind"] == "numbers"]
    assert {x["key"]: x["heading"] for x in mine["sections"]}.get("later") in (
        None,
        "Later · 6 items",
    )


async def test_stale_heading_is_refused(client):
    ctx = await head_world(client)
    f = look(await get(client, ctx, "owner", HEAD_DOC), HEAD)["fix"]
    assert (await fix(client, ctx, "owner", f)).status_code == 201
    again = await fix(client, ctx, "owner", f)
    assert again.status_code == 409, again.text
    detail = again.json()["detail"]
    assert detail["message"] == f"Changed by {detail['changed_by']['name']}"
    assert detail["changed_by"]["id"] == str(ctx.users["owner"].id)
    async with tenant_session(ctx.tenant_id) as s:
        assert [c.op for c in await s.scalars(select(SimpleChange))] == ["set_section_number"]


async def test_undo_puts_the_heading_back(client):
    ctx = await head_world(client)
    f = look(await get(client, ctx, "owner", HEAD_DOC), HEAD)["fix"]
    r = await fix(client, ctx, "owner", f)
    assert r.status_code == 201, r.text
    u = await client.post(f"{CHANGES}/{r.json()['change']['id']}/undo", headers=ctx.as_("owner"))
    assert u.status_code in (200, 201), u.text
    back = look(await get(client, ctx, "owner", HEAD_DOC), HEAD)
    assert back is not None and back["fix"]["words"] == "Use 6"
    async with tenant_session(ctx.tenant_id) as s:
        d = await s.scalar(select(SimpleDraft))
        assert "later" not in (d.overlay.get("headings") or {})


async def test_heading_fix_as_a_proposal(client):
    ctx = await head_world(client)
    f = look(await get(client, ctx, "owner", HEAD_DOC), HEAD)["fix"]
    r = await fix(client, ctx, "approver", f)
    assert r.status_code == 201, r.text
    prop = r.json()["change"]
    assert prop["status"] == "proposed"
    assert prop["after"]["sections"]["later"]["heading"] == "Later · 6 items"
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.scalar(select(SimpleDraft)) is None
    owner = look(await get(client, ctx, "owner", HEAD_DOC), HEAD)
    assert owner["fix"]["proposal"]["change_id"] == prop["id"]
    acc = await client.post(f"{CHANGES}/{prop['id']}/accept", headers=ctx.as_("owner"))
    assert acc.status_code == 200, acc.text
    assert look(await get(client, ctx, "owner", HEAD_DOC), HEAD) is None
    async with tenant_session(ctx.tenant_id) as s:
        d = await s.scalar(select(SimpleDraft))
        assert d.overlay["headings"] == {"later": "Later · 6 items"}


async def test_submitted_draft_imports_the_heading(client):
    ctx = await head_world(client)
    f = look(await get(client, ctx, "owner", HEAD_DOC), HEAD)["fix"]
    assert (await fix(client, ctx, "owner", f)).status_code == 201
    draft_id = (await get(client, ctx, "owner", HEAD_DOC))["draft"]["id"]
    sub = await client.post(f"/v1/simple/drafts/{draft_id}/submit", headers=ctx.as_("owner"))
    assert sub.status_code == 200, sub.text
    assert sub.json()["version"] == 2
    async with tenant_session(ctx.tenant_id) as s:
        v2 = await s.scalar(select(DocumentVersion).where(DocumentVersion.number == 2))
        assert "## Later · 6 items {#later}" in v2.markdown
        assert "8 items" not in v2.markdown
        later = await s.scalar(
            select(Section).where(Section.version_id == v2.id, Section.section_key == "later")
        )
        assert later.heading == "Later · 6 items"
        assert later.body_md.startswith("- Invite by QR code")


# --------------------------------------------------------------------------- fix round 2


async def test_fixes_in_the_draft_are_listed_with_undo(client):
    ctx = await clear_world(client)
    view = await get(client, ctx, "owner", DOC)
    assert view["fixed"] == []
    one = await fix(client, ctx, "owner", look(view, COUNT)["fix"])
    two = await fix(client, ctx, "owner", look(view, PER)["fix"])
    assert one.status_code == two.status_code == 201
    # A reload reads them from the draft's live changes, each with its Undo.
    mine = await get(client, ctx, "owner", DOC)
    assert mine["draft"]["changes"] == 2
    assert [(x["change_id"], x["can_undo"]) for x in mine["fixed"]] == [
        (one.json()["change"]["id"], True),
        (two.json()["change"]["id"], True),
    ]
    assert mine["fixed"][0]["words"] == "Fixed: set to 6 in “Not this quarter”"
    assert mine["fixed"][1]["words"].startswith("Fixed: set to 200 in “")
    assert (await get(client, ctx, "viewer", DOC))["fixed"] == []
    u = await client.post(f"{CHANGES}/{one.json()['change']['id']}/undo", headers=ctx.as_("owner"))
    assert u.status_code in (200, 201), u.text
    after = await get(client, ctx, "owner", DOC)
    assert [x["change_id"] for x in after["fixed"]] == [two.json()["change"]["id"]]
    assert look(after, COUNT) is not None


async def test_fixes_are_listed_in_the_order_they_were_made(client):
    # Two fixes made in the same instant (a frozen clock, or one second for a person) list
    # in the order they were made, not by their random ids: the later one is given the
    # smaller id here, so an order that falls back to the id lists them the wrong way.
    ctx = await clear_world(client)
    view = await get(client, ctx, "owner", DOC)
    one = (await fix(client, ctx, "owner", look(view, COUNT)["fix"])).json()["change"]
    two = (await fix(client, ctx, "owner", look(view, PER)["fix"])).json()["change"]
    first, second = uuid.UUID(int=2**128 - 1), uuid.UUID(int=1)
    async with tenant_session(ctx.tenant_id) as s:
        at = await s.scalar(select(SimpleChange.at).where(SimpleChange.id == one["id"]))
        for old, new in ((one["id"], first), (two["id"], second)):
            await s.execute(
                update(SimpleChange).where(SimpleChange.id == old).values(id=new, at=at)
            )
        await s.commit()
    mine = await get(client, ctx, "owner", DOC)
    assert [x["change_id"] for x in mine["fixed"]] == [str(first), str(second)]
    assert mine["fixed"][0]["words"] == "Fixed: set to 6 in “Not this quarter”"


async def test_a_heading_fix_is_listed(client):
    ctx = await head_world(client)
    f = look(await get(client, ctx, "owner", HEAD_DOC), HEAD)["fix"]
    assert (await fix(client, ctx, "owner", f)).status_code == 201
    [x] = (await get(client, ctx, "owner", HEAD_DOC))["fixed"]
    assert x["words"] == "Fixed: set to 6 in “Later · 6 items”" and x["can_undo"] is True


async def test_a_count_in_words_stays_in_words(client):
    ctx = await clear_world(client)
    f = look(await get(client, ctx, "owner", DOC), COUNT)["fix"]
    r = await fix(client, ctx, "owner", f)
    assert r.status_code == 201, r.text
    body = r.json()["change"]["after"]["sections"]["later"]["body"]
    assert "Six features wait for next quarter." in body and "6 features" not in body
    assert one_pager_checks.set_number("eight items", "eight items", "6") == "six items"
    assert one_pager_checks.set_number("EIGHT items", "EIGHT items", "6") == "SIX items"
    assert one_pager_checks.set_number("8 items", "8 items", "6") == "6 items"
    # A value with no word for it is written as a numeral.
    assert one_pager_checks.set_number("Eight items", "Eight items", "250") == "250 items"


async def test_change_sentence_names_the_section(client):
    ctx = await head_world(client)
    f = look(await get(client, ctx, "owner", HEAD_DOC), HEAD)["fix"]
    c = (await fix(client, ctx, "owner", f)).json()["change"]
    words = change_words.phrase(c["op"], c["target"], c["before"], c["after"], None)
    assert words == "set the count in “Later” to 6"
    body = {"sections": {"later": {"heading": "Not this quarter", "body": "x"}}}
    assert (
        change_words.phrase("set_section_number", {"section": "later"}, body, {"number": "6"}, None)
        == "set the number in “Not this quarter” to 6"
    )


async def test_empty_before_is_refused(client):
    ctx = await clear_world(client)
    f = look(await get(client, ctx, "owner", DOC), COUNT)["fix"]
    r = await fix(client, ctx, "owner", f, before="")
    assert r.status_code == 422, r.text


def test_setext_heading_is_patched():
    md = "Later · 8 items {#later}\n---------------\n\n- One\n"
    sec = Section(section_key="later", heading="Later · 8 items", body_md="- One")
    got = one_pager.patched_markdown(
        SimpleNamespace(markdown=md), [sec], {}, {"later": "Later · 6 items"}
    )
    assert got.startswith("Later · 6 items {#later}\n---------------\n")
    gone = Section(section_key="later", heading="Soon · 8 items", body_md="- One")
    with pytest.raises(ChangeError) as e:
        one_pager.patched_markdown(SimpleNamespace(markdown=md), [gone], {}, {"later": "Soon · 6"})
    assert "“Soon · 8 items”" in str(e.value.detail)


# --------------------------------------------------------------------------- follow-ups

TWO_DOC = "later-two"
TWO_PRD = HEAD_PRD.replace("title: Later list", "title: Later two").replace(
    "## Later · 8 items {#later}\n",
    "## Later · 8 items {#later}\n\nFive features wait for next quarter.\n",
)
TWO_BODY = "“Five features wait for next” says 5, but “Later · 6 items” shows 6 items."


async def two_world(client):
    ctx = await make_ctx()
    r = await client.post(f"/v1/documents/{TWO_DOC}/versions", content=TWO_PRD.encode(),
                          headers=MD | ctx.as_("owner"))  # fmt: skip
    assert r.status_code in (200, 201), r.text
    return ctx


async def test_either_of_two_fixes_in_a_section_undoes(client):
    # Review finding: with two number fixes in one section only the newer could be undone;
    # the older's Undo said "Changed by <yourself>". Each undoes its own number only.
    ctx = await two_world(client)
    head = (await fix(client, ctx, "owner", look(await get(client, ctx, "owner", TWO_DOC),
                                                 HEAD)["fix"])).json()["change"]  # fmt: skip
    body_fix = look(await get(client, ctx, "owner", TWO_DOC), TWO_BODY)["fix"]
    body = (await fix(client, ctx, "owner", body_fix)).json()["change"]
    view = await get(client, ctx, "owner", TWO_DOC)
    assert [(x["change_id"], x["can_undo"]) for x in view["fixed"]] == [
        (head["id"], True),
        (body["id"], True),
    ]
    u = await client.post(f"{CHANGES}/{head['id']}/undo", headers=ctx.as_("owner"))
    assert u.status_code in (200, 201), u.text
    async with tenant_session(ctx.tenant_id) as s:
        d = await s.scalar(select(SimpleDraft))
        assert "later" not in (d.overlay.get("headings") or {})
        assert d.overlay["sections"]["later"].startswith("Six features wait for next quarter.")
    after = await get(client, ctx, "owner", TWO_DOC)
    assert [x["change_id"] for x in after["fixed"]] == [body["id"]]
    u = await client.post(f"{CHANGES}/{body['id']}/undo", headers=ctx.as_("owner"))
    assert u.status_code in (200, 201), u.text
    async with tenant_session(ctx.tenant_id) as s:
        d = await s.scalar(select(SimpleDraft))
        assert not d.overlay.get("sections", {}).get("later")
        assert not (d.overlay.get("headings") or {})
    assert (await get(client, ctx, "owner", TWO_DOC))["fixed"] == []


async def test_undo_whose_number_is_gone_is_refused(client):
    # The older fix's number was changed again since: its undo is refused, nothing written.
    ctx = await clear_world(client)
    f = look(await get(client, ctx, "owner", DOC), COUNT)["fix"]
    one = (await fix(client, ctx, "owner", f)).json()["change"]
    async with tenant_session(ctx.tenant_id) as s:
        d = await s.scalar(select(SimpleDraft))
        secs = dict(d.overlay["sections"])
        secs["later"] = secs["later"].replace("Six features", "Seven features")
        d.overlay = {**d.overlay, "sections": secs}
        await s.commit()
    u = await client.post(f"{CHANGES}/{one['id']}/undo", headers=ctx.as_("owner"))
    assert u.status_code == 409, u.text


async def test_a_decider_who_is_no_owner_sees_the_proposal(client):
    # Review finding: the Inbox's Open on "Section number on <PRD>" lands the PRD's decider
    # (no owner) on the one-pager, where "Needs a look" was owners-only: the proposal routed
    # to them shows on its item, with Accept and Decline; nothing else does.
    from oracle.docs.models import Document
    from oracle.review.models import DocumentReviewPolicy

    ctx = await clear_world(client)
    async with tenant_session(ctx.tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == DOC))
        s.add(DocumentReviewPolicy(document_id=doc.id, decider_id=ctx.users["approver"].id))
        await s.commit()
    assert (await get(client, ctx, "approver", DOC))["needs_look"] == []
    f = look(await get(client, ctx, "owner", DOC), COUNT)["fix"]
    r = await fix(client, ctx, "commenter", f)
    assert r.status_code == 201, r.text
    prop = r.json()["change"]
    assert prop["routed_to"] == [str(ctx.users["approver"].id)]
    mine = await get(client, ctx, "approver", DOC)
    assert [x["text"] for x in mine["needs_look"]] == [COUNT]
    assert mine["needs_look"][0]["fix"]["proposal"]["change_id"] == prop["id"]
    assert mine["needs_look"][0]["fix"]["proposal"]["can_decide"] is True
    acc = await client.post(f"{CHANGES}/{prop['id']}/accept", headers=ctx.as_("approver"))
    assert acc.status_code == 200, acc.text
    assert (await get(client, ctx, "approver", DOC))["needs_look"] == []


def test_a_fix_keeps_thousands_separators():
    sec = Section(
        section_key="targets",
        heading="Targets",
        body_md="Company-wide target: 1,200,000 paid seats in total.",
    )
    f = one_pager_checks._fix(sec, "1,200,000 paid seats", "1,200,000", 1100000)
    assert f is not None and f["value"] == "1,100,000"
    plain = Section(section_key="t", heading="T", body_md="Target: 1200000 paid seats.")
    assert one_pager_checks._fix(plain, "1200000 paid seats", "1200000", 1100000)["value"] == (
        "1100000"
    )


def test_a_word_between_number_and_noun_keeps_its_fix():
    sec = Section(
        section_key="later",
        heading="Later",
        body_md="We plan two more features for spring.\n\n- One\n- Two\n- Three\n",
    )
    [x] = one_pager_checks.numbers([sec])
    assert x.fix is not None
    assert x.fix["said"] == "two more features for spring"
    assert one_pager_checks.set_number(sec.body_md, x.fix["said"], x.fix["value"]).startswith(
        "We plan three more features"
    )


async def _heading_fixed_then_edited(client, heading: str, body_lead: str = ""):
    """head_world with its heading count fixed (8 to 6), then the section edited in the
    draft: its heading to ``heading``, ``body_lead`` put before its list."""
    ctx = await head_world(client)
    f = look(await get(client, ctx, "owner", HEAD_DOC), HEAD)["fix"]
    one = (await fix(client, ctx, "owner", f)).json()["change"]
    async with tenant_session(ctx.tenant_id) as s:
        d = await s.scalar(select(SimpleDraft))
        ov = {**d.overlay, "headings": {"later": heading}}
        if body_lead:
            ov["sections"] = {"later": body_lead + one["before"]["sections"]["later"]["body"]}
        d.overlay = ov
        await s.commit()
    return ctx, one


async def test_heading_fix_undoes_after_the_heading_was_edited(client):
    # Review minor (Nov 7): a heading fix undone once the heading was edited around its
    # number puts only the number back; the edit stays and the body is untouched.
    ctx, one = await _heading_fixed_then_edited(client, "Later, after spring · 6 items")
    u = await client.post(f"{CHANGES}/{one['id']}/undo", headers=ctx.as_("owner"))
    assert u.status_code in (200, 201), u.text
    async with tenant_session(ctx.tenant_id) as s:
        d = await s.scalar(select(SimpleDraft))
        assert d.overlay["headings"] == {"later": "Later, after spring · 8 items"}
        assert "later" not in (d.overlay.get("sections") or {})


async def test_heading_fix_whose_number_left_the_heading_is_refused(client):
    # Review minor (Nov 7): once the heading no longer holds the fixed number, the undo does
    # not look for it in the body (a body number the heading fix never set): it is refused
    # with the section's words now, and nothing is written.
    ctx, one = await _heading_fixed_then_edited(
        client, "Later · 7 items", "About 6 items wait for spring.\n\n"
    )
    u = await client.post(f"{CHANGES}/{one['id']}/undo", headers=ctx.as_("owner"))
    assert u.status_code == 409, u.text
    assert u.json()["detail"]["current"]["heading"] == "Later · 7 items"
    async with tenant_session(ctx.tenant_id) as s:
        d = await s.scalar(select(SimpleDraft))
        assert d.overlay["headings"] == {"later": "Later · 7 items"}
        assert d.overlay["sections"]["later"].startswith("About 6 items wait for spring.")
        assert [c.status for c in await s.scalars(select(SimpleChange))] == ["applied"]


def test_a_fix_keeps_a_decimal_as_written():
    # Review minor (Nov 7): a decimal keeps its places and separators ("1,200.5" -> "1,502.5",
    # never "1502.5"; "2.75" -> "2.50"), and a long value is never cut ("1.23457e+06").
    def value(said: str, before: str, to: float) -> str:
        sec = Section(section_key="t", heading="T", body_md=f"Company-wide target: {said}.")
        f = one_pager_checks._fix(sec, said, before, to)
        assert f is not None
        return f["value"]

    assert value("1,200.5 paid seats", "1,200.5", 1502.5) == "1,502.5"
    assert value("1,200.75 paid seats", "1,200.75", 1502.5) == "1,502.50"
    assert value("1,200.5 paid seats", "1,200.5", 1500) == "1,500.0"
    assert value("2.75 hours saved", "2.75", 2.5) == "2.50"
    assert value("2.75 hours saved", "2.75", 3) == "3.00"
    assert value("2 hours saved", "2", 2.25) == "2.25"
    assert value("1234567 paid seats", "1234567", 1234567.5) == "1234567.5"
    assert value("1,000,000 paid seats", "1,000,000", 1234567.5) == "1,234,567.5"
    assert value("0.5 hours saved", "0.5", 0.1 * 3) == "0.3"
    sec = Section(section_key="t", heading="T", body_md="Company-wide target: 1,200.5 seats.")
    assert one_pager_checks.set_number(sec.body_md, "1,200.5 seats", "1,502.50") == (
        "Company-wide target: 1,502.50 seats."
    )


def _per_unit_text(body: str) -> list[str]:
    sec = Section(section_key="targets", heading="Targets", body_md=body)
    return [x.text for x in one_pager_checks.numbers([sec])]


def test_the_target_is_quoted_as_written():
    # Review (Nov 7): the look text quotes the company-wide target as the PRD writes it,
    # its separators kept ("1,250.75", never "1250.75").
    [text] = _per_unit_text(
        "Each region adds 300.5 paid workspaces a month. We sell in 5 regions. "
        "Company-wide target: 1,250.75 paid workspaces a month."
    )
    assert text == (
        "300.5 paid workspaces per region × 5 regions is 1,502.5, "
        "but the company-wide target says 1,250.75."
    )


def test_look_numbers_read_as_a_person_writes_them():
    # Review (Nov 7): a computed number shows plain, as the mock shows it: "0.3", never
    # "0.30000000000000004"; "1,234,567.5", never "1.23457e+06" or "1234567.5".
    assert _per_unit_text(
        "Each team saves 0.1 support hours a week. We have 3 teams. "
        "Company-wide target: 2 support hours a week."
    ) == ["0.1 support hours per team × 3 teams is 0.3, but the company-wide target says 2."]
    assert _per_unit_text(
        "Each region adds 246913.5 trial seats. We sell in 5 regions. "
        "Company-wide target: 1,000,000 trial seats."
    ) == [
        "246,913.5 trial seats per region × 5 regions is 1,234,567.5, "
        "but the company-wide target says 1,000,000."
    ]
    assert one_pager_checks._n(0.1 * 3) == "0.3"
    assert one_pager_checks._n(1234567.5) == "1,234,567.5"
    assert one_pager_checks._n(200.0) == "200"
