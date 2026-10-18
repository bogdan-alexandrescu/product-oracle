"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { Button, ErrorNote, Loading } from "@/components/ui";
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

  // A flow that reads an approved document (prd_to_roadmap) starts from the Roadmap screen,
  // where the PRD is picked; this dialog offers the others.
  const flows = useMemo(() => catalog.data?.flows.filter((f) => !f.source_kind) ?? [], [catalog.data]);
  const flow = flows.find((f) => f.key === flowKey);

  // Choices on top of the flow's defaults; a new flow starts from its defaults again.
  const segmentRoles = (s: Flow["segments"][number]) => roles[s.name] ?? s.roles;
  const selectFlow = (key: Flow["key"]) => {
    setFlowKey(key);
    setRoles({});
    setCheckpoints({});
    setEstimate(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
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
        draft && draft.flow === flowKey
          ? await unwrap(api.PATCH("/v1/runs/{run_id}", { params: { path: { run_id: draft.id } }, body }))
          : await unwrap(api.POST("/v1/runs", { body: { flow: flowKey, ...body } }));
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
  const inputCls = "w-full rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm focus:border-neutral-500 focus:outline-none";

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-neutral-900/30 px-4 py-10">
      <div role="dialog" aria-modal="true" aria-labelledby="new-run-title" className="w-full max-w-2xl rounded-lg border border-neutral-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-3">
          <h2 id="new-run-title" className="text-base font-semibold text-neutral-900">
            New run
          </h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            ✕
          </Button>
        </div>
        <div className="space-y-5 px-5 py-4 text-sm">
          {catalog.error && <ErrorNote>{catalog.error}</ErrorNote>}
          {!catalog.data && !catalog.error && <Loading />}
          {catalog.data && flow && (
            <>
              <RunsWhere runtime={catalog.data.runtime} />
              {catalog.data.runtime_notes.length > 0 && (
                <ul className="space-y-1 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900" data-testid="runtime-notes">
                  {catalog.data.runtime_notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
              <fieldset>
                <legend className="mb-1.5 font-medium text-neutral-800">Flow</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {flows.map((f) => (
                    <label
                      key={f.key}
                      className={`cursor-pointer rounded-md border px-3 py-2 ${f.key === flowKey ? "border-neutral-900 bg-neutral-50" : "border-neutral-200"}`}
                    >
                      <input
                        type="radio"
                        name="flow"
                        value={f.key}
                        checked={f.key === flowKey}
                        onChange={() => selectFlow(f.key)}
                        className="mr-2"
                      />
                      <span className="font-medium">{f.title}</span>
                      <span className="mt-0.5 block text-xs text-neutral-500">{f.description}</span>
                    </label>
                  ))}
                </div>
                {catalog.data.flows.some((f) => f.source_kind) && (
                  <p className="mt-1.5 text-xs text-neutral-500" data-testid="roadmap-flow-note">
                    A roadmap from an approved PRD starts from the{" "}
                    <Link href="/roadmap" className="underline underline-offset-2">
                      Roadmap
                    </Link>{" "}
                    screen.
                  </p>
                )}
              </fieldset>

              <label className="block">
                <span className="mb-1 block font-medium text-neutral-800">
                  {flow.requires_document ? "PRD or roadmap to revise" : "PRD document"}
                </span>
                {flow.requires_document ? (
                  <select className={inputCls} value={document} onChange={(e) => change(setDocument)(e.target.value)}>
                    <option value="">Choose a document…</option>
                    {docOptions.map((d) => (
                      <option key={d.id} value={d.slug}>
                        {d.title}
                        {d.kind === "roadmap" ? " (roadmap)" : ""}
                      </option>
                    ))}
                  </select>
                ) : (
                  <>
                    <input
                      className={inputCls}
                      list="run-documents"
                      placeholder="new-prd-slug or an existing document"
                      value={document}
                      onChange={(e) => change(setDocument)(e.target.value)}
                    />
                    <datalist id="run-documents">
                      {docOptions.filter((d) => d.kind === "prd").map((d) => (
                        <option key={d.id} value={d.slug}>
                          {d.title}
                        </option>
                      ))}
                    </datalist>
                    <span className="mt-1 block text-xs text-neutral-500">A new slug creates the document when the draft is imported.</span>
                  </>
                )}
              </label>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block font-medium text-neutral-800">Depth</span>
                  <select className={inputCls} value={depth} onChange={(e) => change(setDepth)(e.target.value as Depth)}>
                    {Object.entries(catalog.data.depths).map(([k, mult]) => (
                      <option key={k} value={k}>
                        {k} (×{mult})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block font-medium text-neutral-800">Budget (USD, optional)</span>
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
                <legend className="mb-1.5 font-medium text-neutral-800">Segments, agent roles and checkpoints</legend>
                <ol className="divide-y divide-neutral-200 rounded-md border border-neutral-200">
                  {flow.segments.map((s, i) => (
                    <li key={s.name} className="space-y-2 px-3 py-2.5">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-medium text-neutral-900">
                          {i + 1}. {s.title}
                        </span>
                        <label className="flex items-center gap-1.5 text-xs text-neutral-700">
                          <input
                            type="checkbox"
                            checked={checkpoints[s.checkpoint] ?? true}
                            onChange={(e) => change(setCheckpoints)({ ...checkpoints, [s.checkpoint]: e.target.checked })}
                            aria-label={`Stop for ${CHECKPOINT_LABEL[s.checkpoint]}`}
                          />
                          Stop for {CHECKPOINT_LABEL[s.checkpoint].toLowerCase()}
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
                              className={`rounded-full border px-2 py-0.5 text-xs ${on ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-300 text-neutral-600 hover:bg-neutral-50"}`}
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
        <div className="flex justify-end gap-2 border-t border-neutral-200 px-5 py-3">
          <Button onClick={onClose}>Cancel</Button>
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
