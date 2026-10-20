"""CR-11 roadmap items (§11.4, §16 item 18): a prd_to_roadmap run's items are stored
with the roadmap version, traced to the exact approved PRD version, section, feature and
requirements; with blocker dependencies, validation gates and economics; dates only with
a verified basis; brief and full views; manual import; carried forward by the feedback
loop. Against Postgres with the FakeRuntime."""

from datetime import date

from sqlalchemy import select

from oracle.docs.models import Document, DocumentVersion
from oracle.roadmap.models import ProductTrack, RoadmapItem
from oracle.swarm import Outcome
from oracle.tenancy import tenant_session
from tests.roadmap_helpers import basis, other_company, seed_trace
from tests.test_roadmap import (  # noqa: F401 - fixtures
    ITEMS,
    PRD,
    ROADMAP,
    ROADMAP_MD,
    approved_prd,
    as_user,
    built_roadmap,
    create,
    get,
    owner,
    runtime,
    seed_baseline,
    start,
    tick,
)

URL = f"/v1/roadmaps/{ROADMAP}/items"


async def test_run_items_are_traced_to_the_approved_prd(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    ids = await seed_trace(tenant_id)
    await built_roadmap(client, auth, runtime)

    out = (await client.get(URL, headers=auth)).json()
    assert out["roadmap"]["slug"] == ROADMAP and out["roadmap"]["version"] == 1
    assert out["source"]["slug"] == PRD and out["source"]["version"] == 1
    assert out["source"]["approved"] is True
    assert out["view"] == "full" and out["track_id"]
    pay, ship = out["items"]
    assert [pay["item_key"], ship["item_key"]] == ["payment-step", "shipping-step"]
    assert pay["horizon"] == "now" and ship["horizon"] == "next"
    assert pay["freshness"] == "fresh"
    # The exact PRD version and section, at its hash, with a link that opens it.
    assert pay["prd"]["document"]["slug"] == PRD and pay["prd"]["document"]["version"] == 1
    assert pay["prd"]["section_key"] == "s-5-1" and pay["prd"]["section_hash"]
    assert pay["prd"]["link"] == f"/documents/{PRD}/v/1#s-5-1"
    # Feature (by key), requirement (part_of), blocker (affects), with how each was made.
    assert pay["feature"]["id"] == str(ids["feature"])
    assert [r["id"] for r in pay["requirements"]] == [str(ids["requirement"])]
    assert {(t["target"], t["via"]) for t in pay["trace"]} == {
        ("feature", "key_match"),
        ("requirement", "graph"),
        ("blocker", "graph"),
    }
    (blk,) = pay["blockers"]
    assert blk["id"] == str(ids["blocker"]) and blk["blocker_status"] == "open"
    assert blk["critical"] is True and blk["resolved"] is False
    # Validation gates: the requirement's acceptance criterion, the blocker's experiment.
    kinds = {g["kind"]: g for g in pay["validation_gates"]}
    assert kinds["acceptance_criterion"]["entity_id"] == str(ids["criterion"])
    assert kinds["feasibility_experiment"]["criterion"] == "p99 under 300 ms at 5x load"
    # Economics: the feature's effort and confidence, the priority score.
    assert pay["economics"]["baseline"] == {"effort": 2, "confidence": 0.8}
    assert pay["economics"]["priority_score"] == 4.2
    # The date rests on the verified ENG-412 estimate.
    assert pay["milestone"]["date"] == "2026-11-30"
    assert len(pay["milestone"]["basis_ids"]) == 1
    assert ship["depends_on"] == ["payment-step"] and ship["blockers"] == []

    brief = (await client.get(URL, params={"view": "brief"}, headers=auth)).json()
    assert brief["view"] == "brief"
    assert brief["items"][0]["requirements"] == [] and brief["items"][0]["trace"] == []
    assert brief["items"][0]["prd"]["section_key"] == "s-5-1"

    # The accepted PRD started its track, which follows this roadmap.
    async with tenant_session(tenant_id) as s:
        track = await s.scalar(select(ProductTrack))
        assert str(track.id) == out["track_id"]
        roadmap = await s.scalar(select(Document).where(Document.slug == ROADMAP))
        assert track.roadmap_document_id == roadmap.id


async def test_declared_and_section_linked_trace(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    await approved_prd(client, auth, approve=False)
    await seed_baseline(tenant_id)
    ids = await seed_trace(tenant_id)
    # The PRD's shipping section implements the saved-cards requirement (a trace link).
    resp = await client.post(
        f"/v1/documents/{PRD}/versions/1/section-links",
        json={"links": [{"section_key": "s-5-2", "kind": "implements",
                         "entity_id": str(ids["requirement"])}]},
        headers=auth,
    )  # fmt: skip
    assert resp.status_code in (200, 201), resp.text
    resp = await client.post(f"/v1/documents/{PRD}/versions/1/approve", headers=auth)
    assert resp.status_code == 200, resp.text
    items = ITEMS.replace(
        "    prd_section: s-5-2\n",
        "    prd_section: s-5-2\n    feature: shipping-step\n    blockers: [psp-rate-limit, nope]\n"
        "    validation_gates: [{name: Pilot, criterion: 3 shops ship}]\n"
        "    economics: {value: fewer drop-offs, cost: 2 sprints}\n",
    )
    runtime.script["roadmap_items"] = [Outcome(artifacts={"roadmap_items.yaml": items})]
    runtime.script["roadmap_draft"] = [Outcome(artifacts={"roadmap.md": ROADMAP_MD})]
    off = {"roadmap_items": False, "roadmap_review": False}
    run = await start(
        client, auth, await create(client, auth, source=PRD, knobs={"checkpoints": off})
    )
    await tick(client, auth)
    await tick(client, auth)
    assert (await get(client, auth, run["id"]))["status"] == "succeeded"

    ship = (await client.get(URL, headers=auth)).json()["items"][1]
    vias = {(t["target"], t.get("via"), t["key"], t["unresolved"]) for t in ship["trace"]}
    assert ("feature", "declared", "shipping-step", False) in vias
    assert ("blocker", "declared", "psp-rate-limit", False) in vias
    assert ("blocker", None, "nope", True) in vias
    assert ("requirement", "section_link", "saved-cards", False) in vias
    assert ship["validation_gates"][0] == {"kind": "declared", "name": "Pilot",
                                           "criterion": "3 shops ship"}  # fmt: skip
    assert ship["economics"]["declared"] == {"value": "fewer drop-offs", "cost": "2 sprints"}


async def test_a_manual_import_refuses_unverified_dates_and_pins_approved_versions(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
):
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    put = f"/v1/roadmaps/{ROADMAP}/versions/1/items"

    # Never an invented date: no verified basis supports 2026-12-15.
    guess = ITEMS.replace("date: 2026-11-30", "date: 2026-12-15")
    resp = await client.put(put, json={"yaml": guess}, headers=auth)
    assert resp.status_code == 422, resp.text
    assert [p["code"] for p in resp.json()["detail"]["problems"]] == ["unverified_date"]
    # Nothing replaced.
    assert (await client.get(URL, headers=auth)).json()["items"][0]["milestone"]["date"] == (
        "2026-11-30"
    )

    # A capacity plan verified for that date makes it acceptable.
    await basis(tenant_id, "CAP-Q4", date(2026, 12, 15), kind="capacity")
    ok = guess.replace("ENG-412 estimate", "CAP-Q4 capacity plan")
    resp = await client.put(put, json={"yaml": ok}, headers=auth)
    assert resp.status_code == 200, resp.text
    assert resp.json()["items"][0]["milestone"]["date"] == "2026-12-15"
    assert resp.json()["problems"] == [] and resp.json()["refused_dates"] == []

    # Horizons only: no date needed.
    undated = ITEMS.replace(
        "milestone: {name: Beta, date: 2026-11-30, date_source: ENG-412 estimate}",
        "milestone: Beta",
    )
    resp = await client.put(put, json={"yaml": undated}, headers=auth)
    assert resp.status_code == 200 and resp.json()["items"][0]["milestone"] == {"name": "Beta"}

    # An approved version's items are pinned.
    assert (
        await client.post(f"/v1/documents/{ROADMAP}/versions/1/approve", headers=auth)
    ).status_code == 200
    resp = await client.put(put, json={"yaml": ITEMS}, headers=auth)
    assert resp.status_code == 409

    # Roles: a commenter reads but cannot import.
    commenter = await as_user(tenant_id, "commenter")
    assert (await client.get(URL, headers=commenter)).status_code == 200
    assert (await client.put(put, json={"yaml": ITEMS}, headers=commenter)).status_code == 403


async def test_a_run_never_stores_an_unverified_date(client, owner, runtime):  # noqa: F811
    """With the items checkpoint on, a reviewer may approve a file with problems; the
    stored item keeps the milestone's name and records the refused date, never the date."""
    tenant_id, auth = owner
    await approved_prd(client, auth)
    guess = ITEMS.replace("date_source: ENG-412 estimate", "date_source: a hunch")
    runtime.script["roadmap_items"] = [Outcome(artifacts={"roadmap_items.yaml": guess})]
    runtime.script["roadmap_draft"] = [Outcome(artifacts={"roadmap.md": ROADMAP_MD})]
    run = await start(
        client,
        auth,
        await create(client, auth, source=PRD, knobs={"checkpoints": {"roadmap_review": False}}),
    )
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    cp = next(c for c in run["checkpoints"] if c["status"] == "pending")
    await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/decide",
        json={"decision": "approved"},
        headers=auth,
    )
    await tick(client, auth)
    assert (await get(client, auth, run["id"]))["status"] == "succeeded"
    pay = (await client.get(URL, headers=auth)).json()["items"][0]
    assert pay["milestone"]["name"] == "Beta" and pay["milestone"]["date"] is None
    assert pay["milestone"]["refused_date"] == "2026-11-30"
    assert "never invents dates" in pay["milestone"]["refused"]


async def test_the_feedback_loop_carries_items_forward(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    # A person pushes version 2 that drops the shipping step.
    text = (
        ROADMAP_MD.split("## Next {#next}")[0].replace(
            "| [Next](#next) | [Shipping step](#next-shipping-step) "
            "| Fewer buyers drop off at shipping |\n",
            "",
        )
        + "## Later {#later}\n\n## Sources and data points {#sources}\n\n- none\n"
    )
    resp = await client.post(
        f"/v1/documents/{ROADMAP}/versions", content=text.encode(),
        headers={**auth, "Content-Type": "text/markdown"},
    )  # fmt: skip
    assert resp.status_code in (200, 201), resp.text
    out = (await client.get(URL, headers=auth)).json()
    assert out["roadmap"]["version"] == 2
    assert [i["item_key"] for i in out["items"]] == ["payment-step"]
    assert out["items"][0]["note"] == "carried from version 1"
    # Version 1 keeps both.
    v1 = (await client.get(URL, params={"version": 1}, headers=auth)).json()
    assert len(v1["items"]) == 2
    async with tenant_session(tenant_id) as s:
        assert len((await s.scalars(select(RoadmapItem))).all()) == 3
        assert len((await s.scalars(select(DocumentVersion))).all()) == 3  # PRD v1, roadmap v1-2


async def test_items_routes_are_company_scoped(client, owner, runtime):  # noqa: F811
    _, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    other = await other_company()
    assert (await client.get(URL, headers=other)).status_code == 404
    assert (await client.get(f"/v1/roadmaps/{ROADMAP}/alignment", headers=other)).status_code == 404
    resp = await client.put(
        f"/v1/roadmaps/{ROADMAP}/versions/1/items", json={"yaml": ITEMS}, headers=other
    )
    assert resp.status_code == 404
    resp = await client.post(
        f"/v1/roadmaps/{ROADMAP}/items/staleness", json={"action": "review"}, headers=other
    )
    assert resp.status_code == 404
    # A PRD is not a roadmap.
    assert (await client.get(f"/v1/roadmaps/{PRD}/items", headers=auth)).status_code == 422
