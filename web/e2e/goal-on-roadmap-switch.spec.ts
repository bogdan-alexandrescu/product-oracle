import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * milestone-kinds (PR 1499 review): a goal's target date shows on the roadmap as a goal milestone
 * while the goal is "On the roadmap". Who may edit the goal turns that off and on in the goal's own
 * form on Priorities (Goal buckets), as a person would; on invented data (the mock's
 * "simple-plan" scenario, whose goal Reliability has a target date; the mock's today is Nov 3, 2026).
 *
 * Card goal-on-roadmap-switch: protects = the goal's form has an "On the roadmap" switch; off, the
 * goal's target-date milestone leaves the roadmap's Milestones band; on, it comes back; fails_when =
 * the form has no switch, or the milestone stays (or does not come back).
 * Card goal-target-diamond: protects = the goal's target-date diamond, not the reader's to move,
 * opens its card to read on a click; fails_when = the click does nothing.
 */

test.use({ viewport: { width: 1440, height: 900 } });

async function roadmap(page: Page) {
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await expect(page.getByTestId("ms-band")).toBeVisible();
}

/** The goal milestones on the Milestones band: the labels and those folded into a "+N". */
async function goalOnBand(page: Page, title: string): Promise<number> {
  const labels = await page
    .getByTestId("ms-label")
    .filter({ has: page.locator('[data-testid="mk-icon"][data-kind="goal"]') })
    .filter({ hasText: title })
    .count();
  const folded = (await page.getByTestId("ms-band-more").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""))).filter((t) => t.includes(` ${title} · `)).length;
  return labels + folded;
}

async function setOnRoadmap(page: Page, title: string, on: boolean) {
  await page.goto("/simple/priorities?tab=buckets");
  const bucket = page.getByTestId("goal-bucket").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  await bucket.getByRole("button", { name: `Edit ${title}` }).click();
  const form = bucket.getByTestId("goal-form");
  const sw = form.getByRole("switch", { name: "On the roadmap" });
  await expect(sw).toBeChecked({ checked: !on });
  await sw.click();
  await expect(sw).toBeChecked({ checked: on });
  await form.getByRole("button", { name: "Save goal" }).click();
  await expect(form).toBeHidden();
  await expect(page.getByTestId("bucket-note")).toContainText(`Saved ${title}`);
}

const TITLE = "Reliability";

test("a goal's On the roadmap switch takes its target-date milestone off the Milestones band and puts it back", async ({ page }) => {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "simple-plan"] as const);
  await login(page);
  await roadmap(page);
  // The goal's target date, drawn as a goal milestone named for the goal.
  expect(await goalOnBand(page, TITLE)).toBe(1);
  // Its diamond opens its card to read (it changes on the goal, not here).
  await page.locator(`[data-testid="ms-diamond"][data-kind="goal"][data-day="2027-02-12"]`).click();
  await expect(page.getByTestId("ms-card")).toHaveAttribute("data-rights", "read");
  await page.getByTestId("ms-card").getByRole("button", { name: "Close" }).click();

  await setOnRoadmap(page, TITLE, false);
  await roadmap(page);
  await expect.poll(() => goalOnBand(page, TITLE)).toBe(0);

  await setOnRoadmap(page, TITLE, true);
  await roadmap(page);
  await expect.poll(() => goalOnBand(page, TITLE)).toBe(1);
});
