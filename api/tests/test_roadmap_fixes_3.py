"""Roadmap review fixes, round 3 (PR #76 review).

1. Agent output never stalls the API: roadmap_items.yaml is read by a bounded loader
   (plain decimal numbers only, capped scalar length and nesting depth, every failure
   a refusal), parsed in a worker thread with a time cap, and a bad file is a failed
   check, never a tick exception.
4. Minors: NaN/Infinity refused; exact reference tokens; a tracker basis's milestones
   re-checked on re-match; create_schedule_basis checks the PRD of a track-less tracker
   record; PATCH owner_id refuses disabled members.
"""

import asyncio
import time
import uuid
from datetime import UTC, date, datetime

import pytest
from sqlalchemy import select

from oracle import safe_yaml
from oracle.auth.models import User
from oracle.auth.service import create_user
from oracle.roadmap.schedule import Basis, supporting
from oracle.runs import roadmap as items_file
from oracle.runs.models import RunSegment
from oracle.runs.roadmap import check_items
from oracle.runtokens import RunToken
from oracle.swarm import Outcome
from oracle.tenancy import tenant_session
from tests.test_roadmap import (  # noqa: F401 - fixtures
    ITEMS,
    PRD,
    ROADMAP_MD,
    approved_prd,
    built_roadmap,
    create,
    get,
    owner,  # noqa: F811
    runtime,
    start,
    tick,
)
from tests.test_roadmap_dates import other_prd
from tests.test_tracks import track_of


async def disable_member(tenant_id, user_id, monkeypatch) -> None:
    """Disable a member: ``users.disabled_at`` once PR #69's member disable is merged;
    until then a stand-in attribute on the model, read the same way."""
    if "disabled_at" in User.__table__.c:
        async with tenant_session(tenant_id) as s:
            user = await s.get(User, user_id)
            user.disabled_at = datetime.now(UTC)
            await s.commit()
        return
    monkeypatch.setattr(
        User,
        "disabled_at",
        property(lambda self: datetime.now(UTC) if self.id == user_id else None),
        raising=False,
    )


def _in_economics(value: str) -> str:
    """ITEMS with ``value`` as the payment step's declared effort."""
    return ITEMS.replace(
        "    prd_section: s-5-1\n",
        f"    prd_section: s-5-1\n    economics: {{effort: {value}}}\n",
        1,
    )


def base60(size: int) -> str:
    """One YAML 1.1 base-60 integer scalar of about ``size`` bytes."""
    return "1" + ":1" * (size // 2)


# YAML 1.1 sexagesimal int: quadratic for yaml.safe_load (3 s at 160 KB); oracle.safe_yaml
# reads it as a string, at once (main's PR #94 semantics).
BASE60 = _in_economics(base60(160_000))
PROBES = {
    # Python refuses int() of more than 4,300 digits: ValueError at once.
    "long_decimal": _in_economics("9" * 5_000),
    # ~400 levels of nesting: RecursionError in the composer, under 1 KB.
    "deep_sequence": _in_economics("[" * 400 + "]" * 400),
    "deep_mapping": _in_economics("{a: " * 400 + "1" + "}" * 400),
}


@pytest.mark.timing
@pytest.mark.parametrize("name", sorted(PROBES))
def test_each_probe_is_a_problem_in_under_100_ms(name):
    text = PROBES[name]
    started = time.monotonic()
    out = check_items(text)
    elapsed = time.monotonic() - started
    assert out.problems and out.items == [], out.problems
    assert elapsed < 0.1, f"{name}: {elapsed:.3f} s"


@pytest.mark.parametrize("name", sorted(PROBES))
def test_the_loader_raises_only_its_refusal(name):
    with pytest.raises(items_file.ItemsYamlError):
        items_file.load_items_yaml(PROBES[name])


@pytest.mark.timing
def test_a_base60_value_is_a_string_read_at_once():
    started = time.monotonic()
    data = items_file.load_items_yaml(BASE60)
    assert time.monotonic() - started < 0.1
    assert isinstance(data["items"][0]["economics"]["effort"], str)


@pytest.mark.timing
def test_the_one_megabyte_base60_scalar_is_refused_at_once():
    text = _in_economics(base60(1_000_000))
    started = time.monotonic()
    out = check_items(text)
    assert time.monotonic() - started < 0.1
    assert [p["code"] for p in out.problems] == ["too_large"]


def test_only_plain_decimal_numbers_are_numbers():
    data = items_file.load_items_yaml(
        "a: 1:30\nb: 0x1F\nc: 0o17\nd: 1_000\ne: 12\nf: -3.5\ng: 1e3\nj: 1.5e+3\n"
        "h: 2026-11-30\ni: true\n"
    )
    assert data["a"] == "1:30" and data["b"] == "0x1F" and data["c"] == "0o17"
    assert data["d"] == "1_000"
    assert data["e"] == 12 and data["f"] == -3.5 and data["g"] == "1e3"
    assert data["j"] == 1500.0
    assert str(data["h"]) == "2026-11-30" and data["i"] is True


def test_explicit_tags_are_refused():
    tagged = ("!!int 1:1:1", "!!float 1e3", "!!binary aGk=", "!!python/name:os.system ''", "!x y")
    for value in tagged:
        out = check_items(_in_economics(value))
        assert [p["code"] for p in out.problems] == ["yaml_tag"], value


def test_an_over_long_value_is_refused(monkeypatch):
    monkeypatch.setattr(safe_yaml, "MAX_SCALAR_CHARS", 50)
    out = check_items(_in_economics('"' + "x " * 40 + '"'))
    assert [p["code"] for p in out.problems] == ["too_large"]


@pytest.mark.timing
def test_the_parse_runs_in_a_worker_thread_with_a_time_cap(monkeypatch):
    def slow(text, **kw):
        time.sleep(1)
        return items_file.ItemsCheck()

    monkeypatch.setattr(items_file, "check_items", slow)
    monkeypatch.setattr(items_file, "PARSE_SECONDS", 0.05)

    async def go():
        # The event loop keeps running while the parse is busy.
        beats = 0

        async def beat():
            nonlocal beats
            while True:
                await asyncio.sleep(0.01)
                beats += 1

        task = asyncio.create_task(beat())
        started = time.monotonic()
        out = await items_file.check_items_async(ITEMS)
        elapsed = time.monotonic() - started
        task.cancel()
        return out, elapsed, beats

    out, elapsed, beats = asyncio.run(go())
    assert [p["code"] for p in out.problems] == ["too_slow"]
    assert elapsed < 0.5 and beats >= 2


def test_any_other_failure_of_the_check_is_a_problem(monkeypatch):
    def boom(text):
        raise MemoryError("out of memory")

    monkeypatch.setattr(items_file, "_parse", boom)
    assert [p["code"] for p in check_items(ITEMS).problems] == ["unreadable_yaml"]


@pytest.mark.timing
@pytest.mark.parametrize("probe", ["long_decimal", "deep_sequence", "deep_mapping"])
async def test_the_tick_completes_and_revokes_the_token(client, owner, runtime, probe):  # noqa: F811
    tenant_id, auth = owner
    await approved_prd(client, auth)
    runtime.script["roadmap_items"] = [Outcome(artifacts={"roadmap_items.yaml": PROBES[probe]})]
    runtime.script["roadmap_draft"] = [Outcome(artifacts={"roadmap.md": ROADMAP_MD})]
    run = await start(
        client, auth,
        await create(client, auth, source=PRD, knobs={"checkpoints": {"roadmap_items": False}}),
    )  # fmt: skip
    started = time.monotonic()
    await tick(client, auth)  # asserts the tick reported no errors
    assert time.monotonic() - started < 2
    run = await get(client, auth, run["id"])
    # Checkpoint off: the bad file fails the run (a failed check, not a tick exception).
    assert run["status"] == "failed", run
    assert "roadmap_items.yaml was rejected" in run["error"]
    async with tenant_session(tenant_id) as s:
        tokens = list(await s.scalars(select(RunToken)))
        segment = await s.scalar(select(RunSegment).where(RunSegment.name == "roadmap_items"))
    assert tokens and all(t.revoked_at is not None for t in tokens)
    assert segment.status == "succeeded"
    assert segment.artifacts["items_check"]["problems"]


# --------------------------------------------------------------------------- 4. minors


@pytest.mark.parametrize(
    "change",
    [
        ("confidence: high", "confidence: .nan"),
        ("score: 4.2", "score: .inf"),
        ("score: 4.2", "score: -.Inf"),
        ("score: 4.2", "score: 1.0e+999"),
    ],
)
def test_nan_and_infinity_are_refused(change):
    out = check_items(ITEMS.replace(*change, 1))
    assert [p["code"] for p in out.problems] == ["non_finite_number"], out.problems
    assert out.items == []


async def test_a_run_s_items_file_is_parsed_once_per_step(client, owner, runtime, monkeypatch):  # noqa: F811
    """The checkpoint's check parses it once; the roadmap version's import, with the same
    PRD version, sections and bases, reuses that check (oracle.runs.roadmap._Checks): no
    second parse at the import and no third in on_roadmap_version."""
    _, auth = owner
    await approved_prd(client, auth)
    real, calls = items_file.load_items_yaml, []

    def counted(text):
        calls.append(len(text))
        return real(text)

    monkeypatch.setattr(items_file, "load_items_yaml", counted)
    await built_roadmap(client, auth, runtime)
    assert calls == [len(ITEMS)], calls


def test_a_reference_matches_only_as_an_exact_token():
    day = date(2026, 11, 30)
    basis = Basis(uuid.uuid4(), "estimate", "ENG-41", day)
    for source in ("ENG-41 estimate", "(ENG-41).", "eng-41, capacity", "ENG-41/"):
        assert supporting(day, source, [basis]) == [basis], source
    for source in ("ENG-41-2 estimate", "ENG-41.2", "XENG-41", "ENG-412", "A-ENG-41", "ENG-41_b"):
        assert supporting(day, source, [basis]) == [], source


async def test_a_tracker_basis_milestone_is_rechecked_when_records_are_rematched(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
):
    _, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    track = await track_of(client, auth)

    async def match(item_key: str) -> None:
        resp = await client.post(
            "/v1/tracker/records",
            json={"tracker": "jira", "records": [
                {"external_ref": "ENG-500", "state": "todo", "track_id": track["id"],
                 "item_key": item_key}]},
            headers=auth,
        )  # fmt: skip
        assert resp.status_code == 200, resp.text

    await match("payment-step")
    resp = await client.post(
        "/v1/schedule-bases",
        json={"kind": "estimate", "reference": "ENG-500", "supports_date": "2026-11-20",
              "prd": PRD, "tracker_key": "ENG-500"},
        headers=auth,
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    basis_id = resp.json()["id"]
    resp = await client.post(
        f"/v1/tracks/{track['id']}/milestones",
        json={"name": "Payments beta", "target_date": "2026-11-20", "basis_ids": [basis_id],
              "item_keys": ["payment-step"]},
        headers=auth,
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    milestone = resp.json()

    # ENG-500 now tracks the shipping step: its basis no longer covers the payment step.
    await match("shipping-step")
    (row,) = [
        m
        for m in (await client.get(f"/v1/tracks/{track['id']}/milestones", headers=auth)).json()
        if m["id"] == milestone["id"]
    ]
    assert row["target_date"] is None and row["basis_ids"] == []


async def test_a_basis_from_a_record_without_a_track_still_checks_the_prd(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
):
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    billing = await other_prd(tenant_id)

    async def post_record(ref: str, **extra) -> str:
        resp = await client.post(
            "/v1/tracker/records",
            json={"tracker": "linear", "records": [
                {"external_ref": ref, "state": "todo", "target_date": "2026-11-30", **extra}]},
            headers=auth,
        )  # fmt: skip
        assert resp.status_code == 200, resp.text
        return resp.json()["records"][0]["id"]

    body = {"kind": "estimate", "reference": "ENG-9", "supports_date": "2026-11-30"}
    # On no track and matched to no item: nothing ties it to the billing PRD.
    loose = await post_record("ENG-9")
    resp = await client.post(
        "/v1/schedule-bases", json={**body, "prd": billing, "tracker_record_id": loose},
        headers=auth,
    )  # fmt: skip
    assert resp.status_code == 422, resp.text
    assert "no track" in resp.json()["detail"]
    # Matched to an item of this PRD's roadmap (no track yet): it is this PRD's.
    matched = await post_record("ENG-10", item_key="payment-step")
    resp = await client.post(
        "/v1/schedule-bases", json={**body, "prd": billing, "tracker_record_id": matched},
        headers=auth,
    )  # fmt: skip
    assert resp.status_code == 422, resp.text
    resp = await client.post(
        "/v1/schedule-bases", json={**body, "prd": PRD, "tracker_record_id": matched},
        headers=auth,
    )  # fmt: skip
    assert resp.status_code == 201, resp.text


async def test_a_disabled_member_cannot_own_a_track(client, owner, runtime, monkeypatch):  # noqa: F811
    tenant_id, auth = owner
    await approved_prd(client, auth)
    track = await track_of(client, auth)
    async with tenant_session(tenant_id) as s:
        gone = await create_user(s, "gone@example.com", "pw")
        lead = await create_user(s, "lead@example.com", "pw")
        await s.commit()
        gone_id, lead_id = gone.id, lead.id
    await disable_member(tenant_id, gone_id, monkeypatch)
    url = f"/v1/tracks/{track['id']}"
    resp = await client.patch(
        url, json={"lock_version": track["lock_version"], "owner_id": str(gone_id)}, headers=auth
    )
    assert resp.status_code == 422, resp.text
    assert "disabled" in resp.json()["detail"]
    resp = await client.patch(
        url, json={"lock_version": track["lock_version"], "owner_id": str(lead_id)}, headers=auth
    )
    assert resp.status_code == 200, resp.text
