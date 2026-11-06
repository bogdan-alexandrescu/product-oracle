"""The questions people answered at a run's stops, as decided calls.

Two kinds of question are answered at a stop before it is decided:

- the architect's questions of the tech briefs at the Engineering check (``eng_review``:
  ``answer:<question id>`` edits, recorded on approval in ``payload["briefs"]``,
  :mod:`oracle.engineering.check`);
- the agents' questions on the Questions from the agents cards of any stop (AQ1,
  :mod:`oracle.runs.agent_questions`), the feature-set stop's among them, recorded when
  the stop is decided (:func:`record`, ``payload["stop_answers"]``): a stop sent back
  reruns its segment, whose next files replace the ones that asked.

An answer is decided once its stop is approved, and a card's answer once its stop is
approved or sent back. This module reads them in one shape (:class:`Answered`) for:

- the run page's Decisions (``RunDecision.answers``, :func:`of_checkpoints`, batched);
- the PRD writers' prompt (:func:`prompt_lines`): each answer stated as decided, with the
  person, the stop and the stop's decision record (its D-number), never as open, and each
  stop's note with who approved or sent it back; the rerun of a sent-back stop's own
  segment reads that stop's card answers;
- the PRD import (:func:`open_problems`): a draft that still lists an answered question
  under Decisions needed or Open questions is refused, naming the question.
"""

import re
import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.docs.schemas import ImportProblem
from oracle.runs.models import Checkpoint, Run

ANSWERED_OPEN = "answered_listed_open"
# The card answers recorded when the stop is decided (:func:`record`).
RECORD = "stop_answers"
DECIDED = ("approved", "changes_requested")
# The segments that write a PRD and read the answers as decided: the first draft and the
# feedback loop's next draft (both PRD imports run :func:`open_problems`).
WRITERS = ("prd_draft", "next_draft")
STOPS = {
    "baseline_confirm": "Ground Truth",
    "eng_review": "Engineering review",
    "eng_dates": "Engineering dates",
    "feature_set": "Feature set",
    "priority_order": "Priority order",
    "prd_review": "PRD review",
}
# The PRD sections that list what is still undecided: by id, else by heading words.
OPEN_IDS = ("decisions", "decisions-needed", "open-questions", "open-decisions")
OPEN_WORDS = ("decisions needed", "open questions", "open decisions", "undecided")


def stop_name(kind: str) -> str:
    return STOPS.get(kind, kind.replace("_", " ").capitalize())


@dataclass
class Answered:
    checkpoint_id: uuid.UUID
    kind: str
    question: str
    answer: str
    # The feature it is about: its key (for citing) and its name (what a person reads).
    feature_key: str | None = None
    feature_title: str | None = None
    by: uuid.UUID | None = None
    by_name: str | None = None
    at: datetime | None = None

    @property
    def stop(self) -> str:
        return stop_name(self.kind)


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


def _engineering(cp: Checkpoint, recorded: dict[str, Any]) -> list[Answered]:
    from oracle.engineering import check as eng_check

    features = {f["key"]: f for f in eng_check._features(cp)}
    out: list[Answered] = []
    answers = recorded.get("answers")
    for key, listed in (answers if isinstance(answers, dict) else {}).items():
        if not isinstance(listed, list):
            continue
        feature = features.get(key) or {}
        asked = {q.get("id"): q.get("question") for q in feature.get("questions") or []}
        title = feature.get("title")
        for a in listed:
            if not isinstance(a, dict) or not isinstance(a.get("answer"), str):
                continue  # a non-text answer is dropped, as at registration
            question = a.get("question") or asked.get(a.get("question_id"))
            answer = a["answer"].strip()
            if not question or not answer:
                continue
            out.append(
                Answered(
                    checkpoint_id=cp.id, kind=cp.kind, question=str(question), answer=answer,
                    feature_key=key, feature_title=title if title and title != key else None,
                    by=_uuid(a.get("by")) or cp.decided_by,
                    at=_when(a.get("at")) or cp.decided_at,
                )
            )  # fmt: skip
    return out


def _is_check(cp: Checkpoint) -> bool:
    from oracle.engineering import check as eng_check

    return (
        cp.kind == eng_check.KIND
        and cp.status == "approved"
        and isinstance((cp.payload or {}).get(eng_check.PAYLOAD_KEY), dict)
    )


async def engineering(db: AsyncSession, cp: Checkpoint) -> list[Answered]:
    """The architect's questions answered at an approved Engineering check."""
    from oracle.engineering import check as eng_check

    return _engineering(cp, await eng_check.recorded_of(db, cp)) if _is_check(cp) else []


def _card(cp: Checkpoint, q: Any, option: str, note: str | None, by: Any, at: Any) -> Answered:
    label = {o.key: o.label for o in q.options}.get(option, option)
    return Answered(
        checkpoint_id=cp.id, kind=cp.kind, question=q.question,
        answer=f"{label}. Note: {note}" if note else label, feature_key=q.feature,
        by=_uuid(by), at=_when(at),
    )  # fmt: skip


def _recorded_cards(cp: Checkpoint) -> list[Answered]:
    out: list[Answered] = []
    for a in (cp.payload or {}).get(RECORD) or []:
        if isinstance(a, dict) and a.get("question") and isinstance(a.get("answer"), str):
            out.append(
                Answered(
                    checkpoint_id=cp.id, kind=cp.kind, question=str(a["question"]),
                    answer=a["answer"], feature_key=a.get("feature"), by=_uuid(a.get("by")),
                    at=_when(a.get("at")),
                )
            )  # fmt: skip
    return out


async def record(db: AsyncSession, run: Run, cp: Checkpoint) -> None:
    """Keep the stop's answered cards on the stop as it is decided: a stop sent back reruns
    its segment, whose next files replace the questions."""
    from oracle.runs import agent_questions

    out: list[dict[str, Any]] = []
    for q in await agent_questions._answered(db, None, run, cp):
        if q.answer is None:
            continue
        by = q.answer.by.id if q.answer.by else None
        a = _card(cp, q, q.answer.option, q.answer.note, by, q.answer.at)
        out.append(
            {"question": a.question, "answer": a.answer, "feature": a.feature_key,
             "by": str(a.by) if a.by else None, "at": a.at.isoformat() if a.at else None}
        )  # fmt: skip
    cp.payload = {**(cp.payload or {}), RECORD: out}


async def named(db: AsyncSession, answers: list[Answered]) -> list[Answered]:
    from oracle.runs import service

    ids = {a.by for a in answers if a.by is not None and a.by_name is None}
    names = await service._people_named(db, ids)
    for a in answers:
        if a.by_name is None and a.by is not None:
            a.by_name = names.get(a.by)
    return answers


async def _read(
    db: AsyncSession, runs: dict[uuid.UUID, Run], cps: list[Checkpoint]
) -> dict[uuid.UUID, list[Answered]]:
    """The answers of decided stops in a fixed number of reads, however many stops: an
    approved check's answers, and every decided stop's cards (as recorded, else read from
    its segment's files for a stop decided before they were recorded)."""
    from oracle.engineering import check as eng_check
    from oracle.runs import agent_questions
    from oracle.runs.models import AgentAnswer, CheckpointAction, RunSegment

    cps = [c for c in cps if c.status in DECIDED and c.run_id in runs]
    out: dict[uuid.UUID, list[Answered]] = {c.id: [] for c in cps}
    checks = [c for c in cps if _is_check(c)]
    unrecorded = [c.id for c in checks if not isinstance((c.payload or {}).get("briefs"), dict)]
    staged: dict[uuid.UUID, list[Any]] = defaultdict(list)
    if unrecorded:
        for action in await db.scalars(
            select(CheckpointAction).where(
                CheckpointAction.checkpoint_id.in_(unrecorded), CheckpointAction.state == "staged"
            )
        ):
            staged[action.checkpoint_id].append(action)
    for c in checks:
        recorded = (c.payload or {}).get("briefs")
        if not isinstance(recorded, dict):
            recorded = eng_check.decisions(c, staged.get(c.id, []))
        out[c.id] += _engineering(c, recorded)
    for c in cps:
        out[c.id] += _recorded_cards(c)
    live = [c for c in cps if RECORD not in (c.payload or {})]
    pairs = {
        (c.run_id, seq)
        for c in live
        if isinstance(seq := (c.payload or {}).get("segment_seq"), int)
    }
    if pairs:
        files = {
            (s.run_id, s.seq): ((s.artifacts or {}).get("files") or {})
            for s in await db.scalars(
                select(RunSegment).where(tuple_(RunSegment.run_id, RunSegment.seq).in_(pairs))
            )
        }
        rows: dict[uuid.UUID, dict[str, Any]] = defaultdict(dict)
        for a in await db.scalars(
            select(AgentAnswer).where(AgentAnswer.checkpoint_id.in_([c.id for c in live]))
        ):
            rows[a.checkpoint_id][a.question_key] = a
        for c in live:
            text = files.get((c.run_id, (c.payload or {}).get("segment_seq")), {})
            text = text.get(agent_questions.FILE)
            for q in agent_questions.parse(text if isinstance(text, str) else None):
                a = rows[c.id].get(q.id)
                if a is not None and a.option in {o.key for o in q.options}:
                    out[c.id].append(_card(c, q, a.option, a.note, a.answered_by, a.answered_at))
    await _titled(db, {c.id: c.run_id for c in cps}, out)
    await named(db, [a for listed in out.values() for a in listed])
    return out


async def _titled(
    db: AsyncSession, run_of: dict[uuid.UUID, uuid.UUID], out: dict[uuid.UUID, list[Answered]]
) -> None:
    """A card names its feature by key only: its name is the run's feature set's (its
    latest scope that lists the key), in one read."""
    from oracle.runs.scope_models import PrdScope, PrdScopeItem

    bare = [a for listed in out.values() for a in listed if a.feature_key and not a.feature_title]
    if not bare:
        return
    rows = await db.execute(
        select(PrdScope.run_id, PrdScopeItem.key, PrdScopeItem.title)
        .join(PrdScope, PrdScope.id == PrdScopeItem.scope_id)
        .where(
            PrdScope.run_id.in_({run_of[a.checkpoint_id] for a in bare}),
            PrdScopeItem.kind == "feature",
            PrdScopeItem.key.in_({a.feature_key for a in bare}),
        )
        .order_by(PrdScope.segment_seq, PrdScope.attempt)
    )
    titles = {(run_id, key): title for run_id, key, title in rows.all() if title}
    for a in bare:
        title = titles.get((run_of[a.checkpoint_id], a.feature_key))
        if title and title != a.feature_key:
            a.feature_title = title


async def of_checkpoint(db: AsyncSession, run: Run, cp: Checkpoint) -> list[Answered]:
    """The questions answered at the stop, each with who answered it and when."""
    return (await _read(db, {run.id: run}, [cp])).get(cp.id, [])


async def of_checkpoints(
    db: AsyncSession, runs: dict[uuid.UUID, Run], cps: list[Checkpoint]
) -> dict[uuid.UUID, list[Answered]]:
    """:func:`of_checkpoint` of many decided stops, batched (the Decisions of many runs)."""
    return await _read(db, runs, cps)


async def _stops(db: AsyncSession, run: Run) -> list[Checkpoint]:
    """The run's stops whose calls stand, in stop order: the latest approval of each stop
    kind (an earlier one was asked again), and the stops of that kind sent back since the
    approval before it (their answers were carried into the attempt that followed)."""
    cps = list(
        await db.scalars(
            select(Checkpoint)
            .where(Checkpoint.run_id == run.id, Checkpoint.status.in_(DECIDED))
            .order_by(Checkpoint.decided_at.desc())
        )
    )
    approvals: dict[str, list[Checkpoint]] = defaultdict(list)
    for cp in cps:
        if cp.status == "approved":
            approvals[cp.kind].append(cp)
    kept: list[Checkpoint] = []
    for cp in cps:
        approved = approvals.get(cp.kind, [])
        if cp.status == "approved":
            if cp is approved[0]:
                kept.append(cp)
        elif len(approved) < 2 or (
            cp.decided_at and approved[1].decided_at and cp.decided_at > approved[1].decided_at
        ):
            kept.append(cp)
    first = datetime.min.replace(tzinfo=UTC)
    return sorted(
        kept, key=lambda c: ((c.payload or {}).get("segment_seq") or 0, c.decided_at or first)
    )


def _latest(answers: list[Answered]) -> list[Answered]:
    """One answer per question, the latest given."""
    by_question: dict[str, Answered] = {}
    for a in answers:
        key = _words(a.question)
        by_question.pop(key, None)
        by_question[key] = a
    return list(by_question.values())


async def of_run(db: AsyncSession, run: Run) -> list[Answered]:
    """Every question answered at the run's stops whose calls stand (:func:`_stops`), in
    stop order."""
    cps = await _stops(db, run)
    read = await _read(db, {run.id: run}, cps)
    return _latest([a for cp in cps for a in read.get(cp.id, [])])


async def _numbers(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, int]:
    """The decision record (its D-number) of each decided stop."""
    from oracle.decisions.models import Decision

    if not ids:
        return {}
    rows = await db.execute(
        select(Decision.source_id, Decision.number).where(
            Decision.source_kind == "checkpoint", Decision.source_id.in_(ids)
        )
    )
    return {sid: n for sid, n in rows.all() if sid is not None}


async def prompt_lines(
    db: AsyncSession, run: Run, segment: str, seq: int | None = None, hidden: Any = None
) -> list[str]:
    """What a writer reads of the stops' calls: each answer stated as decided, with its
    stop, the person and the day, and each stop's note with who approved or sent it back,
    citing the stop's decision record. A PRD writer (:data:`WRITERS`) reads every stop's;
    another segment (``seq``) rerun after its own stop was sent back reads that stop's
    answered cards. A note that names what ``hidden`` withholds is left out."""
    from oracle.runs import service

    stops = await _stops(db, run)
    if segment not in WRITERS:
        stops = [
            c for c in stops
            if c.status == "changes_requested" and (c.payload or {}).get("segment_seq") == seq
        ]  # fmt: skip
    if not stops:
        return []
    read = await _read(db, {run.id: run}, stops)
    answers = _latest([a for cp in stops for a in read.get(cp.id, [])])
    noted = [
        c for c in stops
        if segment in WRITERS and c.note and not (hidden and hidden.names(c.note))
    ]  # fmt: skip
    if not answers and not noted:
        return []
    from oracle import company_time

    zone = await company_time.company_time_zone(db)
    numbers = await _numbers(db, {c.id for c in stops})
    deciders = await service._people_named(
        db, {i for c in noted if (i := service._decider_of(c)) is not None}
    )

    def where(cp_id: uuid.UUID, kind: str) -> str:
        n = numbers.get(cp_id)
        return f"{stop_name(kind)} (D-{n})" if n else stop_name(kind)

    lines = [
        "Decided at this run's stops: a person answered each question below at the stop, "
        "about the feature named before it (its key in parentheses is for citing only, never "
        "a name to write), "
        "and each note below is the call of the person who approved or sent back the stop, "
        "so each is a decision, never an open question. State each answer as decided in "
        "the body where it belongs (Approach, Requirements, Rules and the feature's own "
        "section), cite it like a decision with its D-number, and never list it under "
        "Decisions needed or Open questions:",
    ]
    for c in noted:
        did = "approved" if c.status == "approved" else "sent back"
        decider = service._decider_of(c)
        name = deciders.get(decider) if decider else None
        who = f"{did} by {name}" if name else did
        if c.decided_at is not None:
            who += f" on {company_time.day_in_words(c.decided_at, zone)}"
        lines.append(f'- {where(c.id, c.kind)}, {who}: note "{c.note}"')
    for a in answers:
        who = f"answered by {a.by_name}" if a.by_name else "answered"
        if a.at is not None:
            who += f" on {company_time.day_in_words(a.at, zone)}"
        lines.append(
            f'- {where(a.checkpoint_id, a.kind)}, {who}: {_about(a)}"{a.question}" '
            f'Decided: "{a.answer}"'
        )
    return lines


def _about(a: Answered) -> str:
    """The feature an answer is about, for a writer: its name, and its key apart."""
    if a.feature_title and a.feature_key:
        return f"{a.feature_title} (feature key {a.feature_key}, for citing only): "
    if a.feature_key:
        return f"Feature key {a.feature_key} (for citing only): "
    return ""


def decision_lines(answers: list[Answered]) -> list[str]:
    """The answers as a stop's decision record carries them (``list_decisions``)."""
    if not answers:
        return []
    lines = ["Answers to the architect's questions (decided):"]
    for a in answers:
        # A person reads this record: the feature's name, never its key.
        about = f"{a.feature_title or 'A feature in this run'}: " if a.feature_key else ""
        by = f" (answered by {a.by_name})" if a.by_name else ""
        lines.append(f'- {about}"{a.question}" → "{a.answer}"{by}')
    return lines


# --------------------------------------------------------------------------- import check

_HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*(?:\{#([^}\s]+)\})?\s*$")
# A listed item's marker: a bullet, a number, a checkbox, an id ("Q2:") or a "Question:"
# label before the question itself.
_MARKER = re.compile(
    r"^(?:[-*+]\s+|\d+[.)]\s+)?(?:\[[ xX]\]\s*)?(?:[A-Z]{1,3}-?\d+[:.)]\s+)?"
    r"(?:(?:open\s+)?(?:question|decision)s?\s*:\s*)?",
    re.IGNORECASE,
)
# The owner and due day an open question is listed with, only in their listed forms:
# "… Owner: Rae", "…, needed by Nov 30", "… - owned by Rae", "…? Decide by Nov 30" or
# "… (due Nov 30)"; "owned by", "needed by" and "decide by" only as a tail after a comma,
# a dash, a parenthesis or the question's end, and "Owner:" only as the line's last part
# (no question mark after it), so a "due", "owner" or "needed by" inside the question
# itself ("Is the report needed by finance each week?", "Who is the owner: finance or
# ops?") stays.
_TAIL = re.compile(
    r"(?:[?.!,;:]\s*|\s[-–—]\s*|\s+)owners?\s*:[^?]*$"
    r"|(?:[?.!,;]\s*|\s[-–—]\s*|[–—]\s*)(?:owned|needed|decide)\s+by\b.*$"
    r"|\s*[(\[]\s*(?:due|owners?|(?:owned|needed|decide)\s+by)\b.*$",
    re.IGNORECASE,
)
_RULE = re.compile(r"^:?-{3,}:?$")


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


def _cells(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


def _is_open_label(words: str) -> bool:
    return any(w in words for w in ("question", "decision", "undecided"))


def listed_items(title: str, text: str) -> list[str]:
    """The items an open section lists, one each: a bullet, a table cell or a line. In a
    section that also holds risks ("Risks and open questions") only its open-questions
    list counts (after a label or heading naming open questions, a table with a Question
    column, or an item labelled "Question:"), never a risk line that quotes a question."""
    mixed = "risk" in _words(title)
    listing = not mixed
    column: int | None = None
    table: list[str] | None = None
    out: list[str] = []
    rows = text.splitlines()
    for n, line in enumerate(rows):
        s = line.strip()
        if not s or s.startswith("<!--"):
            continue
        if s.startswith("|"):
            cells = _cells(s)
            if all(_RULE.match(c) or not c for c in cells):
                continue
            if table is None:
                table = cells
                below = rows[n + 1].strip() if n + 1 < len(rows) else ""
                if below.startswith("|") and all(_RULE.match(c) or not c for c in _cells(below)):
                    asks = [i for i, c in enumerate(cells) if "question" in _words(c)]
                    column = asks[0] if asks else None
                    continue
            if column is not None:
                out += cells[column : column + 1]
            elif listing:
                out += cells
            continue
        table, column = None, None
        bullet = re.match(r"^(?:[-*+]|\d+[.)])\s+", s)
        if mixed and not bullet:
            bare = s.lstrip("#").strip().strip("*_").strip()
            if s.startswith("#") or bare.endswith(":") or s.startswith(("**", "__")):
                listing = _is_open_label(_words(bare)) and "risk" not in _words(bare)
                continue
        if listing:
            out.append(s)
        elif re.match(r"(?i)^(?:(?:[-*+]|\d+[.)])\s+)?(?:open\s+)?question\s*:", s):
            out.append(s)
    return out


def _bare(item: str) -> str:
    """The item as the draft lists it, without its bullet, number or label."""
    return _MARKER.sub("", item.strip(), count=1)


def _forms(item: str) -> set[str]:
    """The item as words, with and without its owner and due tail."""
    bare = _bare(item)
    return {w for w in (_words(bare), _words(_TAIL.sub("", bare))) if w}


# Below this many words one word is most of the question ("Which database?" and "Which
# region?" are two questions): a short question is the answered one only word for word.
_LONG = 5

# Words that turn a question around ("t" is the n't of "don't" as words): a question with
# one and its copy without are two.
_NEGATIONS = frozenset({"not", "no", "never", "nor", "without", "dont", "doesnt", "isnt",
                        "cant", "cannot", "wont", "shouldnt", "arent", "didnt", "t"})  # fmt: skip


# Words that name one thing two ways: a question with one in the place of the other is the
# same question. A plural of one ("dbs", "databases") is read as the word (see _variants).
_SYNONYMS = (
    frozenset({"database", "datastore", "db"}),
    frozenset({"app", "application"}),
    frozenset({"repo", "repository"}),
    frozenset({"config", "configuration"}),
    frozenset({"env", "environment"}),
    frozenset({"prod", "production"}),
    frozenset({"info", "information"}),
    frozenset({"docs", "documentation"}),
    # British and American spellings no ending rule covers.
    frozenset({"grey", "gray"}),
    frozenset({"enrol", "enroll"}),
    frozenset({"enrolment", "enrollment"}),
    frozenset({"fulfil", "fulfill"}),
    frozenset({"fulfilment", "fulfillment"}),
    frozenset({"instalment", "installment"}),
    frozenset({"skilful", "skillful"}),
    frozenset({"programme", "program"}),
    frozenset({"judgement", "judgment"}),
    frozenset({"ageing", "aging"}),
    frozenset({"jewellery", "jewelry"}),
    frozenset({"aluminium", "aluminum"}),
    frozenset({"odour", "odor"}),
)

# Common abbreviations, each beside the word it stands for (plurals as for _SYNONYMS). Only
# these stand for a longer word: a real word is never read as one ("end" is not "extend",
# "its" not "items"), so an abbreviation that is not listed is a new word.
_ABBREVIATIONS = (
    frozenset({"yr", "year"}),
    frozenset({"hr", "hour"}),
    frozenset({"min", "minute"}),
    frozenset({"sec", "second"}),
    frozenset({"wk", "week"}),
    frozenset({"mth", "month"}),
    frozenset({"mgmt", "management"}),
    frozenset({"mgr", "manager"}),
    frozenset({"mkt", "market"}),
    frozenset({"mkt", "marketing"}),
    frozenset({"std", "standard"}),
    frozenset({"stg", "staging"}),
    frozenset({"pmt", "payment"}),
    frozenset({"rpt", "report"}),
    frozenset({"dept", "department"}),
    frozenset({"acct", "account"}),
    frozenset({"msg", "message"}),
    frozenset({"req", "request"}),
    frozenset({"req", "requirement"}),
    frozenset({"txn", "transaction"}),
    frozenset({"pw", "pwd", "password"}),
    frozenset({"qty", "quantity"}),
    frozenset({"amt", "amount"}),
    frozenset({"avg", "average"}),
    frozenset({"approx", "approximately"}),
    frozenset({"eng", "engineering"}),
    frozenset({"eng", "engineer"}),
    frozenset({"ops", "operations"}),
    frozenset({"admin", "administrator"}),
    frozenset({"admin", "administration"}),
    frozenset({"perf", "performance"}),
    frozenset({"auth", "authentication"}),
    frozenset({"auth", "authorization"}),
    frozenset({"govt", "government"}),
    frozenset({"intl", "international"}),
    frozenset({"ppl", "people"}),
)

# A word and the word with -s or -es that is a different word ("news" is not more "new").
_NOT_PLURALS = frozenset({("new", "news"), ("good", "goods"), ("custom", "customs"),
                          ("us", "uses"), ("mean", "means"), ("manner", "manners"),
                          ("damage", "damages"), ("saving", "savings"), ("arm", "arms"),
                          ("her", "hers"), ("our", "ours"), ("his", "hiss")})  # fmt: skip
# Endings that take -es for a plural ("boxes"); after any other, -es is another word ("states").
_TAKES_ES = ("s", "x", "z", "ch", "sh", "o")

# British endings and their American spelling, from five letters ("four" is not "for").
_SPELLINGS = (
    (re.compile(r"^([a-z]{2,}[aeiou])ll(ed|ing|ers?)$"), r"\1l\2"),  # cancelled, travelling
    # centre, metre, theatre, fibre, litre, calibre (not timbre, acre or genre)
    (
        re.compile(r"(cent|met|theat|fib|lit|mit|nit|calib|sab|somb|spect|lust|meag|och)re(s?)$"),
        r"\1er\2",
    ),
    (re.compile(r"ogue$"), "og"),  # catalogue
    (re.compile(r"ence$"), "ense"),  # licence
    # colour, honour, behaviour, labour and their endings (not fourth, mourning or pouring)
    (
        re.compile(
            r"^([a-z]{3,})our(s|ed|ing|ite|ites|ful|able|ably|less|er|ers|ist|ists|hood|hoods)?$"
        ),
        r"\1or\2",
    ),
    (re.compile(r"is(e|ed|es|ing|ation|ations)$"), r"iz\1"),  # organise, organisation
    (re.compile(r"ys(e|ed|es|ing)$"), r"yz\1"),  # analyse
)


def _american(word: str) -> str:
    if len(word) < 5:
        return word
    for pattern, spelt in _SPELLINGS:
        word = pattern.sub(spelt, word)
    return word


def _variants(x: str, y: str) -> bool:
    """``x`` and ``y`` are one word spelt two ways: a known synonym ("datastore",
    "database"), a listed abbreviation ("yrs", "years"; "pw", "password"; "mgmt",
    "management"), a plural ("export", "exports"; "box", "boxes") or a British or American
    spelling ("colour", "color"; "organise", "organize"; "licence", "license"; "centre",
    "center"; "catalogue", "catalog"; "cancelled", "canceled"). Two different words
    ("Safari", "Firefox"; "fast", "slow"; "export", "expert"; "new", "news"; "stat",
    "states"; "fourth", "forth"; "timbre", "timber"), a word that is not a listed
    abbreviation of the other ("end", "extend"; "its", "items"; "us", "users"; "ms",
    "months") or an acronym ("SMS", "systems") are not."""
    if x == y:
        return True
    short, long = sorted((x, y), key=len)
    if not short.isalpha() or not long.isalpha():
        return False
    # "dbs" and "databases" are "db" and "database"; "licences" and "licenses" one spelling.
    forms = [(x, y)]
    if x.endswith("s") and y.endswith("s") and len(short) > 2:
        forms.append((x[:-1], y[:-1]))
    for a, b in forms:
        if any(a in s and b in s for s in (*_SYNONYMS, *_ABBREVIATIONS)):
            return True
        if len(max(a, b, key=len)) >= 5 and _american(a) == _american(b):
            return True
    # "boxes", "classes", "matches", "potatoes"; not "states" for "stat" or "planes" for "plan".
    if len(short) >= 3 and (
        long == short + "s" or (long == short + "es" and short.endswith(_TAKES_ES))
    ):
        return (short, long) not in _NOT_PLURALS
    return False


def same_question(asked: str, listed: str) -> bool:
    """``listed`` is the answered question ``asked`` (both as words), compared word by word
    in order: the same words, or, for questions of at least five words, the same number of
    words with at most one position holding the same word spelt another way ("database" for
    "datastore", "yrs" for "years": :func:`_variants`), and the same negations ("should" and
    "should not" are two questions). A different word there ("Firefox" for "Safari", "slow"
    for "fast", "backups" for "exports") is the content of the question, so a new question;
    so is a question one word longer or shorter, a longer one that contains it, or the same
    words in another order ("A replace B" and "B replace A")."""
    if asked == listed:
        return True
    a, b = asked.split(), listed.split()
    if len(a) != len(b) or len(a) < _LONG:
        return False
    if [w for w in a if w in _NEGATIONS] != [w for w in b if w in _NEGATIONS]:
        return False
    apart = [(x, y) for x, y in zip(a, b, strict=True) if x != y]
    return len(apart) == 1 and _variants(*apart[0])


def listed_open(answers: list[Answered], markdown: str) -> list[ImportProblem]:
    """An answered question the draft still lists as undecided, once per question."""
    sections = [
        (sid, title, [(_bare(item), _forms(item)) for item in listed_items(title, text)])
        for sid, title, text in open_sections(markdown)
    ]
    out: list[ImportProblem] = []
    seen: set[str] = set()
    for a in answers:
        asked = _words(a.question)
        if not asked or asked in seen:
            continue
        for sid, title, items in sections:
            line = next(
                (bare for bare, forms in items if any(same_question(asked, f) for f in forms)),
                None,
            )
            if line is not None:
                seen.add(asked)
                line = line.replace("**", "").replace("__", "").strip()
                by = f" by {a.by_name}" if a.by_name else ""
                out.append(
                    ImportProblem(
                        code=ANSWERED_OPEN,
                        message=f'"{a.question}" was answered at {a.stop}{by} '
                        f'("{a.answer}"), but the draft lists it under {title} as "{line}", '
                        "undecided: state the answer as decided in the body and take it out of "
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
