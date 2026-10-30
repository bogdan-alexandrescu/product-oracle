"use client";

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";

import { calendarDay } from "@/lib/dates";

import {
  addDays,
  barKind,
  barSpan,
  broken,
  closedItem,
  DAY_MS,
  daysBetween,
  liftBar,
  liveBreaks,
  markDrag,
  type Lifted,
  milestonePrd,
  ms,
  planMilestones,
  planPrds,
  quarters,
  quarterValue,
  scale,
  shortDay,
  sourceWord,
  whereAttr,
  type Item,
  type Lane,
  type Roadmap,
  type Scale,
  type Slice,
} from "./_lib";
import { CALL_H, RH } from "./_pitch";
import { ellipsize, monthTick, ordinal, PreviewGhost, previewSpan, useAppliedFlash, usePreview, type Layout } from "./_timeline";

/*
 * timeline-overlap B (the owner's pick, 2026-10-28; decision roadmap-timeline-goal-lanes-later):
 * the roadmap's Timeline as goal lanes. B2 (desktop): one lane per goal (the Group by's
 * grouping), the goal's pieces inside it, each coloured by its milestone (M1 blue, M2 violet,
 * M3 amber; PM-owned work grey and dashed, in a lane of its own), a piece stacking into the
 * lane's next row when it runs at the same time as another or starts less than a week after it
 * (decision lane-stacking); slices of one feature share a row, joined by a dotted line; the
 * month and week rows with the Today pill, each milestone's end a flag and a dashed line down
 * the chart, holidays hatched, the legend inside the card. B3 (phone): one thin lane per goal,
 * its work as one bar per run of a milestone, and the opened lane's pieces listed below.
 */

const DAY = DAY_MS;
const WEEK = 7 * DAY;
/** The lane labels' column (B2: 186 px of a 1030 px card). */
const LABEL_W = 186;
/** B2's rows: months, weeks (with the Today pill), the milestone flags; extra rows of marks are 20 px. */
const MONTH_H = 22;
const WEEK_H = 22;
const FLAG_H = 24;
const MARK_ROW = 20;
/** A lane's pills' height (B2: 20); its row pitch and callout line are in _pitch. */
const BAR_H = 20;
/** QA2 finding 11: a slice or bar is never drawn narrower than this, so a short run of work
 * still reads as a pill, not an unreadable blob, at a coarse scale. */
const MIN_PILL_W = 28;
/** The phone's lane runs carry no text, so a smaller floor (near B3's bar height) is enough. */
const MIN_RUN_W = 12;
/** fix4 qa-simple-roadmap-52: a lane's least height: its name (20 px) and count (16 px) with 4 px above and below. */
const LANE_MIN_H = 44;
const LONG_PRESS_MS = 450;
/** B3: the Today row, the month row, the flags row; each lane's name line, gap and bar row. */
const P_TODAY_H = 22;
const P_MONTH_H = 22;
const P_FLAG_H = 20;
const P_MARK_ROW = 18;
const P_BAR_ROW = 16;
const P_BAR_H = 14;

/** "Nov 27": fix4 qa-simple-roadmap-28, the one way the Roadmap writes a day (month first),
 * with its year when it is not this year's ("Jan 1, 2027"). */
const dm = (day: string) =>
  calendarDay(day, day.slice(0, 4) === String(new Date().getUTCFullYear()) ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });

// ---------------------------------------------------------------- text widths

let measure: CanvasRenderingContext2D | null | undefined;
let family = "sans-serif";
/** The drawn width of `text` in the page's type (a label fitted to its pill is never cut). */
const widths = new Map<string, number>();
function textWidth(text: string, px: number, weight: number): number {
  if (typeof document === "undefined") return text.length * px * 0.6;
  // fix4 (500 items): each label's width once (a pill's name is measured to pack and to draw it).
  const key = `${weight}|${px}|${text}`;
  const known = widths.get(key);
  if (known !== undefined) return known;
  const w = measured(text, px, weight);
  if (measure) widths.set(key, w);
  return w;
}
function measured(text: string, px: number, weight: number): number {
  if (measure === undefined) {
    measure = document.createElement("canvas").getContext("2d");
    family = getComputedStyle(document.body).fontFamily || family;
  }
  if (!measure) return text.length * px * 0.6;
  measure.font = `${weight} ${px}px ${family}`;
  return measure.measureText(text).width;
}

/** Measures again once the web fonts have loaded (labels are fitted with them). */
function useFontsReady(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) {
        // Widths measured in a fallback font are measured again in the web font.
        widths.clear();
        setN(1);
      }
    });
    return () => {
      live = false;
    };
  }, []);
  return n;
}

// ---------------------------------------------------------------- the lanes' model

/** A piece of work in a lane: one dated slice of a planned feature, or an item's own span. */
export type Piece = { key: string; code: string | null; name: string; start: string; end: string; milestone: string | null; pm: boolean; slice: Slice | null };
type Unit = { item: Item; pieces: Piece[]; row: number };
/** `line`: each row's top in the lane and `h` the rows' height, in px (a row with a callout takes a callout line more, under it). */
export type LaneModel = { key: string; title: string; kind: "group" | "pm" | "below"; units: Unit[]; rows: number; count: number; h: number; line: number[]; callouts: Set<number> };

const datedSlices = (i: Item): Slice[] => i.slices.filter((x) => x.start_date && x.end_date).sort((a, b) => (a.start_date! < b.start_date! ? -1 : a.start_date! > b.start_date! ? 1 : 0));
const pmSlice = (x: Slice) => x.pm_owned || x.effort_weeks == null;
/** Work the PM does with no engineering: every dated slice of the item is PM-owned. */
export const pmItem = (i: Item) => {
  const d = datedSlices(i);
  return d.length > 0 && d.every(pmSlice);
};
/** A planned item: its slices carry its dates (they follow the PRD; it is not dragged). */
const planned = (i: Item) => datedSlices(i).length > 0;

function piecesOf(item: Item, span?: [string, string]): Piece[] {
  const d = datedSlices(item);
  if (d.length) return d.map((x) => ({ key: `${item.id}:${x.code}`, code: x.code, name: x.name, start: x.start_date!, end: x.end_date!, milestone: x.milestone, pm: pmSlice(x), slice: x }));
  const [start, end] = span ?? barSpan(item);
  return [{ key: item.id, code: item.code ?? null, name: item.title, start, end, milestone: null, pm: false, slice: null }];
}

/**
 * Decision lane-stacking: a piece takes the lane's first row where it neither overlaps another
 * piece nor starts less than a week from one's start; a feature's slices share one row. Units
 * go in start order, the longer first. A broken item's callout goes on a line of its own under
 * its row (qa-simple-roadmap-4, "Under the lane"), so a row holds at most one broken item.
 */
function pack(items: Item[], moved: Record<string, [string, string]>, callout: (i: Item) => boolean, dayPx = 0): { units: Unit[]; rows: number; callouts: Set<number> } {
  const units: Unit[] = items.map((item) => ({ item, pieces: piecesOf(item, moved[item.id]), row: 0 }));
  const len = (p: Piece) => ms(p.end) - ms(p.start);
  units.sort((a, b) => ms(a.pieces[0].start) - ms(b.pieces[0].start) || len(b.pieces[0]) - len(a.pieces[0]) || (a.pieces[0].code ?? a.item.title).localeCompare(b.pieces[0].code ?? b.item.title));
  const clash = (a: [number, number], b: [number, number]) => (a[0] <= b[1] && b[0] <= a[1]) || Math.abs(a[0] - b[0]) < WEEK;
  const rows: [number, number][][] = [];
  const callouts = new Set<number>();
  for (const u of units) {
    const occ: [number, number][] = u.pieces.map((p) => [ms(p.start), ms(p.end)]);
    // fix4 qa-simple-roadmap-2: a pill too short for its name writes it beside itself; that
    // room is the pill's too, so the next pill in its row starts after the name.
    if (dayPx > 0 && !u.item.slices.some((x) => x.start_date && x.end_date)) {
      // From its dates as saved, not a pending move's: a key press or drag never reshuffles
      // the other pills' rows before its change is answered.
      const p = moved[u.item.id] ? piecesOf(u.item)[0] : u.pieces[0];
      const pillW = Math.max(MIN_PILL_W, (daysBetween(p.start, p.end) + 1) * dayPx);
      const name = u.item.draft && !closedItem(u.item) ? `Draft · ${p.name}` : p.name;
      const need = textWidth(name, 12, 650) + 16;
      if (need > pillW) occ.push([ms(p.start), ms(p.start) + ((pillW + 6 + textWidth(name, 12, 600) + 8) / dayPx) * DAY]);
    }
    // fix4 qa-simple-roadmap-31: Oracle's suggestion (its dotted outline, and its "?" left of
    // it) takes its row too, so neither is ever drawn over another pill's name.
    const sg = u.item.suggestion;
    if (sg && !closedItem(u.item)) occ.push([Math.min(ms(sg.start_date), ms(u.pieces[0].start)) - WEEK, ms(sg.end_date)]);
    const call = callout(u.item);
    let r = rows.findIndex((row, n) => !(call && callouts.has(n)) && occ.every((o) => row.every((x) => !clash(o, x))));
    if (r < 0) {
      r = rows.length;
      rows.push([]);
    }
    rows[r].push(...occ);
    if (call) callouts.add(r);
    u.row = r;
  }
  return { units, rows: Math.max(1, rows.length), callouts };
}

/** An item's unit as last drawn, kept while its row and pieces stay (memo(Pill): a key press redraws only the pressed pill). */
const units = new WeakMap<Item, Unit>();
function kept(u: Unit): Unit {
  const old = units.get(u.item);
  if (old && old.row === u.row && old.pieces.length === u.pieces.length && old.pieces.every((p, n) => p.start === u.pieces[n].start && p.end === u.pieces[n].end)) return old;
  units.set(u.item, u);
  return u;
}

/**
 * The lanes: the Group by's groups in the API's order (an item once, in its first group: B's
 * "a piece of work that moves two goals sits only in its first goal's lane"); grouped by goal,
 * PM-owned work has a lane of its own after the goals; closed items (cut, merged) go below the
 * line, last.
 */
function laneModels(data: Roadmap, lane: Lane, moved: Record<string, [string, string]>, callH: Record<string, number> = {}, dayPx = 0): { lanes: LaneModel[]; places: Map<string, number> } {
  const byId = new Map(data.items.map((i) => [i.id, i]));
  const seen = new Set<string>();
  const groups: { key: string; title: string; kind: LaneModel["kind"]; items: Item[] }[] = [];
  const pm: Item[] = [];
  const below: Item[] = [];
  for (const g of data.groups) {
    const items = g.item_ids.map((id) => byId.get(id)).filter((i): i is Item => !!i && !seen.has(i.id));
    for (const i of items) seen.add(i.id);
    below.push(...items.filter(closedItem));
    const live = items.filter((i) => !closedItem(i));
    if (lane === "goal") pm.push(...live.filter(pmItem));
    const own = lane === "goal" ? live.filter((i) => !pmItem(i)) : live;
    if (own.length) groups.push({ key: g.key, title: g.title, kind: "group", items: own });
  }
  if (pm.length) groups.push({ key: "pm-owned", title: "PM-owned", kind: "pm", items: pm });
  if (below.length) groups.push({ key: "below-the-line", title: "Below the line", kind: "below", items: below });
  const lanes = groups.map((g) => {
    const calls = (i: Item) => g.kind !== "below" && broken(i).some((f) => f.kind === "dependency_order");
    const p = pack(g.items, moved, calls, dayPx);
    // fix4 qa-simple-roadmap-1: a callout's line is as tall as its callout is drawn (its words
    // wrap rather than being cut on a narrow chart): 4 px more than it, CALL_H at least.
    const callLine = new Map<number, number>();
    // (The row's broken item's own callout: a row holds one, among other pills.)
    for (const u of p.units) if (calls(u.item)) callLine.set(u.row, Math.max(CALL_H, (callH[u.item.key] ?? 0) + 4));
    const line: number[] = [];
    let h = 0;
    for (let r = 0; r < p.rows; r++) {
      line.push(h);
      h += RH + (callLine.get(r) ?? (p.callouts.has(r) ? CALL_H : 0));
    }
    return { key: g.key, title: g.title, kind: g.kind, units: p.units.map(kept), rows: p.rows, count: g.items.length, h, line, callouts: p.callouts };
  });
  return { lanes, places: new Map(below.map((i, n) => [i.id, n + 1])) };
}

/** A milestone's hue as the PRD's When strip draws it (M1 blue, M2 violet, M3 amber, then round again). */
const hueN = (code: string) => (((Number(code.replace(/\D/g, "")) || 1) - 1) % 3) + 1;
const mLine = (code: string) => `var(--prd-m${hueN(code)})`;
const mBg = (code: string) => `var(--prd-m${hueN(code)}-bg)`;

/** How a piece is drawn: its milestone's hue, PM-owned grey and dashed; an item with no plan by its kind. */
function look(p: Pick<Piece, "milestone" | "pm">, item: Item | null, cut: boolean): { fill: string; stroke: string; dash?: string; ink: string } {
  if (cut) return { fill: "var(--na-bg)", stroke: "var(--line)", ink: "var(--text2)" };
  if (p.pm) return { fill: "var(--simple-paper)", stroke: "var(--prd-pm)", dash: "4 3", ink: "var(--text2)" };
  if (p.milestone) return { fill: mBg(p.milestone), stroke: mLine(p.milestone), ink: mLine(p.milestone) };
  const kind = item ? barKind(item) : "dated";
  if (kind === "draft") return { fill: "var(--simple-paper)", stroke: "var(--line-strong)", dash: "6 4", ink: "var(--text2)" };
  // QA2 finding 17: --line-strong on --na-bg reads near 3:1 in dark mode (barely a UI-component
  // minimum, too faint for a border meant to carry the pill's whole shape); --text2 keeps a
  // readable line in both themes.
  if (kind === "estimated") return { fill: "url(#lanes-estimated)", stroke: "var(--text2)", ink: "var(--text)" };
  return { fill: "var(--na-bg)", stroke: "var(--text2)", ink: "var(--text)" };
}

/** The days the chart spans: every piece, milestone, key date, suggestion and today, two days either side (B2: 17 Oct to 31 Jan for 19 Oct to 29 Jan). */
/** The grouped items' pieces, unpacked (the span needs their days, not their rows). */
function groupedUnits(data: Roadmap, moved: Record<string, [string, string]>): { item: Item; pieces: Piece[] }[] {
  const byId = new Map(data.items.map((i) => [i.id, i]));
  const seen = new Set<string>();
  const out: { item: Item; pieces: Piece[] }[] = [];
  for (const g of data.groups)
    for (const id of g.item_ids) {
      const item = byId.get(id);
      if (!item || seen.has(id)) continue;
      seen.add(id);
      out.push({ item, pieces: piecesOf(item, moved[id]) });
    }
  return out;
}

function spanOf(data: Roadmap, units: { item: Item; pieces: Piece[] }[], extra: string[] = [], before = 2): { t0: string; t1: string } {
  // fix4 qa-simple-roadmap-10: a chat preview's ghost is inside the span (a move to Q2 2027 ghosts there).
  const days: string[] = [data.today, ...extra];
  for (const u of units) {
    for (const p of u.pieces) days.push(p.start, p.end);
    if (u.item.suggestion) days.push(u.item.suggestion.start_date, u.item.suggestion.end_date);
  }
  for (const m of planMilestones(data)) days.push(m.start_date!, m.end_date!);
  for (const m of data.milestones) if (m.date) days.push(m.date);
  for (const k of data.key_dates ?? []) days.push(k.date);
  const lo = days.reduce((a, b) => (b < a ? b : a));
  const hi = days.reduce((a, b) => (b > a ? b : a));
  return { t0: addDays(lo, -before), t1: addDays(hi, 2) };
}

/** The month starts in the span (the first at the span's start), and the Mondays. */
function calendar(t0: string, t1: string) {
  const months: { day: string; label: string; start: boolean }[] = [];
  for (let d = new Date(ms(t0)); d.getTime() < ms(t1); d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
    const day = first < t0 ? t0 : first;
    // fix4 qa-simple-roadmap-30: three letters ("Sep", not en-GB's "Sept"); January names its
    // year (the first label shown names its own too: monthLabels).
    months.push({ day, label: monthTick(first, false), start: first >= t0 });
  }
  const mondays: string[] = [];
  for (let d = addDays(t0, (8 - new Date(ms(t0)).getUTCDay()) % 7); d < t1; d = addDays(d, 7)) mondays.push(d);
  return { months, mondays };
}

// ---------------------------------------------------------------- marks (milestone ends, key dates)

type Mark = { key: string; kind: "end" | "key" | "track"; x: number; words: string; side: "before" | "after"; row: number; w: number };

/** Each mark takes the first row where its flag (or diamond) and words touch no other's; words that would run off the chart go on the line's other side. */
function placeMarks(list: Omit<Mark, "row" | "w">[], width: number, size: number): Mark[] {
  const rows: [number, number][][] = [];
  const out: Mark[] = [];
  for (const m of list) {
    if (m.x < -1 || m.x > width + 1) continue;
    // A flag: 13 px, a 4 px gap, the words and 6 px from its line; a diamond: 5 px, 4 px, the words.
    const w = textWidth(m.words, size, 700) + (m.kind === "end" ? 23 : 9);
    const box = (side: Mark["side"]): [number, number] => (side === "before" ? [m.x - w, m.x + (m.kind === "end" ? 0 : 6)] : [m.x - (m.kind === "end" ? 0 : 6), m.x + w]);
    let side = m.side;
    if (side === "before" && box("before")[0] < 0) side = "after";
    else if (side === "after" && box("after")[1] > width) side = "before";
    const [x0, x1] = box(side);
    let row = 0;
    while (rows[row]?.some(([p, q]) => p < x1 + 6 && x0 < q + 6)) row++;
    (rows[row] ??= []).push([x0, x1]);
    out.push({ ...m, side, row, w });
  }
  return out;
}

const FLAG_PATH = "M2 1h1.4v10H2zM3.4 1.5h7l-1.8 2.6 1.8 2.6h-7z";

// ---------------------------------------------------------------- the component

export interface LanesProps {
  data: Roadmap;
  /** The Group by: the data's groups are already these lanes. */
  lane: Lane;
  /** A phone draws B3. */
  compact: boolean;
  canDrag: boolean;
  /** Bars moved (a drag, or the keyboard's burst not sent yet) and waiting for the change's answer. */
  moved: Record<string, [string, string]>;
  open: string | null;
  onOpen: (item: Item, anchor: { x: number; y: number }) => void;
  onMove: (item: Item, start: string, end: string) => void;
  onKeyMove: (item: Item, start: string, end: string) => void;
  onKeyEnd: (item: Item) => void;
  onKeyCancel: (item: Item) => void;
  onSuggestion: (item: Item, anchor: { x: number; y: number }) => void;
  /** HTML drawn over the chart (the broken links' callouts), in chart pixels. */
  overlay?: (l: Layout, sc: Scale) => ReactNode;
  chartRef?: (el: SVGSVGElement | null) => void;
  /** Quick add's drop targets (the quarters and the goal lanes). */
  dropTargets?: boolean;
  /** The plan's no-work weeks (holidays), hatched. */
  noWork?: { start: string; end: string; label?: string | null }[];
}

/** A goal lane the API names (its key is a goal's id): quick add drops on it. */
const goalLane = (key: string) => key !== "none" && !key.startsWith("plan-goal:");

export function Lanes(props: LanesProps) {
  return props.compact ? <PhoneLanes {...props} /> : <DesktopLanes {...props} />;
}

type Drag = { id: string; mode: "move" | "start" | "end"; x0: number; start: string; end: string; dx: number; moved: boolean; frame: number | null; pointer: number; touch: boolean; armed: boolean; timer: number | null; lift?: Lifted };

declare global {
  interface Window {
    __poDragFrames?: number[];
    __poDragWork?: number[];
  }
}

function useWidth(initial: number): [RefObject<HTMLDivElement | null>, number] {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initial);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const on = () => setWidth(Math.max(200, el.clientWidth));
    on();
    const ro = new ResizeObserver(on);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [box, width];
}

/** The SVG patterns: the holidays' hatch and an estimated item's. */
function Defs() {
  return (
    <defs>
      <pattern id="lanes-holiday" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="1.5" height="7" fill="var(--line-strong)" />
      </pattern>
      <pattern id="lanes-estimated" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="7" height="7" fill="var(--na-bg)" />
        <rect width="2" height="7" fill="var(--line-strong)" opacity="0.35" />
      </pattern>
      <marker id="lanes-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M0,0 L8,4 L0,8 z" fill="var(--line-strong)" />
      </marker>
      <marker id="lanes-arrow-red" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M0,0 L8,4 L0,8 z" fill="var(--crit)" />
      </marker>
      <marker id="lanes-arrow-amber" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M0,0 L8,4 L0,8 z" fill="var(--warn)" />
      </marker>
    </defs>
  );
}

/** The Today pill (B2: in the week row; B3: in its own row), centred on today, never off the chart's left. */
function TodayPill({ x, y }: { x: number; y: number }) {
  const w = textWidth("Today", 11.5, 750) + 14;
  const cx = Math.max(x, 26);
  return (
    <g data-testid="today-pill" pointerEvents="none">
      <rect x={cx - w / 2} y={y} width={w} height={18} rx={9} fill="var(--crit)" />
      <text x={cx} y={y + 9.5} textAnchor="middle" dominantBaseline="central" fontSize={11.5} fontWeight={750} fill="var(--simple-paper)">
        Today
      </text>
    </g>
  );
}

/** The month labels that fit: every month (B2), else every 2nd, 3rd, 6th or 12th on a long span; the first month's part gives way when the next starts within its label. */
function monthLabels(months: { day: string; label: string; start: boolean }[], sc: Scale, width: number) {
  const fits = (list: typeof months) =>
    list.every((m, i) => {
      const next = list[i + 1];
      const w = textWidth(m.label, 13, 650) + 10;
      return sc.x(m.day) + w <= width && (!next || sc.x(next.day) - sc.x(m.day) >= w);
    });
  // fix4 qa-simple-roadmap-30: the first label shown names its year ("Oct 2026"), as each January does.
  const withYear = (list: typeof months) => list.map((m, i) => (i === 0 && !/\d/.test(m.label) ? { ...m, label: `${m.label} ${m.day.slice(0, 4)}` } : m));
  for (const step of [1, 2, 3, 6, 12]) {
    const list = withYear(months.filter((m) => m.start && (new Date(ms(m.day)).getUTCMonth() % step === 0 || step === 1)));
    if (!fits(list)) continue;
    // The span's first, partial month, when it runs at least half a month (a sliver's label
    // crowds the next month's: qa-simple-roadmap-30) and its label fits before the next one.
    const first = months[0];
    const next = list[0];
    if (first && !first.start && next && daysBetween(first.day, next.day) >= 15) {
      const both = withYear([first, ...list.map((m) => ({ ...m, label: m.label === next.label && !/^Jan/.test(next.label) ? next.label.replace(/ \d{4}$/, "") : m.label }))]);
      if (fits(both.slice(0, 2))) return both;
    }
    return list;
  }
  return [];
}

/** B2's week row: each Monday's day over its line where there is room, not under the Today pill (the week it sits in). */
function weekLabelsOf(mondays: string[], sc: Scale, width: number, xt: number): string[] {
  const half = (textWidth("Today", 11.5, 750) + 14) / 2 + 4;
  const pill = { from: Math.max(xt, 26) - half, to: Math.max(xt, 26) + half };
  const out: string[] = [];
  // Weeks narrower than a day's number and its gap draw their lines only.
  if (sc.px * 7 < 18) return out;
  let last = -Infinity;
  for (const d of mondays) {
    const x = sc.x(d);
    const w = textWidth(String(Number(d.slice(8))), 11, 400) + 6;
    if (x < 0 || x + w > width || (x < pill.to && x + w > pill.from) || x - last < w + 4) continue;
    last = x;
    out.push(d);
  }
  return out;
}

/** The milestone ends, the tracks' milestones and the key dates as marks over the lanes. */
function useMarks(data: Roadmap, sc: Scale, width: number, compact: boolean, fonts: number) {
  return useMemo(() => {
    void fonts;
    const many = planPrds(data).size > 1;
    const list: Omit<Mark, "row" | "w">[] = [];
    for (const m of planMilestones(data)) {
      const prd = many ? milestonePrd(data, m) : null;
      const code = `${m.name.split(/[\s·]/)[0]}${prd ? ` ${prd.title}` : ""}`;
      list.push({ key: `end-${m.id}`, kind: "end", x: sc.x(m.end_date!) + sc.px, words: compact ? code : `${code} ends ${dm(m.end_date!)}`, side: "before" });
    }
    for (const m of data.milestones.filter((x) => x.date && !(x.start_date && x.end_date))) list.push({ key: `track-${m.id}`, kind: "track", x: sc.x(m.date!) + sc.px / 2, words: m.name, side: "after" });
    for (const k of data.key_dates ?? []) list.push({ key: `key-${k.id}`, kind: "key", x: sc.x(k.date) + sc.px / 2, words: k.name, side: "after" });
    // QA2 finding 18: milestone ends, tracks and key dates are built in that fixed order above,
    // not by date; placeMarks fills rows in list order, so sort by x first (its rows, and so its
    // labels, then read left to right, earliest date first, instead of by category).
    list.sort((a, b) => a.x - b.x);
    return placeMarks(list, width, compact ? 11.5 : 12.5);
  }, [data, sc, width, compact, fonts]);
}

/** The marks drawn: B2's flags ("M1 ends 13 Nov") right of the line's top, the key dates' and tracks' diamonds; `rowY` is a mark row's middle. */
function Marks({ data, marks, sc, rowY, size, height, poleTop, width }: { data: Roadmap; marks: Mark[]; sc: Scale; rowY: (row: number) => number; size: number; height: number; poleTop: number; width: number }) {
  const many = planPrds(data).size > 1;
  // QA2 finding 19: the last day's column can sit a hair past `width` (its pixel cell runs to
  // the next, off-chart day); clamp every mark's x so its flag/diamond and label never draw
  // past the chart's own right edge.
  const clampX = (v: number) => Math.min(v, width);
  return (
    <>
      {planMilestones(data).map((m) => {
        const mk = marks.find((x) => x.key === `end-${m.id}`);
        const code = m.name.split(/[\s·]/)[0];
        const prd = many ? milestonePrd(data, m) : null;
        const x = clampX(sc.x(m.end_date!) + sc.px);
        const name = `${m.name.replace(/\s*·\s*/, " ")}${prd ? ` (${prd.title})` : ""} ends ${dm(m.end_date!)}`;
        const cy = rowY(mk?.row ?? 0);
        const after = mk?.side === "after";
        const tw = mk ? mk.w - 23 : 0;
        const fx = after ? x + 6 : x - 6 - tw - 4 - 13;
        return (
          <g key={m.id} data-testid="milestone-end" data-date={m.end_date!} data-row={mk?.row ?? 0} role="img" aria-label={name} pointerEvents="none">
            <title>{name}</title>
            {/* The milestone's end: a dashed line down the lanes (B2's pole). */}
            <line data-testid="milestone-end-line" x1={x - 0.25} x2={x - 0.25} y1={poleTop} y2={height} stroke={mLine(code)} strokeWidth={1.5} strokeDasharray="4 3" />
            {mk && (
              <>
                <path data-testid="milestone-flag" d={FLAG_PATH} transform={`translate(${fx} ${cy - 6.5}) scale(${13 / 12})`} fill={mLine(code)} />
                <text data-testid="milestone-end-label" x={after ? x + 6 + 17 : x - 6} y={cy} textAnchor={after ? "start" : "end"} dominantBaseline="central" fontSize={size} fontWeight={700} fill={mLine(code)}>
                  {mk.words}
                </text>
              </>
            )}
          </g>
        );
      })}
      {data.milestones
        .filter((m) => m.date && !(m.start_date && m.end_date))
        .map((m) => {
          const mk = marks.find((x) => x.key === `track-${m.id}`);
          if (!mk) return null;
          const cy = rowY(mk.row);
          return (
            <g key={m.id} data-testid="track-milestone" data-row={mk.row} transform={`translate(${clampX(mk.x)}, ${cy})`}>
              <rect x={-5} y={-5} width={10} height={10} transform="rotate(45)" fill="var(--warn)" />
              <text x={mk.side === "after" ? 9 : -9} dominantBaseline="central" fontSize={size} fontWeight={700} fill="var(--text2)" textAnchor={mk.side === "after" ? "start" : "end"}>
                {m.name}
              </text>
            </g>
          );
        })}
      {(data.key_dates ?? []).map((k) => {
        const mk = marks.find((x) => x.key === `key-${k.id}`);
        if (!mk) return null;
        const cy = rowY(mk.row);
        const kx = clampX(mk.x);
        return (
          <g key={k.id} data-testid="key-date-marker" data-name={k.name} data-date={k.date} data-draft={k.in_draft ? "true" : undefined} data-row={mk.row} pointerEvents="none">
            <title>{`${k.name} · ${shortDay(k.date)}${k.note ? ` · ${k.note}` : ""} (${k.roadmap.title})`}</title>
            <line x1={kx} x2={kx} y1={cy + 6} y2={height} stroke="var(--accent-ink)" strokeWidth={1} opacity={0.7} strokeDasharray={k.in_draft ? "3 3" : undefined} />
            <rect x={kx - 4.5} y={cy - 4.5} width={9} height={9} transform={`rotate(45 ${kx} ${cy})`} fill={k.in_draft ? "var(--simple-paper)" : "var(--accent-ink)"} stroke="var(--accent-ink)" />
            <text x={mk.side === "after" ? kx + 9 : kx - 9} y={cy} dominantBaseline="central" fontSize={size} fontWeight={700} fill="var(--accent-ink)" textAnchor={mk.side === "after" ? "start" : "end"} data-testid="key-date-label">
              {k.name}
            </text>
          </g>
        );
      })}
    </>
  );
}

/** The time grid under the lanes: month lines, week lines, the hatched holidays. */
function Grid({ months, mondays, sc, top, height, weeks, noWork }: { months: { day: string; start: boolean }[]; mondays: string[]; sc: Scale; top: number; height: number; weeks: boolean; noWork: { start: string; end: string; label?: string | null }[] }) {
  const dense = sc.px * 7 < 8;
  return (
    <g pointerEvents="none">
      {weeks &&
        !dense &&
        mondays.map((d) => <line key={`w-${d}`} x1={sc.x(d) + 0.5} x2={sc.x(d) + 0.5} y1={top} y2={height} stroke="var(--simple-rule)" strokeWidth={1} strokeDasharray="3 3" />)}
      {months
        .filter((m) => m.start && sc.x(m.day) > 0)
        .map((m) => (
          <line key={`m-${m.day}`} x1={sc.x(m.day) + 0.5} x2={sc.x(m.day) + 0.5} y1={top} y2={height} stroke="var(--line)" strokeWidth={1} />
        ))}
      {noWork.map((h) => (
        <rect
          key={h.start}
          data-testid="no-work"
          data-start={h.start}
          data-end={h.end}
          x={sc.x(h.start)}
          y={top}
          width={Math.max(sc.px, sc.x(h.end) - sc.x(h.start) + sc.px)}
          height={Math.max(0, height - top)}
          fill="url(#lanes-holiday)"
          opacity={0.3}
        >
          <title>{`${h.label || "No-work week"}: ${dm(h.start)} – ${dm(h.end)}`}</title>
        </rect>
      ))}
    </g>
  );
}

/** "Holidays Dec 24 – Jan 1" (the legend's words for the no-work weeks). */
const holidayWords = (noWork: { start: string; end: string }[]) => noWork.map((h) => `${dm(h.start)} – ${dm(h.end)}`).join(", ");

// ---------------------------------------------------------------- B2: the desktop

function DesktopLanes({ data, lane, canDrag, moved, open, onOpen, onMove, onKeyMove, onKeyEnd, onKeyCancel, onSuggestion, overlay, chartRef, dropTargets, noWork = [] }: LanesProps) {
  const [box, boxW] = useWidth(1030);
  const fonts = useFontsReady();
  const flash = useAppliedFlash();
  const W = Math.max(200, boxW - LABEL_W);
  // fix4 qa-simple-roadmap-1: each callout's drawn height (by item key), measured after it is
  // drawn: its lane makes room for all of it (a narrow chart, the Ask panel open, wraps its words).
  const [callH, setCallH] = useState<Record<string, number>>({});
  const over = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = over.current;
    if (!root) return;
    const all = () => root.querySelectorAll<HTMLElement>('[data-testid="broken-callout"]');
    const ro = new ResizeObserver(() => {
      const next: Record<string, number> = {};
      all().forEach((el) => {
        if (el.dataset.item) next[el.dataset.item] = Math.ceil(el.offsetHeight);
      });
      setCallH((old) => (Object.keys(next).length === Object.keys(old).length && Object.entries(next).every(([k, v]) => old[k] === v) ? old : next));
    });
    // A callout drawn or gone: watch the ones there now (observing reports each one's size).
    const watch = () => {
      ro.disconnect();
      all().forEach((el) => ro.observe(el));
    };
    const mo = new MutationObserver(watch);
    mo.observe(root, { childList: true, subtree: true });
    watch();
    return () => {
      mo.disconnect();
      ro.disconnect();
    };
  }, []);
  const preview = usePreview();
  const previewDays = useMemo(() => previewSpan(preview, data), [preview, data]);
  // The span (and so the scale) does not depend on the rows: a first packing finds it, then the
  // lanes are packed with the scale's px a day (a name beside its pill takes room in its row).
  const { t0, t1 } = useMemo(() => spanOf(data, groupedUnits(data, moved), previewDays), [data, moved, previewDays]);
  const dayPx = W / daysBetween(t0, t1);
  const { lanes, places } = useMemo(() => (void fonts, laneModels(data, lane, moved, callH, dayPx)), [data, lane, moved, callH, dayPx, fonts]);
  const sc = useMemo(() => scale(t0, addDays(t1, -1), W / daysBetween(t0, t1)), [t0, t1, W]);
  const { months, mondays } = useMemo(() => calendar(t0, t1), [t0, t1]);
  const marks = useMarks(data, sc, W, false, fonts);
  const markRows = Math.max(1, ...marks.map((m) => m.row + 1));
  const top = MONTH_H + WEEK_H + FLAG_H + (markRows - 1) * MARK_ROW;
  // The lanes' tops and heights (B2: its rows of 28 px and 8 px more).
  const geo = useMemo(() => {
    const out: { top: number; height: number }[] = [];
    for (const l of lanes) {
      const prev = out[out.length - 1];
      // fix4 qa-simple-roadmap-52: never shorter than its name and count (two lines and a gap).
      out.push({ top: prev ? prev.top + prev.height : top, height: Math.max(LANE_MIN_H, l.h + 8) });
    }
    return out;
  }, [lanes, top]);
  const height = geo.length ? geo[geo.length - 1].top + geo[geo.length - 1].height : top + 36;
  // Each item's row box (its pill sits 4 px into it), as the callouts and the chat's ghost read it;
  // a broken item's callout line, under its row.
  const layout: Layout = useMemo(() => {
    const y = new Map<string, number>();
    const under = new Map<string, number>();
    lanes.forEach((l, n) =>
      l.units.forEach((u) => {
        y.set(u.item.id, geo[n].top + 4 + l.line[u.row]);
        // The callout (drawn 3 px into its box) 2 px under the pill.
        if (l.callouts.has(u.row)) under.set(u.item.id, geo[n].top + 4 + l.line[u.row] + 4 + BAR_H + 2 - 3);
      }),
    );
    return { rows: [], rowH: RH, labelW: LABEL_W, top, height, y, under };
  }, [lanes, geo, top, height]);
  const items = useMemo(() => new Map(data.items.map((i) => [i.id, i])), [data]);
  const units = useMemo(() => new Map(lanes.flatMap((l) => l.units.map((u) => [u.item.id, u] as const))), [lanes]);
  const xt = sc.x(data.today) + sc.px / 2;
  const shownMonths = monthLabels(months, sc, W);
  const weekLabels = weekLabelsOf(mondays, sc, W, xt);
  // fix4 qa-simple-roadmap-2: the room right of each pill, to the next pill in its row (and that
  // pill's "?"), where a name too long for its pill is written instead.
  const roomOf = useMemo(() => {
    const out = new Map<string, number>();
    // By the dates as saved (as pack reserves it): a pending move redraws only its own pill.
    const saved = (o: Unit) => (moved[o.item.id] ? piecesOf(o.item) : o.pieces);
    for (const l of lanes) {
      // Each row's pills' starts, left to right (one pass per lane, not every pill against every pill: 500 items).
      const starts = new Map<number, { x: number; stop: number }[]>();
      for (const o of l.units) {
        const x = sc.x(saved(o)[0].start);
        (starts.get(o.row) ?? starts.set(o.row, []).get(o.row)!).push({ x, stop: x - (o.item.suggestion ? 26 : 4) });
      }
      for (const list of starts.values()) list.sort((a, b) => a.x - b.x);
      for (const u of l.units) {
        const ps = saved(u);
        const end = sc.x(ps[ps.length - 1].end);
        const next = starts.get(u.row)!.find((o) => o.x > end);
        out.set(u.item.id, Math.min(W, next ? next.stop : W));
      }
    }
    return out;
  }, [lanes, sc, W, moved]);

  const svg = useRef<SVGSVGElement | null>(null);
  const live = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const frames = useRef<{ last: number; raf: number | null }>({ last: 0, raf: null });

  // A drag moves the pill under the pointer by direct DOM writes (no React render per move); the change goes to the engine on release.
  const paint = () => {
    const d = drag.current;
    if (!d) return;
    d.frame = null;
    const t0w = performance.now();
    const own = svg.current?.querySelector<SVGGElement>(`g[data-bar-id="${d.id}"]`);
    if (!own) return;
    d.lift ??= liftBar(own);
    const g = d.lift.bar;
    const days = Math.round(d.dx / sc.px);
    const start = d.mode === "end" ? d.start : addDays(d.start, days);
    const end = d.mode === "start" ? d.end : addDays(d.end, days);
    const s = start > end ? end : start;
    const e = end < start ? start : end;
    const x = sc.x(s);
    const w = Math.max(sc.px, sc.x(e) - x + sc.px);
    const rect = g.querySelector<SVGRectElement>("rect[data-body]");
    rect?.setAttribute("x", String(x + 0.75));
    rect?.setAttribute("width", String(Math.max(1, w - 1.5)));
    const label = g.querySelector<SVGTextElement>("text[data-testid='bar-label']");
    if (label) {
      // A name beside its pill follows the pill's end; one inside, its start.
      label.setAttribute("x", String(label.dataset.beside ? x + w + 6 : x + 8.5));
      label.style.visibility = label.dataset.beside || Number(label.dataset.w ?? 0) + 18 <= w ? "visible" : "hidden";
      const hit = g.querySelector<SVGRectElement>("rect[data-hit]");
      hit?.setAttribute("x", String(x));
      hit?.setAttribute("width", String(w + 6 + Number(label.dataset.w ?? 0)));
    }
    const breaks = liveBreaks(items, d.id, s, e);
    markDrag(own, s, e, breaks.length > 0);
    rect?.setAttribute("stroke", breaks.length ? "var(--crit)" : "var(--accent-ink)");
    if (live.current) {
      live.current.hidden = false;
      const words = `${shortDay(s)} – ${shortDay(e)}${breaks.length ? ` · ${breaks[0]}` : " · no broken links"}`;
      if (live.current.textContent !== words) live.current.textContent = words;
      live.current.dataset.state = breaks.length ? "broken" : "ok";
      // On its own layer, moved by a transform: no layout of the chart's box per frame.
      live.current.style.transform = `translate(${Math.max(0, Math.min(x, W - 280))}px, ${(layout.y.get(d.id) ?? 0) - 22}px)`;
    }
    window.__poDragWork?.push(performance.now() - t0w);
  };
  const tick = (t: number) => {
    if (!drag.current?.moved) return;
    if (frames.current.last) window.__poDragFrames?.push(t - frames.current.last);
    frames.current.last = t;
    frames.current.raf = requestAnimationFrame(tick);
  };
  const begin = (d: Drag) => {
    d.armed = true;
    try {
      svg.current?.setPointerCapture?.(d.pointer);
    } catch {
      // A pointer that is gone already: the moves still reach the chart.
    }
  };
  const fixed = (i: Item) => closedItem(i) || planned(i);
  const onDown = (e: ReactPointerEvent<SVGGElement>, item: Item) => {
    if (e.button !== 0) return;
    const [start, end] = moved[item.id] ?? barSpan(item);
    const body = e.currentTarget.querySelector("rect[data-body]") as SVGRectElement | null;
    const r = body?.getBoundingClientRect();
    const edge = r ? Math.min(10, r.width / 4) : 0;
    const mode = !canDrag || fixed(item) || !r ? "move" : e.clientX - r.left < edge ? "start" : r.right - e.clientX < edge ? "end" : "move";
    const touch = e.pointerType === "touch";
    const target = e.currentTarget;
    const d: Drag = { id: item.id, mode, x0: e.clientX, start, end, dx: 0, moved: false, frame: null, pointer: e.pointerId, touch, armed: !touch, timer: null };
    drag.current = d;
    if (touch && canDrag && !fixed(item)) {
      d.timer = window.setTimeout(() => {
        begin(d);
        target.setAttribute("data-picked", "true");
        navigator.vibrate?.(10);
      }, LONG_PRESS_MS);
    } else if (!touch) begin(d);
  };
  const onMoveEvt = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    const dx = e.clientX - d.x0;
    if (!d.armed) {
      if (Math.abs(dx) > 8 && d.timer) {
        clearTimeout(d.timer);
        drag.current = null;
      }
      return;
    }
    const it0 = items.get(d.id);
    if (!canDrag || (it0 && fixed(it0))) return;
    if (!d.moved && Math.abs(dx) < 4) return;
    e.preventDefault();
    if (!d.moved) {
      d.moved = true;
      frames.current.last = 0;
      frames.current.raf = requestAnimationFrame(tick);
    }
    d.dx = dx;
    if (d.frame == null) d.frame = requestAnimationFrame(paint);
  };
  const onUp = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    drag.current = null;
    if (d.timer) clearTimeout(d.timer);
    if (d.frame != null) cancelAnimationFrame(d.frame);
    if (frames.current.raf != null) cancelAnimationFrame(frames.current.raf);
    if (live.current) live.current.hidden = true;
    // The chart's bar back in place (its last move is still written to its dates below).
    d.lift?.drop();
    const item = items.get(d.id);
    if (!item) return;
    const g = svg.current?.querySelector<SVGGElement>(`g[data-bar-id="${d.id}"]`);
    g?.removeAttribute("data-picked");
    if (!d.moved) {
      onOpen(item, { x: sc.x(d.start), y: (layout.y.get(d.id) ?? 0) + RH });
      return;
    }
    d.dx = e.clientX - d.x0;
    paint();
    const s = g?.dataset.dragStart;
    const en = g?.dataset.dragEnd;
    if (s && en && (s !== d.start || en !== d.end)) onMove(item, s, en);
    else if (g) {
      // Back where it was: redraw it from its dates.
      const rect = g.querySelector<SVGRectElement>("rect[data-body]");
      const x0 = sc.x(d.start);
      const w0 = Math.max(sc.px, sc.x(d.end) - x0 + sc.px);
      rect?.setAttribute("x", String(x0 + 0.75));
      rect?.setAttribute("width", String(Math.max(1, w0 - 1.5)));
    }
  };
  const keyOpen = (it: Item) => onOpen(it, { x: sc.x((moved[it.id] ?? barSpan(it))[0]), y: (layout.y.get(it.id) ?? 0) + RH });
  // The keyboard: an arrow moves a focused pill a week, Shift+arrow only its end; each press builds on the last, the burst is one change.
  const keyMove = (it: Item, dir: 1 | -1, resize: boolean) => {
    if (!canDrag || fixed(it)) return;
    const [s, e] = moved[it.id] ?? barSpan(it);
    const end = addDays(e, dir * 7);
    if (resize && end < s) return;
    onKeyMove(it, resize ? s : addDays(s, dir * 7), end);
  };
  // The pills' handlers are the same functions on every render, calling this render's (memo(Pill)).
  const handlers = useRef({ onDown, keyOpen, keyMove, onKeyEnd, onKeyCancel, onSuggestion });
  useLayoutEffect(() => {
    handlers.current = { onDown, keyOpen, keyMove, onKeyEnd, onKeyCancel, onSuggestion };
  });
  const pills = useMemo(
    () => ({
      onDown: (e: ReactPointerEvent<SVGGElement>, it: Item) => handlers.current.onDown(e, it),
      onKeyOpen: (it: Item) => handlers.current.keyOpen(it),
      onKeyMove: (it: Item, dir: 1 | -1, resize: boolean) => handlers.current.keyMove(it, dir, resize),
      onKeyEnd: (it: Item) => handlers.current.onKeyEnd(it),
      onKeyCancel: (it: Item) => handlers.current.onKeyCancel(it),
      onSuggestion: (it: Item, anchor: { x: number; y: number }) => handlers.current.onSuggestion(it, anchor),
    }),
    [],
  );

  // B2's flags row and any rows of marks under it.
  const rowY = (row: number) => (row === 0 ? MONTH_H + WEEK_H + 2 + 10 : MONTH_H + WEEK_H + FLAG_H + (row - 1) * MARK_ROW + MARK_ROW / 2);
  const legend = <LanesLegend data={data} lanes={lanes} noWork={noWork} />;
  return (
    <div
      className="overflow-hidden rounded-[14px] border border-[var(--simple-rule)] bg-[var(--simple-paper)] pt-[14px] pb-3"
      data-testid="simple-chart"
      data-format="timeline"
      data-view="lanes"
      data-lanes={lane}
    >
      <div ref={box} className="flex">
        <div className="min-w-0 flex-none" style={{ width: LABEL_W }} data-testid="chart-labels">
          <div style={{ height: top }} aria-hidden />
          {lanes.map((l, n) => (
            <div
              key={l.key}
              data-testid={l.kind === "below" ? "below-the-line" : "chart-group"}
              data-lane={l.key}
              data-add-where={dropTargets && lane === "goal" && l.kind === "group" && goalLane(l.key) ? whereAttr("goal", l.key) : undefined}
              data-add-label={l.title}
              style={{ height: geo[n].height }}
              className="flex min-w-0 flex-col justify-center border-t border-[var(--simple-rule)] pr-2.5 pl-4"
            >
              <b className={`text-[15px] leading-5 font-bold ${l.kind === "below" ? "text-text2" : ""}`}>{l.title}</b>
              <small className="text-[12.5px] leading-4 text-text-faint" data-testid="lane-count">
                {l.count} {l.count === 1 ? "item" : "items"}
                {l.kind === "pm" ? " · no engineering" : ""}
              </small>
            </div>
          ))}
        </div>
        <div className="relative min-w-0 flex-1" data-testid="chart-scroll">
          <div className="relative" style={{ width: W, height }}>
            <svg
              ref={(el) => {
                svg.current = el;
                chartRef?.(el);
              }}
              width={W}
              height={height}
              data-testid="chart-svg"
              className="block select-none"
              onPointerMove={onMoveEvt}
              onPointerUp={onUp}
              onPointerCancel={onUp}
              role="img"
              aria-label="Roadmap chart"
            >
              <Defs />
              <rect x={0} y={0} width={W} height={height} fill="var(--simple-paper)" />
              {/* Quick add's drop targets: a quarter's columns (transparent). */}
              {dropTargets &&
                quarters(t0, t1).map((q) => {
                  const x0 = Math.max(0, sc.x(q.start));
                  const x1 = Math.min(W, sc.x(q.end) + sc.px);
                  return x1 > x0 ? <rect key={q.start} data-testid="quarter-drop" data-add-where={whereAttr("quarter", quarterValue(q.start))} data-add-label={q.label} x={x0} y={0} width={x1 - x0} height={height} fill="transparent" /> : null;
                })}
              {/* The months and the weeks over the lanes (B2). */}
              <g data-testid="chart-axis" pointerEvents="none">
                {shownMonths.map((m) => (
                  <text key={m.day} data-testid="axis-tick" x={sc.x(m.day) + 6} y={MONTH_H / 2} dominantBaseline="central" fontSize={13} fontWeight={650} fill="var(--text-faint)">
                    {m.label}
                  </text>
                ))}
                {weekLabels.map((d) => (
                  <text key={d} data-testid="axis-week" x={sc.x(d) + 3} y={MONTH_H + 10} dominantBaseline="central" fontSize={11} fill="var(--text-faint)">
                    {Number(d.slice(8))}
                  </text>
                ))}
              </g>
              {lanes.map((l, n) => (
                <line key={`sep-${l.key}`} x1={0} x2={W} y1={geo[n].top + 0.5} y2={geo[n].top + 0.5} stroke="var(--simple-rule)" strokeWidth={1} pointerEvents="none" />
              ))}
              <Grid months={months} mondays={mondays} sc={sc} top={top} height={height} weeks noWork={noWork} />
              <g data-testid="today-mark" pointerEvents="none">
                <line data-testid="today-line" x1={xt} x2={xt} y1={MONTH_H + WEEK_H - 2} y2={height} stroke="var(--crit)" strokeWidth={2} />
              </g>
              <Marks data={data} marks={marks} sc={sc} rowY={rowY} size={12.5} height={height} poleTop={MONTH_H + WEEK_H + 6} width={W} />
              <Arrows data={data} units={units} y={layout.y} sc={sc} moved={moved} />
              {lanes.map((l, n) =>
                l.units.map((u) => (
                  <Pill
                    key={u.item.id}
                    unit={u}
                    item={u.item}
                    lane={l.key}
                    y={geo[n].top + 4 + l.line[u.row] + 4}
                    sc={sc}
                    width={W}
                    span={moved[u.item.id]}
                    open={open === u.item.id}
                    flash={flash.has(u.item.id)}
                    canDrag={canDrag}
                    cut={l.kind === "below"}
                    place={places.get(u.item.id)}
                    room={roomOf.get(u.item.id) ?? W}
                    fonts={fonts}
                    {...pills}
                  />
                )),
              )}
              <PreviewGhost l={layout} sc={sc} items={items} preview={preview} data={data} inset={{ top: 4, h: BAR_H }} />
              <TodayPill x={xt} y={MONTH_H + 2} />
            </svg>
            <div ref={live} hidden data-testid="drag-live" className="pointer-events-none absolute top-0 left-0 z-20 will-change-transform rounded bg-tip px-2 py-0.5 text-xs whitespace-nowrap text-tip-text" />
            {/* fix4 qa-simple-roadmap-1: a callout under its pill writes its words whole, wrapping
                (its fixes onto a line of their own) instead of cutting them, at its own width up
                to the chart's; its lane's line grows to fit it (callH). */}
            <div
              ref={over}
              className="contents [&_[data-testid=broken-callout]]:w-max [&_[data-testid=broken-callout]]:flex-wrap [&_[data-testid=broken-callout]>span]:max-w-none [&_[data-testid=broken-callout]>span]:overflow-visible [&_[data-testid=broken-callout]>span]:break-words [&_[data-testid=broken-callout]>span]:whitespace-normal"
            >
              {overlay?.(layout, sc)}
            </div>
          </div>
        </div>
      </div>
      {legend}
    </div>
  );
}

type PillProps = {
  unit: Unit;
  /** The unit's item. */
  item: Item;
  /** Its lane's key. */
  lane: string;
  /** The pills' top. */
  y: number;
  sc: Scale;
  width: number;
  span?: [string, string];
  open: boolean;
  flash: boolean;
  canDrag: boolean;
  /** Below the line (cut or merged). */
  cut: boolean;
  /** Its place in the return queue (below the line). */
  place?: number;
  /** fix4 qa-simple-roadmap-2: where the room right of it ends (the next pill in its row, or the chart's edge). */
  room: number;
  /** The web fonts have loaded (the labels are fitted again). */
  fonts: number;
  onDown: (e: ReactPointerEvent<SVGGElement>, item: Item) => void;
  onKeyOpen: (item: Item) => void;
  onKeyMove: (item: Item, dir: 1 | -1, resize: boolean) => void;
  onKeyEnd: (item: Item) => void;
  onKeyCancel: (item: Item) => void;
  onSuggestion: (item: Item, anchor: { x: number; y: number }) => void;
};

/** One item in its lane: its pieces as B2's pills (a planned feature's slices on one row, joined by a dotted line). */
const Pill = memo(function Pill({ unit, item, lane, y, sc, width, span, open, flash, canDrag, cut, place, room, onDown, onKeyOpen, onKeyMove, onKeyEnd, onKeyCancel, onSuggestion }: PillProps) {
  const { pieces } = unit;
  const [start, end] = span ?? barSpan(item);
  const kind = barKind(item);
  const red = broken(item).length > 0;
  const amber = !red && item.flags.length > 0;
  const sliced = planned(item);
  const fixed = closedItem(item) || sliced;
  const box = (p: Piece) => {
    const x = sc.x(p.start);
    // A short piece widens to MIN_PILL_W, but never into the next piece of the same feature.
    const next = pieces.filter((q) => q.start > p.start).map((q) => sc.x(q.start) - 2);
    const room = next.length ? Math.min(...next) - x : Infinity;
    return { x, w: Math.max(Math.min(MIN_PILL_W, room), sc.px, sc.x(p.end) - x + sc.px) };
  };
  const all = pieces.map(box);
  const x0 = Math.min(...all.map((b) => b.x));
  const x1 = Math.max(...all.map((b) => b.x + b.w));
  const s = item.suggestion;
  const left = Math.min(x0, s ? sc.x(s.start_date) : x0) - 14;
  const mark = left >= 10 ? left : Math.min(width - 10, Math.max(sc.x(s?.end_date ?? end), x1) + sc.px + 12);
  // QA2 finding 14: a reader's words, not the API's raw enum (sourceWord, from ./_lib).
  const label = `${item.title}: ${shortDay(start)} to ${shortDay(end)}, ${sourceWord(item.estimated ? "estimated" : item.source)}${red ? ", a broken link" : ""}${sliced ? `, ${item.slices.map((x) => `${x.code} in ${x.milestone} ${x.milestone_name}`).join(", ")}` : ""}${canDrag && sliced && !closedItem(item) ? ". Its dates follow the PRD's plan: change them in the PRD" : ""}${canDrag && !fixed ? ". Arrows move it, Shift+arrows its end, sent when you pause; Escape cancels" : ""}`;
  const strokeOf = (base: string) => (red ? "var(--crit)" : amber ? "var(--warn)" : base);
  const strokeW = red || amber || open ? 2.5 : 1.5;
  // fix4 qa-simple-roadmap-31: the suggestion's outline is drawn under the pill (its fill hides
  // the outline's edges where they cross it), so it never runs over the pill's name.
  const outline = s ? (
    <>
      {/* QA2 finding 49: clamped to the chart's own width, belt-and-braces alongside
       * spanOf (which already grows the chart to fit every suggestion). */}
      {(() => {
        const sx0 = Math.max(0, sc.x(s.start_date));
        const sx1 = Math.min(width, Math.max(sc.x(s.end_date) + sc.px, sx0 + MIN_PILL_W));
        return (
          <rect
            data-testid="suggestion-outline"
            data-item={item.key}
            x={sx0}
            y={y - 3}
            width={Math.max(1, sx1 - sx0)}
            height={BAR_H + 6}
            rx={(BAR_H + 6) / 2}
            fill="none"
            stroke="var(--accent-ink)"
            strokeWidth={1.5}
            strokeDasharray="2 3"
            pointerEvents="none"
          >
            {/* QA2 finding 21: an empty dashed box says what it is on hover. */}
            <title>{`Oracle suggests dates for ${item.title}: ${shortDay(s.start_date)} to ${shortDay(s.end_date)}`}</title>
          </rect>
        );
      })()}
    </>
  ) : null;
  return (
    <g>
      {outline}
      {/* Slices of one feature on the same row: a dotted line between them (B2). */}
      {pieces.slice(1).map((q, n) => {
        const a = all[n];
        const b = all[n + 1];
        if (b.x - (a.x + a.w) < 10) return null;
        return (
          <line
            key={`link-${q.key}`}
            data-testid="slice-connector"
            data-feature={q.slice?.feature_code ?? item.code ?? item.key}
            x1={a.x + a.w + 2}
            x2={b.x - 2}
            y1={y + BAR_H / 2}
            y2={y + BAR_H / 2}
            stroke="var(--line-strong)"
            strokeWidth={2}
            strokeDasharray="2 2"
            pointerEvents="none"
          />
        );
      })}
      <g
        data-testid="bar"
        data-bar-id={item.id}
        data-item={item.key}
        data-kind={closedItem(item) ? "cut" : kind}
        data-broken={red ? "true" : amber ? "amber" : "false"}
        data-start={start}
        data-end={end}
        data-row={unit.row}
        data-lane={lane}
        /* The pill's own drawn bounds in chart pixels (x0/x1 can differ from start/end's scale
         * position once slices are stacked and widened to MIN_PILL_W): a broken-link callout
         * placed beside this bar reads these instead of redoing the scale math. */
        data-x0={x0}
        data-x1={x1}
        data-place={place}
        data-open={open ? "true" : undefined}
        data-flash={flash ? "true" : undefined}
        role="button"
        tabIndex={0}
        aria-label={label}
        className={`${canDrag && !fixed ? "cursor-grab" : "cursor-pointer"} ${flash ? "simple-bar-flash" : ""} outline-none data-[picked=true]:[filter:drop-shadow(0_3px_6px_rgb(0_0_0/0.35))] focus-visible:[filter:drop-shadow(0_0_2px_var(--accent))]`}
        style={{ touchAction: canDrag && !fixed ? "none" : "auto" }}
        onPointerDown={(e) => onDown(e, item)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onKeyOpen(item);
          } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
            e.preventDefault();
            onKeyMove(item, e.key === "ArrowRight" ? 1 : -1, e.shiftKey);
          } else if (e.key === "Escape") onKeyCancel(item);
        }}
        onBlur={() => onKeyEnd(item)}
      >
        {sliced ? (
          <>
            {/* The feature's whole span (its slices draw it). */}
            <rect data-body x={x0} y={y} width={x1 - x0} height={BAR_H} fill="transparent" stroke="none" pointerEvents="none" />
            {pieces.map((p, n) => {
              const b = all[n];
              const c = look(p, item, cut);
              // fix4 qa-simple-roadmap-2/3: the slice's name (never its code), cut with "…" to its pill.
              const words = ellipsize(p.name, b.w - 16, 12, 650);
              return (
                <g
                  key={p.key}
                  data-testid="slice-bar"
                  data-code={p.code ?? undefined}
                  data-milestone={p.milestone ?? undefined}
                  data-start={p.start}
                  data-end={p.end}
                  data-colour={p.pm ? "var(--prd-pm)" : p.milestone ? mLine(p.milestone) : "none"}
                  data-estimated={p.slice?.estimated ? "true" : "false"}
                  data-pm-owned={p.pm ? "true" : undefined}
                >
                  <title>{`${p.name}${p.slice ? ` · ${p.slice.milestone} ${p.slice.milestone_name}` : ""} · ${dm(p.start)} – ${dm(p.end)}${p.pm ? " · PM-owned" : p.slice ? ` · ${p.slice.effort_weeks} engineer-weeks` : ""}${p.slice?.estimated ? " · placed by Oracle" : ""}`}</title>
                  <rect
                    data-slice-body
                    x={b.x + 0.75}
                    y={y + 0.75}
                    width={Math.max(1, b.w - 1.5)}
                    height={BAR_H - 1.5}
                    rx={(BAR_H - 1.5) / 2}
                    fill={c.fill}
                    stroke={strokeOf(c.stroke)}
                    strokeWidth={strokeW}
                    strokeDasharray={c.dash}
                  />
                  {words && (
                    <text data-testid="slice-label" x={b.x + 8.5} y={y + BAR_H / 2} dominantBaseline="central" fontSize={12} fontWeight={650} fill={c.ink} pointerEvents="none">
                      {words}
                    </text>
                  )}
                </g>
              );
            })}
          </>
        ) : (
          <PlainPiece item={item} piece={pieces[0]} b={all[0]} y={y} cut={cut} place={place} stroke={strokeOf} strokeW={strokeW} besideAt={s && mark > x1 ? mark + 12 : x1 + 6} room={room} />
        )}
        {/* fix4 qa-simple-roadmap-4: a track's milestone sits on the pill's top edge at its date,
            above the pill's name, never over it. */}
        {item.milestone?.date && !sliced && (
          <rect
            data-testid="item-milestone"
            x={sc.x(item.milestone.date) - 3.5}
            y={y - 3.5}
            width={7}
            height={7}
            transform={`rotate(45 ${sc.x(item.milestone.date)} ${y})`}
            fill="var(--warn)"
            stroke="var(--simple-paper)"
          >
            <title>{`${item.milestone.name ?? "Milestone"} · ${shortDay(item.milestone.date)}`}</title>
          </rect>
        )}
      </g>
      {s && (
        <g>
          <g
            data-testid="suggestion-open"
            data-item={item.key}
            role="button"
            tabIndex={0}
            aria-label={`Oracle's date suggestion for ${item.title}: ${shortDay(s.start_date)} to ${shortDay(s.end_date)}`}
            className="cursor-pointer"
            transform={`translate(${mark}, ${y + BAR_H / 2})`}
            onClick={() => onSuggestion(item, { x: sc.x(s.start_date), y: y + BAR_H })}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") onSuggestion(item, { x: sc.x(s.start_date), y: y + BAR_H });
            }}
          >
            {/* QA2 finding 21: the lone "?" says what it is on hover, not just to a screen reader. */}
            <title>Oracle suggests dates</title>
            <circle r={9} fill="var(--simple-paper)" stroke="var(--accent-ink)" strokeDasharray="2 2" />
            <text textAnchor="middle" y={4} fontSize={11} fontWeight={700} fill="var(--accent-ink)">
              ?
            </text>
          </g>
        </g>
      )}
    </g>
  );
});

/** An item with no plan as one pill: its title, cut with "…" to the pill, or beside a pill too short for it; a draft says so ("Draft · Setup tips"), a cut item is struck through (its place in the return queue on hover). */
function PlainPiece({ item, piece, b, y, cut, place, stroke, strokeW, besideAt, room }: { item: Item; piece: Piece; b: { x: number; w: number }; y: number; cut: boolean; place?: number; stroke: (base: string) => string; strokeW: number; besideAt: number; room: number }) {
  const c = look(piece, item, cut);
  const draft = item.draft && !cut;
  // fix4 qa-simple-roadmap-3/15: the title alone (no "F-06", no "#1"); a draft's reads "Draft · <title>".
  const full = draft ? `Draft · ${piece.name}` : piece.name;
  // fix4 qa-simple-roadmap-2: inside the pill when a real part of it fits; else beside it, up to the next pill.
  const inner = ellipsize(full, b.w - 16, 12, 650);
  const outer = ellipsize(full, room - besideAt - 4, 12, 600);
  const beside = inner.length < Math.min(full.length, 8) && outer.length > inner.length;
  const words = beside ? outer : inner;
  const w = words ? textWidth(words, 12, beside ? 600 : 650) : 0;
  const tag = draft && words.startsWith("Draft");
  const hover = `${full}${place != null ? ` · ${ordinal(place)} to come back if room opens` : ""}`;
  return (
    <>
      <title>{hover}</title>
      {/* A name beside its pill is part of the pill: the gap and the name take the pill's
          clicks too (the bar's middle never falls through to a quarter's drop target). */}
      {beside && words && <rect data-hit x={b.x} y={y} width={Math.max(b.w, besideAt + w - b.x)} height={BAR_H} fill="transparent" />}
      <rect data-body x={b.x + 0.75} y={y + 0.75} width={Math.max(1, b.w - 1.5)} height={BAR_H - 1.5} rx={(BAR_H - 1.5) / 2} fill={c.fill} stroke={stroke(c.stroke)} strokeWidth={strokeW} strokeDasharray={c.dash} />
      {words && (
        <text
          data-testid="bar-label"
          data-w={w}
          data-beside={beside ? "true" : undefined}
          x={beside ? besideAt : b.x + 8.5}
          y={y + BAR_H / 2}
          dominantBaseline="central"
          fontSize={12}
          fontWeight={beside ? 600 : 650}
          fill={beside ? "var(--text2)" : c.ink}
          pointerEvents="none"
          textDecoration={cut ? "line-through" : undefined}
        >
          {tag ? (
            <>
              <tspan data-testid="draft-tag">Draft</tspan>
              {words.slice(5)}
            </>
          ) : (
            words
          )}
        </text>
      )}
    </>
  );
}

/** The dependencies between items, from a dependency's end to its dependent's start (red when broken, amber when accepted as a risk). */
function Arrows({ data, units, y, sc, moved }: { data: Roadmap; units: Map<string, Unit>; y: Map<string, number>; sc: Scale; moved: Record<string, [string, string]> }) {
  const byId = new Map(data.items.map((i) => [i.id, i]));
  const out: ReactNode[] = [];
  const ends = (id: string): [string, string] | null => {
    const u = units.get(id);
    if (!u) return null;
    return moved[id] ?? [u.pieces[0].start, u.pieces[u.pieces.length - 1].end];
  };
  for (const it of data.items) {
    const ty = y.get(it.id);
    const mine = ends(it.id);
    if (ty == null || !mine) continue;
    for (const depId of it.depends_on) {
      const dep = byId.get(depId);
      const dy = y.get(depId);
      const theirs = ends(depId);
      if (!dep || dy == null || !theirs) continue;
      const flag = it.flags.find((f) => f.kind === "dependency_order" && f.subject === depId);
      const tone = flag ? (flag.state === "red" ? "red" : "amber") : "ok";
      const x1 = sc.x(theirs[1]) + sc.px;
      const y1 = dy + 4 + BAR_H / 2;
      // QA2 finding 40: the arrow used to land exactly on the dependent bar's left edge, its
      // head sitting on top of the pill; stop a few px short so it reads beside the bar.
      const x2 = sc.x(mine[0]) - 3;
      const y2 = ty + 4 + BAR_H / 2;
      const mid = Math.max(x1 + 8, x2 - 8);
      out.push(
        <path
          key={`${depId}-${it.id}`}
          d={`M${x1},${y1} H${mid} V${y2} H${x2}`}
          fill="none"
          data-testid="dep-arrow"
          data-state={tone}
          data-from={dep.key}
          data-to={it.key}
          stroke={tone === "red" ? "var(--crit)" : tone === "amber" ? "var(--warn)" : "var(--line-strong)"}
          strokeWidth={tone === "ok" ? 1.25 : 2}
          strokeDasharray={tone === "amber" ? "4 3" : undefined}
          markerEnd={`url(#lanes-arrow${tone === "red" ? "-red" : tone === "amber" ? "-amber" : ""})`}
          pointerEvents="none"
        />,
      );
    }
  }
  return <g>{out}</g>;
}

/** B2's legend, inside the card: the milestones' hues, PM-owned, Today, the holidays, slices of one feature; then only what else the chart draws. */
function LanesLegend({ data, lanes, noWork }: { data: Roadmap; lanes: LaneModel[]; noWork: { start: string; end: string }[] }) {
  const pieces = lanes.filter((l) => l.kind !== "below").flatMap((l) => l.units.flatMap((u) => u.pieces.map((p) => ({ p, item: u.item }))));
  const codes = [...new Set(pieces.flatMap(({ p }) => (p.milestone && !p.pm ? [p.milestone] : [])))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const plain = pieces.filter(({ p }) => !p.milestone && !p.pm).map(({ item }) => item);
  const sliced = lanes.some((l) => l.units.some((u) => u.pieces.length > 1));
  const sw = "inline-block h-2.5 w-[18px] flex-none rounded-[5px] border-[1.5px]";
  const item = (key: string, swatch: ReactNode, words: string) => (
    <span key={key} className="inline-flex items-center gap-1.5 whitespace-nowrap" data-testid="legend-item">
      {swatch}
      {words}
    </span>
  );
  return (
    <div data-testid="legend" className="flex flex-wrap gap-x-4 gap-y-1.5 px-4 pt-2 text-[13px] leading-[18px] text-text-faint">
      {codes.map((c) => item(c, <i aria-hidden className={sw} style={{ background: mBg(c), borderColor: mLine(c) }} />, c))}
      {pieces.some(({ p }) => p.pm) && item("pm", <i aria-hidden className={`${sw} border-dashed`} style={{ borderColor: "var(--prd-pm)" }} />, "PM-owned, no engineering")}
      {plain.some((i) => barKind(i) === "dated") && item("plain", <i aria-hidden className={sw} style={{ background: "var(--na-bg)", borderColor: "var(--text2)" }} />, "Not in a milestone")}
      {plain.some((i) => barKind(i) === "estimated") &&
        item("estimated", <i aria-hidden className={sw} style={{ background: "repeating-linear-gradient(135deg, var(--line-strong) 0 1.5px, var(--na-bg) 1.5px 5px)", borderColor: "var(--text2)" }} />, "Estimated (the horizon’s window)")}
      {plain.some((i) => barKind(i) === "draft") && item("draft", <i aria-hidden className={`${sw} border-dashed`} style={{ borderColor: "var(--line-strong)" }} />, "Draft")}
      {item("today", <i aria-hidden className="inline-block h-3.5 w-0.5 flex-none bg-crit" />, `Today ${dm(data.today)}`)}
      {noWork.length > 0 &&
        item("holidays", <i aria-hidden className="inline-block h-2.5 w-[18px] flex-none rounded-[2px] opacity-60" style={{ background: "repeating-linear-gradient(135deg, var(--line-strong) 0 1.5px, transparent 1.5px 7px)" }} />, `Holidays ${holidayWords(noWork)}`)}
      {sliced && item("slices", <i aria-hidden className="inline-block w-[18px] flex-none border-t-2 border-dotted border-line-strong" />, "slices of one feature")}
      {data.items.some((i) => i.suggestion && !closedItem(i)) &&
        item("suggestion", <i aria-hidden className="inline-block h-2.5 w-[18px] flex-none rounded-[5px] border-[1.5px] border-dotted border-accent-ink" />, "Oracle’s date suggestion (? opens it)")}
      {(data.key_dates?.length ?? 0) > 0 && item("key", <i aria-hidden className="inline-block h-2 w-2 flex-none rotate-45 bg-accent-ink" />, "Key date")}
      {data.milestones.some((m) => m.date && !(m.start_date && m.end_date)) && item("track", <i aria-hidden className="inline-block h-2 w-2 flex-none rotate-45 bg-warn" />, "A track’s milestone")}
      {data.items.some((i) => broken(i).length && !closedItem(i)) && item("broken", <i aria-hidden className={sw} style={{ borderColor: "var(--crit)", borderWidth: 2 }} />, "A broken link")}
      {/* QA2 finding 40: the amber dependency arrow (accepted as a risk) had no legend entry of its own. */}
      {data.items.some((i) => i.flags.some((f) => f.kind === "dependency_order" && f.state !== "red")) &&
        item("dep-amber", <i aria-hidden className="inline-block h-0.5 w-[18px] flex-none bg-warn" />, "Dependency order accepted as a risk (amber arrow)")}
    </div>
  );
}

// ---------------------------------------------------------------- B3: the phone

/** A run of one milestone's work in a lane (a gap of more than two weeks starts a new one), as B3's thin bar. */
type Run = { key: string; milestone: string | null; pm: boolean; plain: Item | null; start: string; end: string; row: number; names: string[] };

function runsOf(l: LaneModel): { runs: Run[]; rows: number } {
  const by = new Map<string, { p: Piece; item: Item }[]>();
  for (const u of l.units)
    for (const p of u.pieces) {
      const k = l.kind === "below" ? "cut" : p.pm ? "pm" : (p.milestone ?? `plain:${barKind(u.item)}`);
      by.set(k, [...(by.get(k) ?? []), { p, item: u.item }]);
    }
  const runs: Run[] = [];
  for (const [k, ps] of by) {
    let cur: Run | null = null;
    for (const { p, item } of [...ps].sort((a, b) => ms(a.p.start) - ms(b.p.start))) {
      if (cur && ms(p.start) - ms(cur.end) <= 14 * DAY) {
        if (p.end > cur.end) cur.end = p.end;
        if (!cur.names.includes(p.name)) cur.names.push(p.name);
        continue;
      }
      cur = { key: `${k}:${p.start}`, milestone: p.milestone, pm: p.pm, plain: p.milestone || p.pm ? null : item, start: p.start, end: p.end, row: 0, names: [p.name] };
      runs.push(cur);
    }
  }
  // B3 draws a lane's runs on one line; runs that run at once take a second (B's stacking).
  runs.sort((a, b) => ms(a.start) - ms(b.start));
  const rows: [number, number][][] = [];
  for (const r of runs) {
    let n = rows.findIndex((row) => row.every(([a, b]) => ms(r.end) < a || ms(r.start) > b));
    if (n < 0) {
      n = rows.length;
      rows.push([]);
    }
    rows[n].push([ms(r.start), ms(r.end)]);
    r.row = n;
  }
  return { runs, rows: Math.max(1, rows.length) };
}

function PhoneLanes({ data, lane, open, onOpen, chartRef, noWork = [], moved }: LanesProps) {
  const [box, boxW] = useWidth(332);
  const fonts = useFontsReady();
  const W = boxW;
  const { lanes } = useMemo(() => laneModels(data, lane, moved), [data, lane, moved]);
  // fix4 qa-simple-roadmap-45: ten days before the first date, so Today's line and a key date's
  // (often the first dates) stand clear of the chart's left edge and of where the bars start.
  const { t0, t1 } = useMemo(() => spanOf(data, lanes.flatMap((l) => l.units), [], 10), [data, lanes]);
  const sc = useMemo(() => scale(t0, addDays(t1, -1), W / daysBetween(t0, t1)), [t0, t1, W]);
  const { months } = useMemo(() => calendar(t0, t1), [t0, t1]);
  const marks = useMarks(data, sc, W, true, fonts);
  const markRows = Math.max(1, ...marks.map((m) => m.row + 1));
  const axisH = P_TODAY_H + P_MONTH_H;
  const top = axisH + P_FLAG_H + (markRows - 1) * P_MARK_ROW;
  // B3 opens the lane with the most work (its "Conversion opened"); a tap opens another.
  const [picked, setPicked] = useState<string | null>(null);
  const fallback = [...lanes].sort((a, b) => b.count - a.count)[0]?.key ?? null;
  const openKey = picked && lanes.some((l) => l.key === picked) ? picked : fallback;
  const runs = useMemo(() => lanes.map(runsOf), [lanes]);
  const geo = useMemo(() => {
    const out: { top: number; head: number; bars: number; height: number }[] = [];
    lanes.forEach((l, n) => {
      const prev = out[out.length - 1];
      const y = prev ? prev.top + prev.height : top;
      const head = l.key === openKey ? 20 : 18;
      out.push({ top: y, head, bars: y + 8 + head + 4, height: 8 + head + 4 + runs[n].rows * P_BAR_ROW });
    });
    return out;
  }, [lanes, runs, top, openKey]);
  const height = geo.length ? geo[geo.length - 1].top + geo[geo.length - 1].height : top;
  const xt = sc.x(data.today) + sc.px / 2;
  const shownMonths = monthLabels(months, sc, W);
  const rowY = (row: number) => (row === 0 ? axisH + P_FLAG_H / 2 : axisH + P_FLAG_H + (row - 1) * P_MARK_ROW + P_MARK_ROW / 2);
  const openLane = lanes.find((l) => l.key === openKey) ?? null;
  const rows = openLane
    ? openLane.units
        .flatMap((u) => u.pieces.map((p) => ({ p, item: u.item })))
        .sort((a, b) => ms(a.p.start) - ms(b.p.start) || ms(b.p.end) - ms(a.p.end) || (a.p.code ?? a.p.name).localeCompare(b.p.code ?? b.p.name))
    : [];
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-[14px] border border-[var(--simple-rule)] bg-[var(--simple-paper)] p-3" data-testid="simple-chart" data-format="timeline" data-view="lanes-phone" data-lanes={lane}>
        <div ref={box}>
          <svg ref={(el) => chartRef?.(el)} width={W} height={height} data-testid="chart-svg" className="block select-none" role="group" aria-label="Roadmap chart">
            <Defs />
            <rect x={0} y={0} width={W} height={height} fill="var(--simple-paper)" />
            <g data-testid="chart-axis" pointerEvents="none">
              {shownMonths.map((m) => (
                <text key={m.day} data-testid="axis-tick" x={sc.x(m.day) + 6} y={P_TODAY_H + P_MONTH_H / 2} dominantBaseline="central" fontSize={13} fontWeight={650} fill="var(--text-faint)">
                  {m.label}
                </text>
              ))}
            </g>
            <Grid months={months} mondays={[]} sc={sc} top={axisH} height={height} weeks={false} noWork={noWork} />
            <g data-testid="today-mark" pointerEvents="none">
              {/* QA2 finding 18: the line used to start inside the month row (y=20), drawing
               * straight through the month label's text; B2's own line only starts once its
               * header rows are behind it, so B3's does too. */}
              <line data-testid="today-line" x1={xt} x2={xt} y1={axisH} y2={height} stroke="var(--crit)" strokeWidth={2} />
            </g>
            <Marks data={data} marks={marks} sc={sc} rowY={rowY} size={11.5} height={height} poleTop={axisH + 4} width={W} />
            {lanes.map((l, n) => {
              const g = geo[n];
              const on = l.key === openKey;
              const name = textWidth(l.title, 14, 700);
              const count = `${l.count} ${l.count === 1 ? "item" : "items"}`;
              const words = name + 4 + textWidth(count, 12.5, 400);
              const chipW = textWidth("open below", 12, 650) + 16;
              const midY = g.top + 8 + g.head / 2;
              return (
                <g
                  key={l.key}
                  data-testid="phone-lane"
                  data-lane={l.key}
                  data-items={l.units.map((u) => u.item.key).join(" ")}
                  data-open={on ? "true" : undefined}
                  role="button"
                  tabIndex={0}
                  // qa-shell-25: the lane is named as it reads ("Grow retention, 4 items").
                  aria-label={`${l.title}, ${count}`}
                  aria-expanded={on}
                  aria-controls="lane-list"
                  className="cursor-pointer outline-none focus-visible:[filter:drop-shadow(0_0_2px_var(--accent))]"
                  onClick={() => setPicked(l.key)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setPicked(l.key);
                    }
                  }}
                >
                  {/* QA2 finding 6: a hover/long-press title carries the lane's full name even
                   * if a very narrow phone ever squeezes the drawn text against its neighbours. */}
                  <title>{l.title}</title>
                  <rect x={0} y={g.top} width={W} height={g.height} fill="transparent" />
                  {/* The lane's name on the paper (the lines run behind it, B3). */}
                  <rect x={0} y={midY - 9} width={words + 4} height={18} rx={4} fill="var(--simple-paper)" />
                  <text y={midY} dominantBaseline="central" fill="var(--text)">
                    <tspan fontSize={14} fontWeight={700} data-testid="phone-lane-name">
                      {l.title}
                    </tspan>
                    <tspan dx={4} fontSize={12.5} fill="var(--text-faint)" data-testid="lane-count">
                      {count}
                    </tspan>
                  </text>
                  {on && (
                    <g data-testid="lane-open-chip">
                      <rect x={W - chipW} y={midY - 10} width={chipW} height={20} rx={10} fill="var(--accent-soft)" />
                      <text x={W - chipW / 2} y={midY} textAnchor="middle" dominantBaseline="central" fontSize={12} fontWeight={650} fill="var(--accent-ink)">
                        open below
                      </text>
                    </g>
                  )}
                  {runs[n].runs.map((r) => {
                    const c = look(r, r.plain, l.kind === "below");
                    const x = sc.x(r.start);
                    const w = Math.max(MIN_RUN_W, sc.px, sc.x(r.end) - x + sc.px);
                    return (
                      <rect
                        key={r.key}
                        data-testid="lane-run"
                        data-milestone={r.milestone ?? undefined}
                        data-pm-owned={r.pm ? "true" : undefined}
                        data-start={r.start}
                        data-end={r.end}
                        x={x + 0.75}
                        y={g.bars + r.row * P_BAR_ROW + 0.75}
                        width={Math.max(1, w - 1.5)}
                        height={P_BAR_H - 1.5}
                        rx={(P_BAR_H - 1.5) / 2}
                        fill={c.fill}
                        stroke={c.stroke}
                        strokeWidth={1.5}
                        strokeDasharray={c.dash}
                      >
                        {/* fix4 review (qa-simple-roadmap-2): B3's thin bar carries no words; it names its items on a long press, hover and to a screen reader. */}
                        <title>{r.names.join(", ")}</title>
                      </rect>
                    );
                  })}
                </g>
              );
            })}
            <TodayPill x={xt} y={2} />
          </svg>
        </div>
      </div>
      {openLane && (
        <section id="lane-list" data-testid="lane-list" data-lane={openLane.key} aria-label={openLane.title} className="flex flex-col gap-0.5 rounded-[14px] border border-[var(--simple-rule)] bg-[var(--simple-paper)] p-3">
          <div className="flex items-baseline gap-2">
            <b className="text-[16px] leading-6 font-bold">{openLane.title}</b>
            {/* fix4 qa-simple-roadmap-45: "at once" counts the lane's bars as drawn (its rows of runs), not its pieces. */}
            <span className="text-[14px] leading-5 text-text-faint" data-testid="lane-list-count">
              {openLane.count} {openLane.count === 1 ? "item" : "items"}, up to {runs[lanes.indexOf(openLane)]?.rows ?? 1} at once
            </span>
          </div>
          <ul>
            {rows.map(({ p, item }) => {
              const red = broken(item);
              const c = look(p, item, closedItem(item));
              return (
                <li key={p.key} className="border-t border-[var(--simple-rule)] first:border-t-0">
                  <button
                    type="button"
                    data-testid="lane-row"
                    data-bar-id={item.id}
                    data-item={item.key}
                    data-code={p.code ?? undefined}
                    data-open={open === item.id ? "true" : undefined}
                    onClick={() => onOpen(item, { x: 0, y: 0 })}
                    className={`grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 py-1.5 text-left text-[14px] leading-[19px] ${open === item.id ? "bg-accent-soft" : ""}`}
                  >
                    {p.code ? <span className="rounded-[6px] border border-line bg-surface2 px-[5px] font-mono text-[12px] leading-[17px] font-semibold whitespace-nowrap text-text">{p.code}</span> : <span />}
                    <span className={`min-w-0 ${closedItem(item) ? "text-text2 line-through" : ""}`}>
                      {p.name}
                      {item.draft && !closedItem(item) && <span className="ml-1.5 rounded-full bg-na-bg px-1.5 text-xs text-na" data-testid="draft-tag">Draft</span>}
                    </span>
                    <span className={`text-[12.5px] whitespace-nowrap ${red.length ? "font-[650] text-crit" : "text-text-faint"}`} title={red[0]?.reason}>
                      <i aria-hidden className="mr-[5px] inline-block h-[9px] w-[9px] rounded-full align-[0]" style={p.pm || !p.milestone ? { border: `1.5px ${p.pm || c.dash ? "dashed" : "solid"} ${c.stroke}`, background: p.pm ? "transparent" : c.fill } : { background: mLine(p.milestone) }} />
                      {red.length ? "⚠ " : ""}
                      {dm(p.start)} – {dm(p.end)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
