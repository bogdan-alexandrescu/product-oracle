"""Helpers for the legacy regression tests: synthetic fixtures, role credentials, and
the CLI and MCP clients driven against the in-process app."""

import asyncio
import io
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import httpx2
from mcp import Client
from mcp.client.streamable_http import streamable_http_client

from oracle.auth.service import create_api_token, create_user, make_session_cookie
from oracle.cli.oracle_cli import main as cli_main
from oracle.config import get_settings
from oracle.review.models import FeedbackItem
from oracle.tenancy import tenant_session

FIXTURES = Path(__file__).resolve().parent / "fixtures"
DOC = "legacy-onboarding"
MARKDOWN = {"Content-Type": "text/markdown"}
# The feedback items legacy_prd_v2.md resolves (addressed, declined).
FEEDBACK_ADDRESSED = uuid.UUID("33333333-3333-4333-8333-333333333333")
FEEDBACK_DECLINED = uuid.UUID("44444444-4444-4444-8444-444444444444")


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


async def import_md(client, headers, text: str, doc: str = DOC) -> httpx.Response:
    return await client.post(
        f"/v1/documents/{doc}/versions", content=text.encode(), headers={**headers, **MARKDOWN}
    )


async def user_cookie(tenant_id: uuid.UUID, role: str) -> dict[str, str]:
    """A signed-in user with ``role`` (session cookie headers)."""
    async with tenant_session(tenant_id) as s:
        user = await create_user(s, f"{role}-{uuid.uuid4().hex[:8]}@example.com", "pw")
        user.role = role
        await s.commit()
    return {"Cookie": f"{get_settings().session_cookie_name}={make_session_cookie(user)}"}


async def role_token(tenant_id: uuid.UUID, role: str) -> str:
    """A raw API token (not tied to a user) carrying ``role``."""
    async with tenant_session(tenant_id) as s:
        token, raw = await create_api_token(s, f"legacy-{role}")
        token.role = role
        await s.commit()
    return raw


async def add_feedback(
    tenant_id: uuid.UUID,
    document_id: str,
    ids: tuple[uuid.UUID, ...] = (FEEDBACK_ADDRESSED, FEEDBACK_DECLINED),
) -> None:
    """The open feedback items legacy_prd_v2.md resolves (by default its own two ids)."""
    async with tenant_session(tenant_id) as s:
        for fid in ids:
            s.add(
                FeedbackItem(
                    id=fid,
                    document_id=uuid.UUID(document_id),
                    raised_on_version=1,
                    kind="general",
                    summary="Legacy reviewer note",
                )
            )
        await s.commit()


class _AsgiBridge(httpx.BaseTransport):
    """A sync transport for the CLI that forwards each request to the async test client
    on the test's event loop (the CLI runs in a worker thread meanwhile)."""

    def __init__(self, client: httpx.AsyncClient, loop: asyncio.AbstractEventLoop):
        self.client = client
        self.loop = loop

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        async def forward() -> httpx.Response:
            resp = await self.client.request(
                request.method,
                request.url.raw_path.decode(),
                content=request.read(),
                headers={k: v for k, v in request.headers.items() if k.lower() != "host"},
            )
            return httpx.Response(resp.status_code, headers=resp.headers, content=resp.content)

        return asyncio.run_coroutine_threadsafe(forward(), self.loop).result(timeout=60)


async def run_cli(client: httpx.AsyncClient, argv: list[str], token: str) -> tuple[int, str, str]:
    """Run ``oracle <argv>`` against the in-process app; returns (code, stdout, stderr)."""
    out, err = io.StringIO(), io.StringIO()
    bridge = _AsgiBridge(client, asyncio.get_running_loop())
    argv = [*argv, "--url", "http://test", "--token", token]
    code = await asyncio.to_thread(cli_main, argv, transport=bridge, out=out, err=err)
    return code, out.getvalue(), err.getvalue()


@asynccontextmanager
async def mcp_session(token: str):
    from oracle.main import app

    http = httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=app),
        base_url="http://test",
        headers={"Authorization": f"Bearer {token}"},
    )
    async with (
        http,
        Client(streamable_http_client("http://test/mcp", http_client=http), mode="legacy") as c,
    ):
        yield c
