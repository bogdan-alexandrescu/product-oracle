import { test as base } from "@playwright/test";

import { MOCK_NOW } from "../lib/api/mock/clock";

export { expect } from "@playwright/test";
export type { Browser, BrowserContext, Locator, Page } from "@playwright/test";

/**
 * Every spec's `test` (#520: pin the mock clock). Each browser context starts at the
 * mock's fixed "now", MOCK_NOW, and the clock then runs on, so timers and polling work
 * as usual while dates no longer move with the wall clock. A test that needs another
 * moment still sets it with page.clock.
 */
export const test = base.extend({
  context: async ({ context }, provide) => {
    await context.clock.install({ time: MOCK_NOW });
    await provide(context);
  },
});

/** The mock's "now" as the test reads it, for dates a test works out itself. */
export const mockNow = () => new Date(MOCK_NOW);
