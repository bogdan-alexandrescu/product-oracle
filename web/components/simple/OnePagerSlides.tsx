"use client";

import { useEffect, useState, type ReactNode } from "react";

import { FlowPanel } from "@/components/simple/FlowVisual";
import { WithFeatureMarks } from "@/components/current-state/CurrentState";
import { PlanByMonth } from "@/components/simple/PlanByMonth";
import { PrdPlan } from "@/components/simple/PrdTimeline";
import type { Schemas } from "@/lib/api/client";

type View = Schemas["OnePagerOut"];
type Line = Schemas["OnePagerLine"];
type Block = Schemas["OnePagerBlock"];

/** Keys that page the slides; a typed field or a dialog over them keeps its own keys. */
const NEXT = new Set(["ArrowRight", "ArrowDown", "PageDown", " "]);
const BACK = new Set(["ArrowLeft", "ArrowUp", "PageUp"]);

/**
 * C-8: Present is a run of full-screen slides, one per block of the one-pager (the problem,
 * what we build, the outcomes, what we are not doing, the risks), then the timeline alone at
 * full width. Arrow keys, Space and Page Up / Down page them; the count says where you are.
 */
export function OnePagerSlides({
  v,
  plan,
  top,
  stop,
  lineWords,
  quotes,
  codes,
  sectionNames,
  onPlan,
}: {
  v: View;
  plan: Schemas["SimplePlanOut"] | null;
  /** A line over the slides ("Showing published v3"), when the presenter picked which. */
  top: ReactNode;
  stop: () => void;
  lineWords: (l: Line) => string;
  /** Each line's quoted name ("“A setup checklist…”"), as the page labels it. */
  quotes: Map<string, string>;
  codes: Map<string, string | null>;
  sectionNames: Record<string, string>;
  onPlan: (p: Schemas["SimplePlanOut"]) => void;
}) {
  const blocks = v.blocks.filter((b) => b.kind !== "timeline");
  const timeline = v.blocks.find((b) => b.kind === "timeline");
  const count = blocks.length + (timeline || plan ? 1 : 0);
  const [at, setAt] = useState(0);
  const go = (n: number) => setAt(Math.max(0, Math.min(count - 1, n)));
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("textarea, input, select, [contenteditable]")) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]')) return;
      const step = NEXT.has(e.key) ? 1 : BACK.has(e.key) ? -1 : e.key === "Home" ? -count : e.key === "End" ? count : 0;
      if (!step) return;
      e.preventDefault();
      setAt((x) => Math.max(0, Math.min(count - 1, x + step)));
    };
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  }, [count]);
  const isTimeline = at >= blocks.length;
  const b = isTimeline ? null : blocks[at];
  const title = b?.title ?? timeline?.title ?? "Timeline";
  const nav = "inline-flex min-h-11 min-w-11 items-center justify-center rounded-[10px] border border-line-strong bg-surface px-3.5 text-[15px] font-semibold text-text disabled:opacity-40";
  return (
    <div className="flex min-h-screen flex-col" data-testid="slides">
      <div className="flex flex-wrap items-center gap-3 px-6 pt-4 max-[767px]:px-4">
        <span className="min-w-0 truncate text-[15px] font-semibold text-text2">{v.document.title}</span>
        {top}
        <span className="flex-1" />
        <button type="button" className={nav} onClick={stop}>
          Stop presenting
        </button>
      </div>
      <section
        key={at}
        aria-roledescription="slide"
        aria-label={`${title}, slide ${at + 1} of ${count}`}
        data-testid="slide"
        className={`mx-auto flex w-full flex-1 flex-col gap-6 px-6 py-8 max-[767px]:px-4 ${isTimeline ? "max-w-none md:px-12" : "max-w-[1100px] justify-center"}`}
      >
        <h2 className="text-[clamp(30px,4vw,52px)] leading-[1.15] font-bold tracking-[-.01em]">{title}</h2>
        {b ? (
          <SlideLines b={b} v={v} lineWords={lineWords} quotes={quotes} sectionNames={sectionNames} />
        ) : plan ? (
          <PrdPlan plan={plan} title={v.document.title} prd={v.document.slug} onPlan={onPlan} />
        ) : v.plan ? (
          <div aria-label="Timeline strip" className="text-[18px]">
            <WithFeatureMarks>
              <PlanByMonth plan={v.plan} prd={v.document} legend items={v.timeline.map((t) => ({ ...t, code: codes.get(t.id) }))} />
            </WithFeatureMarks>
          </div>
        ) : (
          <p className="text-[clamp(20px,2.4vw,30px)] text-text-faint">No roadmap items yet</p>
        )}
      </section>
      <div className="flex items-center justify-center gap-4 px-6 pb-6">
        <button type="button" className={nav} disabled={at === 0} onClick={() => go(at - 1)} aria-label="Previous slide">
          ←
        </button>
        <span role="status" data-testid="slide-count" aria-label={`Slide ${at + 1} of ${count}`} className="min-w-16 text-center text-[17px] font-semibold tabular-nums text-text2">
          {at + 1} / {count}
        </span>
        <button type="button" className={nav} disabled={at === count - 1} onClick={() => go(at + 1)} aria-label="Next slide">
          →
        </button>
      </div>
    </div>
  );
}

function SlideLines({ b, v, lineWords, quotes, sectionNames }: { b: Block; v: View; lineWords: (l: Line) => string; quotes: Map<string, string>; sectionNames: Record<string, string> }) {
  const said = (x: string) => x.replace(/[.\s…]+$/, "").toLowerCase();
  const who = b.key === "problem" && b.who && !b.lines.some((l) => said(l.full ?? l.text).includes(said(b.who!))) ? b.who : null;
  if (!b.lines.length) return <p className="text-[clamp(20px,2.4vw,30px)] text-text-faint">{b.missing ? "Not in the PRD yet" : "Not written yet"}</p>;
  const bullets = b.kind === "lines" || b.kind === "metrics";
  return (
    <ul className={`space-y-4 text-[clamp(20px,2.4vw,30px)] leading-[1.35] ${bullets ? "list-disc pl-[1.2em]" : "list-none"}`}>
      {b.lines.map((l) => (
        <li key={l.id} data-line={l.id}>
          <div>
            {l.metric ? (
              <>
                <span>{l.metric.name}: </span>
                <strong className="tabular-nums">
                  {l.metric.from || "—"} → {l.metric.to}
                </strong>
              </>
            ) : (
              lineWords(l)
            )}
          </div>
          {l.flow_subject && l.flow && (
            <div className="mt-2 text-base" aria-label={`User flow of ${quotes.get(l.id) ?? ""}`} role="group">
              <FlowPanel row subject={{ kind: "one_pager_line", id: l.flow_subject }} documentId={v.document.id} openLabel={`Flow for ${quotes.get(l.id) ?? ""}`} sectionNames={sectionNames} />
            </div>
          )}
        </li>
      ))}
      {who && <li className="list-none text-text2">Who has it: {who}</li>}
    </ul>
  );
}
