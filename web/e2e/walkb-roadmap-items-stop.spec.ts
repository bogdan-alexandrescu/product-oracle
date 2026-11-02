import { expect, test, type Page } from "./test";

import { ROADMAP_REVIEW_RUN } from "../lib/api/mock/runs";
import { login, openSeeded, seedRoadmapReview } from "./helpers";

// walkb-roadmap 1: the Roadmap items stop (/runs/<id>/review/<checkpoint>) on the seeded
// roadmap review run. Webhooks has two reasons to confirm (Open blocker, PRD section changed).

const RUN = ROADMAP_REVIEW_RUN.run.id;
const CP = ROADMAP_REVIEW_RUN.run.checkpoints[0].id;
const SCREEN = `/runs/${RUN}/review/${CP}`;
const row = (page: Page, key: string) => page.locator(`[data-testid="roadmap-item-row"][data-key="${key}"]`);

async function handled(page: Page): Promise<number> {
  const text = (await page.getByText(/\d+ of \d+ handled/).first().textContent()) ?? "";
  return Number(/(\d+) of/.exec(text)![1]);
}

// Card entry: protects = each reason of an item holds its own Accept and the item then counts
// as handled; fails_when = accepting the second reason reopens the first; no_claim = blocking reasons.
test("an item with two reasons keeps an Accept for each and counts as handled", async ({ page }) => {
  await login(page);
  await openSeeded(page, seedRoadmapReview, SCREEN);
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap items" })).toBeVisible();
  const before = await handled(page);
  const webhooks = row(page, "webhooks");
  await webhooks.getByRole("button", { name: "Accept", exact: true }).click();
  // The first Accept answers Open blocker; the row then offers PRD section changed's own.
  await expect(webhooks.getByTestId("reason-chip").first()).toHaveText("PRD section changed");
  await webhooks.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(webhooks.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
  await expect(webhooks).toHaveAttribute("data-state", "handled");
  await expect.poll(() => handled(page)).toBe(before + 1);
  // After a reload the two Accepts still hold.
  await page.reload();
  await expect(row(page, "webhooks")).toHaveAttribute("data-state", "handled");
});

// Card entry: protects = the Milestone column shows the milestone's whole name beside its
// date; fails_when = the name is cut to a letter; no_claim = the inspector.
test("the Milestone column shows the milestone's name, not a letter", async ({ page }) => {
  await login(page);
  await openSeeded(page, seedRoadmapReview, SCREEN);
  const name = row(page, "slack-alerts").getByText("Beta", { exact: true });
  await expect(name).toBeVisible();
  // Its whole width shows: not cut to a letter.
  const cut = await name.evaluate((el) => el.scrollWidth > el.clientWidth + 1 || el.getBoundingClientRect().width < 20);
  expect(cut).toBe(false);
});
