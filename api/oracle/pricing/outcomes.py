"""Win and loss records (H9): list, record, edit, delete and import from CSV.

Owners and approvers only; for anyone else the records are absent (H8, the router's
404). One main reason per deal, in plain words; ``other`` needs a note. ``decided_on`` is
never after the company's today. A record may cite one of its writer's own source items
(S6): it then shows the item's title, link and 400-character excerpt, audited as shared
in full (C1 "Found items").

The CSV import takes the columns of :data:`COLUMNS` under a header row, at most
:data:`MAX_ROWS` rows and :data:`MAX_BYTES` bytes (else 422 for the whole file). Each bad
row is skipped with its line number (the header is line 1) and good rows still import.
Until H7 lands an ``alternative`` is kept as text in ``reason_note``.
"""

import csv
import io
import re
import uuid
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.deps import Principal
from oracle.decisions.service import company_today
from oracle.pricing.models import ACCOUNT_MAX, CURRENCIES, DealOutcome
from oracle.pricing.schemas import (
    LABEL_MAX,
    NOTE_MAX,
    DealOutcomeIn,
    DealOutcomeOut,
    DealOutcomePatch,
    DealSourceItem,
    ImportOut,
    ImportSkipped,
)
from oracle.requests.service import excerpt_of
from oracle.sources.models import Source, SourceItem, SourceItemVersion
from oracle.v2.concurrency import expect_version, flush_or_conflict

COLUMNS = (
    "result",
    "account",
    "segment",
    "plan",
    "annual_value",
    "currency",
    "decided_on",
    "reason",
    "reason_note",
    "alternative",
    "price_quoted",
)
REQUIRED = ("result", "account", "decided_on", "reason")
MAX_ROWS = 2000
MAX_BYTES = 1024 * 1024
RESULT_LABELS = {
    "won": "Won",
    "lost": "Lost",
    "no_decision": "No decision",
    "churned": "Churned",
}
REASON_LABELS = {
    "price": "Price",
    "value": "Value not clear",
    "product_gap": "Missing feature",
    "alternative": "Chose an alternative",
    "timing": "Timing",
    "no_budget": "No budget",
    "champion": "Lost the champion",
    "other": "Other",
}
NOT_YOUR_ITEM = "source_item_id is not one of your own source items"
NO_COMPETITORS = "competitor_id is not available yet: keep the alternative in reason_note"
RUNS_READ_ONLY = "A run's agents only read win and loss records"
_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")


class OutcomeError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def _key(text: str) -> str:
    return " ".join(text.replace("_", " ").replace("-", " ").lower().split())


def _lookup(labels: dict[str, str]) -> dict[str, str]:
    """Keys and plain labels, either case, to the key."""
    return {_key(k): k for k in labels} | {_key(v): k for k, v in labels.items()}


_RESULTS = _lookup(RESULT_LABELS)
_REASONS = _lookup(REASON_LABELS)


def rule_problem(
    *,
    reason: str,
    reason_note: str | None,
    annual_value: Any,
    currency: str | None,
    decided_on: date,
    today: date,
) -> str | None:
    """The rules across fields, shared by the form and the import; None when they hold."""
    if reason == "other" and not reason_note:
        return "reason other needs a reason_note"
    if annual_value is not None and currency is None:
        return "annual_value needs a currency"
    if currency is not None and annual_value is None:
        return "currency needs an annual_value"
    if decided_on > today:
        return "decided_on is in the future"
    return None


def _writer(principal: Principal) -> None:
    # Run tokens have no write scope for this area (oracle.mcp.scopes); the REST layer
    # refuses a run's write too.
    if principal.is_run:
        raise OutcomeError(403, RUNS_READ_ONLY)


async def _item(
    db: AsyncSession, item_id: uuid.UUID, owner_user_id: uuid.UUID | None = None
) -> DealSourceItem | None:
    """A live source item's title, link and excerpt; with ``owner_user_id``, only that
    person's own item."""
    query = select(SourceItem).where(SourceItem.id == item_id, SourceItem.deleted_at.is_(None))
    if owner_user_id is not None:
        query = query.join(Source, Source.id == SourceItem.source_id).where(
            Source.owner_user_id == owner_user_id
        )
    item = await db.scalar(query)
    if item is None:
        return None
    version = (
        await db.get(SourceItemVersion, item.current_version_id)
        if item.current_version_id
        else None
    )
    return DealSourceItem(
        title=item.title or (version.title if version else None),
        url=item.url or (version.url if version else None),
        excerpt=excerpt_of(version.content if version else None),
    )


async def _own_item(db: AsyncSession, principal: Principal, item_id: uuid.UUID) -> None:
    if principal.user_id is None or await _item(db, item_id, principal.user_id) is None:
        raise OutcomeError(422, NOT_YOUR_ITEM)


async def out(db: AsyncSession, row: DealOutcome) -> DealOutcomeOut:
    item = await _item(db, row.source_item_id) if row.source_item_id else None
    return DealOutcomeOut(
        id=row.id,
        result=row.result,  # type: ignore[arg-type]
        account=row.account,
        segment=row.segment,
        plan=row.plan,
        annual_value=float(row.annual_value) if row.annual_value is not None else None,
        currency=row.currency,  # type: ignore[arg-type]
        decided_on=row.decided_on,
        reason=row.reason,  # type: ignore[arg-type]
        reason_note=row.reason_note,
        competitor_id=row.competitor_id,
        price_quoted=row.price_quoted,
        source_item_id=row.source_item_id,
        source_item=item,
        recorded_by=row.recorded_by,
        created_at=row.created_at,
        updated_at=row.updated_at,
        lock_version=row.lock_version,
    )


async def list_outcomes(
    db: AsyncSession,
    *,
    result: str | None = None,
    reason: str | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
) -> list[DealOutcomeOut]:
    """Newest ``decided_on`` first; ``date_from`` and ``date_to`` are inclusive."""
    query = select(DealOutcome)
    if result is not None:
        query = query.where(DealOutcome.result == result)
    if reason is not None:
        query = query.where(DealOutcome.reason == reason)
    if date_from is not None:
        query = query.where(DealOutcome.decided_on >= date_from)
    if date_to is not None:
        query = query.where(DealOutcome.decided_on <= date_to)
    rows = await db.scalars(
        query.order_by(DealOutcome.decided_on.desc(), DealOutcome.created_at.desc())
    )
    return [await out(db, row) for row in rows]


async def get_row(db: AsyncSession, outcome_id: uuid.UUID) -> DealOutcome:
    row = await db.scalar(
        select(DealOutcome)
        .where(DealOutcome.id == outcome_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row is None:
        raise OutcomeError(404, "No such win or loss record")
    return row


def _check(row: DealOutcome, today: date) -> None:
    problem = rule_problem(
        reason=row.reason,
        reason_note=row.reason_note,
        annual_value=row.annual_value,
        currency=row.currency,
        decided_on=row.decided_on,
        today=today,
    )
    if problem:
        raise OutcomeError(422, problem)


async def create(db: AsyncSession, principal: Principal, body: DealOutcomeIn) -> DealOutcome:
    _writer(principal)
    if body.competitor_id is not None:
        raise OutcomeError(422, NO_COMPETITORS)
    if body.source_item_id is not None:
        await _own_item(db, principal, body.source_item_id)
    fields = body.model_dump(exclude={"competitor_id"})
    for name in ("segment", "plan", "reason_note", "price_quoted"):
        fields[name] = fields[name] or None
    row = DealOutcome(**fields, recorded_by=principal.id)
    _check(row, await company_today(db))
    db.add(row)
    await db.flush()
    await db.refresh(row)
    data: dict[str, Any] = {"result": row.result, "reason": row.reason}
    if row.source_item_id:
        data |= {"shared": "full", "source_item_id": str(row.source_item_id)}
    await audit.record(db, principal, "deal_outcome.created", "deal_outcome", row.id, data)
    return row


async def patch(
    db: AsyncSession, principal: Principal, outcome_id: uuid.UUID, body: DealOutcomePatch
) -> DealOutcome:
    _writer(principal)
    row = await get_row(db, outcome_id)
    expect_version(row, body.lock_version)
    # Read before the row changes: a query would autoflush it unchecked.
    today = await company_today(db)
    fields = body.model_fields_set - {"lock_version"}
    for name in ("result", "account", "decided_on", "reason"):
        if name in fields and getattr(body, name) is None:
            raise OutcomeError(422, f"{name} cannot be empty")
    if "competitor_id" in fields and body.competitor_id is not None:
        raise OutcomeError(422, NO_COMPETITORS)
    shared = "source_item_id" in fields and body.source_item_id not in (None, row.source_item_id)
    if shared:
        await _own_item(db, principal, body.source_item_id)  # type: ignore[arg-type]
    for name in sorted(fields - {"competitor_id"}):
        value = getattr(body, name)
        setattr(row, name, value if value != "" else None)
    _check(row, today)
    await flush_or_conflict(db)
    await db.refresh(row)
    data: dict[str, Any] = {"fields": sorted(fields)}
    if shared:
        data |= {"shared": "full", "source_item_id": str(row.source_item_id)}
    await audit.record(db, principal, "deal_outcome.edited", "deal_outcome", row.id, data)
    return row


async def delete(db: AsyncSession, principal: Principal, outcome_id: uuid.UUID) -> None:
    _writer(principal)
    row = await get_row(db, outcome_id)
    data = {"result": row.result, "reason": row.reason, "decided_on": str(row.decided_on)}
    await db.delete(row)
    await db.flush()
    await audit.record(db, principal, "deal_outcome.deleted", "deal_outcome", outcome_id, data)


# --------------------------------------------------------------------------- CSV import


def _rows(raw: bytes) -> tuple[list[str], list[tuple[int, list[str]]]]:
    """The header's column names and each non-blank data row with its first line
    number; 422 for a file that cannot be read as a whole."""
    if len(raw) > MAX_BYTES:
        raise OutcomeError(422, "The file is larger than 1 MB")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as e:
        raise OutcomeError(422, "The file must be UTF-8 text") from e
    reader = csv.reader(io.StringIO(text, newline=""))
    rows: list[tuple[int, list[str]]] = []
    header: list[str] | None = None
    line = 1
    try:
        for cells in reader:
            start, line = line, reader.line_num + 1
            if not any(c.strip() for c in cells):
                continue
            if header is None:
                header = [_key(c).replace(" ", "_") for c in cells]
                continue
            rows.append((start, cells))
            if len(rows) > MAX_ROWS:
                raise OutcomeError(422, f"The file has more than {MAX_ROWS:,} rows")
    except csv.Error as e:
        raise OutcomeError(422, f"The file is not valid CSV (line {reader.line_num}): {e}") from e
    missing = [c for c in REQUIRED if c not in (header or [])]
    if missing:
        raise OutcomeError(
            422,
            f"The header row must name the columns {', '.join(COLUMNS)}; missing: "
            + ", ".join(missing),
        )
    return header or [], rows


def _row(values: dict[str, str], today: date) -> tuple[dict[str, Any] | None, str | None]:
    """One CSV row as DealOutcome fields, or the first problem in plain words."""
    result = _RESULTS.get(_key(values.get("result", "")))
    if result is None:
        return None, "result must be one of: " + ", ".join(RESULT_LABELS.values())
    account = values.get("account", "").strip()
    if not account:
        return None, "account is required"
    if len(account) > ACCOUNT_MAX:
        return None, f"account is longer than {ACCOUNT_MAX} characters"
    texts: dict[str, str | None] = {}
    for name, cap in (("segment", LABEL_MAX), ("plan", LABEL_MAX),
                      ("price_quoted", LABEL_MAX), ("reason_note", NOTE_MAX)):  # fmt: skip
        texts[name] = values.get(name, "").strip() or None
        if texts[name] and len(texts[name]) > cap:  # type: ignore[arg-type]
            return None, f"{name} is longer than {cap} characters"
    annual_value: Decimal | None = None
    raw_value = values.get("annual_value", "").strip().replace(",", "")
    if raw_value:
        try:
            annual_value = Decimal(raw_value)
        except InvalidOperation:
            annual_value = None
        if (
            annual_value is None
            or not annual_value.is_finite()
            or annual_value < 0
            or annual_value >= Decimal("1e12")
        ):
            return None, "annual_value must be a number of 0 or more"
        annual_value = annual_value.quantize(Decimal("0.01"))
    currency = values.get("currency", "").strip().upper() or None
    if currency is not None and currency not in CURRENCIES:
        return None, "currency must be " + ", ".join(CURRENCIES[:-1]) + f" or {CURRENCIES[-1]}"
    raw_day = values.get("decided_on", "").strip()
    try:
        decided_on = date.fromisoformat(raw_day) if _DAY.fullmatch(raw_day) else None
    except ValueError:
        decided_on = None
    if decided_on is None:
        return None, "decided_on must be YYYY-MM-DD"
    reason = _REASONS.get(_key(values.get("reason", "")))
    if reason is None:
        return None, "reason must be one of: " + ", ".join(REASON_LABELS.values())
    alternative = values.get("alternative", "").strip()
    note = texts["reason_note"]
    if alternative:
        # H7's alternatives are not here yet: kept as text.
        note = f"{note}\nAlternative: {alternative}" if note else f"Alternative: {alternative}"
        if len(note) > NOTE_MAX:
            return None, f"reason_note and alternative are longer than {NOTE_MAX} characters"
    problem = rule_problem(
        reason=reason,
        reason_note=note,
        annual_value=annual_value,
        currency=currency,
        decided_on=decided_on,
        today=today,
    )
    if problem:
        return None, problem
    return {
        "result": result,
        "account": account,
        "segment": texts["segment"],
        "plan": texts["plan"],
        "annual_value": annual_value,
        "currency": currency,
        "decided_on": decided_on,
        "reason": reason,
        "reason_note": note,
        "price_quoted": texts["price_quoted"],
    }, None


async def import_csv(
    db: AsyncSession, principal: Principal, raw: bytes, *, dry_run: bool
) -> ImportOut:
    """Create a record per good row (none with ``dry_run``); list each bad one."""
    _writer(principal)
    header, rows = _rows(raw)
    today = await company_today(db)
    created: list[DealOutcome] = []
    skipped: list[ImportSkipped] = []
    for line, cells in rows:
        values = {name: cell for name, cell in zip(header, cells, strict=False)}
        fields, problem = _row(values, today)
        if problem:
            skipped.append(ImportSkipped(line=line, message=problem))
            continue
        created.append(DealOutcome(**fields, recorded_by=principal.id))
    if not dry_run and created:
        db.add_all(created)
        await db.flush()
        await audit.record(
            db,
            principal,
            "deal_outcome.imported",
            "deal_outcome",
            None,
            {"created": len(created), "skipped": len(skipped)},
        )
    return ImportOut(dry_run=dry_run, created=len(created), skipped=skipped)
