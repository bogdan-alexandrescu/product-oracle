"use client";

import type { ReactNode } from "react";

import { Chip, type ChipKind } from "@/components/ds";
import { free } from "@/components/RequestsBehind";
import type { Schemas } from "@/lib/api/client";
import { formatAge, formatDateTime } from "@/lib/format";

type Request = Schemas["RequestOut"];

export const STATE: Record<Request["state"], { label: string; kind: ChipKind }> = {
  new: { label: "New", kind: "na" },
  qualified: { label: "Qualified", kind: "pass" },
  merged: { label: "Merged", kind: "na" },
  disqualified: { label: "Disqualified", kind: "crit" },
};
export const CHANNEL_LABEL: Record<Request["channel"], string> = {
  in_app: "In app",
  support: "Support",
  sales: "Sales",
  slack: "Slack",
  interview: "Interview",
  meeting: "Meeting",
  team: "Team",
  doc: "Doc",
  other: "Other",
};

/** Why a request has no box to tick for Start a PRD. */
function notFree(r: Request): string {
  if (r.state !== "qualified") return "Only a qualified request starts a PRD";
  return "Already behind a brief or a PRD";
}

/** The meta columns, in this order on every row (qa-work-36): state, goal, theme, asker, channel, age. */
const META_COLS = [
  { key: "state", label: "State" },
  { key: "goal", label: "Goal" },
  { key: "theme", label: "Theme" },
  { key: "asker", label: "Asked by" },
  { key: "channel", label: "Channel" },
  { key: "age", label: "Age" },
] as const;

/** One grid for the meta line and its header, so each field sits in its own column on every row. */
const META_GRID =
  "grid min-w-0 flex-1 grid-cols-[6.5rem_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_5.5rem_3rem] items-center gap-x-3 max-[600px]:grid-cols-2 max-[600px]:gap-y-1.5";

/** The checkbox slot: on every row when ticking is offered, so titles line up (qa-work-35); 44 px on a phone. */
const BOX_SLOT = "mt-1 flex size-6 flex-none items-center justify-center max-[600px]:mt-0 max-[600px]:-ml-2.5 max-[600px]:size-11";

const none = <span className="text-text2">—</span>;

/**
 * The request queue, newest first (#329, #348): each request's title on its first line, then
 * its state, goals, theme, requester, channel and age in fixed, labelled columns; the selected
 * one is marked, and a click anywhere on a row opens it. `empty` shows when there are none.
 * With `chosen`, every row has a box to tick for Start a PRD (C1 lane 2), enabled on the
 * qualified requests behind no brief or PRD yet.
 */
export function RequestList({
  requests,
  goalTitles,
  selected,
  onSelect,
  empty,
  chosen,
  onChoose,
}: {
  requests: Request[];
  goalTitles: Map<string, string>;
  selected: string | null;
  onSelect: (id: string) => void;
  empty: ReactNode;
  /** The qualified requests ticked for Start a PRD; absent: nothing to tick. */
  chosen?: string[];
  onChoose?: (ids: string[]) => void;
}) {
  if (requests.length === 0) return <>{empty}</>;
  const ticking = !!(chosen && onChoose);
  return (
    <div>
      <div
        aria-hidden
        data-testid="request-list-head"
        className="flex items-center gap-3 border-b border-line bg-surface2 px-4 py-1.5 text-[13px] leading-4 font-semibold text-text2 max-[600px]:hidden"
      >
        {ticking && <span className="w-6 flex-none" />}
        {/* The title is the row's first line; these name the columns of its second. */}
        <div className={META_GRID}>
          {META_COLS.map((c) => (
            <span key={c.key}>{c.label}</span>
          ))}
        </div>
      </div>
      <ul className="divide-y divide-line" data-testid="request-list">
        {requests.map((r) => {
          const on = r.id === selected;
          const goals = r.goal_ids.map((id) => goalTitles.get(id) ?? "A goal");
          const cells: Record<(typeof META_COLS)[number]["key"], ReactNode> = {
            state: <Chip kind={STATE[r.state].kind}>{STATE[r.state].label}</Chip>,
            goal: goals.length ? (
              <span className="flex min-w-0 flex-wrap gap-1" title={goals.join(", ")}>
                {goals.map((g, i) => (
                  <Chip key={r.goal_ids[i]} kind="acc" data-testid="goal-chip" className="min-w-0">
                    <span className="truncate">{g}</span>
                  </Chip>
                ))}
              </span>
            ) : (
              none
            ),
            theme: r.theme ? (
              <span className="truncate font-medium text-text" title={r.theme.title}>
                {r.theme.title}
              </span>
            ) : (
              none
            ),
            asker: r.requester_name ? (
              <span className="truncate" title={r.requester_name}>
                {r.requester_name}
              </span>
            ) : (
              none
            ),
            channel: <Chip kind="line">{CHANNEL_LABEL[r.channel]}</Chip>,
            age: (
              <span data-testid="request-age" className="tnum" title={formatDateTime(r.created_at)}>
                {formatAge(r.created_at)}
              </span>
            ),
          };
          return (
            <li
              key={r.id}
              id={`request-${r.id}`}
              data-testid="request-row"
              data-channel={r.channel}
              aria-current={on ? "true" : undefined}
              onClick={() => onSelect(r.id)}
              className={`flex cursor-pointer items-start gap-3 px-4 py-2.5 ${on ? "bg-accent-soft shadow-[inset_4px_0_0_var(--accent)]" : "hover:bg-surface2"}`}
            >
              {ticking && (
                <label
                  data-testid="request-choose"
                  className={`${BOX_SLOT} ${free(r) ? "cursor-pointer" : "cursor-not-allowed"}`}
                  title={free(r) ? undefined : notFree(r)}
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--accent)] disabled:cursor-not-allowed"
                    aria-label={`Select ${r.title}`}
                    disabled={!free(r)}
                    checked={chosen!.includes(r.id)}
                    onChange={(e) => onChoose!(e.target.checked ? [...chosen!, r.id] : chosen!.filter((id) => id !== r.id))}
                  />
                </label>
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex min-w-0 items-center gap-2">
                  <button
                    type="button"
                    className="min-h-8 min-w-0 flex-1 truncate text-left text-[15px] font-semibold max-[600px]:min-h-11 max-[600px]:whitespace-normal max-[600px]:[overflow-wrap:anywhere]"
                    title={r.body ?? r.title}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(r.id);
                    }}
                  >
                    {r.title}
                  </button>
                  {!r.verified && (
                    // C3: a customer's own words from an interview are taken as given, not checked.
                    <Chip kind="warn" data-testid="request-unverified" title="In the customer's own words from an interview: taken as given, not checked">
                      Unverified
                    </Chip>
                  )}
                </div>
                <div className={`${META_GRID} text-sm text-text2`}>
                  {META_COLS.map((c) => (
                    <div key={c.key} data-field={c.key} className="flex min-w-0 items-center gap-1.5">
                      <span className="sr-only text-[13px] font-semibold text-text2 max-[600px]:not-sr-only max-[600px]:flex-none">{c.label}</span>
                      {cells[c.key]}
                    </div>
                  ))}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
