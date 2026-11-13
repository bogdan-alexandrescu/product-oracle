import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * Visual QA, Nov 12, 2026 (docs/qa/2026-11-12/simple-home.md), Simple's Home, Decisions'
 * Waiting for you and the Inbox on the mock's invented data: #4 a broken link's or a date's
 * feature shows its code before its name (Home, Decisions, the Inbox, Walk me through it),
 * #6 on a phone a Dates row's why sits behind its (i), #18 Simple's Inbox says its count once.
 */

const CODE = /^[A-Z][A-Z0-9]*-\d+[a-j]?$/;

async function open(page: Page, path: string) {
  await login(page);
  await page.goto(path);
}

/**
 * The waiting rows of a feature with a code start its name with that code: both of Weekly alert
 * digest's broken links (F-06) and Health log's dates (F-03). A feature with no code (the cut
 * In-app tour) has none to show.
 */
async function codedRows(page: Page, { broken }: { broken: boolean }) {
  const rows = page.getByTestId("simple-page").getByTestId("waiting-item");
  const health = rows.and(page.locator('[data-kind="date"]')).filter({ hasText: "Health log" });
  await expect(health.locator(".simple-code")).toHaveText("F-03");
  // Home lists broken links in their own card (named with their codes there), not among these rows.
  if (!broken) return;
  const digest = rows.and(page.locator('[data-kind="broken_link"]')).filter({ hasText: "Weekly alert digest" });
  await expect(digest).toHaveCount(2);
  for (const k of [0, 1]) await expect(digest.nth(k).locator(".simple-code")).toHaveText("F-06");
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  /** #4: fails when "Broken link · Weekly alert digest" or "Dates to confirm · …" shows no code. */
  test("#4 Decisions' Waiting for you names each feature with its code", async ({ page }) => {
    await open(page, "/simple/decisions");
    await expect(page.getByRole("region", { name: "Waiting for you", exact: true })).toBeVisible();
    await codedRows(page, { broken: true });
  });

  /** #4: fails when Home's Also waiting for you names a feature without its code. */
  test("#4 Home's Also waiting for you names each feature with its code", async ({ page }) => {
    await open(page, "/simple");
    await codedRows(page, { broken: false });
  });

  /** #4: fails when an Inbox Dates row's feature shows no code. */
  test("#4 the Inbox's Dates rows name each feature with its code", async ({ page }) => {
    await open(page, "/simple/inbox");
    const names = page.locator('[data-testid="date-suggestion-context"]').locator("xpath=..").getByTestId("feature-name");
    await expect(names.first()).toBeVisible();
    const n = await names.count();
    for (let k = 0; k < Math.min(n, 5); k++) await expect(names.nth(k).locator(".simple-code")).toHaveText(CODE);
  });

  /** #4: fails when Walk me through it's broken link step names the feature without its code. */
  test("#4 Walk me through it names a broken link's feature with its code", async ({ page }) => {
    await open(page, "/simple");
    const walk = page.getByRole("button", { name: "Walk me through it" });
    await walk.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await walk.click();
    const step = page.locator('[data-testid="walk-step"][data-kind="broken_link"]');
    await expect(step).toBeVisible();
    await expect(step.getByTestId("walk-step-title").locator(".simple-code")).toHaveText(CODE);
  });

  /** #18: fails when Simple's Inbox shows "N waiting" beside its title as well as Needs you's count. */
  test("#18 Simple's Inbox says its count once", async ({ page }) => {
    await open(page, "/simple/inbox");
    await expect(page.getByTestId("inbox-needs")).toBeVisible();
    await expect(page.getByText(/^\d+ waiting$/)).toHaveCount(0);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  /** #6: fails when every Dates row prints its long why on a phone. */
  test("#6 on a phone a Dates row's why is behind its (i)", async ({ page }) => {
    await open(page, "/simple/inbox");
    await expect(page.getByTestId("date-suggestion-context").first()).toBeVisible();
    await expect(page.getByTestId("date-suggestion-basis").first()).toBeHidden();
    await expect(page.getByText(/^It starts with/).filter({ visible: true })).toHaveCount(0);
    const tip = page.getByTestId("date-suggestion-basis-tip").first();
    await expect(tip).toBeVisible();
  });
});
