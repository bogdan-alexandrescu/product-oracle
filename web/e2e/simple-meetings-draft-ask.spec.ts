import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * RP2 c (mk-runplan, the owner's pick re-confirmed Nov 4; ported from train AN's
 * fidelity-picks-nov4), on the mock's "meeting-draft-dates" scenario (invented data), at the
 * frame's viewport (1440 x 900): protects=Approve these 6 dates brings its ask into view; the
 * decision stamp keeps its zone ("Avery Stone · Wed Nov 4, 4:41 PM PST"); fails_when=the ask
 * opens out of view, or the stamp drops the zone.
 */

const DESKTOP = { width: 1440, height: 900 };

test.describe("RP2 c: the meeting's draft step", () => {
  test.use({ viewport: DESKTOP });

  async function openRoadmapStep(page: Page) {
    await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, "meeting-draft-dates"]);
    await login(page);
    await page.goto("/simple/meetings");
    await page.getByRole("button", { name: "Start review" }).first().click();
    const sheet = page.getByRole("dialog", { name: "Start a review" });
    await sheet.getByLabel("PRD").selectOption({ label: "Saved carts" });
    await sheet.getByRole("checkbox", { name: "Priya Raman" }).check();
    await sheet.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Review: Saved carts" })).toBeVisible();
    await page.getByRole("navigation", { name: "Steps" }).getByRole("button", { name: "2 Roadmap" }).click();
    return page.getByRole("region", { name: "Roadmap slice" });
  }

  test("Approve these 6 dates brings its ask into view; the decision stamp keeps the zone", async ({ page }) => {
    const slice = await openRoadmapStep(page);
    await slice.getByRole("button", { name: "Approve these 6 dates" }).click();
    const ask = slice.getByRole("dialog", { name: "Approve dates" });
    await expect(ask).toContainText("Put 6 items on the roadmap with these dates?");
    await expect(ask).toBeInViewport({ ratio: 1 });
    await ask.getByRole("button", { name: "Approve dates" }).click();
    await expect(slice.getByRole("status")).toHaveText("Dates approved in this meeting: 6 items are on the roadmap.");

    const stamp = page.getByRole("region", { name: "Decisions in this meeting" }).getByTestId("decision-stamp").first();
    await expect(stamp).toHaveText(/^Avery Stone · [A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M [A-Z]{2,4}$/);
  });
});
