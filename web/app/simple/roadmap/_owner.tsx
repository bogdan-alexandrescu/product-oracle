'use client';

import { api, unwrap } from '@/lib/api/client';
import { useQuery } from '@/lib/use-query';

import type { Item } from './_lib';

export type Person = { user_id: string; name: string };

/** de-r1: the people an item's owner may be (as the panel's Owner pick: who may write). */
export function useOwners(canChange: boolean): Person[] | undefined {
  const people = useQuery(`people:panel:${canChange}`, () =>
    canChange
      ? unwrap(api.GET('/v1/people', { params: { query: { limit: 200 } } }))
      : Promise.resolve([]),
  );
  return people.data?.filter((p) => p.can_write);
}

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');

/**
 * de-r1 (RE2 A): the owner's initials beside the selected bar; a click picks a person, saved at
 * once (the panel's Owner change: set_owner). Blank: the track's owner.
 */
export function OwnerPick({
  item,
  people,
  left,
  onPick,
}: {
  item: Item;
  people: Person[];
  left: number;
  onPick: (ownerId: string | null) => void;
}) {
  const name = item.owner?.name ?? '';
  // #1908: the circle says what it is on hover: its owner, picked here.
  const tip = `Owner: ${name || "the track's owner"}`;
  return (
    <span
      data-testid="bar-owner"
      className="pointer-events-auto absolute top-[7px] z-[12] flex h-5 min-w-5 items-center justify-center rounded-full border border-line-strong bg-surface px-1 text-xs font-semibold text-text2 focus-within:border-accent"
      style={{ left }}
      title={tip}
    >
      {name ? initials(name) : '+'}
      <select
        data-testid="bar-owner-pick"
        aria-label={`Owner of ${item.title}`}
        title={tip}
        value={item.own_owner_id ?? ''}
        onChange={(e) => onPick(e.target.value || null)}
        onKeyDown={(e) => e.stopPropagation()}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        <option value="">{"The track's owner"}</option>
        {people.map((p) => (
          <option key={p.user_id} value={p.user_id}>
            {p.name}
          </option>
        ))}
      </select>
    </span>
  );
}
