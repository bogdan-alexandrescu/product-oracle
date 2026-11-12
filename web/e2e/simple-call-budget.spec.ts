import { writeFileSync } from "node:fs";

import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * Card simple-call-budget: protects = each Simple page asks the API for each read once: on its
 * first load no URL is read twice (the rail and the page share one call), and on moving to it
 * from another page the rail's counts read a moment ago are not read again unless the page
 * itself shows that data; fails_when = a page and the rail, or two parts of a page, each fetch
 * the same route, or every move between pages reads the rail's lists again (the slow waiting
 * list most of all); no_claim = how fast the API answers (the API lanes' timing tests).
 */

const WAITING = "GET /v1/simple/decisions/waiting";
const ROADMAP_WAITING = "GET /v1/simple/roadmap/waiting";
const INBOX = "GET /v1/inbox";
const QUESTIONS = "GET /v1/inbox/questions";
const SUGGESTIONS = "GET /v1/simple/goal-suggestions?status=open";
const MEETINGS = "GET /v1/simple/meetings";
const CAPABILITIES = "GET /v1/me/capabilities";

/** Per page: where it lives, its rail button, and the rail's reads it does not show itself. */
const PAGES: { name: string; path: string; nav: string; railOnly: string[] }[] = [
  { name: "Home", path: "/simple", nav: "simple-nav-home", railOnly: [ROADMAP_WAITING, CAPABILITIES] },
  { name: "Roadmap", path: "/simple/roadmap", nav: "simple-nav-roadmap", railOnly: [INBOX, QUESTIONS, MEETINGS, CAPABILITIES] },
  { name: "Goal map", path: "/simple/goals", nav: "simple-nav-goals", railOnly: [WAITING, ROADMAP_WAITING, INBOX, QUESTIONS, MEETINGS, CAPABILITIES] },
  { name: "Priorities", path: "/simple/priorities", nav: "simple-nav-priorities", railOnly: [WAITING, ROADMAP_WAITING, INBOX, QUESTIONS, MEETINGS, CAPABILITIES] },
  { name: "Decisions", path: "/simple/decisions", nav: "simple-nav-decisions", railOnly: [ROADMAP_WAITING, INBOX, QUESTIONS, SUGGESTIONS, MEETINGS, CAPABILITIES] },
  { name: "Inbox", path: "/simple/inbox", nav: "simple-nav-inbox", railOnly: [WAITING, ROADMAP_WAITING, SUGGESTIONS, MEETINGS, CAPABILITIES] },
  { name: "Meetings", path: "/simple/meetings", nav: "simple-nav-meetings", railOnly: [WAITING, ROADMAP_WAITING, INBOX, QUESTIONS, SUGGESTIONS, CAPABILITIES] },
  { name: "One-pagers", path: "/simple/one-pagers", nav: "simple-nav-one-pagers", railOnly: [WAITING, ROADMAP_WAITING, INBOX, QUESTIONS, SUGGESTIONS, MEETINGS, CAPABILITIES] },
];

/** The calls the in-browser mock API has served since this page loaded. */
const calls = (page: Page) => page.evaluate(() => [...((globalThis as { __poMockCalls?: string[] }).__poMockCalls ?? [])]);

/** Waits until no call has been made for a moment (at most a few rounds), then returns them all. */
async function settledCalls(page: Page): Promise<string[]> {
  let last = -1;
  for (let i = 0; i < 6; i++) {
    const now = (await calls(page)).length;
    if (now === last) break;
    last = now;
    await page.waitForTimeout(1200);
  }
  return calls(page);
}

/** The GET calls made more than once, with how many times. */
function twice(list: string[]): Record<string, number> {
  const n: Record<string, number> = {};
  for (const c of list) if (c.startsWith("GET ")) n[c] = (n[c] ?? 0) + 1;
  return Object.fromEntries(Object.entries(n).filter(([, k]) => k > 1));
}

/** E2E_CALLS_DIR: each test also writes the calls it saw there (the before/after table). */
function record(name: string, list: string[]) {
  const dir = process.env.E2E_CALLS_DIR;
  if (dir) writeFileSync(`${dir}/${name.replace(/[^a-z-]+/gi, "_")}.json`, JSON.stringify(list));
}

for (const p of PAGES) {
  test.describe(p.name, () => {
    test("reads each URL once on its first load", async ({ page }) => {
      await login(page);
      await page.goto(p.path);
      await expect(page.getByTestId(p.nav).first()).toBeVisible();
      const seen = await settledCalls(page);
      record(`${p.name} load`, seen);
      expect(twice(seen)).toEqual({});
    });

    test("reads each URL at most once on moving to it, and none of the rail's counts again", async ({ page }) => {
      await login(page);
      const from = p.path === "/simple" ? "/simple/roadmap" : "/simple";
      await page.goto(from);
      await expect(page.getByTestId(p.nav).first()).toBeVisible();
      await settledCalls(page);
      await page.evaluate(() => ((globalThis as { __poMockCalls?: string[] }).__poMockCalls!.length = 0));
      await page.getByTestId(p.nav).first().click();
      await expect(page).toHaveURL((u) => u.pathname === p.path);
      const seen = await settledCalls(page);
      record(`${p.name} nav`, seen);
      expect(twice(seen)).toEqual({});
      expect(seen.filter((c) => p.railOnly.includes(c))).toEqual([]);
    });
  });
}
