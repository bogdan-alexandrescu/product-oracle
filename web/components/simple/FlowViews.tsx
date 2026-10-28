"use client";

import { useEffect, useRef, useState } from "react";

import type { Schemas } from "@/lib/api/client";

/**
 * The owner's flow picks (2026-10-28: A with C, and the storyboard D): the pieces every
 * presentation of a flow shares, drawn from the same steps. The diagram (the flow's real
 * shapes: boxes, decision diamonds, step numbers) small as the row's live thumbnail, across
 * the page in the opened view, top to bottom in the full-screen viewer; the steps in full
 * words; the storyboard (one card per step, the screen last). Labels wrap at word ends:
 * nothing is cut mid-word.
 */

type Flow = Schemas["SimpleFlow"];
export type FlowStep = Schemas["SimpleFlowStep"];

/** A flow's steps: its nodes, or for a bundle with none, its step words as plain steps. */
export const stepsOf = (flow: { nodes?: FlowStep[] | null; steps: string[] }): FlowStep[] =>
  flow.nodes?.length ? flow.nodes : flow.steps.map((s, i) => ({ id: `s${i + 1}`, label: s, kind: "step" as const, feature: null, change: "same" as const }));

const lower = (s: string): string => (s ? s[0].toLowerCase() + s.slice(1) : s);

/** A step in full words: "Decision: Is the user signed in? If yes: the plan opens. If no: ...". */
export function stepWords(s: FlowStep): string {
  if (s.kind !== "decision") return s.label;
  return [`Decision: ${s.label}`, s.yes ? `If yes: ${lower(s.yes)}` : "", s.no ? `If no: ${lower(s.no)}` : ""].filter(Boolean).join(" ");
}

/** Words in lines of at most `width` characters, broken only between words; past `max`
 * lines the last line ends at a whole word with "…" (a long single word keeps its room). */
export function wrapWords(text: string, width: number, max = 3): string[] {
  const lines: string[] = [];
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const last = lines.at(-1);
    if (last !== undefined && (last + " " + w).length <= width) lines[lines.length - 1] = `${last} ${w}`;
    else lines.push(w);
  }
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, max);
  kept[max - 1] = `${kept[max - 1]}…`;
  return kept;
}

const W = 150;
const GAP = 34;
const LINE = 17;

/**
 * The diagram: `across` (the opened view, fitted to the width), `down` (the viewer's left
 * column) or `mini` (the row's thumbnail: the shapes and numbers, no words).
 */
export function FlowDiagram({ flow, layout, testId }: { flow: { nodes?: FlowStep[] | null; steps: string[] }; layout: "across" | "down" | "mini"; testId?: string }) {
  const steps = stepsOf(flow);
  const mini = layout === "mini";
  const down = layout === "down";
  const shapes = steps.map((s) => {
    const lines = mini ? [] : wrapWords(s.label, s.kind === "decision" ? 14 : 17, s.kind === "decision" ? 3 : 3);
    const h = mini ? (s.kind === "decision" ? 64 : 44) : Math.max(s.kind === "decision" ? 100 : 60, 28 + lines.length * LINE + (s.kind === "decision" ? 30 : 0));
    return { s, lines, h };
  });
  const tallest = Math.max(...shapes.map((x) => x.h), 44);
  const placed = shapes.map((x, i) => ({ ...x, at: 12 + shapes.slice(0, i).reduce((sum, y) => sum + (down ? y.h : W) + GAP, 0) }));
  const end = placed.length ? placed[placed.length - 1].at + (down ? placed[placed.length - 1].h : W) : 12;
  const width = down ? W + 24 : end + 12;
  const height = down ? end + 12 : tallest + 24;
  const label = `User flow: ${steps.map((s, i) => `${i + 1} ${s.label}`).join(", then ")}`;
  return (
    <svg
      role="img"
      aria-label={label}
      data-testid={testId}
      viewBox={`0 0 ${width} ${height}`}
      className={mini ? "h-12 w-auto max-w-[180px] text-text" : down ? "mx-auto w-full max-w-[220px] text-text" : "w-full text-text"}
      preserveAspectRatio="xMidYMin meet"
    >
      {placed.map(({ s, lines, h, at }, i) => {
        const x = down ? 12 : at;
        const y = down ? at : 12 + (tallest - h) / 2;
        const cx = x + W / 2;
        const cy = y + h / 2;
        const stroke = s.change === "new" ? "var(--accent)" : "var(--line-strong)";
        const next = placed[i + 1];
        return (
          <g key={s.id}>
            {next &&
              (down ? (
                <path d={`M${cx} ${y + h} V${next.at - 2}`} stroke="var(--line-strong)" strokeWidth={1.5} markerEnd="url(#flow-arrow)" fill="none" />
              ) : (
                <path d={`M${x + W} ${12 + tallest / 2} H${next.at - 2}`} stroke="var(--line-strong)" strokeWidth={1.5} markerEnd="url(#flow-arrow)" fill="none" />
              ))}
            {s.kind === "decision" ? (
              <polygon points={`${cx},${y} ${x + W},${cy} ${cx},${y + h} ${x},${cy}`} fill="var(--surface2)" stroke={stroke} strokeWidth={s.change === "new" ? 2.5 : 1.5} data-shape="decision" />
            ) : (
              <rect x={x} y={y} width={W} height={h} rx={10} fill="var(--surface)" stroke={stroke} strokeWidth={s.change === "new" ? 2.5 : 1.5} strokeDasharray={s.change === "changed" ? "6 4" : undefined} data-shape="step" />
            )}
            <circle cx={x + 14} cy={y + 14} r={mini ? 12 : 11} fill="var(--text)" />
            <text x={x + 14} y={y + 18.5} textAnchor="middle" fontSize={mini ? 15 : 12} fontWeight={700} fill="var(--surface)">
              {i + 1}
            </text>
            {lines.map((l, j) => (
              <text key={j} x={cx} y={cy - ((lines.length - 1) * LINE) / 2 + j * LINE + 5} textAnchor="middle" fontSize={13} fill="currentColor">
                {l}
              </text>
            ))}
          </g>
        );
      })}
      <defs>
        <marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="var(--line-strong)" />
        </marker>
      </defs>
    </svg>
  );
}

/** Every step in full words, numbered: a decision with what its Yes and No lead to. */
export function FlowStepList({ flow }: { flow: Flow }) {
  return (
    <ol className="space-y-2" data-testid="flow-steps" aria-label="Steps">
      {stepsOf(flow).map((s, i) => (
        <li key={s.id} className="flex gap-2">
          <span className="inline-flex h-6 w-6 flex-none items-center justify-center rounded-full bg-text text-[13px] font-bold text-surface" aria-hidden>
            {i + 1}
          </span>
          <span className="min-w-0 break-words">
            <span className="sr-only">{i + 1} </span>
            {s.kind === "decision" ? <span className="font-semibold">Decision: </span> : null}
            {s.label}
            {s.kind === "decision" && s.yes ? <span> If yes: {lower(s.yes)}</span> : null}
            {s.kind === "decision" && s.no ? <span> If no: {lower(s.no)}</span> : null}
            {s.feature ? <span className="text-text2"> · {s.feature}</span> : null}
            {s.change !== "same" && (
              <span className="ml-1 rounded bg-accent-soft px-1 text-[length:var(--simple-small)] font-semibold text-accent-ink">{s.change === "new" ? "New" : "Changed"}</span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** The screen the flow touches as a labelled wireframe: its title and its regions top to bottom. */
export function FlowScreen({ flow, compact }: { flow: Flow; compact?: boolean }) {
  if (!flow.touches_screen) return <p className="text-text2">It touches no screen.</p>;
  return (
    <div role="img" aria-label={`Wireframe of ${flow.screen.title}`} data-testid="flow-screen" className={`rounded-lg border border-line-strong bg-surface ${compact ? "p-2" : "p-3"}`}>
      <p className="mb-2 font-semibold">{flow.screen.title}</p>
      <div className="flex flex-col gap-1.5">
        {flow.screen.regions.map((r, i) => (
          <div key={`${i}-${r}`} className="flex items-baseline gap-2 rounded border border-dashed border-line-strong bg-surface2 px-2 py-1.5 text-[length:var(--simple-small)]">
            <span className="text-text2">Part {i + 1}</span>
            <span className="min-w-0 break-words">{r}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Who does a step, in a word ("User", "App", "Admin"); a drawing made before Oracle said so: by its kind. */
const who = (s: FlowStep): string => s.actor || (s.kind === "decision" ? "App" : "User");

/**
 * The storyboard: each step a card in a row (its number, who does it, the step in full
 * words, for a decision what Yes and No lead to), the screen as the last card. On a phone
 * one card at a time: swipe, or Previous / Next.
 */
export function FlowStoryboard({ flow, phone }: { flow: Flow; phone: boolean }) {
  const steps = stepsOf(flow);
  const total = steps.length + (flow.touches_screen ? 1 : 0);
  const row = useRef<HTMLOListElement>(null);
  const [at, setAt] = useState(0);
  useEffect(() => {
    const el = row.current;
    if (!el || !phone) return;
    const on = () => setAt(Math.min(total - 1, Math.max(0, Math.round(el.scrollLeft / Math.max(1, el.clientWidth)))));
    el.addEventListener("scroll", on, { passive: true });
    return () => el.removeEventListener("scroll", on);
  }, [phone, total]);
  const go = (n: number) => {
    const el = row.current;
    const to = Math.min(total - 1, Math.max(0, n));
    setAt(to);
    el?.scrollTo({ left: to * el.clientWidth, behavior: "instant" as ScrollBehavior });
  };
  const card = phone ? "w-full flex-none snap-center" : "w-[240px] flex-none";
  return (
    <div data-testid="flow-storyboard">
      <ol ref={row} aria-label="Storyboard" className={`flex gap-3 overflow-x-auto pb-2 ${phone ? "snap-x snap-mandatory" : ""}`}>
        {steps.map((s, i) => (
          <li key={s.id} className={`${card} rounded-xl border border-line-strong bg-surface p-3`} data-testid="story-card" aria-label={`Step ${i + 1} of ${steps.length}`}>
            <div className="flex items-center gap-2">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-text text-sm font-bold text-surface">{i + 1}</span>
              <span className="rounded-full bg-surface2 px-2 text-[length:var(--simple-small)] font-semibold" data-testid="story-who">
                {who(s)}
              </span>
              {s.change !== "same" && <span className="rounded bg-accent-soft px-1 text-[length:var(--simple-small)] font-semibold text-accent-ink">{s.change === "new" ? "New" : "Changed"}</span>}
            </div>
            <p className="mt-2 break-words">{s.kind === "decision" ? <><span className="font-semibold">Decision: </span>{s.label}</> : s.label}</p>
            {s.kind === "decision" && (s.yes || s.no) && (
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[length:var(--simple-small)]" data-testid="story-yes-no">
                {s.yes && (
                  <>
                    <dt className="font-semibold">Yes</dt>
                    <dd className="break-words">{s.yes}</dd>
                  </>
                )}
                {s.no && (
                  <>
                    <dt className="font-semibold">No</dt>
                    <dd className="break-words">{s.no}</dd>
                  </>
                )}
              </dl>
            )}
          </li>
        ))}
        {flow.touches_screen && (
          <li className={`${card} rounded-xl border border-line-strong bg-surface p-3`} data-testid="story-card" aria-label="The screen">
            <p className="mb-2 text-[length:var(--simple-small)] font-semibold text-text2">The screen</p>
            <FlowScreen flow={flow} compact />
          </li>
        )}
      </ol>
      {phone && (
        <div className="mt-2 flex items-center justify-between gap-2">
          <button type="button" className="h-11 rounded-lg border border-line-strong px-3 disabled:text-text2" disabled={at === 0} onClick={() => go(at - 1)}>
            Previous
          </button>
          <span data-testid="story-at" aria-live="polite">
            Card {at + 1} of {total}
          </span>
          <button type="button" className="h-11 rounded-lg border border-line-strong px-3 disabled:text-text2" disabled={at === total - 1} onClick={() => go(at + 1)}>
            Next
          </button>
        </div>
      )}
    </div>
  );
}

/** The [Diagram | Storyboard] switch of the opened view and the viewer. */
export function ViewSwitch({ value, onChange }: { value: "diagram" | "storyboard"; onChange: (v: "diagram" | "storyboard") => void }) {
  return (
    <div role="group" aria-label="Show the flow as" className="inline-flex overflow-hidden rounded-button border border-line-strong bg-surface">
      {(["diagram", "storyboard"] as const).map((v) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)} className={`h-9 px-3 font-medium ${value === v ? "bg-accent text-on-accent" : "text-text hover:bg-surface2"}`}>
          {v === "diagram" ? "Diagram" : "Storyboard"}
        </button>
      ))}
    </div>
  );
}

const PHONE = "(max-width: 640px)";
export function usePhone(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const q = window.matchMedia(PHONE);
    const on = () => setPhone(q.matches);
    on();
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return phone;
}
