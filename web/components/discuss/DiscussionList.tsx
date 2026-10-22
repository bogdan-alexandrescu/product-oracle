"use client";

import { Chip, Empty, Icon } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";

export type DiscussionSummary = Schemas["DiscussionSummary"];
export type HiddenDiscussion = Schemas["HiddenDiscussion"];
export type DiscussionRow = DiscussionSummary | HiddenDiscussion;

/** A private discussion the reader is not in: only that it exists (and a shared summary). */
export function isHidden(row: DiscussionRow): row is HiddenDiscussion {
  return "hidden" in row && row.hidden === true;
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function Lock() {
  return (
    <span role="img" aria-label="Private" title="Private" className="flex-none text-text2" data-testid="discussion-lock">
      <Icon name="lock" size={16} />
    </span>
  );
}

/**
 * One line per discussion: its title, who started it, its messages and last activity. A
 * private one shows a lock; one the reader is not in reads "Private discussion" and nothing
 * else, or the summary its starter shared. `version`: the version on screen, so a discussion
 * started on another reads "Started on v3".
 */
export function DiscussionList({
  rows,
  onOpen,
  version,
  empty = "No discussions yet",
}: {
  rows: DiscussionRow[];
  onOpen: (id: string) => void;
  version?: number;
  empty?: string;
}) {
  if (rows.length === 0) return <Empty testId="discussions-empty">{empty}</Empty>;
  return (
    <ol className="flex flex-col" aria-label="Discussions">
      {rows.map((row) => (
        <li key={row.id} className="border-b border-line last:border-b-0">
          <button
            type="button"
            data-testid="discussion-row"
            data-hidden={isHidden(row) ? "true" : undefined}
            onClick={() => onOpen(row.id)}
            className="flex w-full min-w-0 flex-col gap-1 py-3 text-left hover:bg-surface2 max-[639px]:min-h-11"
          >
            {isHidden(row) ? (
              <>
                <span className="flex min-w-0 items-center gap-1.5 text-[15px] font-semibold text-text">
                  <Lock />
                  Private discussion
                </span>
                {row.summary && <span className="text-sm leading-5 break-words text-text2">{row.summary}</span>}
              </>
            ) : (
              <>
                <span className="flex min-w-0 items-center gap-1.5">
                  {row.visibility === "private" && <Lock />}
                  <span className="min-w-0 text-[15px] leading-[22px] font-semibold break-words text-text">{row.title}</span>
                </span>
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-text2">
                  <span className="min-w-0 truncate">{row.subject_label}</span>
                  {row.status === "closed" && <Chip kind="na">Closed</Chip>}
                  {version != null && row.started_on_version != null && row.started_on_version !== version && (
                    <Chip kind="line">Started on v{row.started_on_version}</Chip>
                  )}
                </span>
                <span className="tnum flex flex-wrap gap-x-2 text-[13px] text-text2">
                  <span>{row.started_by.name}</span>
                  <span>{plural(row.message_count, "message", "messages")}</span>
                  {row.last_message_at && <span>{formatDateTime(row.last_message_at)}</span>}
                  {row.me.unread > 0 && <Chip kind="acc">{row.me.unread} new</Chip>}
                </span>
              </>
            )}
          </button>
        </li>
      ))}
    </ol>
  );
}
