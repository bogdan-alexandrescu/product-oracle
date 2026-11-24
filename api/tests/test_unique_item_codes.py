"""unique-codes (the owner, Nov 23): every roadmap item has its own code; nothing shares one.

Items of one Ground Truth feature (its slices) read the feature's code today, so two items
read F-51 and setting an owner on one leaves the other flagged. An item's own code (its
title's) now comes before its feature's; a code another item reads is refused naming that
item; the migration gives every item sharing a code (or with none) its own, the earliest
start keeping it, the others the next free numbers, audited. Invented example data only.
"""

import asyncio
import importlib.util
import uuid
from datetime import UTC, date, datetime

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import create_async_engine

from oracle import company_time
from oracle.models import AuditEvent
from oracle.roadmap.models import RoadmapItem
from oracle.simple.models import SimpleDraft
from oracle.tenancy import tenant_session, unscoped_session
from tests.conftest import API_DIR
from tests.migration_db import upgrade
from tests.test_migrations import SCRATCH_URL, _cfg, _run, scratch_db  # noqa: F401
from tests.test_simple_changes_api import make_people
from tests.test_simple_goal_milestones_api import CHANGES
from tests.test_simple_roadmap_api import NOW, Seed, by_key, get

pytestmark = pytest.mark.asyncio(loop_scope="session")

REVISION = "0136_unique_item_codes"


def migration():
    """Migration 0136 itself: the renumbering is frozen inside it (it imports no app code)."""
    path = API_DIR / "migrations" / "versions" / f"{REVISION}.py"
    spec = importlib.util.spec_from_file_location(REVISION, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def one_feature_two_items(ctx) -> tuple[str, str]:
    """Feature F-51 Alert routing with two items: one reads the feature's code, the other its
    own (F-64)."""
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, _, rv = await seed.roadmap("alerts")
        f = await seed.entity("feature", "F-51")
        f.title = "Alert routing"
        a = await seed.item(rv, pv, "a", position=0, title="Alert routing", feature_id=f.id)
        b = await seed.item(rv, pv, "b", position=1, title="F-64 Routing by team", feature_id=f.id)
        await s.commit()
    return str(a.id), str(b.id)


@pytest.fixture
def before_the_rule(monkeypatch):
    """Rows written as they stood before codes-at-write (Nov 23), which now numbers a second
    item of a feature as it is written: the migration's pairs to renumber."""
    from oracle.roadmap import codes

    monkeypatch.setattr(codes._Numbering, "give", lambda self, row, code: None)


def set_code(client, ctx, item: str, before: str | None, after: str | None):
    body = {"op": "set_code", "target": {"item_id": item}, "before": {"code": before},
            "after": {"code": after}}  # fmt: skip
    return client.post(CHANGES, json=body, headers=ctx.as_("owner"))


async def test_two_items_of_one_feature_read_their_own_codes(client):
    """Two items of one feature read two codes; the one with its own still names the feature."""
    # protects=an item's own code (its title's) before its feature's, and its feature named;
    # fails_when=both items read F-51; no_claim=Priorities' 2x2 marks.
    ctx = await make_people()
    await one_feature_two_items(ctx)
    shown = by_key(await get(client, ctx, "owner"))
    a, b = shown["a"], shown["b"]
    assert (a["code"], a["code_from"], a["title"]) == ("F-51", "feature", "Alert routing")
    assert (b["code"], b["code_from"], b["title"]) == ("F-64", None, "Routing by team")
    assert b["feature_name"] == "F-51 Alert routing"
    assert a["feature_name"] is None


async def test_a_taken_code_is_refused_naming_the_item_that_has_it(client):
    """An item of a feature takes a code of its own; one another item reads is refused."""
    ctx = await make_people()
    _, b = await one_feature_two_items(ctx)
    r = await set_code(client, ctx, b, "F-64", "F-51")
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "F-51 is already the code of F-51 Alert routing"
    r = await set_code(client, ctx, b, "F-64", "F-70")
    assert r.status_code == 201, r.text
    assert by_key(await get(client, ctx, "owner"))["b"]["code"] == "F-70"


async def test_a_rename_keeps_the_items_own_code_checked(client):
    """A rename of an item of a feature, to a code another item reads, is refused."""
    ctx = await make_people()
    _, b = await one_feature_two_items(ctx)
    body = {"op": "edit_title", "target": {"item_id": b}, "before": {"title": "Routing by team"},
            "after": {"title": "F-51 Routing by team"}}  # fmt: skip
    r = await client.post(CHANGES, json=body, headers=ctx.as_("owner"))
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "F-51 is already the code of F-51 Alert routing"


@pytest.mark.asyncio(loop_scope="session")
async def test_the_next_free_number_is_one_rule():
    """New items and the migration share one rule: the highest F-number in use, plus one."""
    from oracle.roadmap import codes

    assert codes.next_number(["F-62", "F-37a", "F-12.2", None, "AB-90", "F-8"]) == "F-63"
    assert codes.next_number([]) == "F-1"


def test_the_migration_chains_on_the_single_head():
    """Migration 0136 chains on 0135 (feature comments); the one head is 0137 (stale by meaning)."""
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    from tests.conftest import API_DIR

    script = ScriptDirectory.from_config(Config(str(API_DIR / "alembic.ini")))
    assert script.get_revision("0136_unique_item_codes").down_revision == "0135_feature_comments"
    assert script.get_heads() == ["0137_stale_by_meaning"]


def _at(day: int) -> datetime:
    return datetime(2026, 10, day, 9, 0, tzinfo=UTC)


async def test_the_migration_gives_every_item_its_own_code(client, before_the_rule):
    """Each group sharing a code keeps it on its earliest start; the others take the next free
    numbers in date order, as do items with none; unique codes stay; audited; twice is once."""
    mig = migration()
    ACTION = mig.ACTION

    def renumber(session):
        return mig.renumber(session.connection())

    ctx = await make_people()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, rm, rv = await seed.roadmap("alerts")
        rv2 = await seed.version(rm, 2)
        f51 = await seed.entity("feature", "F-51")
        f62 = await seed.entity("feature", "F-62")
        f31 = await seed.entity("feature", "F-31")
        await seed.entity("feature", "F-08")  # a feature with no item: its number is in use

        def item(v, key, title, created, **kw):
            return seed.item(v, pv, key, title=title, created_at=_at(created), **kw)

        # Three slices of F-51: the earliest start keeps it.
        await item(rv2, "a", "Routing rules", 1, feature_id=f51.id, start_date=date(2026, 12, 1))
        await item(rv2, "b", "Routing by team", 2, feature_id=f51.id, start_date=date(2026, 11, 2))
        await item(rv2, "c", "Routing digest", 3, feature_id=f51.id)
        # The same item on the version before: its approved row is left as it was.
        await item(rv, "a", "Routing rules", 1, feature_id=f51.id, start_date=date(2026, 12, 1))
        # An item dropped before the latest version shares no plan with h: neither changes.
        await item(rv, "z", "F-29a Old saved views", 1)
        # Two of F-62 on one start date: the earliest created keeps it.
        await item(rv2, "d", "Search index", 5, feature_id=f62.id, start_date=date(2026, 11, 9))
        await item(rv2, "e", "Search filters", 4, feature_id=f62.id, start_date=date(2026, 11, 9))
        # Unique codes stay, slices with a suffix too; an item with none gets one.
        await item(rv2, "g", "F-37a Exports", 6)
        await item(rv2, "h", "F-29a Saved views", 7)
        await item(rv2, "i", "Loose ends", 8, start_date=date(2026, 11, 20))
        # A title leading with another code than its feature's showed the feature's: unique, it
        # keeps it (the title now leads with it); in a group, the audit names it too.
        await item(rv2, "k", "F-99 Launch flow", 9, feature_id=f31.id)
        m = await item(rv2, "m", "Wrap up", 10, feature_id=f51.id)
        await s.commit()
        # Written as rows stood before the write check, which refuses it now.
        t = RoadmapItem.__table__
        await s.execute(update(t).where(t.c.id == m.id).values(title="F-37a Wrap up"))
        await s.commit()

    async with unscoped_session() as s:
        made = await s.run_sync(renumber)
        await s.commit()
    got = {m["item_key"]: (m["old"], m["new"]) for m in made}
    assert got == {
        "d": ("F-62", "F-63"),  # Nov 9, created after e
        "i": (None, "F-64"),  # Nov 20
        "a": ("F-51", "F-65"),  # Dec 1
        "c": ("F-51", "F-66"),  # no start date: last
        "m": ("F-51", "F-67"),
    }

    async with unscoped_session() as s:
        titles = {
            (r.roadmap_version_id, r.item_key): r.title
            for r in await s.scalars(
                select(RoadmapItem).where(RoadmapItem.roadmap_document_id == rm.id)
            )
        }
        events = list(
            await s.scalars(
                select(AuditEvent).where(
                    AuditEvent.action == ACTION, AuditEvent.tenant_id == ctx.tenant_id
                )
            )
        )
    # Current plan only: the latest version is renumbered; the version before keeps what was
    # approved (the old shared code).
    assert titles[(rv2.id, "a")] == "F-65 Routing rules"
    assert titles[(rv.id, "a")] == "Routing rules"
    assert titles[(rv2.id, "b")] == "Routing by team"  # keeps F-51, from its feature
    assert titles[(rv2.id, "e")] == "Search filters"  # keeps F-62
    assert titles[(rv2.id, "g")] == "F-37a Exports"
    assert titles[(rv2.id, "h")] == "F-29a Saved views"
    assert titles[(rv.id, "z")] == "F-29a Old saved views"
    assert titles[(rv2.id, "k")] == "F-31 F-99 Launch flow"  # still shows F-31, same name
    assert titles[(rv2.id, "m")] == "F-67 F-37a Wrap up"
    pairs = sorted(((e.data["old"], e.data["new"]) for e in events), key=str)
    assert pairs == sorted(got.values(), key=str)
    assert all(isinstance(e.entity_id, uuid.UUID) for e in events)

    async with unscoped_session() as s:
        again = await s.run_sync(renumber)
        await s.commit()
    assert again == []


async def _plans(ctx):
    """Feature F-51 with two items sharing its code, on an older approved version (v1), the
    latest (v2) and a working draft; a row in Trash on v2; an older row leading with another
    code than its feature's. Returns the ids and the roadmap document id."""
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, rm, rv = await seed.roadmap("alerts")
        rv2 = await seed.version(rm, 2)
        f51 = await seed.entity("feature", "F-51")
        f31 = await seed.entity("feature", "F-31")
        draft = await seed.add(
            SimpleDraft(
                document_id=rm.id,
                base_version_id=rv2.id,
                status="working",
                overlay={},
                created_by=ctx.users["owner"].id,
            )
        )
        ids: dict[str, uuid.UUID] = {}

        async def add(name, v, key, title, created, **kw):
            row = await seed.item(v, pv, key, title=title, created_at=_at(created), **kw)
            ids[name] = row.id

        b = {"feature_id": f51.id}
        await add("b2", rv2, "b", "Routing by team", 2, start_date=date(2026, 11, 2), **b)
        await add("a2", rv2, "a", "Routing rules", 1, start_date=date(2026, 12, 1), **b)
        await add("a1", rv, "a", "Routing rules", 1, start_date=date(2026, 12, 1), **b)
        await add("lead1", rv, "q", "F-99 Quiet hours", 1, feature_id=f31.id)
        await add("trash2", rv2, "t", "F-99 Gone item", 3, feature_id=f31.id,
                  deleted_at=_at(20))  # fmt: skip
        await add("trash_dup", rv2, "u", "Gone slice", 3, deleted_at=_at(20), **b)
        draft_row = RoadmapItem(
            roadmap_document_id=rm.id, simple_draft_id=draft.id, item_key="a",
            title="Routing rules", horizon="now", position=0, start_date=date(2026, 12, 1),
            created_at=_at(4), feature_id=f51.id)  # fmt: skip
        await seed.add(draft_row)
        ids["a_draft"] = draft_row.id
        await s.commit()
    return ids, rm.id


async def _rows(ids):
    """Every stored column of each row, by name."""
    t = RoadmapItem.__table__
    async with unscoped_session() as s:
        got = (await s.execute(select(t).where(t.c.id.in_(list(ids.values()))))).mappings().all()
    by_id = {r["id"]: dict(r) for r in got}
    return {name: by_id[i] for name, i in ids.items()}


async def _renumber():
    mig = migration()
    async with unscoped_session() as s:
        made = await s.run_sync(lambda session: mig.renumber(session.connection()))
        await s.commit()
    return made


async def test_an_older_approved_versions_row_is_left_exactly_as_approved(client, before_the_rule):
    """The item of the latest version is renumbered; its row on the older approved version
    keeps its title and every other column."""
    # protects=Current plan only (the owner, Nov 23): approved rows are never rewritten;
    # fails_when=the second pass renumbers every live row of the item across versions.
    ctx = await make_people()
    ids, _ = await _plans(ctx)
    before = await _rows(ids)
    made = await _renumber()
    after = await _rows(ids)
    assert [(m["item_key"], m["old"], m["new"]) for m in made] == [("a", "F-51", "F-52")]
    assert after["a1"] == before["a1"]
    assert after["a1"]["title"] == "Routing rules"


async def test_neither_pass_rewrites_a_row_in_trash(client):
    """A row in Trash is left as it was: one sharing a code (second pass) and one leading
    with another code than its feature's (first pass)."""
    ctx = await make_people()
    ids, _ = await _plans(ctx)
    before = await _rows(ids)
    await _renumber()
    after = await _rows(ids)
    assert after["trash2"] == before["trash2"]
    assert after["trash_dup"] == before["trash_dup"]


async def test_the_first_pass_leaves_an_older_versions_row_leading_with_another_code(client):
    """An older version's row leading with F-99 under feature F-31 keeps its title: the first
    pass only rewrites rows on the current plan."""
    ctx = await make_people()
    ids, _ = await _plans(ctx)
    await _renumber()
    assert (await _rows(ids))["lead1"]["title"] == "F-99 Quiet hours"


async def test_a_second_run_changes_nothing_with_older_rows_present(client, before_the_rule):
    """The older row keeps the old shared code after the first run; the second run does not
    read it as a new duplicate: no changes, no new audit rows, every row as it was."""
    ctx = await make_people()
    ids, _ = await _plans(ctx)
    await _renumber()
    stored = await _rows(ids)

    async def audits():
        async with unscoped_session() as s:
            return len(
                list(
                    await s.scalars(
                        select(AuditEvent).where(
                            AuditEvent.action == migration().ACTION,
                            AuditEvent.tenant_id == ctx.tenant_id,
                        )
                    )
                )
            )

    count = await audits()
    assert count == 1
    assert await _renumber() == []
    assert await audits() == count
    assert await _rows(ids) == stored


async def test_the_latest_version_and_a_working_draft_are_renumbered(client, before_the_rule):
    """The latest version's and the working draft's rows of the item take the new code; the
    keeper (earliest start) stays."""
    ctx = await make_people()
    ids, _ = await _plans(ctx)
    await _renumber()
    after = await _rows(ids)
    assert after["a2"]["title"] == "F-52 Routing rules"
    assert after["a_draft"]["title"] == "F-52 Routing rules"
    assert after["b2"]["title"] == "Routing by team"


def test_the_alembic_step_gives_every_item_its_own_code(scratch_db):  # noqa: F811
    """Upgrading 0135 -> 0136 on a database with shared codes renumbers them and audits each;
    running the step's logic again changes nothing."""
    # protects=the real alembic step (not only its function): earliest start keeps the shared
    # code, the others take the next free numbers, an item with none too, one audit row each;
    # fails_when=the step imports app code, renumbers a unique code, or a rerun changes rows;
    # no_claim=the downgrade (it does nothing).
    cfg = _cfg()
    upgrade(cfg, "0135_feature_comments")
    tenant, doc = uuid.uuid4(), uuid.uuid4()
    version, feature = uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:id, 'Example Co')", id=tenant)
    _run(
        "INSERT INTO documents (id, tenant_id, slug, title, status, kind, visibility)"
        " VALUES (:d, :t, 'plan', 'Plan', 'approved', 'roadmap', 'company')",
        d=doc,
        t=tenant,
    )
    _run(
        "INSERT INTO document_versions (id, tenant_id, document_id, number, markdown,"
        " content_hash) VALUES (:v, :t, :d, 1, '# plan', 'h1')",
        v=version,
        t=tenant,
        d=doc,
    )
    _run(
        "INSERT INTO entities (id, tenant_id, type, key, title, status, origin)"
        " VALUES (:f, :t, 'feature', 'F-51', 'Alert routing', 'confirmed', 'user')",
        f=feature,
        t=tenant,
    )
    rows = [  # key, title, feature, start
        ("a", "Routing rules", feature, date(2026, 12, 1)),
        ("b", "Routing by team", feature, date(2026, 11, 2)),
        ("c", "F-37a Exports", None, None),
        ("d", "Loose ends", None, date(2026, 11, 20)),
    ]
    for key, title, feat, start in rows:
        _run(
            "INSERT INTO roadmap_items (id, tenant_id, roadmap_document_id,"
            " roadmap_version_id, item_key, position, title, horizon, feature_id,"
            " start_date, created_at) VALUES (gen_random_uuid(), :t, :d, :v, :k, 0, :title,"
            " 'now', :f, :s, now())",
            t=tenant,
            d=doc,
            v=version,
            k=key,
            title=title,
            f=feat,
            s=start,
        )

    def titles():
        return dict(_run("SELECT item_key, title FROM roadmap_items"))

    def audits():
        return sorted(
            (r[0]["item_key"], r[0]["old"], r[0]["new"])
            for r in _run("SELECT data FROM audit_events WHERE action = :a", a=migration().ACTION)
        )

    upgrade(cfg, REVISION)
    assert titles() == {
        "a": "F-53 Routing rules",  # Dec 1: the later of the two sharing F-51, numbered after d
        "b": "Routing by team",  # Nov 2: keeps F-51, from its feature
        "c": "F-37a Exports",
        "d": "F-52 Loose ends",  # none, Nov 20: the next free number
    }
    assert audits() == [("a", "F-51", "F-53"), ("d", None, "F-52")]

    # The step's logic again, on the upgraded database: nothing changes.
    async def again():
        engine = create_async_engine(SCRATCH_URL)
        async with engine.begin() as conn:
            made = await conn.run_sync(migration().renumber)
        await engine.dispose()
        return made

    assert asyncio.run(again()) == []
    assert titles()["a"] == "F-53 Routing rules"
    assert len(audits()) == 2
