"""The queued interview jobs: ``interview_guide`` and ``interview_snapshot``.

The guide's input is only what step 2 names (decision S6 Private findings sharing): the
intake's title and brief and the statements of its open gaps of the customer categories
that everyone may see; or the theme's title and the titles of its qualified requests;
or the topic. The snapshot's input is the approved questions and the customer's answers.

The snapshot keeps only quotes that are exact substrings of the customer's messages
(rule 6), and each need becomes one request (rule 7): New, unverified, channel and
origin ``interview``, the customer as requester (as given), linked to the interview and
to its intake or theme. Nothing else is written: no gap, answer or baseline item.

A pricing interview's snapshot (H9) also carries ``pricing``: the four Van Westendorp
prices, the currency, the budget owner and what it replaces, each as said or null.
"""

import re
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.interviews.models import Interview, InterviewMessage
from oracle.interviews.schemas import GUIDE_MAX, INTRO_MAX, PROMPT_MAX, InterviewPricing
from oracle.interviews.turns import is_quote
from oracle.jobs import prompting
from oracle.jobs.kinds import Ask, JobInputError
from oracle.jobs.models import LlmJob
from oracle.requests.models import ProductRequest, RequestTheme
from oracle.v2.models import KnowledgeGap, ProductIntake

#: The gap categories a customer can speak to (step 2).
CUSTOMER_CATEGORIES = (
    "customer_user",
    "pain_evidence",
    "alternatives",
    "differentiation",
    "economic_benefit",
)
MAX_GAPS = 20
MAX_REQUESTS = 30
BRIEF_MAX = 4000
TITLE_MAX = 200
LIST_MAX = 5
QUOTES_MAX = 3
NEEDS_MAX = 10
PRICING_MAX = 200
#: The pricing fields that hold a price; the others are words (currency, who, what).
PRICES = ("too_cheap", "bargain", "expensive", "too_expensive")
_NUMBER = re.compile(r"\d+")


async def _interview(s: AsyncSession, job: LlmJob) -> Interview:
    row = await s.get(Interview, job.interview_id) if job.interview_id else None
    if row is None:
        raise JobInputError("the interview no longer exists")
    return row


async def guide_input(s: AsyncSession, row: Interview) -> dict[str, Any]:
    """What the guide call sees, and nothing else (criterion 2)."""
    from oracle.intake.questions import private_gap
    from oracle.intake.sharing import OPEN_STATUSES

    if row.intake_id is not None:
        intake = await s.get(ProductIntake, row.intake_id)
        if intake is None:
            raise JobInputError("the PRD idea no longer exists")
        gaps = await s.scalars(
            select(KnowledgeGap)
            .where(
                KnowledgeGap.intake_id == intake.id,
                KnowledgeGap.category.in_(CUSTOMER_CATEGORIES),
                KnowledgeGap.status.in_(sorted(OPEN_STATUSES)),
            )
            .order_by(KnowledgeGap.created_at, KnowledgeGap.id)
        )
        shared = [g for g in gaps if not private_gap(intake, g)][:MAX_GAPS]
        return {
            "intake": {
                "title": intake.title,
                "brief": prompting.as_str(intake.brief, BRIEF_MAX),
                "open_questions": [
                    {"category": g.category, "statement": g.statement} for g in shared
                ],
            }
        }
    if row.theme_id is not None:
        theme = await s.get(RequestTheme, row.theme_id)
        if theme is None:
            raise JobInputError("the request theme no longer exists")
        titles = await s.scalars(
            select(ProductRequest.title)
            .where(ProductRequest.theme_id == theme.id, ProductRequest.state == "qualified")
            .order_by(ProductRequest.created_at)
            .limit(MAX_REQUESTS)
        )
        return {"theme": {"title": theme.title, "requests": list(titles)}}
    return {"topic": row.topic or row.title}


async def guide(s: AsyncSession, job: LlmJob, ask: Ask) -> dict[str, Any]:
    row = await _interview(s, job)
    if row.status != "draft":
        raise JobInputError("the interview is no longer a draft")
    answer = await ask("interview_guide", await guide_input(s, row))
    raw = answer.get("questions")
    if not isinstance(raw, list):
        raise prompting.AnswerError("the guide has no questions")
    questions = []
    for q in raw:
        if not isinstance(q, dict):
            continue
        prompt = prompting.as_str(q.get("prompt"), PROMPT_MAX)
        if prompt:
            purpose = prompting.as_str(q.get("purpose"), PROMPT_MAX) or None
            questions.append({"id": uuid.uuid4().hex[:12], "prompt": prompt, "purpose": purpose})
    if not questions:
        raise prompting.AnswerError("the guide has no questions")
    intro = prompting.as_str(answer.get("intro"), INTRO_MAX)
    # Re-read under the row lock: a person's edit or link meanwhile wins.
    row = await s.get(Interview, row.id, with_for_update=True, populate_existing=True)
    if row is None or row.status != "draft" or row.guide_job_id != job.id:
        raise JobInputError("the interview changed while Oracle drafted its questions")
    row.guide = questions[:GUIDE_MAX]
    row.intro = intro or row.intro
    await s.flush()
    return {"interview_id": str(row.id), "questions": len(row.guide)}


def _texts(value: Any, limit: int = 300) -> list[str]:
    if not isinstance(value, list):
        return []
    out = [prompting.as_str(v, limit) for v in value if isinstance(v, str)]
    return [v for v in out if v][:LIST_MAX]


def _numbers(text: str) -> set[str]:
    # "1,200" and "1 200" are 1200; a decimal point splits ("9.50" is 9 and 50).
    return set(_NUMBER.findall(re.sub(r"(?<=\d)[,\s](?=\d{3}(?!\d))", "", text)))


def pricing(value: Any, said: list[str]) -> dict[str, str | None]:
    """The model's pricing object, as said or null. A non-string or empty value is null.
    A price is kept only when it holds a number and every number in it appears in one of
    the customer's answers: we cannot check that the customer meant it, but a price whose
    numbers they never wrote is invented, so it is null."""
    raw = value if isinstance(value, dict) else {}
    heard = set().union(*(_numbers(m) for m in said))
    out: dict[str, str | None] = {}
    for name in InterviewPricing.model_fields:
        v = raw.get(name)
        text = v.strip()[:PRICING_MAX] if isinstance(v, str) else ""
        if text and name in PRICES:
            found = _numbers(text)
            text = text if found and found <= heard else ""
        out[name] = text or None
    return InterviewPricing(**out).model_dump()


async def snapshot(s: AsyncSession, job: LlmJob, ask: Ask) -> dict[str, Any]:
    row = await _interview(s, job)
    messages = list(
        await s.scalars(
            select(InterviewMessage)
            .where(InterviewMessage.interview_id == row.id, InterviewMessage.kind == "answer")
            .order_by(InterviewMessage.created_at, InterviewMessage.id)
        )
    )
    said = [m.body for m in messages]
    if not said:
        raise JobInputError("the interview has no answers")
    guide = row.guide or []
    payload: dict[str, Any] = {
        "questions": [{"id": q["id"], "prompt": q["prompt"]} for q in guide],
        "answers": [{"question_id": m.guide_item, "body": m.body} for m in messages],
    }
    if row.preset is not None:
        payload["preset"] = row.preset
    answer = await ask("interview_snapshot", payload)
    known = {q["id"] for q in guide}

    def question(value: Any) -> str | None:
        return value if isinstance(value, str) and value in known else None

    quotes = [
        {"text": q["text"], "question_id": question(q.get("question_id"))}
        for q in answer.get("quotes") or []
        if isinstance(q, dict) and is_quote(q.get("text"), said)
    ][:QUOTES_MAX]
    needs = []
    for n in answer.get("needs") or []:
        if not isinstance(n, dict):
            continue
        title = prompting.as_str(n.get("title"), TITLE_MAX)
        if not title:
            continue
        quote = n.get("quote") if is_quote(n.get("quote"), said) else None
        needs.append(
            {"title": title, "quote": quote, "question_id": question(n.get("question_id"))}
        )
    needs = needs[:NEEDS_MAX]

    row = await s.get(Interview, row.id, with_for_update=True, populate_existing=True)
    if row is None:
        raise JobInputError("the interview no longer exists")
    written: dict[str, Any] = {
        "quick_facts": _texts(answer.get("quick_facts")),
        "quotes": quotes,
        "needs": needs,
        "insights": _texts(answer.get("insights")),
    }
    if row.preset == "pricing":
        written["pricing"] = pricing(answer.get("pricing"), said)
    row.snapshot = written
    created = 0
    already = await s.scalar(
        select(ProductRequest.id).where(ProductRequest.interview_id == row.id).limit(1)
    )
    if already is None:
        requester = row.interviewee_name or ""
        if row.interviewee_company:
            requester = f"{requester} ({row.interviewee_company})"
        for need in needs:
            request = ProductRequest(
                title=need["title"],
                body=need["quote"],
                channel="interview",
                origin="interview",
                requester_name=requester or None,
                requester_kind="customer",
                verified=False,
                interview_id=row.id,
                intake_id=row.intake_id,
                theme_id=row.theme_id,
                state="new",
            )
            s.add(request)
            await s.flush()
            await audit.record(
                s, audit.ORACLE, "request.created", "product_request", request.id,
                {"channel": "interview", "interview_id": str(row.id)},
            )  # fmt: skip
            created += 1
    await s.flush()
    return {"interview_id": str(row.id), "quotes": len(quotes), "requests": created}
