import type { Locator, Page } from "@playwright/test";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test } from "./test";

/*
 * prio-company (the owner, Nov 4: "a person always sees what is happening to a roadmap shared
 * with them and every change it needs can be made in the UI"). Simple › Priorities, as the
 * owner, on the "simple-plan" scenario (invented data):
 * - no row tells the owner to ask for access: every row has its drag handle;
 * - no row shows a made-up code chip; a feature's own key (F-06) sits beside its name only;
 * - "N of M miss this quarter" is a count with "Show them", which lists each feature on its own
 *   line, each opening the feature's panel;
 * - a PM-owned row (no engineer-weeks, no score) gets "Add effort" in place, and its score shows;
 * - the Line picker names each line's PRD.
 * Desktop 1440x900 and phone 390x844, light and dark.
 */

const PHONE = { width: 390, height: 844 };

async function setUp(page: Page, scheme: "light" | "dark", phone: boolean, scenario = "simple-plan"): Promise<void> {
  await page.setViewportSize(phone ? PHONE : { width: 1440, height: 900 });
  await page.context().addInitScript(
    ([key, value, themeKey, theme]) => {
      if (value) localStorage.setItem(key, value);
      localStorage.setItem(themeKey, theme);
    },
    [MOCK_SCENARIO_KEY, scenario, THEME_KEY, scheme] as const,
  );
  await page.emulateMedia({ colorScheme: scheme });
  await login(page);
  await page.goto("/simple/priorities");
  await expect(page.getByTestId("simple-priorities")).toBeVisible();
  await expect(page.getByText("Loading priorities…")).toHaveCount(0);
}

const rowByTitle = (page: Page, title: string): Locator => page.getByTestId("prio-row").filter({ has: page.getByTestId("prio-title").getByText(title) });

for (const scheme of ["light", "dark"] as const) {
  for (const phone of [false, true]) {
    test.describe(`${scheme} ${phone ? "390px" : "desktop"}`, () => {
      test("the owner moves every row, reads names not codes, and sees who misses the line one per line", async ({ page }, info) => {
        await setUp(page, scheme, phone);
        const rows = page.getByTestId("prio-row");
        await expect(rows.first()).toBeVisible();
        const n = await rows.count();
        expect(n).toBeGreaterThan(3);
        // Never the access message for the owner; every row has its handle.
        await expect(page.getByTestId("prio-locked")).toHaveCount(0);
        await expect(page.getByTestId("prio-no-handle")).toHaveCount(0);
        await expect(page.locator("[data-handle]")).toHaveCount(n);

        // No made-up code chips; the feature's own key beside its name.
        await expect(page.getByTestId("prio-code")).toHaveCount(0);
        const keys = await page.getByTestId("prio-own-key").allTextContents();
        for (const k of keys) expect(k).toMatch(/^[A-Z]{1,3}-\d+$/);
        await expect(rowByTitle(page, "Setup error report").getByTestId("prio-own-key")).toHaveText("F-06");

        await page.screenshot({ path: info.outputPath(`priorities-plan-${scheme}-${phone ? "390" : "desktop"}.png`), fullPage: false });
      });

      test("N of M miss this quarter is a count, and Show them lists each feature on its own line", async ({ page }, info) => {
        // The first-run roadmap: the line is this quarter, so the list is one part under the caption.
        await setUp(page, scheme, phone, "");
        // "N of M miss …": a count, then Show them lists each, one per line.
        const caption = page.getByTestId("line-caption").first();
        await expect(caption).toContainText(/\d+ of \d+ miss/);
        const misses = await page.locator('[data-testid="prio-row"][data-misses="true"]').count();
        expect(misses).toBeGreaterThan(1);
        await expect(caption.getByTestId("line-miss")).toHaveCount(0);
        await caption.getByRole("button", { name: "Show them" }).click();
        const listed = caption.getByTestId("line-miss");
        await expect(listed).toHaveCount(misses);
        const a = await listed.nth(0).boundingBox();
        const b = await listed.nth(1).boundingBox();
        expect(b!.y).toBeGreaterThanOrEqual(a!.y + a!.height - 1);
        await page.screenshot({ path: info.outputPath(`priorities-${scheme}-${phone ? "390" : "desktop"}.png`), fullPage: false });
        // Each opens the feature.
        await listed.nth(0).click();
        await expect(page.getByRole("dialog")).toBeVisible();
      });

      test("a PM-owned row gets its effort in place, then its score", async ({ page }) => {
        await setUp(page, scheme, phone);
        const pricing = rowByTitle(page, "Pricing page words");
        await expect(pricing.getByTestId("prio-pm-owned")).toBeVisible();
        await pricing.getByRole("button", { name: "Add effort" }).click();
        await pricing.getByLabel("Effort for Pricing page words, in engineer-weeks").fill("2");
        await pricing.getByRole("button", { name: "Save" }).click();
        await expect(pricing.getByTestId("prio-pm-owned")).toHaveCount(0);
        await expect(pricing.getByTestId("prio-score")).toBeVisible();
        await expect(pricing.getByTestId("prio-numbers")).toContainText("2 wk");
      });

      test("the Line picker lists each PRD's milestones under its name, each once", async ({ page }) => {
        await setUp(page, scheme, phone);
        const select = page.getByTestId("line-picker").getByLabel("Line", { exact: true });
        const options = await select.locator("option").allTextContents();
        const groups = select.locator("optgroup");
        expect(await groups.count(), options.join("\n")).toBeGreaterThan(0);
        for (const g of await groups.all()) {
          expect(await g.getAttribute("label")).toBeTruthy();
          for (const t of await g.locator("option").allTextContents()) expect(t).toMatch(/^(From the PRD|Milestone): /);
        }
        // Every PRD milestone sits under its PRD; each line once; no placeholder name.
        const loose = await select.locator(":scope > option").allTextContents();
        expect(loose.filter((t) => t.startsWith("From the PRD: ")), loose.join("\n")).toEqual([]);
        expect(new Set(options).size, options.join("\n")).toBe(options.length);
        expect(options.join("\n")).not.toMatch(/(^|\s)N(\s|$)/m);
      });
    });
  }
}
