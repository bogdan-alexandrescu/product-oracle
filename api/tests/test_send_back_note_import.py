"""A send-back with only a note imports; a refused draft goes back to its writer (Nov 3).

At a review stop sent back with a note and no feedback items, the writer answers the
note's points as resolutions with no ``feedback_id`` (``kind: note``): the import records
them against the note. A malformed resolution never refuses the whole draft: it is
dropped with a warning. A refused draft sent back with no note carries the import's
problems to the writer, and the stop names the problem in plain words.
"""

import pytest

from oracle.docs.parser import parse_draft
from tests.fixtures import draft, import_draft, seed_auth
from tests.test_retry_draft_import import OLDER, _decide, _rejected, owner, runtime  # noqa: F401
from tests.test_runs import get, pending

V1 = draft("prd_v1.md")

NOTE_ANSWERS = """resolutions:
  - id: note-1
    kind: note
    status: addressed
    note: Shortened the summary to three lines
  - id: note-2
    status: declined
    note: The launch date stays, as the brief says
  - feedback_id: not-a-feedback-id
    status: addressed
"""


def _with_resolutions(text: str, block: str) -> str:
    head, rest = text.split("\n", 1)
    return f"{head}\n{block}{rest}"


def test_note_answers_parse_and_a_bad_resolution_is_dropped():
    parsed = parse_draft(_with_resolutions(V1, NOTE_ANSWERS))
    assert parsed.resolutions == []
    assert [(n.id, n.status) for n in parsed.note_resolutions] == [
        ("note-1", "addressed"),
        ("note-2", "declined"),
    ]
    assert parsed.note_resolutions[1].note == "The launch date stays, as the brief says"
    assert len(parsed.dropped_resolutions) == 1
    assert "resolution #3" in parsed.dropped_resolutions[0]
    assert "feedback item" in parsed.dropped_resolutions[0]


def test_the_production_note_answers_without_a_kind_parse():
    # The writer's own shape on Nov 3: note-1..note-8, no feedback_id, no kind.
    block = "resolutions:\n" + "".join(
        f"  - id: note-{i}\n    status: addressed\n    note: Point {i} done\n" for i in range(1, 9)
    )
    parsed = parse_draft(_with_resolutions(V1, block))
    assert [n.id for n in parsed.note_resolutions] == [f"note-{i}" for i in range(1, 9)]
    assert parsed.dropped_resolutions == []


async def test_a_draft_with_note_answers_and_a_bad_resolution_imports(client):
    _, auth = await seed_auth()
    resp = await import_draft(client, auth, _with_resolutions(V1, NOTE_ANSWERS))
    assert resp.status_code == 201, resp.text
    warnings = resp.json()["warnings"]
    dropped = [w for w in warnings if w["code"] == "resolution_dropped"]
    assert len(dropped) == 1 and "resolution #3" in dropped[0]["message"]
    answered = [w for w in warnings if w["code"] == "note_answered"]
    assert len(answered) == 1
    assert "2 points" in answered[0]["message"]


async def test_send_back_to_writer_with_no_note_sends_the_import_problems(
    client, owner, runtime, monkeypatch
):
    _, auth = owner
    run = await _rejected(client, auth, runtime, monkeypatch)
    resp = await _decide(client, auth, run, "changes_requested", None)
    assert resp.status_code == 200, resp.text
    run = resp.json()
    assert run["status"] == "running"
    assert run["segments"][4]["status"] in ("queued", "running")
    prompt = runtime.submitted[-1].steps[-1].prompt
    assert OLDER in prompt
    assert "was refused at import" in prompt


async def test_the_stop_names_the_import_problem_in_plain_words(
    client, owner, runtime, monkeypatch
):
    _, auth = owner
    run = await _rejected(client, auth, runtime, monkeypatch)
    blocked = pending(run)["cannot_approve"]
    assert blocked.startswith("Oracle refused prd.md: 1 citation is invalid (source)."), blocked
    assert blocked.endswith("Retry import, or send it back to the writer.")
    resp = await _decide(client, auth, run)
    assert resp.status_code == 409 and resp.json()["detail"] == blocked
    run = await get(client, auth, run["id"])
    assert pending(run)["cannot_approve"] == blocked


@pytest.mark.parametrize(
    ("message", "plain"),
    [
        ("resolution #1 is invalid: feedback_id", "1 resolution names no feedback item"),
    ],
)
def test_a_refused_resolution_reads_in_plain_words(message, plain):
    from oracle.docs.schemas import ImportProblem
    from oracle.runs import rejection

    text = rejection.summary(
        "roadmap.md", [ImportProblem(code="invalid_resolution", message=message)]
    )
    assert text == f"Oracle refused roadmap.md: {plain}."
