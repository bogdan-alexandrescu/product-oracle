/**
 * Simple S2 (#723): the company-wide roadmap (GET /v1/simple/roadmap) and Oracle's date
 * suggestions (/v1/simple/roadmap/date-suggestions), as api/oracle/simple serves them.
 *
 * Invented data: two company-wide roadmaps and one for owners and approvers only, with
 * typed, accepted, engineering, tracker and estimated dates, dependencies, a milestone, a
 * cut item and a draft without an owner. The rules are the API's (oracle.simple.dates and
 * constraints), simplified: the company's day is the mock clock's UTC day and the planning
 * horizons are the defaults (short 1 quarter, medium 2, long 12-24 months).
 */
import { byPrdRank, prdRanker } from "./prd-rank";
import type { Schemas } from "@/lib/api/client";
import { goalPosition, sortGoals, type OrderedGoal } from "@/lib/goal-order";
import { plainFlow } from "./simple-visuals";
import { leftOut } from "./decision-notes";
import { mockNowMs } from "./clock";
import { companyDayIso } from "./connections";
import { newCompany, seeded, stableUuid } from "./ids";
import { milestoneOut, oldMilestonesOut, routeMilestones, type MockMilestone, type OldCtx } from "./simple-milestones";
import { betSubject, flowFor, type VisualsDb } from "./simple-visuals";
import type { OnePagerDb } from "./simple-one-pager";
import { appliedMilestones, type AppliedRecord } from "./approved-roadmap";
import { PLAN_PRD_SLUG, planMilestones, planSlices, planSpan, type PlanDb } from "./simple-plan";
import { COMPANY_SLUG, COMPANY_TITLE } from "./one-roadmap";
import { estimates } from "./simple-priorities";
import { basePlan as fitBasePlan, PLAN_TARGET as FIT_PLAN_TARGET, schedule as fitSchedule } from "./fit-date-engine";

type Item = Schemas["SimpleRoadmapItem"];
type Suggestion = Schemas["DateSuggestionOut"];
type Dated = Schemas["SimpleDate"];
type Flag = Schemas["SimpleFlag"];
type Horizon = Item["horizon"];
type Role = Schemas["Me"]["role"];

interface SeedItem {
  /** trash-features-goals: moved to Trash (oracle.trash.filter.INCLUDE_TRASHED): left out of
   * every read (visibleItems) but kept here, as they were, for Restore. */
  trashed?: boolean;
  key: string;
  title: string;
  horizon: Horizon;
  roadmap: string;
  goal?: string;
  track?: string;
  confidence?: "low" | "medium" | "high";
  /** Days from the window's start; with `source`. */
  start?: number;
  end?: number;
  source?: Exclude<Dated["source"], "estimated">;
  depends?: string[];
  /** roadmap-edit-fixes: the key of the feature it delivers, when that is no code (another
   * PRD's item may depend on it by that key, as the API's dependency checks accept). */
  feature_key?: string;
  /** roadmap-edit-fixes: Oracle's ideas of what a new item depends on (keys), a person's to add. */
  suggested_depends?: string[];
  /** roadmap-edit-fixes: when Oracle's draft filled a field (a conflict it caused names Oracle). */
  drafted_at?: string;
  status?: Item["status"];
  /** one-feature-panel: the status the tracker gave it, kept once its panel sets one (planned reads it again). */
  tracked?: Item["status"];
  /** item-chat-understands (RoadmapItem.shipped): its own "already shipped" mark, apart from a status its tracker gives it. */
  shipped?: { note: string; on: string } | null;
  draft?: boolean;
  /** Its own milestone (RoadmapItem.milestone): its day from the horizon's start, null when it has no date.
   * build-feature-panel review 2: `engine` is what the date engine stored besides the name and
   * day (its date_source, basis_ids...), never shown; a null name reads "Milestone". */
  milestone?: { name: string | null; day: number | null; engine?: Record<string, unknown> };
  /** The track milestone record naming the item (its name), whatever its own text says. */
  record?: string;
  /** The roadmap item's validation gates (days from the window's start); one naming a
   * phase ends that phase on its day (oracle.simple.dates.named_phases). */
  gates?: { phase: string; day: number }[];
  risks?: { flag: Flag["kind"]; note: string; subject?: string | null }[];
  /** Simple S3a's change engine (./simple-changes.ts) edits these. */
  outcome?: string | null;
  /** build-feature-panel (AN PR 1204): the item's notes (op edit_note), the panel's Notes row. */
  note?: string | null;
  position?: number;
  /** S4 (the floating card): the priority's rationale and the PRD section it came from. */
  why?: string;
  section?: string;
  /** The walk: the heading of that PRD section ("F-06 ..." names it by the PRD's code). */
  heading?: string;
  /** S7: goals linked directly besides `goal` (merges add the draft's). */
  goals?: string[];
  /** S7: the items this draft looks like (keys, best first), until kept both or merged. */
  looks_like?: string[];
  kept_both?: boolean;
  /** S7: the key of the item this draft was merged into (the draft is closed). */
  merged_into?: string;
  /** prio-company: the key of the item whose feature this one is (an item a move on Priorities
   * added to the company roadmap for a feature it did not hold); else its own feature. */
  feature?: string;
  /** S7: the Ground Truth feature (with no item) this draft was linked to by a merge. */
  // A draft merged with a Ground Truth feature that has no item: linked to it (still a draft).
  linked_feature?: string;
  /** S7: Oracle's drafting job runs until this mock time (ms); the item is "drafting" until then. */
  drafting_until?: number;
  /** S7: a draft quick-added on a quarter: Oracle's date suggestion falls in it. */
  quarter?: { start: string; end: string };
  flow?: Schemas["SimpleFlow"] | null;
  /** S7: notes a merge left on the kept item. */
  notes?: string[];
  /** meet-chat-right-prd: on its PRD's draft roadmap (a run's items-only roadmap, the PRD not
   * approved yet), not on the roadmap: only a review meeting's chat on that PRD reads it. */
  draft_roadmap?: boolean;
  /** approved-prd-roadmap: an item an approved PRD put in the draft names that PRD. */
  from_prd?: { slug: string; title: string };
  /** The Ground Truth feature it is (RoadmapItem.feature_id): an approved PRD's item matches by it. */
  feature_id?: string | null;
  /** approved-prd-roadmap: its dates as the PRD has them (ISO days; no start: end-only). */
  dates?: { start: string | null; end: string; source: "engineering" | "accepted" };
  /** build-runplan RP2: the PRD it belongs to when not its roadmap's own (./meeting-draft.ts). */
  prd_doc?: { id: string; slug: string; title: string };
  /** Bring a date in: the re-plan sliced or split it, so its date waits for a new estimate. */
  estimate_pending?: boolean;
  /** approved-roadmap-to-simple: the source words of the dates an applied roadmap version gave it
   * ("founder commitment"); its `dates` are that version's. */
  basis?: string;
}

export type MockVersion = { roadmap: string; number: number; without: string[] };

/** trash-features-goals review 4: off its roadmap's latest version (published while it was in Trash). */
function offLatest(db: SimpleDb, s: SeedItem): boolean {
  const latest = (db.versions ?? []).filter((v) => v.roadmap === s.roadmap).at(-1);
  return !!latest?.without.includes(s.key);
}

interface SimpleDb {
  items: SeedItem[];
  ids: Record<string, string>;
  /** The items' own dates once a suggestion was accepted or edited, or moved in Simple (ISO days). */
  own: Record<string, { start: string; end: string; source?: "typed" | "accepted" }>;
  suggestions: Suggestion[];
  /** Simple S3a (./simple-changes.ts): sessions and changes. */
  sessions?: Schemas["SimpleSessionOut"][];
  changes?: Schemas["SimpleChangeOut"][];
  /** walkc-meeting (./simple-changes.ts markMeetingProposal): the ids of proposals made in a
   * meeting, which stay with the meeting's deciders (changes.current_route). */
  meeting_proposals?: string[];
  /** inbox-meeting-proposals owner (changes.inbox_rows from_ask): the ids of proposals asked
   * through Ask Oracle (a card applied outside a meeting). */
  ask_proposals?: string[];
  /** Simple S3b (./simple-changes.ts): working drafts, each with its roadmap's published items. */
  drafts?: MockDraft[];
  /** trash-features-goals review 4: each roadmap's versions published in the mock, each with the
   * keys of the features that were in Trash when it was published (made without them). The
   * roadmap reads its latest; Restore puts the feature back on every one (trash.restoreFromTrash). */
  versions?: MockVersion[];
  /** walkb-roadmap review 5a: roadmaps built from a PRD with no approved version yet (their drafts' `published` is false). */
  unapproved?: string[];
  /** S3b: non-versioned targets (item tasks, action items, overrides, launch tasks) by id. */
  targets?: Record<string, Record<string, unknown>>;
  /** D-a (#730 review): each roadmap's designated decider (roadmap slug -> person id). */
  deciders?: Record<string, string>;
  /** Each roadmap's required reviewers (roadmap slug -> person ids: its review policy's
   * DocumentReviewPolicy.mandatory_reviewer_ids; roadmap-decide and inbox-meeting-proposals reviews):
   * a submitted draft waits on them after its decider. */
  reviewers?: Record<string, string[]>;
  /** agenda-sheet ("meeting-agenda-sheet"): a PRD's designated decider (PRD slug -> person id). */
  prd_deciders?: Record<string, string>;
  /** agenda-sheet ("meeting-agenda-sheet"): a review of Usage alerts starts mid-agenda (one item decided, a topic added, one skipped). */
  agenda_midway?: { topic: string; by: string } | null;
  /** D-a: each track's owner (track key -> person id); their role (Who.roles) says whether they decide. */
  track_owners?: Record<string, string>;
  /** S4: people's display names (person id -> name), for the items' owners. */
  people?: Record<string, string>;
  /** S4: proposed decisions naming an item (item key -> decisions). */
  decisions?: Record<string, { number: number; title: string }[]>;
  /** Roadmap-plus (api/oracle/simple/key_dates.py): each roadmap's key dates as its working
   * draft has them (roadmap slug -> key dates); a draft keeps the published ones. */
  key_dates?: Record<string, MockKeyDate[]>;
  /** A roadmap's own name when it differs from ROADMAPS' (roadmap slug -> title), as Build
   * roadmap names one after its PRD ("simple-walk-long-name"). */
  titles?: Record<string, string>;
  /** S7 (./simple-suggestions.ts): Oracle's feature suggestions for goals, its suggest jobs
   * (goal key -> when the job is done, mock ms) and the goals suggested for automatically. */
  goal_suggestions?: GoalSuggestionRow[];
  /** Goal buckets (./goal-buckets.ts): the goals and each feature's goal links. */
  goal_buckets?: import("./goal-buckets").GoalBucketsDb;
  /** one-feature-panel: a roadmap goal edited through the goal edit (goal key -> its fields). */
  goal_edits?: Record<string, RoadmapGoalFields>;
  goal_jobs?: Record<string, { until: number; job_id: string; origin: "auto" | "on_demand" }>;
  auto_done?: string[];
  /** S7: the seeds a merge changed, as they were (change id -> seeds), for its undo. */
  snapshots?: Record<string, SeedItem[]>;
  /** S10: the visuals (./simple-visuals.ts), shared with the one-pager's. */
  visuals?: VisualsDb;
  /** walkb-roadmap review: the PRD's one-pager, whose bets' flows its items show. */
  onePager?: OnePagerDb;
  /** S8: decided decisions that changed each item (by item id), newest first. */
  decided_in?: Record<string, Schemas["SimpleDecidedRef"][]>;
  /** The plan-model lane (./simple-plan.ts): Guided setup's plan, in the "simple-plan" scenario. */
  plan?: PlanDb;
  /** "goal-buckets-undated": the plan's roadmap has no approved version yet, so Priorities reads no dated plan. */
  plan_undated?: boolean;
  /** roadmap-keydates: each PRD's dated milestones as its latest approved version has them
   * (PRD slug -> milestones), read by the server before every request (prdMilestonesOf). */
  prd_milestones?: Record<string, PrdMilestone[]>;
  /** lane-gt-ui: each baseline feature's code (F-12), by id: an item reads its feature's code (server.ts). */
  feature_codes?: Record<string, string>;
  /** build-milestones-on-roadmap: each roadmap's milestones per goal (./simple-milestones.ts). */
  goal_milestones?: MockMilestone[];
  /** roadmap-keydates review ("roadmap-keydates-uncoded"): a track milestone record's own day
   * (record name -> day), as a record with a target date reads; none: undated. */
  record_dates?: Record<string, string>;
  /** approved-roadmap-to-simple: roadmaps Simple knows besides ROADMAPS (slug -> its title,
   * PRD, track key and track title), known while their items are the roadmap's. */
  extra_roadmaps?: Record<string, { title: string; prd: string; track: string; track_title: string }>;
  /** one-roadmap-many-prds (api/oracle/roadmap/company.feeding_ids): the company roadmap's slug;
   * while set, its items alone feed Simple and older per-PRD roadmaps' items are history. */
  company_roadmap?: string;
  /** simple-replaced-prds (api/oracle/roadmap/company.replaced_prd_ids): the ids and slugs of the
   * PRDs marked replaced, set by server.ts from its documents; their items no longer feed Simple. */
  replaced_prds?: string[];
  /** The current PRD each replaced one (by id and slug) went to: its first "Replaced by",
   * followed while that one is replaced too (additions._home files a new item under it). */
  replaced_with?: Record<string, Schemas["SimpleDocRef"]>;
  /** approved-roadmap-to-simple (./approved-roadmap.ts): what each roadmap's last applied version said. */
  applied?: Record<string, AppliedRecord>;
}

/** roadmap-keydates: a PRD's milestone as its plan reads it: its code, name and end day. */
export type PrdMilestone = { code: string; name: string; date: string };

/** A roadmap's key date (roadmap_key_dates): invented names and days. */
export interface MockKeyDate {
  id: string;
  name: string;
  date: string;
  note: string | null;
}

/** S7: one of Oracle's suggested features for a goal, as stored. */
export interface GoalSuggestionRow {
  id: string;
  /** oracle.simple.quality: Oracle's suggestion failed its checks twice (their plain words): owners only. */
  checks?: string[];
  goal: string;
  title: string;
  outcome: string;
  why: string;
  evidence: Schemas["SimpleEvidence"][];
  status: "open" | "accepted" | "rejected";
  reason: string | null;
  origin: "auto" | "on_demand" | "person";
  /** A person's suggestion (origin "person"): who sent it. */
  proposed_by?: string | null;
  created_at: string;
  decided_by_name: string | null;
  decided_at: string | null;
  change_id: string | null;
  item_id: string | null;
  flow: Schemas["SimpleFlow"] | null;
}

/** A reader, with every member's role (D-a: a track owner decides only as an approver or owner). */
export interface Who {
  id: string;
  role: Role;
  roles?: Record<string, Role>;
  /** The company's owners (who decide an item with no decider) and every member's display name. */
  owners?: string[];
  names?: Record<string, string>;
}

/** A working draft of one roadmap (oracle.simple.drafts): the items in `db.items` are the
 * draft's; `published` keeps the roadmap's published items for those who may not see it. */
interface MockDraft {
  out: Omit<Schemas["SimpleDraftOut"], "changes" | "can_submit" | "can_resume" | "can_approve" | "can_publish" | "required_reviewers" | "change_log" | "can_withdraw" | "from_prds" | "published">;
  roadmap: string;
  published: { items: SeedItem[]; own: SimpleDb["own"]; key_dates?: MockKeyDate[] };
  /** approved-prd-roadmap: what each approved PRD put in it (PRD slug -> item keys, key date ids). */
  prds?: Record<string, { prd: Schemas["SimpleDocRef"]; version: number; keys: string[]; key_dates: string[] }>;
}

/** `draft`: the number of the PRD draft (version) the roadmap's items were imported from. */
export const ROADMAPS: Record<string, { title: string; visibility: "company" | "approvers"; prd: string; draft: number }> = {
  "alerts-roadmap": { title: "Alerts roadmap", visibility: "company", prd: "Usage alerts", draft: 5 },
  "onboarding-roadmap": { title: "Onboarding roadmap", visibility: "company", prd: "Guided setup", draft: 2 },
  "pricing-roadmap": { title: "Pricing roadmap", visibility: "approvers", prd: "Plan changes", draft: 3 },
};
/**
 * plan-open-from-simple: an item's roadmap as the API names it, by its document's slug, the one
 * the Plan's rows carry (the Alerts roadmap is the usage-alerts-roadmap document); the picker
 * keeps the mock's own key.
 */
const ROADMAP_DOC_SLUG: Record<string, string> = { "alerts-roadmap": "usage-alerts-roadmap" };
/** The Simple roadmap whose items a roadmap document holds (its own slug, or alerts-roadmap for usage-alerts-roadmap). */
export const roadmapKeyOf = (docSlug: string): string => Object.keys(ROADMAP_DOC_SLUG).find((k) => ROADMAP_DOC_SLUG[k] === docSlug) ?? docSlug;
/** S7 adds Keep alerts quiet, a goal with no items yet (Oracle suggested features for it on its own). */
export const GOALS: Record<string, string> = { "grow-retention": "Grow retention", "faster-activation": "Faster activation", "quiet-alerts": "Keep alerts quiet" };
/** roadmap-talk's goals (the "roadmap-talk" scenario's items name them); known once such an item is seeded. */
export const TALK_GOALS: Record<string, string> = { reliability: "Reliability", growth: "Growth", activation: "Activation", revenue: "Revenue" };
const TALK_ITEM = "adaptive-pacing";
/**
 * The goals TALK_GOALS adds, when the roadmap holds roadmap-talk's items (the scenario's seed, or
 * a reload of it), or a PRD's dated plan ("simple-plan"...: its goals are these four, so people
 * suggest features under them from Priorities' Goal buckets).
 */
export function knowTalkGoals(db: { items: { key: string }[]; plan?: unknown }): void {
  if (!(TALK_ITEM in GOALS_KNOWN) && (db.items.some((x) => x.key === TALK_ITEM) || !!db.plan)) {
    Object.assign(GOALS, TALK_GOALS);
    GOALS_KNOWN[TALK_ITEM] = true;
  }
}
const GOALS_KNOWN: Record<string, boolean> = {};
/** Confirmed Baseline goals a scenario adds by their own ids (goal-ladder's), id to title: add_item may name them. */
export const MAP_GOALS: Record<string, string> = {};

/**
 * build-goal-order-control: the "goal-order" scenarios' added goals (server.ts seeds them), named
 * while the Ground Truth holds them confirmed so their roadmap work names its goal. As knowManyPlans,
 * once another scenario's data loads the ones it added are taken out again. Invented data.
 */
const GOAL_ORDER_GOALS: Record<string, string> = {
  "g.paid-conversion": "Grow paid conversion",
  "support-load": "Cut support load",
  "guided-week": "Make the first week feel guided for every new team, from sign-up to their first shared report",
  "mid-size": "Win more mid-size teams",
  "page-speed": "Faster page loads",
};
let goalOrderAdded: string[] = [];
export function knowGoalOrderGoals(entities: { key: string; status: string }[]): void {
  const scenario = entities.some((e) => e.key === "support-load");
  const want = Object.keys(GOAL_ORDER_GOALS).filter((k) => scenario && entities.some((e) => e.key === k && e.status === "confirmed"));
  for (const k of goalOrderAdded) if (!want.includes(k)) delete GOALS[k];
  goalOrderAdded = goalOrderAdded.filter((k) => want.includes(k));
  for (const k of want)
    if (!(k in GOALS)) {
      GOALS[k] = GOAL_ORDER_GOALS[k];
      goalOrderAdded.push(k);
    }
}

/**
 * goal-order: the company's goals (the Ground Truth's), so Simple's goal refs, groups, buckets and
 * goal cards follow the one goal order (lib/goal-order.ts). server.ts names them before every
 * Simple route; a goal the Ground Truth does not hold comes after those it does, by key.
 */
let companyGoals: (OrderedGoal & { key: string })[] = [];
export function knowCompanyGoals(goals: (OrderedGoal & { key: string })[]): void {
  companyGoals = sortGoals(goals);
}
/** A goal's place in the one goal order (by key). */
export function goalRank(key: string): number {
  const n = companyGoals.findIndex((g) => g.key === key);
  return n < 0 ? Number.MAX_SAFE_INTEGER : n;
}
/** A goal's position (by key), null when unset or unknown. */
export function goalPositionOf(key: string): number | null {
  const g = companyGoals.find((x) => x.key === key);
  return g ? goalPosition(g) : null;
}

/** The PRD's own code of a section an item came from ("f-06" -> "F-06"); null when the key is no code (service.py). */
export function prdCode(section: string | null | undefined): string | null {
  const m = /^([a-z]{1,3})-(\d+)$/i.exec((section ?? "").trim());
  return m ? `${m[1].toUpperCase()}-${m[2]}` : null;
}

/** roadmap-edit-fixes (service.coded_title): an item whose title carries its code ("F-07
 * Alpha") reads as code F-07 and name Alpha; else its code and title. */
export function codedTitle(title: string, code: string | null): [string | null, string] {
  const m = /^([A-Z][A-Z0-9]*-\d+[a-z]?)\s+(\S.*)$/.exec(title);
  if (!m || (code && code !== m[1])) return [code, title];
  return [m[1], m[2].trim()];
}

/** The item a stored dependency key names: its key, its code, else the key of its feature. */
export function dependencyOf(items: SeedItem[], k: string): SeedItem | undefined {
  const low = k.toLowerCase();
  return items.find((x) => x.key === k) ?? items.find((x) => [codedTitle(x.title, prdCode(x.section))[0], x.feature_key].some((c) => !!c && c.toLowerCase() === low));
}

/** roadmap-edit-fixes (changes.loop_of): why `key` may not depend on `keys`: one already
 * depends on it, directly or through others; null when none closes a loop. */
export function loopOf(items: SeedItem[], key: string, keys: string[], ignore: string[] = []): string | null {
  const named = (x: SeedItem) => { const [c, t] = codedTitle(x.title, prdCode(x.section)); return c ? `${c} ${t}` : t; };
  const self = items.find((x) => x.key === key);
  if (!self) return null;
  for (const k of keys) {
    const d = dependencyOf(items, k);
    if (!d || d.key === key || ignore.includes(d.key)) continue;
    const seen = new Set<string>();
    const todo = [d.key];
    while (todo.length) {
      const cur = todo.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (cur === key) return `${named(d)} already depends on ${named(self)}`;
      const x = items.find((i) => i.key === cur);
      for (const n of x?.depends ?? []) { const y = dependencyOf(items, n); if (y && !ignore.includes(y.key)) todo.push(y.key); }
    }
  }
  return null;
}

/** An item named as the API's visuals name it (subject_name): "F-06 Weekly alert digest", or its title with no code. */
export function itemSubjectName(db: Pick<SimpleDb, "items" | "ids"> | undefined, id: string): string | null {
  const key = db && Object.keys(db.ids).find((k) => db.ids[k] === id);
  const item = key ? db!.items.find((s) => s.key === key) : undefined;
  if (!item) return null;
  const code = prdCode(item.section);
  return code ? `${code} ${item.title}` : item.title;
}

/** "F-06 Loop guards": the section's code with its heading, else with the feature's name;
 * never the section's key (service.prd_section_label). */
function sectionLabel(section: string, heading: string | undefined, name: string): string {
  const code = prdCode(section);
  let words = (heading ?? "").trim() || name.trim();
  if (code && words.toUpperCase().startsWith(code)) words = words.slice(code.length).replace(/^[\s:.\-·–—]+/, "");
  return `${code ?? ""} ${words}`.trim();
}

/** S4: each goal's metric (the goal counters' line). */
const METRICS: Record<string, string> = { "grow-retention": "Teams active after 90 days", "faster-activation": "Days to the first alert", "quiet-alerts": "Teams muting alerts" };
/** roadmap-gantt ("simple-plan-two"): a goal named like a plan goal ("Growth"), for the plan's items only. */
const PLAN_GOALS: Record<string, string> = { growth: "Growth" };
/** one-feature-panel: each goal's target and date (invented), as the goal edit reads them. */
const TARGETS: Record<string, [string, string]> = { "grow-retention": ["70% of teams", "2027-03-31"], "faster-activation": ["2 days", "2027-02-26"], "quiet-alerts": ["Under 10% of teams", "2027-03-31"] };
/** build-feature-panel (AN PR 1204): each goal's latest reading and unit (invented), the panel's Reading row. */
const READINGS: Record<string, { current: number; unit: string }> = { "grow-retention": { current: 61, unit: "%" }, "faster-activation": { current: 3, unit: "days" } };
export type RoadmapGoalFields = { title: string; metric: string | null; target: string | null; due: string | null };
/** A goal's key from its id (the goal edit takes either kind of goal, as the API's one goal entity):
 * a roadmap goal's, or a goal bucket's of that key. */
export const roadmapGoalKey = (id: string, db?: Pick<SimpleDb, "goal_buckets">): string | null =>
  [...Object.keys(GOALS), ...Object.keys(PLAN_GOALS), ...(db?.goal_buckets?.goals.filter((g) => !g.trashed).map((g) => g.key) ?? [])].find((k) => stableUuid(`simple-goal/${k}`) === id) ?? null;
/** The goal bucket of a roadmap goal's key, not in Trash: the one goal both read and write. */
const bucketGoalOf = (db: Pick<SimpleDb, "goal_buckets">, key: string) => db.goal_buckets?.goals.find((g) => g.key === key && !g.trashed);
/** trash-features-goals: whether the goal of this key is in Trash (left out of every item's goal). */
export const goalInTrash = (db: Pick<SimpleDb, "goal_buckets">, key: string): boolean =>
  (db.goal_buckets?.goals ?? []).some((g) => g.trashed && (g.key === key || g.title.toLowerCase() === (GOALS[key] ?? PLAN_GOALS[key] ?? "").toLowerCase()));
/** The seeded fields of a roadmap goal (a goal bucket of its key starts from them). */
export const roadmapGoalSeed = (key: string): RoadmapGoalFields => ({ title: GOALS[key] ?? PLAN_GOALS[key], metric: METRICS[key] ?? null, target: TARGETS[key]?.[0] ?? null, due: TARGETS[key]?.[1] ?? null });
/** The goal's fields as read: its goal bucket's (one goal store, as the API's one goal entity), else an edit, else its seed. */
export const roadmapGoal = (db: Pick<SimpleDb, "goal_edits" | "goal_buckets">, key: string): RoadmapGoalFields => {
  const b = bucketGoalOf(db, key);
  if (b) return { title: b.title, metric: b.measure, target: b.target, due: b.due };
  return db.goal_edits?.[key] ?? roadmapGoalSeed(key);
};
/** A goal's name, measure, target and date written where every page reads them: its goal bucket, else the roadmap goal's edit. */
export function writeRoadmapGoal(db: Pick<SimpleDb, "goal_edits" | "goal_buckets">, key: string, fields: RoadmapGoalFields): void {
  const b = bucketGoalOf(db, key);
  if (b) Object.assign(b, { title: fields.title, measure: fields.metric, target: fields.target, due: fields.due });
  else (db.goal_edits ??= {})[key] = fields;
}
export const goalId = (key: string): string => stableUuid(`simple-goal/${key}`);
/** The item's goal_ids as the API reads them (set_goals' before): the goal it moves most first. */
export function goalIdsOf(s: { goal?: string; goals?: string[] }): string[] {
  return [...new Set([...(s.goal ? [s.goal] : []), ...(s.goals ?? [])])].map(goalId);
}
export const roadmapId = (slug: string): string => stableUuid(`simple-doc/${slug}`);
// A new company has no roadmap yet (qa-shell-8: oracle.simple.service reads none).
export const ROADMAP_SLUGS = (): string[] => (newCompany() ? [] : Object.keys(ROADMAPS));
/** Whether a commenter or viewer reads the roadmap (oracle.docs.visibility). */
export const readsRoadmap = (slug: string, role: Role): boolean => !(role === "commenter" || role === "viewer") || ROADMAPS[slug]?.visibility === "company";
type StoredTask = { id: string; title: string; status: Schemas["SimpleItemTask"]["status"]; owner_id: string | null; owner_name: string | null; due_date: string | null; item_id: string; at: string };
const storedTasks = (db: SimpleDb): StoredTask[] =>
  Object.entries(db.targets ?? {})
    .filter(([, v]) => v.kind === "item_task")
    .map(([id, v]) => ({ ...(v as Omit<StoredTask, "id">), id }))
    .sort((a, b) => (a.at < b.at ? -1 : 1));
const taskOut = (t: StoredTask): Schemas["SimpleItemTask"] => ({ id: t.id, title: t.title, status: t.status, owner: t.owner_id ? { id: t.owner_id, name: t.owner_name ?? "someone" } : null, due_date: t.due_date });
/** walkc-roadmap-tasks: an item's tasks, not dropped, in the order they were added. */
export const itemTasks = (db: SimpleDb, itemId: string): Schemas["SimpleItemTask"][] => storedTasks(db).filter((t) => t.item_id === itemId && t.status !== "dropped").map(taskOut);
/** walkc-roadmap-tasks: the open tasks waiting on `me` (questions.tasks_waiting), due first. */
export function tasksWaiting(db: SimpleDb, me: { id: string; role: Role }): Schemas["SimpleTaskWaiting"][] {
  const today = companyToday();
  return storedTasks(db)
    .filter((t) => t.owner_id === me.id && (t.status === "todo" || t.status === "doing"))
    .flatMap((t) => {
      const key = Object.keys(db.ids).find((k) => db.ids[k] === t.item_id);
      const s = key ? db.items.find((x) => x.key === key) : undefined;
      if (!s || !readsRoadmap(s.roadmap, me.role)) return [];
      return [{ ...taskOut(t), item_id: t.item_id, item_title: s.title, roadmap_id: roadmapId(s.roadmap), late: !!t.due_date && t.due_date < today }];
    })
    .sort((a, b) => (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999"));
}
/** The roadmap a slug or id names, when the role reads it. */
export const readableRoadmap = (asked: string | null, role: Role): string | undefined =>
  asked ? ROADMAP_SLUGS().find((r) => (r === asked || roadmapId(r) === asked) && readsRoadmap(r, role)) : undefined;
/** S7: an item closed for the plan (cut, or a draft merged into another). */
export const closed = (s: SeedItem): boolean => s.status === "cut" || !!s.merged_into;
/** roadmap-done (owner, Nov 4), as the API's status: a done (shipped) item is off the roadmap, never checked, and holds nothing up. */
export const doneItem = (s: SeedItem): boolean => !closed(s) && !s.draft && s.status === "done";
export const TRACKS: Record<string, string> = { alerts: "Usage alerts track", onboarding: "Guided setup track", welcome: "Welcome media track" };

const SEED: SeedItem[] = [
  { key: "alert-rules", title: "Alert rules engine", horizon: "now", roadmap: "alerts-roadmap", goal: "grow-retention", track: "alerts", confidence: "high", start: 0, end: 40, source: "typed", status: "in_progress", gates: [{ phase: "discover", day: 6 }, { phase: "build", day: 28 }], why: "Admins asked for it most this quarter.", section: "bets" },
  { key: "alert-digest", title: "Weekly alert digest", horizon: "now", roadmap: "alerts-roadmap", goal: "grow-retention", track: "alerts", confidence: "medium", start: 30, end: 70, source: "accepted", depends: ["alert-rules"], milestone: { name: "Beta", day: 60 }, section: "f-06", heading: "F-06 Weekly digest of fired alerts" },
  { key: "alert-mobile", title: "Mobile alert push", horizon: "now", roadmap: "alerts-roadmap", goal: "grow-retention", track: "alerts", confidence: "high", end: 80, source: "engineering", depends: ["alert-rules"], status: "in_progress" },
  { key: "alert-export", title: "Alert history export", horizon: "next", roadmap: "alerts-roadmap", track: "alerts", confidence: "medium", end: 50, source: "tracker" },
  { key: "alert-sso", title: "Alert routing by team", horizon: "next", roadmap: "alerts-roadmap", goal: "grow-retention", track: "alerts", confidence: "low", depends: ["alert-export"] },
  { key: "setup-checklist", title: "Setup checklist", horizon: "now", roadmap: "onboarding-roadmap", goal: "faster-activation", track: "onboarding", confidence: "high", start: 10, end: 45, source: "typed", status: "in_progress", gates: [{ phase: "Beta", day: 40 }] },
  { key: "setup-import", title: "Sample data import", horizon: "now", roadmap: "onboarding-roadmap", goal: "faster-activation", track: "onboarding", confidence: "medium", start: 20, end: 60, source: "typed", status: "in_progress", depends: ["setup-checklist"], gates: [{ phase: "beta", day: 75 }], risks: [{ flag: "dependency_order", note: "The checklist's last step is not needed" }] },
  { key: "setup-tour", title: "In-app tour", horizon: "later", roadmap: "onboarding-roadmap", goal: "faster-activation", track: "onboarding", status: "cut", start: 30, end: 75, source: "typed" },
  { key: "setup-video", title: "Welcome video", horizon: "later", roadmap: "onboarding-roadmap", track: "onboarding", depends: ["setup-tour"] },
  { key: "setup-ideas", title: "Team invite nudges", horizon: "next", roadmap: "onboarding-roadmap", goal: "faster-activation", draft: true },
  // one-feature-panel: the Guided setup PRD's F-03 (the feature its decisions block), on its roadmap as the API has it.
  { key: "setup-health-log", title: "Health log", horizon: "later", roadmap: "onboarding-roadmap", track: "onboarding", confidence: "low", section: "f-03", heading: "F-03 Health log" },
  { key: "price-tiers", title: "New plan tiers", horizon: "next", roadmap: "pricing-roadmap", confidence: "medium" },
];

/**
 * walkb-roadmap review: the flow drawn on the PRD's one-pager for the bet an item was built
 * from (service.bet_flows): the bet naming the item's code or title, else the one bet drawn
 * from the item's PRD section alone; null for an item not built from a PRD section.
 */
function betFlow(db: SimpleDb, s: SeedItem): Schemas["SimpleFlow"] | null {
  const op = db.onePager;
  if (!op || !s.section || ROADMAPS[s.roadmap].prd.toLowerCase().replace(/ /g, "-") !== op.doc.slug) return null;
  const bets = op.blocks.find((b) => b.key === "bets")?.lines ?? [];
  const words = (t: string) => ` ${t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
  const code = prdCode(s.section);
  // roadmap-keydates: its own bet: the one naming its code, else the one bet from its section
  // alone, else the one bet its title names (a short title two bets mention names neither).
  const one = <T,>(xs: T[]): T | undefined => (xs.length === 1 ? xs[0] : undefined);
  const line =
    one(bets.filter((l) => !!code && words(l.text).includes(words(code)))) ??
    one(bets.filter((l) => l.keys.includes(s.section!))) ??
    one(bets.filter((l) => !!s.title.trim() && words(l.text).includes(words(s.title))));
  return line ? flowFor(db.visuals, "one_pager_line", betSubject(op.flowKey ? `${op.flowKey}/${line.id}` : line.id)) : null;
}

const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const ms = (day: string): number => Date.parse(`${day}T00:00:00Z`);
const addDays = (day: string, n: number): string => iso(ms(day) + n * DAY);
/** Today: the company's day (its time zone), as oracle.company_time.company_today (qa-shell-6). */
export const companyToday = (): string => companyDayIso(new Date(mockNowMs()));
const span = (a: string, b: string): number => Math.round((ms(b) - ms(a)) / DAY) + 1;
const word = (day: string): string => new Date(ms(day)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function addMonths(day: string, months: number): string {
  const d = new Date(ms(day));
  const y = d.getUTCFullYear() + Math.floor((d.getUTCMonth() + months) / 12);
  const m = (d.getUTCMonth() + months) % 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return iso(Date.UTC(y, m, Math.min(d.getUTCDate(), last)));
}

/** oracle.simple.dates.windows with the default horizons, on the mock's day: Later starts the
 * day after Next ends (no gap) and ends where the long horizon ends (today + 24 months). */
export function simpleWindows(today: string): Record<Horizon, [string, string]> {
  const d = new Date(ms(today));
  const q = iso(Date.UTC(d.getUTCFullYear(), 3 * Math.floor(d.getUTCMonth() / 3), 1));
  const medium = addMonths(q, 3);
  const mediumEnd = addMonths(medium, 6);
  return { now: [q, addDays(medium, -1)], next: [medium, addDays(mediumEnd, -1)], later: [mediumEnd, addMonths(today, 24)] };
}

/**
 * The "simple-deciders" scenario (#734 review, D-a): the pricing roadmap names a decider and
 * each track an owner of another role; the welcome video and tour move to the welcome
 * track. People are member ids.
 */
export function seedSimpleDeciders(people: { decider: string; approver: string; commenter: string; viewer: string }): SimpleDb {
  const db = seedSimpleRoadmap();
  for (const s of db.items) if (s.key === "setup-tour" || s.key === "setup-video") s.track = "welcome";
  db.deciders = { "pricing-roadmap": people.decider };
  db.track_owners = { alerts: people.approver, onboarding: people.commenter, welcome: people.viewer };
  return db;
}

export function seedSimpleRoadmap(): SimpleDb {
  // A new company: no items yet, so no plan, broken links, priorities or key dates (Detailed says no goals).
  // Nor Oracle's goal suggestions (no goal is confirmed yet: none are made on its own).
  if (newCompany()) return { items: [], ids: {}, own: {}, suggestions: [], decisions: {}, key_dates: {}, goal_suggestions: [], goal_jobs: {}, auto_done: Object.keys(GOALS) };
  return seeded("simple-roadmap", () => ({
    items: SEED.map((s) => ({ ...s })),
    ids: Object.fromEntries(SEED.map((s) => [s.key, stableUuid(`simple-item/${s.key}`)])),
    own: {},
    suggestions: [],
    decisions: { "alert-digest": [{ number: 7, title: "Send the digest weekly or daily?" }] },
    key_dates: seedKeyDates(),
  }));
}

/** Roadmap-plus: invented key dates, days from this quarter's start on the mock's clock. */
export function seedKeyDates(): Record<string, MockKeyDate[]> {
  const q = simpleWindows(companyToday()).now[0];
  return {
    "alerts-roadmap": [{ id: stableUuid("simple-key-date/conference"), name: "Customer conference", date: addDays(q, 44), note: "Keynote slot for alerts" }],
    "onboarding-roadmap": [{ id: stableUuid("simple-key-date/board"), name: "Board meeting", date: addDays(q, 75), note: null }],
  };
}

/**
 * The dates an item stores (its start_date/end_date columns in the API): a typed or accepted
 * seed's dates, or those Simple set; null for engineering, tracker and estimated dates.
 */
export function storedDates(db: SimpleDb, key: string): { start: string | null; end: string | null } {
  const own = db.own[key];
  if (own) return { start: own.start, end: own.end };
  const s = db.items.find((x) => x.key === key)!;
  // hotfix-2: a PRD's item stores the dates the PRD gave it (an engineering end-only one too).
  if (s.dates) return { start: s.dates.start, end: s.dates.end };
  if (s.source !== "typed" && s.source !== "accepted") return { start: null, end: null };
  const w = simpleWindows(companyToday())[s.horizon];
  return { start: s.start !== undefined ? addDays(w[0], s.start) : null, end: s.end !== undefined ? addDays(w[0], s.end) : null };
}

/**
 * The "simple-500" scenario (S4, dod-perf: first paint and drag speed): a company-wide
 * roadmap of 500 invented items over 12 roadmaps (each from its own PRD), 8 goals and 6
 * tracks, two in three dated, with chains of dependencies inside each roadmap.
 */
const MANY_PRDS = ["Billing portal", "Team spaces", "Audit trail", "Usage reports", "Mobile app", "Search", "Integrations hub", "Data export", "Access control", "Notifications", "Help center", "Partner API"];
const MANY_GOALS: Record<string, string> = {
  "grow-retention": "Grow retention", "faster-activation": "Faster activation", "win-teams": "Win larger teams", "cut-churn": "Cut churn",
  "trust-security": "Earn security trust", "open-platform": "Open the platform", "self-serve": "Self-serve support", "go-mobile": "Work from phones",
};
const MANY_TRACKS: Record<string, string> = { "web-core": "Web core track", "mobile": "Mobile track", "platform": "Platform track", "data": "Data track", "growth": "Growth track", "security": "Security track" };
const MANY_WORDS = ["Faster", "Simpler", "Shared", "Bulk", "Scheduled", "Smarter", "Offline", "Guided"];
const MANY_THINGS = ["invoices", "filters", "exports", "invites", "alerts", "reports", "settings", "search", "roles", "dashboards", "imports", "comments", "webhooks"];
const manySlug = (n: number): string => `${MANY_PRDS[n].toLowerCase().replace(/ /g, "-")}-roadmap`;
/**
 * The 500-item scenario's roadmaps, goals and tracks, known once its items are seeded or reloaded
 * (as knowTalkGoals). dod-perf review: once the roadmap holds them no longer (another scenario's
 * data), the ones it added are taken out again.
 */
let manyAdded: { roadmaps: string[]; goals: string[]; tracks: string[] } | null = null;
export function knowManyPlans(db: { items: { key: string; roadmap: string }[] } | undefined): void {
  knowFitRoadmap(db);
  const many = !!db?.items.some((x) => x.roadmap === manySlug(0));
  if (many && !manyAdded) {
    manyAdded = {
      roadmaps: MANY_PRDS.map((_, n) => manySlug(n)).filter((k) => !(k in ROADMAPS)),
      goals: Object.keys(MANY_GOALS).filter((k) => !(k in GOALS)),
      tracks: Object.keys(MANY_TRACKS).filter((k) => !(k in TRACKS)),
    };
    MANY_PRDS.forEach((prd, n) => (ROADMAPS[manySlug(n)] ??= { title: `${prd} roadmap`, visibility: "company", prd, draft: 1 + (n % 4) }));
    for (const k of manyAdded.goals) GOALS[k] = MANY_GOALS[k];
    for (const k of manyAdded.tracks) TRACKS[k] = MANY_TRACKS[k];
  } else if (!many && manyAdded) {
    for (const k of manyAdded.roadmaps) delete ROADMAPS[k];
    for (const k of manyAdded.goals) delete GOALS[k];
    for (const k of manyAdded.tracks) delete TRACKS[k];
    manyAdded = null;
  }
}

/**
 * approved-roadmap-to-simple: the roadmaps and tracks a db adds (SimpleDb.extra_roadmaps), known
 * while it is the roadmap's, as knowManyPlans; taken out again once it is not.
 */
let extraAdded: { roadmaps: string[]; tracks: string[] } = { roadmaps: [], tracks: [] };
export function knowExtraRoadmaps(db: { extra_roadmaps?: SimpleDb["extra_roadmaps"] } | undefined): void {
  for (const k of extraAdded.roadmaps) delete ROADMAPS[k];
  for (const k of extraAdded.tracks) delete TRACKS[k];
  extraAdded = { roadmaps: [], tracks: [] };
  for (const [slug, r] of Object.entries(db?.extra_roadmaps ?? {})) {
    if (!(slug in ROADMAPS)) {
      ROADMAPS[slug] = { title: r.title, visibility: "company", prd: r.prd, draft: 1 };
      extraAdded.roadmaps.push(slug);
    }
    if (!(r.track in TRACKS)) {
      TRACKS[r.track] = r.track_title;
      extraAdded.tracks.push(r.track);
    }
  }
}

export function seedSimpleMany(n = 500): SimpleDb {
  const goals = Object.keys(MANY_GOALS);
  const tracks = Object.keys(MANY_TRACKS);
  const horizons: Horizon[] = ["now", "next", "later"];
  const items: SeedItem[] = Array.from({ length: n }, (_, i) => {
    const dated = i % 3 !== 2;
    const start = (i * 7) % 60;
    return {
      key: `item-${i}`, title: `${MANY_WORDS[i % 8]} ${MANY_THINGS[i % 13]} ${Math.floor(i / 12) + 1}`, horizon: horizons[i % 3], roadmap: manySlug(i % 12),
      goal: goals[i % 8], track: tracks[i % 6], confidence: (["low", "medium", "high"] as const)[i % 3],
      ...(dated ? { start, end: start + 20 + (i % 30), source: "typed" as const } : {}),
      ...(i >= 12 && i % 5 === 3 ? { depends: [`item-${i - 12}`] } : {}),
    };
  });
  const db: SimpleDb = { items, ids: Object.fromEntries(items.map((s) => [s.key, stableUuid(`simple-item/${s.key}`)])), own: {}, suggestions: [] };
  knowManyPlans(db);
  return db;
}

/**
 * Bring a date in (./fit-date.ts): its invented PRD's items on the Help desk roadmap, under the
 * fit-date scenarios, ending where its plan has them. An approved re-plan moves them
 * (fitDateApproved), as the API's fit_date_router._roadmap_follows does in the roadmap's next version.
 */
const FIT_ROADMAP = "help-desk-roadmap";
const FIT_PRD = { id: stableUuid("fit-date/prd"), slug: "reply-faster", title: "Reply faster in the shared inbox" };
// Each item ends where the fit-date plan's capacity queue has it (./fit-date-engine, the API's
// fit_date.schedule), so the roadmap and the panel read the same dates.
const FIT_PLAN = fitBasePlan(1, FIT_PLAN_TARGET);
const FIT_SCHEDULE = fitSchedule(FIT_PLAN);
const FIT_M1_END = FIT_SCHEDULE.milestones.M1;
const FIT_ITEMS: [key: string, title: string, end: string][] = FIT_PLAN.items.map((i) => [`fit-${i.id}`, i.title, FIT_SCHEDULE.items[i.id]]);
const horizonOf = (end: string): Horizon => {
  const w = simpleWindows(companyToday());
  return end <= w.now[1] ? "now" : end <= w.next[1] ? "next" : "later";
};

/** The Help desk roadmap, its goal and track, known while the roadmap holds its items (as knowManyPlans). */
function knowFitRoadmap(db: { items: { roadmap: string }[] } | undefined): void {
  if (db?.items.some((x) => x.roadmap === FIT_ROADMAP)) {
    ROADMAPS[FIT_ROADMAP] ??= { title: "Help desk roadmap", visibility: "company", prd: FIT_PRD.title, draft: 3 };
    GOALS["reply-faster"] ??= "Reply faster";
    TRACKS["help-desk"] ??= "Help desk track";
  } else if (ROADMAPS[FIT_ROADMAP]) {
    delete ROADMAPS[FIT_ROADMAP];
    delete GOALS["reply-faster"];
    delete TRACKS["help-desk"];
  }
}

/** An item only the Help desk roadmap holds once the company roadmap exists: history, never on Simple. */
export const FIT_OLD_ITEM = "Saved reply folders";

/**
 * The fit-date scenarios: the Help desk roadmap's items, added to the company's roadmap. With
 * `company` (one-roadmap-many-prds), they sit on the company roadmap (Product roadmap), which alone
 * feeds Simple, and the PRD's older Help desk roadmap keeps one item of its own as history.
 */
export function seedFitDateRoadmap(db: SimpleDb, company = false): void {
  const roadmap = company ? COMPANY_SLUG : FIT_ROADMAP;
  for (const [key, title, end] of FIT_ITEMS) {
    db.items.push({
      key, title, horizon: horizonOf(end), roadmap, goal: "reply-faster", track: "help-desk", confidence: "medium",
      status: end <= FIT_M1_END ? "in_progress" : "planned", prd_doc: FIT_PRD,
      dates: { start: addDays(end, -20), end, source: "engineering" },
    });
    db.ids[key] = stableUuid(`simple-item/${key}`);
  }
  if (company) {
    const end = "2027-01-15";
    db.items.push({
      key: "fit-old-folders", title: FIT_OLD_ITEM, horizon: horizonOf(end), roadmap: FIT_ROADMAP, goal: "reply-faster", track: "help-desk",
      confidence: "medium", status: "planned", prd_doc: FIT_PRD, dates: { start: addDays(end, -20), end, source: "engineering" },
    });
    db.ids["fit-old-folders"] = stableUuid("simple-item/fit-old-folders");
    db.extra_roadmaps = { ...db.extra_roadmaps, [COMPANY_SLUG]: { title: COMPANY_TITLE, prd: FIT_PRD.title, track: "help-desk", track_title: "Help desk track" } };
    // The company roadmap alone feeds Simple (api/oracle/roadmap/company.feeding_ids).
    db.company_roadmap = COMPANY_SLUG;
  }
  knowFitRoadmap(db);
}

/** Moves an approve sent, until the request's roadmap takes them (applyFitDate). */
let fitMoves: { moves: { item: string; end?: string | null }[]; pending: string[] } | null = null;

/**
 * Bring a date in's approval (./fit-date.ts): each item (by key or title) moves to its new end
 * date (null: it leaves the plan's dates as they were), and the sliced or split ones wait on a
 * new estimate. Applied to the roadmap by applyFitDate in the same request.
 */
export function fitDateApproved(moves: { item: string; end?: string | null }[], pending: string[]): void {
  fitMoves = { moves, pending };
}

/** The approval's moves (fitDateApproved), made on the mock's roadmap; nothing when none waits. */
export function applyFitDate(db: SimpleDb | undefined): void {
  const was = fitMoves;
  fitMoves = null;
  if (!was || !db) return;
  // The re-plan lands on the company roadmap while there is one (fit_date_router._roadmap_id).
  const on = db.company_roadmap ?? FIT_ROADMAP;
  const named = (s: SeedItem, names: string[]) => s.roadmap === on && (names.includes(s.key) || names.includes(s.title));
  for (const s of db.items) {
    const to = was.moves.find((m) => named(s, [m.item]));
    if (to?.end && s.dates) {
      const start = s.dates.start && s.dates.start < addDays(to.end, -7) ? s.dates.start : addDays(to.end, -14);
      s.dates = { ...s.dates, start, end: to.end };
      s.horizon = horizonOf(to.end);
      delete db.own[s.key];
    }
    if (named(s, was.pending)) s.estimate_pending = true;
  }
}

/** The item's stored dates (the API's start_date, end_date, date_source columns): moved or
 * accepted in Simple, else the seed's typed or accepted dates; undefined when none. */
export function ownDates(db: SimpleDb, s: SeedItem): SimpleDb["own"][string] | undefined {
  if (db.own[s.key]) return db.own[s.key];
  if ((s.source !== "typed" && s.source !== "accepted") || s.start === undefined || s.end === undefined) return undefined;
  const w = simpleWindows(companyToday())[s.horizon];
  return { start: addDays(w[0], s.start), end: addDays(w[0], s.end), source: s.source };
}

/**
 * dates.lead_days (hotfix-effort-start): an estimated start lies the item's effort as Priorities
 * reads it (weeks x 7 calendar days) before a given end, else 28 days.
 */
function leadDays(db: SimpleDb, s: SeedItem): number {
  const weeks = estimates(db, s.key, db.ids[s.key] ?? stableUuid(`simple-item/${s.key}`)).effort;
  return weeks && weeks > 0 ? Math.floor(weeks * 7 + 0.5) : 28;
}

function resolve(db: SimpleDb, s: SeedItem, w: [string, string]): { start: Dated; end: Dated } {
  const own = db.own[s.key];
  if (own) {
    const source = own.source ?? "accepted";
    return { start: { date: own.start, source, estimated: false }, end: { date: own.end, source, estimated: false } };
  }
  if (s.dates) {
    const end: Dated = { date: s.dates.end, source: s.dates.source, estimated: false };
    if (s.dates.start) return { start: { date: s.dates.start, source: s.dates.source, estimated: false }, end };
    return { start: { date: addDays(end.date, -leadDays(db, s)), source: "estimated", estimated: true }, end };
  }
  const end: Dated = s.end !== undefined && s.source ? { date: addDays(w[0], s.end), source: s.source, estimated: false } : { date: w[1], source: "estimated", estimated: true };
  let start: Dated = { date: w[0], source: "estimated", estimated: true };
  if (s.start !== undefined && s.source) start = { date: addDays(w[0], s.start), source: s.source, estimated: false };
  else if (!end.estimated) start = { date: addDays(end.date, -leadDays(db, s)), source: "estimated", estimated: true };
  return { start, end };
}

/**
 * An item's own dates (stored, typed or estimated), before afterDependencies: an end-only item
 * that depends on another keeps its window's start here, not the start its bar takes after that
 * work. Its one caller (simple-home-move) stores these as typed, so its bar draws them as given.
 */
export function shownDates(db: SimpleDb, key: string): { start: string; end: string } {
  const s = db.items.find((x) => x.key === key)!;
  const r = resolve(db, s, simpleWindows(companyToday())[s.horizon]);
  return { start: r.start.date, end: r.end.date };
}

/** hotfix-2: the dates the roadmap shows for an item (after what it depends on), a move's `before`. */
export function readDates(db: SimpleDb, key: string): { start: string; end: string } {
  const w = simpleWindows(companyToday());
  const all = new Map(db.items.map((s) => [s.key, { s, r: resolve(db, s, w[s.horizon]) }]));
  afterDependencies(all);
  const r = all.get(key)!.r;
  return { start: r.start.date, end: r.end.date };
}

/**
 * oracle.simple.dates.after_dependencies (walkb-roadmap): an item dated only by its end starts
 * the day after what it depends on ends (the end itself when that is later); a fully estimated
 * bar (walkb-roadmap review) moves to start that day, keeping its length. Dependencies first;
 * changes `all` in place.
 */
function afterDependencies(all: Map<string, { s: SeedItem; r: { start: Dated; end: Dated } }>): void {
  const done = new Set<string>();
  const visit = (key: string) => {
    const x = all.get(key);
    if (!x || done.has(key)) return;
    done.add(key);
    const deps = (x.s.depends ?? []).filter((k) => k !== key && all.has(k) && !doneItem(all.get(k)!.s));
    deps.forEach(visit);
    const ends = deps.map((k) => all.get(k)!.r.end.date).sort();
    const latest = ends[ends.length - 1];
    if (!x.r.start.estimated || !latest || latest < x.r.start.date) return;
    const day = addDays(latest, 1);
    if (x.r.end.estimated) {
      const end = addDays(day, span(x.r.start.date, x.r.end.date) - 1);
      x.r = { start: { date: day, source: "estimated", estimated: true }, end: { date: end, source: "estimated", estimated: true } };
      return;
    }
    x.r = { start: { date: day < x.r.end.date ? day : x.r.end.date, source: "estimated", estimated: true }, end: x.r.end };
  };
  [...all.keys()].forEach(visit);
}

/** meeting-changes-only-its-agenda: the roadmap a PRD's own track is on (the one whose PRD it is). */
export const homeRoadmapOf = (prdSlug: string): string | undefined =>
  ROADMAP_SLUGS().find((r) => ROADMAPS[r].prd.toLowerCase().replace(/ /g, "-") === prdSlug);

/** meeting-changes-only-its-agenda ("meeting-agenda"): an item of another roadmap's PRD, as a
 * test roadmap built from the same PRD (Welcome video, on the onboarding roadmap, of Usage alerts). */
export function itemOfOtherPrd(db: SimpleDb, key: string, roadmap: string): void {
  const s = db.items.find((x) => x.key === key);
  if (s) s.prd_doc = itemPrd({ ...s, roadmap });
}

/** one-feature-panel: the Goal map's features as roadmap items (once the map is read), each its own. */
export function knowGoalMapItems(db: SimpleDb | undefined, items: { key: string; id: string; title: string; section: string }[]): void {
  for (const it of items) {
    if (!db || db.ids[it.key]) continue;
    db.items.push({ key: it.key, title: it.title, horizon: "next", roadmap: "onboarding-roadmap", track: "onboarding", confidence: "medium", section: it.section, heading: `${it.section.toUpperCase()} ${it.title}` });
    db.ids[it.key] = it.id;
  }
}

/** hotfix-2 ("simple-dated-move"): an Alerts PRD item dated only by its date source (engineering's
 * end, no start), as approving the PRD stores it on the draft; its start is estimated. */
export function dateSourceItem(db: SimpleDb): void {
  const end = "2027-04-02";
  db.items.push({ key: "alert-replay", title: "Alert replay engine", horizon: horizonOf(end), roadmap: "alerts-roadmap", track: "alerts", confidence: "medium", from_prd: { slug: "usage-alerts", title: "Usage alerts" }, dates: { start: null, end, source: "engineering" } });
  db.ids["alert-replay"] = stableUuid("simple-item/alert-replay");
}

/** cross-prd-deps ("simple-cross-prd-dates"): ``key`` also depends on ``dep``, an item of another PRD. */
export function dependOnOtherPrd(db: SimpleDb, key: string, dep: string): void {
  const s = db.items.find((x) => x.key === key);
  if (s) s.depends = [...(s.depends ?? []), dep];
}

/** The PRD a seeded item was built from (its roadmap's). */
function itemPrd(s: SeedItem): Schemas["SimpleDocRef"] {
  const prd = ROADMAPS[s.roadmap].prd;
  return { id: stableUuid(`simple-prd/${s.roadmap}`), slug: prd.toLowerCase().replace(/ /g, "-"), title: prd };
}

/** The PRD an item reads as its own: the one it was added from, else its roadmap's (the API's item.prd). */
export function ownPrd(s: SeedItem): Schemas["SimpleDocRef"] {
  if (s.prd_doc) return s.prd_doc;
  if (s.from_prd) return { id: stableUuid(`simple-prd/${s.from_prd.slug}`), slug: s.from_prd.slug, title: s.from_prd.title };
  return itemPrd(s);
}

/** A milestone no plan dates (the new SimpleMilestone fields, empty). */
const UNDATED = { start_date: null, end_date: null, effort_weeks: null, done_when: [] as string[], targets: [] as { goal: string; target: string }[] };

const PHASES = [["discover", 0.15], ["build", 0.55], ["beta", 0.2], ["launch", 0.1]] as const;

/** The track milestone record naming a seeded item, as the API's read carries it. */
function recordOf(s: { record?: string; track?: string }): { record_id?: string; record_name?: string } {
  return s.record ? { record_id: stableUuid(`simple-milestone/${s.track}/${s.record}`), record_name: s.record } : {};
}

/** oracle.simple.dates.phases: the milestone and gates naming a phase end it on their date;
 * every other phase keeps the 15/55/20/10 split of the bar, estimated. */
function phases(start: string, end: string, s: SeedItem, w: [string, string]): Schemas["SimplePhase"][] {
  const named = new Map<string, string>();
  for (const e of [...(s.milestone?.day != null ? [{ phase: s.milestone.name, day: s.milestone.day }] : []), ...(s.gates ?? [])]) {
    const word = (e.phase ?? "").trim().toLowerCase();
    if (PHASES.some(([k]) => k === word)) named.set(word, addDays(w[0], e.day));
  }
  const total = span(start, end);
  let cursor = start;
  let share = 0;
  return PHASES.map(([key, part], i) => {
    share += part;
    const own = named.get(key);
    let day = own ?? (i === PHASES.length - 1 ? end : addDays(start, Math.round(total * share) - 1));
    if (!own) {
      // An estimated phase ends before the next dated gate (roadmap-plus: they may bunch up).
      const gate = PHASES.slice(i + 1).map(([k]) => named.get(k)).filter((d): d is string => !!d).sort()[0];
      if (gate && day >= gate) day = addDays(gate, -1);
      if (day < cursor) day = cursor;
    }
    const out = { key, start: cursor < day ? cursor : day, end: day, estimated: !own };
    if (addDays(day, 1) > cursor) cursor = addDays(day, 1);
    return out;
  });
}

const short = (t: string): string => (t.length <= 40 ? t : `${t.slice(0, 39)}…`);

/** "Usage alerts PRD": a PRD's title with PRD after it when it does not say so (company.OnRoadmap.prd_name). */
const prdName = (title: string): string => (title.toLowerCase().endsWith("prd") ? title : `${title} PRD`);

/** A dependency_order line, naming the item and its dependency (constraints.check), with the years when they differ;
 * a dependency of another PRD is named with its PRD (the owner, Nov 4). */
function dependencyLine(title: string, start: string, depTitle: string, end: string, verb: "starts" | "ends" = "starts", depPrd: string | null = null): string {
  const years = start.slice(0, 4) !== end.slice(0, 4);
  const day = (d: string) => `${word(d)}${years ? ` ${d.slice(0, 4)}` : ""}`;
  return `‘${short(title)}’ ${verb} ${day(start)}, but ‘${short(depTitle)}’${depPrd ? ` (${depPrd})` : ""}, which it depends on, ends ${day(end)}`;
}

function flagsOf(s: SeedItem, r: { start: Dated; end: Dated }, all: Map<string, { s: SeedItem; r: { start: Dated; end: Dated } }>, w: [string, string]): Flag[] {
  const out: Flag[] = [];
  const flag = (kind: Flag["kind"], reason: string, fixes: Flag["fixes"], subject: string | null = null): void => {
    const risk = s.risks?.find((x) => x.flag === kind && (!x.subject || x.subject === subject));
    out.push({ kind, reason, fixes, state: risk ? "amber" : "red", subject, risk_note: risk?.note ?? null, moves: [], dependents: [] });
  };
  // roadmap-done, as constraints.check: a done item is not checked, and a dependency on one is met.
  if (doneItem(s)) return out;
  // roadmap-decide, as constraints.check: a cut item (below the line) is not checked for its order.
  for (const k of s.status === "cut" ? [] : (s.depends ?? [])) {
    // roadmap-edit-fixes round 1 (constraints.check): a key by code names its item; a done dependency is met whatever
    // its dates, and a cut item's own links break nothing.
    const key = all.has(k) ? k : (dependencyOf([...all.values()].map((x) => x.s), k)?.key ?? k);
    const dep = all.get(key);
    if (!dep || key === s.key || closed(dep.s) || closed(s) || dep.s.status === "done" || doneItem(dep.s) || (dep.r.end.estimated && r.start.estimated)) continue;
    const theirs = ownPrd(dep.s).title;
    const depPrd = theirs !== ownPrd(s).title ? prdName(theirs) : null;
    if (r.start.estimated) {
      // walkb-roadmap, as constraints.check: an invented start breaks no link; a real end before the dependency's end does.
      if (!r.end.estimated && dep.r.end.date >= r.end.date)
        flag("dependency_order", dependencyLine(s.title, r.end.date, dep.s.title, dep.r.end.date, "ends", depPrd), ["shift_dependents", "move_dependency", "accept_risk"], stableUuid(`simple-item/${key}`));
      continue;
    }
    if (dep.r.end.date >= r.start.date)
      flag("dependency_order", dependencyLine(s.title, r.start.date, dep.s.title, dep.r.end.date, "starts", depPrd), ["shift_dependents", "move_dependency", "accept_risk"], stableUuid(`simple-item/${key}`));
  }
  if (s.milestone?.day != null) {
    const day = addDays(w[0], s.milestone.day);
    if (r.end.date > day) flag("outside_milestone", `‘${short(s.title)}’ ends ${word(r.end.date)}, after its milestone ‘${s.milestone.name}’ (${word(day)})`, ["accept_risk"], s.milestone.name);
  }
  if (s.status === "cut") {
    const live = [...all.values()].filter((x) => x.s.status !== "cut" && !doneItem(x.s) && x.s.depends?.includes(s.key));
    if (live.length) {
      const more = live.length > 1 ? ` and ${live.length - 1} other${live.length > 2 ? "s" : ""}` : "";
      flag("cut_with_dependents", `Cut, but ‘${short(live[0].s.title)}’${more} ${live.length > 1 ? "depend" : "depends"} on it`, ["restore", "remove_dependency", "accept_risk"]);
    }
  }
  if (s.draft && !s.track && !closed(s)) flag("draft_without_owner", "Draft with no owner to confirm it", []);
  return out;
}

const days = (a: string, b: string): number => Math.round((ms(b) - ms(a)) / DAY);

/**
 * The new [start, end] of every item "Move the dependents" moves (changes.shift_plan): the
 * roadmap's flags name them (SimpleFlag.moves) and the change engine moves them (./simple-changes.ts).
 */
export function shiftPlan(items: Map<string, Item>, itemId: string, depId: string): Record<string, [string, string]> {
  // #9: every direct dependent of `dep` that starts too early moves, not only the one whose
  // callout was clicked (two items can share a dependency, each estimated or slice-dated);
  // then the move walks forward transitively through each moved item's own dependents.
  const dep = items.get(depId);
  const moves: Record<string, [string, string]> = {};
  const queue: string[] = [];
  if (!dep) return moves;
  for (const n of dep.needed_by) {
    const next = items.get(n);
    if (!next || next.status === "cut" || next.start.date > dep.end.date) continue;
    // A sibling whose order on dep was accepted as a risk stays where it is (as the API).
    if (n !== itemId && next.flags.some((f) => f.kind === "dependency_order" && f.state === "amber" && f.subject === depId)) continue;
    const delta = days(next.start.date, addDays(dep.end.date, 1));
    moves[n] = [addDays(next.start.date, delta), addDays(next.end.date, delta)];
    queue.push(n);
  }
  while (queue.length) {
    const cur = queue.shift()!;
    for (const n of items.get(cur)!.needed_by) {
      const next = items.get(n);
      if (!next || moves[n] || next.status === "cut") continue;
      if (next.start.date <= moves[cur][1]) {
        const delta = days(next.start.date, addDays(moves[cur][1], 1));
        moves[n] = [addDays(next.start.date, delta), addDays(next.end.date, delta)];
        queue.push(n);
      }
    }
  }
  return moves;
}

/** S4: the item's owner, by name (service: an enabled track owner), from the people /v1/people lists. */
function ownerOf(db: SimpleDb, s: SeedItem, names?: Record<string, string>): Item["owner"] {
  const id = itemOwnerId(db, s.key);
  return id ? { id, name: names?.[id] ?? db.people?.[id] ?? "Track owner" } : null;
}

/** A chat card's set_owner / set_decider (the targets kept by item id), if any: the item's own owner or decider. */
export const namedOn = (db: SimpleDb, key: string, field: "owner_id" | "decider_id"): string | null | undefined => {
  const t = db.targets?.[db.ids[key]];
  return t && field in t ? ((t[field] as string | null) ?? null) : undefined;
};

/** The owners of a PRD's tracks (the API's one_pager.who track_owners): the tracks of the items its roadmap holds. */
export function prdTrackOwnerIds(db: SimpleDb, prdSlug: string): string[] {
  const tracks = new Set(db.items.filter((s) => ROADMAPS[s.roadmap]?.prd.toLowerCase().replace(/ /g, "-") === prdSlug).flatMap((s) => (s.track ? [s.track] : [])));
  return [...tracks].flatMap((t) => (db.track_owners?.[t] ? [db.track_owners[t]] : []));
}

/** The item's owner: the one a chat card named, else its track's owner. */
export function itemOwnerId(db: SimpleDb, key: string): string | null {
  const named = namedOn(db, key, "owner_id");
  if (named !== undefined) return named;
  const track = db.items.find((x) => x.key === key)?.track;
  return (track ? db.track_owners?.[track] : undefined) ?? null;
}

/** The item's own decider (a chat card's set_decider), else the first of deciderIds. */
export function itemDeciderId(db: SimpleDb, key: string, roles?: Record<string, Role>): string | null {
  const named = namedOn(db, key, "decider_id");
  if (named !== undefined) return named;
  const s = db.items.find((x) => x.key === key);
  return s ? (deciderIds(db, s, roles)[0] ?? null) : null;
}

const RANK: Record<Role, number> = { viewer: 0, commenter: 1, approver: 2, owner: 3 };

/** service.decider_ids (D-a): the roadmap's decider, else the item's track owner when an
 * approver or owner; [] when the company's owners decide. The default seed names none;
 * the "simple-deciders" scenario (seedSimpleDeciders) names both. */
export function deciderIds(db: SimpleDb, s: SeedItem, roles?: Record<string, Role>): string[] {
  const named = namedOn(db, s.key, "decider_id");
  if (named) return [named];
  const decider = db.deciders?.[s.roadmap];
  if (decider) return [decider];
  const owner = s.track ? db.track_owners?.[s.track] : undefined;
  return owner && RANK[roles?.[owner] ?? "viewer"] >= RANK.approver ? [owner] : [];
}

/** service.can_decide (D-a): an owner; the decider; with none, the item's track owner while an approver or owner. */
export function canDecideItem(db: SimpleDb, s: SeedItem, me: { id: string; role: Role }): boolean {
  if (me.role === "owner") return true;
  const named = namedOn(db, s.key, "decider_id");
  if (named) return named === me.id;
  const decider = db.deciders?.[s.roadmap];
  if (decider) return decider === me.id;
  return !!s.track && db.track_owners?.[s.track] === me.id && RANK[me.role] >= RANK.approver;
}

/** drafts.can_edit: who changes (submits, approves) a roadmap directly. */
export function canEditRoadmap(db: SimpleDb, roadmap: string, me: { id: string; role: Role }): boolean {
  if (me.role === "owner") return true;
  const decider = db.deciders?.[roadmap];
  if (decider) return decider === me.id;
  const tracks = new Set(db.items.filter((s) => s.roadmap === roadmap && s.track).map((s) => s.track!));
  return [...tracks].some((t) => db.track_owners?.[t] === me.id) && RANK[me.role] >= RANK.approver;
}

/** simple-replaced-prds (service.load): an item of a replaced PRD is history, read in Detailed only. */
export function ofReplacedPrd(db: SimpleDb, s: SeedItem): boolean {
  const replaced = db.replaced_prds ?? [];
  return !!replaced.length && (replaced.includes(ownPrd(s).id) || replaced.includes(ownPrd(s).slug));
}

/** additions._home: the track and PRD a feature added in Simple is filed under, in place: the
 * roadmap's first track (by when it was made: TRACKS' order) of a current PRD, else its first
 * track under the PRD that replaced it. A track's PRD is its first item's on the roadmap. */
export function fileUnderCurrentPrd(db: SimpleDb, s: SeedItem): void {
  const tracks = Object.keys(TRACKS).flatMap((t) => {
    const first = db.items.find((x) => x.roadmap === s.roadmap && x.track === t);
    return first ? [first] : [];
  });
  if (!tracks.length) return;
  const live = tracks.find((x) => !ofReplacedPrd(db, x));
  if (live) {
    s.track = live.track;
    s.prd_doc = ownPrd(live);
    return;
  }
  s.track = tracks[0].track;
  const own = ownPrd(tracks[0]);
  const to = db.replaced_with?.[own.id] ?? db.replaced_with?.[own.slug];
  if (to) s.prd_doc = to;
}

function visibleItems(db: SimpleDb, role: Role): SeedItem[] {
  const restricted = role === "commenter" || role === "viewer";
  return db.items.filter((s) => !s.trashed && !offLatest(db, s) && (!db.company_roadmap || s.roadmap === db.company_roadmap) && (!restricted || ROADMAPS[s.roadmap].visibility === "company") && !ofReplacedPrd(db, s));
}

/** plan-model (suggestions._planned): the item's dated slices in its PRD's plan; none when the plan does not place it. */
function plannedSlices(db: SimpleDb, s: SeedItem): Schemas["SimpleSlice"][] {
  const code = prdCode(s.section);
  if (!db.plan || !code || ROADMAPS[s.roadmap].prd.toLowerCase().replace(/ /g, "-") !== PLAN_PRD_SLUG) return [];
  return planSlices().filter((x) => x.feature_code === code && x.start_date && x.end_date);
}

/**
 * The item's date suggestion as the roadmap shows it (service.build): its open one; for an
 * item the plan places, one per slice, shown as their span (the earliest start, the latest
 * end) under the first slice's id, which Accept applies whole.
 */
export function itemSuggestion(db: SimpleDb, itemId: string): Suggestion | undefined {
  const open = db.suggestions.filter((x) => x.item_id === itemId && x.status === "open").sort((a, b) => (a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : 0));
  const first = open[0];
  if (!first || first.slice_code == null) return first;
  const start = open.map((x) => x.start_date).reduce((a, b) => (b < a ? b : a));
  const end = open.map((x) => x.end_date).reduce((a, b) => (b > a ? b : a));
  return { ...first, start_date: start, end_date: end };
}

/** oracle.simple.suggestions.regenerate: one open suggestion per undated item (plan-model: per slice of a planned one). */
function regenerate(db: SimpleDb, today: string): number {
  const w = simpleWindows(today);
  const resolved = new Map(db.items.map((s) => [s.key, { s, r: resolve(db, s, w[s.horizon]) }]));
  afterDependencies(resolved);
  const durations = new Map<string, number[]>();
  for (const { s, r } of resolved.values()) {
    if (r.start.estimated || r.end.estimated) continue;
    const k = s.confidence ?? "";
    durations.set(k, [...(durations.get(k) ?? []), span(r.start.date, r.end.date)]);
  }
  let open = 0;
  for (const { s, r } of resolved.values()) {
    const id = db.ids[s.key];
    const current = db.suggestions.find((x) => x.item_id === id && x.status === "open");
    const undated = r.start.estimated && r.end.estimated && !closed(s) && s.status !== "done" && !s.drafting_until;
    if (!undated || db.suggestions.some((x) => x.item_id === id && x.status === "dismissed")) {
      db.suggestions = db.suggestions.filter((x) => !(x.item_id === id && x.status === "open"));
      continue;
    }
    // plan-model: an item the plan places gets one suggestion per dated slice, inside its milestone.
    const planned = plannedSlices(db, s);
    if (planned.length) {
      const codes = new Set(planned.map((x) => x.code));
      db.suggestions = db.suggestions.filter((x) => !(x.item_id === id && x.status === "open" && !codes.has(x.slice_code ?? "")));
      for (const sl of planned) {
        const [start, end] = [sl.start_date!, sl.end_date!];
        const basis = `Placed inside ${sl.milestone} ${sl.milestone_name} by the PRD's order (${word(sl.milestone_start!)} – ${word(sl.milestone_end!)}).`;
        open += 1;
        const mine = db.suggestions.find((x) => x.item_id === id && x.status === "open" && x.slice_code === sl.code);
        if (mine) Object.assign(mine, { start_date: start, end_date: end, basis });
        else
          db.suggestions.push({
            id: stableUuid(`simple-suggestion/${s.key}/${sl.code}/${start}/${end}`),
            item_id: id, item_key: s.key, item_title: s.title, start_date: start, end_date: end, basis,
            status: "open", created_at: new Date(mockNowMs()).toISOString(), decided_by: null, decided_at: null, slice_code: sl.code, can_decide: false,
          });
      }
      continue;
    }
    const window = w[s.horizon];
    let start = window[0];
    let why = `starts with the ${s.horizon[0].toUpperCase()}${s.horizon.slice(1)} window`;
    const deps = (s.depends ?? []).map((k) => resolved.get(k)).filter((x) => x !== undefined);
    const latest = deps.sort((a, b) => (a.r.end.date < b.r.end.date ? 1 : -1))[0];
    if (latest && addDays(latest.r.end.date, 1) > start) {
      start = addDays(latest.r.end.date, 1);
      why = `starts the day after ‘${latest.s.title}’ ends`;
    }
    const same = [...(durations.get(s.confidence ?? "") ?? [])].sort((a, b) => a - b);
    const mid = same.length ? (same.length % 2 ? same[(same.length - 1) / 2] : Math.floor((same[same.length / 2 - 1] + same[same.length / 2]) / 2 + 0.5)) : 28;
    const conf = s.confidence ? `${s.confidence}-confidence` : "unrated";
    // finding 30: plain words, not statistics jargon ("median").
    const how = same.length ? `${mid} days, about the same as ${same.length} similar ${conf} item${same.length === 1 ? "" : "s"}` : `${mid} days, typical with no dated ${conf} items yet`;
    let end = addDays(start, mid - 1);
    let tail = "";
    if (start <= window[1] && window[1] < end) {
      end = window[1];
      tail = `, cut at the window's end (${word(window[1])})`;
    }
    const basis = `It ${why} (${word(start)}) and runs ${how}${tail}.`;
    open += 1;
    if (current) Object.assign(current, { start_date: start, end_date: end, basis });
    else
      db.suggestions.push({
        id: stableUuid(`simple-suggestion/${s.key}/${start}/${end}`),
        item_id: id, item_key: s.key, item_title: s.title, start_date: start, end_date: end, basis,
        status: "open", created_at: new Date(mockNowMs()).toISOString(), decided_by: null, decided_at: null, can_decide: false,
      });
  }
  return open;
}

const OPEN_DRAFT = ["working", "submitted"];

/** drafts.ensure: the roadmap's new working draft, opened on its published items (`except`:
 * keys left out of them, read by no one outside the draft). */
export function openDraft(db: SimpleDb, rm: string, by: string, except: string[] = []): MockDraft {
  const items = db.items.filter((x) => x.roadmap === rm && !except.includes(x.key));
  const keys = new Set(items.map((x) => x.key));
  const d: MockDraft = {
    roadmap: rm,
    published: structuredClone({ items, own: Object.fromEntries(Object.entries(db.own).filter(([k]) => keys.has(k))), key_dates: db.key_dates?.[rm] ?? [] }),
    out: {
      id: crypto.randomUUID(), document: { id: stableUuid(`simple-doc/${rm}`), slug: rm, title: rm.replace(/-/g, " ").replace(/^./, (x) => x.toUpperCase()) },
      status: "working", base_version: 1, version: null, created_by: by, created_at: new Date(mockNowMs()).toISOString(), participant_ids: [by],
      submitted_at: null, submitted_by: null, decider_approved: false, waiting_on: [], approved_at: null, blocked_by: [], decision_notes: [],
    },
  };
  (db.drafts ??= []).push(d);
  return d;
}

/**
 * trash_items._reopened: a feature only ever in a Simple draft whose draft was approved while it
 * was in Trash (its version made without it) goes to the roadmap's open draft, the working one
 * (opened, without it, when there is none) or the one in review; the change that added it counts
 * there, so the draft is sent with it. Never onto the published roadmap.
 */
export function reopenDraftOnly(db: SimpleDb, key: string, roadmap: string, by: string): void {
  const id = db.ids[key];
  const added = (db.changes ?? []).find((c) => c.op === "add_item" && c.target.item_id === id && ["applied", "accepted"].includes(c.status));
  const own = (db.drafts ?? []).filter((d) => (added?.draft_ids ?? []).includes(d.out.id));
  if (!added || !own.length || own.some((d) => OPEN_DRAFT.includes(d.out.status))) return;
  const made = own.map((d) => (db.versions ?? []).find((v) => v.roadmap === roadmap && v.number === d.out.version));
  if (made.some((v) => !v?.without.includes(key))) return;
  const open = (db.drafts ?? []).filter((d) => d.roadmap === roadmap && OPEN_DRAFT.includes(d.out.status));
  const d = open.find((x) => x.out.status === "working") ?? open[0] ?? openDraft(db, roadmap, by, [key]);
  added.draft_ids = [...(added.draft_ids ?? []), d.out.id];
}

/** A draft's applied changes, not undone. */
export function draftChanges(db: SimpleDb, id: string): number {
  const cs = db.changes ?? [];
  return cs.filter((c) => ["applied", "accepted"].includes(c.status) && (c.draft_ids ?? []).includes(id) && !cs.some((u) => u.undoes_id === c.id)).length;
}

/** Who sees a draft in the mock: owners, its people, the roadmap's decider and its required reviewers. */
export function seesDraft(d: MockDraft, me: { id: string; role: Role }, db?: SimpleDb): boolean {
  // drafts.sees: whoever it waits on and its roadmap's required reviewers read it too.
  return me.role === "owner" || d.out.created_by === me.id || d.out.participant_ids.includes(me.id) || db?.deciders?.[d.roadmap] === me.id || (d.out.waiting_on ?? []).includes(me.id) || (db?.reviewers?.[d.roadmap] ?? []).includes(me.id);
}

/** The roadmap as one reader reads it: hidden drafts' roadmaps at their published items. */
function readerView(db: SimpleDb, me: { id: string; role: Role }): { db: SimpleDb; hidden: number; visible: Schemas["SimpleDraftBrief"][]; hiddenBy: Record<string, number> } {
  const hiddenBy: Record<string, number> = {};
  let items = db.items;
  let own = db.own;
  let keyDates = db.key_dates ?? {};
  let hidden = 0;
  const visible: Schemas["SimpleDraftBrief"][] = [];
  for (const d of (db.drafts ?? []).filter((x) => OPEN_DRAFT.includes(x.out.status))) {
    if (seesDraft(d, me, db)) {
      visible.push({ id: d.out.id, document_id: d.out.document.id, status: d.out.status, changes: draftChanges(db, d.out.id) });
      continue;
    }
    hidden += draftChanges(db, d.out.id);
    hiddenBy[d.out.document.id] = (hiddenBy[d.out.document.id] ?? 0) + draftChanges(db, d.out.id);
    const keys = new Set(items.filter((s) => s.roadmap === d.roadmap).map((s) => s.key));
    items = [...items.filter((s) => s.roadmap !== d.roadmap), ...d.published.items];
    keyDates = { ...keyDates, [d.roadmap]: d.published.key_dates ?? [] };
    own = { ...Object.fromEntries(Object.entries(own).filter(([k]) => !keys.has(k))), ...d.published.own };
  }
  const shownDocs = new Set(visible.map((v) => v.document_id));
  const proposed = (db.changes ?? []).filter((c) => c.status === "proposed" && me.role !== "owner" && c.document_id && !shownDocs.has(c.document_id));
  hidden += proposed.length;
  for (const c of proposed) hiddenBy[c.document_id!] = (hiddenBy[c.document_id!] ?? 0) + 1;
  return { db: { ...db, items, own, key_dates: keyDates }, hidden, visible, hiddenBy };
}

/** fix4 qa-simple-roadmap-9: the items one reader reads (the API's drafts.overlays_for): a
 * change's stale check and a fix's plan read them, so a commenter acts on what they see. */
export function readerDb(db: SimpleDb, me: { id: string; role: Role }): SimpleDb {
  return readerView(db, me).db;
}

export function roadmapOut(db: SimpleDb, role: Role, q: URLSearchParams, me?: Who): Schemas["SimpleRoadmapOut"] | null {
  knowTalkGoals(db);
  knowExtraRoadmaps(db);
  foldPrdCopies(db);
  const decides = (s: SeedItem) => canDecideItem(db, s, me ?? { id: "", role });
  const deciders = (s: SeedItem) => {
    const ids = deciderIds(db, s, me?.roles);
    return (ids.length ? ids : (me?.owners ?? [])).map((id) => me?.names?.[id]).filter((n): n is string => !!n);
  };
  const reader = { ...(me ? readerView(db, me) : { db, hidden: 0, visible: [], hiddenBy: {} as Record<string, number> }), full: db };
  db = reader.db;
  const today = companyToday();
  const w = simpleWindows(today);
  const group = (q.get("group") ?? "goal") as Schemas["SimpleRoadmapOut"]["group"];
  if (!["goal", "track", "prd"].includes(group)) return null;
  const seeds = visibleItems(db, role);
  const all = new Map(seeds.map((s) => [s.key, { s, r: resolve(db, s, w[s.horizon]) }]));
  afterDependencies(all);
  // The plan-model lane: the plan PRD's items whose code is a plan feature carry its slices.
  const slices = db.plan ? planSlices() : [];
  const slicesOf = (s: SeedItem, prdSlug: string) => {
    const code = prdCode(s.section);
    return code && (prdSlug === PLAN_PRD_SLUG || db.plan?.prds?.includes(prdSlug)) ? slices.filter((x) => x.feature_code === code) : [];
  };
  // trash-features-goals: a goal in Trash is left out of every item's goal (service.load's goal_ids).
  const inTrash = (k: string) => goalInTrash(reader.full, k);
  // roadmap-edit-fixes: a dependency names an item by its key, else by its code or feature key.
  const depOf = (k: string) => (all.has(k) ? k : dependencyOf(seeds, k)?.key);
  const items: Item[] = seeds.map((s) => {
    const r = all.get(s.key)!.r;
    const [code, title] = codedTitle(s.title, prdCode(s.section));
    const rm = ROADMAPS[s.roadmap];
    const sliced = slicesOf(s, rm.prd.toLowerCase().replace(/ /g, "-"));
    const suggestion = itemSuggestion(db, db.ids[s.key]);
    return {
      id: db.ids[s.key], key: s.key, title, outcome: s.outcome ?? null, note: s.note ?? null, horizon: s.horizon,
      estimate_pending: !!s.estimate_pending,
      // Its feature's code (F-12), else its own (codedTitle: the title's, else its PRD section's), as service.load's Entry.code.
      code: (s.feature_id && db.feature_codes?.[s.feature_id]) || code,
      roadmap: { id: stableUuid(`simple-doc/${s.roadmap}`), slug: ROADMAP_DOC_SLUG[s.roadmap] ?? s.roadmap, title: rm.title },
      prd: ownPrd(s),
      goal: s.goal && !inTrash(s.goal) ? { id: stableUuid(`simple-goal/${s.goal}`), key: s.goal, ...roadmapGoal(reader.full, s.goal), position: goalPositionOf(s.goal), ...READINGS[s.goal] } : null,
      track: s.track ? { id: stableUuid(`simple-track/${s.track}`), title: TRACKS[s.track] } : null,
      confidence: s.confidence ?? null,
      status: s.merged_into ? "merged" : s.status === "cut" ? "cut" : s.draft ? "draft" : (s.status ?? "planned"),
      draft: !!s.draft,
      start: r.start, end: r.end,
      // approved-roadmap-to-simple: the applied version's words, until a person changes the dates.
      date_basis: s.basis && s.dates && !db.own[s.key] ? s.basis : null,
      source: r.end.estimated ? r.start.source : r.end.source,
      estimated: r.start.estimated && r.end.estimated,
      suggestion: suggestion ? { ...suggestion, can_decide: decides(s) } : null,
      // service._milestone: its own dated milestone (set_milestone writes it, as typed in its
      // panel; null: cleared), else the track's record, else its own undated one.
      milestone: s.milestone?.day != null
        ? { name: s.milestone.name, date: addDays(w[s.horizon][0], s.milestone.day), source: "item", ...recordOf(s) }
        : s.milestone && !s.record
          ? { name: s.milestone.name, date: null, source: "item" }
          : s.record ? { name: s.record, date: null, source: "track", ...recordOf(s) } : null,
      phases: phases(r.start.date, r.end.date, s, w[s.horizon]),
      slices: sliced,
      milestones: [...new Set(sliced.map((x) => x.milestone))],
      depends_on: [...new Set((s.depends ?? []).map(depOf).filter((k): k is string => !!k && k !== s.key))].map((k) => db.ids[k]),
      needed_by: seeds.filter((x) => x.key !== s.key && (x.depends ?? []).some((k) => depOf(k) === s.key)).map((x) => db.ids[x.key]),
      flags: flagsOf(s, r, all, w[s.horizon]),
      owner: ownerOf(db, s, me?.names),
      // one-feature-panel: the item's own owner (set_owner's before) and its stored dependency keys.
      own_owner_id: namedOn(db, s.key, "owner_id") ?? null,
      depends_keys: s.depends ?? [],
      depends_key_of: Object.fromEntries((s.depends ?? []).flatMap((k) => { const d = depOf(k); return d && d !== s.key ? [[db.ids[d], k]] : []; }).reverse()),
      depends_keys_of: (s.depends ?? []).reduce<Record<string, string[]>>((o, k) => { const d = depOf(k); if (d && d !== s.key) (o[db.ids[d]] ??= []).push(k); return o; }, {}),
      suggested_depends: (s.suggested_depends ?? []).filter((k) => !(s.depends ?? []).includes(k) && !loopOf(seeds, s.key, [k])),
      can_decide: decides(s),
      deciders: deciders(s),
      reasons: [
        ...(s.notes ?? []),
        ...(s.why ? [s.why] : []),
        ...(s.goal ? [`Serves the goal ${GOALS[s.goal]}.`] : []),
        ...(s.section ? [`From ${rm.prd}: ${sectionLabel(s.section, s.heading, s.title).replace(/^[A-Z][A-Z0-9]*-\d+[a-z]?\s+/, "")}.`] : []),
      ].slice(0, 3),
      open_decisions: (db.decisions?.[s.key] ?? []).map((d) => ({ id: stableUuid(`simple-decision/${d.number}`), number: d.number, title: d.title })),
      looks_like: s.draft && !s.kept_both && !closed(s) ? matchesOf(db, s.looks_like ?? []) : [],
      merged_into: s.merged_into ? { id: db.ids[s.merged_into], code: s.merged_into, title: db.items.find((x) => x.key === s.merged_into)?.title ?? s.merged_into } : null,
      drafting: !!s.drafting_until,
      flow: s.draft ? (s.flow ?? null) : (flowFor(db.visuals, "feature", db.ids[s.key]) ?? betFlow(db, s)),
      goal_ids: goalIdsOf(s),
      // S8: the decided decisions that changed the item (./simple-meetings.ts records them).
      decided_in: [...(db.decided_in?.[db.ids[s.key]] ?? [])],
      // walkc-roadmap-tasks: the work under the item (service._tasks).
      tasks: itemTasks(db, db.ids[s.key]),
    };
  });
  // qa-simple-home-1: what "Move the dependents" moves, as the change engine moves it (service.read).
  const byItem = new Map(items.map((i) => [i.id, i]));
  for (const i of items)
    for (const f of i.flags) if (f.kind === "dependency_order" && f.fixes.includes("shift_dependents") && f.subject) f.moves = Object.keys(shiftPlan(byItem, i.id, f.subject));
  // roadmap-decide review (service.load): a cut item's live dependents, read before any filter.
  for (const i of items)
    for (const f of i.flags)
      if (f.kind === "cut_with_dependents")
        f.dependents = i.needed_by
          .map((id) => byItem.get(id))
          .filter((n): n is Item => !!n && n.status !== "cut" && n.status !== "done")
          .map((n) => ({ id: n.id, title: n.title, can_decide: n.can_decide }));
  // The Roadmap filter (service.build's ``roadmap``): one readable roadmap, by id or slug.
  const readable = ROADMAP_SLUGS().filter((r) => readsRoadmap(r, role));
  const chosen = readableRoadmap(q.get("roadmap"), role);
  const prd = q.get("prd");
  const goal = q.get("goal");
  const track = q.get("track");
  const from = q.get("from");
  const to = q.get("to");
  const onDraft = new Set(db.items.filter((s) => s.draft_roadmap).map((s) => db.ids[s.key]));
  const shown = items.filter(
    (i) =>
      (q.get("draft_roadmap") === "1" || !onDraft.has(i.id)) &&
      (!q.get("roadmap") || i.roadmap.slug === (ROADMAP_DOC_SLUG[chosen ?? ""] ?? chosen)) &&
      (!prd || i.prd?.slug === prd || i.prd?.id === prd) &&
      (!goal || i.goal?.key === goal || i.goal?.id === goal) &&
      (!track || i.track?.id === track) &&
      (!from || i.end.date >= from) &&
      (!to || i.start.date <= to),
  );
  const groups = new Map<string, { title: string; sort: string; item_ids: string[] }>();
  const prdRank = prdRanker();
  for (const i of shown) {
    const ref = group === "goal" ? i.goal : group === "track" ? i.track : i.prd;
    const none = { goal: "No goal", track: "No track", prd: "No PRD" }[group];
    const key = ref?.id ?? "none";
    // goal-order: goal groups in the one goal order (then by key); prd-order: PRD groups in the company PRD order; No goal last.
    const sort = !ref
      ? "1"
      : "key" in ref
        ? `0${String(goalRank(String(ref.key))).padStart(16, "0")}${ref.key}`
        : group === "prd"
          ? `0${String(prdRank(ref)).padStart(16, "0")}${ref.title}`
          : `0${ref.title}`;
    const g = groups.get(key) ?? { title: ref?.title ?? none, sort, item_ids: [] };
    g.item_ids.push(i.id);
    groups.set(key, g);
  }
  return {
    today, group,
    windows: { now: { start: w.now[0], end: w.now[1] }, next: { start: w.next[0], end: w.next[1] }, later: { start: w.later[0], end: w.later[1] } },
    groups: [...groups.entries()].sort((a, b) => (a[1].sort < b[1].sort ? -1 : 1)).map(([key, g]) => ({ key, title: g.title, item_ids: g.item_ids })),
    items: shown,
    milestones: [
      // The digest's Beta (a new company has no digest, so no Beta).
      ...(db.ids["alert-digest"]
        ? [{ id: stableUuid("simple-milestone/beta"), track_id: stableUuid("simple-track/alerts"), name: "Beta", date: addDays(w.now[0], 60), horizon: "now" as const, status: "planned" as const, item_ids: [db.ids["alert-digest"]], ...UNDATED }]
        : []),
      ...[...new Set(seeds.flatMap((s) => (s.record ? [s.record] : [])))].map((name) => {
        const of = seeds.filter((s) => s.record === name);
        return { id: recordOf(of[0]).record_id!, track_id: stableUuid(`simple-track/${of[0].track}`), name, date: db.record_dates?.[name] ?? null, horizon: "now" as const, status: "planned" as const, item_ids: of.map((s) => db.ids[s.key]), ...UNDATED };
      }),
      // approved-roadmap-to-simple: each shown roadmap's applied version's milestones.
      ...(chosen ? [chosen] : readable).flatMap((slug) => appliedMilestones(db, slug)),
      // The plan's dated milestones (M1-M3), each naming the items with a slice in it.
      // roadmap-gantt: each planned PRD's own records ("simple-plan-two": two PRDs, M1-M3 each).
      // simple-replaced-prds (service._milestone_out): a replaced PRD's items are not read, so its
      // track has no PRD and its milestones keep their target day and counts only, no plan.
      ...(db.plan ? [PLAN_PRD_SLUG, ...(db.plan.prds ?? [])] : []).flatMap((slug) => {
        const inPlay = items.some((i) => i.prd?.slug === slug);
        return planMilestones().map((m) => ({
          id: stableUuid(slug === PLAN_PRD_SLUG ? `simple-plan-milestone/${m.code}` : `simple-plan-milestone/${slug}/${m.code}`),
          track_id: stableUuid(`simple-track/${slug === PLAN_PRD_SLUG ? "onboarding" : (seeds.find((s) => ROADMAPS[s.roadmap].prd.toLowerCase().replace(/ /g, "-") === slug)?.track ?? "onboarding")}`),
          name: `${m.code} · ${m.name}`, date: m.end_date,
          horizon: (m.end_date <= w.now[1] ? "now" : m.end_date <= w.next[1] ? "next" : "later") as Horizon, status: "planned" as const,
          item_ids: items.filter((i) => i.prd?.slug === slug && i.milestones.includes(m.code)).map((i) => i.id),
          ...(inPlay ? { start_date: m.start_date, end_date: m.end_date, effort_weeks: m.effort_weeks, done_when: m.done_when, targets: m.targets } : UNDATED),
        }));
      }),
    ],
    // build-milestones-on-roadmap: the shown roadmaps' milestones per goal (a PRD's among them);
    // while the company roadmap exists, its own alone (older roadmaps are history, company.feeding_ids).
    goal_milestones: (db.goal_milestones ?? []).filter((m) => !m.deleted && (!db.company_roadmap || m.roadmap === db.company_roadmap) && (chosen ? m.roadmap === chosen : readable.includes(m.roadmap))).map((x) => milestoneOut(x, db.ids, x.prd ? role !== "viewer" : role !== "viewer" && role !== "commenter" && (!me || canEditRoadmap(db, x.roadmap, me)), role !== "viewer", me && { role: me.role, name: me.names?.[me.id] }, (slug) => roadmapTitle(db, slug))),
    old_milestones: oldMilestonesOut(db.goal_milestones ?? [], role, oldCtx(db)),
    // service.build: the span of the shown items' PRDs' plans only (a replaced plan PRD's goes with its items).
    span: db.plan && shown.some((i) => !!i.prd && (i.prd.slug === PLAN_PRD_SLUG || !!db.plan?.prds?.includes(i.prd.slug))) ? planSpan() : null,
    // A working draft belongs to one roadmap: a chosen roadmap's read carries its own only.
    changes_in_review: chosen ? (reader.hiddenBy[roadmapId(chosen)] ?? 0) : reader.hidden,
    drafts: chosen ? reader.visible.filter((d) => d.document_id === roadmapId(chosen)) : reader.visible,
    // One roadmap chosen: its key dates; all roadmaps: every readable one's (oracle.simple.service).
    ...keyDatesOut(db, reader.full, chosen ? [chosen] : readable, me ?? { id: "", role }),
    roadmaps: keyDatesOut(db, reader.full, readable, me ?? { id: "", role }).key_date_roadmaps,
    roadmap: chosen ? { id: roadmapId(chosen), slug: chosen, title: roadmapTitle(db, chosen) } : null,
    // decisions-reversed-or-trashed: the items' decisions left out as no longer standing.
    left_out: leftOut(),
    applied_versions: (chosen ? [chosen] : readable).flatMap((slug) => {
      const a = appliedVersionOut(db, slug, role, all);
      return a ? [a] : [];
    }),
  };
}

/** "Dec 2" (Simple's dates in a difference line). */
const dayWord = (d: string | null): string => (d ? word(d) : "no date");

/**
 * approved-roadmap-to-simple: the line for a roadmap whose shown version was applied: whether
 * its items still read what that version says, else each difference in plain words.
 */
function appliedVersionOut(db: SimpleDb, slug: string, role: Role, all: Map<string, { s: SeedItem; r: { start: Dated; end: Dated } }>): Schemas["SimpleAppliedVersion"] | null {
  const a = db.applied?.[slug];
  if (!a) return null;
  const n = a.version;
  const differences: string[] = [];
  // As the API's oracle.simple.approved_roadmap.lines: the shown items in order; one the
  // version did not list was added after it, a listed one cut since was cut after it.
  const listed = new Map(a.plan.map((row) => [row.key, row]));
  for (const x of all.values()) {
    if (x.s.roadmap !== slug) continue;
    const row = listed.get(x.s.key);
    if (!row) {
      differences.push(`${x.s.title} was added after version ${n}`);
      continue;
    }
    if (x.s.status === "cut") {
      differences.push(`${x.s.title} was cut after version ${n}`);
      continue;
    }
    if (!row.start && !row.end) continue;
    const [start, end] = [x.r.start.date, x.r.end.date];
    const startDiffers = !!row.start && row.start !== start;
    const endDiffers = row.end !== end;
    if (startDiffers && endDiffers) differences.push(`${x.s.title} runs ${dayWord(start)} to ${dayWord(end)}, version ${n} says ${dayWord(row.start)} to ${dayWord(row.end)}`);
    else if (endDiffers) differences.push(`${x.s.title} ends ${dayWord(end)}, version ${n} says ${dayWord(row.end)}`);
    else if (startDiffers) differences.push(`${x.s.title} starts ${dayWord(start)}, version ${n} says ${dayWord(row.start)}`);
  }
  return {
    roadmap: { id: roadmapId(slug), slug, title: roadmapTitle(db, slug) },
    version: n, approved_at: a.approved_at, href: a.href,
    matches: differences.length === 0, differences,
    shipped: [...a.shipped], moved_out: [...a.moved_out],
    can_apply: RANK[role] >= RANK.approver,
  };
}

/** The applied-version line of one roadmap, as GET /v1/simple/roadmap?roadmap= reads it. */
export function appliedVersionOf(db: SimpleDb, slug: string, me: Who): Schemas["SimpleAppliedVersion"] | null {
  const out = roadmapOut(db, me.role, new URLSearchParams({ roadmap: slug }), me);
  return out?.applied_versions?.find((x) => x.roadmap.slug === slug) ?? null;
}

const roadmapTitle = (db: SimpleDb, slug: string): string => db.titles?.[slug] ?? ROADMAPS[slug].title;

/** old-milestones: the company roadmap and its items, for the older roadmaps' milestones (./simple-milestones.ts). */
const oldCtx = (db: SimpleDb): OldCtx => ({
  company: db.company_roadmap,
  companyItems: new Map(db.items.filter((s) => s.roadmap === db.company_roadmap).map((s) => [s.key, s.title])),
  feedingPrds: new Set(db.items.filter((s) => s.roadmap === db.company_roadmap).flatMap((s) => (s.prd_doc ? [s.prd_doc.slug] : []))),
  // The mock's items carry no feature of their own: the same item key is the same feature.
  companyKey: (_roadmap, key) => db.items.find((s) => s.roadmap === db.company_roadmap && s.key === key)?.key,
  roadmapTitle: (slug) => roadmapTitle(db, slug),
  goalTitle: (key) => GOALS[key] ?? null,
});

/** Roadmap-plus: the shown roadmaps' key dates (the draft's to who sees it) and who may change them. */
function keyDatesOut(db: SimpleDb, full: SimpleDb, shown: string[], me: { id: string; role: Role }): Pick<Schemas["SimpleRoadmapOut"], "key_dates" | "key_date_roadmaps"> {
  const slugs = [...shown].sort((a, b) => roadmapTitle(db, a).localeCompare(roadmapTitle(db, b)));
  const ref = (slug: string) => ({ id: stableUuid(`simple-doc/${slug}`), slug, title: roadmapTitle(db, slug) });
  const draftOf = (slug: string) => (full.drafts ?? []).find((d) => d.roadmap === slug && OPEN_DRAFT.includes(d.out.status));
  const keyDates = slugs
    .flatMap((slug) => {
      const pub = draftOf(slug)?.published.key_dates ?? null;
      const fromPrds = prdKeyDates(db, slug, ref(slug));
      // ah-prd-milestones-once review (key_dates.published_copies): a copy of a PRD's milestone the
      // roadmap published before they were read-only from the PRD (its name, "From <PRD>") is skipped.
      const copies = new Set(fromPrds.map((k) => `${k.id}/${k.name.replace(/^\S+ · /, "")}/From ${k.prd!.title}`));
      const own = (db.key_dates?.[slug] ?? []).filter((k) => !copies.has(`${k.id}/${k.name}/${k.note}`)).map((k) => {
        const was = pub?.find((x) => x.id === k.id);
        const inDraft = pub !== null && (!was || JSON.stringify(was) !== JSON.stringify(k));
        return { id: k.id, roadmap: ref(slug), name: k.name, date: k.date, note: k.note, in_draft: inDraft, prd: null };
      });
      return [...own, ...fromPrds];
    })
    .sort((a, b) => (a.date === b.date ? a.name.localeCompare(b.name) : a.date < b.date ? -1 : 1));
  const may = me.role !== "viewer";
  return { key_dates: keyDates, key_date_roadmaps: slugs.map((slug) => ({ roadmap: ref(slug), applies: may && canEditRoadmap(full, slug, me), can_change: may })) };
}

/**
 * roadmap-keydates (the owner, Nov 1: "Read-only from the PRD"): each dated milestone of the
 * PRDs on the roadmap (key_dates.prd_key_dates), "M1 · Prove it" on its end day, its PRD
 * named: no row of the roadmap's, so never edited here; it moves when the PRD does.
 */
function prdKeyDates(db: SimpleDb, slug: string, roadmap: Schemas["SimpleDocRef"]): Schemas["SimpleKeyDate"][] {
  const hidden = new Set(db.plan?.hidden ?? []);
  // roadmap-keydates review: every PRD the roadmap's items come from, each item's own (an item
  // added from another approved PRD names that one), as the API's key_date_prds reads them.
  // simple-replaced-prds: never a replaced PRD's (service.load drops its items, as visibleItems).
  const prds = [...new Map(db.items.filter((s) => s.roadmap === slug && !s.draft_roadmap && !ofReplacedPrd(db, s)).map((s) => [ownPrd(s).id, ownPrd(s)])).values()];
  return prds
    .filter((p) => !hidden.has(p.slug))
    // prd-order (as key_date_prds): the roadmap's PRDs in the company PRD order.
    .sort(byPrdRank(prdRanker()))
    .flatMap((prd) =>
      (db.prd_milestones?.[prd.slug] ?? []).map((m) => ({
        id: stableUuid(`simple-prd-key-date/${slug}/${prd.slug}/${m.code}`),
        roadmap,
        name: m.name ? `${m.code} · ${m.name}` : m.code,
        date: m.date,
        note: null,
        in_draft: false,
        prd,
      })),
    );
}

/** roadmap-keydates: the plan PRDs' dated milestones when no approved version of theirs states any (the "simple-plan" scenarios). */
export function planPrdMilestones(plan: PlanDb | undefined): Record<string, PrdMilestone[]> {
  if (!plan || plan.undated) return {};
  const ms = planMilestones()
    .filter((m, i) => !plan.partly_dated || i === 0)
    .map((m) => ({ code: m.code, name: m.name, date: m.end_date }));
  return Object.fromEntries([PLAN_PRD_SLUG, ...(plan.prds ?? [])].map((slug) => [slug, ms]));
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** S7: the matches a draft keeps (live items, best first, at most 2). */
export function matchesOf(db: SimpleDb, keys: string[]): Schemas["SimpleMatch"][] {
  return keys
    .map((k) => db.items.find((x) => x.key === k))
    .filter((x): x is SeedItem => !!x && !closed(x) && !ofReplacedPrd(db, x))
    .slice(0, 2)
    // Its display code (F-06) or none, never its key, as additions.reconcile.
    .map((x) => ({ kind: "item" as const, id: db.ids[x.key], code: prdCode(x.section) ?? "", title: x.title }));
}

const WORDS = (t: string): Set<string> => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4));

/** S7, Oracle's duplicate check (simplified): live items of the roadmap sharing a word of four
 * letters or more with the title, most shared first; never a replaced PRD's (additions.reconcile
 * reads service.load). */
export function lookalikes(db: SimpleDb, title: string, roadmap: string | null, except?: string): string[] {
  const mine = WORDS(title);
  return db.items
    .filter((x) => x.key !== except && !closed(x) && !x.draft && (!roadmap || x.roadmap === roadmap) && !ofReplacedPrd(db, x))
    .map((x) => ({ k: x.key, n: [...WORDS(x.title)].filter((w) => mine.has(w)).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.k.localeCompare(b.k))
    .slice(0, 2)
    .map((x) => x.k);
}

/** S7: Oracle's drafting job, done once the mock clock passes its time: the draft gets an
 * outcome, a flow, a dependency on its goal's first live item and an open date suggestion
 * (in the quarter it was dropped on, else its horizon's window). */
export function settleDrafting(db: SimpleDb): void {
  const now = mockNowMs();
  const w = simpleWindows(iso(now));
  for (const s of db.items) {
    if (!s.drafting_until || s.drafting_until > now) continue;
    delete s.drafting_until;
    // roadmap-edit-fixes: Oracle fills only what a person has not.
    if (s.outcome == null) {
      s.outcome = `Teams get ${s.title.toLowerCase()} without asking support`;
      s.drafted_at = new Date(now).toISOString();
    }
    s.flow = plainFlow({
      title: s.title,
      steps: ["Open the alerts page", `Find ${s.title.toLowerCase()}`, "Set it up in one step", "See it working"],
      screen: { title: `${s.title} settings`, regions: ["Header: what it does", "The one setting", "A preview", "Save and Cancel buttons"] },
    });
    // roadmap-edit-fixes: its dependency ideas are suggestions a person adds, never written.
    const dep = db.items.find((x) => x.key !== s.key && x.goal && x.goal === s.goal && !closed(x) && !x.draft && x.roadmap === s.roadmap);
    if (dep && !(s.depends ?? []).includes(dep.key)) s.suggested_depends = [dep.key];
    const [start, end] = s.quarter ? [s.quarter.start < iso(now) ? iso(now) : s.quarter.start, s.quarter.end] : w[s.horizon];
    const id = db.ids[s.key];
    db.suggestions = db.suggestions.filter((x) => !(x.item_id === id && x.status === "open"));
    db.suggestions.push({
      id: stableUuid(`simple-suggestion/${s.key}/${start}/${end}`),
      item_id: id, item_key: s.key, item_title: s.title, start_date: start, end_date: end,
      basis: s.quarter ? `It falls in the quarter it was added to (${word(start)} – ${word(end)}).` : `It spans the ${s.horizon} window (${word(start)} – ${word(end)}).`,
      status: "open", created_at: new Date(now).toISOString(), decided_by: null, decided_at: null, can_decide: false,
    });
  }
}

/**
 * inbox-meeting-proposals fix (suggestions.inbox_rows): the open date suggestions I may decide,
 * one row per item (its slices' span), newest first. The mock makes suggestions when the
 * roadmap is first read, so the Inbox lists them from then on.
 */
export function dateSuggestionInboxRows(db: SimpleDb | undefined, me: { id: string; role: Role }, seen: string | null): Schemas["InboxSimpleDateSuggestion"][] {
  if (!db) return [];
  const seeds = new Map(visibleItems(db, me.role).map((s) => [db.ids[s.key], s]));
  const out: Schemas["InboxSimpleDateSuggestion"][] = [];
  const done = new Set<string>();
  for (const x of [...db.suggestions].filter((y) => y.status === "open").sort((a, b) => (a.created_at < b.created_at ? 1 : -1))) {
    const s = seeds.get(x.item_id);
    if (done.has(x.item_id) || !s || !canDecideItem(db, s, me)) continue;
    done.add(x.item_id);
    const span = itemSuggestion(db, x.item_id) ?? x;
    out.push({
      id: span.id, item_id: x.item_id, item_title: s.title, document_id: roadmapId(s.roadmap), start_date: span.start_date, end_date: span.end_date,
      basis: span.basis, at: x.created_at, state: !seen || x.created_at > seen ? "new" : "open",
    });
  }
  return out;
}

/** /v1/simple/roadmap and its date suggestions (api/oracle/simple/router.py). */
export async function routeSimpleRoadmap(db: SimpleDb, me: Who, req: Request, p: string[], q: URLSearchParams): Promise<Response | null> {
  if (p[1] !== "simple" || p[2] !== "roadmap") return null;
  const m = req.method;
  const today = companyToday();
  if (!db.suggestions.length && !Object.keys(db.own).length) regenerate(db, today);
  settleDrafting(db);
  if (!p[3] && m === "GET") {
    if (q.get("roadmap") && !readableRoadmap(q.get("roadmap"), me.role)) return json(404, { detail: "No such roadmap" });
    const out = roadmapOut(db, me.role, q, me);
    return out ? json(200, out) : json(422, { detail: "group: goal, track or prd" });
  }
  if (p[3] === "waiting" && !p[4] && m === "GET") {
    // roadmap-decide review (GET /v1/simple/roadmap/waiting): the whole roadmap's broken links and
    // the dates the reader may confirm, no filter but ``roadmap`` (one roadmap's; 404 when unread).
    const one = q.get("roadmap");
    if (one && !readableRoadmap(one, me.role)) return json(404, { detail: "No such roadmap" });
    const items = (roadmapOut(db, me.role, new URLSearchParams(one ? { roadmap: one } : {}), me)?.items ?? []).filter((i) => i.status !== "done");
    const links = items.flatMap((i) => i.flags).filter((f) => f.state === "red" && f.fixes.length > 0 && (f.kind === "dependency_order" || f.kind === "cut_with_dependents"));
    return json(200, { broken_links: links.length, dates_to_confirm: items.filter((i) => !!i.suggestion?.can_decide).length });
  }
  const slugOf = (id: string) => Object.keys(ROADMAPS).find((r) => roadmapId(r) === id) ?? null;
  const ms = await routeMilestones(db, me, req, p, slugOf, (r) => canEditRoadmap(db, r, me), (r) => !!db.company_roadmap && r !== db.company_roadmap, oldCtx(db));
  if (ms) return ms;
  if (p[3] !== "date-suggestions") return null;
  if (!p[4] && m === "GET") {
    const status = q.get("status") ?? "open";
    const seeds = new Map(visibleItems(db, me.role).map((s) => [db.ids[s.key], s]));
    return json(200, db.suggestions.filter((s) => s.status === status && seeds.has(s.item_id)).map((s) => ({ ...s, can_decide: canDecideItem(db, seeds.get(s.item_id)!, me) })));
  }
  if (p[4] === "refresh" && m === "POST") {
    if (me.role !== "owner" && me.role !== "approver") return json(403, { detail: "Requires the approver role" });
    return json(200, { open: regenerate(db, today) });
  }
  // D-b: accept and edit are changes (./simple-changes.ts routes them); dismiss is here.
  if (m !== "POST" || !p[4] || p[5] !== "dismiss") return null;
  const s = db.suggestions.find((x) => x.id === p[4]);
  const item = s && visibleItems(db, me.role).find((x) => db.ids[x.key] === s.item_id);
  if (!s || !item) return json(404, { detail: "No such date suggestion" });
  if (!canDecideItem(db, item, me)) return json(403, { detail: "Only an owner or the roadmap's decider (with no decider, its owner) decides date suggestions" });
  if (s.status !== "open") return json(409, { detail: `This suggestion is ${s.status} already` });
  const at = new Date(mockNowMs()).toISOString();
  // As the API: dismissing a planned item's row dismisses every open slice of the item.
  for (const x of db.suggestions) {
    if (x === s || (s.slice_code != null && x.item_id === s.item_id && x.status === "open" && x.slice_code != null)) Object.assign(x, { status: "dismissed", decided_by: me.id, decided_at: at });
  }
  return json(200, { ...s, can_decide: true });
}

export type { MockDraft, SeedItem, SimpleDb };

/** approved-prd-roadmap: what an approved PRD version brings (oracle.simple.prd_roadmap). */
export interface PrdApproval {
  prd: Schemas["SimpleDocRef"];
  version: number;
  /** The roadmap its derived items name (Simple roadmap slug), when no roadmap holds the PRD. */
  roadmap?: string | null;
  items: {
    key: string;
    title: string;
    horizon: Horizon;
    outcome?: string | null;
    feature_id?: string | null;
    start: string | null;
    end: string | null;
    source: "engineering" | "accepted";
  }[];
}

/**
 * approved-prd-shown-once (hotfix PR 1273): a copy of a shown item (same roadmap and PRD, its key
 * the shown one's with "-2", "-3", ... as the mock re-keys an added item) reads as that item, once,
 * as the API's drafts.fold: the copy's title and dates, its own dates and cut on top. Folded for
 * good, so a change made later on the item always takes effect.
 */
export function foldPrdCopies(db: SimpleDb): void {
  const prdOf = (x: SeedItem) => x.from_prd?.slug ?? ROADMAPS[x.roadmap]?.prd.toLowerCase().replace(/ /g, "-");
  for (const copy of [...db.items]) {
    if (!copy.from_prd) continue;
    const m = /^(.+)-\d+$/.exec(copy.key);
    const shown = m && db.items.find((x) => x !== copy && x.key === m[1] && x.roadmap === copy.roadmap && prdOf(x) === prdOf(copy));
    if (!shown) continue;
    shown.title = copy.title;
    if (copy.dates) shown.dates = copy.dates;
    if (db.own[copy.key]) db.own[shown.key] = db.own[copy.key];
    else if (copy.dates) delete db.own[shown.key];
    if (copy.status === "cut") shown.status = "cut";
    delete db.own[copy.key];
    db.items = db.items.filter((x) => x !== copy);
    for (const d of db.drafts ?? [])
      for (const p of Object.values(d.prds ?? {}))
        p.keys = [...new Set(p.keys.map((k) => (k === copy.key ? shown.key : k)))];
  }
}

/**
 * approved-prd-roadmap: approving a PRD version puts its dated items in its roadmap's working
 * draft, marked as from the PRD (oracle.simple.prd_roadmap.on_prd_approved); no key dates, its
 * milestones are read-only from the PRD (ah-prd-milestones-once).
 * Approving again takes the PRD's earlier additions out first; an item already published only
 * adds what changed; nothing while the roadmap's draft is in review.
 */
export function approvedPrdToDraft(
  db: SimpleDb,
  a: PrdApproval,
  me: string,
): void {
  const rm =
    Object.keys(ROADMAPS).find((k) => ROADMAPS[k].prd === a.prd.title) ??
    (a.roadmap && ROADMAPS[a.roadmap] ? a.roadmap : null);
  if (!rm) return;
  const drafts = (db.drafts ??= []);
  let d = drafts.find((x) => x.roadmap === rm && x.out.status === "working");
  if (!d) {
    if (drafts.some((x) => x.roadmap === rm && x.out.status === "submitted"))
      return;
    const items = db.items.filter((x) => x.roadmap === rm);
    const keys = new Set(items.map((x) => x.key));
    d = {
      roadmap: rm,
      published: structuredClone({
        items,
        own: Object.fromEntries(
          Object.entries(db.own).filter(([k]) => keys.has(k)),
        ),
        key_dates: db.key_dates?.[rm] ?? [],
      }),
      out: {
        id: crypto.randomUUID(),
        document: {
          id: stableUuid(`simple-doc/${rm}`),
          slug: rm,
          title: ROADMAPS[rm].title,
        },
        status: "working",
        base_version: 1,
        version: null,
        created_by: me,
        created_at: new Date(mockNowMs()).toISOString(),
        participant_ids: [me],
        decision_notes: [],
        submitted_at: null,
        submitted_by: null,
        decider_approved: false,
        waiting_on: [],
        approved_at: null,
        blocked_by: [],
      },
    };
    drafts.push(d);
  }
  if (!d.out.participant_ids.includes(me)) d.out.participant_ids.push(me);
  const prds = (d.prds ??= {});
  // The PRD's earlier additions leave the draft: added items go, changed published ones are as published.
  const before = prds[a.prd.slug];
  delete prds[a.prd.slug];
  const kds = [...(db.key_dates?.[rm] ?? [])].filter(
    (k) => !before?.key_dates.includes(k.id),
  );
  if (before) {
    const published = new Map(d.published.items.map((x) => [x.key, x]));
    db.items = db.items.flatMap((x) =>
      x.roadmap === rm && before.keys.includes(x.key)
        ? published.has(x.key)
          ? [structuredClone(published.get(x.key)!)]
          : []
        : [x],
    );
  }
  foldPrdCopies(db);
  const w = simpleWindows(companyToday());
  const keys: string[] = [];
  // approved-prd-shown-once: the PRD's item the roadmap shows already (same key, else same
  // feature, else same title; every key match first, each shown item matched once) is updated,
  // never added again.
  const ours = db.items.filter(
    (x) =>
      x.roadmap === rm &&
      (x.from_prd?.slug ??
        ROADMAPS[rm].prd.toLowerCase().replace(/ /g, "-")) === a.prd.slug,
  );
  const named = (t: string) => t.trim().toLowerCase();
  const matched = new Map<string, SeedItem>();
  for (const same of [
    (it: PrdApproval["items"][number], x: SeedItem) => x.key === it.key,
    (it: PrdApproval["items"][number], x: SeedItem) => !!it.feature_id && x.feature_id === it.feature_id,
    (it: PrdApproval["items"][number], x: SeedItem) =>
      !!named(it.title) && named(x.title) === named(it.title),
  ]) {
    for (const it of a.items) {
      if (!it.end || matched.has(it.key)) continue;
      const taken = new Set(matched.values());
      const x = ours.find((o) => !taken.has(o) && same(it, o));
      if (x) matched.set(it.key, x);
    }
  }
  for (const it of a.items) {
    if (!it.end) continue;
    const start = it.start && it.start <= it.end ? it.start : null;
    const pub = matched.get(it.key);
    if (pub) {
      const r = resolve(db, pub, w[pub.horizon]);
      if (
        r.end.date === it.end &&
        (start ? r.start.date === start : r.start.estimated) &&
        pub.title === it.title
      )
        continue;
      delete db.own[pub.key];
      Object.assign(pub, {
        title: it.title,
        dates: { start, end: it.end, source: it.source },
      });
      keys.push(pub.key);
      continue;
    }
    let key = it.key;
    for (let n = 2; db.items.some((x) => x.key === key); n++)
      key = `${it.key.slice(0, 21)}-${n}`;
    db.ids[key] = stableUuid(`simple-prd-item/${rm}/${a.prd.slug}/${key}`);
    db.items.push({
      key,
      title: it.title,
      horizon: it.horizon,
      roadmap: rm,
      outcome: it.outcome ?? null,
      position:
        Math.max(
          0,
          ...db.items
            .filter((x) => x.roadmap === rm)
            .map((x) => x.position ?? 0),
        ) + 1,
      from_prd: { slug: a.prd.slug, title: a.prd.title },
      dates: { start, end: it.end, source: it.source },
    });
    keys.push(key);
  }
  // ah-prd-milestones-once (the owner's pick: 'Read-only from the PRD'): no key dates; its
  // milestones show read-only from the PRD (prdKeyDates), once each. An earlier copy leaves.
  (db.key_dates ??= {})[rm] = kds;
  if (keys.length)
    prds[a.prd.slug] = {
      prd: a.prd,
      version: a.version,
      keys,
      key_dates: [],
    };
}

/** approved-prd-roadmap: how many items each approved PRD put in the draft; key_dates is always 0
 * (ah-prd-milestones-once: its milestones are read-only from the PRD), as the API's sources_out. */
export function draftPrds(d: MockDraft): Schemas["SimpleDraftPrd"][] {
  const byRank = byPrdRank(prdRanker());
  return Object.values(d.prds ?? {})
    .map((x) => ({
      prd: x.prd,
      version: x.version,
      items: x.keys.length,
      key_dates: 0,
    }))
    .sort((a, b) => byRank(a.prd, b.prd));
}
