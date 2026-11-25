import { describe, expect, it } from 'vitest';

import { buildGroups, CAP, newTitle, rowsOf } from './groups';
import { featureHits, indexHits, matches, type Hit } from './hits';

// build-palette (#1794): what the palette lists for what is typed. Invented example data.
const features = featureHits(
  Array.from({ length: 8 }, (_, n) => ({
    id: `i${n}`,
    code: `F-${70 + n}`,
    title: `Alert step ${n}`,
    status: 'planned' as const,
    merged_into: null,
    track: { title: 'Usage alerts' },
  })),
);
const index = indexHits({
  prds: [{ id: 'd1', slug: 'annual-billing', title: 'Annual billing PRD', status: 'in_review' }],
  goals: [{ id: 'g1', name: 'Growth', measure: 'sign-ups' }],
  key_results: [{ id: 'k1', name: 'Sign-ups per rep per day', goal: 'Growth', goal_id: 'g1' }],
  milestones: [{ id: 'm1', code: 'M3', name: '50 sign-ups per rep', date: 'Dec 2' }],
  features: [],
});
const all = [...features, ...index];
const ask: Hit = { key: 'a-ask', kind: 'Action', name: 'Ask Oracle', where: '' };
const item: Hit = { key: 'a-item', kind: 'Action', name: 'New item', where: '' };
const page = (name: string): Hit => ({ key: `p-${name}`, kind: 'Page', name, where: 'Simple' });
const pages = { own: [page('Home'), page('Goal map')], more: [page('Runs')] };
const base = { all, pages, actions: [item, ask], recent: [], whole: [], ready: true };
const labels = (words: string, more: Partial<typeof base> = {}) =>
  buildGroups({ ...base, ...more, words }).groups.map((g) => g.label);

describe('palette groups', () => {
  it('finds a feature by its code with or without the dash, a milestone by its own', () => {
    expect(matches(features[0], 'F-70')).toBe(true);
    expect(matches(features[0], 'f70')).toBe(true);
    expect(features[0].where).toBe('Usage alerts · Planned');
    expect(labels('M3')).toEqual(['Milestones', 'Do']);
  });

  it('groups found items by kind, five each, then a row for the rest', () => {
    const { groups, none } = buildGroups({ ...base, words: 'alert step' });
    expect(none).toBe(false);
    expect(groups[0]).toMatchObject({ label: 'Features', more: 8 - CAP });
    expect(groups[0].hits).toHaveLength(CAP);
    const rows = rowsOf(groups);
    expect(rows[CAP]).toMatchObject({ more: 'Feature', name: '3 more features ↓' });
    expect(rows[CAP + 1].key).toBe('a-item');
    const whole = buildGroups({ ...base, words: 'alert step', whole: ['Feature'] });
    expect(whole.groups[0].hits).toHaveLength(8);
    expect(rowsOf(whole.groups)[8].key).toBe('a-item');
  });

  it('a key result opens its goal on Goal map; a PRD its one-pager; a milestone its card', () => {
    const of = (kind: string) => index.find((h) => h.kind === kind)!;
    expect(of('Key result').href).toBe('/simple/goals?goal=g1');
    expect(of('PRD').href).toBe('/simple/one-pagers/annual-billing');
    expect(of('Milestone').href).toBe('/simple/roadmap?milestone=m1');
  });

  it('"new …" lists the add first and what it finds below', () => {
    expect(newTitle('new Quiet hours')).toEqual({ typedNew: true, title: 'Quiet hours' });
    const pricing = { ...features[0], key: 'f-new', name: 'New pricing page' };
    const typed = buildGroups({ ...base, all: [...all, pricing], words: 'new pricing' });
    expect(rowsOf(typed.groups).map((h) => h.key)).toEqual(['a-item', 'f-new']);
    expect(rowsOf(buildGroups({ ...base, words: 'new Quiet hours' }).groups)).toEqual([item]);
  });

  it('for one who adds nothing, "new …" is a plain search', () => {
    const pricing = { ...features[0], key: 'f-new', name: 'New pricing page' };
    const viewer = { ...base, all: [...all, pricing], actions: [ask] };
    expect(labels('new pricing', viewer)).toEqual(['Features', 'Do']);
    expect(buildGroups({ ...viewer, words: 'new zebra' }).none).toBe(true);
  });

  it('nothing found and no page is no match, once both reads have answered', () => {
    expect(buildGroups({ ...base, words: 'zebra' }).none).toBe(true);
    expect(buildGroups({ ...base, words: 'goal map' }).none).toBe(false);
    const reading = buildGroups({ ...base, words: 'F-99', all: [], ready: false });
    expect(reading).toEqual({ groups: [], none: false });
  });

  it('the empty box lists its own shell’s pages; the others are found by name', () => {
    const go = buildGroups({ ...base, words: '' }).groups.find((g) => g.label === 'Go to')!;
    expect(go.hits).toEqual(pages.own);
    expect(labels('runs')).toEqual(['Go to', 'Do']);
  });
});
