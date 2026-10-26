"""H11 Autonomy for what Oracle drafts and never acts on: H4's strategy and vision, and
the words for people outside the company (``external_messages``).

Their ceilings are Recommend (``strategy``) and Draft (``vision``, ``external_messages``),
so nothing here acts, sends or notifies: Observe stops Oracle drafting, the levels above
shape what it drafts. C1's why-not replies ask ``external_messages`` themselves
(:func:`oracle.requests.replies.drafts_allowed`).

- **Runs that write the text** (:func:`run_refusal`, at run creation): a ``strategy_draft``
  or ``feedback_loop`` run on a product strategy or a vision, and an ``update_draft`` or
  ``feedback_loop`` run on a board or investor update, are refused at Observe. The drift
  check and the documents themselves stay: an owner can still write them by hand.
- **The product strategy's draft** (:func:`strategy_lines`): at Draft the agents write the
  choices the owner and the company's own material name and recommend none; at Recommend
  they propose choices with the alternative weighed and a default; the owner decides.
- **The launch kit** (:func:`kit_lines`, :func:`kit_external_allowed`): at Observe it drafts
  internal texts only; its import drops external tasks, public changelog entries and
  notes to people outside the company.
"""

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from oracle import autonomy

# Document kind -> (responsibility, what Oracle does not draft at Observe).
_KINDS = {
    "strategy": ("strategy", "product strategy"),
    "vision": ("vision", "vision"),
    "update": ("external_messages", "board or investor update"),
}
# The flows that write a document of these kinds.
_FLOWS = ("strategy_draft", "update_draft", "feedback_loop")

STRATEGY_DRAFT = (
    "Oracle is set to Draft for the product strategy: write the focus and stop choices the "
    "owner's brief and the company's own strategy material name, for the owner to edit and "
    "own. Add no choice of your own and recommend none; where the material leaves a choice "
    "open, say so in Trade-offs and risks."
)
STRATEGY_RECOMMEND = (
    "Oracle is set to Recommend for the product strategy: propose the focus and stop "
    "choices the evidence supports. For each, name the alternative you weighed, the "
    "evidence for both and why yours is the default; the owner decides by approving."
)
KIT_OBSERVE = (
    "Oracle is set to Observe for words for people outside the company: draft only the "
    "internal tasks (internal_announcement, support_notes, sales_briefing, pre_mortem), "
    "internal changelog entries and notes to members (member:<id>). Leave release notes, "
    "help docs, in-app message, customer email, public entries and notes to anyone else "
    "to people."
)


async def run_refusal(db: AsyncSession, flow: str, document_kind: str | None) -> str | None:
    """Why a run may not draft this document at the company's level (409), or None."""
    if flow not in _FLOWS or document_kind not in _KINDS:
        return None
    key, what = _KINDS[document_kind]
    if await autonomy.allows(db, key, "draft"):
        return None
    return f"Oracle drafts no {what} at Observe"


async def strategy_lines(db: AsyncSession, document_kind: str | None) -> list[str]:
    """The product strategy's level for a strategy_draft run's prompt (none for a vision)."""
    if document_kind != "strategy":
        return []
    level = await autonomy.level(db, "strategy")
    if level == "draft":
        return [STRATEGY_DRAFT]
    if level == "recommend":
        return [STRATEGY_RECOMMEND]
    return []


async def kit_external_allowed(db: AsyncSession) -> bool:
    """Whether the launch kit drafts words for people outside (Draft, the default)."""
    return await autonomy.allows(db, "external_messages", "draft")


async def kit_lines(db: AsyncSession, run: Any) -> list[str]:
    """The launch kit's prompt line at Observe (none at Draft)."""
    return [] if await kit_external_allowed(db) else [KIT_OBSERVE]
