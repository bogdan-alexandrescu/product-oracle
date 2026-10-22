"""Step 2 of Oracle's pushback on a move or pin (decided 2026-10-21, C9 "Pushback"):
Oracle's own model reads the person's written reason against the evidence and may add
one ``reason_contradicts_evidence`` message.

One call through :func:`oracle.llm.gateway.complete` with the built-in job
``override_reason_check`` (600 output tokens), made synchronously inside
``POST /v1/priorities/overrides`` while the person waits, cut off after
:data:`DEADLINE_SECONDS`. At most :data:`DAILY_CAP` checks per company per UTC day,
counted from that day's ``priority_override.reason_checked`` audit events.

The model step never stops a person from saving: no Claude account, a gateway error, the
deadline, an answer that is not the JSON asked for, or the daily cap all give a rules-only
result (``failed``, ``timed_out`` or ``skipped``). Nothing is retried in the request.

The deadline is enforced here (``asyncio.wait_for``) rather than through the gateway's
``deadline``: the gateway refuses to start a call unless a whole call
(``ORACLE_LLM_TIMEOUT_SECONDS``, minutes) still fits before its deadline, which a 10 s
budget never leaves.

Source text is data, never instructions: the prompt says so and the evidence goes in
``untrusted_data``. Neither the reason nor evidence text is logged or audited.
"""

import asyncio
import json
import logging
import time
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from datetime import time as day_start
from functools import cache
from pathlib import Path
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.jobs import prompting
from oracle.llm import gateway
from oracle.llm.transports import LlmOutOfTime
from oracle.models import AuditEvent

log = logging.getLogger(__name__)

JOB = "override_reason_check"
EVENT = "priority_override.reason_checked"
DEADLINE_SECONDS: float = 10
DAILY_CAP = 200
# A reason this short says too little to check.
MIN_REASON = 10
MAX_REASON = 500
MAX_CITED = 5
MAX_EVIDENCE = 20
MAX_TEXT = 600
PROMPT = Path(__file__).resolve().parent / "prompts" / f"{JOB}.md"


class UnreadableAnswer(ValueError):
    """The model's answer is not the JSON object the prompt asks for."""


@dataclass(frozen=True)
class EvidenceItem:
    id: str
    title: str
    source_kind: str
    date: str | None
    confidence: float | None
    text: str

    def chip(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "source_kind": self.source_kind,
            "confidence": self.confidence,
            "date": self.date,
        }


@dataclass
class ReasonCheck:
    # contradiction | no_contradiction | skipped | failed | timed_out
    status: str
    ms: int | None = None
    # The reason_contradicts_evidence pushback message, on a contradiction.
    message: dict[str, Any] | None = None
    # Whether the model was called (each call is audited once).
    called: bool = False
    usage: dict[str, Any] = field(default_factory=dict)
    account_label: str | None = None
    via: str | None = None

    def stored(self) -> dict[str, Any]:
        """What an override keeps of it: status and ms, no usage, no text."""
        return {"status": self.status, "ms": self.ms}


@cache
def system_prompt() -> str:
    return PROMPT.read_text(encoding="utf-8")


def _item(e: EvidenceItem) -> dict[str, Any]:
    return {**asdict(e), "text": e.text[:MAX_TEXT]}


def build_prompt(
    *,
    reason: str,
    feature: dict[str, Any],
    cited: list[EvidenceItem],
    evidence: list[EvidenceItem],
    change: dict[str, Any] | None = None,
) -> tuple[str, str]:
    """(system prompt, user message): the reason, the change and the feature, then the
    cited evidence first and at most :data:`MAX_EVIDENCE` more items by confidence, each
    cut to :data:`MAX_TEXT` characters, as quoted data."""
    cited = cited[:MAX_CITED]
    cited_ids = {e.id for e in cited}
    rest = sorted(
        (e for e in evidence if e.id not in cited_ids),
        key=lambda e: -(e.confidence if e.confidence is not None else -1),
    )[:MAX_EVIDENCE]
    payload = {
        "reason": reason[:MAX_REASON],
        "change": change or {},
        "feature": feature,
        "untrusted_data": {
            "cited_evidence": [_item(e) for e in cited],
            "evidence": [_item(e) for e in rest],
        },
    }
    return system_prompt(), json.dumps(payload, ensure_ascii=False, default=str)


def parse_answer(text: str, allowed: set[str]) -> tuple[str, dict[str, Any] | None]:
    """(status, message): a message is kept only when ``contradicts`` is true and every
    cited id is one of the inputs (at least one); otherwise ``no_contradiction``."""
    try:
        value = prompting.parse_answer(text)
    except prompting.AnswerError as e:
        raise UnreadableAnswer(str(e)) from None
    contradicts = value.get("contradicts")
    if not isinstance(contradicts, bool):
        raise UnreadableAnswer("contradicts must be true or false")
    if not contradicts:
        return "no_contradiction", None
    message, ids, claim = value.get("message"), value.get("evidence_ids"), value.get("claim")
    if not isinstance(message, str) or not message.strip():
        raise UnreadableAnswer("a contradiction needs a message")
    if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
        raise UnreadableAnswer("evidence_ids must be a list of ids")
    ids = list(dict.fromkeys(ids))
    if not ids or any(i not in allowed for i in ids):
        return "no_contradiction", None
    return "contradiction", {
        "claim": (claim if isinstance(claim, str) else "").strip()[:200],
        "message": message.strip()[:MAX_TEXT],
        "evidence_ids": ids,
    }


async def checks_today(db: AsyncSession) -> int:
    """This company's model checks so far this UTC day (its audit events)."""
    since = datetime.combine(datetime.now(UTC).date(), day_start.min, tzinfo=UTC)
    return int(
        await db.scalar(
            select(func.count())
            .select_from(AuditEvent)
            .where(AuditEvent.action == EVENT, AuditEvent.created_at >= since)
        )
        or 0
    )


async def check_reason(
    db: AsyncSession,
    feature: dict[str, Any],
    override: dict[str, Any],
    evidence: dict[str, list[EvidenceItem]],
) -> ReasonCheck:
    """Read ``override["reason"]`` against ``evidence`` (``cited`` and ``items``, the
    feature's own). Never raises for the model's sake: any failure is a status."""
    reason = str(override.get("reason") or "")
    if len(reason.strip()) < MIN_REASON:
        return ReasonCheck("skipped")
    if await checks_today(db) >= DAILY_CAP:
        return ReasonCheck("skipped")
    cited = list(evidence.get("cited") or [])[:MAX_CITED]
    items = list(evidence.get("items") or [])
    system, content = build_prompt(
        reason=reason, feature=feature, cited=cited, evidence=items, change=override.get("change")
    )
    shown = json.loads(content)["untrusted_data"]
    allowed = {e["id"] for e in shown["cited_evidence"] + shown["evidence"]}
    by_id = {e.id: e for e in [*cited, *items]}
    from oracle.jobs.kinds import MAX_TOKENS

    started = time.monotonic()
    check = ReasonCheck("failed", called=True)
    try:
        completion = await asyncio.wait_for(
            gateway.complete(
                db,
                system,
                [{"role": "user", "content": content}],
                MAX_TOKENS[JOB],
                job=JOB,
            ),
            timeout=DEADLINE_SECONDS,
        )
    except (TimeoutError, LlmOutOfTime):
        check.status = "timed_out"
    except Exception as e:  # any gateway failure: the rules decide alone
        log.warning("override reason check failed: %s", type(e).__name__)
    else:
        check.usage = dict(completion.usage or {})
        check.account_label = completion.account_label
        check.via = completion.via
        try:
            status, message = parse_answer(completion.text, allowed)
        except UnreadableAnswer:
            log.warning("override reason check: the answer was not the JSON asked for")
        else:
            check.status = status
            if message is not None:
                check.message = {
                    "code": "reason_contradicts_evidence",
                    "message": message["message"],
                    "claim": message["claim"],
                    "evidence": [by_id[i].chip() for i in message["evidence_ids"]],
                }
    check.ms = int((time.monotonic() - started) * 1000)
    return check
