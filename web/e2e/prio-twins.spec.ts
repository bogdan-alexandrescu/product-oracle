import type { Locator, Page } from "@playwright/test";
import { COMPANY_TITLE } from "../lib/api/mock/one-roadmap";
import { MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { PRIORITIES_TWINS_SCENARIO, TWINS } from "../lib/api/mock/simple-priorities";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test } from "./test";

/*
 * qa-prio-twins (a visual QA of Simple › Priorities): each feature appears once, in one place. On the
 * "priorities-twins" scenario (invented data, on "one-roadmap"), as the owner:
 * - Trusted seller badge, whose draft is on the company roadmap, never reads "Not on Product roadmap yet": its
 *   draft shows on its row (Confirm, Merge into…), not again under "Not ranked yet";
 * - a second Block list draft, linked to nothing, shows on Block list's one row, merged there with Merge into…;
 * - a second Queue backpressure item is one row with it, merged with Merge into…;
 * - the score's formula sits behind an (i) by the list's heading, never as a line of text;
 * - the Show filter's All counts every feature listed, Block list and Queue backpressure too (only proposed by
 *   Oracle, so with no mark yet).
 * Desktop 1440x900 and phone 390x844.
 */

async function setUp(page: Page, phone: boolean, role = ""): Promise<void> {
  await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  await page.context().addInitScript(
    ([key, value, themeKey, roleKey, as]) => {
      localStorage.setItem(key, value);
      localStorage.setItem(themeKey, "light");
      if (as) localStorage.setItem(roleKey, as);
    },
    [MOCK_SCENARIO_KEY, PRIORITIES_TWINS_SCENARIO, THEME_KEY, MOCK_ROLE_KEY, role] as const,
  );
  await login(page);
  await page.goto("/simple/priorities");
  await expect(page.getByTestId("simple-priorities")).toBeVisible();
  await expect(page.getByText("Loading priorities…")).toHaveCount(0);
  await expect(page.getByTestId("prio-row").first()).toBeVisible();
}

const rowsNamed = (page: Page, title: string): Locator => page.getByTestId("prio-row").filter({ has: page.getByTestId("prio-title").getByText(title, { exact: true }) });
const notRanked = (page: Page): Locator => page.getByRole("region", { name: "Not ranked yet" });

for (const phone of [false, true]) {
  test.describe(phone ? "390px" : "desktop", () => {
    test("a roadmap draft is on the roadmap, shown once on its feature's row", async ({ page }) => {
      await setUp(page, phone);
      const row = rowsNamed(page, TWINS.draft);
      await expect(row).toHaveCount(1);
      await expect(row.getByTestId("prio-adds")).toHaveCount(0);
      await expect(page.getByText(`Not on ${COMPANY_TITLE} yet`)).toHaveCount(0);
      const draft = row.getByTestId("prio-row-draft");
      await expect(draft).toHaveCount(1);
      await expect(draft.getByRole("button", { name: "Confirm" })).toBeVisible();
      await expect(draft.getByRole("button", { name: "Merge into…" })).toBeVisible();
      await expect(notRanked(page).getByText(TWINS.draft)).toHaveCount(0);
      // Every title once: never two rows, never a row and a draft of its own.
      const titles = await page.getByTestId("prio-title").allTextContents();
      expect(new Set(titles).size, titles.join(" | ")).toBe(titles.length);
      const drafts = await page.getByTestId("prio-draft").allTextContents();
      for (const t of titles) expect(drafts.some((d) => d.includes(t)), `${t} also under Not ranked yet`).toBe(false);
    });

    test("a draft with a row's name shows on that row and merges into it", async ({ page }) => {
      await setUp(page, phone);
      const row = rowsNamed(page, TWINS.unlinked);
      await expect(row).toHaveCount(1);
      await expect(notRanked(page).getByText(TWINS.unlinked, { exact: true })).toHaveCount(0);
      const draft = row.getByTestId("prio-row-draft");
      await expect(draft).toHaveCount(1);
      // Only named as the feature: no Confirm, only Merge into…, the row's own item picked.
      await expect(draft.getByRole("button", { name: "Confirm" })).toHaveCount(0);
      await draft.getByRole("button", { name: "Merge into…" }).click();
      await expect(draft.getByLabel("Merge into")).toHaveValue(/.+/);
      await expect(draft.getByLabel("Merge into").locator("option:checked")).toHaveText(TWINS.unlinked);
      await draft.getByRole("button", { name: "Merge", exact: true }).click();
      await expect(page.getByText(`Merged ${TWINS.unlinked} into ${TWINS.unlinked}`)).toBeVisible();
      await expect(row.getByTestId("prio-row-draft")).toHaveCount(0);
      await expect(rowsNamed(page, TWINS.unlinked)).toHaveCount(1);
    });

    test("two records with one name are one row, merged with Merge into…", async ({ page }) => {
      await setUp(page, phone);
      const row = rowsNamed(page, TWINS.item);
      await expect(row).toHaveCount(1);
      const twin = row.getByTestId("prio-twin");
      await expect(twin).toHaveCount(1);
      await twin.getByRole("button", { name: "Merge into…" }).click();
      await twin.getByRole("button", { name: "Merge", exact: true }).click();
      await expect(page.getByText(`Merged ${TWINS.item} into ${TWINS.item}`)).toBeVisible();
      await expect(rowsNamed(page, TWINS.item).getByTestId("prio-twin")).toHaveCount(0);
      await expect(rowsNamed(page, TWINS.item)).toHaveCount(1);
    });

    test("the score's formula is behind an (i) by the list's heading", async ({ page }) => {
      await setUp(page, phone);
      await expect(page.getByText(/^Score = goal value/)).toBeHidden();
      await page.getByTestId("line-caption").getByTestId("prio-score-help").click();
      await expect(page.locator("#prio-score-text")).toHaveText("Score = goal value × Oracle's confidence in it (0 to 1) ÷ effort in engineer-weeks.");
    });

    test("the Show filter's All counts every feature listed, one with no mark yet too", async ({ page }) => {
      await setUp(page, phone);
      await expect(page.getByTestId("cs-legend")).toBeVisible();
      const n = await page.getByTestId("prio-row").count();
      await expect(page.getByTestId("cs-legend").getByRole("button", { name: /^All / })).toHaveText(`All ${n}`);
    });
  });
}
