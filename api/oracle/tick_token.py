"""Mint the scheduler's tick token: an API token with the ``tick`` scope.

    python -m oracle.tick_token [--name scheduler-tick] [--tenant <company id>]

A tick token runs ``POST /v1/internal/tick`` (``oracle tick``) for its company and
nothing else: every other route refuses it with 403, the MCP server does not accept it,
and it acts for no member, with no role beyond reading. Give it to whatever calls the
tick on a schedule (``ORACLE_API_TOKEN`` for ``oracle tick``) instead of an owner's
token. The raw token is printed once; only its hash is stored. Revoke it like any token
(``DELETE /v1/api-tokens/{id}``, or Settings > Members > API tokens).

Without ``--tenant`` the first company is used (a single-company install).
"""

import argparse
import asyncio
import uuid

from sqlalchemy import select

from oracle.auth.service import create_api_token
from oracle.db import dispose_engine
from oracle.models import Tenant
from oracle.tenancy import tenant_session, unscoped_session


async def mint(name: str = "scheduler-tick", tenant_id: uuid.UUID | None = None) -> str:
    """Create a tick-scoped token in ``tenant_id`` (default the first company); returns
    the raw token."""
    if tenant_id is None:
        async with unscoped_session() as s:
            tenant_id = await s.scalar(select(Tenant.id).order_by(Tenant.created_at).limit(1))
        if tenant_id is None:
            raise SystemExit("no company yet: run python -m oracle.seed first")
    async with tenant_session(tenant_id) as s:
        _, raw = await create_api_token(s, name, scope="tick")
        await s.commit()
    return raw


async def _main(args: argparse.Namespace) -> None:
    try:
        raw = await mint(args.name, uuid.UUID(args.tenant) if args.tenant else None)
    finally:
        await dispose_engine()
    print(
        f"Tick token '{args.name}' (runs POST /v1/internal/tick only; shown once, only its "
        f"hash is kept):\n  export ORACLE_API_TOKEN={raw}"
    )


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    p.add_argument("--name", default="scheduler-tick")
    p.add_argument("--tenant", default=None, help="the company's id (default: the first)")
    asyncio.run(_main(p.parse_args()))


if __name__ == "__main__":
    main()
