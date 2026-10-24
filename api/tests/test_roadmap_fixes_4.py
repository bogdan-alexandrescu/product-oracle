"""Roadmap review fixes, round 4 (PR #87 review).

B1. The round-3 probes (base-60, a 5,000-digit number, deep nesting, an alias bomb)
    against every YAML Oracle reads from outside: a draft's front matter (parse_draft,
    POST /versions, a run's prd.md / roadmap.md import), baseline.yaml and templates. One
    safe loader (oracle.safe_yaml), off the event loop; POST /versions capped at 1 MB.
"""

import time

import pytest

from oracle import safe_yaml
from oracle.config import get_settings
from oracle.docs.parser import DraftError, parse_draft
from oracle.runs import flows
from oracle.runs import roadmap as items_file
from oracle.swarm import Outcome
from tests.fixtures import import_draft
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


@pytest.mark.timing
@pytest.mark.parametrize("name", sorted(YAML_PROBES))
def test_parse_draft_refuses_each_probe_in_front_matter_at_once(name):
    started = time.monotonic()
    with pytest.raises(DraftError) as exc:
        parse_draft(_front_matter_probe(name))
    assert time.monotonic() - started < 0.1
    assert [p.code for p in exc.value.problems] == ["invalid_front_matter"]


@pytest.mark.timing
def test_a_template_front_matter_probe_is_a_problem():
    from oracle.templates.validation import check_template

    for name in YAML_PROBES:
        started = time.monotonic()
        check = check_template(_front_matter_probe(name))
        assert time.monotonic() - started < 0.1
        assert "invalid_front_matter" in {p.code for p in check.problems}, name


@pytest.mark.timing
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


@pytest.mark.timing
@pytest.mark.parametrize("name", ["deep_mapping", "deep_sequence", "alias_bomb"])
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


@pytest.mark.timing
@pytest.mark.parametrize("name", ["long_decimal", "deep_mapping", "alias_bomb"])
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


# --------------------------------------------------------------------------- M1

# Each a way to write 2026-12-15 (no basis of the PRD supports it) that a reader sees as
# that date. ENG-412 supports 2026-11-30 only.
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
    from tests.test_roadmap import built_roadmap

    _, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    for probe in DATE_PROBES:
        resp = await import_draft(client, auth, _with_paragraph(probe), ROADMAP)
        assert resp.status_code == 422, (probe, resp.text)
        assert {e["code"] for e in resp.json()["errors"]} == {"unverified_date"}, probe
    # The control: the verified date, and month or quarter phrases, import.
    ok = _with_paragraph("Beta 30 Nov 2026, GA in Q4 2026 or December 2026.")
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
    _, auth = owner
    await approved_prd(client, auth)
    await _run_import(client, auth, runtime, _with_paragraph("\n\n".join(DATE_PROBES)))
    version = (await client.get(f"{VERSIONS}/1", headers=auth)).json()
    warnings = [w for w in version["warnings"] if w["code"] == "unverified_date"]
    assert len(warnings) == len(DATE_PROBES), [w["message"] for w in warnings]
    flagged = [m for m in version["date_marks"] if m["status"] == "unverified"]
    assert len(flagged) == len(DATE_PROBES)
    assert all(m["label"] == "unverified" for m in flagged)
    # The verified Beta date stays unmarked.
    assert ("2026-11-30", "verified") in {(m["text"], m["status"]) for m in version["date_marks"]}
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
    assert html.count("Dec 15, 2026 <strong>[unverified]</strong>") == 2
    assert "<code>2026-12-15</code> <strong>[unverified]</strong>" in html
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
    _, auth = owner
    await approved_prd(client, auth)
    await _run_import(client, auth, runtime, _with_paragraph("GA 2026-12-15."))
    resp = await client.post(f"{VERSIONS}/1/approve", headers=auth)
    assert resp.status_code == 409, resp.text
    body = resp.json()
    assert "2026-12-15" in body["detail"]
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
    assert [d["status"] for d in resp.json()["dates"]] == ["withdrawn"]


# --------------------------------------------------------------------------- minors


async def test_a_database_error_while_checking_items_rolls_back_and_the_tick_goes_on(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
    monkeypatch,
):
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
    # A row that only mentions it after another item's link: the first item link owns it.
    other = ROADMAP_MD.replace(
        "| [Payment step](#now-payment-step) | Buyers pay without re-entering their card |",
        "| [Payment step](#now-payment-step) | After [ship](#next-shipping-step) 2026-12-15 |",
    )
    assert (await import_draft(client, auth, other, ROADMAP)).status_code == 422


async def test_a_roadmap_takes_its_prd_from_its_own_link_not_from_its_text(client, owner):  # noqa: F811
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
        resp = await refine("now-payment-step", "GA 2026-12-15. Beta by 2026-11-30.")
        assert resp.status_code == 422, resp.text
    finally:
        gateway.set_transports(previous)


async def test_a_disabled_owner_is_refused_once_the_column_exists(client, owner):  # noqa: F811
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
