import { expect, test } from "./test";

import { login } from "./helpers";

// X-9: Present mode's Sources slide lists each source by its title and when it was
// retrieved, as the API's deck does; never the kind of source ("web", "gdocs").

test.use({ viewport: { width: 1440, height: 900 } });

test("X-9: the Sources slide lists each source by title, without its kind", async ({ page }) => {
  await login(page);
  await page.goto("/documents/saved-carts/v/2");
  await page.getByRole("link", { name: "Present" }).filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/documents\/saved-carts\/v\/2\/present$/);
  const counter = page.getByTestId("slide-counter");
  await expect(counter).toHaveText("1 / 10");
  await page.keyboard.press("End");
  await expect(counter).toHaveText("10 / 10");

  const slide = page.getByTestId("audience-view").locator(".current-slide");
  await expect(slide.locator(".slide-title")).toHaveText("Sources and data points");
  const items = slide.locator(".slide-sources li");
  await expect(items).toHaveCount(2);
  await expect(items.locator(".src-title")).toHaveText(["Cart abandonment survey", "Repeat orders, Q3 review"]);
  await expect(items.nth(0)).toContainText(/retrieved Oct\s15,\s2026,\s3:00\sAM\sPDT/);
  await expect(slide.locator(".src-kind")).toHaveCount(0);
  for (const kind of ["web", "gdocs"]) await expect(slide.locator(".slide-sources")).not.toContainText(kind);
});
