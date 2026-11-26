'use client';

/** de-r2: the Roadmap's goal cards, changed in place. A goal's name: a click opens it for typing,
 * Enter or leaving it saves at once (shown before the API answers, put back with the error if
 * refused), Esc cancels. Only where the reader may change the goal (its own can_edit) and the goal
 * has the measure, target and date a goal's write needs; elsewhere the name reads as before. */

import { useState } from 'react';

import { api, unwrap } from '@/lib/api/client';
import { CARD_CHANGED_EVENT, sendGoalChanged } from '@/lib/api/simple-chat';

import { useGoalBuckets } from '../priorities/goal-buckets';

export function GoalTitle({ id, title }: { id: string; title: string }) {
  const buckets = useGoalBuckets();
  const [editing, setEditing] = useState<string | null>(null);
  const [shown, setShown] = useState<{ from: string; to: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const g =
    buckets.data?.goals.find((x) => x.id === id) ??
    buckets.data?.goals.find((x) => x.title === title);
  const now = shown && shown.from === title ? shown.to : title;
  const editable = !!g?.can_edit && !!g.measure && !!g.target && !!g.due;
  if (!editable || !g) return <>{now}</>;
  const save = async (to: string) => {
    setEditing(null);
    const name = to.trim();
    if (!name || name === now) return;
    setFailed(null);
    setShown({ from: title, to: name });
    try {
      await unwrap(
        api.PATCH('/v1/simple/goal-buckets/goals/{goal_id}', {
          params: { path: { goal_id: g.id } },
          body: { title: name, measure: g.measure!, target: g.target!, due: g.due! },
        }),
      );
    } catch (e) {
      setShown(null);
      setFailed(e instanceof Error && e.message ? e.message : 'Oracle could not save it');
      return;
    }
    void buckets.reload();
    sendGoalChanged();
    window.dispatchEvent(new CustomEvent(CARD_CHANGED_EVENT));
  };
  if (editing != null)
    return (
      <input
        autoFocus
        aria-label="Goal name"
        data-testid="goal-counter-title-input"
        value={editing}
        onChange={(e) => setEditing(e.target.value)}
        onBlur={() => void save(editing)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void save(editing);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setEditing(null);
          }
        }}
        className="h-7 w-full min-w-0 rounded-md border border-line-strong bg-surface px-1.5 text-base font-semibold text-text"
      />
    );
  return (
    <span
      role="button"
      tabIndex={0}
      data-testid="goal-counter-title-edit"
      title={failed ?? undefined}
      data-failed={failed ? '' : undefined}
      onClick={() => setEditing(now)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'F2') {
          e.preventDefault();
          setEditing(now);
        }
      }}
      className={`rounded-sm hover:underline hover:decoration-dotted ${failed ? 'text-crit' : ''}`}
    >
      {now}
    </span>
  );
}
