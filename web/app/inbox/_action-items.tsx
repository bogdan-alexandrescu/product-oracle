'use client';

import { useState } from 'react';

import { Button, Chip, LinkButton } from '@/components/ds';
import { api, unwrap, type Schemas } from '@/lib/api/client';
import { calendarDay } from '@/lib/dates';
import { errorMessage } from '@/lib/use-query';

import type { OnActed } from './_actions';
import { isNew, type StatedNeed } from './_needs';
import { FeatureName } from './_proposals';

type ActionItem = Schemas['InboxSimpleActionItem'];

/**
 * #1817: a meeting's action item waiting on its owner (the API's `simple_action_items`,
 * counted): what it is, its due date and linked item, and the meeting it came from. Done closes
 * it (set_action_item_status), its Undo in the Inbox's banner; Open goes to the meeting.
 */
export function actionItemRows(
  rows: ActionItem[],
  onActed: OnActed,
  seenBefore: string | null | undefined,
): StatedNeed[] {
  return rows.map((a) => ({
    key: `action-item-${a.id}`,
    icon: 'check',
    kind: 'Action item',
    item: (
      <span className="min-w-0 truncate" title={a.title} data-user-content>
        {a.title}
      </span>
    ),
    context: (
      <span className="flex min-w-0 flex-wrap items-center gap-2" data-testid="action-item-context">
        {a.due_date && <Chip kind={a.late ? 'warn' : 'line'}>Due {calendarDay(a.due_date)}</Chip>}
        {a.item_id && a.item_title && (
          <FeatureName name={a.item_title} itemId={a.item_id} documentId={a.roadmap_id} />
        )}
      </span>
    ),
    at: a.at,
    state: isNew(a.at, seenBefore) ? 'new' : 'open',
    counted: true,
    group: 'minutes',
    action: (
      <span className="flex items-center gap-2">
        <DoneButton a={a} onActed={onActed} />
        {a.meeting_id && (
          <LinkButton
            href={`/simple/meetings/${a.meeting_id}`}
            aria-label={`Open ${a.meeting_title ?? 'the meeting'}`}
          >
            Open
          </LinkButton>
        )}
      </span>
    ),
  }));
}

function DoneButton({ a, onActed }: { a: ActionItem; onActed: OnActed }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await unwrap(
        api.POST('/v1/simple/changes', {
          body: {
            op: 'set_action_item_status',
            target: { action_item_id: a.id, ...(a.item_id ? { item_id: a.item_id } : {}) },
            before: { status: 'open' },
            after: { status: 'done' },
          },
        }),
      );
      const id = r.change.id;
      onActed({
        id,
        message: `Done: ${a.title}`,
        undo: () =>
          unwrap(
            api.POST('/v1/simple/changes/{change_id}/undo', {
              params: { path: { change_id: id } },
            }),
          ),
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button disabled={busy} onClick={() => void done()} aria-label={`Done: ${a.title}`}>
        Done
      </Button>
      {error && (
        <span role="alert" className="text-sm text-crit">
          {error}
        </span>
      )}
    </>
  );
}
