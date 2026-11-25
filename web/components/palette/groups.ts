// build-palette (#1794): the palette's list for what is typed (CP2 b, Find and do): the empty box
// shows recent items, Do and Go to; "new …" shows the add; anything else the found items by kind,
// the pages it names and Do. Pure, so a unit test reads it.
import { FOUND_KINDS, GROUP_OF, matches, type Hit, type HitKind } from './hits';

export const CAP = 5;

export type Group = { label: string; kind?: HitKind; hits: Hit[]; more: number };

/** "new Quiet hours" (or "new item: …"): the words that become the new item's title. */
export function newTitle(words: string): { typedNew: boolean; title: string } {
  return {
    typedNew: /^new\b/i.test(words),
    title: words.replace(/^new( item)?:?\s*/i, '').trim(),
  };
}

export function buildGroups({
  words,
  all,
  pages,
  actions,
  recent,
  whole,
}: {
  words: string;
  all: Hit[];
  pages: Hit[];
  actions: Hit[];
  recent: string[];
  /** The kind whose "more" was opened: all of it shows. */
  whole: HitKind | null;
}): { groups: Group[]; none: boolean } {
  if (!words) {
    const seen = recent.flatMap((k) => all.filter((h) => h.key === k));
    return {
      groups: [
        { label: 'Recent', hits: seen, more: 0 },
        { label: 'Do', hits: actions, more: 0 },
        { label: 'Go to', hits: pages, more: 0 },
      ],
      none: false,
    };
  }
  if (newTitle(words).typedNew)
    return {
      groups: [{ label: 'Do', hits: actions.filter((a) => a.key !== 'a-ask'), more: 0 }],
      none: false,
    };
  const found = all.filter((h) => matches(h, words));
  const groups: Group[] = FOUND_KINDS.flatMap((k) => {
    const hits = found.filter((h) => h.kind === k);
    const cap = whole === k ? hits.length : CAP;
    return hits.length
      ? [
          {
            label: GROUP_OF[k],
            kind: k,
            hits: hits.slice(0, cap),
            more: hits.length - Math.min(cap, hits.length),
          },
        ]
      : [];
  });
  const pg = pages.filter((p) => matches(p, words));
  if (pg.length) groups.push({ label: 'Go to', hits: pg, more: 0 });
  groups.push({ label: 'Do', hits: actions, more: 0 });
  return { groups, none: found.length === 0 };
}
