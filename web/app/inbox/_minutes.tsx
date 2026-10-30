"use client";

import { LinkButton } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";

import type { StatedNeed } from "./_needs";

type Minutes = Schemas["InboxSimpleMinutes"];

/**
 * A review meeting's minutes, sent to each attendee (Simple's end screen: "Each attendee's
 * Inbox"; the API's `simple_minutes`). Open goes to the Decisions page by that meeting, where
 * the minutes read beside its decisions. Shown, not counted: nothing waits on the attendee.
 */
export function minutesRows(rows: Minutes[]): StatedNeed[] {
  return rows.map((m) => ({
    key: `minutes-${m.meeting_id}`,
    icon: "doc",
    kind: "Meeting minutes",
    item: (
      <span className="min-w-0 truncate" title={m.title}>
        {m.title}
      </span>
    ),
    context: <span className="text-text2">{m.decisions === 1 ? "1 decision" : `${m.decisions} decisions`}</span>,
    at: m.sent_at,
    state: m.state,
    counted: false,
    group: "minutes",
    action: <LinkButton href={`/simple/decisions?meeting=${m.meeting_id}`}>Open</LinkButton>,
  }));
}
