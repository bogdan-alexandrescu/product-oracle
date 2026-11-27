import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

/**
 * #1819: the Simple brief asks that each test state its card (protects / fails_when /
 * no_claim). Every Playwright spec whose file name says "simple" states at least one of the
 * three; the list of those that state none starts, and stays, empty.
 */
const E2E = path.resolve(__dirname, '..', 'e2e');

test('every Simple spec states its test card', () => {
  const specs = fs.readdirSync(E2E).filter((f) => /simple/i.test(f) && f.endsWith('.spec.ts'));
  expect(specs.length).toBeGreaterThan(200);
  const missing = specs.filter(
    (f) => !/\b(protects|fails_when|no_claim)\b/.test(fs.readFileSync(path.join(E2E, f), 'utf8')),
  );
  expect(missing).toEqual([]);
});
