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
