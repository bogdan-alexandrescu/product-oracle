"""What an intake proposes: research runs and PRD patches, and which source items its
runs may not read (migration 0014_intake).

The gap registry, the question ledger and the intake itself live on the foundation's
tables (``oracle.v2.models``). An intake proposal is the one thing those tables cannot
hold: a change Oracle suggests from an answer, which a person accepts or dismisses.
Nothing here runs or edits anything by itself (§5 step 7):

- ``research_run``: "Research this". Accepting it creates a *draft* run of the existing
  baseline-to-PRD flow, pinned to the intake's snapshot; an approver still estimates and
  starts it, under the usual cost gates.
- ``prd_patch``: an answer that belongs in the linked PRD. Accepting it opens a feedback
  item on the PRD's latest version, so the change reaches the document only through
  the existing review and refinement flow (approved sections stay locked).

``intake_withheld_items`` is precomputed from each intake (S6, owner 2026-10-19): while
any finding of an intake is below "shared in full", every item its analysis and jobs
read is withheld from its author's runs. Run reads query it in SQL
(``oracle.intake.evidence.run_withheld``) instead of parsing every intake per request.
``intake_shared_items`` lists what the findings shared in full cite: any run reads those
in full text unless an intake withholds them (round 6, owner 2026-10-19).
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, Index, Text, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in
from oracle.v2.models import _fk, _json, _updated_at

PROPOSAL_KINDS = ("research_run", "prd_patch")
PROPOSAL_STATUSES = ("proposed", "accepted", "dismissed")


class IntakeProposal(TenantScoped, Base):
    __tablename__ = "intake_proposals"
    __table_args__ = (
        CheckConstraint(_in("kind", PROPOSAL_KINDS), name="kind"),
        CheckConstraint(_in("status", PROPOSAL_STATUSES), name="status"),
    )

    intake_id: Mapped[uuid.UUID] = _fk("product_intakes", nullable=False)
    gap_id: Mapped[uuid.UUID | None] = _fk("knowledge_gaps", "SET NULL")
    question_id: Mapped[uuid.UUID | None] = _fk("stakeholder_questions", "SET NULL")
    answer_id: Mapped[uuid.UUID | None] = _fk("stakeholder_answers", "SET NULL")
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    # research_run: gap ids, flow, depth; prd_patch: document, base version, section, text.
    detail: Mapped[dict[str, Any]] = _json()
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="proposed", server_default="proposed"
    )
    # What accepting it made: {"run_id"} or {"feedback_item_id"}.
    result: Mapped[dict[str, Any]] = _json()
    # User or API token ids, no FK, as elsewhere.
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    decided_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decision_note: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = _updated_at()


class IntakeWithheldItem(TenantScoped, Base):
    """A source item its intake's author's runs may not read, while any finding of the
    intake is below "shared in full" (rewritten by ``evidence.record_reads``)."""

    __tablename__ = "intake_withheld_items"
    __table_args__ = (
        UniqueConstraint("intake_id", "item_id"),
        Index("ix_intake_withheld_items_user_id_item_id", "user_id", "item_id"),
    )

    intake_id: Mapped[uuid.UUID] = _fk("product_intakes", nullable=False)
    # The intake's author (no FK, as elsewhere): whose runs may not read the item.
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    # No FK: a deleted item withheld stays withheld until the intake is recomputed.
    item_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)


class IntakeSharedItem(TenantScoped, Base):
    """A source item cited by a finding its intake's author shared in full: readable in
    full text by runs (S6, owner 2026-10-19), unless an intake withholds it
    (``IntakeWithheldItem``, which always wins). Rewritten by ``evidence.record_reads``."""

    __tablename__ = "intake_shared_items"
    __table_args__ = (
        UniqueConstraint("intake_id", "item_id"),
        Index("ix_intake_shared_items_item_id_user_id", "item_id", "user_id"),
    )

    intake_id: Mapped[uuid.UUID] = _fk("product_intakes", nullable=False)
    # The intake's author, whose item it is (no FK, as elsewhere).
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    item_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
