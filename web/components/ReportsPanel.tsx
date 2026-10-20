"use client";

import { useState } from "react";

import { usePolling } from "@/components/JobsPanel";
import { Button } from "@/components/ds";
import { FeedbackStatusChip, JobStatusChip, TabBar } from "@/components/review/parts";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type FeedbackStatus } from "@/lib/api/client";
import { formatDate, formatDateTime, NO_ACCOUNT_REASON } from "@/lib/format";
import { hasRole, useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";
import { sectionHref } from "@/lib/section-link";

type Tab = "resolution" | "changes";

/** A version's reports: how each feedback item was handled, and what changed since an earlier version. */
export function ReportsPanel({
  doc,
  n,
  refreshKey,
  initialTab = "resolution",
}: {
  doc: string;
  n: number;
  refreshKey: number;
  /** "changes" opens on What changed (where applying a next draft lands, C1e). */
  initialTab?: Tab;
}) {
  const { role } = useMe();
  const canAct = hasRole(role, "approver");
  const [tab, setTab] = useState<Tab>(initialTab);
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
      <div className="flex flex-wrap items-center gap-2">
        {q.data.generated_at ? (
          <span className="tnum text-[13px] font-semibold text-text2">Written {formatDateTime(q.data.generated_at)}</span>
        ) : (
          <span className="text-sm font-semibold text-text2">No reports yet.</span>
        )}
        {job && job.status !== "succeeded" && <JobStatusChip status={job.status} />}
        <span className="ml-auto flex gap-1.5">
          {canAct && (
            <Button disabled={busy} onClick={generate}>
              {r ? "Write again" : "Write reports"}
            </Button>
          )}
          {r && (
            <>
              <Button variant="ghost" onClick={() => download("md")} aria-label="Export reports MD">
                MD
              </Button>
              <Button variant="ghost" onClick={() => download("html")} aria-label="Export reports HTML">
                HTML
              </Button>
            </>
          )}
        </span>
      </div>
      {job?.status === "failed" && (
        <p className="rounded-button bg-crit-bg px-3 py-2 text-sm font-medium text-crit" role="alert">
          {job.error}
          {job.error_reason && NO_ACCOUNT_REASON[job.error_reason] && <> {NO_ACCOUNT_REASON[job.error_reason]}</>}
        </p>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
      {(r || c) && (
        <TabBar
          label="Reports"
          size="sm"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "resolution", label: "Resolution report" },
            { id: "changes", label: c?.since ? `What changed since v${c.since}` : "What changed" },
          ]}
        />
      )}
      {tab === "resolution" && r && (
        <section aria-label="Resolution report" className="flex flex-col gap-2">
          <p className="text-[15px] leading-[22px] font-medium text-text">{r.summary}</p>
          <ol className="flex flex-col">
            {r.items.map((i) => (
              <li key={i.feedback_id} className="border-b border-line py-2.5 last:border-b-0">
                <div className="flex items-center gap-2">
                  <FeedbackStatusChip status={i.status as FeedbackStatus} />
                  {i.section_key && <span className="truncate font-mono text-[13px] text-text2">#{i.section_key}</span>}
                </div>
                <p className="mt-1 text-[15px] leading-[22px] text-text">{i.summary}</p>
                {(i.explanation || i.resolution_note) && (
                  <p className="mt-1 text-sm leading-5 text-text2">{i.explanation || i.resolution_note}</p>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
      {tab === "changes" && c && (
        <section aria-label="What changed" className="flex flex-col gap-2">
          <p className="text-[15px] leading-[22px] font-medium text-text">{c.summary}</p>
          {c.sections.length > 0 && (
            <ul className="flex flex-col">
              {c.sections.map((sec) => (
                <li key={sec.section_key} className="border-b border-line py-2 text-sm leading-5 last:border-b-0">
                  <a href={sectionHref(doc, n, sec.section_key)} className="font-semibold text-accent-ink hover:underline">
                    {sec.heading}
                  </a>{" "}
                  <span className="text-[13px] text-text2">({sec.status})</span>
                  {sec.summary && <span className="text-text">: {sec.summary}</span>}
                </li>
              ))}
            </ul>
          )}
          {c.new_sources.length > 0 && (
            <>
              <h3 className="mt-1 text-[13px] font-semibold tracking-[0.02em] text-text2">New sources</h3>
              <ul className="flex flex-col gap-1.5 text-sm leading-5 text-text" data-testid="new-sources">
                {c.new_sources.map((src, i) => (
                  <li key={i}>
                    {src.url ? (
                      <a href={src.url} target="_blank" rel="noopener noreferrer" className="font-medium underline underline-offset-2">
                        {src.title}
                      </a>
                    ) : (
                      <span className="font-medium">{src.title}</span>
                    )}
                    <span className="text-text2">
                      {src.about && ` (on ${src.about})`} · {src.kind} · added {formatDate(src.added_at)}
                    </span>
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
