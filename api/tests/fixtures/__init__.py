"""Draft fixtures and helpers shared by the document tests.

``prd_v2.md`` resolves the feedback items ``FEEDBACK_SHIPPING`` and
``FEEDBACK_GUEST``; tests create items with these ids before importing it.
"""

import uuid
from pathlib import Path

FIXTURES = Path(__file__).resolve().parent
FEEDBACK_SHIPPING = uuid.UUID("11111111-1111-4111-8111-111111111111")
FEEDBACK_GUEST = uuid.UUID("22222222-2222-4222-8222-222222222222")
MARKDOWN = {"Content-Type": "text/markdown"}


def draft(name: str) -> str:
    return (FIXTURES / name).read_text()


async def seed_auth() -> tuple[uuid.UUID, dict[str, str]]:
    """Seed tenant + admin + token; return (tenant_id, auth headers)."""
    from oracle.seed import seed

    result = await seed(password="test-password-123")
    return result.tenant_id, {"Authorization": f"Bearer {result.token}"}


async def import_draft(client, headers, text: str, doc: str = "checkout-redesign"):
    return await client.post(
        f"/v1/documents/{doc}/versions", content=text.encode(), headers={**headers, **MARKDOWN}
    )


# The baseline items the fixtures' ``source: oracle`` citations name ("baseline goal g1 ...",
# "baseline decision show-shipping-early ..."): the import refuses a ref that names none.
ORACLE_REFS = (("goal", "g1"), ("decision", "show-shipping-early"))


async def seed_oracle_refs(tenant_id: uuid.UUID) -> None:
    """The company's baseline items the fixtures' oracle citations name."""
    from oracle.baseline.models import Entity
    from oracle.tenancy import tenant_session

    async with tenant_session(tenant_id) as s:
        for type_, key in ORACLE_REFS:
            s.add(Entity(type=type_, key=key, title=key, status="confirmed", origin="user"))
        await s.commit()
