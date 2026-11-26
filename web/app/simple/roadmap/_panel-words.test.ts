import { describe, expect, it } from 'vitest';

import { featureTitle, noteWords, targetWords } from './_panel-words';

describe('panel-2 panel words', () => {
  it("keeps a title to the feature's name", () => {
    expect(featureTitle('Usage alerts: Weekly alert digest (P0)', 'Usage alerts')).toBe(
      'Weekly alert digest',
    );
    expect(featureTitle('Weekly alert digest — Usage alerts', 'Usage alerts')).toBe(
      'Weekly alert digest',
    );
    expect(featureTitle('Weekly alert digest [P1]', null)).toBe('Weekly alert digest');
    expect(featureTitle('Usage alerts', 'Usage alerts')).toBe('Usage alerts');
    expect(featureTitle('Usage alerts export', 'Usage alerts')).toBe('Usage alerts export');
  });
  it('drops milestone shorthand from a target', () => {
    expect(targetWords('70% of teams (M2)')).toBe('70% of teams');
    expect(targetWords('70% of teams (by M1, M2)')).toBe('70% of teams');
    expect(targetWords('Under 10% (of teams)')).toBe('Under 10% (of teams)');
  });
  it("words Oracle's version notes and keeps a person's", () => {
    expect(noteWords('from version 21')).toBe('Carried over from the last roadmap');
    expect(noteWords('from version 21, deferred')).toBe(
      'Carried over from the last roadmap, moved later',
    );
    expect(noteWords('carried from version 3')).toBe('Carried over from the last roadmap');
    expect(noteWords('added in Simple on version 4')).toBe('Added in Simple');
    expect(noteWords('Keynote slot for alerts')).toBe('Keynote slot for alerts');
  });
});
