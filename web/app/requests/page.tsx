"use client";

import { useMemo, useState } from "react";

import { Empty, Page, PageHeader, Panel, ViewOnly } from "@/components/ds";
import { ErrorNote } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

import { FoundInSources } from "./_components/FoundInSources";
import { NewRequestButton } from "./_components/NewRequest";
import { RequestList } from "./_components/RequestList";
import { ClassifyNow, DailyTriageSwitch, TriageStatusLine, useTriage } from "./_components/Triage";

/**
 * Requests (C1). Oracle's triage: Classify now and the "Daily triage at 07:00 PT" switch
 * (approvers and owners; others see the switch's state) and its status line, and
 * the requests Oracle found in your own sources, yours alone until you file one. New request
 * (#329) files one in the app; it lands in the queue below, selected, with its goal chips.
 * The queue's tabs, facets and inspector come with the Requests screen lane.
 */
export default function RequestsPage() {
  const { can, capsReady } = useMe();
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
  return (
    <Page>
      <PageHeader
        title="Requests"
        status={
          <>
            {capsReady && !can("create_request", true) && <ViewOnly />}
            <TriageStatusLine status={run} />
          </>
        }
        action={
          capsReady && (
            <>
              <DailyTriageSwitch triage={triage} canChange={can("set_request_triage_daily")} />
              {can("start_request_triage") && <ClassifyNow triage={triage} />}
              <NewRequestButton onFiled={filed} />
            </>
          )
        }
      />
      <div className="flex min-w-0 flex-col gap-4 max-[600px]:gap-3">
        {can("list_request_candidates") && <FoundInSources refresh={`${run?.run_id ?? ""}:${run?.active ?? false}`} />}
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
    </Page>
  );
}
