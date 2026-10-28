"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Button } from "@/components/ds";
import { FlowPanel } from "@/components/simple/FlowVisual";
import { PlanByMonth } from "@/components/simple/PlanByMonth";
import { PrdTimeline } from "@/components/simple/PrdTimeline";
import { StartSheet } from "@/components/simple/meetings/StartSheet";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { calendarDay, formatInZone, useCompanyZone } from "@/lib/dates";
import { errorMessage, useQuery } from "@/lib/use-query";

type View = Schemas["OnePagerOut"];
type Line = Schemas["OnePagerLine"];
type Note = Schemas["OnePagerNote"];

function day(d: string | null | undefined): string {
  return d ? calendarDay(d.slice(0, 10), { month: "short", day: "numeric", year: "numeric" }) : "";
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
  const [planNow, setPlanNow] = useState<Schemas["SimplePlanOut"] | null>(null);
  useEffect(() => {
    if (seenRefresh.current === refresh) return;
    seenRefresh.current = refresh;
    void reloadPage();
    // A newly approved version's plan shows at once, not only after moving away and back.
    setPlanNow(null);
    void reloadPlan();
  }, [refresh, reloadPage, reloadPlan]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  // A phone: the line last tapped shows its Edit (a tap is no hover; it need not open the line).
  // A phone snaps a tap near the words onto them, so a line's first tap only shows its Edit and
  // a second tap on its words opens it.
  const [tapped, setTapped] = useState<string | null>(null);
  const firstTap = useRef(false);
  const [diff, setDiff] = useState<string | null>(null);
  const [wide, setWide] = useState<string | null>(null);
  // Lines shortened with "…" shown whole, in place (CLD's production walk, 2026-10-27).
  const [whole, setWhole] = useState<Set<string>>(new Set());
  const [presenting, setPresenting] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  // Desktop margin: each note sits beside its line (placeNotes).
  const margin = useRef<HTMLElement>(null);
  useEffect(() => {
    const on = () => placeNotes(margin.current);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  useLayoutEffect(() => placeNotes(margin.current));

  if (q.loading && !q.data) return <div className="px-6 py-8"><Loading /></div>;
  if (q.error || !q.data) return <div className="px-6 py-8"><ErrorNote>{q.error ?? "Not found"}</ErrorNote></div>;
  const v: View = q.data;
  const numbers = new Map<string, number>();
  v.blocks.flatMap((b) => b.lines).forEach((l, i) => numbers.set(l.id, i + 1));

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
      const name = `${v.document.slug}-v${v.version}-one-pager.pdf`;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setSaved(name);
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

  const notesFor = (id: string) => v.notes.filter((n) => n.line_id === id);
  const plan = planNow ?? planQ.data ?? null;
  const planShown = !!plan && plan.status !== "none" && plan.milestones.length > 0;
  const meta = [
    `Version ${v.version}`,
    v.published_at ? `published ${day(v.published_at)}` : null,
    v.owner ? `Owner ${v.owner.name}` : "No owner yet",
    v.decider ? `Decider ${v.decider.name}` : null,
    plan?.span ? plan.span.label : v.span_start && v.span_end ? `${day(v.span_start)} – ${day(v.span_end)}` : null,
  ].filter(Boolean);

  return (
    <div
      className={`min-h-screen bg-[var(--simple-desk)] text-[length:var(--simple-body)] text-text ${presenting ? "fixed inset-0 z-50 overflow-auto" : ""}`}
      data-testid="one-pager"
      data-presenting={presenting ? "true" : undefined}
    >
      {v.draft && (
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
      {!v.draft && v.changes_in_review > 0 && (
        <div role="status" className="simple-noprint border-b border-[var(--simple-rule)] px-4 py-2 text-base text-text-faint">
          {v.changes_in_review} {v.changes_in_review === 1 ? "change" : "changes"} in review · you read the published version
        </div>
      )}
      <div className="simple-noprint mx-auto flex max-w-[1180px] flex-wrap items-center justify-end gap-2 px-4 pt-4">
        {presenting ? (
          <Button onClick={stopPresenting}>Stop presenting</Button>
        ) : (
          <Button onClick={present}>Present</Button>
        )}
        <Button onClick={exportPdf}>Export PDF</Button>
        {!sessionId && <Button onClick={() => setStarting(true)}>Start review</Button>}
        <Link className="underline" href={`/documents/${v.document.slug}`}>Open the detailed view</Link>
      </div>
      <StartSheet open={starting} onClose={() => setStarting(false)} prd={v.document.slug} origin="one_pager" />
      {saved && <p role="status" className="simple-noprint mx-auto max-w-[1180px] px-4 text-right text-base">Saved {saved}</p>}
      {error && <div className="mx-auto max-w-[1180px] px-4"><ErrorNote>{error}</ErrorNote></div>}
      {planShown && (
        <div className="mx-auto max-w-[1180px] px-4 pt-6">
          <PrdTimeline plan={plan} onPlan={setPlanNow} />
        </div>
      )}
      <div className="mx-auto grid max-w-[1180px] gap-6 px-4 py-6 md:grid-cols-[minmax(0,820px)_var(--simple-margin)]">
        <article aria-label="One-pager" className="rounded-md border border-[var(--simple-rule)] bg-[var(--simple-paper)] px-6 py-8 shadow-sm md:col-start-1 md:px-12">
          <header className="mb-4 border-b border-[var(--simple-rule)] pb-3">
            <h1 className="text-3xl font-semibold">{v.document.title}</h1>
            <p className="mt-1 text-base text-text-faint" data-testid="one-pager-meta">{meta.join(" · ")}</p>
          </header>
          {v.blocks.filter((b) => !(planShown && b.kind === "timeline")).map((b) => (
            <section key={b.key} aria-label={b.title} className="mt-5">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-text-faint">{b.title}</h2>
              {b.kind === "timeline" ? (
                <div className="mt-2" aria-label="Timeline strip">
                  {v.plan ? <PlanByMonth plan={v.plan} prd={v.document} /> : <p className="text-base text-text-faint">No roadmap items yet</p>}
                </div>
              ) : (
                <ul className="mt-1 space-y-1">
                  {b.lines.map((l) => (
                    <li key={l.id} data-line={l.id} data-state={l.state} className="group list-none" onPointerDown={(e) => { const touch = e.pointerType !== "mouse"; firstTap.current = touch && tapped !== l.id; if (touch) setTapped(l.id); }} onClick={() => { firstTap.current = false; }}>
                      <div className={`rounded px-2 py-1 ${TINT[l.state]}`}>
                        {editing === l.id ? (
                          <form onSubmit={(e) => { e.preventDefault(); void save(l); }} className="space-y-2">
                            <label className="sr-only" htmlFor={`edit-${l.id}`}>Line {numbers.get(l.id)}</label>
                            <textarea id={`edit-${l.id}`} value={draftText} onChange={(e) => setDraftText(e.target.value)} rows={2} className="w-full rounded border border-[var(--simple-rule)] bg-transparent p-2" />
                            <div className="flex gap-2">
                              <Button type="submit" variant="primary" disabled={busy || !draftText.trim()}>{v.can_edit ? "Save" : "Propose"}</Button>
                              <Button type="button" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                            </div>
                          </form>
                        ) : (
                          <div className="flex items-start gap-2">
                            <span className="flex-1">
                              <button type="button" className="text-left" aria-expanded={open === l.id} onClick={() => { if (!firstTap.current) setOpen(open === l.id ? null : l.id); }} data-testid="one-pager-line-text">
                                {b.kind === "lines" || b.kind === "metrics" ? "• " : ""}
                                {l.metric ? (<><span>{l.metric.name}: </span><strong className="tabular-nums">{l.metric.from || "—"} → {l.metric.to}</strong></>) : l.full ? (whole.has(l.id) ? l.full : foldAtSentence(l.full, l.text)) : l.text}
                              </button>
                              {l.full && !l.metric && foldAtSentence(l.full, l.text) !== l.full && (
                                <button
                                  type="button"
                                  className="simple-noprint ml-2 text-sm underline"
                                  aria-expanded={whole.has(l.id)}
                                  aria-label={`${whole.has(l.id) ? "Show less of" : "Show all of"} line ${numbers.get(l.id)}`}
                                  onClick={() => setWhole((w) => { const n = new Set(w); if (n.has(l.id)) n.delete(l.id); else n.add(l.id); return n; })}
                                >
                                  {whole.has(l.id) ? "Show less" : "Show all"}
                                </button>
                              )}
                            </span>
                            {(v.can_edit || v.can_propose) && (
                              // The owner's P6: "Edit" shows when the line is pointed at or tapped, not on every line.
                              <button
                                type="button"
                                className={`simple-noprint text-sm underline group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 ${tapped === l.id ? "opacity-100" : "opacity-0"}`}
                                onClick={() => { setEditing(l.id); setDraftText(l.full ?? l.text); }}
                              >
                                <span aria-hidden data-testid="line-edit-word">{v.can_edit ? "Edit" : "Propose wording"}</span>
                                <span className="sr-only">{v.can_edit ? `Edit line ${numbers.get(l.id)}` : `Propose wording for line ${numbers.get(l.id)}`}</span>
                              </button>
                            )}
                          </div>
                        )}
                        {l.flow_subject && (
                          // The flows review: a bet's flow is the same row as a roadmap card's
                          // (the live thumbnail and its states), opened in place.
                          <div className="simple-noprint" aria-label={`User flow of bet ${numbers.get(l.id)}`} role="group">
                            <FlowPanel row subject={{ kind: "one_pager_line", id: l.flow_subject }} documentId={v.document.id} openLabel={`Flow for bet ${numbers.get(l.id)}`} />
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
                          <div role="dialog" aria-label={`Sources of line ${numbers.get(l.id)}`} className="simple-noprint mt-2 rounded border border-[var(--simple-rule)] bg-[var(--simple-paper)] p-3 text-base shadow-md">
                            {l.source_keys.map((k) => {
                              const sec = v.sections.find((x) => x.key === k);
                              return (
                                <div key={k} className="mb-2">
                                  <p className="text-sm font-semibold">{sec?.heading ?? k}</p>
                                  {sec && <p className="whitespace-pre-wrap text-sm text-text-faint">{sec.body}</p>}
                                </div>
                              );
                            })}
                            <Link className="underline" href={`/documents/${v.document.slug}#${l.source_keys[0]}`}>Open the detailed view</Link>
                          </div>
                        )}
                      </div>
                      {/* Phone: the margin notes move under their line. */}
                      <div className="md:hidden">{notesFor(l.id).map((n) => <MarginNote key={n.change_id} {...{ n, no: numbers.get(l.id)!, busy, diff, setDiff, wide, setWide, undo, decide }} />)}</div>
                    </li>
                  ))}
                  {b.lines.length === 0 && <li className="list-none text-base text-text-faint" data-testid="one-pager-empty-block">Not written yet</li>}
                </ul>
              )}
            </section>
          ))}
        </article>
        <aside ref={margin} aria-label="Margin" className="simple-noprint relative hidden md:block">
          {[...v.notes].sort((a, b) => (numbers.get(a.line_id) ?? 0) - (numbers.get(b.line_id) ?? 0)).map((n) => (
            <div key={n.change_id} data-note-for={n.line_id} data-change={n.change_id} className="absolute inset-x-0">
              <MarginNote {...{ n, no: numbers.get(n.line_id) ?? 0, busy, diff, setDiff, wide, setWide, undo, decide }} />
            </div>
          ))}
          {v.notes.length === 0 && <p className="text-base text-text-faint">No changes yet.</p>}
        </aside>
      </div>
    </div>
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
  n, no, busy, diff, setDiff, wide, setWide, undo, decide,
}: {
  n: Note;
  no: number;
  busy: boolean;
  diff: string | null;
  setDiff: (id: string | null) => void;
  wide: string | null;
  setWide: (id: string | null) => void;
  undo: (n: Note) => void;
  decide: (n: Note, a: "accept" | "decline") => void;
}) {
  const zone = useCompanyZone();
  const widened = wide === n.change_id;
  return (
    <div
      role="note"
      aria-label={n.kind === "change" ? `Change to line ${no}` : `Proposal for line ${no}`}
      data-widened={widened ? "true" : undefined}
      className={`rounded-md border border-[var(--simple-rule)] p-3 text-base ${n.kind === "change" ? "bg-[var(--simple-edited)]" : "bg-[var(--simple-proposal)]"} ${widened ? "fixed inset-x-0 bottom-0 top-0 z-40 overflow-auto md:static md:w-[min(640px,90vw)]" : ""}`}
    >
      <p>
        {n.kind === "change"
          ? `${n.can_undo ? "You" : n.by_name} changed line ${no} · ${formatInZone(n.at, zone, { hour: "numeric", minute: "2-digit" })}${n.meeting_title ? `, in ${n.meeting_title}` : n.in_meeting ? ", in the meeting" : ""}`
          : `${n.by_name} proposes new wording for line ${no}`}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {n.can_undo && <Button disabled={busy} onClick={() => undo(n)}>Undo</Button>}
        {n.can_decide && <Button variant="primary" disabled={busy} onClick={() => decide(n, "accept")}>Accept</Button>}
        {n.can_decide && <Button disabled={busy} onClick={() => decide(n, "decline")}>Decline</Button>}
        <button type="button" className="text-sm underline" aria-expanded={diff === n.change_id} onClick={() => setDiff(diff === n.change_id ? null : n.change_id)}>See before/after</button>
        {n.adds_feature && (
          <button type="button" aria-label={`Flow for line ${no}`} className="h-8 w-12 rounded border border-[var(--simple-rule)] bg-[var(--simple-paper)] text-xs" onClick={() => setWide(widened ? null : n.change_id)}>
            {n.flow ? "Flow" : "⋯"}
          </button>
        )}
      </div>
      {diff === n.change_id && (
        <div className="mt-2 space-y-2 text-sm" aria-label="Before and after">
          <p><span className="font-semibold">Line before:</span> <del>{n.before}</del></p>
          <p><span className="font-semibold">Line after:</span> <ins>{n.after}</ins></p>
          {n.sections.map((s) => (
            <div key={s.key} className="rounded border border-[var(--simple-rule)] p-2">
              <p className="font-semibold">Section “{s.heading}”</p>
              <pre className="whitespace-pre-wrap"><del>{s.before}</del></pre>
              <pre className="whitespace-pre-wrap"><ins>{s.after}</ins></pre>
            </div>
          ))}
        </div>
      )}
      {widened && (
        <div className="mt-3" aria-label="User flow">
          <FlowPanel subject={{ kind: n.flow?.subject_kind ?? "change", id: n.flow?.subject_id ?? n.change_id }} />
          <Button className="mt-2" onClick={() => setWide(null)}>Close</Button>
        </div>
      )}
    </div>
  );
}


