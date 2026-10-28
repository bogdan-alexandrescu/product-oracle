"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatInZone, useCompanyZone } from "@/lib/dates";
import { useQuery } from "@/lib/use-query";

import { FlowDiagram, FlowScreen, FlowStepList, FlowStoryboard, usePhone, ViewSwitch } from "./FlowViews";

type Flow = Schemas["SimpleFlow"];
type Visual = Schemas["SimpleVisualOut"];
export type FlowSubject = { kind: string; id: string };

/** The subject a flow is the visual of, when the API names it. */
export function subjectOf(flow: { subject_kind?: string | null; subject_id?: string | null } | null | undefined): FlowSubject | null {
  return flow?.subject_kind && flow.subject_id ? { kind: flow.subject_kind, id: flow.subject_id } : null;
}

/** The opened drawing (the owner's pick A): the whole diagram fitted to the width with short
 * labels, then every step in full words, then the screen it touches as a labelled wireframe
 * (Oracle's sanitised wireframe in a sandboxed frame, nothing in it runs) with its numbered
 * annotations. In the full-screen viewer (C, `big`): the diagram top to bottom on the left,
 * the steps on the right, the wireframe below; on a phone three tabs, Diagram | Steps | Screen. */
function Drawing({ flow, big, phone }: { flow: Flow; big?: boolean; phone: boolean }) {
  const [tab, setTab] = useState<"diagram" | "steps" | "screen">("diagram");
  const diagram = <FlowDiagram flow={flow} layout={big ? "down" : "across"} testId="flow-svg" />;
  const steps = (
    <div>
      <h3 className="font-semibold">Steps</h3>
      {flow.goal && <p className="text-[length:var(--simple-small)] text-text2" data-testid="flow-goal">Goal: {flow.goal}</p>}
      <div className="mt-2">
        <FlowStepList flow={flow} />
      </div>
    </div>
  );
  const screen = (
    <div>
      <h3 className="font-semibold">Screen: {flow.touches_screen ? flow.screen.title : "none (it touches no screen)"}</h3>
      {flow.wireframe ? (
        <>
          <p className="text-[length:var(--simple-small)] text-text2" data-testid="flow-regions">
            Regions: {flow.screen.regions.join(" · ")}
          </p>
          <iframe title={`Wireframe of ${flow.screen.title}`} sandbox="" srcDoc={flow.wireframe} data-testid="flow-wireframe" className={`mt-2 w-full rounded-lg border border-line bg-white ${big ? "h-[420px]" : "h-56"}`} />
        </>
      ) : flow.touches_screen ? (
        <div className="mt-1">
          <FlowScreen flow={flow} />
        </div>
      ) : null}
      {(flow.annotations?.length ?? 0) > 0 && (
        <ol className="mt-3 space-y-1 text-[length:var(--simple-small)]" aria-label="Annotations" data-testid="flow-annotations">
          {flow.annotations!.map((a) => (
            <li key={a.n}>
              <span className="mr-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-text text-[11px] font-bold text-surface">{a.n}</span>
              {a.note}
              {(a.section_key || a.requirement) && (
                <span className="text-text2">
                  {" "}
                  · {a.section_key ? `PRD § ${a.section_key}` : ""}
                  {a.section_key && a.requirement ? ", " : ""}
                  {a.requirement ? `requirement ${a.requirement}` : ""}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
  if (big && phone) {
    return (
      <div>
        <div role="tablist" aria-label="Parts of the flow" className="flex w-full overflow-hidden rounded-button border border-line-strong">
          {(["diagram", "steps", "screen"] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`h-11 flex-1 font-medium ${tab === t ? "bg-accent text-on-accent" : "bg-surface text-text"}`}>
              {t === "diagram" ? "Diagram" : t === "steps" ? "Steps" : "Screen"}
            </button>
          ))}
        </div>
        <div role="tabpanel" className="mt-3">
          {tab === "diagram" ? diagram : tab === "steps" ? steps : screen}
        </div>
      </div>
    );
  }
  if (big) {
    return (
      <div className="space-y-4">
        <div className="grid gap-6 md:grid-cols-[minmax(200px,1fr)_2fr]">
          <div className="rounded-lg border border-line bg-surface p-3">{diagram}</div>
          {steps}
        </div>
        {screen}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-semibold">User flow: {flow.title}</h3>
        <div className="mt-2 rounded-lg border border-line bg-surface p-2">{diagram}</div>
      </div>
      {steps}
      {screen}
    </div>
  );
}

/** What the row says while there is no drawing: none yet, Oracle drawing it (its stages, a
 * bar, when it started), or Oracle could not draw it. */
function NoDrawing({ v, busy, onAsk, phone }: { v: Visual; busy: boolean; onAsk: () => void; phone?: boolean }) {
  const zone = useCompanyZone();
  if (v.pending) {
    const stages = [`Read ${v.subject_name || "the PRD"}`, "Draw the steps", "Draw the screen"];
    const at = Math.min(stages.length - 1, Math.max(0, v.stage ?? 0));
    return (
      <div className="space-y-2" data-testid="flow-empty" data-state="drawing">
        <p className="font-semibold">Oracle is drawing the flow</p>
        <ol className={`flex flex-wrap gap-x-2 gap-y-1 ${phone ? "flex-col" : ""}`} aria-label="Stages">
          {stages.map((s, i) => (
            <li key={s} className={i === at ? "font-semibold text-accent-ink" : i < at ? "text-text" : "text-text2"} aria-current={i === at ? "step" : undefined}>
              {i > 0 && !phone ? <span aria-hidden className="mr-2 text-text2">→</span> : null}
              {s}
            </li>
          ))}
        </ol>
        <div role="progressbar" aria-label="Drawing" aria-valuemin={0} aria-valuemax={stages.length} aria-valuenow={at + 1} className="h-2 w-full overflow-hidden rounded-full bg-surface2">
          <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${((at + 1) / (stages.length + 1)) * 100}%` }} />
        </div>
        <p className="text-[length:var(--simple-small)] text-text2">
          Updates here by itself; you can close the card.
          {v.started_at ? ` Started ${formatInZone(v.started_at, zone, { hour: "numeric", minute: "2-digit" })}.` : ""}
        </p>
      </div>
    );
  }
  if (v.failed) {
    return (
      <div className="space-y-2" data-testid="flow-empty" data-state="failed">
        <p className="text-danger">Oracle could not draw this flow. Nothing changed on the item.</p>
        {v.can_revise && (
          <Button onClick={onAsk} disabled={busy}>
            Retry
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-2" data-testid="flow-empty" data-state="none">
      <p className="font-semibold">No flow yet</p>
      {v.can_revise ? (
        <>
          <p className="text-[length:var(--simple-small)] text-text2">Oracle draws the steps and the screen they touch, from the PRD.</p>
          <Button onClick={onAsk} disabled={busy}>
            Ask Oracle to draw it
          </Button>
        </>
      ) : (
        <p className="text-[length:var(--simple-small)] text-text2">Oracle has not drawn a user flow or a screen for this yet.</p>
      )}
    </div>
  );
}

/** "6 steps · 1 screen · version 1 · drawn 7:04 PM" (the time in the company's zone). */
export function flowMeta(flow: Flow, zone: string): string {
  const n = flow.nodes?.length || flow.steps.length;
  const parts = [`${n} step${n === 1 ? "" : "s"}`, flow.touches_screen ? "1 screen" : "no screen", `version ${flow.version}`];
  if (flow.made_at) parts.push(`drawn ${formatInZone(flow.made_at, zone, { hour: "numeric", minute: "2-digit" })}`);
  return parts.join(" · ");
}

/**
 * Simple S10 (D26): a proposal's visual in its widened card. The newest drawing with its
 * history (older versions open read-only), the comments, a comment box for commenters and
 * up, Revise for who changes the subject directly (Oracle redraws it as the next version),
 * "Ask Oracle to draw it" when there is none, and Full screen (for a meeting or a
 * presentation). What a reader may do comes from the API's can_* fields. A one-pager bet
 * line names its PRD (`documentId`): the API looks the bet up on that page. While Oracle
 * draws (the simple_visual job), the panel says so and reads again until the drawing lands.
 */
export function FlowPanel({
  subject,
  documentId,
  onClose,
  onDrawn,
  row = false,
  openLabel = "Open the flow",
  onOpenChange,
}: {
  subject: FlowSubject;
  documentId?: string;
  onClose?: () => void;
  onDrawn?: (flow: Flow) => void;
  /** The owner's pick A: start as the row (the live thumbnail and its states), "Open the flow" spreads it. */
  row?: boolean;
  /** The row thumbnail's name (a roadmap card's: "Open the item's flow"). */
  openLabel?: string;
  /** The row was opened or closed (a card widens for the opened view). */
  onOpenChange?: (open: boolean) => void;
}) {
  const zone = useCompanyZone();
  const phone = usePhone();
  const [opened, setOpened] = useState(!row);
  const [view, setView] = useState<"diagram" | "storyboard">("diagram");
  // A drawing this row watched land (it was drawing, now it is drawn) carries "New".
  const [fresh, setFresh] = useState(false);
  const sawPending = useRef(false);
  const onOpenRef = useRef(onOpenChange);
  useEffect(() => {
    onOpenRef.current = onOpenChange;
  });
  useEffect(() => {
    if (row) onOpenRef.current?.(opened);
  }, [row, opened]);
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
    if (sawPending.current) {
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
  const [full, setFull] = useState(false);
  const [text, setText] = useState("");
  const [on, setOn] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!full) return;
    // Escape leaves the viewer only: caught first, so the card under it stays open.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setFull(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [full]);

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

  const body = (big: boolean) =>
    flow ? (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-[length:var(--simple-small)]">
          <span data-testid="flow-version" className="font-semibold">
            Version {flow.version} of {v.versions.length}
            {shown !== null ? " (an older version)" : ""}
          </span>
          {v.pending && <span className="text-text2" data-testid="flow-pending">Oracle is drawing the next version…</span>}
          {!v.pending && v.failed && shown === null && (
            <span className="text-danger" data-testid="flow-failed">
              Oracle could not draw the next version.{" "}
              {v.can_revise && (
                <button type="button" className="underline" disabled={busy} onClick={() => void retry()}>
                  Retry
                </button>
              )}
            </span>
          )}
          {v.versions.length > 1 && (
            <label className="flex items-center gap-1">
              <span className="text-text2">History</span>
              <select aria-label="Version" value={flow.version} onChange={(e) => void openVersion(Number(e.target.value))} className="rounded border border-line bg-surface px-1 py-0.5">
                {v.versions.map((x) => (
                  <option key={x.number} value={x.number}>
                    Version {x.number}
                    {x.addressed ? ` · ${x.addressed} comment${x.addressed === 1 ? "" : "s"} addressed` : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          <span className="flex-1" />
          <ViewSwitch value={view} onChange={setView} />
          {!big && (
            <Button variant="ghost" onClick={() => setFull(true)}>
              Full screen
            </Button>
          )}
        </div>
        {view === "storyboard" ? <FlowStoryboard flow={flow} phone={phone} /> : <Drawing flow={flow} big={big} phone={phone} />}
        <section aria-label="Comments on the flow" className="border-t border-line pt-2">
          <h3 className="font-semibold">Comments</h3>
          {v.comments.length === 0 ? (
            <p className="text-[length:var(--simple-small)] text-text2">No comments yet.</p>
          ) : (
            <ul className="mt-1 space-y-1 text-[length:var(--simple-small)]" data-testid="flow-comments">
              {v.comments.map((c) => (
                <li key={c.id}>
                  <span className="font-semibold">{c.by_name}</span>
                  {c.annotation ? ` on note ${c.annotation}` : ""}: {c.body}{" "}
                  <span className="text-text2">{c.addressed_in ? `· addressed in version ${c.addressed_in}` : "· open"}</span>
                </li>
              ))}
            </ul>
          )}
          {v.can_comment && shown === null && (
            <form
              className="mt-2 flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (text.trim()) void comment();
              }}
            >
              <label className="min-w-0 flex-1">
                <span className="sr-only">Comment on the flow</span>
                <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="What should change?" aria-label="Comment on the flow" className="w-full rounded border border-line bg-surface p-2" />
              </label>
              {(flow.annotations?.length ?? 0) > 0 && (
                <select aria-label="On annotation" value={on} onChange={(e) => setOn(e.target.value)} className="rounded border border-line bg-surface px-1 py-1">
                  <option value="">The whole flow</option>
                  {flow.annotations!.map((a) => (
                    <option key={a.n} value={a.n}>
                      Note {a.n}
                    </option>
                  ))}
                </select>
              )}
              <Button type="submit" disabled={busy || !text.trim()}>
                Comment
              </Button>
            </form>
          )}
          {v.can_revise && shown === null && (
            <div className="mt-2 flex items-center gap-2">
              <Button variant="primary" disabled={busy || v.pending || open.length === 0} onClick={() => void revise()}>
                Revise
              </Button>
              <span className="text-[length:var(--simple-small)] text-text2">
                {open.length ? `Oracle redraws it from ${open.length} open comment${open.length === 1 ? "" : "s"} as a new version.` : "Comment first: Oracle revises from the comments."}
              </span>
            </div>
          )}
        </section>
      </div>
    ) : (
      <NoDrawing v={v} busy={busy} onAsk={() => void ask()} phone={phone} />
    );

  // The owner's pick C: the viewer over the page; Escape or Exit full screen goes back.
  const fullView = (f: Flow) => (
    <div role="dialog" aria-modal="true" aria-label={`Full screen: ${f.title}`} data-testid="flow-fullscreen" className="fixed inset-0 z-[60] overflow-auto bg-surface p-4 sm:p-8">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 text-xl font-semibold break-words">{f.title}</h2>
        <Button onClick={() => setFull(false)}>Exit full screen</Button>
      </div>
      {body(true)}
    </div>
  );

  const rowView = v.flow ? (
    <div className="flex flex-wrap items-center gap-3" data-testid="flow-row-drawn">
      <button type="button" aria-label={openLabel} aria-expanded={opened} data-testid="flow-row-thumb" onClick={() => setOpened((o) => !o)} className="flex-none rounded-md border border-line bg-surface p-1 hover:border-line-strong">
        <FlowDiagram flow={v.flow} layout="mini" />
      </button>
      <div className="min-w-[12rem] flex-1">
        <p className="font-semibold break-words">
          {v.flow.title}
          {fresh && (
            <span className="ml-2 inline-block rounded-full bg-accent-soft px-2 align-middle text-[length:var(--simple-small)] font-semibold text-accent-ink" data-testid="flow-new">
              New
            </span>
          )}
        </p>
        <p className="text-[length:var(--simple-small)] text-text2" data-testid="flow-meta">
          {flowMeta(v.flow, zone)}
        </p>
        {v.pending && (
          <p className="text-[length:var(--simple-small)] text-text2" data-testid="flow-pending">
            Oracle is drawing the next version…
          </p>
        )}
      </div>
      {!opened && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setOpened(true)}>Open the flow</Button>
          <Button variant="ghost" onClick={() => setFull(true)}>
            Full screen
          </Button>
        </div>
      )}
    </div>
  ) : (
    <NoDrawing v={v} busy={busy} onAsk={() => void ask()} phone={phone} />
  );

  if (row) {
    return (
      <section data-testid="flow-row" aria-label="Flow" className="mt-1">
        {rowView}
        {opened && flow && (
          <div data-testid="flow-detail" className="mt-3 rounded-lg border border-line p-3 sm:p-4">
            {body(false)}
            <Button variant="ghost" className="mt-2" onClick={() => setOpened(false)}>
              Close the flow
            </Button>
          </div>
        )}
        {error && <p className="mt-2 text-[length:var(--simple-small)] text-danger">{error}</p>}
        {full && flow && fullView(flow)}
      </section>
    );
  }

  return (
    <section data-testid="flow-detail" className="mt-3 rounded-lg border border-dashed border-line-strong p-4">
      {body(false)}
      {error && <p className="mt-2 text-[length:var(--simple-small)] text-danger">{error}</p>}
      {onClose && (
        <Button variant="ghost" className="mt-2" onClick={onClose}>
          Close the flow
        </Button>
      )}
      {full && flow && fullView(flow)}
    </section>
  );
}

/** A flow's live thumbnail: its real shapes (boxes, decision diamonds, step numbers). */
export function FlowMini({ flow }: { flow: { nodes?: Flow["nodes"] | null; steps: string[] } }) {
  // A line's thumbnail stays narrow: the line's words keep the room.
  return <FlowDiagram flow={flow} layout="mini" className="block h-auto w-20 text-text" />;
}
