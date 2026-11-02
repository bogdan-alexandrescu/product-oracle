"use client";
// mk-qa4-roadmap, the owner's picks (Nov 1): the Timeline zooms around today (QR1 A), each
// state has its own look with the key on top (QR2 A), broken links sit in a panel above the
// chart (QR3 A) and an item opens in a side panel (QR4 A; a sheet on a phone).

import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { addMonths } from "@/lib/dates";

import { FixButtons, type Act } from "./_card";
import {
  addDays,
  barSpan,
  broken,
  closedItem,
  daysBetween,
  liveBreaks,
  ms,
  quarterValue,
  quarters,
  shortDay,
  spanWords,
  type Flag,
  type Item,
  type Roadmap,
  whereAttr,
} from "./_lib";
import { DRAG_PX, grabAt, LONG_PRESS_MS, planned } from "./_timeline";

type Zoom = "6m" | "1y" | "all";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const monthWord = (day: string) =>
  `${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
const quarterWords = (q: { start: string; end: string }) =>
  `${MONTHS[Number(q.start.slice(5, 7)) - 1]} – ${MONTHS[Number(q.end.slice(5, 7)) - 1]} ${q.start.slice(0, 4)}`;

/** Today's own colour (QR2 A): purple, never the red of a broken link. */
const TODAY = "var(--today)";

type Row =
  | { kind: "lane"; key: string; title: string; count: number }
  | { kind: "item"; item: Item };

/** Items by goal (a lane per goal, then No goal, then Below the line), each item its own row.
 * The lanes are the data's goal groups (oneLane(lanes(data, "goal"))), as the goal cards, the
 * Gantt, the Waterfall and Now / Next / Later count them: a plan's slices put an item with no
 * goal of its own in its plan goal's lane, and PM-owned work has a lane of its own. */
function rowsOf(data: Roadmap): Row[] {
  const byId = new Map(data.items.map((i) => [i.id, i]));
  const lanes = new Map<string, { title: string; items: Item[] }>();
  const below: Item[] = [];
  for (const g of data.groups)
    for (const id of g.item_ids) {
      const i = byId.get(id);
      if (!i) continue;
      if (closedItem(i)) {
        below.push(i);
        continue;
      }
      if (!lanes.has(g.key)) lanes.set(g.key, { title: g.title, items: [] });
      lanes.get(g.key)!.items.push(i);
    }
  const order = [...lanes.entries()].sort(([a], [b]) =>
    a === "none" ? 1 : b === "none" ? -1 : 0,
  );
  const out: Row[] = [];
  for (const [k, l] of order) {
    out.push({ kind: "lane", key: k, title: l.title, count: l.items.length });
    for (const i of [...l.items].sort((a, b) =>
      a.start.date < b.start.date ? -1 : 1,
    ))
      out.push({ kind: "item", item: i });
  }
  if (below.length) {
    out.push({
      kind: "lane",
      key: "below",
      title: "Below the line",
      count: below.length,
    });
    for (const i of below) out.push({ kind: "item", item: i });
  }
  return out;
}

/** The open broken link of a live item (red means this and nothing else). */
export function brokenFlag(i: Item): Flag | undefined {
  return closedItem(i)
    ? undefined
    : broken(i).find((f) => f.kind === "dependency_order");
}

/** QR2 A: how a bar shows its state. */
type Look = {
  bar: CSSProperties;
  name?: CSSProperties;
  chip?: string;
  mark?: boolean;
};
const HATCH =
  "repeating-linear-gradient(45deg, var(--accent-soft) 0 3px, color-mix(in srgb, var(--accent) 35%, transparent) 3px 6px)";
const DATED: CSSProperties = {
  background: "var(--accent-soft)",
  border: "1.5px solid var(--accent)",
};
const DRAFT: CSSProperties = {
  background: "var(--surface)",
  border: "1.5px dashed var(--line-strong)",
};
const BROKEN: CSSProperties = {
  background: "var(--accent-soft)",
  border: "2px solid var(--crit)",
};
function lookOf(i: Item): Look {
  const base: CSSProperties = i.estimated
    ? { ...DATED, background: HATCH }
    : DATED;
  if (i.draft) return { bar: DRAFT, chip: "Draft" };
  if (closedItem(i))
    return {
      bar: { background: "var(--surface2)", border: "1.5px solid var(--line)" },
      name: { textDecoration: "line-through", color: "var(--text2)" },
    };
  if (brokenFlag(i))
    return { bar: { ...base, border: BROKEN.border }, mark: true };
  return { bar: base };
}

/** QR2 A's key: a swatch drawn as the mark is, then short words; only the looks on the chart. */
function Key({ data }: { data: Roadmap }) {
  const has = (f: (i: Item) => boolean) => data.items.some(f);
  const sw = (s: CSSProperties) => (
    <i
      aria-hidden
      className="inline-block h-3 w-7 flex-none rounded-sm"
      style={s}
    />
  );
  const e: [string, ReactNode, string][] = [["dated", sw(DATED), "Dated"]];
  if (has((i) => i.estimated))
    e.push(["est", sw({ ...DATED, background: HATCH }), "Estimated"]);
  if (has((i) => i.draft)) e.push(["draft", sw(DRAFT), "Draft"]);
  if (has((i) => !!brokenFlag(i)))
    e.push(["broken", sw(BROKEN), "⚠ Broken link"]);
  if (has(closedItem))
    e.push([
      "cut",
      <span key="c" className="text-sm text-text2 line-through">
        Cut
      </span>,
      "Cut, below the line",
    ]);
  e.push([
    "today",
    <i
      key="t"
      aria-hidden
      className="inline-block h-3.5 w-0.5 flex-none"
      style={{ background: TODAY }}
    />,
    `Today ${shortDay(data.today)}`,
  ]);
  return (
    <ul
      data-testid="timeline-key"
      className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-text2"
    >
      {e.map(([k, s, w]) => (
        <li key={k} data-key={k} className="flex items-center gap-2">
          {s}
          {w}
        </li>
      ))}
    </ul>
  );
}

interface Common {
  data: Roadmap;
  phone: boolean;
  act: Act;
  canChange: boolean;
  byId: Map<string, Item>;
}

export interface TimelineProps extends Common {
  /** The open item's key, and how to open or close one. */
  openKey: string | null;
  onOpen: (key: string | null) => void;
  /** The Gantt's moves (roadmap-r2): bars moved and waiting for the change's answer, a
   * drag's change, the keyboard's burst and its end or cancel (_roadmap.tsx's). */
  moved: Record<string, [string, string]>;
  onMove: (item: Item, start: string, end: string) => void;
  onKeyMove: (item: Item, start: string, end: string) => void;
  onKeyEnd: (item: Item) => void;
  onKeyCancel: (item: Item) => void;
  /** The item card (FloatingCard), placed by `style`; `sheet`: a phone's bottom sheet. */
  card: (
    item: Item,
    style: CSSProperties,
    sheet: boolean,
    onClose: () => void,
  ) => ReactNode;
}

const LABEL_W = 232;
const ROW_H = 34;

/** The Timeline (QR1 A): six months around today, one row per item, names fixed on the left;
 * a phone gets a list by quarter. The key and the broken links sit above it; an open item
 * sits in a panel at its right (a sheet on a phone). */
export function ZoomTimeline(props: TimelineProps) {
  const { data, phone, openKey, onOpen } = props;
  const openItem = openKey
    ? (data.items.find((i) => i.key === openKey) ?? null)
    : null;
  const side = !phone && !!openItem;
  return (
    // The page reads its chart (and its format) by simple-chart, as the other formats give it.
    <div data-testid="simple-chart" data-format="timeline" data-view="zoom">
      <div data-testid="zoom-timeline" className="mt-2">
        <div className="mb-2 rounded-lg border border-line bg-surface px-3 py-2">
          <Key data={data} />
        </div>
        <ConflictPanel {...props} onShow={onOpen} />
        <div className={side ? "flex items-start gap-3" : ""}>
          <div className="min-w-0 flex-1">
            {phone ? <QuarterList {...props} /> : <DayChart {...props} />}
          </div>
          {side && openItem && (
            <aside
              data-testid="item-panel"
              aria-label={openItem.title}
              className="sticky top-3 max-h-[calc(100dvh-24px)] w-[400px] flex-none overflow-y-auto rounded-xl border border-line bg-surface shadow-tip"
            >
              {props.card(
                openItem,
                {
                  position: "relative",
                  left: 0,
                  top: 0,
                  width: "100%",
                  border: 0,
                  boxShadow: "none",
                },
                false,
                () => onOpen(null),
              )}
            </aside>
          )}
        </div>
        {phone &&
          openItem &&
          props.card(openItem, { height: "52dvh" }, true, () => onOpen(null))}
      </div>
    </div>
  );
}

/** QR3 A: the broken links in a panel of their own above the chart (the Timeline's and the
 * Waterfall's), each with its words in full and its three fixes; Hide folds it to one line. */
export function ConflictPanel({
  data,
  act,
  canChange,
  byId,
  onShow,
  phone,
}: Common & { onShow: (key: string) => void }) {
  const list = data.items.flatMap((i) =>
    closedItem(i)
      ? []
      : broken(i)
          .filter((f) => f.kind === "dependency_order")
          .map((f) => ({ i, f })),
  );
  const [shut, setShut] = useState(false);
  if (!list.length)
    return (
      <p
        data-testid="conflicts"
        className="mb-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-text2"
      >
        No broken links
      </p>
    );
  return (
    <section
      data-testid="conflicts"
      className="mb-2 rounded-xl border border-crit bg-surface"
    >
      <button
        type="button"
        aria-expanded={!shut}
        onClick={() => setShut(!shut)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-semibold text-crit"
      >
        ⚠ {list.length} broken {list.length === 1 ? "link" : "links"}{" "}
        <span className="ml-auto text-text2">{shut ? "Show" : "Hide"}</span>
      </button>
      {!shut && (
        <ul className="divide-y divide-line border-t border-line">
          {list.map(({ i, f }) => (
            <li
              key={i.id}
              data-testid="conflict"
              data-item={i.key}
              className={`flex gap-3 px-3 py-2 ${phone ? "flex-col" : "flex-wrap items-center"}`}
            >
              <button
                type="button"
                onClick={() => onShow(i.key)}
                className="min-w-0 flex-1 text-left text-sm text-text hover:underline"
              >
                {f.reason}
              </button>
              <div className="max-w-full min-w-0">
                <FixButtons
                  item={i}
                  flag={f}
                  items={byId}
                  act={act}
                  canChange={canChange}
                  inline={!phone}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A desktop's chart: one row per item, days to scale, zoomed to six months around today. */
function DayChart(props: TimelineProps) {
  const { data, phone, openKey, onOpen } = props;
  const rows = useMemo(() => rowsOf(data), [data]);
  const [zoom, setZoom] = useState<Zoom>("6m");
  const fit = zoom === "all";
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(1000);
  const [sl, setSl] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const on = () => setW(el.clientWidth);
    on();
    const ro = new ResizeObserver(on);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const labelW = phone ? 132 : LABEL_W;
  const days = data.items
    .flatMap((i) => [i.start.date, i.end.date])
    .concat(data.today)
    .sort();
  const t0 = addDays(days[0].slice(0, 8) + "01", 0);
  const t1 = addDays(days[days.length - 1], 20);
  const span = daysBetween(t0, t1);
  const visible = Math.max(200, w - labelW - 2);
  const ppd = fit ? visible / span : visible / (zoom === "1y" ? 365 : 182);
  const trackW = Math.round(span * ppd);
  const x = (d: string) => daysBetween(t0, d) * ppd;
  const xt = x(data.today);
  useLayoutEffect(() => {
    if (box.current && !fit) box.current.scrollLeft = Math.max(0, xt - 60);
  }, [xt, fit, zoom]);
  const months: { day: string; label: string }[] = [];
  for (let d = t0; d <= t1;) {
    const m = Number(d.slice(5, 7));
    const every = fit ? 3 : 1;
    if ((m - 1) % every === 0)
      months.push({
        day: d,
        label: m === 1 || months.length === 0 ? monthWord(d) : MONTHS[m - 1],
      });
    const n = new Date(ms(d));
    d = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 1))
      .toISOString()
      .slice(0, 10);
  }
  // The first month in sight carries its year.
  const firstSeen = fit
    ? months[0]?.day
    : months.find((m) => x(m.day) >= sl - 2)?.day;
  // roadmap-r2: the Gantt's moves. A drag past DRAG_PX moves the bar by whole days (an end
  // grabbed near the bar's edge, grabAt, moves only that end); a shorter one is a click. A
  // finger picks a bar up with the Gantt's long press first. The arrow keys move a focused
  // bar a week, Shift+arrow a month; each move is the Gantt's change. Cut and planned items,
  // and a viewer's bars, do not move.
  const { canChange, moved, onMove, onKeyMove, onKeyEnd, onKeyCancel } = props;
  const fixed = (i: Item) => !canChange || closedItem(i) || planned(i);
  const drag = useRef<{ item: Item; mode: "move" | "start" | "end"; x0: number; start: string; end: string; moved: boolean; pointer: number; armed: boolean; timer: number | null } | null>(null);
  const clicked = useRef(false);
  const [live, setLive] = useState<{ id: string; start: string; end: string } | null>(null);
  const spanOf = (i: Item): [string, string] =>
    live?.id === i.id ? [live.start, live.end] : (moved[i.id] ?? barSpan(i));
  const dragTo = (dx: number): [string, string] | null => {
    const d = drag.current;
    if (!d) return null;
    const n = Math.round(dx / ppd);
    const a = d.mode === "end" ? d.start : addDays(d.start, n);
    const b = d.mode === "start" ? d.end : addDays(d.end, n);
    return a > b ? [b, a] : [a, b];
  };
  const onDown = (e: ReactPointerEvent<HTMLButtonElement>, i: Item) => {
    if (e.button !== 0 || fixed(i)) return;
    const [start, end] = moved[i.id] ?? barSpan(i);
    const mode = grabAt(e.currentTarget.getBoundingClientRect(), e.clientX);
    const touch = e.pointerType === "touch";
    const d = { item: i, mode, x0: e.clientX, start, end, moved: false, pointer: e.pointerId, armed: !touch, timer: null as number | null };
    drag.current = d;
    // A finger: a long press picks the bar up, as on the Gantt.
    if (touch)
      d.timer = window.setTimeout(() => {
        d.armed = true;
        navigator.vibrate?.(10);
      }, LONG_PRESS_MS);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // A pointer that is gone already.
    }
  };
  const onDragMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    const dx = e.clientX - d.x0;
    if (!d.armed) {
      // A finger that moves before the long press is not a drag.
      if (Math.abs(dx) > 8) stopDrag();
      return;
    }
    if (!d.moved && Math.abs(dx) < DRAG_PX) return;
    e.preventDefault();
    d.moved = true;
    const to = dragTo(dx)!;
    if (live?.start !== to[0] || live?.end !== to[1] || live?.id !== d.item.id)
      setLive({ id: d.item.id, start: to[0], end: to[1] });
  };
  /** The drag over: no bar in hand, no live dates. */
  const stopDrag = () => {
    if (drag.current?.timer) clearTimeout(drag.current.timer);
    drag.current = null;
    setLive(null);
  };
  const onUp = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    const [s, en] = dragTo(e.clientX - d.x0)!;
    stopDrag();
    if (!d.moved) return;
    // A drag is no click: the click that follows the release opens nothing.
    clicked.current = true;
    if (s !== d.start || en !== d.end) onMove(d.item, s, en);
  };
  // A cancelled drag (the browser took the pointer) moves nothing, and no click follows it to swallow.
  const onCancel = (e: ReactPointerEvent) => {
    if (drag.current && e.pointerId === drag.current.pointer) stopDrag();
  };
  const keyMove = (i: Item, dir: 1 | -1, month: boolean) => {
    if (fixed(i)) return;
    const [s, en] = moved[i.id] ?? barSpan(i);
    const s1 = month ? addMonths(s, dir) : addDays(s, dir * 7);
    onKeyMove(i, s1, addDays(en, daysBetween(s, s1)));
  };
  const liveItem = live ? data.items.find((i) => i.id === live.id) : undefined;
  const liveWarn = live ? liveBreaks(props.byId, live.id, live.start, live.end) : [];
  const zooms: [Zoom, string][] = [
    ["6m", "6 months"],
    ["1y", "1 year"],
    ["all", "All 3 years"],
  ];
  return (
    <div className="rounded-xl border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <span className="text-sm text-text2">Show</span>
        <div
          role="group"
          aria-label="Show"
          className="inline-flex overflow-hidden rounded-lg border border-line"
        >
          {zooms.map(([z, words]) => (
            <button
              key={z}
              type="button"
              data-testid={`zoom-${z}`}
              aria-pressed={zoom === z}
              onClick={() => setZoom(z)}
              className={`px-3 py-1 text-sm font-semibold ${zoom === z ? "bg-accent text-on-accent" : "hover:bg-surface2"}`}
            >
              {words}
            </button>
          ))}
        </div>
        {!fit && (
          <button
            type="button"
            onClick={() =>
              box.current?.scrollTo({
                left: Math.max(0, xt - 60),
                behavior: "smooth",
              })
            }
            className="h-8 rounded-lg border border-line px-3 text-sm font-semibold hover:bg-surface2"
          >
            Back to today
          </button>
        )}
        {!fit && (
          <span className="ml-auto text-sm text-text2">
            Scroll sideways for earlier and later
          </span>
        )}
      </div>
      <div
        ref={box}
        data-testid="timeline-scroll"
        onScroll={(e) => setSl(e.currentTarget.scrollLeft)}
        className="relative overflow-x-auto"
      >
        <div className="relative" style={{ width: labelW + trackW }}>
          <div className="sticky top-0 z-20 flex h-11 border-b border-line bg-surface">
            <div
              data-testid="timeline-names-head"
              className="sticky left-0 z-20 flex-none border-r border-line bg-surface"
              style={{ width: labelW }}
            />
            <div className="relative" style={{ width: trackW }}>
              {months
                .filter((m) => !fit || x(m.day) < trackW - 64)
                .map((m) => (
                  <span
                    key={m.day}
                    data-testid="timeline-month"
                    className="absolute top-1 text-xs whitespace-nowrap text-text2"
                    style={{ left: x(m.day) + 4 }}
                  >
                    {m.day === firstSeen ? monthWord(m.day) : m.label}
                  </span>
                ))}
            </div>
          </div>
          <div
            className="pointer-events-none absolute top-11 bottom-0 z-10"
            style={{ left: labelW + xt, width: 2, background: TODAY }}
            data-testid="today-line"
          />
          <span
            className="absolute top-[21px] z-30 rounded-full px-2 text-xs leading-5 font-bold whitespace-nowrap text-white"
            style={{
              left: Math.max(
                labelW + 2,
                Math.min(labelW + xt - 22, labelW + trackW - 56),
              ),
              background: TODAY,
            }}
          >
            Today
          </span>
          {/* Quick add's drop targets: a quarter's columns (transparent, under the rows). */}
          {props.canChange &&
            quarters(t0, t1).map((q) => (
              <div
                key={q.start}
                data-testid="quarter-drop"
                data-add-where={whereAttr("quarter", quarterValue(q.start))}
                data-add-label={q.label}
                className="absolute top-11 bottom-0"
                style={{ left: labelW + Math.max(0, x(q.start)), width: Math.max(0, Math.min(trackW, x(addDays(q.end, 1))) - Math.max(0, x(q.start))) }}
              />
            ))}
          {months.map((m) => (
            <div
              key={m.day}
              aria-hidden
              className="absolute top-11 bottom-0 border-l border-line/60"
              style={{ left: labelW + x(m.day) }}
            />
          ))}
          {rows.map((r) => {
            if (r.kind === "lane")
              return (
                <div
                  key={`l-${r.key}`}
                  data-testid="timeline-lane"
                  className="pointer-events-none relative z-[11] flex h-8 items-end border-b border-line bg-surface2/70"
                >
                  <div className="sticky left-0 px-3 pb-1 text-sm font-semibold whitespace-nowrap">
                    {r.title}{" "}
                    <span className="font-normal text-text2">
                      · {r.count} {r.count === 1 ? "item" : "items"}
                    </span>
                  </div>
                </div>
              );
            const i = r.item;
            const lk = lookOf(i);
            const [ds, de] = spanOf(i);
            const bx = x(ds);
            const bw = Math.max(8, x(addDays(de, 1)) - bx);
            const still = fixed(i);
            const sel = openKey === i.key;
            return (
              <div
                key={i.id}
                data-testid="timeline-row"
                data-item={i.key}
                data-open={sel || undefined}
              >
                <div
                  className={`pointer-events-none relative flex border-b border-line/60 ${sel ? "bg-accent-soft/50" : ""}`}
                  style={{ height: ROW_H }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      onOpen(sel ? null : i.key);
                      // Opening an item whose bar is out of sight slides the chart to it.
                      if (!sel && (bx + bw < sl || bx > sl + visible))
                        box.current?.scrollTo({ left: Math.max(0, bx - 60) });
                    }}
                    className={`pointer-events-auto sticky left-0 z-[12] flex flex-none items-center gap-1.5 border-r border-line px-3 text-left text-sm ${sel ? "bg-accent-soft" : "bg-surface"} hover:underline`}
                    style={{ width: labelW }}
                    title={i.title}
                  >
                    <span className="min-w-0 truncate" style={lk.name}>
                      {i.title}
                    </span>
                    {lk.chip && (
                      <span data-testid="draft-tag" className="flex-none rounded-full bg-surface2 px-1.5 text-[11px] text-text2">
                        {lk.chip}
                      </span>
                    )}
                    {lk.mark && (
                      <span
                        className="flex-none text-crit"
                        aria-label="Broken link"
                      >
                        ⚠
                      </span>
                    )}
                  </button>
                  <div className="relative" style={{ width: trackW }}>
                    <button
                      type="button"
                      data-bar-id={i.id}
                      data-testid="timeline-bar"
                      data-start={ds}
                      data-end={de}
                      data-live={live?.id === i.id ? (liveWarn.length ? "broken" : "ok") : undefined}
                      aria-label={`${i.title}, ${spanWords(ds, de, data.today)}${still ? "" : ". Arrows move it a week, Shift+arrows a month; Escape cancels"}`}
                      onClick={() => {
                        if (clicked.current) clicked.current = false;
                        else onOpen(sel ? null : i.key);
                      }}
                      onPointerDown={(e) => onDown(e, i)}
                      onPointerMove={onDragMove}
                      onPointerUp={onUp}
                      onPointerCancel={onCancel}
                      onKeyDown={(e) => {
                        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                          e.preventDefault();
                          keyMove(i, e.key === "ArrowRight" ? 1 : -1, e.shiftKey);
                        } else if (e.key === "Escape") onKeyCancel(i);
                      }}
                      onBlur={() => onKeyEnd(i)}
                      className={`pointer-events-auto absolute rounded-full ${still ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"} focus-visible:shadow-[0_0_0_2px_var(--surface),0_0_0_4px_var(--accent)]`}
                      style={{
                        touchAction: still ? "auto" : "none",
                        ...lk.bar,
                        left: bx,
                        width: bw,
                        top: 8,
                        height: 18,
                        outline: sel
                          ? "2px solid var(--accent-ink)"
                          : undefined,
                        outlineOffset: 2,
                      }}
                    />
                    {!fit && bx + bw - Math.max(bx, sl) > 120 && (
                      <span
                        className="pointer-events-none absolute top-[9px] z-[11] flex px-1.5"
                        style={{
                          left: Math.max(bx, sl),
                          width: bx + bw - Math.max(bx, sl),
                        }}
                      >
                        <span className="min-w-0 truncate rounded bg-surface px-1 text-xs leading-4 text-text">
                          {spanWords(ds, de, data.today)}
                        </span>
                      </span>
                    )}
                    {live?.id === i.id && liveItem && (
                      // The Gantt's live words while a bar is dragged: its dates, and a link it would break.
                      <span
                        data-testid="drag-live"
                        data-state={liveWarn.length ? "broken" : "ok"}
                        className="pointer-events-none absolute -top-5 z-20 rounded bg-tip px-2 py-0.5 text-xs whitespace-nowrap text-tip-text"
                        style={{ left: Math.max(0, bx) }}
                      >
                        {shortDay(live.start)} – {shortDay(live.end)}
                        {liveWarn.length ? ` · ${liveWarn[0]}` : " · no broken links"}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** A phone's Timeline: a list by quarter; an item sits in the quarter it starts in (or in
 * this one, when it started before and runs on). */
function QuarterList(props: TimelineProps) {
  const { data, openKey, onOpen } = props;
  const days = data.items
    .flatMap((i) => [i.start.date, i.end.date])
    .concat(data.today)
    .sort();
  const qs = quarters(days[0], days[days.length - 1]);
  const tq = qs.find((q) => q.start <= data.today && data.today <= q.end);
  return (
    <div data-testid="timeline-list" className="space-y-3">
      {qs.map((q) => {
        const items = data.items
          .filter(
            (i) =>
              (q.start <= i.start.date && i.start.date <= q.end) ||
              (q === tq && i.start.date < q.start && i.end.date >= q.start),
          )
          .sort((a, b) => (a.start.date < b.start.date ? -1 : 1));
        if (!items.length) return null;
        return (
          <section
            key={q.start}
            data-testid="timeline-quarter"
            className="rounded-xl border border-line bg-surface"
          >
            <h3 className="flex items-center gap-2 border-b border-line px-3 py-2 text-sm font-semibold">
              {q.label}{" "}
              <span className="font-normal text-text2">
                {quarterWords(q)} · {items.length} items
              </span>
              {q === tq && (
                <span
                  className="rounded-full px-2 text-xs font-bold whitespace-nowrap text-white"
                  style={{ background: TODAY }}
                >
                  Today {shortDay(data.today)}
                </span>
              )}
            </h3>
            <ul className="divide-y divide-line/60">
              {items.map((i) => {
                const lk = lookOf(i);
                const sel = openKey === i.key;
                return (
                  <li
                    key={i.id}
                    data-testid="timeline-row"
                    data-item={i.key}
                    data-open={sel || undefined}
                  >
                    <button
                      type="button"
                      data-bar-id={i.id}
                      data-testid="timeline-bar"
                      onClick={() => onOpen(sel ? null : i.key)}
                      className={`flex w-full items-center gap-3 px-3 py-2 text-left ${sel ? "bg-accent-soft" : "hover:bg-surface2"}`}
                    >
                      <i
                        aria-hidden
                        className="h-3 w-6 flex-none rounded-full"
                        style={lk.bar}
                      />
                      <span className="min-w-0 flex-1">
                        <span
                          className="block text-sm font-semibold"
                          style={lk.name}
                        >
                          {i.title}
                          {lk.chip ? (
                            <span data-testid="draft-tag" className="ml-2 rounded-full bg-surface2 px-1.5 text-[11px] font-normal text-text2">
                              {lk.chip}
                            </span>
                          ) : null}
                        </span>
                        <span className="block text-xs text-text2">
                          {spanWords(i.start.date, i.end.date, data.today)}
                          {i.goal ? ` · ${i.goal.title}` : ""}
                        </span>
                        {brokenFlag(i) && (
                          <span className="block text-xs text-crit">
                            ⚠ Broken link
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
