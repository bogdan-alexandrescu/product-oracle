// build-palette (#1794): an item with no code yet is found by its name, with no code shown, and
// its actions never print one; a feature on no roadmap opens on the Ground Truth. Invented data.
import { describe, expect, it } from 'vitest';

import { featureActions } from './actions';
import { featureHits, indexHits, matches } from './hits';

const tour = {
  id: 'i-1',
  code: null,
  title: 'In-app tour',
  status: 'cut',
  merged_into: null,
} as unknown as Parameters<typeof featureHits>[0][number];

describe('featureHits', () => {
  it('keeps an item with no code, named by its title alone', () => {
    const [h] = featureHits([tour]);
    expect(h.code).toBeUndefined();
    expect(h.feature).toMatchObject({ id: 'i-1', code: '', name: 'In-app tour' });
    expect(matches(h, 'in-app tour')).toBe(true);
    const words = featureActions(h, () => {}).map((a) => a.name);
    expect(words).toContain('Ask Oracle about In-app tour');
    expect(words.join(' ')).not.toMatch(/null|undefined/);
  });
});

describe('indexHits', () => {
  it('lists a feature on no roadmap under Features, opening on the Ground Truth', () => {
    const hits = indexHits({
      prds: [],
      goals: [],
      key_results: [],
      milestones: [],
      features: [{ id: 'e-12', code: 'F-12', name: 'Referral link' }],
    });
    expect(hits).toEqual([
      expect.objectContaining({
        kind: 'Feature',
        code: 'F-12',
        name: 'Referral link',
        href: '/ground-truth?entity=e-12',
      }),
    ]);
    expect(matches(hits[0], 'F-12')).toBe(true);
  });
});
