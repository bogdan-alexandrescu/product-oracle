"use client";

import { Empty, Page, PageHeader, Panel, ViewOnly } from "@/components/ds";
import { useMe } from "@/lib/me";

import { FoundInSources } from "./_components/FoundInSources";
import { ClassifyNow, DailyTriageSwitch, TriageStatusLine, useTriage } from "./_components/Triage";

/**
 * Requests (C1). Oracle's triage: Classify now and the "Daily triage at 07:00 PT" switch
 * (approvers and owners; others see the switch's state) and its status line, and
 * the requests Oracle found in your own sources, yours alone until you file one. The request
 * queue itself (table, inspector, Add request) comes with the Requests screen lane.
 */
export default function RequestsPage() {
  const { can, capsReady } = useMe();
  const triage = useTriage();
  const run = triage.data;
  return (
    <Page>
      <PageHeader
        title="Requests"
        status={
          <>
            {capsReady && !can("create_request") && <ViewOnly />}
            <TriageStatusLine status={run} />
          </>
        }
        action={
          capsReady && (
            <>
              <DailyTriageSwitch triage={triage} canChange={can("set_request_triage_daily")} />
              {can("start_request_triage") && <ClassifyNow triage={triage} />}
            </>
          )
        }
      />
      <div className="flex min-w-0 flex-col gap-4 max-[600px]:gap-3">
        {can("list_request_candidates") && <FoundInSources refresh={`${run?.run_id ?? ""}:${run?.active ?? false}`} />}
        <Panel>
          <Empty icon="requests" testId="requests-empty">
            Nothing yet
          </Empty>
        </Panel>
      </div>
    </Page>
  );
}
