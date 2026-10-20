"""Roadmap review fixes, round 4 (PR #87 review).

B1. The round-3 probes (base-60, a 5,000-digit number, deep nesting, an alias bomb)
    against every YAML Oracle reads from outside: a draft's front matter (parse_draft,
    POST /versions, a run's prd.md / roadmap.md import), baseline.yaml and templates. One
    safe loader (oracle.safe_yaml), off the event loop; POST /versions capped at 1 MB.
"""

import time

import pytest

from oracle import safe_yaml
from oracle.docs.parser import MAX_DRAFT_BYTES, DraftError, parse_draft
from oracle.runs import flows
from oracle.runs import roadmap as items_file
from oracle.swarm import Outcome
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


def base60(size: int) -> str:
    return "1" + ":1" * (size // 2)


ALIAS_BOMB = (
    'a: &a ["x","x","x","x","x","x","x","x","x"]\n'
    "b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]\n"
    "c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]\n"
    "d: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]\n"
)
# Each a YAML value that stock yaml.safe_load stalls on, crashes on or expands.
YAML_PROBES = {
    "base60": f"effort: {base60(160_000)}",
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


@pytest.mark.parametrize("name", sorted(YAML_PROBES))
def test_the_safe_loader_refuses_each_probe_at_once(name):
    started = time.monotonic()
    with pytest.raises(safe_yaml.SafeYamlError):
        safe_yaml.load(YAML_PROBES[name])
    assert time.monotonic() - started < 0.1


def test_duplicate_keys_are_refused_and_yaml11_words_stay_strings():
    with pytest.raises(safe_yaml.SafeYamlError) as exc:
        safe_yaml.load("a: 1\nb: 2\na: 3\n")
    assert exc.value.code == "duplicate_key" and exc.value.line == 3
    data = safe_yaml.load("a: NO\nb: On\nc: off\nd: yes\ne: true\nf: 1:30\n")
    assert data == {"a": "NO", "b": "On", "c": "off", "d": "yes", "e": True, "f": "1:30"}
    # baseline.yaml keeps its YAML 1.1 booleans (locked: yes), as it always read them.
    assert safe_yaml.load("locked: yes\n", yaml11_booleans=True) == {"locked": True}


def test_items_keep_yaml11_booleans_as_strings_and_refuse_duplicate_keys():
    data = items_file.load_items_yaml("title: NO\nconfidence: On\n")
    assert data == {"title": "NO", "confidence": "On"}
    with pytest.raises(items_file.ItemsYamlError) as exc:
        items_file.load_items_yaml("items: []\nitems: []\n")
    assert exc.value.code == "duplicate_key"
    dup = ITEMS.replace("    title: Payment step\n", "    title: Payment step\n    title: Pay\n", 1)
    assert [p["code"] for p in items_file.check_items(dup).problems] == ["duplicate_key"]


def test_an_export_never_writes_aliases_the_loader_would_refuse():
    shared = {"k": "v"}
    text = safe_yaml.dump({"a": shared, "b": shared})
    assert "&" not in text and safe_yaml.load(text) == {"a": shared, "b": shared}


@pytest.mark.parametrize("name", sorted(YAML_PROBES))
def test_parse_draft_refuses_each_probe_in_front_matter_at_once(name):
    started = time.monotonic()
    with pytest.raises(DraftError) as exc:
        parse_draft(_front_matter_probe(name))
    assert time.monotonic() - started < 0.1
    assert [p.code for p in exc.value.problems] == ["invalid_front_matter"]


def test_a_template_front_matter_probe_is_a_problem():
    from oracle.templates.validation import check_template

    for name in YAML_PROBES:
        started = time.monotonic()
        check = check_template(_front_matter_probe(name))
        assert time.monotonic() - started < 0.1
        assert "invalid_front_matter" in {p.code for p in check.problems}, name


@pytest.mark.parametrize("name", sorted(YAML_PROBES))
async def test_post_versions_refuses_each_probe(client, owner, name):  # noqa: F811
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
    _, auth = owner
    body = _front_matter_probe("long_decimal", "# T {#t}\n\n" + "word " * (MAX_DRAFT_BYTES // 5))
    resp = await client.post(
        "/v1/documents/big/versions",
        content=body.encode(),
        headers={**auth, "Content-Type": "text/markdown"},
    )
    assert resp.status_code == 413, resp.text
    with pytest.raises(DraftError) as exc:
        parse_draft(body)
    assert [p.code for p in exc.value.problems] == ["too_large"]


@pytest.mark.parametrize("name", sorted(YAML_PROBES))
async def test_baseline_yaml_refuses_each_probe(client, owner, name):  # noqa: F811
    _, auth = owner
    started = time.monotonic()
    resp = await client.post(
        "/v1/baseline/yaml",
        content=f"version: 1\n{YAML_PROBES[name]}\n".encode(),
        headers={**auth, "Content-Type": "application/yaml"},
    )
    assert time.monotonic() - started < 1
    assert resp.status_code == 422, resp.text


async def test_the_draft_parse_runs_off_the_event_loop(monkeypatch):
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


@pytest.mark.parametrize("name", ["base60", "deep_sequence", "alias_bomb"])
async def test_a_runs_roadmap_md_probe_fails_the_import_not_the_tick(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
    name,
):
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


@pytest.mark.parametrize("name", ["base60", "deep_mapping", "alias_bomb"])
async def test_a_runs_prd_md_probe_fails_the_import_not_the_tick(client, owner, runtime, name):  # noqa: F811
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
