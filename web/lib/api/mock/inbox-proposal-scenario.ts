import { stableUuid } from './ids';

import type { Schemas } from '../client';
import type { SimpleDb } from './simple-roadmap';

/**
 * inbox-2 (#1893), the "inbox-replaced-proposal" scenario (on "one-roadmap", invented data): a
 * commenter asked to make themselves the owner of Trusted seller badge, an item of the replaced
 * Trust plan, and it still waits on the company's owner. The Inbox counts it, so Decisions'
 * Waiting for you lists it too (waiting_reads.proposals). And a meeting's owner change on Block
 * list, routed to the commenter, who may not decide it: their Waiting for you opens it in the Inbox.
 * inbox-codes (#1786): the badge came from its PRD's section F-45, so its row names it "F-45 Trusted
 * seller badge", though no roadmap Simple reads holds it; so does the Owner's action item on it.
 */
export const INBOX_REPLACED_PROPOSAL_SCENARIO = 'inbox-replaced-proposal';

export function seedReplacedProposal(db: SimpleDb, members: Schemas['MemberOut'][]): void {
  const owner = members.find((m) => m.email === 'admin@example.com')!;
  const commenter = members.find((m) => m.email === 'commenter@example.com')!;
  const badge = db.items.find((s) => s.key === 'trusted-badge');
  if (badge) badge.section = 'f-45';
  // #1913: Block list too (F-46), so its waiting rows name it by code and name.
  const blocks = db.items.find((s) => s.key === 'block-list');
  if (blocks) blocks.section = 'f-46';
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
  (db.targets ??= {})[stableUuid('simple-action/inbox-replaced-badge')] = {
    kind: 'action_item',
    title: 'Check the badge rules',
    owner_id: owner.id,
    due_date: null,
    status: 'open',
    item_id: db.ids['trusted-badge'],
    meeting_id: null,
    at: '2026-11-20T09:00:00Z',
  };
}
