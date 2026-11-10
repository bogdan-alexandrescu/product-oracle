/**
 * Simple S6 (#723): GET /v1/simple/priorities, as api/oracle/simple/priorities.py serves it,
 * over the mock's company-wide roadmap (./simple-roadmap.ts): each visible item stands for
 * its baseline feature, with an invented goal value and effort.
 *
 * Oracle's order is the goal_weighted ranking (oracle.priorities.scoring): rows serving a
 * goal first, by score = goal value x confidence / effort; then those serving none (flagged);
 * a prerequisite moves up to just before its highest-ranked dependent. People's pins
 * (`override_priority` changes, ./simple-changes.ts) apply after the formula, never above a
 * dependency. `estimate_feature` writes a person's goal value or effort, which the score uses.
 */
import type { Schemas } from "@/lib/api/client";
import { PLAN_PRD_SLUG, planOut, planSlices } from "./simple-plan";
import { closed, codedTitle, companyToday, goalRank, prdCode, roadmapOut, trackPrdTitles, TRACKS, type SeedItem, type SimpleDb } from "./simple-roadmap";
import { flowFor } from "./simple-visuals";
import { madeOrder } from "./made-order";
import { MOCK_SCENARIO_KEY, stableUuid } from "./ids";
import { COMPANY_SLUG, COMPANY_TITLE, OLD_ITEM } from "./one-roadmap";
import { seedGoalBuckets } from "./goal-buckets";

type Row = Schemas["SimplePriorityRow"];
type Item = Schemas["SimpleRoadmapItem"];
type Role = Schemas["Me"]["role"];
type Values = Record<string, unknown>;

export interface PrioritiesCtx {
  id: string;
  role: Role;
  owners: string[];
  names: Record<string, string>;
  roles?: Record<string, Role>;
}

/**
 * Each item's feature: Oracle's goal value (Σ goal weight x contribution) and effort in weeks;
 * `code`: the feature's own code (its key in the baseline), when it has one.
 */
const FEATURES: Record<string, { value: number; effort: number; code?: string }> = {
  "alert-rules": { value: 6, effort: 4 },
  "alert-digest": { value: 5, effort: 2 },
  "alert-mobile": { value: 4, effort: 3 },
  "alert-export": { value: 0, effort: 1 },
  // hotfix-2 ("simple-dated-move"): a 4-week feature dated only by engineering's end.
  "alert-replay": { value: 3, effort: 4 },
  "alert-sso": { value: 3, effort: 2 },
  "setup-checklist": { value: 4, effort: 2 },
  "setup-import": { value: 6, effort: 3, code: "F-12" },
  "setup-video": { value: 0, effort: 1 },
  "price-tiers": { value: 0, effort: 3 },
  // kr-in-priorities: the "goal-key-results" scenario's feature on a key result (server.ts).
  "kr-setup-list": { value: 5, effort: 3 },
};
/**
 * The "priorities-goal-no-value" scenario's invented feature: it serves a goal, but Oracle has no goal value for it (as
 * the API sends when the feature's goal has none), so it has no score and is drawn at goal value 0.
 */
const GOAL_NO_VALUE: SeedItem = { key: "alert-quiet-hours", title: "Quiet hours for alerts", horizon: "next", roadmap: "alerts-roadmap", goal: "grow-retention", track: "alerts", confidence: "medium" };
export const PRIORITIES_GOAL_NO_VALUE_SCENARIO = "priorities-goal-no-value";
const INVENTED: Record<string, { value: number | null; effort: number }> = { [GOAL_NO_VALUE.key]: { value: null, effort: 1 } };

/** The "priorities-goal-no-value" scenario's seed (server.ts): the roadmap holds its invented feature from the start. */
export function seedGoalNoValue(db: SimpleDb): void {
  db.items.push({ ...GOAL_NO_VALUE });
  db.ids[GOAL_NO_VALUE.key] = stableUuid(`simple-item/${GOAL_NO_VALUE.key}`);
}

/**
 * qa-prio-twins ("priorities-twins", on "one-roadmap"): one feature known to more than one record. Trusted seller
 * badge (only an older roadmap holds it) has a draft on the company roadmap linked to it; a second Block list draft
 * links to nothing; a second Queue backpressure item is its own feature. Invented data.
 */
export const PRIORITIES_TWINS_SCENARIO = "priorities-twins";
export const TWINS = { draft: OLD_ITEM, unlinked: "Block list", item: "Queue backpressure" } as const;
export function seedPrioritiesTwins(db: SimpleDb): void {
  const add = (s: SeedItem) => {
    db.items.push(s);
    db.ids[s.key] = stableUuid(`simple-item/${s.key}`);
  };
  add({ key: "trusted-badge-draft", title: TWINS.draft, horizon: "later", roadmap: COMPANY_SLUG, feature: "trusted-badge", draft: true, confidence: "high", source: "engineering" });
  add({ key: "block-list-copy", title: TWINS.unlinked, horizon: "later", roadmap: COMPANY_SLUG, draft: true, confidence: "medium", source: "engineering" });
  add({ key: "queue-backpressure-2", title: TWINS.item, horizon: "later", roadmap: COMPANY_SLUG, confidence: "low", source: "engineering" });
  // Oracle only proposed these two: they rank, but have no mark (Show's All still counts them).
  db.proposed_features = ["block-list", "queue-backpressure"];
}

/** qa-prio-twins (priorities.same_name): two names are the same, case and spacing aside. */
const sameName = (t: string | null | undefined): string => (t ?? "").split(/\s+/).filter(Boolean).join(" ").toLowerCase();

/**
 * The "priorities-plan-goal-names" scenario (the owner, Nov 8: a plan goal and a goal record with one name are two
 * goals): "simple-plan", whose plan names a goal "Activation", where Alert rules' own goal record is also
 * "Activation". Invented data.
 */
export const PRIORITIES_PLAN_GOAL_NAMES_SCENARIO = "priorities-plan-goal-names";
export function seedPlanGoalNames(db: SimpleDb): void {
  const rules = db.items.find((s) => s.key === "alert-rules");
  if (!rules) throw new Error(`${PRIORITIES_PLAN_GOAL_NAMES_SCENARIO}: the seed has no Alert rules engine (alert-rules) to give the goal "Activation"`);
  rules.goal = "activation";
}

/**
 * The "priorities-plan-goal-codes" scenario: "simple-plan", whose plan has two goals named Activation with their own
 * codes (G1 Activation: Bulk import, Help center search; G3 Activation: Onboarding emails), two goals. Invented data.
 */
export const PRIORITIES_PLAN_GOAL_CODES_SCENARIO = "priorities-plan-goal-codes";
export function seedPlanGoalCodes(db: SimpleDb): void {
  if (!db.plan) throw new Error(`${PRIORITIES_PLAN_GOAL_CODES_SCENARIO}: the seed has no plan to give two Activation goals`);
  db.plan.coded_goals = true;
}

/**
 * The "priorities-plan-one-week" scenario: "simple-plan" with M1's capacity 1 engineer-week (its planned weeks run
 * over it, and it has no name) and Self-serve checkout's M2 part 1 week. Invented data.
 */
export const PRIORITIES_PLAN_ONE_WEEK_SCENARIO = "priorities-plan-one-week";
export function seedPlanOneWeek(db: SimpleDb): void {
  if (!db.plan) throw new Error(`${PRIORITIES_PLAN_ONE_WEEK_SCENARIO}: the seed has no plan to give a 1-week milestone`);
  db.plan.one_week = true;
}

/**
 * The "priorities-plan-goal-twins" scenario: "simple-plan", whose plan names Activation twice with no code (the
 * owner's pick: one goal, one shape). Invented data.
 */
export const PRIORITIES_PLAN_GOAL_TWINS_SCENARIO = "priorities-plan-goal-twins";
export function seedPlanGoalTwins(db: SimpleDb): void {
  if (!db.plan) throw new Error(`${PRIORITIES_PLAN_GOAL_TWINS_SCENARIO}: the seed has no plan to name Activation twice`);
  db.plan.twin_goals = true;
}

/**
 * kr-in-priorities, the "priorities-plan-key-results" scenario: "simple-plan" whose Ground Truth holds Growth as a goal
 * and Activation, a plan goal, as its key result (a subgoal); Help center search (F-20, an Activation slice) is not a
 * goal-bucket feature yet, so only its slice names its goal. Invented data.
 */
export const PRIORITIES_PLAN_KEY_RESULTS_SCENARIO = "priorities-plan-key-results";
export function seedPlanKeyResults<E extends { id: string; key: string; title: string; type: string; status: string; parent_id?: string | null; attrs?: Record<string, unknown> | null }>(entities: E[], db: SimpleDb): void {
  const template = entities.find((e) => e.type === "goal" && e.status === "confirmed");
  if (!template || !db.plan) throw new Error(`${PRIORITIES_PLAN_KEY_RESULTS_SCENARIO}: the seed has no goal or no plan`);
  const growth = { ...template, id: stableUuid("simple-goal/plan-growth"), key: "plan-growth", title: "Growth", parent_id: null, attrs: { metric: "Weekly active teams", weight: 1 } };
  entities.push(growth, { ...template, id: stableUuid("simple-goal/plan-activation"), key: "plan-activation", title: "Activation", parent_id: growth.id, attrs: { metric: "Teams that finish setup in a day", weight: 1 } });
  const gb = (db.goal_buckets = seedGoalBuckets());
  gb.features = gb.features.filter((f) => f.key !== "F-20");
}

/** The "simple-plan" scenario's existing items the plan names (server.ts seedSimplePlanScenario). */
const PLAN_EXISTING: Record<string, string> = { "setup-checklist": "F-01", "setup-import": "F-02" };

/** An item's code in the plan (plan-f-07: F-07; an existing item the plan names: its code), with a plan. */
function planCode(db: SimpleDb, key: string): string | null {
  if (!db.plan) return null;
  const m = /^plan-f-(\d+)$/.exec(key);
  return m ? `F-${m[1]}` : (PLAN_EXISTING[key] ?? null);
}

/**
 * The baseline feature key of an item: its plan code, else its own code, else its key (as Priorities
 * reads it); an item added for a feature (SeedItem.feature) reads that feature's.
 */
export function featureKeyOf(db: SimpleDb, key: string): string {
  const k = featureOf(db, key);
  return planCode(db, k) ?? FEATURES[k]?.code ?? k;
}

/** The plan's engineer-weeks of a feature across its slices; null when it is all PM-owned (no engineer-weeks, as plan.py). */
function planWeeks(code: string): number | null {
  const of = planSlices().filter((x) => x.feature_code === code);
  if (!of.length) return null;
  return of.every((x) => x.effort_weeks == null) ? null : of.reduce((n, x) => n + (x.effort_weeks ?? 0), 0);
}

/**
 * The "simple-plan" scenario's items (plan-f-07 ...): their effort is the plan's engineer-weeks
 * across their slices (PM-owned work: none, so no score), their goal value invented from the code.
 */
function planFeature(key: string): { value: number; effort: number | null } | null {
  const m = /^plan-f-(\d+)$/.exec(key);
  if (!m) return null;
  return { value: ((Number(m[1]) * 5) % 7) + 1, effort: planWeeks(`F-${m[1]}`) };
}
const CONFIDENCE: Record<string, number> = { high: 0.8, medium: 0.5, low: 0.3 };

const round = (n: number): number => Math.round(n * 1000) / 1000;
const featureId = (itemId: string): string => `feature-${itemId}`;
/** The key of the item standing for `key`'s feature: its own, or the one it was added for (SeedItem.feature). */
const featureOf = (db: SimpleDb, key: string): string => db.items.find((s) => s.key === key)?.feature ?? key;
/** An item's feature id: one per feature, whichever roadmap's item stands for it. */
const featureOfItem = (db: SimpleDb, i: { key: string; id: string }): string => featureId(db.ids[featureOf(db, i.key)] ?? i.id);

/** The key of the item standing for the feature `fid`, undefined for no such feature. */
export function featureItem(db: SimpleDb, fid: string): string | undefined {
  return Object.keys(db.ids).find((k) => featureId(db.ids[k]) === fid && !db.items.find((s) => s.key === k)?.feature);
}

/**
 * targets.add_to_company: the company roadmap's item of the feature `fid`, added under Later (its
 * draft there confirmed rather than a second item added); the feature's own item while there is no
 * company roadmap (a move then ranks the feature alone); undefined for no such feature.
 */
export function addToCompany(db: SimpleDb, fid: string, seen: SimpleDb = db): string | { refused: string } | undefined {
  const base = featureItem(db, fid);
  const src = base ? db.items.find((s) => s.key === base) : undefined;
  if (!base || !src) return undefined;
  const slug = db.company_roadmap;
  if (!slug) return base;
  const there = db.items.filter((s) => s.roadmap === slug && featureOf(db, s.key) === base && !closed(s) && s.status !== "cut");
  const kept = there.find((s) => !s.draft) ?? there[0];
  if (kept) {
    kept.draft = false;
    return kept.key;
  }
  // every-field (targets.add_to_company): its code is no other item's own, a title's (its slices share it), in set_code's words.
  const code = (src.feature_id && db.feature_codes?.[src.feature_id]) || codedTitle(src.title, prdCode(src.section))[0];
  const other = code ? seen.items.find((x) => x.roadmap === slug && !x.trashed && x.key !== base && x.feature !== base && !(x.feature_id && seen.feature_codes?.[x.feature_id]) && !prdCode(x.section) && codedTitle(x.title, null)[0]?.toUpperCase() === code.toUpperCase()) : undefined;
  if (code && other) return { refused: `${code} is already the code of ${code} ${codedTitle(other.title, null)[1]}` };
  let key = base;
  for (let n = 2; db.ids[key]; n++) key = `${base}-${n}`;
  const row: SeedItem = { key, title: src.title, horizon: "later", roadmap: slug, feature: base, confidence: src.confidence, source: "engineering", goal: src.goal };
  db.items.push(row);
  db.ids[key] = stableUuid(`simple-item/${key}`);
  return key;
}

/**
 * prio-company (priorities._items): every feature ranks, so a feature with no item on the company
 * roadmap is a row with no item; the item another roadmap holds for it stands for it here.
 */
function offCompany(db: SimpleDb, on: Item[]): Item[] {
  const slug = db.company_roadmap;
  if (!slug) return [];
  const held = new Set(on.filter((i) => !i.draft).map((i) => featureOf(db, i.key)));
  // priorities.compute ranks every feature, a replaced PRD's too (service.load leaves out only its
  // items): read every roadmap's items, a replaced PRD's included.
  const replaced = db.replaced_prds;
  db.company_roadmap = undefined;
  db.replaced_prds = undefined;
  try {
    return roadmapOut(db, "owner", new URLSearchParams())!.items.filter((i) => db.items.find((s) => s.key === i.key)?.roadmap !== slug && !i.draft && !held.has(featureOf(db, i.key)));
  } finally {
    db.company_roadmap = slug;
    db.replaced_prds = replaced;
  }
}

const FEATURE_CODE = /^[A-Z]{1,3}-\d+$/;

/** Initials of up to three words of `name` (Team invite nudges TIN); a one-word name's first two letters (Pricing PR); then the name's first number, if it has one (Pay 1 PA1). */
function initials(name: string): string {
  const words = name.match(/\p{L}+/gu) ?? [];
  const number = name.match(/\d+/)?.[0] ?? "";
  if (words.length >= 2) return words.slice(0, 3).map((w) => w[0]).join("").toUpperCase() + number;
  return `${words[0] ?? ""}xx`.slice(0, 2).toUpperCase() + number;
}

/**
 * priorities.short_codes: each feature's short code, for feature keys in creation order: the
 * key when it is a code (F-12), else its PRD section's code (F-06), else the initials of its
 * shown name (`names`, by key; the key when it has none) and its number (Pay 1 PA1), a digit
 * added on a clash in creation order (SC, SC2; PA1.2 after a number), so every reader reads the same code, a rename moves it, and a new feature
 * never renames an older one.
 */
export function shortCodes(keys: string[], prd: Record<string, string> = {}, names: Record<string, string> = {}): string[] {
  const out: (string | null)[] = keys.map((k) => (FEATURE_CODE.test(k) ? k : null));
  const taken = new Set(out.filter((c): c is string => c !== null));
  // The walk: a feature whose item came from a PRD section with a code (f-06) reads F-06.
  keys.forEach((k, i) => {
    if (out[i] === null && prd[k] && !taken.has(prd[k])) {
      out[i] = prd[k];
      taken.add(prd[k]);
    }
  });
  keys.forEach((k, i) => {
    if (out[i] !== null) return;
    const base = initials(names[k]?.trim() || k);
    const sep = /\d$/.test(base) ? "." : "";
    let code = base;
    for (let n = 2; taken.has(code); n++) code = `${base}${sep}${n}`;
    taken.add(code);
    out[i] = code;
  });
  return out as string[];
}

function quarter(today: string): Schemas["SimpleQuarter"] {
  const d = new Date(`${today}T00:00:00Z`);
  const q = Math.floor(d.getUTCMonth() / 3);
  const start = new Date(Date.UTC(d.getUTCFullYear(), q * 3, 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(d.getUTCFullYear(), q * 3 + 3, 0)).toISOString().slice(0, 10);
  return { start, end, label: `Q${q + 1} ${d.getUTCFullYear()}` };
}

/** The values stored for an item's non-versioned targets (./simple-changes.ts `db.targets`). */
function stored(db: SimpleDb, itemId: string): Values {
  return db.targets?.[itemId] ?? {};
}

/** A person's estimates, else the feature's: [goal value, effort, whether the value is a person's]. */
export function estimates(db: SimpleDb, key: string, itemId: string): { value: number | null; effort: number | null; valueEstimated: boolean } {
  // An item added for another's feature (SeedItem.feature) reads that feature's estimates, its own over them.
  const base = featureOf(db, key);
  if (base !== key) {
    const was = estimates(db, base, db.ids[base]);
    const s = stored(db, itemId);
    const value = typeof s.goal_value === "number" ? s.goal_value : null;
    return { value: value ?? was.value, effort: typeof s.effort === "number" ? s.effort : was.effort, valueEstimated: value !== null || was.valueEstimated };
  }
  // A feature the mock does not list has no effort until a person estimates it (the API reads none, not 1 week).
  const own = FEATURES[key] ?? planFeature(key) ?? INVENTED[key] ?? { value: 0, effort: null };
  // With a plan, an existing item the plan names takes the plan's engineer-weeks (one effort on every tab).
  const code = db.plan ? PLAN_EXISTING[key] : undefined;
  const f = code ? { ...own, effort: planWeeks(code) ?? own.effort } : own;
  const s = stored(db, itemId);
  return {
    value: typeof s.goal_value === "number" ? s.goal_value : f.value,
    effort: typeof s.effort === "number" ? s.effort : f.effort,
    valueEstimated: typeof s.goal_value === "number",
  };
}

/**
 * service.efforts: an item's effort for its estimated start, as estimates reads it (null for a
 * feature the mock does not list that no person estimated: the API reads no effort, not 1 week).
 */
export function startEffort(db: SimpleDb, key: string, itemId: string): number | null {
  return estimates(db, key, itemId).effort;
}

/** targets.py's `before` of estimate_feature and override_priority, as stored now. */
export function priorityBefore(db: SimpleDb, key: string, op: string, itemId: string): Values {
  if (op === "estimate_feature") {
    const e = estimates(db, key, itemId);
    return { goal_value: e.valueEstimated ? e.value : null, effort: e.effort };
  }
  return { override: (stored(db, itemId).override as Values | undefined) ?? null };
}

/** targets.py's stored `after` of the two ops (a pin at a rank; the estimates rounded). */
export function priorityAfter(op: string, after: Values): Values | string {
  if (op === "override_priority") {
    // after.clear: back to Oracle's rank (targets.py), the active override ends.
    if (after.clear === true) return { override: null };
    const pos = after.position;
    const reason = String(after.reason ?? "").trim();
    if (typeof pos !== "number" || pos < 1) return "after.position: a rank from 1 (the top)";
    if (!reason || /[\r\n]/.test(reason)) return "after.reason: why, in one line of 1 to 500 characters";
    return { override: { kind: "pin", position: pos, above_feature_id: null, reason } };
  }
  const out: Values = {};
  for (const k of ["goal_value", "effort"]) {
    if (!(k in after)) continue;
    const v = Number(after[k]);
    // qa-simple-plan-6: a goal value goes down to 0; an effort stays above 0 (targets.py).
    if (k === "goal_value" ? !(v >= 0) : !(v > 0)) return `after.${k}: a number ${k === "goal_value" ? "0 or more" : "above 0"}`;
    out[k] = Math.round(v * 10) / 10;
  }
  return Object.keys(out).length ? out : "after: goal_value or effort";
}

function depsOf(item: Item, byId: Map<string, Item>): string[] {
  return item.depends_on.filter((d) => byId.has(d));
}

/** scoring.dependency order: a prerequisite moves up to just before its highest-ranked dependent. */
function dependencyOrder(sorted: Item[], byId: Map<string, Item>): Item[] {
  const out: Item[] = [];
  const placed = new Set<string>();
  const place = (i: Item, stack: Set<string>) => {
    if (placed.has(i.id) || stack.has(i.id)) return;
    stack.add(i.id);
    for (const d of depsOf(i, byId)) place(byId.get(d)!, stack);
    placed.add(i.id);
    out.push(i);
  };
  for (const i of sorted) place(i, new Set());
  return out;
}

function ancestors(id: string, byId: Map<string, Item>, seen = new Set<string>()): Set<string> {
  for (const d of depsOf(byId.get(id)!, byId)) {
    if (seen.has(d)) continue;
    seen.add(d);
    ancestors(d, byId, seen);
  }
  return seen;
}

/** The latest override_priority change that holds for this item (applied or accepted, not undone). */
function activeOverride(db: SimpleDb, itemId: string): Schemas["SimpleChangeOut"] | undefined {
  const cs = db.changes ?? [];
  const last = madeOrder(
    cs.filter((c) => c.op === "override_priority" && c.target.item_id === itemId && ["applied", "accepted"].includes(c.status) && !cs.some((u) => u.undoes_id === c.id)),
    (c) => [c.decided_at ?? c.at],
  ).at(-1);
  // The last one a clear (back to Oracle's rank): no override.
  return last?.after.override ? last : undefined;
}

type Line = Schemas["SimpleLine"];
const NOW_LINE: Line = { key: "now", kind: "now", label: "This quarter (Now)", date: null };

const lineDay = (d: string): string => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * priorities._same_as: what makes a milestone the same as another on its day, by the roadmap
 * chart's rule (roadmap/_lib.ts drawnKeyDates): its code ("M1"), or its name without the code
 * ("prove it", in lower case).
 */
const sameAs = (name: string, day: string): string[] => {
  const words = name.replace(/^[A-Z][A-Z0-9]*-?[0-9]+[a-z]?\s*[·:.\-–—]?\s*/, "").trim().toLowerCase();
  return [`${name.split(/[\s·]/)[0]}|${day}`, ...(words ? [`~${words}|${day}`] : [])].sort();
};

/**
 * priorities.lines: Now, each key date and each dated milestone the reader sees. The key dates
 * are the roadmap read's own (roadmapOut's keyDatesOut, as key_dates.read_key_dates serves
 * both pages): a PRD's milestones among them, each naming its PRD. prio-line-once: a milestone
 * with a PRD key date's name on its day is left out (listed once, "From the PRD"); `same` is
 * the key date's line by the left-out milestone's key, so a saved pick of it draws that line.
 */
/** priorities.readable: a template's lone "N" placeholder ("Milestone N agents") is no name; "Beta [internal]" is one. */
const readable = (name: string | null | undefined): string | null => {
  const n = (name ?? "").trim();
  return n && !/(^|\s)N(\s|$)/.test(n) ? n : null;
};

/** priorities._code_of: a milestone's code ("M1" of "M1 · Measured"), null for a name with none. */
const codeOf = (name: string): string | null => (/^[A-Z][A-Z0-9]*-?[0-9]+[a-z]?/.test(name) ? name.split(/[\s·:.–—]/)[0] : null);

function linesOf(read: Schemas["SimpleRoadmapOut"], prdsOfTrack: (trackId: string) => string[]): { lines: Line[]; same: Map<string, Line> } {
  const tracks = new Set(read.items.map((i) => i.track?.id).filter(Boolean));
  // prio-company: each line names its PRD (a milestone its track's); a PRD's code on any day, or a line already listed, once.
  // tracks-goal: a track's PRDs (track.prd_ids) by title; those on the roadmap read, and every PRD's id.
  const onRoadmap = new Map(read.items.flatMap((i) => (i.prd ? [[i.prd.title, i.prd] as const] : [])));
  const idOf = new Map([...(read.key_dates ?? []).flatMap((k) => (k.prd ? [[k.prd.title, k.prd.id] as const] : [])), ...[...onRoadmap].map(([t, p]) => [t, p.id] as const)]);
  const keyDates = (read.key_dates ?? []).filter((k) => readable(k.name)).map((k): Line => ({ key: `key_date:${k.id}`, kind: "key_date", label: `${k.name} · ${lineDay(k.date)}`, date: k.date, prd: k.prd ?? null }));
  const fromPrd = new Map<string, Line>();
  const byCode = new Map<string, Line>();
  (read.key_dates ?? []).filter((k) => readable(k.name)).forEach((k, i) => {
    if (!k.prd) return;
    sameAs(k.name, k.date).forEach((x) => fromPrd.has(x) || fromPrd.set(x, keyDates[i]));
    const code = codeOf(k.name);
    if (code && !byCode.has(`${k.prd.id}|${code}`)) byCode.set(`${k.prd.id}|${code}`, keyDates[i]);
  });
  const same = new Map<string, Line>();
  const milestones: Line[] = [];
  const seen = new Map(keyDates.map((l) => [`${l.label}|${l.prd?.id ?? ""}`, l]));
  for (const m of read.milestones) {
    if (!m.date || !tracks.has(m.track_id) || m.status === "dropped" || !readable(m.name)) continue;
    const key = `milestone:${m.id}`;
    // tracks-goal: a track milestone reads the first of the track's PRDs on the roadmap; its code is looked up in each of them.
    const titles = prdsOfTrack(m.track_id);
    const prd = titles.map((t) => onRoadmap.get(t)).find(Boolean);
    const ref = prd ? { id: prd.id, slug: prd.slug, title: prd.title } : null;
    const label = `${m.name} · ${lineDay(m.date)}`;
    const code = codeOf(m.name);
    const coded = code ? titles.map((t) => byCode.get(`${idOf.get(t)}|${code}`)).find(Boolean) : undefined;
    const kd = sameAs(m.name, m.date).map((x) => fromPrd.get(x)).find(Boolean) ?? coded ?? seen.get(`${label}|${ref?.id ?? ""}`);
    if (kd) same.set(key, kd);
    else {
      const ln: Line = { key, kind: "milestone", label, date: m.date, prd: ref };
      seen.set(`${label}|${ref?.id ?? ""}`, ln);
      milestones.push(ln);
    }
  }
  // Key dates and milestones in date order, one list (Now first).
  return { lines: [NOW_LINE, ...[...keyDates, ...milestones].sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : 0))], same };
}

/** priorities.pick_line: the line named among those offered (or a left-out milestone's key date: `same`), or a picked day; else Now. */
function pickLine(key: string | null, offered: Line[], same?: Map<string, Line>): Line {
  if (key?.startsWith("date:")) {
    const day = key.slice(5);
    // A day before 2000 is a half-typed one (year 1), never a line (priorities.FIRST_LINE_YEAR).
    return /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(day)) && Number(day.slice(0, 4)) >= 2000 ? { key, kind: "date", label: `By ${lineDay(day)}`, date: day } : NOW_LINE;
  }
  return (key ? same?.get(key) : undefined) ?? offered.find((x) => x.key === key) ?? NOW_LINE;
}

/**
 * The "priorities-bucket-only" scenario: a Goal bucket lists a feature the ranked rows do not
 * (the first goal's first feature), so its bucket row opens the feature panel by its code (S-3).
 */
export const PRIORITIES_BUCKET_ONLY_SCENARIO = "priorities-bucket-only";

export function prioritiesOut(
  db: SimpleDb,
  ctx: PrioritiesCtx,
  route: (c: Schemas["SimpleChangeOut"]) => string[],
  decides: (itemId: string) => boolean,
  lineKey: string | null = null,
): Schemas["SimplePrioritiesOut"] {
  const today = companyToday();
  const read = roadmapOut(db, ctx.role, new URLSearchParams(), { id: ctx.id, role: ctx.role })!;
  const trackKeys = new Map(Object.keys(TRACKS).map((k) => [stableUuid(`simple-track/${k}`), k]));
  const { lines, same } = linesOf(read, (id) => {
    const k = trackKeys.get(id);
    return k ? trackPrdTitles(db, k) : [];
  });
  const line = pickLine(lineKey, lines, same);
  const readItems = new Map(read.items.map((i) => [i.id, i]));
  // A cut draft reads as "draft" on the roadmap: the seed says it is cut (as the API's cut set).
  // S7: a draft merged into another is closed too.
  const cut = new Set(db.items.filter((s) => closed(s)).map((s) => s.key));
  const live = read.items.filter((i) => i.status !== "cut" && !cut.has(i.key));
  // Every feature ranks (the baseline is company-wide); one whose item the reader may not see
  // is a row with no item, never reorderable (priorities.py).
  const seen = new Set(read.items.map((i) => i.id));
  const on = roadmapOut(db, "owner", new URLSearchParams())!.items.filter((i) => i.status !== "cut" && !cut.has(i.key));
  const all = [...on, ...offCompany(db, on).filter((i) => i.status !== "cut" && !cut.has(i.key))];
  // A draft item is never ranked (priorities.py `_items`): it sits under "Not ranked yet", with no
  // row and no bucket weeks. Here each item stands for its own feature, so a draft has no row at all.
  // prio-unranked: an item linked to no feature (its seed's feature_id null, as the Ground Truth
  // scenario's Export to sheets) has no ranked feature: no row, listed in `unranked` instead.
  const noFeature = (i: Item) => db.items.find((s) => s.key === i.key)?.feature_id === null;
  const ranked = all.filter((i) => !i.draft && !noFeature(i));
  const byId = new Map(ranked.map((i) => [i.id, i]));
  const keyOf = (i: Item) => i.key;
  const score = new Map<string, number>();
  for (const i of ranked) {
    const e = estimates(db, keyOf(i), i.id);
    // No effort (PM-owned work): no score (scoring.py's missing_inputs), ranked after the scored.
    // No goal value (a goal Oracle has none for): no score either.
    if (e.effort && e.value != null) score.set(i.id, round((e.value * (CONFIDENCE[i.confidence ?? ""] ?? 0.5)) / e.effort));
  }
  const sc = (id: string): number => score.get(id) ?? -1;
  const sorted = [...ranked].sort((a, b) => Number(!a.goal) - Number(!b.goal) || sc(b.id) - sc(a.id) || a.title.localeCompare(b.title));
  const oracle = dependencyOrder(sorted, byId);
  const oracleRank = new Map(oracle.map((i, n) => [i.id, n + 1]));
  // People's pins, oldest first; never above a dependency.
  let yours = [...oracle];
  const pins = ranked
    .map((i) => ({ i, c: activeOverride(db, i.id) }))
    .filter((x) => x.c)
    .sort((a, b) => ((a.c!.decided_at ?? a.c!.at) < (b.c!.decided_at ?? b.c!.at) ? -1 : 1));
  for (const { i, c } of pins) {
    const pos = Number((c!.after.override as Values).position);
    yours = yours.filter((x) => x.id !== i.id);
    yours.splice(Math.min(pos - 1, yours.length), 0, i);
  }
  yours = dependencyOrder(yours, byId);
  const can = ctx.role !== "viewer";
  // qa-prio-twins (priorities._held): a feature's live draft on the roadmap the reader sees, by its link.
  const draftOf = (i: Item) => live.find((d) => d.draft && d.key !== i.key && featureOfItem(db, d) === featureOfItem(db, i));
  const rows: Row[] = yours.map((i, n) => {
    const e = estimates(db, keyOf(i), i.id);
    const above = yours.slice(0, n);
    let after: Row["after"] = null;
    if (above.some((a) => sc(a.id) < sc(i.id))) {
      const anc = ancestors(i.id, byId);
      const dep = [...above].reverse().find((a) => anc.has(a.id));
      if (dep) after = { code: dep.key, title: dep.title };
    }
    const o = activeOverride(db, i.id);
    const mine = seen.has(i.id);
    return {
      rank: n + 1,
      oracle_rank: oracleRank.get(i.id) ?? null,
      feature_id: featureOfItem(db, i),
      item_id: mine ? i.id : null,
      code: i.key,
      short_code: "",
      own_key: null,
      title: i.title,
      goal: i.goal ? { key: i.goal.key, title: i.goal.title, position: i.goal.position ?? null } : null,
      milestone: mine ? readable(i.milestone?.name) : null,
      horizon: mine ? i.horizon : null,
      goal_value: e.value,
      effort: e.effort,
      score: score.get(i.id) ?? null,
      confidence: CONFIDENCE[i.confidence ?? ""] ?? 0.5,
      value_estimated: e.valueEstimated,
      depends_on: depsOf(i, byId).map((d) => byId.get(d)!.key),
      after,
      override: o ? { by_name: o.by_name, reason: String((o.after.override as Values).reason), at: o.decided_at ?? o.at } : null,
      above_line: mine && (line.date ? readItems.get(i.id)!.end.date <= line.date : i.horizon === "now"),
      end_date: mine ? readItems.get(i.id)!.end.date : null,
      end_estimated: mine && readItems.get(i.id)!.end.estimated,
      estimate_pending: mine && !!readItems.get(i.id)!.estimate_pending,
      no_goal: !i.goal,
      in_plan: false,
      // prio-company: an owner moves every row (a move adds a feature to the company roadmap).
      can_reorder: can && (mine || ctx.role === "owner"),
      on_roadmap: mine || !!draftOf(i),
      draft_item_id: mine ? null : (draftOf(i)?.id ?? null),
      twins: [],
      applies: mine ? decides(i.id) : ctx.role === "owner",
      // feature-parts: the feature it is part of, as the roadmap reads it.
      part_of: mine ? (i.part_of ?? null) : null,
      // Its own parts, as the roadmap reads them, whether the list shows them or not.
      parts: mine ? (i.parts ?? []) : [],
      before_override: (stored(db, i.id).override as Record<string, unknown> | undefined) ?? null,
    };
  });
  // In the mock each item's key is its feature's key (its own code when it has one); FEATURES
  // is in creation order, a feature outside it after them by key.
  // With a plan, a feature the plan names is keyed by the plan's code (F-06), so one feature reads one code on every tab.
  const featureKey = (k: string): string => featureKeyOf(db, k);
  const created = [...Object.keys(FEATURES), ...yours.map((i) => i.key).filter((k) => !FEATURES[k]).sort()].map(featureKey);
  const prdCodes = Object.fromEntries(yours.filter((i) => i.code).map((i) => [featureKey(i.key), i.code!]));
  // Each feature's shown name (priorities.py `_shown_names`): its item's title as every reader
  // sees it, else its seed item's.
  const names = Object.fromEntries([...db.items.map((i) => [featureKey(i.key), i.title]), ...ranked.map((i) => [featureKey(i.key), i.title])]);
  const shorts = shortCodes(created, prdCodes, names);
  const short = new Map(created.map((k, n) => [k, shorts[n]]));
  yours.forEach((i, n) => (rows[n].short_code = short.get(featureKey(i.key))!));
  // prio-company: the feature's own code beside its name (priorities.FEATURE_CODE), never letters made up.
  rows.forEach((r) => (r.own_key = /^[A-Z]{1,3}-\d+$/.test(r.short_code) ? r.short_code : null));
  const codes = new Map(read.items.map((i) => [i.id, i]));
  // As priorities.py lists them: by at, a tie in the order made.
  const proposals: Schemas["SimplePriorityProposal"][] = madeOrder(db.changes ?? [], (c) => [c.at])
    // Ranking proposals, and a draft's Confirm or Merge (S7: a merge_item), as priorities.py.
    .filter((c) => c.status === "proposed" && codes.has(String(c.target.item_id)))
    .filter((c) => c.op === "override_priority" || c.op === "estimate_feature" || ((c.op === "confirm_item" || c.op === "cut" || c.op === "merge_item") && codes.get(String(c.target.item_id))!.draft))
    .filter((c) => ctx.role === "owner" || c.by === ctx.id || route(c).includes(ctx.id))
    .map((c) => {
      const i = codes.get(String(c.target.item_id))!;
      return {
        change_id: c.id, op: c.op as Schemas["SimplePriorityProposal"]["op"], item_id: i.id, feature_id: featureOfItem(db, i), code: i.key, title: i.title, by_name: c.by_name, at: c.at, reason: c.reason,
        after: c.after, waiting_for: route(c).map((p) => ctx.names[p] ?? "someone"), can_decide: decides(i.id), can_withdraw: c.by === ctx.id, flow: flowFor(db.visuals, "change", c.id) ?? flowFor(db.visuals, "feature", i.id),
      };
    });
  // plan-charts: with a plan, its PRD's items are in it (Goal buckets lists the rest outside it).
  const plan = planOf(db, read, ctx.role);
  if (plan) {
    const prdOf = new Map(read.items.map((i) => [i.id, i.prd?.slug]));
    yours.forEach((i, n) => (rows[n].in_plan = prdOf.get(i.id) === PLAN_PRD_SLUG));
  }
  // qa-prio-twins (priorities._fold_twins): rows of one name are one row, the best-ranked on the roadmap; the
  // others its twins, each with how it merges into it. Nothing is merged.
  const lead = new Map<string, Row>();
  for (const r of rows) {
    const first = rows.filter((x) => sameName(x.title) === sameName(r.title)).sort((a, b) => a.rank - b.rank);
    const l = first.find((x) => x.on_roadmap) ?? first[0];
    lead.set(r.feature_id, l);
    if (l === r) continue;
    const mine = !!r.item_id && !!l.item_id && readItems.get(r.item_id)!.roadmap.id === readItems.get(l.item_id)!.roadmap.id;
    const merge = !can ? null : mine ? ("item" as const) : !r.item_id ? ("entity" as const) : null;
    (l.twins ??= []).push({
      feature_id: r.feature_id, item_id: r.item_id, code: r.code, title: r.title, goal: r.goal, merge,
      into_id: merge === "item" ? l.item_id : null, applies: merge === "item" ? decides(r.item_id!) : merge === "entity" && (ctx.role === "owner" || ctx.role === "approver"),
    });
  }
  const kept = rows.filter((r) => lead.get(r.feature_id) === r);
  const byFeature = new Map(kept.map((r) => [r.feature_id, r]));
  const drafts: Schemas["SimplePriorityDraft"][] = live
    .filter((i) => i.draft)
    .map((i) => {
      // qa-prio-twins: the row it shows on, by its link (a draft added for a feature), else by name.
      const own = featureOf(db, i.key) !== i.key;
      const linked = own ? byFeature.get(featureOfItem(db, i)) : undefined;
      const row = linked ?? (own ? undefined : kept.find((r) => sameName(r.title) === sameName(i.title)));
      return {
        item_id: i.id, code: i.key, title: i.title, goal: i.goal ? { key: i.goal.key, title: i.goal.title, position: i.goal.position ?? null } : null, roadmap: i.roadmap, applies: decides(i.id),
        merge_into: all
          .filter((x) => !x.draft && seen.has(x.id))
          .filter((x) => x.roadmap.id === i.roadmap.id)
          .sort((a, b) => Number(a.id !== row?.item_id) - Number(b.id !== row?.item_id) || Number(a.goal?.key !== i.goal?.key) - Number(b.goal?.key !== i.goal?.key) || a.key.localeCompare(b.key))
          .slice(0, 8)
          .map((x) => ({ item_id: x.id, code: x.key, title: x.title })),
        row_feature_id: row?.feature_id ?? null,
        linked: !!linked,
      };
    });
  // prio-unranked (priorities.py `_unranked`): the reader's live, non-draft items no row holds.
  const unranked: Schemas["SimplePriorityUnranked"][] = live
    .filter((i) => !i.draft && noFeature(i))
    .map((i) => ({ item_id: i.id, code: i.key, title: i.title, goal: i.goal ? { key: i.goal.key, title: i.goal.title, position: i.goal.position ?? null } : null, roadmap: i.roadmap }));
  const buckets: Schemas["SimpleGoalBucket"][] = [];
  for (const r of kept) {
    const key = r.goal?.key ?? "none";
    let b = buckets.find((x) => x.key === key);
    if (!b) buckets.push((b = { key, title: r.goal?.title ?? "No goal", weeks: 0, share: 0, codes: [], no_goal: !r.goal, position: r.goal?.position ?? null }));
    if (r.horizon === "now" && r.item_id) {
      b.weeks = round(b.weeks + (r.effort ?? 0));
      b.codes.push(r.code);
    }
  }
  // goal-order: goals in the one goal order, No goal last.
  buckets.sort((a, b) => Number(a.no_goal) - Number(b.no_goal) || goalRank(a.key) - goalRank(b.key));
  const total = round(buckets.reduce((s, b) => s + b.weeks, 0));
  for (const b of buckets) b.share = total ? round(b.weeks / total) : 0;
  const bucketOnly = typeof localStorage !== "undefined" && localStorage.getItem(MOCK_SCENARIO_KEY) === PRIORITIES_BUCKET_ONLY_SCENARIO ? buckets.find((b) => !b.no_goal)?.codes[0] : undefined;
  return {
    // The plan-model lane: with a plan, its span ("Nov 2 - Feb 12"), else the calendar quarter.
    today, quarter: read.span ?? quarter(today), method: "goal_weighted",
    formula: "score = Σ(goal weight × contribution) × confidence × track record ÷ effort",
    rows: bucketOnly ? kept.filter((r) => r.code !== bucketOnly) : kept, proposals, drafts, unranked, buckets, weeks_total: total, can_change: can, line, lines,
    company_roadmap: db.company_roadmap ? { id: stableUuid(`simple-doc/${db.company_roadmap}`), slug: db.company_roadmap, title: COMPANY_TITLE } : null,
    // plan-charts: the plan this quarter is, when the reader sees its PRD's items.
    plan,
  };
}

/** priorities.plan_in_play: the plan PRD's plan as the API's priorities carry it (no version, no re-read). */
function planOf(db: SimpleDb, read: Schemas["SimpleRoadmapOut"], role: Role): Schemas["SimplePlanOut"] | null {
  const prd = read.items.find((i) => i.prd?.slug === PLAN_PRD_SLUG)?.prd;
  if (!db.plan || !prd || db.plan_undated) return null;
  return { ...planOut(db.plan, { id: prd.id, slug: prd.slug, title: prd.title }, role), version: null, can_read_again: false, read_at: null };
}
