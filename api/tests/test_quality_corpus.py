"""The evaluation corpus (tests/fixtures/eval): every case returns its expected statuses.

The corpus is synthetic and redacted. It pins the deterministic rules; the model's light
judging is compared with it, never the other way round.
"""

import pytest

from oracle import readiness
from oracle.quality import criteria
from oracle.quality.compare import agreement
from oracle.readiness import ReadinessContext
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.quality_corpus import case_paths, load_case, seed_case

# Build prompt §10: the corpus covers each of these.
REQUIRED_CASES = {
    "good_section",
    "bad_section",
    "conflicting_evidence",
    "uncertain_claims",
    "missing_goals",
    "untestable_acceptance",
    "blocker_no_mitigation",
    "social_api_policy",
    "tenant_config_leakage",
    "stale_derived_spec",
}
STATUSES = {"pass", "warning", "critical", "not_applicable"}


def test_the_corpus_covers_every_case_section_10_lists():
    covered = set()
    for path in case_paths():
        covered |= set(load_case(path).get("covers") or [])
    assert REQUIRED_CASES <= covered, REQUIRED_CASES - covered


def test_every_expectation_names_a_known_check_and_status():
    keys = set(criteria.KEYS) | set(criteria.HARD_KEYS)
    for path in case_paths():
        case = load_case(path)
        assert case["expected"], path.stem
        assert set(case["expected"]) <= keys, (path.stem, set(case["expected"]) - keys)
        assert set(case["expected"].values()) <= STATUSES, path.stem


def test_every_criterion_is_exercised_beyond_pass():
    """Each criterion has at least one case where it is not a pass."""
    seen: dict[str, set[str]] = {}
    for path in case_paths():
        for key, status in load_case(path)["expected"].items():
            seen.setdefault(key, set()).add(status)
    for key in (*criteria.KEYS, *criteria.HARD_KEYS):
        assert seen.get(key, set()) - {"pass"}, key


@pytest.mark.parametrize("path", case_paths(), ids=lambda p: p.stem)
async def test_corpus_case(client, path):
    case = load_case(path)
    ctx = await make_ctx()
    seeded = await seed_case(client, ctx, case)
    criteria.register()
    async with tenant_session(ctx.tenant_id) as s:
        report = await readiness.evaluate(
            ReadinessContext(s, seeded.document_id, seeded.version_id, purpose="publish"),
            keys=criteria.ALL_KEYS,
        )
    results = {r.key: r for r in report.results}
    assert set(results) == set(criteria.ALL_KEYS)
    for r in report.results:
        assert r.error is None, (r.key, r.error)
        assert r.rationale.strip(), r.key
    got = {k: results[k].status for k in case["expected"]}
    assert got == case["expected"], {k: results[k].rationale for k in got}
    assert report.blocked == case["blocked"]
    # Only the hard checks can block; the ten criteria never do.
    assert {r.key for r in report.blocking} <= set(criteria.HARD_KEYS)
    for key, words in case["rationale_contains"].items():
        for word in words:
            assert word.lower() in results[key].rationale.lower(), (key, word, results[key])


async def test_human_and_model_ratings_are_compared_not_trusted(client):
    """Synthetic raters and a canned model answer are compared with the rules."""
    case = load_case("good-prd")
    ctx = await make_ctx()
    seeded = await seed_case(client, ctx, case)
    criteria.register()
    async with tenant_session(ctx.tenant_id) as s:
        report = await readiness.evaluate(
            ReadinessContext(s, seeded.document_id, seeded.version_id), keys=criteria.KEYS
        )
    rules = {r.key: r.status for r in report.results}
    human = case["human_ratings"][0]["ratings"]
    model = {c["key"]: c["status"] for c in case["model_output"]["criteria"]}
    result = agreement(rules, human=[human], model=model)
    assert result.compared == {"human": 4, "model": 2}
    assert result.human_agreement == 0.75  # the rater disagrees on validation_plan
    assert result.model_agreement == 0.5
    assert "validation_plan" in result.disagreements
    # Unknown keys from a model never count.
    assert "not_a_criterion" not in result.disagreements
