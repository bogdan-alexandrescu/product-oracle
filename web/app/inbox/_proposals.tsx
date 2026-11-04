"use client";

import { Button, LinkButton } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";

import { isNew, type Act, type StatedNeed } from "./_needs";

type Proposal = Schemas["InboxSimpleChange"];

const upper = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * inbox-meeting-proposals: a meeting changes only what it reviews; what it asked for on an
 * item it does not review waits here for that item's owner (the API's `simple_proposals` made in
 * a meeting): the item by its name, what was asked in plain words, which meeting and when.
 * Accept applies it as Needs a decision does, Decline leaves the item; either way the row
 * leaves the Inbox. Only someone who may decide it (its `can_decide`) gets the buttons.
 */
export function meetingProposalRows(proposals: Proposal[], busy: string | null, act: Act, seenBefore: string | null | undefined): StatedNeed[] {
  return proposals
    .filter((p) => p.from_meeting)
    .map((p) => {
      const name = p.item_title ?? "An item";
      const path = { params: { path: { change_id: p.id } }, body: {} };
      return {
        key: `meeting-proposal-${p.id}`,
        icon: "roadmap",
        kind: "Meeting proposal",
        item: (
          <span className="min-w-0 truncate" title={name}>
            {name}
          </span>
        ),
        context: (
          <span className="block text-text2" data-testid="meeting-proposal-context">
            {upper(p.asked ?? "a change")} · asked for by the meeting {p.from_meeting!.title} on {formatDateTime(p.at)}
          </span>
        ),
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
