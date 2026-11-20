import { expect, test } from 'vitest';

import { parseBlocks } from './markdown';

// Wall-clock budgets: run alone (npm run test:timing, CI's e2e-timing job), never in the
// parallel unit run, where other files' load counts against them.

test('many unclosed image and link openers parse in linear time @timing', () => {
  for (const unit of ['![', '[', '![a](', '[a](']) {
    const started = Date.now();
    parseBlocks(unit.repeat(50_000));
    expect(Date.now() - started, unit).toBeLessThan(1500);
  }
});

// Emphasis is bounded like link text: many unclosed '*' or '_' openers scan a bounded
// stretch each (60 KB of " *a" took about a second, a megabyte froze the tab).
for (const unit of [' *a', ' _a', ' **a', '*a ', '_a ', '** a']) {
  test(`many unclosed emphasis openers (${JSON.stringify(unit)}) parse in linear time @timing`, () => {
    const started = Date.now();
    parseBlocks(unit.repeat(50_000));
    expect(Date.now() - started).toBeLessThan(1500);
  });
}

test('a megabyte of unclosed emphasis openers parses in linear time @timing', () => {
  const started = Date.now();
  parseBlocks(' *a _b **c'.repeat(100_000));
  expect(Date.now() - started).toBeLessThan(1500);
});
