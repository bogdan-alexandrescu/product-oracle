import uuid

import pytest
from sqlalchemy import delete, select, text, update

from oracle.models import Document, Tenant
from oracle.tenancy import (
    TenantMismatchError,
    TenantRequiredError,
    bare_session,
    set_tenant,
    tenant_session,
)
from tests.conftest import make_tenant


async def test_select_without_tenant_is_refused():
    async with bare_session() as s:
        with pytest.raises(TenantRequiredError):
            await s.execute(select(Document))


async def test_get_text_and_flush_without_tenant_are_refused():
    async with bare_session() as s:
        with pytest.raises(TenantRequiredError):
            await s.get(Document, uuid.uuid4())
        with pytest.raises(TenantRequiredError):
            await s.execute(text("SELECT 1"))
        s.add(Document(slug="x", title="X", tenant_id=uuid.uuid4()))
        with pytest.raises(TenantRequiredError):
            await s.flush()


async def test_tenant_session_requires_a_tenant():
    with pytest.raises(TenantRequiredError):
        async with tenant_session(None):  # type: ignore[arg-type]
            pass


async def test_set_tenant_unlocks_the_session(tenant_id):
    async with bare_session() as s:
        set_tenant(s, tenant_id)
        assert (await s.execute(select(Document))).all() == []


async def _add_doc(tenant: uuid.UUID, slug: str) -> uuid.UUID:
    async with tenant_session(tenant) as s:
        doc = Document(slug=slug, title=slug.title())  # tenant_id stamped on flush
        s.add(doc)
        await s.commit()
        assert doc.tenant_id == tenant
        return doc.id


async def test_queries_only_see_own_tenant():
    a, b = await make_tenant("A"), await make_tenant("B")
    doc_a = await _add_doc(a, "alpha")
    doc_b = await _add_doc(b, "beta")

    async with tenant_session(a) as s:
        slugs = (await s.scalars(select(Document.slug))).all()
        assert slugs == ["alpha"]
        assert await s.get(Document, doc_b) is None
        assert (await s.scalars(select(Tenant.name))).all() == ["A"]

        # Bulk UPDATE / DELETE are scoped too.
        await s.execute(update(Document).values(title="changed"))
        await s.execute(delete(Document).where(Document.id == doc_b))
        await s.commit()

    async with tenant_session(b) as s:
        doc = await s.get(Document, doc_b)
        assert doc is not None and doc.title == "Beta"
    async with tenant_session(a) as s:
        assert (await s.get(Document, doc_a)).title == "changed"


async def test_cannot_write_rows_of_another_tenant():
    a, b = await make_tenant("A"), await make_tenant("B")
    async with tenant_session(a) as s:
        s.add(Document(slug="x", title="X", tenant_id=b))
        with pytest.raises(TenantMismatchError):
            await s.flush()
