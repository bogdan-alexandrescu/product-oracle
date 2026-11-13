import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * Visual QA, Nov 12, 2026 (docs/qa/2026-11-12/simple-roadmap.md), the Roadmap page's own parts:
 * #1 the Needs a decision panel names each item by its code and name ("F-06 Weekly alert digest"),
 * an item with no code flagged "Not in the Ground Truth"; #5 an end past its milestone names the
 * milestone with its code ("M1 Beta"); #12 "Undone" answers in the bottom-right corner its
 * "Moved …" toast was in, never over the page's title; #14 the Waterfall's "Drag a bar …" line
 * sits behind an (i) on the key's "Phases" label; #15 an archived goal's Removed row does not
 * say "Goals" again after "Goal". The mock's default seed (invented products and people).
 */

const URL = "/simple/roadmap";
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

const bar = (page: Page, key: string): Locator => page.locator(`g[data-testid="bar"][data-item="${key}"]`);
const body = (page: Page, key: string): Locator => bar(page, key).locator("rect[data-body]");
const toast = (page: Page): Locator => page.getByTestId("toasts").getByRole("status");

async function open(page: Page) {
  await login(page);
  await page.goto(URL);
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
}

/** Drags a Gantt bar by `dx` pixels with the mouse, from its middle. */
async function drag(page: Page, key: string, dx: number) {
  await body(page, key).scrollIntoViewIfNeeded();
  const box = (await body(page, key).boundingBox())!;
  const x = box.x + Math.min(box.width / 2, 120);
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 12 });
  await page.mouse.up();
}

/** The toast sits in the bottom-right corner of a 1440 x 900 window, clear of the page's title. */
async function inCorner(page: Page) {
  const box = (await toast(page).boundingBox())!;
  const vw = page.viewportSize()!;
  expect(box.x + box.width, "its right edge is near the window's").toBeGreaterThan(vw.width - 60);
  expect(box.x, "it starts right of the middle").toBeGreaterThan(vw.width / 2);
  expect(box.y, "it is in the lower half").toBeGreaterThan(vw.height / 2);
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Needs a decision names items by code and name, flags one with no code, and names the milestone with its code", async ({ page }) => {
    // protects: in the owner's Needs a decision panel at 1440 px, the broken-links line for Weekly alert digest reads "F-06 Weekly alert digest" with no Not in the Ground Truth mark, a broken item with no code carries "Not in the Ground Truth", and the digest's end past its milestone names it "M1 Beta"
    // fails_when: an item is named by its title alone, an item with no code shows no mark, or the reason says "after its milestone ‘Beta’"
    // no_claim: the chart's rows and cards, the exports, and the API's own reason words
    await open(page);
    await page.getByTestId("needs-decision").click();
    const tray = page.getByTestId("decision-tray");
    await expect(tray).toBeVisible();
    const digest = tray.getByTestId("tray-broken").filter({ has: page.getByTestId("tray-item").filter({ hasText: "Weekly alert digest" }) });
    await expect(digest.getByTestId("tray-item")).toHaveText("F-06 Weekly alert digest");
    await expect(digest.getByTestId("not-in-gt")).toHaveCount(0);
    await expect(digest.getByTestId("flag-reason").filter({ hasText: "after its milestone" })).toContainText(/after its milestone ‘M\d+ Beta’/);
    // A broken item with no code is flagged beside its name.
    const uncoded = tray.getByTestId("tray-broken").filter({ hasNot: page.getByTestId("tray-item").filter({ hasText: /^F-\d+ / }) }).first();
    await expect(uncoded.getByTestId("not-in-gt")).toHaveText("Not in the Ground Truth");
  });

  test("Undo from a Moved toast says Undone in the bottom-right corner", async ({ page }) => {
    // protects: at 1440 px, after an owner drags Alert history export on the Gantt and presses Undo in the "Moved …" toast, an "Undone" toast shows in the bottom-right corner, where the Moved toast was
    // fails_when: no Undone shows, or it shows at the top or the left, over the page's title
    // no_claim: the undo's own dates (simple-roadmap.spec.ts) and a phone's centred strip
    await open(page);
    await page.getByTestId("format-gantt").click();
    await expect(bar(page, "alert-export")).toBeVisible();
    await drag(page, "alert-export", 90);
    await expect(toast(page)).toContainText("Moved 'Alert history export'");
    await inCorner(page);
    await toast(page).getByRole("button", { name: "Undo" }).click();
    await expect(toast(page)).toContainText("Undone");
    await inCorner(page);
  });

  test("Undo in the working draft's banner says Undone in the bottom-right corner, not over the title", async ({ page }) => {
    // protects: at 1440 px, after a drag puts a change in the working draft, its banner's Undo shows "Undone" in the bottom-right corner
    // fails_when: the Undone toast sits at the top of the window, over the page's title and scope
    // no_claim: the banner's counts after Undo (simple-roadmap-count-waits.spec.ts)
    await open(page);
    await page.getByTestId("format-gantt").click();
    await expect(bar(page, "alert-export")).toBeVisible();
    await drag(page, "alert-export", 90);
    await expect(toast(page)).toContainText("Moved 'Alert history export'");
    await toast(page).getByRole("button", { name: "Dismiss" }).click();
    await page.getByTestId("draft-banner").getByRole("button", { name: "Undo" }).click();
    await expect(toast(page)).toContainText("Undone");
    await inCorner(page);
  });

  test("the Removed list's archived goal does not say Goals again", async ({ page }) => {
    // protects: the Removed list's archived goal row reads "Goal · Archived on …", not "Goal · Goals · Archived on …"
    // fails_when: the row's middle part repeats the kind ("Goals")
    // no_claim: the feature and milestone rows' places, and Restore
    await open(page);
    await page.getByTestId("removed-open").click();
    const list = page.getByRole("dialog", { name: "Removed from your plans" });
    const goal = list.getByTestId("removed-row").filter({ hasText: "Fewer support tickets about billing" });
    await expect(goal).toContainText(/Goal · Archived on [A-Z][a-z]{2} \d+/);
    await expect(goal).not.toContainText("Goals");
  });
});

test.describe("phone", () => {
  test.use(PHONE);

  test("the Waterfall's key keeps the drag words behind an (i) on Phases", async ({ page }) => {
    // protects: on a 390 px phone, the Waterfall's key shows no "Drag a bar …" sentence; the (i) beside its Phases label holds it
    // fails_when: the sentence shows as prose under the chart, or no (i) on Phases holds it
    // no_claim: the drag itself (simple-roadmap-plus.spec.ts) and the Gantt's and board's keys
    await open(page);
    await page.getByTestId("format-waterfall").click();
    await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", "waterfall");
    const legend = page.getByTestId("legend");
    await expect(legend).toBeVisible();
    await expect(legend.getByText(/Drag a bar/)).toBeHidden();
    const tip = legend.getByRole("button", { name: "About Phases" });
    await tip.scrollIntoViewIfNeeded();
    await tip.click();
    await expect(page.getByRole("tooltip").filter({ hasText: "Drag a bar (press and hold first)" })).toBeVisible();
  });
});
