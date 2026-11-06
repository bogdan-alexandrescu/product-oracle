/**
 * The Ground Truth check (docs/ground-truth.md; the owner, Nov 5: "Flag it, don't refuse"):
 * GET /v1/baseline/check, as api/oracle/baseline/check.py serves it (GroundTruthOut). Readable by
 * anyone who reads the roadmap; it only lists flags and never refuses a save.
 *
 * The "ground-truth-flags" scenario (MOCK_SCENARIO_KEY): one flag of each kind on the Alerts
 * roadmap and its PRD Scale, plus a roadmap item on a feature a run only proposed. The flags are
 * read from the mock's own state, as the API reads them, so each fix made in the UI (a feature
 * added or confirmed, a goal picked, an item linked or taken off) removes its flag. Every other
 * scenario reads no flags. Invented data only.
 */
import type { Schemas } from "@/lib/api/client";
import type { BaselineState } from "./baseline";
import { stableUuid } from "./ids";
import { closed, roadmapId, type SimpleDb } from "./simple-roadmap";

export const GROUND_TRUTH_FLAGS_SCENARIO = "ground-truth-flags";

type Kind = Schemas["GroundTruthFlag"]["kind"];
type Action = Schemas["GroundTruthFix"]["action"];
type Flag = Schemas["GroundTruthFlag"];
type Entity = BaselineState["entities"][number];

/** In the API's order (CHECK_KINDS). */
export const CHECK_KINDS: Kind[] = ["unlinked_item", "slice_parent_missing", "prd_feature_missing", "no_code", "no_goal", "runs_today_on_roadmap"];

const WORDS: Record<Kind, string> = {
  unlinked_item: "This roadmap item is not a feature in the Ground Truth.",
  slice_parent_missing: "This slice's feature is not in the Ground Truth.",
  prd_feature_missing: "This PRD's feature is not in the Ground Truth.",
  no_code: "This feature has no feature code yet.",
  no_goal: "This feature serves no goal.",
  runs_today_on_roadmap: "This feature runs today but is still on the roadmap.",
};

/** Each fix's button, as the API's FIX_WORDS. */
const FIX_WORDS: Record<Action, string> = {
  add_to_ground_truth: "Add to Ground Truth",
  link_to_feature: "Link to a feature",
  confirm_feature: "Confirm it",
  give_code: "Give it a code",
  pick_goal: "Pick a goal",
  take_off_roadmap: "Take it off the roadmap",
};

const ROADMAP_SLUG = "alerts-roadmap";
const ROADMAP = { id: roadmapId(ROADMAP_SLUG), title: "Alerts roadmap" };
const PRD = { id: stableUuid("ground-truth/prd/scale"), title: "Scale" };
const featureId = (key: string) => stableUuid(`ground-truth/feature/${key}`);
/** A feature's code is its key when the key is one (F-12), as oracle.simple.priorities reads it. */
const F_CODE = /^[A-Z]{1,3}-\d+$/;

/** The scenario's features: key, name, status, whether it serves a goal. */
const FEATURES: [string, string, Entity["status"], boolean][] = [
  ["F-02", "Audit log", "confirmed", false],
  ["smart-search", "Smart search", "confirmed", true],
  ["F-03", "Night alerts", "confirmed", true],
  ["F-11", "Sheets export", "confirmed", true],
  ["F-12", "Digest emails", "confirmed", true],
  ["F-14", "Weekly digest", "proposed", true],
];
/** Running today (Current state's proof), as feature_states would say. */
const RUNNING = new Set([featureId("F-03")]);
/** The scenario's roadmap items: key, title, the feature it is, a draft (Export to sheets is published, unlinked). */
const ITEMS: [string, string, string | null, boolean][] = [
  ["gt-export-to-sheets", "Export to sheets", null, false],
  ["gt-weekly-digest", "Weekly digest", featureId("F-14"), true],
  ["gt-night-alerts", "Night alerts", featureId("F-03"), false],
];
/** The PRD Scale's approved plan: its features not in the Ground Truth (F-15 spans two milestones: slice F-15a); it serves the scenario's goal. */
const PRD_FEATURES = [{ code: "F-09", name: "Guest seats", slice: null }, { code: "F-15", name: "Usage report", slice: "F-15a" }];

/** Adds the scenario's features (to the baseline) and items (to the Alerts roadmap). */
export function seedGroundTruth(baseline: BaselineState, simple: SimpleDb): void {
  const template = baseline.entities.find((e) => e.type === "feature")!;
  const goal = prdGoal(baseline)!;
  const edge = baseline.edges.find((e) => e.type === "supports")!;
  for (const [key, title, status, serves] of FEATURES) {
    const id = featureId(key);
    if (baseline.entities.some((e) => e.id === id)) continue;
    baseline.entities.push({ ...template, id, key, title, body: null, attrs: {}, status, parent_id: null, locked: false, locked_by: null, locked_at: null });
    if (serves) baseline.edges.push({ ...edge, id: stableUuid(`ground-truth/serves/${key}`), src_id: id, dst_id: goal.id, status: "confirmed", locked: false, locked_by: null, locked_at: null });
  }
  for (const [key, title, feature, draft] of ITEMS) {
    if (simple.items.some((x) => x.key === key)) continue;
    simple.items.push({ key, title, horizon: "next", roadmap: ROADMAP_SLUG, track: "alerts", confidence: "medium", start: 30, end: 70, source: "typed", draft, feature_id: feature });
    simple.ids[key] = stableUuid(`simple-item/${key}`);
  }
}

const flag = (kind: Kind, fixes: [Action, string][], rest: Partial<Flag>): Flag => ({
  kind,
  item: null,
  feature: null,
  goal: null,
  where: { roadmap: null, prd: null },
  words: WORDS[kind],
  fixes: fixes.map(([action, target]) => ({ action, target, words: FIX_WORDS[action] })),
  hint: null,
  like: null,
  ...rest,
});

/** The goal the PRD gives its features (the plan's one goal), as check.py's goal_of. */
const prdGoal = (baseline: BaselineState) =>
  baseline.entities.find((e) => e.type === "goal" && e.status === "confirmed") ?? baseline.entities.find((e) => e.type === "goal" && e.status !== "rejected");

function flagsOf(baseline: BaselineState, simple: SimpleDb): Flag[] {
  const byId = new Map(baseline.entities.filter((e) => e.type === "feature").map((e) => [e.id, e]));
  const truth = [...byId.values()].filter((e) => e.status === "confirmed");
  const g = prdGoal(baseline);
  const goal = g ? { id: g.id, code: null, name: g.title } : null;
  const ref = (e: Entity) => ({ id: e.id, code: F_CODE.test(e.key) ? e.key : null, name: e.title });
  const both = { roadmap: ROADMAP, prd: PRD };
  const out: Flag[] = [];
  const items = ITEMS.map(([key]) => simple.items.find((x) => x.key === key)).filter((s): s is NonNullable<typeof s> => !!s && !closed(s) && !s.trashed);
  for (const s of items) {
    const linked = byId.get(s.linked_feature ?? s.feature_id ?? "");
    // Its feature as the roadmap's working draft has it (a set_feature change: Add or Link).
    if (linked?.status === "confirmed") continue;
    const id = simple.ids[s.key];
    out.push(
      flag("unlinked_item", [linked?.status === "proposed" ? ["confirm_feature", linked.id] : ["add_to_ground_truth", id], ["link_to_feature", id]], {
        item: { id, code: null, name: s.title },
        feature: linked ? ref(linked) : null,
        where: both,
      }),
    );
  }
  const names = new Set(truth.map((e) => e.title.trim().toLowerCase()));
  const codes = new Set(truth.map((e) => e.key).filter((k) => F_CODE.test(k)));
  const missing = PRD_FEATURES.filter((f) => !codes.has(f.code) && !names.has(f.name.toLowerCase()));
  for (const f of missing)
    if (f.slice) out.push(flag("slice_parent_missing", [["add_to_ground_truth", f.code], ["link_to_feature", f.code]], { item: { id: null, code: f.slice, name: f.name }, goal, where: both }));
  for (const f of missing)
    if (!f.slice) out.push(flag("prd_feature_missing", [["add_to_ground_truth", f.code], ["link_to_feature", f.code]], { feature: { id: null, code: f.code, name: f.name }, goal, where: both }));
  // Every confirmed feature, as the API checks them.
  for (const e of truth) if (!F_CODE.test(e.key)) out.push(flag("no_code", [["give_code", e.id]], { feature: ref(e) }));
  const serving = new Set(baseline.edges.filter((e) => e.type === "supports" && e.status !== "rejected").map((e) => e.src_id));
  for (const e of truth) if (!serving.has(e.id)) out.push(flag("no_goal", [["pick_goal", e.id]], { feature: ref(e) }));
  for (const s of items) {
    const f = byId.get(s.feature_id ?? "");
    if (f && RUNNING.has(f.id)) out.push(flag("runs_today_on_roadmap", [["take_off_roadmap", simple.ids[s.key]]], { item: { id: simple.ids[s.key], code: null, name: s.title }, feature: ref(f), where: both }));
  }
  return out;
}

/** GroundTruthOut for the scenario: its flags in CHECK_KINDS' order, their counts per kind (zero included) and the total. */
export function groundTruthCheck(scenario: string | null, baseline: BaselineState, simple: SimpleDb | undefined): Schemas["GroundTruthOut"] {
  const found = scenario === GROUND_TRUTH_FLAGS_SCENARIO && simple ? flagsOf(baseline, simple) : [];
  const flags = CHECK_KINDS.flatMap((k) => found.filter((f) => f.kind === k));
  const counts = Object.fromEntries(CHECK_KINDS.map((k) => [k, flags.filter((f) => f.kind === k).length]));
  return { flags, counts, total: flags.length };
}
