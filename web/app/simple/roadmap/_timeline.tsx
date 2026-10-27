"use client";

import { memo, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import {
  addDays,
  barKind,
  barSpan,
  broken,
  daysBetween,
  liveBreaks,
  ms,
  quarters,
  scale,
  shortDay,
  type Format,
  type GanttUnit,
  type Item,
  type Roadmap,
  type Scale,
} from "./_lib";

/** One row of the chart: a group's heading (its metric line) or an item. */
export type Row = { kind: "group"; key: string; title: string; metric: string | null; below?: boolean } | { kind: "item"; item: Item; place?: number };

export interface Layout {
  rows: Row[];
  rowH: number;
  labelW: number;
  top: number;
  height: number;
  y: Map<string, number>;
}

const AXIS_H = 40;
const LONG_PRESS_MS = 450;

/** The rows: each group with its items (cut items below the line, in their return-queue order). */
export function layout(data: Roadmap, compact: boolean): Layout {
  const byId = new Map(data.items.map((i) => [i.id, i]));
  const rows: Row[] = [];
  const below: Item[] = [];
  for (const g of data.groups) {
    const items = g.item_ids.map((id) => byId.get(id)).filter((i): i is Item => !!i);
    const live = items.filter((i) => i.status !== "cut");
    below.push(...items.filter((i) => i.status === "cut"));
    if (!live.length) continue;
    const metric = live.find((i) => i.goal?.metric)?.goal?.metric ?? null;
    rows.push({ kind: "group", key: g.key, title: g.title, metric: data.group === "goal" ? metric : null });
    for (const item of live) rows.push({ kind: "item", item });
  }
  if (below.length) {
    rows.push({ kind: "group", key: "below-the-line", title: "Below the line", metric: null, below: true });
    below.forEach((item, n) => rows.push({ kind: "item", item, place: n + 1 }));
  }
  const rowH = compact ? 30 : 36;
  const y = new Map<string, number>();
  rows.forEach((r, n) => {
    if (r.kind === "item") y.set(r.item.id, AXIS_H + n * rowH);
  });
  return { rows, rowH, labelW: compact ? 116 : 248, top: AXIS_H, height: AXIS_H + rows.length * rowH + 8, y };
}

/** The chart's span and pixels per day: the timeline fits its quarters to the width; the
 * Gantt is a day or week scale around the items, scrolling sideways. */
export function chartScale(data: Roadmap, format: Format, unit: GanttUnit, width: number): { scale: Scale; ticks: { day: string; label: string; major: boolean }[] } {
  const starts = data.items.map((i) => i.start.date).concat(data.today);
  const ends = data.items.map((i) => i.end.date).concat(data.today);
  const lo = starts.reduce((a, b) => (a < b ? a : b));
  const hi = ends.reduce((a, b) => (a > b ? a : b));
  if (format === "timeline") {
    const qs = quarters(lo < data.windows.now.start ? lo : data.windows.now.start, hi);
    const s = qs[0].start;
    const e = qs[qs.length - 1].end;
    const px = Math.max(0.5, width / (daysBetween(s, e) + 1));
    return { scale: scale(s, e, px), ticks: qs.map((q) => ({ day: q.start, label: q.label, major: true })) };
  }
  const s = addDays(lo, -7);
  const e = addDays(hi, 7);
  const sc = scale(s, e, unit === "day" ? 26 : 7);
  const ticks: { day: string; label: string; major: boolean }[] = [];
  const first = new Date(ms(s));
  // Weeks start on Monday.
  let d = unit === "day" ? s : addDays(s, (8 - first.getUTCDay()) % 7);
  for (let n = 0; d <= e && n < 2000; n++) {
    const date = new Date(ms(d));
    ticks.push({ day: d, label: unit === "day" ? String(date.getUTCDate()) : shortDay(d), major: unit === "day" ? date.getUTCDate() === 1 || date.getUTCDay() === 1 : true });
    d = addDays(d, unit === "day" ? 1 : 7);
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
  /** Bars moved and waiting for the change's answer (drawn at their new dates). */
  moved: Record<string, [string, string]>;
  open: string | null;
  onOpen: (item: Item, anchor: { x: number; y: number }) => void;
  onMove: (item: Item, start: string, end: string) => void;
  onSuggestion: (item: Item, anchor: { x: number; y: number }) => void;
  /** HTML drawn over the chart (callouts, popovers, the card), in chart pixels. */
  overlay?: (l: Layout, sc: Scale) => ReactNode;
  chartRef?: (el: SVGSVGElement | null) => void;
}

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

export function Chart({ data, format, unit, compact, canDrag, moved, open, onOpen, onMove, onSuggestion, overlay, chartRef }: ChartProps) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(240, el.clientWidth - 2)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const l = useMemo(() => layout(data, compact), [data, compact]);
  const { scale: sc, ticks } = useMemo(() => chartScale(data, format, unit, width), [data, format, unit, width]);
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
    const w = Math.max(sc.px, sc.x(e) - x + sc.px);
    const rect = g.querySelector<SVGRectElement>("rect[data-body]");
    rect?.setAttribute("x", String(x));
    rect?.setAttribute("width", String(w));
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
    const mode = !canDrag || item.status === "cut" ? "move" : e.clientX - r.left < edge ? "start" : r.right - e.clientX < edge ? "end" : "move";
    const touch = e.pointerType === "touch";
    const d: Drag = { id: item.id, mode, x0: e.clientX, start, end, dx: 0, moved: false, frame: null, pointer: e.pointerId, touch, armed: !touch, timer: null };
    drag.current = d;
    if (touch && canDrag && item.status !== "cut") {
      // Phone: a long press picks the bar up; moving first scrolls.
      d.timer = window.setTimeout(() => {
        begin(d);
        e.currentTarget?.setAttribute?.("data-picked", "true");
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
    if (!canDrag || items.get(d.id)?.status === "cut") return;
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
      rect?.setAttribute("x", String(sc.x(d.start)));
      rect?.setAttribute("width", String(Math.max(sc.px, sc.x(d.end) - sc.x(d.start) + sc.px)));
    }
  };

  const keyOpen = (it: Item) => onOpen(it, { x: sc.x((moved[it.id] ?? barSpan(it))[0]), y: (l.y.get(it.id) ?? 0) + l.rowH });
  const today = sc.x(data.today);
  const chartW = sc.width;
  return (
    <div className="flex border border-line bg-surface" data-testid="simple-chart" data-format={format} data-unit={format === "gantt" ? unit : undefined}>
      <div className="flex-none border-r border-line" style={{ width: l.labelW }} data-testid="chart-labels">
        <div style={{ height: l.top }} className="flex items-end px-3 pb-1 text-xs font-semibold tracking-wide text-text2 uppercase">
          {data.group === "goal" ? "Goal" : data.group === "track" ? "Track" : "PRD"}
        </div>
        {l.rows.map((r, n) =>
          r.kind === "group" ? (
            <div
              key={`g-${r.key}-${n}`}
              data-testid={r.below ? "below-the-line" : "chart-group"}
              style={{ height: l.rowH }}
              className={`flex flex-col justify-center truncate bg-surface2 px-3 ${r.below ? "text-text2" : ""}`}
            >
              <span className="truncate text-[15px] leading-tight font-semibold">{r.title}</span>
              {r.metric && (
                <span className="truncate text-xs text-text2" data-testid="group-metric">
                  {r.metric}
                </span>
              )}
            </div>
          ) : (
            <button
              key={r.item.id}
              type="button"
              data-testid="chart-label"
              style={{ height: l.rowH }}
              onClick={() => onOpen(r.item, { x: sc.x((moved[r.item.id] ?? barSpan(r.item))[0]), y: (l.y.get(r.item.id) ?? 0) + l.rowH })}
              className="flex w-full items-center gap-2 truncate px-3 text-left text-[15px] hover:bg-surface2"
            >
              {r.place != null && (
                <span className="tnum flex-none text-xs text-text2" data-testid="return-place" title="Its place in the return queue">
                  #{r.place}
                </span>
              )}
              <span className={`truncate ${r.item.status === "cut" ? "text-text2 line-through" : ""}`}>{r.item.title}</span>
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
            <Axis ticks={ticks} sc={sc} height={l.height} format={format} />
            {l.rows.map((r, n) =>
              r.kind === "group" ? <rect key={`gb-${n}`} x={0} y={l.top + n * l.rowH} width={chartW} height={l.rowH} fill="var(--surface2)" /> : null,
            )}
            {data.milestones
              .filter((m) => m.date)
              .map((m) => (
                <g key={m.id} data-testid="track-milestone" transform={`translate(${sc.x(m.date!)}, ${l.top - 10})`}>
                  <rect x={-5} y={-5} width={10} height={10} transform="rotate(45)" fill="var(--warn)" />
                  <text x={8} y={4} fontSize={11} fill="var(--text2)">
                    {m.name}
                  </text>
                </g>
              ))}
            <Arrows data={data} l={l} sc={sc} moved={moved} />
            {l.rows.map((r) => (r.kind === "item" ? <Bar key={r.item.id} item={r.item} y={l.y.get(r.item.id)!} h={l.rowH} sc={sc} span={moved[r.item.id]} open={open === r.item.id} canDrag={canDrag} onDown={onDown} onKeyOpen={keyOpen} onSuggestion={onSuggestion} /> : null))}
            <line x1={today} x2={today} y1={l.top - 14} y2={l.height} stroke="var(--crit)" strokeWidth={2} data-testid="today-line" />
            <text x={today + 4} y={l.top - 4} fontSize={11} fill="var(--crit)" fontWeight={600}>
              Today
            </text>
          </svg>
          <div ref={live} hidden data-testid="drag-live" className="pointer-events-none absolute z-20 rounded bg-tip px-2 py-0.5 text-xs whitespace-nowrap text-tip-text" />
          {overlay?.(l, sc)}
        </div>
      </div>
    </div>
  );
}

function Axis({ ticks, sc, height, format }: { ticks: { day: string; label: string; major: boolean }[]; sc: Scale; height: number; format: Format }) {
  return (
    <g data-testid="chart-axis">
      {ticks.map((t, n) => {
        const x = sc.x(t.day);
        const next = ticks[n + 1] ? sc.x(ticks[n + 1].day) : sc.width;
        return (
          <g key={t.day}>
            {format === "timeline" && n % 2 === 1 && <rect x={x} y={0} width={next - x} height={height} fill="var(--bg)" opacity={0.5} />}
            <line x1={x} x2={x} y1={0} y2={height} stroke="var(--line)" strokeWidth={t.major ? 1 : 0.5} />
            {(format === "timeline" || t.major || sc.px >= 20) && (
              <text x={x + 4} y={24} fontSize={format === "timeline" ? 13 : 11} fontWeight={format === "timeline" ? 600 : 400} fill="var(--text2)" data-testid="axis-tick">
                {format === "timeline" && next - x < 64 ? t.label.split(" ")[0] : t.label}
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
      const x2 = sc.x(itStart);
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
  canDrag: boolean;
  onDown: (e: ReactPointerEvent<SVGGElement>, item: Item) => void;
  onKeyOpen: (item: Item) => void;
  onSuggestion: (item: Item, anchor: { x: number; y: number }) => void;
};

const Bar = memo(function Bar({ item, y, h, sc, span, open, canDrag, onDown, onKeyOpen, onSuggestion }: BarProps) {
  const [start, end] = span ?? barSpan(item);
  const kind = barKind(item);
  const red = broken(item).length > 0;
  const amber = !red && item.flags.length > 0;
  const x = sc.x(start);
  const w = Math.max(sc.px, sc.x(end) - x + sc.px);
  const pad = Math.round(h * 0.2);
  const fill = item.status === "cut" ? "var(--na-bg)" : kind === "estimated" ? "url(#simple-hatch)" : kind === "draft" ? "var(--surface)" : "var(--accent)";
  const stroke = red ? "var(--crit)" : amber ? "var(--warn)" : kind === "dated" ? "var(--accent-ink)" : "var(--accent)";
  const s = item.suggestion;
  // The suggestion's handle sits left of the bar (a broken link's callout is on its right).
  const left = Math.min(x, s ? sc.x(s.start_date) : x) - 14;
  const mark = left >= 10 ? left : Math.max(sc.x(s?.end_date ?? end), x + w) + sc.px + 12;
  const label = `${item.title}: ${shortDay(start)} to ${shortDay(end)}, ${item.estimated ? "estimated" : item.source}${red ? ", a broken link" : ""}`;
  return (
    <g>
      <g
        data-testid="bar"
        data-bar-id={item.id}
        data-item={item.key}
        data-kind={item.status === "cut" ? "cut" : kind}
        data-broken={red ? "true" : amber ? "amber" : "false"}
        data-start={start}
        data-end={end}
        data-open={open ? "true" : undefined}
        role="button"
        tabIndex={0}
        aria-label={label}
        className={canDrag && item.status !== "cut" ? "cursor-grab" : "cursor-pointer"}
        style={{ touchAction: canDrag ? "none" : "auto" }}
        onPointerDown={(e) => onDown(e, item)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onKeyOpen(item);
          }
        }}
      >
        <rect
          data-body
          x={x}
          y={y + pad}
          width={w}
          height={h - 2 * pad}
          rx={5}
          fill={fill}
          stroke={stroke}
          strokeWidth={red || amber || open ? 2.5 : 1.25}
          strokeDasharray={kind === "draft" ? "6 4" : undefined}
        />
        {item.milestone?.date && (
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
            x={sc.x(s.start_date)}
            y={y + pad - 3}
            width={Math.max(sc.px, sc.x(s.end_date) - sc.x(s.start_date) + sc.px)}
            height={h - 2 * pad + 6}
            rx={6}
            fill="none"
            stroke="var(--accent-ink)"
            strokeWidth={1.5}
            strokeDasharray="2 3"
            pointerEvents="none"
          />
          <g
            data-testid="suggestion-open"
            data-item={item.key}
            role="button"
            tabIndex={0}
            aria-label={`Oracle's date suggestion for ${item.title}: ${shortDay(s.start_date)} to ${shortDay(s.end_date)}`}
            className="cursor-pointer"
            transform={`translate(${mark}, ${y + h / 2})`}
            onClick={() => onSuggestion(item, { x: sc.x(s.start_date), y: y + h })}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") onSuggestion(item, { x: sc.x(s.start_date), y: y + h });
            }}
          >
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
