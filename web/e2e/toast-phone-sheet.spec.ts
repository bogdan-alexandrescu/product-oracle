import { login } from "./helpers";
import { expect, test } from "./test";

/**
 * Card toast-phone-sheet (PR 1246): protects = on a phone, a message shown while a bottom sheet
 * is open (Key dates) sits right under the phone's top bar (44 px), clear of the header, the sheet
 * and its buttons; fails_when = the message sits near the bottom, over the open sheet, or its top
 * rule is not built and it lands wherever its place in the page puts it; no_claim = the message's
 * words (roadmap-keydates.spec.ts). Invented data: the mock's Onboarding roadmap.
 */

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test("on a phone, a message shown over the Key dates sheet sits at the top, clear of it", async ({ page }) => {
  await login(page);
  await page.goto("/simple/roadmap?roadmap=onboarding-roadmap");
  await page.getByTestId("key-dates-open").click();
  const sheet = page.getByTestId("key-dates-editor");
  await expect(sheet).toBeVisible();
  await sheet.getByLabel("New key date's name").fill("Partner demo day");
  await sheet.getByLabel("New key date's day").fill("2026-12-10");
  await sheet.getByRole("button", { name: /^(Add|Propose)$/ }).click();

  const message = page.getByTestId("toasts").getByRole("status");
  await expect(message).toBeVisible();
  await expect(sheet).toBeVisible();
  const said = (await message.boundingBox())!;
  const at = (await sheet.boundingBox())!;
  const header = (await page.getByTestId("phone-header").boundingBox())!;
  expect(header.height).toBe(44);
  await expect(page.getByTestId("toasts")).toHaveCSS("top", "44px");
  expect(said.y).toBe(44);
  expect(said.y + said.height).toBeLessThanOrEqual(at.y);
});
