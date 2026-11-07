"use client";
// PV-1 One count per spot (BGD's pick, Nov 7): on the Value / effort chart, marks that would cover each other become
// one dark mark showing their count, drawn within half a mark of their values (or just clear of a corner's name);
// a tap opens a sheet listing its features by rank, and a row opens the one feature panel. Phone and desktop alike.

import type { ReactNode } from "react";

import { Sheet } from "@/components/ds";

/** A rectangle on the plot, in pixels: left, top, right, bottom. */
export type Box = [number, number, number, number];
type Pt = [number, number];
/** What a count needs of a feature. */
export type CountRow = { feature_id: string; code: string; short_code?: string | null; title: string; rank: number; goal_value?: number | null; effort?: number | null };

/** Features drawn as one count mark, at `at`, in rank order. */
export type Crowd<T extends CountRow> = { id: string; at: Pt; rows: T[] };

/** A mark's radius: today's 36 px marks. */
export const MARK_R = 18;
// V-4: marks keep GAP px apart, never touching (a hollow mark's ring reads as one with its neighbour's).
const GAP = 4;

const fmt = (n: number | null | undefined) => (n == null ? "–" : Number(n.toFixed(1)).toString());

/** Marks whose real spots would touch (closer than d in both directions), grouped in rank order around the first one's spot. */
function groups<T extends CountRow>(rows: T[], at: (r: T) => Pt, d: number): Crowd<T>[] {
  const out: Crowd<T>[] = [];
  for (const r of rows) {
    const [x, y] = at(r);
    const g = out.find((c) => Math.abs(c.at[0] - x) < d && Math.abs(c.at[1] - y) < d);
    if (g) g.rows.push(r);
    else out.push({ id: r.feature_id, at: [x, y], rows: [r] });
  }
  return out;
}

/**
 * The nearest free spot to `at` for a mark of radius r (searched up to maxd px; none past it): inside the plot, GAP px
 * from every placed mark, and 3 px clear of a quadrant's name (qa4-simple-plan-9: never on its edge).
 */
function nearest(at: Pt, r: number, w: number, h: number, placed: [number, number, number][], avoid: Box[], maxd: number): Pt | null {
  const inside = (x: number, y: number) => x >= r && x <= w - r && y >= r && y <= h - r;
  const free = (x: number, y: number) =>
    inside(x, y) &&
    placed.every(([px, py, pr]) => Math.abs(px - x) >= pr + r + GAP || Math.abs(py - y) >= pr + r + GAP) &&
    avoid.every((q) => x + r + 3 <= q[0] || x - r - 3 >= q[2] || y + r + 3 <= q[1] || y - r - 3 >= q[3]);
  const cx = Math.min(w - r, Math.max(r, at[0]));
  const cy = Math.min(h - r, Math.max(r, at[1]));
  if (free(cx, cy)) return [cx, cy];
  for (let rad = 3; rad <= maxd; rad += 3) {
    const n = Math.max(12, Math.round(rad / 2));
    for (let k = 0; k < n; k++) {
      const t = (k / n) * 2 * Math.PI;
      const x = cx + rad * Math.cos(t);
      const y = cy + rad * Math.sin(t);
      if (free(x, y)) return [x, y];
    }
  }
  return null;
}

/**
 * Where each mark sits on a w x h plot (`at`: a feature's real spot), in rank order. Features at nearly one spot
 * (closer than half a mark) start as one group; each group sits within half a mark of its spot, or else joins the
 * placed mark or count in its way, which then counts it too; with none in the way, only a corner's name or the edge
 * is, and it moves just clear of them. A group of one is a lone mark (`spots`); the rest are counts (`crowds`), so no
 * two marks ever overlap (qa-simple-plan-11).
 */
export function markLayout<T extends CountRow>(rows: T[], w: number, h: number, at: (r: T) => Pt, avoid: Box[]): { spots: Map<string, Pt>; crowds: Crowd<T>[] } {
  const R = MARK_R;
  if (!w || !h) return { spots: new Map(rows.map((r) => [r.feature_id, at(r)])), crowds: [] };
  const placed: [number, number, number][] = [];
  const out: Crowd<T>[] = [];
  for (const g of groups(rows, at, R)) {
    const s = nearest(g.at, R, w, h, placed, avoid, R);
    // In the way: the nearest placed mark or count that could block it (closer than a mark and a half) counts it too.
    const dist = (c: Crowd<T>) => Math.max(Math.abs(c.at[0] - g.at[0]), Math.abs(c.at[1] - g.at[1]));
    const near = s ? undefined : out.filter((c) => dist(c) < 3 * R + GAP).sort((a, b) => dist(a) - dist(b))[0];
    if (near) {
      near.rows.push(...g.rows);
      continue;
    }
    const t = s ?? nearest(g.at, R, w, h, placed, avoid, Math.max(w, h)) ?? g.at;
    placed.push([t[0], t[1], R]);
    out.push({ ...g, at: t });
  }
  const spots = new Map<string, Pt>();
  for (const c of out) if (c.rows.length === 1) spots.set(c.rows[0].feature_id, c.at);
  for (const c of out) c.rows.sort((x, y) => x.rank - y.rank);
  return { spots, crowds: out.filter((c) => c.rows.length > 1) };
}

/** Whether a feature serves a goal (the plan's goal, as its mark's name reads it). */
export type HasGoal<T> = (r: T) => boolean;

/** Whether every feature in a count has the same numbers (its title says them; the rows need not). */
const oneSpot = (rows: CountRow[]) => new Set(rows.map((r) => `${r.effort ?? "pm"}|${r.goal_value ?? "–"}`)).size === 1;

// A span never breaks; lines break only at the dot.
const span = (xs: number[]) => (Math.min(...xs) === Math.max(...xs) ? fmt(xs[0]) : `${fmt(Math.min(...xs))}⁠–⁠${fmt(Math.max(...xs))}`);
/** An effort in a lone mark's words: "effort 1 week", "effort 2 weeks", "PM-owned, no effort". */
const effortWords = (xs: number[]) => (xs.length === 1 || Math.min(...xs) === Math.max(...xs) ? `effort ${fmt(xs[0])} ${xs[0] === 1 ? "week" : "weeks"}` : `effort ${span(xs)} weeks`);

/**
 * What a count's features share, in the lone marks' words: "effort 1 week · goal value 0", the span when they differ
 * ("effort 2⁠–⁠4 weeks"); PM-owned work (no effort) says "PM-owned, no effort"; with no goal (or no goal value) "no goal".
 */
export function crowdWhere<T extends CountRow>(rows: T[], hasGoal: HasGoal<T>): string {
  const e = rows.flatMap((r) => (r.effort == null ? [] : [r.effort]));
  const pm = rows.some((r) => r.effort == null);
  const v = rows.flatMap((r) => (r.goal_value == null ? [] : [r.goal_value]));
  const none = rows.filter((r) => !hasGoal(r) || r.goal_value == null).length;
  const effort = !e.length ? "PM-owned, no effort" : pm ? `${effortWords(e)} or PM-owned` : effortWords(e);
  // Some with no goal (or none): "goal value 0 or no goal", as PM-owned work joins an effort.
  const value = none === rows.length ? (v.length ? `goal value ${span(v)} · no goal` : "no goal") : `goal value ${span(v)}${none ? " or no goal" : ""}`;
  return `${effort} · ${value}`;
}

/** A count's spoken name: what its features share, then its first three features by code and name. */
export function crowdName<T extends CountRow>(rows: T[], hasGoal: HasGoal<T>): string {
  const first = rows
    .slice(0, 3)
    .map((r) => `${r.short_code || r.code} ${r.title}`)
    .join(", ");
  return `${rows.length} features at ${crowdWhere(rows, hasGoal)}: ${first}${rows.length > 3 ? ` and ${rows.length - 3} more` : ""}; show them`;
}

/** A row's own numbers in a count whose features differ: "6 · 2 weeks", "4 · PM-owned" (its mark shows whether it has a goal). */
const rowNums = (r: CountRow) => `${fmt(r.goal_value)} · ${r.effort == null ? "PM-owned" : `${fmt(r.effort)} ${r.effort === 1 ? "week" : "weeks"}`}`;

/** One feature in a count's list: rank, its mark (`shape`: its goal's, "none" with no goal), code and name, its numbers; a tap opens the one feature panel. */
function CountListRow<T extends CountRow>({ r, mark, shape, onOpen, nums }: { r: T; mark: (r: T) => ReactNode; shape: (r: T) => string; onOpen: (r: T) => void; nums: boolean }) {
  return (
    <li>
      <button type="button" data-testid="vxe-crowd-row" data-code={r.code} data-shape={shape(r)} onClick={() => onOpen(r)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[15px] leading-[22px] hover:bg-surface2">
        <span className="w-6 flex-none text-right font-[650] tabular-nums">{r.rank}</span>
        {mark(r)}
        <span data-testid="vxe-crowd-code" className="flex-none whitespace-nowrap rounded-md border border-line-strong bg-surface px-1 text-[13px] font-semibold tabular-nums text-text">{r.short_code || r.code}</span>
        <span className="min-w-0 flex-1 truncate">{r.title}</span>
        {nums && <span className="flex-none whitespace-nowrap text-[13px] tabular-nums text-text2">{rowNums(r)}</span>}
      </button>
    </li>
  );
}

/** A count's features by rank: a bottom sheet on a phone, a panel at the right edge on a wider screen. */
export function CrowdSheet<T extends CountRow>({ crowd, mark, shape, hasGoal, onOpen, onClose }: { crowd: Crowd<T> | null; mark: (r: T) => ReactNode; shape: (r: T) => string; hasGoal: HasGoal<T>; onOpen: (r: T) => void; onClose: () => void }) {
  if (!crowd) return null;
  return (
    <Sheet open side title={`${crowd.rows.length} features · ${crowdWhere(crowd.rows, hasGoal)}`} onClose={onClose} testId="vxe-crowd-sheet">
      <ul className="flex flex-col pb-2" data-testid="vxe-crowd-list">
        {crowd.rows.map((r) => (
          <CountListRow key={r.feature_id} r={r} mark={mark} shape={shape} onOpen={onOpen} nums={!oneSpot(crowd.rows)} />
        ))}
      </ul>
    </Sheet>
  );
}

/** A count's glyph: a dark disc with the count, a second disc behind it (several stacked). */
function CountGlyph({ n }: { n: number }) {
  const fs = n > 9 ? 12 : 13;
  return (
    <svg width={2 * MARK_R} height={2 * MARK_R} viewBox="0 0 36 36" aria-hidden className="block flex-none overflow-visible">
      <circle cx="21" cy="15" r="13.5" fill="var(--surface)" stroke="var(--text)" strokeWidth="2" />
      <circle cx="16" cy="20" r="14" fill="var(--text)" stroke="var(--surface)" strokeWidth="2" />
      <text x="16" y={20 + fs * 0.36} textAnchor="middle" fontSize={fs} fontWeight="700" fill="var(--bg)">
        {n}
      </text>
    </svg>
  );
}

/** A count on the plot; selected when it holds the selected feature, ringed as a lone mark is when it holds the one just moved. */
export function CrowdMark<T extends CountRow>({ crowd, lit, moved, hasGoal, onPick, buttonRef }: { crowd: Crowd<T>; lit: boolean; moved: boolean; hasGoal: HasGoal<T>; onPick: () => void; buttonRef?: (el: HTMLButtonElement | null) => void }) {
  const n = crowd.rows.length;
  return (
    <button
      ref={buttonRef}
      type="button"
      data-testid="vxe-crowd"
      data-count={n}
      data-moved={moved ? "true" : undefined}
      aria-label={crowdName(crowd.rows, hasGoal)}
      aria-haspopup="dialog"
      onClick={onPick}
      style={{ left: crowd.at[0], top: crowd.at[1] }}
      className={`absolute z-[5] -translate-x-1/2 -translate-y-1/2 rounded-full ${lit ? "ring-[3px] ring-accent ring-offset-2 ring-offset-surface" : moved ? "ring-2 ring-accent ring-offset-2 ring-offset-surface" : ""}`}
    >
      <CountGlyph n={n} />
    </button>
  );
}
