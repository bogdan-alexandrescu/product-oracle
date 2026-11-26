// build-shortcuts (#1795), KS1 B 'Letters after g': the keys the ? sheet lists. The same single
// keys on every page with rows, and pages by g then a letter.

export type Key = { keys: string[]; label: string; then?: boolean; alt?: string[]; href?: string };
export type Group = { name: string; keys: Key[]; open: boolean };
export type Page = { label: string; href: string };

/** Each page's letter after g (Roadmap r, Priorities p, Goal map m, Decisions d, Inbox i, ...). */
export const LETTER: Record<string, string> = {
  Home: 'h',
  'One-pagers': 'o',
  Roadmap: 'r',
  'Goal map': 'm',
  Priorities: 'p',
  Meetings: 'e',
  Decisions: 'd',
  Inbox: 'i',
  Requests: 'q',
  'Ground Truth': 't',
  Plan: 'l',
  Runs: 'u',
  Company: 'c',
  Settings: 's',
};

/** The rail's pages with their letters; a page with no letter of its own takes its first free one. */
export function goKeys(pages: Page[]): Key[] {
  const used = new Set(pages.map((p) => LETTER[p.label]).filter(Boolean));
  return pages.map((p) => {
    let l = LETTER[p.label];
    if (!l) {
      l =
        p.label
          .toLowerCase()
          .replace(/[^a-z]/g, '')
          .split('')
          .find((c) => !used.has(c)) ?? '';
      used.add(l);
    }
    return { keys: ['g', l], label: p.label, then: true, href: p.href };
  });
}

export const ROW_KEYS: Key[] = [
  { keys: ['j'], label: 'Next row', alt: ['↓'] },
  { keys: ['k'], label: 'Previous row', alt: ['↑'] },
  { keys: ['Enter'], label: 'Open the feature' },
  { keys: ['Shift', 'J'], label: 'Move the row down' },
  { keys: ['Shift', 'K'], label: 'Move the row up' },
];

/** The version viewer's keys, as they were (VersionView). */
export const DOCUMENT_KEYS: Key[] = [
  { keys: [']'], label: 'Next change', alt: ['j'] },
  { keys: ['['], label: 'Previous change', alt: ['k'] },
  { keys: ['/'], label: 'Search or filter' },
  { keys: ['c'], label: 'Comment' },
  { keys: ['v'], label: 'Brief or full' },
  { keys: ['{'], label: 'Previous version', alt: ['}'] },
];

export function everywhere(detailed: boolean): Key[] {
  return [
    { keys: ['?'], label: 'Show the keys' },
    { keys: ['/'], label: 'Search or filter' },
    { keys: ['Esc'], label: 'Close the top panel' },
    { keys: ['c'], label: 'Add on this page' },
    { keys: ['s'], label: detailed ? 'Switch to Simple' : 'Switch to Detailed' },
  ];
}

const OTHERS: { name: string; keys: Key[] }[] = [
  {
    name: 'Roadmap',
    keys: [
      { keys: ['j'], label: 'Next item on the timeline' },
      { keys: ['c'], label: 'Add an item' },
      { keys: ['Enter'], label: 'Open the feature' },
    ],
  },
  {
    name: 'Goal map',
    keys: [{ keys: ['/'], label: 'Search the roadmap' }],
  },
  { name: 'Documents', keys: DOCUMENT_KEYS },
];

/** The page's name in the sheet's first group. */
export function pageName(path: string, pages: Page[]): string {
  if (/^\/documents\/[^/]+\/v/.test(path)) return 'Documents';
  const hit = pages
    .filter((p) => path === p.href || path.startsWith(`${p.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return hit?.label ?? 'This page';
}

/** The sheet's groups: this page first, then Go to and Everywhere, then other pages folded. */
export function sheetGroups(path: string, pages: Page[], detailed: boolean): Group[] {
  const here = pageName(path, pages);
  const own = here === 'Documents' ? DOCUMENT_KEYS : ROW_KEYS;
  return [
    { name: `This page · ${here}`, keys: own, open: true },
    { name: 'Go to', keys: goKeys(pages), open: true },
    { name: 'Everywhere', keys: everywhere(detailed), open: true },
    ...OTHERS.filter((o) => o.name !== here).map((o) => ({ ...o, open: false })),
  ];
}

/** A key the search box finds: by its name or by the keys themselves. */
export function matches(k: Key, q: string): boolean {
  const w = q.trim().toLowerCase();
  if (!w) return true;
  return (
    k.label.toLowerCase().includes(w) ||
    [...k.keys, ...(k.alt ?? [])].join(' ').toLowerCase().includes(w)
  );
}

/** Moves and adds: struck out for one who may change nothing. */
export const isEdit = (k: Key) => /^(Move the row|Add on this page|Add an item)/.test(k.label);

/** A commenter's move and add become suggestions, as their edits do. */
export function suggestionLabel(label: string): string {
  if (label.startsWith('Move the row')) return label.replace('Move the row', 'Suggest a move');
  if (/^Add (on this page|an item)/.test(label)) return 'Suggest an item';
  return label;
}
