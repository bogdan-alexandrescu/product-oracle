import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login, openRoadmapItem, signOut } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * estimated-effort-mock-order (drafts.who): the owners of a roadmap's tracks read its working
 * draft, and a track belongs to the roadmap its track row names (ProductTrack.roadmap_document_id),
 * not to whichever roadmap an item was moved from onto it. In the "simple-deciders" scenario
 * (invented data) Cory Hale (cory.hale@example.com, a commenter) owns the onboarding track
 * ("Guided setup track") on the Onboarding roadmap and nothing on the Alerts roadmap.
 * protects = after the owner moves Alert rules engine a step in the Alerts working draft and puts
 * it on Cory's track there, Cory's Gantt shows its published dates, the Alerts draft hidden;
 * fails_when = the mock reads track ownership from the draft's items (Cory reads the moved dates);
 * no_claim = the API's rule (api/tests for drafts.who).
 */

const bar = (page: Page, key: string): Locator => page.locator(`g[data-testid="bar"][data-item="${key}"]`);
const panel = (page: Page) => page.getByTestId("floating-card");

async function gantt(page: Page) {
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.getByTestId("format-gantt").click();
  const b = bar(page, "alert-rules");
  await b.scrollIntoViewIfNeeded();
  await expect(b).toBeVisible();
  return b;
}

test.use({ viewport: { width: 1440, height: 900 } });

test("an item moved onto a track in a draft does not show that draft to the track's owner", async ({ page }) => {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "simple-deciders"] as const);
  await login(page, ADMIN.email);
  const b = await gantt(page);
  const start = (await b.getAttribute("data-start"))!;
  const end = (await b.getAttribute("data-end"))!;
  await b.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByText(/^Moved 'Alert rules engine' to /)).toBeVisible();
  await expect(b).not.toHaveAttribute("data-start", start);

  await page.getByTestId("format-timeline").click();
  await openRoadmapItem(page, "alert-rules");
  await expect(panel(page)).toBeVisible();
  await panel(page).getByRole("button", { name: "Change the track" }).click();
  await panel(page).getByTestId("card-track-edit").getByLabel("Track").selectOption({ label: "Guided setup track" });
  await panel(page).getByTestId("card-track-edit").getByRole("button", { name: "Save" }).click();
  await expect(panel(page).getByTestId("card-track")).toHaveText("Guided setup track");

  await signOut(page);
  await login(page, "cory.hale@example.com");
  const seen = await gantt(page);
  await expect(seen).toHaveAttribute("data-start", start);
  await expect(seen).toHaveAttribute("data-end", end);
});
