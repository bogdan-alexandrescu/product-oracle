"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { usePolling } from "@/components/JobsPanel";
import { Button, Chip, InfoTip } from "@/components/ds";
import { FIELD_LABEL, InlineError, TEXTAREA } from "@/components/review/parts";
import { api, unwrap, type LlmJob, type RefinementPreview } from "@/lib/api/client";
import { failedAt, JOB_STATUS_LABEL, jobFailure } from "@/lib/format";
import { useQuery } from "@/lib/use-query";
import { sectionHref } from "@/lib/section-link";

/**
 * An approver's "Refine section": Oracle revises this one section from an instruction
 * (accepted suggestions are staged for the next draft instead, C1e), keeping its id and the house rules (no
 * evidence in the body), shows a diff preview, and on accept imports it as the next
 * version with the feedback resolutions recorded.
 */
export function RefineSection({
  doc,
  n,
  sectionKey,
  heading,
  defaultOpen = false,
  onClose,
}: {
  doc: string;
  n: number;
  sectionKey: string;
  heading: string;
  /** Start open (the caller offers its own "Refine section", e.g. in a ⋯ menu). */
  defaultOpen?: boolean;
  /** The caller owns the open control: Close and Discard call this instead of showing the button again. */
  onClose?: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(defaultOpen);
  const [instruction, setInstruction] = useState("");
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
    setInstruction("");
    setError(null);
    onClose?.();
  }

  async function refine() {
    setBusy(true);
    setError(null);
    try {
      const j = await unwrap(
        api.POST("/v1/documents/{doc}/versions/{n}/sections/{key}/refine", {
          params: { path: { doc, n, key: sectionKey } },
          // C1e: accepted suggestions go into the next draft as one batch, not one section at a time.
          body: { suggestion_ids: [], instruction: instruction.trim() || null },
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
      router.push(sectionHref(doc, v.number, sectionKey));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not accept the revision.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    if (onClose) return null;
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
          Oracle revises this one section from your instruction, keeping its id; you review a diff and accept it as the
          next version. Accepted suggestions wait for Build draft.
        </InfoTip>
        <Button variant="ghost" className="ml-auto" onClick={reset}>
          Close
        </Button>
      </div>
      {!job && (
        <div className="mt-2 flex flex-col gap-2.5">
          {(accepted.data ?? []).length > 0 && (
            <p className="flex items-center gap-1.5 text-sm font-medium text-text2" data-testid="refine-staged">
              <Chip kind="now">{accepted.data!.length} staged</Chip>
              Build draft · page header
            </p>
          )}
          <label className={FIELD_LABEL}>
            Instruction
            <textarea rows={2} value={instruction} onChange={(e) => setInstruction(e.target.value)} className={TEXTAREA} />
          </label>
          <div>
            <Button variant="solid" disabled={busy || !instruction.trim()} onClick={refine}>
              Refine
            </Button>
          </div>
        </div>
      )}
      {job && job.status !== "succeeded" && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm" data-testid="refine-status">
          <Chip
            kind={job.status === "failed" ? "crit" : job.status === "cancelled" ? "na" : "acc"}
            dot
            data-testid={job.status === "failed" && job.finished_at ? "job-failed" : undefined}
          >
            {job.status === "failed" && job.finished_at ? failedAt(job.finished_at) : JOB_STATUS_LABEL[job.status]}
          </Chip>
          {running && <span className="text-text2">Oracle is revising the section.</span>}
          {job.status === "failed" && (
            <p className="basis-full font-medium text-crit">
              {jobFailure(job)}
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
