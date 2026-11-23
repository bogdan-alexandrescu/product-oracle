'use client';

import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react';

import type { Schemas } from '@/lib/api/client';

import { itemName } from './_gtflag';
import { closedItem } from './_lib';

import type { Act } from './_card';

type Item = Schemas['SimpleRoadmapItem'];

/** Stored with the pin as its one-line why, as the Goal buckets' move. */
const REASON = 'Reordered in place';

/**
 * timeline-order: items in the one feature order (their `position`, Priorities' rank, the order the Goal buckets
 * follow); an item with no position keeps its place among them, after the ordered ones. Stable: one position shared
 * by two items keeps them as given.
 */
export function inOrder<T extends { position?: number | null }>(items: T[]): T[] {
  const at = (i: T) => i.position ?? Infinity;
  return items
    .map((i, n) => ({ i, n }))
    .sort((a, b) => at(a.i) - at(b.i) || a.n - b.n)
    .map((x) => x.i);
}

/** The handle a row's name carries: drag it, or Alt+ArrowUp / Alt+ArrowDown on it. */
export type RowOrder = {
  /** It has a handle: who may change (a proposer too) and an item in the order. */
  may: (i: Item) => boolean;
  /** A move of it waits for a decider (the pending mark). */
  pending: (i: Item) => boolean;
  drag: (
    lane: string,
    i: Item,
  ) => {
    draggable: true;
    onDragStart: (e: DragEvent) => void;
    onDragOver: (e: DragEvent) => void;
    onDrop: (e: DragEvent) => void;
  };
  keys: (lane: string, i: Item) => (e: KeyboardEvent) => void;
};

/**
 * timeline-order: a row moved up or down within its lane takes the rank of the one it lands on, through the same
 * override_priority change the Goal buckets and Priorities write (one request; the ones between renumber). A
 * decider's move shows at once (rolled back with the server's words when refused; Undo in its toast); a proposer's
 * is filed and its row carries the pending mark. Rights are the item's own can_decide and the page's can().
 */
export function useRowOrder({
  act,
  canChange,
  proposed,
}: {
  act: Act;
  canChange: boolean;
  /** The items with a move waiting for a decider. */
  proposed?: ReadonlySet<string>;
}) {
  const [local, setLocal] = useState<{ lane: string; ids: string[] } | null>(null);
  const lanes = useRef(new Map<string, Item[]>()).current;
  /** The lane's items as shown: a move in flight first, else in order. */
  const arrange = (lane: string, items: Item[]): Item[] => {
    const byId = new Map(items.map((i) => [i.id, i]));
    const shown =
      local?.lane === lane &&
      local.ids.length === items.length &&
      local.ids.every((id) => byId.has(id))
        ? local.ids.map((id) => byId.get(id)!)
        : inOrder(items);
    lanes.set(lane, shown);
    return shown;
  };
  const may = (i: Item) => canChange && i.position != null && !closedItem(i);

  async function move(lane: string, i: Item, onto: Item) {
    const shown = lanes.get(lane) ?? [];
    if (i.id === onto.id || !may(i) || onto.position == null || !shown.includes(onto)) return;
    const next = shown.filter((x) => x.id !== i.id);
    const at = next.indexOf(onto) + (shown.indexOf(i) < shown.indexOf(onto) ? 1 : 0);
    next.splice(at, 0, i);
    if (i.can_decide) setLocal({ lane, ids: next.map((x) => x.id) });
    const words = `${itemName(i)} to rank ${onto.position}`;
    try {
      await act(
        { applied: `Moved ${words}`, proposed: `move ${words}` },
        {
          op: 'override_priority',
          target: { item_id: i.id },
          before: { override: i.before_override ?? null },
          after: { position: onto.position, reason: REASON },
          reason: REASON,
        },
      );
    } finally {
      setLocal(null);
    }
  }

  const order: RowOrder = {
    may,
    pending: (i) => !!proposed?.has(i.id),
    drag: (lane, i) => ({
      draggable: true,
      onDragStart: (e) => {
        e.dataTransfer.setData('text/x-timeline-row', `${lane}|${i.id}`);
        e.dataTransfer.effectAllowed = 'move';
      },
      onDragOver: (e) => {
        if (e.dataTransfer.types.includes('text/x-timeline-row')) e.preventDefault();
      },
      onDrop: (e) => {
        const [from, id] = e.dataTransfer.getData('text/x-timeline-row').split('|');
        const it = (lanes.get(lane) ?? []).find((x) => x.id === id);
        if (from !== lane || !it) return;
        e.preventDefault();
        void move(lane, it, i);
      },
    }),
    keys: (lane, i) => (e) => {
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || !may(i)) return;
      e.preventDefault();
      e.stopPropagation();
      const shown = lanes.get(lane) ?? [];
      const onto = shown[shown.indexOf(i) + (e.key === 'ArrowUp' ? -1 : 1)];
      if (onto) void move(lane, i, onto);
    },
  };
  return { arrange, order, local };
}
