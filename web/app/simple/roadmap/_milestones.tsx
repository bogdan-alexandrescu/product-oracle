"use client";
/* build-milestones-on-roadmap (the owner's picks: 'Click the time axis', 'Card, line per goal',
 * 'Edit asks the PRD'): a roadmap's milestones per goal on Simple Roadmap's Timeline, Gantt and
 * Now / Next / Later. Pointing at the time axis shows a hollow diamond and "+ Milestone on <day>";
 * a click opens the card in the chart's top corner (a sheet on a phone), bars tapped while it is
 * open become the items it waits on. A milestone is a diamond on the axis and a line across its own
 * goal's rows; a drag on the diamond moves it, a click opens it to edit or remove; every change has
 * Undo. A PRD's own milestones are hollow and dashed: a change to one asks the PRD's owner. */

import { createContext, useContext, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { Button } from "@/components/ds";
import { GoalNumbers } from "@/components/simple/GoalOrder"; // MOCK-HOOK
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { addDays, calendarDay } from "@/lib/dates";

import { decide as decideChange, shortDay, type Item, type Roadmap } from "./_lib";
import { msEdge, msFill, msInk } from "./_timeline";

export type GoalMilestone = Schemas["SimpleGoalMilestone"];

/** MOCK-HOOK RM1 "Milestones across the roadmap": the proposal picked by ?rm1=a|b|c|d (none: as built). */
export const rm1 = (): "a" | "b" | "c" | "d" | null => { // MOCK-HOOK
  const v = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("rm1"); // MOCK-HOOK
  return v === "a" || v === "b" || v === "c" || v === "d" ? v : null; // MOCK-HOOK
}; // MOCK-HOOK
/** MOCK-HOOK RM1 A, C, D: the milestone band's height under the date axis (two rows of labels; 0: no band). */
export const rm1Band = (phone = false): number => (rm1() && rm1() !== "b" ? (phone ? 30 : 54) : 0); // MOCK-HOOK
const RM1_ROW = 24; // MOCK-HOOK
/** MOCK-HOOK RM1 C: codes by date across the whole roadmap (two on one date share a number, a/b). */
export function rm1Renum(list: GoalMilestone[], goalNums: Map<string, number>): Map<string, string> { // MOCK-HOOK
  const renum = new Map<string, string>(); // MOCK-HOOK
  const all = list.filter((m) => m.date).sort((a, b) => a.date!.localeCompare(b.date!) || (goalNums.get(a.goal_id ?? "") ?? 99) - (goalNums.get(b.goal_id ?? "") ?? 99)); // MOCK-HOOK
  let n = 0; // MOCK-HOOK
  all.forEach((m, i) => { // MOCK-HOOK
    const same = all.filter((o) => o.date === m.date); // MOCK-HOOK
    if (i === 0 || all[i - 1].date !== m.date) n += 1; // MOCK-HOOK
    renum.set(m.id, same.length > 1 ? `M${n}${"abcdef"[same.indexOf(m)]}` : `M${n}`); // MOCK-HOOK
  }); // MOCK-HOOK
  return renum; // MOCK-HOOK
} // MOCK-HOOK
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
  /** An item it waits on, opened in the item's own panel (the milestone's card closes). */
  openItem: (itemId: string) => void;
  /** A bar tapped while the card is open: an item it waits on (again: no longer). */
  pick: (itemId: string) => boolean;
  save: (again: boolean) => Promise<void>;
  remove: () => Promise<void>;
  /** milestone-rights: who may not change it proposes the card's change (or removing it) to the roadmap's decider. */
  propose: (remove: boolean) => Promise<void>;
  move: (m: GoalMilestone, date: string) => Promise<void>;
  undo: () => Promise<void>;
  closeToast: () => void;
  /** roadmap-decide: the PRD milestone whose ask is open for its owner's Approve / Decline. */
  asking: string | null;
  setAsking: (id: string | null) => void;
  /** The PRD owner approves or declines a change the roadmap asked of the PRD. */
  decide: (m: GoalMilestone, how: "accept" | "decline") => Promise<void>;
}

const Ctx = createContext<MsCtl | null>(null);
export const MsProvider = ({ value, children }: { value: MsCtl; children: ReactNode }) => <Ctx.Provider value={value}>{children}</Ctx.Provider>;
export const useMsCtl = () => useContext(Ctx);

/** The milestones' state and their changes for one read of the roadmap (`reload` reads it again). */
export function useMilestones({ data, phone, canChange, reload, openItem }: { data: Roadmap | undefined; phone: boolean; canChange: boolean; reload: () => Promise<unknown>; openItem: (itemId: string) => void }): MsCtl | null {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [moving, setMoving] = useState<{ id: string; date: string } | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const lastLane = useRef<string | null>(null);
  if (!data) return null;
  const list = data.goal_milestones ?? [];
  const items = new Map(data.items.map((i) => [i.id, i]));
  const goals = [...new Map(data.items.flatMap((i) => (i.goal ? [[i.goal.id, { id: i.goal.id, title: i.goal.title }] as const] : []))).values()];
  const goalTitle = (id: string | null) => goals.find((g) => g.id === id)?.title ?? "No goal";
  const nextCode = (goal: string | null) => `M${list.filter((m) => m.goal_id === goal && !m.prd).reduce((a, m) => Math.max(a, Number(m.code.slice(1)) || 0), 0) + 1}`;
  const roadmapOf = (goal: string | null) => data.roadmap?.id ?? data.items.find((i) => i.goal?.id === goal)?.roadmap.id ?? data.items[0]?.roadmap.id;
  // A milestone is added only where the reader's change applies (POST answers 403 elsewhere).
  const applies = new Set((data.key_date_roadmaps ?? []).filter((r) => r.applies).map((r) => r.roadmap.id));
  const canAddTo = (goal: string | null) => applies.has(roadmapOf(goal) ?? "");
  const lateOf = (ids: string[], date: string) => ids.filter((id) => (items.get(id)?.end.date ?? "") > date).length;
  const fresh = (date: string, goal: string | null, second = false): Draft => ({ id: null, code: nextCode(goal), name: "", date, goal_id: goal, item_ids: [], counts_when: RULES[0], second, prd: false });
  const done = async (t: Toast) => {
    await reload();
    setToast(t);
  };
  const patch = (id: string, body: Schemas["SimpleGoalMilestonePatch"]) => unwrap(api.PATCH("/v1/simple/roadmap/milestones/{milestone_id}", { params: { path: { milestone_id: id } }, body }));
  return {
    asking,
    setAsking,
    decide: async (m, how) => {
      const id = m.pending?.change_id;
      if (!id) return;
      setAsking(null);
      try {
        await decideChange(id, how);
      } catch {
        setToast({ words: `Oracle could not ${how === "accept" ? "approve" : "decline"} the change to ${words(m)}`, undo: null });
        return;
      }
      await done({ words: how === "accept" ? `Approved: ${words(m)} moves to ${day(m.pending!.date ?? m.date!)} in the PRD` : `Declined: ${words(m)} stays on ${day(m.date!)}`, undo: null });
    },
    list,
    draft,
    hover,
    moving,
    toast,
    phone,
    canAdd: canChange && [null, ...goals.map((g) => g.id)].some(canAddTo),
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
    openItem: (itemId) => {
      setDraft(null);
      openItem(itemId);
    },
    edit: (m) => {
      setToast(null);
      setDraft({ id: m.id, code: m.code, name: m.name, date: m.pending?.date ?? m.date ?? data.today, goal_id: m.goal_id ?? null, item_ids: m.item_ids, counts_when: m.counts_when, second: false, prd: !!m.prd });
    },
    pick: (itemId) => {
      if (!draft || draft.prd) return false;
      const m = draft.id ? list.find((x) => x.id === draft.id) : null;
      if (m && !m.can_change && !m.can_propose) return false;
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
    propose: async (remove) => {
      const m = draft?.id ? list.find((x) => x.id === draft.id) : null;
      if (!draft || !m) return;
      const before = { name: m.name, date: m.date ?? null, goal_id: m.goal_id ?? null, item_ids: m.item_ids, counts_when: m.counts_when };
      const after = remove ? null : { name: draft.name.trim() || m.name, date: draft.date, goal_id: draft.goal_id, item_ids: draft.item_ids, counts_when: draft.counts_when };
      await unwrap(api.POST("/v1/simple/changes", { body: { op: "edit_goal_milestone", target: { milestone_id: m.id }, before: { milestone: before }, after: { milestone: after } } }));
      setDraft(null);
      await done({ words: `${remove ? `Proposed removing ${words(m)}` : `Proposed a change to ${words(m)}`} · it waits in Needs a decision`, undo: null });
    },
    move: async (m, date) => {
      if (!m.date || date === m.date) return;
      try {
        await patch(m.id, { date });
      } catch (e) {
        setToast({ words: e instanceof Error ? e.message : "Oracle could not move it", undo: null });
        return;
      }
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
      style={{ left: x - size / 2 - (hit ? 4 : 0), top: y - size / 2 - (hit ? 4 : 0), width: size + (hit ? 8 : 0), height: size + (hit ? 8 : 0), padding: hit ? 4 : 0, pointerEvents: hit ? undefined : "none" }}
      onPointerDown={onPointerDown}
      onClick={onClick}
    >
      <i aria-hidden className="block h-full w-full rotate-45 rounded-[2px]" style={{ background: hollow ? "var(--surface)" : edge, border: `1.5px ${dashed ? "dashed" : "solid"} ${edge}` }} />
    </span>
  );
}

/** A label's width at text-xs semibold, near enough to keep labels apart. */
const textW = (t: string) => Math.ceil(t.length * 7.6) + 24;

function Chip({ children, style, className = "", mx, testid, title, onClick }: { children: ReactNode; style?: CSSProperties; className?: string; mx?: number; testid?: string; title?: string; onClick?: () => void }) {
  return (
    <span
      data-testid={testid}
      title={title}
      data-ms-label={mx != null ? "" : undefined}
      data-mx={mx}
      data-t0={mx != null ? style?.top : undefined}
      onClick={onClick}
      className={`absolute z-[14] overflow-hidden text-ellipsis rounded-full px-2 text-xs leading-5 font-semibold whitespace-nowrap ${onClick ? "cursor-pointer" : ""} ${className}`}
      style={{ ...style, pointerEvents: onClick ? undefined : "none" }}
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
  /** Spans of the axis (layer pixels) the "+ Milestone" hint keeps off: the Timeline's roadmap milestone names. */
  keepOff?: [number, number][];
  /** The axis' part in sight (layer pixels): the Timeline's track between the names column and the chart's right edge. */
  span?: [number, number];
  /** MOCK-HOOK RM1: the band's top (layer pixels), under the date axis. */
  bandTop?: number; // MOCK-HOOK
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
  const v = rm1(); // MOCK-HOOK
  const goalNums = useContext(GoalNumbers); // MOCK-HOOK
  const [rmTip, setRmTip] = useState<{ id: string; left: number; top: number } | null>(null); // MOCK-HOOK
  // A label keeps all its words inside the chart's visible part: it sits right of its diamond when it
  // fits there, else left of it, else after the label it meets, on one line (cut short when the row runs
  // out). The names column (the Timeline's sticky one) counts as an edge, and a label whose
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
      // roadmap-decide: one line per header row, never stepping down over the item rows' bars and
      // dates: each sits right of its diamond (or left of it near the right edge), and one that would
      // run into the next label is cut short there (its words in its tooltip).
      const labels = [...layer.querySelectorAll<HTMLElement>("[data-ms-label]")].sort((a, b) => (Number(a.dataset.t0) || 0) - (Number(b.dataset.t0) || 0) || Number(a.dataset.mx) - Number(b.dataset.mx));
      const shown = labels.filter((el) => {
        const mx = lx + Number(el.dataset.mx);
        const gone = mx < leftEdge - 6 || mx > right + 6;
        el.style.visibility = gone ? "hidden" : "";
        return !gone;
      });
      let end = -Infinity;
      shown.forEach((el, n) => {
        const t0 = Number(el.dataset.t0) || 0;
        const prev = shown[n - 1];
        if (!prev || (Number(prev.dataset.t0) || 0) !== t0) end = -Infinity;
        const next = shown[n + 1];
        const nextT = next && (Number(next.dataset.t0) || 0) === t0 ? lx + Number(next.dataset.mx) + 6 : Infinity;
        el.style.whiteSpace = "nowrap";
        el.style.width = "";
        el.style.maxWidth = "";
        el.style.top = `${t0}px`;
        const w = el.scrollWidth + 2;
        const mx = lx + Number(el.dataset.mx);
        // A change asked of a PRD keeps all its words; the labels after it make room.
        const lead = el.dataset.testid === "ms-asked";
        let l = Math.max(mx + 6, leftEdge, end + 4);
        let cw = w;
        const room = Math.min(lead ? Infinity : nextT - 4, right) - l;
        if (w > room) {
          const roomL = mx - 6 - Math.max(leftEdge, end + 4);
          if ((lead || nextT === Infinity) && w <= roomL) l = mx - 6 - w;
          // A phone's narrow chart: no room right of its diamond, so cut short on its left (still clickable).
          else if (room < 40 && roomL >= 40) {
            cw = Math.min(w, roomL);
            l = mx - 6 - cw;
          } else cw = Math.max(40, Math.min(w, room));
        }
        if (l + cw > right) {
          // No room left in the row: it waits behind the ones before it (its diamond keeps its name).
          if (!lead && l + 40 > right) {
            el.style.visibility = "hidden";
            return;
          }
          l = Math.max(leftEdge, right - cw);
        }
        el.style.maxWidth = `${cw}px`;
        el.style.width = cw < w ? `${cw}px` : "";
        el.style.left = `${l - lx}px`;
        end = l + cw;
      });
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
  // MOCK-HOOK RM1 C: one numbering by date across the roadmap (two on one date share it, a/b).
  const renum = rm1Renum(ms.list, goalNums); // MOCK-HOOK
  const rmCode = (m: GoalMilestone) => (v === "c" ? (renum.get(m.id) ?? m.code) : m.code); // MOCK-HOOK
  const rmWords = (m: GoalMilestone) => `${rmCode(m)} ${m.name}`; // MOCK-HOOK
  const own = ms.list.filter((m) => !m.prd && m.date);
  const prd = ms.list.filter((m) => m.prd && m.date);
  const shown = own.map((m) => (ms.moving?.id === m.id ? { ...m, date: ms.moving.date } : m));
  // Two on one day share one diamond, with their count on its corner.
  const byDay = new Map<string, number>();
  for (const m of shown) byDay.set(m.date!, (byDay.get(m.date!) ?? 0) + 1);
  const seenDay = new Map<string, number>();

  // Labels in a goal's header row, one line of them (roadmap-decide: never spilling into the item rows
  // below, where they drew over the bars' dates): each starts at its line, or right after the label
  // before it; one near the right edge sits to the left of its line, else is cut short (its full
  // words in its tooltip).
  const ends = new Map<string, number>();
  const labelAt = (band: string, mx: number, y0: number, text: string, cap = phone ? 160 : 320) => {
    let w = Math.min(textW(text), cap);
    const end = ends.get(band) ?? -Infinity;
    let l = Math.max(mx + 6, end + 4);
    if (l + w > props.width - 6) {
      if (mx - 6 - w >= end + 4) l = mx - 6 - w;
      else w = Math.max(48, props.width - 6 - l);
    }
    ends.set(band, l + w);
    return { left: l, top: y0 + 5, maxWidth: w };
  };
  const askWords = (m: GoalMilestone, asked: string, live: boolean) =>
    live ? `Moving ${words(m)} to ${day(asked)}` : `Asked the PRD: move ${words(m)} to ${day(asked)} · waits for ${m.prd_owner ?? "its owner"}`;
  type Label = { key: string; date: string; m: GoalMilestone; text: string };
  const labels: Label[] = [
    ...shown.map((m) => ({ key: m.id, date: m.date!, m, text: `${words(m)} · ${day(m.date!)}` })),
    ...prd.map((m) => ({ key: m.id, date: m.date!, m, text: `PRD · ${words(m)}` })),
  ];
  for (const m of prd) {
    const live = ms.moving?.id === m.id ? ms.moving.date : null;
    const asked = live ?? m.pending?.date ?? null;
    if (asked && asked !== m.date) labels.push({ key: `ask-${m.id}`, date: asked, m, text: askWords(m, asked, !!live) });
  }
  const at = new Map<string, { left: number; top: number; maxWidth: number }>();
  for (const { key, date, m, text } of labels.sort((a, b) => a.date.localeCompare(b.date))) {
    const lane = laneOf(m.goal_id);
    if (lane) at.set(key, labelAt(lane.key, X(date), lane.y0, text));
  }
  // A drag on a diamond moves it; a click (no move) opens it.
  const grab = (m: GoalMilestone) => (e: ReactPointerEvent) => {
    if (!m.can_change) return;
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
      // Their count, a small badge on the diamond's top-right corner: it sits wholly above the
      // diamonds' own boxes, so it never covers the next one at any zoom (its names in its tooltip).
      if (many > 1)
        out.push(
          <span
            key={`c-${m.id}`}
            data-testid="ms-same-day"
            title={`${many} milestones on ${day(date)}: ${shown.filter((o) => o.date === date).map(words).join(", ")}`}
            className="absolute z-[25] h-3 min-w-3 rounded-full bg-text px-1 text-center text-[10px] leading-3 font-bold text-surface"
            style={{ left: mx + 3, top: axisY - 22 }}
          >
            {many}
            <span className="sr-only"> on {day(date)}</span>
          </span>,
        );
      out.push(<Diamond key={`d-${m.id}`} x={mx} y={axisY} code={rmCode(m)} title={`${words(m)}, ${fullDay(date)}`} onPointerDown={grab(m)} />); // MOCK-HOOK
    }
    if (v) { // MOCK-HOOK
      out.push(<div key={`v-${m.id}`} data-testid="ms-line" data-day={date} aria-hidden className="pointer-events-none absolute z-[12]" style={{ left: mx - 0.75, top: axisY + 6, height: height - axisY - 6, borderLeft: `1.5px solid ${msEdge(rmCode(m))}` }} />); // MOCK-HOOK
      if (v === "b" && lane) out.push(<Chip key={`f-${m.id}`} testid="ms-label" mx={mx} title={`${words(m)} · ${day(date)}`} onClick={() => ms.edit(m)} style={{ ...at.get(m.id), background: msFill(m.code), color: msInk(m.code), border: `1px solid ${msEdge(m.code)}` }}>{words(m)} · {day(date)}</Chip>); // MOCK-HOOK
    } // MOCK-HOOK
    if (!lane) continue;
    // A line across the goal's own rows, its words in the goal's header row.
    if (!v) out.push(<div key={`v-${m.id}`} data-testid="ms-line" data-day={date} aria-hidden className="pointer-events-none absolute z-[12]" style={{ left: mx - 0.75, top: lane.y0, height: lane.y1 - lane.y0, borderLeft: `1.5px solid ${msEdge(m.code)}` }} />); // MOCK-HOOK
    if (!v) out.push(<div key={`s-${m.id}`} aria-hidden className="pointer-events-none absolute z-[12]" style={{ left: mx - 0.75, top: axisY + 6, height: lane.y0 - axisY - 6, borderLeft: `1px dotted ${msEdge(m.code)}`, opacity: 0.6 }} />); // MOCK-HOOK
    if (!v) out.push( // MOCK-HOOK: as built
      <Chip key={`f-${m.id}`} testid="ms-label" mx={mx} title={`${words(m)} · ${day(date)}`} onClick={() => ms.edit(m)} style={{ ...at.get(m.id), background: msFill(m.code), color: msInk(m.code), border: `1px solid ${msEdge(m.code)}` }}>
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
        const t = `Ends after ${rmWords(m)}`; // MOCK-HOOK rmWords (C: the new code)
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
    if (v) out.push(<div key={`pv-${m.id}`} aria-hidden className="pointer-events-none absolute z-[12]" style={{ left: mx - 0.75, top: axisY + 6, height: height - axisY - 6, borderLeft: `1.5px ${v === "b" ? "dashed" : "solid"} ${msEdge(rmCode(m))}` }} />); // MOCK-HOOK
    if (v && v !== "b") out.push(<Diamond key={`p-${m.id}`} x={mx} y={axisY} code={rmCode(m)} title={`${words(m)} (from the PRD ${m.prd!.title})`} testid="ms-prd-diamond" onPointerDown={grab(m)} />); // MOCK-HOOK
    else out.push(<Diamond key={`p-${m.id}`} x={mx} y={axisY} code={m.code} hollow title={`${words(m)} (from the PRD ${m.prd!.title})`} testid="ms-prd-diamond" onPointerDown={grab(m)} />); // MOCK-HOOK
    if (!lane) continue;
    if (!v) out.push(<div key={`pv-${m.id}`} aria-hidden className="pointer-events-none absolute z-[12]" style={{ left: mx - 0.75, top: lane.y0, height: lane.y1 - lane.y0, borderLeft: `1.5px dashed ${msEdge(m.code)}`, opacity: to != null ? 0.4 : 1 }} />); // MOCK-HOOK
    if (!v || v === "b") out.push( // MOCK-HOOK: A, C, D draw it in the band
      <Chip key={`pc-${m.id}`} testid="ms-prd-label" mx={mx} title={`PRD · ${words(m)}`} onClick={() => ms.edit(m)} className="border" style={{ background: "var(--surface)", ...at.get(m.id), borderStyle: "dashed", color: msInk(m.code), borderColor: msEdge(m.code), opacity: to != null ? 0.5 : 1 }}>
        <span className="font-normal text-text2">PRD · </span>
        {words(m)}
      </Chip>,
    );
    if (to != null) {
      out.push(<Diamond key={`pp-${m.id}`} x={to} y={axisY} code={m.code} hollow dashed color="var(--warn)" title={`Asked: ${fullDay(asked!)}`} testid="ms-proposed" />);
      out.push(<div key={`ppv-${m.id}`} aria-hidden className="pointer-events-none absolute z-[12]" style={{ left: to - 0.75, top: lane.y0, height: lane.y1 - lane.y0, borderLeft: "1.5px dashed var(--warn)" }} />);
      // roadmap-decide: the PRD's owner gets the ask as an action: the chip opens Approve / Decline in place.
      const mine = !live && !!m.pending?.can_decide;
      out.push(
        <Chip key={`ppc-${m.id}`} testid="ms-asked" mx={to} title={askWords(m, asked!, !!live)} className="border border-warn bg-warn-bg text-warn" onClick={mine ? () => ms.setAsking(ms.asking === m.id ? null : m.id) : undefined} style={{ left: to + 6, top: lane.y0 + 5, ...at.get(`ask-${m.id}`) }}>
          {askWords(m, asked!, !!live)}
        </Chip>,
      );
      if (mine && ms.asking === m.id)
        out.push(
          <span key={`ppd-${m.id}`} role="group" aria-label={`Decide the change to ${words(m)}`} data-testid="ms-asked-decide" className="absolute z-[17] flex gap-1.5 rounded-lg border border-line bg-surface p-1.5 shadow-tip" style={{ left: at.get(`ask-${m.id}`)?.left ?? to + 6, top: lane.y0 + 30 }}>
            <Button variant="solid" className="!h-7 !px-2 !text-xs" onClick={() => void ms.decide(m, "accept")}>
              Approve
            </Button>
            <Button className="!h-7 !px-2 !text-xs" onClick={() => void ms.decide(m, "decline")}>
              Decline
            </Button>
          </span>,
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
    // The hint steps right past any name it would cover.
    let hintL: number | null = X(addDays(ms.today, 97));
    for (const [a, b] of [...(props.keepOff ?? [])].sort((p, q) => p[0] - q[0])) if (hintL < b + 6 && hintL + 92 > a - 6) hintL = b + 8;
    // On the Timeline it stays in sight, right of the names column: the free place nearest its
    // day, past a name or before it; with none, no hint.
    if (props.span) {
      const [lo, hi] = props.span;
      const want = X(addDays(ms.today, 97));
      const spans = props.keepOff ?? [];
      const free = (l: number) => l >= lo + 6 && l + 92 <= hi - 6 && spans.every(([a, b]) => l >= b + 6 || l + 92 <= a - 6);
      const near = [Math.min(Math.max(want, lo + 6), hi - 98), ...spans.flatMap(([a, b]) => [b + 8, a - 100])].filter(free);
      hintL = near.length ? near.reduce((p, q) => (Math.abs(q - want) < Math.abs(p - want) ? q : p)) : null;
    }
    if (hintL != null && !ms.hover && !d && !phone)
      out.push(
        <Chip key="hint" testid="ms-add-hint" className="z-[26] border border-dashed border-line-strong bg-surface text-text2" style={{ left: hintL, top: axisY - 10 }}>
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
        // The chart under it pans on a press: the axis takes its own press (a click or a tap) first.
        onPointerDown={(e) => {
          e.stopPropagation();
          e.preventDefault();
          const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
          ms.setHover(null);
          ms.begin(dayAt(x, px, ms.today), null);
        }}
      />,
    );
    // No "+ Milestone" hint while a milestone is dragged along the axis (ms3-a-mid).
    if (ms.hover && !ms.moving && !(d && !d.id)) {
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

  // MOCK-HOOK RM1 A, C, D: every label in one band under the date axis; close ones stack (two rows), then fold into a count.
  const band = rm1Band(phone); // MOCK-HOOK
  if (band && props.bandTop != null) { // MOCK-HOOK
    const rows = phone ? 1 : 2; // MOCK-HOOK
    const goalOf = (m: GoalMilestone) => lanes.find((l) => l.key === (m.goal_id ?? "none")); // MOCK-HOOK
    const list = ms.list.filter((m) => m.date).sort((a, b) => a.date!.localeCompare(b.date!) || (goalNums.get(a.goal_id ?? "") ?? 99) - (goalNums.get(b.goal_id ?? "") ?? 99)); // MOCK-HOOK
    type Placed = { m: GoalMilestone; left: number; w: number; row: number; more: GoalMilestone[] }; // MOCK-HOOK
    const placed: Placed[] = []; // MOCK-HOOK
    const last: (Placed | null)[] = Array(rows).fill(null); // MOCK-HOOK
    const MIN = v === "d" ? 78 : 62; // MOCK-HOOK
    for (const m of list) { // MOCK-HOOK
      const mx = X(m.date!); // MOCK-HOOK
      const num = v === "d" ? 22 : 0; // MOCK-HOOK
      const w = Math.min(textW(rmWords(m)) + num, phone ? 150 : 230); // MOCK-HOOK
      let l = mx + 6; // MOCK-HOOK
      if (l + MIN > props.width - 4) l = mx - 6 - Math.min(w, MIN + 40); // MOCK-HOOK
      const row = last.findIndex((p) => !p || p.left + MIN + (p.more.length ? 30 : 0) <= l - 4); // MOCK-HOOK
      if (row < 0) { // MOCK-HOOK
        const host = last.reduce((a, b) => (b && (!a || b.left > a.left) ? b : a), null as Placed | null)!; // MOCK-HOOK
        host.more.push(m); // MOCK-HOOK
        continue; // MOCK-HOOK
      } // MOCK-HOOK
      const prev = last[row]; // MOCK-HOOK
      if (prev) prev.w = Math.min(prev.w, l - 4 - prev.left - (prev.more.length ? 30 : 0)); // MOCK-HOOK
      const p = { m, left: l, w, row, more: [] }; // MOCK-HOOK
      placed.push(p); // MOCK-HOOK
      last[row] = p; // MOCK-HOOK
    } // MOCK-HOOK
    for (const p of placed) p.w = Math.min(p.w, props.width - 4 - p.left - (p.more.length ? 30 : 0)); // MOCK-HOOK
    out.push(<div key="rm-band" data-testid="rm1-band" aria-hidden className="pointer-events-none absolute z-[11] border-b border-line bg-surface2/60" style={{ left, top: props.bandTop, width: props.width - left, height: band }} />); // MOCK-HOOK
    const tipFor = (m: GoalMilestone) => { // MOCK-HOOK
      const g = goalOf(m)?.title ?? "No goal"; // MOCK-HOOK
      const n = goalNums.get(m.goal_id ?? ""); // MOCK-HOOK
      return { // MOCK-HOOK
        head: `${rmWords(m)} · ${fullDay(m.date!)}`, // MOCK-HOOK
        goal: `Advances ${n ? `goal ${n}, ` : ""}${g}`, // MOCK-HOOK
        prd: m.prd ? `From the PRD ${m.prd.title}` : null, // MOCK-HOOK
        was: v === "c" && rmCode(m) !== m.code ? `Was ${m.code} in ${g}` : null, // MOCK-HOOK
      }; // MOCK-HOOK
    }; // MOCK-HOOK
    for (const p of placed) { // MOCK-HOOK
      const m = p.m; // MOCK-HOOK
      const top = props.bandTop + (phone ? 5 : 4 + p.row * RM1_ROW); // MOCK-HOOK
      const n = goalNums.get(m.goal_id ?? "") ?? goalNums.get(goalOf(m)?.title ?? ""); // MOCK-HOOK
      const show = () => setRmTip({ id: m.id, left: p.left, top: top + 24 }); // MOCK-HOOK
      out.push( // MOCK-HOOK
        <span key={`rb-${m.id}`} data-testid="rm1-label" data-prd={m.prd ? "" : undefined} role="button" tabIndex={0} aria-label={`${tipFor(m).head}. ${tipFor(m).goal}`} onPointerEnter={show} onFocus={show} onPointerLeave={() => setRmTip(null)} onBlur={() => setRmTip(null)} onClick={() => ms.edit(m)} className="absolute z-[14] flex cursor-pointer items-center gap-1 overflow-hidden rounded-full px-1.5 text-xs leading-5 font-semibold whitespace-nowrap" style={{ left: p.left, top, maxWidth: Math.max(p.w, 40), background: msFill(rmCode(m)), color: msInk(rmCode(m)), border: `1px solid ${msEdge(rmCode(m))}` }}> {/* MOCK-HOOK */}
          {v === "d" && n ? <span aria-label={`Goal ${n}`} className="goal-num tnum" style={{ marginRight: 0, marginLeft: -3, height: 16, minWidth: 16, padding: "0 4px", fontSize: 11, background: "var(--surface)", color: "var(--text)" }}>{n}</span> : null} {/* MOCK-HOOK: the goal headers' number chip */}
          <span className="min-w-0 overflow-hidden text-ellipsis">{rmWords(m)}</span> {/* MOCK-HOOK */}
        </span>, // MOCK-HOOK
      ); // MOCK-HOOK
      if (p.more.length) // MOCK-HOOK
        out.push( // MOCK-HOOK
          <span key={`rbm-${m.id}`} data-testid="rm1-more" title={p.more.map((o) => `${rmWords(o)} · ${day(o.date!)}`).join(", ")} className="absolute z-[14] h-5 rounded-full border border-line-strong bg-surface px-1.5 text-xs leading-[18px] font-semibold text-text" style={{ left: p.left + Math.max(p.w, 40) + 3, top }}> {/* MOCK-HOOK */}
            +{p.more.length} {/* MOCK-HOOK */}
          </span>, // MOCK-HOOK
        ); // MOCK-HOOK
    } // MOCK-HOOK
    const tm = rmTip && list.find((m) => m.id === rmTip.id); // MOCK-HOOK
    if (rmTip && tm) { // MOCK-HOOK
      const t = tipFor(tm); // MOCK-HOOK
      out.push( // MOCK-HOOK
        <span key="rm-tip" data-testid="rm1-tip" role="tooltip" className="pointer-events-none absolute z-40 flex max-w-80 flex-col rounded bg-tip px-2 py-1 text-xs text-tip-text" style={{ left: Math.min(rmTip.left, props.width - 300), top: rmTip.top }}> {/* MOCK-HOOK */}
          <b>{t.head}</b> {/* MOCK-HOOK */}
          {t.prd && <span>{t.prd}</span>} {/* MOCK-HOOK */}
          <span>{t.goal}</span> {/* MOCK-HOOK */}
          {t.was && <span>{t.was}</span>} {/* MOCK-HOOK */}
          <span>Waits on {tm.item_ids.length} {tm.item_ids.length === 1 ? "item" : "items"}</span> {/* MOCK-HOOK */}
        </span>, // MOCK-HOOK
      ); // MOCK-HOOK
    } // MOCK-HOOK
  } // MOCK-HOOK

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

/** milestone-rights: the reasons, as tooltips (the card adds no sentences). */
const WHO_CHANGES = "Only an owner or the roadmap's decider (with none, its owner) changes its milestones";
const PROPOSE_WHY = "Goes to the roadmap's decider, who accepts or declines it in Needs a decision";

const Btn = ({ children, onClick, primary = false, className = "", testid, title }: { children: ReactNode; onClick: () => void; primary?: boolean; className?: string; testid?: string; title?: string }) => (
  <button type="button" data-testid={testid} title={title} onClick={onClick} className={`rounded-lg px-3 text-sm leading-8 font-semibold ${primary ? "bg-accent text-on-accent" : "border border-line-strong"} ${className}`}>
    {children}
  </button>
);

/** The milestone's card: in the chart's top corner (a sheet on a phone). */
export function MsCard() {
  const ms = useMsCtl();
  const [busy, setBusy] = useState(false);
  // milestone-rights: the API's refusal, on the card it came from (the person's input stays).
  const [failed, setFailed] = useState<{ on: string; words: string } | null>(null);
  if (!ms?.draft) return null;
  const d = ms.draft;
  const on = d.id ?? "new";
  const set = (p: Partial<typeof d>) => {
    setFailed(null);
    ms.setDraft({ ...d, ...p });
  };
  const run = (f: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setFailed(null);
    void f()
      .catch((e: unknown) => setFailed({ on, words: e instanceof Error && e.message ? e.message : "Oracle could not save it" }))
      .finally(() => setBusy(false));
  };
  const error = failed?.on === on && (
    <p role="alert" data-testid="ms-error" className="text-sm text-crit">
      {failed.words}
    </p>
  );
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
        {error}
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
  const own = d.id ? ms.list.find((x) => x.id === d.id) : undefined;
  // milestone-rights: who changes it saves; who may only propose proposes; anyone else reads.
  const rights = !own || own.can_change ? "change" : own.can_propose ? "propose" : "read";
  const reads = rights === "read";
  const head = !d.id ? (d.second ? "Next milestone" : "New milestone") : reads ? `${d.code} ${d.name}` : `Edit ${d.code}`;
  const late = (id: string) => (ms.items.get(id)?.end.date ?? "") > d.date;
  return (
    <div data-testid="ms-card" data-rights={rights} role="dialog" aria-label={head} className={`${cls} flex flex-col gap-2.5 bg-surface p-4 shadow-xl`}>
      {phone && <i aria-hidden className="mx-auto mb-1 block h-1 w-10 rounded-full bg-line-strong" />}
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">{head}</h2>
        <span className="text-xs text-text2">{`${goalTitle} · ${day(d.date)}`}</span>
      </div>
      <fieldset disabled={reads} title={reads ? WHO_CHANGES : undefined} className="contents">
        <Field label="Name">
          <span className="font-semibold" style={{ color: msInk(d.code) }}>
            {d.code}
          </span>
          <input aria-label="Name" autoFocus={!phone && !reads} value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="What is true by then" className={bare} />
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
      </fieldset>
      <div className="flex flex-col gap-1" data-testid="ms-waits-on">
        <span className="text-xs font-semibold text-text2">
          Items it waits on {!reads && <span className="font-normal">· tap bars on the chart to add</span>}
        </span>
        <div className="flex flex-wrap gap-1.5">
          {d.item_ids.map((id) => {
            const it = ms.items.get(id);
            return (
              <span key={id} data-testid="ms-waits-chip" className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-surface2 px-2 text-xs leading-6">
                {it ? (
                  <button type="button" data-testid="ms-waits-open" className="underline-offset-2 hover:underline" onClick={() => ms.openItem(id)}>
                    {it.title}
                  </button>
                ) : (
                  "An item"
                )}
                {it && late(id) && <span className="font-semibold text-crit">· ends {day(it.end.date)}, after it</span>}
                {!reads && (
                  <button type="button" aria-label={`Take ${it?.title ?? "it"} off`} className="text-text2" onClick={() => set({ item_ids: d.item_ids.filter((x) => x !== id) })}>
                    ×
                  </button>
                )}
              </span>
            );
          })}
          {d.item_ids.length === 0 && <span className="text-xs text-text2">None yet</span>}
        </div>
      </div>
      <fieldset disabled={reads} title={reads ? WHO_CHANGES : undefined} className="contents">
        <RuleField value={d.counts_when} onChange={(counts_when) => set({ counts_when })} />
      </fieldset>
      {error}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {rights === "change" && (
          <Btn primary testid="ms-save" onClick={() => run(() => ms.save(false))}>
            {d.id ? "Save" : "Add"}
          </Btn>
        )}
        {rights === "propose" && (
          <Btn primary testid="ms-propose" title={PROPOSE_WHY} onClick={() => run(() => ms.propose(false))}>
            Propose
          </Btn>
        )}
        {!d.id && (
          <Btn testid="ms-add-another" onClick={() => run(() => ms.save(true))}>
            Add and place another
          </Btn>
        )}
        {d.id && rights === "change" && (
          <Btn className="text-crit" testid="ms-remove" onClick={() => run(ms.remove)}>
            Remove
          </Btn>
        )}
        {rights === "propose" && (
          <Btn className="text-crit" testid="ms-propose-remove" title={PROPOSE_WHY} onClick={() => run(() => ms.propose(true))}>
            Propose removing it
          </Btn>
        )}
        <button type="button" className="px-1 text-sm text-text2" onClick={() => ms.setDraft(null)}>
          {reads ? "Close" : "Cancel"}
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
