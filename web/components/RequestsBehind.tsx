"use client";

import { useEffect } from "react";

import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useQuery } from "@/lib/use-query";

type Request = Schemas["RequestOut"];

/** The New PRD address of Start a PRD (C1 lane 2): the brief with these requests ticked. */
export function startPrdHref(ids: string[]): string {
  return `/documents/new?kind=prd&requests=${ids.join(",")}`;
}

/** Start a PRD offers a request only while it is qualified and behind no brief or PRD yet
 * (rules 2 and 7: the API refuses one already taken with 409). */
export function free(r: Request): boolean {
  return r.state === "qualified" && !r.intake_id && !r.document;
}

/** The theme groups of the qualified requests, by theme title; "No theme" last. */
function byTheme(requests: Request[]): [string, Request[]][] {
  const groups = new Map<string, Request[]>();
  for (const r of requests) {
    const key = r.theme?.title ?? "";
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups].sort(([a], [b]) => (!a ? 1 : !b ? -1 : a.localeCompare(b)));
}

/**
 * The brief's "Requests behind it" (C1 lane 2): every qualified request not yet behind a brief
 * or a PRD, grouped by theme, to tick. Continue links the ticked ones to the brief, and the PRD
 * its run makes to them. Ticked ones that are taken drop out. Hidden when none is free.
 */
export function RequestsBehind({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const requests = useQuery("brief-requests", () =>
    unwrap(api.GET("/v1/requests", { params: { query: { state: "qualified", limit: 200 } } })),
  );
  const items = (requests.data?.items ?? []).filter(free);
  const loaded = requests.data !== null && requests.data !== undefined;
  const offered = items.map((r) => r.id).join(",");
  useEffect(() => {
    if (!loaded) return;
    const kept = value.filter((id) => offered.split(",").includes(id));
    if (kept.length !== value.length) onChange(kept);
  }, [loaded, offered, value, onChange]);
  if (requests.data && items.length === 0) return null;
  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 text-[15px] font-semibold text-text">
        Requests behind it <span className="font-normal text-text2">Optional</span>
      </legend>
      {requests.error && <ErrorNote>{requests.error}</ErrorNote>}
      {requests.loading && <Loading />}
      <div className="flex flex-col gap-3">
        {byTheme(items).map(([theme, rows]) => (
          <div key={theme || "none"} data-testid="requests-theme" className="flex min-w-0 flex-col gap-1.5">
            <p className="text-sm font-semibold text-text2">{theme || "No theme"}</p>
            {rows.map((r) => {
              const checked = value.includes(r.id);
              return (
                <label
                  key={r.id}
                  className={`flex min-w-0 cursor-pointer items-center gap-2.5 rounded-button border px-3 py-2 ${
                    checked ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="size-4 flex-none accent-[var(--accent)]"
                    checked={checked}
                    onChange={(e) => onChange(e.target.checked ? [...value, r.id] : value.filter((id) => id !== r.id))}
                  />
                  <span className="min-w-0 flex-1 font-semibold text-text [overflow-wrap:anywhere]">{r.title}</span>
                </label>
              );
            })}
          </div>
        ))}
      </div>
    </fieldset>
  );
}
