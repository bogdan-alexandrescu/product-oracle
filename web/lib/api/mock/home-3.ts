// home-3 (issues 1900, 1897): Home's live shapes the tidy mock lacked (invented data).
import type { Schemas } from '@/lib/api/client';

import { stableUuid } from './ids';

import type { SimpleDb } from './simple-roadmap';

export const HOME_3_SCENARIO = 'home-3';

const THEO = { id: stableUuid('member/commenter@example.com'), name: 'Theo Brandt' };

/**
 * The "simple-home" roadmap as the live site reads it:
 *
 * #1900: four changes by Theo Brandt (owner changed, dates accepted, status changed, added), each
 * storing only the id an older version of the roadmap gave its item (each approved version
 * copies its items under new ids, changes._past), and one on an item that version dropped.
 *
 * #1897: Alert SSO sits in the Alerts track's undated "Field trial", a track milestone no
 * roadmap milestone joins (its date is set on the Plan page, not in Simple).
 */
export function withHome3(rm: SimpleDb): SimpleDb {
  const past = (key: string, title: string) => {
    const id = stableUuid(`simple-item-v1/${key}`);
    (rm.past ??= {})[id] = { key, title };
    return id;
  };
  const change = (
    n: number,
    op: string,
    item: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): Schemas['SimpleChangeOut'] => ({
    id: stableUuid(`simple-change/home-3-${n}`),
    session_id: null,
    document_id: stableUuid('simple-doc/alerts-roadmap'),
    op: op as Schemas['SimpleChangeOut']['op'],
    draft_ids: [],
    target: { item_id: item },
    before,
    after,
    status: 'applied',
    by: THEO.id,
    by_name: THEO.name,
    at: `2026-10-2${n}T15:00:00Z`,
    decided_by: null,
    decided_at: null,
    reason: null,
    decision_reason: null,
    routed_to: [],
    undoes_id: null,
    undone: false,
    can_decide: false,
    can_undo: false,
  });
  rm.changes = [
    ...(rm.changes ?? []),
    change(1, 'set_owner', past('alert-rules', 'Alert rules engine'), {}, {}),
    change(2, 'accept_date_suggestion', past('alert-mobile', 'Mobile alert push'), {}, {}),
    change(3, 'set_status', past('alert-export', 'Alert history export'), {}, { shipped: true }),
    change(4, 'add_item', past('setup-tour', 'Product tour'), {}, {}),
    change(5, 'set_owner', past('old-widget', 'Example widget'), {}, {}),
  ];
  rm.items = rm.items.map((s) => (s.key === 'alert-sso' ? { ...s, record: 'Field trial' } : s));
  return rm;
}
