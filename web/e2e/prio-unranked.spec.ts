import type { Page } from "@playwright/test";

import { GROUND_TRUTH_FLAGS_SCENARIO } from "../lib/api/mock/ground-truth";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test } from "./test";

/**
 * prio-unranked: on Simple Priorities, a live roadmap item with no ranked feature is listed under
 * the ranked rows, in a "No ranked feature" group whose (i) says why: muted, no score, no drag
 * handle, and a click (or Enter) opens the one feature panel. A draft is not listed there. Once
 * the item is linked to a Ground Truth feature (Detailed › Ground Truth, Link to a feature) it is
 * a ranked row. The "ground-truth-flags" scenario: Export to sheets is a published item with no
 * feature; Weekly digest is a draft. As the owner, 1440 and 390 wide, light and dark.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function open(page: Page, theme: "light" | "dark") {
  await page.addInitScript(
    ([t, key, sc]) => {
      localStorage.setItem("oracle-theme", t);
      localStorage.setItem(key, sc);
    },
    [theme, MOCK_SCENARIO_KEY, GROUND_TRUTH_FLAGS_SCENARIO] as const,
  );
  await login(page);
  await page.goto("/simple/priorities");
  await expect(page.getByTestId("prio-row").first()).toBeVisible();
}

const unrankedRow = (page: Page, name: string) => page.getByTestId("prio-unranked-row").filter({ hasText: name });
const rankedRow = (page: Page, name: string) => page.getByTestId("prio-row").filter({ hasText: name });

for (const [size, viewport] of [["1440", DESKTOP], ["390", PHONE]] as const)
  for (const theme of ["light", "dark"] as const)
    test.describe(`${size} ${theme}`, () => {
      test.use({ viewport });

      test("an item with no ranked feature shows under the ranked rows and opens its panel; it ranks once linked", async ({ page }) => {
        await open(page, theme);
        const group = page.getByTestId("prio-unranked");
        await expect(group).toBeVisible();
        await expect(group.getByRole("heading", { name: "No ranked feature" })).toBeVisible();
        // The (i) says why; no sentence on the page.
        await group.getByRole("button", { name: /No ranked feature/ }).click();
        await expect(page.getByRole("tooltip")).toContainText("no ranked feature yet");
        await page.keyboard.press("Escape");

        const sheets = unrankedRow(page, "Export to sheets");
        await expect(sheets).toHaveCount(1);
        await expect(rankedRow(page, "Export to sheets")).toHaveCount(0);
        // Under every ranked row.
        const lastRanked = await page.getByTestId("prio-row").last().boundingBox();
        const box = await sheets.boundingBox();
        expect(box!.y).toBeGreaterThan(lastRanked!.y + lastRanked!.height - 1);
        // No score, no rank, nothing to drag.
        await expect(sheets.getByTestId("prio-score")).toHaveCount(0);
        await expect(sheets.getByTestId("prio-rank")).toHaveCount(0);
        await expect(page.getByRole("button", { name: /Drag Export to sheets/ })).toHaveCount(0);
        // A draft is not listed there (it sits among the drafts).
        await expect(unrankedRow(page, "Weekly digest")).toHaveCount(0);
        // The page fits a phone.
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

        // A click opens the one feature panel.
        await sheets.getByRole("button", { name: /Export to sheets/ }).click();
        const panel = page.getByTestId("item-panel");
        await expect(panel).toBeVisible();
        await expect(panel).toContainText("Export to sheets");
        await expect(panel).toContainText("Depends on");
        await page.keyboard.press("Escape");
        await expect(panel).toHaveCount(0);
        // So does Enter.
        await sheets.getByRole("button", { name: /Export to sheets/ }).focus();
        await page.keyboard.press("Enter");
        await expect(panel).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(panel).toHaveCount(0);

        // Linked to a Ground Truth feature, it ranks.
        await page.goto("/baseline");
        await expect(page.getByTestId("gt-band")).toBeVisible();
        await page.getByTestId("gt-count-unlinked_item").click();
        await page.getByTestId("gt-row").filter({ hasText: "Export to sheets" }).getByRole("button", { name: /Link to a feature/ }).click();
        const picker = page.getByTestId("gt-picker");
        await picker.getByLabel("Find a feature").fill("Sheets");
        await picker.getByRole("button", { name: "F-11 Sheets export" }).click();
        await expect(picker).toHaveCount(0);

        await page.goto("/simple/priorities");
        await expect(rankedRow(page, "Export to sheets")).toHaveCount(1);
        await expect(unrankedRow(page, "Export to sheets")).toHaveCount(0);
        await expect(page.getByTestId("prio-unranked")).toHaveCount(0);
      });
    });
