import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * hotfix-2: moving a roadmap item whose dates come from a date source is accepted. In the
 * "simple-dated-move" scenario (invented data), Alert replay engine came from the Usage alerts
 * PRD dated only by engineering's end, Apr 2, 2027: the item stores that end, and the roadmap
 * shows a start its effort before it (Mar 6). A move sends the dates the roadmap shows as its
 * `before`; it sent the stored ones (none, as engineering's), so every move was refused
 * "Changed since you saw it", also right after a reload.
 *
 * protects = dragging that bar earlier, or moving it with the arrow keys, is accepted, with no
 * refusal, and the new dates show as the item's own, also after a reload; fails_when = the move
 * is refused or the bar snaps back to Mar 6 - Apr 2; no_claim = the API's check
 * (api/tests/test_approved_prd_roadmap_api.py).
 */

const bar = (page: Page, key: string): Locator => page.locator(`g[data-testid="bar"][data-item="${key}"]`);
const refused = (page: Page) => page.getByText(/Changed since you saw it/);

async function open(page: Page) {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "simple-dated-move"] as const);
  await login(page, ADMIN.email);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  // Bars move on the Gantt (the Timeline is for reading).
  await page.getByTestId("format-gantt").click();
  const b = bar(page, "alert-replay");
  await b.scrollIntoViewIfNeeded();
  await expect(b).toHaveAttribute("data-start", "2027-03-06");
  await expect(b).toHaveAttribute("data-end", "2027-04-02");
  return b;
}

test.use({ viewport: { width: 1440, height: 900 } });

test("dragging a bar dated by engineering earlier is accepted and the new dates show", async ({ page }) => {
  const b = await open(page);
  const box = (await b.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let n = 1; n <= 12; n++) await page.mouse.move(x - n * 10, y);
  await page.mouse.up();
  await expect(page.getByText(/^Moved 'Alert replay engine' to /)).toBeVisible();
  await expect(b).not.toHaveAttribute("data-end", "2027-04-02");
  const start = (await b.getAttribute("data-start"))!;
  const end = (await b.getAttribute("data-end"))!;
  expect(end < "2027-04-02", "the bar moved earlier").toBe(true);
  await expect(refused(page)).toHaveCount(0);
  await page.reload();
  await page.getByTestId("format-gantt").click();
  await expect(bar(page, "alert-replay")).toHaveAttribute("data-start", start);
  await expect(bar(page, "alert-replay")).toHaveAttribute("data-end", end);
});

test("moving it with the arrow keys is accepted, also right after a reload", async ({ page }) => {
  let b = await open(page);
  await page.reload();
  await page.getByTestId("format-gantt").click();
  b = bar(page, "alert-replay");
  await b.focus();
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(1200);
  await expect(page.getByText(/^Moved 'Alert replay engine' to /)).toBeVisible();
  await expect(refused(page)).toHaveCount(0);
  await expect(b).toHaveAttribute("data-start", "2027-02-27");
  await expect(b).toHaveAttribute("data-end", "2027-03-26");
});
