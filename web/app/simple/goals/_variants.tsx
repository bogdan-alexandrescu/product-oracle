"use client";

// MOCK-HOOK (whole file): goal-map-v2 mock-ups only. Four proposals for a calmer Goal map,
// switched by ?gm=a|b|c|d on /simple/goals. Every feature opens the one FeaturePanel (onOpen).
import { useEffect, useMemo, useState, type PointerEvent as RPointerEvent, type ReactNode } from "react";

import { toast as dsToast, type ToastAsk } from "@/components/ds";
import { Icon } from "@/components/ds/Icon";
import { InfoTip } from "@/components/ds/InfoTip";
import { api, unwrap } from "@/lib/api/client";
import type { GmFeature, GmGoal, GmMilestone, GoalMap } from "@/lib/api/mock/goal-map";
import { errorMessage } from "@/lib/use-query";

import { propose } from "../roadmap/_lib";

export type GmVariant = "a" | "b" | "c" | "d";
type F = GmFeature & { goal?: string };
type M = GmMilestone;
const toast = (ask: ToastAsk) => dsToast({ place: "corner", ...ask });

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
const amount = (v: number | null, unit: string) => (v === null ? "—" : unit === "$" ? (v >= 1000 ? `$${Math.round(v / 100) / 10}k` : `$${v}`) : String(v));
const progress = (g: GmGoal) => (g.current === null ? 0 : g.target === 0 ? (g.current <= 0 ? 1 : 1 / (1 + g.current)) : Math.min(1, g.current / g.target));
function fstate(f: F): { w: string; mark: string; cls: string } {
  if (!f.released) return { w: "Planned", mark: "", cls: "text-text2" };
  return f.lift === "not_helping" ? { w: "Not helping yet", mark: "⚠", cls: "text-warn" } : { w: "Shipped", mark: "✓", cls: "text-pass" };
}

/** Milestone codes M1.. roadmap-wide by date (the variants' own read). */
export function v2MilestoneCodes(map: GoalMap): Map<string, string> {
  return new Map([...map.milestones].sort((a, b) => (a.due_on ?? "").localeCompare(b.due_on ?? "")).map((m, i) => [m.id, `M${i + 1}`]));
}

interface GoalView {
  g: GmGoal;
  n: number;
  ms: M[];
  feats: F[];
  groups: { m: M | null; feats: F[] }[];
  next: M | null;
}

function model(map: GoalMap): GoalView[] {
  const byDate = [...map.milestones].sort((a, b) => (a.due_on ?? "").localeCompare(b.due_on ?? ""));
  return map.goals.map((g, i) => {
    const ms = byDate.filter((m) => m.goal === g.id);
    const ids = new Set(ms.map((m) => m.id));
    const feats = (map.features as F[]).filter((f) => (f.milestones[0] ? ids.has(f.milestones[0]) : f.goal === g.id));
    const groups = [...ms.map((m) => ({ m, feats: feats.filter((f) => f.milestones[0] === m.id) })), { m: null, feats: feats.filter((f) => !f.milestones.length) }];
    return { g, n: i + 1, ms, feats, groups, next: ms.find((m) => m.status !== "met") ?? null };
  });
}

/* ---------- Shared pieces ---------- */

interface Ctx {
  map: GoalMap;
  codes: Map<string, string>;
  mcode: Map<string, string>;
  color: (area: string | null) => string;
  trackName: (area: string | null) => string;
  onOpen: (f: F) => void;
  menu: string | null;
  setMenu: (k: string | null) => void;
  setMover: (f: F | null) => void;
  renaming: string | null;
  setRenaming: (k: string | null) => void;
  moved: string | null;
  act: ReturnType<typeof useActs>;
  onAttach: (milestone: string, area?: string) => void;
  /** A: a row picked up to drag (after it moves a few pixels). */
  grab?: (f: F, e: RPointerEvent) => void;
  dragging?: string | null;
}

function Status({ s, small }: { s: string; small?: boolean }) {
  const [w, cls] = STATUS[s] ?? STATUS.not_measured;
  return <span className={`whitespace-nowrap rounded-full font-semibold ${small ? "px-1.5 text-[12px]" : "px-2 py-0.5 text-[13px]"} ${cls}`}>{w}</span>;
}

function Bar({ g, thin }: { g: GmGoal; thin?: boolean }) {
  const p = progress(g);
  const tone = g.status === "at_risk" ? "bg-warn" : g.status === "missed" ? "bg-crit" : g.status === "met" ? "bg-pass" : "bg-accent";
  return (
    <span className={`block w-full overflow-hidden rounded-full bg-surface2 ${thin ? "h-1.5" : "h-2"}`} role="img" aria-label={`${amount(g.current, g.unit)} now, aiming at ${amount(g.target, g.unit)}`}>
      <span className={`block h-full rounded-full ${tone}`} style={{ width: `${Math.max(4, p * 100)}%` }} />
    </span>
  );
}

function GoalInfo({ g, krs }: { g: GmGoal; krs?: string }) {
  return (
    <InfoTip label={g.name} testId={`gm2-goal-info-${g.id}`}>
      <span className="flex flex-col gap-1">
        <b>Measured as {g.measure}</b>
        <span>{(krs || g.math).replace(/^Key results: /, "")}</span>
        {g.read_on && <span>Read on {g.read_on}</span>}
      </span>
    </InfoTip>
  );
}

function Menu({ k, label, items, c }: { k: string; label: string; items: { w: string; on: () => void; crit?: boolean }[]; c: Ctx }) {
  const open = c.menu === k;
  return (
    <span className="relative inline-flex">
      <button type="button" aria-label={`More for ${label}`} aria-expanded={open} data-testid={`gm2-menu-${k}`} onClick={(e) => (e.stopPropagation(), c.setMenu(open ? null : k))} className={`rounded-md px-1 leading-none text-text2 hover:bg-surface2 ${open ? "bg-surface2" : ""}`}>
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

function featureMenu(f: F, c: Ctx) {
  const name = `${c.codes.get(f.id) ?? ""} ${f.name}`.trim();
  return <Menu k={`f-${f.id}`} label={name} c={c} items={[{ w: "Open", on: () => c.onOpen(f) }, { w: "Move to…", on: () => c.setMover(f) }, { w: "Move to Trash", on: () => void c.act.trashFeature(f), crit: true }]} />;
}

function milestoneMenu(m: M, c: Ctx) {
  return <Menu k={`m-${m.id}`} label={`${c.mcode.get(m.id)} ${m.name}`} c={c} items={[{ w: "Rename", on: () => c.setRenaming(m.id) }, { w: "Add a feature", on: () => c.onAttach(m.id) }, { w: "Move to Trash", on: () => void c.act.trashMilestone(m), crit: true }]} />;
}

function goalMenu(v: GoalView, c: Ctx) {
  return <Menu k={`g-${v.g.id}`} label={v.g.name} c={c} items={[{ w: "Rename", on: () => c.setRenaming(v.g.id) }, ...(v.ms[0] ? [{ w: "Add a feature", on: () => c.onAttach((v.next ?? v.ms[0]).id) }] : [])]} />;
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
      data-testid="gm2-rename"
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
function Slot({ f, c }: { f: F; c: Ctx }) {
  const s = fstate(f);
  if (c.dragging)
    return (
      <span className={`flex w-6 shrink-0 justify-center text-[12px] ${s.cls}`} title={s.w}>
        {s.mark || <span className="m-1 size-2 rounded-full border border-text-faint" />}
      </span>
    );
  return (
    <span className="flex w-6 shrink-0 justify-center">
      <span className={`flex text-[12px] group-hover:hidden group-focus-within:hidden group-has-[[aria-expanded=true]]:hidden ${s.cls}`} title={s.w}>
        {s.mark || <span className="m-1 size-2 rounded-full border border-text-faint" />}
      </span>
      <span className="hidden group-hover:inline-flex group-focus-within:inline-flex group-has-[[aria-expanded=true]]:inline-flex">{featureMenu(f, c)}</span>
    </span>
  );
}

/** One feature as one line: track dot, code and name, status. */
function FeatureRow({ f, c, date, tag }: { f: F; c: Ctx; date?: string; tag?: boolean }) {
  const code = c.codes.get(f.id);
  return (
    <li data-feature={f.id} data-moved={c.moved === f.id ? "1" : undefined} onPointerDown={c.grab ? (e) => c.grab!(f, e) : undefined} className={`group flex items-center gap-2 rounded-lg px-1.5 py-0.5 leading-5 hover:bg-surface2 ${c.moved === f.id ? "bg-accent-soft ring-2 ring-accent" : ""} ${c.dragging === f.id ? "opacity-40" : ""} ${c.grab ? "touch-none" : ""}`}>
      <span className="size-2.5 shrink-0 rounded-full" style={{ background: c.color(f.area) }} title={c.trackName(f.area)} />
      <button type="button" onClick={() => c.onOpen(f)} className="min-w-0 flex-1 truncate text-left text-[13.5px] hover:underline" title={`${code ?? ""} ${f.name}`.trim()}>
        {code && <span className="mr-1 text-[12px] text-text-faint">{code}</span>}
        {f.name}
      </button>
      {tag && (
        <span className="shrink-0 rounded-full border px-1.5 text-[12px] max-[600px]:hidden" style={{ borderColor: c.color(f.area), color: c.color(f.area) }}>
          {c.trackName(f.area)}
        </span>
      )}
      {date !== undefined && <span className="w-14 shrink-0 text-right text-[12px] text-text2">{date}</span>}
      <Slot f={f} c={c} />
    </li>
  );
}

function MilestoneHead({ m, c, n }: { m: M | null; c: Ctx; n: number }) {
  if (!m)
    return (
      <div className="flex items-center gap-2 border-b border-line pt-2 pb-0.5 text-[12px] font-semibold tracking-wide text-text2 uppercase">
        <span className="flex-1">No milestone</span>
        <span>{n}</span>
      </div>
    );
  return (
    <div data-milestone={m.id} className="group flex items-baseline gap-1.5 border-b border-line pt-2 pb-0.5 text-[13px]">
      <span className="font-semibold text-accent-ink">{c.mcode.get(m.id)}</span>
      {c.renaming === m.id ? <Rename id={m.id} was={m.name} c={c} className="flex-1 text-[13px]" /> : <span className="min-w-0 flex-1 font-semibold leading-tight">{m.name}</span>}
      <span className="whitespace-nowrap text-text2">{day(m.due_on)}</span>
      {m.status === "met" ? <span className="text-pass" title="Met">✓</span> : m.status === "at_risk" ? <span className="text-warn" title="At risk">⚠</span> : null}
      <span className="opacity-0 group-hover:opacity-100 has-[[aria-expanded=true]]:opacity-100">{milestoneMenu(m, c)}</span>
    </div>
  );
}

function GoalTitle({ v, c, big }: { v: GoalView; c: Ctx; big?: boolean }) {
  return c.renaming === v.g.id ? (
    <Rename id={v.g.id} was={v.g.name} c={c} className={big ? "text-[18px]" : "text-[16px]"} />
  ) : (
    <span className={`font-semibold ${big ? "text-[18px]" : "text-[16px]"}`}>{v.g.name}</span>
  );
}

function Legend({ c, off, toggle }: { c: Ctx; off?: Set<string>; toggle?: (id: string) => void }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5" data-testid="gm2-legend">
      {c.map.areas.map((a) =>
        toggle ? (
          <button key={a.id} type="button" aria-pressed={!off?.has(a.id)} onClick={() => toggle(a.id)} className={`flex items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 text-[13px] ${off?.has(a.id) ? "opacity-40" : "bg-surface"}`}>
            <span className="size-2.5 rounded-full" style={{ background: c.color(a.id) }} />
            {a.name}
          </button>
        ) : (
          <span key={a.id} className="flex items-center gap-1.5 px-1 text-[13px]">
            <span className="size-2.5 rounded-full" style={{ background: c.color(a.id) }} />
            {a.name}
          </span>
        ),
      )}
    </span>
  );
}

/* ---------- The actions (the API's own routes, each with Undo) ---------- */

function useActs(map: GoalMap, setMap: (m: GoalMap) => void, reload: () => unknown, codes: Map<string, string>, mcode: Map<string, string>, setMoved: (id: string | null) => void) {
  const named = (f: F) => `${codes.get(f.id) ?? ""} ${f.name}`.trim();
  const msWords = (id: string | null) => {
    const m = map.milestones.find((x) => x.id === id);
    return m ? `${mcode.get(m.id)} ${m.name}` : "No milestone";
  };
  const failed = (e: unknown) => toast({ message: errorMessage(e) });
  const moveRaw = async (f: F, from: string | null, to: string | null): Promise<GoalMap | null> => {
    if (from && to) return unwrap(api.POST("/v1/simple/goal-map/links/move", { body: { feature: f.id, from_milestone: from, to_milestone: to } }));
    if (!from && to) return unwrap(api.POST("/v1/simple/goal-map/links", { body: { feature: f.id, milestone: to, area: f.area ?? map.areas[0]?.id ?? "", expected: "", confidence: "medium" } }));
    if (from && !to) return unwrap(api.POST("/v1/simple/goal-map/links/detach", { body: { feature: f.id, milestone: from } }));
    return null;
  };
  return {
    move: async (f: F, to: string | null) => {
      const from = f.milestones[0] ?? null;
      try {
        const next = await moveRaw(f, from, to);
        if (!next) return;
        setMap(next);
        setMoved(f.id);
        const toGoal = map.goals.find((g) => g.id === map.milestones.find((m) => m.id === to)?.goal);
        const fromGoal = map.milestones.find((m) => m.id === from)?.goal;
        toast({
          message: `Moved ${named(f)} to ${msWords(to)}${toGoal && fromGoal && toGoal.id !== fromGoal ? ` (${toGoal.name})` : ""}`,
          action: { label: "Undo", onClick: () => void moveRaw({ ...f, milestones: to ? [to] : [] }, to, from).then((m) => m && setMap(m), failed) },
        });
      } catch (e) {
        failed(e);
      }
    },
    rename: async (id: string, name: string, was: string) => {
      const m = map.milestones.find((x) => x.id === id);
      try {
        if (m) await unwrap(api.PATCH("/v1/simple/roadmap/milestones/{milestone_id}", { params: { path: { milestone_id: id } }, body: { name } }));
        else {
          const g = map.goals.find((x) => x.id === id)!;
          const t = amount(g.target, g.unit);
          await unwrap(api.PATCH("/v1/simple/goal-buckets/goals/{goal_id}", { params: { path: { goal_id: id } }, body: { title: name, measure: g.measure, target: t, due: "", seen: { title: was, measure: g.measure, target: t, due: null } } }));
        }
        await reload();
        toast({ message: `Renamed ${was} to ${name}`, action: m ? { label: "Undo", onClick: () => void unwrap(api.PATCH("/v1/simple/roadmap/milestones/{milestone_id}", { params: { path: { milestone_id: id } }, body: { name: was } })).then(reload, failed) } : undefined });
      } catch (e) {
        failed(e);
      }
    },
    trashFeature: async (f: F) => {
      try {
        await propose({ op: "delete_item", target: { item_id: f.id }, before: { deleted: false }, after: { deleted: true } });
        await reload();
        toast({ message: `Moved ${named(f)} to Trash` });
      } catch (e) {
        failed(e);
      }
    },
    trashMilestone: async (m: M) => {
      try {
        await unwrap(api.DELETE("/v1/simple/roadmap/milestones/{milestone_id}", { params: { path: { milestone_id: m.id } } }));
        await reload();
        toast({ message: `Moved ${mcode.get(m.id)} ${m.name} to Trash`, action: { label: "Undo", onClick: () => void unwrap(api.POST("/v1/simple/roadmap/milestones/{milestone_id}/restore", { params: { path: { milestone_id: m.id } } })).then(reload, failed) } });
      } catch (e) {
        failed(e);
      }
    },
  };
}

/** Move to…: every goal's milestones by date, and its own goal's No milestone. */
function MovePicker({ f, views, c, onClose }: { f: F; views: GoalView[]; c: Ctx; onClose: () => void }) {
  const at = f.milestones[0] ?? null;
  const own = views.find((v) => v.feats.some((x) => x.id === f.id));
  const pick = (to: string | null) => {
    onClose();
    void c.act.move(f, to);
  };
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/20 pt-[10vh] max-[600px]:items-end max-[600px]:pt-0" onClick={onClose}>
      <div role="dialog" aria-label={`Move ${f.name}`} data-testid="gm2-mover" onClick={(e) => e.stopPropagation()} className="simple-card w-[720px] max-w-full gap-2 max-[600px]:rounded-b-none">
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
          {views.map((v) => (
            <div key={v.g.id} className="flex flex-col">
              <span className="px-2 pt-1 text-[12px] font-semibold tracking-wide text-text2 uppercase">{v.g.name}</span>
              {[...v.ms, ...(v === own ? [null] : [])].map((m) => {
                const here = (m?.id ?? null) === at && v === own;
                return (
                  <button key={m?.id ?? "none"} type="button" disabled={here} data-to={m?.id ?? "none"} onClick={() => pick(m?.id ?? null)} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[14px] hover:bg-accent-soft disabled:opacity-60 disabled:hover:bg-transparent">
                    {m ? (
                      <>
                        <span className="font-semibold text-accent-ink">{c.mcode.get(m.id)}</span>
                        <span className="flex-1 truncate">{m.name}</span>
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
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------- A · Four columns ---------- */

function FourColumns({ views, c: base }: { views: GoalView[]; c: Ctx }) {
  const [off, setOff] = useState<Set<string>>(new Set());
  // Drag a row onto another milestone (any goal's) or its goal's No milestone.
  const [drag, setDrag] = useState<{ f: F; x: number; y: number; over: string | null } | null>(null);
  const [pending, setPending] = useState<{ f: F; x: number; y: number } | null>(null);
  const act = base.act;
  useEffect(() => {
    if (!pending) return;
    const move = (e: PointerEvent) => {
      if (!drag && Math.hypot(e.clientX - pending.x, e.clientY - pending.y) < 6) return;
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-drop]");
      setDrag({ f: pending.f, x: e.clientX, y: e.clientY, over: el?.getAttribute("data-drop") ?? null });
    };
    const up = () => {
      setPending(null);
      setDrag(null);
      if (!drag?.over) return;
      const at = drag.f.milestones[0] ?? `none:${drag.f.goal}`;
      if (drag.over === at || (drag.over.startsWith("none:") && drag.over !== `none:${drag.f.goal}`)) return;
      void act.move(drag.f, drag.over.startsWith("none:") ? null : drag.over);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [act, pending, drag]);
  const c: Ctx = { ...base, grab: (f, e) => setPending({ f, x: e.clientX, y: e.clientY }), dragging: drag?.f.id ?? null };
  const dropTo = drag?.over && !drag.over.startsWith("none:") ? c.map.milestones.find((m) => m.id === drag.over) : null;
  const toggle = (id: string) => setOff((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Legend c={c} off={off} toggle={toggle} />
      </div>
      <div className="grid grid-cols-4 gap-4 max-[900px]:grid-cols-2 max-[600px]:grid-cols-1" data-testid="gm2-a">
        {views.map((v) => (
          <section key={v.g.id} data-goal={v.g.id} className="flex min-w-0 flex-col gap-1 rounded-2xl border border-line bg-surface p-3">
            <div className="group flex items-start gap-2">
              <span className="text-[28px] leading-none font-bold">{amount(v.g.target, v.g.unit)}</span>
              <span className="ml-auto flex items-center gap-1">
                <Status s={v.g.status} />
                <GoalInfo g={v.g} />
                {goalMenu(v, c)}
              </span>
            </div>
            <GoalTitle v={v} c={c} />
            <Bar g={v.g} />
            <span className="text-[12px] text-text2">
              {amount(v.g.current, v.g.unit)} now · aim {amount(v.g.target, v.g.unit)}
            </span>
            {v.groups.map(({ m, feats }) => {
              const shown = feats.filter((f) => !off.has(f.area ?? ""));
              if (!m && !feats.length && !drag) return null;
              const key = m?.id ?? `none:${v.g.id}`;
              const over = drag?.over === key && key !== (drag.f.milestones[0] ?? `none:${drag.f.goal}`);
              return (
                <div key={key} data-drop={key} className={`rounded-lg ${over ? "bg-accent-soft outline-2 outline-accent outline-dashed" : ""}`}>
                  <MilestoneHead m={m} c={c} n={feats.length} />
                  <ul className="flex flex-col">
                    {shown.map((f) => (
                      <FeatureRow key={f.id} f={f} c={c} />
                    ))}
                  </ul>
                </div>
              );
            })}
          </section>
        ))}
      </div>
      {drag && (
        <div className="pointer-events-none fixed z-50 flex max-w-[360px] items-center gap-2 rounded-lg border border-accent bg-surface px-2 py-1 text-[13.5px] shadow-xl" style={{ left: drag.x + 12, top: drag.y + 8 }} data-testid="gm2-ghost">
          <span className="size-2.5 shrink-0 rounded-full" style={{ background: c.color(drag.f.area) }} />
          <span className="truncate">{drag.f.name}</span>
          {dropTo && (
            <span className="shrink-0 rounded-full bg-accent px-1.5 text-[12px] font-semibold text-on-accent">
              → {c.mcode.get(dropTo.id)} {dropTo.name}
            </span>
          )}
        </div>
      )}
    </>
  );
}

/* ---------- B · Goals by tracks grid ---------- */

function TracksGrid({ views, c }: { views: GoalView[]; c: Ctx }) {
  const all = [...c.map.milestones].sort((a, b) => (a.due_on ?? "").localeCompare(b.due_on ?? ""));
  const col = new Map(views.map((v, i) => [v.g.id, i]));
  return (
    <div className="flex flex-col gap-3 overflow-x-auto" data-testid="gm2-b">
      <div className="grid min-w-[1000px] grid-cols-[150px_repeat(4,minmax(0,1fr))] gap-x-3 max-[600px]:grid-cols-[96px_repeat(4,240px)]">
        <span />
        {views.map((v) => (
          <div key={v.g.id} data-goal={v.g.id} className="group flex flex-col gap-1 rounded-2xl border border-line bg-surface p-3">
            <div className="flex items-center gap-2">
              <span className="text-[24px] leading-none font-bold">{amount(v.g.target, v.g.unit)}</span>
              <span className="ml-auto flex items-center gap-1">
                <Status s={v.g.status} />
                <GoalInfo g={v.g} />
                {goalMenu(v, c)}
              </span>
            </div>
            <GoalTitle v={v} c={c} />
            <Bar g={v.g} thin />
          </div>
        ))}
        <span className="pt-2 text-[12px] font-semibold text-text2 uppercase">Milestones</span>
        {/* The milestone strip: by date across the goals, each under the goal it measures. */}
        <div className="col-span-4 grid grid-cols-4 gap-x-3 pt-2 max-[600px]:grid-cols-[repeat(4,240px)]" data-testid="gm2-strip">
          {views.map((v) => (
            <div key={v.g.id} className="flex flex-wrap content-start items-start gap-1 border-t-4 pt-1.5" style={{ borderColor: "var(--accent-mid)" }}>
              {all
                .filter((m) => col.get(m.goal) === col.get(v.g.id))
                .map((m) => (
                  <span key={m.id} data-milestone={m.id} className="group flex max-w-full items-center gap-1 rounded-md bg-surface2 px-1.5 py-0.5 text-[12px]">
                    <b className="text-accent-ink">{c.mcode.get(m.id)}</b>
                    {c.renaming === m.id ? <Rename id={m.id} was={m.name} c={c} className="text-[12px]" /> : <span className="truncate">{m.name}</span>}
                    <span className="whitespace-nowrap text-text2">{day(m.due_on)}</span>
                    <span className="hidden group-hover:inline-flex has-[[aria-expanded=true]]:inline-flex">{milestoneMenu(m, c)}</span>
                  </span>
                ))}
            </div>
          ))}
        </div>
        {c.map.areas.map((a) => (
          <div key={a.id} className="contents">
            <span className="flex items-start gap-1.5 border-t border-line pt-2 text-[14px] font-semibold" data-track={a.id}>
              <span className="mt-1.5 size-2.5 shrink-0 rounded-full" style={{ background: c.color(a.id) }} />
              {a.name}
            </span>
            {views.map((v) => {
              const feats = v.feats.filter((f) => f.area === a.id);
              return (
                <ul key={v.g.id} className="flex min-h-10 flex-col gap-1 border-t border-line py-1.5" data-cell={`${a.id}:${v.g.id}`}>
                  {feats.map((f) => {
                    const m = c.map.milestones.find((x) => x.id === f.milestones[0]);
                    return (
                      <li key={f.id} data-feature={f.id} className={`group flex items-center gap-1 rounded-lg border bg-surface px-2 py-0.5 text-[13px] leading-[17px] ${c.moved === f.id ? "border-accent bg-accent-soft ring-2 ring-accent" : "border-line"}`} style={{ borderLeft: `3px solid ${c.color(a.id)}` }}>
                        <button type="button" onClick={() => c.onOpen(f)} className="min-w-0 flex-1 text-left">
                          <span className="block truncate hover:underline">{f.name}</span>
                          <span className="block truncate text-[11.5px] text-text2">{m ? `${c.mcode.get(m.id)} ${m.name}` : "No milestone"}</span>
                        </button>
                        <Slot f={f} c={c} />
                      </li>
                    );
                  })}
                </ul>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- C · Outline ---------- */

function Outline({ views, c, open, setOpen }: { views: GoalView[]; c: Ctx; open: Set<string>; setOpen: (s: Set<string>) => void }) {
  const flip = (id: string) => setOpen(open.has(id) ? new Set([...open].filter((x) => x !== id)) : new Set([...open, id]));
  return (
    <div className="flex flex-col gap-2" data-testid="gm2-c">
      <div className="flex justify-end gap-2">
        <button type="button" className="simple-small font-semibold text-accent-ink hover:underline" onClick={() => setOpen(new Set(views.map((v) => v.g.id)))}>
          Expand all
        </button>
        <button type="button" className="simple-small font-semibold text-accent-ink hover:underline" onClick={() => setOpen(new Set())}>
          Collapse all
        </button>
      </div>
      <ul className="flex flex-col rounded-2xl border border-line bg-surface">
        {views.map((v) => {
          const on = open.has(v.g.id);
          return (
            <li key={v.g.id} data-goal={v.g.id} className="border-b border-line last:border-b-0">
              <div className="group grid grid-cols-[24px_minmax(0,1.6fr)_160px_96px_minmax(0,1.4fr)_90px_56px] items-center gap-4 px-4 py-3 max-[600px]:grid-cols-[24px_minmax(0,1fr)_auto] max-[600px]:gap-x-2 max-[600px]:gap-y-1 max-[600px]:px-3">
                <button type="button" aria-expanded={on} aria-label={`${on ? "Collapse" : "Expand"} ${v.g.name}`} onClick={() => flip(v.g.id)} className="rounded p-0.5 hover:bg-surface2">
                  <Icon name={on ? "chevron-down" : "chevron-right"} size={18} />
                </button>
                <button type="button" onClick={() => flip(v.g.id)} className="flex min-w-0 items-baseline gap-2 text-left max-[600px]:order-1">
                  <span className="text-[20px] font-bold">{amount(v.g.target, v.g.unit)}</span>
                  {c.renaming === v.g.id ? <Rename id={v.g.id} was={v.g.name} c={c} className="text-[16px]" /> : <span className="truncate text-[16px] font-semibold max-[600px]:whitespace-normal">{v.g.name}</span>}
                </button>
                <span className="flex flex-col gap-0.5 max-[600px]:order-3 max-[600px]:col-span-2 max-[600px]:col-start-2">
                  <Bar g={v.g} thin />
                  <span className="text-[12px] text-text2">
                    {amount(v.g.current, v.g.unit)} now · aim {amount(v.g.target, v.g.unit)}
                  </span>
                </span>
                <span className="max-[600px]:order-2">
                  <Status s={v.g.status} />
                </span>
                <span className="truncate text-[13px] text-text2 max-[600px]:order-4 max-[600px]:col-span-2 max-[600px]:col-start-2">
                  {v.next ? (
                    <>
                      Next: <b className="text-accent-ink">{c.mcode.get(v.next.id)}</b> {v.next.name} · {day(v.next.due_on)}
                    </>
                  ) : null}
                </span>
                <span className="text-right text-[13px] text-text2 max-[600px]:order-5 max-[600px]:col-start-2 max-[600px]:text-left">{v.feats.length} features</span>
                <span className="flex items-center max-[600px]:order-6">
                  <GoalInfo g={v.g} />
                  {goalMenu(v, c)}
                </span>
              </div>
              {on && (
                <div className="flex flex-col pr-4 pb-3 pl-14 max-[600px]:px-3">
                  {v.groups.map(({ m, feats }) =>
                    !m && !feats.length ? null : (
                      <div key={m?.id ?? "none"}>
                        <MilestoneHead m={m} c={c} n={feats.length} />
                        <ul className="flex flex-col">
                          {feats.map((f) => (
                            <FeatureRow key={f.id} f={f} c={c} tag date={m ? day(m.due_on) : ""} />
                          ))}
                        </ul>
                      </div>
                    ),
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ---------- D · Goal cards and a side sheet ---------- */

function Cards({ views, c, sheet, setSheet }: { views: GoalView[]; c: Ctx; sheet: string | null; setSheet: (id: string | null) => void }) {
  const v = views.find((x) => x.g.id === sheet);
  return (
    <>
      <div className="grid grid-cols-2 gap-4 max-[600px]:grid-cols-1" data-testid="gm2-d">
        {views.map((x) => (
          <div key={x.g.id} data-goal={x.g.id} role="button" tabIndex={0} aria-label={`Open ${x.g.name}`} onClick={() => setSheet(x.g.id)} onKeyDown={(e) => e.key === "Enter" && setSheet(x.g.id)} className={`group flex cursor-pointer flex-col gap-3 rounded-2xl border bg-surface p-5 text-left hover:border-accent ${sheet === x.g.id ? "border-accent ring-2 ring-accent/30" : "border-line"}`}>
            <div className="flex items-start gap-3">
              <span className="text-[40px] leading-none font-bold">{amount(x.g.target, x.g.unit)}</span>
              <span className="ml-auto flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                <Status s={x.g.status} />
                <GoalInfo g={x.g} />
                {goalMenu(x, c)}
              </span>
            </div>
            <GoalTitle v={x} c={c} big />
            <span className="flex flex-col gap-1">
              <Bar g={x.g} />
              <span className="text-[13px] text-text2">
                {amount(x.g.current, x.g.unit)} now · aim {amount(x.g.target, x.g.unit)}
              </span>
            </span>
            {x.next && (
              <span className="text-[14px]">
                Next: <b className="text-accent-ink">{c.mcode.get(x.next.id)}</b> {x.next.name} · <span className="text-text2">{day(x.next.due_on)}</span>
              </span>
            )}
            <span className="flex flex-col gap-1">
              <span className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface2" role="img" aria-label={`${x.feats.length} features by track`}>
                {c.map.areas.map((a) => {
                  const n = x.feats.filter((f) => f.area === a.id).length;
                  return n ? <span key={a.id} style={{ width: `${(n / x.feats.length) * 100}%`, background: c.color(a.id) }} title={`${a.name}: ${n}`} /> : null;
                })}
              </span>
              <span className="flex flex-wrap gap-x-3 text-[12px] text-text2">
                {c.map.areas.map((a) => {
                  const n = x.feats.filter((f) => f.area === a.id).length;
                  return n ? (
                    <span key={a.id} className="flex items-center gap-1">
                      <span className="size-2 rounded-full" style={{ background: c.color(a.id) }} />
                      {a.name} {n}
                    </span>
                  ) : null;
                })}
              </span>
            </span>
          </div>
        ))}
      </div>
      {v && (
        <div className="fixed inset-y-0 right-0 z-30 flex w-[520px] max-w-full flex-col border-l border-line bg-surface shadow-2xl max-[600px]:top-[12vh] max-[600px]:bottom-[var(--phone-tab-bar)] max-[600px]:rounded-t-2xl max-[600px]:border-t" role="dialog" aria-label={v.g.name} data-testid="gm2-sheet">
          <div className="flex items-start gap-2 border-b border-line p-4">
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="flex items-baseline gap-2">
                <span className="text-[26px] leading-none font-bold">{amount(v.g.target, v.g.unit)}</span>
                <GoalTitle v={v} c={c} big />
              </span>
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="w-40">
                  <Bar g={v.g} thin />
                </span>
                <span className="whitespace-nowrap text-[13px] text-text2">
                  {amount(v.g.current, v.g.unit)} now · aim {amount(v.g.target, v.g.unit)}
                </span>
                <Status s={v.g.status} small />
              </span>
            </span>
            {goalMenu(v, c)}
            <button type="button" aria-label="Close" onClick={() => setSheet(null)} className="rounded-full p-1 hover:bg-surface2">
              <Icon name="x" />
            </button>
          </div>
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
            <ol className="flex flex-col" data-testid="gm2-ladder">
              {v.ms.map((m, i) => (
                <li key={m.id} data-milestone={m.id} className="group relative flex items-center gap-2 py-1 pl-6 text-[14px]">
                  <span className={`absolute left-1 size-3 rounded-full border-2 ${m.status === "met" ? "border-pass bg-pass" : "border-accent bg-surface"}`} />
                  {i < v.ms.length - 1 && <span className="absolute top-1/2 left-[9px] h-full w-0.5 bg-line" />}
                  <b className="text-accent-ink">{c.mcode.get(m.id)}</b>
                  {c.renaming === m.id ? <Rename id={m.id} was={m.name} c={c} className="flex-1 text-[14px]" /> : <span className="min-w-0 flex-1 truncate">{m.name}</span>}
                  <span className="text-[13px] text-text2">{day(m.due_on)}</span>
                  <Status s={m.status} small />
                  <span className="opacity-0 group-hover:opacity-100 has-[[aria-expanded=true]]:opacity-100">{milestoneMenu(m, c)}</span>
                </li>
              ))}
            </ol>
            {c.map.areas.map((a) => {
              const feats = v.feats.filter((f) => f.area === a.id);
              if (!feats.length) return null;
              return (
                <div key={a.id}>
                  <div className="flex items-center gap-1.5 border-b border-line pb-0.5 text-[13px] font-semibold">
                    <span className="size-2.5 rounded-full" style={{ background: c.color(a.id) }} />
                    {a.name}
                    <span className="ml-auto font-normal text-text2">{feats.length}</span>
                  </div>
                  <ul className="flex flex-col">
                    {feats.map((f) => {
                      const m = c.map.milestones.find((x) => x.id === f.milestones[0]);
                      return <FeatureRowM key={f.id} f={f} c={c} m={m ?? null} />;
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

function FeatureRowM({ f, c, m }: { f: F; c: Ctx; m: M | null }) {
  const code = c.codes.get(f.id);
  return (
    <li data-feature={f.id} className={`group flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-surface2 ${c.moved === f.id ? "bg-accent-soft ring-2 ring-accent" : ""}`}>
      <button type="button" onClick={() => c.onOpen(f)} className="min-w-0 flex-1 truncate text-left text-[14px] hover:underline">
        {code && <span className="mr-1 text-[12px] text-text-faint">{code}</span>}
        {f.name}
      </button>
      <span className="max-w-[170px] shrink-0 truncate text-[12px] text-text2">{m ? `${c.mcode.get(m.id)} ${m.name}` : "No milestone"}</span>
      <Slot f={f} c={c} />
    </li>
  );
}

/* ---------- The switch ---------- */

export function GoalMapVariants({
  variant,
  map,
  setMap,
  reload,
  codes,
  onOpen,
  onAttach,
  head,
}: {
  variant: GmVariant;
  map: GoalMap;
  setMap: (m: GoalMap) => void;
  reload: () => unknown;
  codes: Map<string, string>;
  onOpen: (f: GmFeature) => void;
  onAttach: (milestone: string, area?: string) => void;
  head: ReactNode;
}) {
  const mcode = useMemo(() => v2MilestoneCodes(map), [map]);
  const views = useMemo(() => model(map), [map]);
  const [menu, setMenu] = useState<string | null>(null);
  const [mover, setMover] = useState<F | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [moved, setMoved] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [sheet, setSheet] = useState<string | null>(null);
  const act = useActs(map, setMap, reload, codes, mcode, setMoved);
  const ci = new Map(map.areas.map((a, i) => [a.id, i]));
  const c: Ctx = {
    map,
    codes,
    mcode,
    color: (a) => TRACK_COLORS[ci.get(a ?? "") ?? 5],
    trackName: (a) => map.areas.find((x) => x.id === a)?.name ?? "No track",
    onOpen,
    menu,
    setMenu,
    setMover,
    renaming,
    setRenaming,
    moved,
    act,
    onAttach,
  };
  return (
    <div className="flex flex-col gap-4" data-testid={`gm2-${variant}-page`} data-gm={variant} onClick={() => menu && setMenu(null)}>
      <div className="flex flex-wrap items-end gap-3">
        {head}
        {variant !== "a" && variant !== "b" && <span className="ml-auto"><Legend c={c} /></span>}
        {variant === "b" && <span className="ml-auto"><Legend c={c} /></span>}
      </div>
      {variant === "a" && <FourColumns views={views} c={c} />}
      {variant === "b" && <TracksGrid views={views} c={c} />}
      {variant === "c" && <Outline views={views} c={c} open={open} setOpen={setOpen} />}
      {variant === "d" && <Cards views={views} c={c} sheet={sheet} setSheet={setSheet} />}
      {mover && <MovePicker f={mover} views={views} c={c} onClose={() => setMover(null)} />}
    </div>
  );
}
