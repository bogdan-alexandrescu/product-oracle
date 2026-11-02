import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN } from "./helpers";

/*
 * SW1 "A card per stop" (the owner's pick of Nov 1): each run stop that waits on me gets its own
 * card on Simple's Home, under the summary, with its one action as the card's button; the
 * greeting counts the runs, so Home no longer says "Nothing waits on you today." while a run waits.
 *
 * In the "simple-waits" mock scenario three runs wait on the owner: a feature set (Saved
 * addresses), an engineering review (Offline sync) and engineering dates (Usage alerts). Each
 * test runs on desktop and on a phone (390 px).
 */

async function signIn(page: Page, email: string, scenario: string) {
  await page.context().addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, scenario] as const);
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto("/simple");
  await expect(page.getByTestId("home-sentence")).toBeVisible();
}

const stops = (page: Page) => page.getByTestId("home-run-stop");

for (const phone of [false, true]) {
  const where = phone ? "phone" : "desktop";

  test.describe(where, () => {
    test.beforeEach(async ({ page }) => {
      if (phone) await page.setViewportSize({ width: 390, height: 844 });
    });

    test(`a card per waiting stop, its action opens the run at that stop (${where})`, async ({ page }) => {
      await signIn(page, ADMIN.email, "simple-waits");
      // Oldest first, each with what it is, which PRD it is for and since when it waits.
      await expect(stops(page)).toHaveCount(3);
      const feature = page.getByRole("region", { name: "Feature set: Saved addresses PRD" });
      const review = page.getByRole("region", { name: "Engineering review: Offline sync PRD" });
      const dates = page.getByRole("region", { name: "Engineering dates: Usage alerts PRD" });
      await expect(feature).toContainText("A run waits on you to go on. Waiting since Sat, Oct 17");
      await expect(review).toContainText("Waiting since Sat, Oct 17");
      await expect(dates).toContainText("Waiting since Thu, Oct 22");
      await expect(feature.getByRole("link")).toHaveText("Check the feature set");
      await expect(review.getByRole("link")).toHaveText("Check the engineering review");
      await expect(dates.getByRole("link")).toHaveText("Review the dates");
      // The greeting names the runs, and the walk is offered.
      await expect(page.getByTestId("home-sentence")).toContainText("runs wait on you.");
      await expect(page.getByTestId("home-sentence")).not.toContainText("Nothing waits on you");
      await expect(page.getByRole("button", { name: "Walk me through it" })).toBeVisible();
      // The cards sit under the summary and above the decisions.
      const summaryBottom = (await page.getByTestId("home-summary").boundingBox())!;
      const firstTop = (await stops(page).first().boundingBox())!;
      expect(firstTop.y).toBeGreaterThan(summaryBottom.y + summaryBottom.height - 1);
      if (phone) {
        // Phone: the button runs the card's full width, under its words.
        const card = (await review.boundingBox())!;
        const btn = (await review.getByRole("link").boundingBox())!;
        expect(btn.width).toBeGreaterThan(card.width - 60);
      }
      await review.getByRole("link", { name: "Check the engineering review" }).click();
      await expect(page).toHaveURL(/\/runs\/[^/?]+/);
      await expect(page.getByText("Engineering review").first()).toBeVisible();
    });

    test(`one stop: one card, the greeting says a run waits (${where})`, async ({ page }) => {
      await signIn(page, ADMIN.email, "feature-set");
      await expect(stops(page)).toHaveCount(1);
      await expect(stops(page).getByRole("link")).toHaveText("Check the feature set");
      await expect(page.getByTestId("home-sentence")).toContainText("a run wait");
    });

    test(`no card for a stop I may not decide (${where})`, async ({ page }) => {
      await signIn(page, "viewer@example.com", "simple-waits");
      await expect(page.getByTestId("home-greeting")).toBeVisible();
      await expect(page.getByRole("heading", { name: /Goals|Plan/ }).first()).toBeVisible();
      await expect(stops(page)).toHaveCount(0);
    });
  });
}
