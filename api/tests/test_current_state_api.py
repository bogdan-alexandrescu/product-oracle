"""Current state beside Desired state: each confirmed feature's mark (new, in progress,
exists, exists with old proof), its proof (code map, pull requests, tasks, measured), the
ready band and the owner's Move / Not yet, Check again, the "still runs?" answer, the
"already shipped" mark and the nightly re-read. Against Postgres.

The company's clock is fixed at Nov 4, 2026, noon UTC (``company_time.now``).
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from oracle import company_time
from oracle.baseline.models import Entity
from oracle.currentstate import service
from oracle.currentstate.models import FeatureProof, FeatureState
from oracle.engineering.models import CodeMap
from oracle.metrics.models import Metric, MetricValue
from oracle.simple.models import RoadmapItemTask
from oracle.sources import store
from oracle.sources.base import ItemUpsert
from oracle.sources.models import Source
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx
from tests.test_code_maps import MAP, shared_map
from tests.test_simple_roadmap_api import Seed

URL = "/v1/feature-states"
NOW = datetime(2026, 11, 4, 12, 0, tzinfo=UTC)


@pytest.fixture
def clock(monkeypatch):
    moment = {"now": NOW}
    monkeypatch.setattr(company_time, "now", lambda: moment["now"])
    return moment


def full_proofs(checked_at: datetime) -> list[dict]:
    return [
        dict(kind="code_map", count=3, ok=True, checked_at=checked_at),
        dict(kind="pull_requests", count=5, ok=True, checked_at=checked_at),
        dict(kind="tasks", count=4, total=4, ok=True, checked_at=checked_at),
        dict(kind="measured", value="3,410 sent last month", period="Oct", ok=True,
             checked_at=checked_at),
    ]  # fmt: skip


class World:
    """Features: ``fresh`` (nothing), ``building`` (a code map hit), ``shipped`` (marked as
    already shipped, no proof yet), ``running`` (moved, proof 2 days old), ``old`` (moved,
    proof 41 days old), ``gone`` (moved, then "no longer runs"), ``done`` (all four proofs:
    ready), ``tracked`` (an item with tasks: 2 done, 1 to do, 1 dropped) and ``idea`` (a
    proposed feature, never listed)."""

    def __init__(self, ctx: Ctx) -> None:
        self.ctx = ctx
        self.ids: dict[str, str] = {}

    async def build(self) -> "World":
        async with tenant_session(self.ctx.tenant_id) as s:
            seed = Seed(s)
            _, pv, rm, rv = await seed.roadmap("payments")
            goal = await seed.entity("goal", "growth", weight=1)
            keys = ("fresh", "building", "shipped", "running", "old", "gone", "done", "tracked")
            f = {k: await seed.entity("feature", k) for k in keys}
            idea = await seed.entity("feature", "idea")
            idea.status = "proposed"
            await seed.supports(f["done"], goal)

            def proof(feature: str, **kw) -> FeatureProof:
                return FeatureProof(feature_id=f[feature].id, **kw)

            s.add(proof("building", kind="code_map", count=2, ok=True, checked_at=NOW))
            s.add(FeatureState(feature_id=f["shipped"].id, status="shipped", shipped_at=NOW))
            two, old = NOW - timedelta(days=2), NOW - timedelta(days=41)
            for key, at in (("running", two), ("old", old)):
                s.add(
                    FeatureState(
                        feature_id=f[key].id,
                        status="current",
                        shipped_at=at,
                        moved_at=at,
                        move_note="owner_confirmed",
                        checked_at=at,
                    )
                )
                for p in full_proofs(at):
                    s.add(proof(key, **p))
            s.add(
                FeatureState(
                    feature_id=f["gone"].id,
                    status="desired",
                    shipped_at=two,
                    answer="no_longer_runs",
                    answered_at=two,
                    checked_at=two,
                )
            )
            s.add(proof("gone", kind="code_map", count=1, ok=True, checked_at=two))
            for p in full_proofs(two):
                s.add(proof("done", **p))
            item = await seed.item(rv, pv, "pay-1", milestone={"name": "Beta"},
                                   feature_id=f["tracked"].id)  # fmt: skip
            await seed.item(rv, pv, "pay-2", position=1, feature_id=f["done"].id,
                            milestone={"name": "Beta"})  # fmt: skip
            for i, st in enumerate(("done", "done", "todo", "dropped")):
                s.add(
                    RoadmapItemTask(
                        item_id=item.id,
                        roadmap_document_id=rm.id,
                        item_key="pay-1",
                        title=f"Task {i}",
                        status=st,
                        position=i,
                        created_by=self.ctx.users["owner"].id,
                    )
                )
            s.add(proof("tracked", kind="tasks", count=0, total=0, ok=False, checked_at=old))
            await s.commit()
            self.item_id = str(item.id)
            self.ids = {k: str(e.id) for k, e in f.items()} | {"idea": str(idea.id)}
        return self

    async def read(self, client, who: str = "owner") -> dict:
        r = await client.get(URL, headers=self.ctx.as_(who))
        assert r.status_code == 200, r.text
        return r.json()

    async def rows(self, client, who: str = "owner") -> dict[str, dict]:
        return {r["code"]: r for r in (await self.read(client, who))["features"]}

    async def post(self, client, feature: str, action: str, who: str = "owner", **body):
        return await client.post(f"{URL}/{self.ids[feature]}/{action}",
                                 json=body or None, headers=self.ctx.as_(who))  # fmt: skip


async def world() -> World:
    return await World(await make_ctx()).build()


async def test_marks_for_each_kind(client, clock):
    """protects=each confirmed feature reads one mark: new (nothing), in_progress (a proof
    count or tasks under way), exists (moved, fresh proof), exists_old (proof 41 days old),
    exists with no_proof_yet (marked as already shipped, nothing read yet); "no longer runs"
    puts a feature back in Desired; a proposed feature is never listed; the counts add up;
    fails_when=a mark, a count or a field is wrong; no_claim=the web's drawing."""
    w = await world()
    out = await w.read(client)
    rows = {r["code"]: r for r in out["features"]}
    assert set(rows) == {"fresh", "building", "shipped", "running", "old", "gone", "done",
                         "tracked"}  # fmt: skip
    marks = {k: r["mark"] for k, r in rows.items()}
    assert marks == {"fresh": "new", "building": "in_progress", "shipped": "exists",
                     "running": "exists", "old": "exists_old", "gone": "in_progress",
                     "done": "in_progress", "tracked": "in_progress"}  # fmt: skip
    assert rows["shipped"]["no_proof_yet"] is True and rows["shipped"]["proofs"] == []
    assert rows["shipped"]["move_how"] == "marked_shipped"
    assert rows["running"]["no_proof_yet"] is False and rows["running"]["proof_days"] == 2
    assert rows["running"]["move_how"] == "owner_confirmed"
    assert rows["old"]["proof_days"] == 41
    assert rows["fresh"]["proofs"] == [] and rows["fresh"]["proof_days"] is None
    assert rows["done"]["goal"] == "Growth" and rows["done"]["milestone"] == "Beta"
    assert rows["done"]["title"] == "Done" and rows["done"]["feature_id"] == w.ids["done"]
    kinds = [p["kind"] for p in rows["running"]["proofs"]]
    assert kinds == ["code_map", "pull_requests", "tasks", "measured"]
    assert (out["running"], out["old_proof"], out["in_progress"], out["new"]) == (3, 1, 4, 1)
    assert (out["desired"], out["ready"]) == (5, 1)
    assert (out["can_move"], out["can_answer"]) == (True, True)
    viewer = await w.read(client, "viewer")
    assert (viewer["can_move"], viewer["can_answer"]) == (False, False)


def test_mark_pure():
    """protects=the mark rule on its own; fails_when=it drifts; no_claim=the read."""
    st = FeatureState(status="current", checked_at=NOW - timedelta(days=31))
    assert service.mark(st, [], False, NOW) == "exists_old"
    st = FeatureState(status="shipped", checked_at=None)
    assert service.mark(st, [], False, NOW) == "exists"
    st = FeatureState(status="current", answer="no_longer_runs")
    assert service.mark(st, [], False, NOW) == "new"
    assert service.mark(None, [], True, NOW) == "in_progress"
    assert service.mark(None, [FeatureProof(kind="code_map", count=1)], False, NOW) == (
        "in_progress"
    )


async def test_ready_and_not_yet(client, clock):
    """protects=a feature with all four proofs reads ready; Not yet takes it off the ready
    band until its proof is read again later; fails_when=ready ignores a proof or not_yet;
    no_claim=the move itself."""
    w = await world()
    rows = await w.rows(client)
    assert rows["done"]["ready"] is True
    assert [k for k, r in rows.items() if r["ready"]] == ["done"]
    r = await w.post(client, "done", "move", decision="not_yet")
    assert r.status_code == 200, r.text
    assert r.json()["ready"] is False and r.json()["mark"] == "in_progress"
    assert (await w.rows(client))["done"]["ready"] is False
    clock["now"] = NOW + timedelta(days=1)
    r = await w.post(client, "done", "check")
    assert r.status_code == 200, r.text
    assert r.json()["ready"] is True


async def test_move_needs_capability_and_readiness(client, clock):
    """protects=Move needs confirm_entity's role (a viewer gets 403) and a ready feature
    (409 otherwise); a move puts the feature in Current state, moved by the owner;
    fails_when=either check is missing or the move does not stick; no_claim=Not yet."""
    w = await world()
    r = await w.post(client, "done", "move", "viewer", decision="move")
    assert r.status_code == 403
    r = await w.post(client, "fresh", "move", decision="move")
    assert r.status_code == 409
    r = await w.post(client, "done", "move", decision="move")
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["mark"] == "exists" and out["move_how"] == "owner_confirmed"
    assert out["moved_at"] and out["shipped_at"] and out["ready"] is False
    assert out["proof_days"] == 0
    assert (await w.rows(client))["done"]["mark"] == "exists"


async def test_check_again_rereads_tasks(client, clock):
    """protects=Check again re-reads the tasks proof from the feature's items (done of all,
    dropped left out) and stamps checked_at now; a viewer gets 403;
    fails_when=tasks or checked_at stay stale; no_claim=live code map or pull request reads."""
    w = await world()
    r = await w.post(client, "tracked", "check", "viewer")
    assert r.status_code == 403
    r = await w.post(client, "tracked", "check")
    assert r.status_code == 200, r.text
    out = r.json()
    tasks = next(p for p in out["proofs"] if p["kind"] == "tasks")
    assert (tasks["count"], tasks["total"]) == (2, 3)
    assert datetime.fromisoformat(tasks["checked_at"]) == NOW
    assert datetime.fromisoformat(out["checked_at"]) == NOW
    assert out["checking"] is False


async def test_measured_from_an_old_month_is_not_read_yet(client, clock):
    """protects=a measured proof whose month is past reads still_true false after a
    re-read; fails_when=an old number counts as still true; no_claim=live metric reads."""
    w = await world()
    r = await w.post(client, "running", "check")
    assert r.status_code == 200, r.text
    proofs = {p["kind"]: p for p in r.json()["proofs"]}
    assert proofs["measured"]["still_true"] is False
    assert proofs["code_map"]["still_true"] is True


async def test_answer_still_runs_and_no_longer_runs(client, clock):
    """protects=an owner's "still runs" clears an old proof (exists again, 0 days); "no
    longer runs" puts the feature back in Desired; "changed" keeps it; a viewer gets 403;
    fails_when=an answer is not kept or the mark does not follow; no_claim=the wording."""
    w = await world()
    r = await w.post(client, "old", "answer", "viewer", answer="still_runs")
    assert r.status_code == 403
    r = await w.post(client, "old", "answer", answer="still_runs")
    assert r.status_code == 200, r.text
    out = r.json()
    assert (out["mark"], out["proof_days"], out["answer"]) == ("exists", 0, "still_runs")
    assert out["answered_at"]
    r = await w.post(client, "running", "answer", answer="changed")
    assert r.json()["mark"] == "exists" and r.json()["answer"] == "changed"
    r = await w.post(client, "running", "answer", answer="no_longer_runs")
    assert r.json()["mark"] != "exists" and r.json()["move_how"] is None
    r = await w.post(client, "running", "answer", answer="maybe")
    assert r.status_code == 422


async def test_mark_as_already_shipped(client, clock):
    """protects=the item chat's "Mark as already shipped" card puts a feature in Current
    state with no proof yet; a viewer gets 403; fails_when=the status or shipped_at is not
    kept; no_claim=the card."""
    w = await world()
    r = await w.post(client, "fresh", "shipped", "viewer")
    assert r.status_code == 403
    r = await w.post(client, "fresh", "shipped")
    assert r.status_code == 200, r.text
    out = r.json()
    assert (out["mark"], out["no_proof_yet"], out["move_how"]) == ("exists", True,
                                                                   "marked_shipped")  # fmt: skip
    assert datetime.fromisoformat(out["shipped_at"]) == NOW
    r = await client.post(f"{URL}/{w.ids['idea']}/shipped", headers=w.ctx.as_("owner"))
    assert r.status_code == 404


async def test_nightly_reread_all(clock):
    """protects=the nightly job re-reads every feature with a state or proofs and stamps
    checked_at, once a night; fails_when=a feature is skipped or it runs twice a night;
    no_claim=the scheduler's own timing."""
    w = await world()
    later = NOW + timedelta(days=1)
    async with tenant_session(w.ctx.tenant_id) as s:
        n = await service.nightly(s, later)
        await s.commit()
    assert n == 7  # every feature but fresh
    async with tenant_session(w.ctx.tenant_id) as s:
        st = await service.state_of(s, w.ids["old"])
        assert st is not None and st.read_at == later
        tracked = await service.proofs_of(s, w.ids["tracked"])
        tasks = next(p for p in tracked if p.kind == "tasks")
        assert (tasks.count, tasks.total, tasks.checked_at) == (2, 3, later)
        assert await service.nightly(s, later + timedelta(hours=2)) == 0


async def test_the_tick_rereads_proof_once_a_night(client, clock):
    """protects=the company's tick (``POST /v1/internal/tick``, as the scheduled ticker)
    runs the nightly re-read; fails_when=the step is not wired; no_claim=the other steps."""
    w = await world()
    clock["now"] = NOW + timedelta(days=1)
    r = await client.post("/v1/internal/tick", headers=w.ctx.as_("owner"))
    assert r.status_code == 200, r.text
    async with tenant_session(w.ctx.tenant_id) as s:
        st = await service.state_of(s, w.ids["running"])
        assert st is not None and st.read_at == NOW + timedelta(days=1)


async def test_each_feature_names_its_roadmap_items(client, clock):
    """protects=a roadmap bar finds its feature's pill: each feature lists its items' ids;
    fails_when=item_ids is missing or empty for a feature with an item; no_claim=draft items."""
    w = await world()
    rows = await w.rows(client)
    assert rows["tracked"]["item_ids"] == [w.item_id]
    assert rows["gone"]["item_ids"] == []


async def test_the_nightly_reread_does_not_make_old_proof_fresh(clock):
    """protects=the nightly re-read finds nothing new in a live source for a feature whose
    proof was confirmed 41 days ago, so it still reads exists_old (only a live source or the
    owner's answer confirms it); the job still skips it for the rest of the night;
    fails_when=a re-read alone stamps the proof fresh; no_claim=the wording."""
    w = await world()
    later = NOW + timedelta(days=1)
    async with tenant_session(w.ctx.tenant_id) as s:
        await service.nightly(s, later)
        await s.commit()
    async with tenant_session(w.ctx.tenant_id) as s:
        st = await service.state_of(s, w.ids["old"])
        assert st is not None
        assert st.checked_at == NOW - timedelta(days=41) and st.read_at == later
        f = await service.feature(s, w.ids["old"])
        assert (await service.one(s, f, later)).mark == "exists_old"
        assert await service.nightly(s, later + timedelta(hours=2)) == 0


async def test_live_sources_make_a_feature_ready(client, clock):
    """protects=Check again reads the code map, merged pull requests and the goal's metric
    for a feature (as well as its tasks), so with all four in it reads ready and its proof
    is fresh; fails_when=a proof kind has no live reader; no_claim=the matching words."""
    w = await world()
    fid = w.ids["tracked"]
    content = {**MAP, "modules": [*MAP["modules"], {"id": "module:tracked", "path": "api/tracked",
               "summary": "The Tracked feature", "depends_on": []}]}  # fmt: skip
    map_id = await shared_map(w.ctx.tenant_id, content)
    async with tenant_session(w.ctx.tenant_id) as s:
        code_map = await s.get(CodeMap, map_id)
        assert code_map is not None
        source = await s.get(Source, code_map.source_id)
        assert source is not None
        for n, merged in ((1, "2026-10-30T10:00:00Z"), (2, "no")):
            await store.upsert_item(s, source, ItemUpsert(
                external_id=f"example-org/app:pull:{n}", kind="pull_request",
                title=f"pay-1: tracked step {n}", url=None, author="sam",
                content=f"# pay-1: tracked step {n}\n\n- Merged: {merged}\n"))  # fmt: skip
        goal = (await s.execute(select(Entity).where(Entity.type == "goal"))).scalar_one()
        feature = await s.get(Entity, uuid.UUID(fid))
        assert feature is not None
        await Seed(s).supports(feature, goal)
        m = Metric(title="Alerts sent", description="Alerts sent each week", kind="output",
                   unit="sent", direction="up", source="manual", goal_id=goal.id,
                   owner_id=w.ctx.users["owner"].id)  # fmt: skip
        s.add(m)
        await s.flush()
        s.add(MetricValue(metric_id=m.id, week_start=datetime(2026, 11, 2).date(), value=3410,
                          source="manual", definition_version=1))  # fmt: skip
        for t in (await s.execute(select(RoadmapItemTask))).scalars():
            if t.status == "todo":
                t.status = "done"
        await s.commit()
    r = await w.post(client, "tracked", "check")
    assert r.status_code == 200, r.text
    out = r.json()
    proofs = {p["kind"]: p for p in out["proofs"]}
    assert proofs["code_map"]["count"] == 1
    assert proofs["pull_requests"]["count"] == 1
    assert (proofs["tasks"]["count"], proofs["tasks"]["total"]) == (3, 3)
    assert proofs["measured"]["value"] == "3,410 sent" and proofs["measured"]["period"] == "Nov"
    assert out["ready"] is True
    assert datetime.fromisoformat(out["checked_at"]) == NOW
