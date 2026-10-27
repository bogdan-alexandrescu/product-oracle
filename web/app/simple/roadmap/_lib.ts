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

const SOURCE_WORDS: Record<Schemas["SimpleDate"]["source"], string> = {
  typed: "typed",
  accepted: "accepted",
  engineering: "engineering",
  tracker: "tracker",
  estimated: "estimated",
};

export function sourceWord(source: Schemas["SimpleDate"]["source"]): string {
  return SOURCE_WORDS[source];
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
