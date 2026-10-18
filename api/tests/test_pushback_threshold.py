"""The pushback threshold is a company setting (confidence_weights "pushback", default 0.7)."""

from decimal import Decimal

from oracle.baseline.models import Entity, Evidence
from oracle.jobs import kinds
from oracle.tenant_settings import TenantSetting


async def _evidence_refs(db) -> list[dict]:
    _, evidence, _ = await kinds.baseline_context(db)
    return evidence


async def test_default_threshold_is_0_7_and_a_company_can_raise_it(db):
    feature = Entity(type="feature", key="checkout", title="Checkout", origin="user")
    db.add(feature)
    await db.flush()
    db.add(
        Evidence(
            entity_id=feature.id, excerpt="Buyers abandon at shipping", confidence=Decimal("0.8")
        )
    )
    await db.flush()

    assert len(await _evidence_refs(db)) == 1  # 0.8 >= 0.7

    db.add(TenantSetting(key="confidence_weights", value={"pushback": 0.9}))
    await db.flush()
    assert await _evidence_refs(db) == []  # 0.8 < 0.9
