"""H9 Pricing input: the API's shapes."""

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from oracle.pricing.models import ACCOUNT_MAX

# --------------------------------------------------------------------------- Win and loss

Result = Literal["won", "lost", "no_decision", "churned"]
Reason = Literal[
    "price", "value", "product_gap", "alternative", "timing", "no_budget", "champion", "other"
]
Currency = Literal["USD", "EUR", "GBP"]
NOTE_MAX = 2000
LABEL_MAX = 200

Account = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=ACCOUNT_MAX)
]
Label = Annotated[str, StringConstraints(strip_whitespace=True, max_length=LABEL_MAX)]
Note = Annotated[str, StringConstraints(strip_whitespace=True, max_length=NOTE_MAX)]
Value = Annotated[Decimal, Field(ge=0, max_digits=14, decimal_places=2)]


class DealOutcomeIn(BaseModel):
    """One deal's result and its main reason. ``reason: other`` needs ``reason_note``;
    ``annual_value`` and ``currency`` come together; ``decided_on`` is not in the
    future (the company's today)."""

    model_config = ConfigDict(extra="forbid")

    result: Result
    account: Account
    segment: Label | None = None
    plan: Label | None = None
    annual_value: Value | None = None
    currency: Currency | None = None
    decided_on: date
    reason: Reason
    reason_note: Note | None = None
    # One of the company's active alternatives (H7, Company › Market › Alternatives).
    competitor_id: uuid.UUID | None = None
    price_quoted: Label | None = None
    # One of the recorder's own source items (S6).
    source_item_id: uuid.UUID | None = None


class DealOutcomePatch(BaseModel):
    """Change some fields (lock_version required); null clears an optional one."""

    model_config = ConfigDict(extra="forbid")

    lock_version: int
    result: Result | None = None
    account: Account | None = None
    segment: Label | None = None
    plan: Label | None = None
    annual_value: Value | None = None
    currency: Currency | None = None
    decided_on: date | None = None
    reason: Reason | None = None
    reason_note: Note | None = None
    competitor_id: uuid.UUID | None = None
    price_quoted: Label | None = None
    source_item_id: uuid.UUID | None = None


class DealSourceItem(BaseModel):
    """What the record shares of its source item: title, link and a 400-character
    excerpt (C1 "Found items")."""

    title: str | None
    url: str | None
    excerpt: str | None


class DealOutcomeOut(BaseModel):
    id: uuid.UUID
    result: Result
    account: str
    segment: str | None
    plan: str | None
    annual_value: float | None
    currency: Currency | None
    decided_on: date
    reason: Reason
    reason_note: str | None
    competitor_id: uuid.UUID | None
    # The linked alternative's name, archived or not.
    competitor_name: str | None = None
    price_quoted: str | None
    source_item_id: uuid.UUID | None
    # None without one, or when the item is gone.
    source_item: DealSourceItem | None
    recorded_by: uuid.UUID
    created_at: datetime
    updated_at: datetime
    lock_version: int


class ImportSkipped(BaseModel):
    # The header is line 1.
    line: int
    message: str


class ImportOut(BaseModel):
    dry_run: bool
    # Rows created (with dry_run, rows that would be).
    created: int
    skipped: list[ImportSkipped]
    # Each distinct alternative named in the file that is none of the company's active
    # alternatives (by name or alias): kept as text in reason_note.
    unmatched_alternatives: list[str] = []


# --------------------------------------------------------------------------- Pricing memos

MemoState = Literal["draft", "in_review", "approved", "decided"]


class MemoDecision(BaseModel):
    number: int
    title: str
    status: str
    chosen_label: str | None = None


class PricingOwner(BaseModel):
    id: uuid.UUID
    name: str


class PricingMemoSummary(BaseModel):
    document_id: uuid.UUID
    slug: str
    title: str
    question: str | None
    state: MemoState
    decision: MemoDecision | None
    updated_at: datetime
    # Who decides (the memo header's Decide, or "Waiting for <name> to decide"); the
    # setting itself is an owner's read.
    pricing_owner: PricingOwner | None = None


class DecideMemoIn(BaseModel):
    # "This replaces D-<n>": the earlier pricing decision this one supersedes.
    replaces: int | None = Field(default=None, ge=1)
