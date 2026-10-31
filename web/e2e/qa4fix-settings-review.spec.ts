import { expect, test, type Locator, type Page } from "./test";

import { login } from "./helpers";

/*
 * Review follow-ups on the QA pass 4 Settings fixes, driven through the UI on the mock layer
 * as a person would.
 */

test("Inbox counts the sources that need attention as Settings › Sources does", async ({ page }) => {
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-sources").click();
  await expect(page.getByTestId("sources-attention")).toHaveText("3 need attention");

  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-inbox").first().click();
  const group = page.getByTestId("inbox-sources");
  await expect(group.getByTestId("source-need-text")).toHaveCount(3);
  // The source that lost access to a doc and a folder, and the one that must reconnect.
  await expect(group.getByRole("row").filter({ hasText: "Product docs" }).getByTestId("source-need-text")).toHaveText(
    "Lost access to 2 items: share them again or remove them from this source",
  );
  await expect(group.getByRole("row").filter({ hasText: "Drive folders" }).getByTestId("source-need-text")).toHaveText(
    "Reconnect to choose files: reconnect its account in Settings › Connections",
  );
  await expect(group).toContainText("Legacy all-hands chat");
  // Not the one in error.
  await expect(group).not.toContainText("Example repo");

  await group.getByRole("link", { name: "Edit Drive folders" }).click();
  await expect(page).toHaveURL(/\/settings\/sources#source-/);
});

/** A switch's drawn box: appearance, fill and border, as the dark theme draws it. */
const drawn = (box: Locator) =>
  box.evaluate((el) => {
    const css = getComputedStyle(el);
    return { appearance: css.appearance, background: css.backgroundColor, border: css.borderTopColor, tick: css.backgroundImage !== "none" };
  });

const ACCENT = "rgb(124, 200, 248)";
const LINE_STRONG = "rgb(95, 112, 135)";

/** Unchecked reads as an empty outline; checked as the accent with a tick. */
async function expectDarkSwitch(page: Page, box: Locator) {
  await expect(box).not.toBeChecked();
  expect(await drawn(box)).toEqual({ appearance: "none", background: "rgba(0, 0, 0, 0)", border: LINE_STRONG, tick: false });
  await box.click();
  await expect(box).toBeChecked();
  expect(await drawn(box)).toEqual({ appearance: "none", background: ACCENT, border: ACCENT, tick: true });
  const size = await box.boundingBox();
  expect(Math.round(size!.width)).toBeGreaterThanOrEqual(16);
}

test.describe("dark theme", () => {
  test.use({ colorScheme: "dark" });

  test("qa4-settings-20: the new webhook's owners-and-approvers switch reads off, then on", async ({ page }) => {
    await login(page);
    await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
    await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-webhooks").click();
    await page.getByRole("button", { name: "New webhook" }).click();
    const sheet = page.getByRole("dialog", { name: "New webhook" });
    await expectDarkSwitch(page, sheet.getByRole("switch", { name: "Include owners-and-approvers content" }));
    // On, it asks why.
    await expect(sheet.getByLabel("Why")).toBeVisible();
  });

  test("qa4-settings-20: the Requests Auto-sort switch reads off, then on", async ({ page }) => {
    await login(page);
    await page.getByTestId("nav-requests").filter({ visible: true }).first().click();
    await page.getByTestId("triage-menu").click();
    const box = page.getByTestId("triage-menu-panel").getByRole("switch", { name: /^Auto-sort new requests daily/ });
    await expectDarkSwitch(page, box);
    await expect(page.getByTestId("triage-menu")).toHaveText("Auto-sort: On");
  });
});
