"use client";

import { useEffect, useState } from "react";

import { Button, Empty, InfoTip } from "@/components/ds";
import { InlineError, JobStatusChip } from "@/components/review/parts";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type JobSettings, type LlmJob, type LlmJobKind } from "@/lib/api/client";
import { formatDateTime, formatUsd, jobFailure, JOB_KIND_LABEL, JOB_SETTING_LABEL, NO_ACCOUNT_REASON } from "@/lib/format";
import { useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

/** The #hash of History's fold of Oracle's work, which the overview's version inspector links to. */
export const ORACLE_WORK = "oracle-work";

const SETTINGS_EVENT = "po:llm-settings-changed";

/** Calls `fn` after an owner saves a document's switches on this page; returns the unsubscribe. */
export function onJobSettingsChanged(doc: string, fn: () => void): () => void {
  const listener = (e: Event) => {
    if ((e as CustomEvent<{ doc: string }>).detail.doc === doc) fn();
  };
  window.addEventListener(SETTINGS_EVENT, listener);
  return () => window.removeEventListener(SETTINGS_EVENT, listener);
}

/** Polls while any job is queued or running, so the panel shows the worker's progress. */
export function usePolling(active: boolean, reload: () => Promise<void>, ms = 1500) {
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void reload(), ms);
    return () => clearInterval(t);
  }, [active, reload, ms]);
}

/** The pool account a job ran on, or the company's fallback when no account was registered. */
function accountName(job: LlmJob): string {
  if (job.account_label) return job.account_label;
  return job.via?.startsWith("fallback") ? "Fallback (no pool account)" : "—";
}

function summary(job: LlmJob): string | null {
  const out = job.output as Record<string, unknown> | null;
  if (!out || job.status !== "succeeded") return null;
  if (job.kind === "review_comments") {
    const n = Number(out.handled ?? 0);
    if (!n) return String(out.note ?? "No new feedback to handle");
    const push = Number(out.pushbacks ?? 0);
    return `${n} feedback item${n === 1 ? "" : "s"} handled${push ? ` · ${push} pushback${push === 1 ? "" : "s"}` : ""}`;
  }
  if (job.kind === "reporting") return `Reports for v${job.version_number}`;
  if (out.applied_version) return `Accepted as v${out.applied_version}`;
  if (job.kind === "refinement_batch") {
    if (out.discarded_at) return "Discarded";
    const n = Array.isArray(out.sections) ? out.sections.length : 0;
    return `Draft v${(job.version_number ?? 0) + 1} ready to review · ${n} section${n === 1 ? "" : "s"}`;
  }
  return `Revision of #${job.section_key} ready to review`;
}

function JobRow({ job, onChanged }: { job: LlmJob; onChanged: () => void }) {
  // #370: Retry and Cancel show to whoever may call them.
  const { can } = useMe();
  const retry = (job.status === "failed" || job.status === "cancelled") && can("retry_llm_job");
  const cancel = (job.status === "queued" || job.status === "running") && can("cancel_llm_job");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const act = async (what: "retry" | "cancel") => {
    setBusy(true);
    setError(null);
    try {
      const params = { params: { path: { job_id: job.id } } };
      await unwrap(
        what === "retry"
          ? api.POST("/v1/llm-jobs/{job_id}/retry", params)
          : api.POST("/v1/llm-jobs/{job_id}/cancel", params),
      );
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the job.");
    } finally {
      setBusy(false);
    }
  };
  const note = summary(job);
  return (
    <li className="border-b border-line py-3 last:border-b-0" data-testid="llm-job" data-status={job.status}>
      <div className="flex flex-wrap items-center gap-2">
        <JobStatusChip status={job.status} at={job.finished_at} />
        <span className="font-semibold text-text" data-testid="job-kind">
          {JOB_KIND_LABEL[job.kind]}
        </span>
        {job.version_number != null && <span className="font-mono text-[13px] text-text2">v{job.version_number}</span>}
        {job.section_key && <span className="truncate font-mono text-[13px] text-text2">#{job.section_key}</span>}
        <span className="tnum ml-auto text-[13px] text-text2">{formatDateTime(job.created_at)}</span>
      </div>
      {note && <p className="mt-1 text-[15px] leading-[22px] text-text">{note}</p>}
      {job.status === "failed" && (
        <div className="mt-1.5 rounded-lg bg-crit-bg px-2.5 py-2 text-sm leading-5 text-crit" data-testid="job-error">
          <p className="font-semibold">{jobFailure({ error: job.error, error_reason: null })}</p>
          {job.error_reason && NO_ACCOUNT_REASON[job.error_reason] && <p className="mt-0.5">{NO_ACCOUNT_REASON[job.error_reason]}</p>}
          {/* A reset already past says nothing about now (#556). */}
          {job.next_reset_at && Date.parse(job.next_reset_at) > now && (
            <p className="tnum mt-0.5">Next reset: {formatDateTime(job.next_reset_at)}</p>
          )}
        </div>
      )}
      {job.status === "queued" && job.error && <p className="mt-1 text-sm font-medium text-warn">{job.error}</p>}
      {job.attempts > 1 && (
        <p className="tnum mt-1 text-[13px] text-text2">
          <span className="font-semibold">Attempts</span> <span className="text-text">{job.attempts}</span>
        </p>
      )}
      {/* P3d Cost prominence: the account, tokens and cost sit behind Details. */}
      <details className="mt-1.5 text-[13px] text-text2">
        <summary className="w-fit cursor-pointer font-semibold text-text2 hover:text-text">Details</summary>
        <dl className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
          <div className="flex items-center gap-1.5">
            <dt className="font-semibold">Account</dt>
            <dd className="text-text" data-testid="job-account">
              {accountName(job)}
            </dd>
          </div>
          {job.input_tokens != null && (
            <div className="flex items-center gap-1.5">
              <dt className="font-semibold">Tokens</dt>
              <dd className="tnum text-text" data-testid="job-tokens">
                {job.input_tokens.toLocaleString("en")} in · {(job.output_tokens ?? 0).toLocaleString("en")} out
              </dd>
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <dt className="font-semibold">Cost</dt>
            {/* CostFigure's look; formatUsd keeps sub-cent costs readable ($0.0034). */}
            <dd data-testid="job-cost" data-cost="small" className="tnum font-mono font-medium text-text2">
              {formatUsd(job.cost_usd)}
            </dd>
          </div>
        </dl>
      </details>
      {(retry || cancel) && (
        <div className="mt-2 flex gap-2">
          {retry && (
            <Button disabled={busy} onClick={() => act("retry")}>
              Retry
            </Button>
          )}
          {cancel && (
            <Button variant="ghost" disabled={busy} onClick={() => act("cancel")}>
              Cancel
            </Button>
          )}
        </div>
      )}
      {error && <InlineError>{error}</InlineError>}
    </li>
  );
}

function SettingsForm({ doc }: { doc: string }) {
  const q = useQuery(`llm-settings|${doc}`, () =>
    unwrap(api.GET("/v1/documents/{doc}/llm-jobs/settings", { params: { path: { doc } } })),
  );
  const [error, setError] = useState<string | null>(null);
  async function toggle(kind: LlmJobKind, on: boolean) {
    if (!q.data) return;
    const before = q.data;
    const body = { ...before, [kind]: on };
    setError(null);
    q.setData(() => body);
    try {
      const next = await unwrap(api.PUT("/v1/documents/{doc}/llm-jobs/settings", { params: { path: { doc } }, body }));
      q.setData(() => next);
      window.dispatchEvent(new CustomEvent(SETTINGS_EVENT, { detail: { doc } }));
    } catch (e) {
      q.setData(() => before);
      setError(e instanceof Error ? e.message : "Could not save.");
    }
  }
  if (!q.data) return null;
  return (
    <fieldset className="rounded-button border border-line px-3 pt-1 pb-2.5" data-testid="llm-job-settings">
      <legend className="flex items-center gap-1.5 px-1 text-[13px] font-semibold tracking-[0.02em] text-text2">
        Oracle does on its own
        <InfoTip label="Oracle does on its own" align="start">
          Oracle reads new feedback and writes reports by itself. Turn each off here.
        </InfoTip>
      </legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {(Object.keys(q.data!) as (keyof JobSettings)[]).map((k) => (
          <label key={k} className="flex items-center gap-2 text-sm font-medium text-text">
            <input
              type="checkbox"
              className="size-4 accent-[var(--accent)]"
              checked={q.data![k] ?? true}
              onChange={(e) => toggle(k, e.target.checked)}
            />
            {JOB_SETTING_LABEL[k] ?? k}
          </label>
        ))}
      </div>
      {error && <InlineError>{error}</InlineError>}
    </fieldset>
  );
}

/** Oracle's work on a document (History): its switches, run-now buttons, and each job with retry and cancel. */
export function JobsPanel({ doc, version, refreshKey = 0 }: { doc: string; version?: number; refreshKey?: number }) {
  const { can } = useMe();
  // #370: the switches show only to whoever may change them; the run-now buttons likewise.
  const canSettings = can("put_llm_job_settings");
  const canQueue = can("create_llm_job");
  const q = useQuery(`llm-jobs|${doc}|${refreshKey}`, () =>
    unwrap(api.GET("/v1/documents/{doc}/llm-jobs", { params: { path: { doc } } })),
  );
  const active = !!q.data?.some((j) => j.status === "queued" || j.status === "running");
  usePolling(active, q.reload);
  const [error, setError] = useState<string | null>(null);

  async function queue(kind: "review_comments" | "reporting") {
    setError(null);
    try {
      await unwrap(
        api.POST("/v1/documents/{doc}/llm-jobs", { params: { path: { doc } }, body: { kind, version: version ?? null } }),
      );
      await q.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not queue the job.");
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="jobs-panel">
      {canSettings && <SettingsForm doc={doc} />}
      {canQueue && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => queue("review_comments")}>Suggest changes now</Button>
          <Button onClick={() => queue("reporting")}>Write reports now</Button>
        </div>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {!q.data && !q.error && <Loading />}
      {q.data && q.data.length === 0 && (
        <Empty>Oracle hasn&apos;t worked on this version yet.</Empty>
      )}
      {q.data && q.data.length > 0 && (
        <ol className="flex flex-col" aria-label="Oracle's work">
          {q.data.map((j) => (
            <JobRow key={j.id} job={j} onChanged={() => void q.reload()} />
          ))}
        </ol>
      )}
    </div>
  );
}
