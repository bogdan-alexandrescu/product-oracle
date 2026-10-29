"use client";

import Link from "next/link";
import { useState } from "react";

import { Button, Chip, DataTable, InfoTip, Page, PageHeader, Panel, type Column } from "@/components/ds";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

import { GenerateDialog } from "./_generate";
import { type ReportItem } from "./_lib";

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
    cell: (r) => <span className="tnum text-text2">{formatDateTime(r.generated_at)}</span>,
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
        // qa-plan-25: every Plan tab's page is titled "Plan", like the strip beneath it.
        title="Plan"
        // qa-plan-11: no back link, the Plan tab strip below leads back, so the title stays put.
        info={
          <InfoTip label="Alignment reports" align="start" side="bottom">
            Each week Oracle reports how the tracks stand against their milestones and posts it to Slack. A report
            opens from here; the newest is also the Alignment report link.
          </InfoTip>
        }
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
        // qa-plan-40: headed "Reports", its count only when there are some; with none, the
        // empty state offers Generate now to a member who may (as /plan/reports/latest does).
        <Panel title="Reports" count={q.data.length || undefined} testId="reports-panel">
          {q.data.length === 0 ? (
            <div data-testid="reports-empty" className="flex flex-col items-center gap-3 px-4 py-8 text-center text-[15px] text-text2">
              <p>
                No report yet. Oracle makes one every week for the week that ended.
                {can("create_alignment_report") ? " You can generate one now for the week so far." : " An owner can generate one now."}
              </p>
              {can("create_alignment_report") && (
                <Button variant="primary" icon="plus" onClick={() => setOpen(true)}>
                  Generate now
                </Button>
              )}
            </div>
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
