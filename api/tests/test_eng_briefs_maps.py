"""The architect's briefs cite only the run's code maps (F4 Engineering check, F5-2).

Seen in an end-to-end pass: the run's maps covered two repositories, the features lived
mostly in a third with no map, and every brief was refused for citing that repository's
ids from other material, one refusal line per feature. The architect's prompt now lists
the ids it may cite (at most 40 per kind, the rest through get_code_map) with the rule and
a self-check; the file's shape has a one-line example; the stop groups unknown ids, one
line each, and says which repository has no map. Synthetic placeholders only.
"""

import uuid

import pytest

import oracle.main  # noqa: F401  (registers the lanes' prompt lines)
from oracle.engineering import briefs, check
from oracle.runs import flows
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from tests.fixtures import seed_auth
from tests.tech_brief_helpers import FEATURES, SAMPLE, flow_with_eng_check, seed_features
from tests.test_code_maps import MAP, REPO, shared_map

# SAMPLE with both features citing an id of a repository the run has no map of, and
# that repository named under code_map.unmapped.
UNMAPPED = (
    SAMPLE.replace(
        '    - {repo: "org/app", commit: "3f2c9a1", as_of: "2026-10-18T10:00:00Z"}\n',
        f'    - {{repo: "{REPO}", commit: "3f2c9a1", as_of: "2026-10-18T10:00:00Z"}}\n'
        '  unmapped: ["example-org/shop"]\n',
    )
    .replace('reuse: ["module:notifications"]', 'reuse: ["module:storefront"]')
    .replace(
        '      - {area: "api/notifications", kind: module, change: change, '
        'ref: "module:notifications"}',
        '      - {area: "shop/storefront", kind: module, change: change, '
        'ref: "module:storefront"}\n'
        '      - {area: "shop/cart", kind: data_model, change: change, ref: "model:cart"}',
    )
)
MAP_IDS = {"module:billing", "module:notifications"}


def test_unknown_ids_are_grouped_one_line_each_with_the_features_citing_them():
    # protects=the refusal list names each unknown id once with the features that cite
    # it; fails_when=one line per feature and id (55 lines for a few ids).
    summary = check._summarize(UNMAPPED, FEATURES, MAP_IDS, {REPO})
    unknown = [p for p in summary["problems"] if p["code"] == "unknown_ref"]
    assert [p["message"] for p in unknown] == [
        "'model:cart' is not in the code map this run used: cited by feature-b (touches[1].ref)",
        "'module:storefront' is not in the code map this run used: cited by feature-a "
        "(reuse), feature-b (touches[0].ref)",
    ]
    assert unknown[1]["features"] == ["feature-a", "feature-b"]
    assert unknown[1]["feature"] is None
    # The F5-1 contract still lists a problem per feature (registration refuses each).
    per_feature = [p for p in briefs.check(UNMAPPED, FEATURES, MAP_IDS) if p.code == "unknown_ref"]
    assert len(per_feature) == 3


def test_the_check_names_the_repository_with_no_map():
    # protects=the stop says which repository the run's maps do not cover; fails_when=
    # the summary has no unmapped_repos, or lists a repository a map covers.
    summary = check._summarize(UNMAPPED, FEATURES, MAP_IDS, {REPO.upper()})
    assert summary["unmapped_repos"] == ["example-org/shop"]
    # A repository listed under repos that no map of the run covers counts too.
    other = SAMPLE.replace("org/app", "example-org/legacy")
    assert check._summarize(other, FEATURES, MAP_IDS, {REPO})["unmapped_repos"] == [
        "example-org/legacy"
    ]
    assert check._summarize(SAMPLE, FEATURES, MAP_IDS, {"org/app"})["unmapped_repos"] == []


def test_a_repository_named_as_a_url_or_with_git_is_the_map_s_repository():
    # protects=a repository the briefs name as a URL, an ssh address or with .git matches
    # the map's owner/name; fails_when=exact matching shows a false "No code map covers".
    for name in (
        "https://github.com/org/app",
        "https://github.com/org/app.git/",
        "git@github.com:org/app.git",
        "org/app.git",
        "Org/App",
    ):
        named = SAMPLE.replace('"org/app"', f'"{name}"')
        assert check._summarize(named, FEATURES, MAP_IDS, {"org/app"})["unmapped_repos"] == []
    assert (
        check._summarize(SAMPLE, FEATURES, MAP_IDS, {"https://github.com/org/app.git"})[
            "unmapped_repos"
        ]
        == []
    )
    other = SAMPLE.replace('"org/app"', '"https://github.com/org/app-web"')
    assert check._summarize(other, FEATURES, MAP_IDS, {"org/app"})["unmapped_repos"] == [
        "https://github.com/org/app-web"
    ]


def test_unknown_ids_with_no_repository_named_still_say_no_map_covers_them():
    # protects=a brief citing a third repository's ids without naming it still tells the
    # stop that no map covers them; fails_when=only grouped ids show, with no no-map line.
    unnamed = UNMAPPED.replace('  unmapped: ["example-org/shop"]\n', "")
    summary = check._summarize(unnamed, FEATURES, MAP_IDS, {REPO})
    assert summary["unmapped_repos"] == []
    assert summary["unnamed_repo"] is True
    # Named, or no unknown ids: no such line.
    assert check._summarize(UNMAPPED, FEATURES, MAP_IDS, {REPO})["unnamed_repo"] is False
    assert check._summarize(SAMPLE, FEATURES, MAP_IDS, {"org/app"})["unnamed_repo"] is False
    assert check._summarize(None, FEATURES, MAP_IDS)["unnamed_repo"] is False


def test_unmapped_must_be_a_list_of_text():
    # protects=the new field's shape; fails_when=a mistyped unmapped crashes or passes.
    bad = UNMAPPED.replace('unmapped: ["example-org/shop"]', "unmapped: example-org/shop")
    assert any(
        p.code == "bad_entry" and "unmapped" in p.message
        for p in briefs.check(bad, FEATURES, MAP_IDS)
    )
    assert briefs.parse(UNMAPPED).code_map.unmapped == ["example-org/shop"]


def test_the_task_shows_the_shape_with_a_one_line_example():
    # protects=the shape the architect writes, shown exactly; fails_when=the example or
    # the "assumptions is a list of text" rule is dropped.
    task = flows.TECH_BRIEF_TASK
    assert "assumptions is a list of text" in task
    assert "- {feature: " in task and 'assumptions: ["' in task
    assert "unmapped" in task


def test_the_architect_lines_list_the_citable_ids_the_rule_and_the_self_check():
    # protects=the prompt's list of citable ids (at most 40 per kind, the rest through
    # get_code_map with the map's id), the cite-only rule and the self-check; fails_when=
    # any of them is missing.
    content = {
        **MAP,
        "modules": [{"id": f"module:m{i:02}", "path": f"api/m{i:02}", "summary": "x",
                     "depends_on": []} for i in range(45)],
    }  # fmt: skip
    map_id = uuid.uuid4()
    lines = "\n".join(check.architect_lines([(map_id, content)]))
    assert "module:m00" in lines and "module:m39" in lines and "module:m40" not in lines
    assert "and 5 more" in lines
    assert f"get_code_map with id {map_id}" in lines
    assert "Cite only ids in this run's code maps" in lines
    assert "under assumptions" in lines and "code_map.unmapped" in lines
    assert "Before you finish" in lines
    # A runtime that cannot reach Oracle's MCP cannot read the rest: ids not shown are
    # not cited, and get_code_map is not offered.
    offline = "\n".join(check.architect_lines([(map_id, content)], mcp_reachable=False))
    assert "module:m39" in offline and "and 5 more" in offline
    assert "get_code_map" not in offline
    assert "ids not shown here cannot be cited" in offline
    none = "\n".join(check.architect_lines([]))
    assert "no code map" in none and "used: false" in none


@pytest.fixture
def eng_flow(monkeypatch):
    monkeypatch.setitem(flows.FLOWS, "baseline_to_prd", flow_with_eng_check())


@pytest.fixture
def unmapped_runtime():
    fake = FakeRuntime({"eng_check": [Outcome(artifacts={flows.BRIEFS_FILE: UNMAPPED})]})
    set_runtime(fake)
    yield fake
    set_runtime(None)


async def test_the_stop_reads_grouped_ids_and_the_unmapped_repository(
    client, eng_flow, unmapped_runtime
):
    # protects=the architect's prompt carries the run's ids, and the stop's check stores
    # the grouped problems and the repository with no map; fails_when=the prompt lacks
    # the ids or the rule, or the stored check repeats an id per feature.
    from tests.test_tech_briefs import advance_to, pending, start

    tenant_id, auth = await seed_auth()
    await seed_features(tenant_id)
    map_id = await shared_map(tenant_id, MAP)
    run = await start(client, auth, "unmapped-shop-prd")
    run = await advance_to(client, auth, run["id"], "eng_review")
    prompt = next(
        step.prompt
        for wf in unmapped_runtime.submitted
        for step in wf.steps
        if flows.BRIEFS_FILE in step.prompt
    )
    assert "module:billing" in prompt and "job:nightly-sync" in prompt
    assert f"get_code_map with id {map_id}" in prompt
    assert "Cite only ids in this run's code maps" in prompt
    stored = pending(run)["payload"]["briefs_check"]
    assert stored["unmapped_repos"] == ["example-org/shop"]
    unknown = [p for p in stored["problems"] if p["code"] == "unknown_ref"]
    assert len(unknown) == 2
    assert unknown[1]["features"] == ["feature-a", "feature-b"]
