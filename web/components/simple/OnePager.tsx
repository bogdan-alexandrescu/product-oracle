"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { Button, LinkButton } from "@/components/ds";
import { clock, FlowPanel } from "@/components/simple/FlowVisual";
import { PlanByMonth } from "@/components/simple/PlanByMonth";
import { MkOnePagerDraft, useMk } from "@/components/mk/MkRunPlan"; // MOCK-HOOK
import { dmy, ew, PrdPlan, TAP44, usePhone } from "@/components/simple/PrdTimeline";
import { PrdStatus } from "@/components/simple/PrdStatus";
import { StartSheet } from "@/components/simple/meetings/StartSheet";
import { quoteLine } from "@/components/simple/quote-line";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useCompanyZone } from "@/lib/dates";
import { errorMessage, useQuery } from "@/lib/use-query";

type View = Schemas["OnePagerOut"];
type Line = Schemas["OnePagerLine"];
type Note = Schemas["OnePagerNote"];

export { quoteLine };

/** A section's Markdown as plain lines: no "- " bullets, "#" heads or "**" marks (qa-simple-prd-16/17). */
export function plainLines(md: string): { text: string; bullet: boolean }[] {
  return md
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const bullet = /^([-*+]|\d+[.)])\s+/.test(x);
      return { text: x.replace(/^([-*+]|\d+[.)]|#+)\s+/, "").replace(/\*\*|__|`/g, ""), bullet };
    });
}

/** The words of `before` and `after` with only the changed ones marked (qa-simple-prd-17). */
function wordDiff(before: string, after: string): { a: ReactNode[]; b: ReactNode[] } {
  const x = before.split(/(\s+)/);
  const y = after.split(/(\s+)/);
  let head = 0;
  while (head < x.length && head < y.length && x[head] === y[head]) head++;
  let tail = 0;
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++;
  const part = (w: string[], mark: "del" | "ins") => {
    const mid = w.slice(head, w.length - tail).join("");
    return [w.slice(0, head).join(""), mid ? (mark === "del" ? <del key="m">{mid}</del> : <ins key="m">{mid}</ins>) : null, w.slice(w.length - tail).join("")];
  };
  return { a: part(x, "del"), b: part(y, "ins") };
}

/** What holds a decider-approved draft back, in the meeting banner's words ("Waiting on Rae's approval · Sections Scope need a reviewer"). */
function heldWords(d: Schemas["OnePagerDraft"]): string {
  const names = d.waiting_on.map((p) => p.name);
  const who = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
  return [...(names.length ? [`Waiting on ${who}'s approval`] : []), ...d.blocked_by].join(" · ");
}

/**
 * The owner's P5: a shortened line folds at a sentence end, never mid-sentence: the whole
 * sentences that fit in the API's cut (`shown`, ending "…"), else the first sentence whole.
 */
export function foldAtSentence(full: string, shown: string): string {
  const room = shown.replace(/…$/, "").length;
  const ends = [...full.matchAll(/[.!?](?=\s|$)/g)].map((m) => m.index! + 1);
  if (!ends.length) return full;
  const fit = ends.filter((e) => e <= room);
  return full.slice(0, fit.length ? fit[fit.length - 1] : ends[0]).trim();
}

/** "2h ago": how long since `at` (Remind's "Reminded 2h ago"). */
export function ago(at: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / (24 * 60))}d ago`;
}

const TINT: Record<Line["state"], string> = {
  published: "",
  edited: "bg-[var(--simple-edited)]",
  proposal: "bg-[var(--simple-proposal)]",
};

/**
 * Simple S5 (#723), the owner's pick "A · Paper": one printed-page column, the same page the
 * one-page PDF prints. Changes and proposals sit in a right margin beside their line (under
 * it on a phone); a line edit is the change engine's `edit_line`, a section patch of every
 * source section into the PRD's shared working draft. What a reader may do comes from the
 * API's can_* fields. Inside a review meeting (S8, `sessionId`), its line edits and decisions
 * go through the meeting's session and become the meeting's decisions.
 */
export function OnePager({ doc, sessionId, refresh, onChanged }: { doc: string; sessionId?: string; refresh?: string; onChanged?: () => void }) {
  const q = useQuery(`simple-one-pager|${doc}`, () =>
    unwrap(api.GET("/v1/simple/one-pagers/{doc}", { params: { path: { doc } } })),
  );
  // A meeting's screen: read again when the meeting moves on (Approve publishes the draft).
  const seenRefresh = useRef(refresh);
  const reloadPage = q.reload;
  // prd-timeline: the PRD's plan leads the page (its timeline, goal lanes and milestone parts).
  const planQ = useQuery(`simple-prd-plan|${doc}`, () =>
    unwrap(api.GET("/v1/simple/prds/{prd}/plan", { params: { path: { prd: doc } } })).catch(() => null),
  );
  const reloadPlan = planQ.reload;
  // qa-simple-prd-p3-16: the PRD's status chip reads the same summary as the One-pagers list
  // (the document's own, written by the same code), not the whole list of PRDs.
  const docQ = useQuery(`simple-prd-doc|${doc}`, () => unwrap(api.GET("/v1/documents/{doc}", { params: { path: { doc } } })).catch(() => null));
  const reloadDoc = docQ.reload;
  // qa-simple-prd-p3-4: a plan-led page shows the PRD's lines (and their Edit) on asking.
  const [linesShown, setLinesShown] = useState(false);
  const [planNow, setPlanNow] = useState<Schemas["SimplePlanOut"] | null>(null);
  useEffect(() => {
    if (seenRefresh.current === refresh) return;
    seenRefresh.current = refresh;
    void reloadPage();
    // A newly approved version's plan shows at once, not only after moving away and back.
    setPlanNow(null);
    void reloadPlan();
    void reloadDoc();
  }, [refresh, reloadPage, reloadPlan, reloadDoc]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");
  // Typed words ask "Discard your changes?" before Cancel or Escape drops them.
  const [discarding, setDiscarding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  // A phone: the line last tapped shows its Edit (a tap is no hover; it need not open the line).
  // A phone snaps a tap near the words onto them, so a line's first tap only shows its Edit and
  // a second tap on its words opens it.
  const [tapped, setTapped] = useState<string | null>(null);
  const firstTap = useRef(false);
  // qa-simple-prd-p3-1: a touch that lands on a line's hidden Edit takes no action.
  const hiddenTap = useRef(false);
  const [diff, setDiff] = useState<string | null>(null);
  const [wide, setWide] = useState<string | null>(null);
  // Lines shortened with "…" shown whole, in place (CLD's production walk, 2026-10-27).
  const [whole, setWhole] = useState<Set<string>>(new Set());
  // 2026-10-30: the bets whose flow was asked for here ("Draw the flow"): their flow row shows while Oracle draws.
  const [asked, setAsked] = useState<Set<string>>(new Set());
  const [presenting, setPresenting] = useState(false);
  const [saved, setSaved] = useState(false);
  // qa-simple-prd-25: "PDF downloaded" shows a few seconds, then goes.
  useEffect(() => {
    if (!saved) return;
    const t = window.setTimeout(() => setSaved(false), 4000);
    return () => window.clearTimeout(t);
  }, [saved]);
  // qa-simple-prd-24: leaving full screen (Esc) ends presenting too.
  useEffect(() => {
    const on = () => {
      if (!document.fullscreenElement) setPresenting(false);
    };
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);
  const root = useRef<HTMLDivElement>(null);
  // qa-simple-prd-p3-19: Escape stops presenting, full screen granted or not.
  useEffect(() => {
    if (!presenting) return;
    const on = (e: KeyboardEvent) => {
      // qa-simple-prd-p3-18: Tab goes round the presented page; a dialog over it (a flow, portalled
      // outside the page) keeps its own Tab.
      if (e.key === "Tab" && root.current && !(document.activeElement as HTMLElement | null)?.closest('[role="dialog"], [role="alertdialog"], [aria-modal="true"]')) {
        const all = Array.from(root.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])')).filter((x) => x.offsetParent !== null);
        const at = all.indexOf(document.activeElement as HTMLElement);
        if (all.length && (e.shiftKey ? at <= 0 : at === all.length - 1 || at < 0)) {
          e.preventDefault();
          all[e.shiftKey ? all.length - 1 : 0].focus();
        }
        return;
      }
      // A dialog over the page (the editor's "Discard your changes?" too) takes its own Escape.
      if (e.key === "Escape" && !document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]')) {
        setPresenting(false);
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      }
    };
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  }, [presenting]);
  // qa-simple-prd-p3-18: while presenting, the shell behind the page (its rail) takes no focus.
  useEffect(() => {
    if (!presenting || !root.current) return;
    const off: HTMLElement[] = [];
    for (let el: HTMLElement | null = root.current; el && el !== document.body; el = el.parentElement) {
      for (const sib of Array.from(el.parentElement?.children ?? [])) {
        if (sib !== el && sib instanceof HTMLElement && !sib.inert && sib.tagName !== "SCRIPT") {
          sib.inert = true;
          off.push(sib);
        }
      }
    }
    return () => off.forEach((x) => (x.inert = false));
  }, [presenting]);
  // qa-simple-prd-p3-2: an opened editor has the cursor, its words selected.
  useEffect(() => {
    if (!editing) return;
    const box = document.getElementById(`edit-${editing}`) as HTMLTextAreaElement | null;
    box?.focus();
    box?.select();
  }, [editing]);
  // qa-simple-prd-16: Escape closes a line's sources, unless a dialog over them takes it.
  useEffect(() => {
    if (!open) return;
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector('[role="dialog"], dialog[open]')) setOpen(null);
    };
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  }, [open]);
  const [starting, setStarting] = useState(false);
  // Desktop margin: each note sits beside its line (placeNotes).
  const margin = useRef<HTMLElement>(null);
  useEffect(() => {
    const on = () => placeNotes(margin.current);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  useLayoutEffect(() => placeNotes(margin.current));
  const phone = usePhone();
  const mk = useMk(); // MOCK-HOOK

  if (q.loading && !q.data) return <div className="px-6 py-8"><Loading /></div>;
  if (q.error || !q.data) {
    // A missing PRD's address is the app's not-found pattern (qa-shell-11): its title, one
    // sentence, Back to One-pagers and Go to Home (the bare URL: the person's own home).
    const missing = !q.error || /not found|no such/i.test(q.error);
    return (
      <div className="mx-auto flex max-w-[1180px] flex-col items-start gap-3 px-12 pt-[26px] pb-12 max-[767px]:px-4 max-[767px]:pt-3.5">
        {!missing && <BackLink />}
        <h1 className="simple-h1">{missing ? "One-pager not found" : "One-pager"}</h1>
        {missing ? (
          <div data-testid="one-pager-missing" className="flex flex-col items-start gap-3">
            <p className="text-[15px] text-text2">This one-pager doesn&apos;t exist or was deleted.</p>
            <div className="flex flex-wrap gap-2">
              <LinkButton href="/simple/one-pagers" variant="primary" icon="back" className="h-10">
                Back to One-pagers
              </LinkButton>
              <LinkButton href="/" variant="secondary" icon="home" className="h-10">
                Go to Home
              </LinkButton>
            </div>
          </div>
        ) : (
          <ErrorNote>{q.error}</ErrorNote>
        )}
      </div>
    );
  }
  const v: View = q.data;
  const numbers = new Map<string, number>();
  const words = new Map<string, string>();
  v.blocks.flatMap((b) => b.lines).forEach((l, i) => {
    numbers.set(l.id, i + 1);
    words.set(l.id, quoteLine(l.metric ? l.metric.name : l.text));
  });

  async function act(run: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await run();
      await q.reload();
      onChanged?.();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  // 2026-10-30: "Draw the flow" asks Oracle for a bet's flow (the flow panel's own request), then shows its row.
  const drawFlow = (line: Line) =>
    act(async () => {
      await unwrap(api.POST("/v1/simple/visuals/{kind}/{subject_id}/request", { params: { path: { kind: "one_pager_line", subject_id: line.flow_subject! } }, body: { brief: "", document_id: v.document.id } }));
      setAsked((a) => new Set(a).add(line.id));
    });
  const save = (line: Line) =>
    act(async () => {
      await unwrap(api.POST("/v1/simple/changes", {
        body: { session_id: sessionId ?? null, op: "edit_line", target: { document_id: v.document.id, line_id: line.id }, before: { line: line.text }, after: { line: draftText } },
      }));
      setEditing(null);
    });
  const decide = (n: Note, action: "accept" | "decline") =>
    act(() => unwrap(api.POST(`/v1/simple/changes/{change_id}/${action}`, { params: { path: { change_id: n.change_id } }, body: sessionId ? { session_id: sessionId } : {} })));
  const submit = () =>
    act(() => unwrap(api.POST("/v1/simple/drafts/{draft_id}/submit", { params: { path: { draft_id: v.draft!.id } } })));
  // Remind (owner, 2026-10-26): each waiting reviewer gets an Inbox nudge, once a day at most.
  const remind = () =>
    act(() => unwrap(api.POST("/v1/simple/one-pagers/{doc}/remind", { params: { path: { doc } } })));
  const undo = (n: Note) =>
    act(() => unwrap(api.POST("/v1/simple/changes/{change_id}/undo", { params: { path: { change_id: n.change_id } } })));

  async function exportPdf() {
    setError(null);
    try {
      const blob = await unwrap(api.GET("/v1/simple/one-pagers/{doc}/pdf", { params: { path: { doc } }, parseAs: "blob" })) as Blob;
      const name = `${v.document.title.replace(/[\\/:*?"<>|]+/g, " ").trim()} v${v.version} one-pager.pdf`;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function present() {
    setPresenting(true);
    await document.documentElement.requestFullscreen?.().catch(() => undefined);
  }
  async function stopPresenting() {
    setPresenting(false);
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
  }

  // qa-simple-prd-p3-2: leaving the editor puts the cursor back on the line's Edit; typed words ask first.
  function cancelEdit(l: Line, sure = false) {
    if (!sure && draftText !== (l.words ?? l.full ?? l.text)) {
      setDiscarding(true);
      return;
    }
    setDiscarding(false);
    setEditing(null);
    setTapped(l.id);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-edit-for="${l.id}"]`)?.focus());
  }
  const notesFor = (id: string) => v.notes.filter((n) => n.line_id === id);
  const plan = planNow ?? planQ.data ?? null;
  const planShown = !!plan && plan.status !== "none" && plan.milestones.length > 0 && !mk.rp2; // MOCK-HOOK: a draft PRD shows no approved plan
  const summary = docQ.data ?? null;
  // qa-simple-prd-18: a draft whose changes were all undone shows no banner.
  const draftShown = !!v.draft && (v.draft.changes > 0 || v.draft.status === "submitted");
  // qa-simple-prd-10: who may start a review is the start API's rule (can_start: an owner or the
  // PRD's decider); everyone else reads who can, on a disabled button.
  // Owners' "Needs a look": the checks a held build failed (kind "check", oracle.simple.quality)
  // in the note above the page; the PRD's numbers and codes to look at (ad-onepager) in NeedsALook.
  const heldChecks = v.needs_look.filter((x) => x.kind === "check");
  const prdLooks = v.needs_look.filter((x) => x.kind !== "check");
  const startWhy = v.decider ? `Ask ${v.decider.name} or an owner to start a review` : "Ask an owner to start a review";
  const actions = presenting ? (
    <button type="button" className={btn(phone)} onClick={stopPresenting}>Stop presenting</button>
  ) : (
    <>
      <button type="button" className={btn(phone)} onClick={present}>{!phone && <Glyph d={PRESENT} />}Present</button>
      <button type="button" className={btn(phone)} onClick={exportPdf}>{!phone && <Glyph d={PDF} />}Export PDF</button>
      {!sessionId && (
        // qa-simple-prd-p3-28: the reason sits under the disabled button, not in the row.
        <span className="relative inline-flex">
          <button
            type="button"
            className={`${btn(phone)} disabled:cursor-not-allowed disabled:opacity-60`}
            disabled={!v.can_start}
            title={v.can_start ? undefined : startWhy}
            aria-describedby={v.can_start ? undefined : "start-review-why"}
            onClick={() => setStarting(true)}
          >
            {!phone && <Glyph d={REVIEW} />}Start review
          </button>
          {!v.can_start && (
            <span id="start-review-why" data-testid="start-review-why" className="absolute top-full right-0 z-[1] mt-1 w-max max-w-[240px] text-right text-[13px] leading-[17px] text-text2">
              {startWhy}
            </span>
          )}
        </span>
      )}
      {/* qa-simple-prd-p3-28: the four actions in one style; in a meeting it opens in a new tab (qa-simple-decide). */}
      <Link className={`${btn(phone)} ${phone ? TAP44 : ""}`} href={`/documents/${v.document.slug}`} {...(sessionId ? { target: "_blank", rel: "noopener" } : {})}>
        Open the detailed view{sessionId ? " (new tab)" : ""}
      </Link>
    </>
  );
  const toast = saved && (
    <p role="status" className="simple-noprint fixed right-4 bottom-4 z-50 rounded-[10px] border border-line-strong bg-surface px-4 py-2 text-[15px] font-semibold shadow-md">PDF downloaded</p>
  );

  return (
    <div
      ref={root}
      className={`min-h-screen ${presenting ? "bg-[var(--simple-desk)]" : ""} text-[length:var(--simple-body)] text-text ${presenting ? "fixed inset-0 z-50 overflow-auto" : ""}`}
      data-testid="one-pager"
      data-presenting={presenting ? "true" : undefined}
    >
      {draftShown && v.draft && !presenting && (
        <div role="status" aria-label="Working draft" className="simple-noprint flex flex-wrap items-center gap-3 border-b border-[var(--simple-rule)] bg-[var(--simple-edited)] px-4 py-2 text-base">
          <strong>Working draft</strong>
          <span>· {v.draft.changes} {v.draft.changes === 1 ? "change" : "changes"}</span>
          <span>· published v{v.draft.base_version ?? v.version} stays live until approved</span>
          {v.draft.decider_approved && (v.draft.waiting_on.length > 0 || v.draft.blocked_by.length > 0) && (
            <span>· Approved in {v.draft.approved_in ?? "the meeting"} · not yet published: {heldWords(v.draft)}</span>
          )}
          {v.draft.status === "submitted" && !v.draft.decider_approved && v.draft.waiting_on.length > 0 && (
            <span data-testid="draft-waits-on">· Submitted · waiting on review from {v.draft.waiting_on.map((p) => p.name).join(", ")}</span>
          )}
          {v.draft.can_submit && (
            <Button disabled={busy} onClick={() => void submit()}>Submit for review</Button>
          )}
          {v.draft.status === "submitted" && v.draft.waiting_on.length > 0 && (v.draft.can_remind || v.draft.reminded_at) && (
            <span className="flex items-center gap-2">
              {v.draft.can_remind && (
                <Button disabled={busy} onClick={() => void remind()} title="Send each reviewer it waits on an Inbox reminder (once a day at most)">
                  Remind
                </Button>
              )}
              {v.draft.reminded_at && <span data-testid="reminded-at">Reminded {ago(v.draft.reminded_at)}</span>}
            </span>
          )}
        </div>
      )}
      {!draftShown && v.changes_in_review > 0 && !presenting && (
        <div role="status" className="simple-noprint border-b border-[var(--simple-rule)] px-4 py-2 text-base text-text-faint">
          {v.changes_in_review} {v.changes_in_review === 1 ? "change" : "changes"} in review · you read the published version
        </div>
      )}
      {/* oracle.simple.quality: Oracle's build failed its checks twice; the API names them to owners only. */}
      {heldChecks.length > 0 && !presenting && (
        <div role="note" aria-label="Needs a look" data-testid="needs-look" className="simple-noprint border-b border-[var(--simple-rule)] px-4 py-2 text-base text-text-faint">
          <span className="font-semibold text-text2">Needs a look</span> · Oracle&apos;s page missed these checks; others read the last good version.
          <ul className="mt-1 list-disc pl-5">
            {heldChecks.map((c) => <li key={c.text}>{c.text}</li>)}
          </ul>
        </div>
      )}
      <StartSheet open={starting} onClose={() => setStarting(false)} prd={v.document.slug} origin="one_pager" />
      {/* qa-simple-prd-14/44, p3-16: the same header (title, status, version, owner, span) on both kinds. */}
      <div className={`mx-auto flex max-w-[1180px] flex-col gap-5 px-12 pt-[26px] max-[767px]:gap-3.5 max-[767px]:px-4 max-[767px]:pt-3.5 ${planShown ? "pb-12" : ""}`}>
        <PrdHeader
          inMeeting={!!sessionId}
          v={v}
          plan={planShown ? plan : null}
          summary={summary}
          phone={phone}
          presenting={presenting}
          draft={draftShown || v.changes_in_review > 0}
          actions={actions}
        />
        {toast}
        {error && <ErrorNote>{error}</ErrorNote>}
        {planShown && <PrdPlan plan={plan!} title={v.document.title} onPlan={setPlanNow} />}
        {planShown && (v.can_edit || v.can_propose) && !presenting && !sessionId && (
          // qa-simple-prd-p3-4: the plan's words come from the PRD's lines; they are changed there.
          <p data-testid="plan-lines-door" className="simple-noprint flex flex-wrap items-center gap-x-3 gap-y-1 text-[15px] text-text2">
            The words above come from the PRD&apos;s lines.
            <button type="button" className={btn(phone)} aria-expanded={linesShown} onClick={() => setLinesShown((x) => !x)}>
              {linesShown ? "Hide the lines" : v.can_edit ? "Edit the wording" : "Propose wording"}
            </button>
          </p>
        )}
      </div>
      {/* With a plan the page ends with the milestone's card (pick D). The one-pager's lines and
          margin stay under it inside a review meeting, and whenever there is something to review
          (a working draft, changes in review or margin notes; BGD 2026-10-28), so the people
          Remind sends here can read and decide them. */}
      {(!planShown || linesShown || sessionId || !!v.draft || v.changes_in_review > 0 || v.notes.length > 0) && (
      <div className="mx-auto grid max-w-[1180px] gap-6 px-4 py-6 md:grid-cols-[minmax(0,820px)_var(--simple-margin)]">
        <article aria-label="One-pager" className="rounded-md border border-[var(--simple-rule)] bg-[var(--simple-paper)] px-6 py-8 shadow-sm md:col-start-1 md:px-12">
          {prdLooks.length > 0 && !presenting && <NeedsALook items={prdLooks} />}
          {mk.rp2 && ( // MOCK-HOOK
            <section aria-label="Timeline" className="mt-5"> {/* MOCK-HOOK */}
              <h2 className="text-sm font-semibold uppercase tracking-wide text-text-faint">Timeline</h2> {/* MOCK-HOOK */}
              <div className="mt-2">{(mk.rp2 === "b" || mk.rp2 === "d") ? <MkOnePagerDraft mk={mk} phone={phone} /> : <p className="text-base text-text-faint">No roadmap items yet</p>}</div> {/* MOCK-HOOK */}
            </section> // MOCK-HOOK
          )} {/* MOCK-HOOK */}
          {v.blocks.filter((b) => !(planShown && b.kind === "timeline") && !(mk.rp2 && b.kind === "timeline") /* MOCK-HOOK */).map((b) => (
            <section key={b.key} aria-label={b.title} className="mt-5">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-text-faint">{b.title}</h2>
              {b.kind === "timeline" ? (
                <div className="mt-2" aria-label="Timeline strip">
                  {v.plan ? <PlanByMonth plan={v.plan} prd={v.document} legend /> : <p className="text-base text-text-faint">No roadmap items yet</p>}
                </div>
              ) : (
                <ul className="mt-1 space-y-1">
                  {b.lines.map((l) => (
                    <li key={l.id} data-line={l.id} data-state={l.state} className="group list-none" onPointerDown={(e) => { const touch = e.pointerType !== "mouse"; firstTap.current = touch && tapped !== l.id; if (touch) setTapped(l.id); }} onClick={() => { firstTap.current = false; }}>
                      <div className={`rounded px-2 py-1 ${TINT[l.state]}`}>
                        {editing === l.id ? (
                          <form onSubmit={(e) => { e.preventDefault(); void save(l); }} className="space-y-2">
                            <label className="sr-only" htmlFor={`edit-${l.id}`}>New wording for {words.get(l.id)}</label>
                            <textarea
                              id={`edit-${l.id}`}
                              value={draftText}
                              onChange={(e) => setDraftText(e.target.value)}
                              // qa-simple-prd-p3-2: Escape cancels (back on the line's Edit), Ctrl/Cmd+Enter saves.
                              onKeyDown={(e) => {
                                if (e.key === "Escape") {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  cancelEdit(l);
                                } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                                  e.preventDefault();
                                  if (!busy && draftText.trim()) void save(l);
                                }
                              }}
                              aria-describedby={draftText.trim() ? undefined : `edit-${l.id}-why`}
                              rows={2}
                              className="w-full rounded border border-[var(--simple-rule)] bg-transparent p-2"
                            />
                            {!draftText.trim() && (
                              // qa-simple-prd-p3-27: why Save waits, and how a line goes.
                              <p id={`edit-${l.id}-why`} data-testid="line-edit-empty" className="text-sm text-text2">
                                A line needs words. To drop it, delete it in the detailed view.
                              </p>
                            )}
                            {discarding ? (
                              <div role="alertdialog" aria-label="Discard your changes?" className="flex flex-wrap items-center gap-2">
                                <span className="font-semibold">Discard your changes?</span>
                                <Button type="button" autoFocus onClick={() => { setDiscarding(false); document.getElementById(`edit-${l.id}`)?.focus(); }}>Keep editing</Button>
                                <Button type="button" variant="danger" onClick={() => cancelEdit(l, true)}>Discard</Button>
                              </div>
                            ) : (
                              <div className="flex gap-2">
                                <Button type="submit" variant="primary" disabled={busy || !draftText.trim()}>{v.can_edit ? "Save" : "Propose"}</Button>
                                <Button type="button" variant="ghost" onClick={() => cancelEdit(l)}>Cancel</Button>
                              </div>
                            )}
                          </form>
                        ) : (
                          <div className="relative flex items-start gap-2">
                            {/* qa-simple-prd-p3-25: on a desktop the Edit's room is kept, so pointing at a line never rewraps it. */}
                            <span className={`min-w-0 flex-1 ${(v.can_edit || v.can_propose) && !presenting ? (v.can_edit ? "md:pr-10" : "md:pr-36") : ""}`}>
                              <button type="button" className="text-left" aria-expanded={open === l.id} onClick={() => { if (!firstTap.current) setOpen(open === l.id ? null : l.id); }} data-testid="one-pager-line-text">
                                {b.kind === "lines" || b.kind === "metrics" ? "• " : ""}
                                {l.metric ? (<><span>{l.metric.name}: </span><strong className="tabular-nums">{l.metric.from || "—"} → {l.metric.to}</strong></>) : l.full ? (whole.has(l.id) ? l.full : foldAtSentence(l.full, l.text)) : l.text}
                              </button>
                              {l.full && !l.metric && foldAtSentence(l.full, l.text) !== l.full && (
                                <button
                                  type="button"
                                  className="simple-noprint ml-2 text-sm underline"
                                  aria-expanded={whole.has(l.id)}
                                  aria-label={`${whole.has(l.id) ? "Show less of" : "Show all of"} ${words.get(l.id)}`}
                                  onClick={() => setWhole((w) => { const n = new Set(w); if (n.has(l.id)) n.delete(l.id); else n.add(l.id); return n; })}
                                >
                                  {whole.has(l.id) ? "Show less" : "Show all"}
                                </button>
                              )}
                              {l.can_draw_flow && l.flow_subject && !asked.has(l.id) && !presenting && (
                                // 2026-10-30: a small link at the end of a bet's line, for those who may ask Oracle to draw its flow.
                                <button
                                  type="button"
                                  className="simple-noprint ml-2 text-sm text-text2 underline max-md:min-h-11"
                                  aria-label={`Draw the flow for ${words.get(l.id)}`}
                                  disabled={busy}
                                  onClick={() => void drawFlow(l)}
                                >
                                  Draw the flow
                                </button>
                              )}
                            </span>
                            {(v.can_edit || v.can_propose) && !presenting && (
                              // The owner's P6: "Edit" shows when the line is pointed at or tapped, not on every line.
                              <button
                                type="button"
                                // qa-simple-prd-37: hidden, it takes no width (it overlays the line's end); qa-simple-prd-36: 44 px on a phone.
                                // qa-simple-prd-p3-1: hidden, a touch on it opens nothing. qa-simple-prd-p3-25: on a desktop it
                                // always sits in the room kept at the line's end, so showing it moves no words.
                                data-edit-for={l.id}
                                className={`simple-noprint flex-none text-sm whitespace-nowrap underline focus:opacity-100 max-md:min-h-11 max-md:min-w-11 max-md:px-3 ${
                                  tapped === l.id
                                    ? "opacity-100 max-md:static md:absolute md:top-0 md:right-0"
                                    : "absolute top-0 right-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                                }`}
                                // A touch on it while hidden only shows it (as a tap on its line does).
                                // A touch that scrolls (no click) leaves nothing behind; a keyboard's Enter (no pointer) is never a tap.
                                onPointerDown={(e) => { hiddenTap.current = e.pointerType !== "mouse" && tapped !== l.id; }}
                                onPointerCancel={() => { hiddenTap.current = false; }}
                                onClick={(e) => {
                                  const tap = hiddenTap.current;
                                  hiddenTap.current = false;
                                  if (tap && e.detail > 0) return;
                                  setDiscarding(false);
                                  setEditing(l.id);
                                  setDraftText(l.words ?? l.full ?? l.text);
                                }}
                              >
                                <span aria-hidden data-testid="line-edit-word">{v.can_edit ? "Edit" : "Propose wording"}</span>
                                <span className="sr-only">{v.can_edit ? `Edit ${words.get(l.id)}` : `Propose wording for ${words.get(l.id)}`}</span>
                              </button>
                            )}
                          </div>
                        )}
                        {b.kind === "metrics" && editing !== l.id && (
                          // 2026-10-30: how the outcome is measured, from the PRD (what is counted and where).
                          <p className="pl-3 text-sm text-text2" data-testid="outcome-measure">
                            {l.measure ? `counted as: ${l.measure}${l.measure_source ? ` · from ${l.measure_source}` : ""}` : "How it is measured is not in the PRD yet"}
                          </p>
                        )}
                        {l.footnotes.length > 0 && editing !== l.id && (
                          <p className="pl-3 text-sm text-text2" data-testid="line-footnotes">{l.footnotes.join(" ")}</p>
                        )}
                        {l.flow_subject && (l.flow || asked.has(l.id)) && (
                          // The flows review (2026-10-30: only once a flow exists or is being drawn): a bet's flow is the same row as a roadmap card's
                          // (the live thumbnail and its states), opened in place.
                          <div className="simple-noprint" aria-label={`User flow of ${words.get(l.id)}`} role="group">
                            <FlowPanel row subject={{ kind: "one_pager_line", id: l.flow_subject }} documentId={v.document.id} openLabel={`Flow for ${words.get(l.id)}`} />
                          </div>
                        )}
                        {l.decisions.length > 0 && (
                          <p className="simple-noprint text-sm" data-testid="line-decisions">
                            {l.decisions.slice(0, 3).map((d, i) => (
                              <span key={d.id}>
                                {i === 0 ? "Decided in " : ", "}
                                <Link className="underline" href={`/simple/decisions#d-${d.number}`} title={d.title}>D-{d.number}</Link>
                              </span>
                            ))}
                          </p>
                        )}
                        {open === l.id && (
                          // qa-simple-prd-16: an inline expansion in the page's own type (Escape closes it).
                          <div role="region" aria-label={`Sources of ${words.get(l.id)}`} className="simple-noprint mt-2 rounded border border-[var(--simple-rule)] bg-[var(--simple-paper)] p-3 text-base">
                            {l.source_keys.map((k) => {
                              const sec = v.sections.find((x) => x.key === k);
                              if (!sec) return null;
                              const rows = plainLines(sec.body);
                              // qa-simple-prd-p3-26: where in the PRD the line comes from: its section, the line marked in it.
                              const mine = (x: string) => isSource(x, l);
                              const row = (x: { text: string }) => (mine(x.text) ? <mark data-testid="source-line" className="rounded-sm bg-[var(--simple-edited)] px-0.5 text-text">{x.text}</mark> : x.text);
                              return (
                                <div key={k} className="mb-2">
                                  <p className="text-sm font-semibold">From the PRD&apos;s section “{sec.heading}”</p>
                                  {rows.some((x) => x.bullet) ? (
                                    <ul className="list-disc space-y-0.5 pl-5 text-sm text-text2">{rows.map((x, i) => <li key={i}>{row(x)}</li>)}</ul>
                                  ) : (
                                    rows.map((x, i) => <p key={i} className="text-sm text-text2">{row(x)}</p>)
                                  )}
                                </div>
                              );
                            })}
                            {l.decisions.length > 0 && <p className="mb-2 text-sm text-text2">Decided in {l.decisions.map((d) => `D-${d.number} ${d.title}`).join(", ")}</p>}
                            <Link className="underline" href={`/documents/${v.document.slug}#${l.source_keys[0]}`}>Open the detailed view</Link>
                            <button type="button" className="ml-3 text-sm underline" onClick={() => setOpen(null)}>Close</button>
                          </div>
                        )}
                      </div>
                      {/* Phone: the margin notes move under their line. */}
                      <div className="md:hidden">{!presenting && notesFor(l.id).map((n) => <MarginNote key={n.change_id} {...{ n, quote: words.get(l.id) ?? "", busy, diff, setDiff, wide, setWide, undo, decide }} />)}</div>
                    </li>
                  ))}
                  {b.lines.length === 0 && <li className="list-none text-base text-text-faint" data-testid="one-pager-empty-block">{b.missing ? "Not in the PRD yet" : "Not written yet"}</li>}
                  {b.key === "problem" && (
                    // 2026-10-30: who has the problem, from the PRD's users or personas section.
                    <li className="list-none px-2 text-base" data-testid="problem-who">
                      {b.who ? `Who has it: ${b.who}` : "Who has it is not in the PRD yet"}
                    </li>
                  )}
                </ul>
              )}
            </section>
          ))}
        </article>
        <aside ref={margin} aria-label="Changes and proposals" className={`simple-noprint relative hidden min-w-0 ${presenting || (!v.notes.length && !v.can_edit && !v.can_propose) ? "" : "md:block"}`}>
          {/* qa-simple-prd-34: the margin says what it is for; readers who change nothing see none when empty. */}
          {v.notes.length === 0 && <p className="text-sm font-semibold uppercase tracking-wide text-text-faint">Changes and proposals</p>}
          {[...v.notes].sort((a, b) => (numbers.get(a.line_id) ?? 0) - (numbers.get(b.line_id) ?? 0)).map((n) => (
            <div key={n.change_id} data-note-for={n.line_id} data-change={n.change_id} className="absolute inset-x-0">
              <MarginNote {...{ n, quote: words.get(n.line_id) ?? "", busy, diff, setDiff, wide, setWide, undo, decide }} />
            </div>
          ))}
          {v.notes.length === 0 && <p className="mt-1 text-base text-text2">No changes yet. An edit or a proposed wording shows here beside its line.</p>}
        </aside>
      </div>
      )}
    </div>
  );
}

/** A section's row the line was read from: the same words, or the line's words start it. */
function isSource(row: string, l: Line): boolean {
  const norm = (x: string) => x.replace(/…$/, "").replace(/\s+/g, " ").trim().toLowerCase();
  const r = norm(row);
  const w = norm(l.metric ? l.metric.name : (l.full ?? l.text));
  return !!r && !!w && (r === w || r.startsWith(w) || w.startsWith(r) || r.includes(w));
}

const btn = (phone: boolean) =>
  `simple-noprint inline-flex items-center gap-[7px] border border-line-strong bg-surface font-semibold whitespace-nowrap text-text ${phone ? "min-h-[34px] rounded-[9px] px-2.5 text-[14px]" : "min-h-10 rounded-[10px] px-3.5 text-[15px]"}`;
const PRESENT = "M3 4h18v12H3zM12 16v4M8 20h8";
const PDF = "M12 4v11M7 10l5 5 5-5M5 20h14";
const REVIEW = "M4 5h16v11h-9l-5 4v-4H4z";
function Glyph({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} aria-hidden fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className="flex-none">
      <path d={d} />
    </svg>
  );
}

/**
 * fidelity prd (pick D, D1 and D2): the PRD's own header above its timeline: the way back to
 * One-pagers, Present, Export PDF, Start review and the detailed view, the title, then
 * Approved, the version and its day, the owner, the plan's dates and its engineer-weeks.
 * A phone (D2) keeps the title, the facts and the actions, smaller; its header bar names
 * the page (One-pagers), so the title there is a level-1 heading that is not an H1.
 */
function PrdHeader({ v, plan, summary, phone, presenting, draft, actions, inMeeting = false }: { v: View; plan: Schemas["SimplePlanOut"] | null; summary: Schemas["DocumentSummary"] | null; phone: boolean; presenting: boolean; draft: boolean; actions: ReactNode; inMeeting?: boolean }) {
  // qa-simple-prd-3: the plan's own span only; with no dated milestone the header says so.
  // qa-simple-prd-p3-16: a PRD without a plan heads its one-pager the same way, with its own span.
  const span = plan ? (plan.span ? { start: plan.span.start, end: plan.span.end } : null) : v.span_start && v.span_end ? { start: v.span_start, end: v.span_end } : null;
  const caps = (plan?.milestones ?? []).map((m) => m.effort_weeks).filter((x): x is number => x != null);
  const total = caps.length ? caps.reduce((a, b) => a + b, 0) : null;
  const published = v.published_at ? dmy(v.published_at.slice(0, 10)) : null;
  // qa-simple-prd-p3-16: "Approved" only where the One-pagers list says so too (one summary for both).
  const approved = !!published && (!summary || !!summary.approved_version || summary.status === "approved");
  // qa-simple-prd-47: separators at the meta line's own 4.5:1 colour.
  const sep = phone ? null : <span aria-hidden className="text-text2">·</span>;
  return (
    <div className="flex flex-col gap-2.5">
      {!phone && (
        <div className="flex items-center gap-2.5">
          {!presenting && !inMeeting && <BackLink />}
          <span className="flex-1" />
          {actions}
        </div>
      )}
      {phone ? (
        <div role="heading" aria-level={1} className="text-[25px] leading-[31px] font-[750] tracking-[-.01em]">{v.document.title}</div>
      ) : (
        <h1 className="text-[34px] leading-[42px] font-bold tracking-[-.01em]">{v.document.title}</h1>
      )}
      <div data-testid="one-pager-meta" className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[15px] leading-[22px] text-text2">
        {approved && (
          <span className="inline-flex h-6 items-center gap-[5px] rounded-xl bg-pass-bg px-[9px] text-[13px] leading-[18px] font-semibold whitespace-nowrap text-pass">
            <svg viewBox="0 0 24 24" width={16} height={16} aria-hidden fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
            Approved
          </span>
        )}
        {/* qa-simple-prd-9: the same state the One-pagers list names. */}
        {approved && draft && <span data-testid="one-pager-draft-chip" className="text-[14px] font-semibold text-text">draft in progress</span>}
        {/* qa-simple-prd-p3-16: never approved, it shows the status the list shows ("In review", "Draft"). */}
        {!approved && summary && <span data-testid="one-pager-status"><PrdStatus d={summary} /></span>}
        <span>{phone && plan ? `v${v.version}` : `Version ${v.version}`}{published ? ` · ${published}` : ""}</span>
        {sep}
        {v.owner ? <span>Owner <b className="font-[650] text-text">{v.owner.name}</b></span> : <span>No owner yet</span>}
        {!plan && v.decider && (
          <>
            {sep}
            <span>Decider <b className="font-[650] text-text">{v.decider.name}</b></span>
          </>
        )}
        {(plan || span) && sep}
        {span ? <b className="font-[650] text-text">{dmy(span.start)} → {dmy(span.end)}</b> : plan && <span data-testid="one-pager-no-dates">No dates yet</span>}
        {total != null && (
          <>
            {sep}
            <span>
              <b className="font-[650] text-text">{ew(total)}</b>
            </span>
          </>
        )}
      </div>
      {phone && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/simple/one-pagers" className="inline-flex items-center gap-1 text-[15px] font-semibold text-accent">
      <svg viewBox="0 0 24 24" width={16} height={16} aria-hidden fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
        <path d="M15 6l-6 6 6 6" />
      </svg>
      One-pagers
    </Link>
  );
}

/** Each margin note's top at its line's top, pushed below the note above it. */
function placeNotes(el: HTMLElement | null) {
  if (!el) return;
  const base = el.getBoundingClientRect().top;
  let floor = 0;
  for (const card of Array.from(el.querySelectorAll<HTMLElement>("[data-note-for]"))) {
    const line = document.querySelector(`[data-line="${card.dataset.noteFor}"]`);
    const top = Math.max(line ? line.getBoundingClientRect().top - base : floor, floor);
    card.style.top = `${Math.round(top)}px`;
    floor = top + card.offsetHeight + 12;
  }
  el.style.minHeight = `${Math.round(floor)}px`;
}

function MarginNote({
  n, quote: line, busy, diff, setDiff, wide, setWide, undo, decide,
}: {
  n: Note;
  quote: string;
  busy: boolean;
  diff: string | null;
  setDiff: (id: string | null) => void;
  wide: string | null;
  setWide: (id: string | null) => void;
  undo: (n: Note) => void;
  decide: (n: Note, a: "accept" | "decline") => void;
}) {
  const zone = useCompanyZone();
  // The note names its line by the words it had (they stay put while the line changes).
  const quote = quoteLine(n.before) || line;
  const widened = wide === n.change_id;
  const shown = diff === n.change_id;
  const words = wordDiff(n.before, n.after);
  // Escape closes the note's flow dialog, as the page's other dialogs.
  useEffect(() => {
    if (!widened) return;
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape") setWide(null);
    };
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  }, [widened, setWide]);
  return (
    <div
      role="note"
      aria-label={n.kind === "change" ? `Change to ${quote}` : `Proposal for ${quote}`}
      data-widened={widened ? "true" : undefined}
      className={`min-w-0 rounded-md border border-[var(--simple-rule)] p-3 text-base [overflow-wrap:anywhere] ${n.kind === "change" ? "bg-[var(--simple-edited)]" : "bg-[var(--simple-proposal)]"}`}
    >
      <p>
        {n.kind === "change"
          ? `${n.can_undo ? "You" : n.by_name} changed ${quote} · ${clock(n.at, zone)}${n.meeting_title ? `, in ${n.meeting_title}` : n.in_meeting ? ", in the meeting" : ""}`
          : `${n.can_undo ? "You propose" : `${n.by_name} proposes`} new wording for ${quote} · ${clock(n.at, zone)}`}
      </p>
      {/* qa-simple-prd-35: a proposal shows its words at once. */}
      {n.kind === "proposal" && <p className="mt-1 text-[15px]" data-testid="proposal-words">“{n.after}”</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {/* qa-simple-prd-p3-17: a proposer withdraws their own proposal (the undo of a proposal). */}
        {n.can_undo && <Button disabled={busy} onClick={() => undo(n)}>{n.kind === "proposal" ? "Withdraw" : "Undo"}</Button>}
        {n.can_decide && <Button variant="primary" disabled={busy} onClick={() => decide(n, "accept")}>Accept</Button>}
        {n.can_decide && <Button disabled={busy} onClick={() => decide(n, "decline")}>Decline</Button>}
        <button type="button" className="text-sm underline" aria-expanded={shown} onClick={() => setDiff(shown ? null : n.change_id)}>See before/after</button>
        {n.adds_feature && (
          <button type="button" aria-label={`Flow for ${quote}`} className="h-8 w-12 rounded border border-[var(--simple-rule)] bg-[var(--simple-paper)] text-xs" onClick={() => setWide(widened ? null : n.change_id)}>
            {n.flow ? "Flow" : "⋯"}
          </button>
        )}
      </div>
      {shown && (
        // qa-simple-prd-17: only the changed words are marked, in the page's type.
        <div className="mt-2 space-y-2 text-sm" aria-label="Before and after" data-testid="note-diff">
          <p><span className="font-semibold">Before:</span> {words.a}</p>
          <p><span className="font-semibold">After:</span> {words.b}</p>
          {n.sections.map((s) => {
            const was = plainLines(s.before).map((x) => x.text);
            const now = plainLines(s.after).map((x) => x.text);
            const gone = was.filter((x) => !now.includes(x));
            const added = now.filter((x) => !was.includes(x));
            return (
              <div key={s.key} className="rounded border border-[var(--simple-rule)] p-2">
                <p className="font-semibold">In “{s.heading}”</p>
                {gone.map((x, i) => <p key={`g${i}`}><del>{x}</del></p>)}
                {added.map((x, i) => <p key={`a${i}`}><ins>{x}</ins></p>)}
                {!gone.length && !added.length && <p>No other change</p>}
              </div>
            );
          })}
        </div>
      )}
      {widened && (
        // qa-simple-prd-2: the flow opens in a dialog wide enough for it, over a dimmed page.
        <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/50 md:pt-16" onClick={(e) => { if (e.target === e.currentTarget) setWide(null); }}>
          <div role="dialog" aria-modal="true" aria-label="User flow" className="h-full w-full overflow-auto bg-[var(--simple-paper)] p-4 md:h-auto md:max-h-[80vh] md:w-[min(640px,90vw)] md:rounded-md">
            <FlowPanel subject={{ kind: n.flow?.subject_kind ?? "change", id: n.flow?.subject_id ?? n.change_id }} />
            <Button className="mt-2" onClick={() => setWide(null)}>Close</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * "Needs a look" (2026-10-30): a quiet note for the PRD's owners (the API sends the items to
 * them only) naming what to look at and where. One list any of the one-pager's checks can add to.
 */
export function NeedsALook({ items }: { items: Schemas["OnePagerLook"][] }) {
  return (
    <section aria-label="Needs a look" className="simple-noprint mb-4 rounded border border-dashed border-[var(--simple-rule)] px-3 py-2 text-sm text-text2">
      <h2 className="font-semibold">Needs a look</h2>
      <ul className="mt-1 space-y-1">
        {items.map((x, i) => (
          <li key={i} data-kind={x.kind}>
            {x.text}
            {x.where.length > 0 && <span className="text-text-faint"> In: {x.where.join(", ")}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
