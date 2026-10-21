"use client";

import { Empty, Page, PageHeader, Panel } from "@/components/ds";
import { hasRole, useMe } from "@/lib/me";

import { FoundInSources } from "./_components/FoundInSources";
import { ClassifyNow, TriageStatusLine, useTriage } from "./_components/Triage";

/**
 * Requests (C1). Oracle's triage: Classify now (approvers and owners) and its status line, and
 * the requests Oracle found in your own sources, yours alone until you file one. The request
 * queue itself (table, inspector, Add request) comes with the Requests screen lane.
 */
export default function RequestsPage() {
  const { role } = useMe();
  const triage = useTriage();
  const run = triage.data;
  return (
    <Page>
      <PageHeader
        title="Requests"
        status={<TriageStatusLine status={run} />}
        action={hasRole(role, "approver") ? <ClassifyNow triage={triage} /> : undefined}
      />
      <div className="flex min-w-0 flex-col gap-4 max-[600px]:gap-3">
        {hasRole(role, "commenter") && <FoundInSources refresh={`${run?.run_id ?? ""}:${run?.active ?? false}`} />}
        <Panel>
          <Empty icon="requests" testId="requests-empty">
            Nothing yet
          </Empty>
        </Panel>
      </div>
    </Page>
  );
}
