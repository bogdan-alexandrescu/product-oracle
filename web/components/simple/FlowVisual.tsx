"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatInZone, useCompanyZone } from "@/lib/dates";
import { useQuery } from "@/lib/use-query";

import { Code, FlowDiagram, FlowScreen, FlowStepList, Icon, ICONS, ScreenCard, stepsOf, StoryCard, Tabs, usePhone } from "./FlowViews";

type Flow = Schemas["SimpleFlow"];
type Visual = Schemas["SimpleVisualOut"];
export type FlowSubject = { kind: string; id: string };

/** The subject a flow is the visual of, when the API names it. */
export function subjectOf(flow: { subject_kind?: string | null; subject_id?: string | null } | null | undefined): FlowSubject | null {
  return flow?.subject_kind && flow.subject_id ? { kind: flow.subject_kind, id: flow.subject_id } : null;
}

/** How long a running drawing job reads as "Draw the steps" before "Draw the screen". */
const RUN_SCREEN_MS = 15000;
/** A drawing made this recently carries "New" (the row need not have watched it land). */
const NEW_MS = 15 * 60 * 1000;

/** "PDT"/"PST" read as "PT" (as the daily run's time does); other zones keep their short name ("CET"). */
const friendlyZone = (time: string): string => time.replace(/\b(P|M|C|E|AK)[SD]T$/, "$1T");

/** "Oct 26, 8:00 AM PT": a time in the company's zone, always with its day, in the app's month-first style, with the
 * zone's friendly name (qa-simple-prd-20; qa-simple-prd-p3-14: never a time with no day; qa-simple-roadmap-29:
 * never "PDT"). */
export const clock = (iso: string, zone: string): string => {
  const time = formatInZone(iso, zone, { hour: "numeric", minute: "2-digit" });
  if (time === iso) return iso;
  return `${formatInZone(iso, zone, { month: "short", day: "numeric" })}, ${friendlyZone(time)}`;
};

/** A flow: three steps joined left to right (qa-simple-prd-33: not the Roadmap's icon). */
const FLOW_ICON = "r,2,9,5,6,1.5|r,9.5,9,5,6,1.5|r,17,9,5,6,1.5|M7 12h2.5M14.5 12h2.5";

/** "6 steps · 1 screen". */
export function flowSize(flow: Flow): string {
  const n = flow.nodes?.length || flow.steps.length;
  return `${n} step${n === 1 ? "" : "s"} · ${flow.touches_screen ? "1 screen" : "no screen"}`;
}

/** "Version 1 · drawn Oct 26, 7:04 PM PT" (the time in the company's zone, with its day). */
export function flowDrawn(flow: Flow, zone: string): string {
  return `Version ${flow.version}${flow.made_at ? ` · drawn ${clock(flow.made_at, zone)}` : ""}`;
}

/** "6 steps · 1 screen · version 1 · drawn 26 Oct, 7:04 PM PT" (the time in the company's zone). */
export function flowMeta(flow: Flow, zone: string): string {
  return `${flowSize(flow)} · ${flowDrawn(flow, zone).replace(/^V/, "v")}`;
}

/** A subject's name starting with its code ("F-06 Weekly alert digest"): its code alone, as the stages say it. */
const codeOf = (name: string): string | null => /^([A-Z][A-Z0-9]*-\d+[a-z]?)\b/.exec(name)?.[1] ?? null;

/** "build" -> "Build": a PRD section's key, in plain words. */
const capSection = (key: string): string => key.charAt(0).toUpperCase() + key.slice(1);

// The mock-ups' buttons: .btn (32 px, 8 px corners) and .sbtn.sm (34 px, 10 px corners).
/** fix4 qa-simple-roadmap-48: a scrolling pane's scrollbar in the theme's colours (dark in dark mode). */
const SCROLL = "[scrollbar-color:var(--line-strong)_var(--surface)]";
const BTN = "inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 text-[14px] leading-none font-semibold whitespace-nowrap text-text hover:bg-surface2 disabled:opacity-60";
// qa-simple-roadmap-32: disabled must look disabled too (Revise reads enabled otherwise).
const BTN_SOLID = "inline-flex h-8 items-center gap-1.5 rounded-lg border border-accent bg-accent px-3 text-[14px] leading-none font-semibold whitespace-nowrap text-on-accent hover:bg-accent-ink disabled:cursor-not-allowed disabled:border-line-strong disabled:bg-surface2 disabled:text-text2 disabled:hover:bg-surface2";
const BTN_GHOST = "inline-flex h-8 items-center gap-1.5 rounded-lg px-1.5 text-[14px] leading-none font-semibold whitespace-nowrap text-accent-ink hover:bg-surface2";
const SBTN = "simple-button !min-h-[34px] gap-1.5 !px-3 !text-[14px]";
const META = "text-[13px] leading-[18px] text-text2";
const SUB = "mb-1.5 text-[15px] leading-[22px] font-semibold";

/** The drawing's row while there is none (A): none yet, Oracle drawing it (its stages, a bar,
 * when it started), or Oracle could not draw it. */
function NoDrawing({ v, busy, onAsk, showHint }: { v: Visual; busy: boolean; onAsk: () => void; showHint?: boolean }) {
  const zone = useCompanyZone();
  // The API says queued (0) or running (1): Oracle draws the steps, then the screen, in one
  // run, so a run past RUN_SCREEN_MS reads as drawing the screen (the bar fills past half).
  const running = v.pending && (v.stage ?? 0) >= 1;
  const [longRun, setLongRun] = useState(false);
  useEffect(() => {
    if (!running) return;
    const t = window.setTimeout(() => setLongRun(true), RUN_SCREEN_MS);
    return () => {
      window.clearTimeout(t);
      setLongRun(false);
    };
  }, [running]);
  if (v.pending) {
    const name = v.subject_name || "the PRD";
    const stages = [`Read ${codeOf(name) ?? name}`, "Draw the steps", "Draw the screen"];
    const at = Math.min(stages.length - 1, Math.max(0, v.stage ?? 0) + (running && longRun ? 1 : 0));
    return (
      <div data-testid="flow-empty" data-state="drawing">
        <div className="mt-2 flex items-start gap-3">
          <span aria-hidden className="flex-none rounded-lg border border-dashed border-line bg-surface2 p-1.5">
            <svg viewBox="0 0 172 56" width={150} className="block">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <g key={i}>
                  <rect x={4 + i * 28} y={16} width={20} height={20} rx={4} fill="var(--line)" opacity={0.7} />
                  {i < 5 && <path d={`M${25 + i * 28} 26 L${32 + i * 28} 26`} stroke="var(--line-strong)" strokeWidth={1.2} />}
                </g>
              ))}
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <b className="font-[650]">Oracle is drawing the flow</b>
            <p className={META}>About a minute</p>
          </div>
        </div>
        <div className="mt-2.5 flex flex-col gap-1.5">
          <ol className="flex flex-wrap gap-x-3 gap-y-1 text-[13px] leading-[18px] font-medium text-text2" aria-label="Stages">
            {stages.map((s, i) => (
              <li
                key={s}
                aria-current={i === at ? "step" : undefined}
                className={`flex items-center gap-[5px] ${i < at ? "text-pass" : i === at ? "font-[650] text-accent-ink" : ""}`}
              >
                <span
                  aria-hidden
                  className={`h-[9px] w-[9px] flex-none rounded-full border-[1.5px] ${i < at ? "border-pass bg-pass" : i === at ? "border-accent bg-accent-soft shadow-[0_0_0_3px_var(--accent-soft)]" : "border-line-strong"}`}
                />
                {s}
              </li>
            ))}
          </ol>
          <div role="progressbar" aria-label="Drawing" aria-valuemin={0} aria-valuemax={stages.length} aria-valuenow={at + 1} className="h-1.5 overflow-hidden rounded-[3px] bg-surface2">
            <span className="block h-full rounded-[3px] bg-accent transition-[width]" style={{ width: `${((at + 1) / (stages.length + 1)) * 100}%` }} />
          </div>
          <p className={META}>
            Updates here by itself; you can close the card.
            {v.started_at ? <span className="whitespace-nowrap"> Started {clock(v.started_at, zone)}.</span> : null}
          </p>
        </div>
      </div>
    );
  }
  if (v.failed) {
    return (
      <div className="mt-2 flex items-start gap-2.5 rounded-[10px] bg-crit-bg px-3 py-2.5 text-text" data-testid="flow-empty" data-state="failed">
        <span className="mt-0.5 text-crit">
          <Icon d={ICONS.warn} size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <b className="font-[650]">Oracle could not draw this flow.</b>{" "}
          <p className={META}>Nothing changed on the item.</p>
        </div>
        {v.can_revise && (
          <button type="button" className={SBTN} onClick={onAsk} disabled={busy}>
            <Icon d={ICONS.retry} />
            Retry
          </button>
        )}
      </div>
    );
  }
  return (
    <div data-testid="flow-empty" data-state="none">
      <div className="mt-2 flex flex-wrap items-start gap-3">
        {/* qa-simple-prd-p3-24: the stronger line, so the dashed box reads in dark as in light. */}
        <span aria-hidden className="grid h-[72px] w-[min(164px,35%)] flex-none place-items-center rounded-lg border border-dashed border-line-strong text-text-faint">
          <Icon d={FLOW_ICON} size={22} width={1.7} />
        </span>
        <div className="min-w-[180px] flex-1">
          <p className="text-text2">No flow yet</p>
          {v.can_revise && (
            <div className="mt-1.5">
              <button type="button" className={SBTN} onClick={onAsk} disabled={busy}>
                <Icon d={ICONS.sparkle} />
                Ask Oracle to draw it
              </button>
            </div>
          )}
        </div>
      </div>
      {showHint !== false && (
        // Once per list (qa-simple-prd-33): a row after one already giving the hint (bets in
        // one section, siblings in a list) leaves it out.
        <p data-testid="flow-hint" className={`simple-flow-hint mt-2 ${META} [li:has(.simple-flow-hint)~li_&]:hidden`}>
          {v.can_revise ? "Oracle draws the steps and the screen they touch, from the PRD." : "Oracle has not drawn a user flow or a screen for this yet."}
        </p>
      )}
    </div>
  );
}

/** Where Simple's page sits (between the rail and the Ask dock): the opened views lie over it. */
function useMainBox(on: boolean): { left: number; right: number } {
  const [box, setBox] = useState({ left: 16, right: 16 });
  useLayoutEffect(() => {
    if (!on) return;
    const read = () => {
      const r = document.querySelector("main")?.getBoundingClientRect();
      setBox(r ? { left: Math.round(r.left) + 16, right: Math.round(window.innerWidth - r.right) + 16 } : { left: 16, right: 16 });
    };
    read();
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, [on]);
  return box;
}

/** A modal layer: the focus moves into it and stays there (Tab cycles), Escape closes only it
 * (caught first, so the card under it stays open), and once it is gone the focus goes back to
 * what opened it. A layer under another (the opened view under the viewer) keeps its opener. */
function useModal(ref: React.RefObject<HTMLElement | null>, on: boolean, onEscape: () => void) {
  const esc = useRef(onEscape);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    esc.current = onEscape;
  });
  useEffect(() => {
    if (!on) return;
    const layer = ref.current;
    const active = document.activeElement as HTMLElement | null;
    if (!layer?.contains(active)) {
      opener.current = active;
      (layer?.querySelector<HTMLElement>("[data-first]") ?? layer)?.focus();
    }
    const onKey = (e: KeyboardEvent) => {
      const el = ref.current;
      if (e.key === "Tab" && el) {
        const all = [...el.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, iframe, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.hasAttribute("disabled") && x.getClientRects().length > 0);
        if (!all.length) return;
        const [a, z] = [all[0], all[all.length - 1]];
        const inside = el.contains(document.activeElement);
        if (e.shiftKey && (!inside || document.activeElement === a)) {
          e.preventDefault();
          z.focus();
        } else if (!e.shiftKey && (!inside || document.activeElement === z)) {
          e.preventDefault();
          a.focus();
        }
        return;
      }
      if (e.key !== "Escape") return;
      e.stopPropagation();
      esc.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      // Gone (not just under another layer): the focus goes back.
      if (!layer?.isConnected && opener.current?.isConnected) opener.current.focus();
    };
  }, [on, ref]);
}

function Layer({ children }: { children: ReactNode }) {
  return typeof document === "undefined" ? null : createPortal(children, document.body);
}

/**
 * Simple S10 (D26) drawn to the owner's flow picks (2026-10-28: A, a live thumbnail that opens a
 * readable view, with C, a full-screen viewer, and D, a storyboard of step cards): one Flow
 * component for the roadmap item card, a PRD line and a proposal.
 *
 * - The row (A, `row`): the flow's real shapes as a live thumbnail with its name, "New", "6 steps ·
 *   1 screen" and "Version 1 · drawn 26 Oct, 7:04 PM PT"; "Open the flow" and "Open the storyboard". Its
 *   states: no flow yet (Ask Oracle to draw it), drawing (stages, a bar, when it started; it swaps
 *   itself in), failed (Retry). `line`: the card's compact line beside its talk (a small picture
 *   and the flow's name).
 * - Opened (A): across the page, the whole diagram, then every step in full words beside the screen
 *   it touches; Full screen, Comment (the comments, opened full screen) and Close. On a phone: a
 *   full-height sheet, the diagram top to bottom.
 * - Full screen (C): the diagram top to bottom on the left, the steps boxed on the right, the screen
 *   below; Comment (the comments, notes, versions and Revise) and Exit full screen; on a phone one
 *   tab each for Diagram, Steps and Screen.
 * - Storyboard (D): a band across the page, a card per step (who does it, the step in full words, a
 *   decision's Yes and No) and the screen last; on a phone one card at a time.
 *
 * What a reader may do comes from the API's can_* fields. A one-pager bet line names its PRD
 * (`documentId`). While Oracle draws (the simple_visual job), the row says so and reads again
 * until the drawing lands.
 */
export function FlowPanel({
  subject,
  documentId,
  onClose,
  onDrawn,
  row = false,
  line = false,
  openLabel = "Open the flow",
  onOpenChange,
  code,
  name,
  backLabel,
  inlineComments = false,
  showHint,
  sectionNames,
}: {
  subject: FlowSubject;
  documentId?: string;
  /** The page's own names for the PRD's sections (a one-pager's "What we will build"), for the notes. */
  sectionNames?: Record<string, string>;
  onClose?: () => void;
  onDrawn?: (flow: Flow) => void;
  /** The owner's pick A: start as the row (the live thumbnail and its states). */
  row?: boolean;
  /** The card beside its talk: one compact line (a small picture and the flow's name). */
  line?: boolean;
  /** The row thumbnail's name (a roadmap card's: "Open the item's flow"). */
  openLabel?: string;
  /** A view of the flow opened or closed. */
  onOpenChange?: (open: boolean) => void;
  /** The subject's code and name for the opened views' titles ("F-06 Loop and blast-radius guards · flow"). */
  code?: string | null;
  name?: string;
  /** The Roadmap card's viewer: a back link to it ("Roadmap"); unset, none (the one-pager's, qa-simple-prd-p3-22). */
  backLabel?: string;
  /** The Roadmap card's Comment opens the comments in the opened view (fix4 qa-simple-roadmap-47);
   * unset, it opens them full screen (qa-simple-prd-p3-22). */
  inlineComments?: boolean;
  /** With no flow yet, the hint under "No flow yet" ("Oracle draws the steps..."). Unset: it
   * shows on the first row of a list only; false: never; true: on this row (bar the CSS rule). */
  showHint?: boolean;
}) {
  const zone = useCompanyZone();
  const phone = usePhone();
  const [view, setView] = useState<null | "opened" | "story">(row || line ? null : "opened");
  const [full, setFull] = useState(false);
  const [fullTab, setFullTab] = useState<"diagram" | "steps" | "screen">("diagram");
  const [commentingOn, setCommenting] = useState(false);
  // fix4 qa-simple-roadmap-47: the opened view has Comment too; with every view closed the comments are closed.
  const commenting = commentingOn && (view !== null || full);
  // A drawing this row watched land (it was drawing, now it is drawn) carries "New", as does
  // one made in the last NEW_MS (it landed while the card was closed).
  const [fresh, setFresh] = useState(false);
  const sawPending = useRef(false);
  const onOpenRef = useRef(onOpenChange);
  useEffect(() => {
    onOpenRef.current = onOpenChange;
  });
  const anyOpen = (row || line) && (view !== null || full);
  useEffect(() => {
    if (row || line) onOpenRef.current?.(anyOpen);
  }, [row, line, anyOpen]);
  const key = `simple-visual|${subject.kind}|${subject.id}`;
  const q = useQuery(key, () =>
    unwrap(
      api.GET("/v1/simple/visuals/{kind}/{subject_id}", {
        params: { path: { kind: subject.kind, subject_id: subject.id }, query: documentId ? { document_id: documentId } : {} },
        // The walk-fixes review: every poll asks the API, never a copy kept from before the job ended.
        cache: "no-store",
      }),
    ),
  );
  const pending = q.data?.pending ?? false;
  // The walk: read again until the job ends (a ref, so a re-render never stops the reading),
  // then tell the place that asked (its thumbnail, its "No flow yet") what was drawn.
  const reloadRef = useRef(q.reload);
  const onDrawnRef = useRef(onDrawn);
  useEffect(() => {
    reloadRef.current = q.reload;
    onDrawnRef.current = onDrawn;
  });
  useEffect(() => {
    if (!pending) return;
    const t = window.setInterval(() => void reloadRef.current(), 2000);
    return () => window.clearInterval(t);
  }, [pending]);
  const drawnFlow = q.data?.flow ?? null;
  const told = useRef<string | null>(null);
  useEffect(() => {
    if (pending) sawPending.current = true;
    if (!drawnFlow || pending) return;
    const age = drawnFlow.made_at ? Date.now() - Date.parse(drawnFlow.made_at) : -1;
    if (sawPending.current || (age >= 0 && age < NEW_MS)) {
      sawPending.current = false;
      setFresh(true);
    }
    const mark = `${drawnFlow.version}`;
    if (told.current === mark) return;
    told.current = mark;
    onDrawnRef.current?.(drawnFlow);
  }, [drawnFlow, pending]);
  const [shown, setShown] = useState<number | null>(null);
  const [old, setOld] = useState<Flow | null>(null);
  const [text, setText] = useState("");
  const [on, setOn] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const box = useMainBox(anyOpen && !phone);
  const openedRef = useRef<HTMLDivElement>(null);
  const storyRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const overlay = row || line;
  useModal(openedRef, overlay && view === "opened" && !full, () => setView(null));
  useModal(storyRef, overlay && view === "story" && !full, () => setView(null));
  useModal(viewerRef, full, () => {
    if (commenting) setCommenting(false);
    else setFull(false);
  });
  // qa-simple-prd-p3-22, qa4-simple-prd-30: full screen and the flow's and storyboard's sheets
  // each have one scroller, their own: the page behind stops scrolling, so no second scrollbar
  // stands beside the sheet's at the right edge.
  const sheetOpen = full || (overlay && view !== null);
  useEffect(() => {
    if (!sheetOpen) return;
    const html = document.documentElement;
    const was = html.style.overflow;
    html.style.overflow = "hidden";
    return () => {
      html.style.overflow = was;
    };
  }, [sheetOpen]);

  async function post(run: () => Promise<{ data?: Visual; error?: unknown; response: Response }>, after?: () => void) {
    setBusy(true);
    setError(null);
    const r = await run();
    setBusy(false);
    if (!r.response.ok || !r.data) {
      const detail = (r.error as { detail?: unknown } | undefined)?.detail;
      setError(typeof detail === "string" ? detail : `Could not save (${r.response.status})`);
      return;
    }
    const data = r.data;
    q.setData(() => data);
    setShown(null);
    setOld(null);
    after?.();
  }

  const path = { kind: subject.kind, subject_id: subject.id };
  const comment = () =>
    post(
      () => api.POST("/v1/simple/visuals/{kind}/{subject_id}/comments", { params: { path }, body: { body: text.trim(), annotation: on ? Number(on) : null } }),
      () => {
        setText("");
        setOn("");
      },
    );
  const revise = () => post(() => api.POST("/v1/simple/visuals/{kind}/{subject_id}/revise", { params: { path }, body: {} }));
  // Retry a failed redraw: from the open comments, or with none, as a note (the API's revise).
  const retry = () =>
    post(() => api.POST("/v1/simple/visuals/{kind}/{subject_id}/revise", { params: { path }, body: q.data?.comments.some((c) => c.addressed_in === null) ? {} : { note: "Retry: Oracle could not draw the last version" } }));
  const ask = () => post(() => api.POST("/v1/simple/visuals/{kind}/{subject_id}/request", { params: { path }, body: { brief: "", document_id: documentId ?? null } }));

  async function openVersion(n: number) {
    const v = q.data;
    if (!v || n === v.flow?.version) {
      setShown(null);
      setOld(null);
      return;
    }
    const r = await api.GET("/v1/simple/visuals/{kind}/{subject_id}/versions/{number}", { params: { path: { ...path, number: n } } });
    if (r.data) {
      setShown(n);
      setOld(r.data);
    }
  }

  if (q.error) return <p className="mt-3 text-[length:var(--simple-small)] text-danger">{q.error}</p>;
  if (!q.data) return <p className="mt-3 text-[length:var(--simple-small)] text-text2">Loading the flow…</p>;
  const v = q.data;
  const flow = old ?? v.flow;
  const open = v.comments.filter((c) => c.addressed_in === null);
  // qa4-simple-prd-33: a reader who may not comment (a viewer) is not offered "Comment": the same
  // panel reads as the flow's comments, notes and versions.
  const commentWord = v.can_comment ? "Comment" : "See comments";
  const title = (f: Flow, what: string) => (
    <>
      {code ? <><Code code={code} className="mr-0.5 align-[2px]" />{" "}</> : null}
      {name ?? f.title} · {what}
    </>
  );
  const phoneMeta = (f: Flow) => `${code ? `${code} · ` : ""}${flowDrawn(f, zone).replace(/^V/, code ? "v" : "V")}`;
  const older = shown !== null ? " (an older version)" : "";

  /** The comments, the notes, the versions and Revise: behind the viewer's Comment. */
  const commentsPanel = (f: Flow, inline = false) => (
    <section
      aria-label="Comments on the flow"
      data-testid="flow-comments-panel"
      className={inline ? "flex flex-col gap-3" : `absolute top-0 right-0 bottom-0 z-10 flex flex-col gap-3 overflow-y-auto border-l border-line bg-surface p-5 shadow-tip ${phone ? "left-0" : "w-[420px]"}`}
    >
      <div className="flex items-center gap-2">
        <h3 className="flex-1 text-[18px] leading-6 font-semibold">Comments</h3>
        {!inline && (
          <button type="button" aria-label="Close the comments" className="grid h-7 w-7 place-items-center rounded-md text-text2 hover:bg-surface2" onClick={() => setCommenting(false)}>
            <Icon d={ICONS.close} size={18} width={1.7} />
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[14px]">
        <span data-testid="flow-version" className="font-semibold">
          Version {f.version} of {v.versions.length}
          {older}
        </span>
        {v.versions.length > 1 && (
          <label className="flex items-center gap-1">
            <span className="text-text2">History</span>
            <select aria-label="Version" value={f.version} onChange={(e) => void openVersion(Number(e.target.value))} className="rounded border border-line bg-surface px-1 py-0.5">
              {v.versions.map((x) => (
                <option key={x.number} value={x.number}>
                  Version {x.number}
                  {x.addressed ? ` · ${x.addressed} comment${x.addressed === 1 ? "" : "s"} addressed` : ""}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {v.pending && (
        <p className={META} data-testid="flow-pending">
          Oracle is drawing the next version…
        </p>
      )}
      {!v.pending && v.failed && shown === null && (
        <p className="text-[14px] text-crit" data-testid="flow-failed">
          Oracle could not draw the next version.{" "}
          {v.can_revise && (
            <button type="button" className="underline" disabled={busy} onClick={() => void retry()}>
              Retry
            </button>
          )}
        </p>
      )}
      {(f.annotations?.length ?? 0) > 0 && (
        <ol className="space-y-1 text-[14px] leading-5" aria-label="Notes" data-testid="flow-annotations">
          {f.annotations!.map((a) => (
            <li key={a.n}>
              <span className="mr-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-text text-[11px] font-bold text-surface">{a.n}</span>
              {a.note}
              {/* qa4-simple-prd-32: where the page names its sections, the section in those words and no requirement code. */}
              {a.section_key && sectionNames?.[a.section_key] ? (
                <span className="text-text2"> · From “{sectionNames[a.section_key]}”</span>
              ) : (
                (a.section_key || a.requirement) && (
                  <span className="text-text2">
                    {" "}
                    · {a.section_key ? `From the PRD: ${capSection(a.section_key)} section` : ""}
                    {a.section_key && a.requirement ? ", " : ""}
                    {a.requirement ? <span className="whitespace-nowrap">{`Requirement ${a.requirement}`}</span> : ""}
                  </span>
                )
              )}
            </li>
          ))}
        </ol>
      )}
      {v.comments.length === 0 ? (
        <p className={META}>No comments yet.</p>
      ) : (
        <ul className="space-y-1 text-[14px] leading-5" data-testid="flow-comments">
          {v.comments.map((c) => (
            <li key={c.id}>
              <span className="font-semibold">{c.by_name}</span>
              {c.annotation ? ` on note ${c.annotation}` : ""}: {c.body} <span className="text-text2">{c.addressed_in ? `· addressed in version ${c.addressed_in}` : "· open"}</span>
            </li>
          ))}
        </ul>
      )}
      {v.can_comment && shown === null && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) void comment();
          }}
        >
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="What should change?" aria-label="Comment on the flow" className="w-full rounded-[10px] border border-line-strong bg-surface px-3 py-2 text-[15px]" />
          <div className="flex flex-wrap items-center gap-2">
            {(f.annotations?.length ?? 0) > 0 && (
              <select aria-label="On annotation" value={on} onChange={(e) => setOn(e.target.value)} className="h-8 rounded-lg border border-line-strong bg-surface px-2 text-[14px]">
                <option value="">The whole flow</option>
                {f.annotations!.map((a) => (
                  <option key={a.n} value={a.n}>
                    Note {a.n}
                  </option>
                ))}
              </select>
            )}
            {/* qa4-simple-prd-31: named apart from the header's Comment toggle. */}
            <button type="submit" className={BTN} disabled={busy || !text.trim()}>
              Post comment
            </button>
          </div>
        </form>
      )}
      {v.can_revise && shown === null && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={BTN_SOLID} disabled={busy || v.pending || open.length === 0} onClick={() => void revise()}>
            Revise
          </button>
          <span className={META}>{open.length ? `Oracle redraws it from ${open.length} open comment${open.length === 1 ? "" : "s"} as a new version.` : "Comment first: Oracle revises from the comments."}</span>
        </div>
      )}
      {error && <p className="text-[14px] text-crit">{error}</p>}
    </section>
  );

  /** The opened view's body (A): the diagram across, then the steps beside the screen. */
  const acrossBody = (f: Flow) => (
    <>
      <div className="mt-3.5 mb-1.5">
        <FlowDiagram flow={f} layout="across" testId="flow-svg" />
      </div>
      <div className="mt-2.5 grid gap-7 sm:grid-cols-2">
        <div className="min-w-0">
          <p className={SUB}>Steps</p>
          <FlowStepList flow={f} />
        </div>
        <div className="min-w-0">
          <p className={SUB}>Screen: {f.touches_screen ? f.screen.title : "none (it touches no screen)"}</p>
          <FlowScreen flow={f} size={12} />
        </div>
      </div>
    </>
  );

  // The opened view's one Comment (the comments, notes, versions and Revise), as each page's own
  // lane built it: on the Roadmap card (fix4 qa-simple-roadmap-47) it opens them in the opened
  // view, after the screen on a phone; elsewhere (qa-simple-prd-p3-22) it opens them full screen.
  const commentButton = inlineComments ? (
    <button type="button" className={BTN} aria-expanded={commenting} onClick={() => setCommenting((c) => !c)}>
      {commentWord}
    </button>
  ) : (
    <button
      type="button"
      className={BTN}
      onClick={() => {
        setCommenting(true);
        setFull(true);
      }}
    >
      {commentWord}
    </button>
  );
  const exitFull = () => {
    setCommenting(false);
    setFull(false);
  };

  /** A phone's opened view (A): a full-height sheet, the diagram top to bottom, then the steps. */
  const phoneOpened = (f: Flow) => (
    <div ref={openedRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`${f.title} · flow`} data-testid="flow-detail" className="fixed inset-0 z-[60] flex flex-col bg-surface text-[15px] leading-[22px] text-text outline-none">
      <div className="flex flex-none items-center gap-2.5 border-b border-line px-3 py-2.5">
        <button type="button" data-first className={BTN_GHOST} onClick={() => setView(null)}>
          {/* qa4-simple-prd-30: the flow's sheet closes with "Close", as the storyboard's does. */}
          Close
        </button>
        <h2 className="min-w-0 flex-1 text-[17px] leading-6 font-[650] break-words">{f.title} · flow</h2>
        <button type="button" className={BTN} onClick={() => setFull(true)}>
          <Icon d={ICONS.expand} />
          Full screen
        </button>
      </div>
      <div className={`min-h-0 flex-1 overflow-y-auto px-4 py-3 ${SCROLL}`}>
        <div className="flex items-center gap-2">
          <p className={`min-w-0 flex-1 ${META}`} data-testid="flow-drawn">
            {phoneMeta(f)}
            {older}
          </p>
          {!inlineComments && commentButton}
        </div>
        <div className="mt-2">
          <FlowDiagram flow={f} layout="down" width={352} testId="flow-svg" />
        </div>
        <p className={`mt-3.5 ${SUB}`}>Steps</p>
        <FlowStepList flow={f} />
        <p className={`mt-2 ${SUB}`}>Screen: {f.touches_screen ? f.screen.title : "none (it touches no screen)"}</p>
        <FlowScreen flow={f} size={12} />
        {/* The header has no room on a phone: Comment follows the screen. */}
        {inlineComments && <div className="mt-3">{commentButton}</div>}
        {commenting && !full && <div className="mt-3 border-t border-line pt-3">{commentsPanel(f, true)}</div>}
      </div>
    </div>
  );

  /** The opened view (A) on a desktop: across the page, over the roadmap. */
  const desktopOpened = (f: Flow) => (
    <div
      ref={openedRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={`${name ?? f.title} · flow`}
      data-testid="flow-detail"
      style={{ left: box.left, right: box.right, top: 16, maxHeight: "calc(100dvh - 32px)" }}
      className="fixed z-50 overflow-y-auto rounded-[14px] border border-line bg-surface px-[22px] py-[18px] text-[15px] leading-[22px] text-text shadow-tip outline-none"
    >
      <div className="flex items-center gap-2.5">
        <h2 className="min-w-0 flex-1 text-[20px] leading-7 font-[650] break-words">{title(f, "flow")}</h2>
        <span className={META} data-testid="flow-drawn">
          {flowDrawn(f, zone)}
          {older}
        </span>
        {inlineComments && commentButton}
        <button type="button" className={BTN} data-first onClick={() => setFull(true)}>
          <Icon d={ICONS.expand} />
          Full screen
        </button>
        {!inlineComments && commentButton}
        <button type="button" className={BTN} onClick={() => setView(null)}>
          Close
        </button>
      </div>
      {acrossBody(f)}
      {commenting && !full && <div className="mt-3 border-t border-line pt-3">{commentsPanel(f, true)}</div>}
    </div>
  );

  /** The full-screen viewer (C): over the page; Escape or Exit full screen goes back. */
  const viewer = (f: Flow) => {
    const diagram = <FlowDiagram flow={f} layout="down" width={phone ? 352 : 440} testId="flow-svg" />;
    const screen = (
      <>
        <p className={SUB}>{phone ? `Screen: ${f.touches_screen ? f.screen.title : "none"}` : `Screen it touches: ${f.touches_screen ? f.screen.title : "none"}`}</p>
        <div className="max-w-[900px]">
          <FlowScreen flow={f} size={phone ? 12 : 13.2} />
        </div>
      </>
    );
    return (
      <div ref={viewerRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`Full screen: ${f.title}`} data-testid="flow-fullscreen" className="fixed inset-0 z-[70] flex flex-col bg-surface text-[15px] leading-[22px] text-text outline-none">
        {phone ? (
          <div className="flex flex-none items-center gap-2 border-b border-line px-3 py-2.5">
            <h2 className="min-w-0 flex-1 text-[17px] leading-6 font-[650] break-words">{f.title} · flow</h2>
            <button type="button" className={BTN} aria-expanded={commenting} onClick={() => setCommenting((c) => !c)}>
              {commentWord}
            </button>
            <button type="button" className={BTN_SOLID} data-first aria-label="Exit full screen" onClick={exitFull}>
              Exit
            </button>
          </div>
        ) : (
          // qa-simple-prd-p3-22: one way out (Exit full screen, as Escape), not a back link beside it,
          // bar the Roadmap card's own "Roadmap" back.
          <div className="flex flex-none items-center gap-3 border-b border-line px-7 py-3.5">
            {backLabel && (
              <button
                type="button"
                className={BTN_GHOST}
                onClick={() => {
                  exitFull();
                  setView(null);
                }}
              >
                <Icon d={ICONS.back} />
                {backLabel}
              </button>
            )}
            <h2 className="min-w-0 flex-1 text-[21px] leading-7 font-[650] break-words">{title(f, "flow")}</h2>
            <span className={META}>
              {flowDrawn(f, zone)}
              {older}
            </span>
            <button type="button" className={BTN} aria-expanded={commenting} onClick={() => setCommenting((c) => !c)}>
              {commentWord}
            </button>
            <button type="button" className={BTN_SOLID} data-first onClick={exitFull}>
              Exit full screen
            </button>
          </div>
        )}
        <div className="relative min-h-0 flex-1">
          {/* qa-simple-roadmap-12: the comments panel is an overlay (`absolute right-0 w-[420px]`);
              while it is open, this pane keeps clear of it so the Steps list is not covered. */}
          <div className={`h-full overflow-y-auto ${SCROLL} ${commenting && !phone ? "pr-[420px]" : ""}`}>
            {phone ? (
              <div className="px-4 py-3">
                <Tabs
                  label="Parts of the flow"
                  value={fullTab}
                  onChange={setFullTab}
                  items={[
                    { value: "diagram", label: "Diagram" },
                    { value: "steps", label: "Steps" },
                    { value: "screen", label: "Screen" },
                  ]}
                />
                <p className={`mt-2 ${META}`}>{phoneMeta(f)}</p>
                <div role="tabpanel" className="mt-2">
                  {fullTab === "diagram" ? diagram : fullTab === "steps" ? <FlowStepList flow={f} boxed /> : screen}
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-[460px_1fr] content-start gap-x-10 gap-y-5 px-7 py-[22px]">
                <div className="min-w-0">
                  <p className={SUB}>User flow</p>
                  {diagram}
                </div>
                <div className="min-w-0">
                  <p className={SUB}>Steps</p>
                  <FlowStepList flow={f} boxed />
                </div>
                <div className="col-span-full border-t border-line pt-4">{screen}</div>
              </div>
            )}
          </div>
          {commenting && commentsPanel(f)}
        </div>
      </div>
    );
  };

  /** The storyboard (D): a band across the foot of the page; a phone: one card at a time. */
  const story = (f: Flow) => (
    <Storyboard
      f={f}
      phone={phone}
      box={box}
      refEl={storyRef}
      heading={title(f, "storyboard")}
      meta={flowDrawn(f, zone)}
      phoneMeta={phoneMeta(f)}
      onClose={() => setView(null)}
      onScreen={() => {
        setFullTab("screen");
        setFull(true);
      }}
    />
  );

  // The opened view and the storyboard on a desktop dim the page behind (qa-simple-prd-22); a
  // click on it closes them, as Escape does. A phone's are full-height sheets.
  const backdrop = overlay && !phone && !full && (view === "opened" || view === "story") && (
    <div aria-hidden data-testid="flow-backdrop" className="fixed inset-0 z-50 bg-hero/50" onClick={() => setView(null)} />
  );
  const layers = flow ? (
    <Layer>
      {backdrop}
      {view === "opened" && overlay && (phone ? phoneOpened(flow) : desktopOpened(flow))}
      {view === "story" && overlay && story(flow)}
      {full && viewer(flow)}
    </Layer>
  ) : null;

  if (line) {
    // The card beside its talk: the flow's small picture and its name.
    return (
      <section data-testid="flow-row" aria-label="Flow" className="mt-1 flex items-center gap-2 text-[15px] leading-[22px]">
        {v.flow ? (
          <>
            <button type="button" aria-label={openLabel} data-testid="flow-row-thumb" onClick={() => (setCommenting(false), setView("opened"))} className="grid h-9 w-12 flex-none place-items-center rounded border border-line bg-surface2 hover:border-line-strong">
              <svg width="34" height="20" viewBox="0 0 34 20" aria-hidden>
                <rect x="1" y="6" width="8" height="8" rx="2" fill="none" stroke="var(--line-strong)" />
                <rect x="13" y="6" width="8" height="8" rx="2" fill="none" stroke="var(--line-strong)" />
                <rect x="25" y="6" width="8" height="8" rx="2" fill="none" stroke="var(--line-strong)" />
                <path d="M9 10 H13 M21 10 H25" stroke="var(--line-strong)" />
              </svg>
            </button>
            <span className="min-w-0 break-words">{v.flow.title}</span>
          </>
        ) : (
          <span className="text-text2" data-testid="flow-empty" data-state={v.pending ? "drawing" : v.failed ? "failed" : "none"}>
            {v.pending ? "Oracle is drawing the flow" : v.failed ? "Oracle could not draw this flow." : "No flow yet"}
          </span>
        )}
        {layers}
      </section>
    );
  }

  if (row) {
    return (
      <section data-testid="flow-row" aria-label="Flow" className="text-[15px] leading-[22px]">
        {v.flow ? (
          <div data-testid="flow-row-drawn">
            <div className="mt-2 flex items-start gap-3 max-[600px]:flex-col max-[600px]:gap-2">
              <button type="button" aria-label={openLabel} aria-expanded={view === "opened"} data-testid="flow-row-thumb" onClick={() => (setCommenting(false), setView("opened"))} className="flex-none rounded-lg border border-line bg-surface p-1.5 hover:border-line-strong">
                <FlowDiagram flow={v.flow} layout="mini" />
              </button>
              <div className="min-w-0 flex-1 max-[600px]:w-full">
                <b className="font-[650] break-words">{v.flow.title}</b>
                {fresh && (
                  <span className="ml-1.5 inline-flex items-center rounded-full bg-pass-bg px-2 align-[1px] text-[12px] leading-5 font-semibold text-pass" data-testid="flow-new">
                    New
                  </span>
                )}
                <p className="text-[15px] leading-[22px] text-text2" data-testid="flow-meta">
                  {flowSize(v.flow)}
                </p>
                <p className={META} data-testid="flow-drawn">
                  {flowDrawn(v.flow, zone)}
                </p>
                {v.pending && (
                  <p className={META} data-testid="flow-pending">
                    Oracle is drawing the next version…
                  </p>
                )}
                {!v.pending && v.failed && (
                  <p className="text-[13px] leading-[18px] text-crit" data-testid="flow-failed">
                    Oracle could not draw the next version.{" "}
                    {v.can_revise && (
                      <button type="button" className="font-semibold underline" disabled={busy} onClick={() => void retry()}>
                        Retry
                      </button>
                    )}
                  </p>
                )}
              </div>
            </div>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <button type="button" className={SBTN} onClick={() => (setCommenting(false), setView("opened"))}>
                Open the flow
              </button>
              <button type="button" className={SBTN} onClick={() => setView("story")}>
                Open the storyboard
              </button>
            </div>
          </div>
        ) : (
          <NoDrawing v={v} busy={busy} onAsk={() => void ask()} showHint={showHint} />
        )}
        {error && <p className="mt-2 text-[14px] text-crit">{error}</p>}
        {layers}
      </section>
    );
  }

  // A proposal's visual, inline where it is (a widened card, a priority, a PRD's change): the
  // opened view's body with its own Storyboard, Full screen and comments.
  return (
    <section data-testid="flow-detail" className="mt-3 rounded-[14px] border border-line bg-surface px-4 py-4 text-[15px] leading-[22px] text-text">
      {flow ? (
        <>
          <div className="flex flex-wrap items-center gap-2.5">
            <h3 className="min-w-0 flex-1 text-[18px] leading-6 font-[650] break-words">User flow: {flow.title}</h3>
            <span className={META} data-testid="flow-drawn">
              {flowDrawn(flow, zone)}
              {older}
            </span>
            <button type="button" className={BTN} aria-pressed={view === "story"} onClick={() => setView(view === "story" ? "opened" : "story")}>
              {view === "story" ? "The diagram" : "Storyboard"}
            </button>
            <button type="button" className={BTN} onClick={() => setFull(true)}>
              <Icon d={ICONS.expand} />
              Full screen
            </button>
          </div>
          {view === "story" ? (
            <ol aria-label="Storyboard" data-testid="flow-storyboard" className="mt-3 flex items-start gap-3 overflow-x-auto pb-1">
              {stepsOf(flow).map((s, i) => (
                <StoryCard key={s.id} s={s} n={i + 1} />
              ))}
              {flow.touches_screen && (
                <ScreenCard
                  flow={flow}
                  onOpen={() => {
                    setFullTab("screen");
                    setFull(true);
                  }}
                />
              )}
            </ol>
          ) : (
            acrossBody(flow)
          )}
          <div className="mt-3 border-t border-line pt-3">{commentsPanel(flow, true)}</div>
        </>
      ) : (
        <NoDrawing v={v} busy={busy} onAsk={() => void ask()} showHint={showHint} />
      )}
      {error && !flow && <p className="mt-2 text-[14px] text-crit">{error}</p>}
      {onClose && (
        <button type="button" className={`${BTN} mt-3`} onClick={onClose}>
          Close the flow
        </button>
      )}
      {full && flow && <Layer>{viewer(flow)}</Layer>}
    </section>
  );
}

/** The storyboard (D). Desktop: a band across the foot of the page, the cards in a row. Phone:
 * one card at a time, swiped or stepped with the two buttons, dots for where it is. */
function Storyboard({
  f,
  phone,
  box,
  refEl,
  heading,
  meta,
  phoneMeta,
  onClose,
  onScreen,
}: {
  f: Flow;
  phone: boolean;
  box: { left: number; right: number };
  refEl: React.RefObject<HTMLDivElement | null>;
  heading: ReactNode;
  meta: string;
  phoneMeta: string;
  onClose: () => void;
  onScreen: () => void;
}) {
  const steps = stepsOf(f);
  const n = steps.length;
  const total = n + (f.touches_screen ? 1 : 0);
  const [at, setAt] = useState(0);
  const touch = useRef<number | null>(null);
  const go = (k: number) => setAt(Math.min(total - 1, Math.max(0, k)));
  if (!phone) {
    return (
      <div
        ref={refEl}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`${f.title} · storyboard`}
        data-testid="flow-storyboard"
        style={{ left: box.left, right: box.right, bottom: 16 }}
        className="fixed z-50 rounded-[14px] border border-line bg-surface px-4 pt-4 pb-[18px] text-[15px] leading-[22px] text-text shadow-tip outline-none"
      >
        <div className="flex items-center gap-2.5">
          <h2 className="min-w-0 flex-1 text-[18px] leading-6 font-[650] break-words">{heading}</h2>
          <span className="text-[13px] leading-[18px] text-text2">{meta}</span>
          <button type="button" data-first className={BTN} onClick={onClose}>
            Close
          </button>
        </div>
        {/* fix4 qa-simple-roadmap-53: each card as tall as its words (no stretched empty space). */}
        <ol aria-label="Storyboard" className={`mt-3 flex items-start gap-3 overflow-x-auto ${SCROLL}`}>
          {steps.map((s, i) => (
            <StoryCard key={s.id} s={s} n={i + 1} />
          ))}
          {f.touches_screen && <ScreenCard flow={f} onOpen={onScreen} />}
        </ol>
      </div>
    );
  }
  const onScreenCard = at >= n;
  const s = steps[Math.min(at, n - 1)];
  // qa4-simple-prd-30: a sheet from the bottom, as tall as the card and its buttons, not the
  // whole screen with blank height under them.
  return (
    <div ref={refEl} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`${f.title} · storyboard`} data-testid="flow-storyboard" className="fixed inset-x-0 bottom-0 z-[60] flex max-h-dvh flex-col rounded-t-[14px] border-t border-line bg-surface shadow-tip text-[15px] leading-[22px] text-text outline-none">
      <div className="flex flex-none items-center gap-2 border-b border-line px-3 py-2.5">
        <h2 className="min-w-0 flex-1 text-[17px] leading-6 font-[650] break-words">{f.title} · storyboard</h2>
        <button type="button" data-first className={BTN} onClick={onClose}>
          Close
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-4">
        <p className="text-[13px] leading-[18px] text-text2">{phoneMeta}</p>
        <p className="text-[15px] leading-[22px] font-semibold" data-testid="story-at" aria-live="polite">
          {onScreenCard ? (
            <>
              The screen <span className="font-normal text-text2">· after step {n}</span>
            </>
          ) : (
            <>
              Step {at + 1} of {n}
              {f.touches_screen ? <span className="font-normal text-text2"> · then the screen</span> : null}
            </>
          )}
        </p>
        <ol
          aria-label="Storyboard"
          className="flex"
          onTouchStart={(e) => (touch.current = e.touches[0]?.clientX ?? null)}
          onTouchEnd={(e) => {
            const x0 = touch.current;
            const x1 = e.changedTouches[0]?.clientX;
            touch.current = null;
            if (x0 == null || x1 == null || Math.abs(x1 - x0) < 40) return;
            go(at + (x1 < x0 ? 1 : -1));
          }}
        >
          {onScreenCard ? <ScreenCard flow={f} onOpen={onScreen} big /> : <StoryCard s={s} n={at + 1} big />}
        </ol>
        <div className="flex justify-center gap-1.5" aria-hidden>
          {Array.from({ length: total }, (_, i) => (
            <i key={i} className={`block h-2 rounded-full ${i === at ? "w-5 rounded-[4px] bg-accent" : "w-2 bg-line"}`} />
          ))}
        </div>
        <div className="flex gap-2.5">
          {at > 0 && (
            <button type="button" className="simple-button flex-1 gap-1.5" onClick={() => go(at - 1)}>
              <Icon d={ICONS.back} size={18} />
              Step {at}
            </button>
          )}
          {at < total - 1 && (
            <button type="button" className="simple-button simple-button-primary flex-1 gap-1.5" onClick={() => go(at + 1)}>
              {at + 1 < n ? `Step ${at + 2}` : "The screen"}
              <Icon d={ICONS.next} size={18} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
