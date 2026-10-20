"""Specs review, round 8: the structure check's markdown parse is bounded (a long line of
tag-like text is refused before it is parsed, a slow parse is refused at its time cap), and
spec bodies refuse javascript:, vbscript: and data: link destinations."""

import time

import pytest

from oracle import safe_yaml
from oracle.docs.parser import parse_draft
from oracle.specs import contract
from oracle.swarm import FakeRuntime, set_runtime
from tests.specs_helpers import make_world
from tests.test_specs_review2 import generated
from tests.test_specs_review3 import _edit
from tests.test_specs_review7 import _after_anchor


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


BASE = "---\ntitle: T\nkind: spec\n---\n\n# T {#spec}\n\nIntro.\n\n## R {#r}\n\nx\n"


def _problems(body: str):
    draft = parse_draft(BASE)
    draft.sections[-1].body_md = body
    return contract.structure_problems(draft.markdown, draft)


def test_a_900_kb_line_of_tags_is_refused_quickly():
    started = time.monotonic()
    problems = _problems("<b>" * 300_000)
    assert time.monotonic() - started < 2
    assert "line_too_long" in {p.code for p in problems}


def test_a_line_just_under_the_cap_is_parsed():
    codes = {p.code for p in _problems("word " * 3_000)}  # 15,000 characters
    assert "line_too_long" not in codes


@pytest.mark.parametrize(
    "body",
    [
        "[x](javascript:alert(1))",
        "[x](JavaScript:alert(1))",
        "[x](vbscript:msgbox(1))",
        "![x](data:image/png;base64,AAAA)",
        "[x]: javascript:alert(1)\n\n[x]",
        "[x](<javascript:alert(1)>)",
    ],
)
def test_script_and_data_link_destinations_are_refused(body):
    codes = {p.code for p in _problems(body)}
    assert codes & {"script_url", "data_url"}, body


def test_https_mailto_and_relative_links_are_kept():
    codes = {p.code for p in _problems("[a](https://x.io) [b](mailto:a@b.co) [c](#r) [d](/p)")}
    assert not codes & {"script_url", "data_url"}


async def test_an_edit_whose_markdown_parse_is_too_slow_is_refused(client, runtime, monkeypatch):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    real = contract._BLOCK_MD.parse

    def slow(text, *args, **kwargs):
        if "<b>rates" in text:
            time.sleep(1.0)
        return real(text, *args, **kwargs)

    monkeypatch.setattr(contract._BLOCK_MD, "parse", slow)
    monkeypatch.setattr(safe_yaml, "PARSE_SECONDS", 0.2)
    resp = await _edit(
        client, world, created, _after_anchor("Cache <b>rates</b> for five minutes.")
    )
    assert resp.status_code == 422, resp.text
    assert "too_slow" in resp.text


def test_exports_render_a_remote_image_as_a_link_and_a_stored_image_as_an_image():
    from oracle.export import render

    for md in (render._markdown(), render._themed_markdown(False)):
        remote = md.render("![chart](https://example.com/c.png)")
        assert "<img" not in remote
        assert '<a href="https://example.com/c.png"' in remote
        assert "chart (example.com)" in remote
        assert "<img" in md.render("![stored](/uploads/a.png)")
        assert "<img" not in md.render("![x](//evil.io/a.png)")
