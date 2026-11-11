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
  /** The goal's own key (a Priorities row's goal.key): a card filters by it, never by the name two goals may share. */
  key: string;
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

/** The goal band: one tile per confirmed top-level goal, in the one goal order (lib/goal-order.ts). */
export function goalTiles(goals: Entity[], roadmap: Roadmap | undefined, waiting: Set<string>): GoalTile[] {
  const today = roadmap?.today ?? "";
  const confirmed = goals.filter((g) => g.type === "goal" && g.status === "confirmed");
  const byId = new Map(confirmed.map((g) => [g.id, g]));
  return goalViews(confirmed)
    .filter((v) => !v.parentId)
    .map((v) => {
      const a = (byId.get(v.id)?.attrs ?? {}) as Record<string, unknown>;
      // roadmap-done: a done item is off the plan; it puts no goal at risk.
      const items = (roadmap?.items ?? []).filter((i) => i.goal?.id === v.id && i.status !== "cut" && i.status !== "done");
      const why = items.map((i) => itemAtRisk(i, today)).find(Boolean) ?? null;
      const measured = num(a.current) != null;
      const unit = typeof a.unit === "string" ? a.unit : "";
      const counted = !!unit && COUNTED.test(unit) && !["ms", "s", "min", "h", "days"].includes(unit);
      const status: GoalStatus = why ? "At risk" : measured ? "Planned" : counted ? "Not counted yet" : a.metric || a.target != null ? "Not measured yet" : "Planned";
      return {
        id: v.id,
        key: byId.get(v.id)?.key ?? v.id,
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
 * depend on; a draft with no owner has no fix, so it is not one), on the working draft as the
 * reader sees it, on every item, whoever decides it (its fixes say Propose for the others). The
 * one definition for Home, the walk and the one waiting list (qa-simple-home-3): "Walk me through
 * it" (GET /v1/simple/walk, oracle.simple.chat.broken_links, and its mock) walks the same, and
 * Decisions lists the ones I decide (waiting_list._roadmap). The Roadmap page splits them into
 * its broken links between items and its other flags (fix4 qa-simple-roadmap-8, qa4-simple-roadmap-38).
 */
export type BrokenLink = { item: Item; flag: Schemas["SimpleFlag"]; dependency: Item | undefined };

export const isBrokenLink = (f: Schemas["SimpleFlag"]): boolean => f.state === "red" && f.fixes.length > 0;

/** The dates an item stores (typed or accepted), as the change engine compares them; null for the others. */
export function storedDates(i: Item): { start_date: string | null; end_date: string | null } {
  const own = (d: Schemas["SimpleDate"]) => (d.source === "typed" || d.source === "accepted" ? d.date : null);
  return { start_date: own(i.start), end_date: own(i.end) };
}

/** A broken link's one-click fixes (Home's broken-links card, Decisions' broken-link rows). */
export type FixOp = "shift_dependents" | "move_dependency" | "accept_risk";

/** A broken link's fix as one change through the engine (POST /v1/simple/changes). */
export function fixChange(b: BrokenLink, op: FixOp, note = ""): Schemas["SimpleChangeIn"] {
  const dep = b.dependency;
  return op === "accept_risk"
    ? { op, target: { item_id: b.item.id, flag: b.flag.kind, subject: b.flag.subject }, before: { risk: null }, after: { risk: { note: note.trim() } } }
    : { op, target: { item_id: b.item.id, subject: b.flag.subject }, before: { [b.item.id]: storedDates(b.item), ...(dep ? { [dep.id]: storedDates(dep) } : {}) } };
}

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

/** `of` (Home only): whose a row's milestone is, for its accessible name when two rows read alike;
 * `also` (Home only): the other names of the milestones folded into its row ("M1 Measured and mapped");
 * `ms` (Home only, home-milestone-rename): the roadmap's own milestone the row renames, by id. */
export type PlanStrip = Omit<Schemas["SimplePlanStrip"], "rows"> & { rows: (Schemas["SimplePlanStrip"]["rows"][number] & { of?: string | null; also?: string[]; ms?: string })[] };
export type PlanInput = {
  start: string;
  end: string;
  estimated: boolean;
  milestone: string | null;
  milestoneDate: string | null;
  /** The day the plan starts the milestone, when the PRD dates it (a plan's M1 2 Nov - 27 Nov). */
  milestoneStart?: string | null;
  /** The milestone record the item links (a track milestone), when any: its row; `label`, when
   * given, is the row's name as is (Home: the current milestone's code and name, whole); `of`,
   * whose it is (its PRD's or goal's name), tells two rows that read alike apart to a screen reader;
   * `also`, the other names folded into its row (Home). */
  record?: { id: string; name: string | null; label?: string; of?: string | null; also?: string[]; ms?: string } | null;
  /** The roadmap item it reads (the one-pager lists a row's items by it). */
  id?: string | null;
  /** roadmap-milestone-codes: its milestone's roadmap-wide code (the one-pager, `coded`). */
  roadmapCode?: string | null;
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

/** plan_strip._named: a row's label by its roadmap code ("M1 · Beta" in M2 -> "M2 · Beta"), its name alone with none. */
function namedBy(label: string, code: string | null | undefined): string {
  const m = MILESTONE_CODE.exec(label);
  const name = m ? m[2].trim() : label;
  if (code) return name ? `${code} · ${name}` : code;
  return name || label;
}

/** `coded` (the one-pager, plan_strip.strip(coded=True)): rows read each input's roadmap code, one row per code. */
export function planByMonth(items: PlanInput[], today: string, through: string | null = null, coded = false): PlanStrip | null {
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
    let [key, label] = i.record ? [`record:${i.record.id}`, i.record.label ?? milestoneOf(i.record.name)[1]] : milestoneOf(i.milestone);
    if (coded) {
      key = i.roadmapCode ? `code:${i.roadmapCode}` : `name:${key}`;
      label = namedBy(label, i.roadmapCode);
    }
    keyed.set(key, [...(keyed.get(key) ?? []), { label, i }]);
  }
  const groups = new Map<string, { name: string; date: string | null; begins: string | null; of: PlanInput[]; whose: string | null; also: string[]; code?: string | null; ms?: string }>();
  for (const [key, of] of keyed) {
    const counts = new Map<string, number>();
    for (const x of of) counts.set(x.label, (counts.get(x.label) ?? 0) + 1);
    // A named label ("M4 · Rollout") before the bare code ("M4"), a record's too, then the commonest.
    const bare = (label: string) => Number(/^M\d{1,2}$/i.test(label.trim()));
    const named = [...counts].sort((a, b) => bare(a[0]) - bare(b[0]) || b[1] - a[1] || byCodePoint(a[0], b[0]))[0][0];
    // A record named only by its code ("M2") reads the name its own items give that code
    // (vqa one-pager 3, as plan_strip.strip), never another record's; `coded`, read by its
    // roadmap code (the roadmap code decides the row, the items' name its label).
    const said = new Map<string, number>();
    for (const x of of) {
      const raw = milestoneOf(x.i.milestone)[1];
      const label = coded ? namedBy(raw, x.i.roadmapCode) : raw;
      if (label !== named && (milestoneOf(label)[0] === named || milestoneOf(raw)[0] === named)) said.set(label, (said.get(label) ?? 0) + 1);
    }
    const name = said.size ? [...said].sort((a, b) => b[1] - a[1] || byCodePoint(a[0], b[0]))[0][0] : named;
    const dates = of.flatMap((x) => (x.i.milestoneDate ? [x.i.milestoneDate] : []));
    const date = dates.length ? maxOf(dates) : null;
    // A dated plan milestone (the PRD dates it): its row spans its start to its end.
    const starts = of.flatMap((x) => (x.i.milestoneStart ? [x.i.milestoneStart] : []));
    // A record's row is its own (two PRDs' "M1 · Launch" on one date are two rows).
    const whose = of.find((x) => x.i.record?.of)?.i.record?.of ?? null;
    // Names its items' records read beside the row's own (a track's on two roadmaps), the row's own never.
    const also = [...new Set(of.flatMap((x) => x.i.record?.also ?? []))].filter((n) => !sameWords(n, name.replace(" · ", " ")));
    const ms = of.find((x) => x.i.record?.ms)?.i.record?.ms;
    // Each record (or code) is its own row: two records sharing a name and date stay two.
    groups.set(key, { name, date, begins: starts.length ? minOf(starts) : null, of: of.map((x) => x.i), whose, also, code: coded ? (of[0].i.roadmapCode ?? null) : undefined, ms });
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
  const row = (name: string, date: string | null, of: PlanInput[], milestone: boolean, begins: string | null = null, whose: string | null = null, also: string[] = [], code?: string | null, ms?: string): PlanStrip["rows"][number] => ({
    name,
    date,
    items: of.length,
    start: begins && date ? begins : minOf(of.map((i) => i.start)),
    end: begins && date ? date : maxOf(of.map((i) => i.end)),
    estimated: begins && date ? false : of.every((i) => i.estimated),
    milestone,
    past_edge: !!date && date > end,
    item_ids: [...new Set(of.flatMap((i) => (i.id ? [i.id] : [])))],
    ...(whose ? { of: whose } : {}),
    ...(also.length ? { also } : {}),
    ...(coded ? { code: code ?? null } : {}),
    ...(ms ? { ms } : {}),
  });
  const rows = [...groups.values()]
    .sort((a, b) => (a.date === null) !== (b.date === null) ? (a.date === null ? 1 : -1) : byCodePoint(a.date ?? "", b.date ?? "") || byCodePoint(a.name, b.name))
    .map((g) => row(g.name, g.date, g.of, true, g.begins, g.whose, g.also, g.code, g.ms));
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
        id: i.id,
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
  id: i.id,
});

/** A name wrapped whole in one pair of brackets ("[Launch (beta)]", "(Pilot)"): its words inside. */
const unwrap = (name: string) => {
  const m = /^([[(])(.*)([\])])$/.exec(name);
  if (!m || (m[1] === "[") !== (m[3] === "]")) return name;
  // "(Launch) (beta)" is two pairs, not one round it.
  let depth = 0;
  for (const c of m[2]) {
    depth += c === "(" || c === "[" ? 1 : c === ")" || c === "]" ? -1 : 0;
    if (depth < 0) return name;
  }
  return depth === 0 ? m[2].trim() : name;
};

/** A milestone's name as a person reads it, whole: its code and name ("M1 · Launch (beta)"), its
 * code alone when it has no name ("M2"), never "Milestone M2" nor "M3 · "; a name wrapped in
 * brackets reads without them, and one that repeats its code ("M2 · Pilot") reads it once. */
const wholeName = (code: string | null, name: string) => {
  let n = name.trim().split(/\s+/).filter(Boolean).join(" ");
  const own = MILESTONE_CODE.exec(n);
  if (own && (!code || own[1].toUpperCase() === code)) {
    code = own[1].toUpperCase();
    n = own[2].trim();
  }
  n = unwrap(n);
  return code ? (n ? `${code} · ${n}` : code) : n || "Milestone";
};
/** A roadmap's own (goal) milestone's name, whole: "M2 · Pilot", "M3" with no name (never "M3 · ");
 * its code the roadmap's one (roadmap-milestone-codes), else its own. */
export const goalMilestoneName = (m: { code: string; roadmap_code?: string | null; name: string }) => wholeName((m.roadmap_code ?? m.code).trim().toUpperCase() || null, m.name);
const sameWords = (a: string, b: string) => a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * home-milestones-current: Home's plan inputs, each item (not cut) in the roadmap's current
 * milestone, dated or not, a dropped one never (nor a PRD's plan milestone, its start and end
 * dated): the roadmap milestone picked in its panel (by
 * id) or naming it, else the track milestone naming it or its record, else the current milestone
 * its typed text names by code ("M1") or name (its roadmap's, then its track's), else its
 * track's first dated one it ends on or before. Each row reads that milestone's own code and
 * name, whole. An item whose milestone is gone (removed, renamed away, or a text no current
 * milestone has) is in none: "Not in a milestone". A PRD's plan slices are not read
 * (home-waiting-one-list: never one PRD's plan milestones).
 *
 * home-milestones-whole (reviews of PRs 1424 and 1439): one row per milestone: a roadmap's own
 * milestones of one goal, code (and PRD) are one row; a track milestone is one row wherever its
 * items sit, and a roadmap's own milestone joins it when the API gives both one roadmap code (oracle.simple.roadmap_codes: their names
 * match, whatever else of the code is there, the owner's "Join whenever names match" of Nov 9;
 * one of no goal, the one track of its code on its roadmap). The row shows the longer name (its
 * date, else the earliest joined one's) and its (i) lists each other name once ("Also: M1
 * Measured"; no name is ever hidden); a typed text
 * or bare code is read on the item's own roadmap (the read's roadmap's when its own has none),
 * never the first roadmap that has it, nor a guess between two goals'.
 *
 * home-milestones-own-roadmap (production regression from PR 1439): a typed code is its own
 * goal's milestone, else its track's, else its roadmap's own (a track one there, or one of no
 * goal), as Priorities shows the item in that code; never another goal's while one of these is.
 * Another track's only when it is the one track of the roadmap with that code (review of PR 1453:
 * of two tracks' "M1", never a guess).
 */
export function homePlanInputs(data: Roadmap): PlanInput[] {
  // milestone-kinds: a goal's own target date (goal_target) lists the goal's features but holds
  // none of them: they stay in the milestones they are placed in.
  const goals = (data.goal_milestones ?? []).filter((m) => !m.goal_target);
  const live = new Map(goals.map((m) => [m.id, m]));
  // A milestone with a start and an end is a PRD's plan milestone, never read here.
  const tracks = data.milestones.filter((m) => m.status !== "dropped" && !(m.start_date && m.end_date));
  const codeOf = (name: string) => MILESTONE_CODE.exec(name.trim())?.[1].toUpperCase() ?? null;
  const restOf = (name: string) => (codeOf(name) ? MILESTONE_CODE.exec(name.trim())![2] : name);
  type Gm = (typeof goals)[number];
  type Tm = (typeof tracks)[number];
  const goalCode = (gm: Gm) => gm.code.trim().toUpperCase() || codeOf(gm.name);
  // A track is on the roadmaps of the items in it.
  const roadmapsOf = new Map<string, Set<string>>();
  const onto = (track: string, roadmap: string) => roadmapsOf.set(track, (roadmapsOf.get(track) ?? new Set()).add(roadmap));
  for (const i of data.items) if (i.track) onto(i.track.id, i.roadmap.id);
  for (const m of tracks) for (const i of data.items) if (m.item_ids.includes(i.id)) onto(m.track_id, i.roadmap.id);
  // A goal's and a track's title, as any item names it (a milestone carries only their ids).
  const goalTitles = new Map(data.items.flatMap((i) => (i.goal ? [[i.goal.id, i.goal.title] as const] : [])));
  const trackTitles = new Map(data.items.flatMap((i) => (i.track ? [[i.track.id, i.track.title] as const] : [])));
  // One row per milestone: a roadmap's own milestones of one goal, code (and PRD) are one;
  // two goals' M1 on one roadmap are two (codes are numbered per goal, the owner's of Nov 8).
  const goalKey = (gm: Gm) => {
    if (gm.roadmap_code) return `goal:${gm.roadmap_code}`;
    const code = goalCode(gm);
    return code ? `goal:${gm.roadmap_id}|${gm.goal_id ?? ""}|${code}|${gm.prd?.slug ?? ""}` : `goal:${gm.id}`;
  };
  // A typed text names a current milestone by its code ("M1 · Measure it (a note)") or by its name.
  const named = (text: string, code: string | null, name: string) => {
    const head = text.trim().split(" (")[0].split(";")[0];
    const typed = codeOf(head);
    return typed ? typed === code : [text, head].some((t) => sameWords(t, name) || sameWords(t, unwrap(name)) || (!!code && sameWords(t, wholeName(code, name))));
  };
  // Each item's milestone: a roadmap's own (goal) one, or a track one (with the item's roadmap).
  type Hit = { gm: Gm } | { tm: Tm; roadmap: string };
  const find = (i: Item): Hit | null => {
    const own = i.milestone;
    const gm = (own?.id ? live.get(own.id) : undefined) ?? goals.find((m) => m.item_ids.includes(i.id));
    if (gm) return { gm };
    // Its milestone was picked by id and is gone: in none, whatever its old words say.
    if (own?.id) return null;
    const tm = tracks.find((m) => m.item_ids.includes(i.id)) ?? (own?.record_id ? tracks.find((m) => m.id === own.record_id) : undefined);
    if (tm) return { tm, roadmap: i.roadmap.id };
    if (own?.name) {
      const text = own.name;
      // home-milestones-own-roadmap: Priorities shows the item in the milestone its text names
      // ("Milestone M1"); Home reads that milestone on its own roadmap, else the read's (the
      // company roadmap's), never another roadmap's: its own goal's (codes are numbered per goal),
      // else its track's, else its roadmap's own (a track one there, or one of no goal); a code
      // another goal has is that goal's only when nothing else of the code is there and no other
      // goal has it too (never a guess); another track's only when no other track of the roadmap
      // has it too (never a guess); a whole name names its one milestone.
      const byCode = !!codeOf(text.trim().split(" (")[0].split(";")[0]);
      for (const roadmap of new Set([i.roadmap.id, ...(data.roadmap ? [data.roadmap.id] : [])])) {
        const on = goals.filter((m) => m.roadmap_id === roadmap && named(text, goalCode(m), restOf(m.name)));
        const only = new Set(on.map((m) => m.goal_id ?? "")).size === 1 ? on[0] : undefined;
        const g = on.find((m) => !!i.goal && m.goal_id === i.goal.id) ?? (byCode ? undefined : only);
        if (g) return { gm: g };
        const here = tracks.filter((m) => named(text, codeOf(m.name), restOf(m.name)));
        // Another track's is its only when it is the one of the roadmap's tracks that has it: of two
        // ("M1 · Measured" and "M1 · Other"), never a guess (review of PR 1453).
        const there = here.filter((m) => !!roadmapsOf.get(m.track_id)?.has(roadmap));
        const t = (i.track ? here.find((m) => m.track_id === i.track!.id) : undefined) ?? (there.length === 1 ? there[0] : undefined);
        if (t) return { tm: t, roadmap: i.roadmap.id };
        const r = on.find((m) => !m.goal_id) ?? only;
        if (r) return { gm: r };
      }
      return null;
    }
    const after = tracks
      .filter((m) => m.date && !!i.track && m.track_id === i.track.id && i.end.date <= m.date)
      .sort((a, b) => byCodePoint(a.date!, b.date!))[0];
    return after ? { tm: after, roadmap: i.roadmap.id } : null;
  };
  const kept = data.items.filter((i) => i.status !== "cut");
  const hits = new Map(kept.map((i) => [i.id, find(i)] as const));
  // A track milestone is company-wide: always one row (by its id), wherever its items sit. A
  // roadmap's own milestone joins it when the API gave both one roadmap code (the rule's one place,
  // oracle.simple.roadmap_codes); the row shows the longer name and lists the others in its (i) (the
  // owner's of Nov 9, "One M1 row" and "Join whenever names match").
  const into = new Map<Gm, Tm>();
  const folded = new Map<Tm, Gm[]>();
  const rowName = new Map<Tm, string>();
  const also = new Map<Tm, string[]>();
  // roadmap-milestone-codes: a goal's (or a PRD's) milestone that is a track milestone shares its
  // roadmap code (the API's rule, oracle.simple.roadmap_codes): one row.
  // Read by whole name (then id), never in the read's order: a bare-code track takes the same
  // name, and lists the same others, whichever roadmap comes first (home-milestones-two-roadmaps).
  const byName = [...goals].sort((a, b) => byCodePoint(goalMilestoneName(a), goalMilestoneName(b)) || byCodePoint(a.id, b.id));
  for (const gm of byName) {
    const code = gm.roadmap_code;
    const tm = code ? tracks.find((t) => t.roadmap_code === code) : undefined;
    if (!code || !tm) continue;
    into.set(gm, tm);
    folded.set(tm, [...(folded.get(tm) ?? []), gm]);
  }
  // Join whenever names match (the owner's of Nov 9): the row shows the longer name (more words,
  // then more letters; the track's own on a tie) and its (i) lists each other name once, case and
  // spaces never counting; a bare code is no name.
  const pick = (code: string, all: string[]): { shown: string; others: string[] } | null => {
    const names = all.filter((n) => n !== code);
    const size = (n: string) => [n.split(/\s+/).length, n.length];
    const shown = names.reduce<string | null>((best, n) => {
      if (!best) return n;
      const [w, l] = size(n);
      const [bw, bl] = size(best);
      return w > bw || (w === bw && l > bl) ? n : best;
    }, null);
    if (!shown) return null;
    const others: string[] = [];
    for (const n of names) {
      const other = n.replace(" · ", " ");
      if (!sameWords(n, shown) && !others.some((o) => sameWords(o, other))) others.push(other);
    }
    return { shown, others };
  };
  for (const [tm, own] of folded) {
    const got = pick(tm.roadmap_code!, [wholeName(tm.roadmap_code!, restOf(tm.name)), ...own.map((g) => wholeName(tm.roadmap_code!, restOf(g.name)))]);
    if (!got) continue;
    rowName.set(tm, got.shown);
    if (got.others.length) also.set(tm, got.others);
  }
  // A goal's milestone joined with a PRD's (or the roadmap's own) of one roadmap code, no track's: the same.
  const byCode = new Map<string, Gm[]>();
  for (const gm of byName) if (gm.roadmap_code && !into.has(gm)) byCode.set(gm.roadmap_code, [...(byCode.get(gm.roadmap_code) ?? []), gm]);
  const codeRow = new Map([...byCode].flatMap(([code, own]) => {
    const got = own.length > 1 ? pick(code, own.map((g) => wholeName(code, restOf(g.name)))) : null;
    return got ? [[code, got] as const] : [];
  }));
  // Whose a row is (its PRD's, else its goal's, else its track's): two rows that read alike are told apart by it.
  const ofTrack = (tm: Tm) => {
    const own = folded.get(tm) ?? [];
    // Its own whole name; with none, the name of a roadmap milestone that joins it ("M3" never hides a joined "M3 · Rules ready").
    const name = rowName.get(tm) ?? wholeName(tm.roadmap_code ?? codeOf(tm.name), restOf(tm.name));
    // Its own date, else the earliest of those that join it.
    const dates = own.flatMap((g) => (g.date ? [g.date] : []));
    return { key: `track:${tm.id}`, name, date: tm.date ?? (dates.length ? minOf(dates) : null), of: trackTitles.get(tm.track_id) ?? null, also: also.get(tm), ms: undefined as string | undefined };
  };
  const ofGoal = (gm: Gm) => {
    const tm = into.get(gm);
    if (tm) return ofTrack(tm);
    const joined = gm.roadmap_code ? codeRow.get(gm.roadmap_code) : undefined;
    const dates = (gm.roadmap_code ? (byCode.get(gm.roadmap_code) ?? []) : [gm]).flatMap((g) => (g.date ? [g.date] : []));
    // home-milestone-rename: the row renames the milestone whose name it shows.
    const shows = joined && (byCode.get(gm.roadmap_code!) ?? []).find((g) => sameWords(wholeName(gm.roadmap_code!, restOf(g.name)), joined.shown));
    if (joined) return { key: goalKey(gm), name: joined.shown, date: dates.length ? minOf(dates) : null, of: gm.prd?.title ?? (gm.goal_id ? goalTitles.get(gm.goal_id) : undefined) ?? null, also: joined.others.length ? joined.others : undefined, ms: (shows || gm).id };
    return { key: goalKey(gm), name: goalMilestoneName(gm), date: gm.date ?? null, of: gm.prd?.title ?? (gm.goal_id ? goalTitles.get(gm.goal_id) : undefined) ?? null, also: undefined, ms: gm.id };
  };
  return kept.map((i) => {
    const base: PlanInput = { start: i.start.date, end: i.end.date, estimated: i.estimated, milestone: null, milestoneDate: null, id: i.id };
    const h = hits.get(i.id);
    const m = h ? ("gm" in h ? ofGoal(h.gm) : ofTrack(h.tm)) : null;
    return m ? { ...base, milestone: m.name, milestoneDate: m.date, record: { id: m.key, name: m.name, label: m.name, of: m.of, ...(m.also ? { also: m.also } : {}), ...(m.ms ? { ms: m.ms } : {}) } } : base;
  });
}

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
  cut_with_dependents: "Cut it and its dependents",
  restore: "Restore",
  edit_title: "Retitle",
  edit_outcome: "Change the outcome",
  edit_note: "Change the notes",
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
  set_section_number: "Set a number in a PRD section",
  add_key_date: "Add a key date",
  edit_key_date: "Change a key date",
  remove_key_date: "Remove a key date",
  edit_goal_milestone: "Change a milestone",
  set_milestone: "Set a milestone",
  set_goals: "Move to another goal",
  add_feature_ask: "File a feature ask",
  set_owner: "Change the owner",
  set_decider: "Change the decider",
  decide_question: "Decide a question",
  name_decider: "Name who decides",
  // trash-features-goals and the goal asks (edit-goals-prds EG1 a).
  delete_item: "Move to Trash",
  delete_goal: "Move the goal to Trash",
  archive_goal: "Archive the goal",
  unarchive_goal: "Restore the goal",
  edit_decision: "Change a decision",
  withdraw_decision: "Withdraw a decision",
  edit_question: "Change a question",
};
/** A change's words; one the list does not name yet reads "Change", never its code. */
export const opWords = (op: string): string => OP_WORDS[op] ?? "Change";

/** What happened, in plain words, before the item it happened to (Home's "Since your last visit"). */
const DONE_WORDS: Record<string, string> = {
  move_dates: "Dates moved for",
  change_horizon: "Horizon changed for",
  reorder: "Reordered",
  cut: "Cut",
  cut_with_dependents: "Cut with its dependents:",
  restore: "Restored",
  edit_title: "Retitled",
  edit_outcome: "Outcome changed for",
  edit_note: "Notes changed for",
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
  set_section_number: "Number set in a PRD section",
  add_key_date: "Key date added",
  edit_key_date: "Key date changed",
  remove_key_date: "Key date removed",
  edit_goal_milestone: "Milestone changed",
  add_item: "Added",
  merge_item: "Merged",
  keep_both: "Kept beside its look-alike:",
  set_milestone: "Milestone set for",
  set_goals: "Moved to another goal:",
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
  let subject = item ? `${item.code ? `${item.code} ` : ""}${item.title}` : named;
  // Review minor: a cut with its dependents names every item it cut, the item first.
  const titles = c.op === "cut_with_dependents" && Array.isArray(c.target?.titles) ? (c.target.titles as unknown[]).slice(1).map(String) : [];
  if (titles.length) {
    const all = [subject ?? "an item", ...titles];
    subject = `${all.slice(0, -1).join(", ")} and ${all[all.length - 1]}`;
  }
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

/**
 * roadmap-decide: what happens next to a working draft and who acts, in plain words, with the
 * action the reader may take ("submit": Send for review; "approve": the decider's Approve;
 * "publish": the decider's Approve and publish on a working draft, the owner's Nov 4 pick).
 * The roadmap's banner and Home say the same. `names` names the people it waits on.
 */
export function draftNext(
  d: Pick<Schemas["SimpleDraftOut"], "status" | "can_submit" | "can_approve" | "can_publish" | "base_version" | "published" | "waiting_on"> &
    Partial<Pick<Schemas["SimpleDraftOut"], "decider" | "decider_approved" | "next_version">> & { required_reviewers?: string[] },
  names?: (id: string) => string,
): { words: string; action: "submit" | "approve" | "publish" | null } {
  // hotfix 4: the number it becomes, after the roadmap's latest version (a run's may be newer than its base).
  const v = `version ${d.next_version ?? (d.base_version ?? 0) + 1}`;
  const publish = d.published ? `${v} replaces the approved roadmap` : `${v} is published`;
  // Review: the roadmap's decider by name (the draft carries it) until they approve, then whom it waits on.
  const decider = d.decider && !d.decider_approved ? [d.decider.name] : [];
  const people = [...decider, ...(names ? d.waiting_on.filter((id) => id !== d.decider?.id).map(names) : [])];
  const who = people.length ? people.join(", ") : "its decider";
  const verb = people.length > 1 ? "approve" : "approves";
  if (d.status === "submitted") {
    if (d.can_approve) return { words: `Sent for review: it waits for your approval. When you approve, ${publish}`, action: "approve" };
    return { words: `Sent for review: it waits for ${who} to approve. Then ${publish}`, action: null };
  }
  // Review: required reviewers still hold it after the decider's approval: named before the click.
  const later = d.required_reviewers ?? [];
  if (d.can_publish && later.length) {
    const them = names ? later.map(names).join(", ") : "its required reviewers";
    return { words: `Next: you approve it, then ${them} ${later.length > 1 || !names ? "review" : "reviews"} it. When they approve, ${publish}`, action: "publish" };
  }
  if (d.can_publish) return { words: `Next: you approve it, and ${publish}`, action: "publish" };
  if (d.can_submit) return { words: `Next: you send it for review. When ${who} ${verb}, ${publish}`, action: "submit" };
  return { words: `Next: the roadmap's owner sends it for review. When ${who} ${verb}, ${publish}`, action: null };
}
