"""What an intake proposes: research runs and PRD patches (migration 0014_intake).

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
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, Text, Uuid
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
