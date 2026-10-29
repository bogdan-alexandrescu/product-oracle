/**
 * Simple S4 (#723) roadmap, lane 1: what the timeline and the Gantt share. Days are ISO
 * strings (the API's), counted in UTC; a scale turns them into pixels.
 */
import { api, type Schemas } from "@/lib/api/client";
import { calendarDay } from "@/lib/dates";

export type Roadmap = Schemas["SimpleRoadmapOut"];
export type Item = Schemas["SimpleRoadmapItem"];
export type Flag = Schemas["SimpleFlag"];
export type Change = Schemas["SimpleChangeOut"];
export type ChangeResult = Schemas["SimpleChangeResult"];
export type Draft = Schemas["SimpleDraftOut"];
export type KeyDate = Schemas["SimpleKeyDate"];
export type Format = "timeline" | "gantt" | "board" | "waterfall";
export type GanttUnit = "day" | "week";

export const DAY_MS = 86_400_000;
export const ms = (day: string): number => Date.parse(`${day.slice(0, 10)}T00:00:00Z`);
export const iso = (t: number): string => new Date(t).toISOString().slice(0, 10);
export const addDays = (day: string, n: number): string => iso(ms(day) + n * DAY_MS);
export const daysBetween = (a: string, b: string): number => Math.round((ms(b) - ms(a)) / DAY_MS);

export const shortDay = (day: string): string => calendarDay(day);

/** A span in words, with its year when it is not this year's ("Jan 1 – Jun 30, 2027",
 * "Oct 22, 2027 – Oct 22, 2028"). */
export function spanWords(start: string, end: string, today: string): string {
  const [ys, ye, yt] = [start, end, today].map((d) => d.slice(0, 4));
  if (ys === ye && ys === yt) return `${shortDay(start)} – ${shortDay(end)}`;
  if (ys === ye) return `${shortDay(start)} – ${shortDay(end)}, ${ye}`;
  return `${shortDay(start)}, ${ys} – ${shortDay(end)}, ${ye}`;
}

export function quarterOf(day: string): { start: string; label: string } {
  const d = new Date(ms(day));
  const q = Math.floor(d.getUTCMonth() / 3);
  return { start: iso(Date.UTC(d.getUTCFullYear(), q * 3, 1)), label: `Q${q + 1} ${d.getUTCFullYear()}` };
}

export function nextQuarter(start: string): string {
  const d = new Date(ms(start));
  return iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, 1));
}

/** The quarters from the one holding `from` through the one holding `to`. */
export function quarters(from: string, to: string): { start: string; end: string; label: string }[] {
  const out: { start: string; end: string; label: string }[] = [];
  let q = quarterOf(from).start;
  while (q <= to && out.length < 40) {
    const n = nextQuarter(q);
    out.push({ start: q, end: addDays(n, -1), label: quarterOf(q).label });
    q = n;
  }
  return out;
}

export interface Scale {
  start: string;
  end: string;
  /** Pixels per day. */
  px: number;
  width: number;
  x: (day: string) => number;
  day: (x: number) => string;
}

export function scale(start: string, end: string, px: number): Scale {
  const s = ms(start);
  return {
    start,
    end,
    px,
    width: Math.max(1, (daysBetween(start, end) + 1) * px),
    x: (day) => ((ms(day) - s) / DAY_MS) * px,
    day: (x) => iso(s + Math.round(x / px) * DAY_MS),
  };
}

/** The bar's drawn span: its resolved dates (an estimate spans its horizon's window). */
export const barSpan = (i: Item): [string, string] => [i.start.date, i.end.date];

/** What a bar looks like, in order: draft (dashed), estimated (hatched), dated (solid). */
export function barKind(i: Item): "draft" | "estimated" | "dated" {
  if (i.draft) return "draft";
  if (i.estimated) return "estimated";
  return "dated";
}

/** A date's source, in plain words for a reader (not the API's enum value). Also used for a
 * bar's aria-label (_timeline.tsx, _lanes.tsx). */
export const SOURCE_WORDS: Record<Schemas["SimpleDate"]["source"], string> = {
  typed: "Dates set by you",
  accepted: "Dates accepted from Oracle",
  engineering: "Dates from engineering",
  tracker: "Dates from the tracker",
  estimated: "Estimated by Oracle",
};

export function sourceWord(source: Schemas["SimpleDate"]["source"]): string {
  return SOURCE_WORDS[source];
}

/** An item's status, in plain words for a reader (not the API's `in_progress`-style enum
 * value). Also used for a bar's aria-label (_timeline.tsx, _lanes.tsx). */
export const STATUS_WORDS: Record<Item["status"], string> = {
  planned: "Planned",
  in_progress: "In progress",
  done: "Done",
  cut: "Cut",
  draft: "Draft",
  merged: "Merged",
};

export function statusWord(status: Item["status"]): string {
  return STATUS_WORDS[status];
}

/** A confidence rating, in plain words (title-cased, not the API's lowercase value). */
export const CONFIDENCE_WORDS: Record<"low" | "medium" | "high", string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

export function confidenceWord(confidence: string): string {
  return CONFIDENCE_WORDS[confidence as "low" | "medium" | "high"] ?? confidence;
}

/** A phase's key (a gate or the waterfall's slice), in plain words. Also used for a bar's
 * aria-label (_timeline.tsx, _lanes.tsx); matches _timeline.tsx's PHASES labels. */
export const PHASE_WORDS: Record<Item["phases"][number]["key"], string> = {
  discover: "Discover",
  build: "Build",
  beta: "Beta",
  launch: "Launch",
};

export function phaseWord(key: Item["phases"][number]["key"]): string {
  return PHASE_WORDS[key] ?? key;
}

/** The item's stored dates (the change engine's `before` of move_dates): typed or accepted
 * dates are the item's own; any other source reads as none stored. */
export function storedDates(i: Item): { start_date: string | null; end_date: string | null } {
  const own = (d: Schemas["SimpleDate"]) => (d.source === "typed" || d.source === "accepted" ? d.date : null);
  return { start_date: own(i.start), end_date: own(i.end) };
}

/** The flags drawn red (not accepted as a risk). */
export const broken = (i: Item): Flag[] => i.flags.filter((f) => f.state === "red");

/**
 * The constraint checker's dependency rule, live while a bar is dragged (the API checks it
 * again on drop): the item starts on or before a dependency ends, or ends on or after a
 * dependent starts.
 */
export function liveBreaks(items: Map<string, Item>, id: string, start: string, end: string): string[] {
  const it = items.get(id);
  if (!it) return [];
  const out: string[] = [];
  for (const d of it.depends_on) {
    const dep = items.get(d);
    if (dep && dep.status !== "cut" && dep.end.date >= start) out.push(`Starts ${shortDay(start)}, but '${dep.title}' it depends on ends ${shortDay(dep.end.date)}`);
  }
  for (const n of it.needed_by) {
    const next = items.get(n);
    if (next && next.status !== "cut" && end >= next.start.date) out.push(`Ends ${shortDay(end)}, after '${next.title}' that depends on it starts ${shortDay(next.start.date)}`);
  }
  return out;
}

export class ChangeFailed extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function detailOf(error: unknown): string {
  const d = (error as { detail?: unknown } | undefined)?.detail;
  if (typeof d === "string") return d;
  if (d && typeof d === "object" && "message" in d) return String((d as { message: unknown }).message);
  return "Oracle could not make this change";
}

/** One change through the engine (POST /v1/simple/changes). */
export async function propose(body: Schemas["SimpleChangeIn"]): Promise<ChangeResult> {
  const { data, error, response } = await api.POST("/v1/simple/changes", { body });
  if (!data) throw new ChangeFailed(detailOf(error), response.status);
  return data;
}

export async function undo(id: string): Promise<ChangeResult> {
  const { data, error, response } = await api.POST("/v1/simple/changes/{change_id}/undo", { params: { path: { change_id: id } } });
  if (!data) throw new ChangeFailed(detailOf(error), response.status);
  return data;
}

export async function decide(id: string, how: "accept" | "decline"): Promise<ChangeResult> {
  const path = { params: { path: { change_id: id } }, body: {} };
  const { data, error, response } =
    how === "accept" ? await api.POST("/v1/simple/changes/{change_id}/accept", path) : await api.POST("/v1/simple/changes/{change_id}/decline", path);
  if (!data) throw new ChangeFailed(detailOf(error), response.status);
  return data;
}

export async function suggestion(id: string, how: "accept" | "edit" | "dismiss", dates?: { start_date: string; end_date: string }): Promise<void> {
  const path = { params: { path: { suggestion_id: id } } };
  const r =
    how === "accept"
      ? await api.POST("/v1/simple/roadmap/date-suggestions/{suggestion_id}/accept", path)
      : how === "edit"
        ? await api.POST("/v1/simple/roadmap/date-suggestions/{suggestion_id}/edit", { ...path, body: dates! })
        : await api.POST("/v1/simple/roadmap/date-suggestions/{suggestion_id}/dismiss", path);
  if (!r.data) throw new ChangeFailed(detailOf(r.error), r.response.status);
}

/** The words a change's result says: applied (undo) or proposed (to whom). */
export function resultWords(r: ChangeResult, what: string): string {
  return r.change.status === "applied" ? `${what} in your working draft` : `${what} proposed: it waits for the decider`;
}

const PHASE_SPLIT: [Item["phases"][number]["key"], number][] = [
  ["discover", 0.15],
  ["build", 0.55],
  ["beta", 0.2],
  ["launch", 0.1],
];

/**
 * Roadmap-plus: the item's waterfall phases over a new span, as the API works them out
 * again after a move (oracle.simple.dates.phases): a phase a dated gate ends stays on the
 * gate's day; every other phase keeps its share of the bar and ends before the next dated
 * gate (they may bunch up). Drawn while a bar is dragged and until the change answers.
 */
export function rephase(item: Item, start: string, end: string): Item["phases"] {
  const named = new Map(item.phases.filter((p) => !p.estimated).map((p) => [p.key, p.end]));
  const total = daysBetween(start, end) + 1;
  let cursor = start;
  let share = 0;
  return PHASE_SPLIT.map(([key, part], i) => {
    share += part;
    const own = named.get(key);
    let day = own ?? (i === PHASE_SPLIT.length - 1 ? end : addDays(start, Math.round(total * share) - 1));
    if (!own) {
      const gate = PHASE_SPLIT.slice(i + 1)
        .map(([k]) => named.get(k))
        .filter((d): d is string => !!d)
        .sort()[0];
      if (gate && day >= gate) day = addDays(gate, -1);
      if (day < cursor) day = cursor;
    }
    const out = { key, start: cursor < day ? cursor : day, end: day, estimated: !own };
    if (addDays(day, 1) > cursor) cursor = addDays(day, 1);
    return out;
  });
}

/** Roadmap-plus: the key dates of the item's roadmap it ends within 2 weeks of, in words; null when none. */
export function nearWords(item: Item, keyDates: KeyDate[]): string | null {
  const near = keyDates
    .filter((k) => k.roadmap.id === item.roadmap.id && Math.abs(daysBetween(item.end.date, k.date)) <= 14)
    .map((k) => {
      const n = daysBetween(item.end.date, k.date);
      const when = n === 0 ? "ends that day" : n > 0 ? `ends ${n} day${n === 1 ? "" : "s"} before` : `ends ${-n} day${n === -1 ? "" : "s"} after`;
      return `${k.name} (${shortDay(k.date)}): ${when}`;
    });
  return near.length ? near.join(" · ") : null;
}

/** S7: an item closed for the plan (cut, or a draft merged into another): drawn below the line. */
export const closedItem = (i: Item): boolean => i.status === "cut" || i.status === "merged";

/** S7: a quarter as the change engine names it ("2026-Q4"). */
export function quarterValue(start: string): string {
  const d = new Date(ms(start));
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

/** S7: where a quick-added item goes: a quarter, a horizon or a goal (data-add-where="kind:value"). */
export type Where = { kind: "quarter" | "horizon" | "goal"; value: string; label: string };
export const whereAttr = (kind: Where["kind"], value: string): string => `${kind}:${value}`;

/** roadmap-gantt: what the rows sit under (Goal by default; Milestone is read from the items' slices). */
export type Lane = "goal" | "milestone" | "track" | "prd";
export type Slice = Schemas["SimpleSlice"];
export type Milestone = Roadmap["milestones"][number];

/** A milestone's colour, by its code (M1, M2, M3, then round again). */
const MILESTONE_INKS = ["var(--accent)", "var(--pass)", "var(--warn)", "var(--na)"];
export function milestoneInk(code: string): string {
  const n = Number(code.replace(/\D/g, "")) || 1;
  return MILESTONE_INKS[(n - 1) % MILESTONE_INKS.length];
}

/** A milestone's words, its code with its name ("M2 Scale volume", never "M2 · Scale volume"). */
export const milestoneWords = (name: string): string => name.replace(/\s*·\s*/, " ");

/** The plan's dated milestones (a start and an end), in date order. */
export const planMilestones = (data: Roadmap): Milestone[] =>
  data.milestones.filter((m) => m.start_date && m.end_date).sort((a, b) => (a.end_date! < b.end_date! ? -1 : 1));

/** The milestone a person is in now: the one running today, else the next one, else the last. */
export function currentMilestone(data: Roadmap): Milestone | null {
  const list = planMilestones(data);
  return list.find((m) => m.end_date! >= data.today) ?? list.at(-1) ?? null;
}

/** The PRDs the plan's items come from (slug -> title), in the order first seen. */
export function planPrds(data: Roadmap): Map<string, string> {
  return new Map(data.items.flatMap((i) => (i.slices.length && i.prd ? [[i.prd.slug, i.prd.title] as [string, string]] : [])));
}

/** A dated milestone's PRD: the PRD of the planned items it names, else of its track's (null: none). */
export function milestonePrd(data: Roadmap, m: Milestone): { slug: string; title: string } | null {
  const ids = new Set(m.item_ids);
  const planned = data.items.filter((i) => i.slices.length && i.prd);
  const prd = (planned.find((i) => ids.has(i.id)) ?? planned.find((i) => i.track?.id === m.track_id))?.prd;
  return prd ? { slug: prd.slug, title: prd.title } : null;
}

/**
 * The rows' lanes. Goal: the API's goal groups, an item with no goal of its own going under the
 * goal its plan slices move most (the API's lane of that goal when there is one; one lane per
 * goal, "No goal" last); Milestone: an item under its PRD's milestone of its first slice, in code
 * order, titled with the PRD when the plan's items come from more than one ("No milestone"
 * last); Track and PRD: the API's.
 */
export function lanes(data: Roadmap, by: Lane): Roadmap {
  if (by === "track" || by === "prd") return data;
  const byId = new Map(data.items.map((i) => [i.id, i]));
  const out = new Map<string, { key: string; title: string; item_ids: string[] }>();
  const order = new Map<string, [string, string]>();
  const put = (key: string, title: string, id: string) => {
    const g = out.get(key) ?? { key, title, item_ids: [] };
    g.item_ids.push(id);
    out.set(key, g);
  };
  if (by === "goal") {
    for (const g of data.groups)
      for (const id of g.item_ids) {
        const goal = g.key === "none" ? byId.get(id)?.slices.find((x) => x.goal)?.goal : null;
        const named = goal ? data.groups.find((x) => x.key !== "none" && x.title === goal) : undefined;
        if (named) put(named.key, named.title, id);
        else if (goal) put(`plan-goal:${goal}`, goal, id);
        else put(g.key, g.title, id);
      }
  } else {
    const many = planPrds(data).size > 1;
    for (const g of data.groups)
      for (const id of g.item_ids) {
        const item = byId.get(id);
        const first = item?.slices[0];
        if (first) {
          const prd = item!.prd;
          const key = `milestone:${prd?.slug ?? ""}:${first.milestone}`;
          order.set(key, [first.milestone, prd?.title ?? ""]);
          put(key, `${first.milestone} ${first.milestone_name}${many && prd ? ` (${prd.title})` : ""}`, id);
        } else put("none", "No milestone", id);
      }
  }
  const groups = [...out.values()];
  if (by === "milestone")
    groups.sort((a, b) => {
      if (a.key === "none" || b.key === "none") return Number(a.key === "none") - Number(b.key === "none");
      const [ac, ap] = order.get(a.key)!;
      const [bc, bp] = order.get(b.key)!;
      return ac.localeCompare(bc, undefined, { numeric: true }) || ap.localeCompare(bp);
    });
  else groups.sort((a, b) => Number(a.key === "none") - Number(b.key === "none"));
  return { ...data, groups };
}
