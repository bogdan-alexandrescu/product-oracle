"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { usePolling } from "@/components/JobsPanel";
import { Button, INPUT } from "@/components/ui";
import { api, unwrap, type LlmJob, type RefinementPreview } from "@/lib/api/client";
import { JOB_STATUS_LABEL, NO_ACCOUNT_REASON } from "@/lib/format";
import { useQuery } from "@/lib/use-query";

/**
 * An approver's "Refine section": Oracle revises this one section from the accepted
 * suggestions on it (and/or an instruction), keeping its id and the house rules (no
 * evidence in the body), shows a diff preview, and on accept imports it as the next
 * version with the feedback resolutions recorded.
 */
export function RefineSection({ doc, n, sectionKey, heading }: { doc: string; n: number; sectionKey: string; heading: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [job, setJob] = useState<LlmJob | null>(null);
  const [preview, setPreview] = useState<RefinementPreview | null>(null);
  const [edit, setEdit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accepted = useQuery(`accepted|${doc}|${sectionKey}|${open}`, () =>
    open
      ? unwrap(
          api.GET("/v1/documents/{doc}/suggestions", {
            params: { path: { doc }, query: { status: "accepted", section_key: sectionKey } },
          }),
        ).then((rows) => rows.filter((s) => s.kind === "section_text"))
      : Promise.resolve([]),
  );
  const chosen = picked ?? new Set((accepted.data ?? []).map((s) => s.id));

  const running = job?.status === "queued" || job?.status === "running";
  usePolling(running, async () => {
    if (!job) return;
    setJob(await unwrap(api.GET("/v1/llm-jobs/{job_id}", { params: { path: { job_id: job.id } } })));
  });
  useEffect(() => {
    if (job?.status !== "succeeded" || preview) return;
    unwrap(api.GET("/v1/llm-jobs/{job_id}/preview", { params: { path: { job_id: job.id } } }))
      .then(setPreview)
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load the preview."));
  }, [job, preview]);

  function reset() {
    setOpen(false);
    setJob(null);
    setPreview(null);
    setEdit(null);
    setPicked(null);
    setInstruction("");
    setError(null);
  }

  async function refine() {
    setBusy(true);
    setError(null);
    try {
      const j = await unwrap(
        api.POST("/v1/documents/{doc}/versions/{n}/sections/{key}/refine", {
          params: { path: { doc, n, key: sectionKey } },
          body: { suggestion_ids: [...chosen], instruction: instruction.trim() || null },
        }),
      );
      setJob(j);
      setPreview(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the refinement.");
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!job) return;
    setBusy(true);
    setError(null);
    try {
      const v = await unwrap(
        api.POST("/v1/llm-jobs/{job_id}/apply", {
          params: { path: { job_id: job.id } },
          body: edit != null ? { body_md: edit } : {},
        }),
      );
      reset();
      router.push(`/documents/${doc}/v/${v.number}#s-${sectionKey}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not accept the revision.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)} aria-label={`Refine section ${heading}`}>
        Refine section
      </Button>
    );
  }

  return (
    <div className="mt-3 rounded-md border border-violet-200 bg-violet-50/40 px-3 py-2 text-sm" data-testid="refine-panel">
      <div className="flex items-center gap-2">
        <p className="font-medium text-neutral-900">Refine “{heading}”</p>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={reset}>
          Close
        </Button>
      </div>
      {!job && (
        <div className="mt-2 flex flex-col gap-2">
          {(accepted.data ?? []).length > 0 ? (
            <fieldset className="flex flex-col gap-1">
              <legend className="text-xs text-neutral-600">Accepted suggestions to work in</legend>
              {accepted.data!.map((s) => (
                <label key={s.id} className="flex items-start gap-1.5 text-xs text-neutral-800">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={chosen.has(s.id)}
                    onChange={(e) => {
                      const next = new Set(chosen);
                      if (e.target.checked) next.add(s.id);
                      else next.delete(s.id);
                      setPicked(next);
                    }}
                  />
                  <span className="line-clamp-2">{s.edited_text ?? s.text}</span>
                </label>
              ))}
            </fieldset>
          ) : (
            <p className="text-xs text-neutral-600">No accepted suggestions on this section; give Oracle an instruction.</p>
          )}
          <label className="flex flex-col gap-1 text-xs text-neutral-600">
            Instruction (optional)
            <textarea rows={2} value={instruction} onChange={(e) => setInstruction(e.target.value)} className={INPUT} />
          </label>
          <div>
            <Button size="sm" variant="primary" disabled={busy || (chosen.size === 0 && !instruction.trim())} onClick={refine}>
              Refine
            </Button>
          </div>
        </div>
      )}
      {job && job.status !== "succeeded" && (
        <div className="mt-2 text-xs text-neutral-700" data-testid="refine-status">
          <p>
            {JOB_STATUS_LABEL[job.status]}
            {running && "… Oracle is revising the section."}
          </p>
          {job.status === "failed" && (
            <p className="mt-1 text-rose-800">
              {job.error} {job.error_reason && NO_ACCOUNT_REASON[job.error_reason]}
            </p>
          )}
        </div>
      )}
      {preview && (
        <div className="mt-2 flex flex-col gap-2" data-testid="refine-preview">
          <p className="text-xs text-neutral-600">
            Preview of #{preview.section_key}: other sections and approved sections stay as they are.
          </p>
          <p className="rounded border border-neutral-200 bg-white px-2 py-1.5 text-[13px] leading-6 whitespace-pre-wrap text-neutral-800">
            {preview.words.map((w, i) =>
              w.op === "insert" ? (
                <ins key={i} className="diff-ins">
                  {w.text}
                </ins>
              ) : w.op === "delete" ? (
                <del key={i} className="diff-del">
                  {w.text}
                </del>
              ) : (
                <span key={i}>{w.text}</span>
              ),
            )}
          </p>
          {edit != null && (
            <label className="flex flex-col gap-1 text-xs text-neutral-600">
              Your edit of the section body
              <textarea rows={6} value={edit} onChange={(e) => setEdit(e.target.value)} className={INPUT} />
            </label>
          )}
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="primary" disabled={busy} onClick={apply}>
              Accept as next version
            </Button>
            {edit == null && (
              <Button size="sm" onClick={() => setEdit(preview.body_md)}>
                Edit first
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={reset}>
              Discard
            </Button>
          </div>
        </div>
      )}
      {error && <p className="mt-1 text-xs text-rose-700">{error}</p>}
    </div>
  );
}
