import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * RP2 'Meeting step as draft' (build-runplan): a review meeting's Roadmap step shows the run's
 * draft roadmap of a not-yet-approved PRD, its dated items hatched and marked Draft, with Change
 * dates, Leave out and Approve these N dates, which puts the items on the roadmap.
 *
 * Test cards (protects / fails_when / no_claim):
 * - "the draft shows hatched; a change of dates and approving put the items on the roadmap":
 *   protects=the picked frames rp2-c-rest, rp2-c-mid, rp2-c-open and rp2-c-done at 1440;
 *   fails_when=the step says "No roadmap items for this PRD yet", a row lacks Draft, its dates
 *   or its buttons, the moved line is not said, the ask is missing, or the approval is not in
 *   All decisions with the items solid, or its PRD link in Company > Decisions does not open the
 *   PRD; no_claim=the real API (api/tests/test_simple_meetings_draft_dates.py).
 * - "Leave out drops an item from the draft": protects=the item never goes on the roadmap and
 *   the button counts one fewer; fails_when=it stays or the count does not change.
 * - phone (390): protects=frame rp2-c-rest-390; fails_when=a row or the button is missing or
 *   the page scrolls sideways.
 */

const ITEMS = ["Save a cart for later", "Carts kept across devices", "Price-drop note on saved carts", "Shared carts for teams", "Saved-cart reminder emails", "Turn a cart into a quote"];

async function openRoadmapStep(page: Page) {
  await page.addInitScript((key) => localStorage.setItem(key, "meeting-draft-dates"), MOCK_SCENARIO_KEY);
  await login(page);
  await page.goto("/simple/meetings");
  await expect(page.getByRole("region", { name: "Upcoming" })).toBeVisible();
  await page.getByRole("button", { name: "Start review" }).first().click();
  const sheet = page.getByRole("dialog", { name: "Start a review" });
  await sheet.getByLabel("PRD").selectOption({ label: "Saved carts" });
  await sheet.getByRole("checkbox", { name: "Priya Raman" }).check();
  await sheet.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review: Saved carts" })).toBeVisible();
  await page.getByRole("navigation", { name: "Steps" }).getByRole("button", { name: "2 Roadmap" }).click();
  const slice = page.getByRole("region", { name: "Roadmap slice" });
  await expect(slice.getByRole("heading", { name: "Saved carts on the roadmap" })).toBeVisible();
  return slice;
}

const row = (slice: ReturnType<Page["getByRole"]>, title: string) => slice.locator("li").filter({ hasText: title });

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the draft shows hatched; a change of dates and approving put the items on the roadmap", async ({ page }) => {
    const slice = await openRoadmapStep(page);
    // rp2-c-rest: the run's draft, hatched, each row marked Draft with its dates.
    await expect(slice).toContainText("Draft from the run: not approved");
    await expect(slice).not.toContainText("No roadmap items for this PRD yet.");
    await expect(slice.getByRole("img", { name: "Draft roadmap" })).toBeVisible();
    await expect(slice.locator("[data-bar]")).toHaveCount(6);
    await expect(slice.locator("li")).toHaveCount(6);
    for (const t of ITEMS) {
      await expect(row(slice, t)).toContainText("Draft");
      await expect(row(slice, t).getByRole("button", { name: `Change dates for ${t}` })).toBeVisible();
      await expect(row(slice, t).getByRole("button", { name: `Leave out ${t}` })).toBeVisible();
    }
    await expect(row(slice, "Save a cart for later")).toHaveText(/Save a cart for later · Now · Nov 9 – Dec 18 · Draft/);
    await expect(row(slice, "Turn a cart into a quote")).toHaveText(/Turn a cart into a quote · Later · Apr 5 – May 28 · Draft/);

    // rp2-c-mid: Change dates moves an item 4 weeks later; it stays draft.
    await row(slice, "Turn a cart into a quote").getByRole("button", { name: "Change dates for Turn a cart into a quote" }).click();
    const form = slice.getByRole("form", { name: "Change dates for Turn a cart into a quote" });
    await form.getByLabel("Start").fill("2027-05-03");
    await form.getByLabel("End").fill("2027-06-25");
    await form.getByRole("button", { name: "Save dates" }).click();
    await expect(slice.getByTestId("draft-said")).toHaveText("Moved Turn a cart into a quote 4 weeks later (draft)");
    await expect(row(slice, "Turn a cart into a quote")).toHaveText(/Later · May 3 – Jun 25 · Draft/);
    await expect(slice.getByRole("img", { name: "Draft roadmap" })).toContainText("Jun");

    // rp2-c-open: Approve these 6 dates asks first.
    await slice.getByRole("button", { name: "Approve these 6 dates" }).click();
    const ask = slice.getByRole("dialog", { name: "Approve dates" });
    await expect(ask).toContainText("Put 6 items on the roadmap with these dates?");
    await expect(ask).toContainText("Everyone sees them on the roadmap at once. The PRD itself still needs its own approval.");
    await ask.getByRole("button", { name: "Cancel" }).click();
    await expect(ask).toHaveCount(0);
    await slice.getByRole("button", { name: "Approve these 6 dates" }).click();
    await slice.getByRole("dialog", { name: "Approve dates" }).getByRole("button", { name: "Approve dates" }).click();

    // rp2-c-done: the items are on the roadmap, solid; the approval is in All decisions.
    await expect(slice.getByRole("status")).toHaveText("Dates approved in this meeting: 6 items are on the roadmap.");
    await expect(slice.getByRole("img", { name: "Roadmap items" })).toBeVisible();
    await expect(slice.locator("[data-bar]")).toHaveCount(6);
    await expect(slice).not.toContainText("Draft from the run");
    await expect(page.getByText("Saved carts dates approved: 6 items on the roadmap").first()).toBeVisible();

    // After a reload the Roadmap step still says the dates were approved here, solid.
    await page.reload();
    await page.getByRole("navigation", { name: "Steps" }).getByRole("button", { name: "2 Roadmap" }).click();
    await expect(slice.getByRole("status")).toHaveText("Dates approved in this meeting: 6 items are on the roadmap.");
    await expect(slice.locator("[data-bar]")).toHaveCount(6);
    await expect(slice).not.toContainText("Draft from the run");

    // The items are on the Simple roadmap now.
    await page.goto("/simple/roadmap?prd=saved-carts");
    // vqa-simple-runs: the Timeline's bars move by drag and arrow keys since train AH (the owner's answer), and say so in their name.
    await expect(page.getByRole("button", { name: /^Turn a cart into a quote, May 3 – Jun 25, 2027\. Arrows move it/ })).toBeVisible();

    // runplan-r2: the decision is in Company > Decisions and its PRD link opens the PRD.
    await page.goto("/company/decisions?state=all");
    await page.getByTestId("decision-row").filter({ hasText: "Saved carts dates approved: 6 items on the roadmap" }).click();
    const inspector = page.getByTestId("decision-inspector").filter({ visible: true });
    await expect(inspector).toContainText("Saved carts dates approved: 6 items on the roadmap");
    await inspector.getByRole("link", { name: "Saved carts PRD" }).click();
    await expect(page).toHaveURL(/\/documents\/saved-carts$/);
    await expect(page.getByRole("heading", { name: "Saved carts", level: 1 })).toBeVisible();
    await expect(page.getByText("Not found")).toHaveCount(0);
  });

  test("Leave out drops an item from the draft", async ({ page }) => {
    const slice = await openRoadmapStep(page);
    await row(slice, "Shared carts for teams").getByRole("button", { name: "Leave out Shared carts for teams" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Leave out", exact: true }).click();
    await expect(slice.getByTestId("draft-said")).toHaveText("Left out Shared carts for teams: it does not go on the roadmap.");
    await expect(row(slice, "Shared carts for teams")).toHaveCount(0);
    await expect(slice.locator("li")).toHaveCount(5);
    await expect(slice.getByRole("button", { name: "Approve these 5 dates" })).toBeVisible();
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("at 390 px every draft row and Approve these 6 dates show, nothing scrolls sideways", async ({ page }) => {
    const slice = await openRoadmapStep(page);
    await expect(slice).toContainText("Draft from the run: not approved");
    await expect(slice.locator("li")).toHaveCount(6);
    for (const t of ITEMS) await expect(row(slice, t)).toContainText("Draft");
    await expect(slice.getByRole("button", { name: "Approve these 6 dates" })).toBeVisible();
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(wide).toBeLessThanOrEqual(0);
  });
});
