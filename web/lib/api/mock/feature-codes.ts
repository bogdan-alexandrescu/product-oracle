/**
 * Feature codes, as api/oracle/baseline/fixes.py gives them (codes-on-join): every feature has a
 * code, given when it joins the Ground Truth (created or confirmed), or by Give it a code. The
 * next code is the next F-number (two digits at least) over every feature code, every key a
 * feature had before (a code once given is never given again), every PRD code and every roadmap
 * item's PRD section; a slice of a coded feature gets its feature's code and the next letter; a
 * slice whose feature has no code keeps its key; a key that is a code is kept. A key a feature had
 * before stays its alias (fixes.former_keys, read from its revisions): service.find_entity finds
 * the feature by it. Only types are imported here, so ./baseline.ts and ./ground-truth.ts both use it.
 */
import type { BaselineState } from "./baseline";

type Entity = BaselineState["entities"][number];

/** Any feature code (F-15, F-15a), and a code a slice's feature lends its number from (F-15). */
export const ANY_CODE = /^[A-Z]{1,3}-\d+[a-j]?$/;
const WHOLE = /^[A-Z]{1,3}-\d+$/;
const F_NUMBER = /^F-(\d+)(?:\.\d+)?[A-J]?$/i;

/** fixes.former_keys: {a key a feature had before (its revisions): that feature's id}, the latest holder, not a key a feature has now. */
export function formerKeys(s: BaselineState): Map<string, string> {
  const features = new Map(s.entities.filter((e) => e.type === "feature").map((e) => [e.id, e] as const));
  const out = new Map<string, string>();
  for (const r of s.revisions ?? []) {
    if (!r.entity_id || !features.has(r.entity_id)) continue;
    const before = (r.before as { key?: unknown } | null)?.key;
    const after = (r.after as { key?: unknown } | null)?.key;
    if (typeof before === "string" && before && before !== after) out.set(before, r.entity_id);
  }
  for (const e of features.values()) out.delete(e.key);
  return out;
}

/** fixes.by_former_key: the feature that had `key` before, if no feature has it now. */
export function byFormerKey(s: BaselineState, key: string): Entity | undefined {
  const id = formerKeys(s).get(key);
  return id ? s.entities.find((e) => e.id === id) : undefined;
}

/** service.find_entity: the entity of that type and key; a feature also by a key it had before. */
export function findByKey(s: BaselineState, type: string, key: string): Entity | undefined {
  return s.entities.find((e) => e.type === type && e.key === key) ?? (type === "feature" && key ? byFormerKey(s, key) : undefined);
}

/** A feature as a person reads it: its code and name ("F-12 Weekly alert digest"), its name alone when it has no code. */
export function codeAndName(e: Entity): string {
  return ANY_CODE.test(e.key) ? `${e.key} ${e.title}` : e.title;
}

/**
 * fixes.next_code: the code `e` would be given, or why not. `seen`: the other codes the API reads
 * (every PRD's feature codes, every roadmap item's PRD section).
 */
export function nextFeatureCode(s: BaselineState, e: Entity, seen: string[]): { code: string } | { refused: string } {
  if (e.status !== "confirmed") return { refused: "This feature is not in the Ground Truth yet." };
  if (ANY_CODE.test(e.key)) return { refused: "This feature already has a code." };
  const taken = new Set([
    ...s.entities.filter((x) => x.type === "feature").map((x) => x.key),
    ...(s.codesGiven ?? []),
    ...formerKeys(s).keys(),
  ]);
  const parent = e.parent_id ? s.entities.find((x) => x.id === e.parent_id && x.type === "feature") : undefined;
  if (parent) {
    if (!WHOLE.test(parent.key)) return { refused: "Give its feature a code first." };
    const letter = [..."abcdefghij"].find((l) => !taken.has(`${parent.key}${l}`));
    return letter ? { code: `${parent.key}${letter}` } : { refused: "This feature has no slice letter left." };
  }
  const numbers = [...taken, ...seen]
    .map((k) => F_NUMBER.exec(k.trim().toUpperCase()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => Number(m[1]));
  return { code: `F-${String(Math.max(0, ...numbers) + 1).padStart(2, "0")}` };
}

/** Writes `code` as the feature's key, kept for Undo (Give it a code's DELETE) and never given again. */
export function setCode(s: BaselineState, e: Entity, code: string): void {
  (s.codeFrom ??= {})[e.id] = e.key;
  (s.codesGiven ??= []).push(code);
  e.key = code;
}

/** check.whole_code: a code as a feature is keyed by it, a slice's letter dropped (f-07a reads F-07). */
export function wholeCode(raw: unknown): string | null {
  const m = /^([a-z]{1,3})-(\d+)[a-j]?$/i.exec(String(raw ?? "").trim());
  return m ? `${m[1].toUpperCase()}-${m[2].padStart(2, "0")}` : null;
}

/** fixes.wanted_code: its Code attribute, else the one code of the roadmap items tied to it (`tied`). */
export function wantedCode(e: Entity, tied: string[]): string | null {
  const own = wholeCode((e.attrs as Record<string, unknown> | null)?.code);
  if (own) return own;
  const codes = [...new Set(tied.map(wholeCode).filter((c): c is string => !!c))];
  return codes.length === 1 ? codes[0] : null;
}

/** fixes._free: no other feature has `code`, now or as a code it gave back. */
export function codeFree(s: BaselineState, e: Entity, code: string): boolean {
  if (s.entities.some((x) => x.type === "feature" && x.id !== e.id && x.key === code)) return false;
  const former = formerKeys(s).get(code);
  return !former || former === e.id;
}

/**
 * fixes.code_on_join: a confirmed feature with no code gets its own code (wantedCode) when free, else its next code as its key; a code it
 * has is kept; a slice whose feature has no code keeps its key. The caller writes the revision.
 */
export function codeOnJoin(s: BaselineState, e: Entity, seen: string[], tied: string[] = []): void {
  if (e.type !== "feature" || e.status !== "confirmed") return;
  // Its own code first (its Code attribute, else its roadmap item's), when no other feature has it.
  const parent = e.parent_id ? s.entities.find((x) => x.id === e.parent_id && x.type === "feature") : undefined;
  const want = !ANY_CODE.test(e.key) && !parent ? wantedCode(e, tied) : null;
  if (want && codeFree(s, e, want)) return setCode(s, e, want);
  const next = nextFeatureCode(s, e, seen);
  if ("code" in next) setCode(s, e, next.code);
}
