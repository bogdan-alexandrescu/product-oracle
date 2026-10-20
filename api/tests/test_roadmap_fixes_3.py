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

import pytest
from sqlalchemy import select

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
    create,
    get,
    owner,
    runtime,
    start,
    tick,
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


PROBES = {
    # YAML 1.1 sexagesimal int: quadratic to build (3 s at 160 KB), then ValueError.
    "base60": _in_economics(base60(160_000)),
    # Python refuses int() of more than 4,300 digits: ValueError at once.
    "long_decimal": _in_economics("9" * 5_000),
    # ~400 levels of nesting: RecursionError in the composer, under 1 KB.
    "deep_sequence": _in_economics("[" * 400 + "]" * 400),
    "deep_mapping": _in_economics("{a: " * 400 + "1" + "}" * 400),
}


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


def test_the_one_megabyte_base60_scalar_is_refused_at_once():
    text = _in_economics(base60(1_000_000))
    started = time.monotonic()
    out = check_items(text)
    assert time.monotonic() - started < 0.1
    assert [p["code"] for p in out.problems] == ["too_large"]


def test_only_plain_decimal_numbers_are_numbers():
    data = items_file.load_items_yaml(
        "a: 1:30\nb: 0x1F\nc: 0o17\nd: 1_000\ne: 12\nf: -3.5\ng: 1e3\nh: 2026-11-30\ni: true\n"
    )
    assert data["a"] == "1:30" and data["b"] == "0x1F" and data["c"] == "0o17"
    assert data["d"] == "1_000"
    assert data["e"] == 12 and data["f"] == -3.5 and data["g"] == 1000.0
    assert str(data["h"]) == "2026-11-30" and data["i"] is True


def test_explicit_tags_are_refused():
    tagged = ("!!int 1:1:1", "!!float 1e3", "!!binary aGk=", "!!python/name:os.system ''", "!x y")
    for value in tagged:
        out = check_items(_in_economics(value))
        assert [p["code"] for p in out.problems] == ["yaml_tag"], value


def test_an_over_long_value_is_refused(monkeypatch):
    monkeypatch.setattr(items_file, "MAX_SCALAR_CHARS", 50)
    out = check_items(_in_economics('"' + "x " * 40 + '"'))
    assert [p["code"] for p in out.problems] == ["too_large"]


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


@pytest.mark.parametrize("probe", ["long_decimal", "deep_sequence", "base60"])
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
