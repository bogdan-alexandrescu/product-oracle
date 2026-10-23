"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, Chip, DataTable, Page, PageHeader, Panel, type Column } from "@/components/ds";
import { ErrorNote } from "@/components/ui";
import { INTERVIEW_STATUS_KIND, INTERVIEW_STATUS_LABEL, interviewsCall, type InterviewSummary } from "@/lib/api/interviews";
import { formatDate } from "@/lib/format";
import { useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

import { InterviewDialog } from "../_components/InterviewDialog";

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
  { key: "finished", header: "Finished", width: "120px", cell: (r) => (r.finished_at ? formatDate(r.finished_at) : "—"), phoneLabel: "Finished " },
  { key: "requests", header: "Requests", width: "100px", align: "right", cell: (r) => <span className="tnum">{r.request_count}</span>, phoneLabel: "Requests " },
];

/** Requests' Interviews tab (C3): every customer interview, newest first; a row opens it. */
export default function InterviewsPage() {
  const router = useRouter();
  const { can } = useMe();
  const q = useQuery("interviews", () => interviewsCall<InterviewSummary[]>("GET", "/v1/interviews?kind=customer"));
  const [interviewing, setInterviewing] = useState(false);
  return (
    <Page>
      <PageHeader
        title="Requests"
        action={can("create_interview") && <Button onClick={() => setInterviewing(true)}>Interview a customer</Button>}
      />
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      <Panel title="Interviews" count={q.data?.length}>
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
      {interviewing && (
        <InterviewDialog
          onClose={() => {
            setInterviewing(false);
            void q.reload();
          }}
        />
      )}
    </Page>
  );
}
