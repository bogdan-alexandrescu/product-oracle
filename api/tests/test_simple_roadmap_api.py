"""Simple S2 (#723): the company-wide roadmap read (``GET /v1/simple/roadmap``) and Oracle's
date suggestions (``/v1/simple/roadmap/date-suggestions``). Against Postgres.

Each test seeds its roadmaps, items, tracks, tracker records and schedule bases through the
models and reads or acts as a person of the company would. The company's clock is fixed
(``company_time.now``): Monday Nov 2, 2026 in the Company time zone unless a test moves it.

Test cards (protects / fails_when / no_claim):

- test_dates_come_from_each_source: protects=typed, engineering (a verified basis of the
  item), tracker and estimated dates through the route, each naming its source;
  fails_when=a stored source is skipped or misnamed; no_claim=how F4 records a basis.
- test_estimated_windows_follow_the_company_day: protects=at 03:00 UTC on Jan 1 the
  company's day is Dec 31 (Pacific): a Now item's estimate is Q4 2026; fails_when=the
  server's day anchors it; no_claim=other time zones.
- test_visibility_per_role: protects=an approvers-only roadmap's items and suggestions
  are absent for commenters and viewers and present for approvers and owners;
  fails_when=either way; no_claim=the web.
- test_grouping_and_filters: protects=group=goal|track|prd groups every shown item once
  (No goal / No track / No PRD last; an item without a track takes the track that
  follows its PRD on its roadmap), filters prd, goal, track and from/to narrow the
  items; fails_when=an item is in two groups or a filter is ignored; no_claim=S4's views.
- test_500_items_answer_under_300_ms: protects=a company with 500 items (deps, records,
  bases, goals) reads in under 300 ms (the best of 3, after a warm-up);
  fails_when=the read goes per item; no_claim=production hardware.
- test_flags_through_the_route: protects=a dependency ending after its dependent starts
  and an open blocker expected after the start reach the item with reasons and fixes;
  an accepted risk is amber; fails_when=flags are missing or a risk hides one;
  no_claim=applying the fixes (S3).
- test_suggestions_regenerate_once_a_day_and_on_demand: protects=the tick makes one
  open suggestion per undated item once a company day, refresh on demand, a dated item
  gets none; fails_when=the tick regenerates every minute or dates a dated item;
  no_claim=the scheduled ticker's lock (its own tests).
- test_suggestion_permissions_per_role (parametrized): protects=owners decide; the
  roadmap's decider decides; with no decider the roadmap's track owner decides; other
  approvers, commenters and viewers get 403; fails_when=a role decides that may not, or
  the decider is refused; no_claim=the web's can_* use.
- test_accept_edit_dismiss: protects=accept writes the suggestion's dates with
  date_source accepted, edit writes the new dates (accepted, suggestion edited),
  dismiss leaves the item undated and the next refresh offers it nothing (30 days); a
  decided suggestion cannot be decided again (409); fails_when=either way;
  no_claim=S3's working drafts.
- test_migration_columns: protects=roadmap_items' new columns' defaults and the
  date_source check; fails_when=a default or the check is missing; no_claim=downgrade
  (tests/test_migrations.py walks every revision).
"""

import hashlib
import time
from datetime import UTC, date, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from oracle import company_time
from oracle.baseline.models import Edge, Entity
from oracle.docs.models import Document, DocumentVersion
from oracle.review.models import DocumentReviewPolicy
from oracle.roadmap.models import (
    ProductTrack,
    RoadmapItem,
    ScheduleBasis,
    TrackerRecord,
    TrackMilestone,
)
from oracle.simple import suggestions
from oracle.simple.models import RoadmapDateSuggestion
from oracle.tenancy import tenant_session
from oracle.v2.models import FeasibilityExperiment
from tests.baseline_helpers import Ctx, make_ctx

NOW = datetime(2026, 11, 2, 20, 0, tzinfo=UTC)  # Mon Nov 2, 12:00 PT
URL = "/v1/simple/roadmap"
SUGGESTIONS = "/v1/simple/roadmap/date-suggestions"


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    moment = {"now": NOW}
    monkeypatch.setattr(company_time, "now", lambda: moment["now"])
    return moment


class Seed:
    """Adds rows to one company's session; the caller commits."""

    def __init__(self, s) -> None:
        self.s = s

    async def add(self, row):
        self.s.add(row)
        await self.s.flush()
        return row

    async def doc(self, slug: str, kind: str = "prd", visibility: str = "company") -> Document:
        return await self.add(
            Document(
                slug=slug,
                title=slug.replace("-", " ").title(),
                kind=kind,
                status="approved",
                visibility=visibility,
            )
        )

    async def version(self, doc: Document, n: int = 1, approved: bool = True) -> DocumentVersion:
        body = f"# {doc.slug} v{n}\n"
        return await self.add(
            DocumentVersion(
                document_id=doc.id,
                number=n,
                markdown=body,
                content_hash=hashlib.sha256(body.encode()).hexdigest(),
                approved_at=datetime(2026, 10, 1, tzinfo=UTC) if approved else None,
            )
        )

    async def roadmap(self, slug: str, visibility: str = "company") -> tuple:
        prd = await self.doc(f"{slug}-prd")
        pv = await self.version(prd)
        rm = await self.doc(slug, "roadmap", visibility)
        rv = await self.version(rm)
        return prd, pv, rm, rv

    async def item(
        self, rv: DocumentVersion, pv: DocumentVersion | None, key: str, **kw: Any
    ) -> RoadmapItem:
        kw.setdefault("horizon", "now")
        kw.setdefault("position", 0)
        kw.setdefault("title", key.replace("-", " ").title())
        return await self.add(
            RoadmapItem(
                roadmap_document_id=rv.document_id,
                roadmap_version_id=rv.id,
                item_key=key,
                prd_document_id=pv.document_id if pv is not None else None,
                prd_version_id=pv.id if pv is not None else None,
                **kw,
            )
        )

    async def entity(self, type_: str, key: str, **attrs) -> Entity:
        return await self.add(
            Entity(
                type=type_,
                key=key,
                title=key.replace("-", " ").title(),
                status="confirmed",
                origin="user",
                attrs=attrs,
            )
        )

    async def supports(self, feature: Entity, goal: Entity) -> None:
        await self.add(
            Edge(
                src_id=feature.id,
                dst_id=goal.id,
                type="supports",
                status="confirmed",
                origin="user",
            )
        )

    async def track(
        self, pv: DocumentVersion, rm: Document, title: str = "Track", **kw: Any
    ) -> ProductTrack:
        return await self.add(
            ProductTrack(
                prd_document_id=pv.document_id,
                started_version_id=pv.id,
                current_version_id=pv.id,
                roadmap_document_id=rm.id,
                title=title,
                **kw,
            )
        )


async def get(client, ctx: Ctx, role: str = "owner", **params) -> dict:
    r = await client.get(URL, params=params, headers=ctx.as_(role))
    assert r.status_code == 200, r.text
    return r.json()


def by_key(body: dict) -> dict[str, dict]:
    return {i["key"]: i for i in body["items"]}


async def test_dates_come_from_each_source(client):
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        prd, pv, rm, rv = await seed.roadmap("payments")
        track = await seed.track(pv, rm)
        await seed.item(
            rv,
            pv,
            "typed",
            start_date=date(2026, 10, 5),
            end_date=date(2026, 11, 20),
            date_source="typed",
        )
        await seed.item(rv, pv, "eng", track_id=track.id)
        await seed.item(rv, pv, "tracked", track_id=track.id)
        await seed.item(rv, pv, "undated", horizon="next")
        s.add(
            ScheduleBasis(
                kind="estimate",
                reference="ENG-1",
                supports_date=date(2026, 12, 4),
                prd_document_id=prd.id,
                item_key="eng",
                status="verified",
                verified_at=NOW,
            )
        )
        s.add(
            TrackerRecord(
                tracker="linear",
                external_ref="ENG-2",
                track_id=track.id,
                item_key="eng",
                state="todo",
                target_date=date(2026, 12, 20),
                observed_at=NOW,
            )
        )
        s.add(
            TrackerRecord(
                tracker="linear",
                external_ref="ENG-3",
                track_id=track.id,
                item_key="tracked",
                state="in_progress",
                target_date=date(2026, 12, 11),
                observed_at=NOW,
            )
        )
        await s.commit()
    items = by_key(await get(client, ctx))
    assert items["typed"]["start"] == {"date": "2026-10-05", "source": "typed", "estimated": False}
    assert items["typed"]["end"]["date"] == "2026-11-20"
    assert items["eng"]["end"] == {
        "date": "2026-12-04",
        "source": "engineering",
        "estimated": False,
    }
    assert items["eng"]["start"] == {"date": "2026-10-01", "source": "estimated", "estimated": True}
    assert (items["eng"]["source"], items["eng"]["estimated"]) == ("engineering", False)
    assert items["tracked"]["end"]["source"] == "tracker"
    assert items["tracked"]["status"] == "in_progress"
    undated = items["undated"]
    assert (undated["source"], undated["estimated"]) == ("estimated", True)
    assert (undated["start"]["date"], undated["end"]["date"]) == ("2027-01-01", "2027-06-30")
    assert [p["key"] for p in undated["phases"]] == ["discover", "build", "beta", "launch"]


async def test_estimated_windows_follow_the_company_day(client, clock):
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, _, rv = await seed.roadmap("payments")
        await seed.item(rv, pv, "now-item")
        await s.commit()
    clock["now"] = datetime(2027, 1, 1, 3, 0, tzinfo=UTC)
    body = await get(client, ctx)
    assert body["today"] == "2026-12-31"
    item = by_key(body)["now-item"]
    assert (item["start"]["date"], item["end"]["date"]) == ("2026-10-01", "2026-12-31")
    assert body["windows"]["now"] == {"start": "2026-10-01", "end": "2026-12-31"}


async def test_visibility_per_role(client):
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, _, rv = await seed.roadmap("open-plan")
        _, hpv, _, hrv = await seed.roadmap("board-plan", visibility="approvers")
        await seed.item(rv, pv, "shared")
        await seed.item(hrv, hpv, "secret")
        await s.commit()
        await suggestions.regenerate(s)
        await s.commit()
    for role, keys in (
        ("owner", {"shared", "secret"}),
        ("approver", {"shared", "secret"}),
        ("commenter", {"shared"}),
        ("viewer", {"shared"}),
    ):
        body = await get(client, ctx, role)
        assert set(by_key(body)) == keys, role
        if "secret" not in keys:
            assert "Board Plan" not in str(body) and "board-plan" not in str(body)
        r = await client.get(SUGGESTIONS, headers=ctx.as_(role))
        assert r.status_code == 200
        assert len(r.json()) == len(keys), role


async def test_grouping_and_filters(client):
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, rm, rv = await seed.roadmap("payments")
        _, pv2, rm2, rv2 = await seed.roadmap("onboarding")
        track = await seed.track(pv, rm, "Payments track")
        goal = await seed.entity("goal", "grow-revenue")
        feature = await seed.entity("feature", "saved-cards")
        await seed.supports(feature, goal)
        await seed.item(rv, pv, "cards", feature_id=feature.id, track_id=track.id)
        await seed.item(rv, pv, "refunds", horizon="later")
        await seed.item(rv2, pv2, "tour", horizon="next")
        await s.commit()
        goal_id, track_id = str(goal.id), str(track.id)

    body = await get(client, ctx, group="goal")
    groups = [(g["key"], g["title"], len(g["item_ids"])) for g in body["groups"]]
    assert groups == [(goal_id, "Grow Revenue", 1), ("none", "No goal", 2)]
    assert by_key(body)["cards"]["goal"]["key"] == "grow-revenue"

    body = await get(client, ctx, group="track")
    assert [(g["title"], len(g["item_ids"])) for g in body["groups"]] == [
        ("Payments track", 2),
        ("No track", 1),
    ]

    body = await get(client, ctx, group="prd")
    assert [(g["title"], len(g["item_ids"])) for g in body["groups"]] == [
        ("Onboarding Prd", 1),
        ("Payments Prd", 2),
    ]

    assert set(by_key(await get(client, ctx, prd="payments-prd"))) == {"cards", "refunds"}
    assert set(by_key(await get(client, ctx, goal="grow-revenue"))) == {"cards"}
    assert set(by_key(await get(client, ctx, track=track_id))) == {"cards", "refunds"}
    # Now is Q4 2026, Next Q1-Q2 2027, Later from Nov 2027.
    assert set(by_key(await get(client, ctx, **{"from": "2027-01-01", "to": "2027-03-31"}))) == {
        "tour"
    }
    assert set(by_key(await get(client, ctx, to="2026-12-31"))) == {"cards"}
    r = await client.get(URL, params={"group": "team"}, headers=ctx.as_("owner"))
    assert r.status_code == 422


async def seed_many(ctx: Ctx, n: int = 500) -> None:
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        goals = [await seed.entity("goal", f"goal-{g}") for g in range(5)]
        per = 50
        for r in range(n // per):
            prd, pv, rm, rv = await seed.roadmap(f"roadmap-{r}")
            track = await seed.track(pv, rm, f"Track {r}", owner_id=ctx.users["approver"].id)
            feature = await seed.entity("feature", f"feature-{r}")
            await seed.supports(feature, goals[r % 5])
            for i in range(per):
                key = f"item-{i}"
                kw: dict[str, Any] = {
                    "horizon": ("now", "next", "later")[i % 3],
                    "position": i,
                    "feature_id": feature.id,
                    "track_id": track.id,
                    "confidence": ("low", "medium", "high")[i % 3],
                }
                if i:
                    kw["depends_on"] = [f"item-{i - 1}"]
                if i % 4 == 0:
                    kw.update(
                        start_date=date(2026, 10, 1) + timedelta(days=i),
                        end_date=date(2026, 11, 1) + timedelta(days=i),
                        date_source="typed",
                    )
                s.add(
                    RoadmapItem(
                        roadmap_document_id=rm.id,
                        roadmap_version_id=rv.id,
                        item_key=key,
                        title=f"Item {r}-{i}",
                        prd_document_id=prd.id,
                        prd_version_id=pv.id,
                        **kw,
                    )
                )
                if i % 4 == 1:
                    s.add(
                        TrackerRecord(
                            tracker="linear",
                            external_ref=f"T-{r}-{i}",
                            track_id=track.id,
                            item_key=key,
                            state="todo",
                            target_date=date(2026, 12, 1),
                            observed_at=NOW,
                        )
                    )
                if i % 4 == 2:
                    s.add(
                        ScheduleBasis(
                            kind="estimate",
                            reference=f"E-{r}-{i}",
                            supports_date=date(2026, 12, 10),
                            prd_document_id=prd.id,
                            item_key=key,
                            status="verified",
                            verified_at=NOW,
                        )
                    )
            s.add(
                TrackMilestone(
                    track_id=track.id, name="Beta", horizon="now", item_keys=["item-0", "item-1"]
                )
            )
        await s.commit()
        await suggestions.regenerate(s)
        await s.commit()


async def test_500_items_answer_under_300_ms(client):
    ctx = await make_ctx()
    await seed_many(ctx)
    headers = ctx.as_("owner")
    r = await client.get(URL, headers=headers)
    assert r.status_code == 200 and len(r.json()["items"]) == 500
    assert sum(1 for i in r.json()["items"] if i["suggestion"]) > 100
    times = []
    for _ in range(3):
        t0 = time.perf_counter()
        r = await client.get(URL, headers=headers)
        times.append(time.perf_counter() - t0)
        assert r.status_code == 200
    assert min(times) < 0.3, times


async def test_flags_through_the_route(client):
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, _, rv = await seed.roadmap("payments")
        blocker = await seed.entity(
            "constraint", "rate-limit", blocker={"type": "hard", "status": "open"}
        )
        s.add(
            FeasibilityExperiment(
                blocker_id=blocker.id,
                hypothesis="A queue absorbs it",
                decision_gate_at=datetime(2026, 11, 25, tzinfo=UTC),
            )
        )
        await seed.item(
            rv,
            pv,
            "ledger",
            start_date=date(2026, 10, 1),
            end_date=date(2026, 11, 15),
            date_source="typed",
        )
        await seed.item(
            rv,
            pv,
            "import",
            start_date=date(2026, 11, 10),
            end_date=date(2026, 12, 15),
            date_source="typed",
            depends_on=["ledger"],
            blocker_ids=[blocker.id],
            accepted_risks=[{"flag": "blocker_date", "note": "Queue first"}],
        )
        await s.commit()
    body = await get(client, ctx)
    items = by_key(body)
    flags = {f["kind"]: f for f in items["import"]["flags"]}
    assert flags["dependency_order"]["state"] == "red"
    assert flags["dependency_order"]["fixes"] == [
        "shift_dependents",
        "move_dependency",
        "accept_risk",
    ]
    assert "Ledger" in flags["dependency_order"]["reason"]
    assert flags["blocker_date"]["state"] == "amber"
    assert flags["blocker_date"]["risk_note"] == "Queue first"
    assert items["import"]["depends_on"] == [items["ledger"]["id"]]
    assert items["ledger"]["needed_by"] == [items["import"]["id"]]


async def open_suggestions(ctx: Ctx) -> list[RoadmapDateSuggestion]:
    async with tenant_session(ctx.tenant_id) as s:
        return list(
            await s.scalars(
                select(RoadmapDateSuggestion).where(RoadmapDateSuggestion.status == "open")
            )
        )


async def test_suggestions_regenerate_once_a_day_and_on_demand(client, clock):
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, _, rv = await seed.roadmap("payments")
        await seed.item(
            rv,
            pv,
            "dated",
            start_date=date(2026, 10, 1),
            end_date=date(2026, 10, 30),
            date_source="typed",
        )
        await seed.item(rv, pv, "undated")
        await s.commit()
        assert await suggestions.daily(s) is True
        await s.commit()
    (first,) = await open_suggestions(ctx)
    # 30 days, the median of the one dated item (no confidence either).
    assert (first.start_date, first.end_date) == (date(2026, 10, 1), date(2026, 10, 30))
    async with tenant_session(ctx.tenant_id) as s:
        assert await suggestions.daily(s) is False
    clock["now"] = NOW + timedelta(days=1)
    async with tenant_session(ctx.tenant_id) as s:
        assert await suggestions.daily(s) is True
        await s.commit()
    assert len(await open_suggestions(ctx)) == 1
    async with tenant_session(ctx.tenant_id) as s:
        await s.execute(text("DELETE FROM roadmap_date_suggestions"))
        await s.commit()
    assert (
        await client.post(f"{SUGGESTIONS}/refresh", headers=ctx.as_("viewer"))
    ).status_code == 403
    r = await client.post(f"{SUGGESTIONS}/refresh", headers=ctx.as_("approver"))
    assert r.status_code == 200, r.text
    assert r.json()["open"] == 1
    body = await get(client, ctx)
    suggestion = by_key(body)["undated"]["suggestion"]
    assert suggestion["start_date"] == "2026-10-01" and suggestion["basis"]
    assert by_key(body)["dated"]["suggestion"] is None


async def seed_decidable(ctx: Ctx, *, decider: str | None, track_owner: str | None) -> str:
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, rm, rv = await seed.roadmap("payments")
        owner_id = ctx.users[track_owner].id if track_owner else None
        track = await seed.track(pv, rm, owner_id=owner_id)
        await seed.item(rv, pv, "undated", track_id=track.id)
        if decider:
            s.add(DocumentReviewPolicy(document_id=rm.id, decider_id=ctx.users[decider].id))
        await s.commit()
        await suggestions.regenerate(s)
        await s.commit()
    (row,) = await open_suggestions(ctx)
    return str(row.id)


@pytest.mark.parametrize(
    "role,decider,track_owner,allowed",
    [
        ("owner", None, None, True),
        ("owner", "approver", None, True),
        ("approver", "approver", None, True),
        ("approver", None, None, False),
        ("approver", None, "approver", True),
        ("approver", "commenter", "approver", False),
        ("commenter", None, None, False),
        ("viewer", None, None, False),
    ],
)
async def test_suggestion_permissions_per_role(client, role, decider, track_owner, allowed):
    ctx = await make_ctx()
    sid = await seed_decidable(ctx, decider=decider, track_owner=track_owner)
    listed = (await client.get(SUGGESTIONS, headers=ctx.as_(role))).json()
    assert listed[0]["can_decide"] is allowed
    r = await client.post(f"{SUGGESTIONS}/{sid}/dismiss", headers=ctx.as_(role))
    assert r.status_code == (200 if allowed else 403), r.text


async def test_accept_edit_dismiss(client):
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, _, rv = await seed.roadmap("payments")
        for key in ("a", "b", "c"):
            await seed.item(rv, pv, key)
        await s.commit()
        await suggestions.regenerate(s)
        await s.commit()
    owner = ctx.as_("owner")
    rows = {r["item_key"]: r for r in (await client.get(SUGGESTIONS, headers=owner)).json()}
    assert set(rows) == {"a", "b", "c"}

    r = await client.post(f"{SUGGESTIONS}/{rows['a']['id']}/accept", headers=owner)
    assert r.status_code == 200 and r.json()["status"] == "accepted"
    r = await client.post(
        f"{SUGGESTIONS}/{rows['b']['id']}/edit",
        headers=owner,
        json={"start_date": "2026-11-02", "end_date": "2026-11-30"},
    )
    assert r.status_code == 200 and r.json()["status"] == "edited"
    r = await client.post(
        f"{SUGGESTIONS}/{rows['b']['id']}/edit",
        headers=owner,
        json={"start_date": "2026-11-30", "end_date": "2026-11-02"},
    )
    assert r.status_code in (409, 422)
    r = await client.post(f"{SUGGESTIONS}/{rows['c']['id']}/dismiss", headers=owner)
    assert r.status_code == 200 and r.json()["status"] == "dismissed"
    r = await client.post(f"{SUGGESTIONS}/{rows['a']['id']}/dismiss", headers=owner)
    assert r.status_code == 409

    items = by_key(await get(client, ctx))
    assert items["a"]["start"] == {
        "date": rows["a"]["start_date"],
        "source": "accepted",
        "estimated": False,
    }
    assert (items["b"]["start"]["date"], items["b"]["end"]["date"]) == ("2026-11-02", "2026-11-30")
    assert items["b"]["end"]["source"] == "accepted"
    assert items["c"]["estimated"] is True and items["c"]["suggestion"] is None
    r = await client.post(f"{SUGGESTIONS}/refresh", headers=owner)
    assert r.json()["open"] == 0


async def test_migration_columns():
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, _, rv = await seed.roadmap("payments")
        row = await seed.item(rv, pv, "plain")
        await s.commit()
        await s.refresh(row)
        assert (row.accepted_risks, row.draft, row.date_source) == ([], False, None)
        row.date_source = "guessed"
        with pytest.raises(IntegrityError):
            await s.commit()
