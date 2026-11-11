import cProfile, pstats, time, traceback, collections, os
from sqlalchemy import event
import pytest
from oracle import company_time
from oracle.db import get_engine
from tests.baseline_helpers import make_ctx
from tests.roadmap_scale_seed import NOW, seed_company


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def test_profile(client):
    t0 = time.perf_counter()
    ctx = await seed_company()
    print("seed", time.perf_counter() - t0)
    h = ctx.as_("owner")
    out = os.environ["TMPDIR"] + "/prof/"
    for url in ("/v1/simple/roadmap", "/v1/simple/roadmap/waiting"):
        r = await client.get(url, headers=h); assert r.status_code == 200, r.text
        sites = collections.Counter()
        stmts = []
        def count(conn, cursor, statement, *a):
            if "SAVEPOINT" in statement: return
            stmts.append(statement)
            conn.info["t0"] = time.perf_counter()
        def after(conn, cursor, statement, params, context, many):
            if "SAVEPOINT" in statement: return
            sites[f"{(time.perf_counter() - conn.info['t0'])*1000:7.1f} ms rows={cursor.rowcount} " + " ".join(statement.split())[:300]] += 1
        eng = get_engine().sync_engine
        event.listen(eng, "before_cursor_execute", count)
        event.listen(eng, "after_cursor_execute", after)
        t0 = time.perf_counter()
        r = await client.get(url, headers=h)
        dt = time.perf_counter() - t0
        event.remove(eng, "before_cursor_execute", count)
        event.remove(eng, "after_cursor_execute", after)
        print(url, f"{dt*1000:.0f} ms", len(stmts), "statements", len(r.content), "bytes")
        name = url.rsplit("/", 1)[1]
        with open(out + name + "-sites.txt", "w") as f:
            for k, v in sorted(sites.items()): f.write(f"{v}\t{k}\n")
        times = []
        for _ in range(3):
            t0 = time.perf_counter(); await client.get(url, headers=h); times.append(time.perf_counter() - t0)
        print(url, "times", [round(x*1000) for x in times])
        pr = cProfile.Profile(); pr.enable()
        await client.get(url, headers=h)
        pr.disable()
        pstats.Stats(pr, stream=open(out + name + "-cum.txt", "w")).sort_stats("cumulative").print_stats(80)
        pstats.Stats(pr, stream=open(out + name + "-tot.txt", "w")).sort_stats("tottime").print_stats(40)


STACK = []


async def test_steps(client, monkeypatch):
    import functools, importlib
    ctx = await seed_company()
    h = ctx.as_("owner")
    spent = collections.defaultdict(float)
    targets = {
        "oracle.simple.service": ["load", "_parent_goals", "_open_decisions", "item_codes", "_decided", "_tasks",
                                  "_bet_flows", "_lead_prds", "_goal_targets", "_roadmap_codes", "_track_bands", "_prd_headings",
                                  "_goals", "_ladder_goals", "efforts", "_blockers", "_cut", "_ancestors", "item_out"],
        "oracle.simple.additions": ["item_extras"],
        "oracle.simple.drafts": ["reader", "submitted_versions", "added_raw", "who"],
        "oracle.simple.goal_milestones": ["list_for_roadmaps", "target_rights"],
        "oracle.simple.meetings": ["decided_in", "decided_refs"],
        "oracle.auth.deps": [],
        "oracle.simple.visuals": ["flows_for"],
        "oracle.roadmap.tracks": ["lead_prd"], "oracle.roadmap.codes": ["feature_codes"], 
        "oracle.simple.key_dates": ["key_date_prds", "read_key_dates", "roadmap_key_dates"],
        "oracle.simple.plan": ["views"],
        "oracle.simple.goal_buckets": ["_goals"],
        "oracle.simple.old_milestones": ["preview"],
        "oracle.simple.approved_roadmap": ["lines"],
        "oracle.roadmap.company": ["feeding_ids", "feature_keys_of", "replaced_prd_ids"],
        "oracle.simple.goal_reads": ["goals_by_id"],
        "oracle.simple.constraints": ["check"],
        "oracle.simple.dates": ["after_dependencies", "resolve_by_dates"],
        "oracle.docs.prd_order": ["prd_ranks"],
    }
    import inspect
    for mod, names in targets.items():
        m = importlib.import_module(mod)
        for n in names:
            f = getattr(m, n)
            label = f"{mod.rsplit('.', 1)[1]}.{n}"
            if inspect.iscoroutinefunction(f):
                async def w(*a, __f=f, __l=label, **k):
                    t0 = time.perf_counter()
                    STACK.append(__l)
                    try:
                        return await __f(*a, **k)
                    finally:
                        STACK.pop()
                        spent[__l] += time.perf_counter() - t0
            else:
                def w(*a, __f=f, __l=label, **k):
                    t0 = time.perf_counter()
                    try:
                        return __f(*a, **k)
                    finally:
                        spent[__l] += time.perf_counter() - t0
            monkeypatch.setattr(m, n, w)
    from oracle.simple import service as _svc
    for n in ("_versions",):
        pass
    for url in ("/v1/simple/roadmap", "/v1/simple/roadmap/waiting"):
        await client.get(url, headers=h)
        by = collections.Counter()
        def count(conn, cursor, statement, *a):
            if "SAVEPOINT" in statement: return
            by[(" < ".join(STACK[::-1][:3]) or "-") + " :: " + " ".join(statement.split())[:90]] += 1
        eng = get_engine().sync_engine
        event.listen(eng, "before_cursor_execute", count)
        await client.get(url, headers=h)
        event.remove(eng, "before_cursor_execute", count)
        with open(os.environ["TMPDIR"] + "/prof/" + url.rsplit("/", 1)[1] + "-by.txt", "w") as fh:
            for k2, v2 in sorted(by.items()): fh.write(f"{v2}\t{k2}\n")
        spent.clear()
        t0 = time.perf_counter()
        for _ in range(3):
            await client.get(url, headers=h)
        print(url, f"total {(time.perf_counter() - t0) / 3 * 1000:.0f} ms")
        for k, v in sorted(spent.items(), key=lambda kv: -kv[1]):
            print(f"  {v / 3 * 1000:7.1f} ms  {k}")


async def test_goals_probe(client):
    from sqlalchemy import select
    from oracle.roadmap.models import RoadmapItem
    from oracle.simple import service
    from oracle.docs import prd_order
    from oracle.tenancy import tenant_session
    ctx = await seed_company()
    async with tenant_session(ctx.tenant_id) as s:
        fids = set(await s.scalars(select(RoadmapItem.feature_id)))
        for _ in range(2):
            t0 = time.perf_counter(); await service._goals(s, fids); print("_goals", (time.perf_counter() - t0) * 1000)
            t0 = time.perf_counter(); await prd_order.prd_ranks(s); print("ranks", (time.perf_counter() - t0) * 1000)
        pr = cProfile.Profile(); pr.enable()
        await prd_order.prd_ranks(s)
        pr.disable()
        pstats.Stats(pr, stream=open(os.environ["TMPDIR"] + "/prof/ranks.txt", "w")).sort_stats("tottime").print_stats(25)


async def test_build_direct(client):
    import gc
    from oracle.auth.deps import Principal
    from oracle.simple import service
    from oracle.tenancy import tenant_session
    ctx = await seed_company()
    who = Principal(tenant_id=ctx.tenant_id, kind="user", role="owner", user_id=ctx.users["owner"].id)
    for label in ("plain", "nogc"):
        if label == "nogc": gc.disable()
        async with tenant_session(ctx.tenant_id) as s:
            t0 = time.perf_counter(); await service.build(s, who); print(label, "build", (time.perf_counter() - t0) * 1000)
        gc.enable()
    async with tenant_session(ctx.tenant_id) as s:
        gc.disable()
        pr = cProfile.Profile(); pr.enable()
        await service.build(s, who)
        pr.disable()
        gc.enable()
    pstats.Stats(pr, stream=open(os.environ["TMPDIR"] + "/prof/build-tot.txt", "w")).sort_stats("tottime").print_stats(40)
    pstats.Stats(pr, stream=open(os.environ["TMPDIR"] + "/prof/build-cum.txt", "w")).sort_stats("cumulative").print_stats(120)
    st = pstats.Stats(pr, stream=open(os.environ["TMPDIR"] + "/prof/load-callees.txt", "w")); st.sort_stats("cumulative").print_callees("service.py:316")
    st = pstats.Stats(pr, stream=open(os.environ["TMPDIR"] + "/prof/build-callees.txt", "w")); st.sort_stats("cumulative").print_callees("service.py:1584")


async def test_gc_share(client):
    import gc
    ctx = await seed_company()
    h = ctx.as_("owner")
    spent = collections.Counter(); n = collections.Counter(); t = {}
    def cb(phase, info):
        if phase == "start": t[0] = time.perf_counter()
        else:
            spent[info["generation"]] += time.perf_counter() - t[0]; n[info["generation"]] += 1
    print("objects tracked", len(gc.get_objects()), gc.get_threshold())
    for url in ("/v1/simple/roadmap", "/v1/simple/roadmap/waiting"):
        await client.get(url, headers=h)
        gc.callbacks.append(cb); spent.clear(); n.clear()
        t0 = time.perf_counter()
        for _ in range(5):
            await client.get(url, headers=h)
        total = (time.perf_counter() - t0) / 5
        gc.callbacks.remove(cb)
        print(url, f"{total*1000:.0f} ms/request; gc per request:", {g: (round(spent[g] / 5 * 1000), n[g] / 5) for g in sorted(spent)})
        gc.freeze()
        t0 = time.perf_counter()
        for _ in range(5):
            await client.get(url, headers=h)
        print(url, f"after gc.freeze: {(time.perf_counter() - t0) / 5 * 1000:.0f} ms/request")
        gc.unfreeze()
