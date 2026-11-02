"""AQ1 Cards atop the review: the questions a run's agents asked at a stop.

The segment a stop reviews may write ``agent_questions.yaml`` (``questions``: each with
id, role, feature or null, question, why, options ``{key, label, detail}`` and the agent's
pick ``recommended``). Every member reads them on the stop's review page; the stop's
approver role or above answers them (:mod:`oracle.runs.actions` ``_writable``: the same
rule as staging), and may answer again until the stop is decided. The decision record
(:func:`oracle.decisions.capture.checkpoint`) carries each answer to the next step; a
question nobody answered goes with the agent's pick (:func:`decision_lines`).
"""

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, safe_yaml
from oracle.auth.deps import Principal
from oracle.authz import has_role
from oracle.runs import flows, service
from oracle.runs.models import AgentAnswer, Checkpoint, Run, RunSegment
from oracle.runs.schemas import (
    AgentAnswerOut,
    AgentOptionOut,
    AgentQuestionOut,
    AgentQuestionsOut,
)

FILE = "agent_questions.yaml"


def _text(value: Any) -> str | None:
    return str(value).strip() or None if value is not None else None


def parse(text: str | None) -> list[AgentQuestionOut]:
    """The questions in the agents' file; a row without an id, a question or two options is
    left out, and a file that does not parse asks nothing."""
    if not text:
        return []
    try:
        data = safe_yaml.load(text)
    except safe_yaml.SafeYamlError:
        return []
    rows = data.get("questions") if isinstance(data, dict) else data
    out: list[AgentQuestionOut] = []
    seen: set[str] = set()
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        qid, question = _text(row.get("id")), _text(row.get("question"))
        options = [
            AgentOptionOut(key=str(o["key"]), label=str(o.get("label") or o["key"]),
                           detail=_text(o.get("detail")))
            for o in row.get("options") or []
            if isinstance(o, dict) and _text(o.get("key"))
        ]  # fmt: skip
        if not qid or not question or len(options) < 2 or qid in seen:
            continue
        seen.add(qid)
        pick = _text(row.get("recommended"))
        out.append(
            AgentQuestionOut(
                id=qid,
                role=_text(row.get("role")) or "agent",
                feature=_text(row.get("feature")),
                question=question,
                why=_text(row.get("why")),
                options=options,
                recommended=pick if pick in {o.key for o in options} else None,
            )
        )
    return out


async def _asked(db: AsyncSession, run: Run, cp: Checkpoint) -> list[AgentQuestionOut]:
    seq = (cp.payload or {}).get("segment_seq")
    if not isinstance(seq, int):
        return []
    segment = await db.scalar(
        select(RunSegment).where(RunSegment.run_id == run.id, RunSegment.seq == seq)
    )
    files = ((segment.artifacts or {}).get("files") or {}) if segment else {}
    text = files.get(FILE)
    return parse(text if isinstance(text, str) else None)


async def _next_step(db: AsyncSession, run: Run, cp: Checkpoint) -> str | None:
    """The title of the step after the stop's segment that runs (one whose stop is off is
    recorded skipped at launch); None after the last."""
    flow = flows.FLOWS.get(run.flow)
    seq = (cp.payload or {}).get("segment_seq")
    if flow is None or not isinstance(seq, int):
        return None
    name = await db.scalar(
        select(RunSegment.name)
        .where(RunSegment.run_id == run.id, RunSegment.seq > seq, RunSegment.status != "skipped")
        .order_by(RunSegment.seq)
        .limit(1)
    )
    titles = {s.name: s.title for s in flow.segments}
    return titles.get(name) if name else None


async def _answered(
    db: AsyncSession, principal: Principal | None, run: Run, cp: Checkpoint
) -> list[AgentQuestionOut]:
    from oracle.runs.actions import _people

    asked = await _asked(db, run, cp)
    if not asked:
        return []
    rows = {
        a.question_key: a
        for a in await db.scalars(select(AgentAnswer).where(AgentAnswer.checkpoint_id == cp.id))
    }
    people = await _people(db, [a.answered_by for a in rows.values() if a.answered_by])
    me = principal.id if principal is not None else None
    for q in asked:
        a = rows.get(q.id)
        if a is not None and a.option in {o.key for o in q.options}:
            q.answer = AgentAnswerOut(
                option=a.option,
                note=a.note,
                by=people.get(a.answered_by) if a.answered_by else None,
                at=a.answered_at,
                mine=a.answered_by is not None and a.answered_by == me,
            )
    return asked


async def _stop(db: AsyncSession, run_id: uuid.UUID, checkpoint_id: uuid.UUID):
    run = await service._get_run(db, run_id)
    cp = await db.scalar(
        select(Checkpoint).where(Checkpoint.id == checkpoint_id, Checkpoint.run_id == run.id)
    )
    if cp is None:
        raise service.NotFound(f"checkpoint {checkpoint_id} not found")
    return run, cp


async def read(
    db: AsyncSession, principal: Principal, run_id: uuid.UUID, checkpoint_id: uuid.UUID
) -> AgentQuestionsOut:
    """The stop's agent questions with their answers, any member."""
    run, cp = await _stop(db, run_id, checkpoint_id)
    return AgentQuestionsOut(
        questions=await _answered(db, principal, run, cp),
        next_step=await _next_step(db, run, cp),
        can_answer=cp.status == "pending" and has_role(principal.role, cp.approver_role),  # type: ignore[arg-type]
    )


async def answer(
    db: AsyncSession,
    principal: Principal,
    run_id: uuid.UUID,
    checkpoint_id: uuid.UUID,
    question_id: str,
    option: str,
    note: str | None,
) -> None:
    """Answer one question (the stop's approver role or above, while it is pending);
    answering again replaces the answer. Audited."""
    from oracle.runs.actions import _writable

    run, cp = await _writable(db, principal, run_id, checkpoint_id, stage=True)
    q = next((q for q in await _asked(db, run, cp) if q.id == question_id), None)
    if q is None:
        raise service.NotFound(f"question {question_id} not found")
    if option not in {o.key for o in q.options}:
        raise service.Invalid(f"{option} is not an option of this question")
    note = _text(note)
    row = await db.scalar(
        select(AgentAnswer).where(
            AgentAnswer.checkpoint_id == cp.id, AgentAnswer.question_key == q.id
        )
    )
    if row is None:
        row = AgentAnswer(checkpoint_id=cp.id, question_key=q.id, option=option)
        db.add(row)
    row.option, row.note, row.answered_by = option, note, principal.id
    row.answered_at = service._now()
    await audit.record(
        db,
        principal,
        "checkpoint.agent_question_answered",
        "checkpoint",
        cp.id,
        {"run_id": str(run.id), "question": q.id, "option": option},
    )
    await db.commit()


async def decision_lines(db: AsyncSession, run: Run, cp: Checkpoint) -> list[str]:
    """The answers, as the decision record gives them to the next step's agent: each
    question with the option chosen (and its note), or the agent's pick when nobody
    answered."""
    lines: list[str] = []
    for q in await _answered(db, None, run, cp):
        label = {o.key: o.label for o in q.options}
        if q.answer is not None:
            line = f"- {q.question}: {label[q.answer.option]}"
            if q.answer.by is not None:
                line += f" (answered by {q.answer.by.name})"
            if q.answer.note:
                line += f'. Note: "{q.answer.note}"'
        elif q.recommended:
            line = f"- {q.question}: {label[q.recommended]} (the agent's pick, not answered)"
        else:
            line = f"- {q.question}: not answered"
        lines.append(line)
    return ["Answers to the agents' questions (settled):", *lines] if lines else []
