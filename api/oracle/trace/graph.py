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

Rejected entities and edges are not part of the trace. Walks are bounded.
"""

import uuid
from collections import defaultdict
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.baseline.models import Edge, Entity

# src is downstream of dst.
UPSTREAM_EDGES = ("supports", "derived_from", "part_of", "verifies")
SRC_DOWNSTREAM = (*UPSTREAM_EDGES, "depends_on")
# dst is downstream of src.
DST_DOWNSTREAM = ("affects", "blocks", "mitigates")
MAX_DEPTH = 8
MAX_NODES = 2000


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
    """The company's non-rejected graph, loaded once per request."""

    entities: dict[uuid.UUID, Entity]
    out_edges: dict[uuid.UUID, list[Edge]] = field(default_factory=lambda: defaultdict(list))
    in_edges: dict[uuid.UUID, list[Edge]] = field(default_factory=lambda: defaultdict(list))

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
                    seen.add(other)
                    steps.append(Step(other, edge.id, edge.type, edge.status, node, depth))
                    nxt.append(other)
                    if len(seen) >= MAX_NODES:
                        return steps
            if not nxt:
                break
            frontier = nxt
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


async def load(db: AsyncSession) -> Graph:
    entities = {
        e.id: e for e in (await db.scalars(select(Entity).where(Entity.status != "rejected"))).all()
    }
    graph = Graph(entities=entities)
    edges = (await db.scalars(select(Edge).where(Edge.status != "rejected"))).all()
    for e in edges:
        if e.src_id in entities and e.dst_id in entities:
            graph.out_edges[e.src_id].append(e)
            graph.in_edges[e.dst_id].append(e)
    return graph
