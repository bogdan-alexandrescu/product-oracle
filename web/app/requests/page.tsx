"use client";

import { useMemo, useState } from "react";

import { Button, Empty, Page, PageHeader, Panel } from "@/components/ds";
import { ErrorNote } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { hasRole, useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

import { FoundInSources } from "./_components/FoundInSources";
import { InterviewDialog } from "./_components/InterviewDialog";
import { NewRequestButton } from "./_components/NewRequest";
import { RequestList } from "./_components/RequestList";
import { ClassifyNow, DailyTriageSwitch, TriageStatusLine, useTriage } from "./_components/Triage";

/**
 * Requests (C1). Oracle's triage: Classify now and the "Daily triage at 07:00 PT" switch
 * (approvers and owners; others see the switch's state) and its status line, and
 * the requests Oracle found in your own sources, yours alone until you file one. New request
 * (#329) files one in the app; it lands in the queue below, selected, with its goal chips.
 * Interview a customer (C3, commenters and up). The queue's tabs, facets and inspector come
 * with the Requests screen lane.
 */
export default function RequestsPage() {
  const { role } = useMe();
  const triage = useTriage();
  const run = triage.data;
  const requests = useQuery("requests", () => unwrap(api.GET("/v1/requests", { params: { query: { limit: 200 } } })));
  const goals = useQuery("request-goals", () => unwrap(api.GET("/v1/baseline/entities", { params: { query: { type: "goal" } } })));
  const goalTitles = useMemo(() => new Map((goals.data ?? []).map((g) => [g.id, g.title])), [goals.data]);
  const [selected, setSelected] = useState<string | null>(null);
  const filed = (request: Schemas["RequestOut"]) => {
    requests.setData((list) => list && { ...list, items: [request, ...list.items], total: list.total + 1 });
    setSelected(request.id);
  };
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
            <NewRequestButton onFiled={filed} />
          </>
        }
      />
      <div className="flex min-w-0 flex-col gap-4 max-[600px]:gap-3">
        {hasRole(role, "commenter") && <FoundInSources refresh={`${run?.run_id ?? ""}:${run?.active ?? false}`} />}
        <Panel>
          {requests.error && (
            <div className="px-4 pt-3">
              <ErrorNote>{requests.error}</ErrorNote>
            </div>
          )}
          {requests.data && (
            <RequestList
              requests={requests.data.items}
              goalTitles={goalTitles}
              selected={selected}
              onSelect={setSelected}
              empty={
                <div data-testid="requests-empty" className="flex flex-col items-center pb-10">
                  <Empty icon="requests">Nothing yet</Empty>
                  <NewRequestButton onFiled={filed} variant="secondary" />
                </div>
              }
            />
          )}
        </Panel>
      </div>
      {interviewing && <InterviewDialog onClose={() => setInterviewing(false)} />}
    </Page>
  );
}
