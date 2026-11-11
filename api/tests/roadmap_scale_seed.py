"""roadmap-speed: one invented company at least the size of a real one, for the timing and
statement tests of the Simple roadmap read (tests/test_simple_roadmap_speed.py).

4 goals, 5 tracks, 25 PRDs (each with 4 approved versions and a plan: 2 milestones, 16
features), one company roadmap of 400 items (parts under parents, dependencies within and
across PRDs, typed, tracker and engineering dates, open date suggestions, tasks), 2,000
Ground Truth entities, 60 milestones (20 on tracks, 40 goal milestones), 1,500 changes and 30
members. Every name is made up.
"""

import hashlib
import itertools
import uuid
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import event

from oracle.auth.models import User
from oracle.baseline.models import Edge, Entity
from oracle.decisions.models import Decision
from oracle.docs.models import Document, DocumentVersion
from oracle.roadmap.models import (
    ProductTrack,
    RoadmapItem,
    ScheduleBasis,
    TrackerRecord,
    TrackMilestone,
    TrackPrd,
)
from oracle.simple import suggestions
from oracle.simple.models import RoadmapItemTask, SimpleChange
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx
from tests.conftest import make_tenant

NOW = datetime(2026, 11, 2, 20, 0, tzinfo=UTC)
GOALS, TRACKS, PRDS, PER_PRD, ENTITIES, CHANGES, MEMBERS = 4, 5, 25, 16, 2000, 1500, 30


def _plan(n: int, codes: list[str]) -> str:
    start = date(2026, 10, 5) + timedelta(weeks=n % 6)
    mid = start + timedelta(weeks=8)
    end = mid + timedelta(weeks=10)
    rows = []
    for i, code in enumerate(codes):
        m = (
            "[M1 Pilot](#milestone-m1)"
            if i == 0
            else ("[M2 Rollout](#milestone-m2)" if i == 8 else "")
        )
        rows.append(
            f"| {m} | [{code} Part {n}-{i}](#{code.lower()}) | Goal {n % GOALS} | Done {i} |"
        )
    filler = "\n".join(
        f"Paragraph {k} of plan {n}: example words about the work." for k in range(150)
    )
    day = mid + timedelta(days=1)

    def on(d: date) -> str:
        return f"{d:%b} {d.day}, {d.year}"

    return (
        f"# Product {n} PRD\n\n## Features by milestone {{#brief-items}}\n\n"
        "| Milestone | Feature | Goal | Outcome |\n|---|---|---|---|\n"
        + "\n".join(rows)
        + "\n\n## Milestones {#milestones}\n\n"
        + "| Milestone | Name | Start | End |\n|---|---|---|---|\n"
        + f"| M1 | Pilot | {on(start)} | {on(mid)} |\n"
        + f"| M2 | Rollout | {on(day)} | {on(end)} |\n\n"
        + filler
        + "\n"
    )


def _fixed_ids(s) -> None:
    """Every row the seed adds gets an id and times from a counter, not uuid4 and now(), so
    two runs read the same rows in the same order (the response's digest is pinned)."""
    counter = itertools.count(1)

    def before_flush(session, context, instances):
        for obj in session.new:
            n = next(counter)
            if getattr(obj, "id", 0) is None:
                obj.id = uuid.UUID(int=n)
            for col in ("created_at", "updated_at"):
                if hasattr(obj, col) and getattr(obj, col) is None:
                    setattr(obj, col, NOW - timedelta(days=60) + timedelta(seconds=n))

    event.listen(s.sync_session, "before_flush", before_flush)


async def seed_company() -> Ctx:
    """The company, its rows and its members (owner, approver, commenter and viewer first)."""
    ctx = Ctx(tenant_id=await make_tenant("Example Scale Co"))
    async with tenant_session(ctx.tenant_id) as s:
        _fixed_ids(s)

        async def add(row):
            s.add(row)
            await s.flush()
            return row

        members = []
        for role in ("owner", "approver", "commenter", "viewer"):
            ctx.users[role] = await add(
                User(email=f"{role}@example.com", password_hash="x", role=role)
            )
            members.append(ctx.users[role])
        for i in range(MEMBERS - len(members)):
            role = ("approver", "commenter", "viewer")[i % 3]
            members.append(
                await add(
                    User(
                        email=f"member{i}@example.com",
                        password_hash="x",
                        role=role,
                        name=f"Member {i}",
                    )
                )
            )
        goals = [
            await add(
                Entity(
                    type="goal",
                    key=f"goal-{g}",
                    title=f"Grow example metric {g}",
                    status="confirmed",
                    origin="user",
                    attrs={"target": "40%", "metric": f"Metric {g}", "due": "2027-06-30"},
                )
            )
            for g in range(GOALS)
        ]
        features: list[Entity] = []
        for n in range(ENTITIES):
            kind = (
                "feature"
                if n < 1600
                else ("requirement", "constraint", "decision", "product")[n % 4]
            )
            key = f"F-{100 + n}" if kind == "feature" else f"{kind}-{n}"
            e = Entity(
                type=kind,
                key=key,
                title=f"Example {kind} {n}",
                status="confirmed",
                origin="user",
                attrs={"effort": ("XS", "S", "M", "L")[n % 4]} if kind == "feature" else {},
            )
            s.add(e)
            if kind == "feature":
                features.append(e)
        await s.flush()
        for n, f in enumerate(features[:800]):
            s.add(
                Edge(
                    src_id=f.id,
                    dst_id=goals[n % GOALS].id,
                    type="supports",
                    status="confirmed",
                    origin="user",
                )
            )
        await s.flush()

        def body_version(doc: Document, number: int, markdown: str) -> DocumentVersion:
            return DocumentVersion(
                document_id=doc.id,
                number=number,
                markdown=markdown,
                content_hash=hashlib.sha256(markdown.encode()).hexdigest(),
                approved_at=datetime(2026, 9, 1, tzinfo=UTC) + timedelta(days=number),
            )

        roadmap = await add(
            Document(
                slug="company-roadmap",
                title="Company roadmap",
                kind="roadmap",
                status="approved",
                visibility="company",
                company_roadmap=True,
            )
        )
        rvs = [await add(body_version(roadmap, k, f"# Company roadmap v{k}\n")) for k in (1, 2, 3)]
        rv = rvs[-1]
        prds: list[tuple[Document, DocumentVersion, list[str]]] = []
        for p in range(PRDS):
            doc = await add(
                Document(
                    slug=f"product-{p}-prd",
                    title=f"Product {p} PRD",
                    kind="prd",
                    status="approved",
                    visibility="company",
                )
            )
            codes = [features[p * PER_PRD + i].key for i in range(PER_PRD)]
            pv = None
            for k in range(1, 5):
                pv = await add(body_version(doc, k, _plan(p, codes) + f"\nRevision {k}\n"))
            prds.append((doc, pv, codes))
        tracks = []
        for t in range(TRACKS):
            lead, lpv, _ = prds[t * 5]
            track = await add(
                ProductTrack(
                    id=uuid.UUID(int=900_000 + t),
                    prd_document_id=lead.id,
                    started_version_id=lpv.id,
                    current_version_id=lpv.id,
                    roadmap_document_id=roadmap.id,
                    title=f"Track {t}",
                    owner_id=members[1 + t].id,
                    goal_id=goals[t % GOALS].id,
                    position=t,
                )
            )
            tracks.append(track)
            for doc, _, _ in prds[t * 5 + 1 : (t + 1) * 5]:
                s.add(TrackPrd(prd_document_id=doc.id, track_id=track.id, state="linked"))
        await s.flush()
        items: list[RoadmapItem] = []
        olds: dict[tuple[int, str], RoadmapItem] = {}
        for p, (doc, pv, codes) in enumerate(prds):
            track = tracks[p // 5]
            for i, code in enumerate(codes):
                n = p * PER_PRD + i
                kw: dict = {
                    "horizon": ("now", "next", "later")[n % 3],
                    "confidence": ("low", "medium", "high")[n % 3],
                }
                deps = []
                if i and i % 8:
                    deps.append(codes[i - 1])
                if p and i == 3:
                    deps.append(prds[p - 1][2][5])  # another PRD's feature key
                if n % 4 == 0:
                    kw.update(
                        start_date=date(2026, 10, 1) + timedelta(days=n % 90),
                        end_date=date(2026, 11, 15) + timedelta(days=n % 120),
                        date_source="typed",
                    )
                if i in (2, 3, 10):
                    kw["parent_key"] = codes[i - 1]  # a part of the feature before it
                if n % 7 == 0:
                    kw["goal_ids"] = [goals[(n // 7) % GOALS].id]
                if n % 9 == 0:
                    kw["owner_id"] = members[n % MEMBERS].id
                if n % 11 == 0:
                    kw["milestone"] = {"name": "M1 Pilot"}
                row = RoadmapItem(
                    roadmap_document_id=roadmap.id,
                    roadmap_version_id=rv.id,
                    item_key=code,
                    title=f"Part {p}-{i}",
                    prd_document_id=doc.id,
                    prd_version_id=pv.id,
                    prd_section_key=f"{code.lower()}",
                    feature_id=features[n].id,
                    position=n,
                    track_id=track.id if n % 5 else None,
                    depends_on=deps,
                    **kw,
                )
                s.add(row)
                items.append(row)
                # The older versions keep their own copies (history the read skips).
                for old in rvs[:-1]:
                    olds[(old.number, code)] = RoadmapItem(
                        roadmap_document_id=roadmap.id,
                        roadmap_version_id=old.id,
                        item_key=code,
                        title=f"Part {p}-{i}",
                        horizon="now",
                        position=n,
                        prd_document_id=doc.id,
                        prd_version_id=pv.id,
                        feature_id=features[n].id,
                    )
                    s.add(olds[(old.number, code)])
                if n % 4 == 1:
                    s.add(
                        TrackerRecord(
                            tracker="linear",
                            external_ref=f"EX-{n}",
                            track_id=track.id,
                            item_key=code,
                            state=("todo", "in_progress", "done")[n % 3],
                            target_date=date(2026, 12, 1) + timedelta(days=n % 40),
                            observed_at=NOW,
                        )
                    )
                if n % 4 == 2:
                    s.add(
                        ScheduleBasis(
                            kind="estimate",
                            reference=f"EST-{n}",
                            supports_date=date(2026, 12, 10),
                            prd_document_id=doc.id,
                            item_key=code,
                            status="verified",
                            verified_at=NOW,
                        )
                    )
        await s.flush()
        for n, row in enumerate(items):
            if n % 3 == 0:
                for k in range(2):
                    s.add(
                        RoadmapItemTask(
                            item_id=row.id,
                            roadmap_document_id=roadmap.id,
                            item_key=row.item_key,
                            title=f"Task {n}-{k}",
                            position=k,
                            created_by=members[0].id,
                        )
                    )
        milestones = 0
        for t, track in enumerate(tracks):
            for m in range(4):
                keys = [prds[t * 5 + m][2][j] for j in range(3)]
                s.add(
                    TrackMilestone(
                        track_id=track.id, name=f"Track {t} step {m}", horizon="now", item_keys=keys
                    )
                )
                milestones += 1
        for g, goal in enumerate(goals):
            for m in range(10):
                p = (g * 10 + m) % PRDS
                s.add(
                    TrackMilestone(
                        roadmap_id=roadmap.id,
                        goal_id=goal.id,
                        code=f"M{m + 1}",
                        name=f"Goal {g} step {m}",
                        horizon="now",
                        kind="delivery",
                        target_date=date(2026, 11, 1) + timedelta(days=14 * m),
                        item_ids=[items[p * PER_PRD + j].id for j in range(2)],
                    )
                )
                milestones += 1
        assert milestones == 60
        await s.flush()
        for c in range(CHANGES):
            row = items[c % len(items)]
            status = ("applied", "proposed", "accepted", "declined", "undone")[c % 5]
            s.add(
                SimpleChange(
                    document_id=roadmap.id,
                    op="move_dates",
                    target={"item_id": str(row.id)},
                    before={"end_date": "2026-12-01"},
                    after={"end_date": "2026-12-15"},
                    status=status,
                    by=members[c % MEMBERS].id,
                    at=NOW - timedelta(hours=c),
                    routed_to=[members[0].id] if status == "proposed" else [],
                )
            )
        # Decisions naming items, some by an older version's row of the same key.
        for d in range(80):
            row = items[(d * 5) % len(items)]
            named = olds[(1, row.item_key)] if d % 3 == 0 else row
            decided = d % 4 != 3
            s.add(
                Decision(
                    number=d + 1,
                    title=f"Example call {d}",
                    status="decided" if decided else "reversed",
                    chosen_option="A" if decided else None,
                    rationale="Example reason" if decided else None,
                    decided_at=NOW - timedelta(days=d) if decided else None,
                    review_at=date(2027, 1, 4) if decided else None,
                    reversibility="reversible",
                    approver_id=members[d % MEMBERS].id,
                    driver="Example driver",
                    origin="manual",
                    subjects=[{"kind": "roadmap_item", "id": str(named.id)}],
                )
            )
        await s.commit()
        await suggestions.regenerate(s)
        await s.commit()
    return ctx
