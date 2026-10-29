"use client";

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { APPLIED_EVENT, lastPreview, PREVIEW_EVENT, type AppliedDetail, type ChatPreview, type PreviewDetail } from "@/lib/api/simple-chat";

import {
  addDays,
  barKind,
  barSpan,
  broken,
  closedItem,
  daysBetween,
  liveBreaks,
  milestonePrd,
  milestoneWords,
  ms,
  planMilestones,
  planPrds,
  currentMilestone,
  phaseWord,
  quarters,
  rephase,
  quarterValue,
  scale,
  shortDay,
  sourceWord,
  type Format,
  type GanttUnit,
  type Item,
  type Lane,
  type Roadmap,
  type Scale,
  whereAttr,
} from "./_lib";

/** One row of the chart: a group's heading (its metric line) or an item. */
export type Row = { kind: "group"; key: string; title: string; metric: string | null; below?: boolean; count?: number } | { kind: "item"; item: Item; place?: number };

export interface Layout {
  rows: Row[];
  rowH: number;
  labelW: number;
  top: number;
  height: number;
  y: Map<string, number>;
}

/** The header above the rows (roadmap-milestones D): the ticks' line, then a line per row of marks
 * (milestone ends, key dates, track milestones, Today), then a gap: 54 px with one row of marks. */
const TICK_H = 30;
const MARK_ROW = 16;
const headerHeight = (markRows: number) => TICK_H + Math.max(1, markRows) * MARK_ROW + 8;
const AXIS_H = headerHeight(1);
const LONG_PRESS_MS = 450;
/** A bar's narrowest width, however short its span or far the scale is zoomed out: it stays a
 * visible, clickable shape beside its label rather than a blob a few pixels wide (finding 11). */
const MIN_BAR_W = 24;

/** The rows: each group with its items (cut items below the line, in their return-queue order). */
export function layout(data: Roadmap, compact: boolean, lane: Lane = data.group, top = AXIS_H): Layout {
  const byId = new Map(data.items.map((i) => [i.id, i]));
  const rows: Row[] = [];
  const below: Item[] = [];
  for (const g of data.groups) {
    const items = g.item_ids.map((id) => byId.get(id)).filter((i): i is Item => !!i);
    const live = items.filter((i) => !closedItem(i));
    below.push(...items.filter((i) => closedItem(i)));
    if (!live.length) continue;
    const metric = live.find((i) => i.goal?.metric)?.goal?.metric ?? null;
    rows.push({ kind: "group", key: g.key, title: g.title, metric: lane === "goal" ? metric : null, count: live.length });
    for (const item of live) rows.push({ kind: "item", item });
  }
  if (below.length) {
    rows.push({ kind: "group", key: "below-the-line", title: "Below the line", metric: null, below: true });
    below.forEach((item, n) => rows.push({ kind: "item", item, place: n + 1 }));
  }
  const rowH = compact ? 30 : 36;
  const y = new Map<string, number>();
  rows.forEach((r, n) => {
    if (r.kind === "item") y.set(r.item.id, top + n * rowH);
  });
  // fix2-simple-roadmap-gantt: a phone's label column is wide enough for a name, its chips and
  // a return place without squeezing the name to nothing (findings 6, 7).
  return { rows, rowH, labelW: compact ? 152 : 248, top, height: top + rows.length * rowH + 8, y };
}

/** A label's width in the chart's type (a canvas measures it; an estimate before there is one). */
let measure: CanvasRenderingContext2D | null | undefined;
let family = "";
function textWidth(s: string, size: number, weight: number): number {
  if (typeof document !== "undefined") {
    if (measure === undefined) measure = document.createElement("canvas").getContext("2d");
    if (measure) {
      family ||= getComputedStyle(document.body).fontFamily;
      measure.font = `${weight} ${size}px ${family}`;
      // A little room for a web font still loading (its fallback may be narrower).
      return Math.ceil(measure.measureText(s).width * 1.06) + 2;
    }
  }
  return Math.ceil(s.length * size * 0.64);
}

/** A mark on the time axis: a milestone's end, a key date, a track milestone or Today. */
export type Mark = {
  key: string;
  kind: "end" | "key" | "track" | "today";
  x: number;
  /** The words drawn beside it ("" draws none). */
  words: string;
  /** Its words before (left of) or after (right of) its glyph. */
  side: "before" | "after";
  /** Its row in the header (0: the first under the ticks); marks never share a row where their words would touch. */
  row: number;
  w: number;
  /** Its glyph and words, left to right. */
  box: [number, number];
};

const GLYPH: Record<Mark["kind"], number> = { end: 9, key: 7, track: 7, today: 1 };

/** The marks' rows: each mark takes the first row where its glyph and words touch no other's; words
 * that would run off the chart go on the glyph's other side. Labels never overlap (roadmap-milestones). */
export function placeMarks(marks: Omit<Mark, "row" | "w" | "box">[], width: number, flags = false, size = 11): Mark[] {
  const rows: [number, number][][] = [];
  const out: Mark[] = [];
  for (const m of marks) {
    if (m.x < -1 || m.x > width + 1) continue;
    const w = m.words ? textWidth(m.words, m.kind === "today" ? 10 : size, 700) : 0;
    const g = GLYPH[m.kind];
    // Today's pill: 38 px right of the line (left of it at the chart's right edge). The
    // Timeline's milestone end is a flag and its words beside the line (timeline-overlap B2).
    const box = (side: Mark["side"]): [number, number] =>
      m.kind === "today"
        ? side === "after"
          ? [m.x - 1, m.x + (w ? 41 : 1)]
          : [m.x - (w ? 41 : 1), m.x + 1]
        : m.kind === "end" && flags
          ? side === "before"
            ? [m.x - 18 - w, m.x]
            : [m.x, m.x + 18 + w]
          : side === "before"
            ? [m.x - g - 2 - w, m.x + g]
            : [m.x - g, m.x + g + 2 + w];
    let side = m.side;
    const [a, b] = box(side);
    if (side === "before" && a < 0) side = "after";
    else if (side === "after" && b > width) side = "before";
    const [x0, x1] = box(side);
    let row = 0;
    while (rows[row]?.some(([p, q]) => p < x1 + 6 && x0 < q + 6)) row++;
    (rows[row] ??= []).push([x0, x1]);
    out.push({ ...m, side, row, w, box: [x0, x1] });
  }
  return out;
}

/** A milestone's colour (M1 blue, M2 violet, M3 amber, then round again): the PRD timeline's edge tokens. */
export const msEdge = (code: string): string => `var(--simple-m${((Number(code.replace(/\D/g, "")) || 1) - 1) % 3 + 1}-edge)`;
/** Its words' colour: the edge darkened (light) or lightened (dark) toward the text for contrast. */
export const msInk = (code: string): string => `color-mix(in srgb, ${msEdge(code)} 70%, var(--text))`;
/** Its pale fill (the Timeline's pieces). */
export const msFill = (code: string): string => `color-mix(in srgb, ${msEdge(code)} 16%, var(--surface))`;

/** The waterfall's phases in order, each with its colour (solid: a milestone or gate dates
 * it; hatched: estimated from the bar's split). */
export const PHASES: { key: Item["phases"][number]["key"]; label: string; ink: string; soft: string }[] = [
  { key: "discover", label: "Discover", ink: "var(--na)", soft: "var(--na-bg)" },
  { key: "build", label: "Build", ink: "var(--accent)", soft: "var(--accent-soft)" },
  { key: "beta", label: "Beta", ink: "var(--warn)", soft: "var(--warn-bg)" },
  { key: "launch", label: "Launch", ink: "var(--pass)", soft: "var(--pass-bg)" },
];

/** The chart's span and pixels per day: the timeline and the waterfall fit their quarters to
 * the width; the Gantt is a day or week scale around the items, scrolling sideways. */
export function chartScale(data: Roadmap, format: Format, unit: GanttUnit, width: number, weeks = false): { scale: Scale; ticks: { day: string; label: string; major: boolean }[] } {
  const starts = data.items.map((i) => i.start.date).concat(data.today);
  const ends = data.items.map((i) => i.end.date).concat(data.today);
  const lo = starts.reduce((a, b) => (a < b ? a : b));
  const hi = ends.reduce((a, b) => (a > b ? a : b));
  if (weeks) unit = "week";
  if (format !== "gantt" && !weeks) {
    const qs = quarters(lo < data.windows.now.start ? lo : data.windows.now.start, hi);
    const s = qs[0].start;
    const e = qs[qs.length - 1].end;
    const px = Math.max(0.5, width / (daysBetween(s, e) + 1));
    return { scale: scale(s, e, px), ticks: qs.map((q) => ({ day: q.start, label: q.label, major: true })) };
  }
  const ticks: { day: string; label: string; major: boolean }[] = [];
  if (unit === "week") {
    // roadmap-milestones D: whole weeks, Monday to Sunday, from the first item's week to the last
    // one's; on a desktop they share the chart's width (a long span scrolls), on a phone a week
    // is 52.5 px and the weeks scroll sideways. A month's first week draws a stronger line.
    const s = addDays(lo, -((new Date(ms(lo)).getUTCDay() + 6) % 7));
    const e = addDays(hi, (7 - new Date(ms(hi)).getUTCDay()) % 7);
    const days = daysBetween(s, e) + 1;
    // A span that fits at 5 px a day or more fills the width; a longer one scrolls at 7 px a day.
    const sc = scale(s, e, weeks ? 7.5 : width / days >= 5 ? Math.min(14, width / days) : 7);
    for (let d = s, n = 0; d <= e && n < 600; d = addDays(d, 7), n++) ticks.push({ day: d, label: shortDay(d), major: new Date(ms(d)).getUTCDate() <= 7 });
    return { scale: sc, ticks };
  }
  const s = addDays(lo, -7);
  const e = addDays(hi, 7);
  const sc = scale(s, e, 26);
  for (let d = s, n = 0; d <= e && n < 2000; d = addDays(d, 1), n++) {
    const date = new Date(ms(d));
    ticks.push({ day: d, label: String(date.getUTCDate()), major: date.getUTCDate() === 1 || date.getUTCDay() === 1 });
  }
  return { scale: sc, ticks };
}

export interface ChartProps {
  data: Roadmap;
  format: Format;
  unit: GanttUnit;
  compact: boolean;
  /** People who may change things drag; viewers read. */
  canDrag: boolean;
  /** Bars moved (a drag, or the keyboard's burst not sent yet) and waiting for the change's answer (drawn at their new dates). */
  moved: Record<string, [string, string]>;
  open: string | null;
  onOpen: (item: Item, anchor: { x: number; y: number }) => void;
  onMove: (item: Item, start: string, end: string) => void;
  /** The keyboard: a press moves the bar locally (the burst is sent on a pause or blur), Escape cancels it. */
  onKeyMove: (item: Item, start: string, end: string) => void;
  onKeyEnd: (item: Item) => void;
  onKeyCancel: (item: Item) => void;
  onSuggestion: (item: Item, anchor: { x: number; y: number }) => void;
  /** HTML drawn over the chart (callouts, popovers, the card), in chart pixels. */
  overlay?: (l: Layout, sc: Scale) => ReactNode;
  chartRef?: (el: SVGSVGElement | null) => void;
  /** S7: quick add's drop targets (the quarter columns and the goal headers). */
  dropTargets?: boolean;
  /** roadmap-gantt: what the rows sit under (the data's groups are already these lanes). */
  lane?: Lane;
  /** The plan's no-work weeks (holidays), drawn grey. */
  noWork?: { start: string; end: string; label?: string | null }[];
  /** roadmap-milestones D3: on a phone, the milestone whose end is off screen to the right ("M3"), as the chart scrolls (null: none). */
  onOffscreen?: (code: string | null) => void;
  /** roadmap-milestones D: items pulled into another horizon by a change still waiting for its decider ("pending", amber). */
  pulled?: ReadonlySet<string>;
}

/** An item the plan dates by its slices: drawn one bar per slice, its dates the plan's (not dragged). */
const planned = (i: Item): boolean => i.slices.some((x) => x.start_date && x.end_date);
/** A milestone's code from its name ("M2 · Scale volume": "M2"). */
const codeOf = (name: string): string => name.split(/[\s·]/)[0];

const LANE_WORDS: Record<Lane, string> = { goal: "Goal", milestone: "Milestone", track: "Track", prd: "PRD" };
/** A goal lane the API names (its key is a goal's id): quick add and the suggestions button work on it. */
const goalLane = (key: string) => key !== "none" && !key.startsWith("plan-goal:");

type Drag = {
  id: string;
  mode: "move" | "start" | "end";
  x0: number;
  start: string;
  end: string;
  dx: number;
  moved: boolean;
  frame: number | null;
  pointer: number;
  touch: boolean;
  armed: boolean;
  timer: number | null;
};

declare global {
  interface Window {
    /** A spec sets it to an array to collect the drag's frame times (ms between frames). */
    __poDragFrames?: number[];
    /** And this one for the time each pointer move took to handle (ms). */
    __poDragWork?: number[];
  }
}

export function Chart({ data, format, unit, compact, canDrag, moved, open, onOpen, onMove, onKeyMove, onKeyEnd, onKeyCancel, onSuggestion, overlay, chartRef, dropTargets, lane = data.group, noWork = [], onOffscreen, pulled }: ChartProps) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const flash = useAppliedFlash();
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(240, el.clientWidth - 2)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // A phone's chart of planned work scrolls sideways by weeks (the names stay pinned on the left).
  const weeks = compact && format !== "waterfall" && data.items.some((i) => i.slices.length > 0);
  const { scale: sc, ticks } = useMemo(() => chartScale(data, format, unit, width, weeks), [data, format, unit, width, weeks]);
  const axisFormat: Format = weeks ? "gantt" : format;
  // roadmap-milestones D: the Gantt draws one bar per slice in the accent, labelled with its code.
  const gantt = format === "gantt";
  // timeline-overlap B2: the Timeline marks a milestone's end with a flag (the Gantt, D: a diamond).
  const flags = format === "timeline";
  const chartW = sc.width;
  // The marks on the time axis, in rows that keep their words apart (Today first, then the
  // milestone ends, the tracks' milestones and the key dates).
  const marks = useMemo(() => {
    const many = planPrds(data).size > 1;
    // A phone draws Today as its line only (D3).
    const list: Omit<Mark, "row" | "w" | "box">[] = compact ? [] : [{ key: "today", kind: "today", x: sc.x(data.today), words: "Today", side: "after" }];
    for (const m of planMilestones(data)) {
      const prd = many ? milestonePrd(data, m) : null;
      const code = `${codeOf(m.name)}${prd ? ` ${prd.title}` : ""}`;
      list.push({ key: `end-${m.id}`, kind: "end", x: sc.x(m.end_date!) + sc.px, words: compact ? `${code} ends` : `${code} ends ${shortDay(m.end_date!)}`, side: "before" });
    }
    for (const m of data.milestones.filter((x) => x.date && !(x.start_date && x.end_date))) list.push({ key: `track-${m.id}`, kind: "track", x: sc.x(m.date!), words: m.name, side: "after" });
    for (const k of data.key_dates ?? []) list.push({ key: `key-${k.id}`, kind: "key", x: sc.x(k.date) + sc.px / 2, words: k.name, side: "after" });
    // finding 18: pack rows in date order left to right, so a later mark never takes a lower
    // row an earlier one needed (the list above is built milestone-ends, then tracks, then key
    // dates, not by date).
    return placeMarks([...list].sort((a, b) => a.x - b.x), chartW, flags);
  }, [data, sc, chartW, compact, flags]);
  const top = headerHeight(Math.max(0, ...marks.map((m) => m.row + 1)));
  const l = useMemo(() => layout(data, compact, lane, top), [data, compact, lane, top]);
  // findings 15/16: a row's code is a tooltip, not a visible prefix (some items have none, and
  // a repeated code on two items would read as the same thing twice); it only ever shows when
  // every row's code is its own.
  const codeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of l.rows) if (r.kind === "item" && r.item.code) counts.set(r.item.code, (counts.get(r.item.code) ?? 0) + 1);
    return counts;
  }, [l.rows]);
  // D3: on a phone, which milestone ends off screen to the right ("Swipe sideways for M3").
  useEffect(() => {
    const el = box.current;
    if (!el || !onOffscreen) return;
    const ends = planMilestones(data).map((m) => ({ code: codeOf(m.name), x: sc.x(m.end_date!) + sc.px }));
    const tell = () => onOffscreen(compact ? (ends.find((e) => e.x > el.scrollLeft + el.clientWidth)?.code ?? null) : null);
    tell();
    el.addEventListener("scroll", tell, { passive: true });
    return () => el.removeEventListener("scroll", tell);
  }, [data, sc, compact, onOffscreen, width]);
  // The current milestone scrolled into view once per format (where the chart scrolls). A
  // desktop Gantt also opens scrolled here (finding 8/38): its day scale spans every item's
  // whole date range, so without this it can open on a window where most rows show no bar.
  const scrolled = useRef("");
  const current = currentMilestone(data);
  useEffect(() => {
    const el = box.current;
    const key = `${format}:${unit}:${weeks}`;
    if (!el || !current?.start_date || scrolled.current === key || !(weeks || format === "gantt")) return;
    scrolled.current = key;
    el.scrollLeft = Math.max(0, sc.x(current.start_date) - 16);
  }, [format, unit, weeks, compact, current, sc]);
  const items = useMemo(() => new Map(data.items.map((i) => [i.id, i])), [data]);
  const svg = useRef<SVGSVGElement | null>(null);
  const live = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

  // Drag: the bar moves under the pointer by direct DOM writes (no React render per move);
  // the change goes to the engine on release.
  const paint = () => {
    const d = drag.current;
    if (!d) return;
    d.frame = null;
    const t0 = performance.now();
    const g = svg.current?.querySelector<SVGGElement>(`g[data-bar-id="${d.id}"]`);
    if (!g) return;
    const days = Math.round(d.dx / sc.px);
    const start = d.mode === "end" ? d.start : addDays(d.start, days);
    const end = d.mode === "start" ? d.end : addDays(d.end, days);
    const s = start > end ? end : start;
    const e = end < start ? start : end;
    const x = sc.x(s);
    const w = Math.max(MIN_BAR_W, sc.x(e) - x + sc.px);
    const rect = g.querySelector<SVGRectElement>("rect[data-body]");
    rect?.setAttribute("x", String(x));
    rect?.setAttribute("width", String(w));
    const it = items.get(d.id);
    if (format === "waterfall" && it) drawPhases(g, rephase(it, s, e), sc, x, w);
    g.dataset.dragStart = s;
    g.dataset.dragEnd = e;
    const breaks = liveBreaks(items, d.id, s, e);
    g.dataset.live = breaks.length ? "broken" : "ok";
    rect?.setAttribute("stroke", breaks.length ? "var(--crit)" : "var(--accent-ink)");
    if (live.current) {
      live.current.hidden = false;
      live.current.textContent = `${shortDay(s)} – ${shortDay(e)}${breaks.length ? ` · ${breaks[0]}` : " · no broken links"}`;
      live.current.dataset.state = breaks.length ? "broken" : "ok";
      live.current.style.left = `${Math.min(x, sc.width - 280)}px`;
      live.current.style.top = `${(l.y.get(d.id) ?? 0) - 24}px`;
    }
    window.__poDragWork?.push(performance.now() - t0);
  };

  const frames = useRef<{ last: number; raf: number | null }>({ last: 0, raf: null });
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

  const onDown = (e: ReactPointerEvent<SVGGElement>, item: Item) => {
    if (e.button !== 0) return;
    const [start, end] = moved[item.id] ?? barSpan(item);
    const r = (e.currentTarget.querySelector("rect[data-body]") as SVGRectElement).getBoundingClientRect();
    const edge = Math.min(10, r.width / 4);
    // The waterfall moves the whole item (its phases follow); the timeline and Gantt also stretch an end.
    const mode = !canDrag || closedItem(item) || planned(item) || format === "waterfall" ? "move" : e.clientX - r.left < edge ? "start" : r.right - e.clientX < edge ? "end" : "move";
    const touch = e.pointerType === "touch";
    // React clears currentTarget once the handler returns: keep the bar for the timeout.
    const target = e.currentTarget;
    const d: Drag = { id: item.id, mode, x0: e.clientX, start, end, dx: 0, moved: false, frame: null, pointer: e.pointerId, touch, armed: !touch, timer: null };
    drag.current = d;
    if (touch && canDrag && !closedItem(item) && !planned(item)) {
      // Phone: a long press picks the bar up; moving first scrolls.
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
    if (!canDrag || (it0 && (closedItem(it0) || planned(it0)))) return;
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
    const item = items.get(d.id);
    if (!item) return;
    const g = svg.current?.querySelector<SVGGElement>(`g[data-bar-id="${d.id}"]`);
    g?.removeAttribute("data-picked");
    if (!d.moved) {
      const y = l.y.get(d.id) ?? 0;
      onOpen(item, { x: sc.x(d.start), y: y + l.rowH });
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
      const w0 = Math.max(MIN_BAR_W, sc.x(d.end) - x0 + sc.px);
      rect?.setAttribute("x", String(x0));
      rect?.setAttribute("width", String(w0));
      if (format === "waterfall") drawPhases(g, moved[item.id] ? rephase(item, d.start, d.end) : item.phases, sc, x0, w0);
    }
  };

  const keyOpen = (it: Item) => onOpen(it, { x: sc.x((moved[it.id] ?? barSpan(it))[0]), y: (l.y.get(it.id) ?? 0) + l.rowH });
  // The keyboard's drag: an arrow moves a focused bar by a day (the Gantt's day scale) or a
  // week; Shift+arrow moves only its end. Each press builds on the last one's local move;
  // the burst is one change (onKeyMove's caller sends it on a pause or blur).
  const keyMove = (it: Item, dir: 1 | -1, resize: boolean) => {
    if (!canDrag || closedItem(it) || planned(it)) return;
    const [s, e] = moved[it.id] ?? barSpan(it);
    // The waterfall moves the whole item: Shift+arrow moves it too.
    if (format === "waterfall") resize = false;
    const n = dir * (format === "gantt" && unit === "day" ? 1 : 7);
    const end = addDays(e, n);
    if (resize && end < s) return;
    onKeyMove(it, resize ? s : addDays(s, n), end);
  };
  // The bars' handlers are the same functions on every render, calling this render's: a
  // press redraws only the bar whose own props changed (memo(Bar)).
  const handlers = useRef({ onDown, keyOpen, keyMove, onKeyEnd, onKeyCancel, onSuggestion });
  useLayoutEffect(() => {
    handlers.current = { onDown, keyOpen, keyMove, onKeyEnd, onKeyCancel, onSuggestion };
  });
  const bars = useMemo(
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
  const today = sc.x(data.today);
  const todayMark = marks.find((m) => m.kind === "today");
  // A mark's line of words: its baseline, and its glyph's centre just above it.
  const baseline = (row: number) => TICK_H + 14 + row * MARK_ROW;
  // A mark's line starts under any words of a lower row it would cross (a line never runs through a label).
  const lineTop = (x: number, row: number, from: number) => {
    const below = marks.filter((o) => o.row > row && o.words && o.box[0] - 2 <= x && x <= o.box[1] + 2).map((o) => o.row);
    return below.length ? Math.max(from, baseline(Math.max(...below)) + 5) : from;
  };
  const openY = open ? l.y.get(open) : undefined;
  return (
    <div className="flex border border-line bg-surface" data-testid="simple-chart" data-format={format} data-unit={format === "gantt" ? unit : undefined} data-weeks={weeks ? "true" : undefined}>
      <div className="min-w-0 flex-none border-r border-line" style={{ width: l.labelW }} data-testid="chart-labels">
        <div style={{ height: l.top }} className="flex items-end px-3 pb-1.5 text-xs font-semibold tracking-[.05em] text-text2 uppercase">
          {LANE_WORDS[lane]}
        </div>
        {l.rows.map((r, n) =>
          r.kind === "group" ? (
            <div
              key={`g-${r.key}-${n}`}
              data-testid={r.below ? "below-the-line" : "chart-group"}
              data-add-where={dropTargets && lane === "goal" && !r.below && goalLane(r.key) ? whereAttr("goal", r.key) : undefined}
              data-add-label={r.title}
              style={{ height: l.rowH }}
              className={`flex min-w-0 flex-col justify-center bg-surface2 px-3 ${r.below ? "text-text2" : ""}`}
            >
              {gantt ? (
                // D: the goal's name and, under it, its metric. The row's height must fit both
                // lines (finding 6): a phone's tighter leading keeps the subtitle from being
                // painted over by the next row.
                <>
                  <span className={`truncate font-semibold ${compact ? "text-sm leading-[16px]" : "text-[15px] leading-[18px]"}`} title={r.title}>
                    {r.title}
                  </span>
                  {r.metric && (
                    <span className={`truncate text-text2 ${compact ? "text-[11px] leading-[13px]" : "text-xs leading-[15px]"}`} data-testid="group-metric" title={r.metric}>
                      {r.metric}
                    </span>
                  )}
                </>
              ) : (
                <>
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className={`truncate font-semibold ${compact ? "text-sm leading-[16px]" : "text-[15px] leading-tight"}`} title={r.title}>
                      {r.title}
                    </span>
                    {r.count != null && !r.below && (
                      <span className="tnum flex-none text-xs text-text2" data-testid="lane-count">
                        {r.count} {r.count === 1 ? "item" : "items"}
                      </span>
                    )}
                  </span>
                  {r.metric && (
                    <span className={`truncate text-text2 ${compact ? "text-[11px] leading-[13px]" : "text-xs"}`} data-testid="group-metric" title={r.metric}>
                      {r.metric}
                    </span>
                  )}
                </>
              )}
            </div>
          ) : (
            <button
              key={r.item.id}
              type="button"
              data-testid="chart-label"
              data-open={open === r.item.id ? "true" : undefined}
              style={{ height: l.rowH }}
              onClick={() => onOpen(r.item, { x: sc.x((moved[r.item.id] ?? barSpan(r.item))[0]), y: (l.y.get(r.item.id) ?? 0) + l.rowH })}
              className={`flex w-full min-w-0 items-center text-left hover:bg-surface2 ${compact ? "gap-1 px-2 text-[13px]" : "gap-2 px-3 text-[15px]"} ${open === r.item.id ? "bg-accent-soft" : ""}`}
            >
              {r.place != null && (
                <span className="tnum flex-none text-xs text-text2" data-testid="return-place" title="Its place in the return queue">
                  #{r.place}
                </span>
              )}
              {/* findings 15/16: every row shows its name, in full width; a code (F-01) sits only
                  in the tooltip, and only when it is this row's alone (some rows have none, and
                  the mock has repeated one by mistake). The name always gets the row's space
                  first; the chips after it shrink instead of squeezing it to nothing (finding 7). */}
              <span
                data-testid="label-title"
                title={r.item.code && codeCounts.get(r.item.code) === 1 ? `${r.item.code} ${r.item.title}` : r.item.title}
                className={`min-w-[45%] flex-1 truncate ${closedItem(r.item) ? "text-text2 line-through" : ""}`}
              >
                {r.item.title}
              </span>
              {r.item.draft && !closedItem(r.item) && (
                <span className="max-w-[48px] min-w-0 shrink truncate rounded-full bg-na-bg px-1.5 text-xs text-na" data-testid="draft-tag" title="Draft">
                  Draft
                </span>
              )}
              {gantt && pulled?.has(r.item.id) && (
                <span
                  className="flex h-5 max-w-[104px] min-w-0 shrink items-center truncate rounded-full bg-warn-bg px-2 text-xs font-semibold text-warn"
                  data-testid="pending-tag"
                  title="Pending decision"
                >
                  Pending decision
                </span>
              )}
            </button>
          ),
        )}
      </div>
      <div ref={box} className="relative min-w-0 flex-1 overflow-x-auto" data-testid="chart-scroll">
        <div className="relative" style={{ width: chartW, height: l.height }}>
          <svg
            ref={(el) => {
              svg.current = el;
              chartRef?.(el);
            }}
            width={chartW}
            height={l.height}
            data-testid="chart-svg"
            className="block select-none"
            onPointerMove={onMoveEvt}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            role="img"
            aria-label="Roadmap chart"
          >
            <defs>
              <pattern id="simple-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="8" height="8" fill="var(--accent-soft)" />
                <line x1="0" y1="0" x2="0" y2="8" stroke="var(--accent-mid)" strokeWidth="4" />
              </pattern>
              {format === "waterfall" &&
                PHASES.map((p) => (
                  <pattern key={p.key} id={`simple-hatch-${p.key}`} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                    <rect width="8" height="8" fill={p.soft} />
                    <line x1="0" y1="0" x2="0" y2="8" stroke={p.ink} strokeWidth="2.5" opacity="0.7" />
                  </pattern>
                ))}
              {/* D: pulled in, pending a decision (amber hatch). */}
              <pattern id="simple-pulled" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="8" height="8" fill="var(--warn-bg)" />
                <line x1="0" y1="0" x2="0" y2="8" stroke="var(--warn)" strokeWidth="2" opacity=".55" />
              </pattern>
              <marker id="simple-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" fill="var(--line-strong)" />
              </marker>
              <marker id="simple-arrow-red" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" fill="var(--crit)" />
              </marker>
              <marker id="simple-arrow-amber" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" fill="var(--warn)" />
              </marker>
            </defs>
            <rect x={0} y={0} width={chartW} height={l.height} fill="var(--surface)" />
            <Axis ticks={ticks} sc={sc} height={l.height} format={axisFormat} drop={!!dropTargets && axisFormat !== "gantt"} compact={compact} />
            {/* D: holidays are grey columns under the rows. */}
            {noWork.map((h) => (
              <rect
                key={h.start}
                data-testid="no-work"
                data-start={h.start}
                data-end={h.end}
                x={sc.x(h.start)}
                y={l.top}
                width={Math.max(sc.px, sc.x(h.end) - sc.x(h.start) + sc.px)}
                height={l.height - l.top}
                fill="var(--na-bg)"
                opacity={0.9}
                pointerEvents="none"
              >
                <title>{`${h.label || "No-work week"}: ${shortDay(h.start)} – ${shortDay(h.end)}`}</title>
              </rect>
            ))}
            {l.rows.map((r, n) =>
              r.kind === "group" ? <rect key={`gb-${n}`} x={0} y={l.top + n * l.rowH} width={chartW} height={l.rowH} fill="var(--surface2)" /> : null,
            )}
            {/* D: the open item's row is tinted across the chart. */}
            {openY != null && <rect data-testid="open-row" x={0} y={openY} width={chartW} height={l.rowH} fill="var(--accent-soft)" opacity={0.7} pointerEvents="none" />}
            {planMilestones(data).map((m) => {
              const mk = marks.find((x) => x.key === `end-${m.id}`);
              const mx = sc.x(m.end_date!) + sc.px;
              const code = codeOf(m.name);
              // Two or more planned PRDs: each end names its PRD ("M1 Prove it (Usage alerts)").
              const prd = planPrds(data).size > 1 ? milestonePrd(data, m) : null;
              const words = `${milestoneWords(m.name)}${prd ? ` (${prd.title})` : ""} ends ${shortDay(m.end_date!)}`;
              const by = baseline(mk?.row ?? 0);
              const cy = by - 4;
              return (
                <g key={m.id} data-testid="milestone-end" data-date={m.end_date!} data-row={mk?.row ?? 0} role="img" aria-label={words} pointerEvents="none">
                  <title>{words}</title>
                  {flags ? (
                    // B2: a flag, then "M1 ends Nov 27", against the line.
                    <>
                      <line data-testid="milestone-end-line" x1={mx} x2={mx} y1={lineTop(mx, mk?.row ?? 0, cy - 7)} y2={l.height} stroke={msEdge(code)} strokeWidth={1.2} strokeDasharray="4 3" />
                      <path
                        data-testid="milestone-flag"
                        d={`M${mk?.side === "after" ? mx + 5 : mx - 16 - (mk?.w ?? 0)} ${cy + 5} v-11 h8 l-2 3 l2 3 h-8`}
                        fill={msEdge(code)}
                        stroke={msEdge(code)}
                        strokeWidth={1.2}
                        strokeLinejoin="round"
                      />
                      {mk?.words && (
                        <text x={mk.side === "before" ? mx - 3 : mx + 17} y={by} fontSize={11} fontWeight={700} fill={msInk(code)} textAnchor={mk.side === "before" ? "end" : "start"} data-testid="milestone-end-label">
                          {mk.words}
                        </text>
                      )}
                    </>
                  ) : (
                    <>
                      <line data-testid="milestone-end-line" x1={mx} x2={mx} y1={lineTop(mx, mk?.row ?? 0, cy + 6)} y2={l.height} stroke={msEdge(code)} strokeWidth={1.2} strokeDasharray="4 3" />
                      <rect x={mx - 6} y={cy - 6} width={12} height={12} transform={`rotate(45 ${mx} ${cy})`} fill={msEdge(code)} />
                      {mk?.words && (
                        <text x={mk.side === "before" ? mx - 10 : mx + 10} y={by} fontSize={11} fontWeight={700} fill={msInk(code)} textAnchor={mk.side === "before" ? "end" : "start"} data-testid="milestone-end-label">
                          {mk.words}
                        </text>
                      )}
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
                const cy = baseline(mk.row) - 4;
                return (
                  <g key={m.id} data-testid="track-milestone" data-row={mk.row} transform={`translate(${mk.x}, ${cy})`}>
                    <rect x={-5} y={-5} width={10} height={10} transform="rotate(45)" fill="var(--warn)" />
                    <text x={mk.side === "after" ? 9 : -9} y={4} fontSize={11} fontWeight={700} fill="var(--text2)" textAnchor={mk.side === "after" ? "start" : "end"}>
                      {m.name}
                    </text>
                  </g>
                );
              })}
            {(data.key_dates ?? []).map((k) => {
              const mk = marks.find((x) => x.key === `key-${k.id}`);
              if (!mk) return null;
              const kx = mk.x;
              const cy = baseline(mk.row) - 4;
              return (
                <g key={k.id} data-testid="key-date-marker" data-name={k.name} data-date={k.date} data-draft={k.in_draft ? "true" : undefined} data-row={mk.row} pointerEvents="none">
                  <title>{`${k.name} · ${shortDay(k.date)}${k.note ? ` · ${k.note}` : ""} (${k.roadmap.title})`}</title>
                  <line x1={kx} x2={kx} y1={lineTop(kx, mk.row, cy + 5)} y2={l.height} stroke="var(--accent-ink)" strokeWidth={1} opacity={0.7} strokeDasharray={k.in_draft ? "3 3" : undefined} />
                  <rect x={kx - 5} y={cy - 5} width={10} height={10} transform={`rotate(45 ${kx} ${cy})`} fill={k.in_draft ? "var(--surface)" : "var(--accent-ink)"} stroke="var(--accent-ink)" />
                  <text x={mk.side === "after" ? kx + 9 : kx - 9} y={cy + 4} fontSize={11} fontWeight={700} fill="var(--accent-ink)" textAnchor={mk.side === "after" ? "start" : "end"} data-testid="key-date-label">
                    {k.name}
                  </text>
                </g>
              );
            })}
            <Arrows data={data} l={l} sc={sc} moved={moved} />
            {l.rows.map((r) =>
              r.kind === "item" ? (
                <Bar key={r.item.id} item={r.item} y={l.y.get(r.item.id)!} h={l.rowH} sc={sc} span={moved[r.item.id]} open={open === r.item.id} flash={flash.has(r.item.id)} canDrag={canDrag} phased={format === "waterfall"} gantt={gantt} compact={compact} pulled={gantt && !!pulled?.has(r.item.id)} width={chartW} {...bars} />
              ) : null,
            )}
            <PreviewGhost l={l} sc={sc} items={items} />
            {/* D: Today is a red line with a red "Today" pill under the ticks (D3: the line only on a phone). */}
            <g data-testid="today-mark" pointerEvents="none">
              {/* finding 18: the line starts below the axis's own tick labels (never above
                  TICK_H), so it never draws through them on its way down to the Today pill. */}
              <line x1={today} x2={today} y1={compact ? l.top - 4 : lineTop(today, 0, Math.max(TICK_H + 2, baseline(0) - 25))} y2={l.height} stroke="var(--crit)" strokeWidth={1.5} data-testid="today-line" />
              {todayMark?.words && (
                <>
                  <rect x={todayMark.side === "after" ? today + 2 : today - 40} y={baseline(0) - 17} width={38} height={14} rx={7} fill="var(--crit)" />
                  <text x={todayMark.side === "after" ? today + 21 : today - 21} y={baseline(0) - 6.5} fontSize={10} fontWeight={700} fill="var(--surface)" textAnchor="middle">
                    Today
                  </text>
                </>
              )}
            </g>
          </svg>
          <div ref={live} hidden data-testid="drag-live" className="pointer-events-none absolute z-20 rounded bg-tip px-2 py-0.5 text-xs whitespace-nowrap text-tip-text" />
          {overlay?.(l, sc)}
        </div>
      </div>
    </div>
  );
}

/** A phase's x and width inside its bar: a phase a gate dates past the item's end is drawn
 * inside the bar (its title keeps the dates). */
function phaseBox(p: Item["phases"][number], sc: Scale, x: number, w: number): [number, number] {
  const px = Math.min(Math.max(sc.x(p.start), x), x + w - 1);
  const right = Math.min(sc.x(p.end) + sc.px, x + w);
  return [px, Math.max(1, right - px)];
}

/** Redraws a phased bar's phases by direct DOM writes (the drag paints without React). */
function drawPhases(g: SVGGElement, phases: Item["phases"], sc: Scale, x: number, w: number) {
  for (const p of phases) {
    const r = g.querySelector<SVGRectElement>(`rect[data-phase="${p.key}"]`);
    if (!r) continue;
    const [px, pw] = phaseBox(p, sc, x, w);
    r.setAttribute("x", String(px));
    r.setAttribute("width", String(pw));
    r.dataset.start = p.start;
    r.dataset.end = p.end;
  }
}

function Axis({ ticks, sc, height, format, drop, compact }: { ticks: { day: string; label: string; major: boolean }[]; sc: Scale; height: number; format: Format; drop: boolean; compact: boolean }) {
  // D: a week's date over each week (D3: every other week on a phone, or where a week is too
  // narrow for its date); the day scale numbers its days.
  const weekly = format === "gantt" && sc.px < 20;
  const everyOther = compact || sc.px * 7 < 46;
  return (
    <g data-testid="chart-axis">
      {ticks.map((t, n) => {
        const x = sc.x(t.day);
        const next = ticks[n + 1] ? sc.x(ticks[n + 1].day) : sc.width;
        const labelled = format !== "gantt" || (weekly ? !everyOther || n % 2 === 0 : t.major || sc.px >= 20);
        // finding 28: a narrow quarter header still names its year ("Q4 '26"), not just "Q4".
        const [qWord, qYear] = t.label.split(" ");
        const text = format !== "gantt" && next - x < 64 ? `${qWord}${qYear ? ` '${qYear.slice(-2)}` : ""}` : t.label;
        const size = format !== "gantt" ? 13 : 11;
        const weight = format !== "gantt" ? 600 : 400;
        // finding 19: the right-most ticks keep their whole label inside the chart instead of
        // running past its edge (where the svg clips them): they anchor from their end once
        // they would otherwise overflow.
        const clipped = x + 3 + textWidth(text, size, weight) > sc.width;
        return (
          <g key={t.day}>
            {format !== "gantt" && n % 2 === 1 && <rect x={x} y={0} width={next - x} height={height} fill="var(--bg)" opacity={0.5} />}
            {drop && <rect data-testid="quarter-drop" data-add-where={whereAttr("quarter", quarterValue(t.day))} data-add-label={t.label} x={x} y={0} width={next - x} height={height} fill="transparent" />}
            <line x1={x} x2={x} y1={0} y2={height} stroke="var(--line)" strokeWidth={t.major ? 1 : 0.5} />
            {labelled && (
              <text
                x={clipped ? Math.max(0, sc.width - 2) : x + 3}
                y={format !== "gantt" ? 24 : 22}
                fontSize={size}
                fontWeight={weight}
                fill="var(--text2)"
                textAnchor={clipped ? "end" : "start"}
                data-testid="axis-tick"
              >
                {text}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}

function Arrows({ data, l, sc, moved }: { data: Roadmap; l: Layout; sc: Scale; moved: Record<string, [string, string]> }) {
  const byId = new Map(data.items.map((i) => [i.id, i]));
  const out: ReactNode[] = [];
  for (const it of data.items) {
    const y = l.y.get(it.id);
    if (y == null) continue;
    for (const depId of it.depends_on) {
      const dep = byId.get(depId);
      const dy = l.y.get(depId);
      if (!dep || dy == null) continue;
      const flag = it.flags.find((f) => f.kind === "dependency_order" && f.subject === depId);
      const tone = flag ? (flag.state === "red" ? "red" : "amber") : "ok";
      const [, depEnd] = moved[depId] ?? barSpan(dep);
      const [itStart] = moved[it.id] ?? barSpan(it);
      const x1 = sc.x(depEnd) + sc.px;
      const y1 = dy + l.rowH / 2;
      // finding 40: the arrow's head sits beside the bar it points to, not drawn over its own
      // edge and outline.
      const x2 = sc.x(itStart) - 2;
      const y2 = y + l.rowH / 2;
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
          markerEnd={`url(#simple-arrow${tone === "red" ? "-red" : tone === "amber" ? "-amber" : ""})`}
        />,
      );
    }
  }
  return <g>{out}</g>;
}

type BarProps = {
  item: Item;
  y: number;
  h: number;
  sc: Scale;
  span?: [string, string];
  open: boolean;
  /** roadmap-talk: a change to it was just applied from a chat card (the bar flashes). */
  flash?: boolean;
  canDrag: boolean;
  /** The waterfall: the bar drawn as its four phases. */
  phased: boolean;
  /** roadmap-milestones D: the Gantt's look (slices in the accent, labelled with their codes). */
  gantt?: boolean;
  /** A phone's rows (D3: smaller slice codes). */
  compact?: boolean;
  /** D: pulled in by a change waiting for its decider (amber hatch). */
  pulled?: boolean;
  /** finding 49: the chart's pixel width, so a suggestion's outline (its dates need not sit
   * inside the chart's own span) is drawn no wider than the chart itself. */
  width: number;
  onDown: (e: ReactPointerEvent<SVGGElement>, item: Item) => void;
  onKeyOpen: (item: Item) => void;
  onKeyMove: (item: Item, dir: 1 | -1, resize: boolean) => void;
  onKeyEnd: (item: Item) => void;
  onKeyCancel: (item: Item) => void;
  onSuggestion: (item: Item, anchor: { x: number; y: number }) => void;
};

const Bar = memo(function Bar({ item, y, h, sc, span, open, flash, canDrag, phased, gantt = false, compact = false, pulled = false, width, onDown, onKeyOpen, onKeyMove, onKeyEnd, onKeyCancel, onSuggestion }: BarProps) {
  const [start, end] = span ?? barSpan(item);
  const kind = barKind(item);
  const red = broken(item).length > 0;
  const amber = !red && item.flags.length > 0;
  const x = sc.x(start);
  // finding 11: a bar never draws thinner than MIN_BAR_W, so a short slice at a zoomed-out
  // scale stays a real, clickable shape rather than a few-pixel blob.
  const w = Math.max(MIN_BAR_W, sc.x(end) - x + sc.px);
  const pad = Math.round(h * 0.2);
  const fill = closedItem(item) ? "var(--na-bg)" : pulled ? "url(#simple-pulled)" : kind === "estimated" ? "url(#simple-hatch)" : kind === "draft" ? "var(--surface)" : "var(--accent)";
  // finding 17: an undated (draft/estimated) bar's outline uses the line token, not the accent,
  // so it keeps contrast against a dark background the way a dated bar's accent-ink does.
  const stroke = red ? "var(--crit)" : amber || pulled ? "var(--warn)" : kind === "dated" ? "var(--accent-ink)" : "var(--line-strong)";
  const s = item.suggestion;
  // The suggestion's handle sits left of the bar (a broken link's callout is on its right).
  const left = Math.min(x, s ? sc.x(s.start_date) : x) - 14;
  const mark = left >= 10 ? left : Math.max(sc.x(s?.end_date ?? end), x + w) + sc.px + 12;
  // A moved bar's phases as the API will work them out again (dated gates stay).
  const phases = phased && span ? rephase(item, start, end) : item.phases;
  // finding 14: plain words for a screen reader, not the API's enum values.
  const phaseWords = phased ? `, ${phases.map((p) => `${phaseWord(p.key)} to ${shortDay(p.end)}${p.estimated ? " (estimated)" : ""}`).join(", ")}` : "";
  const sliced = !phased && planned(item);
  const fixed = closedItem(item) || planned(item);
  const label = `${item.title}: ${shortDay(start)} to ${shortDay(end)}, ${item.estimated ? "Estimated by Oracle" : sourceWord(item.source)}${phaseWords}${red ? ", a broken link" : ""}${sliced ? `, ${item.slices.map((x) => `${x.code} in ${x.milestone} ${x.milestone_name}`).join(", ")}` : ""}${canDrag && planned(item) && !closedItem(item) ? ". Its dates follow the PRD's plan: change them in the PRD" : ""}${canDrag && !fixed ? (phased ? ". Arrows move the whole item" : ". Arrows move it, Shift+arrows its end") + ", sent when you pause; Escape cancels" : ""}`;
  // finding 49: the suggestion's dashed outline is clamped to the chart's own width (its dates
  // can run past the chart's span); a small arrow says it continues past the edge.
  const sx = sc.x(s?.start_date ?? start);
  const sRawW = s ? Math.max(MIN_BAR_W, sc.x(s.end_date) - sx + sc.px) : 0;
  const sClampedW = Math.min(width, Math.max(MIN_BAR_W, Math.min(sRawW, width - sx - 1)));
  const sxDraw = Math.max(0, Math.min(sx, width - sClampedW - 1));
  const sOverflows = s != null && sx + sRawW > width + 0.5;
  return (
    <g>
      <g
        data-testid="bar"
        data-bar-id={item.id}
        data-item={item.key}
        data-kind={closedItem(item) ? "cut" : kind}
        data-broken={red ? "true" : amber ? "amber" : "false"}
        data-start={start}
        data-end={end}
        data-open={open ? "true" : undefined}
        data-pulled={pulled ? "true" : undefined}
        data-flash={flash ? "true" : undefined}
        data-phased={phased ? "true" : undefined}
        role="button"
        tabIndex={0}
        aria-label={label}
        className={`${canDrag && !fixed ? "cursor-grab" : "cursor-pointer"} ${flash ? "simple-bar-flash" : ""} data-[picked=true]:[filter:drop-shadow(0_3px_6px_rgb(0_0_0/0.35))]`}
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
        {phased &&
          phases.map((p) => {
            const tone = PHASES.find((t) => t.key === p.key)!;
            const [px, pw] = phaseBox(p, sc, x, w);
            return (
              <rect
                key={p.key}
                data-testid="phase"
                data-phase={p.key}
                data-estimated={p.estimated ? "true" : "false"}
                data-start={p.start}
                data-end={p.end}
                x={px}
                y={y + pad}
                width={pw}
                height={h - 2 * pad}
                fill={p.estimated ? `url(#simple-hatch-${p.key})` : tone.ink}
                opacity={closedItem(item) ? 0.4 : 1}
              >
                <title>{`${tone.label}: ${shortDay(p.start)} – ${shortDay(p.end)}${p.estimated ? ", estimated" : ""}`}</title>
              </rect>
            );
          })}
        <rect
          data-body
          x={x}
          y={y + pad}
          width={w}
          height={h - 2 * pad}
          rx={4}
          fill={phased || sliced ? "transparent" : fill}
          stroke={sliced ? ((open && !gantt) || red || amber ? stroke : "none") : stroke}
          strokeWidth={red || amber || open ? 2.5 : gantt ? 1 : 1.25}
          strokeDasharray={kind === "draft" ? "6 4" : undefined}
        />
        {sliced && <Slices item={item} y={y + pad} h={h - 2 * pad} sc={sc} gantt={gantt} open={open} compact={compact} />}
        {item.milestone?.date && !sliced && (
          <rect
            data-testid="item-milestone"
            x={sc.x(item.milestone.date) - 5}
            y={y + h / 2 - 5}
            width={10}
            height={10}
            transform={`rotate(45 ${sc.x(item.milestone.date)} ${y + h / 2})`}
            fill="var(--warn)"
            stroke="var(--surface)"
          >
            <title>{`${item.milestone.name ?? "Milestone"} · ${shortDay(item.milestone.date)}`}</title>
          </rect>
        )}
      </g>
      {s && (
        <g>
          <rect
            data-testid="suggestion-outline"
            data-item={item.key}
            data-clamped={sOverflows ? "true" : undefined}
            x={sxDraw}
            y={y + pad - 3}
            width={sClampedW}
            height={h - 2 * pad + 6}
            rx={6}
            fill="none"
            stroke="var(--accent-ink)"
            strokeWidth={1.5}
            strokeDasharray="2 3"
            pointerEvents="none"
          />
          {/* finding 49: a small arrow says the suggested span keeps going past the chart's edge. */}
          {sOverflows && (
            <path
              data-testid="suggestion-continues"
              d={`M${sxDraw + sClampedW - 7},${y + h / 2 - 5} l7,5 l-7,5`}
              fill="none"
              stroke="var(--accent-ink)"
              strokeWidth={1.5}
              pointerEvents="none"
            />
          )}
          <g
            data-testid="suggestion-open"
            data-item={item.key}
            role="button"
            tabIndex={0}
            aria-label={`Oracle suggests dates for ${item.title}: ${shortDay(s.start_date)} to ${shortDay(s.end_date)}`}
            className="cursor-pointer"
            transform={`translate(${mark}, ${y + h / 2})`}
            onClick={() => onSuggestion(item, { x: sc.x(s.start_date), y: y + h })}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") onSuggestion(item, { x: sc.x(s.start_date), y: y + h });
            }}
          >
            <title>{`Oracle suggests dates for ${item.title}`}</title>
            <circle r={9} fill="var(--surface)" stroke="var(--accent-ink)" strokeDasharray="2 2" />
            <text textAnchor="middle" y={4} fontSize={11} fontWeight={700} fill="var(--accent-ink)">
              ?
            </text>
          </g>
        </g>
      )}
    </g>
  );
});

/** roadmap-gantt: a planned item's slices, one bar each on its row. The Gantt (roadmap-milestones
 * D) draws them in the accent, a feature cut in two or more labelled with each slice's code
 * (F-05a, beside the bar when it is too short), PM-owned work as a dashed outline; the Timeline
 * colours them by milestone with code and name where the words fit, joined by a dotted line. */
function Slices({ item, y, h, sc, gantt, open, compact }: { item: Item; y: number; h: number; sc: Scale; gantt: boolean; open: boolean; compact: boolean }) {
  const dated = item.slices.filter((x) => x.start_date && x.end_date).sort((a, b) => (a.start_date! < b.start_date! ? -1 : 1));
  const feature = dated[0]?.feature_code ?? item.code ?? item.key;
  // finding 11: a slice is never a sub-24px blob, even a one-day slice at a zoomed-out scale.
  const box = (x: (typeof dated)[number]) => ({ x: sc.x(x.start_date!), w: Math.max(MIN_BAR_W, sc.x(x.end_date!) - sc.x(x.start_date!) + sc.px) });
  const size = compact ? 10.5 : 11;
  return (
    <g>
      {!gantt &&
        dated.slice(1).map((x, n) => {
          const a = box(dated[n]);
          const b = box(x);
          return (
            <line
              key={`link-${x.code}`}
              data-testid="slice-connector"
              data-feature={feature}
              x1={a.x + a.w}
              x2={Math.max(a.x + a.w, b.x)}
              y1={y + h / 2}
              y2={y + h / 2}
              stroke="var(--text2)"
              strokeWidth={1.5}
              strokeDasharray="2 3"
            />
          );
        })}
      {dated.map((x) => {
        const b = box(x);
        const pm = x.pm_owned || x.effort_weeks == null;
        const edge = gantt ? "var(--accent-ink)" : msEdge(x.milestone);
        const fill = pm ? "var(--surface)" : gantt ? "var(--accent)" : msFill(x.milestone);
        const words = gantt ? (dated.length > 1 ? x.code : "") : `${x.code} ${x.name}`;
        const tw = words ? textWidth(words, size, 650) : 0;
        const inside = !!words && tw + (gantt ? 10 : 12) <= b.w;
        // The Gantt's code too long for its bar sits just after it (D: "F-05b" beside a short bar).
        const beside = gantt && !!words && !inside;
        return (
          <g
            key={x.code}
            data-testid="slice-bar"
            data-code={x.code}
            data-milestone={x.milestone}
            data-start={x.start_date!}
            data-end={x.end_date!}
            data-colour={gantt ? "var(--accent)" : msEdge(x.milestone)}
            data-estimated={x.estimated ? "true" : "false"}
            data-pm-owned={pm ? "true" : undefined}
          >
            <title>{`${x.code} ${x.name} · ${x.milestone} ${x.milestone_name} · ${shortDay(x.start_date!)} – ${shortDay(x.end_date!)}${pm ? " · PM-owned" : ` · ${x.effort_weeks} engineer-weeks`}${x.estimated ? " · placed by Oracle" : ""}`}</title>
            <rect
              data-slice-body
              x={b.x}
              y={y}
              width={b.w}
              height={h}
              rx={4}
              fill={fill}
              stroke={pm && gantt ? "var(--line-strong)" : edge}
              strokeWidth={gantt && open ? 2.5 : 1}
              strokeDasharray={pm ? "3 2" : undefined}
            />
            {(inside || beside) && (
              <text
                data-testid="slice-label"
                x={beside ? b.x + b.w + 5 : b.x + (gantt ? 5 : 6)}
                y={y + h / 2 + 4}
                fontSize={size}
                fontWeight={beside ? 400 : 650}
                fill={beside ? "var(--text2)" : pm ? "var(--accent-ink)" : gantt ? "var(--on-accent)" : msInk(x.milestone)}
                pointerEvents="none"
              >
                {words}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}

/** How long an applied change's bar flashes (ms). */
const FLASH_MS = 2500;

/** roadmap-talk: the items chat cards just applied to ("simple:applied"; Apply all sends several), each for ~2.5 s. */
export function useAppliedFlash(): ReadonlySet<string> {
  const [flash, setFlash] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    let timer = 0;
    const on = (e: Event) => {
      const id = (e as CustomEvent<AppliedDetail>).detail?.item_id;
      if (!id) return;
      setFlash((f) => new Set(f).add(id));
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setFlash(new Set()), FLASH_MS);
    };
    window.addEventListener(APPLIED_EVENT, on);
    return () => {
      window.removeEventListener(APPLIED_EVENT, on);
      window.clearTimeout(timer);
    };
  }, []);
  return flash;
}

/** S9: a chat card's Preview, ghosted on its bar ("simple:preview"): new dates, horizon, title, milestone, or a cut strike. */
export function PreviewGhost({ l, sc, items }: { l: Pick<Layout, "y" | "rowH">; sc: Scale; items: Map<string, Item> }) {
  const [preview, setPreview] = useState<ChatPreview>(() => lastPreview()?.preview ?? null);
  useEffect(() => {
    const on = (e: Event) => setPreview((e as CustomEvent<PreviewDetail>).detail?.preview ?? null);
    window.addEventListener(PREVIEW_EVENT, on);
    return () => window.removeEventListener(PREVIEW_EVENT, on);
  }, []);
  if (!preview) return null;
  const item = items.get(preview.item_id);
  const y = l.y.get(preview.item_id);
  if (!item || y === undefined) return null;
  const [start, end] = barSpan(item);
  const pad = Math.round(l.rowH * 0.2);
  const box = (a: string, b: string) => ({ x: sc.x(a), w: Math.max(sc.px, sc.x(b) - sc.x(a) + sc.px) });
  const cur = box(start, end);
  const common = { "data-testid": "preview-ghost", "data-kind": preview.kind, pointerEvents: "none" as const };
  if (preview.kind === "dates") {
    const b = box(preview.start_date, preview.end_date);
    return (
      <g {...common} data-start={preview.start_date} data-end={preview.end_date}>
        <rect x={b.x} y={y + pad} width={b.w} height={l.rowH - 2 * pad} rx={4} fill="var(--accent)" opacity={0.35} stroke="var(--accent-ink)" strokeDasharray="4 3" />
      </g>
    );
  }
  if (preview.kind === "cut") {
    return (
      <g {...common}>
        <line x1={cur.x} x2={cur.x + cur.w} y1={y + l.rowH / 2} y2={y + l.rowH / 2} stroke="var(--crit)" strokeWidth={3} />
      </g>
    );
  }
  if (preview.kind === "milestone") {
    return (
      <g {...common} transform={`translate(${sc.x(preview.date)}, ${y + l.rowH / 2})`}>
        <rect x={-6} y={-6} width={12} height={12} transform="rotate(45)" fill="var(--warn)" opacity={0.5} stroke="var(--warn)" strokeDasharray="3 2" />
        <text x={10} y={4} fontSize={11} fill="var(--text2)">
          {preview.name}
        </text>
      </g>
    );
  }
  const words = preview.kind === "title" ? preview.title : `Moves to ${preview.horizon[0].toUpperCase()}${preview.horizon.slice(1)}`;
  return (
    <g {...common}>
      <rect x={cur.x} y={y + pad} width={cur.w} height={l.rowH - 2 * pad} rx={4} fill="none" stroke="var(--accent-ink)" strokeDasharray="4 3" />
      <text x={cur.x + cur.w + 8} y={y + l.rowH / 2 + 4} fontSize={12} fill="var(--accent-ink)" fontWeight={600}>
        {words}
      </text>
    </g>
  );
}
