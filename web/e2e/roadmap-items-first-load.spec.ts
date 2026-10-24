import { expect, test, type Page } from "./test";

import { ROADMAP_REVIEW_RUN } from "../lib/api/mock/runs";
import { MOCK_SLOW_KEY, MOCK_SLOW_MS } from "../lib/api/mock/server";
import { login, seedRoadmapReview } from "./helpers";

// D1 Roadmap items review, first load (found on 2026-10-24: "Loading…" for seconds before
// the table drew). The screen needs the run and the checkpoint's shared draft; it asks for
// both at once, not the draft only once the run has answered.

const RUN = ROADMAP_REVIEW_RUN.run.id;
const CP = ROADMAP_REVIEW_RUN.run.checkpoints[0].id;
const SCREEN = `/runs/${RUN}/review/${CP}`;
const RUN_READ = `GET /v1/runs/${RUN}`;
const DRAFT_READ = `GET /v1/runs/${RUN}/checkpoints/${CP}/review`;

/** The calls the in-browser mock API has served since this page loaded. */
const calls = (page: Page) => page.evaluate(() => [...((globalThis as { __poMockCalls?: string[] }).__poMockCalls ?? [])]);

// Card entry: protects = the review screen reads the run and its draft together, each once,
// so its first load waits for the slower of the two, not their sum; fails_when = the draft is
// asked for only after the run answers, or either is read twice before the table draws;
// no_claim = the API's statements per read (api/tests/test_roadmap_items_review_reads.py).
test("the review screen reads the run and the draft together on its first load", async ({ page }) => {
  await login(page);
  await seedRoadmapReview(page);
  // The run's read answers late, as on a slow network.
  await page.evaluate(([key, path]) => localStorage.setItem(key, path), [MOCK_SLOW_KEY, `/v1/runs/${RUN}`]);
  await page.goto(SCREEN);
  // While the run is still on its way, the draft has been asked for already.
  await expect(page.getByRole("status").filter({ hasText: "Loading…" }).first()).toBeVisible();
  await expect.poll(() => calls(page), { timeout: MOCK_SLOW_MS / 2 }).toContain(DRAFT_READ);
  await expect(page.locator('[data-testid="roadmap-item-row"]')).toHaveCount(0);

  await expect(page.getByRole("heading", { level: 1, name: "Roadmap items" })).toBeVisible();
  await expect(page.locator('[data-testid="roadmap-item-row"]').first()).toBeVisible();
  const served = await calls(page);
  expect(served.filter((c) => c === RUN_READ)).toHaveLength(1);
  expect(served.filter((c) => c === DRAFT_READ)).toHaveLength(1);
  await page.evaluate((key) => localStorage.removeItem(key), MOCK_SLOW_KEY);
});
