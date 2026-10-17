"""The v1 tables: tenant scoping, check constraints, generated search column."""

import hashlib

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError

from oracle.baseline.models import Edge, Entity, Evidence, Proposal
from oracle.members.models import Invite
from oracle.runs.models import Checkpoint, Run
from oracle.sources.models import Source, SourceItem, SourceItemVersion
from oracle.templates.defaults import DEFAULT_TEMPLATE_KEY, ensure_default_template
from oracle.templates.models import Template, TemplateVersion
from oracle.tenancy import TenantMismatchError, tenant_session
from tests.conftest import make_tenant


def _source() -> Source:
    return Source(kind="github", name="storefront", config={"repos": ["example-org/storefront"]})


def _entity(key: str = "activation") -> Entity:
    return Entity(type="goal", key=key, title="Activation", origin="user")


def _run() -> Run:
    return Run(flow="baseline_to_prd", knobs={"depth": "standard"})


@pytest.mark.parametrize(
    "make", [_source, _entity, _run, lambda: Invite(email="pm@example.com", role="viewer")]
)
async def test_rows_are_invisible_and_unwritable_across_tenants(make):
    a, b = await make_tenant("A"), await make_tenant("B")
    async with tenant_session(a) as s:
        row = make()
        s.add(row)
        await s.commit()
        model, row_id = type(row), row.id
        assert row.tenant_id == a

    async with tenant_session(b) as s:
        assert await s.get(model, row_id) is None
        assert (await s.scalars(select(model))).all() == []
        s.add(make())
        await s.commit()  # B's own row with the same unique fields is fine

    async with tenant_session(b) as s:
        other = make()
        other.tenant_id = a
        s.add(other)
        with pytest.raises(TenantMismatchError):
            await s.flush()

    async with tenant_session(a) as s:
        assert await s.scalar(select(func.count()).select_from(model)) == 1


@pytest.mark.parametrize(
    "make",
    [
        lambda: Source(kind="dropbox", name="x"),
        lambda: Source(kind="upload", name="x", status="broken"),
        lambda: Entity(type="epic", key="x", title="X", origin="user"),
        lambda: Entity(type="goal", key="x", title="X", origin="robot"),
        lambda: Entity(type="goal", key="x", title="X", origin="user", status="maybe"),
        lambda: Run(flow="roadmap"),
        lambda: Run(flow="feedback_loop", status="sleeping"),
        lambda: Invite(email="pm@example.com", role="admin"),
        lambda: Invite(email="PM@example.com", role="viewer"),
    ],
)
async def test_enum_like_columns_are_checked(db, make):
    db.add(make())
    with pytest.raises(IntegrityError, match="ck_"):
        await db.flush()


async def test_one_open_invite_per_email(db):
    db.add(Invite(email="pm@example.com", role="viewer"))
    await db.flush()
    db.add(Invite(email="pm@example.com", role="approver"))
    with pytest.raises(IntegrityError, match="uq_invites_tenant_id_email_open"):
        await db.flush()


async def test_revoked_invite_frees_the_email(db):
    from datetime import UTC, datetime

    db.add(Invite(email="pm@example.com", role="viewer", revoked_at=datetime.now(UTC)))
    db.add(Invite(email="pm@example.com", role="approver"))
    await db.flush()


async def test_evidence_and_edges_targets(db):
    goal, feature = _entity(), Entity(type="feature", key="one-click", title="1", origin="agent")
    db.add_all([goal, feature])
    await db.flush()
    edge = Edge(src_id=feature.id, dst_id=goal.id, type="supports", origin="agent")
    db.add(edge)
    await db.flush()
    db.add(Evidence(entity_id=goal.id, excerpt="from the plan"))
    db.add(Proposal(payload={"type": "feature", "title": "New"}))  # a new item: no target
    await db.flush()

    async with db.begin_nested():
        db.add(Evidence(entity_id=goal.id, edge_id=edge.id))
        with pytest.raises(IntegrityError, match="ck_evidence_one_target"):
            await db.flush()
    async with db.begin_nested():
        db.add(Evidence())
        with pytest.raises(IntegrityError, match="ck_evidence_one_target"):
            await db.flush()
    async with db.begin_nested():
        db.add(Edge(src_id=goal.id, dst_id=goal.id, type="blocks", origin="user"))
        with pytest.raises(IntegrityError, match="ck_edges_not_self"):
            await db.flush()


async def test_checkpoint_defaults_to_approver(db):
    run = _run()
    db.add(run)
    await db.flush()
    cp = Checkpoint(run_id=run.id, kind="prd_review")
    db.add(cp)
    await db.flush()
    await db.refresh(cp)
    assert (cp.status, cp.approver_role) == ("pending", "approver")


async def test_item_versions_get_a_search_vector(db):
    source = _source()
    db.add(source)
    await db.flush()
    item = SourceItem(source_id=source.id, external_id="issue-1", kind="issue", title="Checkout")
    db.add(item)
    await db.flush()
    content = "Shipping costs surprise buyers at the last step"
    version = SourceItemVersion(
        item_id=item.id,
        title=item.title,
        content=content,
        content_hash=hashlib.sha256(content.encode()).hexdigest(),
    )
    db.add(version)
    await db.flush()
    item.current_version_id = version.id
    await db.flush()

    query = func.websearch_to_tsquery("english", "checkout shipping")
    found = (
        await db.scalars(
            select(SourceItemVersion.id).where(SourceItemVersion.search.op("@@")(query))
        )
    ).all()
    assert found == [version.id]
    indexdef = await db.scalar(
        text("SELECT indexdef FROM pg_indexes WHERE indexname = 'ix_source_item_versions_search'")
    )
    assert "USING gin (search)" in indexdef


async def test_default_template_is_seeded_once(db):
    await ensure_default_template(db)
    await ensure_default_template(db)
    templates = (await db.scalars(select(Template))).all()
    assert [t.key for t in templates] == [DEFAULT_TEMPLATE_KEY]
    version = await db.scalar(select(TemplateVersion))
    assert version.version == 1 and "{#goal-trace}" in version.body


async def test_seed_gives_the_tenant_the_default_template():
    from oracle.seed import seed

    r = await seed()
    async with tenant_session(r.tenant_id) as s:
        assert await s.scalar(select(Template.key)) == DEFAULT_TEMPLATE_KEY
