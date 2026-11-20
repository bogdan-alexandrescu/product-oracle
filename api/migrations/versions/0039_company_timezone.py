"""One Company time zone (owner decision 2026-10-22)

The weekly alignment report has no time zone of its own any more: it reads the Company
time zone (``company_timezone``), as goals' "today" and the rituals do. A company whose
``alignment_report`` setting holds a ``timezone`` gets it as its ``company_timezone``
when it has none yet, and the report's value loses the key.

Rituals have no zone of their own either (owner decision 2026-10-22, one zone): a ritual
stored in another zone than the Company time zone (America/Los_Angeles when none is
set, the default from the same day) moves to it, with its next date recomputed there.

The downgrade gives every stored ``alignment_report`` the company's zone back
(America/Los_Angeles when none is set); ``company_timezone`` stays (0031_rituals'
downgrade drops it), and so do the rituals' zones (each is a valid schedule).

The next date is worked out here, frozen as oracle.rituals.schedule.next_occurrence was at
this revision (#1575), so a later change to the app does not change this migration.

Revision ID: 0039_company_timezone
Revises: 0038_outcome_tracking
"""

import json
from calendar import monthrange
from collections.abc import Sequence
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import sqlalchemy as sa
from alembic import op

revision: str = "0039_company_timezone"
down_revision: str | None = "0038_outcome_tracking"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The Company time zone of a company that never set one, as of this revision.
DEFAULT_ZONE = "America/Los_Angeles"
# A Monday: week 0 of every every_n_weeks series.
EPOCH = date(2024, 1, 1)
# A stored schedule's defaults, as of this revision.
RULE = {"interval": 1, "weekday": 0, "week_of_month": 1, "month": 1, "time": "09:00"}


def _at(day: date, s: dict[str, Any]) -> datetime:
    h, m = s["time"].split(":")
    at = datetime.combine(day, time(int(h), int(m)), tzinfo=ZoneInfo(s["timezone"]))
    return at.astimezone(UTC)


def _nth_weekday(year: int, month: int, weekday: int, nth: int) -> date:
    days = monthrange(year, month)[1]
    if nth == -1:
        last = date(year, month, days)
        return last - timedelta(days=(last.weekday() - weekday) % 7)
    first = date(year, month, 1)
    return first + timedelta(days=(weekday - first.weekday()) % 7 + 7 * (nth - 1))


def _months(s: dict[str, Any]) -> set[int]:
    if s["freq"] == "monthly":
        return set(range(1, 13))
    if s["freq"] == "quarterly":
        return {s["month"] + 3 * q for q in range(4)}
    return {s["month"]}


def _next_occurrence(schedule: dict[str, Any], after: datetime) -> datetime:
    """The first due time of ``schedule`` strictly after ``after`` (UTC)."""
    s = {**RULE, "timezone": DEFAULT_ZONE, **schedule}
    local = after.astimezone(ZoneInfo(s["timezone"])).date()
    if s["freq"] in ("weekly", "every_n_weeks"):
        step = s["interval"] if s["freq"] == "every_n_weeks" else 1
        day = local - timedelta(days=1)
        for _ in range(7 * step + 8):
            if day.weekday() == s["weekday"] and ((day - EPOCH).days // 7) % step == 0:
                at = _at(day, s)
                if at > after:
                    return at
            day += timedelta(days=1)
    else:
        months = _months(s)
        year, month = local.year, local.month - 1
        if month == 0:
            year, month = year - 1, 12
        for _ in range(26):
            if month in months:
                at = _at(_nth_weekday(year, month, s["weekday"], s["week_of_month"]), s)
                if at > after:
                    return at
            year, month = (year + 1, 1) if month == 12 else (year, month + 1)
    raise ValueError("no next occurrence")  # pragma: no cover - every rule repeats


def upgrade() -> None:
    op.execute(
        """
        INSERT INTO tenant_settings (id, tenant_id, key, value)
        SELECT gen_random_uuid(), r.tenant_id, 'company_timezone', r.value -> 'timezone'
        FROM tenant_settings r
        WHERE r.key = 'alignment_report'
          AND jsonb_typeof(r.value -> 'timezone') = 'string'
          AND NOT EXISTS (
              SELECT 1 FROM tenant_settings c
              WHERE c.tenant_id = r.tenant_id AND c.key = 'company_timezone'
          )
        """
    )
    op.execute(
        "UPDATE tenant_settings SET value = value - 'timezone' "
        "WHERE key = 'alignment_report' AND value -> 'timezone' IS NOT NULL"
    )
    _rituals_on_the_company_zone()


def _rituals_on_the_company_zone() -> None:
    conn = op.get_bind()
    rows = conn.execute(
        sa.text(
            """
            SELECT r.id, r.schedule, r.status, z.zone
            FROM rituals r
            CROSS JOIN LATERAL (
                SELECT COALESCE(
                    (SELECT c.value #>> '{}' FROM tenant_settings c
                     WHERE c.tenant_id = r.tenant_id AND c.key = 'company_timezone'),
                    :default
                ) AS zone
            ) z
            WHERE r.schedule ->> 'timezone' IS DISTINCT FROM z.zone
            """
        ),
        {"default": DEFAULT_ZONE},
    ).all()
    now = datetime.now(UTC)
    for ritual_id, schedule, status, zone in rows:
        moved = {**schedule, "timezone": zone}
        conn.execute(
            sa.text(
                "UPDATE rituals SET schedule = CAST(:s AS jsonb), next_due_at = :n, "
                "lock_version = lock_version + 1 WHERE id = :id"
            ),
            {
                "s": json.dumps(moved),
                "n": _next_occurrence(moved, now) if status == "active" else None,
                "id": ritual_id,
            },
        )


def downgrade() -> None:
    op.execute(
        """
        UPDATE tenant_settings r
        SET value = r.value || jsonb_build_object('timezone', COALESCE(
            (SELECT c.value FROM tenant_settings c
             WHERE c.tenant_id = r.tenant_id AND c.key = 'company_timezone'),
            '"America/Los_Angeles"'::jsonb))
        WHERE r.key = 'alignment_report'
        """
    )
