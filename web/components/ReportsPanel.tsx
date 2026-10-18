"use client";

import { useState } from "react";

import { usePolling } from "@/components/JobsPanel";
import { Badge, Button, ErrorNote, Loading, StatusBadge } from "@/components/ui";
import { api, unwrap, type FeedbackStatus } from "@/lib/api/client";
import { formatDate, formatDateTime, JOB_STATUS_LABEL, NO_ACCOUNT_REASON } from "@/lib/format";
import { hasRole, useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

type Tab = "resolution" | "changes";

/** A version's reports: how each feedback item was handled, and what changed since an earlier version. */
export function ReportsPanel({ doc, n, refreshKey }: { doc: string; n: number; refreshKey: number }) {
  const { role } = useMe();
  const canAct = hasRole(role, "approver");
  const [tab, setTab] = useState<Tab>("resolution");
  const [error, setError] = useState<string | null>(null);
  const q = useQuery(`reports|${doc}|${n}|${refreshKey}`, () =>
    unwrap(api.GET("/v1/documents/{doc}/versions/{n}/reports", { params: { path: { doc, n } } })),
  );
  const job = q.data?.latest_job;
  usePolling(job?.status === "queued" || job?.status === "running", q.reload);

  async function generate() {
    setError(null);
    try {
      await unwrap(api.POST("/v1/documents/{doc}/llm-jobs", { params: { path: { doc } }, body: { kind: "reporting", version: n } }));
      await q.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not queue the reports.");
    }
  }

  async function download(format: "md" | "html") {
    setError(null);
    try {
      const blob = await unwrap<Blob>(
        api.GET("/v1/documents/{doc}/versions/{n}/reports/export", {
          params: { path: { doc, n }, query: { format } },
          parseAs: "blob",
        }),
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${doc}-v${n}-reports.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed.");
    }
  }

  if (q.error) return <ErrorNote>{q.error}</ErrorNote>;
  if (!q.data) return <Loading />;
  const r = q.data.resolution;
  const c = q.data.changes;
  const busy = job?.status === "queued" || job?.status === "running";

  return (
    <div className="flex flex-col gap-3" data-testid="reports-panel">
      <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
        {q.data.generated_at ? <span>Written {formatDateTime(q.data.generated_at)}</span> : <span>No reports yet.</span>}
        {job && job.status !== "succeeded" && <Badge tone={job.status === "failed" ? "red" : "blue"}>{JOB_STATUS_LABEL[job.status]}</Badge>}
        <span className="ml-auto flex gap-1.5">
          {canAct && (
            <Button size="sm" disabled={busy} onClick={generate}>
              {r ? "Write again" : "Write reports"}
            </Button>
          )}
          {r && (
            <>
              <Button size="sm" onClick={() => download("md")} aria-label="Export reports MD">
                MD
              </Button>
              <Button size="sm" onClick={() => download("html")} aria-label="Export reports HTML">
                HTML
              </Button>
            </>
          )}
        </span>
      </div>
      {job?.status === "failed" && (
        <p className="rounded border border-rose-200 bg-rose-50 px-2 py-1.5 text-xs text-rose-900" role="alert">
          {job.error}
          {job.error_reason && NO_ACCOUNT_REASON[job.error_reason] && <> {NO_ACCOUNT_REASON[job.error_reason]}</>}
        </p>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
      {(r || c) && (
        <div role="tablist" aria-label="Reports" className="flex gap-1 border-b border-neutral-200">
          {(
            [
              ["resolution", "Resolution report"],
              ["changes", c?.since ? `What changed since v${c.since}` : "What changed"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              type="button"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`-mb-px border-b-2 px-2 pb-1.5 text-xs ${
                tab === id ? "border-neutral-900 font-medium text-neutral-900" : "border-transparent text-neutral-500 hover:text-neutral-800"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {tab === "resolution" && r && (
        <section aria-label="Resolution report" className="flex flex-col gap-2 text-sm">
          <p className="text-neutral-800">{r.summary}</p>
          <ol className="flex flex-col gap-2">
            {r.items.map((i) => (
              <li key={i.feedback_id} className="rounded-md border border-neutral-200 bg-white px-3 py-2">
                <div className="flex items-center gap-1.5">
                  <StatusBadge status={i.status as FeedbackStatus} />
                  {i.section_key && <span className="font-mono text-[11px] text-neutral-500">#{i.section_key}</span>}
                </div>
                <p className="mt-1 text-neutral-900">{i.summary}</p>
                {(i.explanation || i.resolution_note) && (
                  <p className="mt-1 text-xs text-neutral-700">{i.explanation || i.resolution_note}</p>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
      {tab === "changes" && c && (
        <section aria-label="What changed" className="flex flex-col gap-2 text-sm">
          <p className="text-neutral-800">{c.summary}</p>
          {c.sections.length > 0 && (
            <ul className="flex flex-col gap-1">
              {c.sections.map((sec) => (
                <li key={sec.section_key}>
                  <a href={`#s-${sec.section_key}`} className="font-medium underline-offset-2 hover:underline">
                    {sec.heading}
                  </a>{" "}
                  <span className="text-xs text-neutral-500">({sec.status})</span>
                  {sec.summary && <span className="text-neutral-700">: {sec.summary}</span>}
                </li>
              ))}
            </ul>
          )}
          {c.new_sources.length > 0 && (
            <>
              <h3 className="mt-1 text-xs font-semibold text-neutral-700">New sources in the baseline</h3>
              <ul className="flex flex-col gap-1 text-xs text-neutral-700" data-testid="new-sources">
                {c.new_sources.map((src, i) => (
                  <li key={i}>
                    {src.url ? (
                      <a href={src.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                        {src.title}
                      </a>
                    ) : (
                      src.title
                    )}
                    {src.about && ` (on ${src.about})`} · {src.kind} · added {formatDate(src.added_at)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </div>
  );
}
