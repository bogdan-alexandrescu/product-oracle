import { ownTreeOnly } from './lib/ownTreeOnly';

// #1716: a Vitest test reads only web/ and docs/contracts, as a Playwright spec does
// (e2e/test.ts); the old-names census reads every tree.
ownTreeOnly(['guards/ground-truth-words-source.test.ts']);
