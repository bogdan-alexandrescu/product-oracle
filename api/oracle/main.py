import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import text

from oracle.account.router import router as account_router
from oracle.auth.router import router as auth_router
from oracle.autonomy_router import router as autonomy_router
from oracle.baseline.goals import GoalAttrs
from oracle.baseline.router import router as baseline_router
from oracle.baseline.service import GoalFieldsInvalid
from oracle.blockers.router import router as blockers_router
from oracle.claude_accounts.router import router as claude_accounts_router
from oracle.claude_accounts.sweep import get_pool_settings, run_scheduler
from oracle.config import get_settings
from oracle.connections.browse_github import router as github_browse_router
from oracle.connections.browse_google import router as drive_browse_router
from oracle.connections.browse_slack import router as slack_browse_router
from oracle.connections.notion_pages import router as notion_pages_router
from oracle.connections.router import router as connections_router
from oracle.db import dispose_engine, get_engine
from oracle.decisions.router import router as decisions_router
from oracle.discussions.router import router as discussions_router
from oracle.docs.parser import DraftError
from oracle.docs.router import router as docs_router
from oracle.docs.schemas import ImportErrorResponse
from oracle.engineering.router import router as engineering_router
from oracle.export.router import router as export_router
from oracle.intake.drafting import DraftGateClosed, draft_gate_closed
from oracle.intake.router import router as intake_router
from oracle.integrations.router import router as company_integrations_router
from oracle.interviews.public import router as public_interviews_router
from oracle.interviews.router import router as interviews_router
from oracle.jobs.router import router as llm_jobs_router
from oracle.jobs.worker import (
    JOB_OVERHEAD_SECONDS,
    get_worker_settings,
    job_seconds,
    run_worker,
)
from oracle.launches.router import router as launches_router
from oracle.mcp.oauth.routes import router as oauth_router
from oracle.mcp.server import mount_mcp
from oracle.members.router import people_router
from oracle.members.router import router as members_router
from oracle.modules.router import router as modules_router
from oracle.modules.service import seed_all_companies
from oracle.plan.router import router as plan_router
from oracle.preferences.router import router as preferences_router
from oracle.priorities.router import router as priorities_router
from oracle.quality.router import router as quality_router
from oracle.reports.router import router as reports_router
from oracle.requests.router import router as requests_router
from oracle.review.router import router as review_router
from oracle.review.v2_router import router as review_v2_router
from oracle.rituals.router import router as rituals_router
from oracle.roadmap.router import router as roadmap_router
from oracle.runs.router import router as runs_router
from oracle.safe_yaml import ParseBusy
from oracle.setup import router as setup_router
from oracle.sources.fireflies_browse import router as fireflies_browse_router
from oracle.sources.repair import run_at_startup as repair_version_urls_at_startup
from oracle.sources.router import router as sources_router
from oracle.specs.router import router as specs_router
from oracle.staging.router import router as staging_router
from oracle.strategy.router import router as strategy_router
from oracle.swarm import close_runtime
from oracle.templates.router import router as templates_router
from oracle.tenant_settings_api import router as settings_router
from oracle.ticker.router import HARD_LIMIT_SECONDS
from oracle.ticker.router import router as ticker_router
from oracle.trace.router import router as trace_router
from oracle.trash.router import router as trash_router
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
    # Versions an old image wrote without a link during the rollout (0014_intake):
    # repaired now and once more later, in the background (oracle.sources.repair).
    repair = asyncio.create_task(repair_version_urls_at_startup())
    interval = get_pool_settings().sweep_seconds
    tasks = [asyncio.create_task(run_scheduler(interval))] if interval > 0 and not ticker else []
    # The local worker for built-in model jobs; `oracle tick` runs them too.
    # ORACLE_LLM_JOBS_WORKER_SECONDS=0 turns it off.
    every = get_worker_settings().worker_seconds
    if every > 0:
        tasks.append(asyncio.create_task(run_worker(every)))
    tasks.append(repair)
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

    @app.exception_handler(DraftError)
    async def draft_rejected(_request: Request, exc: DraftError) -> JSONResponse:
        # M3: a version that can not be served as it must be (a spec version that can not
        # carry its state labels) is a 422 on every read path (the markdown, the exports,
        # the feedback package, MCP), never a 500. Routes that import drafts answer the
        # same body themselves.
        body = ImportErrorResponse(
            detail=f"draft rejected: {len(exc.problems)} problem(s)", errors=exc.problems
        )
        return JSONResponse(body.model_dump(mode="json"), 422)

    # C5: drafting from an intake waits until its critical questions are decided; the
    # 409 names them, on every path that creates or starts such a run.
    app.add_exception_handler(DraftGateClosed, draft_gate_closed)

    @app.exception_handler(GoalFieldsInvalid)
    async def goal_fields_rejected(_request: Request, exc: GoalFieldsInvalid) -> JSONResponse:
        # B5: a person's goal write with bad typed fields; every problem with its code.
        return JSONResponse({"detail": str(exc), "errors": exc.problems}, 422)

    @app.exception_handler(ParseBusy)
    async def parse_busy(_request: Request, exc: ParseBusy) -> JSONResponse:
        # The parse pool would not take an import now (owner, 2026-10-20): 429 for a person
        # with two parses already, 503 after a 10 s wait for a free worker.
        return JSONResponse(
            {"code": exc.code, "message": exc.message},
            exc.status,
            headers={"Retry-After": "5"},
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
    app.include_router(trash_router)
    app.include_router(docs_router)
    app.include_router(review_router)
    # G1: one thread per subject, open by default, private when its starter says so.
    app.include_router(discussions_router)
    app.include_router(staging_router)
    app.include_router(review_v2_router)
    app.include_router(export_router)
    app.include_router(llm_jobs_router)
    # v1 lanes add their routes to these (empty until then).
    app.include_router(members_router)
    app.include_router(people_router)
    app.include_router(account_router)
    app.include_router(connections_router)
    app.include_router(slack_browse_router)
    app.include_router(github_browse_router)
    app.include_router(drive_browse_router)
    app.include_router(notion_pages_router)
    app.include_router(settings_router)
    # A1: Home's Set up checklist.
    app.include_router(setup_router)
    # H11: how far Oracle goes on its own, per responsibility, and its "Oracle did" rows.
    app.include_router(autonomy_router)
    app.include_router(claude_accounts_router)
    app.include_router(sources_router)
    app.include_router(fireflies_browse_router)
    app.include_router(baseline_router)
    app.include_router(priorities_router)
    app.include_router(decisions_router)
    app.include_router(rituals_router)
    app.include_router(templates_router)
    app.include_router(runs_router)
    # Product Oracle v2: thin read routes over the shared tables; lanes add writes.
    app.include_router(v2_router)
    # v2 lanes: intake, gaps, questions and answers (CR-03).
    app.include_router(intake_router)
    # CR-08: PRD quality and readiness, outcome tracking and learnings.
    app.include_router(quality_router)
    # Modules and compositions (CR-01/02): catalogue, packs, manifests, revisions.
    app.include_router(modules_router)
    app.include_router(trace_router)
    app.include_router(engineering_router)
    app.include_router(blockers_router)
    # CR-09: engineering specs, user flows and wireframes from an approved PRD.
    app.include_router(specs_router)
    app.include_router(roadmap_router)
    # F6: the weekly alignment report and the company's Slack install it posts through.
    app.include_router(reports_router)
    app.include_router(company_integrations_router)
    app.include_router(requests_router)
    # C3 Interviews: members' routes, and the customer's behind a private link (no member
    # credential, never MCP tools: oracle.mcp.tools.PUBLIC_OPERATIONS).
    app.include_router(interviews_router)
    app.include_router(public_interviews_router)
    # F1 Plan screen: one read of the PRDs in play and the roadmap rows.
    app.include_router(plan_router)
    app.include_router(strategy_router)
    app.include_router(launches_router)
    # OAuth 2.1 for external MCP clients (discovery, registration, tokens, consent).
    app.include_router(oauth_router)
    # Cloud Scheduler's run ticker (Google ID token only; not in OpenAPI, so no MCP tool).
    app.include_router(ticker_router)
    # Every REST operation above (and any added later) is also an MCP tool here.
    mount_mcp(app)
    # B5: MCP clients see a goal's typed attrs shape.
    base_openapi = app.openapi

    def openapi() -> dict:
        if app.openapi_schema is None:
            doc = base_openapi()
            doc.setdefault("components", {}).setdefault("schemas", {})["GoalAttrs"] = (
                GoalAttrs.model_json_schema()
            )
        return app.openapi_schema

    app.openapi = openapi
    return app


app = create_app()
