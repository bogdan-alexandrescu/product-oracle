import { expect, test, type Page } from "./test";

import { GROUND_TRUTH_CONFIRM_SCENARIO } from "../lib/api/mock/ground-truth";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * Confirm it keeps a feature's own code and its goal link (docs/ground-truth.md: a feature is keyed
 * by its own code when no other feature has it). The "ground-truth-confirm" scenario: Usage sync, a
 * feature a run proposed with its Code F-16 and its link to the goal, on a roadmap item; Alert rules,
 * confirmed before as F-30 while its Code is F-17, its goal link still only proposed (contribution 1); Alert
 * sounds, confirmed as F-31 while its roadmap item's code F-11 is Sheets export's; Alert volume,
 * confirmed as F-32 while its Code F-11 is Sheets export's; Alert digest, confirmed as F-33 while its Code
 * F-18 is read only by the slice F-18a.
 */

async function open(page: Page) {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, GROUND_TRUTH_CONFIRM_SCENARIO] as const);
  await login(page);
  await page.goto("/baseline");
  await expect(page.getByTestId("gt-band")).toBeVisible();
}

const count = (page: Page, kind: string) => page.getByTestId(`gt-count-${kind}`);
const list = (page: Page, kind: string) => page.getByTestId(`gt-list-${kind}`);
const row = (page: Page, kind: string, name: string) => list(page, kind).getByTestId("gt-row").filter({ hasText: name });

async function openKind(page: Page, kind: string) {
  await count(page, kind).click();
  await expect(list(page, kind)).toBeVisible();
}

test("Confirm it keys the feature by its own code and confirms its goal link", async ({ page }) => {
  await open(page);
  await openKind(page, "unlinked_item");
  await row(page, "unlinked_item", "Usage sync").getByRole("button", { name: /Confirm it/ }).click();
  await expect(page.getByTestId("gt-notice")).toContainText("Confirmed “Usage sync” as F-16.");
  await openKind(page, "no_goal");
  await expect(row(page, "no_goal", "Audit log")).toHaveCount(1);
  await expect(row(page, "no_goal", "Usage sync")).toHaveCount(0);
});

test("Use its code re-keys a feature confirmed under another number", async ({ page }) => {
  await open(page);
  await expect(count(page, "code_differs")).toContainText("Code differs from its PRD");
  await openKind(page, "code_differs");
  await expect(row(page, "code_differs", "Alert rules")).toContainText("F-30");
  await row(page, "code_differs", "Alert rules").getByRole("button", { name: /Use its code/ }).click();
  await expect(page.getByTestId("gt-notice")).toContainText("“Alert rules” is now F-17.");
  await expect(row(page, "code_differs", "Alert rules")).toHaveCount(0);
  await openKind(page, "no_goal");
  await expect(row(page, "no_goal", "Alert rules")).toHaveCount(0);
});

test("Pick a goal on a goal it is only proposed to serve confirms that link", async ({ page }) => {
  await open(page);
  await openKind(page, "no_goal");
  await row(page, "no_goal", "Alert rules").getByRole("button", { name: /Pick a goal/ }).click();
  const picker = page.getByTestId("gt-picker");
  await picker.getByRole("button").filter({ hasText: "Raise activation" }).click();
  await expect(page.getByTestId("gt-notice")).toContainText("“F-30 Alert rules” now serves “Raise activation”.");
  await expect(row(page, "no_goal", "Alert rules")).toHaveCount(0);
});

test("Pick a goal on a proposed link keeps the contribution picked", async ({ page }) => {
  await open(page);
  await openKind(page, "no_goal");
  await row(page, "no_goal", "Alert rules").getByRole("button", { name: /Pick a goal/ }).click();
  await page.getByTestId("gt-picker").getByRole("button").filter({ hasText: "Raise activation" }).click();
  await expect(page.getByTestId("gt-notice")).toContainText("“F-30 Alert rules” now serves “Raise activation”.");
  await page.getByTestId("feature-F-30").getByRole("button", { name: "Alert rules" }).click();
  await expect(page.getByRole("dialog", { name: "Alert rules" }).getByLabel("Contribution to Raise activation")).toHaveValue("2");
});

test("A code another feature holds offers Link to a feature on its item", async ({ page }) => {
  await open(page);
  await openKind(page, "code_differs");
  const sounds = row(page, "code_differs", "Alert sounds");
  await expect(sounds).toContainText("F-31");
  await expect(sounds.getByRole("button", { name: /Use its code/ })).toHaveCount(0);
  await sounds.getByRole("button", { name: /Link to a feature/ }).click();
  await page.getByTestId("gt-picker").getByRole("button").filter({ hasText: "Sheets export" }).click();
  await expect(page.getByTestId("gt-notice")).toContainText("Linked “F-11 Alert sounds” to “Sheets export”.");
  await expect(row(page, "code_differs", "Alert sounds")).toHaveCount(0);
});

test("A Code another feature holds, with no item to link, is not flagged", async ({ page }) => {
  await open(page);
  await openKind(page, "code_differs");
  await expect(row(page, "code_differs", "Alert sounds")).toHaveCount(1);
  await expect(row(page, "code_differs", "Alert volume")).toHaveCount(0);
});

test("A slice's code does not hold its whole code: Use its code re-keys", async ({ page }) => {
  await open(page);
  await openKind(page, "code_differs");
  await row(page, "code_differs", "Alert digest").getByRole("button", { name: /Use its code/ }).click();
  await expect(page.getByTestId("gt-notice")).toContainText("“Alert digest” is now F-18.");
  await expect(row(page, "code_differs", "Alert digest")).toHaveCount(0);
});
