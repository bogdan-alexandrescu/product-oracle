"use client";

/**
 * Simple Goal map, drawn as "Goals by tracks grid" (the owner's pick of Nov 11, proposal B): the
 * goals across as columns, each with its milestone strip under it, and the roadmap's tracks as
 * rows; each cell lists the features where that track serves that goal, as chips with their
 * milestone. A phone scrolls the grid sideways with the track names held at the left. Every chip
 * opens Simple's one feature panel; the menus rename, add, move and trash, each with Undo.
 */
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, type CSSProperties } from "react";

import { toast as dsToast, type ToastAsk } from "@/components/ds";
import { Icon } from "@/components/ds/Icon";
import { InfoTip } from "@/components/ds/InfoTip";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import type { GmFeature, GmGoal, GmMilestone, GoalMap } from "@/lib/api/mock/goal-map";
import { formatCount } from "@/lib/format";
import { joinTwins } from "@/lib/goal-map-twins";
import { keyResults, type KeyResults } from "@/lib/key-results";
import { errorMessage, useQuery } from "@/lib/use-query";

import { propose, resultWords, undo, type ChangeResult } from "../roadmap/_lib";
import { FeaturePanel, type Placement } from "./_panel";

const toast = (ask: ToastAsk) => dsToast({ place: "corner", ...ask });

type M = GmMilestone;
/** A key result of a goal on the map, shown behind its goal's (i). */
type KrLine = { id: string; code: string | null; name: string };

const TRACK_COLORS = ["#3b82f6", "#0d9488", "#8b5cf6", "#d97706", "#db2777", "#64748b"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (iso: string | null | undefined) => (iso ? `${MON[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}` : "");
const STATUS: Record<string, [string, string]> = {
  met: ["Met", "bg-pass-bg text-pass"],
  on_track: ["On track", "bg-accent-soft text-accent-ink"],
  at_risk: ["At risk", "bg-warn-bg text-warn"],
  missed: ["Missed", "bg-crit-bg text-crit"],
  not_measured: ["Not measured", "bg-na-bg text-na"],
  no_gate: ["No gate", "bg-na-bg text-na"],
};

function num(v: number | null, unit: string): string {
  if (v === null) return "—";
  if (unit === "$") return v >= 1000 ? `$${formatCount(Math.round(v / 100) / 10)}k` : `$${formatCount(v)}`;
  return formatCount(Math.round(v * 10) / 10);
}
const progress = (g: GmGoal) => (g.current === null ? 0 : g.target === 0 ? (g.current <= 0 ? 1 : 1 / (1 + g.current)) : Math.min(1, g.current / g.target));
const byDate = (a: M, b: M) => (a.due_on ?? "9999").localeCompare(b.due_on ?? "9999");

/** One feature in the grid: on a milestone (a map feature) or on its goal only (unplaced). */
interface Chip {
  id: string;
  name: string;
  /** Its map feature (null: on no milestone). */
  f: GmFeature | null;
  m: M | null;
  goal: string;
  /** Its roadmap track (null: none). */
  track: string | null;
  done: boolean;
  lift: GmFeature["lift"];
}

function fstate(c: Chip): { w: string; mark: string; cls: string } {
  if (!c.done) return { w: "Planned", mark: "", cls: "text-text2" };
  return c.lift === "not_helping" ? { w: "Not helping yet", mark: "⚠", cls: "text-warn" } : { w: "Shipped", mark: "✓", cls: "text-pass" };
}

/**
 * kr-in-goal-map: the map as Simple shows it. Only top-level goals are goals; a key result (a
 * subgoal of a goal on the map) shows behind its goal's (i), and its milestones and work sit
 * under that goal.
 */
function withKeyResults(raw: GoalMap, krs: KeyResults): { map: GoalMap; lines: Map<string, KrLine[]>; top: (id: string | null) => string | null } {
  const onMap = new Set(raw.goals.map((g) => g.id));
  const top = (id: string | null) => {
    const p = krs.parentOf(id);
    return p && onMap.has(p.id) ? p.id : id;
  };
  const goals = raw.goals.filter((g) => top(g.id) === g.id);
  const lines = new Map(goals.map((g) => [g.id, krs.of(g.id).map((k): KrLine => ({ id: k.id, code: k.code, name: k.name }))]));
  return {
    map: {
      ...raw,
      goals,
      milestones: raw.milestones.map((m) => (top(m.goal) === m.goal ? m : { ...m, goal: top(m.goal)! })),
      unplaced: raw.unplaced.map((u) => (top(u.goal ?? null) === (u.goal ?? null) ? u : { ...u, goal: top(u.goal ?? null) })),
      off_map: raw.off_map.filter((g) => top(g.id) === g.id),
    },
    lines,
    top,
  };
}

/** The goal and milestone (with its roadmap code) a feature sits under, for its panel. */
function placement(map: GoalMap, feature: string, codes: Map<string, string>): Placement | null {
  const m = map.milestones.find((x) => x.id === map.features.find((f) => f.id === feature)?.milestones[0]);
  const gi = map.goals.findIndex((g) => g.id === m?.goal);
  const g = map.goals[gi];
  if (!m || !g) return null;
  return { goal: { id: g.id, title: g.name, metric: g.metric?.title ?? null, target: num(g.target, g.unit), position: gi + 1 }, milestone: `${codes.get(m.id) ?? ""} ${m.name}`.trim() };
}

/** After an edit, brings what changed into view. */
function reveal(sel: string, block: ScrollLogicalPosition = "center") {
  setTimeout(() => document.querySelector(sel)?.scrollIntoView({ block, inline: "nearest" }), 50);
}

/* ---------- Shared pieces ---------- */

interface Track {
  id: string | null;
  name: string;
  color: string;
}

interface Ctx {
  map: GoalMap;
  codes: Map<string, string>;
  mcode: Map<string, string>;
  tracks: Track[];
  onOpen: (c: Chip) => void;
  menu: string | null;
  setMenu: (k: string | null) => void;
  setMover: (c: Chip | null) => void;
  renaming: string | null;
  setRenaming: (k: string | null) => void;
  moved: string | null;
  act: ReturnType<typeof useActs>;
  onAttach: (milestone: string) => void;
  /** Each PRD milestone's PRD: its menu opens it (never Trash). */
  prdOf: Map<string, NonNullable<Schemas["SimpleGoalMilestone"]["prd"]>>;
  go: (href: string) => void;
}

const mWords = (m: M, c: { mcode: Map<string, string> }) => `${c.mcode.get(m.id) ?? ""} ${m.name}`.trim();

function Status({ s }: { s: string }) {
  const [w, cls] = STATUS[s] ?? STATUS.not_measured;
  return <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[13px] font-semibold ${cls}`}>{w}</span>;
}

function Bar({ g }: { g: GmGoal }) {
  const p = progress(g);
  const tone = g.status === "at_risk" ? "bg-warn" : g.status === "missed" ? "bg-crit" : g.status === "met" ? "bg-pass" : "bg-accent";
  return (
    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-surface2" role="img" aria-label={`${num(g.current, g.unit)} now, aiming at ${num(g.target, g.unit)}`}>
      <span className={`block h-full rounded-full ${tone}`} style={{ width: `${Math.max(4, p * 100)}%` }} />
    </span>
  );
}

function GoalInfo({ g, krs }: { g: GmGoal; krs: KrLine[] }) {
  return (
    <InfoTip label={g.name} testId={`gm-goal-info-${g.id}`}>
      <span className="flex flex-col gap-1">
        <b>Measured as {g.measure}</b>
        <span>{krs.length ? krs.map((k) => `${k.code ? `${k.code} ` : ""}${k.name}`).join(" · ") : g.math.replace(/^Key results: /, "")}</span>
        {g.read_on && <span>Read on {g.read_on}</span>}
      </span>
    </InfoTip>
  );
}

function Menu({ k, label, items, c }: { k: string; label: string; items: { w: string; on: () => void; crit?: boolean }[]; c: Ctx }) {
  const open = c.menu === k;
  return (
    <span className="relative inline-flex">
      <button type="button" aria-label={`More for ${label}`} aria-expanded={open} data-testid={`gm-menu-${k}`} onClick={(e) => (e.stopPropagation(), c.setMenu(open ? null : k))} className={`rounded-md px-1 leading-none text-text2 hover:bg-surface2 ${open ? "bg-surface2" : ""}`}>
        <Icon name="more" size={16} />
      </button>
      {open && (
        <span role="menu" className="absolute top-full right-0 z-30 mt-1 flex w-max min-w-[180px] flex-col rounded-xl border border-line bg-surface py-1 text-[14px] shadow-lg">
          {items.map((it) => (
            <button key={it.w} type="button" role="menuitem" onClick={(e) => (e.stopPropagation(), c.setMenu(null), it.on())} className={`px-3 py-1.5 text-left hover:bg-surface2 ${it.crit ? "text-crit" : ""}`}>
              {it.w}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

function featureMenu(f: Chip, c: Ctx) {
  const name = `${c.codes.get(f.id) ?? ""} ${f.name}`.trim();
  return (
    <Menu
      k={`f-${f.id}`}
      label={name}
      c={c}
      items={[{ w: "Open", on: () => c.onOpen(f) }, ...(c.map.can_edit ? [{ w: "Move to…", on: () => c.setMover(f) }, { w: "Move to Trash", on: () => void c.act.trashFeature(f), crit: true }] : [])]}
    />
  );
}

function milestoneMenu(m: M, c: Ctx) {
  if (!m.can_change) return null;
  const prd = c.prdOf.get(m.id);
  const items = [
    { w: "Rename", on: () => c.setRenaming(m.id) },
    { w: "Add a feature", on: () => c.onAttach(m.id) },
    prd ? { w: `Open ${prd.title}`, on: () => c.go(`/simple/one-pagers/${prd.slug}`) } : { w: "Move to Trash", on: () => void c.act.trashMilestone(m), crit: true },
  ];
  return <Menu k={`m-${m.id}`} label={mWords(m, c)} c={c} items={items} />;
}

function goalMenu(g: GmGoal, ms: M[], c: Ctx) {
  if (!c.map.can_edit) return null;
  const next = ms.find((m) => m.status !== "met") ?? ms[0];
  return <Menu k={`g-${g.id}`} label={g.name} c={c} items={[{ w: "Rename", on: () => c.setRenaming(g.id) }, ...(next ? [{ w: "Add a feature", on: () => c.onAttach(next.id) }] : [])]} />;
}

function Rename({ id, was, c, className }: { id: string; was: string; c: Ctx; className?: string }) {
  const [v, setV] = useState(was);
  const done = (save: boolean) => {
    c.setRenaming(null);
    if (save && v.trim() && v.trim() !== was) void c.act.rename(id, v.trim(), was);
  };
  return (
    <input
      autoFocus
      aria-label={`Rename ${was}`}
      data-testid="gm-rename"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => done(true)}
      onKeyDown={(e) => (e.key === "Enter" ? done(true) : e.key === "Escape" ? done(false) : null)}
      onClick={(e) => e.stopPropagation()}
      className={`min-w-0 rounded-md border border-accent bg-surface px-1.5 py-0.5 font-semibold outline-none ring-2 ring-accent/30 ${className ?? ""}`}
    />
  );
}

/** A feature's status mark; its ⋯ menu takes the same place on hover or focus. */
function Slot({ f, c }: { f: Chip; c: Ctx }) {
  const s = fstate(f);
  return (
    <span className="flex w-6 shrink-0 justify-center max-[600px]:w-auto max-[600px]:gap-1">
      <span className={`flex text-[12px] group-hover:hidden group-focus-within:hidden group-has-[[aria-expanded=true]]:hidden max-[600px]:flex! ${s.cls}`} title={s.w}>
        {s.mark || <span className="m-1 size-2 rounded-full border border-text-faint" />}
      </span>
      {/* A phone has no hover: its ⋯ stays beside the mark. */}
      <span className="hidden group-hover:inline-flex group-focus-within:inline-flex group-has-[[aria-expanded=true]]:inline-flex max-[600px]:inline-flex">{featureMenu(f, c)}</span>
    </span>
  );
}

function Legend({ tracks }: { tracks: Track[] }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5" data-testid="gm-legend">
      {tracks.map((t) => (
        <span key={t.id ?? "none"} className="flex items-center gap-1.5 px-1 text-[13px]">
          <span className="size-2.5 rounded-full" style={{ background: t.color }} />
          {t.name}
        </span>
      ))}
    </span>
  );
}

/* ---------- The actions (the API's own routes, each with Undo) ---------- */

function useActs(map: GoalMap, setMap: (m: GoalMap) => void, reload: () => Promise<unknown>, codes: Map<string, string>, mcode: Map<string, string>, tracks: Track[], setMoved: (id: string | null) => void) {
  const named = (f: Chip) => `${codes.get(f.id) ?? ""} ${f.name}`.trim();
  const msWords = (id: string | null) => {
    const m = map.milestones.find((x) => x.id === id);
    return m ? mWords(m, { mcode }) : "No milestone";
  };
  const failed = (e: unknown) => toast({ message: errorMessage(e) });
  // A feature on no milestone is attached (filed under its own area, else the map's first).
  const moveRaw = async (f: Chip, from: string | null, to: string | null): Promise<GoalMap | null> => {
    if (from && to) return unwrap(api.POST("/v1/simple/goal-map/links/move", { body: { feature: f.id, from_milestone: from, to_milestone: to } }));
    if (!from && to) return unwrap(api.POST("/v1/simple/goal-map/links", { body: { feature: f.id, milestone: to, area: f.f?.area ?? map.areas[0]?.id ?? "", expected: "", confidence: "medium" } }));
    if (from && !to) return unwrap(api.POST("/v1/simple/goal-map/links/detach", { body: { feature: f.id, milestone: from } }));
    return null;
  };
  /** A change through the change engine: applied (with Undo), else what it waits for. */
  const change = async (r: ChangeResult, words: string, back: string) => {
    await reload();
    if (r.change.status !== "applied") return toast({ message: resultWords(r, words) });
    toast({ message: words, action: { label: "Undo", onClick: () => void undo(r.change.id).then(reload).then(() => toast({ message: back }), failed) } });
  };
  return {
    move: async (f: Chip, to: string | null) => {
      const from = f.m?.id ?? null;
      try {
        const next = await moveRaw(f, from, to);
        if (!next) return;
        setMap(next);
        setMoved(f.id);
        reveal(`[data-testid="gm-chip"][data-feature="${f.id}"]`);
        const toGoal = map.goals.find((g) => g.id === map.milestones.find((m) => m.id === to)?.goal);
        toast({
          message: `Moved ${named(f)} to ${msWords(to)}${toGoal && toGoal.id !== f.goal ? ` (${toGoal.name})` : ""}`,
          action: { label: "Undo", onClick: () => void moveRaw({ ...f, m: map.milestones.find((m) => m.id === to) ?? null }, to, from).then((m) => m && setMap(m), failed) },
        });
      } catch (e) {
        failed(e);
      }
    },
    track: async (f: Chip, to: string | null) => {
      const name = (id: string | null) => tracks.find((t) => t.id === id)?.name ?? "No track";
      try {
        const r = await propose({ op: "set_track", target: { item_id: f.id }, before: { track_id: f.track }, after: { track_id: to } });
        setMoved(f.id);
        await change(r, `Moved ${named(f)} to ${name(to)}`, `Moved ${named(f)} back to ${name(f.track)}`);
      } catch (e) {
        failed(e);
      }
    },
    rename: async (id: string, name: string, was: string) => {
      const m = map.milestones.find((x) => x.id === id);
      // A goal's name through its goal bucket, its measure, target and date as they are.
      const goalTo = async (title: string, seen: string) => {
        const b = (await unwrap(api.GET("/v1/simple/goal-buckets"))).goals.find((x) => x.id === id);
        if (!b) throw new Error(`${seen} is not a goal you can rename here`);
        return unwrap(api.PATCH("/v1/simple/goal-buckets/goals/{goal_id}", { params: { path: { goal_id: id } }, body: { title, measure: b.measure ?? "", target: b.target ?? "", due: b.due ?? "", seen: { title: seen, measure: b.measure ?? null, target: b.target ?? null, due: b.due ?? null } } }));
      };
      const msTo = (n: string) => unwrap(api.PATCH("/v1/simple/roadmap/milestones/{milestone_id}", { params: { path: { milestone_id: id } }, body: { name: n } }));
      try {
        if (m) await msTo(name);
        else await goalTo(name, was);
        await reload();
        toast({ message: `Renamed ${was} to ${name}`, action: { label: "Undo", onClick: () => void (m ? msTo(was) : goalTo(was, name)).then(reload, failed) } });
      } catch (e) {
        failed(e);
      }
    },
    trashFeature: async (f: Chip) => {
      try {
        const r = await propose({ op: "delete_item", target: { item_id: f.id }, before: { deleted: false }, after: { deleted: true } });
        await change(r, `Moved ${named(f)} to Trash`, `Put back ${named(f)}`);
      } catch (e) {
        failed(e);
      }
    },
    trashMilestone: async (m: M) => {
      try {
        await unwrap(api.DELETE("/v1/simple/roadmap/milestones/{milestone_id}", { params: { path: { milestone_id: m.id } } }));
        await reload();
        toast({ message: `Moved ${mWords(m, { mcode })} to Trash`, action: { label: "Undo", onClick: () => void unwrap(api.POST("/v1/simple/roadmap/milestones/{milestone_id}/restore", { params: { path: { milestone_id: m.id } } })).then(reload, failed) } });
      } catch (e) {
        failed(e);
      }
    },
  };
}

/** Move to…: every goal's milestones by date, its own goal's No milestone, and the tracks. */
function MovePicker({ f, c, onClose }: { f: Chip; c: Ctx; onClose: () => void }) {
  const at = f.m?.id ?? null;
  const pick = (to: string | null) => {
    onClose();
    void c.act.move(f, to);
  };
  const row = "flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[14px] hover:bg-accent-soft disabled:opacity-60 disabled:hover:bg-transparent";
  const head = "px-2 pt-1 text-[12px] font-semibold tracking-wide text-text2 uppercase";
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/20 pt-[10vh] max-[600px]:items-end max-[600px]:pt-0" onClick={onClose}>
      <div role="dialog" aria-label={`Move ${c.codes.get(f.id) ?? ""} ${f.name}`} data-testid="gm-mover" onClick={(e) => e.stopPropagation()} className="simple-card w-[720px] max-w-full gap-2 max-[600px]:rounded-b-none">
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate text-[17px] font-semibold">
            Move {c.codes.get(f.id) && <span className="text-text-faint">{c.codes.get(f.id)} </span>}
            {f.name}
          </h2>
          <button type="button" aria-label="Close" onClick={onClose} className="rounded-full p-1 hover:bg-surface2">
            <Icon name="x" />
          </button>
        </div>
        <div className="grid max-h-[70vh] grid-cols-2 gap-x-4 gap-y-2 overflow-y-auto max-[600px]:grid-cols-1">
          {c.map.goals.map((g) => {
            const own = g.id === f.goal;
            return (
              <div key={g.id} className="flex flex-col">
                <span className={head}>{g.name}</span>
                {[...c.map.milestones.filter((m) => m.goal === g.id).sort(byDate), ...(own ? [null] : [])].map((m) => {
                  const here = own && (m?.id ?? null) === at;
                  return (
                    <button key={m?.id ?? "none"} type="button" disabled={here} data-to={m?.id ?? "none"} onClick={() => pick(m?.id ?? null)} className={row}>
                      {m ? (
                        <>
                          <span className="font-semibold text-accent-ink">{c.mcode.get(m.id)}</span>
                          <span className="flex-1 truncate" title={m.name}>{m.name}</span>
                          <span className="text-[12px] text-text2">{day(m.due_on)}</span>
                        </>
                      ) : (
                        <span className="flex-1">No milestone</span>
                      )}
                      {here && <span className="text-[12px] text-text2">✓ Here now</span>}
                    </button>
                  );
                })}
              </div>
            );
          })}
          <div className="flex flex-col" data-testid="gm-mover-tracks">
            <span className={head}>Tracks</span>
            {c.tracks.map((t) => {
              const here = t.id === f.track;
              return (
                <button
                  key={t.id ?? "none"}
                  type="button"
                  disabled={here}
                  data-to-track={t.id ?? "none"}
                  onClick={() => {
                    onClose();
                    void c.act.track(f, t.id);
                  }}
                  className={row}
                >
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: t.color }} />
                  <span className="flex-1 truncate">{t.name}</span>
                  {here && <span className="text-[12px] text-text2">✓ Here now</span>}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- The grid ---------- */

function TracksGrid({ chips, lines, c }: { chips: Chip[]; lines: Map<string, KrLine[]>; c: Ctx }) {
  const goals = c.map.goals;
  const all = [...c.map.milestones].sort(byDate);
  const order = new Map(all.map((m, i) => [m.id, i]));
  // A cell's chips in milestone order (No milestone last), so a moved chip lands in its place.
  const inOrder = (xs: Chip[]) => [...xs].sort((a, b) => (a.m ? order.get(a.m.id)! : all.length) - (b.m ? order.get(b.m.id)! : all.length));
  const n = goals.length;
  return (
    <div className="flex flex-col gap-3 overflow-x-auto" data-testid="gm-grid">
      <div className="grid min-w-[1000px] grid-cols-[150px_repeat(var(--gm-n),minmax(0,1fr))] gap-x-3 max-[600px]:grid-cols-[96px_repeat(var(--gm-n),220px)]" style={{ "--gm-n": n } as CSSProperties}>
        <span />
        {goals.map((g) => (
          <div key={g.id} data-goal={g.id} data-testid="gm-goal" className="group flex flex-col gap-1 rounded-2xl border border-line bg-surface p-3">
            <div className="flex items-center gap-2">
              <span className="text-[24px] leading-none font-bold">{num(g.target, g.unit)}</span>
              <span className="ml-auto flex items-center gap-1">
                <Status s={g.status} />
                <GoalInfo g={g} krs={lines.get(g.id) ?? []} />
                {goalMenu(
                  g,
                  all.filter((m) => m.goal === g.id),
                  c,
                )}
              </span>
            </div>
            {c.renaming === g.id ? (
              <Rename id={g.id} was={g.name} c={c} className="text-[16px]" />
            ) : (
              <span className="line-clamp-2 min-h-[2.5em] text-[16px] leading-[1.25] font-semibold" title={g.name}>
                {g.name}
              </span>
            )}
            <Bar g={g} />
          </div>
        ))}
        <span className="pt-2 text-[12px] font-semibold text-text2 uppercase max-[600px]:sticky max-[600px]:left-0 max-[600px]:z-10 max-[600px]:bg-bg">Milestones</span>
        {/* The milestone strip: by date across the goals, each under the goal it measures. */}
        <div className="col-span-(--gm-n) grid grid-cols-[repeat(var(--gm-n),minmax(0,1fr))] gap-x-3 pt-2 max-[600px]:grid-cols-[repeat(var(--gm-n),220px)]" data-testid="gm-strip">
          {goals.map((g) => (
            <div key={g.id} className="flex flex-wrap content-start items-start gap-1 border-t-4 pt-1.5" style={{ borderColor: "var(--accent-mid)" }}>
              {all
                .filter((m) => m.goal === g.id)
                .map((m) => (
                  <span key={m.id} data-milestone={m.id} data-testid="gm-strip-milestone" className="group flex max-w-full items-center gap-1 rounded-md bg-surface2 px-1.5 py-0.5 text-[12px]">
                    <b className="text-accent-ink">{c.mcode.get(m.id)}</b>
                    {c.renaming === m.id ? <Rename id={m.id} was={m.name} c={c} className="text-[12px]" /> : <span className="truncate" title={m.name}>{m.name}</span>}
                    <span className="whitespace-nowrap text-text2">{day(m.due_on)}</span>
                    <span className="hidden group-hover:inline-flex has-[[aria-expanded=true]]:inline-flex max-[600px]:inline-flex">{milestoneMenu(m, c)}</span>
                  </span>
                ))}
            </div>
          ))}
        </div>
        {c.tracks.map((t) => (
          <div key={t.id ?? "none"} className="contents">
            <span className="flex items-start gap-1.5 border-t border-line pt-2 text-[14px] font-semibold max-[600px]:sticky max-[600px]:left-0 max-[600px]:z-10 max-[600px]:bg-bg" data-testid="gm-track" data-track={t.id ?? "none"}>
              <span className="mt-1.5 size-2.5 shrink-0 rounded-full" style={{ background: t.color }} />
              {t.name}
            </span>
            {goals.map((g) => (
              <ul key={g.id} className="flex min-h-10 flex-col gap-1 border-t border-line py-1.5" data-testid="gm-cell" data-track={t.id ?? "none"} data-goal={g.id}>
                {inOrder(chips.filter((f) => f.goal === g.id && f.track === t.id)).map((f) => (
                  <li
                    key={f.id}
                    data-testid="gm-chip"
                    data-feature={f.id}
                    data-track={t.id ?? "none"}
                    data-moved={c.moved === f.id ? "1" : undefined}
                    className={`group flex items-center gap-1 rounded-lg border bg-surface px-2 py-0.5 text-[13px] leading-[17px] ${c.moved === f.id ? "border-accent bg-accent-soft ring-2 ring-accent" : "border-line"}`}
                    style={{ borderLeft: `3px solid ${t.color}` }}
                  >
                    <button type="button" onClick={() => c.onOpen(f)} className="min-w-0 flex-1 text-left">
                      <span className="block truncate hover:underline" title={`${c.codes.get(f.id) ?? ""} ${f.name}`.trim()}>
                        {c.codes.get(f.id) && <span className="mr-1 text-[11.5px] text-text-faint">{c.codes.get(f.id)}</span>}
                        {f.name}
                      </span>
                      <span className="block truncate text-[11.5px] text-text2" title={f.m ? mWords(f.m, c) : undefined}>
                        {f.m ? mWords(f.m, c) : "No milestone"}
                      </span>
                    </button>
                    <Slot f={f} c={c} />
                  </li>
                ))}
              </ul>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- Add a feature ---------- */

function AttachDrawer({ map, milestone, codes, mcode, onClose, onSave }: { map: GoalMap; milestone: string; codes: Map<string, string>; mcode: Map<string, string>; onClose: () => void; onSave: (feature: string, milestone: string, expected: string) => void }) {
  const roadmap = useQuery("simple-roadmap:goal-map", () => unwrap(api.GET("/v1/simple/roadmap", { params: { query: {} } })));
  const [m, setM] = useState(milestone);
  const [search, setSearch] = useState("");
  const [feature, setFeature] = useState("");
  const [expected, setExpected] = useState("");
  const label = "flex flex-col gap-1.5 font-semibold";
  const field = "w-full rounded-xl border border-line-strong bg-surface px-3 py-2 text-[17px]";
  const on = new Map(map.features.map((f) => [f.id, f]));
  const term = search.toLowerCase();
  const named = (roadmap.data?.items ?? []).map((i) => ({ id: i.id, code: codes.get(i.id) ?? i.code ?? "", name: on.get(i.id)?.name ?? i.title }));
  const list = named.filter((i) => !on.get(i.id)?.milestones.includes(m) && (!term || `${i.code} ${i.name}`.toLowerCase().includes(term)));
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/20 max-[600px]:items-end">
      <div role="dialog" aria-label="Add a feature" data-testid="gm-editor" className="simple-card m-3 w-[460px] max-w-[calc(100vw-24px)] overflow-y-auto max-[600px]:m-0 max-[600px]:max-h-[85vh] max-[600px]:w-full max-[600px]:max-w-full max-[600px]:rounded-b-none">
        <div className="flex items-center justify-between gap-2">
          <h2 className="simple-h2">Add a feature</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="rounded-full p-1 hover:bg-surface2">
            <Icon name="x" />
          </button>
        </div>
        <label className={label}>
          Milestone
          <select className={field} value={m} onChange={(e) => setM(e.target.value)}>
            {[...map.milestones].sort(byDate).map((x) => (
              <option key={x.id} value={x.id}>
                {mWords(x, { mcode })}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          Feature
          <input className={field} value={search} placeholder="Search the roadmap" onChange={(e) => setSearch(e.target.value)} />
        </label>
        <ul className="flex max-h-72 flex-col gap-1.5 overflow-y-auto" data-testid="gm-attach-list">
          {!roadmap.data && <li className="simple-small">{roadmap.error ? errorMessage(roadmap.error) : "Loading the roadmap…"}</li>}
          {list.map((i) => (
            <li key={i.id}>
              <button type="button" onClick={() => setFeature(i.id)} className={`w-full rounded-xl border px-3 py-2 text-left font-semibold ${feature === i.id ? "border-accent bg-accent-soft" : "border-line"}`}>
                {i.code && <span className="simple-code mr-1">{i.code}</span>}
                {i.name}
              </button>
            </li>
          ))}
        </ul>
        <label className={label}>
          Expected lift here
          <input className={field} value={expected} placeholder="For example +5 a day" onChange={(e) => setExpected(e.target.value)} />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-full border border-line bg-surface px-4 py-1.5 text-[15px] font-semibold hover:bg-surface2">
            Cancel
          </button>
          <button type="button" data-testid="gm-save" disabled={!feature || !m} onClick={() => onSave(feature, m, expected)} className="rounded-full border border-accent bg-accent px-4 py-1.5 text-[15px] font-semibold text-on-accent disabled:opacity-40">
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- The page ---------- */

function Guardrail({ map }: { map: GoalMap }) {
  const g = map.guardrail;
  if (!g) return null;
  return (
    <div data-testid="gm-guardrail" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border border-pass/40 bg-pass-bg px-4 py-2.5">
      <Icon name="lock" size={18} className="text-pass" />
      <span className="font-semibold">Guardrail: {g.name} {g.rule}</span>
      <span className={`ml-auto font-semibold ${g.held ? "text-pass" : "text-crit"}`} title={`Every milestone must hold it. ${g.current === null ? "Not measured today" : `${num(g.current, "")} today`}`}>
        Held {g.days.filter((v) => v === 0).length} of 7 days
      </span>
    </div>
  );
}

export function GoalMapPage() {
  const q = useQuery("simple-goal-map", () => unwrap(api.GET("/v1/simple/goal-map")));
  // kr-in-goal-map: the goals' parents, read before the map is drawn so no key result shows as a goal.
  const goalList = useQuery("simple-goal-map-goal-tree", () => unwrap(api.GET("/v1/baseline/entities", { params: { query: { type: "goal" } } })));
  const krs = useMemo(() => keyResults(goalList.data ?? []), [goalList.data]);
  const folded = useMemo(() => (q.data && (goalList.data || goalList.error) ? withKeyResults(q.data, krs) : null), [q.data, goalList.data, goalList.error, krs]);
  // The roadmap read: each feature's code and track, the tracks in order, each milestone's code.
  const roadmap = useQuery("simple-roadmap:goal-map", () => unwrap(api.GET("/v1/simple/roadmap", { params: { query: {} } })));
  // Goal map twins: a PRD's milestone coded as a goal's own one is drawn once, as the goal's.
  const map = useMemo(() => (folded ? joinTwins(folded.map, roadmap.data?.goal_milestones).map : undefined), [folded, roadmap.data]);
  const prdOf = useMemo(() => new Map((roadmap.data?.goal_milestones ?? []).flatMap((m) => (m.prd ? [[m.id, m.prd] as const] : []))), [roadmap.data]);
  const router = useRouter();
  const refresh = () => Promise.all([q.reload(), goalList.reload(), roadmap.reload()]);
  const codes = useMemo(() => new Map((roadmap.data?.items ?? []).flatMap((i) => (i.code ? [[i.id, i.code] as [string, string]] : []))), [roadmap.data]);
  const mcode = useMemo(() => new Map((roadmap.data?.goal_milestones ?? []).flatMap((m) => (m.roadmap_code ? [[m.id, m.roadmap_code] as [string, string]] : []))), [roadmap.data]);
  const trackOf = useMemo(() => new Map((roadmap.data?.items ?? []).map((i) => [i.id, i.track?.id ?? null])), [roadmap.data]);
  const doneOf = useMemo(() => new Set((roadmap.data?.items ?? []).filter((i) => i.status === "done").map((i) => i.id)), [roadmap.data]);
  const [menu, setMenu] = useState<string | null>(null);
  const [mover, setMover] = useState<Chip | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [moved, setMoved] = useState<string | null>(null);
  const [panel, setPanel] = useState<Chip | null>(null);
  const [attach, setAttach] = useState<string | null>(null);
  // goal-map-scoreboard: a Home goal card opens the map on its goal (by id; else by its name).
  const params = useSearchParams();
  const asked = folded?.top(params.get("goal")) ?? params.get("goal");
  const askedName = params.get("name");
  const picked = map?.goals.find((g) => g.id === asked)?.id ?? map?.goals.find((g) => !!askedName && g.name.toLowerCase() === askedName.toLowerCase())?.id ?? null;
  // A goal left off the map (no number to aim at): a line names it and why, never the top in silence.
  const off = map && asked && !picked ? (map.off_map.find((g) => g.id === asked) ?? (askedName ? { id: asked, key: asked, name: askedName } : null)) : null;
  const offId = off?.id ?? null;
  useEffect(() => {
    if (picked) reveal(`[data-testid="gm-goal"][data-goal="${picked}"]`, "start");
    else if (offId) reveal(`[data-testid="gm-off-map"]`);
  }, [picked, offId]);

  const chips = useMemo((): Chip[] => {
    if (!map) return [];
    const ms = new Map(map.milestones.map((m) => [m.id, m]));
    const goals = new Set(map.goals.map((g) => g.id));
    const placed = map.features.flatMap((f): Chip[] => {
      const m = ms.get(f.milestones[0] ?? "") ?? null;
      return m && goals.has(m.goal) ? [{ id: f.id, name: f.name, f, m, goal: m.goal, track: trackOf.get(f.id) ?? null, done: f.released, lift: f.lift }] : [];
    });
    const on = new Set(placed.map((c) => c.id));
    const loose = map.unplaced.flatMap((u): Chip[] => (u.goal && goals.has(u.goal) && !on.has(u.id) ? [{ id: u.id, name: u.name, f: null, m: null, goal: u.goal, track: trackOf.get(u.id) ?? null, done: doneOf.has(u.id), lift: "not_measured" }] : []));
    return [...placed, ...loose];
  }, [map, trackOf, doneOf]);
  const tracks = useMemo((): Track[] => {
    const rows: Track[] = [...(roadmap.data?.tracks ?? [])].map((t, i) => ({ id: t.id, name: t.title, color: TRACK_COLORS[Math.min(i, TRACK_COLORS.length - 2)] }));
    const known = new Set(rows.map((t) => t.id));
    // A track a feature names that the list lacks still gets its row; features with none get No track.
    for (const i of roadmap.data?.items ?? []) {
      if (!i.track || known.has(i.track.id) || !chips.some((c) => c.track === i.track!.id)) continue;
      known.add(i.track.id);
      rows.push({ id: i.track.id, name: i.track.title, color: TRACK_COLORS[Math.min(rows.length, TRACK_COLORS.length - 2)] });
    }
    if (chips.some((c) => c.track === null)) rows.push({ id: null, name: "No track", color: TRACK_COLORS[TRACK_COLORS.length - 1] });
    return rows;
  }, [roadmap.data, chips]);
  const act = useActs(map ?? (q.data as GoalMap), (m) => q.setData(() => m), refresh, codes, mcode, tracks, setMoved);

  if (!map || !roadmap.data) return <div className="simple-page" role="status">{q.error ? errorMessage(q.error) : roadmap.error ? errorMessage(roadmap.error) : "Loading the goal map…"}</div>;

  const c: Ctx = { map, codes, mcode, tracks, onOpen: setPanel, menu, setMenu, setMover, renaming, setRenaming, moved, act, onAttach: setAttach, prdOf, go: (href) => router.push(href) };
  const add = async (feature: string, milestone: string, expected: string) => {
    const f = map.features.find((x) => x.id === feature);
    try {
      const next = await unwrap(api.POST("/v1/simple/goal-map/links", { body: { feature, milestone, area: f?.area ?? map.areas[0]?.id ?? "", expected, confidence: "medium" } }));
      q.setData(() => next);
      setAttach(null);
      setMoved(feature);
      reveal(`[data-testid="gm-chip"][data-feature="${feature}"]`);
    } catch (e) {
      toast({ message: errorMessage(e) });
    }
  };

  return (
    <div className="simple-page" data-testid="gm-page" style={{ maxWidth: "none" }}>
      <div className="flex flex-col gap-4" onClick={() => menu && setMenu(null)}>
        <div className="flex flex-wrap items-end gap-3">
          <h1 className="simple-h1 max-[600px]:sr-only">Goal map</h1>
          <span className="ml-auto">
            <Legend tracks={tracks} />
          </span>
        </div>
        {off && (
          <p data-testid="gm-off-map" className="simple-small flex flex-wrap items-center gap-x-2 rounded-xl border border-line px-3 py-1.5">
            <span>
              Not on the map yet: <b className="font-semibold text-text">{off.name}</b> has no number to aim at.
            </span>
            <Link href={`/simple/priorities?goal=${encodeURIComponent(off.key)}&name=${encodeURIComponent(off.name)}`} className="font-semibold text-accent-ink hover:underline">
              Open the goal
            </Link>
          </p>
        )}
        <Guardrail map={map} />
        <TracksGrid chips={chips} lines={folded?.lines ?? new Map()} c={c} />
        {mover && <MovePicker f={mover} c={c} onClose={() => setMover(null)} />}
      </div>
      {attach && <AttachDrawer map={map} milestone={attach} codes={codes} mcode={mcode} onClose={() => setAttach(null)} onSave={(f, m, e) => void add(f, m, e)} />}
      {panel && (
        <FeaturePanel
          id={panel.id}
          code={codes.get(panel.id)}
          name={panel.name}
          placed={placement(map, panel.id, mcode)}
          onClose={() => {
            setPanel(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

