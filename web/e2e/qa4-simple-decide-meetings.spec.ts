import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * The qa4-simple-decide findings on the Meetings page and its start sheet, driven through the
 * UI on the mock's invented data (Guided setup, Weekly goals check-in, Review: Usage alerts),
 * desktop and phone, as the company's owner.
 *
 * -5: "Everyone except viewers" says what it does: owners and each item's decider apply, others
 * propose. -7: a past meeting's time is labelled "started …", as Decisions dates it by its start.
 * -13: a greyed-out Start says what is missing beside it. -19: the sheet's review time reads
 * "Mon Nov 2, 9:00 AM", no zone letters. -21: a past meeting says its count once. -34: on a
 * phone the times and "Pre-read" never break across lines. -39: each row's Start review is named
 * for its review.
 */

const sheet = (page: Page) => page.getByRole("dialog", { name: "Start a review" });
const MOMENT = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{1,2}:\d{2} [AP]M$/;

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function meetings(page: Page) {
  await login(page);
  await page.goto("/simple/meetings");
  await expect(page.getByRole("region", { name: "Upcoming" })).toBeVisible();
}

async function openSheet(page: Page) {
  await meetings(page);
  await tap(page.getByRole("button", { name: "Start review" }).first());
  await sheet(page).getByLabel("PRD").selectOption({ label: "Guided setup" });
}

/** How many lines an inline element takes. */
const lines = (l: Locator) => l.evaluate((el) => el.getClientRects().length);

for (const phone of [false, true]) {
  test.describe(phone ? "phone" : "desktop", () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1512, height: 900 } });

    test("qa4-simple-decide-5: Everyone except viewers says who applies and who proposes", async ({ page }) => {
      await openSheet(page);
      const everyone = sheet(page).getByRole("radio", { name: "Everyone except viewers" });
      await expect(everyone).toBeChecked();
      await expect(everyone).toHaveAccessibleDescription("Owners and each item's decider apply; others propose.");
      await expect(sheet(page).getByText("Owners and each item's decider apply; others propose.")).toBeVisible();
    });

    test("qa4-simple-decide-13: a greyed-out Start says what is missing", async ({ page }) => {
      await openSheet(page);
      const s = sheet(page);
      const start = s.getByRole("button", { name: "Start", exact: true });
      for (const box of await s.getByRole("group", { name: "Who attends" }).getByRole("checkbox").all()) await box.uncheck();
      await expect(start).toBeDisabled();
      await expect(s.getByTestId("start-missing")).toHaveText("Tick at least one attendee besides you.");
      await expect(start).toHaveAccessibleDescription("Tick at least one attendee besides you.");
      await s.getByRole("group", { name: "Who attends" }).getByRole("checkbox", { name: "Theo Brandt" }).check();
      await expect(s.getByTestId("start-missing")).toHaveCount(0);
      await expect(start).toBeEnabled();
      await tap(s.getByRole("radio", { name: "Presenter plus one or two people" }));
      await expect(start).toBeDisabled();
      await expect(s.getByTestId("start-missing")).toHaveText("Pick who may change things.");
      await s.getByLabel("Who else changes things").getByRole("checkbox", { name: "Theo Brandt" }).check();
      await expect(s.getByTestId("start-missing")).toHaveCount(0);
      await expect(start).toBeEnabled();
    });

    test("qa4-simple-decide-19: the start sheet's review time reads month first with no zone letters", async ({ page }) => {
      await meetings(page);
      await tap(page.getByRole("button", { name: "Start review: Weekly goals check-in" }));
      const occ = sheet(page).getByTestId("start-occurrence");
      await expect(occ).toContainText("Weekly goals check-in");
      const text = (await occ.innerText()).split(" · ").pop()!.trim();
      expect(text).toMatch(MOMENT);
      await expect(occ).not.toContainText(/\b(PST|PDT|PT|GMT)\b/);
    });

    test("qa4-simple-decide-7 and -21: a past meeting is dated by its start, labelled, and says its count once", async ({ page }) => {
      await meetings(page);
      const past = page.getByRole("region", { name: "Past" });
      const row = past.getByTestId("meetings-past-row").filter({ hasText: "Review: Usage alerts" });
      await expect(row).toContainText(/ · started (Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M$/);
      await expect(past).toContainText("1 decision taken.");
      await expect(row).not.toContainText("decision");
    });

    test("qa4-simple-decide-34: times and Pre-read stay on one line", async ({ page }) => {
      await meetings(page);
      const time = page.getByTestId("meetings-past-row").filter({ hasText: "Review: Usage alerts" }).getByText(MOMENT);
      await expect(time).toBeVisible();
      expect(await lines(time)).toBe(1);
      const rows = page.getByTestId("meetings-upcoming-row");
      await expect(rows.first()).toBeVisible();
      for (const row of await rows.all()) {
        const pre = row.getByText("Pre-read", { exact: true });
        await expect(pre).toHaveCount(1);
        expect(await lines(pre)).toBe(1);
        const due = row.getByText(MOMENT);
        await expect(due).toHaveCount(1);
        expect(await lines(due)).toBe(1);
      }
    });

    test("qa4-simple-decide-39: each row's Start review is named for its review", async ({ page }) => {
      await meetings(page);
      const upcoming = page.getByRole("region", { name: "Upcoming" });
      const weekly = upcoming.getByRole("button", { name: "Start review: Weekly goals check-in", exact: true });
      await expect(weekly).toBeVisible();
      await expect(weekly).toHaveText("Start review");
      await expect(upcoming.getByRole("button", { name: "Start review", exact: true })).toHaveCount(0);
      const names = await upcoming.getByRole("button", { name: /^Start review: / }).evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
      expect(new Set(names).size).toBe(names.length);
      await tap(weekly);
      await expect(sheet(page).getByTestId("start-occurrence")).toContainText("Weekly goals check-in");
    });
  });
}
