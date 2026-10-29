"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import type { Schemas } from "@/lib/api/client";

/**
 * The owner's flow picks (2026-10-28: A with C, and the storyboard D), drawn to the mock-ups
 * (simple-v3/talk/flow-display.html): the pieces every presentation of a flow shares, drawn
 * from the same steps. The diagram (the flow's real shapes: boxes, decision diamonds with
 * their No branch, accent step numbers) small as the row's live thumbnail, across the page in
 * the opened view, top to bottom in the full-screen viewer and on a phone; the steps in full
 * words; the screen as a wireframe of numbered regions; the storyboard's step cards. Labels
 * wrap at word ends: nothing is cut mid-word.
 */

type Flow = Schemas["SimpleFlow"];
export type FlowStep = Schemas["SimpleFlowStep"];

/** A flow's steps: its nodes, or for a bundle with none, its step words as plain steps. */
export const stepsOf = (flow: { nodes?: FlowStep[] | null; steps: string[] }): FlowStep[] =>
  flow.nodes?.length ? flow.nodes : flow.steps.map((s, i) => ({ id: `s${i + 1}`, label: s, kind: "step" as const, feature: null, change: "same" as const }));

const lower = (s: string): string => (s ? s[0].toLowerCase() + s.slice(1) : s);
/** "The sign-in page opens." as the end of a sentence ("If no: the sign-in page opens."). */
const outcome = (s: string): string => lower(s.trim());

/** Words in lines of at most `width` characters, broken only between words (a word longer than
 * the line also after its hyphens); every word is kept: the box grows to hold them. */
export function wrapWords(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    // A long hyphenated word ("alert-history-timeline") in pieces that end at a hyphen.
    const pieces = word.length > width ? (word.match(/[^-]+-*|-+/g) ?? [word]) : [word];
    pieces.forEach((w, k) => {
      const last = lines.at(-1);
      const sep = k === 0 ? " " : "";
      if (last !== undefined && (last + sep + w).length <= width) lines[lines.length - 1] = `${last}${sep}${w}`;
      else lines.push(w);
    });
  }
  return lines;
}

const LINE = 17;
const FONT = 13;
/** A label's font size: 13, or smaller when one word is wider than its room (about 0.55 em a character). */
const fontFor = (lines: string[], room: number, size = FONT): number => Math.min(size, Math.floor((room / (0.55 * Math.max(1, ...lines.map((l) => l.length)))) * 10) / 10);
/** The first baseline of `n` lines of `LINE` centred on `cy`. */
const firstLine = (cy: number, n: number, line = LINE, drop = 4.5): number => cy - ((n - 1) * line) / 2 + drop;

const NUM = { r: 11, font: 12 };

/** The step number: an accent disc with its number, as the mock-up draws it. */
function Num({ cx, cy, n }: { cx: number; cy: number; n: number }) {
  return (
    <>
      <circle cx={cx} cy={cy} r={NUM.r} fill="var(--accent)" />
      <text x={cx} y={cy + 4.5} textAnchor="middle" fontSize={NUM.font} fontWeight={700} fill="var(--on-accent)">
        {n}
      </text>
    </>
  );
}

/** Stroke of a step by what the flow changes: new in accent, changed dashed. */
const strokeOf = (s: FlowStep, decision: boolean) => ({
  stroke: decision || s.change === "new" ? "var(--accent)" : "var(--line-strong)",
  strokeDasharray: s.change === "changed" ? "6 4" : undefined,
});

/**
 * The diagram: `across` (the opened view: one row as wide as the page, a decision's No branch
 * under it; a long flow wraps to more rows), `down` (the viewer and a phone: top to bottom,
 * a decision's No branch to its right) or `mini` (the row's thumbnail: the shapes and their
 * numbers, six a row).
 */
export function FlowDiagram({
  flow,
  layout,
  testId,
  className,
  width,
}: {
  flow: { nodes?: FlowStep[] | null; steps: string[] };
  layout: "across" | "down" | "mini";
  testId?: string;
  className?: string;
  /** The drawn width in px (down: the viewer's 440, a phone's 352). */
  width?: number;
}) {
  const steps = stepsOf(flow);
  const box = useRef<SVGSVGElement>(null);
  const [room, setRoom] = useState(0);
  useEffect(() => {
    const el = box.current?.parentElement;
    if (layout !== "across" || !el) return;
    const on = () => setRoom(el.clientWidth);
    on();
    const ro = new ResizeObserver(on);
    ro.observe(el);
    return () => ro.disconnect();
  }, [layout]);
  const label = `User flow: ${steps.map((s, i) => `${i + 1} ${s.label}`).join(", then ")}`;
  const svg = (w: number, h: number, body: ReactNode, style?: React.CSSProperties, cls?: string) => (
    <svg ref={box} role="img" aria-label={label} data-testid={testId} viewBox={`0 0 ${w} ${h}`} className={className ?? cls} style={style} preserveAspectRatio="xMidYMin meet" fontFamily="var(--font-sans)">
      <defs>
        <marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="var(--line-strong)" />
        </marker>
      </defs>
      {body}
    </svg>
  );
  const arrow = (d: string, key?: string) => <path key={key} d={d} stroke="var(--line-strong)" strokeWidth={1.5} fill="none" markerEnd="url(#flow-arrow)" />;
  const yesNo = (x: number, y: number, word: "Yes" | "No", anchor: "middle" | "start" = "start") => (
    <text x={x} y={y} textAnchor={anchor} fontSize={FONT} fontWeight={600} fill="var(--text2)">
      {word}
    </text>
  );

  if (layout === "mini") {
    // The thumbnail: 20 px boxes 28 px apart, decisions as diamonds with a small No branch.
    const per = 6;
    const rows = Math.max(1, Math.ceil(steps.length / per));
    const at = (i: number) => ({ x: 4 + (i % per) * 28, dy: Math.floor(i / per) * 44 });
    const h = 56 + (rows - 1) * 44;
    return svg(
      172,
      h,
      steps.map((s, i) => {
        const { x, dy } = at(i);
        const cx = x + 10;
        const cy = 26 + dy;
        const dec = s.kind === "decision";
        const next = steps[i + 1];
        const n = next ? at(i + 1) : null;
        const link = !n ? null : n.dy === dy ? `M${x + 21} ${cy} L${n.x + (next!.kind === "decision" ? -1 : 0)} ${cy}` : `M${cx} ${cy + 14} V${cy + 24} H${n.x + 10} V${n.dy + 16}`;
        return (
          <g key={s.id}>
            {link && <path d={link} stroke="var(--line-strong)" strokeWidth={1.2} fill="none" />}
            {dec ? (
              <>
                <path d={`M${cx} ${cy - 13} L${cx + 11} ${cy} L${cx} ${cy + 13} L${cx - 11} ${cy} Z`} fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth={1.2} data-shape="decision" />
                {s.no && (
                  <>
                    <path d={`M${cx} ${cy + 13} L${cx} ${cy + 20}`} stroke="var(--line-strong)" />
                    <rect x={cx - 8} y={cy + 20} width={16} height={6} rx={2} fill="var(--surface2)" stroke="var(--line-strong)" strokeDasharray="2 1.5" />
                  </>
                )}
              </>
            ) : (
              <rect x={x} y={cy - 10} width={20} height={20} rx={4} fill="var(--surface)" stroke="var(--line-strong)" strokeWidth={1.2} data-shape="step" />
            )}
            <text x={cx} y={cy + 4} textAnchor="middle" fontSize={10} fontWeight={700} fill="var(--text)">
              {i + 1}
            </text>
          </g>
        );
      }),
      undefined,
      "block h-auto w-[150px] max-w-full",
    );
  }

  if (layout === "down") {
    // Top to bottom: 200 x 64 boxes, decisions 200 x 84 with "No" to a dashed box on the right.
    const X = 12;
    const W = 200;
    const CX = X + W / 2;
    let y = 14;
    const body: ReactNode[] = [];
    steps.forEach((s, i) => {
      const dec = s.kind === "decision";
      const lines = wrapWords(s.label, dec ? 15 : 25);
      const font = fontFor(lines, dec ? W - 70 : W - 16);
      const h = dec ? Math.max(84, 40 + lines.length * LINE) : Math.max(64, 16 + lines.length * LINE);
      const cy = y + h / 2;
      const { stroke, strokeDasharray } = strokeOf(s, dec);
      const branch = dec && s.no ? wrapWords(s.no.replace(/\.$/, ""), 13) : null;
      body.push(
        <g key={s.id}>
          {dec ? (
            <path d={`M${CX} ${y} L${X + W} ${cy} L${CX} ${y + h} L${X} ${cy} Z`} fill="var(--accent-soft)" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" data-shape="decision" />
          ) : (
            <rect x={X} y={y} width={W} height={h} rx={10} fill="var(--surface)" stroke={stroke} strokeWidth={1.5} strokeDasharray={strokeDasharray} data-shape="step" />
          )}
          <text textAnchor="middle" fontSize={font} fontWeight={dec ? 600 : 500} fill="var(--text)">
            {lines.map((l, j) => (
              <tspan key={j} x={CX} y={firstLine(cy, lines.length) + j * LINE}>
                {l}
              </tspan>
            ))}
          </text>
          <Num cx={dec ? X + 28 : X + 2} cy={dec ? y + 14 : y + 2} n={i + 1} />
        </g>,
      );
      if (branch) {
        const bh = Math.max(44, 12 + branch.length * 16);
        body.push(
          <g key={`${s.id}-no`}>
            {arrow(`M${X + W + 2} ${cy} L${X + W + 28} ${cy}`)}
            {yesNo(X + W + 8, cy - 7, "No")}
            <rect x={X + W + 30} y={cy - bh / 2} width={96} height={bh} rx={8} fill="var(--surface2)" stroke="var(--line-strong)" strokeDasharray="4 3" />
            <text textAnchor="middle" fontSize={12} fontWeight={500} fill="var(--text2)">
              {branch.map((l, j) => (
                <tspan key={j} x={X + W + 78} y={firstLine(cy, branch.length, 16, 4.2) + j * 16}>
                  {l}
                </tspan>
              ))}
            </text>
          </g>,
        );
      }
      y += h;
      if (steps[i + 1]) {
        body.push(<g key={`${s.id}-to`}>{arrow(`M${CX} ${y + 2} L${CX} ${y + 24}`)}{dec && s.no ? yesNo(CX + 6, y + 17, "Yes") : null}</g>);
        y += 26;
      }
    });
    const w = width ?? 352;
    return svg(342, y + 10, body, { width: w, maxWidth: "100%" }, "block h-auto");
  }

  // Across: 150 x 76 boxes 40 apart, decisions 150 x 100, a decision's No branch under it; a box
  // grows down with its words. Drawn at full size (13 px text on the screen): as many a row as
  // fit the room, the rows sharing the steps evenly; a room narrower than one box scrolls.
  const W = 150;
  const GAP = 40;
  const BRANCH = { w: 140, chars: 17, line: LINE };
  const fit = Math.max(1, Math.floor(((room || 1120) - 4) / (W + GAP)));
  const nRows = Math.max(1, Math.ceil(steps.length / fit));
  const per = Math.max(1, Math.ceil(steps.length / nRows));
  const drawn = steps.map((s) => {
    const dec = s.kind === "decision";
    const lines = wrapWords(s.label, dec ? 12 : 19);
    const h = dec ? Math.max(100, 50 + lines.length * LINE) : Math.max(76, 16 + lines.length * LINE);
    const branch = dec && s.no ? wrapWords(s.no.replace(/\.$/, ""), BRANCH.chars) : null;
    return { s, dec, lines, h, branch, bh: branch ? Math.max(40, 10 + branch.length * BRANCH.line) : 0 };
  });
  const rowsOf = Array.from({ length: nRows }, (_, r) => drawn.slice(r * per, r * per + per));
  // A row's middle line: half its tallest box down; its height: down to its lowest No branch.
  const mid = rowsOf.map((row) => Math.max(...row.map((d) => d.h)) / 2);
  const rowH = rowsOf.map((row, r) => Math.max(2 * mid[r], ...row.map((d) => (d.branch ? mid[r] + d.h / 2 + 48 + d.bh : 0))));
  const rowTop = rowH.map((_, r) => 20 + rowH.slice(0, r).reduce((a, h) => a + h + 36, 0));
  const across = 10 + Math.min(per, steps.length || 1) * (W + GAP) - GAP + 10;
  const height = rowTop[nRows - 1] + rowH[nRows - 1] + 8;
  const body: ReactNode[] = [];
  drawn.forEach(({ s, dec, lines, h, branch, bh }, i) => {
    const r = Math.floor(i / per);
    const c = i % per;
    const x = 10 + c * (W + GAP);
    const cy = rowTop[r] + mid[r];
    const font = fontFor(lines, dec ? W - 40 : W - 12);
    const top = cy - h / 2;
    const { stroke, strokeDasharray } = strokeOf(s, dec);
    body.push(
      <g key={s.id}>
        {dec ? (
          <path d={`M${x + W / 2} ${top} L${x + W} ${cy} L${x + W / 2} ${top + h} L${x} ${cy} Z`} fill="var(--accent-soft)" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" data-shape="decision" />
        ) : (
          <rect x={x} y={top} width={W} height={h} rx={10} fill="var(--surface)" stroke={stroke} strokeWidth={1.5} strokeDasharray={strokeDasharray} data-shape="step" />
        )}
        <text textAnchor="middle" fontSize={font} fontWeight={dec ? 600 : 500} fill="var(--text)">
          {lines.map((l, j) => (
            <tspan key={j} x={x + W / 2} y={firstLine(cy, lines.length) + j * LINE}>
              {l}
            </tspan>
          ))}
        </text>
        <Num cx={x + 6} cy={dec ? top + 4 : top - 6} n={i + 1} />
      </g>,
    );
    if (branch) {
      const bt = top + h + 48;
      body.push(
        <g key={`${s.id}-no`} data-testid="flow-no">
          {arrow(`M${x + W / 2} ${top + h} L${x + W / 2} ${bt - 2}`)}
          {yesNo(x + W / 2 + 6, bt - 22, "No")}
          <rect x={x + (W - BRANCH.w) / 2} y={bt} width={BRANCH.w} height={bh} rx={8} fill="var(--surface2)" stroke="var(--line-strong)" strokeDasharray="4 3" />
          <text textAnchor="middle" fontSize={FONT} fontWeight={500} fill="var(--text2)">
            {branch.map((l, j) => (
              <tspan key={j} x={x + W / 2} y={firstLine(bt + bh / 2, branch.length, BRANCH.line) + j * BRANCH.line}>
                {l}
              </tspan>
            ))}
          </text>
        </g>,
      );
    }
    const next = drawn[i + 1];
    if (next) {
      const nr = Math.floor((i + 1) / per);
      if (nr === r) {
        body.push(
          <g key={`${s.id}-to`}>
            {arrow(`M${x + W + 2} ${cy} L${x + W + GAP - 2} ${cy}`)}
            {dec && s.no ? yesNo(x + W + GAP / 2, cy - 8, "Yes", "middle") : null}
          </g>,
        );
      } else {
        // The next row: out of the right side, down past this row, back to the next row's first step.
        const ny = rowTop[nr] + mid[nr] - next.h / 2;
        const nx = 10 + W / 2;
        body.push(<g key={`${s.id}-to`}>{arrow(`M${x + W + 2} ${cy} H${x + W + 12} V${rowTop[r] + rowH[r] + 18} H${nx} V${ny - 2}`)}</g>);
      }
    }
  });
  const vw = across + (nRows > 1 ? 12 : 0);
  // One user unit a pixel, so 13 px text reads 13 px; the diagram scrolls in its own box if wider.
  return <div className="max-w-full overflow-x-auto">{svg(vw, height, body, { width: vw, maxWidth: "none" }, "block h-auto")}</div>;
}

/** The mock-up's step marker: an accent disc, or for a decision a turned square. */
function StepMark({ n, decision }: { n: number; decision: boolean }) {
  return decision ? (
    <span aria-hidden className="m-[3px] grid h-[22px] w-[22px] rotate-45 place-items-center rounded-md bg-accent text-[13px] leading-none font-bold text-on-accent">
      <span className="-rotate-45">{n}</span>
    </span>
  ) : (
    <span aria-hidden className="grid h-7 w-7 place-items-center rounded-full bg-accent text-[13px] leading-none font-bold text-on-accent">
      {n}
    </span>
  );
}

/** A step's extras the API gives: the feature it uses, and New or Changed. */
function StepExtras({ s }: { s: FlowStep }) {
  return (
    <>
      {s.feature ? <span className="text-text2"> · {s.feature}</span> : null}
      {s.change !== "same" && (
        <>
          {" "}
          <span className="ml-0.5 inline-flex rounded-full bg-pass-bg px-2 align-[1px] text-[12px] leading-5 font-semibold text-pass">{s.change === "new" ? "New" : "Changed"}</span>
        </>
      )}
    </>
  );
}

/** Every step in full words, numbered and joined by a line; a decision with what No leads to.
 * `boxed` (the full-screen viewer): each step in its own box, decisions tinted. */
export function FlowStepList({ flow, boxed = false }: { flow: Flow; boxed?: boolean }) {
  const steps = stepsOf(flow);
  return (
    <ol className="flex flex-col" data-testid="flow-steps" aria-label="Steps">
      {steps.map((s, i) => {
        const dec = s.kind === "decision";
        return (
          <li key={s.id} className="relative grid grid-cols-[28px_1fr] gap-2.5 pb-3">
            {i < steps.length - 1 && <span aria-hidden className="absolute top-7 bottom-0 left-[13px] w-0.5 bg-line" />}
            <StepMark n={i + 1} decision={dec} />
            <span className={`min-w-0 text-[15px] leading-[22px] break-words ${boxed ? `rounded-[10px] border px-2.5 py-2 ${dec ? "border-accent-mid bg-accent-soft" : "border-line bg-surface"}` : ""}`}>
              <span className="sr-only">{i + 1} </span>
              {dec ? <b className="font-[650]">Decision: </b> : null}
              {s.label}
              <StepExtras s={s} />
              {dec && s.no ? (
                <>
                  {" "}
                  <span className="mt-0.5 block text-[13px] leading-[18px] text-text2">If no: {outcome(s.no)}</span>
                </>
              ) : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** The screen the flow touches as the mock-up's wireframe: its regions as numbered dashed boxes,
 * the first across the top, the rest in two columns. */
export function FlowScreen({ flow, size = 12 }: { flow: Flow; size?: number }) {
  if (!flow.touches_screen) return <p className="text-[15px] text-text2">It touches no screen.</p>;
  const regions = flow.screen.regions;
  const rest = regions.slice(1);
  const half = Math.ceil(rest.length / 2);
  const region = (r: string, n: number) => (
    <div key={`${n}-${r}`} className="flex min-w-0 flex-col gap-[5px] rounded-lg border-[1.5px] border-dashed border-line-strong px-2 py-1.5" data-testid="flow-region">
      <b className="flex items-center gap-1.5 font-[650] text-text" style={{ fontSize: size, lineHeight: "16px" }}>
        <i className="grid h-4 w-4 flex-none place-items-center rounded-full bg-text text-[10px] not-italic text-surface">{n}</i>
        <span className="min-w-0 break-words">{r}</span>
      </b>
      <span aria-hidden className="block h-[7px] w-full rounded bg-surface2" />
      <span aria-hidden className="block h-[7px] w-4/5 rounded bg-surface2" />
    </div>
  );
  return (
    <div role="img" aria-label={`Wireframe of ${flow.screen.title}: ${regions.join(", ")}`} data-testid="flow-regions" className="grid gap-2 rounded-[10px] border border-line-strong bg-surface p-2.5 font-medium text-text2" style={{ fontSize: size, lineHeight: "16px" }}>
      {regions[0] !== undefined && region(regions[0], 1)}
      {rest.length === 1 && region(rest[0], 2)}
      {rest.length > 1 && (
        <div className="grid grid-cols-[1fr_1.25fr] gap-2">
          <div className="grid content-start gap-2">{rest.slice(0, half).map((r, i) => region(r, i + 2))}</div>
          <div className="grid content-start gap-2">{rest.slice(half).map((r, i) => region(r, i + 2 + half))}</div>
        </div>
      )}
    </div>
  );
}

/** Who does a step, in a word ("User", "App", "Admin"); a drawing made before Oracle said so: by its kind. */
export const who = (s: FlowStep): string => s.actor || (s.kind === "decision" ? "App" : "User");

/** One storyboard card: its number, who does it, the step in full words, a decision's Yes and No.
 * `big`: a phone's one card at a time. */
export function StoryCard({ s, n, big = false }: { s: FlowStep; n: number; big?: boolean }) {
  const dec = s.kind === "decision";
  return (
    <li
      data-testid="story-card"
      aria-label={`Step ${n}`}
      className={`flex flex-none flex-col gap-1.5 rounded-xl border ${dec ? "border-accent-mid bg-accent-soft" : "border-line bg-surface"} ${big ? "w-full px-[18px] py-4 text-[17px] leading-[26px]" : "w-[128px] px-3 py-2.5 text-[14px] leading-5"}`}
    >
      <div className="flex items-center gap-1.5">
        <span className={`grid flex-none place-items-center bg-accent leading-none font-bold text-on-accent ${dec ? "rounded-[5px]" : "rounded-full"} ${big ? "h-7 w-7 text-[14px]" : "h-[22px] w-[22px] text-[12px]"}`}>{n}</span>
        <span data-testid="story-who" className={`ml-auto font-semibold text-text2 ${big ? "text-[14px] leading-5" : "text-[13px] leading-4"}`}>
          {who(s)}
        </span>
      </div>
      <p className={`break-words ${big ? "mt-1.5" : ""}`}>
        {dec && big ? <b className="font-[650]">Decision: </b> : null}
        {s.label}
      </p>
      {dec && (s.yes || s.no) && (
        <p data-testid="story-yes-no" className={`mt-auto border-t border-dashed border-line-strong pt-1.5 font-medium text-text2 ${big ? "text-[15px] leading-[22px]" : "text-[12px] leading-[17px]"}`}>
          {s.yes && (
            <>
              <b className="font-[650] text-text">Yes:</b> {outcome(s.yes)}
            </>
          )}
          {s.yes && s.no && <br />}
          {s.no && (
            <>
              <b className="font-[650] text-text">No:</b> {outcome(s.no)}
            </>
          )}
        </p>
      )}
    </li>
  );
}

/** The storyboard's last card: the screen, its regions, Open the screen. */
export function ScreenCard({ flow, onOpen, big = false }: { flow: Flow; onOpen: () => void; big?: boolean }) {
  return (
    <li data-testid="story-card" aria-label="The screen" className={`flex flex-none flex-col gap-1.5 rounded-xl border border-line bg-surface2 ${big ? "w-full px-[18px] py-4 text-[17px] leading-[26px]" : "w-[181px] px-3 py-2.5 text-[14px] leading-5"}`}>
      <div className="flex items-center gap-1.5">
        <span className={`grid flex-none place-items-center rounded-[5px] bg-text leading-none font-bold text-surface ${big ? "h-7 w-7 text-[14px]" : "h-[22px] w-[22px] text-[12px]"}`}>S</span>
        <span className={`ml-auto font-semibold text-text2 ${big ? "text-[14px] leading-5" : "text-[13px] leading-4"}`}>Screen</span>
      </div>
      <p className="font-[650] break-words">{flow.screen.title}</p>
      <ol className="flex flex-col gap-px text-[13px] leading-[18px] text-text2">
        {flow.screen.regions.map((r, i) => (
          <li key={`${i}-${r}`}>
            {i + 1} {r}
          </li>
        ))}
      </ol>
      <button type="button" onClick={onOpen} className="mt-auto inline-flex h-8 items-center self-start rounded-lg border border-line-strong bg-surface px-3 text-[14px] font-semibold whitespace-nowrap text-text hover:bg-surface2">
        Open the screen
      </button>
    </li>
  );
}

/** The mock-up's line icons (24 px grid, drawn in the current colour). */
export function Icon({ d, size = 16, width = 2 }: { d: string; size?: number; width?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="flex-none">
      {d.split("|").map((p) => (p.startsWith("c") ? <circle key={p} cx={p.split(",")[1]} cy={p.split(",")[2]} r={p.split(",")[3]} /> : p.startsWith("r") ? <rect key={p} x={p.split(",")[1]} y={p.split(",")[2]} width={p.split(",")[3]} height={p.split(",")[4]} rx={p.split(",")[5]} /> : <path key={p} d={p} />))}
    </svg>
  );
}

export const ICONS = {
  roadmap: "M4 6h6M4 12h10M4 18h16|c,12,6,2|c,16,12,2",
  sparkle: "M12 4l1.8 4.7L18.5 10.5l-4.7 1.8L12 17l-1.8-4.7L5.5 10.5l4.7-1.8z",
  warn: "M12 4l9 16H3z|M12 10v4M12 17v.5",
  retry: "M4 12a8 8 0 1 0 2.4-5.7|M4 4v4h4",
  expand: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  back: "M15 6l-6 6 6 6",
  next: "M9 6l6 6-6 6",
  close: "M6 6l12 12M18 6L6 18",
  ask: "c,12,12,8|M9.8 9.5a2.3 2.3 0 114 1.6c-.8.6-1.8 1.1-1.8 2.4M12 16.5v.5",
  lock: "r,5,11,14,9,2|M8 11V8a4 4 0 018 0v3",
  doc: "M6 3h8l4 4v14H6z|M14 3v4h4M9 12h6M9 16h6",
} as const;

/** An item's code as the mock-ups chip it ("F-06"): mono, on the second surface. */
export function Code({ code, className = "" }: { code: string; className?: string }) {
  return <span className={`rounded-md bg-surface2 px-1.5 font-mono text-[13px] leading-5 font-semibold whitespace-nowrap text-text ${className}`}>{code}</span>;
}

/** The selected part of the mock-ups' segmented control: a soft shadow in light, a line in dark. */
const SEG_ON: React.CSSProperties = { boxShadow: "0 1px 2px light-dark(rgba(13,23,36,.12), transparent), 0 0 0 1px light-dark(transparent, var(--line))" };

/** The mock-ups' segmented control (Details | Talk to Oracle; Diagram | Steps | Screen): one tab a part. */
export function Tabs<T extends string>({ label, items, value, onChange, className = "" }: { label: string; items: { value: T; label: string }[]; value: T; onChange: (v: T) => void; className?: string }) {
  return (
    <div role="tablist" aria-label={label} className={`grid auto-cols-fr grid-flow-col gap-0.5 rounded-[10px] bg-surface2 p-[3px] ${className}`}>
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          role="tab"
          aria-selected={value === it.value}
          onClick={() => onChange(it.value)}
          style={value === it.value ? SEG_ON : undefined}
          className={`grid h-[30px] place-items-center rounded-lg px-3 text-[14px] leading-none whitespace-nowrap ${value === it.value ? "bg-surface font-semibold text-text" : "font-medium text-text2"}`}
        >
          {it.label}
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
