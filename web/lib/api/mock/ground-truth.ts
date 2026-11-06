/**
 * The Ground Truth check (docs/ground-truth.md; the owner, Nov 5: "Flag it, don't refuse"):
 * GET /v1/baseline/check, as api/oracle/baseline/check.py serves it (GroundTruthOut). Readable by
 * anyone who reads the roadmap; it only lists flags and never refuses a save.
 *
 * The "ground-truth-flags" scenario (MOCK_SCENARIO_KEY): one flag of each kind on the Alerts
 * roadmap and its PRD Scale, plus a roadmap item on a feature a run only proposed. The flags are
 * read from the mock's own state, as the API reads them, so each fix made in the UI (a feature
 * added or confirmed, a goal picked, an item linked (a set_feature change in its roadmap's working
 * draft) or taken off, a code given, a PRD's feature linked) removes its flag. Export to sheets is
 * published, unlinked. The slices are two roadmap items (F-15a Usage report, F-15b Usage
 * chart) of an F-15 in no PRD flag nor the Ground Truth: one Add to Ground Truth (F-15) clears
 * both. The PRD's F-09 Guest seats spans two milestones; its roadmap item (section f-09) reads
 * F-09a. As the API: a PRD's feature matches by code only (a same-name feature is a hint), an
 * item linked to no feature whose own code or slice's feature is a confirmed feature's code is
 * in the Ground Truth by code and not flagged unlinked, though it is flagged if that feature runs
 * today; no_code and no_goal read every confirmed feature (the base mock's have a code and a goal
 * here), a goal served by a confirmed link to a confirmed goal. Every other scenario reads no
 * flags. Invented data only.
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
const F_CODE = /^[A-Z]{1,3}-\d+[a-j]?$/;

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
/** The scenario's roadmap items: key, title, the feature it is, a draft (Export to sheets is published), the PRD
 * section it came from. */
const ITEMS: [string, string, string | null, boolean, string?][] = [
  ["gt-export-to-sheets", "Export to sheets", null, false],
  ["gt-weekly-digest", "Weekly digest", featureId("F-14"), true],
  ["gt-night-alerts", "Night alerts", featureId("F-03"), false],
  // Digest emails came from a PRD's F-20 section: the next code counts it (F-21).
  ["gt-digest-emails", "Digest emails", featureId("F-12"), false, "f-20"],
  // Two slice items (PRD sections f-15a, f-15b) whose feature, F-15, is in no PRD flag nor the Ground Truth.
  ["gt-usage-report", "Usage report", null, true, "f-15a"],
  ["gt-usage-chart", "Usage chart", null, true, "f-15b"],
  // An item of the PRD's F-09, over two milestones: it reads F-09a, and is an unlinked item (F-09 is the PRD's flag).
  ["gt-guest-invites", "Guest invites", null, true, "f-09"],
];
/** The PRD Scale's approved plan: its feature not in the Ground Truth, over two milestones; it serves the
 * scenario's goal. */
const PRD_FEATURES = [{ code: "F-09", name: "Guest seats", milestones: ["Beta", "Launch"] }];
/** The codes the base mock's confirmed features take here, so each of the scenario's kinds has its one flag. */
const BASE_CODES = ["F-04", "F-05", "F-06", "F-07", "F-08"];

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
  // The base mock's confirmed features: each with a code and serving a confirmed goal (the check reads every one).
  const ours = new Set(FEATURES.map(([key]) => featureId(key)));
  const others = baseline.entities.filter((e) => e.type === "feature" && e.status === "confirmed" && !ours.has(e.id) && !F_CODE.test(e.key));
  others.forEach((e, n) => {
    if (n < BASE_CODES.length) e.key = BASE_CODES[n];
    if (!baseline.edges.some((x) => x.type === "supports" && x.src_id === e.id && x.dst_id === goal.id && x.status === "confirmed"))
      baseline.edges.push({ ...edge, id: stableUuid(`ground-truth/serves/base/${e.id}`), src_id: e.id, dst_id: goal.id, status: "confirmed", locked: false, locked_by: null, locked_at: null });
  });
  for (const [key, title, feature, draft, section] of ITEMS) {
    if (simple.items.some((x) => x.key === key)) continue;
    simple.items.push({ key, title, horizon: "next", roadmap: ROADMAP_SLUG, track: "alerts", confidence: "medium", start: 30, end: 70, source: "typed", draft, feature_id: feature, ...(section ? { section } : {}) });
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
  // The Ground Truth by code (F-12, a slice F-12a), as check.py's truth_of.
  const truthOf = new Map(truth.filter((e) => F_CODE.test(e.key)).map((e) => [e.key, e]));
  // Link to a feature: a PRD feature linked to a Ground Truth feature is that feature.
  const links = baseline.prdLinks?.[PRD.id] ?? {};
  const linkedTo = (code: string | null) => {
    const e = code ? byId.get(links[code] ?? "") : undefined;
    return e?.status === "confirmed" ? e : undefined;
  };
  const missing = PRD_FEATURES.filter((f) => !truthOf.has(f.code) && !linkedTo(f.code));
  // Each item's code (F-15a for a slice section f-15a) and its slice's feature's (F-15). An item of a PRD
  // feature over several milestones takes the next letter no slice item of it has (F-09a), as check.py's slice_of.
  const sectionOf = (s: (typeof items)[number]) => {
    const m = /^([a-z]{1,3})-(\d+)([a-j])?$/i.exec((s.section ?? "").trim());
    return m ? { base: `${m[1].toUpperCase()}-${m[2].padStart(2, "0")}`, letter: m[3]?.toLowerCase() } : null;
  };
  const taken = new Map<string, Set<string>>();
  for (const s of items) {
    const sec = sectionOf(s);
    if (sec?.letter) taken.set(sec.base, (taken.get(sec.base) ?? new Set()).add(sec.letter));
  }
  const slices = new Map<string, [string, string]>();
  for (const s of items) {
    const sec = sectionOf(s);
    if (sec?.letter) slices.set(s.key, [`${sec.base}${sec.letter}`, sec.base]);
    else if (sec && (PRD_FEATURES.find((f) => f.code === sec.base)?.milestones.length ?? 0) > 1) {
      const used = taken.get(sec.base) ?? new Set<string>();
      const letter = [..."abcdefghij"].find((x) => !used.has(x)) ?? "j";
      taken.set(sec.base, used.add(letter));
      slices.set(s.key, [`${sec.base}${letter}`, sec.base]);
    }
  }
  const codeOf = (s: (typeof items)[number]): [string | null, string | null] => slices.get(s.key) ?? [sectionOf(s)?.base ?? null, null];
  const byCode = (s: (typeof items)[number]) => {
    for (const c of codeOf(s)) if (c && (truthOf.get(c) ?? linkedTo(c))) return truthOf.get(c) ?? linkedTo(c);
    return undefined;
  };
  for (const s of items) {
    const linked = byId.get(s.linked_feature ?? s.feature_id ?? "");
    // Its feature as the roadmap's working draft has it (a set_feature change: Add or Link).
    if (linked?.status === "confirmed" || (!linked && byCode(s))) continue;
    const id = simple.ids[s.key];
    const [code, parent] = codeOf(s);
    const item = { id, code, name: s.title };
    if (!linked && parent && !missing.some((f) => f.code === parent)) {
      out.push(flag("slice_parent_missing", [["add_to_ground_truth", parent], ["link_to_feature", id]], { item, where: both }));
      continue;
    }
    out.push(
      flag("unlinked_item", [linked?.status === "proposed" ? ["confirm_feature", linked.id] : ["add_to_ground_truth", id], ["link_to_feature", id]], {
        item,
        feature: linked ? ref(linked) : null,
        where: both,
      }),
    );
  }
  // By code only: the same name as a confirmed feature is a hint, never a match.
  for (const f of missing) {
    const like = truth.find((e) => e.title.trim().toLowerCase() === f.name.toLowerCase());
    const hint = like ? `${["Same name as", F_CODE.test(like.key) ? like.key : null, like.title].filter(Boolean).join(" ")}.` : null;
    out.push(flag("prd_feature_missing", [["add_to_ground_truth", f.code], ["link_to_feature", f.code]], { feature: { id: null, code: f.code, name: f.name }, goal, where: both, hint, like: like ? ref(like) : null }));
  }
  // Every confirmed feature, as the API: a goal is served by a confirmed link to a confirmed goal.
  for (const e of truth) if (!F_CODE.test(e.key)) out.push(flag("no_code", [["give_code", e.id]], { feature: ref(e) }));
  const goals = new Set(baseline.entities.filter((e) => e.type === "goal" && e.status === "confirmed").map((e) => e.id));
  const serving = new Set(baseline.edges.filter((e) => e.type === "supports" && e.status === "confirmed" && goals.has(e.dst_id)).map((e) => e.src_id));
  for (const e of truth) if (!serving.has(e.id)) out.push(flag("no_goal", [["pick_goal", e.id]], { feature: ref(e) }));
  for (const s of items) {
    // Its own feature, or the one it matches by code (F-03, F-03a).
    const f = byId.get(s.linked_feature ?? s.feature_id ?? "") ?? byCode(s);
    if (f && RUNNING.has(f.id)) out.push(flag("runs_today_on_roadmap", [["take_off_roadmap", simple.ids[s.key]]], { item: { id: simple.ids[s.key], code: codeOf(s)[0], name: s.title }, feature: ref(f), where: both }));
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

type Role = Schemas["Me"]["role"];
const RANK: Role[] = ["viewer", "commenter", "approver", "owner"];
const atLeast = (role: Role, min: Role) => RANK.indexOf(role) >= RANK.indexOf(min);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fail = (status: number, detail: string) => json(status, { detail });
/** A code a slice's feature lends its number from (F-15), and any feature code (F-15, F-15a). */
const WHOLE = /^[A-Z]{1,3}-\d+$/;
const ANY_CODE = /^[A-Z]{1,3}-\d+[a-j]?$/;

/**
 * The next code for a feature, as oracle.baseline.fixes.next_code: its feature's number and the next letter for a slice,
 * else the highest F-number + 1 over every feature's code, a code once given (never given again), the PRD's codes and
 * every roadmap item's PRD section (prd_section_key).
 */
function nextCode(baseline: BaselineState, simple: SimpleDb | undefined, e: Entity): string | Response {
  if (e.status !== "confirmed") return fail(409, "This feature is not in the Ground Truth yet.");
  if (ANY_CODE.test(e.key)) return fail(409, "This feature already has a code.");
  const keys = new Set([...baseline.entities.filter((x) => x.type === "feature").map((x) => x.key), ...(baseline.codesGiven ?? [])]);
  const parent = e.parent_id ? baseline.entities.find((x) => x.id === e.parent_id && x.type === "feature") : undefined;
  if (parent) {
    if (!WHOLE.test(parent.key)) return fail(409, "Give its feature a code first.");
    const letter = [..."abcdefghij"].find((l) => !keys.has(`${parent.key}${l}`));
    return letter ? `${parent.key}${letter}` : fail(409, "This feature has no slice letter left.");
  }
  const sections = (simple?.items ?? []).map((x) => (x.section ?? "").trim().toUpperCase());
  const numbers = [...keys, ...PRD_FEATURES.map((f) => f.code), ...sections].map((k) => /^F-(\d+)(?:\.\d+)?[A-J]?$/i.exec(k)).filter((m) => !!m).map((m) => Number(m![1]));
  return `F-${String(Math.max(0, ...numbers) + 1).padStart(2, "0")}`;
}

function propose(baseline: BaselineState, userId: string, feature: Entity, fix: Record<string, string>) {
  const same = baseline.proposals.find((x) => x.status === "open" && x.entity_id === feature.id && JSON.stringify((x.payload as { fix?: unknown }).fix) === JSON.stringify(fix));
  if (same) return same;
  const p = {
    id: stableUuid(`ground-truth/proposal/${feature.id}/${JSON.stringify(fix)}/${baseline.proposals.length}`),
    entity_id: feature.id,
    edge_id: null,
    payload: { op: "update", kind: "entity", fields: {}, fix, reason: `Ground Truth fix: ${fix.action}`, origin: "agent" },
    run_id: null,
    actor: `user:${userId}`,
    status: "open" as const,
    decided_by: null,
    decided_at: null,
    created_at: new Date().toISOString(),
  };
  baseline.proposals.push(p);
  return p;
}

function giveCode(baseline: BaselineState, simple: SimpleDb | undefined, e: Entity): string | Response {
  const code = nextCode(baseline, simple, e);
  if (typeof code !== "string") return code;
  (baseline.codeFrom ??= {})[e.id] = e.key;
  (baseline.codesGiven ??= []).push(code);
  e.key = code;
  return code;
}

function link(baseline: BaselineState, prd: string, code: string, featureId: string): Entity | Response {
  if (prd !== PRD.id) return fail(404, "No such PRD");
  if (!PRD_FEATURES.some((f) => f.code === code)) return fail(404, "This PRD has no such feature");
  const feature = baseline.entities.find((x) => x.id === featureId && x.type === "feature");
  if (!feature) return fail(404, "No such feature");
  if (feature.status !== "confirmed") return fail(409, "Link it to a feature in the Ground Truth.");
  const links = ((baseline.prdLinks ??= {})[prd] ??= {});
  if (links[code]) return fail(409, "This PRD's feature is already linked; undo that first.");
  links[code] = feature.id;
  return feature;
}

/**
 * The check's fixes that are no plain entity or edge write, as api/oracle/baseline/fixes.py serves them:
 * POST and DELETE /v1/baseline/entities/{id}/code (Give it a code, Undo), POST and DELETE
 * /v1/baseline/prd-links (Link to a feature for a PRD's feature or slice, Undo), and accepting a
 * commenter's fix proposal. Approvers and owners act at once; a commenter's fix is a proposal. Null for any other route.
 */
export async function routeGroundTruthFixes(baseline: BaselineState, simple: SimpleDb | undefined, me: { id: string; role: Role }, req: Request, p: string[], q: URLSearchParams): Promise<Response | null> {
  const m = req.method;
  const ref = (e: Entity) => ({ id: e.id, code: ANY_CODE.test(e.key) ? e.key : null, name: e.title });
  const out = (e: Entity, rest: { status: "done" | "proposed"; code?: string | null; proposal_id?: string | null }) =>
    json(200, { feature: ref(e), code: null, proposal_id: null, ...rest } satisfies Schemas["GroundTruthFixOut"]);
  if (p[1] !== "baseline") return null;
  if (p[2] === "entities" && p[3] && p[4] === "code" && !p[5] && (m === "POST" || m === "DELETE")) {
    if (!atLeast(me.role, m === "POST" ? "commenter" : "approver")) return fail(403, "Your role cannot do this");
    const e = baseline.entities.find((x) => x.id === p[3] && x.type === "feature");
    if (!e) return fail(404, "No such feature");
    if (m === "DELETE") {
      const old = baseline.codeFrom?.[e.id];
      if (!old || !ANY_CODE.test(e.key)) return fail(409, "This feature's code was not given here.");
      if (baseline.entities.some((x) => x.type === "feature" && x.key === old)) return fail(409, "Its old key is taken by another feature.");
      e.key = old;
      delete baseline.codeFrom![e.id];
      return out(e, { status: "done" });
    }
    const code = nextCode(baseline, simple, e);
    if (typeof code !== "string") return code;
    if (!atLeast(me.role, "approver")) return out(e, { status: "proposed", proposal_id: propose(baseline, me.id, e, { action: "give_code" }).id });
    giveCode(baseline, simple, e);
    return out(e, { status: "done", code });
  }
  if (p[2] === "prd-links" && !p[3] && (m === "POST" || m === "DELETE")) {
    if (!atLeast(me.role, m === "POST" ? "commenter" : "approver")) return fail(403, "Your role cannot do this");
    if (m === "DELETE") {
      const prd = q.get("prd_document_id") ?? "";
      const code = (q.get("code") ?? "").trim();
      if (prd !== PRD.id) return fail(404, "No such PRD");
      const links = baseline.prdLinks?.[prd];
      if (!links?.[code]) return fail(409, "This PRD's feature is not linked.");
      delete links[code];
      return json(200, { ok: true });
    }
    const body = JSON.parse((await req.text()) || "{}") as Schemas["PrdLinkCreate"];
    const code = body.code.trim();
    if (!atLeast(me.role, "approver")) {
      // Checked as the API checks it, then proposed.
      const trial: BaselineState = { ...baseline, prdLinks: JSON.parse(JSON.stringify(baseline.prdLinks ?? {})) };
      const checked = link(trial, body.prd_document_id, code, body.feature_id);
      if (checked instanceof Response) return checked;
      const name = PRD_FEATURES.find((f) => f.code === code)!.name;
      return out(checked, { status: "proposed", proposal_id: propose(baseline, me.id, checked, { action: "link_prd_feature", prd_document_id: body.prd_document_id, code, name }).id });
    }
    const linked = link(baseline, body.prd_document_id, code, body.feature_id);
    return linked instanceof Response ? linked : out(linked, { status: "done" });
  }
  if (p[2] === "proposals" && p[3] && p[4] === "accept" && m === "POST") {
    const prop = baseline.proposals.find((x) => x.id === p[3]);
    const fix = (prop?.payload as { fix?: Record<string, string> } | undefined)?.fix;
    if (!prop || !fix) return null;
    if (!atLeast(me.role, "approver")) return fail(403, "Your role cannot do this");
    if (prop.status !== "open") return fail(409, `Proposal is already ${prop.status}`);
    const e = baseline.entities.find((x) => x.id === prop.entity_id);
    if (!e) return fail(404, "No such feature");
    const done = fix.action === "give_code" ? giveCode(baseline, simple, e) : link(baseline, fix.prd_document_id, fix.code, e.id);
    if (done instanceof Response) return done;
    return null; // the baseline's route accepts it (no field to change) and serves its ProposalOut.
  }
  return null;
}
