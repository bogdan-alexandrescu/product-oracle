"""The tech brief contract (F5-1): ``tech_briefs.yaml``, one brief per feature.

The architect step of F4's Engineering check writes it (:data:`oracle.runs.flows.
TECH_BRIEF_TASK`); F4's Engineering dates stop reads the same file later in the run.
:func:`check` lists its problems for the Engineering check's file-level error card;
:func:`parse` reads a file whose entries are well formed (registration,
:mod:`oracle.engineering.store`); :func:`render_markdown` writes ``brief.md``.

The file is untrusted text: it is parsed with :mod:`oracle.safe_yaml`, capped at
:data:`MAX_BYTES`, :data:`MAX_FEATURES` features and :data:`MAX_QUESTIONS` questions
per feature, and its text fields are data, never instructions.

Format (``version: 1``)::

    code_map: {used: true, repos: [{repo, commit, as_of}]}   # used: false without a map
    features:
      - feature: <a key of feature_set.yaml>
        title, approach, size (xs | s | m | l | xl), size_why
        touches: [{area, kind, change, ref}]   # ref: a code map id, or null
        reuse: [<code map id>]
        risks: [{risk, level, mitigation}]
        questions: [{id, question, why, blocking}]
        depends_on: [<feature key>]
        assumptions: [<text>]                  # at least one when code_map.used is false
"""

from collections.abc import Collection
from typing import Any, Literal

from pydantic import BaseModel

from oracle import safe_yaml

VERSION = 1
FILE = "tech_briefs.yaml"
MAX_BYTES = 200 * 1024
MAX_FEATURES = 100
MAX_QUESTIONS = 20
# Size and its person-weeks.
SIZES = {"xs": 0.5, "s": 1, "m": 2, "l": 4, "xl": 8}
# What a touch is: the kinds of a code map's entries (F5-2's code_map.json).
TOUCH_KINDS = ("module", "api", "data_model", "flag", "job")
CHANGES = ("new", "change", "remove")
RISK_LEVELS = ("low", "medium", "high")

ProblemCode = Literal[
    "unreadable",
    "wrong_version",
    "too_large",
    "bad_entry",
    "missing_feature",
    "unknown_feature",
    "bad_size",
    "bad_kind",
    "bad_change",
    "duplicate_question_id",
    "unknown_dependency",
    "unknown_ref",
    "ref_without_map",
    "no_assumptions",
]


class Problem(BaseModel):
    code: ProblemCode
    message: str
    # The feature key the problem is about; None for the file as a whole.
    feature: str | None = None


class Touch(BaseModel):
    area: str
    kind: str
    change: str
    ref: str | None = None


class Risk(BaseModel):
    risk: str
    level: str
    mitigation: str | None = None


class Question(BaseModel):
    id: str
    question: str
    why: str | None = None
    blocking: bool = False


class RepoRef(BaseModel):
    repo: str
    commit: str | None = None
    as_of: str | None = None


class CodeMapUse(BaseModel):
    used: bool
    repos: list[RepoRef] = []


class Brief(BaseModel):
    feature: str
    title: str
    approach: str
    touches: list[Touch] = []
    reuse: list[str] = []
    risks: list[Risk] = []
    questions: list[Question] = []
    size: str
    size_why: str | None = None
    depends_on: list[str] = []
    assumptions: list[str] = []


class TechBriefs(BaseModel):
    version: int
    code_map: CodeMapUse
    features: list[Brief]


class BriefsInvalid(ValueError):
    def __init__(self, problems: list[Problem]):
        self.problems = problems
        super().__init__("; ".join(f"[{p.code}] {p.message}" for p in problems))


def _p(code: ProblemCode, message: str, feature: str | None = None) -> Problem:
    return Problem(code=code, message=message, feature=feature)


def _text(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _list_of(value: Any, kind: type) -> bool:
    return isinstance(value, list) and all(isinstance(v, kind) for v in value)


# Fields of an entry: (name, required, shape check, what it must be).
_TEXT = (_text, "text")
_OPT_TEXT = (lambda v: v is None or isinstance(v, str), "text or null")
_STRINGS = (lambda v: _list_of(v, str), "a list of text")
_MAPS = (lambda v: _list_of(v, dict), "a list of mappings")
ENTRY_FIELDS = {
    "feature": (True, *_TEXT),
    "title": (True, *_TEXT),
    "approach": (True, *_TEXT),
    "size": (True, *_TEXT),
    "size_why": (False, *_OPT_TEXT),
    "touches": (False, *_MAPS),
    "reuse": (False, *_STRINGS),
    "risks": (False, *_MAPS),
    "questions": (False, *_MAPS),
    "depends_on": (False, *_STRINGS),
    "assumptions": (False, *_STRINGS),
}
TOUCH_FIELDS = {"area": _TEXT, "kind": _TEXT, "change": _TEXT, "ref": _OPT_TEXT}
RISK_FIELDS = {"risk": _TEXT, "level": _TEXT, "mitigation": _OPT_TEXT}
QUESTION_FIELDS = {
    "id": _TEXT,
    "question": _TEXT,
    "why": _OPT_TEXT,
    "blocking": (lambda v: isinstance(v, bool), "true or false"),
}


def _shape(
    item: dict[str, Any], fields: dict[str, tuple], where: str, key: str | None
) -> list[Problem]:
    out = []
    for name, (ok, what) in fields.items():
        if name in item and not ok(item[name]):
            out.append(_p("bad_entry", f"{where}: {name} must be {what}", key))
        elif name not in item and what == "text":
            out.append(_p("bad_entry", f"{where}: {name} is missing", key))
    return out


def _load(text: str) -> tuple[dict[str, Any] | None, list[Problem]]:
    """The file as a mapping, or the problems that keep it from being read."""
    if not isinstance(text, str):
        return None, [_p("unreadable", "tech_briefs.yaml is not text")]
    try:
        data = safe_yaml.load(text, limit=MAX_BYTES)
    except safe_yaml.SafeYamlError as exc:
        return None, [_p("unreadable", f"tech_briefs.yaml could not be read: {exc.problem}")]
    if not isinstance(data, dict):
        return None, [_p("unreadable", "tech_briefs.yaml must be a mapping")]
    if data.get("version") != VERSION:
        return None, [
            _p("wrong_version", f"version must be {VERSION}, not {data.get('version')!r}")
        ]
    return data, []


def check(
    text: str, feature_keys: Collection[str], code_map: Collection[str] | None
) -> list[Problem]:
    """The problems of ``text``; ``[]`` when it is a valid set of briefs.

    ``feature_keys``: the keys of the approved feature set (one brief each).
    ``code_map``: the ids of the code map(s) the run used (``module:billing``...), None
    when no shared code map was available to the run."""
    data, problems = _load(text)
    if data is None:
        return problems
    return _check(data, feature_keys, code_map)


def _check(
    data: dict[str, Any], feature_keys: Collection[str], code_map: Collection[str] | None
) -> list[Problem]:
    """:func:`check` on the file's loaded mapping."""
    out: list[Problem] = []
    cm = data.get("code_map")
    if not isinstance(cm, dict) or not isinstance(cm.get("used"), bool):
        out.append(_p("bad_entry", "code_map must be a mapping with used: true or false"))
        used = False
    else:
        used = cm["used"]
        repos = cm.get("repos", [])
        if not _list_of(repos, dict) or any(not _text(r.get("repo")) for r in repos):
            out.append(_p("bad_entry", "code_map.repos must be a list of {repo, commit, as_of}"))
    features = data.get("features")
    if not _list_of(features, dict):
        return [*out, _p("bad_entry", "features must be a list of briefs")]
    if len(features) > MAX_FEATURES:
        return [
            *out,
            _p("too_large", f"{len(features)} features; at most {MAX_FEATURES} per file"),
        ]
    wanted = set(feature_keys)
    seen: set[str] = set()
    known_ids = None if code_map is None else set(code_map)
    for i, entry in enumerate(features):
        key = entry.get("feature") if _text(entry.get("feature")) else None
        where = f"features[{i}]" + (f" ({key})" if key else "")
        shape = []
        for name, (required, ok, what) in ENTRY_FIELDS.items():
            if name in entry and not ok(entry[name]):
                shape.append(_p("bad_entry", f"{where}: {name} must be {what}", key))
            elif required and name not in entry:
                shape.append(_p("bad_entry", f"{where}: {name} is missing", key))
        out += shape
        if key is None:
            continue
        if key in seen:
            out.append(_p("bad_entry", f"{where}: a second brief for {key}", key))
        seen.add(key)
        if key not in wanted:
            out.append(_p("unknown_feature", f"{key} is not a feature of the feature set", key))
        size = entry.get("size")
        if isinstance(size, str) and size not in SIZES:
            out.append(
                _p("bad_size", f"{where}: size {size!r} is not one of {', '.join(SIZES)}", key)
            )
        refs: list[tuple[str, str]] = []
        for j, touch in enumerate(entry.get("touches") or [] if not shape else []):
            if not isinstance(touch, dict):
                continue
            tw = f"{where}.touches[{j}]"
            out += _shape(touch, TOUCH_FIELDS, tw, key)
            if isinstance(touch.get("kind"), str) and touch["kind"] not in TOUCH_KINDS:
                out.append(
                    _p("bad_kind", f"{tw}: kind {touch['kind']!r} is not one of "
                       f"{', '.join(TOUCH_KINDS)}", key)
                )  # fmt: skip
            if isinstance(touch.get("change"), str) and touch["change"] not in CHANGES:
                out.append(
                    _p("bad_change", f"{tw}: change {touch['change']!r} is not one of "
                       f"{', '.join(CHANGES)}", key)
                )  # fmt: skip
            if _text(touch.get("ref")):
                refs.append((f"{tw}.ref", touch["ref"]))
        if not shape:
            refs += [(f"{where}.reuse", r) for r in entry.get("reuse") or []]
        for j, risk in enumerate(entry.get("risks") or [] if not shape else []):
            rw = f"{where}.risks[{j}]"
            out += _shape(risk, RISK_FIELDS, rw, key)
            if isinstance(risk.get("level"), str) and risk["level"] not in RISK_LEVELS:
                out.append(_p("bad_entry", f"{rw}: level must be one of "
                              f"{', '.join(RISK_LEVELS)}", key))  # fmt: skip
        questions = entry.get("questions") or [] if not shape else []
        if len(questions) > MAX_QUESTIONS:
            out.append(
                _p("too_large", f"{where}: {len(questions)} questions; at most {MAX_QUESTIONS}",
                   key)
            )  # fmt: skip
        ids: set[str] = set()
        for j, q in enumerate(questions[:MAX_QUESTIONS]):
            out += _shape(q, QUESTION_FIELDS, f"{where}.questions[{j}]", key)
            qid = q.get("id")
            if isinstance(qid, str):
                if qid in ids:
                    out.append(
                        _p("duplicate_question_id", f"{where}: question id {qid!r} twice", key)
                    )
                ids.add(qid)
        for dep in entry.get("depends_on") or [] if not shape else []:
            if dep not in wanted:
                out.append(
                    _p("unknown_dependency", f"{where}: depends on {dep!r}, not a feature of "
                       "the feature set", key)
                )  # fmt: skip
        for rw, ref in refs:
            if not used:
                out.append(
                    _p("ref_without_map", f"{rw}: {ref!r} cites a code map, but code_map.used "
                       "is false", key)
                )  # fmt: skip
            elif known_ids is None or ref not in known_ids:
                out.append(
                    _p("unknown_ref", f"{rw}: {ref!r} is not in the code map this run used",
                       key)
                )  # fmt: skip
        if not used and not shape and not entry.get("assumptions"):
            out.append(
                _p("no_assumptions", f"{where}: no code map, so list at least one assumption",
                   key)
            )  # fmt: skip
    for key in sorted(wanted - seen):
        out.append(_p("missing_feature", f"{key} has no brief", key))
    return out


def parse(text: str) -> TechBriefs:
    """The briefs of a file whose entries are well formed (references are not checked:
    :func:`check` does that against the feature set and the code map). Raises
    :class:`BriefsInvalid` otherwise. The file is loaded once. Untrusted text: callers
    on the event loop run it on the parse pool (:func:`oracle.engineering.store.prepare`)."""
    data, problems = _load(text)
    if data is None:
        raise BriefsInvalid(problems)
    features = data.get("features")
    keys = [f.get("feature") for f in features] if _list_of(features, dict) else []
    structural = [
        p
        for p in _check(data, [k for k in keys if isinstance(k, str)], None)
        if p.code in ("bad_entry", "too_large")
    ]
    if structural:
        raise BriefsInvalid(structural)
    return TechBriefs.model_validate(data)


def _label(value: str) -> str:
    return value.replace("_", " ")


def render_markdown(
    brief: Brief,
    code_map: CodeMapUse,
    *,
    verdict: dict[str, Any] | None,
    answers: list[dict[str, Any]],
) -> str:
    """``brief.md``: the brief as a person reads it."""
    lines = [f"# Tech brief: {brief.title}", "", f"Feature `{brief.feature}`.", ""]
    if code_map.used:
        repos = ", ".join(
            f"{r.repo}" + (f" at {r.commit}" if r.commit else "") + (f" ({r.as_of})" if r.as_of
                                                                      else "")
            for r in code_map.repos
        )  # fmt: skip
        lines += [f"Code map: {repos or 'used'}.", ""]
    else:
        lines += ["No code map: assumptions.", ""]
        lines += [f"- {a}" for a in brief.assumptions] + [""]
    lines += ["## Approach", "", brief.approach, ""]
    if brief.touches:
        lines += ["## What it touches", "", "| Area | Kind | Change | Code map ref |",
                  "|---|---|---|---|"]  # fmt: skip
        lines += [
            f"| {t.area} | {_label(t.kind)} | {t.change} | {t.ref or '-'} |" for t in brief.touches
        ]
        lines.append("")
    if brief.reuse:
        lines += ["## Reuses", ""] + [f"- {r}" for r in brief.reuse] + [""]
    if brief.risks:
        lines += ["## Risks", ""]
        lines += [
            f"- {r.risk} ({r.level})" + (f": {r.mitigation}" if r.mitigation else "")
            for r in brief.risks
        ]
        lines.append("")
    if brief.questions:
        by_id = {a.get("question_id"): a.get("answer") for a in answers}
        lines += ["## Questions", ""]
        for q in brief.questions:
            lines.append(f"- {q.question}" + (" (blocking)" if q.blocking else ""))
            if q.why:
                lines.append(f"  Why: {q.why}")
            if by_id.get(q.id):
                lines.append(f"  Answer: {by_id[q.id]}")
        lines.append("")
    weeks = SIZES.get(brief.size)
    lines += ["## Size", "", f"{brief.size.upper()}" + (f" (about {weeks:g} person-weeks)"
                                                       if weeks else "")]  # fmt: skip
    if brief.size_why:
        lines.append(brief.size_why)
    lines.append("")
    if brief.depends_on:
        lines += ["## Depends on", ""] + [f"- {d}" for d in brief.depends_on] + [""]
    if verdict is not None:
        value = verdict.get("value")
        lines += ["## Engineering check", "", _label(value) if value else "Approved"]
        if verdict.get("note"):
            lines.append(verdict["note"])
        lines.append("")
    return "\n".join(lines)
