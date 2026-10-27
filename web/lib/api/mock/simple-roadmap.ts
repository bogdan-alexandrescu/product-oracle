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
import { mockNowMs } from "./clock";
import { seeded, stableUuid } from "./ids";

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
}

/** A reader, with every member's role (D-a: a track owner decides only as an approver or owner). */
export interface Who {
  id: string;
  role: Role;
  roles?: Record<string, Role>;
}

/** A working draft of one roadmap (oracle.simple.drafts): the items in `db.items` are the
 * draft's; `published` keeps the roadmap's published items for those who may not see it. */
interface MockDraft {
  out: Omit<Schemas["SimpleDraftOut"], "changes" | "can_submit" | "can_resume" | "can_approve" | "change_log" | "can_withdraw">;
  roadmap: string;
  published: { items: SeedItem[]; own: SimpleDb["own"] };
}

const ROADMAPS: Record<string, { title: string; visibility: "company" | "approvers"; prd: string }> = {
  "alerts-roadmap": { title: "Alerts roadmap", visibility: "company", prd: "Usage alerts" },
  "onboarding-roadmap": { title: "Onboarding roadmap", visibility: "company", prd: "Guided setup" },
  "pricing-roadmap": { title: "Pricing roadmap", visibility: "approvers", prd: "Plan changes" },
};
const GOALS: Record<string, string> = { "grow-retention": "Grow retention", "faster-activation": "Faster activation" };
/** S4: each goal's metric (the goal counters' line). */
const METRICS: Record<string, string> = { "grow-retention": "Teams active after 90 days", "faster-activation": "Days to the first alert" };
const TRACKS: Record<string, string> = { alerts: "Usage alerts track", onboarding: "Guided setup track", welcome: "Welcome media track" };

const SEED: SeedItem[] = [
  { key: "alert-rules", title: "Alert rules engine", horizon: "now", roadmap: "alerts-roadmap", goal: "grow-retention", track: "alerts", confidence: "high", start: 0, end: 40, source: "typed", status: "in_progress", gates: [{ phase: "discover", day: 6 }, { phase: "build", day: 28 }], why: "Admins asked for it most this quarter.", section: "bets" },
  { key: "alert-digest", title: "Weekly alert digest", horizon: "now", roadmap: "alerts-roadmap", goal: "grow-retention", track: "alerts", confidence: "medium", start: 30, end: 70, source: "accepted", depends: ["alert-rules"], milestone: { name: "Beta", day: 60 } },
  { key: "alert-mobile", title: "Mobile alert push", horizon: "now", roadmap: "alerts-roadmap", goal: "grow-retention", track: "alerts", confidence: "high", end: 80, source: "engineering", depends: ["alert-rules"] },
  { key: "alert-export", title: "Alert history export", horizon: "next", roadmap: "alerts-roadmap", track: "alerts", confidence: "medium", end: 50, source: "tracker" },
  { key: "alert-sso", title: "Alert routing by team", horizon: "next", roadmap: "alerts-roadmap", goal: "grow-retention", track: "alerts", confidence: "low", depends: ["alert-export"] },
  { key: "setup-checklist", title: "Setup checklist", horizon: "now", roadmap: "onboarding-roadmap", goal: "faster-activation", track: "onboarding", confidence: "high", start: 10, end: 45, source: "typed", gates: [{ phase: "Beta", day: 40 }] },
  { key: "setup-import", title: "Sample data import", horizon: "now", roadmap: "onboarding-roadmap", goal: "faster-activation", track: "onboarding", confidence: "medium", start: 20, end: 60, source: "typed", depends: ["setup-checklist"], risks: [{ flag: "dependency_order", note: "The checklist's last step is not needed" }] },
  { key: "setup-tour", title: "In-app tour", horizon: "later", roadmap: "onboarding-roadmap", goal: "faster-activation", track: "onboarding", status: "cut" },
  { key: "setup-video", title: "Welcome video", horizon: "later", roadmap: "onboarding-roadmap", track: "onboarding", depends: ["setup-tour"] },
  { key: "setup-ideas", title: "Team invite nudges", horizon: "next", roadmap: "onboarding-roadmap", goal: "faster-activation", draft: true },
  { key: "price-tiers", title: "New plan tiers", horizon: "next", roadmap: "pricing-roadmap", confidence: "medium" },
];

const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const ms = (day: string): number => Date.parse(`${day}T00:00:00Z`);
const addDays = (day: string, n: number): string => iso(ms(day) + n * DAY);
const span = (a: string, b: string): number => Math.round((ms(b) - ms(a)) / DAY) + 1;
const word = (day: string): string => new Date(ms(day)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function addMonths(day: string, months: number): string {
  const d = new Date(ms(day));
  const y = d.getUTCFullYear() + Math.floor((d.getUTCMonth() + months) / 12);
  const m = (d.getUTCMonth() + months) % 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return iso(Date.UTC(y, m, Math.min(d.getUTCDate(), last)));
}

/** tenant_settings_api.horizon_windows with the default horizons, on the mock's day. */
export function simpleWindows(today: string): Record<Horizon, [string, string]> {
  const d = new Date(ms(today));
  const q = iso(Date.UTC(d.getUTCFullYear(), 3 * Math.floor(d.getUTCMonth() / 3), 1));
  const medium = addMonths(q, 3);
  const mediumEnd = addMonths(medium, 6);
  return { now: [q, addDays(medium, -1)], next: [medium, addDays(mediumEnd, -1)], later: [addMonths(today, 12), addMonths(today, 24)] };
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
  return seeded("simple-roadmap", () => ({
    items: SEED.map((s) => ({ ...s })),
    ids: Object.fromEntries(SEED.map((s) => [s.key, stableUuid(`simple-item/${s.key}`)])),
    own: {},
    suggestions: [],
    decisions: { "alert-digest": [{ number: 7, title: "Send the digest weekly or daily?" }] },
  }));
}

/**
 * The "simple-500" scenario (S4: first paint and drag speed): 500 invented items over the
 * three roadmaps, both goals and the three tracks, dated and undated, with chains of
 * dependencies.
 */
export function seedSimpleMany(n = 500): SimpleDb {
  const roadmaps = ["alerts-roadmap", "onboarding-roadmap", "pricing-roadmap"];
  const goals = [...Object.keys(GOALS), undefined];
  const tracks = Object.keys(TRACKS);
  const horizons: Horizon[] = ["now", "next", "later"];
  const items: SeedItem[] = Array.from({ length: n }, (_, i) => {
    const dated = i % 3 !== 2;
    const start = (i * 7) % 60;
    return {
      key: `item-${i}`, title: `Planned item ${i + 1}`, horizon: horizons[i % 3], roadmap: roadmaps[i % 2],
      goal: goals[i % 3], track: tracks[i % 3], confidence: (["low", "medium", "high"] as const)[i % 3],
      ...(dated ? { start, end: start + 20 + (i % 30), source: "typed" as const } : {}),
      ...(i % 10 === 5 ? { depends: [`item-${i - 1}`] } : {}),
    };
  });
  return { items, ids: Object.fromEntries(items.map((s) => [s.key, stableUuid(`simple-item/${s.key}`)])), own: {}, suggestions: [] };
}

/** The item's stored dates (the API's start_date, end_date, date_source columns): moved or
 * accepted in Simple, else the seed's typed or accepted dates; undefined when none. */
export function ownDates(db: SimpleDb, s: SeedItem): SimpleDb["own"][string] | undefined {
  if (db.own[s.key]) return db.own[s.key];
  if ((s.source !== "typed" && s.source !== "accepted") || s.start === undefined || s.end === undefined) return undefined;
  const w = simpleWindows(iso(mockNowMs()))[s.horizon];
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

const PHASES = [["discover", 0.15], ["build", 0.55], ["beta", 0.2], ["launch", 0.1]] as const;

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
    if (day < cursor) day = cursor;
    const out = { key, start: cursor, end: day, estimated: !own };
    cursor = addDays(day, 1);
    return out;
  });
}

const short = (t: string): string => (t.length <= 40 ? t : `${t.slice(0, 39)}…`);

function flagsOf(s: SeedItem, r: { start: Dated; end: Dated }, all: Map<string, { s: SeedItem; r: { start: Dated; end: Dated } }>, w: [string, string]): Flag[] {
  const out: Flag[] = [];
  const flag = (kind: Flag["kind"], reason: string, fixes: Flag["fixes"], subject: string | null = null): void => {
    const risk = s.risks?.find((x) => x.flag === kind && (!x.subject || x.subject === subject));
    out.push({ kind, reason, fixes, state: risk ? "amber" : "red", subject, risk_note: risk?.note ?? null });
  };
  for (const key of s.depends ?? []) {
    const dep = all.get(key);
    if (!dep || dep.s.status === "cut" || (dep.r.end.estimated && r.start.estimated)) continue;
    if (dep.r.end.date >= r.start.date)
      flag("dependency_order", `Starts ${word(r.start.date)}, but '${short(dep.s.title)}' it depends on ends ${word(dep.r.end.date)}`, ["shift_dependents", "move_dependency", "accept_risk"], stableUuid(`simple-item/${key}`));
  }
  if (s.milestone) {
    const day = addDays(w[0], s.milestone.day);
    if (r.end.date > day) flag("outside_milestone", `Ends ${word(r.end.date)}, after its milestone '${s.milestone.name}' (${word(day)})`, ["accept_risk"], s.milestone.name);
  }
  if (s.status === "cut") {
    const live = [...all.values()].filter((x) => x.s.status !== "cut" && x.s.depends?.includes(s.key));
    if (live.length) {
      const more = live.length > 1 ? ` and ${live.length - 1} other${live.length > 2 ? "s" : ""}` : "";
      flag("cut_with_dependents", `Cut, but '${short(live[0].s.title)}'${more} ${live.length > 1 ? "depend" : "depends"} on it`, ["accept_risk"]);
    }
  }
  if (s.draft && !s.track) flag("draft_without_owner", "Draft with no owner to confirm it", []);
  return out;
}

/** S4: the item's track owner, by name (service: an enabled track owner). */
function ownerOf(db: SimpleDb, s: SeedItem): Item["owner"] {
  const id = s.track ? db.track_owners?.[s.track] : undefined;
  return id ? { id, name: db.people?.[id] ?? "Track owner" } : null;
}

const RANK: Record<Role, number> = { viewer: 0, commenter: 1, approver: 2, owner: 3 };

/** service.decider_ids (D-a): the roadmap's decider, else the item's track owner when an
 * approver or owner; [] when the company's owners decide. The default seed names none;
 * the "simple-deciders" scenario (seedSimpleDeciders) names both. */
export function deciderIds(db: SimpleDb, s: SeedItem, roles?: Record<string, Role>): string[] {
  const decider = db.deciders?.[s.roadmap];
  if (decider) return [decider];
  const owner = s.track ? db.track_owners?.[s.track] : undefined;
  return owner && RANK[roles?.[owner] ?? "viewer"] >= RANK.approver ? [owner] : [];
}

/** service.can_decide (D-a): an owner; the decider; with none, the item's track owner while an approver or owner. */
export function canDecideItem(db: SimpleDb, s: SeedItem, me: { id: string; role: Role }): boolean {
  if (me.role === "owner") return true;
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

/** oracle.simple.suggestions.regenerate: one open suggestion per undated item. */
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
    const undated = r.start.estimated && r.end.estimated && s.status !== "cut" && s.status !== "done";
    if (!undated || db.suggestions.some((x) => x.item_id === id && x.status === "dismissed")) {
      if (current) db.suggestions = db.suggestions.filter((x) => x !== current);
      continue;
    }
    const window = w[s.horizon];
    let start = window[0];
    let why = `starts with the ${s.horizon[0].toUpperCase()}${s.horizon.slice(1)} window`;
    const deps = (s.depends ?? []).map((k) => resolved.get(k)).filter((x) => x !== undefined);
    const latest = deps.sort((a, b) => (a.r.end.date < b.r.end.date ? 1 : -1))[0];
    if (latest && addDays(latest.r.end.date, 1) > start) {
      start = addDays(latest.r.end.date, 1);
      why = `starts the day after '${latest.s.title}' ends`;
    }
    const same = [...(durations.get(s.confidence ?? "") ?? [])].sort((a, b) => a - b);
    const mid = same.length ? (same.length % 2 ? same[(same.length - 1) / 2] : Math.floor((same[same.length / 2 - 1] + same[same.length / 2]) / 2 + 0.5)) : 42;
    const conf = s.confidence ? `${s.confidence}-confidence` : "unrated";
    const how = same.length ? `${mid} days, the median of ${same.length} dated ${conf} items` : `${mid} days, the default with no dated ${conf} items`;
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
    own = { ...Object.fromEntries(Object.entries(own).filter(([k]) => !keys.has(k))), ...d.published.own };
  }
  const shownDocs = new Set(visible.map((v) => v.document_id));
  hidden += (db.changes ?? []).filter((c) => c.status === "proposed" && me.role !== "owner" && c.document_id && !shownDocs.has(c.document_id)).length;
  return { db: { ...db, items, own }, hidden, visible };
}

export function roadmapOut(db: SimpleDb, role: Role, q: URLSearchParams, me?: { id: string; role: Role }): Schemas["SimpleRoadmapOut"] | null {
  const decides = (s: SeedItem) => canDecideItem(db, s, me ?? { id: "", role });
  const reader = me ? readerView(db, me) : { db, hidden: 0, visible: [] };
  db = reader.db;
  const today = iso(mockNowMs());
  const w = simpleWindows(today);
  const group = (q.get("group") ?? "goal") as Schemas["SimpleRoadmapOut"]["group"];
  if (!["goal", "track", "prd"].includes(group)) return null;
  const seeds = visibleItems(db, role);
  const all = new Map(seeds.map((s) => [s.key, { s, r: resolve(db, s, w[s.horizon]) }]));
  const items: Item[] = seeds.map((s) => {
    const r = all.get(s.key)!.r;
    const rm = ROADMAPS[s.roadmap];
    const suggestion = db.suggestions.find((x) => x.item_id === db.ids[s.key] && x.status === "open");
    return {
      id: db.ids[s.key], key: s.key, title: s.title, outcome: s.outcome ?? null, horizon: s.horizon,
      roadmap: { id: stableUuid(`simple-doc/${s.roadmap}`), slug: s.roadmap, title: rm.title },
      prd: { id: stableUuid(`simple-prd/${s.roadmap}`), slug: rm.prd.toLowerCase().replace(/ /g, "-"), title: rm.prd },
      goal: s.goal ? { id: stableUuid(`simple-goal/${s.goal}`), key: s.goal, title: GOALS[s.goal], metric: METRICS[s.goal] ?? null } : null,
      track: s.track ? { id: stableUuid(`simple-track/${s.track}`), title: TRACKS[s.track] } : null,
      confidence: s.confidence ?? null,
      status: s.draft ? "draft" : (s.status ?? "planned"),
      draft: !!s.draft,
      start: r.start, end: r.end,
      source: r.end.estimated ? r.start.source : r.end.source,
      estimated: r.start.estimated && r.end.estimated,
      suggestion: suggestion ? { ...suggestion, can_decide: decides(s) } : null,
      milestone: s.milestone ? { name: s.milestone.name, date: addDays(w[s.horizon][0], s.milestone.day), source: "item" } : null,
      phases: phases(r.start.date, r.end.date, s, w[s.horizon]),
      depends_on: (s.depends ?? []).filter((k) => all.has(k)).map((k) => db.ids[k]),
      needed_by: seeds.filter((x) => x.depends?.includes(s.key)).map((x) => db.ids[x.key]),
      flags: flagsOf(s, r, all, w[s.horizon]),
      owner: ownerOf(db, s),
      can_decide: decides(s),
      reasons: [
        ...(s.why ? [s.why] : []),
        ...(s.goal ? [`Serves the goal ${GOALS[s.goal]}.`] : []),
        ...(s.section ? [`From ${rm.prd}, section ${s.section}.`] : []),
      ].slice(0, 3),
      open_decisions: (db.decisions?.[s.key] ?? []).map((d) => ({ id: stableUuid(`simple-decision/${d.number}`), number: d.number, title: d.title })),
    };
  });
  const prd = q.get("prd");
  const goal = q.get("goal");
  const track = q.get("track");
  const from = q.get("from");
  const to = q.get("to");
  const shown = items.filter(
    (i) =>
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
      { id: stableUuid("simple-milestone/beta"), track_id: stableUuid("simple-track/alerts"), name: "Beta", date: addDays(w.now[0], 60), horizon: "now", status: "planned", item_ids: [db.ids["alert-digest"]] },
    ],
    changes_in_review: reader.hidden,
    drafts: reader.visible,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** /v1/simple/roadmap and its date suggestions (api/oracle/simple/router.py). */
export async function routeSimpleRoadmap(db: SimpleDb, me: Who, req: Request, p: string[], q: URLSearchParams): Promise<Response | null> {
  if (p[1] !== "simple" || p[2] !== "roadmap") return null;
  const m = req.method;
  const today = iso(mockNowMs());
  if (!db.suggestions.length && !Object.keys(db.own).length) regenerate(db, today);
  if (!p[3] && m === "GET") {
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
  Object.assign(s, { status: "dismissed", decided_by: me.id, decided_at: new Date(mockNowMs()).toISOString() });
  return json(200, { ...s, can_decide: true });
}

export type { MockDraft, SeedItem, SimpleDb };
