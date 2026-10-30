import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA plan findings on Launches and Changelog (qa-plan-17/18, 51, 52, 53), on the mock API.
 * The default company has a track (Usage alerts PRD) whose roadmap is in review, no launches
 * and no changelog entries; the "launches" scenario approves usage-alerts-roadmap v1 and seeds
 * launches and entries; "roadmap-diff" has v1 approved and v2, a later draft.
 */

async function start(page: Page, opts: { scenario?: string; role?: "viewer" | "approver" } = {}) {
  if (opts.scenario) await page.addInitScript((s) => localStorage.setItem("po-mock-scenario", s), opts.scenario);
  if (opts.role) await page.addInitScript((r) => localStorage.setItem("po-mock-role", r), opts.role);
  await login(page);
}

test("qa-plan-18: New launch names the track and points to approving its roadmap, with no dead Create", async ({ page }) => {
  // fix4 qa-plan-13: with no approved roadmap, New launch is disabled and the page says why.
  await start(page);
  await page.goto("/roadmap/launches");
  await expect(page.getByTestId("launches-empty-new")).toBeDisabled();
  const blocked = page.getByTestId("launches-empty").getByTestId("new-launch-blocked");
  await expect(blocked).toContainText("Usage alerts PRD has no approved roadmap yet");
  await expect(blocked).not.toContainText("This track");
  const link = blocked.getByRole("link", { name: "Usage alerts roadmap" });
  await expect(link).toHaveAttribute("href", "/documents/usage-alerts-roadmap");
  await expect(page.getByTestId("new-launch-dialog")).toHaveCount(0);
});

test("qa-plan-17: an approved version 1 with a later draft still offers its items, named in words", async ({ page }) => {
  // As the API: the track's roadmap is its latest approved version with items, even while a later one is open.
  await start(page, { scenario: "roadmap-diff" });
  await page.goto("/roadmap/launches");
  // No launch yet: the empty state's New launch (fix4 qa-plan-15).
  await page.getByTestId("launches-empty-new").click();
  const dialog = page.getByTestId("new-launch-dialog");
  await expect(dialog.getByTestId("new-launch-blocked")).toHaveCount(0);
  await expect(dialog.locator("legend")).toHaveText("Items · Usage alerts roadmap, version 1");
  await expect(dialog.getByTestId("launch-item-option").first()).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Create launch" })).toBeDisabled();
});

test("qa-plan-51: empty Launches and Changelog say so in a sentence and suggest the action the role has", async ({ page }) => {
  await start(page);
  await page.goto("/roadmap/launches");
  // qa-plan-48: with no launch at all, the empty state stands alone (no table).
  await expect(page.getByTestId("launches-empty")).toContainText("No launches yet");
  // fix4 qa-plan-13: no roadmap is approved yet, so New launch is not suggested; the reason is.
  await expect(page.getByTestId("launches-empty-text")).toHaveText("They are planned when a roadmap is approved.");
  await expect(page.getByTestId("launches-empty").getByTestId("new-launch-blocked")).toBeVisible();
  await page.goto("/roadmap/changelog");
  await expect(page.getByTestId("changelog-empty-text")).toHaveText(
    "No entries yet. Add the first; Oracle adds one when it drafts a launch's kit.",
  );
  // fix4 qa-plan-58: the empty card holds New entry.
  await expect(page.getByTestId("changelog-empty").getByRole("button", { name: "New entry" })).toBeVisible();
  await expect(page.getByText("No changelog entries yet")).toHaveCount(0);
});

test("qa-plan-51: a viewer's empty states do not suggest New launch or New entry", async ({ page }) => {
  await start(page, { role: "viewer" });
  await page.goto("/roadmap/launches");
  await expect(page.getByTestId("launches-empty")).toContainText("No launches yet");
  await expect(page.getByTestId("launches-empty-text")).toHaveText("They are planned when a roadmap is approved.");
  await expect(page.getByTestId("launches-empty-new")).toHaveCount(0);
  await page.goto("/roadmap/changelog");
  await expect(page.getByTestId("changelog-empty")).toHaveText(
    "No entries yet. Oracle adds one when it drafts a launch's kit, and approvers add their own.",
  );
  await expect(page.getByTestId("changelog-empty")).not.toContainText("New entry");
});

test("qa-plan-52: with nothing published the exports are disabled with a visible reason", async ({ page }) => {
  await start(page);
  await page.goto("/roadmap/changelog");
  await expect(page.getByTestId("changelog-empty")).toBeVisible();
  await expect(page.getByTestId("export-md")).toBeDisabled();
  await expect(page.getByTestId("export-html")).toBeDisabled();
  await expect(page.getByTestId("export-why")).toContainText("Nothing to export yet: export gives the published public entries.");
});

test("qa-plan-52: an export says what it downloaded", async ({ page }) => {
  await start(page, { scenario: "launches" });
  await page.goto("/roadmap/changelog");
  await expect(page.getByTestId("changelog-entry").first()).toBeVisible();
  await expect(page.getByTestId("export-why")).toHaveCount(0);
  const download = page.waitForEvent("download");
  await page.getByTestId("export-md").click();
  expect((await download).suggestedFilename()).toBe("changelog.md");
  await expect(page.getByRole("status").filter({ hasText: "Downloaded changelog.md with 2 published public entries." })).toBeVisible();
  // Days read as dates, not ISO strings.
  await expect(page.getByTestId("changelog-day").first().locator("time")).toHaveText("Oct 20, 2026");
});

test("qa-plan-53: Launches and Changelog link to each other with the same button style", async ({ page }) => {
  await start(page, { scenario: "launches" });
  await page.goto("/roadmap/changelog");
  const toLaunches = page.getByTestId("launches-link");
  await expect(toLaunches.locator("svg")).toHaveCount(1);
  const variantA = await toLaunches.getAttribute("data-variant");
  const classA = await toLaunches.getAttribute("class");
  await toLaunches.click();
  await expect(page).toHaveURL(/\/roadmap\/launches$/);
  const toChangelog = page.getByTestId("changelog-link");
  await expect(toChangelog.locator("svg")).toHaveCount(1);
  expect(await toChangelog.getAttribute("data-variant")).toBe(variantA);
  expect(await toChangelog.getAttribute("class")).toBe(classA);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("qa-plan-52/18: at 390 px the export reason and the New launch pointer fit with no sideways scroll", async ({ page }) => {
    await start(page);
    await page.goto("/roadmap/changelog");
    await expect(page.getByTestId("export-why")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.goto("/roadmap/launches");
    const blocked = page.getByTestId("new-launch-blocked");
    await expect(blocked).toBeVisible();
    const box = await blocked.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  });
});
