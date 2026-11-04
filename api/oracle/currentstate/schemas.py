"""Current state's REST shapes (``/v1/feature-states``)."""

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel

Mark = Literal["new", "in_progress", "exists", "exists_old"]
ProofKind = Literal["code_map", "pull_requests", "tasks", "measured"]
Answer = Literal["still_runs", "changed", "no_longer_runs"]


class FeatureProofOut(BaseModel):
    kind: ProofKind
    count: int | None = None
    total: int | None = None
    # A measured value as a person reads it ("3,410 sent last month") and its month ("Sep").
    value: str | None = None
    period: str | None = None
    ok: bool
    still_true: bool | None = None
    checked_at: datetime | None = None
    # "not read yet": a measured value from a past month, not read for this one.
    note: str | None = None


class FeatureStateOut(BaseModel):
    feature_id: uuid.UUID
    # The feature's key.
    code: str
    title: str
    area: str | None = None
    goal: str | None = None
    milestone: str | None = None
    mark: Mark
    shipped_at: datetime | None = None
    checked_at: datetime | None = None
    # Whole days since the proof was last read; None when it never was.
    proof_days: int | None = None
    # Marked as existing (shipped or moved) with no proof read yet.
    no_proof_yet: bool
    # Every proof is in and the owner has not said Not yet since: ready to move.
    ready: bool
    checking: bool
    answer: Answer | None = None
    answered_at: datetime | None = None
    moved_at: datetime | None = None
    move_how: Literal["owner_confirmed", "marked_shipped"] | None = None
    proofs: list[FeatureProofOut]
    # The feature's roadmap items (a roadmap bar finds its feature's pill by these).
    item_ids: list[uuid.UUID] = []


class FeatureStatesOut(BaseModel):
    features: list[FeatureStateOut]
    # Counts: running (exists, old proof too), old_proof (exists_old), in_progress, new,
    # desired (in_progress + new) and ready.
    running: int
    old_proof: int
    in_progress: int
    new: int
    desired: int
    ready: int
    # The caller may move a feature (Move / Not yet) and answer "does it still run?".
    can_move: bool
    can_answer: bool


class FeatureAnswerIn(BaseModel):
    answer: Answer


class FeatureMoveIn(BaseModel):
    decision: Literal["move", "not_yet"]
