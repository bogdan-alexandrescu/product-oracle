"use client";

// MOCK-HOOK: this whole file is mock-up code for SW1 (Simple Home when a run waits on you).
// ?sw1=a|b|c|d picks the proposal, &open=1 opens D's tray; the mock's ?swn=0|1|3 sets how many stops wait.

import Link from "next/link";
import { useEffect, useState } from "react"; // MOCK-HOOK

import { Icon } from "@/components/ds/Icon"; // MOCK-HOOK
import type { Schemas } from "@/lib/api/client"; // MOCK-HOOK
import { formatInZone, useCompanyZone } from "@/lib/dates"; // MOCK-HOOK
import { loadInbox, onWaitingChanged } from "@/lib/waiting"; // MOCK-HOOK

import { CHECKPOINT_LABEL } from "../../runs/_lib"; // MOCK-HOOK

export type SwVariant = "a" | "b" | "c" | "d"; // MOCK-HOOK
export type Stop = Schemas["InboxOut"]["checkpoints"][number]; // MOCK-HOOK

/** MOCK-HOOK: the proposal in the address (?sw1=), none = the product as built. */
export function swVariant(): SwVariant | null {
  if (typeof window === "undefined") return null; // MOCK-HOOK
  const v = new URLSearchParams(window.location.search).get("sw1"); // MOCK-HOOK
  return v === "a" || v === "b" || v === "c" || v === "d" ? v : null; // MOCK-HOOK
}

/** MOCK-HOOK: carries the mock-up's switches onto a link, so the next page tells the same story. */
export function swHref(href: string): string {
  if (typeof window === "undefined") return href; // MOCK-HOOK
  const q = new URLSearchParams(window.location.search); // MOCK-HOOK
  const keep = new URLSearchParams(); // MOCK-HOOK
  for (const k of ["sw1", "swn", "calm"]) if (q.get(k)) keep.set(k, q.get(k)!); // MOCK-HOOK
  const s = keep.toString(); // MOCK-HOOK
  return s ? `${href}${href.includes("?") ? "&" : "?"}${s}` : href; // MOCK-HOOK
}

/** MOCK-HOOK: the run stops that wait on me (the Inbox's checkpoints I may decide), oldest first. */
export function useRunStops(): { stops: Stop[] | undefined; variant: SwVariant | null } {
  const [stops, setStops] = useState<Stop[] | undefined>(undefined); // MOCK-HOOK
  const [variant, setVariant] = useState<SwVariant | null>(null); // MOCK-HOOK
  const [n, setN] = useState(0); // MOCK-HOOK
  useEffect(() => onWaitingChanged(() => setN((x) => x + 1)), []); // MOCK-HOOK
  useEffect(() => {
    setVariant(swVariant()); // MOCK-HOOK
    let alive = true; // MOCK-HOOK
    loadInbox()
      .then((i) => alive && setStops(i.checkpoints.filter((c) => c.can_decide && c.status === "pending").sort((a, b) => a.created_at.localeCompare(b.created_at)))) // MOCK-HOOK
      .catch(() => alive && setStops([])); // MOCK-HOOK
    return () => {
      alive = false; // MOCK-HOOK
    };
  }, [n]);
  return { stops, variant }; // MOCK-HOOK
}

/** MOCK-HOOK: the one action a stop asks of the person, in plain words. */
const ACTION: Partial<Record<Stop["kind"], string>> = {
  feature_set: "Check the feature set", // MOCK-HOOK
  eng_review: "Check the engineering review", // MOCK-HOOK
  priority_order: "Set the order", // MOCK-HOOK
  prd_review: "Review the PRD", // MOCK-HOOK
  eng_dates: "Review the dates", // MOCK-HOOK
  roadmap_items: "Check the roadmap items", // MOCK-HOOK
  baseline_confirm: "Confirm the baseline", // MOCK-HOOK
};

/** MOCK-HOOK: what the stop is, in the run page's own words (only "Feature set" is shortened). */
const NAME: Partial<Record<Stop["kind"], string>> = {
  feature_set: "Feature set", // MOCK-HOOK
};

export const stopName = (s: Stop) => NAME[s.kind] ?? CHECKPOINT_LABEL[s.kind]; // MOCK-HOOK
export const stopAction = (s: Stop) => ACTION[s.kind] ?? "Open the stop"; // MOCK-HOOK
export const stopHref = (s: Stop) => swHref(`/runs/${s.run_id}`); // MOCK-HOOK: the run page tells the same story (calm, swn)
/** MOCK-HOOK: what the run is for: its PRD, else the flow. */
export const stopFor = (s: Stop & { document_title?: string | null; document_slug?: string | null; flow_title?: string }) =>
  s.document_title || (s.document_slug ? `${s.document_slug.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase())} PRD` : s.flow_title || "A run"); // MOCK-HOOK

/** MOCK-HOOK: "Waiting since Tue, Oct 27" in the company's zone. */
function Since({ s }: { s: Stop }) {
  const zone = useCompanyZone(); // MOCK-HOOK
  return <>Waiting since {formatInZone(s.created_at, zone, { weekday: "short", month: "short", day: "numeric" })}</>; // MOCK-HOOK
}

/** MOCK-HOOK: the stop's summary line, when the Inbox gives one. */
const summaryOf = (s: Stop) => ((s as { summary?: string | null }).summary ?? null); // MOCK-HOOK

/** MOCK-HOOK (A): one card per stop, its one action on the right. */
export function StopCard({ s }: { s: Stop }) {
  return (
    <section aria-label={`${stopName(s)}: ${stopFor(s)}`} data-testid="sw-stop-card" className="simple-card">
      <div className="flex flex-wrap items-center gap-3">
        <span aria-hidden className="grid size-9 flex-none place-items-center rounded-full bg-warn-bg text-warn">
          <Icon name="runs" size={20} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="simple-h2 break-words">
            {stopName(s)} <span className="font-normal text-text2">· {stopFor(s)}</span>
          </h2>
          <p className="simple-small">
            A run waits on you to go on. <Since s={s} />
          </p>
        </div>
        <Link href={stopHref(s)} className="simple-button simple-button-primary max-[600px]:w-full max-[600px]:justify-center">
          {stopAction(s)}
        </Link>
      </div>
      {summaryOf(s) && <p className="simple-small mt-2 pl-12 max-[600px]:pl-0">{summaryOf(s)}</p>}
    </section>
  );
}

/** MOCK-HOOK (B): one line; the stops themselves stay in Detailed's In flight. */
export function RunsLine({ stops }: { stops: Stop[] }) {
  const names = stops.map(stopName); // MOCK-HOOK
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`; // MOCK-HOOK
  return (
    <section aria-label="Runs waiting" data-testid="sw-runs-line" className="simple-card">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span aria-hidden className="grid size-9 flex-none place-items-center rounded-full bg-warn-bg text-warn">
          <Icon name="runs" size={20} />
        </span>
        <span className="min-w-0 flex-1">
          <strong>{stops.length === 1 ? "A run waits on you" : `${stops.length} runs wait on you`}</strong>
          <span className="simple-small block">{list}</span>
        </span>
        <Link href={swHref("/home")} className="simple-link whitespace-nowrap">
          Open in Detailed -&gt;
        </Link>
      </p>
    </section>
  );
}

/** MOCK-HOOK (C, D): a stop as a row: its name and run, then its one action. */
export function StopRow({ s, compact = false }: { s: Stop; compact?: boolean }) {
  return (
    <li data-testid="sw-stop-row" className={compact ? "flex flex-col gap-2 border-t border-line py-3 first:border-t-0" : "simple-row"}>
      {!compact && (
        <span aria-hidden className="grid size-9 flex-none place-items-center rounded-full bg-warn-bg text-warn">
          <Icon name="runs" size={20} />
        </span>
      )}
      <div className="flex min-w-0 flex-col gap-1">
        <span className="font-semibold break-words">
          {stopName(s)} · {stopFor(s)}
        </span>
        <span className="simple-small">
          A run waits on you. <Since s={s} />
        </span>
      </div>
      <div className={compact ? "" : "simple-actions"}>
        <Link href={stopHref(s)} className={`simple-button ${compact ? "" : "simple-button-primary"}`}>
          {stopAction(s)}
        </Link>
      </div>
    </li>
  );
}

/** MOCK-HOOK (D): the rail's Runs entry and its tray of stops. */
export function RunTray({ phone = false }: { phone?: boolean }) {
  const { stops, variant } = useRunStops(); // MOCK-HOOK
  const [open, setOpen] = useState(false); // MOCK-HOOK
  useEffect(() => setOpen(new URLSearchParams(window.location.search).get("open") === "1"), []); // MOCK-HOOK
  if (variant !== "d") return null; // MOCK-HOOK
  const n = stops?.length ?? 0; // MOCK-HOOK
  const tray = open && (
    <div
      role="dialog"
      aria-label="Runs waiting on you"
      data-testid="sw-tray"
      className={
        phone
          ? "fixed inset-x-0 bottom-[var(--phone-tab-bar)] z-[45] max-h-[70dvh] overflow-auto rounded-t-[18px] border-t border-line bg-surface px-5 pt-4 pb-3 shadow-panel"
          : "fixed top-24 left-[calc(var(--simple-rail-width)+8px)] z-[45] w-[420px] rounded-[18px] border border-line bg-surface px-5 pt-4 pb-3 shadow-panel"
      }
    >
      <header className="flex items-center gap-3">
        <h2 className="simple-h2 flex-1">Runs waiting on you</h2>
        <button type="button" aria-label="Close" className="simple-button" onClick={() => setOpen(false)}>
          <Icon name="x" size={18} />
        </button>
      </header>
      {n === 0 ? (
        <p className="simple-small py-3">No run waits on you. Runs that need you show here.</p>
      ) : (
        <ul className="mt-1">
          {stops!.map((s) => (
            <StopRow key={s.id} s={s} compact />
          ))}
        </ul>
      )}
    </div>
  );
  if (phone)
    return (
      <>
        {n > 0 && (
          <button
            type="button"
            data-testid="sw-tray-chip"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className="fixed right-3 bottom-[calc(var(--phone-tab-bar)+12px)] z-[41] hidden items-center gap-2 rounded-full border border-line bg-surface px-4 py-2.5 text-[16px] font-semibold shadow-panel max-[600px]:flex"
          >
            <Icon name="runs" size={18} />
            Runs
            <span className="simple-count tnum">{n}</span>
          </button>
        )}
        <div className="hidden max-[600px]:block">{tray}</div>
      </>
    );
  return (
    <>
      <button
        type="button"
        data-testid="sw-tray-button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex h-12 items-center gap-3 rounded-xl px-3 text-[length:var(--simple-rail-label)] leading-6 font-medium text-rail-text hover:bg-rail-hover hover:text-rail-active-text ${open ? "ring-1 ring-line-strong ring-inset" : ""}`} // MOCK-HOOK: open is a ring, not "current": Home stays the one current entry
      >
        <Icon name="runs" stroke={1.7} />
        <span className="min-w-0 flex-1 truncate text-left">Runs</span>
        {n > 0 && <span className="simple-count tnum">{n}</span>}
      </button>
      <div className="max-[600px]:hidden">{tray}</div>
    </>
  );
}
