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

async function signIn(page: Page, email: string, scenario?: string) {
  if (scenario) await page.context().addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, scenario] as const);
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
        const words = (await review.getByText("A run waits on you to go on.").boundingBox())!;
        const btn = (await review.getByRole("link").boundingBox())!;
        expect(btn.width).toBeGreaterThan(card.width - 60);
        expect(btn.y).toBeGreaterThanOrEqual(words.y + words.height);
      }
      await review.getByRole("link", { name: "Check the engineering review" }).click();
      await expect(page).toHaveURL(/\/runs\/[^/?]+/);
      await expect(page.getByText("Engineering review").first()).toBeVisible();
    });

    test(`one stop: one card, the greeting says a run waits (${where})`, async ({ page }) => {
      // The default company: one run waits on the owner to confirm its baseline.
      await signIn(page, ADMIN.email);
      await expect(stops(page)).toHaveCount(1);
      await expect(page.getByRole("region", { name: "Confirm the baseline: Team onboarding PRD" }).getByRole("link")).toHaveText("Confirm the baseline");
      await expect(page.getByTestId("home-sentence")).toContainText("a run wait on you.");
      // Its button opens the run at that stop; once confirmed there, Home has no card and no run in the greeting.
      await stops(page).getByRole("link", { name: "Confirm the baseline" }).click();
      await expect(page).toHaveURL(/\/runs\/[^/?]+/);
      await page.getByRole("button", { name: "Approve and continue" }).first().click();
      await expect(page.getByRole("button", { name: "Approve and continue" })).toHaveCount(0);
      // Back, in the app: the card has gone at once, never shown again while Home reads the Inbox.
      await page.evaluate(() => {
        const w = window as unknown as { shownStops: number };
        w.shownStops = 0;
        const look = () => {
          const shown = [...document.querySelectorAll<HTMLElement>('[data-testid="home-run-stop"]')].filter((el) => el.checkVisibility());
          w.shownStops = Math.max(w.shownStops, shown.length);
          requestAnimationFrame(look);
        };
        requestAnimationFrame(look);
      });
      await page.goBack();
      await expect(page).toHaveURL(/\/simple$/);
      await expect(page.getByTestId("home-sentence")).toBeVisible();
      await page.waitForLoadState("networkidle");
      await expect(stops(page)).toHaveCount(0);
      expect(await page.evaluate(() => (window as unknown as { shownStops: number }).shownStops)).toBe(0);
      await expect(page.getByTestId("home-sentence")).not.toContainText("run");
      await page.goto("/simple");
      await expect(page.getByTestId("home-sentence")).toBeVisible();
      await expect(page.getByTestId("home-sentence")).not.toContainText("run");
      await expect(stops(page)).toHaveCount(0);
    });

    // vqa-simple-runs: Back to Home shows the page as it was left (cacheComponents keeps it).
    // The mock answers on a timer: with the page clock paused nothing is read again, so a card
    // drawn now is the stale one of the stop just confirmed.
    test(`back to Home after confirming: the confirmed stop's card is not drawn from before (${where})`, async ({ page }) => {
      await signIn(page, ADMIN.email);
      await expect(stops(page)).toHaveCount(1);
      await stops(page).getByRole("link", { name: "Confirm the baseline" }).click();
      await expect(page).toHaveURL(/\/runs\/[^/?]+/);
      await page.getByRole("button", { name: "Approve and continue" }).first().click();
      await expect(page.getByRole("button", { name: "Approve and continue" })).toHaveCount(0);
      await page.waitForLoadState("networkidle");
      const now = await page.evaluate(() => Date.now());
      await page.clock.pauseAt(now + 2000);
      await page.goBack();
      await expect(page).toHaveURL(/\/simple$/);
      await expect(page.getByTestId("home-sentence")).toBeVisible();
      await expect(stops(page)).toHaveCount(0);
      await page.clock.resume();
      await page.waitForLoadState("networkidle");
      await expect(page.getByTestId("home-sentence")).not.toContainText("run");
      await expect(stops(page)).toHaveCount(0);
    });

    test(`no card for a stop I may not decide (${where})`, async ({ page }) => {
      await signIn(page, "viewer@example.com", "simple-waits");
      await expect(page.getByTestId("home-greeting")).toBeVisible();
      await expect(page.getByTestId("home-sentence")).toHaveText("Here is where the plan stands.");
      await page.waitForLoadState("networkidle");
      await expect(stops(page)).toHaveCount(0);
    });
  });
}
