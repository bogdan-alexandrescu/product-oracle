"use client";
// mk-qa4-roadmap, the owner's picks (Nov 1): the Timeline zooms around today (QR1 A), each
// state has its own look with the key on top (QR2 A), broken links sit in a panel above the
// chart (QR3 A) and an item opens in a side panel (QR4 A; a sheet on a phone).

import { MsLayer, msCode, useMsBand, useMsCtl, type MsLane, type MsRow } from "./_milestones";
import {
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { GoalNum, GoalNumbers } from "@/components/simple/GoalOrder";
import { InfoTip } from "@/components/ds/InfoTip";
import { addMonths, calendarDay } from "@/lib/dates";
import { useMe } from "@/lib/me";
import { LINK_KINDS } from "@/lib/roadmap-links";

import { FixButtons, fixCount, type Act } from "./_card";
import {
  addDays,
  barSpan,
  broken,
  closedItem,
  daysBetween,
  brokenLinks,
  liveBreaks,
  mergedName,
  ms,
  partsTree,
  planGoal,
  quarterValue,
  quarters,
  shortDay,
  spanWords,
  type Flag,
  type Item,
  type Roadmap,
  whereAttr,
} from "./_lib";
import { DRAG_PX, grabAt, LONG_PRESS_MS, msEdge, msInk, planned } from "./_timeline";
import { joinedNames, joinedWords } from "@/lib/milestone-code";

type Zoom = "3m" | "6m" | "1y" | "all";
/** Days in sight at each zoom (All fits the whole plan). */
const ZOOM_DAYS: Record<Exclude<Zoom, "all">, number> = { "3m": 91, "6m": 182, "1y": 365 };
/** The owner (Nov 9): every zoom reaches at least this day, item or not. */
const Q1_2027_END = "2027-03-31";
/** The zoom each person picked on this visit (the page's own, gone on a reload), by who is
 * signed in: someone else signing in on the same tab opens on 3 months, not on its pick. */
const visit = new Map<string, Zoom>();

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
  | { kind: "item"; item: Item; depth?: number };

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
    const sorted = [...l.items].sort((a, b) => (a.start.date < b.start.date ? -1 : 1));
    // feature-parts: every part, at any depth, right under its parent (in its top parent's
    // lane, oneLane), drawn as a tree; one whose parent is not shown keeps its own place.
    for (const x of partsTree([sorted.map((i) => i.id)], byId)[0]) out.push({ kind: "item", item: byId.get(x.id)!, depth: x.depth });
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
  /** Review: under a filter, the whole roadmap's broken links (the side menu's count), and how to see them all. */
  all?: number;
  onAll?: () => void;
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
/** A milestone label's "+N" chip, about its width. */
const MS_CHIP_W = 30;
const fullDay = (d: string) => calendarDay(d, { month: "short", day: "numeric", year: "numeric" });
const ROW_H = 34;

/** The Timeline (QR1 A): three months from just before today, one row per item, names fixed on the left;
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
          {/* The chart's bars, date words and today line stack inside its own context (isolate),
           * so they never paint over the item's panel, nor its talk widened over the chart. */}
          <div className="isolate min-w-0 flex-1">
            {phone ? <QuarterList {...props} /> : <DayChart {...props} />}
          </div>
          {side && openItem && (
            <aside
              data-testid="item-panel"
              aria-label={openItem.title}
              className="sticky top-3 z-30 max-h-[calc(100dvh-24px)] w-[400px] flex-none overflow-y-auto rounded-xl border border-line bg-surface shadow-tip"
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
  all,
  onAll,
}: Common & { onShow: (key: string) => void }) {
  // roadmap-decide: every broken link of the working draft, a cut item others depend on
  // included: the same ones Needs a decision, Home and the side menu count.
  const list = data.items.flatMap((i) => brokenLinks(i).map((f) => ({ i, f })));
  // Pre-demo QA S-14: an item's breaks together, in the order the first of them reads.
  const groups: (typeof list)[] = [];
  for (const x of list) {
    const g = groups.find((y) => y[0].i.id === x.i.id);
    if (g) g.push(x);
    else groups.push([x]);
  }
  const one = ({ i, f }: (typeof list)[number]) => {
    // Review: with more than the three fixes (a cut item's Remove the dependency per dependent),
    // the fixes take their own line under the sentence, as the tray has them.
    const stacked = phone || fixCount(f) > 3;
    return (
      <li
        key={`${i.id}-${f.kind}-${f.subject}`}
        data-testid="conflict"
        data-item={i.key}
        className={`flex px-3 py-2 ${stacked ? "flex-col gap-1" : "flex-wrap items-center gap-3"}`}
      >
        {LINK_KINDS.includes(f.kind) ? (
          <button
            type="button"
            onClick={() => onShow(i.key)}
            className={`text-left text-sm text-text hover:underline ${stacked ? "" : "min-w-[16rem] flex-1"}`}
          >
            {f.reason}
          </button>
        ) : (
          // Pre-demo QA S-5: an end past its milestone counts here too; its feature's name
          // shows, its sentence behind the (i) (no visible prose).
          <span className={`flex items-center gap-1 text-sm text-text ${stacked ? "" : "min-w-[16rem] flex-1"}`}>
            <button type="button" onClick={() => onShow(i.key)} className="text-left hover:underline">
              {i.title}
            </button>
            <InfoTip label={i.title} align="start" testId="conflict-why">
              {f.reason}
            </InfoTip>
          </span>
        )}
        <div className="max-w-full min-w-0">
          <FixButtons
            item={i}
            flag={f}
            items={byId}
            act={act}
            canChange={canChange}
            inline={!stacked}
          />
        </div>
      </li>
    );
  };
  const [shut, setShut] = useState(false);
  // Review: a filter hides some: "1 broken link here, 3 in all", with Clear filters; only
  // when the whole roadmap holds more than these filters show.
  const elsewhere = all !== undefined && all !== list.length && !!onAll;
  const showAll = elsewhere ? (
    <span className="flex flex-none items-center gap-2 text-sm font-normal text-text2" data-testid="conflicts-all">
      {all} in all
      <button type="button" onClick={onAll} className="font-semibold text-accent-ink hover:underline">
        Clear filters
      </button>
    </span>
  ) : null;
  if (!list.length)
    return (
      <div
        data-testid="conflicts"
        className="mb-2 flex flex-wrap items-center gap-x-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-text2"
      >
        {elsewhere ? "No broken links here," : "No broken links"}
        {showAll}
      </div>
    );
  return (
    <section
      data-testid="conflicts"
      className="mb-2 rounded-xl border border-crit bg-surface"
    >
      <div className="flex w-full flex-wrap items-center gap-x-2 px-3 py-2 text-sm">
        <button
          type="button"
          aria-expanded={!shut}
          onClick={() => setShut(!shut)}
          className={`flex min-w-0 items-center gap-2 text-left font-semibold text-crit ${elsewhere ? "" : "flex-1"}`}
        >
          ⚠ {list.length} broken {list.length === 1 ? "link" : "links"}
          {elsewhere ? " here," : <span className="ml-auto font-normal text-text2">{shut ? "Show" : "Hide"}</span>}
        </button>
        {showAll}
        {elsewhere && (
          <button type="button" aria-expanded={!shut} onClick={() => setShut(!shut)} className="ml-auto text-text2">
            {shut ? "Show" : "Hide"}
          </button>
        )}
      </div>
      {!shut && (
        <ul className="divide-y divide-line border-t border-line">
          {groups.map((g) =>
            g.length === 1 ? (
              one(g[0])
            ) : (
              // Pre-demo QA S-14, as on Home: an item's second break sits under its first, ruled together.
              <li key={g[0].i.id} data-testid="conflict-group" data-item={g[0].i.key} className="py-1">
                <ul className="ml-3 divide-y divide-line border-l-2 border-crit/40">{g.map(one)}</ul>
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}

/** A desktop's chart: one row per item, days to scale, zoomed to three months from just before today. */
function DayChart(props: TimelineProps) {
  const { data, phone, openKey, onOpen } = props;
  // Join whenever names match (the owner, Nov 9): a track milestone reads the joined milestone's longer name.
  const joined = joinedNames(data.goal_milestones ?? [], data.milestones ?? []);
  // build-goal-order-control: a goal lane's header leads with the goal's number.
  const numbers = useContext(GoalNumbers);
  const rows = useMemo(() => rowsOf(data), [data]);
  // The owner (Nov 9): the Timeline opens on 3 months; a person's pick holds for the visit
  // (back from the Gantt too), never stored: a new visit opens on 3 months again.
  const { me } = useMe();
  const who = me?.user_id ?? me?.token_id ?? "";
  const [, redraw] = useState(0);
  const zoom = visit.get(who) ?? "3m";
  const setZoom = (z: Zoom) => {
    visit.set(who, z);
    redraw((n) => n + 1);
  };
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
  const last = addDays(days[days.length - 1], 20);
  const t1 = last > Q1_2027_END ? last : Q1_2027_END;
  const span = daysBetween(t0, t1);
  const visible = Math.max(200, w - labelW - 2);
  const ppd = fit ? visible / span : visible / ZOOM_DAYS[zoom];
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
  // A month that starts just left of the view keeps its label, whole, at the view's left
  // edge while the next month's label is not in its way.
  const cutAt = fit ? -1 : months.findIndex((m) => x(m.day) >= sl - 2) - 1;
  const pinned =
    cutAt >= 0 &&
    (cutAt + 1 >= months.length || x(months[cutAt + 1].day) - sl > 80)
      ? months[cutAt].day
      : undefined;
  // Owner (Nov 4): 3 months marks each week, a line and its Monday's day in the months' row,
  // between the month names. A month that starts on a Monday keeps only its month line.
  const weeks: string[] = [];
  if (zoom === "3m")
    for (let d = addDays(t0, (8 - new Date(ms(t0)).getUTCDay()) % 7); d <= t1; d = addDays(d, 7))
      if (d.slice(8, 10) !== "01") weeks.push(d);
  // The first month in sight carries its year.
  const firstSeen = fit
    ? months[0]?.day
    : (pinned ?? months.find((m) => x(m.day) >= sl - 2)?.day);
  // The week marks in sight, each read without a hover: a month's first one names the month
  // ("Nov 9"), the rest give the day ("16"). A mark gives way to a month's name, or to the mark
  // before it, where they would touch.
  const monthAt = months.map((m) => {
    const at = m.day === pinned ? sl : x(m.day);
    const words = m.day === firstSeen ? monthWord(m.day) : m.label;
    return [at, at + 12 + words.length * 7];
  });
  const weekMarks: { day: string; words: string }[] = [];
  let lastMonth = "";
  let lastEnd = -Infinity;
  for (const d of weeks) {
    if (x(d) < sl + 2) continue;
    const words = d.slice(0, 7) === lastMonth ? String(Number(d.slice(8, 10))) : shortDay(d);
    const end = x(d) + 4 + words.length * 7;
    if (x(d) < lastEnd + 6 || monthAt.some(([a, b]) => end > a - 6 && x(d) < b)) continue;
    weekMarks.push({ day: d, words });
    lastMonth = d.slice(0, 7);
    lastEnd = end;
  }
  // A milestone whose line has slid under the names column keeps its label whole at the view's
  // left edge, till all of it would be gone; then the label goes too. Re-review (Nov 5): no name
  // is ever lost. A label that would meet the one before folds into that one's "+N" chip, right
  // after its label; a label ends short of the next (its words cut with "…", whole in its tip).
  const marks = (data.milestones ?? [])
    .filter((m) => m.date && m.status !== "dropped" && m.date >= t0 && m.date <= t1)
    .sort((a, b) => (a.date as string).localeCompare(b.date as string))
    .map((m) => {
      const at = x(m.date as string);
      const words = `◆ ${joinedWords(m, joined)} · ${shortDay(m.date as string)}`;
      const left = fit ? at : Math.max(at, sl);
      return { m, at, words, left, gone: !fit && at + 26 + words.length * 7 < sl };
    });
  const msGroups: { head: (typeof marks)[number]; more: (typeof marks)[number][]; room: number }[] = [];
  for (const k of marks) {
    if (k.gone) continue;
    const g = msGroups[msGroups.length - 1];
    const room = g ? k.left - 6 - g.head.left - (g.more.length ? MS_CHIP_W + 2 : 0) : Infinity;
    if (g && room < 56) g.more.push(k);
    else {
      if (g) g.room = room;
      msGroups.push({ head: k, more: [], room: Infinity });
    }
  }
  const msById = new Map(marks.map((k) => [k.m.id, k]));
  const [msTip, setMsTip] = useState<{ id: string; left: number; top: number } | null>(null);
  const [msList, setMsList] = useState<string | null>(null);
  const [msCard, setMsCard] = useState<string | null>(null);
  // The control that opened the card (a list entry's "+N" chip, as the list closes) takes the
  // focus back when the card closes by Escape or ×, so Tab goes on from where it was.
  const msBack = useRef<HTMLElement | null>(null);
  const closeMs = () => {
    setMsCard(null);
    setMsList(null);
    const back = msBack.current;
    msBack.current = null;
    if (back?.isConnected) back.focus();
  };
  useEffect(() => {
    if (!msCard && !msList) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (msCard) closeMs();
      else setMsList(null);
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  });
  // The card takes the focus as it opens (a chip's list it came from closes), without scrolling
  // the chart: a tall card on a short chart would slide the month header out of sight.
  const msCardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (msCard) msCardRef.current?.focus({ preventScroll: true });
  }, [msCard]);
  // A line's tip follows the pointer down the line, once a frame at most.
  const tipNext = useRef<{ id: string; left: number; top: number } | null>(null);
  const tipFrame = useRef(0);
  const moveTip = (tip: { id: string; left: number; top: number }) => {
    tipNext.current = tip;
    if (tipFrame.current) return;
    tipFrame.current = requestAnimationFrame(() => {
      tipFrame.current = 0;
      setMsTip(tipNext.current);
    });
  };
  const leaveTip = () => {
    cancelAnimationFrame(tipFrame.current);
    tipFrame.current = 0;
    setMsTip(null);
  };
  useEffect(() => () => cancelAnimationFrame(tipFrame.current), []);
  // roadmap-milestone-codes: the milestone band's row under the date axis.
  const msBandH = useMsBand(phone);
  // The other names of the joined milestone, each once ("Also: M1 Measured").
  const alsoOf = (m: { roadmap_code?: string | null }) => {
    const a = m.roadmap_code ? joined.get(m.roadmap_code)?.also : undefined;
    return a?.length ? `Also: ${a.join(", ")}` : null;
  };
  const msWords = (m: (typeof marks)[number]["m"]) =>
    `${joinedWords(m, joined)}, ${fullDay(m.date as string)}${m.done_when.length ? ` · counts when ${m.done_when.join("; ")}` : ""}`;
  // A tip or a card stays inside the chart's view, right of the names column.
  const inView = (l: number, width: number) => Math.max(labelW + sl + 6, Math.min(l, sl + w - width - 6));
  const openMs = (id: string, from: HTMLElement | null) => {
    msBack.current = msCard === id ? null : from;
    setMsList(null);
    setMsTip(null);
    setMsCard(msCard === id ? null : id);
  };
  // roadmap-r2: the Gantt's moves. A drag past DRAG_PX moves the bar by whole days (an end
  // grabbed near the bar's edge, grabAt, moves only that end); a shorter one is a click. A
  // finger picks a bar up with the Gantt's long press first. The arrow keys move a focused
  // bar a week, Shift+arrow a month; each move is the Gantt's change. Cut and planned items,
  // and a viewer's bars, do not move.
  const { canChange, moved, onMove, onKeyMove, onKeyEnd, onKeyCancel } = props;
  const fixed = (i: Item) => !canChange || closedItem(i) || planned(i);
  const drag = useRef<{
    item: Item;
    mode: "move" | "start" | "end";
    x0: number;
    start: string;
    end: string;
    moved: boolean;
    pointer: number;
    armed: boolean;
    timer: number | null;
    dx: number;
    frame: number | null;
  } | null>(null);
  const clicked = useRef(false);
  // The bar in hand lives outside the chart's state: a move redraws only its own row.
  const [live] = useState(liveStore);
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
    const d = {
      item: i,
      mode,
      x0: e.clientX,
      start,
      end,
      moved: false,
      pointer: e.pointerId,
      armed: !touch,
      timer: null as number | null,
      dx: 0,
      frame: null as number | null,
    };
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
    // The bar follows the pointer once a frame, however many moves the frame had (as the Gantt).
    d.dx = dx;
    d.frame ??= requestAnimationFrame(() => {
      d.frame = null;
      if (drag.current !== d) return;
      const to = dragTo(d.dx)!;
      const was = live.get();
      if (was?.start !== to[0] || was?.end !== to[1] || was?.id !== d.item.id)
        live.set({ id: d.item.id, start: to[0], end: to[1] });
    });
  };
  /** The drag over: no bar in hand, no live dates. */
  const stopDrag = () => {
    if (drag.current?.timer) clearTimeout(drag.current.timer);
    if (drag.current?.frame != null) cancelAnimationFrame(drag.current.frame);
    drag.current = null;
    live.set(null);
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
  // The rows' moves read the latest draw's state through a ref, so each row's `on` stays the
  // same object and only the rows whose own props change redraw.
  const latest = useRef({
    onDown,
    onDragMove,
    onUp,
    onCancel,
    keyMove,
    onKeyCancel,
    onKeyEnd,
    onOpen,
    sl,
    visible,
  });
  useLayoutEffect(() => {
    latest.current = {
      onDown,
      onDragMove,
      onUp,
      onCancel,
      keyMove,
      onKeyCancel,
      onKeyEnd,
      onOpen,
      sl,
      visible,
    };
  });
  const on = useMemo<RowMoves>(
    () => ({
      name: (i, sel, bx, bw) => {
        const l = latest.current;
        l.onOpen(sel ? null : i.key);
        // Opening an item whose bar is out of sight slides the chart to it.
        if (!sel && (bx + bw < l.sl || bx > l.sl + l.visible))
          box.current?.scrollTo({ left: Math.max(0, bx - 60) });
      },
      bar: (i, sel) => {
        if (clicked.current) clicked.current = false;
        else latest.current.onOpen(sel ? null : i.key);
      },
      down: (e, i) => latest.current.onDown(e, i),
      move: (e) => latest.current.onDragMove(e),
      up: (e) => latest.current.onUp(e),
      cancel: (e) => latest.current.onCancel(e),
      keyMove: (i, dir, month) => latest.current.keyMove(i, dir, month),
      keyCancel: (i) => latest.current.onKeyCancel(i),
      keyEnd: (i) => latest.current.onKeyEnd(i),
    }),
    [],
  );
  const zooms: [Zoom, string][] = [
    ["3m", "3 months"],
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
                // A month that starts left of the view would peek out from under the names
                // column cut short; the picked frames show only months that start in sight.
                .filter((m) =>
                  fit
                    ? x(m.day) < trackW - 64
                    : x(m.day) >= sl - 2 || m.day === pinned,
                )
                .map((m) => (
                  <span
                    key={m.day}
                    data-testid="timeline-month"
                    data-keep-clear
                    className="absolute top-1 text-xs whitespace-nowrap text-text2"
                    style={{ left: (m.day === pinned ? sl : x(m.day)) + 4 }}
                  >
                    {m.day === firstSeen ? monthWord(m.day) : m.label}
                  </span>
                ))}
              {weekMarks.map(({ day, words }) => (
                <span
                  key={day}
                  data-testid="timeline-week"
                  data-keep-clear
                  title={`Week of ${shortDay(day)}`}
                  className="absolute top-1 text-xs whitespace-nowrap text-text2/80"
                  style={{ left: x(day) + 4 }}
                >
                  {words}
                </span>
              ))}
            </div>
          </div>
          {msBandH > 0 && (
            <div className="flex" style={{ height: msBandH }}>
              <div className="sticky left-0 z-20 flex flex-none items-center border-r border-b border-line bg-surface px-3 text-xs font-semibold text-text2" style={{ width: labelW }}>
                Milestones
              </div>
            </div>
          )}
          <div
            className="pointer-events-none absolute top-11 bottom-0 z-10"
            style={{ left: labelW + xt, width: 2, background: TODAY }}
            data-testid="today-line"
          />
          <span
            data-testid="today-pill"
            data-keep-clear
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
          {/* approved-roadmap-to-simple: the roadmap's milestones (an approved version's too),
           * each a dashed line on its day with its name, as the Gantt marks them. */}
          {marks.map(({ m, at }) =>
            // A line under the names column would show through a goal's header row. It lies under
            // the rows (a bar on it keeps the pointer), which let the pointer through elsewhere.
            fit || at >= sl ? (
              <button
                key={m.id}
                type="button"
                data-testid="timeline-milestone-line"
                data-day={m.date}
                aria-label={msWords(m)}
                // The label (or its chip) is the milestone's one Tab stop; the line keeps the pointer.
                tabIndex={-1}
                onPointerEnter={(e) => moveTip({ id: m.id, left: labelW + at + 8, top: e.clientY - e.currentTarget.getBoundingClientRect().top + 44 + 12 })}
                onPointerMove={(e) => moveTip({ id: m.id, left: labelW + at + 8, top: e.clientY - e.currentTarget.getBoundingClientRect().top + 44 + 12 })}
                onPointerLeave={leaveTip}
                onFocus={() => setMsTip({ id: m.id, left: labelW + at + 8, top: 48 })}
                onBlur={leaveTip}
                onClick={(e) => openMs(m.id, e.currentTarget)}
                className="absolute top-11 bottom-0 z-10 w-[6px] cursor-pointer border-l-2 border-dashed border-text2 focus-visible:outline-2 focus-visible:outline-accent"
                style={{ left: labelW + at }}
              />
            ) : null,
          )}
          {msGroups.map(({ head: { m, left, words }, more, room }) => (
            <div
              key={m.id}
              className="absolute top-[21px] z-[25] flex items-start gap-0.5"
              style={{ left: labelW + left + 4 }}
            >
              <button
                type="button"
                data-testid="timeline-milestone"
                aria-label={msWords(m)}
                aria-expanded={msCard === m.id}
                onPointerEnter={(e) => setMsTip({ id: m.id, left: labelW + left + 4, top: 42 + (e.currentTarget.offsetHeight - 18) })}
                onPointerLeave={() => setMsTip(null)}
                onFocus={() => setMsTip({ id: m.id, left: labelW + left + 4, top: 42 })}
                onBlur={() => setMsTip(null)}
                onClick={(e) => openMs(m.id, e.currentTarget)}
                className="min-w-0 cursor-pointer overflow-hidden rounded-full border border-line bg-surface px-2 text-xs leading-4 text-ellipsis whitespace-nowrap text-text hover:bg-surface2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                style={{ maxWidth: room < Infinity ? room : undefined }}
              >
                {words}
              </button>
              {more.length > 0 && (
                <div className="group relative flex-none">
                  <button
                    type="button"
                    data-testid="timeline-milestone-more"
                    aria-label={`${more.length} more ${more.length === 1 ? "milestone" : "milestones"}: ${more.map((k) => joinedWords(k.m, joined)).join(", ")}`}
                    aria-expanded={msList === m.id}
                    onClick={() => setMsList((l) => (l === m.id ? null : m.id))}
                    className="block cursor-pointer rounded-full border border-line bg-surface px-1.5 text-xs leading-4 font-semibold text-text2 hover:bg-surface2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                    style={{ minWidth: MS_CHIP_W - 4 }}
                  >
                    +{more.length}
                  </button>
                  <div className={`absolute top-full left-0 z-40 pt-1 ${msList === m.id ? "block" : "hidden group-focus-within:block group-hover:block"}`}>
                    <ul
                      data-testid="timeline-milestone-list"
                      aria-label="More milestones here"
                      className="min-w-48 rounded-lg border border-line bg-surface py-1 shadow-lg"
                    >
                      {more.map((k) => (
                        <li key={k.m.id}>
                          <button
                            type="button"
                            data-testid="timeline-milestone-entry"
                            aria-label={msWords(k.m)}
                            onClick={(e) =>
                              openMs(k.m.id, e.currentTarget.closest(".group")?.querySelector<HTMLElement>('[data-testid="timeline-milestone-more"]') ?? null)
                            }
                            className="block w-full px-3 py-1 text-left text-xs whitespace-nowrap text-text hover:bg-surface2 focus-visible:bg-surface2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                          >
                            {k.words}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </div>
          ))}
          {msTip && msById.has(msTip.id) && (
            <span
              data-testid="timeline-milestone-tip"
              role="tooltip"
              className="pointer-events-none absolute z-40 max-w-80 rounded bg-tip px-2 py-0.5 text-xs text-tip-text"
              style={{ left: inView(msTip.left, 240), top: msTip.top }}
            >
              {msWords(msById.get(msTip.id)!.m)}
              {alsoOf(msById.get(msTip.id)!.m) && <span className="block">{alsoOf(msById.get(msTip.id)!.m)}</span>}
            </span>
          )}
          {msCard &&
            msById.has(msCard) &&
            (() => {
              const { m, at } = msById.get(msCard)!;
              const gates = m.item_ids.map((id) => data.items.find((i) => i.id === id)).filter((i) => i !== undefined);
              return (
                <div
                  ref={msCardRef}
                  tabIndex={-1}
                  data-testid="timeline-milestone-card"
                  role="dialog"
                  aria-label={`${joinedWords(m, joined)}, ${fullDay(m.date as string)}`}
                  className="absolute top-12 z-40 flex w-72 flex-col gap-2 rounded-xl border border-line bg-surface p-3 text-sm shadow-xl outline-none"
                  style={{ left: inView(labelW + at + 4, 288) }}
                >
                  <div className="flex items-start gap-2">
                    <span className="min-w-0 flex-1 font-semibold text-text">◆ {joinedWords(m, joined)}</span>
                    <button
                      type="button"
                      aria-label="Close"
                      onClick={closeMs}
                      className="h-6 w-6 flex-none rounded text-text2 hover:bg-surface2 focus-visible:outline-2 focus-visible:outline-accent"
                    >
                      ×
                    </button>
                  </div>
                  <span className="text-text2">{fullDay(m.date as string)}</span>
                  {alsoOf(m) && <span data-testid="timeline-milestone-also" className="text-text2">{alsoOf(m)}</span>}
                  {m.done_when.length > 0 && <span className="text-text">Counts when {m.done_when.join("; ")}</span>}
                  {gates.length > 0 && (
                    <div className="flex flex-col gap-1">
                      <span className="text-xs font-semibold text-text2">Waits on</span>
                      {gates.map((i) => (
                        <button
                          key={i.id}
                          type="button"
                          onClick={() => {
                            msBack.current = null;
                            setMsCard(null);
                            onOpen(i.key);
                          }}
                          className="text-left text-accent-ink hover:underline focus-visible:outline-2 focus-visible:outline-accent"
                        >
                          {i.title}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}
          {/* Quick add's drop targets: a quarter's columns (transparent, under the rows). */}
          {props.canChange &&
            quarters(t0, t1).map((q) => (
              <div
                key={q.start}
                data-testid="quarter-drop"
                data-add-where={whereAttr("quarter", quarterValue(q.start))}
                data-add-label={q.label}
                className="absolute top-11 bottom-0"
                style={{
                  left: labelW + Math.max(0, x(q.start)),
                  width: Math.max(
                    0,
                    Math.min(trackW, x(addDays(q.end, 1))) -
                      Math.max(0, x(q.start)),
                  ),
                }}
              />
            ))}
          {months.map((m) => (
            <div
              key={m.day}
              aria-hidden
              data-testid="timeline-month-line"
              data-day={m.day}
              className="absolute top-11 bottom-0 border-l border-line/60"
              style={{ left: labelW + x(m.day) }}
            />
          ))}
          {weeks.map((d) => (
            <div
              key={`w-${d}`}
              aria-hidden
              data-testid="timeline-week-line"
              data-day={d}
              className="absolute top-11 bottom-0 border-l border-dashed border-line/40"
              style={{ left: labelW + x(d) }}
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
                    {data.group === "goal" && r.key !== "none" && r.key !== "below" && <GoalNum n={numbers.get(r.key) ?? numbers.get(r.title)} />}
                    {r.title}{" "}
                    <span className="font-normal text-text2">
                      · {r.count} {r.count === 1 ? "item" : "items"}
                    </span>
                  </div>
                </div>
              );
            const i = r.item;
            const [ds, de] = moved[i.id] ?? barSpan(i);
            return (
              <TimelineRow
                key={i.id}
                item={i}
                ds={ds}
                de={de}
                t0={t0}
                ppd={ppd}
                labelW={labelW}
                trackW={trackW}
                sl={sl}
                fit={fit}
                today={data.today}
                canChange={canChange}
                still={fixed(i)}
                sel={openKey === i.key}
                live={live}
                byId={props.byId}
                on={on}
                depth={r.depth ?? 0}
              />
            );
          })}
          {/* build-milestones-on-roadmap: the milestones over the Timeline */}
          <TimelineMilestones
            rows={rows}
            moved={moved}
            x={x}
            labelW={labelW}
            trackW={trackW}
            phone={phone}
            span={[labelW + sl, sl + w]}
            keepOff={msGroups.map(({ head, more, room }): [number, number] => [
              labelW + head.left + 4,
              labelW + head.left + 4 + Math.min(room, 16 + head.words.length * 7) + (more.length ? MS_CHIP_W + 2 : 0),
            ])}
          />
        </div>
      </div>
    </div>
  );
}

/** build-milestones-on-roadmap: each row's place, for the milestone layer over the Timeline. */
function TimelineMilestones({ rows, moved, x, labelW, trackW, phone, span, keepOff }: { rows: Row[]; moved: Record<string, [string, string]>; x: (d: string) => number; labelW: number; trackW: number; phone: boolean; span: [number, number]; keepOff: [number, number][] }) {
  let y = 44 + useMsBand(phone);
  const out: MsRow[] = [];
  const lanes: MsLane[] = [];
  for (const r of rows) {
    if (r.kind === "lane") {
      lanes.push({ key: r.key, title: r.title, y0: y, y1: y + 32 });
      y += 32;
      continue;
    }
    const [s, e] = moved[r.item.id] ?? barSpan(r.item);
    out.push({ id: r.item.id, title: r.item.title, lane: lanes[lanes.length - 1]?.key ?? "", y, h: ROW_H, start: s, end: e });
    y += ROW_H;
    if (lanes.length) lanes[lanes.length - 1].y1 = y;
  }
  return <MsLayer view="timeline" x={x} left={labelW} top={44} axisY={33} height={y} width={labelW + trackW} rows={out} lanes={lanes} phone={phone} span={span} keepOff={keepOff} bandTop={44} />;
}

const NO_WARN: string[] = [];

type Live = { id: string; start: string; end: string } | null;

/** The day chart's bar in hand and its live dates. Each row reads only its own bar from it
 * (useSyncExternalStore), so a drag's move redraws the dragged row, not the chart's 500. */
function liveStore() {
  let now: Live = null;
  const seen = new Set<() => void>();
  return {
    get: () => now,
    set: (next: Live) => {
      now = next;
      seen.forEach((f) => f());
    },
    watch: (f: () => void) => {
      seen.add(f);
      return () => {
        seen.delete(f);
      };
    },
  };
}
type LiveStore = ReturnType<typeof liveStore>;

/** A day chart row's moves, the same functions on every draw (so memo(TimelineRow) holds). */
type RowMoves = {
  name: (i: Item, sel: boolean, bx: number, bw: number) => void;
  bar: (i: Item, sel: boolean) => void;
  down: (e: ReactPointerEvent<HTMLButtonElement>, i: Item) => void;
  move: (e: ReactPointerEvent) => void;
  up: (e: ReactPointerEvent) => void;
  cancel: (e: ReactPointerEvent) => void;
  keyMove: (i: Item, dir: 1 | -1, month: boolean) => void;
  keyCancel: (i: Item) => void;
  keyEnd: (i: Item) => void;
};

/** One item's row of the day chart: its name and its bar. A drag redraws only the bar in
 * hand (memo, as the Gantt's Bar), not the 500 rows. */
const TimelineRow = memo(function TimelineRow({
  item: i,
  ds: ds0,
  de: de0,
  t0,
  ppd,
  labelW,
  trackW,
  sl,
  fit,
  today,
  canChange,
  still,
  sel,
  live: store,
  byId,
  on,
  depth,
}: {
  item: Item;
  ds: string;
  de: string;
  t0: string;
  ppd: number;
  labelW: number;
  trackW: number;
  sl: number;
  fit: boolean;
  today: string;
  canChange: boolean;
  still: boolean;
  sel: boolean;
  live: LiveStore;
  byId: Map<string, Item>;
  on: RowMoves;
  /** feature-parts: how deep a part it is (0: a feature of its own). */
  depth: number;
}) {
  const lk = lookOf(i);
  const live = useSyncExternalStore(
    store.watch,
    () => {
      const l = store.get();
      return l?.id === i.id ? l : null;
    },
    () => null,
  );
  const [ds, de] = live ? [live.start, live.end] : [ds0, de0];
  const bx = daysBetween(t0, ds) * ppd;
  const bw = Math.max(8, daysBetween(t0, addDays(de, 1)) * ppd - bx);
  const liveWarn = useMemo(
    () => (live ? liveBreaks(byId, live.id, live.start, live.end) : NO_WARN),
    [live, byId],
  );
  return (
    <div
      data-testid="timeline-row"
      data-item={i.key}
      data-depth={depth || undefined}
      data-open={sel || undefined}
      // A row out of sight is not painted (content-visibility), so a drag's frame repaints the
      // rows in sight and not the chart's 500. Its containment stacks the row on its own, so
      // the row sits over the chart's today line and draws its own piece of it (below). Only its
      // name and bar take the pointer: a milestone's line under the row takes the rest.
      className="pointer-events-none relative z-[11]"
      style={
        live
          ? undefined
          : {
              contentVisibility: "auto",
              containIntrinsicSize: `auto ${ROW_H}px`,
            }
      }
    >
      <div
        className={`pointer-events-none relative flex border-b border-line/60 ${sel ? "bg-accent-soft/50" : ""}`}
        style={{ height: ROW_H }}
      >
        <button
          type="button"
          onClick={() => on.name(i, sel, bx, bw)}
          className={`pointer-events-auto sticky left-0 z-[12] flex flex-none items-center gap-1.5 border-r border-line px-3 text-left text-sm ${sel ? "bg-accent-soft" : "bg-surface"} hover:underline`}
          style={{ width: labelW, paddingLeft: 12 + depth * 14 }}
          title={i.title}
        >
          {/* feature-parts: a part drawn as a branch of its parent's tree. */}
          {depth > 0 && (
            <span aria-hidden className="flex-none text-text2">
              └
            </span>
          )}
          <span className="min-w-0 truncate" style={lk.name}>
            {i.title}
            {/* panel-menu: a merged feature says where it went, by code and name as its panel does. */}
            {i.merged_into && <span data-testid="row-merged" className="ml-1 text-text2">· Merged into {mergedName(i, (id) => byId.get(id))}</span>}
          </span>
          {lk.chip && (
            <span
              data-testid="draft-tag"
              className="flex-none rounded-full bg-surface2 px-1.5 text-[11px] text-text2"
            >
              {lk.chip}
            </span>
          )}
          {lk.mark && (
            <span className="flex-none text-crit" aria-label="Broken link">
              ⚠
            </span>
          )}
        </button>
        <div className="relative" style={{ width: trackW }}>
          <div
            aria-hidden
            className="pointer-events-none absolute top-0 bottom-0 z-10"
            style={{
              left: daysBetween(t0, today) * ppd,
              width: 2,
              background: TODAY,
            }}
          />
          <button
            type="button"
            data-bar-id={i.id}
            data-testid="timeline-bar"
            data-start={ds}
            data-end={de}
            data-live={live ? (liveWarn.length ? "broken" : "ok") : undefined}
            aria-label={`${i.title}, ${spanWords(ds, de, today)}${canChange && planned(i) && !closedItem(i) ? ". Its dates follow the PRD's plan: change them in the PRD" : ""}${still ? "" : ". Arrows move it a week, Shift+arrows a month; Escape cancels"}`}
            onClick={() => on.bar(i, sel)}
            onPointerDown={(e) => on.down(e, i)}
            onPointerMove={on.move}
            onPointerUp={on.up}
            onPointerCancel={on.cancel}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                e.preventDefault();
                on.keyMove(i, e.key === "ArrowRight" ? 1 : -1, e.shiftKey);
              } else if (e.key === "Escape") on.keyCancel(i);
            }}
            onBlur={() => on.keyEnd(i)}
            className={`pointer-events-auto absolute rounded-full ${still ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"} focus-visible:shadow-[0_0_0_2px_var(--surface),0_0_0_4px_var(--accent)]`}
            style={{
              touchAction: still ? "auto" : "none",
              ...lk.bar,
              left: bx,
              width: bw,
              top: 8,
              height: 18,
              outline: sel ? "2px solid var(--accent-ink)" : undefined,
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
                {spanWords(ds, de, today)}
              </span>
            </span>
          )}
          {/* roadmap-decide: an item with no dates of its own (Oracle's estimate on both ends) whose
           * bar has no room for its dates says so beside it, never a bare unlabeled pill. */}
          {!live && i.start.estimated && i.end.estimated && (fit || bx + bw - Math.max(bx, sl) <= 120) && (
            <span
              data-testid="bar-no-dates"
              className="pointer-events-none absolute top-[9px] z-[11] rounded bg-surface px-1 text-xs leading-4 whitespace-nowrap text-text2"
              style={bx + bw + 96 <= trackW ? { left: bx + bw + 4 } : bx >= 96 ? { left: bx - 92 } : { left: Math.max(bx, 0) + 4 }}
            >
              No dates yet
            </span>
          )}
          {live && (
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
});

/** roadmap-milestone-codes: on a phone, the quarter's milestones across the roadmap, one line each, by date. */
function QuarterMilestones({ from, to }: { from: string; to: string }) {
  const ms = useMsCtl();
  const list = (ms?.band ?? []).filter((m) => from <= m.date! && m.date! <= to);
  if (!list.length) return null;
  return (
    <ul data-testid="ms-quarter" className="border-b border-line/60 bg-surface2/60 px-3 py-1.5 text-xs">
      {list.map((m) => (
        <li key={m.id} className="flex items-center gap-1.5 py-0.5">
          <i aria-hidden className="h-2 w-2 flex-none rotate-45 rounded-[1px]" style={{ background: msEdge(msCode(m)) }} />
          <span className="min-w-0 truncate font-semibold" style={{ color: msInk(msCode(m)) }}>
            {msCode(m)} {ms?.joined.get(msCode(m))?.name ?? m.name}
          </span>
          <span className="ml-auto flex-none text-text2">{shortDay(m.date!)}</span>
        </li>
      ))}
    </ul>
  );
}

/** A phone's Timeline: a list by quarter; an item sits in the quarter it starts in (or in
 * this one, when it started before and runs on). */
function QuarterList(props: TimelineProps) {
  const { data, openKey, onOpen } = props;
  // Join whenever names match (the owner, Nov 9): a track milestone reads the joined milestone's longer name.
  const joined = joinedNames(data.goal_milestones ?? [], data.milestones ?? []);
  const days = data.items
    .flatMap((i) => [i.start.date, i.end.date])
    .concat(data.today)
    .sort();
  const qs = quarters(days[0], days[days.length - 1]);
  const tq = qs.find((q) => q.start <= data.today && data.today <= q.end);
  const byId = new Map(data.items.map((i) => [i.id, i]));
  return (
    <div data-testid="timeline-list" className="space-y-3">
      {qs.map((q) => {
        const inQ = data.items
          .filter(
            (i) =>
              (q.start <= i.start.date && i.start.date <= q.end) ||
              (q === tq && i.start.date < q.start && i.end.date >= q.start),
          )
          .sort((a, b) => (a.start.date < b.start.date ? -1 : 1));
        if (!inQ.length) return null;
        // feature-parts: the quarter's parts under their parents, as a tree.
        const tree = partsTree([inQ.map((i) => i.id)], byId)[0];
        const depth = new Map(tree.map((x) => [x.id, x.depth]));
        const items = tree.map((x) => byId.get(x.id)!);
        return (
          <section
            key={q.start}
            data-testid="timeline-quarter"
            className="rounded-xl border border-line bg-surface"
          >
            <h3 className="flex items-center gap-2 border-b border-line px-3 py-2 text-sm font-semibold">
              {q.label}{" "}
              <span className="font-normal text-text2">
                {quarterWords(q)} · {items.length} {items.length === 1 ? "item" : "items"}
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
            {/* approved-roadmap-to-simple: the quarter's milestones, as the desktop's dashed lines. */}
            {(data.milestones ?? [])
              .filter((m) => m.date && m.status !== "dropped" && q.start <= m.date && m.date <= q.end)
              .map((m) => (
                <p
                  key={m.id}
                  data-testid="timeline-milestone"
                  className="border-b border-line/60 px-3 py-1 text-xs text-text2"
                >
                  ◆ {joinedWords(m, joined)} · {shortDay(m.date as string)}
                  {m.done_when.length > 0 && ` · counts when ${m.done_when.join("; ")}`}
                </p>
              ))}
            <QuarterMilestones from={q.start} to={q.end} />
            <ul className="divide-y divide-line/60">
              {items.map((i) => {
                const lk = lookOf(i);
                const sel = openKey === i.key;
                // ah2-roadmap-specs review: the goal its Gantt lane names (its PRD's, else its own).
                const goal = planGoal(i) ?? i.goal?.title;
                return (
                  <li
                    key={i.id}
                    data-testid="timeline-row"
                    data-item={i.key}
                    data-depth={depth.get(i.id) || undefined}
                    data-open={sel || undefined}
                    style={{ paddingLeft: (depth.get(i.id) ?? 0) * 16 }}
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
                          {(depth.get(i.id) ?? 0) > 0 && (
                            <span aria-hidden className="mr-1 font-normal text-text2">
                              └
                            </span>
                          )}
                          {i.title}
                          {lk.chip ? (
                            <span
                              data-testid="draft-tag"
                              className="ml-2 rounded-full bg-surface2 px-1.5 text-[11px] font-normal text-text2"
                            >
                              {lk.chip}
                            </span>
                          ) : null}
                        </span>
                        <span className="block text-xs text-text2">
                          {spanWords(i.start.date, i.end.date, data.today)}
                          {goal ? ` · ${goal}` : ""}
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
