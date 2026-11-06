import { expect, test, type Page } from "./test";

import { GROUND_TRUTH_FLAGS_SCENARIO } from "../lib/api/mock/ground-truth";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * Pre-demo visual QA of the Ground Truth page (P-2, D-2, D-5, D-6, D-12), against the mock, as
 * the owner and as a viewer: the Ready to move banner reads as one line with no stray colon and
 * asks only someone who may say yes; the page's and Running today's explanations sit behind an
 * (i); the feature list's columns line up; a flag row's status is a chip and its feature is
 * named with its code.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const VIEWER = "viewer@example.com";

const PEOPLE = [
  { who: "owner", email: undefined },
  { who: "viewer", email: VIEWER },
] as const;

async function open(page: Page, url: string, email?: string) {
  await login(page, email);
  await page.goto(url);
}

/** The (i) with its name opens; its tip says the words. */
async function tipSays(page: Page, label: string, words: string | RegExp) {
  const button = page.getByRole("button", { name: `About ${label}`, exact: true }).first();
  await button.click();
  await expect(page.getByRole("tooltip").filter({ hasText: words })).toBeVisible();
  await page.keyboard.press("Escape");
}

for (const { who, email } of PEOPLE) {
  for (const viewport of [DESKTOP, PHONE])
    for (const colorScheme of ["light", "dark"] as const) {
      if (viewport === PHONE && colorScheme === "dark") continue;
      test(`P-2: the ready banner reads as one run, no stray colon (${who}, ${viewport.width}, ${colorScheme})`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.emulateMedia({ colorScheme });
        await open(page, "/ground-truth", email);
        const band = page.getByTestId("cs3-ready");
        const words = band.getByTestId("cs3-ready-words");
        await expect(words.locator("b")).toHaveText("2 ready to move");
        // What a person sees (the (i)'s words are hidden until it opens).
        expect(await words.innerText()).toMatch(/^2 ready to move\s*i?$/);
        expect(await band.innerText()).not.toContain(":");
        // The count and its words sit on one line.
        const bold = (await words.locator("b").boundingBox())!;
        const run = (await words.boundingBox())!;
        expect(run.height).toBeLessThan(bold.height * 1.8);
        expect(Math.abs(bold.y + bold.height / 2 - (run.y + run.height / 2))).toBeLessThan(4);
      });
    }

  for (const colorScheme of ["light", "dark"] as const) {
    test(`D-2, D-5: the banner asks only who may say yes; the explanations are behind an (i) and columns line up (${who}, ${colorScheme})`, async ({ page }) => {
      await page.setViewportSize(DESKTOP);
      await page.emulateMedia({ colorScheme });
      await open(page, "/ground-truth", email);
      const band = page.getByTestId("cs3-ready");
      await expect(band).toBeVisible();
      const seen = await band.innerText();
      expect(seen).not.toMatch(/shipped, with proof/i);
      expect(seen).not.toContain("your yes");
      if (who === "owner") await tipSays(page, "Ready to move", "Each one needs your yes.");
      else {
        await band.getByRole("button", { name: "About Ready to move" }).click();
        const tip = page.getByRole("tooltip").filter({ hasText: "Shipped, with proof." });
        await expect(tip).toBeVisible();
        await expect(tip).not.toContainText("your yes");
        await expect(tip).toContainText("An approver or owner says yes to each move.");
        await page.keyboard.press("Escape");
      }
      await expect(page.getByText("Goals, areas of focus, milestones and every feature", { exact: false })).toBeHidden();
      await tipSays(page, "Ground Truth", "Goals, areas of focus, milestones and every feature");
      // Each row's area, milestone and progress start at one x, at one width.
      const rows = page.getByTestId("cs-desired-row");
      await expect(rows.first()).toBeVisible();
      const progress = await page.getByTestId("cs-desired-progress").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => [Math.round(r.x), Math.round(r.width)]));
      const areas = await page.getByTestId("cs-desired-area").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().x)));
      expect(progress.length).toBeGreaterThan(3);
      expect(new Set(progress.map((p) => p.join(":"))).size).toBe(1);
      expect(new Set(areas).size).toBe(1);
    });

    test(`D-6: Running today's words are behind an (i), with no leading separator (${who}, ${colorScheme})`, async ({ page }) => {
      await page.setViewportSize(DESKTOP);
      await page.emulateMedia({ colorScheme });
      await open(page, "/ground-truth?view=current", email);
      const summary = page.getByTestId("cs-summary");
      await expect(summary).toContainText("3 running");
      await expect(page.getByText("What runs today: each built feature", { exact: false })).toBeHidden();
      await expect(page.getByText("Oracle reads code maps", { exact: false })).toBeHidden();
      expect(await summary.innerText()).not.toContain("·");
      await summary.getByRole("button", { name: "About Running today" }).click();
      await expect(page.getByRole("tooltip").filter({ hasText: "Oracle reads code maps, merged pull requests and done tasks each night" })).toBeVisible();
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "About Running today" }).first().click();
      await expect(page.getByRole("tooltip").filter({ hasText: "What runs today: each built feature with its proof" })).toBeVisible();
    });

    test(`D-12: a flag row's status is a chip and its feature has its name with its code (${who}, ${colorScheme})`, async ({ page }) => {
      await page.setViewportSize(DESKTOP);
      await page.emulateMedia({ colorScheme });
      await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, GROUND_TRUTH_FLAGS_SCENARIO] as const);
      await open(page, "/ground-truth", email);
      await page.getByTestId("gt-count-unlinked_item").click();
      const digest = page.getByTestId("gt-row").filter({ hasText: "Weekly digest" });
      const unconfirmed = digest.getByTestId("gt-unconfirmed");
      await expect(unconfirmed.locator('[data-kind="warn"]')).toHaveText("Waiting to be confirmed");
      await expect(unconfirmed.getByTestId("code-chip")).toHaveAccessibleName("F-14 Weekly digest");
      await expect(digest).not.toContainText("Waiting to be confirmed:");
      // A code is never on its own: every code in a row is a chip's, beside its name.
      await page.getByTestId("gt-count-slice_parent_missing").click();
      const slice = page.getByTestId("gt-row").filter({ hasText: "Usage report" });
      await expect(slice.getByTestId("code-chip").first()).toHaveAccessibleName("F-15a Usage report");
      const rows = page.getByTestId("gt-row");
      expect(await rows.locator(".font-mono").count()).toBe(await rows.getByTestId("code-tag").count());
    });
  }
}
