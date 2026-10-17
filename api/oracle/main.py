from contextlib import asynccontextmanager

from fastapi import FastAPI, Response, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import text

from oracle.auth.router import router as auth_router
from oracle.baseline.router import router as baseline_router
from oracle.config import get_settings
from oracle.connections.router import router as connections_router
from oracle.db import dispose_engine, get_engine
from oracle.docs.router import router as docs_router
from oracle.export.router import router as export_router
from oracle.members.router import router as members_router
from oracle.priorities.router import router as priorities_router
from oracle.review.router import router as review_router
from oracle.runs.router import router as runs_router
from oracle.sources.router import router as sources_router
from oracle.templates.router import router as templates_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
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
    app.include_router(docs_router)
    app.include_router(review_router)
    app.include_router(export_router)
    # v1 lanes add their routes to these (empty until then).
    app.include_router(members_router)
    app.include_router(connections_router)
    app.include_router(sources_router)
    app.include_router(baseline_router)
    app.include_router(priorities_router)
    app.include_router(templates_router)
    app.include_router(runs_router)
    return app


app = create_app()
