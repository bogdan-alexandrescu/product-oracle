"""Add it to a PRD: the Engineering check's way on for a Ground Truth feature in no PRD.

The check names a feature a brief depends on that no PRD holds ("Export logs is in no PRD
yet"). "Add it to a PRD" starts a Ground Truth to PRD run of the PRD picked (or of a new
PRD) with that feature to add: the run's ``features`` knob (Ground Truth features by key or
id), which its baseline and feature set prompts are told to keep. While that run is live
the check reads the feature as being added to that PRD, not in no PRD; once the run stops
(cancelled or failed) it is in no PRD again, and once the run's scope is approved it is
that PRD's feature.

Test card (every test below): protects=the Engineering check's "in no PRD yet" can be
cleared in the UI, by a run that really adds the feature to a PRD; fails_when=the knob is
dropped, an unknown feature or another flow is accepted, a PATCH without it loses it, the
prompts leave it out, or the check still says the feature is in no PRD while a run adds it;
no_claim=how well the agents follow the prompt.

Runs against Postgres with the FakeRuntime. Invented data only.
"""

import pytest

from oracle.runs import flows
from oracle.runs.models import Run
from oracle.tenancy import tenant_session
from tests.baseline_helpers import confirm, entity
from tests.intake_helpers import company
from tests.test_cross_prd_dependencies import (  # noqa: F401  (clock: the pinned day)
    _add,
    _summary,
    clock,
    world,
)


async def _features(client, ctx) -> list[dict]:
    """Two confirmed Ground Truth features and one rejected."""
    out = []
    for key, title in (("export-logs", "Export logs"), ("usage-meter", "Usage meter")):
        feature = await entity(client, ctx, type="feature", key=key, title=title)
        await confirm(client, ctx, feature)
        out.append(feature)
    gone = await entity(client, ctx, type="feature", key="old-idea", title="Old idea")
    resp = await client.post(
        f"/v1/baseline/entities/{gone['id']}/reject", headers=ctx.as_("approver")
    )
    assert resp.status_code == 200, resp.text
    return out


def _named(run: dict) -> list[tuple[str, str]]:
    return [(f["key"], f["title"]) for f in run["knobs"]["features"]]


async def _run(client, ctx, expect: int = 201, flow: str = "baseline_to_prd", **knobs) -> dict:
    resp = await client.post(
        "/v1/runs",
        json={"flow": flow, "document": "safety", "knobs": knobs},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == expect, resp.text
    return resp.json()


async def test_a_prd_run_names_the_features_to_add_and_patch_keeps_them(client):
    ctx = await company()
    made = await _features(client, ctx)
    run = await _run(client, ctx, features=["export-logs", made[1]["id"], "export-logs"])
    assert _named(run) == [("export-logs", "Export logs"), ("usage-meter", "Usage meter")]
    assert run["knobs"]["features"][0]["id"] == made[0]["id"]
    owner = ctx.as_("owner")
    resp = await client.patch(
        f"/v1/runs/{run['id']}", json={"knobs": {"depth": "deep"}}, headers=owner
    )
    assert resp.status_code in (200, 204), resp.text
    read = (await client.get(f"/v1/runs/{run['id']}", headers=owner)).json()
    assert _named(read) == _named(run)
    resp = await client.patch(
        f"/v1/runs/{run['id']}", json={"knobs": {"features": ["usage-meter"]}}, headers=owner
    )
    assert resp.status_code in (200, 204), resp.text
    read = (await client.get(f"/v1/runs/{run['id']}", headers=owner)).json()
    assert _named(read) == [("usage-meter", "Usage meter")]
    # Without the knob a run adds none.
    assert (await _run(client, ctx))["knobs"]["features"] == []


async def test_an_unknown_or_rejected_feature_or_another_flow_is_422(client):
    ctx = await company()
    await _features(client, ctx)
    resp = await _run(client, ctx, expect=422, features=["old-idea"])
    assert "old-idea" in str(resp)
    await _run(client, ctx, expect=422, features=["no-such-feature"])
    await _run(client, ctx, expect=422, flow="feedback_loop", features=["export-logs"])


def _prompt(segment: str, features: list[tuple[str, str]]) -> str:
    flow = flows.FLOWS["baseline_to_prd"]
    seg = flow.segment(segment)
    ctx = flows.PromptContext(
        run_id="r1", document="safety", snapshot_as_of=None, low_confidence=0.5,
        target_features=features,
    )  # fmt: skip
    return flows.step_prompt(flow, seg, seg.roles[-1], last=True, ctx=ctx)


def test_the_baseline_and_feature_set_prompts_keep_the_features_to_add():
    for segment in ("baseline", "feature_set"):
        prompt = _prompt(segment, [("export-logs", "Export logs")])
        assert "Features to add: add these Ground Truth features to this PRD." in prompt
        assert "- export-logs: Export logs" in prompt
    assert "keep each of them under features" in _prompt("feature_set", [("export-logs", "x")])
    for segment in ("baseline", "feature_set", "priority", "prd_draft"):
        assert "Features to add" not in _prompt(segment, [])


async def _adding(w: dict, status: str, *, document: bool = True) -> Run:
    """A Ground Truth to PRD run of the Safety PRD (or of a new PRD) started to add Export
    logs, now ``status``."""
    async with tenant_session(w["tenant"]) as s:
        from sqlalchemy import select

        from oracle.baseline.models import Entity

        gt = await s.scalar(select(Entity).where(Entity.key == "export-logs"))
        knobs = {"target_features": [{"id": str(gt.id), "key": gt.key, "title": gt.title}]}
        if not document:
            knobs["document_slug"] = "audit-trail"
        run = await _add(s, Run(flow="baseline_to_prd", status=status, knobs=knobs,
                                document_id=w["safety"] if document else None))  # fmt: skip
        await s.commit()
        return run


@pytest.mark.parametrize("status", ["running", "awaiting_checkpoint"])
async def test_a_feature_a_live_run_adds_is_not_in_no_prd(status):
    w = await world(roadmap=False)
    await _adding(w, status)
    summary = await _summary(w, "export-logs")
    assert summary["problems"] == []
    assert summary["elsewhere"] == {"export-logs": "Export logs (being added to Safety PRD)"}


async def test_a_new_prd_s_run_names_the_prd_by_its_slug():
    w = await world(roadmap=False)
    await _adding(w, "running", document=False)
    summary = await _summary(w, "export-logs")
    assert summary["elsewhere"] == {"export-logs": "Export logs (being added to Audit trail PRD)"}


@pytest.mark.parametrize("status", ["draft", "cancelled", "failed", "succeeded"])
async def test_a_run_not_started_or_stopped_adds_nothing(status):
    # A draft run (the dialog closed before Start), a stopped one, or one that finished
    # without keeping it: the feature is in no PRD.
    w = await world(roadmap=False)
    await _adding(w, status)
    (problem,) = (await _summary(w, "export-logs"))["problems"]
    assert problem["code"] == "dependency_in_no_prd"


async def test_the_run_adding_it_does_not_count_for_itself():
    w = await world(roadmap=False)
    run = await _adding(w, "running")
    async with tenant_session(w["tenant"]) as s:
        from oracle.engineering import check

        mine = await check.elsewhere(s, await s.get(Run, run.id))
    assert "export-logs" not in mine
