"""The Ground Truth check (docs/ground-truth.md; the owner, Nov 5: "Flag it, don't refuse").

The Ground Truth is the baseline graph (internal names keep "baseline"). Its features are the
confirmed ``feature`` entities not in Trash: a run only proposes, an approver confirms. Every
roadmap item is a Ground Truth feature or a slice of one, and a PRD's features are Ground
Truth entries by code. Anything that breaks this is allowed (no save is refused) and listed
here, each flag with one plain sentence and the fixes a person can make in the UI:

- ``unlinked_item``: a roadmap item linked to no Ground Truth feature (none, or one a run
  only proposed: then "Confirm it" confirms that feature, beside "Link to a feature");
- ``slice_parent_missing``: a roadmap slice item (section F-15a, or an item of a PRD feature
  over several milestones) linked to no feature, whose feature (F-15) is not in the Ground
  Truth; one flagged as ``prd_feature_missing`` already is an ``unlinked_item`` instead, so
  one missing feature is one flag of its own however many milestones it spans;
- ``prd_feature_missing``: a feature of a PRD's approved version not in the Ground Truth, by
  code only (a feature with no code is flagged too; one with the name of a Ground Truth
  feature carries it as a hint, "Same name as F-05 Bulk import.");
- ``no_code``: a Ground Truth feature with no F-code;
- ``no_goal``: a Ground Truth feature serving no confirmed goal by a confirmed link;
- ``runs_today_on_roadmap``: a feature running today (Current state) still on the roadmap,
  fixed by taking it off the roadmap (an item can also be an ``unlinked_item``).

"The roadmap" is what every reader is shown: the shown version of each company-visible
roadmap that feeds Simple (the company roadmap alone while there is one), less cut, shipped,
merged and taken-off items and the items of a replaced PRD. A PRD's features are those of
its approved version's plan (``simple_prd_plans``); slices as ``oracle.simple.plan``. Trash
is left out, as every read.
"""

import re
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.baseline.models import Edge, Entity
from oracle.baseline.schemas import (
    CHECK_KINDS,
    GroundTruthDoc,
    GroundTruthFix,
    GroundTruthFlag,
    GroundTruthOut,
    GroundTruthRef,
    GroundTruthWhere,
)
from oracle.currentstate.models import FeatureState
from oracle.currentstate.service import exists
from oracle.docs import visibility
from oracle.docs.models import Document, DocumentVersion
from oracle.roadmap import company
from oracle.roadmap.models import RoadmapItem
from oracle.simple.models import SimplePrdPlan

# A feature's F-code (F-12; a clash reads F-12.2).
F_CODE = re.compile(r"[A-Z]{1,3}-\d+(?:\.\d+)?")
# A slice's PRD section (f-15a: the first slice of F-15).
SLICE_SECTION = re.compile(r"([a-z]{1,3})-(\d+)([a-j])", re.IGNORECASE)
LETTERS = "abcdefghij"
# Plan states that take an item off the plan (oracle.simple.approved_roadmap).
OFF_PLAN = ("shipped", "next_prd")

WORDS = {
    "unlinked_item": "This roadmap item is not a feature in the Ground Truth.",
    "slice_parent_missing": "This slice's feature is not in the Ground Truth.",
    "prd_feature_missing": "This PRD's feature is not in the Ground Truth.",
    "no_code": "This feature has no feature code yet.",
    "no_goal": "This feature serves no goal.",
    "runs_today_on_roadmap": "This feature runs today but is still on the roadmap.",
}
# Each fix's button.
FIX_WORDS = {
    "add_to_ground_truth": "Add to Ground Truth",
    "link_to_feature": "Link to a feature",
    "confirm_feature": "Confirm it",
    "give_code": "Give it a code",
    "pick_goal": "Pick a goal",
    "take_off_roadmap": "Take it off the roadmap",
}


def _doc(d: Document | None) -> GroundTruthDoc | None:
    return GroundTruthDoc(id=d.id, title=d.title) if d is not None else None


async def _roadmap_items(db: AsyncSession) -> tuple[list[RoadmapItem], dict[uuid.UUID, Document]]:
    """The items every reader is shown on the roadmap, and the roadmaps by id."""
    from oracle.simple import drafts, service

    docs = {
        d.id: d
        for d in await db.scalars(
            select(Document).where(
                Document.kind == "roadmap", Document.visibility == visibility.COMPANY
            )
        )
    }
    feeding = await company.feeding_ids(db, list(docs))
    if not feeding:
        return [], {}
    versions = (
        await db.execute(
            select(
                DocumentVersion.id,
                DocumentVersion.document_id,
                DocumentVersion.number,
                DocumentVersion.approved_at,
            ).where(DocumentVersion.document_id.in_(feeding))
        )
    ).all()
    with_items = set(
        await db.scalars(
            select(RoadmapItem.roadmap_version_id)
            .where(RoadmapItem.roadmap_document_id.in_(feeding))
            .distinct()
        )
    )
    shown = service._versions(versions, with_items, await drafts.submitted_versions(db))
    if not shown:
        return [], {}
    replaced = await company.replaced_prd_ids(db)
    items = [
        i
        for i in await db.scalars(
            select(RoadmapItem)
            .where(RoadmapItem.roadmap_version_id.in_(list(shown.values())))
            .order_by(RoadmapItem.position, RoadmapItem.item_key)
        )
        if not i.cut
        and i.shipped is None
        and i.merged_into is None
        and i.plan_state not in OFF_PLAN
        and i.prd_document_id not in replaced
    ]
    return items, {i: docs[i] for i in shown}


async def _prd_plans(db: AsyncSession) -> list[tuple[Document, dict[str, Any]]]:
    """Each company-visible, not replaced PRD with the plan read from its approved version."""
    replaced = await company.replaced_prd_ids(db)
    rows = await db.execute(
        select(Document, SimplePrdPlan.data)
        .join(SimplePrdPlan, SimplePrdPlan.document_id == Document.id)
        .where(
            Document.kind == "prd",
            Document.visibility == visibility.COMPANY,
            SimplePrdPlan.status == "ready",
            SimplePrdPlan.version_id.is_not(None),
        )
        .order_by(Document.title)
    )
    return [(d, data or {}) for d, data in rows.all() if d.id not in replaced]


async def run(db: AsyncSession) -> GroundTruthOut:
    """Every flag in the company (the tenant session), in the order of ``CHECK_KINDS``."""
    from oracle.simple.priorities import _short_codes, prd_code

    features = list(
        await db.scalars(
            select(Entity).where(Entity.type == "feature").order_by(Entity.created_at, Entity.key)
        )
    )
    by_id = {f.id: f for f in features}
    truth = [f for f in features if f.status == "confirmed"]
    short = await _short_codes(db, names=False)
    code_of = {f.id: c for f in features if F_CODE.fullmatch(c := short.get(f.key, ""))}

    def ref(f: Entity) -> GroundTruthRef:
        return GroundTruthRef(id=f.id, code=code_of.get(f.id), name=f.title)

    items, roadmaps = await _roadmap_items(db)
    truth_ids = {f.id for f in truth}
    flags: dict[str, list[GroundTruthFlag]] = {k: [] for k in CHECK_KINDS}

    def flag(kind: str, fixes: list[tuple[str, str]], **kw: Any) -> None:
        flags[kind].append(
            GroundTruthFlag(
                kind=kind,  # type: ignore[arg-type]
                words=WORDS[kind],
                fixes=[
                    GroundTruthFix(action=a, target=t, words=FIX_WORDS[a])  # type: ignore[arg-type]
                    for a, t in fixes
                ],
                **kw,
            )
        )

    prd_docs: dict[uuid.UUID, Document] = {}
    if items:
        prd_ids = {i.prd_document_id for i in items if i.prd_document_id is not None}
        if prd_ids:
            prd_docs = {
                d.id: d for d in await db.scalars(select(Document).where(Document.id.in_(prd_ids)))
            }

    def where_of(i: RoadmapItem) -> GroundTruthWhere:
        return GroundTruthWhere(
            roadmap=_doc(roadmaps.get(i.roadmap_document_id)),  # type: ignore[arg-type]
            prd=_doc(prd_docs.get(i.prd_document_id)),  # type: ignore[arg-type]
        )

    # A PRD's roadmap: the company roadmap first, else by title (one stable pick).
    active = await company.active(db)
    active_id = active.id if active is not None else None
    roadmap_of_prd: dict[uuid.UUID | None, Document] = {}
    for d in sorted(
        {i.roadmap_document_id: roadmaps[i.roadmap_document_id] for i in items}.values(),
        key=lambda d: (d.id != active_id, d.title, str(d.id)),
    ):
        for i in items:
            if i.roadmap_document_id == d.id:
                roadmap_of_prd.setdefault(i.prd_document_id, d)

    # A PRD's features, by code only.
    truth_codes = {code_of[f.id] for f in truth if f.id in code_of}
    same_name: dict[str, Entity] = {}
    for f in truth:
        same_name.setdefault(f.title.strip().casefold(), f)
    plans = await _prd_plans(db)
    spans: dict[tuple[uuid.UUID, str], int] = {}
    missing: set[tuple[uuid.UUID, str]] = set()
    for prd, data in plans:
        roadmap = roadmap_of_prd.get(prd.id) or (active if active in roadmaps.values() else None)
        for f in data.get("features") or []:
            if not isinstance(f, dict):
                continue
            code = str(f.get("code") or "").strip()
            name = str(f.get("name") or "").strip() or code
            if code:
                spans[(prd.id, code)] = len([m for m in f.get("milestones") or [] if m])
            if not name or code in truth_codes:
                continue
            if code:
                missing.add((prd.id, code))
            like = same_name.get(name.casefold())
            hint = None
            if like is not None:
                hint = " ".join(x for x in ("Same name as", code_of.get(like.id), like.title) if x)
            flag(
                "prd_feature_missing",
                [("add_to_ground_truth", code or name), ("link_to_feature", code or name)],
                feature=GroundTruthRef(id=None, code=code or None, name=name),
                where=GroundTruthWhere(roadmap=_doc(roadmap), prd=_doc(prd)),
                hint=f"{hint}." if hint else None,
                like=ref(like) if like is not None else None,
            )

    # Each roadmap slice item: its code (F-15a) and its feature's (F-15).
    slice_of: dict[uuid.UUID, tuple[str, str]] = {}
    seen: dict[tuple[uuid.UUID | None, str], int] = {}
    for i in items:
        if m := SLICE_SECTION.fullmatch((i.prd_section_key or "").strip()):
            parent = f"{m.group(1).upper()}-{m.group(2)}"
            slice_of[i.id] = (f"{parent}{m.group(3).lower()}", parent)
        elif (code := prd_code(i.prd_section_key)) and spans.get(
            (i.prd_document_id, code),
            0,  # type: ignore[arg-type]
        ) > 1:
            n = seen[(i.prd_document_id, code)] = seen.get((i.prd_document_id, code), -1) + 1
            slice_of[i.id] = (f"{code}{LETTERS[min(n, len(LETTERS) - 1)]}", code)

    def item_ref(i: RoadmapItem) -> GroundTruthRef:
        code = slice_of[i.id][0] if i.id in slice_of else prd_code(i.prd_section_key)
        return GroundTruthRef(id=i.id, code=code, name=i.title)

    for i in items:
        if i.feature_id in truth_ids:
            continue
        linked = by_id.get(i.feature_id) if i.feature_id is not None else None
        target = str(i.id)
        parent = slice_of[i.id][1] if i.id in slice_of else None
        if (
            linked is None
            and parent is not None
            and parent not in truth_codes
            and (i.prd_document_id, parent) not in missing
        ):
            flag(
                "slice_parent_missing",
                [("add_to_ground_truth", parent), ("link_to_feature", target)],
                item=item_ref(i),
                where=where_of(i),
            )
            continue
        # Linked to a feature a run proposed: an approver confirms it (the owner, Nov 5).
        first = (
            ("confirm_feature", str(linked.id))
            if linked is not None and linked.status == "proposed"
            else ("add_to_ground_truth", target)
        )
        flag(
            "unlinked_item",
            [first, ("link_to_feature", target)],
            item=item_ref(i),
            feature=ref(linked) if linked is not None else None,
            where=where_of(i),
        )

    for f in truth:
        if f.id not in code_of:
            flag("no_code", [("give_code", str(f.id))], feature=ref(f), where=GroundTruthWhere())

    goals = set(
        await db.scalars(
            select(Entity.id).where(Entity.type == "goal", Entity.status == "confirmed")
        )
    )
    serving = set(
        await db.scalars(
            select(Edge.src_id).where(
                Edge.type == "supports",
                Edge.status == "confirmed",
                Edge.src_id.in_(truth_ids),
                Edge.dst_id.in_(goals),
            )
        )
    )
    for f in truth:
        if f.id not in serving:
            flag("no_goal", [("pick_goal", str(f.id))], feature=ref(f), where=GroundTruthWhere())

    running = {
        s.feature_id
        for s in await db.scalars(select(FeatureState).where(FeatureState.feature_id.in_(by_id)))
        if exists(s)
    }
    for i in items:
        if i.feature_id in running:
            flag(
                "runs_today_on_roadmap",
                [("take_off_roadmap", str(i.id))],
                item=item_ref(i),
                feature=ref(by_id[i.feature_id]),  # type: ignore[index]
                where=where_of(i),
            )

    out = [f for k in CHECK_KINDS for f in flags[k]]
    return GroundTruthOut(flags=out, counts={k: len(flags[k]) for k in CHECK_KINDS}, total=len(out))
