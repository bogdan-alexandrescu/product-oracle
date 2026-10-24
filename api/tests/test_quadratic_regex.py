"""Regexes that run on untrusted draft text outside markdown-it must be linear.

A run of spaces between two words made ``CITATION_STRIP_RE`` and ``SECTION_ID_RE`` quadratic
(0.75 s and 1.0 s per 20,000-character line): the CPU budget never fired, the regex engine
held the GIL, and four ~1 MB posts starved the event loop and the 4-thread parse pool.
"""

import asyncio
import time

import pytest

from oracle.docs.parser import CITATION_STRIP_RE, SECTION_ID_RE, DraftError, parse_draft
from tests.fixtures import draft, import_draft, seed_auth
from tests.test_mcp import api_token

PRD = draft("prd_v1.md")
CPU_LIMIT = 2.0
SPACES = 19_990


def _line(prefix: str = "") -> str:
    return f"{prefix}a" + " " * SPACES + "b"


def _body(lines: int = 12) -> str:
    return PRD + "\n" + "\n".join(_line() for _ in range(lines)) + "\n"


def _headings(lines: int = 12) -> str:
    return PRD + "\n" + "\n".join(_line("# ") for _ in range(lines)) + "\n"


SHAPES = {"body": _body, "headings": _headings}


@pytest.mark.parametrize("shape", sorted(SHAPES))
def test_parse_draft_is_linear_on_a_space_run(shape):
    text = SHAPES[shape]()
    start = time.process_time()
    try:
        parse_draft(text)
    except DraftError:
        pass
    took = time.process_time() - start
    assert took < CPU_LIMIT, f"{shape} took {took:.2f}s of CPU"


@pytest.mark.parametrize("shape", sorted(SHAPES))
async def test_import_is_linear_on_a_space_run(client, shape):
    _, auth = await seed_auth()
    text = SHAPES[shape]()
    start = time.process_time()
    resp = await import_draft(client, auth, text)
    took = time.process_time() - start
    assert resp.status_code in (201, 413, 422), resp.text
    assert took < CPU_LIMIT, f"{shape} import took {took:.2f}s of CPU"


@pytest.mark.timing
@pytest.mark.parametrize("shape", sorted(SHAPES))
async def test_honest_import_after_four_big_posts(client, shape):
    tenant, auth = await seed_auth()
    big = SHAPES[shape](50)  # ~1 MB
    assert len(big.encode()) < 1024 * 1024
    await import_draft(client, auth, PRD)
    start = time.perf_counter()
    posts = [
        asyncio.create_task(
            import_draft(
                client,
                auth,
                big.replace("document: checkout-redesign", f"document: big-{i}", 1),
                doc=f"big-{i}",
            )
        )
        for i in range(4)
    ]
    await asyncio.sleep(0)
    # Another person's: one person has at most two parses at once.
    honest = await import_draft(client, {"Authorization": f"Bearer {await api_token(tenant)}"}, PRD)
    took = time.perf_counter() - start
    assert honest.status_code in (200, 201), honest.text[:300]
    assert took < 10, f"the honest import took {took:.1f}s behind four big posts"
    await asyncio.gather(*posts, return_exceptions=True)


def test_regexes_keep_their_behaviour_on_normal_text():
    strip = CITATION_STRIP_RE.sub
    assert strip("", "Users drop off [c:c1] at shipping.") == "Users drop off at shipping."
    assert strip("", "[c:c1] first\t[c:c2]") == " first"
    assert strip("", "a[c:x]b") == "ab"
    assert strip("", "no cite [c: x] here") == "no cite [c: x] here"
    text = "Goals  {#goals}  "
    m = SECTION_ID_RE.search(text)
    assert m and m.group(1) == "goals" and text[: m.start()] == "Goals"
    assert SECTION_ID_RE.search("{#a}") and SECTION_ID_RE.search("x {#a} y") is None


def _fast(fn, limit=0.15):
    start = time.process_time()
    fn()
    took = time.process_time() - start
    assert took < limit, f"took {took:.2f}s of CPU"


def test_citation_re_is_linear_on_open_markers():
    from oracle.docs.parser import CITATION_RE

    text = ("[c:" * 6_600 + "\n") * 50
    _fast(lambda: list(CITATION_RE.finditer(text)))
    assert CITATION_RE.findall("a [c:c1] b [c:c2]") == ["c1", "c2"]


def test_quality_bullets_are_linear_on_blank_lines():
    from oracle.quality.text import _BULLET

    for text in ("\n" * 20_000, " \n" * 10_000, "\n" * 20_000 + "x", "-" + " \n" * 10_000 + "x"):
        _fast(lambda text=text: list(_BULLET.finditer(text)))
    found = _BULLET.findall("- one\n  * two  \n3. three\n4) four\nnot - a bullet\n")
    assert [b.strip() for b in found] == ["one", "two", "three", "four"]


def test_template_title_line_is_linear():
    from oracle.templates.service import draft_skeleton

    def skeleton(body: str) -> str:
        return draft_skeleton(
            "---\ntitle: T\n---\n" + body,
            slug="s",
            title="My title",
            kind="prd",
            template="t",
            version=1,
            theme=None,
        )

    for body in (
        "# a" + " " * 20_000 + "b\n",
        ("#" + " " * 100 + "\n") * 200,
        "# " + "{#" * 10_000,
    ):
        _fast(lambda body=body: skeleton(body))
    assert "# My title   {#goals}" in skeleton("# Old   {#goals}\n\ntext\n")
    assert "# My title{#goals}" in skeleton("# {#goals}\n")
