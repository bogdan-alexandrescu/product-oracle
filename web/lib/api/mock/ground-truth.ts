/**
 * The Ground Truth check (docs/ground-truth.md; the owner, Nov 5: "Flag it, don't refuse"):
 * GET /v1/baseline/check, as api/oracle/baseline/check.py serves it (GroundTruthOut). Readable by
 * anyone who reads the roadmap; it only lists flags and never refuses a save.
 *
 * The "ground-truth-flags" scenario (MOCK_SCENARIO_KEY): one flag of each kind on the one
 * Product roadmap and its PRD Scale. Every other scenario reads no flags. Invented data only.
 */
import type { Schemas } from "@/lib/api/client";
import { stableUuid } from "./ids";

export const GROUND_TRUTH_FLAGS_SCENARIO = "ground-truth-flags";

type Kind = Schemas["GroundTruthFlag"]["kind"];
type Action = Schemas["GroundTruthFix"]["action"];

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

const ROADMAP = { id: stableUuid("ground-truth/roadmap"), title: "Product roadmap" };
const PRD = { id: stableUuid("ground-truth/prd/scale"), title: "Scale" };
const id = (key: string) => stableUuid(`ground-truth/${key}`);

const flag = (kind: Kind, fixes: [Action, string][], rest: Partial<Schemas["GroundTruthFlag"]>): Schemas["GroundTruthFlag"] => ({
  kind,
  item: null,
  feature: null,
  where: { roadmap: null, prd: null },
  words: WORDS[kind],
  fixes: fixes.map(([action, target]) => ({ action, target })),
  ...rest,
});

function seedFlags(): Schemas["GroundTruthFlag"][] {
  const both = { roadmap: ROADMAP, prd: PRD };
  return [
    flag("unlinked_item", [["add_to_ground_truth", id("item/export")], ["link_to_feature", id("item/export")]], {
      item: { id: id("item/export"), code: null, name: "Export to sheets" },
      where: both,
    }),
    flag("slice_parent_missing", [["add_to_ground_truth", "F-15"], ["link_to_feature", "F-15"]], {
      item: { id: null, code: "F-15a", name: "Usage report" },
      where: both,
    }),
    flag("prd_feature_missing", [["add_to_ground_truth", "F-09"], ["link_to_feature", "F-09"]], {
      feature: { id: null, code: "F-09", name: "Team invites" },
      where: both,
    }),
    flag("no_code", [["give_code", id("feature/smart-search")]], {
      feature: { id: id("feature/smart-search"), code: null, name: "Smart search" },
    }),
    flag("no_goal", [["pick_goal", id("feature/audit-log")]], {
      feature: { id: id("feature/audit-log"), code: "F-02", name: "Audit log" },
    }),
    flag("runs_today_on_roadmap", [["take_off_roadmap", id("item/night-alerts")]], {
      item: { id: id("item/night-alerts"), code: null, name: "Night alerts" },
      feature: { id: id("feature/night-alerts"), code: "F-03", name: "Night alerts" },
      where: both,
    }),
  ];
}

/** GroundTruthOut for the scenario: its flags, their counts per kind (zero included) and the total. */
export function groundTruthCheck(scenario: string | null): Schemas["GroundTruthOut"] {
  const flags = scenario === GROUND_TRUTH_FLAGS_SCENARIO ? seedFlags() : [];
  const counts = Object.fromEntries(CHECK_KINDS.map((k) => [k, flags.filter((f) => f.kind === k).length]));
  return { flags, counts, total: flags.length };
}
