import { expect, test, type Page } from "@playwright/test";

import { GROUND_TRUTH_FLAGS_SCENARIO } from "../lib/api/mock/ground-truth";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * The Ground Truth check on Detailed's Ground Truth page (docs/ground-truth.md; the owner,
 * Nov 5: allowed but flagged). The "ground-truth-flags" scenario: Export to sheets (a roadmap
 * item on no feature), Weekly digest (on a feature a run only proposed), the slice F-15a Usage
 * report, the PRD's F-09 Team invites, Smart search (no code), F-02 Audit log (no goal) and
 * F-03 Night alerts (runs today, still on the roadmap). Each fix is made as a person makes it.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function open(page: Page, email?: string) {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, GROUND_TRUTH_FLAGS_SCENARIO] as const);
  await login(page, email);
  await page.goto("/baseline");
  await expect(page.getByTestId("gt-band")).toBeVisible();
}

const count = (page: Page, kind: string) => page.getByTestId(`gt-count-${kind}`);
const total = (page: Page) => page.getByTestId("gt-total");

async function openKind(page: Page, kind: string) {
  await count(page, kind).click();
  await expect(page.getByTestId(`gt-list-${kind}`)).toBeVisible();
}

const row = (page: Page, name: string) => page.getByTestId("gt-row").filter({ hasText: name });

for (const viewport of [DESKTOP, PHONE])
  for (const colorScheme of ["light", "dark"] as const)
    test(`the flags band counts each kind and opens its items (${viewport.width}, ${colorScheme})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme });
      await open(page);
      await expect(total(page)).toHaveText("7");
      await expect(count(page, "unlinked_item")).toContainText("Not in the Ground Truth");
      await expect(count(page, "unlinked_item")).toContainText("2");
      for (const kind of ["slice_parent_missing", "prd_feature_missing", "no_code", "no_goal", "runs_today_on_roadmap"]) await expect(count(page, kind)).toContainText("1");
      await openKind(page, "unlinked_item");
      await expect(row(page, "Export to sheets")).toContainText("This roadmap item is not a feature in the Ground Truth.");
      await expect(row(page, "Export to sheets").getByRole("button", { name: /Add to Ground Truth/ })).toBeVisible();
      await expect(row(page, "Weekly digest").getByRole("button", { name: /Confirm it/ })).toBeVisible();
      await openKind(page, "prd_feature_missing");
      await expect(row(page, "Team invites")).toContainText("F-09");
      // Nothing runs past the screen's edge.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });

test.describe("as the owner", () => {
  test.use({ viewport: DESKTOP });

  test("Add to Ground Truth adds the roadmap item's feature and its flag goes", async ({ page }) => {
    await open(page);
    await openKind(page, "unlinked_item");
    await row(page, "Export to sheets").getByRole("button", { name: /Add to Ground Truth/ }).click();
    await expect(page.getByTestId("gt-notice")).toContainText("Added “Export to sheets” to the Ground Truth.");
    await expect(row(page, "Export to sheets")).toHaveCount(0);
    await expect(count(page, "unlinked_item")).toContainText("1");
    await expect(total(page)).toHaveText("6");
  });

  test("Add to Ground Truth adds a PRD's feature, and its slice's", async ({ page }) => {
    await open(page);
    await openKind(page, "prd_feature_missing");
    await row(page, "Team invites").getByRole("button", { name: /Add to Ground Truth/ }).click();
    await expect(count(page, "prd_feature_missing")).toHaveCount(0);
    await openKind(page, "slice_parent_missing");
    await row(page, "Usage report").getByRole("button", { name: /Add to Ground Truth/ }).click();
    await expect(count(page, "slice_parent_missing")).toHaveCount(0);
    await expect(total(page)).toHaveText("5");
  });

  test("Link to a feature picks a Ground Truth feature by code and name", async ({ page }) => {
    await open(page);
    await openKind(page, "unlinked_item");
    await row(page, "Export to sheets").getByRole("button", { name: /Link to a feature/ }).click();
    const picker = page.getByTestId("gt-picker");
    await picker.getByLabel("Find a feature").fill("F-11");
    await picker.getByRole("button", { name: "F-11 Sheets export" }).click();
    await expect(picker).toHaveCount(0);
    await expect(page.getByTestId("gt-notice")).toContainText("Linked “Export to sheets” to “Sheets export”.");
    await expect(row(page, "Export to sheets")).toHaveCount(0);
    await expect(total(page)).toHaveText("6");
  });

  test("Confirm it confirms the feature a run proposed", async ({ page }) => {
    await open(page);
    await openKind(page, "unlinked_item");
    await row(page, "Weekly digest").getByRole("button", { name: /Confirm it/ }).click();
    await expect(page.getByTestId("gt-notice")).toContainText("Confirmed “Weekly digest”.");
    await expect(row(page, "Weekly digest")).toHaveCount(0);
    await expect(count(page, "unlinked_item")).toContainText("1");
  });

  test("Pick a goal links the feature to a goal", async ({ page }) => {
    await open(page);
    await openKind(page, "no_goal");
    await row(page, "Audit log").getByRole("button", { name: /Pick a goal/ }).click();
    const picker = page.getByTestId("gt-picker");
    await picker.getByRole("button").filter({ hasText: "Raise activation" }).click();
    await expect(page.getByTestId("gt-notice")).toContainText("“Audit log” now serves “Raise activation”.");
    await expect(count(page, "no_goal")).toHaveCount(0);
    await expect(total(page)).toHaveText("6");
  });

  test("Give it a code shows no button while no route gives one", async ({ page }) => {
    await open(page);
    await openKind(page, "no_code");
    await expect(row(page, "Smart search")).toContainText("This feature has no feature code yet.");
    await expect(row(page, "Smart search").getByRole("button")).toHaveCount(0);
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
    await expect(total(page)).toHaveText("6");
    await page.getByTestId("gt-notice").getByRole("button", { name: "Undo" }).click();
    await expect(count(page, "runs_today_on_roadmap")).toContainText("1");
    await expect(total(page)).toHaveText("7");
  });

test.describe("as an approver", () => {
  test.use({ viewport: DESKTOP });

  test("Confirm it and Pick a goal", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await open(page, "approver@example.com");
    await openKind(page, "unlinked_item");
    await row(page, "Weekly digest").getByRole("button", { name: /Confirm it/ }).click();
    await expect(row(page, "Weekly digest")).toHaveCount(0);
    await openKind(page, "no_goal");
    await row(page, "Audit log").getByRole("button", { name: /Pick a goal/ }).click();
    await page.getByTestId("gt-picker").getByRole("button").filter({ hasText: "Raise activation" }).click();
    await expect(count(page, "no_goal")).toHaveCount(0);
    await expect(total(page)).toHaveText("5");
  });
});

for (const viewport of [DESKTOP, PHONE])
  test(`a viewer reads the flags with no fixes (${viewport.width})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await open(page, "viewer@example.com");
    await expect(total(page)).toHaveText("7");
    for (const kind of ["unlinked_item", "prd_feature_missing", "no_goal", "runs_today_on_roadmap"]) {
      await openKind(page, kind);
      await expect(page.getByTestId(`gt-list-${kind}`).getByTestId("gt-row").first()).toBeVisible();
      await expect(page.getByTestId(`gt-list-${kind}`).getByRole("button")).toHaveCount(0);
    }
  });
