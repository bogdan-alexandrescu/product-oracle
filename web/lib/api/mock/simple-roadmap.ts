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
import type { Schemas } from "@/lib/api/client";
import { plainFlow } from "./simple-visuals";
import { mockNowMs } from "./clock";
import { companyDayIso } from "./connections";
import { newCompany, seeded, stableUuid } from "./ids";
import { flowFor, type VisualsDb } from "./simple-visuals";
import { PLAN_PRD_SLUG, planMilestones, planSlices, planSpan, type PlanDb } from "./simple-plan";

type Item = Schemas["SimpleRoadmapItem"];
type Suggestion = Schemas["DateSuggestionOut"];
type Dated = Schemas["SimpleDate"];
type Flag = Schemas["SimpleFlag"];
type Horizon = Item["horizon"];
type Role = Schemas["Me"]["role"];

interface SeedItem {
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
  status?: Item["status"];
  draft?: boolean;
  milestone?: { name: string; day: number };
  /** The track milestone record naming the item (its name), whatever its own text says. */
  record?: string;
  /** The roadmap item's validation gates (days from the window's start); one naming a
   * phase ends that phase on its day (oracle.simple.dates.named_phases). */
  gates?: { phase: string; day: number }[];
  risks?: { flag: Flag["kind"]; note: string; subject?: string | null }[];
  /** Simple S3a's change engine (./simple-changes.ts) edits these. */
  outcome?: string | null;
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
  /** S7: the baseline feature (with no item) this draft was linked to by a merge. */
  // A draft merged with a baseline feature that has no item: linked to it (still a draft).
  linked_feature?: string;
  /** S7: Oracle's drafting job runs until this mock time (ms); the item is "drafting" until then. */
  drafting_until?: number;
  /** S7: a draft quick-added on a quarter: Oracle's date suggestion falls in it. */
  quarter?: { start: string; end: string };
  flow?: Schemas["SimpleFlow"] | null;
  /** S7: notes a merge left on the kept item. */
  notes?: string[];
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
  /** Simple S3b (./simple-changes.ts): working drafts, each with its roadmap's published items. */
  drafts?: MockDraft[];
  /** S3b: non-versioned targets (item tasks, action items, overrides, launch tasks) by id. */
  targets?: Record<string, Record<string, unknown>>;
  /** D-a (#730 review): each roadmap's designated decider (roadmap slug -> person id). */
  deciders?: Record<string, string>;
  /** D-a: each track's owner (track key -> person id); their role (Who.roles) says whether they decide. */
  track_owners?: Record<string, string>;
  /** S4: people's display names (person id -> name), for the items' owners. */
  people?: Record<string, string>;
  /** S4: proposed decisions naming an item (item key -> decisions). */
  decisions?: Record<string, { number: number; title: string }[]>;
  /** Roadmap-plus (api/oracle/simple/key_dates.py): each roadmap's key dates as its working
   * draft has them (roadmap slug -> key dates); a draft keeps the published ones. */
  key_dates?: Record<string, MockKeyDate[]>;
  /** S7 (./simple-suggestions.ts): Oracle's feature suggestions for goals, its suggest jobs
   * (goal key -> when the job is done, mock ms) and the goals suggested for automatically. */
  goal_suggestions?: GoalSuggestionRow[];
  goal_jobs?: Record<string, { until: number; job_id: string; origin: "auto" | "on_demand" }>;
  auto_done?: string[];
  /** S7: the seeds a merge changed, as they were (change id -> seeds), for its undo. */
  snapshots?: Record<string, SeedItem[]>;
  /** S10: the visuals (./simple-visuals.ts), shared with the one-pager's. */
  visuals?: VisualsDb;
  /** S8: decided decisions that changed each item (by item id), newest first. */
  decided_in?: Record<string, { id: string; number: number; title: string }[]>;
  /** The plan-model lane (./simple-plan.ts): Guided setup's plan, in the "simple-plan" scenario. */
  plan?: PlanDb;
}

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
  out: Omit<Schemas["SimpleDraftOut"], "changes" | "can_submit" | "can_resume" | "can_approve" | "change_log" | "can_withdraw">;
  roadmap: string;
  published: { items: SeedItem[]; own: SimpleDb["own"]; key_dates?: MockKeyDate[] };
}

/** `draft`: the number of the PRD draft (version) the roadmap's items were imported from. */
const ROADMAPS: Record<string, { title: string; visibility: "company" | "approvers"; prd: string; draft: number }> = {
  "alerts-roadmap": { title: "Alerts roadmap", visibility: "company", prd: "Usage alerts", draft: 5 },
  "onboarding-roadmap": { title: "Onboarding roadmap", visibility: "company", prd: "Guided setup", draft: 2 },
  "pricing-roadmap": { title: "Pricing roadmap", visibility: "approvers", prd: "Plan changes", draft: 3 },
};
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

/** The PRD's own code of a section an item came from ("f-06" -> "F-06"); null when the key is no code (service.py). */
export function prdCode(section: string | null | undefined): string | null {
  const m = /^([a-z]{1,3})-(\d+)$/i.exec((section ?? "").trim());
  return m ? `${m[1].toUpperCase()}-${m[2]}` : null;
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
export const goalId = (key: string): string => stableUuid(`simple-goal/${key}`);
export const roadmapId = (slug: string): string => stableUuid(`simple-doc/${slug}`);
// A new company has no roadmap yet (qa-shell-8: oracle.simple.service reads none).
export const ROADMAP_SLUGS = (): string[] => (newCompany() ? [] : Object.keys(ROADMAPS));
/** Whether a commenter or viewer reads the roadmap (oracle.docs.visibility). */
export const readsRoadmap = (slug: string, role: Role): boolean => !(role === "commenter" || role === "viewer") || ROADMAPS[slug]?.visibility === "company";
/** The roadmap a slug or id names, when the role reads it. */
export const readableRoadmap = (asked: string | null, role: Role): string | undefined =>
  asked ? ROADMAP_SLUGS().find((r) => (r === asked || roadmapId(r) === asked) && readsRoadmap(r, role)) : undefined;
/** S7: an item closed for the plan (cut, or a draft merged into another). */
export const closed = (s: SeedItem): boolean => s.status === "cut" || !!s.merged_into;
const TRACKS: Record<string, string> = { alerts: "Usage alerts track", onboarding: "Guided setup track", welcome: "Welcome media track" };

const SEED: SeedItem[] = [
  { key: "alert-rules", title: "Alert rules engine", horizon: "now", roadmap: "alerts-roadmap", goal: "grow-retention", track: "alerts", confidence: "high", start: 0, end: 40, source: "typed", status: "in_progress", gates: [{ phase: "discover", day: 6 }, { phase: "build", day: 28 }], why: "Admins asked for it most this quarter.", section: "bets" },
  { key: "alert-digest", title: "Weekly alert digest", horizon: "now", roadmap: "alerts-roadmap", goal: "grow-retention", track: "alerts", confidence: "medium", start: 30, end: 70, source: "accepted", depends: ["alert-rules"], milestone: { name: "Beta", day: 60 }, section: "f-06", heading: "F-06 Weekly digest of fired alerts" },
  { key: "alert-mobile", title: "Mobile alert push", horizon: "now", roadmap: "alerts-roadmap", goal: "grow-retention", track: "alerts", confidence: "high", end: 80, source: "engineering", depends: ["alert-rules"] },
  { key: "alert-export", title: "Alert history export", horizon: "next", roadmap: "alerts-roadmap", track: "alerts", confidence: "medium", end: 50, source: "tracker" },
  { key: "alert-sso", title: "Alert routing by team", horizon: "next", roadmap: "alerts-roadmap", goal: "grow-retention", track: "alerts", confidence: "low", depends: ["alert-export"] },
  { key: "setup-checklist", title: "Setup checklist", horizon: "now", roadmap: "onboarding-roadmap", goal: "faster-activation", track: "onboarding", confidence: "high", start: 10, end: 45, source: "typed", gates: [{ phase: "Beta", day: 40 }] },
  { key: "setup-import", title: "Sample data import", horizon: "now", roadmap: "onboarding-roadmap", goal: "faster-activation", track: "onboarding", confidence: "medium", start: 20, end: 60, source: "typed", depends: ["setup-checklist"], gates: [{ phase: "beta", day: 75 }], risks: [{ flag: "dependency_order", note: "The checklist's last step is not needed" }] },
  { key: "setup-tour", title: "In-app tour", horizon: "later", roadmap: "onboarding-roadmap", goal: "faster-activation", track: "onboarding", status: "cut" },
  { key: "setup-video", title: "Welcome video", horizon: "later", roadmap: "onboarding-roadmap", track: "onboarding", depends: ["setup-tour"] },
  { key: "setup-ideas", title: "Team invite nudges", horizon: "next", roadmap: "onboarding-roadmap", goal: "faster-activation", draft: true },
  { key: "price-tiers", title: "New plan tiers", horizon: "next", roadmap: "pricing-roadmap", confidence: "medium" },
];

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

/** The item's stored dates (the API's start_date, end_date, date_source columns): moved or
 * accepted in Simple, else the seed's typed or accepted dates; undefined when none. */
export function ownDates(db: SimpleDb, s: SeedItem): SimpleDb["own"][string] | undefined {
  if (db.own[s.key]) return db.own[s.key];
  if ((s.source !== "typed" && s.source !== "accepted") || s.start === undefined || s.end === undefined) return undefined;
  const w = simpleWindows(companyToday())[s.horizon];
  return { start: addDays(w[0], s.start), end: addDays(w[0], s.end), source: s.source };
}

function resolve(db: SimpleDb, s: SeedItem, w: [string, string]): { start: Dated; end: Dated } {
  const own = db.own[s.key];
  if (own) {
    const source = own.source ?? "accepted";
    return { start: { date: own.start, source, estimated: false }, end: { date: own.end, source, estimated: false } };
  }
  const end: Dated = s.end !== undefined && s.source ? { date: addDays(w[0], s.end), source: s.source, estimated: false } : { date: w[1], source: "estimated", estimated: true };
  let start: Dated = { date: w[0], source: "estimated", estimated: true };
  if (s.start !== undefined && s.source) start = { date: addDays(w[0], s.start), source: s.source, estimated: false };
  else if (end.date < w[0]) start = { date: addDays(end.date, -41), source: "estimated", estimated: true };
  return { start, end };
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
  for (const e of [...(s.milestone ? [{ phase: s.milestone.name, day: s.milestone.day }] : []), ...(s.gates ?? [])]) {
    const word = e.phase.trim().toLowerCase();
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

/** A dependency_order line, naming the item and its dependency (constraints.check), with the years when they differ. */
function dependencyLine(title: string, start: string, depTitle: string, end: string): string {
  const years = start.slice(0, 4) !== end.slice(0, 4);
  const day = (d: string) => `${word(d)}${years ? ` ${d.slice(0, 4)}` : ""}`;
  return `‘${short(title)}’ starts ${day(start)}, but ‘${short(depTitle)}’, which it depends on, ends ${day(end)}`;
}

function flagsOf(s: SeedItem, r: { start: Dated; end: Dated }, all: Map<string, { s: SeedItem; r: { start: Dated; end: Dated } }>, w: [string, string]): Flag[] {
  const out: Flag[] = [];
  const flag = (kind: Flag["kind"], reason: string, fixes: Flag["fixes"], subject: string | null = null): void => {
    const risk = s.risks?.find((x) => x.flag === kind && (!x.subject || x.subject === subject));
    out.push({ kind, reason, fixes, state: risk ? "amber" : "red", subject, risk_note: risk?.note ?? null, moves: [] });
  };
  for (const key of s.depends ?? []) {
    const dep = all.get(key);
    if (!dep || closed(dep.s) || (dep.r.end.estimated && r.start.estimated)) continue;
    if (dep.r.end.date >= r.start.date)
      flag("dependency_order", dependencyLine(s.title, r.start.date, dep.s.title, dep.r.end.date), ["shift_dependents", "move_dependency", "accept_risk"], stableUuid(`simple-item/${key}`));
  }
  if (s.milestone) {
    const day = addDays(w[0], s.milestone.day);
    if (r.end.date > day) flag("outside_milestone", `‘${short(s.title)}’ ends ${word(r.end.date)}, after its milestone ‘${s.milestone.name}’ (${word(day)})`, ["accept_risk"], s.milestone.name);
  }
  if (s.status === "cut") {
    const live = [...all.values()].filter((x) => x.s.status !== "cut" && x.s.depends?.includes(s.key));
    if (live.length) {
      const more = live.length > 1 ? ` and ${live.length - 1} other${live.length > 2 ? "s" : ""}` : "";
      flag("cut_with_dependents", `Cut, but ‘${short(live[0].s.title)}’${more} ${live.length > 1 ? "depend" : "depends"} on it`, ["accept_risk"]);
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

/** S4: the item's track owner, by name (service: an enabled track owner). */
function ownerOf(db: SimpleDb, s: SeedItem): Item["owner"] {
  const id = itemOwnerId(db, s.key);
  return id ? { id, name: db.people?.[id] ?? "Track owner" } : null;
}

/** A chat card's set_owner / set_decider (the targets kept by item id), if any: the item's own owner or decider. */
const namedOn = (db: SimpleDb, key: string, field: "owner_id" | "decider_id"): string | null | undefined => {
  const t = db.targets?.[db.ids[key]];
  return t && field in t ? ((t[field] as string | null) ?? null) : undefined;
};

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

function visibleItems(db: SimpleDb, role: Role): SeedItem[] {
  const restricted = role === "commenter" || role === "viewer";
  return db.items.filter((s) => !restricted || ROADMAPS[s.roadmap].visibility === "company");
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
    const mid = same.length ? (same.length % 2 ? same[(same.length - 1) / 2] : Math.floor((same[same.length / 2 - 1] + same[same.length / 2]) / 2 + 0.5)) : 42;
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

/** A draft's applied changes, not undone. */
export function draftChanges(db: SimpleDb, id: string): number {
  const cs = db.changes ?? [];
  return cs.filter((c) => ["applied", "accepted"].includes(c.status) && (c.draft_ids ?? []).includes(id) && !cs.some((u) => u.undoes_id === c.id)).length;
}

/** Who sees a draft in the mock (no required reviewers): owners, its people and the roadmap's decider. */
export function seesDraft(d: MockDraft, me: { id: string; role: Role }, db?: SimpleDb): boolean {
  return me.role === "owner" || d.out.created_by === me.id || d.out.participant_ids.includes(me.id) || db?.deciders?.[d.roadmap] === me.id;
}

/** The roadmap as one reader reads it: hidden drafts' roadmaps at their published items. */
function readerView(db: SimpleDb, me: { id: string; role: Role }): { db: SimpleDb; hidden: number; visible: Schemas["SimpleDraftBrief"][] } {
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
    const keys = new Set(items.filter((s) => s.roadmap === d.roadmap).map((s) => s.key));
    items = [...items.filter((s) => s.roadmap !== d.roadmap), ...d.published.items];
    keyDates = { ...keyDates, [d.roadmap]: d.published.key_dates ?? [] };
    own = { ...Object.fromEntries(Object.entries(own).filter(([k]) => !keys.has(k))), ...d.published.own };
  }
  const shownDocs = new Set(visible.map((v) => v.document_id));
  hidden += (db.changes ?? []).filter((c) => c.status === "proposed" && me.role !== "owner" && c.document_id && !shownDocs.has(c.document_id)).length;
  return { db: { ...db, items, own, key_dates: keyDates }, hidden, visible };
}

/** fix4 qa-simple-roadmap-9: the items one reader reads (the API's drafts.overlays_for): a
 * change's stale check and a fix's plan read them, so a commenter acts on what they see. */
export function readerDb(db: SimpleDb, me: { id: string; role: Role }): SimpleDb {
  return readerView(db, me).db;
}

export function roadmapOut(db: SimpleDb, role: Role, q: URLSearchParams, me?: Who): Schemas["SimpleRoadmapOut"] | null {
  knowTalkGoals(db);
  const decides = (s: SeedItem) => canDecideItem(db, s, me ?? { id: "", role });
  const deciders = (s: SeedItem) => {
    const ids = deciderIds(db, s, me?.roles);
    return (ids.length ? ids : (me?.owners ?? [])).map((id) => me?.names?.[id]).filter((n): n is string => !!n);
  };
  const reader = { ...(me ? readerView(db, me) : { db, hidden: 0, visible: [] }), full: db };
  db = reader.db;
  const today = companyToday();
  const w = simpleWindows(today);
  const group = (q.get("group") ?? "goal") as Schemas["SimpleRoadmapOut"]["group"];
  if (!["goal", "track", "prd"].includes(group)) return null;
  const seeds = visibleItems(db, role);
  const all = new Map(seeds.map((s) => [s.key, { s, r: resolve(db, s, w[s.horizon]) }]));
  // The plan-model lane: the plan PRD's items whose code is a plan feature carry its slices.
  const slices = db.plan ? planSlices() : [];
  const slicesOf = (s: SeedItem, prdSlug: string) => {
    const code = prdCode(s.section);
    return code && (prdSlug === PLAN_PRD_SLUG || db.plan?.prds?.includes(prdSlug)) ? slices.filter((x) => x.feature_code === code) : [];
  };
  const items: Item[] = seeds.map((s) => {
    const r = all.get(s.key)!.r;
    const rm = ROADMAPS[s.roadmap];
    const sliced = slicesOf(s, rm.prd.toLowerCase().replace(/ /g, "-"));
    const suggestion = itemSuggestion(db, db.ids[s.key]);
    return {
      id: db.ids[s.key], key: s.key, title: s.title, outcome: s.outcome ?? null, horizon: s.horizon,
      code: prdCode(s.section),
      roadmap: { id: stableUuid(`simple-doc/${s.roadmap}`), slug: s.roadmap, title: rm.title },
      prd: { id: stableUuid(`simple-prd/${s.roadmap}`), slug: rm.prd.toLowerCase().replace(/ /g, "-"), title: rm.prd },
      goal: s.goal ? { id: stableUuid(`simple-goal/${s.goal}`), key: s.goal, title: GOALS[s.goal] ?? PLAN_GOALS[s.goal], metric: METRICS[s.goal] ?? null } : null,
      track: s.track ? { id: stableUuid(`simple-track/${s.track}`), title: TRACKS[s.track] } : null,
      confidence: s.confidence ?? null,
      status: s.merged_into ? "merged" : s.status === "cut" ? "cut" : s.draft ? "draft" : (s.status ?? "planned"),
      draft: !!s.draft,
      start: r.start, end: r.end,
      source: r.end.estimated ? r.start.source : r.end.source,
      estimated: r.start.estimated && r.end.estimated,
      suggestion: suggestion ? { ...suggestion, can_decide: decides(s) } : null,
      milestone: s.milestone
        ? { name: s.milestone.name, date: addDays(w[s.horizon][0], s.milestone.day), source: "item", ...recordOf(s) }
        : s.record ? { name: s.record, date: null, source: "track", ...recordOf(s) } : null,
      phases: phases(r.start.date, r.end.date, s, w[s.horizon]),
      slices: sliced,
      milestones: [...new Set(sliced.map((x) => x.milestone))],
      depends_on: (s.depends ?? []).filter((k) => all.has(k)).map((k) => db.ids[k]),
      needed_by: seeds.filter((x) => x.depends?.includes(s.key)).map((x) => db.ids[x.key]),
      flags: flagsOf(s, r, all, w[s.horizon]),
      owner: ownerOf(db, s),
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
      flow: s.draft ? (s.flow ?? null) : flowFor(db.visuals, "feature", db.ids[s.key]),
      goal_ids: [...new Set([...(s.goal ? [s.goal] : []), ...(s.goals ?? [])])].map(goalId),
      // S8: the decided decisions that changed the item (./simple-meetings.ts records them).
      decided_in: [...(db.decided_in?.[db.ids[s.key]] ?? [])],
    };
  });
  // qa-simple-home-1: what "Move the dependents" moves, as the change engine moves it (service.read).
  const byItem = new Map(items.map((i) => [i.id, i]));
  for (const i of items)
    for (const f of i.flags) if (f.kind === "dependency_order" && f.fixes.includes("shift_dependents") && f.subject) f.moves = Object.keys(shiftPlan(byItem, i.id, f.subject));
  // The Roadmap filter (service.build's ``roadmap``): one readable roadmap, by id or slug.
  const readable = ROADMAP_SLUGS().filter((r) => readsRoadmap(r, role));
  const chosen = readableRoadmap(q.get("roadmap"), role);
  const prd = q.get("prd");
  const goal = q.get("goal");
  const track = q.get("track");
  const from = q.get("from");
  const to = q.get("to");
  const shown = items.filter(
    (i) =>
      (!q.get("roadmap") || i.roadmap.slug === chosen) &&
      (!prd || i.prd?.slug === prd || i.prd?.id === prd) &&
      (!goal || i.goal?.key === goal || i.goal?.id === goal) &&
      (!track || i.track?.id === track) &&
      (!from || i.end.date >= from) &&
      (!to || i.start.date <= to),
  );
  const groups = new Map<string, { title: string; sort: string; item_ids: string[] }>();
  for (const i of shown) {
    const ref = group === "goal" ? i.goal : group === "track" ? i.track : i.prd;
    const none = { goal: "No goal", track: "No track", prd: "No PRD" }[group];
    const key = ref?.id ?? "none";
    const g = groups.get(key) ?? { title: ref?.title ?? none, sort: ref ? `0${"key" in ref ? ref.key : ref.title}` : "1", item_ids: [] };
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
        return { id: recordOf(of[0]).record_id!, track_id: stableUuid(`simple-track/${of[0].track}`), name, date: null, horizon: "now" as const, status: "planned" as const, item_ids: of.map((s) => db.ids[s.key]), ...UNDATED };
      }),
      // The plan's dated milestones (M1-M3), each naming the items with a slice in it.
      // roadmap-gantt: each planned PRD's own records ("simple-plan-two": two PRDs, M1-M3 each).
      ...(db.plan ? [PLAN_PRD_SLUG, ...(db.plan.prds ?? [])] : []).flatMap((slug) =>
        planMilestones().map((m) => ({
          id: stableUuid(slug === PLAN_PRD_SLUG ? `simple-plan-milestone/${m.code}` : `simple-plan-milestone/${slug}/${m.code}`),
          track_id: stableUuid(`simple-track/${slug === PLAN_PRD_SLUG ? "onboarding" : (seeds.find((s) => ROADMAPS[s.roadmap].prd.toLowerCase().replace(/ /g, "-") === slug)?.track ?? "onboarding")}`),
          name: `${m.code} · ${m.name}`, date: m.end_date,
          horizon: (m.end_date <= w.now[1] ? "now" : m.end_date <= w.next[1] ? "next" : "later") as Horizon, status: "planned" as const,
          item_ids: items.filter((i) => i.prd?.slug === slug && i.milestones.includes(m.code)).map((i) => i.id),
          start_date: m.start_date, end_date: m.end_date, effort_weeks: m.effort_weeks, done_when: m.done_when, targets: m.targets,
        })),
      ),
    ],
    span: db.plan ? planSpan() : null,
    changes_in_review: reader.hidden,
    drafts: reader.visible,
    // One roadmap chosen: its key dates; all roadmaps: every readable one's (oracle.simple.service).
    ...keyDatesOut(db, reader.full, chosen ? [chosen] : readable, me ?? { id: "", role }),
    roadmaps: keyDatesOut(db, reader.full, readable, me ?? { id: "", role }).key_date_roadmaps,
    roadmap: chosen ? { id: roadmapId(chosen), slug: chosen, title: ROADMAPS[chosen].title } : null,
  };
}

/** Roadmap-plus: the shown roadmaps' key dates (the draft's to who sees it) and who may change them. */
function keyDatesOut(db: SimpleDb, full: SimpleDb, shown: string[], me: { id: string; role: Role }): Pick<Schemas["SimpleRoadmapOut"], "key_dates" | "key_date_roadmaps"> {
  const slugs = [...shown].sort((a, b) => ROADMAPS[a].title.localeCompare(ROADMAPS[b].title));
  const ref = (slug: string) => ({ id: stableUuid(`simple-doc/${slug}`), slug, title: ROADMAPS[slug].title });
  const draftOf = (slug: string) => (full.drafts ?? []).find((d) => d.roadmap === slug && OPEN_DRAFT.includes(d.out.status));
  const keyDates = slugs
    .flatMap((slug) => {
      const pub = draftOf(slug)?.published.key_dates ?? null;
      return (db.key_dates?.[slug] ?? []).map((k) => {
        const was = pub?.find((x) => x.id === k.id);
        const inDraft = pub !== null && (!was || JSON.stringify(was) !== JSON.stringify(k));
        return { id: k.id, roadmap: ref(slug), name: k.name, date: k.date, note: k.note, in_draft: inDraft };
      });
    })
    .sort((a, b) => (a.date === b.date ? a.name.localeCompare(b.name) : a.date < b.date ? -1 : 1));
  const may = me.role !== "viewer";
  return { key_dates: keyDates, key_date_roadmaps: slugs.map((slug) => ({ roadmap: ref(slug), applies: may && canEditRoadmap(full, slug, me), can_change: may })) };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** S7: the matches a draft keeps (live items, best first, at most 2). */
export function matchesOf(db: SimpleDb, keys: string[]): Schemas["SimpleMatch"][] {
  return keys
    .map((k) => db.items.find((x) => x.key === k))
    .filter((x): x is SeedItem => !!x && !closed(x))
    .slice(0, 2)
    // Its display code (F-06) or none, never its key, as additions.reconcile.
    .map((x) => ({ kind: "item" as const, id: db.ids[x.key], code: prdCode(x.section) ?? "", title: x.title }));
}

const WORDS = (t: string): Set<string> => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4));

/** S7, Oracle's duplicate check (simplified): live items of the roadmap sharing a word of four
 * letters or more with the title, most shared first. */
export function lookalikes(db: SimpleDb, title: string, roadmap: string | null, except?: string): string[] {
  const mine = WORDS(title);
  return db.items
    .filter((x) => x.key !== except && !closed(x) && !x.draft && (!roadmap || x.roadmap === roadmap))
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
    s.outcome ??= `Teams get ${s.title.toLowerCase()} without asking support`;
    s.flow = plainFlow({
      title: s.title,
      steps: ["Open the alerts page", `Find ${s.title.toLowerCase()}`, "Set it up in one step", "See it working"],
      screen: { title: `${s.title} settings`, regions: ["Header: what it does", "The one setting", "A preview", "Save and Cancel buttons"] },
    });
    const dep = db.items.find((x) => x.key !== s.key && x.goal && x.goal === s.goal && !closed(x) && !x.draft && x.roadmap === s.roadmap);
    if (dep && !(s.depends ?? []).includes(dep.key)) s.depends = [...(s.depends ?? []), dep.key];
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
