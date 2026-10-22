"""The customer-facing model call (``interview_turn``) and the checks on what it says.

A turn is one inline call in the customer's request (25-second deadline, 400 tokens).
Its input is built here from the interview row alone (:func:`turn_payload`): the
approved intro and questions, the current question, this conversation and whether a
follow-up is still allowed. The interviewer rules are the prompt
(``oracle/jobs/prompts/interview_turn.v1.md``); nothing else of the company (its name,
baseline, sources, goals, other interviews, PRDs) reaches the call (rule 4).

What the model says is checked before the customer sees it (rule 5, :func:`checked`):
plain text only, no links, length capped. A reply that fails is dropped whole, and the
conversation moves to the next approved question. Every pattern here reads model output
and must stay linear (see oracle.jobs.prompting).
"""

import asyncio
import json
import logging
import re
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from oracle.interviews.models import Interview, InterviewMessage
from oracle.jobs import prompting
from oracle.llm import gateway

log = logging.getLogger(__name__)

JOB = "interview_turn"
DEADLINE_SECONDS = 25.0
ACK_MAX = 120
FOLLOW_UP_MAX = 300

# A link in any form: a scheme, www., or a dotted host followed by a path or a common TLD.
_LINK = re.compile(
    r"[a-z][a-z0-9+.-]{0,20}://|\bwww\.|\b[a-z0-9-]{1,63}\.(?:com|net|org|io|co|ai|app|dev|"
    r"info|biz|me|us|uk|de|fr|ly|gl|gg|xyz|link|site|online)\b|\b[a-z0-9-]{1,63}\.[a-z]{2,24}/",
    re.I,
)
# Markup: HTML tags, Markdown links, images, code fences and emphasis.
_MARKUP = re.compile(r"<[a-z/!]|\]\(|```|\*\*|__|^#{1,6} ", re.I | re.M)


def checked(text: Any, limit: int) -> str | None:
    """``text`` stripped when it is plain text of at most ``limit`` characters with no
    link or markup; else None (the reply is not posted)."""
    if not isinstance(text, str):
        return None
    text = " ".join(text.split())
    if not text or len(text) > limit:
        return None
    if _LINK.search(text) or _MARKUP.search(text):
        return None
    return text


def is_quote(text: Any, said: list[str]) -> bool:
    """``text`` is an exact substring of one of the customer's messages (rule 6)."""
    return isinstance(text, str) and bool(text.strip()) and any(text in m for m in said)


def role_of(message: InterviewMessage) -> str:
    return "oracle" if message.role == "oracle" else "customer"


def turn_payload(
    interview: Interview, messages: list[InterviewMessage], may_follow_up: bool
) -> dict[str, Any]:
    """Everything the customer-facing call sees (rule 4)."""
    guide = interview.guide or []
    current = guide[interview.position] if interview.position < len(guide) else None
    return {
        "intro": interview.intro or "",
        "questions": [{"id": q["id"], "prompt": q["prompt"]} for q in guide],
        "current_question": (
            {"id": current["id"], "prompt": current["prompt"]} if current else None
        ),
        "conversation": [
            {"role": role_of(m), "body": m.body} for m in messages if m.kind != "skip"
        ],
        "may_follow_up": may_follow_up,
    }


@dataclass
class Reply:
    ack: str
    follow_up: str | None
    model: str | None = None
    usage: dict[str, Any] = field(default_factory=dict)
    cost_usd: Decimal | None = None


def _cost(usage: dict[str, Any]) -> Decimal | None:
    for key in ("total_cost_usd", "cost_usd"):
        value = usage.get(key)
        if isinstance(value, int | float) and not isinstance(value, bool):
            return Decimal(str(round(float(value), 4)))
    return None


@dataclass
class Spent:
    """A call that ran but whose reply was not posted: its cost is still recorded."""

    model: str | None = None
    usage: dict[str, Any] = field(default_factory=dict)
    cost_usd: Decimal | None = None


async def customer_turn(
    db: AsyncSession, payload: dict[str, Any], prompt: str = JOB
) -> tuple[Reply | None, Spent | None]:
    """One customer-facing call: the checked reply, or None (the reply failed the checks,
    the call failed or ran out of time) with what the call spent, if it ran. A team turn
    (oracle.interviews.team) runs the same job with its own ``prompt``."""
    name, system = prompting.current(prompt)
    from oracle.jobs.kinds import MAX_TOKENS

    try:
        completion = await asyncio.wait_for(
            gateway.complete(
                db,
                system,
                [{"role": "user", "content": json.dumps(payload, ensure_ascii=False)}],
                MAX_TOKENS[JOB],
                job=JOB,
            ),
            timeout=DEADLINE_SECONDS,
        )
    except Exception as e:  # timeout or any gateway failure: the next question instead
        log.warning("interview turn failed: %s", type(e).__name__)
        return None, None
    usage = dict(completion.usage or {})
    spent = Spent(completion.model, usage, _cost(usage))
    try:
        answer = prompting.parse_answer(completion.text)
    except prompting.AnswerError:
        return None, spent
    ack = checked(answer.get("ack"), ACK_MAX)
    raw_follow_up = answer.get("follow_up")
    follow_up = None
    if raw_follow_up not in (None, ""):
        follow_up = checked(raw_follow_up, FOLLOW_UP_MAX)
        if follow_up is None:
            return None, spent
    if ack is None:
        return None, spent
    return Reply(ack, follow_up, spent.model, spent.usage, spent.cost_usd), None
