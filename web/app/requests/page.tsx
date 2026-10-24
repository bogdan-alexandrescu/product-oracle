"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";

import { Button, Empty, Page, PageHeader, Panel, SegmentedControl, Split, ViewOnly } from "@/components/ds";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

import { FoundInSources } from "./_components/FoundInSources";
import { InterviewDialog } from "./_components/InterviewDialog";
import { NewRequestButton } from "./_components/NewRequest";
import { RequestInspector } from "./_components/RequestInspector";
import { RequestList, STATE } from "./_components/RequestList";
import { Themes } from "./_components/Themes";
import { ClassifyNow, DailyTriageSwitch, TriageStatusLine, useTriage } from "./_components/Triage";

/**
 * Requests (C1). Oracle's triage: Classify now and the "Daily triage at 07:00 PT" switch
 * (approvers and owners; others see the switch's state) and its status line, and
 * the requests Oracle found in your own sources, yours alone until you file one. New request
 * (#329) files one in the app; it lands in the queue below, selected, with its goal chips.
 * The queue (#348) filters by state, goal and theme and searches titles and words; the
 * selected request opens in the inspector. The Themes tab lists, creates, renames and
 * archives themes.
 * Interview a customer (C3, commenters and up). #370: each control shows only to a role that
 * can use it (can()); a role that can file nothing reads the page as View only.
 * H10: Replies to send keeps the declined requests whose replies are still to send;
 * ?request=<id> (the Inbox's Open) lands on that request.
 */
export default function RequestsPage() {
  return (
    <Suspense fallback={null}>
      <Requests />
    </Suspense>
  );
}

function Requests() {
  const wanted = useSearchParams().get("request");
  const { can, capsReady } = useMe();
  const triage = useTriage();
  const run = triage.data;
  const requests = useQuery("requests", () => unwrap(api.GET("/v1/requests", { params: { query: { limit: 200 } } })));
  const goals = useQuery("request-goals", () => unwrap(api.GET("/v1/baseline/entities", { params: { query: { type: "goal" } } })));
  const goalTitles = useMemo(() => new Map((goals.data ?? []).map((g) => [g.id, g.title])), [goals.data]);
  const themes = useQuery("request-themes", () => unwrap(api.GET("/v1/request-themes", { params: { query: { include_archived: true } } })));
  const [tab, setTab] = useState<"queue" | "themes">("queue");
  const [picked, setSelected] = useState<string | null>(null);
  const selected = picked ?? wanted;
  const [toSend, setToSend] = useState(false);
  const [state, setState] = useState("");
  const [goal, setGoal] = useState("");
  const [theme, setTheme] = useState("");
  const [search, setSearch] = useState("");
  const filed = (request: Schemas["RequestOut"]) => {
    requests.setData((list) => list && { ...list, items: [request, ...list.items], total: list.total + 1 });
    setSelected(request.id);
    // Clear the filters so the filed request shows, selected.
    setState("");
    setGoal("");
    setTheme("");
    setSearch("");
    setToSend(false);
    setTab("queue");
  };
  const changed = (request: Schemas["RequestOut"]) => {
    requests.setData((list) => list && { ...list, items: list.items.map((r) => (r.id === request.id ? request : r)) });
    // A merge into a declined request changes that one too (its replies, asked again).
    if (request.state === "merged") requests.reload();
    // Accepting Oracle's theme may create one; a decision moves request counts.
    themes.reload();
  };
  const themeChanged = (t: Schemas["RequestThemeOut"]) =>
    themes.setData((list) => (list?.some((x) => x.id === t.id) ? list.map((x) => (x.id === t.id ? t : x)) : [...(list ?? []), t]));
  const all = requests.data?.items ?? [];
  const text = search.trim().toLowerCase();
  const shown = all.filter(
    (r) =>
      (!state || r.state === state) &&
      (!goal || r.goal_ids.includes(goal)) &&
      (!theme || r.theme?.id === theme) &&
      (!toSend || (r.state === "disqualified" && r.replies.open > 0)) &&
      (!text || r.title.toLowerCase().includes(text) || (r.body ?? "").toLowerCase().includes(text)),
  );
  const current = all.find((r) => r.id === selected);
  const liveThemes = (themes.data ?? []).filter((t) => !t.archived);
  const [interviewing, setInterviewing] = useState(false);
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
              {can("create_interview") && <Button onClick={() => setInterviewing(true)}>Interview a customer</Button>}
              <NewRequestButton onFiled={filed} />
            </>
          )
        }
      />
      <div className="flex min-w-0 flex-col gap-4 max-[600px]:gap-3">
        {can("list_request_candidates") && <FoundInSources refresh={`${run?.run_id ?? ""}:${run?.active ?? false}`} />}
        <SegmentedControl
          label="Requests view"
          value={tab}
          onChange={setTab}
          items={[
            { value: "queue", label: "Queue", count: requests.data?.total ?? null },
            { value: "themes", label: "Themes", count: liveThemes.length || null },
          ]}
        />
        {tab === "themes" ? (
          <Panel>
            {themes.error && (
              <div className="px-4 pt-3">
                <ErrorNote>{themes.error}</ErrorNote>
              </div>
            )}
            {themes.data && <Themes themes={themes.data} onChange={themeChanged} />}
          </Panel>
        ) : (
          <Split
            inspector={
              current && (
                <RequestInspector
                  key={current.id}
                  request={current}
                  requests={all}
                  themes={themes.data ?? []}
                  goalTitles={goalTitles}
                  onChange={changed}
                  onTheme={themeChanged}
                />
              )
            }
          >
            <Panel>
              {requests.error && (
                <div className="px-4 pt-3">
                  <ErrorNote>{requests.error}</ErrorNote>
                </div>
              )}
              {all.length > 0 && (
                <div data-testid="request-filters" className="flex flex-wrap items-end gap-2 border-b border-line px-4 py-3">
                  <input
                    type="search"
                    aria-label="Search requests"
                    placeholder="Search requests"
                    className={`${INPUT} min-w-0 flex-1 basis-48`}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  <select aria-label="State" className={`${INPUT} w-auto`} value={state} onChange={(e) => setState(e.target.value)}>
                    <option value="">Any state</option>
                    {(Object.keys(STATE) as (keyof typeof STATE)[]).map((s) => (
                      <option key={s} value={s}>
                        {STATE[s].label}
                      </option>
                    ))}
                  </select>
                  <select aria-label="Goal" className={`${INPUT} w-auto max-w-full`} value={goal} onChange={(e) => setGoal(e.target.value)}>
                    <option value="">Any goal</option>
                    {[...goalTitles].map(([id, title]) => (
                      <option key={id} value={id}>
                        {title}
                      </option>
                    ))}
                  </select>
                  <select aria-label="Theme" className={`${INPUT} w-auto max-w-full`} value={theme} onChange={(e) => setTheme(e.target.value)}>
                    <option value="">Any theme</option>
                    {/* Archived themes too (last, marked): their requests can still be found. */}
                    {[...liveThemes, ...(themes.data ?? []).filter((t) => t.archived)].map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.archived ? `${t.title} (archived)` : t.title}
                      </option>
                    ))}
                  </select>
                  <label className="flex items-center gap-2 py-2 text-sm font-semibold text-text2">
                    <input type="checkbox" checked={toSend} onChange={(e) => setToSend(e.target.checked)} />
                    Replies to send
                  </label>
                </div>
              )}
              {requests.data &&
                (all.length > 0 && shown.length === 0 ? (
                  <Empty>No requests match</Empty>
                ) : (
                  <RequestList
                    requests={shown}
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
                ))}
            </Panel>
          </Split>
        )}
      </div>
      {interviewing && <InterviewDialog onClose={() => setInterviewing(false)} />}
    </Page>
  );
}
