"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { Button, Icon, InfoTip } from "@/components/ds";
import { ErrorNote, INPUT, Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage, useQuery } from "@/lib/use-query";

import { CHECKPOINT_LABEL, EstimateSummary, RunsWhere, usd, type EstimateOut, type FlowCatalog } from "./_lib";

type Flow = FlowCatalog["flows"][number];
type Depth = "quick" | "standard" | "deep";

/** Pick a flow and its knobs, see the estimate, then start the run. */
export function NewRunDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const catalog = useQuery("flows", () => unwrap(api.GET("/v1/flows")));
  const documents = useQuery("documents", () => unwrap(api.GET("/v1/documents")));

  const [flowKey, setFlowKey] = useState<Flow["key"]>("baseline_to_prd");
  const [document, setDocument] = useState("");
  const [depth, setDepth] = useState<Depth>("standard");
  const [roles, setRoles] = useState<Record<string, string[]>>({});
  const [checkpoints, setCheckpoints] = useState<Record<string, boolean>>({});
  const [budget, setBudget] = useState("");
  const [draft, setDraft] = useState<{ id: string; flow: Flow["key"] } | null>(null);
  const [estimate, setEstimate] = useState<EstimateOut | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // D12: the catalog's one rule says which flows this dialog offers; a flow with its own
  // door elsewhere (Build next draft, Plan › Roadmap documents, a launch) is a pointer line
  // instead.
  const flows = useMemo(() => catalog.data?.flows.filter((f) => f.in_new_run_dialog) ?? [], [catalog.data]);
  const pointers = useMemo(() => catalog.data?.flows.filter((f) => f.starts_from) ?? [], [catalog.data]);
  const flow = flows.find((f) => f.key === flowKey) ?? flows[0];

  // Choices on top of the flow's defaults; a new flow starts from its defaults again.
  const segmentRoles = (s: Flow["segments"][number]) => roles[s.name] ?? s.roles;
  const selectFlow = (key: Flow["key"]) => {
    setFlowKey(key);
    setRoles({});
    setCheckpoints({});
    setEstimate(null);
  };

  useEffect(() => {
    // A field that handled Escape itself (closing its suggestions) marks it handled.
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const knobs = useMemo(
    () => ({
      depth,
      roles: Object.fromEntries((flow?.segments ?? []).map((s) => [s.name, roles[s.name] ?? s.roles])),
      checkpoints: Object.fromEntries((flow?.segments ?? []).map((s) => [s.checkpoint, checkpoints[s.checkpoint] ?? true])),
      budget_usd: budget.trim() ? Number(budget) : null,
    }),
    [flow, depth, roles, checkpoints, budget],
  );

  const change = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setEstimate(null);
  };

  const toggleRole = (s: Flow["segments"][number], role: string) => {
    const current = segmentRoles(s);
    change(setRoles)({
      ...roles,
      [s.name]: current.includes(role) ? current.filter((r) => r !== role) : [...current, role],
    });
  };

  async function runEstimate() {
    setBusy(true);
    setError(null);
    try {
      const body = { document: document.trim() || null, knobs };
      // A draft's flow is fixed: a different flow gets a fresh draft.
      const run =
        draft && draft.flow === flow?.key
          ? await unwrap(api.PATCH("/v1/runs/{run_id}", { params: { path: { run_id: draft.id } }, body }))
          : await unwrap(api.POST("/v1/runs", { body: { flow: flow!.key, ...body } }));
      setDraft({ id: run.id, flow: run.flow });
      setEstimate(await unwrap(api.POST("/v1/runs/{run_id}/estimate", { params: { path: { run_id: run.id } } })));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      await unwrap(api.POST("/v1/runs/{run_id}/start", { params: { path: { run_id: draft.id } } }));
      router.push(`/runs/${draft.id}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  const docOptions = documents.data ?? [];
  const inputCls = `${INPUT} h-10 placeholder:text-text2`;
  const legendCls = "mb-1.5 flex items-center gap-1.5 text-[13px] font-semibold tracking-[0.02em] text-text2";

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-hero/50 px-4 py-10 max-[600px]:px-2 max-[600px]:py-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-run-title"
        className="w-full max-w-2xl min-w-0 rounded-inspector border border-line bg-surface text-text shadow-tip"
      >
        <div className="flex min-h-14 items-center gap-2 border-b border-line px-5 max-[600px]:px-4">
          <h2 id="new-run-title" className="font-display text-xl font-bold tracking-heading">
            {catalog.data && !flows.length ? "Start a run" : "New run"}
          </h2>
          {catalog.data && (
            <InfoTip label="where runs execute" align="start" side="bottom">
              <RunsWhere runtime={catalog.data.runtime} />
            </InfoTip>
          )}
          <span className="flex-1" />
          <Button variant="ghost" icon="x" onClick={onClose} aria-label="Close" />
        </div>
        <div className="space-y-5 px-5 py-4 text-[15px] max-[600px]:px-4">
          {catalog.error && <ErrorNote>{catalog.error}</ErrorNote>}
          {!catalog.data && !catalog.error && <Loading />}
          {catalog.data && !flow && <FlowPointers flows={pointers} />}
          {catalog.data && flow && (
            <>
              {catalog.data.runtime_notes.length > 0 && (
                <ul className="space-y-1 rounded-button bg-accent-soft px-3 py-2 text-sm text-accent-ink" data-testid="runtime-notes">
                  {catalog.data.runtime_notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
              <fieldset>
                <legend className={legendCls}>Flow</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {flows.map((f) => (
                    <label
                      key={f.key}
                      className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-button border px-3 py-2 ${
                        f.key === flow.key ? "border-accent bg-accent-soft shadow-[inset_0_0_0_1px_var(--accent)]" : "border-line-strong hover:bg-surface2"
                      }`}
                    >
                      <input
                        type="radio"
                        name="flow"
                        value={f.key}
                        checked={f.key === flow.key}
                        onChange={() => selectFlow(f.key)}
                        className="accent-[var(--accent)]"
                      />
                      <span className="min-w-0 flex-1 truncate font-semibold">{f.title}</span>
                      <InfoTip label={f.title}>{f.description}</InfoTip>
                    </label>
                  ))}
                </div>
                <FlowPointers flows={pointers} />
              </fieldset>

              <div>
                <span id="run-document-label" className={legendCls}>
                  {flow.requires_document ? "PRD or roadmap to revise" : "PRD document"}
                </span>
                {flow.requires_document ? (
                  <select
                    aria-labelledby="run-document-label"
                    className={inputCls}
                    value={document}
                    onChange={(e) => change(setDocument)(e.target.value)}
                  >
                    <option value="">Choose a document…</option>
                    {docOptions.map((d) => (
                      <option key={d.id} value={d.slug}>
                        {d.title}
                        {d.kind === "roadmap" ? " (roadmap)" : ""}
                      </option>
                    ))}
                  </select>
                ) : (
                  <DocumentField
                    className={inputCls}
                    value={document}
                    onChange={change(setDocument)}
                    options={docOptions.filter((d) => d.kind === "prd")}
                  />
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className={legendCls}>Depth</span>
                  <select className={inputCls} value={depth} onChange={(e) => change(setDepth)(e.target.value as Depth)}>
                    {Object.entries(catalog.data.depths).map(([k, mult]) => (
                      <option key={k} value={k}>
                        {k} (×{mult})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className={legendCls}>Budget (USD)</span>
                  <input
                    className={inputCls}
                    type="number"
                    min="1"
                    step="1"
                    placeholder="No cap"
                    value={budget}
                    onChange={(e) => change(setBudget)(e.target.value)}
                  />
                </label>
              </div>

              <fieldset>
                <legend className={legendCls}>
                  Segments
                  <InfoTip label="segments" align="start">
                    Each segment runs the agent roles picked here, then stops for its checkpoint if it is on.
                  </InfoTip>
                </legend>
                <ol className="divide-y divide-line rounded-panel border border-line">
                  {flow.segments.map((s, i) => (
                    <li key={s.name} className="space-y-2 px-3 py-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                        <span className="min-w-0 truncate font-semibold">
                          <span className="tnum">{i + 1}</span>. {s.title}
                        </span>
                        <label className="flex items-center gap-1.5 text-sm text-text2">
                          <input
                            type="checkbox"
                            className="size-4 accent-[var(--accent)]"
                            checked={checkpoints[s.checkpoint] ?? true}
                            onChange={(e) => change(setCheckpoints)({ ...checkpoints, [s.checkpoint]: e.target.checked })}
                            aria-label={`Stop for ${CHECKPOINT_LABEL[s.checkpoint]}`}
                          />
                          <Icon name="flag" size={16} />
                          <span className="max-w-56 truncate">{CHECKPOINT_LABEL[s.checkpoint]}</span>
                        </label>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {catalog.data!.roles.map((r) => {
                          const on = segmentRoles(s).includes(r.key);
                          return (
                            <button
                              type="button"
                              key={r.key}
                              aria-pressed={on}
                              title={`${r.description} · ${usd(r.base_usd)} at standard depth`}
                              onClick={() => toggleRole(s, r.key)}
                              className={`inline-flex h-7 items-center rounded-full border px-2.5 text-[13px] font-semibold ${
                                on ? "border-accent bg-accent text-on-accent" : "border-line-strong text-text2 hover:bg-surface2"
                              }`}
                            >
                              {r.title}
                            </button>
                          );
                        })}
                      </div>
                    </li>
                  ))}
                </ol>
              </fieldset>

              {estimate && <EstimateSummary estimate={estimate} />}
              {error && <ErrorNote>{error}</ErrorNote>}
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3 max-[600px]:px-4">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={runEstimate} disabled={busy || !flow}>
            {estimate ? "Re-estimate" : "Estimate"}
          </Button>
          <Button variant="primary" onClick={start} disabled={busy || !estimate || !estimate.within_budget}>
            {estimate?.needs_approval ? "Ask an owner to approve" : "Start run"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Where the flows with their own door start: one line each, linked when there is a screen. */
function FlowPointers({ flows }: { flows: Flow[] }) {
  if (!flows.length) return null;
  return (
    <ul className="mt-2 space-y-1 text-sm text-text2" data-testid="flow-pointers">
      {flows.map((f) => {
        const start = f.starts_from!;
        return (
          <li key={f.key} className="flex items-center gap-1.5" data-testid="flow-pointer">
            {start.href ? (
              <Link href={start.href} className="font-semibold text-accent-ink underline-offset-2 hover:underline">
                {start.label}
              </Link>
            ) : (
              <span>{start.label}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

type DocOption = { id: string; slug: string; title: string };

/** A new slug or an existing PRD, with its own suggestion list: Escape closes the list first. */
function DocumentField({
  className,
  value,
  onChange,
  options,
}: {
  className: string;
  value: string;
  onChange: (v: string) => void;
  options: DocOption[];
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const q = value.trim().toLowerCase();
  const matches = options
    .filter((d) => d.slug !== value && (d.slug.toLowerCase().includes(q) || d.title.toLowerCase().includes(q)))
    .slice(0, 8);
  const shown = open && matches.length > 0;

  const pick = (slug: string) => {
    onChange(slug);
    setOpen(false);
    setActive(-1);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape" && shown) {
      e.preventDefault();
      setOpen(false);
      setActive(-1);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!shown) return setOpen(true);
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => (a + step + matches.length) % matches.length);
    } else if (e.key === "Enter" && shown && active >= 0 && matches[active]) {
      e.preventDefault();
      pick(matches[active].slug);
    }
  };

  return (
    <div className="relative">
      <input
        role="combobox"
        aria-labelledby="run-document-label"
        aria-describedby="run-document-hint"
        aria-autocomplete="list"
        aria-expanded={shown}
        aria-controls="run-documents"
        aria-activedescendant={shown && active >= 0 ? `run-document-${active}` : undefined}
        autoComplete="off"
        className={className}
        placeholder="new-prd-slug or an existing document"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {shown && (
        <ul
          id="run-documents"
          role="listbox"
          aria-label="Document suggestions"
          className="absolute inset-x-0 top-full z-10 mt-1 max-h-56 overflow-y-auto rounded-inspector border border-line bg-surface py-1 shadow-tip"
        >
          {matches.map((d, i) => (
            <li
              key={d.id}
              id={`run-document-${i}`}
              role="option"
              aria-selected={i === active}
              className={`flex min-w-0 cursor-pointer items-baseline gap-2 px-3 py-1.5 ${i === active ? "bg-surface2" : "hover:bg-surface2"}`}
              // Keep focus in the field so the click lands before blur closes the list.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(d.slug)}
            >
              <span className="truncate font-semibold">{d.slug}</span>
              <span className="truncate text-text2">{d.title}</span>
            </li>
          ))}
        </ul>
      )}
      <span id="run-document-hint" className="sr-only">
        A new slug creates the document when the draft is imported.
      </span>
    </div>
  );
}
