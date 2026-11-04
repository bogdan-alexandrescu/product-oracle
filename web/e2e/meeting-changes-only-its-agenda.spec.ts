import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * meeting-changes-only-its-agenda: a meeting changes only what it reviews. In the mock's
 * "meeting-agenda" scenario the invented PRD Usage alerts has the Welcome video on the
 * onboarding roadmap; a review of Usage alerts reviews the alerts roadmap. Its cut of an
 * alerts item applies; its cut of the Welcome video applies nothing and says so ("Welcome
 * video is on another roadmap: sent to its owner to decide"), and the roadmap's owner sees it
 * in Needs a decision, naming the meeting, and accepts it there. Desktop and phone.
 */

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function startReview(page: Page) {
  await login(page);
  await page.goto("/simple/meetings");
  await tap(page.getByRole("button", { name: /^Start review/ }).first());
  const sheet = page.getByRole("dialog", { name: "Start a review" });
  await sheet.getByLabel("PRD").selectOption({ label: "Usage alerts" });
  await tap(sheet.getByRole("button", { name: "Start", exact: true }));
  await expect(page.getByRole("heading", { name: "Review: Usage alerts" })).toBeVisible();
  await tap(page.getByRole("navigation", { name: "Steps" }).getByRole("button", { name: "2 Roadmap" }));
  return page.getByRole("region", { name: "Roadmap slice" });
}

async function cut(page: Page, slice: Locator, title: string) {
  await tap(slice.getByRole("button", { name: `Cut ${title}` }));
  await page.getByRole("alertdialog").getByRole("button", { name: "Cut" }).click();
}

test.beforeEach(async ({ context }) => {
  await context.addInitScript((key) => localStorage.setItem(key, "meeting-agenda"), MOCK_SCENARIO_KEY);
});

for (const phone of [false, true]) {
  test.describe(phone ? "phone" : "desktop", () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 } });

    test("a cut on the meeting's roadmap applies; a cut elsewhere is a proposal for its owner", async ({ page }) => {
      const slice = await startReview(page);
      const said = slice.getByTestId("roadmap-said");

      await cut(page, slice, "Alert history export");
      await expect(said).toHaveText("Cut Alert history export.");
      await expect(slice.locator('[data-item="alert-export"]')).toContainText("Cut");

      await cut(page, slice, "Welcome video");
      await expect(said).toHaveText("Welcome video is on another roadmap: sent to its owner to decide.");
      await expect(slice.locator('[data-item="setup-video"]')).not.toContainText("· Cut ·");
      await expect(slice.getByRole("button", { name: "Cut Welcome video" })).toBeVisible();

      // The Decisions step lists it, with no Accept for the meeting.
      await tap(page.getByRole("navigation", { name: "Steps" }).getByRole("button", { name: "3 Decisions" }));
      const elsewhere = page.getByTestId("proposal-elsewhere");
      await expect(elsewhere).toHaveText("On another roadmap: sent to its owner to decide.");

      // The roadmap's owner decides it in Needs a decision, which names the meeting.
      await page.goto("/simple/roadmap");
      await expect(page.getByTestId("simple-roadmap")).toBeVisible();
      await page.getByTestId("needs-decision").click();
      const proposal = page.getByTestId("decision-tray").getByTestId("tray-proposal").filter({ hasText: "Welcome video" });
      await expect(proposal.getByTestId("proposal-from-meeting")).toHaveText("Asked for by the meeting Review: Usage alerts");
      await proposal.getByRole("button", { name: "Accept" }).click();
      await expect(page.getByTestId("decision-tray").getByTestId("tray-proposal").filter({ hasText: "Welcome video" })).toHaveCount(0);
    });
  });
}
