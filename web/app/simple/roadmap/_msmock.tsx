"use client";
/* MOCK-HOOK: this whole file is the mk-milestones mock-up layer (MS1..MS3), never merged.
 * URL switches: ?ms1=a|b|c|d (how to add), ?ms2=a|b|c (what it asks and how it is drawn),
 * ?ms3=a|b|c (a PRD's own milestones), &phase=rest|open|mid|done|second|move|removed|hard, &many=1. */

import { useSearchParams } from "next/navigation";
import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";

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
  const added = (["done", "second", "move", "hard", "removed", "board"].includes(p) || (p === "open" && ms.decision === "ms2")) && ms.decision !== "ms3";
  if (added && p !== "removed") list.push(p === "move" ? { ...MS_NEW, date: "2027-01-27" } : MS_NEW);
  if (p === "second" && ms.decision !== "ms3") list.push({ ...MS_SECOND, ghost: true });
  if (p === "open" && ms.decision === "ms1" && ms.ms1 === "c") list.push({ ...MS_NEW, ghost: true });
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
    </span>
  );
}

function Lock() {
  return (
    <svg aria-hidden viewBox="0 0 10 10" className="mr-1 inline-block h-3 w-3 align-[-1px]" fill="var(--text2)">
      <rect x="1.5" y="4.5" width="7" height="5" rx="1" />
      <path d="M3 4.5V3a2 2 0 0 1 4 0v1.5" stroke="var(--text2)" strokeWidth="1.2" fill="none" />
    </svg>
  );
}

/** A label's width at text-xs semibold, near enough to keep labels apart. */
const textW = (t: string) => Math.ceil(t.length * 7.6) + 24;

function Chip({ children, style, className = "", mx }: { children: ReactNode; style?: CSSProperties; className?: string; mx?: number }) {
  return (
    <span data-ms-label={mx != null ? "" : undefined} data-mx={mx} data-t0={mx != null ? style?.top : undefined} className={`absolute z-[14] overflow-hidden text-ellipsis rounded-full px-2 text-xs leading-5 font-semibold whitespace-nowrap ${className}`} style={style}>
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
        // Its full width on one line and its own row, read once before any fitting.
        const w = Number((el.dataset.w0 ??= String(el.scrollWidth + 2)));
        const t0 = Number(el.dataset.t0) || 0;
        // A diamond scrolled out of sight takes its words with it; none is left half shown.
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
        // A wrapped label is taller than its planned row: it steps down past any label it would sit on.
        el.style.top = `${t0}px`;
        for (let n = 0; wrap && n < 4; n++) {
          const r = el.getBoundingClientRect();
          const hit = placed.find((o) => r.left < o.right + 2 && o.left < r.right + 2 && r.top < o.bottom + 1 && o.top < r.bottom + 1);
          if (!hit) break;
          el.style.top = `${parseFloat(el.style.top) + (hit.bottom - r.top) + 3}px`;
        }
        placed.push(el.getBoundingClientRect());
      }
      // The chart's own key-date and track marks: a word cut by an edge moves to the mark's other side
      // or slides in from the edge; a mark scrolled out of sight takes its word with it.
      for (const t of box.querySelectorAll<SVGTextElement>("[data-testid=key-date-marker] text, [data-testid=track-milestone] text")) {
        const x0 = Number((t.dataset.x0 ??= t.getAttribute("x") ?? "0"));
        const a0 = (t.dataset.a0 ??= t.getAttribute("text-anchor") ?? "start");
        t.setAttribute("x", String(x0));
        t.setAttribute("text-anchor", a0);
        const mark = t.parentElement?.querySelector("rect")?.getBoundingClientRect();
        const kx = mark ? mark.left + mark.width / 2 : 0;
        const gone = !mark || kx < leftEdge - 6 || kx > right + 6;
        t.style.visibility = gone ? "hidden" : "";
        if (gone) continue;
        const r = t.getBoundingClientRect();
        if (r.left < leftEdge && a0 === "end" && r.right + r.width + 18 <= right) {
          t.setAttribute("text-anchor", "start");
          t.setAttribute("x", String(x0 + 18));
        } else if (r.left < leftEdge) t.setAttribute("x", String(x0 + (leftEdge - r.left)));
        else if (r.right > right && a0 === "start" && r.left - r.width - 18 >= leftEdge) {
          t.setAttribute("text-anchor", "end");
          t.setAttribute("x", String(x0 - 18));
        } else if (r.right > right) t.setAttribute("x", String(x0 - (r.right - right)));
      }
    };
    fit();
    box.addEventListener("scroll", fit);
    return () => box.removeEventListener("scroll", fit);
  });
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

  // Labels in a goal's header row: each keeps its name; one that has no room moves to the row below,
  // and one near the right edge sits to the left of its diamond. They keep off the built "Beta" flag's word.
  const tiers = new Map<string, number[]>();
  const labelAt = (band: string, mx: number, y0: number, text: string, cap = phone ? 160 : 320) => {
    const w = Math.min(textW(text), cap);
    let left = mx + 6;
    if (left + w > props.width - 6) left = mx - 6 - w;
    const ends = tiers.get(band) ?? [];
    let t = ends.findIndex((e) => left >= e + 4);
    if (t < 0) t = ends.length < 3 ? ends.length : ends.indexOf(Math.min(...ends));
    ends[t] = left + w;
    tiers.set(band, ends);
    return { left, top: y0 + 6 + t * 24, maxWidth: w };
  };
  const order = [...list.map((m) => ({ m, prd: false })), ...prd.map((m) => ({ m, prd: true }))].sort((a, b) => a.m.date.localeCompare(b.m.date));
  const at = new Map<string, { left: number; top: number; maxWidth: number }>();
  for (const { m, prd: fromPrd } of order) {
    const lane = laneOf(m.goal);
    const words = fromPrd ? `${ms.ms3 === "c" ? "Copied · " : "PRD · "}${m.code} ${m.name}` : style === "c" ? `${m.code} ${m.name}` : `${m.code} ${m.name} · ${day(m.date)}`;
    if (style === "b" && !fromPrd) at.set(m.id, labelAt("all", X(m.date), top - 4, words));
    else if (style === "c" && !fromPrd && lane) at.set(m.id, labelAt(m.goal, X(m.date) - 13, lane.y0, `${words}  `));
    else if (lane) at.set(m.id, labelAt(m.goal, X(m.date), lane.y0, words + (ms.ms3 === "b" ? "  " : "")));
  }
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
      if (lane)
        out.push(
          <Chip key={`t-${m.id}`} mx={mx - 13} className="bg-surface !pl-1" style={{ ...at.get(m.id), color: msInk(m.code) }}>
            <i aria-hidden data-testid="ms-lane-diamond" className="mr-1 inline-block h-2 w-2 rotate-45 align-[1px]" style={{ background: msEdge(m.code) }} />
            {m.code} {m.name}
          </Chip>,
        );
      continue;
    }
    if (style === "b") {
      // B: one line down the whole chart, its flag at the top of the rows.
      out.push(<div key={`v-${m.id}`} aria-hidden className="pointer-events-none absolute z-[12]" style={{ left: mx - 0.75, top: axisY + 6, height: height - axisY - 6, borderLeft: `1.5px solid ${msEdge(m.code)}` }} />);
      out.push(
        <Chip key={`f-${m.id}`} mx={mx} style={{ ...at.get(m.id), background: msFill(m.code), color: msInk(m.code), border: `1px ${m.ghost ? "dashed" : "solid"} ${msEdge(m.code)}` }}>
          {m.code} {m.name}
        </Chip>,
      );
    } else if (lane) {
      // A: a line across the goal's own lanes, its words in the goal's header row.
      out.push(<div key={`v-${m.id}`} aria-hidden className="pointer-events-none absolute z-[12]" style={{ left: mx - 0.75, top: lane.y0, height: lane.y1 - lane.y0, borderLeft: `1.5px ${m.ghost ? "dashed" : "solid"} ${msEdge(m.code)}` }} />);
      out.push(<div key={`s-${m.id}`} aria-hidden className="pointer-events-none absolute z-[12]" style={{ left: mx - 0.75, top: axisY + 6, height: lane.y0 - axisY - 6, borderLeft: `1px dotted ${msEdge(m.code)}`, opacity: 0.6 }} />);
      out.push(
        <Chip key={`f-${m.id}`} mx={mx} style={{ ...at.get(m.id), background: m.ghost ? "var(--surface)" : msFill(m.code), color: msInk(m.code), border: `1px ${m.ghost ? "dashed" : "solid"} ${msEdge(m.code)}` }}>
          {m.code} {m.name} · {day(m.date)}
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
        if (!late && ex < mx) out.push(<div key={`g-${m.id}-${k}`} aria-hidden className="pointer-events-none absolute z-[12]" style={{ left: ex + 2, top: cy - 1, width: mx - ex - 2, borderTop: `2px dotted ${msEdge(m.code)}` }} />);
        out.push(<i key={`gd-${m.id}-${k}`} aria-hidden className="pointer-events-none absolute z-[13] h-2 w-2 rounded-full" style={{ left: (late ? mx : ex) - 4, top: cy - 4, background: late ? "var(--crit)" : msEdge(m.code) }} />);
      }
      if (late && style !== "c")
        out.push(
          <Chip key={`late-${m.id}-${k}`} className="border border-crit bg-crit-bg text-crit" style={{ left: mx - 10 - textW(`Ends after ${m.code}`), top: cy - 10 }}>
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
    const to = proposed ? X("2027-01-05") : mx;
    out.push(<Diamond key={`p-${m.id}`} x={mx} y={axisY} code={m.code} hollow={ms.ms3 !== "c"} title={`${m.code} ${m.name} (from the PRD ${m.prd})`} lock={ms.ms3 === "b"} testid="ms-prd-diamond" />);
    if (lane)
      out.push(<div key={`pv-${m.id}`} aria-hidden className="pointer-events-none absolute z-[12]" style={{ left: mx - 0.75, top: lane.y0, height: lane.y1 - lane.y0, borderLeft: `1.5px ${ms.ms3 === "c" ? "solid" : "dashed"} ${msEdge(m.code)}`, opacity: proposed ? 0.4 : 1 }} />);
    if (lane)
      out.push(
        <Chip key={`pc-${m.id}`} mx={mx} className="border" style={{ background: ms.ms3 === "c" ? msFill(m.code) : "var(--surface)", ...at.get(m.id), borderStyle: ms.ms3 === "c" ? "solid" : "dashed", color: msInk(m.code), borderColor: msEdge(m.code), opacity: proposed ? 0.5 : 1 }}>
          {ms.ms3 === "b" && <Lock />}
          <span className="font-normal text-text2">{ms.ms3 === "c" ? "Copied · " : "PRD · "}</span>{m.code} {m.name}
        </Chip>,
      );
    if (proposed && lane) {
      out.push(<Diamond key={`pp-${m.id}`} x={to} y={axisY} code={m.code} hollow dashed title="Proposed" testid="ms-proposed" />);
      out.push(<div key={`ppv-${m.id}`} aria-hidden className="pointer-events-none absolute z-[12]" style={{ left: to - 0.75, top: lane.y0, height: lane.y1 - lane.y0, borderLeft: `1.5px dashed ${msEdge(m.code)}` }} />);
      out.push(
        <Chip key={`ppc-${m.id}`} className="border border-warn bg-warn-bg text-warn" style={{ left: to + 6, top: lane.y0 + 54 }}>
          {p === "mid" ? `Moving ${m.code} ${m.name} to ${day("2027-01-05")}` : `Asked the PRD: move ${m.code} ${m.name} to ${day("2027-01-05")} · waits for Nora Vance`}
        </Chip>,
      );
    }
  }

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
      if (r && p === "open") out.push(<div key={`pick-${k}`} aria-hidden className="pointer-events-none absolute z-[12]" style={{ left: X(r.start) - 3, top: r.y + 3, width: Math.max(30, X(r.end) - X(r.start) + 6), height: r.h - 6, outline: "2px solid var(--accent)", borderRadius: 8 }} />);
      if (r && p === "open") out.push(<span key={`tick-${k}`} aria-hidden className="absolute z-[13] flex h-4 w-4 items-center justify-center rounded bg-accent text-[11px] font-bold text-on-accent" style={{ left: Math.max(4, X(r.start) - 22), top: r.y + r.h / 2 - 8 }}>✓</span>);
    }
  }
  if (ms.decision === "ms1" && ms.ms1 === "d" && ["open"].includes(p)) {
    const gx = nx;
    if (newLane) out.push(<div key="drop" aria-hidden className="pointer-events-none absolute z-[11]" style={{ left: 0, top: newLane.y0, width: props.width, height: newLane.y1 - newLane.y0, background: "var(--accent-soft)", opacity: 0.45 }} />);
    out.push(<div key="ghost-l" aria-hidden className="pointer-events-none absolute z-[12]" style={{ left: gx, top: axisY + 6, height: height - axisY - 6, borderLeft: "1px dashed var(--accent-ink)" }} />);
    out.push(
      <span key="drag" className="absolute z-[16] flex items-center gap-1.5 rounded-full border border-accent-ink bg-surface px-2.5 text-xs leading-6 font-semibold text-accent-ink shadow-lg" style={{ left: gx - 10, top: (newLane?.y0 ?? top) + 40, transform: "rotate(-3deg)" }}>
        <i aria-hidden className="inline-block h-2.5 w-2.5 rotate-45 bg-accent-ink" /> Milestone · drop on {day(MS_NEW.date)} in Grow retention
      </span>,
    );
  }
  if (ms.decision === "ms1" && ms.ms1 === "d" && !phone)
    out.push(
      // Pinned to the chart's top-left corner as it scrolls sideways.
      <div key="palette" className="sticky top-0 left-0 z-[30] h-0 w-0">
        <span data-testid="ms-palette" className="absolute flex cursor-grab items-center gap-1.5 rounded-full border border-line-strong bg-surface px-2.5 text-xs leading-6 font-semibold whitespace-nowrap" style={{ left: view === "timeline" ? 12 : 8, top: view === "timeline" ? 10 : axisY - 12, opacity: p === "open" ? 0.45 : 1 }}>
          <i aria-hidden className="inline-block h-2.5 w-2.5 rotate-45 bg-accent-ink" /> Drag a milestone onto a date
        </span>
      </div>,
    );
  // MS2: moving one on the axis.
  if (ms.decision === "ms2" && p === "move") {
    out.push(
      <span key="mv" className="absolute z-[16] rounded bg-tip px-2 py-0.5 text-xs whitespace-nowrap text-tip-text" style={{ left: X("2027-01-27") + 16, top: axisY + 8 }}>
        M3 {day("2027-01-20")} → {day("2027-01-27")} · 1 item still ends after it
      </span>,
    );
    out.push(<Cursor key="cur" x={X("2027-01-27") + 2} y={axisY + 4} grab />);
  }

  // The add card (MS1 mid and second, MS2 every open state).
  const cardAt = (d: string) => ({ left: Math.max(8, Math.min(X(d) + 14, props.width - 380)), top: axisY + 18 });
  if (ms.decision === "ms1" && p === "mid") out.push(<AddCard key="card" ms={ms} m={MS_NEW} at={cardAt(MS_NEW.date)} phone={phone} gantt={view === "gantt"} />);
  if (ms.decision === "ms1" && ms.ms1 !== "c" && p === "second") out.push(<AddCard key="card" ms={ms} m={MS_SECOND} at={{ left: Math.max(8, X(MS_SECOND.date) - 374), top: axisY + 18 }} phone={phone} gantt={view === "gantt"} second />);
  if (ms.decision === "ms2" && ["open", "mid"].includes(p)) out.push(<AddCard key="card" ms={ms} m={MS_NEW} at={cardAt(MS_NEW.date)} phone={phone} gantt={view === "gantt"} edit={p === "open"} />);
  if (ms.decision === "ms3" && p === "open") out.push(<PrdCard key="card" ms={ms} at={cardAt("2026-12-15")} phone={phone} gantt={view === "gantt"} />);

  return (
    <div ref={ref} data-testid="ms-layer" className="pointer-events-none absolute inset-0 [&>*]:pointer-events-auto">
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
  const pickedFirst = ms.decision === "ms1" && ms.ms1 === "b";
  const tickList = (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-semibold text-text2">Items it waits on · tick them, or tap bars</span>
      {["alert-rules", "alert-digest", "alert-mobile", "alert-sso"].map((k) => (
        <span key={k} className="flex items-center gap-2 text-sm">
          <i aria-hidden className={`inline-block h-3.5 w-3.5 rounded border ${(second ? [] : m.gates).includes(k) ? "border-accent bg-accent" : "border-line-strong"}`} /> {ITEM_WORDS[k]}
          {k === "alert-sso" && !second && <span className="text-xs font-semibold text-crit">ends Aug 20, after it</span>}
        </span>
      ))}
    </div>
  );
  const gates = style === "b" ? tickList : (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-semibold text-text2">Items it waits on {picking ? <span className="font-normal">{style === "b" ? "· tick them below or tap bars" : "· tap bars on the chart to add"}</span> : null}</span>
      <div className="flex flex-wrap gap-1.5">
        {(second && !pickedFirst ? [] : m.gates).map((k) => (
          <span key={k} className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-surface2 px-2 text-xs leading-6">
            {ITEM_WORDS[k] ?? k}
            {k === "alert-sso" && <span className="font-semibold text-crit">· ends Aug 20, after it</span>}
            <span aria-hidden className="text-text2">×</span>
          </span>
        ))}
        {second && !pickedFirst && <span className="text-xs text-text2">None yet</span>}
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
        {buttons}
      </aside>
    );
  const cls = phone ? "fixed right-0 bottom-0 left-0 z-[60] max-h-[70vh] overflow-y-auto rounded-t-2xl border-t border-line" : "fixed top-4 right-6 z-[60] w-[360px] rounded-xl border border-line";
  return (
    <div data-testid="ms-card" className={`${cls} flex flex-col gap-2.5 bg-surface p-4 shadow-xl`} data-at={at.left} data-gantt={gantt}>
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
  const cls = phone ? "fixed right-0 bottom-0 left-0 z-[60] rounded-t-2xl border-t border-line" : "fixed top-4 right-6 z-[60] w-[360px] rounded-xl border border-line";
  return (
    <div data-testid="ms-prd-card" className={`${cls} flex flex-col gap-2.5 bg-surface p-4 shadow-xl`} data-at={at.left} data-gantt={gantt}>
      {phone && <i aria-hidden className="mx-auto mb-1 block h-1 w-10 rounded-full bg-line-strong" />}
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
  if (ms.decision === "ms2" && p === "done") words = ms.ms2 === "c" ? "M3 added" : "M3 added · 1 item it waits on ends after it";
  if (ms.decision === "ms2" && p === "move") words = "";
  if (ms.decision === "ms2" && p === "removed") words = "M3 Teams set 3 rules in week 1 removed";
  if (ms.decision === "ms3" && p === "done") words = ms.ms3 === "a" ? "Asked Nora Vance to move M2 to Jan 5 in the PRD" : ms.ms3 === "c" ? "4 milestones copied from the PRD Usage alerts" : "";
  if (!words) return null;
  return (
    <div data-testid="ms-toast" className={`fixed z-[70] flex items-center gap-3 rounded-lg bg-tip px-4 py-3 text-sm text-tip-text shadow-xl ${phone ? "top-3 right-3 left-3" : "top-4 right-6"}`}>
      <span>{words}</span>
      <span className="font-semibold underline">Undo</span>
    </div>
  );
}

/** MS1 C: the add bar takes a milestone in words ("M3 Teams set 3 rules in week 1 by Jan 20"). */
export function MsTypeBar() {
  const ms = useMs();
  if (!ms.on || ms.decision !== "ms1" || ms.ms1 !== "c") return null;
  const typed = ms.phase === "open" ? "M3 Teams set 3 rules in week 1 by Jan 20" : ms.phase === "second" ? "M4 Digest opened by 70% by Feb 17|" : "";
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

/** MS3: the key for the PRD's milestones (or C's copy line), in a row of its own above the chart so
 * it never covers the time axis, the Today mark or a month. */
export function MsKey({ phone }: { phone: boolean }) {
  const ms = useMs();
  if (!ms.on || !ms.ms3 || phone) return null;
  const tray = ms.ms3 === "c" && ms.phase !== "done";
  return (
    <div data-testid="ms3-key-row" className="flex flex-wrap items-center gap-2">
      {tray ? (
        <span data-testid="ms3-tray" className="rounded-full border border-dashed border-line-strong bg-surface px-2.5 text-xs leading-6 font-semibold whitespace-nowrap text-text">
          The PRD Usage alerts has 4 milestones · <span className="text-accent-ink underline">Copy onto the roadmap</span>
        </span>
      ) : (
        <span data-testid="ms3-key" className="flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-xs leading-6 whitespace-nowrap text-text2">
          {ms.ms3 === "c" ? (
            <><i aria-hidden className="inline-block h-2.5 w-2.5 rotate-45" style={{ background: msEdge("M1") }} /> Copied from the PRD Usage alerts: the roadmap’s own now</>
          ) : (
            <><i aria-hidden className="inline-block h-2.5 w-2.5 rotate-45 border-[1.5px] border-dashed" style={{ borderColor: msEdge("M1") }} /> Hollow, dashed: from the PRD Usage alerts{ms.ms3 === "b" && <> · <Lock />changes only there</>}{ms.ms3 === "a" && <> · a change asks its owner</>}</>
          )}
        </span>
      )}
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
      <span className={phone ? "whitespace-nowrap" : ""}>{phone ? "2 items picked" : "2 items picked: Mobile alert push, Alert routing by team"}</span>
      <span className="rounded-lg bg-surface px-3 leading-8 font-semibold whitespace-nowrap text-text">{phone ? "Make a milestone" : "Make a milestone after these"}</span>
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
