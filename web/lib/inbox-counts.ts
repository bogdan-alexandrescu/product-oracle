import type { Schemas } from "@/lib/api/client";

type Inbox = Schemas["InboxOut"];
export type InboxCounts = Schemas["InboxCountsOut"];

/** Proposals on a PRD question or a one-pager line or number: not the roadmap's (PR 1320 re-review). */
const NOT_ROADMAP_OPS = ["decide_question", "name_decider", "edit_line", "set_section_number"];

/**
 * inbox-reads: the Inbox's counts as GET /v1/inbox/counts gives them, from a whole Inbox read
 * (a page that reads it anyway: the rail takes its counts from it, no call of its own). `roadmap`:
 * of `total`, what the Simple Roadmap tab counts too (inbox-meeting-proposals fix).
 */
export function inboxCounts(inbox: Inbox): InboxCounts {
  return {
    total: inbox.total,
    roadmap:
      inbox.simple_proposals.filter((x) => !NOT_ROADMAP_OPS.includes(x.op)).length +
      inbox.simple_approvals.length +
      inbox.simple_goal_suggestions.length +
      (inbox.simple_track_suggestions?.filter((x) => !x.proposed).length ?? 0),
  };
}
