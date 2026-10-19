"""oracle.readiness: register_check and evaluate, with dummy checks."""

import uuid

import pytest
from sqlalchemy import text

from oracle import readiness
from oracle.readiness import CheckOutcome, ReadinessContext


@pytest.fixture(autouse=True)
def _no_lane_checks():
    with readiness.isolated_checks():
        yield


def outcome(status: str, **kw) -> readiness.Check:
    async def check(ctx: ReadinessContext) -> CheckOutcome:
        return CheckOutcome(status=status, rationale=f"dummy {status}", **kw)

    return check


async def test_results_carry_status_rationale_evidence_and_owner(db):
    owner, ev = uuid.uuid4(), uuid.uuid4()
    readiness.register_check("problem_clarity", outcome("pass"))
    readiness.register_check(
        "critical_blockers",
        outcome("warning", evidence_ids=[ev], owner_id=owner, section_keys=["risks"]),
        hard=True,
    )
    report = await readiness.evaluate(ReadinessContext(db, uuid.uuid4()))
    assert [(r.key, r.hard, r.status) for r in report.results] == [
        ("problem_clarity", False, "pass"),
        ("critical_blockers", True, "warning"),
    ]
    blocker = report.results[1]
    assert blocker.evidence_ids == [ev] and blocker.owner_id == owner
    assert blocker.section_keys == ["risks"] and blocker.rationale == "dummy warning"
    assert not report.blocked


async def test_only_a_critical_hard_check_blocks(db):
    """T2 is open: an advisory critical is shown, never a stop."""
    readiness.register_check("evidence_quality", outcome("critical"))
    readiness.register_check("security_policy", outcome("not_applicable"), hard=True)
    ctx = ReadinessContext(db, uuid.uuid4(), purpose="publish")
    report = await readiness.evaluate(ctx)
    assert not report.blocked

    readiness.register_check("critical_blockers", outcome("critical"), hard=True)
    report = await readiness.evaluate(ctx)
    assert report.blocked
    assert [r.key for r in report.blocking] == ["critical_blockers"]


async def test_a_hard_check_that_raises_fails_closed(db):
    async def broken(ctx):
        raise RuntimeError("source index unavailable")

    readiness.register_check("security_policy", broken, hard=True)
    readiness.register_check("alternatives", broken)
    report = await readiness.evaluate(ReadinessContext(db, uuid.uuid4()))
    hard, advisory = report.results
    assert hard.status == "critical" and "source index unavailable" in hard.error
    assert advisory.status == "warning" and advisory.error
    assert report.blocked


async def test_a_check_returning_the_wrong_type_is_an_error(db):
    async def sloppy(ctx):
        return {"status": "pass"}

    readiness.register_check("sloppy", sloppy, hard=True)
    (result,) = (await readiness.evaluate(ReadinessContext(db, uuid.uuid4()))).results
    assert result.status == "critical" and "CheckOutcome" in result.error


async def test_a_failed_query_does_not_poison_later_checks(db):
    async def bad_sql(ctx):
        await ctx.db.execute(text("SELECT * FROM no_such_table"))
        return CheckOutcome(status="pass", rationale="unreachable")

    async def good_sql(ctx):
        assert (await ctx.db.execute(text("SELECT 1"))).scalar() == 1
        return CheckOutcome(status="pass", rationale="query ran")

    readiness.register_check("bad", bad_sql)
    readiness.register_check("good", good_sql)
    bad, good = (await readiness.evaluate(ReadinessContext(db, uuid.uuid4()))).results
    assert bad.status == "warning" and bad.error
    assert good.status == "pass" and good.rationale == "query ran"


async def test_evaluate_a_subset_and_pass_the_context(db):
    seen: list[ReadinessContext] = []

    async def spy(ctx):
        seen.append(ctx)
        return CheckOutcome(status="pass", rationale="ok")

    readiness.register_check("a", spy)
    readiness.register_check("b", outcome("critical"), hard=True)
    doc, version = uuid.uuid4(), uuid.uuid4()
    ctx = ReadinessContext(db, doc, version, composition_revision=3)
    report = await readiness.evaluate(ctx, keys=["a"])
    assert [r.key for r in report.results] == ["a"] and not report.blocked
    assert seen == [ctx] and seen[0].composition_revision == 3


def test_registration_rules():
    readiness.register_check("k", outcome("pass"))
    readiness.register_check("k", outcome("critical"), hard=True)  # replaces
    assert [(r.key, r.hard) for r in readiness.checks()] == [("k", True)]
    readiness.unregister_check("k")
    assert readiness.checks() == []
    with pytest.raises(ValueError, match="needs a key"):
        readiness.register_check("", outcome("pass"))


def test_bad_status_is_refused():
    with pytest.raises(ValueError):
        CheckOutcome(status="green", rationale="nope")
