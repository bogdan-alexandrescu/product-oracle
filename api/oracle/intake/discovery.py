"""A brief's answer "unknown; finding out is part of this work" is work, never a blocker
(owner, walk 2 problem 19).

When the honest answer to a brief's question is that nobody knows yet and finding out is
part of the work ("Unknown; finding the platform's limits is part of this work"), the
answer plans work rather than leaving the question open: its question is answered and its
gap settled (no review wait, B4 is about claims, not plans), the brief lists it under
``work`` as a requirement cited to the answer, the draft writer writes it as a
requirement in the PRD and, when it gates a date, an early discovery item with its own
estimate, and a run's draft that lists it as a blocker, or leaves it out, is refused
(:func:`draft_problems`, checked in ``oracle.runs.service._import_draft``).

:func:`is_discovery` reads plain words: something is unknown (or not checked yet) and
finding it out is part of the work, the team will find out, or a discovery step does;
"not part of this work" and "outside this work" are never work.
"""

import re
import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

import yaml
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.docs.schemas import ImportProblem
from oracle.intake import categories as cats
from oracle.v2.models import KnowledgeGap, StakeholderAnswer, StakeholderQuestion

# The answer kinds that may say it: a real answer, or "don't know" with a note.
KINDS = ("answer", "dont_know")
# How a draft cites the answer (a urn ref; the citation contract allows it).
CITE_REF = "urn:oracle:answer:{id}"

_UNKNOWN = re.compile(
    r"\b(unknown|not (yet )?known|(don't|do not|doesn't|does not|didn't|did not) know|"
    r"(no one|nobody) knows|not sure|unsure|unclear|not clear|no idea|"
    r"(no one|nobody) (has )?(checked|looked|measured|tested)|"
    r"(haven't|have not|hasn't|has not|not) (yet )?(been )?"
    r"(checked|measured|tested|confirmed|verified|looked)|tbd|"
    r"to be (found|determined|confirmed|checked))\b"
)
# Finding something out: the verbs a person uses for it.
_FINDING = (
    r"\b(find(s|ing)?|found|figur(e|es|ing)|work(s|ing)? (it|them|this|that|these|those) out|"
    r"learn(s|ing)?|discover(s|ing|y)?|check(s|ing)?|measur(e|es|ing)|test(s|ing)?|"
    r"investigat(e|es|ing|ion)|research(es|ing)?|spike)\b"
)
_PART = r"\bpart of (this|the|our) (work|project|job|plan|build|scope|effort|feature|prd)\b"
_FINDING_IS_PART = re.compile(_FINDING + r"[^.;!?]{0,80}?" + _PART)
_WE_WILL_FIND = re.compile(
    r"\b(we'll|we will|we're going to|the team will|will be) "
    r"(find|figure|work|found|figured|worked)( (it|them|this|that))? out\b"
)
_DISCOVERY_STEP = re.compile(r"\b(discovery|spike)\b")
_NOT_PART = re.compile(
    r"\b(not|never|isn't|aren't|nor)\b[^.;!?]{0,30}"
    + _PART
    + r"|\boutside (of )?(this|the|our) (work|scope|project|plan)\b|\bout of scope\b"
)


def _plain(text: str) -> str:
    return " ".join(text.replace("’", "'").replace("‘", "'").lower().split())


def is_discovery(text: str | None) -> bool:
    """Whether ``text`` says the thing is unknown and finding it out is part of the work."""
    if not text or not text.strip():
        return False
    t = _plain(text)
    if _NOT_PART.search(t):
        return False
    if _FINDING_IS_PART.search(t):
        return True
    return bool(
        _UNKNOWN.search(t)
        and (re.search(_PART, t) or _WE_WILL_FIND.search(t) or _DISCOVERY_STEP.search(t))
    )


# What to find out, by category; any other: "Find out the <category label>".
_REQUIREMENTS = {
    "third_party_policy": "Find out the platform's policy and API limits",
    "blockers": "Find out what could stop this shipping",
}


def requirement_for(category: str, statement: str) -> str:
    """The requirement such an answer makes of a gap: what to find out."""
    if category in _REQUIREMENTS:
        return _REQUIREMENTS[category]
    c = cats.BY_KEY.get(category)
    if c is not None:
        return f"Find out the {c.label[0].lower()}{c.label[1:]}"
    return f"Find out: {statement.rstrip('.')}"


@dataclass(frozen=True)
class Work:
    """One answer that became work: the requirement and its answer."""

    gap_id: uuid.UUID
    question_id: uuid.UUID
    answer_id: uuid.UUID
    requirement: str
    answer: str

    @property
    def cite_ref(self) -> str:
        return CITE_REF.format(id=self.answer_id)


async def work_of(
    db: AsyncSession,
    questions: Iterable[StakeholderQuestion],
    gaps: dict[uuid.UUID, KnowledgeGap],
    keep: set[uuid.UUID] | None = None,
) -> list[Work]:
    """The work the latest answer of each question (of a gap in ``gaps``) makes; only the
    answers in ``keep`` when given (a run's pinned answers)."""
    qs = [q for q in questions if q.gap_id is not None and q.gap_id in gaps]
    if not qs:
        return []
    rows = await db.scalars(
        select(StakeholderAnswer)
        .where(StakeholderAnswer.question_id.in_([q.id for q in qs]))
        .order_by(StakeholderAnswer.created_at, StakeholderAnswer.id)
    )
    latest: dict[uuid.UUID, StakeholderAnswer] = {}
    for a in rows:
        if keep is None or a.id in keep:
            latest[a.question_id] = a
    out = []
    for q in qs:
        a = latest.get(q.id)
        if a is None or a.kind not in KINDS or not is_discovery(a.body):
            continue
        gap = gaps[q.gap_id]  # type: ignore[index]
        out.append(
            Work(gap.id, q.id, a.id, requirement_for(gap.category, gap.statement), a.body or "")
        )
    return out


async def run_work(db: AsyncSession, intake_id: uuid.UUID, keep: set[uuid.UUID]) -> list[Work]:
    """The work a run from the intake drafts: of its pinned answers, on the gaps everyone
    may see (a private gap's answer gates nothing, S6)."""
    from oracle.intake import sharing
    from oracle.v2.models import ProductIntake

    intake = await db.get(ProductIntake, intake_id)
    if intake is None or not keep:
        return []
    reg = sharing.registry(intake)
    gaps = {
        g.id: g
        for g in await db.scalars(select(KnowledgeGap).where(KnowledgeGap.intake_id == intake_id))
        if sharing.gating_view(g, reg) is not None
    }
    questions = await db.scalars(
        select(StakeholderQuestion).where(StakeholderQuestion.intake_id == intake_id)
    )
    return await work_of(db, questions, gaps, keep)


# A line or heading that holds something up.
_BLOCKER = re.compile(
    r"\bblock(s|ed|er|ers|ing)?\b|\bwaits? on\b|\bwaiting on\b|\bon hold\b|\bstops? the draft\b",
    re.IGNORECASE,
)
_SECTION_ID = re.compile(r"\{#([^}\s]+)\}")


def _front(markdown: str) -> tuple[dict, list[str], int]:
    """(the front matter, the body's lines, the line number the body starts at)."""
    lines = markdown.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, lines, 1
    end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
    if end is None:
        return {}, lines, 1
    try:
        front = yaml.safe_load("\n".join(lines[1:end])) or {}
    except yaml.YAMLError:
        front = {}
    return (front if isinstance(front, dict) else {}), lines[end + 1 :], end + 2


def _as_blocker(w: Work) -> ImportProblem:
    return ImportProblem(
        code="discovery_as_blocker",
        message=f"“{w.requirement}” is listed as a blocker. The brief's answer says finding "
        "it out is part of this work: write it as a requirement, and as an early discovery "
        "item with its own estimate when it gates a date, never as a blocker.",
        refs={"answer_id": str(w.answer_id)},
    )


def draft_problems(markdown: str, work: Sequence[Work]) -> list[ImportProblem]:
    """A draft's problems with the brief's work: each must be a requirement cited to its
    answer (``discovery_not_planned``), never a blocker (``discovery_as_blocker``: under a
    blockers heading, on a line saying it blocks, or under ``blockers`` in the front
    matter)."""
    if not work:
        return []
    front, body, start = _front(markdown)
    citations = front.get("citations") if isinstance(front.get("citations"), list) else []
    listed = front.get("blockers") if isinstance(front.get("blockers"), list) else []
    problems: list[ImportProblem] = []
    for w in work:
        key = str(w.answer_id).lower()
        chips = {
            str(c.get("id"))
            for c in citations
            if isinstance(c, dict) and c.get("id") and key in str(c.get("ref") or "").lower()
        }
        if not chips:
            problems.append(
                ImportProblem(
                    code="discovery_not_planned",
                    message=f"The brief's answer “{w.answer}” makes finding this out part of "
                    f"the work: add the requirement “{w.requirement}” cited to that answer "
                    f"(ref {w.cite_ref}).",
                    refs={"answer_id": str(w.answer_id)},
                )
            )
            continue
        if any(str(b) in chips or key in str(b).lower() for b in listed):
            problems.append(_as_blocker(w))
            continue
        marks = [f"[c:{c}]" for c in chips]
        heading = ""
        for n, line in enumerate(body, start):
            if line.lstrip().startswith("#"):
                heading = line
            if any(m in line for m in marks) and (
                _BLOCKER.search(heading) or _BLOCKER.search(line)
            ):
                p = _as_blocker(w)
                section = _SECTION_ID.search(heading)
                p.section_key = section[1] if section else None
                p.line = n
                problems.append(p)
                break
    return problems
