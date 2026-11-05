"use client";

// The rebuild sign (owner's pick A, PR 1232's status chip): a live chip beside a PRD's or
// roadmap's version saying the run that will make its next version, opening the run's steps,
// who started it, its next stop and who it waits on, what will change, and Open run.
// GET /v1/rebuilds (oracle.runs.rebuilds), re-read every 5 s while a run runs (the run
// page's POLL_MS, RunDetail in app/runs/_run-detail.tsx) and the tab is shown, once a minute
// while one waits on a person or to start; else only when the tab comes back. Always also on
// a page change, on focus and after a change is saved.

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { api, type Schemas } from "@/lib/api/client";
import { useCompanyZone, zoneDateTime, zoneTime, zoneWeekday } from "@/lib/dates";
import { versionHref } from "@/lib/version-href";

type Rebuild = Schemas["Rebuild"];
type State = Rebuild["state"];
type Data = Schemas["RebuildsOut"];

/** While a run runs, the sign re-reads as often as the run page does. */
export const POLL_MS = 5000;
/** While a run waits on a person or to start (that may be days): once a minute. */
export const WAIT_POLL_MS = 60_000;
/** Landed versions this browser opened ("v4 ready: review it" goes away), as "slug@4". */
export const OPENED_KEY = "po-rebuild-opened";
/** A change that may start, move or end a run: the sign re-reads at once. */
export const REBUILDS_CHANGED = "po-rebuilds-changed";

// One shared read for every sign on the page.
let data: Data | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let reading = false;
let again = false;
let opened: string[] | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
/** How soon to read again: soon while a run runs, slowly while one waits, else never. */
const pollMs = (d: Data | null) =>
  d?.rebuilds.some((r) => r.state === "running") ? POLL_MS : d?.rebuilds.some((r) => r.state === "waiting" || r.state === "scheduled") ? WAIT_POLL_MS : null;

async function read() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (reading) {
    again = true;
    return;
  }
  reading = true;
  try {
    const { data: got } = await api.GET("/v1/rebuilds");
    if (got) {
      data = got;
      emit();
    }
  } catch {
    // A failed read keeps what the sign said; the next read tries again.
  } finally {
    reading = false;
  }
  if (again) {
    again = false;
    return read();
  }
  schedule();
}

/** The next read while the tab is shown: in 5 s while a run runs, in a minute while one waits; else none until a wake. */
function schedule() {
  if (timer) clearTimeout(timer);
  timer = null;
  const ms = pollMs(data);
  if (!listeners.size || document.hidden || ms == null) return;
  timer = setTimeout(() => void read(), ms);
}

/** Re-read now, if a sign is on the page. */
export function refreshRebuilds() {
  if (listeners.size) void read();
}

const wake = () => {
  if (document.hidden) {
    if (timer) clearTimeout(timer);
    timer = null;
  } else refreshRebuilds();
};

// A saved change (Approve, a run started or stopped) re-reads at once: the done chip must
// not wait for the next read.
api.use({
  onResponse({ request, response }) {
    if (request.method !== "GET" && response.ok && !request.url.includes("/v1/rebuilds")) setTimeout(refreshRebuilds, 0);
  },
});

function subscribe(l: () => void) {
  listeners.add(l);
  if (listeners.size === 1) {
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    window.addEventListener(REBUILDS_CHANGED, wake);
    void read();
  }
  return () => {
    listeners.delete(l);
    if (listeners.size) return;
    document.removeEventListener("visibilitychange", wake);
    window.removeEventListener("focus", wake);
    window.removeEventListener(REBUILDS_CHANGED, wake);
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

function openedIds(): string[] {
  if (opened) return opened;
  try {
    opened = JSON.parse(localStorage.getItem(OPENED_KEY) ?? "[]") as string[];
  } catch {
    opened = [];
  }
  return opened;
}

const versionKey = (slug: string, n: number) => `${slug}@${n}`;

/** A landed version this person opened: its "ready: review it" goes away. */
export function markVersionOpened(slug: string, n: number) {
  const id = versionKey(slug, n);
  if (openedIds().includes(id)) return;
  opened = [...openedIds(), id].slice(-50);
  localStorage.setItem(OPENED_KEY, JSON.stringify(opened));
  listeners.forEach((l) => l());
}

const getData = () => data;
const getOpened = () => (typeof window === "undefined" ? null : openedIds());
const noop = () => () => {};

/**
 * The runs that will make a new version of a document, live; null until read. A landed
 * version this person opened is left out, except on `own`, the document's own page, which
 * says it until it is approved (frames a-one-pager-done and a-detailed-done).
 */
export function useRebuilds(own?: string) {
  const d = useSyncExternalStore(subscribe, getData, () => null);
  const seen = useSyncExternalStore(subscribe, getOpened, () => null);
  // A page change re-reads: what was started or approved elsewhere shows at once.
  const path = usePathname();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    refreshRebuilds();
  }, [path]);
  if (!d) return null;
  return { ...d, rebuilds: d.rebuilds.filter((r) => r.state !== "done" || r.document_slug === own || !seen?.includes(versionKey(r.document_slug, r.to_version))) };
}

/** The version page (and a page showing a version): it marks that version opened. */
export function RebuildSeen({ slug, version }: { slug: string; version: number }) {
  useSyncExternalStore(noop, getOpened, () => null);
  useEffect(() => {
    if (slug && Number.isFinite(version)) markVersionOpened(slug, version);
  }, [slug, version]);
  return null;
}

/** The version page's own: the version in its URL (/documents/<slug>/v/<n>). */
export function RebuildSeenHere() {
  const { doc, n } = useParams<{ doc: string; n: string }>();
  return <RebuildSeen slug={decodeURIComponent(doc)} version={Number(n)} />;
}

type Rb = NonNullable<ReturnType<typeof useRebuilds>>;

/** The run the chip names first: one that moves, then one set to start, then the rest. */
const ORDER: Record<State, number> = { running: 0, waiting: 1, scheduled: 2, failed: 3, done: 4 };
const byState = (a: Rebuild, b: Rebuild) => ORDER[a.state] - ORDER[b.state];

/**
 * A document's runs: its own and, for a PRD, a roadmap run that reads it (frame
 * a-one-pager-running-rbcasetwo); for the company roadmap, the PRD runs that feed it.
 */
function runsFor(rb: Rb, slug: string) {
  const own = rb.rebuilds.filter((r) => r.document_slug === slug || r.source_slug === slug).sort(byState);
  // A new PRD still being written feeds nothing yet: it is not one of the roadmap's PRDs.
  const feeds = rb.company_roadmap?.slug === slug ? rb.rebuilds.filter((r) => r.document_kind === "prd" && !r.new_document && r.document_slug !== slug).sort(byState) : [];
  return { own, feeds };
}

function stepsWord(r: Rebuild) {
  return `step ${r.step} of ${r.steps.length}`;
}

/** A document's name; a new one not written yet may have none but its slug, said in words. */
export function titleOf(r: Rebuild) {
  if (r.document_title) return r.document_title;
  const words = r.document_slug.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A new document being written: "New PRD", "New roadmap". */
export const newWord = (r: Rebuild) => (r.document_kind === "roadmap" ? "New roadmap" : r.document_kind === "prd" || !r.document_kind ? "New PRD" : "New document");

/** A run writing a new document: no page of it yet, so the line says it is being written. */
function newLine(r: Rebuild, zone: string) {
  switch (r.state) {
    case "running":
      return `Being written · ${stepsWord(r)}${r.minutes_left != null ? ` · about ${r.minutes_left} min` : ""}`;
    case "scheduled":
      return r.scheduled_for ? `Being written · starts ${zoneWeekday(r.scheduled_for, zone).split(",")[0]} ${zoneTime(r.scheduled_for, zone)}` : "Being written · not started yet";
    case "waiting":
      return `Being written · waiting on ${(r.waits_on ?? "a person").split(" ")[0]}`;
    case "failed":
      return `Writing stopped at ${stepsWord(r)}`;
    case "done":
      return `v${r.to_version} ready: review it`;
  }
}

/** The short line for one run, as the chip says it. */
function line(r: Rebuild, zone: string, roadmap: boolean) {
  if (r.new_document) return newLine(r, zone);
  switch (r.state) {
    case "running": {
      const left = r.minutes_left != null ? ` · about ${r.minutes_left} min` : "";
      return roadmap ? `Rebuilding ${r.document_title} v${r.to_version} · ${stepsWord(r)}${left}` : `Rebuilding v${r.to_version} · ${stepsWord(r)}${left}`;
    }
    case "scheduled":
      return r.scheduled_for ? `Rebuild scheduled ${zoneWeekday(r.scheduled_for, zone)}, ${zoneTime(r.scheduled_for, zone)}` : "Rebuild not started yet";
    case "waiting":
      return `Waiting on ${r.waits_on ?? "a person"} · ${stepsWord(r)}`;
    case "failed":
      return `Rebuild stopped at ${stepsWord(r)}`;
    case "done":
      return `v${r.to_version} ready: review it`;
  }
}

/** Lists and Home: the compact chip. */
function shortLine(r: Rebuild, zone: string) {
  if (r.new_document) return newLine(r, zone);
  switch (r.state) {
    case "running":
      return `Rebuilding v${r.to_version} · ${r.step}/${r.steps.length}`;
    case "scheduled":
      return r.scheduled_for ? `Rebuild ${zoneWeekday(r.scheduled_for, zone).split(",")[0]} ${zoneTime(r.scheduled_for, zone).replace(/ [A-Z]{2,5}$/, "")}` : "Rebuild waiting";
    case "waiting":
      return `Waiting on ${(r.waits_on ?? "a person").split(" ")[0]}`;
    case "failed":
      return "Rebuild stopped";
    case "done":
      return `v${r.to_version} ready: review it`;
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


function Steps({ r }: { r: Rebuild }) {
  return (
    <ol className="flex flex-col gap-1 text-[13px] leading-[18px]" data-testid="rb-steps">
      {r.steps.map((s, i) => {
        const n = i + 1;
        const done = r.state === "done" || n < r.step || (n === r.step && r.state === "waiting");
        const now = n === r.step && (r.state === "running" || r.state === "failed");
        return (
          <li key={`${n}-${s}`} className={`flex items-center gap-2 ${now ? "font-semibold text-text" : done ? "text-text2" : "text-text-faint"}`}>
            <span aria-hidden className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] ${done ? "bg-pass-bg text-pass" : now ? (r.state === "failed" ? "bg-crit-bg text-crit" : "bg-accent-soft text-accent-ink") : "border border-line"}`}>
              {done ? "✓" : n}
            </span>
            <span className="min-w-0 break-words">{s}</span>
          </li>
        );
      })}
      {r.state === "waiting" && r.waits_on && (
        <li className="flex items-center gap-2 font-semibold text-text">
          <span aria-hidden className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-warn-bg text-[10px] text-warn">
            …
          </span>
          <span className="min-w-0 break-words">Review stop: {r.waits_on}</span>
        </li>
      )}
    </ol>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** What happens to the page while it runs, in one sentence. */
function outcome(r: Rebuild) {
  const was = r.from_version != null ? `v${r.from_version}` : null;
  if (r.new_document && r.state !== "failed") return `It writes a ${newWord(r).replace(/^New/, "new")}, ${titleOf(r)}. Nobody reads it until it is approved.`;
  if (r.state === "done") return was ? `v${r.to_version} is a draft until it is approved. Until then, everyone keeps seeing ${was}.` : `v${r.to_version} is a draft until it is approved.`;
  if (r.state === "failed") {
    const why = (r.error ?? "It stopped").replace(/\.$/, "");
    return `${why} at "${r.steps[r.step - 1] ?? "its last step"}". Nothing changed${was ? `: you still read ${was}` : ""}.`;
  }
  if (!was) return `It makes a new draft, v${r.to_version}. Nobody reads it until it is approved.`;
  return r.document_kind === "roadmap"
    ? `It makes a new draft, v${r.to_version}. Until v${r.to_version} is approved, everyone keeps seeing the approved roadmap (${was}).`
    : `It makes a new draft, v${r.to_version}. Until v${r.to_version} is approved, everyone keeps seeing ${was}.`;
}

function RunAction({ r }: { r: Rebuild }) {
  const cls = "simple-button whitespace-nowrap";
  if (r.state === "waiting" && r.waits_on_action)
    return (
      <Link href={r.review_link ?? `/runs/${r.run_id}`} className={`${cls} simple-button-primary`}>
        {cap(r.waits_on_action)}
      </Link>
    );
  if (r.state === "done")
    return (
      <Link href={versionHref(r.document_slug, r.document_kind, r.to_version)} className={`${cls} simple-button-primary`} onClick={() => markVersionOpened(r.document_slug, r.to_version)}>
        Review v{r.to_version}
      </Link>
    );
  return (
    <Link href={`/runs/${r.run_id}`} className={cls}>
      Open run
    </Link>
  );
}

/** The run's details: steps, who started it, its stop, what will change and Open run. */
function RunCard({ r, zone }: { r: Rebuild; zone: string }) {
  const kind = r.flow === "prd_to_roadmap" ? "Roadmap run" : r.flow === "feedback_loop" ? "Regenerate" : r.flow_title;
  return (
    <div className="flex flex-col gap-2" data-testid="rb-run">
      <p className="text-[14px] leading-[20px] font-semibold text-text">
        {kind} · {titleOf(r)}
      </p>
      <p className="text-[13px] leading-[18px] text-text2">
        {r.state === "scheduled"
          ? `Set up by ${r.started_by ?? "someone"}${r.scheduled_for ? ` · starts ${zoneWeekday(r.scheduled_for, zone)}, ${zoneTime(r.scheduled_for, zone)}` : " · not started yet"}`
          : `Started by ${r.started_by ?? "someone"}${r.started_at ? ` · ${zoneDateTime(r.started_at, zone)}` : ""}`}
      </p>
      {r.state !== "scheduled" && <Steps r={r} />}
      {(r.state === "running" || r.state === "scheduled") && r.next_stop_who && r.next_stop_action && (
        <p className="text-[13px] leading-[18px] text-text2">
          Next stop: <b className="font-semibold text-text">{r.next_stop_who}</b> will {r.next_stop_action}.
        </p>
      )}
      {r.state === "waiting" && r.waits_on && (
        <p className="text-[13px] leading-[18px] text-text2">
          Waiting on <b className="font-semibold text-text">{r.waits_on}</b> to {r.waits_on_action}.
        </p>
      )}
      <p className="text-[13px] leading-[18px] text-text2">{outcome(r)}</p>
      <div>
        <RunAction r={r} />
      </div>
    </div>
  );
}

/** The live chip beside the version, opening its popover. */
function Chip({ runs, compact, summary, roadmap }: { runs: Rebuild[]; compact?: boolean; summary?: string; roadmap?: boolean }) {
  const zone = useCompanyZone();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  // "just now": the moment a read moves the run to its next step.
  const r = runs[0];
  const at = `${r.run_id}:${r.state}:${r.step}`;
  const last = useRef(at);
  const [moved, setMoved] = useState(false);
  useEffect(() => {
    if (last.current === at) return;
    const was = last.current;
    last.current = at;
    if (!was.startsWith(`${r.run_id}:`)) return;
    setMoved(true);
    const t = setTimeout(() => setMoved(false), 4000);
    return () => clearTimeout(t);
  }, [at, r.run_id]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const more = runs.length - 1;
  const justMoved = moved && r.state === "running";
  const text = summary ?? (compact ? shortLine(r, zone) : line(r, zone, !!roadmap && r.document_kind === "roadmap"));
  return (
    <span ref={ref} className="relative inline-flex max-w-full">
      <button
        type="button"
        data-testid="rb-chip"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`relative z-[1] inline-flex min-h-6 max-w-full items-center gap-1.5 rounded-xl px-[9px] py-0.5 text-left text-[13px] leading-[18px] font-semibold ${TONE[r.state]} ${justMoved ? "ring-2 ring-accent/40" : ""}`}
      >
        <Dot state={r.state} />
        <span className="min-w-0 break-words">{text}</span>
        {justMoved && !compact && <span className="rounded bg-surface/70 px-1 text-[11px] whitespace-nowrap">just now</span>}
        {more > 0 && !summary && <span className="rounded-lg bg-surface/70 px-1.5 text-[12px] whitespace-nowrap">+{more} {more === 1 ? "run" : "runs"}</span>}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="What is rebuilding this"
          data-testid="rb-popover"
          className="absolute top-[calc(100%+6px)] left-0 z-30 flex w-[340px] flex-col gap-3 rounded-xl border border-line-strong bg-surface p-3.5 text-left font-normal shadow-lg max-[600px]:fixed max-[600px]:top-auto max-[600px]:right-3 max-[600px]:bottom-[calc(var(--phone-tab-bar,0px)+12px)] max-[600px]:left-3 max-[600px]:w-auto max-[600px]:max-h-[70vh] max-[600px]:overflow-y-auto"
        >
          {runs.map((x, i) => (
            <div key={x.run_id} className={i > 0 ? "border-t border-line pt-3" : undefined}>
              <RunCard r={x} zone={zone} />
            </div>
          ))}
          <p className="text-[12px] leading-[16px] text-text-faint">Updates by itself while the run moves.</p>
        </div>
      )}
    </span>
  );
}

/**
 * The sign beside a PRD's or roadmap's version or title: nothing while no run will make a
 * new version of it. `compact` in lists and on Home.
 */
export function RebuildSign({ slug: named, compact = false, own = false }: { slug: string | null; compact?: boolean; own?: boolean }) {
  // `own`: the document's own page (the one-pager, the Detailed page) keeps "ready: review it".
  const rb = useRebuilds(own && named ? named : undefined);
  // No document named (the Roadmap's All roadmaps): the company roadmap.
  const slug = named ?? rb?.company_roadmap?.slug;
  if (!rb || !slug) return null;
  const sign = signFor(rb, slug);
  if (!sign) return null;
  return <Chip runs={sign.runs} compact={compact} summary={sign.summary} roadmap={sign.roadmap} />;
}

/** What a document's sign shows: its runs, first the one the chip names, and A's summary. */
function signFor(rb: Rb, slug: string) {
  const { own, feeds } = runsFor(rb, slug);
  const roadmap = rb.company_roadmap?.slug === slug;
  // The company roadmap fed by several PRDs: how many of them rebuild, then its own run. Only
  // then are the PRDs' runs folded in (A's '2 of 4 PRDs rebuilding'); else its own runs.
  const rebuilding = feeds.filter((r) => r.state === "running" || r.state === "waiting");
  const summary = roadmap && rebuilding.length > 1 && !own.some((r) => r.state === "running" || r.state === "waiting") ? `${rebuilding.length} of ${rb.company_roadmap!.prds} PRDs rebuilding · the roadmap updates after them` : undefined;
  const runs = summary ? [...rebuilding, ...own] : own;
  if (!runs.length) return null;
  return { runs, summary, roadmap: roadmap || runs[0].document_kind === "roadmap" };
}

/** Home's part: what shared with me is being rebuilt, each with its compact chip. */
export function RebuildHome() {
  const rb = useRebuilds();
  if (!rb || !rb.rebuilds.length) return null;
  const items = new Map<string, { slug: string; title: string; href: string }>();
  for (const r of rb.rebuilds) {
    if (items.has(r.document_slug)) continue;
    const roadmap = r.document_kind === "roadmap" || rb.company_roadmap?.slug === r.document_slug;
    // A new document has no page until its first version: the row opens the run writing it.
    const href = r.new_document ? `/runs/${r.run_id}` : roadmap ? "/simple/roadmap" : `/simple/one-pagers/${r.document_slug}`;
    items.set(r.document_slug, { slug: r.document_slug, title: r.new_document ? `${newWord(r)}: ${titleOf(r)}` : titleOf(r), href });
  }
  // As A: the heading says what every row's chip says first.
  const states = new Set([...items.values()].map((it) => signFor(rb, it.slug)?.runs[0].state));
  const heading = states.size === 1 && states.has("done") ? "New versions ready" : states.size === 1 && states.has("failed") ? "Rebuilds that stopped" : "Being rebuilt";
  return (
    <section className="simple-card" aria-label={heading} data-testid="rb-home">
      <h2 className="simple-h2">{heading}</h2>
      <ul className="flex flex-col">
        {[...items.values()].map((it) => (
          <li key={it.slug} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-2.5 last:border-b-0">
            <Link href={it.href} className="min-w-0 font-semibold break-words hover:underline">
              {it.title}
            </Link>
            <span className="ml-auto max-w-full">
              <RebuildSign slug={it.slug} compact />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
