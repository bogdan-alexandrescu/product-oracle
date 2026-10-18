"use client";

import { useEffect, useState } from "react";

import { Badge, Button, ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type JobSettings, type LlmJob, type LlmJobKind } from "@/lib/api/client";
import { formatDateTime, formatUsd, JOB_KIND_LABEL, JOB_STATUS_LABEL, NO_ACCOUNT_REASON } from "@/lib/format";
import { hasRole, useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

const STATUS_TONE: Record<LlmJob["status"], "neutral" | "blue" | "green" | "red" | "amber"> = {
  queued: "neutral",
  running: "blue",
  succeeded: "green",
  failed: "red",
  cancelled: "neutral",
};

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
  return `Revision of #${job.section_key} ready to review`;
}

function JobRow({ job, canAct, onChanged }: { job: LlmJob; canAct: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    <li className="rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm" data-testid="llm-job" data-status={job.status}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={STATUS_TONE[job.status]}>{JOB_STATUS_LABEL[job.status]}</Badge>
        <span className="font-medium text-neutral-900">{JOB_KIND_LABEL[job.kind]}</span>
        {job.version_number != null && <span className="text-xs text-neutral-500">v{job.version_number}</span>}
        {job.section_key && <span className="font-mono text-[11px] text-neutral-500">#{job.section_key}</span>}
        <span className="ml-auto text-xs text-neutral-400">{formatDateTime(job.created_at)}</span>
      </div>
      {note && <p className="mt-1 text-neutral-700">{note}</p>}
      {job.status === "failed" && (
        <div className="mt-1.5 rounded border border-rose-200 bg-rose-50 px-2 py-1.5 text-xs text-rose-900" data-testid="job-error">
          <p>{job.error ?? "The job failed."}</p>
          {job.error_reason && NO_ACCOUNT_REASON[job.error_reason] && (
            <p className="mt-0.5">{NO_ACCOUNT_REASON[job.error_reason]}</p>
          )}
          {job.next_reset_at && <p className="mt-0.5">Next reset: {formatDateTime(job.next_reset_at)}</p>}
        </div>
      )}
      {job.status === "queued" && job.error && <p className="mt-1 text-xs text-amber-800">{job.error}</p>}
      <dl className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-neutral-500">
        <div className="flex gap-1">
          <dt>Account</dt>
          <dd className="text-neutral-700" data-testid="job-account">
            {accountName(job)}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt>Cost</dt>
          <dd className="text-neutral-700" data-testid="job-cost">
            {formatUsd(job.cost_usd)}
          </dd>
        </div>
        {job.input_tokens != null && (
          <div className="flex gap-1">
            <dt>Tokens</dt>
            <dd className="text-neutral-700">
              {job.input_tokens.toLocaleString("en")} in · {(job.output_tokens ?? 0).toLocaleString("en")} out
            </dd>
          </div>
        )}
        {job.attempts > 1 && (
          <div className="flex gap-1">
            <dt>Attempts</dt>
            <dd className="text-neutral-700">{job.attempts}</dd>
          </div>
        )}
      </dl>
      {canAct && (job.status === "failed" || job.status === "cancelled" || job.status === "queued" || job.status === "running") && (
        <div className="mt-2 flex gap-2">
          {(job.status === "failed" || job.status === "cancelled") && (
            <Button size="sm" disabled={busy} onClick={() => act("retry")}>
              Retry
            </Button>
          )}
          {(job.status === "queued" || job.status === "running") && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => act("cancel")}>
              Cancel
            </Button>
          )}
        </div>
      )}
      {error && <p className="mt-1 text-xs text-rose-700">{error}</p>}
    </li>
  );
}

function SettingsForm({ doc, canEdit }: { doc: string; canEdit: boolean }) {
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
    } catch (e) {
      q.setData(() => before);
      setError(e instanceof Error ? e.message : "Could not save.");
    }
  }
  if (!q.data) return null;
  return (
    <fieldset className="rounded-md border border-neutral-200 px-3 py-2 text-sm" data-testid="llm-job-settings">
      <legend className="px-1 text-xs font-medium text-neutral-600">Built-in jobs on this document</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {(Object.keys(JOB_KIND_LABEL) as (keyof JobSettings)[]).map((k) => (
          <label key={k} className="flex items-center gap-1.5 text-neutral-800">
            <input
              type="checkbox"
              checked={q.data![k] ?? true}
              disabled={!canEdit}
              onChange={(e) => toggle(k, e.target.checked)}
            />
            {JOB_KIND_LABEL[k]}
          </label>
        ))}
      </div>
      {!canEdit && <p className="mt-1 text-xs text-neutral-500">Only an owner turns these on or off.</p>}
      {error && <p className="mt-1 text-xs text-rose-700">{error}</p>}
    </fieldset>
  );
}

/** The document's built-in model jobs: status, the account each ran on, cost, retry and cancel. */
export function JobsPanel({ doc, version, refreshKey = 0 }: { doc: string; version?: number; refreshKey?: number }) {
  const { role } = useMe();
  const canAct = hasRole(role, "approver");
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
      <SettingsForm doc={doc} canEdit={hasRole(role, "owner")} />
      {canAct && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => queue("review_comments")}>
            Handle new feedback
          </Button>
          <Button size="sm" onClick={() => queue("reporting")}>
            Write reports
          </Button>
        </div>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {!q.data && !q.error && <Loading />}
      {q.data && q.data.length === 0 && (
        <p className="text-sm text-neutral-500">
          No jobs yet. Oracle handles new comments and writes each version&apos;s reports on its own.
        </p>
      )}
      {q.data && q.data.length > 0 && (
        <ol className="flex flex-col gap-2" aria-label="Jobs">
          {q.data.map((j) => (
            <JobRow key={j.id} job={j} canAct={canAct} onChanged={() => void q.reload()} />
          ))}
        </ol>
      )}
    </div>
  );
}
