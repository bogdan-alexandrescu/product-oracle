"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { usePolling } from "@/components/JobsPanel";
import { Button, Chip, InfoTip } from "@/components/ds";
import { FIELD_LABEL, InlineError, TEXTAREA } from "@/components/review/parts";
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
      <Button variant="ghost" icon="flag" onClick={() => setOpen(true)} aria-label={`Refine section ${heading}`}>
        Refine section
      </Button>
    );
  }

  return (
    <div className="mt-3 w-full rounded-button border border-line bg-surface2 px-3 py-2.5 text-left" data-testid="refine-panel">
      <div className="flex items-center gap-2">
        <p className="min-w-0 truncate font-semibold text-text">Refine “{heading}”</p>
        <InfoTip label="refining a section" align="start">
          Oracle revises this one section from the accepted suggestions on it and your instruction, keeping its id; you
          review a diff and accept it as the next version.
        </InfoTip>
        <Button variant="ghost" className="ml-auto" onClick={reset}>
          Close
        </Button>
      </div>
      {!job && (
        <div className="mt-2 flex flex-col gap-2.5">
          {(accepted.data ?? []).length > 0 ? (
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1 text-[13px] font-semibold tracking-[0.02em] text-text2">Accepted suggestions</legend>
              {accepted.data!.map((s) => (
                <label key={s.id} className="flex items-start gap-2 text-sm leading-5 text-text">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 accent-[var(--accent)]"
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
            <p className="text-sm text-text2">No accepted suggestions on this section; give Oracle an instruction.</p>
          )}
          <label className={FIELD_LABEL}>
            Instruction (optional)
            <textarea rows={2} value={instruction} onChange={(e) => setInstruction(e.target.value)} className={TEXTAREA} />
          </label>
          <div>
            <Button variant="solid" disabled={busy || (chosen.size === 0 && !instruction.trim())} onClick={refine}>
              Refine
            </Button>
          </div>
        </div>
      )}
      {job && job.status !== "succeeded" && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm" data-testid="refine-status">
          <Chip kind={job.status === "failed" ? "crit" : job.status === "cancelled" ? "na" : "acc"} dot>
            {JOB_STATUS_LABEL[job.status]}
          </Chip>
          {running && <span className="text-text2">Oracle is revising the section.</span>}
          {job.status === "failed" && (
            <p className="basis-full font-medium text-crit">
              {job.error} {job.error_reason && NO_ACCOUNT_REASON[job.error_reason]}
            </p>
          )}
        </div>
      )}
      {preview && (
        <div className="mt-2 flex flex-col gap-2" data-testid="refine-preview">
          <p className="font-mono text-[13px] font-medium text-text2">Preview · #{preview.section_key}</p>
          <p className="rounded-lg border border-line bg-surface px-2.5 py-2 text-sm leading-6 whitespace-pre-wrap text-text">
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
            <label className={FIELD_LABEL}>
              Your edit of the section body
              <textarea rows={6} value={edit} onChange={(e) => setEdit(e.target.value)} className={TEXTAREA} />
            </label>
          )}
          <div className="flex flex-wrap gap-1.5">
            <Button variant="solid" icon="check" disabled={busy} onClick={apply}>
              Accept as next version
            </Button>
            {edit == null && <Button onClick={() => setEdit(preview.body_md)}>Edit first</Button>}
            <Button variant="ghost" onClick={reset}>
              Discard
            </Button>
          </div>
        </div>
      )}
      {error && <InlineError>{error}</InlineError>}
    </div>
  );
}
