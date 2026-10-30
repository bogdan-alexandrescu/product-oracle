import { goalViews } from "@/app/home/_goals";
import type { Schemas } from "@/lib/api/client";

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

/** A number with the reader's locale grouping ("50,000"). */
export function grouped(v: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(v);
}

export function figure(value: number, unit: string, locale?: string): string {
  const v = grouped(value, locale);
  if (unit === "%") return `${v}%`;
  if (unit === "USD") return `$${v}`;
  if (unit === "EUR") return `€${v}`;
  if (unit === "GBP") return `£${v}`;
  if (["ms", "s", "min", "h", "days"].includes(unit)) return `${v} ${unit}`;
  return `${v}`;
}

/**
 * The goal's target in words, each figure with its unit (H1: never a bare number): "From 50
 * teams · now 100 teams · target 200 teams with weekly alerts on" (the metric names a counted
 * unit's target when it starts with that unit; with no unit, each figure reads with the metric).
 */
export function targetPath(attrs: Record<string, unknown>): string | null {
  const unit = typeof attrs.unit === "string" ? attrs.unit : "";
  const target = num(attrs.target);
  if (target == null) return typeof attrs.target_text === "string" ? attrs.target_text : null;
  const metric = typeof attrs.metric === "string" ? attrs.metric.trim() : "";
  // With no unit, each figure reads with the metric ("10 teams muting alerts"), never bare.
  const plain = (v: number) =>
    !unit && metric ? `${grouped(v)} ${metric}` : unit && !["%", "USD", "EUR", "GBP", "ms", "s", "min", "h", "days"].includes(unit) ? `${grouped(v)} ${unit}` : figure(v, unit);
  const goal = unit && metric.toLowerCase().startsWith(`${unit.toLowerCase()} `) ? `${grouped(target)} ${metric}` : plain(target);
  const start = num(attrs.start);
  const current = num(attrs.current);
  const steps = [start != null ? `from ${plain(start)}` : null, current != null ? `now ${plain(current)}` : null, `target ${goal}`].filter((x): x is string => !!x);
  const words = steps.join(" · ");
  return words.charAt(0).toUpperCase() + words.slice(1);
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

/**
 * The broken links on the roadmap: one row per red flag that has a one-click fix (a
 * dependency out of order, a blocker due late, an end past its milestone, a cut item others
 * depend on; a draft with no owner has no fix, so it is not one), on every item, whoever
 * decides it (its fixes say Propose for the others). The one definition: "Walk me through
 * it" (GET /v1/simple/walk, oracle.simple.chat.broken_links, and its mock) walks the same.
 */
export type BrokenLink = { item: Item; flag: Schemas["SimpleFlag"]; dependency: Item | undefined };

export const isBrokenLink = (f: Schemas["SimpleFlag"]): boolean => f.state === "red" && f.fixes.length > 0;

export function brokenLinks(roadmap: Roadmap | undefined): BrokenLink[] {
  if (!roadmap) return [];
  const byId = new Map(roadmap.items.map((i) => [i.id, i]));
  return roadmap.items.flatMap((item) =>
    item.flags
      .filter(isBrokenLink)
      .map((flag) => ({ item, flag, dependency: flag.subject ? byId.get(flag.subject) : undefined })),
  );
}

const DAY = 86_400_000;

export type PlanStrip = Schemas["SimplePlanStrip"];
export type PlanInput = {
  start: string;
  end: string;
  estimated: boolean;
  milestone: string | null;
  milestoneDate: string | null;
  /** The day the plan starts the milestone, when the PRD dates it (a plan's M1 2 Nov - 27 Nov). */
  milestoneStart?: string | null;
  /** The milestone record the item links (a track milestone), when any: its row. */
  record?: { id: string; name: string | null } | null;
};

/** The plan strip shows this many rows; the rest are "+N more on the roadmap". */
export const PLAN_ROWS = 8;
const PLAN_MONTHS = 6;
const monthOf = (day: string) => `${day.slice(0, 7)}-01`;
function addMonths(first: string, n: number): string {
  const d = new Date(`${first}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)).toISOString().slice(0, 10);
}
const monthsBetween = (a: string, b: string) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7)) + 1;
const minOf = (xs: string[]) => xs.reduce((a, b) => (b < a ? b : a));
const maxOf = (xs: string[]) => xs.reduce((a, b) => (b > a ? b : a));

/**
 * The plan strip (the owner's pick after CLD's production walk, 2026-10-27): a PRD's span by
 * month with its milestones, today's line and how many commitments end past the edge; one
 * row per milestone, the items with no milestone summed in one row. The same rules as the
 * API's oracle.simple.plan_strip.strip (the one-pager and its PDF): from the month of the
 * earliest start (or milestone) to the month of the latest milestone (with none dated, the
 * latest committed end, else the latest end), at most 6 months.
 */
/** Strings in code point order, as Python sorts them (the API's strip). */
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// M1..M99: "M1.5 · X" and "M2026 roadmap" are texts, not codes.
const MILESTONE_CODE = /^(M\d{1,2})(?![\w.])\s*[·:\-–—]?\s*(.*)$/i;

/**
 * A milestone text's group key and its row label, as the API's plan_strip.milestone_of
 * (CLD's production walk, 2026-10-27: real texts carry notes): its code (M1, M2, ...), else
 * the text before the first " (" or ";". "M1 · Measure it (a note); more" -> ["M1", "M1 ·
 * Measure it"]; empty -> "Milestone".
 */
export function milestoneOf(text: string | null): [string, string] {
  const head = (text ?? "").trim().split(" (")[0].split(";")[0].split(/\s+/).filter(Boolean).join(" ");
  const m = MILESTONE_CODE.exec(head);
  if (m) {
    const code = m[1].toUpperCase();
    const name = m[2].trim();
    return [code, name ? `${code} · ${name}` : code];
  }
  return head ? [head, head] : ["Milestone", "Milestone"];
}

export function planByMonth(items: PlanInput[], today: string, through: string | null = null): PlanStrip | null {
  if (items.length === 0) return null;
  // One row per milestone (the record the item links, else its code, else its text before
  // any note), not per text.
  const keyed = new Map<string, { label: string; i: PlanInput }[]>();
  const loose: PlanInput[] = [];
  for (const i of items) {
    if (!i.record && !i.milestone && !i.milestoneDate) {
      loose.push(i);
      continue;
    }
    const [key, label] = i.record ? [`record:${i.record.id}`, milestoneOf(i.record.name)[1]] : milestoneOf(i.milestone);
    keyed.set(key, [...(keyed.get(key) ?? []), { label, i }]);
  }
  const groups = new Map<string, { name: string; date: string | null; begins: string | null; of: PlanInput[] }>();
  for (const [key, of] of keyed) {
    const counts = new Map<string, number>();
    for (const x of of) counts.set(x.label, (counts.get(x.label) ?? 0) + 1);
    // A named label ("M4 · Rollout") before the bare code ("M4"), then the commonest.
    const name = [...counts].sort((a, b) => Number(a[0] === key) - Number(b[0] === key) || b[1] - a[1] || byCodePoint(a[0], b[0]))[0][0];
    const dates = of.flatMap((x) => (x.i.milestoneDate ? [x.i.milestoneDate] : []));
    const date = dates.length ? maxOf(dates) : null;
    // A dated plan milestone (the PRD dates it): its row spans its start to its end.
    const starts = of.flatMap((x) => (x.i.milestoneStart ? [x.i.milestoneStart] : []));
    groups.set(`${name}|${date ?? ""}`, { name, date, begins: starts.length ? minOf(starts) : null, of: of.map((x) => x.i) });
  }
  const dated = [...groups.values()].flatMap((g) => (g.date ? [g.date] : []));
  const committed = items.filter((i) => !i.estimated).map((i) => i.end);
  const begins = items.flatMap((i) => (i.milestoneStart ? [i.milestoneStart] : []));
  const first = minOf([...items.map((i) => i.start), ...dated, ...begins]);
  const last = dated.length ? maxOf(dated) : maxOf(committed.length ? committed : items.map((i) => i.end));
  let start = monthOf(first);
  // qa-simple-home-17: Home's strip runs to the end of the quarter (`through`), each month labelled.
  const lastMonth = monthOf([last > first ? last : first, ...(through ? [through] : [])].sort().at(-1)!);
  let n = monthsBetween(start, lastMonth);
  if (n > PLAN_MONTHS) {
    const anchor = minOf([addMonths(monthOf(today), -1), addMonths(lastMonth, 1 - PLAN_MONTHS)]);
    start = anchor > start ? anchor : start;
    n = Math.min(PLAN_MONTHS, monthsBetween(start, lastMonth));
  }
  const months = Array.from({ length: n }, (_, k) => addMonths(start, k));
  const end = new Date(Date.parse(`${addMonths(months.at(-1)!, 1)}T00:00:00Z`) - DAY).toISOString().slice(0, 10);
  const row = (name: string, date: string | null, of: PlanInput[], milestone: boolean, begins: string | null = null): PlanStrip["rows"][number] => ({
    name,
    date,
    items: of.length,
    start: begins && date ? begins : minOf(of.map((i) => i.start)),
    end: begins && date ? date : maxOf(of.map((i) => i.end)),
    estimated: begins && date ? false : of.every((i) => i.estimated),
    milestone,
    past_edge: !!date && date > end,
  });
  const rows = [...groups.values()]
    .sort((a, b) => (a.date === null) !== (b.date === null) ? (a.date === null ? 1 : -1) : byCodePoint(a.date ?? "", b.date ?? "") || byCodePoint(a.name, b.name))
    .map((g) => row(g.name, g.date, g.of, true, g.begins));
  if (loose.length) rows.push(row("No milestone", null, loose, false));
  return {
    start,
    end,
    months,
    today: today >= start && today <= end ? today : null,
    rows,
    past_edge: items.filter((i) => !i.estimated && i.end > end).length,
  };
}

/** A roadmap item as the plan strip reads it: one input per slice when the plan slices it
 * (each in its milestone, dated by the PRD's plan), else the item itself. */
export const planInputs = (i: Item): PlanInput[] =>
  (i.slices ?? []).length
    ? i.slices.map((s) => ({
        start: s.start_date ?? i.start.date,
        end: s.end_date ?? i.end.date,
        estimated: !(s.milestone_start && s.milestone_end),
        milestone: `${s.milestone} · ${s.milestone_name}`,
        milestoneDate: s.milestone_end ?? null,
        milestoneStart: s.milestone_start ?? null,
      }))
    : [planInput(i)];

/** A roadmap item (with no slices) as the plan strip reads it. */
export const planInput = (i: Item): PlanInput => ({
  start: i.start.date,
  end: i.end.date,
  estimated: i.estimated,
  milestone: i.milestone ? i.milestone.name || "Milestone" : null,
  milestoneDate: i.milestone?.date ?? null,
  record: i.milestone?.record_id ? { id: i.milestone.record_id, name: i.milestone.record_name ?? null } : null,
});

/**
 * Home's plan: the PRD in play (the only PRD with items this quarter), or the top PRD by
 * priority when several (its best-ranked item), else the one with most items this quarter.
 * With several and the ranking not read yet (`ranked` null), undefined: Home waits for it.
 */
export function prdInPlay(roadmap: Roadmap | undefined, ranked: (string | null | undefined)[] | null = []): Schemas["SimpleDocRef"] | null | undefined {
  if (!roadmap) return null;
  const { start, end } = roadmap.windows.now;
  const now = roadmap.items.filter((i) => i.prd && i.status !== "cut" && i.start.date <= end && i.end.date >= start);
  const prds = new Map<string, { prd: Schemas["SimpleDocRef"]; n: number }>();
  for (const i of now) {
    const p = prds.get(i.prd!.id) ?? { prd: i.prd!, n: 0 };
    p.n += 1;
    prds.set(i.prd!.id, p);
  }
  if (prds.size <= 1) return [...prds.values()][0]?.prd ?? null;
  // Several: the ranking picks; with none yet (null), undefined: wait for it.
  if (ranked === null) return undefined;
  const byItem = new Map(roadmap.items.map((i) => [i.id, i]));
  for (const id of ranked) {
    const prd = id ? byItem.get(id)?.prd : null;
    if (prd && prds.has(prd.id)) return prd;
  }
  return [...prds.values()].sort((a, b) => b.n - a.n || a.prd.title.localeCompare(b.prd.title))[0].prd;
}

/** "Good morning" by the hour of the Company's day. */
export function greeting(hour: number): string {
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

/**
 * One sentence on what waits, by name: "Decisions and a broken link wait on you." The counts
 * are the summary tiles' alone (qa-simple-home-15), so the sentence does not repeat them.
 */
export function waitSentence(parts: [number, string, string][]): string {
  const shown = parts.filter(([n]) => n > 0).map(([n, one, many]) => (n === 1 ? `a ${one}` : many));
  if (shown.length === 0) return "Nothing waits on you today.";
  const list = shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
  const total = parts.reduce((s, [n]) => s + n, 0);
  return `${list[0].toUpperCase()}${list.slice(1)} ${total === 1 ? "waits" : "wait"} on you.`;
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
  shift_dependents: "Move the dependents",
  move_dependency: "Move the dependency",
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
  estimate_feature: "Estimate value and effort",
  confirm_item: "Confirm the item",
  edit_line: "Edit a one-pager line",
  add_key_date: "Add a key date",
  edit_key_date: "Change a key date",
  remove_key_date: "Remove a key date",
  set_milestone: "Set a milestone",
  add_feature_ask: "File a feature ask",
};

/** What happened, in plain words, before the item it happened to (Home's "Since your last visit"). */
const DONE_WORDS: Record<string, string> = {
  move_dates: "Dates moved for",
  change_horizon: "Horizon changed for",
  reorder: "Reordered",
  cut: "Cut",
  restore: "Restored",
  edit_title: "Retitled",
  edit_outcome: "Outcome changed for",
  accept_date_suggestion: "Suggested dates accepted for",
  accept_risk: "Risk accepted on",
  shift_dependents: "Dependents moved after",
  move_dependency: "Dependency moved for",
  override_priority: "Priority changed for",
  add_item_task: "Task added to",
  edit_item_task: "Task changed on",
  set_item_task_status: "Task status set on",
  add_action_item: "Action item added",
  edit_action_item: "Action item changed",
  set_action_item_status: "Action item status set",
  add_launch_task: "Launch task added to",
  set_launch_task_status: "Launch task status set on",
  estimate_feature: "Effort estimated for",
  confirm_item: "Confirmed",
  edit_line: "One-pager line edited",
  add_key_date: "Key date added",
  edit_key_date: "Key date changed",
  remove_key_date: "Key date removed",
  add_item: "Added",
  merge_item: "Merged",
  keep_both: "Kept beside its look-alike:",
  set_milestone: "Milestone set for",
  add_feature_ask: "Feature ask filed:",
};

/**
 * The walk: a change as Home's "Since your last visit" says it, in plain words, never the op's
 * internal name: "Effort estimated for F-08 Conversion attribution v0". `item` is the item it
 * changed (its PRD code and title) when the reader sees it.
 */
export function changeWords(c: Pick<Schemas["SimpleChangeOut"], "op" | "after" | "target">, item: { code?: string | null; title: string } | null | undefined): string {
  const after = (c.after ?? {}) as Record<string, unknown>;
  let lead = DONE_WORDS[c.op] ?? "Changed";
  if (c.op === "estimate_feature") {
    const value = "goal_value" in after;
    const effort = "effort" in after;
    lead = value && effort ? "Value and effort estimated for" : value ? "Value estimated for" : "Effort estimated for";
  }
  const named = typeof after.title === "string" ? after.title : typeof after.name === "string" ? after.name : null;
  const subject = item ? `${item.code ? `${item.code} ` : ""}${item.title}` : named;
  return subject ? `${lead} ${subject}` : lead.replace(/ (for|to|on|after|beside its look-alike):?$|:$/, "");
}

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
