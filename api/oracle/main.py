import asyncio
import contextlib
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
from oracle.connections.router import router as connections_router
from oracle.db import dispose_engine, get_engine
from oracle.docs.router import router as docs_router
from oracle.export.router import router as export_router
from oracle.jobs.router import router as llm_jobs_router
from oracle.jobs.worker import get_worker_settings, run_worker
from oracle.mcp.oauth.routes import router as oauth_router
from oracle.mcp.server import mount_mcp
from oracle.members.router import router as members_router
from oracle.preferences.router import router as preferences_router
from oracle.priorities.router import router as priorities_router
from oracle.review.router import router as review_router
from oracle.runs.router import router as runs_router
from oracle.sources.router import router as sources_router
from oracle.templates.router import router as templates_router
from oracle.tenant_settings_api import router as settings_router
from oracle.v2.router import router as v2_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    # The Claude account pool's local scheduler (SwarmCloud runs its sweep from Cloud
    # Scheduler); `oracle tick` sweeps too. ORACLE_CLAUDE_SWEEP_SECONDS=0 turns it off.
    interval = get_pool_settings().sweep_seconds
    tasks = [asyncio.create_task(run_scheduler(interval))] if interval > 0 else []
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
    app.include_router(settings_router)
    app.include_router(claude_accounts_router)
    app.include_router(sources_router)
    app.include_router(baseline_router)
    app.include_router(priorities_router)
    app.include_router(templates_router)
    app.include_router(runs_router)
    # Product Oracle v2: thin read routes over the shared tables; lanes add writes.
    app.include_router(v2_router)
    app.include_router(blockers_router)
    # OAuth 2.1 for external MCP clients (discovery, registration, tokens, consent).
    app.include_router(oauth_router)
    # Every REST operation above (and any added later) is also an MCP tool here.
    mount_mcp(app)
    return app


app = create_app()
