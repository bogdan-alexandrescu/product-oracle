"""F1 Plan screen: ``GET /v1/plan`` and ``GET /v1/plan/items/history`` (oracle.plan).

Each test seeds exactly the situation it names through the models (documents, versions,
roadmap items, tracks, tracker records, schedule bases, runs and checkpoints) and reads
the Plan as a person of the company would. Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_plan_lists_both_prds_and_every_item_once: protects=one tracked PRD and one PRD in
  draft give 2 cards and each item once, approved v1 items as ``approved`` and v2 items as
  ``draft``; fails_when=an item shows twice, a PRD is missing, an origin is wrong;
  no_claim=items are seeded rows, not built by a prd_to_roadmap run.
- test_scope_approved_drops_draft_items: protects=``scope=approved`` returns no draft
  item and no figure counted from drafts; fails_when=a draft row leaks into the approved
  view; no_claim=the browser's remembered choice (Playwright covers it on the mock).
- test_item_state (parametrized, one per §5 row): protects=the state chip's rule;
  fails_when=the first matching rule is not the one applied; no_claim=tracker records
  are seeded rows, not read from a tracker.
- test_a_moved_draft_item_says_from_where: protects=the moved change from Now to Next;
  fails_when=the diff is not the one engine's; no_claim=the UI suffix wording.
- test_change_counts_plan_changes_only: protects=a confidence change or a 1-place rank
  shift is no counted change, an outcome change is; fails_when=notes count; no_claim=none.
- test_prd_stage (parametrized, one per §4 row): protects=stage, stage line and journey
  step; fails_when=a PRD shows the wrong stage; no_claim=runs are seeded rows, no
  SwarmCloud workflow runs.
- test_engineering_stop_lines: protects=F4's two engineering stage lines and who they wait
  for; fails_when=the lead or the approver fallback is wrong; no_claim=no engineering lead
  can be named yet (A3): the rule is called with one.
- test_next_decision (parametrized, one per §7 row): protects=next.action and next.who;
  fails_when=the wrong decision or decider is named; no_claim=the F2/F3/F7 dialogs.
- test_another_companys_rows_never_appear: protects=company scoping; fails_when=an id of
  the other company appears; no_claim=none.
- test_run_tokens_are_refused_and_viewers_read: protects=403 for a run (any scope), 200
  for a viewer, no MCP scope for the area; fails_when=a run's agent reads the Plan;
  no_claim=the MCP transport itself (scopes are checked as oracle.mcp.tools does).
- test_query_budget: protects=at most 20 + 6 x tracks statements with 30 tracks and 300
  items; fails_when=the route reads per track or per item; no_claim=timings.
- test_item_history_in_version_order: protects=one entry per roadmap version that has
  the item, in version order; fails_when=a version is missing, repeated or out of order;
  no_claim=tracker events (F2 fills them).
"""

import hashlib
import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import event, select

from oracle.auth.deps import RUN_TOKEN_HEADER
from oracle.baseline.models import Edge, Entity
from oracle.db import get_engine
from oracle.docs.models import Document, DocumentVersion
from oracle.mcp import scopes
from oracle.plan import service
from oracle.roadmap.models import (
    ProductTrack,
    RoadmapItem,
    ScheduleBasis,
    TrackerRecord,
    TrackMilestone,
)
from oracle.runs.models import Checkpoint, Run, RunSegment
from oracle.runtokens import mint_run_token
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx

TODAY = datetime.now(UTC).date()
DAY = TODAY + timedelta(days=30)


class Seed:
    """Adds rows to one company's session; the caller commits."""

    def __init__(self, s) -> None:
        self.s = s

    async def add(self, row):
        self.s.add(row)
        await self.s.flush()
        return row

    async def doc(self, slug: str, kind: str = "prd", status: str = "draft") -> Document:
        return await self.add(Document(slug=slug, title=slug.replace("-", " ").title(),
                                       kind=kind, status=status))  # fmt: skip

    async def version(
        self, doc: Document, n: int, *, approved: bool = False, source=None
    ) -> DocumentVersion:
        text = f"# {doc.slug} v{n}\n"
        return await self.add(
            DocumentVersion(
                document_id=doc.id,
                number=n,
                markdown=text,
                content_hash=hashlib.sha256(text.encode()).hexdigest(),
                approved_at=datetime(2026, 10, n, tzinfo=UTC) if approved else None,
                source_version_id=source.id if source is not None else None,
            )
        )

    async def entity(self, type_: str, key: str, **attrs) -> Entity:
        return await self.add(Entity(type=type_, key=key, title=key.title(), status="confirmed",
                                     origin="user", attrs=attrs))  # fmt: skip

    async def supports(self, feature: Entity, goal: Entity) -> None:
        await self.add(Edge(src_id=feature.id, dst_id=goal.id, type="supports",
                            status="confirmed", origin="user"))  # fmt: skip

    async def item(
        self, rv: DocumentVersion, key: str, prd: DocumentVersion | None, **kw: Any
    ) -> RoadmapItem:
        roadmap_id = rv.document_id
        kw.setdefault("horizon", "now")
        kw.setdefault("position", 0)
        kw.setdefault("title", key.replace("-", " ").title())
        return await self.add(
            RoadmapItem(
                roadmap_document_id=roadmap_id,
                roadmap_version_id=rv.id,
                item_key=key,
                prd_document_id=prd.document_id if prd is not None else None,
                prd_version_id=prd.id if prd is not None else None,
                prd_section_key=kw.pop("section", f"section-{key}"),
                **kw,
            )
        )

    async def track(
        self, prd: DocumentVersion, roadmap: Document | None = None, **kw: Any
    ) -> ProductTrack:
        return await self.add(
            ProductTrack(
                prd_document_id=prd.document_id,
                started_version_id=prd.id,
                current_version_id=prd.id,
                roadmap_document_id=roadmap.id if roadmap is not None else None,
                title="Track",
                **kw,
            )
        )

    async def record(self, track: ProductTrack, key: str, ref: str, **kw: Any) -> TrackerRecord:
        kw.setdefault("state", "in_progress")
        url = f"https://tracker.example.com/{ref}"
        return await self.add(TrackerRecord(tracker="linear", external_ref=ref, track_id=track.id,
                                            item_key=key, observed_at=datetime.now(UTC),
                                            url=url, **kw))  # fmt: skip

    async def basis(
        self, prd: DocumentVersion, ref: str, day: date, status: str = "verified"
    ) -> ScheduleBasis:
        return await self.add(ScheduleBasis(kind="estimate", reference=ref, supports_date=day,
                                            prd_document_id=prd.document_id, status=status,
                                            verified_at=datetime.now(UTC)))  # fmt: skip

    async def run(
        self,
        doc: Document,
        status: str,
        segments: list[tuple[str, str]],
        checkpoint: tuple[str, str, str] | None = None,
        flow: str = "baseline_to_prd",
    ) -> Run:
        run = await self.add(Run(flow=flow, status=status, document_id=doc.id))
        for seq, (name, st) in enumerate(segments):
            await self.add(RunSegment(run_id=run.id, seq=seq, name=name, status=st))
        if checkpoint is not None:
            kind, role, segment = checkpoint
            await self.add(Checkpoint(run_id=run.id, kind=kind, approver_role=role,
                                      payload={"segment": segment}))  # fmt: skip
        return run

    async def approved_roadmap(self, slug: str, keys: list[str], **item_kw: Any):
        """A PRD with an approved v1, its roadmap v1 (approved) with ``keys`` in Now, and
        an active track following it. Returns (prd v1, roadmap doc, roadmap v1, track,
        items)."""
        prd = await self.doc(slug, status="approved")
        p1 = await self.version(prd, 1, approved=True)
        roadmap = await self.doc(f"{slug}-roadmap", kind="roadmap", status="approved")
        r1 = await self.version(roadmap, 1, approved=True, source=p1)
        track = await self.track(p1, roadmap)
        items = [
            await self.item(r1, k, p1, position=i, track_id=track.id, **item_kw)
            for i, k in enumerate(keys)
        ]
        return p1, roadmap, r1, track, items


async def plan(client, ctx: Ctx, who: str = "approver", **params) -> dict:
    resp = await client.get("/v1/plan", params=params, headers=ctx.as_(who))
    assert resp.status_code == 200, resp.text
    return resp.json()


def by_key(body: dict) -> dict[str, dict]:
    return {i["key"]: i for i in body["items"]}


def card(body: dict, slug: str) -> dict:
    return next(p for p in body["prds"] if p["document"]["slug"] == slug)


# --- the whole view --------------------------------------------------------------------------


async def seed_two_prds(ctx: Ctx) -> None:
    """PRD A, tracked: approved roadmap v1 with three items. PRD B in draft: approved v1
    with roadmap v1 (b1 Now, b2 Next) and a draft v2 whose roadmap draft v2 moves b1 to
    Next, drops b2 and adds b3."""
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        await seed.approved_roadmap("prd-a", ["a1", "a2", "a3"])
        prd = await seed.doc("prd-b", status="in_review")
        p1 = await seed.version(prd, 1, approved=True)
        p2 = await seed.version(prd, 2)
        roadmap = await seed.doc("prd-b-roadmap", kind="roadmap", status="in_review")
        r1 = await seed.version(roadmap, 1, approved=True, source=p1)
        r2 = await seed.version(roadmap, 2, source=p2)
        await seed.item(r1, "b1", p1, position=0)
        await seed.item(r1, "b2", p1, position=1, horizon="next")
        await seed.item(r2, "b1", p2, position=0, horizon="next")
        await seed.item(r2, "b3", p2, position=1, horizon="later")
        await s.commit()


async def test_plan_lists_both_prds_and_every_item_once(client):
    ctx = await make_ctx()
    await seed_two_prds(ctx)
    body = await plan(client, ctx)
    assert body["scope"] == "all"
    assert sorted(p["document"]["slug"] for p in body["prds"]) == ["prd-a", "prd-b"]
    keys = [i["key"] for i in body["items"]]
    assert sorted(keys) == ["a1", "a2", "a3", "b1", "b2", "b3"]
    items = by_key(body)
    assert {k: items[k]["origin"] for k in keys} == {
        "a1": "approved", "a2": "approved", "a3": "approved",
        "b1": "draft", "b2": "approved", "b3": "draft",
    }  # fmt: skip
    assert items["b2"]["change"] == {"kind": "dropped", "from_horizon": None,
                                     "to_horizon": None, "fields": [], "notes": [],
                                     "draft_version": 2}  # fmt: skip
    assert items["b3"]["change"]["kind"] == "new"
    assert items["b1"]["prd"]["version"] == 2 and items["b1"]["prd"]["approved"] is False
    assert items["b1"]["prd"]["link"] == "/documents/prd-b/v/2#section-b1"
    assert items["b1"]["roadmap"] == {"slug": "prd-b-roadmap", "version": 2, "anchor": "next-b1"}
    assert items["a1"]["roadmap"] == {"slug": "prd-a-roadmap", "version": 1, "anchor": "now-a1"}
    assert body["counts"] == {"prds": 2, "at_risk": 0, "proposed": 2, "items": 6}
    assert card(body, "prd-b")["figure"] == "2 items · 1 moved"
    assert card(body, "prd-a")["figure"] == "On track"


async def test_scope_approved_drops_draft_items(client):
    ctx = await make_ctx()
    await seed_two_prds(ctx)
    body = await plan(client, ctx, scope="approved")
    assert body["scope"] == "approved"
    assert [i for i in body["items"] if i["origin"] == "draft"] == []
    assert sorted(i["key"] for i in body["items"]) == ["a1", "a2", "a3", "b1", "b2"]
    assert all(i["change"] is None for i in body["items"])
    assert body["counts"]["proposed"] == 0
    # The PRD still has its card; the figure counted from its draft is gone.
    assert card(body, "prd-b")["figure"] is None
    assert (await client.get("/v1/plan", params={"scope": "x"},
                             headers=ctx.as_("viewer"))).status_code == 422  # fmt: skip


async def test_goal_ids_come_from_the_features_supports_edges(client):
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        goal = await seed.entity("goal", "g-activation")
        other = await seed.entity("feature", "f-other")
        feature = await seed.entity("feature", "f-pay")
        await seed.supports(feature, goal)
        await seed.add(Edge(src_id=feature.id, dst_id=other.id, type="depends_on",
                            status="confirmed", origin="user"))  # fmt: skip
        p1, roadmap, r1, track, _ = await seed.approved_roadmap("prd-a", [])
        await seed.item(r1, "served", p1, feature_id=feature.id, track_id=track.id)
        await seed.item(r1, "orphan", p1, position=1, track_id=track.id)
        await s.commit()
        goal_id = goal.id
    items = by_key(await plan(client, ctx))
    assert items["served"]["goal_ids"] == [str(goal_id)]
    assert items["orphan"]["goal_ids"] == []


# --- item state (§5) -------------------------------------------------------------------------


async def _proposed(seed: Seed):
    prd = await seed.doc("prd-x")
    p1 = await seed.version(prd, 1)
    roadmap = await seed.doc("prd-x-roadmap", kind="roadmap")
    r1 = await seed.version(roadmap, 1, source=p1)
    await seed.item(r1, "it", p1)


async def _done(seed: Seed):
    _, _, _, track, _ = await seed.approved_roadmap("prd-x", ["it"])
    await seed.record(track, "it", "ENG-1", state="done")


async def _slipped_overdue(seed: Seed):
    p1, _, _, track, _ = await seed.approved_roadmap("prd-x", ["it"])
    past = await seed.basis(p1, "ENG-0", TODAY - timedelta(days=3))
    await seed.add(TrackMilestone(track_id=track.id, name="Beta", target_date=past.supports_date,
                                  basis_ids=[past.id], item_keys=["it"]))  # fmt: skip
    await seed.record(track, "it", "ENG-1")


async def _slipped_milestone_passed(seed: Seed):
    p1, _, _, track, _ = await seed.approved_roadmap("prd-x", ["it"])
    past = await seed.basis(p1, "ENG-0", TODAY - timedelta(days=3))
    await seed.add(TrackMilestone(track_id=track.id, name="Beta", target_date=past.supports_date,
                                  basis_ids=[past.id], item_keys=["it"]))  # fmt: skip


async def _at_risk(seed: Seed):
    await seed.approved_roadmap(
        "prd-x", ["it"], freshness="potentially_stale", stale_reasons=["section changed"]
    )


async def _on_track(seed: Seed):
    _, _, _, track, _ = await seed.approved_roadmap("prd-x", ["it"])
    await seed.record(track, "it", "ENG-1")


async def _planned(seed: Seed):
    await seed.approved_roadmap("prd-x", ["it"], horizon="next")


@pytest.mark.parametrize(
    ("situation", "state"),
    [
        (_proposed, "proposed"),
        (_done, "done"),
        (_slipped_overdue, "slipped"),
        (_slipped_milestone_passed, "slipped"),
        (_at_risk, "at_risk"),
        (_on_track, "on_track"),
        (_planned, "planned"),
    ],
)
async def test_item_state(client, situation, state):
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        await situation(Seed(s))
        await s.commit()
    body = await plan(client, ctx)
    (item,) = body["items"]
    assert item["state"] == state, item
    if state in ("at_risk", "slipped"):
        assert item["reasons"] and body["counts"]["at_risk"] == 1


async def test_why_it_needs_you_names_one_count(client):
    """#505: an item marked by two bulk writes says what changed once, with the latest
    count; never "42 baseline items changed; 11 baseline items changed"."""
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        await Seed(s).approved_roadmap(
            "prd-x",
            ["it"],
            freshness="potentially_stale",
            stale_reasons=["42 baseline items changed", "11 baseline items changed"],
        )
        await s.commit()
    (item,) = (await plan(client, ctx))["items"]
    stale = [r["detail"] for r in item["reasons"] if r["kind"] == "stale"]
    assert stale == ["11 baseline items changed"]


async def draft_twin(client, ctx: Ctx, approved: dict[str, Any], draft: dict[str, Any]) -> dict:
    """An approved roadmap v1 with item ``it`` and a draft v2 with its twin."""
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        p1, roadmap, r1, track, _ = await seed.approved_roadmap("prd-x", ["it"], **approved)
        r2 = await seed.version(roadmap, 2, source=p1)
        await seed.item(r2, "it", p1, track_id=track.id, **draft)
        await s.commit()
    (item,) = (await plan(client, ctx))["items"]
    return item


async def test_a_moved_draft_item_says_from_where(client):
    ctx = await make_ctx()
    item = await draft_twin(client, ctx, {"horizon": "now"}, {"horizon": "next"})
    assert item["origin"] == "draft" and item["state"] == "proposed"
    assert item["change"]["kind"] == "moved"
    assert (item["change"]["from_horizon"], item["change"]["to_horizon"]) == ("now", "next")


@pytest.mark.parametrize(
    ("approved", "draft", "kind", "fields", "notes"),
    [
        ({"confidence": "high"}, {"confidence": "low"}, "unchanged", [], ["confidence"]),
        ({"priority": {"rank": 3}}, {"priority": {"rank": 4}}, "unchanged", [], ["rank"]),
        ({"priority": {"rank": 3}}, {"priority": {"rank": 5}}, "changed", ["rank"], []),
        ({"outcome": "Faster"}, {"outcome": "Fewer drop-offs"}, "changed", ["outcome"], []),
    ],
)
async def test_change_counts_plan_changes_only(client, approved, draft, kind, fields, notes):
    ctx = await make_ctx()
    item = await draft_twin(client, ctx, approved, draft)
    assert item["change"]["kind"] == kind
    assert item["change"]["fields"] == fields and item["change"]["notes"] == notes


# --- PRD stage (§4) --------------------------------------------------------------------------


async def _closed(seed: Seed):
    prd = await seed.doc("prd-x", status="in_review")
    p1 = await seed.version(prd, 1, approved=True)
    await seed.version(prd, 2)
    await seed.track(p1, status="closed")


async def _paused(seed: Seed):
    prd = await seed.doc("prd-x", status="approved")
    p1 = await seed.version(prd, 1, approved=True)
    await seed.track(p1, status="paused")


async def _waiting_feature_set(seed: Seed):
    prd = await seed.doc("prd-x")
    await seed.version(prd, 1)
    await seed.run(prd, "awaiting_checkpoint", [("baseline", "succeeded"),
                                                ("feature_set", "succeeded")],
                   ("feature_set", "approver", "feature_set"))  # fmt: skip


async def _waiting_prd_review(seed: Seed):
    prd = await seed.doc("prd-x")
    await seed.version(prd, 1)
    await seed.run(prd, "awaiting_checkpoint", [("prd_draft", "succeeded")],
                   ("prd_review", "approver", "prd_draft"))  # fmt: skip


async def _drafting(seed: Seed):
    prd = await seed.doc("prd-x")
    await seed.version(prd, 1)
    await seed.run(prd, "running", [("priority", "succeeded"), ("prd_draft", "running")])


async def _approved_and_in_review(seed: Seed):
    prd = await seed.doc("prd-x", status="in_review")
    await seed.version(prd, 1, approved=True)
    await seed.version(prd, 2)


async def _approved_and_draft(seed: Seed):
    prd = await seed.doc("prd-x", status="draft")
    await seed.version(prd, 1, approved=True)
    await seed.version(prd, 2)


async def _in_build(seed: Seed):
    _, _, _, track, _ = await seed.approved_roadmap("prd-x", ["it"])
    await seed.record(track, "it", "ENG-1")


async def _approved(seed: Seed):
    prd = await seed.doc("prd-x", status="approved")
    p1 = await seed.version(prd, 1, approved=True)
    await seed.track(p1)


async def _in_review_with_roadmap_draft(seed: Seed):
    prd = await seed.doc("prd-x", status="in_review")
    await seed.version(prd, 1)
    p2 = await seed.version(prd, 2)
    roadmap = await seed.doc("prd-x-roadmap", kind="roadmap")
    await seed.version(roadmap, 1)
    r2 = await seed.version(roadmap, 2, source=p2)
    await seed.item(r2, "it", p2)


async def _in_review(seed: Seed):
    prd = await seed.doc("prd-x", status="in_review")
    await seed.version(prd, 1)
    await seed.version(prd, 2)


async def _draft(seed: Seed):
    prd = await seed.doc("prd-x")
    await seed.version(prd, 1)


async def _brief(seed: Seed):
    await seed.doc("prd-x")


@pytest.mark.parametrize(
    ("situation", "who", "stage", "label", "step"),
    [
        (_closed, "approver", "closed", "Closed", 9),
        (_paused, "approver", "paused", "Paused", 9),
        (_waiting_feature_set, "approver", "waiting", "Feature set · waiting for you", 7),
        (_waiting_feature_set, "viewer", "waiting", "Feature set · waiting for approver", 7),
        (_waiting_prd_review, "approver", "waiting", "PRD review · waiting for you", 8),
        (_drafting, "approver", "drafting", "Drafting · PRD draft", 7),
        (_approved_and_in_review, "approver", "in_review", "Approved v1 · draft 2 in review", 8),
        (_approved_and_draft, "approver", "draft", "Approved v1 · draft 2", 8),
        (_in_build, "approver", "in_build", "Approved v1 · in build", 9),
        (_approved, "approver", "approved", "Approved v1", 9),
        (
            _in_review_with_roadmap_draft, "approver", "in_review",
            "Draft 2 in review · roadmap draft 2", 8,
        ),
        (_in_review, "approver", "in_review", "Draft 2 in review", 8),
        (_draft, "approver", "draft", "Draft 1", 8),
        (_brief, "approver", "idea", "Brief", 1),
    ],
)  # fmt: skip
async def test_prd_stage(client, situation, who, stage, label, step):
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        await situation(Seed(s))
        await s.commit()
    body = await plan(client, ctx, who)
    (prd,) = body["prds"]
    assert (prd["stage"], prd["stage_label"], prd["journey_step"]) == (stage, label, step)
    assert prd["waiting_for_viewer"] is label.endswith("waiting for you")


def test_engineering_stop_lines():
    lead, me = uuid.uuid4(), uuid.uuid4()
    line = service.checkpoint_line
    # A lead is named: the check waits for them, whoever looks.
    assert line("eng_review", "eng_check", "approver", "approver", me, lead) == (
        "Engineering check · waiting for the engineering lead",
        7,
        False,
    )
    assert line("eng_review", "eng_dates", "approver", "owner", lead, lead) == (
        "Engineering dates · waiting for you",
        7,
        True,
    )
    # F4 lane B: the dates stop's own kind names itself and waits for the lead too.
    assert line("eng_dates", "eng_dates", "approver", "approver", me, lead) == (
        "Engineering dates · waiting for the engineering lead",
        7,
        False,
    )
    # No lead yet (A3): the approvers decide.
    assert line("eng_review", "eng_check", "approver", "viewer", me, None) == (
        "Engineering check · waiting for approver",
        7,
        False,
    )
    assert line("roadmap_review", "roadmap_draft", "approver", "owner", me, None) == (
        "Roadmap review · waiting for you",
        8,
        True,
    )


async def test_cards_put_the_viewers_decisions_first(client):
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        await seed.approved_roadmap("prd-risky", ["it"], freshness="potentially_stale")
        await _waiting_feature_set(seed)
        late = await seed.doc("prd-late")
        await seed.version(late, 1)
        await s.commit()
    order = [p["document"]["slug"] for p in (await plan(client, ctx))["prds"]]
    assert order[:2] == ["prd-x", "prd-risky"], order
    assert card(await plan(client, ctx), "prd-risky")["figure"] == "At risk"


# --- next decision (§7) ----------------------------------------------------------------------


def dated(ref: str) -> dict:
    """An item milestone dated DAY on the basis ``ref``."""
    return {"name": "Beta", "date": DAY.isoformat(), "date_source": ref, "basis_ids": []}


async def _n_draft(seed: Seed, owner_id):
    await _proposed(seed)


async def _n_refused(seed: Seed, owner_id):
    await seed.approved_roadmap("prd-x", ["it"], milestone={
        "name": "Beta", "date": None, "date_source": "ENG-1", "basis_ids": [],
        "refused_date": DAY.isoformat(), "refused": "no basis"})  # fmt: skip


async def _n_withdrawn(seed: Seed, owner_id):
    p1, *_ = await seed.approved_roadmap("prd-x", ["it"], milestone=dated("ENG-9"))
    await seed.basis(p1, "ENG-9", DAY, status="withdrawn")


async def _n_slip(seed: Seed, owner_id):
    p1, _, _, track, _ = await seed.approved_roadmap("prd-x", ["it"], milestone=dated("ENG-5"))
    await seed.basis(p1, "ENG-5", DAY)
    await seed.record(track, "it", "ENG-5", target_date=DAY + timedelta(days=9))
    track.owner_id = owner_id


async def _n_blocker(seed: Seed, owner_id, severity="major", type_="soft"):
    blocker = await seed.entity("constraint", "limit", blocker={
        "type": type_, "severity": severity, "status": "open"})  # fmt: skip
    await seed.approved_roadmap("prd-x", ["it"], horizon="later", blocker_ids=[blocker.id])


async def _n_critical(seed: Seed, owner_id):
    await _n_blocker(seed, owner_id, "critical", "hard")


async def _n_stale(seed: Seed, owner_id):
    await seed.approved_roadmap("prd-x", ["it"], horizon="later", freshness="potentially_stale")


async def _n_untracked(seed: Seed, owner_id):
    await seed.approved_roadmap("prd-x", ["it"], horizon="next")


async def _n_nothing(seed: Seed, owner_id):
    await seed.approved_roadmap("prd-x", ["it"], horizon="later")


@pytest.mark.parametrize(
    ("situation", "named_owner", "action", "label", "role", "status"),
    [
        (_n_draft, False, "review_prd", "PRD review", "approver", None),
        (_n_refused, False, "verify_date", "Verify date", "approver", "unverified"),
        (_n_withdrawn, False, "reverify_date", "Re-verify date", "approver", "withdrawn"),
        (_n_slip, True, "decide_slip", "Decide on slip", "track_owner", "verified"),
        (_n_slip, False, "decide_slip", "Decide on slip", "owner", "verified"),
        (_n_blocker, False, "resolve_blocker", "Resolve blocker", "approver", None),
        (_n_critical, False, "resolve_blocker", "Resolve blocker", "owner", None),
        (_n_stale, False, "reconcile", "Reconcile", "approver", None),
        (_n_untracked, False, "link_issue", "Link issue", "approver", None),
        (_n_nothing, False, None, "—", None, None),
    ],
)
async def test_next_decision(client, situation, named_owner, action, label, role, status):
    ctx = await make_ctx()
    owner_id = ctx.users["owner"].id if named_owner else None
    async with tenant_session(ctx.tenant_id) as s:
        await situation(Seed(s), owner_id)
        await s.commit()
    (item,) = (await plan(client, ctx))["items"]
    nxt = item["next"]
    assert (nxt["action"], nxt["label"]) == (action, label)
    if role is None:
        assert nxt["who"] is None
    else:
        assert nxt["who"] == {"role": role, "user_id": str(owner_id) if owner_id else None}
    assert item["engineering"]["date_status"] == status
    if action == "decide_slip":
        assert item["engineering"]["slip_days"] == 9 and item["state"] == "at_risk"
        assert [r["external_ref"] for r in item["engineering"]["records"]] == ["ENG-5"]
    if action == "review_prd":
        assert nxt["href"] == "/documents/prd-x/v/1" and nxt["viewer_may"] is True
    if action == "resolve_blocker":
        assert nxt["href"].startswith("/baseline?entity=")


async def test_basis_ids_are_the_bases_the_date_source_names(client):
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        p1, _, _, track, _ = await seed.approved_roadmap(
            "prd-x", ["it", "other"], milestone=dated("ENG-412")
        )
        named = await seed.basis(p1, "ENG-412", DAY)
        # Verified later, on the same date and for the whole PRD, but not named by the date.
        await seed.basis(p1, "CAP-9", DAY)
        await s.commit()
    items = {i["key"]: i for i in (await plan(client, ctx))["items"]}
    assert items["it"]["engineering"]["date_status"] == "verified"
    assert items["it"]["engineering"]["basis_ids"] == [str(named.id)]

    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        row = await s.get(ScheduleBasis, named.id)
        row.status, row.withdrawn_at = "withdrawn", datetime.now(UTC)
        cap = await s.scalar(select(ScheduleBasis).where(ScheduleBasis.reference == "CAP-9"))
        await s.delete(cap)
        # Withdrawn later on the same date: one the source does not name, one named but
        # scoped to the other item.
        await seed.basis(p1, "ENG-450", DAY, status="withdrawn")
        other = await seed.basis(p1, "ENG-412", DAY, status="withdrawn")
        other.item_key = "other"
        await s.commit()
    items = {i["key"]: i for i in (await plan(client, ctx))["items"]}
    assert items["it"]["engineering"]["date_status"] == "withdrawn"
    assert items["it"]["engineering"]["basis_ids"] == [str(named.id)]
    assert items["other"]["engineering"]["basis_ids"] == sorted([str(named.id), str(other.id)])


# --- company scoping, access, cost -----------------------------------------------------------


async def test_another_companys_rows_never_appear(client):
    mine, theirs = await make_ctx("Example Co"), await make_ctx("Other Co")
    for ctx, slug in ((mine, "prd-mine"), (theirs, "prd-theirs")):
        async with tenant_session(ctx.tenant_id) as s:
            await Seed(s).approved_roadmap(slug, ["k1", "k2"])
            await s.commit()
    body = await plan(client, mine)
    other = await plan(client, theirs)
    assert [p["document"]["slug"] for p in body["prds"]] == ["prd-mine"]
    ids = {i["id"] for i in body["items"]} | {p["document"]["id"] for p in body["prds"]}
    their_ids = {i["id"] for i in other["items"]} | {p["document"]["id"] for p in other["prds"]}
    assert len(ids) == 3 and len(their_ids) == 3 and not ids & their_ids
    assert {i["track_id"] for i in body["items"]}.isdisjoint(
        {i["track_id"] for i in other["items"]}
    )


async def test_run_tokens_are_refused_and_viewers_read(client):
    ctx = await make_ctx()
    await seed_two_prds(ctx)
    assert (await client.get("/v1/plan", headers=ctx.as_("viewer"))).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        run = Run(flow="baseline_to_prd", created_by=ctx.users["approver"].id, status="running")
        s.add(run)
        await s.flush()
        raw = await mint_run_token(
            s, run.id, ["read:documents", "read:baseline", "read:sources", "write:drafts"], 600
        )
        await s.commit()
    run_headers = {**ctx.as_("approver"), RUN_TOKEN_HEADER: raw}
    for path in ("/v1/plan", "/v1/plan/items/history?roadmap=prd-b-roadmap&item=b1"):
        assert (await client.get(path, headers=run_headers)).status_code == 403, path
        assert scopes.required_scope("GET", path.split("?")[0]) is None
    # People's MCP clients get the tools, named after the operations (I2 MCP parity).
    from oracle.main import app

    ops = {op["operationId"] for p in app.openapi()["paths"].values() for op in p.values()}
    assert {"get_plan", "get_plan_item_history"} <= ops


async def test_query_budget(client):
    ctx = await make_ctx()
    tracks = 30
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        goal = await seed.entity("goal", "g1")
        for t in range(tracks):
            feature = await seed.entity("feature", f"f{t}")
            await seed.supports(feature, goal)
            p1, roadmap, r1, track, items = await seed.approved_roadmap(
                f"prd-{t}", [f"i{t}-{n}" for n in range(10)], feature_id=feature.id,
                milestone={"name": "Beta", "date": DAY.isoformat(), "date_source": f"ENG-{t}",
                           "basis_ids": []},
            )  # fmt: skip
            await seed.basis(p1, f"ENG-{t}", DAY)
            await seed.record(track, items[0].item_key, f"ENG-{t}")
            await seed.add(TrackMilestone(track_id=track.id, name="GA", item_keys=["x"]))
        await s.commit()
    statements: list[str] = []

    def count(conn, cursor, statement, *args):
        statements.append(statement)

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", count)
    try:
        body = await plan(client, ctx)
    finally:
        event.remove(engine, "before_cursor_execute", count)
    assert len(body["items"]) == 300 and len(body["prds"]) == 30
    assert len(statements) <= 20 + 6 * tracks, len(statements)


async def test_item_history_in_version_order(client):
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        prd = await seed.doc("prd-x", status="approved")
        p1 = await seed.version(prd, 1, approved=True)
        p2 = await seed.version(prd, 2, approved=True)
        roadmap = await seed.doc("prd-x-roadmap", kind="roadmap")
        r1 = await seed.version(roadmap, 1, source=p1)
        r2 = await seed.version(roadmap, 2, source=p2)
        r3 = await seed.version(roadmap, 3, source=p2)
        r4 = await seed.version(roadmap, 4, approved=True, source=p2)
        await seed.item(r4, "it", p2, horizon="now")
        await seed.item(r2, "it", p2, horizon="now")
        await seed.item(r1, "it", p1, horizon="next")
        await seed.item(r3, "other", p2)
        await s.commit()
    resp = await client.get(
        "/v1/plan/items/history",
        params={"roadmap": "prd-x-roadmap", "item": "it"},
        headers=ctx.as_("viewer"),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["tracker_events"] == []
    assert [(v["version"], v["prd_version"], v["horizon"]) for v in body["versions"]] == [
        (1, 1, "next"), (2, 2, "now"), (4, 2, "now"),
    ]  # fmt: skip
    assert [v["approved_at"] is not None for v in body["versions"]] == [False, False, True]
    missing = await client.get(
        "/v1/plan/items/history",
        params={"roadmap": "nope", "item": "it"},
        headers=ctx.as_("viewer"),
    )
    assert missing.status_code == 404
