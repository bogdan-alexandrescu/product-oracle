"use client";

import { Chip, DataTable, Page, PageHeader, Panel, type Column } from "@/components/ds";
import { ErrorNote } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatDate } from "@/lib/format";
import { useQuery } from "@/lib/use-query";

type RequestRow = Schemas["RequestOut"];

const CHANNEL_LABEL: Record<RequestRow["channel"], string> = {
  support: "Support",
  sales: "Sales",
  team: "Team",
  interview: "Interview",
  slack: "Slack",
  meeting: "Meeting",
  doc: "Doc",
  other: "Other",
};

const COLUMNS: Column<RequestRow>[] = [
  { key: "title", header: "Request", cell: (r) => <span title={r.body ?? r.title}>{r.title}</span>, phone: "title" },
  {
    key: "verified",
    header: "Checked",
    width: "120px",
    // C3: a customer's own words from an interview are taken as given, not checked.
    cell: (r) => (r.verified ? null : <Chip kind="warn" data-testid="request-unverified">Unverified</Chip>),
  },
  { key: "channel", header: "Channel", width: "120px", cell: (r) => <Chip kind="line">{CHANNEL_LABEL[r.channel]}</Chip> },
  { key: "from", header: "Asked by", width: "200px", cell: (r) => r.requester_name ?? "—", phoneLabel: "By " },
  { key: "at", header: "Received", width: "120px", cell: (r) => formatDate(r.created_at), hideOnPhone: true },
];

/**
 * Requests' New tab (C1): the requests nobody has decided yet, newest first, each with its
 * channel and an Unverified mark when the requester is taken as given (a customer interview).
 * The full queue (inspector, decisions) comes with the Requests screen lane.
 */
export default function NewRequestsPage() {
  const q = useQuery("requests:new", () => unwrap(api.GET("/v1/requests", { params: { query: { state: "new", limit: 200 } } })));
  return (
    <Page>
      <PageHeader title="Requests" />
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      <Panel title="New" count={q.data?.total}>
        <DataTable
          label="New requests"
          testId="new-requests"
          columns={COLUMNS}
          rows={q.data?.items}
          rowKey={(r) => r.id}
          loading={q.loading}
          rowProps={(r) => ({ id: `request-${r.id}`, "data-testid": "request-row", "data-channel": r.channel })}
        />
      </Panel>
    </Page>
  );
}
