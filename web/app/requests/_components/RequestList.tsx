"use client";

import type { ReactNode } from "react";

import { Chip, type ChipKind } from "@/components/ds";
import { free } from "@/components/RequestsBehind";
import type { Schemas } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";

type Request = Schemas["RequestOut"];

export const STATE: Record<Request["state"], { label: string; kind: ChipKind }> = {
  new: { label: "New", kind: "na" },
  qualified: { label: "Qualified", kind: "pass" },
  merged: { label: "Merged", kind: "na" },
  disqualified: { label: "Disqualified", kind: "crit" },
};
export const CHANNEL_LABEL: Record<Request["channel"], string> = {
  support: "Support",
  sales: "Sales",
  team: "Team",
  interview: "Interview",
  slack: "Slack",
  meeting: "Meeting",
  doc: "Doc",
  other: "Other",
  in_app: "In app",
};

/** How long ago a request came in: "today", else whole days ("3d"). */
export function age(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return days < 1 ? "today" : `${days}d`;
}

/**
 * The request queue, newest first (#329, #348): each request's title, goal chips, state,
 * theme, requester, channel and age; the selected one is marked. `empty` shows when there
 * are none. With `chosen`, qualified requests behind no brief or PRD yet get a box to tick for
 * Start a PRD (C1 lane 2).
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
  return (
    <ul className="divide-y divide-line" data-testid="request-list">
      {requests.map((r) => {
        const on = r.id === selected;
        return (
          <li
            key={r.id}
            data-testid="request-row"
            aria-current={on ? "true" : undefined}
            className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 ${on ? "bg-accent-soft" : "hover:bg-surface2"}`}
          >
            {chosen && onChoose && free(r) && (
              <input
                type="checkbox"
                className="size-4 flex-none accent-[var(--accent)]"
                aria-label={`Select ${r.title}`}
                checked={chosen.includes(r.id)}
                onChange={(e) => onChoose(e.target.checked ? [...chosen, r.id] : chosen.filter((id) => id !== r.id))}
              />
            )}
            <button type="button" className="min-w-0 flex-1 basis-64 truncate text-left text-[15px] font-semibold" title={r.body ?? r.title} onClick={() => onSelect(r.id)}>
              {r.title}
            </button>
            <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-text2">
              {r.goal_ids.map((id) => (
                <Chip key={id} kind="acc" data-testid="goal-chip">
                  {goalTitles.get(id) ?? "A goal"}
                </Chip>
              ))}
              <Chip kind={STATE[r.state].kind}>{STATE[r.state].label}</Chip>
              {r.theme && <span className="truncate font-medium text-text">{r.theme.title}</span>}
              {r.requester_name && <span className="truncate">{r.requester_name}</span>}
              <Chip kind="line">{CHANNEL_LABEL[r.channel]}</Chip>
              <span data-testid="request-age" className="tnum" title={formatDateTime(r.created_at)}>
                {age(r.created_at)}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
