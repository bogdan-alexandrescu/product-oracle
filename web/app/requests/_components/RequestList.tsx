"use client";

import type { ReactNode } from "react";

import { Chip, type ChipKind } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";

type Request = Schemas["RequestOut"];

const STATE: Record<Request["state"], { label: string; kind: ChipKind }> = {
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

/**
 * The request queue, newest first (#329): each request's title, state, channel, requester
 * and goal chips; the selected one is marked. `empty` shows when there are none.
 */
export function RequestList({
  requests,
  goalTitles,
  selected,
  onSelect,
  empty,
}: {
  requests: Request[];
  goalTitles: Map<string, string>;
  selected: string | null;
  onSelect: (id: string) => void;
  empty: ReactNode;
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
            <button type="button" className="min-w-0 flex-1 basis-64 truncate text-left text-[15px] font-semibold" title={r.body ?? r.title} onClick={() => onSelect(r.id)}>
              {r.title}
            </button>
            <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-text2">
              <Chip kind={STATE[r.state].kind}>{STATE[r.state].label}</Chip>
              <Chip kind="line">{CHANNEL_LABEL[r.channel]}</Chip>
              {r.goal_ids.map((id) => (
                <Chip key={id} kind="acc" data-testid="goal-chip">
                  {goalTitles.get(id) ?? "A goal"}
                </Chip>
              ))}
              {r.requester_name && <span className="truncate">{r.requester_name}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
