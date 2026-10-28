"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useQuery } from "@/lib/use-query";

type Flow = Schemas["SimpleFlow"];
type Visual = Schemas["SimpleVisualOut"];
export type FlowSubject = { kind: string; id: string };

/** The subject a flow is the visual of, when the API names it. */
export function subjectOf(flow: { subject_kind?: string | null; subject_id?: string | null } | null | undefined): FlowSubject | null {
  return flow?.subject_kind && flow.subject_id ? { kind: flow.subject_kind, id: flow.subject_id } : null;
}

const svgSrc = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** The drawing: the user flow (sanitised SVG shown as an image: nothing in it runs), the
 * steps in words (decision points, the feature of each, NEW/CHANGED versus today), and the
 * screen's low-fi wireframe in a sandboxed frame; the numbered annotations under it. */
function Drawing({ flow, big }: { flow: Flow; big?: boolean }) {
  return (
    <div className={`grid gap-4 ${big ? "lg:grid-cols-[3fr_2fr]" : "sm:grid-cols-2"}`}>
      <div>
        <h3 className="font-semibold">User flow: {flow.title}</h3>
        {flow.goal && <p className="text-[length:var(--simple-small)] text-text2" data-testid="flow-goal">Goal: {flow.goal}</p>}
        {flow.svg && (
          <div className="mt-2 overflow-x-auto rounded-lg border border-line bg-white p-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={svgSrc(flow.svg)} alt={`User flow: ${flow.steps.join(", then ")}`} data-testid="flow-svg" className={big ? "max-w-none" : "max-w-none h-28"} />
          </div>
        )}
        <ol className="mt-2 list-decimal pl-5" data-testid="flow-steps">
          {(flow.nodes?.length ? flow.nodes : flow.steps.map((s, i) => ({ id: `s${i + 1}`, label: s, kind: "step" as const, feature: null, change: "same" as const }))).map((s) => (
            <li key={s.id}>
              {s.kind === "decision" ? <span className="font-semibold">Decision: </span> : null}
              {s.label}
              {s.feature ? <span className="text-text2"> · {s.feature}</span> : null}
              {s.change !== "same" && (
                <span className="ml-1 rounded bg-accent-soft px-1 text-[length:var(--simple-small)] font-semibold text-accent-ink">{s.change === "new" ? "New" : "Changed"}</span>
              )}
            </li>
          ))}
        </ol>
      </div>
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
          <div aria-label={`Wireframe of ${flow.screen.title}`} role="img" className="mt-1 flex flex-col gap-1 rounded-lg border border-line-strong bg-surface p-2">
            {flow.screen.regions.map((r) => (
              <div key={r} className="rounded border border-dashed border-line-strong px-2 py-1 text-[length:var(--simple-small)] text-text2">
                {r}
              </div>
            ))}
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
    </div>
  );
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
export function FlowPanel({ subject, documentId, onClose, onDrawn }: { subject: FlowSubject; documentId?: string; onClose?: () => void; onDrawn?: (flow: Flow) => void }) {
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
    if (!drawnFlow || pending) return;
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
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFull(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
          {!big && (
            <Button variant="ghost" onClick={() => setFull(true)}>
              Full screen
            </Button>
          )}
        </div>
        <Drawing flow={flow} big={big} />
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
      <div className="space-y-2">
        <p data-testid="flow-empty">
          {v.pending
            ? "Oracle is drawing the user flow and the screen it touches…"
            : v.failed
              ? `Oracle could not draw the flow${v.failure ? `: ${v.failure}` : ""}.`
              : "No flow yet: Oracle has not drawn a user flow or a wireframe for this proposal."}
        </p>
        {v.can_revise && !v.pending && (
          <Button onClick={() => void ask()} disabled={busy}>
            {v.failed ? "Retry" : "Ask Oracle to draw it"}
          </Button>
        )}
      </div>
    );

  return (
    <section data-testid="flow-detail" className="mt-3 rounded-lg border border-dashed border-line-strong p-4">
      {body(false)}
      {error && <p className="mt-2 text-[length:var(--simple-small)] text-danger">{error}</p>}
      {onClose && (
        <Button variant="ghost" className="mt-2" onClick={onClose}>
          Close the flow
        </Button>
      )}
      {full && flow && (
        <div role="dialog" aria-modal="true" aria-label={`Full screen: ${flow.title}`} data-testid="flow-fullscreen" className="fixed inset-0 z-[60] overflow-auto bg-surface p-4 sm:p-8">
          <div className="mb-3 flex items-center gap-2">
            <h2 className="flex-1 text-xl font-semibold">{flow.title}</h2>
            <Button onClick={() => setFull(false)}>Exit full screen</Button>
          </div>
          {body(true)}
        </div>
      )}
    </section>
  );
}

/** A flow's thumbnail: as many boxes as it has steps (at most 4). */
export function FlowMini({ flow }: { flow: Pick<Flow, "steps"> }) {
  return (
    <svg width="64" height="40" viewBox="0 0 64 40" aria-hidden className="text-text2">
      {flow.steps.slice(0, 4).map((_, i) => (
        <g key={i}>
          <rect x={2 + i * 16} y={12} width={11} height={16} rx={2} fill="none" stroke="currentColor" />
          {i > 0 && <line x1={i * 16 - 3} y1={20} x2={i * 16 + 2} y2={20} stroke="currentColor" />}
        </g>
      ))}
    </svg>
  );
}
