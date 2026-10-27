import { goalViews } from "@/app/home/_goals";
import type { Schemas } from "@/lib/api/client";
import { calendarDay } from "@/lib/dates";

/**
 * Simple's Home (#723 S1, the owner's "Brief as cards" pick): what the goal band, the summary
 * card and the plan strip derive from the reads the stack serves (the baseline's goals,
 * GET /v1/simple/roadmap, the Inbox, the change engine's changes and drafts). Pure: the page
 * loads, this decides.
 */

type Entity = Schemas["EntityOut"];
type Roadmap = Schemas["SimpleRoadmapOut"];
type Item = Schemas["SimpleRoadmapItem"];

export type GoalStatus = "At risk" | "Not measured yet" | "Not counted yet" | "Planned";

export type GoalTile = {
  id: string;
  code: string;
  name: string;
  weight: number | null;
  /** The metric's target path: start, current (when measured), target ("50 -> 100 -> 200"). */
  path: string | null;
  status: GoalStatus;
  /** Why it is at risk, in one line (the first broken link or missed milestone). */
  why: string | null;
  guardrail: boolean;
  /** Items serving it that wait on the signed-in person (a proposal they decide, a broken link). */
  needYou: number;
};

const COUNTED = /^[a-z][a-z -]{0,23}$/;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function figure(v: number, unit: string): string {
  if (unit === "%") return `${v}%`;
  if (unit === "USD") return `$${v}`;
  if (unit === "EUR") return `€${v}`;
  if (unit === "GBP") return `£${v}`;
  if (["ms", "s", "min", "h", "days"].includes(unit)) return `${v} ${unit}`;
  return `${v}`;
}

/** "50 -> 100 -> 200": the start, the measured value and the target, those the goal has. */
export function targetPath(attrs: Record<string, unknown>): string | null {
  const unit = typeof attrs.unit === "string" ? attrs.unit : "";
  const target = num(attrs.target);
  if (target == null) return typeof attrs.target_text === "string" ? attrs.target_text : null;
  const steps = [num(attrs.start), num(attrs.current), target].filter((v): v is number => v != null);
  return steps.map((v) => figure(v, unit)).join(" -> ");
}

/** A broken dependency (red, not accepted as a risk) or a milestone past its date and not done. */
export function itemAtRisk(item: Item, today: string): string | null {
  const broken = item.flags.find((f) => f.state === "red" && f.kind === "dependency_order");
  if (broken) return broken.reason;
  const m = item.milestone;
  if (m?.date && m.date < today && item.status !== "done" && item.status !== "cut") return `Missed its milestone${m.name ? ` '${m.name}'` : ""}`;
  return null;
}

/** The goal band: one tile per confirmed top-level goal, heaviest first, then by key. */
export function goalTiles(goals: Entity[], roadmap: Roadmap | undefined, waiting: Set<string>): GoalTile[] {
  const today = roadmap?.today ?? "";
  const confirmed = goals.filter((g) => g.type === "goal" && g.status === "confirmed");
  const byId = new Map(confirmed.map((g) => [g.id, g]));
  return goalViews(confirmed)
    .filter((v) => !v.parentId)
    .map((v) => {
      const a = (byId.get(v.id)?.attrs ?? {}) as Record<string, unknown>;
      const items = (roadmap?.items ?? []).filter((i) => i.goal?.id === v.id && i.status !== "cut");
      const why = items.map((i) => itemAtRisk(i, today)).find(Boolean) ?? null;
      const measured = num(a.current) != null;
      const unit = typeof a.unit === "string" ? a.unit : "";
      const counted = !!unit && COUNTED.test(unit) && !["ms", "s", "min", "h", "days"].includes(unit);
      const status: GoalStatus = why ? "At risk" : measured ? "Planned" : counted ? "Not counted yet" : a.metric || a.target != null ? "Not measured yet" : "Planned";
      return {
        id: v.id,
        code: v.code ?? v.tag,
        name: v.name,
        weight: num(a.weight),
        path: targetPath(a),
        status,
        why,
        guardrail: a.guardrail === true || a.kind === "guardrail",
        needYou: items.filter((i) => waiting.has(i.id)).length,
      };
    });
}

/** The broken links on the roadmap: one row per red dependency flag. */
export type BrokenLink = { item: Item; flag: Schemas["SimpleFlag"]; dependency: Item | undefined };

export function brokenLinks(roadmap: Roadmap | undefined): BrokenLink[] {
  if (!roadmap) return [];
  const byId = new Map(roadmap.items.map((i) => [i.id, i]));
  return roadmap.items.flatMap((item) =>
    item.flags
      .filter((f) => f.state === "red" && f.kind === "dependency_order")
      .map((flag) => ({ item, flag, dependency: flag.subject ? byId.get(flag.subject) : undefined })),
  );
}

const DAY = 86_400_000;
const ms = (day: string) => Date.parse(`${day}T00:00:00Z`);

export type StripMonth = { label: string; left: number; width: number };
export type StripBar = { item: Item; left: number; width: number; estimated: boolean; past: boolean; broken: boolean };
export type Strip = {
  months: StripMonth[];
  bars: StripBar[];
  milestones: { name: string; left: number }[];
  today: number | null;
  /** Commitments that end after the strip's last day. */
  pastEdge: number;
};

/**
 * The plan this quarter as a strip: the items of the quarter's window (the "now" horizon) by
 * month, estimated (undated) bars hatched, milestones marked, today's line, and how many
 * commitments end past the edge. Positions are percentages of the window.
 */
export function planStrip(roadmap: Roadmap | undefined): Strip | null {
  if (!roadmap) return null;
  const { start, end } = roadmap.windows.now;
  const from = ms(start);
  const to = ms(end) + DAY;
  const pct = (day: string) => Math.max(0, Math.min(100, ((ms(day) - from) / (to - from)) * 100));
  const months: StripMonth[] = [];
  for (let d = new Date(from); d.getTime() < to; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const next = Math.min(to, Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    months.push({
      label: calendarDay(d.toISOString(), { month: "short" }),
      left: ((d.getTime() - from) / (to - from)) * 100,
      width: ((next - d.getTime()) / (to - from)) * 100,
    });
  }
  const items = roadmap.items.filter((i) => i.status !== "cut" && i.start.date <= end && i.end.date >= start);
  const bars = items.map((item) => {
    const left = pct(item.start.date);
    return {
      item,
      left,
      width: Math.max(2, pct(item.end.date) - left),
      estimated: item.estimated || item.start.estimated,
      past: item.end.date > end,
      broken: item.flags.some((f) => f.state === "red" && f.kind === "dependency_order"),
    };
  });
  const milestones = roadmap.milestones
    .filter((m) => m.date && m.date >= start && m.date <= end)
    .map((m) => ({ name: m.name, left: pct(m.date!) }));
  for (const i of items) {
    if (i.milestone?.date && i.milestone.source === "item" && i.milestone.date >= start && i.milestone.date <= end && !milestones.some((m) => m.name === i.milestone!.name)) {
      milestones.push({ name: i.milestone.name ?? "Milestone", left: pct(i.milestone.date) });
    }
  }
  const t = roadmap.today;
  return {
    months,
    bars,
    milestones,
    today: t >= start && t <= end ? pct(t) : null,
    pastEdge: bars.filter((b) => b.past && !b.estimated).length,
  };
}

/** "Good morning" by the hour of the Company's day. */
export function greeting(hour: number): string {
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

/** One sentence on what waits: "2 decisions and 1 proposal wait on you." */
export function waitSentence(parts: [number, string, string][]): string {
  const shown = parts.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  if (shown.length === 0) return "Nothing waits on you today.";
  const list = shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
  const total = parts.reduce((s, [n]) => s + n, 0);
  return `${list} ${total === 1 ? "waits" : "wait"} on you.`;
}

/** What a Simple change does, in Simple's words ("Move dates", "Retitle"). */
export const OP_WORDS: Record<string, string> = {
  move_dates: "Move dates",
  change_horizon: "Move to another horizon",
  reorder: "Reorder",
  cut: "Cut",
  restore: "Restore",
  edit_title: "Retitle",
  edit_outcome: "Change the outcome",
  accept_date_suggestion: "Accept suggested dates",
  accept_risk: "Accept as a risk",
  shift_dependents: "Move dependents",
  move_dependency: "Move dependency",
  override_priority: "Change the priority",
  add_item: "Add an item",
  merge_item: "Merge a duplicate",
  keep_both: "Keep both",
  add_item_task: "Add a task",
  edit_item_task: "Change a task",
  set_item_task_status: "Set a task's status",
  add_action_item: "Add an action item",
  edit_action_item: "Change an action item",
  set_action_item_status: "Set an action item's status",
  add_launch_task: "Add a launch task",
  set_launch_task_status: "Set a launch task's status",
};

const LINE_FIELDS = ["title", "outcome", "start_date", "end_date", "horizon"];

/** A line edit's before and after ("Mar 3 – Apr 1" → "Mar 10 – Apr 8"), when the change is one. */
export function beforeAfter(c: Pick<Schemas["SimpleChangeOut"], "before" | "after">): { before: string; after: string } | null {
  const b = c.before as Record<string, unknown>;
  const a = c.after as Record<string, unknown>;
  const keys = LINE_FIELDS.filter((k) => k in a);
  if (keys.length === 0) return null;
  const show = (v: Record<string, unknown>) =>
    "start_date" in a ? `${v.start_date ?? "undated"} – ${v.end_date ?? "undated"}` : keys.map((k) => String(v[k] ?? "—")).join(" · ");
  return { before: show(b), after: show(a) };
}

/** A proposal that adds a new flow or feature (S10's visuals): an added item, task or launch task. */
export const NEW_FLOW_OPS = new Set(["add_item_task", "add_launch_task", "add_action_item", "add_item"]);
