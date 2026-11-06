import { expect, test, type Page } from "./test";

import { GROUND_TRUTH_FLAGS_SCENARIO } from "../lib/api/mock/ground-truth";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, openRoadmapItem, signOut } from "./helpers";

/**
 * The Ground Truth check on Detailed's Ground Truth page (docs/ground-truth.md; the owner,
 * Nov 5: allowed but flagged). The "ground-truth-flags" scenario: Export to sheets (a roadmap
 * item on no feature), Weekly digest (on a feature a run only proposed), F-09a Guest invites (an
 * item of the PRD's F-09, over two milestones), the slices F-15a Usage report and F-15b Usage
 * chart, the PRD's F-09 Guest seats, Smart search (no code), F-02 Audit log (no goal) and F-03
 * Night alerts (runs today, still on the roadmap). Export to sheets is published: Add and Link set
 * its feature through the roadmap's working draft (a change, so its link rides the next version)
 * and its panel on the Roadmap shows the feature. Each fix is made as a person makes it; a fix sent
 * for approval leaves its row waiting, with no second button, after a reload too. A PRD's feature
 * Add to Ground Truth makes serves the PRD's goal; any other serves none yet, so it is flagged for one.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function open(page: Page, email?: string) {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, GROUND_TRUTH_FLAGS_SCENARIO] as const);
  await login(page, email);
  await page.goto("/baseline");
  await expect(page.getByTestId("gt-band")).toBeVisible();
  return Number(await total(page).textContent());
}

const count = (page: Page, kind: string) => page.getByTestId(`gt-count-${kind}`);
const total = (page: Page) => page.getByTestId("gt-total");
const list = (page: Page, kind: string) => page.getByTestId(`gt-list-${kind}`);

async function openKind(page: Page, kind: string) {
  await count(page, kind).click();
  await expect(list(page, kind)).toBeVisible();
}

const row = (page: Page, name: string) => page.getByTestId("gt-row").filter({ hasText: name });

/** The item's panel on the Simple Roadmap: its name, after the code of the feature it is. */
async function roadmapPanelName(page: Page, key: string) {
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await openRoadmapItem(page, key);
  return page.getByTestId("floating-card").getByTestId("card-name");
}

/** The item's panel from the Roadmap's Gantt: its bar, opened from the keyboard. */
async function ganttPanelName(page: Page, key: string) {
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.getByTestId("format-gantt").click();
  const bar = page.locator(`g[data-testid="bar"][data-item="${key}"]`).first();
  await bar.scrollIntoViewIfNeeded();
  await bar.focus();
  await page.keyboard.press("Enter");
  return page.getByTestId("floating-card").getByTestId("card-name");
}

/** The feature's panel from Priorities: its name, clicked where it is listed. */
async function prioritiesPanelName(page: Page, name: string) {
  await page.goto("/simple/priorities");
  const button = page.getByRole("button", { name, exact: true }).first();
  await button.scrollIntoViewIfNeeded();
  await button.click();
  return page.getByTestId("item-panel").getByTestId("floating-card").getByTestId("card-name");
}

for (const viewport of [DESKTOP, PHONE])
  for (const colorScheme of ["light", "dark"] as const)
    test(`the flags band counts each kind and opens its items (${viewport.width}, ${colorScheme})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme });
      await open(page);
      await expect(total(page)).toHaveText("9");
      await expect(count(page, "unlinked_item")).toContainText("Not in the Ground Truth");
      await expect(count(page, "unlinked_item")).toContainText("3");
      await expect(count(page, "slice_parent_missing")).toContainText("2");
      for (const kind of ["prd_feature_missing", "no_code", "no_goal", "runs_today_on_roadmap"]) await expect(count(page, kind)).toContainText("1");
      await openKind(page, "unlinked_item");
      // One short line shows; the flag's sentence is behind the (i).
      const sheets = row(page, "Export to sheets");
      await expect(sheets).toContainText("Alerts roadmap");
      await expect(sheets.getByRole("tooltip")).toBeHidden();
      await sheets.getByRole("button", { name: "About Export to sheets" }).click();
      await expect(sheets.getByRole("tooltip")).toHaveText("This roadmap item is not a feature in the Ground Truth.");
      await expect(sheets.getByRole("button", { name: /Add to Ground Truth/ })).toBeVisible();
      // Linked to a feature a run only proposed: it says so, with Confirm it.
      const unconfirmed = row(page, "Weekly digest").getByTestId("gt-unconfirmed");
      await expect(unconfirmed).toContainText("Waiting to be confirmed");
      await expect(unconfirmed.getByTestId("code-chip")).toHaveAccessibleName("F-14 Weekly digest");
      await expect(row(page, "Weekly digest").getByRole("button", { name: /Confirm it/ })).toBeVisible();
      await expect(row(page, "Guest invites")).toContainText("F-09a");
      await openKind(page, "prd_feature_missing");
      await expect(row(page, "Guest seats")).toContainText("F-09");
      await expect(row(page, "Guest seats")).toContainText("PRD Scale");
      // Nothing runs past the screen's edge.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });

test.describe("as the owner", () => {
  test.use({ viewport: DESKTOP });

  test("Add to Ground Truth adds a published item's feature once, and its flag goes", async ({ page }) => {
    await open(page);
    await openKind(page, "unlinked_item");
    await row(page, "Export to sheets").getByRole("button", { name: /Add to Ground Truth/ }).click();
    await expect(page.getByTestId("gt-notice")).toContainText("Added “Export to sheets” to the Ground Truth.");
    await expect(row(page, "Export to sheets")).toHaveCount(0);
    await expect(count(page, "unlinked_item")).toContainText("2");
    // The new feature is one feature, named as the item; it had no code and serves no goal yet: it is flagged for both instead.
    await openKind(page, "no_code");
    await expect(list(page, "no_code").getByTestId("gt-row").filter({ hasText: "Export to sheets" })).toHaveCount(1);
    await expect(count(page, "no_code")).toContainText("2");
    await expect(count(page, "no_goal")).toContainText("2");
    await expect(total(page)).toHaveText("10");
  });

  test("Add to Ground Truth adds a PRD's feature with its code and goal, and one slice's feature for both slices", async ({ page }) => {
    await open(page);
    await openKind(page, "prd_feature_missing");
    await row(page, "Guest seats").getByRole("button", { name: /Add to Ground Truth/ }).click();
    await expect(page.getByTestId("gt-notice")).toContainText("Added “Guest seats” to the Ground Truth.");
    await expect(count(page, "prd_feature_missing")).toHaveCount(0);
    // It is F-09 and serves the PRD's goal: no Give it a code nor Pick a goal, and its roadmap item F-09a is in the Ground Truth by that code.
    await expect(count(page, "no_code")).toContainText("1");
    await expect(count(page, "no_goal")).toContainText("1");
    await expect(count(page, "unlinked_item")).toContainText("2");
    await expect(total(page)).toHaveText("7");
    // One add on the slice F-15a adds F-15: both its slices (F-15a, F-15b) go.
    await openKind(page, "slice_parent_missing");
    await expect(row(page, "Usage chart")).toContainText("F-15b");
    await row(page, "Usage report").getByRole("button", { name: /Add to Ground Truth/ }).click();
    await expect(page.getByTestId("gt-notice")).toContainText("Added “Usage report” to the Ground Truth.");
    await expect(count(page, "slice_parent_missing")).toHaveCount(0);
    await expect(count(page, "no_code")).toContainText("1");
    // F-15 is a feature with its code, which serves no goal yet; F-09 serves the PRD's.
    await openKind(page, "no_goal");
    await expect(page.getByRole("button", { name: "Pick a goal: F-15 Usage report" })).toBeVisible();
    await expect(row(page, "Guest seats")).toHaveCount(0);
    await expect(count(page, "no_goal")).toContainText("2");
    await expect(total(page)).toHaveText("6");
  });

  test("Link to a feature links a published item to a Ground Truth feature by code and name", async ({ page }) => {
    await open(page);
    await openKind(page, "unlinked_item");
    await row(page, "Export to sheets").getByRole("button", { name: /Link to a feature/ }).click();
    const picker = page.getByTestId("gt-picker");
    await picker.getByLabel("Find a feature").fill("F-11");
    await picker.getByRole("button", { name: "F-11 Sheets export" }).click();
    await expect(picker).toHaveCount(0);
    await expect(page.getByTestId("gt-notice")).toContainText("Linked “Export to sheets” to “Sheets export”.");
    await expect(row(page, "Export to sheets")).toHaveCount(0);
    await expect(total(page)).toHaveText("8");
    // The published item is linked through the roadmap's draft: its panel shows the feature.
    await expect(await roadmapPanelName(page, "gt-export-to-sheets")).toHaveText(/^F-11\s*Export to sheets/);
    // The one feature panel shows it too, from the Gantt and from Priorities.
    await expect(await ganttPanelName(page, "gt-export-to-sheets")).toHaveText(/^F-11\s*Export to sheets/);
    await expect(await prioritiesPanelName(page, "Export to sheets")).toHaveText(/^F-11\s*Export to sheets/);
  });

  test("Link to a feature links a slice: its flag goes, its other slice stays", async ({ page }) => {
    await open(page);
    await openKind(page, "slice_parent_missing");
    await row(page, "Usage report").getByRole("button", { name: /Link to a feature/ }).click();
    const picker = page.getByTestId("gt-picker");
    await picker.getByLabel("Find a feature").fill("Sheets");
    await picker.getByRole("button", { name: "F-11 Sheets export" }).click();
    await expect(picker).toHaveCount(0);
    await expect(page.getByTestId("gt-notice")).toContainText("Linked “Usage report” to “Sheets export”.");
    await expect(row(page, "Usage report")).toHaveCount(0);
    await expect(count(page, "slice_parent_missing")).toContainText("1");
    await expect(row(page, "Usage chart")).toContainText("F-15b");
    await expect(total(page)).toHaveText("8");
    // After a reload too: the link is the item's own, in its roadmap's draft.
    await page.reload();
    await expect(count(page, "slice_parent_missing")).toContainText("1");
    await expect(await roadmapPanelName(page, "gt-usage-report")).toHaveText(/^F-11\s*Usage report/);
  });

  test("Confirm it confirms the feature a run proposed", async ({ page }) => {
    await open(page);
    await openKind(page, "unlinked_item");
    await row(page, "Weekly digest").getByRole("button", { name: /Confirm it/ }).click();
    await expect(page.getByTestId("gt-notice")).toContainText("Confirmed “Weekly digest”.");
    await expect(row(page, "Weekly digest")).toHaveCount(0);
    await expect(count(page, "unlinked_item")).toContainText("2");
    await expect(total(page)).toHaveText("8");
  });

  test("Pick a goal links the feature to a goal", async ({ page }) => {
    await open(page);
    await openKind(page, "no_goal");
    await row(page, "Audit log").getByRole("button", { name: /Pick a goal/ }).click();
    const picker = page.getByTestId("gt-picker");
    await picker.getByRole("button").filter({ hasText: "Raise activation" }).click();
    await expect(page.getByTestId("gt-notice")).toContainText("“Audit log” now serves “Raise activation”.");
    await expect(count(page, "no_goal")).toHaveCount(0);
    await expect(total(page)).toHaveText("8");
  });
});

for (const colorScheme of ["light", "dark"] as const)
  test(`Take it off the roadmap, then Undo (390, ${colorScheme})`, async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.emulateMedia({ colorScheme });
    await open(page);
    await openKind(page, "runs_today_on_roadmap");
    await row(page, "Night alerts").getByRole("button", { name: /Take it off the roadmap/ }).click();
    await expect(page.getByTestId("gt-notice")).toContainText("Took “Night alerts” off the roadmap.");
    await expect(count(page, "runs_today_on_roadmap")).toHaveCount(0);
    await expect(total(page)).toHaveText("8");
    await page.getByTestId("gt-notice").getByRole("button", { name: "Undo" }).click();
    await expect(count(page, "runs_today_on_roadmap")).toContainText("1");
    await expect(total(page)).toHaveText("9");
  });

for (const viewport of [DESKTOP, PHONE])
  test.describe(`as an approver who does not edit the roadmap (${viewport.width})`, () => {
    test.use({ viewport });

    test("Confirm it, Pick a goal and Add go at once; the item's link waits for its decider", async ({ page }) => {
      await page.emulateMedia({ colorScheme: "dark" });
      const start = await open(page, "approver@example.com");
      await openKind(page, "unlinked_item");
      await row(page, "Weekly digest").getByRole("button", { name: /Confirm it/ }).click();
      await expect(row(page, "Weekly digest")).toHaveCount(0);
      await row(page, "Export to sheets").getByRole("button", { name: /Add to Ground Truth/ }).click();
      await expect(page.getByTestId("gt-notice")).toContainText("Added “Export to sheets” to the Ground Truth.");
      // The feature is added at once; the item's link is a roadmap change its decider approves.
      await expect(row(page, "Export to sheets").getByTestId("gt-pending")).toHaveText("Waiting for an approver");
      await expect(row(page, "Export to sheets").getByRole("button", { name: /Add to Ground Truth|Link to a feature/ })).toHaveCount(0);
      await openKind(page, "no_goal");
      await row(page, "Audit log").getByRole("button", { name: /Pick a goal/ }).click();
      await page.getByTestId("gt-picker").getByRole("button").filter({ hasText: "Raise activation" }).click();
      await expect(row(page, "Audit log")).toHaveCount(0);
      // Two flags went; the new feature brings its own no-code and no-goal flags.
      await expect(total(page)).toHaveText(String(start));
    });

    test("Take it off the roadmap is sent for approval: the row waits, with no second button", async ({ page }) => {
      const start = await open(page, "approver@example.com");
      await openKind(page, "runs_today_on_roadmap");
      await row(page, "Night alerts").getByRole("button", { name: /Take it off the roadmap/ }).click();
      await expect(page.getByTestId("gt-notice")).toContainText("Sent “Night alerts” off the roadmap for approval.");
      await expect(row(page, "Night alerts").getByTestId("gt-pending")).toHaveText("Waiting for an approver");
      await expect(row(page, "Night alerts").getByRole("button", { name: /Take it off the roadmap/ })).toHaveCount(0);
      await expect(total(page)).toHaveText(String(start));
    });
  });

for (const viewport of [DESKTOP, PHONE])
  test(`a commenter's Add is sent for approval, with the item's link; the row waits, after a reload too (${viewport.width})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const start = await open(page, "commenter@example.com");
    await openKind(page, "unlinked_item");
    await expect(row(page, "Export to sheets").getByRole("button", { name: /Link to a feature/ })).toHaveCount(0);
    await row(page, "Export to sheets").getByRole("button", { name: /Add to Ground Truth/ }).click();
    await expect(page.getByTestId("gt-notice")).toContainText("Sent “Export to sheets” for approval.");
    await expect(row(page, "Export to sheets").getByTestId("gt-pending")).toHaveText("Waiting for an approver");
    await expect(row(page, "Export to sheets").getByRole("button")).toHaveCount(1); // its (i) only
    await expect(total(page)).toHaveText(String(start));
    // After a reload the row still waits: the open proposal is read back, never made twice.
    await page.reload();
    await openKind(page, "unlinked_item");
    await expect(row(page, "Export to sheets").getByTestId("gt-pending")).toHaveText("Waiting for an approver");
    await expect(row(page, "Export to sheets").getByRole("button", { name: /Add to Ground Truth/ })).toHaveCount(0);
  });

test("a commenter's Add of a PRD's feature, once approved, serves its goal and its flag clears", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  const start = await open(page, "commenter@example.com");
  await openKind(page, "prd_feature_missing");
  await row(page, "Guest seats").getByRole("button", { name: /Add to Ground Truth/ }).click();
  await expect(row(page, "Guest seats").getByTestId("gt-pending")).toHaveText("Waiting for an approver");
  // The owner approves it on the Proposals tab.
  await signOut(page);
  await login(page);
  await page.goto("/baseline?tab=proposals");
  await page.getByTestId("proposal").filter({ hasText: "Guest seats" }).getByRole("button", { name: "Accept" }).click();
  await expect(page.getByTestId("proposal").filter({ hasText: "Guest seats" })).toHaveCount(0);
  await page.goto("/baseline");
  await expect(page.getByTestId("gt-band")).toBeVisible();
  await expect(count(page, "prd_feature_missing")).toHaveCount(0);
  // F-09 kept its code and serves the PRD's goal: no flag of its own.
  await expect(total(page)).toHaveText(String(start - 2));
  await openKind(page, "no_goal");
  await expect(row(page, "Guest seats")).toHaveCount(0);
});

for (const viewport of [DESKTOP, PHONE])
  test(`a viewer reads the flags with no fixes (${viewport.width})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await open(page, "viewer@example.com");
    await expect(total(page)).toHaveText("9");
    for (const kind of ["unlinked_item", "prd_feature_missing", "no_goal", "runs_today_on_roadmap"]) {
      await openKind(page, kind);
      await expect(list(page, kind).getByTestId("gt-row").first()).toBeVisible();
      await expect(list(page, kind).getByRole("button", { name: /Add to Ground Truth|Link to a feature|Confirm it|Pick a goal|Take it off the roadmap/ })).toHaveCount(0);
    }
  });
