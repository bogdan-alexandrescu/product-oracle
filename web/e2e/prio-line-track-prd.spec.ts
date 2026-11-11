import { ADMIN, login, openRoadmapItem } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * tracks-goal (priorities.lines): a track milestone's line names the first of its track's PRDs on
 * the roadmap, whichever PRD the track's other features come from. On the mock's default company
 * (invented data) the Usage alerts track holds the Beta milestone; a Guided setup feature moved
 * onto that track keeps its own PRD, and Beta stays listed under Usage alerts.
 * protects = the Line picker groups a milestone under its track's first PRD;
 * fails_when = the mock takes the PRD of the track's last feature (Beta under Guided setup).
 */

const panel = (page: Page) => page.getByTestId("floating-card");

async function betaGroup(page: Page): Promise<string | null> {
  await page.goto("/simple/priorities");
  await expect(page.getByTestId("simple-priorities")).toBeVisible();
  const beta = page.locator("#prio-line option").filter({ hasText: /^Milestone: Beta · / });
  await expect(beta).toHaveCount(1);
  return beta.evaluate((o) => (o.parentElement instanceof HTMLOptGroupElement ? o.parentElement.label : null));
}

test.use({ viewport: { width: 1440, height: 900 } });

test("a milestone's line stays under its track's first PRD when a feature from another PRD joins the track", async ({ page }) => {
  await login(page, ADMIN.email);
  expect(await betaGroup(page)).toBe("Usage alerts");

  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await openRoadmapItem(page, "setup-import");
  await expect(panel(page)).toBeVisible();
  await panel(page).getByRole("button", { name: "Change the track" }).click();
  await panel(page).getByTestId("card-track-edit").getByLabel("Track").selectOption({ label: "Usage alerts track" });
  await panel(page).getByTestId("card-track-edit").getByRole("button", { name: "Save" }).click();
  await expect(panel(page).getByTestId("card-track")).toHaveText("Usage alerts track");

  expect(await betaGroup(page)).toBe("Usage alerts");
});
