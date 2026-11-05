"""The questions people answered at a run's stops, as decided calls.

Two kinds of question are answered at a stop before it is approved:

- the architect's questions of the tech briefs at the Engineering check (``eng_review``:
  ``answer:<question id>`` edits, recorded on approval in ``payload["briefs"]``,
  :mod:`oracle.engineering.check`);
- the agents' questions on the Questions from the agents cards of any stop (AQ1,
  :mod:`oracle.runs.agent_questions`), the feature-set stop's among them.

Once the stop is approved each answer is decided. This module reads them in one shape
(:class:`Answered`) for:

- the run page's Decisions (``RunDecision.answers``, :func:`of_checkpoints`);
- the PRD writer's prompt (:func:`prompt_lines`): each answer stated as decided, with the
  person, the stop and the stop's decision record (its D-number), never as open;
- the PRD import (:func:`open_problems`): a draft that still lists an answered question
  under Decisions needed or Open questions is refused, naming the question.

A stop's notes are carried already (``PromptContext.reviewer_notes``).
"""

import re
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.docs.schemas import ImportProblem
from oracle.runs.models import Checkpoint, Run

ANSWERED_OPEN = "answered_listed_open"
# The segments that write the PRD and read the answers as decided.
WRITERS = ("prd_draft",)
STOPS = {
    "eng_review": "Engineering review",
    "feature_set": "Feature set",
    "priority_order": "Priority order",
    "prd_review": "PRD review",
}
# The PRD sections that list what is still undecided: by id, else by heading words.
OPEN_IDS = ("decisions", "decisions-needed", "open-questions", "open-decisions")
OPEN_WORDS = ("decisions needed", "open questions", "open decisions", "undecided")


@dataclass
class Answered:
    checkpoint_id: uuid.UUID
    kind: str
    question: str
    answer: str
    feature: str | None = None
    by: uuid.UUID | None = None
    by_name: str | None = None
    at: datetime | None = None

    @property
    def stop(self) -> str:
        return STOPS.get(self.kind, self.kind.replace("_", " ").capitalize())


def _uuid(value: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value)) if value else None
    except ValueError:
        return None


def _when(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(str(value)) if value else None
    except ValueError:
        return None


async def engineering(db: AsyncSession, cp: Checkpoint) -> list[Answered]:
    from oracle.engineering import check as eng_check

    check = (cp.payload or {}).get(eng_check.PAYLOAD_KEY)
    if cp.kind != eng_check.KIND or not isinstance(check, dict):
        return []
    recorded = await eng_check.recorded_of(db, cp)
    features = {f["key"]: f for f in eng_check._features(cp)}
    out: list[Answered] = []
    for key, listed in (recorded.get("answers") or {}).items():
        feature = features.get(key) or {}
        asked = {q.get("id"): q.get("question") for q in feature.get("questions") or []}
        title = feature.get("title")
        name = f"{key} {title}" if title and title != key else key
        for a in listed:
            question = a.get("question") or asked.get(a.get("question_id"))
            answer = str(a.get("answer") or "").strip()
            if not question or not answer:
                continue
            out.append(
                Answered(
                    checkpoint_id=cp.id, kind=cp.kind, question=str(question), answer=answer,
                    feature=name, by=_uuid(a.get("by")) or cp.decided_by,
                    at=_when(a.get("at")) or cp.decided_at,
                )
            )  # fmt: skip
    return out


async def _agents(db: AsyncSession, run: Run, cp: Checkpoint) -> list[Answered]:
    from oracle.runs import agent_questions

    out: list[Answered] = []
    for q in await agent_questions._answered(db, None, run, cp):
        if q.answer is None:
            continue
        label = {o.key: o.label for o in q.options}.get(q.answer.option, q.answer.option)
        answer = f"{label}. Note: {q.answer.note}" if q.answer.note else label
        out.append(
            Answered(
                checkpoint_id=cp.id, kind=cp.kind, question=q.question, answer=answer,
                feature=q.feature, by=q.answer.by.id if q.answer.by else None,
                by_name=q.answer.by.name if q.answer.by else None, at=q.answer.at,
            )
        )  # fmt: skip
    return out


async def named(db: AsyncSession, answers: list[Answered]) -> list[Answered]:
    from oracle.runs import service

    ids = {a.by for a in answers if a.by is not None and a.by_name is None}
    names = await service._people_named(db, ids)
    for a in answers:
        if a.by_name is None and a.by is not None:
            a.by_name = names.get(a.by)
    return answers


async def of_checkpoint(db: AsyncSession, run: Run, cp: Checkpoint) -> list[Answered]:
    """The questions answered at the stop, each with who answered it and when."""
    return await named(db, [*await engineering(db, cp), *await _agents(db, run, cp)])


async def of_checkpoints(
    db: AsyncSession, runs: dict[uuid.UUID, Run], cps: list[Checkpoint]
) -> dict[uuid.UUID, list[Answered]]:
    """:func:`of_checkpoint` of approved stops (a stop sent back decided nothing)."""
    out: dict[uuid.UUID, list[Answered]] = {}
    for cp in cps:
        if cp.status == "approved" and cp.run_id in runs:
            out[cp.id] = await of_checkpoint(db, runs[cp.run_id], cp)
    return out


async def of_run(db: AsyncSession, run: Run) -> list[Answered]:
    """Every question answered at the run's approved stops, the latest approval of a stop
    kind only (an earlier attempt's answers were asked again), in stop order."""
    cps = list(
        await db.scalars(
            select(Checkpoint)
            .where(Checkpoint.run_id == run.id, Checkpoint.status == "approved")
            .order_by(Checkpoint.decided_at.desc())
        )
    )
    latest: dict[str, Checkpoint] = {}
    for cp in cps:
        latest.setdefault(cp.kind, cp)
    ordered = sorted(
        latest.values(), key=lambda c: ((c.payload or {}).get("segment_seq") or 0, c.decided_at)
    )
    out: list[Answered] = []
    for cp in ordered:
        out += await of_checkpoint(db, run, cp)
    return out


async def _numbers(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, int]:
    """The decision record (its D-number) of each approved stop."""
    from oracle.decisions.models import Decision

    if not ids:
        return {}
    rows = await db.execute(
        select(Decision.source_id, Decision.number).where(
            Decision.source_kind == "checkpoint", Decision.source_id.in_(ids)
        )
    )
    return {sid: n for sid, n in rows.all() if sid is not None}


async def prompt_lines(db: AsyncSession, run: Run, segment: str) -> list[str]:
    """What the PRD writer reads of the answers: each stated as decided, with its stop, the
    person and the day, and the stop's decision record to cite."""
    if segment not in WRITERS:
        return []
    answers = await of_run(db, run)
    if not answers:
        return []
    from oracle import company_time

    zone = await company_time.company_time_zone(db)
    numbers = await _numbers(db, {a.checkpoint_id for a in answers})
    lines = [
        "Decided at this run's stops: a person answered each question below and approved "
        "the stop, so each is a decision, never an open question. State each answer as "
        "decided in the body where it belongs (Approach, Requirements, Rules and the "
        "feature's own section), cite it like a decision with its D-number, and never list "
        "it under Decisions needed or Open questions:",
    ]
    for a in answers:
        n = numbers.get(a.checkpoint_id)
        where = f"{a.stop} (D-{n})" if n else a.stop
        who = f"answered by {a.by_name}" if a.by_name else "answered"
        if a.at is not None:
            who += f" on {company_time.day_in_words(a.at, zone)}"
        about = f"{a.feature}: " if a.feature else ""
        lines.append(f'- {where}, {who}: {about}"{a.question}" Decided: "{a.answer}"')
    return lines


def decision_lines(answers: list[Answered]) -> list[str]:
    """The answers as a stop's decision record carries them (``list_decisions``)."""
    if not answers:
        return []
    lines = ["Answers to the architect's questions (decided):"]
    for a in answers:
        about = f"{a.feature}: " if a.feature else ""
        by = f" (answered by {a.by_name})" if a.by_name else ""
        lines.append(f'- {about}"{a.question}" → "{a.answer}"{by}')
    return lines


# --------------------------------------------------------------------------- import check

_HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*(?:\{#([^}\s]+)\})?\s*$")


def _words(text: str) -> str:
    return " ".join(re.sub(r"[^0-9a-z]+", " ", text.lower()).split())


def open_sections(markdown: str) -> list[tuple[str, str, str]]:
    """The draft's sections that list what is undecided: (id, title, text), each with its
    subsections."""
    lines = markdown.splitlines()
    out: list[tuple[str, str, str]] = []
    fence = False
    heads: list[tuple[int, int, str, str]] = []
    for i, line in enumerate(lines):
        if line.lstrip().startswith(("```", "~~~")):
            fence = not fence
        if fence:
            continue
        m = _HEADING.match(line)
        if m:
            heads.append((i, len(m[1]), m[2].strip(), m[3] or ""))
    for n, (i, level, title, sid) in enumerate(heads):
        named = _words(title)
        if sid not in OPEN_IDS and not any(w in named for w in OPEN_WORDS):
            continue
        end = next((j for j, lv, _, _ in heads[n + 1 :] if lv <= level), len(lines))
        out.append((sid, title, "\n".join(lines[i + 1 : end])))
    return out


def listed_open(answers: list[Answered], markdown: str) -> list[ImportProblem]:
    """An answered question the draft still lists as undecided, once per question."""
    sections = [(sid, title, _words(text)) for sid, title, text in open_sections(markdown)]
    out: list[ImportProblem] = []
    seen: set[str] = set()
    for a in answers:
        asked = _words(a.question)
        if not asked or asked in seen:
            continue
        for sid, title, text in sections:
            if asked in text:
                seen.add(asked)
                by = f" by {a.by_name}" if a.by_name else ""
                out.append(
                    ImportProblem(
                        code=ANSWERED_OPEN,
                        message=f'"{a.question}" was answered at {a.stop}{by} '
                        f'("{a.answer}"), but the draft lists it under {title} as undecided: '
                        "state the answer as decided in the body and take it out of "
                        f"{title}",
                        section_key=sid or None,
                    )
                )
                break
    return out


async def open_problems(db: AsyncSession, run: Run, markdown: str) -> list[ImportProblem]:
    """:func:`listed_open` for the run's answers."""
    answers = await of_run(db, run)
    return listed_open(answers, markdown) if answers else []
