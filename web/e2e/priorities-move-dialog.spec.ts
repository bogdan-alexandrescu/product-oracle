import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * detailed-b #15 (QA Nov 12, docs/qa/2026-11-12/detailed-b.md), the owner's pick of Nov 13: on Detailed
 * Priorities the Move dialog is a centred dialog above 600 px wide, like the other desktop confirmations; a phone
 * keeps the bottom sheet. Its contents stay (features show code and name). Driven through the UI on the mock.
 * fails_when = on a desktop the Move dialog spans the window's width or sits on its bottom edge, or on a phone it
 * is not a bottom sheet.
 */

async function moveUp(page: Page, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  await login(page);
  await page.goto("/priorities");
  await expect(page.getByTestId("priority-row-F-2")).toBeVisible();
  await page.getByTestId("priority-row-F-2").getByRole("button", { name: "Move up" }).click();
  const dialog = page.getByTestId("override-sheet");
  await expect(dialog).toContainText("Move F-2 Shipping cost shown in the cart");
  await expect(dialog.getByTestId("move-target")).toHaveText("Move above F-5 Address lookup service");
  await expect(dialog.getByRole("button", { name: "Save" })).toBeVisible();
  return dialog;
}

test("detailed-b 15: on a desktop the Move dialog is centred, not a full-width bottom sheet", async ({ page }) => {
  const dialog = await moveUp(page, { width: 1440, height: 900 });
  await expect(dialog).toHaveAttribute("role", "dialog");
  await expect(page.getByTestId("dialog-backdrop")).toBeVisible();
  const box = (await dialog.boundingBox())!;
  expect(box.width).toBeLessThan(800);
  expect(Math.abs(box.x + box.width / 2 - 720)).toBeLessThan(4);
  expect(box.y + box.height).toBeLessThan(900 - 8);
  // Escape closes it.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("detailed-b 15: on a phone the Move dialog stays a bottom sheet", async ({ page }) => {
  const dialog = await moveUp(page, { width: 390, height: 844 });
  await expect(page.getByTestId("dialog-backdrop")).toHaveCount(0);
  const box = (await dialog.boundingBox())!;
  expect(box.width).toBeGreaterThan(385);
  expect(Math.abs(box.y + box.height - 844)).toBeLessThan(2);
});
