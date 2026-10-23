"""#396 Warnings speak the app's words: every version warning and publish-gate message a
person sees says what to do in the app (record a date basis on Plan › Dates), names the
document by its title and the section by its heading, and never carries an HTTP method,
an API route or a raw id. The ids stay in the machine fields (``code``, ``refs``,
``section_keys``) for agents and the API. One helper (:mod:`oracle.wording`) builds and
checks these messages, and rewrites the old wording stored on versions before #396.
Against Postgres with the FakeRuntime for the import and approve paths."""

import ast
import re
import uuid
from datetime import date
from pathlib import Path

import pytest

from oracle import wording
from oracle.docs import service as docs_service
from oracle.docs.schemas import ImportProblem, VersionWarning
from oracle.review import publish_gate
from oracle.review.schemas import PublishBlock
from oracle.roadmap import doc_dates, schedule
from tests.test_roadmap import (  # noqa: F401 - fixtures
    PRD,
    approved_prd,
    owner,
    runtime,
)
from tests.test_roadmap_fixes_4 import VERSIONS, _run_import, _with_paragraph

API_WORDS = re.compile(
    r"/v1/|\b(GET|POST|PUT|PATCH|DELETE)\b"
    r"|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
    re.IGNORECASE,
)
ID = "00000000-0000-0000-0000-000000000000"

LEGACY_DATE = (
    "the date 2026-01-01 (section roadmap, line 1) rests on no verified estimate, capacity "
    "or commitment of PRD example-prd for this item; record one (POST /v1/schedule-bases) "
    "or drop the date. Oracle never invents dates"
)
LEGACY_LEFT_OPEN = (
    "an agent's draft closes feedback only as addressed, and only on a section whose text "
    "or evidence it changed in this version; these stay open: "
)
LEGACY_CITATION = (
    f"citation 'bl-example' names source item '{ID}', which this company does not have; "
    "the citation is kept without it"
)


def _plain(text: str) -> None:
    assert not API_WORDS.search(text), text
    assert wording.api_words(text) == [], text


def _mark(status: str = "unverified", **kw) -> doc_dates.Mark:
    defaults = dict(
        section_key="now-payment-step",
        text="2026-12-15",
        day=date(2026, 12, 15),
        status=status,
        line=1,
        bases=["ENG-412"] if status == "withdrawn" else [],
    )
    return doc_dates.Mark(**{**defaults, **kw})


MARKS = [
    _mark(),
    _mark(line=0),
    _mark(where="title", section_key=""),
    _mark("withdrawn"),
    _mark(days=(date(2026, 12, 1), date(2026, 1, 12)), text="12/1/2026"),
]


# --------------------------------------------------------------------------- builders


@pytest.mark.parametrize("mark", MARKS, ids=lambda m: f"{m.status}-{m.where}-{m.line}")
@pytest.mark.parametrize(
    "prd,update", [("Checkout redesign PRD", False), (None, False), (None, True)]
)
def test_every_date_message_says_what_to_do_in_the_app(mark, prd, update):
    """protects=#396 the date warning, the import refusal and the withdrawn note name
    Plan › Dates, the PRD by its title and the section by its heading;
    fails_when=a message carries an API route, an HTTP method or a raw id, or names the
    section by its key; no_claim=which dates are marked (test_roadmap_doc_dates.py)."""
    msg = doc_dates.problem_message(mark, prd, update=update, heading="Payment step")
    _plain(msg)
    assert "Plan › Dates" in msg and "now-payment-step" not in msg
    if mark.where != "title":
        assert '"Payment step"' in msg
    if prd and mark.status != "withdrawn":
        assert '"Checkout redesign PRD"' in msg


def test_the_item_and_track_date_refusals_say_what_to_do_in_the_app():
    for msg in (schedule.UNVERIFIED, schedule.OUTSIDE_NOW, doc_dates.SOURCES_NOT_LAST):
        _plain(msg)
    assert "Plan › Dates" in schedule.UNVERIFIED and "never invents dates" in schedule.UNVERIFIED


def test_the_citation_warning_names_a_source_item_oracle_no_longer_has():
    for headings in (["Problem"], ["Problem", "Decisions"], []):
        msg = wording.unknown_source_item(headings)
        _plain(msg)
        assert "a source item Oracle no longer has" in msg
        for h in headings:
            assert f'"{h}"' in msg


def test_the_publish_gate_message_names_headings_and_plan_dates():
    marks = [_mark(), _mark("withdrawn", text="2026-11-30", day=date(2026, 11, 30))]
    headings = {"now-payment-step": "Payment step"}
    detail, blocks = publish_gate.dates_refusal(marks, headings)
    _plain(detail)
    assert "Plan › Dates" in detail and '"Payment step"' in detail
    assert "now-payment-step" not in detail
    for b in blocks:
        _plain(b.rationale)
        # The ids stay in the machine field.
        assert b.key == "unverified_date" and b.id.startswith("now-payment-step:")


# --------------------------------------------------------------------------- the helper


def test_the_old_stored_wording_is_rewritten_and_its_ids_move_to_refs():
    """protects=#396 versions imported before #396 show the new wording when served;
    fails_when=a stored message still reaches the web with a route or a raw id, or the
    rewrite loses an id agents need; no_claim=the stored JSON is not rewritten (it is read
    through the helper)."""
    assert wording.api_words(LEGACY_DATE) == ["POST", "/v1/"]
    assert wording.api_words(LEGACY_CITATION) == [ID]
    date_warning = VersionWarning(code="unverified_date", message=LEGACY_DATE)
    _plain(date_warning.message)
    assert "record a date basis on Plan › Dates" in date_warning.message
    citation = VersionWarning(code="unknown_citation_item", message=LEGACY_CITATION)
    _plain(citation.message)
    assert "a source item Oracle no longer has" in citation.message
    # The ids the old wording carried are kept, in the machine field.
    assert citation.refs == {"cite_key": "bl-example", "source_item": ID}
    a, b = str(uuid.uuid4()), str(uuid.uuid4())
    left_open = VersionWarning(code="resolution_not_applied", message=f"{LEGACY_LEFT_OPEN}{a}, {b}")
    _plain(left_open.message)
    assert "2 feedback items stay open" in left_open.message
    assert left_open.refs == {"feedback_items": f"{a}, {b}"}
    # Plain text is left as it is.
    plain = VersionWarning(code="x", message="sections approved in version 1 changed: scope")
    assert plain.message == "sections approved in version 1 changed: scope"


def test_nothing_else_is_rewritten_so_no_id_is_lost():
    """protects=the ids in messages #396 does not reword (an import's unknown feedback item,
    test_import.py); fails_when=a served model rewrites a message it does not know, swapping
    an id for "an item"; no_claim=which builders reach the web (the scan below)."""
    message = f"resolution references unknown feedback item {ID}"
    assert ImportProblem(code="unknown_feedback_item", message=message).message == message
    other = f"something about {ID} (see POST /v1/things)"
    assert VersionWarning(code="x", message=other).message == other
    assert PublishBlock(key="k", id=ID, title="t", rationale=other).rationale == other


def test_a_warning_keeps_its_ids_in_refs():
    w = VersionWarning(
        code="unknown_citation_item",
        message=wording.unknown_source_item(["Problem"]),
        refs={"cite_key": "bl-example", "source_item": ID},
    )
    assert w.model_dump()["refs"] == {"cite_key": "bl-example", "source_item": ID}
    assert VersionWarning(code="x", message="y").refs == {}


def test_feedback_an_agent_s_draft_left_open_is_named_by_section():
    """protects=#396 the Warnings panel's "these stay open" names sections by heading;
    fails_when=it lists feedback ids, or refs loses them; no_claim=which feedback a run may
    close (test_review_v2_security_2.py)."""
    a, b, c = (str(uuid.uuid4()) for _ in range(3))
    headings = {"problem": "Problem", "risks": "Risks"}
    message, refs = wording.feedback_left_open({a: "problem", b: "risks", c: None}, headings)
    _plain(message)
    assert '3 feedback items stay open' in message
    assert '"Problem"' in message and '"Risks"' in message and "the document" in message
    assert refs == {"feedback_items": f"{a}, {b}, {c}"}
    one, refs = wording.feedback_left_open({a: "problem"}, headings)
    _plain(one)
    assert "1 feedback item stays open" in one and refs == {"feedback_items": a}


# --------------------------------------------------------------------------- every builder

# The message arguments of every warning, import problem and publish block Oracle builds.
BUILDERS = {"ImportProblem": "message", "VersionWarning": "message", "Block": "rationale"}
BUILDERS_POSITIONAL = {"PublishBlocked": 0}
# A name in a message that holds a database id (a draft's own keys, ``citation.id``, are
# what its author wrote, not ids): the builder must carry it in ``refs`` too.
ID_NAME = re.compile(r"^(?:fid|uuid|.+_ids?|.+uuid)$")
# Messages that echo back an id the caller itself sent, for the agent that sent it (the
# import's 422, test_import.py pins the id in the message); they carry ``refs`` as well.
ECHOES_AN_ID = {"unknown_feedback_item"}
ORACLE = Path(__file__).resolve().parents[1] / "oracle"


def _constants() -> dict[str, str]:
    """Every module-level string constant in oracle/, by name (messages reuse them)."""
    out: dict[str, str] = {}
    for path in ORACLE.rglob("*.py"):
        for node in ast.parse(path.read_text()).body:
            if isinstance(node, ast.Assign) and len(node.targets) == 1:
                target, value = node.targets[0], node.value
                if isinstance(target, ast.Name):
                    text = _literal(value, {})
                    if text is not None:
                        out[target.id] = text
    return out


def _literal(node: ast.AST, constants: dict[str, str]) -> str | None:
    """The literal text of ``node``: its strings and the constants it names, with each
    interpolated value as ``{}``."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        return "".join(_literal(v, constants) or "{}" for v in node.values)
    if isinstance(node, ast.FormattedValue):
        return None
    if isinstance(node, ast.BinOp):
        return (_literal(node.left, constants) or "{}") + (_literal(node.right, constants) or "{}")
    if isinstance(node, ast.Name | ast.Attribute):
        return constants.get(node.id if isinstance(node, ast.Name) else node.attr)
    return None


def _builds() -> list[tuple[str, ast.Call, ast.AST]]:
    out = []
    for path in sorted(ORACLE.rglob("*.py")):
        for node in ast.walk(ast.parse(path.read_text())):
            if not isinstance(node, ast.Call):
                continue
            fn = node.func
            name = fn.id if isinstance(fn, ast.Name) else getattr(fn, "attr", None)
            where = f"{path.relative_to(ORACLE.parent)}:{node.lineno}"
            if name in BUILDERS:
                arg = next((k.value for k in node.keywords if k.arg == BUILDERS[name]), None)
            elif name in BUILDERS_POSITIONAL and node.args:
                arg = node.args[BUILDERS_POSITIONAL[name]]
            else:
                continue
            if arg is not None:
                out.append((where, node, arg))
    return out


def test_every_message_builder_speaks_the_app_s_words_and_keeps_ids_in_refs():
    """protects=#396 Done when 1: every warning, import problem and publish block a person
    can see, wherever it is built; fails_when=a builder writes an HTTP method or a /v1/
    route into a message, or puts an id in a message without carrying it in ``refs``;
    no_claim=the runtime wording of each builder (the tests above)."""
    constants = _constants()
    builds = _builds()
    assert len(builds) > 60, "the scan found the builders"
    routes, ids = [], []
    for where, call, arg in builds:
        text = ""
        for sub in ast.walk(arg):
            if isinstance(sub, ast.Constant) and isinstance(sub.value, str):
                text += " " + sub.value
            elif isinstance(sub, ast.Name | ast.Attribute):
                text += " " + (_literal(sub, constants) or "")
        if wording.api_words(text):
            routes.append((where, text))
        values = [v.value for v in ast.walk(arg) if isinstance(v, ast.FormattedValue)]
        called = {id(c.func) for v in values for c in ast.walk(v) if isinstance(c, ast.Call)}
        named = [
            sub.id if isinstance(sub, ast.Name) else sub.attr
            for v in values
            for sub in ast.walk(v)
            if isinstance(sub, ast.Name | ast.Attribute) and id(sub) not in called
        ]
        code = next((k.value for k in call.keywords if k.arg == "code"), None)
        has_refs = any(k.arg == "refs" for k in call.keywords)
        if any(ID_NAME.match(n) for n in named):
            echo = isinstance(code, ast.Constant) and code.value in ECHOES_AN_ID
            if not has_refs or not echo:
                ids.append(where)
    assert (routes, ids) == ([], [])


def test_an_echoed_feedback_id_is_in_refs_too():
    """protects=agents keep the ids (Done when 3); fails_when=the unknown feedback item's
    problem loses its id from the message or from refs; no_claim=the import's other
    refusals (test_import.py)."""
    p = docs_service.unknown_feedback_item(uuid.UUID(ID))
    assert ID in p.message and p.refs == {"feedback_item": ID}


# --------------------------------------------------------------------------- served


async def test_a_run_s_date_warning_and_the_approve_refusal_are_plain(client, owner, runtime):  # noqa: F811
    """protects=#396 the roadmap version's Warnings panel and Approve's 409 as served;
    fails_when=the served warning or the 409 detail carries /v1/, a method or an id, or the
    ids agents need are gone; no_claim=the Warnings panel layout (e2e/version-warnings)."""
    _, auth = owner
    await approved_prd(client, auth)
    await _run_import(client, auth, runtime, _with_paragraph("GA 2026-12-15."))
    version = (await client.get(f"{VERSIONS}/1", headers=auth)).json()
    (w,) = [w for w in version["warnings"] if w["code"] == "unverified_date"]
    _plain(w["message"])
    assert "Plan › Dates" in w["message"] and "2026-12-15" in w["message"]
    assert '"Payment step"' in w["message"] and "Checkout redesign" in w["message"]
    # The ids agents need: the section key, the date and the PRD's slug.
    assert w["section_keys"] == ["now-payment-step"]
    assert w["refs"] == {"date": "2026-12-15", "prd": PRD}
    for other in version["warnings"]:
        _plain(other["message"])

    resp = await client.post(f"{VERSIONS}/1/approve", headers=auth)
    assert resp.status_code == 409, resp.text
    body = resp.json()
    _plain(body["detail"])
    assert "Plan › Dates" in body["detail"] and "2026-12-15" in body["detail"]
    for b in body["blocking"]:
        _plain(b["rationale"])
    assert [b["id"] for b in body["blocking"]] == ["now-payment-step:2026-12-15"]
