import type { Schemas } from "@/lib/api/client";

export type InspectorOut = Schemas["InspectorOut"];
export type Recommendation = Schemas["RecommendationOut"];
export type Module = Schemas["InspectedModule"] | Schemas["ComposedModule"];
export type Problem = Schemas["CompositionProblem"];
/** Draft changes as the API takes them; `order` lists every included module, or null. */
export type Changes = { add: string[]; remove: string[]; order: string[] | null };

export const NO_CHANGES: Changes = { add: [], remove: [], order: null };

export type Filter = "all" | "mandatory" | "suggested" | "optional" | "excluded" | "problems";

export const FILTER_LABEL: Record<Filter, string> = {
  all: "All",
  mandatory: "Mandatory",
  suggested: "Suggested",
  optional: "Optional",
  excluded: "Excluded",
  problems: "Has problems",
};

export const SELECTION_LABEL: Record<Module["selection"], string> = {
  mandatory: "Mandatory",
  suggested: "Suggested",
  optional: "Optional",
};

const SELECTION_ORDER: Module["selection"][] = ["mandatory", "suggested", "optional"];

/** decided_by and policy_source in words, as the mockup labels them. */
export const DECIDED_BY: Record<Module["decided_by"], string> = {
  policy: "Policy",
  template: "Template",
  condition: "Condition holds",
  learning: "A kept learning",
  dependency: "Dependency",
  user: "A person",
  conflict: "Conflict",
  none: "Nobody yet",
};

export const POLICY_SOURCE: Record<Module["policy_source"], string> = {
  company: "Company policy",
  pack: "Pack policy",
  template: "Template",
  catalog: "Catalog",
};

export const KNOWLEDGE: Record<Schemas["Basis"]["knowledge_state"], string> = {
  verified_fact: "Verified fact",
  user_decision: "User decision",
  ai_inference: "AI inference",
  hypothesis: "Hypothesis",
  unknown: "Unknown",
};

export function hasProblems(m: Module): boolean {
  return m.field_problems.length > 0 || !!m.condition_error;
}

export function matches(m: Module, f: Filter): boolean {
  if (f === "all") return true;
  if (f === "excluded") return !m.included;
  if (f === "problems") return hasProblems(m);
  return m.selection === f;
}

/** Mandatory, Suggested, Optional; included modules in their order, then the excluded. */
export function sortModules(modules: Module[]): Module[] {
  return [...modules].sort(
    (a, b) =>
      SELECTION_ORDER.indexOf(a.selection) - SELECTION_ORDER.indexOf(b.selection) ||
      Number(b.included) - Number(a.included) ||
      a.order - b.order ||
      a.key.localeCompare(b.key),
  );
}

/** The section the API keeps last: a module rendering it comes after every other one. */
const SOURCES_SECTION = "sources";

/** The modules that must stay last in an order (they render the sources section). */
export function lastKeys(modules: Module[]): string[] {
  return modules.filter((m) => m.section_ids.includes(SOURCES_SECTION)).map((m) => m.key);
}

export function toggle(changes: Changes, key: string, included: boolean, last: string[] = []): Changes {
  const add = changes.add.filter((k) => k !== key);
  const remove = changes.remove.filter((k) => k !== key);
  const staged = changes.add.includes(key) || changes.remove.includes(key);
  // A custom order lists every included module: one leaving drops out, one coming goes last
  // but before the modules that must stay last (Sources and data points).
  const goesOut = staged ? changes.add.includes(key) : included;
  const order = changes.order && (goesOut ? changes.order.filter((k) => k !== key) : insertBefore(changes.order, key, last));
  if (staged) return { add, remove, order };
  return included ? { add, remove: [...remove, key], order } : { add: [...add, key], remove, order };
}

function insertBefore(order: string[], key: string, last: string[]): string[] {
  const at = order.findIndex((k) => last.includes(k));
  return at < 0 || last.includes(key) ? [...order, key] : [...order.slice(0, at), key, ...order.slice(at)];
}

/** The draft's included modules in order: its custom order, else the newest revision's
 * order with removals dropped and additions last. */
export function draftOrder(changes: Changes, modules: Module[]): string[] {
  return (
    changes.order ??
    modules
      .filter((m) => (m.included && !changes.remove.includes(m.key)) || changes.add.includes(m.key))
      .sort((a, b) => (a.included ? a.order : 1e9) - (b.included ? b.order : 1e9))
      .map((m) => m.key)
  );
}

/** Moves an included module one place up (-1) or down (+1) in the draft's order. */
export function move(changes: Changes, modules: Module[], key: string, by: -1 | 1): Changes {
  const order = draftOrder(changes, modules);
  const at = order.indexOf(key);
  const to = at + by;
  if (at < 0 || to < 0 || to >= order.length) return changes;
  const next = [...order];
  [next[at], next[to]] = [next[to], next[at]];
  return { ...changes, order: next };
}

/** The changes as the API's ChangesIn, or null for none. */
export function changesIn(c: Changes): { add: string[]; remove: string[]; order: string[] | null } | null {
  return c.add.length || c.remove.length || c.order ? { add: c.add, remove: c.remove, order: c.order } : null;
}

export type Diff = {
  added: Module[];
  removed: Module[];
  versionChanged: { key: string; title: string; before: string; after: string }[];
  reordered: boolean;
  material: boolean;
  affectedSections: string[];
};

/**
 * The preview against the revision in force, worked out as the API's RevisionDiff is
 * (added, removed, version_changed, reordered, material, affected_sections).
 */
export function diffOf(before: Module[], after: Module[]): Diff {
  const was = new Map(before.filter((m) => m.included).map((m) => [m.key, m]));
  const now = new Map(after.filter((m) => m.included).map((m) => [m.key, m]));
  const added = [...now.values()].filter((m) => !was.has(m.key));
  const removed = [...was.values()].filter((m) => !now.has(m.key));
  const versionChanged = [...now.values()]
    .filter((m) => was.has(m.key) && was.get(m.key)!.version !== m.version)
    .map((m) => ({ key: m.key, title: m.title, before: was.get(m.key)!.version, after: m.version }));
  const kept = (map: Map<string, Module>) =>
    [...map.values()]
      .filter((m) => was.has(m.key) && now.has(m.key))
      .sort((a, b) => a.order - b.order)
      .map((m) => m.key)
      .join(",");
  const reordered = kept(was) !== kept(now);
  const touched = new Set([...added, ...removed].map((m) => m.key).concat(versionChanged.map((v) => v.key)));
  const affectedSections = [...new Set([...before, ...after].filter((m) => touched.has(m.key)).flatMap((m) => m.section_ids))].sort();
  return { added, removed, versionChanged, reordered, material: touched.size > 0, affectedSections };
}

/** A revision's added and removed modules in one line, by name ("+ Risks · − Tool policies"). */
export function diffLine(d: Schemas["RevisionDiff"], titleOf: (key: string) => string): string {
  return [...d.added.map((k) => `+ ${titleOf(k)}`), ...d.removed.map((k) => `− ${titleOf(k)}`), ...d.version_changed.map((v) => `~ ${titleOf(v.key)} (newer version)`)].join(" · ");
}

/** A module key's name from the modules at hand, else the key in words ("tool policies"). */
export function titler(...lists: (Module[] | null | undefined)[]): (key: string) => string {
  const names = new Map<string, string>();
  for (const list of lists) for (const m of list ?? []) if (!names.has(m.key)) names.set(m.key, m.title);
  return (key) => names.get(key) ?? key.split(".").pop()!.replace(/[-_]/g, " ");
}

/** The modules a change touches, by name, for "approvals on … will be invalidated". */
export function touchedNames(added: string[], removed: string[], changed: string[], titleOf: (key: string) => string): string {
  const names = [...new Set([...added, ...removed, ...changed].map(titleOf))];
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The pack policy in words. */
export const PACK_POLICY: Record<string, string> = {
  required: "Required",
  conditional: "When it applies",
  optional: "Optional",
};

/** Where a module comes from, in words. */
export const ORIGIN: Record<string, string> = {
  builtin: "Built-in",
  company: "Company module",
  override: "Company version",
};

/** How the packs were picked, in words. */
export const PACKS_SOURCE: Record<string, string> = {
  chosen: "chosen by a person",
  default: "company default",
  category: "from the product category",
};

/** A review role in words ("owner" is "Owner"). */
export const ROLE: Record<string, string> = { viewer: "Viewer", commenter: "Commenter", approver: "Approver", owner: "Owner" };

/** A value a condition compares with, in words: "tool_use" is "Tool use". */
function valueInWords(v: unknown): string {
  if (Array.isArray(v)) return v.map(valueInWords).join(", ");
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (v == null) return "nothing";
  const s = String(v).replace(/[_-]+/g, " ").trim();
  return typeof v === "string" ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** An input's path as a phrase: "scope.capabilities" is "the scope's capabilities". */
function pathInWords(path: string): { phrase: string; many: boolean } {
  const parts = path.split(".").map((p) => p.replace(/[_-]+/g, " ").trim()).filter(Boolean);
  const last = parts.pop() ?? "";
  const owner = parts.join(" ");
  const phrase = owner ? `the ${owner}${owner.endsWith("s") ? "'" : "'s"} ${last}` : `the ${last}`;
  return { phrase, many: last.endsWith("s") };
}

/** The evaluator's operators in words, for one thing and for many. */
const OP_WORDS: Record<string, [string, string]> = {
  eq: ["is", "are"],
  ne: ["is not", "are not"],
  in: ["is one of", "are one of"],
  not_in: ["is none of", "are none of"],
  contains: ["includes", "include"],
  contains_any: ["includes any of", "include any of"],
  contains_all: ["includes all of", "include all of"],
  gt: ["is more than", "are more than"],
  gte: ["is at least", "are at least"],
  lt: ["is less than", "are less than"],
  lte: ["is at most", "are at most"],
  exists: ["is given", "are given"],
  present: ["is given", "are given"],
  missing: ["is not given", "are not given"],
  absent: ["is not given", "are not given"],
  truthy: ["is set", "are set"],
};
const NO_VALUE = new Set(["exists", "present", "missing", "absent", "truthy"]);

/** One condition in plain words: scope.capabilities contains 'tool_use' is "the scope's
 * capabilities include Tool use" (qa-docs-27: never the evaluator's own text). */
export function conditionInWords(b: { path: string; op: string; expected?: unknown }): string {
  const { phrase, many } = pathInWords(b.path);
  const op = OP_WORDS[b.op]?.[many ? 1 : 0] ?? b.op.replace(/_/g, " ");
  return NO_VALUE.has(b.op) ? `${phrase} ${op}` : `${phrase} ${op} ${valueInWords(b.expected)}`;
}

function joined(parts: string[]): string {
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Why a module is here, in plain words: the API's reason names a condition in the
 * evaluator's terms ("Suggested: scope.capabilities contains 'tool_use' (actual: …)"); it is
 * said from the module's basis instead ("Applies when the scope's capabilities include Tool use."). */
export function reasonInWords(m: Pick<Module, "reason" | "basis">): string {
  if (!m.basis.length) return m.reason;
  if (m.reason.startsWith("Suggested: ")) {
    const held = m.basis.filter((b) => b.holds);
    return `Applies when ${joined((held.length ? held : m.basis).map(conditionInWords))}.`;
  }
  const at = m.reason.indexOf("its condition did not hold");
  if (at >= 0) return `${m.reason.slice(0, at)}it applies only when ${joined(m.basis.map(conditionInWords))}.`;
  return m.reason;
}

/** A missing input in plain words: "Input scope.capabilities is missing." is "The scope's
 * capabilities are not given." */
export function missingInWords(line: string): string {
  const hit = /^Input (\S+) is missing\.$/.exec(line);
  if (!hit) return line;
  const { phrase, many } = pathInWords(hit[1]);
  return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)} ${many ? "are" : "is"} not given.`;
}
