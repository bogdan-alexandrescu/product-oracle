import { expect, mockNow, test, type Page } from "./test";

import { ADMIN } from "./helpers";
import { onlyTheRoadmapRefresh, trashEvery } from "./trash-helpers";

/*
 * home-deleted-roadmap: once every roadmap has left Trash for good (its 30 days passed),
 * Home's "Next review meeting" says the roadmap refresh's roadmap was deleted for good and on
 * which day (month first), no longer that it is in Trash, and links the ritual's settings.
 *
 * Test cards (protects / fails_when / no_claim):
 * - deleted for good: protects=with every roadmap moved to Trash through its menu and 31
 *   days gone by, "Next review meeting" reads "Its roadmap was deleted for good on Nov 22 · Ritual
 *   settings" (the day Trash deleted it)
 *   and the link opens the ritual; fails_when=it still says the roadmap is in Trash, or
 *   shows the refresh as if its roadmap were live, or only says so once Trash is visited,
 *   or leaves out the day or writes it ISO;
 *   no_claim=the API's check (pytest:
 *   test_home_ritual_deleted.py).
 */

const DAY_MS = 86_400_000;

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function roadmapDeletedForGood(page: Page) {
  await signIn(page);
  await onlyTheRoadmapRefresh(page);
  await page.goto("/plan/documents");
  await expect(page.getByTestId("roadmaps-table")).toBeVisible();
  expect(await trashEvery(page, page.getByTestId("roadmap-row"))).toBe(0);
  await expect(page.getByTestId("roadmap-row")).toHaveCount(0);

  // While the roadmaps wait in Trash, Home says so.
  await page.goto("/simple");
  const meeting = page.getByTestId("simple-page").getByTestId("home-meeting-next");
  await expect(meeting.getByTestId("home-meeting-trash")).toHaveText("Reviews a roadmap in Trash · Ritual settings");
  await expect(meeting.getByTestId("home-meeting-deleted")).toHaveCount(0);

  // A month on, Trash has deleted them for good: Home knows without a visit to Trash first.
  await page.clock.setSystemTime(new Date(mockNow().getTime() + 31 * DAY_MS));
  await page.goto("/simple");
  await expect(meeting).toContainText("Monthly roadmap refresh");
  const line = meeting.getByTestId("home-meeting-deleted");
  await expect(line).toHaveText("Its roadmap was deleted for good on Nov 22 · Ritual settings");
  await expect(meeting.getByTestId("home-meeting-trash")).toHaveCount(0);
  await line.getByRole("link", { name: "Ritual settings" }).click();
  await expect(page).toHaveURL(/\/company\/rituals\?ritual=/);
  await expect(page.getByRole("heading", { name: "Monthly roadmap refresh" }).filter({ visible: true })).toBeVisible();

  await page.goto("/settings/trash");
  await expect(page.getByTestId("trash-entry")).toHaveCount(0);
}

test("once its roadmap is deleted for good, the next review meeting says so", async ({ page }) => {
  await roadmapDeletedForGood(page);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("once its roadmap is deleted for good, the next review meeting says so", async ({ page }) => {
    await roadmapDeletedForGood(page);
  });
});
