"""raw-tokens-everywhere: a generated text people are shown or export never carries a raw
citation token ("[c:id]", "[l:n]", "[s:id]"); a citation becomes the footnote the export
already uses, or is dropped when it points to nothing."""

import re
from dataclasses import dataclass
from datetime import UTC, datetime
from types import SimpleNamespace

from oracle.export.render import ExportVersion, _Footnotes, _markdown, render_markdown
from oracle.raw_tokens import has_raw_tokens, markdown_footnotes, strip_raw_tokens

RAW = re.compile(r"\[[cls]:")


def test_strip_raw_tokens_drops_every_kind_with_its_space():
    text = "Teams plan by capacity [c:capacity]. Reads [l:2] and sees [s:convdef], [c:a, b]."
    assert strip_raw_tokens(text) == "Teams plan by capacity. Reads and sees,."
    assert strip_raw_tokens("Nested [c:[c:x]a] and open [c:gametric") == "Nested and open gametric"
    assert not has_raw_tokens(strip_raw_tokens("x [c:[c:[c:y]]] z"))
    # Ordinary brackets and links stay.
    assert strip_raw_tokens("See [the plan](https://example.com) [1].") == (
        "See [the plan](https://example.com) [1]."
    )


def test_markdown_footnotes_number_known_citations_and_drop_unknown_ones():
    labels = {"capacity": "Capacity plan (upload notes.pdf)", "c2": "Funnel review"}
    out = markdown_footnotes(
        "Capacity is low [c:capacity]. Funnel [c:c2, f-aice]; again [c:capacity] [l:3].\n",
        labels.get,
    )
    assert out == (
        "Capacity is low[^1]. Funnel[^2]; again[^1].\n\n"
        "[^1]: Capacity plan (upload notes.pdf)\n"
        "[^2]: Funnel review\n"
    )
    assert markdown_footnotes("Only [c:f-aice] here.", labels.get) == "Only here."


@dataclass
class _V:
    number: int = 2
    markdown: str = ""
    created_at: datetime = datetime(2026, 10, 16, tzinfo=UTC)
    approved_at: datetime | None = None


@dataclass
class _D:
    slug: str = "planning"
    title: str = "Planning PRD"
    status: str = "draft"


@dataclass
class _C:
    cite_key: str
    source: str
    ref: str
    title: str | None = None
    excerpt: str | None = None


def test_markdown_export_carries_footnotes_not_raw_tokens():
    md = (
        "---\ndocument: planning\n---\n\n# Planning PRD {#title}\n\n"
        "Teams plan by capacity [c:capacity]; the AI estimate [c:f-aice] is off.\n\n"
        "## Sources and data points {#sources}\n- capacity upload: Capacity plan [c:capacity]\n"
    )
    ev = ExportVersion(
        document=_D(),
        version=_V(markdown=md),
        sections=[],
        citations=[_C("capacity", "upload", "capacity-plan.pdf", "Capacity plan")],
        latest_number=2,
    )
    out = render_markdown(ev)
    assert not RAW.search(out), out
    assert "Teams plan by capacity[^1]; the AI estimate is off." in out
    assert out.rstrip().endswith("[^1]: Capacity plan (upload capacity-plan.pdf)")
    assert out.startswith("---\ndocument: planning\n---\n<!-- Product Oracle export:")


def test_html_and_pdf_body_drop_a_citation_that_points_to_nothing():
    """The HTML export and the PDF (rendered from it) number known citations and drop
    unknown ones and other raw markers, never "[c:f-aice]" as text."""
    env = {"footnotes": _Footnotes(by_key={"capacity": object()})}
    html = _markdown().render("By capacity [c:capacity], estimate [c:f-aice] and [l:2].", env)
    assert not RAW.search(html), html
    assert '<a href="#fn-1"' in html


def test_storyboard_and_flow_words_carry_no_raw_tokens():
    """The one-pager's opened storyboard reads its flow's nodes: no "[c:gametric]"."""
    from oracle.simple.visuals import _flow

    v = SimpleNamespace(subject_kind="one_pager_line", subject_id=None)
    ver = SimpleNamespace(
        title="Game metric flow [c:gametric]",
        steps=[
            {"id": "s1", "label": "Open the game metric [c:gametric]", "kind": "step"},
            {
                "id": "s2",
                "label": "Is it a conversion? [c:convdef]",
                "kind": "decision",
                "yes": "Count it [c:convdef]",
                "no": "Skip it [s:x]",
                "actor": "App",
            },
        ],
        screen={"title": "Metrics [c:gametric]", "regions": ["Chart [c:convdef]", "Filters"]},
        number=1,
        goal="Lift conversion [l:1]",
        flow_svg="<svg><text>Open the game metric [c:gametric]</text></svg>",
        wireframe_html="<div>Chart [c:convdef]</div>",
        annotations=[{"n": 1, "target": "s1", "note": "From the metric [c:gametric]"}],
        created_at=datetime(2026, 11, 3, tzinfo=UTC),
    )
    flow = _flow(v, ver, 1)
    assert not RAW.search(flow.model_dump_json()), flow.model_dump_json()
    assert flow.nodes[1].label == "Is it a conversion?"
    assert flow.nodes[1].yes == "Count it" and flow.steps[0] == "Open the game metric"
    assert flow.screen.regions == ["Chart", "Filters"]
