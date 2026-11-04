"use client";

import { Button, LinkButton } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";

import { isNew, type Act, type StatedNeed } from "./_needs";

type Proposal = Schemas["InboxSimpleChange"];

const upper = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Who or what asked for it: a meeting by its name, Ask Oracle for a teammate, or the teammate. */
function askedBy(p: Proposal): string {
  if (p.from_meeting) return `asked for by the meeting ${p.from_meeting.title}`;
  if (p.from_ask) return `asked through Ask Oracle by ${p.by_name}`;
  return `asked for by ${p.by_name}`;
}

/**
 * inbox-meeting-proposals: every Simple proposal waiting on me (the API's `simple_proposals`):
 * one a meeting asked for on an item it does not review, one asked through Ask Oracle, one a
 * teammate made on the page. Each says the item by its name, what was asked in plain words, who
 * or what asked and when. Accept applies it as Needs a decision does, Decline leaves the item;
 * either way the row leaves the Inbox. Only someone who may decide it (its `can_decide`) gets
 * the buttons.
 */
export function proposalRows(proposals: Proposal[], busy: string | null, act: Act, seenBefore: string | null | undefined): StatedNeed[] {
  return proposals
    .map((p) => {
      const name = p.item_title ?? "An item";
      const path = { params: { path: { change_id: p.id } }, body: {} };
      return {
        key: `proposal-${p.id}`,
        icon: "roadmap",
        kind: "Proposal",
        // The item cell keeps its room (it wraps): what was asked, by whom or what and when, under the name.
        item: (
          <>
            <span className="min-w-0 truncate" title={name}>
              {name}
            </span>
            <span className="block basis-full text-sm break-words whitespace-normal text-text2" data-testid="meeting-proposal-context">
              {upper(p.asked ?? "a change")} · {askedBy(p)} on {formatDateTime(p.at)}
            </span>
          </>
        ),
        context: <span className="block truncate text-text2">{p.from_meeting ? "Not on that meeting's agenda" : p.reason?.trim() || "Waiting for your decision"}</span>,
        at: p.at,
        state: isNew(p.at, seenBefore) ? "new" : "open",
        counted: true,
        group: "proposals",
        action: (
          <>
            {p.can_decide && (
              <>
                <Button disabled={busy !== null} onClick={() => act(`proposal-accept-${p.id}`, () => unwrap(api.POST("/v1/simple/changes/{change_id}/accept", path)))}>
                  Accept
                </Button>
                <Button variant="ghost" disabled={busy !== null} onClick={() => act(`proposal-decline-${p.id}`, () => unwrap(api.POST("/v1/simple/changes/{change_id}/decline", path)))}>
                  Decline
                </Button>
              </>
            )}
            {p.document_id && (
              <LinkButton href={`/simple/roadmap?roadmap=${p.document_id}&review=proposals`} aria-label={`Open ${name} on its roadmap`}>
                Open
              </LinkButton>
            )}
          </>
        ),
      };
    });
}
