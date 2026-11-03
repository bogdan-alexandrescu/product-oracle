"use client";
/* eslint-disable react-hooks/set-state-in-effect -- MOCK-HOOK: the switches are read once in the browser */

// MOCK-HOOK: the whole file. Mock-ups for "Desired state and Current state" (CS1 how Current state
// is shown and kept true, CS2 the new / in progress / exists mark, CS3 how a feature moves).
// Switched on by ?cs1=a|b|c, ?cs2=a|b|c, ?cs3=a|b|c with &phase=rest|open|mid|done and &hard=1.

import { useEffect, useState, type ReactNode } from "react";

import { Button, Page, PageHeader } from "@/components/ds";
import { CS_AREAS, CS_FEATURES, CS_STAGE_WORD, type CsFeature, type Stage } from "@/lib/api/mock/currentstate";

export type Cs = { cs1: string | null; cs2: string | null; cs3: string | null; phase: string; hard: boolean }; // MOCK-HOOK

/** MOCK-HOOK: the switches, read from the URL once the page is in the browser. */
export function useCs(): Cs | null {
  const [cs, setCs] = useState<Cs | null>(null);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const theme = p.get("theme");
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
    if (!p.get("cs1") && !p.get("cs2") && !p.get("cs3")) return;
    setCs({ cs1: p.get("cs1"), cs2: p.get("cs2"), cs3: p.get("cs3"), phase: p.get("phase") ?? "rest", hard: p.get("hard") === "1" });
  }, []);
  return cs;
}

const BY_NAME = new Map(CS_FEATURES.map((f) => [f.name, f])); // MOCK-HOOK
export const csFeature = (name: string) => BY_NAME.get(name); // MOCK-HOOK

/* ------------------------------------------------------------------ CS2: the mark */

function Glyph({ stage, stale, size = 14 }: { stage: Stage; stale?: boolean; size?: number }) {
  const r = size / 2 - 1.5;
  const c = size / 2;
  const tone = stage === "exists" ? (stale ? "var(--warn)" : "var(--pass)") : stage === "progress" ? "var(--warn)" : "var(--accent-ink)";
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="flex-none">
      <circle cx={c} cy={c} r={r} fill={stage === "exists" ? tone : "none"} stroke={tone} strokeWidth={1.8} strokeDasharray={stage === "new" ? "2.4 2" : undefined} />
      {stage === "progress" && <path d={`M${c} ${c - r} A${r} ${r} 0 0 1 ${c} ${c + r} Z`} fill={tone} />}
      {stage === "exists" && !stale && <path d={`M${c - r / 2} ${c} l${r / 2.6} ${r / 2.4} l${r / 1.4} -${r / 1.1}`} stroke="var(--surface)" strokeWidth={1.6} fill="none" strokeLinecap="round" />}
      {stage === "exists" && stale && <text x={c} y={c + 0.5} textAnchor="middle" dominantBaseline="central" fontSize={size * 0.7} fontWeight={800} fill="var(--surface)">!</text>}
    </svg>
  );
}

/** The mark, as each CS2 proposal draws it. compact: on a narrow spot (a bar, a phone row). */
export function FeatureMark({ variant, stage, stale, compact = false }: { variant: string; stage: Stage; stale?: boolean; compact?: boolean }) {
  const word = stage === "exists" && stale ? "Exists · proof old" : CS_STAGE_WORD[stage];
  if (variant === "b") {
    const cls = stage === "exists" ? (stale ? "bg-warn-bg text-warn" : "bg-pass-bg text-pass") : stage === "progress" ? "bg-warn-bg text-warn" : "bg-accent-soft text-accent-ink";
    return (
      <span data-testid="cs-mark" title={word} className={`inline-flex flex-none items-center whitespace-nowrap rounded-full px-2 py-px text-[12px] font-semibold uppercase tracking-wide ${cls}`}>
        {compact && stage === "exists" && stale ? "Exists ·!" : stage === "exists" && stale ? word : CS_STAGE_WORD[stage]}
      </span>
    );
  }
  if (variant === "c") {
    const bg =
      stage === "exists"
        ? stale
          ? "repeating-linear-gradient(0deg, var(--warn) 0 3px, transparent 3px 5px)"
          : "var(--pass)"
        : stage === "progress"
          ? "linear-gradient(0deg, var(--warn) 50%, transparent 50%)"
          : "transparent";
    return (
      <span data-testid="cs-mark" title={word} aria-label={word} className="inline-block h-5 w-1.5 flex-none rounded-full" style={{ background: bg, boxShadow: stage === "new" ? "inset 0 0 0 1.5px var(--accent-ink)" : stage === "progress" ? "inset 0 0 0 1.5px var(--warn)" : undefined }} />
    );
  }
  return (
    <span data-testid="cs-mark" title={word} className={`inline-flex flex-none items-center gap-1 whitespace-nowrap text-[12px] font-semibold ${stage === "exists" ? (stale ? "text-warn" : "text-pass") : stage === "progress" ? "text-warn" : "text-accent-ink"}`}>
      <Glyph stage={stage} stale={stale} />
      {!compact && <span>{word}</span>}
    </span>
  );
}

const MEANS: Record<Stage, string> = {
  new: "Asked for or planned. Nothing built yet.",
  progress: "Being built: some pull requests merged, tasks still open.",
  exists: "Runs today, with proof: code, merged pull requests, done tasks and a measured value.",
};

function Legend({ variant, counts, pick, pressed }: { variant: string; counts: Record<Stage, number>; pick?: Stage | null; pressed?: Stage | null }) {
  const total = counts.new + counts.progress + counts.exists;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[length:var(--simple-small)]" data-testid="cs-legend" role="group" aria-label="Show features that are">
      <span className="mr-1 text-text2">Show</span>
      <button className={`rounded-full border px-3 py-1 ${!pick ? "border-accent bg-accent-soft font-semibold text-accent-ink" : "border-line bg-surface"}`}>All {total}</button>
      {(["new", "progress", "exists"] as Stage[]).map((s) => (
        <button key={s} className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 ${pick === s ? "border-accent bg-accent-soft font-semibold text-accent-ink" : "border-line bg-surface"} ${pressed === s ? "ring-2 ring-accent ring-offset-1" : ""}`}>
          <FeatureMark variant={variant} stage={s} compact={variant !== "b"} />
          {variant !== "b" && <span>{CS_STAGE_WORD[s]}</span>}
          <span className="tabular-nums text-text2">{counts[s]}</span>
        </button>
      ))}
    </div>
  );
}

/** The mark's explainer, opened from a row's mark. */
function MarkCard({ variant, f }: { variant: string; f: CsFeature }) {
  return (
    <div role="dialog" aria-label={`${f.name}: ${CS_STAGE_WORD[f.stage]}`} className="absolute left-0 top-full z-30 mt-2 w-[360px] max-w-[calc(100vw-24px)] rounded-xl border border-line bg-surface p-4 text-[14px] shadow-xl" data-testid="cs-mark-card">
      <div className="mb-2 flex items-center gap-2">
        <FeatureMark variant={variant} stage={f.stage} stale={f.stale} />
        <span className="font-semibold">{f.name}</span>
      </div>
      <p className="mb-3 text-text2">{MEANS[f.stage]}</p>
      <ul className="space-y-1">
        <li>{f.prs} merged pull requests</li>
        <li>
          {f.tasks?.[0]} of {f.tasks?.[1]} tracker tasks done
        </li>
        <li>{f.measured ?? "No measured value yet"}</li>
      </ul>
      <p className="mt-3 text-[13px] text-text2">It moves to Current state once it ships and its proof is in.</p>
    </div>
  );
}

/** Priorities' ranked rows, replaced with the 60 mock features (MOCK-HOOK). */
const ORDER: number[] = (() => {
  // In progress near the top, a few existing ones spread through, the new ones after.
  const progress = [10, 11, 12, 13, 14, 15];
  const exists = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const slots: Record<number, number> = { 0: progress[0], 1: progress[1], 3: progress[2], 5: progress[3], 8: progress[4], 11: progress[5], 2: exists[1], 6: exists[2], 13: exists[0], 19: exists[3], 26: exists[4], 32: exists[5], 39: exists[6], 46: exists[7], 52: exists[8], 58: exists[9] };
  let n = 16;
  return Array.from({ length: 60 }, (_, i) => slots[i] ?? n++);
})();

export function csPriorityRows<R extends { title: string; feature_id: string; code: string; short_code?: string | null; rank: number; above_line: boolean; oracle_rank?: number | null }>(rows: R[], cs: Cs | null): R[] {
  if (!cs?.cs2 || rows.length === 0) return rows;
  const all = ORDER.map((k, i) => {
    const f = CS_FEATURES[k];
    const base = rows[i % rows.length];
    return { ...base, title: f.name, feature_id: `cs-${f.id}`, code: `F-${String(i + 1).padStart(2, "0")}`, short_code: `F-${f.id.slice(2)}`, rank: i + 1, oracle_rank: i + 1, above_line: i < 14 };
  });
  const shown = cs.phase === "done" ? all.filter((r) => csFeature(r.title)?.stage === "new") : all;
  return cs.hard || cs.phase === "done" ? shown : shown.slice(0, 18);
}

/** The strip above Priorities' list (the proposal's filter) and its explainer. */
export function CsPrioBar({ cs }: { cs: Cs | null }) {
  if (!cs?.cs2) return null;
  const counts = { new: 44, progress: 6, exists: 10 };
  return (
    <div className="mb-3" data-testid="cs-prio-bar">
      <Legend variant={cs.cs2} counts={counts} pick={cs.phase === "done" ? "new" : null} pressed={cs.phase === "mid" ? "new" : null} />
      {cs.phase === "done" && <p className="mt-2 text-[length:var(--simple-small)] text-text2">44 new features: nothing built for these yet. Ranks stay as in the full list.</p>}
    </div>
  );
}

/** A Priorities row's mark; the second row's opens its explainer at phase=open. */
export function CsRowMark({ title }: { title: string }) {
  const cs = useCs();
  const f = cs?.cs2 ? csFeature(title) : undefined;
  if (!cs?.cs2 || !f) return null;
  const open = cs.phase === "open" && f.name === CS_FEATURES[ORDER[0]].name;
  return (
    <span className="relative inline-flex">
      <button className={`inline-flex items-center rounded-md ${open ? "ring-2 ring-accent ring-offset-2" : ""}`} aria-expanded={open} aria-label={`What ${CS_STAGE_WORD[f.stage]} means`}>
        <FeatureMark variant={cs.cs2} stage={f.stage} stale={f.stale} compact={false} />
      </button>
      {open && <MarkCard variant={cs.cs2} f={f} />}
    </span>
  );
}

/* ------------------------------------------------------------------ the Detailed page */

const desired = CS_FEATURES.filter((f) => f.stage !== "exists");
const current = CS_FEATURES.filter((f) => f.stage === "exists");

function Tabs({ view, moved = 0 }: { view: "desired" | "current"; moved?: number }) {
  return (
    <div role="tablist" className="mb-4 flex gap-1 border-b border-line" data-testid="cs-tabs">
      {[
        { k: "desired", label: "Desired state", n: desired.length - moved, tip: "What the product should become" },
        { k: "current", label: "Current state", n: current.length + moved, tip: "What runs today" },
      ].map((t) => (
        <button key={t.k} role="tab" aria-selected={view === t.k} title={t.tip} className={`-mb-px border-b-2 px-3 py-2 text-[14px] ${view === t.k ? "border-accent font-semibold text-text" : "border-transparent text-text2"}`}>
          {t.label} <span className="tabular-nums text-text2">{t.n}</span>
        </button>
      ))}
    </div>
  );
}

function Proof({ f, wide = true }: { f: CsFeature; wide?: boolean }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px] text-text2">
      <span title="Code map">{f.files} files</span>
      <span title="Merged pull requests">{f.prs} pull requests</span>
      <span title="Tracker tasks marked done">
        {f.tasks?.[0]}/{f.tasks?.[1]} tasks
      </span>
      {wide && <span title="Measured value" className="text-text">{f.measured}</span>}
    </span>
  );
}

function Fresh({ f, phase, focus }: { f: CsFeature; phase: string; focus: boolean }) {
  if (focus && phase === "mid") return <span className="text-[13px] text-accent-ink">Checking now…</span>;
  if (focus && phase === "done") return <span className="text-[13px] font-semibold text-pass">Checked Nov 3 · you confirmed</span>;
  if (f.stale) return <span className="whitespace-nowrap rounded-full bg-warn-bg px-2 py-0.5 text-[13px] font-semibold text-warn">Proof is 41 days old</span>;
  return <span className="whitespace-nowrap text-[13px] text-text2">Checked {f.checked}</span>;
}

const STALE = current.find((f) => f.stale)!;

/** CS1 a: the proof table. */
function ProofTable({ phase, phone }: { phase: string; phone: boolean }) {
  const open = phase !== "rest";
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface" data-testid="cs1-table">
      {!phone && (
        <div className="grid grid-cols-[minmax(170px,1.2fr)_96px_minmax(200px,2fr)_minmax(150px,1fr)] gap-3 border-b border-line bg-surface2 px-4 py-2 text-[12px] font-semibold uppercase tracking-wide text-text2">
          <span>Feature</span>
          <span>Shipped</span>
          <span>Proof</span>
          <span>Proof checked</span>
        </div>
      )}
      {[...current].sort((a, b) => Number(!!b.stale) - Number(!!a.stale)).map((f) => {
        const focus = f === STALE;
        return (
          <div key={f.id} className={`border-b border-line last:border-b-0 ${focus && phase !== "done" ? "bg-warn-bg/40" : ""}`} data-testid="cs1-row">
            <div className={phone ? "space-y-1 px-3 py-2.5" : "grid grid-cols-[minmax(170px,1.2fr)_96px_minmax(200px,2fr)_minmax(150px,1fr)] items-center gap-3 px-4 py-2.5"}>
              <span className="flex items-center gap-2 font-medium">
                <Glyph stage="exists" stale={f.stale && !(focus && phase === "done")} />
                {f.name}
              </span>
              <span className="text-[13px] text-text2">{f.shipped}, 2026</span>
              <Proof f={f} wide={!phone} />
              <span className="flex flex-wrap items-center gap-2">
                <Fresh f={f} phase={phase} focus={focus} />
                {focus && phase === "rest" && (
                  <Button variant="secondary">
                    Check again
                  </Button>
                )}
              </span>
            </div>
            {focus && open && phase !== "done" && (
              <div className="mx-4 mb-3 rounded-lg border border-line bg-surface p-3 text-[14px]" data-testid="cs1-check">
                <p className="mb-2 font-semibold">Is {f.name} still true today?</p>
                <ul className="mb-3 space-y-1.5">
                  <Line ok={phase === "mid" ? true : null}>Code map: 9 files still in place</Line>
                  <Line ok={phase === "mid" ? true : null}>4 merged pull requests, none reverted</Line>
                  <Line ok={phase === "mid" ? true : null}>6 of 6 tracker tasks done</Line>
                  <Line ok={phase === "mid" ? false : null}>Measured value: 3,410 sent last month (Sep). October not read yet</Line>
                </ul>
                <div className="flex flex-wrap gap-2">
                  <Button variant="primary">Yes, still runs</Button>
                  <Button variant="secondary">Something changed</Button>
                  <Button variant="ghost">No longer runs</Button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Line({ ok, children }: { ok: boolean | null; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span className={`mt-0.5 inline-flex h-4 w-4 flex-none items-center justify-center rounded-full text-[11px] font-bold ${ok === true ? "bg-pass text-surface" : ok === false ? "bg-warn text-surface" : "border border-line-strong"}`}>{ok === true ? "✓" : ok === false ? "!" : ""}</span>
      <span>{children}</span>
    </li>
  );
}

/** CS1 b: one card per area, with each feature's freshness bar. */
function AreaCards({ phase, phone }: { phase: string; phone: boolean }) {
  return (
    <div className="flex gap-4">
      <div className={`grid flex-1 gap-3 ${phone ? "grid-cols-1" : "grid-cols-3"}`} data-testid="cs1-cards">
        {CS_AREAS.map((area) => {
          const fs = current.filter((f) => f.area === area);
          return (
            <section key={area} className="rounded-xl border border-line bg-surface p-3">
              <h3 className="mb-2 flex items-center justify-between text-[14px] font-semibold">
                {area} <span className="font-normal text-text2">{fs.length} running</span>
              </h3>
              {fs.map((f) => {
                const focus = f === STALE;
                const stale = f.stale && !(focus && phase === "done");
                const days = focus && phase === "done" ? 0 : (f.checkedDays ?? 0);
                return (
                  <div key={f.id} className={`mb-2 rounded-lg border p-2.5 ${stale ? "border-dashed border-warn opacity-90" : "border-line"} ${focus && phase !== "rest" && phase !== "done" ? "ring-2 ring-accent" : ""}`}>
                    <div className="flex items-center justify-between gap-2 text-[14px] font-medium">
                      <span className="flex items-center gap-2">
                        <Glyph stage="exists" stale={stale} />
                        {f.name}
                      </span>
                      {stale && <span className="text-[12px] font-semibold text-warn">Proof old</span>}
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface2" title={`Proof checked ${days} days ago`}>
                      <div className={`h-full ${stale ? "bg-warn" : "bg-pass"}`} style={{ width: `${Math.max(6, 100 - days * 2.2)}%` }} />
                    </div>
                    <p className="mt-1 text-[12px] text-text2">{focus && phase === "done" ? "Checked Nov 3 · you confirmed" : `Checked ${f.checked} · ${f.measured}`}</p>
                  </div>
                );
              })}
              {fs.length === 0 && <p className="text-[13px] text-text2">Nothing runs here yet.</p>}
            </section>
          );
        })}
      </div>
      {!phone && phase !== "rest" && phase !== "done" && (
        <aside className="w-[340px] flex-none rounded-xl border border-line bg-surface p-4 text-[14px]" data-testid="cs1-side">
          <p className="mb-1 flex items-center gap-2 font-semibold">
            <Glyph stage="exists" stale /> {STALE.name}
          </p>
          <p className="mb-3 text-text2">Billing · shipped May 20, 2026 · Lena Fischbach owns it</p>
          <p className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-text2">Proof, newest first</p>
          <ol className="mb-3 space-y-2 border-l border-line pl-3">
            <li><b>Sep 23</b> · measured: 3,410 invoices sent in September</li>
            <li><b>Jun 2</b> · tracker: 6 of 6 tasks done</li>
            <li><b>May 20</b> · 4 pull requests merged</li>
            <li><b>May 20</b> · code map: 9 files</li>
          </ol>
          {phase === "mid" ? (
            <>
              <label className="mb-2 flex items-center gap-2"><input type="radio" readOnly checked /> Still runs as before</label>
              <label className="mb-2 flex items-center gap-2"><input type="radio" readOnly /> Changed</label>
              <label className="mb-3 flex items-center gap-2"><input type="radio" readOnly /> No longer runs</label>
              <Button variant="primary">Confirm</Button>
            </>
          ) : (
            <Button variant="primary">Check it now</Button>
          )}
        </aside>
      )}
    </div>
  );
}

/** CS1 c: what shipped, newest first, as dated entries. */
function Shipped({ phase, phone }: { phase: string; phone: boolean }) {
  const months = ["Oct", "Sep", "Aug", "Jul", "Jun", "May", "Apr", "Mar"];
  return (
    <div className="max-w-[860px]" data-testid="cs1-timeline">
      {months.map((m) => {
        const fs = current.filter((f) => f.shipped?.startsWith(m));
        if (fs.length === 0) return null;
        return (
          <section key={m} className="mb-3">
            <h3 className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-text2">{m} 2026</h3>
            {fs.map((f) => {
              const focus = f === STALE;
              const stale = f.stale && !(focus && phase === "done");
              return (
                <div key={f.id} data-cs-focus={focus ? "" : undefined} className={`relative ml-2 border-l-2 pb-3 pl-4 ${stale ? "border-dashed border-warn" : "border-pass"}`}>
                  <span className="absolute -left-[8px] top-0.5"><Glyph stage="exists" stale={stale} /></span>
                  <p className={`font-medium ${stale ? "text-text2" : ""}`}>
                    {f.name} <span className="font-normal text-text2">· shipped {f.shipped}</span>
                  </p>
                  {!phone || !stale ? <Proof f={focus && phase === "done" ? { ...f, measured: "3,520 sent in October" } : f} wide={!phone} /> : null}
                  {stale && (
                    <p className="mt-1 text-[13px] text-warn">
                      Not checked since {f.checked}. {phase === "rest" && <button className="font-semibold underline">Ask Lena Fischbach</button>}
                    </p>
                  )}
                  {focus && phase === "open" && (
                    <div className="mt-2 max-w-[520px] rounded-lg border border-line bg-surface p-3 text-[14px]">
                      <p className="mb-2">Ask Lena Fischbach if {f.name} still runs as before:</p>
                      <textarea readOnly className="mb-2 h-16 w-full rounded-md border border-line bg-surface2 p-2 text-[13px]" value="Do invoices as PDF still go out each month? The last proof is from Sep 23." />
                      <Button variant="primary">Send</Button>
                    </div>
                  )}
                  {focus && phase === "mid" && <p className="mt-1 text-[13px] text-accent-ink">Asked Lena Fischbach Nov 3, 9:12 AM · waiting for an answer</p>}
                  {focus && phase === "done" && <p className="mt-1 text-[13px] font-semibold text-pass">Lena Fischbach confirmed Nov 3: still runs</p>}
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ CS3: moving */

const READY = desired.filter((f) => f.ready);

function DesiredList({ mark, moving, phone, hard }: { mark: string; moving: CsFeature[]; phone: boolean; hard: boolean }) {
  const left = desired.filter((f) => !moving.includes(f));
  const shown = hard ? left : left.slice(0, phone ? 9 : 14);
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface" data-testid="cs-desired">
      {shown.map((f) => {
        return (
          <div key={f.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2 last:border-b-0">
            <FeatureMark variant={mark} stage={f.stage} compact={phone} />
            <span className={"min-w-[10rem] flex-1 font-medium"}>{f.name}</span>
            {!phone && <span className="w-[200px] text-[13px] text-text2">{f.area}</span>}
            {!phone && <span className="w-[140px] text-[13px] text-text2">{f.milestone}</span>}
            {f.stage === "progress" && (
              <span className={`text-[13px] ${f.ready ? "font-semibold text-pass" : "text-text2"}`}>
                {f.ready ? "Proof is in" : `${f.tasks?.[0]} of ${f.tasks?.[1]} tasks done`}
              </span>
            )}
          </div>
        );
      })}
      {!hard && <p className="px-4 py-2 text-[13px] text-text2">and {left.length - shown.length} more</p>}
    </div>
  );
}

function ProofDialog({ f, phase }: { f: CsFeature; phase: string }) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-3" data-testid="cs3-dialog">
      <div role="dialog" aria-label={`Move ${f.name} to Current state`} className="w-[520px] max-w-full rounded-2xl border border-line bg-surface p-5 shadow-2xl">
        <h2 className="mb-1 text-[18px] font-semibold">Move {f.name} to Current state?</h2>
        <p className="mb-3 text-[14px] text-text2">Oracle found proof that it runs today:</p>
        <ul className="mb-4 space-y-1.5 text-[14px]">
          <Line ok>Code map: {f.files} files</Line>
          <Line ok>{f.prs} pull requests merged</Line>
          <Line ok>
            {f.tasks?.[0]} of {f.tasks?.[1]} tracker tasks done
          </Line>
          <Line ok>{f.measured}</Line>
        </ul>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost">Not yet</Button>
          <Button variant="primary">{phase === "mid" ? "Moving…" : "Move to Current state"}</Button>
        </div>
      </div>
    </div>
  );
}

function Toast({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="fixed bottom-6 left-1/2 z-40 flex w-max max-w-[calc(100vw-24px)] max-[600px]:bottom-[76px] -translate-x-1/2 items-center gap-4 rounded-xl bg-[var(--tip)] px-4 py-3 text-[14px] text-[var(--tip-text)] shadow-xl" data-testid="cs3-toast">
      {children}
    </div>
  );
}

function CurrentList({ moved, how, phone }: { moved: CsFeature[]; how: string; phone: boolean }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface" data-testid="cs-current">
      {[...moved, ...current].map((f) => {
        const isNew = moved.includes(f);
        return (
          <div key={f.id} className={`flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2 last:border-b-0 ${isNew ? "bg-pass-bg/60" : ""}`}>
            <Glyph stage="exists" stale={f.stale} />
            <span className="min-w-[10rem] flex-1 font-medium">{f.name}</span>
            {!phone && <Proof f={f} wide={false} />}
            <span className={`text-[13px] ${isNew ? "font-semibold text-pass" : f.stale ? "text-warn" : "text-text2"}`}>{isNew ? how : f.stale ? "Proof is 41 days old" : `Checked ${f.checked}`}</span>
          </div>
        );
      })}
    </div>
  );
}

function Move({ v, phase, phone, hard }: { v: string; phase: string; phone: boolean; hard: boolean }) {
  const one = READY[0];
  const many = READY;
  const gone = v === "a" && (phase === "open" || phase === "mid") ? [one] : v === "a" && hard ? READY : []; // moved by Oracle, out of Desired state
  if (phase === "done") {
    const moved = v === "c" ? READY : [one];
    return (
      <>
        <Tabs view="current" moved={moved.length} />
        {v === "c" && <Banner tone="pass">Friday check done: 2 moved to Current state, 1 stays in Desired state (Report builder: 5 tasks still open).</Banner>}
        <CurrentList moved={moved} phone={phone} how={v === "a" ? "Moved today on proof" : v === "b" ? "Moved Nov 3 · you confirmed" : "Moved Nov 6 · Friday check"} />
        {v === "a" && (
          <Toast>
            <span>{one.name} moved to Current state: proof is in.</span>
            <button className="font-semibold underline">Undo</button>
          </Toast>
        )}
      </>
    );
  }
  return (
    <>
      <Tabs view="desired" moved={gone.length} />
      {v === "b" && (
        <Banner tone="pass" testId="cs3-ready">
          <b>{many.length} ready to move</b>: shipped, with proof. Each one needs your yes.
          <span className="ml-2 inline-flex flex-wrap gap-1.5">
            {many.map((f) => (
              <button key={f.id} className={`rounded-full border border-line bg-surface px-2.5 py-0.5 text-[13px] ${f === one && phase !== "rest" ? "ring-2 ring-accent" : ""}`}>{f.name}</button>
            ))}
          </span>
        </Banner>
      )}
      {v === "c" && (
        <Banner tone="info" testId="cs3-friday">
          <b>Friday check, Nov 6</b>: {hard ? many.length : 3} features may have shipped this week. <Button variant="secondary">Review them</Button>
        </Banner>
      )}
      {v === "c" && phase !== "rest" && (
        <div className="mb-3 max-w-[640px] rounded-xl border border-line bg-surface p-4 text-[14px]" data-testid="cs3-review">
          <p className="mb-2 font-semibold">Did these ship this week?</p>
          {[...READY, desired.find((f) => f.name === "Report builder")!].map((f, i) => (
            <label key={f.id} className="flex items-center gap-2 border-b border-line py-2 last:border-b-0">
              <input type="checkbox" readOnly checked={phase === "mid" ? i < 2 : false} />
              <span className="flex-1 font-medium">{f.name}</span>
              <span className="text-[13px] text-text2">{f.ready ? `${f.prs} pull requests · all tasks done` : `${f.tasks?.[0]} of ${f.tasks?.[1]} tasks done`}</span>
            </label>
          ))}
          <div className="mt-3 flex gap-2">
            <Button variant="primary">{phase === "mid" ? "Move 2 to Current state" : "Move to Current state"}</Button>
            <Button variant="ghost">Later</Button>
          </div>
        </div>
      )}
      <DesiredList mark="a" moving={gone} phone={phone} hard={hard} />
      {v === "b" && (phase === "open" || phase === "mid") && <ProofDialog f={one} phase={phase} />}
      {v === "a" && phase === "open" && (
        <Toast>
          <span>{one.name} moved to Current state: proof is in.</span>
          <button className="font-semibold underline">Undo</button>
          <button className="underline">See proof</button>
        </Toast>
      )}
      {v === "a" && phase === "mid" && (
        <Toast>
          <span>Undo moving {one.name}? It goes back to Desired state as In progress.</span>
          <button className="rounded-md bg-surface px-2 py-0.5 font-semibold text-text">Yes, undo</button>
          <button className="underline">Keep it</button>
        </Toast>
      )}
      {v === "a" && phase === "rest" && hard && (
        <Toast>
          <span>2 features moved to Current state overnight: Saved searches, Retry failed payments.</span>
          <button className="font-semibold underline">Undo</button>
        </Toast>
      )}
    </>
  );
}

function Banner({ tone, testId, children }: { tone: "pass" | "info"; testId?: string; children: ReactNode }) {
  return (
    <div data-testid={testId} className={`mb-3 flex flex-wrap items-center gap-2 rounded-xl px-4 py-2.5 text-[14px] ${tone === "pass" ? "bg-pass-bg" : "bg-accent-soft"}`}>
      {children}
    </div>
  );
}

function usePhone(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => setPhone(window.innerWidth < 600), []);
  return phone;
}

/** Detailed › Desired state / Current state, as each proposal draws it (MOCK-HOOK). */
export function CsPage({ cs }: { cs: Cs }) {
  const phone = usePhone();
  const { phase, hard } = cs;
  const view = cs.cs1 || (cs.cs3 && phase === "done") ? "current" : "desired";
  const title = cs.cs2 ? "Where the mark shows" : view === "current" ? "Current state" : "Desired state";
  const sub = cs.cs2
    ? "The same three marks where Oracle names a feature outside Priorities: a roadmap bar, a one-pager line, an Ask Oracle answer and a meeting agenda item."
    : view === "current"
      ? "What runs today: each built feature with its proof, and how fresh that proof is."
      : "What the product should become: goals, areas of focus, milestones and the planned features.";
  return (
    <Page>
      <PageHeader title={title} />
      <p className="-mt-2 mb-3 max-w-[760px] text-[14px] text-text2">{sub}</p>
      {cs.cs1 && (
        <>
          <Tabs view="current" />
          <div className="mb-3 flex flex-wrap items-center gap-3 text-[14px]">
            <span><b>10</b> running</span>
            {phase === "done" ? <span className="text-text2"><b>0</b> with old proof</span> : <span className="text-warn"><b>1</b> with old proof</span>}
            <span className="text-text2">6 in progress in Desired state</span>
            <span className="text-text2">· Oracle reads code maps, merged pull requests and done tasks each night; you confirm.</span>
          </div>
          {cs.cs1 === "a" && <ProofTable phase={phase} phone={phone} />}
          {cs.cs1 === "b" && <AreaCards phase={phase} phone={phone} />}
          {cs.cs1 === "c" && <Shipped phase={phase} phone={phone} />}
          {hard && <HardNote />}
        </>
      )}
      {cs.cs2 && phase === "places" && <Places v={cs.cs2} phone={phone} />}
      {cs.cs3 && <Move v={cs.cs3} phase={phase} phone={phone} hard={hard} />}
    </Page>
  );
}

function HardNote() {
  return (
    <div className="mt-4 rounded-xl border border-line bg-surface p-3" data-testid="cs-hard">
      <p className="mb-2 text-[13px] font-semibold text-text2">Still in Desired state: 6 in progress, 44 new</p>
      <div className="flex flex-wrap gap-1.5">
        {desired.map((f) => (
          <span key={f.id} className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[12px]">
            <Glyph stage={f.stage} size={11} /> {f.name}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ CS2: the mark in other places */

/** A feature's name with its mark, as it sits inside a line of text. */
function Named({ v, name }: { v: string; name: string }) {
  const f = csFeature(name)!;
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap font-semibold">
      <span className="self-center"><FeatureMark variant={v} stage={f.stage} stale={f.stale} /></span>
      {f.name}
    </span>
  );
}

function Place({ title, where, focus, children }: { title: string; where: string; focus?: boolean; children: ReactNode }) {
  return (
    <section data-cs-focus={focus ? "" : undefined} className="rounded-xl border border-line bg-surface p-4" data-testid="cs2-place">
      <h3 className="text-[14px] font-semibold">{title}</h3>
      <p className="mb-3 text-[12px] text-text2">{where}</p>
      {children}
    </section>
  );
}

/** CS2: the mark on a roadmap bar, a one-pager line, a chat answer and an agenda item (MOCK-HOOK). */
function Places({ v, phone }: { v: string; phone: boolean }) {
  const bars: { name: string; from: number; span: number }[] = [
    { name: "Card payments", from: 0, span: 2 },
    { name: "Retry failed payments", from: 1, span: 2 },
    { name: "Yearly billing", from: 3, span: 1 },
    { name: "Bank transfer payments", from: 3, span: 2 },
    { name: "Tax by country", from: 5, span: 1 },
  ];
  const cols = 6;
  return (
    <div className={`grid gap-4 ${phone ? "grid-cols-1" : "grid-cols-2"}`} data-testid="cs2-places">
      <Place title="Roadmap bar" where="Detailed › Plan › Billing, Nov to Apr">
        <div className="mb-1 grid text-[11px] text-text2" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
          {["Nov", "Dec", "Jan", "Feb", "Mar", "Apr"].map((m) => <span key={m} className="border-l border-line pl-1">{m}</span>)}
        </div>
        <div className="space-y-1.5">
          {bars.map((b) => {
            const f = csFeature(b.name)!;
            return (
              <div key={b.name} className="grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
                <div className="flex h-7 min-w-0 items-center gap-1.5 overflow-hidden rounded-md border border-accent/40 bg-accent-soft px-1.5 text-[12px] font-medium" style={{ gridColumn: `${b.from + 1} / span ${b.span}` }} title={f.name}>
                  <FeatureMark variant={v} stage={f.stage} stale={f.stale} compact />
                  <span className="truncate">{f.name}</span>
                </div>
              </div>
            );
          })}
        </div>
      </Place>
      <Place title="One-pager line" where="Detailed › PRDs › Billing one-pager, What we build">
        <ul className="list-disc space-y-2 pl-5 text-[14px] leading-6">
          <li><Named v={v} name="Card payments" />: customers pay by card at checkout.</li>
          <li><Named v={v} name="Retry failed payments" />: try a failed card again after one, three and seven days.</li>
          <li><Named v={v} name="Yearly billing" />: pay for a year at once, with two months free.</li>
          <li><Named v={v} name="Invoices as PDF" />: each invoice also goes out as a PDF.</li>
        </ul>
      </Place>
      <Place title="Ask Oracle answer" focus={phone} where="The Ask Oracle panel, asked “What is left to do in Billing?”">
        <div className="rounded-xl bg-surface2 p-3 text-[14px] leading-7">
          Billing has one feature that runs today, <Named v={v} name="Card payments" />, and one being built,{" "}
          <Named v={v} name="Retry failed payments" />. Nothing is built yet for <Named v={v} name="Yearly billing" /> or{" "}
          <Named v={v} name="Tax by country" />. <Named v={v} name="Invoices as PDF" /> runs, but its proof is 41 days old.
        </div>
      </Place>
      <Place title="Meeting agenda item" where="Company › Rituals › Billing weekly, Nov 5">
        <ol className="list-decimal space-y-2 pl-5 text-[14px] leading-6">
          <li>Is <Named v={v} name="Retry failed payments" /> ready to move to Current state? · Tomas Lind · 10 min</li>
          <li>Scope <Named v={v} name="Yearly billing" /> for the Spring release · Mira Okafor · 15 min</li>
          <li>Check <Named v={v} name="Invoices as PDF" /> still runs · Lena Fischbach · 5 min</li>
        </ol>
      </Place>
    </div>
  );
}
