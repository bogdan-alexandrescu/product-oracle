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
    # The ids stay a list, one per feedback item (#396 fixes 2).
    assert left_open.refs == {"feedback_items": [a, b]}
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
    assert "3 feedback items stay open" in message
    assert '"Problem"' in message and '"Risks"' in message and "the document" in message
    assert refs == {"feedback_items": [a, b, c]}
    one, refs = wording.feedback_left_open({a: "problem"}, headings)
    _plain(one)
    assert "1 feedback item stays open" in one and refs == {"feedback_items": [a]}


# --------------------------------------------------------------------------- every builder

# The message arguments of every warning, import problem and publish block Oracle builds.
BUILDERS = {"ImportProblem": "message", "VersionWarning": "message", "Block": "rationale"}
BUILDERS_POSITIONAL = {"PublishBlocked": 0}
# A name in a message that holds a database id (a draft's own keys, ``citation.id``, are
# what its author wrote, not ids): the builder must carry it in ``refs`` too.
ID_NAME = re.compile(r"^(?:fid|uuid|.+_ids?|.+uuid)$")
# A bare ``{x.id}`` is a database id too (#396 fixes 2): ``f"... {item.id}"``.
ID_ATTR = "id"
# Messages that echo back an id the caller itself sent, for the agent that sent it (the
# import's 422, test_import.py pins the id in the message); they carry ``refs`` as well.
# A draft's own keys (a citation's id, a strategy choice's id) are echoed the same way.
ECHOES_AN_ID = {"unknown_feedback_item", "duplicate_citation", "choice_without_section"}
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


def _names_an_id(arg: ast.AST) -> bool:
    """Whether a message interpolates a database id: a name like ``fid`` or ``item_id``, or
    a bare ``{x.id}``."""
    values = [v.value for v in ast.walk(arg) if isinstance(v, ast.FormattedValue)]
    called = {id(c.func) for v in values for c in ast.walk(v) if isinstance(c, ast.Call)}
    for v in values:
        for sub in ast.walk(v):
            if id(sub) in called:
                continue
            if isinstance(sub, ast.Name) and ID_NAME.match(sub.id):
                return True
            if isinstance(sub, ast.Attribute) and (sub.attr == ID_ATTR or ID_NAME.match(sub.attr)):
                return True
    return False


@pytest.mark.parametrize(
    "source,names",
    [
        ('VersionWarning(code="x", message=f"gone: {item.id}")', True),
        ('VersionWarning(code="x", message=f"gone: {fid}")', True),
        ('VersionWarning(code="x", message=f"gone: {row.source_item_id}")', True),
        ('VersionWarning(code="x", message=f"in {section.heading!r}")', False),
        ('VersionWarning(code="x", message=f"{len(item.ids)} open")', False),
        ('VersionWarning(code="x", message=f"{quoted(item.id)}")', True),
    ],
)
def test_the_scan_treats_a_bare_dot_id_as_an_id(source, names):
    """protects=#396 fixes 2 item 3: ``{x.id}`` in a message is an id the builder must keep in
    ``refs``; fails_when=the scan reads ``item.id`` as a plain name; no_claim=which builders
    exist (the scan below)."""
    call = ast.parse(source).body[0].value
    arg = next(k.value for k in call.keywords if k.arg == "message")
    assert _names_an_id(arg) is names


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
        code = next((k.value for k in call.keywords if k.arg == "code"), None)
        has_refs = any(k.arg == "refs" for k in call.keywords)
        if _names_an_id(arg):
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


# --------------------------------------------------------------------------- gate refusals

# #396 fixes 2: the refusals the approve, publish, review and run-start paths raise as
# errors reach the web as the response's ``detail`` (and SwarmCloud's advice becomes a run's
# note); a person reads them, so they speak the app's words too.
REFUSAL_MODULES = [
    "review/service.py",
    "review/router.py",
    "review/publish_gate.py",
    "specs/service.py",
    "specs/router.py",
    "runs/service.py",
    "runs/router.py",
    "runs/workflow.py",
    "tenant_settings_api.py",
]
# #396 fixes 3: refusals that may name an id filled in at runtime (``_names_an_id``), and
# why a person never reads that id. A 404 (``NotFound``, a review's ``not_found``) answers a
# lookup with the id the caller sent ("run {run_id} not found"): the web asks only for what
# it listed, so only an agent or a stale link meets it. The others, by their message's start:
ID_EXEMPT = {
    # An internal check of the import (docs/service.py passes its own version): an error,
    # never a refusal served to anyone.
    "version {} does not belong to document": "internal check",
    # The annotation key the caller sent (a draft's own key, like a citation's id), echoed
    # back: the web comments only on the annotations it shows.
    "no annotation {}": "echoes the caller's own key",
}
_NOT_FOUND = {"NotFound"}


def _refusal_text(arg: ast.AST, constants: dict[str, str]) -> str:
    text = ""
    for sub in ast.walk(arg):
        if isinstance(sub, ast.Constant) and isinstance(sub.value, str):
            text += sub.value
        elif isinstance(sub, ast.Name | ast.Attribute):
            text += " " + (_literal(sub, constants) or "")
    return text


def _is_a_404(call: ast.Call) -> bool:
    fn = call.func
    name = fn.id if isinstance(fn, ast.Name) else getattr(fn, "attr", None)
    first = call.args[0] if call.args else None
    return name in _NOT_FOUND or (isinstance(first, ast.Constant) and first.value == "not_found")


def _refusals() -> list[tuple[str, str, bool]]:
    """(where, text, names an id) of every refusal message raised in REFUSAL_MODULES, and of
    each of SwarmCloud's advice a run's notes carry (``runs/workflow.py`` ADVICE). An id
    filled in at runtime counts (``_names_an_id``), except in the 404s and ID_EXEMPT."""
    constants = _constants()
    out = []
    for name in REFUSAL_MODULES:
        path = ORACLE / name
        for node in ast.walk(ast.parse(path.read_text())):
            args: list[ast.AST] = []
            exempt = False
            if isinstance(node, ast.Raise) and isinstance(node.exc, ast.Call):
                call = node.exc
                exempt = _is_a_404(call)
                args = [
                    *call.args,
                    *(k.value for k in call.keywords if k.arg in ("detail", "message")),
                ]
            elif (
                isinstance(node, ast.AnnAssign)
                and getattr(node.target, "id", None) == "ADVICE"
                and isinstance(node.value, ast.Dict)
            ):
                # #481: every advice, the operator's too (its API call is in the
                # note's refs, workflow.ADVICE_REFS).
                args = list(node.value.values)
            for arg in args:
                literal = _literal(arg, constants) or ""
                names = (
                    _names_an_id(arg)
                    and not exempt
                    and not any(literal.startswith(start) for start in ID_EXEMPT)
                )
                out.append((f"{name}:{arg.lineno}", _refusal_text(arg, constants), names))
    return out


def test_every_gate_refusal_a_person_reads_speaks_the_app_s_words():
    """protects=#396 fixes 2 item 2, fixes 3 item 1: the refusals of the approve, publish,
    review and run-start paths that reach the web, and SwarmCloud's advice a run's notes
    carry (#481: the operator's too); fails_when=one carries /v1/, an HTTP method or a UUID,
    as text or as an id filled in at runtime (``{run.id}``, ``{workflow_id}``); no_claim=MCP
    tools' messages (an agent reads them), 404 lookups and ID_EXEMPT."""
    refusals = _refusals()
    assert len(refusals) > 200, "the scan found the refusals"
    assert [(where, text) for where, text, _ in refusals if wording.api_words(text)] == []
    assert [(where, text) for where, text, names in refusals if names] == []


def test_the_refusal_scan_sees_an_id_filled_in_at_runtime():
    """protects=#396 fixes 3 item 1; fails_when=the scan reads only literal text, so
    ``{run.id}`` passes; no_claim=which refusals exist (the scan above)."""
    source = 'raise SpecError(f"run {run.id} is still going")'
    call = ast.parse(source).body[0].exc
    assert _names_an_id(call.args[0]) and not _is_a_404(call)
    lookup = ast.parse('raise NotFound(f"run {run_id} not found")').body[0].exc
    assert _is_a_404(lookup)
    review = ast.parse('raise ReviewError("not_found", f"Comment {cid} not found")').body[0].exc
    assert _is_a_404(review)


# --------------------------------------------------------------------------- served refusals


async def test_a_stale_spec_s_approve_refusal_is_plain_and_keeps_its_id(client, runtime):  # noqa: F811
    """protects=#396 fixes 2 item 1: Approve on a spec version that may be stale, and the
    approval of its flow, as served; fails_when=the detail carries /v1/, a method or an id,
    or the artifact version's id is gone from refs; no_claim=when a spec is stale
    (test_specs.py)."""
    from tests import specs_helpers as h
    from tests.fixtures import draft
    from tests.test_specs import generated

    world = await h.make_world(client)
    created = await generated(client, runtime, world)
    head, viewer = world.ctx.as_("owner"), world.ctx.as_("viewer")
    v2 = draft("prd_v1.md").replace(
        "Show the shipping cost on the cart page", "Show a shipping estimate on the cart page"
    )
    assert (await h.import_md(client, head, v2)).status_code == 201
    spec = await h.get_spec(client, viewer, created["spec"]["request"]["id"])
    assert spec["freshness"] == "potentially_stale"
    spec_version = spec["versions"][0]["artifact_version"]["id"]

    slug = created["spec"]["document_slug"]
    resp = await client.post(f"/v1/documents/{slug}/versions/1/approve", headers=head)
    assert resp.status_code == 422, resp.text
    body = resp.json()
    _plain(body["detail"])
    assert "may be stale" in body["detail"] and "Potentially stale" in body["detail"]
    # #481: the refusal names the controls a person uses.
    assert CONTROLS in body["detail"], body["detail"]
    assert body["refs"] == {"artifact_version": spec_version}

    flow = next(d for d in spec["design"] if d["kind"] == "user_flow")["version"]
    resp = await client.post(
        f"/v1/design-artifacts/{flow['id']}/reviews", json={"kind": "approved"}, headers=head
    )
    assert resp.status_code == 409, resp.text
    body = resp.json()
    _plain(body["detail"])
    assert "may be stale" in body["detail"] and "Potentially stale" in body["detail"]
    assert CONTROLS in body["detail"], body["detail"]
    assert body["refs"] == {"artifact_version": flow["id"]}


# #481: where a person reviews or reconciles a spec version that may be stale.
CONTROLS = (
    "Review or reconcile it from its tech brief page (Potentially stale › Review / Reconcile)"
)


async def test_review_clears_a_stale_spec_s_label_and_approve_then_succeeds(client, runtime):  # noqa: F811
    """protects=#481 Build 2: Review on a spec version that may be stale writes the trace's
    staleness action (the Plan inspector's store), so its label clears and Approve passes;
    fails_when=the review leaves the version potentially stale, or Approve still refuses;
    no_claim=the controls on the page (web/e2e/spec-staleness.spec.ts)."""
    from tests import specs_helpers as h
    from tests.fixtures import draft
    from tests.test_specs import generated

    world = await h.make_world(client)
    created = await generated(client, runtime, world)
    head, viewer = world.ctx.as_("owner"), world.ctx.as_("viewer")
    v2 = draft("prd_v1.md").replace(
        "Show the shipping cost on the cart page", "Show a shipping estimate on the cart page"
    )
    assert (await h.import_md(client, head, v2)).status_code == 201
    spec = await h.get_spec(client, viewer, created["spec"]["request"]["id"])
    av = spec["versions"][0]["artifact_version"]["id"]
    body = {"action": "review", "artifact_version_id": av, "reason": "Checked against v2"}
    # A viewer may not mark it reviewed (the page hides the control from them).
    resp = await client.post("/v1/trace/staleness/actions", json=body, headers=viewer)
    assert resp.status_code == 403, resp.text
    resp = await client.post("/v1/trace/staleness/actions", json=body, headers=head)
    assert resp.status_code == 200, resp.text
    assert resp.json()["freshness"] == "under_review"
    spec = await h.get_spec(client, viewer, created["spec"]["request"]["id"])
    assert spec["versions"][0]["artifact_version"]["freshness"] == "under_review"
    slug = created["spec"]["document_slug"]
    resp = await client.post(f"/v1/documents/{slug}/versions/1/approve", headers=head)
    assert resp.status_code == 200, resp.text


async def test_starting_a_run_before_its_estimate_says_what_to_do(client, runtime):  # noqa: F811
    """protects=#396 fixes 2 item 2: Start on a draft run with no estimate, as served;
    fails_when=the detail names POST /v1/runs/{id}/estimate; no_claim=the cost gates
    (test_runs.py)."""
    from tests import specs_helpers as h

    world = await h.make_world(client)
    created = await h.request_spec(client, world)
    approver = world.ctx.as_("approver")
    resp = await client.post(f"/v1/runs/{created['run_id']}/start", headers=approver)
    assert resp.status_code == 409, resp.text
    _plain(resp.json()["detail"])
    assert "Estimate" in resp.json()["detail"]


async def test_regenerate_while_the_spec_s_run_is_going_says_so_in_the_app_s_words(
    client,
    runtime,  # noqa: F811
):
    """protects=#396 fixes 3 item 2: Regenerate on a spec whose run has not ended, as
    served; fails_when=the detail names the run's id, or refs loses it; no_claim=when a spec
    may be regenerated (test_specs_review2.py)."""
    from tests import specs_helpers as h

    world = await h.make_world(client)
    created = await h.request_spec(client, world)
    resp = await client.post(
        f"/v1/spec-requests/{created['spec']['request']['id']}/regenerate",
        json={"reason": "v2"},
        headers=world.ctx.as_("approver"),
    )
    assert resp.status_code == 409, resp.text
    body = resp.json()
    _plain(body["detail"])
    assert created["run_id"] not in body["detail"]
    assert "this spec's run has not ended" in body["detail"]
    assert body["refs"] == {"run": created["run_id"]}


@pytest.fixture
def swarm_settings(monkeypatch):
    """test_adapter_v2's environment (its autouse ``settings``), for one test here."""
    from tests.test_adapter_v2 import settings

    yield from settings.__wrapped__(monkeypatch)


async def test_cancel_again_names_no_workflow_id_and_keeps_it_in_refs(
    client, monkeypatch, swarm_settings
):
    """protects=#396 fixes 3 item 2: Cancel again in the Inbox, refused and done, as served;
    fails_when=the refusal or the run's note names the workflow's id, or refs loses it;
    no_claim=when Cancel again is offered (test_adapter_v2_round9.py)."""
    from tests.fixtures import seed_auth
    from tests.test_adapter_v2 import _Clock, on
    from tests.test_adapter_v2_round9 import _again, _over_after_stop
    from tests.test_runs import get

    tenant_id, auth = await seed_auth()
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _over_after_stop(client, auth, tenant_id, swarm, clock)
    resp = await _again(client, auth, run["id"], "wf_gone")
    assert resp.status_code == 409, resp.text
    body = resp.json()
    assert "wf_gone" not in body["detail"] and "nothing to cancel again" in body["detail"]
    assert body["refs"] == {"workflow": "wf_gone"}

    resp = await _again(client, auth, run["id"])
    assert resp.status_code == 200, resp.text
    notes = [n for n in (await get(client, auth, run["id"]))["notes"] if "Cancel again" in n]
    assert notes and all("wf_1" not in n for n in notes), notes


# --------------------------------------------------------------------------- Refused


def test_a_refusal_keeps_the_headers_of_the_error_it_replaces():
    """protects=#396 fixes 3 item 3: ``wording.Refused`` in place of an HTTPException keeps
    its headers (a Retry-After, a WWW-Authenticate); fails_when=Refused drops them or the
    handler does not serve them; no_claim=which refusals carry headers."""
    import asyncio

    from oracle.main import app

    refused = wording.Refused(429, "busy", {"run": ID}, headers={"Retry-After": "5"})
    assert refused.headers == {"Retry-After": "5"}
    assert wording.Refused(409, "no", {}).headers is None
    handler = app.exception_handlers[wording.Refused]
    resp = asyncio.run(handler(None, refused))
    assert resp.status_code == 429 and resp.headers["Retry-After"] == "5"
    assert resp.body == b'{"detail":"busy","refs":{"run":"' + ID.encode() + b'"}}'
