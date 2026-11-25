import { describe, expect, it } from 'vitest';

import { buildGroups, CAP, newTitle } from './groups';
import { featureHits, indexHits, matches, pageHits, type Hit } from './hits';

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
});
const all = [...features, ...index];
const ask: Hit = { key: 'a-ask', kind: 'Action', name: 'Ask Oracle', where: '' };
const item: Hit = { key: 'a-item', kind: 'Action', name: 'New item', where: '' };
const base = { all, pages: pageHits(true), actions: [item, ask], recent: [], whole: null };

describe('palette groups', () => {
  it('finds a feature by its code with or without the dash', () => {
    expect(matches(features[0], 'F-70')).toBe(true);
    expect(matches(features[0], 'f70')).toBe(true);
    expect(features[0].where).toBe('Usage alerts · Planned');
  });

  it('groups found items by kind, five each, then more', () => {
    const { groups, none } = buildGroups({ ...base, words: 'alert step' });
    expect(none).toBe(false);
    expect(groups[0]).toMatchObject({ label: 'Features', more: 8 - CAP });
    expect(groups[0].hits).toHaveLength(CAP);
    const whole = buildGroups({ ...base, words: 'alert step', whole: 'Feature' });
    expect(whole.groups[0].hits).toHaveLength(8);
  });

  it('a key result opens its goal on Goal map; a PRD its one-pager', () => {
    const kr = index.find((h) => h.kind === 'Key result')!;
    expect(kr.href).toBe('/simple/goals?goal=g1');
    expect(index.find((h) => h.kind === 'PRD')!.href).toBe('/simple/one-pagers/annual-billing');
  });

  it('"new …" lists the add alone; nothing found and no page is no match', () => {
    expect(newTitle('new Quiet hours')).toEqual({ typedNew: true, title: 'Quiet hours' });
    const typed = buildGroups({ ...base, words: 'new Quiet hours' });
    expect(typed.groups.map((g) => g.hits.map((h) => h.key))).toEqual([['a-item']]);
    expect(buildGroups({ ...base, words: 'zebra' }).none).toBe(true);
    expect(buildGroups({ ...base, words: 'goal map' }).none).toBe(false);
  });
});
