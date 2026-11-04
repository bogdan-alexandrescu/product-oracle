"use client";
/* build-milestones-on-roadmap (the owner's picks: 'Click the time axis', 'Card, line per goal',
 * 'Edit asks the PRD'): a roadmap's milestones per goal on Simple Roadmap's Timeline, Gantt and
 * Now / Next / Later. Pointing at the time axis shows a hollow diamond and "+ Milestone on <day>";
 * a click opens the card in the chart's top corner (a sheet on a phone), bars tapped while it is
 * open become the items it waits on. A milestone is a diamond on the axis and a line across its own
 * goal's rows; a drag on the diamond moves it, a click opens it to edit or remove; every change has
 * Undo. A PRD's own milestones are hollow and dashed: a change to one asks the PRD's owner. */

import { createContext, useContext, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { api, unwrap, type Schemas } from "@/lib/api/client";
import { addDays, calendarDay } from "@/lib/dates";

import { shortDay, type Item, type Roadmap } from "./_lib";
import { msEdge, msFill, msInk } from "./_timeline";

export type GoalMilestone = Schemas["SimpleGoalMilestone"];
export type MsRow = { id: string; title: string; lane: string; y: number; h: number; start: string; end: string };
export type MsLane = { key: string; title: string; y0: number; y1: number };

const day = (d: string) => shortDay(d);
const fullDay = (d: string) => calendarDay(d, { month: "short", day: "numeric", year: "numeric" });
const words = (m: { code: string; name: string }) => `${m.code} ${m.name}`;

/** The rules a milestone counts by, offered on the card (its own one kept when it differs). */
const RULES = ["Holds 7 days in a row", "Holds 14 days in a row", "Holds 4 weeks in a row", "Holds 7 days in a row on one live team", "Holds 14 days in a row on all teams"];

type Draft = { id: string | null; code: string; name: string; date: string; goal_id: string | null; item_ids: string[]; counts_when: string; second: boolean; prd: boolean };
type Toast = { words: string; undo: (() => Promise<unknown>) | null };

export interface MsCtl {
  list: GoalMilestone[];
  draft: Draft | null;
  hover: string | null;
  moving: { id: string; date: string } | null;
  toast: Toast | null;
  phone: boolean;
  canAdd: boolean;
  goals: { id: string; title: string }[];
  items: Map<string, Item>;
  today: string;
  setHover: (d: string | null) => void;
  setMoving: (m: { id: string; date: string } | null) => void;
  setDraft: (d: Draft | null) => void;
  /** The goal whose rows the pointer was last over. */
  overLane: (goal: string | null) => void;
  begin: (date: string, goal: string | null) => void;
  edit: (m: GoalMilestone) => void;
  /** A bar tapped while the card is open: an item it waits on (again: no longer). */
  pick: (itemId: string) => boolean;
  save: (again: boolean) => Promise<void>;
  remove: () => Promise<void>;
  move: (m: GoalMilestone, date: string) => Promise<void>;
  undo: () => Promise<void>;
  closeToast: () => void;
}

const Ctx = createContext<MsCtl | null>(null);
export const MsProvider = ({ value, children }: { value: MsCtl; children: ReactNode }) => <Ctx.Provider value={value}>{children}</Ctx.Provider>;
export const useMsCtl = () => useContext(Ctx);

/** The milestones' state and their changes for one read of the roadmap (`reload` reads it again). */
export function useMilestones({ data, phone, canChange, reload }: { data: Roadmap | undefined; phone: boolean; canChange: boolean; reload: () => Promise<unknown> }): MsCtl | null {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [moving, setMoving] = useState<{ id: string; date: string } | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const lastLane = useRef<string | null>(null);
  if (!data) return null;
  const list = data.goal_milestones ?? [];
  const items = new Map(data.items.map((i) => [i.id, i]));
  const goals = [...new Map(data.items.flatMap((i) => (i.goal ? [[i.goal.id, { id: i.goal.id, title: i.goal.title }] as const] : []))).values()];
  const goalTitle = (id: string | null) => goals.find((g) => g.id === id)?.title ?? "No goal";
  const nextCode = (goal: string | null) => `M${list.filter((m) => m.goal_id === goal && !m.prd).reduce((a, m) => Math.max(a, Number(m.code.slice(1)) || 0), 0) + 1}`;
  const roadmapOf = (goal: string | null) => data.roadmap?.id ?? data.items.find((i) => i.goal?.id === goal)?.roadmap.id ?? data.items[0]?.roadmap.id;
  const lateOf = (ids: string[], date: string) => ids.filter((id) => (items.get(id)?.end.date ?? "") > date).length;
  const fresh = (date: string, goal: string | null, second = false): Draft => ({ id: null, code: nextCode(goal), name: "", date, goal_id: goal, item_ids: [], counts_when: RULES[0], second, prd: false });
  const done = async (t: Toast) => {
    await reload();
    setToast(t);
  };
  const patch = (id: string, body: Schemas["SimpleGoalMilestonePatch"]) => unwrap(api.PATCH("/v1/simple/roadmap/milestones/{milestone_id}", { params: { path: { milestone_id: id } }, body }));
  return {
    list,
    draft,
    hover,
    moving,
    toast,
    phone,
    canAdd: canChange,
    goals,
    items,
    today: data.today,
    setHover,
    setMoving,
    setDraft,
    overLane: (g) => {
      lastLane.current = g;
    },
    begin: (date, goal) => {
      setToast(null);
      setDraft((d) => (d && !d.id ? { ...d, date } : fresh(date, goal ?? lastLane.current ?? goals[0]?.id ?? null)));
    },
    edit: (m) => {
      setToast(null);
      setDraft({ id: m.id, code: m.code, name: m.name, date: m.pending?.date ?? m.date ?? data.today, goal_id: m.goal_id ?? null, item_ids: m.item_ids, counts_when: m.counts_when, second: false, prd: !!m.prd });
    },
    pick: (itemId) => {
      if (!draft || draft.prd) return false;
      setDraft({ ...draft, item_ids: draft.item_ids.includes(itemId) ? draft.item_ids.filter((x) => x !== itemId) : [...draft.item_ids, itemId] });
      return true;
    },
    save: async (again) => {
      if (!draft) return;
      const d = draft;
      if (d.prd) {
        const m = list.find((x) => x.id === d.id)!;
        await patch(d.id!, { date: d.date, counts_when: d.counts_when === m.counts_when ? null : d.counts_when });
        setDraft(null);
        await done({ words: `Asked ${m.prd_owner ?? "the PRD's owner"} to move ${words(m)} to ${day(d.date)} in the PRD`, undo: () => patch(m.id, { date: m.date }) });
        return;
      }
      if (d.id) {
        const was = list.find((x) => x.id === d.id)!;
        await patch(d.id, { name: d.name, date: d.date, goal_id: d.goal_id, item_ids: d.item_ids, counts_when: d.counts_when });
        setDraft(null);
        await done({ words: `${words({ code: d.code, name: d.name })} saved`, undo: () => patch(was.id, { name: was.name, date: was.date, goal_id: was.goal_id, item_ids: was.item_ids, counts_when: was.counts_when }) });
        return;
      }
      const made = await unwrap(api.POST("/v1/simple/roadmap/milestones", { body: { roadmap_id: roadmapOf(d.goal_id)!, name: d.name.trim() || "New milestone", date: d.date, goal_id: d.goal_id, item_ids: d.item_ids, counts_when: d.counts_when } }));
      const late = lateOf(d.item_ids, d.date);
      setDraft(again ? { ...fresh(addDays(d.date, 28), d.goal_id, true), code: `M${(Number(made.code.slice(1)) || 0) + 1}` } : null);
      await done({
        words: late ? `${words(made)} added · ${late} ${late === 1 ? "item it waits on ends" : "items it waits on end"} after it` : `${words(made)} added to ${goalTitle(made.goal_id ?? null)}`,
        undo: () => unwrap(api.DELETE("/v1/simple/roadmap/milestones/{milestone_id}", { params: { path: { milestone_id: made.id } } })),
      });
    },
    remove: async () => {
      if (!draft?.id) return;
      const m = list.find((x) => x.id === draft.id)!;
      await unwrap(api.DELETE("/v1/simple/roadmap/milestones/{milestone_id}", { params: { path: { milestone_id: m.id } } }));
      setDraft(null);
      await done({ words: `${words(m)} removed`, undo: () => unwrap(api.POST("/v1/simple/roadmap/milestones/{milestone_id}/restore", { params: { path: { milestone_id: m.id } } })) });
    },
    move: async (m, date) => {
      if (!m.date || date === m.date) return;
      await patch(m.id, { date });
      if (m.prd) await done({ words: `Asked ${m.prd_owner ?? "the PRD's owner"} to move ${words(m)} to ${day(date)} in the PRD`, undo: () => patch(m.id, { date: m.date }) });
      else await done({ words: `${words(m)} moved to ${day(date)}`, undo: () => patch(m.id, { date: m.date }) });
    },
    undo: async () => {
      const u = toast?.undo;
      setToast(null);
      if (u) {
        await u();
        await reload();
      }
    },
    closeToast: () => setToast(null),
  };
}

/** One milestone's mark: a diamond on the time axis. */
function Diamond({ x, y, code, size = 12, hollow = false, dashed = false, title, testid = "ms-diamond", color, onPointerDown, onClick }: { x: number; y: number; code: string; size?: number; hollow?: boolean; dashed?: boolean; title: string; testid?: string; color?: string; onPointerDown?: (e: ReactPointerEvent) => void; onClick?: () => void }) {
  const edge = color ?? msEdge(code);
  const hit = onClick || onPointerDown;
  return (
    <span
      data-testid={testid}
      title={title}
      aria-label={hit ? title : undefined}
      role={hit ? "button" : undefined}
      className={`absolute z-[25] ${hit ? "cursor-grab touch-none" : ""}`}
      style={{ left: x - size / 2 - (hit ? 4 : 0), top: y - size / 2 - (hit ? 4 : 0), width: size + (hit ? 8 : 0), height: size + (hit ? 8 : 0), padding: hit ? 4 : 0 }}
      onPointerDown={onPointerDown}
      onClick={onClick}
    >
      <i aria-hidden className="block h-full w-full rotate-45 rounded-[2px]" style={{ background: hollow ? "var(--surface)" : edge, border: `1.5px ${dashed ? "dashed" : "solid"} ${edge}` }} />
    </span>
  );
}

/** A label's width at text-xs semibold, near enough to keep labels apart. */
const textW = (t: string) => Math.ceil(t.length * 7.6) + 24;

function Chip({ children, style, className = "", mx, testid, onClick }: { children: ReactNode; style?: CSSProperties; className?: string; mx?: number; testid?: string; onClick?: () => void }) {
  return (
    <span
      data-testid={testid}
      data-ms-label={mx != null ? "" : undefined}
      data-mx={mx}
      data-t0={mx != null ? style?.top : undefined}
      onClick={onClick}
      className={`absolute z-[14] overflow-hidden text-ellipsis rounded-full px-2 text-xs leading-5 font-semibold whitespace-nowrap ${onClick ? "cursor-pointer" : ""} ${className}`}
      style={style}
    >
      {children}
    </span>
  );
}

export interface MsLayerProps {
  view: "timeline" | "gantt";
  x: (d: string) => number;
  /** Where the rows start (the axis' foot) and the axis' mark line. */
  top: number;
  axisY: number;
  height: number;
  width: number;
  rows: MsRow[];
  lanes: MsLane[];
  phone: boolean;
  /** Left inset of the track (the Timeline's names column). */
  left?: number;
}

/** The day under a point of the track: x is monotonic, so a halving search over days finds it. */
function dayAt(x: (d: string) => number, px: number, from: string): string {
  let lo = -1500;
  let hi = 1500;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (x(addDays(from, mid)) < px) lo = mid + 1;
    else hi = mid;
  }
  const a = addDays(from, lo - 1);
  const b = addDays(from, lo);
  return Math.abs(x(a) - px) < Math.abs(x(b) - px) ? a : b;
}

/** The milestone layer drawn over the Timeline or the Gantt. */
export function MsLayer(props: MsLayerProps) {
  const ms = useMsCtl();
  const ref = useRef<HTMLDivElement>(null);
  // A label keeps all its words inside the chart's visible part: it sits right of its diamond when it
  // fits there, else left of it; with no room for one line on either side it wraps to two lines on the
  // roomier side. The names column (the Timeline's sticky one) counts as an edge, and a label whose
  // diamond has scrolled out of sight goes with it.
  useLayoutEffect(() => {
    const layer = ref.current;
    let sc = layer?.parentElement ?? null;
    while (sc && !(sc.scrollWidth > sc.clientWidth + 2 && /auto|scroll/.test(getComputedStyle(sc).overflowX))) sc = sc.parentElement;
    if (!layer || !sc) return;
    const box = sc;
    const inset = props.view === "timeline" ? (props.left ?? 0) : 0;
    const fit = () => {
      const b = box.getBoundingClientRect();
      const right = b.right - 6;
      const leftEdge = b.left + inset + 6;
      const lx = layer.getBoundingClientRect().left;
      const placed: DOMRect[] = [];
      // Top rows first, so a label that steps down only ever lands below the one it met.
      const labels = [...layer.querySelectorAll<HTMLElement>("[data-ms-label]")].sort((a, b) => (Number(a.dataset.t0) || 0) - (Number(b.dataset.t0) || 0));
      for (const el of labels) {
        const mx = Number(el.dataset.mx);
        el.style.whiteSpace = "nowrap";
        el.style.width = "";
        el.style.maxWidth = "";
        const w = el.scrollWidth + 2;
        const t0 = Number(el.dataset.t0) || 0;
        const gone = lx + mx < leftEdge - 6 || lx + mx > right + 6;
        el.style.visibility = gone ? "hidden" : "";
        if (gone) continue;
        const startR = Math.max(lx + mx + 6, leftEdge);
        const roomR = right - startR;
        const roomL = lx + mx - 6 - leftEdge;
        const wrap = roomR < w && roomL < w;
        el.style.whiteSpace = wrap ? "normal" : "nowrap";
        el.style.lineHeight = wrap ? "14px" : "";
        el.style.paddingBlock = wrap ? "2px" : "";
        el.style.borderRadius = wrap ? "8px" : "";
        const cw = wrap ? Math.min(Math.max(roomR, roomL), Math.ceil(w * 0.6) + 12) : w;
        el.style.maxWidth = `${cw}px`;
        el.style.width = wrap ? `${cw}px` : "";
        el.style.left = `${roomR >= w || (wrap && roomR >= roomL) ? startR - lx : mx - 6 - cw}px`;
        el.style.top = `${t0}px`;
        for (let n = 0; wrap && n < 4; n++) {
          const r = el.getBoundingClientRect();
          const hit = placed.find((o) => r.left < o.right + 2 && o.left < r.right + 2 && r.top < o.bottom + 1 && o.top < r.bottom + 1);
          if (!hit) break;
          el.style.top = `${parseFloat(el.style.top) + (hit.bottom - r.top) + 3}px`;
        }
        placed.push(el.getBoundingClientRect());
      }
    };
    fit();
    box.addEventListener("scroll", fit);
    return () => box.removeEventListener("scroll", fit);
  });
  if (!ms) return null;
  const { x, axisY, height, rows, lanes, phone, left = 0 } = props;
  const X = (d: string) => left + x(d);
  const laneOf = (g: string | null | undefined) => lanes.find((l) => l.key === (g ?? "none"));
  const rowOf = (id: string) => rows.find((r) => r.id === id);
  const out: ReactNode[] = [];
  const own = ms.list.filter((m) => !m.prd && m.date);
  const prd = ms.list.filter((m) => m.prd && m.date);
  const shown = own.map((m) => (ms.moving?.id === m.id ? { ...m, date: ms.moving.date } : m));
  // Two on one day share one diamond, with their count on the axis.
  const byDay = new Map<string, number>();
  for (const m of shown) byDay.set(m.date!, (byDay.get(m.date!) ?? 0) + 1);
  const seenDay = new Map<string, number>();

  // Labels in a goal's header row: each keeps its name; one that has no room moves to the row below,
  // and one near the right edge sits to the left of its diamond.
  const tiers = new Map<string, number[]>();
  const labelAt = (band: string, mx: number, y0: number, text: string, cap = phone ? 160 : 320) => {
    const w = Math.min(textW(text), cap);
    let l = mx + 6;
    if (l + w > props.width - 6) l = mx - 6 - w;
    const ends = tiers.get(band) ?? [];
    let t = ends.findIndex((e) => l >= e + 4);
    if (t < 0) t = ends.length < 3 ? ends.length : ends.indexOf(Math.min(...ends));
    ends[t] = l + w;
    tiers.set(band, ends);
    return { left: l, top: y0 + 6 + t * 24, maxWidth: w };
  };
  const order = [...shown.map((m) => ({ m, fromPrd: false })), ...prd.map((m) => ({ m, fromPrd: true }))].sort((a, b) => a.m.date!.localeCompare(b.m.date!));
  const at = new Map<string, { left: number; top: number; maxWidth: number }>();
  for (const { m, fromPrd } of order) {
    const lane = laneOf(m.goal_id);
    if (lane) at.set(m.id, labelAt(lane.key, X(m.date!), lane.y0, fromPrd ? `PRD · ${words(m)}` : `${words(m)} · ${day(m.date!)}`));
  }
  // A drag on a diamond moves it; a click (no move) opens it.
  const grab = (m: GoalMilestone) => (e: ReactPointerEvent) => {
    if (!ms.canAdd || !m.can_change) return;
    e.preventDefault();
    e.stopPropagation();
    const layer = e.currentTarget.closest<HTMLElement>("[data-testid=ms-layer]")!;
    const drag = { x0: e.clientX, moved: false };
    const from = m.pending?.date ?? m.date!;
    const onMove = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - drag.x0) > 3) drag.moved = true;
      if (!drag.moved) return;
      const px = ev.clientX - layer.getBoundingClientRect().left - left;
      ms.setMoving({ id: m.id, date: dayAt(x, px, from) });
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (!drag.moved) {
        ms.setMoving(null);
        ms.edit(m);
        return;
      }
      const px = ev.clientX - layer.getBoundingClientRect().left - left;
      const to = dayAt(x, px, from);
      void ms.move(m, to).finally(() => ms.setMoving(null));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  for (const m of shown) {
    const date = m.date!;
    const mx = X(date);
    const lane = laneOf(m.goal_id);
    const n = seenDay.get(date) ?? 0;
    seenDay.set(date, n + 1);
    const many = byDay.get(date) ?? 1;
    if (n === 0) {
      out.push(<Diamond key={`d-${m.id}`} x={mx} y={axisY} code={m.code} title={`${words(m)}, ${fullDay(date)}`} onPointerDown={grab(m)} />);
      if (many > 1)
        out.push(
          <Chip key={`c-${m.id}`} testid="ms-same-day" className="z-[26] bg-text text-surface" style={{ left: mx + 8, top: axisY - 10 }}>
            {many} on {day(date)}
          </Chip>,
        );
    }
    if (!lane) continue;
    // A line across the goal's own rows, its words in the goal's header row.
    out.push(<div key={`v-${m.id}`} aria-hidden className="pointer-events-none absolute z-[12]" style={{ left: mx - 0.75, top: lane.y0, height: lane.y1 - lane.y0, borderLeft: `1.5px solid ${msEdge(m.code)}` }} />);
    out.push(<div key={`s-${m.id}`} aria-hidden className="pointer-events-none absolute z-[12]" style={{ left: mx - 0.75, top: axisY + 6, height: lane.y0 - axisY - 6, borderLeft: `1px dotted ${msEdge(m.code)}`, opacity: 0.6 }} />);
    out.push(
      <Chip key={`f-${m.id}`} testid="ms-label" mx={mx} onClick={() => ms.edit(m)} style={{ ...at.get(m.id), background: msFill(m.code), color: msInk(m.code), border: `1px solid ${msEdge(m.code)}` }}>
        {words(m)} · {day(date)}
      </Chip>,
    );
    // Each item it waits on tied to it by a dotted line; one that ends after it is late (red).
    for (const id of m.item_ids) {
      const r = rowOf(id);
      if (!r) continue;
      const ex = X(r.end);
      const cy = r.y + r.h / 2;
      const late = r.end > date;
      if (!late && ex < mx) out.push(<div key={`g-${m.id}-${id}`} aria-hidden className="pointer-events-none absolute z-[12]" style={{ left: ex + 2, top: cy - 1, width: mx - ex - 2, borderTop: `2px dotted ${msEdge(m.code)}` }} />);
      out.push(<i key={`gd-${m.id}-${id}`} aria-hidden className="pointer-events-none absolute z-[13] h-2 w-2 rounded-full" style={{ left: (late ? mx : ex) - 4, top: cy - 4, background: late ? "var(--crit)" : msEdge(m.code) }} />);
      if (late) {
        const t = `Ends after ${words(m)}`;
        const w = Math.min(textW(t), phone ? 220 : 360);
        out.push(
          <Chip key={`late-${m.id}-${id}`} testid="ms-late" className="border border-crit bg-crit-bg text-crit" style={{ left: Math.max(left + 4, mx - 10 - w), top: cy - 10, maxWidth: w }}>
            {t}
          </Chip>,
        );
      }
    }
  }

  // A PRD's own milestones: hollow, dashed, tagged "PRD"; a change asks its owner (dashed amber till then).
  for (const m of prd) {
    const date = m.date!;
    const mx = X(date);
    const lane = laneOf(m.goal_id);
    const live = ms.moving?.id === m.id ? ms.moving.date : null;
    const asked = live ?? m.pending?.date ?? null;
    const to = asked && asked !== date ? X(asked) : null;
    out.push(<Diamond key={`p-${m.id}`} x={mx} y={axisY} code={m.code} hollow title={`${words(m)} (from the PRD ${m.prd!.title})`} testid="ms-prd-diamond" onPointerDown={grab(m)} />);
    if (!lane) continue;
    out.push(<div key={`pv-${m.id}`} aria-hidden className="pointer-events-none absolute z-[12]" style={{ left: mx - 0.75, top: lane.y0, height: lane.y1 - lane.y0, borderLeft: `1.5px dashed ${msEdge(m.code)}`, opacity: to != null ? 0.4 : 1 }} />);
    out.push(
      <Chip key={`pc-${m.id}`} testid="ms-prd-label" mx={mx} onClick={() => ms.edit(m)} className="border" style={{ background: "var(--surface)", ...at.get(m.id), borderStyle: "dashed", color: msInk(m.code), borderColor: msEdge(m.code), opacity: to != null ? 0.5 : 1 }}>
        <span className="font-normal text-text2">PRD · </span>
        {words(m)}
      </Chip>,
    );
    if (to != null) {
      out.push(<Diamond key={`pp-${m.id}`} x={to} y={axisY} code={m.code} hollow dashed color="var(--warn)" title={`Asked: ${fullDay(asked!)}`} testid="ms-proposed" />);
      out.push(<div key={`ppv-${m.id}`} aria-hidden className="pointer-events-none absolute z-[12]" style={{ left: to - 0.75, top: lane.y0, height: lane.y1 - lane.y0, borderLeft: "1.5px dashed var(--warn)" }} />);
      out.push(
        <Chip key={`ppc-${m.id}`} testid="ms-asked" className="border border-warn bg-warn-bg text-warn" style={{ left: to + 6, top: lane.y0 + 54 }}>
          {live ? `Moving ${words(m)} to ${day(asked!)}` : `Asked the PRD: move ${words(m)} to ${day(asked!)} · waits for ${m.prd_owner ?? "its owner"}`}
        </Chip>,
      );
    }
  }

  // Moving one of the roadmap's own: a tip says what changes as it goes.
  const mv = ms.moving && own.find((m) => m.id === ms.moving!.id);
  if (mv && ms.moving!.date !== mv.date) {
    const late = mv.item_ids.filter((id) => (rowOf(id)?.end ?? "") > ms.moving!.date).length;
    out.push(
      <span key="mv" data-testid="ms-move-tip" className="absolute z-[16] rounded bg-tip px-2 py-0.5 text-xs whitespace-nowrap text-tip-text" style={{ left: X(ms.moving!.date) + 16, top: axisY + 8 }}>
        {words(mv)} {day(mv.date!)} → {day(ms.moving!.date)}
        {late ? ` · ${late} ${late === 1 ? "item still ends" : "items still end"} after it` : " · nothing it waits on ends after it"}
      </span>,
    );
  }

  // Adding: the time axis takes a click; pointing at it shows where the milestone lands.
  const d = ms.draft;
  if (ms.canAdd) {
    if (!ms.hover && !d && !phone)
      out.push(
        <Chip key="hint" testid="ms-add-hint" className="z-[26] border border-dashed border-line-strong bg-surface text-text2" style={{ left: X(addDays(ms.today, 97)), top: axisY - 10 }}>
          + Milestone
        </Chip>,
      );
    out.push(
      <div
        key="axis"
        data-testid="ms-axis"
        aria-label="Add a milestone on the time axis"
        className="absolute z-[24] cursor-crosshair"
        style={{ left, top: axisY - 14, width: props.width - left, height: 26 }}
        onPointerMove={(e) => {
          if (e.pointerType === "touch") return;
          const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
          ms.setHover(dayAt(x, px, ms.today));
        }}
        onPointerLeave={() => ms.setHover(null)}
        onClick={(e) => {
          const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
          ms.setHover(null);
          ms.begin(dayAt(x, px, ms.today), null);
        }}
      />,
    );
    if (ms.hover && !(d && !d.id)) {
      const hx = X(ms.hover);
      out.push(<Diamond key="ghost" x={hx} y={axisY} code="M1" hollow dashed color="var(--accent-ink)" title="New milestone here" testid="ms-ghost" />);
      out.push(<div key="ghost-l" aria-hidden className="pointer-events-none absolute z-[12]" style={{ left: hx - 0.5, top: axisY + 6, height: height - axisY - 6, borderLeft: "1px dashed var(--accent-ink)" }} />);
      out.push(
        <Chip key="ghost-c" testid="ms-ghost-words" className="pointer-events-none z-[26] bg-accent-ink text-on-accent" style={{ left: hx + 10, top: axisY - 10 }}>
          + Milestone on {fullDay(ms.hover)}
        </Chip>,
      );
    }
  }
  // The day chosen (a dashed diamond and line in its goal); the bars it waits on are outlined.
  if (d && !d.prd) {
    const nx = X(d.date);
    const lane = laneOf(d.goal_id);
    if (!d.id) out.push(<Diamond key="new" x={nx} y={axisY} code={d.code} hollow dashed title="New milestone" testid="ms-new" />);
    if (lane && !d.id) out.push(<div key="new-l" aria-hidden className="pointer-events-none absolute z-[12]" style={{ left: nx - 0.5, top: lane.y0, height: lane.y1 - lane.y0, borderLeft: "1.5px dashed var(--accent-ink)" }} />);
    for (const id of d.item_ids) {
      const r = rowOf(id);
      if (r) out.push(<div key={`pk-${id}`} data-testid="ms-picked" aria-hidden className="pointer-events-none absolute z-[11]" style={{ left: X(r.start) - 3, top: r.y + 3, width: Math.max(30, X(r.end) - X(r.start) + 6), height: r.h - 6, outline: "2px solid var(--accent)", borderRadius: 8 }} />);
    }
  }

  return (
    <div
      ref={ref}
      data-testid="ms-layer"
      className="pointer-events-none absolute inset-0 [&>*]:pointer-events-auto"
      onPointerMoveCapture={(e) => {
        const y = e.clientY - (ref.current?.getBoundingClientRect().top ?? 0);
        const lane = lanes.find((l) => y >= l.y0 && y < l.y1);
        if (lane) ms.overLane(lane.key === "none" ? null : lane.key);
      }}
    >
      {out}
    </div>
  );
}

function Field({ label, children, testid }: { label: string; children: ReactNode; testid?: string }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-semibold text-text2" data-testid={testid}>
      {label}
      <span className="relative flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-2.5 text-sm font-normal text-text">{children}</span>
    </label>
  );
}

const bare = "min-w-0 flex-1 appearance-none bg-transparent text-sm text-text outline-none";

/** The date field: the day in words, a date picker under it. */
function DateField({ value, onChange }: { value: string; onChange: (d: string) => void }) {
  return (
    <Field label="Date" testid="ms-date">
      <span>{fullDay(value)}</span>
      <input aria-label="Date" type="date" value={value} onChange={(e) => e.target.value && onChange(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" />
    </Field>
  );
}

function RuleField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const rules = value && !RULES.includes(value) ? [value, ...RULES] : RULES;
  return (
    <Field label="It counts when">
      <select aria-label="It counts when" value={value} onChange={(e) => onChange(e.target.value)} className={bare}>
        {rules.map((r) => (
          <option key={r}>{r}</option>
        ))}
      </select>
    </Field>
  );
}

const Btn = ({ children, onClick, primary = false, className = "", testid }: { children: ReactNode; onClick: () => void; primary?: boolean; className?: string; testid?: string }) => (
  <button type="button" data-testid={testid} onClick={onClick} className={`rounded-lg px-3 text-sm leading-8 font-semibold ${primary ? "bg-accent text-on-accent" : "border border-line-strong"} ${className}`}>
    {children}
  </button>
);

/** The milestone's card: in the chart's top corner (a sheet on a phone). */
export function MsCard() {
  const ms = useMsCtl();
  const [busy, setBusy] = useState(false);
  if (!ms?.draft) return null;
  const d = ms.draft;
  const set = (p: Partial<typeof d>) => ms.setDraft({ ...d, ...p });
  const run = (f: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    void f().finally(() => setBusy(false));
  };
  const phone = ms.phone;
  const cls = phone ? "fixed right-0 bottom-0 left-0 z-[60] max-h-[70vh] overflow-y-auto rounded-t-2xl border-t border-line" : "fixed top-4 right-6 z-[60] w-[360px] rounded-xl border border-line";
  const goalTitle = ms.goals.find((g) => g.id === d.goal_id)?.title ?? "No goal";
  if (d.prd) {
    const m = ms.list.find((x) => x.id === d.id)!;
    return (
      <div data-testid="ms-prd-card" role="dialog" aria-label={words(m)} className={`${cls} flex flex-col gap-2.5 bg-surface p-4 shadow-xl`}>
        {phone && <i aria-hidden className="mx-auto mb-1 block h-1 w-10 rounded-full bg-line-strong" />}
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">
            <span style={{ color: msInk(m.code) }}>{m.code}</span> {m.name}
          </h2>
          <span className="rounded-full bg-na-bg px-2 text-xs leading-5 text-na">From the PRD</span>
        </div>
        <p className="text-sm text-text2">
          From the PRD{" "}
          <a href={`/simple/one-pagers/${m.prd!.slug}`} className="font-semibold text-accent-ink underline">
            {m.prd!.title}
          </a>
          {m.prd_owner && <> · owned by {m.prd_owner}</>}
        </p>
        <DateField value={d.date} onChange={(date) => set({ date })} />
        <RuleField value={d.counts_when} onChange={(counts_when) => set({ counts_when })} />
        <p className="text-xs text-text2">A change here goes to {m.prd_owner ?? "the PRD's owner"} as a change to the PRD. It shows dashed until they say yes.</p>
        <div className="flex gap-2">
          <Btn primary onClick={() => run(ms.save.bind(null, false))}>
            Ask to change it
          </Btn>
          <button type="button" className="px-1 text-sm leading-8 text-text2" onClick={() => ms.setDraft(null)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }
  const head = d.id ? `Edit ${d.code}` : d.second ? "Next milestone" : "New milestone";
  const late = (id: string) => (ms.items.get(id)?.end.date ?? "") > d.date;
  return (
    <div data-testid="ms-card" role="dialog" aria-label={head} className={`${cls} flex flex-col gap-2.5 bg-surface p-4 shadow-xl`}>
      {phone && <i aria-hidden className="mx-auto mb-1 block h-1 w-10 rounded-full bg-line-strong" />}
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">{head}</h2>
        <span className="text-xs text-text2">{`${goalTitle} · ${day(d.date)}`}</span>
      </div>
      <Field label="Name">
        <span className="font-semibold" style={{ color: msInk(d.code) }}>
          {d.code}
        </span>
        <input aria-label="Name" autoFocus={!phone} value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="What is true by then" className={bare} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <DateField value={d.date} onChange={(date) => set({ date })} />
        <Field label="Goal">
          <select aria-label="Goal" value={d.goal_id ?? ""} onChange={(e) => set({ goal_id: e.target.value || null })} className={bare}>
            {ms.goals.map((g) => (
              <option key={g.id} value={g.id}>
                {g.title}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="flex flex-col gap-1" data-testid="ms-waits-on">
        <span className="text-xs font-semibold text-text2">
          Items it waits on <span className="font-normal">· tap bars on the chart to add</span>
        </span>
        <div className="flex flex-wrap gap-1.5">
          {d.item_ids.map((id) => {
            const it = ms.items.get(id);
            return (
              <span key={id} data-testid="ms-waits-chip" className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-surface2 px-2 text-xs leading-6">
                {it?.title ?? "An item"}
                {it && late(id) && <span className="font-semibold text-crit">· ends {day(it.end.date)}, after it</span>}
                <button type="button" aria-label={`Take ${it?.title ?? "it"} off`} className="text-text2" onClick={() => set({ item_ids: d.item_ids.filter((x) => x !== id) })}>
                  ×
                </button>
              </span>
            );
          })}
          {d.item_ids.length === 0 && <span className="text-xs text-text2">None yet</span>}
        </div>
      </div>
      <RuleField value={d.counts_when} onChange={(counts_when) => set({ counts_when })} />
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Btn primary testid="ms-save" onClick={() => run(() => ms.save(false))}>
          {d.id ? "Save" : "Add"}
        </Btn>
        {!d.id && (
          <Btn testid="ms-add-another" onClick={() => run(() => ms.save(true))}>
            Add and place another
          </Btn>
        )}
        {d.id && (
          <Btn className="text-crit" testid="ms-remove" onClick={() => run(ms.remove)}>
            Remove
          </Btn>
        )}
        <button type="button" className="px-1 text-sm text-text2" onClick={() => ms.setDraft(null)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** What was just done, with Undo. */
export function MsToast() {
  const ms = useMsCtl();
  if (!ms?.toast) return null;
  return (
    <div data-testid="ms-toast" role="status" className={`fixed z-[70] flex items-center gap-3 rounded-lg bg-tip px-4 py-3 text-sm text-tip-text shadow-xl ${ms.phone ? "top-3 right-3 left-3" : "top-4 right-6"}`}>
      <span>{ms.toast.words}</span>
      {ms.toast.undo && (
        <button type="button" className="font-semibold underline" onClick={() => void ms.undo()}>
          Undo
        </button>
      )}
    </div>
  );
}

/** The key for a PRD's milestones, in a row of its own above the chart so it never covers the time
 * axis; one with no date anywhere is counted here, not drawn. */
export function MsKey() {
  const ms = useMsCtl();
  if (!ms || ms.phone) return null;
  const prds = [...new Map(ms.list.filter((m) => m.prd).map((m) => [m.prd!.id, m.prd!])).values()];
  if (!prds.length) return null;
  const undated = ms.list.filter((m) => m.prd && !m.date).length;
  return (
    <div data-testid="ms3-key-row" className="flex flex-wrap items-center gap-2">
      <span data-testid="ms3-key" className="flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-xs leading-6 whitespace-nowrap text-text2">
        <i aria-hidden className="inline-block h-2.5 w-2.5 rotate-45 border-[1.5px] border-dashed" style={{ borderColor: msEdge("M1") }} /> Hollow, dashed: from the PRD {prds.map((p) => p.title).join(", ")} · a change asks its owner
        {undated > 0 && ` · ${undated} with no date yet`}
      </span>
    </div>
  );
}

/** Now / Next / Later: the milestones in each horizon, as a row above its cards. */
export function MsBoardRow({ horizon, windows }: { horizon: string; windows: Roadmap["windows"] }) {
  const ms = useMsCtl();
  if (!ms) return null;
  const h = (d: string) => (d <= windows.now.end ? "now" : d <= windows.next.end ? "next" : "later");
  const here = ms.list.filter((m) => m.date && h(m.date) === horizon).sort((a, b) => a.date!.localeCompare(b.date!));
  const w = windows[horizon as "now" | "next" | "later"];
  return (
    <div data-testid="ms-board-row" className="flex flex-wrap gap-1.5 px-1 pb-2">
      {here.map((m) => (
        <button
          type="button"
          key={m.id}
          data-testid="ms-board-chip"
          onClick={() => ms.edit(m)}
          className="inline-flex items-center gap-1.5 rounded-full border px-2 text-xs leading-6 font-semibold"
          style={{ background: m.prd ? "var(--surface)" : msFill(m.code), color: msInk(m.code), borderColor: msEdge(m.code), borderStyle: m.prd ? "dashed" : "solid" }}
        >
          <i aria-hidden className="inline-block h-2 w-2 rotate-45" style={{ background: m.prd ? "var(--surface)" : msEdge(m.code), border: m.prd ? `1px dashed ${msEdge(m.code)}` : undefined }} />
          {m.prd ? "PRD · " : ""}
          {words(m)} · {day(m.date!)}
        </button>
      ))}
      {ms.canAdd && (
        <button type="button" data-testid="ms-board-add" onClick={() => ms.begin(w.end < ms.today ? ms.today : w.end, null)} className="inline-flex items-center rounded-full border border-dashed border-line-strong px-2 text-xs leading-6 text-text2">
          + Milestone
        </button>
      )}
    </div>
  );
}
