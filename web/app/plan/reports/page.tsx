"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { Button, Chip, DataTable, Empty, Notice, Page, PageHeader, Panel, useFocusTrap, type Column } from "@/components/ds";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

import { inZone, type ReportItem } from "./_lib";

const SLACK_KIND = { posted: "pass", failed: "crit", pending: "warn", not_configured: "na", not_requested: "na" } as const;
const SLACK_LABEL = { posted: "Posted", failed: "Not posted", pending: "Retrying", not_configured: "No Slack", not_requested: "Not posted" } as const;

const COLUMNS: Column<ReportItem>[] = [
  {
    key: "week",
    header: "Report",
    phone: "title",
    cell: (r) => (
      <Link href={`/plan/reports/${r.id}`} className="block truncate font-semibold hover:underline" title={r.headline}>
        {r.title}
      </Link>
    ),
  },
  {
    key: "headline",
    header: "Headline",
    width: "44%",
    phone: "meta",
    cell: (r) => (
      <span className="block truncate text-text2" title={r.headline}>
        {r.headline}
      </span>
    ),
  },
  {
    key: "slack",
    header: "Slack",
    width: "120px",
    phone: "meta",
    cell: (r) => (
      <Chip kind={SLACK_KIND[r.slack.status]} dot>
        {SLACK_LABEL[r.slack.status]}
      </Chip>
    ),
  },
  {
    key: "generated",
    header: "Made",
    width: "190px",
    align: "right",
    phone: "meta",
    cell: (r) => <span className="tnum text-text2">{inZone(r.generated_at, r.timezone)}</span>,
  },
];

/** Plan › Alignment reports: every report, newest first; owners Generate now. */
export default function ReportsPage() {
  const q = useQuery("alignment-reports", () => unwrap(api.GET("/v1/alignment-reports", { params: { query: { limit: 200 } } })));
  const { can } = useMe();
  const [open, setOpen] = useState(false);
  return (
    <Page>
      <PageHeader
        title="Alignment reports"
        back={<Link href="/roadmap" className="hover:underline">Roadmap</Link>}
        action={
          can("create_alignment_report") && (
            <Button variant="primary" icon="plus" onClick={() => setOpen(true)}>
              Generate now
            </Button>
          )
        }
      />
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {q.loading && !q.data && <Loading />}
      {q.data && (
        <Panel title="Every report" count={q.data.length} testId="reports-panel">
          {q.data.length === 0 ? (
            <Empty>No report yet. Oracle makes one every week for the week that ended.</Empty>
          ) : (
            <div data-testid="reports-table">
              <DataTable label="Alignment reports" columns={COLUMNS} rows={q.data} rowKey={(r) => r.id} />
            </div>
          )}
        </Panel>
      )}
      {open && <GenerateDialog onClose={() => setOpen(false)} />}
    </Page>
  );
}

function GenerateDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);
  const [post, setPost] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useFocusTrap(ref, true, onClose);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const report = await unwrap(api.POST("/v1/alignment-reports", { body: { post_to_slack: post } }));
      router.push(`/plan/reports/${report.id}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-hero/50 px-4 py-10 max-[600px]:px-2 max-[600px]:py-4">
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="generate-report-title"
        className="w-full max-w-lg min-w-0 rounded-inspector border border-line bg-surface text-text shadow-tip"
      >
        <div className="flex min-h-14 items-center gap-2 border-b border-line px-5 max-[600px]:px-4">
          <h2 id="generate-report-title" className="font-display text-xl font-bold tracking-heading">
            Generate a report now
          </h2>
          <span className="flex-1" />
          <Button variant="ghost" icon="x" onClick={onClose} aria-label="Close" />
        </div>
        <div className="space-y-4 px-5 py-4 text-[15px] max-[600px]:px-4">
          <p className="text-text2">The roadmap against engineering for the week so far, for every active or paused track.</p>
          <label className="flex items-center gap-2 font-medium">
            <input type="checkbox" checked={post} onChange={(e) => setPost(e.target.checked)} className="size-4 accent-[var(--accent)]" />
            Post to Slack
          </label>
          {error && <Notice tone="error">{error}</Notice>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="solid" disabled={busy} onClick={generate} data-autofocus>
              Generate
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
