import { readFile } from "node:fs/promises";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * The one-pager of a run-written PRD reads as the PRD says (CLD's walk B, 2026-11-01), on the
 * mock's "one-pager-run-prd-walk": an approved PRD whose one-pager Oracle's job wrote. Invented data.
 *
 * Test cards (protects / fails_when / no_claim):
 * - protects=each outcome shows how it is measured in its Success measures line's own words,
 *   with its source and never its target; its target reads whole ("3 hours a week") and no
 *   ISO date shows; who has it is one plain line, the primary people's words; a bet's code
 *   gets the name of its feature's own section, never a requirement's words after a colon;
 *   a milestone counting its features above its scope, exit and date lines is no "Needs a
 *   look" item; the PDF carries the same words; fails_when=an outcome reads "How it is
 *   measured is not in the PRD yet", who has it lists labels or a job story, a bet reads
 *   "F-01 every newly connected ...", "2027-03-31" shows, or "Needs a look" appears;
 *   no_claim=the API's reading (api/tests/test_simple_one_pager_walkb.py).
 */
const URL = "/simple/one-pagers/guided-setup";

async function open(page: Page) {
  await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, "one-pager-run-prd-walk"] as const);
  await login(page);
  await page.goto(URL);
}

for (const phone of [false, true]) {
  test.describe(phone ? "phone" : "desktop", () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 900 } });

    test("an owner reads a run's PRD one-pager as the PRD says it", async ({ page }) => {
      await open(page);
      const article = page.getByRole("article", { name: "One-pager" });
      const outcomes = article.getByRole("region", { name: "Outcomes and how we measure them" });
      // How each outcome is measured, in its Success measures line's own words.
      await expect(outcomes.locator('[data-line="outcomes-1"]').getByTestId("outcome-measure")).toHaveText(
        "counted as: share of new accounts live within 30 days, recomputed daily · from the onboarding tracker",
      );
      await expect(outcomes.locator('[data-line="outcomes-2"]').getByTestId("outcome-measure")).toHaveText("counted as: reported weekly per person");
      // A target the job cut mid-word reads whole.
      await expect(outcomes.locator('[data-line="outcomes-2"]')).toContainText("Hours saved per manager: 0 → 3 hours a week");
      await expect(article).not.toContainText("2027-03-31");
      // Who has it: one plain line, never labels, the hypothesis note or the job story.
      await expect(article.getByTestId("problem-who")).toHaveText("Who has it: Customer success managers who run onboarding for new accounts");
      // A code gets its feature section's name, and the sentence still reads.
      const bets = article.getByRole("region", { name: "What we will build" });
      await expect(bets.locator('[data-line="bets-1"]')).toContainText("F-01 Pacing plan gives every new account a pace to follow.");
      await expect(article).not.toContainText("every newly connected");
      // No false "Needs a look": the milestone's two features are no disagreement, every code is named.
      await expect(page.getByRole("region", { name: "Needs a look" })).toHaveCount(0);
      // Export PDF prints the same words (the mock's PDF prints the lines, not the measures).
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: "Export PDF" }).click();
      const pdf = await readFile((await (await download).path())!, "utf8");
      expect(pdf).toContain("F-01 Pacing plan gives every new account a pace to follow.");
      expect(pdf).toContain("by Mar 31, 2027");
      expect(pdf).not.toContain("2027-03-31");
    });
  });
}
