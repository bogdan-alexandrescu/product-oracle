"use client";

// MOCK-HOOK: rebuild-sign mock-ups (mockups-out/mk-rebuildsign). Never merged.
// The URL picks what is drawn: ?rb=a|b|c (proposal), &rbstate=running|scheduled|waiting|failed|done,
// &rbcase=two (a regenerate and a roadmap run on one PRD) | four (a roadmap fed by four PRDs,
// two rebuilding), &rbtick=1 (the moment a poll moves the run to its next step).
// In the product the runs come from GET /v1/runs (RunSummary: status, flow, document_slug,
// segments, checkpoints, waiting_on, created_by), re-read every 5 s while one moves, as the run page does.

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

export type Proposal = "a" | "b" | "c";
type State = "running" | "scheduled" | "waiting" | "failed" | "done";
type Where = "one-pager" | "list-row" | "roadmap" | "prd-detailed" | "home";

type Run = {
  id: string;
  what: "regenerate" | "roadmap";
  slug: string;
  title: string;
  kind: "prd" | "roadmap";
  from: number;
  to: number;
  state: State;
  step: number; // 1-based, the step it is on
  steps: string[];
  startedBy: string;
  startedAt: string;
  minutesLeft: number;
  scheduledFor: string;
  stop: { who: string; action: string; button: string };
  failed: { reason: string };
  justMoved: boolean;
};

const PRD_STEPS = ["Read the sources", "Draft the sections", "Check the draft", "Review stop", "Write the one-pager", "Save the new draft"];
const ROADMAP_STEPS = ["Read the PRDs", "Place the features", "Check what depends on what", "Review stop", "Set the dates", "Save the new draft"];

export const REBUILD_PRD = "checkout-redesign";
export const REBUILD_ROADMAP = "product-roadmap";

const noSubscribe = () => () => {};
/** The page's query string, read after hydration (the server renders no sign). */
function useSearch() {
  return useSyncExternalStore(noSubscribe, () => window.location.search, () => null);
}

function readParams(search: string | null) {
  if (search == null) return null;
  const p = new URLSearchParams(search);
  const rb = p.get("rb");
  if (rb !== "a" && rb !== "b" && rb !== "c") return null;
  const st = p.get("rbstate");
  const state: State = st === "scheduled" || st === "waiting" || st === "failed" || st === "done" ? st : "running";
  return { proposal: rb as Proposal, state, hard: p.get("rbcase"), tick: Number(p.get("rbtick") ?? 0) || 0 };
}

function makeRuns(state: State, hard: string | null, tick: number, polls: number): Run[] {
  const prdStep = state === "waiting" ? 4 : state === "failed" ? 3 : state === "done" ? 6 : tick ? 3 : 2;
  // Live: each poll (every 5 s) re-reads the run; its time left counts down as it moves.
  const left = Math.max(5, (tick ? 31 : 40) - Math.floor((polls * 5) / 60));
  const base = {
    state,
    startedBy: "Avery Stone",
    startedAt: "Oct 22, 11:20 AM PDT",
    scheduledFor: "Thu, Oct 29, 9:00 AM PDT",
    failed: { reason: "Two sections came back empty" },
    justMoved: !!tick && state === "running",
  };
  const prd: Run = {
    ...base,
    id: "rebuild-prd",
    what: "regenerate",
    slug: REBUILD_PRD,
    title: "Checkout redesign PRD",
    kind: "prd",
    from: 2,
    to: 3,
    step: prdStep,
    steps: PRD_STEPS,
    minutesLeft: left,
    stop: { who: "Priya Raman", action: "approve the new sections", button: "Review the sections" },
  };
  const roadmap: Run = {
    ...base,
    id: "rebuild-roadmap",
    what: "roadmap",
    slug: REBUILD_ROADMAP,
    title: "Product roadmap",
    kind: "roadmap",
    from: 7,
    to: 8,
    step: prdStep,
    steps: ROADMAP_STEPS,
    minutesLeft: left + 15,
    stop: { who: "Priya Raman", action: "approve the new dates", button: "Review the dates" },
  };
  if (hard === "two") {
    // The same PRD: its own regenerate, and a roadmap run reading it (it waits for the new draft).
    return [prd, { ...roadmap, state: "scheduled", step: 1, scheduledFor: "after the PRD's new draft", justMoved: false }];
  }
  if (hard === "four") {
    const carts: Run = { ...prd, id: "rebuild-carts", slug: "saved-carts", title: "Saved carts PRD", from: 2, to: 3, step: Math.min(prdStep + 1, 6), minutesLeft: Math.max(5, left - 22), justMoved: false };
    return [prd, carts, { ...roadmap, state: "scheduled", step: 1, scheduledFor: "after the 2 PRDs", justMoved: false }];
  }
  return [prd, roadmap];
}

/** The rebuild runs the URL asks for, re-read every 5 s (the run page's POLL_MS) while one moves. */
export function useRebuilds() {
  const search = useSearch();
  const p = useMemo(() => readParams(search), [search]);
  const [polls, setPolls] = useState(0);
  const [opened, setOpened] = useState(false);
  const moving = p && (p.state === "running" || p.state === "waiting");
  useEffect(() => {
    if (!moving) return;
    const t = setInterval(() => setPolls((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, [moving]);
  if (!p) return null;
  return { proposal: p.proposal, state: p.state, hard: p.hard, runs: makeRuns(p.state, p.hard, p.tick, polls), opened, open: () => setOpened(true) };
}

type Rb = NonNullable<ReturnType<typeof useRebuilds>>;

function runsFor(rb: Rb, slug: string, kind: "prd" | "roadmap") {
  if (kind === "roadmap") {
    // A roadmap's sign covers its own run and, in the four-PRD case, the PRDs that feed it.
    return rb.runs.filter((r) => r.kind === "roadmap" || (rb.hard === "four" && r.kind === "prd"));
  }
  return rb.runs.filter((r) => r.slug === slug || (rb.hard === "two" && r.kind === "roadmap"));
}

function stepsWord(r: Run) {
  return `step ${r.step} of ${r.steps.length}`;
}

/** The short line for one run, as the chip, the marker and the banner title say it. */
function line(r: Run) {
  switch (r.state) {
    case "running":
      return r.kind === "roadmap" ? `Rebuilding ${r.title} v${r.to} · ${stepsWord(r)} · about ${r.minutesLeft} min` : `Rebuilding v${r.to} · ${stepsWord(r)} · about ${r.minutesLeft} min`;
    case "scheduled":
      return r.scheduledFor.startsWith("after") ? `Rebuild waits ${r.scheduledFor}` : `Rebuild scheduled ${r.scheduledFor}`;
    case "waiting":
      return `Waiting on ${r.stop.who} · ${stepsWord(r)}`;
    case "failed":
      return `Rebuild stopped at ${stepsWord(r)}`;
    case "done":
      return `v${r.to} ready: review it`;
  }
}

function shortLine(r: Run) {
  switch (r.state) {
    case "running":
      return `Rebuilding v${r.to} · ${r.step}/${r.steps.length}`;
    case "scheduled":
      return r.scheduledFor.startsWith("after") ? "Rebuild waiting" : "Rebuild Thu 9:00 AM";
    case "waiting":
      return `Waiting on ${r.stop.who.split(" ")[0]}`;
    case "failed":
      return "Rebuild stopped";
    case "done":
      return `v${r.to} ready: review it`;
  }
}

const TONE: Record<State, string> = {
  running: "bg-accent-soft text-accent-ink",
  scheduled: "bg-surface2 text-text2 border border-line",
  waiting: "bg-warn-bg text-warn",
  failed: "bg-crit-bg text-crit",
  done: "bg-pass-bg text-pass",
};

function Dot({ state }: { state: State }) {
  if (state === "running")
    return (
      <span aria-hidden className="relative inline-flex h-2 w-2 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-50" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-current" />
      </span>
    );
  if (state === "scheduled")
    return (
      <svg aria-hidden viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" className="shrink-0">
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5V12l3 2" />
      </svg>
    );
  if (state === "waiting")
    return (
      <svg aria-hidden viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" className="shrink-0">
        <circle cx="12" cy="8" r="3.5" />
        <path d="M5 19c1.2-3.2 3.8-4.8 7-4.8s5.8 1.6 7 4.8" />
      </svg>
    );
  if (state === "failed")
    return (
      <svg aria-hidden viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className="shrink-0">
        <path d="M12 7v6M12 16.5v.5" />
        <circle cx="12" cy="12" r="9" />
      </svg>
    );
  return (
    <svg aria-hidden viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function Steps({ r }: { r: Run }) {
  return (
    <ol className="flex flex-col gap-1 text-[13px] leading-[18px]" data-testid="rb-steps">
      {r.steps.map((s, i) => {
        const n = i + 1;
        const done = r.state === "done" || n < r.step;
        const now = n === r.step && r.state !== "done" && r.state !== "scheduled";
        const label = s === "Review stop" ? `Review stop: ${r.stop.who}` : s;
        return (
          <li key={s} className={`flex items-center gap-2 ${now ? "font-semibold text-text" : done ? "text-text2" : "text-text-faint"}`}>
            <span aria-hidden className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] ${done ? "bg-pass-bg text-pass" : now ? (r.state === "failed" ? "bg-crit-bg text-crit" : r.state === "waiting" ? "bg-warn-bg text-warn" : "bg-accent-soft text-accent-ink") : "border border-line"}`}>
              {done ? "✓" : n}
            </span>
            <span className="min-w-0 break-words">{label}</span>
            {now && r.state === "running" && r.justMoved && <span className="rounded bg-accent-soft px-1 text-[11px] text-accent-ink">just now</span>}
          </li>
        );
      })}
    </ol>
  );
}

function Progress({ r }: { r: Run }) {
  const pct = r.state === "done" ? 100 : r.state === "scheduled" ? 0 : Math.round(((r.step - 1 + (r.state === "running" ? 0.5 : 0)) / r.steps.length) * 100);
  const bar = r.state === "failed" ? "bg-crit" : r.state === "waiting" ? "bg-warn" : r.state === "done" ? "bg-pass" : "bg-accent";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface2" role="progressbar" aria-label={`${r.title}: ${stepsWord(r)}`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full rounded-full ${bar} transition-[width] duration-700`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** What happens to the page while it runs, in one sentence. */
function outcome(r: Run) {
  if (r.state === "done") return `v${r.to} is a draft until it is approved. Until then, everyone keeps seeing v${r.from}.`;
  if (r.state === "failed") return `${r.failed.reason} at "${r.steps[r.step - 1]}". Nothing changed: you still read v${r.from}.`;
  return r.kind === "roadmap"
    ? `It makes a new draft, v${r.to}. Until v${r.to} is approved, everyone keeps seeing the approved roadmap (v${r.from}).`
    : `It makes a new draft, v${r.to}. Until v${r.to} is approved, everyone keeps seeing v${r.from}.`;
}

function RunAction({ r, onOpen }: { r: Run; onOpen?: () => void }) {
  const cls = "simple-button whitespace-nowrap";
  if (r.state === "waiting")
    return (
      <Link href="/runs" className={`${cls} simple-button-primary`}>
        {r.stop.button}
      </Link>
    );
  if (r.state === "done")
    return (
      <button type="button" className={`${cls} simple-button-primary`} onClick={onOpen}>
        Review v{r.to}
      </button>
    );
  return (
    <Link href="/runs" className={cls}>
      Open run
    </Link>
  );
}

/** The run's details: steps, who started it, its stop and Open run (A's popover, C's note). */
function RunCard({ r, onOpen }: { r: Run; onOpen?: () => void }) {
  return (
    <div className="flex flex-col gap-2" data-testid="rb-run">
      <p className="text-[14px] leading-[20px] font-semibold text-text">
        {r.what === "roadmap" ? "Roadmap run" : "Regenerate"} · {r.title}
      </p>
      <p className="text-[13px] leading-[18px] text-text2">
        {r.state === "scheduled" ? `Set up by ${r.startedBy} · ${r.scheduledFor.startsWith("after") ? `starts ${r.scheduledFor}` : `starts ${r.scheduledFor}`}` : `Started by ${r.startedBy} · ${r.startedAt}`}
      </p>
      {r.state !== "scheduled" && <Steps r={r} />}
      {(r.state === "running" || r.state === "scheduled") && (
        <p className="text-[13px] leading-[18px] text-text2">
          Next stop: <b className="font-semibold text-text">{r.stop.who}</b> will {r.stop.action}.
        </p>
      )}
      {r.state === "waiting" && (
        <p className="text-[13px] leading-[18px] text-text2">
          Waiting on <b className="font-semibold text-text">{r.stop.who}</b> to {r.stop.action}.
        </p>
      )}
      <p className="text-[13px] leading-[18px] text-text2">{outcome(r)}</p>
      <div>
        <RunAction r={r} onOpen={onOpen} />
      </div>
    </div>
  );
}

/** A: the live chip beside the version, opening its popover. */
function Chip({ runs, compact, onOpen, summary }: { runs: Run[]; compact?: boolean; onOpen: () => void; summary?: string }) {
  const search = useSearch();
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? new URLSearchParams(search ?? "").get("rbopen") === "1";
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setToggled(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const r = runs[0];
  const more = runs.length - 1;
  const text = summary ?? (compact ? shortLine(r) : line(r));
  return (
    <span ref={ref} className="relative inline-flex max-w-full">
      <button
        type="button"
        data-testid="rb-chip"
        aria-expanded={open}
        onClick={() => setToggled(!open)}
        className={`relative z-[1] inline-flex min-h-6 max-w-full items-center gap-1.5 rounded-xl px-[9px] py-0.5 text-left text-[13px] leading-[18px] font-semibold ${TONE[r.state]} ${r.justMoved ? "ring-2 ring-accent/40" : ""}`}
      >
        <Dot state={r.state} />
        <span className="min-w-0 break-words">{text}</span>
        {r.justMoved && !compact && <span className="rounded bg-surface/70 px-1 text-[11px] whitespace-nowrap">just now</span>}
        {more > 0 && !summary && <span className="rounded-lg bg-surface/70 px-1.5 text-[12px] whitespace-nowrap">+{more} {more === 1 ? "run" : "runs"}</span>}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="What is rebuilding this"
          data-testid="rb-popover"
          className="absolute top-[calc(100%+6px)] left-0 z-30 flex w-[340px] flex-col gap-3 rounded-xl border border-line-strong bg-surface p-3.5 shadow-lg max-[600px]:fixed max-[600px]:top-auto max-[600px]:right-3 max-[600px]:bottom-[calc(var(--phone-tab-bar,0px)+12px)] max-[600px]:left-3 max-[600px]:w-auto max-[600px]:max-h-[70vh] max-[600px]:overflow-y-auto"
        >
          {runs.map((x, i) => (
            <div key={x.id} className={i > 0 ? "border-t border-line pt-3" : undefined}>
              <RunCard r={x} onOpen={onOpen} />
            </div>
          ))}
          <p className="text-[12px] leading-[16px] text-text-faint">Updates by itself while the run moves.</p>
        </div>
      )}
    </span>
  );
}

/** B: the full-width banner under the header. */
function Banner({ runs, onOpen }: { runs: Run[]; onOpen: () => void }) {
  return (
    <section
      aria-label="Rebuild in progress"
      data-testid="rb-banner"
      className={`flex flex-col gap-3 rounded-xl border px-4 py-3 ${runs[0].state === "failed" ? "border-crit/40 bg-crit-bg/40" : runs[0].state === "done" ? "border-pass/40 bg-pass-bg/50" : runs[0].state === "waiting" ? "border-warn/40 bg-warn-bg/40" : "border-line-strong bg-surface"}`}
    >
      {runs.map((r, i) => (
        <div key={r.id} className={`flex flex-col gap-2 ${i > 0 ? "border-t border-line pt-3" : ""}`}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className={`inline-flex items-center gap-1.5 rounded-xl px-[9px] py-0.5 text-[13px] leading-[18px] font-semibold ${TONE[r.state]}`}>
              <Dot state={r.state} />
              {r.state === "running" ? "Rebuilding" : r.state === "scheduled" ? "Scheduled" : r.state === "waiting" ? "Waiting" : r.state === "failed" ? "Stopped" : "Ready"}
            </span>
            <p className="min-w-0 flex-1 text-[15px] leading-[22px] font-semibold text-text break-words">
              {r.state === "done"
                ? `v${r.to} of ${r.title} is ready: review it`
                : r.state === "scheduled"
                  ? `${r.what === "roadmap" ? "Roadmap run" : "Regenerate"} on ${r.title}: ${r.scheduledFor.startsWith("after") ? `starts ${r.scheduledFor}` : r.scheduledFor}`
                  : `${r.what === "roadmap" ? "Roadmap run" : "Regenerate"} on ${r.title} · ${stepsWord(r)}: ${r.steps[r.step - 1] === "Review stop" ? `Review stop` : r.steps[r.step - 1]}`}
              {r.justMoved && <span className="ml-2 rounded bg-accent-soft px-1 text-[11px] font-semibold text-accent-ink align-middle">just now</span>}
            </p>
            {r.state === "running" && <span className="text-[13px] text-text2 whitespace-nowrap max-[600px]:basis-full">about {r.minutesLeft} min left</span>}
          </div>
          {r.state !== "scheduled" && <Progress r={r} />}
          {r.state === "waiting" && (
            <p className="text-[14px] leading-[20px] text-text2">
              Waiting on <b className="font-semibold text-text">{r.stop.who}</b> to {r.stop.action}.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="min-w-0 flex-1 text-[14px] leading-[20px] text-text2 basis-[260px]">{outcome(r)}</p>
            <RunAction r={r} onOpen={onOpen} />
          </div>
        </div>
      ))}
    </section>
  );
}

/** C: the quiet marker where the PRD or roadmap is listed or headed. */
function Marker({ runs }: { runs: Run[] }) {
  const r = runs[0];
  const text = r.state === "done" ? `v${r.to} ready: review it` : r.state === "failed" ? "Rebuild stopped" : r.state === "scheduled" ? "New version scheduled" : "New version coming";
  return (
    <span data-testid="rb-marker" className={`inline-flex items-center gap-1.5 text-[13px] leading-[18px] font-semibold whitespace-nowrap ${r.state === "failed" ? "text-crit" : r.state === "done" ? "text-pass" : r.state === "waiting" ? "text-warn" : "text-accent-ink"}`}>
      <Dot state={r.state} />
      {text}
      {runs.length > 1 && <span className="font-normal text-text2">· {runs.length} runs</span>}
    </span>
  );
}

/** C: the page-level note with its live step counter. */
function Note({ runs, onOpen }: { runs: Run[]; onOpen: () => void }) {
  const r = runs[0];
  const many = runs.length > 1;
  // The marker by the title says "New version coming"; the note says how far along, never the same words.
  const detail = (x: Run) => {
    switch (x.state) {
      case "running":
        return `${stepsWord(x).replace("step", "Step")}: ${x.steps[x.step - 1].toLowerCase()} · about ${x.minutesLeft} min`;
      case "scheduled":
        return `Starts ${x.scheduledFor}`;
      case "waiting":
        return `${stepsWord(x).replace("step", "Step")}: waiting on ${x.stop.who} to ${x.stop.action}`;
      case "failed":
        return `${x.failed.reason} at step ${x.step}. You still read v${x.from}.`;
      case "done":
        return `v${x.to} is a draft until it is approved. You still read v${x.from}.`;
    }
  };
  const action = (x: Run) =>
    x.state === "done" ? (
      <button type="button" className="font-semibold text-accent-ink hover:underline" onClick={onOpen}>
        Review v{x.to}
      </button>
    ) : (
      <Link href="/runs" className="font-semibold text-accent-ink hover:underline">
        {x.state === "waiting" ? x.stop.button : "Open run"}
      </Link>
    );
  return (
    <div role="status" aria-live="polite" data-testid="rb-note" className="flex flex-col gap-1.5 border-l-[3px] border-accent/60 py-1 pl-3 text-[14px] leading-[20px] text-text2">
      {runs.map((x) => (
        <p key={x.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 break-words">
          {many && <b className="font-semibold text-text">{x.kind === "roadmap" ? `Roadmap run on ${x.title}` : x.title}:</b>}
          <span className="tnum">{detail(x)}</span>
          {x.justMoved && <span className="rounded bg-accent-soft px-1 text-[11px] font-semibold text-accent-ink">just now</span>}
          {many && action(x)}
        </p>
      ))}
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
        {!many && action(r)}
        {(r.state === "running" || r.state === "waiting" || r.state === "scheduled") && !many && <span>Until v{r.to} is approved, everyone keeps seeing v{r.from}.</span>}
        {r.state !== "done" && r.state !== "failed" && <span className="text-text-faint">Updates by itself</span>}
      </p>
    </div>
  );
}

/**
 * MOCK-HOOK: one slot per place a PRD or roadmap shows. `place` names where; `slot` is inline
 * (beside the version or title) or block (under the header). Draws nothing without ?rb=.
 */
export function RebuildSign({ place, slug, kind = "prd", slot, version }: { place: Where; slug: string; kind?: "prd" | "roadmap"; slot: "inline" | "block"; version?: number | null }) {
  const rb = useRebuilds();
  if (!rb) return null;
  // The new version is the one after what the page shows.
  const runs = runsFor(rb, slug, kind).map((r) => (version != null && r.slug === slug ? { ...r, from: version, to: version + 1 } : r));
  if (!runs.length) return null;
  // The new version lands: the sign says so until it is opened (or approved), then goes away.
  if (rb.state === "done" && rb.opened) return null;
  const p = rb.proposal;
  const list = place === "list-row" || place === "home";
  if (slot === "inline") {
    // The four-PRD roadmap: its chip says how many of its PRDs rebuild, then names it.
    const summary = kind === "roadmap" && rb.hard === "four" && rb.state === "running" ? `2 of 4 PRDs rebuilding · Product roadmap v8 after` : undefined;
    if (p === "a") return <Chip runs={runs} compact={list} onOpen={rb.open} summary={summary} />;
    if (p === "c") return <Marker runs={runs} />;
    if (p === "b" && list) return <Marker runs={runs} />;
    return null;
  }
  if (p === "b" && !list) return <Banner runs={runs} onOpen={rb.open} />;
  if (p === "c" && !list) return <Note runs={runs} onOpen={rb.open} />;
  return null;
}

/** MOCK-HOOK: Home's part: what shared with me is being rebuilt, each in the proposal's own sign. */
export function RebuildHome() {
  const rb = useRebuilds();
  if (!rb) return null;
  if (rb.state === "done" && rb.opened) return null;
  const items =
    rb.hard === "four"
      ? [{ slug: REBUILD_ROADMAP, kind: "roadmap" as const, title: "Product roadmap", href: "/simple/roadmap" }]
      : [
          { slug: REBUILD_PRD, kind: "prd" as const, title: "Checkout redesign PRD", href: `/simple/one-pagers/${REBUILD_PRD}` },
          ...(rb.hard === "two" ? [] : [{ slug: REBUILD_ROADMAP, kind: "roadmap" as const, title: "Product roadmap", href: "/simple/roadmap" }]),
        ];
  if (rb.proposal === "b") {
    const runs = rb.hard === "four" ? runsFor(rb, REBUILD_ROADMAP, "roadmap") : rb.hard === "two" ? runsFor(rb, REBUILD_PRD, "prd") : rb.runs;
    return <Banner runs={runs} onOpen={rb.open} />;
  }
  return (
    <section className="simple-card" aria-label="Being rebuilt" data-testid="rb-home">
      <h2 className="simple-h2">Being rebuilt</h2>
      <ul className="flex flex-col">
        {items.map((it) => (
          <li key={it.slug} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-2.5 last:border-b-0">
            <Link href={it.href} className="min-w-0 font-semibold break-words hover:underline">
              {it.title}
            </Link>
            <span className="ml-auto max-w-full">
              <RebuildSign place="home" slug={it.slug} kind={it.kind} slot="inline" />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
