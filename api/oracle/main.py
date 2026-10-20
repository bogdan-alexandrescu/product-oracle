import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Response, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import text

from oracle.auth.router import router as auth_router
from oracle.baseline.router import router as baseline_router
from oracle.blockers.router import router as blockers_router
from oracle.claude_accounts.router import router as claude_accounts_router
from oracle.claude_accounts.sweep import get_pool_settings, run_scheduler
from oracle.config import get_settings
from oracle.connections.browse_github import router as github_browse_router
from oracle.connections.browse_slack import router as slack_browse_router
from oracle.connections.notion_pages import router as notion_pages_router
from oracle.connections.router import router as connections_router
from oracle.db import dispose_engine, get_engine
from oracle.docs.router import router as docs_router
from oracle.export.router import router as export_router
from oracle.jobs.router import router as llm_jobs_router
from oracle.jobs.worker import (
    JOB_OVERHEAD_SECONDS,
    get_worker_settings,
    job_seconds,
    run_worker,
)
from oracle.mcp.oauth.routes import router as oauth_router
from oracle.mcp.server import mount_mcp
from oracle.members.router import router as members_router
from oracle.modules.router import router as modules_router
from oracle.modules.service import seed_all_companies
from oracle.preferences.router import router as preferences_router
from oracle.priorities.router import router as priorities_router
from oracle.quality.router import router as quality_router
from oracle.review.router import router as review_router
from oracle.roadmap.router import router as roadmap_router
from oracle.runs.router import router as runs_router
from oracle.sources.fireflies_browse import router as fireflies_browse_router
from oracle.sources.router import router as sources_router
from oracle.swarm import close_runtime
from oracle.templates.router import router as templates_router
from oracle.tenant_settings_api import router as settings_router
from oracle.ticker.router import HARD_LIMIT_SECONDS
from oracle.ticker.router import router as ticker_router
from oracle.trace.router import router as trace_router
from oracle.v2.router import router as v2_router

log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    ticker = bool(settings.ticker_audience.strip() and settings.ticker_service_account.strip())
    if ticker and job_seconds() > HARD_LIMIT_SECONDS:
        log.warning(
            "ORACLE_LLM_TIMEOUT_SECONDS is %.0f: no model call fits in a run ticker's %.0f s, "
            "so the scheduled tick runs no built-in jobs; set it to at most %.0f "
            "(docs/ops-run-ticker.md)",
            job_seconds() - JOB_OVERHEAD_SECONDS,
            HARD_LIMIT_SECONDS,
            HARD_LIMIT_SECONDS - JOB_OVERHEAD_SECONDS,
        )
    # Built-in templates, modules and manifests for every company, so a release's new
    # or upgraded built-ins are there before anyone reads (reads never write). Each
    # company is seeded on its own: one failing is logged by id and the rest go on.
    # Nothing here is fatal: the write paths seed too.
    try:
        await seed_all_companies()
    except Exception:
        log.exception("seeding built-in modules at startup failed")
    # The Claude account pool's local scheduler (SwarmCloud runs its sweep from Cloud
    # Scheduler): it sweeps the companies due, never one within five minutes of its last
    # sweep. Not started while the run ticker is configured: the ticker sweeps then, once
    # for every instance. ORACLE_CLAUDE_SWEEP_SECONDS=0 turns it off.
    interval = get_pool_settings().sweep_seconds
    tasks = [asyncio.create_task(run_scheduler(interval))] if interval > 0 and not ticker else []
    # The local worker for built-in model jobs; `oracle tick` runs them too.
    # ORACLE_LLM_JOBS_WORKER_SECONDS=0 turns it off.
    every = get_worker_settings().worker_seconds
    if every > 0:
        tasks.append(asyncio.create_task(run_worker(every)))
    yield
    for task in tasks:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
    await close_runtime()
    await dispose_engine()


class Health(BaseModel):
    status: str
    database: str


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Product Oracle API",
        version="0.1.0",
        lifespan=lifespan,
        # operationId = function name, so generated clients get readable names.
        generate_unique_id_function=lambda route: route.name,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/healthz", response_model=Health, tags=["health"])
    async def healthz(response: Response) -> Health:
        # Engine-level check on purpose: it is not tenant data, so no tenant session.
        try:
            async with get_engine().connect() as conn:
                await conn.execute(text("SELECT 1"))
        except Exception:
            response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
            return Health(status="error", database="unreachable")
        return Health(status="ok", database="ok")

    app.include_router(auth_router)
    app.include_router(preferences_router)
    app.include_router(docs_router)
    app.include_router(review_router)
    app.include_router(export_router)
    app.include_router(llm_jobs_router)
    # v1 lanes add their routes to these (empty until then).
    app.include_router(members_router)
    app.include_router(connections_router)
    app.include_router(slack_browse_router)
    app.include_router(github_browse_router)
    app.include_router(notion_pages_router)
    app.include_router(settings_router)
    app.include_router(claude_accounts_router)
    app.include_router(sources_router)
    app.include_router(fireflies_browse_router)
    app.include_router(baseline_router)
    app.include_router(priorities_router)
    app.include_router(templates_router)
    app.include_router(runs_router)
    # Product Oracle v2: thin read routes over the shared tables; lanes add writes.
    app.include_router(v2_router)
    # CR-08: PRD quality and readiness, outcome tracking and learnings.
    app.include_router(quality_router)
    # Modules and compositions (CR-01/02): catalogue, packs, manifests, revisions.
    app.include_router(modules_router)
    app.include_router(trace_router)
    app.include_router(blockers_router)
    app.include_router(roadmap_router)
    # OAuth 2.1 for external MCP clients (discovery, registration, tokens, consent).
    app.include_router(oauth_router)
    # Cloud Scheduler's run ticker (Google ID token only; not in OpenAPI, so no MCP tool).
    app.include_router(ticker_router)
    # Every REST operation above (and any added later) is also an MCP tool here.
    mount_mcp(app)
    return app


app = create_app()
