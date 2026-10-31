"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";

import { Button, Empty, Notice, Page, Panel, Split } from "@/components/ds";
import { startPrdHref } from "@/components/RequestsBehind";
import { ErrorNote, INPUT_INLINE, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

import { FoundInSources } from "./FoundInSources";
import { RequestInspector } from "./RequestInspector";
import { RequestList, STATE } from "./RequestList";
import { RequestsHeader } from "./RequestsHeader";
import { NO_FILTERS, useRequestsState } from "./RequestsState";
import { Themes } from "./Themes";
import { useTriage } from "./Triage";

/** Which Requests tab: every request (the queue), those nobody has decided yet, or the themes. */
export type RequestsView = "all" | "new" | "themes";

/** A filter's control: its natural width beside the others, full width and 44 px high on a phone (qa-work-39). */
const FILTER = `${INPUT_INLINE} max-w-full max-[600px]:min-h-11 max-[600px]:w-full`;

/**
 * Requests (C1): the All requests, To decide and Themes tabs, one screen under the shared
 * header (RequestsHeader). All requests is the queue (#348): it filters by state, goal and
 * theme and searches titles and words; the requests Oracle found in your own sources sit above
 * it. To decide is the same queue held to the requests nobody has decided yet (qa-work-6: a
 * row opens the same inspector). A filed request lands in the list, selected. Ticking
 * qualified requests and Start a PRD opens New PRD with them behind the brief (C1 lane 2), for
 * those who can write a brief. Themes lists, creates, renames and archives themes. The
 * filters, ticked requests, selection and themes are the tabs' shared state (RequestsState), so
 * moving between tabs keeps them. To decide asks the API for the New requests themselves
 * (state=new), so an older one past the queue's first 200 still shows.
 * H10: Replies to send keeps the declined requests whose replies are still to send;
 * ?request=<id> (the Inbox's Open) lands on that request.
 */
export function RequestsScreen({ view }: { view: RequestsView }) {
  return (
    <Suspense fallback={null}>
      <Requests view={view} />
    </Suspense>
  );
}

function Requests({ view }: { view: RequestsView }) {
  const wanted = useSearchParams().get("request");
  const { can, capsReady, capsError } = useMe();
  const triage = useTriage();
  const run = triage.data;
  // Oracle's finds in your sources (All requests): read here, so the page waits for them (qa4-work-13).
  const findable = view === "all" && can("list_request_candidates");
  const found = useQuery<Schemas["CandidateOut"][]>(
    `request-candidates:${findable}:${run?.run_id ?? ""}:${run?.active ?? false}`,
    () => (findable ? unwrap(api.GET("/v1/request-candidates", { params: { query: { status: "open" } } })) : Promise.resolve([])),
    { keepPrevious: true },
  );
  const requests = useQuery("requests", () => unwrap(api.GET("/v1/requests", { params: { query: { limit: 200 } } })));
  // To decide's own list: the API's New requests, not the queue's first 200 filtered here.
  const undecided = useQuery(`requests:new:${view}`, () =>
    view === "new" ? unwrap(api.GET("/v1/requests", { params: { query: { state: "new", limit: 200 } } })) : Promise.resolve(null),
  );
  const listed = view === "new" ? undecided : requests;
  const goals = useQuery("request-goals", () => unwrap(api.GET("/v1/baseline/entities", { params: { query: { type: "goal" } } })));
  const goalTitles = useMemo(() => new Map((goals.data ?? []).map((g) => [g.id, g.title])), [goals.data]);
  const { themes, filters, setFilters, chosen, setChosen, picked, setPicked } = useRequestsState();
  const { goal, theme, search } = filters;
  // State and Replies to send are All requests' filters only: To decide does not show them.
  const state = view === "all" ? filters.state : "";
  // qa-work-40: Replies to send is for those who can send them, not viewers.
  const canReply = can("update_request_reply", true);
  const toSend = view === "all" && canReply && filters.toSend;
  // A request picked by hand stays picked across the tabs; a new ?request= (the Inbox's Open) wins.
  const selected = picked && picked.under === wanted ? picked.id : wanted;
  const setSelected = (id: string | null) => setPicked(id ? { id, under: wanted } : null);
  const router = useRouter();
  const canStart = can("create_intake", true);
  const filed = (request: Schemas["RequestOut"]) => {
    // Clear the filters so the filed request shows, selected.
    setFilters(NO_FILTERS);
    // On Themes, the filed request opens on All requests.
    if (view === "themes") return router.push(`/requests?request=${encodeURIComponent(request.id)}`);
    requests.setData((list) => list && { ...list, items: [request, ...list.items], total: list.total + 1 });
    undecided.setData((list) => list && { ...list, items: [request, ...list.items], total: list.total + 1 });
    setSelected(request.id);
  };
  const changed = (request: Schemas["RequestOut"]) => {
    requests.setData((list) => list && { ...list, items: list.items.map((r) => (r.id === request.id ? request : r)) });
    undecided.setData((list) => list && { ...list, items: list.items.map((r) => (r.id === request.id ? request : r)) });
    // A merge into a declined request changes that one too (its replies, asked again).
    if (request.state === "merged") {
      void requests.reload();
      void undecided.reload();
    }
    // Accepting Oracle's theme may create one; a decision moves request counts.
    themes.reload();
  };
  const themeChanged = (t: Schemas["RequestThemeOut"]) =>
    themes.setData((list) => (list?.some((x) => x.id === t.id) ? list.map((x) => (x.id === t.id ? t : x)) : [...(list ?? []), t]));
  const loaded = listed.data?.items ?? [];
  // To decide: the requests nobody has decided yet; one decided here stays in view while open.
  const all = view === "new" ? loaded.filter((r) => r.state === "new" || r.id === selected) : loaded;
  // The inspector's other requests (merge targets, Oracle's duplicate): the queue's and To decide's.
  const context = useMemo(() => {
    const extra = (undecided.data?.items ?? []).filter((r) => !requests.data?.items.some((x) => x.id === r.id));
    return [...(requests.data?.items ?? []), ...extra];
  }, [requests.data, undecided.data]);
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
  // qa4-work-17: a search or filter can hide the open request; the inspector says so.
  const hidden = !!current && !shown.some((r) => r.id === current.id);
  const onlySearch = !!text && !state && !goal && !theme && !toSend;
  const clear = (
    <Button variant="secondary" onClick={() => setFilters(NO_FILTERS)}>
      {onlySearch ? "Clear search" : "Clear filters"}
    </Button>
  );
  // qa4-work-13: the page draws once what the role may do, the list and Oracle's finds are in,
  // so the owner's controls and the finds never push the list down under the cursor. Once
  // drawn it stays: a later read (a triage run's new finds) does not blank it.
  const [drawn, setDrawn] = useState(false);
  const ready =
    drawn ||
    ((capsReady || !!capsError) &&
      (triage.data !== undefined || !!triage.error) &&
      (listed.data !== undefined || !!listed.error) &&
      (!findable || (found.data !== undefined && !found.loading) || !!found.error));
  if (ready && !drawn) setDrawn(true);
  return (
    <Page>
      <RequestsHeader triage={triage} onFiled={filed} />
      {!ready ? (
        <Panel testId="requests-loading">
          <div className="px-4 py-3">
            <Loading label="Loading requests…" />
          </div>
        </Panel>
      ) : (
        <div className="flex min-w-0 flex-col gap-4 max-[600px]:gap-3">
          {findable && <FoundInSources found={found} />}
          {view === "themes" ? (
            <Panel title="Themes" count={liveThemes.length}>
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
                  <div className="flex min-w-0 flex-col gap-2">
                    {hidden && (
                      <Notice testId="request-hidden" action={clear}>
                        {onlySearch ? "Your search hides this request from the list." : "Your filters hide this request from the list."}
                      </Notice>
                    )}
                    <RequestInspector
                      key={current.id}
                      request={current}
                      requests={context}
                      themes={themes.data ?? []}
                      goalTitles={goalTitles}
                      onChange={changed}
                      onTheme={themeChanged}
                    />
                  </div>
                )
              }
            >
              <Panel
                title={view === "new" ? "To decide" : "All requests"}
                count={listed.data ? (shown.length === all.length ? all.length : `${shown.length} of ${all.length}`) : undefined}
                testId={view === "new" ? "new-requests" : "all-requests"}
              >
                {listed.error && (
                  <div className="px-4 pt-3">
                    <ErrorNote>{listed.error}</ErrorNote>
                  </div>
                )}
                {all.length > 0 && (
                  <div
                    data-testid="request-filters"
                    className="flex flex-wrap items-end gap-2 border-b border-line px-4 py-3 max-[600px]:flex-col max-[600px]:items-stretch max-[600px]:px-3"
                  >
                    <input
                      type="search"
                      aria-label="Search requests"
                      placeholder="Search requests"
                      className={`${FILTER} min-w-0 flex-1 basis-48 max-[600px]:basis-auto`}
                      value={search}
                      onChange={(e) => setFilters({ search: e.target.value })}
                    />
                    {view === "all" && (
                      <select aria-label="State" className={FILTER} value={state} onChange={(e) => setFilters({ state: e.target.value })}>
                        <option value="">Any state</option>
                        {(Object.keys(STATE) as (keyof typeof STATE)[]).map((s) => (
                          <option key={s} value={s}>
                            {STATE[s].label}
                          </option>
                        ))}
                      </select>
                    )}
                    <select aria-label="Goal" className={FILTER} value={goal} onChange={(e) => setFilters({ goal: e.target.value })}>
                      <option value="">Any goal</option>
                      {[...goalTitles].map(([id, title]) => (
                        <option key={id} value={id}>
                          {title}
                        </option>
                      ))}
                    </select>
                    <select aria-label="Theme" className={FILTER} value={theme} onChange={(e) => setFilters({ theme: e.target.value })}>
                      <option value="">Any theme</option>
                      {/* Archived themes too (last, marked): their requests can still be found. */}
                      {[...liveThemes, ...(themes.data ?? []).filter((t) => t.archived)].map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.archived ? `${t.title} (archived)` : t.title}
                        </option>
                      ))}
                    </select>
                    {view === "all" && canReply && (
                      <label className="flex min-h-9 items-center gap-2 text-sm font-semibold text-text2 max-[600px]:min-h-11">
                        <input type="checkbox" className="max-[600px]:size-5" checked={toSend} onChange={(e) => setFilters({ toSend: e.target.checked })} />
                        Replies to send
                      </label>
                    )}
                  </div>
                )}
                {listed.data &&
                  (all.length > 0 && shown.length === 0 ? (
                    <div data-testid="requests-no-match" className="flex flex-col items-center gap-3 px-4 py-8 text-center">
                      <p className="text-[15px] text-text2">{onlySearch ? "No requests match your search" : "No requests match your filters"}</p>
                      {clear}
                    </div>
                  ) : (
                    <RequestList
                      requests={shown}
                      goalTitles={goalTitles}
                      selected={selected}
                      onSelect={setSelected}
                      chosen={view === "all" && canStart ? chosen : undefined}
                      onChoose={setChosen}
                      empty={
                        view === "new" && loaded.length > 0 ? (
                          <Empty testId="requests-empty">Every request has been decided</Empty>
                        ) : (
                          // qa-shell-10: the header's New request is the one button; this says to use it.
                          <Empty icon="requests" testId="requests-empty">
                            {can("create_request", true) ? "No requests yet. Add one with New request." : "No requests yet. They appear here once someone files one."}
                          </Empty>
                        )
                      }
                    />
                  ))}
                {view === "all" && chosen.length > 0 && (
                  // qa-work-8: the bar stays at the bottom of the screen, wherever the ticked row is
                  // (above the phone's bottom bar).
                  <div
                    data-testid="start-prd-bar"
                    className="sticky bottom-0 z-20 flex flex-wrap items-center gap-2 rounded-b-panel border-t border-line bg-surface px-4 py-3 shadow-tip max-[600px]:bottom-[68px] max-[600px]:px-3"
                  >
                    <Button variant="primary" className="max-[600px]:h-11" onClick={() => router.push(startPrdHref(chosen))}>
                      {`Start a PRD from ${plural(chosen.length, "request")}`}
                    </Button>
                    <Button variant="ghost" className="max-[600px]:h-11" onClick={() => setChosen([])}>
                      Clear
                    </Button>
                  </div>
                )}
              </Panel>
            </Split>
          )}
        </div>
      )}
    </Page>
  );
}
