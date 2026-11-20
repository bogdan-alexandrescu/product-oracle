"""Runs: what a segment's agents are told: the prompt context from the run and its documents."""

import uuid
from typing import Any

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import company_time, confidence
from oracle.baseline.goals import target_words
from oracle.baseline.models import Edge, Entity
from oracle.docs import service as docs_service
from oracle.docs import visibility
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.engineering import check as eng_check
from oracle.engineering import dates as eng_dates
from oracle.jobs.models import LlmSuggestion
from oracle.priorities import service as priorities_service
from oracle.priorities.models import PrioritySnapshot
from oracle.review.models import FeedbackItem
from oracle.review.service import locked_section_keys
from oracle.roadmap import company as roadmap_company
from oracle.roadmap import schedule
from oracle.roadmap.views import items_version, version_items
from oracle.runs import extensions, feature_set, flows, reuse, service, stop_answers, workflow
from oracle.runs.models import Checkpoint, Run, RunSegment
from oracle.runs.service import (
    COMPANY_QUEUE,
    ITEMS_FILE,
    _checkpoints,
    _flow,
    _knobs,
    _set_knob,
    _source_id,
    member_hidden,
    reads_as_member,
)
from oracle.sources.models import Snapshot
from oracle.swarm import AgentRuntime
from oracle.templates import service as templates_service
from oracle.tenant_settings import TenantSetting
from oracle.tenant_settings_api import company_horizons


async def _low_threshold(db: AsyncSession) -> float:
    row = await db.scalar(select(TenantSetting).where(TenantSetting.key == "confidence_weights"))
    overrides = row.value if row is not None and isinstance(row.value, dict) else None
    return float(confidence.merged(overrides)["low"])


# D12: the knobs that name what Build next draft sent a feedback loop.
SENT_KNOBS = ("feedback_ids", "suggestion_ids", "next_draft_change_ids")


def sent_items(run: Run) -> bool:
    """D12: the run was started from Build next draft, so it was given exactly the items
    in its knobs (one missing names none), not every open item."""
    return any(k in (run.knobs or {}) for k in SENT_KNOBS)


async def _loop_feedback(db: AsyncSession, run: Run) -> list[dict[str, Any]]:
    """D12: the items a feedback loop started from Build next draft was given: the
    feedback staged for the agents and each accepted section-text change, with its text."""
    knobs = run.knobs or {}
    fids = [uuid.UUID(str(i)) for i in knobs.get("feedback_ids") or []]
    sids = [uuid.UUID(str(i)) for i in knobs.get("suggestion_ids") or []]
    texts: dict[uuid.UUID, str] = {}
    for sug in await db.scalars(
        select(LlmSuggestion).where(
            LlmSuggestion.id.in_(sids), LlmSuggestion.document_id == run.document_id
        )
    ):
        texts[sug.feedback_item_id] = sug.edited_text or sug.text or ""
    items = await db.scalars(
        select(FeedbackItem)
        .where(
            FeedbackItem.document_id == run.document_id,
            FeedbackItem.id.in_([*fids, *texts]),
        )
        .order_by(FeedbackItem.created_at, FeedbackItem.id)
    )
    return [
        {
            "id": str(f.id),
            "section_key": f.section_key,
            "summary": f.summary,
            **({"accepted_text": texts[f.id]} if f.id in texts else {}),
        }
        for f in items
    ]


async def _imported_numbers(db: AsyncSession, run: Run) -> set[int]:
    """The version numbers this run's drafts were imported as, any attempt (each attempt's
    import is on its checkpoint's payload, the current one on its segment)."""
    segments = await db.scalars(select(RunSegment).where(RunSegment.run_id == run.id))
    checkpoints = await db.scalars(select(Checkpoint).where(Checkpoint.run_id == run.id))
    imports = [(s.artifacts or {}).get("import") for s in segments]
    imports += [(c.payload or {}).get("import") for c in checkpoints]
    return {
        int(imp["version"])
        for imp in imports
        if isinstance(imp, dict) and imp.get("version") is not None and not imp.get("error")
    }


async def _loop_section_changes(db: AsyncSession, run: Run) -> list[dict[str, Any]]:
    """G4: the section changes staged from discussions that a feedback loop started from
    Build next draft was given, oldest first: still staged, or applied in a draft this run
    imported (a later attempt keeps them); never one another build applied."""
    from oracle.staging.models import NextDraftChange

    ids = [uuid.UUID(str(i)) for i in (run.knobs or {}).get("next_draft_change_ids") or []]
    if not ids:
        return []
    mine = await _imported_numbers(db, run)
    rows = await db.scalars(
        select(NextDraftChange)
        .where(
            NextDraftChange.id.in_(ids),
            NextDraftChange.document_id == run.document_id,
            or_(
                NextDraftChange.status == "staged",
                and_(
                    NextDraftChange.status == "applied",
                    NextDraftChange.applied_in_version.in_(mine),
                ),
            ),
        )
        .order_by(NextDraftChange.created_at, NextDraftChange.id)
    )
    return [
        {
            "id": str(r.id),
            "section_key": r.section_key,
            "instruction": r.instruction,
            "reason": r.reason,
            **({"text": r.text} if r.text else {}),
        }
        for r in rows
    ]


async def _prompt_context(
    db: AsyncSession,
    run: Run,
    segment: RunSegment,
    segments: list[RunSegment],
    attempt: int,
    change_request: str | None,
    runtime: AgentRuntime,
    *,
    attached: bool = False,
    planned: list[tuple[int, str, list[str]]] | None = None,
) -> flows.PromptContext:
    """``attached``: the run token reaches the agents, so earlier outputs are named, not
    pasted; ``planned``: earlier segments of the same workflow and the files they write."""
    knobs = _knobs(run)
    snapshot = await db.get(Snapshot, run.snapshot_id) if run.snapshot_id else None
    document = None
    doc = await db.get(Document, run.document_id) if run.document_id else None
    if doc is not None:
        document = doc.slug
    document = document or run.knobs.get("document_slug")
    kind = await _target_kind(db, run)
    source = await _source_context(db, run) if _flow(run).source_prompt else None
    draft_ctx = None
    # A roadmap draft is built from its source PRD (as before C4); a PRD draft from the
    # baseline, with the template picked at New PRD.
    if (
        _flow(run).segment(segment.name).imports_draft
        and run.knobs.get("template")
        and (source is not None or kind != "roadmap")
    ):
        if doc is not None:
            title = doc.title
        elif source is not None:
            title = f"{source.title} {flows.KIND_NAMES[kind]}"
        else:
            title = await _intake_title(db, run) or (document or "")
        draft_ctx = await _draft_context(db, run, kind, document or "", title)
    prior: dict[str, str] = {}
    prior_files: list[tuple[int, str, list[str]]] = []
    in_workflow = {seq for seq, _, _ in planned or []}
    for s in segments:
        if s.seq < segment.seq and s.seq not in in_workflow:
            files = (s.artifacts or {}).get("files") or {}
            for name, content in files.items():
                prior[name] = content
            if files:
                prior_files.append((s.seq, _flow(run).segment(s.name).title, sorted(files)))
    prior_files += list(planned or [])
    run_items = None
    if (
        run.flow == "prd_to_roadmap"
        and segment.name == "roadmap_draft"
        and (items_text := prior.get(ITEMS_FILE))
    ):
        # roadmap-plan-tables: the checkpoint's check of the file (kept by
        # oracle.runs.roadmap), not a second parse in the prompt.
        run_items = (await service.items_check(db, run, items_text)).items
    # A person sent the segment back (D5): it starts from its previous files and the
    # problems Oracle's check found in them. A runtime retry has no change request.
    previous = (segment.artifacts or {}).get("previous") if change_request else None
    previous_attempt: int | None = None
    previous_files: dict[str, str] = {}
    previous_problems: list[str] = []
    if attempt > 1 and isinstance(previous, dict) and int(previous.get("attempt") or 0) < attempt:
        previous_attempt = int(previous["attempt"])
        previous_files = dict(previous.get("files") or {})
        previous_problems = workflow.check_problems(
            ITEMS_FILE, previous.get("items_check"), []
        ) + workflow.check_problems(
            flows.draft_file(kind), None, list(previous.get("import_problems") or [])
        )
    # #562 review: a person's words that name something a commenter may not see stay out
    # of a member-view run's prompt (reviewer notes, the change request, the Regenerate
    # note; discussions: oracle.discussions.agent_view.for_member_run).
    hidden = await member_hidden(db, run)
    # A PRD writer reads each stop's note in its decided block, with the stop's name, who
    # decided and the decision record (stop_answers.prompt_lines).
    notes = [
        f"{c.kind}: {c.note}"
        for c in await _checkpoints(db, [run.id])
        if c.status == "approved" and c.note and not (hidden and hidden.names(c.note))
        and segment.name not in stop_answers.WRITERS
    ]  # fmt: skip
    if change_request and hidden and hidden.names(change_request):
        change_request = WITHHELD_NOTE
    feedback: list[dict[str, Any]] = []
    locked: list[str] = []
    section_changes: list[dict[str, Any]] = []
    chosen = sent_items(run)
    if run.flow == "feedback_loop" and run.document_id:
        feedback = await _loop_feedback(db, run) if chosen else []
        section_changes = await _loop_section_changes(db, run) if chosen else []
        if not chosen:
            items = await db.scalars(
                select(FeedbackItem)
                .where(FeedbackItem.document_id == run.document_id, FeedbackItem.status == "open")
                .order_by(FeedbackItem.created_at, FeedbackItem.id)
            )
            feedback = [
                {"id": str(f.id), "section_key": f.section_key, "summary": f.summary} for f in items
            ]
        latest = await db.scalar(
            select(DocumentVersion)
            .where(DocumentVersion.document_id == run.document_id)
            .order_by(DocumentVersion.number.desc())
            .limit(1)
        )
        if latest is not None:
            locked = sorted(await locked_section_keys(db, latest.id))
    from oracle.discussions import agent_view

    # G5: what people discussed about the run, as its agents see it.
    discussions = await agent_view.for_prompt(db, run)
    scope_yaml = None
    if not attached and "get_prd_scope" in _flow(run).segment(segment.name).tools:
        scope = await feature_set.approved_scope(db, run_id=run.id, document_id=run.document_id)
        if scope is not None:
            scope_rows = await feature_set.scope_items(db, scope.id)
            scope_yaml = await feature_set.scope_yaml_async(scope, scope_rows)
    # SwarmCloud reaches Oracle only through the credential it attaches; the local
    # runtime's agents are Oracle's own.
    mcp_reachable = attached or (runtime.can_reach_oracle and runtime.name != "swarmcloud")
    return flows.PromptContext(
        run_id=str(run.id),
        document=document,
        snapshot_as_of=snapshot.as_of.isoformat() if snapshot else None,
        low_confidence=await _low_threshold(db),
        depth=knobs.depth,
        prior_outputs=prior,
        run_items=run_items,
        reviewer_notes=notes,
        feedback=feedback,
        staged=chosen,
        section_changes=section_changes,
        locked_sections=locked,
        attempt=attempt,
        change_request=change_request,
        previous_attempt=previous_attempt,
        previous_seq=segment.seq if previous_attempt is not None else None,
        previous_files=previous_files,
        previous_problems=previous_problems,
        mcp_reachable=mcp_reachable,
        mcp_attached=attached,
        prior_files=prior_files,
        kind=kind,
        source=source,
        loop_plan=await service._loop_plan_inputs(db, run)
        if kind == "roadmap"
        and run.flow != "prd_to_roadmap"
        and _flow(run).segment(segment.name).imports_draft
        else None,
        draft=draft_ctx,
        extra_lines=[
            *await extensions.prompt_lines(db, run),
            *await eng_check.prompt_lines(db, run.id, segment.name),
            *await stop_answers.prompt_lines(db, run, segment.name, segment.seq, hidden),
            *(
                await eng_check.run_architect_lines(db, run, mcp_reachable=mcp_reachable)
                if flows.BRIEFS_FILE in _flow(run).segment(segment.name).outputs
                else []
            ),
            *await eng_dates.prompt_lines(db, run, segment.name),
            *await _roadmap_lines(db, run, segment.name, kind, hidden),
            *_regenerate_note(run, hidden),
            *await _carried_lines(db, run, segment.name),
        ],
        intake_id=run.knobs.get("intake_id"),
        intake_gap_ids=list(run.knobs.get("intake_gap_ids") or []),
        scope_yaml=scope_yaml,
        launch_id=run.knobs.get("launch_id"),
        target_goals=[(g["key"], g["title"]) for g in run.knobs.get("target_goals") or []],
        target_features=[(f["key"], f["title"]) for f in run.knobs.get("target_features") or []],
        discussions=discussions,
        baseline_reused=reuse.short_date(
            reused["approved_at"], await company_time.company_time_zone(db)
        )
        if (reused := run.knobs.get("reuse_baseline")) and segment.name != "baseline"
        else None,
    )


async def _roadmap_lines(
    db: AsyncSession, run: Run, segment: str, kind: str | None, hidden: Any
) -> list[str]:
    """prd-reads-working-draft: a PRD's run follows the company roadmap of record (its
    working draft when newer than the published version; oracle.simple.roadmap_of_record)
    and keeps the words saying which one it read (``roadmap_read``, the run page's)."""
    from oracle.simple import roadmap_of_record

    if run.flow not in roadmap_of_record.FLOWS or segment not in roadmap_of_record.SEGMENTS:
        return []
    if kind != "prd":
        return []
    # The draft is read by its own rule (oracle.simple.drafts.sees): the run reads it when
    # the person who started the run may see it (the owner always may), else the published
    # version; a run nobody started (Oracle's own) has nobody who may see it, so it reads
    # the published version.
    record = await roadmap_of_record.read(db, reader=run.created_by)
    if record is None:
        return []
    # Each step keeps the roadmap it read (``roadmap_read_by``); ``roadmap_read`` is the
    # last step's, the one the run page shows.
    knobs = dict(run.knobs or {})
    by_step = {**(knobs.get("roadmap_read_by") or {}), segment: record.label}
    if knobs.get("roadmap_read") != record.label or knobs.get("roadmap_read_by") != by_step:
        run.knobs = {**knobs, "roadmap_read": record.label, "roadmap_read_by": by_step}
    return roadmap_of_record.prompt_lines(record, run.document_id, hidden)


async def _carried_lines(db: AsyncSession, run: Run, segment: str) -> list[str]:
    """The PRD writer's carried inputs, when the run's brief replaces a PRD."""
    if segment != "prd_draft":
        return []
    from oracle.intake import carried

    got = await carried.of_run(db, run)
    return carried.prompt_lines(got) if got is not None else []


# #562 review: what a member-view run's prompt says instead of a person's note that names
# something a commenter may not see.
WITHHELD_NOTE = (
    "A person's note names something only owners and approvers may see, so it is not shown here."
)


def _regenerate_note(run: Run, hidden: visibility.Hidden | None = None) -> list[str]:
    """#482: the note given with Regenerate, for every step of the run it started (none
    when it names something ``hidden``)."""
    note = (run.knobs or {}).get("regenerate_note")
    if not note or (hidden is not None and hidden.names(note)):
        return []
    return [
        "This run regenerates the document as its next version. The note given with "
        "Regenerate (a person's words: follow them where they fit the task above):",
        f"- {note}",
    ]


async def _target_kind(db: AsyncSession, run: Run) -> str:
    """The kind of the document the run writes: the flow's, else the document's."""
    flow = _flow(run)
    if flow.target_kind:
        return flow.target_kind
    if run.document_id:
        kind = await db.scalar(select(Document.kind).where(Document.id == run.document_id))
        if kind:
            return kind
    return "prd"


def _explain(feature: dict[str, Any]) -> str:
    explanation = feature.get("explanation") or {}
    parts = [explanation.get("formula") or ""]
    parts += list(explanation.get("steps") or [])[:3]
    parts += list(explanation.get("order") or [])[:2]
    return " ".join(p for p in parts if p)[:400]


async def _run_horizons(db: AsyncSession, run: Run) -> dict[str, int]:
    """The planning horizons pinned when the run started (A1: runs under way keep what
    they started with); a run started before they were pinned reads the company's."""
    pinned = (run.knobs or {}).get("planning_horizons")
    if isinstance(pinned, dict):
        return dict(pinned)
    return await company_horizons(db)


async def _source_context(db: AsyncSession, run: Run) -> flows.SourceContext | None:
    """prd_to_roadmap: the approved PRD version, priorities, edges and goals."""
    source_id = _source_id(run)
    if source_id is None:
        return None
    version = await db.get(DocumentVersion, source_id)
    if version is None:
        return None
    document = await db.get(Document, version.document_id)
    sections = list(
        (
            await db.execute(
                select(Section.section_key, Section.heading)
                .where(Section.version_id == version.id)
                .order_by(Section.ordinal)
            )
        ).all()
    )
    # C8 rule 7: this PRD's approved order, else a person's company-wide snapshot (no
    # run), else the live goal-weighted ranking. A proposed or discarded order never counts.
    newest = PrioritySnapshot.created_at.desc()
    saved = select(PrioritySnapshot).where(PrioritySnapshot.status == "saved")
    stored = await db.scalar(
        saved.where(PrioritySnapshot.document_id == version.document_id).order_by(newest).limit(1)
    )
    if stored is not None:
        at = stored.decided_at or stored.created_at
        on = company_time.day_first_in_words(at, await company_time.company_time_zone(db))
        method = f"{stored.method}, this PRD's approved order of {on}"
        ranking = list(stored.ranking or [])
    elif (
        stored := await db.scalar(
            saved.where(PrioritySnapshot.run_id.is_(None)).order_by(newest).limit(1)
        )
    ) is not None:
        on = company_time.day(stored.created_at, await company_time.company_time_zone(db))
        method = f"{stored.method}, priority snapshot of {on.isoformat()}"
        ranking = list(stored.ranking or [])
    else:
        live = await priorities_service.compute(db, "goal_weighted")
        method = f"{live.method}, live ranking"
        ranking = [f.model_dump(mode="json") for f in live.features]
    priorities = [
        {
            "rank": f.get("rank"),
            "key": f.get("key"),
            "title": f.get("title"),
            "score": f.get("score"),
            "flags": f.get("flags") or [],
            "depends_on": f.get("depends_on") or [],
            "explanation": _explain(f),
        }
        for f in ranking
    ]
    shown = select(Entity).where(Entity.status != "rejected")
    if await reads_as_member(db, run):
        # #562 review: a member-view run's prompt has no hidden decision's entity, nor
        # (both ends must be shown) any edge to or from one.
        shown = shown.where(visibility.member_entity_visible(Entity))
    entities = {e.id: e for e in await db.scalars(shown)}
    edges = [
        {
            "src": f"{entities[e.src_id].type}:{entities[e.src_id].key}",
            "type": e.type,
            "dst": f"{entities[e.dst_id].type}:{entities[e.dst_id].key}",
        }
        for e in await db.scalars(
            select(Edge)
            .where(Edge.type.in_(("depends_on", "blocks")), Edge.status != "rejected")
            .order_by(Edge.created_at, Edge.id)
        )
        if e.src_id in entities and e.dst_id in entities
    ]
    goals = [
        {
            "key": e.key,
            "title": e.title,
            **{k: (e.attrs or {}).get(k) for k in ("metric", "target", "horizon")},
            # B5: the typed target in words ("at least 45% (...), short horizon").
            "target_words": target_words(e.attrs or {}),
        }
        for e in sorted(entities.values(), key=lambda e: e.key)
        if e.type == "goal" and e.status == "confirmed"
    ]
    bases = await schedule.verified_bases(db, version.document_id)
    if _flow(run).stores_draft_items:
        from oracle.roadmap import draft_items

        known_from, known = await draft_items.known_items(db, version)
    else:
        known_from, known = await _known_roadmap_items(db, run)
    frozen = (
        await _frozen_queue(db, run, version)
        if run.flow == "prd_to_roadmap"
        else {"rows": [], "per_week": None, "today": None}
    )
    return flows.SourceContext(
        approved=version.approved_at is not None or not _flow(run).stores_draft_items,
        known_items=known,
        known_from=known_from,
        horizons=await _run_horizons(db, run),
        schedule_bases=[b.as_json() for b in bases],
        company_queue=frozen["rows"],
        company_plan={k: v for k, v in frozen.items() if k != "rows"},
        slug=document.slug if document else str(version.document_id),
        title=document.title if document else "",
        version=version.number,
        markdown=version.markdown,
        sections=[(k, h) for k, h in sections],
        priorities=priorities,
        priority_method=method,
        edges=edges,
        goals=goals,
    )


async def _frozen_queue(
    db: AsyncSession, run: Run, source: DocumentVersion | None
) -> dict[str, Any]:
    """one-roadmap-many-prds: the shared queue this run reads (oracle.roadmap.company
    .frozen_queue), stored on the run when its first prompt (the roadmap_items segment's)
    is built, before the run writes its items file; that prompt, the roadmap draft's, every
    rewrite after a refusal and the check read that copy, though other PRDs' runs land or
    the team's capacity changes meanwhile. ``source``: the run's PRD version."""
    frozen = (run.knobs or {}).get(COMPANY_QUEUE)
    if isinstance(frozen, dict) and isinstance(frozen.get("rows"), list):
        return frozen
    frozen = await roadmap_company.frozen_queue(
        db, source.document_id if source else None, run.created_at, source
    )
    _set_knob(run, COMPANY_QUEUE, frozen)
    await db.flush()
    return frozen


async def _known_roadmap_items(db: AsyncSession, run: Run) -> tuple[str, list[dict[str, str]]]:
    """E3: the latest items of the roadmap a prd_to_roadmap run writes the next version
    of, so the agents keep their ids; none for a new roadmap."""
    doc = await db.get(Document, run.document_id) if run.document_id else None
    if doc is None and run.knobs.get("document_slug"):
        doc = await db.scalar(select(Document).where(Document.slug == run.knobs["document_slug"]))
    if doc is None or doc.kind != "roadmap":
        return "", []
    version = await items_version(db, doc)
    rows = await version_items(db, version)
    if not rows or version is None:
        return "", []
    known = [{"id": r.item_key, "title": r.title, "horizon": r.horizon} for r in rows]
    return f"roadmap v{version.number}", known


async def _intake_title(db: AsyncSession, run: Run) -> str | None:
    """The title of the intake a run started from (a new PRD takes it, C4)."""
    raw = run.knobs.get("intake_id")
    if not raw:
        return None
    from oracle.v2.models import ProductIntake

    try:
        intake = await db.get(ProductIntake, uuid.UUID(str(raw)))
    except ValueError:
        return None
    return intake.title if intake is not None else None


async def _draft_context(
    db: AsyncSession, run: Run, kind: str, slug: str, title: str
) -> flows.DraftContext | None:
    """The draft's template, theme and skeleton (the template's body as a first draft of
    this ``kind`` document, front matter included): a roadmap's (prd_to_roadmap) and a
    PRD's (baseline_to_prd, C4)."""
    key, number = run.knobs.get("template"), run.knobs.get("template_version")
    if not key or not number:
        return None
    body = await docs_service.template_body(db, key, str(number))
    if body is None:
        return None
    theme = run.knobs.get("theme")
    skeleton = templates_service.draft_skeleton(
        body,
        slug=slug,
        title=title,
        kind=kind,
        template=key,
        version=int(number),
        theme=theme,
    )
    return flows.DraftContext(
        kind=kind,
        slug=slug,
        template=key,
        template_version=int(number),
        theme=theme,
        skeleton=skeleton,
    )
