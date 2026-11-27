import { stableUuid } from './ids';

import type { Schemas } from '../client';
import type { SimpleDb } from './simple-roadmap';

/**
 * inbox-2 (#1893), the "inbox-replaced-proposal" scenario (on "one-roadmap", invented data): a
 * commenter asked to make themselves the owner of Trusted seller badge, an item of the replaced
 * Trust plan, and it still waits on the company's owner. The Inbox counts it, so Decisions'
 * Waiting for you lists it too (waiting_reads.proposals). And a meeting's owner change on Block
 * list, routed to the commenter, who may not decide it: their Waiting for you opens it in the Inbox.
 */
export const INBOX_REPLACED_PROPOSAL_SCENARIO = 'inbox-replaced-proposal';

export function seedReplacedProposal(db: SimpleDb, members: Schemas['MemberOut'][]): void {
  const owner = members.find((m) => m.email === 'admin@example.com')!;
  const commenter = members.find((m) => m.email === 'commenter@example.com')!;
  (db.changes ??= []).push({
    id: stableUuid('simple-proposal/inbox-replaced-owner'),
    session_id: null,
    document_id: null,
    draft_ids: [],
    op: 'set_owner',
    target: { item_id: db.ids['trusted-badge'] },
    before: { owner_id: null },
    after: { owner_id: commenter.id },
    status: 'proposed',
    by: commenter.id,
    by_name: commenter.name ?? commenter.email,
    at: '2026-11-20T10:00:00Z',
    decided_by: null,
    decided_at: null,
    reason: null,
    decision_reason: null,
    routed_to: [owner.id],
    undoes_id: null,
    undone: false,
    can_decide: false,
    can_undo: false,
  });
  // inbox-2 re-review: routed to the commenter (a meeting's), who may not decide it now.
  const routed = stableUuid('simple-proposal/inbox-routed-commenter');
  db.changes.push({
    ...db.changes[db.changes.length - 1],
    id: routed,
    target: { item_id: db.ids['block-list'] },
    after: { owner_id: owner.id },
    by: owner.id,
    by_name: owner.name ?? owner.email,
    at: '2026-11-21T10:00:00Z',
    routed_to: [commenter.id],
  });
  (db.meeting_proposals ??= []).push(routed);
}
