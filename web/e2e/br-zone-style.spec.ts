import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * simple-home #13 (Nov 12 QA): one time-zone style in Simple, the short zone ("9:00 AM PDT")
 * as Home writes it. Meetings' Upcoming and Past rows, the Start a review sheet's time and an
 * ended meeting's "Ended …" line all carry it; none says "Pacific Time". Driven through the UI
 * on the mock's invented data (Weekly goals check-in, Review: Usage alerts), desktop and phone.
 */

const ZONED = /(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{1,2}:\d{2} [AP]M P[DS]T/;

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function meetings(page: Page) {
  await login(page);
  await page.goto("/simple/meetings");
  await expect(page.getByRole("region", { name: "Upcoming" })).toBeVisible();
}

for (const phone of [false, true]) {
  test.describe(phone ? "phone" : "desktop", () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 } });

    test("Meetings rows and the start sheet write the short zone", async ({ page }) => {
      await meetings(page);
      const rows = page.getByTestId("meetings-upcoming-row");
      await expect(rows.first()).toBeVisible();
      for (const row of await rows.all()) await expect(row).toContainText(ZONED);
      const past = page.getByTestId("meetings-past-row").filter({ hasText: "Review: Usage alerts" });
      await expect(past).toContainText(new RegExp(`started ${ZONED.source}`));
      await tap(page.getByRole("button", { name: "Start review: Weekly goals check-in" }));
      await expect(page.getByRole("dialog", { name: "Start a review" }).getByTestId("start-occurrence")).toContainText(ZONED);
    });

    test("an ended meeting reads Ended <day, time PDT>, not Pacific Time", async ({ page }) => {
      await meetings(page);
      await tap(page.getByTestId("meetings-past").getByRole("link", { name: "Review: Usage alerts" }).first());
      const ended = page.getByTestId("meeting-ended-at");
      await expect(ended).toContainText(new RegExp(`^Ended ${ZONED.source} · `));
      await expect(ended).not.toContainText("Pacific Time");
    });
  });
}
