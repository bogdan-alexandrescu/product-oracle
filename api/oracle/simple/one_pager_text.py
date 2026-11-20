"""The one-pager's blocks and words: block specs and section mapping, a section's facts,
lines clipped to their caps, plan and PRD items, goal names, and a line's section patch
(moved from oracle.simple.one_pager)."""

import hashlib
import json
import logging
import re
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import safe_yaml
from oracle.baseline.models import Entity
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.errors import exception_text
from oracle.roadmap.models import RoadmapItem
from oracle.simple import one_pager_checks, plan_strip, quality
from oracle.simple import plan as plan_model
from oracle.simple.models import SimpleOnePager
from oracle.simple.one_pager_checks import resolved
from oracle.simple.schemas import OnePagerMetric

log = logging.getLogger("oracle.simple.one_pager")

# set_section_number (owner, Nov 5): a "Needs a look" numbers item's one-click fix.
NUMBER_OP = "set_section_number"
OPS: frozenset[str] = frozenset({"edit_line", NUMBER_OP})
LINE_MAX = 300
PROBLEM_WORDS = 60
# A shortened line keeps its whole text (at most this long) for "Show all".
FULL_MAX = 2000


@dataclass(frozen=True)
class Spec:
    """One block: its words, caps and either the template's section keys or the heading
    words that map sections to it."""

    key: str
    title: str
    rules: str
    kind: str
    min_lines: int
    max_lines: int
    max_words: int
    whole_block: bool = False
    words: tuple[str, ...] = ()
    sections: tuple[str, ...] = ()


# D5's six fallback blocks. Mapping tries them in MATCH order (the narrower words first).
FALLBACK: tuple[Spec, ...] = (
    Spec(
        "problem",
        "Problem and who has it",
        "At most 60 words",
        "text",
        1,
        1,
        PROBLEM_WORDS,
        True,
        (
            "problem",
            "who has it",
            "who",
            "user",
            "customer",
            "why",
            "background",
            "context",
            "pain",
        ),
    ),
    Spec(
        "bets",
        "What we will build",
        "3-5 bets",
        "lines",
        3,
        5,
        30,
        False,
        (
            "build",
            "solution",
            "scope",
            "bet",
            "requirement",
            "feature",
            "proposal",
            "approach",
            "what we",
        ),
    ),
    Spec(
        "outcomes",
        "Outcomes and how we measure them",
        "2-4 metrics, from → to",
        "metrics",
        2,
        4,
        30,
        False,
        ("outcome", "metric", "success", "measure", "goal", "kpi", "impact"),
    ),
    Spec(
        "not_doing",
        "Not doing",
        "At most 5 lines",
        "lines",
        0,
        5,
        30,
        False,
        ("not doing", "non-goal", "non goal", "out of scope", "won't", "not in scope"),
    ),
    Spec(
        "risks",
        "Risks and open decisions",
        "At most 5",
        "lines",
        0,
        5,
        30,
        False,
        (
            "risk",
            "open question",
            "open decision",
            "decision",
            "assumption",
            "dependenc",
            "question",
        ),
    ),
)
MATCH = ("not_doing", "risks", "outcomes", "problem", "bets")
TIMELINE = Spec("timeline", "Timeline", "The PRD's roadmap slice", "timeline", 0, 0, 0)

_BULLET = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$")
_SENTENCE = re.compile(r"(?<=[.!?])\s+")
_METRIC = re.compile(
    r"^(?P<name>.*?)[:\s,-]*\s(?:from\s+)?(?P<from>[~<>]?[$€£]?\d[\d.,]*\s?(?:%|ms|s|x|k|m|days?|"
    r"hours?|minutes?)?)\s*(?:→|->|\bto\b)\s*(?P<to>[~<>]?[$€£]?\d[\d.,]*\s?(?:%|ms|s|x|k|m|"
    r"days?|hours?|minutes?)?)",
    re.IGNORECASE,
)
_MD = re.compile(r"[*_`]+|\[([^\]]*)\]\([^)]*\)|\[\^?[\w-]+\]")
# A markdown table's separator row ("|---|:---:|", GFM's "|-|-|" too); its header is the row
# above it.
# A template's guidance (CLD's production walk, 2026-10-27): HTML comments, and lines that are
# only placeholders ("<Milestone>: <Feature>") or arrows ("→") are never a one-pager line.
_COMMENT = re.compile(r"<!--.*?(?:-->|\Z)", re.S)
_PLACEHOLDER = re.compile(r"<[^<>\n]*>")
_WORDY = re.compile(r"[^\W_]")
_TABLE_SEP = re.compile(r"^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$")
_CELL_SPLIT = re.compile(r"(?<!\\)\|")


# --------------------------------------------------------------------------- blocks


def _template_specs(body: str | None) -> tuple[Spec, ...] | None:
    """The blocks a template names in its front matter (``one_pager.blocks``), or None."""
    if not body or not body.startswith("---"):
        return None
    end = body.find("\n---", 3)
    if end < 0:
        return None
    try:
        meta = safe_yaml.load(body[3:end]) or {}
    except safe_yaml.SafeYamlError as exc:  # load raises only this
        log.warning("template front matter could not be parsed: %s", exception_text(exc))
        return None
    blocks = ((meta.get("one_pager") or {}) if isinstance(meta, dict) else {}).get("blocks")
    if not isinstance(blocks, list) or not blocks:
        return None
    out = []
    for b in blocks:
        if not isinstance(b, dict) or not b.get("key") or not b.get("title"):
            continue
        n = int(b.get("max_lines") or 5)
        out.append(
            Spec(
                str(b["key"]),
                str(b["title"]),
                f"At most {n} lines",
                "lines",
                0,
                max(1, min(n, 5)),
                30,
                sections=tuple(str(s) for s in b.get("sections") or []),
            )
        )
    return tuple(out) or None


async def specs_for(db: AsyncSession, document: Document) -> tuple[Spec, ...]:
    from oracle.templates.models import Template, TemplateVersion

    if document.template:
        body = await db.scalar(
            select(TemplateVersion.body)
            .join(Template, Template.id == TemplateVersion.template_id)
            .where(Template.key == document.template)
            .order_by(TemplateVersion.version.desc())
            .limit(1)
        )
        found = _template_specs(body)
        if found:
            return found
    return FALLBACK


def mapping(specs: tuple[Spec, ...], sections: list[Section]) -> dict[str, list[Section]]:
    """Each block's sections: the template's keys, else the first block (MATCH order)
    whose words the section's heading or key holds. Level-1 headings (the title) and empty
    sections map nowhere."""
    out: dict[str, list[Section]] = {s.key: [] for s in specs}
    by_key = {s.key: s for s in specs}
    explicit = any(s.sections for s in specs)
    for sec in sections:
        if sec.level <= 1 or not (sec.body_text or "").strip():
            continue
        if explicit:
            for s in specs:
                if sec.section_key in s.sections:
                    out[s.key].append(sec)
            continue
        name = f"{sec.heading} {sec.section_key}".casefold().replace("_", " ")
        for k in MATCH:
            spec = by_key.get(k)
            if spec and any(w in name for w in spec.words):
                out[k].append(sec)
                break
    return out


def sections_hash(version: DocumentVersion, specs, mapped: dict[str, list[Section]]) -> str:
    raw = json.dumps(
        [
            str(version.id),
            [s.key for s in specs],
            {k: [(s.section_key, s.content_hash) for s in v] for k, v in mapped.items()},
        ],
        sort_keys=True,
    )
    return hashlib.sha256(raw.encode()).hexdigest()


def _plain(text: str) -> str:
    return " ".join(_MD.sub(lambda m: m.group(1) or "", text).split())


def _words(text: str, n: int) -> str:
    w = text.split()
    return text if len(w) <= n else " ".join(w[:n]).rstrip(",;:") + "…"


def _upto(text: str, chars: int) -> str:
    """At most ``chars``, cut at a word with "…", never mid-word."""
    if len(text) <= chars:
        return text
    head = text[: chars - 1]
    return (head.rsplit(" ", 1)[0] if " " in head else head).rstrip(",;: ") + "…"


def _uncomment(text: str) -> str:
    return _COMMENT.sub(" ", text)


def template_only(text: str) -> bool:
    """Only a template's placeholders, arrows or punctuation: no words of the PRD's own."""
    return not _WORDY.search(_PLACEHOLDER.sub("", _uncomment(text)))


def clip(text: str, words: int, chars: int = LINE_MAX) -> tuple[str, str | None]:
    """A line held to its words and characters, cut at a word boundary with "…", and the
    whole text when it was cut (else None)."""
    text = " ".join(text.split())
    shown = _words(text, words)
    if len(shown) > chars:
        head = shown[: chars - 1]
        head = head.rsplit(" ", 1)[0] if " " in head else head
        shown = head.rstrip(",;: …") + "…"
    return shown, (text[:FULL_MAX] if shown != text else None)


def _tidy(
    text: str, words: int, full: str | None, sources: list[Section]
) -> tuple[str, str | None]:
    """A stored line as it reads: comments out, cut at a word boundary (a line cut mid-word
    by an older build loses its broken word; one that is its source fact whole stays), and
    its whole text when it is shortened (as stored, else its own source fact, else its prose
    sections' sentences)."""
    text = " ".join(resolved(_uncomment(text)).split())
    full = resolved(full) if full else full
    own = _own_fact(text, sources)
    if len(text) >= LINE_MAX and not text.endswith("…") and own != text:
        text = (text.rsplit(" ", 1)[0] if " " in text else text).rstrip(",;:") + "…"
    shown, cut = clip(text, words)
    if not shown.endswith("…"):
        return shown, None
    whole = full or (cut if cut and not cut.endswith("…") else None) or own
    # A prose section's line is its sentences; a bullet's or a row's is its own fact only.
    whole = whole or " ".join(f for sec in sources if not _listed(sec) for f in _facts(sec))
    whole = whole[:FULL_MAX] if whole else None
    return shown, (whole if whole and whole != shown else None)


def _listed(sec: Section) -> bool:
    """Whether a section's facts are its bullets or table rows (one line each), not prose."""
    rows, rest = _tables(_uncomment(resolved(sec.body_md or "")))
    return bool(rows) or any(_BULLET.match(line) for line in rest)


def _own_fact(text: str, sources: list[Section]) -> str | None:
    """The source fact a stored line was taken from: the first that starts with the line's
    words (less a trailing "…"), else None."""
    head = text.removesuffix("…").rstrip(",;: ")
    if not head:
        return None
    return next((f for sec in sources for f in _facts(sec) if f.startswith(head)), None)


def _id(item: Any) -> str | None:
    return str(item.id) if getattr(item, "id", None) else None


def roadmap_codes_of(read: Any, prd_id: uuid.UUID) -> Callable[..., str | None]:
    """roadmap-milestone-codes: an item's milestone's roadmap-wide code, as the Roadmap read
    (``read``, service.build) gives it: a picked roadmap milestone's or a track milestone's by
    its id, else this PRD's milestone of that written code (or name) on the roadmap; None when
    it is no roadmap milestone. A PRD milestone on two roadmaps reads its first code."""
    by_id = {m.id: m.roadmap_code for m in [*read.goal_milestones, *read.milestones]}
    own: dict[str, str] = {}
    for m in read.goal_milestones:
        if m.prd is None or m.prd.id != prd_id or not m.roadmap_code:
            continue
        for k in (m.code.strip().upper(), " ".join(m.name.split()).casefold()):
            if k and (k not in own or int(m.roadmap_code[1:]) < int(own[k][1:])):
                own[k] = m.roadmap_code

    by_name: dict[str, str] = {}
    # A roadmap milestone (a track's, or a roadmap's own; a goal's target date holds no item).
    named = [
        *read.milestones,
        *(m for m in read.goal_milestones if not getattr(m, "goal_target", False)),
    ]
    for m in named:
        k = " ".join((m.name or "").split()).casefold()
        code = m.roadmap_code
        if k and code and (k not in by_name or int(code[1:]) < int(by_name[k][1:])):
            by_name[k] = code

    def of(text: str | None, *ids: uuid.UUID | None) -> str | None:
        for i in ids:
            if i is not None and by_id.get(i):
                return by_id[i]
        if not text:
            return None
        key, label = plan_strip.milestone_of(text)
        name = label.split(" · ", 1)[1] if " · " in label else ""
        return (
            own.get(key)
            or own.get(" ".join(name.split()).casefold())
            # A track milestone the text names ("Beta launch"), as Home and the Roadmap read it.
            or by_name.get(" ".join((name or label).split()).casefold())
        )

    return of


def plan_items(
    items: list[Any],
    names: dict[str, str] | None = None,
    code_of: Callable[..., str | None] | None = None,
) -> list[plan_strip.PlanItem]:
    """The plan strip's reading of a PRD's roadmap items (neither cut nor merged), each with
    the milestone record that links it, when any. ``names``: the PRD plan's milestone names
    by code; a milestone said only by its code ("M2", an item of the PRD with no slice, or
    its milestone record) reads with its name ("M2 · Ship to beta", vqa one-pager 3).
    ``code_of`` (roadmap_codes_of): each with its milestone's roadmap code."""
    names = names or {}

    def named(text: str | None) -> str | None:
        code, label = plan_strip.milestone_of(text)
        return f"{code} · {names[code]}" if text and label == code and names.get(code) else text

    out = []
    for i in items:
        # panel-menu: a merged feature (any, not only a draft) is off the plan as a cut one.
        if i.status in ("cut", "merged"):
            continue
        # plan-model: one input per slice, each in its milestone as the PRD's plan dates it.
        for sl in getattr(i, "slices", None) or []:
            out.append(
                plan_strip.PlanItem(
                    sl.start_date or i.start.date,
                    sl.end_date or i.end.date,
                    not (sl.milestone_start and sl.milestone_end),
                    named(f"{sl.milestone} · {sl.milestone_name}"),
                    sl.milestone_end,
                    milestone_start=sl.milestone_start,
                    id=_id(i),
                    roadmap_code=code_of(sl.milestone) if code_of else None,
                )
            )
        if getattr(i, "slices", None):
            continue
        out.append(
            plan_strip.PlanItem(
                i.start.date,
                i.end.date,
                i.estimated,
                named(i.milestone.name or "Milestone") if i.milestone else None,
                i.milestone.date if i.milestone else None,
                str(i.milestone.record_id) if i.milestone and i.milestone.record_id else None,
                named(i.milestone.record_name) if i.milestone else None,
                i.milestone.start_date if i.milestone else None,
                _id(i),
                code_of(
                    i.milestone.record_name or i.milestone.name,
                    i.milestone.id,
                    i.milestone.record_id,
                )
                if code_of and i.milestone
                else None,
            )
        )
    return out


# A feature's code read one way ("f-7", "F-007" and 7 read "F-07"; a slice F-15a is F-15).
_FEATURE_CODE = re.compile(r"([a-z]{1,3})-0*(\d{1,4})[a-j]?", re.IGNORECASE)


def _feature_code(raw: Any) -> str | None:
    if isinstance(raw, int) and not isinstance(raw, bool):
        raw = f"F-{raw}"
    m = _FEATURE_CODE.fullmatch(str(raw or "").strip())
    return f"{m.group(1).upper()}-{int(m.group(2)):02d}" if m else None


async def prd_items(
    db: AsyncSession,
    document: Document,
    b: "Built",
    items: list[Any],
    view: plan_model.View | None,
) -> list[Any]:
    """S-8: the PRD's roadmap items, of the roadmap the reader is shown: its own (the PRD
    they name) and those of its features (docs/ground-truth.md: an item is a Ground Truth
    feature by code), whatever PRD they name: the company roadmap's items that deliver a
    feature of the PRD's plan (``view``: its stored plan, else its approved version's
    tables, as the Roadmap reads it) or of its own coded sections (F-07), by their code or a
    slice's feature's (F-07a), or by the feature its plan links.

    Each is placed by THIS PRD's plan only: its slices are the plan's slices of the feature
    it delivers; an item of another PRD with none sits under no milestone, never under
    that PRD's milestone or dates."""
    codes = {c for s in b.sections if (c := _feature_code(s.section_key))}
    # A code read one way -> the plan's feature code as the PRD writes it.
    planned: dict[str, str] = {}
    links: dict[uuid.UUID, str] = {}
    if view is not None:
        for raw in view.feature_codes:
            if c := _feature_code(raw):
                planned.setdefault(c, raw)
        for code, raw in view.links.items():
            try:
                links[uuid.UUID(raw)] = code
            except ValueError:
                continue
    codes |= set(planned)
    features: dict[uuid.UUID, uuid.UUID] = {}
    keyed: dict[uuid.UUID, str] = {}
    ids = [i.id for i in items if i.id]
    if ids and (codes or links):
        features = {
            i: f
            for i, f in (
                await db.execute(
                    select(RoadmapItem.id, RoadmapItem.feature_id).where(
                        RoadmapItem.id.in_(ids), RoadmapItem.feature_id.is_not(None)
                    )
                )
            ).all()
        }
        if features:
            keyed = {
                e: c
                for e, key in (
                    await db.execute(
                        select(Entity.id, Entity.key).where(Entity.id.in_(set(features.values())))
                    )
                ).all()
                if (c := _feature_code(key)) in codes  # type: ignore[assignment]
            }

    def own(i: Any) -> bool:
        return i.prd is not None and i.prd.id == document.id

    def mine(i: Any) -> bool:
        f = features.get(i.id)
        return (
            own(i)
            or _feature_code(i.code) in codes
            or (f is not None and (f in links or f in keyed))
        )

    def feature(i: Any) -> str | None:
        """The plan's feature the item delivers, when the plan has it."""
        f = features.get(i.id)
        for c in (_feature_code(i.code), keyed.get(f) if f else None):
            if c in planned:
                return planned[c]
        return links.get(f) if f else None

    out = []
    for i in items:
        if not mine(i):
            continue
        code = feature(i)
        slices = view.slices_of(code) if view is not None and code else []
        out.append(
            i.model_copy(update={"slices": slices, "milestone": i.milestone if own(i) else None})
        )
    return out


# A goal's code in a PRD's words ("G2", a subgoal "G1.2"), and the name the PRD gives it
# beside it: "G2 (retention)", "G2: Retention", "**G2 Retention**", a row "| G2 | Retention |".
GOAL_CODE = re.compile(r"\bG\d{1,3}(?:\.\d{1,2})?\b")
_GOAL_PAREN = re.compile(r"\b(G\d{1,3}(?:\.\d{1,2})?)\b\**\s*\(([A-Za-z][^()\n]{0,40})\)")
_GOAL_AFTER = re.compile(r"\**\s*(?:[:=—–]\s*|\s-\s)?\**([A-Z][\w'’-]*(?: [A-Za-z][\w'’-]*){0,4})")


def _goal_name(text: str) -> str:
    text = " ".join(text.split()).strip(" *-—–:")
    return text[:1].upper() + text[1:]


async def goal_names(db: AsyncSession, sections: list[Section]) -> dict[str, str]:
    """P-5: each goal code's name: the Ground Truth goal keyed by it (``G2`` -> "Grow
    retention"), else the name the PRD gives it."""
    out: dict[str, str] = {}
    for sec in sections:
        text = one_pager_checks._plain(f"{sec.heading or ''}\n{sec.body_md or ''}")
        for m in _GOAL_PAREN.finditer(text):
            out.setdefault(m.group(1), _goal_name(m.group(2)))
        for raw in text.splitlines():
            cells = [c.strip(" *") for c in raw.strip().strip("|").split("|")]
            if raw.strip().startswith("|"):
                for c, nxt in zip(cells, cells[1:], strict=False):
                    if GOAL_CODE.fullmatch(c) and nxt and not GOAL_CODE.search(nxt):
                        out.setdefault(c, _goal_name(nxt))
                continue
            for m in GOAL_CODE.finditer(raw):
                if n := _GOAL_AFTER.match(raw[m.end() :]):
                    out.setdefault(m.group(0), _goal_name(n.group(1)))
    found = {m.group(0) for s in sections for m in GOAL_CODE.finditer(s.body_md or "")}
    if found:
        upper = {c.upper(): c for c in found}
        rows = await db.execute(
            select(Entity.key, Entity.title, Entity.status).where(
                Entity.type == "goal",
                Entity.status != "rejected",
                func.upper(Entity.key).in_(list(upper)),
            )
        )
        # A confirmed goal's title over a proposed one's, over the PRD's own words.
        for key, title, _ in sorted(rows.all(), key=lambda r: r[2] == "confirmed"):
            if title and title.strip():
                out[upper[key.upper()]] = title.strip()
    return out


def with_goal_names(text: str, names: dict[str, str]) -> str:
    """The text with each goal code's name beside it ("G2 Grow retention"): a code the PRD
    named in brackets ("G2 (retention)") reads the name instead of them."""
    if not text or not names:
        return text

    def paren(m: re.Match[str]) -> str:
        return f"{m.group(1)} {names[m.group(1)]}" if m.group(1) in names else m.group(0)

    text = _GOAL_PAREN.sub(paren, text)

    def put(m: re.Match[str]) -> str:
        code, name = m.group(0), names.get(m.group(0))
        if not name or text[m.end() :].lstrip(" :—–-*").lower().startswith(name.lower()):
            return code
        return f"{code} {name}"

    return GOAL_CODE.sub(put, text)


def _says_not_in_prd(text: str) -> bool:
    """A line that only says the PRD lacks it ("Not in the PRD yet.", "Open decisions: Not in
    the PRD yet"): the block's own mark says it, once."""
    said = " ".join(text.split()).rstrip(" .").casefold()
    no = quality.NOT_IN_PRD.casefold()
    return said == no or (said.endswith(f": {no}") and len(said) - len(no) <= 40)


def _cells(row: str) -> list[str]:
    """A table row's cells, without the outer pipes."""
    r = row.strip()
    r = r[1:] if r.startswith("|") else r
    r = r[:-1] if r.endswith("|") and not r.endswith("\\|") else r
    return [c.strip() for c in _CELL_SPLIT.split(r)]


def _tables(md: str) -> tuple[list[tuple[str, list[str]]], list[str]]:
    """A section's table body rows (each raw line and its cells) and its other lines. A
    table's header and separator rows are neither: they are never a line."""
    lines = md.splitlines()
    rows: list[tuple[str, list[str]]] = []
    rest: list[str] = []
    i = 0
    while i < len(lines):
        if "|" in lines[i] and i + 1 < len(lines) and _TABLE_SEP.match(lines[i + 1]):
            i += 2
            while i < len(lines) and "|" in lines[i] and lines[i].strip():
                rows.append((lines[i], _cells(lines[i])))
                i += 1
            continue
        rest.append(lines[i])
        i += 1
    return rows, rest


def _row_line(cells: list[str]) -> str:
    """A table body row as one readable line: "<first cell>: <the next non-empty cell>"."""
    vals = [v for v in (_plain(c.replace("\\|", "/")).strip(" |") for c in cells) if v]
    return ": ".join(vals[:2])


def _unpiped(text: str) -> str:
    """A line never starts or ends with a pipe: a table row's words read as one line. Pipes
    inside prose ("p50 | p95 | p99") stay as written."""
    t = text.strip()
    if t.startswith("|") or t.endswith("|"):
        t = _row_line(_cells(t)) if "|" in t.strip("| ") else t.strip(" |")
    return t.strip(" |")


def _facts(sec: Section) -> list[str]:
    """A section's bullets and its tables' body rows (one line each), else its sentences; its
    citations resolved as the PRD's PDF resolves them (never a ``[c:id]`` on a line)."""
    rows, rest = _tables(_uncomment(resolved(sec.body_md or "")))
    bullets = [_plain(m.group(1)) for line in rest if (m := _BULLET.match(line))]
    facts = [b for b in (_unpiped(x) for x in bullets) if b and not template_only(b)]
    facts += [x for x in (_row_line(c) for _, c in rows) if x and not template_only(x)]
    if facts:
        return facts
    prose = _plain("\n".join(rest)) if rows else _uncomment(sec.body_text or "")
    # A skeleton's bare lines ("→", "<Risk>: <mitigation>") are not sentences of the PRD.
    prose = "\n".join(x for x in prose.splitlines() if not template_only(x))
    return [
        s
        for s in (_unpiped(_plain(x)) for x in _SENTENCE.split(prose))
        if s and not template_only(s)
    ]


def metric_of(text: str) -> OnePagerMetric | None:
    m = _METRIC.search(text)
    if not m:
        return None
    name = m.group("name").strip(" :,-") or text
    return OnePagerMetric.model_validate(
        {"name": name, "from": m.group("from").strip(), "to": m.group("to").strip()}
    )


def extract(specs: tuple[Spec, ...], mapped: dict[str, list[Section]]) -> list[dict[str, Any]]:
    """Oracle's quick read: each block's lines from its sections' bullets and sentences,
    capped."""
    out = []
    for spec in specs:
        secs = mapped.get(spec.key, [])
        lines: list[dict[str, Any]] = []
        if spec.whole_block:
            text, whole, keys = "", "", []
            for sec in secs:
                for fact in _facts(sec):
                    whole = f"{whole} {fact}".strip()
                    if len(text.split()) >= spec.max_words:
                        continue
                    text = f"{text} {fact}".strip()
                    if sec.section_key not in keys:
                        keys.append(sec.section_key)
            if text:
                shown = clip(text, spec.max_words)[0]
                line = {"text": shown, "source_keys": keys}
                if shown != whole:
                    line["full"] = whole[:FULL_MAX]
                lines.append(line)
        else:
            facts = [(f, sec.section_key) for sec in secs for f in _facts(sec)]
            if spec.kind == "metrics":
                facts = sorted(facts, key=lambda f: metric_of(f[0]) is None)
            for fact, key in facts[: spec.max_lines]:
                shown, cut = clip(fact, spec.max_words)
                line: dict[str, Any] = {"text": shown, "source_keys": [key]}
                if cut:
                    line["full"] = cut
                if spec.kind == "metrics" and (m := metric_of(fact)):
                    line["metric"] = m.model_dump(by_alias=True)
                lines.append(line)
        out.append({"key": spec.key, "lines": lines})
    return out


def _metric(raw: Any) -> OnePagerMetric | None:
    """A stored line's metric as it reads: its citations resolved (a quick read stored
    before that rule keeps them)."""
    if not raw:
        return None
    m = OnePagerMetric.model_validate(raw)
    m.name, m.to = resolved(m.name).strip() or m.name, resolved(m.to).strip() or m.to
    m.from_ = resolved(m.from_).strip() if m.from_ else m.from_
    return m


def _numbered(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    for b in blocks:
        for i, line in enumerate(b["lines"], 1):
            line["id"] = f"{b['key']}-{i}"
    return blocks


def clean_answer(
    answer: Any, specs: tuple[Spec, ...], mapped: dict[str, list[Section]], strict: bool = True
) -> list[dict[str, Any]] | None:
    """The job's answer, held to each block's caps and its own section keys; None when it
    is not usable (the quick read stays). Not ``strict`` (an answer that failed its checks,
    held for owners): a block left short is kept as it is."""
    given = {b.get("key"): b for b in (answer or {}).get("blocks") or [] if isinstance(b, dict)}
    out = []
    for spec in specs:
        allowed = {s.section_key for s in mapped.get(spec.key, [])}
        lines = []
        marked = quality.marked(given.get(spec.key) or {})
        if marked and not quality.has_facts(mapped.get(spec.key, [])):
            out.append({"key": spec.key, "lines": [], "missing": True})  # "Not in the PRD yet"
            continue
        for raw in (given.get(spec.key) or {}).get("lines") or []:
            if not isinstance(raw, dict):
                continue
            text = _unpiped(" ".join(resolved(_uncomment(str(raw.get("text") or ""))).split()))
            keys = [str(k) for k in raw.get("source_keys") or [] if str(k) in allowed]
            if not text or not keys or template_only(text):
                continue
            shown, cut = clip(text, spec.max_words)
            line: dict[str, Any] = {"text": shown, "source_keys": keys}
            if cut:
                line["full"] = cut
            m = raw.get("metric")
            if spec.kind == "metrics" and isinstance(m, dict) and m.get("name") and m.get("to"):
                line["metric"] = {
                    "name": _upto(resolved(str(m["name"])).strip(), 120),
                    "from": _upto(resolved(str(m.get("from") or "")).strip(), 60),
                    "to": _upto(resolved(str(m["to"])).strip(), 80),
                }
            lines.append(line)
        lines = lines[: spec.max_lines]
        facts = sum(len(_facts(x)) for x in mapped.get(spec.key, []))
        if strict and len(lines) < min(max(spec.min_lines, marked), facts):
            return None  # a block marked "Not in the PRD yet" that the PRD has: not usable
        out.append({"key": spec.key, "lines": lines})
    return _numbered(out)


@dataclass
class Built:
    document: Document
    version: DocumentVersion
    specs: tuple[Spec, ...]
    sections: list[Section]
    row: SimpleOnePager


def _body(values: dict[str, Any], key: str) -> str:
    return str(((values.get("sections") or {}).get(key) or {}).get("body") or "")


def _spans(body: str) -> tuple[list[str], bool]:
    """A section's facts as written: its bullets' text, else its sentences."""
    bullets = [m.group(1) for line in body.splitlines() if (m := _BULLET.match(line))]
    if bullets:
        return bullets, True
    return [x.strip() for x in _SENTENCE.split(body.strip()) if x.strip()], False


def _stems(text: str) -> set[str]:
    return {w[:4] for w in re.findall(r"[\w%]+", text.casefold()) if len(w) > 2}


def _hits(spans: list[str], old: str) -> list[str]:
    """The facts a line says: those its words hold (a quick read's line, the concatenated
    Problem, a truncated line), else the one fact a paraphrase (the job's wording) rests on."""
    o = _plain(old).rstrip("…").strip()
    if not o:
        return []
    exact = [r for r in spans if (p := _plain(r)) and (p in o or (o in p and len(o.split()) > 2))]
    if exact:
        return exact
    line = _stems(o)
    scored = [(len(_stems(r) & line) / max(len(_stems(r)), 1), r) for r in spans]
    best = max(scored, default=(0.0, ""))
    return [best[1]] if best[0] >= 0.6 else []


def _drop(body: str, raw: str, bullets: bool) -> str:
    if bullets:
        pat = r"^[ \t]*(?:[-*+]|\d+[.)])[ \t]+" + re.escape(raw) + r"[ \t]*(?:\n|$)"
        return re.sub(pat, "", body, count=1, flags=re.M)
    return re.sub(re.escape(raw) + r"[ \t]*", "", body, count=1)


def _row_with(cells: list[str], new: str) -> str:
    """A table row saying the new line: "A: B" writes its first two non-empty cells, other
    words the second (the row's other cells stay)."""
    out = list(cells)
    filled = [i for i, c in enumerate(cells) if _plain(c).strip(" |")] or [0]
    head, sep, tail = new.partition(": ")
    put = lambda i, v: out.__setitem__(i, v.strip().replace("|", "\\|"))  # noqa: E731
    if len(filled) >= 2 and sep:
        put(filled[0], head)
        put(filled[1], tail)
    else:
        put(filled[1] if len(filled) >= 2 else filled[0], new)
    return "| " + " | ".join(out) + " |"


def patch(body: str, old: str, new: str, *, first: bool = True) -> str | None:
    """The section with the line's new words: the fact(s) the old line says replaced by
    the new line (``first``), or dropped (a later section of a line resting on several,
    which the new words now speak for). None when the section holds nothing the line says:
    the edit is refused rather than a new claim added beside the old one."""
    o = _plain(old).rstrip("…").strip()
    for raw, cells in _tables(body)[0]:
        said = _row_line(cells)
        if said and o and (said == o or (said.startswith(o) and len(o.split()) > 2)):
            if not first:
                return re.sub(re.escape(raw) + r"[ \t]*(?:\n|$)", "", body, count=1)
            return body.replace(raw, _row_with(cells, new), 1)
    spans, bullets = _spans(body)
    hits = _hits(spans, old)
    if not hits:
        stripped = old.rstrip("…").strip()
        if not stripped or stripped not in body:
            return None
        return body.replace(stripped, new, 1) if first else body.replace(stripped, "", 1)
    out = body
    for i, raw in enumerate(hits):
        out = out.replace(raw, new, 1) if first and i == 0 else _drop(out, raw, bullets)
    return out


def patch_all(bodies: dict[str, str], old: str, new: str) -> dict[str, str] | None:
    """Every source section of a line patched (see :func:`patch`), or None."""
    out: dict[str, str] = {}
    for i, (k, body) in enumerate(bodies.items()):
        got = patch(body, old, new, first=i == 0)
        if got is None:
            return None
        out[k] = got
    return out
