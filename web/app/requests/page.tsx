"use client";

import { useState } from "react";

import { Button, Empty, Page, PageHeader, Panel } from "@/components/ds";
import { hasRole, useMe } from "@/lib/me";

import { FoundInSources } from "./_components/FoundInSources";
import { InterviewDialog } from "./_components/InterviewDialog";
import { ClassifyNow, DailyTriageSwitch, TriageStatusLine, useTriage } from "./_components/Triage";

/**
 * Requests (C1). Oracle's triage: Classify now and the "Daily triage at 07:00 PT" switch
 * (approvers and owners; others see the switch's state) and its status line, and
 * the requests Oracle found in your own sources, yours alone until you file one, and
 * Interview a customer (C3, commenters and up). The request queue itself (table, inspector,
 * Add request) comes with the Requests screen lane.
 */
export default function RequestsPage() {
  const { role } = useMe();
  const triage = useTriage();
  const run = triage.data;
  const [interviewing, setInterviewing] = useState(false);
  return (
    <Page>
      <PageHeader
        title="Requests"
        status={<TriageStatusLine status={run} />}
        action={
          <>
            <DailyTriageSwitch triage={triage} canChange={hasRole(role, "approver")} />
            {hasRole(role, "approver") && <ClassifyNow triage={triage} />}
            {hasRole(role, "commenter") && <Button onClick={() => setInterviewing(true)}>Interview a customer</Button>}
          </>
        }
      />
      <div className="flex min-w-0 flex-col gap-4 max-[600px]:gap-3">
        {hasRole(role, "commenter") && <FoundInSources refresh={`${run?.run_id ?? ""}:${run?.active ?? false}`} />}
        <Panel>
          <Empty icon="requests" testId="requests-empty">
            Nothing yet
          </Empty>
        </Panel>
      </div>
      {interviewing && <InterviewDialog onClose={() => setInterviewing(false)} />}
    </Page>
  );
}
