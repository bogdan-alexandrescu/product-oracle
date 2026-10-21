"""Code capability maps (F5-2): building, storing, sharing and refreshing them.

- :func:`request_map`: a GitHub source's owner maps one of its repos (Settings › Sources,
  **Map the code**): a ``building`` row and a ``code_map`` run, estimated and started
  (over the approval threshold it waits for an owner, P3). A refresh is the same run,
  started by the ticker in the owner's name.
- :func:`import_map`: the ``code_map`` importer (``oracle.runs.extensions``): the run's
  ``code_map.json`` checked (:mod:`oracle.engineering.codemap`) and stored ``ready``, or
  ``failed`` with its problems (the run fails too).
- :func:`set_sharing`: private (only the source's owner sees the map; no run uses it)
  or full (everyone reads it, runs use it), for every map of the source's repo (S6).
  Lowering it back stops new uses; briefs already written keep their refs.
- :func:`note_merge`: a sync saw a pull request merged on the repo after a map's run
  started: that map is ``stale`` (one building is marked as it lands: merges during a
  refresh coalesce into one follow-up).
- :func:`refresh_due`: the ticker's step: maps whose run ended without a map are
  ``failed``; a repo whose latest map is stale gets one refresh run when its last run
  started more than :data:`REFRESH_EVERY` ago and none is building.
- :func:`for_run` and :func:`recorded_ids`: the shared ready maps a run uses, recorded on
  the run as it starts (``knobs["code_maps"]``), and their ids for the tech brief check.

Until SwarmCloud's read-only checkout of the repo is available to Oracle's agents
(SwarmCloud #1434 and the git token, ``docs/swarmcloud-interface.md`` §0) the indexer reads
what Oracle synced of the repo (README, docs, issues, pull requests) through Oracle's MCP
and marks the map ``partial`` ("Docs only: code not read" wherever it shows).
"""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import and_, delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.deps import Principal
from oracle.auth.models import User
from oracle.engineering import codemap
from oracle.engineering.models import CodeMap
from oracle.runs.models import Run
from oracle.sources.models import Source
from oracle.tenancy import current_tenant, tenant_session

FLOW = "code_map"
REFRESH_EVERY = timedelta(hours=1)
# The runs a map's build waits on; any other status ended it.
ACTIVE_RUN = ("draft", "awaiting_approval", "running", "awaiting_checkpoint", "paused_overrun")


class CodeMapError(Exception):
    status = 409


class NotFound(CodeMapError):
    status = 404


class Invalid(CodeMapError):
    status = 422


def _now() -> datetime:
    return datetime.now(UTC)


def _same(a: str, b: str) -> bool:
    return a.strip().lower() == b.strip().lower()


def visible(principal: Principal) -> Any:
    """Who sees a map: everyone a shared one; a private one only its source's owner, as
    a person (a run reads shared maps only, S6). Join :class:`Source` first."""
    shared = CodeMap.sharing == "full"
    if principal.is_run or principal.user_id is None:
        return shared
    return or_(shared, Source.owner_user_id == principal.user_id)


def readable(principal: Principal):
    return (
        select(CodeMap, Source)
        .join(Source, Source.id == CodeMap.source_id)
        .where(visible(principal))
    )


def mine(principal: Principal, source: Source) -> bool:
    return (
        not principal.is_run
        and principal.user_id is not None
        and source.owner_user_id == principal.user_id
    )


async def _source_of(db: AsyncSession, principal: Principal, source_id: uuid.UUID) -> Source:
    source = await db.get(Source, source_id)
    if source is None or not mine(principal, source):
        raise NotFound("Source not found")
    return source


def _repo_of(source: Source, repo: str) -> str:
    if source.kind != "github":
        raise Invalid("Only a GitHub source's repositories have a code map")
    listed = [r for r in (source.config or {}).get("repos") or [] if isinstance(r, str)]
    match = next((r for r in listed if _same(r, repo)), None)
    if match is None:
        raise Invalid(f"{repo} is not a repository of this source")
    return match.strip()


async def _latest(db: AsyncSession, source_id: uuid.UUID, repo: str) -> CodeMap | None:
    return await db.scalar(
        select(CodeMap)
        .where(CodeMap.source_id == source_id, func.lower(CodeMap.repo) == repo.lower())
        .order_by(CodeMap.created_at.desc(), CodeMap.id.desc())
        .limit(1)
    )


async def request_map(
    db: AsyncSession, principal: Principal, source_id: uuid.UUID, repo: str, *, refresh=False
) -> CodeMap:
    """A building map and its ``code_map`` run, estimated and started; commits. The
    caller submits the run (``runs.service.submit_queued``), or the next tick does."""
    from oracle.runs import service as runs_service
    from oracle.runs.schemas import RunCreate

    source = await _source_of(db, principal, source_id)
    name = _repo_of(source, repo)
    latest = await _latest(db, source.id, name)
    if latest is not None and latest.status == "building":
        raise CodeMapError(f"A code map of {name} is already being built")
    row = CodeMap(
        id=uuid.uuid4(),
        source_id=source.id,
        repo=name,
        status="building",
        # A refresh is shared as the map it replaces.
        sharing=latest.sharing if latest is not None else "private",
        shared_by=latest.shared_by if latest is not None else None,
        shared_at=latest.shared_at if latest is not None else None,
    )
    db.add(row)
    await db.flush()
    run_id = await runs_service.create_run(
        db,
        principal,
        RunCreate(flow=FLOW),
        entry_knobs={"code_map_id": str(row.id)},
        commit=False,
    )
    row.run_id = run_id
    await audit.record(
        db,
        principal,
        "code_map.requested",
        "code_map",
        row.id,
        {"source_id": str(source.id), "repo": name, "run_id": str(run_id), "refresh": refresh},
    )
    await db.commit()
    await runs_service.estimate(db, principal, run_id)
    await runs_service.start(db, principal, run_id)
    await db.refresh(row)
    return row


def _map_id(run: Any) -> uuid.UUID | None:
    raw = (run.knobs or {}).get("code_map_id")
    try:
        return uuid.UUID(str(raw)) if raw else None
    except ValueError:
        return None


def _as_of(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        at = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return at if at.tzinfo else at.replace(tzinfo=UTC)


async def import_map(
    db: AsyncSession, run: Any, files: dict[str, str], principal: Principal
) -> dict[str, Any]:
    """The ``code_map`` importer: the run's map checked and stored, in its own
    transaction. An ``error`` fails the run (the segment has no checkpoint)."""
    map_id = _map_id(run)
    if map_id is None:
        return {"error": "the run names no code map"}
    async with tenant_session(current_tenant(db)) as s:
        row = await s.get(CodeMap, map_id, with_for_update=True)
        if row is None:
            return {"error": "the run's code map is gone"}
        text = files.get(codemap.FILE)
        problems = (
            [codemap.Problem(code="unreadable", message=f"the run left no {codemap.FILE}")]
            if text is None
            else codemap.check(text)
        )
        if not problems:
            content = codemap.parse(text or "")
            if not _same(content["repo"], row.repo):
                problems = [
                    codemap.Problem(
                        code="bad_entry",
                        message=f"repo is {content['repo']!r}, not {row.repo!r}",
                    )
                ]
        if problems:
            row.status = "failed"
            row.error = "; ".join(f"[{p.code}] {p.message}" for p in problems)[:4000]
            await s.commit()
            return {"error": f"{codemap.FILE} was refused: {row.error}", "code_map_id": str(row.id)}
        commit = content.get("commit")
        # A map of the same commit already stored is replaced by this one.
        await s.execute(
            delete(CodeMap).where(
                CodeMap.source_id == row.source_id,
                CodeMap.repo == row.repo,
                CodeMap.commit_sha == commit,
                CodeMap.id != row.id,
            )
        )
        row.commit_sha = commit
        row.content = content
        row.size_bytes = len((text or "").encode())
        row.as_of = _as_of(content.get("generated_at")) or _now()
        row.error = None
        # A merge during the build: stale as it lands (one follow-up refresh).
        row.status = "stale" if row.stale_at is not None else "ready"
        await audit.record(
            s,
            audit.ORACLE,
            "code_map.built",
            "code_map",
            row.id,
            {"run_id": str(run.id), "commit": commit, "partial": content["partial"]},
        )
        await s.commit()
        return {"code_map_id": str(row.id), "status": row.status}


async def set_sharing(
    db: AsyncSession, principal: Principal, row: CodeMap, source: Source, sharing: str
) -> None:
    """Share every map of the source's repo in full, or make them private (the source's
    owner only); audited when it changes. The caller commits."""
    if not mine(principal, source):
        raise NotFound("Code map not found")
    if row.sharing == sharing:
        return
    rows = (
        await db.scalars(
            select(CodeMap).where(CodeMap.source_id == source.id, CodeMap.repo == row.repo)
        )
    ).all()
    now = _now()
    for r in rows:
        r.sharing = sharing
        r.shared_by = principal.user_id if sharing == "full" else None
        r.shared_at = now if sharing == "full" else None
    await audit.record(
        db,
        principal,
        "code_map.shared" if sharing == "full" else "code_map.unshared",
        "code_map",
        row.id,
        {"source_id": str(source.id), "repo": row.repo, "maps": len(rows)},
    )


async def note_merge(db: AsyncSession, source_id: uuid.UUID, repo: str, merged_at: datetime) -> int:
    """A pull request of ``repo`` merged at ``merged_at``: the source's latest map of the
    repo, when its run started before that, is marked stale (the caller commits).
    Returns how many maps it marked."""
    latest = await _latest(db, source_id, repo)
    if latest is None or latest.created_at >= merged_at or latest.status == "failed":
        return 0
    if latest.stale_at is None:
        latest.stale_at = merged_at
    if latest.status == "ready":
        latest.status = "stale"
    return 1


async def drop_outside(db: AsyncSession, source: Source) -> int:
    """Delete the source's maps of repos it no longer lists (S5's narrowing rule; the
    caller commits). Returns how many it deleted."""
    listed = {
        r.strip().lower() for r in (source.config or {}).get("repos") or [] if isinstance(r, str)
    }
    query = delete(CodeMap).where(CodeMap.source_id == source.id)
    if listed:
        query = query.where(func.lower(CodeMap.repo).not_in(listed))
    result = await db.execute(query)
    return result.rowcount or 0  # type: ignore[attr-defined]


async def _ended(db: AsyncSession) -> int:
    """Maps still building whose run ended (failed, cancelled, or without a map)."""
    rows = (
        await db.execute(
            select(CodeMap, Run)
            .outerjoin(Run, Run.id == CodeMap.run_id)
            .where(CodeMap.status == "building")
            .with_for_update(of=CodeMap)
        )
    ).all()
    n = 0
    for row, run in rows:
        if run is not None and run.status in ACTIVE_RUN:
            continue
        row.status = "failed"
        row.error = (
            "The code map run is gone"
            if run is None
            else f"The code map run {run.status}" + (f": {run.error}" if run.error else "")
        )[:4000]
        n += 1
    return n


async def refresh_due(db: AsyncSession) -> int:
    """The ticker's step (commits): end the builds whose run ended, then start one
    refresh run per repo whose latest map is stale, when its last run started more than
    :data:`REFRESH_EVERY` ago and none is building, in the source owner's name. Returns
    how many refresh runs it started."""
    from oracle.runs import service as runs_service

    await _ended(db)
    await db.commit()
    newest = (
        select(
            CodeMap.id,
            func.row_number()
            .over(
                partition_by=(CodeMap.source_id, func.lower(CodeMap.repo)),
                order_by=(CodeMap.created_at.desc(), CodeMap.id.desc()),
            )
            .label("n"),
        )
        .where(CodeMap.tenant_id == current_tenant(db))
        .subquery()
    )
    due = (
        await db.execute(
            select(CodeMap, Source, User)
            .join(newest, and_(newest.c.id == CodeMap.id, newest.c.n == 1))
            .join(Source, Source.id == CodeMap.source_id)
            .join(User, User.id == Source.owner_user_id)
            .where(CodeMap.status == "stale", CodeMap.created_at < _now() - REFRESH_EVERY)
            .order_by(CodeMap.created_at)
        )
    ).all()
    started = 0
    for row, source, owner in due:
        if owner.disabled_at is not None or source.status == "paused":
            continue
        principal = Principal(
            tenant_id=source.tenant_id, kind="user", role=owner.role, user_id=owner.id
        )  # type: ignore[arg-type]
        try:
            fresh = await request_map(db, principal, source.id, row.repo, refresh=True)
        except (CodeMapError, runs_service.RunError):
            await db.rollback()
            continue
        if fresh.run_id is not None:
            await runs_service.submit_queued(db, fresh.run_id)
        started += 1
    return started


async def for_run(db: AsyncSession) -> list[dict[str, Any]]:
    """The shared ready maps a run uses (the latest per source and repo), as the run
    records them: id, repo, commit, as_of."""
    rows = (
        await db.scalars(
            select(CodeMap)
            .where(CodeMap.sharing == "full", CodeMap.status == "ready")
            .order_by(CodeMap.created_at.desc(), CodeMap.id.desc())
        )
    ).all()
    out: list[dict[str, Any]] = []
    seen: set[tuple[uuid.UUID, str]] = set()
    for r in rows:
        key = (r.source_id, r.repo.lower())
        if key in seen:
            continue
        seen.add(key)
        out.append(
            {
                "id": str(r.id),
                "repo": r.repo,
                "commit": r.commit_sha,
                "as_of": r.as_of.isoformat() if r.as_of else None,
            }
        )
    return out


async def recorded(db: AsyncSession, run: Run) -> list[CodeMap]:
    """The maps a run recorded as it started, as stored (still there)."""
    ids = []
    for m in (run.knobs or {}).get("code_maps") or []:
        try:
            ids.append(uuid.UUID(str(m.get("id"))))
        except (ValueError, AttributeError):
            continue
    if not ids:
        return []
    return list(await db.scalars(select(CodeMap).where(CodeMap.id.in_(ids))))


async def recorded_ids(db: AsyncSession, run: Run) -> frozenset[str] | None:
    """The ids of the maps the run used; None when it recorded none (no shared map)."""
    maps = [m for m in await recorded(db, run) if m.content]
    if not maps:
        return None
    return frozenset(i for m in maps for i in codemap.ids(m.content or {}))


async def latest_shared(db: AsyncSession) -> list[CodeMap]:
    """The latest shared ready map of each source and repo."""
    picked = {m["id"] for m in await for_run(db)}
    if not picked:
        return []
    return list(
        await db.scalars(
            select(CodeMap)
            .where(CodeMap.id.in_([uuid.UUID(i) for i in picked]))
            .order_by(CodeMap.repo)
        )
    )


# SwarmCloud's read-only checkout of a repo for Oracle's agents (#1434, and the git token
# of docs/swarmcloud-interface.md §0) is not available yet: maps are built from the docs.
CHECKOUT_AVAILABLE = False


async def prompt_lines(db: AsyncSession, run: Run) -> list[str]:
    """The code_map prompt: the repository and how to read it."""
    map_id = _map_id(run)
    row = await db.get(CodeMap, map_id) if map_id else None
    if row is None:
        return ["No code map is attached to this run: write nothing."]
    source = await db.get(Source, row.source_id)
    lines = [
        f"Repository: {row.repo}"
        + (f" (of the GitHub source '{source.name}')" if source else "")
        + '. Write its full name in "repo" and the commit you read in "commit".',
    ]
    if CHECKOUT_AVAILABLE:
        lines.append(
            "Read the repository at the head of its default branch through the read-only "
            'checkout the runtime gives this step, and write "partial": false.'
        )
    else:
        lines.append(
            "The code itself cannot be read from this runtime yet. Build the map from what "
            f"Oracle synced of {row.repo} (its README, docs, issues and pull requests): find "
            'them with search and read them with get_source_item. Write "partial": true, '
            f'since the map rests on the docs ({codemap.PARTIAL_LABEL}), and "commit": null '
            "unless the docs name one."
        )
    return lines
