"""Runs: a segment's end: its draft imported and checked, and the run advanced."""

import uuid
from dataclasses import dataclass
from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, autonomy, company_time, safe_yaml, webhooks, wording
from oracle.auth.deps import Principal
from oracle.auth.models import ApiToken, User
from oracle.baseline import yaml_io
from oracle.docs import draft_checks
from oracle.docs import service as docs_service
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.docs.parser import DraftError
from oracle.docs.schemas import ImportProblem, VersionSource
from oracle.engineering import check as eng_check
from oracle.engineering import dates as eng_dates
from oracle.errors import exception_text
from oracle.jobs.models import LlmSuggestion
from oracle.priorities import run_order
from oracle.priorities.models import PrioritySnapshot
from oracle.review.models import FeedbackItem
from oracle.review.schemas import Resolution
from oracle.roadmap import company as roadmap_company
from oracle.roadmap import schedule
from oracle.runs import (
    extensions,
    feature_set,
    flows,
    reasons,
    rejection,
    roadmap,
    service,
    stop_answers,
    workflow,
)
from oracle.runs import resolutions as answers
from oracle.runs.batch import once
from oracle.runs.models import Checkpoint, Run, RunSegment
from oracle.runs.scope_models import PrdScope
from oracle.runs.service import (
    ITEMS_FILE,
    _art,
    _flow,
    _knobs,
    _set_art,
    _set_knob,
    _TickStats,
    log,
)
from oracle.swarm import RuntimeUnavailable
from oracle.swarm.runtime import NOT_YET
from oracle.swarm.settings import get_runtime_settings
from oracle.tenancy import current_tenant, tenant_session


def _creator(principal_tenant: uuid.UUID, user: User | None, token: ApiToken | None) -> Principal:
    if user is not None and user.disabled_at is not None:
        # A disabled member's runs act for no one (C2); disabling cancels them too.
        raise LookupError("run creator is disabled")
    if user is not None:
        return Principal(
            tenant_id=principal_tenant,
            kind="user",
            role=user.role,  # type: ignore[arg-type]
            user_id=user.id,
        )
    if token is not None:
        return Principal(
            tenant_id=principal_tenant,
            kind="token",
            role=token.role,  # type: ignore[arg-type]
            token_id=token.id,
        )
    raise LookupError("run creator not found")


async def _loop_plan_inputs(
    db: AsyncSession, run: Run
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    """What a roadmap draft without an items file of its own (the feedback loop's next
    draft, the owner Nov 4) builds its plan tables from, as the roadmap was when the run
    started (so the brief and the check read the same): (its latest items of the PRD its
    latest version came from, as an items file's entries; that PRD's verified bases; on the
    company roadmap, the shared queue with the other PRDs' items, as it stands: a loop draft
    neither adds nor moves items, and its import carries them forward in their places; the
    items an approved version took off the plan, shipped or moved to the next PRD, whose
    plan_state carry_forward keeps: {key, title, state}, so the tables show them with their
    status and a draft that keeps their rows is not refused). A roadmap with no items (or
    no document) gives an empty plan: its loop draft still needs both tables, empty."""
    from oracle.roadmap import draft_items
    from oracle.roadmap.models import RoadmapItem

    doc = await db.get(Document, run.document_id) if run.document_id else None
    if doc is None:
        return [], [], [], []
    latest = await db.scalar(
        select(DocumentVersion)
        .where(
            DocumentVersion.document_id == doc.id,
            DocumentVersion.created_at <= run.created_at,
        )
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )
    source = (
        await db.get(DocumentVersion, latest.source_version_id)
        if latest is not None and latest.source_version_id
        else None
    )
    prd_id = source.document_id if source is not None else None
    version = await roadmap_company._items_version(db, doc.id, run.created_at)
    rows: list[RoadmapItem] = []
    kept: list[dict[str, Any]] = []
    if version is not None:
        replaced = await roadmap_company.replaced_prd_ids(db)
        for r in await db.scalars(
            select(RoadmapItem)
            .where(RoadmapItem.roadmap_version_id == version.id)
            .order_by(RoadmapItem.position)
        ):
            if r.prd_document_id in replaced:
                continue
            if r.plan_state is None:
                rows.append(r)
            else:
                kept.append({"key": r.item_key, "title": r.title, "state": r.plan_state})
    queued: list[dict[str, Any]] = []
    if doc.company_roadmap:
        # The other PRDs' items are in the tables as the queue has them.
        rows = [r for r in rows if r.prd_document_id == prd_id]
        queued = await roadmap_company.run_queue(db, prd_id, run.created_at)
    bases = [b.as_json() for b in await schedule.verified_bases(db, prd_id)]
    return draft_items.entries(rows), bases, queued, kept


async def _plan_table_problems(
    db: AsyncSession, run: Run, markdown: str, source_id: uuid.UUID | None
) -> list[ImportProblem]:
    """The draft's plan tables against the run's engineering dates (oracle.runs.plan_tables):
    the items file the roadmap_items segment wrote and the source PRD's verified bases;
    any other run's roadmap draft (the feedback loop): the roadmap's own items."""
    from oracle.runs import plan_tables

    if run.flow != "prd_to_roadmap":
        items, loop_bases, queued, kept = await _loop_plan_inputs(db, run)
        loop_plan = plan_tables.engineering_plan(items, loop_bases, others=queued, kept=kept)
        return plan_tables.check(
            markdown, loop_plan, await company_time.company_today(db), loop=True
        )
    text = None
    for seg in await db.scalars(
        select(RunSegment).where(RunSegment.run_id == run.id).order_by(RunSegment.seq)
    ):
        files = (seg.artifacts or {}).get("files") or {}
        text = files.get(plan_tables.ITEMS_FILE, text)
    # The checkpoint's check of the file (kept by oracle.runs.roadmap): never parsed again.
    items = (await items_check(db, run, text)).items if text else None
    source = await db.get(DocumentVersion, source_id) if source_id else None
    bases = await schedule.verified_bases(db, source.document_id if source else None)
    # one-roadmap-many-prds: the other PRDs' items on the company roadmap are in the tables
    # too, from the queue the run froze when its first prompt (roadmap_items) was built.
    frozen = await service._frozen_queue(db, run, source)
    others = roadmap_company.with_run_items(
        frozen["rows"], items, **{k: v for k, v in frozen.items() if k != "rows"}
    )
    plan = plan_tables.engineering_plan(items, [b.as_json() for b in bases], others=others)
    today = frozen["today"]
    day = date.fromisoformat(today) if today else await roadmap_company.run_day(db, run.created_at)
    return plan_tables.check(markdown, plan, day)


async def _draft_source(db: AsyncSession, run: Run) -> uuid.UUID | None:
    """The provenance of the draft a run imports: the run's source version
    (prd_to_roadmap), else the document's latest version's (the feedback loop keeps the
    PRD version a roadmap came from)."""
    source_id = service._source_id(run)
    if source_id is not None or not run.document_id:
        return source_id
    return await db.scalar(
        select(DocumentVersion.source_version_id)
        .where(DocumentVersion.document_id == run.document_id)
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )


async def _prd_links(db: AsyncSession, markdown: str, source: VersionSource) -> dict[str, Any]:
    """Which of the draft's links to its source document resolve to a section of the
    source version."""
    keys = set(
        await db.scalars(select(Section.section_key).where(Section.version_id == source.version_id))
    )
    resolved, unresolved = 0, []
    for link in roadmap.doc_links(markdown):
        if link["slug"] not in (source.slug, str(source.document_id)):
            continue
        if link["version"] == source.version and (
            link["section"] is None or link["section"] in keys
        ):
            resolved += 1
        else:
            unresolved.append(link["href"])
    return {"resolved": resolved, "unresolved": unresolved}


async def _work_problems(db: AsyncSession, run: Run, markdown: str) -> list[ImportProblem]:
    """A PRD draft's problems with the work its brief's answers made (an answer saying
    finding out is part of this work: a requirement cited to it, never a blocker)."""
    from oracle.intake import discovery, drafting

    intake_id = drafting._intake_id(run)
    pinned = (run.knobs or {}).get(drafting.ANSWER_IDS)
    if intake_id is None or not isinstance(pinned, list) or (run.knobs or {}).get("intake_gap_ids"):
        return []
    keep = set()
    for i in pinned:
        try:
            keep.add(uuid.UUID(str(i)))
        except ValueError:
            continue  # a malformed knob pins nothing
    return discovery.draft_problems(markdown, await discovery.run_work(db, intake_id, keep))


async def _import_draft(db: AsyncSession, run: Run, kind: str, markdown: str) -> dict[str, Any]:
    """Import the draft as the next version of the run's document (of ``kind``, with
    the run's provenance), in its own transaction."""
    tenant_id = current_tenant(db)
    name = flows.draft_file(kind)
    ref = str(run.document_id) if run.document_id else run.knobs.get("document_slug")
    if not ref:
        return {"error": "the run names no document"}
    user = await db.get(User, run.created_by) if run.created_by else None
    token = None if user or not run.created_by else await db.get(ApiToken, run.created_by)
    try:
        principal = _creator(tenant_id, user, token)
    except LookupError as exc:
        return {"error": exception_text(exc)}
    source_id = await _draft_source(db, run)
    knobs = run.knobs or {}
    template = (
        (knobs["template"], str(knobs["template_version"]))
        if knobs.get("template") and knobs.get("template_version")
        else None
    )
    if kind == "roadmap":
        # roadmap-plan-tables: a draft without the plan tables approving it applies to
        # Simple, or with other items or dates than the run's, goes back to the writer;
        # every roadmap draft, the feedback loop's too (the owner, Nov 4).
        problems = await _plan_table_problems(db, run, markdown, source_id)
        if problems:
            return rejection.refused(name, problems)
    if kind == "prd" and (problems := await _work_problems(db, run, markdown)):
        # Walk 2 problem 19: what the brief's answers made work is never a blocker.
        return rejection.refused(name, problems)
    if kind == "prd":
        # A question a person answered at a stop is decided: a draft that still lists it
        # under Decisions needed or Open questions goes back to the writer.
        problems = await stop_answers.open_problems(db, run, markdown)
        if problems:
            return rejection.refused(name, problems)
    async with tenant_session(tenant_id) as s:
        try:
            result = await docs_service.import_draft(
                s,
                ref,
                markdown,
                principal,
                kind=kind,
                theme=knobs.get("theme"),
                template=template,
                source_version_id=source_id,
                # An agent's draft never replaces approved text: it becomes a patch.
                cause="run_draft",
                origin="run",
                run_id=run.id,
                # A run's draft is kept: its unverified dates are marked and recorded.
                unverified_dates="mark",
                # The slug of a document the run was to create: never another document's
                # next version (checked under the document's row lock).
                run_creates=run.document_id is None,
            )
        except DraftError as exc:
            # The string stays (older readers); the run page, the Inbox and MCP read the
            # problems and their summary, and the problems are the findings when the draft
            # goes back to the writer (_send_back). All capped (rejection.refused).
            return rejection.refused(name, exc.problems)
        except (docs_service.NotFoundError, docs_service.ImportConflictError) as exc:
            return {"error": f"{name} was not imported: {exception_text(exc)}"}
        if not result.created and source_id and result.version.source is None:
            # The same draft was already imported (an agent pushed it) without its
            # provenance: record it now.
            row = await s.get(DocumentVersion, result.version.id)
            if row is not None and row.source_version_id is None:
                row.source_version_id = source_id
                await s.commit()
                # Without its date markers (the import checked its dates; none of the
                # markers is read here): never a wait for dates in the middle of a tick.
                result.version = await docs_service.read_version(s, row, require_dates=False)
        if run.flow == "feedback_loop" and any(knobs.get(k) for k in service.SENT_KNOBS):
            await _settle_sent_items(s, run, result.version.number, result.resolutions)
        if (run.knobs or {}).get("intake_id"):
            # C5: the intake's answers given while this draft was written become feedback.
            from oracle.intake import late_answers

            # Committed also when it raised nothing: it links the intake to its PRD, which
            # an answer given later needs to become feedback (#587 review).
            await late_answers.sync(s, run, result.version.document_id)
            await s.commit()
        document = await s.get(Document, result.version.document_id)
        out: dict[str, Any] = {
            "document_id": str(result.version.document_id),
            "slug": document.slug if document else None,
            "kind": document.kind if document else kind,
            "version": result.version.number,
            "created": result.created,
            "warnings": [w.code for w in result.version.warnings],
        }
        # #306: codes the draft uses without their names (and a roadmap's date words), in
        # the warning's plain words; a run sends such a draft back to the writer before a
        # person reviews it.
        sent_back = draft_checks.SENT_BACK
        code_names = [w.message for w in result.version.warnings if w.code in sent_back]
        if code_names:
            out["code_names"] = code_names
        source = result.version.source
        if source is not None:
            out["source"] = source.model_dump(mode="json")
            out["prd_links"] = await _prd_links(s, markdown, source)
    return out


async def _run_importer(
    db: AsyncSession, run: Run, name: str, files: dict[str, str]
) -> dict[str, Any]:
    """A lane's importer (oracle.runs.extensions) on the segment's files, as the run's
    creator."""
    tenant_id = current_tenant(db)
    user = await db.get(User, run.created_by) if run.created_by else None
    token = None if user or not run.created_by else await db.get(ApiToken, run.created_by)
    try:
        principal = _creator(tenant_id, user, token)
    except LookupError as exc:
        return {"error": exception_text(exc)}
    # The importer works in its own transactions (a spec's design check takes up to
    # DESIGN_CHECK_SECONDS): this session holds none open meanwhile.
    await db.commit()
    return await extensions.run_importer(name, db, run, files, principal)


async def _settle_sent_items(
    s: AsyncSession, run: Run, number: int, resolutions: list[Resolution]
) -> None:
    """D12: what a feedback loop started from Build next draft was sent, once its draft
    is version ``number``: the accepted section-text changes and the discussions' section
    changes are applied in it (as the built-in path's apply records them), and the items
    staged for the agents that the draft's resolutions answer leave Staged. Their status
    is the import's: an agent never closes a whole-draft item itself, so a person confirms
    it in the version's review.
    ``resolutions`` are the import's own parse of the draft: it is not parsed again."""
    knobs = run.knobs or {}
    answered = {str(r.feedback_id) for r in resolutions}
    sent = [uuid.UUID(str(i)) for i in knobs.get("feedback_ids") or [] if str(i) in answered]
    items = list(
        await s.scalars(
            select(FeedbackItem).where(
                FeedbackItem.id.in_(sent), FeedbackItem.document_id == run.document_id
            )
        )
    )
    for item in items:
        item.staged_for_agents_at = item.staged_for_agents_by = None
    ids = [uuid.UUID(str(i)) for i in knobs.get("suggestion_ids") or []]
    rows = list(
        await s.scalars(
            select(LlmSuggestion).where(
                LlmSuggestion.id.in_(ids),
                LlmSuggestion.document_id == run.document_id,
                LlmSuggestion.status == "accepted",
                LlmSuggestion.applied_in_version.is_(None),
            )
        )
    )
    for row in rows:
        row.status = "applied"
        row.applied_in_version = number
    changes = await _apply_section_changes(s, run, number)
    if rows or items or changes:
        await s.commit()


async def _apply_section_changes(s: AsyncSession, run: Run, number: int) -> int:
    """G4: the section changes staged from discussions that the run was sent are applied
    in its draft, version ``number``, and their discussion changes done, as Oracle's own
    apply (``next_draft.apply``) records them. A run that writes no draft (failed,
    cancelled) never gets here: its rows stay staged for the next draft."""
    from oracle.discussions.models import DiscussionChange
    from oracle.staging.models import NextDraftChange

    ids = [uuid.UUID(str(i)) for i in (run.knobs or {}).get("next_draft_change_ids") or []]
    if not ids:
        return 0
    rows = list(
        await s.scalars(
            select(NextDraftChange).where(
                NextDraftChange.id.in_(ids),
                NextDraftChange.document_id == run.document_id,
                NextDraftChange.status == "staged",
            )
        )
    )
    for r in rows:
        r.status = "applied"
        r.applied_in_version = number
        change = (
            await s.get(DiscussionChange, r.discussion_change_id)
            if r.discussion_change_id
            else None
        )
        if change is not None and change.status == "staged":
            change.status = "done"
            change.decision_note = f"Applied in draft {number}"
    return len(rows)


async def _import_baseline(db: AsyncSession, run: Run, text: str) -> dict[str, Any]:
    """Merge baseline.yaml through the baseline's YAML import, in its own transaction:
    the run's agent writes, as the run's creator; locked items get proposals."""
    tenant_id = current_tenant(db)
    user = await db.get(User, run.created_by) if run.created_by else None
    token = None if user or not run.created_by else await db.get(ApiToken, run.created_by)
    try:
        principal = _creator(tenant_id, user, token)
    except LookupError as exc:
        return {"error": exception_text(exc)}
    async with tenant_session(tenant_id) as s:
        # H11: how far Oracle may go with the baseline, read now (a change applies to the
        # next merge). Below Act every write is a proposal; at Observe nothing is merged.
        level = await autonomy.level(s, "baseline")
        if level == "observe":
            return {"skipped": True, "autonomy": _baseline_autonomy(level)}
        try:
            result = await yaml_io.import_yaml(
                s,
                principal,
                text,
                run_id=run.id,
                origin="agent",
                reason="The run's Ground Truth file (baseline.yaml)",
                proposals_only=level != "act",
            )
        except yaml_io.YamlInvalid as exc:
            problems = "; ".join(
                f"[{p.code}] {p.message}" + (f" ({p.where})" if p.where else "")
                for p in exc.problems
            )
            return {"error": f"baseline.yaml was rejected: {problems}"}
        await s.commit()
    out = result.model_dump(mode="json")
    if level != "act":
        out["autonomy"] = _baseline_autonomy(level)
    return out


def _baseline_autonomy(level: str) -> dict[str, str]:
    """What the run page says when the baseline's level changed the merge (H11)."""
    if level == "observe":
        note = "Ground Truth merge skipped: Oracle is set to observe the Ground Truth"
    else:
        note = (
            f"Ground Truth changes became proposals: Oracle is set to {level} for the Ground Truth"
        )
    return {"level": level, "note": note}


def _current_attempt(art: dict[str, Any], segment: RunSegment) -> dict[str, Any]:
    """The segment's current attempt: the latest on its workflow. A found earlier
    submission (a search, a cancel's lookup) is listed by its number and may sit after
    it; the last listed is taken only when none is on the segment's workflow."""
    ours = [a for a in art["attempts"] if a.get("workflow_id") == segment.swarm_workflow_id]
    if ours:
        return ours[-1]
    return art["attempts"][-1] if art["attempts"] else {}


async def _relocked(
    db: AsyncSession, run: Run, segment: RunSegment, attempt: int, *, gate: bool
) -> list[RunSegment] | None:
    """After :func:`_advance` committed mid-way (an import runs in its own transaction):
    take the run's row lock again (the review gate first, with ``gate``) and read the
    run and its segments afresh into the same objects. None when the run is no longer
    running (cancelled, by its owner or a disable of its creator, failed, paused) or the
    segment is no longer this attempt, succeeded and being advanced: nothing more is
    written for it, nothing opened or submitted."""
    if gate:
        from oracle.review import publish

        await publish.gate_lock(db, shared=True)
    fresh, segments = await service._locked(db, run.id)
    now = next((s for s in segments if s.id == segment.id), None)
    if fresh is None or fresh.status != "running" or now is None or now.status != "succeeded":
        return None
    last = _current_attempt(_art(now), now)
    if last.get("attempt", 1) != attempt or not last.get("advanced"):
        return None
    return segments


async def _advance(
    db: AsyncSession,
    run: Run,
    segment: RunSegment,
    segments: list[RunSegment],
    wait: dict[str, Any] | None = None,
    *,
    gate: bool = False,
) -> bool:
    """After a segment succeeded: import its draft, then open or skip its checkpoint
    (and queue the next segment for :func:`submit_queued`: :func:`_submit`).

    An import commits first (it runs in its own transaction), which releases the run's
    row lock and, with ``gate`` (the caller held the review gate), the gate: both are
    taken again and the run re-read before anything more is written (:func:`_relocked`).

    ``wait``: the step of the live workflow that waits for this checkpoint's decision
    (adapter v2); the Inbox decision is posted to it.

    Returns False when this attempt of the segment was already advanced. One that was
    interrupted after its first commit (an import raised) is marked ``opening`` and is
    advanced again by the next tick (:func:`_resume_advance`): the imports are
    idempotent, and the checkpoint opens then (its wait kept in ``opening_wait``).
    It also returns False when the run or the segment changed during an import.
    """
    flow, knobs = _flow(run), _knobs(run)
    sdef = flow.segment(segment.name)
    art = _art(segment)
    attempt = _current_attempt(art, segment)
    if attempt.get("advanced") is True:
        return False
    # Set to True in the transaction that opens (or skips) the checkpoint.
    attempt["advanced"] = "opening"
    if wait is not None:
        # W5: the token is held from before the import's commit until the checkpoint
        # that stands for this wait is added (cleared in the same transaction).
        _set_knob(
            run,
            "opening_wait",
            {
                "workflow_id": wait.get("workflow_id"),
                "step_id": wait.get("step_id"),
                "kind": sdef.checkpoint_for(await service._target_kind(db, run)),
                "seq": segment.seq,
                "wait": wait,
            },
        )
    number = attempt.get("attempt", 1)
    imported: dict[str, Any] | None = None
    baseline_import: dict[str, Any] | None = None
    if sdef.imports_baseline:
        text = art["files"].get("baseline.yaml")
        if text is None:
            baseline_import = {"error": "the segment left no Ground Truth file (baseline.yaml)"}
        else:
            # Committed first: the import runs in its own transaction.
            _set_art(segment, art)
            await db.commit()
            baseline_import = await service._import_baseline(db, run, text)
            # The commit released the run's row lock: take it again, read the run again.
            fresh = await _relocked(db, run, segment, number, gate=gate)
            if fresh is None:
                return False
            segments = fresh
        art["baseline_import"] = baseline_import
    items_check: dict[str, Any] | None = None
    if ITEMS_FILE in sdef.outputs:
        try:
            # In a savepoint: a database error while checking rolls back the check's own
            # reads only, and the tick's transaction (the segment, the run's row lock)
            # stays usable.
            async with db.begin_nested():
                items_check = await service._check_items(
                    db, run, art["files"].get(ITEMS_FILE), segment, number
                )
        except safe_yaml.ParseBusy:
            raise  # no worker for it: this tick gives up, the next retries
        except Exception as exc:  # noqa: BLE001 - a bad file fails the check, never the tick
            log.exception("checking %s of run %s failed", ITEMS_FILE, run.id)
            items_check = reasons.summarize(
                {
                    "items": 0,
                    "by_horizon": {},
                    "problems": [
                        {
                            "code": "unreadable_yaml",
                            "message": f"{ITEMS_FILE} could not be checked ({type(exc).__name__})",
                        }
                    ],
                },
                [],
                None,
            )
        art["items_check"] = items_check
    draft_error: str | None = None
    if flow.stores_draft_items:
        from oracle.roadmap import draft_items

        try:
            # In a savepoint, as the check: a failed store fails the run, never the tick.
            async with db.begin_nested():
                stored, draft_error = await draft_items.store(
                    db, run, art["files"].get(ITEMS_FILE), items_check or {}
                )
        except safe_yaml.ParseBusy:
            raise  # no worker for it: this tick gives up, the next retries
        except Exception as exc:  # noqa: BLE001
            log.exception("storing the draft items of run %s failed", run.id)
            draft_error = f"the roadmap items could not be stored ({type(exc).__name__})"
        art["draft_items"] = {"error": draft_error} if draft_error else {"stored": stored}
    fs_check: dict[str, Any] | None = None
    scope_id: uuid.UUID | None = None
    if feature_set.FILE in sdef.outputs:
        try:
            # In a savepoint, as the items check: a database error rolls back the check's
            # own reads and writes only.
            async with db.begin_nested():
                fs_check, scope_id = await _check_feature_set(
                    db, run, segment, number, art["files"].get(feature_set.FILE)
                )
        except Exception as exc:  # noqa: BLE001 - a bad file fails the check, never the tick
            log.exception("checking %s of run %s failed", feature_set.FILE, run.id)
            failed = feature_set.FeatureSetCheck()
            failed.add(
                "unreadable_yaml",
                f"{feature_set.FILE} could not be checked ({type(exc).__name__})",
            )
            fs_check = failed.as_json()
        art["feature_set_check"] = fs_check
    order_check: dict[str, Any] | None = None
    snapshot_id: uuid.UUID | None = None
    if run_order.FILE in sdef.outputs:
        try:
            # In a savepoint, as the items check: a database error rolls back the check's
            # own reads and writes only.
            async with db.begin_nested():
                order_check, snapshot_id = await _check_priority_order(
                    db, run, segment, number, art["files"].get(run_order.FILE)
                )
        except safe_yaml.ParseBusy:
            raise  # no worker for it: this tick gives up, the next retries
        except Exception as exc:  # noqa: BLE001 - a bad file fails the check, never the tick
            log.exception("checking %s of run %s failed", run_order.FILE, run.id)
            failed = run_order.OrderCheck()
            failed.add(
                "unreadable_yaml", f"{run_order.FILE} could not be checked ({type(exc).__name__})"
            )
            order_check = failed.as_json()
        art["priority_check"] = order_check
    launch_import: dict[str, Any] | None = None
    if flows.LAUNCH_FILE in sdef.outputs:
        from oracle.launches import service as launches_service

        try:
            # In a savepoint, as the items check: a bad file never fails the tick.
            async with db.begin_nested():
                launch_import = await launches_service.import_kit_run(
                    db, run, art["files"].get(flows.LAUNCH_FILE)
                )
        except Exception as exc:  # noqa: BLE001
            log.exception("importing %s of run %s failed", flows.LAUNCH_FILE, run.id)
            launch_import = {"error": f"{flows.LAUNCH_FILE} could not be imported "
                             f"({type(exc).__name__})"}  # fmt: skip
        art["launch_import"] = launch_import
    triage_import: dict[str, Any] | None = None
    if flows.TRIAGE_FILE in sdef.outputs:
        from oracle.requests import triage

        try:
            # In a savepoint, as the items check: a bad file never fails the tick.
            async with db.begin_nested():
                triage_import = await triage.apply(db, run, art["files"].get(flows.TRIAGE_FILE))
        except safe_yaml.ParseBusy:
            raise  # no worker for it: this tick gives up, the next retries
        except Exception as exc:  # noqa: BLE001
            log.exception("applying %s of run %s failed", flows.TRIAGE_FILE, run.id)
            triage_import = {"error": f"{flows.TRIAGE_FILE} could not be applied "
                             f"({type(exc).__name__})"}  # fmt: skip
        for note in triage_import.get("notes") or []:
            service._note_art(art, note)
        art["triage_import"] = triage_import
    if sdef.imports_draft:
        kind = await service._target_kind(db, run)
        name = flows.draft_file(kind)
        markdown = art["files"].get(name)
        if markdown is None:
            # The same shape as a refusal (_import_draft): the run page, the Inbox, MCP
            # and the send-back findings read it alike.
            missing = [
                ImportProblem(code=rejection.MISSING_DRAFT, message=f"the segment left no {name}")
            ]
            imported = {
                "error": missing[0].message,
                "problems": [p.model_dump(mode="json") for p in missing],
                "summary": rejection.summary(name, missing),
            }
        else:
            # Committed first: the import runs in its own transaction.
            _set_art(segment, art)
            await db.commit()
            imported = await _import_draft(db, run, kind, markdown)
            # The commit released the run's row lock: take it again, read the run again.
            fresh = await _relocked(db, run, segment, number, gate=gate)
            if fresh is None:
                return False
            segments = fresh
            if imported.get("document_id"):
                run.document_id = uuid.UUID(imported["document_id"])
                _set_knob(run, "document_slug", None)
                # Rule 6 (C6, C8): the run's PRD scope and priority order name the
                # document from now on.
                await feature_set.fill_document(db, run.id, run.document_id)
                await run_order.fill_document(db, run.id, run.document_id)
                await _link_requests(db, run)
                _check_goal_trace(run, art, imported, markdown)
        art["import"] = imported
    if sdef.importer:
        # Committed first: the importer runs in its own transaction.
        _set_art(segment, art)
        await db.commit()
        try:
            imported = await _run_importer(db, run, sdef.importer, art["files"])
        except safe_yaml.ParseBusy:
            raise  # no worker for it: this tick gives up, the next retries
        except Exception as exc:  # the checkpoint must open whatever the importer does
            log.exception("run %s: importer %s failed", run.id, sdef.importer)
            imported = {"error": f"the {sdef.importer} import failed ({type(exc).__name__})"}
        # The commit released the run's row lock: take it again.
        await db.execute(select(Run.id).where(Run.id == run.id).with_for_update())
        if imported.get("document_id"):
            run.document_id = uuid.UUID(imported["document_id"])
            _set_knob(run, "document_slug", None)
            await _link_requests(db, run)
        art["import"] = imported
    attempt["advanced"] = True
    _set_art(segment, art)

    payload = {
        "segment_seq": segment.seq,
        "segment": segment.name,
        "attempt": attempt.get("attempt", 1),
        "artifacts": sorted(art["files"].keys()),
    }
    if sdef.checkpoint == eng_check.KIND and flows.BRIEFS_FILE in sdef.outputs:
        # F4: what the Engineering check's screen and its gate read.
        payload[eng_check.PAYLOAD_KEY] = await eng_check.check_segment(
            db, run, art["files"].get(flows.BRIEFS_FILE)
        )
    if sdef.checkpoint == eng_dates.KIND:
        # F4 lane B: what the Engineering dates' screen and its gate read.
        payload[eng_dates.PAYLOAD_KEY] = await eng_dates.summarize(
            db, run, art["files"].get(eng_dates.FILE)
        )
    if imported is not None:
        payload["import"] = imported
    if baseline_import is not None:
        payload["baseline_import"] = baseline_import
    if items_check is not None:
        payload["items_check"] = items_check
    if fs_check is not None:
        payload["feature_set_check"] = fs_check
        if scope_id is not None:
            payload["scope_id"] = str(scope_id)
    if order_check is not None:
        payload["priority_check"] = order_check
        if snapshot_id is not None:
            payload["priority_snapshot_id"] = str(snapshot_id)
    if launch_import is not None:
        payload["launch_import"] = launch_import
    if triage_import is not None:
        payload["triage_import"] = triage_import
    if wait is not None:
        payload["wait"] = wait
        _set_knob(run, "opening_wait", None)
    if sdef.checkpoint is None:
        # No stop (F5-2's code_map index): a failed import fails the run, else it goes on.
        for result in (baseline_import, imported, launch_import):
            if result is not None and result.get("error"):
                await service._finish(db, run, "failed", result["error"])
                return True
        await service._next(db, run, segment, segments)
        return True
    checkpoint_kind = sdef.checkpoint_for(await service._target_kind(db, run))
    if (
        wait is not None
        and imported is not None
        and (imported.get("problems") or imported.get("code_names"))
        and knobs.checkpoints.get(sdef.checkpoint, True)
        and await service._send_back(
            db,
            run,
            segment,
            segments,
            wait,
            imported,
            await service._target_kind(db, run),
            checkpoint_kind,
        )
    ):
        return True
    checkpoint_id = uuid.uuid4()
    # H11 ``priorities`` at Act: Oracle saves an order inside the limits itself.
    oracle_orders = (
        order_check is not None
        and snapshot_id is not None
        and knobs.checkpoints.get(sdef.checkpoint, True)
        and await _oracle_saves_order(db, order_check, snapshot_id)
    )
    if knobs.checkpoints.get(sdef.checkpoint, True) and not oracle_orders:
        db.add(
            Checkpoint(
                id=checkpoint_id,
                run_id=run.id,
                kind=checkpoint_kind,
                status="pending",
                approver_role=sdef.approver_role,
                payload=payload,
            )
        )
        await _link_scope(db, scope_id, checkpoint_id)
        await _link_order(db, snapshot_id, checkpoint_id)
        run.status = "awaiting_checkpoint"
        await webhooks.capture(
            db, "run.checkpoint_waiting", audit.ORACLE, run_id=run.id, checkpoint_id=checkpoint_id
        )
        return True
    db.add(
        Checkpoint(
            id=checkpoint_id,
            run_id=run.id,
            kind=checkpoint_kind,
            status="skipped",
            approver_role=sdef.approver_role,
            note=ORDER_SAVED_BY_ORACLE if oracle_orders else "Turned off when the run started.",
            payload=payload,
            decided_at=service._now(),
        )
    )
    await _link_scope(db, scope_id, checkpoint_id)
    await _link_order(db, snapshot_id, checkpoint_id)
    for result in (baseline_import, imported, launch_import, triage_import):
        if result is not None and result.get("error"):
            await service._finish(db, run, "failed", result["error"])
            return True
    if flow.stores_draft_items:
        # E1: the items are stored with their problems; the review is on the Roadmap
        # tab. The run fails only when nothing could be stored.
        if draft_error:
            await service._finish(db, run, "failed", draft_error)
            return True
    elif items_check is not None and items_check["problems"]:
        problems = "; ".join(f"[{p['code']}] {p['message']}" for p in items_check["problems"][:5])
        await service._finish(db, run, "failed", f"{ITEMS_FILE} was rejected: {problems}")
        return True
    if fs_check is not None:
        blocking = [p for p in fs_check["problems"] if p.get("blocking", True)]
        if blocking or scope_id is None:
            problems = "; ".join(f"[{p['code']}] {p['message']}" for p in blocking[:5])
            await service._finish(db, run, "failed", f"{feature_set.FILE} was rejected: {problems}")
            return True
        # Rule 5 (C6): the stop is off and nothing blocks, so Oracle approves the scope.
        scope = await db.get(PrdScope, scope_id)
        if scope is not None:
            await feature_set.approve(db, scope, None, run.document_id)
            await audit.record(
                db,
                audit.ORACLE,
                "prd_scope.approved",
                "prd_scope",
                scope.id,
                {"by": "oracle", "reason": "stop off", "run_id": str(run.id)},
            )
    if order_check is not None:
        blocking = [p for p in order_check["problems"] if p.get("blocking", True)]
        if blocking or snapshot_id is None:
            problems = "; ".join(f"[{p['code']}] {p['message']}" for p in blocking[:5])
            await service._finish(db, run, "failed", f"{run_order.FILE} was rejected: {problems}")
            return True
        # Rule 5 (C8): the stop is off and nothing blocks, so Oracle saves the order.
        snapshot = await db.get(PrioritySnapshot, snapshot_id)
        if snapshot is not None:
            run_order.approve(snapshot, None, run.document_id)
            await service._accept_new(db, run, snapshot, None)
            await audit.record(
                db,
                audit.ORACLE,
                "priority_snapshot.approved",
                "priority_snapshot",
                snapshot.id,
                {
                    "by": "oracle",
                    "reason": "autonomy" if oracle_orders else "stop off",
                    "run_id": str(run.id),
                },
            )
            if oracle_orders:
                await _tell_order_saved(db, run)
    await service._next(db, run, segment, segments)
    return True


async def _link_requests(db: AsyncSession, run: Run) -> None:
    """C1: the PRD a brief's run makes links the requests behind the brief."""
    # Here, not at the top: oracle.requests reads this module.
    from oracle.requests import service as requests_service

    await requests_service.link_run_document(db, run)


def _check_goal_trace(
    run: Run, art: dict[str, Any], imported: dict[str, Any], markdown: str
) -> None:
    """#260: the imported PRD's Goal trace covers every target goal of the run; one it
    leaves out is a warning on the import and a note on the run."""
    targets = {g["key"]: g["title"] for g in (run.knobs or {}).get("target_goals") or []}
    missing = flows.goal_trace_missing(markdown, list(targets.items()))
    if not missing:
        return
    imported["warnings"] = [*imported.get("warnings", []), "goal_trace_incomplete"]
    named = ", ".join(wording.named(targets[k], k) for k in missing)
    service._note_art(
        art, f"The PRD's Goal trace leaves out target goal{'s' * (len(missing) > 1)}: {named}"
    )


async def _check_feature_set(
    db: AsyncSession, run: Run, segment: RunSegment, attempt: int, text: str | None
) -> tuple[dict[str, Any], uuid.UUID]:
    """C6: feature_set.yaml checked against the run's PRD slug and the baseline, and the
    proposed scope written from it (even with blocking problems, so they can be fixed)."""
    known = await feature_set.known_for_run(db, run.id)
    if text is None:
        check = feature_set.FeatureSetCheck()
        check.add("missing_file", f"the segment left no {feature_set.FILE}")
    else:
        doc = await db.get(Document, run.document_id) if run.document_id else None
        slug = doc.slug if doc is not None else (run.knobs or {}).get("document_slug")
        # In a worker thread with a time cap: agent output never holds the event loop.
        check = await feature_set.check_feature_set_async(text, document=slug, known=known)
    scope = await feature_set.write_scope(
        db, run, segment_seq=segment.seq, attempt=attempt, check=check, known=known
    )
    return check.as_json(), scope.id


# The priority stop's note when Oracle saved the order itself (H11 ``priorities`` at Act).
ORDER_SAVED_BY_ORACLE = "Oracle saved this order: Order priorities is set to Act within limits."


async def _oracle_saves_order(
    db: AsyncSession, check: dict[str, Any], snapshot_id: uuid.UUID
) -> bool:
    """Whether Oracle saves the run's order with no stop: ``priorities`` at Act, nothing
    blocking, and every move within one goal and the most places an owner allows."""
    if not await autonomy.allows(db, "priorities", "act"):
        return False
    if any(p.get("blocking", True) for p in check.get("problems") or []):
        return False
    snapshot = await db.get(PrioritySnapshot, snapshot_id)
    limits = await autonomy.limits(db, "priorities")
    if snapshot is None or limits is None:
        return False
    most = int(getattr(limits, "max_rank_move", 0))
    return run_order.outside_limits(list(snapshot.ranking or []), max_rank_move=most) is None


async def _tell_order_saved(db: AsyncSession, run: Run) -> None:
    """The run's starter hears that Oracle saved the order (an "Oracle did" row)."""
    document = await db.get(Document, run.document_id) if run.document_id else None
    name = document.title if document else (run.knobs or {}).get("document_slug") or "this run"
    await autonomy.acted(
        db,
        "priorities",
        summary=f"Saved the priority order of {name}, within one goal and your limit",
        subject={"kind": "run", "key": str(run.id), "href": f"/runs/{run.id}"},
        undo=None,
        notify=[run.created_by] if run.created_by else [],
    )


async def _check_priority_order(
    db: AsyncSession, run: Run, segment: RunSegment, attempt: int, text: str | None
) -> tuple[dict[str, Any], uuid.UUID]:
    """C8: priority.yaml checked against the baseline, the run's approved PRD scope and the
    live ranking, and stored as the run's proposed snapshot (even with blocking problems,
    so they can be seen and sent back)."""
    known, scope_id = await run_order.known_for_run(db, run)
    if text is None:
        check = run_order.OrderCheck()
        check.add("unreadable_yaml", f"the segment left no {run_order.FILE}")
    else:
        # In a worker thread with a time cap: agent output never holds the event loop.
        check = await run_order.check_order_async(text, known=known)
    snapshot = await run_order.propose(
        db, run, segment_seq=segment.seq, attempt=attempt, check=check, known=known,
        scope_id=scope_id,
    )  # fmt: skip
    return check.as_json(), snapshot.id


async def _link_order(
    db: AsyncSession, snapshot_id: uuid.UUID | None, checkpoint_id: uuid.UUID
) -> None:
    """The proposed order names the checkpoint that decides it (added in the same flush)."""
    if snapshot_id is None:
        return
    await db.flush()
    snapshot = await db.get(PrioritySnapshot, snapshot_id)
    if snapshot is not None:
        snapshot.checkpoint_id = checkpoint_id


async def _link_scope(
    db: AsyncSession, scope_id: uuid.UUID | None, checkpoint_id: uuid.UUID
) -> None:
    """The proposed scope names the checkpoint that decides it (added in the same flush)."""
    if scope_id is None:
        return
    await db.flush()
    scope = await db.get(PrdScope, scope_id)
    if scope is not None:
        scope.checkpoint_id = checkpoint_id


# Who Oracle's own answer is from, on the revision's attempt.
SENT_BACK_BY = "Oracle"


def _send_back_entry(
    run: Run, segment: RunSegment, wait: dict[str, Any]
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    """The live workflow and the segment's plan entry when Oracle answers this wait itself
    (:func:`_send_back`): a review of the workflow's last segment, open (not answered or
    ended), followed by a revise step and by a later review for the person."""
    wf = service._drivable(run)
    if wf is None or wf.get("id") != wait.get("workflow_id"):
        return None
    if not wait.get("task_id") or wait.get("console") or wait.get("ended"):
        return None
    planned = wf.get("segments") or []
    entry = service._plan_entry(wf, segment.seq)
    if entry is None or planned[-1].get("seq") != segment.seq:
        return None
    round_ = int(wait.get("round") or 1)
    reviews, revises = entry.get("reviews") or [], entry.get("revises") or []
    if round_ > len(revises) or round_ >= len(reviews) or reviews[round_ - 1] != wait["step_id"]:
        return None
    return wf, entry


async def _send_back(
    db: AsyncSession,
    run: Run,
    segment: RunSegment,
    segments: list[RunSegment],
    wait: dict[str, Any],
    imported: dict[str, Any],
    kind: str,
    checkpoint: str,
) -> bool:
    """A refused draft goes back to the writer before a person is asked (owner,
    2026-10-20). When the segment-end import refused the draft and the wait is a review
    of the workflow's last segment that a revise step and a later review follow, Oracle
    answers it itself: NOT_YET, with the import's problems grouped in plain words as
    findings (:func:`workflow.import_findings`). The revision runs in the same workflow
    and its draft is imported when the next review opens; only one still refused there
    reaches the Inbox (a person decides that review).

    The answer is Oracle's, never a person's: no checkpoint stands for the wait, nothing
    is decided or approved, it is noted on the segment and audited with actor ``oracle``,
    and the run's token stays read-only (W5) until the next round's checkpoint stands
    (:func:`_hold_plan`). Returns False, leaving the review to the person, when the wait
    does not qualify (an earlier segment's checkpoint has one round and no revise step),
    too little of the credential is left for the revision (the tail rule), or SwarmCloud
    did not take the answer.

    A draft imported with codes it does not name (#306, ``code_names``) goes back the same
    way, with those codes as findings (:func:`workflow.code_name_findings`)."""
    found = _send_back_entry(run, segment, wait)
    if found is None:
        return False
    wf, entry = found
    round_ = int(wait.get("round") or 1)
    step = wait["step_id"]
    name = flows.draft_file(kind)
    refused = bool(imported.get("problems"))
    trouble = workflow.code_name_trouble(list(imported.get("warnings") or []))
    why = "was refused at import" if refused else trouble
    left = service._left(wf)
    steps = workflow.agent_steps_after(wf.get("segments") or [], segment.seq, False, round_)
    tail = workflow.tail_seconds(steps, get_runtime_settings())
    if left < tail:
        service._note(
            segment,
            f"{name} {why}. With {service._duration(left)} of the run's credential "
            f"left, under the {service._duration(tail)} the revision needs, Oracle did not send it "
            f"back to the writer: {checkpoint} waits for a person.",
        )
        return False
    findings = (
        workflow.import_findings(
            name, imported.get("problems") or [], imported.get("problems_total")
        )
        if refused
        else workflow.code_name_findings(
            name, list(imported.get("code_names") or []), list(imported.get("warnings") or [])
        )
    )
    payload = {"verdict": NOT_YET, "findings": findings}
    # The same id for the same wait: a post repeated after a lost response is a replay.
    answer_id = str(uuid.uuid5(run.id, f"send-back/{wf['id']}/{step}"))
    runtime = service.get_runtime()
    for tries in (1, 2):
        try:
            await runtime.answer(wf["id"], step, answer_id=answer_id, payload=payload)
            break
        except RuntimeUnavailable as exc:
            if exc.retryable and tries == 1:
                continue
            log.warning("run %s: refused draft not sent back on %s: %s", run.id, step, exc)
            service._note(
                segment,
                f"{name} {why}, and Oracle could not send it back to the "
                f"writer (SwarmCloud: {service._shown(exc)}): {checkpoint} waits for a person.",
            )
            return False
    subject = workflow.warning_subject(list(imported.get("warnings") or []))
    still = (
        "is still refused," if refused else f"still {trouble}, the import says which {subject} and"
    )
    problems = "import's problems" if refused else f"import's warnings on its {subject}"
    service._note(
        segment,
        f"{name} {why}, so Oracle sent the draft back to the writer before "
        f"asking a person: it answered {step} (round {round_}) with NOT_YET and the "
        f"{problems} as findings. This is "
        "Oracle's answer, not a person's decision: nothing is "
        "approved, and the run's agents may not write to Oracle until a person's answer "
        f"counts. The revision is imported when the next review opens; if it {still} "
        f"{checkpoint} waits in the Inbox.",
    )
    await audit.record(
        db,
        audit.ORACLE,
        "run.draft_sent_back",
        "run",
        run.id,
        {
            "segment": segment.name,
            "seq": segment.seq,
            "kind": checkpoint,
            "workflow_id": wf["id"],
            "step_id": step,
            "round": round_,
            "verdict": NOT_YET,
            "findings": findings,
            "error": imported.get("error"),
        },
    )
    entry["oracle_answered"] = [*(entry.get("oracle_answered") or []), step]
    await service._follow(
        db,
        run,
        None,
        segment,
        segments,
        wf,
        entry,
        round_,
        False,
        note="\n".join(findings),
        note_by=SENT_BACK_BY,
    )
    # The revision's attempt is Oracle's send-back: the run reads "Revising: sent back by
    # Oracle" until it is imported (_sent_back).
    art = _art(segment)
    art["attempts"][-1]["sent_back"] = True
    _set_art(segment, art)
    return True


# A resumed advance that raises this many times stops: its step fails, and an owner
# retries it from the Inbox (:func:`retry_import`).
RESUME_TRIES = 5


def _resuming(run: Run, segments: list[RunSegment]) -> RunSegment | None:
    """The segment whose advance was interrupted after its first commit (:func:`_advance`
    raised in an import), to advance again: none once its step failed
    (:data:`RESUME_TRIES`)."""
    if run.status != "running":
        return None
    return next(
        (
            s
            for s in segments
            if s.status == "succeeded" and _current_attempt(_art(s), s).get("advanced") == "opening"
        ),
        None,
    )


async def _resume_advance(
    db: AsyncSession,
    run: Run,
    segment: RunSegment,
    segments: list[RunSegment],
    stats: "_TickStats",
) -> None:
    """An advance interrupted after its first commit: advanced again now, with the wait
    it was opening a checkpoint on (the imports are idempotent: a locked item's proposal
    is the open one already there)."""
    opening = (run.knobs or {}).get("opening_wait")
    wait = None
    if isinstance(opening, dict) and opening.get("seq") == segment.seq:
        wait = opening.get("wait")
    log.warning("run %s: advancing %s again (interrupted)", run.id, segment.name)
    if await _advance(db, run, segment, segments, wait=wait):
        stats.advanced += 1


async def _resume_failed(
    db: AsyncSession, run_id: uuid.UUID, seq: int, exc: Exception, stats: "_TickStats"
) -> tuple[Run, list[RunSegment]]:
    """A resumed advance raised: what it did is rolled back, and the failure is counted
    on the segment's attempt (the error's class and when; never its message, which may
    carry what the agents wrote). At :data:`RESUME_TRIES` it is tried no more: the step
    fails, and owners see "Couldn't import" in the Inbox with Retry
    (:func:`retry_import`). Returns the run and its segments as they are now, locked, for
    the rest of the tick (the workflow is still read: its status, cost and the ceiling)."""
    error = type(exc).__name__
    log.warning("run %s: advancing segment %s again failed (%s)", run_id, seq, error, exc_info=exc)
    await db.rollback()
    run = await service._get_run(db, run_id, lock=True)
    segments = await service._segments(db, run_id, fresh=True)
    segment = next((s for s in segments if s.seq == seq), None)
    if segment is None or _resuming(run, segments) is not segment:
        return run, segments
    art = _art(segment)
    attempt = _current_attempt(art, segment)
    count = int((attempt.get("resume_failures") or {}).get("count") or 0) + 1
    now = service._now().isoformat()
    # ``pass``: this tick's pass over the run, so that the pass run again after a runtime
    # call (_replay) neither tries the advance again nor counts it twice (_tick_run).
    failed = {"count": count, "error": error, "at": now, "pass": stats.pass_id}
    attempt["resume_failures"] = failed
    stats.errors.append(_resume_error(run_id, segment, failed))
    if count >= RESUME_TRIES:
        segment.status = "failed"
        segment.error = (
            f"Couldn't import its output: {error} on {count} tries in a row. Oracle stopped "
            "trying; an owner can retry it from the Inbox."
        )
        _set_knob(run, "import_failed", {"seq": seq, "error": error, "count": count, "at": now})
        await audit.record(
            db,
            None,
            "run.import_failed",
            "run",
            run.id,
            {"segment": segment.name, "error": error, "tries": count},
        )
    _set_art(segment, art)
    await db.commit()
    # The commit released the run's row lock: taken again, read as they are now.
    run = await service._get_run(db, run_id, lock=True)
    return run, await service._segments(db, run_id, fresh=True)


def _resume_error(run_id: uuid.UUID, segment: RunSegment, failed: dict[str, Any]) -> str:
    return (
        f"run {run_id}: importing {segment.name}'s output failed ({failed.get('error')}), "
        f"try {failed.get('count')} of {RESUME_TRIES}"
    )


async def _check_items(
    db: AsyncSession,
    run: Run,
    text: str | None,
    segment: RunSegment | None = None,
    attempt: int | None = None,
) -> dict[str, Any]:
    """roadmap_items.yaml checked against the run's PRD version (oracle.runs.roadmap),
    with every item's reasons (oracle.runs.reasons); after a send-back with a review (D6),
    how this attempt answered it (``resolution``) and its diff (``diff``)."""
    if text is None:
        missing = {
            "items": 0,
            "by_horizon": {},
            "problems": [{"code": "missing_file", "message": f"the segment left no {ITEMS_FILE}"}],
        }
        return reasons.summarize(missing, [], None)
    prior = await prior_review(db, run, segment, attempt) if segment is not None else None
    checked = await checked_items(db, run, text, prior)
    return reasons.summarize(
        checked.check.as_json(),
        checked.reasons,
        checked.base,
        checked.partial,
        checked.resolution,
        checked.diff,
    )


@dataclass(frozen=True)
class PriorReview:
    """D6: the review a send-back delivered (D4) and the attempt it reviewed (D5)."""

    review: dict[str, Any]
    attempt: int
    text: str
    # The attempt that answers it.
    answered_by: int


async def prior_review(
    db: AsyncSession, run: Run, segment: RunSegment, attempt: int | None
) -> PriorReview | None:
    """The review the segment's ``attempt`` answers: the send-back of the previous attempt
    (``artifacts["previous"]``, D5) whose checkpoint stored a review (D4); None for a first
    attempt, a note-only send-back's kept file, or a kind with no item file."""
    previous = (segment.artifacts or {}).get("previous")
    if not isinstance(previous, dict):
        return None
    text = (previous.get("files") or {}).get(ITEMS_FILE)
    number = previous.get("attempt")
    if not isinstance(text, str) or not isinstance(number, int):
        return None
    if attempt is not None and attempt <= number:
        return None
    for cp in reversed(await service._checkpoints(db, [run.id])):
        if (
            (cp.payload or {}).get("segment_seq") == segment.seq
            and cp.status == "changes_requested"
            and isinstance(cp.review, dict)
            and cp.review.get("attempt") == number
        ):
            return PriorReview(cp.review, number, text, attempt or number + 1)
    return None


@dataclass
class CheckedItems:
    """roadmap_items.yaml checked, with its reasons: what :func:`_check_items` stores and
    the shared draft (oracle.runs.actions) reads again on every read."""

    check: roadmap.ItemsCheck
    reasons: list[dict[str, Any]]
    base: dict[str, Any] | None
    partial: bool
    # The section keys of the run's PRD version; None without one.
    prd_sections: set[str] | None
    # D6: how the attempt answered the review it was sent back with, and its diff.
    resolution: dict[str, Any] | None = None
    diff: dict[str, Any] | None = None


async def _version_source(db: AsyncSession, source_id: uuid.UUID) -> Any:
    """A PRD version's slug, number and title (once per Inbox call, oracle.runs.batch)."""
    found = await _prd_source(db, source_id)
    return found[0] if found is not None else None


async def _prd_source(db: AsyncSession, source_id: uuid.UUID) -> tuple[VersionSource, str] | None:
    """A PRD version's source and its markdown, in one read (once per Inbox call)."""
    return await once(("version_source", source_id), lambda: _source_of(db, source_id))


async def _source_of(db: AsyncSession, source_id: uuid.UUID) -> tuple[VersionSource, str] | None:
    row = (
        await db.execute(
            select(DocumentVersion, Document)
            .join(Document, Document.id == DocumentVersion.document_id)
            .where(DocumentVersion.id == source_id)
        )
    ).first()
    return (docs_service.version_source(*row), row[0].markdown) if row is not None else None


async def _section_keys(db: AsyncSession, version_id: uuid.UUID) -> list[str]:
    return list(
        await db.scalars(select(Section.section_key).where(Section.version_id == version_id))
    )


async def items_check(db: AsyncSession, run: Run, text: str) -> roadmap.ItemsCheck:
    """The check of a Roadmap items file, read once per Inbox call (oracle.runs.batch)."""
    check, *_ = await once(
        ("items_check", service._source_id(run), text), lambda: _checked(db, run, text)
    )
    return check


async def _checked(
    db: AsyncSession, run: Run, text: str
) -> tuple[roadmap.ItemsCheck, str | None, int | None, set[str] | None, tuple[Any, ...]]:
    slug = version = prd_id = markdown = title = None
    keys: set[str] | None = None
    source_id = service._source_id(run)
    if source_id is not None:
        found = await _prd_source(db, source_id)
        if found is not None:
            source, markdown = found
            slug, version, prd_id = source.slug, source.version, source.document_id
            title = source.title
            keys = set(
                await once(("section_keys", source_id), lambda: _section_keys(db, source_id))
            )
    # CR-11: a date only with a verified estimate, capacity or commitment behind it.
    bases = await once(("date_bases", prd_id), lambda: schedule.verified_bases(db, prd_id))
    # In a worker thread with a time cap: agent output never holds the event loop.
    # The owner, Nov 4: an item may depend on another PRD's feature on the company roadmap.
    # Checked for the horizon and for a cycle through them.
    on_roadmap = await once(("on_roadmap",), lambda: roadmap_company.features_on_roadmap(db))
    elsewhere = roadmap_company.others_of(on_roadmap, prd_id, run.id)
    check = await roadmap.check_items_async(
        text,
        prd_slug=slug,
        prd_version=version,
        prd_sections=keys,
        date_bases=bases,
        elsewhere=elsewhere,
        prd_name=roadmap_company.OnRoadmap("", title).prd_name if title else None,
    )
    if source_id is not None and markdown is not None and check.items:
        check = await _with_work_problems(db, source_id, markdown, check)
    return check, slug, version, keys, elsewhere


async def _with_work_problems(
    db: AsyncSession, source_id: uuid.UUID, markdown: str, check: roadmap.ItemsCheck
) -> roadmap.ItemsCheck:
    """``check`` with the items' problems with the work the PRD version (``markdown``)
    planned from its brief's answers (walk 2 problem 19: a finding-out is never a blocker).
    A new check: ``check`` may be the parse cache's."""
    from oracle.intake import discovery

    work = await once(("version_work", source_id), lambda: discovery.version_work(db, markdown))
    found = discovery.items_problems(check.items, work)
    if not found:
        return check
    out = roadmap.ItemsCheck(list(check.items), list(check.problems), list(check.resolutions))
    for code, message, item in found:
        out.add(code, message, item)
    return out


async def checked_items(
    db: AsyncSession, run: Run, text: str, prior: PriorReview | None = None
) -> CheckedItems:
    check, slug, version, keys, elsewhere = await once(
        ("items_check", service._source_id(run), text), lambda: _checked(db, run, text)
    )
    if not check.items:
        return CheckedItems(check, [], None, False, keys)
    try:
        # In a savepoint: a database or trace error loses the advisory reasons only; the
        # blocking ones (the check's) are still stored, flagged partial.
        async with db.begin_nested():
            context = await reasons.reason_context(db, run, check.items)
        partial = False
    except Exception:  # noqa: BLE001 - advisory reasons never fail the check or the tick
        log.exception("the reasons of %s of run %s could not be loaded", ITEMS_FILE, run.id)
        context = reasons.ReasonContext(prd_title=slug, prd_version=version, advisory=False)
        partial = True
    # The check's own list of other PRDs' items: each dependency problem finds its item.
    found = reasons.reasons_for(check.items, check.problems, context, elsewhere)
    if prior is None:
        return CheckedItems(check, found, context.base, partial, keys)
    before = await roadmap.check_items_async(prior.text)
    resolution = answers.resolve(prior.review, before.items, check.items, check.resolutions)
    resolution["attempt"] = prior.answered_by
    found = reasons.with_resolutions(
        found, reasons.resolution_reasons(resolution, check.items), check.items
    )
    diff = answers.item_diff(before.items, check.items, prior.attempt)
    return CheckedItems(check, found, context.base, partial, keys, resolution, diff)
