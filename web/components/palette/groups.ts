// build-palette (#1794): the palette's list for what is typed (CP2 b, Find and do): the empty box
// shows recent items, Do and Go to; "new …" shows the add first, then what it finds; anything
// else the found items by kind, the pages it names and Do. Pure, so a unit test reads it.
import { FOUND_KINDS, GROUP_OF, matches, type Hit, type HitKind } from './hits';

import type { Pages } from './pages';

export const CAP = 5;

export type Group = { label: string; kind?: HitKind; hits: Hit[]; more: number };

/** "new Quiet hours" (or "new item: …"): the words that become the new item's title. */
export function newTitle(words: string): { typedNew: boolean; title: string } {
  return {
    typedNew: /^new\b/i.test(words),
    title: words.replace(/^new( item)?:?\s*/i, '').trim(),
  };
}

/** What is found, five of a kind (all of those in `whole`), then how many more. */
function foundGroups(found: Hit[], whole: HitKind[]): Group[] {
  return FOUND_KINDS.flatMap((k) => {
    const hits = found.filter((h) => h.kind === k);
    const cap = whole.includes(k) ? hits.length : CAP;
    const more = hits.length - Math.min(cap, hits.length);
    return hits.length ? [{ label: GROUP_OF[k], kind: k, hits: hits.slice(0, cap), more }] : [];
  });
}

/** The rows in the order the arrow keys walk them: each group's, then its "more". */
export function rowsOf(groups: Group[]): Hit[] {
  return groups.flatMap((g) => [
    ...g.hits,
    ...(g.more && g.kind
      ? [
          {
            key: `more-${g.kind}`,
            kind: 'Action' as const,
            more: g.kind,
            name: `${g.more} more ${g.label.toLowerCase()} ↓`,
            where: '',
          },
        ]
      : []),
  ]);
}

/** One of the rows that shows the rest of a kind. */
export const moreOf = (g: Group) => rowsOf([g])[g.hits.length];

export function buildGroups({
  words,
  all,
  pages,
  actions,
  recent,
  whole,
  ready,
}: {
  words: string;
  all: Hit[];
  pages: Pages;
  actions: Hit[];
  recent: string[];
  /** The kinds whose "more" was opened: all of each shows. */
  whole: HitKind[];
  /** Both reads have answered: only then does nothing found mean no match, and may one add it. */
  ready: boolean;
}): { groups: Group[]; none: boolean } {
  if (!words) {
    const seen = recent.flatMap((k) => all.filter((h) => h.key === k));
    return {
      groups: [
        { label: 'Recent', hits: seen, more: 0 },
        { label: 'Do', hits: actions, more: 0 },
        { label: 'Go to', hits: pages.own, more: 0 },
      ],
      none: false,
    };
  }
  const found = all.filter((h) => matches(h, words));
  const groups = foundGroups(found, whole);
  const pg = [...pages.own, ...pages.more].filter((p) => matches(p, words));
  if (pg.length) groups.push({ label: 'Go to', hits: pg, more: 0 });
  // "new …" by one who may add: the add first, what it finds below.
  if (newTitle(words).typedNew && actions.some((a) => a.key === 'a-item')) {
    const adds = actions.filter((a) => a.key !== 'a-ask');
    return { groups: [{ label: 'Do', hits: adds, more: 0 }, ...groups], none: false };
  }
  if (ready) groups.push({ label: 'Do', hits: actions, more: 0 });
  return { groups, none: ready && found.length === 0 && pg.length === 0 };
}
