'use client';

import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react';

import { storeGoalOrder } from './GoalOrder';

/**
 * prioritize: goals reordered by their header, dragged onto another goal's card or moved one place
 * with Alt+Arrow (Up or Left: earlier). The new order shows at once and is stored as every goal's
 * place (the one goal order every page follows); a refusal puts it back. `ids` is the order shown,
 * `all` every goal's id in the stored order (the ones not shown keep their places after).
 */
export function useGoalDrag({
  ids,
  all,
  may,
  saved,
  failed,
}: {
  ids: string[];
  all: string[];
  may: (id: string) => boolean;
  /** After the order is stored (the page reads again), with the order before and after. */
  saved: (o: { before: string[]; after: string[] }) => Promise<void> | void;
  failed: (e: unknown) => void;
}) {
  const [local, setLocal] = useState<string[] | null>(null);
  const [carried, setCarried] = useState<string | null>(null);
  // The drop reads it at once: the drag's events come before the next render.
  const held = useRef<string | null>(null);
  const hold = (id: string | null) => {
    held.current = id;
    setCarried(id);
  };
  const shown =
    local && local.length === ids.length && ids.every((id) => local.includes(id)) ? local : ids;

  async function place(id: string, onto: string) {
    if (id === onto || !shown.includes(onto)) return;
    const next = shown.filter((x) => x !== id);
    next.splice(next.indexOf(onto) + (shown.indexOf(id) < shown.indexOf(onto) ? 1 : 0), 0, id);
    setLocal(next);
    const before = [...shown, ...all.filter((x) => !shown.includes(x))];
    const after = [...next, ...all.filter((x) => !next.includes(x))];
    try {
      await storeGoalOrder(after, new Map(before.map((x, i) => [x, i + 1])));
      await saved({ before, after });
    } catch (e) {
      failed(e);
    }
    setLocal(null);
  }

  /** The goal header's handle: drag it, or Alt+Arrow while it has focus. */
  const handle = (id: string, name: string) =>
    may(id)
      ? {
          'data-testid': 'goal-handle',
          draggable: true,
          tabIndex: 0,
          // Its heading role and name stay: the tip says how it moves.
          title: `Drag ${name} to reorder goals`,
          onDragStart: (e: DragEvent) => {
            e.dataTransfer.setData('text/plain', id);
            e.dataTransfer.effectAllowed = 'move';
            hold(id);
          },
          onDragEnd: () => hold(null),
          onKeyDown: (e: KeyboardEvent) => {
            if (!e.altKey) return;
            const by = ['ArrowUp', 'ArrowLeft'].includes(e.key)
              ? -1
              : ['ArrowDown', 'ArrowRight'].includes(e.key)
                ? 1
                : 0;
            if (!by) return;
            e.preventDefault();
            e.stopPropagation();
            const onto = shown[shown.indexOf(id) + by];
            if (onto) void place(id, onto);
          },
        }
      : {};

  /** A goal's card takes a dragged goal header. */
  const target = (id: string | undefined) =>
    id
      ? {
          'data-goal-over': carried && carried !== id ? '' : undefined,
          onDragOver: (e: DragEvent) => {
            if (held.current) e.preventDefault();
          },
          onDrop: (e: DragEvent) => {
            const from = held.current;
            if (!from) return;
            e.preventDefault();
            hold(null);
            void place(from, id);
          },
        }
      : {};

  return { shown, handle, target };
}
