import { Empty, Page, PageHeader, Panel } from "@/components/ds";

/** Requests (I3). The request list and triage come in the UI wave, once their APIs merge. */
export default function RequestsPage() {
  return (
    <Page>
      <PageHeader title="Requests" />
      <Panel>
        <Empty icon="requests" testId="requests-empty">
          Nothing yet
        </Empty>
      </Panel>
    </Page>
  );
}
