"""Typed goal fields and dated measurements (B5)

New table ``goal_measurements`` (oracle.baseline.models.GoalMeasurement): a goal's value
on a day, one row per goal per day. Data step: on every goal, each of ``target``,
``start``, ``current``, ``current_as_of``, ``horizon``, ``due``, ``owner``, ``weight``,
``unit`` and ``comparison`` whose value does not fit the typed shape
(oracle.baseline.goals) moves to ``<key>_text`` ("45%" -> ``target_text``); a valid
``metric`` stays. Then what the checks across fields refuse moves too, so every goal can
be saved again: a ``current_as_of`` in the future, a ``current`` without its day, a
negative percentage, a ``target``, ``unit`` or ``comparison`` set without the other two,
and a ``metric`` that is not 3 to 200 characters. No goal is unlocked,
confirmed or rejected.

Additive and short: one UPDATE per changed goal. A lock that cannot be had within a few
seconds fails the migration instead of queueing readers behind it.

The downgrade writes each ``<key>_text`` back to ``<key>`` when ``<key>`` is absent (a
number moved as text goes back as the number) and drops the ``_text`` key, then drops
the table (measurements recorded since are lost; export them first with
``GET /v1/baseline/entities/{id}/measurements``).

Revision ID: 0025_goal_fields
Revises: 0024_segment_skipped
"""

import json
import math
import re
import uuid
from collections.abc import Sequence
from datetime import date

import sqlalchemy as sa
from alembic import op

revision: str = "0025_goal_fields"
down_revision: str | None = "0024_segment_skipped"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "goal_measurements"
LOCK_TIMEOUT = "5s"
# Frozen here as of this revision (oracle.baseline.goals).
KEYS = (
    "target", "start", "current", "current_as_of", "horizon", "due", "owner", "weight", "unit",
    "comparison", "metric",
)  # fmt: skip
NUMBERS = ("target", "start", "current", "weight")
TARGET = ("target", "unit", "comparison")
UNITS = ("%", "USD", "EUR", "GBP", "ms", "s", "min", "h", "days")
NOUN = re.compile(r"[a-z][a-z -]{0,23}")


def _lock_timeout(value: str) -> str:
    bind = op.get_bind()
    before = bind.scalar(sa.text("SELECT current_setting('lock_timeout')"))
    bind.execute(sa.text("SELECT set_config('lock_timeout', :t, true)"), {"t": value})
    return before


def _number(v) -> bool:
    return isinstance(v, int | float) and not isinstance(v, bool) and math.isfinite(v)


def _iso(v) -> bool:
    try:
        return isinstance(v, str) and len(v) == 10 and bool(date.fromisoformat(v))
    except ValueError:
        return False


def _uuid(v) -> bool:
    try:
        return isinstance(v, str) and bool(uuid.UUID(v))
    except ValueError:
        return False


def _fits(key: str, v, members: set[str]) -> bool:
    if key in ("target", "start", "current"):
        return _number(v)
    if key == "weight":
        return _number(v) and 0 < v <= 10
    if key in ("current_as_of", "due"):
        return _iso(v)
    if key == "horizon":
        return v in ("short", "medium", "long")
    if key == "comparison":
        return v in ("at_least", "above", "at_most", "below")
    if key == "unit":
        return isinstance(v, str) and (v in UNITS or bool(NOUN.fullmatch(v)))
    if key == "metric":
        return isinstance(v, str) and 3 <= len(v.strip()) <= 200
    return _uuid(v) and v in members  # owner


def _refused_together(attrs: dict, today: date) -> list[str]:
    """The keys the checks across fields refuse, once every key fits on its own."""
    out: list[str] = []
    as_of = attrs.get("current_as_of")
    if as_of is not None and date.fromisoformat(as_of) > today:
        out.append("current_as_of")
    if attrs.get("current") is not None and (attrs.get("current_as_of") is None or out):
        out.append("current")
    if attrs.get("unit") == "%":
        out += [k for k in ("target", "start", "current") if _number(attrs.get(k)) and attrs[k] < 0]
    left = [k for k in TARGET if attrs.get(k) is not None and k not in out]
    if 0 < len(left) < len(TARGET):
        out += left
    return list(dict.fromkeys(out))


def _text(v) -> str:
    return v if isinstance(v, str) else json.dumps(v)


def _restored(key: str, text: str):
    """A ``<key>_text`` value as the downgrade writes it back: a number moved as text goes
    back as the number."""
    if key in NUMBERS:
        try:
            v = json.loads(text)
        except ValueError:
            return text
        if _number(v):
            return v
    return text


def upgrade() -> None:
    before = _lock_timeout(LOCK_TIMEOUT)
    op.create_table(
        TABLE,
        sa.Column("entity_id", sa.Uuid(), nullable=False),
        sa.Column("value", sa.Numeric(20, 6), nullable=False),
        sa.Column("measured_on", sa.Date(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("evidence_id", sa.Uuid(), nullable=True),
        sa.Column("recorded_by", sa.Uuid(), nullable=True),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["entity_id"],
            ["entities.id"],
            name=op.f("fk_goal_measurements_entity_id_entities"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["evidence_id"],
            ["evidence.id"],
            name=op.f("fk_goal_measurements_evidence_id_evidence"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_goal_measurements_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_goal_measurements")),
        sa.UniqueConstraint(
            "entity_id", "measured_on", name=op.f("uq_goal_measurements_entity_id_measured_on")
        ),
    )
    op.create_index(op.f("ix_goal_measurements_tenant_id"), TABLE, ["tenant_id"])
    op.create_index(op.f("ix_goal_measurements_entity_id"), TABLE, ["entity_id"])

    bind = op.get_bind()
    members = {
        (str(t), str(u))
        for t, u in bind.execute(
            sa.text("SELECT tenant_id, id FROM users WHERE disabled_at IS NULL")
        ).all()
    }
    goals = bind.execute(
        sa.text("SELECT id, tenant_id, attrs FROM entities WHERE type = 'goal'")
    ).all()
    # A day ahead of UTC's, so a value measured today east of UTC stays typed.
    today = bind.scalar(sa.text("SELECT (now() AT TIME ZONE 'UTC')::date + 1"))
    for goal_id, tenant_id, attrs in goals:
        attrs = dict(attrs or {})
        own = {u for t, u in members if t == str(tenant_id)}
        moved = False
        for key in KEYS:
            if key in attrs and attrs[key] is not None and not _fits(key, attrs[key], own):
                attrs[f"{key}_text"] = _text(attrs.pop(key))
                moved = True
        for key in _refused_together(attrs, today):
            attrs[f"{key}_text"] = _text(attrs.pop(key))
            moved = True
        if moved:
            bind.execute(
                sa.text("UPDATE entities SET attrs = CAST(:a AS jsonb) WHERE id = :id"),
                {"a": json.dumps(attrs), "id": goal_id},
            )
    _lock_timeout(before)


def downgrade() -> None:
    before = _lock_timeout(LOCK_TIMEOUT)
    bind = op.get_bind()
    goals = bind.execute(sa.text("SELECT id, attrs FROM entities WHERE type = 'goal'")).all()
    for goal_id, attrs in goals:
        attrs = dict(attrs or {})
        changed = False
        for key in KEYS:
            text = attrs.pop(f"{key}_text", None)
            if text is None:
                continue
            changed = True
            if key not in attrs:
                attrs[key] = _restored(key, text)
        if changed:
            bind.execute(
                sa.text("UPDATE entities SET attrs = CAST(:a AS jsonb) WHERE id = :id"),
                {"a": json.dumps(attrs), "id": goal_id},
            )
    op.drop_index(op.f("ix_goal_measurements_entity_id"), table_name=TABLE)
    op.drop_index(op.f("ix_goal_measurements_tenant_id"), table_name=TABLE)
    op.drop_table(TABLE)
    _lock_timeout(before)
