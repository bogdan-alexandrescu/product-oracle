"""Fresh database for the real-stack E2E: drop + create, migrate, seed.

Run from api/ with its environment (``uv run python ../web/e2e/real/reset_stack.py``).
Reads ORACLE_DATABASE_URL (the E2E database, dropped on every run) and writes the
admin credentials and a new API token to E2E_STATE_FILE for the spec to read.
"""

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import asyncpg
from sqlalchemy.engine import make_url


async def recreate(url: str) -> None:
    u = make_url(url)
    if not u.database or "e2e" not in u.database:
        sys.exit(f"refusing to drop {u.database!r}: the E2E database name must contain 'e2e'")
    conn = await asyncpg.connect(
        host=u.host, port=u.port or 5432, user=u.username, password=u.password, database="postgres"
    )
    try:
        await conn.execute(f'DROP DATABASE IF EXISTS "{u.database}" WITH (FORCE)')
        await conn.execute(f'CREATE DATABASE "{u.database}"')
    finally:
        await conn.close()


async def main() -> None:
    url = os.environ["ORACLE_DATABASE_URL"]
    state_file = Path(os.environ["E2E_STATE_FILE"])
    await recreate(url)
    subprocess.run(["alembic", "upgrade", "head"], check=True)

    from oracle.db import dispose_engine
    from oracle.seed import seed

    try:
        r = await seed(token_name="e2e")  # fresh database: generates the password
    finally:
        await dispose_engine()
    state_file.parent.mkdir(parents=True, exist_ok=True)
    state_file.write_text(
        json.dumps({"email": r.user_email, "password": r.password, "token": r.token}) + "\n"
    )
    print(f"e2e: fresh database {make_url(url).database}, state in {state_file}")


if __name__ == "__main__":
    asyncio.run(main())
