"""INT2 Intake analysis on SwarmCloud, lane 1: the intake_analysis flow and its scope

The ``intake_analysis`` flow joins ``runs.flow`` through ``oracle.migration_checks``
(other lanes' values survive), and ``read:intake-input`` joins the run-token scopes check
(the one run-bound read of an intake's analysis input, owner answer Q1). Queued
``llm_jobs`` of kind ``intake_analysis`` are cancelled as ``moved_to_swarmcloud``: the
tick starts a SwarmCloud read for their intakes (``oracle.intake.read.start_pending_reads``,
at most 20 per tick). The kind stays in the jobs' check, so past jobs stay readable, and
the job stays the fallback (owner answer Q3) and the rollback
(``ORACLE_INTAKE_READ_RUNTIME=job``). The ``intake_ai_read`` company setting needs no
schema: its default lives in ``oracle.tenant_settings_api.DEFAULTS``.

Live-safe: two check rewrites and one bounded update.

Downgrade: refuses while an intake_analysis run is not ended; deletes the ended ones and
any stored ``intake_ai_read`` setting, and narrows both checks. Cancelled jobs stay
cancelled (findings already imported stay: they are the job's shape).

Revision ID: 0055_intake_read
Revises: 0054_reply_opened
"""

from collections.abc import Sequence

from alembic import op
from sqlalchemy import text

from oracle.migration_checks import add_check_values, remove_check_values

revision: str = "0055_intake_read"
down_revision: str | None = "0054_reply_opened"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
FLOW_CHECK = ("runs", "ck_runs_flow", "flow", ("intake_analysis",))
SCOPES_BEFORE = (
    "read:sources",
    "read:baseline",
    "read:documents",
    "write:proposals",
    "write:drafts",
    "read:web",
)
LIVE = ("draft", "awaiting_approval", "running", "awaiting_checkpoint", "paused_overrun")


def _scopes_check(scopes: tuple[str, ...]) -> None:
    listed = ", ".join(f"'{s}'" for s in scopes)
    op.drop_constraint(op.f("ck_run_tokens_scopes"), "run_tokens", type_="check")
    op.create_check_constraint(
        op.f("ck_run_tokens_scopes"),
        "run_tokens",
        f"cardinality(scopes) > 0 AND scopes <@ ARRAY[{listed}]::text[]",
    )


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    add_check_values(*FLOW_CHECK)
    _scopes_check((*SCOPES_BEFORE, "read:intake-input"))
    op.get_bind().execute(
        text(
            "UPDATE llm_jobs SET status = 'cancelled', error_reason = 'moved_to_swarmcloud', "
            "finished_at = now() WHERE kind = 'intake_analysis' AND status = 'queued'"
        )
    )


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    bind = op.get_bind()
    live = bind.execute(
        text("SELECT count(*) FROM runs WHERE flow = 'intake_analysis' AND status = ANY(:s)"),
        {"s": list(LIVE)},
    ).scalar()
    if live:
        raise RuntimeError(f"{live} intake_analysis run(s) not ended; let them end first")
    tokens = bind.execute(
        text(
            "SELECT count(*) FROM run_tokens WHERE 'read:intake-input' = ANY(scopes) "
            "AND revoked_at IS NULL AND expires_at > now()"
        )
    ).scalar()
    if tokens:
        raise RuntimeError("a live run token holds read:intake-input; let it expire first")
    bind.execute(text("DELETE FROM run_tokens WHERE 'read:intake-input' = ANY(scopes)"))
    bind.execute(text("DELETE FROM runs WHERE flow = 'intake_analysis'"))
    bind.execute(text("DELETE FROM tenant_settings WHERE key = 'intake_ai_read'"))
    _scopes_check(SCOPES_BEFORE)
    remove_check_values(*FLOW_CHECK)
