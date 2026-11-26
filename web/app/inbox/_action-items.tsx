'use client';

import { useState } from 'react';

import { Button, Chip, LinkButton } from '@/components/ds';
import { api, unwrap, type Schemas } from '@/lib/api/client';
import { calendarDay } from '@/lib/dates';
import { errorMessage } from '@/lib/use-query';

import { isNew, type StatedNeed } from './_needs';
import { FeatureName } from './_proposals';

import type { OnActed } from './_actions';

type ActionItem = Schemas['InboxSimpleActionItem'];

/**
 * #1817: a meeting's action item waiting on its owner (the API's `simple_action_items`,
 * counted): what it is, its due date and linked item, and the meeting it came from. Its due
 * date changes in place and Done closes it, each Undo in the Inbox's banner; Open goes to the meeting.
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
          <FeatureName
            name={a.item_title}
            itemId={a.item_id}
            documentId={a.roadmap_id}
            code={a.item_code}
          />
        )}
      </span>
    ),
    at: a.at,
    state: isNew(a.at, seenBefore) ? 'new' : 'open',
    counted: true,
    group: 'minutes',
    action: (
      <span className="flex items-center gap-2">
        <ActionItemControls key={`${a.id}-${a.due_date}`} a={a} onActed={onActed} />
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

type Changeable = Pick<ActionItem, 'id' | 'title' | 'due_date' | 'item_id'>;

/**
 * An action item's own controls, in the Inbox row and on its meeting: its due date, changed in
 * place (edit_action_item), and Done (set_action_item_status); each one Undo through `onActed`.
 */
export function ActionItemControls({ a, onActed }: { a: Changeable; onActed: OnActed }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [due, setDue] = useState(a.due_date ?? '');
  const target = { action_item_id: a.id, ...(a.item_id ? { item_id: a.item_id } : {}) };
  const change = async (
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    message: string,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const r = await unwrap(
        api.POST('/v1/simple/changes', {
          body: {
            op: before.status ? 'set_action_item_status' : 'edit_action_item',
            target,
            before,
            after,
          },
        }),
      );
      const id = r.change.id;
      onActed({
        id,
        message,
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
  const moveDue = () => {
    if (!due || due === (a.due_date ?? '')) return;
    void change(
      { due_date: a.due_date ?? null },
      { due_date: due },
      `Due ${calendarDay(due)}: ${a.title}`,
    );
  };
  return (
    <>
      <input
        type="date"
        className="h-10 rounded-button border border-line-strong bg-surface px-2 text-text [color-scheme:light_dark]"
        aria-label={`Due date of ${a.title}`}
        value={due}
        disabled={busy}
        onChange={(e) => setDue(e.target.value)}
        onBlur={moveDue}
        onKeyDown={(e) => {
          if (e.key === 'Enter') moveDue();
        }}
      />
      <Button
        disabled={busy}
        onClick={() => void change({ status: 'open' }, { status: 'done' }, `Done: ${a.title}`)}
        aria-label={`Done: ${a.title}`}
      >
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
