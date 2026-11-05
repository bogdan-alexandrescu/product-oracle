import { test as base } from "@playwright/test";

import { MOCK_NOW } from "../lib/api/mock/clock";

export { expect } from "@playwright/test";
export type { Browser, BrowserContext, Locator, Page } from "@playwright/test";

/**
 * E2E_TEXT_SPACING (a CSS length, "0.4px" or "-0.3px") sets letter-spacing on every page's
 * body: text then runs a few percent wider or narrower, as the same font does on another
 * system (macOS draws Inter Tight wider than Linux), so a layout that only just fits shows.
 */
const TEXT_SPACING = process.env.E2E_TEXT_SPACING;

function widenText(spacing: string) {
  const add = () => {
    const style = document.createElement("style");
    style.textContent = `*, *::before, *::after { letter-spacing: ${spacing} !important; }`;
    document.head.appendChild(style);
  };
  if (document.head) add();
  else document.addEventListener("DOMContentLoaded", add);
}

/**
 * Every spec's `test` (#520: pin the mock clock). Each browser context starts at the
 * mock's fixed "now", MOCK_NOW, and the clock then runs on, so timers and polling work
 * as usual while dates no longer move with the wall clock. A test that needs another
 * moment still sets it with page.clock.
 */
export const test = base.extend({
  context: async ({ context }, provide) => {
    await context.clock.install({ time: MOCK_NOW });
    if (TEXT_SPACING) await context.addInitScript(widenText, TEXT_SPACING);
    await provide(context);
  },
});

/** The mock's "now" as the test reads it, for dates a test works out itself. */
export const mockNow = () => new Date(MOCK_NOW);
