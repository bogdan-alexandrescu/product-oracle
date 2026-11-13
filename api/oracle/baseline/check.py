"""The Ground Truth check (docs/ground-truth.md; the owner, Nov 5: "Flag it, don't refuse").

The Ground Truth is the baseline graph (internal names keep "baseline"). Its features are the
confirmed ``feature`` entities not in Trash: a run only proposes, an approver confirms. Every
roadmap item is a Ground Truth feature or a slice of one, and a PRD's features are Ground
Truth entries by code. Anything that breaks this is allowed (no save is refused) and listed
here, each flag with one plain sentence and the fixes a person can make in the UI:

- ``unlinked_item``: a roadmap item linked to no Ground Truth feature (none, or one a run
  only proposed: then "Confirm it" confirms that feature, beside "Link to a feature"); an
  item linked to none whose own code (F-02) or whose slice's feature (F-15 of F-15a) is a
  Ground Truth feature's code is in it, by code, and not flagged;
- ``slice_parent_missing``: a roadmap slice item (section F-15a, or an item of a PRD feature
  over several milestones) linked to no feature, whose feature (F-15) is not in the Ground
  Truth; one flagged as ``prd_feature_missing`` already is an ``unlinked_item`` instead, so
  one missing feature is one flag of its own however many milestones it spans;
- ``prd_feature_missing``: a feature of a PRD's approved version not in the Ground Truth, by
  code only (a feature with no code is flagged too; one with the name of a Ground Truth
  feature carries it as a hint, "Same name as F-05 Bulk import.");
- ``no_code``: a Ground Truth feature with no F-code;
- ``code_differs``: a feature keyed by the next number as it was confirmed while its own code
  (its Code attribute, else its roadmap item's or PRD feature's) is another, fixed by Use its
  code (``oracle.baseline.fixes.use_own_code``); when that code is a roadmap item's and another
  feature has it, by Link to a feature on that item instead; a slice (F-35a) is never flagged;
- ``no_goal``: a Ground Truth feature serving no confirmed goal by a confirmed link;
- ``runs_today_on_roadmap``: a feature running today (Current state) still on the roadmap,
  its own feature or the one it matches by code (F-03, F-03a), fixed by taking it off the
  roadmap (an item can also be an ``unlinked_item``).

Codes read one way: "f-1", "F-001" and 1 are F-01; a negative or malformed number is no code.

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

from oracle.baseline.models import Edge, Entity, EntityRevision
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

# A feature's F-code (F-12; a clash reads F-12.2; a slice F-12a).
F_CODE = re.compile(r"[A-Z]{1,3}-\d+(?:\.\d+)?[a-j]?")
# A slice's PRD section (f-15a: the first slice of F-15).
SLICE_SECTION = re.compile(r"([a-z]{1,3})-(\d+)([a-j])", re.IGNORECASE)
LETTERS = "abcdefghij"
# A code to read one way (f-1, F-01, F-12.2).
CODE = re.compile(r"([a-z]{1,3})-(\d+)((?:\.\d+)?)", re.IGNORECASE)
# Plan states that take an item off the plan (oracle.simple.approved_roadmap).
OFF_PLAN = ("shipped", "next_prd")

WORDS = {
    "unlinked_item": "This roadmap item is not a feature in the Ground Truth.",
    "slice_parent_missing": "This slice's feature is not in the Ground Truth.",
    "prd_feature_missing": "This PRD's feature is not in the Ground Truth.",
    "no_code": "This feature has no feature code yet.",
    "code_differs": "This feature's code is not the one its item or PRD gives it.",
    "no_goal": "This feature serves no goal.",
    "runs_today_on_roadmap": "This feature runs today but is still on the roadmap.",
}
# Each fix's button.
FIX_WORDS = {
    "add_to_ground_truth": "Add to Ground Truth",
    "link_to_feature": "Link to a feature",
    "confirm_feature": "Confirm it",
    "give_code": "Give it a code",
    "use_code": "Use its code",
    "pick_goal": "Pick a goal",
    "take_off_roadmap": "Take it off the roadmap",
}


def _code(raw: str | None) -> str | None:
    """A code read one way, its number two digits at least ("f-1", "F-001" read "F-01";
    F-12.2 keeps its clash suffix), None for no code ("problem")."""
    m = CODE.fullmatch((raw or "").strip())
    return f"{m.group(1).upper()}-{int(m.group(2)):02d}{m.group(3)}" if m else None


def _plan_code(raw: Any) -> str:
    """A PRD plan feature's code as an F-code ("f-15", "F-015" and 15 read "F-15"), "" for
    none or a number that is no code (-3, "3.5")."""
    if isinstance(raw, int) and not isinstance(raw, bool):
        return f"F-{raw:02d}" if raw >= 0 else ""
    code = raw.strip() if isinstance(raw, str) else ""
    if code.isdigit():
        return f"F-{int(code):02d}"
    if not any(c.isalpha() for c in code):
        return ""
    return _code(code) or code


def whole_code(raw: Any) -> str | None:
    """A code as a feature is keyed by it: a slice's letter dropped (f-07a reads F-07), None
    for no code."""
    if m := SLICE_SECTION.fullmatch(str(raw or "").strip()):
        return f"{m.group(1).upper()}-{int(m.group(2)):02d}"
    code = _plan_code(raw) if raw is not None else ""
    return code if re.fullmatch(r"[A-Z]{1,3}-\d+", code) else None


def own_code(feature: Entity, tied: set[str] | None) -> str | None:
    """The code ``feature`` is keyed by when no other feature has it: its own Code attribute,
    else the one code of the roadmap items and PRD features tied to it (``tied``)."""
    if own := whole_code((feature.attrs or {}).get("code")):
        return own
    return next(iter(tied)) if tied and len(tied) == 1 else None


def _tied(
    items: list[RoadmapItem],
    feature_of: dict[uuid.UUID, uuid.UUID | None],
    plans: list[tuple[Document, dict[str, Any]]],
    ids: set[uuid.UUID],
) -> dict[uuid.UUID, set[str]]:
    """{feature id: the codes of the roadmap items linked to it and the PRD features linked to
    it}, a slice's letter dropped."""
    out: dict[uuid.UUID, set[str]] = {}
    for i in items:
        if (fid := feature_of.get(i.id)) in ids and (c := whole_code(i.prd_section_key)):
            out.setdefault(fid, set()).add(c)  # type: ignore[arg-type]
    for _, data in plans:
        for raw, to in (data.get("links") or {}).items():
            if (fid := _uuid(to)) in ids and (c := whole_code(raw)):
                out.setdefault(fid, set()).add(c)  # type: ignore[arg-type]
    return out


async def tied_codes(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, set[str]]:
    """:func:`_tied` read from the roadmap every reader is shown and the PRDs' plans."""
    from oracle.simple import drafts

    items, _ = await _roadmap_items(db)
    effective = await drafts.effective(db, items)
    feature_of = {i.id: effective[str(i.id)].feature_id for i in items}
    return _tied(items, feature_of, await _prd_plans(db), ids)


def _uuid(raw: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(raw))
    except ValueError:
        return None


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
    from oracle.simple.priorities import _short_codes

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
    # An item's feature as its roadmap's working draft has it: Add to Ground Truth and Link to
    # a feature set it there (a set_feature change), so a published item's link rides the
    # next version and its flag goes at once.
    from oracle.simple import drafts

    effective = await drafts.effective(db, items)
    feature_of = {i.id: effective[str(i.id)].feature_id for i in items}
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

    # A PRD's features, by code only (a slice's code, F-12a, as stored).
    truth_of = {(_code(c) or c): f for f in truth if (c := code_of.get(f.id))}
    truth_codes = set(truth_of)
    same_name: dict[str, Entity] = {}
    for f in truth:
        same_name.setdefault(f.title.strip().casefold(), f)
    plans = await _prd_plans(db)
    spans: dict[tuple[uuid.UUID, str], int] = {}
    missing: set[tuple[uuid.UUID, str]] = set()
    goals = {
        g.title.strip().casefold(): g
        for g in await db.scalars(
            select(Entity).where(Entity.type == "goal", Entity.status != "rejected")
        )
    }

    def goal_of(f: dict[str, Any], data: dict[str, Any]) -> GroundTruthRef | None:
        """The goal the PRD gives a feature: its own, else the plan's one goal."""
        named = f.get("goal") or ((data.get("goals") or [None])[0]
                                  if len(data.get("goals") or []) == 1 else None)  # fmt: skip
        g = goals.get(str(named).strip().casefold()) if isinstance(named, str) else None
        return GroundTruthRef(id=g.id, code=None, name=g.title) if g is not None else None

    # A PRD's feature linked to a Ground Truth feature (Link to a feature,
    # oracle.baseline.fixes) is that feature: neither it nor its items are flagged.
    linked: dict[tuple[uuid.UUID, str], Entity] = {}
    for prd, data in plans:
        links = data.get("links") or {}
        roadmap = roadmap_of_prd.get(prd.id) or (active if active in roadmaps.values() else None)
        for f in data.get("features") or []:
            if not isinstance(f, dict):
                continue
            raw = str(f.get("code") or "").strip()
            code = _plan_code(f.get("code"))
            name = str(f.get("name") or "").strip() or code
            if code:
                spans[(prd.id, code)] = len([m for m in f.get("milestones") or [] if m])
            if not name or code in truth_codes:
                continue
            to = by_id.get(_uuid(links.get(raw, links.get(code))))  # type: ignore[arg-type]
            if to is not None and to.id in truth_ids:
                if code:
                    linked[(prd.id, code)] = to
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
                goal=goal_of(f, data),
                where=GroundTruthWhere(roadmap=_doc(roadmap), prd=_doc(prd)),
                hint=f"{hint}." if hint else None,
                like=ref(like) if like is not None else None,
            )

    # Each roadmap slice item: its code (F-15a) and its feature's (F-15). An item of a PRD
    # feature over several milestones takes the next letter no slice item has (F-15c after
    # an F-15b item).
    slice_of: dict[uuid.UUID, tuple[str, str]] = {}
    taken: dict[tuple[uuid.UUID | None, str], set[str]] = {}
    for i in items:
        if m := SLICE_SECTION.fullmatch((i.prd_section_key or "").strip()):
            parent = f"{m.group(1).upper()}-{int(m.group(2)):02d}"
            slice_of[i.id] = (f"{parent}{m.group(3).lower()}", parent)
            taken.setdefault((i.prd_document_id, parent), set()).add(m.group(3).lower())
    for i in items:
        code = _code(i.prd_section_key)
        key = (i.prd_document_id, code or "")
        if code and spans.get(key, 0) > 1:  # type: ignore[arg-type]
            used = taken.setdefault(key, set())
            letter = next((x for x in LETTERS if x not in used), LETTERS[-1])
            used.add(letter)
            slice_of[i.id] = (f"{code}{letter}", code)

    def item_ref(i: RoadmapItem) -> GroundTruthRef:
        code = slice_of[i.id][0] if i.id in slice_of else _code(i.prd_section_key)
        return GroundTruthRef(id=i.id, code=code, name=i.title)

    # The feature of each item linked to none, by code: its own (F-02) or its slice's (F-15).
    by_code: dict[uuid.UUID, Entity] = {}
    for i in items:
        if by_id.get(feature_of[i.id]) is None:  # type: ignore[arg-type]
            parent = slice_of[i.id][1] if i.id in slice_of else None
            for code in (item_ref(i).code, parent):
                if code in truth_of or (i.prd_document_id, code) in linked:
                    by_code[i.id] = truth_of.get(code) or linked[(i.prd_document_id, code)]  # type: ignore[index]
                    break

    for i in items:
        if feature_of[i.id] in truth_ids or i.id in by_code:
            continue
        own = by_id.get(feature_of[i.id]) if feature_of[i.id] is not None else None
        target = str(i.id)
        parent = slice_of[i.id][1] if i.id in slice_of else None
        if (
            own is None
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
            ("confirm_feature", str(own.id))
            if own is not None and own.status == "proposed"
            else ("add_to_ground_truth", target)
        )
        flag(
            "unlinked_item",
            [first, ("link_to_feature", target)],
            item=item_ref(i),
            feature=ref(own) if own is not None else None,
            where=where_of(i),
        )

    for f in truth:
        if f.id not in code_of:
            flag("no_code", [("give_code", str(f.id))], feature=ref(f), where=GroundTruthWhere())

    # Keyed by the next number as it was confirmed (its confirm changed its key), while its own
    # code is another: Use its code re-keys it.
    joined = {
        (i, k)
        for i, k in (
            await db.execute(
                select(EntityRevision.entity_id, EntityRevision.after["key"].astext).where(
                    EntityRevision.entity_id.in_(truth_ids),
                    EntityRevision.before["status"].astext == "proposed",
                    EntityRevision.after["status"].astext == "confirmed",
                    EntityRevision.before["key"].astext != EntityRevision.after["key"].astext,
                )
            )
        ).all()
    }
    tied = _tied(items, feature_of, plans, truth_ids)
    held: dict[str, uuid.UUID] | None = None
    for f in truth:
        if (f.id, f.key) not in joined or f.id not in code_of:
            continue
        # A slice reads its feature's code with its letter (F-35a): no code of its own.
        if (up := by_id.get(f.parent_id)) is not None and up.type == "feature":  # type: ignore[arg-type]
            continue
        want = own_code(f, tied.get(f.id))
        if not want or want == whole_code(code_of[f.id]):
            continue
        if held is None:
            from oracle.baseline.fixes import canonical_code, former_keys

            held = {(canonical_code(k) or k): i for k, i in (await former_keys(db)).items()}
            held |= {(_code(c) or c): i for i, c in code_of.items()}
        # Its item's code is another feature's (a duplicate): link the item to that feature.
        mine = whole_code((f.attrs or {}).get("code")) is None
        dup = held.get(want) not in (None, f.id)
        on = None
        if mine and dup:
            on = next(
                (i for i in items
                 if feature_of[i.id] == f.id and whole_code(i.prd_section_key) == want),
                None,
            )  # fmt: skip
        if on is not None:
            flag("code_differs", [("link_to_feature", str(on.id))], item=item_ref(on),
                 feature=ref(f), where=where_of(on))  # fmt: skip
        else:
            flag(
                "code_differs", [("use_code", str(f.id))], feature=ref(f), where=GroundTruthWhere()
            )

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
        # Its own feature, else the one it matches by code.
        fid = (
            feature_of[i.id]
            if feature_of[i.id] in by_id
            else by_code[i.id].id
            if i.id in by_code
            else None
        )
        if fid in running:
            flag(
                "runs_today_on_roadmap",
                [("take_off_roadmap", str(i.id))],
                item=item_ref(i),
                feature=ref(by_id[fid]),  # type: ignore[index]
                where=where_of(i),
            )

    out = [f for k in CHECK_KINDS for f in flags[k]]
    return GroundTruthOut(flags=out, counts={k: len(flags[k]) for k in CHECK_KINDS}, total=len(out))
