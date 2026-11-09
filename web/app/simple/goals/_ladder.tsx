"use client";

/**
 * Simple Goal map as the Goal ladder (goal-ladder, the owner's picks of Nov 6): the week strip
 * (today and each milestone's week), the goals as columns in priority order with their
 * milestones as key-result cards and the work behind each milestone under it, on a pan-and-zoom
 * canvas ("Free canvas"). No arrows at rest: each card counts what it waits on (←2) and what
 * waits on it (3→); picking a card lights its arrows ("Arrows for the picked card"). Edit ladder
 * shows grips, ⋯ menus, + Add and drop zones ("Edit ladder toggle").
 *
 * How the canvas and Edit mode meet: outside Edit mode dragging a card only moves it on this
 * person's canvas (place_card) and dragging the background pans; in Edit mode, dropping a
 * feature on a milestone's work (or a goal) moves it there, and dropping it on empty canvas
 * only places it. Tidy up never changes data. A phone shows one goal at a time: no canvas.
 *
 * goal-map-editing (the owner's ask of Nov 6): every feature is on the ladder; one serving a
 * goal but no milestone sits under its goal ("Not on a key result"), one serving no goal in a
 * last "No goal" column, and the header's badge leads to them. In Edit mode a feature dropped
 * on a milestone links there, on another goal's column (or its group) serves that goal, on
 * "Not on a key result" lets go of its milestones; a milestone moves within its goal or to
 * another; a goal column moves in the one goal order. The ⋯ menus (and Move to…) do the same by
 * keyboard, and Move to Trash (or the Delete key) sends a feature, milestone or goal to
 * Settings › Trash. Each change has a toast with Undo; a commenter's becomes a suggestion where
 * the change engine takes one, and a move they may not make says why and snaps back.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type PointerEvent as RPointerEvent, type RefObject, type WheelEvent as RWheelEvent } from "react";

import Link from "next/link";
import { Icon } from "@/components/ds/Icon";
import { confirmInPage } from "@/components/ds/ConfirmDialog";
import { InfoTip } from "@/components/ds/InfoTip";
import { toast } from "@/components/ds/Toast";
import { storeGoalOrder } from "@/components/simple/GoalOrder";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import type { GmFeature, GmGoal, GmMilestone, GmStatus, GoalMap } from "@/lib/api/mock/goal-map";
import { formatCount } from "@/lib/format";
import { useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

import { ChangeFailed, propose, statusWord, undo, type Item } from "../roadmap/_lib";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (iso: string | null | undefined) => (iso ? `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}` : "");
const span = (a: string | null | undefined, b: string | null | undefined) => (a && b ? `${day(a)} – ${day(b)}` : b ? `by ${day(b)}` : "No dates yet");
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const KR: Record<GmStatus, string> = { met: "text-pass", on_track: "text-accent-ink", at_risk: "text-warn", missed: "text-crit", not_measured: "text-text2", no_gate: "text-text2" };
const KR_WORD: Record<GmStatus, string> = { met: "Met", on_track: "On track", at_risk: "At risk", missed: "Missed", not_measured: "Too early", no_gate: "No gate yet" };
const WORK: Record<Item["status"], string> = { done: "text-pass", in_progress: "text-accent-ink", planned: "text-warn", draft: "text-crit", cut: "text-text2", merged: "text-text2" };

/** Goal columns on the canvas, in canvas units (the canvas starts at 72%, as the board). */
const COL = 256;
const GAP = 12;
const START_ZOOM = 0.72;

function num(v: number | null, unit: string): string {
  if (v === null) return "—";
  const n = formatCount(Math.round(v * 10) / 10);
  if (unit === "%") return `${n}%`;
  if (unit === "$") return `$${n}`;
  return unit ? `${n} ${v === 1 && unit.endsWith("s") ? unit.slice(0, -1) : unit}` : n;
}

/** A milestone's reading is short (the frames: "2.6 of 2"): only % and $ stay beside the number. */
const mUnit = (unit: string) => (unit === "%" || unit === "$" ? unit : "");

export function usePhone(): boolean {
  return useSyncExternalStore(
    (on) => {
      const m = window.matchMedia("(max-width: 600px)");
      m.addEventListener("change", on);
      return () => m.removeEventListener("change", on);
    },
    () => window.matchMedia("(max-width: 600px)").matches,
    () => false,
  );
}

/** A feature as the ladder draws it: the map's feature with its roadmap item's code, status, dates and links. */
interface LdFeature {
  f: GmFeature;
  item: Item | undefined;
  code: string;
  goal: string | null;
  /** What it waits on and what waits on it (features on the map only). */
  waits: string[];
  wanted: string[];
  /** What this person suggested it wait on, not yet decided. */
  suggested: string[];
  /** goal-map-editing: on no milestone (the map's unplaced), under its goal or in No goal. */
  free: boolean;
}

interface V {
  map: GoalMap;
  goals: GmGoal[];
  ms: GmMilestone[];
  msCode: Map<string, string>;
  feats: LdFeature[];
  byId: Map<string, LdFeature>;
  sel: string | null;
  setSel: (id: string | null) => void;
  edit: boolean;
  /** Owners and approvers change it; a commenter's change is a suggestion; a viewer reads. */
  canChange: boolean;
  /** Whether this milestone is changed directly (its own can_change), not map.can_edit. */
  krCan: (milestone: string) => boolean;
  may: boolean;
  phone: boolean;
  places: Map<string, { x: number; y: number }>;
  live: { id: string; dx: number; dy: number } | null;
  menu: string | null;
  setMenu: (id: string | null) => void;
  /** The picked arrow ("from>to"), whose pop-up shows; it lasts while its card stays picked. */
  arrow: string | null;
  setArrow: (key: string | null) => void;
  adding: string | null;
  setAdding: (ms: string | null) => void;
  drop: string | null;
  refused: [string, string] | null;
  fresh: string | null;
  /** The badge's lead: the groups of features on no milestone, highlighted, and the goal of the first (null: No goal). */
  flash: boolean;
  flashGoal: string | null;
  onOpen: (f: GmFeature) => void;
  act: Acts;
}

interface Acts {
  move: (feature: string, from: string, to: string) => Promise<void>;
  link: (waiter: string, on: string) => Promise<void>;
  unlink: (waiter: string, on: string) => Promise<void>;
  remove: (feature: string) => Promise<void>;
  step: (feature: string, dir: -1 | 1) => Promise<void>;
  add: (milestone: string, title: string) => Promise<void>;
  place: (feature: string, x: number | null, y: number | null) => Promise<void>;
  tidy: () => Promise<void>;
  moveTo: (feature: string) => void;
  waitsOn: (feature: string) => void;
  /** goal-map-editing: a feature dropped on "ms:<id>", "free:<goal|none>", "goal:<id>" or "col:<id>". */
  dropFeature: (feature: string, target: string) => Promise<void>;
  /** A milestone into a goal, before another of its milestones (null: last). */
  moveKr: (milestone: string, goal: string, before: string | null) => Promise<void>;
  stepKr: (milestone: string, dir: -1 | 1) => Promise<void>;
  krTo: (milestone: string) => void;
  /** A goal to its place in the one goal order (0: first). */
  orderGoal: (goal: string, to: number) => Promise<void>;
  trashGoal: (goal: string) => Promise<void>;
  trashKr: (milestone: string) => Promise<void>;
  /** A move the reader may not make: why, and the card snaps back. */
  refuse: (why: string) => void;
}

/** kr-in-goal-map: a key result as its goal's card lists it: its name and its number to aim at. */
export type KrLine = { id: string; code: string | null; name: string; current: number | null; target: number | null; unit: string };

export interface LadderProps {
  map: GoalMap;
  setMap: (m: GoalMap) => void;
  reloadMap: () => Promise<unknown>;
  onOpen: (f: GmFeature) => void;
  /** The goal map's own edits (+ Add milestone, the gate, the goal's target and metric, a PRD). */
  onAddMilestone: (goal: string) => void;
  onGate: (milestone: string) => void;
  /** Attach a roadmap feature already made to a milestone (the map's attach drawer). */
  onAttach: (milestone: string, area: string) => void;
  onGoal: (goal: string) => void;
  onMetric: (goal: string) => void;
  onPrd: ((milestone: string) => void) | null;
  /** The goal a link opened the map on (Home's goal cards). */
  picked: string | null;
  /** kr-in-goal-map: each goal's key results, by goal id (shown in its card, never as goals). */
  keyResults?: Map<string, KrLine[]>;
  /** The page's title block, and the guardrail strip under the header. */
  head: ReactNode;
  guardrail: ReactNode;
  /** The map's flags (gates with no feature, features serving no gate): beside the toggle, as no frame has a row for them. */
  flags?: ReactNode;
}

/**
 * every-field-editable: a key result asked onto another goal by who may not move it (an approver
 * who is not the roadmap's decider): a proposal through the change engine, named by the goal
 * alone, that waits in Needs a decision for the decider to accept or decline.
 */
export async function proposeKrGoal(m: GmMilestone, goal: string, what: string, reload: () => unknown): Promise<void> {
  await unwrap(
    api.POST("/v1/simple/changes", {
      body: { op: "edit_goal_milestone", target: { milestone_id: m.id }, before: { milestone: { goal_id: m.goal } }, after: { milestone: { goal_id: goal } } },
    }),
  );
  await reload();
  toast({ message: `Proposed: ${what}; it waits in Needs a decision` });
}

/** every-field-editable: the owner's or decider's own move of a key result to another goal, with Undo. */
export async function moveKrGoal(m: GmMilestone, goal: string, what: string, reload: () => unknown): Promise<void> {
  const to = (goal_id: string) => unwrap(api.PATCH("/v1/simple/roadmap/milestones/{milestone_id}", { params: { path: { milestone_id: m.id } }, body: { goal_id } }));
  await to(goal);
  await reload();
  toast({ message: what, action: { label: "Undo", onClick: () => void to(m.goal).then(reload) } });
}

export function GoalLadder(props: LadderProps) {
  const { map } = props;
  const { can, me } = useMe();
  const phone = usePhone();
  const roadmap = useQuery("simple-roadmap:goal-map", () => unwrap(api.GET("/v1/simple/roadmap", { params: { query: {} } })));
  const items = useMemo(() => new Map((roadmap.data?.items ?? []).map((i) => [i.id, i])), [roadmap.data]);
  // The person's own pending suggestions: a suggested link shows on the card that would wait.
  const proposals = useQuery("simple-proposals", () => unwrap(api.GET("/v1/simple/changes", { params: { query: { status: "proposed" } } })));
  const canChange = map.can_edit;
  // A milestone changes (Trash, move, drag) for the roadmap's owner or decider, not every approver.
  const krCan = (milestone: string) => !!map.milestones.find((x) => x.id === milestone)?.can_change;
  const may = canChange || can("create_simple_change");
  const [edit, setEdit] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ kind: "move" | "waits" | "kr"; feature: string } | null>(null);
  const [flash, setFlash] = useState(false);
  const [live, setLive] = useState<V["live"]>(null);
  const [drop, setDrop] = useState<string | null>(null);
  const [refused, setRefused] = useState<[string, string] | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [arrowAt, setArrowAt] = useState<{ key: string; sel: string | null } | null>(null);
  // An arrow's pop-up closes when another card is picked.
  const arrow = arrowAt?.sel === sel ? arrowAt.key : null;

  const goals = map.goals;
  const ms = useMemo(() => goals.flatMap((g) => map.milestones.filter((m) => m.goal === g.id)), [goals, map.milestones]);
  // roadmap-milestone-codes: a milestone's one code across the roadmap (its ladder place while the roadmap has none).
  const msCode = useMemo(() => {
    const onRoadmap = new Map((roadmap.data?.goal_milestones ?? []).flatMap((m) => (m.roadmap_code ? [[m.id, m.roadmap_code] as const] : [])));
    return new Map(ms.map((m, i) => [m.id, onRoadmap.get(m.id) ?? `M${i + 1}`]));
  }, [ms, roadmap.data]);
  const feats = useMemo(() => {
    // goal-map-editing: the features on no milestone are cards too, under the goal their item serves.
    const loose: GmFeature[] = map.unplaced.map((u) => ({ id: u.id, name: u.name, area: null, milestones: [], lever: "", expected: "", confidence: "Medium", released: false, measured: null, lift: "not_measured", links: [] }));
    const on = new Set([...map.features, ...loose].map((f) => f.id));
    const goalOf = new Map(map.milestones.map((m) => [m.id, m.goal]));
    const mapGoals = new Set(map.goals.map((g) => g.id));
    const freeGoal = new Map(map.unplaced.map((u) => [u.id, u.goal && mapGoals.has(u.goal) ? u.goal : null]));
    const base: LdFeature[] = [...map.features, ...loose].map((f) => {
      const item = items.get(f.id);
      const free = !f.milestones.length;
      return { f, item, code: item?.code ?? "", goal: free ? (freeGoal.get(f.id) ?? null) : (goalOf.get(f.milestones[0]) ?? null), waits: (item?.depends_on ?? []).filter((d) => on.has(d)), wanted: [] as string[], suggested: [] as string[], free };
    });
    const by = new Map(base.map((x) => [x.f.id, x]));
    for (const x of base) for (const d of x.waits) by.get(d)?.wanted.push(x.f.id);
    // A suggested link names the feature it would wait on by its key or code.
    const ofKey = (k: string) => base.find((y) => y.item?.key === k || (!!y.code && y.code.toLowerCase() === k.toLowerCase()));
    for (const c of proposals.data ?? []) {
      const x = c.op === "set_depends" && c.by === me?.user_id ? by.get(String(c.target.item_id ?? "")) : undefined;
      if (!x) continue;
      const was = new Set((c.before.depends_on as string[] | undefined) ?? []);
      for (const k of (c.after.depends_on as string[] | undefined) ?? []) {
        const y = !was.has(k) ? ofKey(k) : undefined;
        if (y && !x.suggested.includes(y.f.id)) x.suggested.push(y.f.id);
      }
    }
    return base;
  }, [map, items, proposals.data, me?.user_id]);
  const byId = useMemo(() => new Map(feats.map((x) => [x.f.id, x])), [feats]);
  const places = useMemo(() => new Map(map.places.map((p) => [p.feature, { x: p.x, y: p.y }])), [map.places]);

  const reload = useCallback(async () => {
    await Promise.all([props.reloadMap(), roadmap.reload(), proposals.reload()]);
  }, [props, roadmap, proposals]);
  const named = useCallback((id: string) => {
    const x = byId.get(id);
    return x ? `${x.code} ${x.f.name}`.trim() : "";
  }, [byId]);
  const failed = (e: unknown) => toast({ message: e instanceof ChangeFailed || e instanceof Error ? e.message : "Oracle could not make this change" });

  /** One change through the engine: applied (with Undo) or, for a commenter, a suggestion. */
  const change = async (body: Schemas["SimpleChangeIn"], done: string, suggested: string, onUndo?: () => Promise<void>) => {
    const r = await propose(body);
    const c = r.change;
    await reload();
    toast({
      message: c.status === "applied" ? done : `Suggested: ${suggested}.${map.approver ? ` Sent to ${map.approver}.` : ""}`,
      action:
        c.status === "applied" && c.can_undo
          ? { label: "Undo", onClick: () => void (onUndo ? onUndo() : undo(c.id).then(() => undefined)).then(reload, failed) }
          : c.status === "proposed" && c.op !== "add_item"
            ? // Undo takes the suggestion back (the proposer withdraws it).
              { label: "Undo", onClick: () => void unwrap(api.POST("/v1/simple/changes/{change_id}/withdraw", { params: { path: { change_id: c.id } } })).then(reload, failed) }
            : undefined,
    });
  };
  const dependsKey = (x: LdFeature | undefined) => x?.item?.key ?? x?.code ?? "";
  const goalName = (id: string | null) => {
    const i = goals.findIndex((g) => g.id === id);
    return i < 0 ? "No goal" : `Goal ${i + 1} ${goals[i].name}`;
  };
  const krName = (id: string) => `${msCode.get(id) ?? ""} ${map.milestones.find((m) => m.id === id)?.name ?? ""}`.trim();
  const refuse = (why: string) => toast({ message: why });
  /** goal-map-editing: a link onto a milestone, filed under its first area (as + Add feature). */
  const attachLink = (feature: string, milestone: string, area?: string | null, expected = "", confidence: "high" | "medium" | "low" = "medium") => {
    const m = map.milestones.find((x) => x.id === milestone);
    return unwrap(api.POST("/v1/simple/goal-map/links", { body: { feature, milestone, area: area ?? m?.areas[0] ?? map.areas[0]?.id ?? "", expected, confidence } }));
  };
  const detachLink = (feature: string, milestone: string) => unwrap(api.POST("/v1/simple/goal-map/links/detach", { body: { feature, milestone } }));
  /** A milestone's goal's milestones, in the ladder's order. */
  const krsOf = (goal: string) => map.milestones.filter((m) => m.goal === goal).map((m) => m.id);
  const afterOf = (m: GoalMap, id: string) => m.milestones.find((x) => x.id === id)?.depends[0] ?? null;
  /**
   * A goal's milestones in `ids`' order: each comes after the one before it (the map orders them by
   * what each comes after), the first keeping what it came after outside the goal. Written first to
   * last, so no step makes a loop.
   */
  const chain = async (ids: string[], first: string | null): Promise<GoalMap | null> => {
    let next: GoalMap | null = null;
    for (let i = 0; i < ids.length; i++) {
      const want = i === 0 ? first : ids[i - 1];
      if (afterOf(next ?? map, ids[i]) === want) continue;
      next = await unwrap(api.PATCH("/v1/simple/goal-map/milestones/{milestone_id}", { params: { path: { milestone_id: ids[i] } }, body: { after: want, confirm: false } }));
    }
    return next;
  };
  /** Puts back what each milestone came after, as `was` read. */
  const putBack = async (was: Map<string, string | null>, ids: string[]) => {
    let at: GoalMap = map;
    for (const id of ids) {
      const want = was.get(id) ?? null;
      if (afterOf(at, id) !== want) at = await unwrap(api.PATCH("/v1/simple/goal-map/milestones/{milestone_id}", { params: { path: { milestone_id: id } }, body: { after: want, confirm: false } }));
    }
  };
  const setGoal = (x: LdFeature, goal: string | null, where: string) =>
    change(
      { op: "set_goal", target: { item_id: x.f.id }, before: { goal_id: x.item?.goal?.id ?? null }, after: { goal_id: goal } },
      `Moved ${named(x.f.id)} to ${where}`,
      `move ${named(x.f.id)} to ${where}`,
    );

  const act: Acts = {
    move: async (feature, from, to) => {
      if (from === to) return;
      try {
        const next = await unwrap(api.POST("/v1/simple/goal-map/links/move", { body: { feature, from_milestone: from, to_milestone: to } }));
        props.setMap(next);
        setFresh(feature);
        const m = map.milestones.find((x) => x.id === to);
        toast({
          message: `Moved ${named(feature)} to ${msCode.get(to)} ${m?.name ?? ""}`,
          action: { label: "Undo", onClick: () => void unwrap(api.POST("/v1/simple/goal-map/links/move", { body: { feature, from_milestone: to, to_milestone: from } })).then(props.setMap, failed) },
        });
      } catch (e) {
        failed(e);
      }
    },
    link: async (waiter, on) => {
      const w = byId.get(waiter);
      if (!w?.item || waiter === on) return;
      try {
        setRefused(null);
        await change(
          { op: "set_depends", target: { item_id: waiter }, before: { depends_on: w.item.depends_keys }, after: { depends_on: [...w.item.depends_keys, dependsKey(byId.get(on))] } },
          `${named(waiter)} now waits on ${named(on)}`,
          `${named(waiter)} waits on ${named(on)}`,
        );
        setFresh(waiter);
        setSel(waiter);
      } catch (e) {
        // A loop is refused (422); the drawn arrow stays red until the next pick, and the words
        // name both cards: the one drawn from already waits on the one drawn onto. Any other
        // refusal gets one plain line, never the API's field path.
        const said = e instanceof ChangeFailed && e.status === 422 ? e.message : "";
        if (said.startsWith("Not added, it would make a loop:")) {
          setRefused([on, waiter]);
          toast({ message: `Not added, it would make a loop: ${named(on)} already waits on ${named(waiter)}` });
        } else if (said.startsWith("after.depends_on: item or feature keys")) {
          toast({ message: `Not added: ${byId.get(on)?.f.name ?? "this feature"} has no roadmap item yet to link to` });
        } else if (said.startsWith("after.depends_on: no item or feature has the key")) {
          toast({ message: "Not added: no feature has that key" });
        } else if (said) {
          toast({ message: "Not added. Try again or pick another feature." });
        } else failed(e);
      }
    },
    unlink: async (waiter, on) => {
      const w = byId.get(waiter);
      const o = byId.get(on);
      if (!w?.item || !o) return;
      const keep = w.item.depends_keys.filter((k) => k !== o.item?.key && k.toLowerCase() !== o.code.toLowerCase());
      try {
        await change(
          { op: "set_depends", target: { item_id: waiter }, before: { depends_on: w.item.depends_keys }, after: { depends_on: keep } },
          `${named(waiter)} no longer waits on ${named(on)}`,
          `${named(waiter)} stops waiting on ${named(on)}`,
        );
      } catch (e) {
        failed(e);
      }
    },
    remove: async (feature) => {
      const x = byId.get(feature);
      if (!x) return;
      setMenu(null);
      try {
        await change({ op: "delete_item", target: { item_id: feature }, before: { deleted: false }, after: { deleted: true } }, `Moved ${named(feature)} to Trash`, `delete ${named(feature)}`);
        if (sel === feature) setSel(null);
      } catch (e) {
        failed(e);
      }
    },
    step: async (feature, dir) => {
      setMenu(null);
      const x = byId.get(feature);
      const m = x?.f.milestones[0];
      const list = feats.filter((y) => y.f.milestones[0] === m);
      const i = list.findIndex((y) => y.f.id === feature);
      const other = list[i + dir];
      const all = roadmap.data?.items ?? [];
      const at = all.findIndex((y) => y.id === other?.f.id);
      const from = all.findIndex((y) => y.id === feature);
      if (!other || at < 0 || from < 0) return;
      try {
        await change({ op: "reorder", target: { item_id: feature }, before: { position: from }, after: { position: at } }, `Moved ${named(feature)} ${dir < 0 ? "up" : "down"}`, `move ${named(feature)} ${dir < 0 ? "up" : "down"}`);
      } catch (e) {
        failed(e);
      }
    },
    add: async (milestone, title) => {
      const m = map.milestones.find((x) => x.id === milestone);
      if (!m || !title.trim()) return;
      try {
        // On the roadmap its milestone's work is on (else Oracle picks one the person may edit).
        const roadmap = feats.find((x) => x.f.milestones.includes(milestone) && x.item)?.item?.roadmap?.id ?? null;
        const r = await propose({ op: "add_item", target: { roadmap_id: roadmap, where: { kind: "goal", value: m.goal } }, before: {}, after: { title: title.trim() } });
        const id = r.change.status === "applied" ? (r.change.target as { item_id?: string }).item_id : undefined;
        if (id && canChange) {
          const next = await unwrap(api.POST("/v1/simple/goal-map/links", { body: { feature: id, milestone, area: m.areas[0] ?? map.areas[0]?.id ?? "", expected: "", confidence: "medium" } }));
          props.setMap(next);
          setFresh(id);
        }
        await reload();
        setAdding(null);
        toast({ message: r.change.status === "applied" ? `Added ${title.trim()} under ${msCode.get(milestone)}` : `Suggested: add ${title.trim()}.${map.approver ? ` Sent to ${map.approver}.` : ""}` });
      } catch (e) {
        failed(e);
      }
    },
    place: async (feature, x, y) => {
      try {
        const next = await unwrap(api.POST("/v1/simple/goal-map/place-card", { body: { feature, x, y } }));
        props.setMap(next);
        if (x !== null)
          toast({ message: `Moved ${named(feature)} by hand`, action: { label: "Undo", onClick: () => void unwrap(api.POST("/v1/simple/goal-map/place-card", { body: { feature, x: null, y: null } })).then(props.setMap, failed) } });
      } catch (e) {
        failed(e);
      }
    },
    tidy: async () => {
      try {
        props.setMap(await unwrap(api.DELETE("/v1/simple/goal-map/places")));
      } catch (e) {
        failed(e);
      }
    },
    moveTo: (feature) => {
      setMenu(null);
      setSheet({ kind: "move", feature });
    },
    waitsOn: (feature) => {
      setMenu(null);
      setSheet({ kind: "waits", feature });
    },
    krTo: (milestone) => {
      setMenu(null);
      setSheet({ kind: "kr", feature: milestone });
    },
    refuse,
    dropFeature: async (feature, t) => {
      const x = byId.get(feature);
      if (!x) return;
      const [kind, ref] = [t.slice(0, t.indexOf(":")), t.slice(t.indexOf(":") + 1)];
      if (kind === "ms") {
        const m = map.milestones.find((y) => y.id === ref);
        if (!m || x.f.milestones.includes(ref)) return;
        if (canChange) {
          if (x.free) {
            try {
              const next = await attachLink(feature, ref);
              props.setMap(next);
              setFresh(feature);
              toast({ message: `Moved ${named(feature)} to ${krName(ref)}`, action: { label: "Undo", onClick: () => void detachLink(feature, ref).then(props.setMap, failed) } });
            } catch (e) {
              failed(e);
            }
          } else await act.move(feature, x.f.milestones[0], ref);
          return;
        }
        // A commenter: the goal the milestone serves, as a suggestion; within its own goal, none.
        if (m.goal !== x.goal) await act.dropFeature(feature, `free:${m.goal}`);
        else refuse("Only owners and approvers put a feature on a milestone");
        return;
      }
      const goal = ref === "none" ? null : ref;
      // Onto its own goal's card or column: nothing moves (a drop on "Not on a key result" lets go).
      if (kind !== "free" && goal === x.goal) return;
      if (x.free && goal === x.goal) return;
      const where = kind === "free" && goal ? `Not on a key result in ${goalName(goal)}` : goalName(goal);
      if (!canChange) {
        if (goal === x.goal) return refuse("Only owners and approvers take a feature off a milestone");
        try {
          await setGoal(x, goal, goalName(goal));
        } catch (e) {
          failed(e);
        }
        return;
      }
      const links = x.f.links;
      try {
        for (const l of links) props.setMap(await detachLink(feature, l.milestone));
        // Off its milestones it serves its item's own goal: set it when that is not the one dropped on.
        const read = await unwrap(api.GET("/v1/simple/roadmap", { params: { query: {} } }));
        const now = read.items.find((i) => i.id === feature)?.goal?.id ?? null;
        const c = now !== goal ? (await propose({ op: "set_goal", target: { item_id: feature }, before: { goal_id: now }, after: { goal_id: goal } })).change : null;
        await reload();
        setFresh(feature);
        toast({
          message: `Moved ${named(feature)} to ${where}`,
          action: {
            label: "Undo",
            onClick: () =>
              void (async () => {
                if (c?.status === "applied" && c.can_undo) await undo(c.id);
                for (const l of links) props.setMap(await attachLink(feature, l.milestone, x.f.area, l.expected, l.confidence.toLowerCase() as "high" | "medium" | "low"));
              })().then(reload, failed),
          },
        });
      } catch (e) {
        failed(e);
        await reload();
      }
    },
    moveKr: async (milestone, goal, before) => {
      const m = map.milestones.find((x) => x.id === milestone);
      if (!m) return;
      if (!krCan(milestone)) {
        if (goal === m.goal) return refuse("Only an owner or the roadmap's decider moves milestones");
        // every-field-editable: who may not move it (an approver who is not the decider) asks to.
        try {
          await proposeKrGoal(m, goal, `move ${krName(milestone)} to ${goalName(goal)}`, reload);
          setMenu(null);
        } catch (e) {
          failed(e);
        }
        return;
      }
      const was = new Map(map.milestones.map((x) => [x.id, x.depends[0] ?? null] as const));
      const from = krsOf(m.goal);
      const ids = krsOf(goal).filter((x) => x !== milestone);
      const at = before ? ids.indexOf(before) : -1;
      ids.splice(at < 0 ? ids.length : at, 0, milestone);
      if (goal === m.goal && ids.join() === from.join()) return;
      const name = krName(milestone);
      const a0 = was.get(ids[0]) ?? null;
      const first = ids[0] !== milestone && a0 && !ids.includes(a0) ? a0 : null;
      try {
        if (goal !== m.goal) await unwrap(api.PATCH("/v1/simple/roadmap/milestones/{milestone_id}", { params: { path: { milestone_id: milestone } }, body: { goal_id: goal } }));
        await chain(ids, first);
        await reload();
        setMenu(null);
        toast({
          message: goal === m.goal ? `Moved ${name}` : `Moved ${name} to ${goalName(goal)}`,
          action: {
            label: "Undo",
            onClick: () =>
              void (async () => {
                // kr-in-goal-map: back onto its own goal (a key result's milestone, onto the key result).
                if (goal !== m.goal) await unwrap(api.PATCH("/v1/simple/roadmap/milestones/{milestone_id}", { params: { path: { milestone_id: milestone } }, body: { goal_id: (m as GmMilestone & { kr?: string }).kr ?? m.goal } }));
                await putBack(was, [...from, ...ids.filter((x) => !from.includes(x))]);
              })().then(reload, failed),
          },
        });
      } catch (e) {
        failed(e);
        await reload();
      }
    },
    stepKr: async (milestone, dir) => {
      const m = map.milestones.find((x) => x.id === milestone);
      if (!m) return;
      const ids = krsOf(m.goal);
      const i = ids.indexOf(milestone);
      const other = ids[i + dir];
      if (!other) return;
      // Down: before the one after the next (none: last).
      await act.moveKr(milestone, m.goal, dir < 0 ? other : (ids[i + 2] ?? null));
    },
    orderGoal: async (goal, to) => {
      setMenu(null);
      if (!canChange) return refuse("Only owners and approvers change the goal order");
      const was = goals.map((g) => g.id);
      const next = was.filter((x) => x !== goal);
      next.splice(Math.max(0, Math.min(to, next.length)), 0, goal);
      if (next.join() === was.join()) return;
      try {
        await storeGoalOrder(next, new Map(was.map((id, i) => [id, i + 1] as const)));
        await reload();
        toast({ message: "Goal order saved", action: { label: "Undo", onClick: () => void storeGoalOrder(was, new Map(next.map((id, i) => [id, i + 1] as const))).then(reload, failed) } });
      } catch (e) {
        failed(e);
        await reload();
      }
    },
    trashGoal: async (goal) => {
      setMenu(null);
      const g = goals.find((x) => x.id === goal);
      if (!g) return;
      const name = goalName(goal);
      const krs = krsOf(goal);
      const fs = feats.filter((x) => x.goal === goal).length;
      const ok = await confirmInPage({
        action: "Move to Trash",
        title: `Move ${name} to Trash?`,
        message: `${krs.length} ${krs.length === 1 ? "milestone goes" : "milestones go"} with it, and its ${fs} ${fs === 1 ? "feature moves" : "features move"} to No goal. Restore puts them back.`,
        destructive: true,
      });
      if (!ok) return;
      try {
        const out = await unwrap(api.DELETE("/v1/simple/goal-buckets/goals/{goal_id}", { params: { path: { goal_id: goal } } }));
        await reload();
        if (out.change)
          toast({
            message: `Suggested: move ${name} to Trash.${map.approver ? ` Sent to ${map.approver}.` : ""}`,
            action: { label: "Undo", onClick: () => void unwrap(api.POST("/v1/simple/changes/{change_id}/withdraw", { params: { path: { change_id: out.change!.id } } })).then(reload, failed) },
          });
        else
          toast({
            message: `Moved ${name} to Trash`,
            action: out.can_restore ? { label: "Undo", onClick: () => void unwrap(api.POST("/v1/simple/goal-buckets/goals/{goal_id}/restore", { params: { path: { goal_id: goal } } })).then(reload, failed) } : undefined,
          });
      } catch (e) {
        failed(e);
      }
    },
    trashKr: async (milestone) => {
      setMenu(null);
      const name = krName(milestone);
      try {
        await unwrap(api.DELETE("/v1/simple/roadmap/milestones/{milestone_id}", { params: { path: { milestone_id: milestone } } }));
        await reload();
        toast({
          message: `Moved ${name} to Trash`,
          action: { label: "Undo", onClick: () => void unwrap(api.POST("/v1/simple/roadmap/milestones/{milestone_id}/restore", { params: { path: { milestone_id: milestone } } })).then(reload, failed) },
        });
      } catch (e) {
        failed(e);
      }
    },
  };

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (!(e.target as HTMLElement).closest?.("[data-ld-menu]")) setMenu(null);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);

  // goal-map-editing: the header's badge leads to the features on no milestone, highlighted a while.
  useEffect(() => {
    let off: ReturnType<typeof setTimeout> | undefined;
    const show = () => {
      setFlash(true);
      clearTimeout(off);
      off = setTimeout(() => setFlash(false), 4000);
    };
    window.addEventListener("ld-show-loose", show);
    return () => {
      window.removeEventListener("ld-show-loose", show);
      clearTimeout(off);
    };
  }, []);

  // Escape lets go, in order: an open menu, a picked arrow and its pop-up, then the picked card.
  // goal-map-editing: Delete (or Backspace) moves the picked card to Trash while editing.
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]");
      if ((e.key === "Delete" || e.key === "Backspace") && edit && may && sel && !sheet && !typing) {
        e.preventDefault();
        void act.remove(sel);
        return;
      }
      if (e.key !== "Escape" || sheet) return;
      if (menu) setMenu(null);
      else if (arrow) setArrowAt(null);
      else if (sel) {
        setSel(null);
        setRefused(null);
      }
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `act` is rebuilt each render; `sel` and `edit` stand for it.
  }, [menu, arrow, sel, sheet, edit, may]);

  const firstLoose = goals.find((g) => feats.some((x) => x.free && x.goal === g.id));
  const v: V = { map, goals, ms, msCode, feats, byId, sel, setSel: (id) => { setSel(id); setRefused(null); }, edit, canChange, krCan, may, phone, places, live, menu, setMenu, arrow, setArrow: (key) => setArrowAt(key ? { key, sel } : null), adding, setAdding, drop, refused, fresh, flash, flashGoal: firstLoose?.id ?? null, onOpen: props.onOpen, act };
  const drag = { setLive, setDrop };

  return (
    <Ctx.Provider value={{ props }}>
      <header className="flex flex-wrap items-end justify-between gap-3">
      {props.head}
      <div className="flex flex-wrap items-center justify-end gap-2" data-testid="ld-actions">
        {props.flags}
        {may ? (
          <Btn primary={edit} testId="ld-edit" onClick={() => { setEdit(!edit); setMenu(null); setAdding(null); }}>
            {edit ? <><Icon name="check" size={16} /> {canChange ? "Done" : "Done suggesting"}</> : canChange ? "Edit ladder" : "Suggest changes"}
          </Btn>
        ) : (
          <span data-testid="ld-read-only" className="rounded-full bg-surface2 px-3 py-1 text-[14px] font-semibold text-text2" title="You can read this ladder. Owners and approvers change it; commenters suggest changes.">
            Read only
          </span>
        )}
      </div>
      </header>
      {!phone && props.guardrail}
      {phone ? <Phone v={v} /> : (
        <>
          <PeriodStrip v={v} />
          <Canvas v={v} drag={drag} />
        </>
      )}
      {sheet && <Sheet v={v} sheet={sheet} onClose={() => setSheet(null)} />}
    </Ctx.Provider>
  );
}

/** The page's own edits, for the goal and milestone menus. */
const Ctx = createContext<{ props: LadderProps } | null>(null);

function Btn({ children, onClick, primary, testId, small, label }: { children: ReactNode; onClick?: () => void; primary?: boolean; testId?: string; small?: boolean; label?: string }) {
  return (
    <button type="button" aria-label={label} data-testid={testId} onClick={onClick} className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border font-semibold ${small ? "px-2.5 py-0.5 text-[14px]" : "px-4 py-1.5 text-[15px]"} ${primary ? "border-accent bg-accent text-on-accent" : "border-line bg-surface text-text hover:bg-surface2"}`}>
      {children}
    </button>
  );
}

/* ---------- the week strip: the rest of this quarter and the next, today and each milestone's week ---------- */

interface Week { n: number; from: string; today: boolean; mark: string; full: string }

function periods(map: GoalMap, ms: GmMilestone[], code: Map<string, string>): { id: string; name: string; weeks: Week[] }[] {
  const today = map.today_on;
  const t = new Date(`${today}T00:00:00Z`);
  const monday = addDays(today, -((t.getUTCDay() + 6) % 7));
  const y = t.getUTCFullYear();
  const q = Math.floor(t.getUTCMonth() / 3);
  const qEnd = new Date(Date.UTC(y, q * 3 + 3, 1)).toISOString().slice(0, 10);
  const ny = q === 3 ? y + 1 : y;
  const nq = (q + 1) % 4;
  const nEnd = new Date(Date.UTC(ny, nq * 3 + 3, 1)).toISOString().slice(0, 10);
  const weeks = (from: string, to: string): Week[] => {
    const out: Week[] = [];
    for (let w = from, n = 1; w < to; w = addDays(w, 7), n++) {
      const end = addDays(w, 7);
      const due = ms.filter((m) => m.due_on && m.due_on >= w && m.due_on < end);
      out.push({ n, from: w, today: today >= w && today < end, mark: due.map((m) => `${code.get(m.id)} ${short(m.name)}`).join("\n"), full: due.map((m) => `${code.get(m.id)} ${m.name}`).join("\n") });
    }
    return out;
  };
  const nStart = qEnd;
  const nMonday = addDays(nStart, (8 - new Date(`${nStart}T00:00:00Z`).getUTCDay()) % 7);
  return [
    { id: "now", name: q === 3 ? `Rest of ${y}` : `Rest of Q${q + 1} ${y}`, weeks: weeks(monday, nMonday) },
    { id: "next", name: `Q${nq + 1} ${ny}`, weeks: weeks(nMonday, nEnd) },
  ];
}

function PeriodStrip({ v }: { v: V }) {
  const ps = periods(v.map, v.ms, v.msCode);
  return (
    <div className="flex gap-4" data-testid="ld-periods">
      {ps.map((p) => {
        const end = addDays(p.weeks.at(-1)?.from ?? v.map.today_on, 7);
        const n = v.goals.filter((g) => v.ms.some((m) => m.goal === g.id && m.due_on && m.due_on >= (p.weeks[0]?.from ?? "") && m.due_on < end)).length;
        return (
          <div key={p.id} className="flex min-w-0 flex-col gap-1" style={{ flex: p.weeks.length }}>
            <span className="text-[13px] font-bold tracking-wide text-text2 uppercase">
              {p.name} · {n} {n === 1 ? "goal" : "goals"}
            </span>
            <span className="flex gap-1">
              {p.weeks.map((w) => (
                <span key={w.n} className="flex min-w-0 flex-1 flex-col items-center gap-0.5">
                  <span data-testid={w.today ? "ld-today" : undefined} title={`Week of ${day(w.from)}`} className={`grid h-6 w-full place-items-center rounded-md text-[12px] font-semibold ${w.today ? "bg-accent text-on-accent" : w.mark ? "bg-accent-soft text-accent-ink ring-1 ring-accent/50" : "bg-surface2 text-text-faint"}`}>
                    W{w.n}
                  </span>
                </span>
              ))}
            </span>
            <WeekLabels weeks={p.weeks} />
          </div>
        );
      })}
    </div>
  );
}

/** A milestone's first few words for the week strip, never ending on a small word ("by", "at", "without"...). */
function short(name: string): string {
  const w: string[] = [];
  for (const x of name.split(" ")) if ([...w, x].join(" ").length <= 26) w.push(x);
  else break;
  while (w.length > 2 && /^(by|at|for|to|of|in|inside|without|under|one|a|the|and|every|down|weekly|baseline|new|per|with|from|on|than|over|into|or|up|each)$/i.test(w[w.length - 1])) w.pop();
  return w.join(" ");
}

/** Under the week chips: "We are here" and each milestone's name, a row down when it would touch a neighbour. */
function WeekLabels({ weeks }: { weeks: Week[] }) {
  const placed = weeks.flatMap((w, i) => {
    const text = w.today ? "We are here" : w.mark;
    return text ? [{ i, text, full: w.today ? undefined : w.full, today: w.today }] : [];
  });
  const n = weeks.length;
  // Until the labels are measured, the rows a label takes when its neighbour is under 3 weeks away,
  // so the canvas below fits itself to the strip's height when it opens.
  const guess: number[] = [];
  for (const { i, text } of placed) {
    const lines = text.split("\n").length;
    let r = 0;
    while (Array.from({ length: lines }, (_, k) => guess[r + k]).some((x) => x !== undefined && i - x < 3)) r++;
    for (let k = 0; k < lines; k++) guess[r + k] = i;
  }
  const box = useRef<HTMLSpanElement>(null);
  // Each label's place, from its drawn width: under its week, kept inside the strip, and a row
  // down (as the Roadmap's milestone labels) when its box would meet one already placed.
  const [at, setAt] = useState<{ pos: { left: number; top: number }[]; rows: number } | null>(null);
  const key = placed.map((x) => `${x.i}:${x.text}`).join("|");
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const lay = () => {
      const width = el.clientWidth;
      const taken: [number, number][][] = [];
      const pos = (Array.from(el.children) as HTMLElement[]).map((k, j) => {
        const w = k.offsetWidth;
        const lines = Math.max(1, Math.round(k.offsetHeight / 13));
        const left = Math.max(0, Math.min(width - w, ((placed[j].i + 0.5) / n) * width - w / 2));
        const free = (r: number) => Array.from({ length: lines }, (_, x) => taken[r + x] ?? []).every((row) => row.every(([a, b]) => left + w + 6 <= a || b + 6 <= left));
        let r = 0;
        while (!free(r)) r++;
        for (let x = 0; x < lines; x++) (taken[r + x] ??= []).push([left, left + w]);
        return { left, top: r * 13 };
      });
      const next = { pos, rows: taken.length };
      setAt((o) => (JSON.stringify(o) === JSON.stringify(next) ? o : next));
    };
    lay();
    const ro = new ResizeObserver(lay);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for the labels.
  }, [key, n]);
  return (
    <span ref={box} className="relative block" style={{ height: (at?.rows ?? guess.length) * 13 + 6 }}>
      {placed.map(({ i, text, full, today }, j) => (
        <span
          key={i}
          data-testid={today ? "ld-here" : "ld-week-mark"}
          title={full}
          className={`absolute w-max max-w-[160px] text-[11px] leading-[13px] whitespace-pre-line ${today ? "font-semibold text-accent-ink" : "text-text2"} ${i === 0 ? "text-left" : i === n - 1 ? "text-right" : "text-center"}`}
          style={at?.pos[j] ? { left: at.pos[j].left, top: at.pos[j].top } : { left: 0, top: 0, visibility: "hidden" }}
        >
          {text}
        </span>
      ))}
    </span>
  );
}

/* ---------- cards ---------- */

function More({ open, onClick, label }: { open?: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      data-testid="ld-more"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`grid h-6 w-7 shrink-0 place-items-center rounded-md border ${open ? "border-accent bg-accent-soft text-accent-ink" : "border-transparent text-text2 hover:border-line"}`}
    >
      <Icon name="more" size={16} />
    </button>
  );
}

function MenuList({ items, testId }: { items: { w: string; on: () => void; crit?: boolean }[]; testId: string }) {
  return (
    <div data-ld-menu data-testid={testId} role="menu" className="absolute top-full right-1 z-30 mt-1 flex w-52 flex-col rounded-xl border border-line bg-surface py-1 text-text shadow-lg" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      {items.map(({ w, on, crit }) => (
        <button key={w} type="button" role="menuitem" onClick={on} className={`px-3 py-1.5 text-left text-[14px] font-normal hover:bg-surface2 ${crit ? "text-crit" : ""}`}>
          {w}
        </button>
      ))}
    </div>
  );
}

function useLadderProps(): LadderProps {
  return useContext(Ctx)!.props;
}

/** goal-map-scoreboard: where a goal's reading comes from, or the action that gives it one. */
function Reading({ g, canEdit, onPick }: { g: GmGoal; canEdit: boolean; onPick: (goal: string) => void }) {
  const link = "w-fit text-[12px] leading-4 font-semibold text-accent-ink hover:underline";
  if (g.missing === "metric")
    return canEdit ? (
      <button type="button" data-testid="gm-pick-metric" onClick={() => onPick(g.id)} className={link}>
        Pick its metric
      </button>
    ) : (
      <Link href="/company/metrics" data-testid="gm-see-metrics" className={link}>See metrics</Link>
    );
  if (g.missing === "values" && g.metric)
    return (
      <Link href={`/company/metrics?metric=${encodeURIComponent(g.metric.id)}`} data-testid="gm-add-value" className={link}>
        Add a value
      </Link>
    );
  return null;
}

/** Where a goal's reading comes from, behind the reading's (i) (the frames show no line for it). */
function Source({ g }: { g: GmGoal }) {
  if (g.missing) return null;
  return (
    <InfoTip label="where this reading comes from" testId="gm-goal-source-tip">
      <span data-testid="gm-goal-source">
        {g.metric ? `From ${g.metric.title}` : "Typed in by hand"}
        {g.read_on ? ` · ${g.read_on}` : ""}
      </span>
    </InfoTip>
  );
}

function GoalCard({ g, i, v }: { g: GmGoal; i: number; v: V }) {
  const p = useLadderProps();
  const now = v.ms.some((m) => m.goal === g.id && m.due_on && m.due_on <= addDays(v.map.today_on, 14));
  const draws = [...new Set(v.ms.filter((m) => m.goal === g.id).flatMap((m) => m.areas))].map((a) => v.map.areas.find((x) => x.id === a)?.name).filter(Boolean);
  const key = `goal:${g.id}`;
  const live = v.live?.id === g.id ? v.live : null;
  const krs = p.keyResults?.get(g.id) ?? [];
  return (
    <div
      data-ld-goal={g.id}
      data-goal={g.id}
      data-testid="ld-goal"
      tabIndex={v.edit && v.may ? 0 : undefined}
      onKeyDown={(e) => {
        if ((e.key === "Delete" || e.key === "Backspace") && v.edit && v.may && e.target === e.currentTarget) {
          e.preventDefault();
          e.stopPropagation();
          void v.act.trashGoal(g.id);
        }
      }}
      style={live ? { transform: `translate(${live.dx}px, ${live.dy}px)`, zIndex: 40 } : v.menu === key ? { zIndex: 40 } : undefined}
      className={`relative flex flex-col gap-0.5 rounded-2xl border bg-surface px-3 py-2 ${p.picked === g.id ? "ring-4 ring-accent/40" : ""} ${now || p.picked === g.id ? "border-2 border-accent" : "border-line"} ${live ? "rotate-1 shadow-2xl" : ""} ${v.drop === `goal:${g.id}` ? "border-accent! bg-accent-soft" : ""}`}
    >
      <span className="flex items-start justify-between gap-2">
        <span className="flex items-center gap-1 text-[13px] font-bold tracking-wide text-text2 uppercase">
          {v.edit && v.canChange && !v.phone && <span className="cursor-grab text-text-faint" aria-hidden><Icon name="grip" size={16} /></span>}
          Goal {i + 1}
        </span>
        {v.edit && v.may && <More label={`More for ${g.name}`} open={v.menu === key} onClick={() => v.setMenu(v.menu === key ? null : key)} />}
      </span>
      <span className="text-[16px] leading-5 font-semibold">{g.name}</span>
      <span className="text-[13px] leading-[18px] text-text2">{g.math}</span>
      <span data-testid="ld-goal-measure" className="flex flex-wrap items-baseline gap-x-2 text-[14px]">
        <span className="inline-flex items-baseline gap-2 whitespace-nowrap">
          <span data-testid="ld-goal-numbers" className="leading-5 whitespace-nowrap">
            <b className="text-[16px]">{num(g.current, g.unit)}</b> of {num(g.target, g.unit)}
          </span>
          <Source g={g} />
        </span>
        <span data-testid="ld-goal-status" className={`ml-auto leading-5 font-semibold whitespace-nowrap ${KR[g.status]}`}>{KR_WORD[g.status]}</span>
      </span>
      <Reading g={g} canEdit={v.canChange} onPick={p.onMetric} />
      {krs.length > 0 && (
        <div data-testid="ld-goal-krs" className="flex flex-col gap-0.5 border-t border-line pt-1">
          <span className="flex items-center gap-1 text-[12px] font-bold tracking-wide text-text2 uppercase">
            Key results
          </span>
          <ul className="flex flex-col gap-0.5">
            {krs.map((k) => (
              <li key={k.id} data-testid="ld-goal-kr" className="flex items-baseline justify-between gap-2 text-[13px] leading-[17px]">
                <span className="min-w-0">
                  {k.code && <span className="simple-code mr-1">{k.code}</span>}
                  {k.name}
                </span>
                <span className="whitespace-nowrap text-text2">{k.target === null ? "No target yet" : <><b className="text-text">{num(k.current, k.unit)}</b> of {num(k.target, k.unit)}</>}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {draws.length > 0 && <span className="text-[12px] leading-4 text-text2">Draws on: {draws.join(", ")}</span>}
      {v.menu === key && (
        <MenuList
          testId="ld-goal-menu"
          items={[
            ...(v.canChange
              ? [
                  { w: "Change the target", on: () => { v.setMenu(null); p.onGoal(g.id); } },
                  { w: "Pick its metric", on: () => { v.setMenu(null); p.onMetric(g.id); } },
                  ...(i > 0 ? [{ w: "Move left", on: () => void v.act.orderGoal(g.id, i - 1) }] : []),
                  ...(i < v.goals.length - 1 ? [{ w: "Move right", on: () => void v.act.orderGoal(g.id, i + 1) }] : []),
                ]
              : []),
            { w: "Move to Trash", on: () => void v.act.trashGoal(g.id), crit: true },
          ]}
        />
      )}
    </div>
  );
}

function MilestoneCard({ m, v }: { m: GmMilestone; v: V }) {
  const p = useLadderProps();
  const key = `ms:${m.id}`;
  const area = v.map.areas.find((a) => a.id === m.areas[0])?.name;
  const live = v.live?.id === m.id ? v.live : null;
  const krs = v.ms.filter((x) => x.goal === m.goal);
  const at = krs.findIndex((x) => x.id === m.id);
  return (
    <div
      data-ld-ms={m.id}
      data-testid="ld-milestone"
      tabIndex={v.edit && v.krCan(m.id) ? 0 : undefined}
      onKeyDown={(e) => {
        if ((e.key === "Delete" || e.key === "Backspace") && v.edit && v.krCan(m.id) && e.target === e.currentTarget) {
          e.preventDefault();
          e.stopPropagation();
          void v.act.trashKr(m.id);
        }
      }}
      style={live ? { transform: `translate(${live.dx}px, ${live.dy}px)`, zIndex: 40 } : v.menu === key ? { zIndex: 40 } : undefined}
      className={`relative flex flex-col gap-0.5 rounded-xl border bg-surface px-2.5 py-1.5 ${live ? "rotate-1 border-accent shadow-2xl" : "border-line"} ${v.drop === `kr:${m.id}` ? "border-accent! bg-accent-soft" : ""}`}
    >
      <span className="flex items-start gap-2">
        {v.edit && v.krCan(m.id) && !v.phone && <span className="mt-0.5 cursor-grab text-text-faint" aria-hidden><Icon name="grip" size={16} /></span>}
        <span className="text-[14px] leading-[18px] font-semibold">
          <span className="simple-code mr-1">{v.msCode.get(m.id)}</span>
          {m.name}
        </span>
        {v.edit && v.canChange && <span className="ml-auto"><More label={`More for ${m.name}`} open={v.menu === key} onClick={() => v.setMenu(v.menu === key ? null : key)} /></span>}
      </span>
      <span className="text-[12px] leading-4 text-text2" title={m.measure}>
        {m.threshold === null ? <>Reads <b className="text-text">{num(m.current, mUnit(m.unit))}</b> · no gate yet</> : <><b className="text-text">{num(m.current, mUnit(m.unit))}</b> of {num(m.threshold, mUnit(m.unit))}</>}
        {m.due_on ? ` · by ${day(m.due_on)}` : ""}
        {area ? ` · ${area}` : ""}
      </span>
      <b data-testid="ld-ms-status" className={`text-[12px] leading-4 ${m.proposed ? "text-accent-ink" : KR[m.status]}`}>{m.proposed ? "Proposed" : KR_WORD[m.status]}</b>
      {v.menu === key && (
        <MenuList
          testId="ld-ms-menu"
          items={[
            { w: m.proposed ? "Set and confirm the gate" : "Edit the gate", on: () => { v.setMenu(null); p.onGate(m.id); } },
            { w: "Attach a feature…", on: () => { v.setMenu(null); p.onAttach(m.id, m.areas[0] ?? ""); } },
            ...(p.onPrd ? [{ w: "New PRD from it", on: () => { v.setMenu(null); p.onPrd!(m.id); } }] : []),
            ...(v.krCan(m.id)
              ? [
                  ...(at > 0 ? [{ w: "Move up", on: () => void v.act.stepKr(m.id, -1) }] : []),
                  ...(at < krs.length - 1 ? [{ w: "Move down", on: () => void v.act.stepKr(m.id, 1) }] : []),
                  { w: "Move to…", on: () => v.act.krTo(m.id) },
                  { w: "Move to Trash", on: () => void v.act.trashKr(m.id), crit: true },
                ]
              : // every-field-editable: anyone else who may propose asks to move it to another goal.
                v.may ? [{ w: "Move to another goal…", on: () => v.act.krTo(m.id) }] : []),
          ]}
        />
      )}
    </div>
  );
}

function FeatureCard({ x, v, ms, compact }: { x: LdFeature; v: V; ms?: string; compact?: boolean }) {
  const { f } = x;
  const { sel, byId } = v;
  const picked = sel ? byId.get(sel) : undefined;
  const related = !sel || sel === f.id || x.waits.includes(sel) || (picked?.waits ?? []).includes(f.id);
  const menu = v.menu === `f:${f.id}`;
  // A card whose menu is open is never dimmed: its menu is drawn solid over the rest.
  const dim = !!sel && !related && !v.phone && !menu;
  const isSel = sel === f.id;
  const place = v.places.get(f.id);
  const live = v.live?.id === f.id ? v.live : null;
  const dx = (place?.x ?? 0) + (live?.dx ?? 0);
  const dy = (place?.y ?? 0) + (live?.dy ?? 0);
  const loop = v.refused?.includes(f.id);
  const fresh = v.fresh === f.id;
  const status = x.item?.status;
  const handles = v.edit && v.may;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${x.code} ${f.name}`.trim()}
      aria-pressed={isSel}
      data-ld-card={f.id}
      data-feature={f.id}
      data-testid="ld-feature"
      data-placed={place ? "1" : undefined}
      onClick={() => (v.phone ? v.onOpen(f) : v.setSel(isSel ? null : f.id))}
      onKeyDown={(e) => {
        if (e.key === "Enter") v.onOpen(f);
        if (e.key === " ") {
          e.preventDefault();
          v.setSel(isSel ? null : f.id);
        }
        // goal-map-editing: Delete moves it to Trash while editing (the picked card's, from anywhere).
        if ((e.key === "Delete" || e.key === "Backspace") && v.edit && v.may && !isSel) {
          e.preventDefault();
          e.stopPropagation();
          void v.act.remove(f.id);
        }
      }}
      style={dx || dy ? { transform: `translate(${dx}px, ${dy}px)`, zIndex: menu ? 40 : 20, ...(place && !live ? { boxShadow: "0 8px 24px rgb(0 0 0 / .18)" } : {}) } : menu ? { zIndex: 40 } : undefined}
      className={`relative flex cursor-pointer touch-none flex-col gap-0.5 rounded-xl border bg-surface ${compact ? "px-2 py-1.5" : "px-2.5 py-1.5"} transition-opacity select-none ${dim ? "[&>*]:opacity-40" : ""} ${isSel || place ? "border-accent" : "border-line hover:border-line-strong"} ${isSel ? "ring-2 ring-accent/40" : ""} ${fresh ? "border-accent! ring-2 ring-accent/40" : ""} ${live ? "rotate-1 shadow-2xl" : ""} ${v.drop === `card:${f.id}` ? "border-accent! bg-accent-soft" : ""} ${loop ? "border-crit! ring-2 ring-crit/30" : ""}`}
    >
      <span className="flex items-start gap-1.5">
        {handles && !v.phone && <span className="mt-0.5 cursor-grab text-text-faint" aria-hidden><Icon name="grip" size={16} /></span>}
        <span className={`min-w-0 flex-1 font-semibold ${compact ? "text-[13px] leading-[17px]" : "text-[14px] leading-[19px]"}`}>
          {x.code && <span className="simple-code mr-1 whitespace-nowrap">{x.code}</span>}
          {f.name}
        </span>
        {handles && <More label={`More for ${f.name}`} open={menu} onClick={() => v.setMenu(menu ? null : `f:${f.id}`)} />}
      </span>
      <span className={`flex flex-wrap items-center gap-x-1.5 ${compact ? "text-[12px]" : "text-[13px]"} leading-5`}>
        {status && <b className={WORK[status]}>{statusWord(status)}</b>}
        {/* Dates only Oracle's window gives (no one set them) read as the frames: No dates yet. */}
        <span className="text-text2">· {x.item?.estimated ? "No dates yet" : span(x.item?.start.date, x.item?.end.date)}</span>
        {(x.waits.length > 0 || x.wanted.length > 0) && (
          <span data-testid="ld-counts" className="ml-auto flex gap-1.5 text-text2" title={`Waits on ${x.waits.length} · ${x.wanted.length} wait on it`}>
            {x.waits.length > 0 && <span>←{x.waits.length}</span>}
            {x.wanted.length > 0 && <span>{x.wanted.length}→</span>}
          </span>
        )}
      </span>
      {x.suggested.map((id) => (
        <span key={id} data-testid="ld-suggested" className="w-fit rounded-md bg-warn-bg px-2 py-0.5 text-[12px] leading-4 font-semibold text-warn">
          Suggested: wait on {`${v.byId.get(id)?.code ?? ""} ${v.byId.get(id)?.f.name ?? ""}`.trim()}
        </span>
      ))}
      {isSel && !v.phone && (
        <button type="button" data-testid="ld-open" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); v.onOpen(f); }} className="w-fit text-[13px] font-semibold text-accent-ink hover:underline">
          Open
        </button>
      )}
      {place && !live && (
        <span data-testid="ld-placed" className="w-fit rounded-full bg-accent-soft px-2 text-[12px] leading-5 font-semibold text-accent-ink">
          Placed by hand · serves {v.msCode.get(f.milestones[0])} {v.map.milestones.find((m) => m.id === f.milestones[0])?.name}
        </span>
      )}
      {ms && f.milestones.length > 1 && <span className="text-[12px] leading-4 text-text2">Also serves {f.milestones.filter((m) => m !== ms).map((m) => v.msCode.get(m)).join(", ")}</span>}
      {/* the edge dot a dependency is drawn from (while editing, on the picked card) */}
      {handles && isSel && !v.phone && (
        <span data-ld-dot={f.id} data-testid="ld-dot" title="Drag onto the card that waits on this one" className="absolute top-1/2 -right-[9px] z-30 h-4 w-4 -translate-y-1/2 cursor-crosshair rounded-full border-2 border-surface bg-accent" />
      )}
      {menu && (
        <MenuList
          testId="ld-feature-menu"
          items={[
            { w: "Open", on: () => { v.setMenu(null); v.onOpen(f); } },
            { w: "Move to…", on: () => v.act.moveTo(f.id) },
            ...(x.free ? [] : [{ w: "Move up", on: () => void v.act.step(f.id, -1) }, { w: "Move down", on: () => void v.act.step(f.id, 1) }]),
            { w: "Waits on…", on: () => v.act.waitsOn(f.id) },
            { w: "Move to Trash", on: () => void v.act.remove(f.id), crit: true },
          ]}
        />
      )}
    </div>
  );
}

/** + Add: a feature under each milestone (a name field in place), a milestone under each goal. */
function AddFeature({ m, v }: { m: GmMilestone; v: V }) {
  const [name, setName] = useState("");
  if (v.adding === m.id)
    return (
      <form
        data-testid="ld-add-form"
        className="flex flex-col gap-1.5 rounded-xl border border-accent bg-surface p-2"
        onPointerDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void v.act.add(m.id, name);
        }}
      >
        <input autoFocus aria-label={`New feature under ${v.msCode.get(m.id)}`} value={name} onChange={(e) => setName(e.target.value)} className="rounded-lg border border-line bg-surface px-2 py-1 text-[14px]" />
        <span className="flex gap-1.5">
          <button type="submit" className="rounded-full border border-accent bg-accent px-2.5 py-0.5 text-[14px] font-semibold text-on-accent">Add</button>
          <Btn small onClick={() => v.setAdding(null)}>Cancel</Btn>
        </span>
      </form>
    );
  return (
    <button type="button" data-testid="ld-add-feature" onPointerDown={(e) => e.stopPropagation()} onClick={() => v.setAdding(m.id)} className="rounded-xl border border-dashed border-line-strong bg-surface2 px-2.5 py-1 text-left text-[13px] font-semibold text-text2 hover:bg-surface">
      + Add feature
    </button>
  );
}

/* ---------- the ladder: goal columns, milestones, the work behind each ---------- */

function Columns({ v }: { v: V }) {
  const p = useLadderProps();
  const noGoal = v.feats.filter((x) => !x.goal);
  // goal-map-editing: a last column for the features serving no goal (a drop zone while editing).
  const cols = v.goals.length + (noGoal.length > 0 || (v.edit && v.may) ? 1 : 0);
  return (
    <div className="flex flex-col gap-3" style={{ width: cols * COL + (cols - 1) * GAP }}>
      <div className="grid items-start" style={{ gridTemplateColumns: `repeat(${cols}, ${COL}px)`, gap: GAP }}>
        {v.goals.map((g, i) => (
          <div key={g.id} className={`flex min-w-0 flex-col items-stretch rounded-2xl ${v.drop === `col:${g.id}` ? "outline-2 outline-offset-4 outline-accent" : ""}`} data-testid="ld-column" data-ld-column={g.id}>
            <GoalCard g={g} i={i} v={v} />
            <Stem />
            <div className="flex flex-col gap-1.5 rounded-2xl bg-accent-soft/50 p-2">
              <span className="text-[12px] font-bold tracking-wide text-text2 uppercase">Milestones</span>
              {v.ms.filter((m) => m.goal === g.id).map((m) => <MilestoneCard key={m.id} m={m} v={v} />)}
              {v.edit && v.canChange && (
                <button type="button" data-testid="ld-add-milestone" onPointerDown={(e) => e.stopPropagation()} onClick={() => p.onAddMilestone(g.id)} className="rounded-xl border border-dashed border-line-strong bg-surface2 px-2.5 py-1 text-left text-[13px] font-semibold text-text2 hover:bg-surface">
                  + Add milestone
                </button>
              )}
            </div>
            <Stem />
            <div className="flex flex-col gap-1.5 rounded-2xl bg-surface2 p-2">
              <span className="text-[12px] font-bold tracking-wide text-text2 uppercase">Work behind it</span>
              {v.ms.filter((m) => m.goal === g.id).map((m) => <Group key={m.id} m={m} v={v} />)}
            </div>
            <Loose v={v} goal={g.id} />
          </div>
        ))}
        {cols > v.goals.length && <Loose v={v} goal={null} />}
      </div>
    </div>
  );
}

/**
 * goal-map-editing: the features on no milestone: under their goal ("Not on a key result"), or in
 * the last column ("No goal"). Drawn while it holds any, and while editing as a drop zone.
 */
function Loose({ v, goal }: { v: V; goal: string | null }) {
  const fs = v.feats.filter((x) => (goal ? x.free && x.goal === goal : !x.goal));
  const key = `free:${goal ?? "none"}`;
  if (goal && !fs.length && !(v.edit && v.may)) return null;
  return (
    <>
      {goal && <Stem />}
      <div
        data-ld-free={goal ?? "none"}
        data-testid={goal ? "ld-free" : "ld-nogoal"}
        data-goal={goal ?? undefined}
        data-count={fs.length}
        data-flash={v.flash && fs.length ? "1" : undefined}
        className={`flex flex-col gap-1.5 rounded-2xl border border-dashed p-2 transition-shadow ${v.drop === key ? "border-accent bg-accent-soft" : "border-line-strong"} ${v.flash && fs.length ? "ring-4 ring-accent/50" : ""}`}
      >
        <span className="text-[12px] font-bold tracking-wide text-text2 uppercase">
          {goal ? "Not on a key result" : "No goal"} · {fs.length}
        </span>
        {fs.map((x) => <FeatureCard key={x.f.id} x={x} v={v} />)}
      </div>
    </>
  );
}

function Stem() {
  return <span aria-hidden className="mx-auto block h-3 w-0.5 bg-line-strong" />;
}

/** One milestone's features (a feature drawn once; its other milestone points to it); a drop zone while editing. */
function Group({ m, v }: { m: GmMilestone; v: V }) {
  const fs = v.feats.filter((x) => x.f.milestones.includes(m.id));
  const drop = v.drop === `ms:${m.id}`;
  return (
    <div data-ld-group={m.id} data-testid="ld-group" className={`flex flex-col gap-1.5 ${drop ? "rounded-xl outline-2 outline-offset-2 outline-accent" : ""} ${v.edit && v.may ? "rounded-xl border border-dashed border-line p-1" : ""}`}>
      <span className="relative w-fit rounded bg-surface2 text-[12px] leading-4 font-semibold text-text2">
        <span className="simple-code">{v.msCode.get(m.id)}</span> {m.name}
      </span>
      {fs.map((x) =>
        x.f.milestones[0] === m.id ? (
          <FeatureCard key={x.f.id} x={x} v={v} ms={m.id} />
        ) : (
          <span key={x.f.id} className="rounded-xl border border-dashed border-line-strong px-2 py-1 text-[12px] leading-4 text-text2">
            <b className="text-text">{x.code}</b> {x.f.name} · card under {v.msCode.get(x.f.milestones[0])}
          </span>
        ),
      )}
      {v.edit && v.may && <AddFeature m={m} v={v} />}
    </div>
  );
}

/* ---------- the arrows: the picked card's, both ways ---------- */

type Path = { d: string; key: string; from: string; to: string; mid: [number, number] };

function curve(a: DOMRect, b: DOMRect, box: DOMRect, s: number): { d: string; mid: [number, number] } {
  const ay = (a.top + a.height / 2 - box.top) / s;
  const by = (b.top + b.height / 2 - box.top) / s;
  if (Math.abs(a.left - b.left) < 40 * s) {
    // In one column: out of the right edge and back in, bowed by how far apart they are.
    const x = (a.right - box.left) / s;
    // In the gutter (the column's padding and the gap), clear of the card's edge, never into the next column.
    const bow = 16 + Math.min(6, Math.abs(by - ay) / 80);
    return { d: `M${x},${ay} C${x + bow},${ay} ${x + bow},${by} ${x + 2},${by}`, mid: [x + bow * 0.75, (ay + by) / 2] };
  }
  const right = b.left > a.left;
  const x1 = ((right ? a.right : a.left) - box.left) / s;
  const x2 = ((right ? b.left : b.right) - box.left) / s;
  const dx = Math.max(40, Math.abs(x2 - x1) / 2) * (right ? 1 : -1);
  return { d: `M${x1},${ay} C${x1 + dx},${ay} ${x2 - dx},${by} ${x2},${by}`, mid: [(x1 + x2) / 2, (ay + by) / 2] };
}

function Arrows({ v, root, drawing, zoom }: { v: V; root: RefObject<HTMLDivElement | null>; drawing: { from: string; x: number; y: number } | null; zoom: number }) {
  // Lines are drawn in canvas units: divided by the zoom, they are 3 px on screen (5 px picked).
  const px = (n: number) => n / zoom;
  const [paths, setPaths] = useState<Path[]>([]);
  const [pend, setPend] = useState<string | null>(null);
  const [line, setLine] = useState<string | null>(null);
  const picked = v.arrow;
  const setPicked = v.setArrow;
  const { sel, feats, refused, live, places } = v;
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => {
      const box = el.getBoundingClientRect();
      const s = el.offsetWidth ? box.width / el.offsetWidth : 1;
      const at = (id: string) => el.querySelector(`[data-ld-card="${id}"]`)?.getBoundingClientRect();
      const out: Path[] = [];
      if (sel)
        for (const x of feats)
          for (const d of x.waits) {
            if (x.f.id !== sel && d !== sel) continue;
            const a = at(d);
            const b = at(x.f.id);
            if (a && b) out.push({ ...curve(a, b, box, s), key: `${d}>${x.f.id}`, from: d, to: x.f.id });
          }
      setPaths(out);
      const pair = drawing ? null : refused;
      const a = pair && at(pair[0]);
      const b = pair && at(pair[1]);
      setPend(a && b ? curve(a, b, box, s).d : null);
      // the arrow being drawn from the picked card's dot to the pointer
      const from = drawing && at(drawing.from);
      if (drawing && from) {
        const x1 = (from.right - box.left) / s;
        const y1 = (from.top + from.height / 2 - box.top) / s;
        const x2 = (drawing.x - box.left) / s;
        const y2 = (drawing.y - box.top) / s;
        setLine(`M${x1},${y1} C${x1 + 60},${y1} ${x2 - 60},${y2} ${x2},${y2}`);
      } else setLine(null);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [root, sel, feats, refused, live, places, drawing]);
  const pick = paths.find((p) => p.key === picked);
  const word = (id: string) => {
    const x = v.byId.get(id);
    return x ? <><b className="whitespace-nowrap">{x.code}</b> {x.f.name}</> : null;
  };
  return (
    <>
      <svg className="pointer-events-none absolute inset-0 z-10 h-full w-full overflow-visible" aria-hidden>
        <defs>
          <marker id="ld-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--accent)" />
          </marker>
          <marker id="ld-head-crit" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--crit)" />
          </marker>
        </defs>
        {paths.map((p) => (
          <g key={p.key}>
            <path data-testid="ld-arrow" data-arrow={p.key} d={p.d} fill="none" markerEnd="url(#ld-head)" className="text-accent" stroke="currentColor" strokeWidth={px(picked === p.key ? 5 : 3)} strokeOpacity={picked && picked !== p.key ? 0.35 : 0.95} />
            {/* a wider line under the pointer, to pick the arrow */}
            <path
              data-testid="ld-arrow-hit"
              data-arrow={p.key}
              d={p.d}
              fill="none"
              stroke="transparent"
              strokeWidth={px(14)}
              className="pointer-events-auto cursor-pointer"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setPicked(picked === p.key ? null : p.key);
              }}
            />
          </g>
        ))}
        {(line || pend) && <path data-testid={line ? "ld-drawing" : "ld-refused"} d={(line ?? pend)!} fill="none" stroke="currentColor" className={line ? "text-accent" : "text-crit"} strokeWidth={px(3)} strokeDasharray={`${px(6)} ${px(4)}`} markerEnd={line ? "url(#ld-head)" : "url(#ld-head-crit)"} />}
      </svg>
      {pick && (
        <span
          data-testid="ld-arrow-pop"
          className="absolute z-30 flex w-[280px] flex-col items-start gap-1 rounded-xl border border-accent bg-surface px-2.5 py-1.5 text-[13px] leading-[17px] shadow"
          style={{ left: pick.mid[0] + 14, top: pick.mid[1] - 40 }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <span>
            {word(pick.to)} waits on {word(pick.from)}
          </span>
          {v.may && (
            <button
              type="button"
              className="font-bold text-crit hover:underline"
              onClick={() => {
                setPicked(null);
                void v.act.unlink(pick.to, pick.from);
              }}
            >
              Remove
            </button>
          )}
        </span>
      )}
    </>
  );
}

/* ---------- the canvas: pan and zoom, cards placed by the ladder but movable ---------- */

function Canvas({ v, drag }: { v: V; drag: { setLive: (l: V["live"]) => void; setDrop: (d: string | null) => void } }) {
  const box = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 16, y: 12, z: START_ZOOM });
  const [size, setSize] = useState({ w: 0, h: 0, cw: 1, ch: 1 });
  const [drawing, setDrawing] = useState<{ from: string; x: number; y: number } | null>(null);
  const gesture = useRef<{ kind: "pan" | "card" | "dot" | "kr" | "goal"; id?: string; from?: string; sx: number; sy: number; vx: number; vy: number; moved: boolean } | null>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => {
      el.style.height = `${Math.max(420, innerHeight - el.getBoundingClientRect().top - window.scrollY * 0 - 16)}px`;
      setSize({ w: el.clientWidth, h: el.clientHeight, cw: root.current?.offsetWidth ?? 1, ch: root.current?.offsetHeight ?? 1 });
    };
    fit();
    // Opened below the fold, the canvas's own wheel-pan would hold the page still: scroll it into view once.
    el.scrollIntoView({ block: "nearest" });
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    if (root.current) ro.observe(root.current);
    return () => ro.disconnect();
  }, []);

  // goal-map-editing: the badge's lead pans the first group of features on no milestone into view.
  useEffect(() => {
    const el = box.current;
    const group = v.flash ? el?.querySelector<HTMLElement>("[data-ld-free][data-flash]") : null;
    if (!el || !group) return;
    el.scrollIntoView({ block: "nearest" });
    const b = el.getBoundingClientRect();
    const c = group.getBoundingClientRect();
    setView((o) => ({ ...o, x: o.x + (b.left + 24 - c.left), y: o.y + (b.top + 24 - c.top) }));
  }, [v.flash]);

  // A picked card stays in view: panned in by the least it needs, with its arrows' room around it.
  useEffect(() => {
    const el = box.current;
    const card = v.sel ? el?.querySelector<HTMLElement>(`[data-ld-card="${CSS.escape(v.sel)}"]`) : null;
    if (!el || !card) return;
    const b = el.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    const pad = 16;
    const dx = c.left < b.left + pad ? b.left + pad - c.left : c.right > b.right - pad ? b.right - pad - c.right : 0;
    const dy = c.top < b.top + pad ? b.top + pad - c.top : c.bottom > b.bottom - pad ? b.bottom - pad - c.bottom : 0;
    if (dx || dy) setView((o) => ({ ...o, x: o.x + dx, y: o.y + dy }));
    // Only when the pick changes, not on each pan.
  }, [v.sel]);
  const zoomTo = (z: number, cx = size.w / 2, cy = size.h / 2) =>
    setView((o) => {
      const nz = Math.min(1.5, Math.max(0.3, Math.round(z * 100) / 100));
      return { z: nz, x: cx - ((cx - o.x) / o.z) * nz, y: cy - ((cy - o.y) / o.z) * nz };
    });
  const fitAll = () => {
    // Fit never below 85%: smaller, names cannot be read.
    const z = Math.min(1.5, Math.max(0.85, Math.floor(((size.w - 32) / size.cw) * 100) / 100));
    setView({ x: 16, y: 12, z });
  };
  const canPlace = v.may;

  /** Swallows the click that may follow a drag's release; when none comes, the next real click still lands. */
  const swallowClick = () => {
    const stop = (c: MouseEvent) => c.stopPropagation();
    window.addEventListener("click", stop, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 0);
  };
  /**
   * What is under the pointer, looking through the card being dragged: a card ("card:<id>", for
   * the dot's arrow), a milestone card ("kr:<id>"), a milestone's work ("ms:<id>"), a group of
   * features on no milestone ("free:<goal|none>"), a goal card ("goal:<id>") or a goal's column
   * ("col:<id>"). `cards`: a card counts as itself; else as the zone it sits in.
   */
  const target = (cx: number, cy: number, self: string, cards = true): string | null => {
    for (const el of document.elementsFromPoint(cx, cy)) {
      const h = el as HTMLElement;
      const card = h.closest?.("[data-ld-card]") as HTMLElement | null;
      const kr = h.closest?.("[data-ld-ms]") as HTMLElement | null;
      const goal = h.closest?.("[data-ld-goal]") as HTMLElement | null;
      // The card being dragged sits under the pointer: look through it.
      if (card?.dataset.ldCard === self || kr?.dataset.ldMs === self || goal?.dataset.ldGoal === self) continue;
      if (card && cards) return `card:${card.dataset.ldCard}`;
      if (kr) return `kr:${kr.dataset.ldMs}`;
      const g = h.closest?.("[data-ld-group]") as HTMLElement | null;
      if (g) return `ms:${g.dataset.ldGroup}`;
      const free = h.closest?.("[data-ld-free]") as HTMLElement | null;
      if (free) return `free:${free.dataset.ldFree}`;
      if (goal) return `goal:${goal.dataset.ldGoal}`;
      const col = h.closest?.("[data-ld-column]") as HTMLElement | null;
      if (col) return `col:${col.dataset.ldColumn}`;
    }
    return null;
  };
  /** The goal a zone belongs to (a milestone's, a group's, a goal card's or column's). */
  const goalOfZone = (t: string | null): string | null => {
    if (!t) return null;
    const ref = t.slice(t.indexOf(":") + 1);
    if (t.startsWith("kr:") || t.startsWith("ms:")) return v.map.milestones.find((m) => m.id === ref)?.goal ?? null;
    return ref === "none" ? null : ref;
  };
  /** A feature's drop zone in Edit mode: a milestone card counts as its work. */
  const featureZone = (t: string | null) => (t?.startsWith("kr:") ? `ms:${t.slice(3)}` : t);

  const down = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest("button, input, form, [data-ld-menu], a")) return;
    const dot = t.closest("[data-ld-dot]") as HTMLElement | null;
    const card = t.closest("[data-ld-card]") as HTMLElement | null;
    // goal-map-editing: in Edit mode a milestone or a goal card is picked up (a commenter's move is refused on the drop).
    // A milestone its person may not change (not the roadmap's owner or decider) is not picked up: the card pans.
    const krEl = v.edit && v.may ? (t.closest("[data-ld-ms]") as HTMLElement | null) : null;
    const krLocked = !!krEl && !v.krCan(krEl.dataset.ldMs ?? "");
    const kr = krLocked ? null : krEl;
    const goal = v.edit && v.may && !krLocked ? (t.closest("[data-ld-goal]") as HTMLElement | null) : null;
    if (dot) gesture.current = { kind: "dot", from: dot.dataset.ldDot, sx: e.clientX, sy: e.clientY, vx: 0, vy: 0, moved: false };
    else if (card && canPlace) gesture.current = { kind: "card", id: card.dataset.ldCard, sx: e.clientX, sy: e.clientY, vx: 0, vy: 0, moved: false };
    else if (kr) gesture.current = { kind: "kr", id: kr.dataset.ldMs, sx: e.clientX, sy: e.clientY, vx: 0, vy: 0, moved: false };
    else if (goal) gesture.current = { kind: "goal", id: goal.dataset.ldGoal, sx: e.clientX, sy: e.clientY, vx: 0, vy: 0, moved: false };
    else if (!card) gesture.current = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
    else return;
  };
  const move = (e: RPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g) return;
    const dx = e.clientX - g.sx;
    const dy = e.clientY - g.sy;
    if (!g.moved && Math.hypot(dx, dy) < 5) return;
    // Captured once it is a drag, so a plain click still reaches the card.
    if (!g.moved) (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    g.moved = true;
    if (g.kind === "pan") setView((o) => ({ ...o, x: g.vx + dx, y: g.vy + dy }));
    if (g.kind === "card") {
      drag.setLive({ id: g.id!, dx: dx / view.z, dy: dy / view.z });
      const t = v.edit ? featureZone(target(e.clientX, e.clientY, g.id!, false)) : null;
      drag.setDrop(t);
    }
    if (g.kind === "kr" || g.kind === "goal") {
      drag.setLive({ id: g.id!, dx: dx / view.z, dy: dy / view.z });
      const t = target(e.clientX, e.clientY, g.id!, false);
      drag.setDrop(g.kind === "goal" ? (goalOfZone(t) ? `col:${goalOfZone(t)}` : null) : t);
    }
    if (g.kind === "dot") {
      setDrawing({ from: g.from!, x: e.clientX, y: e.clientY });
      const t = target(e.clientX, e.clientY, g.from!);
      drag.setDrop(t?.startsWith("card:") ? t : null);
    }
  };
  const up = (e: RPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    gesture.current = null;
    drag.setDrop(null);
    if (!g || !g.moved) {
      if (g?.kind === "pan") v.setSel(null);
      return;
    }
    const dx = (e.clientX - g.sx) / view.z;
    const dy = (e.clientY - g.sy) / view.z;
    if (g.kind === "card") {
      const id = g.id!;
      const x = v.byId.get(id);
      const t = v.edit ? featureZone(target(e.clientX, e.clientY, id, false)) : null;
      drag.setLive(null);
      swallowClick();
      // Edit mode: dropped on a milestone's work, a goal or its column, or a group, it moves there
      // (a commenter's becomes a suggestion, or says why and snaps back). On its own goal's card or
      // column it is only placed, as on empty canvas.
      const own = !!t && (t.startsWith("col:") || t.startsWith("goal:")) && goalOfZone(t) === x?.goal;
      if (t && !own && v.may) {
        void v.act.dropFeature(id, t);
        return;
      }
      // A card on no milestone has no place on the canvas: it snaps back.
      if (!x || x.free) return;
      const at = v.places.get(id);
      void v.act.place(id, Math.round((at?.x ?? 0) + dx), Math.round((at?.y ?? 0) + dy));
    }
    if (g.kind === "kr") {
      const id = g.id!;
      const t = target(e.clientX, e.clientY, id, false);
      drag.setLive(null);
      swallowClick();
      const goal = goalOfZone(t);
      if (!goal) return;
      if (!v.krCan(id)) return v.act.refuse("Only an owner or the roadmap's decider moves milestones");
      // Onto another milestone card: before it when dropped on its top half, else after it.
      let before: string | null = null;
      if (t?.startsWith("kr:")) {
        const on = t.slice(3);
        const el = document.querySelector(`[data-ld-ms="${CSS.escape(on)}"]`);
        const r = el?.getBoundingClientRect();
        const krs = v.ms.filter((m) => m.goal === goal && m.id !== id).map((m) => m.id);
        before = r && e.clientY < r.top + r.height / 2 ? on : (krs[krs.indexOf(on) + 1] ?? null);
      }
      void v.act.moveKr(id, goal, before);
    }
    if (g.kind === "goal") {
      const id = g.id!;
      const t = target(e.clientX, e.clientY, id, false);
      drag.setLive(null);
      swallowClick();
      const goal = goalOfZone(t);
      if (!goal || goal === id) return;
      if (!v.canChange) return v.act.refuse("Only owners and approvers change the goal order");
      void v.act.orderGoal(id, v.goals.findIndex((x) => x.id === goal));
    }
    if (g.kind === "dot") {
      setDrawing(null);
      const t = target(e.clientX, e.clientY, g.from!);
      if (t?.startsWith("card:")) void v.act.link(t.slice(5), g.from!);
      swallowClick();
    }
  };
  const wheel = (e: RWheelEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey) {
      const r = box.current!.getBoundingClientRect();
      zoomTo(view.z * (e.deltaY < 0 ? 1.1 : 0.9), e.clientX - r.left, e.clientY - r.top);
    } else setView((o) => ({ ...o, x: o.x - e.deltaX, y: o.y - e.deltaY }));
  };
  useEffect(() => {
    // The page does not scroll under the canvas while the wheel pans it.
    const el = box.current;
    if (!el) return;
    const stop = (e: WheelEvent) => e.preventDefault();
    el.addEventListener("wheel", stop, { passive: false });
    return () => el.removeEventListener("wheel", stop);
  }, []);

  // The overview: the ladder's columns, and the part of it in view.
  const OW = 112;
  const OH = 40;
  const ox = OW / (size.cw + 32);
  const oy = OH / (size.ch + 24);
  const vw = Math.min(OW, (size.w / view.z) * ox);
  const vh = Math.min(OH, (size.h / view.z) * oy);
  const vx = Math.max(0, Math.min(OW - vw, ((16 - view.x) / view.z) * ox));
  const vy = Math.max(0, Math.min(OH - vh, ((12 - view.y) / view.z) * oy));

  return (
    <>
      <div className="flex items-center justify-end gap-2">
        <div className="flex items-center gap-1 rounded-full border border-line bg-surface px-1.5 py-1 text-[14px] font-semibold shadow" data-testid="ld-zoom">
          <button type="button" aria-label="Zoom out" className="grid h-7 w-7 place-items-center rounded-full hover:bg-surface2" onClick={() => zoomTo(view.z - 0.1)}>−</button>
          <span className="px-1" data-testid="ld-zoom-level">{Math.round(view.z * 100)}%</span>
          <button type="button" aria-label="Zoom in" className="grid h-7 w-7 place-items-center rounded-full hover:bg-surface2" onClick={() => zoomTo(view.z + 0.1)}>+</button>
          <button type="button" data-testid="ld-fit" className="rounded-full px-2 hover:bg-surface2" onClick={fitAll}>Fit</button>
          {canPlace && (
            <button type="button" data-testid="ld-tidy" className="rounded-full px-2 hover:bg-surface2" title="Put every card back where the ladder places it" onClick={() => void v.act.tidy()}>
              Tidy up
            </button>
          )}
        </div>
        <button
          type="button"
          aria-label="Overview"
          data-testid="ld-overview"
          className="relative flex h-10 w-28 gap-0.5 overflow-hidden rounded-lg border border-line bg-surface p-1"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const cx = (e.clientX - r.left) / ox;
            const cy = (e.clientY - r.top) / oy;
            setView((o) => ({ ...o, x: size.w / 2 - cx * o.z + 16, y: size.h / 2 - cy * o.z + 12 }));
          }}
        >
          {v.goals.map((g) => (
            <span
              key={g.id}
              role="img"
              aria-label={`Goal ${v.goals.indexOf(g) + 1}: ${g.name}`}
              title={`Goal ${v.goals.indexOf(g) + 1}: ${g.name}`}
              data-testid="ld-overview-goal"
              className="grid min-h-3.5 flex-1 place-items-start justify-center self-start rounded-sm bg-surface2 text-[10px] leading-3 font-bold text-text2"
              style={{ height: `${Math.max(30, Math.min(100, (v.feats.filter((x) => x.goal === g.id).length + 3) * 6))}%` }}
            >
              {v.goals.indexOf(g) + 1}
            </span>
          ))}
          <span className="absolute rounded border-2 border-accent" style={{ left: vx, top: vy, width: Math.max(8, vw), height: Math.max(6, vh) }} />
        </button>
      </div>
      <div
        ref={box}
        data-testid="ld-canvas"
        className={`relative h-[560px] scroll-mb-4 touch-none overflow-hidden rounded-2xl border border-line cursor-grab active:cursor-grabbing`}
        style={{ backgroundImage: "radial-gradient(var(--color-line) 1px, transparent 1px)", backgroundSize: "18px 18px" }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={() => {
          gesture.current = null;
          drag.setLive(null);
          drag.setDrop(null);
          setDrawing(null);
        }}
        onWheel={wheel}
      >
        <div data-ld-canvas className="absolute top-0 left-0 origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
          <div ref={root} className="relative">
            <Arrows v={v} root={root} drawing={drawing} zoom={view.z} />
            <Columns v={v} />
          </div>
        </div>
      </div>
    </>
  );
}

/* ---------- phone: one goal at a time ---------- */

function Phone({ v }: { v: V }) {
  const p = useLadderProps();
  const first = Math.max(0, v.goals.findIndex((g) => g.id === p.picked));
  const [gi, setGi] = useState(first);
  // goal-map-editing: a last tab for the features serving no goal; the badge opens the first group's tab.
  const noGoal = v.feats.some((x) => !x.goal) || (v.edit && v.may);
  const { goals, flashGoal } = v;
  useEffect(() => {
    const show = () => {
      const at = goals.findIndex((x) => x.id === flashGoal);
      setGi(at < 0 ? goals.length : at);
      requestAnimationFrame(() => document.querySelector("[data-ld-free][data-flash]")?.scrollIntoView({ block: "center" }));
    };
    window.addEventListener("ld-show-loose", show);
    return () => window.removeEventListener("ld-show-loose", show);
  }, [goals, flashGoal]);
  if (noGoal && gi >= v.goals.length)
    return (
      <div className="flex flex-col gap-2" data-testid="ld-phone">
        <Tabs v={v} gi={gi} setGi={setGi} noGoal />
        <Loose v={v} goal={null} />
      </div>
    );
  const g = v.goals[Math.min(gi, v.goals.length - 1)];
  // The shown goal's next milestone.
  const next = v.ms.filter((m) => m.goal === g?.id && m.due_on && m.due_on >= v.map.today_on).sort((a, b) => a.due_on!.localeCompare(b.due_on!))[0];
  const t = new Date(`${v.map.today_on}T00:00:00Z`);
  const monday = addDays(v.map.today_on, -((t.getUTCDay() + 6) % 7));
  if (!g) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="ld-phone">
      <span className="rounded-xl bg-surface2 px-3 py-1.5 text-[14px]">
        <b>We are here: week of {day(monday)}</b>
        {next && <> · next: {v.msCode.get(next.id)} {next.name}, {day(next.due_on)}</>}
      </span>
      <Tabs v={v} gi={Math.min(gi, v.goals.length - 1)} setGi={setGi} noGoal={noGoal} />
      {/* The guardrail as one line under the goal picker (ld1-a-phone). */}
      {v.map.guardrail && (
        <span data-testid="ld-phone-guardrail" className="truncate text-[13px] leading-5 text-text2" title={`Guardrail: ${v.map.guardrail.name} ${v.map.guardrail.rule}`}>
          <Icon name="lock" size={16} className={`mr-1 inline align-[-3px] ${v.map.guardrail.held ? "text-pass" : "text-crit"}`} />
          Guardrail: {v.map.guardrail.name} {v.map.guardrail.rule} · <b className={v.map.guardrail.held ? "text-pass" : "text-crit"}>Held {v.map.guardrail.days.filter((d) => d === 0).length} of 7 days</b>
        </span>
      )}
      <GoalCard g={g} i={Math.min(gi, v.goals.length - 1)} v={v} />
      {v.ms.filter((m) => m.goal === g.id).map((m) => (
        <div key={m.id} className="flex flex-col gap-1.5 rounded-2xl bg-surface2 p-2" data-ld-group={m.id} data-testid="ld-group">
          <MilestoneCard m={m} v={v} />
          {v.feats.filter((x) => x.f.milestones[0] === m.id).map((x) => <FeatureCard key={x.f.id} x={x} v={v} ms={m.id} />)}
          {v.edit && v.may && <AddFeature m={m} v={v} />}
        </div>
      ))}
      {v.edit && v.canChange && (
        <button type="button" data-testid="ld-add-milestone" onClick={() => p.onAddMilestone(g.id)} className="rounded-xl border border-dashed border-line-strong bg-surface2 px-2.5 py-1 text-left text-[13px] font-semibold text-text2">
          + Add milestone
        </button>
      )}
      <Loose v={v} goal={g.id} />
    </div>
  );
}

/** The phone's goal picker, and No goal last when any feature serves none. */
function Tabs({ v, gi, setGi, noGoal }: { v: V; gi: number; setGi: (i: number) => void; noGoal: boolean }) {
  const tab = (on: boolean) => `shrink-0 rounded-full border px-3 py-1 text-[14px] font-semibold ${on ? "border-accent bg-accent text-on-accent" : "border-line bg-surface"}`;
  return (
    <div className="flex gap-1.5 overflow-x-auto pb-1" role="tablist">
      {v.goals.map((x, i) => (
        <button type="button" role="tab" aria-selected={i === gi} key={x.id} onClick={() => setGi(i)} className={tab(i === gi)}>
          Goal {i + 1}
        </button>
      ))}
      {noGoal && (
        <button type="button" role="tab" aria-selected={gi >= v.goals.length} onClick={() => setGi(v.goals.length)} className={tab(gi >= v.goals.length)}>
          No goal
        </button>
      )}
    </div>
  );
}

/* ---------- Move to… and Waits on…: a sheet on a phone, a dialog on a desktop ---------- */

function Sheet({ v, sheet, onClose }: { v: V; sheet: { kind: "move" | "waits" | "kr"; feature: string }; onClose: () => void }) {
  const x = v.byId.get(sheet.feature);
  const kr = sheet.kind === "kr" ? v.map.milestones.find((m) => m.id === sheet.feature) : undefined;
  // goal-map-editing: a feature's place: a milestone ("ms:<id>"), a goal's "Not on a key result" ("free:<goal>") or No goal ("free:none").
  const from = x ? (x.free ? `free:${x.goal ?? "none"}` : `ms:${x.f.milestones[0]}`) : `goal:${kr?.goal ?? ""}`;
  const [to, setTo] = useState(from);
  const [q, setQ] = useState("");
  if (!x && !kr) return null;
  const hits = x ? v.feats.filter((y) => y.f.id !== x.f.id && !x.waits.includes(y.f.id) && `${y.code} ${y.f.name}`.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8) : [];
  const radio = (value: string, label: ReactNode, key: string) => (
    <label key={key} className={`flex items-center gap-2 rounded-lg px-2 py-0.5 text-[14px] leading-[18px] ${value === to ? "bg-accent-soft font-semibold text-accent-ink" : ""}`}>
      <input type="radio" name="ld-move" checked={value === to} onChange={() => setTo(value)} />
      {label}
      {value === from ? " (now)" : ""}
    </label>
  );
  const title = kr ? `Move ${v.msCode.get(kr.id) ?? ""}` : sheet.kind === "move" ? `Move ${x!.code}` : `${x!.code} waits on`;
  return (
    <div className={`fixed inset-0 z-50 bg-black/30 ${v.phone ? "flex flex-col justify-end" : "grid place-items-center"}`} onClick={onClose}>
      <div
        role="dialog"
        aria-label={title}
        data-testid={kr ? "ld-ms-move-sheet" : sheet.kind === "move" ? "ld-move-sheet" : "ld-waits-sheet"}
        onClick={(e) => e.stopPropagation()}
        className={v.phone ? "flex max-h-[80vh] flex-col gap-2 rounded-t-2xl border-t border-line bg-surface p-4 shadow-2xl" : "flex max-h-[80vh] w-[440px] flex-col gap-2 rounded-2xl border border-line bg-surface p-4 shadow-2xl"}
      >
        <b className="text-[16px]">
          {kr ? (
            <>
              Move <span className="simple-code">{v.msCode.get(kr.id)}</span> {kr.name}
            </>
          ) : (
            <>
              {sheet.kind === "move" ? "Move " : ""}
              <span className="simple-code">{x!.code}</span> {x!.f.name}
              {sheet.kind === "waits" ? " waits on" : ""}
            </>
          )}
        </b>
        {kr ? (
          <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
            {v.goals.map((g, i) => radio(`goal:${g.id}`, <>Goal {i + 1} · {g.name}</>, g.id))}
          </div>
        ) : sheet.kind === "move" ? (
          <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
            {v.goals.map((g, i) => (
              <div key={g.id} className="flex flex-col gap-0.5">
                <span className="text-[12px] font-bold tracking-wide text-text2 uppercase">Goal {i + 1} · {g.name}</span>
                {v.ms.filter((m) => m.goal === g.id).map((m) => radio(`ms:${m.id}`, <><span className="simple-code">{v.msCode.get(m.id)}</span> {m.name}</>, m.id))}
                {radio(`free:${g.id}`, "Not on a key result", `free:${g.id}`)}
              </div>
            ))}
            {radio("free:none", "No goal", "free:none")}
          </div>
        ) : (
          <div className="flex min-h-0 flex-col gap-1 overflow-y-auto">
            <input autoFocus aria-label="Find a feature" value={q} onChange={(e) => setQ(e.target.value)} className="rounded-lg border border-accent bg-surface px-2 py-1 text-[14px]" />
            {hits.map((y) => (
              <button
                type="button"
                key={y.f.id}
                className="rounded-lg px-2 py-1 text-left text-[13px] leading-[17px] hover:bg-surface2"
                onClick={() => {
                  onClose();
                  void v.act.link(x!.f.id, y.f.id);
                }}
              >
                <span className="simple-code mr-1">{y.code}</span>
                {y.f.name}
              </button>
            ))}
          </div>
        )}
        <span className="flex justify-end gap-2 border-t border-line pt-2">
          <Btn onClick={onClose}>Cancel</Btn>
          {(kr || sheet.kind === "move") && (
            <Btn
              primary
              testId="ld-move-go"
              onClick={() => {
                onClose();
                if (to === from) return;
                if (kr) void v.act.moveKr(kr.id, to.slice(5), null);
                else void v.act.dropFeature(x!.f.id, to);
              }}
            >
              Move
            </Btn>
          )}
        </span>
      </div>
    </div>
  );
}
