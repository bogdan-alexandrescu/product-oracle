import { mockNowMs } from './clock';
import { canDecideItem, roadmapId, shownCode, type SimpleDb } from './simple-roadmap';

import type { Schemas } from '../client';

type Row = Schemas['InboxSimpleActionItem'];
type Minutes = Schemas['SimpleMinutes'];
type Me = Parameters<typeof canDecideItem>[2];

/**
 * #1817: the mock of oracle.simple.meeting_actions. A meeting's action items are stored with
 * the other non-versioned targets (`db.targets`, kind `action_item`), as add_action_item stores
 * them; the open ones a person owns are rows of their Inbox (counted) and Home's waiting list.
 */
export function recordActionItems(
  db: SimpleDb,
  meetingId: string,
  minutes: Minutes,
  by: string,
): void {
  const targets = (db.targets ??= {});
  const at = new Date(mockNowMs()).toISOString();
  for (const a of minutes.action_items) {
    if (a.action_item_id && targets[a.action_item_id]) continue;
    const linked = a.item_id && Object.values(db.ids).includes(a.item_id) ? a.item_id : null;
    targets[crypto.randomUUID()] = {
      kind: 'action_item',
      title: a.title,
      owner_id: a.owner_id ?? by,
      due_date: a.due_date ?? null,
      status: 'open',
      item_id: linked,
      meeting_id: meetingId,
      at,
    };
  }
}

/** Whether `me` owns the action item a change targets (its owner changes or closes it). */
export function ownsActionItem(db: SimpleDb, target: Record<string, unknown>, me: string): boolean {
  const row = db.targets?.[String(target.action_item_id ?? '')];
  return row?.kind === 'action_item' && row.owner_id === me;
}

export function actionItemRows(
  db: SimpleDb | undefined,
  me: string,
  meetingTitle: (id: string) => string | null,
  seen: string | null | undefined,
): Row[] {
  const today = new Date(mockNowMs()).toISOString().slice(0, 10);
  const titleOf = (id: string) => {
    const key = Object.keys(db?.ids ?? {}).find((k) => db!.ids[k] === id);
    return db?.items.find((s) => s.key === key)?.title ?? null;
  };
  // inbox-codes (#1786): as meeting_actions.inbox_rows, the linked item's code (codes.code_of).
  const codeOf = (id: string) => {
    const key = Object.keys(db?.ids ?? {}).find((k) => db!.ids[k] === id);
    const s = db?.items.find((x) => x.key === key);
    return s ? shownCode(s, (f) => db!.feature_codes?.[f]) : null;
  };
  const roadmapOf = (id: string) => {
    const key = Object.keys(db?.ids ?? {}).find((k) => db!.ids[k] === id);
    const roadmap = db?.items.find((s) => s.key === key)?.roadmap;
    return roadmap ? roadmapId(roadmap) : null;
  };
  return Object.entries(db?.targets ?? {})
    .filter(([, t]) => t.kind === 'action_item' && t.owner_id === me && t.status === 'open')
    .map(([id, t]) => {
      const due = (t.due_date as string | null) ?? null;
      const at = String(t.at);
      const item = (t.item_id as string | null) ?? null;
      const meeting = (t.meeting_id as string | null) ?? null;
      return {
        id,
        title: String(t.title),
        due_date: due,
        late: !!due && due < today,
        item_id: item,
        item_title: item ? titleOf(item) : null,
        item_code: item ? codeOf(item) : null,
        roadmap_id: item ? roadmapOf(item) : null,
        meeting_id: meeting,
        meeting_title: meeting ? meetingTitle(meeting) : null,
        at,
        state: !seen || at > seen ? ('new' as const) : ('open' as const),
      };
    })
    .sort((a, b) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999'));
}

/**
 * meeting_actions.of_meeting: a sent meeting's recorded action items; `can_change` for its
 * owner, or one who decides its item (an owner when it has none).
 */
export function meetingActionItems(
  db: SimpleDb,
  meetingId: string,
  me: Me,
  nameOf: (id: string) => string | null,
): Schemas['SimpleMeetingActionItem'][] {
  const decides = (item: string | null) => {
    const key = item ? Object.keys(db.ids).find((k) => db.ids[k] === item) : undefined;
    const s = key ? db.items.find((x) => x.key === key) : undefined;
    return s ? canDecideItem(db, s, me) : me.role === 'owner';
  };
  return Object.entries(db.targets ?? {})
    .filter(([, t]) => t.kind === 'action_item' && t.meeting_id === meetingId)
    .map(([id, t]) => {
      const owner = String(t.owner_id);
      const item = (t.item_id as string | null) ?? null;
      return {
        id,
        title: String(t.title),
        owner_id: owner,
        owner_name: nameOf(owner),
        due_date: (t.due_date as string | null) ?? null,
        item_id: item,
        status: String(t.status),
        can_change: owner === me.id || decides(item),
      };
    });
}
