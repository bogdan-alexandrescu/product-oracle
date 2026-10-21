"""Walking the baseline graph along the trace chain.

Edge directions as stored (``src -type-> dst``) and what they mean for the chain:

- ``supports`` (feature → goal or outcome), ``derived_from`` (requirement → outcome →
  goal), ``part_of`` (requirement → feature → product), ``verifies`` (acceptance
  criterion → requirement) and ``depends_on``: ``src`` is *downstream* of ``dst``. A
  change to ``dst`` may make ``src`` stale.
- ``affects`` (assumption, risk, constraint or decision → requirement or feature),
  ``blocks`` (constraint → feature or requirement) and ``mitigates`` (decision → risk or
  constraint): ``dst`` is downstream of ``src``.
- ``owned_by`` (→ person) names an owner. A person changing is not a content change, so
  it never propagates.

Rejected entities and edges are not part of the trace, except the walk's own roots: a
root that was just rejected (or is about to be deleted) still reaches what was built on
it. Nothing loads the whole graph: :func:`load_around` loads the neighbourhood of the
roots, one query per level, and walks are bounded (``MAX_ROOTS`` roots, ``MAX_DEPTH``
levels, ``MAX_NODES`` entities). A walk or load that stops at a bound sets
``Graph.truncated``.
"""

import uuid
from collections import defaultdict
from dataclasses import dataclass, field

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.baseline.models import Edge, Entity

# src is downstream of dst.
UPSTREAM_EDGES = ("supports", "derived_from", "part_of", "verifies")
SRC_DOWNSTREAM = (*UPSTREAM_EDGES, "depends_on")
# dst is downstream of src.
DST_DOWNSTREAM = ("affects", "blocks", "mitigates")
MAX_DEPTH = 8
MAX_NODES = 2000
# A large import's roots alone must not fill MAX_NODES and leave no room for neighbours.
MAX_ROOTS = 500


@dataclass(frozen=True)
class Step:
    """One entity reached by a walk: how (edge) and from where (``via``)."""

    entity_id: uuid.UUID
    edge_id: uuid.UUID
    edge_type: str
    edge_status: str
    via: uuid.UUID
    depth: int


@dataclass
class Graph:
    """A neighbourhood of the company's graph (:func:`load_around`): its roots, whatever
    their status, and the non-rejected entities and edges reachable from them."""

    entities: dict[uuid.UUID, Entity]
    out_edges: dict[uuid.UUID, list[Edge]] = field(default_factory=lambda: defaultdict(list))
    in_edges: dict[uuid.UUID, list[Edge]] = field(default_factory=lambda: defaultdict(list))
    # A load or a walk stopped at MAX_DEPTH or MAX_NODES: there may be more.
    truncated: bool = False

    def _walk(self, start: uuid.UUID, neighbours) -> list[Step]:
        seen = {start}
        frontier = [start]
        steps: list[Step] = []
        for depth in range(1, MAX_DEPTH + 1):
            nxt: list[uuid.UUID] = []
            for node in frontier:
                for edge, other in neighbours(node):
                    if other in seen or other not in self.entities:
                        continue
                    if len(seen) >= MAX_NODES:
                        self.truncated = True
                        return steps
                    seen.add(other)
                    steps.append(Step(other, edge.id, edge.type, edge.status, node, depth))
                    nxt.append(other)
            if not nxt:
                return steps
            frontier = nxt
        if any(
            other not in seen and other in self.entities
            for node in frontier
            for _, other in neighbours(node)
        ):
            self.truncated = True
        return steps

    def upstream(self, start: uuid.UUID) -> list[Step]:
        """Towards goals: what ``start`` derives from, is part of, verifies or supports."""

        def neighbours(node):
            for e in self.out_edges[node]:
                if e.type in UPSTREAM_EDGES:
                    yield e, e.dst_id

        return self._walk(start, neighbours)

    def downstream(self, start: uuid.UUID) -> list[Step]:
        """Everything a change to ``start`` may make stale."""

        def neighbours(node):
            for e in self.in_edges[node]:
                if e.type in SRC_DOWNSTREAM:
                    yield e, e.src_id
            for e in self.out_edges[node]:
                if e.type in DST_DOWNSTREAM:
                    yield e, e.dst_id

        return self._walk(start, neighbours)

    def chain_down(self, start: uuid.UUID) -> list[Step]:
        """The chain below ``start`` only (outcomes, features, requirements, criteria),
        without what assumptions or decisions affect: the view a person reads."""

        def neighbours(node):
            for e in self.in_edges[node]:
                if e.type in UPSTREAM_EDGES:
                    yield e, e.src_id

        return self._walk(start, neighbours)

    def closure(self, start: uuid.UUID) -> set[uuid.UUID]:
        """``start`` and everything downstream of it."""
        return {start, *(s.entity_id for s in self.downstream(start))}

    def confirmed_goals(self, start: uuid.UUID) -> list[Entity]:
        goals = [self.entities[s.entity_id] for s in self.upstream(start)]
        return sorted(
            (g for g in goals if g.type == "goal" and g.status == "confirmed"),
            key=lambda g: g.key,
        )

    def related(self, start: uuid.UUID) -> list[tuple[Edge, Entity, str]]:
        """Direct neighbours that are not on the chain: (edge, entity, "in" | "out")."""
        out: list[tuple[Edge, Entity, str]] = []
        for e in self.in_edges[start]:
            if e.type not in UPSTREAM_EDGES and e.src_id in self.entities:
                out.append((e, self.entities[e.src_id], "in"))
        for e in self.out_edges[start]:
            if e.type not in UPSTREAM_EDGES and e.dst_id in self.entities:
                out.append((e, self.entities[e.dst_id], "out"))
        return out


def _down_condition(frontier: list[uuid.UUID]):
    return or_(
        and_(Edge.dst_id.in_(frontier), Edge.type.in_(SRC_DOWNSTREAM)),
        and_(Edge.src_id.in_(frontier), Edge.type.in_(DST_DOWNSTREAM)),
    )


def _down_next(edge: Edge, frontier: set[uuid.UUID]) -> list[uuid.UUID]:
    out = []
    if edge.type in SRC_DOWNSTREAM and edge.dst_id in frontier:
        out.append(edge.src_id)
    if edge.type in DST_DOWNSTREAM and edge.src_id in frontier:
        out.append(edge.dst_id)
    return out


def _up_condition(frontier: list[uuid.UUID]):
    return and_(Edge.src_id.in_(frontier), Edge.type.in_(UPSTREAM_EDGES))


def _up_next(edge: Edge, frontier: set[uuid.UUID]) -> list[uuid.UUID]:
    return [edge.dst_id] if edge.src_id in frontier else []


def _any_condition(frontier: list[uuid.UUID]):
    return or_(Edge.src_id.in_(frontier), Edge.dst_id.in_(frontier))


def _any_next(edge: Edge, frontier: set[uuid.UUID]) -> list[uuid.UUID]:
    return [x for x in (edge.src_id, edge.dst_id) if x not in frontier]


async def load_around(
    db: AsyncSession,
    roots: list[uuid.UUID],
    *,
    up: bool = False,
    down: bool = True,
    related: bool = False,
) -> Graph:
    """The neighbourhood of ``roots``: the roots (whatever their status), and the
    non-rejected entities and edges reachable downstream (``down``), upstream towards
    goals (``up``) and one hop away along any edge (``related``). One query per level
    and direction, at most ``MAX_ROOTS`` roots (the first ones), ``MAX_DEPTH`` levels
    and ``MAX_NODES`` entities; stopping at a bound sets ``truncated``."""
    roots = list(dict.fromkeys(roots))
    g = Graph(entities={})
    if not roots:
        return g
    if len(roots) > MAX_ROOTS:
        g.truncated = True
        roots = roots[:MAX_ROOTS]
    g.entities = {e.id: e for e in (await db.scalars(select(Entity).where(Entity.id.in_(roots))))}
    edges: dict[uuid.UUID, Edge] = {}

    async def expand(condition, next_of, depth_limit: int = MAX_DEPTH) -> None:
        seen = {r for r in roots if r in g.entities}
        frontier = list(seen)
        for _ in range(depth_limit):
            if not frontier:
                return
            rows = (
                await db.scalars(select(Edge).where(Edge.status != "rejected", condition(frontier)))
            ).all()
            fset = set(frontier)
            candidates: list[uuid.UUID] = []
            for edge in rows:
                edges.setdefault(edge.id, edge)
                for other in next_of(edge, fset):
                    if other not in seen and other not in candidates:
                        candidates.append(other)
            missing = [c for c in candidates if c not in g.entities]
            if missing:
                found = (
                    await db.scalars(
                        select(Entity)
                        .where(Entity.id.in_(missing), Entity.status != "rejected")
                        .order_by(Entity.type, Entity.key)
                    )
                ).all()
                room = max(MAX_NODES - len(g.entities), 0)
                if len(found) > room:
                    g.truncated = True
                    found = found[:room]
                for e in found:
                    g.entities[e.id] = e
            frontier = [c for c in candidates if c in g.entities]
            seen.update(frontier)
            if g.truncated:
                return
        if frontier and depth_limit == MAX_DEPTH:
            # More only if an edge leads to a live entity not reached yet; one back into
            # what was reached (a cycle) is not.
            fset = set(frontier)
            rest = await db.scalars(
                select(Edge).where(Edge.status != "rejected", condition(frontier))
            )
            beyond = {o for edge in rest for o in next_of(edge, fset) if o not in seen}
            if beyond and await db.scalar(
                select(Entity.id).where(Entity.id.in_(beyond), Entity.status != "rejected").limit(1)
            ):
                g.truncated = True

    if down:
        await expand(_down_condition, _down_next)
    if up:
        await expand(_up_condition, _up_next)
    if related:
        await expand(_any_condition, _any_next, depth_limit=1)
    for e in edges.values():
        if e.src_id in g.entities and e.dst_id in g.entities:
            g.out_edges[e.src_id].append(e)
            g.in_edges[e.dst_id].append(e)
    return g
