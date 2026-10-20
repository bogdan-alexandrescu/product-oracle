"""Untrusted YAML (oracle.safe_yaml): the probes from the security review answer fast,
with a 422/413 or a failed import, on every path that reads YAML; the repo's own YAML
(templates, fixtures, modules) parses as it did with yaml.safe_load."""

import asyncio
import gc
import re
import time
from pathlib import Path

import pytest
import yaml

from oracle import safe_yaml
from oracle.baseline import yaml_io
from oracle.docs.parser import DraftError, parse_draft, split_front_matter
from oracle.runs import flows, roadmap
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from oracle.templates.validation import check_template
from tests.fixtures import MARKDOWN, draft, import_draft, seed_auth
from tests.test_mcp import api_token, mcp_client, text_of
from tests.test_runs import get, started, tick

REPO = Path(__file__).resolve().parents[2]
FAST = 0.1  # seconds: every probe is answered within this
# ...but 50,000 values are allowed, and building them takes longer (on the parse pool).
BUDGET = {"many_nodes": 3.0}

PRD = draft("prd_v1.md")


def _nested_mapping(depth: int) -> str:
    return "probe:\n" + "".join("  " * (i + 1) + f"k{i}:\n" for i in range(depth)) + "\n"


def _laughs() -> str:
    lines = ['l0: &l0 ["lol", "lol", "lol", "lol", "lol", "lol", "lol", "lol", "lol"]']
    lines += [f"l{i}: &l{i} [{', '.join([f'*l{i - 1}'] * 9)}]" for i in range(1, 9)]
    return "\n".join(lines) + "\n"


# Lines added to the top of a valid document. Each is refused (problem regex).
REFUSED = {
    "long_decimal": ("probe: " + "9" * 5000 + "\n", r"more than 30 digits"),
    "long_decimal_float": ("probe: 1." + "9" * 100 + "\n", r"more than 30 digits"),
    "deep_sequence": ("probe: " + "[" * 1000 + "\n", r"nested more than 32"),
    "deep_flow_mapping": ("probe: " + "{a: " * 1000 + "\n", r"nested more than 32"),
    "deep_mapping": (_nested_mapping(100), r"nested more than 32"),
    "billion_laughs": (_laughs(), r"anchors and aliases"),
    "alias": ("a: &x 1\nprobe: *x\n", r"anchors and aliases"),
    "tag_binary": ("probe: !!binary aGVsbG8=\n", r"tags are not allowed"),
    "tag_verbatim": ("probe: !<tag:yaml.org,2002:str> x\n", r"tags are not allowed"),
    "tag_python": ("probe: !!python/object/apply:os.system ['true']\n", r"tags are not allowed"),
    "tag_local": ("probe: !thing x\n", r"tags are not allowed"),
    "nan": ("probe: .nan\n", r"must be finite"),
    "inf": ("probe: -.inf\n", r"must be finite"),
    "overflow": ("probe: 1.0e+999\n", r"out of range"),
    "overflow_negative": ("probe: -9.9e+999\n", r"out of range"),
    "duplicate_key": ("probe: 1\nprobe: 2\n", r"duplicate key 'probe'"),
    "control_escape": ('probe: "a\\x00b"\n', r"non-printable"),
    "control_raw": ("probe: a\x07b\n", r"non-printable"),
    "long_scalar": ("probe: " + "x" * (300 * 1024) + "\n", r"longer than 262144"),
    "many_nodes": ("probe: [" + ",".join(["1"] * 60_000) + "]\n", r"more than 50000 values"),
}
BASE60_80K = "probe: " + ":".join(["1"] * 40_000) + "\n"  # 80 KB: read as a string
BASE60_1M = "probe: " + ":".join(["1"] * 530_000) + "\n"  # over 1 MiB: refused


def with_front_matter(lines: str, text: str = PRD) -> str:
    assert text.startswith("---\n")
    return "---\n" + lines + text[4:]


def _timed(fn, *args, **kwargs):
    start = time.perf_counter()
    try:
        return fn(*args, **kwargs), None, time.perf_counter() - start
    except Exception as exc:  # noqa: BLE001
        return None, exc, time.perf_counter() - start


# --- the loader ---------------------------------------------------------------------------


@pytest.mark.parametrize("name", sorted(REFUSED))
def test_probe_is_refused_fast(name):
    text, problem = REFUSED[name]
    safe_yaml.load("warm: up")
    _, exc, took = _timed(safe_yaml.load, text)
    assert isinstance(exc, safe_yaml.SafeYamlError), exc
    assert isinstance(exc, yaml.YAMLError)
    assert re.search(problem, str(exc)), str(exc)
    assert took < BUDGET.get(name, FAST), f"{name} took {took:.3f}s"


def test_base60_is_a_string_and_fast():
    data, exc, took = _timed(safe_yaml.load, BASE60_80K)
    assert exc is None
    assert isinstance(data["probe"], str) and data["probe"].startswith("1:1:1")
    assert took < FAST
    _, exc, took = _timed(safe_yaml.load, BASE60_1M)
    assert isinstance(exc, safe_yaml.SafeYamlError) and "larger than" in str(exc)
    assert took < FAST


def test_narrowed_types():
    data = safe_yaml.load(
        "a: yes\nb: no\nc: on\nd: off\ne: true\nf: False\ng: 1:30\nh: 0x1F\ni: 012\n"
        "j: 1_000\nk: 4.2\nl: -3\nm: ~\nn: 2026-11-30\no: 2.5e+3\np: '1'\n'<<': {x: 1}\n"
        "q: 1e999\nr: 1.0e5\n"
    )
    assert data == {
        "a": "yes",
        "b": "no",
        "c": "on",
        "d": "off",
        "e": True,
        "f": False,
        "g": "1:30",
        "h": "0x1F",
        "i": "012",
        "j": "1_000",
        "k": 4.2,
        "l": -3,
        "m": None,
        "n": __import__("datetime").date(2026, 11, 30),
        "o": 2500.0,
        "p": "1",
        "<<": {"x": 1},
        "q": "1e999",  # no dot: a string in YAML 1.1 (yaml.safe_load) too
        "r": "1.0e5",  # an exponent needs its sign in YAML 1.1
    }


def test_what_safe_dump_writes_reads_back_the_same():
    """Exports (baseline YAML, a draft's front matter) are written by yaml.safe_dump."""
    data = {
        "strings": ["yes", "no", "on", "1:30", "0x1F", "012", "1_000", "1e5", "1.0e5", "~"],
        "more": ["2026-11-30", "null", "true", "<<", "=", "1e999", "+5", "", " x "],
        "numbers": [1, -3, 4.2, 2500.0, 1e20, 0.1, -0.0],
        "flags": [True, False, None],
        "date": __import__("datetime").date(2026, 11, 30),
    }
    assert safe_yaml.load(yaml.safe_dump(data, sort_keys=False, allow_unicode=True)) == data


def test_directives_and_internal_errors_are_one_error():
    for text in ("%TAG !e! tag:e,2000:\n---\na: 1\n", "%YAML 1.1\n---\na: 1\n"):
        with pytest.raises(safe_yaml.SafeYamlError, match="directives"):
            safe_yaml.load(text)
    # A date that is no date raised ValueError from yaml.safe_load.
    with pytest.raises(safe_yaml.SafeYamlError, match="could not be read"):
        safe_yaml.load("d: 2026-02-30\n")
    with pytest.raises(safe_yaml.SafeYamlError, match="larger than 10 bytes"):
        safe_yaml.load("a: 12345678901\n", limit=10)
    with pytest.raises(safe_yaml.SafeYamlError) as caught:
        safe_yaml.load("a: [\n")
    assert caught.value.line is not None


async def test_a_slow_parse_does_not_block_the_event_loop():
    """run_parse runs on the parse pool: other coroutines keep running meanwhile.

    The cyclic GC is off here: a full collection pauses every thread (the test process's
    heap takes ~0.2 s), whatever allocates; that is not the parse holding the loop."""
    heavy = "probe: [" + ",".join(["1"] * 45_000) + "]\n"  # allowed, ~0.2 s to build
    gaps: list[float] = []
    done = asyncio.Event()

    async def heartbeat():
        last = time.perf_counter()
        while not done.is_set():
            await asyncio.sleep(0.001)
            now = time.perf_counter()
            gaps.append(now - last)
            last = now

    gc.disable()
    try:
        beat = asyncio.create_task(heartbeat())
        await asyncio.sleep(0.01)
        parses = (safe_yaml.run_parse(safe_yaml.load, heavy) for _ in range(3))
        data = await asyncio.gather(*parses)
        done.set()
        await beat
    finally:
        gc.enable()
    assert all(len(d["probe"]) == 45_000 for d in data)
    assert max(gaps) < FAST, f"the loop stalled {max(gaps):.3f}s"


# --- parse_draft ---------------------------------------------------------------------------


@pytest.mark.parametrize("name", sorted(REFUSED))
def test_parse_draft_refuses_probe(name):
    lines, problem = REFUSED[name]
    parse_draft(PRD)
    _, exc, took = _timed(parse_draft, with_front_matter(lines))
    assert isinstance(exc, DraftError), exc
    assert exc.problems[0].code == "invalid_front_matter"
    assert re.search(problem, exc.problems[0].message)
    assert took < BUDGET.get(name, FAST), f"{name} took {took:.3f}s"


def test_parse_draft_base60_and_size():
    parsed, exc, took = _timed(parse_draft, with_front_matter(BASE60_80K))
    assert exc is None and isinstance(parsed.front_matter["probe"], str) and took < FAST
    _, exc, took = _timed(parse_draft, with_front_matter(BASE60_1M))
    assert isinstance(exc, DraftError) and took < FAST
    assert [p.code for p in exc.problems] == ["draft_too_large"]


def test_parse_draft_reports_the_line_of_a_refusal():
    with pytest.raises(DraftError) as caught:
        parse_draft(with_front_matter("a: 1\nprobe: &x 1\n"))
    assert caught.value.problems[0].line == 3  # the '---' line is line 1


# --- POST /v1/documents/{doc}/versions and MCP push_draft ----------------------------------


@pytest.mark.parametrize(
    "name", ["deep_sequence", "billion_laughs", "long_decimal", "tag_binary", "nan"]
)
async def test_import_version_answers_422(client, name):
    _, auth = await seed_auth()
    await import_draft(client, auth, PRD, doc="warm-up")
    start = time.perf_counter()
    resp = await import_draft(client, auth, with_front_matter(REFUSED[name][0]))
    took = time.perf_counter() - start
    assert resp.status_code == 422, resp.text
    assert resp.json()["errors"][0]["code"] == "invalid_front_matter"
    assert took < FAST, f"{name} took {took:.3f}s"


async def test_import_version_caps_the_body(client):
    _, auth = await seed_auth()
    start = time.perf_counter()
    resp = await import_draft(client, auth, with_front_matter(BASE60_1M))
    assert resp.status_code == 413, resp.text
    assert resp.json()["detail"] == "request body is larger than 1048576 bytes"
    assert time.perf_counter() - start < FAST

    # Streamed without a Content-Length: refused while reading.
    async def chunks():
        for _ in range(20):
            yield b"x" * 64 * 1024

    resp = await client.post(
        "/v1/documents/checkout-redesign/versions",
        content=chunks(),
        headers={**auth, **MARKDOWN},
    )
    assert resp.status_code == 413, resp.text


async def test_import_version_reads_base60_as_a_string(client):
    _, auth = await seed_auth()
    resp = await import_draft(client, auth, with_front_matter(BASE60_80K))
    assert resp.status_code == 201, resp.text
    assert resp.json()["front_matter"]["probe"].startswith("1:1:1")


async def test_push_draft_refuses_probes(tenant_id):
    token = await api_token(tenant_id, "owner")
    async with mcp_client(token) as c:
        for name in ("deep_sequence", "billion_laughs", "overflow"):
            pushed = await c.call_tool(
                "push_draft",
                {
                    "doc": "checkout-redesign",
                    "markdown": with_front_matter(REFUSED[name][0]),
                    "base_version": 0,
                },
            )
            assert pushed.is_error
            assert text_of(pushed).startswith("HTTP 422")
            assert "invalid_front_matter" in text_of(pushed)
        pushed = await c.call_tool(
            "push_draft",
            {
                "doc": "checkout-redesign",
                "markdown": with_front_matter(BASE60_1M),
                "base_version": 0,
            },
        )
        assert pushed.is_error and text_of(pushed).startswith("HTTP 413")


# --- POST /v1/baseline/yaml ----------------------------------------------------------------

BASELINE = "version: 1\nentities: []\nedges: []\n"


@pytest.mark.parametrize("name", sorted(REFUSED))
def test_baseline_parse_refuses_probe(name):
    _, exc, took = _timed(yaml_io._parse_and_validate, REFUSED[name][0] + BASELINE)
    assert isinstance(exc, yaml_io.YamlInvalid), exc
    assert [p.code for p in exc.problems] == ["invalid_yaml"]
    assert took < BUDGET.get(name, FAST)


@pytest.mark.parametrize("name", ["deep_sequence", "billion_laughs", "nan", "duplicate_key"])
async def test_baseline_yaml_import_answers_422(client, name):
    _, auth = await seed_auth()
    headers = {**auth, "Content-Type": "application/yaml"}
    await client.post("/v1/baseline/yaml", content=BASELINE.encode(), headers=headers)
    start = time.perf_counter()
    resp = await client.post(
        "/v1/baseline/yaml", content=(REFUSED[name][0] + BASELINE).encode(), headers=headers
    )
    took = time.perf_counter() - start
    assert resp.status_code == 422, resp.text
    assert [e["code"] for e in resp.json()["errors"]] == ["invalid_yaml"]
    assert took < FAST, f"{name} took {took:.3f}s"


async def test_baseline_yaml_import_caps_the_body(client):
    _, auth = await seed_auth()
    resp = await client.post(
        "/v1/baseline/yaml",
        content=(BASE60_1M + BASELINE).encode(),
        headers={**auth, "Content-Type": "application/yaml"},
    )
    assert resp.status_code == 413, resp.text
    assert "larger than 1048576 bytes" in resp.json()["detail"]


# --- templates and roadmap_items.yaml ------------------------------------------------------

TEMPLATE = "---\nbrief: [t]\n---\n# T {#t}\n\n## Sources and data points {#sources}\n"


@pytest.mark.parametrize("name", ["deep_sequence", "billion_laughs", "tag_python", "nan"])
def test_template_front_matter_and_layout_refuse_probes(name):
    lines = REFUSED[name][0]
    check, exc, took = _timed(check_template, "---\n" + lines + TEMPLATE[4:])
    assert exc is None and took < FAST
    assert "invalid_front_matter" in {p.code for p in check.problems}
    layout = TEMPLATE.replace("# T {#t}\n", "# T {#t}\n\n```yaml\n" + lines + "```\n")
    check, exc, took = _timed(check_template, layout)
    assert exc is None and took < FAST
    assert {p.code for p in check.problems} == {"invalid_layout"}


async def test_template_validate_route_refuses_a_probe(client):
    _, auth = await seed_auth()
    body = "---\n" + REFUSED["billion_laughs"][0] + TEMPLATE[4:]
    resp = await client.post("/v1/templates/validate", json={"body": body}, headers=auth)
    assert resp.status_code == 200, resp.text
    assert "invalid_front_matter" in {p["code"] for p in resp.json()["problems"]}


@pytest.mark.parametrize("name", ["deep_sequence", "billion_laughs", "nan"])
def test_roadmap_items_refuse_probes(name):
    check, exc, took = _timed(roadmap.check_items, REFUSED[name][0] + "items: []\n")
    assert exc is None and took < FAST
    assert [p["code"] for p in check.problems] == ["invalid_yaml"]


def test_roadmap_items_bad_date_is_invalid_yaml_not_a_crash():
    check = roadmap.check_items("items:\n  - id: a\n    milestone: {date: 2026-02-30}\n")
    assert [p["code"] for p in check.problems] == ["invalid_yaml"]


# --- a run's prd.md and baseline.yaml ------------------------------------------------------


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


@pytest.mark.parametrize("name", ["deep_sequence", "billion_laughs", "base60_1m"])
async def test_a_runs_unsafe_prd_md_fails_the_import_visibly(client, runtime, name):
    _, auth = await seed_auth()
    lines = BASE60_1M if name == "base60_1m" else REFUSED[name][0]
    prd = with_front_matter(lines, PRD.replace("checkout-redesign", "example-prd"))
    runtime.script["prd_draft"] = [Outcome(artifacts={"prd.md": prd})]
    off = dict.fromkeys(flows.FLOWS["baseline_to_prd"].checkpoints, False)
    run = await started(client, auth, checkpoints=off)
    for _ in range(4):
        await tick(client, auth)  # asserts the tick reported no errors
    run = await get(client, auth, run["id"])
    assert run["status"] == "failed"
    code = "draft_too_large" if name == "base60_1m" else "invalid_front_matter"
    assert run["error"].startswith(f"prd.md was rejected: [{code}]"), run["error"]
    assert run["segments"][3]["draft_import"]["version"] is None


async def test_a_runs_unsafe_baseline_yaml_fails_the_import_visibly(client, runtime):
    _, auth = await seed_auth()
    text = REFUSED["billion_laughs"][0] + BASELINE
    runtime.script["baseline"] = [Outcome(artifacts={"baseline.yaml": text})]
    off = dict.fromkeys(flows.FLOWS["baseline_to_prd"].checkpoints, False)
    run = await started(client, auth, checkpoints=off)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "failed"
    assert run["error"].startswith("baseline.yaml was rejected: [invalid_yaml]"), run["error"]


# --- the repo's own YAML parses as it did ----------------------------------------------------

_YAML_FENCE = re.compile(r"^```ya?ml[ \t]*\n(.*?)^```", re.S | re.M)
_SKIP_DIRS = {".git", ".github", "private", "node_modules", ".venv", ".next", "__pycache__"}


def _repo_yaml() -> list[tuple[str, str]]:
    """Every YAML file, draft/template front matter and yaml block in the repo."""
    out: list[tuple[str, str]] = []
    for path in sorted(REPO.rglob("*")):
        rel = path.relative_to(REPO)
        if _SKIP_DIRS & set(rel.parts) or not path.is_file():
            continue
        if path.suffix in (".yaml", ".yml"):
            out.append((str(rel), path.read_text(encoding="utf-8")))
        elif path.suffix == ".md":
            text = path.read_text(encoding="utf-8").replace("\r\n", "\n")
            fm, _, _ = split_front_matter(text)
            if fm is not None:
                out.append((f"{rel} (front matter)", fm))
            out += [(f"{rel} (yaml block)", m.group(1)) for m in _YAML_FENCE.finditer(text)]
    return out


def test_every_template_and_fixture_parses_as_before():
    from oracle.templates.preview import SAMPLE_PRD, SAMPLE_ROADMAP

    texts = _repo_yaml()  # the built-in templates are files under oracle/templates/builtin
    assert len(texts) > 50
    for name, body in [("SAMPLE_PRD", SAMPLE_PRD), ("SAMPLE_ROADMAP", SAMPLE_ROADMAP)]:
        fm, _, _ = split_front_matter(body.replace("\r\n", "\n"))
        if fm is not None:
            texts.append((name, fm))
        texts += [(f"{name} (yaml block)", m.group(1)) for m in _YAML_FENCE.finditer(body)]
    compared = 0
    for name, text in texts:
        try:
            before = yaml.safe_load(text)
        except yaml.YAMLError:
            with pytest.raises(safe_yaml.SafeYamlError):
                safe_yaml.load(text)
            continue
        after = safe_yaml.load(text)
        assert after == before and repr(after) == repr(before), name
        compared += 1
    assert compared > 50
