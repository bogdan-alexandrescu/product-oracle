"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";

import { Button, Empty, Page, Panel, Split } from "@/components/ds";
import { startPrdHref } from "@/components/RequestsBehind";
import { ErrorNote, INPUT_INLINE } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

import { FoundInSources } from "./FoundInSources";
import { NewRequestButton } from "./NewRequest";
import { RequestInspector } from "./RequestInspector";
import { RequestList, STATE } from "./RequestList";
import { RequestsHeader } from "./RequestsHeader";
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
 * those who can write a brief. Themes lists, creates, renames and archives themes.
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
  const { can } = useMe();
  const triage = useTriage();
  const run = triage.data;
  const requests = useQuery("requests", () => unwrap(api.GET("/v1/requests", { params: { query: { limit: 200 } } })));
  const goals = useQuery("request-goals", () => unwrap(api.GET("/v1/baseline/entities", { params: { query: { type: "goal" } } })));
  const goalTitles = useMemo(() => new Map((goals.data ?? []).map((g) => [g.id, g.title])), [goals.data]);
  const themes = useQuery("request-themes", () => unwrap(api.GET("/v1/request-themes", { params: { query: { include_archived: true } } })));
  const [picked, setSelected] = useState<string | null>(null);
  const selected = picked ?? wanted;
  const [toSend, setToSend] = useState(false);
  const [state, setState] = useState("");
  const [goal, setGoal] = useState("");
  const [theme, setTheme] = useState("");
  const [search, setSearch] = useState("");
  const router = useRouter();
  // C1 lane 2: the qualified requests ticked for Start a PRD.
  const [chosen, setChosen] = useState<string[]>([]);
  const canStart = can("create_intake", true);
  const filed = (request: Schemas["RequestOut"]) => {
    // On Themes, the filed request opens on All requests.
    if (view === "themes") return router.push(`/requests?request=${encodeURIComponent(request.id)}`);
    requests.setData((list) => list && { ...list, items: [request, ...list.items], total: list.total + 1 });
    setSelected(request.id);
    // Clear the filters so the filed request shows, selected.
    setState("");
    setGoal("");
    setTheme("");
    setSearch("");
    setToSend(false);
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
  const loaded = requests.data?.items ?? [];
  // To decide: the requests nobody has decided yet; one decided here stays in view while open.
  const all = view === "new" ? loaded.filter((r) => r.state === "new" || r.id === selected) : loaded;
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
  return (
    <Page>
      <RequestsHeader triage={triage} onFiled={filed} />
      <div className="flex min-w-0 flex-col gap-4 max-[600px]:gap-3">
        {view === "all" && can("list_request_candidates") && <FoundInSources refresh={`${run?.run_id ?? ""}:${run?.active ?? false}`} />}
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
                <RequestInspector
                  key={current.id}
                  request={current}
                  requests={loaded}
                  themes={themes.data ?? []}
                  goalTitles={goalTitles}
                  onChange={changed}
                  onTheme={themeChanged}
                />
              )
            }
          >
            <Panel
              title={view === "new" ? "To decide" : "All requests"}
              count={requests.data ? (shown.length === all.length ? all.length : `${shown.length} of ${all.length}`) : undefined}
              testId={view === "new" ? "new-requests" : "all-requests"}
            >
              {requests.error && (
                <div className="px-4 pt-3">
                  <ErrorNote>{requests.error}</ErrorNote>
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
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  {view === "all" && (
                    <select aria-label="State" className={FILTER} value={state} onChange={(e) => setState(e.target.value)}>
                      <option value="">Any state</option>
                      {(Object.keys(STATE) as (keyof typeof STATE)[]).map((s) => (
                        <option key={s} value={s}>
                          {STATE[s].label}
                        </option>
                      ))}
                    </select>
                  )}
                  <select aria-label="Goal" className={FILTER} value={goal} onChange={(e) => setGoal(e.target.value)}>
                    <option value="">Any goal</option>
                    {[...goalTitles].map(([id, title]) => (
                      <option key={id} value={id}>
                        {title}
                      </option>
                    ))}
                  </select>
                  <select aria-label="Theme" className={FILTER} value={theme} onChange={(e) => setTheme(e.target.value)}>
                    <option value="">Any theme</option>
                    {/* Archived themes too (last, marked): their requests can still be found. */}
                    {[...liveThemes, ...(themes.data ?? []).filter((t) => t.archived)].map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.archived ? `${t.title} (archived)` : t.title}
                      </option>
                    ))}
                  </select>
                  {view === "all" && (
                    <label className="flex min-h-9 items-center gap-2 text-sm font-semibold text-text2 max-[600px]:min-h-11">
                      <input type="checkbox" className="max-[600px]:size-5" checked={toSend} onChange={(e) => setToSend(e.target.checked)} />
                      Replies to send
                    </label>
                  )}
                </div>
              )}
              {view === "all" && chosen.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
                  <Button variant="primary" onClick={() => router.push(startPrdHref(chosen))}>
                    {`Start a PRD from ${plural(chosen.length, "request")}`}
                  </Button>
                  <Button variant="ghost" onClick={() => setChosen([])}>
                    Clear
                  </Button>
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
                    chosen={view === "all" && canStart ? chosen : undefined}
                    onChoose={setChosen}
                    empty={
                      view === "new" && loaded.length > 0 ? (
                        <Empty testId="requests-empty">Every request has been decided</Empty>
                      ) : (
                        <div data-testid="requests-empty" className="flex flex-col items-center pb-10">
                          <Empty icon="requests">Nothing yet</Empty>
                          <NewRequestButton onFiled={filed} variant="secondary" />
                        </div>
                      )
                    }
                  />
                ))}
            </Panel>
          </Split>
        )}
      </div>
    </Page>
  );
}
