"use client";
/* MOCK-HOOK: this whole file is the mk-milestones mock-up layer (MS1..MS3), never merged.
 * URL switches: ?ms1=a|b|c|d (how to add), ?ms2=a|b|c (what it asks and how it is drawn),
 * ?ms3=a|b|c (a PRD's own milestones), &phase=rest|open|mid|done|second|move|removed|hard, &many=1. */

import { useSearchParams } from "next/navigation";
import type { CSSProperties, ReactNode } from "react";

import { MS_NEW, MS_OWN, MS_PRD, MS_SAME_DAY, MS_SECOND, type MsMock } from "@/lib/api/mock/ms-mock";

import { shortDay } from "./_lib";
import { msEdge, msFill, msInk } from "./_timeline";

export type MsRow = { key: string; title: string; lane: string; y: number; h: number; start: string; end: string };
export type MsLane = { title: string; y0: number; y1: number };

export function useMs() {
  const q = useSearchParams();
  const ms1 = q.get("ms1") ?? "";
  const ms2 = q.get("ms2") ?? "";
  const ms3 = q.get("ms3") ?? "";
  const on = !!(ms1 || ms2 || ms3);
  return { on, ms1: ms1 || "a", ms2: ms2 || "a", ms3, phase: q.get("phase") ?? "rest", decision: ms3 ? "ms3" : ms2 ? "ms2" : "ms1" };
}

const day = (d: string) => shortDay(d);
const fullDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** The milestones drawn in this state. */
function drawn(ms: ReturnType<typeof useMs>): { list: (MsMock & { ghost?: boolean; late?: boolean; proposed?: string })[]; prd: MsMock[] } {
  const p = ms.phase;
  const list: (MsMock & { ghost?: boolean; proposed?: string })[] = ms.decision === "ms3" ? MS_OWN.filter((m) => m.goal !== "Grow retention") : [...MS_OWN];
  const added = (["done", "second", "move", "hard", "removed"].includes(p) || (p === "open" && ms.decision === "ms2")) && ms.decision !== "ms3";
  if (added && p !== "removed") list.push(p === "move" ? { ...MS_NEW, date: "2027-01-27" } : MS_NEW);
  if (p === "second" && ms.decision === "ms1") list.push({ ...MS_SECOND, ghost: true });
  if (p === "hard" && ms.decision !== "ms3") list.push(MS_SAME_DAY, MS_SECOND);
  let prd: MsMock[] = [];
  if (ms.ms3) {
    prd = MS_PRD;
    if (ms.ms3 === "c" && p !== "done") prd = [];
  }
  return { list, prd };
}

/** One milestone's mark: a diamond on the time axis. */
function Diamond({ x, y, code, size = 12, hollow = false, dashed = false, title, testid = "ms-diamond", lock = false }: { x: number; y: number; code: string; size?: number; hollow?: boolean; dashed?: boolean; title: string; testid?: string; lock?: boolean }) {
  return (
    <span data-testid={testid} title={title} className="absolute z-[25]" style={{ left: x - size / 2, top: y - size / 2, width: size, height: size }}>
      <i
        aria-hidden
        className="block h-full w-full rotate-45 rounded-[2px]"
        style={{ background: hollow ? "var(--surface)" : msEdge(code), border: `1.5px ${dashed ? "dashed" : "solid"} ${msEdge(code)}` }}
      />
      {lock && (
        <svg aria-hidden viewBox="0 0 10 10" className="absolute -top-2.5 -right-2.5 h-3 w-3" fill="var(--text2)">
          <rect x="1.5" y="4.5" width="7" height="5" rx="1" />
          <path d="M3 4.5V3a2 2 0 0 1 4 0v1.5" stroke="var(--text2)" strokeWidth="1.2" fill="none" />
        </svg>
      )}
    </span>
  );
}

function Chip({ children, style, className = "" }: { children: ReactNode; style?: CSSProperties; className?: string }) {
  return (
    <span className={`absolute z-[14] overflow-hidden text-ellipsis rounded-full px-2 text-xs leading-5 font-semibold whitespace-nowrap ${className}`} style={style}>
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

/** The milestone layer drawn over the Timeline or the Gantt. */
export function MsLayer(props: MsLayerProps) {
  const ms = useMs();
  if (!ms.on) return null;
  const { x, top, axisY, height, rows, lanes, phone, left = 0, view } = props;
  const X = (d: string) => left + x(d);
  const { list, prd } = drawn(ms);
  const laneOf = (g: string) => lanes.find((l) => l.title === g);
  const rowOf = (k: string) => rows.find((r) => r.key === k);
  const p = ms.phase;
  const out: ReactNode[] = [];
  const style = ms.decision === "ms2" ? ms.ms2 : "a";
  // Same-day milestones (the hard case) are drawn as one diamond with a count on the axis.
  const byDay = new Map<string, number>();
  for (const m of list) byDay.set(m.date, (byDay.get(m.date) ?? 0) + 1);
  const seenDay = new Map<string, number>();

  // Each label has room up to the next milestone in its goal.
  const room = (m: MsMock) => {
    const next = list.filter((o) => (style === "b" || o.goal === m.goal) && o.date > m.date).map((o) => X(o.date)).sort((a, b) => a - b)[0];
    return next != null ? Math.max(28, next - X(m.date) - 12) : 420;
  };
  for (const m of list) {
    const mx = X(m.date);
    const lane = laneOf(m.goal);
    const n = seenDay.get(m.date) ?? 0;
    seenDay.set(m.date, n + 1);
    const many = (byDay.get(m.date) ?? 1) > 1;
    if (n === 0) {
      out.push(<Diamond key={`d-${m.id}`} x={mx} y={axisY} code={m.code} hollow={m.ghost} dashed={m.ghost} title={`${m.code} ${m.name}, ${fullDay(m.date)}`} />);
      if (many) out.push(<Chip key={`c-${m.id}`} className="z-[26] bg-text text-surface" style={{ left: mx + 8, top: axisY - 10 }}>2 on {day(m.date)}</Chip>);
    }
    if (style === "c") {
      // C: the diamond on the axis, and a small one in the goal's header.
      if (lane) out.push(<Diamond key={`l-${m.id}`} x={mx} y={lane.y0 + 16} code={m.code} size={9} title={m.name} testid="ms-lane-diamond" />);
      if (lane && !phone) out.push(<Chip key={`t-${m.id}`} style={{ left: mx + 8, top: lane.y0 + 6, color: msInk(m.code) }}>{m.code}</Chip>);
      continue;
    }
    if (style === "b") {
      // B: one line down the whole chart, its flag at the top of the rows.
      out.push(<div key={`v-${m.id}`} aria-hidden className="pointer-events-none absolute z-[12]" style={{ left: mx - 0.75, top: axisY + 6, height: height - axisY - 6, borderLeft: `1.5px solid ${msEdge(m.code)}` }} />);
      out.push(
        <Chip key={`f-${m.id}`} style={{ left: mx + 4, top: top + 2 + n * 22, maxWidth: room(m), background: msFill(m.code), color: msInk(m.code), border: `1px solid ${msEdge(m.code)}` }}>
          {m.code} {phone ? "" : m.name}
        </Chip>,
      );
    } else if (lane) {
      // A: a line across the goal's own lanes, its words in the goal's header row.
      out.push(<div key={`v-${m.id}`} aria-hidden className="pointer-events-none absolute z-[12]" style={{ left: mx - 0.75, top: lane.y0, height: lane.y1 - lane.y0, borderLeft: `1.5px ${m.ghost ? "dashed" : "solid"} ${msEdge(m.code)}` }} />);
      out.push(<div key={`s-${m.id}`} aria-hidden className="pointer-events-none absolute z-[12]" style={{ left: mx - 0.75, top: axisY + 6, height: lane.y0 - axisY - 6, borderLeft: `1px dotted ${msEdge(m.code)}`, opacity: 0.6 }} />);
      out.push(
        <Chip key={`f-${m.id}`} style={{ left: mx + 6, top: lane.y0 + 6, maxWidth: room(m), background: msFill(m.code), color: msInk(m.code), border: `1px ${m.ghost ? "dashed" : "solid"} ${msEdge(m.code)}` }}>
          {m.code} {phone ? "" : `${m.name} · ${day(m.date)}`}
        </Chip>,
      );
    }
    // Its gate: each item it waits on tied to it; an item that ends after it is late (red).
    for (const k of m.gates) {
      const r = rowOf(k);
      if (!r) continue;
      const ex = X(r.end);
      const cy = r.y + r.h / 2;
      const late = r.end > m.date;
      if (style === "a") {
        if (!late && ex < mx) out.push(<div key={`g-${m.id}-${k}`} aria-hidden className="pointer-events-none absolute z-[12]" style={{ left: ex + 2, top: cy, width: mx - ex - 2, borderTop: `1.5px dotted ${msEdge(m.code)}` }} />);
        out.push(<i key={`gd-${m.id}-${k}`} aria-hidden className="pointer-events-none absolute z-[13] h-2 w-2 rounded-full" style={{ left: (late ? mx : ex) - 4, top: cy - 4, background: late ? "var(--crit)" : msEdge(m.code) }} />);
      }
      if (late && style !== "c")
        out.push(
          <Chip key={`late-${m.id}-${k}`} className="border border-crit bg-crit-bg text-crit" style={{ left: Math.min(mx + 8, props.width - 150), top: cy - 10 }}>
            Ends after {m.code}
          </Chip>,
        );
    }
  }

  // MS3: a PRD's own milestones.
  for (const m of prd) {
    const mx = X(m.date);
    const lane = laneOf(m.goal);
    const proposed = ms.ms3 === "a" && ["mid", "done"].includes(p) && m.id === "p2";
    const at = proposed ? X("2027-01-05") : mx;
    out.push(<Diamond key={`p-${m.id}`} x={mx} y={axisY} code={m.code} hollow title={`${m.code} ${m.name} (from the PRD ${m.prd})`} lock={ms.ms3 === "b"} testid="ms-prd-diamond" />);
    if (lane)
      out.push(<div key={`pv-${m.id}`} aria-hidden className="pointer-events-none absolute z-[12]" style={{ left: mx - 0.75, top: lane.y0, height: lane.y1 - lane.y0, borderLeft: `1.5px dashed ${msEdge(m.code)}`, opacity: proposed ? 0.4 : 1 }} />);
    if (lane)
      out.push(
        <Chip key={`pc-${m.id}`} className="border bg-surface" style={{ left: mx + 6, top: lane.y0 + 6, maxWidth: (() => { const nx = prd.map((o) => X(o.date)).filter((v) => v > mx).sort((a, b) => a - b)[0]; return nx != null ? Math.max(28, nx - mx - 12) : 420; })(), color: msInk(m.code), borderColor: msEdge(m.code), opacity: proposed ? 0.5 : 1 }}>
          {m.code} {phone ? "" : m.name} <span className="font-normal text-text2">{ms.ms3 === "c" ? "· copied from PRD" : "· PRD"}</span>
        </Chip>,
      );
    if (proposed && lane) {
      out.push(<Diamond key={`pp-${m.id}`} x={at} y={axisY} code={m.code} hollow dashed title="Proposed" testid="ms-proposed" />);
      out.push(<div key={`ppv-${m.id}`} aria-hidden className="pointer-events-none absolute z-[12]" style={{ left: at - 0.75, top: lane.y0, height: lane.y1 - lane.y0, borderLeft: "1.5px dashed var(--color-warn)" }} />);
      out.push(
        <Chip key={`ppc-${m.id}`} className="border border-warn bg-warn-bg text-warn" style={{ left: at + 6, top: lane.y0 + 30 }}>
          {p === "mid" ? `Moving to ${day("2027-01-05")}` : `Asked the PRD: move ${m.code} to ${day("2027-01-05")} · waits for Nora Vance`}
        </Chip>,
      );
    }
  }

  if (ms.ms3 === "c" && p !== "done" && !phone)
    out.push(
      <Chip key="tray" className="z-[26] border border-dashed border-line-strong bg-surface text-text" style={{ left: X("2026-11-24"), top: axisY - 10 }}>
        The PRD Usage alerts has 4 milestones · <span className="text-accent-ink underline">Copy onto the roadmap</span>
      </Chip>,
    );
  if (ms.ms3 === "b" && p === "mid") {
    const lx = X("2026-12-15");
    out.push(<Cursor key="cur" x={lx + 2} y={axisY + 4} grab />);
    out.push(
      <span key="refuse" className="absolute z-[30] rounded bg-tip px-2 py-1 text-xs whitespace-nowrap text-tip-text" style={{ left: lx - 40, top: axisY + 26 }}>
        M2 is the PRD’s. It changes in the PRD · <span className="underline">Open Usage alerts</span>
      </span>,
    );
  }
  // MS1: the add control on the chart.
  const nx = X(MS_NEW.date);
  const newLane = laneOf(MS_NEW.goal);
  if (ms.decision === "ms1" && ms.ms1 === "a" && p === "rest" && !phone)
    out.push(
      <Chip key="hint" className="z-[26] border border-dashed border-line-strong bg-surface text-text2" style={{ left: X("2027-02-08"), top: axisY - 10 }}>
        + Milestone
      </Chip>,
    );
  if (ms.decision === "ms1" && ms.ms1 === "a" && p === "open") {
    out.push(<Diamond key="ghost" x={nx} y={axisY} code="M3" hollow dashed title="New milestone here" testid="ms-ghost" />);
    out.push(<div key="ghost-l" aria-hidden className="pointer-events-none absolute z-[12]" style={{ left: nx - 0.5, top: axisY + 6, height: height - axisY - 6, borderLeft: "1px dashed var(--accent-ink)" }} />);
    out.push(
      <Chip key="ghost-c" className="z-[26] bg-accent-ink text-on-accent" style={{ left: nx + 10, top: axisY - 10 }}>
        + Milestone on {fullDay(MS_NEW.date)}
      </Chip>,
    );
    out.push(<Cursor key="cur" x={nx + 2} y={axisY + 4} />);
  }
  if ((ms.decision === "ms1" || ms.decision === "ms2") && p === "mid") {
    // Mid-add: the day is chosen (a dashed diamond and line), the tapped bars are shaded as they are picked.
    out.push(<Diamond key="ghost" x={nx} y={axisY} code="M3" hollow dashed title="New milestone" testid="ms-ghost" />);
    if (newLane) out.push(<div key="ghost-l" aria-hidden className="pointer-events-none absolute z-[12]" style={{ left: nx - 0.5, top: newLane.y0, height: newLane.y1 - newLane.y0, borderLeft: "1.5px dashed var(--accent-ink)" }} />);
    for (const k of MS_NEW.gates) {
      const r = rowOf(k);
      if (r) out.push(<div key={`pk-${k}`} aria-hidden className="pointer-events-none absolute z-[11]" style={{ left: X(r.start) - 3, top: r.y + 3, width: Math.max(30, X(r.end) - X(r.start) + 6), height: r.h - 6, outline: "2px solid var(--accent)", borderRadius: 8 }} />);
    }
  }
  if (ms.decision === "ms1" && ms.ms1 === "b" && ["open", "mid"].includes(p)) {
    for (const k of MS_NEW.gates) {
      const r = rowOf(k);
      if (r) out.push(<div key={`pick-${k}`} aria-hidden className="pointer-events-none absolute z-[11]" style={{ left: 0, top: r.y, width: props.width, height: r.h, background: "var(--accent-soft)", opacity: 0.55 }} />);
    }
  }
  if (ms.decision === "ms1" && ms.ms1 === "c" && p === "open") {
    out.push(<Diamond key="ghost" x={nx} y={axisY} code="M3" hollow dashed title="Preview" testid="ms-ghost" />);
    if (newLane) out.push(<div key="ghost-l" aria-hidden className="pointer-events-none absolute z-[12]" style={{ left: nx - 0.5, top: newLane.y0, height: newLane.y1 - newLane.y0, borderLeft: "1.5px dashed var(--accent-ink)" }} />);
    if (newLane) out.push(<Chip key="ghost-c" className="border border-dashed border-accent-ink bg-surface text-accent-ink" style={{ left: nx + 6, top: newLane.y0 + 6 }}>M3 Teams set 3 rules in week 1 · {day(MS_NEW.date)}</Chip>);
  }
  if (ms.decision === "ms1" && ms.ms1 === "d" && ["open"].includes(p)) {
    const gx = X("2027-01-18");
    if (newLane) out.push(<div key="drop" aria-hidden className="pointer-events-none absolute z-[11]" style={{ left: 0, top: newLane.y0, width: props.width, height: newLane.y1 - newLane.y0, background: "var(--accent-soft)", opacity: 0.45 }} />);
    out.push(<div key="ghost-l" aria-hidden className="pointer-events-none absolute z-[12]" style={{ left: gx, top: axisY + 6, height: height - axisY - 6, borderLeft: "1px dashed var(--accent-ink)" }} />);
    out.push(
      <span key="drag" className="absolute z-[16] flex items-center gap-1.5 rounded-full border border-accent-ink bg-surface px-2.5 text-xs leading-6 font-semibold text-accent-ink shadow-lg" style={{ left: gx - 10, top: (newLane?.y0 ?? top) + 40, transform: "rotate(-3deg)" }}>
        <i aria-hidden className="inline-block h-2.5 w-2.5 rotate-45 bg-accent-ink" /> Milestone · drop on {day("2027-01-18")} in Grow retention
      </span>,
    );
  }
  if (ms.decision === "ms1" && ms.ms1 === "d" && !phone)
    out.push(
      <span key="palette" data-testid="ms-palette" className="absolute z-[15] flex cursor-grab items-center gap-1.5 rounded-full border border-line-strong bg-surface px-2.5 text-xs leading-6 font-semibold" style={{ left: view === "timeline" ? 12 : 8, top: view === "timeline" ? 10 : axisY - 12, opacity: p === "open" ? 0.45 : 1 }}>
        <i aria-hidden className="inline-block h-2.5 w-2.5 rotate-45 bg-accent-ink" /> Drag a milestone onto a date
      </span>,
    );
  // MS2: moving one on the axis.
  if (ms.decision === "ms2" && p === "move") {
    out.push(
      <span key="mv" className="absolute z-[16] rounded bg-tip px-2 py-0.5 text-xs whitespace-nowrap text-tip-text" style={{ left: X("2027-01-27") - 60, top: axisY + 12 }}>
        M3 {day("2027-01-20")} → {day("2027-01-27")} · 1 item still ends after it
      </span>,
    );
    out.push(<Cursor key="cur" x={X("2027-01-27") + 2} y={axisY + 4} grab />);
  }

  // The add card (MS1 mid and second, MS2 every open state).
  const cardAt = (d: string) => ({ left: Math.max(8, Math.min(X(d) + 14, props.width - 380)), top: axisY + 18 });
  if (ms.decision === "ms1" && p === "mid") out.push(<AddCard key="card" ms={ms} m={MS_NEW} at={cardAt(MS_NEW.date)} phone={phone} gantt={view === "gantt"} />);
  if (ms.decision === "ms1" && p === "second") out.push(<AddCard key="card" ms={ms} m={MS_SECOND} at={{ left: Math.max(8, X(MS_SECOND.date) - 374), top: axisY + 18 }} phone={phone} gantt={view === "gantt"} second />);
  if (ms.decision === "ms2" && ["open", "mid"].includes(p)) out.push(<AddCard key="card" ms={ms} m={MS_NEW} at={cardAt(MS_NEW.date)} phone={phone} gantt={view === "gantt"} edit={p === "open"} />);
  if (ms.decision === "ms3" && p === "open") out.push(<PrdCard key="card" ms={ms} at={cardAt("2026-12-15")} phone={phone} gantt={view === "gantt"} />);

  return (
    <div data-testid="ms-layer" className="pointer-events-none absolute inset-0 [&>*]:pointer-events-auto">
      {out}
      <MsToast ms={ms} phone={phone} />
    </div>
  );
}

function Cursor({ x, y, grab = false }: { x: number; y: number; grab?: boolean }) {
  return (
    <svg aria-hidden className="pointer-events-none absolute z-[20]" style={{ left: x, top: y }} width="18" height="22" viewBox="0 0 18 22">
      {grab ? (
        <path d="M5 9V4.5a1.5 1.5 0 0 1 3 0V9V3a1.5 1.5 0 0 1 3 0v6V4.5a1.5 1.5 0 0 1 3 0V13c0 4-2.5 7-6 7S2.5 17 2 15l-1-4.5a1.4 1.4 0 0 1 2.6-1L5 12z" fill="white" stroke="black" strokeWidth="1.1" />
      ) : (
        <path d="M1 1l0 16 4.5-4 3 7 2.5-1-3-7 6 0z" fill="white" stroke="black" strokeWidth="1.2" strokeLinejoin="round" />
      )}
    </svg>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-semibold text-text2">
      {label}
      <span className="flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-2.5 text-sm font-normal text-text">{children}</span>
    </label>
  );
}

const ITEM_WORDS: Record<string, string> = { "alert-mobile": "Mobile alert push", "alert-sso": "Alert routing by team", "alert-digest": "Weekly alert digest", "alert-rules": "Alert rules engine" };

/** The new milestone's card: what it asks for (MS2) in the state of the add (MS1). */
function AddCard({ ms, m, at, phone, gantt, second = false, edit = false }: { ms: ReturnType<typeof useMs>; m: MsMock; at: { left: number; top: number }; phone: boolean; gantt: boolean; second?: boolean; edit?: boolean }) {
  const style = ms.decision === "ms2" ? ms.ms2 : "a";
  const picking = !second;
  const gates = (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-semibold text-text2">Items it waits on {picking ? <span className="font-normal">{style === "b" ? "· tick them below or tap bars" : "· tap bars on the chart to add"}</span> : null}</span>
      <div className="flex flex-wrap gap-1.5">
        {(second ? [] : m.gates).map((k) => (
          <span key={k} className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-surface2 px-2 text-xs leading-6">
            {ITEM_WORDS[k] ?? k}
            {k === "alert-sso" && <span className="font-semibold text-crit">· ends Aug 20, after it</span>}
            <span aria-hidden className="text-text2">×</span>
          </span>
        ))}
        {second && <span className="text-xs text-text2">None yet</span>}
      </div>
    </div>
  );
  const head = edit ? `Edit ${m.code}` : second ? "Next milestone" : "New milestone";
  const fields =
    style === "c" ? (
      <>
        <Field label="Name">{`${m.code} ${m.name}`}</Field>
        <Field label="Date">{fullDay(m.date)}</Field>
        <p className="text-xs text-text2">Add the items it waits on and when it counts later, from its diamond.</p>
      </>
    ) : (
      <>
        <Field label="Name">
          <span className="font-semibold" style={{ color: msInk(m.code) }}>{m.code}</span> {second ? <span className="text-text2">Digest opened by 7|</span> : m.name}
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Date">{fullDay(m.date)}</Field>
          <Field label="Goal">{m.goal} ▾</Field>
        </div>
        {gates}
        <Field label="It counts when">{second ? <span className="text-text2">Holds 7 days in a row ▾</span> : <>{m.rule} ▾</>}</Field>
        {style === "b" && <Field label="Status">{m.status} ▾</Field>}
      </>
    );
  const buttons = (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <span className="rounded-lg bg-accent px-3 text-sm leading-8 font-semibold text-on-accent">{edit ? "Save" : "Add"}</span>
      {!edit && <span className="rounded-lg border border-line-strong px-3 text-sm leading-8 font-semibold">Add and place another</span>}
      {edit && <span className="rounded-lg border border-line-strong px-3 text-sm leading-8 font-semibold text-crit">Remove</span>}
      <span className="px-1 text-sm text-text2">Cancel</span>
    </div>
  );
  if (style === "b" && !phone)
    return (
      <aside data-testid="ms-panel" className="fixed top-0 right-0 bottom-0 z-[60] flex w-[380px] flex-col gap-3 overflow-y-auto border-l border-line bg-surface p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">{head}</h2>
          <span className="text-text2">×</span>
        </div>
        {fields}
        <div className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-text2">All of Grow retention</span>
          {["Alert rules engine", "Weekly alert digest", "Mobile alert push", "Alert routing by team", "Alert history export"].map((t) => (
            <span key={t} className="flex items-center gap-2 text-sm">
              <i aria-hidden className={`inline-block h-3.5 w-3.5 rounded border ${["Mobile alert push", "Alert routing by team"].includes(t) ? "border-accent bg-accent" : "border-line-strong"}`} /> {t}
            </span>
          ))}
        </div>
        {buttons}
      </aside>
    );
  const cls = phone ? "fixed right-0 bottom-0 left-0 z-[60] max-h-[70vh] overflow-y-auto rounded-t-2xl border-t border-line" : gantt ? "fixed right-6 bottom-6 z-[60] w-[360px] rounded-xl border border-line" : "absolute z-[40] w-[360px] rounded-xl border border-line";
  return (
    <div data-testid="ms-card" className={`${cls} flex flex-col gap-2.5 bg-surface p-4 shadow-xl`} style={phone || gantt ? undefined : at}>
      {phone && <i aria-hidden className="mx-auto mb-1 block h-1 w-10 rounded-full bg-line-strong" />}
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">{head}</h2>
        <span className="text-xs text-text2">{second ? "M3 added · now the next one" : `Grow retention · ${day(m.date)}`}</span>
      </div>
      {fields}
      {buttons}
    </div>
  );
}

/** MS3: a PRD milestone opened on the chart. */
function PrdCard({ ms, at, phone, gantt }: { ms: ReturnType<typeof useMs>; at: { left: number; top: number }; phone: boolean; gantt: boolean }) {
  const m = MS_PRD[1];
  const cls = phone ? "fixed right-0 bottom-0 left-0 z-[60] rounded-t-2xl border-t border-line" : gantt ? "fixed right-6 bottom-6 z-[60] w-[360px] rounded-xl border border-line" : "absolute z-[40] w-[360px] rounded-xl border border-line";
  return (
    <div data-testid="ms-prd-card" className={`${cls} flex flex-col gap-2.5 bg-surface p-4 shadow-xl`} style={phone || gantt ? undefined : at}>
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">
          <span style={{ color: msInk(m.code) }}>{m.code}</span> {m.name}
        </h2>
        <span className="rounded-full bg-na-bg px-2 text-xs leading-5 text-na">From the PRD</span>
      </div>
      <p className="text-sm text-text2">
        From the PRD <span className="font-semibold text-accent-ink underline">Usage alerts</span> · owned by Nora Vance
      </p>
      {ms.ms3 === "b" ? (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-text2">Date</dt>
            <dd>{fullDay(m.date)}</dd>
            <dt className="text-text2">Waits on</dt>
            <dd>Weekly alert digest</dd>
            <dt className="text-text2">Counts when</dt>
            <dd>{m.rule}</dd>
          </dl>
          <p className="rounded-lg bg-surface2 px-3 py-2 text-sm">This one changes in the PRD, not here.</p>
          <span className="self-start rounded-lg bg-accent px-3 text-sm leading-8 font-semibold text-on-accent">Open it in the PRD</span>
        </>
      ) : ms.ms3 === "a" ? (
        <>
          <Field label="Date">{fullDay(m.date)}</Field>
          <Field label="It counts when">{m.rule} ▾</Field>
          <p className="text-xs text-text2">A change here goes to Nora Vance as a change to the PRD. It shows dashed until she says yes.</p>
          <div className="flex gap-2">
            <span className="rounded-lg bg-accent px-3 text-sm leading-8 font-semibold text-on-accent">Ask to change it</span>
            <span className="px-1 text-sm leading-8 text-text2">Cancel</span>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm">The PRD has 4 milestones. Copy them onto this roadmap to place and edit them here; the PRD stays as it is.</p>
          {MS_PRD.map((x) => (
            <span key={x.id} className="flex items-center gap-2 text-sm">
              <i aria-hidden className="inline-block h-3.5 w-3.5 rounded border border-accent bg-accent" />
              <span style={{ color: msInk(x.code) }} className="font-semibold">{x.code}</span> {x.name} · {day(x.date)}
            </span>
          ))}
          <span className="self-start rounded-lg bg-accent px-3 text-sm leading-8 font-semibold text-on-accent">Copy 4 onto the roadmap</span>
        </>
      )}
    </div>
  );
}

function MsToast({ ms, phone }: { ms: ReturnType<typeof useMs>; phone: boolean }) {
  const p = ms.phase;
  let words = "";
  if (ms.decision === "ms1" && p === "done") words = "M3 Teams set 3 rules in week 1 added to Grow retention";
  if (ms.decision === "ms2" && p === "done") words = "M3 added · 1 item it waits on ends after it";
  if (ms.decision === "ms2" && p === "move") words = "";
  if (ms.decision === "ms2" && p === "removed") words = "M3 Teams set 3 rules in week 1 removed";
  if (ms.decision === "ms3" && p === "done") words = ms.ms3 === "a" ? "Asked Nora Vance to move M2 to Jan 5 in the PRD" : ms.ms3 === "c" ? "4 milestones copied from the PRD Usage alerts" : "";
  if (!words) return null;
  return (
    <div data-testid="ms-toast" className={`fixed z-[70] flex items-center gap-3 rounded-lg bg-tip px-4 py-3 text-sm text-tip-text shadow-xl ${phone ? "right-3 bottom-20 left-3" : "right-6 bottom-6"}`}>
      <span>{words}</span>
      <span className="font-semibold underline">Undo</span>
    </div>
  );
}

/** MS1 C: the add bar takes a milestone in words ("M3 Teams set 3 rules in week 1 by Jan 20"). */
export function MsTypeBar() {
  const ms = useMs();
  if (!ms.on || ms.decision !== "ms1" || ms.ms1 !== "c") return null;
  const typed = ms.phase === "open" ? "M3 Teams set 3 rules in week 1 by Jan 20" : ms.phase === "second" ? "M4 Digest opened by 70% by Feb 1|" : "";
  return (
    <div data-testid="ms-typebar" className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-line-strong bg-surface px-3 py-2.5">
      <span className="text-[15px] font-semibold">Add a milestone</span>
      <span className="flex min-h-9 flex-1 items-center rounded-lg border border-line-strong px-3 text-[15px]">
        {typed ? <span>{typed}</span> : <span className="text-text-faint">Name and date, like “M3 Teams set 3 rules by Jan 20”</span>}
      </span>
      {ms.phase === "open" && <span className="text-xs text-text2">Grow retention · Jan 20, 2027 · Enter to add</span>}
      {ms.phase === "second" && <span className="text-xs text-text2">M3 added · keep typing for the next</span>}
    </div>
  );
}

/** MS1 B: the "after these" bar when items are picked. */
export function MsPickBar({ phone }: { phone: boolean }) {
  const ms = useMs();
  if (!ms.on || ms.decision !== "ms1" || ms.ms1 !== "b" || !["open", "rest"].includes(ms.phase)) return null;
  if (ms.phase === "rest")
    return <p className="text-xs text-text2" data-testid="ms-pick-hint">Tip: tick items, then make a milestone after them.</p>;
  return (
    <div data-testid="ms-pickbar" className={`z-[70] flex items-center gap-3 rounded-xl bg-tip px-4 py-2.5 text-sm text-tip-text shadow-xl ${phone ? "fixed right-3 bottom-20 left-3" : "fixed bottom-6 left-1/2 -translate-x-1/2"}`}>
      <span>2 items picked: Mobile alert push, Alert routing by team</span>
      <span className="rounded-lg bg-surface px-3 leading-8 font-semibold text-text">Make a milestone after these</span>
      <span className="underline">Clear</span>
    </div>
  );
}

/** Now / Next / Later: the milestones in each horizon, as a row above its cards. */
export function MsBoardRow({ horizon }: { horizon: string }) {
  const ms = useMs();
  if (!ms.on) return null;
  const { list } = drawn(ms);
  const h = (d: string) => (d < "2027-01-01" ? "now" : d < "2027-04-01" ? "next" : "later");
  const here = list.filter((m) => h(m.date) === horizon);
  return (
    <div data-testid="ms-board-row" className="flex flex-wrap gap-1.5 px-1 pb-2">
      {here.map((m) => (
        <span key={m.id} className="inline-flex items-center gap-1.5 rounded-full border px-2 text-xs leading-6 font-semibold" style={{ background: msFill(m.code), color: msInk(m.code), borderColor: msEdge(m.code), borderStyle: m.ghost ? "dashed" : "solid" }}>
          <i aria-hidden className="inline-block h-2 w-2 rotate-45" style={{ background: msEdge(m.code) }} />
          {m.code} {m.name} · {day(m.date)}
        </span>
      ))}
      <span className="inline-flex items-center rounded-full border border-dashed border-line-strong px-2 text-xs leading-6 text-text2">+ Milestone</span>
    </div>
  );
}
