"""A PRD's feature may depend on a feature of another area PRD (the owner, Nov 4): every PRD
feeds ONE company roadmap, so such a link is real and survives every stop.

A Scale PRD's run has one feature, ``observability``, that depends on
``account-health-ledger``, a feature of the Safety PRD on the company roadmap. The
Engineering check reads the brief (no ``unknown_dependency``) and names the dependency with
its PRD; the PRD writer is told to keep the link; the roadmap items check lets a Scale item
depend on it and the company queue plans it after the Safety item. The feature set stop
shows it as information ("needs ... from Safety PRD"), not a blocking problem. A key on no
roadmap is still refused at both stops. Against Postgres. Invented data only.
"""

import hashlib
from datetime import UTC, datetime

import pytest
from sqlalchemy import select

import oracle.main  # noqa: F401  (registers the lanes' prompt lines)
from oracle import company_time
from oracle.baseline.models import Entity
from oracle.docs.models import Document, DocumentVersion
from oracle.engineering import check
from oracle.roadmap import company
from oracle.roadmap.models import RoadmapItem
from oracle.runs import feature_set
from oracle.runs import roadmap as items_file
from oracle.runs.models import Checkpoint, CheckpointAction, Run
from oracle.runs.scope_models import PrdScope, PrdScopeItem
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx

NOW = datetime(2026, 11, 4, 9, 0, tzinfo=UTC)

BRIEFS = """\
version: 1
code_map: {used: false, repos: []}
features:
  - feature: observability
    title: "Observability"
    approach: "Read account health from the ledger and chart it."
    touches: []
    reuse: []
    risks: []
    questions: []
    size: m
    size_why: "One dashboard"
    depends_on: [DEP]
    assumptions: ["The ledger has an API"]
"""

FEATURE_SET = """\
version: 1
document: scale
features:
  - {key: observability, title: Observability, summary: Charts of account health, goals: [],
     depends_on: [DEP], confidence: 0.8, requirements: []}
excluded:
  - {key: DEP, reason: Lives in another PRD}
"""


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


def _hash(body: str) -> str:
    return hashlib.sha256(body.encode()).hexdigest()


async def _add(s, row):
    s.add(row)
    await s.flush()
    return row


async def _prd(s, slug: str, title: str) -> tuple[Document, DocumentVersion]:
    doc = await _add(s, Document(slug=slug, title=title, kind="prd", status="approved",
                                 visibility="company"))  # fmt: skip
    body = f"# {title}"
    v = await _add(s, DocumentVersion(document_id=doc.id, number=1, markdown=body,
                                      content_hash=_hash(body), approved_at=NOW))  # fmt: skip
    return doc, v


async def _scope(s, run: Run, doc: Document, features, excluded=()) -> PrdScope:
    scope = await _add(s, PrdScope(run_id=run.id, segment_seq=2, attempt=1, status="approved",
                                   document_id=doc.id, check_result={},
                                   approved_at=NOW))  # fmt: skip
    for i, (key, title, deps) in enumerate(features):
        s.add(PrdScopeItem(scope_id=scope.id, kind="feature", key=key, title=title,
                           depends_on=list(deps), decision="include", position=i))  # fmt: skip
    for i, (key, title) in enumerate(excluded):
        s.add(PrdScopeItem(scope_id=scope.id, kind="feature", key=key, title=title,
                           decision="exclude", decision_reason="Elsewhere",
                           position=100 + i))  # fmt: skip
    await s.flush()
    return scope


async def world(*, roadmap: bool = True) -> dict:
    """The Safety PRD's approved scope holds account-health-ledger, and the company roadmap's
    version 1 its item; the Scale PRD's run's approved scope holds observability, which
    depends on it."""
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        for key, title in (("observability", "Observability"),
                           ("account-health-ledger", "Account health ledger"),
                           ("export-logs", "Export logs")):  # fmt: skip
            s.add(Entity(type="feature", key=key, title=title, status="confirmed", origin="user"))
        safety, sv = await _prd(s, "safety", "Safety")
        scale, _ = await _prd(s, "scale", "Scale")
        other = await _add(s, Run(flow="baseline_to_prd", status="succeeded",
                                  document_id=safety.id))  # fmt: skip
        await _scope(s, other, safety, [("account-health-ledger", "Account health ledger", [])])
        run = await _add(s, Run(flow="baseline_to_prd", status="running", document_id=scale.id))
        await _scope(s, run, scale, [("observability", "Observability", ["account-health-ledger"])])
        if roadmap:
            rm = await _add(s, Document(slug=company.SLUG, title=company.TITLE, kind="roadmap",
                                        status="draft", visibility="company",
                                        company_roadmap=True))  # fmt: skip
            v1 = await _add(s, DocumentVersion(document_id=rm.id, number=1, markdown="# R",
                                               content_hash=_hash("# R")))  # fmt: skip
            s.add(RoadmapItem(roadmap_document_id=rm.id, roadmap_version_id=v1.id,
                              item_key="account-health-ledger", title="Account health ledger",
                              horizon="next", position=0, prd_document_id=safety.id,
                              prd_version_id=sv.id))  # fmt: skip
        await s.commit()
        return {"tenant": ctx.tenant_id, "run": run.id, "scale": scale.id, "safety": safety.id}


async def _summary(w: dict, dep: str = "account-health-ledger") -> dict:
    async with tenant_session(w["tenant"]) as s:
        run = await s.get(Run, w["run"])
        return await check.check_segment(s, run, BRIEFS.replace("DEP", dep))


async def test_a_cross_prd_dependency_passes_the_engineering_check_named_with_its_prd():
    # protects=a brief depending on another PRD's feature on the company roadmap is read,
    # not refused, and names it with its PRD; fails_when=unknown_dependency refuses the file.
    w = await world()
    summary = await _summary(w)
    assert summary["problems"] == []
    assert [f["key"] for f in summary["features"]] == ["observability"]
    assert summary["features"][0]["depends_on"] == ["account-health-ledger"]
    assert summary["elsewhere"] == {"account-health-ledger": "Account health ledger (Safety PRD)"}


async def test_a_dependency_on_a_key_no_roadmap_knows_is_still_refused():
    # protects=only real links pass; fails_when=any key passes the check.
    w = await world()
    summary = await _summary(w, "made-up-feature")
    assert [p["code"] for p in summary["problems"]] == ["unknown_dependency"]
    assert summary["elsewhere"] == {}
    # With no company roadmap, a key Ground Truth does not know is refused too.
    bare = await world(roadmap=False)
    assert [p["code"] for p in (await _summary(bare, "made-up-feature"))["problems"]] == [
        "unknown_dependency"
    ]


async def test_a_dependency_waived_at_the_feature_set_stop_passes_the_engineering_check():
    # protects=a dependency waived at this run's feature set stop is accepted; fails_when=
    # a waived dependency still refuses the briefs.
    w = await world(roadmap=False)
    async with tenant_session(w["tenant"]) as s:
        scope = await feature_set.approved_scope(s, run_id=w["run"])
        await _add(s, PrdScopeItem(scope_id=scope.id, kind="feature", key="export-logs",
                                   title="Export logs", decision="exclude",
                                   position=50))  # fmt: skip
        row = await s.scalar(
            select(PrdScopeItem).where(
                PrdScopeItem.scope_id == scope.id, PrdScopeItem.key == "observability"
            )
        )
        row.depends_on = ["export-logs"]
        cp = await _add(s, Checkpoint(run_id=w["run"], kind="feature_set", status="approved"))
        scope.checkpoint_id = cp.id
        s.add(CheckpointAction(checkpoint_id=cp.id, item_key="observability", kind="waive",
                               answers=["depends_on_excluded"], state="staged"))  # fmt: skip
        await s.commit()
    summary = await _summary(w, "export-logs")
    assert summary["problems"] == []
    assert summary["elsewhere"] == {"export-logs": "Export logs"}


async def test_the_prd_draft_and_its_plan_keep_the_link():
    # protects=the PRD writer is told to keep the dependency named with its PRD, the items
    # check lets a Scale item depend on the Safety item and the company queue plans it after;
    # fails_when=the link is dropped on the way to the roadmap.
    w = await world()
    summary = await _summary(w)
    async with tenant_session(w["tenant"]) as s:
        s.add(Checkpoint(run_id=w["run"], kind=check.KIND, status="approved", decided_at=NOW,
                         payload={check.PAYLOAD_KEY: summary,
                                  "briefs": {"sizes": {"observability": "m"},
                                             "verdicts": {}, "answers": {}}}))  # fmt: skip
        await s.commit()
        lines = await check.prompt_lines(s, w["run"], "prd_draft")
        assert (
            "- observability (Observability) depends on account-health-ledger: "
            "Account health ledger (Safety PRD)"
        ) in lines
        elsewhere = await company.keys_of_other_prds(s, w["scale"])
        assert "account-health-ledger" in elsewhere
        assert "account-health-ledger" not in await company.keys_of_other_prds(s, w["safety"])

    items = (
        "version: 1\nprd: {document: scale, version: 1}\nitems:\n"
        "  - {id: observability, title: Observability, outcome: Health is charted,\n"
        "     horizon: now, depends_on: [account-health-ledger]}\n"
    )
    checked = items_file.check_items(items, prd_slug="scale", prd_version=1, elsewhere=elsewhere)
    assert "unknown_dependency" not in [p["code"] for p in checked.problems]
    assert checked.items[0]["depends_on"] == ["account-health-ledger"]
    unknown = items_file.check_items(items.replace("account-health-ledger", "made-up"),
                                     prd_slug="scale", prd_version=1,
                                     elsewhere=elsewhere)  # fmt: skip
    assert "unknown_dependency" in [p["code"] for p in unknown.problems]

    # On the company roadmap the Scale item (Now) waits for the Safety item (Next).
    async with tenant_session(w["tenant"]) as s:
        rm = await company.active(s)
        version = await s.scalar(
            select(DocumentVersion).where(DocumentVersion.document_id == rm.id)
        )
        s.add(RoadmapItem(roadmap_document_id=rm.id, roadmap_version_id=version.id,
                          item_key="observability", title="Observability", horizon="now",
                          position=1, prd_document_id=w["scale"],
                          depends_on=["account-health-ledger"]))  # fmt: skip
        await s.commit()
        _, queued = await company.queue(s)
        assert [q.item.item_key for q in queued] == ["account-health-ledger", "observability"]


async def test_the_feature_set_stop_shows_another_prd_s_feature_as_information():
    # protects=a dependency on a feature another PRD on the company roadmap holds is not a
    # blocking problem and reads "needs X from <PRD>"; fails_when=it asks for a waiver.
    w = await world()
    async with tenant_session(w["tenant"]) as s:
        known = await feature_set.known_for_run(s, w["run"])
    text = FEATURE_SET.replace("DEP", "account-health-ledger")
    out = feature_set.check_feature_set(text, document="scale", known=known)
    assert [(p["code"], p["blocking"], p["message"]) for p in out.problems] == [
        ("needs_other_prd", False, "observability needs Account health ledger from Safety PRD")
    ]
    assert out.blocking == 0
    # On no roadmap at all: still blocking.
    out = feature_set.check_feature_set(
        FEATURE_SET.replace("DEP", "export-logs"), document="scale", known=known
    )
    assert [(p["code"], p["blocking"]) for p in out.problems] == [("depends_on_excluded", True)]


def test_the_scope_review_row_reads_needs_x_from_its_prd_and_does_not_block():
    # protects=the feature set stop's row says what is needed and from which PRD, and asks
    # for no waiver; fails_when=it reads as a blocking problem or shows the raw key.
    from oracle.runs import scope_review

    problem = {
        "code": "needs_other_prd",
        "blocking": False,
        "feature": "observability",
        "requirement": None,
        "message": "observability needs Account health ledger from Safety PRD",
    }
    scope = PrdScope(check_result={"problems": [problem]})
    (reason,) = scope_review.reasons_of(scope, [], [])["observability"]
    assert reason.label == "Needs Account health ledger from Safety PRD"
    assert reason.severity == "to_confirm"
    assert reason.waivable is False


# --------------------------------------------------------------------------- review round 1


async def test_a_run_already_waiting_at_the_engineering_check_is_read_again():
    # protects=a run stopped at the Engineering check before cross-PRD links were accepted
    # shows its briefs and may be approved once the stop is read, with no rerun;
    # fails_when=the stored check is read as it was stored ("could not be read").
    from oracle.runs import gate, service
    from oracle.runs.models import RunSegment

    w = await world()
    text = BRIEFS.replace("DEP", "account-health-ledger")
    async with tenant_session(w["tenant"]) as s:
        # The stored check of the old rules: the dependency refused as unknown.
        old = check._summarize(text, frozenset({"observability"}), None)
        assert [p["code"] for p in old["problems"]] == ["unknown_dependency"]
        s.add(RunSegment(run_id=w["run"], seq=3, name="eng_review", status="succeeded",
                         artifacts={"files": {check.briefs.FILE: text}}))  # fmt: skip
        cp = await _add(s, Checkpoint(run_id=w["run"], kind=check.KIND, status="pending",
                                      payload={"segment_seq": 3, check.PAYLOAD_KEY: old}))  # fmt: skip
        await s.commit()
        cp_id = cp.id
    async with tenant_session(w["tenant"]) as s:
        out = await service.read_run(s, w["run"], None)
    shown = next(c for c in out.checkpoints if c.id == cp_id)
    assert shown.payload[check.PAYLOAD_KEY]["problems"] == []
    async with tenant_session(w["tenant"]) as s:
        cp = await s.get(Checkpoint, cp_id)
        stored = cp.payload[check.PAYLOAD_KEY]
        assert stored["problems"] == []
        assert [f["key"] for f in stored["features"]] == ["observability"]
        assert stored["elsewhere"] == {
            "account-health-ledger": "Account health ledger (Safety PRD)"
        }
        verdict = CheckpointAction(checkpoint_id=cp.id, item_key="observability", kind="edit",
                                   field="verdict", state="staged",
                                   value={"verdict": "feasible"})  # fmt: skip
        g = gate.approve_gate(cp, None, [verdict])
        assert g is not None and g.file_problems == 0 and g.open


async def _two_prds_on_the_roadmap(scale_items=(), safety_deps=("observability",)) -> dict:
    """world(), with the Safety item waiting on the Scale PRD's ``observability`` (a cycle
    when Scale's observability also waits on the ledger)."""
    w = await world()
    async with tenant_session(w["tenant"]) as s:
        item = await s.scalar(
            select(RoadmapItem).where(RoadmapItem.item_key == "account-health-ledger")
        )
        item.depends_on = list(safety_deps)
        for row in scale_items:
            s.add(row(item))
        await s.commit()
    return w


ITEMS = (
    "version: 1\nprd: {document: scale, version: 1}\nitems:\n"
    "  - {id: observability, title: Observability, outcome: Health is charted,\n"
    "     horizon: HORIZON, depends_on: [DEP]}\n"
)


async def _items_check(w: dict, horizon: str = "now", dep: str = "account-health-ledger"):
    async with tenant_session(w["tenant"]) as s:
        others = await company.other_prds(s, w["scale"])
    return items_file.check_items(
        ITEMS.replace("HORIZON", horizon).replace("DEP", dep),
        prd_slug="scale",
        prd_version=1,
        prd_name="Scale PRD",
        elsewhere=others,
    )


async def test_a_cycle_across_two_prds_is_reported_naming_both_features_and_prds():
    # protects=a cycle through another PRD's feature is a problem named in plain words;
    # fails_when=the cross-PRD link skips the cycle check and the queue keeps any order.
    w = await _two_prds_on_the_roadmap()
    checked = await _items_check(w, "next")
    cycles = [p for p in checked.problems if p["code"] == "dependency_cycle"]
    assert [p["message"] for p in cycles] == [
        "Observability (Scale PRD) and Account health ledger (Safety PRD) wait on each other"
    ]
    # No cycle when the Safety item waits on nothing.
    w = await _two_prds_on_the_roadmap(safety_deps=())
    assert "dependency_cycle" not in [p["code"] for p in (await _items_check(w, "next")).problems]


async def test_a_cross_prd_dependency_in_a_later_horizon_is_reported():
    # protects=an item in Now waiting on another PRD's item in Next is told plainly;
    # fails_when=the cross-PRD link skips the horizon check.
    w = await _two_prds_on_the_roadmap(safety_deps=())
    checked = await _items_check(w, "now")
    assert [p["message"] for p in checked.problems if p["code"] == "horizon_breaks_dependency"] == [
        "Observability is in Now but waits on Account health ledger (Safety PRD) in Next"
    ]
    later = await _items_check(w, "later")
    assert "horizon_breaks_dependency" not in [p["code"] for p in later.problems]


async def _ledger_by_feature_key(w: dict) -> None:
    """The Safety item is keyed ``ahl-1`` and linked to the account-health-ledger feature;
    the Scale item ``observability`` (Now) depends on the feature's key, listed first."""
    async with tenant_session(w["tenant"]) as s:
        ledger = await s.scalar(select(Entity).where(Entity.key == "account-health-ledger"))
        item = await s.scalar(
            select(RoadmapItem).where(RoadmapItem.item_key == "account-health-ledger")
        )
        item.item_key = "ahl-1"
        item.feature_id = ledger.id
        item.position = 5
        s.add(RoadmapItem(roadmap_document_id=item.roadmap_document_id,
                          roadmap_version_id=item.roadmap_version_id, item_key="observability",
                          title="Observability", horizon="now", position=0,
                          prd_document_id=w["scale"],
                          depends_on=["account-health-ledger"]))  # fmt: skip
        await s.commit()


async def test_a_dependency_on_a_feature_key_orders_the_queue_by_its_items():
    # protects=a dependency named by another PRD's feature key (accepted by the checks)
    # orders the company queue by that feature's items; fails_when=it is matched by item key
    # only and silently dropped.
    w = await world()
    await _ledger_by_feature_key(w)
    async with tenant_session(w["tenant"]) as s:
        _, queued = await company.queue(s)
    assert [q.item.item_key for q in queued] == ["ahl-1", "observability"]


async def test_the_simple_panel_shows_a_dependency_named_by_a_feature_key():
    # protects=the feature panel's depends on / needed by hold the other PRD's item when the
    # dependency names its feature; fails_when=the link is matched by item key only.
    from oracle.simple import service as simple

    w = await world()
    await _ledger_by_feature_key(w)
    async with tenant_session(w["tenant"]) as s:
        read = await simple.load(s)
    by_key = {e.row.item_key: e for e in read.entries}
    assert by_key["observability"].depends_on == [by_key["ahl-1"].row.id]
    assert by_key["ahl-1"].needed_by == [by_key["observability"].row.id]


async def test_a_confirmed_ground_truth_feature_passes_both_stops():
    # protects=the four area PRDs, none on the company roadmap yet, may depend on each
    # other's confirmed features at the Engineering check, as at the feature set stop;
    # fails_when=the feature set passes and the Engineering check refuses the briefs.
    w = await world(roadmap=False)
    async with tenant_session(w["tenant"]) as s:
        known = await feature_set.known_for_run(s, w["run"])
    out = feature_set.check_feature_set(
        FEATURE_SET.replace("DEP", "export-logs").replace("excluded:\n  - {key: export-logs, "
                                                          "reason: Lives in another PRD}\n", ""),
        document="scale",
        known=known,
    )  # fmt: skip
    assert out.blocking == 0
    summary = await _summary(w, "export-logs")
    assert summary["problems"] == []
    assert summary["elsewhere"] == {"export-logs": "Export logs"}
