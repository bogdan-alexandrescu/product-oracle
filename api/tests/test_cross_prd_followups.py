"""Cross-PRD dependencies follow-ups (PR 1240 review minors).

- A Ground Truth feature in no PRD is caught at the Engineering check, named and linked:
  "Export logs is in no PRD yet", not first at the roadmap items stop.
- An unknown dependency reads in words: the brief's feature by name and code, and what was
  not found, never ``features[0] (key)``.
- A cancelled or failed run's scope is not on the company roadmap; an earlier scope of a
  live or finished run of that PRD still is.
- A stopped update run of a published PRD keeps the PRD's earlier approved scope on the
  company roadmap: approving the run's scope superseded it, and the run then stopped.
- A Ground Truth feature with no title is named with a readable name and its key.
- A waiting Engineering check whose dependency stays unknown is not parsed again on every
  read while its briefs and what Oracle knows stay the same.

Against Postgres. Invented data only.
"""

from datetime import UTC, datetime

from sqlalchemy import select

from oracle.baseline.models import Entity
from oracle.engineering import check
from oracle.roadmap import company
from oracle.runs import feature_set
from oracle.runs.models import Checkpoint, Run, RunSegment
from oracle.runs.scope_models import PrdScope, PrdScopeItem
from oracle.tenancy import tenant_session
from tests.test_cross_prd_dependencies import (  # noqa: F401  (clock: the pinned day)
    BRIEFS,
    NOW,
    _add,
    _summary,
    clock,
    world,
)


async def test_a_ground_truth_feature_in_no_prd_is_caught_at_the_engineering_check():
    # protects=a dependency on a confirmed feature no PRD holds is named at the Engineering
    # check; fails_when=the check accepts it and the roadmap items stop refuses it later.
    w = await world(roadmap=False)
    summary = await _summary(w, "export-logs")
    assert [p["code"] for p in summary["problems"]] == ["dependency_in_no_prd"]
    (problem,) = summary["problems"]
    assert problem["message"] == "Export logs is in no PRD yet: Observability depends on it"
    assert problem["feature"] == "observability"
    assert "export-logs" not in summary["elsewhere"]
    # It names the Ground Truth feature, so the stop links to it (add it to a PRD there).
    async with tenant_session(w["tenant"]) as s:
        gt = await s.scalar(select(Entity.id).where(Entity.key == "export-logs"))
    assert problem["entity"] == str(gt)
    # Another PRD's feature is still accepted, named with its PRD.
    on = await _summary(await world(), "account-health-ledger")
    assert on["problems"] == []


async def test_an_unknown_dependency_is_named_in_words():
    # protects=the unknown-dependency message names the feature and what was not found;
    # fails_when=it reads "features[0] (observability): depends on 'made-up-feature', ...".
    w = await world()
    (problem,) = (await _summary(w, "made-up-feature"))["problems"]
    assert problem["code"] == "unknown_dependency"
    assert problem["message"] == (
        'Observability (observability) depends on "made-up-feature", a feature Oracle cannot '
        "find in any PRD or in Ground Truth"
    )


async def _stopped_scope(tenant, status: str, *, key: str, title: str) -> None:
    async with tenant_session(tenant) as s:
        run = await _add(s, Run(flow="baseline_to_prd", status=status,
                                knobs={"document_slug": key}))  # fmt: skip
        scope = await _add(s, PrdScope(run_id=run.id, segment_seq=2, attempt=1,
                                       status="approved", check_result={},
                                       approved_at=NOW))  # fmt: skip
        s.add(PrdScopeItem(scope_id=scope.id, kind="feature", key=key, title=title,
                           decision="include", position=0))  # fmt: skip
        await s.commit()


async def test_a_cancelled_or_failed_run_s_scope_is_not_on_the_company_roadmap():
    # protects=only live runs and published PRDs feed the company roadmap; fails_when=a
    # cancelled or failed run's approved scope still counts.
    w = await world()
    await _stopped_scope(w["tenant"], "cancelled", key="session-guard", title="Session guard")
    await _stopped_scope(w["tenant"], "failed", key="login-alerts", title="Login alerts")
    await _stopped_scope(w["tenant"], "running", key="audit-trail", title="Audit trail")
    async with tenant_session(w["tenant"]) as s:
        # A later cancelled run of the Safety PRD does not hide its finished run's scope.
        later = await _add(s, Run(flow="baseline_to_prd", status="cancelled",
                                  document_id=w["safety"]))  # fmt: skip
        scope = await _add(s, PrdScope(run_id=later.id, segment_seq=2, attempt=1,
                                       status="approved", document_id=w["safety"],
                                       check_result={},
                                       approved_at=datetime(2026, 11, 5, tzinfo=UTC)))  # fmt: skip
        s.add(PrdScopeItem(scope_id=scope.id, kind="feature", key="abandoned-idea",
                           title="Abandoned idea", decision="include", position=0))  # fmt: skip
        await s.commit()
        on = await company.features_on_roadmap(s)
    assert "session-guard" not in on
    assert "login-alerts" not in on
    assert "abandoned-idea" not in on
    assert on["audit-trail"].label == "Audit trail (Audit trail PRD)"
    assert on["account-health-ledger"].label == "Account health ledger (Safety PRD)"


async def _stopped_update(w: dict, status: str) -> None:
    """An update run of the Safety PRD whose scope is approved at its feature set stop (the
    PRD's earlier approved scope is then superseded), and the run then ``status``."""
    async with tenant_session(w["tenant"]) as s:
        run = await _add(s, Run(flow="baseline_to_prd", status="running",
                                document_id=w["safety"]))  # fmt: skip
        scope = await _add(s, PrdScope(run_id=run.id, segment_seq=2, attempt=1,
                                       status="proposed", document_id=w["safety"],
                                       check_result={}))  # fmt: skip
        s.add(PrdScopeItem(scope_id=scope.id, kind="feature", key="session-guard",
                           title="Session guard", decision="include", position=0))  # fmt: skip
        await s.flush()
        await feature_set.approve(s, scope, None)
        run.status = status
        await s.commit()


async def _safety_kept(w: dict) -> None:
    async with tenant_session(w["tenant"]) as s:
        on = await company.features_on_roadmap(s)
    assert on["account-health-ledger"].label == "Account health ledger (Safety PRD)"
    assert "session-guard" not in on
    # Another PRD's brief depending on it is not told it is in no PRD yet.
    summary = await _summary(w)
    assert summary["problems"] == []
    assert summary["elsewhere"] == {"account-health-ledger": "Account health ledger (Safety PRD)"}


async def test_a_cancelled_update_run_keeps_the_prd_s_earlier_scope_on_the_roadmap():
    # protects=a cancelled update of a published PRD falls back to the scope it superseded;
    # fails_when=none of the PRD's features are on the company roadmap any more.
    w = await world(roadmap=False)
    await _stopped_update(w, "cancelled")
    await _safety_kept(w)


async def test_a_failed_update_run_keeps_the_prd_s_earlier_scope_on_the_roadmap():
    # protects=a failed update of a published PRD falls back to the scope it superseded;
    # fails_when=the PRD's features read as in no PRD yet.
    w = await world(roadmap=False)
    await _stopped_update(w, "failed")
    await _safety_kept(w)


async def test_a_live_update_run_s_scope_replaces_the_one_it_superseded():
    # protects=the fallback is only for a stopped run; fails_when=a superseded scope still
    # shows beside the live run's newer one.
    w = await world(roadmap=False)
    await _stopped_update(w, "running")
    async with tenant_session(w["tenant"]) as s:
        on = await company.features_on_roadmap(s)
    assert on["session-guard"].label == "Session guard (Safety PRD)"
    assert "account-health-ledger" not in on


async def test_a_feature_with_no_title_in_no_prd_is_named_in_words_with_its_key():
    # protects=a nameless Ground Truth feature reads as a name and its key; fails_when=the
    # message names it by its bare key ("usage-meter is in no PRD yet").
    w = await world(roadmap=False)
    async with tenant_session(w["tenant"]) as s:
        s.add(Entity(type="feature", key="usage-meter", title=" ", status="confirmed",
                     origin="user"))  # fmt: skip
        await s.commit()
    (problem,) = (await _summary(w, "usage-meter"))["problems"]
    assert problem["message"] == (
        "Usage meter (usage-meter) is in no PRD yet: Observability depends on it"
    )


async def test_a_waiting_check_with_a_key_still_unknown_is_not_parsed_again(monkeypatch):
    # protects=a stop read again and again with the same unknown key parses its briefs
    # once; fails_when=every read parses the file again.
    w = await world()
    calls: list[int] = []
    real = check.summarize

    async def counted(*args, **kwargs):
        calls.append(1)
        return await real(*args, **kwargs)

    monkeypatch.setattr(check, "summarize", counted)
    text = BRIEFS.replace("DEP", "made-up-feature")
    old = check._summarize(text, frozenset({"observability"}), None)
    async with tenant_session(w["tenant"]) as s:
        files = {check.briefs.FILE: text}
        segment = RunSegment(run_id=w["run"], seq=3, name="eng_review", status="succeeded",
                             artifacts={"files": files})  # fmt: skip
        await _add(s, segment)
        payload = {"segment_seq": 3, check.PAYLOAD_KEY: old}
        cp = await _add(s, Checkpoint(run_id=w["run"], kind=check.KIND, status="pending",
                                      payload=payload))  # fmt: skip
        await s.commit()
        run = await s.get(Run, w["run"])
        for _ in range(3):
            await check.refresh(s, run, [segment], [cp], persist=False)
        assert len(calls) == 1
        # New briefs are read again.
        other = text.replace("One dashboard", "Two dashboards")
        segment.artifacts = {"files": {check.briefs.FILE: other}}
        await check.refresh(s, run, [segment], [cp], persist=False)
        assert len(calls) == 2
        # And so are the same briefs once the key is known.
        s.add(PrdScopeItem(scope_id=(await s.get(PrdScope, await _safety_scope(s, w))).id,
                           kind="feature", key="made-up-feature", title="Made up feature",
                           decision="include", position=5))  # fmt: skip
        await s.flush()
        assert await check.refresh(s, run, [segment], [cp], persist=False)
        assert len(calls) == 3
        assert cp.payload[check.PAYLOAD_KEY]["problems"] == []


async def _safety_scope(s, w):
    from sqlalchemy import select

    return await s.scalar(select(PrdScope.id).where(PrdScope.document_id == w["safety"]))


async def test_the_trash_filter_builds_its_criteria_once(monkeypatch):
    # protects=each read (the Inbox makes about 75) reuses the trash filter's criteria;
    # fails_when=every SELECT builds one loader criteria per trashable class again.
    from oracle.trash import filter as trash_filter

    built: list[object] = []
    real = trash_filter.with_loader_criteria

    def counted(*args, **kwargs):
        built.append(args[0])
        return real(*args, **kwargs)

    monkeypatch.setattr(trash_filter, "with_loader_criteria", counted)
    monkeypatch.setattr(trash_filter, "_OPTIONS", (), raising=False)
    w = await world(roadmap=False)
    async with tenant_session(w["tenant"]) as s:
        for _ in range(3):
            assert await s.get(Run, w["run"]) is not None
            s.expunge_all()
    assert len(built) == len(trash_filter.criteria())
