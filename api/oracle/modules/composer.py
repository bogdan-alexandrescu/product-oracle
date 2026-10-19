"""The composer (build prompt §4.3): from a template, packs, company policy and inputs to
an explained, ordered module composition. Pure and deterministic: no database, no clock,
no model call. The same context always gives the same composition.

Steps, in order:

1. **Candidates**: the modules of the chosen packs, the template's manifest, the
   company's mandatory modules and the modules a person adds.
2. **Policy** (who decides "mandatory"): the company policy first (required, optional
   or disabled), else the strongest of the pack's contract policy and the template
   manifest's policy (required > conditional > optional).
3. **Selection**: a required module is mandatory. A conditional module is suggested
   when its applicability expression holds (oracle.modules.evaluator); the evaluation is
   explained leaf by leaf, and paths it could not read are missing information. An
   advisory score (rules, or an external AI signal) is shown but never decides alone.
   A module the template already renders stays in by default, so the template keeps
   its shape.
4. **A person's changes**: add, remove, reorder. A mandatory module, or a module an
   included module depends on, is never removed silently: the request is refused with a
   problem saying why.
5. **Closure and conflicts**: dependencies are pulled in (explained as "needed by"),
   to a fixpoint; a required dependency that cannot be satisfied fails clearly.
   Conflicts drop the weaker module, or fail when both are mandatory or a person asked
   for both.
6. **Order**: a topological order over ``order_after`` / ``order_before`` with ties by
   ``display_order`` then id; the Sources and data points module is always last (O1c).
   A person's order is checked against the same constraints.
7. **Validation**: section ids must not collide, and supplied field values are checked
   against each module's declarative validators.

Problems are returned, not raised: ``fatal`` problems make a composition invalid (a
recommendation shows them; confirming refuses).
"""

import heapq
import re
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel

from oracle.modules.evaluator import ConditionError, Evaluation, evaluate
from oracle.v2.contract import ALWAYS, FieldDefinition, ModuleContract
from oracle.v2.schemas import CompositionModule

Selection = Literal["mandatory", "suggested", "optional"]
DecidedBy = Literal["policy", "template", "condition", "dependency", "user", "conflict", "none"]
PolicySource = Literal["company", "pack", "template", "catalog"]
KnowledgeState = Literal["verified_fact", "user_decision", "ai_inference", "hypothesis", "unknown"]

_RANK = {"optional": 0, "conditional": 1, "required": 2}
SOURCES_SECTION = "sources"
ROLES = ("viewer", "commenter", "approver", "owner")


# --- inputs -------------------------------------------------------------------------------


@dataclass(frozen=True)
class ManifestEntry:
    sections: tuple[str, ...]
    policy: str
    version: str | None = None


@dataclass(frozen=True)
class TemplateSection:
    key: str
    level: int
    heading: str
    brief: bool


@dataclass(frozen=True)
class Provenance:
    knowledge_state: KnowledgeState
    evidence_ids: tuple[str, ...] = ()
    source: str | None = None


@dataclass(frozen=True)
class Advisory:
    score: float
    rationale: str


@dataclass(frozen=True)
class Changes:
    add: tuple[str, ...] = ()
    remove: tuple[str, ...] = ()
    order: tuple[str, ...] | None = None
    reason: str | None = None
    # The deciding person's role and id (for role-gated modules and the record).
    role: str = "owner"
    actor_id: str | None = None


@dataclass
class Context:
    contracts: dict[str, ModuleContract]
    origins: dict[str, str] = field(default_factory=dict)
    # Archived (or otherwise unavailable) module ids the company still has.
    unavailable: set[str] = field(default_factory=set)
    packs: dict[str, tuple[str, ...]] = field(default_factory=dict)
    template_key: str | None = None
    template_version: str | None = None
    template_sections: list[TemplateSection] = field(default_factory=list)
    manifest: dict[str, ManifestEntry] = field(default_factory=dict)
    company_required: tuple[str, ...] = ()
    company_optional: tuple[str, ...] = ()
    company_disabled: tuple[str, ...] = ()
    inputs: dict[str, Any] = field(default_factory=dict)
    provenance: dict[str, Provenance] = field(default_factory=dict)
    advisory: dict[str, Advisory] = field(default_factory=dict)
    field_values: dict[str, dict[str, Any]] = field(default_factory=dict)


# --- outputs ------------------------------------------------------------------------------


class Basis(BaseModel):
    """One input that drove a decision: what was read, what it held, and how we know."""

    path: str
    op: str
    expected: Any = None
    actual: Any = None
    holds: bool
    missing: bool
    knowledge_state: KnowledgeState
    evidence_ids: list[str] = []
    source: str | None = None


class QuestionRef(BaseModel):
    key: str
    prompt: str
    category: str
    importance: str
    fills: list[str] = []


class LayerImpact(BaseModel):
    """Where the module shows up in the document (O1f brief and full layers)."""

    brief_sections: list[str] = []
    full_sections: list[str] = []
    # Sections this module adds to the template (not already in it).
    new_sections: list[str] = []
    # Template sections it maps to that the template version actually has.
    template_sections: list[str] = []
    # Mapped sections the template version does not have (an edited copy dropped them).
    absent_template_sections: list[str] = []


class FieldProblem(BaseModel):
    field: str
    kind: str
    message: str


class ComposedModule(CompositionModule):
    """A module in a composition, with everything the inspector explains (§4.5)."""

    title: str = ""
    origin: str = "builtin"
    selection: Selection = "optional"
    decided_by: DecidedBy = "none"
    policy_source: PolicySource = "catalog"
    explanation: list[str] = []
    basis: list[Basis] = []
    missing_information: list[str] = []
    questions: list[QuestionRef] = []
    depends_on: list[str] = []
    required_by: list[str] = []
    conflicts_with: list[str] = []
    layer_impact: LayerImpact = LayerImpact()
    field_problems: list[FieldProblem] = []
    condition_error: str | None = None
    user_reason: str | None = None
    required_review_role: str = "approver"


class CompositionProblem(BaseModel):
    code: str
    message: str
    module: str | None = None
    fatal: bool = True


class OutlineEntry(BaseModel):
    section_id: str
    heading: str
    level: int
    layer: Literal["brief", "full"]
    module: str | None = None
    origin: Literal["template", "module"]


class Composition(BaseModel):
    template: str | None = None
    template_version: str | None = None
    packs: list[str] = []
    modules: list[ComposedModule] = []
    problems: list[CompositionProblem] = []
    outline: list[OutlineEntry] = []

    @property
    def valid(self) -> bool:
        return not any(p.fatal for p in self.problems)

    @property
    def included(self) -> list[ComposedModule]:
        return [m for m in self.modules if m.included]


# --- helpers ------------------------------------------------------------------------------


def _root_state(path: str) -> KnowledgeState:
    """Default knowledge state of an input (provenance overrides it): the confirmed
    baseline is a verified fact; anything else was given by a person."""
    return "verified_fact" if path.split(".")[0] == "baseline" else "user_decision"


def _basis(ev: Evaluation, ctx: Context) -> list[Basis]:
    out = []
    for leaf in ev.leaves:
        prov = _provenance(ctx, leaf.path)
        out.append(
            Basis(
                path=leaf.path,
                op=leaf.op,
                expected=leaf.expected,
                actual=leaf.actual,
                holds=leaf.holds,
                missing=leaf.missing,
                knowledge_state="unknown"
                if leaf.missing
                else (prov.knowledge_state if prov else _root_state(leaf.path)),
                evidence_ids=list(prov.evidence_ids) if prov else [],
                source=prov.source if prov else None,
            )
        )
    return out


def _provenance(ctx: Context, path: str) -> Provenance | None:
    """The provenance recorded for ``path`` or its nearest ancestor."""
    parts = path.split(".")
    for i in range(len(parts), 0, -1):
        prov = ctx.provenance.get(".".join(parts[:i]))
        if prov is not None:
            return prov
    return None


def _effective_sections(contract: ModuleContract, ctx: Context) -> list[str]:
    entry = ctx.manifest.get(contract.id)
    if entry is not None:
        return list(entry.sections)
    return contract.effective_section_ids()


def _layer_impact(contract: ModuleContract, ctx: Context) -> LayerImpact:
    entry = ctx.manifest.get(contract.id)
    if entry is not None and ctx.template_sections:
        present = {s.key: s for s in ctx.template_sections}
        here = [s for s in entry.sections if s in present]
        return LayerImpact(
            brief_sections=[s for s in here if present[s].brief],
            full_sections=[s for s in here if not present[s].brief],
            template_sections=here,
            absent_template_sections=[s for s in entry.sections if s not in present],
        )
    sections = contract.effective_section_ids()
    if contract.brief_section_ids:
        brief = list(contract.brief_section_ids)
    elif contract.brief_layer and not contract.full_layer:
        brief = list(sections)
    else:
        brief = []
    full = [s for s in sections if s not in brief] if contract.full_layer or not brief else []
    return LayerImpact(brief_sections=brief, full_sections=full, new_sections=list(sections))


def _questions(contract: ModuleContract, ctx: Context) -> list[QuestionRef]:
    out = []
    for q in contract.question_prompts:
        if q.when is not None:
            try:
                if not evaluate(q.when, ctx.inputs).value:
                    continue
            except ConditionError:
                pass  # ask when unsure
        out.append(
            QuestionRef(
                key=q.key,
                prompt=q.prompt,
                category=q.category,
                importance=q.importance,
                fills=list(q.fills),
            )
        )
    return out


# --- field validation ---------------------------------------------------------------------


def _type_ok(defn: FieldDefinition, value: Any, item: bool = False) -> bool:
    kind = defn.item_type if item else defn.type
    if kind in ("text", "markdown", "date", "reference"):
        return isinstance(value, str)
    if kind == "number":
        return isinstance(value, int | float) and not isinstance(value, bool)
    if kind == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if kind == "boolean":
        return isinstance(value, bool)
    if kind == "enum":
        return isinstance(value, str) and value in defn.options
    if kind == "list":
        return isinstance(value, list) and all(_type_ok(defn, v, item=True) for v in value)
    return False


def _empty(value: Any) -> bool:
    return value is None or value in ("", [], {})


def validate_fields(
    contract: ModuleContract, values: dict[str, Any], evidence: dict[str, list[str]] | None = None
) -> list[FieldProblem]:
    """Check field values against the module's field types and declarative validators."""
    defs = {f.key: f for f in contract.fields}
    problems: list[FieldProblem] = []
    for key in values:
        if key not in defs:
            problems.append(FieldProblem(field=key, kind="unknown", message=f"no field {key}"))
    for key, defn in defs.items():
        value = values.get(key)
        if defn.required and _empty(value):
            problems.append(
                FieldProblem(field=key, kind="required", message=f"{defn.label} is required")
            )
        elif not _empty(value) and not _type_ok(defn, value):
            problems.append(
                FieldProblem(field=key, kind="type", message=f"{defn.label} must be {defn.type}")
            )
    for v in contract.validators:
        value = values.get(v.field)
        msg = v.message
        if v.kind == "required":
            if _empty(value) and not defs[v.field].required:
                problems.append(
                    FieldProblem(field=v.field, kind="required", message=msg or "required")
                )
            continue
        if v.kind == "requires_evidence":
            if not _empty(value) and not (evidence or {}).get(v.field):
                problems.append(
                    FieldProblem(
                        field=v.field,
                        kind="requires_evidence",
                        message=msg or "needs evidence or a confirmed assumption",
                    )
                )
            continue
        if _empty(value):
            continue
        bad = False
        if v.kind in ("min_length", "max_length") and isinstance(value, str | list):
            bad = len(value) < v.value if v.kind == "min_length" else len(value) > v.value
        elif v.kind in ("min", "max") and isinstance(value, int | float):
            bad = value < v.value if v.kind == "min" else value > v.value
        elif v.kind == "one_of":
            bad = value not in v.value
        elif v.kind == "pattern" and isinstance(value, str):
            # Bounded pattern (validated at contract load); fullmatch on bounded input.
            bad = re.fullmatch(v.value, value[:10_000]) is None
        if bad:
            problems.append(
                FieldProblem(field=v.field, kind=v.kind, message=msg or f"fails {v.kind}")
            )
    return problems


# --- the composer -------------------------------------------------------------------------


@dataclass
class _State:
    m: dict[str, ComposedModule]
    removed_by_user: set[str]
    added_by_user: set[str]
    problems: list[CompositionProblem]
    display: dict[str, int] = field(default_factory=dict)

    def problem(self, code: str, message: str, module: str | None = None, fatal: bool = True):
        if not any(p.code == code and p.module == module for p in self.problems):
            self.problems.append(
                CompositionProblem(code=code, message=message, module=module, fatal=fatal)
            )


def _policy(ctx: Context, key: str, contract: ModuleContract) -> tuple[str, PolicySource]:
    if key in ctx.company_required:
        return "required", "company"
    if key in ctx.company_disabled:
        return "disabled", "company"
    if key in ctx.company_optional:
        return "optional", "company"
    in_pack = any(key in modules for modules in ctx.packs.values())
    best: tuple[str, PolicySource] | None = None
    if in_pack:
        best = (contract.policy, "pack")
    entry = ctx.manifest.get(key)
    if entry is not None and (best is None or _RANK[entry.policy] > _RANK[best[0]]):
        best = (entry.policy, "template")
    return best or ("optional", "catalog")


def _role_ok(role: str, needed: str) -> bool:
    return role in ROLES and ROLES.index(role) >= ROLES.index(needed)


def _candidate_keys(ctx: Context, changes: Changes | None) -> list[str]:
    keys: list[str] = []
    for modules in ctx.packs.values():
        keys.extend(modules)
    keys.extend(sorted(ctx.manifest, key=lambda k: (ctx.manifest[k].sections, k)))
    keys.extend(ctx.company_required)
    if changes:
        keys.extend(changes.add)
    seen: set[str] = set()
    return [k for k in keys if not (k in seen or seen.add(k))]


def _version(ctx: Context, key: str, contract: ModuleContract) -> str:
    entry = ctx.manifest.get(key)
    return entry.version if entry is not None and entry.version else contract.version


def compose(ctx: Context, changes: Changes | None = None) -> Composition:  # noqa: C901
    st = _State(
        m={},
        removed_by_user=set(),
        added_by_user=set(),
        problems=[],
        display={k: c.display_order for k, c in ctx.contracts.items()},
    )
    pack_names = ", ".join(ctx.packs) or "no pack"

    # 1-3: candidates, policy and selection.
    for key in _candidate_keys(ctx, changes):
        contract = ctx.contracts.get(key)
        if contract is None:
            if key in ctx.company_required:
                st.problem(
                    "required_module_unavailable",
                    f"Company policy requires {key}, but it is archived or does not exist.",
                    key,
                )
            elif changes and key in changes.add:
                st.problem("unknown_module", f"{key} is not an available module.", key)
            elif key in ctx.unavailable:
                # A pack or manifest module the company archived is not offered; say so.
                st.problem(
                    "module_archived",
                    f"{key} is archived by the company, so it is not offered.",
                    key,
                    fatal=False,
                )
            continue
        policy, source = _policy(ctx, key, contract)
        mod = ComposedModule(
            key=key,
            version=_version(ctx, key, contract),
            policy="optional" if policy == "disabled" else policy,
            included=False,
            reason="",
            order=0,
            section_ids=_effective_sections(contract, ctx),
            title=contract.title,
            origin=ctx.origins.get(key, "builtin"),
            policy_source=source,
            depends_on=list(contract.depends_on),
            conflicts_with=list(contract.conflicts_with),
            layer_impact=_layer_impact(contract, ctx),
            required_review_role=contract.required_review_role,
        )
        st.m[key] = mod
        lines = mod.explanation
        if source == "company":
            lines.append(f"Company module policy: {policy}.")
        elif source == "pack":
            lines.append(f"Pack {pack_names}: {policy}.")
        elif source == "template":
            lines.append(
                f"Template {ctx.template_key} renders it in "
                f"{', '.join(ctx.manifest[key].sections)} ({policy})."
            )
        ev: Evaluation | None = None
        if contract.condition != ALWAYS:
            try:
                ev = evaluate(contract.condition, ctx.inputs)
            except ConditionError as e:
                mod.condition_error = f"{e.code}: {e}"
                mod.missing_information.append(f"Condition could not be evaluated: {e}")
            if ev is not None:
                mod.basis = _basis(ev, ctx)
                mod.score = ev.score
                mod.missing_information.extend(f"Input {p} is missing." for p in ev.missing)
                ids = {_uuid(e) for b in mod.basis if b.holds for e in b.evidence_ids}
                mod.driven_by = sorted(i for i in ids if i is not None)
        advisory = ctx.advisory.get(key)
        if advisory is not None:
            mod.score = advisory.score
            lines.append(
                f"Advisory signal {advisory.score:.2f}: {advisory.rationale} "
                "(advisory only; it never decides on its own)."
            )
        in_template = key in ctx.manifest
        if policy == "disabled":
            mod.selection, mod.decided_by = "optional", "policy"
            mod.reason = "Disabled by company module policy."
        elif policy == "required":
            mod.selection, mod.included, mod.decided_by = "mandatory", True, "policy"
            mod.reason = {
                "company": "Mandatory: company module policy requires it.",
                "pack": f"Mandatory in pack {pack_names}.",
                "template": f"Mandatory: template {ctx.template_key} is built around it.",
                "catalog": "Mandatory.",
            }[source]
        elif policy == "conditional" and ev is not None and ev.value:
            mod.selection, mod.included, mod.decided_by = "suggested", True, "condition"
            mod.reason = "Suggested: " + "; ".join(ev.reasons(held=True))
        else:
            mod.selection = "optional"
            if policy == "conditional":
                why = (
                    "its condition could not be evaluated"
                    if ev is None
                    else "its condition did not hold: " + "; ".join(ev.reasons())
                )
            else:
                why = "it is optional"
            if in_template:
                mod.included, mod.decided_by = True, "template"
                mod.reason = (
                    f"Kept: template {ctx.template_key} already has its sections, although {why}."
                )
            else:
                mod.decided_by = "none" if policy == "optional" else "condition"
                mod.reason = f"Not suggested: {why}."
        mod.questions = _questions(contract, ctx) if contract.question_prompts else []
        values = ctx.field_values.get(key)
        if values is not None:
            mod.field_problems = validate_fields(contract, values)
            mod.missing_information.extend(
                f"Field {p.field}: {p.message}." for p in mod.field_problems if p.kind == "required"
            )

    # 4: a person's changes.
    if changes:
        _apply_changes(ctx, st, changes)

    # 5: dependency closure and conflicts, to a fixpoint.
    for _ in range(len(st.m) + len(ctx.contracts) + 2):
        if not (_close(ctx, st) | _resolve_conflicts(ctx, st, changes)):
            break

    for mod in st.m.values():
        mod.required_by = sorted(
            k for k, other in st.m.items() if other.included and mod.key in other.depends_on
        )

    # 7 (structure): section ids must not collide.
    _check_sections(ctx, st)

    # 6: order.
    ordered = _order(ctx, st, changes)
    for i, key in enumerate(ordered):
        st.m[key].order = (i + 1) * 10
    excluded = sorted((k for k, mod in st.m.items() if not mod.included))
    modules = [st.m[k] for k in ordered] + [st.m[k] for k in excluded]
    out = Composition(
        template=ctx.template_key,
        template_version=ctx.template_version,
        packs=list(ctx.packs),
        modules=modules,
        problems=st.problems,
    )
    out.outline = outline(ctx, out)
    return out


def _apply_changes(ctx: Context, st: _State, ch: Changes) -> None:
    reason = (ch.reason or "").strip() or None
    if set(ch.add) & set(ch.remove):
        both = ", ".join(sorted(set(ch.add) & set(ch.remove)))
        st.problem("add_and_remove", f"{both} is both added and removed.")
    for key in ch.remove:
        mod = st.m.get(key)
        if mod is None or not mod.included:
            st.problem("not_included", f"{key} is not in the composition.", key)
            continue
        if mod.selection == "mandatory":
            st.problem(
                "required_module",
                f"{mod.title} is mandatory ({mod.reason}) and cannot be removed. "
                "Change the company module policy to make it optional first.",
                key,
            )
            continue
        if not _role_ok(ch.role, mod.required_review_role):
            st.problem(
                "role_required",
                f"Removing {mod.title} needs the {mod.required_review_role} role.",
                key,
            )
            continue
        mod.included, mod.decided_by, mod.user_reason = False, "user", reason
        mod.overridden_by = _uuid(ch.actor_id)
        mod.explanation.append(f"Removed by a person: {reason or 'no reason given'}.")
        st.removed_by_user.add(key)
    for key in ch.add:
        mod = st.m.get(key)
        if mod is None:
            continue  # reported as unknown_module
        if key in ctx.company_disabled:
            st.problem("module_disabled", f"{mod.title} is disabled by company policy.", key)
            continue
        if not _role_ok(ch.role, mod.required_review_role):
            st.problem(
                "role_required",
                f"Adding {mod.title} needs the {mod.required_review_role} role.",
                key,
            )
            continue
        st.added_by_user.add(key)  # the person's intent counts in conflicts
        if mod.included:
            continue
        mod.included, mod.decided_by, mod.user_reason = True, "user", reason
        mod.overridden_by = _uuid(ch.actor_id)
        mod.explanation.append(f"Added by a person: {reason or 'no reason given'}.")


def _uuid(value: str | None):
    import uuid

    try:
        return uuid.UUID(value) if value else None
    except ValueError:
        return None


def _close(ctx: Context, st: _State) -> bool:
    """Pull in dependencies of included modules; drop what cannot be satisfied."""
    changed = False
    for key in list(st.m):
        mod = st.m[key]
        if not mod.included:
            continue
        for dep in mod.depends_on:
            target = st.m.get(dep)
            unavailable = dep not in ctx.contracts or dep in ctx.company_disabled
            if dep in st.removed_by_user:
                st.problem(
                    "required_dependency",
                    f"{st.m[dep].title} cannot be removed: {mod.title} depends on it. "
                    f"Remove {mod.title} as well, or keep {st.m[dep].title}.",
                    dep,
                )
                continue
            if unavailable:
                if mod.selection == "mandatory" or key in st.added_by_user:
                    st.problem(
                        "unsatisfied_dependency",
                        f"{mod.title} needs {dep}, which is "
                        + (
                            "disabled by company policy."
                            if dep in ctx.contracts
                            else "unavailable."
                        ),
                        key,
                    )
                    continue
                mod.included, mod.decided_by = False, "dependency"
                mod.reason = f"Not included: it needs {dep}, which is unavailable."
                changed = True
                break
            if target is None:
                contract = ctx.contracts[dep]
                policy, source = _policy(ctx, dep, contract)
                target = ComposedModule(
                    key=dep,
                    version=_version(ctx, dep, contract),
                    policy="optional" if policy == "disabled" else policy,
                    included=False,
                    reason="",
                    order=0,
                    section_ids=_effective_sections(contract, ctx),
                    title=contract.title,
                    origin=ctx.origins.get(dep, "builtin"),
                    selection="optional",
                    policy_source=source,
                    depends_on=list(contract.depends_on),
                    conflicts_with=list(contract.conflicts_with),
                    layer_impact=_layer_impact(contract, ctx),
                    questions=_questions(contract, ctx),
                    required_review_role=contract.required_review_role,
                )
                st.m[dep] = target
            if not target.included:
                target.included, target.decided_by = True, "dependency"
                target.reason = f"Included because {mod.title} depends on it."
                target.explanation.append(f"Needed by {key}.")
                changed = True
    return changed


def _display_order(st: _State, key: str) -> int:
    return st.display.get(key, 100)


def _strength(st: _State, key: str) -> tuple:
    mod = st.m[key]
    return (
        mod.selection == "mandatory",
        key in st.added_by_user,
        mod.decided_by == "template",
        mod.selection == "suggested",
        mod.score or 0.0,
        -_display_order(st, key),
        key,
    )


def _resolve_conflicts(ctx: Context, st: _State, changes: Changes | None) -> bool:
    changed = False
    included = sorted(k for k, mod in st.m.items() if mod.included)
    for a in included:
        for b in st.m[a].conflicts_with + [k for k in included if a in st.m[k].conflicts_with]:
            if b == a or b not in st.m or not (st.m[a].included and st.m[b].included):
                continue
            ma, mb = st.m[a], st.m[b]
            if ma.selection == "mandatory" and mb.selection == "mandatory":
                st.problem(
                    "required_conflict",
                    f"{ma.title} and {mb.title} are both mandatory but conflict. "
                    "Change the company module policy.",
                    a,
                )
                continue
            user = st.added_by_user
            if (a in user and b in user) or (a in user and mb.selection == "mandatory"):
                st.problem(
                    "conflict",
                    f"{ma.title} conflicts with {mb.title}; remove {mb.title} to add it.",
                    a,
                )
                continue
            if b in user and ma.selection == "mandatory":
                st.problem(
                    "conflict",
                    f"{mb.title} conflicts with {ma.title}; remove {ma.title} to add it.",
                    b,
                )
                continue
            if a in user and b not in user and changes is not None:
                st.problem(
                    "conflict",
                    f"{ma.title} conflicts with {mb.title}; remove {mb.title} in the same change.",
                    a,
                )
                continue
            if b in user and a not in user and changes is not None:
                st.problem(
                    "conflict",
                    f"{mb.title} conflicts with {ma.title}; remove {ma.title} in the same change.",
                    b,
                )
                continue
            keep, drop = (a, b) if _strength(st, a) > _strength(st, b) else (b, a)
            st.m[drop].included, st.m[drop].decided_by = False, "conflict"
            st.m[drop].reason = f"Not included: it conflicts with {st.m[keep].title}."
            changed = True
    if changed:
        # A dropped module may leave a dependent without its dependency.
        for key, mod in st.m.items():
            if not mod.included:
                continue
            for dep in mod.depends_on:
                if dep in st.m and not st.m[dep].included and st.m[dep].decided_by == "conflict":
                    if mod.selection == "mandatory":
                        st.problem(
                            "unsatisfied_dependency",
                            f"{mod.title} needs {st.m[dep].title}, which conflicts with "
                            "another module.",
                            key,
                        )
                    else:
                        mod.included, mod.decided_by = False, "dependency"
                        mod.reason = f"Not included: its dependency {dep} conflicts."
    return changed


def _is_sources(mod: ComposedModule) -> bool:
    return SOURCES_SECTION in mod.section_ids


def _edges(ctx: Context, st: _State, keys: list[str]) -> set[tuple[str, str]]:
    """(before, after) pairs among ``keys`` from order_after/order_before and O1c."""
    present = set(keys)
    edges: set[tuple[str, str]] = set()
    for key in keys:
        contract = ctx.contracts[key]
        for other in contract.order_after:
            if other in present:
                edges.add((other, key))
        for other in contract.order_before:
            if other in present:
                edges.add((key, other))
    sources = [k for k in keys if _is_sources(st.m[k])]
    for s in sources:
        for k in keys:
            if k != s and not _is_sources(st.m[k]):
                edges.add((k, s))
    return edges


def _order(ctx: Context, st: _State, changes: Changes | None) -> list[str]:
    keys = [k for k, mod in st.m.items() if mod.included]
    edges = _edges(ctx, st, keys)
    default = _topological(ctx, st, keys, edges)
    if changes is None or changes.order is None:
        return default
    wanted = list(changes.order)
    if sorted(wanted) != sorted(keys) or len(set(wanted)) != len(wanted):
        missing = sorted(set(keys) - set(wanted))
        extra = sorted(set(wanted) - set(keys))
        st.problem(
            "order_mismatch",
            "The order must list every included module exactly once"
            + (f"; missing {', '.join(missing)}" if missing else "")
            + (f"; not included {', '.join(extra)}" if extra else "")
            + ".",
        )
        return default
    pos = {k: i for i, k in enumerate(wanted)}
    bad = sorted((a, b) for a, b in edges if pos[a] > pos[b])
    for a, b in bad:
        st.problem("order_violation", f"{st.m[a].title} must come before {st.m[b].title}.", b)
    if bad:
        return default
    for i, k in enumerate(wanted):
        if default[i] != k:
            st.m[k].explanation.append("Position set by a person.")
    return wanted


def _topological(
    ctx: Context, st: _State, keys: list[str], edges: set[tuple[str, str]]
) -> list[str]:
    """Kahn's algorithm; ties by display order, then id (deterministic)."""
    indegree = {k: 0 for k in keys}
    after: dict[str, list[str]] = {k: [] for k in keys}
    for a, b in edges:
        after[a].append(b)
        indegree[b] += 1
    heap = [(_display_order(st, k), k) for k in keys if indegree[k] == 0]
    heapq.heapify(heap)
    out: list[str] = []
    while heap:
        _, k = heapq.heappop(heap)
        out.append(k)
        for nxt in sorted(after[k]):
            indegree[nxt] -= 1
            if indegree[nxt] == 0:
                heapq.heappush(heap, (_display_order(st, nxt), nxt))
    if len(out) != len(keys):
        stuck = sorted(set(keys) - set(out))
        st.problem("order_cycle", f"Ordering constraints form a cycle among {', '.join(stuck)}.")
        out.extend(sorted(stuck, key=lambda k: (_display_order(st, k), k)))
    return out


def _check_sections(ctx: Context, st: _State) -> None:
    owner: dict[str, str] = {}
    template_keys = {s.key for s in ctx.template_sections}
    mapped = {s for e in ctx.manifest.values() for s in e.sections}
    for key in sorted(k for k, mod in st.m.items() if mod.included):
        mod = st.m[key]
        for s in mod.layer_impact.new_sections:
            if s in template_keys and s not in mapped:
                st.problem(
                    "section_collision",
                    f"{mod.title} adds section {s}, which the template already uses.",
                    key,
                )
            if s in owner:
                st.problem(
                    "section_collision",
                    f"{mod.title} and {st.m[owner[s]].title} both render section {s}.",
                    key,
                )
            owner[s] = key


# --- outline and skeleton -----------------------------------------------------------------


def outline(ctx: Context, comp: Composition) -> list[OutlineEntry]:
    """The document's sections in order: the template's own, then module sections inserted
    (brief ones before the full version, full ones before Sources and data points)."""
    owners: dict[str, str] = {}
    for mod in comp.included:
        for s in mod.layer_impact.template_sections:
            owners[s] = mod.key
    entries = [
        OutlineEntry(
            section_id=s.key,
            heading=s.heading,
            level=s.level,
            layer="brief" if s.brief else "full",
            module=owners.get(s.key),
            origin="template",
        )
        for s in ctx.template_sections
    ]
    brief_new: list[OutlineEntry] = []
    full_new: list[OutlineEntry] = []
    for mod in comp.included:
        impact = mod.layer_impact
        for s in impact.new_sections:
            entry = OutlineEntry(
                section_id=s,
                heading=_heading(mod, s),
                level=2,
                layer="brief" if s in impact.brief_sections else "full",
                module=mod.key,
                origin="module",
            )
            (brief_new if entry.layer == "brief" else full_new).append(entry)
    if not entries:
        return brief_new + full_new
    keys = [e.section_id for e in entries]
    full_at = keys.index("full") if "full" in keys else _first_full(entries)
    sources_at = keys.index(SOURCES_SECTION) if SOURCES_SECTION in keys else len(entries)
    sources_new = [e for e in full_new if e.section_id.startswith(SOURCES_SECTION)]
    full_new = [e for e in full_new if e not in sources_new]
    out = entries[:full_at] + brief_new + entries[full_at:sources_at] + full_new
    return out + entries[sources_at:] + sources_new


def _first_full(entries: list[OutlineEntry]) -> int:
    for i, e in enumerate(entries):
        if e.layer == "full":
            return i
    return len(entries)


def _heading(mod: ComposedModule, section: str) -> str:
    sections = mod.layer_impact.new_sections
    if len(sections) == 1 or section == sections[0]:
        return mod.title
    return f"{mod.title}: {section.replace('-', ' ')}"


__all__ = [
    "Advisory",
    "Basis",
    "Changes",
    "ComposedModule",
    "Composition",
    "Context",
    "LayerImpact",
    "ManifestEntry",
    "OutlineEntry",
    "CompositionProblem",
    "Provenance",
    "QuestionRef",
    "TemplateSection",
    "compose",
    "outline",
    "validate_fields",
]
