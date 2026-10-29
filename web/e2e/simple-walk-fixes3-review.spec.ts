import { expect, test } from "./test";

import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";

/*
 * The walk-fixes-3 review: a ritual's occurrence held by its Simple review meeting is still
 * recorded in Detailed, driven through the UI on the mock layer (lib/api/mock/rituals.ts,
 * simple-meetings.ts). Made-up people and items only.
 *
 * Card walk3-review-record-held: protects = after the owner starts the weekly check-in's review
 * from Meetings > Upcoming and ends it (the occurrence is held), the ritual's occurrence page in
 * Detailed still offers the owner its notes, without Skip, and Mark held saves them; fails_when
 * = the page shows only "No notes" (the API answered 409 "This occurrence is held"), or offers
 * Skip on a held occurrence; no_claim = the audit event (api: test_simple_walk_fixes3_m2_api).
 */

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1366, height: 820 };

for (const [phone, scheme] of [[false, "light"], [false, "dark"], [true, "light"]] as const) {
  const where = `${phone ? "phone" : "desktop"}, ${scheme}`;
  test.describe(where, () => {
    test.use({ viewport: phone ? PHONE : DESKTOP, colorScheme: scheme });

    test(`the owner records the notes of a review held in Simple (${where})`, async ({ page }) => {
      await page.context().addInitScript(([key, theme]) => localStorage.setItem(key, theme), [THEME_KEY, scheme] as const);
      await login(page);
      // The owner prepares the next weekly goals check-in in Detailed: its occurrence page.
      await page.setViewportSize(DESKTOP);
      await page.goto("/company/rituals");
      await page.getByTestId("ritual-row").filter({ hasText: "Weekly goals check-in" }).click();
      await page.getByTestId("ritual-inspector").filter({ visible: true }).getByRole("button", { name: "Prepare now" }).click();
      await expect(page).toHaveURL(/\/company\/rituals\/[0-9a-f-]{36}$/);
      const occurrence = page.url();
      if (phone) await page.setViewportSize(PHONE);

      // The review is held early in Simple: started from Upcoming, then ended.
      await page.goto("/simple/meetings");
      const row = page.getByRole("region", { name: "Upcoming" }).getByTestId("meetings-upcoming-row").filter({ hasText: "Weekly goals check-in" }).first();
      await row.getByRole("button", { name: "Start review" }).click();
      await page.getByRole("dialog", { name: "Start a review" }).getByRole("button", { name: "Start", exact: true }).click();
      await page.getByRole("button", { name: "End meeting" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "End meeting" }).click();
      await expect(page.getByRole("button", { name: "End meeting" })).toHaveCount(0);

      // Back on the occurrence page: the notes are still the owner's to record.
      await page.goto(occurrence);
      const record = page.getByRole("region", { name: "Record the meeting" });
      await expect(record).toBeVisible();
      await expect(record.getByRole("button", { name: "Skip" })).toHaveCount(0);
      await record.getByLabel("Notes").fill("Agreed to ship F-03 Guided setup first.");
      await record.getByRole("button", { name: "Mark held" }).click();
      await expect(page.getByRole("region", { name: "Record the meeting" })).toHaveCount(0);
      await expect(page.getByText("Agreed to ship F-03 Guided setup first.")).toBeVisible();
      if (phone) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);
    });
  });
}
