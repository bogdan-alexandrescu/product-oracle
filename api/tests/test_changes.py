"""oracle.changes: record_change stores an event and awaits the registered handlers."""

import uuid

import pytest
from sqlalchemy import func, select

from oracle import changes
from oracle.auth.deps import Principal
from oracle.tenancy import tenant_session
from oracle.v2.models import ArtifactDependency, ChangeEvent
from tests.conftest import make_tenant


@pytest.fixture(autouse=True)
def _no_lane_handlers():
    with changes.isolated_handlers():
        yield


async def test_records_the_event_and_runs_handlers_in_order(db):
    seen: list[tuple[str, str]] = []

    async def first(session, event):
        assert session is db
        seen.append(("first", event.subject_kind))

    async def second(session, event):
        # The event is flushed (it has an id) before handlers run.
        assert event.id is not None
        seen.append(("second", event.cause))

    changes.register_handler("lane.first", first)
    changes.register_handler("lane.second", second)
    principal = Principal(
        tenant_id=uuid.uuid4(), kind="user", role="approver", user_id=uuid.uuid4()
    )
    doc_section = uuid.uuid4()

    event = await changes.record_change(
        db,
        "document_section",
        cause="section_edited",
        actor=principal,
        subject_id=doc_section,
        subject_ref="checkout-redesign@2#goal-trace",
        data={"before_hash": "a", "after_hash": "b"},
    )
    await db.commit()

    assert seen == [("first", "document_section"), ("second", "section_edited")]
    stored = await db.get(ChangeEvent, event.id)
    assert stored.actor == principal.actor
    assert stored.subject_id == doc_section
    assert stored.data == {"before_hash": "a", "after_hash": "b"}
    assert stored.handled_by == ["lane.first", "lane.second"]


async def test_handlers_can_filter_by_subject(db):
    calls: list[str] = []

    async def only_sections(session, event):
        calls.append(event.subject_kind)

    changes.register_handler("review.invalidate", only_sections, subjects={"document_section"})
    blocker = await changes.record_change(db, "blocker_status", cause="resolved", actor=None)
    await changes.record_change(db, "document_section", cause="edited", actor="run:abc")
    assert calls == ["document_section"]
    assert blocker.handled_by == [] and blocker.actor == "system"


async def test_a_handler_writes_in_the_same_transaction(db):
    """The trace lane's handler marks downstream outputs stale, atomically with the event."""

    async def mark_stale(session, event):
        session.add(
            ArtifactDependency(
                upstream_entity_id=None,
                upstream_version_id=None,
                freshness="potentially_stale",
                caused_by_change_id=event.id,
            )
        )

    changes.register_handler("trace.mark_stale", mark_stale)
    # The dependency violates its check constraints (no downstream, no upstream): the
    # flush inside record_change fails, so the change does not commit either.
    with pytest.raises(Exception, match="ck_artifact_dependencies"):
        await changes.record_change(db, "requirement", cause="edited", actor=None)
    await db.rollback()
    assert await db.scalar(select(func.count()).select_from(ChangeEvent)) == 0


async def test_a_failing_handler_aborts_the_change(db):
    async def boom(session, event):
        raise RuntimeError("cannot invalidate approvals")

    changes.register_handler("review.invalidate", boom)
    with pytest.raises(RuntimeError, match="cannot invalidate approvals"):
        await changes.record_change(db, "decision", cause="reversed", actor=None)
    await db.rollback()
    assert await db.scalar(select(func.count()).select_from(ChangeEvent)) == 0


async def test_registration_rules():
    async def h(session, event):
        return None

    with pytest.raises(changes.UnknownSubjectError, match="nonsense"):
        changes.register_handler("x", h, subjects={"nonsense"})
    changes.register_handler("x", h)
    changes.register_handler("x", h, subjects={"decision"})  # replaces, not duplicates
    assert [(r.name, r.subjects) for r in changes.handlers()] == [("x", frozenset({"decision"}))]
    changes.unregister_handler("x")
    assert changes.handlers() == []


async def test_record_change_validates_its_input(db):
    with pytest.raises(changes.UnknownSubjectError):
        await changes.record_change(db, "weather", cause="rain", actor=None)
    with pytest.raises(ValueError, match="needs a cause"):
        await changes.record_change(db, "decision", cause="", actor=None)


async def test_events_are_company_scoped(db, tenant_id):
    await changes.record_change(db, "decision", cause="made", actor=None)
    await db.commit()
    other = await make_tenant("Other Co")
    async with tenant_session(other) as s:
        assert (await s.scalars(select(ChangeEvent))).all() == []


def test_isolated_handlers_restores_the_registry():
    async def h(session, event):
        return None

    changes.register_handler("outer", h)
    with changes.isolated_handlers():
        assert changes.handlers() == []
        changes.register_handler("inner", h)
    assert [r.name for r in changes.handlers()] == ["outer"]
