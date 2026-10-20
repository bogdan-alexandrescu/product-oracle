"""O4 'Roadmap dates' (owner, 2026-10-19): a dated milestone rests only on a verified
basis recorded for THAT PRD (and for that item or tracker key when the basis names one);
withdrawing the basis removes the date, from the item, the track's headline and the drift
checks; a date outside Now is dropped on import with a recorded problem. Against
Postgres with the FakeRuntime."""

from sqlalchemy import select

from oracle.docs.models import Document
from oracle.roadmap.models import RoadmapItem
from oracle.swarm import Outcome
from oracle.tenancy import tenant_session
from tests.test_roadmap import (  # noqa: F401 - fixtures
    ITEMS,
    PRD,
    ROADMAP,
    ROADMAP_MD,
    approved_prd,
    built_roadmap,
    create,
    get,
    owner,
    runtime,
    start,
    tick,
)
from tests.test_tracks import track_of

URL = f"/v1/roadmaps/{ROADMAP}/items"
PUT = f"/v1/roadmaps/{ROADMAP}/versions/1/items"
DEC = "date: 2026-12-15"


async def other_prd(tenant_id) -> str:
    async with tenant_session(tenant_id) as s:
        s.add(Document(slug="billing-prd", title="Billing PRD", kind="prd", status="draft"))
        await s.commit()
    return "billing-prd"


async def record(client, auth, **body) -> dict:
    body = {"kind": "estimate", "supports_date": "2026-12-15", **body}
    resp = await client.post("/v1/schedule-bases", json=body, headers=auth)
    assert resp.status_code == 201, resp.text
    return resp.json()


def dated(source: str, day: str = "2026-12-15") -> str:
    return ITEMS.replace("date: 2026-11-30", f"date: {day}").replace("ENG-412 estimate", source)


async def test_the_eng_412_probe_is_refused(client, owner, runtime):  # noqa: F811
    """The reviewer's probe: a basis recorded for no PRD, or for another PRD, dated an
    item of any PRD's roadmap by being named in date_source."""
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    billing = await other_prd(tenant_id)

    # A basis needs its PRD.
    body = {"kind": "estimate", "reference": "ENG-412", "supports_date": "2026-12-15"}
    resp = await client.post("/v1/schedule-bases", json=body, headers=auth)
    assert resp.status_code == 422, resp.text
    # Another PRD's basis supports nothing on this roadmap.
    await record(client, auth, reference="ENG-412", prd=billing)
    resp = await client.put(PUT, json={"yaml": dated("ENG-412 estimate")}, headers=auth)
    assert resp.status_code == 422, resp.text
    assert [p["code"] for p in resp.json()["detail"]["problems"]] == ["unverified_date"]
    # Nor is it offered to this PRD's run.
    run = await start(client, auth, await create(client, auth, source=PRD, document="r2"))
    prompt = runtime.submitted[-1].steps[-1].prompt
    assert "- ENG-412 (estimate) supports 2026-11-30" in prompt
    assert "supports 2026-12-15" not in prompt, prompt
    assert run["status"] == "running"

    # A basis for this PRD but another item supports only that item.
    await record(client, auth, reference="ENG-412", prd=PRD, item_key="shipping-step")
    resp = await client.put(PUT, json={"yaml": dated("ENG-412 estimate")}, headers=auth)
    assert resp.status_code == 422
    assert [p["code"] for p in resp.json()["detail"]["problems"]] == ["unverified_date"]
    # A basis for a tracker key supports the items that tracker issue is matched to.
    track = await track_of(client, auth)
    resp = await client.post(
        "/v1/tracker/records",
        json={"tracker": "jira", "records": [
            {"external_ref": "ENG-413", "state": "todo", "track_id": track["id"],
             "item_key": "shipping-step"}]},
        headers=auth,
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    await record(client, auth, reference="CAP-1", prd=PRD, tracker_key="ENG-413")
    resp = await client.put(PUT, json={"yaml": dated("CAP-1 capacity")}, headers=auth)
    assert resp.status_code == 422
    # Recorded for this item, it holds.
    b = await record(client, auth, reference="ENG-412", prd=PRD, item_key="payment-step")
    assert b["item_key"] == "payment-step" and b["prd_document_id"]
    resp = await client.put(PUT, json={"yaml": dated("ENG-412 estimate")}, headers=auth)
    assert resp.status_code == 200, resp.text
    assert resp.json()["items"][0]["milestone"]["basis_ids"] == [b["id"]]

    # An item key and a tracker key together are refused.
    resp = await client.post(
        "/v1/schedule-bases",
        json={**body, "prd": PRD, "item_key": "a", "tracker_key": "B-1"},
        headers=auth,
    )
    assert resp.status_code == 422


async def test_withdrawal_removes_the_date_everywhere(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    track = await track_of(client, auth)
    # The tracker says payment lands after the Beta date: a date slip.
    resp = await client.post(
        "/v1/tracker/records",
        json={"tracker": "jira", "records": [
            {"external_ref": "ENG-412", "state": "in_progress", "target_date": "2026-12-20",
             "track_id": track["id"], "item_key": "payment-step"}]},
        headers=auth,
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    track = await track_of(client, auth)
    assert track["next_milestone"]["target_date"] == "2026-11-30"
    assert "(2026-11-30)" in track["headline"]
    assert "date_slip" in {d["kind"] for d in track["drift"]}

    bases = (await client.get("/v1/schedule-bases", headers=auth)).json()
    (eng,) = [b for b in bases if b["reference"] == "ENG-412"]
    resp = await client.post(
        f"/v1/schedule-bases/{eng['id']}/withdraw", json={"reason": "Re-estimated"}, headers=auth
    )
    assert resp.status_code == 200, resp.text

    pay = (await client.get(URL, headers=auth)).json()["items"][0]
    assert pay["milestone"]["date"] is None and pay["milestone"]["basis_ids"] == []
    assert pay["milestone"]["refused_date"] == "2026-11-30"
    assert pay["milestone"]["name"] == "Beta"
    track = await track_of(client, auth)
    assert track["next_milestone"]["name"] == "Beta"
    assert track["next_milestone"]["target_date"] is None
    assert track["next_milestone"]["dated"] is False
    assert "2026-11-30" not in track["headline"], track["headline"]
    assert not {d["kind"] for d in track["drift"]} & {"date_slip", "overdue"}
    report = (await client.get(f"/v1/roadmaps/{ROADMAP}/alignment", headers=auth)).json()
    by = {i["item_key"]: i for i in report["items"]}
    assert by["payment-step"]["milestone"]["date"] is None
    assert not {d["kind"] for d in by["payment-step"]["drift"]} & {"date_slip", "overdue"}
    monitored = (await client.post(f"/v1/tracks/{track['id']}/monitor", headers=auth)).json()
    assert monitored["overview"]["next_milestone"]["target_date"] is None
    # The approved record is not rewritten: the date is withheld when read.
    async with tenant_session(tenant_id) as s:
        row = await s.scalar(select(RoadmapItem).where(RoadmapItem.item_key == "payment-step"))
        assert row.milestone["date"] == "2026-11-30"


async def test_a_date_outside_now_is_dropped_on_import(client, owner, runtime):  # noqa: F811
    """With the items checkpoint on, a reviewer may approve a file with a dated Next
    item; the stored item keeps the milestone's name and records the dropped date."""
    _, auth = owner
    await approved_prd(client, auth)
    await record(client, auth, reference="ENG-413", prd=PRD, supports_date="2027-02-01")
    items = ITEMS.replace(
        "milestone: Shipping estimate up front",
        "milestone: {name: GA, date: 2027-02-01, date_source: ENG-413 estimate}",
    )
    runtime.script["roadmap_items"] = [Outcome(artifacts={"roadmap_items.yaml": items})]
    runtime.script["roadmap_draft"] = [Outcome(artifacts={"roadmap.md": ROADMAP_MD})]
    run = await start(
        client,
        auth,
        await create(client, auth, source=PRD, knobs={"checkpoints": {"roadmap_review": False}}),
    )
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    cp = next(c for c in run["checkpoints"] if c["status"] == "pending")
    assert [p["code"] for p in cp["payload"]["items_check"]["problems"]] == ["date_outside_now"]
    resp = await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/decide",
        json={"decision": "approved"},
        headers=auth,
    )
    assert resp.status_code == 200, resp.text
    await tick(client, auth)
    assert (await get(client, auth, run["id"]))["status"] == "succeeded"
    pay, ship = (await client.get(URL, headers=auth)).json()["items"]
    assert pay["milestone"]["date"] == "2026-11-30"
    assert ship["milestone"]["name"] == "GA" and ship["milestone"]["date"] is None
    assert ship["milestone"]["refused_date"] == "2027-02-01"
    assert "only in now" in ship["milestone"]["refused"]
