"""new-prd-from-replaced-prd: a new PRD can start from an approved PRD it replaces; that
PRD's standing decisions and verified estimates for the new PRD's area are its inputs.

- test_carried_decisions_are_the_standing_decided_ones: protects=the carried decisions
  are the decided decisions about the old PRD or its items that still stand; reversed,
  withdrawn and trashed ones are left out and named; fails_when=a lapsed or trashed one is
  carried, or one about another PRD is; no_claim=what the model writes from them.
- test_carried_bases_are_the_area_items_verified_ones: protects=only verified, not
  withdrawn, schedule bases of the old PRD for the area's items are carried;
  fails_when=a proposed, withdrawn, other-item or other-PRD basis is carried.
- test_brief_replaces_an_approved_prd_and_says_what_it_carries: protects=POST
  /v1/intakes with replaces stores the area and the brief (intake.carried) says which
  decisions and estimates are carried; a draft PRD cannot be replaced (422);
  fails_when=the field is dropped or a draft PRD is accepted.
- test_run_prompt_lists_the_carried_inputs: protects=the PRD writer's prompt names the
  old PRD, each carried decision and estimate and the area's items, and leaves out the
  lapsed ones; fails_when=any is missing; no_claim=other segments.
- test_critic_flags_a_departure_and_a_dropped_item: protects=the critic flags a draft
  that departs from a carried decision or drops a carried item without saying why, and
  passes one that continues or leaves an item out with why; fails_when=either is missed
  or a good draft is flagged.

Invented example data only.
"""

import uuid
from datetime import UTC, date, datetime
from types import SimpleNamespace

import pytest
from sqlalchemy import update

from oracle.decisions.models import Decision
from oracle.docs.models import Document, DocumentVersion
from oracle.intake import carried
from oracle.roadmap.models import DraftRoadmap, RoadmapItem, ScheduleBasis
from oracle.runs import service as runs_service
from oracle.tenancy import tenant_session
from tests.decision_helpers import decide, propose
from tests.intake_helpers import company, create_intake

OLD = "Example Chat PRD"
OLD_TEXT = "# Example Chat PRD\n\nRate caps, safe mode and a referral program.\n"


@pytest.fixture
async def ctx():
    return await company()


async def _prd(ctx, slug: str, title: str, *, approved: bool = True) -> dict:
    """A PRD with one version and three items: caps, safe-mode and referrals."""
    async with tenant_session(ctx.tenant_id) as s:
        state = "approved" if approved else "draft"
        doc = Document(slug=slug, title=title, kind="prd", status=state, visibility="company")
        s.add(doc)
        await s.flush()
        at = datetime(2026, 9, 1, tzinfo=UTC) if approved else None
        v = DocumentVersion(document_id=doc.id, number=1, markdown=OLD_TEXT, content_hash=slug,
                            approved_at=at)  # fmt: skip
        s.add(v)
        await s.flush()
        draft = DraftRoadmap(prd_document_id=doc.id, prd_version_id=v.id, status="ready")
        s.add(draft)
        await s.flush()
        items = {}
        for i, (key, name) in enumerate(
            (("caps", "Message rate caps"), ("safe-mode", "Safe mode"), ("referrals", "Referrals"))
        ):
            row = RoadmapItem(draft_roadmap_id=draft.id, item_key=key, position=i, title=name,
                              horizon="now", prd_document_id=doc.id,
                              prd_version_id=v.id)  # fmt: skip
            s.add(row)
            await s.flush()
            items[key] = str(row.id)
        await s.commit()
        return {"id": str(doc.id), "version": str(v.id), "items": items}


def _about(kind: str, id_: str) -> list[dict]:
    return [{"kind": kind, "id": id_, "ref": "example"}]


async def _decided(client, ctx, title: str, subjects: list[dict]) -> dict:
    d = await propose(client, ctx, title=title, subjects=subjects)
    await decide(client, ctx, d["number"])
    return d


async def _set_status(ctx, decision_id: str, status: str) -> None:
    async with tenant_session(ctx.tenant_id) as s:
        await s.execute(
            update(Decision).where(Decision.id == uuid.UUID(decision_id)).values(status=status)
        )
        await s.commit()


async def _basis(ctx, prd: dict, key: str | None, ref: str, **kw) -> None:
    async with tenant_session(ctx.tenant_id) as s:
        s.add(ScheduleBasis(kind=kw.pop("kind", "estimate"), reference=ref,
                            supports_date=kw.pop("supports", date(2026, 12, 15)),
                            prd_document_id=uuid.UUID(prd["id"]), item_key=key,
                            status=kw.pop("status", "verified"),
                            verified_at=kw.pop("verified_at", datetime(2026, 10, 1, tzinfo=UTC)),
                            **kw))  # fmt: skip
        await s.commit()


async def _world(client, ctx) -> dict:
    old = await _prd(ctx, "example-chat-prd", OLD)
    other = await _prd(ctx, "example-other-prd", "Example Other PRD")
    w = {"old": old, "other": other}
    w["cut"] = await _decided(client, ctx, "Cut voice notes", _about("document", old["id"]))
    w["cap"] = await _decided(
        client, ctx, "Cap at 30 messages a minute", _about("roadmap_item", old["items"]["caps"])
    )
    w["on_version"] = await _decided(
        client, ctx, "Launch by Dec 15", _about("document_version", old["version"])
    )
    w["reversed"] = await _decided(client, ctx, "Drop safe mode", _about("document", old["id"]))
    await _set_status(ctx, w["reversed"]["id"], "reversed")
    w["withdrawn"] = await _decided(client, ctx, "Freeze referrals", _about("document", old["id"]))
    await _set_status(ctx, w["withdrawn"]["id"], "withdrawn")
    w["open"] = await propose(client, ctx, title="Maybe add stickers",
                              subjects=_about("document", old["id"]))  # fmt: skip
    w["elsewhere"] = await _decided(client, ctx, "Other PRD call",
                                    _about("document", other["id"]))  # fmt: skip
    # About the old PRD and a roadmap now in Trash: no longer standing.
    async with tenant_session(ctx.tenant_id) as s:
        gone = Document(slug="example-test-roadmap", title="Example test roadmap", kind="roadmap")
        s.add(gone)
        await s.commit()
        gone_id = str(gone.id)
    w["trashed"] = await _decided(client, ctx, "Ship stickers",
                                  [*_about("document", old["id"]),
                                   *_about("document", gone_id)])  # fmt: skip
    r = await client.request("DELETE", "/v1/documents/example-test-roadmap",
                             headers=ctx.as_("owner"),
                             params={"reason": "A test roadmap",
                                     "confirm_published": True})  # fmt: skip
    assert r.status_code in (200, 204), r.text

    await _basis(ctx, old, "caps", "EX-101", detail="Two weeks, lead estimate")
    await _basis(ctx, old, "safe-mode", "Q4 safety plan", kind="commitment")
    await _basis(ctx, old, "referrals", "EX-303")  # outside the area
    await _basis(ctx, old, "caps", "EX-102", status="proposed", verified_at=None)
    await _basis(ctx, old, "safe-mode", "EX-104", withdrawn_at=datetime(2026, 10, 9, tzinfo=UTC))
    await _basis(ctx, old, None, "Capacity plan")  # PRD-wide, no item
    await _basis(ctx, other, "caps", "EX-900")
    return w


AREA = ["caps", "safe-mode"]


async def test_carried_decisions_are_the_standing_decided_ones(client, ctx):
    w = await _world(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        got = await carried.inputs(s, uuid.UUID(w["old"]["id"]), AREA, "User Safety",
                                   "caps, tripwires and ban prevention")  # fmt: skip
    titles = [d.title for d in got.carried.decisions]
    assert sorted(titles) == ["Cap at 30 messages a minute", "Cut voice notes", "Launch by Dec 15"]
    left = " ".join(got.carried.left_out)
    assert f"D-{w['reversed']['number']} Drop safe mode (reversed)" in left
    assert f"D-{w['withdrawn']['number']} Freeze referrals (withdrawn)" in left
    assert f"D-{w['trashed']['number']} Ship stickers (about a roadmap now in Trash)" in left
    assert "Other PRD call" not in left and "stickers" not in " ".join(titles)
    assert got.markdown == OLD_TEXT
    assert [i.key for i in got.carried.items if i.in_area] == AREA


async def test_carried_bases_are_the_area_items_verified_ones(client, ctx):
    w = await _world(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        got = await carried.inputs(s, uuid.UUID(w["old"]["id"]), AREA)
    assert sorted(b.reference for b in got.carried.bases) == ["EX-101", "Q4 safety plan"]
    assert {b.item_key for b in got.carried.bases} == set(AREA)


async def test_brief_replaces_an_approved_prd_and_says_what_it_carries(client, ctx):
    w = await _world(client, ctx)
    r = await client.get(f"/v1/intakes/replaces/{w['old']['id']}/carried",
                         params={"item_keys": AREA}, headers=ctx.as_("commenter"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert sorted(b["reference"] for b in r.json()["bases"]) == ["EX-101", "Q4 safety plan"]

    replaces = {"document_id": w["old"]["id"], "area_name": "User Safety",
                "area_scope": "caps, tripwires and ban prevention", "item_keys": AREA}  # fmt: skip
    made = await create_intake(client, ctx, replaces=replaces)
    c = made["intake"]["carried"]
    assert c["title"] == OLD
    assert (c["area_name"], c["area_scope"]) == (
        "User Safety",
        "caps, tripwires and ban prevention",
    )
    assert len(c["decisions"]) == 3 and len(c["bases"]) == 2

    draft = await _prd(ctx, "example-draft-prd", "Example Draft PRD", approved=False)
    bad = {**replaces, "document_id": draft["id"]}
    await create_intake(client, ctx, expect=422, replaces=bad)


async def test_run_prompt_lists_the_carried_inputs(client, ctx):
    w = await _world(client, ctx)
    replaces = {"document_id": w["old"]["id"], "area_name": "User Safety",
                "area_scope": "caps, tripwires and ban prevention", "item_keys": AREA}  # fmt: skip
    made = await create_intake(client, ctx, replaces=replaces)
    run = SimpleNamespace(knobs={"intake_id": made["intake"]["id"]})
    async with tenant_session(ctx.tenant_id) as s:
        assert await runs_service._carried_lines(s, run, "baseline") == []
        text = "\n".join(await runs_service._carried_lines(s, run, "prd_draft"))
    assert OLD in text and "User Safety: caps, tripwires and ban prevention" in text
    for d in ("cut", "cap", "on_version"):
        assert f"- D-{w[d]['number']} " in text
    assert f"- D-{w['reversed']['number']} " not in text
    assert "EX-101" in text and "Dec 15, 2026" in text and "Q4 safety plan" in text
    assert "EX-303" not in text and "EX-102" not in text and "EX-900" not in text
    assert "Continues: <old item name> (<old key>)" in text and "Rate caps, safe mode" in text


def _carried(n_cap: int = 7) -> carried.Carried:
    return carried.Carried(
        document_id=uuid.uuid4(), slug="example-chat-prd", title=OLD, version=1,
        items=[carried.CarriedItem(key="caps", title="Message rate caps", in_area=True),
               carried.CarriedItem(key="safe-mode", title="Safe mode", in_area=True)],
        decisions=[carried.CarriedDecision(id=uuid.uuid4(), number=n_cap,
                                           title="Cap at 30 messages a minute")],
    )  # fmt: skip


CARRIED_SECTION = f"# Carried from {OLD} {{#carried}}\n- D-7 Cap at 30 messages a minute\n"


def test_critic_flags_a_departure_and_a_dropped_item():
    c = _carried()
    good = CARRIED_SECTION + (
        "# Rate caps {#caps}\nContinues: caps\nWe keep D-7 Cap at 30 messages a minute.\n"
        "# Left out {#out}\nNot carried: safe-mode because the Growth PRD takes it.\n"
    )
    assert carried.draft_problems(c, good, AREA) == []

    departs = good.replace("We keep D-7", "This draft departs from D-7")
    codes = [p.code for p in carried.draft_problems(c, departs, AREA)]
    assert codes == ["carried_decision_contradicted"]

    dropped = CARRIED_SECTION + "# Rate caps {#caps}\nContinues: caps\nWe keep D-7.\n"
    problems = carried.draft_problems(c, dropped, AREA)
    assert [(p.code, p.refs) for p in problems] == [
        ("carried_item_dropped", {"item_key": "safe-mode"})
    ]

    no_why = dropped + "Not carried: safe-mode\n"
    assert [p.code for p in carried.draft_problems(c, no_why, AREA)] == ["carried_item_dropped"]
    # D-70 is not D-7.
    other = good.replace("We keep D-7", "This draft departs from D-70")
    assert carried.draft_problems(c, other, AREA) == []


async def test_new_prd_items_keep_a_link_to_the_old_items_they_continue(client, ctx):
    """protects=the new PRD's draft items keep a ``continues`` link to the old PRD's items
    their section continues (or that they declare), naming the old PRD; fails_when=no
    link, or a link on an item that continues nothing; no_claim=carrying estimates over."""
    import hashlib

    from oracle.docs.models import Section
    from oracle.roadmap import items as items_mod
    from oracle.runs.models import Run

    w = await _world(client, ctx)
    replaces = {"document_id": w["old"]["id"], "area_name": "User Safety",
                "area_scope": "caps, tripwires and ban prevention", "item_keys": AREA}  # fmt: skip
    made = await create_intake(client, ctx, replaces=replaces)
    bodies = {
        "rate-limits": "Continues: caps\nKeep D-1 as decided.",
        "safety": "Safe mode for new accounts.",
        "growth": "Invites for teams.",
    }
    async with tenant_session(ctx.tenant_id) as s:
        doc = Document(slug="example-user-safety", title="Example User Safety PRD", kind="prd")
        s.add(doc)
        await s.flush()
        v = DocumentVersion(document_id=doc.id, number=1, markdown="# Example\n", content_hash="x")
        s.add(v)
        await s.flush()
        for i, (key, body) in enumerate(bodies.items()):
            s.add(Section(version_id=v.id, section_key=key, ordinal=i, level=2, heading=key,
                          body_md=body, body_text=body,
                          content_hash=hashlib.sha256(body.encode()).hexdigest()))  # fmt: skip
        s.add(Run(flow="baseline_to_prd", status="running", document_id=doc.id,
                  created_by=ctx.users["owner"].id,
                  knobs={"intake_id": made["intake"]["id"]}))  # fmt: skip
        draft = DraftRoadmap(prd_document_id=doc.id, prd_version_id=v.id, status="ready")
        s.add(draft)
        await s.flush()
        text = (
            "version: 1\nprd: {document: example-user-safety, version: 1}\nitems:\n"
            "  - {id: limits, title: Rate limits, horizon: now, prd_section: rate-limits}\n"
            "  - {id: safe, title: Safe mode, horizon: now, prd_section: safety,"
            " continues: safe-mode}\n"
            "  - {id: invites, title: Team invites, horizon: next, prd_section: growth}\n"
        )
        result = await items_mod.import_items(s, v, text, draft=draft)
        links = {
            i.item_key: [
                (t["id"], t["key"], t["via"]) for t in i.trace if t["target"] == "continues"
            ]
            for i in result.items
        }
    assert links == {
        "limits": [(w["old"]["id"], "caps", "section")],
        "safe": [(w["old"]["id"], "safe-mode", "declared")],
        "invites": [],
    }


def _titled(title: str) -> carried.Carried:
    c = _carried()
    c.decisions[0].title = title
    return c


def test_critic_reads_departure_words_outside_the_decisions_own_title():
    """protects=a carried decision whose own title has a departure word ('override',
    'instead of') is not flagged when the draft names it, in the 'Carried from' list or in
    the text; a departure said outside its title still is; fails_when=the title's own words
    flag it (the draft is sent back for ever)."""
    for title in ("Allow an admin override of the alert cap", "Use SMS instead of email"):
        c = _titled(title)
        listed = (
            f"# Carried from {OLD} {{#carried}}\n- D-7 {title} (kept)\n"
            f"# Alerts {{#alerts}}\nContinues: Message rate caps (caps)\nWe keep D-7 {title}.\n"
            "Not carried: Safe mode (safe-mode) because the Growth PRD takes it.\n"
        )
        assert carried.draft_problems(c, listed, AREA) == [], title
        departs = listed.replace(f"We keep D-7 {title}.", f"We reverse D-7 {title}.")
        assert [p.code for p in carried.draft_problems(c, departs, AREA)] == [
            "carried_decision_contradicted"
        ], title


def test_critic_wants_the_carried_from_section():
    """protects=a draft that carries decisions or estimates has its 'Carried from <old
    PRD>' section; fails_when=a draft without it passes."""
    c = _carried()
    body = (
        "# Rate caps {#caps}\nContinues: caps\nWe keep D-7.\n"
        "Not carried: safe-mode because the Growth PRD takes it.\n"
    )
    problems = carried.draft_problems(c, body, AREA)
    assert [p.code for p in problems] == ["carried_section_missing"]
    assert f"Carried from {OLD}" in problems[0].message
    assert carried.draft_problems(c, CARRIED_SECTION + body, AREA) == []
    # Nothing carried: no section is asked for.
    bare = carried.Carried(document_id=uuid.uuid4(), slug="example-chat-prd", title=OLD,
                           version=1, items=c.items, decisions=[])  # fmt: skip
    assert carried.draft_problems(bare, body, AREA) == []


def test_markers_name_the_item_and_its_key():
    """protects=the 'Continues:' and 'Not carried:' lines people read name the item with
    its key ('Safe mode (safe-mode)'), the critic matches on the key in brackets, not on
    words of the name; fails_when=a raw key is asked for, or a name's word is taken as a
    key."""
    c = carried.Carried(
        document_id=uuid.uuid4(), slug="example-chat-prd", title=OLD, version=1,
        items=[carried.CarriedItem(key="caps", title="Safe mode caps", in_area=True),
               carried.CarriedItem(key="safe-mode", title="Safe mode", in_area=True)],
    )  # fmt: skip
    md = "# Caps {#caps}\nContinues: Safe mode caps (caps)\n"
    assert carried.continues_in(md) == ["caps"]
    # 'safe-mode' is neither continued nor left out: the name 'Safe mode caps' is no key.
    assert [p.refs for p in carried.draft_problems(c, md, AREA)] == [{"item_key": "safe-mode"}]
    assert (
        "Not carried: Safe mode (safe-mode) because"
        in carried.draft_problems(c, md, AREA)[0].message
    )
    left = md + "Not carried: Safe mode (safe-mode) because the Growth PRD takes it.\n"
    assert carried.draft_problems(c, left, AREA) == []
    # A bare key still reads.
    assert carried.continues_in("Continues: caps, safe-mode\n") == ["caps", "safe-mode"]


async def test_a_run_draft_that_departs_is_sent_back(client, ctx):
    """protects=import_draft, for a run whose brief replaces a PRD, refuses a draft the
    critic flags (DraftError naming the problem) and takes one it passes;
    fails_when=the hook is dropped."""
    from oracle.docs import service as docs_service
    from oracle.docs.service import DraftError
    from oracle.runs.models import Run

    w = await _world(client, ctx)
    replaces = {"document_id": w["old"]["id"], "area_name": "User Safety",
                "area_scope": "caps, tripwires and ban prevention", "item_keys": AREA}  # fmt: skip
    made = await create_intake(client, ctx, replaces=replaces)
    n = w["cap"]["number"]
    head = "---\ndocument: example-user-safety\ntitle: Example User Safety PRD\n---\n"
    good = (
        f"{head}# Carried from {OLD} {{#carried}}\n\n- D-{n} Cap at 30 messages a minute\n\n"
        f"# Rate caps {{#caps}}\n\nContinues: Message rate caps (caps)\n\n"
        "Not carried: Safe mode (safe-mode) because the Growth PRD takes it.\n"
    )
    bad = good.replace("Not carried: Safe mode (safe-mode) because the Growth PRD takes it.\n",
                       f"We reverse D-{n} here.\n")  # fmt: skip
    from oracle.auth.deps import Principal

    principal = Principal(tenant_id=ctx.tenant_id, kind="user", role="owner",
                          user_id=ctx.users["owner"].id)  # fmt: skip
    async with tenant_session(ctx.tenant_id) as s:
        run = Run(flow="baseline_to_prd", status="running", created_by=ctx.users["owner"].id,
                  knobs={"intake_id": made["intake"]["id"]})  # fmt: skip
        s.add(run)
        await s.flush()
        with pytest.raises(DraftError) as e:
            await docs_service.import_draft(s, "example-user-safety", bad, principal,
                                            run_id=run.id, commit=False)  # fmt: skip
        codes = sorted(p.code for p in e.value.problems)
        assert codes == ["carried_decision_contradicted", "carried_item_dropped"]
        result = await docs_service.import_draft(s, "example-user-safety", good, principal,
                                                 run_id=run.id, commit=False)  # fmt: skip
        assert result.version.number == 1


async def test_a_lapsed_approval_leaves_the_replaces_picker(client, ctx):
    """protects=the Replaces picker (the PRDs GET /v1/documents?kind=prd gives an
    approved_version) offers exactly the PRDs a brief may replace: once a PRD's approval
    lapses (C2) it has no approved_version and its carried read is refused alike;
    fails_when=a lapsed PRD is still offered, so picking it fails with a 422."""
    from oracle.review.state import lapse_approvals

    old = await _prd(ctx, "example-chat-prd", OLD)
    kept = await _prd(ctx, "example-other-prd", "Example Other PRD")
    owner = ctx.users["owner"].id
    async with tenant_session(ctx.tenant_id) as s:
        await s.execute(
            update(DocumentVersion)
            .where(DocumentVersion.id == uuid.UUID(old["version"]))
            .values(approved_by=owner)
        )
        await lapse_approvals(s, None, reason="approver demoted to commenter", reviewer_id=owner)
        await s.commit()
    r = await client.get("/v1/documents", params={"kind": "prd"}, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    offered = {d["id"] for d in r.json() if d["approved_version"] is not None}
    assert offered == {kept["id"]}
    for doc_id, status in ((old["id"], 422), (kept["id"], 200)):
        got = await client.get(f"/v1/intakes/replaces/{doc_id}/carried", headers=ctx.as_("owner"))
        assert got.status_code == status, got.text
