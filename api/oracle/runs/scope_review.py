"""C7 Scope review: approvers decide, edit, add and enhance the feature-set stop's rows,
then approve with edits (no agent round) or send a structured list back.

One store per kind of change (no second staging table):

- An approver's decision or edit on a row writes the **proposed scope rows**
  (``prd_scope_items``, the draft until approval), with the agent's values kept in
  ``original`` for Undo. Every such write re-checks the scope (C6
  :func:`feature_set.check_scope`), keeps the result on the checkpoint for D3's gate, and
  bumps the checkpoint's D8 draft revision.
- Suggestions, waivers and to-confirm accepts are D8 ``checkpoint_actions`` on the row's
  key, in this kind's vocabulary (:func:`oracle.runs.actions._feature_set`). Staging a
  commenter's suggested ``edit`` or ``add`` applies it here (:func:`apply_action`) and
  removes the action.

On approval (:func:`approved`): each requirement a person added becomes a locked, confirmed
``requirement`` entity of the approver's with a ``part_of`` edge to its feature, and each
existing requirement whose text a person edited gets the same direct edit; the agents'
own proposals stay proposals. On send-back, :func:`scope_entries` is D4's entry builder.

The writes commit; :func:`read` does not write.
"""

import re
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.deps import Principal
from oracle.authz import has_role
from oracle.baseline.models import Entity, Proposal
from oracle.jobs.models import LlmJob
from oracle.runs import feature_set, gate, service
from oracle.runs.models import Checkpoint, CheckpointAction, Run
from oracle.runs.schemas import (
    PrdScopeReview,
    ScopeEnhanceAccept,
    ScopeEnhanceIn,
    ScopeGoal,
    ScopeGoalChoice,
    ScopeGoalIn,
    ScopeHistory,
    ScopeItemOut,
    ScopeItemPatch,
    ScopeReason,
    ScopeRequirementIn,
    ScopeReviewFeature,
    ScopeReviewRequirement,
    ScopeSummary,
)
from oracle.runs.scope_models import (
    FEATURE_DECISIONS,
    REQUIREMENT_DECISIONS,
    PrdScope,
    PrdScopeItem,
)

DECIDED = "This feature set is already decided"
STALE = "This row changed since you loaded it: reload to see the latest"
AGENTS_READ_ONLY = "A run token cannot change a feature set: agents read it with get_prd_scope"
NOT_WAIVED = "This cannot be waived; leave it out or send it back"
LEAVE_OUT_REASONS = ("no_goal", "not_now", "out_of_scope", "duplicate")
# The audit events of the writes (each one bumps the checkpoint's draft revision).
EDITED, ADDED, REMOVED = "prd_scope.item_edited", "prd_scope.item_added", "prd_scope.item_removed"
# A flag (C6) is a reason a person confirms.
FLAG_LABELS = {
    "serves_no_goal": "Serves no confirmed goal",
    "low_confidence": "Low confidence",
    "linked_blocker": "Linked open blocker",
    "new_feature": "New, not in the baseline",
    "duplicate_of_existing": "Duplicate of an existing feature",
}
# What a row's history keeps of the agent's values.
FIELDS = ("decision", "decision_reason", "text", "acceptance", "goals", "depends_on",
          "blocker_keys")  # fmt: skip
ENTITY_TITLE = 80


def _now() -> datetime:
    return datetime.now(UTC)


def is_added(item: PrdScopeItem) -> bool:
    """A requirement a person added (it has no agent's values)."""
    return item.origin == "person" and not item.original


def is_edited(item: PrdScopeItem) -> bool:
    if is_added(item):
        return True
    if not item.original:
        return False
    now = feature_set.original_of(item)
    return any(now.get(f) != item.original.get(f) for f in FIELDS)


# --------------------------------------------------------------------------- reasons


def _answers(action: Any, code: str, kind: str) -> bool:
    return (
        getattr(action, "state", None) == "staged"
        and action.kind == kind
        and (not action.answers or code in action.answers)
    )


def reasons_of(
    scope: PrdScope, items: list[PrdScopeItem], actions: list[Any]
) -> dict[str, list[ScopeReason]]:
    """Each feature's reasons: the blocking problems of the scope's stored check and its
    flags to confirm, each ``answered`` by a staged D8 waiver (blocking, a waivable code)
    or accept (to confirm) on its key."""
    check = scope.check_result or {}
    by_key: dict[str, list[Any]] = {}
    for a in actions:
        by_key.setdefault(a.item_key, []).append(a)
    out: dict[str, list[ScopeReason]] = {}
    for p in check.get("problems") or []:
        key = p.get("feature")
        if not key or p.get("code") in feature_set.FILE_PROBLEMS:
            continue
        code = p.get("code") or "problem"
        blocking = p.get("blocking", True)
        severity = "blocking" if blocking else "to_confirm"
        can_waive = blocking and gate.waivable("feature_set", code)
        mine = by_key.get(key, [])
        answered = (
            any(_answers(a, code, "waive") for a in mine)
            if blocking
            else any(_answers(a, code, "accept") for a in mine)
        )
        out.setdefault(key, []).append(
            ScopeReason(
                code=code,
                severity=severity,  # type: ignore[arg-type]
                label=p.get("message") or code,
                requirement=p.get("requirement"),
                waivable=can_waive,
                answered=bool(answered and (can_waive or not blocking)),
            )
        )
    for item in items:
        if item.kind != "feature" or item.decision != "include":
            continue
        mine = by_key.get(item.key, [])
        for flag in item.flags or []:
            out.setdefault(item.key, []).append(
                ScopeReason(
                    code=flag,
                    severity="to_confirm",
                    label=FLAG_LABELS.get(flag, flag.replace("_", " ")),
                    answered=any(_answers(a, flag, "accept") for a in mine),
                )
            )
    return out


def summary_of(
    scope: PrdScope, items: list[PrdScopeItem], actions: list[Any]
) -> tuple[ScopeSummary, dict[str, list[ScopeReason]]]:
    reasons = reasons_of(scope, items, actions)
    features = [i for i in items if i.kind == "feature"]
    out = ScopeSummary(features=len(features))
    for f in features:
        open_ = [r for r in reasons.get(f.key, []) if not r.answered]
        out.needs_you += bool(open_)
        out.blocking += sum(1 for r in open_ if r.severity == "blocking")
        out.to_confirm += sum(1 for r in open_ if r.severity == "to_confirm")
    out.handled = out.features - out.needs_you
    out.edits = sum(1 for i in items if is_edited(i))
    out.suggestions_open = sum(1 for a in actions if a.state == "suggested")
    return out, reasons


async def _actions(db: AsyncSession, cp: Checkpoint | None) -> list[CheckpointAction]:
    if cp is None:
        return []
    return list(
        await db.scalars(select(CheckpointAction).where(CheckpointAction.checkpoint_id == cp.id))
    )


# --------------------------------------------------------------------------- read


async def _names(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, str]:
    from oracle.runs import actions

    people = await actions._people(db, ids)
    return {i: p.name for i, p in people.items()}


def _history(item: PrdScopeItem, names: dict[uuid.UUID, str]) -> ScopeHistory:
    return ScopeHistory(
        original=dict(item.original or {}),
        decided_by=item.decided_by,
        decided_by_name=names.get(item.decided_by) if item.decided_by else None,
        decided_at=item.decided_at,
    )


async def _previous(
    db: AsyncSession, scope: PrdScope
) -> tuple[dict[str, str] | None, dict[str, list[str]] | None]:
    """The previous attempt's decisions and kept requirements, by feature key."""
    before = await db.scalar(
        select(PrdScope)
        .where(
            PrdScope.run_id == scope.run_id,
            PrdScope.segment_seq == scope.segment_seq,
            PrdScope.attempt < scope.attempt,
        )
        .order_by(PrdScope.attempt.desc())
        .limit(1)
    )
    if before is None:
        return None, None
    items = await feature_set.scope_items(db, before.id)
    keys = {i.id: i.key for i in items if i.kind == "feature"}
    decisions = {i.key: i.decision for i in items if i.kind == "feature"}
    reqs: dict[str, list[str]] = {k: [] for k in decisions}
    for i in items:
        if i.kind == "requirement" and i.decision == "keep" and i.parent_id in keys:
            reqs[keys[i.parent_id]].append(i.key)
    return decisions, reqs


async def _scope(db: AsyncSession, scope_id: uuid.UUID, *, lock: bool = False) -> PrdScope:
    q = select(PrdScope).where(PrdScope.id == scope_id).execution_options(populate_existing=True)
    if lock:
        q = q.with_for_update()
    scope = await db.scalar(q)
    if scope is None:
        raise service.NotFound(f"PRD scope {scope_id} not found")
    return scope


async def _title(db: AsyncSession, run: Run | None) -> str | None:
    """The PRD the scope is for: its document's title, else the slug the run names."""
    from oracle.docs.models import Document

    if run is None:
        return None
    document = await db.get(Document, run.document_id) if run.document_id else None
    if document is not None:
        return document.title
    slug = (run.knobs or {}).get("document_slug")
    return str(slug) if slug else None


async def read(db: AsyncSession, principal: Principal, scope_id: uuid.UUID) -> PrdScopeReview:
    scope = await _scope(db, scope_id)
    items = await feature_set.scope_items(db, scope.id)
    cp = await db.get(Checkpoint, scope.checkpoint_id) if scope.checkpoint_id else None
    acts = await _actions(db, cp)
    summary, reasons = summary_of(scope, items, acts)
    names = await _names(db, [i.decided_by for i in items if i.decided_by])
    base = feature_set.scope_out(scope, items)
    by_id = {i.id: i for i in items}
    features = []
    for f in base.features:
        row = by_id[f.id]
        mine = reasons.get(f.key, [])
        features.append(
            ScopeReviewFeature(
                **f.model_dump(exclude={"requirements"}),
                text=row.text,
                position=row.position,
                lock_version=row.lock_version,
                evidence_ids=list(row.evidence_ids or []),
                edited=is_edited(row),
                reasons=mine,
                needs_you=any(not r.answered for r in mine),
                history=_history(row, names),
                requirements=[
                    ScopeReviewRequirement(
                        **r.model_dump(),
                        parent_id=f.id,
                        position=by_id[r.id].position,
                        lock_version=by_id[r.id].lock_version,
                        edited=is_edited(by_id[r.id]),
                        added=is_added(by_id[r.id]),
                        history=_history(by_id[r.id], names),
                    )
                    for r in f.requirements
                ],
            )
        )
    previous, previous_reqs = await _previous(db, scope)
    run = await db.get(Run, scope.run_id)
    goals = await db.scalars(
        select(Entity)
        .where(Entity.type == "goal", Entity.status == "confirmed")
        .order_by(Entity.title)
    )
    can_edit = (
        cp is not None
        and cp.status == "pending"
        and scope.status == "proposed"
        and not principal.is_run
        and not principal.read_only
        and has_role(principal.role, cp.approver_role)  # type: ignore[arg-type]
    )
    return PrdScopeReview(
        **base.model_dump(exclude={"features"}),
        checkpoint_id=scope.checkpoint_id,
        title=await _title(db, run),
        features=features,
        summary=summary,
        previous=previous,
        previous_requirements=previous_reqs,
        goals_available=[ScopeGoalChoice(goal_id=g.id, key=g.key, title=g.title) for g in goals],
        can_edit=can_edit,
    )


# --------------------------------------------------------------------------- writes


async def _writable(
    db: AsyncSession, principal: Principal, scope_id: uuid.UUID
) -> tuple[Run, Checkpoint, PrdScope]:
    """The run (locked), the pending checkpoint and the proposed scope (locked); the
    caller holds the checkpoint's approver role, read now under the review gate."""
    from oracle.runs import actions

    if principal.is_run:
        raise service.Forbidden(AGENTS_READ_ONLY)
    scope = await _scope(db, scope_id)
    if scope.checkpoint_id is None:
        raise service.RunError(DECIDED)
    try:
        run, cp = await actions._writable(
            db, principal, scope.run_id, scope.checkpoint_id, stage=True
        )
    except service.RunError as exc:
        if exc.status == 409:
            raise service.RunError(DECIDED) from None
        raise
    scope = await _scope(db, scope_id, lock=True)
    if scope.status != "proposed":
        raise service.RunError(DECIDED)
    return run, cp, scope


async def _item(db: AsyncSession, scope: PrdScope, item_id: uuid.UUID) -> PrdScopeItem:
    item = await db.scalar(
        select(PrdScopeItem)
        .where(PrdScopeItem.id == item_id, PrdScopeItem.scope_id == scope.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if item is None:
        raise service.NotFound(f"scope row {item_id} not found")
    return item


async def _goals(db: AsyncSession, goals: list[ScopeGoalIn]) -> list[dict[str, Any]]:
    """Confirmed goals only (422 otherwise)."""
    ids = [g.goal_id for g in goals]
    found = {
        e.id: e
        for e in await db.scalars(select(Entity).where(Entity.id.in_(ids), Entity.type == "goal"))
    }
    out = []
    for g in goals:
        e = found.get(g.goal_id)
        if e is None or e.status != "confirmed":
            raise service.Invalid(f"goal {g.goal_id} is not a confirmed goal: pick a confirmed one")
        out.append({"goal_id": str(e.id), "key": e.key, "contribution": g.contribution})
    return out


def _reason(decision: str, reason: str | None) -> str | None:
    if decision not in ("exclude", "defer"):
        return None
    if reason is None or not reason.strip():
        if decision == "exclude":
            raise service.Invalid(
                "leaving a feature out needs a reason: no_goal, not_now, out_of_scope, "
                "duplicate or other:<text>"
            )
        return None
    reason = reason.strip()
    if reason in LEAVE_OUT_REASONS:
        return reason
    if reason.startswith("other:") and reason.removeprefix("other:").strip():
        return reason
    raise service.Invalid(
        "decision_reason is no_goal, not_now, out_of_scope, duplicate or other:<text>"
    )


def _keep_original(item: PrdScopeItem) -> None:
    """The agent's values, kept before a person's first change (a row written before C7
    has none yet)."""
    if not item.original and item.origin == "agent":
        item.original = feature_set.original_of(item)


async def _apply(db: AsyncSession, item: PrdScopeItem, changes: dict[str, Any]) -> None:
    """One person's change to the row (the patch's fields that are set), checked."""
    feature = item.kind == "feature"
    if "decision" in changes:
        decision = changes["decision"]
        allowed = FEATURE_DECISIONS if feature else REQUIREMENT_DECISIONS
        if decision not in allowed:
            raise service.Invalid(f"a {item.kind} is {', '.join(allowed)}")
    for f in ("text", "acceptance"):
        if f in changes and feature:
            raise service.Invalid(f"{f} is a requirement's: change it on the requirement")
    for f in ("goals", "depends_on", "blocker_keys"):
        if f in changes and not feature:
            raise service.Invalid(f"{f} is a feature's: change it on the feature")
    if "goals" in changes:
        changes["goals"] = await _goals(db, changes["goals"])
    if "depends_on" in changes and item.key in changes["depends_on"]:
        raise service.Invalid("a feature cannot depend on itself")
    _keep_original(item)
    if "decision" in changes:
        item.decision = changes["decision"]
        item.decision_reason = _reason(item.decision, changes.get("decision_reason"))
    elif "decision_reason" in changes and item.decision in ("exclude", "defer"):
        item.decision_reason = _reason(item.decision, changes["decision_reason"])
    if "text" in changes:
        item.text = changes["text"].strip()
        item.title = item.text[:200]
    if "acceptance" in changes:
        item.acceptance = [a.strip() for a in changes["acceptance"] if a.strip()]
    if "goals" in changes:
        item.goals = changes["goals"]
    if "depends_on" in changes:
        item.depends_on = list(dict.fromkeys(changes["depends_on"]))
    if "blocker_keys" in changes:
        item.blocker_keys = list(dict.fromkeys(changes["blocker_keys"]))
    if "text" in changes or "acceptance" in changes:
        # The requirement's words are now the person's.
        item.origin = "person"


def _revert(item: PrdScopeItem) -> None:
    if is_added(item):
        raise service.Invalid("a requirement a person added is removed, not reverted")
    o = item.original or {}
    if not o:
        return
    item.decision = o.get("decision", item.decision)
    item.decision_reason = o.get("decision_reason")
    item.text = o.get("text")
    if item.kind == "requirement" and item.text:
        item.title = item.text[:200]
    item.acceptance = list(o.get("acceptance") or [])
    item.goals = [dict(g) for g in o.get("goals") or []]
    item.depends_on = list(o.get("depends_on") or [])
    item.blocker_keys = list(o.get("blocker_keys") or [])
    item.origin = "agent"


async def _done(
    db: AsyncSession,
    principal: Principal,
    run: Run,
    cp: Checkpoint,
    scope: PrdScope,
    item: PrdScopeItem,
    event: str,
    data: dict[str, Any],
) -> ScopeItemOut:
    """After a write: re-check the scope (the gate reads it), bump the draft revision,
    audit, commit; the row with the new tally."""
    from oracle.runs import actions

    await db.flush()
    await service._recheck_scope(db, cp)
    scope.lock_version += 1
    await actions._bump(db, principal, run, cp, event, item.key, data)
    await db.commit()
    items = await feature_set.scope_items(db, scope.id)
    summary, _ = summary_of(scope, items, await _actions(db, cp))
    return item_out(item, summary, cp.draft_revision or 0, scope.lock_version)


def item_out(
    item: PrdScopeItem, summary: ScopeSummary, revision: int, scope_lock: int
) -> ScopeItemOut:
    return ScopeItemOut(
        id=item.id,
        kind=item.kind,  # type: ignore[arg-type]
        key=item.key,
        parent_id=item.parent_id,
        title=item.title,
        text=item.text,
        acceptance=list(item.acceptance or []),
        decision=item.decision,  # type: ignore[arg-type]
        decision_reason=item.decision_reason,
        origin=item.origin,  # type: ignore[arg-type]
        goals=[ScopeGoal(**g) for g in item.goals or []],
        depends_on=list(item.depends_on or []),
        blocker_keys=list(item.blocker_keys or []),
        lock_version=item.lock_version,
        edited=is_edited(item),
        added=is_added(item),
        original=dict(item.original or {}),
        summary=summary,
        revision=revision,
        scope_lock_version=scope_lock,
    )


def _decided(item: PrdScopeItem, principal: Principal) -> None:
    item.decided_by = principal.id
    item.decided_at = _now()
    item.lock_version += 1


async def patch_item(
    db: AsyncSession,
    principal: Principal,
    scope_id: uuid.UUID,
    item_id: uuid.UUID,
    body: ScopeItemPatch,
) -> ScopeItemOut:
    run, cp, scope = await _writable(db, principal, scope_id)
    item = await _item(db, scope, item_id)
    if body.lock_version != item.lock_version:
        raise service.RunError(STALE)
    changes = body.model_dump(exclude_unset=True, exclude={"lock_version", "revert"})
    if body.goals is not None:
        changes["goals"] = body.goals
    if body.revert:
        _revert(item)
    elif not changes:
        raise service.Invalid("nothing to change: name a field, or revert")
    else:
        await _apply(db, item, changes)
    _decided(item, principal)
    data = {"scope_id": str(scope.id), "item_id": str(item.id), "revert": body.revert,
            "fields": sorted(changes)}  # fmt: skip
    return await _done(db, principal, run, cp, scope, item, EDITED, data)


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:60].strip("-") or "requirement"


async def _unique_key(db: AsyncSession, scope: PrdScope, base: str) -> str:
    taken = set(
        await db.scalars(
            select(PrdScopeItem.key).where(
                PrdScopeItem.scope_id == scope.id, PrdScopeItem.kind == "requirement"
            )
        )
    ) | set(await db.scalars(select(Entity.key).where(Entity.type == "requirement")))
    key, n = base, 2
    while key in taken:
        key, n = f"{base}-{n}", n + 1
    return key


async def _add(
    db: AsyncSession,
    principal: Principal,
    scope: PrdScope,
    parent: PrdScopeItem,
    text: str,
    acceptance: list[str],
    goals: list[dict[str, Any]] | None,
) -> PrdScopeItem:
    if parent.kind != "feature":
        raise service.Invalid("a requirement is added to a feature")
    text = text.strip()
    if not text:
        raise service.Invalid("a requirement needs text")
    siblings = await db.scalars(
        select(PrdScopeItem.position).where(PrdScopeItem.parent_id == parent.id)
    )
    item = PrdScopeItem(
        id=uuid.uuid4(),
        scope_id=scope.id,
        kind="requirement",
        parent_id=parent.id,
        key=await _unique_key(db, scope, f"{parent.key}-{_slug(text)}"[:80]),
        title=text[:200],
        text=text,
        acceptance=[a.strip() for a in acceptance if a.strip()],
        goals=goals if goals is not None else [dict(g) for g in parent.goals or []],
        decision="keep",
        origin="person",
        original={},
        position=max(list(siblings), default=-1) + 1,
        lock_version=1,
        decided_by=principal.id,
        decided_at=_now(),
    )
    db.add(item)
    return item


async def add_requirement(
    db: AsyncSession, principal: Principal, scope_id: uuid.UUID, body: ScopeRequirementIn
) -> ScopeItemOut:
    run, cp, scope = await _writable(db, principal, scope_id)
    parent = await _item(db, scope, body.parent_id)
    goals = await _goals(db, body.goals) if body.goals is not None else None
    item = await _add(db, principal, scope, parent, body.text, body.acceptance, goals)
    data = {"scope_id": str(scope.id), "item_id": str(item.id), "parent": parent.key}
    return await _done(db, principal, run, cp, scope, item, ADDED, data)


async def delete_item(
    db: AsyncSession, principal: Principal, scope_id: uuid.UUID, item_id: uuid.UUID
) -> None:
    from oracle.runs import actions

    run, cp, scope = await _writable(db, principal, scope_id)
    item = await _item(db, scope, item_id)
    if not is_added(item):
        raise service.RunError("Only a requirement a person added is removed: cut this one instead")
    key = item.key
    await db.delete(item)
    await db.flush()
    await service._recheck_scope(db, cp)
    scope.lock_version += 1
    await actions._bump(db, principal, run, cp, REMOVED, key,
                        {"scope_id": str(scope.id), "item_id": str(item_id)})  # fmt: skip
    await db.commit()


# --------------------------------------------------------------------------- D8 actions


async def apply_action(
    db: AsyncSession, principal: Principal, cp: Checkpoint, action: CheckpointAction
) -> bool:
    """An approver accepts a commenter's suggested ``edit`` or ``add`` on a feature-set
    checkpoint: it is applied to the scope's row as the approver's (``decided_by``) and
    the action is removed. False when the action is not one this applies (it is staged as
    usual). The caller bumps the revision and commits."""
    if cp.kind != "feature_set" or action.kind not in ("edit", "add"):
        return False
    await apply_change(db, principal, cp, action.item_key, action.kind, action.field,
                       action.value)  # fmt: skip
    await db.delete(action)
    await db.flush()
    return True


async def apply_change(
    db: AsyncSession,
    principal: Principal,
    cp: Checkpoint,
    item_key: str,
    kind: str,
    field: str | None,
    value: Any,
) -> None:
    """A D8 ``edit`` or ``add`` on a feature-set row, applied to the scope as the
    approver's: an accepted suggestion, or an approver's own action (nothing is staged).
    The caller bumps the revision and commits."""
    scope = await service._scope_of(db, cp)
    if scope is None or scope.status != "proposed":
        raise service.RunError(DECIDED)
    item = await db.scalar(
        select(PrdScopeItem)
        .where(PrdScopeItem.scope_id == scope.id, PrdScopeItem.key == item_key)
        .order_by(PrdScopeItem.kind)
        .with_for_update()
    )
    if item is None:
        raise service.Invalid(f"{item_key} is not a row of this feature set")
    if kind == "add":
        v = value if isinstance(value, dict) else {}
        await _add(db, principal, scope, item, str(v.get("text") or ""),
                   [str(a) for a in v.get("acceptance") or []], None)  # fmt: skip
    else:
        field = field or ""
        changes: dict[str, Any]
        if field == "decision":
            v = value if isinstance(value, dict) else {"decision": value}
            changes = {"decision": v.get("decision"), "decision_reason": v.get("reason")}
        elif field == "goals":
            changes = {"goals": [ScopeGoalIn(**g) for g in value or []]}
        else:
            changes = {field: value}
        await _apply(db, item, changes)
        _decided(item, principal)
    await db.flush()
    await service._recheck_scope(db, cp)
    scope.lock_version += 1


# --------------------------------------------------------------------------- enhance


async def enhance(
    db: AsyncSession,
    principal: Principal,
    scope_id: uuid.UUID,
    item_id: uuid.UUID,
    body: ScopeEnhanceIn,
) -> LlmJob:
    """Queue a ``scope_enhance`` job for a requirement (one live job per row)."""
    _, _, scope = await _writable(db, principal, scope_id)
    item = await _item(db, scope, item_id)
    if item.kind != "requirement":
        raise service.Invalid("Enhance deepens a requirement")
    live = await db.scalar(
        select(LlmJob).where(
            LlmJob.scope_id == scope.id,
            LlmJob.kind == "scope_enhance",
            LlmJob.status.in_(("queued", "running")),
            LlmJob.input["item_id"].astext == str(item.id),
        )
    )
    if live is not None:
        await db.commit()
        return live
    job = LlmJob(
        kind="scope_enhance",
        scope_id=scope.id,
        status="queued",
        input={
            "item_id": str(item.id),
            "item_key": item.key,
            **({"instruction": body.instruction.strip()} if body.instruction else {}),
        },
        requested_by=principal.id,
        attempts=0,
    )
    db.add(job)
    await db.flush()
    await audit.record(db, principal, "llm_job.queue", "llm_job", job.id,
                       {"kind": "scope_enhance", "scope_id": str(scope.id),
                        "item_key": item.key})  # fmt: skip
    await db.commit()
    await db.refresh(job)
    return job


async def enhance_payload(db: AsyncSession, job: LlmJob) -> dict[str, Any]:
    """What the model is given: the feature's title and summary, the requirement's text
    and acceptance, the goal titles, and the intake's brief when the run has one."""
    from oracle.jobs.kinds import JobInputError
    from oracle.v2.models import ProductIntake

    scope = await db.get(PrdScope, job.scope_id) if job.scope_id else None
    if scope is None:
        raise JobInputError("the feature set no longer exists")
    raw = (job.input or {}).get("item_id")
    item = await db.get(PrdScopeItem, uuid.UUID(str(raw))) if raw else None
    if item is None or item.scope_id != scope.id:
        raise JobInputError("the requirement is no longer in the feature set")
    parent = await db.get(PrdScopeItem, item.parent_id) if item.parent_id else None
    goal_ids = []
    for g in (parent.goals if parent else []) or []:
        try:
            goal_ids.append(uuid.UUID(str(g.get("goal_id"))))
        except ValueError:
            continue
    titles = (
        list(await db.scalars(select(Entity.title).where(Entity.id.in_(goal_ids))))
        if goal_ids
        else []
    )
    payload: dict[str, Any] = {
        "feature": {
            "title": parent.title if parent else None,
            "summary": parent.text if parent else None,
        },
        "requirement": {"text": item.text, "acceptance": list(item.acceptance or [])},
        "goals": titles,
    }
    run = await db.get(Run, scope.run_id)
    intake_id = (run.knobs or {}).get("intake_id") if run is not None else None
    if intake_id:
        try:
            intake = await db.get(ProductIntake, uuid.UUID(str(intake_id)))
        except ValueError:
            intake = None
        if intake is not None and intake.brief:
            payload["brief"] = intake.brief
    instruction = (job.input or {}).get("instruction")
    if instruction:
        payload["instruction"] = instruction
    return payload


def _lines(value: Any, limit: int = 500) -> list[str]:
    items = value if isinstance(value, list) else []
    return [str(v).strip()[:limit] for v in items[:20] if isinstance(v, str) and v.strip()]


def enhance_output(answer: dict[str, Any], item_id: str) -> dict[str, Any]:
    """The model's answer, checked: invalid is a transient failure (worker rules)."""
    from oracle.jobs import prompting

    text = answer.get("text")
    if not isinstance(text, str) or not text.strip():
        raise prompting.AnswerError("the answer has no text")
    return {
        "item_id": item_id,
        "text": text.strip()[:1000],
        "acceptance": _lines(answer.get("acceptance")),
        "edge_cases": _lines(answer.get("edge_cases")),
        "data_needs": _lines(answer.get("data_needs")),
    }


async def accept_enhancement(
    db: AsyncSession,
    principal: Principal,
    scope_id: uuid.UUID,
    item_id: uuid.UUID,
    job_id: uuid.UUID,
    body: ScopeEnhanceAccept,
) -> ScopeItemOut:
    run, cp, scope = await _writable(db, principal, scope_id)
    item = await _item(db, scope, item_id)
    job = await db.get(LlmJob, job_id)
    if (
        job is None
        or job.kind != "scope_enhance"
        or job.scope_id != scope.id
        or (job.input or {}).get("item_id") != str(item.id)
    ):
        raise service.NotFound(f"enhancement {job_id} not found for this requirement")
    if job.status != "succeeded" or not job.output:
        raise service.RunError(f"the enhancement is {job.status}: wait for it, or ask again")
    text = body.text if body.text is not None else job.output.get("text")
    acceptance = body.acceptance if body.acceptance is not None else job.output.get("acceptance")
    await _apply(db, item, {"text": str(text or ""), "acceptance": list(acceptance or [])})
    _decided(item, principal)
    data = {"scope_id": str(scope.id), "item_id": str(item.id), "job_id": str(job.id),
            "edited": body.text is not None or body.acceptance is not None}  # fmt: skip
    return await _done(db, principal, run, cp, scope, item, EDITED, data)


# --------------------------------------------------------------------------- approval


async def approved(
    db: AsyncSession, principal: Principal | None, run: Run, cp: Checkpoint, scope: PrdScope
) -> dict[str, Any]:
    """Approve with edits (call c2): the requirements a person added become locked,
    confirmed baseline requirements of the approver's with a ``part_of`` edge to their
    feature; an existing requirement whose words a person changed gets the same direct
    edit. The agents' proposals stay proposals. Returns what the approval audit adds:
    ``edits``, ``waived`` codes and the ``entities`` written."""
    from oracle.baseline import service as baseline

    items = await feature_set.scope_items(db, scope.id)
    acts = await _actions(db, cp)
    features = {i.id: i for i in items if i.kind == "feature"}
    writer = baseline.Writer(principal, "user", reason="Feature set approved with edits")
    entities: list[str] = []
    for item in items:
        if item.kind != "requirement" or item.decision != "keep":
            continue
        parent = features.get(item.parent_id) if item.parent_id else None
        if parent is None or parent.decision != "include":
            continue
        if is_added(item) and item.entity_id is None:
            key = await _unique_key(db, scope, item.key) if await baseline.find_entity(
                db, "requirement", item.key) else item.key  # fmt: skip
            goal_keys = [g.get("key") for g in item.goals or [] if g.get("key")]
            result = await baseline.create_entity(
                db,
                writer,
                type_="requirement",
                key=key,
                title=(item.text or key)[:ENTITY_TITLE],
                body=item.text,
                attrs={"feature": parent.key, "goals": goal_keys,
                       "acceptance": list(item.acceptance or []), "from_scope": str(scope.id)},
                status="confirmed",
            )  # fmt: skip
            entity = result.entity
            if entity is None:
                continue
            item.entity_id = entity.id
            entities.append(str(entity.id))
            feature_id = await _feature_entity(db, run, parent)
            await baseline.create_edge(
                db, writer, src_id=entity.id, dst_id=feature_id, type_="part_of"
            )
        elif is_edited(item) and item.entity_id is not None:
            o = item.original or {}
            if o.get("text") == item.text and o.get("acceptance") == list(item.acceptance or []):
                continue
            entity = await db.get(Entity, item.entity_id)
            if entity is None:
                continue
            await baseline.update_entity(
                db,
                writer,
                entity,
                {"body": item.text, "attrs": {"acceptance": list(item.acceptance or [])}},
            )
            entities.append(str(entity.id))
    waived = sorted(
        {c for a in acts if a.state == "staged" and a.kind == "waive" for c in a.answers or []}
    )
    return {"edits": sum(1 for i in items if is_edited(i)), "waived": waived,
            "entities": entities}  # fmt: skip


async def _feature_entity(db: AsyncSession, run: Run, feature: PrdScopeItem) -> uuid.UUID:
    """The baseline entity a person's requirement is ``part_of``: the feature row's, the
    one of its key (its proposal was accepted since), else, for a feature the agents only
    proposed, the agents' proposed entity made from their proposal now. A person confirms
    or rejects it as any proposed entity; the agents' open create proposal it stands for
    is withdrawn (accepting it would only refuse: the feature exists)."""
    from oracle.baseline import service as baseline

    if feature.entity_id is not None:
        return feature.entity_id
    entity = await baseline.find_entity(db, "feature", feature.key)
    if entity is None:
        proposal = await db.get(Proposal, feature.proposal_id) if feature.proposal_id else None
        if proposal is not None and proposal.status != "open":
            proposal = None
        fields = ((proposal.payload or {}).get("fields") or {}) if proposal else {}
        why = "A person added a requirement to this new feature"
        writer = baseline.Writer(None, "agent", run_id=run.id, reason=why)
        result = await baseline.create_entity(
            db,
            writer,
            type_="feature",
            key=feature.key,
            title=str(fields.get("title") or feature.title or feature.key),
            body=fields.get("body") or feature.text,
            attrs=dict(fields.get("attrs") or {}),
            status="proposed",
        )
        if result.entity is None:
            raise service.RunError(f"feature {feature.key} could not be added to the baseline")
        entity = result.entity
        if proposal is not None:
            proposal.status = "withdrawn"
    feature.entity_id = entity.id
    return entity.id


async def edits_count(db: AsyncSession, cp: Checkpoint) -> int:
    scope = await service._scope_of(db, cp)
    if scope is None:
        return 0
    return sum(1 for i in await feature_set.scope_items(db, scope.id) if is_edited(i))


# --------------------------------------------------------------------------- send back


def scope_entries(
    items: list[PrdScopeItem], actions: list[Any], reasons: dict[str, list[ScopeReason]]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """D4's entry builder for ``feature_set``: one entry per changed or questioned row
    (``include | exclude | defer | cut | edit | enhance | add | question``) with its
    changes, reason and the person or suggestion it came from; then the waivers."""
    features = {i.id: i for i in items if i.kind == "feature"}
    entries: list[dict[str, Any]] = []
    for item in sorted(items, key=lambda i: (i.kind != "feature", i.position)):
        if not is_edited(item):
            continue
        o = item.original or {}
        entry: dict[str, Any] = {"id": item.key}
        if is_added(item):
            parent = features.get(item.parent_id) if item.parent_id else None
            entry["action"] = "add"
            entry["changes"] = {"parent": parent.key if parent else None, "text": item.text,
                                "acceptance": list(item.acceptance or [])}  # fmt: skip
        elif item.decision != o.get("decision"):
            entry["action"] = item.decision if item.decision != "keep" else "edit"
            if item.decision_reason:
                entry["note"] = item.decision_reason
        else:
            entry["action"] = "edit"
            changes = {
                f: feature_set.original_of(item)[f]
                for f in FIELDS
                if feature_set.original_of(item)[f] != o.get(f)
            }
            entry["changes"] = changes
        entries.append(entry)
    waived: list[dict[str, Any]] = []
    for a in actions:
        if a.state != "staged":
            continue
        if a.kind == "waive":
            why = a.value.get("reason") if isinstance(a.value, dict) else None
            codes = list(a.answers) or [r.code for r in reasons.get(a.item_key, [])]
            waived += [{"id": a.item_key, "code": c, "reason": why} for c in codes or [None]]
        elif a.kind == "question":
            text = a.value.get("text") if isinstance(a.value, dict) else None
            entries.append({"id": a.item_key, "action": "question", "question": text})
    return entries, waived


async def review_entries(
    db: AsyncSession, cp: Checkpoint, actions: list[Any]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]] | None:
    """The send-back entries of a feature-set checkpoint's scope, its waivers and its
    feature keys in order; None without a scope."""
    scope = await service._scope_of(db, cp)
    if scope is None:
        return None
    items = await feature_set.scope_items(db, scope.id)
    _, reasons = summary_of(scope, items, actions)
    entries, waived = scope_entries(items, actions, reasons)
    keys = [i.key for i in sorted(items, key=lambda i: i.position) if i.kind == "feature"]
    return entries, waived, keys
