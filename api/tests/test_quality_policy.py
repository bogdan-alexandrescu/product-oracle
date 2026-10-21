"""T2 PRD quality policy (owner, 2026-10-19): advisory, gate criticals only.

§16 item 11: an ordinary advisory quality score alone never blocks a publish. Only the
hard checks (failed critical security or policy requirements, unsupported third-party
operation; approvals and blockers belong to other lanes) can.
"""

import uuid

from oracle import readiness
from oracle.quality import criteria
from oracle.readiness import CheckOutcome, ReadinessContext
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.quality_corpus import load_case, seed_case


def test_the_ten_criteria_are_advisory_and_only_two_checks_are_hard():
    import oracle.main  # noqa: F401  (the app registers the checks at import)

    registered = {r.key: r.hard for r in readiness.checks()}
    assert len(criteria.KEYS) == 10
    for key in criteria.KEYS:
        assert registered[key] is False, key
    assert set(criteria.HARD_KEYS) == {"security_policy", "third_party_support"}
    for key in criteria.HARD_KEYS:
        assert registered[key] is True, key


def test_no_numeric_publish_score_exists():
    """No universal numeric score: the catalogue has statuses, not a threshold."""
    for info in criteria.catalogue():
        dumped = info.model_dump()
        assert "score" not in dumped and "threshold" not in dumped and "weight" not in dumped


async def test_every_advisory_criterion_critical_never_blocks(client):
    """A PRD that fails every advisory criterion is shown as critical, never blocked."""
    ctx = await make_ctx()
    seeded = await seed_case(client, ctx, load_case("bad-prd-sections"))
    criteria.register()
    async with tenant_session(ctx.tenant_id) as s:
        report = await readiness.evaluate(
            ReadinessContext(s, seeded.document_id, seeded.version_id, purpose="publish"),
            keys=criteria.ALL_KEYS,
        )
    statuses = {r.key: r.status for r in report.results}
    assert sum(statuses[k] == "critical" for k in criteria.KEYS) >= 5
    assert not report.blocked and report.blocking == []


async def test_an_advisory_criterion_forced_critical_still_does_not_block(db):
    with readiness.isolated_checks():
        criteria.register()
        for key in criteria.KEYS:

            async def critical(ctx, key=key):
                return CheckOutcome(status="critical", rationale=f"{key} forced critical")

            readiness.register_check(key, critical)  # advisory, as registered
        for key in criteria.HARD_KEYS:

            async def fine(ctx):
                return CheckOutcome(status="pass", rationale="ok")

            readiness.register_check(key, fine, hard=True)
        ctx = ReadinessContext(db, uuid.uuid4(), purpose="publish")
        report = await readiness.evaluate(ctx)
        assert [r.status for r in report.results if not r.hard] == ["critical"] * 10
        assert not report.blocked


async def test_a_failed_hard_check_blocks(client):
    ctx = await make_ctx()
    seeded = await seed_case(client, ctx, load_case("failed-security-requirement"))
    criteria.register()
    async with tenant_session(ctx.tenant_id) as s:
        report = await readiness.evaluate(
            ReadinessContext(s, seeded.document_id, seeded.version_id, purpose="publish"),
            keys=criteria.ALL_KEYS,
        )
    assert report.blocked
    assert [r.key for r in report.blocking] == ["security_policy"]


async def test_a_quality_check_that_cannot_load_its_document_is_safe(db):
    """An unknown document: advisory criteria are not_applicable or warnings, hard checks
    are not_applicable (there is nothing to check), and nothing raises."""
    criteria.register()
    report = await readiness.evaluate(ReadinessContext(db, uuid.uuid4()), keys=criteria.ALL_KEYS)
    assert all(r.error is None for r in report.results)
    assert not report.blocked
