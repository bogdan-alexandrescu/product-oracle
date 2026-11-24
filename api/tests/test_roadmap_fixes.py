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
from oracle.config import get_settings
from oracle.docs.parser import DraftError, parse_draft
from oracle.roadmap.schedule import Basis, supporting
from oracle.runs import flows
from oracle.runs import roadmap as items_file
from oracle.runs.models import RunSegment
from oracle.runs.roadmap import check_items
from oracle.runtokens import RunToken
from oracle.swarm import Outcome
from oracle.tenancy import tenant_session
from tests.fixtures import import_draft
from tests.test_roadmap import (  # noqa: F401 - fixtures
    ENG_412_DAY,
    ENG_412_ON,
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
    """Each malicious items file is flagged as a problem in under 100 ms."""
    text = PROBES[name]
    started = time.monotonic()
    out = check_items(text)
    elapsed = time.monotonic() - started
    assert out.problems and out.items == [], out.problems
    assert elapsed < 0.1, f"{name}: {elapsed:.3f} s"


@pytest.mark.parametrize("name", sorted(PROBES))
def test_the_loader_raises_only_its_refusal(name):
    """The raw YAML loader refuses every unsafe probe with its own error, not a crash."""
    with pytest.raises(items_file.ItemsYamlError):
        items_file.load_items_yaml(PROBES[name])


@pytest.mark.timing
def test_a_base60_value_is_a_string_read_at_once():
    """A sexagesimal-looking value like 1:30 stays a string and parses at once."""
    started = time.monotonic()
    data = items_file.load_items_yaml(BASE60)
    assert time.monotonic() - started < 0.1
    assert isinstance(data["items"][0]["economics"]["effort"], str)


@pytest.mark.timing
def test_the_one_megabyte_base60_scalar_is_refused_at_once():
    """A huge base60 scalar is refused as too large without delay."""
    text = _in_economics(base60(1_000_000))
    started = time.monotonic()
    out = check_items(text)
    assert time.monotonic() - started < 0.1
    assert [p["code"] for p in out.problems] == ["too_large"]


def test_only_plain_decimal_numbers_are_numbers():
    """Only plain decimal numbers parse as numbers; hex, octal and time stay strings."""
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
    """An explicit YAML tag, even on a plain value, is refused."""
    tagged = ("!!int 1:1:1", "!!float 1e3", "!!binary aGk=", "!!python/name:os.system ''", "!x y")
    for value in tagged:
        out = check_items(_in_economics(value))
        assert [p["code"] for p in out.problems] == ["yaml_tag"], value


def test_an_over_long_value_is_refused(monkeypatch):
    """A scalar longer than the configured max length is refused as too large."""
    monkeypatch.setattr(safe_yaml, "MAX_SCALAR_CHARS", 50)
    out = check_items(_in_economics('"' + "x " * 40 + '"'))
    assert [p["code"] for p in out.problems] == ["too_large"]


@pytest.mark.timing
def test_the_parse_runs_in_a_worker_thread_with_a_time_cap(monkeypatch):
    """A slow items parse is time-capped and runs off the event loop, not blocking it."""

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
    """An unexpected error while checking items is reported as a problem, not a crash."""

    def boom(text):
        raise MemoryError("out of memory")

    monkeypatch.setattr(items_file, "_parse", boom)
    assert [p["code"] for p in check_items(ITEMS).problems] == ["unreadable_yaml"]


@pytest.mark.timing
@pytest.mark.parametrize("probe", ["long_decimal", "deep_sequence", "deep_mapping"])
async def test_the_tick_completes_and_revokes_the_token(client, owner, runtime, probe):  # noqa: F811
    """A rejected roadmap items file fails the run and revokes tokens, not the tick."""
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
    """NaN and infinity values in items are refused as non-finite numbers."""
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
    """A tracker reference matches only as a whole token, not inside another one."""
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
    """A tracker-record basis is rechecked when the record's item match changes."""
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
    """A schedule basis from a trackless record still ties only to its own PRD."""
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
    """A disabled member cannot be made a track's owner."""
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


# -----------------------------------------------------------------------------
# Roadmap review fixes, round 4 (PR #87 review).
#
# B1. The round-3 probes (base-60, a 5,000-digit number, deep nesting, an alias bomb)
#     against every YAML Oracle reads from outside: a draft's front matter (parse_draft,
#     POST /versions, a run's prd.md / roadmap.md import), baseline.yaml and templates. One
#     safe loader (oracle.safe_yaml), off the event loop; POST /versions capped at 1 MB.


ALIAS_BOMB = (
    'a: &a ["x","x","x","x","x","x","x","x","x"]\n'
    "b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]\n"
    "c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]\n"
    "d: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]\n"
)
# Each a YAML value that stock yaml.safe_load stalls on, crashes on or expands. (A base-60
# value is no refusal: oracle.safe_yaml reads it as a string, at once.)
YAML_PROBES = {
    "long_decimal": "effort: " + "9" * 5_000,
    "deep_sequence": "effort: " + "[" * 400 + "]" * 400,
    "deep_mapping": "effort: " + "{a: " * 400 + "1" + "}" * 400,
    "alias_bomb": ALIAS_BOMB,
}


def _front_matter_probe(name: str, body: str = "# T {#t}\n\nText.\n") -> str:
    return f"---\ntitle: Probe\n{YAML_PROBES[name]}\n---\n\n{body}"


def _roadmap_probe(name: str) -> str:
    head, rest = ROADMAP_MD.split("\n", 1)
    return f"{head}\n{YAML_PROBES[name]}\n{rest}"


# --------------------------------------------------------------------------- B1


@pytest.mark.timing
@pytest.mark.parametrize("name", sorted(YAML_PROBES))
def test_the_safe_loader_refuses_each_probe_at_once(name):
    """The safe YAML loader refuses every unsafe probe in under 100 ms."""
    started = time.monotonic()
    with pytest.raises(safe_yaml.SafeYamlError):
        safe_yaml.load(YAML_PROBES[name])
    assert time.monotonic() - started < 0.1


def test_duplicate_keys_are_refused_and_yaml11_words_stay_strings():
    """Duplicate keys are refused with their line; words like On or NO stay strings."""
    with pytest.raises(safe_yaml.SafeYamlError) as exc:
        safe_yaml.load("a: 1\nb: 2\na: 3\n")
    assert exc.value.code == "duplicate_key" and exc.value.line == 3
    data = safe_yaml.load("a: NO\nb: On\nc: off\nd: yes\ne: true\nf: 1:30\n")
    assert data == {"a": "NO", "b": "On", "c": "off", "d": "yes", "e": True, "f": "1:30"}


def test_items_keep_yaml11_booleans_as_strings_and_refuse_duplicate_keys():
    """Items keep YAML1.1 words like On as strings and refuse duplicate keys anywhere."""
    data = items_file.load_items_yaml("title: NO\nconfidence: On\n")
    assert data == {"title": "NO", "confidence": "On"}
    with pytest.raises(items_file.ItemsYamlError) as exc:
        items_file.load_items_yaml("items: []\nitems: []\n")
    assert exc.value.code == "duplicate_key"
    dup = ITEMS.replace("    title: Payment step\n", "    title: Payment step\n    title: Pay\n", 1)
    assert [p["code"] for p in items_file.check_items(dup).problems] == ["duplicate_key"]


def test_an_export_never_writes_aliases_the_loader_would_refuse():
    """An export never writes the YAML aliases its own strict loader would refuse."""
    shared = {"k": "v"}
    text = safe_yaml.dump({"a": shared, "b": shared})
    assert "&" not in text and safe_yaml.load(text) == {"a": shared, "b": shared}


@pytest.mark.timing
@pytest.mark.parametrize("name", sorted(YAML_PROBES))
def test_parse_draft_refuses_each_probe_in_front_matter_at_once(name):
    """A draft's front matter refuses every unsafe YAML probe in under 100 ms."""
    started = time.monotonic()
    with pytest.raises(DraftError) as exc:
        parse_draft(_front_matter_probe(name))
    assert time.monotonic() - started < 0.1
    assert [p.code for p in exc.value.problems] == ["invalid_front_matter"]


@pytest.mark.timing
def test_a_template_front_matter_probe_is_a_problem():
    """A template's front matter is checked against the same unsafe YAML probes."""
    from oracle.templates.validation import check_template

    for name in YAML_PROBES:
        started = time.monotonic()
        check = check_template(_front_matter_probe(name))
        assert time.monotonic() - started < 0.1
        assert "invalid_front_matter" in {p.code for p in check.problems}, name


@pytest.mark.timing
@pytest.mark.parametrize("name", sorted(YAML_PROBES))
async def test_post_versions_refuses_each_probe(client, owner, name):  # noqa: F811
    """Posting a version with unsafe front matter is refused in under a second."""
    _, auth = owner
    started = time.monotonic()
    resp = await client.post(
        "/v1/documents/probe/versions",
        content=_front_matter_probe(name).encode(),
        headers={**auth, "Content-Type": "text/markdown"},
    )
    assert time.monotonic() - started < 1
    assert resp.status_code == 422, resp.text
    assert [e["code"] for e in resp.json()["errors"]] == ["invalid_front_matter"]


async def test_post_versions_refuses_a_body_over_one_megabyte(client, owner):  # noqa: F811
    """A document version body over one megabyte is refused as too large."""
    _, auth = owner
    limit = get_settings().max_body_bytes
    body = _front_matter_probe("long_decimal", "# T {#t}\n\n" + "word " * (limit // 5))
    resp = await client.post(
        "/v1/documents/big/versions",
        content=body.encode(),
        headers={**auth, "Content-Type": "text/markdown"},
    )
    assert resp.status_code == 413, resp.text
    with pytest.raises(DraftError) as exc:
        parse_draft(body)
    assert [p.code for p in exc.value.problems] == ["draft_too_large"]


@pytest.mark.timing
@pytest.mark.parametrize("name", sorted(YAML_PROBES))
async def test_baseline_yaml_refuses_each_probe(client, owner, name):  # noqa: F811
    """Posting baseline YAML with an unsafe probe is refused, not accepted."""
    _, auth = owner
    started = time.monotonic()
    resp = await client.post(
        "/v1/baseline/yaml",
        content=f"version: 1\n{YAML_PROBES[name]}\n".encode(),
        headers={**auth, "Content-Type": "application/yaml"},
    )
    assert time.monotonic() - started < 1
    assert resp.status_code == 422, resp.text


@pytest.mark.timing
async def test_the_draft_parse_runs_off_the_event_loop(monkeypatch):
    """A slow draft parse is time-capped and keeps the event loop running."""
    import asyncio

    from oracle.docs import parser

    def slow(markdown):
        time.sleep(0.5)
        raise AssertionError("not reached")

    monkeypatch.setattr(parser, "parse_draft", slow)
    monkeypatch.setattr(safe_yaml, "PARSE_SECONDS", 0.05)
    beats = 0

    async def beat():
        nonlocal beats
        while True:
            await asyncio.sleep(0.01)
            beats += 1

    task = asyncio.create_task(beat())
    with pytest.raises(DraftError) as exc:
        await parser.parse_draft_async("---\ntitle: x\n---\n")
    task.cancel()
    assert [p.code for p in exc.value.problems] == ["too_slow"] and beats >= 2


@pytest.mark.timing
@pytest.mark.parametrize("name", ["deep_mapping", "deep_sequence", "alias_bomb"])
async def test_a_runs_roadmap_md_probe_fails_the_import_not_the_tick(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
    name,
):
    """A run's own bad roadmap.md fails its import, never the tick that reads it."""
    _, auth = owner
    await approved_prd(client, auth)
    runtime.script["roadmap_items"] = [Outcome(artifacts={"roadmap_items.yaml": ITEMS})]
    runtime.script["roadmap_draft"] = [Outcome(artifacts={"roadmap.md": _roadmap_probe(name)})]
    off = {"roadmap_items": False, "roadmap_review": False}
    run = await start(
        client, auth, await create(client, auth, source=PRD, knobs={"checkpoints": off})
    )
    started = time.monotonic()
    await tick(client, auth)
    await tick(client, auth)
    assert time.monotonic() - started < 3
    run = await get(client, auth, run["id"])
    assert run["status"] == "failed", run
    assert "roadmap.md was rejected" in run["error"] and "invalid_front_matter" in run["error"]


@pytest.mark.timing
@pytest.mark.parametrize("name", ["long_decimal", "deep_mapping", "alias_bomb"])
async def test_a_runs_prd_md_probe_fails_the_import_not_the_tick(client, owner, runtime, name):  # noqa: F811
    """A run's own bad prd.md fails its import, never the tick that reads it."""
    from tests.fixtures import draft

    _, auth = owner
    prd = draft("prd_v1.md")
    head, rest = prd.split("\n", 1)
    runtime.script["prd_draft"] = [
        Outcome(artifacts={"prd.md": f"{head}\n{YAML_PROBES[name]}\n{rest}"})
    ]
    off = dict.fromkeys(flows.FLOWS["baseline_to_prd"].checkpoints, False)
    resp = await client.post(
        "/v1/runs",
        json={"flow": "baseline_to_prd", "document": "example-prd", "knobs": {"checkpoints": off}},
        headers=auth,
    )
    assert resp.status_code == 201, resp.text
    run = await start(client, auth, resp.json())
    started = time.monotonic()
    for _ in range(4):
        await tick(client, auth)
    assert time.monotonic() - started < 5
    run = await get(client, auth, run["id"])
    assert run["status"] == "failed", run
    assert "prd.md was rejected" in run["error"] and "invalid_front_matter" in run["error"]


# --------------------------------------------------------------------------- M1

# Each a way to write 2026-12-15 (no basis of the PRD supports it) that a reader sees as
# that date. ENG-412 supports ENG_412_DAY only.
DATE_PROBES = [
    "GA 15/12/2026.",
    "GA 12/15/2026 (US).",
    "GA 2026/12/15 slash.",
    "GA 15.12.2026 dotted.",
    "GA 2026.12.15 dotted.",
    "GA 2026-12-15T09:00Z cutover.",
    "GA 20261215 compact.",
    "GA Dec 15 yearless.",
    "GA the 15th of December.",
    "GA Dec 15, 2026 nbsp.",
    "GA 2026‑12‑15 nb-hyphen.",
    "GA 2026-12-​15 zero-width.",
    "GA ２０２６-12-15 fullwidth.",
    "GA Dec&nbsp;15, 2027 entity.",
    "GA **Dec** 16,\n2026 emphasis.",
    "GA `2026-12-17` code.",
    "GA <https://example.com/2026-12-18> autolink.",
    "GA [plan](see 2026-12-19) spaced destination.",
    "GA Q4/Dec 20, 2026 slash-before.",
    "GA.Dec 21, 2026 dot-before.",
    "GA 22-Dec-2026 hyphenated.",
    "GA 12/23/26 short year.",
    "GA Dec 24\\, 2026 escape.",
    "GA 2026&#45;12&#45;25 numeric entity.",
    "GA *Dec 26, 2026* emphasis.",
]


def _with_paragraph(text: str, md: str = ROADMAP_MD) -> str:
    heading = "### Payment step {#now-payment-step}\n\n"
    assert heading in md
    return md.replace(heading, heading + text + "\n\n", 1)


async def test_every_probe_is_refused_on_a_person_s_import(client, owner, runtime):  # noqa: F811
    """Every unverified date probe is refused on import; a verified date still imports."""
    from tests.test_roadmap import built_roadmap

    _, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    for probe in DATE_PROBES:
        resp = await import_draft(client, auth, _with_paragraph(probe), ROADMAP)
        assert resp.status_code == 422, (probe, resp.text)
        assert {e["code"] for e in resp.json()["errors"]} == {"unverified_date"}, probe
    # The control: the verified date, and month or quarter phrases, import.
    beta = f"{ENG_412_ON.day} {ENG_412_ON:%b} {ENG_412_ON.year}"  # e.g. 30 Nov 2026
    ok = _with_paragraph(f"Beta {beta}, GA in Q4 2026 or December 2026.")
    assert (await import_draft(client, auth, ok, ROADMAP)).status_code == 201


async def _run_import(client, auth, runtime, markdown: str) -> dict:  # noqa: F811
    runtime.script["roadmap_items"] = [Outcome(artifacts={"roadmap_items.yaml": ITEMS})]
    runtime.script["roadmap_draft"] = [Outcome(artifacts={"roadmap.md": markdown})]
    off = {"roadmap_items": False, "roadmap_review": False}
    run = await start(
        client, auth, await create(client, auth, source=PRD, knobs={"checkpoints": off})
    )
    await tick(client, auth)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "succeeded", run
    return run


async def test_every_probe_is_a_warning_and_a_marker_on_a_run_s_import(client, owner, runtime):  # noqa: F811
    """Each unverified date gets one warning and a marker, not one warning per mention."""
    _, auth = owner
    await approved_prd(client, auth)
    await _run_import(client, auth, runtime, _with_paragraph("\n\n".join(DATE_PROBES)))
    version = (await client.get(f"{VERSIONS}/1", headers=auth)).json()
    warnings = [w for w in version["warnings"] if w["code"] == "unverified_date"]
    flagged = [m for m in version["date_marks"] if m["status"] == "unverified"]
    assert len(flagged) == len(DATE_PROBES)
    # date-warnings-honest: one warning per distinct date and item, not one per mention.
    days = {tuple(m["days"]) for m in flagged}
    assert len(warnings) == len(days) < len(DATE_PROBES), [w["message"] for w in warnings]
    assert all(m["label"] == "unverified" for m in flagged)
    # The verified Beta date stays unmarked.
    assert (ENG_412_DAY, "verified") in {(m["text"], m["status"]) for m in version["date_marks"]}
    # Each probe's marker is in the markdown, right after the date.
    md = (await client.get(f"{VERSIONS}/1/markdown", headers=auth)).text
    assert md.count("<!-- oracle: date unverified -->") == len(DATE_PROBES)
    for after in (
        "GA 20261215 <!-- oracle: date unverified --> compact.",
        "GA `2026-12-17` <!-- oracle: date unverified --> code.",
        "<https://example.com/2026-12-18> <!-- oracle: date unverified --> autolink.",
        "GA Q4/Dec 20, 2026 <!-- oracle: date unverified --> slash-before.",
        "GA.Dec 21, 2026 <!-- oracle: date unverified --> dot-before.",
        "GA *Dec 26, 2026* <!-- oracle: date unverified --> emphasis.",
        "GA **Dec** 16,\n2026 <!-- oracle: date unverified --> emphasis.",
    ):
        assert after in md, after


ROADMAP = "checkout-redesign-roadmap"
VERSIONS = f"/v1/documents/{ROADMAP}/versions"


async def test_title_notes_and_layout_text_are_read_but_layout_yaml_and_sources_are_not(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
):
    """A title's or layout's prose date is checked; its YAML and Sources are not."""
    from tests.test_roadmap import built_roadmap

    _, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    titled = ROADMAP_MD.replace("title: Checkout roadmap", "title: Checkout GA Dec 15, 2026")
    resp = await import_draft(client, auth, titled, ROADMAP)
    assert resp.status_code == 422 and "the title" in resp.json()["errors"][0]["message"]
    noted = _with_paragraph("Payment first.\n\n```notes\nSay GA is 2026-12-15.\n```")
    resp = await import_draft(client, auth, noted, ROADMAP)
    assert resp.status_code == 422, resp.text
    layout = (
        "## Layout {#layout}\n\nLanes fixed until 2026-12-15.\n\n```yaml\nlanes: [now]\n```\n\n"
    )
    laid = ROADMAP_MD.replace(
        "## Sources and data points {#sources}", layout + "## Sources and data points {#sources}"
    )
    resp = await import_draft(client, auth, laid, ROADMAP)
    assert resp.status_code == 422, resp.text
    # The layout's YAML is for the renderer; the Sources section is evidence.
    quiet = laid.replace("Lanes fixed until 2026-12-15.", "Lanes fixed.").replace(
        "lanes: [now]", "lanes: [now]\nfrozen: 2026-12-15"
    )
    quiet = quiet.replace("- Beta date: ENG-412 estimate [c:c1]", "- Retrieved 2026-12-15 [c:c1]")
    assert (await import_draft(client, auth, quiet, ROADMAP)).status_code == 201


async def test_sources_must_be_the_last_part(client, owner, runtime):  # noqa: F811
    """Sources and data points must be the last section, or dates after it still count."""
    from tests.test_roadmap import built_roadmap

    _, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    moved = ROADMAP_MD.replace(
        "## Sources and data points {#sources}\n\n- Beta date: ENG-412 estimate [c:c1]\n",
        "",
    ).replace(
        "## Later {#later}\n",
        "## Sources and data points {#sources}\n\n- Beta date: ENG-412 estimate [c:c1]\n\n"
        "## Later {#later}\n\nGA 2026-12-15.\n",
    )
    resp = await import_draft(client, auth, moved, ROADMAP)
    assert resp.status_code == 422
    codes = [e["code"] for e in resp.json()["errors"]]
    # Refused for its place, and the date after it is read (not exempt).
    assert codes == ["sources_not_last", "unverified_date"], codes
    # A sub-section of sources stays exempt.
    sub = ROADMAP_MD + "\n### Retrieval log {#sources-log}\n\nRead 2026-12-15.\n"
    assert (await import_draft(client, auth, sub, ROADMAP)).status_code == 201


# --------------------------------------------------------------------------- M2


async def test_markers_sit_after_the_exact_span_everywhere(client, owner, runtime):  # noqa: F811
    """The unverified-date marker sits right after the exact date, everywhere shown."""
    _, auth = owner
    await approved_prd(client, auth)
    await _run_import(
        client,
        auth,
        runtime,
        _with_paragraph("Beta Q4/Dec 15, 2026 and Beta.Dec 15, 2026; also `2026-12-15`."),
    )
    marker = "<!-- oracle: date unverified -->"
    md = (await client.get(f"{VERSIONS}/1/markdown", headers=auth)).text
    assert (
        f"Beta Q4/Dec 15, 2026 {marker} and Beta.Dec 15, 2026 {marker}; also `2026-12-15` "
        f"{marker}." in md
    )
    export = (await client.get(f"{VERSIONS}/1/export", params={"format": "md"}, headers=auth)).text
    assert export.count(marker) == 3
    html = (await client.get(f"{VERSIONS}/1/export", params={"format": "html"}, headers=auth)).text
    # Export QA pass X, X-12 (train AS cdf393d16): the flag is a small plain mark.
    mark = '<span class="date-mark" data-date-mark="unverified">unverified</span>'
    assert html.count(f"Dec 15, 2026 {mark}") == 2
    assert f"<code>2026-12-15</code> {mark}" in html
    assert "[unverified]" not in html
    deck = (await client.get(f"{VERSIONS}/1/deck", headers=auth)).json()
    text = " ".join(e["html"] for s in deck["slides"] for e in s["expand"]) + " ".join(
        s["html"] for s in deck["slides"]
    )
    assert "Dec 15, 2026 <strong>[unverified]</strong>" in text

    # The marked markdown parses as the stored text (the import drops the comments), and
    # the export parses as a draft.
    from oracle.docs.parser import parse_draft

    stored = (await client.get(f"{VERSIONS}/1", headers=auth)).json()
    assert parse_draft(md).content_hash == stored["content_hash"]
    assert marker not in parse_draft(export).markdown


async def test_mcp_markdown_carries_the_markers_and_date_marks(client, owner, runtime):  # noqa: F811
    """The MCP markdown tool also carries the unverified-date marker and date marks."""
    from tests.test_mcp import api_token, mcp_client, text_of

    tid, auth = owner
    await approved_prd(client, auth)
    await _run_import(client, auth, runtime, _with_paragraph("GA 2026-12-15."))
    token = await api_token(tid, "owner")
    async with mcp_client(token) as c:
        out = await c.call_tool("get_document_markdown", {"doc": ROADMAP, "version": 1})
        assert not out.is_error, text_of(out)
        assert (
            "GA 2026-12-15 <!-- oracle: date unverified -->." in out.structured_content["markdown"]
        )
        marks = out.structured_content["date_marks"]
        assert [(m["text"], m["label"]) for m in marks] == [("2026-12-15", "unverified")]
        assert "date_marks" in text_of(out)


async def test_approval_is_refused_while_a_date_is_marked(client, owner, runtime):  # noqa: F811
    """A version with an unverified date cannot be approved until a basis verifies it."""
    _, auth = owner
    await approved_prd(client, auth)
    await _run_import(client, auth, runtime, _with_paragraph("GA 2026-12-15."))
    resp = await client.post(f"{VERSIONS}/1/approve", headers=auth)
    assert resp.status_code == 409, resp.text
    body = resp.json()
    assert "Dec 15, 2026" in body["detail"]
    assert [(d["text"], d["status"]) for d in body["dates"]] == [("2026-12-15", "unverified")]
    assert [b["key"] for b in body["blocking"]] == ["unverified_date"]
    # Resolved by a basis: the marker goes and the version can be approved.
    resp = await client.post(
        "/v1/schedule-bases",
        json={"kind": "estimate", "reference": "ENG-900", "supports_date": "2026-12-15",
              "prd": PRD},
        headers=auth,
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    resp = await client.post(f"{VERSIONS}/1/approve", headers=auth)
    assert resp.status_code == 200, resp.text


async def test_a_withdrawn_date_on_an_unapproved_version_also_refuses_approval(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
):
    """Withdrawing a date's basis blocks approval too, even before approval happens."""
    _, auth = owner
    await approved_prd(client, auth)
    await _run_import(client, auth, runtime, ROADMAP_MD)
    (eng,) = [
        b
        for b in (await client.get("/v1/schedule-bases", headers=auth)).json()
        if b["reference"] == "ENG-412"
    ]
    resp = await client.post(
        f"/v1/schedule-bases/{eng['id']}/withdraw", json={"reason": "re-estimated"}, headers=auth
    )
    assert resp.status_code == 200, resp.text
    resp = await client.post(f"{VERSIONS}/1/approve", headers=auth)
    assert resp.status_code == 409
    # The body's date and the plan tables' two.
    assert [d["status"] for d in resp.json()["dates"]] == ["withdrawn"] * 3


# --------------------------------------------------------------------------- minors


async def test_a_database_error_while_checking_items_rolls_back_and_the_tick_goes_on(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
    monkeypatch,
):
    """A database error in the items check rolls back cleanly; the tick still finishes."""
    from sqlalchemy import text

    from oracle.roadmap import schedule

    _, auth = owner
    await approved_prd(client, auth)

    async def broken(db, prd):
        await db.execute(text("SELECT * FROM no_such_table"))

    runtime.script["roadmap_items"] = [Outcome(artifacts={"roadmap_items.yaml": ITEMS})]
    run = await start(client, auth, await create(client, auth, source=PRD))
    # The check's database read fails (as a lost connection or a bad query would).
    monkeypatch.setattr(schedule, "verified_bases", broken)
    await tick(client, auth)  # no tick error: the check failed, the session was rolled back
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint", run
    from sqlalchemy import select

    from oracle.runs.models import RunSegment
    from oracle.tenancy import tenant_session

    async with tenant_session(owner[0]) as s:
        seg = await s.scalar(select(RunSegment).where(RunSegment.name == "roadmap_items"))
    assert [p["code"] for p in seg.artifacts["items_check"]["problems"]] == ["unreadable_yaml"]


async def test_the_runs_items_file_is_not_parsed_again_on_each_roadmap_import(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
    monkeypatch,
):
    """The run's items file is parsed once, not again on each later roadmap import."""
    _, auth = owner
    await approved_prd(client, auth)
    parses = []
    real = items_file.check_items

    def counting(text, **kw):
        parses.append(1)
        return real(text, **kw)

    monkeypatch.setattr(items_file, "check_items", counting)
    runtime.script["roadmap_items"] = [Outcome(artifacts={"roadmap_items.yaml": ITEMS})]
    runtime.script["roadmap_draft"] = [Outcome(artifacts={"roadmap.md": ROADMAP_MD})]
    # The run stops at its roadmap review: still active while people push new versions.
    off = {"roadmap_items": False}
    run = await start(
        client, auth, await create(client, auth, source=PRD, knobs={"checkpoints": off})
    )
    await tick(client, auth)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint", run
    for n in range(3):
        md = ROADMAP_MD.replace("Make checkout predictable", f"Make checkout predictable ({n})")
        assert (await import_draft(client, auth, md, ROADMAP)).status_code == 201
        if n == 0:
            # The first person's version checks the file once (it has no PRD version of
            # its own); the next ones reuse that check.
            after_first = len(parses)
    assert len(parses) == after_first, "the same file was parsed again"
    items = (
        await client.get(f"/v1/roadmaps/{ROADMAP}/items", params={"version": 4}, headers=auth)
    ).json()
    assert [i["item_key"] for i in items["items"]] == ["payment-step", "shipping-step"]


async def test_an_item_basis_counts_only_where_its_item_owns_the_date(client, owner, runtime):  # noqa: F811
    """An item's verified date counts only where its own section or link names it."""
    from tests.test_roadmap import built_roadmap
    from tests.test_roadmap_doc_dates import record

    _, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    await record(client, auth, "ENG-500", "2026-12-15", item_key="shipping-step")
    # Mentioned in the payment step's section: not the shipping step's date.
    mention = _with_paragraph("Shipping step (shipping-step) ships 2026-12-15.")
    assert (await import_draft(client, auth, mention, ROADMAP)).status_code == 422
    # In the shipping step's own table row: its date.
    row = ROADMAP_MD.replace(
        "| [Shipping step](#next-shipping-step) | Fewer buyers drop off at shipping |",
        "| [Shipping step](#next-shipping-step) | Ships 2026-12-15 |",
    )
    assert row != ROADMAP_MD
    assert (await import_draft(client, auth, row, ROADMAP)).status_code == 201, "row"
    # date-warnings-honest: a row whose sentence links the item is about it too.
    other = ROADMAP_MD.replace(
        "| [Payment step](#now-payment-step) | Buyers pay without re-entering their card |",
        "| [Payment step](#now-payment-step) | After [ship](#next-shipping-step) 2026-12-15 |",
    )
    assert (await import_draft(client, auth, other, ROADMAP)).status_code == 201
    # A row that names it only in words is not.
    words = ROADMAP_MD.replace(
        "| [Payment step](#now-payment-step) | Buyers pay without re-entering their card |",
        "| [Payment step](#now-payment-step) | After shipping, 2026-12-15 |",
    )
    assert (await import_draft(client, auth, words, ROADMAP)).status_code == 422


async def test_a_roadmap_takes_its_prd_from_its_own_link_not_from_its_text(client, owner):  # noqa: F811
    """A roadmap's PRD comes from its own declared link, never from mentioning text."""
    _, auth = owner
    await approved_prd(client, auth)
    loose = ROADMAP_MD.replace("document: checkout-redesign-roadmap", "document: loose-roadmap")
    without = loose.replace("prd: {document: checkout-redesign, version: 1}\n", "")
    resp = await import_draft(client, auth, without, "loose-roadmap")
    assert resp.status_code == 422 and "none is known" in resp.json()["errors"][0]["message"]
    # Its front matter names its PRD: the PRD's verified ENG-412 supports the Beta date.
    resp = await import_draft(client, auth, loose, "loose-roadmap")
    assert resp.status_code == 201, resp.text


async def test_start_draft_exempts_the_template_s_literal_dates_not_the_title(client, owner):  # noqa: F811
    """A template's own date stays exempt in a new draft; a typed title date is not."""
    _, auth = owner
    body = (
        "---\nkind: roadmap\nbrief: [summary]\n---\n\n# Roadmap {#roadmap}\n\n"
        "## Summary {#summary}\n\nPlanning freeze every year on Dec 15.\n\n"
        "## Now {#now}\n\n## Sources and data points {#sources}\n"
    )
    resp = await client.post(
        "/v1/templates",
        json={"key": "dated-roadmap", "name": "Dated", "kind": "roadmap", "body": body},
        headers=auth,
    )
    assert resp.status_code == 201, resp.text
    resp = await client.post(
        "/v1/drafts",
        json={"kind": "roadmap", "title": "Checkout plan", "template": "dated-roadmap"},
        headers=auth,
    )
    assert resp.status_code == 201, resp.text
    slug = resp.json()["slug"]
    # The company's literal date stays exempt in a person's next version of that section.
    md = (await client.get(f"/v1/documents/{slug}/versions/1/markdown", headers=auth)).text
    assert "Dec 15" in md and "<!-- oracle" not in md
    resp = await import_draft(
        client, auth, md.replace("## Now {#now}", "## Now {#now}\n\nSoon."), slug
    )
    assert resp.status_code == 201, resp.text
    # A date the person typed in the title is theirs.
    resp = await client.post(
        "/v1/drafts",
        json={"kind": "roadmap", "title": "GA Dec 16, 2026", "template": "dated-roadmap"},
        headers=auth,
    )
    assert resp.status_code == 422, resp.text


async def test_a_refinement_checks_only_the_section_it_changes(client, owner, runtime):  # noqa: F811
    """Refining one section checks only that section, not the whole document again."""
    from oracle.llm import gateway
    from tests.claude_account_helpers import add_account, window
    from tests.test_llm_jobs import FakeClaude

    tenant_id, auth = owner
    await approved_prd(client, auth)
    await _run_import(client, auth, runtime, _with_paragraph("GA 2026-12-15."))
    await add_account(tenant_id, "personal", windows={"five_hour": window(0.2)})
    fake = FakeClaude()
    previous = gateway.set_transports(gateway.Transports(plan=fake, api_key=fake))
    try:

        async def refine(key: str, body: str) -> object:
            resp = await client.post(
                f"{VERSIONS}/{await latest()}/sections/{key}/refine",
                json={"instruction": "Tighten it."},
                headers=auth,
            )
            assert resp.status_code == 201, resp.text
            job = resp.json()["id"]
            fake.script["refinement"].append({"heading": None, "body_md": body})
            for _ in range(3):
                await client.post("/v1/internal/tick", headers=auth)
            done = (await client.get(f"/v1/llm-jobs/{job}", headers=auth)).json()
            assert done["status"] == "succeeded", done
            return await client.post(f"/v1/llm-jobs/{job}/apply", json={}, headers=auth)

        async def latest() -> int:
            versions = (await client.get(VERSIONS, headers=auth)).json()
            return max(v["number"] for v in versions)

        # The summary changes; the payment step's marked date is untouched: imports.
        resp = await refine("summary", "Payment first, then shipping.")
        assert resp.status_code == 201, resp.text
        # A revision of the payment step that keeps the unverified date is refused.
        resp = await refine("now-payment-step", f"GA 2026-12-15. Beta by {ENG_412_DAY}.")
        assert resp.status_code == 422, resp.text
    finally:
        gateway.set_transports(previous)


async def test_a_disabled_owner_is_refused_once_the_column_exists(client, owner):  # noqa: F811
    """A disabled user cannot become a track's owner once the disabled column exists."""
    from sqlalchemy import text

    from oracle.auth.service import create_user
    from oracle.db import get_engine as engine
    from oracle.tenancy import tenant_session
    from tests.test_tracks import track_of

    tenant_id, auth = owner
    await approved_prd(client, auth)
    track = await track_of(client, auth)
    async with tenant_session(tenant_id) as s:
        member = await create_user(s, "gone@example.com", "pw")
        await s.commit()
        member_id = member.id
    # The column exists since the member disable (migration 0014_member_disable).
    async with engine().begin() as conn:
        await conn.execute(
            text("UPDATE users SET disabled_at = now() WHERE id = :id"), {"id": member_id}
        )
    resp = await client.patch(
        f"/v1/tracks/{track['id']}",
        json={"owner_id": str(member_id), "lock_version": track["lock_version"]},
        headers=auth,
    )
    assert resp.status_code == 422 and "disabled" in resp.text, resp.text
