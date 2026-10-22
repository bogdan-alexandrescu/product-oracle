"""A proposal as one plain sentence, and who made it (B4 Proposal sentences).

Written once, here, so the web, MCP clients and agents read the same words. The mock
layer ports these rules to web/lib/api/mock/describe.ts: change both together.
"""

import re
import uuid
from collections.abc import Iterable, Mapping
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.baseline.models import Edge, Entity, Proposal
from oracle.baseline.schemas import ProposalProposer, ProposalRun

REMOVED = "an item that was removed"
INTAKE_LABEL = "From an intake answer"
MAX_VALUE = 60
MAX_FIELDS = 3
# Words of what the two texts share, shown before where a long text change starts.
CONTEXT_WORDS = 2

EDGE_VERBS = {
    "supports": "supports",
    "depends_on": "depends on",
    "blocks": "blocks",
    "part_of": "is part of",
    "owned_by": "is owned by",
    "derived_from": "comes from",
    "verifies": "verifies",
    "affects": "affects",
    "mitigates": "reduces the risk of",
}
STRENGTHS = ("none", "weak", "medium", "strong")
# Attribute key -> its label; any other key reads with "_" as spaces.
ATTR_LABELS = {"effort": "effort", "current": "current value", "contribution": "strength"}
# Top-level entity and edge fields, when several change at once.
FIELD_LABELS = {"title": "title", "body": "description", "status": "status"}

_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
_SNAKE = re.compile(r"^[a-z0-9]+(?:_[a-z0-9]+)+$")


def _words(key: str) -> str:
    return key.replace("_", " ")


def _possessive(title: str) -> str:
    return f"{title}’" if title.endswith("s") else f"{title}’s"


def _label(key: str, entity_type: str | None) -> str:
    if key == "status" and entity_type == "feature":
        return "delivery status"
    return ATTR_LABELS.get(key, _words(key))


def _value(value: Any, key: str | None, entities: Mapping[uuid.UUID, Entity]) -> str:
    """A field's value as short words."""
    if key == "contribution" and isinstance(value, int) and not isinstance(value, bool):
        if 0 <= value < len(STRENGTHS):
            return STRENGTHS[value]
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, int | float):
        return str(value)
    if isinstance(value, list):
        shown = ", ".join(_value(v, None, entities) for v in value[:MAX_FIELDS])
        more = len(value) - MAX_FIELDS
        return f"{shown} and {more} more" if more > 0 else shown
    if isinstance(value, dict):
        return "a new value"
    text = str(value)
    if _UUID.fullmatch(text.strip()):
        # An item's id: its title, never the id itself.
        target = entities.get(uuid.UUID(text.strip()))
        return target.title if target is not None else REMOVED
    if _SNAKE.match(text):
        text = _words(text)
    text = _UUID.sub("an item", text)
    return text[:MAX_VALUE] + "…" if len(text) > MAX_VALUE else text


def _changes(fields: Mapping[str, Any]) -> list[tuple[str, Any]]:
    """[(key, new value)]: top-level fields, then attrs, as the payload orders them."""
    out: list[tuple[str, Any]] = []
    for k, v in fields.items():
        if k == "attrs" and isinstance(v, dict):
            out.extend((f"attrs.{ak}", av) for ak, av in v.items())
        elif k != "id":
            out.append((k, v))
    return out


def _old(current: Entity | Edge | None, key: str) -> tuple[bool, Any]:  # (known, value)
    if current is None:
        return False, None
    if key.startswith("attrs."):
        attrs = current.attrs or {}
        k = key.removeprefix("attrs.")
        return (k in attrs and attrs[k] is not None), attrs.get(k)
    v = getattr(current, key, None)
    return v is not None, v


def _same(old: Any, new: Any) -> bool:
    """Whether a proposed value is the one the item has: yes/no never equals 1/0."""
    if isinstance(old, uuid.UUID):
        old = str(old)
    if isinstance(old, bool) != isinstance(new, bool):
        return False
    if isinstance(old, str) and isinstance(new, str) and _UUID.fullmatch(old):
        return old.lower() == new.strip().lower()
    return bool(old == new)


def _real(changes: list[tuple[str, Any]], current: Entity | Edge | None) -> list[tuple[str, Any]]:
    """The changes whose new value differs from the item's (#262); all when it is gone."""
    if current is None:
        return changes
    return [(k, v) for k, v in changes if not _same(_old(current, k)[1], v)]


def _excerpt(words: list[str], start: int) -> str:
    text = " ".join(words[start:])
    text = text[:MAX_VALUE] + "…" if len(text) > MAX_VALUE else text
    return f"…{text}" if start else text


def _values(old: Any, new: Any, key: str, entities: Mapping[uuid.UUID, Entity]) -> tuple[str, str]:
    """(old, new) as short words; two long texts from just before where they differ, so
    the cut never leaves two identical prefixes."""
    texts = isinstance(old, str) and isinstance(new, str)
    if texts and max(len(old), len(new)) > MAX_VALUE and not _UUID.fullmatch(new.strip()):
        a, b = _UUID.sub("an item", old).split(), _UUID.sub("an item", new).split()
        differ = next((i for i, (x, y) in enumerate(zip(a, b, strict=False)) if x != y), None)
        start = max(0, (min(len(a), len(b)) if differ is None else differ) - CONTEXT_WORDS)
        return _excerpt(a, start), _excerpt(b, start)
    return _value(old, key, entities), _value(new, key, entities)


def _change(
    key: str,
    new: Any,
    current: Entity | Edge | None,
    entity_type: str | None,
    entities: Mapping[uuid.UUID, Entity],
) -> str:
    """ "<label> to <new> (was <old>)", as one clause of a longer sentence."""
    bare = key.removeprefix("attrs.")
    label = FIELD_LABELS.get(key) if not key.startswith("attrs.") else None
    label = label or _label(bare, entity_type)
    known, old = _old(current, key)
    if new is None:
        return f"{label} cleared" + (f" (was {_value(old, bare, entities)})" if known else "")
    if not known:
        return f"{label} to {_value(new, bare, entities)}"
    was, to = _values(old, new, bare, entities)
    return f"{label} to {to} (was {was})"


def _changed_list(clauses: list[str]) -> str:
    shown = ", ".join(clauses[:MAX_FIELDS])
    more = len(clauses) - MAX_FIELDS
    return f"{shown} and {more} more" if more > 0 else shown


def _entity_sentence(
    op: str,
    fields: Mapping[str, Any],
    target: Entity | None,
    entities: Mapping[uuid.UUID, Entity],
) -> str:
    if op == "create":
        type_ = _words(str(fields.get("type") or "item"))
        title = str(fields.get("title") or "a new item")
        attrs = fields.get("attrs") or {}
        blocker = " (suggested blocker)" if attrs.get("proposed_blocker") is not None else ""
        return f"Add {type_} “{title}”{blocker}"
    if target is None and op == "delete":
        return f"Remove {REMOVED}"
    type_ = _words(target.type) if target is not None else "item"
    entity_type = target.type if target is not None else None
    title = target.title if target is not None else REMOVED
    if op == "delete":
        return f"Remove {type_} “{title}”"
    changes = _real(_changes(fields), target)
    if not changes:
        return f"No change to {title}"
    keys = [k for k, _ in changes]
    if keys == ["title"]:
        return f"Rename “{title}” to “{changes[0][1]}”"
    if keys == ["body"]:
        return f"Rewrite the description of {title}"
    if keys == ["status"]:
        status = changes[0][1]
        if status == "confirmed":
            return f"Confirm {type_} {title}"
        if status == "rejected":
            return f"Reject {type_} {title}"
        return f"Mark {title} as proposed again"
    if len(changes) == 1:
        key, new = changes[0]
        bare = key.removeprefix("attrs.")
        label = _label(bare, entity_type)
        known, old = _old(target, key)
        if new is None:
            was = f" (was {_value(old, bare, entities)})" if known else ""
            return f"Clear {_possessive(title)} {label}{was}"
        if not known:
            return f"Set {_possessive(title)} {label} to {_value(new, bare, entities)}"
        was, to = _values(old, new, bare, entities)
        return f"Set {_possessive(title)} {label} to {to} (was {was})"
    clauses = [_change(k, v, target, entity_type, entities) for k, v in changes]
    return f"Change {title}: {_changed_list(clauses)}"


def _edge_sentence(
    op: str,
    fields: Mapping[str, Any],
    target: Edge | None,
    entities: Mapping[uuid.UUID, Entity],
) -> str:
    def title(entity_id: Any) -> str:
        try:
            e = entities.get(uuid.UUID(str(entity_id)))
        except ValueError:
            e = None
        return e.title if e is not None else REMOVED

    if op == "create":
        src, dst, type_ = (
            title(fields.get("src_id")),
            title(fields.get("dst_id")),
            fields.get("type"),
        )
        if type_ == "supports":
            c = (fields.get("attrs") or {}).get("contribution")
            strength = STRENGTHS[c] if isinstance(c, int) and 0 <= c < len(STRENGTHS) else "some"
            return f"Link {src} to goal {dst} ({strength} support)"
        return f"Add link: {src} {EDGE_VERBS.get(str(type_), _words(str(type_)))} {dst}"
    if target is None:
        return (
            "Remove a link that was removed" if op == "delete" else "Change a link that was removed"
        )
    verb = EDGE_VERBS.get(target.type, _words(target.type))
    link = f"{title(target.src_id)} {verb} {title(target.dst_id)}"
    if op == "delete":
        return f"Remove link: {link}"
    changes = _real(_changes(fields), target)
    if not changes:
        return f"No change to link {link}"
    clauses = [_change(k, v, target, None, entities) for k, v in changes]
    return f"Change link {link}: {_changed_list(clauses)}"


def describe(
    proposal: Proposal,
    entities: Mapping[uuid.UUID, Entity],
    edges: Mapping[uuid.UUID, Edge],
    awaiting: bool = False,
) -> str:
    """The proposal as one sentence; ``awaiting`` for a question-only intake proposal."""
    p = proposal.payload or {}
    fields = p.get("fields") or {}
    if awaiting:
        category = (fields.get("attrs") or {}).get("category") or "a question"
        return f"Waiting for the author to share an answer ({_words(str(category))})"
    op = str(p.get("op") or "update")
    if p.get("kind") == "edge":
        target_id = proposal.edge_id or _uuid(fields.get("id"))
        return _edge_sentence(op, fields, edges.get(target_id) if target_id else None, entities)
    target_id = proposal.entity_id or _uuid(fields.get("id"))
    return _entity_sentence(op, fields, entities.get(target_id) if target_id else None, entities)


def _uuid(value: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value)) if value is not None else None
    except ValueError:
        return None


def _referenced(payload: Mapping[str, Any]) -> Iterable[uuid.UUID | None]:
    """Entity ids a payload's values may name (an edge's ends, an owner)."""
    fields = payload.get("fields") or {}
    for v in [*fields.values(), *(fields.get("attrs") or {}).values()]:
        if isinstance(v, str) and _UUID.fullmatch(v.strip()):
            yield _uuid(v.strip())


async def summaries(db: AsyncSession, proposals: list[Proposal]) -> dict[uuid.UUID, str]:
    """{proposal id: sentence}: a decided proposal keeps the one stored when it was
    decided; the rest are written from the targets' state now (two queries)."""
    from oracle.baseline.service import _question_only_shape, awaits_answer

    out: dict[uuid.UUID, str] = {}
    todo = []
    for p in proposals:
        stored = (p.payload or {}).get("summary")
        if p.status != "open" and isinstance(stored, str):
            out[p.id] = stored
        else:
            todo.append(p)
    if not todo:
        return out
    edge_ids = {
        i for p in todo for i in (p.edge_id, _uuid((p.payload.get("fields") or {}).get("id")))
    }
    edge_ids.discard(None)
    edges = {
        e.id: e for e in (await db.scalars(select(Edge).where(Edge.id.in_(edge_ids)))).all()
    } if edge_ids else {}  # fmt: skip
    entity_ids: set[uuid.UUID | None] = set()
    for p in todo:
        entity_ids.update((p.entity_id, _uuid((p.payload.get("fields") or {}).get("id"))))
        entity_ids.update(_referenced(p.payload))
    for e in edges.values():
        entity_ids.update((e.src_id, e.dst_id))
    entity_ids.discard(None)
    entities = {
        e.id: e for e in (await db.scalars(select(Entity).where(Entity.id.in_(entity_ids)))).all()
    } if entity_ids else {}  # fmt: skip
    for p in todo:
        awaiting = _question_only_shape(p.payload) and await awaits_answer(db, p.payload)
        out[p.id] = describe(p, entities, edges, awaiting)
    return out


def run_label(run: ProposalRun) -> str:
    """ "Build the baseline · Oct 20"."""
    return f"{run.flow_title} · {_day(run.created_at)}"


def _day(at: datetime) -> str:
    return f"{at.strftime('%b')} {at.day}"


def _from_intake(payload: Mapping[str, Any]) -> bool:
    attrs = (payload.get("fields") or {}).get("attrs") or {}
    return isinstance(attrs, dict) and ("gap_id" in attrs or "proposed_blocker" in attrs)


async def proposers(
    db: AsyncSession, proposals: list[Proposal], runs: Mapping[uuid.UUID, ProposalRun]
) -> dict[uuid.UUID, ProposalProposer]:
    """{proposal id: who made it}: member emails and token names in one query each."""
    from oracle.auth.models import ApiToken, User
    from oracle.members.names import display_name

    def actor_id(p: Proposal, kind: str) -> uuid.UUID | None:
        if p.actor and p.actor.startswith(f"{kind}:"):
            return _uuid(p.actor.split(":", 1)[1])
        return None

    user_ids = {actor_id(p, "user") for p in proposals} - {None}
    token_ids = {actor_id(p, "token") for p in proposals} - {None}
    emails: dict[uuid.UUID, str] = {}
    if user_ids:
        rows = await db.execute(select(User.id, User.email).where(User.id.in_(user_ids)))
        emails = {r.id: r.email for r in rows}
    names: dict[uuid.UUID, str] = {}
    if token_ids:
        rows = await db.execute(
            select(ApiToken.id, ApiToken.name).where(ApiToken.id.in_(token_ids))
        )
        names = {r.id: r.name for r in rows}
    out: dict[uuid.UUID, ProposalProposer] = {}
    for p in proposals:
        run = runs.get(p.run_id) if p.run_id else None
        if run is not None:
            out[p.id] = ProposalProposer(kind="run", label=run_label(run), run_id=run.id)
        elif p.run_id or (p.actor or "").startswith("run:"):
            out[p.id] = ProposalProposer(kind="run", label="A run that was removed")
        elif _from_intake(p.payload or {}):
            # Never the person: which answer made it is the finding author's (S6).
            out[p.id] = ProposalProposer(kind="intake", label=INTAKE_LABEL)
        elif (uid := actor_id(p, "user")) is not None:
            email = emails.get(uid)
            out[p.id] = ProposalProposer(
                kind="person",
                label=display_name(email) if email else "A former member",
                user_id=uid,
                email=email,
            )
        elif (tid := actor_id(p, "token")) is not None:
            name = names.get(tid)
            out[p.id] = ProposalProposer(
                kind="token", label=f"API token “{name}”" if name else "An API token"
            )
        else:
            out[p.id] = ProposalProposer(kind="oracle", label="Oracle")
    return out
