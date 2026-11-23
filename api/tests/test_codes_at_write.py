"""codes-at-write (the owner, Nov 23: "Number them at write"): an item that would show a code
it takes from its Ground Truth feature, which another item of its plan already shows, gets the
next free number at once when it is written, whatever path writes it; nothing is refused but a
typed code that is taken. Invented example data only.

Test cards (protects / fails_when / no_claim):

- test_three_slices_in_one_write_get_three_codes: protects=a PRD import or publish of three
  slices of one feature (one write) gives three codes, the first the feature's, each numbering
  audited as at write; fails_when=two slices read F-51; no_claim=the PRD parser.
- test_a_slice_added_to_a_draft_is_numbered_against_its_version: protects=a Simple draft row
  (the PRD import's) is numbered when the version its draft was opened on holds an item that
  shows the feature's code; fails_when=the draft row reads F-51 beside it.
- test_a_feature_linked_later_is_numbered: protects=an item given the feature later (a dirty
  write) is numbered; fails_when=it reads F-51 beside the first.
- test_two_writes_at_once_get_different_codes: protects=the lock: two writes of the first item
  of one feature at the same moment never both keep its code; fails_when=both read F-51.
- test_a_copy_keeps_its_code_and_older_versions_stay: protects=copying items to a new version
  keeps every code (no renumbering on copy) and the older version's rows are not rewritten;
  fails_when=a copy is numbered.
- test_trash_and_older_versions_are_not_the_plan: protects=a row in Trash or on an older
  version neither counts nor is rewritten: the first live item of the feature keeps its code;
  fails_when=it is numbered for a Trash row, or the Trash row is renamed.
- test_a_typed_taken_code_is_still_refused: protects=a title leading with a code another item
  shows is refused (409) as before; fails_when=it is written or numbered.
"""

import asyncio
import uuid
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import select, update

from oracle import company_time
from oracle.models import AuditEvent
from oracle.roadmap import codes
from oracle.roadmap.models import RoadmapItem
from oracle.simple.models import SimpleDraft
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import make_people
from tests.test_simple_roadmap_api import NOW, Seed

pytestmark = pytest.mark.asyncio(loop_scope="session")


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def world() -> SimpleNamespace:
    """A roadmap (one approved version) and feature F-51 Alert routing; nothing on it yet."""
    ctx = await make_people()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, rm, rv = await seed.roadmap("alerts")
        f = await seed.entity("feature", "F-51")
        f.title = "Alert routing"
        await s.commit()
    return SimpleNamespace(t=ctx.tenant_id, rm=rm.id, rv=rv.id, f=f.id, seed=seed, rm_doc=rm)


def item(w, key: str, n: int = 0, **kw) -> RoadmapItem:
    kw.setdefault("roadmap_version_id", w.rv)
    kw.setdefault("feature_id", w.f)
    return RoadmapItem(roadmap_document_id=w.rm, item_key=key, horizon="now", position=n,
                       title=kw.pop("title", f"Alert routing {key}"), **kw)  # fmt: skip


async def titles(w) -> dict[str, str]:
    async with tenant_session(w.t) as s:
        rows = await s.execute(select(RoadmapItem.item_key, RoadmapItem.title,
                                      RoadmapItem.roadmap_version_id))  # fmt: skip
        return {f"{k}@{v}" if v != w.rv else k: t for k, t, v in rows}


async def numberings(w) -> list[dict]:
    async with tenant_session(w.t) as s:
        found = await s.scalars(
            select(AuditEvent).where(AuditEvent.action == "roadmap.item.code_renumbered")
        )
        return sorted((e.data for e in found), key=lambda d: d["new"])


async def test_three_slices_in_one_write_get_three_codes():
    """Three slices of one feature written at once read three codes; the first keeps F-51."""
    w = await world()
    async with tenant_session(w.t) as s:
        for n, k in enumerate(("a", "b", "c")):
            s.add(item(w, k, n))
        await s.commit()
    assert await titles(w) == {"a": "Alert routing a", "b": "F-52 Alert routing b",
                               "c": "F-53 Alert routing c"}  # fmt: skip
    said = await numberings(w)
    assert [(d["item_key"], d["old"], d["new"], d["at"]) for d in said] == [
        ("b", "F-51", "F-52", "write"),
        ("c", "F-51", "F-53", "write"),
    ]


async def test_a_slice_added_to_a_draft_is_numbered_against_its_version():
    """A draft's added row (as the PRD import writes it) is numbered against its version."""
    w = await world()
    async with tenant_session(w.t) as s:
        s.add(item(w, "a"))
        await s.flush()
        d = SimpleDraft(document_id=w.rm, base_version_id=w.rv, created_by=uuid.uuid4())
        s.add(d)
        await s.flush()
        s.add(item(w, "b", 1, roadmap_version_id=None, simple_draft_id=d.id))
        await s.commit()
    got = {k.split("@")[0]: t for k, t in (await titles(w)).items()}
    assert got == {"a": "Alert routing a", "b": "F-52 Alert routing b"}


async def test_a_feature_linked_later_is_numbered():
    """An item given the feature after it was written is numbered then."""
    w = await world()
    async with tenant_session(w.t) as s:
        s.add(item(w, "a"))
        s.add(item(w, "b", 1, feature_id=None, title="Routing rules"))
        await s.commit()
    async with tenant_session(w.t) as s:
        b = await s.scalar(select(RoadmapItem).where(RoadmapItem.item_key == "b"))
        b.feature_id = w.f
        await s.commit()
    assert (await titles(w))["b"] == "F-52 Routing rules"


async def test_two_writes_at_once_get_different_codes():
    """Two writes of the feature's first item at the same moment: one keeps F-51, one is
    numbered (the second waits for the first's lock)."""
    w = await world()

    async def write(key: str) -> None:
        async with tenant_session(w.t) as s:
            s.add(item(w, key))
            await s.flush()
            await asyncio.sleep(0.3)
            await s.commit()

    await asyncio.gather(write("a"), write("b"))
    got = sorted((await titles(w)).values())
    shown = sorted(codes.title_code(t) or "F-51" for t in got)
    assert shown == ["F-51", "F-52"], got


async def test_a_copy_keeps_its_code_and_older_versions_stay():
    """A new version's copies keep their codes; the older version's rows stay as they were,
    even a pair left from before."""
    w = await world()
    async with tenant_session(w.t) as s:
        s.add(item(w, "a"))
        s.add(item(w, "b", 1))
        await s.commit()
    async with tenant_session(w.t) as s:
        # A pair from before the rule, on the older version.
        await s.execute(update(RoadmapItem).where(RoadmapItem.item_key == "b")
                        .values(title="Alert routing b"))  # fmt: skip
        await s.commit()
    async with tenant_session(w.t) as s:
        v2 = await Seed(s).version(await s.get(type(w.rm_doc), w.rm), 2)
        olds = list(await s.scalars(select(RoadmapItem).where(RoadmapItem.roadmap_version_id == w.rv)))
        for o in olds:
            fields = {c.key: getattr(o, c.key) for c in RoadmapItem.__mapper__.column_attrs
                      if c.key not in ("id", "created_at", "updated_at")}  # fmt: skip
            s.add(codes.copied_from(RoadmapItem(**fields | {"roadmap_version_id": v2.id}),
                                    roadmap_version_id=w.rv))  # fmt: skip
        await s.commit()
    got = await titles(w)
    assert sorted(got.values()) == ["Alert routing a"] * 2 + ["Alert routing b"] * 2, got
    assert await numberings(w) == []


async def test_trash_and_older_versions_are_not_the_plan():
    """The latest version's first live item keeps the feature's code, whatever Trash and an
    older version hold; a second is numbered; neither Trash nor the older row is rewritten."""
    w = await world()
    async with tenant_session(w.t) as s:
        s.add(item(w, "old"))
        await s.commit()
    async with tenant_session(w.t) as s:
        v2 = await Seed(s).version(await s.get(type(w.rm_doc), w.rm), 2)
        s.add(item(w, "gone", roadmap_version_id=v2.id, deleted_at=NOW))
        await s.commit()
    async with tenant_session(w.t) as s:
        s.add(item(w, "new", 1, roadmap_version_id=v2.id))
        await s.commit()
    async with tenant_session(w.t) as s:
        s.add(item(w, "next", 2, roadmap_version_id=v2.id))
        await s.commit()
    got = {k.split("@")[0]: t for k, t in (await titles(w)).items()}
    assert got == {"old": "Alert routing old", "gone": "Alert routing gone",
                   "new": "Alert routing new", "next": "F-52 Alert routing next"}  # fmt: skip


async def test_a_typed_taken_code_is_still_refused():
    """A title leading with the code another item shows is refused, never numbered."""
    w = await world()
    async with tenant_session(w.t) as s:
        s.add(item(w, "a"))
        await s.commit()
    async with tenant_session(w.t) as s:
        s.add(item(w, "b", 1, feature_id=None, title="F-51 Night digest"))
        with pytest.raises(HTTPException) as e:
            await s.flush()
        assert e.value.status_code == 409
        assert e.value.detail == "F-51 is already the code of F-51 Alert routing a"
    assert await titles(w) == {"a": "Alert routing a"}
