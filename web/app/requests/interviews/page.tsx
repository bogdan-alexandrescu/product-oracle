"use client";

import { useRouter } from "next/navigation";

import { Chip, DataTable, Page, Panel, type Column } from "@/components/ds";
import { ErrorNote } from "@/components/ui";
import { INTERVIEW_STATUS_KIND, INTERVIEW_STATUS_LABEL, interviewsCall, type InterviewSummary } from "@/lib/api/interviews";
import { formatAge, formatDateTime } from "@/lib/format";
import { useQuery } from "@/lib/use-query";

import { RequestsHeader } from "../_components/RequestsHeader";
import { useTriage } from "../_components/Triage";

/** "just now", "5m ago": the age the request rows and the triage line write (never "now ago"). */
function finishedAgo(at: string): string {
  const age = formatAge(at);
  return !age || age === "now" ? "just now" : `${age} ago`;
}

const COLUMNS: Column<InterviewSummary>[] = [
  {
    key: "customer",
    header: "Customer",
    cell: (r) => (
      <span className="font-semibold">
        {r.interviewee_name}
        {r.interviewee_company && <span className="font-normal text-text2"> · {r.interviewee_company}</span>}
      </span>
    ),
    phone: "title",
  },
  { key: "about", header: "About", cell: (r) => <span title={r.title}>{r.title}</span> },
  {
    key: "status",
    header: "Status",
    width: "130px",
    cell: (r) => (
      <Chip kind={INTERVIEW_STATUS_KIND[r.status]} dot data-testid="interview-status">
        {INTERVIEW_STATUS_LABEL[r.status]}
      </Chip>
    ),
    phone: "action",
  },
  { key: "by", header: "Created by", width: "150px", cell: (r) => r.created_by_name ?? "—", hideOnPhone: true },
  {
    key: "finished",
    header: "Finished",
    width: "100px",
    // An age, as the request rows show theirs (qa-work-41); the full date on hover.
    cell: (r) =>
      r.finished_at ? (
        <span className="tnum" title={formatDateTime(r.finished_at)} data-testid="interview-finished">
          {finishedAgo(r.finished_at)}
        </span>
      ) : (
        "—"
      ),
    phoneLabel: "Finished ",
  },
  { key: "requests", header: "Requests", width: "100px", align: "right", cell: (r) => <span className="tnum">{r.request_count}</span>, phoneLabel: "Requests " },
];

/**
 * Requests' Interviews tab (C3): every customer interview, newest first; a row opens it. The
 * header is every Requests tab's (qa-work-41); a request filed here opens on All requests. On a
 * phone the rows stack as cards; the table's column widths are dropped there so nothing is
 * wider than the screen (qa-work-42).
 */
export default function InterviewsPage() {
  const router = useRouter();
  const triage = useTriage();
  const q = useQuery("interviews", () => interviewsCall<InterviewSummary[]>("GET", "/v1/interviews?kind=customer"));
  return (
    <Page>
      <RequestsHeader
        triage={triage}
        onFiled={(r) => router.push(`/requests?request=${encodeURIComponent(r.id)}`)}
        onInterviewed={() => void q.reload()}
      />
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      <Panel title="Interviews" count={q.data?.length} className="max-[600px]:[&_colgroup]:hidden">
        <DataTable
          label="Customer interviews"
          testId="interviews-table"
          columns={COLUMNS}
          rows={q.data}
          rowKey={(r) => r.id}
          loading={q.loading}
          onSelect={(id) => router.push(`/requests/interviews/${id}`)}
          rowProps={(r) => ({ "data-testid": "interview-row", "data-status": r.status })}
        />
      </Panel>
    </Page>
  );
}
