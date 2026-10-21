"""Specs review, round 9.

- M1 every markdown parse of untrusted text is bounded: a line over 20,000 characters is
  refused by one linear check before any parse (every draft, not only a spec); a
  megabyte of '![' in short lines is refused at once; prose with long lines is read
  quickly; a parse that is still slow stops at its CPU budget, so slow posts can not hold
  the parse pool, and a queue wait never makes an honest import fail; a spec edit is at
  most MAX_SPEC_BYTES.
- javascript:, vbscript: and data: destinations are refused in every spelling a
  raw-markdown reader may follow: entity-encoded, after control characters, as an
  autolink, and in reference definitions inside quotes or lists or with escaped or
  multi-line labels.
- The exports: a remote image no longer escapes the rest of the HTML, a stored image keeps
  its alt text, and only a path under /uploads/ is a stored image.
"""

import asyncio
import io
import re
import time

import pytest
from pypdf import PdfReader

from oracle import safe_yaml
from oracle.docs.parser import DraftError, parse_draft
from oracle.export import pptx, render
from oracle.export.pdf import pdf_available
from oracle.swarm import FakeRuntime, set_runtime
from tests.baseline_helpers import make_ctx
from tests.specs_helpers import import_md, make_world
from tests.test_specs_review2 import generated
from tests.test_specs_review3 import _edit
from tests.test_specs_review7 import _after_anchor
from tests.test_specs_review8 import _problems

FRONT = "---\ntitle: Probe\n---\n\n# Probe {#probe}\n\n"
SMALL = "---\ntitle: Small\n---\n\n# Small {#small}\n\nA small honest draft.\n"
# 55 lines of 18,000 characters: about a megabyte, every line under the cap, one paragraph.
IMAGE_OPENERS = "\n".join(["![" * 9_000] * 55)
# Prose in lines of 19,999 characters.
LONG_PROSE_LINE = "word " * 3_999 + "word"


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


def _refused_quickly(text: str) -> set[str]:
    started = time.monotonic()
    with pytest.raises(DraftError) as exc:
        parse_draft(text)
    assert time.monotonic() - started < 2
    return {p.code for p in exc.value.problems}


async def _import_quickly(client, text: str, doc: str = "probe"):
    ctx = await make_ctx()
    started = time.monotonic()
    resp = await import_md(client, ctx.as_("owner"), text, doc=doc)
    assert time.monotonic() - started < 2, resp.text[:300]
    return resp


# --------------------------------------------------------------------------- M1


def test_a_900_kb_line_of_tags_is_refused_before_any_parse():
    assert _refused_quickly(FRONT + "<b>" * 300_000 + "\n") == {"line_too_long"}


async def test_a_900_kb_line_of_tags_is_refused_at_import(client):
    resp = await _import_quickly(client, FRONT + "<b>" * 300_000 + "\n")
    assert resp.status_code == 422 and "line_too_long" in resp.text


def test_a_line_over_the_cap_is_named_by_its_line():
    with pytest.raises(DraftError) as exc:
        parse_draft(FRONT + "ok\n\n" + "x" * 20_001 + "\n")
    [problem] = exc.value.problems
    assert problem.code == "line_too_long" and problem.line == 9


@pytest.mark.parametrize("separator", ["\n", "\n\n"])
def test_a_megabyte_of_image_openers_in_short_lines_is_refused_quickly(separator):
    text = FRONT + IMAGE_OPENERS.replace("\n", separator) + "\n"
    assert len(text) > 900_000
    assert _refused_quickly(text)


async def test_a_megabyte_of_image_openers_is_refused_quickly_at_import(client):
    resp = await _import_quickly(client, FRONT + IMAGE_OPENERS + "\n")
    assert resp.status_code == 422, resp.text[:300]


def test_a_megabyte_of_prose_in_long_lines_is_read_quickly():
    text = FRONT + "\n".join([LONG_PROSE_LINE] * 48) + "\n"
    assert len(text) > 950_000
    started = time.monotonic()
    draft = parse_draft(text)
    assert time.monotonic() - started < 2
    assert draft.sections[0].body_text.startswith("word word")


async def test_a_megabyte_of_prose_in_long_lines_imports_quickly(client):
    resp = await _import_quickly(client, FRONT + "\n".join([LONG_PROSE_LINE] * 48) + "\n")
    assert resp.status_code == 201, resp.text[:300]


async def test_a_spec_edit_of_prose_in_long_lines_is_checked_quickly(client, runtime):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    prose = "\n\n".join([LONG_PROSE_LINE] * 8)  # 160 KB: under the spec cap
    started = time.monotonic()
    resp = await _edit(client, world, created, _after_anchor(prose))
    assert time.monotonic() - started < 2
    assert resp.status_code in (200, 201), resp.text[:300]


async def test_a_spec_edit_over_the_spec_cap_is_refused(client, runtime):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    prose = "\n\n".join([LONG_PROSE_LINE] * 11)  # 220 KB
    started = time.monotonic()
    resp = await _edit(client, world, created, _after_anchor(prose))
    assert time.monotonic() - started < 2
    assert resp.status_code == 422 and "too_large" in resp.text, resp.text[:300]


async def test_a_queue_wait_does_not_count_against_the_parse_cap():
    loop = asyncio.get_running_loop()
    # Every worker of the parse pool is busy for longer than the cap.
    busy = [loop.run_in_executor(safe_yaml._EXECUTOR, time.sleep, 0.6) for _ in range(4)]
    assert await safe_yaml.run_parse_within(len, "abc", seconds=0.2) == 3
    await asyncio.gather(*busy)


async def test_slow_posts_do_not_make_a_small_honest_import_fail(client, monkeypatch):
    monkeypatch.setattr(safe_yaml, "PARSE_SECONDS", 0.3)
    owner = (await make_ctx()).as_("owner")
    # Nested brackets (depth 10, closed): slow for markdown-it, under every linear cap.
    slow = FRONT + "\n".join(["[[[[[[[[[[a]]]]]]]]]] " * 800] * 6) + "\n"
    posts = [asyncio.create_task(import_md(client, owner, slow, doc=f"slow-{i}")) for i in range(8)]
    await asyncio.sleep(0.05)  # the slow posts hold the parse pool first
    resp = await import_md(client, owner, SMALL, doc="small")
    assert resp.status_code == 201, resp.text[:300]
    for done in await asyncio.gather(*posts):
        assert done.status_code in (201, 422), done.text[:300]


# --------------------------------------------------------------------------- script URLs


@pytest.mark.parametrize(
    "body",
    [
        "[x](&#106;avascript:alert(1))",
        "[x](&#x6A;avascript:alert(1))",
        "[x](java&#115;cript:alert(1))",
        "[x](javascript&colon;alert(1))",
        "[x](\x01javascript:alert(1))",
        "[x](\x00javascript:alert(1))",
        "[x](<\x01javascript:alert(1)>)",
        "[x](jav&#x09;ascript:alert(1))",
        "<javascript:alert(1)>",
        "<vbscript:msgbox(1)>",
        "> [x]: javascript:alert(1)\n\n[x]",
        "- [x]: javascript:alert(1)\n\n[x]",
        "[a\\]b]: javascript:alert(1)\n\n[a\\]b]",
        "[a\nb]: javascript:alert(1)\n\n[a b]",
        "[x]:\n  javascript:alert(1)\n\n[x]",
        "[x]: &#106;avascript:alert(1)\n\n[x]",
        "![x](&#100;ata:image/png;base64,AAAA)",
        "[x]: <data:text/html,hi>\n\n[x]",
    ],
)
def test_script_and_data_destinations_are_refused_in_every_spelling(body):
    codes = {p.code for p in _problems(body)}
    assert codes & {"script_url", "data_url"}, body


@pytest.mark.parametrize(
    "body",
    [
        "Escaped text \\[x\\](javascript:alert(1)) stays text.",
        "`javascript:` URLs are refused; see https://example.com/security.",
        "[a](https://x.io) [b](mailto:a@b.co) [c](#r) [d](/p) <https://example.com/x>",
    ],
)
def test_text_about_script_urls_and_safe_links_are_kept(body):
    codes = {p.code for p in _problems(body)}
    assert not codes & {"script_url", "data_url"}, body


# --------------------------------------------------------------------------- exports


IMAGES_BODY = (
    "Before ![relative host](//e.com/p.png) after.\n\n"
    "![remote chart](https://e.com/q.png)\n\n"
    "![stored chart](/uploads/rollout.png)\n\n"
    "![evil](/\\evil.com/p.png) ![other](/v1/me) ![dots](/uploads/../v1/me) "
    "![encoded](/uploads/%2e%2e/v1/me)\n\n"
    "Last **paragraph**.\n"
)
STORED_IMG = '<img src="/uploads/rollout.png" alt="stored chart">'


def _check_images_html(html: str) -> None:
    assert "&lt;p&gt;" not in html and "&lt;strong&gt;" not in html, html
    assert "<p>Last <strong>paragraph</strong>.</p>" in html, html
    assert re.findall(r"<img [^>]*>", html) == [STORED_IMG], html
    assert re.search(r'<a href="https://e.com/q.png"[^>]*>remote chart \(e.com\)</a>', html)
    # Not a stored image and no http(s) host: the alt text, as text.
    for alt in ("relative host", "evil", "other", "dots", "encoded"):
        assert re.search(rf"(?<![\w\"=]){alt}(?![\w\"])", re.sub(r"<[^>]+>", " ", html)), alt
    assert "evil.com" not in html


def test_the_export_renderers_show_images_by_the_rule():
    for md in (render._markdown(), render._themed_markdown(False)):
        _check_images_html(md.render(IMAGES_BODY, {"footnotes": render._Footnotes({})}))


async def test_html_and_pdf_exports_show_images_by_the_rule(client):
    owner = (await make_ctx()).as_("owner")
    draft = "---\ntitle: Images\n---\n\n# Images {#images}\n\n" + IMAGES_BODY
    resp = await import_md(client, owner, draft, doc="images")
    assert resp.status_code == 201, resp.text
    url = "/v1/documents/images/versions/1/export"
    resp = await client.get(url, params={"format": "html"}, headers=owner)
    assert resp.status_code == 200, resp.text
    _check_images_html(resp.text)
    if not pdf_available():
        return
    resp = await client.get(url, params={"format": "pdf"}, headers=owner)
    assert resp.status_code == 200, resp.text
    text = " ".join(page.extract_text() for page in PdfReader(io.BytesIO(resp.content)).pages)
    text = re.sub(r"\s+", " ", text)
    assert "remote chart (e.com)" in text and "Last paragraph." in text, text
    assert "<p>" not in text and "&lt;" not in text, text


def test_slides_show_an_image_as_its_label():
    blocks = pptx.parse_blocks(IMAGES_BODY)
    paras = [item for item in blocks.items if isinstance(item, pptx.Para)]
    text = " ".join(r.text for p in paras for r in p.runs)
    for label in ("relative host", "remote chart (e.com)", "stored chart", "evil", "dots"):
        assert label in text, (label, text)
