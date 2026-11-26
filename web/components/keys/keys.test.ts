import { describe, expect, it } from 'vitest';

import { goKeys, matches, pageName, sheetGroups, suggestionLabel } from './keys';

const SIMPLE = [
  { label: 'Home', href: '/simple' },
  { label: 'Roadmap', href: '/simple/roadmap' },
  { label: 'Priorities', href: '/simple/priorities' },
];

describe('keys (#1795, KS1 B)', () => {
  it('gives each page g then its letter', () => {
    expect(goKeys(SIMPLE).map((k) => k.keys.join(' '))).toEqual(['g h', 'g r', 'g p']);
    expect(goKeys([{ label: 'Zebra', href: '/z' }])[0].keys).toEqual(['g', 'z']);
  });
  it('lists this page first and folds the others', () => {
    const groups = sheetGroups('/simple/priorities', SIMPLE, false);
    expect(groups[0].name).toBe('This page · Priorities');
    expect(groups.find((g) => g.name === 'Roadmap')?.open).toBe(false);
    expect(pageName('/documents/x/v/2', SIMPLE)).toBe('Documents');
  });
  it('finds a key by name or by its keys; a commenter suggests', () => {
    expect(matches({ keys: ['g', 'r'], label: 'Roadmap' }, 'road')).toBe(true);
    expect(matches({ keys: ['Esc'], label: 'Close' }, 'Esc')).toBe(true);
    expect(suggestionLabel('Move the row down')).toBe('Suggest a move down');
    expect(suggestionLabel('Add on this page')).toBe('Suggest an item');
  });
});
