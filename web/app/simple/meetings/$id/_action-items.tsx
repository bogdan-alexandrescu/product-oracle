'use client';

import { Chip, toast } from '@/components/ds';
import type { Schemas } from '@/lib/api/client';

import { ActionItemControls } from '../../../inbox/_action-items';

import type { OnActed } from '../../../inbox/_actions';

type Row = Schemas['SimpleMeetingActionItem'];

/**
 * #1817: a sent meeting's action items as recorded: each with its owner and due date, and, for
 * its owner or whoever decides its item (`can_change`), its due date and Done in place, each
 * with one Undo in its toast.
 */
export function SentActionItems({
  items,
  dayWords,
  reload,
}: {
  items: Row[];
  dayWords: (day: string) => string;
  reload: () => Promise<unknown>;
}) {
  const onActed: OnActed = (a) => {
    void reload();
    toast({
      message: a.message,
      action: a.undo && {
        label: 'Undo',
        onClick: () => void a.undo!().then(reload),
      },
    });
  };
  return (
    <ul className="flex flex-col gap-2 pl-5" data-testid="sent-action-items">
      {items.map((a) => (
        <li key={a.id} className="flex list-disc flex-wrap items-center gap-2">
          <span className={a.status === 'open' ? '' : 'line-through'} data-user-content>
            {a.title}
          </span>
          <span>
            · {a.owner_name ?? 'no owner'}
            {a.due_date ? ` · by ${dayWords(a.due_date)}` : ''}
          </span>
          {a.status !== 'open' && <Chip kind="line">Done</Chip>}
          {a.can_change && a.status === 'open' && (
            <ActionItemControls key={`${a.id}-${a.due_date}`} a={a} onActed={onActed} />
          )}
        </li>
      ))}
    </ul>
  );
}
