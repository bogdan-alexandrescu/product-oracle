import { expect, test, type Locator, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA fixes on Settings › Webhooks and Autonomy (qa-settings-33, -34), driven through the UI on
 * the mock layer: on a desktop their forms open as a centred dialog of readable width, on a
 * phone they stay a full-width bottom sheet; a fixed limit is shown, not offered for editing.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function open(page: Page, nav: "webhooks" | "autonomy", phone = false) {
  await login(page);
  if (phone) await page.goto(`/settings/${nav}`);
  else {
    await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
    await page.getByRole("navigation", { name: "Settings" }).getByTestId(`nav-${nav}`).click();
  }
  await expect(page).toHaveURL(new RegExp(`/settings/${nav}$`));
}

async function expectCentredDialog(dialog: Locator) {
  const box = (await dialog.boundingBox())!;
  expect(box.width).toBeLessThan(720);
  expect(box.width).toBeGreaterThan(400);
  expect(Math.abs(box.x + box.width / 2 - DESKTOP.width / 2)).toBeLessThan(4);
  // Off the bottom edge: a dialog, not a sheet.
  expect(box.y + box.height).toBeLessThan(DESKTOP.height - 8);
}

test("qa-settings-33: on a desktop, New webhook opens as a centred dialog of readable width", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await open(page, "webhooks");
  await page.getByRole("button", { name: "New webhook" }).click();
  const dialog = page.getByRole("dialog", { name: "New webhook" });
  await expect(dialog).toBeVisible();
  await expectCentredDialog(dialog);
  await expect(page.getByTestId("new-webhook-sheet").getByTestId("sheet-handle")).toBeHidden();
});

test("qa-settings-33: on a desktop, an Autonomy change opens as a centred dialog", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await open(page, "autonomy");
  await page.getByTestId("autonomy-row-priorities").getByRole("group").getByRole("button", { name: "Act", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Change Order priorities" });
  await expect(dialog).toBeVisible();
  await expectCentredDialog(dialog);
  // Cancel and Save sit inside the dialog's width, not in the window's corner.
  const save = (await dialog.getByRole("button", { name: "Save" }).boundingBox())!;
  const box = (await dialog.boundingBox())!;
  expect(save.x + save.width).toBeLessThanOrEqual(box.x + box.width);
});

test("qa-settings-33: on a phone, New webhook stays a full-width bottom sheet", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await open(page, "webhooks", true);
  await page.getByRole("button", { name: "New webhook" }).click();
  const dialog = page.getByRole("dialog", { name: "New webhook" });
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!;
  expect(Math.round(box.width)).toBe(PHONE.width);
  expect(Math.round(box.y + box.height)).toBe(PHONE.height);
  await expect(page.getByTestId("new-webhook-sheet").getByTestId("sheet-handle")).toBeVisible();
});

test("qa-settings-34: a limit that is fixed is shown as text, with no Edit limits", async ({ page }) => {
  await open(page, "autonomy");
  const baseline = page.getByTestId("autonomy-row-baseline");
  await expect(baseline.getByTestId("autonomy-limits")).toHaveText("unlocked entries only");
  await expect(baseline.getByRole("button", { name: "Edit limits" })).toHaveCount(0);
  // A limit an owner can change still has its button.
  await page.getByTestId("autonomy-row-priorities").getByRole("group").getByRole("button", { name: "Act", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Change Order priorities" });
  await sheet.getByLabel("Why").fill("Small moves are fine");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByTestId("autonomy-row-priorities").getByRole("button", { name: "Edit limits" })).toBeVisible();
});
